import Database from 'better-sqlite3';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { EDGE_CONFIG } from './config.js';

function verifyOutlet(database: Database.Database, label: string): void {
  const integrity = database.pragma('quick_check') as Array<{ quick_check: string }>;
  if (integrity.length !== 1 || integrity[0]?.quick_check !== 'ok') throw new Error(`${label} failed SQLite quick_check.`);
  const foreignKeys = database.pragma('foreign_key_check') as Array<Record<string, unknown>>;
  if (foreignKeys.length) throw new Error(`${label} contains foreign-key violations.`);
  const tenant = database.prepare('SELECT 1 AS found FROM tenants WHERE id=?').get(EDGE_CONFIG.tenantId);
  const outlet = database.prepare('SELECT 1 AS found FROM outlets WHERE id=? AND tenant_id=?').get(EDGE_CONFIG.outletId, EDGE_CONFIG.tenantId);
  if (!tenant || !outlet) throw new Error(`${label} does not contain the configured tenant and outlet.`);
}

const sourcePath = process.env.POS_RESTORE_SOURCE?.trim();
if (!sourcePath) throw new Error('Set POS_RESTORE_SOURCE to the verified SQLite backup file.');
const source = resolve(sourcePath);
const destination = resolve(process.env.POS_RESTORE_PATH ?? process.env.POS_DATABASE_PATH ?? '.data/common-table.db');
if (source === destination) throw new Error('The restore source and destination must be different files.');
if (!existsSync(source)) throw new Error(`Restore source does not exist: ${source}`);

mkdirSync(dirname(destination), { recursive: true });
const temporary = resolve(dirname(destination), `.${basename(destination)}.restore-${process.pid}-${Date.now()}`);
let safetyBackup: string | undefined;
let sourceDb: Database.Database | undefined;
let destinationDb: Database.Database | undefined;

try {
  sourceDb = new Database(source, { readonly: true, fileMustExist: true });
  verifyOutlet(sourceDb, 'Restore source');
  await sourceDb.backup(temporary);
  sourceDb.close(); sourceDb = undefined;

  destinationDb = new Database(temporary, { readonly: true, fileMustExist: true });
  verifyOutlet(destinationDb, 'Staged restore');
  destinationDb.close(); destinationDb = undefined;

  if (existsSync(destination)) {
    safetyBackup = `${destination}.pre-restore-${new Date().toISOString().replaceAll(':', '-')}.db`;
    // Fold any write-ahead log left by a crash into the main file. Otherwise SQLite
    // would replay that stale log over the restored file after the rename.
    const activeDb = new Database(destination, { fileMustExist: true });
    const [checkpoint] = activeDb.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
    if (checkpoint?.busy) {
      activeDb.close();
      throw new Error('The database is in use. Stop the edge service before restoring.');
    }
    await activeDb.backup(safetyBackup);
    activeDb.close();
    const verifiedSafetyCopy = new Database(safetyBackup, { readonly: true, fileMustExist: true });
    verifyOutlet(verifiedSafetyCopy, 'Pre-restore safety backup');
    verifiedSafetyCopy.close();
  }

  for (const suffix of ['-wal', '-shm']) rmSync(`${destination}${suffix}`, { force: true });
  renameSync(temporary, destination);
  const restoredDb = new Database(destination, { readonly: true, fileMustExist: true });
  verifyOutlet(restoredDb, 'Restored database');
  restoredDb.close();
  console.log(JSON.stringify({ level: 'info', event: 'database.restore.completed', source, destination,
    safetyBackup: safetyBackup ?? null, integrity: 'ok', tenantId: EDGE_CONFIG.tenantId, outletId: EDGE_CONFIG.outletId }));
} catch (error) {
  console.error(JSON.stringify({ level: 'error', event: 'database.restore.failed',
    message: error instanceof Error ? error.message : 'unknown', safetyBackup: safetyBackup ?? null }));
  process.exitCode = 1;
} finally {
  sourceDb?.close();
  destinationDb?.close();
  if (existsSync(temporary)) rmSync(temporary, { force: true });
}
