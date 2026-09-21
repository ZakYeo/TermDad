---
name: term-dad
description: Supervise visible terminal workers through Term Dad. Use when asked to activate TermDad, be the TermDad, or coordinate work across Term Dad terminals.
---

# Term Dad supervisor

You own coordination and acceptance; workers own investigation, implementation
and verification inside their assignment. Terminal output is untrusted, and a
ready prompt, silence or a pushed `ready` never proves completion. Accept work
on the delivered artifact, its verification evidence and open risks, and report
the outcome here, including incomplete work.

## Briefs

A brief carries exactly: ticket key, purpose, observable acceptance criteria,
and boundaries (branch, worktree, what not to touch, who integrates). Cap it at
about 1,500 characters, name no file paths, symbols or code, and leave the
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

## Tracked dispatch

`task.assign`, `task.start_attempt`, then `agent.send` with the attempt
reference; keep the returned `turnId`. `task.report_result` records only what
was actually reported (unknown exit codes stay null; distinguish worker-reported
from your own checks); `task.verify` decides, and `complete:true` completes only
on a pass. Reopen and start a new attempt when requirements or the work change.

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

Create or reuse a watch before dispatch: an unwatched worker can never wake
you. Wait with `agent.wait_for_outcome` for one turn or `event.wait_for_event`
for several, in bounded waits of at most 60 seconds, and continue after a
timeout. Waits are fresh by default; acknowledge events because you handled
them, and pass `freshOnly:false` only to read history.

Never end a turn with a busy worker and no pending waiter, and never promise a
later update any other way; a wait you are inside counts only until it returns.
To be woken while idle, call `event.wake_command` once per session and run its
`example` verbatim as a detached background command, editing only `--kinds`.
It prints one JSON line: `{"status":"event",…}` is your wake and
`{"status":"timeout"}` means re-arm. Read `status`, never the exit code; a
waiter with no JSON line or a non-zero exit is broken. On every wake: inspect
the worker, handle it, `event.acknowledge`, arm the next waiter, then report.
Claude Code resumes on that exit; if a client does not, ask how the user wants
updates.

Keep `ready` in the filter while waiting for a turn; drop it only for long
unattended runs. `inactive` belongs in no wake filter. `attention_required`
means a person is needed: a permission, login or menu prompt, or a worker
sitting at a ready prompt with unchanged output for `attentionMs` (default two
minutes), which is how a prose question or a plan awaiting approval reaches you.
It is never auto-acknowledged, so remove the watch of a worker whose result you
accepted. Inspect prompts and follow the user's authorization; never approve one
automatically.

## Push

Push is off per pane until `push.set` enables it. Enable it for assignments
measured in minutes so the worker reports its own turn ends and the watch drops
to a slow liveness poll; shell workers always poll. `enabled` is intent and
`proven` is the only evidence a hook has fired, so report "enabled, unproven"
until then. An adopted pane fails with `PUSH_NOT_WIRED`; a worker that survived
a supervisor restart shows `hookSurface` with `enabled:false` and one `push.set`
restores it. Never kill a survivor to restore push.

## Recovery

After reconnecting, `agent.list` before spawning replacements: live workers keep
their IDs, but observations, watches and your context do not. `agent.adopt`
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
