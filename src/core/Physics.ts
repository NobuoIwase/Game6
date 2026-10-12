// ============================================================================
// Havok 物理エンジンの初期化と、汎用ラグドール。
// ----------------------------------------------------------------------------
// ラグドールは「関節を原点に持つパーツ（TransformNode / Mesh / InstancedMesh）の木構造」
// から作る。各パーツに箱型の剛体を付け、親子間を角度制限付きの 6DoF 関節でつなぐ。
// 兵士・蟻・蜘蛛など、どのキャラクターも同じ仕組みでラグドール化できる。
// ============================================================================
import {
  HavokPlugin,
  Matrix,
  Physics6DoFConstraint,
  PhysicsBody,
  PhysicsConstraintAxis,
  PhysicsMotionType,
  PhysicsShapeBox,
  PhysicsShapeContainer,
  Quaternion,
  Scene,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import havokWasmUrl from "@babylonjs/havok/lib/esm/HavokPhysics.wasm?url";

/** 衝突フィルタ用のビット */
export const COL_STATIC = 1; // 地面・建物・車
export const COL_RAGDOLL = 2; // ラグドール
export const COL_DEBRIS = 4; // 破片
export const COL_ALL = 0xffffffff;

export const GRAVITY = -12;

export async function enableHavok(scene: Scene): Promise<HavokPlugin> {
  const hk = await HavokPhysics({ locateFile: () => havokWasmUrl });
  const plugin = new HavokPlugin(true, hk);
  scene.enablePhysics(new Vector3(0, GRAVITY, 0), plugin);
  return plugin;
}

export interface RigPart {
  /** 見た目のノード。原点が関節位置になるように作っておく */
  node: TransformNode;
  /** 親パーツの番号（ルートは -1） */
  parent: number;
  /** 当たり判定の箱の大きさ */
  size: Vector3;
  /** ノード原点から見た箱の中心 */
  center: Vector3;
  mass: number;
  /** 関節の振れ角の上限（ラジアン） */
  swing?: number;
  /** ねじれ角の上限（ラジアン） */
  twist?: number;
}

export interface RagdollOptions {
  /** 全身に与える初速 */
  velocity?: Vector3;
  /** 一番近いパーツに与える衝撃 */
  impulse?: Vector3;
  impulsePoint?: Vector3;
  /** 回転の初速（ランダムなきりもみ用） */
  spin?: number;
}

export class Ragdoll {
  bodies: PhysicsBody[] = [];
  private constraints: Physics6DoFConstraint[] = [];
  disposed = false;
  age = 0;

  constructor(
    scene: Scene,
    readonly parts: RigPart[],
    opts: RagdollOptions = {},
  ) {
    // 1) 親子関係を外してワールド座標に固定
    for (const p of parts) p.node.computeWorldMatrix(true);
    const worlds = parts.map((p) => p.node.getWorldMatrix().clone());
    for (const p of parts) {
      p.node.setParent(null);
      if (!p.node.rotationQuaternion) p.node.rotationQuaternion = Quaternion.FromEulerVector(p.node.rotation);
      p.node.scaling.set(1, 1, 1);
    }

    // 2) 剛体
    for (const p of parts) {
      const body = new PhysicsBody(p.node, PhysicsMotionType.DYNAMIC, false, scene);
      const shape = new PhysicsShapeBox(p.center, Quaternion.Identity(), p.size, scene);
      shape.filterMembershipMask = COL_RAGDOLL;
      shape.filterCollideMask = COL_STATIC;
      shape.material = { friction: 0.9, restitution: 0.05 };
      body.shape = shape;
      body.setMassProperties({ mass: p.mass });
      body.setLinearDamping(0.15);
      body.setAngularDamping(0.6);
      this.bodies.push(body);
    }

    // 3) 関節
    const rotOf = (m: Matrix) => {
      const q = new Quaternion();
      m.decompose(undefined, q, undefined);
      return q;
    };
    parts.forEach((p, i) => {
      if (p.parent < 0) return;
      const parentWorld = worlds[p.parent];
      const childWorld = worlds[i];
      const jointWorld = childWorld.getTranslation();
      const pivotA = Vector3.TransformCoordinates(jointWorld, parentWorld.clone().invert());
      const qp = rotOf(parentWorld);
      const qc = rotOf(childWorld);
      const rel = Quaternion.Inverse(qp).multiply(qc);
      const axisA = Vector3.Right().rotateByQuaternionToRef(rel, new Vector3());
      const perpA = Vector3.Up().rotateByQuaternionToRef(rel, new Vector3());
      const swing = p.swing ?? 0.7;
      const twist = p.twist ?? 0.3;
      const c = new Physics6DoFConstraint(
        {
          pivotA,
          pivotB: Vector3.Zero(),
          axisA,
          axisB: Vector3.Right(),
          perpAxisA: perpA,
          perpAxisB: Vector3.Up(),
          collision: false,
        },
        [
          { axis: PhysicsConstraintAxis.LINEAR_X, minLimit: 0, maxLimit: 0 },
          { axis: PhysicsConstraintAxis.LINEAR_Y, minLimit: 0, maxLimit: 0 },
          { axis: PhysicsConstraintAxis.LINEAR_Z, minLimit: 0, maxLimit: 0 },
          { axis: PhysicsConstraintAxis.ANGULAR_X, minLimit: -twist, maxLimit: twist },
          { axis: PhysicsConstraintAxis.ANGULAR_Y, minLimit: -swing, maxLimit: swing },
          { axis: PhysicsConstraintAxis.ANGULAR_Z, minLimit: -swing, maxLimit: swing },
        ],
        scene,
      );
      this.bodies[p.parent].addConstraint(this.bodies[i], c);
      this.constraints.push(c);
    });

    // 4) 初速と衝撃
    const v = opts.velocity ?? Vector3.Zero();
    const spin = opts.spin ?? 0;
    for (const b of this.bodies) {
      b.setLinearVelocity(v);
      if (spin) b.setAngularVelocity(new Vector3((Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin));
    }
    if (opts.impulse && opts.impulsePoint) {
      let best = 0,
        bd = Infinity;
      parts.forEach((p, i) => {
        const d = Vector3.DistanceSquared(p.node.position, opts.impulsePoint!);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      this.bodies[best].applyImpulse(opts.impulse, parts[best].node.getAbsolutePosition());
    }
  }

  /** 爆風などで後から力を加える */
  applyImpulse(impulse: Vector3, point: Vector3) {
    if (this.disposed) return;
    const each = impulse.scale(1 / this.bodies.length);
    for (const b of this.bodies) b.applyImpulse(each, point);
  }

  /** ルートパーツの位置 */
  get position(): Vector3 {
    return this.parts[0].node.position;
  }

  /** 動きがほぼ止まったか */
  isResting(): boolean {
    const v = this.bodies[0].getLinearVelocity();
    return v.lengthSquared() < 0.25;
  }

  /** 物理を止めて、見た目のノードだけ残す */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of this.constraints) c.dispose();
    for (const b of this.bodies) {
      b.shape?.dispose();
      b.dispose();
    }
    this.constraints = [];
    this.bodies = [];
  }
}

/**
 * 死亡ポーズのまま固まった死骸（1つの剛体）。
 * パーツの親子関係は保ったまま、ルートパーツに全パーツの箱を合成した形状を付ける。
 * 死骸同士も衝突するので、重なって出現すると押し出し合って軽く跳ねる。
 */
export class RigidCorpse {
  bodies: PhysicsBody[] = [];
  disposed = false;
  readonly root: TransformNode;

  constructor(
    scene: Scene,
    readonly parts: RigPart[],
    opts: RagdollOptions = {},
  ) {
    for (const p of parts) p.node.computeWorldMatrix(true);
    const root = parts[0].node;
    const rootWorld = root.getWorldMatrix().clone();
    const inv = rootWorld.clone().invert();
    root.setParent(null);
    if (!root.rotationQuaternion) root.rotationQuaternion = Quaternion.FromEulerVector(root.rotation);
    root.scaling.set(1, 1, 1);
    this.root = root;
    const cont = new PhysicsShapeContainer(scene);
    let mass = 0;
    for (const p of parts) {
      const rel = p.node === root ? Matrix.Identity() : p.node.getWorldMatrix().multiply(inv);
      const q = new Quaternion();
      const t = new Vector3();
      rel.decompose(undefined, q, t);
      const c = Vector3.TransformCoordinates(p.center, rel);
      cont.addChild(new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), p.size, scene), c, q);
      mass += p.mass;
    }
    cont.filterMembershipMask = COL_RAGDOLL;
    cont.filterCollideMask = COL_STATIC | COL_RAGDOLL;
    cont.material = { friction: 0.8, restitution: 0.25 };
    const body = new PhysicsBody(root, PhysicsMotionType.DYNAMIC, false, scene);
    body.shape = cont;
    body.setMassProperties({ mass });
    body.setLinearDamping(0.1);
    body.setAngularDamping(0.4);
    this.bodies.push(body);
    body.setLinearVelocity(opts.velocity ?? Vector3.Zero());
    const spin = opts.spin ?? 0;
    if (spin) body.setAngularVelocity(new Vector3((Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin));
  }

  applyImpulse(impulse: Vector3, point: Vector3) {
    if (!this.disposed) this.bodies[0].applyImpulse(impulse, point);
  }

  get position(): Vector3 {
    return this.root.position;
  }

  isResting(): boolean {
    return this.bodies[0].getLinearVelocity().lengthSquared() < 0.25;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const b of this.bodies) {
      b.shape?.dispose();
      b.dispose();
    }
    this.bodies = [];
  }
}

/** 死骸として扱える物（ラグドール / 固まった死骸） */
export type CorpseBody = Ragdoll | RigidCorpse;

/** パーツ i を動かす剛体 */
export function corpseBodyOf(c: CorpseBody, i: number): PhysicsBody | undefined {
  return c instanceof RigidCorpse ? c.bodies[0] : c.bodies[i];
}
