import * as THREE from 'three/webgpu';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

/*
 * The repository as a miniature city on a blueprint table: a district per top-level folder,
 * laid out as a squarified treemap, and a building per file whose height follows its size and
 * whose colour follows its type.
 */

export interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
}

interface Item {
  key: string;
  weight: number;
}

/** Squarified treemap (Bruls, Huizing, van Wijk). Items should be sorted heaviest first. */
export function squarify(items: Item[], rect: Rect): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const total = items.reduce((a, i) => a + i.weight, 0);
  if (!total || rect.w <= 0 || rect.d <= 0) return out;
  const scale = (rect.w * rect.d) / total;
  const queue = items.map((i) => ({ key: i.key, area: i.weight * scale }));
  let r = { ...rect };
  let row: typeof queue = [];

  const worst = (row: typeof queue, side: number) => {
    const sum = row.reduce((a, i) => a + i.area, 0);
    let max = 0;
    let min = Infinity;
    for (const i of row) {
      max = Math.max(max, i.area);
      min = Math.min(min, i.area);
    }
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };

  const layout = (row: typeof queue) => {
    const sum = row.reduce((a, i) => a + i.area, 0);
    if (r.w >= r.d) {
      const w = sum / r.d;
      let z = r.z;
      for (const i of row) {
        const d = i.area / w;
        out.set(i.key, { x: r.x, z, w, d });
        z += d;
      }
      r = { x: r.x + w, z: r.z, w: r.w - w, d: r.d };
    } else {
      const d = sum / r.w;
      let x = r.x;
      for (const i of row) {
        const w = i.area / d;
        out.set(i.key, { x, z: r.z, w, d });
        x += w;
      }
      r = { x: r.x, z: r.z + d, w: r.w, d: r.d - d };
    }
  };

  while (queue.length) {
    const side = Math.min(r.w, r.d);
    const next = queue[0];
    if (!row.length || worst([...row, next], side) <= worst(row, side)) {
      row.push(next);
      queue.shift();
    } else {
      layout(row);
      row = [];
    }
  }
  if (row.length) layout(row);
  return out;
}

const TYPE_COLOR: [RegExp, string][] = [
  [/\.rs$/, '#ff8a4c'],
  [/\.(ts|tsx|js|jsx|mjs|svelte|vue)$/, '#5fb6ff'],
  [/\.(md|mdx|txt|rst)$/, '#e8e2d0'],
  [/\.(toml|json|ya?ml|lock|ini|env)$/, '#7fe08a'],
  [/\.(sql|graphql|gql|proto)$/, '#c49bff'],
  [/\.(css|scss|html|astro)$/, '#ff7fbf'],
  [/\.(sh|bash|zsh|ps1|Dockerfile|nix)$/, '#ffd55f'],
  [/\.(py|go|zig|ml|mli|sol|swift|kt|dart|c|h|cpp|java)$/, '#5fe0d0'],
  [/\.(png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf)$/, '#8c8fa8'],
];

function typeColor(path: string): THREE.Color {
  for (const [re, c] of TYPE_COLOR) if (re.test(path)) return new THREE.Color(c);
  return new THREE.Color('#a7b0c8');
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

const CAPACITY = 24_000;

interface Building {
  path: string;
  base: THREE.Color;
  pos: THREE.Vector3;
  foot: number;
  height: number;
  shown: number;
  glow: number;
  glowColor: THREE.Color;
  edited: number;
  bump: number;
}

export class City {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh;
  private buildings: Building[] = [];
  private byPath = new Map<string, number>();
  private plates = new THREE.Group();
  private labels: CSS2DObject[] = [];
  private dirty = true;
  /** The table top, in the group's local space. */
  readonly top: Rect;
  private districts = new Map<string, Rect>();

  constructor(readonly width: number, readonly depth: number, readonly height: number) {
    this.top = { x: -width / 2, z: -depth / 2, w: width, d: depth };
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.1 }), CAPACITY);
    // Fill the colour buffer before the first frame: a pipeline compiled without it ignores it.
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    const c = new THREE.Color('#ffffff');
    for (let i = 0; i < CAPACITY; i++) {
      this.mesh.setMatrixAt(i, zero);
      this.mesh.setColorAt(i, c);
    }
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.position.y = height + 0.06;
    this.plates.position.y = height + 0.055;
    this.group.add(this.buildTable(), this.plates, this.mesh);
  }

  private buildTable(): THREE.Group {
    const g = new THREE.Group();
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = Math.round((1024 * this.depth) / this.width);
    const x = c.getContext('2d')!;
    x.fillStyle = '#0a2240';
    x.fillRect(0, 0, c.width, c.height);
    x.strokeStyle = 'rgba(120, 200, 255, 0.22)';
    x.lineWidth = 1;
    for (let i = 0; i < c.width; i += 32) {
      x.beginPath();
      x.moveTo(i, 0);
      x.lineTo(i, c.height);
      x.stroke();
    }
    for (let j = 0; j < c.height; j += 32) {
      x.beginPath();
      x.moveTo(0, j);
      x.lineTo(c.width, j);
      x.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const topMat = new THREE.MeshStandardMaterial({ map: tex, emissive: '#1a5fa0', emissiveIntensity: 0.35, emissiveMap: tex, roughness: 0.6 });
    const frame = new THREE.MeshStandardMaterial({ color: '#232838', roughness: 0.4, metalness: 0.6 });
    const top = new THREE.Mesh(new THREE.BoxGeometry(this.width + 0.3, 0.1, this.depth + 0.3), [frame, frame, topMat, frame, frame, frame]);
    top.position.y = this.height;
    top.receiveShadow = true;
    top.castShadow = true;
    g.add(top);
    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(this.width + 0.34, 0.02, this.depth + 0.34),
      new THREE.MeshBasicMaterial({ color: '#4fc3ff' }),
    );
    edge.position.y = this.height - 0.06;
    g.add(edge);
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, this.height, 12), frame);
      leg.position.set((sx * this.width) / 2.1, this.height / 2, (sz * this.depth) / 2.1);
      leg.castShadow = true;
      g.add(leg);
    }
    return g;
  }

  // ---------------------------------------------------------------- layout

  setFiles(files: string[], sizes: number[]) {
    this.buildings = [];
    this.byPath.clear();
    for (const l of this.labels) {
      l.element.remove();
      l.removeFromParent();
    }
    this.labels = [];
    this.plates.clear();

    const weight = (size: number) => 1 + Math.log2(1 + size) * 0.15;
    const tree = new Map<string, Map<string, { path: string; size: number }[]>>();
    files.forEach((f, i) => {
      const parts = f.split('/');
      const top = parts.length > 1 ? parts[0] : '·';
      const block = parts.length > 2 ? parts[1] : '·';
      if (!tree.has(top)) tree.set(top, new Map());
      const blocks = tree.get(top)!;
      if (!blocks.has(block)) blocks.set(block, []);
      blocks.get(block)!.push({ path: f, size: sizes[i] ?? 0 });
    });

    const districtItems = [...tree.entries()]
      .map(([key, blocks]) => ({ key, weight: [...blocks.values()].flat().reduce((a, f) => a + weight(f.size), 0) }))
      .sort((a, b) => b.weight - a.weight);
    const pad = 0.04;
    this.districts = squarify(districtItems, { x: this.top.x + pad, z: this.top.z + pad, w: this.top.w - 2 * pad, d: this.top.d - 2 * pad });

    for (const [top, rect] of this.districts) {
      const hue = hash(top);
      const plate = new THREE.Mesh(
        new THREE.BoxGeometry(Math.max(0.01, rect.w - 0.05), 0.012, Math.max(0.01, rect.d - 0.05)),
        new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hue, 0.35, 0.16), emissive: new THREE.Color().setHSL(hue, 0.6, 0.12), roughness: 0.8 }),
      );
      plate.position.set(rect.x + rect.w / 2, 0, rect.z + rect.d / 2);
      plate.receiveShadow = true;
      this.plates.add(plate);

      const blocks = tree.get(top)!;
      const blockItems = [...blocks.entries()]
        .map(([key, fs]) => ({ key, weight: fs.reduce((a, f) => a + weight(f.size), 0) }))
        .sort((a, b) => b.weight - a.weight);
      const inner = { x: rect.x + 0.05, z: rect.z + 0.05, w: Math.max(0.01, rect.w - 0.1), d: Math.max(0.01, rect.d - 0.1) };
      const blockRects = squarify(blockItems, inner);
      for (const [block, br] of blockRects) {
        const fs = blocks.get(block)!.sort((a, b) => a.path.localeCompare(b.path));
        this.placeBlock(fs, br);
      }
    }
    this.labelDistricts();
    this.mesh.count = this.buildings.length;
    this.dirty = true;
  }

  /** Files on a grid inside their block, as square a grid as the block allows. */
  private placeBlock(fs: { path: string; size: number }[], r: Rect) {
    const n = fs.length;
    const cols = Math.max(1, Math.round(Math.sqrt((n * r.w) / Math.max(0.001, r.d))));
    const rows = Math.ceil(n / cols);
    const cw = r.w / cols;
    const cd = r.d / rows;
    fs.forEach((f, i) => {
      const cx = r.x + (i % cols) * cw + cw / 2;
      const cz = r.z + Math.floor(i / cols) * cd + cd / 2;
      this.addBuilding(f.path, f.size, new THREE.Vector3(cx, 0, cz), Math.min(cw, cd) * 0.72, 1);
    });
  }

  private addBuilding(path: string, size: number, pos: THREE.Vector3, foot: number, shown: number): number {
    if (this.buildings.length >= CAPACITY) return -1;
    const i = this.buildings.length;
    const height = 0.03 + Math.min(0.75, Math.log2(1 + size) * 0.038) * (0.85 + hash(path) * 0.3);
    this.buildings.push({
      path,
      base: typeColor(path).multiplyScalar(0.8),
      pos,
      foot: Math.max(0.012, foot),
      height,
      shown,
      glow: 0,
      glowColor: new THREE.Color('#ffffff'),
      edited: 0,
      bump: 0,
    });
    this.byPath.set(path, i);
    this.mesh.count = this.buildings.length;
    this.dirty = true;
    return i;
  }

  private labelDistricts() {
    const biggest = [...this.districts.entries()].sort((a, b) => b[1].w * b[1].d - a[1].w * a[1].d).slice(0, 7);
    for (const [name, r] of biggest) {
      if (r.w * r.d < 0.25) continue;
      const el = document.createElement('div');
      el.className = 'district-label';
      el.textContent = name === '·' ? '(root)' : name;
      const label = new CSS2DObject(el);
      label.position.set(r.x + r.w / 2, this.height + 0.08, r.z + r.d - 0.05);
      this.group.add(label);
      this.labels.push(label);
    }
  }

  /** A file the agent just created: it rises out of its district, or the nearest free space. */
  addFile(path: string): boolean {
    if (this.byPath.has(path)) return false;
    const top = path.includes('/') ? path.split('/')[0] : '·';
    const r = this.districts.get(top) ?? this.top;
    const p = new THREE.Vector3(r.x + 0.08 + hash(path) * Math.max(0.01, r.w - 0.16), 0, r.z + 0.08 + hash(path + '#') * Math.max(0.01, r.d - 0.16));
    const foot = this.buildings.length ? this.buildings[0].foot : 0.08;
    const i = this.addBuilding(path, 2000, p, foot, 0);
    if (i >= 0) {
      this.buildings[i].glow = 1.5;
      this.buildings[i].glowColor.set('#ffe27a');
    }
    return i >= 0;
  }

  // ---------------------------------------------------------------- activity

  has(path: string) {
    return this.byPath.has(path);
  }

  /** World position of the roof of a file's building. */
  roof(path: string): THREE.Vector3 | null {
    const i = this.byPath.get(path);
    if (i === undefined) return null;
    const b = this.buildings[i];
    return this.group.localToWorld(b.pos.clone().setY(this.mesh.position.y + b.height * b.shown));
  }

  touch(path: string, color: string, strength = 1) {
    const i = this.byPath.get(path);
    if (i === undefined) return;
    const b = this.buildings[i];
    b.glow = Math.max(b.glow, strength);
    b.glowColor.set(color);
    this.dirty = true;
  }

  edited(path: string, animate: boolean) {
    const i = this.byPath.get(path);
    if (i === undefined) return;
    const b = this.buildings[i];
    b.edited = 1;
    if (animate) {
      b.bump = 1;
      b.glow = 1.6;
      b.glowColor.set('#ffb347');
    }
    this.dirty = true;
  }

  resetActivity() {
    for (const b of this.buildings) {
      b.glow = 0;
      b.edited = 0;
      b.bump = 0;
      b.shown = 1;
    }
    this.dirty = true;
  }

  get count() {
    return this.buildings.length;
  }

  frame(dt: number) {
    let changed = this.dirty;
    for (const b of this.buildings) {
      if (b.glow > 0.001) {
        b.glow *= Math.exp(-dt * 0.45);
        changed = true;
      }
      if (b.bump > 0.001) {
        b.bump *= Math.exp(-dt * 3);
        changed = true;
      }
      if (b.shown < 1) {
        b.shown = Math.min(1, b.shown + dt * 0.8);
        changed = true;
      }
    }
    if (!changed) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const c = new THREE.Color();
    const amber = new THREE.Color('#ffb347');
    for (let i = 0; i < this.buildings.length; i++) {
      const b = this.buildings[i];
      const h = b.height * b.shown * (1 + b.bump * 0.6);
      m.compose(b.pos, q, s.set(b.foot, Math.max(0.001, h), b.foot));
      this.mesh.setMatrixAt(i, m);
      c.copy(b.base).lerp(amber, b.edited * 0.55);
      if (b.glow > 0.01) c.lerp(b.glowColor, Math.min(1, b.glow)).multiplyScalar(1 + b.glow * 2.5);
      this.mesh.setColorAt(i, c);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.computeBoundingSphere();
    this.dirty = false;
  }

  pick(ray: THREE.Raycaster): string | null {
    const hit = ray.intersectObject(this.mesh, false)[0];
    return hit?.instanceId !== undefined ? (this.buildings[hit.instanceId]?.path ?? null) : null;
  }
}
