import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalRead } from '../src/terminal-read.js';
import { benchmarkFixture, screen } from '../scripts/benchmark-fixture.js';
import { prepareScaling } from '../scripts/benchmark-measure.js';

test('read scopes share checks, retain failures and expire at the operation boundary', async () => {
  const f = await benchmarkFixture();
  try {
    let escaped!: TerminalRead;
    f.calls.length = 0;
    await TerminalRead.run(f.app.agents.backend, async (read) => {
      escaped = read;
      await Promise.all([read.identity(), read.identity(), read.panes(), read.panes()]);
    });
    assert.deepEqual(f.calls.sort(), ['identity', 'list']);
    assert.throws(() => escaped.panes(), /scope has ended/);
    const original = f.app.agents.backend.list;
    let failures = 0;
    f.app.agents.backend.list = async () => {
      failures++;
      throw new Error('transport');
    };
    await TerminalRead.run(f.app.agents.backend, async (read) => {
      await assert.rejects(read.panes(), /transport/);
      await assert.rejects(read.panes(), /transport/);
    });
    assert.equal(failures, 1);
    f.app.agents.backend.list = original;
    await TerminalRead.run(f.app.agents.backend, (read) => read.panes());
  } finally {
    await f.close();
  }
});

test('summary scopes preserve history, stale prompts and input precedence', async () => {
  const f = await benchmarkFixture();
  try {
    const worker = await f.call('agent.adopt', { name: 'worker', paneId: 1, cli: 'codex' });
    f.panes.set(1, '› ');
    const baseline = await f.call('agent.observe', { agentId: worker.agentId });
    await f.call('agent.send', { agentId: worker.agentId, text: 'task' });
    assert.equal((await f.call('orchestrator.status'))[0].status, 'WORKING');
    for (let i = 0; i < 20; i++) await f.call('orchestrator.status');
    assert.equal(
      (await f.call('agent.observe', { agentId: worker.agentId, since: baseline.observationId })).deltaReset,
      false,
    );
    f.panes.set(1, 'Working (esc to interrupt)\nPermission required\n› ');
    const status = (await f.call('orchestrator.status'))[0];
    assert.equal(status.permissionPrompt, true);
    assert.equal(status.inputRequired, true);
  } finally {
    await f.close();
  }
});

test('a binding changed after a sweep listing cannot be sampled or removed using old panes', async () => {
  const f = await benchmarkFixture();
  try {
    const [worker] = await prepareScaling(f, 1);
    const list = f.app.agents.backend.list.bind(f.app.agents.backend);
    f.app.agents.backend.list = async () => {
      const panes = await list();
      await f.app.agents.storage.transaction(true, (s) => {
        const w = s.workers.find((w) => w.agentId === worker.agentId)!;
        w.paneId = 999;
        w.revision = '11111111-2222-4333-8444-555555555555';
        return { state: s, result: undefined };
      });
      f.panes.set(999, screen);
      return panes;
    };
    const result = await f.call('orchestrator.status');
    assert.match(result[0].error, /reattached/);
    assert.equal((await f.app.agents.resolve(worker.agentId)).paneId, 999);
  } finally {
    await f.close();
  }
});

test('watch passes share checks only among due samples and refresh them on the next pass', async () => {
  const f = await benchmarkFixture();
  try {
    const workers = await prepareScaling(f, 5);
    f.calls.length = 0;
    await f.app.watches.poll();
    assert.deepEqual(f.calls, []);
    f.advance();
    await f.app.watches.poll();
    assert.equal(f.calls.filter((c) => c === 'identity').length, 1);
    assert.equal(f.calls.filter((c) => c === 'list').length, 1);
    assert.equal(f.calls.filter((c) => c === 'get-text').length, 5);
    f.panes.delete(workers[0].paneId);
    f.calls.length = 0;
    f.advance();
    await f.app.watches.poll();
    assert.equal(f.calls.filter((c) => c === 'identity').length, 1);
    assert.equal(f.calls.filter((c) => c === 'list').length, 1);
    assert.equal(f.calls.filter((c) => c === 'get-text').length, 4);
    assert.equal(f.app.watches.list().find((w) => w.agentId === workers[0].agentId)?.disappeared, true);
    assert.equal(await f.app.agents.resolveOptional(workers[0].agentId), undefined);
  } finally {
    await f.close();
  }
});

test('a failed watch listing is shared without removing workers or declaring disappearance', async () => {
  const f = await benchmarkFixture();
  try {
    const workers = await prepareScaling(f, 5);
    let calls = 0;
    f.app.agents.backend.list = async () => {
      calls++;
      throw new Error('unavailable');
    };
    f.advance();
    await f.app.watches.poll();
    assert.equal(calls, 1);
    assert.ok(f.app.watches.list().every((w) => w.backendError && !w.disappeared));
    for (const w of workers) assert.ok(await f.app.agents.resolveOptional(w.agentId));
  } finally {
    await f.close();
  }
});
