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

With multiple WezTerm GUIs, configure the server's `WEZTERM_UNIX_SOCKET` environment
setting to the selected GUI socket as described below. Optional screenshot support
uses `TERM_DAD_SCREENSHOT_COMMAND=/home/zak/personal/term-dad/scripts/screenshot-wsl`.
A successful MCP connection alone does not prove that a terminal endpoint is
selected; verify with `terminal.list`. A socket containing a GUI PID must be updated
if that GUI process restarts. See the official [Claude MCP setup](https://code.claude.com/docs/en/mcp)
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

Managed workers launched with `agent.spawn({cli:"codex", ...})` automatically
receive `$term-dad-worker` and its bundled instructions with their first task.
This also works without installing the skill in the worker's terminal domain.
Follow-ups do not repeat the instructions. When spawning without a prompt, or
after an initial readiness timeout, the first successful `agent.send` supplies
them. Use managed agent tools for Codex workers: raw terminal tools do not apply
this initialization. Claude and shell workers receive their task text unchanged.

## Persistent workers and adoption

Managed workers are saved under `TERM_DAD_STATE_DIR` (default:
`${XDG_STATE_HOME:-$HOME/.local/state}/term-dad`). MCP servers sharing this directory
see the same worker IDs and coordinate managed input. Restarting the MCP client
recovers surviving workers in the same verified GUI instance; it does not relaunch
applications or resume exited CLI conversations. Observations and watches start
fresh after restart.

On Windows/WSL, the bundled host-side helper verifies the GUI process and its
start time. With one running GUI, it discovers the standard socket automatically.
With multiple GUIs, configure `WEZTERM_UNIX_SOCKET` on the MCP server to the chosen
Windows path, typically `C:\Users\<user>\.local\share\wezterm\gui-sock-<PID>`.
Find the GUI PID with PowerShell `Get-Process wezterm-gui`; socket files are under
that user's `.local\share\wezterm` directory. The server forwards the endpoint
explicitly to Windows CLI and screenshot subprocesses. Each server targets one
GUI; saved workers belonging to another instance remain detached. If the GUI
restarts, update the socket configuration and restart the MCP server.

```text
agent.list({})
agent.adopt({"name":"existing-worker","paneId":7,"cli":"codex"})
agent.reattach({"agentId":"existing-worker","paneId":7})
agent.forget({"agentId":"existing-worker"})
```

Choose a real pane ID from `terminal.list`; tabs may contain multiple panes.
Adoption and reattachment send no input. An adopted Codex worker receives its
role instructions with the next task unless `workerSkillInitialized:true` was
specified. `agent.forget` removes only the mapping; `agent.stop` closes the pane.
Where identity verification is unsupported, explicit attachment lasts for the
current server session and must be repeated after restart.

An uncertain submission is never replayed automatically. Inspect the pane and
use `agent.reattach` with `acknowledgeUncertainDelivery:true` and an explicit
`workerSkillInitialized` value before retrying. See [worker recovery and storage
failures](docs/tools.md#persistent-workers) for crash-lock recovery.

## Persistent task board

Track goals, priorities, assignments, dependencies, blockers and acceptance criteria
with `task.create`, `task.get`, `task.list`, `task.update`, `task.assign` and
`task.archive`. Tasks persist alongside worker metadata in `TERM_DAD_STATE_DIR`.

```text
task.create({"boardId":"my-project","title":"Implement feature","goal":"Meet the agreed requirements","priority":"high","acceptanceCriteria":[{"id":"checks","description":"Relevant checks pass"}]})
task.assign({"taskId":"<task UUID>","expectedRevision":1,"agentId":"<worker UUID>"})
task.list({"boardId":"my-project","readyOnly":true})
```

Use returned UUIDs and revisions. Tasks survive worker removal, and concurrent
stale edits are rejected. Worker lists and supervisor snapshots include assigned
task summaries; task reads show attached, detached or missing assignees. Completion
requires an explicit passing verification of the current result, satisfied criteria,
completed dependencies and no blockers.
Use `task.start_attempt`, `task.report_result`, and `task.verify` to record results,
artifacts and checks; `task.history` retains the evidence. Supplied exit codes are
reported evidence, not automatically captured execution results. Existing done tasks
remain explicitly `legacy_unverified` until reopened and verified. Assignment records intent; sending instructions to the worker remains a separate
operation. See [task tools and recovery](docs/tools.md#persistent-task-board).

## Screenshots

Text is the primary observation channel. An optional Windows/WSL provider is included:

```sh
codex mcp add term-dad --env TERM_DAD_SCREENSHOT_COMMAND=/home/zak/personal/term-dad/scripts/screenshot-wsl -- /home/zak/personal/term-dad/scripts/launch-local
```

`terminal.screenshot` and `agent.screenshot` return MCP PNG images. The bundled provider captures the whole WezTerm window and activates the requested pane/tab first. It matches the target GUI window by title, restores it if minimized, and fails when the title is ambiguous. See [screenshot strategy](docs/architecture.md#screenshots).

## Input-aware waits

Use `agent.wait_for_outcome({agentId, turnId})` with the turn ID returned by
`agent.send` to wait for required input, heuristic turn completion, disappearance,
or timeout. Add `quietMs` to also return on unchanged output. Observations expose
`inputRequired`, `readyForPrompt`, and pending permission/question/authentication
requests. Quiet output and prompt readiness never verify task success; permission
requests are never automatically approved. See [tool details](docs/tools.md#input-aware-turn-waits).

## Background watches

Use `watch.create` with a managed `agentId`, or an existing `paneId` plus an explicit
`adapter`, to monitor prompt transitions, input requests, inactivity and disappearance.
Watches never approve prompts or infer task success. Desktop notifications are
opt-in; see [watch tools and Windows/WSL setup](docs/tools.md#background-watches).

Watch events enter a bounded durable metadata queue. Use `event.wait_for_event`
or `event.list` to retrieve them and `event.acknowledge` after handling them.
Pending events replay after restart; watch registrations must be recreated.
Set `TERM_DAD_STATE_DIR` to choose a private local storage directory; see
[queue limits and recovery](docs/tools.md#durable-metadata-events).

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

Read the [tool reference](docs/tools.md), [architecture and observation decision](docs/architecture.md), and [roadmap](docs/roadmap.md).
