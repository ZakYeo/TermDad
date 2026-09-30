import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventQueue, FileEventStorage } from '../src/events.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { WezTermBackend } from '../src/backend.js';
import { MemoryWorkerStorage } from '../src/worker-storage.js';
import { MemoryTaskStorage } from '../src/task-storage.js';

async function fixture(t: any) {
  const calls: { args: string[]; input?: string }[] = [];
  const backend = new WezTermBackend(
    async (args, input) => {
      calls.push({ args, input });
      if (args[0] === 'list')
        return JSON.stringify([
          { pane_id: 7, tab_id: 1, window_id: 1, title: 'shell', cwd: '/', size: { rows: 24, cols: 80 } },
        ]);
      if (args[0] === 'spawn') return '9';
      if (args[0] === 'get-text') return '$ ';
      return '';
    },
    async () => null,
  );
  const directory = await mkdtemp(join(tmpdir(), 'term-dad-ergonomics-'));
  const app = createServer(
    backend,
    undefined,
    { automatic: false },
    new EventQueue(new FileEventStorage(directory)),
    new MemoryWorkerStorage(),
    new MemoryTaskStorage(),
  );
  const [a, b] = InMemoryTransport.createLinkedPair(),
    client = new Client({ name: 'ergonomics', version: '1' });
  await app.server.connect(a);
  await client.connect(b);
  t.after(async () => {
    await client.close();
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await raw(name, args);
    assert.notEqual(r.isError, true, JSON.stringify(r));
    return JSON.parse((r.content as { text: string }[])[0].text);
  };
  const fails = async (name: string, args: Record<string, unknown>, pattern: RegExp) => {
    const r = await raw(name, args);
    assert.equal(r.isError, true, `${name} accepted ${JSON.stringify(args)}`);
    assert.match((r.content as { text: string }[])[0].text, pattern);
  };
  const sent = () => calls.filter((c) => c.args[0] === 'send-text');
  return { calls, call, fails, sent };
}

test('terminal.close and terminal.focus accept paneId as well as target plus id', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.call('terminal.close', { paneId: 7 }), { closed: [7] });
  assert.ok(f.calls.some((c) => c.args[0] === 'kill-pane' && c.args.includes('7')));
  await f.call('terminal.focus', { paneId: 7 });
  assert.ok(f.calls.some((c) => c.args[0] === 'activate-pane'));
  await f.fails('terminal.close', {}, /id/);
  await f.fails('terminal.close', { id: 7, paneId: 8 }, /ARGUMENT_CONFLICT/);
});
test('agent.send and agent.broadcast accept message as an alias of text', async (t) => {
  const f = await fixture(t);
  const { agentId } = await f.call('agent.adopt', { name: 'w', cli: 'shell', paneId: 7 });
  const result = await f.call('agent.send', { agentId, message: 'hello' });
  assert.equal(result.sent, true);
  assert.equal(f.sent()[0].input, 'hello');
  await f.fails('agent.send', { agentId }, /text/);
  const outcomes = await f.call('agent.broadcast', { agentIds: [agentId], message: 'again' });
  assert.equal(outcomes[0].sent, true);
});
test('terminal.submit without text presses Enter only', async (t) => {
  const f = await fixture(t);
  await f.call('terminal.submit', { paneId: 7 });
  const sent = f.sent();
  assert.equal(sent.length, 1, 'nothing is pasted before the Enter');
  assert.equal(sent[0].input, '\r');
  assert.ok(sent[0].args.includes('--no-paste'));
});
test('spawn tools accept a command string and split it into argv without a shell', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.call('terminal.spawn', { command: 'zsh -l -c "echo hi there"' }), 9);
  const spawn = f.calls.find((c) => c.args[0] === 'spawn')!;
  assert.deepEqual(spawn.args.slice(spawn.args.indexOf('--') + 1), ['zsh', '-l', '-c', 'echo hi there']);
  await f.fails('terminal.spawn', { command: '"unterminated' }, /quote/);
  await f.fails('terminal.spawn', { command: '   ' }, /command/);
});
test('event.acknowledge accepts eventIds as an alias of ids', async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  assert.deepEqual((await f.call('event.acknowledge', { eventIds: [id] })).unknownIds, [id]);
  await f.fails('event.acknowledge', {}, /ids/);
});
test('terminal.send_key accepts everyday key spellings', async (t) => {
  const f = await fixture(t);
  for (const [key, bytes] of [
    ['Ctrl+C', '\x03'],
    ['ctrl-c', '\x03'],
    ['Page Down', '\x1b[6~'],
    ['PgUp', '\x1b[5~'],
    ['Space', ' '],
    ['Enter', '\r'],
    ['Escape', '\x1b'],
    ['Tab', '\t'],
    ['Down', '\x1b[B'],
  ] as const) {
    await f.call('terminal.send_key', { paneId: 7, key });
    assert.equal(f.sent().at(-1)!.input, bytes, key);
  }
  await f.fails('terminal.send_key', { paneId: 7, key: 'Bogus' }, /Unsupported key/);
});

test('historical read and send aliases normalize before defaults and reject conflicts', async (t) => {
  const f = await fixture(t);
  await f.call('terminal.read', { pane_id: 7, max_lines: 12 });
  assert.ok(f.calls.some((c) => c.args[0] === 'get-text' && c.args.includes('-12')));
  await f.call('terminal.read', { paneId: 7, pane_id: 7, lines: 12, max_lines: 12 });
  await f.fails('terminal.read', { paneId: 7, pane_id: 8 }, /ARGUMENT_CONFLICT/);
  await f.fails('terminal.read', { paneId: 7, lines: 12, max_lines: 13 }, /ARGUMENT_CONFLICT/);
  const { agentId } = await f.call('agent.adopt', { name: 'w', cli: 'shell', paneId: 7 });
  await f.call('agent.send', { to: agentId, message: 'hello' });
  const before = f.sent().length;
  await f.fails('agent.send', { agentId, to: 'other', text: 'hello' }, /ARGUMENT_CONFLICT/);
  await f.fails('agent.send', { agentId, text: 'hello', message: 'different' }, /ARGUMENT_CONFLICT/);
  assert.equal(f.sent().length, before);
});

test('close/focus normalize decimal IDs and reject ambiguous targets without side effects', async (t) => {
  const f = await fixture(t);
  await f.call('terminal.focus', { id: 7, paneId: '007' });
  await f.call('terminal.close', { paneId: '7' });
  const before = f.calls.length;
  for (const tool of ['terminal.close', 'terminal.focus']) {
    for (const target of ['tab', 'window']) {
      await f.fails(tool, { target, paneId: 7 }, /ARGUMENT_CONFLICT/);
      await f.fails(tool, { target, id: 7, paneId: 7 }, /ARGUMENT_CONFLICT/);
    }
    for (const id of ['7x', '-1', '1.5', '', '9007199254740992'])
      await f.fails(tool, { id }, /Invalid|invalid|Too big/);
  }
  assert.equal(f.calls.length, before);
});

test('all nine historically rejected keys work through both key tools', async (t) => {
  const f = await fixture(t);
  const keys = ['Enter', 'enter', 'DownArrow', 'down', 'ArrowDown', 'Down', 'escape', 'Escape', 'Tab'];
  const bytes = ['\r', '\r', '\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', '\x1b', '\x1b', '\t'];
  for (const key of keys) await f.call('terminal.send_key', { paneId: 7, key });
  await f.call('terminal.send_keys', { paneId: 7, keys });
  assert.deepEqual(
    f.sent().map((c) => c.input),
    [...bytes, ...bytes],
  );
  assert.ok(f.sent().every((c) => c.args.includes('--no-paste')));
  const before = f.sent().length;
  await f.fails('terminal.send_keys', { paneId: 7, keys: ['Enter', 'Bogus'] }, /UNSUPPORTED_KEY.*ENTER/);
  assert.equal(f.sent().length, before);
});

test('wait aliases convert seconds before validation and defaults', async (t) => {
  const f = await fixture(t);
  const { agentId } = await f.call('agent.adopt', { name: 'w', cli: 'shell', paneId: 7 });
  await f.call('agent.wait_until_idle', { agentId, timeoutSeconds: 0.01 });
  await f.call('agent.wait_for_text', { agentId, text: '$', timeoutMs: 10, timeoutSeconds: 0.01 });
  const outcome = await f.call('event.wait_for_event', { timeoutSeconds: 0.01 });
  assert.equal(outcome.status, 'timeout');
  for (const tool of [
    'agent.wait_for_text',
    'agent.wait_until_idle',
    'agent.wait_for_outcome',
    'event.wait_for_event',
  ]) {
    const args = { agentId, text: '$', turnId: randomUUID() };
    await f.fails(tool, { ...args, timeoutMs: 10, timeoutSeconds: 1 }, /ARGUMENT_CONFLICT/);
    await f.fails(tool, { ...args, timeoutSeconds: 121 }, /120/);
    await f.fails(tool, { ...args, timeoutSeconds: 0.0001 }, /int|integer/);
  }
});
