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

test('snapshots read every pane once and preserve the separate text projections', async () => {
  const f = await benchmarkFixture();
  try {
    const workers = await prepareScaling(f, 10);
    const special =
      Array.from({ length: 175 }, (_, i) => `line ${i}\t  `).join('\r\n') +
      '\r\n\u001b[32m' +
      'x'.repeat(25000) +
      '\r\n\r\n\r\nfinished   \r\n$   \r\n';
    f.panes.set(workers[0].paneId, special);
    const expectedPane = await f.app.agents.backend.read(workers[0].paneId, 30);
    const expectedWorker = await f.call('agent.observe', { agentId: workers[0].agentId });
    f.calls.length = 0;
    const snapshot = await f.call('terminal.snapshot');
    assert.equal(f.calls.filter((c) => c === 'get-text').length, 11);
    assert.equal(f.calls.filter((c) => c === 'list').length, 1);
    assert.equal(f.calls.filter((c) => c === 'identity').length, 1);
    assert.equal(snapshot.panes.find((p: any) => p.pane_id === workers[0].paneId).recentText, expectedPane);
    const observed = snapshot.agents.find((w: any) => w.agentId === workers[0].agentId);
    for (const key of ['recentText', 'outputHash', 'status', 'linesOmitted', 'inputRequired'])
      assert.equal(observed[key], expectedWorker[key], key);
    const next = await f.call('agent.observe', { agentId: workers[0].agentId, since: observed.observationId });
    assert.equal(next.outputMode, 'unchanged');
    assert.equal(next.deltaReset, false);
  } finally {
    await f.close();
  }
});

test('snapshot classification retains cues outside its default worker text tail', async () => {
  const f = await benchmarkFixture();
  try {
    const worker = await f.call('agent.adopt', { name: 'permission', paneId: 1, cli: 'codex' });
    f.panes.set(1, ['Permission required', ...Array.from({ length: 22 }, () => 'context'), '› '].join('\n'));
    const snapshot = await f.call('terminal.snapshot');
    assert.equal(snapshot.agents[0].permissionPrompt, true);
    assert.equal(snapshot.agents[0].inputRequired, true);
    assert.ok(!snapshot.agents[0].recentText.includes('Permission required'));
    assert.ok(snapshot.panes[0].recentText.includes('Permission required'));
    const original = f.app.agents.backend.read;
    let calls = 0;
    f.app.agents.backend.read = async () => {
      calls++;
      throw new Error('transport read failed');
    };
    await assert.rejects(f.app.agents.workspaceSnapshot(), /transport read failed/);
    assert.equal(calls, 1);
    assert.ok(await f.app.agents.resolveOptional(worker.agentId));
    f.app.agents.backend.read = original;
  } finally {
    await f.close();
  }
});
