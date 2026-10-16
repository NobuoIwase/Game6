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
import { Ragdoll, RigidCorpse, RigPart } from "../core/Physics";
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
      this.ctx.enemies.killed++;
      this.ctx.effects.gore(this.center(), this.kind);
      this.onDeath(dir, Math.min(40, knock + amount * 0.04));
      if (Math.random() < this.def.dropRate) this.ctx.dropItem(this.center());
      return;
    }
    this.onKnock(dir, knock, point);
  }

  protected onKnock(_dir: Vector3, _knock: number, _point: Vector3) {}

  /**
   * 死亡ポーズのまま固まった1つの剛体にして物理演算へ（地上の巨大生物用）。
   * 死骸同士の重なりは物理演算で押し出されて軽く跳ねる。
   */
  /**
   * 死亡ポーズで固めた剛体の死骸にする。
   * @param flip true なら前後軸まわりに転がして仰向けにする（ひっくり返った虫の死骸）
   */
  protected rigidize(velocity: Vector3, spin = 1.5, flip = false) {
    this.deathPose();
    // 地面にめり込まないよう、一番低いパーツが地面の少し上に来るまで持ち上げる
    this.root.computeWorldMatrix(true);
    let low = Infinity;
    const tmp = new Vector3();
    for (const p of this.rig) {
      p.node.computeWorldMatrix(true);
      Vector3.TransformCoordinatesToRef(p.center, p.node.getWorldMatrix(), tmp);
      low = Math.min(low, tmp.y - Math.min(p.size.x, p.size.y, p.size.z) * 0.5);
    }
    const floor = this.ctx.city.heightAt(this.position.x, this.position.z, this.position.y + 1);
    if (low < floor + 0.15) this.root.position.y += floor + 0.15 - low;
    // 空中にいる時間（≒ 2vy/g）でちょうど半回転するくらいの角速度
    let angular: Vector3 | undefined;
    if (flip) {
      const air = Math.max(0.4, (2 * Math.max(1, velocity.y)) / 9.81);
      const fwd = new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      angular = fwd.scale(((Math.random() < 0.5 ? -1 : 1) * Math.PI * 0.9) / air);
    }
    const c = new RigidCorpse(this.ctx.scene, this.rig, { velocity, spin, angular });
    this.ctx.addCorpse(c, [c.root]);
    this.root.dispose();
  }

  /** 死亡ポーズ（各敵で上書き） */
  protected deathPose() {}

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
/**
 * 地上の敵の性格（出現時にランダム）。同じ種類でも動きがばらけて、群れが立体的に迫ってくる。
 *  normal  … 標準。左右に少し散開しながら近づく
 *  rusher  … 突撃型。ひたすら真っすぐ前へ。足が速く、遠くからはあまり撃たない
 *  flanker … 回り込み型。大きく横へ回り込み、側面や背後から迫る
 *  lurker  … 後衛型。距離を取って後ろで待機し、近づかれると下がりながら撃つ
 */
export type Temper = "normal" | "rusher" | "flanker" | "lurker";

export function randomTemper(): Temper {
  const r = Math.random();
  return r < 0.35 ? "normal" : r < 0.6 ? "rusher" : r < 0.82 ? "flanker" : "lurker";
}

export abstract class GroundEnemy extends Enemy {
  temper: Temper = randomTemper();
  airborne = false;
  climbing = 0; // -1 下降, 0 地面, +1 上昇
  pitch = 0;
  roll = 0;
  /** 胴体の高さ（見た目） */
  protected bodyHeight = 1.5;
  protected spinRate = 0;
  moveSpeed = 0;

  /** 戦艦級から生み出された直後（丸まった玉の状態） */
  curled = false;
  private curlT = 0;

  /**
   * 丸まった状態の処理。丸まっていれば true を返す。
   * 玉のまま転がり落ち、着地して少し震えたあと、跳ねるように体を開いて活動を始める。
   */
  protected updateCurled(dt: number): boolean {
    if (!this.curled) return false;
    this.t += dt;
    if (this.airborne) {
      this.updateAir(dt);
      if (!this.airborne) this.ctx.effects.puff(this.position, 4, this.def.radius * 0.5);
    } else {
      this.curlT += dt;
      // 着地後: 小刻みに震えてから開く
      this.roll = Math.sin(this.t * 30) * 0.08 * Math.min(1, this.curlT * 3);
      if (this.curlT > 0.9) {
        this.curled = false;
        this.vel.set(0, 6, 0);
        this.airborne = true;
        this.spinRate = 0;
        this.roll = 0;
        this.activate(0.2);
      }
    }
    this.applyOrientation(dt);
    this.deathPose();
    this.updateHitSpheres();
    return true;
  }

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

  /** 被弾で押し戻される水平速度（m/s）。撃ち続けると前線が押し返される */
  protected shove = new Vector3();

  protected onKnock(dir: Vector3, knock: number, _point: Vector3) {
    // 弾が当たるたびに押し戻される（重いほど動きにくい）
    const sk = (knock * 2.2) / (this.def.mass / 300);
    this.shove.x += dir.x * sk;
    this.shove.z += dir.z * sk;
    const l = this.shove.length();
    if (l > 9) this.shove.scaleInPlace(9 / l);
    if (knock < 6) return;
    // 爆風で吹き飛ぶ
    const k = knock / (this.def.mass / 300);
    this.vel.set(dir.x * k, Math.max(4, k * 0.6), dir.z * k);
    this.airborne = true;
    this.spinRate = (Math.random() - 0.5) * 8;
  }

  /** 押し戻しを位置に反映して減衰させる（段差・壁の手前では止まる） */
  protected applyShove(dt: number) {
    const sv = this.shove;
    if (sv.x * sv.x + sv.z * sv.z < 0.0025) return;
    const p = this.position;
    if (!this.airborne && this.climbing === 0) {
      const nx = p.x + sv.x * dt,
        nz = p.z + sv.z * dt;
      const h = this.ctx.city.heightAt(nx, nz, p.y + 1);
      if (Math.abs(h - p.y) < 0.6) {
        p.x = nx;
        p.z = nz;
        p.y = h;
        this.ctx.city.clampToMap(p, 4);
      } else sv.setAll(0);
    }
    sv.scaleInPlace(Math.exp(-5 * dt));
  }

  /** 空中にいる間の処理。空中なら true を返す */
  protected updateAir(dt: number): boolean {
    if (!this.airborne) return false;
    const p = this.position;
    this.vel.y += GRAVITY * dt;
    p.addInPlace(this.vel.scale(dt));
    this.roll += this.spinRate * dt;
    this.ctx.city.clampToMap(p, 4);
    const g = this.ctx.city.heightAt(p.x, p.z, p.y + Math.max(0, -this.vel.y * dt));
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
