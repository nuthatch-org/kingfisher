import type { ToolKind } from './types';

/**
 * A quiet score for the session. Off until the viewer turns it on, because browsers only allow
 * audio after a gesture, and because nobody wants a tab that starts chirping unasked.
 */
export class Sonifier {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private pad: { gain: GainNode; filter: BiquadFilterNode } | null = null;
  private padLevel = 0;
  enabled = false;
  /** Wanted on, but the browser has not had a click yet, so audio cannot start. */
  wanted = false;

  /** Call from any click or key press: browsers only let audio start after one. */
  unlock() {
    if (this.wanted && !this.enabled) {
      this.enabled = true;
      if (!this.ctx) this.boot();
      void this.ctx?.resume();
    }
  }

  toggle(): boolean {
    this.wanted = !this.enabled;
    this.enabled = !this.enabled;
    if (this.enabled && !this.ctx) this.boot();
    if (this.ctx) {
      if (this.enabled) void this.ctx.resume();
      else void this.ctx.suspend();
    }
    return this.enabled;
  }

  private boot() {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = 0.32;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);

    // The thinking pad: two detuned saws through a slow low-pass, silent until thought arrives.
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 300;
    filter.Q.value = 4;
    for (const f of [110, 110.7, 164.8]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(filter);
      o.start();
    }
    filter.connect(gain).connect(master);
    this.ctx = ctx;
    this.master = master;
    this.pad = { gain, filter };
  }

  private tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.3, at = 0) {
    if (!this.enabled || !this.ctx || !this.master) return;
    const t = this.ctx.currentTime + at;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private noise(dur: number, cutoff: number, vol = 0.25) {
    if (!this.enabled || !this.ctx || !this.master) return;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(this.master);
    src.start();
  }

  tool(kind: ToolKind) {
    switch (kind) {
      case 'read':
        return this.tone(1320, 0.06, 'sine', 0.12);
      case 'search':
        this.tone(990, 0.05, 'sine', 0.1);
        return this.tone(1480, 0.05, 'sine', 0.08, 0.06);
      case 'edit':
        return [392, 494, 587].forEach((f, i) => this.tone(f, 0.5, 'triangle', 0.1, i * 0.02));
      case 'write':
        return [392, 494, 587, 784].forEach((f, i) => this.tone(f, 0.6, 'triangle', 0.09, i * 0.06));
      case 'shell':
        this.noise(0.12, 1800, 0.3);
        return this.tone(110, 0.14, 'sine', 0.25);
      case 'web':
        return this.tone(2093, 0.4, 'sine', 0.08);
      case 'agent':
        return [523, 659, 784].forEach((f, i) => this.tone(f, 0.35, 'sine', 0.08, i * 0.09));
      default:
        return this.tone(880, 0.08, 'sine', 0.08);
    }
  }

  failure() {
    this.tone(98, 0.6, 'sawtooth', 0.12);
    this.tone(104, 0.6, 'sawtooth', 0.12);
  }

  testsPassed() {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.5, 'triangle', 0.12, i * 0.09));
  }

  permission() {
    this.tone(1568, 1.2, 'sine', 0.14);
    this.tone(2349, 1.0, 'sine', 0.06, 0.01);
  }

  yourTurn() {
    this.tone(784, 0.5, 'sine', 0.1);
    this.tone(1175, 0.7, 'sine', 0.08, 0.12);
  }

  /** Called on each thinking delta; the pad swells and then sinks back on its own. */
  thinking() {
    this.padLevel = Math.min(1, this.padLevel + 0.05);
    this.applyPad();
  }

  decay(dt: number) {
    if (this.padLevel <= 0) return;
    this.padLevel = Math.max(0, this.padLevel - dt * 0.15);
    this.applyPad();
  }

  private applyPad() {
    if (!this.ctx || !this.pad) return;
    const t = this.ctx.currentTime;
    this.pad.gain.gain.setTargetAtTime(this.enabled ? this.padLevel * 0.05 : 0, t, 0.4);
    this.pad.filter.frequency.setTargetAtTime(250 + this.padLevel * 900, t, 0.6);
  }
}
