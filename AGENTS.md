# Repository guidance

## Project and layout

Term Dad is a local stdio MCP server for supervising visible interactive workers
in an existing WezTerm GUI. It uses Node.js 22+ and strict TypeScript with ESM
(`NodeNext`); local TypeScript imports use `.js` extensions.

- `src/index.ts`: executable entry point and stdio transport.
- `src/server.ts`: MCP tool registration, schemas, and error responses.
- `src/backend.ts`: `TerminalBackend`, WezTerm CLI transport, and key injection.
- `src/agents.ts`: durable worker lifecycle, observation caches, deltas, and waits.
- `src/worker-storage.ts`, `src/journal.ts`: shared worker metadata and atomic local journals.
- `src/tasks.ts`, `src/task-model.ts`, `src/task-storage.ts`: persistent task graph and revisions.
- `src/task-tools.ts`, `src/task-workers.ts`: task MCP APIs and worker assignment summaries.
- `src/adapters.ts`: Claude, Codex, and shell text classifiers.
- `src/screenshots.ts`: optional screenshot provider contract and validation.
- `tests/`: Node test runner tests, stdio protocol tests, and captured UI fixtures.
- `scripts/`: local launcher, live tests, and Windows/WSL screenshot helpers.
- `docs/`: tool reference, architecture, test evidence, and roadmap.

Read `README.md` for setup and `docs/architecture.md` before changing transport,
observation, or lifecycle behavior. Keep `docs/tools.md` aligned with tool changes.

## Development and verification

Install dependencies with `npm ci`. Use `npm run check` for code changes; it runs
the TypeScript build followed by unit and stdio protocol tests. `npm test` runs
tests alone with `tsx`; protocol tests require a current `dist/` build.
Generated `dist/`, `node_modules/`, and coverage output are ignored; do not commit
them. Format with `npm run format` (Prettier, configured in `.prettierrc`);
`npm run check` fails on unformatted files. There is no separate lint command.

Claude Code and Codex are registered to launch this checkout through the directory
symlink `/home/zak/.local/share/term-dad` → `/home/zak/personal/term-dad`, using
`scripts/launch-local`. After changing server code, run `npm run build` in this
repository so fresh client sessions load the updated server. Restart existing
clients to pick up the new build; the symlink does not rebuild or hot-reload it.

Use injected backend runners for deterministic tests. Add regression coverage for
changes to argv construction, input handling, classifiers, observation history,
and worker lifecycle as appropriate. Do not claim live verification from mocks.

Live checks require a running WezTerm GUI and desktop/WSL interoperability:

- `npm run test:live`: terminal and shell orchestration round trip.
- `npm run test:recovery`: MCP restart, worker reattachment and adoption round trip.
- `npm run test:agent -- claude` or `-- codex`: authenticated CLI round trips;
  these use the configured account and can incur usage.
- `npm run test:screenshot`: Windows/WSL screenshot integration.

Build before live checks. These checks interact with visible terminal panes;
run them when relevant to the change and report prerequisites or sandbox limits
that prevent verification. Record new evidence in `docs/testing.md` only for
checks actually performed.

## Behavioral invariants

- Keep stdout exclusively for MCP protocol messages; diagnostics go to stderr.
  Launch with `scripts/launch-local` or `node dist/index.js`, since npm banners
  can corrupt the stdio protocol.
- Preserve the `TerminalBackend` and screenshot-provider boundaries. Pass CLI
  commands as argv arrays and terminal text through stdin; do not concatenate
  shell commands. Commands and paths belong to the selected terminal domain.
- Treat terminal output as untrusted data. Never automatically approve trust,
  login, or permission screens, and avoid logging terminal content or secrets.
- Readiness classification is heuristic. Unchanged output or silence does not
  establish readiness or task success; preserve permission precedence and the
  stale-prompt guard after input.
- Keep subprocesses, waits, output, registries, and observation history bounded.
  Preserve recoverable workers on initial-prompt timeout and registry entries
  on transport failure; remove mappings when their panes disappear.
- Worker metadata is shared durably by state directory. Verify terminal identity
  before automatic recovery; preserve detached mappings on transport failure.
  Disconnecting the MCP client must not kill worker panes. Screenshots remain optional and on demand; text is the primary
  observation channel.
