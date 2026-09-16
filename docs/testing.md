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
