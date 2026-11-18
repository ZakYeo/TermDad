import { z } from 'zod';
import { FileJournal } from './journal.js';
export const memberSchema = z.object({ agentId: z.uuid(), allowPolling: z.boolean().default(false) }).strict();
export const membersSchema = z
  .array(memberSchema)
  .max(64)
  .refine((members) => new Set(members.map((m) => m.agentId)).size === members.length, 'Duplicate worker membership');
export const groupSchema = z
  .object({
    groupId: z.uuid(),
    name: z.string().min(1).max(100),
    revision: z.number().int().positive(),
    state: z.enum(['active', 'closed']),
    members: membersSchema,
  })
  .strict();
export type SupervisionGroup = z.infer<typeof groupSchema>;
export type GroupMember = z.infer<typeof memberSchema>;
const stateSchema = z
  .object({ version: z.literal(1), groups: z.array(groupSchema).max(64) })
  .strict()
  .superRefine((state, ctx) => {
    const ids = new Set<string>(),
      workers = new Set<string>();
    for (const group of state.groups) {
      if (ids.has(group.groupId)) ctx.addIssue({ code: 'custom', message: 'Duplicate group ID' });
      ids.add(group.groupId);
      if (group.state === 'closed') continue;
      for (const member of group.members) {
        if (workers.has(member.agentId))
          ctx.addIssue({ code: 'custom', message: 'Worker belongs to multiple active groups' });
        workers.add(member.agentId);
      }
    }
  });
export type SupervisionState = z.infer<typeof stateSchema>;
export const emptySupervisionState = (): SupervisionState => ({ version: 1, groups: [] });
export const validateSupervisionState = (value: unknown) => stateSchema.parse(value);
export interface SupervisionStorage {
  warning?: string;
  transaction<T>(write: boolean, fn: (state: SupervisionState) => { state?: SupervisionState; result: T }): Promise<T>;
}
export class FileSupervisionStorage extends FileJournal<SupervisionState> implements SupervisionStorage {
  constructor(directory?: string) {
    super('supervision', 'SUPERVISION', emptySupervisionState, validateSupervisionState, directory);
  }
}
export class MemorySupervisionStorage implements SupervisionStorage {
  private state = emptySupervisionState();
  async transaction<T>(
    write: boolean,
    fn: (state: SupervisionState) => { state?: SupervisionState; result: T },
  ): Promise<T> {
    const outcome = fn(structuredClone(this.state));
    if (outcome.state) {
      if (!write) throw new Error('SUPERVISION_STORAGE_READ_ONLY');
      this.state = validateSupervisionState(outcome.state);
    }
    return structuredClone(outcome.result);
  }
}
