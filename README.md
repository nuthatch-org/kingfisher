# kingfisher

A local, browser-based live view of a coding agent at work. A Rust daemon on 127.0.0.1 owns the
agent process, normalises its event stream, and feeds a WebGPU scene in a browser tab where one
can watch, chat back, interrupt, and approve permission requests.

Runs Claude Code first, by spawning the unmodified official `claude` binary under the user's own
login. kingfisher never reads, stores or forwards credentials. Other agents come later, through
adapters.

## Running it

```sh
cd web && pnpm install && pnpm run build && cd ..   # the page is embedded at compile time
cargo run -p kingfisherd -- --cwd ~/some/repo
```

It prints `http://127.0.0.1:7777/#t=<token>` and opens it. The token rides in the fragment and is
traded for an HttpOnly cookie on first load. `ANTHROPIC_API_KEY` is removed from the agent's
environment so the session runs on your own `claude` login; `--keep-api-key` opts out.

`--replay <file>` plays back a session archive (written to the platform data dir under
`kingfisher/sessions/`) or a bare `claude -p --output-format stream-json` capture, without
spending anything. Anything after `--` goes to `claude`.

`yatr ci` runs format check, clippy, tests and a release build.

## Status

Weekend MVP working, verified live on 2026-11-14 against Claude Code 2.1.325: streaming
transcript, chat, permission cards answered through the `PermissionRequest` HTTP hook, interrupt,
and resume. [docs/design-report.md](docs/design-report.md) is the founding research report.

Found in testing, against the report:

- SIGINT ends the turn and then the whole `claude -p` process exits. The daemon resumes the
  session with `--resume` on the next message, so the conversation survives; the restart costs a
  second or two.
- Thinking text arrives redacted. Only an estimated token count comes through, and that is what
  the transcript shows.
- An interrupted turn reports `total_cost_usd: 0` with no usage, so its cost is not counted.
  The gauge sums the per-process totals, on the unverified reading that `total_cost_usd` is a
  running total within one process.

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
