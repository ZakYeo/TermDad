import { terminalText, type TerminalBackend, type Pane } from './backend.js';
import type { TerminalInstance } from './worker-storage.js';

/** Verified transport facts live only for one read operation, including failures. */
export class TerminalRead {
  private active = true;
  private identityResult?: Promise<TerminalInstance | null>;
  private panesResult?: Promise<Pane[]>;
  private screens = new Map<number, { lines: number; text: Promise<string> }>();
  private constructor(
    private backend: TerminalBackend,
    private mode: 'checks' | 'snapshot',
  ) {}
  static async run<T>(
    backend: TerminalBackend,
    fn: (read: TerminalRead) => Promise<T>,
    mode: 'checks' | 'snapshot' = 'checks',
  ): Promise<T> {
    const read = new TerminalRead(backend, mode);
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
  /** Snapshot callers acquire managed screens under their worker locks before projecting pane tails. */
  screen(paneId: number, lines: number): Promise<string> {
    this.check();
    if (this.mode === 'checks') return this.backend.read(paneId, lines);
    let captured = this.screens.get(paneId);
    if (!captured) {
      captured = { lines, text: Promise.resolve().then(() => this.backend.read(paneId, lines)) };
      this.screens.set(paneId, captured);
    }
    if (captured.lines < lines) throw new Error('Snapshot must acquire its deepest screen first');
    return captured.lines === lines ? captured.text : captured.text.then((text) => terminalText(text, lines));
  }
}
