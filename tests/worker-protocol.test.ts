import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
async function connect(directory: string, identity = 'fixture-instance') {
  const client = new Client({ name: 'worker-recovery-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['tests/fixtures/worker-server.mjs'],
    env: {
      ...process.env,
      TERM_DAD_STATE_DIR: directory,
      WORKER_TEST_IDENTITY: identity,
      WORKER_TEST_LOG: join(directory, 'input.log'),
    } as Record<string, string>,
    stderr: 'pipe',
  });
  await client.connect(transport);
  const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await raw(name, args);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse((result.content as { text: string }[])[0].text);
  };
  return { client, raw, call };
}
test('separate MCP processes recover, share conflicts and input guards, and expose detached mappings', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'term-dad-worker-protocol-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await connect(dir);
  t.after(() => first.client.close());
  const spawned = await first.call('agent.spawn', { name: 'worker', cli: 'codex' });
  const old = await first.call('agent.observe', { agentId: spawned.agentId });
  await first.client.close();
  const second = await connect(dir),
    third = await connect(dir);
  t.after(() => second.client.close());
  t.after(() => third.client.close());
  assert.equal((await second.call('agent.list'))[0].agentId, spawned.agentId);
  assert.equal((await second.call('agent.observe', { agentId: 'worker', since: old.observationId })).deltaReset, true);
  assert.equal((await third.raw('agent.adopt', { name: 'duplicate', cli: 'shell', paneId: 7 })).isError, true);
  const sending = second.call('agent.send', { agentId: 'worker', text: 'first task' });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(join(dir, 'input.log'), 'utf8')).includes('first task')) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.match(await readFile(join(dir, 'input.log'), 'utf8'), /first task/);
  assert.equal((await third.raw('agent.send', { agentId: 'worker', text: 'interleaving task' })).isError, true);
  await sending;
  await third.call('agent.send', { agentId: 'worker', text: 'follow-up' });
  const input = (await readFile(join(dir, 'input.log'), 'utf8'))
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s).input);
  assert.match(input[0], /^\$term-dad-worker/);
  assert.deepEqual(input.slice(1), ['\r', 'follow-up', '\r']);
  const other = await connect(dir, 'reused-pane-in-new-instance');
  t.after(() => other.client.close());
  assert.equal((await other.call('agent.list'))[0].attachment, 'detached');
  assert.equal((await other.raw('agent.stop', { agentId: 'worker' })).isError, true);
  await second.call('agent.forget', { agentId: 'worker' });
  assert.deepEqual(await third.call('agent.list'), []);
});
test('agent.observe and agent.status accept a lines cap and report omitted lines', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'term-dad-worker-lines-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = await connect(dir);
  t.after(() => f.client.close());
  await f.call('agent.spawn', { name: 'worker', cli: 'codex' });
  const one = await f.call('agent.status', { agentId: 'worker', lines: 1 });
  assert.equal(one.recentText, '› Explain this codebase');
  assert.equal(one.linesOmitted, 1);
  assert.equal((await f.raw('agent.observe', { agentId: 'worker', lines: 0 })).isError, true);
});
