import { z } from 'zod';
import { completionFields, completionView } from './task-results.js';

export const MAX_TASKS = 1000;
const label = z.string().trim().min(1).max(200);
export const criterionSchema = z
  .object({
    id: z.string().min(1).max(100),
    description: z.string().trim().min(1).max(2000),
    satisfied: z.boolean().default(false),
    evidence: z.string().max(4000).optional(),
  })
  .strict();
export const taskFields = {
  title: label,
  goal: z.string().trim().min(1).max(8000),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  assignedAgentId: z.uuid().nullable(),
  dependencies: z.array(z.uuid()).max(100),
  blockers: z.array(z.string().trim().min(1).max(2000)).max(50),
  acceptanceCriteria: z.array(criterionSchema).max(50),
};
export const taskSchema = z
  .object({
    ...taskFields,
    ...completionFields,
    id: z.uuid(),
    boardId: label,
    status: z.enum(['todo', 'in_progress', 'done', 'cancelled']),
    archived: z.boolean(),
    revision: z.number().int().positive().safe(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type Task = z.infer<typeof taskSchema>;
export const createTaskSchema = z
  .object({
    ...taskFields,
    boardId: label,
    priority: taskFields.priority.default('normal'),
    assignedAgentId: taskFields.assignedAgentId.default(null),
    dependencies: taskFields.dependencies.default([]),
    blockers: taskFields.blockers.default([]),
    acceptanceCriteria: taskFields.acceptanceCriteria.default([]),
  })
  .strict();
export const taskPatchSchema = z
  .object({ ...taskFields, status: taskSchema.shape.status })
  .partial()
  .strict()
  .refine((p) => Object.values(p).some((v) => v !== undefined), 'Provide at least one change');
export const taskIdentity = { taskId: z.uuid(), expectedRevision: taskSchema.shape.revision };
export const updateTaskSchema = z.object({ ...taskIdentity, patch: taskPatchSchema }).strict();
export const taskFilterSchema = z
  .object({
    boardId: label.optional(),
    assignedAgentId: taskFields.assignedAgentId.optional(),
    status: taskSchema.shape.status.optional(),
    priority: taskFields.priority.optional(),
    includeArchived: z.boolean().default(false),
    readyOnly: z.boolean().default(false),
    offset: z.number().int().min(0).max(MAX_TASKS).default(0),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export const taskStateSchema = z.object({ version: z.literal(2), tasks: z.array(taskSchema).max(MAX_TASKS) }).strict();
export type TaskState = z.infer<typeof taskStateSchema>;
export const emptyTaskState = (): TaskState => ({ version: 2, tasks: [] });

/** Validate the complete graph within one storage transaction, including reverse dependents. */
export function validateTaskState(value: unknown): TaskState {
  // Upgrade only the exact legacy schema; never silently strip corrupt fields.
  const legacy = z
    .object({
      version: z.literal(1),
      tasks: z
        .array(taskSchema.omit({ attempts: true, currentAttemptId: true, legacyCompletion: true }))
        .max(MAX_TASKS),
    })
    .strict();
  if (typeof value === 'object' && value !== null && 'version' in value && value.version === 1) {
    const old = legacy.safeParse(value);
    if (!old.success) throw new Error('TASK_STATE_INVALID: invalid legacy records');
    value = {
      version: 2,
      tasks: old.data.tasks.map((t) => ({
        ...t,
        attempts: [],
        currentAttemptId: null,
        legacyCompletion: t.status === 'done',
      })),
    };
  }
  const parsed = taskStateSchema.safeParse(value);
  if (!parsed.success) throw new Error('TASK_STATE_INVALID: invalid task records');
  const state = parsed.data,
    byId = new Map(state.tasks.map((t) => [t.id, t]));
  if (byId.size !== state.tasks.length) throw new Error('TASK_DUPLICATE_ID');
  for (const task of state.tasks) {
    if (task.updatedAt < task.createdAt) throw new Error('TASK_STATE_INVALID: timestamps out of order');
    if (new Set(task.dependencies).size !== task.dependencies.length) throw new Error('TASK_DUPLICATE_DEPENDENCY');
    if (new Set(task.acceptanceCriteria.map((c) => c.id)).size !== task.acceptanceCriteria.length)
      throw new Error('TASK_DUPLICATE_CRITERION');
    for (const id of task.dependencies) {
      const dependency = byId.get(id);
      if (!dependency) throw new Error('TASK_DEPENDENCY_MISSING');
      if (dependency.boardId !== task.boardId) throw new Error('TASK_DEPENDENCY_BOARD_MISMATCH');
    }
    const attempt = task.attempts.find((a) => a.id === task.currentAttemptId);
    if (task.currentAttemptId && !attempt) throw new Error('TASK_STATE_INVALID: missing current attempt');
    if (
      attempt &&
      (attempt.agentId !== task.assignedAgentId ||
        attempt.specification.goal !== task.goal ||
        JSON.stringify(attempt.specification.dependencies) !== JSON.stringify(task.dependencies) ||
        JSON.stringify(attempt.specification.acceptanceCriteria) !==
          JSON.stringify(task.acceptanceCriteria.map(({ id, description }) => ({ id, description }))))
    )
      throw new Error('TASK_STATE_INVALID: stale attempt specification');
    if (task.legacyCompletion && (task.status !== 'done' || task.attempts.length))
      throw new Error('TASK_STATE_INVALID: invalid legacy completion');
    if (new Set(task.attempts.map((a) => a.id)).size !== task.attempts.length)
      throw new Error('TASK_STATE_INVALID: duplicate attempts');
    for (const a of task.attempts) {
      if (
        new Set(a.reports.map((r) => r.id)).size !== a.reports.length ||
        new Set(a.verifications.map((v) => v.id)).size !== a.verifications.length
      )
        throw new Error('TASK_STATE_INVALID: duplicate results');
      if (
        new Set(a.specification.acceptanceCriteria.map((c) => c.id)).size !== a.specification.acceptanceCriteria.length
      )
        throw new Error('TASK_STATE_INVALID: duplicate snapshot criteria');
      for (const r of a.reports) {
        if (
          new Set(r.checks.map((c) => c.id)).size !== r.checks.length ||
          r.checks.some(
            (c) =>
              new Set(c.criterionIds).size !== c.criterionIds.length ||
              c.criterionIds.some((id) => !a.specification.acceptanceCriteria.some((s) => s.id === id)),
          )
        )
          throw new Error('TASK_STATE_INVALID: check criteria');
      }
      for (const v of a.verifications) {
        const report = a.reports.find((r) => r.id === v.reportId);
        if (!report || report.workVersion !== v.workVersion)
          throw new Error('TASK_STATE_INVALID: verification reference');
        const ids = v.criteria.map((c) => c.criterionId);
        if (
          new Set(ids).size !== ids.length ||
          ids.some((id) => !a.specification.acceptanceCriteria.some((c) => c.id === id))
        )
          throw new Error('TASK_STATE_INVALID: verification criteria');
        if (
          v.result === 'passed' &&
          (report.outcome !== 'succeeded' ||
            report.checks.some((c) => c.result === 'failed') ||
            v.criteria.some((c) => c.result !== 'passed') ||
            ids.length !== a.specification.acceptanceCriteria.length)
        )
          throw new Error('TASK_STATE_INVALID: invalid passing verification');
      }
    }
    if (
      task.status === 'done' &&
      (task.blockers.length ||
        task.acceptanceCriteria.some((c) => !c.satisfied) ||
        task.dependencies.some((id) => byId.get(id)?.status !== 'done'))
    )
      throw new Error('TASK_COMPLETION_BLOCKED: resolve blockers, dependencies and acceptance criteria first');
    if (
      completionView(task).verification.status === 'passed' &&
      (task.blockers.length || task.dependencies.some((id) => byId.get(id)?.status !== 'done'))
    )
      throw new Error('TASK_COMPLETION_BLOCKED: invalidate dependent verification before reopening prerequisites');
    if (task.status === 'done' && !task.legacyCompletion && completionView(task).verification.status !== 'passed')
      throw new Error('TASK_VERIFICATION_REQUIRED');
  }
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('TASK_DEPENDENCY_CYCLE');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of byId.get(id)!.dependencies) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of state.tasks) visit(task.id);
  if (Buffer.byteLength(JSON.stringify(state)) > 4_000_000) throw new Error('TASK_STORAGE_SIZE_LIMIT');
  return state;
}

export function taskView(task: Task, state: TaskState) {
  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  const unresolvedDependencyIds = task.dependencies.filter((id) => byId.get(id)?.status !== 'done');
  const blocked = task.blockers.length > 0 || unresolvedDependencyIds.length > 0;
  const { attempts, ...record } = task;
  return {
    ...record,
    ...completionView(task),
    blocked,
    unresolvedDependencyIds,
    ready: !task.archived && task.status === 'todo' && !blocked,
  };
}
