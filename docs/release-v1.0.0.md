# TermDad 1.0.0

TermDad now provides a compact view of open terminal panes, optional session and
workspace context, clearer worker recovery, and explicit batch closing.

## Breaking changes

- `terminal.list` returns `{selected,panes,counts,detached,notes}` rather than an
  array. Read `result.panes`; request `verbose:true` for each pane's original
  backend metadata under `raw`. Detached records are summarized separately;
  `includeDetached:true` adds their details.
- `terminal.read` removes line padding and excess blank lines by default.
  `raw:true` preserves the previous backend text behavior, including its existing
  final-tail whitespace trimming. Leading indentation remains in compact mode.
- Live tests require `TERM_DAD_TEST_ENDPOINT`, `TERM_DAD_TEST_INSTANCE_KEY` and
  `TERM_DAD_TEST_PANE`. Inherited WezTerm variables no longer authorize tests:
  they can refer to another still-live GUI.

## New behavior

Pane/tab display labels identify their source without renaming the terminal.
Session metadata distinguishes configured adapters, backend-reported executables
and title hints. `activity:"inspect"` adds on-demand managed-worker activity;
`workspace:"inspect"` adds optional local Git context. Missing tools, unverified
terminal domains and failed inspections return explanatory notes. No GitHub
access or workflow-specific completion policy is built into these operations.

Saved workers distinguish another live instance from unavailable verification
and explicit recovery. Positively confirmed exited Windows GUI mappings are
removed under binding locks; uncertain records survive. Client disconnect still
leaves live workers running. Tasks retain historical worker references.

`terminal.close` accepts `paneIds` plus `expectedInstanceKey`, checks identity
before operations and returns per-pane outcomes. An identity failure stops the
remaining batch. It is not an atomic backend operation.

## Upgrade

Install dependencies with `npm ci`, build with `npm run build`, and restart MCP
clients. Update consumers of the listing and read defaults above. Worker/task
journal formats are unchanged by this release. Keep server versions aligned when
sharing a state directory.

The GitHub `v1.0.0` tag and release are to be created from the merged commit after
merge authorization, not from this implementation branch.
