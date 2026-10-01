# Repository-owned Term Dad hooks

All active Term Dad helper code and client templates are versioned here. Personal
client configuration contains references to these helpers, not separate copies of
the implementation. The source of generated client templates is
`src/hook-config.ts`; `hooks preview` renders the exact entries for this checkout.

## Inventory

| Purpose | Repository source | Installation/lifetime |
| --- | --- | --- |
| Claude worker Stop, Notification, SessionEnd push | `src/worker-hooks.ts`, `src/term-dad-notify.ts` | Injected by `agent.spawn`; enabled with `push.set` |
| Codex legacy notify lifecycle push | Same files | Existing launch-time `notify` configuration; preserved for surviving workers |
| Supervisor usage context and cooperative pause | `src/usage-hooks.ts`, `src/usage-hook-cli.ts` | `hooks install`; account explicitly selected |
| Claude status-line usage collection | Same usage helper plus `src/usage-providers.ts` | Installed wrapper preserves the previous renderer |
| Conditional resume waiter | `src/usage-hook-cli.ts` | Integration helper; not automatically installed for unverified clients |
| Existing event wake waiter | `src/wait-cli.ts`, `src/event-tools.ts` | Obtain exact invocation with `event.wake_command` |
| Desktop alerts | `src/notifications.ts`, `scripts/notify-wsl.ps1` | Explicit `TERM_DAD_NOTIFICATION_COMMAND` argv configuration |
| Installer and client templates | `src/hook-install.ts`, `src/hook-config.ts` | Explicit preview/install/doctor/uninstall CLI |

Legacy workers may still invoke the notifier with inline `--socket` and `--token`
arguments. Keep that compatibility entrypoint while those panes survive; new
workers use `--credential` and private rotating credential files. Do not manually
copy lifecycle push hooks into a supervisor: they require a worker registration.

Historical test evidence mentions a local missing-Bun Stop hook; it was not
established as a Term Dad-owned hook. Do not remove unrelated client hooks based
on that diagnostic. When migrating an older custom Term Dad hook, first identify
its purpose using this inventory, disable only that exact registration, then
install the replacement. The installer never deletes arbitrary hooks merely
because their command contains the words "Term Dad".

## Install supervisor usage hooks

Configure the account with `usage.configure`, build, then:

```sh
npm run build
node dist/index.js hooks preview --client claude --account claude-personal
node dist/index.js hooks install --client claude --account claude-personal
node dist/index.js hooks doctor --client claude
```

Use `codex` or `copilot` as appropriate. Defaults:

- Claude: `~/.claude/settings.json`.
- Codex: `$CODEX_HOME/hooks.json`, or `~/.codex/hooks.json` when unset.
- Copilot CLI: `<current directory>/.github/hooks/term-dad.json`.

Use `--config /absolute/path` for another profile/project. The installer targets
POSIX/WSL command syntax. Its generated commands quote paths with spaces and
single quotes; Copilot uses executable/argv fields directly. Native Windows
installation is not verified. `--state-dir` must match the MCP server; hooks do
not discover another process's account state automatically.

Restart the client after installation. In Codex, review and trust the installed
definitions using `/hooks`; enable lifecycle hooks in your client configuration
if your version requires it. The installer never bypasses trust. Other client
versions may require equivalent review. Current templates deliver advisory
context; see the [support matrix](usage.md) before expecting automatic control.

`doctor` checks presence and exact entries, not whether a client executed them.
Inspect `usage.status` session registrations after a real tool call to see that
the helper ran. Those registrations also do not prove model compliance or idle
wake support.

## Preservation, updates, and removal

The installer merges only its own entries and records their exact definitions in
`<config>.term-dad.json`. It saves the prior configuration to
`<config>.term-dad-backup.json` before changes. Repeat installation is idempotent;
rerun it after moving this checkout or changing Node installations. Keep these
local metadata files private and outside commits that expose personal settings.

A previous Claude status-line command is saved in a private renderer file. The
wrapper passes it the original stdin and executes that existing trusted command
verbatim through `/bin/sh`; quota parsing never supplies executable shell text.
Renderer output remains the display. Collection failures are diagnostic and do
not replace the existing renderer. Without a renderer, the wrapper displays a
compact quota summary.

```sh
node dist/index.js hooks uninstall --client claude
```

Uninstall removes exact installer-owned entries and restores the previous status
line only when the installed wrapper is still intact. Manually modified hooks are
preserved and reported as missing/changed by doctor. Backups remain for explicit
recovery. Neither `npm run build` nor starting the MCP server installs personal
hooks.
