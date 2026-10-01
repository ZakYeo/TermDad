import { randomUUID } from 'node:crypto';
import { usageConcern, type UsageAccount } from './usage-model.js';

export function usageEvent(a: UsageAccount, kind: string, summary: string, now: number) {
  if (a.pending.length >= 64) {
    const delivered = a.pending.findIndex((p) => p.published);
    if (delivered < 0) throw new Error('USAGE_EVENT_BACKLOG_FULL');
    // Desktop is best-effort: retain event-journal guarantees without letting an
    // unavailable optional destination prevent observation commits indefinitely.
    a.pending.splice(delivered, 1);
    a.notificationDropped = Math.min(Number.MAX_SAFE_INTEGER, a.notificationDropped + 1);
  }
  a.pending.push({ kind, summary, at: now, key: randomUUID(), published: false });
}

export function evaluateUsage(a: UsageAccount, now: number) {
  const reason = a.config.enabled ? usageConcern(a, now) : 'disabled';
  if (a.reason !== reason) a.revision++;
  a.reason = reason;

  a.nextCheckAt = now + 60_000;
}

export function evaluateWarnings(a: UsageAccount, now: number) {
  if (!a.watch || !a.observation) return;
  const retained: string[] = [];
  for (const w of a.observation.windows) {
    if (w.usedPercent === null) continue;
    const crossed: number[] = [];
    for (const threshold of a.watch.thresholdsUsedPercent) {
      const key = `${w.bucketId}:${w.kind}:${w.resetsAt}:${threshold}`;
      const fired = a.fired.includes(key);
      if (w.usedPercent >= threshold || (fired && w.usedPercent > threshold - 2)) retained.push(key);
      if (w.usedPercent >= threshold && !fired) {
        crossed.push(threshold);
      }
    }
    // One bounded event per window, even when the first sample crosses all ten thresholds.
    if (crossed.length) {
      usageEvent(
        a,
        'usage.threshold',
        `${w.bucketId} ${w.kind}: ${w.usedPercent}% used; crossed ${Math.max(...crossed)}% (${crossed.length} thresholds)`,
        now,
      );
      a.revision++;
    }
  }
  a.fired = retained;
}
