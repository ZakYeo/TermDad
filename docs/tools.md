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
| agent.spawn | `name, cli: claude\|codex\|shell, prompt?, timeoutMs?` plus terminal.spawn options → mapped worker; prompt waits for readiness; first Codex task includes the worker skill |
| agent.list | `{}` → saved metadata, attachment state, recovery reason and storage warning; no terminal text |
| agent.adopt | `name, paneId, cli, workerSkillInitialized?` → register an existing pane; no input sent |
| agent.reattach | `agentId, paneId, acknowledgeUncertainDelivery?, workerSkillInitialized?` → explicitly bind a saved worker; no input sent |
| agent.forget | `agentId` → remove mapping without closing pane |
| agent.send | `agentId, text` → submit task; includes the worker skill on the first Codex task if deferred at spawn |
| agent.observe | `agentId, since?: observationId` → compact state and output delta |
| agent.status | Same as observe |
| agent.interrupt | `agentId` → Ctrl+C |
| agent.stop | `agentId` → kill pane and remove mapping |
| agent.screenshot | `agentId` → provider image |
| agent.wait_for_text | `agentId, text, timeoutMs?` → wait for literal substring in recent output |
| agent.wait_for_outcome | `agentId, turnId, timeoutMs?, quietMs?` → input required, heuristic turn finished, optional quiet output, disappearance, or timeout |
| agent.wait_until_idle | `agentId, timeoutMs?` → recognized ready/idle state; no silence heuristic |
| agent.broadcast | `agentIds: string[], text` → per-worker send success/error |
| agent.collect_results | `{}` → current observations, no inferred task success |
| orchestrator.status | `{}` → observations for attached workers and metadata for detached workers |

Keys: ENTER, ESC, TAB, UP, DOWN, LEFT, RIGHT, CTRL_C, CTRL_D, CTRL_A, CTRL_E, CTRL_U, BACKSPACE, DELETE, HOME, END. Text is capped at 100,000 characters; key sequences at 100 keys. Wait timeout defaults to 30,000ms, maximum 120,000ms. Screenshots require `TERM_DAD_SCREENSHOT_COMMAND`. `newWindow` and `windowId` are mutually exclusive.

`terminal.close` can close your master session too: select IDs deliberately. Broadcast operates only on explicit agent IDs. Observations can report errors individually in workspace snapshots when panes vanish during polling.

## Persistent workers

The MCP server uses `workers.json` under the same private `TERM_DAD_STATE_DIR` as
the event journal. The journals and locks are separate. A shared directory has a
maximum of 64 saved workers, including incomplete spawn reservations. Names are
unique; panes cannot have competing mappings in the same identified instance.
Use different state directories for unrelated environments with unverified identity.
Names are metadata: do not put secrets in them.

`agent.list` returns `{agentId,name,paneId,cli,attachment,recoveryReason,
deliveryPending,workerSkillInitialized,storageWarning}` for each saved worker.
`attachment` is `attached` or `detached`; a reservation has `paneId:null`.
Listing checks the selected backend and reconciles confirmed missing panes.
Transport failure or identity mismatch preserves saved records. Worker IDs and
names survive restart; terminal output, observation IDs and watches do not.
An old `since` observation ID produces a full replacement with `deltaReset:true`.

Automatic recovery requires a matching terminal endpoint and process identity.
Windows/WSL uses the bundled `scripts/instance-windows.ps1` helper; set the MCP
server's `WEZTERM_UNIX_SOCKET` when multiple GUIs are running. The endpoint must
be a local GUI socket named `gui-sock-PID`. Other platforms currently have no
automatic identity provider: spawn/adopt work for that server session, and the
next session requires explicit reattachment. Unreachable Windows endpoints must
be corrected before reattachment. No title/cwd/text matching or CLI relaunch occurs.

`agent.adopt` requires a live pane and an explicit `claude`, `codex` or `shell`
adapter. It creates a new ID. `workerSkillInitialized` defaults to false; for
Codex this schedules role instructions with the next `agent.send`, never during
adoption. `agent.reattach` preserves the saved ID, name and adapter, and rejects
occupied targets. It invalidates observation history; recreate existing watches
following reattachment. On a changed binding, old input hashes are cleared.
Skill state is preserved unless `workerSkillInitialized` is supplied.

Managed input/lifecycle operations use exclusive per-worker locks. A concurrent
operation returns `WORKER_BUSY`; retry after the active operation finishes. Raw
terminal tools remain explicit low-level operations and do not acquire these
input locks. `WORKER_DELIVERY_UNCERTAIN` means a paste, Enter or interrupt may
have reached the pane even though completion could not be recorded. Further
managed input is blocked. Inspect with observation or raw terminal reads, then:

```text
agent.reattach({"agentId":"worker","paneId":7,"acknowledgeUncertainDelivery":true,"workerSkillInitialized":true})
```

Choose the skill flag based on what actually reached Codex; false initializes on
the next task. The acknowledgment itself never repeats input. Successful input
followed by a failed storage commit has the same uncertain outcome.

A rejected or lost spawn response returns `WORKER_SPAWN_UNCERTAIN` and preserves
the reservation, because the pane may already exist. Inspect before forgetting
the reservation or adopting a surviving pane.

If spawn succeeds but recording the pane fails, the error supplies its pane ID
and reservation ID. Inspect the pane, forget the incomplete reservation, then
adopt it. A crash between spawn and recording can leave only the reservation;
use `terminal.list` to identify the surviving pane explicitly. Do not blindly
repeat spawn. Forgetting never closes a pane; successful stop removes its mapping.

Corrupt, oversized or unsafe journals raise `WORKER_STATE_CORRUPT` or
`WORKER_STORAGE_UNSAFE`; preserve the file and recover explicitly. Atomic rename
is the commit point; a later directory-sync failure appears in `storageWarning`
without treating the committed action as failed. A crash can leave `workers.lock`,
`worker-<UUID>.lock`, or `workers.<UUID>.tmp`. Stop **all** servers sharing the
directory, preserve `workers.json`, remove stale locks/orphan temporaries, and
restart. Locks are never stolen on a timer. Resolve any uncertain-delivery marker
through explicit reattachment afterward. Storage targets private local POSIX
filesystems, including WSL; disconnect never kills worker panes.

## Durable metadata events

`event.list`, `event.acknowledge`, and `event.wait_for_event` expose the durable
local event journal. Background watches publish to this queue by default; there
is deliberately no MCP publish/injection tool. Internal producers use
`await events.publish(input)`. The server exposes 47 tools, including the three
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

## Persistent task board

The production server registers six task tools backed by `tasks.json` in
`TERM_DAD_STATE_DIR` (default `${XDG_STATE_HOME:-$HOME/.local/state}/term-dad`).
Tasks and stable worker assignments survive MCP restarts. Tasks are independent
of worker lifetime and are never completed from terminal readiness or silence.
See the [task-board contract](plans/persistent-task-board.md).

| Tool | Inputs and behavior |
| --- | --- |
| `task.create` | Required `boardId`, `title`, `goal`; optional `priority`, `assignedAgentId`, `dependencies`, `blockers`, `acceptanceCriteria`. Creates a `todo` task at revision 1. |
| `task.get` | `taskId`; returns the task even when archived, plus `blocked`, `unresolvedDependencyIds` and `ready`. |
| `task.list` | Optional `boardId`, `assignedAgentId` (null means unassigned), `status`, `priority`, `readyOnly`, `includeArchived`, `offset` and `limit`. Filters combine with AND. Returns `tasks`, `total`, `nextOffset` and `storageWarning`. |
| `task.update` | `taskId`, `expectedRevision`, nonempty `patch`. Editable fields are title, goal, priority, assignment, dependencies, blockers, criteria and status. Arrays replace previous values. |
| `task.assign` | `taskId`, `expectedRevision`, `agentId` (worker UUID or null). Records assignment without worker lookup or terminal input. |
| `task.archive` | `taskId`, `expectedRevision`, `archived` boolean. Hides/restores the record without deleting it or satisfying dependencies. |

Priorities sort urgent, high, normal, low, then creation timestamp and task UUID.
Lists default to 50 results, cap at 100, and omit archived tasks. Offset pagination
is not a stable snapshot while other clients edit tasks. Criteria are objects with
`id`, `description`, optional `satisfied` (default false), and optional `evidence`.

Statuses are `todo`, `in_progress`, `done`, `cancelled`. Completion is explicit and
requires passing verification of the current report, satisfied criteria, completed dependencies and no blockers. Setting criterion booleans alone cannot complete a task. Task readiness
means an unblocked, unarchived `todo` record; terminal readiness is unrelated.
Archived tasks must be restored before editing. Missing workers never delete tasks.
A revision conflict requires rereading the task before retrying the intended change.

`task.get` and `task.list` add an `assignment` snapshot: null for unassigned tasks,
otherwise the worker UUID, name, pane ID, availability (`attached`, `detached`,
`missing`, or `unknown`) and recovery reason. Unknown means the worker registry
could not be read. Detached includes unresolved spawn reservations and unavailable
terminal identity/transport. These reads may reconcile disappeared worker mappings
through `agent.list`; they never dispatch input or change task records. Assignment
writes only record the supplied UUID and do not promise worker availability.

`agent.list`, `orchestrator.status`, `agent.collect_results` and the agents inside
`terminal.snapshot` include `tasks`: total unarchived assignments, up to 20 compact
items sorted by priority (including `currentAttemptId`, `reportedOutcome`, and
`verificationStatus`), a `truncated` flag and `storageWarning`. Use
`task.list({assignedAgentId:"<uuid>"})` to page through full details. If task storage
cannot be read, worker views remain available with `total:null` and
`TASK_SUMMARY_UNAVAILABLE`; `task.list` exposes the underlying error.

Every write validates the full dependency graph under the task journal lock.
Concurrent stale updates fail with `TASK_REVISION_CONFLICT`; reread before retrying.
There are at most 1,000 tasks (archived included), 4 MB of state, 100 dependencies,
50 blockers and 50 criteria per task. Capacity errors preserve all existing tasks;
archiving does not reclaim capacity. No automatic purge or dispatch is provided.

The state directory must be private (0700), and `tasks.json` is written as 0600.
Atomic replacement and directory sync follow the worker/event journal contract.
`TASK_STATE_CORRUPT` preserves damaged state for explicit recovery; never delete it
to suppress an error. A post-commit sync failure succeeds but sets a
`TASK_DURABILITY_WARNING` on subsequent lists; power-loss durability is uncertain.
`TASK_STORAGE_BUSY` may be temporary contention. For a confirmed crash, stop all
servers using the directory, preserve `tasks.json`, and only then remove stale
`tasks.lock` and orphan `tasks.*.tmp` files. No time-based lock stealing occurs.
Tasks, workers and events are separate journals, so their views are not one atomic
snapshot. Task text and evidence are explicit stored content; treat them as
untrusted, and do not include secrets or automatically copy terminal output.


## Completion reporting and verification

Output activity, worker interaction, reported task outcome, and verification are
independent. Quiet output does not imply a finished turn; a finished turn does not
imply a successful or verified task. Reports and decisions are explicit supplied
content, never automatically extracted from terminal text.

| Tool | Inputs and behavior |
| --- | --- |
| `task.start_attempt` | `taskId, expectedRevision`. Requires an assigned worker UUID and an editable task. Records the goal/criteria/dependencies and starts `in_progress`; supersedes earlier attempts without dispatching input. |
| `task.report_result` | `taskId, expectedRevision, attemptId`, plus the report fields below. Only the current attempt can report. Replaces the current result by appending history and makes earlier verification stale. |
| `task.verify` | `taskId, expectedRevision, attemptId, reportId, workVersion, result, rationale, criteria, complete?`. Records a decision against the current report; `complete:true` atomically marks the task done when verification passes. |
| `task.history` | `taskId, offset?, limit?` (default 5, maximum 20). Returns full attempts with reports and decisions, total, nextOffset and current revision. |

Report fields are `outcome` (`succeeded`, `failed`, `blocked`, `cancelled`),
`summary`, `workVersion`, `provenance` (`worker_reported`, `supervisor_recorded`),
`artifacts`, and `checks`. A work version should identify the commit plus any
relevant working-tree changes, or the equivalent artifact version for other work.
Each artifact has `kind` (`file`, `commit`, `pull_request`, `other`), `reference`,
and `context` identifying its domain/repository. References are not fetched.
Each check has `id`, `criterionIds`, `execution`, `context`, nullable ISO `startedAt` and
`finishedAt`, `result` (`passed`, `failed`, `skipped`), nullable integer `exitCode`,
an `evidence` reference array, and `provenance`. Exit codes belong to executions;
unknown codes and execution times stay null. This release does not capture commands or exit codes
itself, and cannot attest that supplied evidence is true.

Verification `result` is `passed`, `failed`, or `inconclusive`. Each entry in
`criteria` has `criterionId`, `result`, and a nonempty `evidence` reference array.
Passing requires a succeeded report without failed checks, one passing decision
for every criterion, resolved dependencies and no blockers. A rationale is always
required, including for tasks without criteria. Skipped checks do not themselves
establish criterion satisfaction. A passing decision updates criterion evidence;
`task.update(status:"done")` uses the same gate as `task.verify(complete:true)`.

Task reads include `currentAttemptId`, compact `currentAttempt`, `latestReport`,
and `verification` summaries. Verification status is `unverified`, `passed`,
`failed`, `inconclusive`, `stale`, or `legacy_unverified`. Full evidence appears
only in `task.history`. A new attempt, report, changed requirements, changed
blockers, reassignment, cancellation, or reopening invalidates current verification.
Title, priority and archival preserve it. Completed tasks must be reopened before
invalidating edits; reopen dependents before their completed prerequisites.
External file edits are not monitored: verification covers only the recorded work
version. Failed or blocked reports leave task lifecycle status unchanged.

Attempts are capped at 20 per task, with 20 reports and 20 verification decisions
per attempt and 50 artifacts/checks per report. The existing 4 MB global bound
still applies; capacity errors never purge evidence. Archived history counts.
Old version-1 task journals are validated and migrated in memory on reads, and
written as version 2 on the next successful mutation. Existing done tasks remain
`legacy_unverified` and continue satisfying dependencies; reopening requires the
new verification workflow. Old server versions cannot read version-2 journals;
restart all clients on the new build before making writes.

Example workflow (use returned UUIDs and revisions at every step):

```text
task.assign({taskId, expectedRevision, agentId})
task.start_attempt({taskId, expectedRevision})
agent.send({agentId, text:"Implement the assigned outcome", attempt:{taskId, attemptId}})
agent.wait_for_outcome({agentId, turnId, timeoutMs:30000})
task.report_result({taskId, expectedRevision, attemptId, outcome:"succeeded", summary:"Implemented and checked", workVersion:"commit:<sha>", provenance:"worker_reported", artifacts:[], checks:[]})
task.verify({taskId, expectedRevision, attemptId, reportId, workVersion:"commit:<sha>", result:"passed", rationale:"Reviewed the outcome", criteria:[{criterionId:"checks", result:"passed", evidence:["reviewed check log"]}], complete:true})
```

### Input-aware turn waits

Managed `agent.send` and prompted `agent.spawn` return `turnId`; observations and
worker lists expose it. Every managed text submission gets a fresh durable ID
before delivery, including follow-ups. `agent.send` optionally accepts
`attempt:{taskId,attemptId}` and checks current assignment before sending. Task
validation and terminal delivery are separate transactions, not an atomic dispatch
reservation. Raw terminal input is not tracked as a managed turn.

`agent.wait_for_outcome` requires the current turn ID, defaults to 30 seconds and
caps at 120 seconds. Optional `quietMs` ranges from 1 second to 1 hour. It returns
`reason` and `lastObservation` (nullable): `input_required`, `turn_finished`,
`output_quiet`, `worker_disappeared`, or `timeout`. Turn completion includes
`provenance:"heuristic"`. Stale prompts cannot finish a turn; input takes precedence
over readiness and silence. A missing pane is confirmed against its original
terminal identity. Transport failure is an error, not disappearance.
Superseded turns, changed bindings, uncertain delivery and cancelled requests
return explicit errors. Existing wait tools keep their original semantics.

Observations retain `awaitingInput` for compatibility and add `inputRequired`,
`readyForPrompt`, and `inputRequest`. A request has an ID, kind (`permission`,
`question`, `authentication`), turn ID, detection time, heuristic provenance, and
`pending` or `uncertain` state. IDs remain stable for an unchanged observed request.
Unknown output preserves an uncertain request; observed work or readiness resolves
it. Sending input alone does not resolve it. Requests are bounded, process-local
observation state, reset on restart/reattachment; no prompt text is stored durably.
Permission classification takes precedence. Recognizable sign-in prompts require
input; generic authentication failures still classify as errors. No prompt is
automatically approved or answered.
