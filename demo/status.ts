import { command, readEvidence, releaseReady, type DemoRun } from './runtime.js';
import type { DemoStatus } from './presentation.js';
type TaskView = {
  id: string;
  status: string;
  blockers: string[];
  assignedAgentId: string | null;
  verification?: { status: string };
  latestReport?: { outcome: string } | null;
};
type WorkerView = {
  agentId: string;
  inputRequired?: boolean;
  awaitingInput?: boolean;
  readyForPrompt?: boolean;
  inputRequest?: { kind: string } | null;
  error?: unknown;
  attachment?: string;
  deliveryPending?: boolean;
};
export function ticketState(task: TaskView | undefined, worker: WorkerView | undefined, merged: boolean) {
  if (!task || task.blockers.length || worker?.error || worker?.deliveryPending || worker?.attachment === 'detached')
    return 'Needs attention';
  if (worker?.inputRequired) return worker.inputRequest?.kind === 'permission' ? 'Needs approval' : 'Needs attention';
  if (task.assignedAgentId && !worker) return 'Needs attention';
  if (task.latestReport && task.latestReport.outcome !== 'succeeded') return 'Needs attention';
  if (['failed', 'inconclusive', 'stale'].includes(task.verification?.status ?? '')) return 'Needs attention';
  if (merged && task.status === 'done' && task.verification?.status === 'passed') return 'Merged';
  if (task.latestReport || merged) return 'Checking';
  if (task.status === 'in_progress') return 'Working';
  if (task.assignedAgentId) return worker?.readyForPrompt ? 'Ready' : 'Starting';
  return 'Queued';
}
export async function collectStatus(
  run: DemoRun,
  call: (name: string, args?: Record<string, unknown>) => Promise<any>,
): Promise<DemoStatus> {
  const page = await call('task.list', { boardId: 'sales-demo' });
  const workers: WorkerView[] = await call('orchestrator.status');
  const evidence = await readEvidence(run);
  const tickets = [];
  for (const ticket of run.tickets) {
    const task: TaskView | undefined = page.tasks.find((t: TaskView) => t.id === ticket.taskId);
    let merged = false;
    if (evidence[ticket.id]) {
      await command('git', ['merge-base', '--is-ancestor', evidence[ticket.id].commit, 'HEAD'], run.repository);
      merged = true;
    }
    tickets.push({
      id: ticket.id,
      title: ticket.title,
      state: ticketState(
        task,
        workers.find((w) => w.agentId === task?.assignedAgentId),
        merged,
      ),
    });
  }
  const released = tickets.every((t) => t.state === 'Merged') && (await releaseReady(run));
  return {
    available: true,
    updatedAt: new Date().toISOString(),
    tickets,
    released,
    message: released
      ? 'One request. Three specialists. One checked release.'
      : 'Dad is coordinating the board-meeting dashboard.',
  };
}
