import { hasCode } from './errors.js';
/** Retry read-only quota status on contention, never retry collectors or mutations. */
export async function retryUsageRead<T>(
  read: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  const delays = [50, 100, 200, 400, 800];
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (!hasCode(error, 'USAGE_STORAGE_BUSY') || attempt === delays.length) throw error;
      await sleep(delays[attempt]);
    }
  }
}
