import type { AgentEvent } from './types';

/** Long silences are squeezed to this, so an hour-long session does not replay an hour of nothing. */
const MAX_GAP_MS = 2500;

export interface Session {
  name: string;
  bytes: number;
  started: number | null;
  ended: number | null;
  cwd: string | null;
  session: string | null;
  first_prompt: string | null;
  tool_calls: number;
  observed: boolean;
}

export async function listSessions(): Promise<Session[]> {
  const res = await fetch('/api/sessions');
  return res.ok ? res.json() : [];
}

/**
 * Plays an archived session through the same reducer the live view uses. Scrubbing backwards
 * resets and re-applies the prefix instantly, because the reducer only knows how to go forwards.
 */
export class Player {
  private events: AgentEvent[] = [];
  private vtimes: number[] = [];
  private idx = 0;
  private vt = 0;
  private last = 0;
  private raf = 0;
  playing = false;
  speed = 4;
  name = '';

  constructor(
    private apply: (events: AgentEvent[], instant: boolean) => void,
    private onTick: (vt: number, duration: number, playing: boolean) => void,
  ) {}

  get duration() {
    return this.vtimes.length ? this.vtimes[this.vtimes.length - 1] : 0;
  }

  async load(name: string): Promise<boolean> {
    const res = await fetch(`/api/sessions/${encodeURIComponent(name)}`);
    if (!res.ok) return false;
    this.events = await res.json();
    this.name = name;
    this.vtimes = [];
    let vt = 0;
    for (let i = 0; i < this.events.length; i++) {
      if (i > 0) vt += Math.min(Math.max(0, this.events[i].ts - this.events[i - 1].ts), MAX_GAP_MS);
      this.vtimes.push(vt);
    }
    this.seek(0);
    this.play();
    return true;
  }

  play() {
    if (this.idx >= this.events.length) this.seek(0);
    this.playing = true;
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.onTick(this.vt, this.duration, false);
  }

  stop() {
    this.pause();
    this.events = [];
    this.vtimes = [];
  }

  seek(target: number) {
    let n = 0;
    while (n < this.vtimes.length && this.vtimes[n] <= target) n++;
    this.idx = n;
    this.vt = target;
    this.apply(this.events.slice(0, n), true);
    this.onTick(this.vt, this.duration, this.playing);
  }

  private frame(now: number) {
    if (!this.playing) return;
    this.vt += (now - this.last) * this.speed;
    this.last = now;
    const start = this.idx;
    while (this.idx < this.events.length && this.vtimes[this.idx] <= this.vt) this.idx++;
    if (this.idx > start) this.apply(this.events.slice(start, this.idx), false);
    if (this.idx >= this.events.length) {
      this.vt = this.duration;
      this.pause();
      return;
    }
    this.onTick(this.vt, this.duration, true);
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }
}
