import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { manageHooks } from '../src/hook-install.js';
import { parseUsageHookArgs } from '../src/usage-hook-cli.js';
import { FileUsageStorage } from '../src/usage-storage.js';
import { UsageService } from '../src/usage.js';
import { hookConfiguration } from '../src/hook-config.js';

test('installer preserves unrelated hooks and status line; repeat install and uninstall are safe', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'term dad hooks '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'settings.json');
  const original = {
    theme: 'dark',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-hook' }] }] },
    statusLine: { type: 'command', command: 'printf original' },
  };
  await writeFile(path, JSON.stringify(original));
  const options = {
    client: 'claude' as const,
    accountRef: 'personal',
    stateDir: dir,
    entry: "/a path/with quotes'/index.js",
    runtime: process.execPath,
  };
  const preview = await manageHooks('preview', path, options);
  assert.equal((preview as any).wrapsExistingStatusline, true);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), original);
  assert.equal(((await manageHooks('install', path, options)) as any).changed, true);
  const installed = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(installed.hooks.Stop.length, 2);
  assert.equal(installed.theme, 'dark');
  assert.ok(installed.statusLine.command.includes('--renderer-file'));
  assert.equal(((await manageHooks('install', path, options)) as any).changed, false);
  assert.deepEqual(((await manageHooks('doctor', path, options)) as any).missing, []);
  await manageHooks('uninstall', path, options);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), original);
});

test('manual hook edits survive uninstall and are reported by doctor', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'term-dad-hook-edit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'hooks.json');
  const options = {
    client: 'codex' as const,
    accountRef: 'p',
    stateDir: dir,
    entry: '/term-dad/index.js',
    runtime: process.execPath,
  };
  await manageHooks('install', path, options);
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.hooks.Stop[0].hooks[0].command = 'my-edited-command';
  await writeFile(path, JSON.stringify(config));
  assert.ok(((await manageHooks('doctor', path, options)) as any).missing.includes('Stop'));
  await manageHooks('uninstall', path, options);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).hooks.Stop[0].hooks[0].command, 'my-edited-command');
});

test('client templates use bounded helpers and argv for Copilot; parser rejects malformed options', () => {
  for (const client of ['claude', 'codex', 'copilot'] as const) {
    const template = hookConfiguration({
      client,
      accountRef: 'a',
      stateDir: '/state',
      entry: '/repo/dist/index.js',
      runtime: '/node',
    });
    assert.ok(template.hooks);
    assert.ok(!JSON.stringify(template).includes('asyncRewake'), 'unverified wake must not be installed');
    if (client === 'copilot') assert.equal(template.hooks!.postToolUse[0].exec, '/node');
  }
  assert.throws(() => parseUsageHookArgs(['--account', 'a', '--client', 'codex', '--statusline']));
  assert.throws(() => parseUsageHookArgs(['--account', 'a', '--client', 'codex', '--garbage', 'x']));
});

test('built helper forwards quota metadata, preserves renderer output and does not log prompt text', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'term-dad-hook-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const usage = new UsageService(new FileUsageStorage(dir));
  await usage.configure({ accountRef: 'p', provider: 'claude' });
  const renderer = join(dir, 'renderer.json');
  await writeFile(renderer, JSON.stringify({ command: 'printf "existing status"' }), { mode: 0o600 });
  const payload = {
    session_id: 'test',
    prompt: 'PRIVATE_PROMPT',
    rate_limits: {
      five_hour: { used_percentage: 82, resets_at: Math.floor(Date.now() / 1000) + 18000 },
    },
  };
  const child = execFile(process.execPath, [
    'dist/index.js',
    'usage-hook',
    '--client',
    'claude',
    '--account',
    'p',
    '--state-dir',
    dir,
    '--statusline',
    '--renderer-file',
    renderer,
  ]);
  const done = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = '',
      stderr = '';
    child.stdout!.on('data', (d) => {
      stdout += d;
    });
    child.stderr!.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr))));
  });
  child.stdin!.end(JSON.stringify(payload));
  const result = await done;
  assert.equal(result.stdout, 'existing status');
  assert.equal(result.stderr, '');
  assert.equal((await usage.status('p')).accounts[0].observation!.windows[0].usedPercent, 82);
  assert.ok(!(await readFile(join(dir, 'usage.json'), 'utf8')).includes('PRIVATE_PROMPT'));
  await usage.close();
});
