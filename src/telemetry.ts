import type { Monitoring } from './monitoring.js';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export interface Metric {
  version: 1;
  session: string;
  timestamp: string;
  tool: string;
  durationMs: number;
  outcome: 'success' | 'error' | 'timeout';
  errorCode?: string;
  responseBytes: number;
  textBytes: number;
}
export interface TelemetrySink {
  record(metric: Metric): void;
  close?(): Promise<void>;
}
export interface TelemetryOptions {
  monitoring?: Monitoring | false;
  telemetry?: TelemetrySink | false;
  now?: () => number;
}
const codes = new Set([
  'ARGUMENT_INVALID',
  'ARGUMENT_MISSING',
  'UNSUPPORTED_KEY',
  'ARGUMENT_CONFLICT',
  'WORKER_BUSY',
  'WORKER_STORAGE_BUSY',
  'WORKER_DETACHED',
  'WORKER_PANE_DISAPPEARED',
  'TASK_REVISION_CONFLICT',
  'TASK_INPUT_INVALID',
  'WATCH_INPUT_INVALID',
  'ATTENTION_INPUT_INVALID',
  'TERMINAL_BUSY',
]);
export const isWaitTool = (name: string) => name.startsWith('agent.wait_') || name === 'event.wait_for_event';

/** Only sizes and closed classifications leave this function; never retain result contents. */
export function resultMetadata(result: unknown, thrown = false) {
  const value = result as { isError?: boolean; content?: { type: string; text?: string }[] } | undefined;
  const texts = value?.content?.filter((item) => item.type === 'text').map((item) => item.text ?? '') ?? [];
  const error = thrown || value?.isError === true;
  const prefix = texts[0]?.match(/^([A-Z][A-Z0-9_]*):/)?.[1];
  const validationFailure = texts[0]?.startsWith('MCP error -32602: Input validation error:');
  let timeout = false;
  for (const text of texts) {
    try {
      const body = JSON.parse(text);
      timeout ||= body?.reason === 'timeout' || body?.status === 'timeout' || body?.timedOut === true;
    } catch {
      /* Plain error text is not JSON. */
    }
  }
  return {
    outcome: error ? ('error' as const) : timeout ? ('timeout' as const) : ('success' as const),
    ...(error
      ? { errorCode: validationFailure ? 'ARGUMENT_INVALID' : prefix && codes.has(prefix) ? prefix : 'TOOL_ERROR' }
      : {}),
    responseBytes: thrown ? 0 : Buffer.byteLength(JSON.stringify(result) ?? ''),
    textBytes: texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
  };
}

/** Wrap the public request registration boundary, outside SDK validation and every tool registrar. */
export function instrumentTools(server: McpServer, sink: TelemetrySink, now = () => performance.now()) {
  const names = new Set<string>();
  const register = server.registerTool.bind(server);
  server.registerTool = (name, config, callback) => {
    names.add(name);
    return register(name, config, callback);
  };
  const session = randomUUID();
  const setHandler = server.server.setRequestHandler.bind(server.server);
  server.server.setRequestHandler = (schema, handler) => {
    if ((schema as unknown) !== CallToolRequestSchema) return setHandler(schema, handler);
    return setHandler(schema, async (request, extra) => {
      const start = now();
      const name = (request as unknown as { params: { name: string } }).params.name;
      let result: unknown;
      let thrown = false;
      try {
        result = await handler(request, extra);
        return result as Awaited<ReturnType<typeof handler>>;
      } catch (error) {
        thrown = true;
        throw error;
      } finally {
        try {
          const durationMs = Math.max(0, now() - start);
          sink.record({
            version: 1,
            session,
            timestamp: new Date().toISOString(),
            tool: names.has(name) ? name : 'unknown',
            durationMs,
            ...resultMetadata(result, thrown),
          });
        } catch {
          /* Telemetry must never change a tool's behavior. */
        }
      }
    });
  };
}
