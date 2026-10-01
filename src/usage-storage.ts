import { acquireLock, FileJournal } from './journal.js';
import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { UsageState } from './usage-model.js';
import { parseUsageState } from './usage-migration.js';

export interface UsageStorage {
  warning?: string;
  collect?<T>(accountRef: string, fn: () => Promise<T>): Promise<T>;
  transaction<T>(write: boolean, fn: (s: UsageState) => { state?: UsageState; result: T }): Promise<T>;
}
export class FileUsageStorage extends FileJournal<UsageState> {
  constructor(directory?: string) {
    super('usage', 'USAGE', () => ({ version: 2, accounts: [] }), parseUsageState, directory);
  }
  async collect<T>(accountRef: string, fn: () => Promise<T>): Promise<T> {
    // Dedicated collector exclusion; never hold a usage journal transaction over I/O.
    const key = createHash('sha256').update(accountRef).digest('hex').slice(0, 24);
    const path = join(this.directory, `usage-collector-${key}.lock`);
    let lock;
    try {
      lock = await acquireLock(path);
    } catch {
      throw new Error('USAGE_COLLECTOR_BUSY');
    }
    try {
      return await fn();
    } finally {
      await lock.close();
      await unlink(path);
    }
  }
}
