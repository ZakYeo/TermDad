import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
test('agent.spawn passes canonical cliArgs through MCP schema to terminal argv', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'td-launch-protocol-')),
    log = join(dir, 'argv.jsonl');
  const client = new Client({ name: 'launch-test', version: '1' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['tests/fixtures/worker-server.mjs'],
        env: { ...process.env, TERM_DAD_STATE_DIR: dir, WORKER_TEST_SPAWN_LOG: log } as Record<string, string>,
      }),
    );
    const result = await client.callTool({
      name: 'agent.spawn',
      arguments: { name: 'plan', cli: 'claude', cliArgs: ['--permission-mode', 'plan'] },
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const argv = JSON.parse((await readFile(log, 'utf8')).trim());
    const index = argv.indexOf('--permission-mode');
    assert.ok(index >= 0);
    assert.equal(argv[index + 1], 'plan');
    assert.ok(argv.includes('--settings'));
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('group MCP setup exposes a dynamic waiter and lists only current pending members', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'td-group-protocol-'));
  const client = new Client({ name: 'group-test', version: '1' });
  const { EventQueue, FileEventStorage } = await import('../src/events.js');
  const queue = new EventQueue(new FileEventStorage(dir));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    return JSON.parse((r.content as any)[0].text);
  };
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['tests/fixtures/worker-server.mjs'],
        env: { ...process.env, TERM_DAD_STATE_DIR: dir } as Record<string, string>,
      }),
    );
    const worker = await call('agent.spawn', { name: 'grouped', cli: 'claude' });
    const setup = await call('supervision.create', { name: 'rounds', members: [{ agentId: worker.agentId }] });
    assert.equal(setup.monitoringReady, true);
    assert.equal(setup.waiter.launched, 'unknown');
    assert.match(setup.waiter.example, /--group/);
    const event = await queue.publish({
      agentId: worker.agentId,
      paneId: 7,
      kind: 'input_required',
      occurredAt: new Date().toISOString(),
      summary: 'Input needed.',
    });
    const listed = await call('event.list', { groupId: setup.group.groupId });
    assert.equal(listed.events[0].id, event.id);
    assert.equal(listed.resumeAfterSequence, undefined);
    const invalid = await client.callTool({
      name: 'event.list',
      arguments: { groupId: setup.group.groupId, afterSequence: 0 },
    });
    assert.equal(invalid.isError, true);
    await call('supervision.update', { groupId: setup.group.groupId, expectedRevision: 1, members: [] });
    assert.deepEqual((await call('event.list', { groupId: setup.group.groupId })).events, []);
    assert.equal((await queue.list({}, false)).events[0].id, event.id, 'membership changes never acknowledge');
    await call('supervision.close', { groupId: setup.group.groupId, expectedRevision: 2 });
    assert.equal((await call('event.list', { groupId: setup.group.groupId })).state, 'closed');
  } finally {
    await client.close();
    await queue.close();
    await rm(dir, { recursive: true, force: true });
  }
});
