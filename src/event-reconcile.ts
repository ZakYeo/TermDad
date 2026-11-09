import type { Agents } from './agents.js';
import type { EventQueue } from './events.js';
/** Only acknowledge the snapshot of events for a verified, absent managed pane. */
export async function reconcileEvents(
  queue: EventQueue,
  agents: Agents,
  agentIds: string[],
  expectedInstanceKey: string,
) {
  const pending = await queue.list({ agentIds }, false, 1000);
  const acknowledged: string[] = [],
    retained: { agentId: string; reason: string }[] = [];
  for (const agentId of agentIds) {
    try {
      const done = await agents.withVerifiedMissing(agentId, expectedInstanceKey, async (paneId) => {
        const ids = pending.events.filter((e) => e.agentId === agentId && e.paneId === paneId).map((e) => e.id);
        for (let start = 0; start < ids.length; start += 100) await queue.acknowledge(ids.slice(start, start + 100));
        acknowledged.push(...ids);
        return true;
      });
      if (!done) retained.push({ agentId, reason: 'pane_present_or_identity_unverified' });
    } catch {
      retained.push({ agentId, reason: 'worker_or_transport_unavailable' });
    }
  }
  return { acknowledged, retained };
}
