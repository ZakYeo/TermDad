import type { UsageAccount } from './usage-model.js';
import { usageEvent } from './usage-policy.js';

/** Persist deadlines from provider observations; never infer a reset from elapsed usage. */
export function scheduleResetAlerts(a: UsageAccount) {
  const previous = a.resetAlerts;
  a.resetAlerts =
    a.config.enabled && a.watch?.notifyOnReset && !a.error
      ? (a.observation?.windows ?? [])
          .filter(
            (w) =>
              (w.kind === 'five_hour' || w.kind === 'weekly') &&
              w.resetsAt !== null &&
              w.usedPercent !== null &&
              w.usedPercent >= 100 - (w.kind === 'weekly' ? a.config.weeklyReservePercent : a.config.reservePercent),
          )
          .map((w) => ({
            bucketId: w.bucketId,
            kind: w.kind,
            resetsAt: w.resetsAt!,
            notified: previous.some(
              (p) => p.bucketId === w.bucketId && p.kind === w.kind && p.resetsAt === w.resetsAt && p.notified,
            ),
          }))
      : [];
}

/** Claim and enqueue together under the usage journal lock, including after restart. */
export function hasDueResetAlert(a: UsageAccount, now: number) {
  return (
    a.config.enabled &&
    !!a.watch?.notifyOnReset &&
    a.resetAlerts.some((alarm) => !alarm.notified && alarm.resetsAt <= now)
  );
}

export function deliverResetAlerts(a: UsageAccount, now: number) {
  if (!hasDueResetAlert(a, now)) return false;
  const due = a.resetAlerts.filter((alarm) => !alarm.notified && alarm.resetsAt <= now);
  if (!due.length) return false;
  usageEvent(
    a,
    'usage.reset_due',
    'Expected quota reset time has passed. Check fresh five-hour and weekly allowances before resuming workers; recovery is not confirmed.',
    now,
  );
  for (const alarm of due) alarm.notified = true;
  a.revision++;
  return true;
}
