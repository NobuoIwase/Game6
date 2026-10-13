// ============================================================================
// プレイヤー（陸戦兵）
// ----------------------------------------------------------------------------
// ・移動 / ジャンプ / 緊急回避（前転） / 武器2つの持ち替え
// ・アーマー（体力）。アイテムで最大値が増える（地球防衛軍風）
// ・爆風で吹き飛ぶ・蜘蛛の糸に絡まると、ラグドール化して倒れ、少しして起き上がる
// ============================================================================
import { Vector3 } from "@babylonjs/core";
import type { GameContext } from "../core/GameContext";
import type { Input } from "../core/Input";
import { Soldier } from "./Soldier";
import { Weapon, CombatContext } from "../combat/Weapon";
import { getWeapon } from "../data/weapons";
import { GRAVITY } from "../core/Physics";
import { clamp, damp } from "../core/MathUtil";
import { sfx } from "../core/Audio";
import { GroundEnemy } from "../enemies/Enemy";

export type PlayerState = "normal" | "roll" | "ragdoll" | "dead";

export class Player {
  soldier: Soldier;
  state: PlayerState = "normal";
  readonly height = 1.8;
  readonly radius = 0.45;
  armor: number;
  maxArmor: number;
  bind = 0;
  private bindHold = 0;
  restrained = false;
  weapons: Weapon[];
  current = 0;
  private velH = new Vector3();
  private velY = 0;
  grounded = true;
  private rollT = 0;
  private rollDir = new Vector3();
  private ragdollT = 0;
  private knockImmune = 0;
  private recoil = 0;
  private switchT = 0;
  /** 受けたダメージの内訳（攻撃の種類 → 合計）。自動テストの集計用 */
  damageLog: Record<string, number> = {};
  /** 被弾時の演出用（0..1） */
  hurtFlash = 0;
  dashing = false;
  yaw = 0;
  pitch = 0;
  private _chest = new Vector3();

  constructor(
    private ctx: GameContext,
    loadout: [string, string],
    armor: number,
    start: Vector3,
  ) {
    this.soldier = new Soldier(ctx.scene);
    this.soldier.root.position.copyFrom(start);
    this.weapons = loadout.map((id) => new Weapon(getWeapon(id)));
    for (const w of this.weapons) {
      w.onLock = () => sfx.lock();
      this.soldier.setWeaponModel(w.def.model);
    }
    this.soldier.setWeaponModel(this.weapon.def.model);
    this.maxArmor = this.armor = armor;
  }

  get position() {
    return this.soldier.root.position;
  }

  get weapon() {
    return this.weapons[this.current];
  }

  get alive() {
    return this.state !== "dead";
  }

  get invulnerable() {
    return false;
  }

  /** 胸の位置（敵の照準点） */
  get chest(): Vector3 {
    if (this.soldier.ragdoll) return this._chest.copyFrom(this.soldier.torso.position); // ラグドール中は親なし
    return this._chest.copyFrom(this.position).addInPlaceFromFloats(0, 1.35, 0);
  }

  /** カメラが追う位置 */
  get focus(): Vector3 {
    if (this.soldier.ragdoll) return this.soldier.pelvis.position.add(new Vector3(0, 0.6, 0));
    return this.position.add(new Vector3(0, this.state === "roll" ? 1.2 : 1.6, 0));
  }

  get canAct() {
    return this.state === "normal";
  }

  update(dt: number, input: Input, combat: CombatContext, aimYaw: number, aimPitch: number) {
    this.yaw = aimYaw;
    this.pitch = aimPitch;
    this.knockImmune = Math.max(0, this.knockImmune - dt);
    this.recoil = Math.max(0, this.recoil - dt * 6);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2);
    this.switchT = Math.max(0, this.switchT - dt);
    this.updateBind(dt);

    if (this.state === "ragdoll" || this.state === "dead") {
      this.updateRagdoll(dt);
      for (const w of this.weapons) w.update(dt, combat, false, false, false);
      return;
    }

    // ---- 武器操作 ----
    if (input.consume("switch")) this.switchWeapon((this.current + 1) % this.weapons.length);
    if (input.consume("weapon0")) this.switchWeapon(0);
    if (input.consume("weapon1")) this.switchWeapon(1);
    if (input.consume("reload") && this.weapon.startReload()) sfx.reload();

    // ---- 移動 ----
    const fwd = new Vector3(Math.sin(aimYaw), 0, Math.cos(aimYaw));
    const right = new Vector3(fwd.z, 0, -fwd.x);
    const wish = fwd.scale(input.moveY).addInPlace(right.scale(input.moveX));
    const zoomSlow = input.zoom && this.weapon.def.zoom > 1.2 ? 0.55 : 1;
    // ダッシュ: 移動中に Shift（スマホはボタン）。射撃・ズームすると解除される
    this.dashing = input.dash && !input.fire && !input.zoom && this.grounded && input.moveY > -0.3 && wish.lengthSquared() > 0.04;
    const speed = this.dashing ? 12 : 6.2 * zoomSlow;

    if (this.state === "roll") {
      // 飛び込み前転（踏み切り → 飛び込み → 前転 → 起き上がり）
      this.rollT += dt;
      const dur = 0.78;
      const k = Math.min(1, this.rollT / dur);
      const sp = k < 0.16 ? 8 : k < 0.36 ? 13 : k < 0.78 ? 10 : 10 - ((k - 0.78) / 0.22) * 8;
      this.velH.copyFrom(this.rollDir).scaleInPlace(sp);
      this.soldier.animateRoll(k);
      this.soldier.root.rotationQuaternion = null;
      this.soldier.root.rotation.y = Math.atan2(this.rollDir.x, this.rollDir.z);
      if (k >= 1) {
        this.state = "normal";
        this.soldier.setRoll(0);
      }
    } else {
      const target = wish.scale(speed);
      const accel = this.grounded ? 14 : 3;
      this.velH.addInPlace(target.subtract(this.velH).scale(damp(accel, dt)));
      if (input.consume("jump") && this.grounded) {
        this.velY = 7.2;
        this.grounded = false;
      }
      if (input.consume("roll") && this.grounded) {
        this.state = "roll";
        this.rollT = 0;
        this.rollDir = wish.lengthSquared() > 0.01 ? wish.normalize() : fwd.clone();
      }
      this.soldier.root.rotation.y = aimYaw;
    }

    // 重力・接地
    const p = this.position;
    this.velY += GRAVITY * dt;
    p.addInPlace(this.velH.scale(dt));
    p.y += this.velY * dt;
    this.ctx.city.collideCircle(p, this.radius, this.height);
    this.pushFromEnemies(p);
    this.ctx.city.clampToMap(p, 1);
    const g = this.ctx.city.heightAt(p.x, p.z, p.y);
    if (p.y <= g + 0.02 && this.velY <= 0) {
      if (!this.grounded && this.velY < -12) this.ctx.effects.puff(p, 3, 0.5);
      p.y = g;
      this.velY = 0;
      this.grounded = true;
    } else if (p.y > g + 0.3) this.grounded = false;

    // ---- 射撃 ----
    const canFire = this.state === "normal" && this.switchT <= 0 && !this.dashing;
    this.weapons.forEach((w, i) => {
      const fired = w.update(dt, combat, i === this.current, input.fire, canFire);
      if (fired) this.recoil = Math.min(1, this.recoil + 0.35 + w.def.recoil * 4);
    });

    // ---- アニメーション ----
    const localF = Vector3.Dot(this.velH, fwd);
    const localR = Vector3.Dot(this.velH, right);
    if (this.state === "normal")
      this.soldier.animate(dt, localF, localR, aimPitch, this.grounded, this.recoil, this.weapon.reloading || this.switchT > 0, this.dashing);
  }

  private switchWeapon(i: number) {
    if (i === this.current || i >= this.weapons.length) return;
    this.weapon.holster();
    this.current = i;
    this.switchT = 0.35;
    this.soldier.setWeaponModel(this.weapon.def.model);
    sfx.reload();
  }

  /** 地上の巨大生物に押される */
  private pushFromEnemies(p: Vector3) {
    for (const e of this.ctx.enemies.list) {
      if (!(e instanceof GroundEnemy) || !e.alive) continue;
      const dx = p.x - e.position.x,
        dz = p.z - e.position.z;
      const min = e.def.radius + this.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 < min * min && Math.abs(p.y - e.position.y) < 3 && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        p.x = e.position.x + (dx / d) * min;
        p.z = e.position.z + (dz / d) * min;
      }
    }
  }

  // ------------------------------------------------------------------ 被ダメージ
  takeDamage(amount: number, from: Vector3, knock: number, src = "other") {
    if (this.state === "dead") return;
    this.armor -= amount;
    this.damageLog[src] = (this.damageLog[src] ?? 0) + amount;
    this.hurtFlash = Math.min(0.85, this.hurtFlash + 0.08 + amount / 150);
    sfx.hurt();
    const dir = this.position.subtract(from);
    dir.y = 0;
    if (dir.lengthSquared() < 1e-4) dir.set(0, 0, 1);
    dir.normalize();
    if (this.armor <= 0) {
      this.armor = 0;
      this.die(dir, Math.max(knock, 6));
      return;
    }
    if (knock >= 8) this.knockdown(dir, knock);
    else if (knock > 0) this.velH.addInPlace(dir.scale(knock));
  }

  /** 爆風などで吹き飛ばされる → ラグドール化 */
  knockdown(dir: Vector3, strength: number) {
    if (this.state === "ragdoll" || this.state === "dead" || this.knockImmune > 0) return;
    this.state = "ragdoll";
    this.ragdollT = 0;
    this.soldier.setRoll(0);
    this.weapon.holster();
    const v = this.velH.add(dir.scale(strength)).add(new Vector3(0, strength * 0.55 + Math.max(0, this.velY), 0));
    this.soldier.startRagdoll({ velocity: v, spin: 4 + strength * 0.2 });
  }

  addBind(v: number) {
    if (this.state !== "normal" && this.state !== "roll") return;
    if (this.knockImmune > 0) return;
    this.bind += v;
    this.bindHold = 0.6;
    if (this.bind >= 100) {
      // 糸に絡め取られて倒れる
      this.restrained = true;
      this.soldier.setWebbed(true);
      this.knockdown(new Vector3(0, 0, 0), 1.5);
    }
  }

  private updateBind(dt: number) {
    this.bindHold -= dt;
    if (this.bindHold <= 0 && !this.restrained) this.bind = Math.max(0, this.bind - 35 * dt);
  }

  private updateRagdoll(dt: number) {
    this.ragdollT += dt;
    const rd = this.soldier.ragdoll;
    if (this.state === "dead") return;
    // 拘束中は少しずつダメージ
    if (this.restrained) this.armor = Math.max(1, this.armor - 4 * this.ctx.difficulty.enemyDamage * dt);
    const minT = this.restrained ? 2.2 : 1.2;
    if (this.ragdollT > minT && (!rd || rd.isResting() || this.ragdollT > 3.5)) this.getUp();
  }

  private getUp() {
    const pelvis = this.soldier.endRagdoll();
    const p = this.position;
    p.set(pelvis.x, 0, pelvis.z);
    this.ctx.city.clampToMap(p, 1);
    // 建物にめり込んでいたら押し出す
    for (let i = 0; i < 4; i++) this.ctx.city.collideCircle(p, this.radius, this.height);
    p.y = this.ctx.city.heightAt(p.x, p.z, pelvis.y);
    this.velH.setAll(0);
    this.velY = 0;
    this.state = "normal";
    this.knockImmune = 1.5;
    this.restrained = false;
    this.bind = 0;
    this.soldier.setWebbed(false);
    this.ctx.effects.puff(p, 3, 0.6);
  }

  private die(dir: Vector3, strength: number) {
    if (this.soldier.ragdoll) {
      this.soldier.ragdoll.applyImpulse(dir.scale(strength * 20), this.chest);
    } else {
      const v = this.velH.add(dir.scale(strength)).add(new Vector3(0, strength * 0.5, 0));
      this.soldier.startRagdoll({ velocity: v, spin: 4 });
    }
    this.state = "dead";
  }

  heal(amount: number) {
    if (!this.alive) return;
    this.armor = clamp(this.armor + amount, 0, this.maxArmor);
  }

  addMaxArmor(amount: number) {
    this.maxArmor += amount;
    this.armor += amount;
  }

  /** 爆風を受けたとき（Game.explode から） */
  applyBlast(center: Vector3, radius: number, damage: number, knock: number, src = "explosion") {
    const c = this.chest;
    const d = Vector3.Distance(c, center);
    if (d > radius + 0.5) return;
    const k = 1 - clamp(d / (radius + 0.5), 0, 1) * 0.6;
    const dir = c.subtract(center);
    dir.y = Math.max(0.2, dir.y);
    dir.normalize();
    if (this.soldier.ragdoll) {
      this.soldier.ragdoll.applyImpulse(dir.scale(knock * 40 * k), c);
      this.takeDamage(damage * k, center, 0, src);
      return;
    }
    this.takeDamage(damage * k, center, 0, src);
    if (this.alive && knock * k >= 6) this.knockdown(new Vector3(dir.x, 0, dir.z).normalize(), knock * k);
  }

  muzzle(): Vector3 {
    return this.soldier.gun.muzzle.getAbsolutePosition().clone();
  }
}
