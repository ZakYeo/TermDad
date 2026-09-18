import { randomUUID } from 'node:crypto';
import type { TaskBoard } from '../src/tasks.js';

export const resultReport = {
  outcome: 'succeeded',
  summary: 'Implemented and checked',
  workVersion: 'commit:test',
  provenance: 'supervisor_recorded',
  artifacts: [],
  checks: [],
};
export async function completeTask(board: TaskBoard, taskId: string) {
  let task = await board.get(taskId);
  if (!task.assignedAgentId)
    task = await board.assign({ taskId, expectedRevision: task.revision, agentId: randomUUID() });
  task = await board.startAttempt({ taskId, expectedRevision: task.revision });
  task = await board.reportResult({
    taskId,
    expectedRevision: task.revision,
    attemptId: task.currentAttemptId,
    ...resultReport,
  });
  return board.verify({
    taskId,
    expectedRevision: task.revision,
    attemptId: task.currentAttemptId,
    reportId: task.latestReport!.id,
    workVersion: resultReport.workVersion,
    result: 'passed',
    rationale: 'Reviewed the requested outcome',
    criteria: task.acceptanceCriteria.map((c) => ({
      criterionId: c.id,
      result: 'passed',
      evidence: ['Reviewed behavior'],
    })),
    complete: true,
  });
}
export async function completeViaTools(
  call: (name: string, args: Record<string, unknown>) => Promise<any>,
  taskId: string,
) {
  let task = await call('task.get', { taskId });
  if (!task.assignedAgentId)
    task = await call('task.assign', { taskId, expectedRevision: task.revision, agentId: randomUUID() });
  task = await call('task.start_attempt', { taskId, expectedRevision: task.revision });
  task = await call('task.report_result', {
    taskId,
    expectedRevision: task.revision,
    attemptId: task.currentAttemptId,
    ...resultReport,
  });
  return call('task.verify', {
    taskId,
    expectedRevision: task.revision,
    attemptId: task.currentAttemptId,
    reportId: task.latestReport.id,
    workVersion: resultReport.workVersion,
    result: 'passed',
    rationale: 'Reviewed the requested outcome',
    criteria: task.acceptanceCriteria.map((c: any) => ({
      criterionId: c.id,
      result: 'passed',
      evidence: ['Reviewed behavior'],
    })),
    complete: true,
  });
}
