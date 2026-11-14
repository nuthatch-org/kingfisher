# kingfisher

A local, browser-based live view of coding agents at work. A Rust daemon on 127.0.0.1 owns the
agent process, normalises its event stream, and feeds a 3D workshop in a browser tab: each agent
is a small robot that walks to the bookshelf to read, the desk to edit, the terminal to run
commands, and so on, while the project fills the shelves as files appear. Helpers arrive through
a portal, permission requests put a spotlight on the robot asking, and from the same page one can
chat back, interrupt, and approve.

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

Every session is archived under the platform data dir in `kingfisher/sessions/`, observed ones
included. **library** in the top bar lists them; picking one replays it through the same scene and
transcript, with play, pause, 1× to 64× and a scrub bar. Idle gaps are squeezed to 2.5 s. Leaving
the replay returns to the live session where it was. `--replay <file>` does the same from the
command line, and also takes a bare `claude -p --output-format stream-json` capture. Anything
after `--` goes to `claude`.

### Switches

**ask me / autonomous** in the footer: while autonomous, the daemon approves every permission
request itself and logs each one as `auto-approved`. It starts off unless `--autonomous` is given,
and switching it on also releases anything already waiting. Claude Code's own deny rules still
apply. **banter** adds a standing instruction for absurd motoring-presenter asides in the agent's
replies, never in code, commits or files; it takes effect on the next message by resuming the
session.

### Watching from a phone

`--phone` adds a second, read-only listener on the local network at port+1, with its own token.
The daemon prints its address and a QR code, and the **phone** chip shows the same QR. That view
cannot prompt, approve, switch modes or take over, and anything it sends is dropped. It runs on
WebGL2 rather than WebGPU, because browsers only offer WebGPU on secure origins and a plain-http LAN
address is not one. macOS may ask once whether `kingfisherd` may accept incoming connections.

### Watching over Tailscale

`--tailscale` puts the same read-only view on your tailnet at `https://<machine>.<tailnet>.ts.net`
with a real certificate, reachable from anywhere on the tailnet, and with WebGPU, since that is a
secure origin. It runs `tailscale serve` in the foreground as a child process, so the route exists
only while the daemon runs and nothing is written to your Tailscale config. The watch listener then
binds to localhost only. `--tailscale-port` picks another HTTPS port than 443. On macOS the CLI
inside `Tailscale.app` is used when `tailscale` is not on the path.

### Watching sessions you started yourself

```sh
cargo run -p kingfisherd -- install-hooks      # shows what it will add to ~/.claude/settings.json, asks first
cargo run -p kingfisherd -- --observe
```

With the hooks installed, every Claude Code session on the machine reports to the daemon while it
runs: prompts, tool calls with diffs, results, the final reply, and permission prompts, which can
be answered from the browser or the terminal (whichever is first wins, and the other's card
withdraws). There is no token streaming for these, as hooks do not carry it. Once such a session
is closed in its terminal, **take over** continues it in the browser with `--resume`.
`uninstall-hooks` removes exactly kingfisher's entries; both commands back the file up first. With
the daemon stopped, the hooks fail open and Claude Code carries on as normal.

`yatr ci` runs format check, clippy, tests and a release build.

## Status

Verified live on 2026-11-14 against Claude Code 2.1.325: streaming transcript, chat, permission
cards answered through the `PermissionRequest` HTTP hook, interrupt and resume; and from v0.2,
observing a separately started session through hooks, approving its permission from the page,
and taking it over. [docs/design-report.md](docs/design-report.md) is the founding research report.

Not yet verified: the sound (built, never heard), the hang watchdog (`--watchdog-secs`, default
300; the hang it guards against was not reproduced), and how the scene performs on a large repo
or on Linux.

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
| Weekend MVP | Daemon spawns `claude -p` in bidirectional stream-json; `PermissionRequest` HTTP hook for approvals; workshop scene, transcript panel, chat, interrupt; NDJSON archive and replay |
| v0.2 | Done: global hooks to observe hand-started sessions; take over via `--resume`; timeline strip, diffs, sound, hang watchdog. Session library with scrubbing replay. Left: terminal pane |
| v0.3 | ACP and Codex adapters; multi-session; more themes; optional OTLP receiver |

## Before any public release

Re-read Anthropic's Claude Code legal page. The design relies on its carve-out for an end user
signing in to the unmodified binary with their own subscription, and that wording changed several
times in 2026.
