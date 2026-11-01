import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const suite = existsSync(bash) ? describe : describe.skip;
suite('web startup migrations', () => {
  function run(mode: string, direct = '') {
    const dir = mkdtempSync(path.join(tmpdir(), 'start-web-test-'));
    try {
      writeFileSync(path.join(dir, 'npx'), `#!/bin/sh\nn=0; [ -f "$STUB_DIR/count" ] && n=$(cat "$STUB_DIR/count"); n=$((n+1)); echo "$n" > "$STUB_DIR/count"\necho "migration-url:$DATABASE_URL"\nif [ "$TEST_MODE" = retry ] && [ "$n" -eq 1 ]; then echo 'P1002: advisory lock timeout'; exit 1; fi\nif [ "$TEST_MODE" = fail ]; then echo 'P3009: migration failed'; exit 1; fi\nif [ "$TEST_MODE" = locked ]; then echo 'P1002: advisory lock timeout'; exit 1; fi\necho 'migrations complete'\n`, { mode: 0o755 });
      writeFileSync(path.join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(path.join(dir, 'node'), '#!/bin/sh\necho "app-start:$DATABASE_URL"\n', { mode: 0o755 });
      const shell = process.platform === 'win32' ? 'export STUB_DIR="$(cygpath -u "$STUB_DIR")"; ' : '';
      return spawnSync(bash, ['-c', `${shell}export PATH="$STUB_DIR:$PATH"; exec sh scripts/start-web.sh`], {
        cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, STUB_DIR: dir,
          DATABASE_URL: 'pooled-url', MIGRATION_DATABASE_URL: direct, TEST_MODE: mode },
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  it('retries a lock timeout and starts only after migrations succeed', () => {
    const result = run('retry');
    expect(result.status).toBe(0); expect(result.stdout).toContain('attempt 2/3');
    expect(result.stdout).toContain('app-start:pooled-url');
  });
  it('stops on migration errors and after bounded lock retries', () => {
    const failure = run('fail'); expect(failure.status).toBe(1); expect(failure.stdout).not.toContain('app-start:');
    expect(failure.stdout).not.toContain('attempt 2/3');
    const locked = run('locked'); expect(locked.status).toBe(1); expect(locked.stdout).toContain('attempt 3/3');
    expect(locked.stdout).not.toContain('app-start:');
  });
  it('uses the direct URL only for migrations, retaining the pooled app URL', () => {
    const result = run('success', 'direct-url');
    expect(result.status).toBe(0); expect(result.stdout).toContain('migration-url:direct-url');
    expect(result.stdout).toContain('app-start:pooled-url');
  });
});
