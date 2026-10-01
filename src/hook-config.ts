import type { HookClient } from './usage-hooks.js';

export type HookConfig = { hooks?: Record<string, any[]>; statusLine?: any; [key: string]: any };
export interface HookInstallOptions {
  client: HookClient;
  accountRef: string;
  stateDir: string;
  entry: string;
  runtime: string;
  rendererFile?: string;
}
export const shellWord = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Canonical client templates: generated absolute paths keep installs portable across checkouts. */
export function hookConfiguration(o: HookInstallOptions): HookConfig {
  const args = [o.entry, 'usage-hook', '--account', o.accountRef, '--client', o.client, '--state-dir', o.stateDir];
  const events =
    o.client === 'copilot'
      ? ['sessionStart', 'postToolUse', 'agentStop', 'sessionEnd']
      : [
          'SessionStart',
          'UserPromptSubmit',
          'PostToolUse',
          'Stop',
          'SessionEnd',
          ...(o.client === 'codex' ? ['Interrupt'] : []),
        ];
  const hooks = Object.fromEntries(
    events.map((event) => {
      const argv = [...args, '--event', event];
      return [
        event,
        o.client === 'copilot'
          ? [{ type: 'command', exec: o.runtime, args: argv, timeoutSec: 5 }]
          : [
              {
                hooks: [
                  {
                    type: 'command',
                    command: [o.runtime, ...argv].map(shellWord).join(' '),
                    timeout: event === 'Interrupt' || event === 'SessionEnd' ? 3 : 5,
                  },
                ],
              },
            ],
      ];
    }),
  );
  // Wake listeners are not installed for advisory-only capabilities. The standalone --wait
  // helper is available to verified integrations; it must never imply automatic support.
  return {
    ...(o.client === 'copilot' ? { version: 1 } : {}),
    hooks,
    ...(o.client === 'claude'
      ? {
          statusLine: {
            type: 'command',
            command: [
              o.runtime,
              ...args,
              '--statusline',
              ...(o.rendererFile ? ['--renderer-file', o.rendererFile] : []),
            ]
              .map(shellWord)
              .join(' '),
          },
        }
      : {}),
  };
}

/** Remove exact entries recorded by this installer, preserving unrelated or manually edited hooks. */
export function removeOwned(config: HookConfig, installed?: HookConfig) {
  const result = structuredClone(config);
  for (const [event, entries] of Object.entries(installed?.hooks ?? {})) {
    const owned = new Set(entries.map((e) => JSON.stringify(e)));
    if (!Array.isArray(result.hooks?.[event])) continue;
    result.hooks![event] = result.hooks![event].filter((e) => !owned.has(JSON.stringify(e)));
    if (!result.hooks![event].length) delete result.hooks![event];
  }
  return result;
}

export function mergeHooks(config: HookConfig, installed: HookConfig) {
  const result = structuredClone(config);
  result.hooks ??= {};
  for (const [event, entries] of Object.entries(installed.hooks ?? {})) {
    if (result.hooks[event] !== undefined && !Array.isArray(result.hooks[event]))
      throw new Error('HOOK_CONFIG_INVALID');
    result.hooks[event] = [...(result.hooks[event] ?? []), ...entries];
  }
  if (installed.statusLine) result.statusLine = installed.statusLine;
  if (installed.version !== undefined) result.version ??= installed.version;
  return result;
}
