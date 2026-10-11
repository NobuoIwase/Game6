// ============================================================================
// 陸戦兵の見た目（プロシージャルモデル）とアニメーション、ラグドール化。
// ----------------------------------------------------------------------------
// 各パーツは「関節位置を原点にした TransformNode」で、子に見た目のメッシュを持つ。
// 腕は武器のグリップ位置へ 2 ボーン IK で手を伸ばすので、武器モデルを
// 差し替えても自然に構える。
// ============================================================================
import { Color3, Mesh, MeshBuilder, PBRMaterial, Quaternion, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { Ragdoll, RagdollOptions, RigPart } from "../core/Physics";
import { fromToQuat } from "../core/MathUtil";
import type { WeaponModel } from "../data/weapons";

export interface GunModel {
  root: TransformNode;
  muzzle: TransformNode;
  gripR: Vector3;
  gripL: Vector3;
  /** 肩に担ぐ武器か */
  shoulder: boolean;
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
  gunPivot!: TransformNode;
  meshes: Mesh[] = [];
  private mats: SoldierMats;
  private guns = new Map<WeaponModel, GunModel>();
  gun!: GunModel;
  private rig: RigPart[] = [];
  private restore: { node: TransformNode; parent: TransformNode | null; pos: Vector3 }[] = [];
  ragdoll: Ragdoll | null = null;
  private webMeshes: Mesh[] = [];
  private walkPhase = 0;
  private readonly L1 = 0.29;
  private readonly L2 = 0.29;

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
      this.add(sph(0.1), fo, M.dark, V(0, -this.L2, 0));
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
      this.add(box(0.13, 0.11, 0.27), sh, M.dark, V(0, -0.43, 0.05)); // ブーツ
      return [th, sh];
    };
    [this.thighL, this.shinL] = leg(-1);
    [this.thighR, this.shinR] = leg(1);

    this.gunPivot = new TransformNode("gunPivot", this.scene);
    this.gunPivot.parent = this.torso;
    this.gunPivot.position.set(0.15, 0.36, 0.12);
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
    this.gun = g;
    if (g.shoulder) this.gunPivot.position.set(0.2, 0.55, 0.02);
    else this.gunPivot.position.set(0.15, 0.36, 0.12);
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
    let gripL = new Vector3(0, -0.06, 0.28);
    let shoulder = false;
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
    } else if (model === "sniper") {
      add(box(0.07, 0.11, 0.5), M.gunMetal, 0, 0, 0.05);
      add(cyl(0.035, 0.75), M.gunMetal, 0, 0.02, 0.65);
      add(box(0.06, 0.12, 0.32), M.gunPoly, 0, -0.02, -0.33);
      add(cyl(0.06, 0.32), M.gunMetal, 0, 0.1, 0.08);
      add(box(0.04, 0.13, 0.06), M.gunPoly, 0, -0.1, 0.02);
      muzzle.position.set(0, 0.02, 1.03);
    } else if (model === "shotgun") {
      add(box(0.08, 0.12, 0.42), M.gunMetal, 0, 0, 0.05);
      add(cyl(0.05, 0.5), M.gunMetal, 0, 0.025, 0.5);
      add(cyl(0.045, 0.45), M.gunMetal, 0, -0.035, 0.45);
      add(box(0.07, 0.07, 0.18), M.gunPoly, 0, -0.035, 0.32); // ポンプ
      add(box(0.06, 0.12, 0.3), M.gunPoly, 0, -0.03, -0.3);
      muzzle.position.set(0, 0.025, 0.76);
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
    return { root, muzzle, gripR, gripL, shoulder };
  }

  // ------------------------------------------------------------------ アニメーション
  /**
   * @param fwd 前後速度（m/s、ローカル）
   * @param side 左右速度
   * @param aimPitch 照準の上下（ラジアン、下向きが +）
   * @param grounded 接地しているか
   * @param recoil 反動（0..1）
   */
  animate(dt: number, fwd: number, side: number, aimPitch: number, grounded: boolean, recoil: number, reloading: boolean) {
    if (this.ragdoll) return;
    const speed = Math.hypot(fwd, side);
    this.walkPhase += dt * (4 + speed * 1.25) * (speed > 0.3 ? 1 : 0);
    const amp = Math.min(0.75, speed * 0.12);
    const ph = this.walkPhase;
    const fwdK = speed > 0.01 ? fwd / speed : 0;
    const sideK = speed > 0.01 ? side / speed : 0;
    const q = Quaternion.RotationYawPitchRoll;
    if (grounded) {
      const sw = Math.sin(ph) * amp;
      this.thighL.rotationQuaternion = q(0, -sw * fwdK - 0.05, sw * sideK * 0.6);
      this.thighR.rotationQuaternion = q(0, sw * fwdK - 0.05, -sw * sideK * 0.6);
      this.shinL.rotationQuaternion = q(0, Math.max(0, Math.cos(ph)) * amp * 1.3 + 0.08, 0);
      this.shinR.rotationQuaternion = q(0, Math.max(0, -Math.cos(ph)) * amp * 1.3 + 0.08, 0);
      this.pelvis.position.y = 0.05 - Math.abs(Math.cos(ph)) * amp * 0.06;
    } else {
      this.thighL.rotationQuaternion = q(0, -0.6, 0.05);
      this.thighR.rotationQuaternion = q(0, -0.2, -0.05);
      this.shinL.rotationQuaternion = q(0, 0.9, 0);
      this.shinR.rotationQuaternion = q(0, 0.5, 0);
    }
    // 上半身: 照準に合わせて前傾、反動
    const lean = 0.08 + Math.min(0.15, speed * 0.015) * fwdK;
    this.torso.rotationQuaternion = q(0, lean + aimPitch * 0.3 - recoil * 0.05, 0);
    this.head.rotationQuaternion = q(0, aimPitch * 0.4, 0);
    // 武器の向き（胴体の傾き分を差し引いて照準方向に合わせる）
    const reloadTilt = reloading ? 0.6 : 0;
    this.gunPivot.rotationQuaternion = q(0, aimPitch * 0.7 - lean - recoil * 0.15 + reloadTilt, reloading ? -0.4 : 0);
    this.gunPivot.position.z = (this.gun?.shoulder ? 0.02 : 0.12) - recoil * 0.06;

    // 腕の IK（胴体ローカル空間で計算）
    this.solveArm(this.upperArmR, this.foreArmR, this.gun.gripR, new Vector3(0.6, -1, -0.6));
    this.solveArm(this.upperArmL, this.foreArmL, this.gun.gripL, new Vector3(-0.9, -1, -0.2));
  }

  private solveArm(upper: TransformNode, fore: TransformNode, grip: Vector3, pole: Vector3) {
    // グリップ位置を胴体ローカルへ
    const gp = this.gunPivot;
    const gq = gp.rotationQuaternion!;
    const target = grip.rotateByQuaternionToRef(gq, new Vector3()).addInPlace(gp.position);
    const S = upper.position;
    const st = target.subtract(S);
    let d = st.length();
    const l1 = this.L1,
      l2 = this.L2 + 0.03;
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

  /** ルートに対するロールの角度（回避動作） */
  setRoll(angle: number) {
    this.rollPivot.rotationQuaternion = Quaternion.RotationYawPitchRoll(0, angle, 0);
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
