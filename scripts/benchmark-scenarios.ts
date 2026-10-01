import type { Fixture } from './benchmark-fixture.js';

type Context = { worker?: any; adopted?: any; task?: any; turn?: any; watch?: any; event?: any; spare?: number };
export interface Scenario {
  tool: string;
  args: (c: Context) => Record<string, unknown>;
  save?: (c: Context, result: any) => void;
  setup?: (f: Fixture, c: Context) => Promise<void>;
  expected?: 'timeout';
}
const worker = (c: Context) => ({ agentId: c.worker.agentId });
const task = (c: Context) => ({ taskId: c.task.id, expectedRevision: c.task.revision });
const saveTask = (c: Context, value: any) => {
  c.task = value;
};
const empty = () => ({});
/** One repeatable workflow covers every registered tool; a fresh fixture resets each iteration. */
export const scenarios: Scenario[] = [
  { tool: 'terminal.list', args: empty },
  { tool: 'terminal.list_instances', args: empty },
  { tool: 'terminal.select_instance', args: () => ({ key: 'benchmark' }) },
  {
    tool: 'terminal.spawn',
    args: () => ({ command: ['bash'] }),
    save: (c, r) => {
      c.spare = r;
    },
  },
  { tool: 'terminal.split', args: () => ({ paneId: 1, command: ['bash'] }) },
  { tool: 'terminal.read', args: () => ({ paneId: 1 }) },
  { tool: 'terminal.send_text', args: () => ({ paneId: 1, text: 'fixture' }) },
  { tool: 'terminal.submit', args: () => ({ paneId: 1, text: 'fixture' }) },
  { tool: 'terminal.send_key', args: () => ({ paneId: 1, key: 'Escape' }) },
  { tool: 'terminal.send_keys', args: () => ({ paneId: 1, keys: ['Down', 'Up'] }) },
  { tool: 'terminal.focus', args: () => ({ paneId: 1 }) },
  { tool: 'terminal.resize', args: () => ({ paneId: 1, direction: 'Left', amount: 1 }) },
  { tool: 'terminal.move', args: () => ({ paneId: 1 }) },
  { tool: 'terminal.screenshot', args: () => ({ paneId: 1 }) },
  {
    tool: 'agent.spawn',
    args: () => ({ name: 'worker', cli: 'shell', command: ['bash'] }),
    save: (c, r) => {
      c.worker = r;
    },
  },
  {
    tool: 'agent.adopt',
    args: () => ({ name: 'adopted', cli: 'shell', paneId: 1 }),
    save: (c, r) => {
      c.adopted = r;
    },
  },
  { tool: 'agent.reattach', args: (c) => ({ agentId: c.adopted.agentId, paneId: 1 }) },
  { tool: 'agent.list', args: empty },
  { tool: 'agent.observe', args: worker },
  { tool: 'agent.status', args: worker },
  { tool: 'agent.wait_for_text', args: (c) => ({ ...worker(c), text: 'benchmark output', timeoutMs: 1 }) },
  { tool: 'agent.wait_until_idle', args: (c) => ({ ...worker(c), timeoutMs: 1 }) },
  { tool: 'agent.screenshot', args: worker },
  { tool: 'orchestrator.status', args: empty },
  { tool: 'agent.collect_results', args: empty },
  { tool: 'terminal.snapshot', args: empty },
  {
    tool: 'task.create',
    args: () => ({ boardId: 'benchmark', title: 'Fixture task', goal: 'Measure tools' }),
    save: saveTask,
  },
  { tool: 'task.get', args: (c) => ({ taskId: c.task.id }) },
  { tool: 'task.list', args: empty },
  { tool: 'task.update', args: (c) => ({ ...task(c), patch: { priority: 'high' } }), save: saveTask },
  { tool: 'task.assign', args: (c) => ({ ...task(c), agentId: c.worker.agentId }), save: saveTask },
  { tool: 'task.start_attempt', args: task, save: saveTask },
  {
    tool: 'agent.send',
    args: (c) => ({
      ...worker(c),
      text: 'fixture',
      attempt: { taskId: c.task.id, attemptId: c.task.currentAttemptId },
    }),
    save: (c, r) => {
      c.turn = r;
    },
  },
  {
    tool: 'agent.wait_for_outcome',
    args: (c) => ({ ...worker(c), turnId: c.turn.turnId, timeoutMs: 1 }),
    expected: 'timeout',
  },
  {
    tool: 'task.report_result',
    args: (c) => ({
      ...task(c),
      attemptId: c.task.currentAttemptId,
      outcome: 'succeeded',
      summary: 'Fixture report',
      workVersion: 'fixture',
      provenance: 'supervisor_recorded',
      artifacts: [],
      checks: [],
    }),
    save: saveTask,
  },
  {
    tool: 'task.verify',
    args: (c) => ({
      ...task(c),
      attemptId: c.task.currentAttemptId,
      reportId: c.task.latestReport.id,
      workVersion: 'fixture',
      result: 'passed',
      rationale: 'Fixture decision',
      criteria: [],
      complete: true,
    }),
    save: saveTask,
  },
  { tool: 'task.history', args: (c) => ({ taskId: c.task.id }) },
  { tool: 'task.archive', args: (c) => ({ ...task(c), archived: true }), save: saveTask },
  { tool: 'orchestrator.attention', args: empty },
  {
    tool: 'watch.create',
    args: worker,
    save: (c, r) => {
      c.watch = r;
    },
  },
  { tool: 'watch.list', args: empty },
  { tool: 'watch.remove', args: (c) => ({ watchId: c.watch.watchId }) },
  { tool: 'push.status', args: empty },
  { tool: 'push.set', args: (c) => ({ ...worker(c), enabled: false }) },
  {
    tool: 'event.list',
    args: empty,
    setup: async (f, c) => {
      c.event = await f.app.events.publish({
        kind: 'ready',
        paneId: 1,
        occurredAt: new Date().toISOString(),
        summary: 'Fixture ready.',
      });
    },
  },
  { tool: 'event.wait_for_event', args: () => ({ freshOnly: false, timeoutMs: 1 }) },
  { tool: 'event.acknowledge', args: (c) => ({ ids: [c.event.id] }) },
  { tool: 'event.wake_command', args: empty },
  { tool: 'usage.configure', args: () => ({ accountRef: 'benchmark', provider: 'codex' }) },
  { tool: 'usage.status', args: empty },
  { tool: 'usage.refresh', args: () => ({ accountRef: 'benchmark' }) },
  { tool: 'usage.watch', args: () => ({ accountRef: 'benchmark' }) },
  { tool: 'usage.unwatch', args: () => ({ accountRef: 'benchmark' }) },
  { tool: 'agent.broadcast', args: (c) => ({ agentIds: [c.worker.agentId, c.adopted.agentId], text: 'fixture' }) },
  { tool: 'agent.interrupt', args: worker },
  { tool: 'agent.forget', args: (c) => ({ agentId: c.adopted.agentId }) },
  { tool: 'agent.stop', args: worker },
  { tool: 'terminal.close', args: (c) => ({ paneId: c.spare }) },
];
export type ScenarioContext = Context;
