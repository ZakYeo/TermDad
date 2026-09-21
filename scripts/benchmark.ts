import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { benchmarkEnvironment } from './benchmark-environment.js';
import { benchmarkFixture } from './benchmark-fixture.js';
import { toolWorkflow, sampleSummary, prepareScaling, scalingPass, type Sample } from './benchmark-measure.js';
import { summarize } from '../src/telemetry-report.js';
import type { Metric } from '../src/telemetry.js';

const destination = resolve(process.argv[2] ?? '/tmp/term-dad-benchmark');
const warmups = 5,
  repetitions = 30;
const all: Record<string, Sample[]> = { disabled: [], enabled: [] },
  metrics: Metric[] = [];
const started = performance.now();
for (let iteration = 0; iteration < warmups + repetitions; iteration++) {
  for (const mode of iteration % 2 ? ['enabled', 'disabled'] : ['disabled', 'enabled']) {
    const f = await benchmarkFixture(mode === 'enabled' ? 'file' : false);
    try {
      const samples = await toolWorkflow(f);
      if (iteration >= warmups) {
        all[mode].push(...samples);
        metrics.push(...f.metrics);
      }
    } finally {
      await f.close();
    }
  }
  if ((iteration + 1) % 5 === 0)
    console.error(`Tool benchmark: ${iteration + 1}/${warmups + repetitions} paired iterations`);
}
const scaling = [];
for (const count of [1, 5, 10]) {
  const f = await benchmarkFixture();
  try {
    const workers = await prepareScaling(f, count),
      samples: Sample[] = [];
    for (let i = 0; i < warmups + repetitions; i++) {
      const pass = await scalingPass(f, workers);
      if (i >= warmups) samples.push(...pass);
    }
    scaling.push({ workers: count, tools: sampleSummary(samples) });
  } finally {
    await f.close();
  }
}
const report = {
  ...benchmarkEnvironment(),
  warmups,
  repetitions,
  elapsedMs: performance.now() - started,
  provenance:
    'In-memory MCP transport, simulated terminal and screenshot providers, memory worker/task/event storage. File telemetry enabled in paired runs; no model calls. Lifecycle scenarios reset with a fresh fixture each iteration. Timings include real configured paste delays. Push scenario measures disabling, not hook delivery.',
  disabled: sampleSummary(all.disabled),
  enabled: sampleSummary(all.enabled),
  server: summarize(metrics),
  scaling,
};
await mkdir(destination, { recursive: true });
await writeFile(join(destination, 'simulated.json'), JSON.stringify(report, null, 2) + '\n');
const lines = [
  '# Simulated benchmark',
  '',
  report.provenance,
  '',
  `Node ${report.node}; ${warmups} warm-ups and ${repetitions} measured iterations per mode. Commit ${report.commit} (${report.workingTree}).`,
  '',
  '| Tool | Off median ms | On median ms | On p95 ms | Max result bytes | Backend calls |',
  '|---|---:|---:|---:|---:|---:|',
];
for (const on of report.enabled) {
  const off = report.disabled.find((s) => s.tool === on.tool)!;
  lines.push(
    `| ${on.tool} | ${off.medianMs.toFixed(3)} | ${on.medianMs.toFixed(3)} | ${on.p95Ms.toFixed(3)} | ${on.maxResponseBytes} | ${on.maxBackendCalls} |`,
  );
}
for (const group of scaling) {
  lines.push(
    '',
    `## ${group.workers} simulated workers`,
    '',
    '| Scenario | Median ms | p95 ms | Max result bytes | Backend calls |',
    '|---|---:|---:|---:|---:|',
  );
  for (const row of group.tools)
    lines.push(
      `| ${row.tool} | ${row.medianMs.toFixed(3)} | ${row.p95Ms.toFixed(3)} | ${row.maxResponseBytes} | ${row.maxBackendCalls} |`,
    );
}
await writeFile(join(destination, 'simulated.md'), lines.join('\n') + '\n');
console.log(`Benchmark reports: ${destination}/simulated.{json,md}`);
