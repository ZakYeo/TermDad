import { CodedError } from './errors.js';
import { PushIngress } from './ingress.js';
import { pushHookArgv, forwardsHookArguments, type PushHookOptions } from './worker-hooks.js';
import { PushCredentialStore, credentialPath } from './push-credentials.js';

export type WorkerCli = 'claude' | 'codex' | 'shell';
export type HookSurface = 'claude_hooks' | 'codex_notify';
export interface WorkerPushBinding {
  credentialPath: string;
  surface: HookSurface;
}
/** The push surface `Agents` needs, so worker code never depends on the transport. */
export interface WorkerPush {
  launch(
    agentId: string,
    cli: WorkerCli,
    command: string[] | undefined,
  ): Promise<{ command: string[] | undefined; push?: WorkerPushBinding }>;
  setEnabled(agentId: string, enabled: boolean): Promise<unknown>;
  status(agentId: string): Promise<unknown>;
  bind(agentId: string, paneId: number): void;
  release(agentId: string): Promise<void>;
  rekey(worker: { agentId: string; paneId: number | null; push?: WorkerPushBinding }): Promise<void>;
  sweepCredentials(live: Set<string>): Promise<number>;
  deliverable(agentId?: string): boolean;
}

/**
 * What the registry needs to know about a managed worker it may hold no registration for. `rekey`
 * re-keys the worker under its own lock and is present only when this server is attached to it.
 */
export interface ResolvedWorker {
  agentId: string;
  cli: WorkerCli;
  push?: WorkerPushBinding;
  rekey?: () => Promise<void>;
}
export type WorkerResolver = (agentIdOrName: string) => Promise<ResolvedWorker | undefined>;
/** Mints one token per worker and prepares hook wiring before pane creation. */
export class WorkerPushRegistry implements WorkerPush {
  private clis = new Map<string, WorkerCli>();
  private socketState: { listening: boolean; bindError?: string } = { listening: false };
  private resolve?: WorkerResolver;
  private credentialErrors = new Map<string, string>();
  private store: PushCredentialStore;
  private stateDir: string;
  constructor(
    private ingress: PushIngress,
    private socketPath: string,
    private notify: string[],
    stateDir: string,
  ) {
    this.store = new PushCredentialStore(stateDir);
    this.stateDir = stateDir;
  }
  /** Lets push report on a managed worker it holds no registration for, instead of failing, and accept its name. */
  attachWorkers(resolve: WorkerResolver) {
    this.resolve = resolve;
  }
  /** The worker as the supervisor named it (UUID or unique name), or undefined when it is not managed. */
  private async worker(agentIdOrName: string) {
    return this.resolve?.(agentIdOrName);
  }
  /** The real bind outcome, so nothing reports an intended socket path as a bound one. */
  attach(outcome: { listening: boolean; bindError?: string }) {
    this.socketState = outcome;
  }
  socket() {
    return { path: this.socketPath, listening: this.socketState.listening, bindError: this.socketState.bindError };
  }
  /** Validate the required channel before any terminal pane is created. */
  async launch(agentId: string, cli: WorkerCli, command: string[] | undefined) {
    if (cli === 'shell') return { command };
    if (!command || !forwardsHookArguments(command))
      throw new CodedError(
        'WORKER_HOOK_CONFIGURATION',
        'command does not forward hook arguments; omit the custom command or explicitly request supervision:polling',
      );
    if (!this.socketState.listening)
      throw new CodedError(
        'PUSH_SOCKET_UNAVAILABLE',
        `server hook socket is unavailable (${this.socketState.bindError ?? 'not listening'}); repair server startup or explicitly request supervision:polling`,
      );
    this.clis.set(agentId, cli);
    const surface = this.surface(agentId)!;
    const path = credentialPath(this.stateDir, agentId);
    // Registration and credential failures reject before pane creation and release partial state.
    try {
      const { token } = this.ingress.register(agentId, -1);
      await this.store.write({ version: 1, agentId, socketPath: this.socketPath, token });
    } catch (e) {
      await this.release(agentId);
      throw new CodedError(
        'WORKER_HOOK_CREDENTIAL',
        `cannot prepare private hook credential: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    this.credentialErrors.delete(agentId);
    const options: PushHookOptions = { credentialPath: path, notify: this.notify };
    return { command: pushHookArgv(cli, command, options), push: { credentialPath: path, surface } };
  }
  /**
   * Replaces a surviving worker's credentials in place. Its argv carries only the file path, so
   * a new token and socket reach it with no relaunch and no lost context. The old token is
   * revoked by `register`, and delivery deliberately returns disabled: push is off for every
   * pane until it is enabled, and a restart cannot verify the worker's hook config survived.
   */
  async rekey(worker: { agentId: string; paneId: number | null; push?: WorkerPushBinding }) {
    if (!worker.push || worker.paneId === null) return;
    this.clis.set(worker.agentId, worker.push.surface === 'claude_hooks' ? 'claude' : 'codex');
    const { token } = this.ingress.register(worker.agentId, worker.paneId);
    try {
      await this.store.write({ version: 1, agentId: worker.agentId, socketPath: this.socketPath, token });
      this.credentialErrors.delete(worker.agentId);
    } catch (e) {
      // Never leave a registration whose worker cannot authenticate; report it instead.
      this.ingress.revoke(worker.agentId);
      this.credentialErrors.set(worker.agentId, e instanceof Error ? e.message : String(e));
    }
  }
  sweepCredentials(live: Set<string>) {
    return this.store.sweep(live);
  }
  // The token is minted before the pane exists; the pane it reports for is fixed here.
  bind(agentId: string, paneId: number) {
    if (!this.ingress.revoked(agentId)) this.ingress.rebind(agentId, paneId);
  }
  async release(agentId: string) {
    this.clis.delete(agentId);
    this.credentialErrors.delete(agentId);
    this.ingress.revoke(agentId);
    await this.store.remove(agentId);
  }
  private surface(agentId: string): HookSurface | null {
    const known = this.clis.get(agentId);
    return known === 'claude' ? 'claude_hooks' : known === 'codex' ? 'codex_notify' : null;
  }
  private credential(agentId: string, durable?: WorkerPushBinding) {
    const error = this.credentialErrors.get(agentId);
    // `recorded` says a binding exists in the journal or this process; it never claims the file is intact.
    return error
      ? { credential: 'unwritable' as const, credentialError: error }
      : {
          credential: (durable || this.ingress.revoked(agentId) === false ? 'recorded' : 'absent') as
            'recorded' | 'absent',
        };
  }
  /**
   * Turning delivery off always succeeds and is idempotent: the safe direction must never be
   * blocked by the reasons a channel is broken. Turning it on fails explicitly instead of
   * returning a success value that describes wiring intent rather than deliverability, and a
   * surviving worker whose startup re-key was skipped is re-keyed here rather than told to respawn.
   */
  async setEnabled(agentIdOrName: string, enabled: boolean) {
    const worker = await this.worker(agentIdOrName),
      agentId = worker?.agentId ?? agentIdOrName;
    if (!enabled) {
      const revoked = this.ingress.revoked(agentId);
      return revoked
        ? { agentId, enabled: false, registered: false }
        : { ...this.ingress.setEnabled(agentId, false), registered: true };
    }
    if (!worker && !this.clis.has(agentId))
      throw new Error(
        `PUSH_UNKNOWN_WORKER: ${agentIdOrName} is not a managed worker; agent.list names the workers this server knows`,
      );
    if ((worker?.cli ?? this.clis.get(agentId)) === 'shell')
      throw new Error('PUSH_UNSUPPORTED_WORKER: shell workers have no hook surface; use a watch instead');
    if (!this.socketState.listening)
      throw new Error(
        `PUSH_SOCKET_UNAVAILABLE: this server did not bind its push socket (${this.socketState.bindError ?? 'reason unavailable'}); keep polling`,
      );
    if (this.ingress.revoked(agentId) && worker?.push) {
      if (!worker.rekey)
        throw new Error(
          `PUSH_NOT_WIRED: worker ${agentId} was launched with hooks but this server is not attached to its pane; agent.reattach it, then enable push again`,
        );
      await worker.rekey();
    }
    if (!this.surface(agentId))
      throw new Error(
        `PUSH_NOT_WIRED: worker ${agentId} has no hook surface in this server, so a hook can never reach it; an adopted pane must be respawned with agent.spawn to push, or watch its pane instead`,
      );
    const failed = this.credentialErrors.get(agentId);
    if (failed)
      throw new Error(
        `PUSH_CREDENTIAL_UNWRITABLE: worker ${agentId} has no private credential a hook could read (${failed})`,
      );
    this.ingress.setEnabled(agentId, true);
    return { ...(await this.status(agentId)), note: 'enabled; no hook has fired yet, so delivery is not proven' };
  }
  async status(agentIdOrName: string) {
    const worker = await this.worker(agentIdOrName),
      agentId = worker?.agentId ?? agentIdOrName;
    // A hook surface means this pane was actually launched with injected argv: the durable
    // binding, or a launch in this process. Never merely the CLI, or an adopted claude pane
    // would report as wired when nothing can ever reach it.
    const surface = worker?.push?.surface ?? this.surface(agentId);
    if (this.ingress.revoked(agentId)) {
      if (worker === undefined && !this.clis.has(agentId))
        throw new Error(
          `PUSH_UNKNOWN_WORKER: ${agentIdOrName} is not a managed worker; agent.list names the workers this server knows`,
        );
      // Say why nothing is registered: only a pane launched with hooks can ever be re-enabled.
      const cli = worker?.cli ?? this.clis.get(agentId);
      const reason =
        cli === 'shell'
          ? 'shell workers have no hook surface; watch the pane instead'
          : surface === null
            ? 'this pane was launched without hooks (adopted), so nothing can push for it; respawn with agent.spawn to push, or watch the pane'
            : 'no push registration in this server; a surviving worker needs push enabled again explicitly after a restart';
      return {
        agentId,
        paneId: null,
        registered: false,
        enabled: false,
        hookSurface: surface,
        ...this.credential(agentId, worker?.push),
        deliveries: { count: 0, lastAt: null, lastKind: null },
        proven: false,
        socket: this.socket(),
        deliverable: false,
        reason,
      };
    }
    const view = this.ingress.status(agentId);
    // A re-keyed worker is registered and off. Say so, so "this can push and currently isn't"
    // is visible in the first call a supervisor makes rather than having to be inferred.
    return {
      ...view,
      registered: true,
      hookSurface: surface,
      ...this.credential(agentId, worker?.push),
      socket: this.socket(),
      deliverable: this.deliverable(agentId),
      reason: !this.socketState.listening
        ? 'server hook socket is unavailable'
        : !view.enabled
          ? 'push is registered for this pane but off; enable it explicitly'
          : view.proven
            ? 'hook delivery observed'
            : 'enabled; hook delivery not yet proven',
    };
  }
  list() {
    return this.ingress.list().map((view) => ({
      ...view,
      registered: true,
      hookSurface: this.surface(view.agentId),
      deliverable: this.deliverable(view.agentId),
      reason: !this.socketState.listening
        ? 'server hook socket is unavailable'
        : !view.enabled
          ? 'push is registered but off'
          : view.proven
            ? 'hook delivery observed'
            : 'enabled; hook delivery not yet proven',
    }));
  }
  enabled(agentId?: string) {
    if (!agentId) return false;
    try {
      return this.ingress.status(agentId).enabled;
    } catch {
      return false;
    }
  }
  /**
   * Enabled describes worker-side intent; deliverable additionally requires a socket this
   * process actually bound. Watches back off only for a channel that can really deliver.
   */
  deliverable(agentId?: string) {
    return this.socketState.listening && this.enabled(agentId);
  }
}
