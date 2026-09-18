import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WorkerPushRegistry } from './push-workers.js';
import { toolCall } from './tool-result.js';

export function registerPushTools(server: McpServer, push: WorkerPushRegistry) {
  // Reads the registry's own socket state, so an intended path can never be reported as a bound one.
  server.registerTool(
    'push.status',
    {
      description:
        'Report push delivery per pane. `enabled` is worker-side intent only; `deliverable` means every link this server can see is live; `proven` means a hook has actually fired, which is the only evidence delivery works. Push is off for every pane until it is enabled.',
      inputSchema: { agentId: z.string().min(1).optional() },
    },
    ({ agentId }) =>
      toolCall('push.status', async () =>
        agentId
          ? { socket: push.socket(), worker: await push.status(agentId) }
          : { socket: push.socket(), workers: push.list() },
      ),
  );
  server.registerTool(
    'push.set',
    {
      description:
        'Turn worker-pushed events on or off for one pane (agentId or worker name). Returns the same deliverability facts as push.status: `deliverable`, `proven`, `reason`. Enable it for long-running work so its watch stops scraping the pane and reports as soon as the worker itself reports; disable it to return to polling. Enabling fails explicitly when the channel cannot deliver: PUSH_NOT_WIRED for a pane launched without hooks (an adopted pane); a surviving worker from a previous server is re-keyed here, not respawned; PUSH_SOCKET_UNAVAILABLE when the socket did not bind, PUSH_UNSUPPORTED_WORKER for a shell worker. Disabling always succeeds.',
      inputSchema: { agentId: z.string().min(1), enabled: z.boolean() },
    },
    ({ agentId, enabled }) => toolCall('push.set', () => push.setEnabled(agentId, enabled)),
  );
}
