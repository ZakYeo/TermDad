import { z } from 'zod';
import { percentile, readTelemetryRecords } from './telemetry-report.js';
import type { MonitoringMetric } from './monitoring.js';
const nonnegative = z.number().finite().nonnegative();
const pane = z.number().int().nonnegative();
const base = z.object({ version: z.literal(1), session: z.uuid(), timestamp: z.iso.datetime() });
const watch = base.extend({ watchId: z.uuid(), paneId: pane });
const phase = z.enum(['start', 'end']);
const eventKind = z.enum([
  'ready',
  'input_required',
  'session_ended',
  'attention_required',
  'pane_disappeared',
  'inactive',
]);
const metricSchema = z.discriminatedUnion('kind', [
  base.extend({ kind: z.literal('session'), phase }).strict(),
  base
    .extend({
      kind: z.literal('backend'),
      operation: z.enum(['instance', 'list', 'read']),
      paneId: pane.optional(),
      durationMs: nonnegative,
      success: z.boolean(),
    })
    .strict(),
  watch.extend({ kind: z.literal('watch'), phase }).strict(),
  watch
    .extend({
      kind: z.literal('sample'),
      source: z.enum(['baseline', 'poll', 'push']),
      changed: z.boolean(),
      intervalMs: nonnegative,
      pushBacked: z.boolean(),
      pushProven: z.boolean(),
    })
    .strict(),
  watch.extend({ kind: z.literal('sample_error') }).strict(),
  watch.extend({ kind: z.literal('delivery'), eventKind, success: z.boolean(), delayMs: nonnegative }).strict(),
  base
    .extend({ kind: z.literal('push'), paneId: pane, eventKind, success: z.boolean(), durationMs: nonnegative })
    .strict(),
]);
export const referenceSchema = z
  .array(
    z
      .object({
        session: z.uuid(),
        paneId: pane,
        eventKind,
        timestamp: z.iso.datetime(),
      })
      .strict(),
  )
  .max(10000);
export type Reference = z.infer<typeof referenceSchema>[number];
export const readMonitoring = (directory: string) =>
  readTelemetryRecords(directory, (value) => metricSchema.parse(value));
const distribution = (values: number[]) => {
  values.sort((a, b) => a - b);
  return {
    count: values.length,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.at(-1) ?? 0,
  };
};
/** Merge overlapping watch lifetimes so duplicate watches never inflate worker minutes. */
function workerMinutes(rows: MonitoringMetric[]) {
  const open = new Map<string, { paneId: number; start: number }>();
  const ranges = new Map<number, [number, number][]>();
  const end = Date.parse(rows.at(-1)!.timestamp);
  let incomplete =
    !rows.some((r) => r.kind === 'session' && r.phase === 'start') ||
    !rows.some((r) => r.kind === 'session' && r.phase === 'end');
  const add = (paneId: number, start: number, finish: number) => {
    const spans = ranges.get(paneId) ?? [];
    spans.push([start, Math.max(start, finish)]);
    ranges.set(paneId, spans);
  };
  for (const row of rows) {
    if (row.kind !== 'watch') continue;
    if (row.phase === 'start') open.set(row.watchId, { paneId: row.paneId, start: Date.parse(row.timestamp) });
    else {
      const first = open.get(row.watchId);
      if (first) {
        add(first.paneId, first.start, Date.parse(row.timestamp));
        open.delete(row.watchId);
      } else incomplete = true;
    }
  }
  for (const first of open.values()) {
    add(first.paneId, first.start, end);
    incomplete = true;
  }
  let total = 0;
  for (const spans of ranges.values()) {
    spans.sort((a, b) => a[0] - b[0]);
    let start = spans[0][0],
      finish = spans[0][1];
    for (const [a, b] of spans.slice(1)) {
      if (a <= finish) finish = Math.max(finish, b);
      else {
        total += finish - start;
        start = a;
        finish = b;
      }
    }
    total += finish - start;
  }
  return { watchedWorkerMinutes: total / 60000, distinctWatchedPanes: ranges.size, incomplete };
}
function detection(rows: MonitoringMetric[], references: Reference[]) {
  const deliveries = rows.filter((r) => r.kind === 'delivery' && r.success);
  const ordered = [...references].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const used = new Set<MonitoringMetric>();
  const delays: number[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const ref = ordered[i];
    const next = ordered.slice(i + 1).find((r) => r.paneId === ref.paneId && r.eventKind === ref.eventKind);
    const found = deliveries.find(
      (r) =>
        r.kind === 'delivery' &&
        !used.has(r) &&
        r.paneId === ref.paneId &&
        r.eventKind === ref.eventKind &&
        r.timestamp >= ref.timestamp &&
        (!next || r.timestamp < next.timestamp),
    );
    if (found) {
      used.add(found);
      delays.push(Date.parse(found.timestamp) - Date.parse(ref.timestamp));
    }
  }
  return {
    ...distribution(delays),
    referenceCount: references.length,
    unmatchedReferences: references.length - delays.length,
  };
}
export function summarizeMonitoring(metrics: MonitoringMetric[], references: Reference[] = []) {
  const sessions = [...new Set([...metrics.map((m) => m.session), ...references.map((r) => r.session)])];
  return sessions.map((session) => {
    const rows = metrics.filter((m) => m.session === session).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const refs = references.filter((r) => r.session === session);
    const coverage = rows.length
      ? workerMinutes(rows)
      : { watchedWorkerMinutes: 0, distinctWatchedPanes: 0, incomplete: true };
    const backend = rows.filter((r) => r.kind === 'backend');
    const samples = rows.filter((r) => r.kind === 'sample');
    const deliveries = rows.filter((r) => r.kind === 'delivery');
    const pushes = rows.filter((r) => r.kind === 'push');
    const previousSamples = new Map<string, number>();
    const spacing: number[] = [];
    for (const sample of samples) {
      const at = Date.parse(sample.timestamp),
        previous = previousSamples.get(sample.watchId);
      if (sample.source === 'poll' && previous !== undefined) spacing.push(at - previous);
      previousSamples.set(sample.watchId, at);
    }
    return {
      session,
      ...coverage,
      readBackendCalls: backend.length,
      callsPerWatchedWorkerMinute: coverage.watchedWorkerMinutes
        ? backend.length / coverage.watchedWorkerMinutes
        : null,
      operations: Object.fromEntries(
        ['instance', 'list', 'read'].map((op) => [op, backend.filter((r) => r.operation === op).length]),
      ),
      backendErrors: backend.filter((r) => !r.success).length,
      pollSamples: samples.filter((r) => r.source === 'poll').length,
      unchangedPollSamples: samples.filter((r) => r.source === 'poll' && !r.changed).length,
      pushConfirmations: samples.filter((r) => r.source === 'push').length,
      pushBackedSamples: samples.filter((r) => r.pushBacked).length,
      pushBackedUnprovenSamples: samples.filter((r) => r.pushBacked && !r.pushProven).length,
      observedPollSpacing: distribution(spacing),
      effectiveIntervalsMs: [...new Set(samples.map((r) => r.intervalMs))].sort((a, b) => a - b),
      sampleErrors: rows.filter((r) => r.kind === 'sample_error').length,
      successfulPushes: pushes.filter((r) => r.success).length,
      failedPushes: pushes.filter((r) => !r.success).length,
      deliveryFailures: deliveries.filter((r) => !r.success).length,
      enqueueToDelivery: distribution(deliveries.filter((r) => r.success).map((r) => r.delayMs)),
      detectionDelay: refs.length ? detection(rows, refs) : null,
    };
  });
}
