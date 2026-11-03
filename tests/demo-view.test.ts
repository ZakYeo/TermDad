import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareRun } from '../demo/runtime.js';
import { loadPrepared } from '../demo/prepared.js';

const root = fileURLToPath(new URL('../', import.meta.url));
test(
  'recorded-run viewer serves existing data without claiming or launching the run',
  { timeout: 15000 },
  async (t) => {
    const run = await prepareRun(root, 7, 'test-gui', 'test-endpoint');
    t.after(() => rm(run.directory, { recursive: true, force: true }));
    run.panes = [8];
    run.tickets[0].taskId = 'recorded-task';
    await writeFile(join(run.directory, 'run.json'), JSON.stringify(run));
    await assert.rejects(loadPrepared(run.directory), /already used/);
    assert.deepEqual(await loadPrepared(run.directory, true), run);
    const child = spawn(process.execPath, ['--import', 'tsx', 'demo/view.ts', run.directory], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
    t.after(async () => {
      child.kill('SIGTERM');
      await closed;
    });
    let error = '';
    child.stderr.on('data', (data) => {
      error += String(data);
    });
    const url = await new Promise<string>((resolve, reject) => {
      let text = '';
      child.stdout.on('data', (data) => {
        text += String(data);
        const match = text.match(/http:\/\/127\.0\.0\.1:\d+\//);
        if (match) resolve(match[0]);
      });
      child.once('error', reject);
      child.once('exit', () => reject(new Error(error || 'Viewer exited before listening')));
    });
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url + 'before/')).status, 200);
    assert.equal((await fetch(url + 'after/')).status, 404);
    const status = await (await fetch(url + 'status')).json();
    assert.equal(status.execution, undefined);
    assert.equal(status.startToken, undefined);
    await assert.rejects(access(join(run.directory, 'launched')));
    await assert.rejects(access(join(run.state, 'workers.json')));
    assert.deepEqual(JSON.parse(await readFile(join(run.directory, 'run.json'), 'utf8')).panes, [8]);
    child.kill('SIGTERM');
    assert.equal(await closed, 0, error);
  },
);
