import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const installerPath = join(repositoryRoot, 'scripts/install-cashier-service.sh');

test('Linux cashier installer creates a persistent, restricted user service', { skip: process.platform !== 'linux' }, () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'common table installer-'));
  try {
    const appDir = join(tempRoot, 'repo');
    const fakeBin = join(tempRoot, 'bin');
    const homeDir = join(tempRoot, 'home');
    const configHome = join(tempRoot, 'config');
    const dataHome = join(tempRoot, 'data');
    mkdirSync(join(appDir, 'scripts'), { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    copyFileSync(installerPath, join(appDir, 'scripts/install-cashier-service.sh'));
    chmodSync(join(appDir, 'scripts/install-cashier-service.sh'), 0o755);
    writeFileSync(join(appDir, '.env'), [
      'VITE_SUPABASE_URL=https://example.supabase.co',
      'VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_test',
      'POS_TENANT_ID=test-tenant',
      'POS_OUTLET_ID=test-outlet',
      'POS_TERMINAL_ID=test-terminal',
      'POS_SESSION_SECRET=12345678901234567890123456789012',
      'POS_SYNC_URL=https://example.supabase.co/functions/v1/pos-sync',
      'POS_TERMINAL_KEY=test-terminal-key',
      'POS_DATABASE_PATH=.data/old.db',
    ].join('\n'));

    const fakeCommands = {
      node: '#!/usr/bin/env bash\nif [[ "${1:-}" == "--version" ]]; then printf \'v22.23.1\\n\'; fi\nexit 0\n',
      npm: '#!/usr/bin/env bash\nif [[ "${1:-}" == "--version" ]]; then printf \'10.9.8\\n\'; fi\nexit 0\n',
      systemctl: '#!/usr/bin/env bash\n[[ "$*" == *is-active* ]] && exit 3\nexit 0\n',
    };
    for (const [name, content] of Object.entries(fakeCommands)) {
      const path = join(fakeBin, name);
      writeFileSync(path, content);
      chmodSync(path, 0o755);
    }

    const result = spawnSync('/bin/bash', [join(appDir, 'scripts/install-cashier-service.sh')], {
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir, PATH: `${fakeBin}:${process.env.PATH}`, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const envPath = join(appDir, '.env');
    const envContents = readFileSync(envPath, 'utf8');
    assert.match(envContents, new RegExp(`^POS_DATABASE_PATH=${dataHome}/common-table-pos/outlet\\.sqlite$`, 'm'));
    assert.doesNotMatch(envContents, /^POS_DATABASE_PATH=\.data\/old\.db$/m);
    assert.equal(statSync(envPath).mode & 0o777, 0o600);

    const unitPath = join(configHome, 'systemd/user/common-table-pos.service');
    const unit = readFileSync(unitPath, 'utf8');
    assert.match(unit, /Restart=on-failure/);
    assert.match(unit, /ProtectSystem=strict/);
    const systemdDataHome = dataHome.replaceAll(' ', '\\x20');
    const systemdAppDir = appDir.replaceAll(' ', '\\x20');
    assert.ok(unit.includes(`WorkingDirectory=${systemdAppDir}`));
    assert.ok(unit.includes(`EnvironmentFile=${systemdAppDir}/.env`));
    assert.ok(unit.includes(`ReadWritePaths=${systemdDataHome}/common-table-pos`));
    assert.match(unit, /Environment=NODE_ENV=production/);
    assert.equal(statSync(unitPath).mode & 0o777, 0o600);
    if (spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' }).status === 0) {
      const unitCheck = spawnSync('systemd-analyze', ['verify', '--user', unitPath], { encoding: 'utf8' });
      assert.equal(unitCheck.status, 0, unitCheck.stderr || unitCheck.stdout);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
