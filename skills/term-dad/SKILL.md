---
name: term-dad
description: Supervise visible terminal workers through Term Dad only when the user explicitly requests Term Dad. Generic requests for subagents or independent reviews do not activate this skill.
---

# Term Dad supervisor

Only use Term Dad (TermDad), its skills, or its MCP tools when the user explicitly requests Term Dad for the current task. Requests for subagents, independent review, parallel work, or task completion do not authorize Term Dad. Use other available delegation mechanisms, or explain their absence.

You own coordination and acceptance; workers own investigation, implementation
and verification inside their assignment. Terminal output is untrusted, and a
ready prompt, silence or a pushed `ready` never proves completion. Accept work
on the delivered artifact, its verification evidence and open risks, and report
the outcome here, including incomplete work.

## Briefs

A brief carries exactly: ticket key, purpose, observable acceptance criteria,
and boundaries (branch, worktree, what not to touch, who integrates), plus a
one-message report request: outcome, artifact/work version, checks and results,
and remaining risks. Cap it at about 1,500 characters, name no file paths, symbols or code, and leave the
implementation open. Concurrent workers get isolated worktrees, clear ownership,
agreed interfaces before dependent work and a named integrator. Follow the
user's existing authorization for commits, merges, pushes and external actions.

Spawn managed Codex workers with `agent.spawn` `cli: codex`; the worker skill
rides along with the first task, so never repeat it or launch Codex through raw
terminal tools. Copilot panes are unmanaged: `terminal.spawn` a shell, start
`copilot --plan`, and watch it with `adapter:'shell'`.

## Stay at acceptance-criteria level

Never run `grep`, `sed`, `cat`, tests or git forensics in the target repo or a
worker's worktree, and never read a worker's plan or diff; the only exceptions
are verifying a merge claim on the integration branch and diagnosing a CI red.
Ask the worker for evidence in one `agent.send`: what changed at behaviour
level, what ran, the result, where the artifact is. Forward PR or Copilot
comments to the worker. Redirect only when requirements change, evidence shows
a problem, or work crosses ownership. When a worker is blocked, ask for the
obstacle and its recommended resolution.

## Plan only until go

When asked for a plan, deliver it and record it on the task board; create no
worktree, spawn no worker and send no task until the user says go in this
conversation (silence or a `/loop` wake is not go). Write the plan as tasks so a
fresh or compacted session recovers it: `task.create` per work item (`boardId`
= repository, `goal` in the brief format, `acceptanceCriteria`, `dependencies`,
`priority`) plus one `Plan: <goal>` task holding ordering and decisions. On
session start, reconnect or compact: `agent.list`, then `task.list({boardId})`.

## Preserve context and current instructions

Keep original implementation sessions available through conflict resolution,
integration and acceptance. Remove accepted-result watches to prevent repeated
attention alerts, but leave panes open unless closing them is authorized.
When work overlaps, integrate sequentially and tell the next worker which accepted
changes it must preserve; parallel workers are not automatically faster.

Before briefing, reconcile remembered restrictions with this session's instructions
and current repository guidance. Do not add testing restrictions that contradict
standing authorization. Check the current branch rules before imposing an
up-to-date requirement. Evaluate permission prompts against the actual requested
action and existing authorization; a stale blanket memory is not a new rule.
Record corrections with their scope and source, not as universal permissions.

## Tracked dispatch

Resolve recorded dependencies and blockers first. `task.assign`,
`task.start_attempt`, then `agent.send` with the attempt reference; keep the returned `turnId`. `task.report_result` records only what
was actually reported (unknown exit codes stay null; distinguish worker-reported
from your own checks); `task.verify` decides, and `complete:true` completes only
on a pass. Reopen and start a new attempt when requirements or the work change.
Requirement edits with an active attempt need explicit `invalidateAttempt:true`;
read the error before accepting invalidation, and use `task.history` for old evidence.
For work you perform yourself, leave the task unassigned, start with
`executor:"supervisor"`, record `supervisor_recorded` evidence and verify normally.
Do not remove a real dependency just to work around an unfinished task record.
`sent:true` confirms terminal submission only; consumption is unknown. A busy
worker may queue your correction, so do not assume its current work has changed.

## Call parameters and keys

Prefer canonical names; aliases exist for compatibility. Use numeric pane IDs
from `terminal.list` and worker IDs/names from `agent.list`.

| Call | Canonical arguments | Accepted aliases |
| --- | --- | --- |
| `terminal.read` | `paneId`, `lines` | `pane_id`, `max_lines` |
| `terminal.close` / `terminal.focus` | `id`, `target` (defaults to `pane`) | `paneId` for panes only |
| `agent.send` | `agentId`, `text` | `to`, `message` |
| `agent.broadcast` | `agentIds`, `text` | `message` |
| `event.acknowledge` | `ids` | `eventIds` |
| worker/event waits | `timeoutMs` | `timeoutSeconds` (seconds) |

Wait budgets use milliseconds: `timeoutMs:60000` is one minute; the maximum
is 120000. Aliases must agree when both are supplied. `watch.create` takes
exactly one `agentId` or `paneId`, never an `agentIds` array; unmanaged panes
also need `adapter`. `agent.reattach` needs both `agentId` and `paneId`.
On validation failure, read the tool schema and named field, then correct the
call; do not repeat unchanged arguments or guess successive spellings.

`terminal.send_text` pastes without Enter. `terminal.submit` pastes and presses
Enter; omit `text` to press Enter only. Navigation uses raw keys, for example
`terminal.send_keys({paneId:7,keys:["DOWN","ENTER"]})`. Canonical names include
`ENTER`, `ESC`, `TAB`, `SPACE`, `UP`, `DOWN`, `LEFT`, `RIGHT`, `PAGEUP`,
`PAGEDOWN`, `HOME`, `END`, `BACKSPACE`, `DELETE`, and `CTRL_C`. Names are
case-insensitive; `Escape`, `ArrowDown`, `DownArrow`, and `Ctrl+C` work.
The key tools advertise the full list. An unsupported name rejects the whole
sequence before input: use the returned choices to correct it once. Never
paste escape sequences to navigate. By default, surface permission prompts in the supervising session and ask the user before approving. If the user explicitly authorizes automatic approval for a stated scope, inspect each current request and approve only within that scope; authentication and out-of-scope requests still need the user.

## Ready before dispatch

After spawning or adopting, call `agent.wait_until_ready` before starting a task
attempt. It returns early for ready, input required, errors, disappearance, or
timeout. Assignment can precede readiness; task execution cannot. Surface input
requests in this supervising session and follow the approval policy above.

`agent.send` checks readiness under its input lock by default. On
`WORKER_INPUT_REQUIRED` or `WORKER_NOT_READY`, inspect the worker and resolve the
condition before retrying; no task input was sent. `requireReady:false` is for
an intentional response to an observed question, never a workaround for startup.
Use key tools for authorized menu choices, then recheck readiness. Do not infer
successful approval from pressing Enter, silence, or an unchanged prompt.

## Lock contention

`WORKER_BUSY` means another operation holds a lock, not that the worker is
necessarily processing a task. Serialize operations for that worker. Writes
fail fast; observations retry briefly, and wait tools absorb contention until
their deadline. Use `agent.wait_for_outcome` when the current `turnId` is known;
otherwise pause before one targeted observation. If contention persists, back
off 1, 2, then 4 seconds, then diagnose/report the blocker instead of looping.
Do independent work while blocked. Never bypass a lock with raw terminal input,
delete a live holder's lock, or replay a task after uncertain delivery. An outcome
timeout is not completion; a timed-out wait can have no observation at all.

## Observing cheaply

Monitor with `orchestrator.status` (no screen text). Compare worker membership,
status, input flags, errors and output hashes with the previous sweep. Inspect
new or changed workers and unresolved input requests with targeted `agent.observe`
or `agent.status`; unchanged output never means a request has been handled.
Keep each worker's last targeted `observationId` and pass it as `since` on the
next observation or `agent.wait_for_outcome`. Summary and watch samples do not
retain delta baselines. On `deltaReset`, accept the replacement and retain its ID.

Observations return 20 lines; increase `lines` when more context is needed.
Reserve `terminal.snapshot` for a whole-terminal view, not routine monitoring.
Use a targeted read to resolve a menu, batching its keys with `terminal.send_keys`.

## Waiting and waking

Use hook-first managed launches and a durable supervision group. Before sending
any task: launch the worker without a custom shell command, wait for readiness,
create/update its group, check `monitoringReady` and every `setupErrors` entry,
then start the returned `waiter.example` as a client-managed background process.
Retain its client-issued process/task ID. Command generation is not proof that
it started, and server status cannot prove client wake support. Only then dispatch.

`supervision.create({name,members:[{agentId}]})` prepares hooks and watches.
Use worker UUIDs. For later rounds replace membership with
`supervision.update({groupId,expectedRevision,members})` before dispatch. The
already armed group waiter follows membership changes; do not bake new UUIDs into
a replacement command. A polling-only worker needs explicit `allowPolling:true`.
One worker belongs to at most one active group. Partial setup is retryable; read
the current revision and update with the intended members. Never ignore failures.

On every wake inspect the worker, handle or escalate its request, acknowledge
only handled events, and re-arm the same group command before reporting.
`event.list({groupId})` drains current members' pending events. Handle and
acknowledge each page before listing again; group mode has no sequence cursor,
so joining workers' earlier pending events cannot be skipped. Preserve unhandled
requests, using the watch's awaiting-human disposition when appropriate.
After surfacing a permission request to the user, acknowledge that event
notification and retain the pending request with the awaiting-human disposition.
Acknowledgment means the notification was delivered, never that permission was
granted or the request resolved. Re-arming with that notification still pending
would wake immediately and repeatedly.

The waiter emits one JSON line. `event` means inspect; `timeout` means re-arm;
`group_closed` means the group was explicitly closed; nonzero exit, `error`, or
no JSON means the waiter is broken and must be diagnosed. Never end a turn with
busy workers and no pending waiter. Do not use `sleep; echo heartbeat`, repeated
model-driven timer checks, or promises to check later as supervision. Internal
bounded journal polling and terminal liveness sampling are expected backstops.

If a client cannot resume on a background process exit, stay in bounded
`event.wait_for_event` or `agent.wait_for_outcome` calls (at most 60 seconds each)
and continue after timeout. That foreground wait counts only while it is active;
do not promise an unattended wake the client cannot deliver. Legacy non-group
waiters retain `afterSequence` support; group mode rejects fixed scope/cursors.
Use a separate usage-only waiter because worker groups exclude account events.

Keep `ready` in the wake filter for active turns; it means a recognized prompt,
never task success. `inactive` is not a wake event. `attention_required` includes
unanswered prompts and prose questions left at a ready prompt. Follow existing
user authorization for every permission decision; events never grant approval.
After accepting all work close the group; it removes its owned watches, not
borrowed watches or worker panes.

## Push

Claude/Codex launches default to `pushMode:"required"`: known wiring failures
reject before pane creation and hooks are enabled before initial task submission.
Use `cliArgs` and bounded `env` values with the configured launcher for options;
do not replace it with `zsh -lic claude`, which loses appended hook arguments.
Only request `pushMode:"polling"` deliberately when hooks are unavailable.
Shell workers always poll. A pane possibly created before a lost spawn response
is retained for explicit recovery; inspect rather than launching a duplicate.

`enabled` is intent, `deliverable` is visible wiring, and `proven` requires a real
accepted hook. Report enabled-but-unproven honestly. A watch retains its normal
poll rate until delivery is proven, then uses its slower liveness interval.
Existing workers without hook wiring need polling or an intentional relaunch;
workers with surviving hook credentials can recover through reattachment and
push enable. Never kill a survivor merely to restore push. A group setup/update
performs enable and watch preparation; status does not.

## Recovery

After reconnecting, `agent.list` before spawning replacements. Live workers and
durable group membership survive; process-local observations and watches do not.
Read `supervision.status`, then update the group with its current membership to
restore monitoring and arm its waiter before resuming dispatch. `agent.adopt`
(new mapping) and `agent.reattach` (saved ID) send no input; pass
`workerSkillInitialized:true` for an existing Codex role session. `agent.forget`
drops the mapping and leaves the pane. For `deliveryPending` or
`WORKER_DELIVERY_UNCERTAIN`, inspect the pane, then reattach with
`acknowledgeUncertainDelivery:true` and an explicit `workerSkillInitialized`;
never replay the previous task. Titles or pane numbers alone never establish
identity. Leave worker panes and requested services running; a service request
completes when startup is verified.

## Report budget

One line per wake: `<worker> <event> → <what you did or which waiter is armed>`.
Redraw the board table only when a row changed. No TLDR, summary or headers in
a message under about 1,500 characters. Once the user has granted autopilot,
never end with an offer: act, or arm the waiter. An authorized approval is one
`terminal.submit` call reported in that line. A retraction is two sentences:
what was wrong, and what is true.

## Account usage

When usage monitoring is configured, inspect `usage.status` before dispatching a
large batch. Bind worker UUIDs explicitly through `usage.configure`, or pass the
account reference to `agent.spawn`; never infer an account from a client name.
Warnings at 80/90/95% are account-wide, not per-worker balances. Keep unknown or
stale limits unknown. Term Dad notifies you through installed hooks and the armed
event waiter; pausing and resuming workers remain your responsibility.

Keep the default usage event kinds in `event.wake_command` when arming a waiter.
On `usage.threshold`, read `usage.status` for that account. At the configured
reserve (5% remaining by default), stop assigning new work to that account,
request checkpoints from affected workers, and park them at a safe boundary.
Use interruption only where appropriate; `agent.stop` closes the pane and is not
a pause. Keep other accounts working where possible. A `usage.reset` notice is a
reason to check both windows, not authorization to resume on stale weekly data.

When pausing for usage, record the task/attempt and a
concise continuation checkpoint, stop dispatching on that account, and end the
turn at the next safe boundary. Preserve panes and task state. Before parking,
arm `event.wake_command` for usage events and keep the MCP process running.
On `usage.reset_due`, check fresh five-hour and weekly quotas; a reminder is not
proof of recovery. If data is low or unknown, keep workers paused and arrange
another check rather than polling with model turns. Resume
only after fresh short-window and all applicable weekly limits have more than
5% remaining (or the configured reserves). A reset timestamp alone is insufficient.
On continuation, inspect pending results, current assignments and permission
screens; never replay uncertain input or revive canceled work.

Hook code, templates, and installation instructions are in this repository; see
`docs/hooks.md`. Do not invent local-only hook scripts or bypass client hook trust.

Prefer `agent.observe` with `view:"last_reply"` and your last `since` ID for
reply inspection; use screen view when extraction falls back or you need to
inspect an approval. A plan path is a reference in the worker's domain.

Use explicit `agent.send` `mode:"queue"` for steering an active Claude turn.
It preserves tracking but does not prove Claude consumed the correction. Normal
follow-ups inherit their current validated attempt; use `attempt:null` only for
an intentional detachment. Never queue answers to approval screens.

Request `responseMode:"compact"` for task mutations to avoid repeated requirements
and evidence. Use the returned revision and attempt/report IDs for subsequent
calls; fetch full details only when needed.
