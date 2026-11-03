import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalWorkspaceInspector, workspaceContexts } from '../src/workspace-context.js';
const pane = {
  pane_id: 1,
  tab_id: 1,
  window_id: 1,
  title: '',
  cwd: 'file://testhost/work/project',
  size: { rows: 1, cols: 1 },
};
test('Git inspection reports worktree, main repository, detached/unborn state and literal argv', async () => {
  const calls: string[][] = [];
  const inspector = new LocalWorkspaceInspector(
    async (args) => {
      calls.push(args);
      if (args.includes('--show-toplevel')) return '/work/project\n/work/main/.git\n';
      if (args.includes('symbolic-ref')) throw Object.assign(new Error('detached'), { code: 1 });
      return 'abc123\n';
    },
    'testhost',
    '',
  );
  const result = await inspector.inspect(pane);
  assert.equal(result.status, 'available');
  assert.equal(result.repositoryRoot, '/work/main');
  assert.equal(result.worktreePath, '/work/project');
  assert.equal(result.branch, null);
  assert.equal(result.commit, 'abc123');
  assert.deepEqual(calls[0].slice(0, 4), ['-C', '/work/project', '-c', 'core.fsmonitor=false']);
});
test('unverified/remote/other WSL domains never launch Git', async () => {
  let calls = 0;
  const inspector = new LocalWorkspaceInspector(
    async () => {
      calls++;
      return '';
    },
    'testhost',
    'Ubuntu',
  );
  for (const p of [
    { ...pane },
    { ...pane, domain_name: 'WSL:Other' },
    { ...pane, cwd: 'file://remote/work' },
    { ...pane, cwd: '/work/project' },
  ])
    assert.equal((await inspector.inspect(p)).status, 'unavailable');
  assert.equal(calls, 0);
});
test('missing Git, non-repository and permission failures are explicit optional outcomes', async () => {
  for (const [error, expected] of [
    [Object.assign(new Error('missing'), { code: 'ENOENT' }), 'unavailable'],
    [new Error('fatal: not a git repository'), 'not_repository'],
    [new Error('permission denied'), 'unavailable'],
    [new Error('timed out'), 'unavailable'],
  ] as const) {
    const result = await new LocalWorkspaceInspector(
      async () => {
        throw error;
      },
      'testhost',
      '',
    ).inspect(pane);
    assert.equal(result.status, expected);
    assert.ok(result.note);
  }
});
test('workspace inspection deduplicates directories, bounds concurrency and isolates failures', async () => {
  let calls = 0,
    active = 0,
    peak = 0;
  const panes = Array.from({ length: 12 }, (_, i) => ({ ...pane, pane_id: i, cwd: `file://testhost/work/${i % 6}` }));
  const contexts = await workspaceContexts(panes, {
    inspect: async () => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      throw new Error('not available');
    },
  });
  assert.equal(calls, 6);
  assert.equal(peak, 4);
  assert.equal(Object.keys(contexts).length, 12);
  assert.equal(contexts[0], contexts[6]);
  assert.equal(contexts[0].status, 'unavailable');
});

test('custom domains sharing the hostname are unavailable and separate git dirs are not repository roots', async () => {
  let calls = 0;
  const inspector = new LocalWorkspaceInspector(
    async (args) => {
      calls++;
      if (args.includes('--show-toplevel')) return '/work/project\n/storage/git-metadata\n';
      return args.includes('symbolic-ref') ? 'feature\n' : 'abc123\n';
    },
    'testhost',
    '',
  );
  assert.equal((await inspector.inspect({ ...pane, domain_name: 'production-container' })).status, 'unavailable');
  assert.equal(calls, 0);
  const result = await inspector.inspect(pane);
  assert.equal(result.repositoryRoot, undefined);
  assert.equal(result.gitCommonDir, '/storage/git-metadata');
  assert.equal(result.worktreePath, '/work/project');
});
