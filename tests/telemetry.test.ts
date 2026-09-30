import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { instrumentTools, resultMetadata, type Metric, type TelemetrySink } from '../src/telemetry.js';
import { FileTelemetry } from '../src/telemetry-storage.js';
import { readTelemetry, summarize } from '../src/telemetry-report.js';
import { guardTerminalSelection } from '../src/terminal-selection.js';

const metric = (): Metric => ({
  version: 1,
  session: randomUUID(),
  timestamp: new Date().toISOString(),
  tool: 'terminal.list',
  durationMs: 3,
  outcome: 'success',
  responseBytes: 10,
  textBytes: 2,
});
async function directory(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'term-dad-telemetry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function protocol(t: any, sink: TelemetrySink, setup: (server: McpServer) => void, now?: () => number) {
  const server = new McpServer({ name: 'telemetry-test', version: '1' });
  instrumentTools(server, sink, now);
  setup(server);
  const client = new Client({ name: 'telemetry-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
}

test('request boundary measures success, SDK validation, returned errors, images and unknown tools once without content', async (t) => {
  const metrics: Metric[] = [];
  let now = 0;
  const call = await protocol(
    t,
    { record: (m) => metrics.push(m) },
    (server) => {
      server.registerTool('read', { inputSchema: { value: z.string() } }, ({ value }) => ({
        content: [{ type: 'text', text: value }],
      }));
      server.registerTool('error', {}, () => ({
        isError: true,
        content: [{ type: 'text', text: 'WORKER_BUSY: secret-error' }],
      }));
      server.registerTool('image', {}, () => ({
        content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('secret-image').toString('base64') }],
      }));
      server.registerTool('wait', {}, () => ({ content: [{ type: 'text', text: '{"status":"timeout"}' }] }));
    },
    () => (now += 7),
  );
  const result = await call('read', { value: '秘密🙂secret-output' });
  await call('read', { value: 42 });
  await call('error');
  await call('image');
  await call('wait');
  await call('secret-unknown');
  assert.equal(metrics.length, 6);
  assert.equal(metrics[0].durationMs, 7);
  assert.equal(metrics[0].responseBytes, Buffer.byteLength(JSON.stringify(result)));
  assert.equal(metrics[0].textBytes, Buffer.byteLength('秘密🙂secret-output'));
  assert.deepEqual(
    metrics.map((m) => m.outcome),
    ['success', 'error', 'error', 'success', 'timeout', 'error'],
  );
  assert.equal(metrics[1].errorCode, 'ARGUMENT_INVALID');
  assert.equal(metrics[2].errorCode, 'WORKER_BUSY');
  assert.equal(metrics[3].textBytes, 0);
  assert.equal(metrics[5].tool, 'unknown');
  assert.ok(!JSON.stringify(metrics).includes('secret'));
});
test('thrown protocol failure and a failing telemetry sink preserve the result/error', async (t) => {
  const metrics: Metric[] = [];
  const call = await protocol(
    t,
    {
      record: (m) => {
        metrics.push(m);
        throw new Error('sink unavailable');
      },
    },
    (server) => {
      server.registerTool('read', {}, () => ({ content: [{ type: 'text', text: 'ok' }] }));
      server.registerTool('fail', {}, () => {
        throw new McpError(ErrorCode.UrlElicitationRequired, 'secret-error');
      });
    },
  );
  assert.equal((await call('read')).isError, undefined);
  await assert.rejects(call('fail'), /secret-error/);
  assert.equal(metrics[1].outcome, 'error');
  assert.equal(metrics[1].responseBytes, 0, 'no result body exists for a thrown protocol exception');
  assert.ok(!JSON.stringify(metrics).includes('secret'));
});
test('concurrent calls and selection-gate rejection each receive one measurement', async (t) => {
  const metrics: Metric[] = [];
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>((r) => {
    started = r;
  });
  const pending = new Promise<void>((r) => {
    release = r;
  });
  const call = await protocol(t, { record: (m) => metrics.push(m) }, (server) => {
    guardTerminalSelection(server);
    server.registerTool('read', {}, async () => {
      started();
      await pending;
      return { content: [] };
    });
    server.registerTool('terminal.select_instance', {}, () => ({ content: [] }));
  });
  const first = call('read');
  await entered;
  assert.equal((await call('terminal.select_instance')).isError, true);
  release();
  await first;
  assert.equal(metrics.length, 2);
  assert.equal(metrics[0].errorCode, 'TERMINAL_BUSY');
});
test('result classification supports both wait contracts and never records unrecognised error prefixes', () => {
  for (const text of ['{"reason":"timeout"}', '{"status":"timeout"}', '{"timedOut":true}'])
    assert.equal(resultMetadata({ content: [{ type: 'text', text }] }).outcome, 'timeout');
  assert.equal(
    resultMetadata({ isError: true, content: [{ type: 'text', text: 'SECRET_TOKEN: private' }] }).errorCode,
    'TOOL_ERROR',
  );
});
test('bounded storage persists drop counts, rotates, prunes and uses private permissions', async (t) => {
  const dir = await directory(t);
  const sink = new FileTelemetry(dir, { queueLimit: 5, maxBytes: 800, maxCompleted: 2 });
  for (let n = 0; n < 10; n++) sink.record(metric());
  await sink.close();
  assert.equal(sink.droppedRecords, 5);
  const files = await readdir(dir);
  assert.ok(files.length <= 2);
  assert.ok(files.every((file) => !file.includes('active')));
  for (const file of files) {
    const info = await stat(join(dir, file));
    assert.equal(info.mode & 0o777, 0o600);
    assert.ok(info.size <= 800);
  }
  const report = await readTelemetry(dir);
  assert.equal(report.droppedRecords, 5);
  assert.ok(report.metrics.length > 0);
});
test('storage sweeps expired files but leaves a peer active file alone', async (t) => {
  const dir = await directory(t);
  const old = join(dir, `${process.pid}-${randomUUID()}.1.jsonl`);
  const peer = join(dir, `${process.pid}-${randomUUID()}.active.jsonl`);
  await writeFile(old, '', { mode: 0o600 });
  await utimes(old, 1, 1);
  await writeFile(peer, '', { mode: 0o600 });
  const sink = new FileTelemetry(dir);
  sink.record(metric());
  await sink.close();
  const files = await readdir(dir);
  assert.ok(!files.includes(old.split('/').at(-1)!));
  assert.ok(files.includes(peer.split('/').at(-1)!));
});
test('storage failure drops measurements, warns once and never rejects record or close', async (t) => {
  const dir = await directory(t),
    path = join(dir, 'file');
  await writeFile(path, '');
  let warnings = 0;
  const sink = new FileTelemetry(path, {
    warn: () => {
      warnings++;
    },
  });
  sink.record(metric());
  await sink.close();
  sink.record(metric());
  assert.equal(warnings, 1);
  assert.equal(sink.droppedRecords, 2);
});
test('report handles truncated lines and computes nearest-rank percentiles', async (t) => {
  const dir = await directory(t);
  const metrics = Array.from({ length: 30 }, (_, i) => ({ ...metric(), durationMs: i + 1 }));
  await writeFile(
    join(dir, `${process.pid}-${randomUUID()}.1.jsonl`),
    metrics.map((m) => JSON.stringify(m)).join('\n') + '\n{"partial',
  );
  const read = await readTelemetry(dir);
  assert.equal(read.invalidLines, 1);
  const [summary] = summarize(read.metrics);
  assert.equal(summary.medianMs, 15);
  assert.equal(summary.p95Ms, 29);
  assert.equal(summary.accumulatedMs, 465);
});

test('argument/key failures have closed codes while embedded worker errors remain successful calls', () => {
  for (const errorCode of ['ARGUMENT_MISSING', 'ARGUMENT_CONFLICT', 'UNSUPPORTED_KEY']) {
    const metric = resultMetadata({ isError: true, content: [{ type: 'text', text: `${errorCode}: private-input` }] });
    assert.equal(metric.errorCode, errorCode);
    assert.equal(metric.outcome, 'error');
    assert.ok(!JSON.stringify(metric).includes('private-input'));
  }
  const metric = resultMetadata({
    content: [{ type: 'text', text: JSON.stringify([{ error: 'WORKER_BUSY: held' }]) }],
  });
  assert.equal(metric.outcome, 'success');
  assert.equal(metric.errorCode, undefined);
});
