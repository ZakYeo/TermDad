import type { TerminalBackend, Pane } from './backend.js';
import type { TerminalInstance } from './worker-storage.js';

/** Verified transport facts live only for one read operation, including failures. */
export class TerminalRead {
  private active = true;
  private identityResult?: Promise<TerminalInstance | null>;
  private panesResult?: Promise<Pane[]>;
  private constructor(private backend: TerminalBackend) {}
  static async run<T>(backend: TerminalBackend, fn: (read: TerminalRead) => Promise<T>): Promise<T> {
    const read = new TerminalRead(backend);
    try {
      return await fn(read);
    } finally {
      read.active = false;
    }
  }
  private check() {
    if (!this.active) throw new Error('Terminal read scope has ended');
  }
  identity() {
    this.check();
    return (this.identityResult ??= Promise.resolve().then(() => this.backend.instance?.() ?? null));
  }
  panes() {
    this.check();
    return (this.panesResult ??= Promise.resolve().then(() => this.backend.list()));
  }
}
