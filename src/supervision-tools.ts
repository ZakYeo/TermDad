import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toolCall } from './tool-result.js';
import { membersSchema } from './supervision-storage.js';
import type { Supervision } from './supervision.js';
export function registerSupervisionTools(server: McpServer, groups: Supervision) {
  server.registerTool(
    'supervision.create',
    {
      description:
        'Create a durable supervision group and prepare member hooks/watches. Returns partial setup failures; does not launch a client waiter.',
      inputSchema: { name: z.string().min(1).max(100), members: membersSchema },
    },
    ({ name, members }) => toolCall('supervision.create', () => groups.create(name, members)),
  );
  server.registerTool(
    'supervision.update',
    {
      description:
        'Replace group membership with revision checking; retry setup or restore hooks/watches after reconnect by supplying the same members. No worker input.',
      inputSchema: { groupId: z.uuid(), expectedRevision: z.number().int().positive(), members: membersSchema },
    },
    ({ groupId, expectedRevision, members }) =>
      toolCall('supervision.update', () => groups.update(groupId, expectedRevision, members)),
  );
  server.registerTool(
    'supervision.status',
    {
      description:
        'Read durable membership and this server’s monitoring facts. Never proves a background waiter was launched or a client will resume.',
      inputSchema: { groupId: z.uuid() },
    },
    ({ groupId }) => toolCall('supervision.status', () => groups.status(groupId)),
  );
  server.registerTool(
    'supervision.close',
    {
      description:
        'Close a group and remove only its owned watches. Does not stop workers or acknowledge their events.',
      inputSchema: { groupId: z.uuid(), expectedRevision: z.number().int().positive() },
    },
    ({ groupId, expectedRevision }) => toolCall('supervision.close', () => groups.close(groupId, expectedRevision)),
  );
}
