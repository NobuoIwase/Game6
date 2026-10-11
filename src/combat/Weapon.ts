// ============================================================================
// 武器の実行時状態（残弾・リロード・連射間隔・ロックオン）と発射処理。
// 武器の性能は src/data/weapons.ts のデータで決まる。
// 発射の結果（命中判定・弾の生成）は CombatContext 経由でゲーム側に依頼する。
// ============================================================================
import { Vector3 } from "@babylonjs/core";
import type { WeaponDef } from "../data/weapons";
import type { Enemy } from "../enemies/Enemy";

export interface CombatContext {
  /** 銃口位置 */
  muzzle(): Vector3;
  /** 照準レイ（カメラ中心から） */
  aimOrigin(): Vector3;
  aimDir(): Vector3;
  /** 即着弾の射撃: origin から dir へ、命中を処理して着弾点を返す */
  hitscan(origin: Vector3, dir: Vector3, range: number, def: WeaponDef): Vector3;
  /** 弾頭（ロケット/ミサイル）を生成 */
  launch(origin: Vector3, dir: Vector3, def: WeaponDef, target: Enemy | null): void;
  /** ロックオン候補（画面中央に近い順） */
  lockCandidates(def: WeaponDef): Enemy[];
  onFire(def: WeaponDef): void;
}

export class Weapon {
  ammo: number;
  reloadT = 0; // >0 ならリロード中（残り秒）
  private cooldown = 0;
  private triggerHeld = false;
  /** ロックオン済みの敵と、ロック中の進捗 */
  locks: Enemy[] = [];
  lockProgress = 0;
  lockingTarget: Enemy | null = null;
  onLock?: () => void;

  constructor(readonly def: WeaponDef) {
    this.ammo = def.magazine;
  }

  get reloading() {
    return this.reloadT > 0;
  }

  get reloadRatio() {
    return this.reloading ? 1 - this.reloadT / this.def.reloadTime : 0;
  }

  startReload(): boolean {
    if (this.reloading || this.ammo >= this.def.magazine) return false;
    this.reloadT = this.def.reloadTime;
    this.locks = [];
    return true;
  }

  /** 武器を持ち替えたとき */
  holster() {
    this.locks = [];
    this.lockProgress = 0;
    this.lockingTarget = null;
    this.triggerHeld = false;
  }

  /**
   * @param active この武器を構えているか（持ち替え中でないか）
   * @param trigger 射撃ボタン
   * @param canFire 射撃可能な状態か（回避中・ダウン中は不可）
   * @returns 発射したら true
   */
  update(dt: number, ctx: CombatContext, active: boolean, trigger: boolean, canFire: boolean): boolean {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.reloadT > 0 && active) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) {
        this.reloadT = 0;
        this.ammo = this.def.magazine;
      }
    }
    if (!active) return false;

    if (this.def.kind === "homing") this.updateLock(dt, ctx, canFire);

    const pressed = trigger && !this.triggerHeld;
    this.triggerHeld = trigger;
    const want = this.def.automatic ? trigger : pressed;
    if (!want || !canFire || this.reloading || this.cooldown > 0) return false;
    if (this.ammo <= 0) {
      this.startReload();
      return false;
    }
    this.fire(ctx);
    this.cooldown = 1 / this.def.fireRate;
    if (this.ammo <= 0) this.startReload(); // 弾切れで自動リロード
    return true;
  }

  private fire(ctx: CombatContext) {
    const d = this.def;
    const origin = ctx.muzzle();
    if (d.kind === "hitscan") {
      this.ammo--;
      const aimO = ctx.aimOrigin();
      const aimD = ctx.aimDir();
      for (let i = 0; i < d.pellets; i++) {
        const dir = spreadDir(aimD, d.spread);
        // 照準レイの先の着弾点を、銃口から狙う（肩越し視点のずれ対策）
        ctx.hitscan(aimO, dir, d.range, d);
      }
    } else if (d.kind === "rocket") {
      this.ammo--;
      const target = this.aimPoint(ctx);
      const dir = spreadDir(target.subtract(origin).normalize(), d.spread);
      ctx.launch(origin, dir, d, null);
    } else {
      // ミサイル: ロックした数だけ一斉発射（ロック無しなら1発直進）
      const targets = this.locks.filter((e) => e.alive);
      const shots = Math.min(this.ammo, Math.max(1, targets.length));
      for (let i = 0; i < shots; i++) {
        const t = targets.length ? targets[i % targets.length] : null;
        const up = new Vector3((Math.random() - 0.5) * 0.6, 0.6 + Math.random() * 0.3, 0);
        const dir = t ? ctx.aimDir().add(up).normalize() : this.aimPoint(ctx).subtract(origin).normalize();
        ctx.launch(origin, dir, d, t);
        this.ammo--;
      }
      this.locks = [];
      this.lockProgress = 0;
      this.lockingTarget = null;
    }
    ctx.onFire(d);
  }

  private aimPoint(ctx: CombatContext): Vector3 {
    // 照準の先 200m（建物などがあればそこ）
    return ctx.aimOrigin().add(ctx.aimDir().scale(200));
  }

  private updateLock(dt: number, ctx: CombatContext, canLock: boolean) {
    const d = this.def;
    this.locks = this.locks.filter((e) => e.alive);
    if (!canLock || this.reloading || this.ammo <= 0) {
      this.lockingTarget = null;
      this.lockProgress = 0;
      return;
    }
    const max = Math.min(d.lockCount ?? 1, this.ammo);
    if (this.locks.length >= max) {
      this.lockingTarget = null;
      return;
    }
    const cands = ctx.lockCandidates(d).filter((e) => !this.locks.includes(e));
    // 一度ロックし始めた目標は範囲内にいる限り継続
    if (!this.lockingTarget || !cands.includes(this.lockingTarget)) {
      this.lockingTarget = cands[0] ?? null;
      this.lockProgress = 0;
    }
    if (!this.lockingTarget) return;
    this.lockProgress += dt;
    if (this.lockProgress >= (d.lockTime ?? 0.5)) {
      this.locks.push(this.lockingTarget);
      this.lockingTarget = null;
      this.lockProgress = 0;
      this.onLock?.();
    }
  }
}

/** 円錐状にランダムに散らした方向 */
export function spreadDir(dir: Vector3, spreadDeg: number): Vector3 {
  if (spreadDeg <= 0) return dir.clone();
  const s = (spreadDeg * Math.PI) / 180;
  const up = Math.abs(dir.y) > 0.95 ? Vector3.Right() : Vector3.Up();
  const r = Vector3.Cross(dir, up).normalize();
  const u = Vector3.Cross(r, dir).normalize();
  const a = Math.random() * Math.PI * 2;
  const m = Math.sqrt(Math.random()) * Math.tan(s);
  return dir
    .add(r.scale(Math.cos(a) * m))
    .add(u.scale(Math.sin(a) * m))
    .normalize();
}
