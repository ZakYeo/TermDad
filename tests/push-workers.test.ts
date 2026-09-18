import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agents } from '../src/agents.js';
import { WezTermBackend } from '../src/backend.js';
import { PushIngress } from '../src/ingress.js';
import { WorkerPushRegistry } from '../src/push-workers.js';
const stateDir = mkdtempSync(join(tmpdir(), 'term-dad-push-workers-'));
process.on('exit', () => rmSync(stateDir, { recursive: true, force: true }));
function fixture() {
  const spawns: string[][] = [];
  const backend = new WezTermBackend(
    async (args) => {
      if (args[0] === 'list')
        return JSON.stringify([
          { pane_id: 7, tab_id: 1, window_id: 1, title: 't', cwd: '/', size: { rows: 24, cols: 80 } },
        ]);
      if (args[0] === 'spawn') {
        spawns.push(args);
        return '7';
      }
      if (args[0] === 'get-text') return 'OpenAI Codex\n› ';
      return '';
    },
    async () => null,
  );
  const ingress = new PushIngress({ sink: async () => {} });
  const push = new WorkerPushRegistry(
    ingress,
    '/run/term-dad/push.sock',
    ['/usr/bin/node', '/opt/notify.js'],
    stateDir,
  );
  push.attach({ listening: true });
  return { agents: new Agents(backend, undefined, push), ingress, push, spawns };
}
test('a spawned worker carries inert push plumbing and stays disabled until it is turned on', async () => {
  const f = fixture();
  const { agentId } = await f.agents.spawn({ name: 'w', cli: 'claude' } as any);
  const argv = f.spawns[0].join(' ');
  assert.ok(argv.includes('--settings'), 'push hooks are injected at launch so enabling needs no restart');
  // The argv carries a credential path, so a restart can re-key this worker without relaunching it.
  assert.ok(argv.includes(join(stateDir, 'push-credentials', `${agentId}.json`)));
  assert.ok(!argv.includes('/run/term-dad/push.sock'), 'no socket path or token is baked into argv');
  assert.equal(f.ingress.status(agentId).enabled, false, 'push is off by default');
  assert.equal(f.ingress.status(agentId).paneId, 7, 'the registration is bound to the spawned pane');
  assert.equal((await f.push.setEnabled(agentId, true)).enabled, true);
});
test('push registration is released when a worker is stopped or forgotten', async () => {
  const f = fixture();
  const { agentId } = await f.agents.spawn({ name: 'w', cli: 'claude' } as any);
  await f.agents.forget(agentId);
  assert.throws(() => f.ingress.status(agentId), /PUSH_UNKNOWN_WORKER/);
  const second = await f.agents.spawn({ name: 'w2', cli: 'codex' } as any);
  assert.ok(f.spawns[1].join(' ').includes('notify='), 'codex workers get a notify program instead of hooks');
  await f.agents.stop(second.agentId);
  assert.throws(() => f.ingress.status(second.agentId), /PUSH_UNKNOWN_WORKER/);
});
test('a shell worker is launched unmodified and cannot be enabled for push', async () => {
  const f = fixture();
  const { agentId } = await f.agents.spawn({ name: 'sh', cli: 'shell' } as any);
  assert.ok(!f.spawns[0].join(' ').includes('push.sock'));
  await assert.rejects(f.push.setEnabled(agentId, true), /PUSH_UNSUPPORTED_WORKER/);
  // The status reason must say why, not describe a survivor that could be re-enabled.
  const status = await f.push.status(agentId);
  assert.equal(status.registered, false);
  assert.match(status.reason!, /shell workers have no hook surface/);
  assert.doesNotMatch(status.reason!, /surviving worker/);
});
test('a channel is only deliverable once the socket this server owns has actually bound', async () => {
  const f = fixture();
  const { agentId } = await f.agents.spawn({ name: 'w', cli: 'claude' } as any);
  assert.equal(f.push.deliverable(agentId), false, 'delivery needs an explicit enable');
  await f.push.setEnabled(agentId, true);
  assert.equal(f.push.deliverable(agentId), true);
  assert.deepEqual(f.push.socket(), { path: '/run/term-dad/push.sock', listening: true, bindError: undefined });
  // A server that could not bind still reports enabled intent, but nothing can reach it.
  f.push.attach({ listening: false, bindError: 'PUSH_SOCKET_PATH_OCCUPIED: refusing to replace a non-socket file' });
  assert.equal((await f.push.status(agentId)).enabled, true, 'the worker-side intent is unchanged');
  assert.equal(f.push.deliverable(agentId), false, 'an unbound socket is not deliverable');
  assert.match(f.push.socket().bindError!, /PUSH_SOCKET_PATH_OCCUPIED/);
  assert.equal(f.push.deliverable('absent'), false, 'an unknown worker is never deliverable');
});
test('enabling push fails for a channel that cannot deliver, rather than reporting success', async () => {
  const f = fixture();
  const { agentId } = await f.agents.spawn({ name: 'w', cli: 'claude' } as any);
  // A pane this server never launched has no hook surface and can never deliver.
  f.push.attachWorkers(async (id) =>
    id === agentId ? { agentId, cli: 'claude' } : id === 'adopted' ? { agentId: 'adopted', cli: 'codex' } : undefined,
  );
  await assert.rejects(f.push.setEnabled('adopted', true), /PUSH_NOT_WIRED/);
  f.push.attach({ listening: false, bindError: 'PUSH_SOCKET_PATH_OCCUPIED: refusing to replace a non-socket file' });
  await assert.rejects(f.push.setEnabled(agentId, true), /PUSH_SOCKET_UNAVAILABLE/);
  f.push.attach({ listening: true });
  const enabled = await f.push.setEnabled(agentId, true);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.proven, false, 'enabling never claims a delivery it has not observed');
  assert.match(enabled.note!, /not proven/);
});
test('disabling push always succeeds, including for a worker with no registration', async () => {
  const f = fixture();
  assert.deepEqual(
    await f.push.setEnabled('absent', false),
    { agentId: 'absent', enabled: false, registered: false },
    'turning delivery off is never blocked by the reasons it is broken',
  );
  const { agentId } = await f.agents.spawn({ name: 'w', cli: 'claude' } as any);
  await f.push.setEnabled(agentId, true);
  assert.equal((await f.push.setEnabled(agentId, false)).enabled, false);
});
test('push status reports a managed worker with no registration instead of throwing', async () => {
  const f = fixture();
  f.push.attachWorkers(async (id) =>
    id === 'survivor'
      ? {
          agentId: 'survivor',
          cli: 'claude',
          push: { credentialPath: join(stateDir, 'push-credentials', 'x.json'), surface: 'claude_hooks' as const },
        }
      : undefined,
  );
  const survivor = await f.push.status('survivor');
  assert.equal(survivor.registered, false, 'a worker this process never registered is reported, not an error');
  assert.equal(survivor.enabled, false);
  assert.equal(survivor.deliverable, false);
  assert.match(survivor.reason!, /registration/);
  // PUSH_UNKNOWN_WORKER is reserved for an id that is not a managed worker at all.
  await assert.rejects(f.push.status('never-existed'), /PUSH_UNKNOWN_WORKER/);
  const { agentId } = await f.agents.spawn({ name: 'w', cli: 'claude' } as any);
  f.push.attachWorkers(async (id) => (id === agentId ? { agentId, cli: 'claude' } : undefined));
  const live = await f.push.status(agentId);
  assert.equal(live.registered, true);
  assert.equal(live.hookSurface, 'claude_hooks');
  assert.equal(live.socket.listening, true);
  assert.ok(!JSON.stringify(live).includes('token'), 'no status result carries a token');
});
test('a spawn that fails after launch leaks no token and no credential file', async () => {
  const f = fixture();
  const credentials = () => readdirSync(join(stateDir, 'push-credentials')).filter((n) => n.endsWith('.json')).length;
  await f.agents.spawn({ name: 'w', cli: 'claude' } as any);
  assert.equal(f.push.list().length, 1);
  const baseline = credentials();
  // A duplicate name throws from insert, after launch has already minted a token and written a file.
  for (let i = 0; i < 5; i++)
    await assert.rejects(f.agents.spawn({ name: 'w', cli: 'claude' } as any), /already exists/);
  assert.equal(f.push.list().length, 1, 'a failed spawn releases its registration');
  assert.equal(credentials(), baseline, 'a failed spawn leaves no credential file behind');
  // The 64-registration cap must never be reachable by retrying failures. Before this was
  // released, attempt 63 failed with PUSH_REGISTRATION_LIMIT and spawning stayed broken for
  // the life of the process.
  for (let i = 0; i < 70; i++)
    await assert.rejects(f.agents.spawn({ name: 'w', cli: 'claude' } as any), /already exists/);
  assert.equal(f.push.list().length, 1, 'retried failures never accumulate registrations');
  assert.equal(credentials(), baseline);
});
test('an unwritable credential store degrades the worker to polling and still saves its mapping', async () => {
  const broken = mkdtempSync(join(tmpdir(), 'term-dad-push-broken-'));
  // A regular file where the credential directory belongs makes every credential write fail.
  writeFileSync(join(broken, 'push-credentials'), 'not a directory');
  const backend = new WezTermBackend(
    async (args) => {
      if (args[0] === 'list')
        return JSON.stringify([
          { pane_id: 7, tab_id: 1, window_id: 1, title: 't', cwd: '/', size: { rows: 24, cols: 80 } },
        ]);
      if (args[0] === 'spawn') return '7';
      return 'OpenAI Codex\n› ';
    },
    async () => null,
  );
  const push = new WorkerPushRegistry(
    new PushIngress({ sink: async () => {} }),
    '/run/term-dad/push.sock',
    ['/usr/bin/node', '/opt/notify.js'],
    broken,
  );
  push.attach({ listening: true });
  const agents = new Agents(backend, undefined, push);
  try {
    const spawned = await agents.spawn({ name: 'w', cli: 'claude' } as any);
    assert.equal(spawned.paneId, 7, 'the spawn the user asked for succeeds');
    const [saved] = await agents.list();
    assert.equal(saved.paneId, 7);
    assert.equal(saved.attachment, 'attached');
    await assert.rejects(
      push.setEnabled(spawned.agentId, true),
      /PUSH_CREDENTIAL_UNWRITABLE/,
      'push cannot be enabled for a channel nothing can reach',
    );
  } finally {
    rmSync(broken, { recursive: true, force: true });
  }
});
