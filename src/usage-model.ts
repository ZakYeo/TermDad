import { z } from 'zod';

export const usageId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_.:/-]+$/);
export const providerName = z.enum(['codex', 'claude', 'copilot']);
export const usageWindowSchema = z
  .object({
    bucketId: usageId,
    kind: z.enum(['five_hour', 'weekly', 'other']),
    windowSeconds: z.number().int().positive().nullable(),
    usedPercent: z.number().finite().min(0).max(10000).nullable(),
    resetsAt: z.number().int().nonnegative().safe().nullable(),
  })
  .strict();
export type UsageWindow = z.infer<typeof usageWindowSchema>;
export const observationSchema = z
  .object({
    observedAt: z.number().int().nonnegative().safe(),
    source: usageId,
    identity: usageId.nullable(),
    windows: z.array(usageWindowSchema).max(32),
  })
  .strict()
  .refine(
    (o) => new Set(o.windows.map((w) => `${w.bucketId}:${w.kind}`)).size === o.windows.length,
    'Duplicate quota windows',
  );
export type UsageObservation = z.infer<typeof observationSchema>;

export const configureUsageSchema = z
  .object({
    accountRef: usageId,
    provider: providerName,
    mode: z.enum(['advisory', 'automatic']).default('advisory'),
    enabled: z.boolean().default(true),
    reservePercent: z.number().min(1).max(50).default(5),
    weeklyReservePercent: z.number().min(1).max(50).default(5),
    // These are selectors, never credentials. The adapter runs the installed CLI.
    codexHome: z.string().min(1).max(4096).optional(),
    profile: z.string().min(1).max(100).optional(),
    workerIds: z.array(z.uuid()).max(64).default([]),
  })
  .strict();
export type UsageConfig = z.infer<typeof configureUsageSchema>;
export const usageWatchSchema = z
  .object({
    accountRef: usageId,
    thresholdsUsedPercent: z.array(z.number().min(1).max(100)).min(1).max(10).default([80, 90, 95]),
    notifyOnReset: z.boolean().default(true),
  })
  .strict();
export type UsageWatch = z.infer<typeof usageWatchSchema>;

export const phaseSchema = z.enum(['running', 'pause_requested', 'paused', 'checking', 'resume_pending']);
export type UsagePhase = z.infer<typeof phaseSchema>;
const sessionSchema = z
  .object({
    id: usageId,
    client: providerName,
    lastSeen: z.number(),
    parked: z.boolean(),
    cancelled: z.boolean(),
    lastRevision: z.number().int().nonnegative(),
    resumeCycle: z.number().int().nonnegative(),
  })
  .strict();
const pendingSchema = z
  .object({
    kind: usageId,
    key: usageId,
    at: z.number(),
    summary: z.string().max(240),
    published: z.boolean().default(false),
  })
  .strict();
export const usageAccountSchema = z
  .object({
    config: configureUsageSchema,
    revision: z.number().int().positive(),
    sourceRevision: z.number().int().positive().default(1),
    observation: observationSchema.nullable(),
    watch: usageWatchSchema.nullable(),
    phase: phaseSchema,
    reason: z.string().max(240).nullable(),
    cycle: z.number().int().nonnegative(),
    nextCheckAt: z.number().nullable(),
    lastAttemptAt: z.number().nullable(),
    notificationDropped: z.number().int().nonnegative().safe().default(0),
    failures: z.number().int().nonnegative().max(20),
    error: z.string().max(100).nullable(),
    fired: z.array(z.string().max(200)).max(320),
    resetAlerts: z
      .array(
        z
          .object({
            bucketId: usageId,
            kind: usageWindowSchema.shape.kind,
            resetsAt: z.number().int().nonnegative().safe(),
            notified: z.boolean(),
          })
          .strict(),
      )
      .max(32)
      .default([]),
    pending: z.array(pendingSchema).max(64),
    sessions: z.array(sessionSchema).max(64),
  })
  .strict();
export type UsageAccount = z.infer<typeof usageAccountSchema>;
export const usageStateSchema = z
  .object({
    version: z.literal(1),
    accounts: z.array(usageAccountSchema).max(32),
  })
  .strict()
  .refine(
    (s) => new Set(s.accounts.map((a) => a.config.accountRef)).size === s.accounts.length,
    'Duplicate usage accounts',
  );
export type UsageState = z.infer<typeof usageStateSchema>;

export interface UsageCapabilities {
  refresh: boolean;
  identity: boolean;
  pause: boolean;
  wake: boolean;
  verified: boolean;
  reason: string;
}
export const freshForMs = 120_000;
export function freshness(o: UsageObservation | null, now: number) {
  if (!o) return 'unknown' as const;
  return now >= o.observedAt && now - o.observedAt <= freshForMs ? ('fresh' as const) : ('stale' as const);
}

/** All reported quota buckets apply. Missing required windows cannot authorize dispatch. */
export function eligibility(a: UsageAccount, now: number): string | null {
  if (a.error) return a.error;
  const o = a.observation;
  if (freshness(o, now) !== 'fresh') return 'usage_unavailable_or_stale';
  for (const kind of ['five_hour', 'weekly'] as const) {
    const windows = o!.windows.filter((w) => w.kind === kind);
    if (!windows.length) return `${kind}_unavailable`;
    for (const w of windows) {
      if (w.usedPercent === null) return `${kind}_unavailable`;
      if (w.resetsAt !== null && w.resetsAt <= now) return `${kind}_reset_unconfirmed`;
      const reserve = kind === 'weekly' ? a.config.weeklyReservePercent : a.config.reservePercent;
      if (w.usedPercent >= 100 - reserve) return `${kind}_reserve`;
    }
  }
  return null;
}
