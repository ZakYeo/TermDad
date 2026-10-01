import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkFixture } from '../scripts/benchmark-fixture.js';

test('MCP usage configuration and account-scoped gates cover send, broadcast and spawn', async () => {
  const f = await benchmarkFixture();
  try {
    const worker = await f.call('agent.spawn', { name: 'bound', cli: 'shell' });
    const other = await f.call('agent.spawn', { name: 'other', cli: 'shell' });
    f.app.usage.providers.codex.capabilities = {
      refresh: true,
      identity: true,
      pause: true,
      wake: true,
      verified: true,
      reason: 'Injected test only',
    };
    await f.call('usage.configure', {
      accountRef: 'a',
      provider: 'codex',
      mode: 'automatic',
      workerIds: [worker.agentId],
    });
    const now = Date.now();
    await f.app.usage.ingest('a', {
      source: 'fixture',
      identity: 'fixture',
      observedAt: now,
      windows: [
        { bucketId: 'all', kind: 'five_hour', windowSeconds: 18000, usedPercent: 95, resetsAt: now + 18000_000 },
        { bucketId: 'all', kind: 'weekly', windowSeconds: 604800, usedPercent: 10, resetsAt: now + 604800_000 },
      ],
    });
    f.calls.length = 0;
    assert.equal((await f.raw('agent.send', { agentId: 'bound', text: 'must not send' })).isError, true);
    assert.ok(!f.calls.includes('send-text'));
    const count = f.panes.size;
    assert.equal((await f.raw('agent.spawn', { name: 'blocked', cli: 'shell', accountRef: 'a' })).isError, true);
    assert.equal(f.panes.size, count);
    const result = await f.call('agent.broadcast', { agentIds: [worker.agentId, other.agentId], text: 'hello' });
    assert.match(result[0].error, /USAGE_PAUSED/);
    assert.equal(result[1].sent, true);
    assert.equal(
      (await f.call('orchestrator.status')).find((w: any) => w.agentId === worker.agentId).usage.accountRef,
      'a',
    );
    assert.ok((await f.call('orchestrator.attention')).usage.accounts.length);
  } finally {
    await f.close();
  }
});

test('initial prompt is rechecked after readiness and leaves its pane intact on usage pause', async () => {
  const f = await benchmarkFixture();
  try {
    await f.call('usage.configure', { accountRef: 'a', provider: 'codex' });
    const gate = f.app.usage.assertDispatch.bind(f.app.usage);
    f.app.usage.assertDispatch = async (workerId, ref) => {
      if (workerId) throw new Error('USAGE_PAUSED: injected threshold crossed during readiness');
      return gate(workerId, ref);
    };
    f.calls.length = 0;
    const result = await f.raw('agent.spawn', {
      name: 'retained',
      cli: 'shell',
      accountRef: 'a',
      prompt: 'do not send',
    });
    assert.equal(result.isError, true);
    assert.ok(f.calls.includes('spawn'));
    assert.ok(!f.calls.includes('send-text'));
    const [worker] = await f.call('agent.list');
    assert.ok(f.panes.has(worker.paneId));
    assert.equal(worker.accountRef, 'a');
    assert.deepEqual((await f.call('usage.status')).accounts[0].workerIds, []);
  } finally {
    await f.close();
  }
});

test('spawned account ownership follows worker lifetime without growing configuration bindings', async () => {
  const f = await benchmarkFixture();
  try {
    await f.call('usage.configure', { accountRef: 'a', provider: 'codex' });
    const worker = await f.call('agent.spawn', { name: 'bound-lifetime', cli: 'shell', accountRef: 'a' });
    const listed = await f.call('agent.list');
    assert.equal(listed[0].accountRef, 'a');
    assert.equal((await f.call('orchestrator.status'))[0].usage.accountRef, 'a');
    const conflicting = await f.raw('usage.configure', {
      accountRef: 'other',
      provider: 'claude',
      workerIds: [worker.agentId],
    });
    assert.equal(conflicting.isError, true);
    await f.call('agent.stop', { agentId: worker.agentId });
    assert.deepEqual((await f.call('usage.status')).accounts[0].workerIds, []);
  } finally {
    await f.close();
  }
});
