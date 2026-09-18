import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { instanceSchema, type TerminalInstance } from './worker-storage.js';
import type { execute } from './backend.js';

const guiSchema = instanceSchema.extend({ pid: z.number().int().positive().safe(), title: z.string().max(4096) });
export type GuiInstance = z.infer<typeof guiSchema>;
export interface InstanceResolver {
  (): Promise<TerminalInstance | null>;
  list(): Promise<GuiInstance[]>;
  select(key: string): Promise<TerminalInstance>;
}

/** Host-side identity only. No command is ever injected into a worker pane. */
export function windowsInstance(binary: string, run: typeof execute): InstanceResolver {
  let endpoint = process.env.WEZTERM_UNIX_SOCKET;
  let firstKey: string | undefined;
  let helperPath: Promise<string> | undefined;
  let resolving: Promise<TerminalInstance | null> | undefined;
  let selecting = false;
  const wsl = binary.startsWith('/mnt/') && binary.toLowerCase().endsWith('.exe');
  const supported = wsl || process.platform === 'win32';
  const unsupported = () =>
    new Error(
      'GUI selection is unsupported for this backend; configure TERM_DAD_WEZTERM and WEZTERM_UNIX_SOCKET, then restart the MCP server',
    );
  async function request(action: 'resolve' | 'list' | 'select', key?: string): Promise<unknown> {
    const script = fileURLToPath(new URL('../scripts/instance-windows.ps1', import.meta.url));
    helperPath ??= wsl ? run('wslpath', ['-w', script]).then((s) => s.trim()) : Promise.resolve(script);
    const powershell = wsl ? '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' : 'powershell.exe';
    const windowsBinary = wsl ? (await run('wslpath', ['-w', binary])).trim() : binary;
    return JSON.parse(
      await run(
        powershell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', await helperPath],
        JSON.stringify({ action, endpoint, binary: windowsBinary, key }),
      ),
    );
  }
  const resolver: InstanceResolver = Object.assign(
    async (): Promise<TerminalInstance | null> => {
      if (!supported) return null;
      if (selecting) throw new Error('TERMINAL_BUSY: GUI selection in progress; retry');
      if (resolving) return resolving;
      resolving = (async () => {
        const identity = instanceSchema.parse(await request('resolve'));
        if (firstKey !== undefined && firstKey !== identity.key)
          throw new Error('WezTerm GUI identity changed; list GUI instances and select one explicitly');
        firstKey = identity.key;
        endpoint = identity.endpoint;
        return identity;
      })();
      try {
        return await resolving;
      } finally {
        resolving = undefined;
      }
    },
    {
      async list(): Promise<GuiInstance[]> {
        if (!supported) throw unsupported();
        return z
          .array(guiSchema)
          .max(64)
          .parse(await request('list'));
      },
      async select(key: string): Promise<TerminalInstance> {
        if (!supported) throw unsupported();
        z.string().min(1).max(1024).parse(key);
        if (selecting || resolving) throw new Error('TERMINAL_BUSY: GUI identity operation in progress; retry');
        selecting = true;
        try {
          const identity = instanceSchema.parse(await request('select', key));
          if (identity.key !== key)
            throw new Error('Selected WezTerm GUI identity no longer matches; list GUI instances and retry');
          firstKey = identity.key;
          endpoint = identity.endpoint;
          return identity;
        } finally {
          selecting = false;
        }
      },
    },
  );
  return resolver;
}
