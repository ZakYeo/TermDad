import { open, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { ticketDefinitions, type DemoRun } from './runtime.js';

export function demoOptions(args: string[]) {
  if (!args.length) return { mode: 'launch' as const };
  if (args.length === 1 && args[0] === '--check') return { mode: 'check' as const };
  if (args.length === 1 && args[0] === '--prepare') return { mode: 'prepare' as const };
  if (args.length === 2 && args[0] === '--prepared' && args[1]) return { mode: 'launch' as const, directory: args[1] };
  throw new Error('Usage: npm run demo [-- --check | --prepare | --prepared <directory>]');
}

export async function loadPrepared(directory: string, allowUsed = false): Promise<DemoRun> {
  const path = await realpath(directory);
  const run: DemoRun = JSON.parse(await readFile(join(path, 'run.json'), 'utf8'));
  if (
    run.directory !== path ||
    run.repository !== join(path, 'release') ||
    run.before !== join(path, 'before') ||
    run.state !== join(path, 'state') ||
    !/^[a-f0-9]{40}$/.test(run.base) ||
    !Array.isArray(run.panes) ||
    (!allowUsed && run.panes.length > 0) ||
    !Array.isArray(run.tickets) ||
    run.tickets.length !== ticketDefinitions.length
  )
    throw new Error('Invalid or already used demo directory; prepare a fresh run.');
  for (const [index, expected] of ticketDefinitions.entries()) {
    const ticket = run.tickets[index];
    if (
      ticket.id !== expected.id ||
      ticket.file !== expected.file ||
      ticket.title !== expected.title ||
      (!allowUsed && !!ticket.taskId) ||
      ticket.worktree !== join(path, expected.id)
    )
      throw new Error('Invalid or already used demo tickets; prepare a fresh run.');
  }
  for (const child of [run.repository, run.before, run.state, ...run.tickets.map((t) => t.worktree)]) {
    if ((await realpath(child)) !== child)
      throw new Error('Prepared demo paths must not redirect outside their directory.');
  }
  return run;
}

/** Prevent two launchers from dispatching the same prepared run; retain the marker on failure. */
export async function claimPrepared(run: DemoRun) {
  const lock = await open(join(run.directory, 'launched'), 'wx', 0o600).catch((error) => {
    if (error.code === 'EEXIST')
      throw new Error('This demo has already been opened. Prepare a fresh run with npm run demo -- --prepare.');
    throw error;
  });
  await lock.close();
}
