# Performance baseline: 21 September 2026

Tool telemetry and deterministic regression budgets are implemented. No performance optimizations were applied. All 53 registered MCP tools have simulated coverage. Live checks used one newly created shell pane and closed only that owned pane; no paid model workers were launched.

## Real shell latency

Windows/WSL WezTerm through stdio MCP, isolated on-disk state, telemetry enabled. Read/status and submit-to-marker rows each use 30 samples after five warm-ups. Lifecycle rows have one sample each. These are client round-trip times. The marker is produced by shell execution, not by matching echoed input.

| Operation | Samples | Median | p95 | Maximum |
|---|---:|---:|---:|---:|
| spawn.shell | 1 | 1.608 s | — | 1.608 s |
| spawn.to_ready | 1 | 2.619 s | — | 2.619 s |
| terminal.list | 30 | 0.784 s | 0.988 s | 1.367 s |
| agent.observe | 30 | 2.430 s | 2.720 s | 2.892 s |
| orchestrator.status | 30 | 3.799 s | 4.563 s | 4.567 s |
| submit.to_marker | 30 | 6.230 s | 7.423 s | 8.565 s |
| stop.shell | 1 | 2.625 s | — | 2.625 s |

`spawn.to_ready` measures the readiness wait after spawn returns, not the combined launch-to-ready duration. `stop.shell` includes ownership/existence checks and verified cleanup. No model generation time is included.

## Payloads and scaling

The fixed 100-line terminal fixture has 1, 5 or 10 simulated workers, plus one unmanaged pane. Values below are maximum serialized MCP result-body bytes over 30 measured passes; counts include terminal identity checks. They are not token or OS-subprocess counts.

| Scenario | 1 worker: bytes / calls | 5 workers: bytes / calls | 10 workers: bytes / calls |
|---|---:|---:|---:|
| observe.full | 1,582 / 3 | 1,582 / 3 | 1,582 / 3 |
| observe.unchanged | 900 / 3 | 900 / 3 | 900 / 3 |
| observe.append | 909 / 3 | 909 / 3 | 909 / 3 |
| orchestrator.status | 827 / 5 | 3,975 / 17 | 7,912 / 32 |
| agent.collect_results | 1,665 / 5 | 8,437 / 17 | 16,904 / 32 |
| terminal.snapshot | 7,767 / 8 | 27,067 / 24 | 51,198 / 44 |
| watch.poll | 14 / 5 | 14 / 25 | 14 / 50 |

The watch pass has no MCP response; its 14-byte fixture envelope is only a benchmark placeholder. The regression budget that matters there is its backend-call count.

## Telemetry overhead and coverage

The paired run measured all 53 tools 30 times with telemetry disabled and 30 times enabled (1,590 calls per mode), after five warm-up workflows. Across tools, the median difference between enabled and disabled per-tool median round-trip times was **0.015 ms**. This is a noisy local comparison, not a guaranteed per-call cost. The enabled mode includes asynchronous file writes; server timing itself excludes telemetry extraction/recording. Tiny screenshot fixtures do not establish overhead for full desktop images.

The simulated runs use an in-memory MCP transport and memory worker/task/event storage, with a fresh fixture workflow each iteration. They exercise real tool implementations but do not simulate terminal subprocess latency. Lifecycle timings therefore cannot predict real CLI launch speed. Every scenario succeeded except the intentionally timed-out `agent.wait_for_outcome` scenario; no unexpected failures occurred. The push scenario tests disabling, not real hooks or event-delivery latency.

## Recommended next steps, in order

1. **Use existing summaries and deltas wherever full screens are unnecessary.** At 10 fixture workers, `orchestrator.status` returned 7,912 bytes versus 51,198 for `terminal.snapshot` (84.5% smaller), and 16,904 for `agent.collect_results` (53.2% smaller). An unchanged observation with `since` used 900 bytes versus 1,582 for a full capped observation (43.1% smaller). These reduce context volume; exact token savings are unmeasured.
2. **Investigate repeated identity checks and pane listings within a sweep.** At 10 workers, status performed 11 identity checks, 11 listings and 10 screen reads: 32 backend operations. A watch pass performed 20 identity checks, 20 listings and 10 reads: 50 operations. Sharing one verified listing/identity within a single pass could remove substantial duplication. Preserve selection, attachment, disappearance and stale-prompt safeguards; do not cache those checks indefinitely or across input operations. The live/simulated gap makes terminal/WSL overhead a stronger candidate than local serialization, but per-operation timings are still needed to distinguish CLI, identity and storage costs.
3. **Investigate duplicated reads in snapshots.** The 10-worker fixture snapshot read 21 screens across 11 panes: managed panes are read for both pane text and worker observations. Reusing a sufficiently deep read within that snapshot is a candidate, provided classifiers retain their full input and both output caps stay correct.
4. **Check polling volume in normal sessions before changing intervals.** Working push delivery already permits polling backoff. The 50-operation watch pass explains why repeated sweeps can be expensive, but this benchmark does not establish real push reliability or multi-worker live latency. Compare natural-session call counts before tuning.
5. **Keep the 100 ms paste delay for now.** It is visible in approximately 101 ms simulated sends, while the live path takes seconds. Removing it offers comparatively little benefit and risks input delivery. Likewise, defer tokenizer dependencies and a dashboard until these local reports identify a recurring need.

## Verification and limitations

- `npm run check` covers the TypeScript build, formatting and all unit/stdio protocol tests. The final result is recorded in `docs/testing.md`.
- Telemetry tests cover privacy markers, Unicode byte counts, success/error/timeout outcomes, SDK validation, unknown tools, images, thrown errors, selection contention, sink failure, bounded queues, rotation, retention and close. The stdio smoke test asserts all seven tool calls flush on client close, including four errors.
- One full run exposed a teardown race: a protocol test removed its directory while telemetry was still writing. Test cleanup now closes clients before removing their directories.
- A separate full run intermittently failed the unchanged event-journal concurrent-writer test: 14 unique sequences were returned for 20 publishes. That file passed all 17 tests in isolation. No journal fix was made. Treat this as a reliability follow-up, not evidence of a performance gain.
- Initial restricted execution could not complete the stdio/desktop path; successful live measurements used local execution with the necessary interoperability. Timing is host/load dependent. No millisecond thresholds were added to CI.
- Model input/output/cache/reasoning tokens were not collected. Bytes are context-volume proxies only. No speedup or token-cost reduction is claimed from this instrumentation-only change.

## Reproduce and inspect

Run `npm run telemetry:report` for normal-session metrics, `npm run bench -- /tmp/term-dad-benchmark` for fixtures, or `npm run bench:live -- /tmp/term-dad-benchmark` for the owned shell benchmark. Restart existing MCP clients after rebuilding to load default-on telemetry. Disable with `TERM_DAD_TELEMETRY=0`.

- [Complete 53-tool comparison and scaling tables](benchmarks/2026-09-21/simulated.md)
- [Simulated machine-readable results](benchmarks/2026-09-21/simulated.json)
- [Live machine-readable results](benchmarks/2026-09-21/live.json)
- [Metric definitions and retention](telemetry.md)

Measured checkout: `62bbd97740c42117a26e8f41ebf3321ba7fec7cc` plus the uncommitted telemetry work; Node `v22.14.0` on `linux` / `6.18.33.2-microsoft-standard-WSL2`. File timestamps identify the individual benchmark runs.
