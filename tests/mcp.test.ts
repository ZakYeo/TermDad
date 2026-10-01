import test from 'node:test';
import { readTelemetry } from '../src/telemetry-report.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
test('stdio MCP smoke: initialize, list tool schemas, validate calls and expose backend failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'term-dad-smoke-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    env: {
      ...process.env,
      TERM_DAD_TELEMETRY: '1',
      TERM_DAD_WEZTERM: '/nonexistent/wezterm',
      TERM_DAD_STATE_DIR: directory,
    } as Record<string, string>,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'test', version: '1' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 58);
    for (const name of [
      'task.create',
      'task.get',
      'task.list',
      'task.update',
      'task.assign',
      'task.archive',
      'agent.spawn',
      'terminal.submit',
      'orchestrator.status',
      'orchestrator.attention',
      'agent.screenshot',
      'watch.create',
      'watch.list',
      'watch.remove',
      'event.list',
      'event.acknowledge',
      'event.wait_for_event',
      'event.wake_command',
    ])
      assert.ok(tools.some((t) => t.name === name));
    const watches = await client.callTool({ name: 'watch.list', arguments: {} });
    assert.deepEqual(JSON.parse((watches.content as any)[0].text), []);
    const badWatch = await client.callTool({
      name: 'watch.create',
      arguments: { paneId: 7, adapter: 'codex', pollMs: 1 },
    });
    assert.equal(badWatch.isError, true);
    const unavailable = await client.callTool({ name: 'watch.create', arguments: { paneId: 7, adapter: 'codex' } });
    assert.equal(unavailable.isError, true);
    const removed = await client.callTool({ name: 'watch.remove', arguments: { watchId: 'missing' } });
    assert.equal(removed.isError, undefined);
    const invalid = await client.callTool({ name: 'terminal.read', arguments: { paneId: -1 } });
    assert.equal(invalid.isError, true);
    const failed = await client.callTool({ name: 'terminal.list', arguments: {} });
    assert.equal(failed.isError, true);
    const snapshot = await client.callTool({ name: 'orchestrator.status', arguments: {} });
    assert.equal(snapshot.isError, undefined);
    await client.close();
    const telemetry = await readTelemetry(join(directory, 'telemetry'));
    assert.equal(telemetry.metrics.length, 7, 'each tools/call, including schema failures, is flushed on stdio close');
    assert.equal(telemetry.metrics.filter((metric) => metric.outcome === 'error').length, 4);
    assert.equal(telemetry.invalidLines, 0);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
