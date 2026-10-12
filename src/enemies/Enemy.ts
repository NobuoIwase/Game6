// ============================================================================
// 敵の基底クラス。
// ----------------------------------------------------------------------------
// 地球防衛軍の敵 AI の基本:
//   ・出現直後は「非アクティブ（待機）」: その場をうろつくだけで攻撃してこない
//   ・攻撃を受ける / プレイヤーが近づく → 「アクティブ」になり襲ってくる
//   ・アクティブ化は周囲の仲間（同じ群れ・一定範囲）にも連鎖する
// 個別の行動は Ant / Spider / Flyer が実装する。
// ============================================================================
import { Matrix, Quaternion, TransformNode, Vector3 } from "@babylonjs/core";
import type { EnemyDef } from "../data/enemies";
import type { GameContext } from "../core/GameContext";
import { Ragdoll, RigPart } from "../core/Physics";
import { GRAVITY } from "../core/Physics";
import { angleDiff, clamp, damp } from "../core/MathUtil";

export interface HitSphere {
  local: Vector3;
  r: number;
  world: Vector3;
  /** 弱点（頭など）はダメージ倍率 */
  mult: number;
}

let nextId = 1;

export abstract class Enemy {
  readonly id = nextId++;
  root: TransformNode;
  hp: number;
  maxHp: number;
  alive = true;
  active = false;
  /** >0 のとき、その秒数後にアクティブ化する（連鎖の遅延） */
  activateDelay = -1;
  group: number;
  home: Vector3;
  vel = new Vector3();
  yaw = 0;
  stagger = 0;
  hitSpheres: HitSphere[] = [];
  protected rig: RigPart[] = [];
  protected t = Math.random() * 10;
  private worldMat = new Matrix();

  constructor(
    readonly def: EnemyDef,
    protected ctx: GameContext,
    pos: Vector3,
    group: number,
  ) {
    this.root = new TransformNode(def.type, ctx.scene);
    this.root.position.copyFrom(pos);
    this.root.rotationQuaternion = new Quaternion();
    this.maxHp = this.hp = def.hp * ctx.difficulty.enemyHp;
    this.group = group;
    this.home = pos.clone();
    this.yaw = Math.random() * Math.PI * 2;
  }

  get position() {
    return this.root.position;
  }

  get kind() {
    return this.def.type;
  }

  /** ロックオン・レーダー用の中心 */
  abstract center(): Vector3;
  abstract update(dt: number): void;
  protected abstract onDeath(dir: Vector3, force: number): void;

  updateHitSpheres() {
    this.root.computeWorldMatrix(true);
    this.worldMat.copyFrom(this.root.getWorldMatrix());
    for (const h of this.hitSpheres) Vector3.TransformCoordinatesToRef(h.local, this.worldMat, h.world);
  }

  /** アクティブ化（連鎖は EnemyManager が処理） */
  activate(delay = 0) {
    if (this.active || !this.alive) return;
    if (delay <= 0) {
      this.active = true;
      this.activateDelay = -1;
      this.onActivate();
    } else if (this.activateDelay < 0 || delay < this.activateDelay) {
      this.activateDelay = delay;
    }
  }

  protected onActivate() {}

  /**
   * ダメージを受ける。
   * @param dir 攻撃の向き（吹き飛ばし方向）
   * @param knock 吹き飛ばしの強さ
   */
  damage(amount: number, dir: Vector3, point: Vector3, knock: number) {
    if (!this.alive) return;
    if (!this.active) this.ctx.enemies.alert(this);
    this.hp -= amount;
    // 怯み時間: 1発ごとに最低 0.18 秒、威力が大きいほど長い
    this.stagger = Math.min(0.6, Math.max(this.stagger, 0.18) + (amount / this.maxHp) * 0.8);
    if (this.hp <= 0) {
      this.alive = false;
      this.ctx.effects.gore(this.center(), this.kind);
      this.onDeath(dir, knock + amount * 0.04);
      if (Math.random() < this.def.dropRate) this.ctx.dropItem(this.center());
      return;
    }
    this.onKnock(dir, knock, point);
  }

  protected onKnock(_dir: Vector3, _knock: number, _point: Vector3) {}

  /** パーツを物理演算に引き渡してラグドール化 */
  protected ragdollize(velocity: Vector3, spin = 2) {
    const r = new Ragdoll(this.ctx.scene, this.rig, { velocity, spin });
    this.ctx.addCorpse(
      r,
      this.rig.map((p) => p.node),
    );
    this.root.dispose();
  }

  /** プレイヤーとの距離（水平） */
  protected distToPlayerH(): number {
    const p = this.ctx.player.position;
    return Math.hypot(p.x - this.position.x, p.z - this.position.z);
  }

  /** プレイヤーまでの視線が建物に遮られていないか */
  protected canSee(from: Vector3): boolean {
    const target = this.ctx.player.chest;
    const hit = this.ctx.city.segment(from, target);
    return !hit || hit.dist > Vector3.Distance(from, target) - 1;
  }
}

/**
 * 地上を歩く敵（蟻・蜘蛛）の共通処理:
 *  ・建物に当たったら壁をよじ登り、屋上を歩き、反対側へ降りる
 *  ・爆風で吹き飛ばされると放物線を描いて落下する
 */
export abstract class GroundEnemy extends Enemy {
  airborne = false;
  climbing = 0; // -1 下降, 0 地面, +1 上昇
  pitch = 0;
  roll = 0;
  /** 胴体の高さ（見た目） */
  protected bodyHeight = 1.5;
  protected spinRate = 0;
  moveSpeed = 0;

  /** XZ 方向 dir（正規化済み）へ速度 speed で移動を試みる */
  protected walk(dir: Vector3, speed: number, dt: number) {
    const city = this.ctx.city;
    const p = this.position;
    const step = speed * dt;
    const nx = p.x + dir.x * step;
    const nz = p.z + dir.z * step;
    // 少し先の地点の高さを見る（壁の手前で登り始める）
    const look = this.def.radius * 0.45;
    const ahead = city.heightAt(p.x + dir.x * look, p.z + dir.z * look);
    const climbSpeed = speed * 0.9;
    if (ahead > p.y + 0.6) {
      // 壁を登る（水平には進まない）
      p.y = Math.min(ahead, p.y + climbSpeed * dt);
      this.climbing = 1;
    } else {
      const here = city.heightAt(nx, nz);
      if (here >= p.y - 0.6 || ahead >= p.y - 0.6) {
        // 平地を歩く（屋上の縁のわずかな隙間はそのまま進む）
        p.x = nx;
        p.z = nz;
        if (here >= p.y - 0.6) p.y = here;
        this.climbing = 0;
      } else {
        // 縁から壁を伝って降りる
        p.x += dir.x * step * 0.25;
        p.z += dir.z * step * 0.25;
        p.y = Math.max(here, p.y - climbSpeed * 1.3 * dt);
        this.climbing = -1;
      }
    }
    this.moveSpeed = speed;
    city.clampToMap(p, 4);
  }

  /** 向きを目標の方位へ旋回 */
  protected turnTo(targetYaw: number, rate: number, dt: number) {
    const d = angleDiff(this.yaw, targetYaw);
    this.yaw += clamp(d, -rate * dt, rate * dt);
  }

  protected onKnock(dir: Vector3, knock: number, _point: Vector3) {
    if (knock < 6) return;
    // 爆風で吹き飛ぶ
    const k = knock / (this.def.mass / 300);
    this.vel.set(dir.x * k, Math.max(4, k * 0.6), dir.z * k);
    this.airborne = true;
    this.spinRate = (Math.random() - 0.5) * 8;
  }

  /** 空中にいる間の処理。空中なら true を返す */
  protected updateAir(dt: number): boolean {
    if (!this.airborne) return false;
    const p = this.position;
    this.vel.y += GRAVITY * dt;
    p.addInPlace(this.vel.scale(dt));
    this.roll += this.spinRate * dt;
    this.ctx.city.clampToMap(p, 4);
    const g = this.ctx.city.heightAt(p.x, p.z);
    if (p.y <= g && this.vel.y < 0) {
      p.y = g;
      this.airborne = false;
      this.vel.setAll(0);
      this.spinRate = 0;
      this.ctx.effects.puff(p, 5, this.def.radius * 0.6);
    }
    return true;
  }

  /** ルートの回転を更新（歩行・登攀・空中回転を反映） */
  protected applyOrientation(dt: number) {
    const targetPitch = this.climbing > 0 ? -Math.PI / 2.3 : this.climbing < 0 ? Math.PI / 2.6 : 0;
    this.pitch += (targetPitch - this.pitch) * damp(10, dt);
    if (!this.airborne) this.roll += (0 - this.roll) * damp(6, dt);
    // 怯みモーション: のけぞって小刻みに震える
    const fl = Math.min(1, this.stagger * 4);
    const flinchP = fl > 0 ? -0.22 * fl + Math.sin(this.t * 47) * 0.05 * fl : 0;
    const flinchR = fl > 0 ? Math.sin(this.t * 39) * 0.06 * fl : 0;
    Quaternion.RotationYawPitchRollToRef(this.yaw, this.pitch + flinchP, this.roll + flinchR, this.root.rotationQuaternion!);
  }
}
