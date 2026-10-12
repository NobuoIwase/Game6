// ============================================================================
// 弾頭・敵弾の管理。
// プレイヤー: ロケット / 誘導ミサイル
// 敵: 酸（蟻）/ 糸（蜘蛛）/ レーザー機銃・爆弾（飛行型）
// ============================================================================
import { Color3, InstancedMesh, Mesh, MeshBuilder, PBRMaterial, Quaternion, StandardMaterial, Vector3 } from "@babylonjs/core";
import type { GameContext } from "../core/GameContext";
import type { WeaponDef } from "../data/weapons";
import type { Enemy } from "../enemies/Enemy";
import { FLYER_BOMB_RADIUS } from "../data/enemies";
import { GRAVITY } from "../core/Physics";
import { distSegmentSegmentSq, lookQuat } from "../core/MathUtil";

export type EnemyShotKind = "acid" | "web" | "laser" | "bomb";
type Kind = "rocket" | "missile" | EnemyShotKind;

interface Projectile {
  kind: Kind;
  mesh: InstancedMesh;
  pos: Vector3;
  prev: Vector3;
  vel: Vector3;
  life: number;
  damage: number;
  def?: WeaponDef;
  target?: Enemy | null;
  age: number;
  active: boolean;
}

const HIT_RADIUS: Record<EnemyShotKind, number> = { acid: 0.55, web: 0.45, laser: 0.4, bomb: 1.0 };
const GRAVITY_K: Record<Kind, number> = { rocket: 0, missile: 0, acid: 1, web: 0.12, laser: 0, bomb: 1 };

export class Projectiles {
  private list: Projectile[] = [];
  private templates = {} as Record<Kind, Mesh>;

  constructor(private ctx: GameContext) {
    const s = ctx.scene;
    const unlit = (name: string, c: Color3, alpha = 1) => {
      const m = new StandardMaterial(name, s);
      m.disableLighting = true;
      m.emissiveColor = c;
      m.alpha = alpha;
      return m;
    };
    const metal = new PBRMaterial("projMetal", s);
    metal.albedoColor = new Color3(0.5, 0.52, 0.5);
    metal.metallic = 0.8;
    metal.roughness = 0.4;

    // ミサイル: 本体 + 噴射炎
    const body = MeshBuilder.CreateCylinder("mslBody", { diameter: 0.18, height: 1.1, tessellation: 8 }, s);
    body.rotation.x = Math.PI / 2;
    body.material = metal;
    const flame = MeshBuilder.CreateCylinder("mslFlame", { diameterTop: 0.16, diameterBottom: 0.02, height: 0.7, tessellation: 8 }, s);
    flame.rotation.x = Math.PI / 2;
    flame.position.z = -0.85;
    flame.material = unlit("flameMat", new Color3(6, 3, 1));
    const missile = Mesh.MergeMeshes([body, flame], true, true, undefined, false, true)!;
    missile.name = "missile";
    this.templates.missile = missile;
    this.templates.rocket = missile;

    const acid = MeshBuilder.CreateSphere("acid", { diameter: 0.55, segments: 6 }, s);
    acid.scaling.z = 1.8;
    acid.material = unlit("acidMat", new Color3(1.4, 2.2, 0.2), 0.9);
    this.templates.acid = acid;
    const web = MeshBuilder.CreateBox("webShot", { width: 0.05, height: 0.05, depth: 6 }, s);
    web.material = unlit("webMat", new Color3(1.6, 1.6, 1.5), 0.8);
    this.templates.web = web;
    const laser = MeshBuilder.CreateBox("laserShot", { width: 0.16, height: 0.16, depth: 4.5 }, s);
    laser.material = unlit("laserMat", new Color3(6, 0.6, 0.3));
    this.templates.laser = laser;
    const bomb = MeshBuilder.CreateSphere("bomb", { diameter: 0.9, segments: 8 }, s);
    bomb.scaling.z = 1.5;
    const bombMat = new PBRMaterial("bombMat", s);
    bombMat.albedoColor = new Color3(0.05, 0.05, 0.06);
    bombMat.emissiveColor = new Color3(0.8, 0.1, 0.05);
    bombMat.metallic = 0.8;
    bombMat.roughness = 0.3;
    bomb.material = bombMat;
    this.templates.bomb = bomb;
    for (const m of Object.values(this.templates)) {
      m.isPickable = false;
      m.position.y = -3000;
      m.alwaysSelectAsActiveMesh = true;
    }
  }

  private get(kind: Kind): Projectile {
    const tpl = this.templates[kind];
    let p = this.list.find((q) => !q.active && q.mesh.sourceMesh === tpl);
    if (!p) {
      const mesh = tpl.createInstance(kind);
      mesh.rotationQuaternion = new Quaternion();
      mesh.isPickable = false;
      p = { kind, mesh, pos: new Vector3(), prev: new Vector3(), vel: new Vector3(), life: 0, damage: 0, age: 0, active: false };
      this.list.push(p);
    }
    p.kind = kind;
    p.active = true;
    p.age = 0;
    p.mesh.setEnabled(true);
    return p;
  }

  /** プレイヤーの弾頭 */
  launch(origin: Vector3, dir: Vector3, def: WeaponDef, target: Enemy | null) {
    const p = this.get(def.kind === "homing" ? "missile" : "rocket");
    p.pos.copyFrom(origin);
    p.prev.copyFrom(origin);
    // ミサイルは低速で射出されて加速する
    p.vel.copyFrom(dir).scaleInPlace(def.kind === "homing" ? def.speed * 0.35 : def.speed);
    p.life = def.range / def.speed + 2;
    p.def = def;
    p.damage = def.damage;
    p.target = target;
  }

  spawnEnemy(kind: EnemyShotKind, origin: Vector3, vel: Vector3, damage: number) {
    const p = this.get(kind);
    p.pos.copyFrom(origin);
    p.prev.copyFrom(origin);
    p.vel.copyFrom(vel);
    p.life = kind === "bomb" ? 8 : kind === "acid" ? 3.5 : 2.5;
    p.damage = damage;
    p.def = undefined;
    p.target = null;
  }

  update(dt: number) {
    const ctx = this.ctx;
    const player = ctx.player;
    const pFeet = player.position.add(new Vector3(0, 0.3, 0));
    const pHead = player.position.add(new Vector3(0, player.height - 0.2, 0));
    for (const p of this.list) {
      if (!p.active) continue;
      p.age += dt;
      p.life -= dt;
      p.prev.copyFrom(p.pos);
      if (p.kind === "missile" && p.def) {
        // 誘導: 目標へ向けて旋回しながら加速
        const speed = Math.min(p.def.speed * 1.6, p.vel.length() + 120 * dt);
        let dir = p.vel.normalizeToNew();
        if (p.target?.alive && p.age > 0.15) {
          const want = p.target.center().subtract(p.pos).normalize();
          const ang = Math.acos(Math.max(-1, Math.min(1, Vector3.Dot(dir, want))));
          const maxA = (p.def.turnRate ?? 3) * dt * (1 + p.age);
          if (ang > 1e-4) {
            const axis = Vector3.Cross(dir, want);
            if (axis.lengthSquared() > 1e-8) {
              dir = dir.rotateByQuaternionToRef(Quaternion.RotationAxis(axis.normalize(), Math.min(ang, maxA)), new Vector3());
            }
          }
        }
        p.vel.copyFrom(dir.scale(speed));
        ctx.effects.trail(p.pos);
      } else if (p.kind === "rocket") {
        ctx.effects.trail(p.pos);
      }
      p.vel.y += GRAVITY * GRAVITY_K[p.kind] * dt;
      p.pos.addInPlace(p.vel.scale(dt));

      // ---- 衝突判定 ----
      const wh = ctx.city.segment(p.prev, p.pos);
      const segLen = Vector3.Distance(p.prev, p.pos);
      if (p.kind === "rocket" || p.kind === "missile") {
        const eh = ctx.enemies.segment(p.prev, p.pos, 0.3);
        const ch = ctx.corpseSegment(p.prev, p.pos);
        const hitT = Math.min(eh ? eh.dist : Infinity, wh ? wh.dist : Infinity, ch ?? Infinity);
        if (hitT <= segLen || p.life <= 0) {
          const at = hitT <= segLen ? p.prev.add(p.vel.normalizeToNew().scale(hitT)) : p.pos;
          this.explodePlayer(p, at);
          continue;
        }
      } else {
        // 死骸に当たった敵弾は止まる（死骸が壁になる）
        const ch = ctx.corpseSegment(p.prev, p.pos);
        if (ch !== null && (!wh || ch < wh.dist)) {
          const at = p.prev.add(p.vel.normalizeToNew().scale(ch));
          if (p.kind === "bomb") {
            ctx.explode({ pos: at, radius: FLYER_BOMB_RADIUS, damage: p.damage, knockback: 14, source: "enemy", buildingDamage: 0.4 });
          } else ctx.effects.puff(at, 1, 0.4);
          this.release(p);
          continue;
        }
        const r = HIT_RADIUS[p.kind];
        const hitPlayer = player.alive && !player.invulnerable && distSegmentSegmentSq(p.prev, p.pos, pFeet, pHead) < (r + 0.4) * (r + 0.4);
        if (hitPlayer) {
          this.hitPlayer(p);
          continue;
        }
        if (wh || p.life <= 0) {
          if (p.kind === "bomb") {
            ctx.explode({ pos: wh ? wh.point : p.pos, radius: FLYER_BOMB_RADIUS, damage: p.damage, knockback: 14, source: "enemy", buildingDamage: 0.4 });
          } else if (wh) {
            if (p.kind === "acid") ctx.effects.puff(wh.point, 1, 0.4);
            else if (p.kind === "laser") ctx.effects.impact(wh.point, wh.normal);
          }
          this.release(p);
          continue;
        }
      }
      p.mesh.position.copyFrom(p.pos);
      lookQuat(p.vel, p.mesh.rotationQuaternion!);
    }
  }

  private hitPlayer(p: Projectile) {
    const ctx = this.ctx;
    const player = ctx.player;
    switch (p.kind) {
      case "acid":
        player.takeDamage(p.damage, p.prev, 0);
        ctx.effects.hitEnemy(player.chest, p.vel.normalizeToNew(), "ant");
        break;
      case "web":
        player.takeDamage(p.damage, p.prev, 0);
        player.addBind(16);
        break;
      case "laser":
        player.takeDamage(p.damage, p.prev, 0);
        ctx.effects.impact(player.chest, p.vel.normalizeToNew().scale(-1));
        break;
      case "bomb":
        ctx.explode({ pos: p.pos, radius: FLYER_BOMB_RADIUS, damage: p.damage, knockback: 14, source: "enemy", buildingDamage: 0.4 });
        break;
    }
    this.release(p);
  }

  private explodePlayer(p: Projectile, at: Vector3) {
    const d = p.def!;
    this.ctx.explode({ pos: at, radius: d.blastRadius, damage: d.damage, knockback: d.knockback, source: "player", buildingDamage: d.buildingDamage });
    this.release(p);
  }

  private release(p: Projectile) {
    p.active = false;
    p.target = null;
    p.mesh.setEnabled(false);
  }

  clear() {
    for (const p of this.list) this.release(p);
  }
}
