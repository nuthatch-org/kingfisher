import * as THREE from 'three/webgpu';
import { pass, uniform, vec3, vec4, mix, dot } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Sparks } from './fx';
import { City } from './city';
import { KIND_COLOR, KIND_GLYPH } from './palette';
import type { ToolKind } from './types';

/*
 * The workshop: one hover robot per agent in a small diorama, walking to the station that matches
 * what it is doing. Everything is procedural geometry and canvas textures, so there are no assets.
 */

type StationId = 'shelf' | 'desk' | 'terminal' | 'cabinet' | 'window' | 'switchboard' | 'lounge' | 'door' | 'floor';

interface Station {
  stand: THREE.Vector3;
  look: THREE.Vector3;
}

const STATIONS: Record<StationId, Station> = {
  shelf: { stand: new THREE.Vector3(-4, 0, -4.4), look: new THREE.Vector3(-4, 1, -6) },
  desk: { stand: new THREE.Vector3(2.2, 0, -2.4), look: new THREE.Vector3(2.2, 1, -4) },
  terminal: { stand: new THREE.Vector3(5.6, 0, -3.3), look: new THREE.Vector3(7, 1, -4.8) },
  cabinet: { stand: new THREE.Vector3(-6.2, 0, 0.4), look: new THREE.Vector3(-8, 1, 0.4) },
  window: { stand: new THREE.Vector3(-6, 0, 3.6), look: new THREE.Vector3(-8, 1.6, 3.6) },
  switchboard: { stand: new THREE.Vector3(5.6, 0, 2), look: new THREE.Vector3(8, 1, 2) },
  lounge: { stand: new THREE.Vector3(-1.4, 0, 3.4), look: new THREE.Vector3(1, 0, 1) },
  door: { stand: new THREE.Vector3(4.6, 0, 4.6), look: new THREE.Vector3(4.6, 1, 0) },
  floor: { stand: new THREE.Vector3(0.8, 0, 2.3), look: new THREE.Vector3(0, 1, 0) },
};

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
const TABLE = { x: -0.6, z: -0.3, w: 5.2, d: 3.4, h: 0.8 };
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

  private deskScreen = new Screen(1.5, 0.9);
  private termScreen = new Screen(1.6, 1.1);
  private leds!: THREE.InstancedMesh;
  private telescope = new THREE.Group();
  private drawer!: THREE.Mesh;
  private boardLights!: THREE.InstancedMesh;
  private portal!: THREE.Mesh;
  private alarm = new THREE.PointLight('#ff2a2a', 0, 9, 1.6);
  private spot = new THREE.SpotLight('#fff1c9', 0, 14, 0.32, 0.5, 1.2);
  private key!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private alarmT = 0;
  private busy = { desk: 0, terminal: 0, switchboard: 0, cabinet: 0, window: 0 };
  private waiting = false;
  private small = false;
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
    this.camera.position.set(16.5, 15, 19);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(-0.3, 0.6, -0.6);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 48;

    const bg = new THREE.Color('#0b0d14');
    this.scene.background = bg;
    this.scene.fog = new THREE.Fog(bg, 30, 70);

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

  private buildRoom() {
    const s = this.scene;
    this.hemi = new THREE.HemisphereLight('#b4c8ff', '#4a3a30', 1.4);
    s.add(this.hemi);
    this.key = new THREE.DirectionalLight('#ffe3c2', 2.4);
    this.key.position.set(8, 14, 6);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(this.small ? 1024 : 2048, this.small ? 1024 : 2048);
    Object.assign(this.key.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 40 });
    this.key.shadow.bias = -0.0005;
    s.add(this.key);
    this.alarm.position.set(7, 3.4, -4.6);
    s.add(this.alarm);
    s.add(this.spot, this.spot.target);

    // floor: a tile grid painted once
    const fc = document.createElement('canvas');
    fc.width = fc.height = 1024;
    const g = fc.getContext('2d')!;
    g.fillStyle = '#231f2b';
    g.fillRect(0, 0, 1024, 1024);
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < 12; j++) {
        g.fillStyle = (i + j) % 2 ? '#262230' : '#2a2534';
        g.fillRect(i * 64, j * (1024 / 12), 64, 1024 / 12);
      }
    }
    g.strokeStyle = 'rgba(120,170,255,0.10)';
    g.lineWidth = 2;
    for (let i = 0; i <= 16; i++) {
      g.beginPath();
      g.moveTo(i * 64, 0);
      g.lineTo(i * 64, 1024);
      g.stroke();
    }
    for (let j = 0; j <= 12; j++) {
      g.beginPath();
      g.moveTo(0, j * (1024 / 12));
      g.lineTo(1024, j * (1024 / 12));
      g.stroke();
    }
    const ft = new THREE.CanvasTexture(fc);
    ft.colorSpace = THREE.SRGBColorSpace;
    const floor = new THREE.Mesh(new THREE.BoxGeometry(16, 0.4, 12), [
      this.mat('#17141d'),
      this.mat('#17141d'),
      new THREE.MeshStandardMaterial({ map: ft, roughness: 0.85 }),
      this.mat('#17141d'),
      this.mat('#17141d'),
      this.mat('#17141d'),
    ]);
    floor.position.y = -0.2;
    floor.receiveShadow = true;
    s.add(floor);
    // the platform floats; its rim glows
    const rim = new THREE.Mesh(new THREE.BoxGeometry(16.1, 0.05, 12.1), new THREE.MeshBasicMaterial({ color: '#4fb8ff' }));
    rim.position.y = -0.42;
    s.add(rim);

    const wall = this.mat('#3a4258', 0.9);
    this.box(16, 4.2, 0.3, wall, 0, 2.1, -6.15);
    this.box(0.3, 4.2, 12, wall, -8.15, 2.1, 0);
    const trim = new THREE.MeshBasicMaterial({ color: '#ffb347' });
    this.box(16, 0.06, 0.06, trim, 0, 4.2, -6);
    this.box(0.06, 0.06, 12, trim, -8, 4.2, 0);

    this.city.group.position.set(TABLE.x, 0, TABLE.z);
    this.scene.add(this.city.group);
    const holo = new THREE.PointLight('#4fb8ff', 3, 6, 1.6);
    holo.position.set(TABLE.x, TABLE.h + 1.6, TABLE.z);
    this.scene.add(holo);
    this.buildShelf();
    this.buildDesk();
    this.buildTerminal();
    this.buildCabinet();
    this.buildWindow();
    this.buildSwitchboard();
    this.buildLounge();
    this.buildPortal();

    // dust in the light
    for (let i = 0; i < 40; i++) {
      this.sparks.emit(new THREE.Vector3((Math.random() - 0.5) * 14, Math.random() * 3.5, (Math.random() - 0.5) * 10), new THREE.Vector3(), new THREE.Color('#ffe6b0'), 0.01, 0.01);
    }
  }

  private buildShelf() {
    const wood = this.mat('#5a3d2b', 0.8);
    const shelf = new THREE.Group();
    shelf.position.set(-4, 0, -5.75);
    this.scene.add(shelf);
    this.box(6.2, 3.6, 0.5, this.mat('#3b281d', 0.85), 0, 1.8, -0.05, shelf);
    for (let r = 0; r < 5; r++) this.box(6.2, 0.06, 0.55, wood, 0, 0.3 + r * 0.72, 0.05, shelf);
    // Scenery now: the project lives on the blueprint table.
    const n = 230;
    const books = new THREE.InstancedMesh(new THREE.BoxGeometry(0.11, 1, 0.38), new THREE.MeshStandardMaterial({ roughness: 0.6 }), n);
    const m = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const p = this.bookSlot(i);
      const h = 0.4 + Math.random() * 0.24;
      m.compose(new THREE.Vector3(p.x, p.y + h / 2, p.z), new THREE.Quaternion(), new THREE.Vector3(1, h, 1));
      books.setMatrixAt(i, m);
      books.setColorAt(i, new THREE.Color().setHSL(Math.random(), 0.45, 0.32 + Math.random() * 0.15));
    }
    books.castShadow = true;
    books.position.copy(shelf.position);
    this.scene.add(books);
  }

  private bookSlot(i: number): THREE.Vector3 {
    const perRow = 46;
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    return new THREE.Vector3(-2.75 + col * 0.12, 0.33 + row * 0.72, 0.12);
  }

  private buildDesk() {
    const wood = this.mat('#6b4a33', 0.6);
    const g = new THREE.Group();
    g.position.set(2.2, 0, -3.8);
    this.scene.add(g);
    this.box(2.6, 0.08, 1.2, wood, 0, 0.9, 0, g);
    for (const [x, z] of [
      [-1.2, -0.5],
      [1.2, -0.5],
      [-1.2, 0.5],
      [1.2, 0.5],
    ])
      this.box(0.08, 0.9, 0.08, wood, x, 0.45, z, g);
    this.box(1.7, 1.05, 0.08, this.mat('#15171f', 0.4, 0.3), 0, 1.65, -0.35, g);
    this.box(0.1, 0.35, 0.1, this.mat('#15171f'), 0, 1.05, -0.35, g);
    this.deskScreen.mesh.position.set(0, 1.65, -0.3);
    g.add(this.deskScreen.mesh);
    this.box(0.9, 0.04, 0.3, this.mat('#2a2d38', 0.5), 0, 0.96, 0.2, g);
    const glow = new THREE.PointLight('#5fc8ff', 3, 4, 1.8);
    glow.position.set(0, 1.6, 0.4);
    g.add(glow);
    this.deskScreen.idle('editor · idle');
  }

  private buildTerminal() {
    const g = new THREE.Group();
    g.position.set(7, 0, -4.8);
    g.rotation.y = -Math.PI / 4;
    this.scene.add(g);
    this.box(1.3, 3.2, 1, this.mat('#1b1e28', 0.45, 0.5), 0, 1.6, 0, g);
    this.termScreen.mesh.position.set(0, 2.2, 0.51);
    g.add(this.termScreen.mesh);
    const leds = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 0.03, 0.02), new THREE.MeshBasicMaterial(), 48);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 48; i++) {
      m.setPosition(-0.5 + (i % 12) * 0.09, 0.4 + Math.floor(i / 12) * 0.22, 0.51);
      leds.setMatrixAt(i, m);
      leds.setColorAt(i, new THREE.Color('#1f6b3a'));
    }
    g.add(leds);
    this.leds = leds;
    const glow = new THREE.PointLight('#ff5fa2', 2.5, 5, 1.8);
    glow.position.set(0, 2.2, 1);
    g.add(glow);
    this.termScreen.lines('zsh', [{ text: '$ _', color: '#9dff8a' }]);
  }

  private buildCabinet() {
    const g = new THREE.Group();
    g.position.set(-7.55, 0, 0.4);
    g.rotation.y = Math.PI / 2;
    this.scene.add(g);
    const wood = this.mat('#7a5a3c', 0.65);
    this.box(1.6, 1.5, 0.8, wood, 0, 0.75, 0, g);
    const brass = this.mat('#d6a85a', 0.3, 0.8);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const d = this.box(0.44, 0.38, 0.04, this.mat('#8d6a48', 0.6), -0.5 + c * 0.5, 0.3 + r * 0.45, 0.42, g);
        this.box(0.1, 0.03, 0.03, brass, 0, 0, 0.03, d);
        if (r === 1 && c === 1) this.drawer = d;
      }
    }
    const lamp = new THREE.PointLight('#ffcf7a', 0, 3, 1.6);
    lamp.position.set(0, 1.8, 0.6);
    lamp.name = 'cabinet-lamp';
    g.add(lamp);
  }

  private buildWindow() {
    const wc = document.createElement('canvas');
    wc.width = 256;
    wc.height = 192;
    const c = wc.getContext('2d')!;
    const grad = c.createLinearGradient(0, 0, 0, 192);
    grad.addColorStop(0, '#0a1030');
    grad.addColorStop(1, '#3a2a6a');
    c.fillStyle = grad;
    c.fillRect(0, 0, 256, 192);
    for (let i = 0; i < 70; i++) {
      c.fillStyle = `rgba(255,255,255,${0.3 + Math.random() * 0.7})`;
      c.fillRect(Math.random() * 256, Math.random() * 150, 1.5, 1.5);
    }
    c.fillStyle = '#ffe9b8';
    c.beginPath();
    c.arc(190, 50, 16, 0, Math.PI * 2);
    c.fill();
    const t = new THREE.CanvasTexture(wc);
    t.colorSpace = THREE.SRGBColorSpace;
    const win = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.8), new THREE.MeshBasicMaterial({ map: t }));
    win.position.set(-7.98, 2.3, 3.6);
    win.rotation.y = Math.PI / 2;
    this.scene.add(win);
    const frame = this.mat('#4a3424', 0.7);
    this.box(0.12, 0.1, 2.6, frame, -7.95, 3.25, 3.6);
    this.box(0.12, 0.1, 2.6, frame, -7.95, 1.35, 3.6);
    this.box(0.12, 1.95, 0.1, frame, -7.95, 2.3, 2.3);
    this.box(0.12, 1.95, 0.1, frame, -7.95, 2.3, 4.9);
    const moon = new THREE.PointLight('#a9b8ff', 2, 6, 1.5);
    moon.position.set(-7, 2.4, 3.6);
    this.scene.add(moon);

    const brass = this.mat('#d6a85a', 0.25, 0.85);
    this.telescope.position.set(-7, 0, 3.6);
    for (let i = 0; i < 3; i++) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.3), this.mat('#3a2a20'));
      const a = (i / 3) * Math.PI * 2;
      leg.position.set(Math.cos(a) * 0.25, 0.6, Math.sin(a) * 0.25);
      leg.rotation.set(Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35);
      this.telescope.add(leg);
    }
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 1.2, 20), brass);
    tube.rotation.z = Math.PI / 2 - 0.5;
    tube.position.set(-0.1, 1.35, 0);
    tube.castShadow = true;
    tube.name = 'tube';
    this.telescope.add(tube);
    this.scene.add(this.telescope);
  }

  private buildSwitchboard() {
    const g = new THREE.Group();
    g.position.set(7.4, 0, 2);
    g.rotation.y = -Math.PI / 2;
    this.scene.add(g);
    this.box(2, 1.9, 0.4, this.mat('#4a3426', 0.7), 0, 0.95, 0, g);
    const lights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.045, 10, 8), new THREE.MeshBasicMaterial(), 24);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 24; i++) {
      m.setPosition(-0.75 + (i % 8) * 0.21, 1.1 + Math.floor(i / 8) * 0.24, 0.22);
      lights.setMatrixAt(i, m);
      lights.setColorAt(i, new THREE.Color('#442a1a'));
    }
    g.add(lights);
    this.boardLights = lights;
  }

  private buildLounge() {
    const rug = new THREE.Mesh(new THREE.CircleGeometry(1.9, 48), this.mat('#5b2f4a', 0.95));
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(-1.4, 0.01, 3.6);
    rug.receiveShadow = true;
    this.scene.add(rug);
    const sofa = this.mat('#3f6f7a', 0.9);
    this.box(3, 0.45, 0.9, sofa, -1.4, 0.3, 4.6);
    this.box(3, 0.8, 0.25, sofa, -1.4, 0.75, 5.0);
    this.box(0.25, 0.65, 0.9, sofa, -2.9, 0.45, 4.6);
    this.box(0.25, 0.65, 0.9, sofa, 0.1, 0.45, 4.6);
    this.box(0.04, 1.8, 0.04, this.mat('#222'), 1.0, 0.9, 5.2);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.4, 20, 1, true), new THREE.MeshStandardMaterial({ color: '#ffd9a0', emissive: '#ffb050', emissiveIntensity: 1.2, side: THREE.DoubleSide }));
    shade.position.set(1.0, 1.85, 5.2);
    this.scene.add(shade);
    const lamp = new THREE.PointLight('#ffb764', 4, 6, 1.6);
    lamp.position.set(1, 1.7, 5.0);
    this.scene.add(lamp);
    const plant = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45, 1), this.mat('#3f8f4f', 0.8));
    plant.position.set(-3.6, 0.9, 5.2);
    this.scene.add(plant);
    this.box(0.5, 0.5, 0.5, this.mat('#b0643a', 0.8), -3.6, 0.25, 5.2);
  }

  private buildPortal() {
    const frame = this.mat('#20232e', 0.4, 0.6);
    const g = new THREE.Group();
    g.position.set(4.6, 0, 5.85);
    this.scene.add(g);
    this.box(0.18, 2.6, 0.2, frame, -0.75, 1.3, 0, g);
    this.box(0.18, 2.6, 0.2, frame, 0.75, 1.3, 0, g);
    this.box(1.7, 0.18, 0.2, frame, 0, 2.6, 0, g);
    this.portal = new THREE.Mesh(
      new THREE.PlaneGeometry(1.32, 2.5),
      new THREE.MeshBasicMaterial({ color: '#c6ff6e', transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.portal.position.set(0, 1.3, 0);
    g.add(this.portal);
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
      station: KIND_STATION[info.kind],
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

  sessionEnded(session: string | null) {
    const r = this.robots.get(session ?? 'main');
    if (!r) return;
    r.goTo('lounge');
    r.idle = true;
    r.setAction('session ended');
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
    this.city.resetActivity();
    this.waiting = false;
    this.placeholder();
    this.deskScreen.idle('editor · idle');
    this.termScreen.lines('zsh', [{ text: '$ _', color: '#9dff8a' }]);
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
        if (t.file) this.flyBook(Math.floor(Math.random() * 230), r, t.file);
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
    this.sparks.burst(r.pos.clone().setY(1.1), color, 14, 2.5, 0.8, 0.22);
  }

  private finish(r: Robot, t: Task) {
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
      this.sparks.burst(new THREE.Vector3(2.2, 1.1, -3.4), new THREE.Color(KIND_COLOR[t.kind]), 40, 4, 1.1, 0.3);
    }
    if (t.ok) r.mood = 'happy';
    setTimeout(() => {
      if (r.mood === 'happy') r.mood = 'normal';
    }, 900);
    r.current = null;
  }

  private flyBook(i: number, r: Robot, file: string) {
    const from = this.bookSlot(i).add(new THREE.Vector3(-4, 0.3, -5.75));
    const tint = new THREE.Color().setHSL(Math.random(), 0.6, 0.55);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.42, 0.1), new THREE.MeshStandardMaterial({ color: tint, emissive: tint, emissiveIntensity: 1.5 }));
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
    this.sparks.burst(new THREE.Vector3(4.6, 1.3, 5.6), new THREE.Color(KIND_COLOR.agent), 60, 3.5, 1.2, 0.3);
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
        r.say(MUSINGS[Math.floor(Math.random() * MUSINGS.length)], 'note', 8);
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
    for (let i = 0; i < 48; i++) {
      const on = Math.random() < 0.04 + this.busy.terminal * 0.5;
      if (Math.random() < 0.15) this.leds.setColorAt(i, c.set(on ? (i % 7 ? '#3dff7a' : '#ffb347') : '#163a24').multiplyScalar(on ? 2.5 : 1));
    }
    if (this.leds.instanceColor) this.leds.instanceColor.needsUpdate = true;
    for (let i = 0; i < 24; i++) {
      if (Math.random() < 0.1) this.boardLights.setColorAt(i, c.set(Math.random() < this.busy.switchboard ? '#ff8a5f' : '#3a2416').multiplyScalar(this.busy.switchboard > 0.1 ? 3 : 1));
    }
    if (this.boardLights.instanceColor) this.boardLights.instanceColor.needsUpdate = true;
    this.drawer.position.z = 0.42 + this.busy.cabinet * 0.35;
    const lamp = this.scene.getObjectByName('cabinet-lamp') as THREE.PointLight | undefined;
    if (lamp) lamp.intensity = this.busy.cabinet * 4;
    const tube = this.telescope.getObjectByName('tube');
    if (tube) tube.rotation.y = Math.sin(now * 0.8) * 0.5 * this.busy.window;
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
