import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Agents } from './agents.js';
import type { TaskBoard } from './tasks.js';
import { dispatchSchema } from './task-dispatch.js';
import { taskMutationView } from './task-tools.js';
import { toolCall } from './tool-result.js';

export function registerTaskDispatch(server: McpServer, board: TaskBoard, agents: Agents) {
  server.registerTool(
    'task.dispatch',
    {
      description:
        'Create, assign and start a task atomically, then submit it once to an existing worker. Reuse the idempotencyKey to inspect a previous dispatch, never to resend uncertain input.',
      inputSchema: dispatchSchema,
    },
    (input) =>
      toolCall('task.dispatch', async () => {
        const result = await board.dispatch(input, (taskId, attemptId) =>
          agents.send(input.agentId, input.text, { taskId, attemptId }),
        );
        return { ...taskMutationView(result, 'compact'), dispatch: result.dispatch };
      }),
  );
}
