# Supervisor session review: September 2026

Status: findings and planned work. Items 1–3 (wake discipline) and 5–8 (shrink
tool results) were delivered on 18 Sep 2026; item 4 is delivered for the read
path (`agent.observe`, `agent.status`, `agent.wait_for_outcome`), writes still
fail fast by design. Items 9, 10, 12–17 and 18–20 were delivered later on
18 Sep 2026 (skill text, argument aliases, key names, push by name with on-demand
re-key, pid-stamped locks with dead-holder reclaim, explicit server exit); see the
notes on each item. This records what three
real Term Dad supervisor sessions showed about the tool surface and the
supervisor skill, so the fixes can be picked up without re-reading the
transcripts.

## Sessions reviewed

All three are Claude Code sessions in which Claude ran as the Term Dad
supervisor over `lib-intelligence-ai-platform` workers. Transcripts live under
`~/.claude/projects/-home-zak-ctm-lib-intelligence-ai-platform/`:

| Date | Session ID | Duration | API calls | Output tokens | Tool-result chars | Human nudges to resume |
|---|---|---|---|---|---|---|
| 2026-09-16 | `70c443e4-6021-422e-a743-784f932d3f09` | 15:08–17:02 | 333 | 233k | 442k | 2 |
| 2026-09-17 | `c31d6539-4044-4279-af72-d43285ca4ed8` | 08:12–14:10 | 877 | 705k | 1.48M | 6 (two `/compact`) |
| 2026-09-18 | `6354bb4a-586a-42d9-8ad3-004944c89580` | 08:04–11:02 | 810 | 434k | 855k | 7 (one `/compact`) |

Method: transcripts were rendered to a condensed log (user, assistant,
tool call, tool result, system lines with timestamps) and read in full. Counts
below come from the raw JSONL. Timestamps are UTC as recorded in the transcripts.

The server builds in use moved during the review window. The 16 Sep session ran
a build before `583dd12` (no push events, `send_key` rejected `Enter`), the
17 Sep session crossed the push-notification rollout mid-session, and the
18 Sep session ran with push events and `wait-for-event` available. Findings
are marked where a later build already changes the picture.

## Where the tokens went

Prose is about 7% of output tokens. Roughly 85% is hidden reasoning. The
dominant cost is cache reads: 250M tokens on 17 Sep because each of 877 calls
re-read a context averaging 289k tokens and peaking at 685k. Reducing call count
and shrinking tool results matters more than shortening prose.

Largest contributors to context, by tool-result characters:

| Source | Evidence |
|---|---|
| `recentText` in `agent.status`, `agent.observe`, `agent.wait_for_outcome`, `orchestrator.status` | 103 blobs across 17–18 Sep, 573k chars; 48% is trailing whitespace and blank runs. `orchestrator.status` returned 25k–28k chars per call because it inlines every agent's screen. |
| `terminal.read` | 56 calls on 18 Sep, 307k chars; pane 9 read 12 times in 40s while driving one menu key by key; the same pane re-read three times returning identical text. |
| `terminal.snapshot` | 29k–37k chars per call. |
| Atlassian MCP | 50 `transitionJiraIssue` calls on 17 Sep each echoed an 8k-char issue (422k chars discarded); 5 of 11 JQL searches overflowed the tool limit. Not Term Dad's code, but the skill can steer usage. |
| `agent.send` bodies | 45 sends on 18 Sep, 91k chars, median 1.8k, max 4.2k; `WORKER_BUSY` retries re-sent full bodies. |
| Wake plumbing | 59 Bash calls on 18 Sep were `cat` of waiter output plus `wait-for-event` re-arms. |

## Finding 1: the supervisor stops with no wake armed

The user had to resume the supervisor 13 times across the three sessions
("keep monitoring", "why did you stop", "did the push hook not work").

- 16 Sep: the skill text of the day said watches do not resume the
  conversation, so at 15:49 the supervisor said "ping me and I'll sweep". Asked
  at 16:00 whether it could set a trigger, it wrote its own WezTerm CLI pollers
  and removed the Term Dad watches. The first fire was a false positive (worker
  idle at the prompt with a background test running). Both pollers then expired
  at a 57-minute cap.
- 17 Sep: same "I can't wake myself" claim at 09:02. After the push rollout at
  09:43, `push.set` returned `PUSH_UNKNOWN_WORKER` for existing workers and
  again after a successful `agent.reattach`. Idle gaps at 10:54 (poller died
  silently), 11:12 (wake filter covered `input_required` only; the worker asked
  in prose and emitted `ready`), and 13:17. Its own diagnosis at 13:18 was
  accurate: "The hook fires, term-dad records the event, and there it stops."
  Three servers were live at once and 50 events sat unacknowledged.
- 18 Sep: push was `proven:true` by 08:34 and 26 wakes arrived by push. Yet six
  of seven nudges map to a turn that ended with no waiter pending: 08:31 (wrong
  entry point `dist/wait-cli.js` exited instantly, unnoticed for 18 minutes),
  08:58, 09:30 (a plan sat unapproved 19 minutes), 10:29, plus 09:54 where a
  waiter was armed but the pane sat on a prose question that emitted `ready`.

Conclusion: on the current build the hooks work whenever a waiter exists. The
failure is re-arm discipline in the skill, one wrong entry point, and the
missing "a person is needed" event kind already planned in
`push-remaining-work.md` section 1.

Related errors: 30 `WORKER_BUSY` or `WORKER_STORAGE_BUSY` across 17–18 Sep;
7 of 11 `agent.wait_for_outcome` calls on 18 Sep failed with `WORKER_BUSY`
rather than waiting.

## Finding 2: every end-of-turn report is an essay

Between tool calls the supervisor is terse (median 130–180 chars). Final
messages are not: median 3.2k chars on 16 Sep, 2.2k on 17 Sep, 1.5k on 18 Sep,
with a header stack, a board table and a TLDR that restates the body.

| Session | Final messages | Ending in TLDR | `##` headers | Tables |
|---|---|---|---|---|
| 16 Sep | 16 | 13 | 49 | 29 |
| 17 Sep | 47 | 43 | 67 | 46 |
| 18 Sep | 56 | 21 | 111 | 55 |

Patterns: a board table redrawn eight or more times on 18 Sep with mostly
unchanged rows; "I'll go quiet now" five times on 17 Sep, each followed by a
wake within minutes; four "nothing needed from me" turns in four minutes on
17 Sep (11:40–11:44), each with headers and a TLDR; a 2.6k-char retraction of a
2.6k-char claim (17 Sep 10:32); a 1,657-char rationale after a single `Enter`
(18 Sep 08:32); a closing "Want me to…?" on nearly every 16 Sep turn after
autopilot had been granted.

## Finding 3: Term Dad results are the main token cost

See the table above. Specifics that point at code:

- `src/agents.ts:186` returns `recentText:output.text` on every observation.
  `src/backend.ts` `read()` trims only the end of the whole text, so each line
  keeps its padding to the pane width and blank runs survive.
- `src/server.ts:82` `orchestrator.status` returns the full snapshot, including
  each agent's `recentText`.
- `src/server.ts:64` `terminal.snapshot` reads 30 lines of every pane.
- `outputHash`, `previousObservationId` and `deltaReset` already exist, so a
  delta mode has most of its plumbing.

## Finding 4: the supervisor drops to code level about once an hour

The skill says to supervise outcomes and let workers own implementation. In
practice the supervisor verified ticket claims by grepping the target repo
itself, before and after the user's explicit correction on 18 Sep 08:49
("worry about inputs, outputs and acceptance criteria").

- 16 Sep 15:30: five greps and a `sed` across the hotel readiness, checkout
  reader and simulator sources to "verify the ticket's code claims", then a
  4k-char design write-up with code blocks. The worker had already reached the
  same reading.
- 17 Sep: six greps to verify nine tickets "line by line" (08:35); five greps
  plus a `sed` to make one ticket decision (10:04); reading a PR diff to
  adjudicate a worker against Copilot (10:29), then misinstructing the worker on
  a path the worker had to correct.
- 18 Sep before 08:49: ran the failing test itself (08:06); six git forensics
  commands inside a worker's worktree ending in an unnecessary
  `agent.interrupt` (08:45, "False alarm on my part"); a brief that fenced a file
  path that did not exist (08:43).
- 18 Sep after 08:49: the next report was outcome-level, but the drift returned
  within 15 minutes (worker plan files read with `sed` at 09:24 and 09:46;
  dispatch prompts still naming symbols at 10:27). Code-token density in prose
  fell about 40% but did not stop.

A contributing cause is structural: `recentText` pushes 8k chars of the
worker's screen, often a source diff, into the supervisor's context on every
status call whether or not it asked.

## Other observations

- Schema fumbles repeated across days: `paneId` vs `id` on `terminal.close`
  and `terminal.focus`; `message` vs `text` on `agent.send` (five times);
  `terminal.submit` requiring an empty `text`; `terminal.spawn` wanting an array;
  `event.acknowledge` `eventIds` vs `ids`; `watch.create` rejecting an array
  target. Roughly 20 validation errors in total.
- `terminal.send_key` rejected `Enter`, `Down`, `Escape`, `Tab` on 16 Sep,
  forcing manual keypresses. The current `keys` and `keyAliases` in
  `src/backend.ts` accept these, so this is fixed; keep the alias list in the
  tool description.
- `terminal.send_text` duplicated the message into the worker prompt twice on
  16 Sep. Not reproduced later; worth a live check.
- Copilot cannot be a managed worker: `agent.spawn` refuses it, `push.set`
  returns `PUSH_UNSUPPORTED_WORKER`, and the supervisor rediscovered the
  `zsh -l` then `copilot --plan` launch recipe each day.
- Servers outliving their client: on 18 Sep four servers were alive, each with a
  live `claude` parent, so multiple servers are usually legitimate. The MCP stdio
  transport never handles stdin ending; in practice the event loop drained and the
  process exited anyway, but an inherited stdin pipe would keep it alive, so the
  server now exits explicitly on stdin end and on parent death. The real
  operational damage found was a `workers.lock` held by no process (0 bytes,
  two hours old) that made every worker write in every server fail
  `WORKER_STORAGE_BUSY`; locks now record their holder and are reclaimed when the
  holder is gone.
- Supervisor acted before being told on 17 Sep (08:23 and 08:43): created
  worktrees, ran installs and spawned two Codex workers when only a plan was
  requested.
- Two `/compact` events on 17 Sep and one on 18 Sep (at 386k tokens). After
  each, the user re-pasted the full work plan because nothing durable held it.

## Planned work, in priority order

### P0 Wake discipline (finding 1)

1. `skills/term-dad/SKILL.md`: add an end-of-turn invariant. If any worker is
   not idle and no `wait-for-event` is pending, arm one before ending the
   turn. Forbid "ping me", "I'll go quiet" and any promise of a later update
   without a pending waiter. Show one canonical arm command and state that a
   waiter that exits within seconds of arming is a failed arm, not a wake.
2. Build `attention_required` as designed in `push-remaining-work.md`
   section 1, and update the skill's wake filter to include it.
3. Consider a self-re-arming `wait-for-event` mode that only exits on an
   actionable event, so a forgotten re-arm cannot happen and the per-wake
   `cat` plus re-arm pair disappears.
4. **Delivered for reads (18 Sep).** Make `agent.wait_for_outcome`, `agent.status` and `agent.observe` retry
   internally on `WORKER_BUSY` and `WORKER_STORAGE_BUSY` with a bounded
   back-off rather than surfacing the lock to the caller.

### P0 Shrink tool results (finding 3)

5. **Delivered (18 Sep).** Normalise `recentText` before it leaves the server: strip trailing spaces
   per line, collapse blank runs, cap at about 20 lines by default with an
   opt-in `lines` parameter for more. Expected saving is at least 48% on the
   current payloads.
6. **Delivered (18 Sep).** `orchestrator.status`: return per-agent summaries without `recentText`.
   Callers can `agent.observe` the one they care about.
7. **Delivered (18 Sep).** Delta mode: when a caller passes its previous `observationId`, return only
   text that changed since that observation, using the existing hash plumbing.
8. **Delivered (18 Sep).** Document in `docs/tools.md` which tools are cheap to poll and which are not.

### P1 Status-report budget (finding 2)

9. **Delivered (18 Sep).** `skills/term-dad/SKILL.md`: one line per wake unless a decision is needed;
   redraw a board only when a row changed; no TLDR under roughly 1,500 chars;
   no closing "Want me to" once the user has granted autopilot; approvals are a
   single key with no rationale; retractions are two sentences.

### P1 Acceptance-criteria level (finding 4)

10. **Delivered (18 Sep).** `skills/term-dad/SKILL.md`: no grep, `sed`, test runs or git forensics in
    the target repo or worker worktrees unless verifying a merge claim or a CI
    red; ask the worker for its evidence instead. Worker briefs carry ticket
    key, purpose, acceptance criteria and boundaries only, capped around
    1,500 chars, with no file or symbol lists.
11. Items 5 and 7 also serve this finding by keeping source diffs out of the
    supervisor's context.

### P2 Tool ergonomics

12. **Delivered (18 Sep).** Normalise parameter names across tools (`id`/`paneId`, `text`/`message`),
    accept `terminal.submit` without `text`, accept a string command on
    `terminal.spawn`, and accept an array target on `watch.create`. Update
    `docs/tools.md` alongside.
13. **Checked (18 Sep).** Live-check `terminal.send_text` for the duplicated-prompt symptom: a marker pasted into a scratch `cat` pane appeared once (`docs/testing.md`); a unit test pins one `send-text` call per paste. Not reproduced against a Claude TUI prompt, so the 16 Sep symptom stays open as a manual retry of the same text.
14. **Delivered (18 Sep).** `push.set`: report deliverability rather than wiring, and confirm the
    re-key path covers `PUSH_UNKNOWN_WORKER` after a successful
    `agent.reattach` (see `push-remaining-work.md` section 4, `restorePush`).
15. **Delivered (18 Sep).** Reap stale servers and the storage lock at startup so a restart does not
    leave three servers attached to one GUI.

### P2 Plan and state

16. **Delivered (18 Sep).** `skills/term-dad/SKILL.md`: plan-only until an explicit go; no worktree,
    install or spawn during planning.
17. **Delivered as skill text (18 Sep).** Store the active work plan in tasks (see `persistent-task-board.md`) so a
    `/compact` does not require the user to re-paste it, and have the skill
    read the board on reconnect.

### P3 Supplementary

18. **Delivered (18 Sep).** Skill guidance for Jira via the Atlassian MCP: bulk transitions in one
    shell call, request key and status fields only.
19. **Delivered (18 Sep).** Skill guidance for menus: one `terminal.send_keys` batch and one read, not
    a read after every key.
20. **Delivered (18 Sep).** Document in the skill that Copilot panes are unmanaged (no push, no
    `agent.spawn`), with the fallback launch and watch recipe.

## Tests and docs each item must touch

Items 4–7 and 12 change `src/agents.ts`, `src/server.ts` and `src/backend.ts`
and need coverage in `tests/` for the trimming, the cap, the delta path and the
retry bound, plus `docs/tools.md` and `docs/architecture.md` updates. Items 1,
9, 10, 16 and 18–20 are skill text only and should be checked against a live
supervisor session; record the result in `docs/testing.md` only if the check is
actually run.
