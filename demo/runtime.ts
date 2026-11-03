import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
export async function command(file: string, args: string[], cwd: string) {
  const result = await exec(file, args, { cwd, timeout: 30000, maxBuffer: 256 * 1024 });
  return result.stdout.trim();
}
export const ticketDefinitions = [
  {
    id: 'SALES-101',
    title: 'Executive KPI cards',
    file: 'components/kpis.js',
    description:
      'Give leadership a quick view of total revenue, customer count, and growth compared with the previous period.',
  },
  {
    id: 'SALES-102',
    title: 'Monthly sales chart',
    file: 'components/chart.js',
    description: 'Show how sales change month by month so the board can spot momentum and changes in performance.',
  },
  {
    id: 'SALES-103',
    title: 'Accounts needing attention',
    file: 'components/accounts.js',
    description:
      'Highlight customers who need follow-up, with clear priority labels so the team knows where to act first.',
  },
];
export interface DemoRun {
  directory: string;
  repository: string;
  before: string;
  state: string;
  base: string;
  parentPane: number;
  instanceKey: string;
  endpoint: string;
  tickets: ((typeof ticketDefinitions)[number] & { worktree: string; taskId?: string; agentId?: string })[];
  panes: number[];
}
export async function saveRun(run: DemoRun) {
  await writeFile(join(run.directory, 'run.json.tmp'), JSON.stringify(run, null, 2));
  await rename(join(run.directory, 'run.json.tmp'), join(run.directory, 'run.json'));
}
export async function prepareRun(root: string, parentPane: number, instanceKey: string, endpoint: string) {
  const directory = await mkdtemp(join(tmpdir(), 'term-dad-demo-'));
  const run: DemoRun = {
    directory,
    repository: join(directory, 'release'),
    before: join(directory, 'before'),
    state: join(directory, 'state'),
    base: '',
    parentPane,
    instanceKey,
    endpoint,
    tickets: ticketDefinitions.map((t) => ({ ...t, worktree: join(directory, t.id) })),
    panes: [],
  };
  await mkdir(run.state, { mode: 0o700 });
  await cp(join(root, 'demo/fixture'), run.repository, { recursive: true });
  await cp(run.repository, run.before, { recursive: true });
  await command('git', ['init', '-b', 'demo/release'], run.repository);
  await command('git', ['config', 'user.name', 'TermDad Demo'], run.repository);
  await command('git', ['config', 'user.email', 'demo@example.invalid'], run.repository);
  await command('git', ['config', 'commit.gpgsign', 'false'], run.repository);
  await command('git', ['add', '.'], run.repository);
  await command('git', ['commit', '-m', 'Prepare board meeting dashboard'], run.repository);
  run.base = await command('git', ['rev-parse', 'HEAD'], run.repository);
  for (const ticket of run.tickets) {
    await command('git', ['worktree', 'add', '-b', ticket.id, ticket.worktree, run.base], run.repository);
  }
  await saveRun(run);
  return run;
}

export interface Evidence {
  commit: string;
  head: string;
  checkedAt: string;
}
export async function readEvidence(run: DemoRun): Promise<Record<string, Evidence>> {
  try {
    return JSON.parse(await readFile(join(run.directory, 'integration.json'), 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
}
// Invoked explicitly by Dad after a worker reports a committed result. Serial execution only.
export async function integrate(run: DemoRun, id: string) {
  const ticket = run.tickets.find((t) => t.id === id);
  if (!ticket) throw new Error('Unknown demo ticket');
  for (const cwd of [run.repository, ticket.worktree]) {
    if (await command('git', ['status', '--porcelain'], cwd))
      throw new Error('Commit or inspect dirty changes before integration');
  }
  const commit = await command('git', ['rev-parse', 'HEAD'], ticket.worktree);
  await command('git', ['merge-base', '--is-ancestor', run.base, commit], run.repository);
  const files = (await command('git', ['diff', '--name-only', run.base, commit], run.repository)).split('\n');
  if (files.length !== 1 || files[0] !== ticket.file) throw new Error(`Worker may change only ${ticket.file}`);
  await command(process.execPath, ['check.mjs', id], ticket.worktree);
  await command('git', ['merge', '--no-ff', '--no-edit', commit], run.repository);
  await command(process.execPath, ['check.mjs', id], run.repository);
  const evidence = await readEvidence(run);
  evidence[id] = {
    commit,
    head: await command('git', ['rev-parse', 'HEAD'], run.repository),
    checkedAt: new Date().toISOString(),
  };
  await writeFile(join(run.directory, 'integration.json.tmp'), JSON.stringify(evidence, null, 2));
  await rename(join(run.directory, 'integration.json.tmp'), join(run.directory, 'integration.json'));
  return evidence[id];
}
export async function releaseReady(run: DemoRun) {
  const evidence = await readEvidence(run);
  if (run.tickets.some((t) => !evidence[t.id])) return false;
  if (await command('git', ['status', '--porcelain'], run.repository)) return false;
  for (const ticket of run.tickets) {
    await command('git', ['merge-base', '--is-ancestor', evidence[ticket.id].commit, 'HEAD'], run.repository);
  }
  await command(process.execPath, ['check.mjs'], run.repository);
  return true;
}
