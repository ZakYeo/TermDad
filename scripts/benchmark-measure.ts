import assert from 'node:assert/strict';
import { resultMetadata } from '../src/telemetry.js';
import { percentile } from '../src/telemetry-report.js';
import { screen, type Fixture } from './benchmark-fixture.js';
import { scenarios, type ScenarioContext } from './benchmark-scenarios.js';

export interface Sample {
  tool: string;
  roundTripMs: number;
  responseBytes: number;
  textBytes: number;
  outcome: string;
  operations: Record<string, number>;
}
export async function measure(f: Fixture, tool: string, operation: () => Promise<unknown>) {
  const before = f.calls.length,
    start = performance.now();
  const result = await operation();
  const roundTripMs = performance.now() - start;
  const operations: Record<string, number> = {};
  for (const call of f.calls.slice(before)) operations[call] = (operations[call] ?? 0) + 1;
  const metadata = resultMetadata(result);
  return {
    result,
    sample: {
      tool,
      roundTripMs,
      responseBytes: metadata.responseBytes,
      textBytes: metadata.textBytes,
      outcome: metadata.outcome,
      operations,
    },
  };
}
export async function toolWorkflow(f: Fixture) {
  assert.deepEqual(
    (await f.client.listTools()).tools.map((t) => t.name).sort(),
    scenarios.map((s) => s.tool).sort(),
    'Every registered tool needs exactly one benchmark scenario',
  );
  const context: ScenarioContext = {},
    samples: Sample[] = [];
  for (const scenario of scenarios) {
    await scenario.setup?.(f, context);
    const { result, sample } = await measure(f, scenario.tool, () => f.raw(scenario.tool, scenario.args(context)));
    assert.equal(sample.outcome, scenario.expected ?? 'success', `${scenario.tool}: ${JSON.stringify(result)}`);
    const content = (result as any).content;
    scenario.save?.(context, content[0]?.type === 'text' ? JSON.parse(content[0].text) : result);
    samples.push(sample);
  }
  return samples;
}
export function sampleSummary(samples: Sample[]) {
  const tools = [...new Set(samples.map((s) => s.tool))].sort();
  return tools.map((tool) => {
    const rows = samples.filter((s) => s.tool === tool),
      times = rows.map((s) => s.roundTripMs).sort((a, b) => a - b);
    const maximum = (fn: (sample: Sample) => number) => rows.reduce((max, row) => Math.max(max, fn(row)), 0);
    const operations: Record<string, number> = {};
    for (const row of rows)
      for (const [name, count] of Object.entries(row.operations))
        operations[name] = Math.max(operations[name] ?? 0, count);
    return {
      tool,
      count: rows.length,
      medianMs: percentile(times, 0.5),
      p95Ms: percentile(times, 0.95),
      maxMs: times.at(-1),
      errors: rows.filter((r) => r.outcome === 'error').length,
      timeouts: rows.filter((r) => r.outcome === 'timeout').length,
      maxResponseBytes: maximum((s) => s.responseBytes),
      maxTextBytes: maximum((s) => s.textBytes),
      maxBackendCalls: maximum((s) => Object.values(s.operations).reduce((sum, n) => sum + n, 0)),
      maxOperations: operations,
    };
  });
}
export async function prepareScaling(f: Fixture, count: number) {
  const workers = [];
  for (let i = 0; i < count; i++)
    workers.push(await f.call('agent.spawn', { name: `scale${i}`, cli: 'shell', command: ['bash'] }));
  for (const worker of workers) await f.app.watches.create({ agentId: worker.agentId });
  return workers;
}
export async function scalingPass(f: Fixture, workers: any[]) {
  const samples: Sample[] = [],
    agentId = workers[0].agentId,
    paneId = workers[0].paneId;
  f.panes.set(paneId, screen);
  const base = await f.call('agent.observe', { agentId });
  const collect = async (label: string, tool: string, args = {}) => {
    const measured = await measure(f, label, () => f.raw(tool, args));
    assert.equal(measured.sample.outcome, 'success');
    samples.push(measured.sample);
    return JSON.parse((measured.result as any).content[0].text);
  };
  const unchanged = await collect('observe.unchanged', 'agent.observe', { agentId, since: base.observationId });
  assert.equal(unchanged.outputMode, 'unchanged');
  assert.ok(!unchanged.recentText);
  f.panes.set(paneId, screen + '\nnext output\n$ ');
  const delta = await collect('observe.append', 'agent.observe', { agentId, since: base.observationId });
  assert.equal(delta.outputMode, 'append');
  assert.ok(delta.recentText.includes('next output'));
  await collect('observe.full', 'agent.observe', { agentId });
  const summaries = await collect('orchestrator.status', 'orchestrator.status');
  assert.ok(summaries.every((row: any) => !('recentText' in row)));
  await collect('agent.collect_results', 'agent.collect_results');
  await collect('terminal.snapshot', 'terminal.snapshot');
  f.advance();
  const watched = await measure(f, 'watch.poll', async () => {
    await f.app.watches.poll();
    return { content: [] };
  });
  samples.push(watched.sample);
  return samples;
}
