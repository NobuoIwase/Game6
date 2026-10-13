// ============================================================================
// アンカー（巨大生物）の造形パーツ。
// ゴツい外殻を作るための「面取りした塊（スラブ）」「多面体の結晶」と、
// 脚に使う「三日月形の鎌（クレセント）」を作る。
// どれも頂点を共有しないフラットシェーディングで、角ばった甲殻らしく見せる。
// ============================================================================
import { Matrix, Mesh, MeshBuilder, Quaternion, Scene, Vector3, VertexData } from "@babylonjs/core";
import { bakeT } from "./AlienShapes";

/**
 * 面取りした塊（菱形立方八面体を潰したもの）。中心が原点。
 * @param sx,sy,sz 各軸の大きさ（m）
 */
export function slab(scene: Scene, name: string, sx: number, sy: number, sz: number, pos = Vector3.Zero(), rot = Vector3.Zero()): Mesh {
  const m = MeshBuilder.CreatePolyhedron(name, { type: 4, sizeX: sx / 2.4, sizeY: sy / 2.4, sizeZ: sz / 2.4 }, scene);
  return bakeT(m, pos, rot);
}

/** 多面体の結晶（とげ・眼・こぶ）。type 1 = 八面体, 3 = 二十面体 */
export function gem(scene: Scene, name: string, type: number, sx: number, sy: number, sz: number, pos = Vector3.Zero(), rot = Vector3.Zero()): Mesh {
  const m = MeshBuilder.CreatePolyhedron(name, { type, sizeX: sx / 2, sizeY: sy / 2, sizeZ: sz / 2 }, scene);
  return bakeT(m, pos, rot);
}

/**
 * 外周線と内周線のあいだを厚み付きの帯にする（鎌・板・とげ）。
 * XY 平面上の線で、厚みは Z 方向。各点ごとに厚みを変えられる（先細り）。
 */
export function band(scene: Scene, name: string, outer: number[][], inner: number[][], thick: number[]): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const tri = (a: number[], b: number[], c: number[]) => {
    const i = positions.length / 3;
    positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    indices.push(i, i + 1, i + 2);
  };
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    tri(a, b, c);
    tri(a, c, d);
  };
  const n = outer.length;
  const P = (p: number[], z: number) => [p[0], p[1], z];
  for (let i = 0; i < n - 1; i++) {
    const t0 = thick[i] / 2,
      t1 = thick[i + 1] / 2;
    const o0 = outer[i],
      o1 = outer[i + 1],
      i0 = inner[i],
      i1 = inner[i + 1];
    quad(P(o0, t0), P(o1, t1), P(i1, t1), P(i0, t0)); // 表
    quad(P(o0, -t0), P(i0, -t0), P(i1, -t1), P(o1, -t1)); // 裏
    quad(P(o0, t0), P(o0, -t0), P(o1, -t1), P(o1, t1)); // 外周の側面
    quad(P(i0, t0), P(i1, t1), P(i1, -t1), P(i0, -t0)); // 内周の側面
  }
  // 両端のふた
  const tA = thick[0] / 2,
    tB = thick[n - 1] / 2;
  quad(P(outer[0], tA), P(inner[0], tA), P(inner[0], -tA), P(outer[0], -tA));
  quad(P(outer[n - 1], tB), P(outer[n - 1], -tB), P(inner[n - 1], -tB), P(inner[n - 1], tB));
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.normals = normals;
  // 多面体（UV 付き）と結合できるように、ダミーの UV を付ける
  vd.uvs = new Array((positions.length / 3) * 2).fill(0);
  const m = new Mesh(name, scene);
  vd.applyToMesh(m);
  return m;
}

/**
 * 三日月形の鎌。根元が原点、先端が +X 方向（len）、ふくらみが +Y 側。
 * @param width 根元の幅
 * @param bend ふくらみの大きさ（len に対する比）
 * @param thick 根元の厚み
 */
export function crescent(scene: Scene, name: string, len: number, width: number, thick: number, bend: number, segs = 7): Mesh {
  const outer: number[][] = [];
  const inner: number[][] = [];
  const th: number[] = [];
  const c = (s: number) => [len * s, bend * len * Math.sin(Math.PI * Math.pow(s, 0.85))];
  for (let i = 0; i <= segs; i++) {
    const s = i / segs;
    const p = c(s);
    const q = c(Math.min(1, s + 0.01));
    const r = c(Math.max(0, s - 0.01));
    let tx = q[0] - r[0],
      ty = q[1] - r[1];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    // 外側（ふくらみ側）は厚く、内側は刃のように鋭く
    const w = width * Math.pow(1 - s, 0.7) + width * 0.03;
    outer.push([p[0] - ty * w * 0.75, p[1] + tx * w * 0.75]);
    inner.push([p[0] + ty * w * 0.25, p[1] - tx * w * 0.25]);
    th.push(thick * (1 - s * 0.75));
  }
  return band(scene, name, outer, inner, th);
}

/** 先の尖った板（甲殻の鱗・とげ）。根元が原点、先端が +X、幅は Y 方向 */
export function spike(scene: Scene, name: string, len: number, width: number, thick: number, pos = Vector3.Zero(), rot = Vector3.Zero()): Mesh {
  const outer = [
    [0, width / 2],
    [len * 0.45, width * 0.42],
    [len, 0.02],
  ];
  const inner = [
    [0, -width / 2],
    [len * 0.45, -width * 0.42],
    [len, -0.02],
  ];
  return bakeT(band(scene, name, outer, inner, [thick, thick * 0.8, thick * 0.2]), pos, rot);
}

/** 局所 +X を xDir へ、局所 +Y をできるだけ yHint へ向ける回転（左手系） */
export function axisQuat(xDir: Vector3, yHint: Vector3, out = new Quaternion()): Quaternion {
  const x = xDir.normalizeToNew();
  let z = Vector3.Cross(x, yHint);
  if (z.lengthSquared() < 1e-6) z = Vector3.Cross(x, new Vector3(0, 0, 1));
  z.normalize();
  const y = Vector3.Cross(z, x);
  const m = Matrix.Identity();
  Matrix.FromXYZAxesToRef(x, y, z, m);
  return Quaternion.FromRotationMatrixToRef(m, out);
}

/**
 * 2 関節の脚の姿勢を設定する（胴体空間の向きで指定）。
 * 腿は上面を上へ、鎌（脛）はふくらみを外側へ向ける。
 */
export function poseLeg(
  femur: { rotationQuaternion: Quaternion | null },
  tibia: { rotationQuaternion: Quaternion | null },
  femurDir: Vector3,
  tibiaDir: Vector3,
  side: number,
  tibiaUp?: Vector3,
) {
  const fq = axisQuat(femurDir, new Vector3(0, 1, 0), femur.rotationQuaternion ?? new Quaternion());
  femur.rotationQuaternion = fq;
  const tq = axisQuat(tibiaDir, tibiaUp ?? new Vector3(side, 0.25, 0));
  tibia.rotationQuaternion = Quaternion.Inverse(fq).multiply(tq);
}
