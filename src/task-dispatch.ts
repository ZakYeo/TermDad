import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createTaskSchema, MAX_TASKS, taskView, validateTaskState, type Task } from './task-model.js';
import type { TaskBoard } from './tasks.js';

export const dispatchSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(100),
    agentId: z.uuid(),
    task: createTaskSchema.omit({ assignedAgentId: true }),
    text: z.string().min(1).max(100000),
  })
  .strict();
export type DispatchInput = z.infer<typeof dispatchSchema>;
type Submit = (taskId: string, attemptId: string) => Promise<{ turnId: string }>;
/** Persist uncertainty before PTY I/O: a restart can never accidentally resend. */
export async function dispatchTask(board: TaskBoard, raw: unknown, submit: Submit) {
  const input = dispatchSchema.parse(raw);
  const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const prepared = await board.storage.transaction(true, (state) => {
    const existing = state.tasks.find((t) => t.dispatch?.key === input.idempotencyKey);
    if (existing) {
      if (existing.dispatch!.fingerprint !== fingerprint) throw new Error('TASK_DISPATCH_KEY_CONFLICT');
      return { result: taskView(existing, state) };
    }
    if (state.tasks.length >= MAX_TASKS) throw new Error('TASK_CAPACITY');
    if (
      input.task.blockers.length ||
      input.task.dependencies.some((id) => state.tasks.find((t) => t.id === id)?.status !== 'done')
    )
      throw new Error('TASK_START_BLOCKED');
    const at = new Date().toISOString(),
      attemptId = randomUUID();
    const task: Task = {
      ...input.task,
      assignedAgentId: input.agentId,
      id: randomUUID(),
      status: 'in_progress',
      archived: false,
      revision: 1,
      createdAt: at,
      updatedAt: at,
      legacyCompletion: false,
      currentAttemptId: attemptId,
      attempts: [
        {
          id: attemptId,
          agentId: input.agentId,
          startedAt: at,
          specification: {
            goal: input.task.goal,
            acceptanceCriteria: input.task.acceptanceCriteria.map(({ id, description }) => ({ id, description })),
            dependencies: input.task.dependencies,
          },
          reports: [],
          verifications: [],
        },
      ],
      dispatch: {
        key: input.idempotencyKey,
        fingerprint,
        attemptId,
        status: 'prepared',
      },
    };
    state.tasks.push(task);
    validateTaskState(state);
    return { state, result: taskView(task, state) };
  });
  if (prepared.dispatch!.status !== 'prepared') return prepared;
  const claimed = await board.storage.transaction(true, (state) => {
    const task = state.tasks.find((t) => t.id === prepared.id)!;
    if (task.dispatch!.status !== 'prepared') return { result: false };
    task.dispatch!.status = 'uncertain';
    task.revision++;
    task.updatedAt = new Date().toISOString();
    return { state, result: true };
  });
  if (!claimed) return board.get(prepared.id);
  let receipt: { turnId: string } | undefined, errorCode: string | undefined;
  try {
    await board.validateAttempt(prepared.id, prepared.dispatch!.attemptId, input.agentId);
    receipt = await submit(prepared.id, prepared.dispatch!.attemptId);
  } catch (error) {
    errorCode = error instanceof Error ? error.message.match(/^[A-Z][A-Z_]+(?=:|$)/)?.[0] : undefined;
    errorCode ??= 'TASK_DISPATCH_UNCERTAIN';
  }
  return board.storage.transaction(true, (state) => {
    const task = state.tasks.find((t) => t.id === prepared.id)!;
    task.dispatch!.status = receipt
      ? 'submitted'
      : [
            'WORKER_NOT_READY',
            'WORKER_INPUT_REQUIRED',
            'WORKER_BUSY',
            'TASK_START_BLOCKED',
            'TASK_ATTEMPT_STALE',
            'TASK_ASSIGNMENT_MISMATCH',
            'TASK_ARCHIVED',
          ].includes(errorCode!)
        ? 'not_submitted'
        : 'uncertain';
    if (receipt) task.dispatch!.turnId = receipt.turnId;
    else task.dispatch!.errorCode = errorCode;
    task.revision++;
    task.updatedAt = new Date().toISOString();
    validateTaskState(state);
    return { state, result: taskView(task, state) };
  });
}
