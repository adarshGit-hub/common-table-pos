import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const { port } = server.address();
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}

test('production shutdown waits for an in-flight menu sync before closing SQLite', { timeout: 15000 }, async t => {
  let releaseUpstream;
  let onMenuRequest;
  const menuRequest = new Promise(resolveRequest => { onMenuRequest = resolveRequest; });
  const upstream = createServer((request, response) => {
    if (request.method !== 'GET' || request.headers['x-pos-terminal-key'] !== 'shutdown-test-terminal-key') {
      response.writeHead(401).end('{"error":"unauthorized"}');
      return;
    }
    releaseUpstream = () => response.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"simulated upstream failure"}');
    onMenuRequest();
  });
  await new Promise((resolveListen, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolveListen); });

  const directory = await mkdtemp(join(tmpdir(), 'common-table-sync-shutdown-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production', PORT: String(port), POS_DATABASE_PATH: join(directory, 'edge.sqlite'),
      POS_TENANT_ID: 'shutdown-test-tenant', POS_TENANT_NAME: 'Shutdown Test Cafe',
      POS_OUTLET_ID: 'shutdown-test-outlet', POS_OUTLET_NAME: 'Shutdown Test Outlet',
      POS_TERMINAL_ID: 'shutdown-test-terminal', POS_TERMINAL_NAME: 'Counter 1',
      POS_LOCATION_LABEL: 'Test Location', POS_ACTOR_ID: 'shutdown-test-manager',
      POS_TIMEZONE: 'Asia/Kolkata', POS_CURRENCY: 'INR', POS_TAX_RATE_BPS: '500',
      POS_SYNC_URL: `http://127.0.0.1:${upstream.address().port}/functions/v1/pos-sync`,
      POS_TERMINAL_KEY: 'shutdown-test-terminal-key',
      VITE_SUPABASE_URL: 'http://127.0.0.1', VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key',
      POS_SESSION_SECRET: 'shutdown-test-session-secret-that-is-at-least-32-bytes', POS_COOKIE_SECURE: 'false',
      POS_AUTO_BACKUP: 'false', POS_PRINTER_MODE: 'disabled',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-5000); });
  child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-5000); });

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), delay(1000)]);
    }
    if (upstream.listening) await new Promise(resolveClose => upstream.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  });

  await Promise.race([menuRequest, delay(5000).then(() => { throw new Error(`Edge did not start menu sync: ${output}`); })]);
  child.kill('SIGTERM');
  await delay(75);
  assert.equal(child.exitCode, null, 'shutdown waits while the menu request is still unresolved');
  releaseUpstream();
  const exitCode = await Promise.race([
    new Promise(resolveExit => child.once('exit', code => resolveExit(code))),
    delay(5000).then(() => { throw new Error(`Edge did not finish graceful shutdown: ${output}`); }),
  ]);
  assert.equal(exitCode, 0, output);
  assert.doesNotMatch(output, /database connection is not open|uncaught exception|TypeError/);
});
