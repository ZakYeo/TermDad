import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { WezTermBackend } from '../src/backend.js';
import { EventQueue, FileEventStorage } from '../src/events.js';
import { FileWorkerStorage } from '../src/worker-storage.js';
import { FileTaskStorage } from '../src/task-storage.js';
import { sendPush } from '../src/term-dad-notify.js';
import { readCredential } from '../src/push-credentials.js';
const identity = { endpoint: 'fixture-socket', key: 'fixture-instance' };
function backend(panes = [7]) {
  const spawns: string[][] = [];
  const wez = new WezTermBackend(
    async (args) => {
      if (args[0] === 'list')
        return JSON.stringify(
          panes.map((pane_id) => ({
            pane_id,
            tab_id: 1,
            window_id: 1,
            title: 't',
            cwd: '/',
            size: { rows: 24, cols: 80 },
          })),
        );
      if (args[0] === 'spawn') {
        spawns.push(args);
        return String(panes[0]);
      }
      if (args[0] === 'get-text') return 'Do you want to proceed?\n› Yes';
      return '';
    },
    async () => identity,
  );
  return { wez, spawns };
}
async function server(t: any, directory: string, panes?: number[]) {
  const { wez, spawns } = backend(panes);
  const events = new EventQueue(new FileEventStorage(directory), 50, 64, Date.now, 0);
  process.env.TERM_DAD_STATE_DIR = directory;
  const term = createServer(
    wez,
    { capture: async () => ({ type: 'image', data: '', mimeType: 'image/png' }) } as any,
    { automatic: false },
    events,
    new FileWorkerStorage(directory),
    new FileTaskStorage(directory),
  );
  t.after(async () => {
    await term.pushSocket.close();
    await term.watches.dispose();
    await term.agents.close();
    await events.close();
  });
  await term.pushReady;
  await term.pushRestored;
  return { term, events, spawns };
}
/** The credential path is baked into the worker's argv, so it is what a live worker rereads. */
function bakedCredentialPath(spawn: string[]) {
  const settings = JSON.parse(spawn[spawn.indexOf('--settings') + 1]);
  const command = settings.hooks.Stop[0].hooks[0].command as string;
  return command.split("'--credential' '")[1].split("'")[0];
}
test('a supervisor restart re-keys a surviving worker so its unchanged argv keeps working', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'term-dad-restore-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await server(t, directory);
  const { agentId } = await first.term.agents.spawn({ name: 'survivor', cli: 'claude' } as any);
  const path = bakedCredentialPath(first.spawns[0]);
  const before = await readCredential(path);
  const revision = (await first.term.agents.resolveOptional(agentId))!.revision;
  await first.term.pushSocket.close();
  const second = await server(t, directory);
  const after = await readCredential(path);
  assert.equal(after.agentId, agentId);
  assert.notEqual(after.token, before.token, 'the restart minted a new token');
  assert.equal(
    after.socketPath,
    second.term.push.socket().path,
    'and points the worker at the socket this server bound',
  );
  assert.equal((await second.term.agents.resolveOptional(agentId))!.revision, revision, 're-keying is not a rebind');
  const status = await second.term.push.status(agentId);
  assert.equal(status.registered, true);
  assert.equal(status.hookSurface, 'claude_hooks');
  assert.equal(status.enabled, false, 'push stays off until it is enabled explicitly');
  assert.match(status.reason ?? '', /explicitly/, 'the report says a surviving worker must be re-enabled');
  // The surviving worker can deliver again after one push.set, with no relaunch.
  await second.term.push.setEnabled(agentId, true);
  assert.deepEqual(await sendPush(after.socketPath, JSON.stringify({ token: after.token, kind: 'ready' })), {
    ok: true,
    delivered: true,
  });
  assert.deepEqual(
    await sendPush(after.socketPath, JSON.stringify({ token: before.token, kind: 'ready' })),
    { error: 'PUSH_UNAUTHORIZED: unknown or revoked push token' },
    'the pre-restart token is revoked',
  );
  assert.equal((await second.term.push.status(agentId)).deliveries.count, 1);
  const journal = await readFile(join(directory, 'workers.json'), 'utf8');
  assert.ok(
    !journal.includes(after.token) && !journal.includes(before.token),
    'no token ever reaches the worker journal',
  );
  assert.ok(journal.includes('claude_hooks'), 'the hook surface is durable, so a restart knows the pane can deliver');
});
test('a restarting server re-keys only workers it can verify it is attached to', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'term-dad-restore-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await server(t, directory);
  const { agentId } = await first.term.agents.spawn({ name: 'survivor', cli: 'claude' } as any);
  const path = bakedCredentialPath(first.spawns[0]);
  const before = await readCredential(path);
  await first.term.pushSocket.close();
  // A record bound to a GUI this server cannot verify must be left for an explicit reattach:
  // worker metadata is shared by state directory, so re-keying it could strand a live peer.
  const storage = new FileWorkerStorage(directory);
  await storage.transaction(true, (s: any) => {
    s.workers[0].instance = { endpoint: 'other-socket', key: 'other-instance' };
    return { state: s, result: undefined };
  });
  const second = await server(t, directory);
  assert.deepEqual(await readCredential(path), before, 'an unattached worker is left byte-identical');
  const status = await second.term.push.status(agentId);
  assert.equal(status.registered, false, 'and holds no registration in this server');
  assert.equal(status.hookSurface, 'claude_hooks', 'while still reporting that its pane was launched with hooks');
});
test('startup removes credentials of workers that are gone and never a surviving one', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'term-dad-restore-sweep-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await server(t, directory);
  const { agentId } = await first.term.agents.spawn({ name: 'survivor', cli: 'claude' } as any);
  const path = bakedCredentialPath(first.spawns[0]);
  const orphanId = '11111111-2222-3333-4444-555555555555';
  const orphan = join(directory, 'push-credentials', `${orphanId}.json`);
  await writeFile(
    orphan,
    JSON.stringify({ version: 1, agentId: orphanId, socketPath: '/run/dead.sock', token: 'stale' }),
    { mode: 0o600 },
  );
  await first.term.pushSocket.close();
  await server(t, directory);
  await assert.rejects(readCredential(orphan), /PUSH_CREDENTIAL_UNREADABLE/, 'a credential with no worker is swept');
  assert.equal((await readCredential(path)).agentId, agentId, "a surviving worker's credential is kept and re-keyed");
});
test('a server that could not bind its socket neither re-keys nor sweeps', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'term-dad-restore-nobind-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await server(t, directory);
  const { agentId } = await first.term.agents.spawn({ name: 'survivor', cli: 'claude' } as any);
  const path = bakedCredentialPath(first.spawns[0]);
  const before = await readCredential(path);
  await first.term.pushSocket.close();
  // Occupy the socket path with a plain file so the next server refuses to bind.
  await writeFile(join(directory, `push.${process.pid}.sock`), 'not a socket', { mode: 0o600 });
  const { wez } = backend();
  const events = new EventQueue(new FileEventStorage(directory), 50, 64, Date.now, 0);
  process.env.TERM_DAD_STATE_DIR = directory;
  const second = createServer(
    wez,
    { capture: async () => ({ type: 'image', data: '', mimeType: 'image/png' }) } as any,
    { automatic: false },
    events,
    new FileWorkerStorage(directory),
    new FileTaskStorage(directory),
  );
  t.after(async () => {
    await second.watches.dispose();
    await second.agents.close();
    await events.close();
  });
  await second.pushReady;
  await second.pushRestored;
  assert.equal(second.push.socket().listening, false);
  assert.match(second.push.socket().bindError!, /PUSH_SOCKET_PATH_OCCUPIED/);
  assert.deepEqual(await readCredential(path), before, 'credentials are untouched when there is nothing to deliver to');
  await assert.rejects(async () => second.push.setEnabled(agentId, true), /PUSH_NOT_WIRED|PUSH_SOCKET_UNAVAILABLE/);
});
test('an adopted pane is never reported as pushable and gets no credential', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'term-dad-adopt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { term } = await server(t, directory);
  const adopted = await term.agents.adopt({ name: 'adopted', cli: 'claude', paneId: 7 } as any);
  await assert.rejects(
    term.push.setEnabled(adopted.agentId, true),
    /PUSH_NOT_WIRED/,
    'a pane launched without injected argv can never deliver',
  );
  const status = await term.push.status(adopted.agentId);
  assert.equal(status.hookSurface, null);
  assert.equal(status.deliverable, false);
  await assert.rejects(
    readCredential(join(directory, 'push-credentials', `${adopted.agentId}.json`)),
    /PUSH_CREDENTIAL_UNREADABLE/,
  );
});
test('reattaching a surviving worker re-keys it and re-points its registration at the new pane', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'term-dad-reattach-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { term, spawns } = await server(t, directory, [7, 9]);
  const { agentId } = await term.agents.spawn({ name: 'survivor', cli: 'claude' } as any);
  const path = bakedCredentialPath(spawns[0]);
  const before = await readCredential(path);
  await term.push.setEnabled(agentId, true);
  await term.agents.reattach({ agentId, paneId: 9 } as any);
  const after = await readCredential(path);
  assert.notEqual(after.token, before.token, 'a rebind re-keys, so the old token cannot report for the new pane');
  const status = await term.push.status(agentId);
  assert.equal(status.paneId, 9, 'the registration follows the pane');
  assert.equal(status.enabled, false, 'and comes back off');
});
test('push tools accept the worker name the supervisor uses everywhere else', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'term-dad-push-name-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { term } = await server(t, directory);
  const { agentId } = await term.agents.spawn({ name: 'survivor', cli: 'claude' } as any);
  const status = await term.push.status('survivor');
  assert.equal(status.agentId, agentId, 'a name resolves to the worker it names');
  assert.equal(status.registered, true);
  const enabled = await term.push.setEnabled('survivor', true);
  assert.equal(enabled.agentId, agentId);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.deliverable, true, 'set reports deliverability, the same fact status reports');
  assert.equal(enabled.proven, false);
  assert.equal(enabled.credential, 'recorded', 'a durable binding is a record, not evidence the file is intact');
  assert.match(enabled.note ?? '', /not proven/);
  await assert.rejects(term.push.status('nobody'), /PUSH_UNKNOWN_WORKER/);
  await assert.rejects(term.push.setEnabled('nobody', true), /PUSH_UNKNOWN_WORKER/);
});
test('a surviving worker that startup could not re-key is re-keyed by push.set instead of being told to respawn', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'term-dad-rekey-on-demand-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await server(t, directory);
  const { agentId } = await first.term.agents.spawn({ name: 'survivor', cli: 'claude' } as any);
  const path = bakedCredentialPath(first.spawns[0]);
  const before = await readCredential(path);
  await first.term.pushSocket.close();
  // Another live operation holds the worker lock while the new server starts, so restore skips it.
  const lock = join(directory, `worker-${agentId}.lock`);
  await writeFile(lock, String(process.pid), { mode: 0o600 });
  const second = await server(t, directory);
  assert.deepEqual(await readCredential(path), before, 'restore left the busy worker alone');
  assert.equal((await second.term.push.status(agentId)).registered, false);
  await rm(lock);
  const enabled = await second.term.push.setEnabled(agentId, true);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.registered, true);
  const after = await readCredential(path);
  assert.notEqual(after.token, before.token, 'enabling re-keyed the worker under its lock');
  assert.equal(after.socketPath, second.term.push.socket().path);
  assert.deepEqual(await sendPush(after.socketPath, JSON.stringify({ token: after.token, kind: 'ready' })), {
    ok: true,
    delivered: true,
  });
});
