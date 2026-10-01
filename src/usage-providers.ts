import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readCodexQuota } from './usage-codex-rpc.js';
import { observationSchema, type UsageConfig, type UsageObservation, type UsageWindow } from './usage-model.js';

export interface UsageProvider {
  collection: 'active' | 'passive' | 'unavailable';
  read?(config: UsageConfig): Promise<UsageObservation>;
}
const codexWindow = z.object({
  usedPercent: z.number().finite().min(0),
  windowDurationMins: z.number().int().positive().nullish(),
  resetsAt: z.number().int().nonnegative().nullish(),
});
const bucket = z.object({
  limitId: z.string().nullish(),
  primary: codexWindow.nullish(),
  secondary: codexWindow.nullish(),
});
export function normalizeCodex(limits: unknown, now: number, identity: string | null): UsageObservation {
  const result = z
    .object({
      rateLimits: bucket.nullish(),
      rateLimitsByLimitId: z.record(z.string(), bucket).nullish(),
    })
    .parse(limits);
  const buckets = result.rateLimitsByLimitId ?? (result.rateLimits ? { codex: result.rateLimits } : {});
  const windows: UsageWindow[] = [];
  for (const [id, b] of Object.entries(buckets)) {
    for (const [slot, w] of Object.entries({ primary: b.primary, secondary: b.secondary })) {
      if (!w) continue;
      const seconds = w.windowDurationMins ? w.windowDurationMins * 60 : null;
      const kind = seconds === 18000 ? 'five_hour' : seconds === 604800 ? 'weekly' : 'other';
      windows.push({
        bucketId: `${b.limitId || id}/${slot}`,
        kind,
        windowSeconds: seconds,
        usedPercent: w.usedPercent,
        resetsAt: w.resetsAt == null ? null : w.resetsAt * 1000,
      });
    }
  }
  return observationSchema.parse({ observedAt: now, identity, source: 'codex.app-server', windows });
}

const claudeWindow = z.object({
  used_percentage: z.number().finite().min(0),
  resets_at: z.number().int().nonnegative(),
});
export function normalizeClaude(payload: unknown, now: number): UsageObservation | null {
  const data = z
    .object({
      rate_limits: z
        .object({
          five_hour: claudeWindow.optional(),
          seven_day: claudeWindow.optional(),
        })
        .optional(),
    })
    .parse(payload);
  if (!data.rate_limits) return null;
  const windows: UsageWindow[] = [];
  for (const [key, kind, seconds] of [
    ['five_hour', 'five_hour', 18000],
    ['seven_day', 'weekly', 604800],
  ] as const) {
    const w = data.rate_limits[key];
    if (w)
      windows.push({
        bucketId: 'claude',
        kind,
        windowSeconds: seconds,
        usedPercent: w.used_percentage,
        resetsAt: w.resets_at * 1000,
      });
  }
  return observationSchema.parse({ observedAt: now, identity: null, source: 'claude.statusline', windows });
}

export function defaultUsageProviders(now: () => number = Date.now): Record<UsageConfig['provider'], UsageProvider> {
  return {
    codex: {
      collection: 'active',
      async read(config) {
        const { account, limits } = await readCodexQuota(config);
        const auth = z
          .object({ account: z.object({ type: z.literal('chatgpt'), email: z.string().nullable() }) })
          .parse(account);
        // An email fingerprint detects login changes, but does not prove workspace identity.
        const identity = auth.account.email ? createHash('sha256').update(auth.account.email).digest('hex') : null;
        return normalizeCodex(limits, now(), identity);
      },
    },
    claude: {
      collection: 'passive',
    },
    copilot: {
      collection: 'unavailable',
    },
  };
}
