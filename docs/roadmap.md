# Roadmap

- Expand captured Claude/Codex UI fixtures across versions and locales.
- Prefer structured foreground-process signals when available; detect agent exit into a remaining shell.
- Extend automatic worker identity verification beyond Windows/WSL local GUI sockets; add explicit multi-GUI routing.
- Per-pane screenshot crops and robust HWND mapping for multiple Windows windows; native Linux/macOS providers.
- Support application cursor mode and extended keyboard protocols explicitly.
- Add another TerminalBackend (tmux) without changing agent management.
- Richer pane reparenting and user-defined adapters. Background subscriptions now exist for an idle supervisor through the `wait-for-event` subcommand; in-process observation subscriptions are still open.
- Add optional access policy for shared machines; the current server is intended for one trusted local user.
