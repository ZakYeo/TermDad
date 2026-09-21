import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { WezTermBackend } from '../src/backend.js';
import { EventQueue, type EventState, type EventStorage } from '../src/events.js';
import { MemoryWorkerStorage } from '../src/worker-storage.js';
import { MemoryTaskStorage } from '../src/task-storage.js';
import { FileTelemetry } from '../src/telemetry-storage.js';
import type { Metric, TelemetrySink } from '../src/telemetry.js';

class MemoryEvents implements EventStorage {
  private state: EventState = { version: 1, nextSequence: 1, events: [] };
  async transaction<T>(_write: boolean, fn: (state: EventState) => { state?: EventState; result: T }) {
    const result = fn(structuredClone(this.state));
    if (result.state) this.state = structuredClone(result.state);
    return result.result;
  }
}
export const screen =
  Array.from({ length: 100 }, (_, i) =>
    `line ${String(i).padStart(3, '0')}: deterministic benchmark output`.padEnd(100),
  ).join('\n') + '\n$ ';
export async function benchmarkFixture(telemetry: false | 'file' | 'default' | TelemetrySink = false) {
  const directory = await mkdtemp(join(tmpdir(), 'term-dad-bench-'));
  const oldDirectory = process.env.TERM_DAD_STATE_DIR;
  process.env.TERM_DAD_STATE_DIR = directory;
  const calls: string[] = [];
  const panes = new Map<number, string>([[1, screen]]);
  let nextPane = 2,
    clock = 10000;
  const identity = { endpoint: 'benchmark', key: 'benchmark' };
  const backend = new WezTermBackend(
    async (args) => {
      calls.push(args[0]);
      const id = Number(args[args.indexOf('--pane-id') + 1]);
      switch (args[0]) {
        case 'list':
          return JSON.stringify(
            [...panes.keys()].map((pane_id) => ({
              pane_id,
              tab_id: pane_id,
              window_id: 1,
              title: 'fixture',
              cwd: '/fixture',
              size: { rows: 24, cols: 100 },
            })),
          );
        case 'spawn':
        case 'split-pane': {
          const pane = nextPane++;
          panes.set(pane, screen);
          return String(pane);
        }
        case 'get-text':
          return panes.get(id) ?? '';
        case 'kill-pane':
          panes.delete(id);
          return '';
        default:
          return '';
      }
    },
    async () => {
      calls.push('identity');
      return identity;
    },
  );
  backend.listInstances = async () => {
    calls.push('list-instances');
    return [{ ...identity, pid: 1, title: 'fixture' }];
  };
  backend.selectInstance = async () => {
    calls.push('select-instance');
    return identity;
  };
  const metrics: Metric[] = [];
  const fileSink = telemetry === 'file' ? new FileTelemetry(join(directory, 'telemetry')) : undefined;
  const sink = fileSink
    ? {
        record: (metric: Metric) => {
          metrics.push(metric);
          fileSink.record(metric);
        },
        close: () => fileSink.close(),
      }
    : telemetry === 'default'
      ? undefined
      : (telemetry as false | TelemetrySink);
  const app = createServer(
    backend,
    {
      capture: async () => {
        calls.push('screenshot');
        return {
          type: 'image',
          mimeType: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        };
      },
    },
    { automatic: false, now: () => clock },
    new EventQueue(new MemoryEvents()),
    new MemoryWorkerStorage(),
    new MemoryTaskStorage(),
    { telemetry: sink },
  );
  await app.pushRestored;
  await app.reaped;
  const client = new Client({ name: 'benchmark', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await app.server.connect(a);
  await client.connect(b);
  const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await raw(name, args);
    assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result)}`);
    const content = result.content as { type: string; text?: string }[];
    return content[0]?.type === 'text' ? JSON.parse(content[0].text!) : result;
  };
  return {
    app,
    client,
    raw,
    call,
    calls,
    panes,
    directory,
    metrics,
    advance: () => {
      clock += 2000;
    },
    async close() {
      await client.close();
      await app.dispose();
      if (oldDirectory === undefined) delete process.env.TERM_DAD_STATE_DIR;
      else process.env.TERM_DAD_STATE_DIR = oldDirectory;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export type Fixture = Awaited<ReturnType<typeof benchmarkFixture>>;
