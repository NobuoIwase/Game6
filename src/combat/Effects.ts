// ============================================================================
// 視覚効果：マズルフラッシュ・曳光弾・着弾・体液・殻の破片・爆発・土煙・焦げ跡・画面の揺れ。
// パーティクルはプール（使い回し）して生成コストを抑える。
// 破片・衝撃波リング・焦げ跡はシンインスタンス（1メッシュ＝1ドローコール）で描く。
// テクスチャはすべて canvas で生成（外部素材なし）。
// 量は画質の particleScale に比例。爆発の点光源は「高」2個・「中」1個・「低」なし。
// ============================================================================
import {
  Color3,
  Color4,
  Constants,
  CylinderParticleEmitter,
  DynamicTexture,
  InstancedMesh,
  Matrix,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  PBRMaterial,
  PointLight,
  Quaternion,
  Scene,
  SphereDirectedParticleEmitter,
  SphereParticleEmitter,
  StandardMaterial,
  Texture,
  Vector3,
} from "@babylonjs/core";
import { lookQuat } from "../core/MathUtil";

// ---------------------------------------------------------------- 手続き生成テクスチャ

function radialTexture(scene: Scene, name: string, stops: [number, string][], size = 128, noise = 0) {
  const t = new DynamicTexture(name, { width: size, height: size }, scene, true);
  const ctx = t.getContext() as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, c] of stops) g.addColorStop(o, c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  if (noise > 0) {
    // もこもこした煙っぽさを出すため、ランダムな円を重ねて削る
    ctx.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 40 * noise; i++) {
      const r = Math.random() * size * 0.12;
      const a = Math.random() * Math.PI * 2;
      const d = size * (0.25 + Math.random() * 0.25);
      ctx.fillStyle = `rgba(0,0,0,${0.15 + Math.random() * 0.3})`;
      ctx.beginPath();
      ctx.arc(size / 2 + Math.cos(a) * d, size / 2 + Math.sin(a) * d, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }
  t.update();
  t.hasAlpha = true;
  return t;
}

/** もくもくした煙の塊（小さな柔らかい円をたくさん重ねる） */
function puffTexture(scene: Scene, name: string, size = 128) {
  const t = new DynamicTexture(name, { width: size, height: size }, scene, true);
  const ctx = t.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, size, size);
  const c = size / 2;
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.random() * size * 0.2;
    const x = c + Math.cos(a) * d;
    const y = c + Math.sin(a) * d;
    const r = size * (0.14 + Math.random() * 0.16);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const al = 0.18 + Math.random() * 0.2;
    g.addColorStop(0, `rgba(255,255,255,${al})`);
    g.addColorStop(0.6, `rgba(255,255,255,${al * 0.5})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // 端が切れないよう外周を丸く消す
  ctx.globalCompositeOperation = "destination-in";
  const m = ctx.createRadialGradient(c, c, size * 0.3, c, c, size * 0.5);
  m.addColorStop(0, "rgba(0,0,0,1)");
  m.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = m;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = "source-over";
  t.update();
  t.hasAlpha = true;
  return t;
}

/** 地面の焦げ跡（不規則な黒い染み） */
function scorchTexture(scene: Scene, size = 128) {
  const t = new DynamicTexture("scorchTex", { width: size, height: size }, scene, true);
  const ctx = t.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, size, size);
  const c = size / 2;
  for (let i = 0; i < 30; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.random() * size * 0.28;
    const x = c + Math.cos(a) * d;
    const y = c + Math.sin(a) * d;
    const r = size * (0.08 + Math.random() * 0.14);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // 中心の濃い部分と放射状の筋
  const g = ctx.createRadialGradient(c, c, 0, c, c, size * 0.3);
  g.addColorStop(0, "rgba(255,255,255,0.8)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2;
    ctx.lineWidth = 1 + Math.random() * 3;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * size * 0.1, c + Math.sin(a) * size * 0.1);
    ctx.lineTo(c + Math.cos(a) * size * (0.3 + Math.random() * 0.18), c + Math.sin(a) * size * (0.3 + Math.random() * 0.18));
    ctx.stroke();
  }
  t.update();
  t.hasAlpha = true;
  return t;
}

// ---------------------------------------------------------------- パーティクルのプール

type Grad = [number, number, number?][];
type ColorGrad = [number, Color4][];

interface PoolConfig {
  capacity: number;
  texture: Texture;
  blend: number;
  color1: Color4;
  color2: Color4;
  colorDead: Color4;
  minSize: number;
  maxSize: number;
  minLife: number;
  maxLife: number;
  minPower: number;
  maxPower: number;
  gravity: number;
  /** 旧形式の大きさ変化（0.4 → sizeGrow 倍。この場合 min/maxSize は無視される） */
  sizeGrow?: number;
  /** 一定の抵抗（毎フレームの移動量に掛かる） */
  drag?: number;
  /** 寿命に対する大きさの変化 [比率, 値, 値2?]。指定時は min/maxSize は無視され、値 × emit の size が実寸 */
  sizes?: Grad;
  /** 寿命に対する抵抗の変化（0 で抵抗なし。最初速く・後で止まる動きに使う） */
  drags?: Grad;
  /** 寿命に対する色の変化（指定時は color1/2/Dead は無視） */
  colors?: ColorGrad;
  /** 速度方向に引き伸ばす（火花・飛沫） */
  stretched?: boolean;
  spin?: number;
}

interface EmitOpts {
  radius?: number;
  dir?: Vector3;
  spread?: number;
  size?: number;
  power?: number;
  /** 縦（速度方向）の伸び倍率（stretched の時） */
  stretch?: number;
  /** 水平に広がる輪（地面の衝撃波の砂煙） */
  ring?: boolean;
  /** 色の上書き（colors グラデーションを使わないプールのみ） */
  c1?: Color4;
  c2?: Color4;
  cDead?: Color4;
}

interface PoolSys {
  ps: ParticleSystem;
  sphere: SphereParticleEmitter;
  directed: SphereDirectedParticleEmitter;
  ring: CylinderParticleEmitter;
}

/** 使い回すパーティクルシステムの束 */
class BurstPool {
  private systems: PoolSys[] = [];
  private i = 0;
  constructor(scene: Scene, name: string, count: number, private cfg: PoolConfig) {
    for (let k = 0; k < count; k++) {
      const ps = new ParticleSystem(`${name}${k}`, cfg.capacity, scene);
      ps.particleTexture = cfg.texture;
      ps.blendMode = cfg.blend;
      ps.color1 = cfg.color1.clone();
      ps.color2 = cfg.color2.clone();
      ps.colorDead = cfg.colorDead.clone();
      ps.minSize = cfg.minSize;
      ps.maxSize = cfg.maxSize;
      ps.minLifeTime = cfg.minLife;
      ps.maxLifeTime = cfg.maxLife;
      ps.minEmitPower = cfg.minPower;
      ps.maxEmitPower = cfg.maxPower;
      ps.gravity = new Vector3(0, cfg.gravity, 0);
      ps.emitRate = 0;
      ps.manualEmitCount = 0;
      const spin = cfg.spin ?? 1.5;
      ps.minAngularSpeed = -spin;
      ps.maxAngularSpeed = spin;
      ps.minInitialRotation = 0;
      ps.maxInitialRotation = Math.PI * 2;
      ps.updateSpeed = 1 / 60;
      if (cfg.sizes) for (const [r, a, b] of cfg.sizes) ps.addSizeGradient(r, a, b);
      else if (cfg.sizeGrow) {
        ps.addSizeGradient(0, 0.4);
        ps.addSizeGradient(1, cfg.sizeGrow);
      }
      if (cfg.drags) for (const [r, a, b] of cfg.drags) ps.addDragGradient(r, a, b);
      else if (cfg.drag) ps.addDragGradient(0, cfg.drag);
      if (cfg.colors) for (const [r, c] of cfg.colors) ps.addColorGradient(r, c);
      if (cfg.stretched) ps.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
      const sphere = new SphereParticleEmitter(0.5);
      const directed = new SphereDirectedParticleEmitter(0.2, new Vector3(), new Vector3());
      const ring = new CylinderParticleEmitter(1, 0.3, 0.15, 0.25);
      ps.particleEmitterType = sphere;
      ps.emitter = new Vector3();
      ps.start();
      this.systems.push({ ps, sphere, directed, ring });
    }
  }

  emit(pos: Vector3, count: number, opts?: EmitOpts) {
    // 同じフレーム内でまだ放出していないシステムは飛ばす（ショットガン等で上書きされないように）
    let sys = this.systems[this.i];
    for (let k = 0; k < this.systems.length && sys.ps.manualEmitCount > 0; k++) {
      this.i = (this.i + 1) % this.systems.length;
      sys = this.systems[this.i];
    }
    this.i = (this.i + 1) % this.systems.length;
    this.emitTo(sys, pos, count, opts);
  }

  /** 番号指定で放出（煙柱のように同じシステムへ少しずつ出し続ける用） */
  emitAt(index: number, pos: Vector3, count: number, opts?: EmitOpts) {
    this.emitTo(this.systems[index % this.systems.length], pos, count, opts);
  }

  get size() {
    return this.systems.length;
  }

  private emitTo(sys: PoolSys, pos: Vector3, count: number, opts?: EmitOpts) {
    const ps = sys.ps;
    const cfg = this.cfg;
    (ps.emitter as Vector3).copyFrom(pos);
    if (opts?.ring) {
      sys.ring.radius = Math.max(0.1, opts.radius ?? 1);
      ps.particleEmitterType = sys.ring;
    } else if (opts?.dir) {
      const d = opts.dir;
      const s = opts.spread ?? 0.5;
      sys.directed.radius = opts.radius ?? 0.2;
      sys.directed.direction1.set(d.x - s, d.y - s, d.z - s);
      sys.directed.direction2.set(d.x + s, d.y + s, d.z + s);
      ps.particleEmitterType = sys.directed;
    } else {
      sys.sphere.radius = opts?.radius ?? 0.5;
      ps.particleEmitterType = sys.sphere;
    }
    const size = opts?.size ?? 1;
    const st = opts?.stretch ?? 1;
    ps.minScaleX = size * 0.7;
    ps.maxScaleX = size;
    ps.minScaleY = size * 0.7 * st;
    ps.maxScaleY = size * st;
    if (opts?.power) {
      ps.minEmitPower = opts.power * 0.4;
      ps.maxEmitPower = opts.power;
    } else {
      ps.minEmitPower = cfg.minPower;
      ps.maxEmitPower = cfg.maxPower;
    }
    if (!cfg.colors) {
      ps.color1.copyFrom(opts?.c1 ?? cfg.color1);
      ps.color2.copyFrom(opts?.c2 ?? cfg.color2);
      ps.colorDead.copyFrom(opts?.cDead ?? cfg.colorDead);
    }
    // 容量を超える分は出しても捨てられるので丸める
    ps.manualEmitCount = Math.min(cfg.capacity, ps.manualEmitCount + Math.max(1, Math.round(count)));
  }
}

// ---------------------------------------------------------------- 破片（シンインスタンス）

/**
 * 重力で飛んで地面で跳ねる小さな破片。1つのメッシュのシンインスタンスで描く（ドローコール1）。
 * 色はインスタンスごとに指定できる（敵の殻の色・コンクリート・焦げた瓦礫）。
 */
class ChipPool {
  readonly mesh: Mesh;
  private n: number;
  private mat: Float32Array;
  private col: Float32Array;
  private pos: Float32Array;
  private vel: Float32Array;
  private scl: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private floor: Float32Array;
  private spin: Float32Array;
  private rot: Quaternion[] = [];
  private axis: Vector3[] = [];
  private next = 0;
  private active = 0;
  private colDirty = false;
  private tmpM = new Matrix();
  private tmpS = new Vector3();
  private tmpP = new Vector3();
  private tmpQ = new Quaternion();

  constructor(scene: Scene, capacity: number) {
    const n = (this.n = capacity);
    // 八面体を不揃いに拡大して角ばった欠片に見せる
    const mesh = MeshBuilder.CreatePolyhedron("chips", { type: 1, size: 0.5 }, scene);
    const mat = new PBRMaterial("chipMat", scene);
    mat.albedoColor = new Color3(1, 1, 1);
    mat.metallic = 0.25;
    mat.roughness = 0.55;
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    this.mat = new Float32Array(n * 16);
    this.col = new Float32Array(n * 4).fill(1);
    mesh.thinInstanceSetBuffer("matrix", this.mat, 16, false);
    mesh.thinInstanceSetBuffer("color", this.col, 4, false);
    mesh.isVisible = false;
    this.mesh = mesh;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.scl = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.floor = new Float32Array(n);
    this.spin = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.rot.push(new Quaternion());
      this.axis.push(new Vector3(0, 1, 0));
    }
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, color: Color3, floorY: number, shade = 0.25) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    if (this.life[i] <= 0) this.active++;
    const i3 = i * 3;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    // 薄い板・細長い欠片などを混ぜる
    this.scl[i3] = size * (0.5 + Math.random() * 0.8);
    this.scl[i3 + 1] = size * (0.25 + Math.random() * 0.5);
    this.scl[i3 + 2] = size * (0.5 + Math.random() * 0.9);
    this.life[i] = this.maxLife[i] = life;
    this.floor[i] = floorY;
    this.spin[i] = 4 + Math.random() * 14;
    this.axis[i].set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    Quaternion.RotationYawPitchRollToRef(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28, this.rot[i]);
    const v = 1 - shade + Math.random() * shade * 2; // 明暗のばらつき
    const i4 = i * 4;
    this.col[i4] = color.r * v;
    this.col[i4 + 1] = color.g * v;
    this.col[i4 + 2] = color.b * v;
    this.col[i4 + 3] = 1;
    this.colDirty = true;
    this.mesh.isVisible = true;
  }

  update(dt: number) {
    if (this.active <= 0) return;
    const g = -18;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const o = i * 16;
      if (this.life[i] <= 0) {
        this.mat.fill(0, o, o + 16);
        this.active--;
        continue;
      }
      const i3 = i * 3;
      let vy = this.vel[i3 + 1];
      let y = this.pos[i3 + 1];
      const fl = this.floor[i];
      const resting = y <= fl + 0.001 && Math.abs(vy) < 0.01;
      if (!resting) {
        vy += g * dt;
        this.pos[i3] += this.vel[i3] * dt;
        this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
        y += vy * dt;
        if (y < fl) {
          // 地面で跳ねる（だんだん弱く）
          y = fl;
          vy = vy < -2.5 ? -vy * 0.35 : 0;
          this.vel[i3] *= 0.55;
          this.vel[i3 + 2] *= 0.55;
          this.spin[i] *= 0.5;
        }
        this.vel[i3 + 1] = vy;
        this.pos[i3 + 1] = y;
        if (this.spin[i] > 0.05) {
          Quaternion.RotationAxisToRef(this.axis[i], this.spin[i] * dt, this.tmpQ);
          this.rot[i].multiplyInPlace(this.tmpQ);
        }
      }
      // 寿命の最後の 30% で縮んで消える
      const k = Math.min(1, this.life[i] / (this.maxLife[i] * 0.3));
      this.tmpS.set(this.scl[i3] * k, this.scl[i3 + 1] * k, this.scl[i3 + 2] * k);
      this.tmpP.set(this.pos[i3], this.pos[i3 + 1] + this.scl[i3 + 1] * 0.25 * k, this.pos[i3 + 2]);
      Matrix.ComposeToRef(this.tmpS, this.rot[i], this.tmpP, this.tmpM);
      this.tmpM.copyToArray(this.mat, o);
    }
    this.mesh.thinInstanceBufferUpdated("matrix");
    if (this.colDirty) {
      this.mesh.thinInstanceBufferUpdated("color");
      this.colDirty = false;
    }
    if (this.active <= 0) {
      this.active = 0;
      this.mesh.isVisible = false;
    }
  }
}

// ---------------------------------------------------------------- 地面に貼る平面（衝撃波リング・焦げ跡）

/** 地面に水平に置く板のシンインスタンス。大きさの変化とフェードだけ行う */
class FlatPool {
  readonly mesh: Mesh;
  private n: number;
  private mat: Float32Array;
  private col: Float32Array;
  private t: Float32Array;
  private life: Float32Array;
  private hold: Float32Array;
  private p: Float32Array; // x, y, z, size0, size1, rotY, alpha
  private rgb: Float32Array;
  private next = 0;
  private active = 0;
  private tmpM = new Matrix();
  private tmpS = new Vector3();
  private tmpP = new Vector3();
  private tmpQ = new Quaternion();

  constructor(scene: Scene, name: string, capacity: number, material: StandardMaterial) {
    const n = (this.n = capacity);
    const mesh = MeshBuilder.CreateGround(name, { width: 1, height: 1 }, scene);
    mesh.material = material;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    this.mat = new Float32Array(n * 16);
    this.col = new Float32Array(n * 4);
    mesh.thinInstanceSetBuffer("matrix", this.mat, 16, false);
    mesh.thinInstanceSetBuffer("color", this.col, 4, false);
    mesh.isVisible = false;
    this.mesh = mesh;
    this.t = new Float32Array(n);
    this.life = new Float32Array(n);
    this.hold = new Float32Array(n);
    this.p = new Float32Array(n * 7);
    this.rgb = new Float32Array(n * 3);
  }

  /** hold: 寿命のうち不透明のまま保つ割合 */
  spawn(x: number, y: number, z: number, size0: number, size1: number, life: number, r: number, g: number, b: number, a: number, hold = 0) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    if (this.life[i] <= 0) this.active++;
    this.t[i] = 0;
    this.life[i] = life;
    this.hold[i] = hold;
    const o = i * 7;
    this.p[o] = x;
    this.p[o + 1] = y;
    this.p[o + 2] = z;
    this.p[o + 3] = size0;
    this.p[o + 4] = size1;
    this.p[o + 5] = Math.random() * Math.PI * 2;
    this.p[o + 6] = a;
    this.rgb[i * 3] = r;
    this.rgb[i * 3 + 1] = g;
    this.rgb[i * 3 + 2] = b;
    this.mesh.isVisible = true;
  }

  update(dt: number) {
    if (this.active <= 0) return;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      this.t[i] += dt;
      const k = this.t[i] / this.life[i];
      if (k >= 1) {
        this.life[i] = 0;
        this.mat.fill(0, i * 16, i * 16 + 16);
        this.col[i * 4 + 3] = 0;
        this.active--;
        continue;
      }
      const o = i * 7;
      // 広がりは最初速く後で遅く
      const e = 1 - (1 - k) * (1 - k) * (1 - k);
      const s = this.p[o + 3] + (this.p[o + 4] - this.p[o + 3]) * e;
      const h = this.hold[i];
      const fade = k < h ? 1 : 1 - (k - h) / (1 - h);
      this.tmpS.set(s, 1, s);
      this.tmpP.set(this.p[o], this.p[o + 1], this.p[o + 2]);
      Quaternion.RotationYawPitchRollToRef(this.p[o + 5], 0, 0, this.tmpQ);
      Matrix.ComposeToRef(this.tmpS, this.tmpQ, this.tmpP, this.tmpM);
      this.tmpM.copyToArray(this.mat, i * 16);
      const c = i * 4;
      this.col[c] = this.rgb[i * 3];
      this.col[c + 1] = this.rgb[i * 3 + 1];
      this.col[c + 2] = this.rgb[i * 3 + 2];
      this.col[c + 3] = this.p[o + 6] * fade;
    }
    this.mesh.thinInstanceBufferUpdated("matrix");
    this.mesh.thinInstanceBufferUpdated("color");
    if (this.active <= 0) {
      this.active = 0;
      this.mesh.isVisible = false;
    }
  }
}

// ---------------------------------------------------------------- 本体

interface Tracer {
  mesh: InstancedMesh;
  from: Vector3;
  dir: Vector3;
  dist: number;
  travelled: number;
  speed: number;
  len: number;
  active: boolean;
}

interface Flash {
  light: PointLight;
  life: number;
  dur: number;
  max: number;
}

/** 爆発後しばらく煙を出し続ける煙柱 */
interface Plume {
  pos: Vector3;
  t: number;
  dur: number;
  acc: number;
  size: number;
  power: number;
}

/** 敵の種類ごとの殻の色と体液の色 */
const SHELL: Record<string, Color3> = {
  ant: new Color3(0.09, 0.08, 0.1),
  spider: new Color3(0.72, 0.68, 0.6),
  flyer: new Color3(0.2, 0.21, 0.23),
  carrier: new Color3(0.16, 0.17, 0.19),
  colossus: new Color3(0.1, 0.11, 0.13),
};
const ANT_ACCENT = new Color3(0.3, 0.05, 0.04);
const FLUID: Record<string, [Color4, Color4]> = {
  // 巨大生物の体液（蟻型は黄緑・蜘蛛型は紫）
  ant: [new Color4(0.8, 0.95, 0.12, 1), new Color4(0.55, 0.75, 0.05, 0.95)],
  spider: [new Color4(0.62, 0.2, 0.78, 1), new Color4(0.42, 0.1, 0.52, 0.95)],
};
const CONCRETE = new Color3(0.55, 0.53, 0.5);
const DEBRIS_COLORS = [new Color3(0.12, 0.11, 0.1), new Color3(0.3, 0.29, 0.27), new Color3(0.5, 0.48, 0.45), new Color3(0.22, 0.16, 0.12)];

export class Effects {
  private flare: BurstPool;
  private shock: BurstPool;
  private fire: BurstPool;
  private smoke: BurstPool;
  private plumeSmoke: BurstPool;
  private sparks: BurstPool;
  private embers: BurstPool;
  private dust: BurstPool;
  private dustRing: BurstPool;
  private droplets: BurstPool;
  private mist: BurstPool;
  private metal: BurstPool;
  private muzzle: BurstPool;
  private trailSmoke: BurstPool;
  private chips: ChipPool;
  private rings: FlatPool;
  private scorches: FlatPool;
  private plumes: (Plume | null)[] = [];
  private plumeNext = 0;
  private tracers: Tracer[] = [];
  private tracerTemplates: Record<string, Mesh> = {};
  private flashes: Flash[] = [];
  // 使い回す一時ベクトル（毎フレーム・毎発の new を避ける）
  private tv1 = new Vector3();
  private tv2 = new Vector3();
  private tc1 = new Color4();
  private tc2 = new Color4();
  private tc3 = new Color4();
  shake = 0;

  constructor(
    scene: Scene,
    private particleScale: number,
  ) {
    const soft = radialTexture(scene, "softTex", [
      [0, "rgba(255,255,255,1)"],
      [0.4, "rgba(255,255,255,0.6)"],
      [1, "rgba(255,255,255,0)"],
    ]);
    const smokeTex = radialTexture(
      scene,
      "smokeTex",
      [
        [0, "rgba(255,255,255,0.9)"],
        [0.5, "rgba(255,255,255,0.5)"],
        [1, "rgba(255,255,255,0)"],
      ],
      128,
      1,
    );
    const puff = puffTexture(scene, "puffTex");
    const spark = radialTexture(
      scene,
      "sparkTex",
      [
        [0, "rgba(255,255,255,1)"],
        [0.2, "rgba(255,240,200,1)"],
        [1, "rgba(255,200,100,0)"],
      ],
      32,
    );
    const flareTex = radialTexture(scene, "flareTex", [
      [0, "rgba(255,255,255,1)"],
      [0.12, "rgba(255,250,230,1)"],
      [0.35, "rgba(255,200,120,0.45)"],
      [1, "rgba(255,150,60,0)"],
    ]);
    const ringTex = radialTexture(scene, "ringTex", [
      [0, "rgba(255,255,255,0)"],
      [0.6, "rgba(255,255,255,0)"],
      [0.85, "rgba(255,255,255,0.35)"],
      [0.94, "rgba(255,255,255,0.9)"],
      [1, "rgba(255,255,255,0)"],
    ]);
    const ps = particleScale;
    const n = (c: number) => Math.max(4, Math.round(c * ps));
    const ADD = ParticleSystem.BLENDMODE_ADD;
    const STD = ParticleSystem.BLENDMODE_STANDARD;
    const C = (r: number, g: number, b: number, a: number) => new Color4(r, g, b, a);
    const fadeDead = C(0, 0, 0, 0);

    // 描画順は作成順になるので、暗い煙を先・明るい炎を後に作る
    // 爆発の煙（黒い煙。炎が消える頃に見え始めて灰色に薄まる）
    const smokeColors: ColorGrad = [
      [0, C(0.09, 0.08, 0.07, 0)],
      [0.1, C(0.1, 0.09, 0.08, 0.85)],
      [0.45, C(0.2, 0.19, 0.18, 0.6)],
      [1, C(0.36, 0.35, 0.34, 0)],
    ];
    this.smoke = new BurstPool(scene, "smoke", 6, {
      capacity: n(50),
      texture: puff,
      blend: STD,
      color1: C(0.32, 0.3, 0.28, 0.75),
      color2: C(0.18, 0.17, 0.16, 0.7),
      colorDead: C(0.25, 0.25, 0.25, 0),
      minSize: 1,
      maxSize: 1,
      minLife: 2.2,
      maxLife: 4.2,
      minPower: 1,
      maxPower: 6,
      gravity: 1.6,
      sizes: [
        [0, 0.5, 0.8],
        [0.3, 1.2, 1.5],
        [1, 2.2, 2.8],
      ],
      drags: [
        [0, 0],
        [0.15, 0.85],
        [1, 0.9],
      ],
      colors: smokeColors,
      spin: 0.5,
    });
    // 煙柱（爆発後しばらく立ち上り続ける）
    this.plumeSmoke = new BurstPool(scene, "plume", 4, {
      capacity: n(60),
      texture: puff,
      blend: STD,
      color1: C(1, 1, 1, 1),
      color2: C(1, 1, 1, 1),
      colorDead: fadeDead,
      minSize: 1,
      maxSize: 1,
      minLife: 3,
      maxLife: 5.5,
      minPower: 2,
      maxPower: 5,
      gravity: 2.2,
      sizes: [
        [0, 0.6, 0.9],
        [1, 2.4, 3.2],
      ],
      drags: [
        [0, 0.2],
        [1, 0.75],
      ],
      colors: [
        [0, C(0.07, 0.065, 0.06, 0)],
        [0.08, C(0.08, 0.075, 0.07, 0.9)],
        [0.5, C(0.16, 0.15, 0.14, 0.6)],
        [1, C(0.32, 0.31, 0.3, 0)],
      ],
      spin: 0.4,
    });
    // 汎用の土煙（着弾・着地・倒壊）
    this.dust = new BurstPool(scene, "dust", 8, {
      capacity: n(120),
      texture: smokeTex,
      blend: STD,
      color1: C(0.62, 0.58, 0.52, 0.6),
      color2: C(0.5, 0.47, 0.42, 0.55),
      colorDead: C(0.5, 0.5, 0.5, 0),
      minSize: 0.6,
      maxSize: 2,
      minLife: 0.6,
      maxLife: 3,
      minPower: 1,
      maxPower: 5,
      gravity: -0.5,
      sizeGrow: 3,
      drag: 0.6,
    });
    // 地面を水平に走る砂煙の輪
    this.dustRing = new BurstPool(scene, "dustRing", 4, {
      capacity: n(48),
      texture: puff,
      blend: STD,
      color1: C(0.68, 0.63, 0.55, 0.85),
      color2: C(0.55, 0.5, 0.43, 0.8),
      colorDead: C(0.6, 0.57, 0.52, 0),
      minSize: 1,
      maxSize: 1,
      minLife: 0.9,
      maxLife: 2.0,
      minPower: 10,
      maxPower: 20,
      gravity: 0.6,
      sizes: [
        [0, 0.4, 0.6],
        [1, 1.5, 2.0],
      ],
      drags: [
        [0, 0],
        [0.12, 0.88],
        [1, 0.97],
      ],
      spin: 0.6,
    });
    // 体液のもや（飛沫と一緒に一瞬広がる）
    this.mist = new BurstPool(scene, "mist", 6, {
      capacity: n(16),
      texture: puff,
      blend: STD,
      color1: C(1, 1, 1, 0.6),
      color2: C(1, 1, 1, 0.5),
      colorDead: fadeDead,
      minSize: 1,
      maxSize: 1,
      minLife: 0.35,
      maxLife: 0.7,
      minPower: 1,
      maxPower: 4,
      gravity: -1.5,
      sizes: [
        [0, 0.5],
        [1, 1.6],
      ],
      drags: [
        [0, 0],
        [0.2, 0.85],
      ],
    });
    // 体液の飛沫（速度方向に伸びる滴。色は敵ごとに上書き）
    this.droplets = new BurstPool(scene, "droplets", 10, {
      capacity: n(60),
      texture: soft,
      blend: STD,
      color1: FLUID.ant[0],
      color2: FLUID.ant[1],
      colorDead: C(0.3, 0.35, 0.02, 0),
      minSize: 0.18,
      maxSize: 0.45,
      minLife: 0.45,
      maxLife: 1.1,
      minPower: 5,
      maxPower: 14,
      gravity: -20,
      stretched: true,
    });
    // ミサイルの煙の尾
    this.trailSmoke = new BurstPool(scene, "trail", 4, {
      capacity: n(300),
      texture: smokeTex,
      blend: STD,
      color1: C(0.85, 0.85, 0.85, 0.55),
      color2: C(0.7, 0.7, 0.7, 0.45),
      colorDead: C(0.6, 0.6, 0.6, 0),
      minSize: 0.5,
      maxSize: 1,
      minLife: 0.8,
      maxLife: 1.6,
      minPower: 0.1,
      maxPower: 0.6,
      gravity: 0.6,
      sizeGrow: 3,
    });
    // 火球（白黄 → 橙 → 暗い赤 → 消える）。最初速く膨らみ、すぐに止まる
    this.fire = new BurstPool(scene, "fire", 6, {
      capacity: n(50),
      texture: puff,
      blend: ADD,
      color1: C(1, 1, 1, 1),
      color2: C(1, 1, 1, 1),
      colorDead: fadeDead,
      minSize: 1,
      maxSize: 1,
      minLife: 0.55,
      maxLife: 1.0,
      minPower: 4,
      maxPower: 14,
      gravity: 2.5,
      sizes: [
        [0, 0.45, 0.7],
        [0.25, 1.0, 1.2],
        [1, 1.35, 1.6],
      ],
      drags: [
        [0, 0],
        [0.12, 0.85],
        [1, 0.93],
      ],
      colors: [
        [0, C(1, 0.95, 0.75, 1)],
        [0.12, C(1, 0.72, 0.28, 1)],
        [0.35, C(0.95, 0.38, 0.08, 0.9)],
        [0.65, C(0.5, 0.1, 0.02, 0.55)],
        [1, C(0.08, 0.02, 0.01, 0)],
      ],
      spin: 0.8,
    });
    // 閃光（ごく短い明るい光の玉）
    this.flare = new BurstPool(scene, "flare", 4, {
      capacity: 4,
      texture: flareTex,
      blend: ADD,
      color1: C(1, 0.95, 0.85, 1),
      color2: C(1, 0.9, 0.7, 1),
      colorDead: C(1, 0.5, 0.1, 0),
      minSize: 1,
      maxSize: 1,
      minLife: 0.1,
      maxLife: 0.16,
      minPower: 0,
      maxPower: 0,
      gravity: 0,
      sizes: [
        [0, 0.7],
        [0.3, 1.0],
        [1, 1.1],
      ],
      spin: 0,
    });
    // 空中に広がる衝撃波の輪（カメラを向く板）
    this.shock = new BurstPool(scene, "shock", 3, {
      capacity: 2,
      texture: ringTex,
      blend: ADD,
      color1: C(1, 0.85, 0.65, 0.7),
      color2: C(1, 0.85, 0.65, 0.7),
      colorDead: C(0.6, 0.4, 0.2, 0),
      minSize: 1,
      maxSize: 1,
      minLife: 0.22,
      maxLife: 0.26,
      minPower: 0,
      maxPower: 0,
      gravity: 0,
      sizes: [
        [0, 0.15],
        [1, 1],
      ],
      spin: 0,
    });
    this.sparks = new BurstPool(scene, "sparks", 8, {
      capacity: n(60),
      texture: spark,
      blend: ADD,
      color1: C(1, 0.95, 0.7, 1),
      color2: C(1, 0.65, 0.25, 1),
      colorDead: C(0.5, 0.1, 0, 0),
      minSize: 0.07,
      maxSize: 0.18,
      minLife: 0.18,
      maxLife: 0.6,
      minPower: 6,
      maxPower: 25,
      gravity: -15,
      stretched: true,
    });
    // 燃えながら落ちる火の粉
    this.embers = new BurstPool(scene, "embers", 4, {
      capacity: n(40),
      texture: spark,
      blend: ADD,
      color1: C(1, 0.7, 0.3, 1),
      color2: C(1, 0.45, 0.1, 1),
      colorDead: C(0.4, 0.05, 0, 0),
      minSize: 0.12,
      maxSize: 0.3,
      minLife: 1.0,
      maxLife: 2.4,
      minPower: 8,
      maxPower: 22,
      gravity: -9,
      stretched: true,
      drags: [
        [0, 0],
        [1, 0.4],
      ],
    });
    this.metal = new BurstPool(scene, "metal", 6, {
      capacity: n(40),
      texture: spark,
      blend: ADD,
      color1: C(0.6, 0.85, 1, 1),
      color2: C(1, 1, 1, 1),
      colorDead: C(0, 0.2, 0.5, 0),
      minSize: 0.08,
      maxSize: 0.25,
      minLife: 0.15,
      maxLife: 0.5,
      minPower: 8,
      maxPower: 22,
      gravity: -10,
      stretched: true,
    });
    this.muzzle = new BurstPool(scene, "muzzle", 3, {
      capacity: 12,
      texture: soft,
      blend: ADD,
      color1: C(1, 0.85, 0.5, 1),
      color2: C(1, 0.6, 0.25, 1),
      colorDead: C(1, 0.3, 0, 0),
      minSize: 0.25,
      maxSize: 0.6,
      minLife: 0.03,
      maxLife: 0.06,
      minPower: 0.5,
      maxPower: 3,
      gravity: 0,
    });

    // 破片・地面の板
    this.chips = new ChipPool(scene, Math.max(48, Math.round(180 * ps)));
    const ringMat = new StandardMaterial("ringMat", scene);
    ringMat.disableLighting = true;
    ringMat.diffuseColor = new Color3(1, 1, 1);
    ringMat.emissiveColor = new Color3(0, 0, 0);
    ringMat.opacityTexture = ringTex;
    ringMat.alphaMode = Constants.ALPHA_ADD;
    ringMat.disableDepthWrite = true;
    ringMat.backFaceCulling = false;
    ringMat.zOffset = -3;
    ringMat.fogEnabled = false;
    this.rings = new FlatPool(scene, "shockRings", 8, ringMat);
    const scorchMat = new StandardMaterial("scorchMat", scene);
    scorchMat.disableLighting = true;
    scorchMat.diffuseColor = new Color3(1, 1, 1);
    scorchMat.emissiveColor = new Color3(0, 0, 0);
    scorchMat.opacityTexture = scorchTexture(scene);
    scorchMat.disableDepthWrite = true;
    scorchMat.zOffset = -2;
    this.scorches = new FlatPool(scene, "scorches", ps < 0.6 ? 6 : 12, scorchMat);
    for (let i = 0; i < this.plumeSmoke.size; i++) this.plumes.push(null);

    // 曳光弾
    const mk = (name: string, color: Color3, w: number) => {
      const m = MeshBuilder.CreateBox(name, { width: w, height: w, depth: 1 }, scene);
      const mat = new StandardMaterial(name + "Mat", scene);
      mat.disableLighting = true;
      mat.emissiveColor = color;
      m.material = mat;
      m.isPickable = false;
      m.position.y = -1000;
      return m;
    };
    this.tracerTemplates.player = mk("tracerP", new Color3(4, 3.2, 1.6), 0.06);
    this.tracerTemplates.laser = mk("tracerE", new Color3(5, 0.6, 0.4), 0.12);

    // 爆発の点光源。数を固定して常に有効のまま強さだけ変える（有効・無効の切替はシェーダー再コンパイルを招く）
    const lights = ps >= 0.95 ? 2 : ps >= 0.7 ? 1 : 0;
    for (let i = 0; i < lights; i++) {
      const l = new PointLight("flash" + i, new Vector3(0, -100, 0), scene);
      l.diffuse = new Color3(1, 0.65, 0.35);
      l.specular = new Color3(0.4, 0.3, 0.2);
      l.intensity = 0;
      l.range = 40;
      this.flashes.push({ light: l, life: 0, dur: 1, max: 0 });
    }
  }

  muzzleFlash(pos: Vector3, dir: Vector3) {
    this.tv1.copyFrom(dir).scaleInPlace(0.1).addInPlace(pos);
    this.tv2.copyFrom(dir).scaleInPlace(2);
    this.muzzle.emit(this.tv1, 3, { dir: this.tv2, spread: 0.4, radius: 0.05 });
    this.lightFlash(pos, 0.05, 2.5, 8);
  }

  tracer(from: Vector3, to: Vector3, kind: "player" | "laser" = "player", speed = 600) {
    const dir = to.subtract(from);
    const dist = dir.length();
    if (dist < 0.5) return;
    dir.scaleInPlace(1 / dist);
    let t = this.tracers.find((t) => !t.active && t.mesh.sourceMesh === this.tracerTemplates[kind]);
    if (!t) {
      if (this.tracers.length > 200) return;
      const mesh = this.tracerTemplates[kind].createInstance("tr");
      mesh.rotationQuaternion = new Quaternion();
      t = { mesh, from: new Vector3(), dir: new Vector3(), dist: 0, travelled: 0, speed, len: 0, active: false };
      this.tracers.push(t);
    }
    t.from.copyFrom(from);
    t.dir.copyFrom(dir);
    t.dist = dist;
    t.travelled = 0;
    t.speed = speed;
    t.len = kind === "laser" ? 3 : Math.min(9, Math.max(2, speed / 70));
    t.active = true;
    t.mesh.setEnabled(true);
    lookQuat(dir, t.mesh.rotationQuaternion!);
    this.placeTracer(t);
  }

  private placeTracer(t: Tracer) {
    const head = Math.min(t.dist, t.travelled + t.len);
    const tail = Math.max(0, Math.min(t.dist, t.travelled));
    const len = Math.max(0.01, head - tail);
    t.mesh.scaling.set(1, 1, len);
    t.mesh.position.copyFrom(t.dir).scaleInPlace((head + tail) / 2).addInPlace(t.from);
  }

  /** 量の倍率（particleScale）を掛けて丸める */
  private q(c: number) {
    return Math.max(1, Math.round(c * this.particleScale));
  }

  /** 破片をまとめて飛ばす。dir 方向（正規化済みでなくてよい）を中心に spread で散らす */
  private throwChips(pos: Vector3, count: number, dir: Vector3 | null, speed: number, spread: number, size: number, life: number, color: Color3 | Color3[], floorY: number) {
    for (let i = 0; i < count; i++) {
      let dx = (Math.random() - 0.5) * 2 * spread;
      let dy = (Math.random() - 0.5) * 2 * spread;
      let dz = (Math.random() - 0.5) * 2 * spread;
      if (dir) {
        dx += dir.x;
        dy += dir.y;
        dz += dir.z;
      }
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const v = speed * (0.45 + Math.random() * 0.55);
      const c = Array.isArray(color) ? color[(Math.random() * color.length) | 0] : color;
      this.chips.spawn(pos.x, pos.y, pos.z, (dx / l) * v, (dy / l) * v + speed * 0.25, (dz / l) * v, size * (0.6 + Math.random() * 0.7), life * (0.7 + Math.random() * 0.6), c, floorY);
    }
  }

  /**
   * 壁・地面への着弾（コンクリート片・土煙・火花）。
   * scale: 大きさ（1 = 通常弾）、color: 欠片の色（省略時はコンクリート色）
   */
  impact(pos: Vector3, normal: Vector3, scale = 1, color?: Color3) {
    const s = Math.max(0.3, scale);
    this.tv1.copyFrom(normal).scaleInPlace(1.2);
    this.sparks.emit(pos, 4 * s, { dir: this.tv1, spread: 0.8, radius: 0.05 });
    this.tv1.copyFrom(normal).scaleInPlace(0.6);
    this.dust.emit(pos, Math.max(1, this.q(3 * s)), { dir: this.tv1, spread: 0.4, radius: 0.1, size: 0.6 + 0.3 * s });
    // 地面（上向きの面）なら着弾点が床。壁なら下の地面まで落ちる
    const floor = normal.y > 0.6 ? pos.y : Math.min(pos.y, 0.05);
    this.tv1.copyFrom(normal).scaleInPlace(0.9);
    this.throwChips(pos, Math.max(1, this.q(2.5 * s)), this.tv1, 6 + 2 * s, 0.6, 0.12 * Math.sqrt(s), 1.6, color ?? CONCRETE, floor);
  }

  /**
   * 敵への着弾（閃光・火花・殻の破片・体液の飛沫ともや）。
   * heavy: true（ロケット・高威力）または強さの数値（1 = 通常弾、2.5 ≒ true）
   * color: 殻の色（省略時は敵の種類から決める）
   */
  hitEnemy(pos: Vector3, dir: Vector3, kind: string, heavy: boolean | number = false, color?: Color3) {
    const k = typeof heavy === "number" ? Math.max(0.3, heavy) : heavy ? 2.5 : 1;
    const sk = Math.sqrt(k);
    // 弾が来た方向へ跳ね返る
    const back = this.tv1.copyFrom(dir).scaleInPlace(-1);
    this.flare.emit(pos, 1, { radius: 0.05, size: 0.9 * sk });
    this.sparks.emit(pos, this.q(5 * k), { dir: back, spread: 0.9, radius: 0.05, power: 14 * sk, stretch: 2.5 });
    const shell = color ?? SHELL[kind] ?? SHELL.flyer;
    const chipColor = kind === "ant" && Math.random() < 0.3 ? ANT_ACCENT : shell;
    this.tv2.copyFrom(back).addInPlaceFromFloats(0, 0.5, 0);
    this.throwChips(pos, Math.max(1, this.q(2 * k)), this.tv2, 7 * sk, 0.7, 0.16 * sk, 2.2, chipColor, 0);
    const fl = FLUID[kind];
    if (fl) {
      // 体液の飛沫（滴）＋ もや
      this.tv2.copyFrom(back).addInPlaceFromFloats(0, 0.45, 0);
      this.tc1.copyFrom(fl[0]);
      this.tc2.copyFrom(fl[1]);
      this.tc3.set(fl[1].r * 0.5, fl[1].g * 0.5, fl[1].b * 0.5, 0);
      this.droplets.emit(pos, this.q(7 * k), {
        dir: this.tv2,
        spread: 0.7,
        radius: 0.15 * sk,
        size: 0.55 * sk,
        power: 8 * sk,
        stretch: 2.2,
        c1: this.tc1,
        c2: this.tc2,
        cDead: this.tc3,
      });
      this.tc1.a = 0.55;
      this.tc2.a = 0.45;
      this.mist.emit(pos, Math.max(1, Math.round(1.5 * sk)), { dir: back, spread: 0.6, radius: 0.2, size: 1.4 * sk, power: 2.5 * sk, c1: this.tc1, c2: this.tc2, cDead: this.tc3 });
    } else {
      // 機械の敵: 青白い火花と黒い煙
      this.metal.emit(pos, this.q(6 * k), { dir: back, spread: 1, radius: 0.1, stretch: 2 });
      if (k > 1.5) this.smoke.emit(pos, 2, { radius: 0.3, size: 0.6 * sk, power: 2 });
    }
  }

  /** 撃破時の体液の飛び散り（color: 殻の色。省略可） */
  gore(pos: Vector3, kind: string, color?: Color3) {
    if (kind === "flyer" || kind === "carrier") {
      this.explosion(pos, 5, false);
      return;
    }
    const fl = FLUID[kind] ?? FLUID.ant;
    this.tc1.copyFrom(fl[0]);
    this.tc2.copyFrom(fl[1]);
    this.tc3.set(fl[1].r * 0.5, fl[1].g * 0.5, fl[1].b * 0.5, 0);
    this.tv2.set(0, 1.5, 0);
    this.droplets.emit(pos, this.q(40), { dir: this.tv2, spread: 1.4, radius: 1, size: 1.8, power: 16, stretch: 2, c1: this.tc1, c2: this.tc2, cDead: this.tc3 });
    this.tc1.a = 0.6;
    this.tc2.a = 0.5;
    this.tv2.set(0, 0.6, 0);
    this.mist.emit(pos, this.q(5), { dir: this.tv2, spread: 1, radius: 1.2, size: 3.5, power: 4, c1: this.tc1, c2: this.tc2, cDead: this.tc3 });
    this.tv2.set(0, 1, 0);
    this.throwChips(pos, this.q(10), this.tv2, 10, 1, 0.35, 3, color ?? SHELL[kind] ?? SHELL.ant, 0);
  }

  /**
   * 爆発。閃光 → 火球（橙 → 暗赤 → 煙）→ 衝撃波と砂煙の輪 → 立ち上る黒煙、破片と火の粉、地面の焦げ跡。
   * すべて radius に比例した大きさ。scorch=false は空中の爆発（焦げ跡なし）。
   */
  explosion(pos: Vector3, radius: number, scorch = true) {
    const r = Math.max(1, radius);
    const s = r / 7;
    const ss = Math.sqrt(s);
    const amt = Math.min(2.2, ss); // 量は大きさの平方根で増やす（大爆発でも出しすぎない）
    const nearGround = pos.y < r * 0.7;
    const groundY = pos.y < 1.5 ? pos.y : 0;

    // 1) 閃光と点光源
    this.flare.emit(pos, 1, { radius: 0.1, size: r * 1.5 });
    this.lightFlash(pos, 0.35 + 0.1 * ss, 60 * ss, r * 7);
    this.shock.emit(pos, 1, { radius: 0.01, size: r * 2.6 });

    // 2) 火球。地面での爆発は半球状に上へ膨らませる（下向きの粒が地面に埋もれないように）
    const c = this.tv1.copyFrom(pos);
    if (nearGround) c.y = groundY + r * 0.3;
    this.tv2.set(0, nearGround ? 0.55 : 0, 0);
    this.fire.emit(c, this.q(30 * amt), { dir: this.tv2, spread: 1, radius: r * 0.25, size: r * 0.5, power: r * 3.2 });
    // 3) 煙（火球の後ろに残る）
    c.y += r * 0.15;
    this.tv2.set(0, 0.6, 0);
    this.smoke.emit(c, this.q(16 * amt), { dir: this.tv2, spread: 1, radius: r * 0.35, size: r * 0.55, power: r * 1.6 });
    // 4) 火花・火の粉
    this.sparks.emit(pos, this.q(26 * amt), { radius: r * 0.1, power: 30 * ss, stretch: 3 });
    this.embers.emit(pos, this.q(16 * amt), { radius: r * 0.15, power: 16 * ss, size: ss, stretch: 2 });
    // 5) 破片（瓦礫・焦げた欠片）
    this.tv2.set(0, 0.8, 0);
    this.throwChips(pos, this.q(12 * amt), this.tv2, 15 * ss, 1, 0.3 * ss, 3.5, DEBRIS_COLORS, groundY);
    // 6) 地面近くなら衝撃波のリングと砂煙の輪、焦げ跡
    if (nearGround) {
      const y = groundY + 0.06;
      this.rings.spawn(pos.x, y, pos.z, r * 0.4, r * 4.4, 0.5, 2.2, 1.6, 1.0, 1);
      this.tv1.set(pos.x, groundY + 0.4, pos.z);
      this.dustRing.emit(this.tv1, this.q(30 * amt), { ring: true, radius: r * 0.35, size: r * 0.42, power: r * 4.5 });
      if (scorch) this.scorches.spawn(pos.x, groundY + 0.035, pos.z, r * 1.1, r * 1.25, 12, 0.02, 0.018, 0.015, 0.85, 0.55);
    }
    // 7) 立ち上る煙柱（しばらく出し続ける）
    const slot = this.plumeNext;
    this.plumeNext = (this.plumeNext + 1) % this.plumes.length;
    let p = this.plumes[slot];
    if (!p) p = this.plumes[slot] = { pos: new Vector3(), t: 0, dur: 0, acc: 0, size: 1, power: 1 };
    p.pos.copyFrom(pos);
    p.pos.y += r * 0.25;
    p.t = 0;
    p.dur = 1.2 + 0.5 * ss;
    p.acc = 0;
    p.size = r * 0.55;
    p.power = 5 * ss;
  }

  /** 建物倒壊の土煙 */
  collapseDust(cx: number, cz: number, hw: number, hd: number, intensity = 1) {
    const n = 4;
    for (let i = 0; i < n; i++) {
      this.tv1.set(cx + (Math.random() - 0.5) * hw * 2, 1, cz + (Math.random() - 0.5) * hd * 2);
      this.dust.emit(this.tv1, 6 * this.particleScale * intensity, { radius: Math.max(hw, hd) * 0.6, size: 2.5, power: 7 });
    }
    // 地面を走る砂煙の輪
    this.tv1.set(cx, 0.8, cz);
    this.dustRing.emit(this.tv1, this.q(20 * intensity), { ring: true, radius: Math.max(hw, hd), size: Math.max(hw, hd) * 0.35, power: 14 });
    this.tv2.set(0, 1, 0);
    this.tv1.set(cx, 2, cz);
    this.throwChips(this.tv1, this.q(6 * intensity), this.tv2, 9, 1, 0.5, 3, DEBRIS_COLORS, 0);
  }

  /** ミサイルの煙の尾 */
  trail(pos: Vector3) {
    this.trailSmoke.emit(pos, 1, { radius: 0.1 });
  }

  /** 着地や接地の土埃 */
  puff(pos: Vector3, amount = 4, size = 1) {
    this.dust.emit(pos, amount * this.particleScale, { radius: size, size, power: 3 });
  }

  private lightFlash(pos: Vector3, life: number, intensity: number, range: number) {
    if (this.flashes.length === 0) return;
    // 空いている（または今いちばん暗い）光源を使う。より強い光は上書きしない
    let best = this.flashes[0];
    for (const f of this.flashes) if (f.light.intensity < best.light.intensity) best = f;
    if (best.life > 0 && best.light.intensity > intensity) return;
    best.light.position.copyFrom(pos);
    best.light.position.y += 1;
    best.light.range = range;
    best.max = intensity;
    best.life = life;
    best.dur = life;
    best.light.intensity = intensity;
  }

  addShake(v: number) {
    this.shake = Math.min(1.5, this.shake + v);
  }

  update(dt: number) {
    for (const t of this.tracers) {
      if (!t.active) continue;
      t.travelled += t.speed * dt;
      if (t.travelled >= t.dist) {
        t.active = false;
        t.mesh.setEnabled(false);
        continue;
      }
      this.placeTracer(t);
    }
    for (const f of this.flashes) {
      if (f.life > 0) {
        f.life -= dt;
        // 最初に強く、すぐに落ちる
        const k = Math.max(0, f.life / f.dur);
        f.light.intensity = f.max * k * k;
      } else f.light.intensity = 0;
    }
    // 煙柱
    for (let i = 0; i < this.plumes.length; i++) {
      const p = this.plumes[i];
      if (!p || p.t >= p.dur) continue;
      p.t += dt;
      p.acc += dt;
      const interval = 0.12;
      if (p.acc >= interval) {
        p.acc -= interval;
        const fade = 1 - p.t / p.dur;
        this.tv2.set(0, 1, 0);
        this.plumeSmoke.emitAt(i, p.pos, Math.max(1, Math.round((2 + fade) * this.particleScale + 0.5)), {
          dir: this.tv2,
          spread: 0.25,
          radius: p.size * 0.5,
          size: p.size * (0.6 + 0.4 * fade),
          power: p.power * (0.5 + 0.5 * fade),
        });
      }
    }
    this.chips.update(dt);
    this.rings.update(dt);
    this.scorches.update(dt);
    this.shake = Math.max(0, this.shake - dt * 2.5);
  }
}
