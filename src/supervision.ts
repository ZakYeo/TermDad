import { wakeCommand } from './event-tools.js';
import { randomUUID } from 'node:crypto';
import { CodedError } from './errors.js';
import {
  groupSchema,
  membersSchema,
  type SupervisionGroup,
  type SupervisionStorage,
  type GroupMember,
} from './supervision-storage.js';

type Watch = {
  bindingRevision?: string;
  watchId: string;
  agentId?: string;
  disappeared?: boolean;
  backendError?: string;
  deliveryError?: string;
};
type Push = { enabled?: boolean; deliverable?: boolean; proven?: boolean; reason?: string };
export interface SupervisionRuntime {
  resolve(agentId: string): Promise<{ revision?: string }>;
  enable(agentId: string): Promise<unknown>;
  pushStatus(agentId: string): Promise<Push>;
  watches(): Watch[];
  createWatch(agentId: string): Promise<Watch>;
  removeWatch(watchId: string): unknown;
  guardWatch(watchId: string, valid: () => Promise<boolean>): void;
}
const fail = (code: string, message: string): never => {
  throw new CodedError(`SUPERVISION_${code}`, message);
};
export class Supervision {
  private owned = new Map<string, Map<string, string>>();
  private pending = new Set<Promise<unknown>>();
  private stopped = false;
  constructor(
    private storage: SupervisionStorage,
    private runtime: SupervisionRuntime,
  ) {}
  get(groupId: string) {
    return this.storage.transaction(false, (s) => ({
      result: s.groups.find((g) => g.groupId === groupId) ?? fail('NOT_FOUND', 'Unknown group'),
    }));
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('SUPERVISION_CLOSED'));
    if (this.pending.size >= 64) return Promise.reject(new Error('SUPERVISION_BUSY'));
    const previous = [...this.pending];
    const result = Promise.allSettled(previous).then(operation);
    this.pending.add(result);
    void result.finally(() => this.pending.delete(result)).catch(() => {});
    return result;
  }
  create(name: string, members: GroupMember[]) {
    return this.run(async () => {
      const group = groupSchema.parse({ groupId: randomUUID(), name, members, revision: 1, state: 'active' });
      await this.storage.transaction(true, (s) => {
        if (s.groups.length >= 64) fail('CAPACITY', 'Maximum of 64 groups reached');
        this.assertAvailable(s.groups, group);
        s.groups.push(group);
        return { state: s, result: undefined };
      });
      return this.prepare(group);
    });
  }
  update(groupId: string, expectedRevision: number, members: GroupMember[]) {
    return this.run(async () => {
      const parsed = membersSchema.parse(members);
      const group = await this.storage.transaction(true, (s) => {
        const g = s.groups.find((g) => g.groupId === groupId) ?? fail('NOT_FOUND', 'Unknown group');
        this.assertRevision(g, expectedRevision);
        if (g.state === 'closed') fail('GROUP_CLOSED', 'Closed groups cannot be updated');
        const next = { ...g, members: parsed, revision: g.revision + 1 };
        this.assertAvailable(s.groups, next);
        Object.assign(g, next);
        return { state: s, result: g };
      });
      this.prune(group);
      return this.prepare(group);
    });
  }
  close(groupId: string, expectedRevision: number) {
    return this.run(async () => {
      const group = await this.storage.transaction(true, (s) => {
        const g = s.groups.find((g) => g.groupId === groupId) ?? fail('NOT_FOUND', 'Unknown group');
        this.assertRevision(g, expectedRevision);
        if (g.state !== 'closed') {
          g.state = 'closed';
          g.revision++;
        }
        return { state: s, result: g };
      });
      this.prune(group);
      return this.status(groupId);
    });
  }
  private assertRevision(group: SupervisionGroup, revision: number) {
    if (group.revision !== revision) fail('REVISION_CONFLICT', 'Read the current group and retry with its revision');
  }
  private assertAvailable(groups: SupervisionGroup[], next: SupervisionGroup) {
    if (
      groups.some(
        (g) =>
          g.groupId !== next.groupId &&
          g.state === 'active' &&
          g.members.some((m) => next.members.some((n) => n.agentId === m.agentId)),
      )
    )
      fail('WORKER_ASSIGNED', 'A worker already belongs to another active group');
  }
  private prune(group: SupervisionGroup) {
    const owned = this.owned.get(group.groupId);
    if (!owned) return;
    for (const [agentId, watchId] of owned) {
      if (group.state === 'closed' || !group.members.some((m) => m.agentId === agentId)) {
        this.runtime.removeWatch(watchId);
        owned.delete(agentId);
      }
    }
    if (!owned.size) this.owned.delete(group.groupId);
  }
  private async prepare(group: SupervisionGroup) {
    // Retire old ownership before borrowing a watch for a newly assigned group.
    for (const groupId of this.owned.keys()) this.prune(await this.get(groupId));
    const failures: Record<string, string> = {};
    for (const member of group.members) {
      try {
        const worker = await this.runtime.resolve(member.agentId);
        if (!member.allowPolling) await this.runtime.enable(member.agentId);
        else await this.runtime.enable(member.agentId).catch(() => {});
        const owned = this.owned.get(group.groupId)?.get(member.agentId);
        const usable = (w: Watch) =>
          w.agentId === member.agentId &&
          !w.disappeared &&
          !w.backendError &&
          !w.deliveryError &&
          (!w.bindingRevision || w.bindingRevision === worker.revision);
        if (owned && !this.runtime.watches().some((w) => w.watchId === owned && usable(w))) {
          this.runtime.removeWatch(owned);
          this.owned.get(group.groupId)?.delete(member.agentId);
        }
        const existing = this.runtime.watches().find(usable);
        if (!existing) {
          const watch = await this.runtime.createWatch(member.agentId);
          let owned = this.owned.get(group.groupId);
          if (!owned) this.owned.set(group.groupId, (owned = new Map()));
          owned.set(member.agentId, watch.watchId);
          this.runtime.guardWatch(watch.watchId, async () => {
            const current = await this.get(group.groupId);
            return current.state === 'active' && current.members.some((m) => m.agentId === member.agentId);
          });
        }
      } catch (error) {
        failures[member.agentId] = error instanceof CodedError ? error.code : 'MONITORING_SETUP_FAILED';
      }
    }
    const current = await this.get(group.groupId);
    this.prune(current);
    this.assertRevision(current, group.revision);
    const status = await this.status(group.groupId);
    return {
      ...status,
      monitoringReady: status.monitoringReady && Object.keys(failures).length === 0,
      setupErrors: failures,
    };
  }
  async status(groupId: string) {
    const group = await this.get(groupId),
      watches = this.runtime.watches();
    const members = await Promise.all(
      group.members.map(async (member) => {
        let worker: { revision?: string } = {};
        let watch: Watch | undefined;
        let push: Push = {},
          error: string | undefined;
        try {
          worker = await this.runtime.resolve(member.agentId);
          watch = watches.find(
            (w) =>
              w.agentId === member.agentId &&
              !w.disappeared &&
              !w.backendError &&
              !w.deliveryError &&
              (!w.bindingRevision || w.bindingRevision === worker.revision),
          );
          push = await this.runtime.pushStatus(member.agentId);
        } catch {
          error = 'WORKER_UNAVAILABLE';
        }
        const monitored =
          !error &&
          !!watch &&
          !watch.backendError &&
          !watch.deliveryError &&
          (member.allowPolling || push.deliverable === true);
        return {
          ...member,
          watchId: watch?.watchId ?? null,
          watchOwned: !!watch && this.owned.get(groupId)?.get(member.agentId) === watch.watchId,
          push,
          monitored,
          ...(error ? { error } : {}),
        };
      }),
    );
    return {
      group,
      members,
      monitoringReady: group.state === 'active' && members.every((m) => m.monitored),
      waiter: {
        ...wakeCommand(undefined, undefined, { groupId }),
        launched: 'unknown' as const,
        clientResume: 'unknown' as const,
      },
      storageWarning: this.storage.warning ?? null,
    };
  }
  async dispose() {
    this.stopped = true;
    await Promise.allSettled([...this.pending]);
  }
}
