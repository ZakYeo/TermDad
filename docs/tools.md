# MCP tool reference

Tool names use dots. All arguments are JSON objects. Omitted arguments below use defaults. IDs are nonnegative integers; agent IDs may also be unique names. Errors return MCP `isError: true`.

| Tool | Arguments and behavior |
|---|---|
| terminal.list_instances | `{}` → up to 64 live Windows/WSL GUI identities (`key`, `endpoint`, `pid`, `title`), plus `selected`; unavailable selection is reported as `selectionError` |
| terminal.select_instance | `key` → select an exact live identity returned above, for this server session; no terminal input |
| terminal.list | `{}` → raw pane metadata including window/tab IDs, cwd, dimensions |
| terminal.spawn | `paneId?, windowId?, newWindow?, domain?, cwd?, command?: string[] \| string` → new pane ID in a tab/window. A string command is split like a shell would (quotes and backslashes honoured); no shell runs |
| terminal.split | `paneId, direction?: right\|bottom, percent?: 1..99, cwd?, command?` → new split pane ID |
| terminal.close | `target?: pane\|tab\|window, id` or just `paneId` → kills all selected panes |
| terminal.focus | `target?: pane\|tab\|window, id` or just `paneId` → activates matching pane |
| terminal.resize | `paneId, direction: Left\|Right\|Up\|Down, amount?: 1..1000` |
| terminal.move | `paneId, newWindow?, windowId?` → move to new tab |
| terminal.read | `paneId, lines?: 1..5000` (default 100) → text tail |
| terminal.send_text | `paneId, text` → paste without submitting |
| terminal.send_key | `paneId, key` → one raw key |
| terminal.send_keys | `paneId, keys: string[]` → ordered keys, entire sequence validated first |
| terminal.submit | `paneId, text?` → paste then Enter; with no text, Enter only |
| terminal.screenshot | `paneId` → MCP PNG image via provider |
| terminal.snapshot | `{}` → panes, 30-line tails and managed agents |
| agent.spawn | `name, cli: claude\|codex\|shell, prompt?, timeoutMs?` plus terminal.spawn options → mapped worker; prompt waits for readiness; first Codex task includes the worker skill |
| agent.list | `{}` → saved metadata, attachment state, recovery reason and storage warning; no terminal text |
| agent.adopt | `name, paneId, cli, workerSkillInitialized?` → register an existing pane; no input sent |
| agent.reattach | `agentId, paneId, acknowledgeUncertainDelivery?, workerSkillInitialized?` → explicitly bind a saved worker; no input sent |
| agent.forget | `agentId` → remove mapping without closing pane |
| agent.send | `agentId, text` (alias `message`) → submit task; includes the worker skill on the first Codex task if deferred at spawn |
| agent.observe | `agentId, since?: observationId, lines?: 1..150` (default 20) → compact state and the tail of normalized output; with `since`, only the change since that observation. `linesOmitted` counts what the cap dropped |
| agent.status | Same as observe |
| agent.interrupt | `agentId` → Ctrl+C |
| agent.stop | `agentId` → kill pane and remove mapping; releases its push registration and removes its credential file |
| push.status | `agentId?` (UUID or worker name) → socket bind state and per-pane delivery facts (`enabled` is intent, `deliverable` is reachability, `proven` is an observed hook) |
| push.set | `agentId` (UUID or name), `enabled` → turn worker-pushed events on or off for one pane; enabling returns the `push.status` facts plus `note`, disabling returns `{agentId,enabled,registered}` |
| agent.screenshot | `agentId` → provider image |
| agent.wait_for_text | `agentId, text, timeoutMs?` → wait for literal substring in recent output |
| agent.wait_for_outcome | `agentId, turnId, timeoutMs?, quietMs?, since?, lines?` → input required, heuristic turn finished, optional quiet output, disappearance, or timeout; `lastObservation` is the change since `since`, capped to `lines` |
| agent.wait_until_idle | `agentId, timeoutMs?` → recognized ready/idle state; no silence heuristic |
| agent.broadcast | `agentIds: string[], text` (alias `message`) → per-worker send success/error |
| agent.collect_results | `{}` → current observations, no inferred task success |
| orchestrator.status | `{}` → per-worker status, activity, hash and task summary with no screen text; metadata for detached workers |
| orchestrator.attention | Task-focused decisions, eligibility, verification, and cursor-based changes; see below |

Keys (case-insensitive): ENTER, ESC, TAB, SPACE, UP, DOWN, LEFT, RIGHT, PAGEUP, PAGEDOWN, CTRL_C, CTRL_D, CTRL_A, CTRL_E, CTRL_U, BACKSPACE, DELETE, HOME, END. Aliases: Escape → ESC, Return/CR/Newline → ENTER, ArrowUp/UpArrow → UP, ArrowDown/DownArrow → DOWN, ArrowLeft/LeftArrow → LEFT, ArrowRight/RightArrow → RIGHT, PgUp/PgDn → PAGEUP/PAGEDOWN, Del → DELETE, BS → BACKSPACE. The separators `+`, `-` and space are accepted, so `Ctrl+C`, `ctrl-c` and `Page Down` resolve. For example, `terminal.send_key({"paneId":7,"key":"ArrowDown"})` sends a down arrow. Both key tools send raw control bytes without bracketed paste; use them for menu navigation. `terminal.send_text` pastes text, so escape sequences sent through it may be treated as pasted content instead of navigation. Unsupported names report accepted keys, and a sequence containing any unsupported name sends no input.

Text is capped at 100,000 characters; key sequences at 100 keys. Wait timeout defaults to 30,000ms, maximum 120,000ms. Screenshots require `TERM_DAD_SCREENSHOT_COMMAND`. `newWindow` and `windowId` are mutually exclusive.

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

## Cost of polling

Screen text is normalized before it leaves the server: trailing spaces are
stripped per line, blank runs collapse to one, and the hash is taken on that
text. Observations return the last 20 lines by default. Choose the tool by how
much text you actually need:

| Cost | Tools | Use for |
|---|---|---|
| Cheap, no screen text | `agent.list`, `orchestrator.status`, `push.status`, `event.list`, `orchestrator.attention` | The board: who is busy, ready, or asking for a person |
| One worker, bounded | `agent.status` / `agent.observe` with `since`; `agent.wait_for_outcome` with `since` | What changed on the worker you are about to act on |
| Expensive | `terminal.snapshot`, `terminal.read` with a large `lines`, `agent.observe` with `lines:150`, `agent.collect_results` | Reading a screen when the tail is not enough; never as a poll |

`since` returns `unchanged` with empty text when nothing moved, `append` with only
the new lines when the screen scrolled or the current line grew, and `replace`
when it was redrawn. `wait_for_outcome` pins the `since` text when it starts, so
its result is a real delta however many times it polled.

Automatic recovery requires a matching terminal endpoint and process identity.
Windows/WSL uses the bundled `scripts/instance-windows.ps1` helper and automatic
GUI selection described below. Set or inherit `WEZTERM_UNIX_SOCKET` to prefer a
specific containing GUI. The endpoint must
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
write returns `WORKER_BUSY`; retry after the active operation finishes. Reads
(`agent.observe`, `agent.status`, the wait tools) retry through a bounded back-off
of about 1.5 seconds before surfacing `WORKER_BUSY` or `WORKER_STORAGE_BUSY`, and
`agent.wait_for_outcome` keeps polling through the lock until its deadline. Raw
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
without treating the committed action as failed. Every lock records the pid of the
process holding it. A lock whose holder has exited is reclaimed automatically, both
when the next acquisition meets it and by a sweep at server startup, which also
removes `workers.<UUID>.tmp` orphans older than a minute. A lock held by a live
process is never taken: nothing is stolen on a timer, so a slow live writer keeps
its exclusivity. If `WORKER_BUSY` persists, the holder is alive; find it before
removing anything by hand. Resolve any uncertain-delivery marker
through explicit reattachment afterward. Storage targets private local POSIX
filesystems, including WSL; disconnect never kills worker panes.

## Durable metadata events

`event.list`, `event.acknowledge`, and `event.wait_for_event` expose the durable
local event journal. Background watches publish to this queue by default; there
is deliberately no MCP publish/injection tool. Internal producers use
`await events.publish(input)`. The server exposes 52 tools, including the three
watch tools and three event tools.

| Tool | Arguments | Result |
| --- | --- | --- |
| `event.list` | Optional filters below; `includeAcknowledged` (default false), `limit` (1–1000, default 100) | `events` in ascending sequence order, `hasMore`, global `pendingCount`, `capacity`, `storageWarning` |
| `event.acknowledge` | `ids` (alias `eventIds`): 1–100 UUID event IDs | Retained matching `events` with acknowledgment timestamps, plus `unknownIds` |
| `event.wait_for_event` | Optional filters; `timeoutMs` (1–120000, default 30000); `freshOnly` (default true) | `{status:"event",event}` or `{status:"timeout"}`, `{status:"cancelled"}`, `{status:"closed"}` |
| `event.wake_command` | none | `command` (argv of the bundled waiter), `stateDir`, `kinds`, and a runnable `example`; read-only |

Filters are `paneIds`, `agentIds`, `watchIds`, `kinds` (each 1–64 values),
`afterSequence` (exclusive), `notBefore` (ISO, compared against `occurredAt`) and
`maxAgeMs` (1–604800000). Values within a filter are alternatives; supplied
filters are combined with AND. Omit filters to match any pending event.

`event.wait_for_event` is **fresh by default**: it only matches events published
after the wait arms, so a pending backlog can never fire as though it were new.
Freshness is a sequence baseline, not a clock comparison, because `occurredAt` is
when a pane was observed while publication can lag it by a watch's `cooldownMs` —
a timestamp cutoff would time out while the event sat pending. Pass
`freshOnly:false` to drain history deliberately, or an explicit `afterSequence` to
resume from a known point; both override the baseline. `event.list` is unchanged
and still returns history by default.

Listing and waiting never acknowledge or consume events, and multiple waiters
can receive the same event. MCP request cancellation settles the wait; disconnect
settles all waits without touching panes. A timeout conveys no worker outcome —
it means re-arm, not that nothing happened.

Events contain only `kind`, `paneId`, optional `watchId`/`agentId`, ISO `occurredAt`,
and a short producer-authored `summary`, plus queue-owned UUID `id`, monotonic
`sequence`, and nullable `acknowledgedAt`. Producers must use static metadata
summaries, never terminal output, prompts, error strings, or secrets. IDs and
summaries are bounded; extra payload fields are rejected.

Pending entries replay after restart. Repeated acknowledgments preserve the
original timestamp. Acknowledged records remain until space is needed; an ID
that has been evicted is reported in `unknownIds` without modifying the journal.

`ready` and `inactive` entries older than the auto-acknowledge window (default 15
minutes) acknowledge themselves, so a journal nobody drains does not grow until it
rejects publication. That set is closed and default-deny: `attention_required`,
`input_required`, `pane_disappeared`, `session_ended` and any unrecognised kind never expire,
because a request for a person or a lost pane must not vanish on a timer. The set
is default-deny, so a kind added later is never swept unless it is added to it. Expiry runs inside `event.list`-free write paths — a publication, an
acknowledgment, or a bounded background pass — never on a read, and an
auto-acknowledged record is indistinguishable from an explicitly acknowledged one.
Acknowledge because you handled something, not to keep waits usable.
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

## Waking an idle supervisor

`event.wait_for_event` can only finish a call the supervisor is already inside; it
cannot start one. To be woken while idle, run the bundled subcommand as a detached
background process and let **its exit** be the wake. Ask the server for the exact
command with `event.wake_command`; its `example` is the canonical form:

```sh
<node> <install>/dist/index.js wait-for-event --until-event --state-dir <stateDir> \
    --kinds attention_required,input_required,ready,pane_disappeared,session_ended
```

Two invocations seen in the field do not work and must not be used: bare
`term-dad …` is not on PATH unless the package was installed globally (exit 127),
and `node dist/wait-cli.js …` loads a module with no entry point and exits at once
with nothing on stdout. The only entry point is `dist/index.js`. The server reports
`--state-dir` explicitly because the waiter resolves its default from *its own*
environment, so a `TERM_DAD_STATE_DIR` set only in the MCP configuration would
otherwise point the waiter at the wrong journal.

| Option | Meaning |
| --- | --- |
| `--kinds`, `--agents`, `--panes`, `--watches` | comma-separated filters, combined with AND exactly as `event.list` does |
| `--after-sequence N` | resume from a known sequence; this is also the deliberate history drain (`--after-sequence 0`) |
| `--max-age-seconds N` | ignore events older than this window |
| `--timeout-seconds N` | 1–86400, default 1800; incompatible with `--until-event` |
| `--until-event` | re-arm mode: never reports a timeout short of a fixed 24-hour cap, so the process exits only for a matching event, the cap, or an unreadable journal |
| `--poll-ms N` | 250–60000, default 2000 |
| `--state-dir PATH` | defaults to the usual state directory |

It writes exactly one JSON line to stdout — `{"status":"event","event":{…}}` or
`{"status":"timeout"}` — and every diagnostic to stderr. Exit codes are `0` for
both of those outcomes, `2` for a usage error and `4` for an unreadable journal:
a timeout is a successful outcome of a bounded wait, not a failed job, and it
means *re-arm*, not that nothing happened. Read `status`, not the exit code. With
`--until-event` the waiter re-arms itself, so a wake is an actionable event unless
the 24-hour cap expired; the cap exists only so an orphaned waiter cannot live
forever. The journal is read once more after the final poll interval, so an event
landing during that interval is returned rather than reported as a timeout.

Like every other reader it is **fresh by default** and never fires on a backlog,
and it **acknowledges nothing** — handle the event, then `event.acknowledge` it.
It needs no running server, starts none, and creates nothing: it reads
`events.json` directly and, deliberately, without taking `events.lock`. That is
safe because a journal mutation commits by renaming a complete file, so an
unlocked reader sees either the whole old version or the whole new one. It matters
because this process is detached and killable while `FileJournal` has no
stale-lock recovery — a waiter that held the lock and was killed would stop the
server publishing at all.

Whether a client actually resumes a session when a background process exits is a
property of that client, not of Term Dad. Confirm it before relying on it.

## Worker-pushed events

Push is **off for every pane until it is enabled**. Enable it for long-running
assignments so a worker reports its own state instead of being scraped.

| Tool | Arguments | Result |
| --- | --- | --- |
| `push.status` | `agentId?` | `socket:{path,listening,bindError}` plus one worker or all of them |
| `push.set` | `agentId`, `enabled` | Turns worker-pushed events on or off for that pane |

A worker entry reports independent facts rather than one flag:

| Field | Means |
| --- | --- |
| `registered` | this server process holds a live registration and token |
| `hookSurface` | `claude_hooks`, `codex_notify`, or `null` when this server did not launch the pane with hooks |
| `enabled` | **worker-side intent only** — that this server would accept a push for the pane |
| `deliveries` | `{count,lastAt,lastKind}`, counted only once the sink accepted a push |
| `proven` | `deliveries.count > 0` — **the only field that means a hook has actually fired** |
| `deliverable` | every link this server can see is live: registered, wired, enabled, socket bound |

`deliverable` is not a promise of delivery. Nothing the server can inspect
establishes that the worker's CLI accepted its injected `--settings` or `notify`
program, that the notifier is executable in the worker's environment, or that the
worker's process can reach the socket path. Only `proven` establishes that, so
read `deliverable` as "nothing visible is broken" and `proven` as "it works".
Delivery counts are per server process; `push.status` is honest about that by
reporting `registered:false` rather than `count:0` when a registration is absent.

Enabling fails instead of returning a success value that overstates what is
known: `PUSH_UNKNOWN_WORKER` when the ID or name is not a managed worker,
`PUSH_UNSUPPORTED_WORKER` for a shell worker, `PUSH_SOCKET_UNAVAILABLE` when the
socket did not bind, and `PUSH_NOT_WIRED` when the pane was launched without hooks
(an adopted pane). A worker that survived a server restart is not refused: if the
startup re-key skipped it (its lock was held at the time), `push.set` re-keys it
under its lock and enables it, and a survivor this server is not attached to is
told to `agent.reattach`, never to respawn. Both push tools accept the worker's
UUID or its unique name, like every other worker tool. Enabling returns the same
facts as `push.status` (`deliverable`, `proven`, `reason`) plus a `note`, so the
result reports deliverability rather than wiring intent; disabling returns only
`{agentId,enabled,registered}`. `credential` is
`recorded` (a binding exists), `absent` or `unwritable`; it never asserts that the
file on disk is intact.
Disabling always succeeds and is idempotent, including when no registration
exists: the safe direction is never blocked by the reasons a channel is broken.
`push.status` likewise reports a managed worker it holds no registration for
rather than failing, and reserves `PUSH_UNKNOWN_WORKER` for an ID that is not a
managed worker at all.

`agent.spawn` injects the plumbing at launch — `--settings` hooks for a Claude
worker, a `notify` program for a Codex worker — so enabling push never needs a
relaunch. The hooks stay inert while the registration is disabled: the request
is answered `{"ok":true,"delivered":false}` and nothing is recorded. Shell
workers have no hook surface; `push.set` rejects them with
`PUSH_UNSUPPORTED_WORKER`.

A worker's hook argv carries the path of a private credential file
(`<state>/push-credentials/<agentId>.json`, mode 0600), never the socket path and
token themselves. A running process's argv cannot be rewritten, so baking
credentials in used to orphan every surviving worker whenever the supervisor
restarted. The notifier reads that file at fire time instead, so a restart can
replace the socket path and mint a new token under a live worker: push is
recoverable with one `push.set` and no relaunch, and no context is lost. This is
not a security boundary — every worker runs as the same user as the server, so
0600 no more isolates workers from each other than the previous argv did.

On startup, and on `agent.reattach`, a server re-keys the workers it can verify
it is attached to and revokes their previous tokens. Delivery comes back
**disabled**: push is off for every pane until it is enabled, and a restart cannot
verify that the worker's hook configuration survived. `push.status` reports
`hookSurface` and `registered` so a re-keyed pane is visibly ready to be
re-enabled. Credentials of workers that are no longer in the durable journal are
swept on startup; a surviving worker's is never touched, and nothing is swept when
that journal could not be read or the socket did not bind. `agent.adopt` records
no hook surface, because a pane launched without injected argv can never deliver.
`--socket`/`--token` remain supported for a worker launched by an earlier build,
which keeps working until the next restart and then needs a relaunch.

A hook connects to a per-server Unix socket in the state directory
(`push.<pid>.sock`, mode 0600, one per server process so servers under different
MCP clients never contend) and sends one bounded JSON line,
`{"token":…,"kind":…}`. Only `input_required`, `ready` and `session_ended` are
accepted (`attention_required` is derived from pane samples only, never pushed), and only the token and kind are trusted: summaries are authored by the
server, so a worker cannot inject event text. An unknown or revoked token is
rejected with `PUSH_UNAUTHORIZED`. Tokens are per worker, minted at spawn or at a
re-key, held in memory and in that worker's owner-only credential file, and
released when the worker is stopped or forgotten. Sockets left by crashed servers
are swept on startup; sockets that still answer are never removed.

A credential that cannot be written never fails a spawn: the worker launches with
unmodified argv and no durable binding, so `push.set` then refuses it with
`PUSH_NOT_WIRED` rather than reporting a channel nothing can reach. A failed
re-key leaves the worker unregistered and reports `credential:"unwritable"`.

An accepted push publishes the event and then samples the pane, so the recorded
status comes from the terminal rather than from the worker's claim. A watch on a
push-backed pane polls on `pushPollMs` instead of `pollMs`, keeping a liveness
backstop for a pane that is killed without ever running a hook; disabling push
restores the normal interval immediately. That back-off follows *deliverability*,
not intent: a registration that is enabled while this server's socket did not
bind keeps the normal `pollMs`, so a channel that cannot deliver never costs the
pane its polling backstop too. A pushed `ready` still means only that
a turn ended, never that a task succeeded.

## Background watches

- `watch.create`: choose exactly one `paneId` or `agentId` (ID or managed name).
  Unmanaged panes require `adapter`: `claude`, `codex`, or `shell`. A pane already
  mapped to a managed worker automatically uses its guarded observations.
  `pollMs`: 500–60,000 (default 2,000); `pushPollMs`: 1,000–3,600,000
  (default 30,000), used only while the watched worker can actually deliver its
  own events (registered, enabled, and this server's socket bound);
  `inactivityMs`: 1,000–3,600,000 (default 60,000); `attentionMs`: 1,000–3,600,000
  (default 120,000), how long a pane may sit at a ready prompt with unchanged
  output before it asks for a person; `cooldownMs`: 0–3,600,000 (default 10,000).
  `notify`: default false; true requires a configured desktop provider.
- `watch.list`: configurations, last classified status, last metadata-only event,
  pending event count, disappearance flag, and safe observation/delivery errors.
- `watch.remove {watchId}`: idempotently remove a watch; never closes a pane.

Example: `watch.create({"agentId":"research","inactivityMs":30000,"notify":true})`.
Create validates pane existence and establishes a baseline. Initial prompt readiness
is suppressed; an initial permission/question screen does produce `input_required`.
`ready` means return to a recognized prompt, **not task success**. `inactive` means
unchanged bounded text, **not task success**, and fires once per quiet episode,
reset by changed text. `attention_required` means **a person is needed**: the pane
shows a recognised permission, login or menu prompt, or it has sat at a ready
prompt with unchanged output for `attentionMs` — the prose-question case no prompt
regex can see. A recognised prompt therefore emits both `input_required` and
`attention_required`. Both sources require one poll of unchanged output, because
the prompt classifier wins over the working one and a question still on screen
while the worker streams would otherwise ask again on every redraw. It fires once
per stable prompt screen (keyed on status and output hash): a changed screen
replaces an undelivered request instead of queueing a second, a new stable screen
at a prompt asks once more, and the key clears when the pane works again. On a
push-backed watch the pane is sampled only every `pushPollMs`, so the stall is
noticed within `attentionMs` plus one liveness interval. A worker left at a ready
prompt with nothing to do asks for a person too: remove the watch of a finished
worker, or expect that wake. It is never auto-acknowledged. `pane_disappeared` requires a successful pane listing;
backend errors preserve the watch and retry. Disappeared watches remain listed
until removed, including pending deliveries. Maximum 64 watches per server.

Cooldown spaces successful event deliveries per watch. Transitions queue while
cooling down; repeated pending events of the same kind coalesce (maximum five
pending kinds per watch). `attention_required` is exempt: it is delivered ahead of
the other kinds on the same pass and is never held by the cooldown, because it is
the one signal that exists to stop a human waiting. Delivery failures remain visible and retry on later
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
`TASK_STORAGE_BUSY` means a live process holds `tasks.lock`: a lock left by a
process that has exited is reclaimed automatically (see persistent workers above).
No time-based lock stealing occurs.
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


## Task-focused attention

`orchestrator.attention` refreshes worker observations and joins them to a single
read of the task graph. It does not dispatch input, approve requests, record
results, or change task records. Existing `orchestrator.status` remains a worker
observation array. Normal worker observation/recovery can still remove mappings
for verified missing panes.

Fresh query: `{boardId?, since?, limit?}`. `limit` defaults to 50, maximum 100.
All boards are included by default. Worker-only attention is included only in
unfiltered queries; board-scoped worker changes include workers assigned to that
board's tasks. Completed, cancelled, and archived tasks leave active queues but
remain represented in change comparisons.

The response contains:

- `cursor`, `boardId`, `generatedAt`, and `collection.startedAt/finishedAt`.
- `sources.tasks/workers`, `warnings`, and `baseline` describing comparison resets
  and incomplete sources. Unavailable task data makes category counts `null`;
  unavailable worker data also makes `needs_decision` unknown (`null`).
- `counts` for each category and compact `entries`, sorted by first category below,
  then urgent/high/normal/low priority, creation time, and ID. Counts overlap.
- `changes`: task/worker IDs, `added`, `removed`, or `updated`, `changedFields`, and
  compact `before/after` metadata. Removal means leaving the compared scope, not
  necessarily deletion. Terminal output changes appear as output-hash changes;
  terminal text, task goals, report summaries, and raw errors are omitted.
- `pagination`: `entryTotal`, `changeTotal`, `offset`, `limit`, `nextOffset`, and
  `pageCursor`. Entries and changes use the same offset/limit independently;
  continue until `nextOffset` is null, even if one array is already empty.

| Category | Meaning |
| --- | --- |
| `needs_decision` | Required or uncertain input, a worker stalled at a ready prompt (`worker_stalled_at_prompt`: unchanged output for two minutes, the same threshold as the watch default `attentionMs`), explicit blockers, unsuccessful reports, failed/inconclusive verification, passed verification awaiting completion, assignment/worker problems, or a matching ready turn missing its report |
| `awaiting_verification` | A current successful report whose verification is unverified or stale |
| `ready_to_dispatch` | An unarchived, unblocked todo task; worker constraints are separate |
| `waiting_on_dependencies` | Active work with unfinished dependencies |
| `in_progress` | Active tasks explicitly marked in progress |

Entries include `reasons` and suggested `nextActions`, task revision, priority,
assignment, attempt/report references, verification status, blocker count, and
unresolved dependency IDs. Fetch `task.get` or `task.history` for full details.
`dispatchConstraints` exposes unassigned/unavailable workers, input requests,
uncertain delivery, lack of readiness, and another in-progress task assigned to
the same worker. `worker_stalled_at_prompt` is deliberately excluded: an idle
worker is the ideal dispatch target, so its stall is a reason, not a constraint. These are informational checks, not an atomic reservation.

Worker summaries include `observedAt`, `observationAgeMs`, `outputInactiveMs`,
status, input request metadata, turn association, delivery uncertainty, and
structured uncertainty reasons. Observation age measures successful acquisition,
not how long output has been unchanged. Failed reads and detached/missing workers
have null observation age and readiness. Fresh classification is still heuristic;
there is no arbitrary age threshold that declares a worker stale or ready.
`workerContext` distinguishes a matching current attempt from assignment-only
context; unmatched context carries `task_turn_unconfirmed`. A matching ready turn
without a result suggests inspection/reporting, never verification or completion.
Raw observations additionally expose `observedAt` and `bindingRevision`.

To page, call `{pageCursor: cursor, offset: nextOffset, limit?}`. This reads the
frozen snapshot without observing again; timestamps and ages stay anchored to
its generation time. Do not combine `pageCursor` with `boardId` or `since`, or use
`offset` without `pageCursor`. Expired pages return `ATTENTION_PAGE_EXPIRED`; start
a fresh query. Only one refresh per service can run at a time (`ATTENTION_BUSY`);
paging remains available during a refresh.

Pass a previous `cursor` as `since` for net changes over the complete dataset,
regardless of whether all pages were read. Calls do not acknowledge changes for
other callers. A first call returns `baseline.reset:true`, reason `initial`, and
no changes. Unknown, expired, or restarted cursors use `unknown_or_expired`;
changing board scope uses `scope_changed`. Resets return the current view and no
invented historical changes. At most 16 snapshots survive for 15 minutes each per
server instance. This is a comparison service, not durable event history.

Source failures preserve independently available data and emit static warnings.
Comparisons involving an unavailable source are skipped and listed in
`baseline.incompleteSources`, including recovery from an incomplete baseline;
absence of changes then does not establish absence of activity. No failed read
is interpreted as mass removal. Task and worker reads are separate snapshots,
not a cross-journal transaction. Inspect and reread task revisions before acting.

## Selecting a WezTerm GUI

On Windows/WSL, the inherited `WEZTERM_UNIX_SOCKET` wins. Without it, the server
selects the sole live GUI, otherwise the foreground WezTerm GUI, otherwise the
most recently started GUI (PID breaks start-time ties). It pins the endpoint and
process start identity; focus changes never redirect operations. An exited or
replaced GUI produces an error until explicit selection or server restart.

`terminal.list_instances` lists candidates even when the pinned GUI is gone.
Pass an exact returned `key` to `terminal.select_instance` to switch. A stale or
invalid key leaves the previous selection intact. This affects only this server;
it does not change environment variables or other clients. Other platforms and
backends without discovery support return an unsupported error.

Switching returns `TERMINAL_BUSY` if another tool call is active or watches remain.
Finish/cancel waits, remove watches, allow pending polling to finish, then retry.
Calls arriving during selection also return busy. Recreate watches after switching.
Worker mappings remain durable and workers in other GUIs become detached; switching
back recovers matching live workers. No panes are closed and no tasks are replayed.
Always list panes again after switching: pane IDs can overlap across GUIs.
