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
import { bakeT, glowMaterial, merge, shellMaterial } from "./AlienShapes";
import { crescent, gem, poseLeg, slab, spike } from "./AnchorShapes";
import { ENEMIES } from "../data/enemies";
import type { GameContext } from "../core/GameContext";
import { GroundEnemy } from "./Enemy";
import { ballisticVelocity, clamp, rand, yawOf } from "../core/MathUtil";
import { GRAVITY } from "../core/Physics";
import { spreadDir } from "../combat/Weapon";
import { sfx } from "../core/Audio";

interface AntTemplates {
  thorax: Mesh;
  thoraxAcc: Mesh;
  head: Mesh;
  abdomen: Mesh;
  abdomenAcc: Mesh;
  femur: Mesh;
  tibia: Mesh;
  mandible: Mesh;
  eyes: Mesh;
}

/** 体の大きさの倍率（全長 約10m。人間の約5〜6倍） */
const S = 1.6;
const FEMUR_L = 1.7 * S;
const TIBIA_L = 2.3 * S;
const cache = new WeakMap<Scene, AntTemplates>();

/** +X 方向へ伸びる先細りの脚パーツ */
export function limb(scene: Scene, name: string, len: number, d0: number, d1: number) {
  const c = MeshBuilder.CreateCylinder(name, { height: len, diameterTop: d1, diameterBottom: d0, tessellation: 8 }, scene);
  return bakeT(c, new Vector3(len / 2, 0, 0), new Vector3(0, 0, -Math.PI / 2));
}

export function hideTemplate(m: Mesh) {
  m.isPickable = false;
  m.receiveShadows = true;
  m.position.y = -2000;
  m.alwaysSelectAsActiveMesh = true;
}

/*
 * 造形（アンカー大型級・甲殻型）:
 *  蟻をそのまま写さず、ラフ画の敵のように「面取りした分厚い装甲板」を重ねたゴツい体にする。
 *  ・胸部: 多面体の芯の上に、前から後ろへ重なる3枚の背甲と、左右に張り出す肩甲
 *  ・頭部: くさび形の重い頭。正面中央に赤く光る小さな眼が縦に並ぶ。下に鎌状の大顎
 *  ・腹部: 後ろへ下がる3つの体節。先端に酸の噴射口
 *  ・脚: 4本。分厚い腿と、三日月形の鎌のような脛で地面に突き立つ
 */
function templates(scene: Scene): AntTemplates {
  const c = cache.get(scene);
  if (c) return c;
  // 黒曜石のような外殻＋赤い装甲縁＋赤く光る眼
  const shell = shellMaterial(scene, "antShell", new Color3(0.04, 0.036, 0.045), 0.65, 0.3);
  const accent = shellMaterial(scene, "antAccent", new Color3(0.26, 0.035, 0.03), 0.5, 0.35);
  const glow = glowMaterial(scene, "antGlow", new Color3(3.2, 0.25, 0.12));
  const V = (x: number, y: number, z: number) => new Vector3(x * S, y * S, z * S);
  const R = (x: number, y: number, z: number) => new Vector3(x, y, z);
  const sl = (x: number, y: number, z: number, p: Vector3, r = R(0, 0, 0)) => slab(scene, "sl", x * S, y * S, z * S, p, r);

  const thorax = merge("antThorax", [
    gem(scene, "core", 3, 1.7 * S, 1.2 * S, 1.9 * S, V(0, 0, 0)),
    // 背甲（前から後ろへ重なる）
    sl(1.9, 0.55, 1.0, V(0, 0.55, 0.45), R(-0.35, 0, 0)),
    sl(2.1, 0.6, 1.0, V(0, 0.7, -0.05), R(-0.1, 0, 0)),
    sl(1.9, 0.55, 0.9, V(0, 0.6, -0.55), R(0.25, 0, 0)),
    // 腹側
    sl(1.3, 0.4, 1.6, V(0, -0.5, 0)),
  ]);
  // 肩甲: 左右に大きく張り出す板（ラフ画の上部の塊）
  const thoraxAcc = merge("antThoraxAcc", [
    sl(1.3, 0.45, 1.3, V(1.05, 0.55, 0.2), R(0, 0.2, -0.55)),
    sl(1.3, 0.45, 1.3, V(-1.05, 0.55, 0.2), R(0, -0.2, 0.55)),
    spike(scene, "sp", 1.1 * S, 0.5 * S, 0.25 * S, V(0, 0.95, 0.1), R(0, Math.PI / 2, Math.PI / 2 - 0.5)),
  ]);
  const head = merge("antHead", [
    // くさび形の頭: 上の重い装甲と、前へ突き出す額
    sl(1.6, 0.8, 1.3, V(0, 0, 0.55)),
    sl(1.75, 0.5, 1.2, V(0, 0.42, 0.65), R(0.3, 0, 0)),
    sl(1.1, 0.45, 0.9, V(0, 0.05, 1.2), R(0.5, 0, 0)),
    sl(1.2, 0.35, 0.9, V(0, -0.38, 0.85), R(-0.2, 0, 0)),
    // 頬の装甲
    sl(0.5, 0.8, 1.0, V(0.78, -0.05, 0.6), R(0, 0.25, 0.2)),
    sl(0.5, 0.8, 1.0, V(-0.78, -0.05, 0.6), R(0, -0.25, -0.2)),
  ]);
  const eyes = merge("antEyes", [
    gem(scene, "e", 1, 0.26 * S, 0.22 * S, 0.2 * S, V(0, 0.2, 1.42)),
    gem(scene, "e", 1, 0.18 * S, 0.15 * S, 0.15 * S, V(0, -0.02, 1.48)),
    gem(scene, "e", 1, 0.14 * S, 0.12 * S, 0.12 * S, V(0.28, 0.12, 1.35)),
    gem(scene, "e", 1, 0.14 * S, 0.12 * S, 0.12 * S, V(-0.28, 0.12, 1.35)),
  ]);
  // 大顎: 内側へ曲がる小さな鎌
  const mandible = bakeT(crescent(scene, "antMand", 1.0 * S, 0.35 * S, 0.22 * S, 0.3), Vector3.Zero(), R(-Math.PI / 2, 0, 0));
  const abdomen = merge("antAbdomen", [
    sl(1.9, 1.35, 1.4, V(0, 0.1, -0.6), R(0.15, 0, 0)),
    sl(1.6, 1.15, 1.3, V(0, -0.05, -1.6), R(0.35, 0, 0)),
    sl(1.2, 0.9, 1.2, V(0, -0.35, -2.45), R(0.6, 0, 0)),
    sl(0.7, 0.6, 0.8, V(0, -0.75, -3.0), R(0.9, 0, 0)),
  ]);
  // 体節ごとの背中のとげと、噴射口まわりの赤い縁
  const abdomenAcc = merge("antAbdomenAcc", [
    spike(scene, "sp", 0.9 * S, 0.5 * S, 0.2 * S, V(0, 0.75, -0.6), R(0, Math.PI / 2, Math.PI / 2 + 0.6)),
    spike(scene, "sp", 0.8 * S, 0.45 * S, 0.2 * S, V(0, 0.55, -1.6), R(0, Math.PI / 2, Math.PI / 2 + 0.9)),
    spike(scene, "sp", 0.6 * S, 0.4 * S, 0.18 * S, V(0, 0.15, -2.45), R(0, Math.PI / 2, Math.PI / 2 + 1.2)),
    sl(0.95, 0.25, 0.95, V(0, -0.95, -3.15), R(0.9, 0, 0)),
  ]);
  // 腿: 分厚い装甲の塊（+X 方向へ伸びる）
  const femur = merge("antFemur", [
    slab(scene, "f", FEMUR_L * 1.05, 0.65 * S, 0.7 * S, new Vector3(FEMUR_L / 2, 0, 0)),
    spike(scene, "sp", 0.7 * S, 0.35 * S, 0.2 * S, new Vector3(FEMUR_L * 0.75, 0.25 * S, 0), R(0, 0, 0.9)),
  ]);
  // 脛: 三日月形の鎌
  const tibia = crescent(scene, "antTibia", TIBIA_L, 0.75 * S, 0.4 * S, 0.22);
  tibia.name = "antTibia";
  const t: AntTemplates = { thorax, thoraxAcc, head, abdomen, abdomenAcc, femur, tibia, mandible, eyes };
  for (const m of Object.values(t)) {
    m.material = m === eyes ? glow : m === thoraxAcc || m === abdomenAcc || m === mandible ? accent : shell;
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
  private mandibles: InstancedMesh[] = [];

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
    this.thorax = inst(T.thorax, this.root, new Vector3(0, 1.45 * S, 0));
    inst(T.thoraxAcc, this.thorax, Vector3.Zero());
    const P = (x: number, y: number, z: number) => new Vector3(x * S, y * S, z * S);
    this.head = inst(T.head, this.thorax, P(0, 0.1, 0.8));
    inst(T.eyes, this.head, Vector3.Zero());
    this.abdomen = inst(T.abdomen, this.thorax, P(0, 0.1, -0.85));
    inst(T.abdomenAcc, this.abdomen, Vector3.Zero());
    for (const sx of [-1, 1]) {
      const m = inst(T.mandible, this.head, P(sx * 0.45, -0.45, 1.1));
      // 鎌の先が前方の内側を向くように
      m.rotationQuaternion = Quaternion.RotationYawPitchRoll(-Math.PI / 2 - sx * 1.05, 0.25, sx > 0 ? 0 : Math.PI);
      this.mandibles.push(m);
    }
    // 4本脚。対角の脚が同時に動く（速歩）
    const zs = [0.45, -0.45];
    const zf = [0.75, -0.7];
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const femur = inst(T.femur, this.thorax, P(sx * 0.85, 0.1, zs[i]));
        const tibia = inst(T.tibia, femur, new Vector3(FEMUR_L * 0.95, 0, 0));
        const phase = (i + (sx > 0 ? 1 : 0)) % 2 === 0 ? 0 : Math.PI;
        this.legs.push({ femur, tibia, side: sx, zf: zf[i], phase });
      }
    }
    this.root.rotationQuaternion = Quaternion.RotationYawPitchRoll(this.yaw, 0, 0);
    this.position.y = ctx.city.heightAt(pos.x, pos.z);

    this.hitSpheres = [
      { local: P(0, 1.55, 0), r: 1.25 * S, world: new Vector3(), mult: 1 },
      { local: P(0, 1.6, 1.6), r: 0.9 * S, world: new Vector3(), mult: 1.5 },
      { local: P(0, 1.4, -2.3), r: 1.3 * S, world: new Vector3(), mult: 0.9 },
    ];
    const V = (x: number, y: number, z: number) => new Vector3(x, y, z);
    this.rig = [
      { node: this.thorax, parent: -1, size: P(2.0, 1.4, 2.0), center: P(0, 0.15, 0), mass: 300 },
      { node: this.head, parent: 0, size: P(1.6, 1.1, 1.5), center: P(0, 0.05, 0.7), mass: 110, swing: 0.6 },
      { node: this.abdomen, parent: 0, size: P(1.7, 1.2, 2.8), center: P(0, -0.2, -1.6), mass: 280, swing: 0.6 },
      ...this.legs.flatMap((l, i) => [
        { node: l.femur, parent: 0, size: V(FEMUR_L, 0.6 * S, 0.6 * S), center: V(FEMUR_L / 2, 0, 0), mass: 30, swing: 0.9 },
        { node: l.tibia, parent: 3 + i * 2, size: V(TIBIA_L * 0.9, 0.5 * S, 0.35 * S), center: V(TIBIA_L * 0.45, 0.15 * S, 0), mass: 18, swing: 1.0 },
      ]),
    ];
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
    this.biteCd = Math.max(0, this.biteCd - dt);
    if (this.updateAir(dt)) {
      this.applyOrientation(dt);
      this.animateLegs(dt, 1.5);
      return;
    }
    if (!this.active) this.idle(dt);
    else this.combat(dt);
    this.applyShove(dt);
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
        // 突撃型は近くまで来ないと撃たない
        const maxRange = this.temper === "rusher" ? 22 : this.def.attackRange;
        const inRange = dist < maxRange && dist > this.def.radius + 5;
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
        this.chaseMove(to, dist, dt);
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
          this.cooldown = this.def.attackInterval * rand(0.8, 1.4) * (this.temper === "rusher" ? 1.5 : this.temper === "lurker" ? 0.85 : 1);
          if (Math.random() < 0.45) this.repositionT = rand(1, 2.5);
        }
        break;
      case "bite":
        this.turnTo(yawOf(to), 6, dt);
        this.moveSpeed = 0;
        if (this.stateT > 0.25 && this.biteCd <= 0) {
          if (dist < this.def.radius + 4) {
            player.takeDamage(18 * this.ctx.difficulty.enemyDamage, this.position, 3, "bite");
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

  /** 性格ごとの接近の仕方 */
  private chaseMove(to: Vector3, dist: number, dt: number) {
    const stop = dist < this.def.radius + 1.5 ? 0 : 1;
    const side = this.flank >= 0 ? 1 : -1;
    const perp = new Vector3(-to.z * side, 0, to.x * side);
    switch (this.temper) {
      case "lurker": {
        // 後ろで待機: 30〜40m を保ち、近づかれたらプレイヤーを向いたまま後ずさる
        this.turnTo(yawOf(to), 3, dt);
        if (dist < 28) this.walk(to.scale(-1).addInPlace(perp.scale(0.4)).normalize(), this.def.speed * 0.55, dt);
        else if (dist < 40) this.walk(perp, this.def.speed * 0.2, dt);
        else this.walk(to, this.def.speed * 0.8, dt);
        return;
      }
      case "flanker": {
        // 回り込み: プレイヤーの横（遠いほど大きく外側）を目指し、近くなってから向き直る
        const goal = this.ctx.player.position.add(perp.scale(clamp(dist * 0.75, 0, 38))).subtract(this.position);
        goal.y = 0;
        const dir = dist < 20 ? to : goal.normalize();
        this.turnTo(yawOf(dir), 3, dt);
        this.walk(new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)), this.def.speed * 1.05 * stop, dt);
        return;
      }
      case "rusher": {
        // ひたすら前へ
        this.turnTo(yawOf(to), 4.5, dt);
        this.walk(new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)), this.def.speed * 1.15 * stop, dt);
        return;
      }
      default: {
        // 左右に少し散開しながら近づく（包囲）
        const flankK = clamp((dist - 12) / 50, 0, 1) * this.flank * 0.9;
        const c = Math.cos(flankK),
          s = Math.sin(flankK);
        const dir = new Vector3(to.x * c - to.z * s, 0, to.x * s + to.z * c);
        this.turnTo(yawOf(dir), 3.5, dt);
        this.walk(new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)), this.def.speed * stop, dt);
      }
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
    const n = 8;
    for (let i = 0; i < n; i++) {
      const v = spreadDir(dir, 5.5).scale(speed * rand(0.92, 1.06));
      this.ctx.projectiles.spawnEnemy("acid", tip, v, this.def.damage * this.ctx.difficulty.enemyDamage);
    }
    sfx.enemyShot(tip, "acid");
  }

  private animateLegs(dt: number, speed: number) {
    const moving = Math.min(1, speed / 4);
    this.gait += dt * (2.2 + speed * 1.0);
    for (const l of this.legs) {
      const ph = this.gait + l.phase;
      const swing = Math.sin(ph) * 0.5 * moving;
      const lift = Math.max(0, Math.cos(ph)) * 0.45 * moving;
      // 腿は外側へ高く張り出し、鎌は外へふくらみながら地面へ突き立つ
      const fd = new Vector3(l.side * 0.8, 0.55 + lift, l.zf + swing);
      const td = new Vector3(l.side * 0.3, -1, l.zf * 0.35 + swing * 0.5);
      poseLeg(l.femur, l.tibia, fd, td, l.side);
    }
    // 大顎をゆっくり開閉（噛みつきでは大きく）
    const open = this.state === "bite" ? 0.5 : 0.12 + Math.sin(this.t * 3.1) * 0.08;
    this.mandibles.forEach((m, i) => {
      const sx = i === 0 ? -1 : 1;
      Quaternion.RotationYawPitchRollToRef(-Math.PI / 2 - sx * (1.05 - open), 0.25, sx > 0 ? 0 : Math.PI, m.rotationQuaternion!);
    });
  }

  /** 死亡ポーズ: 虫の死骸のように脚を腹側へ強く折りたたみ、体を丸める */
  protected deathPose() {
    for (const l of this.legs) {
      const fd = new Vector3(l.side * 0.45, -0.75, l.zf * 0.3);
      const td = new Vector3(-l.side * 0.85, 0.45, -l.zf * 0.25);
      poseLeg(l.femur, l.tibia, fd, td, l.side, new Vector3(0, -1, 0));
    }
    this.head.rotationQuaternion = Quaternion.RotationYawPitchRoll(Math.sin(this.id * 7.1) * 0.15, 0.55, Math.sin(this.id * 3.7) * 0.1);
    this.abdomen.rotationQuaternion = Quaternion.RotationYawPitchRoll(Math.sin(this.id * 5.3) * 0.1, -0.5, 0);
    this.mandibles.forEach((m, i) => {
      const sx = i === 0 ? -1 : 1;
      m.rotationQuaternion = Quaternion.RotationYawPitchRoll(-Math.PI / 2 - sx * 1.35, 0.25, sx > 0 ? 0 : Math.PI);
    });
  }

  protected onDeath(dir: Vector3, force: number) {
    sfx.squish(this.position);
    // 瞬間的に死亡ポーズで固まり、軽く跳ねる（爆風なら大きく飛ぶ）
    const v = new Vector3(dir.x, 0, dir.z).scale(force * 0.2).add(new Vector3(0, 3.2 + force * 0.1, 0));
    this.rigidize(v, 0.5 + force * 0.04, true);
  }
}
