// ============================================================================
// 巨大生物（蟻型）
// ----------------------------------------------------------------------------
// ・群れで行動し、プレイヤーを取り囲むように左右に散開して接近
// ・中距離で腹部を曲げて酸を放物線状に一斉噴射
// ・至近距離では噛みつき
// ・ビルの壁をよじ登って最短距離で迫る
// メッシュは InstancedMesh（同種パーツをまとめて1回で描画）で軽量化している。
// ============================================================================
import { Color3, InstancedMesh, Mesh, MeshBuilder, Quaternion, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { bakeT, cursorPlate, glowMaterial, merge, shard, shellMaterial } from "./AlienShapes";
import { ENEMIES } from "../data/enemies";
import type { GameContext } from "../core/GameContext";
import { GroundEnemy } from "./Enemy";
import { ballisticVelocity, clamp, fromToQuat, rand, yawOf } from "../core/MathUtil";
import { GRAVITY } from "../core/Physics";
import { spreadDir } from "../combat/Weapon";
import { sfx } from "../core/Audio";

interface AntTemplates {
  thorax: Mesh;
  head: Mesh;
  abdomen: Mesh;
  femur: Mesh;
  tibia: Mesh;
  mandible: Mesh;
  antenna: Mesh;
  eyes: Mesh;
}

/** 体の大きさの倍率（全長 約10m。人間の約5〜6倍） */
const S = 1.6;
const FEMUR_L = 1.5 * S;
const TIBIA_L = 2.0 * S;
const cache = new WeakMap<Scene, AntTemplates>();

/** 中心からずらした楕円体などを作り、変形を頂点に焼き込む */
function bake(m: Mesh, scale: Vector3, pos: Vector3, rot?: Vector3) {
  m.scaling.copyFrom(scale);
  m.position.copyFrom(pos);
  if (rot) m.rotation.copyFrom(rot);
  m.bakeCurrentTransformIntoVertices();
  return m;
}

/** +X 方向へ伸びる先細りの脚パーツ */
export function limb(scene: Scene, name: string, len: number, d0: number, d1: number) {
  const c = MeshBuilder.CreateCylinder(name, { height: len, diameterTop: d1, diameterBottom: d0, tessellation: 8 }, scene);
  // 円柱は Y 軸方向。+X 方向に倒して、根元を原点へ
  return bake(c, new Vector3(1, 1, 1), new Vector3(len / 2, 0, 0), new Vector3(0, 0, -Math.PI / 2));
}

export function hideTemplate(m: Mesh) {
  m.isPickable = false;
  m.receiveShadows = true;
  m.position.y = -2000;
  m.alwaysSelectAsActiveMesh = true;
}

// カーソル板の向き: rot.x = +π/2 で先端が前（+Z）、-π/2 で後ろ（-Z）。rot.z を足すと縦に立つ
const FWD = Math.PI / 2;
const BACK = -Math.PI / 2;

function templates(scene: Scene): AntTemplates {
  const c = cache.get(scene);
  if (c) return c;
  // 黒曜石のような外殻＋赤く光る眼
  const shell = shellMaterial(scene, "antShell", new Color3(0.035, 0.032, 0.04), 0.7, 0.22);
  const glow = glowMaterial(scene, "antGlow", new Color3(3.2, 0.25, 0.12));
  const V = (x: number, y: number, z: number) => new Vector3(x * S, y * S, z * S);
  const plate = (size: number, thick: number, pos: Vector3, rot: Vector3) =>
    bakeT(cursorPlate(scene, "pl", size * S, thick * S), pos, rot);

  // 胸部: 水平の板と垂直の板の十字
  const thorax = merge("antThorax", [
    plate(2.0, 0.3, V(0, 0, 0.1), new Vector3(FWD, 0, 0)),
    plate(1.5, 0.25, V(0, 0, 0), new Vector3(FWD, 0, Math.PI / 2)),
  ]);
  // 頭部: 前を向いた板と、とさか
  const head = merge("antHead", [
    plate(1.5, 0.3, V(0, 0.05, 0.55), new Vector3(FWD, 0, 0)),
    plate(1.0, 0.2, V(0, 0.2, 0.4), new Vector3(FWD, 0, Math.PI / 2)),
  ]);
  // 腹部: 後ろ向きの大きな板を扇状に重ねる
  const abdomen = merge("antAbdomen", [
    plate(3.0, 0.35, V(0, 0.2, -1.5), new Vector3(BACK, 0, 0)),
    plate(2.4, 0.3, V(0, 0.3, -1.4), new Vector3(BACK, 0, Math.PI / 2)),
    plate(2.2, 0.25, V(0, 0.35, -1.3), new Vector3(BACK, 0, 0.6)),
    plate(2.2, 0.25, V(0, 0.35, -1.3), new Vector3(BACK, 0, -0.6)),
  ]);
  const femur = shard(scene, "antFemur", FEMUR_L, 0.4 * S, 0.25 * S);
  const tibia = shard(scene, "antTibia", TIBIA_L, 0.3 * S, 0.04 * S);
  const mandible = plate(0.9, 0.15, V(0, 0, 0.4), new Vector3(FWD, 0, 0));
  mandible.name = "antMand";
  const antenna = bakeT(shard(scene, "antAnt", 1.7 * S, 0.1 * S, 0.02 * S), Vector3.Zero(), new Vector3(0, -Math.PI / 2, 0));
  const eyes = merge("antEyes", [
    plate(0.45, 0.12, V(0.42, 0.2, 0.75), new Vector3(FWD, 0, 0.4)),
    plate(0.45, 0.12, V(-0.42, 0.2, 0.75), new Vector3(FWD, 0, -0.4)),
  ]);
  const t: AntTemplates = { thorax, head, abdomen, femur, tibia, mandible, antenna, eyes };
  for (const m of Object.values(t)) {
    m.material = m === eyes ? glow : shell;
    hideTemplate(m);
  }
  cache.set(scene, t);
  return t;
}

/** 影を落とすためにテンプレートを登録 */
export function antTemplateMeshes(scene: Scene): Mesh[] {
  return Object.values(templates(scene));
}

interface Leg {
  femur: InstancedMesh;
  tibia: InstancedMesh;
  side: number;
  zf: number;
  phase: number;
}

type AntState = "chase" | "windup" | "spray" | "recover" | "bite";

export class Ant extends GroundEnemy {
  private thorax: InstancedMesh;
  private head: InstancedMesh;
  private abdomen: InstancedMesh;
  private legs: Leg[] = [];
  private gait = 0;
  private state: AntState = "chase";
  private stateT = 0;
  private cooldown = rand(0.5, 2.5);
  private biteCd = 0;
  private flank = rand(-1, 1);
  private wanderTarget: Vector3 | null = null;
  private wanderWait = rand(0, 3);
  private repositionT = 0;
  private abdomenCurl = 0;

  constructor(ctx: GameContext, pos: Vector3, group: number) {
    super(ENEMIES.ant, ctx, pos, group);
    const T = templates(ctx.scene);
    const inst = (m: Mesh, parent: TransformNode, p: Vector3) => {
      const i = m.createInstance(m.name + this.id);
      i.parent = parent;
      i.position.copyFrom(p);
      i.rotationQuaternion = Quaternion.Identity();
      i.isPickable = false;
      return i;
    };
    this.thorax = inst(T.thorax, this.root, new Vector3(0, 1.2 * S, 0));
    const P = (x: number, y: number, z: number) => new Vector3(x * S, y * S, z * S);
    this.head = inst(T.head, this.thorax, P(0, 0.15, 0.85));
    inst(T.eyes, this.head, Vector3.Zero());
    this.abdomen = inst(T.abdomen, this.thorax, P(0, 0.05, -0.85));
    for (const sx of [-1, 1]) {
      const m = inst(T.mandible, this.head, P(sx * 0.25, -0.2, 1.05));
      m.rotationQuaternion = Quaternion.RotationYawPitchRoll(-sx * 0.35, 0.2, 0);
      const a = inst(T.antenna, this.head, P(sx * 0.3, 0.4, 0.9));
      a.rotationQuaternion = Quaternion.RotationYawPitchRoll(sx * 0.5, -0.7, 0);
    }
    const zs = [0.5, 0.0, -0.5];
    const zf = [0.6, 0.05, -0.55];
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const femur = inst(T.femur, this.thorax, P(sx * 0.5, -0.2, zs[i]));
        const tibia = inst(T.tibia, femur, new Vector3(FEMUR_L, 0, 0));
        // 三脚歩行: 左前・右中・左後 と 右前・左中・右後 が交互に動く
        const phase = (i + (sx > 0 ? 1 : 0)) % 2 === 0 ? 0 : Math.PI;
        this.legs.push({ femur, tibia, side: sx, zf: zf[i], phase });
      }
    }
    this.root.rotationQuaternion = Quaternion.RotationYawPitchRoll(this.yaw, 0, 0);
    this.position.y = ctx.city.heightAt(pos.x, pos.z);

    this.hitSpheres = [
      { local: P(0, 1.2, 0), r: 1.1 * S, world: new Vector3(), mult: 1 },
      { local: P(0, 1.35, 1.5), r: 0.85 * S, world: new Vector3(), mult: 1.5 },
      { local: P(0, 1.5, -2.3), r: 1.4 * S, world: new Vector3(), mult: 0.9 },
    ];
    const V = (x: number, y: number, z: number) => new Vector3(x, y, z);
    this.rig = [
      { node: this.thorax, parent: -1, size: P(1.4, 0.8, 1.8), center: V(0, 0, 0), mass: 250 },
      { node: this.head, parent: 0, size: P(1.2, 0.8, 1.2), center: P(0, 0.05, 0.55), mass: 90, swing: 0.6 },
      { node: this.abdomen, parent: 0, size: P(1.8, 1.4, 2.6), center: P(0, 0.25, -1.5), mass: 280, swing: 0.6 },
      ...this.legs.flatMap((l, i) => [
        { node: l.femur, parent: 0, size: V(FEMUR_L, 0.35 * S, 0.35 * S), center: V(FEMUR_L / 2, 0, 0), mass: 20, swing: 0.9 },
        { node: l.tibia, parent: 3 + i * 2, size: V(TIBIA_L, 0.25 * S, 0.25 * S), center: V(TIBIA_L / 2, 0, 0), mass: 12, swing: 1.0 },
      ]),
    ];
    this.animateLegs(0, 0);
    this.updateHitSpheres();
  }

  center(): Vector3 {
    return this.hitSpheres[0].world.clone();
  }

  update(dt: number) {
    this.t += dt;
    this.stagger = Math.max(0, this.stagger - dt);
    this.biteCd = Math.max(0, this.biteCd - dt);
    if (this.updateAir(dt)) {
      this.applyOrientation(dt);
      this.animateLegs(dt, 1.5);
      return;
    }
    if (!this.active) this.idle(dt);
    else this.combat(dt);
    this.applyOrientation(dt);
    this.animateLegs(dt, this.moveSpeed);
    // 腹部の曲げ（酸の噴射姿勢）
    const curlTarget = this.state === "windup" || this.state === "spray" ? 1 : 0;
    this.abdomenCurl += (curlTarget - this.abdomenCurl) * Math.min(1, dt * 8);
    this.abdomen.rotationQuaternion = Quaternion.RotationYawPitchRoll(0, -0.15 + this.abdomenCurl * 0.9, 0);
    this.head.rotationQuaternion = Quaternion.RotationYawPitchRoll(Math.sin(this.t * 2.3) * 0.12, Math.sin(this.t * 1.7) * 0.08, 0);
  }

  private idle(dt: number) {
    // 非アクティブ: 巣の周りをうろうろする
    this.state = "chase";
    if (this.distToPlayerH() < this.def.detectRange) {
      this.ctx.enemies.alert(this);
      return;
    }
    if (!this.wanderTarget) {
      this.moveSpeed = 0;
      this.wanderWait -= dt;
      if (this.wanderWait <= 0) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 14;
        this.wanderTarget = this.home.add(new Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
      }
      return;
    }
    const to = this.wanderTarget.subtract(this.position);
    to.y = 0;
    const d = to.length();
    if (d < 1.5) {
      this.wanderTarget = null;
      this.wanderWait = rand(1.5, 5);
      return;
    }
    to.scaleInPlace(1 / d);
    this.turnTo(yawOf(to), 2, dt);
    const f = new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.walk(f, 2.6, dt);
  }

  private combat(dt: number) {
    const player = this.ctx.player;
    const pp = player.position;
    const to = pp.subtract(this.position);
    to.y = 0;
    const dist = to.length();
    to.scaleInPlace(1 / Math.max(0.01, dist));
    this.cooldown -= dt;
    this.stateT += dt;
    // 被弾中は怯んで攻撃が中断される（先頭の敵の連続攻撃を止められる）
    if (this.stagger > 0) {
      if (this.state !== "chase") {
        this.state = "chase";
        this.stateT = 0;
      }
      this.cooldown = Math.max(this.cooldown, 0.35);
      this.biteCd = Math.max(this.biteCd, 0.35);
      this.turnTo(yawOf(to), 2, dt);
      const stop = dist < this.def.radius + 1.5 ? 0 : 1;
      this.walk(new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)), this.def.speed * 0.2 * stop, dt);
      return;
    }

    switch (this.state) {
      case "chase": {
        // 噛みつき
        if (dist < this.def.radius + 3 && this.biteCd <= 0 && player.alive) {
          this.state = "bite";
          this.stateT = 0;
          break;
        }
        // 射程内で視線が通れば酸を撃つ
        const inRange = dist < this.def.attackRange && dist > this.def.radius + 5;
        if (inRange && this.cooldown <= 0 && this.repositionT <= 0 && this.climbing === 0 && player.alive) {
          const mouth = this.center().add(new Vector3(0, 1.0 * S, 0));
          if (this.canSee(mouth)) {
            this.state = "windup";
            this.stateT = 0;
            this.moveSpeed = 0;
            break;
          }
        }
        this.repositionT -= dt;
        // 左右に散開しながら近づく（包囲）
        const flankK = clamp((dist - 12) / 50, 0, 1) * this.flank * 0.9;
        const c = Math.cos(flankK),
          s = Math.sin(flankK);
        const dir = new Vector3(to.x * c - to.z * s, 0, to.x * s + to.z * c);
        this.turnTo(yawOf(dir), 3.5, dt);
        const f = new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        const stop = dist < this.def.radius + 1.5 ? 0 : 1;
        this.walk(f, this.def.speed * stop, dt);
        break;
      }
      case "windup":
        this.turnTo(yawOf(to), 4, dt);
        this.moveSpeed = 0;
        if (this.stateT > 0.5) {
          this.state = "spray";
          this.stateT = 0;
          this.sprayAcid();
        }
        break;
      case "spray":
        this.moveSpeed = 0;
        if (this.stateT > 0.35) {
          this.state = "recover";
          this.stateT = 0;
        }
        break;
      case "recover":
        this.moveSpeed = 0;
        if (this.stateT > 0.45) {
          this.state = "chase";
          this.cooldown = this.def.attackInterval * rand(0.8, 1.4);
          if (Math.random() < 0.45) this.repositionT = rand(1, 2.5);
        }
        break;
      case "bite":
        this.turnTo(yawOf(to), 6, dt);
        this.moveSpeed = 0;
        if (this.stateT > 0.25 && this.biteCd <= 0) {
          if (dist < this.def.radius + 4) {
            player.takeDamage(18 * this.ctx.difficulty.enemyDamage, this.position, 3);
            sfx.squish(this.position);
          }
          this.biteCd = 1.4;
        }
        if (this.stateT > 0.6) {
          this.state = "chase";
          this.stateT = 0;
        }
        break;
    }
  }

  private sprayAcid() {
    // 腹部の先端から酸を放物線で一斉に飛ばす
    this.thorax.computeWorldMatrix(true);
    const tip = this.center().add(new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).scale(1.6 * S)).add(new Vector3(0, 0.6 * S, 0));
    const target = this.ctx.player.chest.clone();
    const speed = 42;
    const base = ballisticVelocity(tip, target, speed, GRAVITY);
    const dir = base.normalizeToNew();
    const n = 11;
    for (let i = 0; i < n; i++) {
      const v = spreadDir(dir, 5.5).scale(speed * rand(0.92, 1.06));
      this.ctx.projectiles.spawnEnemy("acid", tip, v, this.def.damage * this.ctx.difficulty.enemyDamage);
    }
    sfx.enemyShot(tip, "acid");
  }

  private animateLegs(dt: number, speed: number) {
    const moving = Math.min(1, speed / 4);
    this.gait += dt * (2 + speed * 1.1);
    const thoraxInvTmp = new Quaternion();
    for (const l of this.legs) {
      const ph = this.gait + l.phase;
      const swing = Math.sin(ph) * 0.45 * moving;
      const lift = Math.max(0, Math.cos(ph)) * 0.35 * moving;
      const fd = new Vector3(l.side * 0.75, 0.35 + lift, l.zf + swing);
      const fq = fromToQuat(Vector3.Right(), fd, l.femur.rotationQuaternion!);
      // 脛は胴体空間で下向き → 腿ローカルへ変換
      const td = new Vector3(l.side * 0.42, -1, l.zf * 0.5 + swing * 0.6);
      Quaternion.InverseToRef(fq, thoraxInvTmp);
      const local = td.rotateByQuaternionToRef(thoraxInvTmp, new Vector3());
      fromToQuat(Vector3.Right(), local, l.tibia.rotationQuaternion!);
    }
  }

  protected onDeath(dir: Vector3, force: number) {
    sfx.squish(this.position);
    const v = new Vector3(dir.x, 0, dir.z).scale(force * 0.5).add(new Vector3(0, 2 + force * 0.25, 0));
    this.ragdollize(v, 1.5 + force * 0.05);
  }
}
