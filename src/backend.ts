import { spawn as spawnProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { windowsInstance, type GuiInstance } from './terminal-instance.js';
import type { TerminalInstance } from './worker-storage.js';
import { CodedError } from './errors.js';

export const id = z.number().int().nonnegative().safe();
const string = z
  .string()
  .min(1)
  .max(8192)
  .refine((s) => !s.includes('\0'), 'NUL is not allowed');
/**
 * Splits one command line into argv the way a POSIX shell would tokenise it (whitespace, single
 * and double quotes, backslash escapes) without ever invoking a shell: no expansion, no operators.
 */
export function splitCommand(command: string | string[]): string[] {
  if (Array.isArray(command)) return command;
  if (!/\S/.test(command)) throw new Error('command must name a program');
  const argv: string[] = [];
  let current = '',
    inWord = false,
    quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) current += command[++i];
      else current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < command.length) {
      current += command[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) {
        argv.push(current);
        current = '';
        inWord = false;
      }
    } else {
      current += c;
      inWord = true;
    }
  }
  if (quote) throw new Error('command has an unterminated quote');
  if (inWord) argv.push(current);
  if (!argv.length) throw new Error('command must name a program');
  return argv;
}
// A string is split by the handlers, not the schema: the SDK reports a schema failure only as
// "Invalid input at command", while splitCommand can say which quote is unterminated.
const commandSchema = z.union([z.array(string).min(1).max(100), z.string().min(1).max(8192)]);
export const spawnSchema = z.object({
  cwd: string.optional(),
  command: commandSchema
    .optional()
    .describe('argv array, or one command line split like a shell would (quotes honoured, no shell run)'),
  paneId: id.optional(),
  windowId: id.optional(),
  newWindow: z.boolean().optional(),
  domain: string.optional(),
});
export type SpawnOptions = z.infer<typeof spawnSchema>;
export type SpawnArguments = Omit<SpawnOptions, 'command'> & { command?: string[] };
const argvSchema = z.array(string).min(1).max(100);
/**
 * The one place spawn options are validated: the schema, the window-target conflict, and the
 * command split into argv. Every launch path calls this once, so no caller re-validates.
 */
export function spawnArguments(o: SpawnOptions): SpawnArguments {
  const parsed = spawnSchema.parse(o);
  if (parsed.newWindow && parsed.windowId !== undefined)
    throw new CodedError('ARGUMENT_CONFLICT', 'newWindow and windowId are mutually exclusive; supply one of them');
  return {
    ...parsed,
    command: parsed.command === undefined ? undefined : argvSchema.parse(splitCommand(parsed.command)),
  };
}
const paneSchema = z
  .object({
    pane_id: id,
    tab_id: id,
    window_id: id,
    title: z.string(),
    cwd: z.string(),
    size: z.object({ rows: id, cols: id }).passthrough(),
  })
  .passthrough();
export type Pane = z.infer<typeof paneSchema>;
export function parsePanes(text: string): Pane[] {
  try {
    return z.array(paneSchema).parse(JSON.parse(text));
  } catch {
    throw new Error('Invalid WezTerm list JSON: expected panes with IDs, title, cwd and size');
  }
}
export type Runner = (args: string[], input?: string) => Promise<string>;
export function execute(
  file: string,
  args: string[],
  input?: string,
  timeout = 15000,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawnProcess(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    p.stderr.setEncoding('utf8');
    const decoder = new StringDecoder('utf8');
    let stdout = '',
      stderr = '',
      done = false,
      stdoutBytes = 0;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(stdout);
    };
    const terminate = (error: Error) => {
      if (done) return;
      p.kill('SIGKILL');
      p.stdin.destroy();
      p.stdout.destroy();
      p.stderr.destroy();
      finish(error);
    };
    const timer = setTimeout(() => terminate(new Error(`${file}: command timed out after ${timeout}ms`)), timeout);
    p.on('error', (e) => finish(new Error(`${file}: ${e.message}. Check executable and terminal connectivity.`)));
    p.stdout.on('data', (b: Buffer) => {
      if (done) return;
      stdoutBytes += b.length;
      if (stdoutBytes > 8 * 1024 * 1024) {
        terminate(new Error('Command output exceeded 8 MiB'));
        return;
      }
      stdout += decoder.write(b);
    });
    p.stdout.on('end', () => {
      if (!done) stdout += decoder.end();
    });
    p.stderr.on('data', (b) => {
      if (!done) stderr = (stderr + b).slice(-8192);
    });
    p.stdin.on('error', () => {});
    p.stdin.end(input);
    p.on('close', (code) =>
      finish(code === 0 ? undefined : new Error(`${file} ${args[0]} failed (${code}): ${stderr}`)),
    );
  });
}
export interface TerminalBackend {
  instance?(): Promise<TerminalInstance | null>;
  listInstances?(): Promise<GuiInstance[]>;
  selectInstance?(key: string): Promise<TerminalInstance>;
  list(): Promise<Pane[]>;
  spawn(o: SpawnOptions): Promise<number>;
  split(o: SpawnOptions & { paneId: number; direction?: 'right' | 'bottom'; percent?: number }): Promise<number>;
  read(paneId: number, lines?: number): Promise<string>;
  sendText(paneId: number, text: string, raw?: boolean): Promise<void>;
  close(paneId: number): Promise<void>;
  focus(paneId: number): Promise<void>;
  resize(paneId: number, direction: string, amount: number): Promise<void>;
  move(paneId: number, newWindow?: boolean, windowId?: number): Promise<void>;
}
export function defaultBinary() {
  const win = '/mnt/c/Program Files/WezTerm/wezterm.exe';
  return process.env.TERM_DAD_WEZTERM || (existsSync(win) ? win : 'wezterm');
}
// WSL does not forward arbitrary Linux environment variables to Windows.
export function terminalEnvironment(endpoint?: string): NodeJS.ProcessEnv {
  const forwarded = (process.env.WSLENV ?? '').split(':').filter((v) => v && v.split('/')[0] !== 'WEZTERM_UNIX_SOCKET');
  return {
    ...process.env,
    ...(endpoint ? { WEZTERM_UNIX_SOCKET: endpoint, WSLENV: [...forwarded, 'WEZTERM_UNIX_SOCKET'].join(':') } : {}),
  };
}
/** Preserve terminal padding while applying the CLI read's newline and tail conventions. */
export const terminalText = (text: string, lines: number) =>
  text.replace(/\r\n/g, '\n').trimEnd().split('\n').slice(-lines).join('\n');

export class WezTermBackend implements TerminalBackend {
  readonly run: Runner;
  readonly instance: () => Promise<TerminalInstance | null>;
  readonly listInstances?: () => Promise<GuiInstance[]>;
  readonly selectInstance?: (key: string) => Promise<TerminalInstance>;
  constructor(run?: Runner, identity?: () => Promise<TerminalInstance | null>) {
    const binary = defaultBinary();
    const resolver = !identity && !run ? windowsInstance(binary, execute) : undefined;
    this.instance = identity ?? resolver ?? (async () => null);
    if (resolver) {
      this.listInstances = () => resolver.list();
      this.selectInstance = (key) => resolver.select(key);
    }
    this.run =
      run ??
      (async (args, input) => {
        const identity = await this.instance(),
          endpoint = identity?.endpoint ?? process.env.WEZTERM_UNIX_SOCKET;
        return execute(binary, ['cli', '--no-auto-start', ...args], input, 15000, terminalEnvironment(endpoint));
      });
  }
  async list() {
    return parsePanes(await this.run(['list', '--format', 'json']));
  }
  private options(o: SpawnArguments) {
    const a: string[] = [];
    if (o.paneId !== undefined) a.push('--pane-id', String(o.paneId));
    if (o.cwd) a.push('--cwd', o.cwd);
    return a;
  }
  private paneId(text: string) {
    const n = Number(text.trim());
    if (!/^\d+$/.test(text.trim())) throw new Error('WezTerm returned an invalid pane ID');
    return id.parse(n);
  }
  async spawn(options: SpawnOptions) {
    const o = spawnArguments(options),
      a = ['spawn', ...this.options(o)];
    if (o.newWindow) a.push('--new-window');
    if (o.windowId !== undefined) a.push('--window-id', String(o.windowId));
    if (o.domain) a.push('--domain-name', o.domain);
    if (o.command) a.push('--', ...o.command);
    return this.paneId(await this.run(a));
  }
  async split(options: SpawnOptions & { paneId: number; direction?: 'right' | 'bottom'; percent?: number }) {
    const o = spawnArguments(options);
    id.parse(options.paneId);
    const a = ['split-pane', ...this.options(o), options.direction === 'right' ? '--right' : '--bottom'];
    if (options.percent !== undefined)
      a.push('--percent', String(z.number().int().min(1).max(99).parse(options.percent)));
    if (o.command) a.push('--', ...o.command);
    return this.paneId(await this.run(a));
  }
  async read(paneId: number, lines = 100) {
    id.parse(paneId);
    z.number().int().min(1).max(5000).parse(lines);
    const text = await this.run(['get-text', '--pane-id', String(paneId), '--start-line', String(-lines)]);
    return terminalText(text, lines);
  }
  async sendText(paneId: number, text: string, raw = false) {
    id.parse(paneId);
    z.string().max(100000).parse(text);
    await this.run(['send-text', '--pane-id', String(paneId), ...(raw ? ['--no-paste'] : [])], text);
  }
  async close(paneId: number) {
    await this.run(['kill-pane', '--pane-id', String(id.parse(paneId))]);
  }
  async focus(paneId: number) {
    await this.run(['activate-pane', '--pane-id', String(id.parse(paneId))]);
  }
  async resize(paneId: number, direction: string, amount: number) {
    await this.run([
      'adjust-pane-size',
      '--pane-id',
      String(id.parse(paneId)),
      '--amount',
      String(z.number().int().min(1).max(1000).parse(amount)),
      z.enum(['Left', 'Right', 'Up', 'Down']).parse(direction),
    ]);
  }
  async move(paneId: number, newWindow = false, windowId?: number) {
    await this.run([
      'move-pane-to-new-tab',
      '--pane-id',
      String(id.parse(paneId)),
      ...(newWindow ? ['--new-window'] : []),
      ...(windowId !== undefined ? ['--window-id', String(id.parse(windowId))] : []),
    ]);
  }
}
export const keys: Record<string, string> = {
  ENTER: '\r',
  ESC: '\x1b',
  TAB: '\t',
  SPACE: ' ',
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  RIGHT: '\x1b[C',
  LEFT: '\x1b[D',
  PAGEUP: '\x1b[5~',
  PAGEDOWN: '\x1b[6~',
  CTRL_C: '\x03',
  CTRL_D: '\x04',
  CTRL_A: '\x01',
  CTRL_E: '\x05',
  CTRL_U: '\x15',
  BACKSPACE: '\x7f',
  DELETE: '\x1b[3~',
  HOME: '\x1b[H',
  END: '\x1b[F',
};
const keyAliases: Record<string, string> = {
  ESCAPE: 'ESC',
  RETURN: 'ENTER',
  CR: 'ENTER',
  NEWLINE: 'ENTER',
  ARROWUP: 'UP',
  UPARROW: 'UP',
  ARROWDOWN: 'DOWN',
  DOWNARROW: 'DOWN',
  ARROWLEFT: 'LEFT',
  LEFTARROW: 'LEFT',
  ARROWRIGHT: 'RIGHT',
  RIGHTARROW: 'RIGHT',
  PGUP: 'PAGEUP',
  PGDN: 'PAGEDOWN',
  PAGE_UP: 'PAGEUP',
  PAGE_DOWN: 'PAGEDOWN',
  DEL: 'DELETE',
  BS: 'BACKSPACE',
};
export const keyDescription = `Case-insensitive key name: ${Object.keys(keys).join(', ')}. Aliases: ${Object.entries(
  keyAliases,
)
  .map(([alias, key]) => `${alias}→${key}`)
  .join(', ')}. Separators + - and space are accepted, so Ctrl+C, ctrl-c and "Page Down" work.`;
/** Uppercase, unify the separators people type, drop a KEY_ prefix, then resolve aliases. */
export function canonicalKey(key: string) {
  const name = key
    .trim()
    .toUpperCase()
    .replace(/[+\-\s]+/g, '_')
    .replace(/^KEY_/, '');
  return Object.hasOwn(keyAliases, name) ? keyAliases[name] : name;
}
export async function sendKeys(b: TerminalBackend, paneId: number, sequence: string[]) {
  const encoded = sequence.map((key) => {
    const canonical = canonicalKey(key);
    if (!Object.hasOwn(keys, canonical))
      throw new CodedError('UNSUPPORTED_KEY', `Unsupported key: ${key}. ${keyDescription}`);
    return keys[canonical];
  });
  for (const input of encoded) await b.sendText(paneId, input, true);
}
/** Pastes then presses Enter; with no text it only presses Enter, which is what confirming a prompt needs. */
export async function submit(b: TerminalBackend, paneId: number, text = '') {
  if (text) {
    await b.sendText(paneId, text);
    await new Promise((r) => setTimeout(r, 100));
  }
  await sendKeys(b, paneId, ['ENTER']);
}
