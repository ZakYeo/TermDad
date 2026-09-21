# Local telemetry and performance baselines

Telemetry is on by default in new server sessions. Set `TERM_DAD_TELEMETRY=0`
in the server environment to disable it. Restart existing MCP clients after a
build to load telemetry. Collection makes no network requests or model calls.

Records live in `${TERM_DAD_STATE_DIR}/telemetry` (using the usual default state
directory when unset). Each version-1 JSONL tool record contains session UUID,
completion timestamp, tool name, monotonic duration in milliseconds, outcome,
bounded error classification, serialized result bytes and text-content bytes.
Arguments, prompts, response text, screenshots and raw error messages are never
stored. Unregistered names become `unknown`. Recognized error codes are a closed
allowlist; all other failures become `TOOL_ERROR`.

Measurement wraps the SDK `tools/call` request handler, outside argument
validation and terminal-selection exclusion. A call generates one record,
including screenshots and failed validation. Thrown protocol errors have zero
result-body bytes because there is no tool result to serialize. Success/error
follows the top-level MCP result; partial failures inside successful batch or
snapshot results are not additional failed calls. Returned `reason:timeout`,
`status:timeout` and `timedOut:true` outcomes are counted separately. Waits that
throw are errors, preserving their existing public contract.

Duration ends when the handler settles, before metric extraction/recording and
before transport delivery. Wait-tool duration includes intentional waiting; it
is not processing overhead. Summing concurrent durations yields accumulated call
time, not session wall time. Bytes count UTF-8 serialization of the tool result,
excluding the JSON-RPC envelope; text bytes count only text content, before JSON
escaping. Neither number is a token count. Image bytes are included in result
bytes; there is no image-to-token conversion.

## Storage and failure behavior

The local POSIX directory and files use owner-only permissions. Writes run
asynchronously in batches of up to 100, with at most 1,000 outstanding records.
Each server owns one active file, rotates at 5 MiB, and prunes completed files
on initialization/rotation to the newest 20 and at most seven days old. Live
peer files are excluded; files whose PID has exited are recovered as completed
files. Each writer adds at most 5 MiB of active data to retained history. PID reuse
can conservatively retain an orphan active file until that PID exits.
Cleanup is activity-driven; no retention daemon runs while the app is stopped.

Overflow drops records and writes a count when storage is available. Storage
failure disables that writer for its lifetime and produces a content-free stderr
warning at most once per minute. It never fails a tool or writes to MCP stdout.
Orderly close allows up to one second to finish writing. Telemetry is best effort:
crashes, forced shutdown, full disks and retention can lose data, and persisted
drop counts cannot account for all such loss. It is not an audit journal.

Library callers can pass a seventh `createServer` argument with
`{ telemetry: false }` or `{ telemetry: sink, now: monotonicClock }`. A sink has
synchronous `record(metric)` and optional asynchronous `close()` methods. The
injected sink must keep its own work and shutdown bounded. Existing six-argument
calls remain compatible. No MCP tools or tool response schemas changed.

## Reports and benchmarks

```sh
npm run telemetry:report
npm run telemetry:report -- /path/to/telemetry --json
npm run bench -- /tmp/term-dad-benchmark
npm run bench:live -- /tmp/term-dad-benchmark
```

The report reads retained records and emits per-tool counts, errors, timeouts,
median/p95/max duration, accumulated duration and byte totals. It skips malformed
or incomplete lines and reports their count. Input is bounded to 128 files,
128 MiB and 500,000 records; truncation is explicit. The JSON version also
includes maximum response sizes. No records is reported as an empty table.

The simulated benchmark runs every registered MCP tool through an in-memory MCP
client and deterministic terminal/screenshot fixtures, with memory worker,
task and event storage. Five warm-up workflows precede 30 measured workflows
for each mode, alternating telemetry-on/off order. File telemetry is real in
the enabled mode. Each workflow starts from a fresh fixture, and setup, cleanup,
plus `tools/list` are excluded from individual tool measurements. Lifecycle,
mutation and wait scenarios use explicit repeatable inputs. Push tests disable
push; they do not measure real hook delivery. The screenshot is a tiny fixture,
not a representative desktop image. The source-run wake command includes its
source-entrypoint warning. Terminal backend counts include identity checks;
they are operation counts, not necessarily OS subprocess counts.

Separate 1/5/10-worker fixture sweeps measure full/unchanged/append observations,
summaries, result collection, snapshots and manual watch passes. An extra
unmanaged pane is present. Regression tests pin explicit response-byte and
backend-call ceilings for those fixtures. Budgets are not auto-updated. Timing
is informational; CI does not enforce millisecond thresholds.

The live benchmark uses one owned shell pane, an isolated state directory,
stdio MCP and real disk storage. It measures 30 warm read/status and
submit-to-marker round trips after five warm-ups. Shell lifecycle operations
have their actual smaller sample counts. No Claude/Codex workers launch.
Unavailable WezTerm/desktop interoperability produces an explicit incomplete
report and nonzero exit. Only owned panes are mutated or closed; GUI selection
and screenshots remain simulated in this benchmark.
