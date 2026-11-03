# Internal business demo

One epic, three Codex workers, one checked release. A repository-only walkthrough
for a nontechnical audience, using fictional Northstar sales data and a local
mock Jira board. It does not connect to Jira or publish code.

## Run it manually

From an interactive **Windows/WSL WezTerm pane**, with a large terminal window:

```sh
cd /tmp/term-dad-demo-development
npm run demo -- --check
npm run demo
```

A checkout elsewhere works too: run the same npm commands there. Install
dependencies with `npm ci` if needed. The launcher builds TermDad before launch.
Requirements: Node.js 22+, Git, Codex on the terminal PATH and authenticated,
and a running WezTerm GUI. The current pane must expose `WEZTERM_PANE` and
`WEZTERM_UNIX_SOCKET`. Verified GUI identity is currently Windows/WSL-specific;
the demo fails clearly elsewhere.

`--check` checks prerequisites without starting model sessions, opening panes,
writing global configuration, or preparing a scratch project. It runs
`codex login status`, not login. It does not prove the live demo will succeed.

The browser opens a local presentation URL, also printed in the terminal. Put
it beside WezTerm or on a second screen. Dad occupies the original pane and
creates three worker panes beside it. Login, trust, and permission prompts still
need normal human attention. One supervisor and three workers use your configured
Codex account and consume model usage.

## What to show

1. Point at the starter dashboard and three tickets: executive KPIs, monthly
   sales, and accounts needing attention.
2. Let Dad introduce and dispatch the team. Three independent Codex sessions
   implement small components in separate Git worktrees.
3. Watch the board progress. Dad checks each contribution and merges it into a
   local scratch release branch.
4. The finished dashboard reveals itself after verified tasks, actual Git merge
   evidence, and combined acceptance checks. Toggle Before/After for the payoff.

Suggested narration: **“I give one assistant the business outcome. TermDad lets
it direct several real coding sessions and bring their work back together.”**

Target three to four minutes after startup, not a guaranteed duration. Rehearse
before presenting: model speed, approval screens, and quota availability vary.
Every run starts from a fresh fixture. There is no prerecorded success fallback.

## Status and failures

The board reads existing `task.list` and `orchestrator.status` MCP tools roughly
every two seconds, with one acquisition at a time. It never shows transcripts.
“Merged” requires passing task verification and a worker commit present in release
history. The reveal also requires all checks passing on a clean release tree.
A worker report alone is “Checking”; silence does not mean completion.

Unavailable observations retain their timestamp and show a warning; the after
preview becomes unavailable. Permission requests, worker problems, failed checks
and blockers need attention. Merge failures preserve the repository for
inspection: no force merges or resets. Tell Dad to stop to halt work; inspect
workers before sending follow-ups, especially after uncertain input delivery.

## Stop and clean up

Exit the supervisor with Codex's normal exit command to stop the preview server.
Ctrl+C remains available to interrupt the active Codex turn. Worker panes stay
open and may still be working if you exit early. Close only the demo worker panes
manually when done; do not bulk-close unrelated panes.

The launcher prints a unique `/tmp/term-dad-demo-*` directory. Its `run.json`
records repository/worktree locations, task IDs, GUI identity, and worker pane
IDs recorded by Dad. `integration.json` contains successful merge/check evidence.
Files remain for inspection after exit. After closing the demo workers, delete
only that specific printed run directory if desired. Do not delete
`/tmp/term-dad-demo-development`, the implementation worktree. A failed launcher
also preserves prepared files. Starting again creates a new independent run;
it does not resume or clean up old runs.

No global MCP registration changes. Each invocation supplies TermDad config and
a private state directory. Other user-configured Codex tools can remain available,
but the supervisor brief confines work to this demo.

## Development checks

`npm run check` includes demo TypeScript checks and deterministic tests. Tests use
fixture HTTP servers, injected prerequisite runners, and disposable Git repos;
they do not launch Codex or control WezTerm.

The fixture has no dependencies or build step: its release check is
`node check.mjs`; workers use `node check.mjs SALES-10x`. The shared renderer
provides styling; workers implement data transformations. This keeps live work
small while requiring real code changes and parallel Git integration.

Independent review and automated tests are not live rehearsal evidence. The live
walkthrough is intentionally left for the presenter to launch manually.
