import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { benchmarkEnvironment } from './benchmark-environment.js';
import { LiveSession, parentPane } from './live-support.js';
import { percentile, readTelemetry, summarize } from '../src/telemetry-report.js';

const destination = resolve(process.argv[2] ?? '/tmp/term-dad-benchmark');
const observations: { operation: string; ms: number }[] = [];
let session: LiveSession | undefined, limitation: string | undefined;
let telemetry: Awaited<ReturnType<typeof readTelemetry>> | undefined;
const clocked = async <T>(operation: string, fn: () => Promise<T>, keep = true) => {
  const start = performance.now();
  const result = await fn();
  if (keep) observations.push({ operation, ms: performance.now() - start });
  return result;
};
try {
  session = await LiveSession.create({ TERM_DAD_TELEMETRY: '1' });
  const live = session,
    call = live.call;
  const panes = await call('terminal.list');
  const worker = await clocked('spawn.shell', () =>
    live.spawnAgent({
      name: 'benchmark-shell',
      cli: 'shell',
      paneId: parentPane(panes),
      command: ['bash', '--noprofile', '--norc', '-i'],
    }),
  );
  await clocked('spawn.to_ready', () => call('agent.wait_until_idle', { agentId: worker.agentId, timeoutMs: 30000 }));
  for (let iteration = 0; iteration < 35; iteration++) {
    const keep = iteration >= 5;
    await clocked('terminal.list', () => call('terminal.list'), keep);
    await clocked('agent.observe', () => call('agent.observe', { agentId: worker.agentId }), keep);
    await clocked('orchestrator.status', () => call('orchestrator.status'), keep);
    // Concatenation ensures the echoed input cannot satisfy the marker wait.
    const suffix = String(iteration).padStart(3, '0');
    await clocked(
      'submit.to_marker',
      async () => {
        await call('agent.send', { agentId: worker.agentId, text: `printf '\\nTD_BENCH_%s\\n' '${suffix}'` });
        await call('agent.wait_for_text', { agentId: worker.agentId, text: `TD_BENCH_${suffix}`, timeoutMs: 15000 });
      },
      keep,
    );
    await call('agent.wait_until_idle', { agentId: worker.agentId, timeoutMs: 15000 });
    if ((iteration + 1) % 5 === 0) console.error(`Live shell benchmark: ${iteration + 1}/35`);
  }
  await clocked('stop.shell', () => live.stopAgent(worker.agentId, worker.paneId));
} catch (error) {
  limitation = error instanceof Error ? error.message : String(error);
  console.error(`Live benchmark incomplete: ${limitation}`);
} finally {
  if (session) {
    // Once all owned panes are closed, close stdio to drain telemetry before reading it.
    // On a failed run retain the normal ownership-aware cleanup path.
    if (session.owned.size === 0) await session.client.close();
    telemetry = await readTelemetry(join(session.directory, 'telemetry'));
    await session.dispose();
  }
}
const operations = [...new Set(observations.map((row) => row.operation))].map((operation) => {
  const values = observations
    .filter((row) => row.operation === operation)
    .map((row) => row.ms)
    .sort((a, b) => a - b);
  return {
    operation,
    count: values.length,
    medianMs: percentile(values, 0.5),
    p95Ms: values.length >= 20 ? percentile(values, 0.95) : null,
    maxMs: values.at(-1),
  };
});
const report = {
  ...benchmarkEnvironment(),
  warmups: 5,
  repetitions: 30,
  provenance:
    'Live WezTerm, stdio MCP, isolated on-disk state, one shell worker, no paid models. Round trips include transport and terminal operations. spawn.to_ready measures the wait after spawn returns.',
  limitation,
  operations,
  server: telemetry ? summarize(telemetry.metrics) : [],
  telemetryCoverage: telemetry
    ? { invalidLines: telemetry.invalidLines, droppedRecords: telemetry.droppedRecords, truncated: telemetry.truncated }
    : undefined,
};
await mkdir(destination, { recursive: true });
await writeFile(join(destination, 'live.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (limitation) process.exitCode = 1;
