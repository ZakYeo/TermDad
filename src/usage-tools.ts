import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { configureUsageSchema, usageId, usageWatchSchema } from './usage-model.js';
import { toolCall } from './tool-result.js';
import type { UsageService } from './usage.js';

export function registerUsageTools(
  server: McpServer,
  usage: UsageService,
  resolve: (id: string) => Promise<{ accountRef?: string }>,
) {
  server.registerTool(
    'usage.status',
    {
      description: 'Account allowances, freshness, reserves and collection support. Unknown is never zero usage.',
      inputSchema: { accountRef: usageId.optional() },
    },
    ({ accountRef }) => toolCall('usage.status', () => usage.status(accountRef)),
  );
  server.registerTool(
    'usage.configure',
    {
      description:
        'Configure account usage monitoring and explicit worker bindings. The supervisor handles pausing and resuming workers.',
      inputSchema: configureUsageSchema,
    },
    (a) =>
      toolCall('usage.configure', async () => {
        for (const id of a.workerIds) {
          const worker = await resolve(id);
          if (worker.accountRef && worker.accountRef !== a.accountRef) throw new Error('USAGE_WORKER_ALREADY_BOUND');
        }
        return usage.configure(a);
      }),
  );
  server.registerTool(
    'usage.refresh',
    {
      description:
        'Read current account quotas without inference. Rate-limited to once a minute. Passive and unavailable collectors return an explicit unsupported error.',
      inputSchema: { accountRef: usageId },
    },
    ({ accountRef }) => toolCall('usage.refresh', () => usage.refresh(accountRef)),
  );
  server.registerTool(
    'usage.watch',
    {
      description:
        'Subscribe to usage threshold crossings, expected reset deadlines and confirmed reset events. Delivery is deduplicated per threshold/window.',
      inputSchema: usageWatchSchema,
    },
    (a) => toolCall('usage.watch', () => usage.watch(a)),
  );
  server.registerTool(
    'usage.unwatch',
    {
      description: 'Remove warning subscription without disabling collection or deleting quota observations.',
      inputSchema: { accountRef: usageId },
    },
    ({ accountRef }) => toolCall('usage.unwatch', () => usage.unwatch(accountRef)),
  );
}
