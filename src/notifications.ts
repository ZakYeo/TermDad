import { z } from 'zod';
import { execute } from './backend.js';
import type { EventInput } from './events.js';
export interface NotificationProvider {
  notify(event: EventInput): Promise<void>;
}
export type NotificationRunner = (file: string, args: string[], input: string, timeout: number) => Promise<string>;
/** Trusted local command, JSON on stdin, no terminal content and no shell. */
export class CommandNotificationProvider implements NotificationProvider {
  private command: string[];
  constructor(
    command: string[],
    private run: NotificationRunner = execute,
  ) {
    this.command = z
      .array(
        z
          .string()
          .min(1)
          .max(8192)
          .refine((s) => !s.includes('\0')),
      )
      .min(1)
      .max(100)
      .parse(command);
  }
  async notify(event: EventInput) {
    await this.run(this.command[0], this.command.slice(1), JSON.stringify(event), 5000);
  }
  static fromEnvironment() {
    const value = process.env.TERM_DAD_NOTIFICATION_COMMAND;
    return value ? new CommandNotificationProvider(JSON.parse(value)) : undefined;
  }
}
