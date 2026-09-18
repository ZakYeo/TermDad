import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute } from '../src/backend.js';

test('local Claude launch preserves host runtime PATH literally and respects configured argv', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'term-dad-launcher-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'tools with spaces $literal'),
    scripts = join(directory, 'scripts'),
    dist = join(directory, 'dist');
  await Promise.all([mkdir(bin), mkdir(scripts), mkdir(dist)]);
  await copyFile(new URL('../scripts/launch-local', import.meta.url), join(scripts, 'launch-local'));
  await symlink(process.execPath, join(bin, 'node'));
  await writeFile(join(bin, 'claude'), '#!/bin/sh\nexec bun\n', { mode: 0o700 });
  await writeFile(join(bin, 'bun'), '#!/bin/sh\nprintf "hook-runtime-visible"\n', { mode: 0o700 });
  await writeFile(join(dist, 'index.js'), 'console.log(process.env.TERM_DAD_CLAUDE_COMMAND);\n');
  const env = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    TERM_DAD_CLAUDE_COMMAND: '',
    TERM_DAD_CODEX_COMMAND: '["custom-codex"]',
  };
  const argv = JSON.parse(await execute('/bin/sh', [join(scripts, 'launch-local')], undefined, 15000, env));
  assert.deepEqual(argv, ['/usr/bin/env', `PATH=${env.PATH}`, join(bin, 'claude')]);
  assert.equal(
    await execute(argv[0], argv.slice(1), undefined, 15000, { ...process.env, PATH: '/usr/bin:/bin' }),
    'hook-runtime-visible',
  );
  const override = '["custom-claude","--flag"]';
  assert.equal(
    (
      await execute('/bin/sh', [join(scripts, 'launch-local')], undefined, 15000, {
        ...env,
        TERM_DAD_CLAUDE_COMMAND: override,
      })
    ).trim(),
    override,
  );
});
