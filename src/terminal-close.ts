import type { TerminalBackend } from './backend.js';
import { CodedError } from './errors.js';
export type CloseOutcome = { paneId: number; outcome: 'closed' | 'already_gone' | 'failed' | 'skipped'; note?: string };
export async function closePanes(
  backend: TerminalBackend,
  paneIds: number[],
  expectedInstanceKey: string,
  reconcile: (paneId: number) => Promise<void>,
) {
  if (
    !paneIds.length ||
    paneIds.length > 100 ||
    new Set(paneIds).size !== paneIds.length ||
    paneIds.some((id) => !Number.isSafeInteger(id) || id < 0) ||
    !expectedInstanceKey
  )
    throw new CodedError(
      'ARGUMENT_INVALID',
      'Batch close needs 1–100 unique pane IDs and expectedInstanceKey from terminal.list.',
    );
  const verify = async () => {
    const identity = await backend.instance?.();
    if (!identity || identity.key !== expectedInstanceKey)
      throw new CodedError(
        'TERMINAL_IDENTITY_MISMATCH',
        'Terminal identity differs or is unavailable; list again before closing.',
      );
  };
  await verify();
  const results: CloseOutcome[] = [];
  let stopped = false;
  for (const paneId of paneIds) {
    if (stopped) {
      results.push({ paneId, outcome: 'skipped', note: 'Terminal identity could not be verified.' });
      continue;
    }
    try {
      await verify();
    } catch {
      stopped = true;
      results.push({ paneId, outcome: 'skipped', note: 'Terminal identity could not be verified.' });
      continue;
    }
    try {
      const panes = await backend.list();
      try {
        await verify();
      } catch {
        stopped = true;
        results.push({ paneId, outcome: 'skipped', note: 'Terminal identity changed during listing.' });
        continue;
      }
      if (!panes.some((pane) => pane.pane_id === paneId)) {
        results.push({ paneId, outcome: 'already_gone' });
        continue;
      }
      await backend.close(paneId);
      let note: string | undefined;
      try {
        await reconcile(paneId);
      } catch {
        note = 'Pane closed; worker reconciliation unavailable. Refresh agent.list.';
      }
      results.push({ paneId, outcome: 'closed', ...(note ? { note } : {}) });
    } catch {
      // Failure does not establish disappearance. Recheck both identity and existence.
      try {
        await verify();
        const panes = await backend.list();
        await verify();
        results.push({ paneId, outcome: panes.some((pane) => pane.pane_id === paneId) ? 'failed' : 'already_gone' });
      } catch {
        try {
          await verify();
        } catch {
          stopped = true;
        }
        results.push({ paneId, outcome: 'failed', note: 'Close or verification failed; inspect before retrying.' });
      }
    }
  }
  return { results };
}
