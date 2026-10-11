// ============================================================================
// 巨大生物（蜘蛛型）
// ----------------------------------------------------------------------------
// ・素早く跳ね回り（跳躍でビルの屋上にも乗る）、一定の距離を保とうとする
// ・扇状に糸を放つ。糸が当たるとダメージ＋「拘束値」が蓄積し、
//   一定以上でプレイヤーは糸に絡め取られて倒れる（ラグドール化）
// ============================================================================
import { Color3, InstancedMesh, Mesh, MeshBuilder, PBRMaterial, Quaternion, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { ENEMIES } from "../data/enemies";
import type { GameContext } from "../core/GameContext";
import { GroundEnemy } from "./Enemy";
import { clamp, fromToQuat, rand, yawOf } from "../core/MathUtil";
import { GRAVITY } from "../core/Physics";
import { spreadDir } from "../combat/Weapon";
import { sfx } from "../core/Audio";
import { hideTemplate, limb } from "./Ant";

interface SpiderTemplates {
  body: Mesh;
  abdomen: Mesh;
  femur: Mesh;
  tibia: Mesh;
  eyes: Mesh;
}

const FEMUR_L = 2.3;
const TIBIA_L = 3.0;
const cache = new WeakMap<Scene, SpiderTemplates>();

function bake(m: Mesh, scale: Vector3, pos: Vector3, rot?: Vector3) {
  m.scaling.copyFrom(scale);
  m.position.copyFrom(pos);
  if (rot) m.rotation.copyFrom(rot);
  m.bakeCurrentTransformIntoVertices();
  return m;
}

function templates(scene: Scene): SpiderTemplates {
  const c = cache.get(scene);
  if (c) return c;
  const hair = new PBRMaterial("spiderHair", scene);
  hair.albedoColor = new Color3(0.035, 0.028, 0.022);
  hair.metallic = 0;
  hair.roughness = 0.75;
  hair.sheen.isEnabled = true;
  hair.sheen.intensity = 0.25;
  hair.sheen.color = new Color3(0.45, 0.4, 0.3);
  const stripe = new PBRMaterial("spiderStripe", scene);
  stripe.albedoColor = new Color3(0.42, 0.26, 0.06);
  stripe.roughness = 0.6;
  const eye = new PBRMaterial("spiderEye", scene);
  eye.albedoColor = new Color3(0.1, 0, 0);
  eye.emissiveColor = new Color3(1.6, 0.05, 0.02);
  eye.roughness = 0.1;

  const s = (name: string) => MeshBuilder.CreateSphere(name, { diameter: 1, segments: 14 }, scene);
  const body = bake(s("spBody"), new Vector3(1.5, 0.9, 1.7), new Vector3(0, 0, 0.1));
  body.material = hair;
  const ab = bake(s("spAbd"), new Vector3(2.2, 1.9, 2.6), new Vector3(0, 0.35, -1.5), new Vector3(-0.25, 0, 0));
  ab.material = hair;
  // 腹部の模様（背中の斑紋）
  const spots: Mesh[] = [];
  for (const [z, w] of [
    [-0.9, 0.7],
    [-1.5, 0.9],
    [-2.1, 0.6],
  ]) {
    const sp = MeshBuilder.CreateSphere("spSpot", { diameter: 1, segments: 8 }, scene);
    bake(sp, new Vector3(w, 0.12, 0.35), new Vector3(0, 1.22 + (z === -1.5 ? 0.08 : -0.05), z));
    spots.push(sp);
  }
  const band = Mesh.MergeMeshes(spots, true)!;
  band.material = stripe;
  const abdomen = Mesh.MergeMeshes([ab, band], true, true, undefined, false, true)!;
  abdomen.name = "spAbdomen";
  const femur = limb(scene, "spFemur", FEMUR_L, 0.26, 0.18);
  femur.material = hair;
  const tibia = limb(scene, "spTibia", TIBIA_L, 0.18, 0.04);
  tibia.material = hair;
  const eyeParts: Mesh[] = [];
  for (const [x, y, d] of [
    [0.18, 0.25, 0.22],
    [-0.18, 0.25, 0.22],
    [0.38, 0.18, 0.14],
    [-0.38, 0.18, 0.14],
    [0.1, 0.38, 0.1],
    [-0.1, 0.38, 0.1],
  ]) {
    const e = MeshBuilder.CreateSphere("spEye", { diameter: d, segments: 6 }, scene);
    e.position.set(x, y, 0.92);
    eyeParts.push(e);
  }
  const eyes = Mesh.MergeMeshes(eyeParts, true)!;
  eyes.material = eye;
  eyes.name = "spEyes";
  const t: SpiderTemplates = { body, abdomen, femur, tibia, eyes };
  for (const m of Object.values(t)) hideTemplate(m);
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
    const T = templates(ctx.scene);
    const inst = (m: Mesh, parent: TransformNode, p: Vector3) => {
      const i = m.createInstance(m.name + this.id);
      i.parent = parent;
      i.position.copyFrom(p);
      i.rotationQuaternion = Quaternion.Identity();
      i.isPickable = false;
      return i;
    };
    this.body = inst(T.body, this.root, new Vector3(0, 1.3, 0));
    inst(T.eyes, this.body, new Vector3(0, 0, 0));
    this.abdomen = inst(T.abdomen, this.body, new Vector3(0, 0.1, -0.7));
    const zs = [0.6, 0.2, -0.2, -0.6];
    const zf = [0.9, 0.3, -0.25, -0.8];
    for (const sx of [-1, 1])
      for (let i = 0; i < 4; i++) {
        const femur = inst(T.femur, this.body, new Vector3(sx * 0.55, 0.1, zs[i]));
        const tibia = inst(T.tibia, femur, new Vector3(FEMUR_L, 0, 0));
        const phase = (i + (sx > 0 ? 1 : 0)) % 2 === 0 ? 0 : Math.PI;
        this.legs.push({ femur, tibia, side: sx, zf: zf[i], phase });
      }
    this.position.y = ctx.city.heightAt(pos.x, pos.z);
    this.hitSpheres = [
      { local: new Vector3(0, 1.3, 0.2), r: 1.0, world: new Vector3(), mult: 1.3 },
      { local: new Vector3(0, 1.7, -1.4), r: 1.35, world: new Vector3(), mult: 1 },
    ];
    const V = (x: number, y: number, z: number) => new Vector3(x, y, z);
    this.rig = [
      { node: this.body, parent: -1, size: V(1.5, 0.9, 1.7), center: V(0, 0, 0.1), mass: 60 },
      { node: this.abdomen, parent: 0, size: V(2.1, 1.8, 2.5), center: V(0, 0.35, -1.5), mass: 70, swing: 0.5 },
      ...this.legs.flatMap((l, i) => [
        { node: l.femur, parent: 0, size: V(FEMUR_L, 0.24, 0.24), center: V(FEMUR_L / 2, 0, 0), mass: 4, swing: 1.0 },
        { node: l.tibia, parent: 2 + i * 2, size: V(TIBIA_L, 0.16, 0.16), center: V(TIBIA_L / 2, 0, 0), mass: 3, swing: 1.1 },
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
    this.t += dt;
    this.stagger = Math.max(0, this.stagger - dt);
    if (this.updateAir(dt)) {
      this.applyOrientation(dt);
      this.animateLegs(dt, 0, true);
      return;
    }
    if (!this.active) this.idle(dt);
    else this.combat(dt);
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

    // 糸を撃つ前の溜め
    if (this.windup >= 0) {
      this.windup -= dt;
      this.moveSpeed = 0;
      this.turnTo(yawOf(to), 6, dt);
      if (this.windup < 0) this.shootWeb();
      return;
    }
    if (dist < this.def.attackRange && this.shootCd <= 0 && player.alive) {
      const eye = this.center().add(new Vector3(0, 0.5, 0));
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
      if (Math.random() < 0.3) this.strafeDir *= -1;
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
    const eye = this.center().add(new Vector3(0, 0.3, 0)).add(new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).scale(1.2));
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
    this.gait += dt * (3 + speed * 1.4);
    const inv = new Quaternion();
    for (const l of this.legs) {
      const ph = this.gait + l.phase;
      const swing = Math.sin(ph) * 0.4 * moving;
      const lift = Math.max(0, Math.cos(ph)) * 0.3 * moving;
      // 蜘蛛は膝を高く上げる姿勢
      const fd = air ? new Vector3(l.side * 0.6, 0.6, l.zf * 1.3) : new Vector3(l.side * 0.6, 0.6 + lift, l.zf + swing);
      const fq = fromToQuat(Vector3.Right(), fd, l.femur.rotationQuaternion!);
      const td = air ? new Vector3(l.side * 0.5, -0.4, l.zf) : new Vector3(l.side * 0.35, -1, l.zf * 0.5 + swing * 0.5);
      Quaternion.InverseToRef(fq, inv);
      fromToQuat(Vector3.Right(), td.rotateByQuaternionToRef(inv, new Vector3()), l.tibia.rotationQuaternion!);
    }
    this.abdomen.rotationQuaternion = Quaternion.RotationYawPitchRoll(Math.sin(this.t * 1.3) * 0.08, Math.sin(this.t * 2) * 0.05, 0);
  }

  protected onDeath(dir: Vector3, force: number) {
    sfx.squish(this.position);
    const v = new Vector3(dir.x, 0, dir.z).scale(force * 0.6).add(new Vector3(0, 3 + force * 0.3, 0));
    this.ragdollize(v.add(this.vel.scale(0.5)), 2 + force * 0.05);
  }
}
