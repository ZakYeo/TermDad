import test from 'node:test';
import assert from 'node:assert/strict';
import { Agents } from '../src/agents.js';
import { WezTermBackend } from '../src/backend.js';
import { WatchManager } from '../src/watches.js';
import { MemoryWorkerStorage } from '../src/worker-storage.js';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
async function fixture(sink?: () => Promise<void>) {
  let screen = 'test@host:~$ ';
  let now = 0,
    hold: ReturnType<typeof deferred> | undefined,
    entered = deferred();
  const reads: number[] = [],
    inputs: string[] = [];
  const backend = new WezTermBackend(
    async (args, input) => {
      if (args[0] === 'spawn') return '7';
      if (args[0] === 'list')
        return JSON.stringify(
          [7, 8].map((pane_id) => ({
            pane_id,
            tab_id: pane_id,
            window_id: 1,
            title: 'test',
            cwd: '/',
            size: { rows: 24, cols: 80 },
          })),
        );
      if (args[0] === 'get-text') {
        const pane = Number(args[args.indexOf('--pane-id') + 1]);
        reads.push(pane);
        if (pane === 7 && hold) {
          const gate = hold;
          hold = undefined;
          entered.resolve();
          await gate.promise;
        }
        return screen;
      }
      if (args[0] === 'send-text' && input) inputs.push(input);
      return '';
    },
    async () => null,
  );
  const agents = new Agents(backend, new MemoryWorkerStorage());
  const worker = await agents.spawn({ name: 'priority', cli: 'shell' });
  const watches = new WatchManager(backend, agents, { automatic: false, now: () => now, sink });
  agents.setInputCoordinator(async (id, operation) =>
    watches.withInputPriority((await agents.resolve(id)).agentId, operation),
  );
  await watches.create({ agentId: worker.agentId, pollMs: 500 });
  await watches.create({ paneId: 8, adapter: 'shell', pollMs: 500 });
  return {
    agents,
    watches,
    worker,
    reads,
    inputs,
    setText: (value: string) => {
      screen = value;
    },
    hold: () => {
      hold = deferred();
      entered = deferred();
      return { gate: hold, entered };
    },
    poll: () => {
      now += 500;
      return watches.poll();
    },
  };
}
test('managed dispatch drains a slow local watch before guarded input without replay', async () => {
  const f = await fixture();
  try {
    const { gate, entered } = f.hold();
    const poll = f.poll();
    await entered.promise;
    const sent = f.agents.send(f.worker.agentId, 'echo harmless');
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(f.inputs.length, 0);
    gate.resolve();
    await poll;
    assert.equal((await sent).sent, true);
    assert.equal(f.inputs.filter((s) => s === 'echo harmless').length, 1);
  } finally {
    await f.watches.dispose();
    await f.agents.close();
  }
});
test('input priority pauses only the selected worker and restores watches on failure', async () => {
  const f = await fixture();
  try {
    const entered = deferred(),
      release = deferred();
    const priority = f.watches.withInputPriority(f.worker.agentId, async () => {
      entered.resolve();
      await release.promise;
      throw new Error('input failed');
    });
    void priority.catch(() => {});
    await entered.promise;
    const before = f.reads.length;
    await f.watches.confirm(7);
    assert.equal(f.reads.length, before);
    await f.watches.confirm(8);
    assert.equal(f.reads.length, before + 1);
    release.resolve();
    await assert.rejects(priority, /input failed/);
    await f.watches.confirm(7);
    assert.equal(f.reads.length, before + 2);
  } finally {
    await f.watches.dispose();
    await f.agents.close();
  }
});
test('a bounded watch drain timeout sends nothing and releases input priority', async () => {
  const f = await fixture();
  try {
    const { gate, entered } = f.hold();
    const poll = f.poll();
    await entered.promise;
    let invoked = false;
    await assert.rejects(
      f.watches.withInputPriority(
        f.worker.agentId,
        async () => {
          invoked = true;
        },
        1,
      ),
      /WORKER_BUSY/,
    );
    assert.equal(invoked, false);
    gate.resolve();
    await poll;
    const before = f.reads.length;
    await f.watches.confirm(7);
    assert.equal(f.reads.length, before + 1);
  } finally {
    await f.watches.dispose();
    await f.agents.close();
  }
});

test('dispatch pins worker metadata before draining watch delivery and rejects a concurrent reattach', async () => {
  const entered = deferred(),
    gate = deferred();
  const f = await fixture(async () => {
    entered.resolve();
    await gate.promise;
  });
  try {
    f.setText('foreground work');
    await f.poll();
    f.setText('test@host:~$ ');
    const poll = f.poll();
    await entered.promise;
    const sent = f.agents.send(f.worker.agentId, 'must not reach another pane');
    void sent.catch(() => {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    await f.agents.reattach({ agentId: f.worker.agentId, paneId: 8, workerSkillInitialized: true });
    gate.resolve();
    await poll;
    await assert.rejects(sent, /WORKER_CHANGED/);
    assert.equal(f.inputs.length, 0);
  } finally {
    gate.resolve();
    await f.watches.dispose();
    await f.agents.close();
  }
});
