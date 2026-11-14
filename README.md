# kingfisher

A local, browser-based live view of a coding agent at work. A Rust daemon on 127.0.0.1 owns the
agent process, normalises its event stream, and feeds a WebGPU scene in a browser tab where one
can watch, chat back, interrupt, and approve permission requests.

Runs Claude Code first, by spawning the unmodified official `claude` binary under the user's own
login. kingfisher never reads, stores or forwards credentials. Other agents come later, through
adapters.

## Status

Design only. No code yet.

- [docs/design-report.md](docs/design-report.md) is the founding research report (2026-11-14):
  feasibility, integration paths, terms, prior art, rendering stack, architecture, MVP plan.

## Plan

| Milestone | Scope |
|---|---|
| Weekend MVP | Daemon spawns `claude -p` in bidirectional stream-json; `PermissionRequest` HTTP hook for approvals; cosmic scene, transcript panel, chat, interrupt; NDJSON archive and replay |
| v0.2 | Global hooks plus transcript tail to observe hand-started sessions; take over via `--resume`; timeline, diff view, terminal pane, sonification; hang watchdog |
| v0.3 | ACP and Codex adapters; multi-session; more themes; optional OTLP receiver |

## Before any public release

Re-read Anthropic's Claude Code legal page. The design relies on its carve-out for an end user
signing in to the unmodified binary with their own subscription, and that wording changed several
times in 2026.
