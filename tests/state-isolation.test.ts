import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('server tests isolate inherited state and never sweep a supervising worker credential', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'term-dad-sentinel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentials = join(directory, 'push-credentials');
  await mkdir(credentials, { mode: 0o700 });
  const agentId = '11111111-1111-4111-8111-111111111111';
  const path = join(credentials, `${agentId}.json`);
  const original = JSON.stringify({
    version: 1,
    agentId,
    socketPath: join(directory, 'fake.sock'),
    token: 'synthetic-test-only',
  });
  await writeFile(path, original, { mode: 0o600 });
  // Before isolation, each of these servers used an empty MemoryWorkerStorage
  // and swept every credential in the inherited state directory during restore.
  const env = { ...process.env, TERM_DAD_STATE_DIR: directory };
  // Let the nested runner own its test protocol rather than inherit our child marker.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      'tests/ergonomics.test.ts',
      'tests/event-freshness.test.ts',
      'tests/terminal-selection.test.ts',
    ],
    { env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(await readFile(path, 'utf8'), original, 'inherited credential must remain byte-for-byte unchanged');
  assert.deepEqual(
    await readdir(directory),
    ['push-credentials'],
    'no sockets, telemetry or journals in inherited state',
  );
});
