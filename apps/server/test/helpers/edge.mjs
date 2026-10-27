// Starts a development-mode edge against a disposable SQLite file and a capturing
// network printer, so end-to-end tests can drive the HTTP API directly.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
export const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function startEdge(t, env = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'common-table-edge-'));
  const databasePath = join(directory, 'edge.sqlite');
  const printed = [];
  const printer = createServer(socket => {
    let received = '';
    socket.on('data', chunk => { received += chunk.toString('latin1'); });
    socket.on('close', () => printed.push(received));
  });
  await new Promise((resolve, reject) => { printer.once('error', reject); printer.listen(0, '127.0.0.1', resolve); });
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'development', PORT: String(port), POS_DATABASE_PATH: databasePath,
      POS_TENANT_ID: 'test-tenant', POS_TENANT_NAME: 'Test Cafe', POS_OUTLET_ID: 'test-outlet',
      POS_OUTLET_NAME: 'Test Outlet', POS_TERMINAL_ID: 'test-terminal', POS_TERMINAL_NAME: 'Counter 1',
      POS_TAX_RATE_BPS: '500', DEMO_TAX_RATE_BPS: '500', POS_CURRENCY: 'INR', POS_TIMEZONE: 'Asia/Kolkata',
      POS_PRINTER_MODE: 'network', POS_PRINTER_HOST: '127.0.0.1', POS_PRINTER_PORT: String(printer.address().port),
      POS_SESSION_SECRET: '', POS_SYNC_URL: '', POS_TERMINAL_KEY: '', VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-5000); });
  child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-5000); });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2500)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    if (printer.listening) await new Promise(resolve => printer.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Test edge exited early: ${output}`);
    try { if ((await fetch(`${baseUrl}/api/ready`)).ok) break; } catch { /* still starting */ }
    if (Date.now() > deadline) throw new Error(`Test edge did not become ready: ${output}`);
    await delay(100);
  }

  // Development edges fall back to this secret; signing a cookie lets a test act as a given role.
  function staffCookie(role) {
    const session = { userId: `user-${role}`, email: `${role}@example.test`, displayName: role, role,
      tenantId: 'test-tenant', outletId: 'test-outlet', expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    const encoded = Buffer.from(JSON.stringify(session)).toString('base64url');
    const signature = createHmac('sha256', 'common-table-development-session-secret').update(encoded).digest('base64url');
    return `ct_pos_session=${encoded}.${signature}`;
  }

  async function request(path, { method = 'GET', body, as } = {}) {
    const headers = { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(as ? { cookie: staffCookie(as) } : {}) };
    const response = await fetch(`${baseUrl}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: response.status, body: json };
  }
  const context = (await request('/api/context')).body;

  async function waitForPrints(predicate, count = 1) {
    for (let attempt = 0; attempt < 60 && printed.filter(predicate).length < count; attempt += 1) await delay(50);
    return printed.filter(predicate);
  }

  async function openShift(openingFloatMinor = 0) {
    const result = await request('/api/shifts/open', { method: 'POST', body: { commandId: randomUUID(), openingFloatMinor } });
    if (result.status !== 201) throw new Error(`Could not open shift: ${JSON.stringify(result.body)}`);
    return result.body.shift.id;
  }

  async function createOrder(fields) {
    return request('/api/orders', { method: 'POST', body: {
      commandId: randomUUID(), tenantId: context.tenantId, outletId: context.outletId, terminalId: context.terminalId,
      orderType: 'takeaway', guestCount: 1, lines: [{ menuItemId: 'indori-poha', quantity: 1 }], ...fields,
    } });
  }

  return { baseUrl, databasePath, context, printed, request, waitForPrints, openShift, createOrder, logs: () => output };
}
