import * as THREE from 'three/webgpu';
import { pass, uniform, vec3, vec4, mix, dot } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { Sparks } from './fx';
import { City } from './city';
import { KIND_COLOR, KIND_GLYPH } from './palette';
import { Robot, Screen, hash, VERB, MUSINGS, type Task, type StageHooks, type ToolCallInfo } from './workshop';
import type { ToolKind } from './types';

/*
 * Inside the repository: the project is a full-size city and the agents fly through it to the
 * building of the file they are working on. Tools that are not about a file live on the outskirts.
 */

type Landmark = 'terminal' | 'mast' | 'kiosk' | 'portal' | 'park';

const LANDMARK_FOR: Partial<Record<ToolKind, Landmark>> = {
  shell: 'terminal',
  web: 'mast',
  mcp: 'kiosk',
  agent: 'portal',
};

/** Which arm animation a robot uses; the names are the workshop's station names. */
const POSE: Record<ToolKind, string> = {
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

interface Kit {
  group: THREE.Group;
  task: Task | null;
  grow: number;
  closing: boolean;
  scope?: THREE.Object3D;
}

interface Holo {
  screen: Screen;
  at: THREE.Vector3;
  life: number;
  task: Task;
}

export class Inside {
  readonly renderer: THREE.WebGPURenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private labels = new CSS2DRenderer();
  private pipeline!: THREE.RenderPipeline;
  private timer = new THREE.Timer();
  private sparks = new Sparks(6000);
  private readonly uSat = uniform(1);

  private robots = new Map<string, Robot>();
  private slots = 0;
  private root = '';
  private city: City | null = null;
  private w = 20;
  private d = 14;
  private cruise = 5.5;
  private marks = new Map<Landmark, { group: THREE.Group; stand: THREE.Vector3; look: THREE.Vector3 }>();
  private termScreen = new Screen(4, 2.6);
  private holos: Holo[] = [];
  private kits: Kit[] = [];
  private scopes: THREE.Object3D[] = [];
  private screens: Screen[] = [];
  private beams: { mesh: THREE.Mesh; robot: Robot; task: Task; to: THREE.Vector3 }[] = [];
  private cone: THREE.Mesh;
  private coneFor: Task | null = null;
  private key!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private spot = new THREE.SpotLight('#fff1c9', 0, 40, 0.25, 0.5, 1.2);
  private alarm = new THREE.PointLight('#ff2a2a', 0, 18, 1.4);
  private alarmT = 0;
  private waiting = false;
  private focused: string | null = null;
  private follow = true;
  private small = matchMedia('(max-width: 760px)').matches;
  private labelTick = 0;

  constructor(private canvas: HTMLCanvasElement, private hooks: StageHooks) {
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.small ? 1.5 : 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 600);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 160;
    this.controls.addEventListener('start', () => (this.follow = false));

    const sky = new THREE.Color('#0b0e1a');
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 60, 220);
    this.labels.domElement.className = 'labels';
    document.body.append(this.labels.domElement);

    this.hemi = new THREE.HemisphereLight('#9fb4ff', '#2a2230', 1.1);
    this.key = new THREE.DirectionalLight('#ffd6a8', 2.2);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(this.small ? 1024 : 4096, this.small ? 1024 : 4096);
    this.key.shadow.bias = -0.0004;
    this.scene.add(this.hemi, this.key, this.key.target, this.spot, this.spot.target, this.alarm);
    this.scene.add(this.sparks.layer.sprite);

    this.cone = new THREE.Mesh(
      new THREE.ConeGeometry(1.6, 5, 32, 1, true),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(KIND_COLOR.search).multiplyScalar(1.5), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.scene.add(this.cone);

    this.buildLandmarks();
    this.furnishYard();
    this.layout(20, 14);
    this.stars();

    canvas.addEventListener('pointermove', (e) => this.onHover(e));
    canvas.addEventListener('click', (e) => this.onClick(e));
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'f' && !(document.activeElement instanceof HTMLTextAreaElement)) this.toggleFollow();
    });
  }

  async start() {
    await this.renderer.init();
    const scenePass = pass(this.scene, this.camera);
    const color = scenePass.getTextureNode('output');
    const lit = color.add(bloom(color, 0.6, 0.45, 0.5));
    const lum = dot(lit.rgb, vec3(0.2126, 0.7152, 0.0722));
    this.pipeline = new THREE.RenderPipeline(this.renderer);
    this.pipeline.outputNode = vec4(mix(vec3(lum), lit.rgb, this.uSat), 1);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  get backend(): string {
    return (this.renderer.backend as any).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  }

  toggleFollow(): boolean {
    this.follow = !this.follow;
    return this.follow;
  }

  // ---------------------------------------------------------------- the outskirts

  private mat(color: string, rough = 0.6, metal = 0.2, emissive = '#000000', ei = 0) {
    return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive, emissiveIntensity: ei });
  }

  private part(geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D) {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  private buildLandmarks() {
    // Terminal tower: a slab with a big screen, for the shell.
    const tower = new THREE.Group();
    this.part(new THREE.BoxGeometry(2.2, 7, 1.6), this.mat('#1b1e28', 0.4, 0.6), 0, 3.5, 0, tower);
    this.termScreen.mesh.position.set(0, 5, 0.82);
    tower.add(this.termScreen.mesh);
    const tl = new THREE.PointLight('#ff5fa2', 6, 10, 1.5);
    tl.position.set(0, 5, 2);
    tower.add(tl);
    this.termScreen.lines('zsh', [{ text: '$ _', color: '#9dff8a' }]);

    // Radio mast, for the web.
    const mast = new THREE.Group();
    this.part(new THREE.CylinderGeometry(0.12, 0.35, 9, 8), this.mat('#8a93a8', 0.4, 0.7), 0, 4.5, 0, mast);
    const dish = this.part(new THREE.SphereGeometry(1.2, 24, 12, 0, Math.PI * 2, 0, Math.PI / 3), this.mat('#d8dce6', 0.3, 0.5), 0, 7, 0.4, mast);
    dish.rotation.x = -Math.PI / 2.4;
    dish.name = 'dish';
    const tip = this.part(new THREE.SphereGeometry(0.18, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(KIND_COLOR.web).multiplyScalar(3) }), 0, 9.1, 0, mast);
    tip.name = 'tip';

    // Kiosk, for MCP calls.
    const kiosk = new THREE.Group();
    this.part(new THREE.BoxGeometry(2, 2.4, 1.4), this.mat('#4a3426', 0.7, 0.1), 0, 1.2, 0, kiosk);
    this.part(new THREE.BoxGeometry(2.4, 0.15, 1.8), this.mat('#ff8a5f', 0.5, 0.2, '#ff8a5f', 0.6), 0, 2.5, 0, kiosk);

    // Portal, where helpers arrive.
    const portal = new THREE.Group();
    const frame = this.mat('#20232e', 0.4, 0.6);
    this.part(new THREE.BoxGeometry(0.3, 4, 0.3), frame, -1.3, 2, 0, portal);
    this.part(new THREE.BoxGeometry(0.3, 4, 0.3), frame, 1.3, 2, 0, portal);
    this.part(new THREE.BoxGeometry(2.9, 0.3, 0.3), frame, 0, 4, 0, portal);
    const field = new THREE.Mesh(
      new THREE.PlaneGeometry(2.3, 3.8),
      new THREE.MeshBasicMaterial({ color: '#c6ff6e', transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }),
    );
    field.position.y = 2;
    field.name = 'field';
    portal.add(field);

    // A small park with a bench and a lamp, where idle robots wait.
    const park = new THREE.Group();
    const grass = new THREE.Mesh(new THREE.CircleGeometry(3.2, 40), this.mat('#2f5a36', 0.95, 0));
    grass.rotation.x = -Math.PI / 2;
    grass.position.y = 0.02;
    grass.receiveShadow = true;
    park.add(grass);
    this.part(new THREE.BoxGeometry(2.4, 0.15, 0.7), this.mat('#6b4a33', 0.7, 0), 0, 0.55, 1.2, park);
    this.part(new THREE.BoxGeometry(2.4, 0.6, 0.12), this.mat('#6b4a33', 0.7, 0), 0, 0.95, 1.55, park);
    this.part(new THREE.CylinderGeometry(0.15, 0.2, 1.4, 8), this.mat('#5a3d2b'), -2, 0.7, -1, park);
    this.part(new THREE.IcosahedronGeometry(1.1, 1), this.mat('#3f8f4f', 0.8, 0), -2, 2.1, -1, park);
    this.part(new THREE.CylinderGeometry(0.05, 0.05, 3), this.mat('#222'), 1.8, 1.5, -0.6, park);
    const lamp = new THREE.PointLight('#ffb764', 8, 9, 1.5);
    lamp.position.set(1.8, 3.1, -0.6);
    park.add(lamp);
    this.part(new THREE.SphereGeometry(0.22, 12, 10), new THREE.MeshBasicMaterial({ color: '#ffd9a0' }), 1.8, 3.1, -0.6, park);

    for (const [name, group] of [
      ['terminal', tower],
      ['mast', mast],
      ['kiosk', kiosk],
      ['portal', portal],
      ['park', park],
    ] as [Landmark, THREE.Group][]) {
      this.scene.add(group);
      this.marks.set(name, { group, stand: new THREE.Vector3(), look: new THREE.Vector3() });
    }
  }

  // ---------------------------------------------------------------- furniture and instruments

  private bench(parent: THREE.Object3D, x: number, z: number, rot = 0, w = 1.6): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rot;
    const wood = this.mat('#7a5638', 0.7, 0);
    const steel = this.mat('#3a3f4e', 0.4, 0.7);
    this.part(new THREE.BoxGeometry(w, 0.08, 0.8), wood, 0, 0.9, 0, g);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) this.part(new THREE.BoxGeometry(0.07, 0.9, 0.07), steel, (sx * (w - 0.15)) / 2, 0.45, (sz * 0.65) / 2, g);
    this.part(new THREE.BoxGeometry(w - 0.2, 0.05, 0.6), steel, 0, 0.3, 0, g);
    parent.add(g);
    return g;
  }

  private computer(parent: THREE.Object3D, x: number, z: number, lines: string[], tint = '#9dff8a'): Screen {
    const screen = new Screen(0.8, 0.5, 256);
    screen.lines(lines[0] ?? '', lines.slice(1).map((t) => ({ text: t, color: tint })));
    this.part(new THREE.BoxGeometry(0.9, 0.58, 0.06), this.mat('#15171f', 0.4, 0.3), x, 1.32, z - 0.03, parent);
    this.part(new THREE.BoxGeometry(0.08, 0.3, 0.08), this.mat('#15171f'), x, 1.03, z - 0.05, parent);
    this.part(new THREE.BoxGeometry(0.6, 0.03, 0.22), this.mat('#2a2d38', 0.5), x, 0.955, z + 0.22, parent);
    screen.mesh.position.set(x, 1.32, z + 0.005);
    parent.add(screen.mesh);
    this.screens.push(screen);
    return screen;
  }

  /** A little oscilloscope or radar scope whose sweep turns, faster while it is in use. */
  private scope(parent: THREE.Object3D, x: number, y: number, z: number, color = '#3dff9a'): THREE.Object3D {
    this.part(new THREE.BoxGeometry(0.5, 0.36, 0.3), this.mat('#2a2f3c', 0.5, 0.5), x, y + 0.18, z, parent);
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.13, 24), new THREE.MeshBasicMaterial({ color: '#06281a' }));
    face.position.set(x - 0.06, y + 0.2, z + 0.152);
    parent.add(face);
    const sweep = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.012), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(3) }));
    sweep.geometry.translate(0.06, 0, 0);
    sweep.position.set(x - 0.06, y + 0.2, z + 0.155);
    parent.add(sweep);
    for (let i = 0; i < 3; i++) {
      this.part(new THREE.CylinderGeometry(0.025, 0.025, 0.04, 10), this.mat('#d6a85a', 0.3, 0.8), x + 0.15, y + 0.1 + i * 0.09, z + 0.16, parent).rotation.x = Math.PI / 2;
    }
    this.scopes.push(sweep);
    return sweep;
  }

  private toolbox(parent: THREE.Object3D, x: number, y: number, z: number) {
    this.part(new THREE.BoxGeometry(0.42, 0.2, 0.22), this.mat('#c0392b', 0.5, 0.3), x, y + 0.1, z, parent);
    this.part(new THREE.TorusGeometry(0.08, 0.015, 6, 12, Math.PI), this.mat('#222', 0.4, 0.6), x, y + 0.2, z, parent);
  }

  private lamp(parent: THREE.Object3D, x: number, y: number, z: number, color = '#ffd28a') {
    this.part(new THREE.CylinderGeometry(0.08, 0.1, 0.03, 12), this.mat('#222'), x, y + 0.015, z, parent);
    const arm = this.part(new THREE.CylinderGeometry(0.012, 0.012, 0.45), this.mat('#444', 0.4, 0.7), x, y + 0.24, z, parent);
    arm.rotation.z = 0.35;
    this.part(new THREE.ConeGeometry(0.09, 0.12, 14, 1, true), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 2, side: THREE.DoubleSide }), x - 0.12, y + 0.45, z, parent);
    const l = new THREE.PointLight(color, 2.5, 3, 1.6);
    l.position.set(x - 0.12, y + 0.4, z);
    parent.add(l);
  }

  /** Benches, computers and instruments around the outskirts. */
  private furnishYard() {
    const tower = this.marks.get('terminal')!.group;
    for (const [z, label] of [
      [2.2, ['ci', 'cargo test ✓', 'clippy ✓', 'fmt ✓']],
      [-2.2, ['build', 'release ok', 'wasm ok']],
    ] as [number, string[]][]) {
      const b = this.bench(tower, 0, z, 0, 1.8);
      this.computer(b, -0.35, -0.1, label);
      this.scope(b, 0.5, 0.94, -0.05);
    }
    const mast = this.marks.get('mast')!.group;
    const desk = this.bench(mast, 0, 2.4, 0, 1.6);
    this.computer(desk, -0.3, -0.1, ['net', 'GET 200', 'GET 200', 'fetch…'], '#5fffd0');
    this.scope(desk, 0.45, 0.94, -0.05, '#5fffd0');
    const kiosk = this.marks.get('kiosk')!.group;
    const kd = this.bench(kiosk, 0, 2.2, 0, 1.4);
    this.computer(kd, 0, -0.1, ['mcp', 'tools/list', 'call…'], '#ff8a5f');
    const park = this.marks.get('park')!.group;
    const table = this.bench(park, 1.2, -1.6, 0.3, 1.4);
    this.lamp(table, 0.4, 0.94, 0);
  }

  /** A field station the robot unfolds beside the building it is working on. */
  private deploy(r: Robot, t: Task, facing: THREE.Vector3) {
    const g = new THREE.Group();
    const toward = new THREE.Vector3().subVectors(facing, r.pos).setY(0).normalize();
    g.position.copy(r.pos).addScaledVector(toward, 0.45);
    g.position.y = r.pos.y - 0.35;
    g.rotation.y = Math.atan2(toward.x, toward.z);
    // Robots hover, so a station off the ground stands on a little hover platform.
    if (g.position.y > 0.2) {
      const deck = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.06, 28), this.mat('#2a3142', 0.4, 0.6, '#1a5fa0', 0.4));
      deck.position.set(0, -0.03, -0.35);
      g.add(deck);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.03, 8, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color(KIND_COLOR[t.kind]).multiplyScalar(2) }));
      ring.rotation.x = Math.PI / 2;
      ring.position.set(0, -0.06, -0.35);
      g.add(ring);
    }
    let scope: THREE.Object3D | undefined;
    if (t.kind === 'edit' || t.kind === 'write') {
      const b = this.bench(g, 0, 0, 0, 1.3);
      const name = (t.file ?? '').split('/').pop() ?? '';
      this.computer(b, -0.25, -0.1, [name, t.kind === 'write' ? 'new file' : 'editing…'], '#ffd27a');
      this.toolbox(b, 0.4, 0.94, 0.05);
      this.lamp(b, 0.5, 0.94, -0.25, '#ffb347');
    } else if (t.kind === 'read') {
      const wood = this.mat('#6b4a33', 0.7, 0);
      this.part(new THREE.CylinderGeometry(0.06, 0.1, 0.95, 10), wood, 0, 0.475, 0, g);
      const top = this.part(new THREE.BoxGeometry(0.7, 0.05, 0.5), wood, 0, 1.0, 0, g);
      top.rotation.x = -0.35;
      const page = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.38), new THREE.MeshBasicMaterial({ color: '#f3ead2' }));
      page.position.set(0, 1.04, 0.01);
      page.rotation.x = -Math.PI / 2 - 0.35;
      g.add(page);
      this.lamp(g, 0.4, 0.98, -0.1);
    } else if (t.kind === 'search') {
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        const leg = this.part(new THREE.CylinderGeometry(0.02, 0.02, 1), this.mat('#3a2a20'), Math.cos(a) * 0.2, 0.45, Math.sin(a) * 0.2, g);
        leg.rotation.set(Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3);
      }
      scope = this.scope(g, 0.06, 0.92, 0, KIND_COLOR.search);
    } else {
      return;
    }
    g.scale.setScalar(0.01);
    this.scene.add(g);
    this.kits.push({ group: g, task: t, grow: 0, closing: false, scope });
  }

  /** Put the outskirts around a city of the given size, and the camera and sun to match. */
  private layout(w: number, d: number) {
    this.w = w;
    this.d = d;
    const place = (name: Landmark, x: number, z: number, face: number, standOffset: THREE.Vector3) => {
      const m = this.marks.get(name)!;
      m.group.position.set(x, 0, z);
      m.group.rotation.y = face;
      m.stand.set(x, 0, z).add(standOffset);
      m.look.set(x, 1.5, z);
    };
    place('terminal', w / 2 + 5, -d / 2 + 2, -Math.PI / 2, new THREE.Vector3(-2.4, 0, 0));
    place('mast', -w / 2 - 5, -d / 2 + 2, Math.PI / 2, new THREE.Vector3(2.2, 0, 0));
    place('kiosk', w / 2 + 5, d / 2 - 2, -Math.PI / 2, new THREE.Vector3(-2.2, 0, 0));
    place('portal', 0, d / 2 + 5, Math.PI, new THREE.Vector3(0, 0, -2.4));
    place('park', -w / 2 - 6, d / 2 - 2, 0, new THREE.Vector3(0, 0, 1.6));
    this.marks.get('park')!.look.set(-w / 2 - 6, 0.5, d / 2 + 3);

    const span = Math.max(w, d * 1.4) + 14;
    Object.assign(this.key.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: span * 4 });
    this.key.shadow.camera.updateProjectionMatrix();
    this.key.position.set(span * 0.6, span * 1.2, span * 0.5);

    const dist = Math.max(w, d) * 1.15 + 18;
    const dir = new THREE.Vector3(0.62, 0.62, 0.78).normalize();
    this.controls.target.set(0, 0, 0);
    this.camera.position.copy(dir.multiplyScalar(dist));
  }

  private stars() {
    for (let i = 0; i < 260; i++) {
      const v = new THREE.Vector3().randomDirection();
      v.y = Math.abs(v.y) * 0.7 + 0.15;
      this.sparks.emit(v.multiplyScalar(180), new THREE.Vector3(), new THREE.Color('#dfe6ff'), 1e9, 0.5, 0);
    }
  }

  // ---------------------------------------------------------------- the city

  setFiles(root: string, files: string[], sizes: number[] = []) {
    this.root = root.replace(/\/$/, '');
    const area = Math.min(1400, Math.max(160, files.length * 1.3));
    const w = Math.sqrt(area * 1.6);
    const d = area / w;
    this.city?.dispose();
    this.city = new City(w, d, 0, { ground: true, heightScale: 4.2, gap: 0.8, maxFoot: 2.4 });
    this.scene.add(this.city.group);
    this.city.setFiles(files, sizes);
    this.layout(w, d);
    this.hooks.files(this.city.count);
  }

  private rel(path: string): string | null {
    if (!path) return null;
    if (this.root && path.startsWith(this.root + '/')) return path.slice(this.root.length + 1);
    if (!path.startsWith('/')) return path.replace(/^\.\//, '');
    return null;
  }

  // ---------------------------------------------------------------- agents

  placeholder() {
    if (!this.robots.size) this.robotFor(null, null).setAction('waiting for a task');
  }

  private robotFor(session: string | null, parent: string | null): Robot {
    if (!session && !parent) {
      const main = [...this.robots.values()].reverse().find((x) => x.scale === 1 && !x.leaving);
      if (main) return main;
    }
    const key = parent ?? session ?? 'main';
    let r = this.robots.get(key);
    if (r) return r;
    const stand = this.robots.get('main');
    if (!parent && session && stand) {
      this.robots.delete('main');
      this.robots.set(key, stand);
      return stand;
    }
    const base = session ? this.robots.get(session) : undefined;
    const color = parent && base ? base.color.clone().offsetHSL(0.08, 0, 0.1) : new THREE.Color().setHSL(0.5 + hash(key) * 0.5, 0.75, 0.55);
    r = new Robot(key, parent ? 'helper' : 'agent', color, parent ? 0.75 : 1.1, this.slots++);
    r.cruise = this.cruise;
    const start = parent ? this.marks.get('portal')!.stand : this.parkSpot(r);
    r.pos.copy(start);
    r.flyTo(start, parent ? new THREE.Vector3(0, 1, 0) : this.marks.get('park')!.look, parent ? 'floor' : 'lounge');
    this.robots.set(key, r);
    this.scene.add(r.group);
    if (parent) this.portalFlash();
    return r;
  }

  private parkSpot(r: Robot): THREE.Vector3 {
    const m = this.marks.get('park')!;
    const i = r.slot;
    return m.stand.clone().add(new THREE.Vector3(((i % 3) - 1) * 1.1, 0, Math.floor(i / 3) * 1.1));
  }

  private markSpot(name: Landmark, r: Robot): { stand: THREE.Vector3; look: THREE.Vector3 } {
    const m = this.marks.get(name)!;
    const side = new THREE.Vector3().subVectors(m.look, m.stand).setY(0).normalize();
    const tangent = new THREE.Vector3(-side.z, 0, side.x);
    const offset = (r.slot % 2 ? 1 : -1) * Math.ceil(r.slot / 2) * 1.2;
    return { stand: m.stand.clone().addScaledVector(tangent, offset), look: m.look.clone().addScaledVector(tangent, offset) };
  }

  session(id: string | null, cwd: string) {
    const r = this.robotFor(id, null);
    const name = cwd.split('/').pop() || 'agent';
    r.rename(name);
    r.onTag = () => this.hooks.focus(id);
    if (!r.current) r.setAction(`ready in ${name}`);
  }

  setFocus(session: string | null) {
    this.focused = session;
    for (const [key, r] of this.robots) r.setFocused(key === session);
    this.follow = true;
  }

  turnStarted(session: string | null, prompt: string, live: boolean) {
    const r = this.robotFor(session, null);
    r.idle = false;
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
    r.say(text.length > 140 ? '…' + text.slice(-140) : text, 'say', 6);
  }

  toolCall(info: ToolCallInfo, live: boolean) {
    const paths = info.paths.map((p) => this.rel(p)).filter((p): p is string => p !== null);
    const file = paths[0] ?? null;
    if (file && info.kind === 'write' && this.city?.addFile(file)) this.hooks.files(this.city.count);
    if (!live) {
      if (info.kind === 'edit' || info.kind === 'write') for (const p of paths) this.city?.edited(p, false);
      return;
    }
    const r = this.robotFor(info.session, info.parent);
    r.idle = false;
    r.queue.push({
      callId: info.callId,
      kind: info.kind,
      station: POSE[info.kind] as Task['station'],
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
      const p = this.marks.get('portal')!;
      helper.flyTo(p.group.position.clone(), p.look, 'door');
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
    const holo = this.holos.find((h) => h.task === task);
    if (holo && task.kind === 'read') this.paintRead(holo.screen, task);
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
  }

  sessionEnded(session: string | null) {
    const r = this.robots.get(session ?? 'main');
    if (!r) return;
    r.idle = true;
    r.setAction('session ended');
  }

  setWaiting(session: string | null, tool: string | null, waiting: boolean) {
    this.waiting = waiting;
    const r = this.robotFor(session, null);
    r.asking = waiting;
    if (waiting) r.say(`may I use ${tool ?? 'this'}?`, 'ask', 600);
    else r.hush();
  }

  compaction(session: string | null) {
    const r = this.robotFor(session, null);
    r.say('tidying up my notes', 'note', 3);
    this.sparks.ring(r.pos.clone().setY(r.pos.y + 1), new THREE.Color('#ffffff'), 80, 6);
  }

  reset() {
    for (const r of this.robots.values()) r.dispose();
    this.robots.clear();
    this.slots = 0;
    for (const h of this.holos) h.screen.mesh.removeFromParent();
    this.holos = [];
    for (const b of this.beams) b.mesh.removeFromParent();
    this.beams = [];
    for (const k of this.kits) k.group.removeFromParent();
    this.kits = [];
    this.city?.resetActivity();
    this.waiting = false;
    this.placeholder();
    this.termScreen.lines('zsh', [{ text: '$ _', color: '#9dff8a' }]);
  }

  // ---------------------------------------------------------------- task lifecycle

  private begin(r: Robot, t: Task) {
    r.current = t;
    r.setAction(t.label, t.kind);
    const site = t.file ? this.city?.site(t.file) : null;
    if (site && (t.kind === 'read' || t.kind === 'edit' || t.kind === 'write')) {
      // Hover beside the building, a little above half its height, facing its wall.
      const y = Math.min(Math.max(site.height * 0.55, 0.4), 6);
      const toward = new THREE.Vector3().subVectors(this.camera.position, site.base).setY(0).normalize();
      const at = site.base.clone().addScaledVector(toward, site.foot / 2 + 0.9);
      at.y = y;
      r.flyTo(at, site.base.clone().setY(y), t.station);
      return;
    }
    if (t.kind === 'search') {
      const dir = this.rel(typeof t.input?.path === 'string' ? t.input.path : '') ?? '';
      const centre = this.city?.district(dir.split('/')[0] || '·') ?? new THREE.Vector3();
      r.flyTo(centre.clone().setY(5.5), centre, t.station);
      return;
    }
    const mark = LANDMARK_FOR[t.kind];
    if (mark) {
      const spot = this.markSpot(mark, r);
      r.flyTo(spot.stand, spot.look, t.station);
      return;
    }
    // Anything else is done where the robot already is.
    r.flyTo(r.pos.clone(), r.pos.clone().add(new THREE.Vector3(0, 0, 1)), t.station);
  }

  private arrive(r: Robot, t: Task) {
    const color = KIND_COLOR[t.kind];
    switch (t.kind) {
      case 'read':
      case 'edit':
      case 'write': {
        if (!t.file || !this.city?.has(t.file)) break;
        this.city.touch(t.file, color, 1.5);
        const site = this.city.site(t.file)!;
        const screen = this.holo(site.base.clone().setY(site.height + 2.2), t);
        if (t.kind === 'read') this.paintRead(screen, t);
        else this.paintEdit(screen, t);
        this.beam(r, t, site.base.clone().setY(Math.min(site.height * 0.55, 6)), color);
        this.deploy(r, t, site.base);
        break;
      }
      case 'search': {
        const dir = this.rel(typeof t.input?.path === 'string' ? t.input.path : '') ?? '';
        let n = 0;
        for (const f of this.city?.paths() ?? []) {
          if (dir && !f.startsWith(dir.replace(/\/$/, '') + '/')) continue;
          this.city!.touch(f, color, 0.8);
          if (++n > 60) break;
        }
        this.coneFor = t;
        this.deploy(r, t, r.pos.clone().add(new THREE.Vector3(0, 0, 1)));
        break;
      }
      case 'shell': {
        const cmd = typeof t.input?.command === 'string' ? t.input.command.split('\n')[0] : '';
        this.termScreen.lines('zsh', [{ text: `$ ${cmd}`, color: '#9dff8a' }, { text: '…', color: '#7f8aa0' }]);
        break;
      }
      case 'agent':
        this.portalFlash();
        break;
    }
    this.sparks.burst(r.pos.clone().setY(r.pos.y + 1.1), new THREE.Color(color), 16, 2.5, 0.8, 0.22);
  }

  private finish(r: Robot, t: Task) {
    if (t.kind === 'shell') {
      const cmd = typeof t.input?.command === 'string' ? t.input.command.split('\n')[0] : '';
      const out = t.summary.split('\n').filter((l) => l.trim()).slice(-8);
      this.termScreen.lines(t.ok ? 'zsh · ok' : 'zsh · failed', [{ text: `$ ${cmd}`, color: '#9dff8a' }, ...out.map((l) => ({ text: l, color: t.ok ? '#cfe6f0' : '#ff9a9a' }))], t.ok ? '#04121a' : '#1e0606');
      if (t.test && t.ok) this.confetti(this.marks.get('terminal')!.group.position.clone().setY(8));
    }
    if (!t.ok) {
      this.alarmT = 2.2;
      this.alarm.position.copy(r.pos).setY(r.pos.y + 3);
      r.mood = 'sad';
      if (t.file) this.city?.touch(t.file, '#ff3030', 2);
    } else {
      r.mood = 'happy';
      if (t.file && (t.kind === 'edit' || t.kind === 'write')) {
        this.city?.edited(t.file, true);
        const roof = this.city?.roof(t.file);
        if (roof) this.sparks.burst(roof, new THREE.Color(KIND_COLOR[t.kind]), 50, 3, 1.2, 0.3);
      }
    }
    setTimeout(() => {
      if (r.mood === 'happy' || r.mood === 'sad') r.mood = 'normal';
    }, 1200);
    for (const h of this.holos) if (h.task === t) h.life = 3.5;
    this.beams = this.beams.filter((b) => {
      if (b.task !== t) return true;
      b.mesh.removeFromParent();
      return false;
    });
    if (this.coneFor === t) this.coneFor = null;
    for (const k of this.kits) if (k.task === t) k.closing = true;
    r.current = null;
  }

  // ---------------------------------------------------------------- effects

  /** A floating panel above a building, showing what the agent sees or changes in it. */
  private holo(at: THREE.Vector3, task: Task): Screen {
    const screen = new Screen(4.2, 2.6, 512);
    const m = screen.mesh.material as THREE.MeshBasicMaterial;
    m.transparent = true;
    m.opacity = 0.92;
    m.side = THREE.DoubleSide;
    screen.mesh.position.copy(at);
    this.scene.add(screen.mesh);
    this.holos.push({ screen, at, life: 999, task });
    while (this.holos.length > 4) this.holos.shift()!.screen.mesh.removeFromParent();
    return screen;
  }

  private paintRead(screen: Screen, t: Task) {
    const lines = t.summary
      ? t.summary.split('\n').slice(0, 14).map((l) => ({ text: l.replace(/^\s*\d+\t/, ''), color: '#cfe6f0' }))
      : [{ text: 'reading…', color: '#7f8aa0' }];
    screen.lines(`◉ ${t.file}`, lines, '#041a24');
  }

  private paintEdit(screen: Screen, t: Task) {
    const before = typeof t.input?.old_string === 'string' ? t.input.old_string : '';
    const after = typeof t.input?.new_string === 'string' ? t.input.new_string : typeof t.input?.content === 'string' ? t.input.content : '';
    const lines: { text: string; color?: string }[] = [];
    if (before) for (const l of before.split('\n').slice(0, 6)) lines.push({ text: `- ${l}`, color: '#ff8f8f' });
    for (const l of after.split('\n').slice(0, 10)) lines.push({ text: `+ ${l}`, color: '#9dff8a' });
    screen.lines(`${t.kind === 'write' ? '✚' : '✎'} ${t.file}`, lines, '#1a1204');
  }

  private beam(r: Robot, task: Task, to: THREE.Vector3, color: string) {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.18, 1, 10, 1, true),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.scene.add(mesh);
    this.beams.push({ mesh, robot: r, task, to });
  }

  private portalFlash() {
    const p = this.marks.get('portal')!.group;
    ((p.getObjectByName('field') as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.95;
    this.sparks.burst(p.position.clone().setY(2), new THREE.Color(KIND_COLOR.agent), 80, 4, 1.3, 0.35);
  }

  private confetti(p: THREE.Vector3) {
    const colors = ['#9dff8a', '#ffe27a', '#7ad7ff', '#ff9de2', '#ffb347'];
    for (let k = 0; k < 5; k++) {
      setTimeout(() => this.sparks.burst(p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3)), new THREE.Color(colors[k]), 90, 7, 1.8, 0.4), k * 150);
    }
  }

  // ---------------------------------------------------------------- frame

  private frame() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.05);
    const now = performance.now();
    let lead: Robot | null = null;

    for (const [key, r] of this.robots) {
      r.cruise = this.cruise;
      if (!r.current && r.queue.length) this.begin(r, r.queue.shift()!);
      const t = r.current;
      if (t && r.arrived) {
        if (t.workedFor === 0) this.arrive(r, t);
        t.workedFor += dt;
        if ((t.kind === 'edit' || t.kind === 'write') && !t.done && Math.random() < 0.4) {
          this.sparks.emit(r.pos.clone().add(new THREE.Vector3(Math.sin(r.yaw) * 0.6, 0.9, Math.cos(r.yaw) * 0.6)), new THREE.Vector3().randomDirection().multiplyScalar(1.5), new THREE.Color('#ffd27a'), 0.5, 0.15, 1.5);
        }
        if (t.done && t.workedFor > 0.8 / (1 + r.queue.length * 0.5)) this.finish(r, t);
      }
      if (!r.current && !r.queue.length && r.idle && r.station !== 'lounge' && !r.leaving) {
        r.flyTo(this.parkSpot(r), this.marks.get('park')!.look, 'lounge');
        r.setAction('your turn');
      }
      const lounging = r.idle && r.station === 'lounge' && r.arrived && !r.current && !r.queue.length && !r.leaving;
      if (!lounging) r.nextMuse = Math.max(r.nextMuse, now + 12000);
      else if (now > r.nextMuse && !r.bubbleUntil) {
        r.say(MUSINGS[Math.floor(Math.random() * MUSINGS.length)], 'note', 8);
        r.nextMuse = now + 25000 + Math.random() * 20000;
      }
      if (key === this.focused || (!lead && !r.idle)) lead = r;
      r.update(dt, this.sparks);
      if (r.gone) {
        r.dispose();
        this.robots.delete(key);
      }
    }

    // The follow camera keeps its angle and distance and slides with the working robot.
    if (this.follow && lead && !lead.idle) {
      const want = lead.pos.clone().setY(Math.min(lead.pos.y, 3));
      const delta = want.sub(this.controls.target).multiplyScalar(Math.min(1, dt * 1.5));
      this.controls.target.add(delta);
      this.camera.position.add(delta);
    }

    const up = new THREE.Vector3(0, 1, 0);
    for (const b of this.beams) {
      const from = b.robot.pos.clone().add(new THREE.Vector3(0, 1.25 * b.robot.scale, 0));
      const dir = new THREE.Vector3().subVectors(b.to, from);
      const len = dir.length();
      b.mesh.position.copy(from).addScaledVector(dir, 0.5);
      b.mesh.scale.set(1, len, 1);
      b.mesh.quaternion.setFromUnitVectors(up, dir.normalize());
    }
    this.holos = this.holos.filter((h) => {
      h.life -= dt;
      h.screen.mesh.lookAt(this.camera.position);
      (h.screen.mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(0.92, Math.max(0, h.life));
      if (h.life > 0) return true;
      h.screen.mesh.removeFromParent();
      return false;
    });

    this.kits = this.kits.filter((k) => {
      k.grow = Math.max(0, Math.min(1, k.grow + (k.closing ? -dt * 2.5 : dt * 3)));
      k.group.scale.setScalar(Math.max(0.01, 1 - Math.pow(1 - k.grow, 3)));
      if (k.closing && k.grow === 0) {
        k.group.removeFromParent();
        return false;
      }
      return true;
    });
    const busy = new Set(this.kits.map((k) => k.scope));
    this.scopes = this.scopes.filter((sw) => sw.parent);
    for (const sweep of this.scopes) sweep.rotation.z -= dt * (busy.has(sweep) ? 7 : 1.5);
    const cm = this.cone.material as THREE.MeshBasicMaterial;
    if (this.coneFor) {
      const owner = [...this.robots.values()].find((r) => r.current === this.coneFor);
      if (owner) this.cone.position.copy(owner.pos).setY(owner.pos.y - 2.5);
      this.cone.rotation.y += dt;
      cm.opacity = Math.min(0.35, cm.opacity + dt);
    } else {
      cm.opacity = Math.max(0, cm.opacity - dt);
    }

    const field = this.marks.get('portal')!.group.getObjectByName('field') as THREE.Mesh;
    const fm = field.material as THREE.MeshBasicMaterial;
    fm.opacity = Math.max(0.15 + Math.sin(now / 500) * 0.05, fm.opacity - dt * 0.8);
    const dish = this.marks.get('mast')!.group.getObjectByName('dish');
    if (dish) dish.rotation.z = Math.sin(now / 1500) * 0.4;

    this.alarmT = Math.max(0, this.alarmT - dt);
    this.alarm.intensity = this.alarmT > 0 ? (Math.sin(now / 70) > 0 ? 40 : 4) : 0;

    const k = Math.min(1, dt * 3);
    this.uSat.value += ((this.waiting ? 0.35 : 1) - this.uSat.value) * k;
    this.key.intensity += ((this.waiting ? 0.5 : 2.2) - this.key.intensity) * k;
    this.hemi.intensity += ((this.waiting ? 0.3 : 1.1) - this.hemi.intensity) * k;
    this.spot.intensity += ((this.waiting ? 220 : 0) - this.spot.intensity) * k;
    for (const r of this.robots.values()) if (r.asking) this.spot.target.position.lerp(r.pos, dt * 4);
    this.spot.position.copy(this.spot.target.position).add(new THREE.Vector3(0, 14, 0));

    this.city?.frame(dt);
    this.sparks.step(dt);
    this.controls.update(dt);
    this.pipeline.render();
    this.labels.render(this.scene, this.camera);
    if ((this.labelTick = (this.labelTick + 1) % 10) === 0 && this.city) {
      const rect = this.canvas.getBoundingClientRect();
      this.city.cullLabels(this.camera, rect.width, rect.height);
    }
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = r.width;
    const h = r.height;
    this.renderer.setSize(w, h, false);
    this.labels.setSize(w, h);
    this.camera.aspect = w / Math.max(1, h);
    const panel = document.querySelector('.panel') as HTMLElement | null;
    const side = panel && getComputedStyle(panel).top === '0px';
    if (side) this.camera.setViewOffset(w, h, panel.offsetWidth / 2, 0, w, h);
    else if (panel) this.camera.setViewOffset(w, h, 0, panel.offsetHeight / 2, w, h);
    else this.camera.clearViewOffset();
    this.camera.fov = w / Math.max(1, h) < 1 ? 55 : 34;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- picking

  private ray = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  private buildingAt(e: MouseEvent): string | null {
    if (!this.city) return null;
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
      this.hooks.hover(this.buildingAt(e), e.clientX, e.clientY);
    });
  }

  private onClick(e: MouseEvent) {
    const p = this.buildingAt(e);
    if (p) this.hooks.pick(p);
  }
}
