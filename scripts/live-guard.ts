import type { TerminalInstance } from '../src/worker-storage.js';

/** Test-only policy: never infer ownership from a pane list or worker registry. */
export class LiveGuard {
  readonly panes = new Set<number>();
  readonly agents = new Set<string>();
  private identity?: TerminalInstance;
  constructor(private readonly endpoint: string | undefined) {}
  verify(instance: TerminalInstance | null) {
    if (
      !this.endpoint ||
      !instance ||
      instance.endpoint.replaceAll('\\', '/').toLowerCase() !== this.endpoint.replaceAll('\\', '/').toLowerCase()
    )
      throw new Error('Live tests require the explicitly configured, verified WezTerm endpoint');
    if (this.identity && (instance.key !== this.identity.key || instance.endpoint !== this.identity.endpoint))
      throw new Error('Live test terminal identity changed; refusing operation and cleanup');
    this.identity ??= instance;
  }
  authorize(name: string, args: Record<string, unknown>) {
    if (name === 'terminal.select_instance') throw new Error('Live tests cannot switch GUI instances');
    if (args.newWindow || args.windowId !== undefined)
      throw new Error('Live tests create tabs only in the pinned current window');
    if (name === 'terminal.spawn' || name === 'agent.spawn') return;
    if (name === 'terminal.list' || name === 'terminal.list_instances' || name === 'agent.list') return;
    if (name === 'terminal.snapshot' || name === 'agent.collect_results' || name === 'orchestrator.status') return;
    if (name.startsWith('terminal.') || name === 'agent.adopt') {
      if (args.target !== undefined && args.target !== 'pane')
        throw new Error('Live tests may target only owned panes');
      const ids = Array.isArray(args.paneIds) ? args.paneIds : [args.paneId ?? args.pane_id ?? args.id];
      if (ids.some((id) => typeof id !== 'number' || !this.panes.has(id)))
        throw new Error('Refusing operation on unowned pane');
    }
    if (name.startsWith('agent.') && name !== 'agent.adopt') {
      const ids = Array.isArray(args.agentIds) ? args.agentIds : [args.agentId];
      if (ids.some((id) => typeof id !== 'string' || !this.agents.has(id)))
        throw new Error('Refusing operation on unowned worker');
    }
  }
}
