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
      { name: 'terminal.close', args: { paneIds: [8], expectedInstanceKey: 'benchmark' } },
      { name: 'terminal.list', args: {} },
    ]),
    [],
  );
});
