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
