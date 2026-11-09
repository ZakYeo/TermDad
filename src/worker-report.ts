import { z } from 'zod';
import { notifyCommand } from './worker-hooks.js';
import { shellWord } from './hook-config.js';

export const workerReportSchema = z
  .object({
    turnId: z.uuid(),
    state: z.enum(['parked_background', 'awaiting_parent', 'done']),
    summary: z.string().trim().min(1).max(800),
    references: z.array(z.string().min(1).max(200)).max(8).default([]),
    checks: z.array(z.string().min(1).max(100)).max(8).default([]),
  })
  .strict();
export type WorkerReport = z.infer<typeof workerReportSchema>;
export function reportInstructions(credential: string, turnId: string) {
  const command = [...notifyCommand(), '--credential', credential, '--report'].map(shellWord).join(' ');
  return `\n\nTerm Dad reporting for this turn (${turnId}): use ${command} '<JSON>' with {"turnId":"${turnId}","state":"parked_background|awaiting_parent|done","summary":"brief explanation","references":[],"checks":[]}. Shell-quote the JSON safely. Report background waits, parent decisions and completion; a report is a claim, never verification. If unavailable, report normally in the terminal. Do not print credentials.\n`;
}
