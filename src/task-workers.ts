import type { Task } from './task-model.js';
import type { TaskBoard } from './tasks.js';

export type WorkerLookup = () => Promise<
  { agentId: string; name: string; paneId: number | null; attachment: string; recoveryReason: string | null }[]
>;

/** Joins are informational snapshots, not atomic promises of dispatch or worker availability. */
export async function withTaskAssignments<T extends Pick<Task, 'assignedAgentId'>>(tasks: T[], lookup: WorkerLookup) {
  let workers: Awaited<ReturnType<WorkerLookup>> | undefined;
  if (tasks.some((t) => t.assignedAgentId))
    try {
      workers = await lookup();
    } catch {
      /* Task reads remain usable when worker storage is unavailable. */
    }
  const byId = new Map(workers?.map((w) => [w.agentId, w]));
  return tasks.map((task) => {
    const worker = task.assignedAgentId ? byId.get(task.assignedAgentId) : undefined;
    const assignment = !task.assignedAgentId
      ? null
      : !workers
        ? {
            agentId: task.assignedAgentId,
            availability: 'unknown',
            name: null,
            paneId: null,
            recoveryReason: 'Worker registry unavailable',
          }
        : worker
          ? {
              agentId: worker.agentId,
              availability: worker.attachment,
              name: worker.name,
              paneId: worker.paneId,
              recoveryReason: worker.recoveryReason,
            }
          : {
              agentId: task.assignedAgentId,
              availability: 'missing',
              name: null,
              paneId: null,
              recoveryReason: 'Worker mapping no longer exists',
            };
    return { ...task, assignment };
  });
}

export async function withWorkerTasks<T extends { agentId: string }>(workers: T[], board: TaskBoard) {
  try {
    const summaries = await board.workerSummaries();
    return workers.map((worker) => ({
      ...worker,
      tasks: {
        ...(summaries.get(worker.agentId) ?? { total: 0, items: [], truncated: false }),
        storageWarning: board.storage.warning ?? null,
      },
    }));
  } catch {
    // A damaged task journal must not prevent worker recovery or observation.
    return workers.map((worker) => ({
      ...worker,
      tasks: {
        total: null,
        items: [],
        truncated: false,
        storageWarning: 'TASK_SUMMARY_UNAVAILABLE: use task.list for diagnostics',
      },
    }));
  }
}
