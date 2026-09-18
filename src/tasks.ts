import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  MAX_TASKS,
  createTaskSchema,
  taskFilterSchema,
  taskIdentity,
  taskView,
  updateTaskSchema,
  validateTaskState,
  type Task,
  type TaskState,
} from './task-model.js';
import {
  startAttemptSchema,
  reportResultSchema,
  verifyTaskSchema,
  taskHistorySchema,
  type Attempt,
} from './task-results.js';
import type { TaskStorage } from './task-storage.js';

export const assignTaskSchema = z.object({ ...taskIdentity, agentId: z.uuid().nullable() }).strict();
export const archiveTaskSchema = z.object({ ...taskIdentity, archived: z.boolean() }).strict();
const priorities = { urgent: 0, high: 1, normal: 2, low: 3 };

/** Task truth is explicit metadata, independent of terminal readiness or worker lifetime. */
export class TaskBoard {
  private operations = new Set<Promise<unknown>>();
  private closed = false;
  constructor(readonly storage: TaskStorage) {}
  private run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('TASK_BOARD_CLOSED'));
    if (this.operations.size >= 128) return Promise.reject(new Error('TASK_OPERATION_LIMIT'));
    const operation = Promise.resolve().then(fn);
    this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation)).catch(() => {});
    return operation;
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.operations]);
  }
  private find(state: TaskState, id: string) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) throw new Error('TASK_NOT_FOUND');
    return task;
  }
  create(input: unknown) {
    return this.run(async () => {
      const fields = createTaskSchema.parse(input);
      return this.storage.transaction(true, (state) => {
        if (state.tasks.length >= MAX_TASKS) throw new Error('TASK_CAPACITY: archived tasks count toward capacity');
        const now = new Date().toISOString();
        const task: Task = {
          ...fields,
          attempts: [],
          currentAttemptId: null,
          legacyCompletion: false,
          id: randomUUID(),
          status: 'todo',
          archived: false,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        state.tasks.push(task);
        validateTaskState(state);
        return { state, result: taskView(task, state) };
      });
    });
  }
  get(taskId: string) {
    return this.run(async () => {
      z.uuid().parse(taskId);
      return this.storage.transaction(false, (state) => ({ result: taskView(this.find(state, taskId), state) }));
    });
  }
  list(input: unknown = {}) {
    return this.run(async () => {
      const filter = taskFilterSchema.parse(input);
      return this.storage.transaction(false, (state) => {
        const tasks = state.tasks
          .filter(
            (t) =>
              (filter.includeArchived || !t.archived) &&
              (filter.boardId === undefined || t.boardId === filter.boardId) &&
              (filter.assignedAgentId === undefined || t.assignedAgentId === filter.assignedAgentId) &&
              (filter.status === undefined || t.status === filter.status) &&
              (filter.priority === undefined || t.priority === filter.priority),
          )
          .map((t) => taskView(t, state))
          .filter((t) => !filter.readyOnly || t.ready)
          .sort(
            (a, b) =>
              priorities[a.priority] - priorities[b.priority] ||
              a.createdAt.localeCompare(b.createdAt) ||
              a.id.localeCompare(b.id),
          );
        const end = filter.offset + filter.limit;
        return {
          result: {
            tasks: tasks.slice(filter.offset, end),
            total: tasks.length,
            nextOffset: end < tasks.length ? end : null,
            storageWarning: this.storage.warning ?? null,
          },
        };
      });
    });
  }
  /** One consistent graph read for derived orchestration views, including archived transitions. */
  snapshot() {
    return this.run(() =>
      this.storage.transaction(false, (state) => ({
        result: {
          tasks: state.tasks.map((task) => taskView(task, state)),
          storageWarning: this.storage.warning ?? null,
        },
      })),
    );
  }
  /** Compact, bounded summaries for worker views; full details remain paginated in task.list. */
  workerSummaries() {
    return this.run(() =>
      this.storage.transaction(false, (state) => {
        const groups = new Map<string, ReturnType<typeof taskView>[]>();
        for (const task of state.tasks) {
          if (task.archived || !task.assignedAgentId) continue;
          const tasks = groups.get(task.assignedAgentId) ?? [];
          tasks.push(taskView(task, state));
          groups.set(task.assignedAgentId, tasks);
        }
        const summaries = new Map(
          [...groups].map(([agentId, tasks]) => {
            tasks.sort(
              (a, b) =>
                priorities[a.priority] - priorities[b.priority] ||
                a.createdAt.localeCompare(b.createdAt) ||
                a.id.localeCompare(b.id),
            );
            return [
              agentId,
              {
                total: tasks.length,
                items: tasks
                  .slice(0, 20)
                  .map(
                    ({
                      id,
                      boardId,
                      title,
                      status,
                      priority,
                      blocked,
                      revision,
                      currentAttemptId,
                      latestReport,
                      verification,
                    }) => ({
                      id,
                      boardId,
                      title,
                      status,
                      priority,
                      blocked,
                      revision,
                      currentAttemptId,
                      reportedOutcome: latestReport?.outcome ?? null,
                      verificationStatus: verification.status,
                    }),
                  ),
                truncated: tasks.length > 20,
              },
            ];
          }),
        );
        return { result: summaries };
      }),
    );
  }
  private change(taskId: string, expectedRevision: number, apply: (task: Task) => void) {
    return this.storage.transaction(true, (state) => {
      const task = this.find(state, taskId);
      if (task.revision !== expectedRevision)
        throw new Error('TASK_REVISION_CONFLICT: reload the task before retrying');
      if (task.revision === Number.MAX_SAFE_INTEGER) throw new Error('TASK_REVISION_OVERFLOW');
      apply(task);
      task.revision++;
      task.updatedAt = new Date(Math.max(Date.now(), Date.parse(task.updatedAt))).toISOString();
      validateTaskState(state);
      return { state, result: taskView(task, state) };
    });
  }
  update(input: unknown) {
    return this.run(async () => {
      const { taskId, expectedRevision, patch } = updateTaskSchema.parse(input);
      return this.change(taskId, expectedRevision, (task) => {
        if (task.archived) throw new Error('TASK_ARCHIVED: unarchive before editing');
        const invalidates =
          Object.keys(patch).some(
            (key) =>
              ['goal', 'acceptanceCriteria', 'dependencies', 'assignedAgentId', 'blockers'].includes(key) &&
              JSON.stringify(patch[key as keyof typeof patch]) !== JSON.stringify(task[key as keyof Task]),
          ) ||
          (patch.status !== undefined &&
            patch.status !== task.status &&
            (task.status === 'done' || ['todo', 'cancelled'].includes(patch.status)));
        if (invalidates) {
          if (task.status === 'done' && (!patch.status || patch.status === 'done'))
            throw new Error('TASK_REOPEN_REQUIRED');
          task.currentAttemptId = null;
          task.legacyCompletion = false;
        }
        for (const [key, value] of Object.entries(patch))
          if (value !== undefined) Object.assign(task, { [key]: value });
      });
    });
  }
  assign(input: unknown) {
    return this.run(async () => {
      const { taskId, expectedRevision, agentId } = assignTaskSchema.parse(input);
      return this.change(taskId, expectedRevision, (task) => {
        if (task.archived) throw new Error('TASK_ARCHIVED: unarchive before assigning');
        if (task.assignedAgentId !== agentId) {
          if (task.status === 'done') throw new Error('TASK_REOPEN_REQUIRED');
          task.currentAttemptId = null;
          task.legacyCompletion = false;
        }
        task.assignedAgentId = agentId;
      });
    });
  }
  private editable(task: Task) {
    if (task.archived) throw new Error('TASK_ARCHIVED');
    if (task.status === 'done' || task.status === 'cancelled') throw new Error('TASK_REOPEN_REQUIRED');
  }
  private current(task: Task, attemptId: string): Attempt {
    const attempt = task.attempts.find((a) => a.id === attemptId);
    if (!attempt || task.currentAttemptId !== attemptId || attempt.agentId !== task.assignedAgentId)
      throw new Error('TASK_ATTEMPT_STALE');
    return attempt;
  }
  startAttempt(input: unknown) {
    return this.run(async () => {
      const o = startAttemptSchema.parse(input);
      return this.change(o.taskId, o.expectedRevision, (task) => {
        this.editable(task);
        if (!task.assignedAgentId) throw new Error('TASK_ASSIGNMENT_REQUIRED');
        if (task.attempts.length >= 20) throw new Error('TASK_ATTEMPT_LIMIT');
        const attempt: Attempt = {
          id: randomUUID(),
          agentId: task.assignedAgentId,
          startedAt: new Date().toISOString(),
          specification: {
            goal: task.goal,
            acceptanceCriteria: task.acceptanceCriteria.map(({ id, description }) => ({ id, description })),
            dependencies: [...task.dependencies],
          },
          reports: [],
          verifications: [],
        };
        task.attempts.push(attempt);
        task.currentAttemptId = attempt.id;
        task.status = 'in_progress';
        task.legacyCompletion = false;
      });
    });
  }
  reportResult(input: unknown) {
    return this.run(async () => {
      const { taskId, expectedRevision, attemptId, ...report } = reportResultSchema.parse(input);
      return this.change(taskId, expectedRevision, (task) => {
        this.editable(task);
        const attempt = this.current(task, attemptId);
        if (attempt.reports.length >= 20) throw new Error('TASK_REPORT_LIMIT');
        if (new Set(report.checks.map((c) => c.id)).size !== report.checks.length)
          throw new Error('TASK_CHECK_DUPLICATE');
        if (
          report.checks.some(
            (c) =>
              new Set(c.criterionIds).size !== c.criterionIds.length ||
              c.criterionIds.some((id) => !task.acceptanceCriteria.some((a) => a.id === id)),
          )
        )
          throw new Error('TASK_CHECK_CRITERION_INVALID');
        attempt.reports.push({ ...report, id: randomUUID(), createdAt: new Date().toISOString() });
      });
    });
  }
  verify(input: unknown) {
    return this.run(async () => {
      const { taskId, expectedRevision, attemptId, complete, ...decision } = verifyTaskSchema.parse(input);
      return this.change(taskId, expectedRevision, (task) => {
        this.editable(task);
        const attempt = this.current(task, attemptId),
          report = attempt.reports.at(-1);
        if (!report || report.id !== decision.reportId || report.workVersion !== decision.workVersion)
          throw new Error('TASK_REPORT_STALE');
        if (attempt.verifications.length >= 20) throw new Error('TASK_VERIFICATION_LIMIT');
        if (complete && decision.result !== 'passed') throw new Error('TASK_VERIFICATION_REQUIRED');
        if (decision.result === 'passed') {
          if (task.blockers.length) throw new Error('TASK_COMPLETION_BLOCKED');
          // Graph validation checks dependencies, even when completion is deferred.
          task.acceptanceCriteria = task.acceptanceCriteria.map((c) => ({
            ...c,
            satisfied: true,
            evidence: decision.criteria
              .find((d) => d.criterionId === c.id)
              ?.evidence.join('\n')
              .slice(0, 4000),
          }));
        }
        attempt.verifications.push({ ...decision, id: randomUUID(), createdAt: new Date().toISOString() });
        if (complete) task.status = 'done';
      });
    });
  }
  history(input: unknown) {
    return this.run(async () => {
      const o = taskHistorySchema.parse(input);
      return this.storage.transaction(false, (state) => {
        const task = this.find(state, o.taskId),
          end = o.offset + o.limit;
        return {
          result: {
            taskId: task.id,
            revision: task.revision,
            attempts: task.attempts.slice(o.offset, end),
            total: task.attempts.length,
            nextOffset: end < task.attempts.length ? end : null,
          },
        };
      });
    });
  }
  validateAttempt(taskId: string, attemptId: string, agentId: string) {
    return this.run(() =>
      this.storage.transaction(false, (state) => {
        const task = this.find(state, taskId);
        this.editable(task);
        const attempt = this.current(task, attemptId);
        if (attempt.agentId !== agentId) throw new Error('TASK_ASSIGNMENT_MISMATCH');
        return { result: undefined };
      }),
    );
  }
  archive(input: unknown) {
    return this.run(async () => {
      const { taskId, expectedRevision, archived } = archiveTaskSchema.parse(input);
      return this.change(taskId, expectedRevision, (task) => {
        task.archived = archived;
      });
    });
  }
}
