// ============================================================================
// 陸戦兵の見た目（プロシージャルモデル）とアニメーション、ラグドール化。
// ----------------------------------------------------------------------------
// 各パーツは「関節位置を原点にした TransformNode」で、子に見た目のメッシュを持つ。
// 腕は武器のグリップ位置へ 2 ボーン IK で手を伸ばすので、武器モデルを
// 差し替えても自然に構える。
// ============================================================================
import { Color3, Mesh, MeshBuilder, PBRMaterial, Quaternion, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { Ragdoll, RagdollOptions, RigPart } from "../core/Physics";
import { basisQuat, clamp, fromToQuat } from "../core/MathUtil";
import type { WeaponModel } from "../data/weapons";

export interface GunModel {
  root: TransformNode;
  muzzle: TransformNode;
  gripR: Vector3;
  gripL: Vector3;
  /** 肩に担ぐ武器か */
  shoulder: boolean;
  /** gunPivot（銃床の当たる位置）から銃モデル原点までのずれ */
  offset: Vector3;
}

interface SoldierMats {
  armor: PBRMaterial;
  suit: PBRMaterial;
  dark: PBRMaterial;
  visor: PBRMaterial;
  gunMetal: PBRMaterial;
  gunPoly: PBRMaterial;
  web: PBRMaterial;
}

function makeMats(scene: Scene): SoldierMats {
  const pbr = (name: string, c: Color3, rough: number, metal: number) => {
    const m = new PBRMaterial(name, scene);
    m.albedoColor = c;
    m.roughness = rough;
    m.metallic = metal;
    return m;
  };
  const visor = pbr("sVisor", new Color3(0.02, 0.03, 0.04), 0.05, 0.6);
  visor.clearCoat.isEnabled = true;
  const web = pbr("sWeb", new Color3(0.9, 0.9, 0.88), 0.6, 0);
  web.alpha = 0.85;
  return {
    armor: pbr("sArmor", new Color3(0.26, 0.3, 0.22), 0.5, 0.15),
    suit: pbr("sSuit", new Color3(0.07, 0.08, 0.08), 0.85, 0),
    dark: pbr("sDark", new Color3(0.03, 0.03, 0.03), 0.7, 0.1),
    visor,
    gunMetal: pbr("gunMetal", new Color3(0.06, 0.065, 0.07), 0.35, 0.85),
    gunPoly: pbr("gunPoly", new Color3(0.13, 0.13, 0.12), 0.7, 0),
    web,
  };
}

export class Soldier {
  root: TransformNode;
  /** 回避ロール用の回転軸 */
  rollPivot: TransformNode;
  pelvis!: TransformNode;
  torso!: TransformNode;
  head!: TransformNode;
  upperArmL!: TransformNode;
  foreArmL!: TransformNode;
  upperArmR!: TransformNode;
  foreArmR!: TransformNode;
  thighL!: TransformNode;
  shinL!: TransformNode;
  thighR!: TransformNode;
  shinR!: TransformNode;
  footL!: TransformNode;
  footR!: TransformNode;
  gunPivot!: TransformNode;
  meshes: Mesh[] = [];
  private mats: SoldierMats;
  private guns = new Map<WeaponModel, GunModel>();
  gun!: GunModel;
  private rig: RigPart[] = [];
  private restore: { node: TransformNode; parent: TransformNode | null; pos: Vector3 }[] = [];
  ragdoll: Ragdoll | null = null;
  private webMeshes: Mesh[] = [];
  /** 歩行周期の位相（0..1） */
  private gait = 0;
  /** 姿勢の補間用（急に切り替わらないように平滑化する） */
  private sm = { low: 0, reload: 0, pelvisYaw: 0.2, move: 0, air: 0, stance: [1, 1], hipY: 0.015 };
  private readonly L1 = 0.3;
  private readonly L2 = 0.3;

  constructor(private scene: Scene) {
    this.mats = makeMats(scene);
    this.root = new TransformNode("soldier", scene);
    this.rollPivot = new TransformNode("rollPivot", scene);
    this.rollPivot.parent = this.root;
    this.rollPivot.position.y = 0.95;
    this.buildBody();
    this.buildWeb();
  }

  private part(name: string, parent: TransformNode, pos: Vector3): TransformNode {
    const n = new TransformNode(name, this.scene);
    n.parent = parent;
    n.position.copyFrom(pos);
    n.rotationQuaternion = Quaternion.Identity();
    return n;
  }

  private add(m: Mesh, parent: TransformNode, mat: PBRMaterial, pos?: Vector3) {
    m.parent = parent;
    if (pos) m.position.copyFrom(pos);
    m.material = mat;
    m.receiveShadows = true;
    m.isPickable = false;
    this.meshes.push(m);
    return m;
  }

  private buildBody() {
    const s = this.scene;
    const M = this.mats;
    const V = (x: number, y: number, z: number) => new Vector3(x, y, z);
    const box = (w: number, h: number, d: number) => MeshBuilder.CreateBox("b", { width: w, height: h, depth: d }, s);
    const cap = (r: number, h: number) => MeshBuilder.CreateCapsule("c", { radius: r, height: h, tessellation: 10, subdivisions: 1 }, s);
    const sph = (d: number) => MeshBuilder.CreateSphere("s", { diameter: d, segments: 10 }, s);

    // 骨盤（ルート）
    this.pelvis = this.part("pelvis", this.rollPivot, V(0, 0.05, 0));
    this.add(box(0.34, 0.2, 0.22), this.pelvis, M.suit);
    this.add(box(0.37, 0.07, 0.25), this.pelvis, M.dark, V(0, 0.07, 0));
    this.add(box(0.12, 0.1, 0.06), this.pelvis, M.armor, V(0.12, 0.05, 0.13)); // ポーチ
    this.add(box(0.12, 0.1, 0.06), this.pelvis, M.armor, V(-0.12, 0.05, 0.13));

    // 胴体
    this.torso = this.part("torso", this.pelvis, V(0, 0.09, 0));
    this.add(box(0.38, 0.5, 0.23), this.torso, M.suit, V(0, 0.26, 0));
    this.add(box(0.4, 0.38, 0.07), this.torso, M.armor, V(0, 0.3, 0.13)); // 胸部装甲
    this.add(box(0.4, 0.42, 0.07), this.torso, M.armor, V(0, 0.3, -0.13)); // 背部装甲
    this.add(box(0.3, 0.32, 0.12), this.torso, M.dark, V(0, 0.32, -0.21)); // バックパック
    this.add(box(0.1, 0.12, 0.05), this.torso, M.dark, V(-0.1, 0.22, 0.18)); // マガジンポーチ
    this.add(box(0.1, 0.12, 0.05), this.torso, M.dark, V(0.02, 0.22, 0.18));
    for (const sx of [-1, 1]) {
      const pad = this.add(box(0.16, 0.08, 0.2), this.torso, M.armor, V(sx * 0.25, 0.5, 0));
      pad.rotation.z = -sx * 0.35;
    }
    // 首と頭
    this.head = this.part("head", this.torso, V(0, 0.53, 0));
    this.add(cap(0.05, 0.12), this.head, M.suit, V(0, 0.03, 0));
    this.add(sph(0.22), this.head, M.suit, V(0, 0.14, 0.01));
    const helmet = this.add(sph(0.29), this.head, M.armor, V(0, 0.19, -0.01));
    helmet.scaling.set(1, 0.82, 1.08);
    this.add(box(0.21, 0.08, 0.06), this.head, M.visor, V(0, 0.14, 0.11));
    this.add(box(0.05, 0.05, 0.08), this.head, M.dark, V(0.14, 0.17, 0.02)); // 通信機

    // 腕
    const arm = (sx: number) => {
      const up = this.part(sx > 0 ? "upperArmR" : "upperArmL", this.torso, V(sx * 0.24, 0.45, 0));
      this.add(cap(0.058, this.L1 + 0.06), up, M.suit, V(0, -this.L1 / 2, 0));
      this.add(box(0.13, 0.12, 0.13), up, M.armor, V(0, -0.06, 0));
      const fo = this.part(sx > 0 ? "foreArmR" : "foreArmL", up, V(0, -this.L1, 0));
      this.add(cap(0.05, this.L2), fo, M.suit, V(0, -this.L2 / 2, 0));
      this.add(box(0.11, 0.14, 0.11), fo, M.armor, V(0, -0.1, 0));
      this.add(box(0.07, 0.11, 0.1), fo, M.dark, V(0, -this.L2 - 0.02, 0)); // 手袋
      return [up, fo];
    };
    [this.upperArmL, this.foreArmL] = arm(-1);
    [this.upperArmR, this.foreArmR] = arm(1);

    // 脚
    const leg = (sx: number) => {
      const th = this.part(sx > 0 ? "thighR" : "thighL", this.pelvis, V(sx * 0.11, -0.04, 0));
      this.add(cap(0.085, 0.46), th, M.suit, V(0, -0.22, 0));
      this.add(box(0.14, 0.22, 0.1), th, M.armor, V(0, -0.18, 0.06));
      const sh = this.part(sx > 0 ? "shinR" : "shinL", th, V(0, -0.44, 0));
      this.add(cap(0.07, 0.44), sh, M.suit, V(0, -0.2, 0));
      this.add(box(0.12, 0.12, 0.08), sh, M.armor, V(0, 0, 0.07)); // 膝
      this.add(box(0.13, 0.3, 0.06), sh, M.armor, V(0, -0.2, 0.06)); // すね
      const ft = this.part(sx > 0 ? "footR" : "footL", sh, V(0, -0.41, 0));
      this.add(box(0.13, 0.11, 0.27), ft, M.dark, V(0, -0.02, 0.05)); // ブーツ
      this.add(box(0.135, 0.03, 0.29), ft, M.suit, V(0, -0.075, 0.05)); // ソール
      return [th, sh, ft];
    };
    [this.thighL, this.shinL, this.footL] = leg(-1);
    [this.thighR, this.shinR, this.footR] = leg(1);

    this.gunPivot = new TransformNode("gunPivot", this.scene);
    this.gunPivot.parent = this.torso;
    this.gunPivot.position.set(0.12, 0.5, 0.15);
    this.gunPivot.rotationQuaternion = Quaternion.Identity();

    // ラグドール定義（質量 kg、箱の大きさ m）
    const R = (node: TransformNode, parent: number, size: Vector3, center: Vector3, mass: number, swing = 0.8, twist = 0.4): RigPart => ({
      node,
      parent,
      size,
      center,
      mass,
      swing,
      twist,
    });
    this.rig = [
      R(this.pelvis, -1, V(0.34, 0.22, 0.24), V(0, 0, 0), 14),
      R(this.torso, 0, V(0.4, 0.5, 0.3), V(0, 0.26, 0), 24, 0.5, 0.3),
      R(this.head, 1, V(0.26, 0.28, 0.28), V(0, 0.15, 0), 5, 0.6, 0.6),
      R(this.upperArmL, 1, V(0.12, this.L1, 0.12), V(0, -this.L1 / 2, 0), 2.5, 1.4, 0.6),
      R(this.foreArmL, 3, V(0.1, this.L2, 0.1), V(0, -this.L2 / 2, 0), 2, 1.2, 0.3),
      R(this.upperArmR, 1, V(0.12, this.L1, 0.12), V(0, -this.L1 / 2, 0), 2.5, 1.4, 0.6),
      R(this.foreArmR, 5, V(0.1, this.L2, 0.1), V(0, -this.L2 / 2, 0), 2, 1.2, 0.3),
      R(this.thighL, 0, V(0.16, 0.44, 0.16), V(0, -0.22, 0), 8, 0.9, 0.3),
      R(this.shinL, 7, V(0.13, 0.46, 0.14), V(0, -0.23, 0.02), 5, 1.0, 0.2),
      R(this.thighR, 0, V(0.16, 0.44, 0.16), V(0, -0.22, 0), 8, 0.9, 0.3),
      R(this.shinR, 9, V(0.13, 0.46, 0.14), V(0, -0.23, 0.02), 5, 1.0, 0.2),
    ];
  }

  private buildWeb() {
    // 蜘蛛の糸に拘束されたときの見た目
    const parts = [this.torso, this.pelvis, this.thighL, this.thighR, this.upperArmL, this.upperArmR];
    for (let i = 0; i < 14; i++) {
      const p = parts[i % parts.length];
      const m = MeshBuilder.CreateCylinder("web", { height: 0.9, diameter: 0.025, tessellation: 4 }, this.scene);
      m.parent = p;
      m.position.set((Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.3 + (p === this.torso ? 0.25 : -0.15), (Math.random() - 0.5) * 0.2);
      m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      m.material = this.mats.web;
      m.isPickable = false;
      m.setEnabled(false);
      this.webMeshes.push(m);
    }
  }

  setWebbed(on: boolean) {
    for (const m of this.webMeshes) m.setEnabled(on);
  }

  // ------------------------------------------------------------------ 武器モデル
  setWeaponModel(model: WeaponModel) {
    if (this.gun) this.gun.root.setEnabled(false);
    let g = this.guns.get(model);
    if (!g) {
      g = this.buildGun(model);
      this.guns.set(model, g);
    }
    g.root.setEnabled(true);
    g.root.position.copyFrom(g.offset);
    this.gun = g;
  }

  private buildGun(model: WeaponModel): GunModel {
    const s = this.scene;
    const M = this.mats;
    const root = new TransformNode("gun_" + model, s);
    root.parent = this.gunPivot;
    const add = (m: Mesh, mat: PBRMaterial, x: number, y: number, z: number) => {
      m.parent = root;
      m.position.set(x, y, z);
      m.material = mat;
      m.isPickable = false;
      this.meshes.push(m);
      return m;
    };
    const box = (w: number, h: number, d: number) => MeshBuilder.CreateBox("g", { width: w, height: h, depth: d }, s);
    const cyl = (d: number, len: number) => {
      const c = MeshBuilder.CreateCylinder("g", { diameter: d, height: len, tessellation: 12 }, s);
      c.rotation.x = Math.PI / 2;
      return c;
    };
    const muzzle = new TransformNode("muzzle", s);
    muzzle.parent = root;
    let gripR = new Vector3(0, -0.07, -0.04);
    let gripL = new Vector3(0, -0.06, 0.27);
    let shoulder = false;
    // 銃床の後端が gunPivot（右肩のくぼみ）に来るようにずらす
    let offset = new Vector3(0, 0.03, 0.4);
    if (model === "launcher") {
      shoulder = true;
      add(cyl(0.17, 1.25), M.gunPoly, 0, 0, 0.15);
      add(cyl(0.2, 0.12), M.gunMetal, 0, 0, 0.75);
      add(cyl(0.2, 0.12), M.gunMetal, 0, 0, -0.45);
      add(box(0.08, 0.16, 0.2), M.gunMetal, 0.13, 0.03, 0.25); // 照準器
      add(box(0.05, 0.14, 0.05), M.gunMetal, 0, -0.15, 0.1); // グリップ
      add(box(0.05, 0.12, 0.05), M.gunMetal, 0, -0.14, 0.42);
      muzzle.position.set(0, 0, 0.82);
      gripR = new Vector3(0, -0.2, 0.1);
      gripL = new Vector3(0, -0.19, 0.42);
      offset = new Vector3(0, 0.14, 0.05); // 筒を右肩に載せる
    } else if (model === "sniper") {
      add(box(0.07, 0.11, 0.5), M.gunMetal, 0, 0, 0.05);
      add(cyl(0.035, 0.75), M.gunMetal, 0, 0.02, 0.65);
      add(box(0.06, 0.12, 0.32), M.gunPoly, 0, -0.02, -0.33);
      add(cyl(0.06, 0.32), M.gunMetal, 0, 0.1, 0.08);
      add(box(0.04, 0.13, 0.06), M.gunPoly, 0, -0.1, 0.02);
      muzzle.position.set(0, 0.02, 1.03);
      offset = new Vector3(0, 0.03, 0.49);
      gripL = new Vector3(0, -0.06, 0.3);
    } else if (model === "shotgun") {
      add(box(0.08, 0.12, 0.42), M.gunMetal, 0, 0, 0.05);
      add(cyl(0.05, 0.5), M.gunMetal, 0, 0.025, 0.5);
      add(cyl(0.045, 0.45), M.gunMetal, 0, -0.035, 0.45);
      add(box(0.07, 0.07, 0.18), M.gunPoly, 0, -0.035, 0.32); // ポンプ
      add(box(0.06, 0.12, 0.3), M.gunPoly, 0, -0.03, -0.3);
      muzzle.position.set(0, 0.025, 0.76);
      offset = new Vector3(0, 0.03, 0.45);
      gripL = new Vector3(0, -0.06, 0.3);
    } else {
      // アサルトライフル
      add(box(0.07, 0.12, 0.42), M.gunMetal, 0, 0, 0.04);
      add(box(0.075, 0.09, 0.28), M.gunPoly, 0, -0.005, 0.38); // ハンドガード
      add(cyl(0.028, 0.22), M.gunMetal, 0, 0.01, 0.62);
      const mag = add(box(0.045, 0.2, 0.09), M.gunPoly, 0, -0.14, 0.12);
      mag.rotation.x = 0.25;
      add(box(0.06, 0.1, 0.26), M.gunPoly, 0, -0.03, -0.27); // ストック
      add(box(0.04, 0.12, 0.05), M.gunPoly, 0, -0.1, -0.03); // グリップ
      add(box(0.05, 0.06, 0.14), M.gunMetal, 0, 0.09, 0.05); // ドットサイト
      muzzle.position.set(0, 0.01, 0.74);
    }
    return { root, muzzle, gripR, gripL, shoulder, offset };
  }

  // ------------------------------------------------------------------ アニメーション
  /*
   * 実際の動きを参考にした手付けのキーフレーム（数値は資料の値を丸めたもの）
   *  ・走り（ジョグ）: 接地時に膝 約15°屈曲 → 立脚中期に 約40°まで沈む → 遊脚中期に 90°前後まで畳む。
   *    立脚 約40% / 遊脚 約60% で、両足が地面から離れる瞬間がある。
   *  ・小銃の構え（現代の軍のスクエア気味のスタンス）: 胸を目標へ向け、左足をやや前、膝を軽く曲げて
   *    重心はやや前。銃床は右肩のくぼみ、頬を銃床に付け、左手はハンドガードを下から支える。
   *  ・ダッシュ中は銃口を斜め下に向けた「ローレディ」。
   *  ・飛び込み前転: 両足で前へ跳んで腕を前へ → 顎を引いて肩〜背中で転がる →
   *    かかとを尻に引き付けて丸まったまま、しゃがみ姿勢で起き上がる。
   */
  private static curve(keys: number[][], p: number): number {
    p -= Math.floor(p);
    for (let i = 1; i < keys.length; i++) {
      if (p <= keys[i][0]) {
        const [p0, v0] = keys[i - 1];
        const [p1, v1] = keys[i];
        const t = (p - p0) / (p1 - p0);
        return v0 + ((v1 - v0) * (1 - Math.cos(t * Math.PI))) / 2;
      }
    }
    return keys[keys.length - 1][1];
  }
  // [位相, 角度(rad)]。股関節は前に振るのが +、膝は曲げるのが +
  private static RUN_HIP = [[0, 0.42], [0.15, 0.08], [0.38, -0.35], [0.62, 0.3], [0.85, 0.66], [1, 0.42]];
  private static RUN_KNEE = [[0, 0.27], [0.15, 0.72], [0.38, 0.4], [0.62, 1.7], [0.85, 0.55], [1, 0.27]];
  private static WALK_HIP = [[0, 0.3], [0.3, 0.02], [0.6, -0.22], [0.8, 0.15], [1, 0.3]];
  private static WALK_KNEE = [[0, 0.1], [0.15, 0.3], [0.45, 0.12], [0.72, 1.05], [0.9, 0.25], [1, 0.1]];

  /** 脚を伸ばしたときの股関節から足裏までの高さ */
  private static legHeight(hip: number, knee: number) {
    return 0.44 * Math.cos(hip) + 0.41 * Math.cos(hip - knee) + 0.09;
  }

  private setLeg(thigh: TransformNode, shin: TransformNode, foot: TransformNode, hip: number, knee: number, splay: number, toe: number) {
    const q = Quaternion.RotationYawPitchRollToRef;
    q(0, -hip, splay, thigh.rotationQuaternion!);
    q(0, knee, 0, shin.rotationQuaternion!);
    // 足首: 足裏が地面と平行になるように打ち消し、遊脚ではつま先を下げる
    q(0, hip - knee + toe, 0, foot.rotationQuaternion!);
  }

  /**
   * @param fwd 前後速度（m/s、ローカル）
   * @param side 左右速度
   * @param aimPitch 照準の上下（ラジアン、下向きが +）
   * @param grounded 接地しているか
   * @param recoil 反動（0..1）
   * @param reloading リロード・武器切替中
   * @param lowReady ダッシュ中（銃を下げて走る）
   */
  animate(dt: number, fwd: number, side: number, aimPitch: number, grounded: boolean, recoil: number, reloading: boolean, lowReady = false) {
    if (this.ragdoll) return;
    const sm = this.sm;
    const k = (rate: number) => 1 - Math.exp(-rate * dt);
    const C = Soldier.curve;
    const speed = Math.hypot(fwd, side);
    const moving = speed > 0.4;

    // 進行方向。後ろ向きに歩くときは脚の周期を逆再生する
    let moveAng = moving ? Math.atan2(side, fwd) : 0;
    let dir = 1;
    if (Math.abs(moveAng) > 1.9) {
      dir = -1;
      moveAng -= Math.sign(moveAng) * Math.PI;
    }
    const pelvisYawT = moving ? clamp(moveAng * 0.85, -1.1, 1.1) : 0.25;
    sm.pelvisYaw += (pelvisYawT - sm.pelvisYaw) * k(9);
    sm.move += ((moving && grounded ? 1 : 0) - sm.move) * k(8);
    sm.air += ((grounded ? 0 : 1) - sm.air) * k(12);
    sm.low += ((lowReady ? 1 : 0) - sm.low) * k(10);
    sm.reload += ((reloading ? 1 : 0) - sm.reload) * k(10);

    const run = clamp((speed - 1.5) / 4, 0, 1);
    const sprint = clamp((speed - 7) / 5, 0, 1);
    if (moving) this.gait += dt * (0.9 + speed * 0.07) * dir;
    this.gait -= Math.floor(this.gait);

    // ---- 脚 ----
    const legAt = (p: number) => {
      const hipAmp = 1 + sprint * 0.3;
      const hip = (C(Soldier.WALK_HIP, p) * (1 - run) + C(Soldier.RUN_HIP, p) * run) * hipAmp;
      const knee = C(Soldier.WALK_KNEE, p) * (1 - run) + C(Soldier.RUN_KNEE, p) * (run + sprint * 0.25);
      const pp = p - Math.floor(p);
      const stance = pp < 0.38 + (1 - run) * 0.22 ? 1 : 0;
      return { hip, knee, stance };
    };
    const A = legAt(this.gait);
    const B = legAt(this.gait + 0.5);
    // 待機（左足を半歩前、膝は軽く曲げる）と空中（膝を引き付ける）
    const idleL = { hip: 0.24, knee: 0.32 },
      idleR = { hip: -0.1, knee: 0.3 };
    const airL = { hip: 0.75, knee: 1.25 },
      airR = { hip: 0.15, knee: 0.85 };
    const mix = (m: { hip: number; knee: number }, idle: { hip: number; knee: number }, air: { hip: number; knee: number }) => {
      const g = sm.move;
      let hip = m.hip * g + idle.hip * (1 - g);
      let knee = m.knee * g + idle.knee * (1 - g);
      hip = hip * (1 - sm.air) + air.hip * sm.air;
      knee = knee * (1 - sm.air) + air.knee * sm.air;
      return { hip, knee };
    };
    const L = mix(A, idleL, airL);
    const R = mix(B, idleR, airR);
    sm.stance[0] += (A.stance - sm.stance[0]) * k(18);
    sm.stance[1] += (B.stance - sm.stance[1]) * k(18);
    const toeL = (1 - sm.stance[0]) * 0.35 * sm.move + sm.air * 0.4;
    const toeR = (1 - sm.stance[1]) * 0.35 * sm.move + sm.air * 0.3;
    this.setLeg(this.thighL, this.shinL, this.footL, L.hip, L.knee, -0.05, toeL);
    this.setLeg(this.thighR, this.shinR, this.footR, R.hip, R.knee, 0.05, toeR);
    // 腰の高さ: 地面に着いている方の脚の長さに合わせる（膝を曲げると自然に沈む）
    const hipH = Math.max(Soldier.legHeight(L.hip, L.knee), Soldier.legHeight(R.hip, R.knee));
    const hipT = grounded ? hipH - 0.91 : 0.03;
    sm.hipY += (hipT - sm.hipY) * k(25);
    this.pelvis.position.y = sm.hipY;

    // ---- 体幹 ----
    const gaitPh = this.gait * Math.PI * 2;
    const q = Quaternion.RotationYawPitchRollToRef;
    q(sm.pelvisYaw, 0, Math.sin(gaitPh) * 0.05 * sm.move, this.pelvis.rotationQuaternion!);
    // 構えているときは胸をやや右へ向ける（左肩が前に出る）
    const chestYaw = 0.2 * (1 - sm.low);
    const torsoYaw = chestYaw - sm.pelvisYaw;
    const lean = 0.1 + run * 0.1 * sm.move + sprint * 0.12 + sm.low * 0.08;
    const torsoPitch = lean + aimPitch * 0.45 * (1 - sm.low) - recoil * 0.04;
    q(torsoYaw, torsoPitch, -Math.sin(gaitPh) * 0.04 * sm.move, this.torso.rotationQuaternion!);
    // 頭は照準方向。構えているときは頬付けで少し右に傾ける
    q(-chestYaw * 0.8, aimPitch * 0.85 - torsoPitch, 0.14 * (1 - sm.low) * (1 - sm.reload), this.head.rotationQuaternion!);
    this.upperArmL.position.z = 0.07 * (1 - sm.low);

    this.poseGun(aimPitch, recoil, torsoYaw, torsoPitch);
  }

  /** 銃の姿勢（胴体ローカル）を決め、両手を IK で銃に添える */
  private poseGun(aimPitch: number, recoil: number, torsoYaw: number, torsoPitch: number) {
    const sm = this.sm;
    const sh = this.gun.shoulder;
    // 照準方向（ルート空間）を胴体ローカルへ戻す
    const invP = Quaternion.Inverse(this.pelvis.rotationQuaternion!);
    const invT = Quaternion.Inverse(Quaternion.RotationYawPitchRoll(torsoYaw, torsoPitch, 0));
    const toLocal = (v: Vector3) => v.rotateByQuaternionToRef(invP, v).rotateByQuaternionToRef(invT, v);
    const a = aimPitch - recoil * 0.06;
    const f = toLocal(new Vector3(0, -Math.sin(a), Math.cos(a)));
    const u = toLocal(new Vector3(0, Math.cos(a), Math.sin(a)));
    const aimQ = basisQuat(f, u);
    const lowQ = sh ? Quaternion.RotationYawPitchRoll(-0.1, -0.45, 0) : Quaternion.RotationYawPitchRoll(-0.95, 0.32, 0.5);
    const reloadQ = sh ? Quaternion.RotationYawPitchRoll(-0.15, -0.2, 0) : Quaternion.RotationYawPitchRoll(-0.3, -0.35, -0.6);
    const gq = Quaternion.Slerp(Quaternion.Slerp(aimQ, lowQ, sm.low), reloadQ, sm.reload);
    this.gunPivot.rotationQuaternion = gq;
    const aimPos = sh ? new Vector3(0.21, 0.6, 0.02) : new Vector3(0.12, 0.5, 0.15);
    const lowPos = sh ? new Vector3(0.21, 0.58, 0) : new Vector3(0.16, 0.34, 0.2);
    const reloadPos = sh ? new Vector3(0.21, 0.56, 0.02) : new Vector3(0.1, 0.36, 0.24);
    const pos = Vector3.Lerp(Vector3.Lerp(aimPos, lowPos, sm.low), reloadPos, sm.reload);
    pos.subtractInPlace(f.scale(recoil * 0.05 * (1 - sm.low)));
    this.gunPivot.position.copyFrom(pos);

    // リロード中は左手を弾倉へ
    const mag = new Vector3(0, -0.17, 0.1);
    const gripL = Vector3.Lerp(this.gun.gripL, mag, sh ? 0 : sm.reload);
    this.solveArm(this.upperArmR, this.foreArmR, this.gun.gripR, new Vector3(0.6, -1, -0.6));
    this.solveArm(this.upperArmL, this.foreArmL, gripL, new Vector3(-0.5, -1, -0.1));
  }

  private solveArm(upper: TransformNode, fore: TransformNode, grip: Vector3, pole: Vector3) {
    // グリップ位置を胴体ローカルへ
    const gp = this.gunPivot;
    const gq = gp.rotationQuaternion!;
    const target = grip.add(this.gun.offset).rotateByQuaternionToRef(gq, new Vector3()).addInPlace(gp.position);
    const S = upper.position;
    const st = target.subtract(S);
    let d = st.length();
    const l1 = this.L1,
      l2 = this.L2 + 0.05;
    d = Math.min(Math.max(d, Math.abs(l1 - l2) + 0.01), l1 + l2 - 0.001);
    const dir = st.normalize();
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const p = pole.normalizeToNew();
    const bend = p.subtract(dir.scale(Vector3.Dot(p, dir))).normalize();
    const elbow = S.add(dir.scale(a)).add(bend.scale(h));
    const down = new Vector3(0, -1, 0);
    const uq = fromToQuat(down, elbow.subtract(S), upper.rotationQuaternion ?? new Quaternion());
    upper.rotationQuaternion = uq;
    const toT = S.add(dir.scale(d)).subtract(elbow);
    const local = toT.rotateByQuaternionToRef(Quaternion.Inverse(uq), new Vector3());
    fore.rotationQuaternion = fromToQuat(down, local, fore.rotationQuaternion ?? new Quaternion());
  }

  /** ルートに対するロールの角度（互換用。0 で通常姿勢に戻す） */
  setRoll(angle: number) {
    this.rollPivot.rotationQuaternion = Quaternion.RotationYawPitchRoll(0, angle, 0);
    this.rollPivot.position.y = 0.95;
  }

  /**
   * 飛び込み前転のポーズ。k = 0..1（経過割合）
   *  0.00-0.16 踏み切り: 前傾して沈み込む
   *  0.16-0.36 飛び込み: 体を水平近くまで倒して前へ伸びる
   *  0.36-0.78 前転: 膝を胸に引き付けて丸まり、肩から背中で一回転
   *  0.78-1.00 起き上がり: しゃがみ姿勢から立ち上がる
   */
  animateRoll(k: number) {
    if (this.ragdoll) return;
    const TAU = Math.PI * 2;
    const ease = (t: number) => t * t * (3 - 2 * t);
    const seg = (a: number, b: number) => clamp((k - a) / (b - a), 0, 1);
    let ang: number, h: number, hip: number, knee: number, tp: number, hp: number;
    if (k < 0.16) {
      const t = ease(seg(0, 0.16));
      ang = 0.85 * t;
      hip = 0.3 + 0.4 * t;
      knee = 0.35 + 0.6 * t;
      h = 0.95 - 0.14 * t;
      tp = 0.25 * t;
      hp = -0.2 * t;
    } else if (k < 0.36) {
      const t = ease(seg(0.16, 0.36));
      ang = 0.85 + 0.7 * t;
      hip = 0.7 - 0.8 * t;
      knee = 0.95 - 0.75 * t;
      h = 0.81 + 0.18 * Math.sin(t * Math.PI);
      tp = 0.25 - 0.25 * t;
      hp = -0.2 - 0.25 * t;
    } else if (k < 0.78) {
      const t = seg(0.36, 0.78);
      const tuck = ease(clamp(t * 2.5, 0, 1));
      ang = 1.55 + (TAU - 1.55) * ease(t);
      hip = -0.1 + 2.1 * tuck - 0.3 * ease(clamp((t - 0.7) / 0.3, 0, 1));
      knee = 0.2 + 2.15 * tuck;
      h = 0.81 - 0.29 * tuck - 0.17 * ease(clamp((t - 0.7) / 0.3, 0, 1));
      tp = 0.65 * tuck;
      hp = -0.45 + 1.15 * tuck;
    } else {
      const t = ease(seg(0.78, 1));
      ang = TAU;
      hip = 1.7 - 1.46 * t;
      knee = 2.35 - 2.03 * t;
      h = Soldier.legHeight(hip, knee) - 0.01;
      tp = 0.65 - 0.5 * t;
      hp = 0.7 - 0.7 * t;
    }
    const q = Quaternion.RotationYawPitchRollToRef;
    q(0, ang, 0, (this.rollPivot.rotationQuaternion ??= new Quaternion()));
    this.rollPivot.position.y = h;
    this.pelvis.position.y = 0.03;
    q(0, 0, 0, this.pelvis.rotationQuaternion!);
    q(0, tp, 0, this.torso.rotationQuaternion!);
    q(0, hp, 0, this.head.rotationQuaternion!);
    this.setLeg(this.thighL, this.shinL, this.footL, hip, knee, -0.08, 0.4);
    this.setLeg(this.thighR, this.shinR, this.footR, hip * 0.92, knee * 0.97, 0.08, 0.4);
    this.sm.low = 1;
    this.sm.reload = 0;
    this.sm.hipY = 0.03;
    this.sm.move = 0;
    this.upperArmL.position.z = 0;
    this.poseGun(0, 0, 0, tp);
  }

  // ------------------------------------------------------------------ ラグドール
  startRagdoll(opts: RagdollOptions) {
    if (this.ragdoll) return;
    this.restore = this.rig.map((p) => ({ node: p.node, parent: p.node.parent as TransformNode | null, pos: p.node.position.clone() }));
    // 銃も手から離して別の剛体にする
    const gunRoot = this.gun.root;
    this.restore.push({ node: gunRoot, parent: gunRoot.parent as TransformNode, pos: gunRoot.position.clone() });
    const gunPart: RigPart = {
      node: gunRoot,
      parent: -1,
      size: this.gun.shoulder ? new Vector3(0.2, 0.2, 1.2) : new Vector3(0.08, 0.2, 0.8),
      center: new Vector3(0, 0, 0.15),
      mass: 4,
    };
    this.ragdoll = new Ragdoll(this.scene, [...this.rig, gunPart], opts);
  }

  /** ラグドールから起き上がる。戻り値は骨盤の位置（新しい立ち位置の基準） */
  endRagdoll(): Vector3 {
    if (!this.ragdoll) return this.pelvis.getAbsolutePosition().clone();
    const pos = this.pelvis.position.clone(); // ラグドール中は親なし＝ワールド座標
    this.ragdoll.dispose();
    this.ragdoll = null;
    for (const r of this.restore) {
      r.node.setParent(r.parent);
      r.node.position.copyFrom(r.pos);
      r.node.rotationQuaternion = Quaternion.Identity();
    }
    this.restore = [];
    return pos;
  }

  /** 骨盤の向きから、うつ伏せかどうか（起き上がり方向の決定用） */
  ragdollYaw(): number {
    const f = new Vector3(0, 0, 1).rotateByQuaternionToRef(this.pelvis.rotationQuaternion ?? Quaternion.Identity(), new Vector3());
    return Math.atan2(f.x, f.z);
  }

  setShadowCaster(add: (m: Mesh) => void) {
    for (const m of this.meshes) add(m);
  }
}
