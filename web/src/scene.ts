import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec3,
  vec4,
  uv,
  time,
  uniform,
  length,
  smoothstep,
  mix,
  dot,
  sin,
  cos,
  pass,
  positionLocal,
  instancedDynamicBufferAttribute,
  instancedBufferAttribute,
  mx_fractal_noise_float,
  normalWorld,
  cameraPosition,
  positionWorld,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { KIND_COLOR } from './palette';
import type { ToolKind } from './types';

const TAU = Math.PI * 2;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

/** Soft round sprite: opaque core falling off to the rim. */
// @types/three types these as Node<string>, which loses swizzles; the runtime type is the one passed.
const dynAttr = (a: THREE.InstancedBufferAttribute, type: string): any => instancedDynamicBufferAttribute(a, type);
const attr = (a: THREE.InstancedBufferAttribute, type: string): any => instancedBufferAttribute(a, type);

const softDisc = Fn(() => {
  const d = length(uv().sub(0.5)).mul(2);
  return smoothstep(1, 0, d).pow(1.6);
});

/**
 * A bag of instanced, additive, CPU-driven sprites. Everything that moves in the scene is one of
 * these, so the whole sky is a handful of draw calls however busy the agent gets.
 */
class SpriteLayer {
  readonly pos: Float32Array;
  readonly col: Float32Array;
  readonly size: Float32Array;
  readonly sprite: THREE.Sprite;
  private readonly posAttr: THREE.InstancedBufferAttribute;
  private readonly colAttr: THREE.InstancedBufferAttribute;
  private readonly sizeAttr: THREE.InstancedBufferAttribute;

  constructor(readonly capacity: number, scale = 4) {
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 4);
    this.size = new Float32Array(capacity);
    this.posAttr = new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.InstancedBufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.InstancedBufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);

    const material = new THREE.PointsNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    const c = dynAttr(this.colAttr, 'vec4');
    material.positionNode = dynAttr(this.posAttr, 'vec3');
    material.sizeNode = dynAttr(this.sizeAttr, 'float').mul(scale);
    material.colorNode = vec4(c.xyz, 1);
    material.opacityNode = softDisc().mul(c.w);

    this.sprite = new THREE.Sprite(material);
    this.sprite.count = 0;
    this.sprite.frustumCulled = false;
  }

  set count(n: number) {
    this.sprite.count = Math.max(0, Math.min(n, this.capacity));
  }
  get count() {
    return this.sprite.count;
  }

  flush() {
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
  }
}

interface FileNode {
  path: string;
  group: number;
  heat: number;
  edited: number;
  base: THREE.Color;
  touches: number;
}

interface Group {
  name: string;
  center: THREE.Vector3;
  members: number;
  hue: number;
}

interface Comet {
  from: THREE.Vector3;
  ctrl: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  dur: number;
  color: THREE.Color;
  kind: ToolKind;
  onArrive?: () => void;
}

interface Moon {
  id: string;
  phase: number;
  radius: number;
  tilt: number;
  speed: number;
  pos: THREE.Vector3;
  fade: number;
  dying: boolean;
}

/** Particle pool slots: position, velocity, colour, life. */
class Sparks {
  readonly layer: SpriteLayer;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private baseSize: Float32Array;
  private drag: Float32Array;
  private next = 0;

  constructor(capacity: number) {
    this.layer = new SpriteLayer(capacity);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.layer.count = capacity;
  }

  emit(p: THREE.Vector3, v: THREE.Vector3, color: THREE.Color, life: number, size: number, drag = 1.6) {
    const i = this.next;
    this.next = (this.next + 1) % this.layer.capacity;
    this.layer.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.layer.col.set([color.r, color.g, color.b, 1], i * 4);
    this.life[i] = life;
    this.maxLife[i] = life;
    this.baseSize[i] = size;
    this.drag[i] = drag;
  }

  burst(p: THREE.Vector3, color: THREE.Color, n: number, speed: number, life = 1.1, size = 0.35) {
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.randomDirection().multiplyScalar(speed * (0.4 + Math.random() * 0.8));
      this.emit(p, v, color, life * (0.6 + Math.random() * 0.6), size);
    }
  }

  ring(p: THREE.Vector3, color: THREE.Color, n: number, speed: number) {
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      v.set(Math.cos(a), (Math.random() - 0.5) * 0.08, Math.sin(a)).multiplyScalar(speed);
      this.emit(p, v, color, 1.4, 0.5, 0.9);
    }
  }

  step(dt: number) {
    const { pos, col, size } = this.layer;
    for (let i = 0; i < this.layer.capacity; i++) {
      if (this.life[i] <= 0) {
        size[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      const damp = Math.exp(-this.drag[i] * dt);
      for (let a = 0; a < 3; a++) {
        this.vel[i * 3 + a] *= damp;
        pos[i * 3 + a] += this.vel[i * 3 + a] * dt;
      }
      col[i * 4 + 3] = k * k;
      size[i] = this.baseSize[i] * (0.4 + 0.6 * k);
    }
    this.layer.flush();
  }
}

export interface SceneHooks {
  hover(path: string | null, x: number, y: number): void;
  pick(path: string): void;
}

export class Observatory {
  readonly renderer: THREE.WebGPURenderer;
  private scene = new THREE.Scene();
  private world = new THREE.Group();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private pipeline!: THREE.RenderPipeline;
  private timer = new THREE.Timer();

  private root = '';
  private files: FileNode[] = [];
  private byPath = new Map<string, number>();
  private groups: Group[] = [];
  private groupByName = new Map<string, number>();
  private nodes = new SpriteLayer(24_000);
  private halos = new SpriteLayer(24_000, 14);
  private sparks = new Sparks(6000);
  private stations = new SpriteLayer(32);
  private moonLayer = new SpriteLayer(64);
  private comets: Comet[] = [];
  private moons = new Map<string, Moon>();

  private readonly core: THREE.Mesh;
  private readonly uThink = uniform(0);
  private readonly uSpeak = uniform(0);
  private readonly uSat = uniform(1);
  private readonly uPulse = uniform(0);
  private think = 0;
  private speak = 0;
  private waiting = false;
  private timeScale = 1;
  private shake = 0;
  private rimFlash = new THREE.Color(0, 0, 0);

  readonly shell = new THREE.Vector3(-17, 2.5, 6);
  readonly cloud = new THREE.Vector3(0, 17, -4);
  readonly mcpStation = new THREE.Vector3(17, -1, 7);

  constructor(private canvas: HTMLCanvasElement, private hooks: SceneHooks) {
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
    this.camera.position.set(0, 24, 44);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.18;
    this.controls.maxDistance = 220;
    this.controls.minDistance = 6;

    this.scene.background = new THREE.Color('#03040a');
    this.scene.add(this.world);
    this.world.add(this.starfield(), this.nebula());
    this.core = this.makeCore();
    this.world.add(this.core);
    for (const l of [this.halos, this.nodes, this.stations, this.moonLayer, this.sparks.layer]) this.world.add(l.sprite);
    this.layoutStations();

    canvas.addEventListener('pointermove', (e) => this.onHover(e));
    canvas.addEventListener('click', (e) => this.onClick(e));
    window.addEventListener('resize', () => this.resize());
  }

  async start() {
    await this.renderer.init();
    const scenePass = pass(this.scene, this.camera);
    const color = scenePass.getTextureNode('output');
    const glow = bloom(color, 0.9, 0.5, 0.2);
    const lit = color.add(glow);
    const lum = dot(lit.rgb, vec3(0.2126, 0.7152, 0.0722));
    this.pipeline = new THREE.RenderPipeline(this.renderer);
    this.pipeline.outputNode = vec4(mix(vec3(lum), lit.rgb, this.uSat), 1);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  get backend(): string {
    return (this.renderer.backend as any).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  }

  // ---------------------------------------------------------------- construction

  private starfield(): THREE.Sprite {
    const n = 7000;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 4);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.randomDirection().multiplyScalar(300 + Math.random() * 500);
      pos.set([v.x, v.y, v.z], i * 3);
      const warm = Math.random();
      col.set([0.7 + warm * 0.3, 0.75 + warm * 0.15, 1 - warm * 0.3, 0.25 + Math.random() * 0.55], i * 4);
    }
    const m = new THREE.PointsNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const c = attr(new THREE.InstancedBufferAttribute(col, 4), 'vec4');
    m.positionNode = attr(new THREE.InstancedBufferAttribute(pos, 3), 'vec3');
    m.sizeNode = float(2.2);
    m.colorNode = vec4(c.xyz, 1);
    m.opacityNode = softDisc().mul(c.w).mul(sin(time.mul(0.7).add(c.x.mul(40))).mul(0.25).add(0.75));
    const s = new THREE.Sprite(m);
    s.count = n;
    s.frustumCulled = false;
    return s;
  }

  /** The thinking field: a slow vortex round the core that thickens and brightens with thought. */
  private nebula(): THREE.Sprite {
    const n = 26_000;
    const seed = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const r = 2.2 + Math.pow(Math.random(), 1.7) * 9;
      seed.set([r, Math.random() * TAU, (Math.random() - 0.5) * (0.6 + r * 0.22), Math.random()], i * 4);
    }
    const s4 = attr(new THREE.InstancedBufferAttribute(seed, 4), 'vec4');
    const r = s4.x;
    const think = this.uThink;
    const angle = float(s4.y.add(time.mul(float(0.9).div(r)).mul(think.mul(2.2).add(0.35))));
    const wobble = mx_fractal_noise_float(vec3(r.mul(0.4), s4.y, time.mul(0.15)), 3).mul(0.9);
    const rr = float(r.add(wobble).mul(think.mul(-0.12).add(1)));
    const p = vec3(cos(angle).mul(rr), s4.z.add(sin(angle.mul(3).add(time)).mul(0.15)), sin(angle).mul(rr));

    const m = new THREE.PointsNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    m.positionNode = p;
    m.sizeNode = float(0.55).add(think.mul(0.5)).mul(s4.w.mul(0.8).add(0.4));
    const inner = vec3(0.45, 0.85, 1.0);
    const outer = vec3(0.55, 0.25, 0.95);
    const hot = vec3(1.0, 0.55, 0.3);
    const tone = mix(inner, outer, smoothstep(2, 10, r));
    m.colorNode = vec4(mix(tone, hot, think.mul(s4.w).mul(0.55)), 1);
    m.opacityNode = softDisc().mul(think.mul(0.22).add(0.012)).mul(smoothstep(11.5, 6, r));
    const s = new THREE.Sprite(m);
    s.count = n;
    s.frustumCulled = false;
    return s;
  }

  private makeCore(): THREE.Mesh {
    const m = new THREE.MeshBasicNodeMaterial();
    const n = mx_fractal_noise_float(positionLocal.mul(2.2).add(time.mul(0.35)), 4);
    const fres = float(1).sub(dot(normalWorld, cameraPosition.sub(positionWorld).normalize()).abs()).pow(2.2);
    const base = mix(vec3(0.35, 0.8, 1.0), vec3(1.0, 0.78, 0.45), n.mul(0.5).add(0.5));
    const energy = float(0.55).add(this.uSpeak.mul(1.6)).add(this.uThink.mul(0.8)).add(this.uPulse.mul(3));
    m.colorNode = base.mul(energy).add(fres.mul(vec3(0.6, 0.9, 1.4)).mul(energy));
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(1.15, 5), m);
    core.add(this.coreHalo());
    return core;
  }

  private coreHalo(): THREE.Sprite {
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const d = length(uv().sub(0.5)).mul(2);
    m.colorNode = vec4(0.5, 0.8, 1.0, 1);
    m.opacityNode = smoothstep(1, 0, d).pow(3).mul(this.uSpeak.mul(0.3).add(this.uThink.mul(0.15)).add(0.1));
    const s = new THREE.Sprite(m);
    s.scale.setScalar(9);
    return s;
  }

  private layoutStations() {
    const put = (i: number, p: THREE.Vector3, c: string, size: number) => {
      const col = new THREE.Color(c);
      this.stations.pos.set([p.x, p.y, p.z], i * 3);
      this.stations.col.set([col.r, col.g, col.b, 0.9], i * 4);
      this.stations.size[i] = size;
    };
    put(0, this.shell, KIND_COLOR.shell, 0.75);
    put(1, this.cloud, KIND_COLOR.web, 0.75);
    put(2, this.mcpStation, KIND_COLOR.mcp, 0.6);
    this.stations.count = 3;
    this.stations.flush();
  }

  // ---------------------------------------------------------------- the codebase

  setFiles(root: string, files: string[]) {
    this.root = root.replace(/\/$/, '');
    this.files = [];
    this.byPath.clear();
    this.groups = [];
    this.groupByName.clear();
    const sorted = [...files].sort();
    for (const f of sorted) this.addFile(f, false);
    this.writeNodes();
  }

  private groupFor(rel: string): number {
    const parts = rel.split('/');
    const name = parts.length > 1 ? parts[0] : '.';
    let g = this.groupByName.get(name);
    if (g === undefined) {
      g = this.groups.length;
      const a = g * GOLDEN + 0.6;
      const r = name === '.' ? 6.5 : 13 + 5.2 * Math.sqrt(g);
      const y = (hash(name) - 0.5) * 7;
      this.groups.push({ name, center: new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r), members: 0, hue: hash(name + '#') });
      this.groupByName.set(name, g);
    }
    return g;
  }

  private addFile(rel: string, write = true): number {
    const existing = this.byPath.get(rel);
    if (existing !== undefined) return existing;
    if (this.files.length >= this.nodes.capacity) return -1;
    const g = this.groupFor(rel);
    const group = this.groups[g];
    const k = group.members++;
    const i = this.files.length;
    const base = new THREE.Color().setHSL(0.52 + group.hue * 0.35, 0.45, 0.42);
    this.files.push({ path: rel, group: g, heat: 0, edited: 0, base, touches: 0 });
    this.byPath.set(rel, i);

    // A galaxy per top-level directory: a phyllotaxis disc, tilted by its own hash, that grows with use.
    const spread = 0.62;
    const rr = spread * Math.sqrt(k + 0.5);
    const a = k * GOLDEN;
    const h = hash(rel);
    const tilt = (group.hue - 0.5) * 1.1;
    const local = new THREE.Vector3(Math.cos(a) * rr, (h - 0.5) * (0.6 + rr * 0.15), Math.sin(a) * rr);
    local.applyAxisAngle(new THREE.Vector3(1, 0, 0), tilt);
    const p = group.center.clone().add(local);
    this.nodes.pos.set([p.x, p.y, p.z], i * 3);
    this.halos.pos.set([p.x, p.y, p.z], i * 3);
    this.nodes.count = this.files.length;
    this.halos.count = this.files.length;
    if (write) this.writeNodes();
    return i;
  }

  /** Agent paths are absolute; the map is keyed by repo-relative path. */
  private rel(path: string): string | null {
    if (!path) return null;
    if (this.root && path.startsWith(this.root + '/')) return path.slice(this.root.length + 1);
    if (!path.startsWith('/')) return path.replace(/^\.\//, '');
    return null;
  }

  private nodePos(i: number): THREE.Vector3 {
    return new THREE.Vector3().fromArray(this.nodes.pos, i * 3);
  }

  private writeNodes() {
    const hot = new THREE.Color('#ffe3b0');
    const amber = new THREE.Color(KIND_COLOR.edit);
    const c = new THREE.Color();
    for (let i = 0; i < this.files.length; i++) {
      const f = this.files[i];
      const heat = Math.min(f.heat, 3);
      c.copy(f.base).lerp(amber, Math.min(f.edited, 1) * 0.8).lerp(hot, Math.min(heat / 2, 1) * 0.75);
      this.nodes.col.set([c.r, c.g, c.b, 0.55 + Math.min(heat, 1) * 0.45], i * 4);
      this.nodes.size[i] = 0.32 + heat * 0.32 + Math.min(f.edited, 1) * 0.18 + Math.min(f.touches, 12) * 0.012;
      this.halos.col.set([c.r, c.g, c.b, Math.min(heat, 1.6) * 0.16 + Math.min(f.edited, 1) * 0.05], i * 4);
      this.halos.size[i] = this.nodes.size[i];
    }
    this.nodes.flush();
    this.halos.flush();
  }

  // ---------------------------------------------------------------- events in

  private originFor(parent: string | null): THREE.Vector3 {
    const moon = parent ? this.moons.get(parent) : undefined;
    return moon ? moon.pos.clone() : new THREE.Vector3(0, 0, 0);
  }

  private launch(from: THREE.Vector3, to: THREE.Vector3, kind: ToolKind, onArrive?: () => void) {
    const mid = from.clone().lerp(to, 0.5);
    const lift = from.distanceTo(to) * 0.28;
    const ctrl = mid.add(new THREE.Vector3((Math.random() - 0.5) * lift, lift * (0.6 + Math.random() * 0.5), (Math.random() - 0.5) * lift));
    const dur = 0.55 + Math.min(from.distanceTo(to) / 40, 1) * 0.7;
    this.comets.push({ from, ctrl, to, t: 0, dur, color: new THREE.Color(KIND_COLOR[kind]), kind, onArrive });
  }

  /** Where a tool call goes: a file star, a directory galaxy, or one of the fixed stations. */
  toolCall(kind: ToolKind, paths: string[], input: any, parent: string | null, live: boolean) {
    const targets: number[] = [];
    for (const p of paths) {
      const r = this.rel(p);
      if (r === null) continue;
      const i = this.byPath.get(r) ?? (kind === 'write' ? this.addFile(r) : undefined);
      if (i !== undefined && i >= 0) targets.push(i);
    }
    for (const i of targets) this.files[i].touches++;

    if (!live) {
      for (const i of targets) {
        if (kind === 'edit' || kind === 'write') this.files[i].edited = 1;
      }
      return;
    }

    const from = this.originFor(parent);
    if (kind === 'agent') {
      return;
    }
    if (targets.length) {
      for (const i of targets) {
        this.launch(from, this.nodePos(i), kind, () => this.impact(i, kind));
      }
      return;
    }
    if (kind === 'search') {
      const dir = this.rel(typeof input?.path === 'string' ? input.path : '') ?? '';
      const g = this.groupByName.get(dir.split('/')[0] || '.');
      const pool = this.files.map((_, i) => i).filter((i) => g === undefined || this.files[i].group === g);
      for (let n = 0; n < Math.min(5, pool.length); n++) {
        const i = pool[Math.floor(Math.random() * pool.length)];
        this.launch(from, this.nodePos(i), kind, () => this.impact(i, kind, 0.5));
      }
      return;
    }
    const station = kind === 'shell' ? this.shell : kind === 'web' ? this.cloud : kind === 'mcp' ? this.mcpStation : null;
    if (station) {
      this.launch(from, station.clone(), kind, () => this.sparks.burst(station, new THREE.Color(KIND_COLOR[kind]), 24, 6));
    }
  }

  private impact(i: number, kind: ToolKind, strength = 1) {
    const f = this.files[i];
    const p = this.nodePos(i);
    const c = new THREE.Color(KIND_COLOR[kind]);
    if (kind === 'edit' || kind === 'write') {
      f.edited = 1;
      f.heat += 2.2 * strength;
      this.sparks.burst(p, c, 46, 7, 1.4, 0.42);
      this.sparks.ring(p, c, 36, 5);
    } else {
      f.heat += 1.1 * strength;
      this.sparks.burst(p, c, 14, 3.5, 0.9, 0.3);
    }
  }

  toolResult(ok: boolean, kind: ToolKind | null, paths: string[], test: boolean) {
    const at = kind === 'shell' ? this.shell : null;
    if (test && at) {
      if (ok) this.fireworks(at.clone().add(new THREE.Vector3(0, 5, 0)));
      else this.failure(at);
      return;
    }
    if (!ok) {
      const r = paths.map((p) => this.rel(p)).find((r) => r !== null && this.byPath.has(r));
      this.failure(r ? this.nodePos(this.byPath.get(r)!) : (at ?? new THREE.Vector3()));
    }
  }

  private fireworks(p: THREE.Vector3) {
    const colors = ['#9dff8a', '#ffe27a', '#7ad7ff', '#ff9de2'];
    for (let k = 0; k < 4; k++) {
      setTimeout(() => {
        const q = p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 8, Math.random() * 5, (Math.random() - 0.5) * 8));
        this.sparks.burst(q, new THREE.Color(colors[k]), 140, 9, 1.8, 0.4);
      }, k * 220);
    }
    this.uPulse.value = 1;
  }

  private failure(p: THREE.Vector3) {
    const red = new THREE.Color('#ff3b3b');
    this.sparks.ring(p, red, 90, 11);
    this.sparks.burst(p, red, 40, 4, 1.2, 0.4);
    this.shake = Math.max(this.shake, 0.9);
    this.rimFlash.set('#ff2020');
  }

  spawnMoon(id: string) {
    if (this.moons.has(id)) return;
    const n = this.moons.size;
    this.moons.set(id, {
      id,
      phase: Math.random() * TAU,
      radius: 3.6 + n * 0.9,
      tilt: (Math.random() - 0.5) * 1.2,
      speed: 0.9 + Math.random() * 0.5,
      pos: new THREE.Vector3(),
      fade: 0,
      dying: false,
    });
    this.sparks.burst(new THREE.Vector3(), new THREE.Color(KIND_COLOR.agent), 50, 5);
  }

  endMoon(id: string) {
    const m = this.moons.get(id);
    if (m) m.dying = true;
  }

  thinking() {
    this.think = Math.min(1, this.think + 0.06);
  }

  speaking() {
    this.speak = Math.min(1, this.speak + 0.08);
  }

  setWaiting(w: boolean) {
    this.waiting = w;
  }

  turnStarted() {
    this.uPulse.value = 0.8;
    this.sparks.ring(new THREE.Vector3(), new THREE.Color('#9fe3ff'), 60, 8);
  }

  compaction() {
    this.sparks.ring(new THREE.Vector3(), new THREE.Color('#ffffff'), 120, 14);
    this.uPulse.value = 1;
  }

  reset() {
    this.comets = [];
    this.moons.clear();
    for (const f of this.files) {
      f.heat = 0;
      f.edited = 0;
      f.touches = 0;
    }
    this.writeNodes();
  }

  // ---------------------------------------------------------------- frame

  private frame() {
    this.timer.update();
    const raw = Math.min(this.timer.getDelta(), 0.05);
    this.timeScale += ((this.waiting ? 0.2 : 1) - this.timeScale) * Math.min(1, raw * 3);
    const dt = raw * this.timeScale;
    this.uSat.value += ((this.waiting ? 0.25 : 1) - this.uSat.value) * Math.min(1, raw * 3);

    this.think = Math.max(0, this.think - dt * 0.12);
    this.speak = Math.max(0, this.speak - dt * 0.9);
    this.uThink.value += (this.think - this.uThink.value) * Math.min(1, dt * 2);
    this.uSpeak.value += (this.speak - this.uSpeak.value) * Math.min(1, dt * 6);
    this.uPulse.value = Math.max(0, this.uPulse.value - dt * 1.6);
    this.core.scale.setScalar(1 + this.uSpeak.value * 0.12 + this.uPulse.value * 0.25);
    this.core.rotation.y += dt * 0.2;

    this.stepComets(dt);
    this.stepMoons(dt);
    this.sparks.step(dt);

    let dirty = false;
    for (const f of this.files) {
      if (f.heat > 0.001) {
        f.heat *= Math.exp(-dt * 0.22);
        dirty = true;
      }
    }
    if (dirty) this.writeNodes();

    this.shake = Math.max(0, this.shake - raw * 1.8);
    const s = this.shake * this.shake * 0.8;
    this.world.position.set((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s);

    this.controls.autoRotateSpeed = this.waiting ? 0.04 : 0.18;
    this.controls.update(raw);
    this.pipeline.render();
  }

  private stepComets(dt: number) {
    const p = new THREE.Vector3();
    const prev = new THREE.Vector3();
    const jitter = new THREE.Vector3();
    this.comets = this.comets.filter((c) => {
      const t0 = Math.min(c.t / c.dur, 1);
      c.t += dt;
      const t1 = Math.min(c.t / c.dur, 1);
      const ease = (t: number) => 1 - Math.pow(1 - t, 2.2);
      const at = (t: number, out: THREE.Vector3) => {
        const u = ease(t);
        const a = c.from.clone().lerp(c.ctrl, u);
        const b = c.ctrl.clone().lerp(c.to, u);
        return out.copy(a.lerp(b, u));
      };
      at(t0, prev);
      at(t1, p);
      const steps = 4;
      for (let k = 0; k < steps; k++) {
        const q = prev.clone().lerp(p, k / steps);
        jitter.randomDirection().multiplyScalar(0.35);
        this.sparks.emit(q, jitter, c.color, 0.5 + Math.random() * 0.25, k === steps - 1 ? 0.55 : 0.3, 2.4);
      }
      if (t1 >= 1) {
        c.onArrive?.();
        return false;
      }
      return true;
    });
  }

  private stepMoons(dt: number) {
    const lime = new THREE.Color(KIND_COLOR.agent);
    let i = 0;
    for (const m of [...this.moons.values()]) {
      m.fade = Math.max(0, Math.min(1, m.fade + (m.dying ? -dt * 0.8 : dt * 1.5)));
      if (m.dying && m.fade === 0) {
        this.moons.delete(m.id);
        continue;
      }
      m.phase += dt * m.speed;
      m.pos.set(Math.cos(m.phase) * m.radius, 0, Math.sin(m.phase) * m.radius).applyAxisAngle(new THREE.Vector3(1, 0, 0), m.tilt);
      this.moonLayer.pos.set([m.pos.x, m.pos.y, m.pos.z], i * 3);
      this.moonLayer.col.set([lime.r, lime.g, lime.b, m.fade], i * 4);
      this.moonLayer.size[i] = 0.5;
      if (Math.random() < 0.6) this.sparks.emit(m.pos, new THREE.Vector3(), lime, 0.8, 0.22, 0);
      i++;
    }
    this.moonLayer.count = i;
    this.moonLayer.flush();
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / Math.max(1, r.height);
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- picking

  private nearest(e: MouseEvent): string | null {
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const v = new THREE.Vector3();
    let best = 14 * 14;
    let hit: string | null = null;
    for (let i = 0; i < this.files.length; i++) {
      v.fromArray(this.nodes.pos, i * 3).add(this.world.position).project(this.camera);
      if (v.z > 1) continue;
      const dx = ((v.x + 1) / 2) * r.width - mx;
      const dy = ((1 - v.y) / 2) * r.height - my;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        hit = this.files[i].path;
      }
    }
    return hit;
  }

  private hoverQueued = false;
  private onHover(e: PointerEvent) {
    if (this.hoverQueued) return;
    this.hoverQueued = true;
    requestAnimationFrame(() => {
      this.hoverQueued = false;
      this.hooks.hover(this.nearest(e), e.clientX, e.clientY);
    });
  }

  private onClick(e: MouseEvent) {
    const p = this.nearest(e);
    if (p) this.hooks.pick(p);
  }

  get fileCount() {
    return this.files.length;
  }
}
