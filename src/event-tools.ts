import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { oneOf, waitShape, waitTimeout } from './arguments.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EventQueue, eventFilterSchema } from './events.js';
import { stateDirectory } from './journal.js';
import { toolCall } from './tool-result.js';

/** Kinds a supervisor is woken for by default: everything that needs a person, plus turn completion. */
export const wakeKinds = [
  'attention_required',
  'input_required',
  'ready',
  'pane_disappeared',
  'session_ended',
  'usage.threshold',
  'usage.reset',
  'usage.reset_due',
  'usage.pause_requested',
  'usage.resume_pending',
] as const;
const shellWord = (value: string) =>
  /^[A-Za-z0-9_./:=,@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
/**
 * The one command that arms a wake. The server names it because bare `term-dad` is not on
 * PATH and `dist/wait-cli.js` is a module that exits at once; both were tried in the field.
 * `--state-dir` is explicit because the waiter runs in the caller's environment, not the server's.
 */
export function wakeCommand(stateDir = stateDirectory(), execPath = process.execPath) {
  const entry = fileURLToPath(new URL('./index.js', import.meta.url)),
    command = [execPath, entry, 'wait-for-event'];
  const args = ['--until-event', '--state-dir', stateDir, '--kinds', wakeKinds.join(',')];
  // A server run from source (tsx) has no index.js beside it; say so rather than hand out a path that cannot run.
  const warning = existsSync(entry)
    ? undefined
    : `entry point ${entry} does not exist; run the waiter from a built dist/ instead`;
  return {
    command,
    stateDir,
    kinds: [...wakeKinds],
    example: [...command, ...args].map(shellWord).join(' '),
    ...(warning ? { warning } : {}),
  };
}

export function registerEventTools(server: McpServer, queue: EventQueue) {
  server.registerTool(
    'event.list',
    {
      description: 'List durable pending metadata events in sequence order. Does not acknowledge them.',
      inputSchema: {
        ...eventFilterSchema.shape,
        includeAcknowledged: z.boolean().default(false),
        limit: z.number().int().min(1).max(1000).default(100),
      },
    },
    ({ includeAcknowledged, limit, ...filter }) =>
      toolCall('event.list', () => queue.list(filter, includeAcknowledged, limit)),
  );
  server.registerTool(
    'event.acknowledge',
    {
      description:
        'Idempotently acknowledge durable events by ids (alias eventIds). Unknown or expired IDs are reported.',
      inputSchema: {
        ids: z.array(z.uuid()).min(1).max(100).optional().describe('event IDs (alias: eventIds)'),
        eventIds: z.array(z.uuid()).min(1).max(100).optional(),
      },
    },
    (a) => toolCall('event.acknowledge', () => queue.acknowledge(oneOf<string[]>(a, ['ids', 'eventIds']))),
  );
  server.registerTool(
    'event.wait_for_event',
    {
      description:
        'Wait for an event matching all supplied filters. Fresh by default: only events published after the wait arms, so a pending backlog cannot fire as new. Pass freshOnly:false to drain history. Never infers worker success and does not acknowledge.',
      inputSchema: {
        ...eventFilterSchema.shape,
        ...waitShape,
        freshOnly: z.boolean().default(true),
      },
    },
    ({ timeoutMs, timeoutSeconds, freshOnly, ...filter }, extra) =>
      toolCall('event.wait_for_event', () =>
        queue.wait(filter, waitTimeout({ timeoutMs, timeoutSeconds }), extra.signal, freshOnly),
      ),
  );
  server.registerTool(
    'event.wake_command',
    {
      description:
        'The exact detached command that wakes an idle supervisor when an event lands. Run its example verbatim as a background process; never run dist/wait-cli.js directly and never assume term-dad is on PATH. Read-only.',
      inputSchema: {},
    },
    () => toolCall('event.wake_command', async () => wakeCommand()),
  );
  const stopSweeper = queue.startSweeper();
  return async () => {
    stopSweeper();
    await queue.close();
  };
}
