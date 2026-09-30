import { z } from 'zod';
import { CodedError } from './errors.js';

/**
 * Tool arguments the supervisor kept spelling two ways. Accept every spelling, insist on one
 * value, and name the canonical field in the error so the schema teaches itself.
 */
export function oneOf<T>(args: Record<string, unknown>, names: readonly string[], fallback?: T): T {
  const supplied = names.filter((n) => args[n] !== undefined);
  if (supplied.length === 0) {
    if (fallback !== undefined) return fallback;
    throw new CodedError(
      'ARGUMENT_MISSING',
      `provide ${names[0]}${names.length > 1 ? ` (alias ${names.slice(1).join(', ')})` : ''}`,
    );
  }
  const values = new Set(supplied.map((n) => JSON.stringify(args[n])));
  if (values.size > 1)
    throw new CodedError('ARGUMENT_CONFLICT', `${supplied.join(' and ')} disagree; supply one of them`);
  return args[supplied[0]] as T;
}

const milliseconds = z.number().int().min(1).max(120000);
export const waitShape = {
  timeoutMs: milliseconds.optional().describe('Wait budget in milliseconds (default 30000, maximum 120000).'),
  timeoutSeconds: z
    .number()
    .positive()
    .max(120)
    .optional()
    .describe('Alias for timeoutMs in seconds; must convert to whole milliseconds.'),
};
export function waitTimeout(a: { timeoutMs?: number; timeoutSeconds?: number }) {
  return milliseconds.parse(
    oneOf<number>(
      {
        timeoutMs: a.timeoutMs,
        timeoutSeconds: a.timeoutSeconds === undefined ? undefined : milliseconds.parse(a.timeoutSeconds * 1000),
      },
      ['timeoutMs', 'timeoutSeconds'],
      30000,
    ),
  );
}
