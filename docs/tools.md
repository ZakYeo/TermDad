# MCP tool reference

Tool names use dots. All arguments are JSON objects. Omitted arguments below use defaults. IDs are nonnegative integers; agent IDs may also be unique names. Errors return MCP `isError: true`.

| Tool | Arguments and behavior |
|---|---|
| terminal.list | `{}` → raw pane metadata including window/tab IDs, cwd, dimensions |
| terminal.spawn | `paneId?, windowId?, newWindow?, domain?, cwd?, command?: string[]` → new pane ID in a tab/window |
| terminal.split | `paneId, direction?: right\|bottom, percent?: 1..99, cwd?, command?` → new split pane ID |
| terminal.close | `target?: pane\|tab\|window, id` → kills all selected panes |
| terminal.focus | `target?: pane\|tab\|window, id` → activates matching pane |
| terminal.resize | `paneId, direction: Left\|Right\|Up\|Down, amount?: 1..1000` |
| terminal.move | `paneId, newWindow?, windowId?` → move to new tab |
| terminal.read | `paneId, lines?: 1..5000` (default 100) → text tail |
| terminal.send_text | `paneId, text` → paste without submitting |
| terminal.send_key | `paneId, key` → one raw key |
| terminal.send_keys | `paneId, keys: string[]` → ordered keys, entire sequence validated first |
| terminal.submit | `paneId, text` → paste then Enter |
| terminal.screenshot | `paneId` → MCP PNG image via provider |
| terminal.snapshot | `{}` → panes, 30-line tails and managed agents |
| agent.spawn | `name, cli: claude\|codex\|shell, prompt?, timeoutMs?` plus terminal.spawn options → mapped worker; prompt waits for readiness |
| agent.send | `agentId, text` → submit follow-up to existing worker |
| agent.observe | `agentId, since?: observationId` → compact state and output delta |
| agent.status | Same as observe |
| agent.interrupt | `agentId` → Ctrl+C |
| agent.stop | `agentId` → kill pane and remove mapping |
| agent.screenshot | `agentId` → provider image |
| agent.wait_for_text | `agentId, text, timeoutMs?` → wait for literal substring in recent output |
| agent.wait_until_idle | `agentId, timeoutMs?` → recognized ready/idle state; no silence heuristic |
| agent.broadcast | `agentIds: string[], text` → per-worker send success/error |
| agent.collect_results | `{}` → current observations, no inferred task success |
| orchestrator.status | `{}` → all managed agent observations |

Keys: ENTER, ESC, TAB, UP, DOWN, LEFT, RIGHT, CTRL_C, CTRL_D, CTRL_A, CTRL_E, CTRL_U, BACKSPACE, DELETE, HOME, END. Text is capped at 100,000 characters; key sequences at 100 keys. Wait timeout defaults to 30,000ms, maximum 120,000ms. Screenshots require `TERM_DAD_SCREENSHOT_COMMAND`. `newWindow` and `windowId` are mutually exclusive.

`terminal.close` can close your master session too: select IDs deliberately. Broadcast operates only on explicit agent IDs. Observations can report errors individually in workspace snapshots when panes vanish during polling.
