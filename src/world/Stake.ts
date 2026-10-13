// ============================================================================
// 遠景の「国家級」アンカー（巨大な杭）
// ----------------------------------------------------------------------------
// 設定（docs/LORE.md）: 衛星軌道上の大陸級から撃ち込まれた国家級は、全長 約10km、
// 芯の直径 約1km、返しのとげを含めると直径 約2km。地面に斜めに突き刺さっている。
// 実際の距離（約11.5km 先）に置くと描画距離の外になるので、空と同じく
// カメラに追従させ、同じ見かけの大きさになるよう縮めて近くに置く。
// ============================================================================
import { Color3, Matrix, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { bakeT, merge } from "../enemies/AlienShapes";
import { slab, spike } from "../enemies/AnchorShapes";

/** 単位: 1 = 100m（全長 100 = 10km） */
const LEN = 100;
/** 地上に出ている長さ（残りは地中） */
const ABOVE = 70;
/** 実際の距離（100m 単位。115 = 11.5km） */
const REAL_DIST = 115;

export function buildNationStake(scene: Scene, dist: number, haze: Color3): Mesh {
  const R = (x: number, y: number, z: number) => new Vector3(x, y, z);
  const parts: Mesh[] = [];
  // 芯: 六角柱。先端（地中側、y=0）ほど細い
  parts.push(bakeT(MeshBuilder.CreateCylinder("shaft", { height: LEN, diameterTop: 11, diameterBottom: 3, tessellation: 6 }, scene), R(0, LEN / 2, 0)));
  // 頭部: 面取りした塊を重ねた石突き
  parts.push(slab(scene, "head", 16, 7, 16, R(0, LEN - 1, 0)));
  parts.push(slab(scene, "head2", 11, 6, 11, R(0, LEN + 4, 0), R(0, Math.PI / 4, 0)));
  // 返しのとげ: 上（頭）側へ反り返る。段ごとに角度をずらす
  for (let row = 0; row < 8; row++) {
    const y = 30 + row * 9;
    const r = 1.5 + (y / LEN) * 4;
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + (row % 2) * (Math.PI / 4);
      const len = 5.5 - row * 0.25;
      // 根元を芯の表面に置き、外側やや上へ向ける
      const dir = R(Math.sin(a), 0, Math.cos(a));
      parts.push(spike(scene, "barb", len, 3.2, 1.4, dir.scale(r).add(R(0, y, 0)), R(0, a - Math.PI / 2, 0.75)));
    }
  }
  const m = merge("nationStake", parts);
  // 地面の位置が原点に来るようにずらす
  m.bakeTransformIntoVertices(Matrix.Translation(0, -(LEN - ABOVE), 0));
  const mat = new StandardMaterial("stakeMat", scene);
  // 大気遠近法: 遠くの山のように霞んだ色にする（フォグは使わず色で表現）
  mat.diffuseColor = new Color3(0.14, 0.14, 0.17);
  mat.emissiveColor = haze.scale(0.42);
  mat.specularColor = new Color3(0.05, 0.05, 0.05);
  mat.backFaceCulling = false;
  m.material = mat;
  m.applyFog = false;
  m.isPickable = false;
  m.alwaysSelectAsActiveMesh = true;
  // 見かけの大きさを保ったまま dist の位置へ
  const s = dist / REAL_DIST;
  m.scaling.setAll(s);
  const dir = new Vector3(0.3, 0, 0.95).normalize();
  const off = dir.scale(dist);
  // 空のドームと同じく、カメラの水平位置に追従させる（近づいても大きさが変わらない）
  scene.onBeforeRenderObservable.add(() => {
    const c = scene.activeCamera?.globalPosition;
    if (c) m.position.set(c.x + off.x, -6, c.z + off.z);
  });
  // 斜めに突き刺さる（頭がプレイヤーから見て右へ倒れる）
  m.rotation.set(0.12, Math.atan2(dir.x, dir.z), -0.32);
  return m;
}
