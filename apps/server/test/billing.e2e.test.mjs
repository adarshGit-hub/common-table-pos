import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startEdge } from './helpers/edge.mjs';

const tablesIn = (floor, areaName) => floor.areas.find(area => area.name === areaName)?.tables ?? [];

test('new orders carry CGST/SGST lines and round to the rupee', { timeout: 30000 }, async t => {
  const edge = await startEdge(t);
  // Indori Poha Rs 70 at the 5% outlet rate: 1.75 + 1.75 tax, 73.50 rounds to 74.
  const order = (await edge.createOrder()).body;
  assert.equal(order.pricingVersion, 2);
  assert.equal(order.subtotalMinor, 7000);
  assert.deepEqual(order.taxLines, [{ taxRateBps: 500, taxCode: null, taxableMinor: 7000, cgstMinor: 175, sgstMinor: 175 }]);
  assert.equal(order.taxTotalMinor, 350);
  assert.equal(order.roundOffMinor, 50);
  assert.equal(order.totalMinor, 7400);
});

test('discounts reprice the bill, respect the cashier limit, and can be removed', { timeout: 30000 }, async t => {
  const edge = await startEdge(t);
  const order = (await edge.createOrder({ lines: [{ menuItemId: 'indori-poha', quantity: 2 }, { menuItemId: 'samosa', quantity: 2 }] })).body;
  assert.equal(order.subtotalMinor, 19000);
  const [poha] = order.lines;

  const tooBig = await edge.request(`/api/orders/${order.id}/discounts`, { method: 'POST', as: 'cashier',
    body: { commandId: randomUUID(), kind: 'percent', value: 2000, reason: 'Regular customer' } });
  assert.equal(tooBig.status, 403, 'a cashier cannot give 20% with the default 10% limit');

  const command = randomUUID();
  const itemDiscount = await edge.request(`/api/orders/${order.id}/discounts`, { method: 'POST', as: 'cashier',
    body: { commandId: command, lineId: poha.id, kind: 'amount', value: 1000, reason: 'Poha was cold' } });
  assert.equal(itemDiscount.status, 201);
  assert.equal(itemDiscount.body.discountMinor, 1000);
  assert.equal(itemDiscount.body.taxLines[0].taxableMinor, 18000);
  const replay = await edge.request(`/api/orders/${order.id}/discounts`, { method: 'POST', as: 'cashier',
    body: { commandId: command, lineId: poha.id, kind: 'amount', value: 1000, reason: 'Poha was cold' } });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.discounts.length, 1, 'a retried discount is not applied twice');

  const managerDiscount = await edge.request(`/api/orders/${order.id}/discounts`, { method: 'POST', as: 'manager',
    body: { commandId: randomUUID(), kind: 'percent', value: 5000, reason: 'Owner guest' } });
  assert.equal(managerDiscount.status, 201);
  assert.equal(managerDiscount.body.discountMinor, 1000 + 9000);
  assert.equal(managerDiscount.body.totalMinor, Math.round((9000 + 450) / 100) * 100);

  const removed = await edge.request(`/api/orders/${order.id}/discounts/${managerDiscount.body.discounts[1].id}/void`, { method: 'POST',
    body: { reason: 'Applied by mistake' } });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.discountMinor, 1000);
  assert.equal(removed.body.discounts.length, 1);

  const shiftId = await edge.openShift();
  await edge.request(`/api/orders/${order.id}/payment`, { method: 'POST', body: { commandId: randomUUID(), shiftId, method: 'cash', amountMinor: removed.body.totalMinor } });
  const [receipt] = await edge.waitForPrints(text => text.includes('INVOICE'));
  assert.match(receipt, /Discount \(Indori Poha\)/);
  assert.match(receipt, /CGST 2\.5%/);
  assert.match(receipt, /SGST 2\.5%/);
  assert.match(receipt, /HSN\/SAC 996331/);
  const report = (await edge.request('/api/reports/daily')).body;
  assert.equal(report.totals.discountMinor, 1000);
  assert.equal(report.totals.salesMinor, removed.body.totalMinor);
  assert.equal(report.taxBreakdown[0].cgstMinor + report.taxBreakdown[0].sgstMinor, report.totals.taxTotalMinor);
});

test('dine-in service charge is optional and taxed; settings control it', { timeout: 30000 }, async t => {
  const edge = await startEdge(t);
  const denied = await edge.request('/api/settings', { method: 'PATCH', as: 'cashier', body: { serviceChargeBps: 1000 } });
  assert.equal(denied.status, 403);
  const saved = await edge.request('/api/settings', { method: 'PATCH', body: { serviceChargeBps: 1000, cashierDiscountLimitBps: 500,
    quickNotes: ['No onion', 'Jain'], outlet: { gstin: '23ABCDE1234F1Z5', receiptFooter: 'Dhanyavaad!' } } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.serviceChargeBps, 1000);
  assert.deepEqual(saved.body.quickNotes, ['No onion', 'Jain']);
  assert.equal(saved.body.outlet.gstin, '23ABCDE1234F1Z5');

  const takeaway = (await edge.createOrder()).body;
  assert.equal(takeaway.serviceChargeMinor, 0, 'takeaway orders never get a service charge');
  const table = tablesIn((await edge.request('/api/floor')).body, 'Main floor')[0];
  const dineIn = (await edge.createOrder({ orderType: 'dine_in', tableId: table.id })).body;
  assert.equal(dineIn.serviceChargeBps, 1000);
  assert.equal(dineIn.serviceChargeMinor, 700);
  assert.equal(dineIn.taxLines[0].taxableMinor, 7700, 'service charge is taxed at the outlet rate');

  assert.equal((await edge.request(`/api/orders/${dineIn.id}/service-charge`, { method: 'POST', body: { enabled: false } })).status, 400);
  const waived = await edge.request(`/api/orders/${dineIn.id}/service-charge`, { method: 'POST', as: 'cashier', body: { enabled: false, reason: 'Guest asked to remove it' } });
  assert.equal(waived.status, 200);
  assert.equal(waived.body.serviceChargeMinor, 0);
  assert.equal(waived.body.totalMinor, 7400);

  const shiftId = await edge.openShift();
  await edge.request(`/api/orders/${dineIn.id}/payment`, { method: 'POST', body: { commandId: randomUUID(), shiftId, method: 'upi', amountMinor: waived.body.totalMinor } });
  const [receipt] = await edge.waitForPrints(text => text.includes('INVOICE'));
  assert.match(receipt, /TAX INVOICE/);
  assert.match(receipt, /GSTIN: 23ABCDE1234F1Z5/);
  assert.match(receipt, /Dhanyavaad!/);
});
