import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { EventQueue, FileEventStorage } from '../src/events.js';

test('a vanished lock cannot authorize deleting a subsequent publisher lock', async (t) => {
  const directory = await fs.mkdtemp('/tmp/term-dad-journal-race-');
  const lock = `${directory}/events.lock`;
  const queues = [0, 1].map(() => new EventQueue(new FileEventStorage(directory), 50));
  const readFile = fs.readFile,
    rename = fs.rename,
    stat = fs.stat;
  let release!: () => void, reached!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const ready = new Promise<void>((r) => {
    reached = r;
  });
  let first: ReturnType<EventQueue['publish']> | undefined;
  let intercepted = false,
    vanished = false;
  const input = (paneId: number) => ({
    kind: 'ready',
    paneId,
    occurredAt: new Date().toISOString(),
    summary: 'Worker status changed',
  });
  await fs.writeFile(lock, String(process.pid), { mode: 0o600 });
  const oldInfo = await stat(lock);
  t.mock.method(fs, 'stat', async (...args: Parameters<typeof stat>) =>
    String(args[0]) === lock && !vanished ? oldInfo : stat(...args),
  );
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
    if (String(args[1]) === `${directory}/events.json` && !intercepted) {
      intercepted = true;
      reached();
      await gate;
    }
    return rename(...args);
  });
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof readFile>) => {
    if (String(args[0]) === lock && !vanished) {
      // Model an already-issued read returning ENOENT after the previous holder
      // releases and a new publisher acquires the name. Stat saw the old inode.
      await fs.unlink(lock);
      first = queues[0].publish(input(1));
      await ready;
      vanished = true;
      throw Object.assign(new Error('lock vanished before read'), { code: 'ENOENT' });
    }
    return readFile(...args);
  });
  syncBuiltinESMExports();
  try {
    // The new publisher stays paused before rename for the entire contender call.
    await assert.rejects(queues[1].publish(input(2)), /EVENT_STORAGE_BUSY/);
    assert.equal((await readFile(lock, 'utf8')).trim(), String(process.pid));
    release();
    const a = await first!;
    const b = await queues[1].publish(input(2));
    assert.deepEqual([a.sequence, b.sequence], [1, 2]);
    const reopened = new EventQueue(new FileEventStorage(directory), 50);
    try {
      assert.deepEqual(
        (await reopened.list()).events.map((e) => e.id),
        [a.id, b.id],
      );
      await Promise.all([queues[0].acknowledge([b.id]), queues[1].acknowledge([a.id])]);
      assert.equal((await reopened.list()).pendingCount, 0);
      assert.equal((await reopened.list({}, true)).events.length, 2);
    } finally {
      await reopened.close();
    }
  } finally {
    release();
    await first?.catch(() => {});
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await Promise.all(queues.map((q) => q.close()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
