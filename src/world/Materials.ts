// ============================================================================
// リアル調 PBR マテリアル。
// Poly Haven (CC0) のテクスチャを読み込み、建物の外壁は Canvas 上で窓を合成して
// 「アルベド / 法線 / ARM(AO・粗さ・金属度)」の3枚を作る。
// ============================================================================
import { Color3, DynamicTexture, PBRMaterial, Scene, Texture } from "@babylonjs/core";

const TEX = "assets/textures/";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("image load failed: " + src));
    img.src = src;
  });
}

function makeCanvas(size: number) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  return c;
}

function canvasTexture(name: string, canvas: HTMLCanvasElement, scene: Scene, srgb: boolean) {
  const t = new DynamicTexture(name, canvas, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  t.update(false);
  t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE;
  t.anisotropicFilteringLevel = 8;
  t.gammaSpace = srgb;
  return t;
}

function tiled(url: string, scene: Scene, srgb = true) {
  const t = new Texture(url, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
  t.anisotropicFilteringLevel = 8;
  t.gammaSpace = srgb;
  return t;
}

/** ARM テクスチャ（R=AO, G=粗さ, B=金属度）を PBR に設定 */
function applyArm(m: PBRMaterial, arm: Texture) {
  m.metallicTexture = arm;
  m.useAmbientOcclusionFromMetallicTextureRed = true;
  m.useRoughnessFromMetallicTextureGreen = true;
  m.useMetallnessFromMetallicTextureBlue = true;
  m.metallic = 1;
  m.roughness = 1;
}

/** 地面などの単純なタイル材 */
export function surfaceMaterial(name: string, base: string, scene: Scene, uvScale: number, tint?: Color3): PBRMaterial {
  const m = new PBRMaterial(name, scene);
  const diff = tiled(`${TEX}${base}_diff.jpg`, scene);
  const nor = tiled(`${TEX}${base}_nor.jpg`, scene, false);
  const arm = tiled(`${TEX}${base}_arm.jpg`, scene, false);
  for (const t of [diff, nor, arm]) {
    t.uScale = uvScale;
    t.vScale = uvScale;
  }
  m.albedoTexture = diff;
  m.bumpTexture = nor;
  m.invertNormalMapY = false;
  applyArm(m, arm);
  if (tint) m.albedoColor = tint;
  return m;
}

export type FacadeStyle = "office" | "brick" | "glass";

export interface FacadeSpec {
  style: FacadeStyle;
  /** テクスチャ1枚が表す横幅（m） */
  tileW: number;
  /** テクスチャ1枚が表す高さ（m） */
  tileH: number;
}

export const FACADE_SPECS: Record<FacadeStyle, FacadeSpec> = {
  office: { style: "office", tileW: 7, tileH: 7.6 },
  brick: { style: "brick", tileW: 8, tileH: 6.4 },
  glass: { style: "glass", tileW: 6, tileH: 8 },
};

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/** 窓ガラス1枚を描く（空の映り込みっぽいグラデーション） */
function drawGlass(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, blinds: boolean, dim = false) {
  const g = ctx.createLinearGradient(x, y, x + w * 0.4, y + h);
  const l = rnd(0.75, 1.25);
  g.addColorStop(0, `rgb(${70 * l | 0},${88 * l | 0},${105 * l | 0})`);
  g.addColorStop(0.55, `rgb(${32 * l | 0},${42 * l | 0},${52 * l | 0})`);
  g.addColorStop(1, `rgb(${22 * l | 0},${28 * l | 0},${34 * l | 0})`);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  if (blinds) {
    const bh = h * rnd(0.2, 0.6);
    const k = dim ? 0.45 : 1;
    ctx.fillStyle = `rgba(${(rnd(170, 215) * k) | 0},${(rnd(165, 205) * k) | 0},${(rnd(150, 190) * k) | 0},0.85)`;
    ctx.fillRect(x, y, w, bh);
    ctx.fillStyle = "rgba(0,0,0,0.15)";
    for (let yy = y + 3; yy < y + bh; yy += 5) ctx.fillRect(x, yy, w, 1);
  }
}

/**
 * 外壁テクスチャを Canvas で合成する。
 * 1枚 = 2スパン × 2フロア分。
 */
async function buildFacade(style: FacadeStyle, scene: Scene) {
  const S = 1024;
  const alb = makeCanvas(S);
  const nor = makeCanvas(S);
  const arm = makeCanvas(S);
  const a = alb.getContext("2d")!;
  const n = nor.getContext("2d")!;
  const r = arm.getContext("2d")!;
  const cells = 2;
  const cw = S / cells;

  if (style === "glass") {
    // カーテンウォール（全面ガラス）
    a.fillStyle = "#283642";
    a.fillRect(0, 0, S, S);
    n.fillStyle = "rgb(128,128,255)";
    n.fillRect(0, 0, S, S);
    r.fillStyle = "rgb(255,18,40)"; // 滑らかなガラス
    r.fillRect(0, 0, S, S);
    for (let iy = 0; iy < cells; iy++)
      for (let ix = 0; ix < cells; ix++) {
        const x = ix * cw,
          y = iy * cw;
        drawGlass(a, x, y, cw, cw, Math.random() < 0.1, true);
        // スパンドレル（床の位置の不透明パネル）
        a.fillStyle = "#1b232b";
        a.fillRect(x, y + cw * 0.82, cw, cw * 0.18);
        r.fillStyle = "rgb(255,90,120)";
        r.fillRect(x, y + cw * 0.82, cw, cw * 0.18);
      }
    // マリオン（縦横のアルミ枠）
    a.fillStyle = "#9aa3ab";
    r.fillStyle = "rgb(255,80,255)";
    n.fillStyle = "rgb(150,128,255)";
    for (let i = 0; i <= cells * 2; i++) {
      const x = (i * S) / (cells * 2) - 5;
      const w = i % 2 === 0 ? 12 : 6;
      a.fillRect(x, 0, w, S);
      r.fillRect(x, 0, w, S);
      n.fillRect(x, 0, w / 2, S);
    }
    for (let i = 0; i <= cells; i++) {
      const y = i * cw + cw * 0.82 - 5;
      a.fillRect(0, y, S, 10);
      r.fillRect(0, y, S, 10);
    }
  } else {
    // 実写テクスチャの壁に窓を合成
    const base = style === "office" ? "facade" : "brick";
    const [di, ni, ai] = await Promise.all([
      loadImage(`${TEX}${base}_diff.jpg`),
      loadImage(`${TEX}${base}_nor.jpg`),
      loadImage(`${TEX}${base}_arm.jpg`),
    ]);
    const rep = style === "office" ? 2 : 3; // 実写テクスチャの繰り返し回数
    for (let i = 0; i < rep; i++)
      for (let j = 0; j < rep; j++) {
        a.drawImage(di, (i * S) / rep, (j * S) / rep, S / rep, S / rep);
        n.drawImage(ni, (i * S) / rep, (j * S) / rep, S / rep, S / rep);
        r.drawImage(ai, (i * S) / rep, (j * S) / rep, S / rep, S / rep);
      }
    if (style === "office") {
      // 少し明るいコンクリート色に寄せる
      a.fillStyle = "rgba(190,185,175,0.25)";
      a.fillRect(0, 0, S, S);
    }
    const wx0 = style === "office" ? 0.14 : 0.24,
      wx1 = style === "office" ? 0.86 : 0.76;
    const wy0 = 0.18,
      wy1 = style === "office" ? 0.78 : 0.72;
    for (let iy = 0; iy < cells; iy++)
      for (let ix = 0; ix < cells; ix++) {
        const x = ix * cw + cw * wx0,
          y = iy * cw + cw * wy0;
        const w = cw * (wx1 - wx0),
          h = cw * (wy1 - wy0);
        // 窓枠
        a.fillStyle = style === "office" ? "#8d9196" : "#d8d4cc";
        a.fillRect(x - 10, y - 10, w + 20, h + 20);
        // 窓台（下の出っ張り）
        a.fillStyle = "#b9b5ad";
        a.fillRect(x - 16, y + h + 8, w + 32, 12);
        // 影
        a.fillStyle = "rgba(0,0,0,0.35)";
        a.fillRect(x - 10, y + h + 20, w + 20, 8);
        drawGlass(a, x, y, w, h, Math.random() < 0.45);
        if (style === "office") {
          // 中央の縦桟
          a.fillStyle = "#8d9196";
          a.fillRect(x + w / 2 - 4, y, 8, h);
        } else {
          a.fillStyle = "#d8d4cc";
          a.fillRect(x + w / 2 - 5, y, 10, h);
          a.fillRect(x, y + h * 0.35, w, 8);
        }
        // 法線: 窓部分は平ら、枠の上下にエッジ
        n.fillStyle = "rgb(128,128,255)";
        n.fillRect(x - 10, y - 10, w + 20, h + 20);
        n.fillStyle = "rgb(128,175,230)";
        n.fillRect(x - 16, y + h + 8, w + 32, 4);
        n.fillStyle = "rgb(128,80,230)";
        n.fillRect(x - 10, y - 10, w + 20, 4);
        // ARM: 枠 = 半光沢、ガラス = 鏡面
        r.fillStyle = "rgb(255,110,40)";
        r.fillRect(x - 10, y - 10, w + 20, h + 20);
        r.fillStyle = "rgb(255,14,20)";
        r.fillRect(x, y, w, h);
      }
  }

  return {
    albedo: canvasTexture(`facade_${style}_alb`, alb, scene, true),
    normal: canvasTexture(`facade_${style}_nor`, nor, scene, false),
    arm: canvasTexture(`facade_${style}_arm`, arm, scene, false),
  };
}

export interface CityMaterials {
  facades: { style: FacadeStyle; mat: PBRMaterial }[];
  roof: PBRMaterial;
  road: PBRMaterial;
  sidewalk: PBRMaterial;
  plaza: PBRMaterial;
  rubble: PBRMaterial;
  balcony: PBRMaterial;
  garageWall: PBRMaterial;
  marking: PBRMaterial;
  metal: PBRMaterial;
  darkMetal: PBRMaterial;
  carPaints: PBRMaterial[];
  glassDark: PBRMaterial;
  tire: PBRMaterial;
  lampGlow: PBRMaterial;
}

export async function createCityMaterials(scene: Scene): Promise<CityMaterials> {
  const facades: { style: FacadeStyle; mat: PBRMaterial }[] = [];
  const tints: Record<FacadeStyle, Color3[]> = {
    office: [new Color3(1, 1, 1), new Color3(0.86, 0.84, 0.8), new Color3(1.05, 1.0, 0.92)],
    brick: [new Color3(1, 1, 1), new Color3(0.8, 0.82, 0.86)],
    glass: [new Color3(1, 1, 1), new Color3(0.8, 0.95, 1.0)],
  };
  for (const style of ["office", "brick", "glass"] as FacadeStyle[]) {
    const tex = await buildFacade(style, scene);
    for (const tint of tints[style]) {
      const m = new PBRMaterial(`facade_${style}_${facades.length}`, scene);
      m.albedoTexture = tex.albedo;
      m.bumpTexture = tex.normal;
      m.invertNormalMapY = false;
      applyArm(m, tex.arm);
      m.albedoColor = tint;
      facades.push({ style, mat: m });
    }
  }

  const roof = surfaceMaterial("roof", "pavement", scene, 1, new Color3(0.62, 0.62, 0.62));
  const road = surfaceMaterial("road", "asphalt", scene, 1);
  const sidewalk = surfaceMaterial("sidewalk", "pavement", scene, 1);
  const plaza = surfaceMaterial("plaza", "pavement", scene, 1, new Color3(0.95, 0.9, 0.85));
  const rubble = surfaceMaterial("rubble", "facade", scene, 1, new Color3(0.55, 0.53, 0.5));
  const balcony = surfaceMaterial("balcony", "pavement", scene, 1, new Color3(0.85, 0.83, 0.8));
  const garageWall = surfaceMaterial("garageWall", "facade", scene, 1, new Color3(0.8, 0.8, 0.78));

  const marking = new PBRMaterial("marking", scene);
  marking.albedoColor = new Color3(0.85, 0.85, 0.82);
  marking.roughness = 0.7;
  marking.metallic = 0;

  const metal = new PBRMaterial("metal", scene);
  metal.albedoColor = new Color3(0.55, 0.57, 0.6);
  metal.metallic = 0.9;
  metal.roughness = 0.4;

  const darkMetal = new PBRMaterial("darkMetal", scene);
  darkMetal.albedoColor = new Color3(0.08, 0.085, 0.09);
  darkMetal.metallic = 0.7;
  darkMetal.roughness = 0.45;

  const paints = [
    new Color3(0.7, 0.05, 0.05),
    new Color3(0.9, 0.9, 0.9),
    new Color3(0.05, 0.06, 0.07),
    new Color3(0.1, 0.2, 0.45),
    new Color3(0.55, 0.56, 0.58),
  ];
  const carPaints = paints.map((c, i) => {
    const m = new PBRMaterial(`carPaint${i}`, scene);
    m.albedoColor = c;
    m.metallic = 0.4;
    m.roughness = 0.35;
    m.clearCoat.isEnabled = true;
    m.clearCoat.intensity = 1;
    m.clearCoat.roughness = 0.05;
    return m;
  });

  const glassDark = new PBRMaterial("glassDark", scene);
  glassDark.albedoColor = new Color3(0.02, 0.025, 0.03);
  glassDark.metallic = 0.1;
  glassDark.roughness = 0.05;

  const tire = new PBRMaterial("tire", scene);
  tire.albedoColor = new Color3(0.03, 0.03, 0.03);
  tire.metallic = 0;
  tire.roughness = 0.9;

  const lampGlow = new PBRMaterial("lampGlow", scene);
  lampGlow.albedoColor = new Color3(1, 0.95, 0.85);
  lampGlow.emissiveColor = new Color3(0.6, 0.55, 0.45);
  lampGlow.roughness = 0.3;
  lampGlow.metallic = 0;

  return { facades, roof, road, sidewalk, plaza, rubble, balcony, garageWall, marking, metal, darkMetal, carPaints, glassDark, tire, lampGlow };
}
