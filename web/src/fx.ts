import * as THREE from 'three/webgpu';
import { Fn, vec4, uv, length, smoothstep, instancedDynamicBufferAttribute } from 'three/tsl';

// @types/three types these as Node<string>, which loses swizzles; the runtime type is the one passed.
const dynAttr = (a: THREE.InstancedBufferAttribute, type: string): any => instancedDynamicBufferAttribute(a, type);

const softDisc = Fn(() => {
  const d = length(uv().sub(0.5)).mul(2);
  return smoothstep(1, 0, d).pow(1.6);
});

/**
 * A bag of instanced, additive, CPU-driven sprites. Everything that moves in the scene is one of
 * these, so the whole sky is a handful of draw calls however busy the agent gets.
 */
export class SpriteLayer {
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

const TAU = Math.PI * 2;

/** Particle pool slots: position, velocity, colour, life. */
export class Sparks {
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

