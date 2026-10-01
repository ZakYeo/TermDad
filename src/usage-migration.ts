import { z } from 'zod';
import { configureUsageSchema, usageAccountSchema, usageStateSchema } from './usage-model.js';

// Accept only the old, validated shape. Removed control state never survives migration.
const legacyAccount = usageAccountSchema.extend({
  config: configureUsageSchema.extend({ mode: z.enum(['advisory', 'automatic']).default('advisory') }),
  phase: z.enum(['running', 'pause_requested', 'paused', 'checking', 'resume_pending']),
  cycle: z.number().int().nonnegative(),
  sessions: z
    .array(
      usageAccountSchema.shape.sessions.element.extend({
        parked: z.boolean(),
        resumeCycle: z.number().int().nonnegative(),
      }),
    )
    .max(64),
});
const legacyState = z.object({ version: z.literal(1), accounts: z.array(legacyAccount).max(32) }).strict();

export function parseUsageState(input: unknown) {
  if ((input as { version?: unknown } | null)?.version !== 1) return usageStateSchema.parse(input);
  const legacy = legacyState.parse(input);
  return usageStateSchema.parse({
    version: 2,
    accounts: legacy.accounts.map(({ phase, cycle, config: { mode, ...config }, sessions, ...account }) => ({
      ...account,
      config,
      // Re-deliver monitoring context after removing the old control instructions.
      sessions: sessions.map(({ parked, resumeCycle, ...session }) => ({ ...session, lastRevision: 0 })),
      pending: account.pending.filter(
        (event) => !['usage.pause_requested', 'usage.resume_pending'].includes(event.kind),
      ),
    })),
  });
}
