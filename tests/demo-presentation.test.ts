import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import test from 'node:test';
import { startPresentation, type DemoStatus } from '../demo/presentation.js';

const initial: DemoStatus = {
  available: true,
  updatedAt: '2026-01-01T00:00:00.000Z',
  tickets: [{ id: 'SALES-101', title: 'KPIs', state: 'Working' }],
  released: false,
  message: 'Team working',
};

async function fixture(t: any, readStatus: () => Promise<DemoStatus>) {
  const directory = await mkdtemp(join(tmpdir(), 'demo-presentation-'));
  const beforeDirectory = join(directory, 'before'),
    afterDirectory = join(directory, 'after');
  await mkdir(beforeDirectory);
  await mkdir(afterDirectory);
  await writeFile(join(beforeDirectory, 'index.html'), 'BEFORE');
  await writeFile(join(afterDirectory, 'index.html'), 'AFTER');
  const server = await startPresentation({ beforeDirectory, afterDirectory, readStatus });
  t.after(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { ...server, directory, beforeDirectory };
}

async function raw(url: string, path: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<number>((resolve, reject) => {
    const req = request(new URL(url), { path, headers, method }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on('error', reject);
    req.end();
  });
}

test('presentation serves the before view and gates unreleased output', async (t) => {
  const server = await fixture(t, async () => initial);
  assert.match(await (await fetch(server.url)).text(), /TermDad/);
  assert.equal(await (await fetch(`${server.url}before/`)).text(), 'BEFORE');
  assert.equal((await fetch(`${server.url}after/`)).status, 404);
  assert.deepEqual(await (await fetch(`${server.url}status`)).json(), initial);
  assert.equal(await raw(server.url, '/', { Host: 'attacker.example' }), 403);
  assert.equal(await raw(server.url, '/status', {}, 'POST'), 405);
});

test('presentation rejects traversal, hidden files, arbitrary extensions and escaping symlinks', async (t) => {
  const server = await fixture(t, async () => initial);
  await writeFile(join(server.directory, 'secret.json'), 'SECRET');
  await writeFile(join(server.beforeDirectory, '.private.json'), 'SECRET');
  await writeFile(join(server.beforeDirectory, 'private.txt'), 'SECRET');
  await symlink(join(server.directory, 'secret.json'), join(server.beforeDirectory, 'escape.json'));
  for (const path of [
    '/before/%2e%2e/secret.json',
    '/before/.private.json',
    '/before/private.txt',
    '/before/escape.json',
    '/before/%00',
    '/before/%5c..%5csecret.json',
  ]) {
    assert.equal(await raw(server.url, path), 404, path);
  }
});

test('presentation exposes after only for a currently available release', async (t) => {
  const server = await fixture(t, async () => ({ ...initial, released: true }));
  assert.equal(await (await fetch(`${server.url}after/`)).text(), 'AFTER');
});

test('failed refresh preserves last observation but marks it unavailable and hides after', async (t) => {
  let calls = 0;
  const server = await fixture(t, async () => {
    if (calls++ > 0) throw new Error('Sensitive terminal contents must never be served');
    return { ...initial, released: true };
  });
  await new Promise((resolve) => setTimeout(resolve, 2150));
  const status = (await (await fetch(`${server.url}status`)).json()) as DemoStatus;
  assert.equal(status.available, false);
  assert.deepEqual(status.tickets, initial.tickets);
  assert.equal(status.updatedAt, initial.updatedAt);
  assert.doesNotMatch(JSON.stringify(status), /Sensitive/);
  assert.equal((await fetch(`${server.url}after/`)).status, 404);
});

test('closing presentation does not wait for an unavailable status source', async () => {
  const server = await startPresentation({
    beforeDirectory: tmpdir(),
    afterDirectory: tmpdir(),
    readStatus: () => new Promise(() => {}),
  });
  await server.close();
  await assert.rejects(fetch(server.url));
});
