import { z } from 'zod';

const text = z.string().trim().min(1).max(4000);
const reference = z.string().trim().min(1).max(2000);
const identity = { taskId: z.uuid(), expectedRevision: z.number().int().positive().safe() };
export const attemptReferenceSchema = z.object({ taskId: z.uuid(), attemptId: z.uuid() }).strict();
const provenance = z.enum(['worker_reported', 'supervisor_recorded']);
export const artifactSchema = z
  .object({ kind: z.enum(['file', 'commit', 'pull_request', 'other']), reference, context: reference })
  .strict();
export const checkSchema = z
  .object({
    id: z.string().min(1).max(100),
    criterionIds: z.array(z.string().min(1).max(100)).max(50),
    execution: text,
    context: reference,
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    result: z.enum(['passed', 'failed', 'skipped']),
    exitCode: z.number().int().nullable(),
    evidence: z.array(reference).max(50),
    provenance,
  })
  .strict()
  .refine(
    (c) => c.startedAt === null || c.finishedAt === null || Date.parse(c.finishedAt) >= Date.parse(c.startedAt),
    'Check timestamps out of order',
  )
  .refine(
    (c) => c.result !== 'passed' || c.exitCode === null || c.exitCode === 0,
    'Passing check cannot have nonzero exit code',
  );
export const reportFields = {
  outcome: z.enum(['succeeded', 'failed', 'blocked', 'cancelled']),
  summary: text,
  workVersion: reference,
  provenance,
  artifacts: z.array(artifactSchema).max(50),
  checks: z.array(checkSchema).max(50),
};
export const reportSchema = z.object({ ...reportFields, id: z.uuid(), createdAt: z.iso.datetime() }).strict();
export const decisionSchema = z
  .object({
    criterionId: z.string().min(1).max(100),
    result: z.enum(['passed', 'failed', 'inconclusive']),
    evidence: z.array(reference).min(1).max(50),
  })
  .strict();
export const verificationFields = {
  reportId: z.uuid(),
  workVersion: reference,
  result: z.enum(['passed', 'failed', 'inconclusive']),
  rationale: text,
  criteria: z.array(decisionSchema).max(50),
};
export const verificationSchema = z
  .object({ ...verificationFields, id: z.uuid(), createdAt: z.iso.datetime() })
  .strict();
export const attemptSchema = z
  .object({
    id: z.uuid(),
    agentId: z.uuid(),
    startedAt: z.iso.datetime(),
    specification: z
      .object({
        goal: z.string().max(8000),
        acceptanceCriteria: z
          .array(z.object({ id: z.string().max(100), description: z.string().max(2000) }).strict())
          .max(50),
        dependencies: z.array(z.uuid()).max(100),
      })
      .strict(),
    reports: z.array(reportSchema).max(20),
    verifications: z.array(verificationSchema).max(20),
  })
  .strict();
export type Attempt = z.infer<typeof attemptSchema>;
export const completionFields = {
  attempts: z.array(attemptSchema).max(20),
  currentAttemptId: z.uuid().nullable(),
  legacyCompletion: z.boolean(),
};
export const startAttemptSchema = z.object(identity).strict();
export const reportResultSchema = z.object({ ...identity, attemptId: z.uuid(), ...reportFields }).strict();
export const verifyTaskSchema = z
  .object({ ...identity, attemptId: z.uuid(), ...verificationFields, complete: z.boolean().default(false) })
  .strict();
export const taskHistorySchema = z
  .object({
    taskId: z.uuid(),
    offset: z.number().int().min(0).max(20).default(0),
    limit: z.number().int().min(1).max(20).default(5),
  })
  .strict();

export function completionView(task: {
  attempts: Attempt[];
  currentAttemptId: string | null;
  legacyCompletion: boolean;
}) {
  const attempt = task.attempts.find((a) => a.id === task.currentAttemptId),
    report = attempt?.reports.at(-1),
    verification = attempt?.verifications.at(-1);
  const valid = verification && verification.reportId === report?.id;
  const hasHistory = task.attempts.some((a) => a.verifications.length);
  return {
    currentAttempt: attempt ? { id: attempt.id, agentId: attempt.agentId, startedAt: attempt.startedAt } : null,
    latestReport: report
      ? { id: report.id, outcome: report.outcome, summary: report.summary, workVersion: report.workVersion }
      : null,
    verification: valid
      ? {
          status: verification.result,
          id: verification.id,
          reportId: verification.reportId,
          workVersion: verification.workVersion,
        }
      : { status: task.legacyCompletion ? 'legacy_unverified' : hasHistory ? 'stale' : 'unverified' },
  };
}
