import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWaitArgs, waitForEvent } from '../src/wait-cli.js';
import { EventQueue, FileEventStorage, type EventInput } from '../src/events.js';
const input = (kind = 'ready', paneId = 7): EventInput => ({
  kind,
  paneId,
  watchId: 'w',
  agentId: 'worker-1',
  occurredAt: new Date().toISOString(),
  summary: 'Worker status changed',
});
async function journal(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'term-dad-wait-'));
  const queue = new EventQueue(new FileEventStorage(directory), 50, 64, Date.now, 0);
  t.after(async () => {
    await queue.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, queue };
}
test('wait-for-event rejects unusable invocations rather than guessing', () => {
  assert.throws(() => parseWaitArgs(['--nonsense']), /WAIT_ARGS_INVALID/);
  assert.throws(() => parseWaitArgs(['--kinds', 'ready,not a kind']), /WAIT_ARGS_INVALID/);
  assert.throws(() => parseWaitArgs(['--panes', 'a,b']), /WAIT_ARGS_INVALID/);
  assert.throws(() => parseWaitArgs(['--timeout-seconds', '0']), /WAIT_ARGS_INVALID/);
  assert.throws(() => parseWaitArgs(['--timeout-seconds', '86401']), /WAIT_ARGS_INVALID/);
  assert.throws(() => parseWaitArgs(['--poll-ms', '10']), /WAIT_ARGS_INVALID/);
  assert.throws(() => parseWaitArgs(['--kinds']), /WAIT_ARGS_INVALID/);
  const parsed = parseWaitArgs(['--kinds', 'ready,attention_required', '--panes', '7,9', '--agents', 'worker-1']);
  assert.deepEqual(parsed.filter, { kinds: ['ready', 'attention_required'], paneIds: [7, 9], agentIds: ['worker-1'] });
  assert.equal(parsed.timeoutSeconds, 1800);
  assert.equal(parsed.pollMs, 2000);
  assert.equal(parsed.fresh, true, 'a waiter never fires on history unless asked');
  assert.equal(parseWaitArgs(['--after-sequence', '0']).fresh, false, 'an explicit sequence is the history drain');
});
test('the external waiter ignores the backlog, returns the first fresh match and acknowledges nothing', async (t) => {
  const { directory, queue } = await journal(t);
  for (const kind of ['ready', 'inactive', 'attention_required']) await queue.publish(input(kind));
  let later: string | undefined;
  // The injected sleep publishes once, after the baseline pass has already read the journal.
  const outcome = await waitForEvent(
    { ...parseWaitArgs(['--kinds', 'attention_required', '--state-dir', directory]), timeoutSeconds: 5 },
    {
      sleep: async () => {
        if (!later) later = (await queue.publish(input('attention_required'))).id;
      },
    },
  );
  assert.equal(outcome.code, 0);
  const result = JSON.parse(outcome.output);
  assert.equal(result.status, 'event');
  assert.equal(result.event.id, later, 'the stale attention_required must not satisfy a fresh waiter');
  assert.equal((await queue.list({}, false, 50)).pendingCount, 4, 'the waiter acknowledged nothing');
  assert.ok(
    JSON.parse(await readFile(join(directory, 'events.json'), 'utf8')).events.every(
      (e: any) => e.acknowledgedAt === null,
    ),
  );
  await assert.rejects(access(join(directory, 'events.lock')), 'a waiter must never take the journal lock');
});
test('an explicit after-sequence drains the pending backlog', async (t) => {
  const { directory, queue } = await journal(t);
  const first = await queue.publish(input());
  const outcome = await waitForEvent(
    { ...parseWaitArgs(['--after-sequence', '0', '--state-dir', directory]), timeoutSeconds: 5 },
    { sleep: async () => {} },
  );
  assert.equal(JSON.parse(outcome.output).event.id, first.id);
});
test('a timed-out waiter reports a timeout without failing, and an absent state directory stays silent', async (t) => {
  const { directory } = await journal(t);
  const empty = await waitForEvent(
    { ...parseWaitArgs(['--state-dir', directory]), timeoutSeconds: 1, pollMs: 250 },
    { sleep: async () => {} },
  );
  assert.deepEqual(empty, { code: 0, output: '{"status":"timeout"}' }, 'a timeout is an outcome, not a failure');
  const missing = join(directory, 'absent');
  const gone = await waitForEvent(
    { ...parseWaitArgs(['--state-dir', missing]), timeoutSeconds: 1, pollMs: 250 },
    { sleep: async () => {} },
  );
  assert.deepEqual(gone, { code: 0, output: '{"status":"timeout"}' });
  await assert.rejects(access(missing), 'reading must never create the state directory');
});
test('a persistently unreadable journal fails explicitly while a momentary one is retried', async (t) => {
  const { directory, queue } = await journal(t);
  const path = join(directory, 'events.json');
  await writeFile(path, '{ broken', { mode: 0o600 });
  // Corruption cannot be transient, so it aborts on the first parse failure rather than
  // retrying for the whole timeout and then sending an operator to recover a healthy file.
  let sleeps = 0;
  const broken = await waitForEvent(
    { ...parseWaitArgs(['--state-dir', directory]), timeoutSeconds: 600, pollMs: 250 },
    {
      sleep: async () => {
        sleeps++;
      },
    },
  );
  assert.equal(broken.code, 4);
  assert.equal(broken.output, '', 'a storage failure writes nothing to stdout');
  assert.equal(sleeps, 0, 'a corrupt journal is not retried for the whole window');
  // A momentarily absent journal is nothing yet, and is retried.
  await rm(path);
  let published: string | undefined;
  const recovered = await waitForEvent(
    { ...parseWaitArgs(['--state-dir', directory]), timeoutSeconds: 5 },
    {
      sleep: async () => {
        if (!published) published = (await queue.publish(input())).id;
      },
    },
  );
  assert.equal(recovered.code, 0);
  assert.equal(JSON.parse(recovered.output).event.id, published);
});
test('a waiter armed before the journal exists receives the first event, but not a restored backlog', async (t) => {
  const { directory, queue } = await journal(t);
  let first: string | undefined;
  const outcome = await waitForEvent(
    { ...parseWaitArgs(['--state-dir', directory]), timeoutSeconds: 5 },
    {
      sleep: async () => {
        if (!first) first = (await queue.publish(input())).id;
      },
    },
  );
  assert.equal(JSON.parse(outcome.output).event.id, first, 'arming on an empty journal must not exclude sequence 1');
  // A journal restored from a backup while a waiter is armed must not fire on its history.
  const restored = await mkdtemp(join(tmpdir(), 'term-dad-wait-restored-'));
  const old = new EventQueue(new FileEventStorage(restored), 50, 64, () => Date.parse('2020-01-01T00:00:00.000Z'), 0);
  await old.publish({
    kind: 'ready',
    paneId: 7,
    watchId: 'w',
    occurredAt: '2020-01-01T00:00:00.000Z',
    summary: 'Worker status changed',
  });
  await old.close();
  const moved = join(restored, 'events.json'),
    aside = join(restored, 'aside.json');
  await rename(moved, aside);
  const backlog = await waitForEvent(
    { ...parseWaitArgs(['--state-dir', restored]), timeoutSeconds: 1, pollMs: 250 },
    {
      sleep: async () => {
        await rename(aside, moved).catch(() => {});
      },
    },
  );
  assert.deepEqual(backlog, { code: 0, output: '{"status":"timeout"}' }, 'restored history is not a fresh event');
  await rm(restored, { recursive: true, force: true });
});
test('--until-event re-arms itself: no bounded timeout, only the hard cap, and an explicit timeout is refused', () => {
  const parsed = parseWaitArgs(['--kinds', 'attention_required', '--until-event']);
  assert.equal(parsed.untilEvent, true);
  assert.equal(parsed.timeoutSeconds, 86400, 'the cap exists so an orphaned waiter cannot outlive a day');
  assert.equal(parseWaitArgs(['--kinds', 'ready']).untilEvent, false);
  assert.throws(
    () => parseWaitArgs(['--until-event', '--timeout-seconds', '5']),
    /WAIT_ARGS_INVALID/,
    'the mode means do not time out',
  );
  assert.throws(() => parseWaitArgs(['--until-event', 'yes']), /WAIT_ARGS_INVALID/, 'a boolean flag takes no value');
});
test('an event published during the final poll interval is returned, not reported as a timeout', async (t) => {
  const { directory, queue } = await journal(t);
  // The clock crosses the deadline while the waiter sleeps; the event lands in that same sleep.
  let clock = 0,
    published: string | undefined;
  const outcome = await waitForEvent(
    { ...parseWaitArgs(['--state-dir', directory]), timeoutSeconds: 1, pollMs: 250 },
    {
      now: () => clock,
      sleep: async () => {
        clock = 5000;
        if (!published) published = (await queue.publish(input())).id;
      },
    },
  );
  assert.equal(outcome.code, 0);
  assert.equal(JSON.parse(outcome.output).status, 'event', 'the last read happens after the last sleep');
  assert.equal(JSON.parse(outcome.output).event.id, published);
});
test('a flag followed by another option is a missing value, never a value that happens to spell an option', () => {
  assert.throws(() => parseWaitArgs(['--kinds', '--until-event']), /WAIT_ARGS_INVALID: --kinds needs a value/);
  assert.throws(
    () => parseWaitArgs(['--state-dir', '--kinds', 'ready']),
    /WAIT_ARGS_INVALID: --state-dir needs a value/,
  );
});
test('the reported wake command warns when its entry point does not exist beside the running module', async () => {
  // Under tsx this module runs from src/, where no index.js exists; the built server has one.
  const { wakeCommand } = await import('../src/event-tools.js');
  const wake = wakeCommand('/tmp/state');
  assert.match(wake.command[1], /index\.js$/);
  assert.match(wake.warning ?? '', /entry point/, 'a supervisor must not be handed a path that cannot run');
});
