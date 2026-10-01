import { randomUUID } from 'node:crypto';
import { eligibility, type UsageAccount } from './usage-model.js';

export function usageEvent(a: UsageAccount, kind: string, summary: string, now: number) {
  if (a.pending.length >= 64) throw new Error('USAGE_EVENT_BACKLOG_FULL');
  a.pending.push({ kind, summary, at: now, key: randomUUID(), published: false });
}

export function evaluateUsage(a: UsageAccount, now: number) {
  const reason = eligibility(a, now);
  const previous = a.phase;
  const previousReason = a.reason;
  if (!a.config.enabled || a.config.mode === 'advisory') {
    a.phase = 'running';
    a.reason = a.config.enabled ? reason : 'disabled';
  } else if (reason) {
    if (previous === 'running' || previous === 'resume_pending') {
      a.cycle++;
      for (const s of a.sessions) s.parked = false;
      usageEvent(a, 'usage.pause_requested', 'Account usage policy requests a safe-boundary pause', now);
    }
    a.phase = a.sessions.some((s) => !s.cancelled && !s.parked) ? 'pause_requested' : 'paused';
    a.reason = reason;
  } else if (previous !== 'running') {
    a.phase = a.sessions.some((s) => !s.cancelled && s.parked) ? 'resume_pending' : 'running';
    a.reason = null;
    if (a.phase === 'resume_pending' && previous !== 'resume_pending')
      usageEvent(a, 'usage.resume_pending', 'Fresh short-window and weekly allowances permit continuation', now);
  } else a.reason = null;
  if (a.phase !== previous || a.reason !== previousReason) a.revision++;

  const relevant =
    a.observation?.windows.filter(
      (w) =>
        w.resetsAt !== null &&
        w.resetsAt > now &&
        (w.usedPercent === null ||
          w.usedPercent >= 100 - (w.kind === 'weekly' ? a.config.weeklyReservePercent : a.config.reservePercent)),
    ) ?? [];
  // If weekly quota blocks work, a five-hour reset cannot make the account eligible.
  const weekly = relevant.filter((w) => w.kind === 'weekly');
  const resets = (weekly.length ? weekly : relevant).map((w) => w.resetsAt!);
  a.nextCheckAt = resets.length ? Math.min(...resets) : now + 60_000;
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
