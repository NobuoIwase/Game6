// ============================================================================
// 自動操縦（AI のテストプレイ用）
// ----------------------------------------------------------------------------
// 人間の操作の代わりに Input の値と視点を毎ステップ書き換えて、ミッションを最後まで遊ぶ。
// 難易度の調整や、変更後に「クリアできるか・どこで死ぬか」を機械的に確かめるために使う。
//   使い方: window.__game().startBot()  → g.simulate(秒) で描画なしに高速に進められる
//   集計:   scripts/autoplay.mjs（ヘッドレスのブラウザで複数回プレイして結果を表示）
// 人間らしさのため、視点の回転速度に上限があり、照準が合ってから撃つ。
// ============================================================================
import { Vector3 } from "@babylonjs/core";
import type { Game } from "./Game";
import type { Enemy } from "../enemies/Enemy";
import { GroundEnemy } from "../enemies/Enemy";
import { Carrier } from "../enemies/Carrier";
import { Flyer } from "../enemies/Flyer";
import { angleDiff, clamp } from "./MathUtil";

export interface BotOptions {
  /** 視点の最大回転速度（rad/s）。人間の操作に近づけるための上限 */
  turnRate?: number;
  /** 照準のぶれ（rad）。大きいほど下手 */
  aimError?: number;
}

export class Bot {
  private strafe = 1;
  private strafeT = 0;
  private rollCd = 0;
  private target: Enemy | null = null;
  private retargetT = 0;
  private wobble = new Vector3();
  private wobbleT = 0;
  /** 引っかかり検出（建物の角で止まったら横へ迂回する） */
  private lastPos = new Vector3();
  private stuckT = 0;
  private detourT = 0;
  private detourSide = 1;
  readonly turnRate: number;
  readonly aimError: number;
  /** 集計 */
  stats = { shotsHeld: 0, rolls: 0, pickups: 0, targetSwitches: 0 };

  constructor(
    private g: Game,
    opts: BotOptions = {},
  ) {
    this.turnRate = opts.turnRate ?? 4.5;
    this.aimError = opts.aimError ?? 0.012;
  }

  drive(dt: number) {
    const g = this.g;
    const input = g.opts.input;
    const player = g.player;
    input.enabled = true;
    input.moveX = 0;
    input.moveY = 0;
    input.fire = false;
    input.zoom = false;
    input.dash = false;
    if (!player.alive || player.state === "ragdoll") return;
    this.rollCd -= dt;
    this.strafeT -= dt;
    this.retargetT -= dt;
    this.wobbleT -= dt;
    if (this.strafeT <= 0) {
      this.strafeT = 1.5 + Math.random() * 2.5;
      if (Math.random() < 0.6) this.strafe *= -1;
    }
    if (this.wobbleT <= 0) {
      this.wobbleT = 0.4;
      const e = this.aimError;
      this.wobble.set((Math.random() - 0.5) * e, (Math.random() - 0.5) * e, 0);
    }

    // ---- 目標の選択 ----
    if (this.retargetT <= 0 || !this.target || !this.target.alive) {
      const t = this.pickTarget();
      if (t !== this.target) this.stats.targetSwitches++;
      this.target = t;
      this.retargetT = 0.6;
    }
    const target = this.target;

    // ---- 武器の選択: 空の敵・戦艦級・遠くの群れはミサイル、それ以外はアサルトライフル ----
    const ml = player.weapons.findIndex((w) => w.def.kind === "homing");
    const ar = player.weapons.findIndex((w) => w.def.kind === "hitscan");
    if (target) {
      const d = Vector3.Distance(target.center(), player.position);
      // 近すぎる相手にミサイルを撃つと自爆するので使わない
      const wantMl = ml >= 0 && d > 30 && (target instanceof Flyer || target instanceof Carrier || d > 70) && player.weapons[ml].ammo > 0;
      const want = wantMl ? ml : ar >= 0 ? ar : player.current;
      if (want !== player.current && !player.weapon.reloading) input.press(want === 0 ? "weapon0" : "weapon1");
    }

    // ---- 照準 ----
    let aimed = false;
    if (target) {
      const tp = this.aimPoint(target);
      const from = g.camera.position;
      const d = tp.subtract(from);
      const len = d.length();
      const wantYaw = Math.atan2(d.x, d.z) + this.wobble.x;
      const wantPitch = Math.asin(clamp(-d.y / len, -1, 1)) + this.wobble.y;
      const dy = angleDiff(g.camYaw, wantYaw);
      const dp = wantPitch - g.camPitch;
      const step = this.turnRate * dt;
      g.camYaw += clamp(dy, -step, step);
      g.camPitch = clamp(g.camPitch + clamp(dp, -step, step), -1.25, 1.2);
      const err = Math.hypot(dy, dp);
      const w = player.weapon;
      aimed = err < 0.05 + 1.2 / Math.max(10, len) && len < w.def.range;
      // ミサイルはロックオンのために撃ち続ける（引き金を引いている間にロックが進む）
      if (w.def.kind === "homing") aimed = err < 0.25 && len < w.def.range;
    }
    input.fire = aimed;
    if (aimed) this.stats.shotsHeld++;

    // ---- 移動 ----
    const fwd = new Vector3(Math.sin(g.camYaw), 0, Math.cos(g.camYaw));
    const right = new Vector3(fwd.z, 0, -fwd.x);
    const move = new Vector3();
    // 近くの地上の敵から距離を取る
    let threat = 0;
    let nearest = Infinity;
    const away = new Vector3();
    for (const e of g.enemies.list) {
      if (!e.alive || !(e instanceof GroundEnemy) || !e.active) continue;
      const v = player.position.subtract(e.position);
      v.y = 0;
      const d = v.length();
      nearest = Math.min(nearest, d);
      if (d < 30) {
        away.addInPlace(v.scale(1 / Math.max(1, d * d)));
        threat++;
      }
    }
    if (threat > 0) move.addInPlace(away.normalize().scale(1.2));
    // 横移動で酸・糸をかわす
    move.addInPlace(right.scale(this.strafe * 0.7));
    // アーマーが減ったら回復アイテムを拾いに行く
    if (player.armor < player.maxArmor * 0.6 && nearest > 14) {
      let best: Vector3 | null = null;
      let bd = 60;
      for (const it of g.pickups.items) {
        const d = Vector3.Distance(it.pos, player.position);
        if (d < bd) {
          bd = d;
          best = it.pos;
        }
      }
      if (best) {
        const v = best.subtract(player.position);
        v.y = 0;
        move.addInPlace(v.normalize().scale(1.5));
      }
    }
    // 見える敵がいなければ、レーダーで一番近い敵の方へ進む（隠れている敵を探しに行く）
    if (!target) {
      let seek: Vector3 | null = null;
      let sd = Infinity;
      for (const e of g.enemies.list) {
        if (!e.alive || (e instanceof Flyer && e.dock)) continue;
        const d = Vector3.Distance(e.position, player.position);
        if (d < sd) {
          sd = d;
          seek = e.position;
        }
      }
      if (seek) {
        const v = seek.subtract(player.position);
        v.y = 0;
        v.normalize();
        // 1.5 秒でほとんど進めていなければ、しばらく横へ迂回してジャンプ
        this.stuckT += dt;
        if (this.stuckT > 1.5) {
          if (Vector3.Distance(this.lastPos, player.position) < 2 && this.detourT <= 0) {
            this.detourT = 2.5;
            this.detourSide = Math.random() < 0.5 ? -1 : 1;
            input.press("jump");
          }
          this.lastPos.copyFrom(player.position);
          this.stuckT = 0;
        }
        this.detourT -= dt;
        const dir = this.detourT > 0 ? new Vector3(-v.z * this.detourSide, 0, v.x * this.detourSide).addInPlace(v.scale(0.3)).normalize() : v;
        move.copyFrom(dir.scale(2)).addInPlace(right.scale(this.strafe * 0.3));
        input.dash = sd > 40;
        // 進む方向を向く
        const yaw = Math.atan2(v.x, v.z);
        g.camYaw += clamp(angleDiff(g.camYaw, yaw), -this.turnRate * dt, this.turnRate * dt);
        g.camPitch += (0.05 - g.camPitch) * Math.min(1, dt * 3);
      }
    }
    if (move.lengthSquared() > 0.01) {
      move.normalize();
      input.moveY = Vector3.Dot(move, fwd);
      input.moveX = Vector3.Dot(move, right);
    }
    // 至近距離に迫られたら緊急回避（前転）
    if (nearest < 10 && this.rollCd <= 0) {
      input.press("roll");
      this.rollCd = 2.5;
      this.stats.rolls++;
    }
  }

  /** 狙う位置（飛行型は弾速ぶん先を狙い、戦艦級は開いている呼吸孔を狙う） */
  private aimPoint(e: Enemy): Vector3 {
    if (e instanceof Carrier) {
      const vents = e.hitSpheres.slice(0, 2).map((h) => h.world);
      const p = this.g.player.position;
      return vents.reduce((a, b) => (Vector3.Distance(a, p) < Vector3.Distance(b, p) ? a : b)).clone();
    }
    const c = e.center();
    if (e instanceof Flyer) {
      const d = Vector3.Distance(c, this.g.camera.position);
      return c.add(e.vel.scale(d / 600));
    }
    return c;
  }

  /** 近い・起動している・見通しが通る敵ほど優先 */
  private pickTarget(): Enemy | null {
    const g = this.g;
    const eye = g.camera.position;
    let best: Enemy | null = null;
    let bestScore = Infinity;
    for (const e of g.enemies.list) {
      if (!e.alive) continue;
      if (e instanceof Flyer && e.dock) continue; // 格納中は後回し
      if (e instanceof Carrier && !e.exposed) continue;
      const c = e instanceof Carrier ? e.position : e.center();
      const d = Vector3.Distance(c, eye);
      if (d > 260) continue;
      let score = d * (e.active ? 1 : 2.5);
      if (e instanceof Flyer) score *= d < 80 ? 0.8 : 1.6;
      if (e instanceof Carrier) score *= 0.5;
      if (score >= bestScore) continue;
      const hit = g.city.segment(eye, c);
      if (hit && hit.dist < d - 3) continue;
      best = e;
      bestScore = score;
    }
    return best;
  }
}
