// ============================================================================
// 輸送船（巨大生物を投下する母艦）
// ----------------------------------------------------------------------------
// 地球防衛軍2 の紹介記事では「インベーダーの輸送船は上空から巨大生物を投下し、
// 撃墜しない限り延々と敵が投下され続ける場合もある」とされている。本作では:
//  ・マップの端から飛来し、プレイヤーの近くの上空で停止する
//  ・一定間隔で底面のハッチを開き、蟻型を次々に投下する
//  ・装甲が厚く、ハッチが開いている間に内部（赤く光るコア）を撃たないとほとんど効かない
//  ・撃墜するとバラバラになって墜落し、地上で大爆発する
// ============================================================================
import { Color3, InstancedMesh, Matrix, Mesh, Quaternion, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { ENEMIES } from "../data/enemies";
import type { GameContext } from "../core/GameContext";
import { Enemy } from "./Enemy";
import { bakeT, cursorPlate, glowMaterial, merge, shellMaterial } from "./AlienShapes";
import { hideTemplate } from "./Ant";
import { Ragdoll } from "../core/Physics";
import { rand } from "../core/MathUtil";
import { sfx } from "../core/Audio";

interface Templates {
  hull: Mesh;
  hatch: Mesh;
  core: Mesh;
}
const cache = new WeakMap<Scene, Templates>();

function templates(scene: Scene): Templates {
  const c = cache.get(scene);
  if (c) return c;
  const shell = shellMaterial(scene, "carrierShell", new Color3(0.16, 0.17, 0.19), 0.85, 0.3);
  const glow = glowMaterial(scene, "carrierCore", new Color3(4, 0.4, 0.2));
  const plates: Mesh[] = [];
  // 円盤: 外向きの大きな板を水平に放射状に並べ、その上に小さな板を重ねる
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const p = cursorPlate(scene, "cp", 20, 2.2);
    p.bakeTransformIntoVertices(
      Matrix.Translation(0, 7, 0)
        .multiply(Matrix.RotationX(Math.PI / 2))
        .multiply(Matrix.RotationY(a)),
    );
    plates.push(p);
  }
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.3;
    const p = cursorPlate(scene, "cp2", 12, 1.5);
    p.bakeTransformIntoVertices(
      Matrix.Translation(0, 4, 0)
        .multiply(Matrix.RotationX(Math.PI / 2 - 0.35))
        .multiply(Matrix.RotationY(a))
        .multiply(Matrix.Translation(0, 2.2, 0)),
    );
    plates.push(p);
  }
  // 上部の塔
  plates.push(bakeT(cursorPlate(scene, "tw", 9, 1.2), new Vector3(0, 5, 0), new Vector3(0, 0, 0)));
  plates.push(bakeT(cursorPlate(scene, "tw2", 9, 1.2), new Vector3(0, 5, 0), new Vector3(0, Math.PI / 2, 0)));
  const hull = merge("carrierHull", plates);
  hull.material = shell;
  // ハッチの扉（1枚。4枚を回転して使う。原点はヒンジ）
  const hatch = bakeT(cursorPlate(scene, "hatch", 7, 0.8), new Vector3(0, -0.6, 2.5), new Vector3(Math.PI / 2, 0, 0));
  hatch.material = shell;
  const core = merge("carrierCoreM", [
    bakeT(cursorPlate(scene, "core", 4, 2), new Vector3(0, 0, 0), new Vector3(0, 0, 0)),
    bakeT(cursorPlate(scene, "core2", 4, 2), new Vector3(0, 0, 0), new Vector3(0, Math.PI / 2, 0)),
  ]);
  core.material = glow;
  const t = { hull, hatch, core };
  for (const m of Object.values(t)) hideTemplate(m);
  cache.set(scene, t);
  return t;
}

export function carrierTemplateMeshes(scene: Scene): Mesh[] {
  const t = templates(scene);
  return [t.hull, t.hatch];
}

type CarrierState = "arrive" | "closed" | "opening" | "open" | "closing";

export class Carrier extends Enemy {
  private hull: InstancedMesh;
  private hatches: TransformNode[] = [];
  private hatchMeshes: InstancedMesh[] = [];
  private core: InstancedMesh;
  private state: CarrierState = "arrive";
  private stateT = 0;
  private hatchOpen = 0; // 0..1
  private hover: Vector3;
  private dropCd = 0;
  private drops = 0;
  /** 1回の開放で投下する数 */
  private readonly perOpen = 4;

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
    this.core = inst(T.core, this.root);
    this.core.position.y = 2;
    for (let k = 0; k < 4; k++) {
      const hinge = new TransformNode("hinge", ctx.scene);
      hinge.parent = this.root;
      const a = (k / 4) * Math.PI * 2;
      hinge.position.set(Math.sin(a) * 4.5, -1, Math.cos(a) * 4.5);
      hinge.rotationQuaternion = Quaternion.RotationYawPitchRoll(a + Math.PI, 0, 0);
      this.hatches.push(hinge);
      this.hatchMeshes.push(inst(T.hatch, hinge));
    }
    this.hitSpheres = [
      // コア（ハッチが開いているときだけ有効）
      { local: new Vector3(0, 0.5, 0), r: 4, world: new Vector3(), mult: 1 },
      // 外殻（ほとんど効かない）
      { local: new Vector3(0, 3, 0), r: 16, world: new Vector3(), mult: 0 },
    ];
    this.updateHitSpheres();
  }

  center(): Vector3 {
    return this.position;
  }

  /** ハッチが開いているか（コアを狙える） */
  get exposed() {
    return this.hatchOpen > 0.5;
  }

  damage(amount: number, dir: Vector3, point: Vector3, knock: number) {
    // 装甲: ハッチが閉じている間はほぼ無効
    super.damage(this.exposed ? amount : amount * 0.03, dir, point, 0);
    void knock;
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
    this.yaw += dt * 0.05;
    Quaternion.RotationYawPitchRollToRef(this.yaw, Math.sin(this.t * 0.4) * 0.03, Math.cos(this.t * 0.33) * 0.03, this.root.rotationQuaternion!);

    switch (this.state) {
      case "arrive":
        if (l < 4) this.setState("closed");
        break;
      case "closed":
        if (this.stateT > (this.drops === 0 ? 2 : 9)) this.setState("opening");
        break;
      case "opening":
        if (this.hatchOpen >= 1) this.setState("open");
        break;
      case "open":
        this.dropCd -= dt;
        if (this.dropCd <= 0 && this.stateT < this.perOpen * 1.1) {
          this.dropCd = 1.0;
          this.dropAnt();
        }
        if (this.stateT > this.perOpen * 1.1 + 2.5) this.setState("closing");
        break;
      case "closing":
        if (this.hatchOpen <= 0) this.setState("closed");
        break;
    }
    const want = this.state === "opening" || this.state === "open" ? 1 : 0;
    this.hatchOpen += Math.sign(want - this.hatchOpen) * Math.min(Math.abs(want - this.hatchOpen), dt / 1.5);
    for (const h of this.hatchMeshes) h.rotationQuaternion = Quaternion.RotationYawPitchRoll(0, this.hatchOpen * 1.3, 0);
    // コアは開いているときだけ見える高さまで降りてくる
    this.core.position.y = 2 - this.hatchOpen * 3;
    this.core.scaling.setAll(0.8 + Math.sin(this.t * 6) * 0.05 + this.hatchOpen * 0.3);
    this.hitSpheres[0].local.y = this.core.position.y;
    this.hitSpheres[0].mult = this.exposed ? 1.5 : 0.03;
  }

  private setState(s: CarrierState) {
    this.state = s;
    this.stateT = 0;
    if (s === "opening") sfx.collapse(this.position);
    if (s === "open") this.ctx.enemies.carrierOpened?.(this);
  }

  private dropAnt() {
    // 生きている投下済みの蟻が多すぎるときは控える
    if (this.ctx.enemies.list.filter((e) => e.kind === "ant").length > 40) return;
    const p = this.position.add(new Vector3(rand(-2, 2), -4, rand(-2, 2)));
    this.ctx.enemies.dropAnt(p);
    this.drops++;
  }

  protected onDeath(dir: Vector3) {
    sfx.explosion(this.position, 2.5);
    this.ctx.effects.explosion(this.position, 22, false);
    this.ctx.effects.addShake(0.8);
    // 外殻・ハッチがバラバラになって墜落する
    const parts = [
      { node: this.hull as TransformNode, parent: -1, size: new Vector3(30, 5, 30), center: new Vector3(0, 3, 0), mass: 20000 },
      ...this.hatchMeshes.map((h) => ({ node: h as TransformNode, parent: -1, size: new Vector3(4, 0.8, 6), center: new Vector3(0, -0.6, 2.5), mass: 600 })),
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
    this.core.dispose();
    this.root.dispose();
  }
}
