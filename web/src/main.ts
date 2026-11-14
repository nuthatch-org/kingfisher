import './style.css';
import { Observatory } from './scene';
import { authenticate, connect, fetchFiles, type Link } from './net';
import { KIND_COLOR, KIND_GLYPH, TEST_COMMAND } from './palette';
import type { AgentEvent, ToolKind } from './types';
import { editsOf, renderDiff } from './diff';
import { Sonifier } from './sound';
import { Player, listSessions, type Session } from './player';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = (tag: string, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

interface ToolEntry {
  row: HTMLElement;
  tick: HTMLElement;
  kind: ToolKind;
  tool: string;
  paths: string[];
  test: boolean;
  parent: string | null;
}

interface Touch {
  tool: string;
  kind: ToolKind;
  ok: boolean | null;
  ts: number;
  row: HTMLElement;
}

class App {
  private link!: Link;
  private log = $('log');
  private streamEl: HTMLElement | null = null;
  private streamBuf = '';
  private thinkEl: HTMLElement | null = null;
  private thinkBuf = '';
  private thinkSummary: HTMLElement | null = null;
  private thinkTokens = 0;
  private flushQueued = false;
  private tools = new Map<string, ToolEntry>();
  private touches = new Map<string, Touch[]>();
  private perms = new Map<string, HTMLElement>();
  private busy = false;
  private contextTokens = 0;
  private contextWindow = 0;
  /** total_cost_usd climbs within one claude process; a resume starts it again from zero. */
  private priorCost = 0;
  private processCost = 0;
  private root = '';
  private river = $('river');
  private lastSession: string | null = null;
  readonly sound = new Sonifier();
  /** Set by main: an observed session living in another repository swaps the sky to it. */
  onCwd: (cwd: string) => void = () => {};

  constructor(private scene: Observatory) {}

  bind(link: Link) {
    this.link = link;
    const input = $<HTMLTextAreaElement>('prompt');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
    });
    $('send').addEventListener('click', () => this.submit());
    $('interrupt').addEventListener('click', () => this.link.send({ type: 'interrupt' }));
    document.addEventListener('keydown', (e) => {
      const first = this.perms.keys().next().value as string | undefined;
      const typing = document.activeElement === input && input.value.length > 0;
      if (first && !typing && (e.key === 'y' || e.key === 'n')) {
        e.preventDefault();
        this.decide(first, e.key === 'y');
      } else if (e.key === 'Escape' && this.busy) {
        this.link.send({ type: 'interrupt' });
      }
    });
    $('drawer-close').addEventListener('click', () => $('drawer').classList.remove('open'));
    $('sound').addEventListener('click', () => {
      const on = this.sound.toggle();
      $('sound').textContent = on ? 'sound on' : 'sound off';
      $('sound').className = on ? 'chip ok' : 'chip dim';
    });
  }

  private submit() {
    const input = $<HTMLTextAreaElement>('prompt');
    const text = input.value.trim();
    if (!text) return;
    this.link.send({ type: 'prompt', text });
    input.value = '';
  }

  private decide(reqId: string, allow: boolean) {
    this.link.send({ type: 'permission', req_id: reqId, allow });
    this.perms.get(reqId)?.classList.add('answered');
  }

  setRoot(root: string) {
    this.root = root.replace(/\/$/, '');
  }

  reset() {
    this.log.replaceChildren();
    this.streamEl = this.thinkEl = null;
    this.streamBuf = this.thinkBuf = '';
    this.tools.clear();
    this.touches.clear();
    this.river.replaceChildren();
    this.lastSession = null;
    this.priorCost = this.processCost = 0;
    this.contextTokens = this.contextWindow = 0;
    $('ctx-fill').style.width = '0';
    $('ctx').textContent = '–';
    $('cost').textContent = '–';
    $('model').textContent = 'no session yet';
    $('cwd').textContent = '…';
    $('auth').textContent = 'auth ?';
    $('auth').className = 'chip';
    this.observed.clear();
    this.setBusy(false);
    for (const p of this.perms.values()) p.remove();
    this.perms.clear();
    this.scene.reset();
    this.scene.setWaiting(false);
  }

  // ------------------------------------------------------------------ reducer

  apply(events: AgentEvent[], backlog: boolean) {
    if (backlog) this.reset();
    const live = !backlog;
    const stick = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 80;
    for (const e of events) this.one(e, live);
    this.queueFlush();
    if (stick || backlog) requestAnimationFrame(() => (this.log.scrollTop = this.log.scrollHeight));
  }

  private one(e: AgentEvent, live: boolean) {
    const b = e.body;
    const sub = e.parent !== null;
    if (e.session && this.lastSession && e.session !== this.lastSession && b.type !== 'session_started') {
      this.endStream();
      this.divider(e.session, false);
    }
    if (e.session) this.lastSession = e.session;
    switch (b.type) {
      case 'session_started': {
        // Hook-observed sessions carry no auth source; only stream-json sessions report one.
        const observed = b.api_key_source === null;
        if (e.session) {
          if (observed) this.observed.add(e.session);
          else this.observed.delete(e.session);
        }
        $('model').textContent = b.model;
        $('cwd').textContent = b.cwd.split('/').pop() || b.cwd;
        $('cwd').title = b.cwd;
        const auth = $('auth');
        if (observed) {
          auth.textContent = 'observed';
          auth.className = 'chip dim';
        } else {
          const subscription = b.api_key_source === 'none';
          auth.textContent = subscription ? 'subscription' : `api key: ${b.api_key_source}`;
          auth.className = subscription ? 'chip ok' : 'chip warn';
        }
        if (b.version) $('version').textContent = `claude ${b.version}`;
        if (!sub && e.session) {
          this.endStream();
          this.divider(e.session, observed, `${b.cwd.split('/').pop() || b.cwd} · ${b.permission_mode ?? 'default'} permissions`);
        }
        if (b.cwd && b.cwd.replace(/\/$/, '') !== this.root) this.onCwd(b.cwd);
        break;
      }
      case 'session_ended':
        this.endStream();
        this.setBusy(false);
        this.notice(`session ended${b.reason ? ` (${b.reason})` : ''}`);
        break;
      case 'permission_withdrawn': {
        this.perms.get(b.req_id)?.remove();
        this.perms.delete(b.req_id);
        this.notice('answered elsewhere');
        this.scene.setWaiting(this.perms.size > 0);
        break;
      }
      case 'turn_started':
        this.endStream();
        this.entry('user', b.text);
        this.setBusy(true);
        this.river.append(el('span', 'turn'));
        if (live) this.scene.turnStarted();
        break;
      case 'thinking_delta':
        if (!this.thinkEl) {
          this.endStream();
          const d = el('details', 'think' + (sub ? ' sub' : '')) as HTMLDetailsElement;
          this.thinkSummary = el('summary', '', 'thinking');
          d.append(this.thinkSummary, el('div', 'body'));
          this.log.append(d);
          this.thinkEl = d.querySelector('.body');
          this.thinkTokens = 0;
        }
        this.thinkBuf += b.text;
        if (live) this.sound.thinking();
        if (b.estimated_tokens && b.estimated_tokens > this.thinkTokens) {
          this.thinkTokens = b.estimated_tokens;
          if (this.thinkSummary) this.thinkSummary.textContent = `thinking · ~${fmt(this.thinkTokens)} tokens`;
        }
        if (live) this.scene.thinking();
        break;
      case 'text_delta':
        this.thinkEl = null;
        this.thinkBuf = '';
        if (!this.streamEl) this.streamEl = this.entry(sub ? 'agent sub' : 'agent', '');
        this.streamBuf += b.text;
        if (live) this.scene.speaking();
        break;
      case 'message_complete':
        if (this.streamEl) {
          this.streamBuf = b.text;
          this.queueFlush();
          this.streamEl = null;
          this.streamBuf = '';
        } else {
          this.entry(sub ? 'agent sub' : 'agent', b.text);
        }
        this.thinkEl = null;
        this.thinkBuf = '';
        break;
      case 'tool_call': {
        this.endStream();
        const command = typeof b.input?.command === 'string' ? b.input.command : '';
        const row = this.toolRow(b.tool, b.kind, b.input, sub);
        const tick = this.tick(row, b.kind, b.tool, b.input);
        if (live) this.sound.tool(b.kind);
        const entry: ToolEntry = { row, tick, kind: b.kind, tool: b.tool, paths: b.paths, test: TEST_COMMAND.test(command), parent: e.parent };
        this.tools.set(b.call_id, entry);
        for (const p of b.paths) {
          const key = this.rel(p);
          const list = this.touches.get(key) ?? [];
          list.push({ tool: b.tool, kind: b.kind, ok: null, ts: e.ts, row });
          this.touches.set(key, list);
        }
        this.scene.toolCall(b.kind, b.paths, b.input, e.parent, live);
        if (b.kind === 'agent' && live) this.scene.spawnMoon(b.call_id);
        break;
      }
      case 'tool_result': {
        const t = this.tools.get(b.call_id);
        if (!t) break;
        t.row.classList.add(b.ok ? 'ok' : 'err');
        t.tick.classList.add(b.ok ? 'ok' : 'err');
        if (live && t.test) b.ok ? this.sound.testsPassed() : this.sound.failure();
        else if (live && !b.ok) this.sound.failure();
        const out = el('pre', 'result', b.summary || (b.ok ? '(no output)' : '(failed)'));
        t.row.querySelector('.detail')?.append(out);
        for (const p of t.paths) {
          const last = this.touches.get(this.rel(p))?.findLast((x) => x.row === t.row);
          if (last) last.ok = b.ok;
        }
        if (t.kind === 'agent') this.scene.endMoon(b.call_id);
        if (live) this.scene.toolResult(b.ok, t.kind, t.paths, t.test);
        break;
      }
      case 'usage':
        if (!sub) {
          this.contextTokens = b.context_tokens;
          this.gauges();
        }
        break;
      case 'rate_limit':
        if (b.utilization !== null) {
          $('rate').textContent = `${Math.round(b.utilization * 100)}% ${b.window?.replace('_', ' ') ?? ''}`;
          $('rate').title = b.resets_at ? `resets ${new Date(b.resets_at * 1000).toLocaleString()}` : '';
        }
        break;
      case 'turn_ended':
        this.endStream();
        if (b.context_window) this.contextWindow = b.context_window;
        if (b.cost_usd !== null) {
          this.processCost = b.cost_usd;
          $('cost').textContent = `$${(this.priorCost + this.processCost).toFixed(2)}`;
        }
        this.gauges();
        this.setBusy(false);
        if (live) this.sound.yourTurn();
        if (!b.ok) this.notice(`turn ended: ${b.reason ?? 'error'}`, 'warn');
        break;
      case 'permission_requested':
        this.permission(b.req_id, b.tool, b.input);
        if (live) this.sound.permission();
        break;
      case 'permission_resolved': {
        const card = this.perms.get(b.req_id);
        card?.remove();
        this.perms.delete(b.req_id);
        this.notice(`${b.allow ? 'allowed' : 'denied'}`, b.allow ? '' : 'warn');
        this.scene.setWaiting(this.perms.size > 0);
        break;
      }
      case 'retry':
        this.notice(`retrying${b.attempt ? ` (attempt ${b.attempt})` : ''}${b.error ? `: ${b.error}` : ''}`, 'warn');
        break;
      case 'compaction':
        this.notice('context compacted');
        if (live) this.scene.compaction();
        break;
      case 'agent_exited':
        this.priorCost += this.processCost;
        this.processCost = 0;
        this.endStream();
        this.setBusy(false);
        this.notice(`agent exited${b.code !== null ? ` (${b.code})` : ''}; the next message resumes it`, 'warn');
        break;
      case 'notice':
        this.notice(b.text);
        break;
      case 'status':
      case 'hook':
      case 'unknown':
        break;
    }
  }

  // ------------------------------------------------------------------ rendering

  private rel(p: string) {
    return this.root && p.startsWith(this.root + '/') ? p.slice(this.root.length + 1) : p;
  }

  private entry(cls: string, text: string): HTMLElement {
    const e = el('div', `entry ${cls}`, text);
    this.log.append(e);
    return e;
  }

  private notice(text: string, cls = '') {
    this.entry(`notice ${cls}`, text);
  }

  private endStream() {
    this.queueFlush();
    this.streamEl = null;
    this.thinkEl = null;
  }

  /** Deltas arrive faster than layout can keep up with; write them to the DOM once per frame. */
  private queueFlush() {
    const s = this.streamEl;
    const sb = this.streamBuf;
    const t = this.thinkEl;
    const tb = this.thinkBuf;
    if (s) s.textContent = sb;
    if (t) t.textContent = tb;
    if (this.flushQueued) return;
    this.flushQueued = true;
    requestAnimationFrame(() => {
      this.flushQueued = false;
      if (this.streamEl) this.streamEl.textContent = this.streamBuf;
      if (this.thinkEl) this.thinkEl.textContent = this.thinkBuf;
    });
  }

  private toolRow(tool: string, kind: ToolKind, input: any, sub: boolean): HTMLElement {
    const row = el('div', `entry tool${sub ? ' sub' : ''}`);
    row.style.setProperty('--kind', KIND_COLOR[kind]);
    const head = el('div', 'head');
    head.append(el('span', 'glyph', KIND_GLYPH[kind]), el('span', 'name', tool), el('span', 'arg', describe(tool, input, this.root)));
    const detail = el('div', 'detail');
    const edits = editsOf(tool, input);
    if (edits?.length) {
      if (typeof input.file_path === 'string') detail.append(el('div', 'diff-path', this.rel(input.file_path)));
      detail.append(renderDiff(edits));
      if (kind === 'edit' || kind === 'write') row.classList.add('open');
    } else {
      detail.append(el('pre', 'input', JSON.stringify(input, null, 2)));
    }
    row.append(head, detail);
    head.addEventListener('click', () => row.classList.toggle('open'));
    this.log.append(row);
    return row;
  }

  private divider(session: string, observed: boolean, label = '') {
    const d = el('div', 'session');
    d.append(el('span', 'sid', `session ${session.slice(0, 8)}`), el('span', 'what', label));
    if (observed) {
      const b = el('button', 'takeover', 'take over');
      b.title = 'Continue this session here with --resume. Close it in the terminal first.';
      b.addEventListener('click', () => this.link.send({ type: 'take_over', session }));
      d.append(b);
    }
    this.log.append(d);
  }

  private tick(row: HTMLElement, kind: ToolKind, tool: string, input: any): HTMLElement {
    const t = el('span', 'tick');
    t.style.setProperty('--kind', KIND_COLOR[kind]);
    t.title = `${tool} ${describe(tool, input, this.root)}`;
    t.addEventListener('click', () => {
      row.classList.add('open', 'flash');
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => row.classList.remove('flash'), 1200);
    });
    this.river.append(t);
    this.river.scrollLeft = this.river.scrollWidth;
    return t;
  }

  private permission(reqId: string, tool: string, input: any) {
    const card = el('div', 'perm');
    card.append(el('div', 'perm-title', `${tool} wants permission`));
    if (typeof input?.command === 'string') {
      card.append(el('pre', 'perm-cmd', input.command));
      if (input.description) card.append(el('div', 'perm-desc', input.description));
    } else if (editsOf(tool, input)?.length) {
      card.append(el('div', 'perm-desc', this.rel(input.file_path ?? '')));
      card.append(renderDiff(editsOf(tool, input)!));
    } else {
      if (input?.file_path) card.append(el('div', 'perm-desc', this.rel(input.file_path)));
      card.append(el('pre', 'perm-cmd', JSON.stringify(input, null, 2)));
    }
    const actions = el('div', 'perm-actions');
    const allow = el('button', 'allow', 'Allow  y');
    const deny = el('button', 'deny', 'Deny  n');
    allow.addEventListener('click', () => this.decide(reqId, true));
    deny.addEventListener('click', () => this.decide(reqId, false));
    actions.append(deny, allow);
    card.append(actions);
    $('perms').append(card);
    this.perms.set(reqId, card);
    this.scene.setWaiting(true);
  }

  /** Sessions seen only through hooks: kingfisher can watch and approve them, not steer them. */
  private observed = new Set<string>();

  private setBusy(busy: boolean) {
    this.busy = busy;
    const s = $('state');
    s.textContent = busy ? 'working' : this.lastSession && this.observed.has(this.lastSession) ? 'idle' : 'your turn';
    s.className = busy ? 'chip busy' : 'chip';
    const steerable = !(this.lastSession && this.observed.has(this.lastSession));
    $('interrupt').toggleAttribute('disabled', !busy || !steerable);
  }

  private gauges() {
    const fill = $('ctx-fill');
    if (this.contextWindow) {
      const pct = Math.min(1, this.contextTokens / this.contextWindow);
      fill.style.width = `${(pct * 100).toFixed(1)}%`;
      fill.classList.toggle('high', pct > 0.8);
      $('ctx').textContent = `${fmt(this.contextTokens)} / ${fmt(this.contextWindow)}`;
    } else if (this.contextTokens) {
      $('ctx').textContent = fmt(this.contextTokens);
    }
  }

  showFile(path: string) {
    const list = this.touches.get(path) ?? [];
    $('drawer-title').textContent = path;
    const body = $('drawer-body');
    body.replaceChildren();
    if (!list.length) body.append(el('div', 'muted', 'Not touched this session.'));
    for (const t of list) {
      const r = el('div', 'touch');
      r.style.setProperty('--kind', KIND_COLOR[t.kind]);
      r.append(
        el('span', 'glyph', KIND_GLYPH[t.kind]),
        el('span', 'name', t.tool),
        el('span', 'when', new Date(t.ts).toLocaleTimeString()),
        el('span', `status ${t.ok === null ? '' : t.ok ? 'ok' : 'err'}`, t.ok === null ? '…' : t.ok ? 'ok' : 'failed'),
      );
      r.addEventListener('click', () => {
        t.row.classList.add('open', 'flash');
        t.row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setTimeout(() => t.row.classList.remove('flash'), 1200);
      });
      body.append(r);
    }
    $('drawer').classList.add('open');
  }
}

function fmt(n: number) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`;
}

function describe(tool: string, input: any, root: string): string {
  const strip = (p: string) => (root && p.startsWith(root + '/') ? p.slice(root.length + 1) : p);
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return input.command.split('\n')[0];
  if (typeof input.file_path === 'string') return strip(input.file_path);
  if (typeof input.pattern === 'string') return input.pattern + (input.path ? `  in ${strip(input.path)}` : '');
  if (typeof input.url === 'string') return input.url;
  if (typeof input.query === 'string') return input.query;
  if (typeof input.description === 'string') return input.description;
  if (typeof input.prompt === 'string') return input.prompt.slice(0, 80);
  return tool.startsWith('mcp__') ? '' : JSON.stringify(input).slice(0, 80);
}

async function main() {
  const tip = $('tip');
  let app: App;
  const scene = new Observatory($<HTMLCanvasElement>('sky'), {
    hover(path, x, y) {
      if (!path) {
        tip.classList.remove('show');
        return;
      }
      tip.textContent = path;
      tip.style.transform = `translate(${x + 14}px, ${y + 10}px)`;
      tip.classList.add('show');
    },
    pick: (path) => app.showFile(path),
  });
  app = new App(scene);

  // A fresh link pasted into an open tab only changes the fragment, which does not reload the page.
  window.addEventListener('hashchange', async () => {
    if (await authenticate().catch(() => false)) location.reload();
  });
  await authenticate().catch(() => false);
  await scene.start();
  $('backend').textContent = scene.backend;

  const loadFiles = async (cwd?: string) => {
    const { root, files } = await fetchFiles(cwd);
    if (cwd && !root) return;
    app.setRoot(root);
    scene.setFiles(root, files);
    $('files').textContent = `${files.length} files`;
  };
  await loadFiles();
  app.onCwd = (cwd) => void loadFiles(cwd);
  let last = performance.now();
  const decay = (now: number) => {
    app.sound.decay((now - last) / 1000);
    last = now;
    requestAnimationFrame(decay);
  };
  requestAnimationFrame(decay);

  // The live log is kept even while replaying, so leaving a replay restores the present exactly.
  let liveLog: AgentEvent[] = [];
  let replaying = false;
  const player = new Player(
    (events, instant) => app.apply(events, instant),
    (vt, duration, playing) => {
      const scrub = $<HTMLInputElement>('scrub');
      scrub.max = String(Math.max(1, duration));
      if (document.activeElement !== scrub) scrub.value = String(vt);
      $('ptime').textContent = `${clock(vt)} / ${clock(duration)}`;
      $('pplay').textContent = playing ? '❚❚' : '▶';
    },
  );
  const enterReplay = async (s: Session) => {
    replaying = true;
    document.body.classList.add('replaying');
    $('library').classList.remove('open');
    $('pname').textContent = `${s.cwd?.split('/').pop() ?? '?'} · ${s.started ? new Date(s.started).toLocaleString() : ''}`;
    if (!(await player.load(s.name))) leaveReplay();
  };
  const leaveReplay = () => {
    player.stop();
    replaying = false;
    document.body.classList.remove('replaying');
    void loadFiles().then(() => app.apply(liveLog, true));
  };
  $('pplay').addEventListener('click', () => (player.playing ? player.pause() : player.play()));
  $('pexit').addEventListener('click', leaveReplay);
  $<HTMLSelectElement>('pspeed').addEventListener('change', (e) => (player.speed = Number((e.target as HTMLSelectElement).value)));
  $<HTMLInputElement>('scrub').addEventListener('input', (e) => player.seek(Number((e.target as HTMLInputElement).value)));
  $('library-btn').addEventListener('click', async () => {
    const panel = $('library');
    if (panel.classList.toggle('open')) renderLibrary(await listSessions(), enterReplay);
  });
  $('library-close').addEventListener('click', () => $('library').classList.remove('open'));

  const link = connect({
    events: (events, backlog) => {
      if (backlog) liveLog = events;
      else liveLog.push(...events);
      if (!replaying) app.apply(events, backlog);
    },
    status(up, ever) {
      const c = $('conn');
      c.textContent = up ? 'live' : ever ? 'reconnecting' : 'not connected: open the link kingfisherd printed';
      c.className = up ? 'chip ok' : 'chip warn';
    },
  });
  app.bind(link);
}

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderLibrary(list: Session[], open: (s: Session) => void) {
  const body = $('library-body');
  body.replaceChildren();
  if (!list.length) body.append(el('div', 'muted', 'No archived sessions yet.'));
  for (const s of list) {
    const row = el('div', 'lib-row');
    const when = s.started ? new Date(s.started) : null;
    const mins = s.started && s.ended ? Math.max(1, Math.round((s.ended - s.started) / 60000)) : 0;
    const head = el('div', 'lib-head');
    head.append(
      el('span', 'lib-repo', s.cwd?.split('/').pop() ?? '?'),
      el('span', 'lib-when', when ? when.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''),
    );
    const meta = el('div', 'lib-meta', `${mins} min · ${s.tool_calls} tool calls · ${(s.bytes / 1024).toFixed(0)} KB${s.observed ? ' · observed' : ''}`);
    row.append(head, el('div', 'lib-prompt', s.first_prompt ?? '(no prompt)'), meta);
    row.addEventListener('click', () => open(s));
    body.append(row);
  }
}

main().catch((e) => {
  console.error(e);
  $('conn').textContent = `failed: ${e?.message ?? e}`;
  $('conn').className = 'chip warn';
});
