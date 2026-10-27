import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startEdge } from './helpers/edge.mjs';

test('takeaway orders get daily tokens and repeat customers are recognised', { timeout: 30000 }, async t => {
  const edge = await startEdge(t);
  const first = (await edge.createOrder({ customer: { phone: '+91 98765 43210', name: 'Asha' }, note: 'Jain, no onion' })).body;
  const second = (await edge.createOrder()).body;
  assert.equal(first.tokenNumber, 1);
  assert.equal(second.tokenNumber, 2);
  assert.equal(first.customer.phone, '919876543210');
  assert.equal(first.customer.name, 'Asha');
  const [kot] = await edge.waitForPrints(text => text.includes('TOKEN 1'));
  assert.match(kot, /NOTE: Jain, no onion/);
  assert.equal((await edge.request('/api/kitchen')).body.find(ticket => ticket.id === first.id).tokenNumber, 1);

  const bad = await edge.createOrder({ customer: { phone: '12' } });
  assert.equal(bad.status, 400);

  const shiftId = await edge.openShift();
  await edge.request(`/api/orders/${first.id}/payment`, { method: 'POST', body: { commandId: randomUUID(), shiftId, method: 'cash', amountMinor: first.totalMinor } });
  const lookup = (await edge.request('/api/customers/lookup?phone=919876543210')).body.customer;
  assert.equal(lookup.name, 'Asha');
  assert.equal(lookup.visitCount, 1);
  assert.equal(lookup.totalSpendMinor, first.totalMinor);
  assert.equal((await edge.request('/api/customers/lookup?phone=9999999999')).body.customer, null);
  const [receipt] = await edge.waitForPrints(text => text.includes('INVOICE'));
  assert.match(receipt, /TOKEN 1/);
  assert.match(receipt, /Customer: Asha x{8}3210/, 'the receipt masks all but the last four phone digits');

  const linked = await edge.request(`/api/orders/${second.id}/customer`, { method: 'POST', as: 'cashier', body: { phone: '9876543210', name: 'Ravi' } });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.customer.name, 'Ravi');
});

test('managers edit the menu locally; cashiers mark items sold out', { timeout: 30000 }, async t => {
  const edge = await startEdge(t);
  const created = await edge.request('/api/setup/menu/items', { method: 'POST', body: { commandId: randomUUID(), name: 'Masala Chai',
    category: 'Beverages', priceMinor: 3000, kitchenStation: 'Tea counter', taxRateBps: 500, taxCode: '996331', vegetarian: true } });
  assert.equal(created.status, 201);
  const chaiId = created.body.id;
  assert.ok(created.body.menu.stations.includes('Tea counter'), 'a new station is created for the kitchen display');
  assert.equal((await edge.request('/api/setup/menu/items', { method: 'POST', as: 'cashier', body: { commandId: randomUUID(), name: 'X', category: 'Y', priceMinor: 1, kitchenStation: 'Z' } })).status, 403);

  const modifiers = await edge.request(`/api/setup/menu/items/${chaiId}/modifiers`, { method: 'PUT',
    body: { modifiers: [{ group: 'Size', name: 'Cutting', priceDeltaMinor: 0 }, { group: 'Size', name: 'Full', priceDeltaMinor: 1000 }] } });
  assert.equal(modifiers.status, 200);
  const menu = (await edge.request('/api/menu')).body;
  const chai = menu.find(item => item.id === chaiId);
  assert.deepEqual(chai.modifiers.map(option => option.name), ['Cutting', 'Full']);

  const full = chai.modifiers.find(option => option.name === 'Full');
  const order = (await edge.createOrder({ lines: [{ menuItemId: chaiId, quantity: 1, modifierIds: [full.id] }] })).body;
  assert.equal(order.subtotalMinor, 4000);

  const priced = await edge.request(`/api/setup/menu/items/${chaiId}`, { method: 'PATCH', body: { priceMinor: 3500 } });
  assert.equal(priced.status, 200);
  assert.equal((await edge.request(`/api/orders/${order.id}`)).body.subtotalMinor, 4000, 'price edits do not change existing orders');

  const soldOut = await edge.request(`/api/menu/items/${chaiId}/availability`, { method: 'POST', as: 'cashier', body: { available: false } });
  assert.equal(soldOut.status, 200);
  assert.equal((await edge.request('/api/menu')).body.find(item => item.id === chaiId).available, false, 'standalone tills still list sold-out items');
  assert.equal((await edge.createOrder({ lines: [{ menuItemId: chaiId, quantity: 1 }] })).status, 400, 'a sold-out item cannot be ordered');

  const removed = await edge.request(`/api/setup/menu/items/${chaiId}/remove`, { method: 'POST', body: {} });
  assert.equal(removed.status, 200);
  assert.ok(!removed.body.items.some(item => item.id === chaiId));
  assert.ok(!(await edge.request('/api/menu')).body.some(item => item.id === chaiId));
  assert.equal((await edge.request(`/api/orders/${order.id}`)).body.lines[0].name, 'Masala Chai', 'order history keeps the removed item');
});
