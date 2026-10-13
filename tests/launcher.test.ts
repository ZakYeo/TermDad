import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, copyFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execute } from '../src/backend.js';
import { pushHookArgv } from '../src/worker-hooks.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'term-dad-launcher-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const hostBin = join(directory, 'host'),
    workerBin = join(directory, 'tools with spaces $literal'),
    home = join(directory, 'home'),
    scripts = join(directory, 'scripts'),
    dist = join(directory, 'dist');
  await Promise.all([hostBin, workerBin, home, scripts, dist].map((path) => mkdir(path)));
  await copyFile(new URL('../scripts/launch-local', import.meta.url), join(scripts, 'launch-local'));
  await symlink(process.execPath, join(hostBin, 'node'));
  await symlink(process.execPath, join(workerBin, 'node'));
  await writeFile(
    join(dist, 'index.js'),
    'console.log(JSON.stringify([process.env.TERM_DAD_CLAUDE_COMMAND, process.env.TERM_DAD_CODEX_COMMAND]));\n',
  );
  const env = {
    ...process.env,
    HOME: home,
    ZDOTDIR: home,
    PATH: `${hostBin}:/usr/bin:/bin`,
    SHELL: '/bin/zsh',
    TERM_DAD_LOCAL_SHELL: '',
    TERM_DAD_CLAUDE_COMMAND: '',
    TERM_DAD_CODEX_COMMAND: '',
    TERM_DAD_TEST_BIN: workerBin,
    TERM_DAD_TEST_LOGIN: '',
    TERM_DAD_TEST_INTERACTIVE: '',
  };
  const runLauncher = (overrides: NodeJS.ProcessEnv = {}) =>
    promisify(execFile)('/bin/sh', [join(scripts, 'launch-local')], {
      env: { ...env, ...overrides },
      timeout: 15000,
    });
  const launch = async (overrides: NodeJS.ProcessEnv = {}) =>
    JSON.parse((await runLauncher(overrides)).stdout) as string[];
  return { directory, workerBin, home, env, launch, runLauncher };
}

test('local launcher selects the configured shell and preserves explicit command overrides', async (t) => {
  const f = await fixture(t);
  for (const shell of ['/bin/zsh', '/bin/bash', '/bin/sh', '/bin/dash', '/bin/ksh']) {
    const commands = (await f.launch({ TERM_DAD_LOCAL_SHELL: shell })).map((value) => JSON.parse(value));
    assert.deepEqual(commands, [
      [shell, '-lic', 'exec "$@"', 'term-dad-worker', 'claude'],
      [shell, '-lic', 'exec "$@"', 'term-dad-worker', 'codex'],
    ]);
  }
  assert.equal(JSON.parse((await f.launch())[0])[0], '/bin/zsh');
  assert.equal(JSON.parse((await f.launch({ SHELL: '' }))[0])[0], '/bin/sh');
  assert.deepEqual(JSON.parse((await f.launch({ SHELL: '/usr/bin/fish' }))[0]), [
    '/usr/bin/fish',
    '-lic',
    'exec $argv',
    'claude',
  ]);
  const override = '["custom-claude","--flag"]';
  const commands = await f.launch({ TERM_DAD_CLAUDE_COMMAND: override });
  assert.equal(commands[0], override);
  assert.equal(JSON.parse(commands[1]).at(-1), 'codex');
  assert.deepEqual(
    await f.launch({
      SHELL: '/bin/unsupported',
      TERM_DAD_CLAUDE_COMMAND: override,
      TERM_DAD_CODEX_COMMAND: '["remote-codex"]',
    }),
    [override, '["remote-codex"]'],
  );
  const fallback = await f.runLauncher({ SHELL: '/bin/unsupported' });
  assert.deepEqual(
    JSON.parse(fallback.stdout).map((value: string) => JSON.parse(value)),
    [['claude'], ['codex']],
  );
  assert.match(fallback.stderr, /Unsupported local shell; launching claude directly without shell startup/);
  assert.match(fallback.stderr, /TERM_DAD_LOCAL_SHELL/);
});

for (const shell of ['/bin/zsh', '/bin/bash']) {
  test(
    `${shell} loads startup environment and forwards CLI and injected hook arguments literally`,
    { skip: !existsSync(shell) },
    async (t) => {
      const f = await fixture(t);
      const login = 'export TERM_DAD_TEST_LOGIN=loaded\n';
      const interactive =
        'export TERM_DAD_TEST_INTERACTIVE=loaded\nexport PATH="$TERM_DAD_TEST_BIN:$PATH"\nprintf "startup-output\\n"\n';
      await Promise.all([
        writeFile(join(f.home, '.zprofile'), login),
        writeFile(join(f.home, '.zshrc'), interactive),
        writeFile(join(f.home, '.bash_profile'), `${login}. "$HOME/.bashrc"\n`),
        writeFile(join(f.home, '.bashrc'), interactive),
      ]);
      for (const runtime of ['bun', 'rtk'])
        await writeFile(join(f.workerBin, runtime), `#!/bin/sh\nprintf '${runtime}-available'\n`, { mode: 0o700 });
      for (const cli of ['claude', 'codex'])
        await writeFile(
          join(f.workerBin, cli),
          `#!/usr/bin/env node
const {execFileSync} = require('node:child_process');
if (process.argv.includes('--test-exit')) process.exit(23);
console.log(JSON.stringify({
  argv: process.argv.slice(2),
  login: process.env.TERM_DAD_TEST_LOGIN,
  interactive: process.env.TERM_DAD_TEST_INTERACTIVE,
  runtimes: ['bun', 'rtk'].map(name => execFileSync(name, {encoding: 'utf8'})),
}));
`,
          { mode: 0o700 },
        );
      // Neither CLI is on the host PATH. Startup chatter must not touch server stdout.
      const commands = (await f.launch({ TERM_DAD_LOCAL_SHELL: shell })).map((value) => JSON.parse(value) as string[]);
      const literal = [
        'a b',
        '',
        '"quoted"',
        "apostrophe'",
        '$HOME',
        '$(touch SHOULD_NOT_EXIST)',
        '`id`',
        '; echo injected',
        '*.json',
        'two\nlines',
      ];
      for (const [index, cli] of (['claude', 'codex'] as const).entries()) {
        const base = [...commands[index], ...literal];
        const argv = pushHookArgv(cli, base, {
          credentialPath: join(f.directory, "state with spaces' $literal", 'credentials.json'),
          notify: [process.execPath, '/path with spaces/notify.js'],
        })!;
        // Simulate a GUI pane without any of the supervisor's runtime PATH entries.
        const env = { ...f.env, PATH: '/usr/bin:/bin' };
        const output = await execute(argv[0], argv.slice(1), undefined, 15000, env);
        const result = JSON.parse(output.trim().split('\n').at(-1)!);
        assert.deepEqual(result.argv, [...literal, ...argv.slice(base.length)]);
        assert.equal(result.login, 'loaded');
        assert.equal(result.interactive, 'loaded');
        assert.deepEqual(result.runtimes, ['bun-available', 'rtk-available']);
        assert.match(output, /^startup-output\n/m);
        await assert.rejects(
          execute(argv[0], [...commands[index].slice(1), '--test-exit'], undefined, 15000, env),
          /23/,
        );
      }
    },
  );
}
