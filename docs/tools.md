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

## Durable metadata events

`event.list`, `event.acknowledge`, and `event.wait_for_event` expose the durable
local event journal. Background watches publish to this queue by default; there
is deliberately no MCP publish/injection tool. Internal producers use
`await events.publish(input)`. The server exposes 32 tools, including the three
watch tools and three event tools.

| Tool | Arguments | Result |
| --- | --- | --- |
| `event.list` | Optional filters below; `includeAcknowledged` (default false), `limit` (1–1000, default 100) | `events` in ascending sequence order, `hasMore`, global `pendingCount`, `capacity`, `storageWarning` |
| `event.acknowledge` | `ids`: 1–100 UUID event IDs | Retained matching `events` with acknowledgment timestamps, plus `unknownIds` |
| `event.wait_for_event` | Optional filters; `timeoutMs` (1–120000, default 30000) | `{status:"event",event}` or `{status:"timeout"}`, `{status:"cancelled"}`, `{status:"closed"}` |

Filters are `paneIds`, `agentIds`, `watchIds`, `kinds` (each 1–64 values), and
`afterSequence` (exclusive). Values within a filter are alternatives; supplied
filters are combined with AND. Omit filters to wait for any pending event.
Listing and waiting never acknowledge or consume events, and multiple waiters
can receive the same event. MCP request cancellation settles the wait; disconnect
settles all waits without touching panes. A timeout conveys no worker outcome.

Events contain only `kind`, `paneId`, optional `watchId`/`agentId`, ISO `occurredAt`,
and a short producer-authored `summary`, plus queue-owned UUID `id`, monotonic
`sequence`, and nullable `acknowledgedAt`. Producers must use static metadata
summaries, never terminal output, prompts, error strings, or secrets. IDs and
summaries are bounded; extra payload fields are rejected.

Pending entries replay after restart. Repeated acknowledgments preserve the
original timestamp. Acknowledged records remain until space is needed; an ID
that has been evicted is reported in `unknownIds` without modifying the journal.
Use `afterSequence` with the last returned sequence to paginate. Sequence values
are never reused within a journal, including after all pending events are acked.

The queue defaults to 1000 retained entries, 64 concurrent waiters and 128 queued
or active storage operations. If pending entries fill capacity, publishing fails
with `EVENT_QUEUE_FULL`; no pending entry is evicted. Producers must surface the
failure and retry after acknowledgment. Excess requests fail with
`EVENT_WAITER_LIMIT` or `EVENT_OPERATION_LIMIT`. Storage lock contention retries
for up to about 200ms and then reports `EVENT_STORAGE_BUSY`; waits retry lock
contention until their own deadline. The 4 MB journal byte limit similarly rejects
writes with `EVENT_STORAGE_SIZE_LIMIT`. Other storage errors fail explicitly.

Set `TERM_DAD_STATE_DIR` to a private directory on a local filesystem. The default
is `$XDG_STATE_HOME/term-dad`, or `~/.local/state/term-dad`. The final directory must
be owned by the current user with mode 0700; journal files use 0600. Unrelated
tools and event reads against an absent directory do not create durable state.
See [architecture](architecture.md#durable-event-journal) for crash recovery.

## Background watches

- `watch.create`: choose exactly one `paneId` or `agentId` (ID or managed name).
  Unmanaged panes require `adapter`: `claude`, `codex`, or `shell`. A pane already
  mapped to a managed worker automatically uses its guarded observations.
  `pollMs`: 500–60,000 (default 2,000); `inactivityMs`: 1,000–3,600,000
  (default 60,000); `cooldownMs`: 0–3,600,000 (default 10,000).
  `notify`: default false; true requires a configured desktop provider.
- `watch.list`: configurations, last classified status, last metadata-only event,
  pending event count, disappearance flag, and safe observation/delivery errors.
- `watch.remove {watchId}`: idempotently remove a watch; never closes a pane.

Example: `watch.create({"agentId":"research","inactivityMs":30000,"notify":true})`.
Create validates pane existence and establishes a baseline. Initial prompt readiness
is suppressed; an initial permission/question screen does produce `input_required`.
`ready` means return to a recognized prompt, **not task success**. `inactive` means
unchanged bounded text, **not task success**, and fires once per quiet episode,
reset by changed text. `pane_disappeared` requires a successful pane listing;
backend errors preserve the watch and retry. Disappeared watches remain listed
until removed, including pending deliveries. Maximum 64 watches per server.

Cooldown spaces successful event deliveries per watch. Transitions queue while
cooling down; repeated pending events of the same kind coalesce (maximum four
pending kinds per watch). Delivery failures remain visible and retry on later
polls; a successful sink is not called again just because desktop delivery failed.
An external sink which accepts an event and then rejects can still cause duplicate
publication on retry; sinks should resolve after acceptance. Removal drops pending
events that have not reached the sink; committed queue events remain available
until acknowledged. Watches themselves are process-local and must be recreated
after restart. MCP disconnect drains in-flight watch delivery before closing the
queue; other undelivered watch transitions are not persisted. Queue overload is
visible in `watch.list.deliveryError` and retries after capacity is acknowledged.
No watch sends input or approves permissions. Polling and desktop delivery
are serial, so configured intervals are minimum delays, not real-time guarantees.

### Opt-in desktop notifications

`TERM_DAD_NOTIFICATION_COMMAND` is a JSON argv array for a trusted local executable.
It receives one metadata-only JSON event on stdin; stdout is discarded. The command
has a five-second timeout and the backend's eight-MiB stdout limit. No shell command
concatenation is used. Configure the environment before starting the MCP server,
then explicitly set `notify:true` when creating a watch.

For this Windows/WSL machine, the bundled PowerShell helper displays a Windows tray
balloon and disposes its icon. Resolve its Windows path before launching the server:

```sh
export TERM_DAD_NOTIFICATION_COMMAND="$(python3 - "$(wslpath -w "$PWD/scripts/notify-wsl.ps1")" <<'PY'
import json, sys
print(json.dumps(['/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
                 '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                 '-File', sys.argv[1]]))
PY
)"
scripts/launch-local
```

Run from the repository root with Node on PATH. This only configures/starts the
server; it does not send a test notification. Windows interoperability and an
interactive desktop must be available; Windows notification settings may suppress
balloons. The process-local execution-policy argument does not change machine
policy. The helper renders fixed messages, never terminal output or event summaries.
It has been supplied with injected-provider tests, not live desktop verification.
