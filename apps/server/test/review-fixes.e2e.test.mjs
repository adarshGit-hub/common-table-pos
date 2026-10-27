import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import test from 'node:test';
import { startEdge } from './helpers/edge.mjs';

test('payment command IDs cannot be replayed against a different order', { timeout: 30000 }, async t => {
  const edge = await startEdge(t);
  const shiftId = await edge.openShift();
  const first = (await edge.createOrder()).body;
  const second = (await edge.createOrder()).body;
  const commandId = randomUUID();
  const pay = order => edge.request(`/api/orders/${order.id}/payment`, { method: 'POST',
    body: { commandId, shiftId, method: 'cash', amountMinor: order.totalMinor } });
  assert.equal((await pay(first)).status, 200);
  const replayed = await pay(second);
  assert.equal(replayed.status, 409);
  assert.equal((await edge.request(`/api/orders/${second.id}`)).body.status, 'sent');
});

test('menu exposes per-item tax rates so the till total matches the charged total', { timeout: 30000 }, async t => {
  const edge = await startEdge(t);
  const menu = (await edge.request('/api/menu')).body;
  assert.ok(menu.every(item => 'taxRateBps' in item && 'taxCode' in item));
});

test('shift close is blocked by orders taken before the shift opened', { timeout: 30000 }, async t => {
  const edge = await startEdge(t);
  const early = (await edge.createOrder()).body;
  const shiftId = await edge.openShift();
  const close = await edge.request(`/api/shifts/${shiftId}/close`, { method: 'POST', body: { commandId: randomUUID(), countedCashMinor: 0 } });
  assert.equal(close.status, 409);
  assert.match(close.body.error, /1 open order/);
  await edge.request(`/api/orders/${early.id}/payment`, { method: 'POST',
    body: { commandId: randomUUID(), shiftId, method: 'cash', amountMinor: early.totalMinor } });
  const closed = await edge.request(`/api/shifts/${shiftId}/close`, { method: 'POST', body: { commandId: randomUUID(), countedCashMinor: early.totalMinor } });
  assert.equal(closed.status, 200);
});

test('split tender receipts list each tender instead of one cash line', { timeout: 30000 }, async t => {
  const edge = await startEdge(t);
  const shiftId = await edge.openShift();
  const order = (await edge.createOrder()).body;
  const upi = 2000;
  const paid = await edge.request(`/api/orders/${order.id}/payment`, { method: 'POST', body: { commandId: randomUUID(), shiftId,
    tenders: [{ method: 'card', amountMinor: order.totalMinor - upi }, { method: 'upi', amountMinor: upi }] } });
  assert.equal(paid.status, 200);
  const [receipt] = await edge.waitForPrints(text => text.includes('INVOICE'));
  assert.match(receipt, /Paid - CARD/);
  assert.match(receipt, /Paid - UPI/);
  assert.doesNotMatch(receipt, /Paid - CASH/);
});

test('a refund of an earlier day keeps the tax breakdown equal to the tax total', { timeout: 30000 }, async t => {
  const edge = await startEdge(t);
  const shiftId = await edge.openShift();
  const order = (await edge.createOrder()).body;
  const paid = await edge.request(`/api/orders/${order.id}/payment`, { method: 'POST',
    body: { commandId: randomUUID(), shiftId, method: 'cash', amountMinor: order.totalMinor } });
  const tenderId = (await edge.request(`/api/orders/${order.id}/payments`)).body.tenders[0].id;
  // Move the sale to the previous day so only the refund falls on today's report.
  const database = new Database(edge.databasePath);
  const yesterday = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
  database.prepare("UPDATE payment_events SET created_at=? WHERE order_id=? AND entry_type='tender'").run(yesterday, order.id);
  database.close();
  assert.equal(paid.status, 200);
  const refund = await edge.request(`/api/orders/${order.id}/refunds`, { method: 'POST',
    body: { commandId: randomUUID(), paymentId: tenderId, shiftId, amountMinor: order.totalMinor, reason: 'Wrong order served' } });
  assert.equal(refund.status, 201);
  const report = (await edge.request('/api/reports/daily')).body;
  assert.equal(report.totals.taxTotalMinor, -order.taxTotalMinor);
  assert.equal(report.taxBreakdown.reduce((sum, row) => sum + row.taxMinor, 0), report.totals.taxTotalMinor);
});
