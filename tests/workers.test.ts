import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agents } from '../src/agents.js';
import { WezTermBackend, terminalEnvironment } from '../src/backend.js';
import {
  FileWorkerStorage,
  MemoryWorkerStorage,
  type WorkerStorage,
  type TerminalInstance,
} from '../src/worker-storage.js';
import { WatchManager } from '../src/watches.js';
const original = { endpoint: 'test-socket', key: 'host:10:started-1' };
function fixture(storage: WorkerStorage = new MemoryWorkerStorage()) {
  let instance: TerminalInstance | null = { ...original },
    alive = true,
    text = 'OpenAI Codex\n› Explain this codebase',
    fail = false;
  const inputs: string[] = [],
    calls: string[] = [];
  const backend = new WezTermBackend(
    async (args, input) => {
      calls.push(args[0]);
      if (fail) throw new Error('backend unavailable');
      if (args[0] === 'list')
        return JSON.stringify(
          alive
            ? [
                {
                  pane_id: 7,
                  tab_id: 1,
                  window_id: 1,
                  title: 'SECRET_TITLE',
                  cwd: 'SECRET_CWD',
                  size: { rows: 24, cols: 80 },
                },
              ]
            : [],
        );
      if (args[0] === 'spawn') return '7';
      if (args[0] === 'get-text') return text;
      if (args[0] === 'send-text') inputs.push(input!);
      if (args[0] === 'kill-pane') alive = false;
      return '';
    },
    async () => instance,
  );
  return {
    backend,
    storage,
    agents: new Agents(backend, storage),
    inputs,
    calls,
    identity: (value: TerminalInstance | null) => {
      instance = value;
    },
    alive: (value: boolean) => {
      alive = value;
    },
    text: (value: string) => {
      text = value;
    },
    fail: (value: boolean) => {
      fail = value;
    },
  };
}
async function directory(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'term-dad-workers-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test('restart retains identity, deferred skill and stale guard, but resets observation history and stores no content', async (t) => {
  const dir = await directory(t),
    f = fixture(new FileWorkerStorage(dir)),
    spawned = await f.agents.spawn({ name: 'worker', cli: 'codex' });
  const first = await f.agents.observe(spawned.agentId);
  await f.agents.close();
  const next = new Agents(f.backend, new FileWorkerStorage(dir));
  assert.equal((await next.list())[0].agentId, spawned.agentId);
  assert.equal((await next.observe(spawned.agentId, first.observationId)).deltaReset, true);
  await next.send(spawned.agentId, 'SECRET_TASK');
  assert.match(f.inputs[0], /^\$term-dad-worker/);
  await next.close();
  const third = new Agents(f.backend, new FileWorkerStorage(dir));
  await third.storage.transaction(true, (s) => {
    s.workers[0].lastInputAt = Date.now() - 5000;
    return { state: s, result: undefined };
  });
  assert.equal((await third.observe(spawned.agentId)).status, 'WORKING');
  await third.send(spawned.agentId, 'follow-up');
  assert.equal(f.inputs[2], 'follow-up');
  const journal = await readFile(join(dir, 'workers.json'), 'utf8');
  for (const secret of ['SECRET_TASK', 'SECRET_TITLE', 'SECRET_CWD', 'Explain this codebase', 'term-dad-worker'])
    assert.ok(!journal.includes(secret));
  assert.equal((await stat(join(dir, 'workers.json'))).mode & 0o777, 0o600);
  assert.ok(!f.calls.includes('kill-pane'));
});
test('identity mismatch and reused pane/process IDs never read or control saved workers', async () => {
  const f = fixture();
  await f.agents.adopt({ name: 'old', cli: 'shell', paneId: 7 });
  f.calls.length = 0;
  f.identity({ ...original, key: 'host:10:started-2' });
  const next = new Agents(f.backend, f.storage);
  assert.equal((await next.list())[0].attachment, 'detached');
  for (const action of [
    () => next.observe('old'),
    () => next.send('old', 'x'),
    () => next.interrupt('old'),
    () => next.stop('old'),
    () =>
      next.withPane('old', async () => {
        throw new Error('screenshot invoked');
      }),
  ])
    await assert.rejects(action(), /WORKER_DETACHED/);
  assert.ok(!f.calls.includes('get-text'));
  assert.ok(!f.calls.includes('send-text'));
  assert.ok(!f.calls.includes('kill-pane'));
  await next.reattach({ agentId: 'old', paneId: 7 });
  assert.equal((await next.list())[0].attachment, 'attached');
});
test('unverifiable identity requires explicit attachment per server session, without duplicate adoption', async () => {
  const f = fixture();
  f.identity(null);
  const w = await f.agents.adopt({ name: 'old', cli: 'shell', paneId: 7 });
  const next = new Agents(f.backend, f.storage);
  assert.equal((await next.list())[0].attachment, 'detached');
  await assert.rejects(next.adopt({ name: 'duplicate', cli: 'shell', paneId: 7 }), /OCCUPIED/);
  await next.reattach({ agentId: w.agentId, paneId: 7 });
  assert.equal((await next.list())[0].attachment, 'attached');
  assert.equal((await f.agents.list())[0].attachment, 'detached');
});
test('adopt and reattach send nothing; initialized Codex follow-up stays literal; forget leaves pane alive', async () => {
  const f = fixture();
  await f.agents.adopt({ name: 'adopted', cli: 'codex', paneId: 7, workerSkillInitialized: true });
  await f.agents.reattach({ agentId: 'adopted', paneId: 7 });
  assert.equal(f.inputs.length, 0);
  assert.ok(!f.calls.includes('spawn'));
  await f.agents.send('adopted', 'literal');
  assert.equal(f.inputs[0], 'literal');
  await f.agents.forget('adopted');
  assert.deepEqual(await f.agents.list(), []);
  assert.ok(!f.calls.includes('kill-pane'));
});
test('transport failure preserves mapping; confirmed disappearance removes it durably for all servers', async () => {
  const f = fixture();
  await f.agents.adopt({ name: 'worker', cli: 'shell', paneId: 7 });
  f.fail(true);
  assert.equal((await f.agents.list())[0].attachment, 'detached');
  await assert.rejects(f.agents.observe('worker'), /backend unavailable/);
  f.fail(false);
  assert.equal((await f.agents.list()).length, 1);
  f.alive(false);
  assert.deepEqual(await f.agents.list(), []);
  assert.deepEqual(await new Agents(f.backend, f.storage).list(), []);
});
test('partial paste failure blocks replay across restart until explicit uncertain-delivery recovery', async () => {
  const f = fixture();
  await f.agents.spawn({ name: 'worker', cli: 'codex' });
  const send = f.backend.sendText.bind(f.backend);
  f.backend.sendText = async (pane, text, raw) => {
    if (raw) throw new Error('lost Enter response');
    await send(pane, text, raw);
  };
  await assert.rejects(f.agents.send('worker', 'task'), /DELIVERY_UNCERTAIN/);
  assert.equal(f.inputs.length, 1);
  const next = new Agents(f.backend, f.storage);
  await assert.rejects(next.send('worker', 'retry'), /DELIVERY_UNCERTAIN/);
  await assert.rejects(next.reattach({ agentId: 'worker', paneId: 7 }), /DELIVERY_UNCERTAIN/);
  await next.reattach({
    agentId: 'worker',
    paneId: 7,
    acknowledgeUncertainDelivery: true,
    workerSkillInitialized: true,
  });
  f.backend.sendText = send;
  await next.send('worker', 'new task');
  assert.equal(f.inputs[1], 'new task');
});
test('cross-instance input/lifecycle exclusion prevents interleaved pastes and duplicate initialization', async (t) => {
  const dir = await directory(t),
    f = fixture(new FileWorkerStorage(dir));
  await f.agents.adopt({ name: 'worker', cli: 'codex', paneId: 7 });
  const next = new Agents(f.backend, new FileWorkerStorage(dir));
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      entered = r;
    });
  const send = f.backend.sendText.bind(f.backend);
  f.backend.sendText = async (...args) => {
    entered();
    await gate;
    return send(...args);
  };
  const first = f.agents.send('worker', 'first');
  await ready;
  for (const action of [
    () => next.send('worker', 'second'),
    () => next.stop('worker'),
    () => next.forget('worker'),
    () => next.reattach({ agentId: 'worker', paneId: 7 }),
  ])
    await assert.rejects(action(), /WORKER_BUSY/);
  release();
  await first;
  await next.send('worker', 'follow-up');
  assert.equal(f.inputs[2], 'follow-up');
});
test('spawn reservations reject duplicate names before backend finishes and failures are recoverable', async () => {
  const f = fixture();
  let release!: (n: number) => void;
  f.backend.spawn = () =>
    new Promise((r) => {
      release = r;
    });
  const first = f.agents.spawn({ name: 'same', cli: 'shell' });
  while (!release) await new Promise((r) => setTimeout(r, 1));
  await assert.rejects(new Agents(f.backend, f.storage).spawn({ name: 'same', cli: 'shell' }), /already exists/);
  release(7);
  await first;
});
test('failed mapping commit returns the live pane and preserves a reservation without submitting', async () => {
  const memory = new MemoryWorkerStorage();
  let writes = 0;
  const broken: WorkerStorage = {
    exclusive: (id, fn) => memory.exclusive(id, fn),
    transaction: (write, fn) => {
      if (write && ++writes === 2) return Promise.reject(new Error('disk full'));
      return memory.transaction(write, fn);
    },
  };
  const f = fixture(broken);
  await assert.rejects(f.agents.spawn({ name: 'worker', cli: 'shell', prompt: 'do work' }), /pane 7.*agent.adopt/);
  assert.equal(f.inputs.length, 0);
  assert.ok(!f.calls.includes('kill-pane'));
  assert.equal((await f.agents.list())[0].paneId, null);
});
test('registry bounds, duplicate targets and schema validation have no terminal input side effects', async () => {
  const f = fixture();
  await f.agents.adopt({ name: 'worker', cli: 'shell', paneId: 7 });
  await assert.rejects(f.agents.adopt({ name: 'duplicate', cli: 'codex', paneId: 7 }), /OCCUPIED/);
  await assert.rejects(f.agents.adopt({ name: 'invalid', cli: 'shell', paneId: -1 }));
  await f.storage.transaction(true, (s) => {
    const template = s.workers[0];
    for (let i = 1; i < 64; i++)
      s.workers.push({ ...template, agentId: crypto.randomUUID(), name: `worker-${i}`, paneId: i + 7 });
    return { state: s, result: undefined };
  });
  await assert.rejects(f.agents.adopt({ name: 'overflow', cli: 'shell', paneId: 7 }), /Maximum/);
  assert.equal(f.inputs.length, 0);
});
test('journal corruption, unknown fields, stale locks and orphan temporaries preserve committed state', async (t) => {
  const dir = await directory(t),
    f = fixture(new FileWorkerStorage(dir));
  await f.agents.adopt({ name: 'worker', cli: 'shell', paneId: 7 });
  const path = join(dir, 'workers.json'),
    valid = await readFile(path, 'utf8');
  await writeFile(join(dir, 'workers.orphan.tmp'), 'partial', { mode: 0o600 });
  assert.equal((await f.agents.list()).length, 1);
  await writeFile(join(dir, 'workers.lock'), '');
  await assert.rejects(f.agents.list(), /WORKER_STORAGE_BUSY/);
  await rm(join(dir, 'workers.lock'));
  await writeFile(path, valid.slice(0, 10));
  await assert.rejects(f.agents.list(), /WORKER_STATE_CORRUPT/);
  assert.equal(await readFile(path, 'utf8'), valid.slice(0, 10));
  const extra = JSON.parse(valid);
  extra.workers[0].prompt = 'secret';
  await writeFile(path, JSON.stringify(extra));
  await assert.rejects(f.agents.list(), /WORKER_STATE_CORRUPT/);
});
test('commit durability warning is observable without duplicating a worker', async (t) => {
  const dir = await directory(t);
  class Fault extends FileWorkerStorage {
    protected override async syncDirectory() {
      throw new Error('sync');
    }
  }
  const f = fixture(new Fault(dir));
  await f.agents.adopt({ name: 'worker', cli: 'shell', paneId: 7 });
  const listed = await f.agents.list();
  assert.equal(listed.length, 1);
  assert.match(listed[0].storageWarning!, /DURABILITY_WARNING/);
});
test('managed watches refuse detached or rebound workers instead of observing another instance', async () => {
  const f = fixture(),
    watch = new WatchManager(f.backend, f.agents, { automatic: false });
  await f.agents.adopt({ name: 'worker', cli: 'codex', paneId: 7 });
  await watch.create({ agentId: 'worker', pollMs: 500 });
  await f.agents.reattach({ agentId: 'worker', paneId: 7 });
  f.calls.length = 0;
  await new Promise((r) => setTimeout(r, 510));
  await watch.poll();
  assert.ok(watch.list()[0].backendError);
  assert.ok(!f.calls.includes('get-text'));
  await watch.dispose();
});
test('close drains an accepted input, leaves panes open and rejects subsequent operations', async () => {
  const f = fixture();
  await f.agents.adopt({ name: 'worker', cli: 'shell', paneId: 7 });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      entered = r;
    });
  f.backend.sendText = async () => {
    entered();
    await gate;
  };
  const sending = f.agents.send('worker', 'x');
  await ready;
  let closed = false;
  const closing = f.agents.close().then(() => {
    closed = true;
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(closed, false);
  release();
  await sending;
  await closing;
  await assert.rejects(f.agents.send('worker', 'x'), /WORKER_CLOSED/);
  assert.ok(!f.calls.includes('kill-pane'));
});
test('Windows endpoint forwarding replaces conflicting WSLENV flags without modifying process environment', () => {
  const previous = process.env.WSLENV;
  try {
    process.env.WSLENV = 'PATH/l:WEZTERM_UNIX_SOCKET/p:OTHER';
    const env = terminalEnvironment('C:\\socket');
    assert.equal(env.WSLENV, 'PATH/l:OTHER:WEZTERM_UNIX_SOCKET');
    assert.equal(env.WEZTERM_UNIX_SOCKET, 'C:\\socket');
    assert.equal(process.env.WSLENV, 'PATH/l:WEZTERM_UNIX_SOCKET/p:OTHER');
  } finally {
    if (previous === undefined) delete process.env.WSLENV;
    else process.env.WSLENV = previous;
  }
});

test('targeted observations evict workers forgotten by another server without needing agent.list', async (t) => {
  const dir = await directory(t),
    f = fixture(new FileWorkerStorage(dir)),
    observer = new Agents(f.backend, new FileWorkerStorage(dir));
  for (let i = 0; i < 70; i++) {
    const worker = await f.agents.adopt({ name: `worker-${i}`, cli: 'shell', paneId: 7 });
    await observer.observe(worker.agentId);
    assert.ok(observer.records.size <= 1);
    await f.agents.forget(worker.agentId);
  }
  await assert.rejects(observer.observe('worker-69'), /Unknown agent/);
  assert.equal(observer.records.size, 0);
});
test('managed watch detects disappearance after another server already removed the mapping', async () => {
  const f = fixture(),
    other = new Agents(f.backend, f.storage);
  let now = 0;
  const events: string[] = [];
  const watches = new WatchManager(f.backend, f.agents, {
    automatic: false,
    now: () => now,
    sink: async (e) => {
      events.push(e.kind);
    },
  });
  await f.agents.adopt({ name: 'worker', cli: 'shell', paneId: 7 });
  await watches.create({ agentId: 'worker', pollMs: 500 });
  f.alive(false);
  assert.deepEqual(await other.list(), []);
  now = 500;
  await watches.poll();
  assert.equal(watches.list()[0].disappeared, true);
  assert.deepEqual(events, ['pane_disappeared']);
  await watches.dispose();
});
test('forgotten live worker or replaced instance does not generate a false disappearance', async () => {
  for (const replaced of [false, true]) {
    const f = fixture();
    let now = 0;
    const events: string[] = [];
    const watches = new WatchManager(f.backend, f.agents, {
      automatic: false,
      now: () => now,
      sink: async (e) => {
        events.push(e.kind);
      },
    });
    await f.agents.adopt({ name: 'worker', cli: 'shell', paneId: 7 });
    await watches.create({ agentId: 'worker', pollMs: 500 });
    await new Agents(f.backend, f.storage).forget('worker');
    if (replaced) {
      f.identity({ ...original, key: 'different-instance' });
      f.alive(false);
    }
    now = 500;
    await watches.poll();
    assert.deepEqual(events, []);
    assert.equal(watches.list()[0].disappeared, false);
    assert.ok(watches.list()[0].backendError);
    await watches.dispose();
  }
});
test('lost spawn response preserves reservation and prevents duplicate launch under the same name', async () => {
  const f = fixture();
  let launches = 0;
  f.backend.spawn = async () => {
    launches++;
    throw new Error('pane created but response lost');
  };
  await assert.rejects(f.agents.spawn({ name: 'worker', cli: 'shell' }), /WORKER_SPAWN_UNCERTAIN/);
  await assert.rejects(new Agents(f.backend, f.storage).spawn({ name: 'worker', cli: 'shell' }), /already exists/);
  assert.equal(launches, 1);
  const saved = await f.agents.list();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].paneId, null);
  await f.agents.forget(saved[0].agentId);
  await f.agents.adopt({ name: 'worker', cli: 'shell', paneId: 7 });
  assert.equal(f.inputs.length, 0);
});

test('invalid spawn options fail before reservation or launch and leave the name available', async () => {
  const f = fixture();
  for (const options of [
    { newWindow: true, windowId: 1 },
    { command: ['bad\0command'] },
    { command: Array(101).fill('arg') },
    { cwd: 'bad\0path' },
  ]) {
    await assert.rejects(f.agents.spawn({ name: 'worker', cli: 'shell', ...options }));
    assert.deepEqual(await f.agents.list(), []);
  }
  assert.deepEqual(f.calls, []);
  await f.agents.spawn({ name: 'worker', cli: 'shell' });
  assert.equal((await f.agents.list()).length, 1);
});

test('invalid configured spawn argv is validated before reservation', async () => {
  const previous = process.env.TERM_DAD_SHELL_COMMAND;
  try {
    process.env.TERM_DAD_SHELL_COMMAND = JSON.stringify(['bad\0command']);
    const f = fixture();
    await assert.rejects(f.agents.spawn({ name: 'worker', cli: 'shell' }));
    assert.deepEqual(await f.agents.list(), []);
    assert.deepEqual(f.calls, []);
    await f.agents.spawn({ name: 'worker', cli: 'shell', command: ['valid-shell'] });
    assert.equal((await f.agents.list()).length, 1);
  } finally {
    if (previous === undefined) delete process.env.TERM_DAD_SHELL_COMMAND;
    else process.env.TERM_DAD_SHELL_COMMAND = previous;
  }
});

test('cache admission is bounded even if a creator only adopts while another server forgets', async () => {
  const f = fixture(),
    other = new Agents(f.backend, f.storage);
  for (let i = 0; i < 100; i++) {
    const w = await f.agents.adopt({ name: `created-${i}`, cli: 'shell', paneId: 7 });
    await other.forget(w.agentId);
    assert.ok(f.agents.records.size <= 64);
  }
});
test('worker lock cleanup failure preserves committed success and actionable delivery uncertainty', async (t) => {
  for (const failInput of [false, true]) {
    const dir = await directory(t);
    class Fault extends FileWorkerStorage {
      protected override async releaseWorkerLock(lock: import('node:fs/promises').FileHandle, _path: string) {
        await lock.close();
        throw new Error('injected cleanup failure');
      }
    }
    const f = fixture(new Fault(dir)),
      w = await f.agents.adopt({ name: 'worker', cli: 'shell', paneId: 7 });
    if (failInput)
      f.backend.sendText = async () => {
        throw new Error('transport');
      };
    if (failInput) await assert.rejects(f.agents.send('worker', 'task'), /WORKER_DELIVERY_UNCERTAIN/);
    else assert.equal((await f.agents.send('worker', 'task')).sent, true);
    const record = (await f.agents.list())[0];
    assert.equal(record.deliveryPending, failInput);
    assert.match(record.storageWarning!, /WORKER_LOCK_CLEANUP_WARNING/);
    await assert.rejects(f.agents.send('worker', 'retry'), /WORKER_BUSY/);
  }
});

test('successful terminal submission with a failed metadata commit remains uncertain after restart', async () => {
  const memory = new MemoryWorkerStorage();
  let writes = 0;
  const broken: WorkerStorage = {
    exclusive: (id, fn) => memory.exclusive(id, fn),
    transaction: (write, fn) => {
      if (write && ++writes === 3) return Promise.reject(new Error('disk full after Enter'));
      return memory.transaction(write, fn);
    },
  };
  const f = fixture(broken);
  await f.agents.adopt({ name: 'worker', cli: 'shell', paneId: 7 });
  await assert.rejects(f.agents.send('worker', 'task'), /DELIVERY_UNCERTAIN/);
  assert.deepEqual(f.inputs, ['task', '\r']);
  const restarted = new Agents(f.backend, broken);
  assert.equal((await restarted.list())[0].deliveryPending, true);
  await assert.rejects(restarted.send('worker', 'retry'), /DELIVERY_UNCERTAIN/);
  assert.equal(f.inputs.length, 2);
});

test('observe waits through a briefly held worker lock instead of surfacing WORKER_BUSY', async () => {
  const f = fixture();
  await f.agents.adopt({ name: 'worker', cli: 'codex', paneId: 7 });
  const next = new Agents(f.backend, f.storage);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      entered = r;
    });
  const send = f.backend.sendText.bind(f.backend);
  f.backend.sendText = async (...args) => {
    entered();
    await gate;
    return send(...args);
  };
  const first = f.agents.send('worker', 'first');
  await ready;
  const observing = next.observe('worker');
  setTimeout(release, 100);
  assert.equal((await observing).name, 'worker');
  await first;
});
test('observe gives up on WORKER_BUSY after its bounded retry schedule', async () => {
  let attempts = 0;
  const memory = new MemoryWorkerStorage();
  const counting: WorkerStorage = {
    transaction: (w, fn) => memory.transaction(w, fn),
    exclusive: (id, fn) => {
      attempts++;
      return memory.exclusive(id, fn);
    },
  };
  const f = fixture(counting);
  const adopted = await f.agents.adopt({ name: 'worker', cli: 'shell', paneId: 7 });
  const next = new Agents(f.backend, counting);
  next.busyRetryMs = [1, 1];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const held = memory.exclusive(adopted.agentId, () => gate);
  attempts = 0;
  await assert.rejects(next.observe('worker'), /WORKER_BUSY/);
  assert.equal(attempts, 3);
  release();
  await held;
});
test('wait_for_outcome keeps polling through a transient WORKER_BUSY', async () => {
  const f = fixture();
  const adopted = await f.agents.adopt({ name: 'worker', cli: 'codex', paneId: 7 });
  const sent = await f.agents.send('worker', 'task');
  f.text('OpenAI Codex\n› done');
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const held = f.storage.exclusive(adopted.agentId, () => gate);
  setTimeout(release, 300);
  // No per-read retry: the wait's own loop must absorb the lock.
  const next = new Agents(f.backend, f.storage);
  next.busyRetryMs = [];
  const outcome = await next.waitForOutcome('worker', sent.turnId, 3000);
  assert.equal(outcome.reason, 'turn_finished');
  await held;
});
test('wait_for_outcome absorbs a journal-busy read between sampling and the turn check', async () => {
  const memory = new MemoryWorkerStorage();
  let armed = false,
    injected = 0;
  const storage: WorkerStorage = {
    exclusive: (id, fn) => memory.exclusive(id, fn),
    transaction: (write, fn) => {
      if (!write && armed && injected === 0) {
        armed = false;
        injected++;
        return Promise.reject(new Error('WORKER_STORAGE_BUSY: transaction lock exists; retry'));
      }
      return memory.transaction(write, fn);
    },
  };
  const f = fixture(storage);
  await f.agents.adopt({ name: 'worker', cli: 'codex', paneId: 7 });
  const sent = await f.agents.send('worker', 'task');
  f.text('OpenAI Codex\n› done');
  const read = f.backend.read.bind(f.backend);
  f.backend.read = async (...args) => {
    const text = await read(...args);
    armed = true;
    return text;
  };
  const outcome = await f.agents.waitForOutcome('worker', sent.turnId, 3000);
  assert.equal(outcome.reason, 'turn_finished');
  assert.ok(injected > 0);
});
test('wait_for_text and wait_until_idle retry through a briefly held worker lock', async () => {
  const f = fixture();
  await f.agents.adopt({ name: 'worker', cli: 'codex', paneId: 7 });
  const next = new Agents(f.backend, f.storage);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      entered = r;
    });
  const send = f.backend.sendText.bind(f.backend);
  f.backend.sendText = async (...args) => {
    entered();
    await gate;
    return send(...args);
  };
  const first = f.agents.send('worker', 'first');
  await ready;
  const waiting = next.wait('worker', (o) => o.recentText.includes('Codex'), 2000);
  setTimeout(release, 100);
  assert.equal((await waiting).name, 'worker');
  await first;
});
