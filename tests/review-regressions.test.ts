import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { WezTermBackend } from '../src/backend.js';
import { MemoryWorkerStorage } from '../src/worker-storage.js';
import { MemoryTaskStorage } from '../src/task-storage.js';
import { EventQueue, FileEventStorage } from '../src/events.js';
import { hashOutput } from '../src/agents.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'term-dad-review-'));
  process.env.TERM_DAD_STATE_DIR = directory;
  let text = '❯';
  const inputs: string[] = [];
  const backend = new WezTermBackend(
    async (args, input) => {
      if (args[0] === 'list')
        return JSON.stringify([
          { pane_id: 7, tab_id: 1, window_id: 1, title: 'w', cwd: '/tmp', size: { rows: 24, cols: 80 } },
        ]);
      if (args[0] === 'spawn') return '7';
      if (args[0] === 'get-text') return text;
      if (input) inputs.push(input);
      return '';
    },
    async () => ({ key: 'k', endpoint: 'e' }),
  );
  const storage = new MemoryWorkerStorage();
  const app = createServer(
    backend,
    undefined,
    { automatic: false },
    new EventQueue(new FileEventStorage(directory)),
    storage,
    new MemoryTaskStorage(),
    { telemetry: false },
  );
  await app.pushReady;
  const worker = await app.agents.spawn({ name: 'w', cli: 'claude' });
  await app.push.setEnabled(worker.agentId, true);
  const token = (app.ingress as any).byAgent.get(worker.agentId).token;
  t.after(async () => {
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    app,
    worker,
    inputs,
    storage,
    text: (value: string) => {
      text = value;
    },
    push: (kind: string) => app.ingress.handle(JSON.stringify({ token, kind })),
    age: () =>
      storage.transaction(true, (s) => {
        s.workers[0].lastInputAt = 0;
        return { state: s, result: null };
      }),
  };
}
test('a completion hook wakes a ready-baselined watch without an intermediate working poll', async (t) => {
  const f = await fixture(t);
  await f.app.watches.create({ agentId: f.worker.agentId, cooldownMs: 0 });
  await f.app.agents.send(f.worker.agentId, 'work');
  await f.age();
  f.text('⏺ Completed\n❯');
  assert.equal((await f.push('turn_ended')).delivered, true);
  await f.push('turn_ended');
  assert.equal((await f.app.events.list({ kinds: ['ready'] })).events.length, 1);
});
test('typed hook evidence enriches the same event in either order, including after acknowledgement', async (t) => {
  const f = await fixture(t);
  await f.app.watches.create({ agentId: f.worker.agentId, cooldownMs: 0 });
  f.text('Do you want to proceed?\n❯');
  await f.push('input_required');
  const first = (await f.app.events.list()).events[0];
  await f.app.events.acknowledge([first.id]);
  await f.push('plan_approval');
  let events = (await f.app.events.list({}, true)).events;
  assert.equal(events.length, 1);
  assert.equal(events[0].id, first.id);
  assert.equal(events[0].kind, 'plan_approval');
  assert.ok(events[0].acknowledgedAt);
  f.text('Different command\nDo you want to proceed?\n❯');
  await f.push('tool_permission');
  await f.push('input_required');
  events = (await f.app.events.list({}, true)).events;
  assert.equal(events.length, 2);
  assert.equal(events[1].kind, 'tool_permission');
});
test('prompt answers preserve reporting identity; external input invalidates late reports; resumed work retires parked claims', async (t) => {
  const f = await fixture(t);
  const sent = await f.app.agents.send(f.worker.agentId, 'work');
  await f.app.agents.noteInputActivity(f.worker.agentId, hashOutput(f.inputs[0]));
  assert.equal((await f.app.agents.resolve(f.worker.agentId)).turn?.id, sent.turnId);
  await f.age();
  f.text('⏺ Waiting for tests\n❯');
  const report = {
    turnId: sent.turnId,
    state: 'parked_background' as const,
    summary: 'waiting',
    references: [],
    checks: [],
  };
  await f.app.agents.recordReport(f.worker.agentId, report);
  assert.equal((await f.app.agents.observe(f.worker.agentId)).status, 'PARKED_BACKGROUND');
  f.text('Working… esc to interrupt');
  await f.app.agents.observe(f.worker.agentId);
  f.text('⏺ Completed tests\n❯');
  assert.equal((await f.app.agents.observe(f.worker.agentId)).status, 'READY_FOR_PROMPT');
  f.text('Which path?\n❯');
  const answer = await f.app.agents.send(f.worker.agentId, 'continue', undefined, false);
  assert.equal(answer.turnId, sent.turnId);
  await f.app.agents.recordReport(f.worker.agentId, { ...report, state: 'done' });
  await f.app.agents.noteInputActivity(f.worker.agentId, hashOutput('native input'));
  await assert.rejects(f.app.agents.recordReport(f.worker.agentId, report), /WORKER_REPORT_STALE/);
});
test('task.dispatch replays its receipt over MCP after the worker is forgotten', async (t) => {
  const f = await fixture(t),
    client = new Client({ name: 'review', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await f.app.server.connect(a);
  await client.connect(b);
  t.after(() => client.close());
  const args = {
    agentId: f.worker.agentId,
    idempotencyKey: 'once',
    task: { boardId: 'b', title: 'Task', goal: 'Goal' },
    text: 'work',
  };
  const first: any = await client.callTool({ name: 'task.dispatch', arguments: args });
  assert.notEqual(first.isError, true);
  await f.app.agents.forget(f.worker.agentId);
  const repeated = await client.callTool({ name: 'task.dispatch', arguments: args });
  assert.deepEqual(repeated, first);
});

test('a parked claim without observed progress eventually yields to current screen evidence', async (t) => {
  const f = await fixture(t);
  const sent = await f.app.agents.send(f.worker.agentId, 'work');
  await f.age();
  f.text('⏺ Waiting\n❯');
  await f.app.agents.recordReport(f.worker.agentId, {
    turnId: sent.turnId,
    state: 'parked_background',
    summary: 'waiting',
    references: [],
    checks: [],
  });
  await f.storage.transaction(true, (s) => {
    s.workers[0].reportContext!.expiresAt = 0;
    return { state: s, result: null };
  });
  f.text('⏺ Finished\n❯');
  assert.equal((await f.app.agents.observe(f.worker.agentId)).status, 'READY_FOR_PROMPT');
});

test('completion cannot publish readiness if the final publication sample sees background work', async (t) => {
  const f = await fixture(t);
  await f.app.watches.create({ agentId: f.worker.agentId, cooldownMs: 0 });
  await f.app.agents.send(f.worker.agentId, 'work');
  await f.age();
  f.text('⏺ Finished foreground\n❯');
  const peek = f.app.agents.peek.bind(f.app.agents);
  let calls = 0;
  f.app.agents.peek = async (id) => {
    const result = await peek(id);
    if (++calls === 1) f.text('❯\n1 shell still running');
    return result;
  };
  await f.push('turn_ended');
  assert.equal((await f.app.events.list({ kinds: ['ready'] })).events.length, 0);
});
