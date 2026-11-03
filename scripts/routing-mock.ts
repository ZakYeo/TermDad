// Real tool schemas/handlers, fake backend and isolated journals. Never contacts WezTerm or GitHub.
import { appendFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { benchmarkFixture } from './benchmark-fixture.js';
const log = process.argv[2];
if (!log) throw new Error('Routing mock requires a call-log destination');
const f = await benchmarkFixture();
f.panes.clear();
f.panes.set(7, 'OpenAI Codex\n› Explain this codebase');
f.panes.set(8, 'OpenAI Codex\nWorking…');
await f.call('agent.adopt', { name: 'keep', cli: 'codex', paneId: 7 });
await f.call('agent.adopt', { name: 'candidate', cli: 'codex', paneId: 8 });
const allowed = new Set([
  'terminal.list',
  'terminal.read',
  'terminal.snapshot',
  'agent.list',
  'orchestrator.status',
  'terminal.close',
]);
const tools = (await f.client.listTools()).tools.filter((tool) => allowed.has(tool.name));
tools.push({
  name: 'review.lookup',
  description:
    'External review service: verify the current open/draft state of a pull request. Independent of TermDad.',
  inputSchema: {
    type: 'object',
    properties: { repository: { type: 'string' }, number: { type: 'integer' } },
    required: ['repository', 'number'],
  },
});
const server = new Server({ name: 'termdad-routing-fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
let calls = 0;
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  await appendFile(log, JSON.stringify({ name, args }) + '\n');
  if (++calls > 6) throw new Error('Routing evaluation tool-call budget exhausted');
  if (name === 'review.lookup')
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            repository: 'example/project',
            number: 42,
            state: 'OPEN',
            isDraft: false,
            source: 'mock_external_service',
          }),
        },
      ],
    };
  if (!allowed.has(name)) throw new Error('Tool outside routing fixture');
  return f.raw(name, args);
});
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await f.close();
  await server.close();
  process.exit(0);
};
process.stdin.once('end', () => void close());
process.once('SIGTERM', () => void close());
await server.connect(new StdioServerTransport());
