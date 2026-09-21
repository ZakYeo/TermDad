import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { benchmarkFixture } from '../scripts/benchmark-fixture.js';
import { prepareScaling, scalingPass, toolWorkflow } from '../scripts/benchmark-measure.js';
import { scenarios } from '../scripts/benchmark-scenarios.js';
import type { Metric } from '../src/telemetry.js';

// Measured September 2026 with the fixed 100-line fixture. These are explicit ceilings,
// not auto-generated snapshots: review any increase, and tighten after an optimization.
const budgets = {
  1: { statusBytes: 950, collectBytes: 1900, snapshotBytes: 8600, statusCalls: 5, snapshotCalls: 8, watchCalls: 5 },
  5: {
    statusBytes: 4400,
    collectBytes: 9300,
    snapshotBytes: 30000,
    statusCalls: 17,
    snapshotCalls: 24,
    watchCalls: 25,
  },
  10: {
    statusBytes: 8800,
    collectBytes: 18600,
    snapshotBytes: 56500,
    statusCalls: 32,
    snapshotCalls: 44,
    watchCalls: 50,
  },
};
for (const count of [1, 5, 10] as const)
  test(`response and backend-call budgets for ${count} simulated workers`, async () => {
    const f = await benchmarkFixture();
    try {
      const rows = await scalingPass(f, await prepareScaling(f, count));
      const budget = budgets[count];
      const limits: Record<string, [number, number]> = {
        'observe.unchanged': [1000, 3],
        'observe.append': [1024, 3],
        'observe.full': [1800, 3],
        'orchestrator.status': [budget.statusBytes, budget.statusCalls],
        'agent.collect_results': [budget.collectBytes, budget.statusCalls],
        'terminal.snapshot': [budget.snapshotBytes, budget.snapshotCalls],
        'watch.poll': [14, budget.watchCalls],
      };
      for (const row of rows) {
        const [bytes, calls] = limits[row.tool];
        assert.ok(row.responseBytes <= bytes, `${row.tool}: ${row.responseBytes} bytes exceeds ${bytes}`);
        const total = Object.values(row.operations).reduce((sum, n) => sum + n, 0);
        assert.ok(total <= calls, `${row.tool}: ${total} calls exceeds ${calls}`);
      }
      assert.ok(
        rows.find((s) => s.tool === 'observe.unchanged')!.responseBytes <
          rows.find((s) => s.tool === 'observe.full')!.responseBytes,
      );
    } finally {
      await f.close();
    }
  });
test('scenario registry exercises every MCP tool and telemetry records each once', async () => {
  const metrics: Metric[] = [];
  const f = await benchmarkFixture({ record: (metric) => metrics.push(metric) });
  try {
    const samples = await toolWorkflow(f);
    assert.equal(samples.length, 53);
    assert.deepEqual(
      metrics.map((m) => m.tool),
      scenarios.map((s) => s.tool),
    );
    assert.equal(metrics.filter((m) => m.outcome === 'timeout').length, 1);
    assert.equal(metrics.filter((m) => m.outcome === 'error').length, 0);
  } finally {
    await f.close();
  }
});
test('disabled telemetry creates no telemetry files', async () => {
  const f = await benchmarkFixture(false);
  try {
    await f.call('terminal.list');
    await assert.rejects(readdir(join(f.directory, 'telemetry')), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

test('default telemetry writes locally and environment opt-out leaves no files', async () => {
  const original = process.env.TERM_DAD_TELEMETRY;
  try {
    for (const enabled of [true, false]) {
      if (enabled) delete process.env.TERM_DAD_TELEMETRY;
      else process.env.TERM_DAD_TELEMETRY = '0';
      const f = await benchmarkFixture('default');
      try {
        await f.call('terminal.list');
        await f.app.dispose();
        if (enabled) assert.ok((await readdir(join(f.directory, 'telemetry'))).some((name) => name.endsWith('.jsonl')));
        else await assert.rejects(readdir(join(f.directory, 'telemetry')), { code: 'ENOENT' });
      } finally {
        await f.close();
      }
    }
  } finally {
    if (original === undefined) delete process.env.TERM_DAD_TELEMETRY;
    else process.env.TERM_DAD_TELEMETRY = original;
  }
});
