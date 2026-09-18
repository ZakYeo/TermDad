import type { Agents } from './agents.js';
import type { TaskBoard } from './tasks.js';

export type TaskSnapshot = Awaited<ReturnType<TaskBoard['snapshot']>>;
export type WorkerSnapshot = Awaited<ReturnType<Agents['snapshot']>>;
type Task = TaskSnapshot['tasks'][number];
/** A ready prompt whose output has not changed for this long is a worker waiting on a person, not one ready to dispatch. Matches the watch default `attentionMs`. */
export const stalledAtPromptMs = 120000;
export const categories = [
  'needs_decision',
  'awaiting_verification',
  'ready_to_dispatch',
  'waiting_on_dependencies',
  'in_progress',
] as const;
export type Category = (typeof categories)[number];
export interface WorkerStatus {
  agentId: string;
  name: string | null;
  paneId: number | null;
  availability: 'attached' | 'detached' | 'missing' | 'unknown';
  status: string | null;
  observedAt: string | null;
  observationAgeMs: number | null;
  outputInactiveMs: number | null;
  bindingRevision: string | null;
  outputHash: string | null;
  turnId: string | null;
  attempt: { taskId: string; attemptId: string } | null;
  inputRequired: boolean | null;
  inputRequest: { id: string; kind: string; state: string; turnId: string | null } | null;
  readyForPrompt: boolean | null;
  deliveryPending: boolean | null;
  uncertainty: string[];
}
export interface AttentionEntry {
  kind: 'task' | 'worker';
  id: string;
  boardId: string | null;
  title: string;
  revision: number | null;
  priority: Task['priority'];
  createdAt: string;
  status: string;
  categories: Category[];
  reasons: string[];
  nextActions: string[];
  assignedAgentId: string | null;
  worker: WorkerStatus | null;
  workerContext: 'matching_attempt' | 'assignment_only' | 'none';
  currentAttemptId: string | null;
  report: Pick<NonNullable<Task['latestReport']>, 'id' | 'outcome' | 'workVersion'> | null;
  verificationStatus: string | null;
  blockerCount: number;
  unresolvedDependencyIds: string[];
  dispatchConstraints: string[];
}

export function workerStatus(worker: WorkerSnapshot[number], now: number): WorkerStatus {
  const observed = 'observationId' in worker ? worker : null;
  return {
    agentId: worker.agentId,
    name: worker.name,
    paneId: worker.paneId,
    availability: observed
      ? 'attached'
      : 'attachment' in worker && worker.attachment === 'detached'
        ? 'detached'
        : 'unknown',
    status: observed?.status ?? null,
    observedAt: observed?.observedAt ?? null,
    observationAgeMs: observed ? Math.max(0, now - Date.parse(observed.observedAt)) : null,
    outputInactiveMs: observed ? Math.max(0, now - observed.lastOutputAt) : null,
    bindingRevision: observed?.bindingRevision ?? null,
    outputHash: observed?.outputHash ?? null,
    turnId: worker.turnId,
    attempt: observed?.attempt ?? null,
    inputRequired: observed?.inputRequired ?? null,
    inputRequest: observed?.inputRequest
      ? {
          id: observed.inputRequest.id,
          kind: observed.inputRequest.kind,
          state: observed.inputRequest.state,
          turnId: observed.inputRequest.turnId,
        }
      : null,
    readyForPrompt: observed?.readyForPrompt ?? null,
    deliveryPending: worker.deliveryPending,
    uncertainty: [
      ...(observed ? ['heuristic_classification'] : ['observation_unavailable']),
      ...('error' in worker ? ['observation_failed'] : []),
      ...(!observed && 'attachment' in worker && worker.attachment === 'detached' ? ['worker_detached'] : []),
      ...(worker.deliveryPending ? ['delivery_uncertain'] : []),
      ...(observed?.status === 'UNKNOWN' ? ['unknown_state'] : []),
      ...(observed?.inputRequest?.state === 'uncertain' ? ['input_request_uncertain'] : []),
    ],
  };
}
function unavailableWorker(agentId: string, available: boolean): WorkerStatus {
  return {
    agentId,
    name: null,
    paneId: null,
    availability: available ? 'missing' : 'unknown',
    status: null,
    observedAt: null,
    observationAgeMs: null,
    outputInactiveMs: null,
    bindingRevision: null,
    outputHash: null,
    turnId: null,
    attempt: null,
    inputRequired: null,
    inputRequest: null,
    readyForPrompt: null,
    deliveryPending: null,
    uncertainty: [available ? 'worker_missing' : 'worker_source_unavailable'],
  };
}
function workerReasons(worker: WorkerStatus): string[] {
  return [
    ...(worker.availability !== 'attached' ? [`worker_${worker.availability}`] : []),
    ...(worker.inputRequired ? [`input_${worker.inputRequest?.kind ?? 'required'}`] : []),
    ...(worker.readyForPrompt && worker.outputInactiveMs !== null && worker.outputInactiveMs >= stalledAtPromptMs
      ? ['worker_stalled_at_prompt']
      : []),
    ...(worker.inputRequest?.state === 'uncertain' ? ['input_request_uncertain'] : []),
    ...(worker.deliveryPending ? ['delivery_uncertain'] : []),
    ...(worker.status === 'UNKNOWN' ? ['worker_state_unknown'] : []),
    ...(worker.status === 'ERROR' ? ['worker_error'] : []),
  ];
}
function actions(reasons: string[]): string[] {
  return [
    ...new Set(
      reasons.map((reason) => {
        if (reason === 'unassigned') return 'assign_worker';
        if (reason === 'explicit_blockers') return 'resolve_blockers';
        if (reason === 'verification_passed') return 'complete_task';
        if (reason === 'report_needs_verification') return 'verify_report';
        if (reason.startsWith('report_') || reason.startsWith('verification_')) return 'review_result';
        if (reason === 'ready_without_report' || reason === 'worker_stalled_at_prompt')
          return 'inspect_worker_and_record_result';
        if (reason.startsWith('input_')) return 'inspect_input_request';
        return 'inspect_worker';
      }),
    ),
  ];
}
export function projectAttention(
  tasks: TaskSnapshot | null,
  workers: WorkerStatus[] | null,
  boardId?: string,
): AttentionEntry[] {
  const byWorker = new Map(workers?.map((w) => [w.agentId, w]));
  const active = (tasks?.tasks ?? []).filter((t) => !t.archived && t.status !== 'done' && t.status !== 'cancelled');
  const entries: AttentionEntry[] = active
    .filter((t) => boardId === undefined || t.boardId === boardId)
    .map((task) => {
      const worker = task.assignedAgentId
        ? (byWorker.get(task.assignedAgentId) ?? unavailableWorker(task.assignedAgentId, workers !== null))
        : null;
      const matches =
        !!worker?.attempt && worker.attempt.taskId === task.id && worker.attempt.attemptId === task.currentAttemptId;
      const context = worker ? (matches ? 'matching_attempt' : 'assignment_only') : 'none';
      // Assignment-level observations are context, never evidence that this task's turn completed.
      const reasons = [
        ...(task.blockers.length ? ['explicit_blockers'] : []),
        ...(!worker ? ['unassigned'] : workerReasons(worker)),
        ...(task.latestReport && task.latestReport.outcome !== 'succeeded'
          ? [`report_${task.latestReport.outcome}`]
          : []),
        ...(['failed', 'inconclusive', 'passed'].includes(task.verification.status)
          ? [`verification_${task.verification.status}`]
          : []),
        ...(matches &&
        task.status === 'in_progress' &&
        !task.latestReport &&
        worker?.readyForPrompt &&
        !worker.deliveryPending
          ? ['ready_without_report']
          : []),
      ];
      const groups: Category[] = reasons.length ? ['needs_decision'] : [];
      if (task.latestReport?.outcome === 'succeeded' && ['unverified', 'stale'].includes(task.verification.status)) {
        groups.push('awaiting_verification');
        reasons.push('report_needs_verification');
      }
      if (task.ready) groups.push('ready_to_dispatch');
      if (task.unresolvedDependencyIds.length) groups.push('waiting_on_dependencies');
      if (task.status === 'in_progress') groups.push('in_progress');
      // An idle worker is the ideal dispatch target: its stall needs a decision but never blocks dispatch.
      const constraints = [
        ...(!worker ? ['unassigned'] : workerReasons(worker).filter((r) => r !== 'worker_stalled_at_prompt')),
        ...(worker && !worker.readyForPrompt ? ['worker_not_ready'] : []),
        ...(worker &&
        active.some((t) => t.id !== task.id && t.assignedAgentId === worker.agentId && t.status === 'in_progress')
          ? ['worker_has_active_task']
          : []),
      ];
      return {
        kind: 'task',
        id: task.id,
        boardId: task.boardId,
        title: task.title,
        revision: task.revision,
        priority: task.priority,
        createdAt: task.createdAt,
        status: task.status,
        categories: groups,
        reasons,
        nextActions: actions(reasons),
        assignedAgentId: task.assignedAgentId,
        worker: worker
          ? { ...worker, uncertainty: [...worker.uncertainty, ...(!matches ? ['task_turn_unconfirmed'] : [])] }
          : null,
        workerContext: context,
        currentAttemptId: task.currentAttemptId,
        report: task.latestReport
          ? { id: task.latestReport.id, outcome: task.latestReport.outcome, workVersion: task.latestReport.workVersion }
          : null,
        verificationStatus: task.verification.status,
        blockerCount: task.blockers.length,
        unresolvedDependencyIds: task.unresolvedDependencyIds,
        dispatchConstraints: constraints,
      };
    });
  // Workers do not own boards; only unfiltered views include worker-only attention.
  if (boardId === undefined)
    for (const worker of workers ?? []) {
      if (active.some((t) => t.assignedAgentId === worker.agentId)) continue;
      const reasons = workerReasons(worker);
      if (!reasons.length) continue;
      entries.push({
        kind: 'worker',
        id: worker.agentId,
        boardId: null,
        title: worker.name ?? worker.agentId,
        revision: null,
        priority: 'normal',
        createdAt: '',
        status: worker.status ?? worker.availability,
        categories: ['needs_decision'],
        reasons,
        nextActions: actions(reasons),
        assignedAgentId: worker.agentId,
        worker: tasks ? worker : { ...worker, uncertainty: [...worker.uncertainty, 'task_source_unavailable'] },
        workerContext: 'none',
        currentAttemptId: null,
        report: null,
        verificationStatus: null,
        blockerCount: 0,
        unresolvedDependencyIds: [],
        dispatchConstraints: [],
      });
    }
  const priorities = { urgent: 0, high: 1, normal: 2, low: 3 };
  const rank = (e: AttentionEntry) => Math.min(...e.categories.map((c) => categories.indexOf(c)));
  return entries.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      priorities[a.priority] - priorities[b.priority] ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
}
