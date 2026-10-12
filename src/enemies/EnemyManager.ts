// ============================================================================
// 敵の管理: 出現・更新・アクティブ化の連鎖・当たり判定。
// ----------------------------------------------------------------------------
// アクティブ化の連鎖（地球防衛軍風）:
//   1体が起動すると、同じ群れの仲間と、その個体の alertRadius 内の敵が
//   距離に応じた少しの時間差で次々に起動する。起動した個体からさらに連鎖する。
// ============================================================================
import { Vector3 } from "@babylonjs/core";
import type { GameContext } from "../core/GameContext";
import type { SpawnGroup } from "../data/missions";
import { Enemy, GroundEnemy } from "./Enemy";
import { Ant } from "./Ant";
import { Spider } from "./Spider";
import { Flyer, FlyerSquad } from "./Flyer";
import { Carrier } from "./Carrier";
import { raySphere, rand } from "../core/MathUtil";

export interface EnemyRayHit {
  enemy: Enemy;
  dist: number;
  point: Vector3;
  mult: number;
}

export class EnemyManager {
  list: Enemy[] = [];
  squads: FlyerSquad[] = [];
  private groupSeq = 0;
  /** 輸送船の出現・ハッチ開放（無線演出用） */
  onCarrier?: (c: Carrier) => void;
  carrierOpened?: (c: Carrier) => void;

  /** 輸送船から蟻型を投下する（空中に出現し、落下して着地する） */
  dropAnt(p: Vector3) {
    const a = new Ant(this.ctx, p.clone(), ++this.groupSeq);
    a.position.copyFrom(p);
    a.airborne = true;
    a.vel.set(rand(-2, 2), -3, rand(-2, 2));
    a.activate(0.4);
    this.list.push(a);
  }

  /** 何かが起動したとき（無線演出用） */
  onFirstAlert?: () => void;
  private anyAlerted = false;

  constructor(private ctx: GameContext) {}

  get aliveCount() {
    let n = 0;
    for (const e of this.list) if (e.alive) n++;
    return n;
  }

  spawnGroup(g: SpawnGroup, scale: number) {
    const group = ++this.groupSeq;
    const count = Math.max(1, Math.round(g.count * scale));
    const center = new Vector3(g.at[0], 0, g.at[1]);
    if (g.type === "carrier") {
      // マップの外側から飛来して、指定地点の上空で止まる
      const out = center.lengthSquared() > 1 ? center.normalizeToNew() : new Vector3(0, 0, -1);
      const from = out.scale(320).addInPlace(new Vector3(0, 90, 0));
      const c = new Carrier(this.ctx, from, group, center.add(new Vector3(0, 62, 0)));
      c.activate(0);
      this.list.push(c);
      this.onCarrier?.(c);
      return;
    }
    if (g.type === "flyer") {
      const home = center.add(new Vector3(0, 55, 0));
      const squad = new FlyerSquad(home, g.formation ?? "v");
      for (let i = 0; i < count; i++) {
        const slot = squad.slot(i);
        const f = new Flyer(this.ctx, home.add(slot), group, squad, i);
        squad.members.push(f);
        this.list.push(f);
        if (g.active) f.activate(0.1 + i * 0.05);
      }
      this.squads.push(squad);
      return;
    }
    for (let i = 0; i < count; i++) {
      // 建物の中に出現しないよう開けた場所を探す
      let p = center.clone();
      for (let tries = 0; tries < 30; tries++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * g.spread;
        const x = center.x + Math.cos(a) * r,
          z = center.z + Math.sin(a) * r;
        if (this.ctx.city.isOpen(x, z, 2.5)) {
          p = new Vector3(x, 0, z);
          break;
        }
      }
      this.ctx.city.clampToMap(p, 6);
      const e = g.type === "ant" ? new Ant(this.ctx, p, group) : new Spider(this.ctx, p, group);
      this.list.push(e);
      if (g.active) e.activate(rand(0.1, 1.0));
    }
  }

  /** 敵 e が刺激を受けた: 自身と周囲を起動 */
  alert(e: Enemy) {
    if (!e.alive) return;
    const wasActive = e.active;
    e.activate(0);
    if (wasActive) return;
    if (!this.anyAlerted) {
      this.anyAlerted = true;
      this.onFirstAlert?.();
    }
    const r = e.def.alertRadius;
    for (const o of this.list) {
      if (!o.alive || o.active || o === e) continue;
      const d = Vector3.Distance(o.position, e.position);
      if (o.group === e.group || d < r) {
        // 遠いほど遅れて反応。起動した個体からさらに連鎖させる
        o.activate(0.15 + d / 45 + Math.random() * 0.4);
      }
    }
  }

  alertSquad(sq: FlyerSquad) {
    for (const m of sq.members) if (m.alive && !m.active) m.activate(0.05);
  }

  update(dt: number) {
    for (const e of this.list) {
      if (!e.alive) continue;
      if (!e.active && e.activateDelay >= 0) {
        e.activateDelay -= dt;
        if (e.activateDelay <= 0) {
          e.activateDelay = -1;
          this.alert(e);
        }
      }
      e.update(dt);
    }
    this.separate();
    // 死んだ敵をリストから除去
    if (this.list.some((e) => !e.alive)) this.list = this.list.filter((e) => e.alive);
    for (const sq of this.squads) sq.members = sq.members.filter((m) => m.alive);
    this.squads = this.squads.filter((s) => s.members.length > 0);
    for (const e of this.list) e.updateHitSpheres();
  }

  /** 地上の敵同士が重ならないよう押し離す（簡易空間ハッシュ） */
  private separate() {
    const cell = 6;
    const map = new Map<number, GroundEnemy[]>();
    const key = (x: number, z: number) => ((Math.floor(x / cell) + 500) << 11) | (Math.floor(z / cell) + 500);
    for (const e of this.list) {
      if (!(e instanceof GroundEnemy) || !e.alive || e.airborne) continue;
      const k = key(e.position.x, e.position.z);
      const arr = map.get(k);
      if (arr) arr.push(e);
      else map.set(k, [e]);
    }
    for (const e of this.list) {
      if (!(e instanceof GroundEnemy) || e.airborne) continue;
      const cx = Math.floor(e.position.x / cell),
        cz = Math.floor(e.position.z / cell);
      for (let ix = -1; ix <= 1; ix++)
        for (let iz = -1; iz <= 1; iz++) {
          const arr = map.get(((cx + ix + 500) << 11) | (cz + iz + 500));
          if (!arr) continue;
          for (const o of arr) {
            if (o.id <= e.id) continue;
            const dx = o.position.x - e.position.x,
              dz = o.position.z - e.position.z;
            const min = (e.def.radius + o.def.radius) * 0.85;
            const d2 = dx * dx + dz * dz;
            if (d2 < min * min && d2 > 1e-6 && Math.abs(o.position.y - e.position.y) < 3) {
              const d = Math.sqrt(d2);
              const push = (min - d) * 0.5;
              const nx = dx / d,
                nz = dz / d;
              e.position.x -= nx * push;
              e.position.z -= nz * push;
              o.position.x += nx * push;
              o.position.z += nz * push;
            }
          }
        }
    }
  }

  /** レイと敵の当たり判定 */
  raycast(origin: Vector3, dir: Vector3, maxDist: number): EnemyRayHit | null {
    let best: EnemyRayHit | null = null;
    for (const e of this.list) {
      if (!e.alive) continue;
      // 大まかな距離で枝刈り
      const c = e.hitSpheres[0]?.world;
      if (!c) continue;
      const toC = c.subtract(origin);
      const along = Vector3.Dot(toC, dir);
      if (along < -6 || along > maxDist + 6) continue;
      for (const h of e.hitSpheres) {
        const t = raySphere(origin, dir, h.world, h.r);
        if (t >= 0 && t <= maxDist && (!best || t < best.dist)) {
          best = { enemy: e, dist: t, point: origin.add(dir.scale(t)), mult: h.mult };
        }
      }
    }
    return best;
  }

  /** 線分と敵（弾頭の移動判定用） */
  segment(a: Vector3, b: Vector3, pad = 0): EnemyRayHit | null {
    const d = b.subtract(a);
    const len = d.length();
    if (len < 1e-6) return null;
    d.scaleInPlace(1 / len);
    let best: EnemyRayHit | null = null;
    for (const e of this.list) {
      if (!e.alive) continue;
      for (const h of e.hitSpheres) {
        const t = raySphere(a, d, h.world, h.r + pad);
        if (t >= 0 && t <= len && (!best || t < best.dist)) best = { enemy: e, dist: t, point: a.add(d.scale(t)), mult: h.mult };
      }
    }
    return best;
  }

  /** 範囲内の敵 */
  inRadius(p: Vector3, r: number): { enemy: Enemy; dist: number }[] {
    const out: { enemy: Enemy; dist: number }[] = [];
    for (const e of this.list) {
      if (!e.alive) continue;
      let best = Infinity;
      for (const h of e.hitSpheres) best = Math.min(best, Math.max(0, Vector3.Distance(p, h.world) - h.r));
      if (best < r) out.push({ enemy: e, dist: best });
    }
    return out;
  }

  dispose() {
    for (const e of this.list) e.root.dispose();
    this.list = [];
    this.squads = [];
  }
}
