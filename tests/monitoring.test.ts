import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitoring, type MonitoringMetric } from '../src/monitoring.js';
import { benchmarkFixture } from '../scripts/benchmark-fixture.js';
import { prepareScaling } from '../scripts/benchmark-measure.js';

test('opt-in monitoring counts real backend checks and watch samples without terminal content', async () => {
  const metrics: MonitoringMetric[] = [];
  const monitoring = new Monitoring({ record: (m) => metrics.push(m) });
  const f = await benchmarkFixture(false, monitoring);
  try {
    await prepareScaling(f, 5);
    metrics.length = 0;
    f.advance();
    await f.app.watches.poll();
    assert.equal(metrics.filter((m) => m.kind === 'backend').length, 7);
    const samples = metrics.filter((m) => m.kind === 'sample');
    assert.equal(samples.length, 5);
    assert.ok(samples.every((m) => m.source === 'poll' && m.intervalMs === 2000 && !m.pushBacked && !m.changed));
    f.panes.set(1, 'secret terminal content');
    await f.call('terminal.read', { paneId: 1 });
    assert.ok(!JSON.stringify(metrics).includes('secret'));
    assert.ok(!JSON.stringify(metrics).includes('fixture'));
  } finally {
    await f.close();
  }
  assert.equal(metrics.filter((m) => m.kind === 'watch' && m.phase === 'end').length, 5);
  assert.equal(metrics.at(-1)?.kind, 'session');
});

test('a failing measurement sink cannot affect backend results or watch delivery', async () => {
  const monitoring = new Monitoring({
    record: () => {
      throw new Error('broken sink');
    },
    close: async () => {
      throw new Error('broken close');
    },
  });
  const f = await benchmarkFixture(false, monitoring);
  try {
    await f.call('agent.adopt', { name: 'worker', cli: 'codex', paneId: 1 });
    await f.app.watches.create({ agentId: 'worker' });
    f.panes.set(1, 'Permission required');
    f.advance();
    await f.app.watches.poll();
    assert.equal(f.app.watches.list()[0].status, 'WAITING_FOR_PERMISSION');
    assert.ok((await f.app.events.list()).events.some((e) => e.kind === 'input_required'));
  } finally {
    await f.close();
  }
});
