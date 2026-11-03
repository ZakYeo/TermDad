import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { command, integrate, prepareRun, readEvidence, releaseReady, type DemoRun } from '../demo/runtime.js';
import { demoEnvironment, preflight, supervisorArgs, workerCommand } from '../demo/launcher.js';
import { collectStatus, ticketState } from '../demo/status.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const implementations: Record<string, string> = {
  'SALES-101': `export default data => {
    const revenue=data.months.reduce((sum,month)=>sum+month.revenue,0);
    return [{label:'Revenue',value:revenue,format:'currency'},
      {label:'Customers',value:data.accounts.length,format:'number'},
      {label:'Growth',value:Math.round((revenue-data.previousRevenue)/data.previousRevenue*1000)/10,format:'percent'}];
  };`,
  'SALES-102': `export default data => data.months.map(({month,revenue})=>({month,revenue}));`,
  'SALES-103': `export default data => data.accounts.map(({name,revenue,daysSinceContact})=>({name,revenue,
    risk:daysSinceContact>=45?'High':daysSinceContact>=30?'Medium':'Low'})).sort((a,b)=>
    ['High','Medium','Low'].indexOf(a.risk)-['High','Medium','Low'].indexOf(b.risk)||a.name.localeCompare(b.name));`,
};
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const run = await prepareRun(root, 7, 'demo-instance', '/tmp/demo-socket');
  t.after(() => rm(run.directory, { recursive: true, force: true }));
  return run;
}
async function finish(run: DemoRun, id: string, source = implementations[id]) {
  const ticket = run.tickets.find((item) => item.id === id)!;
  await writeFile(join(ticket.worktree, ticket.file), source);
  await command('git', ['add', ticket.file], ticket.worktree);
  await command('git', ['commit', '-m', id], ticket.worktree);
  return command('git', ['rev-parse', 'HEAD'], ticket.worktree);
}

test('demo run uses an independent repository and pristine before snapshot', async (t) => {
  const run = await fixture(t);
  assert.equal(await command('git', ['rev-parse', '--absolute-git-dir'], run.repository), join(run.repository, '.git'));
  assert.equal(await command('git', ['branch', '--show-current'], run.repository), 'demo/release');
  assert.equal((await readEvidence(run))['SALES-101'], undefined);
  assert.equal(await releaseReady(run), false);
  for (const ticket of run.tickets) {
    assert.equal(await command('git', ['rev-parse', 'HEAD'], ticket.worktree), run.base);
    assert.equal(await command('git', ['branch', '--show-current'], ticket.worktree), ticket.id);
  }
  await finish(run, 'SALES-101');
  assert.match(await readFile(join(run.before, 'components/kpis.js'), 'utf8'), /return \[\]/);
  assert.equal(JSON.parse(await readFile(join(run.directory, 'run.json'), 'utf8')).state, run.state);
});

test('demo checks and merges all three actual commits before declaring release ready', async (t) => {
  const run = await fixture(t);
  for (const [index, ticket] of run.tickets.entries()) {
    const commit = await finish(run, ticket.id);
    const evidence = await integrate(run, ticket.id);
    assert.equal(evidence.commit, commit);
    assert.match(evidence.head, /^[a-f0-9]{40}$/);
    assert.ok(Number.isFinite(Date.parse(evidence.checkedAt)));
    assert.equal(await releaseReady(run), index === 2);
  }
  assert.equal(Object.keys(await readEvidence(run)).length, 3);
  for (const ticket of run.tickets) ticket.taskId = ticket.id;
  const actualReadyShape = {
    agentId: 'worker',
    status: 'READY_FOR_PROMPT',
    awaitingInput: true,
    inputRequired: false,
    readyForPrompt: true,
  };
  const ready = await collectStatus(run, async (name) =>
    name === 'task.list'
      ? {
          tasks: run.tickets.map((ticket) => ({
            id: ticket.id,
            status: 'done',
            blockers: [],
            assignedAgentId: 'worker',
            verification: { status: 'passed' },
            latestReport: { outcome: 'succeeded' },
          })),
        }
      : [actualReadyShape],
  );
  assert.equal(ready.released, true, 'Finished workers at normal ready prompts must allow the visual reveal');
  assert.ok(ready.tickets.every((ticket) => ticket.state === 'Merged'));

  await writeFile(join(run.repository, 'components/chart.js'), 'export default () => [];');
  assert.equal(await releaseReady(run), false, 'Dirty regression must revoke release readiness');
  await command('git', ['add', 'components/chart.js'], run.repository);
  await command('git', ['commit', '-m', 'Regression after integration'], run.repository);
  await assert.rejects(releaseReady(run), /check.mjs/);
});

test('demo refuses failed checks and changes outside assigned ownership without evidence', async (t) => {
  const run = await fixture(t);
  await finish(run, 'SALES-101', 'export default () => [{label:"Revenue",value:1,format:"currency"}];');
  await assert.rejects(integrate(run, 'SALES-101'), /check.mjs/);
  assert.deepEqual(await readEvidence(run), {});
  const ticket = run.tickets[1];
  await finish(run, ticket.id);
  await writeFile(join(ticket.worktree, 'unrelated.txt'), 'outside ownership');
  await command('git', ['add', 'unrelated.txt'], ticket.worktree);
  await command('git', ['commit', '-m', 'Unrelated edit'], ticket.worktree);
  await assert.rejects(integrate(run, ticket.id), /Worker may change only/);
  assert.deepEqual(await readEvidence(run), {});
  assert.equal(await releaseReady(run), false);
  assert.equal(await command('git', ['rev-parse', 'HEAD'], run.repository), run.base);
});

test('demo preserves merge conflict for inspection and never publishes successful evidence', async (t) => {
  const run = await fixture(t);
  await finish(run, 'SALES-101');
  await writeFile(join(run.repository, 'components/kpis.js'), 'export default () => [{label:"conflict"}];');
  await command('git', ['add', 'components/kpis.js'], run.repository);
  await command('git', ['commit', '-m', 'Conflicting release edit'], run.repository);
  await assert.rejects(integrate(run, 'SALES-101'), /merge/);
  assert.match(await command('git', ['status', '--porcelain'], run.repository), /UU components\/kpis.js/);
  assert.deepEqual(await readEvidence(run), {});
  assert.equal(await releaseReady(run), false);
});

test('demo preflight checks prerequisites without invoking interactive workers', async () => {
  const calls: { file: string; args: string[]; cwd: string }[] = [];
  const runner = async (file: string, args: string[], cwd: string) => {
    calls.push({ file, args, cwd });
    return '';
  };
  const backend = {
    instance: async () => ({ key: 'demo-instance', endpoint: '/tmp/demo-socket' }),
    list: async () => [{ pane_id: 7 }],
  } as unknown as Parameters<typeof preflight>[3];
  const env = { WEZTERM_PANE: '7', WEZTERM_UNIX_SOCKET: '/tmp/demo-socket' };
  assert.equal((await preflight('/tmp/path with spaces', env, runner, backend)).parentPane, 7);
  assert.deepEqual(
    calls.map(({ file, args }) => [file, ...args]),
    [
      ['git', '--version'],
      ['codex', '--version'],
      ['codex', 'login', 'status'],
    ],
  );
  assert.ok(calls.every(({ cwd }) => cwd === '/tmp/path with spaces'));
  await assert.rejects(preflight(root, { ...env, WEZTERM_UNIX_SOCKET: '/other' }, runner, backend), /does not match/);
  await assert.rejects(preflight(root, {}, runner, backend), /inside the intended WezTerm pane/);
  await assert.rejects(
    preflight(
      root,
      env,
      async () => {
        throw new Error('missing prerequisite');
      },
      backend,
    ),
    /missing prerequisite/,
  );
  await assert.rejects(
    preflight(root, env, runner, { ...backend, instance: async () => null } as typeof backend),
    /verified WezTerm/,
  );
  await assert.rejects(
    preflight(root, env, runner, { ...backend, list: async () => [] } as typeof backend),
    /invoking pane/,
  );
});

test('demo launch argv preserves literal paths and normal approval handling without global writes', () => {
  const run = {
    directory: '/tmp/demo space',
    state: '/tmp/demo space/state',
    endpoint: '/tmp/socket space',
  } as DemoRun;
  const prompt = 'Use literal `text` and $(not-a-command).';
  const args = supervisorArgs('/tmp/checkout space', run, prompt);
  assert.equal(args.at(-1), prompt);
  assert.equal(args[args.indexOf('--cd') + 1], run.directory);
  assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.equal(args[args.indexOf('--ask-for-approval') + 1], 'on-request');
  assert.ok(args.includes('mcp_servers.term-dad.command="/tmp/checkout space/scripts/launch-local"'));
  assert.ok(args.includes('mcp_servers.term-dad.env.TERM_DAD_STATE_DIR="/tmp/demo space/state"'));
  assert.ok(!args.some((arg) => /dangerously|mcp add|config.toml/.test(arg)));
  const original = process.env.TERM_DAD_STATE_DIR;
  assert.equal(demoEnvironment(run).TERM_DAD_STATE_DIR, run.state);
  assert.equal(process.env.TERM_DAD_STATE_DIR, original);
});

test('ticket states require actual merge plus passed verification and preserve attention precedence', () => {
  const queued = { id: 'task', status: 'todo', blockers: [], assignedAgentId: null };
  const active = { ...queued, status: 'in_progress', assignedAgentId: 'worker' };
  const worker = { agentId: 'worker', attachment: 'attached' };
  const done = {
    ...active,
    status: 'done',
    latestReport: { outcome: 'succeeded' },
    verification: { status: 'passed' },
  };
  assert.equal(ticketState(queued, undefined, false), 'Queued');
  assert.equal(ticketState(active, worker, false), 'Working');
  assert.equal(ticketState({ ...active, latestReport: { outcome: 'succeeded' } }, worker, false), 'Checking');
  assert.equal(ticketState(done, worker, false), 'Checking');
  assert.equal(ticketState(done, worker, true), 'Merged');
  assert.equal(
    ticketState(done, { ...worker, awaitingInput: true, inputRequired: false }, true),
    'Merged',
    'Ready prompt is not a permission or question',
  );
  for (const changed of [
    { inputRequired: true },
    { attachment: 'detached' },
    { deliveryPending: true },
    { error: 'unavailable' },
  ]) {
    assert.equal(ticketState(done, { ...worker, ...changed }, true), 'Needs attention');
  }
  assert.equal(ticketState(undefined, worker, false), 'Needs attention');
  assert.equal(ticketState(active, undefined, false), 'Needs attention');
  assert.equal(ticketState({ ...done, blockers: ['blocked'] }, worker, true), 'Needs attention');
  assert.equal(ticketState({ ...done, verification: { status: 'stale' } }, worker, true), 'Needs attention');
  assert.equal(ticketState({ ...done, latestReport: { outcome: 'failed' } }, worker, true), 'Needs attention');
});

test('worker launch resolves Codex through a login shell with literal argv', () => {
  assert.deepEqual(workerCommand('/tmp/shell path/zsh').slice(0, 5), [
    '/tmp/shell path/zsh',
    '-lic',
    'exec "$@"',
    'term-dad-demo-worker',
    'codex',
  ]);
  assert.deepEqual(workerCommand('/usr/bin/fish').slice(0, 4), ['/usr/bin/fish', '-lic', 'exec $argv', 'codex']);
  assert.throws(() => workerCommand('/bin/unknown'), /supported login shell/);
});
