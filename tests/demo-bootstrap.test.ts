import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrapWorkers } from '../demo/bootstrap.js';
import { ticketDefinitions, type DemoRun } from '../demo/runtime.js';

function fixture() {
  const run: DemoRun = {
    directory: '/tmp/demo space',
    repository: '/tmp/demo space/release',
    before: '/tmp/demo space/before',
    state: '/tmp/demo space/state',
    base: 'base',
    parentPane: 7,
    instanceKey: 'gui',
    endpoint: 'socket',
    panes: [],
    tickets: ticketDefinitions.map((ticket, index) => ({
      ...ticket,
      worktree: `/tmp/demo space/${ticket.id}`,
      taskId: `task-${index}`,
    })),
  };
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const snapshots: DemoRun[] = [];
  let key = 'gui';
  const panes = new Set([7]);
  let fail = '';
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args });
    if (name === fail) throw new Error('injected failure');
    if (name === 'terminal.list') return { selected: { key }, panes: [...panes].map((pane_id) => ({ pane_id })) };
    if (name === 'terminal.split') {
      const pane = 20 + panes.size;
      panes.add(pane);
      return pane;
    }
    if (name === 'agent.adopt') return { agentId: `worker-${args.paneId}`, paneId: args.paneId };
    if (name === 'task.get') return { revision: 9 };
    if (name === 'task.assign') return {};
    throw new Error(`Unexpected operation ${name}`);
  };
  const persist = async (value: DemoRun) => {
    snapshots.push(structuredClone(value));
  };
  return {
    run,
    calls,
    snapshots,
    call,
    persist,
    panes,
    changeIdentity: () => {
      key = 'other';
    },
    failAt: (name: string) => {
      fail = name;
    },
  };
}

test('demo bootstrap creates and records each pane, adopts and assigns without dispatch', async () => {
  const f = fixture();
  await bootstrapWorkers(f.run, f.call, f.persist);
  assert.deepEqual(
    f.calls.map((c) => c.name),
    Array.from({ length: 3 }, () => [
      'terminal.list',
      'terminal.split',
      'terminal.list',
      'agent.adopt',
      'task.get',
      'task.assign',
    ]).flat(),
  );
  const splits = f.calls.filter((c) => c.name === 'terminal.split').map((c) => c.args);
  assert.deepEqual(
    splits.map((s) => [s.paneId, s.direction, s.percent]),
    [
      [7, 'right', 50],
      [21, 'bottom', 67],
      [22, 'bottom', 50],
    ],
  );
  assert.deepEqual(f.run.panes, [21, 22, 23]);
  assert.deepEqual(
    f.snapshots.map((s) => [s.panes.length, s.tickets.filter((t) => t.agentId).length]),
    [
      [1, 0],
      [1, 1],
      [2, 1],
      [2, 2],
      [3, 2],
      [3, 3],
    ],
  );
  assert.ok(splits.every((s, index) => s.cwd === f.run.tickets[index].worktree && Array.isArray(s.command)));
  assert.ok(f.calls.filter((c) => c.name === 'task.assign').every((c) => c.args.expectedRevision === 9));
  await assert.rejects(bootstrapWorkers(f.run, f.call, f.persist), /already created/);
});

test('demo bootstrap rejects changed GUI or missing parent before creating anything', async () => {
  for (const change of ['identity', 'parent']) {
    const f = fixture();
    if (change === 'identity') f.changeIdentity();
    else f.panes.delete(7);
    await assert.rejects(bootstrapWorkers(f.run, f.call, f.persist), /changed|disappeared/);
    assert.deepEqual(
      f.calls.map((c) => c.name),
      ['terminal.list'],
    );
    assert.deepEqual(f.snapshots, []);
  }
});

test('demo bootstrap records created pane before post-split identity verification', async () => {
  const f = fixture();
  await assert.rejects(
    bootstrapWorkers(
      f.run,
      async (name, args) => {
        const result = await f.call(name, args);
        if (name === 'terminal.split') f.changeIdentity();
        return result;
      },
      f.persist,
    ),
    /identity changed/,
  );
  assert.deepEqual(f.run.panes, [21]);
  assert.equal(f.snapshots.length, 1);
  assert.ok(!f.calls.some((c) => c.name === 'agent.adopt'));
});

test('uncertain creation is never retried and partial adoption remains recorded', async () => {
  const first = fixture();
  first.failAt('terminal.split');
  await assert.rejects(bootstrapWorkers(first.run, first.call, first.persist), /injected/);
  assert.equal(first.calls.filter((c) => c.name === 'terminal.split').length, 1);
  assert.deepEqual(first.snapshots, []);
  const second = fixture();
  second.failAt('task.assign');
  await assert.rejects(bootstrapWorkers(second.run, second.call, second.persist), /injected/);
  assert.deepEqual(second.run.panes, [21]);
  assert.equal(second.run.tickets[0].agentId, 'worker-21');
  assert.equal(second.snapshots.length, 2);
});

test('persistence failure stops before another terminal mutation', async () => {
  const f = fixture();
  await assert.rejects(
    bootstrapWorkers(f.run, f.call, async () => {
      throw new Error('disk full');
    }),
    /disk full/,
  );
  assert.deepEqual(f.run.panes, [21]);
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ['terminal.list', 'terminal.split'],
  );
});
