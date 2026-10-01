import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageService } from '../src/usage.js';
import { FileUsageStorage } from '../src/usage-storage.js';
import { EventQueue, FileEventStorage } from '../src/events.js';
import { usageHook, claudeUsageFeed, claimUsageResume } from '../src/usage-hooks.js';
import { normalizeCodex, normalizeClaude, defaultUsageProviders } from '../src/usage-providers.js';
import { parseWaitArgs, waitForEvent } from '../src/wait-cli.js';
import type { UsageObservation } from '../src/usage-model.js';

async function fixture(t: any, automatic = false) {
  const dir = await mkdtemp(join(tmpdir(), 'term-dad-usage-'));
  let now = 1_800_000_000_000;
  const events = new EventQueue(new FileEventStorage(dir));
  const providers = defaultUsageProviders(() => now);
  let calls = 0;
  let sample: UsageObservation;
  if (automatic)
    providers.codex.capabilities = {
      refresh: true,
      identity: true,
      pause: true,
      wake: true,
      verified: true,
      reason: 'Injected test adapter, not live evidence',
    };
  providers.codex.read = async () => {
    calls++;
    return sample;
  };
  const usage = new UsageService(new FileUsageStorage(dir), events, providers, () => now);
  const observation = (short: number, weekly = 10, reset = now + 18000_000): UsageObservation => ({
    observedAt: now,
    identity: 'test-account',
    source: 'fixture',
    windows: [
      { bucketId: 'all', kind: 'five_hour', usedPercent: short, windowSeconds: 18000, resetsAt: reset },
      { bucketId: 'all', kind: 'weekly', usedPercent: weekly, windowSeconds: 604800, resetsAt: now + 604800_000 },
    ],
  });
  sample = observation(10);
  t.after(async () => {
    await usage.close();
    await events.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    events,
    usage,
    providers,
    observation,
    advance: (ms: number) => {
      now += ms;
    },
    sample: (o: UsageObservation) => {
      sample = o;
    },
    calls: () => calls,
    now: () => now,
  };
}

test('warnings deduplicate across instances, restart, and threshold jitter', async (t) => {
  const f = await fixture(t);
  await f.usage.configure({ accountRef: 'personal', provider: 'codex' });
  await f.usage.ingest('personal', f.observation(82));
  await f.usage.ingest('personal', f.observation(79));
  const peer = new UsageService(new FileUsageStorage(f.dir), f.events, f.providers, f.now);
  await peer.ingest('personal', f.observation(81));
  assert.equal((await f.events.list()).pendingCount, 1);
  await peer.ingest('personal', f.observation(77));
  await peer.ingest('personal', f.observation(80));
  assert.equal((await f.events.list()).pendingCount, 2);
  await peer.close();
});

test('automatic mode is unavailable unless all capabilities are verified', async (t) => {
  const f = await fixture(t);
  for (const provider of ['claude', 'codex', 'copilot'])
    await assert.rejects(
      f.usage.configure({ accountRef: provider, provider, mode: 'automatic' }),
      /AUTOMATIC_UNAVAILABLE/,
    );
  assert.equal((await f.usage.accounts()).length, 0);
});

test('95% gates dispatch; reset with low weekly stays paused; fresh healthy data permits one resume', async (t) => {
  const f = await fixture(t, true);
  await f.usage.configure({ accountRef: 'personal', provider: 'codex', mode: 'automatic' });
  await f.usage.ingest('personal', f.observation(94));
  const hook = { session_id: 'supervisor', hook_event_name: 'SessionStart' };
  await usageHook(f.usage, 'personal', 'codex', hook);
  await f.usage.ingest('personal', f.observation(95));
  await assert.rejects(f.usage.assertDispatch(undefined, 'personal'), /USAGE_PAUSED/);
  assert.equal(
    ((await usageHook(f.usage, 'personal', 'codex', { ...hook, hook_event_name: 'Stop' })) as any).continue,
    false,
  );
  assert.equal((await f.usage.account('personal')).phase, 'paused');
  f.advance(18000_001);
  await assert.rejects(f.usage.assertDispatch(undefined, 'personal'), /USAGE_PAUSED/);
  await f.usage.ingest('personal', f.observation(1, 96));
  assert.equal((await f.usage.account('personal')).phase, 'paused');
  await f.usage.ingest('personal', f.observation(1, 94));
  const a = await f.usage.account('personal');
  assert.equal(a.phase, 'resume_pending');
  assert.equal(await claimUsageResume(f.usage, 'personal', a.sessions[0].id), true);
  assert.equal(await claimUsageResume(f.usage, 'personal', a.sessions[0].id), false);
  await f.usage.assertDispatch(undefined, 'personal');
});

test('stale, missing weekly, and expired reset readings cannot authorize resume', async (t) => {
  const f = await fixture(t, true);
  await f.usage.configure({ accountRef: 'a', provider: 'codex', mode: 'automatic' });
  await f.usage.ingest('a', f.observation(10));
  await f.usage.assertDispatch(undefined, 'a');
  f.advance(120001);
  await assert.rejects(f.usage.assertDispatch(undefined, 'a'), /stale/);
  const missing = f.observation(1);
  missing.windows.pop();
  await f.usage.ingest('a', missing);
  await assert.rejects(f.usage.assertDispatch(undefined, 'a'), /weekly_unavailable/);
  await f.usage.ingest('a', f.observation(1, 1, f.now() - 1));
  await assert.rejects(f.usage.assertDispatch(undefined, 'a'), /reset_unconfirmed/);
});

test('hook delivery is per session; cancellation prevents continuation', async (t) => {
  const f = await fixture(t, true);
  await f.usage.configure({ accountRef: 'a', provider: 'codex', mode: 'automatic' });
  await f.usage.ingest('a', f.observation(95));
  for (const session_id of ['one', 'two']) {
    const input = { session_id, hook_event_name: 'PostToolUse' };
    assert.ok(((await usageHook(f.usage, 'a', 'codex', input)) as any).hookSpecificOutput);
    await usageHook(f.usage, 'a', 'codex', { ...input, hook_event_name: 'Stop' });
  }
  await usageHook(f.usage, 'a', 'codex', { session_id: 'one', hook_event_name: 'SessionEnd' });
  await f.usage.ingest('a', f.observation(1));
  const a = await f.usage.account('a');
  assert.equal(await claimUsageResume(f.usage, 'a', a.sessions[0].id), false);
  assert.equal(await claimUsageResume(f.usage, 'a', a.sessions[1].id), true);
});

test('refresh is rate-limited and shared collector ownership excludes concurrent reads', async (t) => {
  const f = await fixture(t);
  await f.usage.configure({ accountRef: 'a', provider: 'codex' });
  const peer = new UsageService(new FileUsageStorage(f.dir), f.events, f.providers, f.now);
  const results = await Promise.allSettled([f.usage.refresh('a'), peer.refresh('a')]);
  assert.ok(results.some((r) => r.status === 'fulfilled'));
  await f.usage.refresh('a');
  assert.equal(f.calls(), 1);
  f.advance(60000);
  await f.usage.refresh('a');
  assert.equal(f.calls(), 2);
  await peer.close();
});

test('Claude redraws do not refresh stale data and absent fields stay unknown', async (t) => {
  const f = await fixture(t);
  await f.usage.configure({ accountRef: 'claude', provider: 'claude' });
  const input = { rate_limits: { five_hour: { used_percentage: 80, resets_at: Math.floor(f.now() / 1000) + 18000 } } };
  await claudeUsageFeed(f.usage, 'claude', input);
  f.advance(120001);
  await claudeUsageFeed(f.usage, 'claude', input);
  assert.equal((await f.usage.status('claude')).accounts[0].freshness, 'stale');
  assert.equal(normalizeClaude({}, f.now()), null);
  await assert.rejects(f.usage.refresh('claude'), /UNSUPPORTED/);
});

test('Codex windows use actual durations and preserve independent buckets', () => {
  const o = normalizeCodex(
    {
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 95, windowDurationMins: 300, resetsAt: 100 } },
        other: { primary: { usedPercent: 12, windowDurationMins: 15, resetsAt: 100 } },
      },
    },
    0,
    null,
  );
  assert.deepEqual(
    o.windows.map((w) => w.kind),
    ['five_hour', 'other'],
  );
});

test('scheduler retries failed reads with backoff without moving the deadline on each tick', async (t) => {
  const f = await fixture(t, true);
  await f.usage.configure({ accountRef: 'a', provider: 'codex', mode: 'automatic' });
  let calls = 0;
  f.providers.codex.read = async () => {
    calls++;
    throw new Error('sensitive provider failure');
  };
  f.advance(60000);
  await f.usage.tick();
  assert.equal(calls, 1);
  for (let i = 0; i < 59; i++) {
    f.advance(1000);
    await f.usage.tick();
  }
  assert.equal(calls, 1);
  f.advance(1000);
  await f.usage.tick();
  assert.equal(calls, 2);
  assert.equal((await f.usage.account('a')).nextCheckAt, f.now() + 120000);
  assert.ok(!JSON.stringify(await f.usage.status()).includes('sensitive'));
});

test('unwatch preserves policy and account identity changes cannot silently rebind', async (t) => {
  const f = await fixture(t, true);
  await f.usage.configure({ accountRef: 'a', provider: 'codex', mode: 'automatic' });
  await f.usage.ingest('a', f.observation(95));
  await f.usage.unwatch('a');
  await assert.rejects(f.usage.assertDispatch(undefined, 'a'), /USAGE_PAUSED/);
  await f.usage.ingest('a', { ...f.observation(1), identity: 'different-account' });
  assert.equal((await f.usage.account('a')).observation!.identity, 'test-account');
  await assert.rejects(f.usage.assertDispatch(undefined, 'a'), /account_identity_changed/);
});

test('reconfigured source discards an in-flight observation from the old source', async (t) => {
  const f = await fixture(t);
  await f.usage.configure({ accountRef: 'a', provider: 'codex' });
  const revision = (await f.usage.account('a')).revision;
  await f.usage.configure({ accountRef: 'a', provider: 'claude' });
  await f.usage.ingest('a', f.observation(90), revision);
  assert.equal((await f.usage.account('a')).observation, null);
});

test('event queue failure keeps a durable warning outbox for retry', async (t) => {
  const f = await fixture(t);
  await f.usage.configure({ accountRef: 'a', provider: 'codex' });
  const publish = f.events.publish.bind(f.events);
  f.events.publish = async () => {
    throw new Error('offline');
  };
  await assert.rejects(f.usage.ingest('a', f.observation(82)), /offline/);
  assert.equal((await f.usage.account('a')).pending.length, 1);
  f.events.publish = publish;
  await f.usage.flush();
  assert.equal((await f.usage.account('a')).pending.length, 0);
  assert.equal((await f.events.list({ accountRefs: ['a'] })).pendingCount, 1);
});

test('maximum window and threshold configuration fits a bounded warning batch', async (t) => {
  const f = await fixture(t);
  await f.usage.configure({ accountRef: 'a', provider: 'codex' });
  await f.usage.watch({ accountRef: 'a', thresholdsUsedPercent: [10, 20, 30, 40, 50, 60, 70, 80, 90, 95] });
  const o = f.observation(99);
  o.windows = Array.from({ length: 32 }, (_, n) => ({ ...o.windows[0], bucketId: `bucket-${n}` }));
  await f.usage.ingest('a', o);
  assert.equal((await f.events.list()).pendingCount, 32);
  await f.usage.ingest('a', o);
  assert.equal((await f.events.list()).pendingCount, 32);
});

test('legacy events survive new account events and standalone account filters', async (t) => {
  const f = await fixture(t);
  const legacy = {
    version: 1,
    nextSequence: 2,
    events: [
      {
        id: '4ed756d2-1b53-403b-97e4-b293458b432f',
        sequence: 1,
        acknowledgedAt: null,
        kind: 'ready',
        paneId: 7,
        occurredAt: new Date().toISOString(),
        summary: 'Worker ready',
      },
    ],
  };
  await writeFile(join(f.dir, 'events.json'), JSON.stringify(legacy), { mode: 0o600 });
  const input = {
    kind: 'usage.threshold',
    accountRef: 'a',
    deliveryKey: 'test',
    occurredAt: new Date().toISOString(),
    summary: 'Usage warning',
  };
  const e = await f.events.publish(input);
  assert.equal((await f.events.publish(input)).id, e.id);
  assert.equal((await f.events.list()).events[0].id, legacy.events[0].id);
  assert.equal(JSON.parse(await readFile(join(f.dir, 'events.json'), 'utf8')).version, 2);
  const result = await waitForEvent(parseWaitArgs(['--accounts', 'a', '--after-sequence', '1', '--state-dir', f.dir]));
  assert.equal(JSON.parse(result.output).event.id, e.id);
});
