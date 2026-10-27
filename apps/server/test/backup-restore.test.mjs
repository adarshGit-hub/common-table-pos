import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const tenantId = 'tenant-common-table-demo';
const outletId = 'outlet-vijay-nagar-demo';

function seedDatabase(path, marker) {
  const database = new Database(path);
  database.pragma('foreign_keys = ON');
  database.exec(readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  database.prepare('INSERT OR IGNORE INTO tenants(id,name) VALUES(?,?)').run(tenantId, 'Restore test cafe');
  database.prepare('INSERT OR IGNORE INTO outlets(id,tenant_id,name) VALUES(?,?,?)').run(outletId, tenantId, 'Restore test outlet');
  database.exec('CREATE TABLE IF NOT EXISTS restore_test_marker(value TEXT NOT NULL)');
  database.prepare('DELETE FROM restore_test_marker').run();
  database.prepare('INSERT INTO restore_test_marker(value) VALUES(?)').run(marker);
  database.close();
}

function runCli(script, environment) {
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', ...environment },
  });
  assert.equal(result.status, 0, `${script} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim().split('\n').map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

test('SQLite backup restores verified outlet data and keeps a pre-restore safety copy', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'common-table-restore-'));
  const databasePath = join(directory, 'edge.sqlite');
  const backupPath = join(directory, 'verified-backup.sqlite');
  const destinationPath = join(directory, 'restored-edge.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));

  seedDatabase(databasePath, 'backup-value');
  const backupResult = runCli('apps/server/dist/backup.js', { POS_DATABASE_PATH: databasePath, POS_BACKUP_PATH: backupPath });
  assert.equal(backupResult.at(-1).event, 'database.backup.completed');
  assert.equal(backupResult.at(-1).integrity, 'ok');
  const verifiedBackup = new Database(backupPath, { readonly: true, fileMustExist: true });
  assert.equal(verifiedBackup.prepare('SELECT value FROM restore_test_marker').get().value, 'backup-value');
  assert.equal(verifiedBackup.pragma('quick_check')[0].quick_check, 'ok');
  verifiedBackup.close();

  seedDatabase(destinationPath, 'before-restore');
  const restoreResult = runCli('apps/server/dist/restore.js', {
    POS_DATABASE_PATH: destinationPath,
    POS_RESTORE_PATH: destinationPath,
    POS_RESTORE_SOURCE: backupPath,
  });
  const restored = restoreResult.at(-1);
  assert.equal(restored.event, 'database.restore.completed');
  assert.equal(restored.integrity, 'ok');
  assert.ok(restored.safetyBackup);

  const database = new Database(destinationPath, { readonly: true });
  assert.equal(database.prepare('SELECT value FROM restore_test_marker').get().value, 'backup-value');
  assert.equal(database.pragma('quick_check')[0].quick_check, 'ok');
  database.close();

  const safetyCopy = new Database(restored.safetyBackup, { readonly: true });
  assert.equal(safetyCopy.prepare('SELECT value FROM restore_test_marker').get().value, 'before-restore');
  assert.equal(safetyCopy.pragma('quick_check')[0].quick_check, 'ok');
  safetyCopy.close();
});

test('restore replaces a crashed database whose write-ahead log was never checkpointed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'common-table-restore-wal-'));
  const backupPath = join(directory, 'verified-backup.sqlite');
  const destinationPath = join(directory, 'edge.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));

  seedDatabase(backupPath, 'backup-value');
  seedDatabase(destinationPath, 'before-crash');
  // Simulate a crashed edge: a WAL write that is never checkpointed or closed.
  const crash = spawnSync(process.execPath, ['-e', `
    const Database = require(${JSON.stringify(join(root, 'node_modules/better-sqlite3'))});
    const database = new Database(${JSON.stringify(destinationPath)});
    database.pragma('journal_mode = WAL');
    database.pragma('wal_autocheckpoint = 0');
    database.prepare('UPDATE restore_test_marker SET value=?').run('live-wal-value');
    process.kill(process.pid, 'SIGKILL');
  `], { cwd: root, encoding: 'utf8' });
  assert.equal(crash.signal, 'SIGKILL', crash.stderr);

  const restored = runCli('apps/server/dist/restore.js', {
    POS_DATABASE_PATH: destinationPath, POS_RESTORE_PATH: destinationPath, POS_RESTORE_SOURCE: backupPath,
  }).at(-1);
  assert.equal(restored.event, 'database.restore.completed');

  const database = new Database(destinationPath, { readonly: true });
  assert.equal(database.prepare('SELECT value FROM restore_test_marker').get().value, 'backup-value');
  database.close();
  const safetyCopy = new Database(restored.safetyBackup, { readonly: true });
  assert.equal(safetyCopy.prepare('SELECT value FROM restore_test_marker').get().value, 'live-wal-value',
    'the safety copy keeps the crashed database including its un-checkpointed writes');
  safetyCopy.close();
});
