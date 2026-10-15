// ============================================================================
// 開発用: パック GLB の読み込み確認（tools/packs.html）
//   window.grid(role, state?, cols?) → 指定した用途のアセットを格子状に並べる
//   window.cam(x, y, z, tx, ty, tz) → カメラ位置
// 矢印（+Z）が「前」。モデルの正面が +Z を向いているか確認するために、各モデルの手前に赤い棒を置く。
// ============================================================================
import { ArcRotateCamera, Color3, Color4, DirectionalLight, Engine, HemisphericLight, MeshBuilder, PBRMaterial, Scene, StandardMaterial, Vector3, UniversalCamera } from "@babylonjs/core";
import { AssetLibrary, AssetStateName } from "../world/AssetLibrary";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true });
const scene = new Scene(engine);
scene.clearColor = new Color4(0.6, 0.66, 0.72, 1);
scene.createDefaultEnvironment({ createGround: false, createSkybox: false });
new HemisphericLight("h", new Vector3(0.2, 1, -0.3), scene).intensity = 0.5;
new DirectionalLight("s", new Vector3(-0.5, -0.8, 0.4), scene).intensity = 2.2;
const cam = new UniversalCamera("cam", new Vector3(0, 40, -80), scene);
cam.maxZ = 3000;
cam.setTarget(Vector3.Zero());
const g = MeshBuilder.CreateGround("g", { width: 2000, height: 2000 }, scene);
const gm = new PBRMaterial("gm", scene);
gm.albedoColor = new Color3(0.4, 0.42, 0.44);
gm.roughness = 1;
g.material = gm;
const red = new StandardMaterial("red", scene);
red.emissiveColor = new Color3(1, 0, 0);
const lib = new AssetLibrary(scene, "/assets/models/");
const ready = lib.loadCatalog();

async function grid(role: string, state: AssetStateName = "normal", cols = 10, ids?: string[]) {
  await ready;
  const defs = ids ? ids.map((i) => lib.get(i)!).filter(Boolean) : lib.role(role);
  await lib.preload(defs.map((d) => d.id));
  let x = 0,
    z = 0,
    rowD = 0,
    col = 0;
  const out: string[] = [];
  for (const d of defs) {
    const s = d.states.normal!;
    const w = s.max[0] - s.min[0],
      dd = s.max[2] - s.min[2];
    const p = lib.place(d.id, x - s.min[0], 0, z - s.min[2], 0, null, [state]);
    p?.show(state);
    const mark = MeshBuilder.CreateBox("m", { width: 0.3, height: 0.3, depth: 2 }, scene);
    mark.position.set(x + w / 2, 0.2, z + dd + 1.5);
    mark.material = red;
    out.push(`${d.id} ${d.name} ${w.toFixed(1)}x${(s.max[1] - s.min[1]).toFixed(1)}x${dd.toFixed(1)}`);
    x += w + 4;
    rowD = Math.max(rowD, dd);
    if (++col >= cols) {
      col = 0;
      x = 0;
      z -= rowD + 8;
      rowD = 0;
    }
  }
  await scene.whenReadyAsync();
  return out.join("\n");
}
function setCam(x: number, y: number, z: number, tx: number, ty: number, tz: number) {
  cam.position.set(x, y, z);
  cam.setTarget(new Vector3(tx, ty, tz));
  scene.render();
}
Object.assign(window, { grid, cam: setCam, scene, lib, stop: () => engine.stopRenderLoop() });
engine.runRenderLoop(() => scene.render());
void ArcRotateCamera;
