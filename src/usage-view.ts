import type { UsageService } from './usage.js';

/** Quota metadata is an independent source; its failure must not hide worker/task status. */
export async function usageView(usage: UsageService) {
  try {
    return { available: true as const, ...(await usage.status()) };
  } catch {
    return { available: false as const, error: 'usage_status_unavailable' as const, accounts: [] };
  }
}
