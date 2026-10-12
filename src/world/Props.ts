// ============================================================================
// 街の小物（看板・電柱・信号・自販機・街路樹・室外機・給水タンクなど）。
// ----------------------------------------------------------------------------
// 同じ形の小物は「thin instance」で1回の描画にまとめる（数百個置いても軽い）。
// 建物に付いた小物は建物の倒壊に合わせて一緒に沈み、消える（PropBatch.setMatrix）。
// 看板の文字は Canvas で描いたテクスチャ（日本の街らしさ）。
// ============================================================================
import { Color3, DynamicTexture, Matrix, Mesh, MeshBuilder, PBRMaterial, Scene, StandardMaterial, Texture, Vector3, Vector4, VertexData } from "@babylonjs/core";

/** 同じ形の小物の集まり（thin instance） */
export class PropBatch {
  private mats: Matrix[] = [];
  private built = false;
  constructor(readonly mesh: Mesh) {
    mesh.isPickable = false;
    mesh.receiveShadows = true;
  }
  add(m: Matrix): number {
    this.mats.push(m.clone());
    return this.mats.length - 1;
  }
  get count() {
    return this.mats.length;
  }
  /** 生成の最後に1回呼ぶ */
  build() {
    if (this.built) return;
    this.built = true;
    if (this.mats.length === 0) {
      this.mesh.setEnabled(false);
      return;
    }
    const buf = new Float32Array(this.mats.length * 16);
    this.mats.forEach((m, i) => m.copyToArray(buf, i * 16));
    this.mesh.thinInstanceSetBuffer("matrix", buf, 16, false);
    this.mesh.thinInstanceRefreshBoundingInfo(false);
  }
  setMatrix(i: number, m: Matrix, refresh = true) {
    this.mesh.thinInstanceSetMatrixAt(i, m, refresh);
  }
  hide(i: number) {
    this.mesh.thinInstanceSetMatrixAt(i, Matrix.Scaling(0, 0, 0), true);
  }
  base(i: number) {
    return this.mats[i];
  }
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

function pbr(scene: Scene, name: string, c: Color3, rough: number, metal: number, emissive?: Color3) {
  const m = new PBRMaterial(name, scene);
  m.albedoColor = c;
  m.roughness = rough;
  m.metallic = metal;
  if (emissive) m.emissiveColor = emissive;
  return m;
}

function merged(name: string, parts: Mesh[], multi = false) {
  const m = Mesh.MergeMeshes(parts, true, true, undefined, false, multi)!;
  m.name = name;
  return m;
}

/** 文字入りの看板テクスチャ */
function signTexture(scene: Scene, text: string, bg: string, fg: string, vertical: boolean, w = 128, h = 512): Texture {
  const t = new DynamicTexture("sign_" + text, { width: vertical ? w : h, height: vertical ? h : w }, scene, true);
  const ctx = t.getContext() as CanvasRenderingContext2D;
  const W = vertical ? w : h,
    H = vertical ? h : w;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = fg;
  ctx.lineWidth = 6;
  ctx.strokeRect(6, 6, W - 12, H - 12);
  ctx.fillStyle = fg;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const font = '"Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic","Meiryo",sans-serif';
  if (vertical) {
    const chars = [...text];
    const size = Math.min(W * 0.72, (H - 30) / chars.length);
    ctx.font = `900 ${size}px ${font}`;
    chars.forEach((c, i) => ctx.fillText(c, W / 2, 20 + size * (i + 0.5) + (H - 40 - size * chars.length) / 2));
  } else {
    const size = Math.min(H * 0.65, ((W - 30) / [...text].length) * 1.1);
    ctx.font = `900 ${size}px ${font}`;
    ctx.fillText(text, W / 2, H / 2 + 2);
  }
  t.update();
  return t;
}

/** 自販機の正面（飲み物の列） */
function vendingTexture(scene: Scene, body: string): Texture {
  const t = new DynamicTexture("vend_" + body, { width: 128, height: 256 }, scene, true);
  const c = t.getContext() as CanvasRenderingContext2D;
  c.fillStyle = body;
  c.fillRect(0, 0, 128, 256);
  c.fillStyle = "#dfe8ef";
  c.fillRect(10, 14, 108, 120);
  const cols = ["#d22", "#e83", "#29c", "#3a3", "#fc2", "#a5d", "#eee", "#842"];
  for (let r = 0; r < 4; r++)
    for (let k = 0; k < 6; k++) {
      c.fillStyle = cols[(r * 3 + k * 5) % cols.length];
      c.fillRect(14 + k * 17, 20 + r * 29, 12, 20);
      c.fillStyle = "#333";
      c.fillRect(15 + k * 17, 42 + r * 29, 10, 3);
    }
  c.fillStyle = "#222";
  c.fillRect(20, 200, 88, 26);
  c.fillStyle = "#555";
  c.fillRect(96, 150, 14, 30);
  t.update();
  return t;
}

export interface PropKit {
  ac: PropBatch;
  tank: PropBatch;
  antenna: PropBatch;
  vending: PropBatch[];
  signsV: PropBatch[];
  signsH: PropBatch[];
  billboards: PropBatch[];
  trees: PropBatch[];
  pole: PropBatch;
  trafficLight: PropBatch;
  rail: PropBatch;
  bench: PropBatch;
  houseA: PropBatch;
  houseB: PropBatch;
  blockWall: PropBatch;
  shutter: PropBatch;
  all: PropBatch[];
  wireMat: StandardMaterial;
}

const SIGNS_V: [string, string, string][] = [
  ["居酒屋", "#7a1010", "#ffe9a8"],
  ["薬局", "#0d5aa7", "#ffffff"],
  ["カラオケ", "#c21d7a", "#ffffff"],
  ["ラーメン", "#d8a400", "#3b0000"],
  ["不動産", "#1c6b2e", "#ffffff"],
  ["歯科", "#ffffff", "#1450a0"],
  ["質", "#111111", "#f5d000"],
  ["焼肉", "#2a2a2a", "#ff6a00"],
];
const SIGNS_H: [string, string, string][] = [
  ["コンビニ", "#1a8f3c", "#ffffff"],
  ["クリーニング", "#2a6ebd", "#ffffff"],
  ["喫茶 アース", "#5a3b22", "#ffe7c2"],
  ["牛丼", "#e06a00", "#ffffff"],
];
const BILLBOARDS: [string, string, string][] = [
  ["EDF 隊員募集中！", "#0b2a5b", "#ffd84a"],
  ["地球を守れ", "#b01818", "#ffffff"],
  ["新発売 エナジードリンク", "#101010", "#5cff7a"],
];

export function createProps(scene: Scene, mats: { concrete: PBRMaterial; metal: PBRMaterial; darkMetal: PBRMaterial; glassDark: PBRMaterial; plaster: PBRMaterial; rooftile: PBRMaterial; corrugated: PBRMaterial }): PropKit {
  const all: PropBatch[] = [];
  const B = (m: Mesh) => {
    const b = new PropBatch(m);
    all.push(b);
    return b;
  };
  const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0) => {
    const m = MeshBuilder.CreateBox("p", { width: w, height: h, depth: d }, scene);
    m.position.set(x, y, z);
    m.bakeCurrentTransformIntoVertices();
    return m;
  };
  const cyl = (dia: number, h: number, x = 0, y = 0, z = 0, tess = 10) => {
    const m = MeshBuilder.CreateCylinder("p", { diameter: dia, height: h, tessellation: tess }, scene);
    m.position.set(x, y, z);
    m.bakeCurrentTransformIntoVertices();
    return m;
  };

  // 室外機（原点は底面中央）
  const acBody = box(1.6, 1.1, 0.7, 0, 0.55, 0);
  const acFan = cyl(0.8, 0.05, 0.25, 0.55, 0.36, 16);
  acFan.rotation.x = Math.PI / 2;
  acFan.bakeCurrentTransformIntoVertices();
  acBody.material = pbr(scene, "acWhite", new Color3(0.78, 0.78, 0.74), 0.5, 0.2);
  acFan.material = mats.darkMetal;
  const ac = B(merged("acUnit", [acBody, acFan], true));

  // 給水タンク（脚付き）
  const tankBody = cyl(3, 2.6, 0, 3.0, 0, 16);
  tankBody.material = pbr(scene, "tankMat", new Color3(0.82, 0.84, 0.86), 0.45, 0.3);
  const legs = [box(0.2, 1.8, 0.2, 1, 0.9, 1), box(0.2, 1.8, 0.2, -1, 0.9, 1), box(0.2, 1.8, 0.2, 1, 0.9, -1), box(0.2, 1.8, 0.2, -1, 0.9, -1)];
  for (const l of legs) l.material = mats.darkMetal;
  const tank = B(merged("waterTank", [tankBody, ...legs], true));

  // アンテナ
  const ant = merged("antenna", [cyl(0.12, 6, 0, 3, 0, 6), box(1.6, 0.06, 0.06, 0, 5, 0), box(1.2, 0.06, 0.06, 0, 4.2, 0)]);
  ant.material = mats.metal;
  const antenna = B(ant);

  // 自販機（3色）
  const vending = ["#c8102e", "#0a4fa3", "#f2f2f2"].map((col, i) => {
    const m = MeshBuilder.CreateBox("vend", {
      width: 1.0,
      height: 1.85,
      depth: 0.8,
      faceUV: [new Vector4(0, 0, 0.01, 0.01), new Vector4(0, 0, 1, 1), new Vector4(0, 0, 0.01, 0.01), new Vector4(0, 0, 0.01, 0.01), new Vector4(0, 0, 0.01, 0.01), new Vector4(0, 0, 0.01, 0.01)],
    }, scene);
    m.position.y = 0.925;
    m.bakeCurrentTransformIntoVertices();
    const mat = new PBRMaterial("vendMat" + i, scene);
    const tex = vendingTexture(scene, col);
    mat.albedoTexture = tex;
    mat.emissiveTexture = tex;
    mat.emissiveColor = new Color3(0.35, 0.35, 0.35);
    mat.roughness = 0.35;
    mat.metallic = 0.1;
    m.material = mat;
    return B(m);
  });

  // 縦看板（文字は ±Z 面）
  const signMat = (t: Texture, name: string) => {
    const m = new PBRMaterial(name, scene);
    m.albedoTexture = t;
    m.emissiveTexture = t;
    m.emissiveColor = new Color3(0.25, 0.25, 0.25);
    m.roughness = 0.5;
    m.metallic = 0;
    return m;
  };
  const faceUVSign = [new Vector4(0, 0, 1, 1), new Vector4(0, 0, 1, 1), new Vector4(0, 0, 0.02, 0.02), new Vector4(0, 0, 0.02, 0.02), new Vector4(0, 0, 0.02, 0.02), new Vector4(0, 0, 0.02, 0.02)];
  const signsV = SIGNS_V.map(([t, bg, fg], i) => {
    const m = MeshBuilder.CreateBox("signV", { width: 1.3, height: 5.2, depth: 0.35, faceUV: faceUVSign }, scene);
    m.material = signMat(signTexture(scene, t, bg, fg, true), "signV" + i);
    return B(m);
  });
  const signsH = SIGNS_H.map(([t, bg, fg], i) => {
    const m = MeshBuilder.CreateBox("signH", { width: 6, height: 1.3, depth: 0.3, faceUV: faceUVSign }, scene);
    m.material = signMat(signTexture(scene, t, bg, fg, false), "signH" + i);
    return B(m);
  });
  // 屋上の広告看板（骨組み付き。原点は屋上面）
  const billboards = BILLBOARDS.map(([t, bg, fg], i) => {
    const panel = MeshBuilder.CreateBox("bb", { width: 14, height: 5, depth: 0.4, faceUV: faceUVSign }, scene);
    panel.position.y = 6.5;
    panel.bakeCurrentTransformIntoVertices();
    panel.material = signMat(signTexture(scene, t, bg, fg, false, 160, 448), "bb" + i);
    const frame = merged("bbFrame", [box(0.3, 4.5, 0.3, -5, 2.25, -0.5), box(0.3, 4.5, 0.3, 5, 2.25, -0.5), box(0.3, 4.5, 0.3, 0, 2.25, -0.5), box(12, 0.2, 0.2, 0, 3.8, -0.5)]);
    frame.material = mats.darkMetal;
    return B(merged("billboard" + i, [panel, frame], true));
  });

  // 街路樹（幹＋葉のかたまり。2色）
  const trees = [new Color3(0.13, 0.28, 0.1), new Color3(0.2, 0.33, 0.12)].map((leaf, i) => {
    const trunk = cyl(0.35, 3.2, 0, 1.6, 0, 7);
    trunk.material = pbr(scene, "trunk" + i, new Color3(0.22, 0.16, 0.11), 0.9, 0);
    const blobs: Mesh[] = [];
    for (const [x, y, z, r] of [
      [0, 4.2, 0, 2.2],
      [0.9, 3.6, 0.4, 1.6],
      [-0.8, 3.7, -0.5, 1.7],
      [0.2, 5.3, -0.2, 1.5],
    ]) {
      const s = MeshBuilder.CreateIcoSphere("leaf", { radius: r, subdivisions: 1, flat: true }, scene);
      s.position.set(x, y, z);
      s.scaling.y = 0.85;
      s.bakeCurrentTransformIntoVertices();
      blobs.push(s);
    }
    const leaves = merged("leaves", blobs);
    leaves.material = pbr(scene, "leafMat" + i, leaf, 0.85, 0);
    return B(merged("tree" + i, [trunk, leaves], true));
  });

  // 電柱（原点は根元）。腕木と碍子、変圧器
  const poleMain = cyl(0.36, 10, 0, 5, 0, 8);
  poleMain.material = pbr(scene, "poleMat", new Color3(0.6, 0.6, 0.58), 0.8, 0);
  const arms = merged("arms", [box(2.2, 0.12, 0.12, 0, 9.2, 0), box(1.6, 0.12, 0.12, 0, 8.4, 0)]);
  arms.material = mats.darkMetal;
  const trans = cyl(0.6, 1.0, 0.45, 6.8, 0, 10);
  trans.material = pbr(scene, "transMat", new Color3(0.5, 0.52, 0.5), 0.6, 0.4);
  const pole = B(merged("utilityPole", [poleMain, arms, trans], true));

  // 信号機（原点は根元、腕は +X 方向）
  const tlPole = cyl(0.22, 6, 0, 3, 0, 8);
  const tlArm = box(4, 0.15, 0.15, 2, 5.8, 0);
  const tlBox = box(1.6, 0.5, 0.35, 3.6, 5.5, 0);
  for (const m of [tlPole, tlArm, tlBox]) m.material = mats.darkMetal;
  const lights = [
    [3.1, new Color3(0.1, 1.6, 0.4)],
    [3.6, new Color3(1.6, 1.2, 0.1)],
    [4.1, new Color3(0.3, 0.02, 0.02)],
  ].map(([x, c]) => {
    const l = cyl(0.32, 0.06, x as number, 5.5, -0.2, 12);
    l.rotation.x = Math.PI / 2;
    l.bakeCurrentTransformIntoVertices();
    l.material = pbr(scene, "tl" + x, new Color3(0, 0, 0), 0.3, 0, c as Color3);
    return l;
  });
  const trafficLight = B(merged("trafficLight", [tlPole, tlArm, tlBox, ...lights], true));

  // ガードレール（長さ 4m、原点は中央下）
  const railMat = pbr(scene, "railMat", new Color3(0.86, 0.86, 0.84), 0.35, 0.6);
  const rail = merged("rail", [box(4, 0.32, 0.06, 0, 0.75, 0), box(0.1, 0.8, 0.1, -1.95, 0.4, 0), box(0.1, 0.8, 0.1, 0, 0.4, 0)]);
  rail.material = railMat;
  const railB = B(rail);

  // ベンチ
  const benchM = merged("bench", [box(1.8, 0.08, 0.5, 0, 0.45, 0), box(1.8, 0.4, 0.06, 0, 0.75, -0.22), box(0.08, 0.45, 0.45, -0.8, 0.22, 0), box(0.08, 0.45, 0.45, 0.8, 0.22, 0)]);
  benchM.material = pbr(scene, "benchMat", new Color3(0.4, 0.27, 0.15), 0.8, 0);
  const bench = B(benchM);

  // 一戸建て（2種類。原点は敷地中央の地面、正面は +Z）
  const house = (w: number, d: number, h: number, name: string) => {
    const walls = MeshBuilder.CreateBox("hw", {
      width: w,
      height: h,
      depth: d,
      wrap: true,
      faceUV: [new Vector4(0, 0, w / 3, h / 3), new Vector4(0, 0, w / 3, h / 3), new Vector4(0, 0, d / 3, h / 3), new Vector4(0, 0, d / 3, h / 3), new Vector4(0, 0, 1, 1), new Vector4(0, 0, 1, 1)],
    }, scene);
    walls.position.y = h / 2;
    walls.bakeCurrentTransformIntoVertices();
    walls.material = mats.plaster;
    // 切妻屋根（軒の出 0.6m）
    const roof = gableRoof(scene, w + 1.2, d + 1.2, 2.4);
    roof.position.y = h;
    roof.bakeCurrentTransformIntoVertices();
    roof.material = mats.rooftile;
    const wins: Mesh[] = [];
    for (const [x, y] of [
      [-w / 4, 1.5],
      [w / 4, 1.5],
      [-w / 4, 4.2],
      [w / 4, 4.2],
    ]) {
      wins.push(box(1.6, 1.2, 0.1, x, y, d / 2 + 0.03));
      wins.push(box(1.6, 1.2, 0.1, x, y, -d / 2 - 0.03));
    }
    wins.push(box(0.1, 1.2, 1.4, w / 2 + 0.03, 4.2, 0));
    wins.push(box(0.1, 1.2, 1.4, -w / 2 - 0.03, 4.2, 0));
    const winM = merged("win", wins);
    winM.material = mats.glassDark;
    const door = box(1.0, 2.1, 0.12, w / 4, 1.05, d / 2 + 0.06);
    door.material = pbr(scene, "doorMat", new Color3(0.35, 0.22, 0.12), 0.6, 0);
    return merged(name, [walls, roof, winM, door], true);
  };
  const houseA = B(house(8, 9, 5.6, "houseA"));
  const houseB = B(house(9.5, 7.5, 5.6, "houseB"));

  // ブロック塀（長さ 1m 単位。拡大して使う。原点は中央下）
  const bw = box(1, 1.3, 0.18, 0, 0.65, 0);
  bw.material = pbr(scene, "blockWall", new Color3(0.62, 0.61, 0.58), 0.9, 0);
  const blockWall = B(bw);

  // シャッター（商店の正面。原点は下端中央、+Z 向き）
  const sh = MeshBuilder.CreateBox("shutter", { width: 4, height: 2.6, depth: 0.12 }, scene);
  sh.position.y = 1.3;
  sh.bakeCurrentTransformIntoVertices();
  sh.material = mats.corrugated;
  const shutter = B(sh);

  const wireMat = new StandardMaterial("wireMat", scene);
  wireMat.diffuseColor = new Color3(0.05, 0.05, 0.05);
  wireMat.specularColor = new Color3(0, 0, 0);

  return {
    ac,
    tank,
    antenna,
    vending,
    signsV,
    signsH,
    billboards,
    trees,
    pole,
    trafficLight,
    rail: railB,
    bench,
    houseA,
    houseB,
    blockWall,
    shutter,
    all,
    wireMat,
  };
}

/** 切妻屋根のメッシュ（原点は軒の高さの中央。棟は Z 方向） */
function gableRoof(scene: Scene, w: number, d: number, rise: number): Mesh {
  const hw = w / 2,
    hd = d / 2;
  const P = {
    a: [-hw, 0, -hd],
    b: [hw, 0, -hd],
    c: [hw, 0, hd],
    e: [-hw, 0, hd],
    r0: [0, rise, -hd],
    r1: [0, rise, hd],
  };
  const slope = Math.hypot(hw, rise);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const quad = (p: number[][], uv: number[][]) => {
    const i = positions.length / 3;
    for (const v of p) positions.push(...v);
    for (const t of uv) uvs.push(...t);
    indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  const tri = (p: number[][], uv: number[][]) => {
    const i = positions.length / 3;
    for (const v of p) positions.push(...v);
    for (const t of uv) uvs.push(...t);
    indices.push(i, i + 1, i + 2);
  };
  const U = d / 2,
    V = slope / 2;
  quad([P.a, P.r0, P.r1, P.e], [[0, 0], [0, V], [U, V], [U, 0]]); // 左の屋根面
  quad([P.b, P.c, P.r1, P.r0], [[0, 0], [U, 0], [U, V], [0, V]]); // 右の屋根面
  tri([P.a, P.b, P.r0], [[0, 0], [w / 2, 0], [w / 4, V]]); // 妻
  tri([P.c, P.e, P.r1], [[0, 0], [w / 2, 0], [w / 4, V]]);
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.normals = normals;
  vd.uvs = uvs;
  const m = new Mesh("roof", scene);
  vd.applyToMesh(m);
  return m;
}

/** 2点間に垂れ下がった電線（カテナリーの近似）の点列 */
export function wirePath(a: Vector3, b: Vector3, sag: number, n = 8): Vector3[] {
  const pts: Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = Vector3.Lerp(a, b, t);
    p.y -= Math.sin(t * Math.PI) * sag;
    pts.push(p);
  }
  return pts;
}

export const PROP_RAND = rand;
