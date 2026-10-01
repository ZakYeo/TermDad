import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EventQueue } from './events.js';
import { registerEventTools } from './event-tools.js';
import { WezTermBackend, type TerminalBackend, id, spawnSchema, sendKeys, submit, keyDescription } from './backend.js';
import { Agents, adoptionSchema, reattachSchema } from './agents.js';
import { FileWorkerStorage, type WorkerStorage } from './worker-storage.js';
import { CommandScreenshotProvider, type ScreenshotProvider } from './screenshots.js';
import { WatchManager, type WatchOptions } from './watches.js';
import { registerWatchTools } from './watch-tools.js';
import { CommandNotificationProvider } from './notifications.js';
import { attemptReferenceSchema } from './task-results.js';
import { TaskBoard } from './tasks.js';
import { FileTaskStorage, type TaskStorage } from './task-storage.js';
import { registerTaskTools } from './task-tools.js';
import { withWorkerTasks } from './task-workers.js';
import { AttentionService } from './attention.js';
import { registerAttentionTools } from './attention-tools.js';
import { guardTerminalSelection } from './terminal-selection.js';
import { PushIngress, PushSocket, pushSocketPath } from './ingress.js';
import { WorkerPushRegistry } from './push-workers.js';
import { registerPushTools } from './push-tools.js';
import { notifyCommand } from './worker-hooks.js';
import { stateDirectory, reapStaleLocks } from './journal.js';
import { oneOf, waitShape, waitTimeout } from './arguments.js';
import { toolCall, toolError } from './tool-result.js';
import { CodedError } from './errors.js';
import { join } from 'node:path';
import { instrumentTools, type TelemetryOptions } from './telemetry.js';
import { Monitoring } from './monitoring.js';
import { FileTelemetry } from './telemetry-storage.js';
import { UsageService } from './usage.js';
import { registerUsageTools } from './usage-tools.js';
export function createServer(
  backend: TerminalBackend = new WezTermBackend(),
  screenshots: ScreenshotProvider = new CommandScreenshotProvider(),
  watchOptions: WatchOptions | EventQueue = {},
  eventQueue?: EventQueue,
  workerStorage: WorkerStorage = new FileWorkerStorage(),
  taskStorage: TaskStorage = new FileTaskStorage(),
  telemetryOptions: TelemetryOptions = {},
  usageService?: UsageService,
) {
  const server = new McpServer({ name: 'term-dad', version: '0.1.0' }),
    tasks = new TaskBoard(taskStorage);
  const telemetry =
    telemetryOptions.telemetry ??
    (process.env.TERM_DAD_TELEMETRY === '0' ? false : new FileTelemetry(join(stateDirectory(), 'telemetry')));
  if (telemetry) instrumentTools(server, telemetry, telemetryOptions.now);
  const monitoring =
    telemetryOptions.monitoring ??
    (process.env.TERM_DAD_MONITORING === '1' ? Monitoring.file(join(stateDirectory(), 'monitoring')) : undefined);
  if (monitoring) backend = monitoring.backend(backend);
  const socketPath = pushSocketPath(stateDirectory());
  // A pushed event still publishes bounded metadata; `watches.confirm` then samples the pane
  // so the recorded status comes from the terminal rather than from the worker's claim.
  const ingress = new PushIngress({
    sink: async (event) => {
      const start = performance.now();
      let success = false;
      try {
        await events.publish(event);
        await watches.confirm(event.paneId);
        success = true;
      } finally {
        if (monitoring)
          monitoring.record({
            kind: 'push',
            paneId: event.paneId,
            eventKind: event.kind,
            success,
            durationMs: performance.now() - start,
          });
      }
    },
  });
  const pushSocket = new PushSocket(ingress, socketPath);
  const stateDir = stateDirectory();
  const events: EventQueue = watchOptions instanceof EventQueue ? watchOptions : (eventQueue ?? new EventQueue());
  const usage = usageService ?? new UsageService(undefined, events);
  const push = new WorkerPushRegistry(ingress, socketPath, notifyCommand(), stateDir);
  const agents = new Agents(backend, workerStorage, push, {
    spawn: async (agentId, ref) => {
      if (!ref) return;
      await usage.assertDispatch(undefined, ref);
      await usage.mutate(ref, (a) => {
        a.config.workerIds.push(agentId);
      });
    },
    send: (agentId) => usage.assertDispatch(agentId),
  });
  // Push can then report on a managed worker it holds no registration for, rather than failing,
  // accept the worker's name, and re-key a surviving worker on demand under its own lock.
  push.attachWorkers(async (agentIdOrName) => {
    const w = await agents.resolveOptional(agentIdOrName);
    if (!w) return undefined;
    const attached = w.paneId !== null && (await agents.isAttached(w).catch(() => false));
    return {
      agentId: w.agentId,
      cli: w.cli,
      push: w.push,
      ...(attached ? { rekey: () => agents.rekey(w.agentId) } : {}),
    };
  });
  guardTerminalSelection(server);
  const register = (name: string, description: string, shape: z.ZodRawShape, fn: (a: any) => Promise<unknown>) =>
    server.registerTool(name, { description, inputSchema: shape }, (a) => toolCall(name, () => fn(a)));
  const pane = { paneId: id },
    agent = { agentId: z.string().min(1) },
    text = { text: z.string().max(100000) },
    wait = waitShape;
  // `text` or `message`: both spellings were used for days, so both are accepted and one is required.
  const textOrMessage = {
    text: z.string().max(100000).optional().describe('the text to submit (alias: message)'),
    message: z
      .string()
      .max(100000)
      .optional()
      .describe('Alias for text; provide text or message, with matching values if both are present.'),
  };
  const body = (a: { text?: string; message?: string }) => oneOf<string>(a, ['text', 'message']);
  register('terminal.list', 'List live WezTerm windows, tabs and panes.', {}, () => backend.list());
  register(
    'terminal.list_instances',
    'List verified running WezTerm GUIs and the selected identity (Windows/WSL).',
    {},
    async () => {
      if (!backend.listInstances) throw new Error('GUI selection is unavailable for this backend');
      const instances = await backend.listInstances();
      try {
        return { instances, selected: (await backend.instance?.()) ?? null };
      } catch (e) {
        return {
          instances,
          selected: null,
          selectionError: e instanceof Error ? e.message : 'Selected GUI unavailable',
        };
      }
    },
  );
  register(
    'terminal.select_instance',
    'Switch this server to an exact GUI identity returned by terminal.list_instances; sends no input. Remove watches first.',
    { key: z.string().min(1).max(1024) },
    async (a) => {
      if (!backend.selectInstance) throw new Error('GUI selection is unavailable for this backend');
      watches.assertSwitchable();
      return { selected: await backend.selectInstance(a.key) };
    },
  );
  register(
    'terminal.spawn',
    'Create a visible tab or window; command is an argv array or one command line (split like a shell, no shell run).',
    spawnSchema.shape,
    (a) => backend.spawn(a),
  );
  register(
    'terminal.split',
    'Split right (side by side) or bottom (stacked).',
    {
      ...spawnSchema.shape,
      ...pane,
      direction: z.enum(['right', 'bottom']).default('right'),
      percent: z.number().int().min(1).max(99).optional(),
    },
    (a) => backend.split(a),
  );
  register(
    'terminal.read',
    'Read visible text and scrollback: paneId (alias pane_id), lines (alias max_lines, default 100).',
    {
      paneId: id.optional().describe('Pane ID (alias pane_id).'),
      pane_id: id.optional().describe('Alias for paneId.'),
      lines: z.number().int().min(1).max(5000).optional().describe('Tail lines, default 100 (alias max_lines).'),
      max_lines: z.number().int().min(1).max(5000).optional().describe('Alias for lines.'),
    },
    (a) => backend.read(oneOf(a, ['paneId', 'pane_id']), oneOf(a, ['lines', 'max_lines'], 100)),
  );
  register('terminal.send_text', 'Paste text into an interactive PTY without Enter.', { ...pane, ...text }, (a) =>
    backend.sendText(a.paneId, a.text),
  );
  register(
    'terminal.submit',
    'Paste text then press Enter in an existing application; with no text, press Enter only.',
    { ...pane, text: z.string().max(100000).optional() },
    (a) => submit(backend, a.paneId, a.text),
  );
  register(
    'terminal.send_key',
    `Send a named terminal key without bracketed paste. ${keyDescription}`,
    { ...pane, key: z.string().describe(keyDescription) },
    (a) => sendKeys(backend, a.paneId, [a.key]),
  );
  register(
    'terminal.send_keys',
    `Send an ordered sequence of terminal keys without bracketed paste; validates all names before sending. ${keyDescription}`,
    { ...pane, keys: z.array(z.string().describe(keyDescription)).min(1).max(100) },
    (a) => sendKeys(backend, a.paneId, a.keys),
  );
  // `paneId` alone is the common case and was rejected for days; it selects target 'pane'.
  const targetId = z.union([
    id,
    z
      .string()
      .regex(/^[0-9]+$/)
      .transform(Number)
      .pipe(id),
  ]);
  const target = {
    target: z.enum(['pane', 'tab', 'window']).default('pane'),
    id: targetId
      .optional()
      .describe('the pane, tab or window ID for target (alias: paneId, which implies target pane)'),
    paneId: targetId.optional().describe('Pane ID alias for id; only valid with target pane.'),
  };
  const selected = async (a: { target: 'pane' | 'tab' | 'window'; id?: number; paneId?: number }) => {
    if (a.paneId !== undefined && a.target !== 'pane')
      throw new CodedError('ARGUMENT_CONFLICT', 'paneId requires target pane; use id for a tab or window');
    const chosen = oneOf<number>(a, ['id', 'paneId']);
    return (await backend.list()).filter((p) => p[`${a.target}_id`] === chosen);
  };
  register(
    'terminal.close',
    'Kill all processes in the selected pane, tab or window (id with target, or paneId).',
    target,
    async (a) => {
      const panes = await selected(a);
      if (!panes.length) throw new Error('Target not found');
      for (const p of panes) {
        await backend.close(p.pane_id);
        await agents.reconcileClosed(p.pane_id);
      }
      return { closed: panes.map((p) => p.pane_id) };
    },
  );
  register(
    'terminal.focus',
    'Activate a pane or a pane in a tab/window (id with target, or paneId); OS foreground is platform dependent.',
    target,
    async (a) => {
      const [p] = await selected(a);
      if (!p) throw new Error('Target not found');
      await backend.focus(p.pane_id);
    },
  );
  register(
    'terminal.resize',
    'Resize a split by cell count.',
    {
      ...pane,
      direction: z.enum(['Left', 'Right', 'Up', 'Down']),
      amount: z.number().int().min(1).max(1000).default(1),
    },
    (a) => backend.resize(a.paneId, a.direction, a.amount),
  );
  register(
    'terminal.move',
    'Move pane into a new tab, optionally in a new or specified window.',
    { ...pane, newWindow: z.boolean().optional(), windowId: id.optional() },
    (a) => {
      if (a.newWindow && a.windowId !== undefined)
        throw new CodedError('ARGUMENT_CONFLICT', 'newWindow and windowId are mutually exclusive; supply one of them');
      return backend.move(a.paneId, a.newWindow, a.windowId);
    },
  );
  register('terminal.snapshot', 'Workspace panes with recent text and managed agents.', {}, async () => {
    const snapshot = await agents.workspaceSnapshot();
    return { ...snapshot, agents: await withWorkerTasks(snapshot.agents, tasks) };
  });
  register(
    'agent.spawn',
    'Start a visible interactive worker. Codex receives the Term Dad worker skill with its first task. Readiness timeout leaves pane available for diagnosis; never auto-approves permissions.',
    {
      ...spawnSchema.shape,
      name: z.string().min(1).max(100),
      cli: z.enum(['claude', 'codex', 'shell']),
      prompt: z.string().max(100000).optional(),
      accountRef: z.string().min(1).max(100).optional().describe('Explicit usage account binding for the new worker.'),
      ...wait,
    },
    async (a) => {
      if (a.accountRef) {
        await usage.account(a.accountRef);
        await usage.assertDispatch(undefined, a.accountRef);
      }
      const result = await agents.spawn({ ...a, timeoutMs: waitTimeout(a) });
      return result;
    },
  );
  register(
    'agent.list',
    'List saved workers, attachment state and recovery reasons without terminal text.',
    {},
    async () => withWorkerTasks(await agents.list(), tasks),
  );
  register(
    'agent.adopt',
    'Adopt an existing pane without sending input; Codex initializes on the next task unless declared initialized.',
    adoptionSchema.shape,
    (a) => agents.adopt(a),
  );
  register(
    'agent.reattach',
    'Bind a saved worker using both agentId and paneId; inspect uncertain delivery before acknowledging it.',
    reattachSchema.shape,
    (a) => agents.reattach(a),
  );
  register('agent.forget', 'Remove a saved mapping without closing its pane.', agent, (a) => agents.forget(a.agentId));
  register(
    'agent.send',
    'Submit text (alias message) to agentId (alias to); initializes the Codex worker skill if no task has been sent yet.',
    {
      agentId: agent.agentId.optional().describe('Worker ID or name (alias to).'),
      to: agent.agentId.optional().describe('Alias for agentId.'),
      ...textOrMessage,
      attempt: attemptReferenceSchema.optional(),
    },
    async (a) => {
      const task = body(a);
      const agentId = oneOf<string>(a, ['agentId', 'to']);
      await usage.assertDispatch((await agents.resolve(agentId)).agentId);
      if (a.attempt) {
        const worker = await agents.resolve(agentId);
        await tasks.validateAttempt(a.attempt.taskId, a.attempt.attemptId, worker.agentId);
      }
      return agents.send(agentId, task, a.attempt);
    },
  );
  for (const name of ['observe', 'status'])
    register(
      `agent.${name}`,
      'Observe state, activity and the tail of normalized output (20 lines by default). Pass since to get only the change since that observation; raise lines only when a screen is actually needed.',
      { ...agent, since: z.string().optional(), lines: z.number().int().min(1).max(150).default(20) },
      (a) => agents.observe(a.agentId, a.since, a.lines),
    );
  register('agent.interrupt', 'Send Ctrl+C to worker.', agent, (a) => agents.interrupt(a.agentId));
  register('agent.stop', 'Close worker pane and remove mapping.', agent, (a) => agents.stop(a.agentId));
  server.registerTool(
    'agent.wait_for_outcome',
    {
      description:
        'Wait for required input, heuristic turn completion, optional quiet output, disappearance or timeout. Never verifies task success. lastObservation carries the change since `since` when given, capped to `lines`.',
      inputSchema: {
        ...agent,
        turnId: z.uuid(),
        ...wait,
        quietMs: z.number().int().min(1000).max(3600000).optional(),
        since: z.string().optional(),
        lines: z.number().int().min(1).max(150).default(20),
      },
    },
    (a, extra) =>
      toolCall('agent.wait_for_outcome', () =>
        agents.waitForOutcome(a.agentId, a.turnId, waitTimeout(a), a.quietMs, extra.signal, {
          since: a.since,
          lines: a.lines,
        }),
      ),
  );
  for (const kind of ['text', 'idle'] as const) {
    server.registerTool(
      kind === 'text' ? 'agent.wait_for_text' : 'agent.wait_until_idle',
      {
        description:
          kind === 'text'
            ? 'Wait for literal text; lock contention is retried within timeoutMs (alias timeoutSeconds).'
            : 'Wait for a recognized prompt; silence never counts. Lock contention is retried within timeoutMs (alias timeoutSeconds).',
        inputSchema: { ...agent, ...wait, ...(kind === 'text' ? { text: z.string().min(1) } : {}) },
      },
      (a, extra) =>
        toolCall(kind === 'text' ? 'agent.wait_for_text' : 'agent.wait_until_idle', () =>
          agents.wait(
            a.agentId,
            kind === 'text'
              ? (o) => o.recentText.includes(a.text as string)
              : (o) => ['READY_FOR_PROMPT', 'IDLE'].includes(o.status),
            waitTimeout(a),
            extra.signal,
          ),
        ),
    );
  }
  register(
    'agent.broadcast',
    'Submit a message (text, alias message) to explicit workers; returns per-agent outcomes.',
    { agentIds: z.array(z.string()).min(1).max(64), ...textOrMessage },
    async (a) => {
      const task = body(a);
      return Promise.all(
        a.agentIds.map(async (agentId: string) => {
          try {
            await usage.assertDispatch((await agents.resolve(agentId)).agentId);
            return await agents.send(agentId, task);
          } catch (e) {
            return { agentId, error: String(e) };
          }
        }),
      );
    },
  );
  register(
    'agent.collect_results',
    'Collect observations; does not infer task success from idle state.',
    {},
    async () => withWorkerTasks(await agents.snapshot(), tasks),
  );
  register(
    'orchestrator.status',
    'Status, activity and task summary of every managed agent without screen text; use agent.status for the one you need to read.',
    {},
    async () => {
      const workers = await withWorkerTasks(await agents.summaries(), tasks);
      const { accounts } = await usage.status();
      return workers.map((worker) => {
        const account = accounts.find((a) => a.workerIds.includes(worker.agentId));
        return account
          ? {
              ...worker,
              usage: {
                accountRef: account.accountRef,
                phase: account.phase,
                reason: account.reason,
                freshness: account.freshness,
              },
            }
          : worker;
      });
    },
  );
  for (const kind of ['terminal', 'agent'])
    server.registerTool(
      `${kind}.screenshot`,
      {
        description: 'Capture on demand through the configured platform screenshot provider.',
        inputSchema: kind === 'terminal' ? pane : agent,
      },
      async (a: any) => {
        try {
          return {
            content: [
              await (kind === 'terminal'
                ? screenshots.capture(a.paneId, await backend.instance?.())
                : agents.withPane(a.agentId, (paneId, instance) => screenshots.capture(paneId, instance))),
            ],
          };
        } catch (e) {
          return toolError(`${kind}.screenshot`, e);
        }
      },
    );
  const options = watchOptions instanceof EventQueue ? {} : watchOptions;
  const watches: WatchManager = new WatchManager(backend, agents, {
    notifications: CommandNotificationProvider.fromEnvironment(),
    pushDeliverable: (agentId) => push.deliverable(agentId),
    pushProven: (agentId) => !!agentId && !ingress.revoked(agentId) && ingress.status(agentId).proven,
    ...(monitoring ? { monitoring } : {}),
    ...options,
    sink: options.sink ?? ((input) => events.publish(input)),
  });
  // Listening is best effort: a server that cannot bind still polls, it just cannot be pushed to.
  const pushReady = pushSocket
    .listen()
    .then((path) => {
      push.attach({ listening: true });
      return path;
    })
    .catch((e) => {
      const message = e instanceof Error ? e.message : String(e);
      push.attach({ listening: false, bindError: message });
      console.error(`[term-dad] push socket: ${message}`);
      return undefined;
    });
  // A worker that outlived the previous server rereads its credential file, so re-keying it is
  // what makes push recoverable without killing the pane. Skipped entirely when the socket did
  // not bind: rewriting credentials to a dead path would also strand a live peer server's worker.
  const pushRestored = pushReady
    .then((path) => (path ? agents.restorePush() : undefined))
    .catch((e) => {
      console.error(`[term-dad] push restore: ${e instanceof Error ? e.message : e}`);
    });
  // Locks whose holder has exited would otherwise fail every write in every server sharing the
  // directory until someone removed them by hand. Only dead holders are reclaimed; see journal.ts.
  const reaped = reapStaleLocks(stateDir)
    .then((removed) => {
      for (const name of removed) console.error(`[term-dad] reclaimed stale ${name}`);
      return removed;
    })
    .catch(() => [] as string[]);
  const closeTasks = registerTaskTools(server, tasks, () => agents.list());
  const attention = new AttentionService(
    () => tasks.snapshot(),
    () => agents.snapshot(),
  );
  const closeAttention = registerAttentionTools(server, attention, () => usage.status());
  registerUsageTools(server, usage, (id) => agents.resolve(id));
  usage.start();
  const closeEvents = registerEventTools(server, events);
  registerPushTools(server, push);
  const closeWatches = registerWatchTools(server, watches);
  // Shutdown order, explicitly: watches stop sampling and drain their in-flight sink first, so
  // the queue that sink publishes to is still open; the queue then settles every wait; the
  // attention and task services drain; finally the push socket and the worker registry close.
  // Nothing here closes a worker pane. The SDK fires onclose without awaiting it, so the same
  // memoised promise serves both the SDK and an explicit `dispose()`.
  const shutdown = [
    closeWatches,
    () => usage.close(),
    closeEvents,
    closeAttention,
    closeTasks,
    () => pushSocket.close(),
    () => agents.close(),
  ];
  let disposed: Promise<void> | undefined;
  const dispose = () =>
    (disposed ??= (async () => {
      try {
        for (const step of shutdown) await step();
      } finally {
        if (telemetry) await telemetry.close?.().catch(() => {});
        if (monitoring) await monitoring.close();
      }
    })());
  server.server.onclose = dispose;
  return {
    server,
    agents,
    watches,
    events,
    usage,
    tasks,
    attention,
    push,
    ingress,
    pushSocket,
    pushReady,
    pushRestored,
    reaped,
    dispose,
  };
}
