import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { EventQueue } from './events.js';
import { FileUsageStorage, type UsageStorage } from './usage-storage.js';
import { defaultUsageProviders, type UsageProvider } from './usage-providers.js';
import {
  configureUsageSchema,
  eligibility,
  freshness,
  observationSchema,
  usageWatchSchema,
  type UsageAccount,
  type UsageCapabilities,
  type UsageConfig,
  type UsageObservation,
} from './usage-model.js';
import { evaluateUsage, evaluateWarnings, usageEvent } from './usage-policy.js';
import { scheduleResetAlerts, deliverResetAlerts } from './usage-reset.js';
import type { NotificationProvider } from './notifications.js';

export class UsageService {
  private operations = new Set<Promise<unknown>>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private closed = false;
  private monitorError: string | null = null;
  constructor(
    readonly storage: UsageStorage = new FileUsageStorage(),
    readonly events?: EventQueue,
    readonly providers: Record<UsageConfig['provider'], UsageProvider> = defaultUsageProviders(),
    readonly now: () => number = Date.now,
    readonly notifications?: NotificationProvider,
  ) {}
  private run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('USAGE_CLOSED'));
    if (this.operations.size >= 128) return Promise.reject(new Error('USAGE_OPERATION_LIMIT'));
    const p = fn();
    this.operations.add(p);
    void p.finally(() => this.operations.delete(p)).catch(() => {});
    return p;
  }
  async accounts() {
    return this.storage.transaction(false, (s) => ({ result: s.accounts }));
  }
  async account(ref: string) {
    const a = (await this.accounts()).find((a) => a.config.accountRef === ref);
    if (!a) throw new Error('USAGE_ACCOUNT_UNKNOWN');
    return a;
  }
  mutate<T>(ref: string, fn: (a: UsageAccount) => T) {
    return this.storage.transaction(true, (s) => {
      const a = s.accounts.find((a) => a.config.accountRef === ref);
      if (!a) throw new Error('USAGE_ACCOUNT_UNKNOWN');
      const result = fn(a);
      return { state: s, result };
    });
  }
  capabilities(config: UsageConfig): UsageCapabilities {
    return this.providers[config.provider].capabilities;
  }
  automatic(config: UsageConfig) {
    const c = this.capabilities(config);
    return c.refresh && c.identity && c.pause && c.wake && c.verified;
  }
  configure(input: unknown) {
    return this.run(async () => {
      const config = configureUsageSchema.parse(input);
      if (config.codexHome && !isAbsolute(config.codexHome)) throw new Error('USAGE_HOME_MUST_BE_ABSOLUTE');
      if (config.provider === 'codex')
        config.codexHome = resolve(config.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'));
      if (config.mode === 'automatic' && !this.automatic(config))
        throw new Error(`USAGE_AUTOMATIC_UNAVAILABLE: ${this.capabilities(config).reason}`);
      await this.storage.transaction(true, (s) => {
        const existing = s.accounts.find((a) => a.config.accountRef === config.accountRef);
        for (const a of s.accounts) {
          if (a === existing) continue;
          if (a.config.workerIds.some((id) => config.workerIds.includes(id)))
            throw new Error('USAGE_WORKER_ALREADY_BOUND');
          if (
            config.provider === 'codex' &&
            a.config.provider === 'codex' &&
            a.config.codexHome === config.codexHome &&
            a.config.profile === config.profile
          )
            throw new Error('USAGE_SOURCE_ALREADY_BOUND');
        }
        if (existing) {
          const changed =
            existing.config.provider !== config.provider ||
            existing.config.codexHome !== config.codexHome ||
            existing.config.profile !== config.profile;
          existing.config = config;
          existing.revision++;
          existing.sourceRevision++;
          if (changed) {
            existing.observation = null;
            existing.fired = [];
            existing.error = null;
            existing.resetAlerts = [];
            existing.lastAttemptAt = null;
            existing.failures = 0;
          }
          // Reconfiguration never replays a previous resume request into old sessions.
          for (const session of existing.sessions) session.cancelled = true;
          evaluateUsage(existing, this.now());
          scheduleResetAlerts(existing);
        } else {
          if (s.accounts.length >= 32) throw new Error('USAGE_ACCOUNT_LIMIT');
          const a: UsageAccount = {
            config,
            revision: 1,
            sourceRevision: 1,
            observation: null,
            watch: { accountRef: config.accountRef, thresholdsUsedPercent: [80, 90, 95], notifyOnReset: true },
            phase: 'running',
            reason: null,
            cycle: 0,
            nextCheckAt: null,
            lastAttemptAt: null,
            failures: 0,
            error: null,
            fired: [],
            resetAlerts: [],
            pending: [],
            sessions: [],
          };
          evaluateUsage(a, this.now());
          s.accounts.push(a);
        }
        return { state: s, result: undefined };
      });
      await this.flush();
      return this.status(config.accountRef);
    });
  }
  async status(ref?: string) {
    const accounts = await this.accounts();
    if (ref && !accounts.some((a) => a.config.accountRef === ref)) throw new Error('USAGE_ACCOUNT_UNKNOWN');
    return {
      accounts: accounts
        .filter((a) => !ref || a.config.accountRef === ref)
        .map((a) => ({
          accountRef: a.config.accountRef,
          provider: a.config.provider,
          mode: a.config.mode,
          enabled: a.config.enabled,
          workerIds: a.config.workerIds,
          phase: a.phase,
          reason: eligibility(a, this.now()) ?? a.reason,
          freshness: freshness(a.observation, this.now()),
          observation: a.observation,
          nextCheckAt: a.nextCheckAt,
          resetAlerts: a.resetAlerts,
          error: a.error,
          reservePercent: a.config.reservePercent,
          weeklyReservePercent: a.config.weeklyReservePercent,
          watch: a.watch,
          capabilities: this.capabilities(a.config),
          sessions: a.sessions,
        })),
      storageWarning: this.storage.warning ?? null,
      monitorError: this.monitorError,
    };
  }
  watch(input: unknown) {
    return this.run(async () => {
      const w = usageWatchSchema.parse(input);
      await this.mutate(w.accountRef, (a) => {
        a.watch = w;
        scheduleResetAlerts(a);
        evaluateWarnings(a, this.now());
      });
      await this.flush();
      return this.status(w.accountRef);
    });
  }
  unwatch(ref: string) {
    return this.run(async () => {
      await this.mutate(ref, (a) => {
        a.watch = null;
        scheduleResetAlerts(a);
      });
      return this.status(ref);
    });
  }
  ingest(ref: string, raw: unknown, expectedSourceRevision?: number) {
    return this.run(async () => {
      const o = observationSchema.parse(raw);
      if (o.observedAt > this.now()) throw new Error('USAGE_FUTURE_OBSERVATION');
      await this.mutate(ref, (a) => {
        if (expectedSourceRevision !== undefined && a.sourceRevision !== expectedSourceRevision) return;
        if (a.observation && a.observation.observedAt > o.observedAt) return;
        if (a.observation?.identity && a.observation.identity !== o.identity) {
          a.error = 'account_identity_changed';
          evaluateUsage(a, this.now());
          return;
        }
        if (a.error === 'account_identity_changed') return;
        const old = a.observation;
        a.observation = o;
        a.error = null;
        a.failures = 0;
        if (
          old &&
          a.watch?.notifyOnReset &&
          o.windows.some((w) =>
            old.windows.some(
              (p) =>
                p.bucketId === w.bucketId &&
                p.kind === w.kind &&
                p.resetsAt !== null &&
                p.resetsAt <= o.observedAt &&
                w.resetsAt !== null &&
                w.resetsAt > o.observedAt &&
                w.usedPercent !== null &&
                p.usedPercent !== null &&
                w.usedPercent < p.usedPercent,
            ),
          )
        ) {
          usageEvent(a, 'usage.reset', 'A fresh provider observation confirms allowance recovery', this.now());
          a.revision++;
        }
        evaluateWarnings(a, this.now());
        evaluateUsage(a, this.now());
        scheduleResetAlerts(a);
      });
      await this.flush();
    });
  }
  refresh(ref: string) {
    return this.run(async () => {
      const collect = async () => {
        const a = await this.account(ref),
          provider = this.providers[a.config.provider];
        if (!provider.read) throw new Error('USAGE_REFRESH_UNSUPPORTED: source is passive or unavailable');
        if (!a.config.enabled) throw new Error('USAGE_DISABLED');
        if (a.lastAttemptAt !== null && this.now() - a.lastAttemptAt < 60_000) return this.status(ref);
        await this.mutate(ref, (current) => {
          current.lastAttemptAt = this.now();
        });
        try {
          await this.ingest(ref, await provider.read(a.config), a.sourceRevision);
        } catch {
          await this.mutate(ref, (current) => {
            if (current.sourceRevision !== a.sourceRevision) return;
            current.error = 'provider_refresh_failed';
            current.failures = Math.min(20, current.failures + 1);
            evaluateUsage(current, this.now());
            current.nextCheckAt = this.now() + Math.min(900_000, 60_000 * 2 ** (current.failures - 1));
          });
        }
        await this.flush();
        return this.status(ref);
      };
      return this.storage.collect ? this.storage.collect(ref, collect) : collect();
    });
  }
  async assertDispatch(workerId?: string, accountRef?: string) {
    for (const a of await this.accounts()) {
      if (!a.config.enabled || a.config.mode !== 'automatic') continue;
      if (a.config.accountRef !== accountRef && (!workerId || !a.config.workerIds.includes(workerId))) continue;
      const reason = !this.automatic(a.config) ? 'capabilities_unavailable' : eligibility(a, this.now());
      if (reason || (a.phase !== 'running' && a.phase !== 'resume_pending'))
        throw new Error(`USAGE_PAUSED: ${reason ?? a.phase}`);
    }
  }
  async flush() {
    if (!this.events) return;
    for (const a of await this.accounts())
      for (const p of a.pending) {
        const event = await this.events.publish({
          kind: p.kind,
          accountRef: a.config.accountRef,
          deliveryKey: p.key,
          occurredAt: new Date(p.at).toISOString(),
          summary: p.summary,
        });
        await this.notifications?.notify(event);
        await this.mutate(a.config.accountRef, (current) => {
          current.pending = current.pending.filter((e) => e.key !== p.key);
        });
      }
  }
  async tick() {
    if (this.closed) return;
    // Deadline delivery must run even while a previous tick is waiting on provider I/O.
    await this.run(async () => {
      await this.storage.transaction(true, (s) => {
        for (const a of s.accounts) deliverResetAlerts(a, this.now());
        return { state: s, result: undefined };
      });
      await this.flush();
    });
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      await this.run(async () => {
        for (const a of await this.accounts()) {
          if (!a.config.enabled) continue;
          const now = this.now();
          if (a.config.mode === 'automatic' && eligibility(a, now) !== a.reason)
            await this.mutate(a.config.accountRef, (a) => evaluateUsage(a, now));
          if (
            this.providers[a.config.provider].read &&
            (a.nextCheckAt === null ||
              a.nextCheckAt <= now ||
              (a.phase === 'running' && !a.error && (a.lastAttemptAt === null || now - a.lastAttemptAt >= 60_000)))
          )
            await this.refresh(a.config.accountRef).catch(() => {});
        }
        await this.flush();
      });
    } finally {
      this.ticking = false;
    }
  }
  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      void this.tick()
        .then(() => {
          this.monitorError = null;
        })
        .catch(() => {
          this.monitorError = 'usage_monitor_failed';
        });
    }, 1000);
    this.timer.unref();
  }
  async close() {
    clearInterval(this.timer);
    this.closed = true;
    await Promise.allSettled([...this.operations]);
  }
}
