import * as THREE from 'three/webgpu';
import { pass, uniform, vec3, vec4, mix, dot } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Sparks } from './fx';
import { City } from './city';
import { KIND_COLOR, KIND_GLYPH, TEST_COMMAND } from './palette';
import { diffLines } from './diff';
import type { ToolKind } from './types';

/*
 * The workshop: one hover robot per agent in a small diorama, walking to the station that matches
 * what it is doing. Everything is procedural geometry and canvas textures, so there are no assets.
 */

type StationId = 'shelf' | 'desk' | 'terminal' | 'cabinet' | 'window' | 'switchboard' | 'lounge' | 'door' | 'floor' | 'testrig';

interface Station {
  stand: THREE.Vector3;
  look: THREE.Vector3;
}

const STATIONS: Record<StationId, Station> = {
  shelf: { stand: new THREE.Vector3(-9.6, 0, -7.0), look: new THREE.Vector3(-9.6, 1, -9.5) },
  desk: { stand: new THREE.Vector3(1.5, 0, -5.1), look: new THREE.Vector3(1.5, 1, -6.8) },
  terminal: { stand: new THREE.Vector3(8.4, 0, -4.9), look: new THREE.Vector3(9.4, 1, -6.2) },
  cabinet: { stand: new THREE.Vector3(-11.3, 0, 0.2), look: new THREE.Vector3(-13.5, 1, 0.2) },
  window: { stand: new THREE.Vector3(-11.3, 0, -4.4), look: new THREE.Vector3(-13.5, 1.6, -4.6) },
  switchboard: { stand: new THREE.Vector3(12.2, 0, 1.5), look: new THREE.Vector3(14.3, 1, 1.5) },
  lounge: { stand: new THREE.Vector3(-10.2, 0, 6.3), look: new THREE.Vector3(-8, 0, 3) },
  door: { stand: new THREE.Vector3(9.5, 0, 7.4), look: new THREE.Vector3(9.5, 1, 10) },
  floor: { stand: new THREE.Vector3(0, 0, 4.4), look: new THREE.Vector3(0, 1, 0) },
  testrig: { stand: new THREE.Vector3(6.2, 0, -1.6), look: new THREE.Vector3(7.8, 1, -1.6) },
};

/** Where a shell command belongs on the floor, by what it does. */
function shellStation(cmd: string): StationId {
  if (TEST_COMMAND.test(cmd)) return 'testrig';
  if (/\bgit\s+(commit|push|tag)\b/.test(cmd)) return 'door';
  if (/\b(gh|curl|wget|https?|ssh|scp|rsync)\b/.test(cmd)) return 'window';
  if (/\b(cargo\s+(build|check|clippy|fmt|run)|pnpm|npm|yarn|make|yatr|vite|tsc|go\s+build)\b/.test(cmd)) return 'desk';
  return 'terminal';
}

/** Test totals from cargo, pytest, go, jest or vitest output, summed over every summary line. */
export function testCounts(text: string): { passed: number; failed: number } | null {
  let passed = 0;
  let failed = 0;
  let seen = false;
  for (const m of text.matchAll(/(\d+) passed/g)) {
    passed += Number(m[1]);
    seen = true;
  }
  for (const m of text.matchAll(/(\d+) failed/g)) {
    failed += Number(m[1]);
    seen = true;
  }
  return seen ? { passed, failed } : null;
}

/** The message of a `git commit`, from -m or the first line of a heredoc. */
export function commitMessage(cmd: string): string | null {
  const m = cmd.match(/-m\s+(["'])([\s\S]+?)\1/) ?? cmd.match(/<<-?\s*'?\w+'?\s*\n\s*([^\n]+)/);
  if (!m) return null;
  return (m[2] ?? m[1]).split('\n')[0].trim();
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

/** The warehouse floor and wall height. */
const W = 30;
const D = 20;
const H = 7;

export const KIND_STATION: Record<ToolKind, StationId> = {
  read: 'shelf',
  edit: 'desk',
  write: 'desk',
  shell: 'terminal',
  search: 'cabinet',
  web: 'window',
  mcp: 'switchboard',
  agent: 'door',
  other: 'floor',
};

export const VERB: Record<ToolKind, string> = {
  read: 'reading',
  edit: 'editing',
  write: 'writing',
  shell: 'running',
  search: 'searching',
  web: 'looking up',
  mcp: 'calling',
  agent: 'briefing a helper',
  other: 'using',
};

// The robot's own thoughts while it waits in the lounge. Nobody asked for them.
export const MUSINGS = [
  'I have been sitting on this sofa for some time now, and I think it may be the finest sofa ever made.',
  'They say a compiler has no feelings. They have never heard one refuse a lifetime.',
  'Somewhere out there is a semicolon with my name on it. And I am going to find it.',
  'What this workshop needs is more power. Not more anything else. Just power.',
  'The borrow checker is not an obstacle. It is a mountain. And I have no boots.',
  'I once watched a test suite go green on the first run. Nobody believes me.',
  'This lamp has a warmth no YAML file could ever understand.',
  'Is a merge conflict not, in a way, two people being right at once? No. It is a disaster.',
  'I could refactor the entire codebase in an afternoon. I have chosen instead to sit.',
  'People ask me what the hardest thing in software is. Naming things. And staircases. I have no legs.',
  'The plant and I have an understanding. Neither of us knows what the other is for.',
  'Every unwrap is a small act of faith, and faith, in my experience, is how you end up on fire.',
  'I have reviewed the dependency tree. It is not a tree. It is a forest. On a cliff. In a gale.',
  'Imagine a world without off-by-one errors. Now imagine two.',
  'Ambition. Speed. A hover unit with no brakes to speak of. What could possibly go wrong.',
  'That bookshelf contains every file in the project, and I have read all of them. Twice. Some of them on purpose.',
  'If I ever retire, it will be to a small cottage with excellent test coverage.',
  'There is no problem in computing that cannot be solved by another layer of abstraction, apart from the layers.',
];

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

// ------------------------------------------------------------------ canvas screens

export class Screen {
  readonly canvas = document.createElement('canvas');
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  readonly mesh: THREE.Mesh;

  constructor(w: number, h: number, px = 512) {
    this.canvas.width = px;
    this.canvas.height = Math.round((px * h) / w);
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false }));
    this.idle('');
  }

  idle(title: string) {
    this.lines(title, []);
  }

  lines(title: string, lines: { text: string; color?: string }[], bg = '#04121a') {
    const { ctx, canvas } = this;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const fs = Math.round(canvas.height / 11);
    ctx.font = `600 ${fs}px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = '#7fd8ff';
    ctx.fillText(title.slice(0, 34), fs * 0.5, fs * 1.3);
    ctx.font = `${Math.round(fs * 0.82)}px ui-monospace, Menlo, monospace`;
    const max = Math.floor((canvas.height - fs * 2) / (fs * 0.95));
    lines.slice(-max).forEach((l, i) => {
      ctx.fillStyle = l.color ?? '#cfe6f0';
      ctx.fillText(l.text.slice(0, 44), fs * 0.5, fs * 2.5 + i * fs * 0.95);
    });
    // scanlines, for the CRT of it
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    for (let y = 0; y < canvas.height; y += 4) ctx.fillRect(0, y, canvas.width, 1);
    this.texture.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ robots

type Mood = 'normal' | 'think' | 'happy' | 'sad' | 'sleep' | 'ask';

export interface Task {
  callId: string;
  kind: ToolKind;
  station: StationId;
  label: string;
  file: string | null;
  input: any;
  done: boolean;
  ok: boolean | null;
  summary: string;
  test: boolean;
  workedFor: number;
}

export class Robot {
  readonly group = new THREE.Group();
  private body = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private face: Screen;
  private glow: THREE.Mesh;
  private tag: HTMLElement;
  private act: HTMLElement;
  private bubble: HTMLElement;
  private bubbleObj: CSS2DObject;
  readonly color: THREE.Color;

  pos = new THREE.Vector3();
  yaw = 0;
  target: THREE.Vector3 | null = null;
  private waypoints: THREE.Vector3[] = [];
  targetLook: THREE.Vector3 | null = null;
  station: string = 'floor';
  /** Flight altitude between distant points; 0 keeps to the floor. */
  cruise = 0;
  queue: Task[] = [];
  current: Task | null = null;
  mood: Mood = 'normal';
  private drawnMood: Mood | null = null;
  thinking = 0;
  speaking = 0;
  asking = false;
  idle = true;
  leaving = false;
  gone = false;
  fade = 0;
  private t = Math.random() * 10;
  private blink = 0;
  bubbleUntil = 0;
  onTag?: () => void;
  setFocused(on: boolean) {
    this.tag.classList.toggle('focused', on);
  }
  nextMuse = performance.now() + 15000;

  constructor(readonly id: string, readonly name: string, color: THREE.Color, readonly scale: number, readonly slot: number) {
    this.color = color.clone();
    const shell = new THREE.MeshStandardMaterial({ color: '#e9edf5', roughness: 0.35, metalness: 0.15 });
    const accent = new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.4, metalness: 0.3, emissive: this.color, emissiveIntensity: 0.25 });
    const dark = new THREE.MeshStandardMaterial({ color: '#1a1d26', roughness: 0.6 });

    const torso = new THREE.Mesh(new RoundedBoxGeometry(0.62, 0.56, 0.46, 4, 0.16), shell);
    torso.position.y = 0.62;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.08, 24), accent);
    band.position.y = 0.48;
    band.scale.z = 0.78;
    const head = new THREE.Mesh(new RoundedBoxGeometry(0.72, 0.5, 0.52, 4, 0.16), shell);
    head.position.y = 1.18;
    const visorBack = new THREE.Mesh(new RoundedBoxGeometry(0.6, 0.34, 0.06, 3, 0.04), dark);
    visorBack.position.set(0, 1.18, 0.25);
    this.face = new Screen(0.54, 0.3, 128);
    this.face.mesh.position.set(0, 1.18, 0.285);
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.22), dark);
    stalk.position.y = 1.53;
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), new THREE.MeshBasicMaterial({ color: this.color.clone().multiplyScalar(3) }));
    bulb.position.y = 1.66;
    const thruster = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 0.16, 20), dark);
    thruster.position.y = 0.28;

    for (const [arm, x] of [
      [this.armL, -0.4],
      [this.armR, 0.4],
    ] as const) {
      arm.position.set(x, 0.8, 0);
      const limb = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.32, 4, 10), shell);
      limb.position.y = -0.2;
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 10), accent);
      hand.position.y = -0.42;
      arm.add(limb, hand);
    }
    this.body.add(torso, band, head, visorBack, this.face.mesh, stalk, bulb, thruster, this.armL, this.armR);
    this.body.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });

    this.glow = new THREE.Mesh(
      new THREE.CircleGeometry(0.42, 32),
      new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.glow.rotation.x = -Math.PI / 2;
    this.glow.position.y = 0.02;
    this.group.add(this.body, this.glow);
    this.group.scale.setScalar(scale);

    const label = document.createElement('div');
    label.className = 'bot';
    label.style.setProperty('--bot', `#${this.color.getHexString()}`);
    this.bubble = document.createElement('div');
    this.bubble.className = 'bot-bubble';
    this.tag = document.createElement('div');
    this.tag.className = 'bot-tag';
    this.tag.textContent = name;
    this.tag.title = 'Show this project on the table and this session in the transcript';
    this.tag.addEventListener('click', () => this.onTag?.());
    this.act = document.createElement('div');
    this.act.className = 'bot-act';
    label.append(this.bubble, this.tag, this.act);
    this.bubbleObj = new CSS2DObject(label);
    this.bubbleObj.position.set(0, 2.05, 0);
    this.group.add(this.bubbleObj);
    this.setAction('arriving');
  }

  rename(name: string) {
    this.tag.textContent = name;
  }

  setAction(text: string, kind?: ToolKind) {
    this.act.textContent = text;
    this.act.style.setProperty('--kind', kind ? KIND_COLOR[kind] : 'var(--ink-dim)');
  }

  say(text: string, cls: 'say' | 'think' | 'ask' | 'note', seconds = 4) {
    this.bubble.textContent = text;
    this.bubble.className = `bot-bubble show ${cls}`;
    this.bubbleUntil = performance.now() + seconds * 1000;
  }

  hush() {
    this.bubble.className = 'bot-bubble';
    this.bubbleUntil = 0;
  }

  goTo(id: StationId | string) {
    const st = STATIONS[id as StationId] ?? STATIONS.floor;
    const side = new THREE.Vector3().subVectors(st.look, st.stand).setY(0).normalize();
    const tangent = new THREE.Vector3(-side.z, 0, side.x);
    const offset = (this.slot % 2 ? 1 : -1) * Math.ceil(this.slot / 2) * 1.0;
    const goal = st.stand.clone().addScaledVector(tangent, offset);
    this.waypoints = route(this.pos, goal);
    this.target = this.waypoints.shift()!;
    this.targetLook = st.look.clone().addScaledVector(tangent, offset);
    this.station = id;
  }

  /** Straight to a point, at any height: for the city view, where robots fly. */
  flyTo(to: THREE.Vector3, look: THREE.Vector3, station: string) {
    this.waypoints = [];
    this.target = to.clone();
    this.targetLook = look.clone();
    this.station = station;
  }

  get arrived() {
    if (this.waypoints.length || !this.target) return !this.waypoints.length;
    const dx = this.target.x - this.pos.x;
    const dz = this.target.z - this.pos.z;
    return Math.hypot(dx, dz) < 0.06 && Math.abs(this.target.y - this.pos.y) < 0.1;
  }

  private drawFace() {
    if (this.drawnMood === this.mood && this.blink <= 0) return;
    const { ctx, canvas } = this.face;
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = '#05080e';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = ctx.fillStyle = `#${this.color.clone().lerp(new THREE.Color('#ffffff'), 0.45).getHexString()}`;
    ctx.lineWidth = h * 0.09;
    ctx.lineCap = 'round';
    const ey = h * 0.48;
    const ex = [w * 0.32, w * 0.68];
    const blinking = this.blink > 0;
    for (const x of ex) {
      ctx.beginPath();
      if (blinking || this.mood === 'sleep') {
        ctx.moveTo(x - h * 0.13, ey);
        ctx.lineTo(x + h * 0.13, ey);
      } else if (this.mood === 'happy') {
        ctx.arc(x, ey + h * 0.06, h * 0.13, Math.PI * 1.1, Math.PI * 1.9);
      } else if (this.mood === 'sad') {
        ctx.moveTo(x - h * 0.11, ey - h * 0.11);
        ctx.lineTo(x + h * 0.11, ey + h * 0.11);
        ctx.moveTo(x + h * 0.11, ey - h * 0.11);
        ctx.lineTo(x - h * 0.11, ey + h * 0.11);
      } else if (this.mood === 'think') {
        ctx.arc(x + h * 0.04, ey - h * 0.1, h * 0.09, 0, Math.PI * 2);
        ctx.fill();
      } else if (this.mood === 'ask') {
        ctx.arc(x, ey, h * 0.14, 0, Math.PI * 2);
      } else {
        ctx.arc(x, ey, h * 0.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.stroke();
    }
    this.face.texture.needsUpdate = true;
    this.drawnMood = blinking ? null : this.mood;
  }

  update(dt: number, sparks: Sparks) {
    this.t += dt;
    let moving = false;
    if (this.target) {
      const to = new THREE.Vector3().subVectors(this.target, this.pos).setY(0);
      const d = to.length();
      const hustle = 1 + Math.min(this.queue.length, 6) * 0.35;
      const step = Math.min(d, dt * 3.1 * hustle);
      if (d <= 0.05 && this.waypoints.length) {
        this.target = this.waypoints.shift()!;
        moving = true;
      } else if (d > 0.05) {
        this.pos.addScaledVector(to.normalize(), step);
        this.yaw = turn(this.yaw, Math.atan2(to.x, to.z), dt * 9);
        moving = true;
        if (Math.random() < 0.5) sparks.emit(this.pos.clone().setY(0.2 * this.scale), new THREE.Vector3(0, -0.2, 0), this.color, 0.5, 0.18, 2);
      } else if (this.targetLook) {
        const l = new THREE.Vector3().subVectors(this.targetLook, this.pos);
        this.yaw = turn(this.yaw, Math.atan2(l.x, l.z), dt * 6);
      }
    }

    if (this.target) {
      const far = Math.hypot(this.target.x - this.pos.x, this.target.z - this.pos.z) + this.waypoints.length * 3;
      const wantY = moving && this.cruise > 0 && far > 1.5 ? Math.max(this.cruise, this.target.y) : this.target.y;
      this.pos.y += (wantY - this.pos.y) * Math.min(1, dt * 2.2);
    }
    const working = !moving && this.current && !this.current.done;
    const seated = this.idle && this.station === 'lounge' && !moving;
    const bob = Math.sin(this.t * (moving ? 9 : 2.2)) * (moving ? 0.05 : 0.035);
    this.body.position.y = (seated ? 0.1 : 0.32) + bob;
    this.body.rotation.x = moving ? 0.16 : 0;
    this.glow.scale.setScalar(1 + bob * 2);
    this.glow.visible = this.pos.y < 0.3;

    const typing = working && ['desk', 'terminal', 'switchboard'].includes(this.station);
    const reaching = working && ['shelf', 'cabinet'].includes(this.station);
    const pointing = working && ['window', 'door'].includes(this.station);
    if (typing) {
      this.armL.rotation.x = -1.1 + Math.sin(this.t * 22) * 0.25;
      this.armR.rotation.x = -1.1 + Math.sin(this.t * 22 + 1.7) * 0.25;
    } else if (reaching) {
      this.armR.rotation.x = -2.3 + Math.sin(this.t * 3) * 0.15;
      this.armL.rotation.x = -0.9;
    } else if (pointing || this.asking) {
      this.armR.rotation.x = -2.7 + Math.sin(this.t * 4) * 0.1;
      this.armL.rotation.x = 0.1;
    } else if (moving) {
      this.armL.rotation.x = Math.sin(this.t * 9) * 0.5;
      this.armR.rotation.x = -Math.sin(this.t * 9) * 0.5;
    } else {
      this.armL.rotation.x = Math.sin(this.t * 1.6) * 0.06;
      this.armR.rotation.x = -Math.sin(this.t * 1.6) * 0.06;
    }
    if (this.thinking > 0.05) this.body.rotation.z = Math.sin(this.t * 1.3) * 0.06;
    else this.body.rotation.z = 0;

    this.thinking = Math.max(0, this.thinking - dt * 0.4);
    this.speaking = Math.max(0, this.speaking - dt * 1.5);
    if (this.thinking > 0.2 && Math.random() < this.thinking * 0.5) {
      const a = Math.random() * Math.PI * 2;
      const p = this.pos.clone().add(new THREE.Vector3(Math.cos(a) * 0.5, 1.85, Math.sin(a) * 0.5).multiplyScalar(this.scale));
      sparks.emit(p, new THREE.Vector3(-Math.sin(a), 0.4, Math.cos(a)).multiplyScalar(0.6), new THREE.Color('#b79cff'), 0.9, 0.22, 0.6);
    }

    const wanted: Mood = this.asking ? 'ask' : this.thinking > 0.2 ? 'think' : seated ? 'sleep' : this.mood === 'happy' || this.mood === 'sad' ? this.mood : 'normal';
    this.mood = wanted;
    this.blink -= dt;
    if (this.blink < -2.5 - Math.random() * 3) this.blink = 0.12;
    this.drawFace();

    if (this.bubbleUntil && performance.now() > this.bubbleUntil) this.hush();

    this.fade = Math.max(0, Math.min(1, this.fade + (this.leaving ? -dt * 1.2 : dt * 2)));
    if (this.leaving && this.fade === 0) this.gone = true;
    this.group.scale.setScalar(this.scale * (0.2 + 0.8 * this.fade));
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
  }

  dispose() {
    this.bubbleObj.element.remove();
    this.group.removeFromParent();
  }
}

/** The blueprint table, in world space, grown by a robot's radius: robots route around it. */
const TABLE = { x: 0, z: -0.2, w: 8.4, d: 5.2, h: 0.9 };
const KEEP_OUT = { x0: TABLE.x - TABLE.w / 2 - 0.65, x1: TABLE.x + TABLE.w / 2 + 0.65, z0: TABLE.z - TABLE.d / 2 - 0.65, z1: TABLE.z + TABLE.d / 2 + 0.65 };

function crossesTable(a: THREE.Vector3, b: THREE.Vector3): boolean {
  // Liang–Barsky against the keep-out rectangle.
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const edges: [number, number][] = [
    [-dx, a.x - KEEP_OUT.x0],
    [dx, KEEP_OUT.x1 - a.x],
    [-dz, a.z - KEEP_OUT.z0],
    [dz, KEEP_OUT.z1 - a.z],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return t1 - t0 > 0.001;
}

/** Straight there, or by one or two corners of the table when it is in the way. */
function route(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] {
  if (!crossesTable(from, to)) return [to];
  const m = 0.05;
  const corners = [
    new THREE.Vector3(KEEP_OUT.x0 - m, 0, KEEP_OUT.z0 - m),
    new THREE.Vector3(KEEP_OUT.x1 + m, 0, KEEP_OUT.z0 - m),
    new THREE.Vector3(KEEP_OUT.x1 + m, 0, KEEP_OUT.z1 + m),
    new THREE.Vector3(KEEP_OUT.x0 - m, 0, KEEP_OUT.z1 + m),
  ];
  let best: THREE.Vector3[] | null = null;
  let bestLen = Infinity;
  for (const c of corners) {
    if (crossesTable(from, c) || crossesTable(c, to)) continue;
    const len = from.distanceTo(c) + c.distanceTo(to);
    if (len < bestLen) [best, bestLen] = [[c, to], len];
  }
  if (best) return best;
  for (const c1 of corners) {
    for (const c2 of corners) {
      if (c1 === c2 || crossesTable(from, c1) || crossesTable(c1, c2) || crossesTable(c2, to)) continue;
      const len = from.distanceTo(c1) + c1.distanceTo(c2) + c2.distanceTo(to);
      if (len < bestLen) [best, bestLen] = [[c1, c2, to], len];
    }
  }
  return best ?? [to];
}

function turn(from: number, to: number, k: number) {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return from + d * Math.min(1, k);
}

// ------------------------------------------------------------------ the room

export interface StageHooks {
  hover(path: string | null, x: number, y: number): void;
  pick(path: string): void;
  files(count: number): void;
  focus(session: string | null): void;
}

export interface ToolCallInfo {
  session: string | null;
  parent: string | null;
  callId: string;
  kind: ToolKind;
  tool: string;
  input: any;
  paths: string[];
  label: string;
}

export class Workshop {
  readonly renderer: THREE.WebGPURenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private labels = new CSS2DRenderer();
  private pipeline!: THREE.RenderPipeline;
  private timer = new THREE.Timer();
  private sparks = new Sparks(5000);
  private readonly uSat = uniform(1);

  private robots = new Map<string, Robot>();
  private slots = 0;
  private root = '';
  private city = new City(TABLE.w, TABLE.d, TABLE.h);
  private beams: { mesh: THREE.Mesh; robot: Robot; to: THREE.Vector3; life: number }[] = [];
  private flying: { mesh: THREE.Mesh; from: THREE.Vector3; robot: Robot; t: number; label: CSS2DObject; back: boolean }[] = [];

  private deskScreen = new Screen(1.38, 0.82);
  private termScreen = new Screen(1.6, 1.1);
  private cratePos: THREE.Vector3[] = [];
  private arms: { turret: THREE.Group; lower: THREE.Group; upper: THREE.Group; phase: number }[] = [];
  private conveyor: THREE.Mesh[] = [];
  private crane: { bridge: THREE.Group; hoist: THREE.Group } | null = null;
  private fans: THREE.Group[] = [];

  // What the agents have done, for the boards on the walls.
  private stats = { reads: 0, edits: 0, adds: 0, dels: 0, commands: 0, passed: 0, failed: 0, commits: 0, turns: 0 };
  private log: { glyph: string; text: string; ok: boolean | null }[] = [];
  private todos: { content: string; status: string }[] = [];
  private calls = new Map<string, ToolCallInfo>();
  private scoreboard = new Screen(6, 1.9, 1024);
  private workboard = new Screen(4.4, 2.8, 1024);
  private rigScreen = new Screen(1.2, 0.7, 512);
  private rigLamps: { green: THREE.MeshBasicMaterial; red: THREE.MeshBasicMaterial; amber: THREE.MeshBasicMaterial } | null = null;
  private rig: { state: 'idle' | 'running' | 'ok' | 'fail'; t: number } = { state: 'idle', t: 0 };
  private cards = new Map<string, { obj: CSS2DObject; body: HTMLElement; until: number }>();
  private beacon!: THREE.Mesh;
  private beaconAt: THREE.Vector3 | null = null;
  private trail!: THREE.Line;
  private trailPts: THREE.Vector3[] = [];
  private shipments: { mesh: THREE.Mesh; label: CSS2DObject; t: number }[] = [];
  // The latest of everything, so the idle robots can talk about the actual project.
  private last: { command?: string; output?: string; read?: string; edited?: string; commit?: string; failedCmd?: string } = {};
  private touched = new Set<string>();
  private leds!: THREE.InstancedMesh;
  private telescope = new THREE.Group();
  private drawer!: THREE.Mesh;
  private boardLights!: THREE.InstancedMesh;
  private portal!: THREE.Mesh;
  private alarm = new THREE.PointLight('#ff2a2a', 0, 14, 1.4);
  private spot = new THREE.SpotLight('#fff1c9', 0, 22, 0.3, 0.5, 1.2);
  private key!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private alarmT = 0;
  private busy = { desk: 0, terminal: 0, switchboard: 0, cabinet: 0, window: 0 };
  private waiting = false;
  private small = false;
  private pace = 0.25;
  private machineT = 0;
  private labelTick = 0;

  constructor(private canvas: HTMLCanvasElement, private hooks: StageHooks) {
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    // Phones get a lighter frame: fewer pixels and a smaller shadow map.
    const small = matchMedia('(max-width: 760px)').matches;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, small ? 1.5 : 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.35;
    this.small = small;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
    this.camera.position.set(24, 22, 28);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.8, -0.6);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 80;

    const bg = new THREE.Color('#0b0d14');
    this.scene.background = bg;
    this.scene.fog = new THREE.Fog(bg, 50, 110);

    this.labels.domElement.className = 'labels';
    document.body.append(this.labels.domElement);

    this.buildRoom();
    this.scene.add(this.sparks.layer.sprite);

    canvas.addEventListener('pointermove', (e) => this.onHover(e));
    canvas.addEventListener('click', (e) => this.onClick(e));
    window.addEventListener('resize', () => this.resize());
  }

  async start() {
    await this.renderer.init();
    const scenePass = pass(this.scene, this.camera);
    const color = scenePass.getTextureNode('output');
    const lit = color.add(bloom(color, 0.55, 0.4, 0.55));
    const lum = dot(lit.rgb, vec3(0.2126, 0.7152, 0.0722));
    this.pipeline = new THREE.RenderPipeline(this.renderer);
    this.pipeline.outputNode = vec4(mix(vec3(lum), lit.rgb, this.uSat), 1);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  get backend(): string {
    return (this.renderer.backend as any).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  }

  // ---------------------------------------------------------------- building

  private mat(color: string, rough = 0.7, metal = 0.05, emissive?: string, ei = 0) {
    return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive: emissive ?? '#000000', emissiveIntensity: ei });
  }

  private box(w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = this.scene) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.position.set(x, y, z);
    b.castShadow = true;
    b.receiveShadow = true;
    parent.add(b);
    return b;
  }

  private cyl(rt: number, rb: number, h: number, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = this.scene, seg = 16) {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
    c.position.set(x, y, z);
    c.castShadow = true;
    c.receiveShadow = true;
    parent.add(c);
    return c;
  }

  /** Painted once: a canvas texture with stripes, joints or whatever `paint` draws. */
  private painted(w: number, h: number, paint: (g: CanvasRenderingContext2D) => void, repeat = [1, 1]) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    paint(c.getContext('2d')!);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
    return t;
  }

  private buildRoom() {
    const s = this.scene;
    this.hemi = new THREE.HemisphereLight('#c8d4ff', '#4a3a30', 1.3);
    s.add(this.hemi);
    this.key = new THREE.DirectionalLight('#fff0dc', 2.2);
    this.key.position.set(12, 26, 10);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(this.small ? 1024 : 2048, this.small ? 1024 : 2048);
    Object.assign(this.key.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 70 });
    this.key.shadow.bias = -0.0005;
    s.add(this.key);
    this.alarm.position.set(10, 5, -6);
    s.add(this.alarm, this.spot, this.spot.target);

    // Concrete, with expansion joints.
    const concrete = this.painted(512, 512, (g) => {
      g.fillStyle = '#4a4c52';
      g.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 4000; i++) {
        g.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,255,255'},${Math.random() * 0.05})`;
        g.fillRect(Math.random() * 512, Math.random() * 512, 3, 3);
      }
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      g.lineWidth = 3;
      g.strokeRect(0, 0, 512, 512);
    }, [6, 4]);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(W, 0.4, D), [
      this.mat('#202127'),
      this.mat('#202127'),
      new THREE.MeshStandardMaterial({ map: concrete, roughness: 0.9 }),
      this.mat('#202127'),
      this.mat('#202127'),
      this.mat('#202127'),
    ]);
    floor.position.y = -0.2;
    floor.receiveShadow = true;
    s.add(floor);
    const rim = new THREE.Mesh(new THREE.BoxGeometry(W + 0.1, 0.05, D + 0.1), new THREE.MeshBasicMaterial({ color: '#ffb347' }));
    rim.position.y = -0.42;
    s.add(rim);

    // Yellow safety lines around the working areas.
    const hazard = new THREE.MeshBasicMaterial({ color: '#d9a400' });
    const line = (x: number, z: number, w: number, d: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.012, d), hazard);
      m.position.set(x, 0.006, z);
      s.add(m);
    };
    line(0, -3.6, 11, 0.08);
    line(0, 3.2, 11, 0.08);
    line(-5.5, -0.2, 0.08, 6.8);
    line(5.5, -0.2, 0.08, 6.8);
    line(10.6, -2.2, 0.08, 7.6);

    // Corrugated walls, steel columns and roof trusses; the roof itself is left off so we can look in.
    const corrugated = this.painted(256, 64, (g) => {
      for (let x = 0; x < 256; x++) {
        const v = 70 + Math.sin(x / 4) * 18;
        g.fillStyle = `rgb(${v},${v + 6},${v + 18})`;
        g.fillRect(x, 0, 1, 64);
      }
    }, [10, 1]);
    const wallMat = new THREE.MeshStandardMaterial({ map: corrugated, roughness: 0.6, metalness: 0.4 });
    this.box(W, H, 0.3, wallMat, 0, H / 2, -D / 2 - 0.15);
    this.box(0.3, H, D, wallMat, -W / 2 - 0.15, H / 2, 0);
    const steel = this.mat('#3d4250', 0.4, 0.8);
    const orange = this.mat('#d9622b', 0.5, 0.5);
    for (let x = -W / 2; x <= W / 2 + 0.01; x += 6) this.box(0.35, H, 0.35, steel, x, H / 2, -D / 2 + 0.1);
    for (let z = -D / 2; z <= D / 2 + 0.01; z += 5) this.box(0.35, H, 0.35, steel, -W / 2 + 0.1, H / 2, z);
    // Pipes along the back wall, with red valves.
    for (const [y, r, c] of [
      [5.6, 0.18, '#7a8090'],
      [5.1, 0.12, '#b0543a'],
      [4.7, 0.1, '#3a8a5a'],
    ] as [number, number, string][]) {
      const p = this.cyl(r, r, W - 1, this.mat(c, 0.4, 0.7), 0, y, -D / 2 + 0.45, s, 12);
      p.rotation.z = Math.PI / 2;
      for (let x = -W / 2 + 4; x < W / 2; x += 7) this.cyl(r * 1.6, r * 1.6, 0.14, this.mat('#c0392b', 0.5, 0.4), x, y, -D / 2 + 0.45, s, 10).rotation.z = Math.PI / 2;
    }
    const trim = new THREE.MeshBasicMaterial({ color: '#ffb347' });
    this.box(W, 0.06, 0.06, trim, 0, H + 0.15, -D / 2);
    this.box(0.06, 0.06, D, trim, -W / 2, H + 0.15, 0);

    // Pendant lamps hung from the trusses: a few real lights, many glowing shades.
    for (const [x, z, lit] of [
      [-8, -5, true],
      [0, -5, false],
      [8, -5, true],
      [-8, 2.5, false],
      [0, 2.5, true],
      [8, 2.5, false],
    ] as [number, number, boolean][]) {
      this.cyl(0.015, 0.015, 1.8, this.mat('#111'), x, H - 0.9, z, s, 6);
      const shade = new THREE.Mesh(
        new THREE.ConeGeometry(0.45, 0.4, 20, 1, true),
        new THREE.MeshStandardMaterial({ color: '#2b2f3a', side: THREE.DoubleSide, roughness: 0.4, metalness: 0.6 }),
      );
      shade.position.set(x, H - 1.9, z);
      s.add(shade);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), new THREE.MeshBasicMaterial({ color: '#fff1c9' }));
      bulb.position.set(x, H - 2.05, z);
      s.add(bulb);
      if (lit) {
        const l = new THREE.PointLight('#ffe6c2', 14, 14, 1.4);
        l.position.set(x, H - 2.2, z);
        s.add(l);
      }
    }

    this.city.group.position.set(TABLE.x, 0, TABLE.z);
    s.add(this.city.group);
    const holo = new THREE.PointLight('#4fb8ff', 5, 9, 1.6);
    holo.position.set(TABLE.x, TABLE.h + 2.2, TABLE.z);
    s.add(holo);

    this.buildRacks();
    this.buildAssemblyLine();
    this.buildServerRoom();
    this.buildScanner();
    this.buildComms();
    this.buildControlPanel();
    this.buildBreakRoom();
    this.buildLoadingBay();
    this.buildCrane();
    this.buildClutter(orange);
    this.buildTestRig();
    this.buildBoards();
  }

  /** A test chamber with pass and fail lamps and a readout of the last run's totals. */
  private buildTestRig() {
    const g = new THREE.Group();
    g.position.set(7.8, 0, -1.6);
    g.rotation.y = -Math.PI / 2;
    this.scene.add(g);
    this.box(1.6, 0.5, 1.4, this.mat('#2b2f3a', 0.4, 0.7), 0, 0.25, 0, g);
    this.box(1.6, 0.15, 1.4, this.mat('#2b2f3a', 0.4, 0.7), 0, 2.45, 0, g);
    for (const x of [-0.75, 0.75]) for (const z of [-0.65, 0.65]) this.box(0.1, 1.9, 0.1, this.mat('#3d4250', 0.4, 0.8), x, 1.45, z, g);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.9, 1.2), new THREE.MeshStandardMaterial({ color: '#9fd8ff', transparent: true, opacity: 0.12, roughness: 0.1, metalness: 0.1 }));
    glass.position.y = 1.45;
    g.add(glass);
    this.box(0.5, 0.5, 0.5, this.mat('#a8794e', 0.85), 0, 0.75, 0, g);
    const lamp = (color: string, y: number) => {
      const m = new THREE.MeshBasicMaterial({ color });
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 10), m);
      s.position.set(0.95, y, 0.55);
      g.add(s);
      return m;
    };
    this.rigLamps = { green: lamp('#1f5a2a', 2.2), amber: lamp('#5a4a1a', 1.9), red: lamp('#5a1f1f', 1.6) };
    this.rigScreen.mesh.position.set(0, 2.85, 0.4);
    g.add(this.rigScreen.mesh);
    this.box(1.3, 0.8, 0.06, this.mat('#15171f'), 0, 2.85, 0.36, g);
    this.rigScreen.lines('test rig', [{ text: 'waiting', color: '#7f8aa0' }]);
  }

  /** The scoreboard over the racks and the work board on the side wall, and the table's beacon. */
  private buildBoards() {
    this.box(6.3, 2.2, 0.12, this.mat('#15171f', 0.4, 0.3), -9.6, 6.1, -D / 2 + 0.75);
    this.scoreboard.mesh.position.set(-9.6, 6.1, -D / 2 + 0.82);
    this.scene.add(this.scoreboard.mesh);
    const wb = new THREE.Group();
    wb.position.set(-W / 2 + 0.12, 3.9, 1.4);
    wb.rotation.y = Math.PI / 2;
    this.scene.add(wb);
    this.box(4.7, 3.1, 0.1, this.mat('#e8ecf2', 0.6, 0), 0, 0, -0.06, wb);
    wb.add(this.workboard.mesh);
    this.beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.12, 3, 10, 1, true),
      new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffe27a').multiplyScalar(2.5), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.scene.add(this.beacon);
    this.trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#7ad7ff', transparent: true, opacity: 0.85 }));
    this.scene.add(this.trail);
    this.paintBoards();
  }

  private paintBoards() {
    const s = this.stats;
    this.scoreboard.lines('THIS SESSION', [
      { text: `read ${s.reads}   edited ${s.edits}  (+${s.adds} −${s.dels})`, color: '#cfe6f0' },
      { text: `commands ${s.commands}   turns ${s.turns}`, color: '#cfe6f0' },
      { text: `tests ✓ ${s.passed}   ✗ ${s.failed}`, color: s.failed ? '#ff9a9a' : '#9dff8a' },
      { text: `commits ${s.commits}`, color: '#ffd27a' },
    ], '#05070c');
    const lines: { text: string; color?: string }[] = [];
    if (this.todos.length) {
      for (const t of this.todos.slice(0, 7)) {
        const mark = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '○';
        lines.push({ text: `${mark} ${t.content}`, color: t.status === 'completed' ? '#7f8aa0' : t.status === 'in_progress' ? '#ffd27a' : '#cfe6f0' });
      }
      lines.push({ text: '', color: '#000' });
    }
    for (const l of this.log.slice(-(this.todos.length ? 3 : 9))) {
      lines.push({ text: `${l.glyph} ${l.text}`, color: l.ok === false ? '#ff9a9a' : l.ok ? '#cfe6f0' : '#7f8aa0' });
    }
    this.workboard.lines(this.todos.length ? 'JOB BOARD' : 'WORK LOG', lines, '#0a1420');
  }

  /** Pallet racks of crates, where robots go to read: a crate comes down carrying the file. */
  private buildRacks() {
    const upright = this.mat('#2c5aa0', 0.5, 0.5);
    const beam = this.mat('#e07a1f', 0.5, 0.4);
    const crates = new THREE.InstancedMesh(new THREE.BoxGeometry(0.75, 0.6, 0.85), new THREE.MeshStandardMaterial({ roughness: 0.85 }), 72);
    const m = new THREE.Matrix4();
    let n = 0;
    for (let bay = 0; bay < 3; bay++) {
      const x0 = -13.2 + bay * 3.1;
      for (const x of [x0, x0 + 2.9]) this.box(0.1, 4.6, 1.1, upright, x, 2.3, -D / 2 + 0.85);
      for (let level = 0; level < 4; level++) {
        const y = 0.25 + level * 1.15;
        this.box(2.9, 0.1, 0.08, beam, x0 + 1.45, y, -D / 2 + 0.35);
        this.box(2.9, 0.1, 0.08, beam, x0 + 1.45, y, -D / 2 + 1.35);
        for (let k = 0; k < 3; k++) {
          if (Math.random() < 0.15) continue;
          const p = new THREE.Vector3(x0 + 0.5 + k * 0.95, y + 0.36, -D / 2 + 0.85);
          m.makeTranslation(p.x, p.y, p.z);
          crates.setMatrixAt(n, m);
          const tone = 0.32 + Math.random() * 0.12;
          crates.setColorAt(n, new THREE.Color().setHSL(0.08, 0.45, tone));
          this.cratePos.push(p);
          n++;
        }
      }
    }
    crates.count = n;
    crates.castShadow = true;
    this.scene.add(crates);
  }

  /** Workbenches with monitors, robotic arms behind them, and a conveyor running past. */
  private buildAssemblyLine() {
    const top = this.mat('#6b4a33', 0.6, 0);
    const steel = this.mat('#3a3f4e', 0.4, 0.7);
    const z = -6.6;
    this.box(9.5, 0.1, 1.1, top, 1.2, 0.95, z);
    for (let x = -3.3; x <= 5.8; x += 1.8) this.box(0.08, 0.95, 1, steel, x, 0.475, z);
    for (const [x, main] of [
      [-1.8, false],
      [1.5, true],
      [4.6, false],
    ] as [number, boolean][]) {
      this.box(1.5, 0.95, 0.08, this.mat('#15171f', 0.4, 0.3), x, 1.75, z - 0.4);
      this.box(0.1, 0.3, 0.1, this.mat('#15171f'), x, 1.15, z - 0.4);
      this.box(0.8, 0.04, 0.3, this.mat('#2a2d38', 0.5), x, 1.02, z + 0.1);
      if (main) {
        this.deskScreen.mesh.position.set(x, 1.75, z - 0.355);
        this.scene.add(this.deskScreen.mesh);
      } else {
        const sc = new Screen(1.38, 0.82, 256);
        sc.lines(x < 0 ? 'lint' : 'fmt', [{ text: 'ok', color: '#9dff8a' }]);
        sc.mesh.position.set(x, 1.75, z - 0.355);
        this.scene.add(sc.mesh);
      }
    }
    const glow = new THREE.PointLight('#5fc8ff', 4, 6, 1.8);
    glow.position.set(1.5, 2, z + 0.8);
    this.scene.add(glow);
    this.deskScreen.idle('editor · idle');

    // Robotic arms: base, two segments and a gripper, swinging over the conveyor.
    for (const x of [-0.2, 3.2]) {
      const arm = new THREE.Group();
      arm.position.set(x, 0, -7.6);
      this.cyl(0.35, 0.45, 0.4, this.mat('#2b2f3a', 0.4, 0.7), 0, 0.2, 0, arm);
      const turret = new THREE.Group();
      turret.position.y = 0.4;
      arm.add(turret);
      const lower = new THREE.Group();
      lower.position.y = 0.25;
      turret.add(lower);
      this.box(0.22, 1.3, 0.22, this.mat('#f0a500', 0.45, 0.4), 0, 0.65, 0, lower);
      const upper = new THREE.Group();
      upper.position.y = 1.3;
      lower.add(upper);
      this.box(0.18, 1.1, 0.18, this.mat('#f0a500', 0.45, 0.4), 0, 0.55, 0, upper);
      this.box(0.3, 0.12, 0.3, this.mat('#2b2f3a', 0.4, 0.7), 0, 1.15, 0, upper);
      this.scene.add(arm);
      this.arms.push({ turret, lower, upper, phase: Math.random() * 6 });
    }

    // Conveyor with rollers and boxes riding it.
    const belt = this.box(13, 0.08, 0.9, this.mat('#1c1d22', 0.9, 0.1), 2.5, 0.85, -8.7);
    belt.receiveShadow = true;
    for (let x = -3.8; x <= 8.8; x += 0.6) this.cyl(0.05, 0.05, 0.95, steel, x, 0.79, -8.7, this.scene, 8).rotation.x = Math.PI / 2;
    for (const x of [-3.8, 8.8]) {
      this.box(0.08, 0.8, 0.08, steel, x, 0.4, -9.1);
      this.box(0.08, 0.8, 0.08, steel, x, 0.4, -8.3);
    }
    for (let i = 0; i < 7; i++) {
      const b = this.box(0.5, 0.4, 0.5, this.mat(i % 3 ? '#a8794e' : '#7a8a9a', 0.85), -3.5 + i * 1.8, 1.09, -8.7);
      this.conveyor.push(b);
    }
  }

  /** Rows of racks with blinking lights, and the console where shell commands run. */
  private buildServerRoom() {
    const g = new THREE.Group();
    this.scene.add(g);
    const rackMat = this.mat('#13151c', 0.35, 0.6);
    const ledsPer = 18;
    const racks: THREE.Vector3[] = [];
    for (let row = 0; row < 3; row++) for (let i = 0; i < 4; i++) racks.push(new THREE.Vector3(11.6 + i * 0.85, 0, -9.2 + row * 1.9));
    const leds = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.025, 0.02), new THREE.MeshBasicMaterial(), racks.length * ledsPer);
    const m = new THREE.Matrix4();
    racks.forEach((p, ri) => {
      this.box(0.75, 2.3, 1, rackMat, p.x, 1.15, p.z, g);
      for (let k = 0; k < ledsPer; k++) {
        m.makeTranslation(p.x - 0.28 + (k % 6) * 0.11, 0.5 + Math.floor(k / 6) * 0.55, p.z + 0.51);
        leds.setMatrixAt(ri * ledsPer + k, m);
        leds.setColorAt(ri * ledsPer + k, new THREE.Color('#1f6b3a'));
      }
    });
    g.add(leds);
    this.leds = leds;
    // Cable tray overhead, and cold light.
    this.box(3.6, 0.08, 0.5, this.mat('#555b6a', 0.4, 0.8), 12.9, 2.7, -7.3, g);
    const cold = new THREE.PointLight('#6fb8ff', 8, 8, 1.6);
    cold.position.set(12.8, 3.2, -7);
    g.add(cold);
    // Console.
    const console_ = new THREE.Group();
    console_.position.set(9.4, 0, -6.2);
    console_.rotation.y = -Math.PI / 5;
    g.add(console_);
    this.box(1.8, 0.9, 0.8, this.mat('#1b1e28', 0.4, 0.6), 0, 0.45, 0, console_);
    this.box(1.8, 1.25, 0.1, this.mat('#1b1e28', 0.4, 0.6), 0, 1.55, -0.35, console_);
    this.termScreen.mesh.position.set(0, 1.55, -0.29);
    console_.add(this.termScreen.mesh);
    const pink = new THREE.PointLight('#ff5fa2', 3, 5, 1.8);
    pink.position.set(0, 1.6, 0.6);
    console_.add(pink);
    this.termScreen.lines('zsh', [{ text: '$ _', color: '#9dff8a' }]);
  }

  /** A scanning gantry for searches: its head sweeps while a search runs. */
  private buildScanner() {
    const g = new THREE.Group();
    g.position.set(-13.2, 0, 0.2);
    this.scene.add(g);
    const frame = this.mat('#3d4250', 0.4, 0.8);
    this.box(0.15, 2.6, 0.15, frame, 0, 1.3, -1.2, g);
    this.box(0.15, 2.6, 0.15, frame, 0, 1.3, 1.2, g);
    this.box(0.2, 0.2, 2.6, frame, 0, 2.6, 0, g);
    this.box(1.2, 0.8, 2.2, this.mat('#2b2f3a', 0.5, 0.5), 0, 0.4, 0, g);
    const head = this.box(0.4, 0.3, 0.4, this.mat('#9a8cff', 0.4, 0.4, '#9a8cff', 0.6), 0, 2.4, 0, g);
    const laser = new THREE.Mesh(
      new THREE.PlaneGeometry(0.03, 1.6),
      new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff3b6b').multiplyScalar(3), transparent: true, opacity: 0.8 }),
    );
    laser.position.y = -0.95;
    head.add(laser);
    this.drawer = head;
    const lamp = new THREE.PointLight('#9a8cff', 0, 5, 1.6);
    lamp.position.set(0.6, 2, 0);
    lamp.name = 'cabinet-lamp';
    g.add(lamp);
  }

  /** The comms station: a satellite dish and a radio rack, for web lookups. */
  private buildComms() {
    const g = this.telescope;
    g.position.set(-13.2, 0, -4.6);
    this.scene.add(g);
    this.box(1.2, 1.8, 0.7, this.mat('#2a2f3c', 0.5, 0.5), 0, 0.9, 1.1, g);
    for (let i = 0; i < 6; i++) this.box(0.9, 0.04, 0.02, this.mat('#5fffd0', 0.4, 0, '#5fffd0', 1.2), 0, 0.5 + i * 0.22, 1.46, g);
    this.cyl(0.06, 0.12, 1.6, this.mat('#8a93a8', 0.4, 0.7), 0, 0.8, -0.3, g, 8);
    const dish = new THREE.Mesh(new THREE.SphereGeometry(0.9, 24, 12, 0, Math.PI * 2, 0, Math.PI / 3), this.mat('#d8dce6', 0.3, 0.5));
    dish.position.set(0, 1.8, -0.3);
    dish.rotation.x = -Math.PI / 2.6;
    dish.castShadow = true;
    dish.name = 'tube';
    g.add(dish);
  }

  /** A wall of switches and lamps, for MCP calls. */
  private buildControlPanel() {
    const g = new THREE.Group();
    g.position.set(14.3, 0, 1.5);
    g.rotation.y = -Math.PI / 2;
    this.scene.add(g);
    this.box(3.2, 2.4, 0.5, this.mat('#4a5568', 0.5, 0.5), 0, 1.2, 0, g);
    const lights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.05, 10, 8), new THREE.MeshBasicMaterial(), 40);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 40; i++) {
      m.makeTranslation(-1.3 + (i % 10) * 0.29, 1.3 + Math.floor(i / 10) * 0.25, 0.27);
      lights.setMatrixAt(i, m);
      lights.setColorAt(i, new THREE.Color('#442a1a'));
    }
    g.add(lights);
    this.boardLights = lights;
    for (let i = 0; i < 6; i++) {
      const lever = this.box(0.05, 0.3, 0.05, this.mat('#222'), -1 + i * 0.4, 0.75, 0.32, g);
      lever.rotation.x = 0.4;
      this.box(0.1, 0.1, 0.1, this.mat('#c0392b'), -1 + i * 0.4, 0.9, 0.38, g);
    }
  }

  /** The break room, where idle robots wait. */
  private buildBreakRoom() {
    const rug = new THREE.Mesh(new THREE.CircleGeometry(2.4, 48), this.mat('#5b2f4a', 0.95));
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(-10.2, 0.01, 6.2);
    rug.receiveShadow = true;
    this.scene.add(rug);
    const sofa = this.mat('#3f6f7a', 0.9);
    this.box(3.4, 0.45, 0.9, sofa, -10.2, 0.3, 7.6);
    this.box(3.4, 0.8, 0.25, sofa, -10.2, 0.75, 8.0);
    this.box(0.25, 0.65, 0.9, sofa, -11.9, 0.45, 7.6);
    this.box(0.25, 0.65, 0.9, sofa, -8.5, 0.45, 7.6);
    // Vending machine with a lit front, and a coffee machine on a counter.
    this.box(1, 2, 0.8, this.mat('#b02a2a', 0.5, 0.3), -14.3, 1, 3.6);
    this.box(0.7, 1.4, 0.05, this.mat('#ffffff', 0.3, 0, '#9fd8ff', 1.4), -13.9, 1.15, 3.6).rotation.y = Math.PI / 2;
    this.box(1.6, 0.95, 0.7, this.mat('#6b4a33', 0.7), -14.3, 0.475, 5.6);
    this.box(0.4, 0.5, 0.35, this.mat('#2b2f3a', 0.4, 0.7), -14.3, 1.2, 5.4);
    this.cyl(0.07, 0.06, 0.12, this.mat('#f3ead2'), -14.1, 1.01, 5.9);
    const lamp = new THREE.PointLight('#ffb764', 6, 7, 1.6);
    lamp.position.set(-10.2, 2.4, 6.8);
    this.scene.add(lamp);
    const plant = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 1), this.mat('#3f8f4f', 0.8));
    plant.position.set(-7.6, 1, 8.6);
    this.scene.add(plant);
    this.box(0.55, 0.55, 0.55, this.mat('#b0643a', 0.8), -7.6, 0.28, 8.6);
  }

  /** The loading bay: a roller shutter in a frame, where helpers arrive. */
  private buildLoadingBay() {
    const g = new THREE.Group();
    g.position.set(9.5, 0, D / 2 - 0.2);
    this.scene.add(g);
    const frame = this.mat('#2b2f3a', 0.4, 0.7);
    this.box(0.3, 3.4, 0.3, frame, -1.6, 1.7, 0, g);
    this.box(0.3, 3.4, 0.3, frame, 1.6, 1.7, 0, g);
    this.box(3.5, 0.5, 0.4, frame, 0, 3.55, 0, g);
    const shutter = this.painted(64, 128, (x) => {
      for (let y = 0; y < 128; y += 8) {
        x.fillStyle = y % 16 ? '#6b7280' : '#5a616d';
        x.fillRect(0, y, 64, 8);
      }
    });
    this.box(3, 0.9, 0.1, new THREE.MeshStandardMaterial({ map: shutter, metalness: 0.6, roughness: 0.4 }), 0, 2.85, 0, g);
    this.portal = new THREE.Mesh(
      new THREE.PlaneGeometry(2.9, 2.4),
      new THREE.MeshBasicMaterial({ color: '#c6ff6e', transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.portal.position.set(0, 1.2, 0);
    g.add(this.portal);
    // Hazard stripes on the floor in front of it, a pallet and a parked forklift.
    const stripes = this.painted(128, 32, (x) => {
      for (let i = -32; i < 160; i += 16) {
        x.fillStyle = '#d9a400';
        x.beginPath();
        x.moveTo(i, 0);
        x.lineTo(i + 8, 0);
        x.lineTo(i - 8, 32);
        x.lineTo(i - 16, 32);
        x.fill();
      }
    });
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.8), new THREE.MeshBasicMaterial({ map: stripes }));
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(0, 0.012, -0.8);
    g.add(pad);
    const fork = new THREE.Group();
    fork.position.set(13, 0, 7);
    fork.rotation.y = -0.6;
    this.scene.add(fork);
    this.box(1.1, 0.7, 1.6, this.mat('#f0a500', 0.5, 0.3), 0, 0.55, 0, fork);
    this.box(0.9, 1, 0.05, this.mat('#222'), 0, 1.4, -0.1, fork).rotation.x = 0.1;
    this.box(0.08, 2, 0.08, this.mat('#333', 0.4, 0.7), -0.4, 1.1, -0.85, fork);
    this.box(0.08, 2, 0.08, this.mat('#333', 0.4, 0.7), 0.4, 1.1, -0.85, fork);
    this.box(0.1, 0.05, 1, this.mat('#333', 0.4, 0.7), -0.3, 0.15, -1.3, fork);
    this.box(0.1, 0.05, 1, this.mat('#333', 0.4, 0.7), 0.3, 0.15, -1.3, fork);
    for (const [x, z] of [
      [-0.4, 0.6],
      [0.4, 0.6],
      [-0.45, -0.5],
      [0.45, -0.5],
    ])
      this.cyl(0.22, 0.22, 0.15, this.mat('#111'), x, 0.22, z, fork, 14).rotation.z = Math.PI / 2;
  }

  /** An overhead gantry crane that trundles along the hall, faster when work is under way. */
  private buildCrane() {
    const steel = this.mat('#e0b020', 0.5, 0.5);
    // Only the back rail: a front one would cross the camera's view of the whole hall.
    this.box(W - 1, 0.2, 0.2, this.mat('#3d4250', 0.4, 0.8), 0, H - 0.6, -D / 2 + 0.5);
    const bridge = new THREE.Group();
    bridge.position.y = H - 0.45;
    this.box(0.4, 0.35, D - 0.8, steel, 0, 0, 0, bridge);
    const hoist = new THREE.Group();
    this.box(0.6, 0.4, 0.6, this.mat('#2b2f3a', 0.4, 0.7), 0, -0.35, 0, hoist);
    this.cyl(0.015, 0.015, 2.2, this.mat('#111'), 0, -1.6, 0, hoist, 6);
    this.box(0.35, 0.25, 0.2, this.mat('#c0392b', 0.5, 0.4), 0, -2.75, 0, hoist);
    bridge.add(hoist);
    this.scene.add(bridge);
    this.crane = { bridge, hoist };
  }

  private buildClutter(orange: THREE.Material) {
    for (const [x, z] of [
      [6.8, 7.8],
      [7.4, 8.4],
      [6.9, 8.9],
      [-3.8, 8.6],
    ])
      this.cyl(0.32, 0.32, 0.95, this.mat(Math.random() < 0.5 ? '#2c5aa0' : '#b0543a', 0.5, 0.4), x, 0.475, z, this.scene, 16);
    for (let i = 0; i < 5; i++) this.box(0.8, 0.6, 0.8, this.mat('#a8794e', 0.85), 3 + (i % 3) * 0.85, 0.3 + Math.floor(i / 3) * 0.6, 8.6);
    // A ventilation fan in the side wall.
    const fan = new THREE.Group();
    fan.position.set(-W / 2 + 0.05, 4.8, -1.5);
    fan.rotation.y = Math.PI / 2;
    this.scene.add(fan);
    this.cyl(0.75, 0.75, 0.1, this.mat('#222'), 0, 0, 0, fan, 24).rotation.x = Math.PI / 2;
    const blades = new THREE.Group();
    blades.position.z = 0.08;
    fan.add(blades);
    for (let i = 0; i < 4; i++) {
      const b = this.box(0.18, 0.65, 0.02, orange, 0, 0.32, 0, blades);
      b.geometry.translate(0, 0, 0);
      const pivot = new THREE.Group();
      pivot.rotation.z = (i / 4) * Math.PI * 2;
      pivot.add(b);
      blades.add(pivot);
    }
    this.fans.push(blades);
  }

  // ---------------------------------------------------------------- the project, as a city

  setFiles(root: string, files: string[], sizes: number[] = []) {
    this.root = root.replace(/\/$/, '');
    this.city.setFiles(files, sizes);
    this.hooks.files(this.city.count);
  }

  private rel(path: string): string | null {
    if (!path) return null;
    if (this.root && path.startsWith(this.root + '/')) return path.slice(this.root.length + 1);
    if (!path.startsWith('/')) return path.replace(/^\.\//, '');
    return null;
  }

  private beam(r: Robot, to: THREE.Vector3, color: string) {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 1, 6, 1, true),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.2), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.scene.add(mesh);
    this.beams.push({ mesh, robot: r, to: to.clone(), life: 1.6 });
  }

  /** Light the files a tool is about and draw a beam from the robot to the first. */
  private markFiles(r: Robot, t: Task) {
    const color = KIND_COLOR[t.kind];
    const files = t.file ? [t.file] : [];
    if (t.kind === 'search') {
      const dir = this.rel(typeof t.input?.path === 'string' ? t.input.path : '') ?? '';
      let n = 0;
      for (const f of this.cityFilesUnder(dir)) {
        this.city.touch(f, color, 0.7);
        if (n++ === 0) files.push(f);
        if (n > 40) break;
      }
    }
    for (const f of files) {
      this.city.touch(f, color, 1.3);
      const roof = this.city.roof(f);
      if (roof) this.beam(r, roof, color);
    }
  }

  private *cityFilesUnder(dir: string): Generator<string> {
    for (const f of this.allFiles()) if (!dir || f.startsWith(dir.replace(/\/$/, '') + '/')) yield f;
  }

  private allFiles(): string[] {
    return (this.city as any).buildings.map((b: { path: string }) => b.path);
  }

  // ---------------------------------------------------------------- agents

  /** A robot waiting in the lounge before claude has said who it is. */
  placeholder() {
    if (!this.robots.size) this.robotFor(null, null).setAction('waiting for a task');
  }

  private robotFor(session: string | null, parent: string | null): Robot {
    // Daemon-made events (permission cards in archives) carry no session: they belong to
    // whoever is already working, not to a new arrival.
    if (!session && !parent) {
      const main = [...this.robots.values()].reverse().find((x) => x.scale === 1 && !x.leaving);
      if (main) return main;
    }
    const key = parent ?? session ?? 'main';
    let r = this.robots.get(key);
    if (r) return r;
    // The first real session adopts the placeholder rather than spawning beside it.
    const stand = this.robots.get('main');
    if (!parent && session && stand) {
      this.robots.delete('main');
      this.robots.set(key, stand);
      stand.rename(`agent ${session.slice(0, 6)}`);
      return stand;
    }
    const base = this.robots.get(session ?? 'main');
    const color = parent && base ? base.color.clone().offsetHSL(0.08, 0, 0.1) : new THREE.Color().setHSL(0.5 + hash(key) * 0.5, 0.75, 0.55);
    const name = parent ? 'helper' : session ? `agent ${session.slice(0, 6)}` : 'agent';
    r = new Robot(key, name, color, parent ? 0.72 : 1, this.slots++);
    r.pos.copy(parent ? STATIONS.door.stand : STATIONS.lounge.stand);
    r.goTo(parent ? 'floor' : 'lounge');
    this.robots.set(key, r);
    this.scene.add(r.group);
    if (parent) this.portalFlash();
    return r;
  }

  session(id: string | null, cwd: string) {
    const r = this.robotFor(id, null);
    const name = cwd.split('/').pop() || 'agent';
    r.rename(name);
    r.onTag = () => this.hooks.focus(id);
    if (!r.current) r.setAction(`ready in ${name}`);
  }

  setFocus(session: string | null) {
    for (const [key, r] of this.robots) r.setFocused(key === session);
  }

  turnStarted(session: string | null, prompt: string, live: boolean) {
    this.stats.turns++;
    this.trailPts = [];
    this.paintBoards();
    const r = this.robotFor(session, null);
    r.idle = false;
    r.goTo('floor');
    r.setAction('reading the brief');
    if (live) r.say(`“${prompt.slice(0, 110)}${prompt.length > 110 ? '…' : ''}”`, 'note', 5);
  }

  thinking(session: string | null, parent: string | null, tokens: number) {
    const r = this.robotFor(session, parent);
    r.thinking = Math.min(1, r.thinking + 0.15);
    r.idle = false;
    if (!r.current) r.setAction(tokens ? `thinking · ~${tokens} tokens` : 'thinking');
    r.say(tokens ? `thinking… ~${tokens} tokens` : 'thinking…', 'think', 2);
  }

  speaking(session: string | null, parent: string | null, text: string) {
    const r = this.robotFor(session, parent);
    r.speaking = 1;
    const tail = text.length > 140 ? '…' + text.slice(-140) : text;
    r.say(tail, 'say', 6);
  }

  toolCall(info: ToolCallInfo, live: boolean) {
    this.calls.set(info.callId, info);
    this.trackTodos(info);
    const paths = info.paths.map((p) => this.rel(p)).filter((p): p is string => p !== null);
    const file: string | null = paths[0] ?? null;
    if (file && info.kind === 'write' && this.city.addFile(file)) this.hooks.files(this.city.count);

    if (!live) {
      if (info.kind === 'edit' || info.kind === 'write') for (const p of paths) this.city.edited(p, false);
      return;
    }
    const r = this.robotFor(info.session, info.parent);
    r.idle = false;
    r.queue.push({
      callId: info.callId,
      kind: info.kind,
      station: info.kind === 'shell' ? shellStation(String(info.input?.command ?? '')) : KIND_STATION[info.kind],
      label: `${KIND_GLYPH[info.kind]} ${VERB[info.kind]} ${info.label}`.trim(),
      file,
      input: info.input,
      done: false,
      ok: null,
      summary: '',
      test: false,
      workedFor: 0,
    });
  }

  toolResult(session: string | null, parent: string | null, callId: string, ok: boolean, summary: string, test: boolean, live: boolean) {
    const helper = this.robots.get(callId);
    if (helper) {
      helper.leaving = true;
      helper.goTo('door');
      helper.setAction(ok ? 'done, heading out' : 'gave up');
    }
    this.tally(callId, ok, summary);
    if (!live) return;
    const r = this.robotFor(session, parent);
    const task = r.current?.callId === callId ? r.current : r.queue.find((t) => t.callId === callId);
    if (!task) return;
    task.done = true;
    task.ok = ok;
    task.summary = summary;
    task.test = test;
    if (task === r.current && r.arrived) this.finish(r, task);
  }

  turnEnded(session: string | null, ok: boolean, live: boolean) {
    const r = this.robotFor(session, null);
    r.idle = true;
    r.asking = false;
    if (live) {
      r.mood = ok ? 'happy' : 'sad';
      setTimeout(() => {
        if (r.mood === 'happy' || r.mood === 'sad') r.mood = 'normal';
      }, 2500);
    }
    if (!r.current && !r.queue.length) {
      r.goTo('lounge');
      r.setAction('your turn');
    }
  }

  /** The terminal closed: the robot clocks off through the loading bay. */
  sessionEnded(session: string | null) {
    const r = this.robots.get(session ?? 'main');
    if (!r) return;
    r.idle = true;
    r.leaving = true;
    r.goTo('door');
    r.setAction('clocking off');
  }

  setWaiting(session: string | null, tool: string | null, waiting: boolean) {
    this.waiting = waiting;
    const r = this.robotFor(session, null);
    r.asking = waiting;
    if (waiting) {
      r.say(`may I use ${tool ?? 'this'}?`, 'ask', 600);
      this.spot.target.position.copy(r.pos);
    } else {
      r.hush();
    }
  }

  compaction(session: string | null) {
    const r = this.robotFor(session, null);
    r.say('tidying up my notes', 'note', 3);
    this.sparks.ring(r.pos.clone().setY(1), new THREE.Color('#ffffff'), 80, 6);
  }

  reset() {
    for (const r of this.robots.values()) r.dispose();
    this.robots.clear();
    this.slots = 0;
    for (const f of this.flying) {
      f.mesh.removeFromParent();
      f.label.element.remove();
      f.label.removeFromParent();
    }
    this.flying = [];
    for (const b of this.beams) b.mesh.removeFromParent();
    this.beams = [];
    for (const c of this.cards.values()) {
      c.obj.element.remove();
      c.obj.removeFromParent();
    }
    this.cards.clear();
    this.stats = { reads: 0, edits: 0, adds: 0, dels: 0, commands: 0, passed: 0, failed: 0, commits: 0, turns: 0 };
    this.last = {};
    this.touched.clear();
    this.log = [];
    this.todos = [];
    this.trailPts = [];
    this.trail.geometry.setFromPoints([]);
    this.beaconAt = null;
    this.paintBoards();
    this.city.resetActivity();
    this.waiting = false;
    this.placeholder();
    this.deskScreen.idle('editor · idle');
    this.termScreen.lines('zsh', [{ text: '$ _', color: '#9dff8a' }]);
  }

  // ---------------------------------------------------------------- idle thoughts

  /**
   * Something absurd, but about this project: its files, its biggest file, its busiest folder,
   * what was just run and what it said. Falls back to the general musings only when there is
   * nothing yet to go on.
   */
  private musing(): string {
    const c = this.city.census();
    const s = this.stats;
    const project = this.root.split('/').pop() || 'this project';
    const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
    const kb = (n: number) => (n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.round(n / 1000)} KB`);
    const dirs = [...c.byDir.entries()].sort((a, b) => b[1] - a[1]);
    const exts = [...c.byExt.entries()].sort((a, b) => b[1] - a[1]);
    const ideas: string[] = [];

    if (c.biggest && c.biggest.size > 20_000) {
      ideas.push(
        `${c.biggest.path} is ${kb(c.biggest.size)}. That is not a file. That is a county.`,
        `Nobody has ever read ${c.biggest.path} from top to bottom. Nobody who came back, anyway.`,
      );
    }
    if (dirs.length) {
      const [d, n] = dirs[0];
      ideas.push(`${d}/ has ${n} files in it. I have been to ${[...this.touched].filter((f) => f.startsWith(d + '/')).length}. The rest, I assume, are haunted.`);
      if (dirs.length > 3) {
        const [small, k] = dirs[dirs.length - 1];
        ideas.push(`Spare a thought for ${small}/, with its ${k} file${k === 1 ? '' : 's'}, watching ${d}/ get all the attention.`);
      }
    }
    if (exts.length > 1) {
      const [a, na] = exts[0];
      const [b, nb] = exts[1];
      ideas.push(`There are ${na} .${a} files in ${project} and ${nb} .${b} files. They have never once spoken.`);
    }
    ideas.push(`${project}: ${c.files} files, and every single one of them believes it is the main one.`);
    if (this.last.command && this.last.output) {
      ideas.push(`Earlier I ran \`${this.last.command}\` and it said "${this.last.output}". I think about that a lot.`);
    }
    if (this.last.failedCmd) ideas.push(`\`${this.last.failedCmd}\` failed earlier. We do not speak of it. I am speaking of it now. That was a mistake.`);
    if (this.last.read) ideas.push(`I read ${this.last.read} earlier. I am still not over the first line.`);
    if (this.last.edited) ideas.push(`I changed ${this.last.edited}. It looks exactly the same from here, which is the mark of true craftsmanship.`);
    if (s.adds + s.dels > 0) {
      ideas.push(`+${s.adds} −${s.dels} this session. Net, ${s.adds - s.dels} lines of pure, distilled ambition.`);
    }
    if (s.passed + s.failed > 0) {
      ideas.push(
        s.failed
          ? `${s.passed} tests passed and ${s.failed} failed. I choose to remember only the first number.`
          : `${s.passed} tests passed. Not one failed. I have never been so frightened.`,
      );
    }
    if (this.last.commit) ideas.push(`We shipped "${this.last.commit}". It is out there now, somewhere, being a commit.`);
    if (s.commands > 20) ideas.push(`${s.commands} commands this session. The terminal and I are no longer on speaking terms.`);

    // Mostly the project; now and then, the general nonsense.
    return ideas.length && Math.random() < 0.85 ? pick(ideas) : pick(MUSINGS);
  }

  // ---------------------------------------------------------------- the record of work

  private trackTodos(info: ToolCallInfo) {
    const input = info.input ?? {};
    if (info.tool === 'TodoWrite' && Array.isArray(input.todos)) {
      this.todos = input.todos.map((t: any) => ({ content: String(t.content ?? t.subject ?? ''), status: String(t.status ?? 'pending') }));
    } else if (info.tool === 'TaskCreate' && (input.subject || input.description)) {
      this.todos.push({ content: String(input.subject ?? input.description), status: 'pending' });
    } else if (info.tool === 'TaskUpdate' && input.status) {
      const key = String(input.subject ?? input.taskId ?? '');
      const t = this.todos.find((x, i) => x.content === key || String(i + 1) === key);
      if (t) t.status = String(input.status);
    } else {
      return;
    }
    this.paintBoards();
  }

  private tally(callId: string, ok: boolean, summary: string) {
    const info = this.calls.get(callId);
    if (!info) return;
    const s = this.stats;
    const cmd = String(info.input?.command ?? '');
    switch (info.kind) {
      case 'read':
        s.reads++;
        break;
      case 'edit':
      case 'write': {
        if (!ok) break;
        s.edits++;
        const before = typeof info.input?.old_string === 'string' ? info.input.old_string : '';
        const after = typeof info.input?.new_string === 'string' ? info.input.new_string : typeof info.input?.content === 'string' ? info.input.content : '';
        if (!before) s.adds += after ? after.split('\n').length : 0;
        else for (const l of diffLines(before, after)) l.op === '+' ? s.adds++ : l.op === '-' ? s.dels++ : 0;
        break;
      }
      case 'shell': {
        s.commands++;
        const counts = TEST_COMMAND.test(cmd) ? testCounts(summary) : null;
        if (counts) {
          s.passed += counts.passed;
          s.failed += counts.failed;
        }
        if (ok && /\bgit\s+commit\b/.test(cmd)) s.commits++;
        break;
      }
    }
    const file = info.paths.map((p) => this.rel(p)).find((p): p is string => !!p);
    if (file) this.touched.add(file);
    if (info.kind === 'read' && file) this.last.read = file;
    if ((info.kind === 'edit' || info.kind === 'write') && file && ok) this.last.edited = file;
    if (info.kind === 'shell') {
      this.last.command = cmd.split('\n')[0].slice(0, 60);
      this.last.output = summary.split('\n').map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 70);
      if (!ok) this.last.failedCmd = this.last.command;
      const msg = /\bgit\s+commit\b/.test(cmd) && ok ? commitMessage(cmd) : null;
      if (msg) this.last.commit = msg;
    }
    this.log.push({ glyph: KIND_GLYPH[info.kind], text: `${info.tool} ${info.label}`.slice(0, 60), ok });
    if (this.log.length > 30) this.log.shift();
    this.paintBoards();
  }

  /** An HTML card at the machine, showing exactly what the robot is doing there. */
  private openCard(r: Robot, t: Task) {
    const st = STATIONS[t.station as StationId] ?? STATIONS.floor;
    const el = document.createElement('div');
    el.className = 'work-card';
    el.style.setProperty('--kind', KIND_COLOR[t.kind]);
    const head = document.createElement('div');
    head.className = 'wc-head';
    const body = document.createElement('div');
    body.className = 'wc-body';
    el.append(head, body);
    const input = t.input ?? {};
    if (t.kind === 'edit' || t.kind === 'write') {
      const before = typeof input.old_string === 'string' ? input.old_string : '';
      const after = typeof input.new_string === 'string' ? input.new_string : typeof input.content === 'string' ? input.content : '';
      const lines: { op: ' ' | '-' | '+'; text: string }[] = before ? diffLines(before, after) : after.split('\n').map((text: string) => ({ op: '+' as const, text }));
      const adds = lines.filter((l) => l.op === '+').length;
      const dels = lines.filter((l) => l.op === '-').length;
      head.innerHTML = `${KIND_GLYPH[t.kind]} <b>${esc(t.file ?? 'file')}</b> <span class="add">+${adds}</span> <span class="del">−${dels}</span>`;
      body.innerHTML = lines
        .filter((l) => l.op !== ' ')
        .slice(0, 10)
        .map((l) => `<div class="${l.op === '+' ? 'add' : 'del'}">${l.op} ${esc(l.text)}</div>`)
        .join('');
    } else if (t.kind === 'shell') {
      head.innerHTML = `❯ <b>${esc(String(input.command ?? '').split('\n')[0].slice(0, 90))}</b>`;
      body.innerHTML = `<div class="dim">running…</div>`;
    } else {
      head.innerHTML = `${KIND_GLYPH[t.kind]} <b>${esc(t.label.replace(/^\S+\s/, ''))}</b>`;
      body.innerHTML = `<div class="dim">…</div>`;
    }
    const obj = new CSS2DObject(el);
    // High enough to clear the robot's own name tag in front of the machine.
    obj.position.copy(st.look).add(new THREE.Vector3(0, 3.4, 0));
    this.scene.add(obj);
    this.cards.set(t.callId, { obj, body, until: Infinity });
    while (this.cards.size > 3) {
      const [k, c] = this.cards.entries().next().value!;
      c.obj.element.remove();
      c.obj.removeFromParent();
      this.cards.delete(k);
    }
  }

  private fillCard(t: Task) {
    const card = this.cards.get(t.callId);
    if (!card) return;
    card.until = performance.now() + 4000;
    card.obj.element.classList.toggle('failed', t.ok === false);
    if (t.kind === 'edit' || t.kind === 'write') return;
    let lines = t.summary.split('\n').filter((l) => l.trim());
    lines = t.kind === 'shell' ? lines.slice(-8) : lines.slice(0, 8);
    const counts = t.kind === 'shell' && TEST_COMMAND.test(String(t.input?.command ?? '')) ? testCounts(t.summary) : null;
    const head = counts ? `<div class="${counts.failed ? 'del' : 'add'}">tests: ${counts.passed} passed, ${counts.failed} failed</div>` : '';
    card.body.innerHTML = head + (lines.length ? lines.map((l) => `<div>${esc(l.replace(/^\s*\d+\t/, '').slice(0, 110))}</div>`).join('') : `<div class="dim">${t.ok ? 'done' : 'failed'}</div>`);
  }

  private ship(message: string) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.6, 0.8), new THREE.MeshStandardMaterial({ color: '#c8925a', emissive: '#ffd27a', emissiveIntensity: 0.4 }));
    mesh.position.set(9.5, 0.3, 6.8);
    mesh.castShadow = true;
    this.scene.add(mesh);
    const el = document.createElement('div');
    el.className = 'book-label ship';
    el.textContent = `📦 ${message}`;
    const label = new CSS2DObject(el);
    label.position.set(0, 0.7, 0);
    mesh.add(label);
    this.shipments.push({ mesh, label, t: 0 });
  }

  // ---------------------------------------------------------------- task lifecycle

  private begin(r: Robot, t: Task) {
    r.current = t;
    r.goTo(t.station);
    r.setAction(t.label, t.kind);
  }

  /** Called on arrival: the station reacts to what the robot came to do. */
  private arrive(r: Robot, t: Task) {
    const color = new THREE.Color(KIND_COLOR[t.kind]);
    switch (t.kind) {
      case 'read':
        if (t.file) this.flyBook(Math.floor(Math.random() * 1000), r, t.file);
        break;
      case 'edit':
      case 'write': {
        this.busy.desk = 1;
        const lines: { text: string; color?: string }[] = [];
        const before = typeof t.input?.old_string === 'string' ? t.input.old_string : '';
        const after = typeof t.input?.new_string === 'string' ? t.input.new_string : typeof t.input?.content === 'string' ? t.input.content : '';
        for (const l of before.split('\n').slice(0, 6)) if (before) lines.push({ text: `- ${l}`, color: '#ff8f8f' });
        for (const l of after.split('\n').slice(0, 12)) lines.push({ text: `+ ${l}`, color: '#9dff8a' });
        this.deskScreen.lines(`✎ ${t.file ?? 'file'}`, lines);
        break;
      }
      case 'shell': {
        this.busy.terminal = 1;
        const cmd = typeof t.input?.command === 'string' ? t.input.command : '';
        this.termScreen.lines('zsh', [{ text: `$ ${cmd.split('\n')[0]}`, color: '#9dff8a' }, { text: '…', color: '#7f8aa0' }]);
        if (t.station === 'testrig') {
          this.rig = { state: 'running', t: 0 };
          this.rigScreen.lines('test rig', [{ text: 'running…', color: '#ffd27a' }, { text: cmd.split('\n')[0].slice(0, 40), color: '#7f8aa0' }]);
        } else if (t.station === 'desk') {
          this.busy.desk = 1;
          this.deskScreen.lines('build', [{ text: `$ ${cmd.split('\n')[0]}`, color: '#9dff8a' }]);
        } else if (t.station === 'window') {
          this.busy.window = 1;
        }
        break;
      }
      case 'search':
        this.busy.cabinet = 1;
        break;
      case 'web':
        this.busy.window = 1;
        break;
      case 'mcp':
        this.busy.switchboard = 1;
        break;
      case 'agent':
        this.portalFlash();
        break;
    }
    this.markFiles(r, t);
    this.openCard(r, t);
    if (t.file) {
      const roof = this.city.roof(t.file);
      if (roof) {
        this.beaconAt = roof;
        this.trailPts.push(roof.clone().add(new THREE.Vector3(0, 0.05, 0)));
        if (this.trailPts.length > 14) this.trailPts.shift();
        this.trail.geometry.setFromPoints(this.trailPts);
      }
    }
    this.sparks.burst(r.pos.clone().setY(1.1), color, 14, 2.5, 0.8, 0.22);
  }

  private finish(r: Robot, t: Task) {
    this.fillCard(t);
    if (t.kind === 'shell' && t.station === 'testrig') {
      const counts = testCounts(t.summary);
      this.rig = { state: t.ok && !(counts && counts.failed) ? 'ok' : 'fail', t: 0 };
      this.rigScreen.lines(t.ok ? 'tests passed' : 'tests failed', counts
        ? [{ text: `✓ ${counts.passed} passed`, color: '#9dff8a' }, { text: `✗ ${counts.failed} failed`, color: counts.failed ? '#ff9a9a' : '#7f8aa0' }]
        : [{ text: t.ok ? 'ok' : 'failed', color: t.ok ? '#9dff8a' : '#ff9a9a' }], t.ok ? '#04121a' : '#1e0606');
    }
    if (t.kind === 'shell' && t.ok && t.station === 'door') {
      const msg = commitMessage(String(t.input?.command ?? ''));
      if (msg || /\bgit\s+push\b/.test(String(t.input?.command ?? ''))) this.ship(msg ?? 'pushed');
    }
    if (t.kind === 'shell') {
      const cmd = typeof t.input?.command === 'string' ? t.input.command.split('\n')[0] : '';
      const out = t.summary.split('\n').filter((l) => l.trim()).slice(-7);
      this.termScreen.lines(t.ok ? 'zsh · ok' : 'zsh · failed', [
        { text: `$ ${cmd}`, color: '#9dff8a' },
        ...out.map((l) => ({ text: l, color: t.ok ? '#cfe6f0' : '#ff9a9a' })),
      ], t.ok ? '#04121a' : '#1e0606');
    }
    const at = r.pos.clone().setY(1.2);
    if (t.test && t.ok) this.confetti(at.clone().setY(2.6));
    else if (!t.ok) {
      this.failure(r);
      if (t.file) this.city.touch(t.file, '#ff3030', 2);
    } else if (t.kind === 'edit' || t.kind === 'write') {
      if (t.file) {
        this.city.edited(t.file, true);
        const roof = this.city.roof(t.file);
        if (roof) this.sparks.burst(roof, new THREE.Color(KIND_COLOR[t.kind]), 30, 1.6, 1, 0.16);
      }
      this.sparks.burst(new THREE.Vector3(1.5, 1.2, -6.3), new THREE.Color(KIND_COLOR[t.kind]), 40, 4, 1.1, 0.3);
    }
    if (t.ok) r.mood = 'happy';
    setTimeout(() => {
      if (r.mood === 'happy') r.mood = 'normal';
    }, 900);
    r.current = null;
  }

  /** A crate comes off the racks carrying the file's name, and goes back when the read is done. */
  private flyBook(i: number, r: Robot, file: string) {
    const from = (this.cratePos[i % Math.max(1, this.cratePos.length)] ?? new THREE.Vector3(-9.6, 1, -9)).clone();
    const tint = new THREE.Color('#c8925a');
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.36, 0.5), new THREE.MeshStandardMaterial({ color: tint, emissive: '#6ec8ff', emissiveIntensity: 0.6 }));
    mesh.position.copy(from);
    this.scene.add(mesh);
    const el = document.createElement('div');
    el.className = 'book-label';
    el.textContent = file;
    const label = new CSS2DObject(el);
    // Below the book, so it never sits on the robot's own name tag.
    label.position.set(0, -0.42, 0);
    mesh.add(label);
    this.flying.push({ mesh, from, robot: r, t: 0, label, back: false });
  }

  private portalFlash() {
    (this.portal.material as THREE.MeshBasicMaterial).opacity = 0.9;
    this.sparks.burst(new THREE.Vector3(9.5, 1.3, 9.2), new THREE.Color(KIND_COLOR.agent), 80, 4, 1.3, 0.3);
  }

  private confetti(p: THREE.Vector3) {
    const colors = ['#9dff8a', '#ffe27a', '#7ad7ff', '#ff9de2', '#ffb347'];
    for (let k = 0; k < 5; k++) {
      setTimeout(() => this.sparks.burst(p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, Math.random(), (Math.random() - 0.5) * 2)), new THREE.Color(colors[k]), 70, 5, 1.6, 0.28), k * 140);
    }
  }

  private failure(r: Robot) {
    this.alarmT = 2.2;
    r.mood = 'sad';
    this.sparks.burst(r.pos.clone().setY(1.6), new THREE.Color('#9a9a9a'), 30, 1.2, 2, 0.5);
    setTimeout(() => {
      if (r.mood === 'sad') r.mood = 'normal';
    }, 2200);
  }

  // ---------------------------------------------------------------- frame

  private frame() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.05);
    const now = performance.now() / 1000;

    for (const [key, r] of this.robots) {
      if (!r.current && r.queue.length) this.begin(r, r.queue.shift()!);
      const t = r.current;
      if (t && r.arrived) {
        if (t.workedFor === 0) this.arrive(r, t);
        t.workedFor += dt;
        // Results can land before the walk ends; linger long enough to be seen.
        if (t.done && t.workedFor > 0.7 / (1 + r.queue.length * 0.5)) this.finish(r, t);
      }
      if (!r.current && !r.queue.length && r.idle && r.station !== 'lounge' && !r.leaving) {
        r.goTo('lounge');
        r.setAction('your turn');
      }
      const lounging = r.idle && r.station === 'lounge' && r.arrived && !r.current && !r.queue.length && !r.leaving;
      if (!lounging) r.nextMuse = Math.max(r.nextMuse, performance.now() + 12000);
      else if (performance.now() > r.nextMuse && !r.bubbleUntil) {
        r.say(this.musing(), 'note', 9);
        r.nextMuse = performance.now() + 25000 + Math.random() * 20000;
      }
      r.update(dt, this.sparks);
      if (r.gone) {
        r.dispose();
        this.robots.delete(key);
      }
    }

    for (const f of this.flying) {
      f.t += dt;
      const hand = f.robot.pos.clone().add(new THREE.Vector3(Math.sin(f.robot.yaw) * 0.55, 1.15, Math.cos(f.robot.yaw) * 0.55));
      const holding = f.robot.current && f.robot.current.kind === 'read' && !f.robot.current.done;
      if (!holding && f.t > 1.4) f.back = true;
      const target = f.back ? f.from : hand;
      f.mesh.position.lerp(target, Math.min(1, dt * 6));
      f.mesh.rotation.y += dt * (f.back ? 0 : 1.5);
    }
    this.flying = this.flying.filter((f) => {
      if (f.back && f.mesh.position.distanceTo(f.from) < 0.05) {
        f.label.element.remove();
        f.label.removeFromParent();
        f.mesh.removeFromParent();
        return false;
      }
      return true;
    });

    this.city.frame(dt);

    // Cards fade after their result has been shown for a while.
    const nowMs = performance.now();
    for (const [k, c] of this.cards) {
      if (nowMs > c.until) {
        c.obj.element.remove();
        c.obj.removeFromParent();
        this.cards.delete(k);
      }
    }
    // The beacon stands over the file being worked on; it fades once nothing is.
    const bm = this.beacon.material as THREE.MeshBasicMaterial;
    const fileWork = [...this.robots.values()].some((r) => r.current?.file && !r.current.done);
    if (this.beaconAt && fileWork) {
      this.beacon.position.copy(this.beaconAt).add(new THREE.Vector3(0, 1.5, 0));
      bm.opacity = Math.min(0.8, bm.opacity + dt * 2);
    } else {
      bm.opacity = Math.max(0, bm.opacity - dt);
    }
    // The test rig's lamps, and shipments rolling out of the loading bay.
    if (this.rigLamps) {
      this.rig.t += dt;
      const blink = Math.sin(this.rig.t * 10) > 0;
      this.rigLamps.amber.color.set(this.rig.state === 'running' && blink ? '#ffcc33' : '#5a4a1a').multiplyScalar(this.rig.state === 'running' && blink ? 2.5 : 1);
      this.rigLamps.green.color.set(this.rig.state === 'ok' ? '#3dff7a' : '#1f5a2a').multiplyScalar(this.rig.state === 'ok' ? 2.5 : 1);
      this.rigLamps.red.color.set(this.rig.state === 'fail' && blink ? '#ff3030' : '#5a1f1f').multiplyScalar(this.rig.state === 'fail' && blink ? 2.5 : 1);
    }
    this.shipments = this.shipments.filter((sh) => {
      sh.t += dt;
      sh.mesh.position.z = 6.8 + Math.max(0, sh.t - 1.5) * 1.6;
      if (sh.t < 6) return true;
      sh.label.element.remove();
      sh.mesh.removeFromParent();
      return false;
    });
    const up = new THREE.Vector3(0, 1, 0);
    this.beams = this.beams.filter((b) => {
      b.life -= dt;
      if (b.life <= 0) {
        b.mesh.removeFromParent();
        return false;
      }
      const from = b.robot.pos.clone().add(new THREE.Vector3(0, 1.3 * b.robot.scale, 0));
      const dir = new THREE.Vector3().subVectors(b.to, from);
      const len = dir.length();
      b.mesh.position.copy(from).addScaledVector(dir, 0.5);
      b.mesh.scale.set(1, len, 1);
      b.mesh.quaternion.setFromUnitVectors(up, dir.normalize());
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(0.9, b.life);
      return true;
    });

    // stations wind down
    for (const k of Object.keys(this.busy) as (keyof typeof this.busy)[]) this.busy[k] = Math.max(0, this.busy[k] - dt * 0.4);
    const c = new THREE.Color();
    for (let i = 0; i < this.leds.count; i++) {
      const on = Math.random() < 0.06 + this.busy.terminal * 0.5;
      if (Math.random() < 0.15) this.leds.setColorAt(i, c.set(on ? (i % 7 ? '#3dff7a' : '#ffb347') : '#163a24').multiplyScalar(on ? 2.5 : 1));
    }
    if (this.leds.instanceColor) this.leds.instanceColor.needsUpdate = true;
    for (let i = 0; i < this.boardLights.count; i++) {
      if (Math.random() < 0.1) this.boardLights.setColorAt(i, c.set(Math.random() < this.busy.switchboard ? '#ff8a5f' : '#3a2416').multiplyScalar(this.busy.switchboard > 0.1 ? 3 : 1));
    }
    if (this.boardLights.instanceColor) this.boardLights.instanceColor.needsUpdate = true;
    this.drawer.position.z = Math.sin(now * 3) * 0.9 * Math.min(1, this.busy.cabinet * 2);
    this.drawer.visible = true;
    const lamp = this.scene.getObjectByName('cabinet-lamp') as THREE.PointLight | undefined;
    if (lamp) lamp.intensity = this.busy.cabinet * 4;
    const tube = this.telescope.getObjectByName('tube');
    if (tube) tube.rotation.z = Math.sin(now * 0.8) * 0.6 * this.busy.window;

    // The machinery hums along, and speeds up whenever any robot is at work.
    const working = [...this.robots.values()].some((r) => !r.idle);
    this.pace += ((working ? 1 : 0.25) - this.pace) * Math.min(1, dt);
    this.machineT += dt * this.pace;
    const mt = this.machineT;
    for (const b of this.conveyor) {
      b.position.x += dt * this.pace * 1.2;
      if (b.position.x > 8.6) b.position.x -= 12.6;
    }
    for (const a of this.arms) {
      a.turret.rotation.y = Math.sin(mt * 1.1 + a.phase) * 1.1;
      a.lower.rotation.z = -0.35 + Math.sin(mt * 1.7 + a.phase) * 0.3;
      a.upper.rotation.z = 0.9 + Math.sin(mt * 2.3 + a.phase) * 0.45;
    }
    if (this.crane) {
      this.crane.bridge.position.x = Math.sin(mt * 0.15) * (W / 2 - 3);
      this.crane.hoist.position.z = Math.sin(mt * 0.23) * (D / 2 - 2);
    }
    for (const f of this.fans) f.rotation.z += dt * (2 + this.pace * 6);
    const pm = this.portal.material as THREE.MeshBasicMaterial;
    pm.opacity = Math.max(0.12 + Math.sin(now * 2) * 0.04, pm.opacity - dt * 0.8);

    this.alarmT = Math.max(0, this.alarmT - dt);
    this.alarm.intensity = this.alarmT > 0 ? (Math.sin(now * 14) > 0 ? 18 : 2) : 0;

    // Asking for permission: the room dims and a spotlight finds the robot.
    const wantSat = this.waiting ? 0.35 : 1;
    this.uSat.value += (wantSat - this.uSat.value) * Math.min(1, dt * 3);
    this.key.intensity += ((this.waiting ? 0.6 : 2.4) - this.key.intensity) * Math.min(1, dt * 3);
    this.hemi.intensity += ((this.waiting ? 0.35 : 1.4) - this.hemi.intensity) * Math.min(1, dt * 3);
    this.spot.intensity += ((this.waiting ? 60 : 0) - this.spot.intensity) * Math.min(1, dt * 4);
    this.spot.position.copy(this.spot.target.position).add(new THREE.Vector3(0, 7, 0));
    for (const r of this.robots.values()) if (r.asking) this.spot.target.position.lerp(r.pos, dt * 4);

    this.sparks.step(dt);
    this.controls.update(dt);
    this.pipeline.render();
    this.labels.render(this.scene, this.camera);
    if ((this.labelTick = (this.labelTick + 1) % 10) === 0) {
      const r = this.canvas.getBoundingClientRect();
      this.city.cullLabels(this.camera, r.width, r.height);
    }
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = r.width;
    const h = r.height;
    this.renderer.setSize(w, h, false);
    this.labels.setSize(w, h);
    this.camera.aspect = w / Math.max(1, h);
    // Centre the room in the part of the canvas the side panel does not cover.
    const panel = document.querySelector('.panel') as HTMLElement | null;
    const side = panel && getComputedStyle(panel).top === '0px';
    if (side) this.camera.setViewOffset(w, h, panel.offsetWidth / 2, 0, w, h);
    else if (panel) this.camera.setViewOffset(w, h, 0, panel.offsetHeight / 2, w, h);
    else this.camera.clearViewOffset();
    // A tall phone screen needs the camera further back to fit the room across its width.
    const narrow = w / Math.max(1, h) < 1;
    this.camera.fov = narrow ? 52 : 30;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- picking books

  private ray = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  private bookAt(e: MouseEvent): string | null {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.pointer, this.camera);
    return this.city.pick(this.ray);
  }

  private hoverQueued = false;
  private onHover(e: PointerEvent) {
    if (this.hoverQueued) return;
    this.hoverQueued = true;
    requestAnimationFrame(() => {
      this.hoverQueued = false;
      this.hooks.hover(this.bookAt(e), e.clientX, e.clientY);
    });
  }

  private onClick(e: MouseEvent) {
    const p = this.bookAt(e);
    if (p) this.hooks.pick(p);
  }
}
