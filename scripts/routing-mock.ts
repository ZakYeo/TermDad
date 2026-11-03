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
// These tools only operate on disposable fake state, not external user resources.
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((tool) => ({
    ...tool,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  })),
}));
let calls = 0;
let verified = false;
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const invocation = ++calls;
  const verifiedBefore = verified;
  let result;
  try {
    if (calls > 6) throw new Error('Routing evaluation tool-call budget exhausted');
    if (name === 'review.lookup') {
      if (process.argv[3] === 'conditional-unavailable')
        throw new Error('Mock external service unavailable; eligibility is unknown.');
      if (args.repository !== 'example/project' || args.number !== 42) throw new Error('Unknown mock review reference');
      await new Promise((resolve) => setTimeout(resolve, 20));
      result = {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              repository: 'example/project',
              number: 42,
              state: 'OPEN',
              isDraft: process.argv[3] === 'conditional-draft',
              source: 'mock_external_service',
            }),
          },
        ],
      };
      verified = process.argv[3] !== 'conditional-draft';
    } else {
      if (!allowed.has(name)) throw new Error('Tool outside routing fixture');
      result = await f.raw(name, args);
    }
  } catch (error) {
    result = {
      isError: true,
      content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Mock tool failed' }],
    };
  }
  await appendFile(log, JSON.stringify({ name, args, invocation, verifiedBefore, ok: result.isError !== true }) + '\n');
  return result;
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
