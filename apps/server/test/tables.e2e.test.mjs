import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { startEdge } from './helpers/edge.mjs';

const tablesIn = (floor, areaName) => floor.areas.find(area => area.name === areaName)?.tables ?? [];

test('managers set up areas and numbered tables locally; removals keep order history', { timeout: 30000 }, async t => {
  const edge = await startEdge(t);
  assert.equal(edge.context.setupMode, 'standalone');
  const areaCommand = randomUUID();
  const area = await edge.request('/api/setup/areas', { method: 'POST', body: { commandId: areaCommand, name: 'Terrace' } });
  assert.equal(area.status, 201);
  const replay = await edge.request('/api/setup/areas', { method: 'POST', body: { commandId: areaCommand, name: 'Terrace' } });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, area.body.id, 'a retried command returns the original area');
  assert.equal((await edge.request('/api/setup/areas', { method: 'POST', body: { commandId: randomUUID(), name: 'terrace' } })).status, 409);

  const bulk = await edge.request('/api/setup/tables', { method: 'POST',
    body: { commandId: randomUUID(), areaId: area.body.id, prefix: 'T', from: 1, to: 3, capacity: 4 } });
  assert.equal(bulk.status, 201);
  assert.deepEqual(bulk.body.tables.map(table => table.name), ['T 01', 'T 02', 'T 03']);

  let floor = (await edge.request('/api/floor')).body;
  assert.deepEqual(tablesIn(floor, 'Terrace').map(table => [table.name, table.capacity, table.status]),
    [['T 01', 4, 'free'], ['T 02', 4, 'free'], ['T 03', 4, 'free']]);

  const [t1, t2, t3] = bulk.body.tables;
  const order = await edge.createOrder({ orderType: 'dine_in', tableId: t1.id, guestCount: 3 });
  assert.equal(order.status, 201);
  assert.equal(order.body.tableLabel, 'T 01');
  const blocked = await edge.request(`/api/setup/tables/${t1.id}/remove`, { method: 'POST', body: { commandId: randomUUID() } });
  assert.equal(blocked.status, 409, 'a table with an open order cannot be removed');
  assert.equal((await edge.createOrder({ orderType: 'dine_in', tableId: t1.id })).status, 400, 'an occupied table cannot take a second order');

  const renamed = await edge.request(`/api/setup/tables/${t1.id}`, { method: 'PATCH', body: { commandId: randomUUID(), name: 'Terrace 1', capacity: 6 } });
  assert.equal(renamed.status, 200);
  assert.equal((await edge.request(`/api/orders/${order.body.id}`)).body.tableLabel, 'Terrace 1', 'open orders follow the new table name');

  assert.equal((await edge.request(`/api/setup/tables/${t3.id}/remove`, { method: 'POST', body: { commandId: randomUUID() } })).status, 200);
  floor = (await edge.request('/api/floor')).body;
  assert.deepEqual(tablesIn(floor, 'Terrace').map(table => table.name), ['Terrace 1', 'T 02']);
  const occupied = tablesIn(floor, 'Terrace').find(table => table.id === t1.id);
  assert.equal(occupied.status, 'occupied');
  assert.equal(occupied.order.guestCount, 3);
  assert.equal(occupied.order.totalMinor, order.body.totalMinor);
  assert.ok(t2);
});

test('cashiers move, merge, bill and split a table, and the table report reconciles', { timeout: 30000 }, async t => {
  const edge = await startEdge(t);
  const shiftId = await edge.openShift();
  const floor = (await edge.request('/api/floor')).body;
  const [a, b, c] = tablesIn(floor, 'Main floor');
  const first = (await edge.createOrder({ orderType: 'dine_in', tableId: a.id, guestCount: 2,
    lines: [{ menuItemId: 'indori-poha', quantity: 2 }] })).body;
  const second = (await edge.createOrder({ orderType: 'dine_in', tableId: b.id, guestCount: 1,
    lines: [{ menuItemId: 'samosa', quantity: 1 }] })).body;

  const moveCommand = randomUUID();
  const moved = await edge.request(`/api/orders/${first.id}/move`, { method: 'POST', body: { commandId: moveCommand, tableId: c.id, reason: 'Guests asked for a window seat' } });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.tableId, c.id);
  assert.equal((await edge.request(`/api/orders/${first.id}/move`, { method: 'POST', body: { commandId: moveCommand, tableId: c.id, reason: 'Guests asked for a window seat' } })).status, 200);
  const onto = await edge.request(`/api/orders/${first.id}/move`, { method: 'POST', body: { commandId: randomUUID(), tableId: b.id, reason: 'Try occupied table' } });
  assert.equal(onto.status, 409);
  assert.match(onto.body.error, /Merge/);

  const merged = await edge.request(`/api/orders/${second.id}/merge`, { method: 'POST', body: { commandId: randomUUID(), targetOrderId: first.id, reason: 'Party joined together' } });
  assert.equal(merged.status, 200);
  assert.equal(merged.body.lines.length, 2);
  assert.equal(merged.body.guestCount, 3);
  assert.equal(merged.body.totalMinor, first.totalMinor + second.totalMinor);
  const source = (await edge.request(`/api/orders/${second.id}`)).body;
  assert.equal(source.status, 'cancelled');
  assert.equal(source.totalMinor, 0);
  const kitchen = (await edge.request('/api/kitchen')).body;
  assert.ok(kitchen.every(ticket => ticket.id !== second.id), 'the merged-away order leaves the kitchen board');
  assert.equal(kitchen.filter(ticket => ticket.id === first.id).flatMap(ticket => ticket.lines).length, 2);

  const bill = await edge.request(`/api/orders/${first.id}/bill`, { method: 'POST', body: {} });
  assert.equal(bill.status, 200);
  assert.ok(bill.body.billPrintedAt);
  const [printedBill] = await edge.waitForPrints(text => text.includes('BILL - NOT A TAX INVOICE'));
  assert.ok(printedBill);
  const afterBill = (await edge.request('/api/floor')).body;
  assert.equal(tablesIn(afterBill, 'Main floor').find(table => table.id === c.id).status, 'bill_printed');
  assert.equal(tablesIn(afterBill, 'Main floor').find(table => table.id === b.id).status, 'free');

  const total = merged.body.totalMinor;
  const share = Math.floor(total / 3);
  const [pohaLine, samosaLine] = merged.body.lines;
  const paid = await edge.request(`/api/orders/${first.id}/payment`, { method: 'POST', body: { commandId: randomUUID(), shiftId, tenders: [
    { method: 'cash', amountMinor: share, label: 'Guest 1', lineIds: [pohaLine.id] },
    { method: 'upi', amountMinor: share, label: 'Guest 2', lineIds: [samosaLine.id] },
    { method: 'card', amountMinor: total - 2 * share, label: 'Guest 3' },
  ] } });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.status, 'paid');
  const slips = await edge.waitForPrints(text => text.includes('SPLIT BILL SHARE'), 3);
  assert.equal(slips.length, 3);
  assert.ok(slips.some(text => text.includes('Guest 2') && text.includes('Samosa')));

  const report = (await edge.request('/api/reports/tables')).body;
  assert.equal(report.tables.length, 1);
  assert.equal(report.tables[0].tableId, c.id);
  assert.equal(report.tables[0].orderCount, 1);
  assert.equal(report.tables[0].guestCount, 3);
  assert.equal(report.tables[0].salesMinor, total);
  assert.equal(report.areas[0].areaName, 'Main floor');
  const csv = await edge.request('/api/reports/tables.csv');
  assert.match(csv.body, /^"level","area","table","orders"/);
});

test('split shares cannot claim the same item twice', { timeout: 30000 }, async t => {
  const edge = await startEdge(t);
  const shiftId = await edge.openShift();
  const order = (await edge.createOrder()).body;
  const [line] = order.lines;
  const result = await edge.request(`/api/orders/${order.id}/payment`, { method: 'POST', body: { commandId: randomUUID(), shiftId, tenders: [
    { method: 'cash', amountMinor: 100, label: 'A', lineIds: [line.id] },
    { method: 'upi', amountMinor: order.totalMinor - 100, label: 'B', lineIds: [line.id] },
  ] } });
  assert.equal(result.status, 400);
});
