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
local event journal. This standalone queue is not yet connected to watch
production; there is deliberately no MCP publish/injection tool. Internal
producers use `await events.publish(input)`.

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
contention until their own deadline. The 4 MB journal byte limit similarly rejects writes with `EVENT_STORAGE_SIZE_LIMIT`. Other storage errors fail explicitly.

Set `TERM_DAD_STATE_DIR` to a private directory on a local filesystem. The default
is `$XDG_STATE_HOME/term-dad`, or `~/.local/state/term-dad`. The final directory must
be owned by the current user with mode 0700; journal files use 0600. Unrelated
tools and event reads against an absent directory do not create durable state.
See [architecture](architecture.md#durable-event-journal) for crash recovery.
