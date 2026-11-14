import type { AgentEvent, ClientMsg } from './types';

/** Trades the `#t=` fragment for an HttpOnly cookie, then drops it from the address bar. */
export async function authenticate(): Promise<boolean> {
  const m = location.hash.match(/t=([0-9a-f]+)/);
  if (!m) return false;
  history.replaceState(null, '', location.pathname);
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: m[1] }),
  });
  return res.ok;
}

export interface Link {
  send(msg: ClientMsg): void;
}

export function connect(handlers: {
  /** `backlog` is true for the full history sent on (re)connect. */
  events(events: AgentEvent[], backlog: boolean): void;
  status(up: boolean, everConnected: boolean): void;
}): Link {
  let ws: WebSocket | null = null;
  let ever = false;

  const open = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    let first = true;
    ws.onopen = () => {
      ever = true;
      handlers.status(true, ever);
    };
    ws.onmessage = (m) => {
      const events = JSON.parse(m.data) as AgentEvent[];
      handlers.events(events, first);
      first = false;
    };
    ws.onclose = (e) => {
      console.warn(`[kingfisher] socket closed: code ${e.code} ${e.reason}`);
      handlers.status(false, ever);
      setTimeout(open, 1500);
    };
  };
  open();

  return {
    send(msg) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
  };
}

export async function fetchFiles(cwd?: string): Promise<{ root: string; files: string[] }> {
  const res = await fetch(cwd ? `/api/files?cwd=${encodeURIComponent(cwd)}` : '/api/files');
  if (!res.ok) return { root: '', files: [] };
  return res.json();
}

export async function fetchRole(): Promise<{ role: 'control' | 'watch'; phone: string | null }> {
  const res = await fetch('/api/role');
  return res.ok ? res.json() : { role: 'watch', phone: null };
}
