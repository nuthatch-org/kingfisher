# Agent Observatory: Design Report for a Local, Browser-Based, Eye-Candy Live View of Claude Code (and Other Agents)

**Yes, this can work, and you can build it today without breaking Anthropic's rules, provided your tool spawns the unmodified official `claude` binary under your own login and never handles the OAuth token itself.** Claude Code already streams structured, token-level JSON events (`claude -p --output-format stream-json --verbose --include-partial-messages`). It accepts follow-up user messages on stdin (`--input-format stream-json`), can be interrupted with SIGINT, and has documented HTTP hooks that can approve or deny permission requests from a local web server. A single Rust daemon on 127.0.0.1 can own the agent process, normalize events, and stream them to a WebGPU-rendered browser page. On your ThinkPad (RTX 2000 Ada, Debian 13), Chrome 147+ on Wayland enables WebGPU by default with a recent NVIDIA driver. Firefox on Linux still needs a flag.

## TL;DR

- **Feasible: yes.** Use a Rust daemon (axum/tokio) as the primary path. It spawns `claude -p` in bidirectional stream-json mode, so you get token deltas, thinking, tool calls, subagent messages, cost, follow-up prompts and SIGINT interrupts. For permission approvals, register a documented `PermissionRequest` HTTP hook that points back at the daemon. For terminal sessions you started yourself, use passive observation as the fallback: global HTTP hooks plus a tail of the transcript JSONL. This fallback is observe-and-approve only; you can't inject chat.
- **Subscription use is allowed if you stay on the right side of one line.** Anthropic's legal page says its restrictions do not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". What it forbids is third-party tools offering Claude.ai login, routing requests through Pro/Max credentials on behalf of users, or collecting or intermediating Claude.ai tokens. Anthropic's support article (updated October 7, 2026) says `claude -p` and the Agent SDK "still draw from your subscription limits" when you are signed in with your plan. An open-source release is fine on the same terms: each user runs their own `claude` login and the tool never touches credentials.
- **Recommended stack:** a Rust daemon, a TypeScript + Three.js `WebGPURenderer`/TSL frontend with automatic WebGL2 fallback, Rust→WASM for the event reducer and graph layout, ghostty-web for the embedded terminal, CodeMirror 6 for diffs, and Web Audio for sonification. The all-Rust alternative is Bevy or raw wgpu in WASM with an HTML overlay. It looks just as good but you'll ship more slowly and with larger bundles. Nobody yet ships "max eye candy + chat back + approve"; existing tools are either functional GUIs (CloudCLI, opcode, Conductor) or observe-only toys (Pixel Agents, Ctrl/Cubicles). That gap is your opening.

## Key Findings

1. **Claude Code's stream-json output covers everything the visualization needs, and it is documented.** The `system/init` event carries model, tools, MCP servers and a `capabilities` array (e.g. `interrupt_receipt_v1`). Next come `assistant`/`user` messages carrying `tool_use`/`tool_result` blocks, then `stream_event` text and thinking deltas (with `--include-partial-messages`), `system/api_retry` events, and a final `result` line with cost and session metadata. Subagent messages are tagged with `parent_tool_use_id`. `--forward-subagent-text` (v2.1.211+) adds subagent text and thinking, at every nesting depth from v2.1.219.
2. **Bidirectional control without the official SDK is partly documented and partly reverse-engineered.**
   - **Documented:** `--input-format stream-json` for queued user turns; SIGINT to end a turn; `--permission-prompt-tool` (an MCP tool); and `PermissionRequest` HTTP hooks.
   - **Undocumented:** the stdio `control_request`/`control_response` protocol (`initialize`, `can_use_tool`, `interrupt`) the SDKs use internally. Community Rust crates implement it.
3. **Passive observation of an interactive terminal session is possible but read-mostly.** HTTP hooks fire for 33 lifecycle events by my count of the event table in Anthropic's hooks reference (the page gives no total), including PreToolUse, PostToolUse, SubagentStart/Stop, PreCompact/PostCompact, PermissionRequest and Notification. The transcript JSONL holds the full content. Anthropic explicitly says the JSONL "entry format is internal to Claude Code and changes between versions". Hooks can approve permissions but cannot inject a new user prompt into a running TUI.
4. **Anthropic's own "Remote Control" relays through claude.ai/code, not localhost.** It is a great product, but it is not a local protocol you can build on.
5. **Linux WebGPU status on your machine:**
   - **Chrome:** WebGPU is on by default for NVIDIA from Chrome 147, on Wayland, with driver 535.183.01 or newer. X11 needs flags.
   - **Firefox:** WebGPU on Linux is enabled by default only in Nightly. The release channel (152+) has it behind `dom.webgpu.enabled`.
   - **Plan:** develop against Chrome on Wayland and keep a WebGL2 fallback.
6. **Prior art is fragmented, and much of it is stale.**
   - opcode (formerly Claudia) is effectively unmaintained: per amux.io (a competitor, checked October 28, 2026), its latest release is v0.2.0 from August 31, 2025 and the last code change landed October 13, 2025.
   - Bloop, the company behind Vibe Kanban, announced its shutdown on April 10, 2026, saying the project "will live on as open source and community maintained" (quoted by goodguyapps.com); its last tagged release is v0.1.44 (April 24, 2026).
   - Crystal was deprecated in February 2026 and replaced by Nimbalyst, per its GitHub README (final release v0.3.5).
   - CloudCLI is active (v1.37.0, July 2026).
   - Pixel-art "agent office" visualizers (Pixel Agents, Ctrl/Cubicles, PixelHQ) prove there is demand. All of them observe by tailing JSONL and offer no chat-back.

## Details

### 1. Feasibility verdict

**Yes.** The hard parts are already solved by Claude Code itself:

- **Live data:** stream-json is a stable, documented, line-delimited event stream with token-level deltas.
- **Follow-ups:** stream-json input mode keeps one process alive across turns. Messages written to stdin are queued and start new turns. The CLI reference notes that "with `--input-format stream-json`, a message still queued when the limit ends a turn stays queued and starts a new turn".
- **Interrupt:** the headless docs say "To end the turn instead, send SIGINT, or call the Agent SDK's `interrupt()`". SIGTERM instead exits with code 143 and leaves the turn unfinished.
- **Permission approvals:** a `PermissionRequest` hook of `type: "http"` POSTs the request to your daemon. Your daemon holds the HTTP response until you click Approve in the browser, then returns `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`. Anthropic's hooks reference gives HTTP hooks a default 600-second timeout, and the FlorianBruniaux claude-code-ultimate-guide on GitHub lists the same 600s default for PermissionRequest.
- **Rendering:** WebGPU compute-driven particle systems with hundreds of thousands of particles are routine in Three.js (the official compute-particles example simulates 200,000).

The only things that genuinely can't be done are (a) injecting chat into a TUI session you launched by hand in a terminal, and (b) doing anything without a local helper process, because browsers can't spawn `claude`.

### 2. Getting live data out of Claude Code, and sending data in

#### 2.1 Integration path comparison

| Path | Data granularity | Inject follow-ups | Interrupt | Approve permissions | Attach to existing interactive session | Stability |
|---|---|---|---|---|---|---|
| **`claude -p` stream-json in/out (daemon owns process)** | Token deltas (text and thinking), tool_use/tool_result, subagent messages, retries, cost/usage in `result` | Yes (stdin JSON user messages) | Yes (SIGINT; or undocumented `control_request` `interrupt`) | Yes, via HTTP `PermissionRequest` hook or `--permission-prompt-tool` | No (but can `--resume <id>` a past session) | Documented output; input contract under-documented (GitHub issue #44911) |
| **Official Agent SDK (TS/Python)** | Same as above, typed | Yes (streaming input mode, queued messages) | Yes (`interrupt()`) | Yes (`canUseTool`, hooks) | No (resume by session ID) | Fully documented; requires a Node/Python sidecar |
| **Community Rust SDKs** (`claude-agent-sdk-rs`, `claude-agents-sdk`, `claude-cli-sdk`, `ccwire`) | Same | Yes | Yes | Yes (`can_use_tool` callbacks) | No | Unofficial; track CLI internals |
| **HTTP hooks (global, `~/.claude/settings.json`)** | Per-lifecycle-event (33 events in the hooks reference), no token streaming | No (UserPromptSubmit can only add context or block) | No | **Yes** (PermissionRequest) | **Yes**, works for terminal, VS Code, any session | Documented |
| **Transcript JSONL tail (`~/.claude/projects/<proj>/<session>.jsonl`)** | Per-message, full content incl. tool I/O | No | No | No | **Yes**, passive | Explicitly unstable format |
| **OpenTelemetry export** | Metrics, events (prompt, api_request, tool_result, tool_decision), traces (beta) | No | No | No | Yes (env-var based) | Documented; traces beta |
| **Remote Control (`claude --remote-control`, `/rc`)** | Full UI, but at claude.ai/code | Yes | Yes | Yes | Yes | Official, but relays via Anthropic, not a local API |
| **ACP adapter (`@agentclientprotocol/claude-agent-acp`)** | ACP `session/update` stream | Yes | Yes (`session/cancel`) | Yes (`session/request_permission`) | No | Community/Zed-maintained wrapper over the Agent SDK |
| **PTY wrap of interactive `claude`** | Screen scrape plus JSONL | Yes (type into PTY) | Yes (Ctrl-C) | Yes (keystrokes) | No | Fragile; only for a "real terminal" pane |

#### 2.2 Path A, the primary path: the daemon owns a `claude -p` stream-json process

The minimal command for a live, steerable session:

```bash
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --include-hook-events \
  --replay-user-messages \
  --forward-subagent-text \
  --settings ./observatory-settings.json   # registers the PermissionRequest HTTP hook
```

Stdin user turn shape:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Now add tests for the parser"}]}}
```

This shape comes from earlier official headless docs. The current headless page does not spell out the input contract; GitHub issue #44911 asks Anthropic to document it.

Notes and gotchas from current docs:

- **Keep your subscription login.** Do not use `--bare`. The headless docs say that "in bare mode, Claude Code never reads OAuth credentials or the system keychain" and that it needs `ANTHROPIC_API_KEY`. Anthropic recommends `--bare` for scripts and says it "will become the default for `-p` in a future release". That is a real roadmap risk: if it happens, you would have to opt out explicitly to keep subscription auth. Watch the changelog.
- **Default permission mode in `-p`.** With v2.1.302 or later, `claude -p` starts in Manual mode, and calls that need approval are denied unless a `PermissionRequest` hook or `--permission-prompt-tool` approves them. This is exactly the hook your daemon will provide.
- **Without `--bare`, `-p` runs project hooks and MCP servers with no trust dialog.** The docs warn that `-p` "runs the hooks in a project's `.claude/settings.json` and connects the servers in its `.mcp.json`, even in a folder you've never trusted". Show a trust prompt in your UI before launching in a new repo.
- **Subagent tree reconstruction.** Follow `parent_tool_use_id`. A forked skill started from the prompt uses a `forked-command-` prefix.
- **Feature detection.** Read `capabilities` in `system/init` instead of comparing versions.
- **Known bug: hangs.** GitHub issue #53584 reports `-p` stream-json hanging indefinitely mid-stream. Build a watchdog that times out on no stream activity, then SIGINT, then resume.

For interrupts and permissions there are two layers. Use the **documented** one for v0.1: SIGINT, plus the `PermissionRequest` HTTP hook. The **undocumented** stdio control protocol is what the SDKs use: launch with `--permission-prompt-tool stdio`, send `{"type":"control_request","request_id":"…","request":{"subtype":"initialize"}}`, then receive `can_use_tool` requests and answer with `control_response`. It is reverse-engineered in community Rust crates such as `ccwire`, which is tested against CLI 2.1.296. Adopt it later behind a feature flag, gated on the `capabilities` array.

#### 2.3 Path B: the official Agent SDK as a sidecar

The TypeScript and Python Agent SDKs are the fully supported way to get streaming input mode, `interrupt()`, `canUseTool`, programmatic hooks, subagents, and session management (`listSessions()`/`getSessionMessages()`). If you want zero reverse-engineering risk, run a ~200-line Node sidecar using `@anthropic-ai/claude-agent-sdk` that speaks JSON over a Unix socket to the Rust daemon. When signed in with your plan, SDK usage draws from subscription limits; see section 3. No official Rust SDK exists. The community crates (`claude-agent-sdk-rs` v0.6.4 claims "100% feature parity with Python SDK") all wrap the CLI subprocess, so they inherit the same undocumented protocol risk.

#### 2.4 Path C, the fallback: observing sessions you started normally

Put HTTP hooks in `~/.claude/settings.json` pointing to `http://127.0.0.1:<port>/hook/<event>` with a bearer token via `allowedEnvVars`. The documented shape:

```json
{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"http","url":"http://127.0.0.1:7777/hook","timeout":5,"headers":{"Authorization":"Bearer $OBS_TOKEN"},"allowedEnvVars":["OBS_TOKEN"]}]}]}}
```

- **Event coverage.** You get every lifecycle event, from SessionStart/End through Pre/PostToolUse, PostToolBatch, SubagentStart/Stop, TaskCreated/Completed, Pre/PostCompact, FileChanged, CwdChanged, Notification and PermissionRequest. Each payload includes `session_id` and `transcript_path`.
- **No token streaming.** For assistant text you tail `transcript_path`. Docs warn it "is written asynchronously and may lag".
- **Approvals from the browser work.** For a hand-launched terminal session you can still approve PermissionRequest from the browser, and the docs say that hooks and other deciders run alongside each other and "whichever decides first applies".
- **No chat injection into the TUI.** For follow-ups, offer a "take over" button: once the terminal session is idle, the daemon runs `claude -p --resume <session_id> --input-format stream-json …`, which moves you to Path A. Two processes writing one session at the same time is untested territory, so the UI should require the terminal session to be stopped first.
- **Hook failure policy.** HTTP hooks default to `onFailure: "continue"`, so if the daemon is down Claude Code keeps working. Keep that default for observation hooks.

#### 2.5 Other channels

- **OpenTelemetry.** `CLAUDE_CODE_ENABLE_TELEMETRY=1` exports metrics such as `claude_code.token.usage` and `claude_code.cost.usage`, plus log events (`user_prompt`, `api_request`, `tool_result`, `tool_decision`). Traces need `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` and `OTEL_TRACES_EXPORTER=otlp`; span names may change. Content is opt-in via `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS` and similar flags. This is useful as a third input, because the daemon can be an OTLP/HTTP receiver on `localhost:4318` for cost and token gauges, but it is batched (export intervals measured in seconds), so it isn't good for animation timing.
- **Remote Control.** `claude --remote-control`/`--rc`, `/remote-control` in-session, or `claude remote-control` server mode connects a local session to claude.ai/code or the mobile app. It solves "steer from another device", but the transport goes through Anthropic, and it isn't a documented local API.
- **MCP.** Your daemon can expose an MCP server (`--mcp-config`) for two jobs: serving as the `--permission-prompt-tool`, and giving the agent tools that drive the visualization, e.g. a `show_plan` or `highlight_files` tool. It's a fun later feature, not a data source.
- **Status line.** Claude Code's status line command receives session JSON. It is an alternative cheap signal for context and cost in terminal sessions. Its exact fields were not re-verified for this report.

**Recommendation.** Primary is Path A, with the documented hooks for approvals. Fallback is Path C (hooks plus JSONL) for observing any session. Keep Path B (the official TS SDK sidecar) as the escape hatch if the undocumented control protocol breaks.

### 3. Subscription, auth and terms (late 2026)

What the official sources say:

- **Claude Code legal and compliance page:**
  - Scope of OAuth: "**OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
  - Developers: "Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication… Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."
  - Carve-out: "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription."
  - Usage limits: "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
  - Enforcement: "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."
- **Support article "Use the Claude Agent SDK with your Claude plan"** (update of October 7, 2026): "when you're signed in with your Claude plan, the Claude Agent SDK and claude -p still draw from your subscription limits." Separately, Max, Ultra and Team plans now include monthly API credits, which cover the SDK and `claude -p` only when run with an API key from a linked Console org.

**Timeline of the 2026 enforcement.** These dates come from press and secondary sources, not Anthropic primary documents.

| Date | Event |
|---|---|
| January 9, 2026 | Server-side blocking of subscription OAuth tokens in third-party clients that spoofed Claude Code (OpenCode, OpenClaw and others) |
| February 19–20, 2026 | The legal page stated that using subscription OAuth tokens "in any other product, tool, or service — including the Agent SDK — is not permitted" (The Register) |
| April 4, 2026 | Third-party harness usage stopped drawing on plan limits |
| May 2026 | Anthropic announced a separate Agent SDK credit starting June 15 |
| June 15, 2026 | That change was paused ("For now, nothing has changed") |
| October 7, 2026 | Current wording |

The February sentence explicitly naming the Agent SDK has since been rewritten. The current text is the "developers building products… should use API key" plus "unmodified binary" carve-out quoted above.

**What this means for your tool:**

- **Spawning the official `claude` binary locally, logged in with your own subscription:** permitted. This is the explicit carve-out, and it is the architecture recommended here.
- **Reading `~/.claude/.credentials.json`, extracting the OAuth token, or setting `CLAUDE_CODE_OAUTH_TOKEN` to call the Messages API directly from your own client:** prohibited. This is exactly what the January–April enforcement targeted.
- **Using the official Agent SDK with your own plan login for personal use:** the support article confirms it draws from subscription limits. The legal page still steers *developers building products* to API keys, so there is some tension (see Caveats).
- **Open-sourcing the tool:** fine if every user runs their own `claude` login through Anthropic's own flow and the tool never offers login, stores tokens or proxies requests. Do not host it as a service that runs sessions for others on one subscription. Don't use "Claude Code" or Anthropic marks in the product name or logo; the legal page allows plain-text statements like "runs Claude Code".

### 4. Prior art

| Tool | What it is | Data source | Stack | Status (late 2026) | Visual gap |
|---|---|---|---|---|---|
| **Claude Desktop (Code tab), claude.ai/code, VS Code extension** | Official GUIs: sessions, diffs, terminal, permissions, Remote Control | Native | Closed | Active; Desktop Linux build in beta since June 30, 2026 | Functional, not ambient or visual |
| **opcode (formerly Claudia)** | Desktop session manager, agents, usage analytics | Spawns CLI, reads sessions | Tauri 2 + Rust + React | ~22,400 stars, AGPL; last release v0.2.0 (August 31, 2025), last commit October 13, 2025 (amux.io) | Stale; no live visualization |
| **CloudCLI (claudecodeui)** | Self-hosted web/mobile UI for Claude Code, Codex, Cursor CLI | Spawns CLIs, reads CLI files | Node 22 + web | Active, v1.37.0 (July 29, 2026), AGPL | Chat/file UI only |
| **Conductor** | Parallel agents in worktrees (Mac) | Agent SDK with your Claude login | Desktop | Active, macOS only | Orchestration, not visualization |
| **Vibe Kanban** | Kanban board for many agents | Spawns CLIs | Rust + React | ~27k stars; Bloop shut down April 10, 2026, project now community-maintained (last release v0.1.44, April 24, 2026) | Board metaphor only |
| **Crystal** | Parallel Claude sessions in worktrees | Spawns CLI | Electron | Deprecated February 2026, replaced by Nimbalyst (stravu/crystal README) | n/a |
| **Happy (Happy Coder)** | Mobile/web client via `happy` wrapper | Wraps CLI | Open-source, native apps | Active | Remote chat, no viz |
| **Nimbalyst** | Kanban of sessions, diff review, mobile companion | SDK/CLI | Desktop (Mac/Win/Linux) | Active | Productivity UI |
| **Pixel Agents** (pablodelucca) | VS Code pixel-art office; one character per agent, subagent visualization, sounds | **Tails JSONL transcripts**, "purely observational" | React 19 + Canvas 2D webview | Active; README admits terminal-sync desyncs | No chat-back, no codebase map |
| **Ctrl/Cubicles** (bulletproof.sh) | Pixel office for Claude Code, Codex, Augment, plus web dashboard via local daemon | Local daemon | VS Code + web | Active | Same genre; observe-only |
| **PixelHQ** | iOS pixel office | Bridge on laptop watches session files | Native iOS | Active | Observe-only |
| **Zed Claude Agent (ACP)** | Editor-native agent panel | `@agentclientprotocol/claude-agent-acp` over Agent SDK | Rust (Zed) | Active (adapter v0.106.0 noted November 13, 2026) | Editor UI |
| **ccusage, claude-trace, sniffly** | Usage/cost from JSONL; HTTP traffic capture; transcript analytics | JSONL / request interception | CLI/HTML | Not re-verified for this report | Post-hoc, not live |
| **Langfuse, LangSmith, AgentOps, Arize Phoenix, LangWatch, SigNoz, Dash0** | Agent observability backends | OTel / SDK instrumentation | Web | Active (LangWatch, SigNoz, Dash0 publish Claude Code OTel guides) | Trace trees and dashboards, not ambient |

**The gap is real.** Nothing combines (a) a beautiful, GPU-driven live scene of the codebase and agent activity, (b) drill-down to real tool I/O and diffs, and (c) chat, interrupt and approve in the same page. The pixel offices prove people want to watch, but they bolt onto JSONL and can't steer. The steerable GUIs are dashboards.

**What to reuse:**
- the Pixel Agents event→animation mapping idea (it is MIT-licensed)
- the CloudCLI pattern of a local server plus browser (but avoid its AGPL code if you want a permissive license)
- opcode's Tauri packaging as a later option

### 5. Bleeding-edge browser tech for max eye candy

#### 5.1 WebGPU on your machine (Debian 13, RTX 2000 Ada)

From the gpuweb implementation-status wiki:

- **Chrome/Chromium on Linux:**
  - Default-on for Intel Gen12+ from Chrome 144.
  - Default-on for "NVIDIA (driver 535.183.01+) Wayland" from Chrome 147.
  - Every other combination, including NVIDIA on X11, is behind a flag: `--enable-unsafe-webgpu --ozone-platform=x11 --use-angle=vulkan --enable-features=Vulkan,VulkanFromANGLE`.
  - **Action:** run GNOME or KDE on Wayland with the proprietary NVIDIA driver. Check that `nvidia-smi` shows ≥535.183.01; Debian 13's packaged driver should qualify, but verify. Then confirm "WebGPU: Hardware accelerated" in `chrome://gpu`.
- **Firefox on Linux:** the wiki says enabled by default in Nightly, "not Stable/Beta. Mozilla expects to ship on Linux in 2026." A July 2026 gpuweb issue notes that Firefox 152 release works behind `dom.webgpu.enabled`. As of mid-November 2026 (Firefox 159.0.1), treat Firefox-on-Linux WebGPU as opt-in.
- **Spec:** W3C Candidate Recommendation Draft (September 15, 2026).

**Implication:** target Chrome as the primary dev browser, and make WebGL2 fallback a requirement, not a nice-to-have. Three.js's `WebGPURenderer` does this automatically, with TSL compiling to GLSL.

#### 5.2 Rendering engines

| Option | Wow ceiling | Dev velocity | Bundle | Linux reliability | Fit for you |
|---|---|---|---|---|---|
| **Three.js `WebGPURenderer` + TSL** | Very high (compute particles, node post-FX, bloom) | Highest; huge example corpus | Small (hundreds of KB) | Auto WebGL2 fallback | **Primary** |
| **Bevy (WASM + WebGPU)** | Very high | Medium (ECS is natural, but web UI/text/input integration is work) | Several MB to ~12–23 MB real-world; Bevy's own table shows 4.8 MB for a minimal example with fat LTO + wasm-opt | Bevy docs call WebGPU support "experimental"; WebGL2 build needed for Firefox | **Alternative** |
| **Raw wgpu → WASM** | Highest control | Slowest | Small–medium | Same as Bevy | Only for a bespoke renderer core |
| Babylon.js / PlayCanvas | High | High | Larger | Good | Viable, but less shader-art momentum than Three/TSL |
| PixiJS v8 (WebGPU) | High in 2D | High | Small | Good | Great for a 2D "pixel office" or minimal theme |
| Vello (Rust GPU 2D vectors) | High for crisp 2D UI | Medium | Medium | Needs WebGPU | Interesting for the timeline/river view |
| egui/eframe, Leptos, Dioxus, Yew, Makepad | — | — | — | — | Use for panels at most. Leptos is the best choice if you want Rust UI around a Three/WebGPU canvas |
| Rerun viewer | — | — | — | — | Inspiration for the timeline scrubber and the time-series + 3D layout. Embedding is overkill |

#### 5.3 Supporting web platform pieces

The status of each item below is from general knowledge and was not re-verified per browser for this report. Feature-detect each one.

- **Event transport:** WebSocket from the daemon (bidirectional, simple in axum). SSE is enough for read-only views. WebTransport needs HTTP/3 and certificates on localhost, which isn't worth it.
- **Workers:** move the event reducer and graph layout into a Worker. Use OffscreenCanvas so rendering never blocks on transcript parsing.
- **Threads:** SharedArrayBuffer needs COOP/COEP headers, which the daemon can set; localhost is a secure context.
- **WASM:** SIMD and threads are practical everywhere. WasmGC matters only for GC languages, not Rust. JSPI and Memory64 are not needed.
- **UI transitions:** the View Transitions API for panel and diff transitions, `@property` for animated CSS gradients and glows, Popover plus anchor positioning for tool-call tooltips, and scroll-driven animations for the replay timeline.
- **Sonification:** Web Audio, with low-pass ambient tones for thinking, clicks for reads, chords for edits, and percussion for bash.
- **Semantic map:** local embeddings via WebGPU (e.g. transformers.js) or WebNN, to lay files out by meaning. This is optional, v0.3.
- **Terminal:** ghostty-web runs Ghostty's VT parser compiled to WASM behind an xterm.js-compatible API (~400 KB). Alternatively use xterm.js with its WebGL renderer.
- **Code and diffs:** CodeMirror 6 with `@codemirror/merge`, or Monaco's diff editor. Use Shiki for highlighted read-only snippets and tree-sitter WASM for symbol-level nodes.
- **Graph layout:** cosmos.gl/Cosmograph-style GPU force layout, or your own WGSL force-directed compute pass. Sigma.js or deck.gl work for a 2D "map" theme.
- **Motion:** GSAP (now free) or Motion for UI chrome. Theatre.js for authored camera moves. Rive for character animation in the pixel/office theme.

**Recommended primary stack:**
- **Daemon:** Rust (tokio, axum, serde, notify for JSONL tailing, rusqlite for the session store).
- **Frontend:** Vite + TypeScript + Svelte 5 (or Solid) for panels; Three.js `WebGPURenderer` + TSL for the scene.
- **WASM core:** a Rust→WASM crate, shared with the daemon, for the event schema, the reducer (event → scene state) and force layout.
- **Embeds:** ghostty-web, CodeMirror 6 merge view and Web Audio.

This gives you Rust where correctness matters (schema, reducer, process control, security) and the largest shader and post-FX ecosystem for the wow factor.

**Alternative:** the same Rust daemon with Bevy-on-WASM for the scene and Leptos or plain HTML panels around it. Choose this if you'd rather write ECS systems than TSL. Expect bigger bundles, the extra Firefox WebGL2 build, and more glue for text and DOM overlays.

### 6. Visualization concepts mapped to real events

**The shared mapping (theme-independent):**

| Claude Code signal | Scene primitive |
|---|---|
| `system/init` (model, tools, MCP servers) | World spawn: the agent "core" appears; MCP servers as orbiting stations |
| `stream_event` thinking deltas | Thinking field intensity, driven by delta rate |
| `stream_event` text deltas | Speech ribbon or caption stream from the agent; typewriter in the side panel |
| `tool_use` Read/Grep/Glob | Agent emits a probe/comet to the file node; node lights up (heat decays over time) |
| `tool_use` Edit/Write → `tool_result` | Node pulses and grows; diff card materializes and is clickable |
| `tool_use` Bash | Comet to a "shell" station; live ghostty-web pane opens; exit code colors the impact |
| Test command detected (cargo test, pytest, etc.) | Pass becomes fireworks or bloom burst; failure becomes a screen-shake tremor and a red shockwave |
| Agent/Task tool (`parent_tool_use_id` tree) | Subagent satellites spawned from the core with their own trails; despawn on SubagentStop |
| PermissionRequest | Time-dilation effect: scene slows and desaturates; approval card pulses at center |
| `result` (cost, usage) / OTel token metrics | Ambient gauges: context reservoir level, cost meter |
| PreCompact/PostCompact | Reservoir "drains and crystallizes", a visible compaction event |
| `system/api_retry` | Static or flicker on the link to the cloud; retry countdown |
| Notification / Stop | Agent idles; gentle breathing animation; "your turn" chime |

**Themes:**

1. **Cosmic (recommended for the MVP).** Files are stars clustered by directory, forming galaxies. The agent is a bright core, tool calls are comets, thinking is a nebula/aurora shader around the core, and subagents are moons. Why it suits the MVP: point sprites, bloom and additive blending look stunning with little geometry work, it scales to thousands of nodes with instanced points, and it degrades gracefully to WebGL2.
2. **Cyber-city.** The repo is a CodeCity-style city: directories are districts and files are buildings whose height is LOC. Edits raise scaffolding and neon, and the agent is a drone. It is more geometry work, and the most legible for big repos.
3. **Bioluminescent.** The codebase is a coral/mycelium network. Reads send light pulses along hyphae, edits make polyps bloom, and thinking is plankton swirl. This is beautiful with GPU particles and flow fields.
4. **Pixel office.** Tile office in PixiJS with one character per agent or subagent. It is cosy, proven popular, and cheap, a good "second theme".
5. **Minimal zen.** Monochrome ink-wash timeline river with Gource-style file tree, very calm, low GPU. This is the default for battery use.

**Keeping it informative, not just pretty:**
- Every visual element is a handle to a real event ID. Click a comet to open the exact `tool_use` input and `tool_result` output. Click a node to see its file history in this session. Click a diff card to open the CodeMirror merge view.
- A persistent right-hand transcript panel shows streaming text and thinking (collapsible).
- A bottom **timeline river** shows all events as glyphs on a scrubbable time axis. Replay re-feeds recorded events through the same reducer.
- A **chat dock** holds the follow-up input. Messages typed during a turn are queued, which matches stream-json input semantics, and shown as "pending" orbs.
- An **Interrupt** button sends SIGINT and shows the scene "freezing".
- **Approve/Deny** cards appear on PermissionRequest, with the full command or diff, an "always allow this" option, and keyboard shortcuts.

### 7. Architecture

```
┌──────────────── Browser (localhost:7777) ───────────────┐
│ Svelte panels │ Three.js WebGPU scene │ ghostty-web │ CM6 │
│        ▲ Worker: Rust→WASM reducer + layout (shared crate)│
└────────┼──────────── WebSocket (token-authenticated) ─────┘
         │
┌────────┴───────── observatoryd (Rust, axum/tokio) ────────┐
│ Static assets (embedded) │ Session store (SQLite + raw    │
│ Normalizer → AgentEvent   │   NDJSON archive for replay)  │
│ Adapters:                                                  │
│  • ClaudeStreamJson (owns `claude -p` child, stdin/stdout) │
│  • ClaudeHooks (HTTP hook receiver: observe + approve)     │
│  • ClaudeTranscriptTail (notify on ~/.claude/projects)     │
│  • OtlpReceiver (optional, :4318)                          │
│  • AcpClient (any ACP agent: Gemini CLI, Codex adapter…)   │
│  • Codex/OpenCode/Aider/custom-Rust adapters (later)       │
└────────────────────────────────────────────────────────────┘
```

**Why there must be a daemon.** A pure browser can't spawn processes. The File System Access API could tail JSONL, but only with a user gesture per directory and without hooks, chat or approvals. WebContainers run Node in-browser, not your real `claude`. A browser extension with native messaging still needs a native host binary. So a tiny daemon is the honest minimum. Tauri is a good v1.0 wrapper for a dock icon and tray, but the browser-tab approach keeps the "fully local web" promise and lets you use Chrome's WebGPU.

**Event schema (agent-agnostic, versioned):**

```rust
struct AgentEvent {
  v: u16, id: Ulid, ts: i64, session: SessionId,
  agent: AgentRef { kind: "claude-code", instance: u32, parent: Option<AgentRefId> },
  seq: u64, causal_parent: Option<Ulid>,   // e.g. tool_result → tool_use
  body: EventBody,                          // enum below
  raw: Option<Box<RawValue>>,               // original JSON line for drill-down/replay fidelity
}
enum EventBody {
  SessionStarted{model, cwd, tools, mcp}, TurnStarted{by: User|Agent},
  TextDelta{text}, ThinkingDelta{text}, MessageComplete{role, text},
  ToolCall{call_id, tool, kind: Read|Write|Edit|Search|Shell|Web|Agent|Mcp|Other, input, paths},
  ToolResult{call_id, ok, output_summary, exit_code}, FileTouched{path, op},
  SubagentSpawned{call_id, name}, SubagentEnded{call_id},
  PermissionRequested{req_id, tool, input}, PermissionResolved{req_id, decision},
  Usage{input_tokens, output_tokens, cache, cost_usd, context_pct}, Compaction{phase},
  Retry{attempt, delay_ms, error}, TurnEnded{reason}, Error{..}, Notice{..},
}
```

Keep `raw` so the UI can always show ground truth, and so you can re-normalize old recordings when the schema evolves.

**Should ACP be the internal model?** No. Implement an ACP client adapter, but don't make ACP your schema. ACP is designed for editor↔agent request/response UX. Your viewer needs a superset: cost and context gauges, retries, compaction, hook events, and multi-session/multi-agent fan-in from passive sources that have no ACP session at all. ACP's `session/update`, `request_permission` and `cancel` map cleanly into `AgentEvent`. An ACP client adapter is high leverage: it brings in Gemini CLI, Copilot CLI and adapted Codex, and Claude via `@agentclientprotocol/claude-agent-acp`, with one adapter. ACP field details were not re-verified for this report.

**Persistence and replay.** Append every raw line and normalized event to `~/.local/share/observatory/sessions/<id>.ndjson.zst` plus a SQLite index. Replay streams events through the same WebSocket with a virtual clock (1×, 4×, 16×, scrub). The same mechanism gives you a demo mode with no agent running.

**Multi-session and multi-agent.** Each adapter instance gets an `agent.instance`. Show sessions as separate galaxies or districts sharing one camera, or as split views. Subagents are children via `parent_tool_use_id`.

**Localhost security.** The daemon can drive an agent with shell access, so treat it like an SSH endpoint:
- Bind `127.0.0.1` (and `::1`) only; never `0.0.0.0`.
- Generate a random 256-bit token at startup. Open the browser at `http://127.0.0.1:7777/#t=<token>`; a fragment never reaches server logs. The page exchanges it for an HttpOnly, SameSite=Strict cookie.
- **DNS-rebinding protection:** reject any request whose `Host` header isn't exactly `127.0.0.1:<port>` or `localhost:<port>`.
- **WebSocket:** check `Origin` equals your own origin. Send no CORS headers at all.
- Use a strict CSP (`default-src 'self'`; `connect-src 'self'`), with COOP/COEP for SharedArrayBuffer.
- Authenticate the hook endpoint separately: a bearer token via `allowedEnvVars`, plus Anthropic's `allowedHttpHookUrls` setting.
- Never read `~/.claude/.credentials.json`, never log prompts to anything but local disk, and default `--permission-mode` to Manual so the browser is the approver.

**Performance budget (60–120 fps):**
- One instanced draw for all file nodes (10k+ is fine) and one GPU particle buffer for comets and sparks, simulated in a WGSL/TSL compute pass.
- Force layout runs in compute or in a WASM worker, then freezes when stable.
- Bloom at half resolution.
- Batch events per animation frame on the main thread. Text deltas go to the DOM panel, not the canvas.
- Cap heat-map updates with decay textures rather than per-node JS animation.
- Dynamic resolution scale if frame time exceeds 8 ms on 120 Hz panels.
- Keep the terminal and diff editors in DOM layers over the canvas.

**Adapters for other agents:**
- **Codex CLI:** `codex exec --json` JSONL events.
- **OpenCode:** server/SDK JSON API.
- **Gemini CLI or Antigravity CLI:** via ACP. Google's consumer CLI changed in 2026, so verify the current one.
- **Aider:** PTY plus its chat-history file.
- **Custom Rust agents or local open-weight agents:** emit `AgentEvent` directly over a Unix socket. This is the cleanest path, so publish the schema crate.

### 8. MVP plan

**Weekend MVP: "it's alive"**

1. Create the Rust crate `observatoryd`: axum server on 127.0.0.1, token auth, Host/Origin checks, embedded static assets.
2. Spawn the child process:
   `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --forward-subagent-text --settings ./obs-settings.json`
   - Do not set `ANTHROPIC_API_KEY`; that keeps your subscription login.
   - Do not pass `--bare`.
   - Write user turns as JSON lines to stdin.
   - Map Interrupt to `kill -INT <pid>`.
3. Point an `obs-settings.json` `PermissionRequest` HTTP hook at `http://127.0.0.1:7777/hook/permission`. The handler parks the request on a oneshot channel until the browser answers, and returns the `decision` JSON.
4. Normalize events into `AgentEvent`. Archive raw NDJSON.
5. Frontend:
   - **Scene:** a Vite + Three.js `WebGPURenderer` page with the cosmic theme. Build file nodes from `git ls-files` (served by the daemon). Comets go from the core to nodes on tool calls, heat decays, and the nebula intensity follows the thinking-delta rate.
   - **Panels:** a streaming transcript side panel, a chat box, and Interrupt and Approve/Deny cards.
6. **Smoke test:**
   `claude -p "List the files in src and summarize one" --output-format stream-json --verbose --include-partial-messages | tee first.ndjson`
   Then pipe `first.ndjson` into the replay endpoint to iterate on visuals without spending tokens.

**v0.2: "watch anything"**
- A global HTTP-hooks installer (`observatoryd install-hooks` edits `~/.claude/settings.json` with consent) and a JSONL tailer, to observe and approve hand-started terminal and VS Code sessions.
- A "take over" button using `--resume`.
- A session library with replay and scrubbing, the timeline river, the CodeMirror merge view, and the ghostty-web Bash pane.
- Subagent satellites, context reservoir and compaction animation, and Web Audio sonification.
- A watchdog for the stream-json hang bug.

**v0.3: "many agents, many worlds"**
- The ACP client adapter and a Codex `exec --json` adapter.
- Multi-session galaxies and the cyber-city and pixel-office themes.
- An optional OTLP receiver.
- Semantic layout from local embeddings.
- The stdio control-protocol backend (feature-flagged on `capabilities`) or the official TS SDK sidecar, for richer permission suggestions and mode switching.
- An MCP server that lets the agent "annotate" the scene.
- Optional Tauri packaging.

**Key risks:**

| Risk | Likelihood | Mitigation |
|---|---|---|
| CLI event-shape drift | Medium | Keep `raw`, feature-detect via `capabilities`, pin a tested CLI version in CI |
| `--bare` becoming the `-p` default | Announced | Detect auth mode at `system/init`; keep a flag to opt out |
| Policy tightening | Low–medium | Never touch credentials; keep the API-key path one toggle away |
| Firefox Linux WebGPU | Certain for now | WebGL2 fallback |
| Undocumented control protocol | Medium | Stay on documented SIGINT + hooks for v0.1 |

## Recommendations

1. **Build Path A first.** That means a Rust daemon spawning `claude -p` in bidirectional stream-json mode, with a `PermissionRequest` HTTP hook for approvals. It uses only documented mechanisms and your subscription login, legitimately.
2. **Add Path C** (global HTTP hooks plus JSONL tail) **in v0.2** so the viewer is useful for every session, even ones you start in a terminal.
3. **Frontend:** Three.js `WebGPURenderer` + TSL, with a shared Rust→WASM reducer crate. Develop on Chrome under Wayland with the proprietary NVIDIA driver, and ship a WebGL2 fallback from day one.
4. **Start with the Cosmic theme.** Make every glyph clickable down to the raw event.
5. **Own your schema (`AgentEvent`) and treat ACP as an adapter**, not the core model.
6. **Credentials and branding:** never read, store or forward Claude credentials. Don't put "Claude" in the product name. If you open-source it, document that each user must log in with `claude` themselves.

## Caveats

- **Terms tension.** The legal page's "Developers building products… including those using the Agent SDK, should use API key authentication" sits next to the carve-out for end users signing in to the unmodified binary, and next to the support article confirming that SDK and `claude -p` usage draws from plan limits. A personal or open-source local wrapper around the official binary fits the carve-out as written. Anthropic has changed this wording several times in 2026 and "may [enforce] without prior notice". Re-check the legal page before any public release. If in doubt, Anthropic's page says to contact sales.
- **Dates from secondary sources.** The enforcement timeline (January 9, April 4, the May announcement) is from press and blogs. The current policy text and the October 7 support-article update are quoted from Anthropic directly.
- **Undocumented control protocol.** The stdio protocol (`control_request`, `can_use_tool`, `interrupt`, `--permission-prompt-tool stdio`) is reverse-engineered. The return schema of `--permission-prompt-tool` MCP tools is under-documented (GitHub issue #24595).
- **Unstable transcript format.** Anthropic says the JSONL format can break on any release; use it only as a best-effort fallback.
- **Unverified items:** prior-art project statuses from single secondary sources (Vibe Kanban shutdown, Crystal deprecation), ccusage, claude-trace and sniffly details, ACP field names, and the per-browser status of the smaller web-platform features in section 5.3.
- **Fast-moving version numbers.** Claude Code minimum-version notes (v2.1.2xx–v2.1.302) are from the current docs; check `claude --version`.
