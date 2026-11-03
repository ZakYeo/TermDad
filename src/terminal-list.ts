import { sessionContext } from './session-context.js';
import type { Pane } from './backend.js';
import type { Agents } from './agents.js';
import type { TerminalInstance } from './worker-storage.js';

type WorkerView = Awaited<ReturnType<Agents['list']>>[number];
export type ActivityContext = {
  status: string;
  source: string;
  observedAt?: string;
  inputRequired?: boolean;
  note?: string;
};
export type Inventory = {
  activities?: Record<number, ActivityContext>;
  selected: TerminalInstance | null;
  panes: Pane[];
  workers: WorkerView[];
  notes: string[];
};
export type ListOptions = { verbose?: boolean; includeDetached?: boolean };
const nonempty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
function directoryLabel(cwd: string) {
  let path = cwd;
  try {
    path = decodeURIComponent(new URL(cwd).pathname);
  } catch {
    /* Plain terminal-domain paths are valid labels. */
  }
  return path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1);
}
export function compactInventory(inventory: Inventory, options: ListOptions = {}) {
  const attached = new Map(inventory.workers.filter((w) => w.attachment === 'attached').map((w) => [w.paneId, w]));
  const panes = inventory.panes.map((pane) => {
    const worker = attached.get(pane.pane_id);
    const title = nonempty(pane.title),
      directory = directoryLabel(pane.cwd);
    const workerName = nonempty(worker?.name);
    const label = workerName ?? title ?? directory ?? `Pane ${pane.pane_id}`;
    const labelSource = workerName ? 'worker' : title ? 'pane_title' : directory ? 'directory' : 'pane_id';
    return {
      pane_id: pane.pane_id,
      tab_id: pane.tab_id,
      window_id: pane.window_id,
      title: pane.title,
      cwd: pane.cwd,
      label,
      labelSource,
      session: sessionContext(pane, worker),
      activity: inventory.activities?.[pane.pane_id] ?? { status: 'UNKNOWN', source: 'not_inspected' },
      worker: worker ? { agentId: worker.agentId, name: worker.name, cli: worker.cli } : null,
      ...(options.verbose ? { raw: pane } : {}),
    };
  });
  const tabs = new Map<string, typeof panes>();
  for (const pane of panes) {
    const key = `${pane.window_id}:${pane.tab_id}`;
    const group = tabs.get(key) ?? [];
    group.push(pane);
    tabs.set(key, group);
  }
  const labelledPanes = panes.map((pane) => {
    const group = tabs.get(`${pane.window_id}:${pane.tab_id}`)!;
    const representative = [...group].sort((a, b) => a.pane_id - b.pane_id)[0];
    const title = inventory.panes
      .filter((p) => p.window_id === pane.window_id && p.tab_id === pane.tab_id)
      .sort((a, b) => a.pane_id - b.pane_id)
      .map((p) => nonempty(p.tab_title))
      .find(Boolean);
    return {
      ...pane,
      tabLabel: title ?? `${representative.label}${group.length > 1 ? ` (${group.length} panes)` : ''}`,
      tabLabelSource: title ? 'tab_title' : 'pane_label',
    };
  });
  const detached = inventory.workers.filter((w) => w.attachment !== 'attached');
  const reasons: Record<string, number> = {};
  for (const worker of detached) {
    const code = worker.recoveryCode ?? 'verification_unavailable';
    reasons[code] = (reasons[code] ?? 0) + 1;
  }
  return {
    selected: inventory.selected,
    panes: labelledPanes,
    counts: { windows: new Set(panes.map((p) => p.window_id)).size, tabs: tabs.size, panes: panes.length },
    detached: { count: detached.length, reasons, ...(options.includeDetached ? { workers: detached } : {}) },
    notes: inventory.notes,
  };
}
