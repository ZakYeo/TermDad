import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/** Kinds a worker CLI hook may report. Summaries are authored here, never by the worker. */
export const pushKinds = ['input_required', 'ready', 'session_ended'] as const;
export type PushKind = (typeof pushKinds)[number];
const summaries: Record<PushKind, string> = {
  input_required: 'Worker reported that it needs input.',
  ready: 'Worker reported that its turn finished; task success is not established.',
  session_ended: 'Worker reported that its session ended; the pane may still be open.',
};
export interface PushEvent {
  kind: PushKind;
  paneId: number;
  agentId: string;
  occurredAt: string;
  summary: string;
}
export type PushSink = (event: PushEvent) => Promise<unknown>;
export interface PushIngressOptions {
  sink: PushSink;
  now?: () => number;
}
export interface PushResult {
  ok?: true;
  delivered?: boolean;
  error?: string;
}
// Only the token and the kind are trusted from a hook; any other field is ignored.
const messageSchema = z.object({ token: z.string().min(1).max(200), kind: z.enum(pushKinds) }).passthrough();
type Registration = {
  agentId: string;
  paneId: number;
  token: string;
  enabled: boolean;
  deliveries: number;
  lastDeliveryAt: number | null;
  lastKind: PushKind | null;
};

/** Authenticates local worker hooks and turns them into bounded metadata events. */
export class PushIngress {
  private byAgent = new Map<string, Registration>();
  private byToken = new Map<string, Registration>();
  private now: () => number;
  constructor(private options: PushIngressOptions) {
    this.now = options.now ?? Date.now;
  }
  /** Mints a disabled token: push stays off for a pane until it is enabled explicitly. */
  register(agentId: string, paneId: number) {
    this.revoke(agentId);
    if (this.byAgent.size >= 64) throw new Error('PUSH_REGISTRATION_LIMIT: too many push registrations');
    const registration: Registration = {
      agentId,
      paneId,
      token: randomBytes(32).toString('base64url'),
      enabled: false,
      deliveries: 0,
      lastDeliveryAt: null,
      lastKind: null,
    };
    this.byAgent.set(agentId, registration);
    this.byToken.set(registration.token, registration);
    return { token: registration.token, agentId, paneId, enabled: false };
  }
  /** Binds a token minted before its pane existed to the pane it must report for. */
  rebind(agentId: string, paneId: number) {
    const found = this.require(agentId);
    found.paneId = paneId;
    return this.view(found);
  }
  revoke(agentId: string) {
    const found = this.byAgent.get(agentId);
    if (!found) return { revoked: false };
    this.byAgent.delete(agentId);
    this.byToken.delete(found.token);
    return { revoked: true };
  }
  setEnabled(agentId: string, enabled: boolean) {
    const found = this.require(agentId);
    found.enabled = enabled;
    return this.view(found);
  }
  status(agentId: string) {
    return this.view(this.require(agentId));
  }
  list() {
    return [...this.byAgent.values()].map((r) => this.view(r));
  }
  /** Whether this process holds no registration, so callers can report rather than throw. */
  revoked(agentId: string) {
    return !this.byAgent.has(agentId);
  }
  private require(agentId: string) {
    const found = this.byAgent.get(agentId);
    if (!found) throw new Error(`PUSH_UNKNOWN_WORKER: no push registration for ${agentId}`);
    return found;
  }
  /**
   * `enabled` is worker-side intent. `proven` is the only field that means a hook has actually
   * fired: nothing the server can inspect establishes that the worker's CLI accepted its
   * injected configuration, so an observed delivery is the sole evidence.
   */
  private view(r: Registration) {
    return {
      agentId: r.agentId,
      paneId: r.paneId,
      enabled: r.enabled,
      deliveries: {
        count: r.deliveries,
        lastAt: r.lastDeliveryAt === null ? null : new Date(r.lastDeliveryAt).toISOString(),
        lastKind: r.lastKind,
      },
      proven: r.deliveries > 0,
    };
  }
  /** Handles one newline-delimited request line. Never throws; the hook sees a bounded reply. */
  async handle(line: string): Promise<PushResult> {
    if (line.length > 4096) return { error: 'PUSH_INPUT_INVALID: request exceeds 4096 bytes' };
    let message;
    try {
      message = messageSchema.parse(JSON.parse(line));
    } catch {
      return { error: 'PUSH_INPUT_INVALID: expected {"token":string,"kind":one of ' + pushKinds.join('|') + '}' };
    }
    const registration = this.byToken.get(message.token);
    if (!registration) return { error: 'PUSH_UNAUTHORIZED: unknown or revoked push token' };
    if (!registration.enabled) return { ok: true, delivered: false };
    const event: PushEvent = {
      kind: message.kind,
      paneId: registration.paneId,
      agentId: registration.agentId,
      occurredAt: new Date(this.now()).toISOString(),
      summary: summaries[message.kind],
    };
    try {
      await this.options.sink(event);
    } catch {
      return { error: 'PUSH_DELIVERY_FAILED: the event was not recorded; retry or fall back to polling' };
    }
    // Counted only once the sink has accepted it, so `proven` never overstates.
    registration.deliveries++;
    registration.lastDeliveryAt = this.now();
    registration.lastKind = message.kind;
    return { ok: true, delivered: true };
  }
}

import { connect, createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { dirname } from 'node:path';

/** One socket per server process, so servers under different MCP clients never contend. */
export const pushSocketPath = (directory: string, pid = process.pid) => join(directory, `push.${pid}.sock`);
const sweepable = /^push\.\d+\.sock$/;

/** Loopback-free local transport: one newline-delimited JSON request per connection. */
export class PushSocket {
  private server?: Server;
  private connections = new Set<Socket>();
  constructor(
    private ingress: PushIngress,
    readonly path: string,
  ) {}
  async listen() {
    if (this.server) throw new Error('PUSH_SOCKET_ACTIVE: already listening');
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    // A socket file left by a crashed server is replaced; a live one still fails to bind.
    const existing = await stat(this.path).catch(() => undefined);
    if (existing?.isSocket()) await unlink(this.path).catch(() => {});
    else if (existing) throw new Error('PUSH_SOCKET_PATH_OCCUPIED: refusing to replace a non-socket file');
    await this.sweep();
    // Half-open: a hook half-closes as soon as it has written, and the reply must still
    // be delivered after a slow sink (a journal write) rather than racing an auto-close.
    const server = createServer({ allowHalfOpen: true }, (socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.path, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    server.on('error', () => {});
    // The ingress must never keep a server alive on its own; the transport owns that lifetime.
    server.unref();
    await chmod(this.path, 0o600);
    return this.path;
  }
  /** Removes sockets left by crashed peers; a socket that still answers is never touched. */
  private async sweep() {
    const directory = dirname(this.path);
    for (const name of await readdir(directory).catch(() => [])) {
      const candidate = join(directory, name);
      if (!sweepable.test(name) || name === basename(this.path)) continue;
      const alive = await new Promise<boolean>((resolve) => {
        const probe = connect(candidate);
        const settle = (value: boolean) => {
          probe.destroy();
          resolve(value);
        };
        probe.setTimeout(200, () => settle(true));
        probe.on('connect', () => settle(true));
        probe.on('error', () => settle(false));
      });
      if (!alive) await unlink(candidate).catch(() => {});
    }
  }
  private accept(socket: Socket) {
    if (this.connections.size >= 64) {
      socket.destroy();
      return;
    }
    this.connections.add(socket);
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy());
    let buffer = '',
      answered = false;
    const reply = async (line: string) => {
      if (answered) return;
      answered = true;
      socket.end(JSON.stringify(await this.ingress.handle(line)) + '\n');
    };
    socket.on('data', (chunk) => {
      if (answered) return;
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline >= 0) void reply(buffer.slice(0, newline));
      else if (buffer.length > 4096) void reply(buffer);
    });
    socket.on('end', () => {
      if (!answered) void reply(buffer);
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => this.connections.delete(socket));
  }
  async close() {
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(this.path).catch(() => {});
  }
}
