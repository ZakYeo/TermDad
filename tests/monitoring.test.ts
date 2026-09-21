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

test('monitoring reports deduplicate worker time, distinguish push backoff, and require reference transitions for delay', async () => {
  const { summarizeMonitoring } = await import('../src/monitoring-report.js');
  const { randomUUID } = await import('node:crypto');
  const metrics: MonitoringMetric[] = [];
  let now = 0;
  const m = new Monitoring({ record: (r) => metrics.push(r) }, () => now);
  const watchId = randomUUID(),
    duplicate = randomUUID();
  m.record({ kind: 'watch', watchId, paneId: 7, phase: 'start' });
  m.record({ kind: 'watch', watchId: duplicate, paneId: 7, phase: 'start' });
  now = 1000;
  m.record({ kind: 'backend', operation: 'read', paneId: 7, durationMs: 2, success: true });
  m.record({
    kind: 'sample',
    watchId,
    paneId: 7,
    source: 'poll',
    changed: false,
    intervalMs: 30000,
    pushBacked: true,
    pushProven: false,
  });
  m.record({ kind: 'delivery', watchId, paneId: 7, eventKind: 'input_required', success: false, delayMs: 200 });
  now = 1500;
  m.record({ kind: 'delivery', watchId, paneId: 7, eventKind: 'input_required', success: true, delayMs: 700 });
  now = 60000;
  m.record({ kind: 'watch', watchId, paneId: 7, phase: 'end' });
  m.record({ kind: 'watch', watchId: duplicate, paneId: 7, phase: 'end' });
  await m.close();
  const report = summarizeMonitoring(metrics)[0];
  assert.equal(report.watchedWorkerMinutes, 1);
  assert.equal(report.callsPerWatchedWorkerMinute, 1);
  assert.equal(report.incomplete, false);
  assert.equal(report.unchangedPollSamples, 1);
  assert.equal(report.pushBackedUnprovenSamples, 1);
  assert.equal(report.deliveryFailures, 1);
  assert.equal(report.enqueueToDelivery.p95Ms, 700);
  assert.equal(report.detectionDelay, null);
  const reference = {
    session: metrics[0].session,
    paneId: 7,
    eventKind: 'input_required' as const,
    timestamp: new Date(500).toISOString(),
  };
  const measured = summarizeMonitoring(metrics, [
    reference,
    { ...reference, timestamp: new Date(2000).toISOString() },
  ])[0];
  assert.equal(measured.detectionDelay?.p95Ms, 1000);
  assert.equal(measured.detectionDelay?.unmatchedReferences, 1);
  assert.equal(summarizeMonitoring(metrics.filter((r) => r.kind !== 'session'))[0].incomplete, true);
});

test('monitoring uses bounded diagnostic storage separately from tool telemetry', async (t) => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { FileTelemetry } = await import('../src/telemetry-storage.js');
  const { readMonitoring } = await import('../src/monitoring-report.js');
  const { randomUUID } = await import('node:crypto');
  const directory = await mkdtemp('/tmp/term-dad-monitoring-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = new FileTelemetry<MonitoringMetric>(directory, { queueLimit: 2 });
  const monitoring = new Monitoring(file);
  for (let i = 0; i < 100; i++) monitoring.record({ kind: 'backend', operation: 'list', durationMs: 1, success: true });
  await monitoring.close();
  await writeFile(`${directory}/${process.pid}-${randomUUID()}.1.jsonl`, '{broken\n', { mode: 0o600 });
  const report = await readMonitoring(directory);
  assert.ok(report.droppedRecords > 0);
  assert.equal(report.invalidLines, 1);
  assert.ok(report.metrics.length <= 2);
});
