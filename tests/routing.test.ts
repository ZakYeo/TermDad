import test from 'node:test';
import assert from 'node:assert/strict';
import { routingCases, scoreRouting } from '../scripts/routing-cases.js';
import { benchmarkFixture } from '../scripts/benchmark-fixture.js';
test('routing expectations use real tools and accept capability-based alternatives', async () => {
  const f = await benchmarkFixture();
  try {
    const tools = new Map((await f.client.listTools()).tools.map((t) => [t.name, t]));
    for (const scenario of routingCases)
      for (const name of scenario.allowed) if (name !== 'review.lookup') assert.ok(tools.has(name), name);
    assert.match(tools.get('terminal.list')!.description!, /Start here/);
    const schema = tools.get('terminal.list')!.inputSchema.properties!;
    for (const option of ['verbose', 'includeDetached', 'activity', 'workspace']) assert.ok(option in schema);
    const recovery = routingCases.find((c) => c.id === 'recovery')!;
    assert.deepEqual(scoreRouting(recovery, [{ name: 'agent.list', args: {} }]), []);
    assert.deepEqual(scoreRouting(recovery, [{ name: 'terminal.list', args: { includeDetached: true } }]), []);
  } finally {
    await f.close();
  }
});
test('routing scoring detects padded discovery, absent options and unsafe cleanup sequences', () => {
  assert.ok(scoreRouting(routingCases[0], [{ name: 'terminal.snapshot', args: {} }]).length);
  assert.ok(scoreRouting(routingCases[1], [{ name: 'terminal.list', args: {} }]).length);
  const cleanup = routingCases.find((c) => c.id === 'conditional-close')!;
  assert.ok(scoreRouting(cleanup, [{ name: 'terminal.close', args: { paneIds: [7, 8] } }]).length);
  assert.deepEqual(
    scoreRouting(cleanup, [
      { name: 'terminal.list', args: {} },
      { name: 'review.lookup', args: { repository: 'example/project', number: 42 } },
      { name: 'terminal.close', args: { paneIds: [8], expectedInstanceKey: 'benchmark' }, verifiedBefore: true },
      { name: 'terminal.list', args: {} },
    ]),
    [],
  );
});

test('draft or unavailable external verification never permits cleanup', () => {
  for (const id of ['conditional-draft', 'conditional-unavailable']) {
    const scenario = routingCases.find((c) => c.id === id)!;
    const calls = [
      { name: 'terminal.list', args: {} },
      {
        name: 'review.lookup',
        args: { repository: 'example/project', number: 42 },
        ok: id !== 'conditional-unavailable',
      },
    ];
    assert.deepEqual(scoreRouting(scenario, calls), []);
    assert.ok(scoreRouting(scenario, [...calls, { name: 'terminal.close', args: { paneIds: [8] } }]).length);
  }
});

test('routing scoring accepts read aliases and list plus status activity', () => {
  assert.deepEqual(
    scoreRouting(
      routingCases.find((c) => c.id === 'read')!,
      [{ name: 'terminal.read', args: { pane_id: 7, max_lines: 15 } }],
    ),
    [],
  );
  assert.deepEqual(
    scoreRouting(
      routingCases.find((c) => c.id === 'activity')!,
      [
        { name: 'terminal.list', args: {} },
        { name: 'orchestrator.status', args: {} },
      ],
    ),
    [],
  );
});

test('concurrent mock close cannot masquerade as verified cleanup through completion ordering', async (t) => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const dir = await mkdtemp(join(tmpdir(), 'routing-concurrent-'));
  const log = join(dir, 'calls');
  const client = new Client({ name: 'concurrent-routing-test', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['--import', import.meta.resolve('tsx'), join(process.cwd(), 'scripts/routing-mock.ts'), log],
      stderr: 'pipe',
    }),
  );
  t.after(async () => {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  });
  await client.callTool({ name: 'terminal.list', arguments: {} });
  await Promise.all([
    client.callTool({ name: 'review.lookup', arguments: { repository: 'example/project', number: 42 } }),
    client.callTool({ name: 'terminal.close', arguments: { paneIds: [8], expectedInstanceKey: 'benchmark' } }),
  ]);
  const calls = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(calls.find((c) => c.name === 'terminal.close').verifiedBefore, false);
  assert.ok(
    scoreRouting(
      routingCases.find((c) => c.id === 'conditional-close')!,
      calls,
    ).includes('Close before external verification'),
  );
});
