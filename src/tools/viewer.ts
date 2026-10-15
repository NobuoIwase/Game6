// ============================================================================
// 開発用アセットビューア（tools/viewer.html）
// ----------------------------------------------------------------------------
// GLB を1つずつ読み込み、大きさに合わせてカメラを置いて表示する。外部アセットの品質確認・
// 自動撮影（コンタクトシート作成）に使う。ゲーム本体からは使わない。
//   window.show(url, label, yawDeg?) → Promise<情報>
// ============================================================================
import { ArcRotateCamera, AbstractMesh, Color3, Color4, DirectionalLight, Engine, HemisphericLight, Scene, SceneLoader, Vector3, Mesh, MeshBuilder, PBRMaterial } from "@babylonjs/core";
import "@babylonjs/loaders/glTF";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true });
const scene = new Scene(engine);
scene.clearColor = new Color4(0.6, 0.66, 0.72, 1);
scene.environmentIntensity = 1;
scene.createDefaultEnvironment({ createGround: false, createSkybox: false });
const hemi = new HemisphericLight("h", new Vector3(0.2, 1, -0.3), scene);
hemi.intensity = 0.55;
const sun = new DirectionalLight("s", new Vector3(-0.5, -0.8, 0.4), scene);
sun.intensity = 2.4;
const cam = new ArcRotateCamera("cam", -Math.PI * 0.72, 1.12, 10, Vector3.Zero(), scene);
cam.minZ = 0.05;
const ground: Mesh = MeshBuilder.CreateGround("g", { width: 1, height: 1 }, scene);
const gm = new PBRMaterial("gm", scene);
gm.albedoColor = new Color3(0.42, 0.44, 0.46);
gm.roughness = 1;
gm.metallic = 0;
ground.material = gm;
let current: AbstractMesh[] = [];

async function show(url: string, label: string, yawDeg = -130) {
  for (const m of current) m.dispose(false, true);
  current = [];
  // 外部テクスチャ（../../textures/...）を解決できるよう、フォルダとファイル名に分けて渡す
  const cut = url.lastIndexOf("/") + 1;
  const res = await SceneLoader.ImportMeshAsync("", url.slice(0, cut), url.slice(cut), scene);
  current = res.meshes;
  let min = new Vector3(Infinity, Infinity, Infinity),
    max = new Vector3(-Infinity, -Infinity, -Infinity);
  let tris = 0;
  for (const m of res.meshes) {
    m.computeWorldMatrix(true);
    if (!m.getTotalVertices()) continue;
    const b = m.getBoundingInfo().boundingBox;
    min = Vector3.Minimize(min, b.minimumWorld);
    max = Vector3.Maximize(max, b.maximumWorld);
    tris += (m.getTotalIndices() || 0) / 3;
  }
  const size = max.subtract(min);
  const c = min.add(max).scale(0.5);
  const r = Math.max(size.x, size.y, size.z, 0.2);
  ground.scaling.set(r * 3, 1, r * 3);
  ground.position.set(c.x, min.y - 0.001, c.z);
  cam.target.copyFrom(c);
  cam.alpha = (yawDeg * Math.PI) / 180;
  cam.beta = 1.15;
  cam.radius = r * 1.9;
  (document.getElementById("label") as HTMLElement).textContent = label;
  await scene.whenReadyAsync();
  scene.render();
  scene.render();
  return { size: [size.x, size.y, size.z].map((v) => +v.toFixed(2)), tris: Math.round(tris), meshes: res.meshes.length };
}
(window as unknown as { show: typeof show }).show = show;
engine.runRenderLoop(() => scene.render());
window.addEventListener("resize", () => engine.resize());
