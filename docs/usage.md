# Account usage monitoring

Term Dad separates provider account allowance from session token counts and MCP
telemetry. Several workers may share one quota; their percentages are never added.

## Support and limits

| Source/client | Collection | Active-session context | Automatic pause and idle resume |
| --- | --- | --- | --- |
| Codex | Documented app-server account/rateLimits/read; no model turn | Repository-owned lifecycle hook | Unavailable: account/workspace identity and pause/wake not verified together |
| Claude Code | Documented statusLine rate_limits fields, when present | Repository-owned lifecycle hook | Unavailable: no supported fresh read while paused; account identity unverified |
| Copilot CLI | Explicitly unavailable; no estimated subscription quota | Repository-owned lifecycle hook can describe account status | Unavailable: quota collector and pause/wake not verified |

The built-in adapters deliberately report `verified: false`. Configuring
`mode: "automatic"` fails with `USAGE_AUTOMATIC_UNAVAILABLE`, without changing
the account. Unit tests use an injected verified adapter; that is not live-client
evidence. Never edit the capability flags merely to bypass the check.

Advisory mode automatically delivers notices through installed model-context
hooks. At the configured reserve, the notice asks the supervising assistant to
checkpoint and pause affected sessions itself. Automatic policy capabilities do
not gate these notices. At idle, keep the `event.wake_command` background waiter
armed: its defaults include threshold, reset, pause-request, and resume-pending
events. Process completion wakes the assistant only where the client supports
that behavior; merely writing an event or showing a desktop alert does not.

The standalone `usage-hook --wait` helper supports a conditional resume signal
for a future verified integration. It is not installed as an idle wake hook for
the built-in advisory adapters. Native client integration must verify both its
stop semantics and the complete wake delivery before advertising automatic mode.

Sources: [Codex account API](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt),
[Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Claude status lines](https://code.claude.com/docs/en/statusline),
[Claude hooks](https://code.claude.com/docs/en/hooks),
[Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference).

## Configuration and tools

```js
usage.configure({
  accountRef: "personal",
  provider: "codex",
  mode: "advisory",
  reservePercent: 5,
  weeklyReservePercent: 5,
  workerIds: []
})
usage.refresh({ accountRef: "personal" })
usage.watch({ accountRef: "personal", thresholdsUsedPercent: [80, 90, 95], notifyOnReset: true })
usage.status({ accountRef: "personal" })
event.list({ accountRefs: ["personal"], kinds: ["usage.threshold"] })
```

`usage.configure` replaces that account's configuration; include existing worker
IDs when updating it. Worker IDs must be real registered UUIDs. One worker cannot
belong to two configured accounts. Account names are local opaque identifiers,
not login credentials. Hooks bind the supervising session explicitly through
`--account`; `agent.spawn` accepts an explicit `accountRef` for a new worker.
No account identity is inferred from the model/client name.

Codex accepts an absolute `codexHome` and optional CLI `profile`. These select the
CLI's configuration; no tokens are copied into Term Dad. The collector invokes
`codex app-server`, initializes it, reads auth metadata and quotas, then closes it.
It never starts a thread, logs in, purchases credits, or sends an inference request.
`TERM_DAD_CODEX_EXECUTABLE` may select an installed executable. An email fingerprint
detects some login changes but does not prove workspace identity; the email itself
is not persisted.

Claude collection requires installing its status-line wrapper. Absent weekly or
short-window fields remain unknown. Repainting the same quota data with the same
API-duration counter does not refresh its observation time. Existing status-line
rendering remains intact. Model-specific windows not exposed by the documented
feed cannot be inferred from token counts.

`usage.unwatch` removes threshold/reset alerts, not the reserve policy. Set
`enabled: false` through `usage.configure` to disable the account. Reconfiguration
cancels outstanding continuation intents. Account removal and private provider
endpoints are not exposed.

## Policy semantics

In an integration with verified automatic capabilities, `>=95%` short-window or
weekly usage closes the account's managed dispatch gate. Each session receives a
checkpoint-and-stop instruction at a supported hook boundary; a Stop hook records
that it parked. The service does not close panes or mark tasks complete. Work on
other accounts may continue. A bound worker is checked again immediately before
managed input, including the initial prompt after a readiness wait.

The policy state distinguishes `running`, `pause_requested`, `paused`, and
`resume_pending`. Refresh errors and the next scheduled check are reported
separately. The client reports its checkpoint through the existing task board;
the quota journal does not copy prompts, terminal contents, or transcripts.

The reset timestamp schedules a check, not an assumed new allowance. Every
applicable five-hour and weekly window must have **more than** its reserve left.
Readings older than two minutes, expired reset timestamps, missing windows, and
failed reads cannot authorize continuation. Weekly exhaustion takes precedence
when choosing the next recovery check. Provider reads are limited to once a
minute with exponential failure backoff capped at fifteen minutes.

Continuation is claimed once per pause cycle and session. The next model turn
must inspect task/attempt state, permission screens, and uncertain worker input;
no previous terminal command is replayed. Interrupt/session-end hooks cancel
that session's continuation intent. Hook output is delivery evidence, not proof
the model followed the instruction. Manual terminal commands and independent
clients are outside managed dispatch enforcement.

The 5% threshold cannot guarantee a hard spending ceiling: provider reporting
lags and in-flight work may overshoot. There is no automatic provider switching.

## Persistence and events

The owner-only `usage.json` journal is bounded to 32 accounts, 64 sessions per
account, 32 quota windows per observation, and 64 pending events per account.
Metadata uses the existing atomic journal contract. Collectors use a separate
per-account lock, so a network call never holds the usage journal lock. Dead
collector owners are recoverable through the existing PID-based lock protocol.

Events are `usage.threshold`, `usage.pause_requested`, `usage.reset`, and
`usage.resume_pending`. They carry an `accountRef` instead of a fabricated pane.
Pending publications retry with a delivery key; retained events deduplicate
cross-process retries. Once a record is acknowledged and evicted, the queue
cannot guarantee deduplication across an old interrupted producer retry.
Configured desktop notification commands receive the same bounded metadata;
delivery can repeat after a crash between notification and outbox cleanup.
When one observation crosses several thresholds for a window, one event reports
the highest crossed threshold and the number crossed; every threshold is still
tracked individually for deduplication and hysteresis.

Monitoring ends when the hosting MCP process closes. Reopening reloads durable
state and refreshes before any automatic work. No background OS service is
installed. Event journal writes now use version 2: upgrade all Term Dad clients
sharing the state directory together. Existing version-1 IDs, sequences, and
acknowledgments are retained. An old binary cannot read version 2; do not downgrade
without restoring a compatible backup while all writers are stopped.

## Verification

Run `npm run check`. `npm run test:usage -- codex` is an opt-in live account read;
it prints quota metadata without account identity and does not request inference.
See [testing evidence](testing.md) for results actually obtained. Installation
and hook transport can be exercised with temporary configuration and synthetic
quota data; those tests do not establish real client pause/wake support.
