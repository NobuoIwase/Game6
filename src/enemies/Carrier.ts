// ============================================================================
// 戦艦級（スポーンシップ）
// ----------------------------------------------------------------------------
// 国家級（巨大な杭）のとげが分裂して飛び立った、巨大生物を生み出す円盤。これ自体も生物。
//  1. 周囲のとげのあいだの凹みに飛行型をはめ込んだまま、マップの端から飛来して上空で止まる
//  2. 発進: 飛行型は少し下へ降りて凹みから外れ、放射状に外へ離れる（対角線上の仲間と
//     ぶつからない）。そのまま円盤のまわりを回り込んで、プレイヤー側に揃って編隊を組む
//  3. 飛行型を出し終えると、上部と下部の「呼吸孔」（弱点）を開閉して呼吸を始める
//  4. 側面のとげの先から、丸まった巨大生物を生み落とす。玉は地面に落ちると開いて活動を始める
//  外殻はほとんど攻撃を受け付けず、呼吸孔が開いている間に撃つのが有効。
// ============================================================================
import { Color3, InstancedMesh, Mesh, Quaternion, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { ENEMIES, EnemyType } from "../data/enemies";
import type { GameContext } from "../core/GameContext";
import { Enemy } from "./Enemy";
import { glowMaterial, merge, shellMaterial } from "./AlienShapes";
import { gem, slab, spike } from "./AnchorShapes";
import { hideTemplate } from "./Ant";
import type { Flyer } from "./Flyer";
import { Ragdoll } from "../core/Physics";
import { angleDiff, rand } from "../core/MathUtil";
import { sfx } from "../core/Audio";

/** とげ（角）の数。とげのあいだの凹みも同じ数で、そこに飛行型が1機ずつはまる */
export const SHIP_HORNS = 8;
const HORN_R0 = 10;
const HORN_LEN = 17;
const DOCK_R = 15;
const VENT_Y = 4.6;

interface Templates {
  hull: Mesh;
  petal: Mesh;
  vent: Mesh;
  pore: Mesh;
}
const cache = new WeakMap<Scene, Templates>();

function templates(scene: Scene): Templates {
  const c = cache.get(scene);
  if (c) return c;
  const shell = shellMaterial(scene, "shipShell", new Color3(0.13, 0.12, 0.14), 0.7, 0.35);
  const glow = glowMaterial(scene, "shipVent", new Color3(4, 0.5, 0.25));
  const R = (x: number, y: number, z: number) => new Vector3(x, y, z);
  const parts: Mesh[] = [
    // 胴: 面取りした平たい塊を重ねた円盤
    slab(scene, "b", 24, 6, 24),
    slab(scene, "b", 18, 9, 18, R(0, 0, 0), R(0, Math.PI / 8, 0)),
    slab(scene, "b", 14, 3, 14, R(0, 3.6, 0), R(0, Math.PI / 4, 0)),
    slab(scene, "b", 14, 3, 14, R(0, -3.6, 0), R(0, Math.PI / 4, 0)),
  ];
  for (let k = 0; k < SHIP_HORNS; k++) {
    const a = (k / SHIP_HORNS) * Math.PI * 2;
    const dir = R(Math.sin(a), 0, Math.cos(a));
    // 水平に突き出す大きなとげ（返しのように少し下へ反る）と、その上下の小さなとげ
    const yaw = a - Math.PI / 2;
    parts.push(spike(scene, "h", HORN_LEN, 5.5, 3.5, dir.scale(HORN_R0), R(Math.PI / 2, yaw, -0.08)));
    parts.push(spike(scene, "h2", 8, 3.5, 1.6, dir.scale(HORN_R0 - 2).add(R(0, 2.2, 0)), R(Math.PI / 2, yaw, 0.35)));
    parts.push(spike(scene, "h3", 7, 3, 1.4, dir.scale(HORN_R0 - 2).add(R(0, -2.2, 0)), R(Math.PI / 2, yaw, -0.45)));
  }
  const hull = merge("shipHull", parts);
  hull.material = shell;
  // 呼吸孔のふた（花びら状の板。原点が外周側のヒンジで、先端が +X ＝中心向き）
  const petal = spike(scene, "petal", 6.5, 5.2, 0.9, Vector3.Zero(), R(Math.PI / 2, 0, 0));
  petal.name = "shipPetal";
  petal.material = shell;
  const vent = gem(scene, "shipVentM", 3, 7, 3.2, 7);
  vent.material = glow;
  // とげの根元の「産卵孔」
  const pore = gem(scene, "shipPore", 1, 2.4, 2.4, 2.4);
  pore.material = glow;
  const t = { hull, petal, vent, pore };
  for (const m of Object.values(t)) hideTemplate(m);
  cache.set(scene, t);
  return t;
}

export function carrierTemplateMeshes(scene: Scene): Mesh[] {
  const t = templates(scene);
  return [t.hull, t.petal];
}

type ShipState = "arrive" | "launch" | "breathe";

interface DockSlot {
  flyer: Flyer;
  /** 凹みの番号（0..SHIP_HORNS-1） */
  notch: number;
  stage: "docked" | "drop" | "out" | "around" | "form" | "free";
  t: number;
  angle: number;
  pos: Vector3;
  heading: Vector3;
}

export class Carrier extends Enemy {
  private hull: InstancedMesh;
  private petals: { node: TransformNode; mesh: InstancedMesh; top: boolean }[] = [];
  private vents: InstancedMesh[] = [];
  private pores: InstancedMesh[] = [];
  private state: ShipState = "arrive";
  private stateT = 0;
  private hover: Vector3;
  /** 呼吸の開き具合 0..1（開いているときだけ弱点が露出） */
  private breath = 0;
  private breathT = 0;
  private birthCd = 4;
  private birthHorn = -1;
  private birthGlow = 0;
  private docks: DockSlot[] = [];
  private launchIdx = 0;
  private launchCd = 0;
  private formT = 0;

  constructor(ctx: GameContext, pos: Vector3, group: number, hover: Vector3) {
    super(ENEMIES.carrier, ctx, pos, group);
    this.hover = hover;
    const T = templates(ctx.scene);
    const inst = (m: Mesh, parent: TransformNode) => {
      const i = m.createInstance(m.name + this.id);
      i.parent = parent;
      i.position.setAll(0);
      i.rotationQuaternion = Quaternion.Identity();
      i.isPickable = false;
      return i;
    };
    this.hull = inst(T.hull, this.root);
    for (const top of [true, false]) {
      const v = inst(T.vent, this.root);
      v.position.y = top ? VENT_Y - 0.6 : -VENT_Y + 0.6;
      this.vents.push(v);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + (top ? 0 : Math.PI / 6);
        const hinge = new TransformNode("petalHinge", ctx.scene);
        hinge.parent = this.root;
        hinge.position.set(Math.cos(a) * 6.2, top ? VENT_Y + 0.4 : -VENT_Y - 0.4, Math.sin(a) * 6.2);
        hinge.rotationQuaternion = Quaternion.RotationYawPitchRoll(Math.PI - a, 0, 0);
        this.petals.push({ node: hinge, mesh: inst(T.petal, hinge), top });
      }
    }
    for (let k = 0; k < SHIP_HORNS; k++) {
      const a = (k / SHIP_HORNS) * Math.PI * 2;
      const p = inst(T.pore, this.root);
      p.position.set(Math.sin(a) * (HORN_R0 + 1.5), -1.6, Math.cos(a) * (HORN_R0 + 1.5));
      this.pores.push(p);
    }
    this.hitSpheres = [
      // 上下の呼吸孔（開いているときだけ有効）
      { local: new Vector3(0, VENT_Y, 0), r: 4.2, world: new Vector3(), mult: 0.05 },
      { local: new Vector3(0, -VENT_Y, 0), r: 4.2, world: new Vector3(), mult: 0.05 },
      // 外殻（ほとんど効かない）
      { local: new Vector3(0, 0, 0), r: 15, world: new Vector3(), mult: 0.3 },
    ];
    this.updateHitSpheres();
  }

  center(): Vector3 {
    return this.position;
  }

  /** 呼吸孔が開いているか（弱点を狙える） */
  get exposed() {
    return this.breath > 0.45;
  }

  damage(amount: number, dir: Vector3, point: Vector3, knock: number) {
    super.damage(this.exposed ? amount : amount * 0.03, dir, point, 0);
    void knock;
  }

  /** 飛行型を凹みにはめ込む（出現時に EnemyManager から呼ばれる） */
  dockFlyers(flyers: Flyer[]) {
    // 発進順: 対角線上の2機を続けて出す（0, 4, 1, 5, ...）
    flyers.forEach((f, i) => {
      const notch = i % SHIP_HORNS;
      const slot: DockSlot = { flyer: f, notch, stage: "docked", t: 0, angle: 0, pos: new Vector3(), heading: new Vector3(0, 0, 1) };
      f.dock = { pos: slot.pos, heading: slot.heading };
      this.docks.push(slot);
    });
    this.docks.sort((a, b) => (a.notch % (SHIP_HORNS / 2)) * 2 + Math.floor(a.notch / (SHIP_HORNS / 2)) - ((b.notch % (SHIP_HORNS / 2)) * 2 + Math.floor(b.notch / (SHIP_HORNS / 2))));
    this.updateDocks(0);
  }

  update(dt: number) {
    this.t += dt;
    this.stateT += dt;
    // 移動: 指定の上空まで飛んできて、ゆっくり漂う
    const target = this.hover.add(new Vector3(Math.sin(this.t * 0.2) * 6, Math.sin(this.t * 0.5) * 1.5, Math.cos(this.t * 0.17) * 6));
    const to = target.subtract(this.position);
    const sp = this.state === "arrive" ? 22 : 3;
    const l = to.length();
    if (l > 0.1) this.position.addInPlace(to.scale(Math.min(1, (sp * dt) / l)));
    this.yaw += dt * 0.04;
    Quaternion.RotationYawPitchRollToRef(this.yaw, Math.sin(this.t * 0.4) * 0.025, Math.cos(this.t * 0.33) * 0.025, this.root.rotationQuaternion!);
    this.root.computeWorldMatrix(true);

    switch (this.state) {
      case "arrive":
        if (l < 4) this.setState(this.docks.length ? "launch" : "breathe");
        break;
      case "launch":
        this.launchCd -= dt;
        if (this.launchCd <= 0 && this.launchIdx < this.docks.length) {
          const d = this.docks[this.launchIdx++];
          if (d.flyer.alive) {
            d.stage = "drop";
            d.t = 0;
            sfx.collapse(this.position);
          }
          this.launchCd = 0.4;
        }
        if (this.launchIdx >= this.docks.length && this.docks.every((d) => d.stage === "free" || !d.flyer.alive)) this.setState("breathe");
        break;
      case "breathe":
        break;
    }
    this.updateDocks(dt);

    // 呼吸: 開いて 5 秒 → 閉じて 5 秒（発進が終わってから）
    if (this.state === "breathe") {
      this.breathT += dt;
      const cyc = this.breathT % 10;
      const want = cyc > 1.5 && cyc < 6.5 ? 1 : 0;
      if (want && this.breath === 0) this.ctx.enemies.carrierOpened?.(this);
      this.breath += Math.sign(want - this.breath) * Math.min(Math.abs(want - this.breath), dt / 0.9);
      this.updateBirth(dt);
    }
    // 花びら状のふたを開閉（開いている間は脈打つ）
    const pulse = Math.sin(this.t * 5) * 0.08 * this.breath;
    for (const p of this.petals) {
      const ang = (this.breath * 1.05 + pulse) * (p.top ? 1 : -1);
      Quaternion.RotationYawPitchRollToRef(0, 0, ang, p.mesh.rotationQuaternion!);
    }
    for (const v of this.vents) v.scaling.setAll(0.75 + this.breath * 0.35 + pulse);
    for (let k = 0; k < this.pores.length; k++) this.pores[k].scaling.setAll(k === this.birthHorn ? 0.6 + this.birthGlow * 0.9 : 0.6);
    this.hitSpheres[0].mult = this.hitSpheres[1].mult = this.exposed ? 1.5 : 0.05;
  }

  private setState(s: ShipState) {
    this.state = s;
    this.stateT = 0;
  }

  /** 凹みの位置（ワールド）。flyer は機首を外へ向けてはまる */
  private notchWorld(notch: number, radius: number, y: number, out: Vector3) {
    const a = ((notch + 0.5) / SHIP_HORNS) * Math.PI * 2;
    Vector3.TransformCoordinatesFromFloatsToRef(Math.sin(a) * radius, y, Math.cos(a) * radius, this.root.getWorldMatrix(), out);
    return out;
  }

  private updateDocks(dt: number) {
    const tmp = new Vector3();
    const c = this.position;
    // 編隊を組む場所: 円盤の下、プレイヤーの方向へ少し出たところ
    const toP = this.ctx.player.position.subtract(c);
    toP.y = 0;
    const meetYaw = Math.atan2(toP.x, toP.z);
    const R = 38;
    let forming = 0,
      ready = 0;
    for (const d of this.docks) {
      if (!d.flyer.alive || d.stage === "free") continue;
      d.t += dt;
      const outDir = this.notchWorld(d.notch, 1, 0, tmp).subtract(c);
      outDir.y = 0;
      outDir.normalize();
      switch (d.stage) {
        case "docked":
          this.notchWorld(d.notch, DOCK_R, 0, d.pos);
          d.heading.copyFrom(outDir);
          break;
        case "drop": {
          // 下へ降りて凹みから外れる
          const k = Math.min(1, d.t / 1.1);
          this.notchWorld(d.notch, DOCK_R, -6 * k * k * (3 - 2 * k), d.pos);
          d.heading.copyFrom(outDir);
          if (k >= 1) {
            d.stage = "out";
            d.t = 0;
          }
          break;
        }
        case "out": {
          // 放射状に外へ離れる（対角線上の仲間とは逆向きに進むのでぶつからない）
          const k = Math.min(1, d.t / 1.8);
          const e = k * k * (3 - 2 * k);
          this.notchWorld(d.notch, DOCK_R + (R - DOCK_R) * e, -6 - 4 * e, d.pos);
          d.heading.copyFrom(outDir);
          if (k >= 1) {
            d.stage = "around";
            d.t = 0;
            d.angle = Math.atan2(d.pos.x - c.x, d.pos.z - c.z);
          }
          break;
        }
        case "around": {
          // 円盤のまわりを同じ向きに回り込み、プレイヤー側へ集まる（すれ違わない）
          const diff = angleDiff(d.angle, meetYaw);
          const step = Math.sign(diff) * Math.min(Math.abs(diff), 0.75 * dt);
          d.angle += step;
          const prev = d.pos.clone();
          d.pos.set(c.x + Math.sin(d.angle) * R, c.y - 10 - (d.flyer.slotIndex % 3) * 1.5, c.z + Math.cos(d.angle) * R);
          const v = d.pos.subtract(prev);
          if (v.lengthSquared() > 1e-6) d.heading.copyFrom(v.normalize());
          if (Math.abs(diff) < 0.05) {
            d.stage = "form";
            d.t = 0;
          }
          break;
        }
        case "form": {
          // 編隊の位置へ（全員揃うまで待つ）
          const fwd = new Vector3(Math.sin(meetYaw), 0, Math.cos(meetYaw));
          const anchor = c.add(fwd.scale(R + 12)).addInPlace(new Vector3(0, -12, 0));
          const slot = d.flyer.squad.slot(d.flyer.slotIndex).rotateByQuaternionToRef(Quaternion.RotationYawPitchRoll(meetYaw, 0, 0), new Vector3());
          const goal = anchor.add(slot);
          const delta = goal.subtract(d.pos);
          const dist = delta.length();
          const move = Math.min(dist, 14 * dt);
          if (dist > 0.01) d.pos.addInPlace(delta.scale(move / dist));
          d.heading.addInPlace(fwd.subtract(d.heading).scale(Math.min(1, dt * 2))).normalize();
          forming++;
          if (dist < 1.5) ready++;
          break;
        }
      }
    }
    // 全員が編隊位置に揃ったら（または待ちすぎたら）一斉に出撃
    const waiting = this.docks.filter((d) => d.flyer.alive && d.stage !== "free").length;
    if (forming > 0 && forming === waiting) {
      this.formT += dt;
      if (ready === forming || this.formT > 6) this.releaseAll(meetYaw);
    }
  }

  private releaseAll(yaw: number) {
    const fwd = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    for (const d of this.docks) {
      if (!d.flyer.alive || d.stage === "free") continue;
      d.stage = "free";
      const f = d.flyer;
      f.dock = null;
      f.vel.copyFrom(fwd.scale(14));
      f.heading.copyFrom(fwd);
      const sq = f.squad;
      sq.phase = "extend";
      sq.phaseT = 0;
      sq.target = f.position.add(fwd.scale(90));
      sq.target.y = 40;
      f.activate(0.1);
    }
  }

  /** 側面のとげの根元から、丸まった巨大生物を生み落とす */
  private updateBirth(dt: number) {
    this.birthCd -= dt;
    if (this.birthHorn >= 0) {
      this.birthGlow = Math.min(1, this.birthGlow + dt / 1.2);
      if (this.birthGlow >= 1) {
        const k = this.birthHorn;
        this.birthHorn = -1;
        this.birthGlow = 0;
        if (this.ctx.enemies.list.filter((e) => e.kind === "ant" || e.kind === "spider").length > 40) return;
        const p = this.pores[k].getAbsolutePosition().clone();
        const out = p.subtract(this.position);
        out.y = 0;
        out.normalize();
        const type: EnemyType = Math.random() < 0.3 ? "spider" : "ant";
        this.ctx.enemies.birth(type, p.add(out.scale(3)), out.scale(rand(5, 8)).add(new Vector3(0, -2, 0)));
        sfx.squish(p);
      }
    } else if (this.birthCd <= 0) {
      this.birthCd = rand(3.5, 5.5);
      this.birthHorn = Math.floor(Math.random() * SHIP_HORNS);
    }
  }

  protected onDeath(dir: Vector3) {
    sfx.explosion(this.position, 2.5);
    this.ctx.effects.explosion(this.position, 22, false);
    this.ctx.effects.addShake(0.8);
    // 格納中の飛行型も道連れ
    for (const d of this.docks) if (d.flyer.alive && d.stage !== "free") d.flyer.damage(9999, dir, d.flyer.position, 5);
    // 外殻・ふたがバラバラになって墜落する
    const parts = [
      { node: this.hull as TransformNode, parent: -1, size: new Vector3(30, 7, 30), center: new Vector3(0, 0, 0), mass: 20000 },
      ...this.petals.map((p) => ({ node: p.mesh as TransformNode, parent: -1, size: new Vector3(6, 0.9, 4), center: new Vector3(3, 0, 0), mass: 500 })),
    ];
    const r = new Ragdoll(this.ctx.scene, parts, { velocity: dir.scale(2).add(new Vector3(0, -2, 0)), spin: 0.6 });
    this.ctx.addCorpse(
      r,
      parts.map((p) => p.node),
    );
    // 墜落地点で時間差の大爆発
    const ground = this.position.clone();
    ground.y = 2;
    this.ctx.later(2.6, () => this.ctx.explode({ pos: ground, radius: 18, damage: 120, knockback: 25, source: "enemy", buildingDamage: 3 }));
    for (const v of this.vents) v.dispose();
    for (const p of this.pores) p.dispose();
    this.root.dispose();
  }
}
