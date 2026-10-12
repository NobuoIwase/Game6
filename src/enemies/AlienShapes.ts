// ============================================================================
// 異星生物の造形パーツ。
// 「Mac のマウスカーソル」のような矢印形の板（カーソル板）と、三角柱の破片（シャード）を
// 組み合わせて体を作る。飛行型と同じ「三角形の言語」で、地上の生物も異星の存在らしく見せる。
// ============================================================================
import { Color3, Matrix, Mesh, MeshBuilder, PBRMaterial, Quaternion, Scene, Vector3, VertexData } from "@babylonjs/core";

/** カーソル形（先端が +Y、XY 平面。原点はおおよそ重心） */
const CURSOR: [number, number][] = [
  [0, 1.0], // 先端
  [0, -0.18], // 左辺の下
  [0.27, 0.1], // くびれ（左）
  [0.46, -0.36], // 尾の左下
  [0.62, -0.29], // 尾の右下
  [0.43, 0.17], // くびれ（右）
  [0.74, 0.18], // 右の翼
];
// 凹多角形を手で三角形分割したもの
const CURSOR_TRIS: [number, number, number][] = [
  [0, 1, 2],
  [0, 2, 5],
  [0, 5, 6],
  [2, 3, 4],
  [2, 4, 5],
];

/**
 * カーソル形の板（厚み付き）。
 * @param size 先端から尾までのおおよその長さ（m）
 * @param thick 厚み（m）
 */
export function cursorPlate(scene: Scene, name: string, size: number, thick: number): Mesh {
  const cx = 0.3,
    cy = 0.3;
  const pts = CURSOR.map(([x, y]) => [(x - cx) * size, (y - cy) * size] as [number, number]);
  const positions: number[] = [];
  const indices: number[] = [];
  const tri = (a: number[], b: number[], c: number[]) => {
    const i = positions.length / 3;
    positions.push(...a, ...b, ...c);
    indices.push(i, i + 1, i + 2);
  };
  const z = thick / 2;
  for (const [a, b, c] of CURSOR_TRIS) {
    tri([pts[a][0], pts[a][1], z], [pts[b][0], pts[b][1], z], [pts[c][0], pts[c][1], z]);
    tri([pts[a][0], pts[a][1], -z], [pts[c][0], pts[c][1], -z], [pts[b][0], pts[b][1], -z]);
  }
  // 側面
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i],
      q = pts[(i + 1) % pts.length];
    tri([p[0], p[1], z], [p[0], p[1], -z], [q[0], q[1], -z]);
    tri([p[0], p[1], z], [q[0], q[1], -z], [q[0], q[1], z]);
  }
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.normals = normals;
  const m = new Mesh(name, scene);
  vd.applyToMesh(m);
  return m;
}

/** 変形（拡大・回転・移動）を頂点に焼き込む */
export function bakeT(m: Mesh, pos: Vector3, rot: Vector3 = Vector3.Zero(), scale: Vector3 = Vector3.One()): Mesh {
  const mat = Matrix.Compose(scale, Quaternion.FromEulerVector(rot), pos);
  m.bakeTransformIntoVertices(mat);
  return m;
}

/** +X 方向へ伸びる三角柱の破片（脚・触角） */
export function shard(scene: Scene, name: string, len: number, d0: number, d1: number): Mesh {
  const c = MeshBuilder.CreateCylinder(name, { height: len, diameterTop: d1, diameterBottom: d0, tessellation: 3 }, scene);
  return bakeT(c, new Vector3(len / 2, 0, 0), new Vector3(0, 0, -Math.PI / 2));
}

/** 複数メッシュを1つに結合（同じマテリアル前提） */
export function merge(name: string, meshes: Mesh[]): Mesh {
  const m = Mesh.MergeMeshes(meshes, true, true)!;
  m.name = name;
  return m;
}

/** 異星生物の外殻マテリアル（両面描画。三角形の板の裏も見えるため） */
export function shellMaterial(scene: Scene, name: string, color: Color3, metallic: number, roughness: number): PBRMaterial {
  const m = new PBRMaterial(name, scene);
  m.albedoColor = color;
  m.metallic = metallic;
  m.roughness = roughness;
  m.backFaceCulling = false;
  m.twoSidedLighting = true;
  return m;
}

export function glowMaterial(scene: Scene, name: string, color: Color3): PBRMaterial {
  const m = new PBRMaterial(name, scene);
  m.albedoColor = color.scale(0.2);
  m.emissiveColor = color;
  m.roughness = 0.2;
  m.backFaceCulling = false;
  return m;
}
