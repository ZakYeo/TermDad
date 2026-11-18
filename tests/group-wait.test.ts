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
