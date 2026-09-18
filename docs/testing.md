# Verification evidence

Live verification performed on 2026-09-16 in this checkout using Node 22.14.0, Windows WezTerm from WSL Ubuntu, Claude Code 2.1.273 and Codex 0.154.0. The GUI and account are prerequisites; fake runner tests do not substitute for these live tests.

| Gate | Evidence |
|---|---|
| TypeScript build | `npm run build` succeeds |
| Unit and protocol tests | `npm run check`: 15 tests, including JSON parsing, argv/stdin transport, validation, key bytes, hashes, deltas/history bounds, mappings, pane disappearance, silent-worker timeout, permission gating, captured Claude/Codex fixtures, process timeout, concurrent names, stale prompt guard, and real stdio MCP initialization/list/call/errors |
| Live terminal and orchestration | `npm run test:live`: real stdio MCP → WezTerm GUI → shell. Creates a tab, submits a command and follow-up, waits for actual result markers, splits/resizes/focuses/moves, broadcasts to two workers, collects snapshots, creates/closes a window, interrupts sleep, and checks pane-count cleanup |
| Real Claude worker | `npm run test:agent -- claude`: detects readiness, submits short text-only prompt, reads actual answer, submits follow-up in same pane, reads second answer, interrupts and closes |
| Real Codex worker | `npm run test:agent -- codex`: same sequence, using the documented local launcher, which resolves explicit Node/CLI argv via TERM_DAD_CODEX_COMMAND because the WSL domain does not load nvm |
| Screenshots | `npm run test:screenshot`: validates MCP image type, PNG MIME and image dimensions. Full-window capture also visually inspected, including actual terminal content |
| Packaging | `npm pack --dry-run --cache /tmp/term-dad-npm-cache`: includes built executable, modules, docs and screenshot scripts |

The actual initial worker output is captured in `tests/fixtures/claude-ready.txt` and `codex-ready.txt`. Claude's existing local stop hook reported missing `bun`; it was non-blocking, and both answers were received. This repository does not modify the user's hook configuration.

The shell test uses `printf` with a split marker so the expected result cannot pass merely from echoed command text. Worker prompts similarly request concatenation of separate marker components, requiring an actual response. These validate interactive transport, not the agents' competence on arbitrary development tasks. Claude project trust was handled explicitly during setup; the server itself leaves permission screens untouched.

Known test environment constraints: this Codex sandbox blocks Windows interoperability and some child-process pipes. Checks were rerun with authorized host execution. Linux/macOS screenshot providers, alternate WezTerm versions, remote domains, extended keyboard protocols and arbitrary CLI UI revisions have not been live-tested.

To repeat screenshot validation, run `npm run test:screenshot` from this checkout. It writes `/tmp/term-dad-screenshot.png`, activates the first listed pane, and restores its window if minimized. Title matching must be unambiguous. The fixture tests run without CLI accounts or a GUI.

## Background watch implementation trial (2026-09-16)

In the isolated `feat/background-watches` worktree, `npm run check` passed the
TypeScript build and all 27 tests on Node 22.14.0. Added deterministic coverage for
baseline suppression, initial input-required screens, permission precedence,
managed stale prompts, quiet episodes, cooldown, transport recovery/disappearance,
independent sink/notifier retries, capacity, concurrent polls, removal/disposal
while work is awaited, automatic timer cleanup, command argv/stdin/timeout contract,
and MCP create/list/remove/close behavior. The stdio protocol smoke test also
verifies watch schemas and failure responses. Dependency installation and protocol
tests required the standard sandbox escalation for subprocess execution.

No live terminal/desktop tests were run: this trial forbids operating other panes
and sending desktop test notifications. Notification-provider tests inject the
runner; the PowerShell balloon helper has not been live verified.

## Watch/event queue integration trial (2026-09-16)

In `feat/event-queue`, after merging `feat/background-watches`, `npm run check`
passed the TypeScript build and all 43 tests on Node 22.14.0. Stdio tests validate
all 32 registered tools and event filtering, timeout, acknowledgment and replay.
Additional MCP tests with an injected terminal backend validate managed watch
publication into the default durable sink, combined worker/pane/watch/kind filters,
acknowledgment across restart, queue-full delivery failure and retry, and disconnect
while publication is in flight. Shutdown drains that publication before closing the
queue, settles waits and never sends a pane-close command. Both original injection
forms and explicit sink overrides remain covered. Journal tests cover corruption,
concurrent writers, bounded operation backlog, cancellation, and post-commit sync
failure without publication rejection. Protocol subprocesses used standard sandbox
escalation. These are deterministic/local protocol tests, not live GUI evidence;
no terminal panes or desktop notifications were operated for integration.

## Merged trial: live supervisor verification (2026-09-16)

Two visible Codex workers created separate worktrees under `/home/zak/personal`,
implemented watches and the event queue, and merged locally into `main` in sequence.
The combined build passed all 43 tests. The original uncommitted `AGENTS.md` change
was preserved byte-for-byte; no remote or push was used.

After merge `ed7ec4a`, the supervisor ran an ad hoc stdio MCP check against the built
server and real WezTerm, with a private temporary event directory and one temporary
shell pane. It verified automatic inactivity delivery, a return-to-prompt event
after `sleep 3` and a split `printf` result marker, filtered event waits, acknowledgment,
and pending-event replay with the same ID after closing and reconnecting the MCP
client. The pane survived that disconnect. A recreated watch then reported pane
disappearance after deliberate test-pane closure. The final pane count matched
the initial count; both implementation-worker panes remained open.

`npm run test:live` also passed against the merged build, covering the existing
shell, layout, broadcast, observation, interruption, and cleanup behavior. These
checks required authorized host execution after the sandboxed MCP subprocess
connection closed during initialization. No desktop balloon was sent or visually
verified; desktop notification delivery remains covered by injected-provider tests.

## Worker skill initialization (2026-09-16)

`npm run check` passed the TypeScript build and all 47 tests. New injected-backend
tests cover Codex's initial skill instructions, literal follow-ups, custom launch
argv, deferred initialization, onboarding timeout recovery, failed submission,
concurrent input rejection, and unchanged Claude/shell input. Both bundled skills
passed the skill-creator validator; an npm packaging dry run included both skill
files and the compiled prompt helper.

`npm run test:agent -- codex` passed against real WezTerm and authenticated Codex
after authorized host execution; the sandboxed attempt closed the MCP connection
during initialization. The live test exercised the initial task carrying the
worker instructions, an answer and follow-up in the same session, observation,
interruption, and pane cleanup. This confirms transport compatibility, not the
quality of the model's delegation decisions or automatic supervisor activation.
The incidental captured UI fixture refresh was discarded.

## Persistent workers and reattachment (2026-09-16)

`npm run check` passed the TypeScript build and all 73 tests after authorized host
execution. Sandboxed stdio tests could not maintain their subprocess connection.
New deterministic tests cover durable IDs and initialization, stale-prompt guards,
fresh observation history, detached instances and reused IDs, explicit adoption,
uncertain delivery, shared input/lifecycle exclusion, reservations, registry bounds,
corruption and lock recovery, durability warnings, watch rebinding, and disconnect.
Separate MCP processes verified restart recovery, shared mappings, duplicate-pane
rejection, concurrent input rejection, literal follow-ups, detached-state reporting,
and propagation of forgotten mappings.

`npm run test:recovery` passed against the real Windows/WSL WezTerm GUI, pinned to
its local GUI socket. It used a private temporary state directory and test-owned
bash panes. The same worker ID and pane ID survived MCP disconnect/reconnect;
old observation IDs reset, follow-up commands produced expected markers, a raw
terminal pane was adopted and controlled, forgetting preserved that pane, and
stop/cleanup removed the test-owned panes and mappings. This exercised shell
transport, not authenticated Codex/Claude conversation resumption.

The existing `npm run test:live` shell/layout suite also passed with isolated state
and the configured GUI socket after fixing environment forwarding in its MCP
launcher. It covered broadcast, snapshots, pane movement, new windows, interruption
and cleanup. The packaging dry run included the compiled persistence modules,
Windows identity helper and supervisor skill; the updated skill passed validation.

Fresh independent reviewers checked correctness/maintainability, tests, and
security/reliability. Their reproductions found and drove fixes for unbounded
cache growth during cross-server churn, missed watch disappearance after external
removal, and lost spawn-response reservations. Follow-up fault checking also
verified that worker-lock cleanup failures preserve committed results or the
original uncertainty error and expose a storage warning. Reviewers reran their
probes and reported no unresolved findings. Independently authored tests passed
for cache churn, failed post-submit commits, same-binding stale guards, and an
actual child-process SIGKILL during paste followed by safe fixture-lock recovery.

`npm run test:screenshot` was attempted with the pinned endpoint, including after
restricting HWND candidates to that GUI's PID. It failed safely because the
provider could not uniquely match the selected window title to an HWND. No
successful screenshot capture is claimed for this change; the existing provider's
window-title matching limitation remains.

## Persistent task board integration (2026-09-16)

`npm run check` passed the TypeScript build and all 93 tests after authorized host
execution. The completed worker baseline was separately verified with all 73 tests
before integration. The 20 task tests cover explicit acceptance and dependencies,
revision conflicts, memory isolation, file restart recovery, private permissions,
corrupt/oversized journals, rollback, stale locks, post-commit warnings, strict MCP
validation, bounded worker summaries and unavailable/missing assignments.

Separate production stdio MCP processes persisted task IDs and revisions across
restart and rejected one of two conflicting edits. Injected-terminal MCP processes
verified assigned worker summaries, detach/forget/reassignment behavior and that
task operations emitted no terminal input. These fixtures do not constitute live
GUI evidence. A fresh ordinary read-only subagent review found no actionable
integration issues; its focused storage/summary checks passed, while its sandboxed
stdio connections closed during initialization.

`npm run test:recovery` passed against real Windows/WSL WezTerm after explicitly
selecting a verified GUI socket and parent pane. The initial unconfigured attempt
stopped before spawning because multiple GUIs were running. The successful run
used a private temporary state directory and test-owned shell panes, verified task
and worker identity across MCP restart, observed a follow-up marker, explicitly
recorded acceptance evidence and completion, and retained the task after stopping
its worker with a missing-assignee view. Adoption, forgetting and pane cleanup also
passed. No authenticated agent usage or screenshot check was needed for this change.

## Full project review and manual verification (2026-09-16)

`npm run check` passed the build and all 109 tests. The initial sandboxed run
could not communicate with stdio child processes; host execution passed the
93-test baseline and the final suite. New regressions cover split UTF-8 output,
invalid inherited key names before input, byte limits and forced subprocess
termination, concurrent watch capacity and disposal, prelaunch validation, and
live-test ownership, isolation and uncertain-spawn recovery metadata.

Independent correctness/API, security/reliability, and tests/documentation/skills
reviews found and drove these fixes. The live agent test previously had a cleanup
branch that stopped unrelated workers. All live tests now use private state and
close only recorded owned panes; they also tolerate a verified pane exit after
Ctrl+C and leave UI fixtures unchanged unless explicitly requested.

Live checks used the real Windows/WSL WezTerm GUI with its endpoint explicitly
selected because two GUI processes were running:

- `npm run test:live`: shell input/output, layout, broadcast, snapshots, movement,
  interruption and cleanup passed.
- `npm run test:recovery`: worker/task persistence, MCP restart, observation reset,
  follow-up input, adoption, forgetting and cleanup passed on the final build.
- `npm run test:agent -- claude` and `-- codex`: both authenticated CLIs answered
  two no-tools prompts in the same session and completed verified pane cleanup.
  Codex's normal Ctrl+C exit exposed and drove a live-test cleanup correction.
- An additional manual MCP session verified Unicode output, unchanged observation
  deltas, invalid-key rejection, watch inactivity events, event replay after MCP
  restart, acknowledgment and subsequent worker input.
- A separate managed Codex worker received the bundled worker skill and described
  its responsibilities, implementation ownership, lack of extra permissions and
  terminal reporting path correctly. The response was inspected manually. Both
  installed skills resolve to the bundled repository directories; deterministic
  tests also cover first-task-only delivery and literal follow-ups.
- `npm run test:screenshot` passed after fixing native-window enumeration and
  title matching. Initial attempts exposed tab-count prefixes, empty/stale mux
  titles and multiple windows per process. New-window and ordinary-tab captures
  were visually inspected; the final MCP image was a 2576×1408 PNG. Matching
  remains title-based and rejects multiple candidate windows.

The final GUI listing contained only the original pane 0/tab 0/window 0. Only
test-created panes were closed. No trust or permission prompts were approved.
The server was rebuilt; existing MCP clients need a restart to load it and an
explicit GUI endpoint when automatic discovery finds multiple GUI processes.

## Claude installation and client verification (2026-09-16)

Installed both bundled skills as symlinks under `~/.claude/skills`, and updated
the existing user-scoped `term-dad` MCP entry with the selected GUI endpoint and
screenshot provider. Preserved the prior MCP entry separately. `claude mcp get
term-dad` reported connected after installation.

Repeated `npm run test:agent -- claude`: the visible authenticated Claude worker
answered both prompts and its owned pane was cleaned up. In another visible
Claude worker, `/term-dad-worker` loaded the installed skill and correctly
described the role, implementation ownership, lack of extra permissions and
terminal reporting path. This initially exposed a non-blocking `bun: not found`
stop-hook failure in GUI-created panes. The local launcher now forwards its PATH
to automatically resolved Claude commands. The repeat role test completed with
no stop-hook error in the inspected output.

Fresh Claude print-mode client tests loaded `term-dad` through the actual Skill
tool and called the real MCP tools: first `terminal_list`, then `agent_send` and
`agent_wait_for_text` against a separately created owned shell worker. The shell
printed `CLAUDE_CONTROL_VERIFIED`; a separate MCP observation confirmed it. The
client reported no permission denials. Tests used only the installed Term Dad
server entry, with private state for the shell-control test, and allowed only
the specific skill and tool calls needed. All created panes were cleaned up.

`npm run check` passed the build and all 110 tests. The added launcher regression
verifies runtime discovery from a stripped target PATH, literal handling of paths
containing spaces and dollar signs, and preservation of explicit command overrides.

## Completion reports and input-aware waits — 2026-09-16

- `npm run check`: passed, 127 tests, including deterministic completion gates,
  result provenance, stale attempts/reports, verification limits, legacy journal
  migration, mixed-precision timestamps, permission/question/authentication waits,
  uncertain submission, restart identity and stdio task/turn association. The full
  suite ran outside the sandbox for subprocess and stdio support; build is current.
- Both bundled role skills passed `quick_validate.py`.
- A fresh regular review subagent found one timestamp-ordering bug. It was fixed
  by comparing parsed instants, with valid, reversed and equal mixed-precision
  timestamp regression cases. No deep-code-review skill was used for that review.
- `npm run test:live` and `npm run test:recovery` were attempted outside the sandbox.
  Both stopped at initial `terminal.list`: “WezTerm identity unavailable: Configure
  WEZTERM_UNIX_SOCKET to select one WezTerm GUI endpoint.” No test panes were opened.
  The updated live turn-wait and verified-completion paths are **not live verified**.
  Rerun with a selected live endpoint; authenticated agent checks were not run.

## Unified task attention — 2026-09-16

- `npm run check`: passed the build and all 139 tests outside the sandbox, where
  subprocess and stdio communication work. Added 11 deterministic attention tests
  and one stdio protocol scenario covering categories, task/worker attribution,
  observation age, uncertainty, partial failures, independent cursors, expiry,
  frozen pagination, restart resets, and read-only task behavior.
- A fresh review subagent found that worker-source failure could incorrectly
  report zero decisions. Fixed the count to return unknown (`null`), added a
  regression, and had the reviewer verify the fix; no further findings.
- `npm run test:live` was attempted outside the sandbox. It stopped at initial
  `terminal.list`: “WezTerm identity unavailable: Configure WEZTERM_UNIX_SOCKET to
  select one WezTerm GUI endpoint.” No test panes were opened. The new live
  attention/verification/cursor assertions are **not live verified**; rerun with
  a selected GUI endpoint. No authenticated agent checks were run.


## Containing GUI identity through WSL (2026-09-16)

Added `WEZTERM_UNIX_SOCKET` and `WEZTERM_PANE` to the Windows WezTerm config's
`set_environment_variables.WSLENV`, preserving the inherited WSLENV. No fixed
socket or PID is stored in the config. `npm run build` passed.

Live verification opened a temporary WSL pane in each of two already running
GUI processes (17584 and 46848). Each probe inherited its own GUI socket and pane
ID. In the probe process, the built `WezTermBackend.instance()` verified the
corresponding Windows process, and `list()` included that probe's own pane.
Verified probe panes were 18 and 59 respectively; both were closed after testing.
An earlier environment-only probe (pane 17) also inherited the correct socket,
but its test assertion rejected equivalent mixed Windows path separators; it
was closed and the final probes used normalized Windows path comparisons.
The first spawn attempt used an unsupported CLI option and opened no pane.

These checks used actual Windows/WSL interoperability outside the sandbox, with
no authenticated agent launches. Existing supervisor environments were not
modified. A supervisor must be launched in a new pane to inherit the new values.
Full orchestration/recovery suites were not run for this configuration-only fix.

## GUI discovery and switching — 2026-09-16

- `npm run check` passed all 147 tests in the working checkout, including resolver
  pinning/failure/concurrency coverage and MCP switch exclusion during submit and
  watches. This run included pre-existing uncommitted attention tests. Sandboxed
  subprocess tests failed; the suite passed with normal subprocess access.
- The exact intended commit was also built and tested in an isolated temporary
  checkout without the earlier uncommitted work: all 135 tests passed.
- Live `terminal.list` in the existing MCP session recovered access to the current
  GUI (PID 46848, two panes) after the helper update.
- A fresh stdio MCP client with no inherited socket discovered two running GUIs,
  selected PID 46848 by default, switched to each exact returned identity, listed
  two and nine panes respectively, and restored its original selection. No terminal
  input was sent and no panes were opened or closed. New selection tools require
  existing clients to restart/reconnect to the rebuilt server.

## Supervisor wake-up, deliverability and event staleness (2026-09-17)

`npm run check` on Node 22.14.0: TypeScript build plus **192 tests**, up from 172
at the start of this work. New deterministic coverage:

- Watch back-off follows deliverability, not intent: an enabled registration on a
  server whose socket did not bind keeps `pollMs` and reports `pushBacked:false`.
- Event time filters (`notBefore`, `maxAgeMs`) select by instant, combine with the
  other filters, and reject unusable bounds.
- Fresh waits skip a pending backlog and settle on a later publication, while the
  library `EventQueue.wait` still replays for embedders. A dedicated case pins that
  freshness follows publication order rather than the producing clock, by publishing
  an event stamped 1970 after the wait armed.
- The auto-acknowledge sweep expires only aged `ready` and `inactive` records,
  never `attention_required`, `input_required`, `pane_disappeared`, `session_ended`
  or an unknown kind; it acknowledges rather than discards, is a no-op twice, runs
  inside publication, and neither throws nor creates a directory when absent.
- `wait-for-event` argument parsing rejects unknown options, out-of-charset kinds
  and out-of-range bounds before touching the filesystem.
- The waiter ignores a backlog, returns the first fresh match, acknowledges
  nothing, leaves no `events.lock`, reports a timeout as exit 0, never creates an
  absent state directory, retries a momentarily unreadable journal, fails a
  persistently invalid one as exit 4, and — a bug this test found — still receives
  the first event ever published when it armed before the journal existed.
- Over a real spawned `node dist/index.js`: the subcommand completes without
  starting an MCP server, creates no journal, lock or socket, writes exactly one
  JSON line to stdout, reports usage on stderr with exit 2, and a detached waiter
  exits carrying the event that woke it without acknowledging it.

Two test files that previously built real servers against the developer's own
state directory (`tests/watches.test.ts`, `tests/watch-events.test.ts`) are now
pinned to injected storage and a private `TERM_DAD_STATE_DIR`. They had been
creating and sweeping push sockets there; a run was observed removing a socket
belonging to a real earlier session. Verified afterwards that a run of both files
leaves the real state directory untouched.

The client-side wake was confirmed by observation in this environment, not by an
automated test: a detached background process was launched, the session's turn was
ended, the process exited, and the session was re-invoked with the process's single
JSON line available. That is a property of the MCP client, so it is recorded as an
observation and the skill still tells a supervisor to confirm it locally.

No live checks were run for this work: no WezTerm GUI round trip, no real Claude or
Codex worker, and no `npm run test:recovery`. The credential re-key and
`attention_required` sections of the plan are not yet implemented, so the live
push script they require does not exist.

## Wake discipline: `attention_required`, `--until-event`, `event.wake_command` (2026-09-18)

`npm run check` on Node 22: **224 tests**, up from 213. Every new case was written
first and seen to fail for the missing behaviour before the code existed, except
the final-read regression test noted below. New deterministic coverage:

- A recognised prompt yields exactly one `attention_required` across repeated
  polls alongside its `input_required`; a changed prompt replaces the undelivered
  request (pending count stays one, timestamp advances); working and then
  prompting again re-fires.
- A pane left at a ready prompt with unchanged output asks for a person once at
  `attentionMs`, distinctly from `inactive` at `inactivityMs`; a working pane past
  `attentionMs` never does. `attentionMs` is bounded to 1,000–3,600,000.
- With a non-zero cooldown and a just-delivered `ready`, `attention_required` is
  delivered on the same pass while `input_required` waits out the cooldown.
- Existing exact-kind assertions in the watch and MCP watch-event tests were
  updated for the additional kind; capacity in the queue-full case rose from one
  to two so the input request is still the one that fails.
- `orchestrator.attention` reports a worker at a ready prompt with unchanged
  output past two minutes as `needs_decision` with `worker_stalled_at_prompt` and
  `inspect_worker_and_record_result`, and never reports working output as stalled.
- `--until-event` parses as a value-less switch, fixes the cap at 86,400 seconds,
  and is refused together with `--timeout-seconds`.
- An event published during the final poll interval is returned rather than
  reported as a timeout. This test passed on first run: the plan doc's §4 claim
  that the waiter skipped a final read was wrong, and the test now pins the
  behaviour.
- Over a real spawned `node dist/index.js` MCP server: `event.wake_command`
  returns the server's own `process.execPath`, an existing `dist/index.js`, the
  `wait-for-event` subcommand, the server's state directory, and an `example`
  containing `--until-event`, `--state-dir <that directory>` and
  `attention_required`; the reported argv actually runs and reports a timeout as
  exit 0 with one JSON line. Tool count assertions moved from 52 to 53.

A same-day review with an independent agent then found that a prompt-classified
screen whose output was still changing asked for a person on every poll, because
the prompt regexes take precedence over the working ones; both sources now require
one poll of unchanged output, and a regression test streams four redraws under a
question and expects one request. The same review found `--kinds --until-event`
being accepted with `--until-event` as the kind, and `worker_stalled_at_prompt`
leaking into `dispatchConstraints`; both are fixed with tests. Its smoke tests, run
against the built server over stdio with a private state directory, showed the
`event.wake_command` example string running end to end through `sh -c`, including
a state directory containing a space and a quote, and exiting with the published
`attention_required`; a `--until-event` waiter printed nothing when killed after
five idle seconds.

No live checks were run for this work: no WezTerm GUI round trip, no real Claude or
Codex worker asked a question in prose, and no detached waiter was observed exiting
on a real `attention_required`. The MCP server attached to the authoring session was
still the previous build, so exercising the new tool there was not possible without
a restart. The plan's optional live step (spawn a worker, `watch.create` with a
short `attentionMs`, arm the reported command, make the worker ask a question in
prose) remains to be done and recorded here.

## Credential re-key (2026-09-17)

`npm run check`: **212 tests**. New deterministic coverage: credential files are
written atomically and owner-only into an owner-only directory, refuse a
symlinked, world-readable, oversized or malformed target without following it,
carry the path but never the token in a diagnostic, sweep by durable membership
only, and expose no read method on the server-side store. Hook argv carries a
credential path and no token or socket path, including through the wrapper argv
`scripts/launch-local` produces and for a path containing a space and a quote. The
notifier resolves credentials at fire time, prefers a credential path over stale
inline flags, still accepts `--socket`/`--token`, resolves an unmodelled event
without touching the filesystem, and fails an unreadable credential explicitly.
Across two servers over one state directory: a surviving worker is re-keyed so its
unchanged argv keeps working, its pre-restart token is rejected, its binding
revision is unchanged, push returns disabled and one `push.set` restores delivery;
an unattached record is left byte-identical; an orphan credential is swept while a
survivor's is kept; a server that could not bind neither re-keys nor sweeps; an
adopted pane is refused with `PUSH_NOT_WIRED` and gets no credential; and
`agent.reattach` re-keys and re-points the registration at the new pane. No token
appears in `workers.json`.

No live checks were run for this work.

## Argument aliases, lock reclaim, explicit exit and push by name (2026-09-18)

`npm run check`: **262 tests** on Node 22.14.0. New deterministic coverage: a held
lock names its holder pid; a lock whose holder is dead is reclaimed and the
transaction proceeds; a lock held by a live pid is honoured; a pid-less lock is
honoured while fresh and reclaimed once older than the write window; a worker
lock left by a dead process no longer blocks the worker; startup reaping removes
dead-holder locks and old orphan temporaries only; eight concurrent acquirers over one dead lock end with exactly one holder. Over real stdio: a server
exits with code 0 and no socket file when its client closes stdin, and exits when
its parent dies while `sleep` still holds its stdin pipe open. Push tools accept
the worker name; a survivor whose startup re-key was skipped by a held lock is
re-keyed by `push.set` and delivers with its new token; unknown names report
`PUSH_UNKNOWN_WORKER`. In-process MCP calls exercise `terminal.close {paneId}`,
`agent.send {message}`, `terminal.submit {paneId}` alone (one Enter, nothing
pasted), `terminal.spawn {command:"zsh -l -c \"echo hi there\""}` split without a
shell, `event.acknowledge {eventIds}`, and `terminal.send_key` with `Ctrl+C`,
`ctrl-c`, `Page Down`, `PgUp`, `Space`, `Enter`, `Escape`, `Tab`, `Down`.
`send_text` is pinned to one `send-text` call carrying the text on stdin.

Live check performed for `terminal.send_text` duplication (review item 13) with
the same WezTerm argv the backend issues: `wezterm cli spawn -- cat` in a new tab,
`send-text` of a marker, `get-text` showed the marker exactly once; after a
`--no-paste` Enter it appeared twice, which is `cat` echoing its input line. The
tab was killed afterwards. This does not reproduce the 16 Sep symptom, which was
seen inside a Claude Code prompt; no Claude worker was launched for this check
because that uses the configured account.

No live supervisor session was run against the new skill text.
