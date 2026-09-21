import { randomUUID } from 'node:crypto';
import type { TerminalBackend } from './backend.js';
import { FileTelemetry } from './telemetry-storage.js';

export type MonitoringInput =
  | { kind: 'session'; phase: 'start' | 'end' }
  | { kind: 'backend'; operation: 'instance' | 'list' | 'read'; paneId?: number; durationMs: number; success: boolean }
  | { kind: 'watch'; watchId: string; paneId: number; phase: 'start' | 'end' }
  | {
      kind: 'sample';
      watchId: string;
      paneId: number;
      source: 'baseline' | 'poll' | 'push';
      changed: boolean;
      intervalMs: number;
      pushBacked: boolean;
      pushProven: boolean;
    }
  | { kind: 'sample_error'; watchId: string; paneId: number }
  | { kind: 'delivery'; watchId: string; paneId: number; eventKind: string; success: boolean; delayMs: number }
  | { kind: 'push'; paneId: number; eventKind: string; success: boolean; durationMs: number };
export type MonitoringMetric = MonitoringInput & { version: 1; session: string; timestamp: string };
export interface MonitoringSink {
  record(metric: MonitoringMetric): void;
  close?(): Promise<void>;
}
/** Opt-in content-free measurements. Failure must never alter terminal or notification behavior. */
export class Monitoring {
  private readonly session = randomUUID();
  constructor(
    private sink: MonitoringSink,
    private now = Date.now,
  ) {
    this.record({ kind: 'session', phase: 'start' });
  }
  static file(directory: string) {
    return new Monitoring(new FileTelemetry<MonitoringMetric>(directory));
  }
  record(input: MonitoringInput) {
    try {
      this.sink.record({ ...input, version: 1, session: this.session, timestamp: new Date(this.now()).toISOString() });
    } catch {
      /* Measurement cannot fail an operation. */
    }
  }
  backend(backend: TerminalBackend): TerminalBackend {
    return new Proxy(backend, {
      get: (target, key) => {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        if (key !== 'instance' && key !== 'list' && key !== 'read') return value.bind(target);
        return async (...args: unknown[]) => {
          const start = performance.now();
          let success = false;
          try {
            const result = await value.apply(target, args);
            success = true;
            return result;
          } finally {
            this.record({
              kind: 'backend',
              operation: key,
              ...(key === 'read' ? { paneId: args[0] as number } : {}),
              durationMs: performance.now() - start,
              success,
            });
          }
        };
      },
    });
  }
  async close() {
    this.record({ kind: 'session', phase: 'end' });
    try {
      await this.sink.close?.();
    } catch {
      /* Best effort. */
    }
  }
}
