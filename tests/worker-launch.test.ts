import test from 'node:test';
import assert from 'node:assert/strict';
import { workerLaunch, launchEnvironment } from '../src/worker-launch.js';
import { Agents } from '../src/agents.js';
import { WezTermBackend } from '../src/backend.js';

test('managed args and environment preserve literal values through the configured launcher', () => {
  const key = 'TERM_DAD_CODEX_COMMAND';
  const previous = process.env[key];
  try {
    const base = ['/bin/zsh', '-lic', 'exec "$@"', 'term-dad-worker', 'codex'];
    process.env[key] = JSON.stringify(base);
    const args = ['--model', 'literal $(touch /tmp/nope); `pwd`', ''];
    const env = { EXAMPLE: 'a b\n$(pwd)\'"', EMPTY: '' };
    const { launch } = workerLaunch({ cli: 'codex', args, env });
    assert.deepEqual(launch.command, [...base, ...args]);
    assert.deepEqual(launchEnvironment(launch.command, env), [
      'env',
      ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
      ...base,
      ...args,
    ]);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});
test('custom commands reject args and env, and environment is bounded', () => {
  for (const extra of [{ args: [] }, { env: {} }])
    assert.throws(() => workerLaunch({ cli: 'codex', command: ['codex'], ...extra }), /WORKER_CONFIGURATION/);
  for (const env of [
    { 'BAD=KEY': 'x' },
    { OK: '\0' },
    { OK: 'x'.repeat(8193) },
    Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`KEY${i}`, 'x'])),
  ])
    assert.throws(() => workerLaunch({ cli: 'codex', env }), /WORKER_CONFIGURATION/);
});
test('missing hook service requires an explicit polling escape hatch', async () => {
  let spawned = 0;
  const agents = new Agents(
    new WezTermBackend(
      async (args) => {
        if (args[0] === 'spawn') {
          spawned++;
          return '1';
        }
        return '[]';
      },
      async () => null,
    ),
  );
  await assert.rejects(agents.spawn({ name: 'required', cli: 'codex' }), /WORKER_HOOKS_UNAVAILABLE/);
  assert.equal(spawned, 0);
  await agents.spawn({ name: 'polling', cli: 'codex', supervision: 'polling' });
  assert.equal(spawned, 1);
});
