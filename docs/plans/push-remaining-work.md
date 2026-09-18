# Push notification: remaining work

Status: four of five planned sections are implemented and committed. This records
what is **not** built, why it was planned, and what is known about it, so the work
can be picked up without re-deriving it.

Delivered (see `git log 583dd12..`): watch back-off follows deliverability;
event staleness and auto-acknowledge; the `wait-for-event` wake subcommand;
credential-file re-key of surviving workers. Verified at 212 tests under
`npm run check`. No live checks were run for any of it.

## 1. Not implemented: an event kind meaning "a person is needed"

The original complaint this addresses: `input_required` only covers the three
regex-detected prompt shapes in `src/adapters.ts:4-6`. A worker asking a question
in prose classifies as `READY_FOR_PROMPT` and emits `ready`, which also fires at
every turn end, and `inactive` fires constantly during long test runs. There is
still no subscribable signal for "blocked on a person", which cost one lane about
eleven idle minutes.

Evidence from later sessions confirms the priority. In the 18 Sep supervisor
session (Claude Code session `6354bb4a-586a-42d9-8ad3-004944c89580`) push was
`proven:true` and 26 wakes arrived, yet at 09:54 a waiter filtered to
`input_required` sat armed while the pane waited on a prose plan question that
emitted `ready`, until the user intervened at 09:59. The 17 Sep session
(`c31d6539-4044-4279-af72-d43285ca4ed8`) hit the same gap at 11:12. Both, plus
the re-arm failures that this kind does not fix, are analysed in
`supervisor-session-review-2026-09.md`.

Until this lands, the documented wake filters use `input_required`, which covers
only recognised permission, login and menu prompts. When `attention_required`
exists, update the example in `docs/tools.md` and in `skills/term-dad/SKILL.md`
to subscribe to it, and drop the skill's caveat that waking on a prose question is
unavailable.

### Design as planned

Three sources, one emitter (`WatchManager`), all derived from what the server
samples rather than from the worker's word:

1. a pane sample where `inputKind(status)!==null` (`src/interaction.ts:7`);
2. a sample at `READY_FOR_PROMPT` with unchanged output for a new `attentionMs`
   (1000–3600000, default 120000) — the free-prose question case;
3. a worker-asserted claim through the bundled notifier that **only triggers a
   sample**, published solely if the confirming sample corroborates (1) or (2).

Rejected during planning, with reasons worth keeping: remapping Claude's
`Notification` hook (`src/worker-hooks.ts:10`) to the new kind, because it fires
for permission prompts too and would both duplicate `input_required` and silently
change existing behaviour; and publishing a claim straight from `PushIngress`,
because `src/server.ts:30` publishes *before* `watches.confirm`, so the event
would carry no corroboration at all.

### Traps found while planning, which the implementation must handle

- **`enqueue` is keyed by kind.** `src/watches.ts:75` opens
  `if(!this.active(w)||w.pending.has(kind))return;`, so while an
  `attention_required` is still undelivered — the normal case inside `cooldownMs`
  — a second one is silently dropped and `w.lastEvent` keeps the stale summary.
  `enqueue` must *replace* a pending `attention_required`, refreshing its
  timestamp and delivery flags, rather than drop it.
- **The cooldown must not apply.** `deliver` returns early inside `cooldownMs`
  (`src/watches.ts:109`, default 10000) and sends at most one pending kind per
  pass (`:118`). An `attention_required` queued behind a `ready` would wait out
  the cooldown and then the next pass, which for a push-backed watch is
  `pushPollMs` (30000) away — roughly 40s for the one signal that exists to stop
  a human waiting. Drain it first and ignore the cooldown for it.
- **Dedupe on `${status}\0${hash}`, not `inputRequest.id`.** The id does not exist
  for the case the kind is for: `observeInteraction` *deletes* the request at
  `READY_FOR_PROMPT` (`src/interaction.ts:17-18`). A new `w.attentionKey` is
  needed because `w.pending` is cleared on delivery and so cannot suppress a
  re-fire; clear it when the status returns to `WORKING`.
- **Reset the one-shot claim flag on every failure path.** `sample` returns early
  at `src/watches.ts:91,94,99` and throws from `:85,:88`. Without an explicit
  reset in a `finally`, a claim vanishes with no event and no error.
- **Name the methods distinctly.** Two class members called `attention` will not
  compile, and the name is already carried by `AttentionService`,
  `orchestrator.attention` and the planned `attentionMs`. Use
  `claimAttention(paneId)` and a private `recordAttention(w,key)`.
- **A claim reports `delivered:true` today.** `handle` returns that once the sink
  resolves (`src/ingress.ts:54`). A claim that published nothing must reply
  `{ok:true,delivered:false,sampled:true}` instead.
- **A claim from a disabled registration is dropped before the sink**
  (`src/ingress.ts:50`). Combined with re-key returning push disabled, the claim
  path is inert after every restart until an explicit `push.set`. That is correct
  consent behaviour and sources (1) and (2) still work, but it must be documented.
- **It requires an active watch on the pane.** A watch is the only server-owned
  sampling surface. Consistent with `skills/term-dad/SKILL.md`, which already
  mandates a watch before dispatch, but supervisors will otherwise silently miss
  wake-ups on unwatched panes.
- **State the achievable floor.** Even with the cooldown exemption, a claim waits
  for the next sample plus delivery: seconds, not milliseconds.

### Also part of this section: make `orchestrator.attention` agree

Without this, a supervisor woken by `attention_required` for a stalled prose
question calls `orchestrator.attention` and is told the worker is ready to
dispatch. `workerReasons()` (`src/attention-model.ts:48-54`) derives `input_*`
only from `inputRequired`, which a prose question never sets. The fix needs no new
plumbing: `workerStatus` already exposes `readyForPrompt` (`:34`) and a precomputed
`outputInactiveMs` (`:30`), so add a `worker_stalled_at_prompt` reason on the same
threshold and route it through `actions()` (`:55-65`) to
`inspect_worker_and_record_result`. Two surfaces, one answer.

### Tests planned

In `tests/watches.test.ts`: one unresolved prompt yields exactly one
`attention_required` across repeated polls, a changed prompt *replaces* an
undelivered one rather than being dropped, and returning to `WORKING` and back
re-fires; a prompt whose output stops changing asks for a human once at
`attentionMs`, distinctly from `inactive` at `inactivityMs`, and a `WORKING` pane
past `attentionMs` yields neither; a request for a person is delivered ahead of
quieter transitions and is not held back by `cooldownMs`. In
`tests/ingress.test.ts`: a claim publishes nothing unless the pane sample
corroborates it, the recorded summary is the server's static string even when the
push supplies one, and a claim for a pane with no watch is a bounded non-error
no-op. In `tests/attention.test.ts`: a worker stalled at a prompt is reported as
needing a decision rather than ready to dispatch.

### Docs this section must update

`docs/tools.md` — the push kinds sentence (currently "Only `input_required`,
`ready` and `session_ended` are accepted"), the watch kinds table, `attentionMs`
in the `watch.create` options, and the `needs_decision` and `reasons` entries for
`worker_stalled_at_prompt`. `docs/architecture.md` — the kinds list under
Worker-pushed events, "Four pending kinds per watch" under Background watches, and
the dedupe key. `README.md:265` still says "one of three event kinds".
`skills/term-dad-worker/SKILL.md` — instruct a worker to run the bundled notifier
with `--kind attention_required` when it needs a human decision it cannot show as
a prompt, stating that the claim is verified against the pane and dropped if the
pane is still working.

## 2. Not implemented: live verification

Everything delivered is covered only by deterministic tests with injected
backends. `AGENTS.md` forbids claiming live verification from mocks, and
`docs/testing.md` records honestly that no live checks were run.

`scripts/live-recovery.ts` **cannot** carry the push checks: its worker is
`cli:'shell'` (`:7`), which has no hook surface, so a `push.status` assertion
there would only ever prove `PUSH_UNSUPPORTED_WORKER`.

Planned instead: `scripts/live-push.ts`, run as a new `npm run test:push`,
modelled on `scripts/live-agent.ts` (which already spawns a real `claude` or
`codex` worker) and using `LiveSession.restart()` (`scripts/live-support.ts:21`),
which reuses the same `TERM_DAD_STATE_DIR` and relaunches through
`scripts/launch-local`. One script, three claims in sequence:

1. enable push and observe a real `Stop` hook deliver, so `proven` becomes true;
2. `session.restart()`, then assert `push.status` reports `hookSurface` non-null
   with `enabled:false`, re-enable, and observe the *next* turn's hook deliver
   through the worker's original unchanged argv — the claim that matters most,
   since it is the whole point of the credential indirection;
3. arm `term-dad wait-for-event` detached, make the worker ask a question, and
   assert the waiter process exits carrying the event.

What (3) proves and does not: that the waiter exits on the event. Re-invocation of
a supervisor session is the client's behaviour, not Term Dad's. It was confirmed
by observation in one environment (recorded in `docs/testing.md`) and is not
automatically testable here.

## 3. Known residual risks in the delivered work

- **Downgrading the server breaks the whole worker journal.** `workerSchema` is
  strict and `validate()` (`src/worker-storage.ts`) throws
  `WORKER_STATE_CORRUPT` for the *entire* file on an unknown key, so an older
  server sees every managed worker as unrecoverable, not just one with the new
  `push` binding. Forget workers or move `workers.json` aside before downgrading.
- **A worker spawned by a build older than the credential change keeps a baked
  token.** It works until the next restart and then goes silent with no recovery
  but a relaunch. Nothing can fix that retroactively.
- **Two servers attached to the same verified GUI race a re-key.** Last writer
  wins and the loser's registration is dead. The attachment gate prevents the
  common cases (a different GUI, a test server), and the loser is observable —
  `enabled:false`, never `proven` — but this is not arbitrated.
- **`deliverable:true` is not a promise.** Nothing inspectable establishes that a
  worker's CLI accepted its injected configuration, that the notifier is
  executable in its environment, or that its process can reach the socket path.
  Only `proven` does. Keep that distinction in any wording; collapsing it is the
  original bug.
- **Credential files are not a security boundary.** Workers share the server's
  uid.
- **An auto-acknowledged event is indistinguishable from an explicitly
  acknowledged one.** No field records the reason, deliberately: the event state
  schema is strict, so adding one would make a newer journal unreadable by an
  older server and stop it publishing.
- **The waiter reads the journal unlocked**, so it can observe the previous
  committed version and report an event up to one poll interval late. Accepted:
  it is what makes a killed waiter unable to wedge `events.lock`.

## 4. Review findings accepted but not fixed

A self-review of the delivered commits found these. They are real but were left
alone when the work was wrapped up; none can lose an event, leak a token or
deadlock.

- **`WORKER_BUSY` surfaces to callers instead of being retried.** Across the
  17–18 Sep supervisor sessions, 30 calls failed with `WORKER_BUSY` or
  `WORKER_STORAGE_BUSY`, including 7 of 11 `agent.wait_for_outcome` calls on
  18 Sep, each retry re-sending a full `agent.send` body or re-pulling a full
  observation. A bounded internal retry is item 4 in
  `supervisor-session-review-2026-09.md`.
- **`restorePush` gives up permanently on a `WORKER_BUSY` race.**
  `src/agents.ts` catches and logs, and restore runs exactly once from
  `createServer`. `FileWorkerStorage.exclusive` fails instantly rather than
  waiting, so any in-flight operation on that worker — or a stale lock from a
  crash — means it is never re-keyed for the life of the server: its credential
  keeps the dead previous token and the only signal is one stderr line. Wants a
  bounded retry, or a re-key affordance on `push.set`. Note the lock is arguably
  unnecessary: `rekey` mutates no storage.
- **`credential:'ok'` is inferred from the durable record, not from a credential
  that exists.** `src/push-workers.ts`'s helper reports `ok` for any worker with a
  persisted binding, including one whose file holds a revoked token or was removed
  out of band. `deliverable:false` and the `reason` keep it from misleading in
  practice, but the field asserts evidence it does not have — the same
  anti-pattern the honest-reporting commit exists to remove. Verifying would mean
  reading the credential server-side, which the write-only store deliberately
  forbids; reporting `recorded` rather than `ok` would be the honest fix.
- **`push.status` reaches into worker storage outside `Agents.run()`.**
  `createServer` wires `attachWorkers` to `agents.resolveOptional`, which does a
  journal read and prunes the observation cache, with no operation-limit
  accounting and no closed check. Polling `push.status` can therefore surface
  `WORKER_STORAGE_BUSY`.
- **A surviving worker that was not re-keyed is told to respawn.** `setEnabled`
  resolves the hook surface from the in-process map only, so if the socket failed
  to bind or restore lost a lock race, `push.set` throws `PUSH_NOT_WIRED` advising
  `agent.spawn` — which kills the very context the re-key work exists to save. It
  should consult the durable record like `status` does, advise `agent.reattach`,
  and check the socket before the wiring so a bind failure reports
  `PUSH_SOCKET_UNAVAILABLE` instead.
- **A waiter armed on an absent journal uses record timestamps as a tiebreaker.**
  When a journal appears after being absent it is impossible to tell a brand-new
  one from one restored with history, so that one case falls back to `occurredAt`
  against the waiter's start. A cooldown-delayed event published after arming but
  stamped earlier would be skipped. Bounded and rare, but it is the one place
  freshness is not purely sequence-based.
- **Smaller ones:** `parseWaitArgs` lets a repeated flag silently last-win; the
  wait loop does not read once more after its final sleep, so an event published
  in that window reports as a timeout; `PushCredentialStore.prepare`'s ownership
  message is discarded as `(unknown error)`, hiding the most likely real cause of
  a credential failure; and `tests/workers.test.ts`'s "fail before reservation or
  launch" case only exercises `cli:'shell'`, which returns from `launch` early.
