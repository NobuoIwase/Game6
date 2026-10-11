// ============================================================================
// 視覚効果：マズルフラッシュ・曳光弾・着弾・体液・爆発・土煙・画面の揺れ。
// パーティクルはプール（使い回し）して生成コストを抑える。
// ============================================================================
import {
  Color3,
  Color4,
  DynamicTexture,
  InstancedMesh,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  PointLight,
  Quaternion,
  Scene,
  StandardMaterial,
  Texture,
  Vector3,
} from "@babylonjs/core";
import { lookQuat } from "../core/MathUtil";

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
  sizeGrow?: number;
  drag?: number;
}

/** 使い回すパーティクルシステムの束 */
class BurstPool {
  private systems: ParticleSystem[] = [];
  private i = 0;
  constructor(scene: Scene, name: string, count: number, private cfg: PoolConfig) {
    for (let k = 0; k < count; k++) {
      const ps = new ParticleSystem(`${name}${k}`, cfg.capacity, scene);
      ps.particleTexture = cfg.texture;
      ps.blendMode = cfg.blend;
      ps.color1 = cfg.color1;
      ps.color2 = cfg.color2;
      ps.colorDead = cfg.colorDead;
      ps.minSize = cfg.minSize;
      ps.maxSize = cfg.maxSize;
      ps.minLifeTime = cfg.minLife;
      ps.maxLifeTime = cfg.maxLife;
      ps.minEmitPower = cfg.minPower;
      ps.maxEmitPower = cfg.maxPower;
      ps.gravity = new Vector3(0, cfg.gravity, 0);
      ps.emitRate = 0;
      ps.manualEmitCount = 0;
      ps.minAngularSpeed = -1.5;
      ps.maxAngularSpeed = 1.5;
      ps.minInitialRotation = 0;
      ps.maxInitialRotation = Math.PI * 2;
      ps.updateSpeed = 1 / 60;
      if (cfg.sizeGrow) {
        ps.addSizeGradient(0, 0.4);
        ps.addSizeGradient(1, cfg.sizeGrow);
      }
      if (cfg.drag) ps.addDragGradient(0, cfg.drag);
      ps.createSphereEmitter(0.5);
      ps.emitter = new Vector3();
      ps.start();
      this.systems.push(ps);
    }
  }

  emit(pos: Vector3, count: number, opts?: { radius?: number; dir?: Vector3; spread?: number; size?: number; power?: number }) {
    const ps = this.systems[this.i];
    this.i = (this.i + 1) % this.systems.length;
    (ps.emitter as Vector3).copyFrom(pos);
    if (opts?.dir) {
      const d = opts.dir;
      const s = opts.spread ?? 0.5;
      ps.createDirectedSphereEmitter(opts.radius ?? 0.2, d.add(new Vector3(-s, -s, -s)), d.add(new Vector3(s, s, s)));
    } else {
      ps.createSphereEmitter(opts?.radius ?? 0.5);
    }
    const size = opts?.size ?? 1;
    ps.minScaleX = ps.minScaleY = size * 0.7;
    ps.maxScaleX = ps.maxScaleY = size;
    if (opts?.power) {
      ps.minEmitPower = opts.power * 0.4;
      ps.maxEmitPower = opts.power;
    } else {
      ps.minEmitPower = this.cfg.minPower;
      ps.maxEmitPower = this.cfg.maxPower;
    }
    ps.manualEmitCount = Math.max(1, Math.round(count));
  }
}

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

export class Effects {
  private fire: BurstPool;
  private smoke: BurstPool;
  private sparks: BurstPool;
  private dust: BurstPool;
  private fluidAnt: BurstPool;
  private fluidSpider: BurstPool;
  private metal: BurstPool;
  private muzzle: BurstPool;
  private trailSmoke: BurstPool;
  private tracers: Tracer[] = [];
  private tracerTemplates: Record<string, Mesh> = {};
  private flash: PointLight;
  private flashLife = 0;
  private flashMax = 1;
  private rings: { mesh: Mesh; t: number; life: number; size: number }[] = [];
  private ringMat: StandardMaterial;
  shake = 0;

  constructor(
    private scene: Scene,
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
    const ps = particleScale;
    const n = (c: number) => Math.max(4, Math.round(c * ps));
    this.fire = new BurstPool(scene, "fire", 6, {
      capacity: n(80),
      texture: smokeTex,
      blend: ParticleSystem.BLENDMODE_ADD,
      color1: new Color4(1, 0.65, 0.25, 1),
      color2: new Color4(1, 0.4, 0.1, 1),
      colorDead: new Color4(0.2, 0.05, 0, 0),
      minSize: 2,
      maxSize: 5,
      minLife: 0.25,
      maxLife: 0.6,
      minPower: 4,
      maxPower: 14,
      gravity: 3,
      sizeGrow: 1.6,
      drag: 0.85,
    });
    this.smoke = new BurstPool(scene, "smoke", 6, {
      capacity: n(60),
      texture: smokeTex,
      blend: ParticleSystem.BLENDMODE_STANDARD,
      color1: new Color4(0.32, 0.3, 0.28, 0.75),
      color2: new Color4(0.18, 0.17, 0.16, 0.7),
      colorDead: new Color4(0.25, 0.25, 0.25, 0),
      minSize: 3,
      maxSize: 7,
      minLife: 1.8,
      maxLife: 4,
      minPower: 1,
      maxPower: 6,
      gravity: 1.2,
      sizeGrow: 2.2,
      drag: 0.7,
    });
    this.sparks = new BurstPool(scene, "sparks", 8, {
      capacity: n(60),
      texture: spark,
      blend: ParticleSystem.BLENDMODE_ADD,
      color1: new Color4(1, 0.9, 0.6, 1),
      color2: new Color4(1, 0.6, 0.2, 1),
      colorDead: new Color4(0.5, 0.1, 0, 0),
      minSize: 0.08,
      maxSize: 0.25,
      minLife: 0.2,
      maxLife: 0.7,
      minPower: 6,
      maxPower: 25,
      gravity: -15,
    });
    this.dust = new BurstPool(scene, "dust", 8, {
      capacity: n(120),
      texture: smokeTex,
      blend: ParticleSystem.BLENDMODE_STANDARD,
      color1: new Color4(0.62, 0.58, 0.52, 0.6),
      color2: new Color4(0.5, 0.47, 0.42, 0.55),
      colorDead: new Color4(0.5, 0.5, 0.5, 0),
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
    const fluid = (name: string, c1: Color4, c2: Color4) =>
      new BurstPool(scene, name, 8, {
        capacity: n(40),
        texture: soft,
        blend: ParticleSystem.BLENDMODE_STANDARD,
        color1: c1,
        color2: c2,
        colorDead: new Color4(c2.r * 0.5, c2.g * 0.5, c2.b * 0.5, 0),
        minSize: 0.2,
        maxSize: 0.7,
        minLife: 0.4,
        maxLife: 1.1,
        minPower: 4,
        maxPower: 12,
        gravity: -16,
      });
    // 巨大生物の体液（黄緑・紫）
    this.fluidAnt = fluid("fluidAnt", new Color4(0.75, 0.8, 0.15, 1), new Color4(0.55, 0.6, 0.05, 0.9));
    this.fluidSpider = fluid("fluidSpider", new Color4(0.45, 0.15, 0.5, 1), new Color4(0.3, 0.08, 0.35, 0.9));
    this.metal = new BurstPool(scene, "metal", 6, {
      capacity: n(40),
      texture: spark,
      blend: ParticleSystem.BLENDMODE_ADD,
      color1: new Color4(0.6, 0.85, 1, 1),
      color2: new Color4(1, 1, 1, 1),
      colorDead: new Color4(0, 0.2, 0.5, 0),
      minSize: 0.1,
      maxSize: 0.35,
      minLife: 0.15,
      maxLife: 0.5,
      minPower: 8,
      maxPower: 22,
      gravity: -10,
    });
    this.muzzle = new BurstPool(scene, "muzzle", 3, {
      capacity: 12,
      texture: soft,
      blend: ParticleSystem.BLENDMODE_ADD,
      color1: new Color4(1, 0.85, 0.5, 1),
      color2: new Color4(1, 0.6, 0.25, 1),
      colorDead: new Color4(1, 0.3, 0, 0),
      minSize: 0.25,
      maxSize: 0.6,
      minLife: 0.03,
      maxLife: 0.06,
      minPower: 0.5,
      maxPower: 3,
      gravity: 0,
    });
    this.trailSmoke = new BurstPool(scene, "trail", 4, {
      capacity: n(300),
      texture: smokeTex,
      blend: ParticleSystem.BLENDMODE_STANDARD,
      color1: new Color4(0.85, 0.85, 0.85, 0.55),
      color2: new Color4(0.7, 0.7, 0.7, 0.45),
      colorDead: new Color4(0.6, 0.6, 0.6, 0),
      minSize: 0.5,
      maxSize: 1,
      minLife: 0.8,
      maxLife: 1.6,
      minPower: 0.1,
      maxPower: 0.6,
      gravity: 0.6,
      sizeGrow: 3,
    });

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

    this.flash = new PointLight("flash", Vector3.Zero(), scene);
    this.flash.diffuse = new Color3(1, 0.7, 0.4);
    this.flash.intensity = 0;
    this.flash.range = 40;

    this.ringMat = new StandardMaterial("ringMat", scene);
    this.ringMat.disableLighting = true;
    this.ringMat.emissiveColor = new Color3(1, 0.85, 0.6);
    this.ringMat.opacityTexture = radialTexture(scene, "ringTex", [
      [0, "rgba(255,255,255,0)"],
      [0.75, "rgba(255,255,255,0)"],
      [0.9, "rgba(255,255,255,0.8)"],
      [1, "rgba(255,255,255,0)"],
    ]);
    this.ringMat.backFaceCulling = false;
  }

  muzzleFlash(pos: Vector3, dir: Vector3) {
    this.muzzle.emit(pos.add(dir.scale(0.1)), 3, { dir: dir.scale(2), spread: 0.4, radius: 0.05 });
    this.lightFlash(pos, 0.25, 6, 0.05);
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
    t.mesh.position.copyFrom(t.from).addInPlace(t.dir.scale((head + tail) / 2));
  }

  /** 壁・地面への着弾 */
  impact(pos: Vector3, normal: Vector3) {
    this.sparks.emit(pos, 6, { dir: normal.scale(1.2), spread: 0.8, radius: 0.05 });
    this.dust.emit(pos, 2, { dir: normal.scale(0.6), spread: 0.4, radius: 0.1 });
  }

  /** 敵への着弾（体液や火花） */
  hitEnemy(pos: Vector3, dir: Vector3, kind: "ant" | "spider" | "flyer", heavy = false) {
    const back = dir.scale(-1);
    const c = heavy ? 18 : 6;
    if (kind === "ant") this.fluidAnt.emit(pos, c, { dir: back.add(Vector3.Up().scale(0.6)), spread: 0.9, radius: 0.2 });
    else if (kind === "spider") this.fluidSpider.emit(pos, c, { dir: back.add(Vector3.Up().scale(0.6)), spread: 0.9, radius: 0.2 });
    else this.metal.emit(pos, c, { dir: back, spread: 1, radius: 0.1 });
  }

  /** 撃破時の体液の飛び散り */
  gore(pos: Vector3, kind: "ant" | "spider" | "flyer") {
    if (kind === "flyer") {
      this.explosion(pos, 5, false);
      return;
    }
    const pool = kind === "ant" ? this.fluidAnt : this.fluidSpider;
    pool.emit(pos, 30, { dir: Vector3.Up().scale(1.5), spread: 1.4, radius: 1, size: 2 });
  }

  explosion(pos: Vector3, radius: number, scorch = true) {
    const s = radius / 7;
    this.fire.emit(pos, 22 * this.particleScale * Math.min(2, s), { radius: radius * 0.25, size: s * 1.4, power: 12 * s });
    this.smoke.emit(pos.add(new Vector3(0, radius * 0.2, 0)), 14 * this.particleScale * Math.min(2, s), {
      radius: radius * 0.35,
      size: s * 1.5,
      power: 5 * s,
    });
    this.sparks.emit(pos, 25 * this.particleScale, { radius: 0.5, power: 30 * Math.sqrt(s) });
    if (scorch && pos.y < 2) this.dust.emit(pos, 12 * this.particleScale, { radius: radius * 0.5, size: s * 2, power: 6 * s });
    this.lightFlash(pos, 0.5, 30 * s, radius * 6);
    // 衝撃波のリング
    const ring = MeshBuilder.CreateDisc("ring", { radius: 1, tessellation: 24 }, this.scene);
    ring.material = this.ringMat;
    ring.position.copyFrom(pos);
    ring.position.y = Math.max(0.15, pos.y);
    ring.rotation.x = Math.PI / 2;
    ring.isPickable = false;
    this.rings.push({ mesh: ring, t: 0, life: 0.35, size: radius * 1.8 });
  }

  /** 建物倒壊の土煙 */
  collapseDust(cx: number, cz: number, hw: number, hd: number, intensity = 1) {
    const n = 4;
    for (let i = 0; i < n; i++) {
      const p = new Vector3(cx + (Math.random() - 0.5) * hw * 2, 1, cz + (Math.random() - 0.5) * hd * 2);
      this.smoke.emit(p, 6 * this.particleScale * intensity, { radius: Math.max(hw, hd) * 0.6, size: 2.5, power: 7 });
    }
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
    if (this.flashLife > 0 && this.flash.intensity > intensity) return;
    this.flash.position.copyFrom(pos);
    this.flash.position.y += 1;
    this.flash.range = range;
    this.flashMax = intensity;
    this.flashLife = life;
    this.flash.intensity = intensity;
    this.flashDur = life;
  }
  private flashDur = 1;

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
    if (this.flashLife > 0) {
      this.flashLife -= dt;
      this.flash.intensity = Math.max(0, (this.flashLife / this.flashDur) * this.flashMax);
    } else this.flash.intensity = 0;
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      const k = r.t / r.life;
      if (k >= 1) {
        r.mesh.dispose();
        this.rings.splice(i, 1);
        continue;
      }
      const s = 1 + k * r.size;
      r.mesh.scaling.set(s, s, s);
      r.mesh.visibility = 1 - k;
    }
    this.shake = Math.max(0, this.shake - dt * 2.5);
  }
}
