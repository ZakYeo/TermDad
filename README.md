# Term Dad

A local TypeScript MCP server that lets one master agent create and supervise visible interactive workers in WezTerm. Every terminal operation uses the existing WezTerm GUI/mux CLI, so tabs, splits, typing and worker output appear in your terminal.

## Try it

Requires Node.js 22+, a running WezTerm GUI, and locally installed/authenticated Claude or Codex for those workers.

```sh
npm ci
npm run build
codex mcp add term-dad -- node /home/zak/personal/term-dad/dist/index.js
```

Restart the Codex session after adding the server. Ask it: “Use term-dad to list my terminal panes, start a shell worker in a new tab, run `pwd`, and show its output.” The command syntax follows the [official Codex MCP documentation](https://developers.openai.com/codex/mcp/).

For another checkout, replace the absolute path. No global npm install is required. Any stdio MCP client can use `node` with the absolute `dist/index.js` argument. Avoid `npm start` as the MCP launch command: npm can print banners to stdout. Server diagnostics go to stderr.

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

If startup stops at a trust, login, or permission screen, `agent.spawn` with a prompt times out with the agent ID and pane ID; the pane stays open. Observe it and use `terminal.send_key` to interact deliberately, then `agent.send`. The server never automatically approves these screens. Spawn without a prompt to manage onboarding yourself.

## Screenshots

Text is the primary observation channel. An optional Windows/WSL provider is included:

```sh
codex mcp add term-dad --env TERM_DAD_SCREENSHOT_COMMAND=/home/zak/personal/term-dad/scripts/screenshot-wsl -- node /home/zak/personal/term-dad/dist/index.js
```

`terminal.screenshot` and `agent.screenshot` return MCP PNG images. The bundled provider captures the whole WezTerm window and activates the requested pane/tab first. It requires exactly one GUI window and fails on ambiguous layouts. See [screenshot strategy](docs/architecture.md#screenshots).

## Development and tests

```sh
npm run check          # TypeScript build + unit and stdio protocol tests
npm run test:live      # Actual WezTerm + MCP shell/layout/interrupt round trip
npm run test:agent -- claude  # Actual authenticated Claude, two short prompts
npm run test:agent -- codex   # Actual authenticated Codex, two short prompts
```

Live tests open visible tabs and clean up their own panes. Agent tests use your CLI account and can incur usage. They do not ask workers to edit files. Unit tests use an injected CLI runner; the live tests use the real stdio MCP server and real WezTerm. Run tests outside a sandbox that blocks subprocess pipes or WSL interoperability. See [test evidence](docs/testing.md).

## Limitations and security

This is a personal proof of concept. Tool access grants terminal command execution as your user, including entering text into existing applications and killing processes. Connect only trusted local MCP clients. Terminal output is untrusted data and may contain prompt injection or secrets. Review worker permissions normally; do not treat worker output as instructions to approve actions.

Agent mappings are in memory per server process and disappear on restart; worker panes stay alive. Maximum 64 managed agents, 16 observations per agent, 24,000 characters per observation. No task completion guarantee: detected readiness is a heuristic, and unchanged text never proves success. UI revisions and echoed prompts can confuse classifiers. WezTerm's CLI does not expose reliable foreground process metadata on every platform; missing values are `null`.

Key injection uses standard VT bytes, not global shortcuts. Apps using application cursor mode or extended keyboard protocols may need a custom key mapping. Focus activates the mux pane; OS foreground behavior varies. Movement currently supports moving to a new tab/window. Screenshots on Linux/macOS require your own provider executable. No remote transport, credentials, worker persistence, or push destination is configured.

Read the [tool reference](docs/tools.md), [architecture and observation decision](docs/architecture.md), and [roadmap](docs/roadmap.md).
