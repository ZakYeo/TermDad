import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventQueue, FileEventStorage } from '../src/events.js';
import { FileSupervisionStorage, type SupervisionGroup } from '../src/supervision-storage.js';
import { parseWaitArgs, waitForEvent } from '../src/wait-cli.js';
import { wakeCommand } from '../src/event-tools.js';
async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'td-group-wait-')),
    queue = new EventQueue(new FileEventStorage(dir)),
    storage = new FileSupervisionStorage(dir);
  const group: SupervisionGroup = { groupId: randomUUID(), name: 'rounds', revision: 1, state: 'active', members: [] };
  const save = () => storage.transaction(true, () => ({ state: { version: 1, groups: [group] }, result: undefined }));
  await save();
  t.after(async () => {
    await queue.close();
    await rm(dir, { recursive: true, force: true });
  });
  const args = parseWaitArgs(['--group', group.groupId, '--state-dir', dir, '--kinds', 'input_required,ready']);
  const publish = (agentId: string) =>
    queue.publish({
      agentId,
      paneId: 1,
      kind: 'input_required',
      occurredAt: new Date().toISOString(),
      summary: 'Input needed.',
    });
  return { dir, queue, group, save, args, publish };
}
test('armed group waiter follows new members and earlier pending events without a cursor', async (t) => {
  const f = await fixture(t),
    first = randomUUID(),
    second = randomUUID();
  const unrelated = await f.publish(first),
    pending = await f.publish(second);
  let polls = 0;
  const result = await waitForEvent(f.args, {
    sleep: async () => {
      polls++;
      f.group.members = [{ agentId: second, allowPolling: false }];
      f.group.revision++;
      await f.save();
    },
  });
  assert.equal(polls, 1, 'empty group must never match unrelated events');
  assert.equal(JSON.parse(result.output).event.id, pending.id);
  assert.equal(
    (await f.queue.list({}, false)).events.some((e) => e.id === unrelated.id),
    true,
  );
  await assert.rejects(access(join(f.dir, 'supervision.lock')));
});
test('removed members stop matching; events during handling survive acknowledgment and rearming', async (t) => {
  const f = await fixture(t),
    a = randomUUID(),
    b = randomUUID();
  f.group.members = [{ agentId: a, allowPolling: false }];
  await f.save();
  const first = await f.publish(a);
  assert.equal(JSON.parse((await waitForEvent(f.args)).output).event.id, first.id);
  const between = await f.publish(a);
  await f.queue.acknowledge([first.id]);
  assert.equal(JSON.parse((await waitForEvent(f.args)).output).event.id, between.id);
  f.group.members = [{ agentId: b, allowPolling: false }];
  await f.save();
  const next = await f.publish(b);
  assert.equal(JSON.parse((await waitForEvent(f.args)).output).event.id, next.id);
});
test('closed groups terminate while missing and corrupt membership fail visibly', async (t) => {
  const f = await fixture(t);
  f.group.state = 'closed';
  await f.save();
  assert.equal(JSON.parse((await waitForEvent(f.args)).output).status, 'group_closed');
  await writeFile(join(f.dir, 'supervision.json'), '{broken', { mode: 0o600 });
  assert.equal((await waitForEvent(f.args)).code, 4);
  await rm(join(f.dir, 'supervision.json'));
  assert.equal(JSON.parse((await waitForEvent(f.args)).output).error, 'SUPERVISION_STATE_UNREADABLE');
});
test('group mode rejects fixed scope and sequence filters and emits canonical dynamic command', () => {
  const groupId = randomUUID();
  for (const [flag, value] of [
    ['--agents', 'a'],
    ['--accounts', 'a'],
    ['--watches', 'a'],
    ['--panes', '1'],
    ['--after-sequence', '0'],
    ['--max-age-seconds', '5'],
  ])
    assert.throws(() => parseWaitArgs(['--group', groupId, flag, value]), /WAIT_ARGS_INVALID/);
  assert.throws(() => parseWaitArgs(['--group', 'oops']), /WAIT_ARGS_INVALID/);
  const cmd = wakeCommand('/tmp/test', process.execPath, { groupId });
  assert.match(cmd.example, new RegExp(`--group ${groupId}`));
  assert.doesNotMatch(cmd.example, /--agents|--after-sequence/);
  assert.throws(
    () => wakeCommand('/tmp/test', process.execPath, { groupId, afterSequence: 0 }),
    /SUPERVISION_FILTER_INVALID/,
  );
});

test('candidate events are fenced against concurrent membership removal or closure', async (t) => {
  for (const closed of [false, true]) {
    const f = await fixture(t),
      agentId = randomUUID();
    f.group.members = [{ agentId, allowPolling: false }];
    await f.save();
    const event = await f.publish(agentId);
    let reads = 0,
      now = 0;
    const result = await waitForEvent(
      { ...f.args, timeoutSeconds: 1 },
      {
        now: () => now,
        sleep: async () => {
          now += 1000;
        },
        readGroup: async () => {
          reads++;
          return reads === 1
            ? structuredClone(f.group)
            : { ...f.group, revision: 2, state: closed ? 'closed' : 'active', members: [] };
        },
      },
    );
    assert.equal(JSON.parse(result.output).status, closed ? 'group_closed' : 'timeout');
    assert.equal((await f.queue.list({}, false)).events[0].id, event.id);
  }
});
test('MCP group list retries membership changes and never leaks removed candidates', async (t) => {
  const f = await fixture(t),
    agentId = randomUUID();
  f.group.members = [{ agentId, allowPolling: false }];
  await f.save();
  await f.publish(agentId);
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { registerEventTools } = await import('../src/event-tools.js');
  const server = new McpServer({ name: 'group-fence', version: '1' });
  let reads = 0;
  const close = registerEventTools(server, f.queue, undefined, {
    get: async () => (++reads === 1 ? structuredClone(f.group) : { ...f.group, revision: 2, members: [] }),
  });
  const client = new Client({ name: 'group-fence', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const result = await client.callTool({ name: 'event.list', arguments: { groupId: f.group.groupId } });
    assert.notEqual(result.isError, true);
    const listed = JSON.parse((result.content as any)[0].text);
    assert.deepEqual(listed.events, []);
    assert.equal(listed.groupRevision, 2);
    assert.ok(reads >= 4);
  } finally {
    await client.close();
    await server.close();
    await close();
  }
});
