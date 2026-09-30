import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { adapters, type Status } from './adapters.js';
import { observeInteraction, type InteractionState } from './interaction.js';
import { attemptReferenceSchema } from './task-results.js';
import { initialWorkerPrompt } from './worker-skill.js';
import { type TerminalBackend, type SpawnOptions, spawnArguments, submit, sendKeys, id } from './backend.js';
import type { WorkerPush } from './push-workers.js';
import {
  MemoryWorkerStorage,
  newWorker,
  workerSchema,
  type WorkerStorage,
  type WorkerRecord,
  type TerminalInstance,
} from './worker-storage.js';
import { CodedError, hasCode } from './errors.js';
import { TerminalRead } from './terminal-read.js';
export const hashOutput = (text: string) => createHash('sha256').update(text).digest('hex');
/** Screen text as the caller should see it: no per-line padding to the pane width, no runs of blank lines. */
export function normalizeScreen(text: string) {
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}
export function tail(text: string, lines: number) {
  const all = text.split('\n');
  return { text: all.slice(-lines).join('\n'), linesOmitted: Math.max(0, all.length - lines) };
}
const linesSchema = z.number().int().min(1).max(150).default(20);
/** A terminal scrolls: the new screen starts with the tail of the old one. Only the lines after that overlap are new. */
export function delta(previous: string, current: string) {
  if (previous === current) return { mode: 'unchanged', text: '' };
  if (current.startsWith(previous)) return { mode: 'append', text: current.slice(previous.length) };
  const before = previous.split('\n'),
    after = current.split('\n');
  for (let overlap = Math.min(before.length, after.length); overlap > 0; overlap--)
    // A single short line such as a bare prompt marker is a coincidence, not evidence the old screen is still above.
    if (
      (overlap > 1 || before[before.length - 1].trim().length > 2) &&
      before.slice(before.length - overlap).join('\n') === after.slice(0, overlap).join('\n')
    )
      return { mode: 'append', text: after.slice(overlap).join('\n') };
  return { mode: 'replace', text: current };
}
type Observation = { id: string; text: string; status: Status };
type Sample = Awaited<ReturnType<Agents['sample']>>;
export interface Agent extends Omit<WorkerRecord, 'paneId'>, InteractionState {
  paneId: number;
  lastOutputAt: number;
  outputHash: string;
  recentText: string;
  status: Status;
  history: Observation[];
}
const sameInstance = (a: TerminalInstance | null, b: TerminalInstance | null) =>
  a !== null && b !== null && a.key === b.key && a.endpoint === b.endpoint;
export const adoptionSchema = z
  .object({
    name: workerSchema.shape.name,
    paneId: id,
    cli: workerSchema.shape.cli,
    workerSkillInitialized: z.boolean().optional(),
  })
  .strict();
export const reattachSchema = z
  .object({
    agentId: z.string().min(1),
    paneId: id,
    acknowledgeUncertainDelivery: z.boolean().optional(),
    workerSkillInitialized: z.boolean().optional(),
  })
  .strict();

export class Agents {
  readonly records = new Map<string, Agent>();
  private readonly sessionId = randomUUID();
  private operations = new Set<Promise<unknown>>();
  private closed = false;
  private readonly waitShutdown = new AbortController();
  /** Back-off between read retries when another operation holds the worker or journal lock. Reads only: writes still fail fast. */
  busyRetryMs = [50, 100, 200, 400, 800];
  constructor(
    readonly backend: TerminalBackend,
    readonly storage: WorkerStorage = new MemoryWorkerStorage(),
    readonly push?: WorkerPush,
  ) {}
  private run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('WORKER_CLOSED'));
    if (this.operations.size >= 128) return Promise.reject(new Error('WORKER_OPERATION_LIMIT'));
    const task = fn();
    this.operations.add(task);
    void task.finally(() => this.operations.delete(task)).catch(() => {});
    return task;
  }
  async close() {
    this.closed = true;
    this.waitShutdown.abort();
    await Promise.allSettled([...this.operations]);
  }
  private async saved() {
    const workers = await this.storage.transaction(false, (s) => ({ result: s.workers }));
    const live = new Set(workers.map((w) => w.agentId));
    for (const key of this.records.keys()) if (!live.has(key)) this.records.delete(key);
    return workers;
  }
  private async lookup(agentId: string) {
    const a = (await this.saved()).find((w) => w.agentId === agentId || w.name === agentId);
    if (!a) throw new Error(`Unknown agent: ${agentId}`);
    return a;
  }
  // Synchronous cache access is retained for existing embedders; operations always refresh storage.
  get(agentId: string) {
    const a = this.records.get(agentId) ?? [...this.records.values()].find((a) => a.name === agentId);
    if (!a) throw new Error(`Unknown agent: ${agentId}`);
    return a;
  }
  private cache(w: WorkerRecord): Agent {
    if (w.paneId === null)
      throw new Error('WORKER_RESERVED: spawn did not finish; inspect terminal panes before adopting or forgetting');
    let a = this.records.get(w.agentId);
    if (!a || a.revision !== w.revision) {
      a = {
        ...w,
        paneId: w.paneId,
        lastOutputAt: Date.now(),
        outputHash: '',
        recentText: '',
        status: 'UNKNOWN',
        history: [],
      };
      // Admission is bounded too: adopt/spawn may run without any metadata reads.
      if (!this.records.has(w.agentId) && this.records.size >= 64)
        this.records.delete(this.records.keys().next().value!);
      this.records.set(w.agentId, a);
    } else Object.assign(a, w);
    return a;
  }
  private async change(agentId: string, fn: (a: WorkerRecord) => void) {
    const w = await this.storage.transaction(true, (s) => {
      const a = s.workers.find((w) => w.agentId === agentId);
      if (!a) throw new Error('Unknown agent');
      fn(a);
      return { state: s, result: a };
    });
    if (w.paneId !== null) this.cache(w);
    return w;
  }
  private async remove(agentId: string) {
    await this.storage.transaction(true, (s) => ({
      state: { ...s, workers: s.workers.filter((w) => w.agentId !== agentId) },
      result: undefined,
    }));
    this.records.delete(agentId);
    await this.push?.release(agentId);
  }
  private async insert(w: WorkerRecord) {
    await this.storage.transaction(true, (s) => {
      if (s.workers.length >= 64) throw new Error('Maximum of 64 managed agents reached');
      if (s.workers.some((a) => a.name === w.name || a.agentId === w.name || a.name === w.agentId))
        throw new Error(`Agent name already exists: ${w.name}`);
      this.available(s.workers, w);
      return { state: { ...s, workers: [...s.workers, w] }, result: undefined };
    });
  }
  private available(workers: WorkerRecord[], w: WorkerRecord) {
    if (
      w.paneId !== null &&
      workers.some(
        (a) =>
          a.agentId !== w.agentId &&
          a.paneId === w.paneId &&
          (sameInstance(a.instance, w.instance) || (!a.instance && !w.instance)),
      )
    )
      throw new Error('WORKER_PANE_OCCUPIED: pane already has a managed worker');
  }
  private identity() {
    return this.backend.instance?.() ?? Promise.resolve(null);
  }
  private attached(w: WorkerRecord, instance: TerminalInstance | null) {
    return sameInstance(w.instance, instance) || (!w.instance && !instance && w.sessionId === this.sessionId);
  }
  // Identity is resolved once per operation: the resolver pins the first GUI it saw and throws
  // if that ever changes, so a second resolution after the pane listing could only agree or
  // throw, while costing a host subprocess under the worker lock on every observation.
  private async checked(w: WorkerRecord, read?: TerminalRead) {
    const instance = await (read ? read.identity() : this.identity());
    if (!this.attached(w, instance))
      throw new Error(
        'WORKER_DETACHED: terminal identity differs or cannot be verified; use agent.reattach explicitly',
      );
    const a = this.cache(w),
      pane = (await (read ? read.panes() : this.backend.list())).find((p) => p.pane_id === a.paneId);
    if (!pane) {
      await this.remove(a.agentId);
      throw new CodedError('WORKER_PANE_DISAPPEARED', `pane ${a.paneId} disappeared; agent ${a.name} removed`);
    }
    return { a, pane };
  }
  private static busy(e: unknown) {
    return hasCode(e, 'WORKER_BUSY', 'WORKER_STORAGE_BUSY');
  }
  private async retrying<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (!Agents.busy(e) || attempt >= this.busyRetryMs.length) throw e;
        await new Promise((r) => setTimeout(r, this.busyRetryMs[attempt]));
      }
    }
  }
  private async locked<T>(agentId: string, fn: (w: WorkerRecord) => Promise<T>) {
    const w = await this.lookup(agentId);
    return this.storage.exclusive(w.agentId, async () => fn(await this.lookup(w.agentId)));
  }
  spawn(o: SpawnOptions & { name: string; cli: WorkerRecord['cli']; prompt?: string; timeoutMs?: number }) {
    return this.run(async () => {
      // Explicit argv, else the configured JSON argv, else the bare CLI name (shells launch with
      // no command). Whichever wins is validated exactly once, with the rest of the options.
      const configured = process.env[`TERM_DAD_${o.cli.toUpperCase()}_COMMAND`];
      const validated = spawnArguments({
        ...o,
        command: o.command ?? (configured ? JSON.parse(configured) : o.cli === 'shell' ? undefined : [o.cli]),
      });
      const command = validated.command;
      const w = newWorker(o.name, o.cli, null, await this.identity(), this.sessionId);
      // Hooks are injected at launch but stay inert: pushes are dropped until the pane is enabled.
      // The binding is set before the record is inserted, so it is durable from the first write.
      const launched = await this.push?.launch(w.agentId, o.cli, command);
      if (launched?.push) w.push = launched.push;
      let paneId: number | undefined,
        launchedPane = false;
      try {
        const options = { ...validated, command: launched ? launched.command : command };
        await this.storage.exclusive(w.agentId, async () => {
          await this.insert(w);
          try {
            paneId = await this.backend.spawn(options);
            launchedPane = true;
          } catch {
            throw new Error(
              `WORKER_SPAWN_UNCERTAIN: launch response was lost or rejected; reservation ${w.agentId} retained. Inspect terminal.list before forgetting the reservation and adopting any surviving pane. Do not repeat spawn blindly.`,
            );
          }
          try {
            await this.change(w.agentId, (a) => {
              a.paneId = paneId!;
            });
          } catch {
            throw new Error(
              `WORKER_STORAGE_FAILED: pane ${paneId} is alive but mapping was not saved; inspect it, forget reservation ${w.agentId}, and agent.adopt it. No prompt sent.`,
            );
          }
          // Only a worker that was actually launched with hooks has a registration to bind; a
          // degraded launch (unwritable credential, registration limit) polls instead.
          // A bind failure never fails a spawn whose mapping is saved: the worker degrades to polling.
          if (launched?.push) {
            try {
              this.push?.bind(w.agentId, paneId);
            } catch (e) {
              console.error(`[term-dad] push bind ${w.agentId}: ${e instanceof Error ? e.message : e}`);
              await this.push?.release(w.agentId);
            }
          }
        });
      } catch (e) {
        // `launch` already minted a token and wrote a credential file. Release them unless a pane
        // actually started: those two paths deliberately retain a reservation for explicit
        // recovery, and its credential belongs to it until it is forgotten. Without this, a
        // retried name collision or the worker cap leaks a live token per attempt and eventually
        // exhausts the registration limit, permanently breaking spawn for the whole process.
        if (!launchedPane) await this.push?.release(w.agentId);
        throw e;
      }
      if (o.prompt !== undefined) {
        try {
          await this.wait(w.agentId, (obs) => obs.status === 'READY_FOR_PROMPT', o.timeoutMs ?? 30000);
        } catch (e) {
          throw new Error(
            `Agent ${w.agentId}, pane ${paneId} retained for diagnosis; prompt NOT sent: ${e instanceof Error ? e.message : e}`,
          );
        }
        // Submission failures report uncertainty, never the incorrect claim that no input was sent.
        await this.send(w.agentId, o.prompt);
      }
      return {
        agentId: w.agentId,
        name: w.name,
        paneId,
        status: this.get(w.agentId).status,
        turnId: this.get(w.agentId).turn?.id ?? null,
      };
    });
  }
  adopt(input: z.input<typeof adoptionSchema>) {
    return this.run(async () => {
      const o = adoptionSchema.parse(input),
        instance = await this.identity();
      if (!(await this.backend.list()).some((p) => p.pane_id === o.paneId)) throw new Error('Pane not found');
      const w = newWorker(o.name, o.cli, o.paneId, instance, this.sessionId);
      w.workerSkillSent = o.workerSkillInitialized ?? false;
      await this.insert(w);
      this.cache(w);
      return this.view(w, 'attached', null);
    });
  }
  reattach(input: z.input<typeof reattachSchema>) {
    return this.run(async () => {
      const o = reattachSchema.parse(input);
      return this.locked(o.agentId, async (old) => {
        if (old.deliveryPending && (!o.acknowledgeUncertainDelivery || o.workerSkillInitialized === undefined))
          throw new Error(
            'WORKER_DELIVERY_UNCERTAIN: inspect the pane, acknowledgeUncertainDelivery and specify workerSkillInitialized',
          );
        const instance = await this.identity();
        if (!(await this.backend.list()).some((p) => p.pane_id === o.paneId)) throw new Error('Pane not found');
        const updated = await this.storage.transaction(true, (s) => {
          const a = s.workers.find((w) => w.agentId === old.agentId)!;
          const moved = a.paneId !== o.paneId || !this.attached(a, instance);
          Object.assign(a, {
            paneId: o.paneId,
            instance,
            sessionId: this.sessionId,
            revision: randomUUID(),
            deliveryPending: false,
          });
          if (o.workerSkillInitialized !== undefined) a.workerSkillSent = o.workerSkillInitialized;
          if (moved) {
            delete a.lastInputAt;
            delete a.inputOutputHash;
          }
          this.available(s.workers, a);
          return { state: s, result: a };
        });
        this.cache(updated);
        // The pane can change here, so the registration must follow it or pushes would be
        // attributed to the wrong pane. A failed re-key must not fail a rebind that succeeded.
        await this.push?.rekey(updated);
        return this.view(updated, 'attached', null);
      });
    });
  }
  /**
   * Re-keys workers that outlived a previous server, so a surviving pane can push again without
   * being killed. Gated on verified attachment: worker metadata is shared by state directory, so
   * an ungated pass would re-key another live server's workers and silently revoke their tokens.
   * Detached records are left for an explicit `agent.reattach`, which re-keys them anyway.
   */
  restorePush() {
    return this.run(async () => {
      if (!this.push) return;
      const workers = await this.saved(),
        instance = await this.identity();
      for (const w of workers) {
        if (!w.push || w.paneId === null || !this.attached(w, instance)) continue;
        try {
          await this.storage.exclusive(w.agentId, () => this.push!.rekey(w));
        } catch (e) {
          console.error(`[term-dad] push rekey ${w.agentId}: ${e instanceof Error ? e.message : e}`);
        }
      }
      // Only reached when the journal read above succeeded, so a credential is never removed
      // because the durable set could not be established.
      await this.push.sweepCredentials(new Set(workers.map((w) => w.agentId)));
    });
  }
  forget(agentId: string) {
    return this.run(() =>
      this.locked(agentId, async (w) => {
        await this.remove(w.agentId);
        return { forgotten: true };
      }),
    );
  }
  private view(w: WorkerRecord, attachment: string, recoveryReason: string | null) {
    return {
      agentId: w.agentId,
      name: w.name,
      paneId: w.paneId,
      cli: w.cli,
      attachment,
      recoveryReason,
      deliveryPending: w.deliveryPending,
      turnId: w.turn?.id ?? null,
      workerSkillInitialized: w.workerSkillSent,
      storageWarning: this.storage.warning ?? null,
    };
  }
  list() {
    return this.run(() =>
      TerminalRead.run(this.backend, async (read) => (await this.listed(read)).map((entry) => entry.view)),
    );
  }
  private sameBinding(current: WorkerRecord, expected: WorkerRecord) {
    if (current.revision !== expected.revision || current.paneId !== expected.paneId)
      throw new Error('Worker was reattached during observation; retry or recreate its watch');
  }
  private async listed(read: TerminalRead) {
    const workers = await this.saved();
    const entry = (worker: WorkerRecord, attachment: string, reason: string | null) => ({
      worker,
      view: this.view(worker, attachment, reason),
    });
    if (!workers.length) return [];
    let instance: TerminalInstance | null;
    try {
      instance = await read.identity();
    } catch {
      return workers.map((w) => entry(w, 'detached', 'Terminal identity unavailable'));
    }
    let panes;
    try {
      panes = await read.panes();
    } catch {
      return workers.map((w) => entry(w, 'detached', 'Terminal transport unavailable'));
    }
    const result = [];
    for (const w of workers) {
      if (w.paneId !== null && this.attached(w, instance) && !panes.some((p) => p.pane_id === w.paneId)) {
        try {
          await this.locked(w.agentId, (current) => {
            this.sameBinding(current, w);
            return this.checked(current, read);
          });
        } catch (e) {
          if (hasCode(e, 'WORKER_PANE_DISAPPEARED')) continue;
          result.push(entry(w, 'detached', 'Recovery could not verify pane; retry'));
          continue;
        }
      }
      result.push(
        entry(
          w,
          w.paneId !== null && this.attached(w, instance) ? 'attached' : 'detached',
          w.paneId === null
            ? 'Spawn reservation needs explicit recovery'
            : this.attached(w, instance)
              ? null
              : 'Terminal identity differs or is unverified',
        ),
      );
    }
    return result;
  }
  private async screen(paneId: number) {
    return normalizeScreen((await this.backend.read(paneId, 150)).slice(-24000));
  }
  private async sample(w: WorkerRecord, record = true, read?: TerminalRead) {
    const { a, pane } = await this.checked(w, read);
    const text = read ? normalizeScreen((await read.screen(a.paneId, 150)).slice(-24000)) : await this.screen(a.paneId),
      hash = hashOutput(text),
      changed = hash !== a.outputHash;
    if (changed) a.lastOutputAt = Date.now();
    a.outputHash = hash;
    a.recentText = text;
    a.status = adapters[a.cli].classify(text);
    const classifiedStatus = a.status;
    if (
      (a.deliveryPending || (a.lastInputAt && (Date.now() - a.lastInputAt < 750 || hash === a.inputOutputHash))) &&
      a.status === 'READY_FOR_PROMPT'
    )
      a.status = 'WORKING';
    // A guarded stale prompt is not observed progress and must not resolve input requests.
    const interaction = observeInteraction(
      a,
      a.status === 'WORKING' && classifiedStatus === 'READY_FOR_PROMPT' ? 'UNKNOWN' : a.status,
      text,
      a.turn?.id ?? null,
    );
    const observationId = randomUUID(),
      history = [...a.history];
    if (record) this.remember(a, observationId, text, a.status);
    const observation = {
      agentId: a.agentId,
      name: a.name,
      paneId: a.paneId,
      observedAt: new Date().toISOString(),
      bindingRevision: a.revision,
      observationId,
      ...interaction,
      turnId: a.turn?.id ?? null,
      attempt: a.turn?.attempt ?? null,
      status: a.status,
      activity: changed ? 'changed' : 'unchanged',
      lastActivitySecondsAgo: (Date.now() - a.lastOutputAt) / 1000,
      lastInputAt: a.lastInputAt,
      lastOutputAt: a.lastOutputAt,
      outputHash: hash,
      cwd: pane.cwd,
      process: pane.foreground_process_name ?? null,
      awaitingInput: [
        'READY_FOR_PROMPT',
        'WAITING_FOR_PERMISSION',
        'WAITING_FOR_QUESTION',
        'WAITING_FOR_AUTHENTICATION',
      ].includes(a.status),
      permissionPrompt: a.status === 'WAITING_FOR_PERMISSION',
      deliveryPending: a.deliveryPending,
      screenshotAvailable: !!process.env.TERM_DAD_SCREENSHOT_COMMAND,
    };
    return { observation, text, history };
  }
  private remember(a: Agent, id: string, text: string, status: Status) {
    a.history.push({ id, text, status });
    if (a.history.length > 16) a.history.shift();
  }
  /** Records a sample taken with `record=false` once it is about to be returned, so its ID works as a later `since`. */
  private keep({ observation, text }: Sample) {
    const a = this.records.get(observation.agentId);
    if (a && !a.history.some((h) => h.id === observation.observationId))
      this.remember(a, observation.observationId, text, observation.status);
  }
  /** Presentation only: the delta against `since` (or against `base` text when the caller pinned it) and the line cap. */
  private present({ observation, text, history }: Sample, since: string | undefined, lines: number, base?: string) {
    const previous = base ?? (since ? history.find((h) => h.id === since)?.text : undefined);
    const output = previous !== undefined ? delta(previous, text) : { mode: 'replace', text };
    const capped = tail(output.text, lines);
    return {
      ...observation,
      previousObservationId: since,
      deltaReset: !!since && previous === undefined,
      recentText: capped.text,
      outputMode: output.mode,
      linesOmitted: capped.linesOmitted,
    };
  }
  observe(agentId: string, since?: string, lines?: number) {
    return this.run(async () => {
      const n = linesSchema.parse(lines);
      return this.retrying(() => this.locked(agentId, async (w) => this.present(await this.sample(w), since, n)));
    });
  }
  /** A full observation that records nothing, for pollers: it can never evict a caller's `since` baseline. */
  peek(agentId: string) {
    return this.run(() =>
      this.retrying(() => this.locked(agentId, async (w) => (await this.sample(w, false)).observation)),
    );
  }
  /** A watch follows its original binding; absence requires verification against that identity. */
  peekBinding(binding: WorkerRecord, read: TerminalRead) {
    return this.run(() =>
      this.retrying(async () => {
        if (!(await this.resolveOptional(binding.agentId))) {
          if (!this.attached(binding, await read.identity())) throw new Error('WORKER_DETACHED');
          if (!(await read.panes()).some((p) => p.pane_id === binding.paneId)) return undefined;
          throw new Error('Worker is no longer managed; recreate its watch');
        }
        try {
          return await this.locked(binding.agentId, async (current) => {
            this.sameBinding(current, binding);
            return (await this.sample(current, false, read)).observation;
          });
        } catch (e) {
          if (hasCode(e, 'WORKER_PANE_DISAPPEARED')) return undefined;
          throw e;
        }
      }),
    );
  }
  send(agentId: string, text: string, attempt?: z.infer<typeof attemptReferenceSchema>) {
    return this.run(() =>
      this.locked(agentId, async (w) => {
        z.string().max(100000).parse(text);
        if (attempt) attemptReferenceSchema.parse(attempt);
        const { a } = await this.checked(w);
        if (a.deliveryPending)
          throw new Error('WORKER_DELIVERY_UNCERTAIN: inspect and agent.reattach before further input');
        const initialize = a.cli === 'codex' && !a.workerSkillSent,
          prompt = initialize ? initialWorkerPrompt(text) : text;
        z.string().max(100000).parse(prompt);
        const hash = hashOutput(await this.screen(a.paneId));
        await this.change(a.agentId, (w) => {
          w.inputOutputHash = hash;
          w.lastInputAt = Date.now();
          w.deliveryPending = true;
          w.turn = { id: randomUUID(), bindingRevision: w.revision, ...(attempt ? { attempt } : {}) };
        });
        try {
          await submit(this.backend, a.paneId, prompt);
          await this.change(a.agentId, (w) => {
            w.deliveryPending = false;
            if (initialize) w.workerSkillSent = true;
          });
        } catch {
          throw new Error(
            'WORKER_DELIVERY_UNCERTAIN: input may have reached the pane; inspect and agent.reattach before retrying',
          );
        }
        a.status = 'WORKING';
        return { agentId: a.agentId, sent: true, turnId: a.turn!.id };
      }),
    );
  }
  interrupt(agentId: string) {
    return this.run(() =>
      this.locked(agentId, async (w) => {
        const { a } = await this.checked(w);
        if (a.deliveryPending) throw new Error('WORKER_DELIVERY_UNCERTAIN: inspect and reattach first');
        const hash = hashOutput(await this.screen(a.paneId));
        await this.change(a.agentId, (w) => {
          w.inputOutputHash = hash;
          w.lastInputAt = Date.now();
          w.deliveryPending = true;
        });
        try {
          await sendKeys(this.backend, a.paneId, ['CTRL_C']);
          await this.change(a.agentId, (w) => {
            w.deliveryPending = false;
          });
        } catch {
          throw new Error('WORKER_DELIVERY_UNCERTAIN: interrupt may have reached pane; inspect and reattach');
        }
        return { interrupted: true };
      }),
    );
  }
  stop(agentId: string) {
    return this.run(() =>
      this.locked(agentId, async (w) => {
        const { a } = await this.checked(w);
        await this.backend.close(a.paneId);
        await this.remove(a.agentId);
        return { stopped: true };
      }),
    );
  }
  withPane<T>(agentId: string, fn: (paneId: number, instance: TerminalInstance | null) => Promise<T>) {
    return this.run(() =>
      this.locked(agentId, async (w) => {
        const { a } = await this.checked(w);
        return fn(a.paneId, a.instance);
      }),
    );
  }
  async findByPane(paneId: number) {
    const instance = await this.identity();
    return (await this.saved()).find((w) => w.paneId === paneId && this.attached(w, instance));
  }
  async resolve(agentId: string) {
    return this.lookup(agentId);
  }
  async resolveOptional(agentId: string) {
    return (await this.saved()).find((w) => w.agentId === agentId || w.name === agentId);
  }
  async isAttached(w: WorkerRecord) {
    return this.attached(w, await this.identity());
  }
  /** Re-keys one attached worker under its lock, for a `push.set` that finds startup restore skipped it. */
  rekey(agentId: string) {
    return this.run(() =>
      this.locked(agentId, async (w) => {
        if (!this.attached(w, await this.identity()))
          throw new Error('WORKER_DETACHED: terminal identity differs; agent.reattach the worker first');
        await this.push?.rekey(w);
      }),
    );
  }
  async bindingPaneExists(w: WorkerRecord) {
    if (!this.attached(w, await this.identity())) throw new Error('WORKER_DETACHED');
    return (await this.backend.list()).some((p) => p.pane_id === w.paneId);
  }
  async requireAttachment(agentId: string) {
    const w = await this.lookup(agentId);
    if (!this.attached(w, await this.identity())) throw new Error('WORKER_DETACHED');
    return w;
  }
  async reconcileClosed(paneId: number) {
    const w = await this.findByPane(paneId);
    if (w)
      await this.run(() =>
        this.locked(w.agentId, async (current) => {
          await this.checked(current);
        }),
      ).catch((e) => {
        if (!hasCode(e, 'WORKER_PANE_DISAPPEARED')) throw e;
      });
  }
  private checkWait(signal?: AbortSignal) {
    if (this.closed) throw new Error('WORKER_CLOSED');
    if (signal?.aborted) throw new Error('WORKER_WAIT_CANCELLED');
  }
  private async pauseWait(deadline: number, signal?: AbortSignal) {
    this.checkWait(signal);
    const combined = signal ? AbortSignal.any([signal, this.waitShutdown.signal]) : this.waitShutdown.signal;
    try {
      await delay(Math.min(250, Math.max(0, deadline - Date.now())), undefined, { signal: combined });
    } catch (e) {
      this.checkWait(signal);
      throw e;
    }
    this.checkWait(signal);
  }
  /** Retry only contention, under the caller's original deadline. No input is replayed. */
  private async waitRead<T>(read: () => Promise<T>, deadline: number, signal?: AbortSignal): Promise<T | undefined> {
    do {
      this.checkWait(signal);
      try {
        const value = await read();
        this.checkWait(signal);
        return value;
      } catch (e) {
        this.checkWait(signal);
        if (!Agents.busy(e)) throw e;
        if (Date.now() >= deadline) break;
        await this.pauseWait(deadline, signal);
      }
    } while (Date.now() < deadline);
    return undefined;
  }
  wait(
    agentId: string,
    predicate: (o: Awaited<ReturnType<Agents['observe']>>) => boolean,
    timeoutMs = 30000,
    signal?: AbortSignal,
  ) {
    return this.run(async () => {
      z.number().int().min(1).max(120000).parse(timeoutMs);
      const deadline = Date.now() + timeoutMs;
      let last;
      let contended = false;
      do {
        const sample = await this.waitRead(() => this.locked(agentId, (w) => this.sample(w, false)), deadline, signal);
        if (!sample) {
          contended = true;
          break;
        }
        last = this.present(sample, undefined, 150);
        if (predicate(last)) {
          this.keep(sample);
          return this.present(sample, undefined, linesSchema.parse(undefined));
        }
        if (Date.now() >= deadline) break;
        await this.pauseWait(deadline, signal);
      } while (Date.now() < deadline);
      throw new Error(
        `Timed out waiting for ${agentId}; last status ${last?.status ?? 'unavailable'}${contended ? '; lock contention prevented observation' : ''}`,
      );
    });
  }
  waitForOutcome(
    agentId: string,
    turnId: string,
    timeoutMs = 30000,
    quietMs?: number,
    signal?: AbortSignal,
    view: { since?: string; lines?: number } = {},
  ) {
    return this.run(async () => {
      z.uuid().parse(turnId);
      const lines = linesSchema.parse(view.lines);
      z.number().int().min(1).max(120000).parse(timeoutMs);
      if (quietMs !== undefined) z.number().int().min(1000).max(3600000).parse(quietMs);
      const deadline = Date.now() + timeoutMs;
      const binding = await this.waitRead(() => this.lookup(agentId), deadline, signal);
      if (!binding) return { reason: 'timeout', lastObservation: null };
      const assertTurn = (w: WorkerRecord) => {
        if (w.revision !== binding.revision || w.turn?.bindingRevision !== w.revision)
          throw new Error('WORKER_BINDING_CHANGED');
        if (w.turn?.id !== turnId) throw new Error('WORKER_TURN_SUPERSEDED');
        if (w.deliveryPending) throw new Error('WORKER_DELIVERY_UNCERTAIN');
      };
      assertTurn(binding);
      // Pin the caller's baseline now: other observers can evict it from the history while this wait runs.
      const base = view.since
        ? this.records.get(binding.agentId)?.history.find((h) => h.id === view.since)?.text
        : undefined;
      let last: Sample | undefined;
      const shown = () => {
        if (!last) return null;
        this.keep(last);
        return this.present(last, view.since, lines, base);
      };
      const pause = () => this.pauseWait(deadline, signal);
      // A held worker or journal lock is contention, not an outcome: poll again until the deadline.
      const contended = (e: unknown) => Agents.busy(e);
      do {
        this.checkWait(signal);
        let current: WorkerRecord | undefined;
        try {
          current = await this.resolveOptional(binding.agentId);
        } catch (e) {
          this.checkWait(signal);
          if (contended(e)) {
            if (Date.now() >= deadline) break;
            await pause();
            continue;
          }
          throw e;
        }
        if (!current) {
          if (!(await this.bindingPaneExists(binding)))
            return { reason: 'worker_disappeared', lastObservation: shown() };
          throw new Error('WORKER_NO_LONGER_MANAGED');
        }
        assertTurn(current);
        try {
          last = await this.locked(binding.agentId, (w) => this.sample(w, false));
        } catch (e) {
          this.checkWait(signal);
          if (contended(e)) {
            if (Date.now() >= deadline) break;
            await pause();
            continue;
          }
          if (hasCode(e, 'WORKER_PANE_DISAPPEARED') && !(await this.bindingPaneExists(binding)))
            return { reason: 'worker_disappeared', lastObservation: shown() };
          throw e;
        }
        // Input and reattachment can interleave between observations; do not answer for a newer turn.
        let after: WorkerRecord | undefined;
        try {
          after = await this.resolveOptional(binding.agentId);
        } catch (e) {
          this.checkWait(signal);
          if (contended(e)) {
            if (Date.now() >= deadline) break;
            await pause();
            continue;
          }
          throw e;
        }
        if (after) assertTurn(after);
        else continue;
        this.checkWait(signal);
        const o = last.observation;
        if (o.turnId !== turnId) throw new Error('WORKER_TURN_SUPERSEDED');
        if (o.inputRequired) return { reason: 'input_required', lastObservation: shown() };
        if (o.readyForPrompt) return { reason: 'turn_finished', provenance: 'heuristic', lastObservation: shown() };
        if (quietMs !== undefined && Date.now() - Math.max(o.lastOutputAt, o.lastInputAt ?? 0) >= quietMs)
          return { reason: 'output_quiet', lastObservation: shown() };
        if (Date.now() >= deadline) break;
        await pause();
      } while (Date.now() <= deadline);
      return { reason: 'timeout', lastObservation: shown() };
    });
  }
  /** Board view: every observation field except text; summary samples never evict delta baselines. */
  summaries() {
    return this.run(() => TerminalRead.run(this.backend, (read) => this.collect(read, false)));
  }
  snapshot() {
    return this.run(() => TerminalRead.run(this.backend, (read) => this.collect(read, true)));
  }
  /** One deep managed read feeds both the pane tail and its guarded observation. */
  workspaceSnapshot() {
    return this.run(() =>
      TerminalRead.run(
        this.backend,
        async (read) => {
          const panes = await read.panes();
          const agents = await this.collect(read, true);
          return {
            panes: await Promise.all(
              panes.map(async (pane) => ({ ...pane, recentText: await read.screen(pane.pane_id, 30) })),
            ),
            agents,
          };
        },
        'snapshot',
      ),
    );
  }
  private async collect(read: TerminalRead, record: boolean) {
    return Promise.all(
      (await this.listed(read)).map(async ({ worker, view }) => {
        if (view.attachment === 'detached') return view;
        try {
          return await this.retrying(() =>
            this.locked(worker.agentId, async (current) => {
              this.sameBinding(current, worker);
              const sample = await this.sample(current, record, read);
              return record ? this.present(sample, undefined, 20) : sample.observation;
            }),
          );
        } catch (e) {
          return { ...view, error: String(e) };
        }
      }),
    );
  }
}
