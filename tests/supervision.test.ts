import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Supervision, type SupervisionRuntime } from '../src/supervision.js';
import { MemorySupervisionStorage, FileSupervisionStorage } from '../src/supervision-storage.js';
function runtime() {
  const watches: { watchId: string; agentId: string }[] = [],
    enabled = new Set<string>(),
    failures = new Set<string>(),
    guards = new Map<string, () => Promise<boolean>>();
  const port: SupervisionRuntime = {
    resolve: async () => ({}),
    enable: async (id) => {
      if (failures.has(id)) throw new Error('no hooks');
      enabled.add(id);
    },
    pushStatus: async (id) => ({ enabled: enabled.has(id), deliverable: enabled.has(id), proven: false }),
    watches: () => watches,
    createWatch: async (agentId) => {
      const w = { agentId, watchId: randomUUID() };
      watches.push(w);
      return w;
    },
    removeWatch: (id) => {
      const at = watches.findIndex((w) => w.watchId === id);
      if (at >= 0) watches.splice(at, 1);
    },
    guardWatch: (id, valid) => {
      guards.set(id, valid);
    },
  };
  return { port, watches, enabled, failures, guards };
}
const member = () => ({ agentId: randomUUID(), allowPolling: false });
test('groups enforce revisions and exclusive active membership; close preserves borrowed watches', async () => {
  const r = runtime(),
    s = new Supervision(new MemorySupervisionStorage(), r.port),
    a = member(),
    b = member();
  const borrowed = await r.port.createWatch(a.agentId);
  const first = await s.create('rounds', [a, b]);
  assert.equal(first.monitoringReady, true);
  assert.equal(first.members[0].watchOwned, false);
  assert.equal(first.members[1].watchOwned, true);
  assert.equal(first.waiter.launched, 'unknown');
  await assert.rejects(s.create('conflict', [a]), /WORKER_ASSIGNED/);
  await assert.rejects(s.update(first.group.groupId, 4, []), /REVISION_CONFLICT/);
  const closed = await s.close(first.group.groupId, 1);
  assert.equal(closed.group.state, 'closed');
  assert.deepEqual(r.watches, [borrowed]);
  await s.create('reuse', [b]);
  await assert.rejects(s.update(closed.group.groupId, 2, []), /GROUP_CLOSED/);
});
test('partial setup is explicit and retryable; polling requires an exception', async () => {
  const r = runtime(),
    s = new Supervision(new MemorySupervisionStorage(), r.port),
    a = member(),
    b = member();
  r.failures.add(b.agentId);
  const first = await s.create('partial', [a, b]);
  assert.equal(first.monitoringReady, false);
  assert.ok(first.setupErrors[b.agentId]);
  assert.equal(r.watches.length, 1);
  const retried = await s.update(first.group.groupId, 1, [a, { ...b, allowPolling: true }]);
  assert.equal(retried.monitoringReady, true);
  assert.equal(r.watches.length, 2);
  const removed = await s.update(first.group.groupId, 2, [a]);
  assert.equal(removed.group.revision, 3);
  assert.equal(r.watches.length, 1);
});
test('durable groups recover explicitly and peer closure invalidates only owned watches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'td-supervision-'));
  try {
    const a = member(),
      r1 = runtime(),
      s1 = new Supervision(new FileSupervisionStorage(dir), r1.port);
    const first = await s1.create('durable', [a]);
    const r2 = runtime(),
      s2 = new Supervision(new FileSupervisionStorage(dir), r2.port);
    assert.equal((await s2.status(first.group.groupId)).monitoringReady, false);
    const restored = await s2.update(first.group.groupId, 1, [a]);
    assert.equal(restored.monitoringReady, true);
    assert.equal(await [...r1.guards.values()][0](), true);
    await s2.close(first.group.groupId, 2);
    assert.equal(await [...r1.guards.values()][0](), false);
    assert.equal(r2.watches.length, 0);
    await s1.dispose();
    await s2.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('concurrent membership replacement during setup cannot report stale success', async () => {
  const storage = new MemorySupervisionStorage(),
    r1 = runtime(),
    r2 = runtime();
  const s1 = new Supervision(storage, r1.port),
    s2 = new Supervision(storage, r2.port),
    a = member();
  const first = await s1.create('race', []);
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  r1.port.createWatch = async (agentId) => {
    entered();
    await gate;
    const w = { agentId, watchId: randomUUID() };
    r1.watches.push(w);
    return w;
  };
  const pending = s1.update(first.group.groupId, 1, [a]);
  await inside;
  await s2.update(first.group.groupId, 2, []);
  release();
  await assert.rejects(pending, /REVISION_CONFLICT/);
  assert.equal(r1.watches.length, 0);
});
