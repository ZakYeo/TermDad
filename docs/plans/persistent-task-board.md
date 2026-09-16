# Persistent task board

Status: implemented with file-backed storage, production MCP registration and
worker/task summary joins. Task mutations never send terminal input.

## Implemented contract

- `task-model.ts`: versioned, bounded records and whole-graph validation.
- `task-storage.ts`: injectable atomic transaction contract, isolated memory
  implementation and file-backed storage using the shared journal.
- `tasks.ts`: task operations, revision conflict checks, filtering, dependency
  readiness, bounded operation backlog and close/drain behavior.
- `task-tools.ts`: six production MCP tools, with close handling.
- `task-workers.ts`: informational joins between worker identity and task records.

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
Capacity failures never evict records. No purge is provided.

## Storage and integration

`FileTaskStorage` uses `FileJournal<TaskState>` with `tasks.json` and `tasks.lock`
in the shared private state directory. Reads reload and validate the entire graph;
writes validate, sync a unique temporary file, atomically replace the journal and
sync the directory. The journal lock serializes local processes, and revision
checks reject stale writes. Corruption is reported without replacing damaged state.
Post-commit warnings are exposed through task lists and worker task summaries.

`TaskStorage.transaction(write, callback)` callbacks are synchronous and must have
no external side effects. Implementations isolate callback state, serialize
transactions, validate before committing and roll back thrown callbacks.
`MemoryTaskStorage` provides the same data semantics inside a process, without
durability. `TaskBoard` requires explicit storage; `createServer` injects
`FileTaskStorage` by default, accepts an alternative as its sixth argument and
returns `tasks` alongside the other managers. Existing worker/event injection is
unchanged. Starting the server does not create journals. Shutdown drains accepted
task storage operations without closing worker panes.

Task reads enrich assignments through the worker registry. An unavailable registry
reports `unknown`; missing worker IDs report `missing`, never deletion of the task.
Detached workers retain their assignment and recovery reason. Worker observations
and lists carry compact summaries of up to 20 unarchived tasks, with total and
truncation indicators; full task lists remain paginated. A damaged task journal
cannot suppress worker recovery views: summaries explicitly report unavailable.
Joins are independent read snapshots, not cross-journal transactions or guarantees
of worker availability when a later command is sent.

Use a separate `TERM_DAD_STATE_DIR` for development instances. See the tool reference
for private directory requirements and explicit stale-lock/corruption recovery.

Task text is explicit user/supervisor input; it may include sensitive descriptions
or evidence. Do not automatically persist terminal output, log task content, or
copy it into the existing metadata event queue. Task data must remain untrusted
when subsequently used to construct worker prompts.

Automatic dispatch, scheduling, guaranteed worker availability, task-change
notifications and a graphical board are deferred. In particular, task storage and
the event queue do not currently share a commit: reliable notifications would need
an outbox or another explicit recovery strategy. Offset pagination is bounded but
not a snapshot across concurrent edits; reload to reconcile a changing board.

## Verification

Tests cover pure task operations, memory isolation, whole-graph invariants, file
recovery, corruption and lock handling, durability warnings, multi-process MCP
revision conflicts, strict schemas, worker joins and missing assignments. The
production stdio tests use private state directories; worker protocol scenarios
use an injected terminal and are not live GUI evidence.

The live recovery script also creates a task assigned to its test-owned shell,
verifies the assignment after MCP restart, explicitly records acceptance evidence,
and checks the task survives worker removal. See `docs/testing.md` for executions
actually performed and their results.
