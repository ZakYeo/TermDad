import { constants } from 'node:fs';
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { acquireLock, stateDirectory } from './journal.js';
import { providerName, usageId } from './usage-model.js';
import { hookConfiguration, mergeHooks, removeOwned, type HookConfig, type HookInstallOptions } from './hook-config.js';

async function readJson(path: string): Promise<HookConfig | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('HOOK_CONFIG_INVALID');
    const value = JSON.parse(await file.readFile('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('HOOK_CONFIG_INVALID');
    return value;
  } finally {
    await file.close();
  }
}
async function atomicJson(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

export async function manageHooks(action: string, path: string, options: HookInstallOptions) {
  if (!['preview', 'install', 'status', 'doctor', 'uninstall'].includes(action)) throw new Error('HOOK_ACTION_INVALID');
  const manifestPath = `${path}.term-dad.json`,
    rendererFile = `${path}.term-dad-renderer.json`;
  const mutate = action === 'install' || action === 'uninstall';
  if (mutate) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lease = mutate ? await acquireLock(`${path}.term-dad.lock`) : undefined;
  try {
    const original = (await readJson(path)) ?? {};
    const manifest = await readJson(manifestPath);
    const previous = manifest?.installed as HookConfig | undefined;
    const cleaned = removeOwned(original, previous);
    const ownStatusline =
      previous?.statusLine && JSON.stringify(original.statusLine) === JSON.stringify(previous.statusLine);
    const priorStatusline = ownStatusline ? manifest?.originalStatusLine : original.statusLine;
    if (priorStatusline && (priorStatusline.type !== 'command' || typeof priorStatusline.command !== 'string'))
      throw new Error('HOOK_STATUSLINE_UNSUPPORTED: existing renderer cannot be wrapped safely');
    const installed = hookConfiguration({ ...options, ...(priorStatusline ? { rendererFile } : {}) });
    if (action === 'status' || action === 'doctor') {
      const missing = Object.entries(previous?.hooks ?? {}).flatMap(([event, entries]) =>
        entries
          .filter((e) => !(original.hooks?.[event] ?? []).some((x) => JSON.stringify(x) === JSON.stringify(e)))
          .map(() => event),
      );
      return {
        installed: !!manifest,
        client: options.client,
        config: path,
        missing,
        statuslineIntact: !previous?.statusLine || !!ownStatusline,
        proven: false,
        note: 'Configuration presence is not runtime delivery evidence. Inspect usage.status sessions and client hook trust. Automatic pause/resume is capability-gated.',
      };
    }
    if (action === 'preview') return { config: path, changes: installed, wrapsExistingStatusline: !!priorStatusline };
    if (action === 'uninstall') {
      if (!manifest) return { changed: false, config: path };
      if (ownStatusline) {
        if (manifest.originalStatusLine) cleaned.statusLine = manifest.originalStatusLine;
        else delete cleaned.statusLine;
      }
      await atomicJson(`${path}.term-dad-backup.json`, original);
      await atomicJson(path, cleaned);
      await unlink(manifestPath);
      // Keep a renderer if the user edited a wrapper that might still refer to it.
      if (ownStatusline) await unlink(rendererFile).catch(() => {});
      return { changed: true, config: path };
    }
    const merged = mergeHooks(cleaned, installed);
    if (JSON.stringify(merged) === JSON.stringify(original) && previous) return { changed: false, config: path };
    await atomicJson(`${path}.term-dad-backup.json`, original);
    if (priorStatusline) await atomicJson(rendererFile, { command: priorStatusline.command });
    // Write ownership before config: after a crash, repeating install removes exact owned entries.
    await atomicJson(manifestPath, {
      version: 1,
      client: options.client,
      installed,
      originalStatusLine: priorStatusline ?? null,
    });
    await atomicJson(path, merged);
    return {
      changed: true,
      config: path,
      note: 'Restart the client and review its hook trust prompts; run hooks doctor and inspect usage.status.',
    };
  } finally {
    if (lease) {
      await lease.close();
      await unlink(`${path}.term-dad.lock`);
    }
  }
}

export async function runHookInstaller(argv: string[]): Promise<number> {
  try {
    const [action, ...rest] = argv;
    const flags = new Map<string, string>();
    for (let i = 0; i < rest.length; i += 2) {
      if (!['--client', '--account', '--config', '--state-dir'].includes(rest[i]) || !rest[i + 1] || flags.has(rest[i]))
        throw new Error('HOOK_ARGUMENT_INVALID');
      flags.set(rest[i], rest[i + 1]);
    }
    const client = providerName.parse(flags.get('--client'));
    const accountRef = usageId.parse(flags.get('--account') ?? 'personal');
    const defaults = {
      claude: join(homedir(), '.claude', 'settings.json'),
      codex: join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json'),
      copilot: join(process.cwd(), '.github', 'hooks', 'term-dad.json'),
    };
    const result = await manageHooks(action, resolve(flags.get('--config') ?? defaults[client]), {
      client,
      accountRef,
      stateDir: resolve(flags.get('--state-dir') ?? stateDirectory()),
      runtime: process.execPath,
      entry: fileURLToPath(new URL('./index.js', import.meta.url)),
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : 'HOOK_INSTALL_FAILED');
    return 1;
  }
}
