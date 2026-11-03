import assert from 'node:assert/strict';
import test from 'node:test';
import { Agents } from '../src/agents.js';
import { WezTermBackend } from '../src/backend.js';

async function fixture(t: { after: (fn: () => unknown) => void }, initial = '› Ready') {
  let text = initial;
  let alive = true;
  const input: string[] = [];
  const backend = new WezTermBackend(
    async (args, value) => {
      if (args[0] === 'list')
        return JSON.stringify(
          alive
            ? [
                {
                  pane_id: 7,
                  tab_id: 1,
                  window_id: 1,
                  title: 'worker',
                  cwd: 'file:///tmp',
                  size: { rows: 24, cols: 80 },
                },
              ]
            : [],
        );
      if (args[0] === 'spawn') return '7';
      if (args[0] === 'get-text') return text;
      if (args[0] === 'send-text') input.push(value ?? '');
      return '';
    },
    async () => ({ key: 'test', endpoint: 'test' }),
  );
  const agents = new Agents(backend);
  t.after(() => agents.close());
  await agents.spawn({ name: 'worker', cli: 'codex' });
  return { agents, input, setText: (value: string) => (text = value), remove: () => (alive = false) };
}

test('guarded send rejects startup permissions before any input, turn or worker initialization', async (t) => {
  const f = await fixture(t, 'Folder access\nTrust this folder?\n› 1. Trust and continue');
  await assert.rejects(f.agents.send('worker', 'Implement task'), /WORKER_INPUT_REQUIRED/);
  assert.deepEqual(f.input, []);
  assert.equal(f.agents.get('worker').workerSkillSent, false);
  assert.equal(f.agents.get('worker').turn, undefined);
  assert.equal(f.agents.get('worker').deliveryPending, false);
  f.setText('› Ready');
  await f.agents.send('worker', 'Implement task');
  assert.equal(f.input.length, 2);
  assert.match(f.input[0], /Implement task/);
});

test('guarded send rechecks after prior readiness and does not deliver into work or an unknown screen', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.agents.waitUntilReady('worker', 100)).reason, 'ready');
  for (const text of ['Working (1s • esc to interrupt)', 'Starting up…']) {
    f.setText(text);
    await assert.rejects(f.agents.send('worker', 'new task'), /WORKER_NOT_READY/);
    assert.deepEqual(f.input, []);
  }
  f.setText('Trust this folder?\n› Yes');
  await assert.rejects(f.agents.send('worker', 'new task'), /WORKER_INPUT_REQUIRED/);
  assert.deepEqual(f.input, []);
});

test('explicit requireReady false permits an intentional inspected reply', async (t) => {
  const f = await fixture(t, 'Choose an option\nEnter to select');
  await f.agents.send('worker', '1', undefined, false);
  assert.deepEqual(f.input, ['1', '\r']);
  assert.equal(f.agents.get('worker').workerSkillSent, false);
  f.setText('› Ready for the first task');
  await f.agents.storage.transaction(true, (state) => {
    state.workers[0].lastInputAt = Date.now() - 1000;
    return { state, result: undefined };
  });
  await f.agents.send('worker', 'Implement the first task');
  assert.match(f.input[2], /^\$term-dad-worker\n/);
  assert.ok(f.input[2].endsWith('Assignment:\nImplement the first task'));
  assert.equal(f.agents.get('worker').workerSkillSent, true);
});

test('readiness waits return early for permission, authentication, question and error without input', async (t) => {
  for (const [screen, reason] of [
    ['Trust this folder?\n› 1. Trust and continue', 'input_required'],
    ['Sign in to continue', 'input_required'],
    ['Choose an option\nEnter to select', 'input_required'],
    ['API Error: unavailable', 'error'],
  ]) {
    const f = await fixture(t, screen);
    const result = await f.agents.waitUntilReady('worker', 30000);
    assert.equal(result.reason, reason);
    assert.ok(result.lastObservation);
    assert.deepEqual(f.input, []);
  }
});

test('readiness timeout and cancellation never treat silence as readiness', async (t) => {
  const f = await fixture(t, 'Starting up…');
  assert.equal((await f.agents.waitUntilReady('worker', 10)).reason, 'timeout');
  const controller = new AbortController();
  const waiting = f.agents.waitUntilReady('worker', 30000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, /WORKER_WAIT_CANCELLED/);
  assert.deepEqual(f.input, []);
});

test('readiness reports a verified vanished worker pane', async (t) => {
  const f = await fixture(t, 'Starting up…');
  f.remove();
  assert.equal((await f.agents.waitUntilReady('worker', 100)).reason, 'worker_disappeared');
});

test('MCP readiness and send defaults block permission input and broadcast without side effects', async () => {
  const { benchmarkFixture } = await import('../scripts/benchmark-fixture.js');
  const f = await benchmarkFixture();
  try {
    f.panes.set(1, 'Trust this folder?\n› Trust and continue');
    const worker = await f.call('agent.adopt', { name: 'permission', paneId: 1, cli: 'codex' });
    f.calls.length = 0;
    const waiting = await f.call('agent.wait_until_ready', { agentId: worker.agentId, timeoutMs: 30000 });
    assert.equal(waiting.reason, 'input_required');
    assert.equal(waiting.lastObservation.inputRequest.kind, 'permission');
    const rejected = await f.raw('agent.send', { agentId: worker.agentId, text: 'task' });
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected), /WORKER_INPUT_REQUIRED/);
    const broadcast = await f.call('agent.broadcast', { agentIds: [worker.agentId], text: 'task' });
    assert.match(broadcast[0].error, /WORKER_INPUT_REQUIRED/);
    assert.ok(!f.calls.includes('send-text'));
  } finally {
    await f.close();
  }
});
