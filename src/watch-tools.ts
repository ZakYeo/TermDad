import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WatchManager, watchShape } from './watches.js';
import { toolCall } from './tool-result.js';
export function registerWatchTools(server: McpServer, watches: WatchManager) {
  const register = (name: string, description: string, inputSchema: z.ZodRawShape, fn: (a: any) => unknown) =>
    server.registerTool(name, { description, inputSchema }, (a) =>
      toolCall(name, async () => fn(a), { invalid: 'WATCH_INPUT_INVALID' }),
    );
  register(
    'watch.create',
    'Watch exactly one target: agentId or paneId, never agentIds. Unmanaged panes require adapter. Ready and inactivity never establish success.',
    watchShape,
    (a) => watches.create(a),
  );
  register('watch.list', 'List watches, pending delivery counts and recoverable errors.', {}, () => watches.list());
  register('watch.remove', 'Remove a watch without closing its pane.', { watchId: z.string().min(1).max(100) }, (a) =>
    watches.remove(a.watchId),
  );
  return () => watches.dispose();
}
