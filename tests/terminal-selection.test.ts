import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { WezTermBackend, type TerminalBackend } from '../src/backend.js';
import { MemoryWorkerStorage } from '../src/worker-storage.js';
import { MemoryTaskStorage } from '../src/task-storage.js';
import { TerminalSelectionGate } from '../src/terminal-selection.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test('selection gate excludes switches during operations, excludes operations during switches, and releases on failure', async () => {
  const gate = new TerminalSelectionGate(),
    pending = deferred();
  const operation = gate.run(false, () => pending.promise);
  await assert.rejects(
    gate.run(true, async () => {}),
    /TERMINAL_BUSY/,
  );
  await gate.run(false, async () => {});
  pending.resolve();
  await operation;
  const selecting = deferred(),
    selection = gate.run(true, () => selecting.promise);
  await assert.rejects(
    gate.run(false, async () => {}),
    /TERMINAL_BUSY/,
  );
  await assert.rejects(
    gate.run(true, async () => {}),
    /TERMINAL_BUSY/,
  );
  selecting.resolve();
  await selection;
  await assert.rejects(
    gate.run(true, async () => {
      throw new Error('failed');
    }),
    /failed/,
  );
  await gate.run(false, async () => {});
});

test('MCP selection preserves workers and prevents crossing instances during submit or watches', async (t) => {
  const identities = [
    { key: 'one', endpoint: 'one', pid: 1, title: 'First' },
    { key: 'two', endpoint: 'two', pid: 2, title: 'Second' },
  ];
  let selected = identities[0],
    hold = false;
  const entered = deferred(),
    release = deferred(),
    inputs: { key: string; text: string }[] = [];
  const backend: TerminalBackend = new WezTermBackend(
    async (args, input) => {
      if (args[0] === 'list')
        return JSON.stringify([
          { pane_id: 7, tab_id: 1, window_id: 1, title: 'shell', cwd: '/', size: { rows: 24, cols: 80 } },
        ]);
      if (args[0] === 'get-text') return '$ ';
      if (args[0] === 'send-text') {
        inputs.push({ key: selected.key, text: input! });
        if (hold) {
          entered.resolve();
          await release.promise;
        }
      }
      return '';
    },
    async () => ({ key: selected.key, endpoint: selected.endpoint }),
  );
  backend.listInstances = async () => identities;
  backend.selectInstance = async (key) => {
    const next = identities.find((i) => i.key === key);
    if (!next) throw new Error('missing GUI');
    selected = next;
    return selected;
  };
  const app = createServer(
    backend,
    undefined,
    { automatic: false },
    undefined,
    new MemoryWorkerStorage(),
    new MemoryTaskStorage(),
  );
  const [a, b] = InMemoryTransport.createLinkedPair(),
    client = new Client({ name: 'selection-test', version: '1' });
  await app.server.connect(a);
  await client.connect(b);
  t.after(async () => {
    release.resolve();
    await client.close();
    await app.server.close();
    await app.watches.dispose();
    await app.events.close();
  });
  const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await raw(name, args);
    assert.notEqual(r.isError, true, JSON.stringify(r));
    return JSON.parse((r.content as { text: string }[])[0].text);
  };
  assert.equal((await call('terminal.list_instances')).selected.key, 'one');
  await call('agent.adopt', { name: 'worker', cli: 'shell', paneId: 7 });
  hold = true;
  const submit = call('terminal.submit', { paneId: 7, text: 'literal' });
  await entered.promise;
  assert.equal((await raw('terminal.select_instance', { key: 'two' })).isError, true);
  hold = false;
  release.resolve();
  await submit;
  assert.deepEqual(inputs, [
    { key: 'one', text: 'literal' },
    { key: 'one', text: '\r' },
  ]);
  const watch = await call('watch.create', { paneId: 7, adapter: 'shell' });
  assert.equal((await raw('terminal.select_instance', { key: 'two' })).isError, true);
  await call('watch.remove', { watchId: watch.watchId });
  await call('terminal.select_instance', { key: 'two' });
  assert.equal((await call('agent.list'))[0].attachment, 'detached');
  assert.equal((await raw('agent.send', { agentId: 'worker', text: 'must not send' })).isError, true);
  assert.equal(inputs.length, 2);
  assert.equal((await raw('terminal.select_instance', { key: 'missing' })).isError, true);
  assert.equal((await call('terminal.list_instances')).selected.key, 'two');
  await call('terminal.select_instance', { key: 'one' });
  assert.equal((await call('agent.list'))[0].attachment, 'attached');
});
