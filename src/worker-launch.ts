import { z } from 'zod';
import { CodedError } from './errors.js';
import { spawnArguments, type SpawnOptions } from './backend.js';

const literal = z
  .string()
  .max(8192)
  .refine((s) => !s.includes('\0'), 'NUL is not allowed');
export const workerLaunchSchema = z.object({
  supervision: z.enum(['hooks', 'polling']).optional(),
  args: z.array(literal).max(64).optional(),
  env: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), literal)
    .refine(
      (env) => Object.keys(env).length <= 64 && JSON.stringify(env).length <= 32768,
      'environment exceeds 64 entries or 32768 characters',
    )
    .optional(),
});
export type WorkerLaunchOptions = z.infer<typeof workerLaunchSchema>;
export function workerLaunch(o: SpawnOptions & WorkerLaunchOptions & { cli: 'claude' | 'codex' | 'shell' }) {
  try {
    const extra = workerLaunchSchema.parse(o);
    if (o.command !== undefined && (extra.args !== undefined || extra.env !== undefined))
      throw new Error('args and env cannot be combined with a custom command');
    const configured = process.env[`TERM_DAD_${o.cli.toUpperCase()}_COMMAND`];
    const launch = spawnArguments({
      ...o,
      command: o.command ?? (configured ? JSON.parse(configured) : o.cli === 'shell' ? undefined : [o.cli]),
    });
    if ((extra.args || extra.env) && !launch.command) throw new Error('args and env require a managed CLI command');
    if (extra.args) launch.command = [...launch.command!, ...extra.args];
    return { launch, extra };
  } catch (e) {
    throw new CodedError('WORKER_CONFIGURATION', e instanceof Error ? e.message : String(e));
  }
}
/** env receives literal assignments and argv, never shell source. Apply after hook validation. */
export function launchEnvironment(command: string[] | undefined, env?: Record<string, string>) {
  return env && Object.keys(env).length
    ? ['env', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), ...command!]
    : command;
}
