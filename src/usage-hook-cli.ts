import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { execute } from './backend.js';
import { EventQueue, FileEventStorage } from './events.js';
import { stateDirectory } from './journal.js';
import { UsageService } from './usage.js';
import { FileUsageStorage } from './usage-storage.js';
import { claudeUsageFeed, claimUsageResume, usageHook, type HookClient } from './usage-hooks.js';
import { providerName, usageId } from './usage-model.js';

export async function readHookInput(): Promise<string> {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('USAGE_HOOK_INPUT_LIMIT');
  }
  return input;
}
export function parseUsageHookArgs(argv: string[]) {
  const values = new Map<string, string>();
  const allowed = ['--account', '--client', '--event', '--state-dir', '--renderer-file'];
  let statusline = false,
    wait = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--statusline') {
      statusline = true;
      continue;
    }
    if (argv[i] === '--wait') {
      wait = true;
      continue;
    }
    if (!allowed.includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--') || values.has(argv[i]))
      throw new Error('USAGE_HOOK_ARGUMENT_INVALID');
    values.set(argv[i], argv[++i]);
  }
  const client = providerName.parse(values.get('--client'));
  if (statusline && (client !== 'claude' || wait)) throw new Error('USAGE_HOOK_ARGUMENT_INVALID');
  return {
    accountRef: usageId.parse(values.get('--account')),
    client,
    statusline,
    wait,
    event: values.get('--event'),
    stateDir: values.get('--state-dir') ?? stateDirectory(),
    rendererFile: values.get('--renderer-file'),
  };
}

/** The only shell execution here preserves the user's pre-existing statusLine command verbatim. */
async function renderStatusline(path: string | undefined, input: string) {
  if (!path) return '';
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 65536 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('USAGE_RENDERER_UNSAFE');
    const { command } = JSON.parse(await file.readFile('utf8'));
    if (typeof command !== 'string' || !command || command.length > 8192) throw new Error('USAGE_RENDERER_INVALID');
    return execute('/bin/sh', ['-c', command], input, 5000);
  } finally {
    await file.close();
  }
}

export async function waitForUsageResume(
  usage: UsageService,
  ref: string,
  client: HookClient,
  rawId: string,
  options: { now?: () => number; sleep?: (ms: number) => Promise<void>; alive?: () => boolean } = {},
) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + 8 * 86400_000;
  const id = createHash('sha256').update(`${client}:${rawId}`).digest('hex');
  while (now() < deadline && (options.alive?.() ?? true)) {
    const a = await usage.account(ref);
    const s = a.sessions.find((s) => s.id === id);
    if (!s || s.cancelled || !a.config.enabled || a.config.mode !== 'automatic' || !usage.automatic(a.config))
      return null;
    if (await claimUsageResume(usage, ref, id))
      return {
        status: 'resume',
        accountRef: ref,
        cycle: a.cycle,
        message:
          'Term Dad confirmed fresh short-window and weekly allowance above reserve. Inspect task checkpoints and worker state before continuing; never replay uncertain input.',
      };
    await sleep(2000);
  }
  return null;
}

export async function runUsageHook(argv: string[]): Promise<number> {
  let options;
  try {
    options = parseUsageHookArgs(argv);
  } catch {
    console.error('USAGE_HOOK_ARGUMENT_INVALID');
    return 1;
  }
  const events = new EventQueue(new FileEventStorage(options.stateDir));
  const usage = new UsageService(new FileUsageStorage(options.stateDir), events);
  let input = '',
    renderer = '';
  try {
    input = await readHookInput();
    const data = JSON.parse(input);
    if (options.statusline) {
      // Rendering remains useful even if collection fails; never replace a user's existing display.
      try {
        await claudeUsageFeed(usage, options.accountRef, data);
      } catch {
        console.error('USAGE_FEED_UNAVAILABLE');
      }
      renderer = await renderStatusline(options.rendererFile, input);
      if (renderer) process.stdout.write(renderer);
      else {
        const account = await usage.account(options.accountRef);
        process.stdout.write(
          account.observation?.windows.map((w) => `${w.kind}: ${w.usedPercent ?? '?'}%`).join(' | ') ??
            'Usage unavailable',
        );
      }
      return 0;
    }
    if (options.event) data.hook_event_name = options.event;
    const output = await usageHook(usage, options.accountRef, options.client, data);
    if (options.wait) {
      const parent = process.ppid;
      const resume = await waitForUsageResume(
        usage,
        options.accountRef,
        options.client,
        String(data.session_id ?? data.sessionId),
        {
          alive: () => process.ppid === parent,
        },
      );
      if (!resume) return 0;
      if (options.client === 'claude') {
        process.stderr.write(resume.message + '\n');
        return 2;
      }
      process.stdout.write(JSON.stringify(resume) + '\n');
      return 0;
    }
    await usage.flush();
    process.stdout.write(JSON.stringify(output) + '\n');
    return 0;
  } catch {
    // Failures are diagnostics, never fabricated quota readings or permission decisions.
    console.error('USAGE_HOOK_UNAVAILABLE: inspect usage.status and hooks doctor');
    return 1;
  } finally {
    await usage.close();
    await events.close();
  }
}
