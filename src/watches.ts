import type { Monitoring } from './monitoring.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { inputKind } from './interaction.js';
import { adapters, type Status } from './adapters.js';
import { Agents, hashOutput, normalizeScreen } from './agents.js';
import type { WorkerRecord } from './worker-storage.js';
import { id, type TerminalBackend } from './backend.js';
import { TerminalRead } from './terminal-read.js';
import type { NotificationProvider } from './notifications.js';

export interface WatchEventInput {
  kind: string;
  paneId: number;
  watchId?: string;
  agentId?: string;
  occurredAt: string;
  summary: string;
}
export type WatchEventSink = (input: WatchEventInput) => Promise<unknown>;
export const watchShape = {
  paneId: id.optional(),
  agentId: z.string().min(1).max(100).optional(),
  adapter: z.enum(['claude', 'codex', 'shell']).optional(),
  pollMs: z.number().int().min(500).max(60000).default(2000),
  pushPollMs: z.number().int().min(1000).max(3600000).default(30000),
  inactivityMs: z.number().int().min(1000).max(3600000).default(60000),
  attentionMs: z.number().int().min(1000).max(3600000).default(120000),
  cooldownMs: z.number().int().min(0).max(3600000).default(10000),
  notify: z.boolean().default(false),
};
const schema = z
  .object(watchShape)
  .refine((o) => (o.paneId !== undefined) !== (o.agentId !== undefined), 'Choose exactly one paneId or agentId');
type Config = z.infer<typeof schema>;
type Pending = { event: WatchEventInput; sinkDone: boolean; notificationDone: boolean };
type Watch = Config & {
  agentBinding?: WorkerRecord;
  watchId: string;
  paneId: number;
  agentId?: string;
  hash?: string;
  status?: Status;
  changedAt: number;
  quiet: boolean;
  disappeared: boolean;
  lastPoll: number;
  lastDelivery?: number;
  pending: Map<string, Pending>;
  attentionKey?: string;
  backendError?: string;
  deliveryError?: string;
  lastEvent?: WatchEventInput;
};
const summaries: Record<string, string> = {
  input_required: 'Pane requires user input.',
  ready: 'Pane returned to a recognized prompt; task success is not established.',
  inactive: 'Pane text is unchanged; task success is not established.',
  pane_disappeared: 'Pane is no longer present.',
  attention_required:
    'Pane needs a person: an unanswered prompt, or a question left at a ready prompt; task success is not established.',
};
/** The one kind that exists to stop a human waiting: it replaces its own pending entry and ignores the cooldown. */
const attention = 'attention_required';
export interface WatchOptions {
  monitoring?: Monitoring;
  pushProven?: (agentId?: string) => boolean;
  sink?: WatchEventSink;
  notifications?: NotificationProvider;
  now?: () => number;
  automatic?: boolean;
  pushDeliverable?: (agentId?: string) => boolean;
}
export class WatchManager {
  private records = new Map<string, Watch>();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private disposed = false;
  private creations = new Set<Promise<unknown>>();
  private now: () => number;
  constructor(
    private backend: TerminalBackend,
    private agents: Agents,
    private options: WatchOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }
  create(input: unknown) {
    const task = this.createInternal(input);
    this.creations.add(task);
    void task.finally(() => this.creations.delete(task)).catch(() => {});
    return task;
  }
  private async createInternal(input: unknown) {
    if (this.disposed) throw new Error('Watch manager is disposed');
    const config = schema.parse(input);
    if (this.records.size >= 64) throw new Error('Maximum of 64 watches reached');
    if (config.notify && !this.options.notifications) throw new Error('Desktop notifications are not configured');
    const agent = config.agentId
      ? await this.agents.resolve(config.agentId)
      : await this.agents.findByPane(config.paneId!);
    // Lookup yields to concurrent creations and disposal; validate again before inserting.
    if (this.disposed) throw new Error('Watch manager is disposed');
    if (this.records.size >= 64) throw new Error('Maximum of 64 watches reached');
    if (agent?.paneId === null) throw new Error('Worker spawn reservation needs explicit recovery');
    if (!agent && !config.adapter) throw new Error('An unmanaged pane requires an explicit adapter');
    const w: Watch = {
      ...config,
      agentBinding: agent,
      agentId: agent?.agentId,
      paneId: agent?.paneId ?? config.paneId!,
      watchId: randomUUID(),
      changedAt: this.now(),
      quiet: false,
      disappeared: false,
      lastPoll: Infinity,
      pending: new Map(),
    };
    this.records.set(w.watchId, w);
    try {
      await TerminalRead.run(this.backend, (read) => this.sample(w, true, read, 'baseline'));
      if (w.disappeared) throw new Error('Pane not found');
    } catch {
      this.records.delete(w.watchId);
      throw new Error('Cannot observe target pane. Check that it exists and backend connectivity is available.');
    }
    if (this.disposed || !this.records.has(w.watchId)) throw new Error('Watch removed during creation');
    w.lastPoll = this.now();
    this.options.monitoring?.record({ kind: 'watch', watchId: w.watchId, paneId: w.paneId, phase: 'start' });
    this.schedule();
    return this.view(w);
  }
  list() {
    return [...this.records.values()].map((w) => this.view(w));
  }
  assertSwitchable() {
    if (this.records.size || this.creations.size || this.running)
      throw new Error('TERMINAL_BUSY: remove watches and let polling finish before switching GUI');
  }
  private view(w: Watch) {
    return {
      watchId: w.watchId,
      paneId: w.paneId,
      agentId: w.agentId,
      adapter: w.adapter,
      pollMs: w.pollMs,
      pushPollMs: w.pushPollMs,
      pushBacked: this.pushed(w),
      inactivityMs: w.inactivityMs,
      attentionMs: w.attentionMs,
      cooldownMs: w.cooldownMs,
      notify: w.notify,
      status: w.status,
      disappeared: w.disappeared,
      pendingEvents: w.pending.size,
      lastEvent: w.lastEvent,
      backendError: w.backendError,
      deliveryError: w.deliveryError,
    };
  }
  remove(watchId: string) {
    const w = this.records.get(watchId);
    if (w) this.recordWatchEnd(w);
    const removed = this.records.delete(watchId);
    if (!this.records.size && this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    return { removed };
  }
  async dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const w of this.records.values()) this.recordWatchEnd(w);
    this.records.clear();
    await Promise.allSettled([...this.creations, ...(this.running ? [this.running] : [])]);
  }
  private recordWatchEnd(w: Watch) {
    // Baseline creation has no start yet; disappeared watches have already ended.
    if (!w.disappeared && Number.isFinite(w.lastPoll))
      this.options.monitoring?.record({ kind: 'watch', watchId: w.watchId, paneId: w.paneId, phase: 'end' });
  }
  private disappeared(w: Watch, baseline: boolean) {
    this.recordWatchEnd(w);
    w.disappeared = true;
    if (!baseline) this.enqueue(w, 'pane_disappeared');
  }
  private active(w: Watch) {
    return !this.disposed && this.records.get(w.watchId) === w;
  }
  /** A pane whose worker can really deliver its own events only needs a slow liveness backstop. */
  private pushed(w: Watch) {
    return this.options.pushDeliverable?.(w.agentId) === true;
  }
  private interval(w: Watch) {
    return this.pushed(w) ? w.pushPollMs : w.pollMs;
  }
  /**
   * Verifies a pushed event against the pane itself: the worker reports that something
   * happened, the sample decides what the pane's state actually is.
   */
  async confirm(paneId: number) {
    await TerminalRead.run(this.backend, async (read) => {
      for (const w of [...this.records.values()])
        if (w.paneId === paneId && this.active(w) && !w.disappeared) await this.visit(w, read, 'push');
    });
  }
  /** One sample-then-deliver pass over a watch, shared by the poll timer and pushed confirmations. */
  private async visit(w: Watch, read: TerminalRead, source: 'poll' | 'push' = 'poll') {
    if (!w.disappeared) {
      try {
        await this.sample(w, false, read, source);
        w.backendError = undefined;
      } catch {
        w.backendError = 'Observation failed; retrying on the next poll.';
        this.options.monitoring?.record({ kind: 'sample_error', watchId: w.watchId, paneId: w.paneId });
      }
    }
    if (this.active(w)) await this.deliver(w);
    w.lastPoll = this.now();
  }
  private schedule() {
    if (this.disposed || this.options.automatic === false || this.timer || !this.records.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll().finally(() => this.schedule());
    }, 500);
    this.timer.unref();
  }
  // Public for deterministic schedulers/tests. Concurrent callers share one pass.
  poll(): Promise<void> {
    if (this.running) return this.running;
    if (this.disposed) return Promise.resolve();
    this.running = this.pass().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async pass() {
    await TerminalRead.run(this.backend, async (read) => {
      for (const w of this.records.values())
        if (this.active(w) && this.now() - w.lastPoll >= this.interval(w)) await this.visit(w, read);
    });
  }
  private enqueue(w: Watch, kind: string) {
    if (!this.active(w) || (kind !== attention && w.pending.has(kind))) return;
    w.pending.set(kind, {
      event: {
        kind,
        paneId: w.paneId,
        watchId: w.watchId,
        ...(w.agentId ? { agentId: w.agentId } : {}),
        occurredAt: new Date(this.now()).toISOString(),
        summary: summaries[kind],
      },
      sinkDone: !this.options.sink,
      notificationDone: !w.notify,
    });
    w.lastEvent = { ...w.pending.get(kind)!.event };
  }
  private async sample(w: Watch, baseline: boolean, read: TerminalRead, source: 'baseline' | 'poll' | 'push') {
    let hash: string, status: Status;
    if (w.agentBinding) {
      // Managed sampling verifies the original binding and refreshes input state under
      // the worker lock. It never records history or evicts a supervisor's baseline.
      const observation = await this.agents.peekBinding(w.agentBinding, read);
      if (!this.active(w)) return;
      if (!observation) {
        this.disappeared(w, baseline);
        return;
      }
      hash = observation.outputHash;
      status = observation.status;
    } else {
      const panes = await read.panes();
      if (!this.active(w)) return;
      if (!panes.some((p) => p.pane_id === w.paneId)) {
        this.disappeared(w, baseline);
        return;
      }
      const text = normalizeScreen((await this.backend.read(w.paneId, 150)).slice(-24000));
      hash = hashOutput(text);
      status = adapters[w.adapter!].classify(text);
    }
    if (!this.active(w)) return;
    const changed = hash !== w.hash;
    this.options.monitoring?.record({
      kind: 'sample',
      watchId: w.watchId,
      paneId: w.paneId,
      source,
      changed,
      intervalMs: this.interval(w),
      pushBacked: this.pushed(w),
      pushProven: this.options.pushProven?.(w.agentId) === true,
    });
    if (changed) {
      w.changedAt = this.now();
      w.quiet = false;
    }
    const input = (s: Status | undefined) => s !== undefined && inputKind(s) !== null;
    if (input(status) && (!input(w.status) || status !== w.status)) this.enqueue(w, 'input_required');
    if (!baseline && status === 'READY_FOR_PROMPT' && w.status !== 'READY_FOR_PROMPT') this.enqueue(w, 'ready');
    if (!baseline && !changed && !w.quiet && this.now() - w.changedAt >= w.inactivityMs) {
      this.enqueue(w, 'inactive');
      w.quiet = true;
    }
    this.observeAttention(w, status, hash, changed, baseline);
    w.hash = hash;
    w.status = status;
  }
  /**
   * A person is needed when the pane shows a recognised prompt, or sits at a ready prompt with
   * unchanged output for `attentionMs` — the prose-question case no prompt regex can see. Keyed
   * on status and output rather than the interaction request, which no longer exists at a ready
   * prompt; the key clears once the pane works again so the next prompt asks afresh. Both sources
   * require one poll of unchanged output: the prompt classifier wins over the working one, so a
   * question still on screen while the worker streams would otherwise ask again on every redraw.
   */
  private observeAttention(w: Watch, status: Status, hash: string, changed: boolean, baseline: boolean) {
    const prompt = inputKind(status) !== null,
      stalled = !baseline && status === 'READY_FOR_PROMPT' && this.now() - w.changedAt >= w.attentionMs;
    if (!prompt && status !== 'READY_FOR_PROMPT') {
      w.attentionKey = undefined;
      return;
    }
    if (changed || (!prompt && !stalled)) return;
    const key = `${status}\0${hash}`;
    if (key === w.attentionKey) return;
    w.attentionKey = key;
    this.enqueue(w, attention);
  }
  private async deliver(w: Watch) {
    // The error describes this pass: any destination that failed here sets it, a clean pass clears it.
    w.deliveryError = undefined;
    // A failed request for a person stays pending and visible, but never holds the other kinds
    // hostage: a destination that rejects this kind for good would otherwise stall the watch.
    const urgent = w.pending.get(attention);
    if (urgent) {
      await this.deliverOne(w, attention, urgent);
      if (!this.active(w)) return;
    }
    if (w.lastDelivery !== undefined && this.now() - w.lastDelivery < w.cooldownMs) return;
    for (const [kind, p] of w.pending) {
      if (kind === attention) continue;
      if (!this.active(w)) return;
      if (!(await this.deliverOne(w, kind, p))) return;
      w.lastDelivery = this.now();
      if (w.cooldownMs > 0) return;
    }
  }
  /** Delivers one pending kind to both sinks; true only when nothing remains outstanding for it. */
  private async deliverOne(w: Watch, kind: string, p: Pending) {
    let failed = false;
    if (!p.sinkDone) {
      try {
        await this.options.sink!({ ...p.event });
        p.sinkDone = true;
      } catch {
        failed = true;
      }
    }
    if (!this.active(w)) return false;
    if (!p.notificationDone) {
      try {
        await this.options.notifications!.notify({ ...p.event });
        p.notificationDone = true;
      } catch {
        failed = true;
      }
    }
    if (!this.active(w)) return false;
    this.options.monitoring?.record({
      kind: 'delivery',
      watchId: w.watchId,
      paneId: w.paneId,
      eventKind: kind,
      success: !failed,
      delayMs: Math.max(0, this.now() - Date.parse(p.event.occurredAt)),
    });
    if (failed) {
      w.deliveryError = 'Event delivery failed; retrying on the next poll.';
      return false;
    }
    if (w.pending.get(kind) === p) w.pending.delete(kind);
    return true;
  }
}
