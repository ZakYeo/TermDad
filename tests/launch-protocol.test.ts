import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
test('agent.spawn passes canonical cliArgs through MCP schema to terminal argv', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'td-launch-protocol-')),
    log = join(dir, 'argv.jsonl');
  const client = new Client({ name: 'launch-test', version: '1' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['tests/fixtures/worker-server.mjs'],
        env: { ...process.env, TERM_DAD_STATE_DIR: dir, WORKER_TEST_SPAWN_LOG: log } as Record<string, string>,
      }),
    );
    const result = await client.callTool({
      name: 'agent.spawn',
      arguments: { name: 'plan', cli: 'claude', cliArgs: ['--permission-mode', 'plan'] },
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const argv = JSON.parse((await readFile(log, 'utf8')).trim());
    const index = argv.indexOf('--permission-mode');
    assert.ok(index >= 0);
    assert.equal(argv[index + 1], 'plan');
    assert.ok(argv.includes('--settings'));
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
