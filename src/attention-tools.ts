import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolCall } from './tool-result.js';
import { AttentionService, attentionSchema } from './attention.js';

export function registerAttentionTools(server: McpServer, attention: AttentionService) {
  server.registerTool(
    'orchestrator.attention',
    {
      description:
        'Refresh task-focused decisions, dispatch eligibility, verification work, and net changes since a session cursor. Read-only; worker readiness is heuristic. Page frozen results using pageCursor and offset.',
      inputSchema: attentionSchema,
    },
    (input) =>
      toolCall('orchestrator.attention', () => attention.status(input), { invalid: 'ATTENTION_INPUT_INVALID' }),
  );
  return () => attention.close();
}
