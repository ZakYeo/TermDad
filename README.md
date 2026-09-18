# Term Dad

A local TypeScript MCP server that lets one master agent create and supervise visible interactive workers in WezTerm. Every terminal operation uses the existing WezTerm GUI/mux CLI, so tabs, splits, typing and worker output appear in your terminal.

## Try it

Requires Node.js 22+, a running WezTerm GUI, and locally installed/authenticated Claude or Codex for those workers.

```sh
npm ci
npm run build
codex mcp add term-dad -- /home/zak/personal/term-dad/scripts/launch-local
```

Restart the Codex session after adding the server. Ask it: “Use term-dad to list my terminal panes, start a shell worker in a new tab, run `pwd`, and show its output.” The command syntax follows the [official Codex MCP documentation](https://developers.openai.com/codex/mcp/).

The local launcher resolves Claude and Codex from your PATH, including npm-installed Codex under nvm. Claude workers inherit that PATH so local hook runtimes such as Bun remain available in GUI-spawned panes. For another checkout, replace the absolute path. No global npm install is required. Any stdio MCP client can use `node` with the absolute `dist/index.js` argument. Avoid `npm start` as the MCP launch command: npm can print banners to stdout. Server diagnostics go to stderr.

WezTerm is detected as `wezterm` or the standard Windows installation at `/mnt/c/Program Files/WezTerm/wezterm.exe` when running in WSL. Set `TERM_DAD_WEZTERM` to override. Run the server with access to your desktop/WSL interoperability; a sandbox that blocks Windows process execution cannot reach the GUI.

Example tool calls (JSON arguments):

```text
terminal.list({})
agent.spawn({"name":"research","cli":"claude","paneId":0,"cwd":"/home/zak/personal/term-dad","prompt":"Summarize this project's purpose without modifying files."})
agent.observe({"agentId":"research"})
agent.send({"agentId":"research","text":"Now suggest one useful next feature."})
agent.observe({"agentId":"research","since":"<observationId>"})
agent.interrupt({"agentId":"research"})
agent.stop({"agentId":"research"})
```

Use an actual pane ID from `terminal.list`. `paneId` on spawn selects the parent domain/window; the worker opens in a new tab. Use `terminal.split` for a split. A `command` argv array overrides the executable, for example `["/home/zak/.local/bin/claude"]`. Paths and commands refer to the target WezTerm domain, which may differ from the server host.

New WSL panes on this machine do not load nvm. The local launcher handles this automatically. If launching `node dist/index.js` directly, configure worker argv explicitly (or supply `command` to `agent.spawn`):

```sh
codex mcp add term-dad \
  --env 'TERM_DAD_CLAUDE_COMMAND=["/home/zak/.local/bin/claude"]' \
  --env 'TERM_DAD_CODEX_COMMAND=["/home/zak/.nvm/versions/node/v22.14.0/bin/node","/home/zak/.nvm/versions/node/v22.14.0/lib/node_modules/@openai/codex/bin/codex.js"]' \
  --env TERM_DAD_SCREENSHOT_COMMAND=/home/zak/personal/term-dad/scripts/screenshot-wsl \
  -- node /home/zak/personal/term-dad/dist/index.js
```

The local launcher assumes workers run on this host; for remote domains, supply target-domain commands instead.

`TERM_DAD_CLAUDE_COMMAND`, `TERM_DAD_CODEX_COMMAND`, and `TERM_DAD_SHELL_COMMAND` accept JSON argv arrays. Explicit per-spawn commands take precedence. Adjust paths if Node or your CLI installation changes.


If startup stops at a trust, login, or permission screen, `agent.spawn` with a prompt times out with the agent ID and pane ID; the pane stays open. Observe it and use `terminal.send_key` to interact deliberately, then `agent.send`. The server never automatically approves these screens. Spawn without a prompt to manage onboarding yourself.

## Claude Code setup

Term Dad also works with Claude Code as both the supervisor MCP client and a
visible managed worker. Register the server for all local projects:

```sh
claude mcp add --scope user term-dad -- /home/zak/personal/term-dad/scripts/launch-local
mkdir -p "$HOME/.claude/skills"
ln -s /home/zak/personal/term-dad/skills/term-dad "$HOME/.claude/skills/term-dad"
ln -s /home/zak/personal/term-dad/skills/term-dad-worker "$HOME/.claude/skills/term-dad-worker"
claude mcp get term-dad
```

In a fresh Claude Code session, invoke `/term-dad` for the supervisor role or
`/term-dad-worker` for a delegated worker. Use `agent.spawn` with `cli:"claude"`
to start a visible Claude worker. Claude receives task text unchanged, so invoke
`/term-dad-worker <assignment>` explicitly when its role is needed; automatic
first-task role embedding currently applies to Codex workers only.

With multiple WezTerm GUIs, inherit the containing GUI's socket using the
[WSL configuration below](#selecting-the-containing-wezterm-gui-in-wsl), or configure
the server's `WEZTERM_UNIX_SOCKET` explicitly. Optional screenshot support
uses `TERM_DAD_SCREENSHOT_COMMAND=/home/zak/personal/term-dad/scripts/screenshot-wsl`.
A successful MCP connection alone does not prove that a terminal endpoint is
selected; verify with `terminal.list`. An explicitly configured socket containing a GUI PID must be updated
if that GUI process restarts; new panes inherit the current socket automatically. See the official [Claude MCP setup](https://code.claude.com/docs/en/mcp)
and [personal skills](https://code.claude.com/docs/en/skills) documentation.

## Supervisor and worker skills

The bundled `skills/term-dad` and `skills/term-dad-worker` directories are
installable Codex and Claude Code skills. For Codex, to make them available across local repositories,
symlink each directory into `${CODEX_HOME:-$HOME/.codex}/skills` (or copy them
there). For this checkout:

```sh
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -s /home/zak/personal/term-dad/skills/term-dad "${CODEX_HOME:-$HOME/.codex}/skills/term-dad"
ln -s /home/zak/personal/term-dad/skills/term-dad-worker "${CODEX_HOME:-$HOME/.codex}/skills/term-dad-worker"
```

Invoke `$term-dad`, or ask “Activate TermDad” / “You are the TermDad”. The
supervisor delegates outcomes and constraints while workers own implementation.
Restart Codex if the newly installed skills do not appear.

Managed Codex workers receive `$term-dad-worker` and its bundled instructions
with their first submitted task, so the skill need not be installed in the
worker's terminal domain; Claude and shell workers receive their task text
unchanged. See [lifecycle](docs/architecture.md#lifecycle-and-failures).

## Selecting the containing WezTerm GUI in WSL

Term Dad uses the `WEZTERM_UNIX_SOCKET` inherited from its supervisor process.
For Windows WezTerm with WSL panes, forward that variable across the WSL boundary
so multiple GUI processes can each host their own supervisor without fixed PIDs.
Add this to your Windows `.wezterm.lua`, before `return config` (merge with any
existing `set_environment_variables` entries):

```lua
config.set_environment_variables = {
  WSLENV = (os.getenv 'WSLENV' or '') .. ':WEZTERM_UNIX_SOCKET:WEZTERM_PANE',
}
```

Keep the socket as a Windows path: do not add the WSLENV `/p` flag. WezTerm supplies
the socket and pane values for each new pane. Preserve any additional WSLENV entries
in your existing configuration. Open a new WSL pane after the config reload and
launch the supervisor there; existing shells and MCP servers retain their old
environment. Remove fixed `WEZTERM_UNIX_SOCKET` overrides from the MCP registration
or shell startup files if you want the containing GUI to be selected automatically.

Check in the new shell with `printenv WEZTERM_UNIX_SOCKET WEZTERM_PANE`, then use
`terminal.list` from the supervisor.

## Selecting and switching GUIs

Without an inherited socket, or when the inherited socket belongs to a GUI that
has exited, Term Dad selects a running GUI automatically: the only live GUI, the foreground WezTerm GUI, or the most recently started GUI if
another application is foreground. The selected process stays pinned even when
focus changes or the GUI exits. Pane IDs alone do not identify a GUI.

Use `terminal.list_instances({})` to see running Windows/WSL GUIs and the selected
identity, then `terminal.select_instance({"key":"<exact returned key>"})` to switch
this MCP server without restarting it. Remove watches and let active tool calls
finish first; recreate watches for the new target. Switching sends no input and
keeps worker panes and mappings intact. Workers from other GUIs remain detached.
Selections last for this server session; an inherited socket still takes precedence
when a new server starts.

## Persistent workers and adoption

Managed workers are saved under `TERM_DAD_STATE_DIR` (default:
`${XDG_STATE_HOME:-$HOME/.local/state}/term-dad`). Servers sharing this directory
see the same worker IDs and coordinate managed input. Restarting the MCP client
recovers surviving workers in the same verified GUI instance; it does not relaunch
applications, and observations and watches start fresh.

On Windows/WSL the bundled host-side helper verifies the GUI process and start
time. With one GUI it discovers the socket automatically; with several, inherit
`WEZTERM_UNIX_SOCKET` as described above or configure the chosen Windows path
(`C:\Users\<user>\.local\share\wezterm\gui-sock-<PID>`; find the PID with
`Get-Process wezterm-gui`). Each server targets one GUI; workers in another remain
detached. If the GUI restarts, launch the supervisor from a new pane or update the
explicit socket, then restart the MCP server.

```text
agent.list({})
agent.adopt({"name":"existing-worker","paneId":7,"cli":"codex"})
agent.reattach({"agentId":"existing-worker","paneId":7})
agent.forget({"agentId":"existing-worker"})
```

Adoption and reattachment send no input; `agent.forget` removes only the mapping
and `agent.stop` closes the pane. An uncertain submission is never replayed
automatically. See [persistent workers](docs/tools.md#persistent-workers) for
`workerSkillInitialized`, uncertain-delivery acknowledgment and crash-lock recovery.

## Persistent task board

Track goals, priorities, assignments, dependencies, blockers and acceptance criteria
with the `task.*` tools; record attempts, results and verification with
`task.start_attempt`, `task.report_result`, `task.verify` and `task.history`.
Tasks persist alongside worker metadata in `TERM_DAD_STATE_DIR`, survive worker
removal, reject stale concurrent edits, and are never completed from terminal
readiness or silence.

```text
task.create({"boardId":"my-project","title":"Implement feature","goal":"Meet the agreed requirements","priority":"high","acceptanceCriteria":[{"id":"checks","description":"Relevant checks pass"}]})
task.assign({"taskId":"<task UUID>","expectedRevision":1,"agentId":"<worker UUID>"})
task.list({"boardId":"my-project","readyOnly":true})
```

`orchestrator.attention` joins worker observations to the task graph for
decisions, dispatch eligibility and changes since a cursor. See the
[task board](docs/tools.md#persistent-task-board), [completion
reporting](docs/tools.md#completion-reporting-and-verification) and
[attention](docs/tools.md#task-focused-attention) references.

## Screenshots

Text is the primary observation channel. An optional Windows/WSL provider is included:

```sh
codex mcp add term-dad --env TERM_DAD_SCREENSHOT_COMMAND=/home/zak/personal/term-dad/scripts/screenshot-wsl -- /home/zak/personal/term-dad/scripts/launch-local
```

`terminal.screenshot` and `agent.screenshot` return MCP PNG images. The bundled provider captures the whole WezTerm window and activates the requested pane/tab first. It matches the target GUI window by title, restores it if minimized, and fails when the title is ambiguous. See [screenshot strategy](docs/architecture.md#screenshots).

## Waits, watches and pushed events

`agent.wait_for_outcome({agentId, turnId})` waits for required input, heuristic
turn completion, optional quiet output, disappearance or timeout; prompt
readiness and quiet output never verify success, and permission requests are
never approved automatically. See [input-aware waits](docs/tools.md#input-aware-turn-waits).

`watch.create` monitors a managed worker or an unmanaged pane for prompt
transitions, input requests, inactivity, disappearance and `attention_required`
(a person is needed). Events enter a bounded durable journal read through
`event.list`, `event.wait_for_event` and `event.acknowledge`; pending events
replay after restart, watches must be recreated. To be woken while idle, run the
command from `event.wake_command` as a detached background process. See
[watches](docs/tools.md#background-watches), [events](docs/tools.md#durable-metadata-events)
and [waking an idle supervisor](docs/tools.md#waking-an-idle-supervisor).

Push is off for every pane until `push.set` enables it. A Claude or Codex worker
then reports its own input requests and turn ends over a local owner-only socket,
each verified by sampling the pane; `enabled` is intent and `proven` is the only
evidence a hook has fired. Shell workers always poll. See
[worker-pushed events](docs/tools.md#worker-pushed-events).

## Development and tests

```sh
npm run check          # TypeScript build + unit and stdio protocol tests
npm run test:recovery  # MCP restart, stable worker mapping, adoption and cleanup
npm run test:live      # Actual WezTerm + MCP shell/layout/interrupt round trip
npm run test:agent -- claude  # Actual authenticated Claude, two short prompts
npm run test:agent -- codex   # Actual authenticated Codex, two short prompts
npm run test:screenshot      # Actual Windows/WSL screenshot returned through MCP
```

Live tests use private temporary state directories, open visible tabs, and clean up only panes they created. Set `TERM_DAD_TEST_PANE` to select a parent pane; with multiple GUIs, also set `WEZTERM_UNIX_SOCKET` as described above. Agent tests use your CLI account and can incur usage. They do not ask workers to edit files. Captured UI fixtures are overwritten only when `TERM_DAD_CAPTURE_FIXTURES=1` is set. Unit tests use an injected CLI runner; the live tests use the real stdio MCP server and real WezTerm. Run tests outside a sandbox that blocks subprocess pipes or WSL interoperability. See [test evidence](docs/testing.md).

## Limitations and security

This is a personal proof of concept. Tool access grants terminal command execution as your user, including entering text into existing applications and killing processes. Connect only trusted local MCP clients. Terminal output is untrusted data and may contain prompt injection or secrets. Review worker permissions normally; do not treat worker output as instructions to approve actions.

Worker mappings persist in a private shared journal; worker panes stay alive across MCP disconnects. Automatic reattachment requires a verified terminal instance. Maximum 64 managed agents, 16 observations per agent, 24,000 characters per observation. No task completion guarantee: detected readiness is a heuristic, and unchanged text never proves success. UI revisions and echoed prompts can confuse classifiers. WezTerm's CLI does not expose reliable foreground process metadata on every platform; missing values are `null`.

Key injection uses standard VT bytes, not global shortcuts. Apps using application cursor mode or extended keyboard protocols may need a custom key mapping. Focus activates the mux pane; OS foreground behavior varies. Movement currently supports moving to a new tab/window. Screenshots on Linux/macOS require your own provider executable. No remote transport, credentials, application relaunch, or push destination is configured.

Worker-pushed events are local only and carry a token and kind, never event text. Workers run as your user, so credential files are not an isolation boundary between them; a push is therefore verified by sampling the pane and never treated as evidence of task success.

Read the [tool reference](docs/tools.md), [architecture and observation decision](docs/architecture.md), and [roadmap](docs/roadmap.md).
