# Persistent task board: independent foundation

Branch: `feat/task-board`, based on `a8d1abb`. This slice deliberately leaves
`server.ts`, worker lifecycle and the in-progress worker persistence changes alone.
It is an opt-in task library and MCP registration module, **not yet a durable,
production-enabled board**. No worker is launched, inspected or sent input.

## Implemented contract

- `task-model.ts`: versioned, bounded records and whole-graph validation.
- `task-storage.ts`: injectable atomic transaction contract and isolated memory
  implementation. There is intentionally no implicit in-memory production default.
- `tasks.ts`: task operations, revision conflict checks, filtering, dependency
  readiness, bounded operation backlog and close/drain behavior.
- `task-tools.ts`: six opt-in MCP tools, with close handling.

Each task has a UUID, immutable board ID, title, goal, priority (`low`, `normal`,
`high`, `urgent`), optional assigned worker UUID, dependency IDs, explicit blocker
strings, acceptance criteria, status, archival flag, revision and UTC timestamps.
A board ID is an explicit project/scope label; no board registry or filesystem
path identity is inferred. One task has at most one assignee; a worker may have
many tasks. Assignments store stable UUIDs and do not establish worker availability.

Statuses are `todo`, `in_progress`, `done`, `cancelled`. Transitions are explicit.
Blocked state is derived from explicit blockers and dependencies whose status is
not `done`. Readiness means an unarchived `todo` task with no such blockers; it
does not promise the worker is available. A running task may acquire blockers.
Terminal readiness, silence and worker output never change task status.

Criteria have stable caller-provided IDs, descriptions, a `satisfied` flag and
optional evidence notes. Criteria are initially unsatisfied unless explicitly
supplied otherwise. A task may have no criteria. Completion requires all supplied
criteria satisfied, all prerequisites done, and no explicit blockers. Evidence is
recorded, not independently verified or executed. Changing requirements on a done
task must preserve those invariants or explicitly reopen it in the same update.
Reopening a prerequisite of a done task is rejected; reopen the dependent first.

Dependencies must exist in the same board. Duplicates, self references and cycles
are rejected within the mutation transaction. Cancelling or archiving a prerequisite
does not satisfy it; an archived done prerequisite remains satisfied. Archive hides
records from default lists and prevents edits/assignment until restored. Records
are never automatically deleted, including when an assigned worker vanishes.

Every mutation after creation requires `expectedRevision`. A conflict leaves the
record untouched. Update arrays replace their previous values; they do not append.
Only assignment accepts null (to clear it). Empty patches are rejected. Timestamps
never decrease for a task. Unknown properties and invalid field sizes are rejected.

Limits: 1,000 tasks across all boards including archived tasks; 4 MB serialized
state; 100 dependencies, 50 blockers and 50 criteria per task; 128 outstanding
operations per board instance; 100 results per list page. Title/board ID: 200
characters; goal: 8,000; blocker/criterion description: 2,000; evidence: 4,000.
Capacity failures never evict records. No purge is provided in this slice.

## Storage and later integration

`TaskStorage.transaction(write, callback)` matches the shape of the in-progress
journal abstraction. A callback is synchronous and must have no external side
effects. The implementation must serialize transactions across users of a store,
operate on isolated state, validate before commit, roll back thrown callbacks and
avoid retaining aliases to caller-owned results. Memory storage provides those
semantics within a process and can be shared by multiple `TaskBoard` instances.
It does not survive process exit.

After worker persistence lands:

1. Rebase this branch onto the landed changes. Implement `FileTaskStorage` using
   `FileJournal<TaskState>` with `tasks.json`, the shared state-directory selection,
   `emptyTaskState` and `validateTaskState`. Surface task-specific corruption errors
   without replacing damaged state. Confirm isolation/transaction semantics against
   the final journal interface.
2. Add file-backed recovery, cross-process concurrent mutation, corrupt journal,
   lock contention and commit failure tests. Validate the 4 MB limit before writes.
3. Inject that storage into a `TaskBoard` in `createServer`, register the task tools,
   return the board for embedders, and update stdio tool-count/schema assertions.
4. Join assignments to the worker registry by UUID in supervisor summaries.
   Report missing/detached assignees without deleting tasks or rewriting historical
   assignments. Worker existence checks are inherently separate from task commits;
   they must not promise a cross-journal transaction or guaranteed dispatch.
5. Document production enablement and persistent state recovery in the architecture,
   tools and README. Use a separate `TERM_DAD_STATE_DIR` for development instances.

Task text is explicit user/supervisor input; it may include sensitive descriptions
or evidence. Do not automatically persist terminal output, log task content, or
copy it into the existing metadata event queue. Task data must remain untrusted
when subsequently used to construct worker prompts.

Automatic dispatch, scheduling, worker availability verification, task-change
notifications and a graphical board are deferred. In particular, task storage and
the event queue do not currently share a commit: reliable notifications would need
an outbox or another explicit recovery strategy. Offset pagination is bounded but
not a snapshot across concurrent edits; reload to reconcile a changing board.

## Verification

New tests exercise the pure task layer with injected storage and the MCP module
with the SDK's in-memory transport. These are not live WezTerm or disk-recovery
checks. Run `npm run check` in this worktree to build and exercise the existing
suite plus the task tests. File durability and production stdio registration remain
integration work listed above.

Validation performed on 2026-09-16: `npm ci --offline --ignore-scripts`, then
`npm run check` (build and all 54 tests passed, including 11 new task tests).
The full check needed execution outside the sandbox because existing stdio MCP
subprocess connections closed inside it. No live GUI checks were performed.

Fresh independent review identified an MCP schema-boundary issue: supplying only
Zod shapes allowed the SDK to strip unknown top-level properties before validation.
Registration now supplies complete strict schemas. MCP regression calls cover
unknown create/read/filter/update/assign/archive fields and verify rejected writes
leave records unchanged. The full 54-test check passed again after that fix.
