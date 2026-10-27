import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import WebSocket from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const tenantId = 'test-tenant';
const outletId = 'test-outlet';
const terminalId = 'test-terminal';
const terminalKey = 'test-terminal-key-'.padEnd(48, 'x');
const modifiers = [{ id: 'cloud-modifier', group: 'Size', name: 'Large', priceDeltaMinor: 50 }];
const items = [
  { id: 'cloud-poha', name: 'Indori Poha', category: 'Breakfast', priceMinor: 500, emoji: '🍲', color: '#dceee2',
    tag: null, vegetarian: true, available: true, kitchenStation: 'Hot kitchen', modifiers, taxCode: '1101', taxRateBps: 500 },
  { id: 'cloud-chai', name: 'Masala Chai', category: 'Beverages', priceMinor: 200, emoji: '☕', color: '#f4e8d5',
    tag: null, vegetarian: true, available: true, kitchenStation: 'Beverage station', modifiers: [], taxRateBps: 0 },
];
let outletConfig = { name: 'Managed Test Outlet', timezone: 'UTC', currency: 'USD', taxRateBps: 1000,
  receiptName: 'Test Cafe', receiptAddress: '10 Test Street', receiptPhone: '+91 98765 43210', gstin: '22AAAAA0000A1Z5', receiptFooter: 'Thanks for visiting' };
let layout = { areas: [{ id: 'area-main', name: 'Main floor', sortOrder: 0, tables: [
  { id: 'table-1', name: 'Table 01', capacity: 2, sortOrder: 0 },
  { id: 'table-2', name: 'Table 02', capacity: 4, sortOrder: 1 },
] }], stations: [{ id: 'station-hot', name: 'Hot kitchen', sortOrder: 0 }, { id: 'station-sweets', name: 'Sweets', sortOrder: 1 }] };
let inventoryItems = [{ id: '00000000-0000-4000-8000-000000000001', name: 'Poha', unit: 'g', reorderLevel: 50, active: true, onHand: 500 }];
let recipes = [{ menuItemId: 'cloud-poha', inventoryItemId: inventoryItems[0].id, quantityPerSale: 60 }];
const acceptedInventoryEventIds = new Set();
function localFloorPlan(occupiedTables = []) {
  return { ...layout, areas: layout.areas.map(area => ({ ...area, tables: area.tables.map(table => ({ ...table, occupied: occupiedTables.includes(table.name) })) })) };
}
function snapshotVersion() {
  return createHash('sha256').update(JSON.stringify({ outletConfig, items, layout, inventoryItems, recipes })).digest('hex');
}
let version = snapshotVersion();
let upstreamAvailable = true;
const seenEtags = [];
let serverLogs = '';
let sessionCookie = '';

const upstream = createServer(async (request, response) => {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const identity = {
    'owner-token': { id: 'owner-user', email: 'owner@example.test', role: 'owner' },
    'cashier-token': { id: 'cashier-user', email: 'cashier@example.test', role: 'cashier' },
    'kitchen-token': { id: 'kitchen-user', email: 'kitchen@example.test', role: 'kitchen' },
  }[token];
  if (request.url === '/auth/v1/user') {
    response.writeHead(identity ? 200 : 401, { 'content-type': 'application/json' })
      .end(JSON.stringify(identity ? { id: identity.id, email: identity.email, user_metadata: { display_name: identity.role } } : { error: 'invalid token' }));
    return;
  }
  if (request.url?.startsWith('/rest/v1/tenant_memberships?')) {
    const rows = identity?.role === 'owner' ? [{ role: 'owner', status: 'active' }] : [];
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(rows));
    return;
  }
  if (request.url?.startsWith('/rest/v1/outlet_memberships?')) {
    const rows = identity && identity.role !== 'owner' ? [{ role: identity.role, status: 'active' }] : [];
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(rows));
    return;
  }
  if (request.headers['x-pos-terminal-key'] !== terminalKey) {
    response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"bad key"}');
    return;
  }
  if (!upstreamAvailable) {
    response.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"simulated WAN outage"}');
    return;
  }
  if (request.method === 'GET') {
    seenEtags.push(request.headers['if-none-match'] ?? null);
    const currentVersion = snapshotVersion();
    const etag = `"${currentVersion}"`;
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, { etag, 'cache-control': 'no-store' }).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', etag, 'cache-control': 'no-store' })
      .end(JSON.stringify({ tenantId, outletId, version: currentVersion, outletConfig, items, inventoryItems, recipes, layout }));
    return;
  }
  if (request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const acceptedEventIds = [];
    const rejectedEvents = [];
    for (const event of payload.events) {
      if (event.entityType === 'inventory') {
        if (acceptedInventoryEventIds.has(event.eventId)) { acceptedEventIds.push(event.eventId); continue; }
        const stock = inventoryItems.find((item) => item.id === event.payload.inventoryItemId);
        if (event.action === 'inventory.count_adjustment' && stock
          && Number(event.payload.expectedBalance) !== stock.onHand) {
          rejectedEvents.push({ eventId: event.eventId, code: '40001' });
          continue;
        }
        acceptedInventoryEventIds.add(event.eventId);
        if (stock) {
          if(event.action==='inventory.receipt')stock.onHand+=Number(event.payload.quantity);
          else if(event.action==='inventory.count_adjustment')stock.onHand=Number(event.payload.quantity);
          else stock.onHand-=Number(event.payload.quantity);
        }
      }
      acceptedEventIds.push(event.eventId);
    }
    version = snapshotVersion();
    response.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ acceptedEventIds, rejectedEvents }));
    return;
  }
  response.writeHead(405).end();
});

async function listen(target, port = 0) {
  await new Promise((resolveListen, reject) => {
    target.once('error', reject);
    target.listen(port, '127.0.0.1', resolveListen);
  });
  return target.address().port;
}

async function waitFor(check, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch { /* The local edge may still be starting or restarting. */ }
    await delay(100);
  }
  throw new Error(`${message}. Server output: ${serverLogs.slice(-1800)}`);
}

function startEdge({ port, databasePath, upstreamUrl }) {
  const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production', PORT: String(port), POS_DATABASE_PATH: databasePath,
      POS_TENANT_ID: tenantId, POS_TENANT_NAME: 'Test Cafe', POS_OUTLET_ID: outletId,
      POS_OUTLET_NAME: 'Test Outlet', POS_TERMINAL_ID: terminalId, POS_TERMINAL_NAME: 'Counter 1',
      POS_LOCATION_LABEL: 'Test Location', POS_ACTOR_ID: 'test-manager', POS_TIMEZONE: 'Asia/Kolkata', POS_CURRENCY: 'INR', POS_TAX_RATE_BPS: '500',
      POS_SYNC_URL: upstreamUrl, POS_TERMINAL_KEY: terminalKey,
      VITE_SUPABASE_URL: new URL(upstreamUrl).origin, VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key',
      POS_SESSION_SECRET: 'test-session-secret-that-is-at-least-32-bytes', POS_COOKIE_SECURE: 'false',
      MOCK_PRINTER_HOST: '127.0.0.1', MOCK_PRINTER_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { serverLogs = (serverLogs + chunk.toString()).slice(-5000); });
  child.stderr.on('data', (chunk) => { serverLogs = (serverLogs + chunk.toString()).slice(-5000); });
  return child;
}

async function stopEdge(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), delay(3000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function jsonRequest(baseUrl, path, init) {
  const headers = new Headers(init?.headers);
  if (sessionCookie) headers.set('cookie', sessionCookie);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const body = await response.json();
  return { response, body };
}

async function receiveSocketMessage(url, cookie) {
  return new Promise((resolveMessage, rejectMessage) => {
    const socket = new WebSocket(url, { headers: cookie ? { cookie } : {} });
    socket.once('message', (data) => {
      try { resolveMessage({ message: JSON.parse(data.toString()), statusCode: 101 }); }
      catch (error) { rejectMessage(error); }
      socket.close();
    });
    socket.once('unexpected-response', (_request, response) => resolveMessage({ statusCode: response.statusCode }));
    socket.once('error', rejectMessage);
  });
}

test('managed menu sync is local-first across WAN loss and an edge restart', { timeout: 90000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'common-table-menu-sync-'));
  const databasePath = join(directory, 'edge.sqlite');
  const upstreamPort = await listen(upstream);
  const edgePortServer = createServer();
  const edgePort = await listen(edgePortServer);
  await new Promise((resolveClose) => edgePortServer.close(resolveClose));
  const upstreamUrl = `http://127.0.0.1:${upstreamPort}/functions/v1/pos-sync`;
  const baseUrl = `http://127.0.0.1:${edgePort}`;
  let child;
  t.after(async () => {
    if (child) await stopEdge(child);
    await new Promise((resolveClose) => upstream.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  });

  upstreamAvailable = true;
  serverLogs = '';
  child = startEdge({ port: edgePort, databasePath, upstreamUrl });
  await waitFor(async () => (await fetch(`${baseUrl}/api/ready`)).ok, 'edge server did not become ready');
  const unauthenticatedSocket = await receiveSocketMessage(`${baseUrl.replace(/^http/, 'ws')}/socket`);
  assert.equal(unauthenticatedSocket.statusCode, 401, 'WebSocket data requires an outlet session');
  assert.equal((await jsonRequest(baseUrl, '/api/orders')).response.status, 401, 'order data is unavailable without a staff session');
  const ownerLogin = await jsonRequest(baseUrl, '/api/auth/session', { method: 'POST', headers: { authorization: 'Bearer owner-token' } });
  assert.equal(ownerLogin.response.status, 200);
  assert.equal(ownerLogin.body.role, 'owner');
  const cookieHeader = ownerLogin.response.headers.get('set-cookie');
  assert.match(cookieHeader, /HttpOnly/);
  assert.match(cookieHeader, /SameSite=Strict/);
  assert.doesNotMatch(cookieHeader, /; Secure/);
  sessionCookie = cookieHeader.split(';', 1)[0];
  assert.equal((await jsonRequest(baseUrl, '/api/auth/session')).body.userId, 'owner-user');
  const kitchenLogin = await jsonRequest(baseUrl, '/api/auth/session', { method: 'POST', headers: { authorization: 'Bearer kitchen-token' } });
  assert.equal(kitchenLogin.response.status, 200);
  sessionCookie = kitchenLogin.response.headers.get('set-cookie').split(';', 1)[0];
  assert.equal((await jsonRequest(baseUrl, '/api/kitchen')).response.status, 200);
  assert.equal((await jsonRequest(baseUrl, '/api/orders')).response.status, 403, 'kitchen staff cannot read the cashier order list');
  assert.equal((await jsonRequest(baseUrl, '/api/reports/daily')).response.status, 403, 'kitchen staff cannot read financial reports');
  assert.equal((await jsonRequest(baseUrl, '/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).response.status, 403);
  const cashierLogin = await jsonRequest(baseUrl, '/api/auth/session', { method: 'POST', headers: { authorization: 'Bearer cashier-token' } });
  assert.equal(cashierLogin.response.status, 200);
  sessionCookie = cashierLogin.response.headers.get('set-cookie').split(';', 1)[0];
  assert.equal((await jsonRequest(baseUrl, '/api/reports/daily')).response.status, 403, 'cashiers cannot read manager reports');
  const cashierInventoryMovement=await jsonRequest(baseUrl,'/api/inventory/movements',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    commandId:randomUUID(),inventoryItemId:inventoryItems[0].id,movementType:'receipt',quantity:1,expectedBalance:null,reason:'Delivery received',
  })});
  assert.equal(cashierInventoryMovement.response.status,403,'cashiers cannot change inventory');
  const ownerSession = await jsonRequest(baseUrl, '/api/auth/session', { method: 'POST', headers: { authorization: 'Bearer owner-token' } });
  sessionCookie = ownerSession.response.headers.get('set-cookie').split(';', 1)[0];
  await waitFor(async () => {
    const { body } = await jsonRequest(baseUrl, '/api/sync/status');
    return body.menu?.version === version;
  }, 'cloud menu did not hydrate into SQLite');
  assert.deepEqual((await jsonRequest(baseUrl, '/api/context')).body, {
    tenantId, tenantName: 'Test Cafe', outletId, outletName: outletConfig.name,
    terminalId, terminalName: 'Counter 1', locationLabel: 'Test Location',
    currency: 'USD', timeZone: 'UTC', taxRateBps: 1000, setupMode: 'cloud',
    receipt: { name: outletConfig.receiptName, address: outletConfig.receiptAddress, phone: outletConfig.receiptPhone,
      gstin: outletConfig.gstin, footer: outletConfig.receiptFooter },
  }, 'the paired edge applies cloud outlet settings');
  assert.deepEqual((await jsonRequest(baseUrl, '/api/floor-plan')).body, localFloorPlan(),
    'the paired edge applies the active cloud floor plan and kitchen stations');
  assert.equal((await jsonRequest(baseUrl, '/api/inventory')).body[0].onHand, 500,
    'the edge hydrates the cloud stock balance for offline operation');

  const firstMenu = await jsonRequest(baseUrl, '/api/menu');
  assert.equal(firstMenu.body.length, 2);
  assert.equal(firstMenu.body[0].name, 'Indori Poha');
  assert.equal(firstMenu.body[0].priceMinor, 500);
  assert.equal(firstMenu.body[0].modifiers[0].priceDeltaMinor, 50);

  upstreamAvailable = false;
  const commandId = randomUUID();
  const created = await jsonRequest(baseUrl, '/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId, tenantId, outletId, terminalId, orderType: 'dine_in', tableLabel: 'Table 01', guestCount: 1,
      lines: [{ menuItemId: 'cloud-poha', quantity: 1, modifierIds: ['cloud-modifier'] }] }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.subtotalMinor, 550);
  assert.equal(created.body.taxTotalMinor, 28);
  assert.equal(created.body.totalMinor, 578, 'the item rate overrides the outlet fallback for the accepted order');
  assert.equal(created.body.lines[0].taxCode, '1101');
  assert.equal(created.body.lines[0].taxRateBps, 500);
  assert.equal(created.body.currency, 'USD');
  assert.equal(created.body.taxRateBps, 1000);
  assert.deepEqual((await jsonRequest(baseUrl, '/api/floor-plan')).body, localFloorPlan(['Table 01']),
    'active dine-in orders mark their configured table as occupied');
  assert.equal((await jsonRequest(baseUrl, '/api/menu')).body.length, 2);

  const addCommandId = randomUUID();
  const addition = { commandId: addCommandId, lines: [{ menuItemId: 'cloud-chai', quantity: 1 }] };
  const added = await jsonRequest(baseUrl, `/api/orders/${created.body.id}/lines`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(addition),
  });
  assert.equal(added.response.status, 201);
  assert.equal(added.body.totalMinor, 778, 'an explicit zero item rate stays zero instead of inheriting outlet tax');
  assert.equal(added.body.lines[1].taxRateBps, 0);
  const replayedAddition = await jsonRequest(baseUrl, `/api/orders/${created.body.id}/lines`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(addition),
  });
  assert.equal(replayedAddition.response.status, 200);
  assert.equal(replayedAddition.body.lines.length, 2);

  const kitchen = await jsonRequest(baseUrl, '/api/kitchen');
  assert.equal(kitchen.body.length, 2, 'one order creates separate tickets per kitchen station');
  const hotTicket = kitchen.body.find((ticket) => ticket.kitchenStation === 'Hot kitchen');
  const beverageTicket = kitchen.body.find((ticket) => ticket.kitchenStation === 'Beverage station');
  assert.deepEqual(hotTicket.lines.map((line) => line.menuItemId), ['cloud-poha']);
  assert.deepEqual(beverageTicket.lines.map((line) => line.menuItemId), ['cloud-chai']);
  assert.equal(hotTicket.ticketStatus, 'new');
  assert.equal(beverageTicket.ticketStatus, 'new');

  const beverageStatusUrl = `/api/orders/${created.body.id}/stations/${encodeURIComponent('Beverage station')}/status`;
  const kitchenSession = await jsonRequest(baseUrl, '/api/auth/session', { method: 'POST', headers: { authorization: 'Bearer kitchen-token' } });
  sessionCookie = kitchenSession.response.headers.get('set-cookie').split(';', 1)[0];
  const kitchenSocket = await receiveSocketMessage(`${baseUrl.replace(/^http/, 'ws')}/socket`, sessionCookie);
  assert.equal(kitchenSocket.message.type, 'kitchen.snapshot');
  assert.equal('totalMinor' in kitchenSocket.message.payload[0], false, 'kitchen sockets do not receive sales totals');
  assert.equal('unitPriceMinor' in kitchenSocket.message.payload[0].lines[0], false, 'kitchen sockets do not receive item prices');
  const modifiedKitchenLine = kitchenSocket.message.payload.flatMap((ticket) => ticket.lines).find((line) => line.modifiers.length > 0);
  assert.equal(modifiedKitchenLine.modifiers[0].priceDeltaMinor, 0, 'kitchen sockets do not receive modifier prices');
  const forbiddenKitchenVoid = await jsonRequest(baseUrl, `/api/orders/${created.body.id}/lines/${added.body.lines.find((line) => line.menuItemId === 'cloud-chai').id}/void`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: randomUUID(), reason: 'not allowed' }),
  });
  assert.equal(forbiddenKitchenVoid.response.status, 403, 'kitchen staff cannot void order items');
  const preparingBeverage = await jsonRequest(baseUrl, beverageStatusUrl, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'preparing' }),
  });
  assert.equal(preparingBeverage.body.status, 'preparing');
  assert.equal('totalMinor' in preparingBeverage.body, false, 'kitchen status responses do not expose order totals');
  let stationTickets = (await jsonRequest(baseUrl, '/api/kitchen')).body;
  assert.equal(stationTickets.find((ticket) => ticket.kitchenStation === 'Beverage station').ticketStatus, 'preparing');
  assert.equal(stationTickets.find((ticket) => ticket.kitchenStation === 'Hot kitchen').ticketStatus, 'new');
  const ownerAfterKitchen = await jsonRequest(baseUrl, '/api/auth/session', { method: 'POST', headers: { authorization: 'Bearer owner-token' } });
  sessionCookie = ownerAfterKitchen.response.headers.get('set-cookie').split(';', 1)[0];

  const readyBeverage = await jsonRequest(baseUrl, beverageStatusUrl, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'ready' }),
  });
  assert.equal(readyBeverage.body.status, 'sent', 'the order remains open while the hot kitchen ticket is new');
  const preparingHot = await jsonRequest(baseUrl, `/api/orders/${created.body.id}/stations/${encodeURIComponent('Hot kitchen')}/status`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'preparing' }),
  });
  assert.equal(preparingHot.body.status, 'preparing');
  const readyHot = await jsonRequest(baseUrl, `/api/orders/${created.body.id}/stations/${encodeURIComponent('Hot kitchen')}/status`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'ready' }),
  });
  assert.equal(readyHot.body.status, 'ready', 'the order becomes ready when every active station is ready');
  const replayReady = await jsonRequest(baseUrl, beverageStatusUrl, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'ready' }),
  });
  assert.equal(replayReady.body.status, 'ready', 'repeating the same ticket transition is idempotent');

  const chaiLine = added.body.lines.find((line) => line.menuItemId === 'cloud-chai');
  const voidCommandId = randomUUID();
  const voidBody = { commandId: voidCommandId, reason: 'Guest changed mind' };
  const voided = await jsonRequest(baseUrl, `/api/orders/${created.body.id}/lines/${chaiLine.id}/void`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(voidBody),
  });
  assert.equal(voided.response.status, 200);
  assert.equal(voided.body.totalMinor, 578);
  assert.equal(voided.body.lines.find((line) => line.id === chaiLine.id).voidReason, 'Guest changed mind');
  stationTickets = (await jsonRequest(baseUrl, '/api/kitchen')).body;
  assert.equal(stationTickets.length, 1, 'voiding the last item removes only its station ticket');
  assert.equal(stationTickets[0].kitchenStation, 'Hot kitchen');
  assert.equal(stationTickets[0].ticketStatus, 'ready');
  assert.equal(voided.body.status, 'ready');
  const replayedVoid = await jsonRequest(baseUrl, `/api/orders/${created.body.id}/lines/${chaiLine.id}/void`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(voidBody),
  });
  assert.equal(replayedVoid.body.lines.filter((line) => line.voidedAt).length, 1);
  const queued = await jsonRequest(baseUrl, '/api/sync/status');
  assert.ok(queued.body.pending >= 1, 'order events remain in the durable outbox while WAN is down');

  await stopEdge(child);
  child = undefined;
  upstreamAvailable = true;
  serverLogs = '';
  child = startEdge({ port: edgePort, databasePath, upstreamUrl });
  await waitFor(async () => {
    const { body } = await jsonRequest(baseUrl, '/api/orders');
    return body.some((order) => order.commandId === commandId);
  }, 'accepted order was lost after edge restart');
  await waitFor(async () => {
    const { body } = await jsonRequest(baseUrl, '/api/sync/status');
    return body.pending === 0 && body.menu?.version === version;
  }, 'outbox did not sync after WAN returned');
  assert.equal((await jsonRequest(baseUrl, '/api/context')).body.currency, 'USD', 'cloud outlet settings survive an edge restart');
  assert.equal((await jsonRequest(baseUrl, '/api/context')).body.taxRateBps, 1000);
  assert.equal((await jsonRequest(baseUrl, '/api/context')).body.timeZone, 'UTC');
  assert.ok(seenEtags.some((etag) => etag === `"${version}"`),
    `edge requests a 304 when the cloud menu is unchanged (${JSON.stringify({ version, seenEtags })})`);
  const restoredMenu = await jsonRequest(baseUrl, '/api/menu');
  assert.deepEqual(restoredMenu.body.map((item) => item.id), ['cloud-poha', 'cloud-chai']);
  const restoredOrder = (await jsonRequest(baseUrl, '/api/orders')).body.find((order) => order.commandId === commandId);
  assert.equal(restoredOrder.totalMinor, 578);
  assert.equal(restoredOrder.currency, 'USD');
  assert.equal(restoredOrder.taxRateBps, 1000);
  assert.equal(restoredOrder.status, 'ready');
  assert.equal(restoredOrder.lines.find((line) => line.menuItemId === 'cloud-chai').voidReason, 'Guest changed mind');
  const restoredTickets = (await jsonRequest(baseUrl, '/api/kitchen')).body;
  assert.equal(restoredTickets.length, 1);
  assert.equal(restoredTickets[0].ticketStatus, 'ready');

  const openedShift = await jsonRequest(baseUrl, '/api/shifts/open', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: randomUUID(), openingFloatMinor: 50000 }),
  });
  assert.equal(openedShift.response.status, 201);
  const splitPaymentCommand = { commandId: randomUUID(), orderId: created.body.id, shiftId: openedShift.body.shift.id,
    tenders: [{ method: 'cash', amountMinor: 300 }, { method: 'upi', amountMinor: 278 }] };
  const invalidSplit = await jsonRequest(baseUrl, `/api/orders/${created.body.id}/payment`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...splitPaymentCommand, commandId: randomUUID(), tenders: [{ method: 'cash', amountMinor: 300 }, { method: 'upi', amountMinor: 200 }] }),
  });
  assert.equal(invalidSplit.response.status, 409, 'tender amounts must equal the invoice total');
  upstreamAvailable = false;
  const payment = await jsonRequest(baseUrl, `/api/orders/${created.body.id}/payment`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(splitPaymentCommand),
  });
  assert.equal(payment.body.status, 'paid');
  assert.equal(payment.body.invoiceNumber, 'J-INV-000001');
  assert.equal((await jsonRequest(baseUrl, '/api/inventory')).body[0].onHand, 440,
    'paid orders consume recipe stock locally during WAN loss');
  const replayPayment = await jsonRequest(baseUrl, `/api/orders/${created.body.id}/payment`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(splitPaymentCommand),
  });
  assert.equal(replayPayment.response.status, 200, 'a repeated split tender command returns the original paid order');
  assert.equal((await jsonRequest(baseUrl, '/api/inventory')).body[0].onHand, 440,
    'a replayed payment does not consume recipe stock twice');
  const cashierSession = await jsonRequest(baseUrl, '/api/auth/session', { method: 'POST', headers: { authorization: 'Bearer cashier-token' } });
  const cashierCookie = cashierSession.response.headers.get('set-cookie').split(';', 1)[0];
  const refundCommand = { commandId: randomUUID(), paymentId: '', shiftId: openedShift.body.shift.id, amountMinor: 100, reason: 'Guest changed mind' };
  const paymentEvents = await jsonRequest(baseUrl, '/api/sync/status');
  assert.ok(paymentEvents.body.pending >= 4, 'order and both tender events are durably queued');
  const tenderList = await jsonRequest(baseUrl, `/api/orders/${created.body.id}/payments`);
  assert.equal(tenderList.response.status, 200);
  const originalUpi = tenderList.body.tenders.find((tender) => tender.method === 'upi');
  refundCommand.paymentId = originalUpi.id;
  assert.equal(originalUpi.refundableMinor, 278);
  const cashierPaymentList = await fetch(`${baseUrl}/api/orders/${created.body.id}/payments`, { headers: { cookie: cashierCookie } });
  assert.equal(cashierPaymentList.status, 403, 'cashiers cannot inspect manager refund controls');
  const cashierRefund = await fetch(`${baseUrl}/api/orders/${created.body.id}/refunds`, {
    method: 'POST', headers: { cookie: cashierCookie, 'content-type': 'application/json' }, body: JSON.stringify(refundCommand),
  });
  assert.equal(cashierRefund.status, 403, 'cashiers cannot issue manager-only refunds');
  const ownerSessionAfterCashier = await jsonRequest(baseUrl, '/api/auth/session', { method: 'POST', headers: { authorization: 'Bearer owner-token' } });
  sessionCookie = ownerSessionAfterCashier.response.headers.get('set-cookie').split(';', 1)[0];
  const refund = await jsonRequest(baseUrl, `/api/orders/${created.body.id}/refunds`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(refundCommand),
  });
  assert.equal(refund.response.status, 201);
  assert.equal(refund.body.refund.amountMinor, 100);
  const replayRefund = await jsonRequest(baseUrl, `/api/orders/${created.body.id}/refunds`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(refundCommand),
  });
  assert.equal(replayRefund.response.status, 200, 'refund retries return the original refund event');
  const overRefund = await jsonRequest(baseUrl, `/api/orders/${created.body.id}/refunds`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...refundCommand, commandId: randomUUID(), amountMinor: 206 }),
  });
  assert.equal(overRefund.response.status, 409, 'refunds cannot exceed the remaining amount on their original tender');
  const alteredReplay = await jsonRequest(baseUrl, `/api/orders/${created.body.id}/refunds`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...refundCommand, amountMinor: 101 }),
  });
  assert.equal(alteredReplay.response.status, 409, 'reusing a refund command with changed values is rejected');
  const closedShift = await jsonRequest(baseUrl, `/api/shifts/${openedShift.body.shift.id}/close`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: randomUUID(), countedCashMinor: 50300 }),
  });
  assert.equal(closedShift.body.shift.varianceMinor, 0);

  const report = await jsonRequest(baseUrl, '/api/reports/daily');
  assert.equal(report.response.status, 200);
  assert.equal(report.body.totals.paidOrderCount, 1);
  assert.equal(report.body.timeZone, 'UTC');
  assert.equal(report.body.currency, 'USD');
  assert.equal(report.body.totals.subtotalMinor, 455);
  assert.equal(report.body.totals.salesMinor, 478);
  assert.equal(report.body.totals.taxTotalMinor, 23, 'tax refunds are allocated proportionally to the original order tax');
  assert.deepEqual(report.body.taxBreakdown, [{ taxCode: '1101', taxRateBps: 500, taxMinor: 23, cgstMinor: 12, sgstMinor: 11 }]);
  assert.deepEqual(report.body.refunds, { count: 1, amountMinor: 100 });
  assert.deepEqual(report.body.tenders, [
    { method: 'cash', amountMinor: 300, paymentCount: 1 },
    { method: 'upi', amountMinor: 178, paymentCount: 1 },
  ]);
  assert.deepEqual(report.body.items.map((item) => ({ name: item.name, quantity: item.quantity, salesMinor: item.salesMinor })), [
    { name: 'Indori Poha', quantity: 1, salesMinor: 550 },
  ], 'voided items are excluded from paid item sales');
  assert.deepEqual(report.body.voids, { lineCount: 1, quantity: 1, amountMinor: 200 });
  assert.deepEqual(report.body.shifts, { closedCount: 1, expectedCashMinor: 50300, countedCashMinor: 50300, varianceMinor: 0 });
  const start = new Date(report.body.startAt);
  assert.equal(start.getUTCHours(), 0, 'UTC report days start at UTC midnight');
  assert.equal(start.getUTCMinutes(), 0);
  const invalidDate = await fetch(`${baseUrl}/api/reports/daily?date=2026-02-30`, { headers: { cookie: sessionCookie } });
  assert.equal(invalidDate.status, 400);
  const csv = await fetch(`${baseUrl}/api/reports/daily.csv?date=${report.body.date}`, { headers: { cookie: sessionCookie } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const csvText = await csv.text();
  assert.match(csvText, /net_sales/);
  assert.match(csvText, /refunds/);
  assert.match(csvText, /Indori Poha/);
  assert.match(csvText, /tax_rate/);
  assert.match(csvText, /closed_shifts/);
  upstreamAvailable = true;
  await waitFor(async () => (await jsonRequest(baseUrl, '/api/sync/status')).body.pending === 0,
    'inventory consumption did not sync after the WAN returned');
  assert.equal(inventoryItems[0].onHand, 440, 'the synced cloud stock balance includes recipe consumption');
  assert.equal((await jsonRequest(baseUrl, '/api/inventory')).body[0].onHand, 440,
    'a newer cloud inventory snapshot replaces the edge movement without double counting');

  outletConfig = { name: 'Updated Test Outlet', timezone: 'Asia/Kolkata', currency: 'INR', taxRateBps: 500,
    receiptName: 'Updated Test Cafe', receiptAddress: '22 Sample Road', receiptPhone: '+91 12345 67890',
    gstin: '22AAAAA0000A1Z5', receiptFooter: 'Visit again soon' };
  layout = { areas: [
    { id: 'area-main', name: 'Main floor', sortOrder: 0, tables: [{ id: 'table-1', name: 'Table 01', capacity: 2, sortOrder: 0 }] },
    { id: 'area-patio', name: 'Patio', sortOrder: 1, tables: [{ id: 'patio-1', name: 'Patio 01', capacity: 4, sortOrder: 0 }] },
  ], stations: [{ id: 'station-hot', name: 'Hot kitchen', sortOrder: 0 }, { id: 'station-tea', name: 'Tea station', sortOrder: 1 }] };
  version = snapshotVersion();
  await waitFor(async () => {
    const [{ body: context }, { body: syncStatus }] = await Promise.all([
      jsonRequest(baseUrl, '/api/context'), jsonRequest(baseUrl, '/api/sync/status'),
    ]);
    return context.outletName === outletConfig.name && context.timeZone === outletConfig.timezone
      && context.currency === outletConfig.currency && context.taxRateBps === outletConfig.taxRateBps
      && JSON.stringify(context.receipt) === JSON.stringify({ name: outletConfig.receiptName, address: outletConfig.receiptAddress,
        phone: outletConfig.receiptPhone, gstin: outletConfig.gstin, footer: outletConfig.receiptFooter })
      && JSON.stringify((await jsonRequest(baseUrl, '/api/floor-plan')).body) === JSON.stringify(localFloorPlan())
      && syncStatus.menu?.version === version;
  }, 'a cloud-only outlet setting change did not reach the running edge', 40_000);
  const updatedOrder = await jsonRequest(baseUrl, '/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: randomUUID(), tenantId, outletId, terminalId, orderType: 'takeaway', guestCount: 1,
      lines: [{ menuItemId: 'cloud-poha', quantity: 1 }] }),
  });
  assert.equal(updatedOrder.response.status, 201);
  assert.equal(updatedOrder.body.currency, 'INR');
  assert.equal(updatedOrder.body.taxRateBps, 500);
  assert.equal(updatedOrder.body.taxTotalMinor, 26, 'CGST and SGST of 2.5% each on Rs 5.00');
  assert.equal(updatedOrder.body.totalMinor, 500, 'INR bills round to the nearest rupee');
  assert.equal(updatedOrder.body.roundOffMinor, -26);
  const originalOrderAfterConfigChange = (await jsonRequest(baseUrl, '/api/orders')).body.find((order) => order.commandId === commandId);
  assert.equal(originalOrderAfterConfigChange.currency, 'USD', 'configuration updates do not rewrite historical order currency');
  assert.equal(originalOrderAfterConfigChange.taxRateBps, 1000, 'configuration updates do not rewrite historical order tax');

  upstreamAvailable=false;
  const offlineReceipt={commandId:randomUUID(),inventoryItemId:inventoryItems[0].id,movementType:'receipt',quantity:5,expectedBalance:null,reason:'Morning delivery'};
  const receipt=await jsonRequest(baseUrl,'/api/inventory/movements',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(offlineReceipt)});
  assert.equal(receipt.response.status,201,'manager can save an inventory receipt without WAN');
  assert.equal(receipt.body.inventory[0].onHand,445);
  assert.equal((await jsonRequest(baseUrl,'/api/inventory/movements',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(offlineReceipt)})).response.status,200,
    'replaying a movement command does not duplicate stock');
  const waste=await jsonRequest(baseUrl,'/api/inventory/movements',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    commandId:randomUUID(),inventoryItemId:inventoryItems[0].id,movementType:'waste',quantity:2,expectedBalance:null,reason:'Spoilage recorded',
  })});
  assert.equal(waste.body.inventory[0].onHand,443);
  const count={commandId:randomUUID(),inventoryItemId:inventoryItems[0].id,movementType:'count_adjustment',quantity:442,expectedBalance:443,reason:'Closing count'};
  const savedCount=await jsonRequest(baseUrl,'/api/inventory/movements',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(count)});
  assert.equal(savedCount.body.inventory[0].onHand,442);
  assert.equal((await jsonRequest(baseUrl,'/api/inventory/movements',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...count,commandId:randomUUID(),expectedBalance:443})})).response.status,409,
    'a physical count based on a stale local balance is rejected');
  assert.ok((await jsonRequest(baseUrl,'/api/sync/status')).body.pending>=3,'offline stock movements are durable in the sync outbox');
  inventoryItems[0].onHand += 10;
  version = snapshotVersion();
  upstreamAvailable=true;
  const conflicts=await waitFor(async()=>{
    const result=await jsonRequest(baseUrl,'/api/inventory/conflicts');
    return result.body.length===1?result.body:null;
  },'stale cloud count conflict was not surfaced for manager review');
  assert.equal(conflicts[0].countedQuantity,442);
  const retired=await jsonRequest(baseUrl,`/api/inventory/conflicts/${conflicts[0].movementId}/discard`,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({reason:'Discard stale count and recount from refreshed balance.'})});
  assert.equal(retired.response.status,200,retired.body.error);
  assert.equal(retired.body.inventory[0].onHand,453,'refresh removes the rejected delta but keeps the current cloud balance');
  assert.equal(retired.body.conflicts.length,0);
  assert.equal((await jsonRequest(baseUrl,'/api/inventory/movements',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    commandId:randomUUID(),inventoryItemId:inventoryItems[0].id,movementType:'count_adjustment',quantity:452,expectedBalance:453,reason:'Recount after sync conflict',
  })})).response.status,201,'manager can record a fresh count against the refreshed cloud balance');
  await waitFor(async()=>{
    const [{body:status},{body:stock}]=await Promise.all([jsonRequest(baseUrl,'/api/sync/status'),jsonRequest(baseUrl,'/api/inventory')]);
    return status.pending===0&&stock[0].onHand===452&&inventoryItems[0].onHand===452;
  },'recount did not reconcile after retiring the stale count');
});
