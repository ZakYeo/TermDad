import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolError } from './tool-result.js';

/** A GUI switch cannot split a multi-step tool call across terminal instances. */
export class TerminalSelectionGate {
  private active = 0;
  private switching = false;
  async run<T>(select: boolean, operation: () => Promise<T>): Promise<T> {
    if (this.switching || (select && this.active))
      throw new Error('TERMINAL_BUSY: wait for active tool calls to finish before switching GUI');
    if (select) this.switching = true;
    this.active++;
    try {
      return await operation();
    } finally {
      this.active--;
      if (select) this.switching = false;
    }
  }
}

// Install before registering tools so every registrar, including waits and
// screenshots, participates in the same gate. Normal calls remain concurrent.
export function guardTerminalSelection(server: McpServer) {
  const gate = new TerminalSelectionGate(),
    register = server.registerTool.bind(server);
  server.registerTool = (name, config, callback) =>
    register(name, config, ((...args: unknown[]) =>
      gate
        .run(name === 'terminal.select_instance', () =>
          Promise.resolve((callback as (...args: unknown[]) => unknown)(...args)),
        )
        .catch((e) => toolError(name, e))) as typeof callback);
}
