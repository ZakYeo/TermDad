import { createHash } from 'node:crypto';
import { eligibility, providerName, usageId } from './usage-model.js';
import { evaluateUsage } from './usage-policy.js';
import { normalizeClaude } from './usage-providers.js';
import type { UsageService } from './usage.js';

export type HookClient = 'claude' | 'codex' | 'copilot';
/** Hook JSON is untrusted. Only identity and event name are retained, never prompts or tool output. */
export async function usageHook(usage: UsageService, accountRef: string, client: HookClient, input: unknown) {
  usageId.parse(accountRef);
  providerName.parse(client);
  const data = input as Record<string, unknown>;
  if (!data || typeof data !== 'object') throw new Error('USAGE_HOOK_INVALID');
  const rawId = data.session_id ?? data.sessionId;
  if (typeof rawId !== 'string' || !rawId || rawId.length > 4096) throw new Error('USAGE_SESSION_REQUIRED');
  const id = createHash('sha256').update(`${client}:${rawId}`).digest('hex');
  const event = String(data.hook_event_name ?? data.eventName ?? 'PostToolUse').toLowerCase();
  return usage.mutate(accountRef, (a) => {
    let session = a.sessions.find((s) => s.id === id);
    if (!session) {
      // Only closed/cancelled registrations can be evicted; live sessions are never silently dropped.
      a.sessions = a.sessions.filter((s) => !s.cancelled || usage.now() - s.lastSeen < 86400_000);
      if (a.sessions.length >= 64) throw new Error('USAGE_SESSION_LIMIT');
      session = { id, client, lastSeen: usage.now(), parked: false, cancelled: false, lastRevision: 0, resumeCycle: 0 };
      a.sessions.push(session);
    }
    session.lastSeen = usage.now();
    if (event === 'sessionend' || event === 'interrupt') {
      session.cancelled = true;
      return {};
    }
    if (event === 'sessionstart') session.cancelled = false;
    if (session.cancelled || !a.config.enabled) return {};
    if (
      session.parked &&
      session.resumeCycle === a.cycle &&
      eligibility(a, usage.now()) === null &&
      ['userpromptsubmit', 'posttooluse'].includes(event)
    )
      session.parked = false;
    evaluateUsage(a, usage.now());
    const paused =
      a.config.mode === 'automatic' && (eligibility(a, usage.now()) !== null || !usage.automatic(a.config));
    if (paused && (event === 'stop' || event === 'agentstop')) {
      session.parked = true;
      evaluateUsage(a, usage.now());
      // Never force a continuation through a Stop hook while quota is reserved.
      return {
        continue: false,
        stopReason: 'Term Dad account allowance is reserved; waiting for fresh recovery checks.',
      };
    }
    if (session.lastRevision === a.revision) return {};
    session.lastRevision = a.revision;
    const windows =
      a.observation?.windows.map((w) => `${w.kind}: ${w.usedPercent ?? 'unknown'}% used`).join('; ') || 'quota unknown';
    const message = `Term Dad usage (${accountRef}): ${windows}. ${
      paused
        ? 'Account paused. Save a concise checkpoint in the task board and end this turn. Do not dispatch new work. Automatic wake requires fresh short-window and weekly allowances above the configured reserves.'
        : `Policy: reserve ${a.config.reservePercent}% short-window and ${a.config.weeklyReservePercent}% weekly. ${a.config.mode === 'advisory' ? 'Advisory only; automatic pause/resume is not enabled.' : 'Inspect saved tasks and pending worker results before continuing.'}`
    }`;
    if (['stop', 'agentstop', 'sessionend', 'interrupt'].includes(event)) return {};
    if (client === 'copilot') return { additionalContext: message };
    const hookEventName =
      event === 'userpromptsubmit' ? 'UserPromptSubmit' : event === 'sessionstart' ? 'SessionStart' : 'PostToolUse';
    return { hookSpecificOutput: { hookEventName, additionalContext: message } };
  });
}

export async function claudeUsageFeed(usage: UsageService, ref: string, data: unknown) {
  const a = await usage.account(ref);
  if (a.config.provider !== 'claude') throw new Error('USAGE_PROVIDER_MISMATCH');
  const observation = normalizeClaude(data, usage.now());
  if (!observation) return;
  // Status lines may redraw without a new API response. A repaint must not freshen stale quotas.
  const payload = data as { cost?: { total_api_duration_ms?: number } };
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        windows: observation.windows,
        duration: payload.cost?.total_api_duration_ms,
      }),
    )
    .digest('hex');
  observation.source = `claude.statusline:${fingerprint}`;
  if (a.observation?.source === observation.source) return;
  await usage.ingest(ref, observation, a.revision);
}

/** Atomic per-session resume claim. The caller must recheck provider freshness before waking. */
export async function claimUsageResume(usage: UsageService, ref: string, sessionId: string) {
  return usage.mutate(ref, (a) => {
    const s = a.sessions.find((s) => s.id === sessionId);
    if (
      !s ||
      s.cancelled ||
      !s.parked ||
      s.resumeCycle >= a.cycle ||
      !usage.automatic(a.config) ||
      eligibility(a, usage.now()) !== null ||
      a.phase !== 'resume_pending'
    )
      return false;
    s.resumeCycle = a.cycle;
    return true;
  });
}
