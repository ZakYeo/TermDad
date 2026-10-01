import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkFixture } from '../scripts/benchmark-fixture.js';

test('usage monitoring preserves account context without gating send, broadcast or spawn', async () => {
  const f = await benchmarkFixture();
  try {
    const worker = await f.call('agent.spawn', { name: 'bound', cli: 'shell' });
    const other = await f.call('agent.spawn', { name: 'other', cli: 'shell' });
    await f.call('usage.configure', {
      accountRef: 'a',
      provider: 'codex',
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
    await f.call('agent.send', { agentId: 'bound', text: 'supervisor controlled' });
    assert.ok(f.calls.includes('send-text'));
    const count = f.panes.size;
    await f.call('agent.spawn', { name: 'allowed', cli: 'shell', accountRef: 'a' });
    assert.equal(f.panes.size, count + 1);
    const result = await f.call('agent.broadcast', { agentIds: [worker.agentId, other.agentId], text: 'hello' });
    assert.equal(result[0].sent, true);
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

test('unknown spawn account is rejected before opening a pane', async () => {
  const f = await benchmarkFixture();
  try {
    const count = f.panes.size;
    const result = await f.raw('agent.spawn', { name: 'unknown', cli: 'shell', accountRef: 'missing' });
    assert.equal(result.isError, true);
    assert.equal(f.panes.size, count);
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

test('optional usage journal failure preserves worker status and attention results', async () => {
  const f = await benchmarkFixture();
  try {
    const worker = await f.call('agent.spawn', { name: 'visible', cli: 'shell' });
    f.app.usage.status = async () => {
      throw new Error('USAGE_STATE_CORRUPT');
    };
    const status = await f.call('orchestrator.status');
    assert.equal(status[0].agentId, worker.agentId);
    assert.equal(status[0].usage.available, false);
    const attention = await f.call('orchestrator.attention');
    assert.equal(attention.usage.available, false);
    assert.equal(attention.usage.error, 'usage_status_unavailable');
  } finally {
    await f.close();
  }
});
