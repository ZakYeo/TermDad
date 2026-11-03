import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pane } from './backend.js';
import { boundedMap } from './bounded-map.js';

export type WorkspaceContext = {
  status: 'available' | 'unavailable' | 'not_repository';
  source: 'local_git';
  observedAt: string;
  repositoryRoot?: string;
  gitCommonDir?: string;
  worktreePath?: string;
  branch?: string | null;
  commit?: string | null;
  note?: string;
};
export type GitRunner = (args: string[]) => Promise<string>;
const git: GitRunner = (args) =>
  new Promise((resolve, reject) => {
    // Repository discovery must not inherit overrides directing Git at another repository.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    execFile(
      'git',
      args,
      {
        timeout: 5000,
        maxBuffer: 65536,
        windowsHide: true,
        env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
export interface WorkspaceInspector {
  inspect(pane: Pane): Promise<WorkspaceContext>;
}
export class LocalWorkspaceInspector implements WorkspaceInspector {
  constructor(
    private readonly run: GitRunner = git,
    private readonly host = hostname(),
    private readonly distro = process.env.WSL_DISTRO_NAME,
  ) {}
  async inspect(pane: Pane): Promise<WorkspaceContext> {
    const base = { source: 'local_git' as const, observedAt: new Date().toISOString() };
    const unavailable = (note: string): WorkspaceContext => ({ ...base, status: 'unavailable', note });
    let cwd: string;
    try {
      const url = new URL(pane.cwd);
      if (url.protocol !== 'file:' || url.hostname.toLowerCase() !== this.host.toLowerCase())
        return unavailable(
          'Working directory is not verified on the MCP host; target-domain Git inspection is unavailable.',
        );
      if (this.distro && pane.domain_name !== `WSL:${this.distro}`)
        return unavailable('WSL working-directory domain is unverified; no local Git command was run.');
      if (
        pane.domain_name !== undefined &&
        pane.domain_name !== 'local' &&
        pane.domain_name !== 'Local' &&
        !(this.distro && pane.domain_name === `WSL:${this.distro}`)
      )
        return unavailable('Terminal domain is not positively identified as local; no local Git command was run.');
      url.hostname = '';
      cwd = fileURLToPath(url);
      if (process.platform !== 'win32' && /^\/[a-z]:/i.test(cwd))
        return unavailable('Windows path requires a Windows-domain inspector.');
    } catch {
      return unavailable('Working directory lacks a verified local file URI; Git inspection was skipped.');
    }
    const command = (...args: string[]) => this.run(['-C', cwd, '-c', 'core.fsmonitor=false', ...args]);
    try {
      let roots: string;
      try {
        roots = await command('rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir');
      } catch (error) {
        const e = error as NodeJS.ErrnoException & { stderr?: string };
        if (e.code === 'ENOENT')
          return unavailable('Git executable is unavailable; install Git separately to enable optional inspection.');
        if (/not a git repository/i.test(e.stderr ?? e.message))
          return { ...base, status: 'not_repository', note: 'Observed directory is not a Git worktree.' };
        throw error;
      }
      const paths = roots.replace(/\r?\n$/, '').split(/\r?\n/);
      if (paths.length !== 2 || paths.some((path) => !isAbsolute(path) || path.includes('\0')))
        return unavailable('Git returned unsupported or ambiguous workspace metadata.');
      const [worktreePath, common] = paths;
      let branch: string | null = null,
        commit: string | null = null;
      try {
        branch = (await command('symbolic-ref', '--quiet', '--short', 'HEAD')).trim() || null;
      } catch (error) {
        if (Number((error as { code?: unknown }).code) !== 1) throw error;
      }
      try {
        commit = (await command('rev-parse', '--verify', 'HEAD')).trim() || null;
      } catch (error) {
        if (Number((error as { code?: unknown }).code) !== 128) throw error;
      }
      return {
        ...base,
        status: 'available',
        // A directory called .git elsewhere does not establish its parent as a worktree.
        ...(resolve(common) === resolve(worktreePath, '.git') ? { repositoryRoot: worktreePath } : {}),
        gitCommonDir: common,
        worktreePath,
        branch,
        commit,
        note: 'Observed directory state, not a declared worker assignment.',
      };
    } catch {
      return unavailable(
        'Git inspection failed or timed out; check local Git availability, permissions and supported version. Listing remains available.',
      );
    }
  }
}
export async function workspaceContexts(panes: Pane[], inspector: WorkspaceInspector = new LocalWorkspaceInspector()) {
  const groups = new Map<string, Pane[]>();
  for (const pane of panes) {
    const key = JSON.stringify([pane.cwd, pane.domain_name ?? null]);
    const group = groups.get(key) ?? [];
    group.push(pane);
    groups.set(key, group);
  }
  const contexts: Record<number, WorkspaceContext> = {};
  await boundedMap([...groups.values()], 4, async (group) => {
    let context: WorkspaceContext;
    try {
      context = await inspector.inspect(group[0]);
    } catch {
      context = {
        status: 'unavailable',
        source: 'local_git',
        observedAt: new Date().toISOString(),
        note: 'Workspace inspection unavailable; listing remains available.',
      };
    }
    for (const pane of group) contexts[pane.pane_id] = context;
  });
  return contexts;
}
