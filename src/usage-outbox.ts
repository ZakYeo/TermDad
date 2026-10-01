import type { EventInput, EventQueue } from './events.js';
import type { NotificationProvider } from './notifications.js';
import type { UsageService } from './usage.js';
import type { UsageAccount } from './usage-model.js';

type Pending = UsageAccount['pending'][number];
const eventInput = (accountRef: string, p: Pending): EventInput => ({
  kind: p.kind,
  accountRef,
  deliveryKey: p.key,
  occurredAt: new Date(p.at).toISOString(),
  summary: p.summary,
});

/** Independent durable destinations: desktop delivery cannot hold up the event journal. */
export class UsageOutbox {
  private publishing?: Promise<void>;
  private notifying?: Promise<void>;
  private cursor = 0;
  constructor(
    private usage: Pick<UsageService, 'accounts' | 'mutate'>,
    private events?: EventQueue,
    private notifications?: NotificationProvider,
  ) {}
  private async entries() {
    return (await this.usage.accounts()).flatMap((a) => a.pending.map((p) => ({ accountRef: a.config.accountRef, p })));
  }
  publish(): Promise<void> {
    if (this.publishing) return this.publishing;
    const work = async () => {
      if (!this.events) return;
      const errors: unknown[] = [];
      for (const { accountRef, p } of await this.entries()) {
        if (p.published) continue;
        try {
          await this.events.publish(eventInput(accountRef, p));
          await this.usage.mutate(accountRef, (a) => {
            if (!this.notifications) a.pending = a.pending.filter((e) => e.key !== p.key);
            else {
              const current = a.pending.find((e) => e.key === p.key);
              if (current) current.published = true;
            }
          });
        } catch (e) {
          errors.push(e);
        }
      }
      if (errors.length) throw errors[0];
    };
    this.publishing = work().finally(() => {
      this.publishing = undefined;
    });
    return this.publishing;
  }
  notify(): Promise<void> {
    if (this.notifying) return this.notifying;
    const work = async () => {
      if (!this.notifications) return;
      const entries = (await this.entries()).filter(({ p }) => p.published);
      if (!entries.length) return;
      // Bounded parallel desktop work; rotate retries so broken destinations cannot starve others.
      const offset = this.cursor % entries.length;
      const batch = [...entries.slice(offset), ...entries.slice(0, offset)].slice(0, 8);
      this.cursor = offset + batch.length;
      const results = await Promise.allSettled(
        batch.map(async ({ accountRef, p }) => {
          await this.notifications!.notify(eventInput(accountRef, p));
          await this.usage.mutate(accountRef, (a) => {
            a.pending = a.pending.filter((e) => e.key !== p.key);
          });
        }),
      );
      const failure = results.find((r) => r.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    };
    this.notifying = work().finally(() => {
      this.notifying = undefined;
    });
    return this.notifying;
  }
}
