// ============================================================================
// 巨大生物（蜘蛛型）
// ----------------------------------------------------------------------------
// ・素早く跳ね回り（跳躍でビルの屋上にも乗る）、一定の距離を保とうとする
// ・扇状に糸を放つ。糸が当たるとダメージ＋「拘束値」が蓄積し、
//   一定以上でプレイヤーは糸に絡め取られて倒れる（ラグドール化）
// ============================================================================
import { Color3, InstancedMesh, Mesh, Quaternion, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { glowMaterial, merge, shellMaterial } from "./AlienShapes";
import { crescent, gem, poseLeg, slab, spike } from "./AnchorShapes";
import { ENEMIES } from "../data/enemies";
import type { GameContext } from "../core/GameContext";
import { GroundEnemy } from "./Enemy";
import { clamp, rand, yawOf } from "../core/MathUtil";
import { GRAVITY } from "../core/Physics";
import { spreadDir } from "../combat/Weapon";
import { sfx } from "../core/Audio";
import { hideTemplate } from "./Ant";

interface SpiderTemplates {
  body: Mesh;
  crown: Mesh;
  abdomen: Mesh;
  femur: Mesh;
  tibia: Mesh;
  eyes: Mesh;
}

/** 体の大きさの倍率（脚を広げて 約14m） */
const S = 1.6;
const FEMUR_L = 2.2 * S;
const TIBIA_L = 3.0 * S;
const cache = new WeakMap<Scene, SpiderTemplates>();

/*
 * 造形（アンカー大型級・跳躍型）:
 *  蜘蛛をそのまま写さず、平たく幅広い甲羅の上に放射状のとげの冠を持つ体にする。
 *  ・6本の長い鎌状の脚を、膝を胴より高く上げて構える（ラフ画の大きな三日月の脚）
 *  ・正面に紫に光る小さな眼の群れ
 *  ・後ろに分厚い装甲板を重ねた腹部（糸の射出口）
 */
function templates(scene: Scene): SpiderTemplates {
  const c = cache.get(scene);
  if (c) return c;
  // 骨のように白っぽい外殻＋灰色の装甲＋紫に光る眼（甲殻型とは逆の配色）
  const shell = shellMaterial(scene, "spiderShell", new Color3(0.7, 0.66, 0.58), 0.12, 0.5);
  const dark = shellMaterial(scene, "spiderDark", new Color3(0.16, 0.15, 0.17), 0.4, 0.4);
  const glow = glowMaterial(scene, "spiderGlow", new Color3(1.6, 0.3, 3.2));
  const V = (x: number, y: number, z: number) => new Vector3(x * S, y * S, z * S);
  const R = (x: number, y: number, z: number) => new Vector3(x, y, z);
  const sl = (x: number, y: number, z: number, p: Vector3, r = R(0, 0, 0)) => slab(scene, "sl", x * S, y * S, z * S, p, r);
  // 甲羅: 平たく幅広い面取りの塊を重ねる
  const body = merge("spBody", [
    sl(2.4, 0.6, 2.0, V(0, 0, 0.1)),
    sl(1.9, 0.5, 1.6, V(0, 0.35, 0.05), R(-0.1, 0, 0)),
    sl(1.4, 0.55, 0.8, V(0, 0.05, 1.0), R(0.35, 0, 0)), // 額
    sl(1.6, 0.35, 1.4, V(0, -0.4, 0.1)),
  ]);
  // 背中のとげの冠（後ろ向きに放射状）
  const crownParts: Mesh[] = [];
  for (let k = 0; k < 5; k++) {
    const a = -0.9 + (1.8 * k) / 4;
    crownParts.push(spike(scene, "cr", 1.3 * S, 0.45 * S, 0.18 * S, V(Math.sin(a) * 0.5, 0.55, -0.1), R(0, Math.PI / 2 + a, Math.PI / 2 - 0.45)));
  }
  crownParts.push(sl(1.0, 0.3, 0.5, V(0.95, 0.15, 0.45), R(0, 0.5, -0.4)), sl(1.0, 0.3, 0.5, V(-0.95, 0.15, 0.45), R(0, -0.5, 0.4)));
  const crown = merge("spCrown", crownParts);
  const abdomen = merge("spAbdomen", [
    sl(2.1, 1.3, 1.7, V(0, 0.45, -1.2), R(-0.2, 0, 0)),
    sl(1.8, 1.0, 1.5, V(0, 0.6, -2.1), R(-0.45, 0, 0)),
    sl(1.2, 0.7, 1.0, V(0, 0.75, -2.8), R(-0.7, 0, 0)),
  ]);
  const femur = merge("spFemur", [
    slab(scene, "f", FEMUR_L * 1.05, 0.45 * S, 0.5 * S, new Vector3(FEMUR_L / 2, 0, 0)),
    spike(scene, "sp", 0.6 * S, 0.3 * S, 0.15 * S, new Vector3(FEMUR_L * 0.85, 0.2 * S, 0), R(0, 0, 1.0)),
  ]);
  const tibia = crescent(scene, "spTibia", TIBIA_L, 0.55 * S, 0.3 * S, 0.28);
  tibia.name = "spTibia";
  const eyes = merge("spEyes", [
    gem(scene, "e", 1, 0.22 * S, 0.2 * S, 0.18 * S, V(0.2, 0.25, 1.35)),
    gem(scene, "e", 1, 0.22 * S, 0.2 * S, 0.18 * S, V(-0.2, 0.25, 1.35)),
    gem(scene, "e", 1, 0.15 * S, 0.14 * S, 0.14 * S, V(0.45, 0.15, 1.2)),
    gem(scene, "e", 1, 0.15 * S, 0.14 * S, 0.14 * S, V(-0.45, 0.15, 1.2)),
    gem(scene, "e", 1, 0.12 * S, 0.11 * S, 0.11 * S, V(0.12, 0.0, 1.42)),
    gem(scene, "e", 1, 0.12 * S, 0.11 * S, 0.11 * S, V(-0.12, 0.0, 1.42)),
  ]);
  const t: SpiderTemplates = { body, crown, abdomen, femur, tibia, eyes };
  for (const m of Object.values(t)) {
    m.material = m === eyes ? glow : m === crown || m === femur ? dark : shell;
    hideTemplate(m);
  }
  cache.set(scene, t);
  return t;
}

export function spiderTemplateMeshes(scene: Scene): Mesh[] {
  return Object.values(templates(scene));
}

interface Leg {
  femur: InstancedMesh;
  tibia: InstancedMesh;
  side: number;
  zf: number;
  phase: number;
}

export class Spider extends GroundEnemy {
  private body: InstancedMesh;
  private abdomen: InstancedMesh;
  private legs: Leg[] = [];
  private gait = 0;
  private jumpCd = rand(1, 3);
  private shootCd = rand(1, 3);
  private preferDist = rand(22, 40);
  private strafeDir = Math.random() < 0.5 ? -1 : 1;
  private windup = -1;
  private idleT = rand(0, 4);

  constructor(ctx: GameContext, pos: Vector3, group: number) {
    super(ENEMIES.spider, ctx, pos, group);
    // 性格で保ちたい距離を変える（突撃型は懐へ、後衛型は遠くから糸を撃つ）
    if (this.temper === "rusher") this.preferDist = rand(8, 14);
    else if (this.temper === "lurker") this.preferDist = rand(42, 52);
    else if (this.temper === "flanker") this.preferDist = rand(20, 30);
    const T = templates(ctx.scene);
    const inst = (m: Mesh, parent: TransformNode, p: Vector3) => {
      const i = m.createInstance(m.name + this.id);
      i.parent = parent;
      i.position.copyFrom(p);
      i.rotationQuaternion = Quaternion.Identity();
      i.isPickable = false;
      return i;
    };
    this.body = inst(T.body, this.root, new Vector3(0, 1.3 * S, 0));
    const P = (x: number, y: number, z: number) => new Vector3(x * S, y * S, z * S);
    inst(T.eyes, this.body, new Vector3(0, 0, 0));
    inst(T.crown, this.body, new Vector3(0, 0, 0));
    this.abdomen = inst(T.abdomen, this.body, P(0, 0.1, -0.2));
    const zs = [0.6, 0.0, -0.6];
    const zf = [0.95, 0.1, -0.85];
    for (const sx of [-1, 1])
      for (let i = 0; i < 3; i++) {
        const femur = inst(T.femur, this.body, P(sx * 1.0, 0.1, zs[i]));
        const tibia = inst(T.tibia, femur, new Vector3(FEMUR_L * 0.95, 0, 0));
        const phase = (i + (sx > 0 ? 1 : 0)) % 2 === 0 ? 0 : Math.PI;
        this.legs.push({ femur, tibia, side: sx, zf: zf[i], phase });
      }
    this.position.y = ctx.city.heightAt(pos.x, pos.z);
    this.hitSpheres = [
      { local: P(0, 1.3, 0.2), r: 1.0 * S, world: new Vector3(), mult: 1.3 },
      { local: P(0, 1.75, -1.4), r: 1.35 * S, world: new Vector3(), mult: 1 },
    ];
    const V = (x: number, y: number, z: number) => new Vector3(x, y, z);
    this.rig = [
      { node: this.body, parent: -1, size: P(2.3, 0.9, 2.2), center: P(0, 0, 0.2), mass: 200 },
      { node: this.abdomen, parent: 0, size: P(1.9, 1.2, 2.4), center: P(0, 0.6, -1.9), mass: 220, swing: 0.5 },
      ...this.legs.flatMap((l, i) => [
        { node: l.femur, parent: 0, size: V(FEMUR_L, 0.45 * S, 0.45 * S), center: V(FEMUR_L / 2, 0, 0), mass: 16, swing: 1.0 },
        { node: l.tibia, parent: 2 + i * 2, size: V(TIBIA_L * 0.9, 0.4 * S, 0.25 * S), center: V(TIBIA_L * 0.45, 0.15 * S, 0), mass: 10, swing: 1.1 },
      ]),
    ];
    this.applyOrientation(0);
    this.animateLegs(0, 0);
    this.updateHitSpheres();
  }

  center(): Vector3 {
    return this.hitSpheres[0].world.clone();
  }

  update(dt: number) {
    if (this.updateCurled(dt)) return;
    this.t += dt;
    this.stagger = Math.max(0, this.stagger - dt);
    if (this.updateAir(dt)) {
      this.applyOrientation(dt);
      this.animateLegs(dt, 0, true);
      return;
    }
    if (!this.active) this.idle(dt);
    else this.combat(dt);
    this.applyShove(dt);
    this.applyOrientation(dt);
    this.animateLegs(dt, this.moveSpeed);
  }

  private idle(dt: number) {
    if (this.distToPlayerH() < this.def.detectRange) {
      this.ctx.enemies.alert(this);
      return;
    }
    // 待機: ときどき向きを変えて小さく跳ねる
    this.moveSpeed = 0;
    this.idleT -= dt;
    if (this.idleT <= 0) {
      this.idleT = rand(2, 6);
      this.yaw += rand(-1.5, 1.5);
      if (Math.random() < 0.4) {
        const back = this.home.subtract(this.position);
        back.y = 0;
        const dir = back.length() > 10 ? back.normalize() : new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        this.jump(dir, 6, 6);
      }
    }
  }

  private combat(dt: number) {
    const player = this.ctx.player;
    const to = player.position.subtract(this.position);
    to.y = 0;
    const dist = to.length();
    to.scaleInPlace(1 / Math.max(0.01, dist));
    this.jumpCd -= dt;
    this.shootCd -= dt;

    // 被弾中は怯んで攻撃・跳躍が中断される
    if (this.stagger > 0) {
      this.windup = -1;
      this.shootCd = Math.max(this.shootCd, 0.35);
      this.jumpCd = Math.max(this.jumpCd, 0.3);
      this.moveSpeed = 0;
      this.turnTo(yawOf(to), 2, dt);
      return;
    }
    // 糸を撃つ前の溜め
    if (this.windup >= 0) {
      this.windup -= dt;
      this.moveSpeed = 0;
      this.turnTo(yawOf(to), 6, dt);
      if (this.windup < 0) this.shootWeb();
      return;
    }
    if (dist < this.def.attackRange && this.shootCd <= 0 && player.alive) {
      const eye = this.center().add(new Vector3(0, 0.5 * S, 0));
      if (this.canSee(eye)) {
        this.windup = 0.35;
        return;
      }
    }
    // 跳躍で間合いを詰める / 回り込む / 離れる
    if (this.jumpCd <= 0) {
      this.jumpCd = rand(1.6, 3.4);
      let dir: Vector3;
      if (dist > this.preferDist + 12) dir = to.clone();
      else if (dist < this.preferDist - 10) dir = to.scale(-1);
      else dir = new Vector3(-to.z * this.strafeDir, 0, to.x * this.strafeDir);
      // 回り込み型は同じ向きに回り続ける
      if (this.temper !== "flanker" && Math.random() < 0.3) this.strafeDir *= -1;
      const range = clamp(Math.abs(dist - this.preferDist) + rand(8, 18), 10, 32);
      this.jump(dir.normalize(), range, rand(7, 12));
      return;
    }
    // 地上をカサカサ移動（距離を保つ）
    const want = dist > this.preferDist ? to : dist < this.preferDist - 8 ? to.scale(-1) : new Vector3(-to.z * this.strafeDir, 0, to.x * this.strafeDir);
    const faceYaw = yawOf(to);
    this.turnTo(faceYaw, 5, dt);
    const slow = this.stagger > 0 ? 0.3 : 1;
    this.walk(want.normalize(), this.def.speed * 0.6 * slow, dt);
  }

  /** 放物線の跳躍。horizontal = 水平距離、apex = 頂点の高さ */
  private jump(dir: Vector3, horizontal: number, apex: number) {
    const g = -GRAVITY;
    const vy = Math.sqrt(2 * g * apex);
    const tFlight = (2 * vy) / g;
    const vh = horizontal / tFlight;
    this.vel.set(dir.x * vh, vy, dir.z * vh);
    this.airborne = true;
    this.spinRate = 0;
    this.climbing = 0;
    this.yaw = yawOf(dir.lengthSquared() > 0 ? dir : new Vector3(0, 0, 1));
    this.ctx.effects.puff(this.position, 3, 1.5);
  }

  private shootWeb() {
    // 扇状に糸を放つ
    const eye = this.center().add(new Vector3(0, 0.3, 0)).add(new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).scale(1.2 * S));
    const target = this.ctx.player.chest;
    const dir = target.subtract(eye).normalize();
    const n = 8;
    for (let i = 0; i < n; i++) {
      const v = spreadDir(dir, 9).scale(95 * rand(0.9, 1.1));
      this.ctx.projectiles.spawnEnemy("web", eye, v, this.def.damage * this.ctx.difficulty.enemyDamage);
    }
    sfx.enemyShot(eye, "web");
    this.shootCd = this.def.attackInterval * rand(0.8, 1.3);
  }

  private animateLegs(dt: number, speed: number, air = false) {
    const moving = Math.min(1, speed / 4);
    this.gait += dt * (3 + speed * 1.3);
    for (const l of this.legs) {
      const ph = this.gait + l.phase;
      const swing = Math.sin(ph) * 0.45 * moving;
      const lift = Math.max(0, Math.cos(ph)) * 0.35 * moving;
      // 膝（腿の先）を胴より高く上げ、長い鎌を地面へ突き下ろす姿勢
      const fd = air ? new Vector3(l.side * 0.6, 0.5, l.zf * 1.3) : new Vector3(l.side * 0.55, 0.75 + lift, l.zf + swing);
      const td = air ? new Vector3(l.side * 0.6, -0.5, l.zf) : new Vector3(l.side * 0.42, -1, l.zf * 0.45 + swing * 0.5);
      poseLeg(l.femur, l.tibia, fd, td, l.side);
    }
    this.abdomen.rotationQuaternion = Quaternion.RotationYawPitchRoll(Math.sin(this.t * 1.3) * 0.08, Math.sin(this.t * 2) * 0.05, 0);
  }

  /** 死亡ポーズ: 6本の脚を腹側へ強く丸めて縮こまる（ひっくり返った虫の死骸） */
  protected deathPose() {
    for (const l of this.legs) {
      const fd = new Vector3(l.side * 0.4, -0.7, l.zf * 0.35);
      const td = new Vector3(-l.side * 0.9, 0.5, -l.zf * 0.2);
      poseLeg(l.femur, l.tibia, fd, td, l.side, new Vector3(0, -1, 0));
    }
    this.abdomen.rotationQuaternion = Quaternion.RotationYawPitchRoll(0, -0.4, Math.sin(this.id * 4.1) * 0.15);
  }

  protected onDeath(dir: Vector3, force: number) {
    sfx.squish(this.position);
    const v = new Vector3(dir.x, 0, dir.z).scale(force * 0.2).add(new Vector3(0, 1.5 + force * 0.1, 0));
    v.y += 1.7;
    this.rigidize(v.add(this.vel.scale(0.3)), 0.5 + force * 0.04, true);
  }
}
