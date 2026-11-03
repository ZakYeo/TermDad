import { workerCommand } from './launcher.js';
import { saveRun, type DemoRun } from './runtime.js';

type Call = (name: string, args?: Record<string, unknown>) => Promise<any>;

/** Routine setup after Start. Dad still handles readiness, approvals, dispatch and verification. */
export async function bootstrapWorkers(run: DemoRun, call: Call, persist = saveRun) {
  if (run.panes.length || run.tickets.some((ticket) => ticket.agentId))
    throw new Error('Demo workers were already created; do not replay startup.');
  if (run.tickets.length !== 3 || run.tickets.some((ticket) => !ticket.taskId))
    throw new Error('Three recorded demo tasks are required before worker startup.');
  const command = workerCommand(undefined, run);
  const verifyPane = async (paneId: number) => {
    const list = await call('terminal.list');
    if (list.selected?.key !== run.instanceKey)
      throw new Error('Demo GUI identity changed during startup; inspect the existing panes.');
    if (!list.panes.some((pane: { pane_id: number }) => pane.pane_id === paneId))
      throw new Error('Demo parent or worker pane disappeared during startup.');
  };
  for (let index = 0; index < run.tickets.length; index++) {
    const ticket = run.tickets[index];
    const parent = index === 0 ? run.parentPane : run.panes[index - 1];
    await verifyPane(parent);
    // Do not retry: an error can mean a pane was created but its response was lost.
    const paneId: unknown = await call('terminal.split', {
      paneId: parent,
      direction: index === 0 ? 'right' : 'bottom',
      percent: index === 0 || index === 2 ? 50 : 67,
      cwd: ticket.worktree,
      command,
    });
    if (
      typeof paneId !== 'number' ||
      !Number.isSafeInteger(paneId) ||
      paneId < 0 ||
      run.panes.includes(paneId) ||
      paneId === run.parentPane
    )
      throw new Error('Uncertain demo pane creation; inspect the GUI before continuing.');
    run.panes.push(paneId);
    await persist(run);
    await verifyPane(paneId);
    const worker = await call('agent.adopt', { paneId, name: ticket.id, cli: 'codex' });
    if (typeof worker.agentId !== 'string' || !worker.agentId)
      throw new Error('Uncertain demo worker adoption; inspect the existing pane.');
    ticket.agentId = worker.agentId;
    await persist(run);
    const task = await call('task.get', { taskId: ticket.taskId });
    await call('task.assign', { taskId: ticket.taskId, agentId: worker.agentId, expectedRevision: task.revision });
  }
}
