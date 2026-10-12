// ============================================================================
// 超巨大生物（演出）
// ----------------------------------------------------------------------------
// ビルの陰から長い首がゆっくり伸び、ビルの縁から頭を覗かせてプレイヤーをじっと見つめ、
// しばらくすると引っ込んでいく。今のところ攻撃もせず、倒すこともできない「予兆」の演出。
// 首は同じ形の節（カーソル板を放射状に組んだもの）を曲線に沿って並べて作る。
// ============================================================================
import { Color3, Mesh, Quaternion, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import type { GameContext } from "../core/GameContext";
import type { Building } from "../world/City";
import { bakeT, cursorPlate, glowMaterial, merge, shellMaterial } from "./AlienShapes";
import { lookQuat } from "../core/MathUtil";
import { sfx } from "../core/Audio";

const SEGMENTS = 14;
/** 全体の大きさの倍率（頭だけで約40m） */
const CS = 2.5;
const FWD = Math.PI / 2;

interface Templates {
  seg: Mesh;
  head: Mesh;
  eyes: Mesh;
}
const cache = new WeakMap<Scene, Templates>();

function templates(scene: Scene): Templates {
  const c = cache.get(scene);
  if (c) return c;
  const shell = shellMaterial(scene, "colShell", new Color3(0.05, 0.06, 0.08), 0.6, 0.3);
  const glow = glowMaterial(scene, "colGlow", new Color3(3.5, 1.8, 0.3));
  const plate = (size: number, thick: number, pos: Vector3, rot: Vector3) =>
    bakeT(cursorPlate(scene, "pl", size * CS, thick * CS), pos.scale(CS), rot);
  // 首の節: 前（+Z）を向いた板を軸のまわりに 3 枚
  const seg = merge("colSeg", [
    plate(7, 0.8, Vector3.Zero(), new Vector3(FWD, 0, 0)),
    plate(7, 0.8, Vector3.Zero(), new Vector3(FWD, 0, (Math.PI * 2) / 3)),
    plate(7, 0.8, Vector3.Zero(), new Vector3(FWD, 0, (-Math.PI * 2) / 3)),
  ]);
  // 頭: 大きな板を重ねた矢じり形と、下あご
  const head = merge("colHead", [
    plate(16, 1.4, new Vector3(0, 0, 4), new Vector3(FWD, 0, 0)),
    plate(12, 1.2, new Vector3(0, 1.5, 2), new Vector3(FWD - 0.25, 0, Math.PI / 2)),
    plate(11, 1.0, new Vector3(0, -2.2, 3), new Vector3(FWD + 0.25, 0, 0)),
    plate(8, 0.8, new Vector3(4, 0.5, 0), new Vector3(FWD, 0.5, 0.3)),
    plate(8, 0.8, new Vector3(-4, 0.5, 0), new Vector3(FWD, -0.5, -0.3)),
  ]);
  const eyes = merge("colEyes", [
    plate(2.2, 0.4, new Vector3(3.2, 1.2, 7), new Vector3(FWD, 0.3, 0.3)),
    plate(2.2, 0.4, new Vector3(-3.2, 1.2, 7), new Vector3(FWD, -0.3, -0.3)),
    plate(1.4, 0.3, new Vector3(2.2, 2.4, 5.5), new Vector3(FWD, 0.2, 0)),
    plate(1.4, 0.3, new Vector3(-2.2, 2.4, 5.5), new Vector3(FWD, -0.2, 0)),
  ]);
  seg.material = shell;
  head.material = shell;
  eyes.material = glow;
  for (const m of [seg, head, eyes]) {
    m.isPickable = false;
    m.position.y = -3000;
    m.alwaysSelectAsActiveMesh = true;
  }
  const t = { seg, head, eyes };
  cache.set(scene, t);
  return t;
}

export function colossusTemplateMeshes(scene: Scene): Mesh[] {
  const t = templates(scene);
  return [t.seg, t.head];
}

function bezier(p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, u: number, out: Vector3) {
  const a = (1 - u) ** 3,
    b = 3 * (1 - u) ** 2 * u,
    c = 3 * (1 - u) * u * u,
    d = u ** 3;
  out.set(
    p0.x * a + p1.x * b + p2.x * c + p3.x * d,
    p0.y * a + p1.y * b + p2.y * c + p3.y * d,
    p0.z * a + p1.z * b + p2.z * c + p3.z * d,
  );
  return out;
}

export class Colossus {
  private segs: TransformNode[] = [];
  private head: TransformNode;
  private p0: Vector3;
  private p1: Vector3;
  private p2: Vector3;
  private p3: Vector3;
  private t = 0;
  private rise = 0;
  phase: "rise" | "watch" | "sink" | "done" = "rise";
  private readonly riseTime = 8;
  private readonly watchTime = 9;
  private readonly sinkTime = 7;

  /**
   * 首の曲線の制御点。根元はビルの裏（地中）、頭（p3）はビルの横・屋上より上から覗く。
   * @param side 左右どちらから覗くか（±1）
   */
  static path(player: Vector3, b: Building, side: number): [Vector3, Vector3, Vector3, Vector3] {
    const bc = new Vector3(b.cx, 0, b.cz);
    const away = bc.subtract(player);
    away.y = 0;
    away.normalize();
    const lat = new Vector3(-away.z, 0, away.x).scale(side);
    const R = Math.max(b.hw, b.hd);
    const H = b.height;
    const p0 = bc.add(away.scale(R + 30)).addInPlace(new Vector3(0, -15, 0));
    const p1 = p0.add(new Vector3(0, H * 1.1, 0));
    const p3 = bc.add(away.scale(R * 0.2)).addInPlace(lat.scale(R + 8)).addInPlace(new Vector3(0, H + 18, 0));
    const p2 = p3.add(away.scale(30)).addInPlace(new Vector3(0, 15, 0));
    return [p0, p1, p2, p3];
  }

  constructor(
    private ctx: GameContext,
    b: Building,
    side: number,
  ) {
    const T = templates(ctx.scene);
    const pts = Colossus.path(ctx.player.position, b, side);
    [this.p0, this.p1, this.p2, this.p3] = pts;
    for (let i = 0; i < SEGMENTS; i++) {
      const s = T.seg.createInstance("colSeg");
      s.position.copyFrom(this.p0);
      s.rotationQuaternion = new Quaternion();
      const k = 1 - (i / SEGMENTS) * 0.45; // 先端ほど細く
      s.scaling.setAll(k);
      this.segs.push(s);
    }
    const head = new TransformNode("colHeadRoot", ctx.scene);
    head.rotationQuaternion = new Quaternion();
    const hm = T.head.createInstance("colHead");
    hm.parent = head;
    hm.position.setAll(0);
    const em = T.eyes.createInstance("colEyes");
    em.parent = head;
    em.position.setAll(0);
    head.position.copyFrom(this.p0);
    this.head = head;
    sfx.collapse(this.p3);
  }

  /** 戻り値: まだ演出中なら true */
  update(dt: number): boolean {
    if (this.phase === "done") return false;
    this.t += dt;
    if (this.phase === "rise") {
      this.rise = Math.min(1, this.t / this.riseTime);
      if (this.rise >= 1) {
        this.phase = "watch";
        this.t = 0;
      }
    } else if (this.phase === "watch") {
      if (this.t > this.watchTime) {
        this.phase = "sink";
        this.t = 0;
      }
    } else if (this.phase === "sink") {
      this.rise = Math.max(0, 1 - this.t / this.sinkTime);
      if (this.rise <= 0) {
        this.dispose();
        return false;
      }
    }
    // ゆっくり加減速（ease in-out）
    const r = this.rise * this.rise * (3 - 2 * this.rise);
    const pos = new Vector3();
    const next = new Vector3();
    for (let i = 0; i < SEGMENTS; i++) {
      const u = (i / SEGMENTS) * r;
      bezier(this.p0, this.p1, this.p2, this.p3, u, pos);
      bezier(this.p0, this.p1, this.p2, this.p3, Math.min(1, u + 0.02), next);
      // 首のうねり
      pos.y += Math.sin(this.t * 0.9 + i * 0.5) * 0.4 * r;
      this.segs[i].position.copyFrom(pos);
      const tan = next.subtract(pos);
      if (tan.lengthSquared() > 1e-6) lookQuat(tan, this.segs[i].rotationQuaternion!, i * 0.3);
    }
    bezier(this.p0, this.p1, this.p2, this.p3, r, pos);
    this.head.position.copyFrom(pos);
    // 頭はプレイヤーを見つめる（少し首をかしげる）
    const look = this.ctx.player.chest.subtract(pos);
    const sway = Math.sin(this.t * 0.6) * 0.15;
    lookQuat(look, this.head.rotationQuaternion!, sway);
    return true;
  }

  /** 頭の位置（無線演出などで使う） */
  get headPosition() {
    return this.head.position;
  }

  dispose() {
    this.phase = "done";
    for (const s of this.segs) s.dispose();
    this.head.dispose();
  }
}
