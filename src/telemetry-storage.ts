import { mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Metric } from './telemetry.js';

export interface TelemetryStorageOptions {
  maxBytes?: number;
  maxCompleted?: number;
  maxAgeMs?: number;
  queueLimit?: number;
  warn?: () => void;
}
/** Best-effort diagnostics, separate from durable worker/task journals. One writer per active file. */
export class FileTelemetry<T = Metric> {
  private readonly stem = `${process.pid}-${randomUUID()}`;
  private readonly active: string;
  private queue: T[] = [];
  private running?: Promise<void>;
  private closed = false;
  private closing?: Promise<void>;
  private failed = false;
  private bytes = 0;
  private sequence = 0;
  private initialized = false;
  private inFlight = 0;
  private lost = 0;
  private reportedLost = 0;
  private lastWarning = -Infinity;
  constructor(
    readonly directory: string,
    private readonly options: TelemetryStorageOptions = {},
  ) {
    this.active = join(directory, `${this.stem}.active.jsonl`);
  }
  get droppedRecords() {
    return this.lost;
  }
  record(metric: T) {
    if (this.closed || this.failed || this.queue.length + this.inFlight >= (this.options.queueLimit ?? 1000)) {
      this.lost++;
      return;
    }
    this.queue.push(metric);
    this.start();
  }
  private warning() {
    if (Date.now() - this.lastWarning < 60000) return;
    this.lastWarning = Date.now();
    try {
      (this.options.warn ?? (() => console.error('[term-dad] telemetry unavailable; metrics dropped')))();
    } catch {
      /* A diagnostic cannot fail the operation. */
    }
  }
  private start() {
    if (this.running) return;
    this.running = this.drain()
      .catch(() => {
        this.lost += this.queue.length + this.inFlight;
        this.queue = [];
        this.inFlight = 0;
        this.failed = true;
        this.warning();
      })
      .finally(() => {
        this.running = undefined;
        if (this.queue.length && !this.failed) this.start();
      });
  }
  private async initialize() {
    if (this.initialized) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await stat(this.directory);
    if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error('Unsafe telemetry directory');
    await this.prune();
    this.initialized = true;
  }
  private async prune() {
    const completed: { path: string; time: number }[] = [];
    for (const name of await readdir(this.directory)) {
      if (!/^\d+-[0-9a-f-]{36}\.(?:active|\d+)\.jsonl$/.test(name)) continue;
      let path = join(this.directory, name);
      if (name.endsWith('.active.jsonl')) {
        const pid = Number(name.split('-')[0]);
        try {
          process.kill(pid, 0);
          continue;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH') continue;
        }
        const recovered = path.replace('.active.jsonl', '.0.jsonl');
        await rename(path, recovered).catch(() => {});
        path = recovered;
      }
      const info = await stat(path).catch(() => undefined);
      if (info) completed.push({ path, time: info.mtimeMs });
    }
    completed.sort((a, b) => b.time - a.time || a.path.localeCompare(b.path));
    await Promise.all(
      completed
        .filter(
          (entry, index) =>
            index >= (this.options.maxCompleted ?? 20) ||
            Date.now() - entry.time > (this.options.maxAgeMs ?? 7 * 86400000),
        )
        .map((entry) => unlink(entry.path).catch(() => {})),
    );
  }
  private async write(line: string) {
    const size = Buffer.byteLength(line);
    if (this.bytes && this.bytes + size > (this.options.maxBytes ?? 5 * 1024 * 1024)) await this.rotate();
    const file = await open(this.active, 'a', 0o600);
    try {
      await file.writeFile(line);
    } finally {
      await file.close();
    }
    this.bytes += size;
  }
  private async rotate() {
    if (!this.bytes) return;
    await rename(this.active, join(this.directory, `${this.stem}.${++this.sequence}.jsonl`));
    this.bytes = 0;
    await this.prune();
  }
  private async drain() {
    await this.initialize();
    while (this.queue.length) {
      const batch = this.queue.splice(0, 100);
      this.inFlight = batch.length;
      let chunk = '';
      for (const metric of batch) {
        const line = JSON.stringify(metric) + '\n';
        if (chunk && Buffer.byteLength(chunk + line) > (this.options.maxBytes ?? 5 * 1024 * 1024)) {
          await this.write(chunk);
          chunk = '';
        }
        chunk += line;
      }
      if (chunk) await this.write(chunk);
      this.inFlight = 0;
      await this.writeLoss();
    }
  }
  private async writeLoss() {
    if (this.lost === this.reportedLost) return;
    const count = this.lost;
    await this.write(JSON.stringify({ version: 1, kind: 'dropped', count: count - this.reportedLost }) + '\n');
    this.reportedLost = count;
  }
  close() {
    return (this.closing ??= this.finish());
  }
  private async finish() {
    this.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = async () => {
      while (this.running) await this.running;
      if (this.failed || !this.initialized) return;
      await this.writeLoss();
      await this.rotate();
    };
    await Promise.race([
      finish().catch(() => this.warning()),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          this.warning();
          resolve();
        }, 1000);
      }),
    ]);
    clearTimeout(timer);
  }
}
