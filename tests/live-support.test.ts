import test from 'node:test';
import assert from 'node:assert/strict';
import { access, rm } from 'node:fs/promises';
import { LiveSession } from '../scripts/live-support.js';

test('live sessions isolate durable state and preserve it only across their own restart', async () => {
  const first = await LiveSession.create(),
    second = await LiveSession.create();
  try {
    assert.notEqual(first.directory, second.directory);
    const task = await first.call('task.create', { boardId: 'test', title: 'Private', goal: 'Isolated state' });
    assert.equal((await second.call('task.list')).total, 0);
    await first.restart();
    assert.equal((await first.call('task.get', { taskId: task.id })).id, task.id);
  } finally {
    await first.dispose();
    await second.dispose();
  }
  await assert.rejects(access(first.directory));
  await assert.rejects(access(second.directory));
});

test('live cleanup closes only explicitly created panes even after readiness failure', async () => {
  const session = await LiveSession.create(),
    calls: { name: string; args: Record<string, unknown> }[] = [];
  session.call = async (name, args = {}) => {
    calls.push({ name, args });
    if (name === 'agent.spawn') return { agentId: 'test-worker', paneId: 42 };
    if (name === 'agent.wait_until_idle') throw new Error('readiness timeout');
    if (name === 'terminal.spawn') return 43;
    if (name === 'terminal.close') return { closed: [args.id] };
    throw new Error(`Unexpected call: ${name}`);
  };
  try {
    await assert.rejects(session.spawnAgent({ prompt: 'unsafe untracked wait' }), /recording pane ownership/);
    const worker = await session.spawnAgent({ name: 'test', cli: 'shell' });
    await assert.rejects(session.call('agent.wait_until_idle', { agentId: worker.agentId }), /readiness timeout/);
    await session.spawnPane({});
    await assert.rejects(session.closePane(99), /unowned pane/);
  } finally {
    await session.dispose();
  }
  assert.deepEqual(
    calls.filter((c) => c.name === 'terminal.close').map((c) => c.args),
    [
      { target: 'pane', id: 42 },
      { target: 'pane', id: 43 },
    ],
  );
  assert.equal(
    calls.some((c) => c.name === 'agent.list' || c.name === 'orchestrator.status'),
    false,
  );
});

test('live cleanup preserves recovery metadata when an owned pane cannot be closed', async () => {
  const session = await LiveSession.create();
  session.owned.add(42);
  session.call = async () => {
    throw new Error('transport unavailable');
  };
  try {
    await session.dispose();
    await access(session.directory);
    assert.ok(session.owned.has(42));
  } finally {
    await rm(session.directory, { recursive: true, force: true });
  }
});

test('live cleanup accepts a disappeared owned pane only after a successful listing', async () => {
  const session = await LiveSession.create();
  session.owned.add(42);
  const calls: string[] = [];
  session.call = async (name) => {
    calls.push(name);
    if (name === 'terminal.close') throw new Error('Target not found');
    if (name === 'terminal.list') return [{ pane_id: 99 }];
    throw new Error(`Unexpected call: ${name}`);
  };
  await session.dispose();
  assert.deepEqual(calls, ['terminal.close', 'terminal.list']);
  assert.equal(session.owned.size, 0);
  await assert.rejects(access(session.directory));
});

test('live agent shutdown tolerates interrupt exit and stop races but preserves real failures', async () => {
  const session = await LiveSession.create();
  try {
    session.owned.add(42);
    session.call = async (name) => {
      assert.equal(name, 'terminal.list');
      return [{ pane_id: 99 }];
    };
    await session.stopAgent('exited-worker', 42);
    assert.equal(session.owned.size, 0);
    session.owned.add(43);
    let listings = 0;
    session.call = async (name) => {
      if (name === 'terminal.list') return ++listings === 1 ? [{ pane_id: 43 }, { pane_id: 99 }] : [{ pane_id: 99 }];
      assert.equal(name, 'agent.stop');
      throw new Error('Worker pane exited');
    };
    await session.stopAgent('racing-worker', 43);
    assert.equal(listings, 2);
    assert.equal(session.owned.size, 0);
    session.owned.add(44);
    session.call = async (name) => {
      if (name === 'terminal.list') return [{ pane_id: 44 }];
      throw new Error('Permission denied');
    };
    await assert.rejects(session.stopAgent('live-worker', 44), /Permission denied/);
    assert.ok(session.owned.has(44));
    session.call = async () => {
      throw new Error('Listing unavailable');
    };
    await assert.rejects(session.closePane(44), /Listing unavailable/);
    assert.ok(session.owned.has(44));
  } finally {
    // All panes in this test are fake; avoid an intentionally failing disposal warning.
    session.owned.clear();
    await session.dispose();
  }
});

test('failed spawn responses preserve recovery state without guessing pane ownership', async () => {
  for (const kind of ['agent', 'pane', 'split']) {
    const session = await LiveSession.create(),
      calls: string[] = [];
    session.call = async (name) => {
      calls.push(name);
      throw new Error('Spawn response lost');
    };
    try {
      await assert.rejects(
        kind === 'agent' ? session.spawnAgent({ cli: 'shell' }) : session.spawnPane({}, kind === 'split'),
        /Spawn response lost/,
      );
      await session.dispose();
      await access(session.directory);
      assert.equal(session.owned.size, 0);
      assert.deepEqual(calls, [
        kind === 'agent' ? 'agent.spawn' : kind === 'split' ? 'terminal.split' : 'terminal.spawn',
      ]);
    } finally {
      await rm(session.directory, { recursive: true, force: true });
    }
  }
});

test('local spawn prompt rejection does not retain unused recovery state', async () => {
  const session = await LiveSession.create();
  session.call = async () => {
    throw new Error('Preflight must not dispatch');
  };
  await assert.rejects(session.spawnAgent({ prompt: 'Rejected before dispatch' }), /recording pane ownership/);
  await session.dispose();
  await assert.rejects(access(session.directory));
});
