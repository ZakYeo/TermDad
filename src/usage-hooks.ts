import { createHash } from 'node:crypto';
import { freshness, providerName, usageId } from './usage-model.js';
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
      session = { id, client, lastSeen: usage.now(), cancelled: false, lastRevision: 0 };
      a.sessions.push(session);
    }
    session.lastSeen = usage.now();
    if (event === 'sessionend' || event === 'interrupt') {
      session.cancelled = true;
      return {};
    }
    if (event === 'sessionstart') session.cancelled = false;
    if (session.cancelled || !a.config.enabled) return {};
    // These callbacks cannot deliver additionalContext. Do not consume a warning that
    // must still reach the next model-visible hook (or the independently armed waiter).
    if (!['sessionstart', 'userpromptsubmit', 'posttooluse'].includes(event)) return {};
    if (session.lastRevision === a.revision) return {};
    session.lastRevision = a.revision;
    const reserveReached =
      !a.error &&
      freshness(a.observation, usage.now()) === 'fresh' &&
      a.observation!.windows.some(
        (w) =>
          ['five_hour', 'weekly'].includes(w.kind) &&
          w.usedPercent !== null &&
          (w.resetsAt === null || w.resetsAt > usage.now()) &&
          w.usedPercent >= 100 - (w.kind === 'weekly' ? a.config.weeklyReservePercent : a.config.reservePercent),
      );
    const windows =
      a.observation?.windows
        .map(
          (w) =>
            `${w.kind}: ${w.usedPercent ?? 'unknown'}% used, reset ${w.resetsAt === null ? 'unknown' : new Date(w.resetsAt).toISOString()}`,
        )
        .join('; ') || 'quota unknown';
    const resetNotice = a.resetAlerts.some((alert) => alert.notified)
      ? 'Expected reset time has passed. Check fresh five-hour and weekly allowances before resuming workers; recovery is not confirmed. '
      : '';
    const message = `Term Dad usage (${accountRef}, ${freshness(a.observation, usage.now())}): ${windows}. ${resetNotice}${
      reserveReached
        ? 'Usage reserve reached. As supervisor, pause new work on this account, request checkpoints from affected sessions, and park them at a safe boundary. Preserve panes and task state; agent.stop closes a pane, so do not use it to park work. Check fresh short-window and weekly allowances before continuing. Coordinate this through your normal tools.'
        : `Policy: reserve ${a.config.reservePercent}% short-window and ${a.config.weeklyReservePercent}% weekly. Check usage.status before new dispatch and reduce concurrency as allowance runs low. Stale or missing readings do not establish recovery.`
    }`;
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
  await usage.ingest(ref, observation, a.sourceRevision);
}
