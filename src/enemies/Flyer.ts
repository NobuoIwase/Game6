// ============================================================================
// 飛行型侵略兵器（編隊飛行）
// ----------------------------------------------------------------------------
// イメージ画像の「編隊を組み飛行するてき」「曲がる時はひっくり返る」
// 「絨毯爆撃が射撃から爆弾へ」を再現する。
//  ・隊長機（編隊の先頭）が飛行経路を決め、僚機は隊長機に対する相対位置を保つ
//  ・旋回時は大きくバンクし、急旋回ではほぼ裏返る
//  ・最初は機銃掃射の航過を繰り返し、数回ごとに絨毯爆撃の航過に切り替わる
// ============================================================================
import { Color3, InstancedMesh, Mesh, MeshBuilder, PBRMaterial, Quaternion, Scene, Vector3 } from "@babylonjs/core";
import { ENEMIES, FLYER_BOMB_DAMAGE } from "../data/enemies";
import type { GameContext } from "../core/GameContext";
import { Enemy } from "./Enemy";
import { angleDiff, clamp, damp, rand } from "../core/MathUtil";
import { spreadDir } from "../combat/Weapon";
import { sfx } from "../core/Audio";
import { hideTemplate } from "./Ant";
import { Ragdoll } from "../core/Physics";

interface FlyerTemplates {
  hull: Mesh;
  wingL: Mesh;
  wingR: Mesh;
  core: Mesh;
}
const cache = new WeakMap<Scene, FlyerTemplates>();

function templates(scene: Scene): FlyerTemplates {
  const c = cache.get(scene);
  if (c) return c;
  const metal = new PBRMaterial("flyerMetal", scene);
  metal.albedoColor = new Color3(0.2, 0.21, 0.23);
  metal.metallic = 0.85;
  metal.roughness = 0.28;
  const glow = new PBRMaterial("flyerGlow", scene);
  glow.albedoColor = new Color3(0.2, 0.02, 0);
  glow.emissiveColor = new Color3(3, 0.5, 0.1);

  // 胴体: 三角柱を平たくした矢じり形（+Z が機首）
  const hull = MeshBuilder.CreateCylinder("flHull", { diameter: 3.2, height: 0.7, tessellation: 3 }, scene);
  hull.rotation.y = -Math.PI / 2; // 頂点を +Z に向ける
  hull.scaling.set(1, 1, 1.5);
  hull.bakeCurrentTransformIntoVertices();
  const dorsal = MeshBuilder.CreateSphere("flDorsal", { diameter: 1.4, segments: 10 }, scene);
  dorsal.scaling.set(0.8, 0.45, 1.6);
  dorsal.position.set(0, 0.3, -0.2);
  dorsal.bakeCurrentTransformIntoVertices();
  const hullM = Mesh.MergeMeshes([hull, dorsal], true)!;
  hullM.name = "flyerHull";
  hullM.material = metal;

  // 主翼（後退角のついた三角形）。原点は付け根
  const wing = (side: number) => {
    const w = MeshBuilder.CreateCylinder("flWing", { diameter: 3.6, height: 0.16, tessellation: 3 }, scene);
    w.rotation.y = side > 0 ? 0 : Math.PI;
    w.scaling.set(1.1, 1, 0.7);
    w.position.set(side * 1.6, 0, -0.9);
    w.bakeCurrentTransformIntoVertices();
    w.material = metal;
    w.name = side > 0 ? "flWingR" : "flWingL";
    return w;
  };
  const core = MeshBuilder.CreateSphere("flCore", { diameter: 0.7, segments: 8 }, scene);
  core.position.set(0, -0.15, 1.6);
  const eng1 = MeshBuilder.CreateCylinder("flEng", { diameter: 0.5, height: 0.2, tessellation: 10 }, scene);
  eng1.rotation.x = Math.PI / 2;
  eng1.position.set(0.7, 0, -1.6);
  const eng2 = eng1.clone("flEng2");
  eng2.position.x = -0.7;
  const coreM = Mesh.MergeMeshes([core, eng1, eng2], true)!;
  coreM.name = "flyerCore";
  coreM.material = glow;
  const t: FlyerTemplates = { hull: hullM, wingL: wing(-1), wingR: wing(1), core: coreM };
  for (const m of Object.values(t)) hideTemplate(m);
  cache.set(scene, t);
  return t;
}

export function flyerTemplateMeshes(scene: Scene): Mesh[] {
  return Object.values(templates(scene));
}

/** 編隊（隊長機の飛行ロジックを持つ） */
export class FlyerSquad {
  members: Flyer[] = [];
  phase: "patrol" | "approach" | "extend" = "patrol";
  pass = 0;
  bombing = false;
  phaseT = 0;
  target = new Vector3();
  side = 1;
  orbitAngle = Math.random() * Math.PI * 2;

  constructor(
    public home: Vector3,
    public formation: "v" | "line" | "wedge",
  ) {}

  get leader(): Flyer | undefined {
    return this.members.find((m) => m.alive);
  }

  /** 編隊内での位置（隊長機ローカル: x 右, y 上, z 前） */
  slot(index: number): Vector3 {
    const sp = 7;
    if (this.formation === "line") return new Vector3((index % 2 ? 1 : -1) * Math.ceil(index / 2) * sp, 0, 0);
    if (this.formation === "wedge") {
      const row = Math.floor((index + 1) / 3);
      const col = ((index + 1) % 3) - 1;
      return new Vector3(col * sp, row * 1.5, -row * sp);
    }
    // V 字
    const k = Math.ceil(index / 2);
    return new Vector3((index % 2 ? 1 : -1) * k * sp, k * 0.8, -k * sp * 0.9);
  }
}

export class Flyer extends Enemy {
  squad: FlyerSquad;
  slotIndex = 0;
  heading = new Vector3(0, 0, 1);
  speed = 0;
  bank = 0;
  private hull: InstancedMesh;
  private wingL: InstancedMesh;
  private wingR: InstancedMesh;
  private gunCd = 0;
  private bombCd = 0;
  private prevYaw = 0;
  private yawRate = 0;

  constructor(ctx: GameContext, pos: Vector3, group: number, squad: FlyerSquad, slot: number) {
    super(ENEMIES.flyer, ctx, pos, group);
    this.squad = squad;
    this.slotIndex = slot;
    const T = templates(ctx.scene);
    const inst = (m: Mesh) => {
      const i = m.createInstance(m.name + this.id);
      i.parent = this.root;
      i.position.setAll(0); // createInstance は元メッシュの位置を引き継ぐので戻す
      i.rotationQuaternion = Quaternion.Identity();
      i.isPickable = false;
      return i;
    };
    this.hull = inst(T.hull);
    this.wingL = inst(T.wingL);
    this.wingR = inst(T.wingR);
    const core = inst(T.core);
    core.parent = this.hull;
    this.hitSpheres = [
      { local: new Vector3(0, 0, 0.6), r: 1.6, world: new Vector3(), mult: 1 },
      { local: new Vector3(2.4, 0, -1.1), r: 1.1, world: new Vector3(), mult: 1 },
      { local: new Vector3(-2.4, 0, -1.1), r: 1.1, world: new Vector3(), mult: 1 },
    ];
    const V = (x: number, y: number, z: number) => new Vector3(x, y, z);
    // 撃墜時は関節なしでバラバラに飛び散る
    this.rig = [
      { node: this.hull, parent: -1, size: V(2.4, 0.9, 3.6), center: V(0, 0.1, 0), mass: 200 },
      { node: this.wingL, parent: -1, size: V(3.2, 0.2, 2.2), center: V(-1.9, 0, -0.9), mass: 60 },
      { node: this.wingR, parent: -1, size: V(3.2, 0.2, 2.2), center: V(1.9, 0, -0.9), mass: 60 },
    ];
    this.speed = 14;
    this.updateHitSpheres();
  }

  center(): Vector3 {
    return this.position;
  }

  protected onActivate() {
    this.ctx.enemies.alertSquad(this.squad);
  }

  get isLeader() {
    return this.squad.leader === this;
  }

  update(dt: number) {
    this.t += dt;
    this.gunCd -= dt;
    this.bombCd -= dt;
    if (this.isLeader) this.leaderBrain(dt);
    else this.followLeader(dt);

    // 姿勢: 進行方向 + 旋回に応じたバンク（急旋回では裏返る）
    const yaw = Math.atan2(this.heading.x, this.heading.z);
    const pitch = -Math.asin(clamp(this.heading.y, -1, 1));
    this.yawRate = this.yawRate + (angleDiff(this.prevYaw, yaw) / Math.max(dt, 1e-4) - this.yawRate) * damp(6, dt);
    this.prevYaw = yaw;
    const targetBank = clamp(-this.yawRate * 1.6, -2.7, 2.7);
    this.bank += (targetBank - this.bank) * damp(4, dt);
    Quaternion.RotationYawPitchRollToRef(yaw, pitch, this.bank, this.root.rotationQuaternion!);
  }

  private steer(desired: Vector3, turnRate: number, speed: number, dt: number) {
    const d = desired.normalizeToNew();
    const h = this.heading;
    const ang = Math.acos(clamp(Vector3.Dot(h, d), -1, 1));
    const maxA = turnRate * dt;
    if (ang > 1e-4) {
      const t = Math.min(1, maxA / ang);
      // 球面補間で旋回
      const axis = Vector3.Cross(h, d);
      if (axis.lengthSquared() < 1e-8) axis.copyFrom(Vector3.Up());
      axis.normalize();
      const q = Quaternion.RotationAxis(axis, ang * t);
      h.rotateByQuaternionToRef(q, h).normalize();
    }
    this.speed += (speed - this.speed) * damp(1.5, dt);
    this.position.addInPlace(h.scale(this.speed * dt));
    this.avoidBuildings(dt);
  }

  private avoidBuildings(dt: number) {
    const p = this.position;
    const ahead = p.add(this.heading.scale(25));
    const g = Math.max(this.ctx.city.heightAt(ahead.x, ahead.z), this.ctx.city.heightAt(p.x, p.z));
    if (p.y < g + 10) p.y += Math.min(g + 10 - p.y, 25 * dt);
    if (p.y < 8) p.y = 8;
    this.ctx.city.clampToMap(p, -60);
  }

  private leaderBrain(dt: number) {
    const sq = this.squad;
    const player = this.ctx.player;
    sq.phaseT += dt;
    if (!this.active) {
      // 待機: 上空を周回
      sq.orbitAngle += dt * 0.22;
      const r = 45;
      const tgt = sq.home.add(new Vector3(Math.cos(sq.orbitAngle) * r, 55 - sq.home.y, Math.sin(sq.orbitAngle) * r));
      this.steer(tgt.subtract(this.position), 0.8, 16, dt);
      const pd = Vector3.Distance(player.position, this.position);
      if (pd < this.def.detectRange) this.ctx.enemies.alert(this);
      return;
    }
    const pp = player.position;
    const alt = sq.bombing ? 34 : 42;
    switch (sq.phase) {
      case "patrol":
        sq.phase = "extend";
        sq.phaseT = 2;
        break;
      case "approach": {
        // プレイヤー上空（横に少しずらす）を通過する
        const toP = pp.subtract(this.position);
        toP.y = 0;
        const side = new Vector3(-toP.z, 0, toP.x).normalize().scale(sq.bombing ? 0 : sq.side * 12);
        const aim = pp.add(side).add(new Vector3(0, alt, 0));
        const toAim = aim.subtract(this.position);
        this.steer(toAim, 1.0, this.def.speed, dt);
        const hd = Math.hypot(toAim.x, toAim.z);
        const facing = Vector3.Dot(new Vector3(toAim.x, 0, toAim.z).normalize(), new Vector3(this.heading.x, 0, this.heading.z).normalize());
        if (hd < 18 || (facing < 0 && sq.phaseT > 2)) {
          sq.phase = "extend";
          sq.phaseT = 0;
          sq.target = this.position.add(new Vector3(this.heading.x, 0, this.heading.z).normalize().scale(rand(110, 150)));
          sq.target.y = alt + rand(5, 15);
        }
        break;
      }
      case "extend": {
        // 通過後は直進して離脱し、反転して次の航過へ
        this.steer(sq.target.subtract(this.position), 0.9, this.def.speed * 1.1, dt);
        if (sq.phaseT > 3.5 || Vector3.Distance(sq.target, this.position) < 20) {
          sq.phase = "approach";
          sq.phaseT = 0;
          sq.pass++;
          // 2回機銃掃射したら次は爆撃、以降は交互
          sq.bombing = sq.pass >= 3 && sq.pass % 2 === 1;
          sq.side = Math.random() < 0.5 ? -1 : 1;
        }
        break;
      }
    }
    this.attack(dt);
  }

  private followLeader(dt: number) {
    const L = this.squad.leader!;
    const slot = this.squad.slot(this.slotIndex);
    const lq = L.root.rotationQuaternion!;
    // 隊長機のバンクの影響を受けないよう、方位だけで編隊位置を計算
    const yaw = Math.atan2(L.heading.x, L.heading.z);
    const off = slot.rotateByQuaternionToRef(Quaternion.RotationYawPitchRoll(yaw, 0, 0), new Vector3());
    const target = L.position.add(off);
    const to = target.subtract(this.position);
    const dist = to.length();
    // 遅れていれば加速、近ければ隊長機と同じ向き
    const desired = dist > 3 ? to.normalize().scale(Math.min(1, dist / 30)).add(L.heading.scale(1 - Math.min(1, dist / 30))) : L.heading.clone();
    this.steer(desired, 2.2, L.speed * clamp(0.9 + dist / 25, 0.8, 1.6), dt);
    void lq;
    if (this.active) this.attack(dt);
  }

  private attack(_dt: number) {
    const sq = this.squad;
    const player = this.ctx.player;
    if (!player.alive) return;
    const toP = player.chest.subtract(this.position);
    const dist = toP.length();
    if (sq.bombing) {
      // 絨毯爆撃: プレイヤー周辺の上空で一定間隔に投下
      const hd = Math.hypot(toP.x, toP.z);
      if (hd < 70 && this.bombCd <= 0) {
        this.bombCd = 0.32 + Math.random() * 0.1;
        const v = this.heading.scale(this.speed * 0.9).add(new Vector3(0, -2, 0));
        this.ctx.projectiles.spawnEnemy("bomb", this.position.add(new Vector3(0, -1.2, 0)), v, FLYER_BOMB_DAMAGE * this.ctx.difficulty.enemyDamage);
        sfx.enemyShot(this.position, "bomb");
      }
    } else if (sq.phase === "approach") {
      // 機銃掃射: 機首方向にプレイヤーがいれば連射
      const facing = Vector3.Dot(toP.scale(1 / dist), this.heading);
      if (dist < this.def.attackRange && facing > 0.8 && this.gunCd <= 0) {
        this.gunCd = this.def.attackInterval * rand(0.8, 1.6);
        const muzzle = this.position.add(this.heading.scale(2.5));
        const v = spreadDir(toP.normalize(), 3.5).scale(160);
        this.ctx.projectiles.spawnEnemy("laser", muzzle, v, this.def.damage * this.ctx.difficulty.enemyDamage);
        sfx.enemyShot(muzzle, "laser");
      }
    }
  }

  protected onKnock(dir: Vector3, knock: number) {
    // 爆風で機体が揺さぶられる
    this.heading.addInPlace(dir.scale(knock * 0.01)).normalize();
  }

  protected onDeath(dir: Vector3, force: number) {
    sfx.explosion(this.position, 0.6);
    const v = this.heading.scale(this.speed * 0.8).add(dir.scale(force * 0.3)).add(new Vector3(0, 3, 0));
    const r = new Ragdoll(this.ctx.scene, this.rig, { velocity: v, spin: 5 });
    this.ctx.addCorpse(
      r,
      this.rig.map((p) => p.node),
    );
    this.root.dispose();
  }
}
