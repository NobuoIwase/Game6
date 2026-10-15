// ============================================================================
// アセットのパック作成: scripts/import_assets.py library で作った台帳から、
// scripts/asset_selection.json で選んだアセットを「カテゴリ別のパック GLB」にまとめる。
//
//   node scripts/build_packs.mjs        （作業フォルダは環境変数 ASSET_WORK、既定 .asset-work/）
//
// ・公開先（claude.ai のアーティファクト）の制限: 1 ファイル 15MB・全体 511 ファイル・256MB。
//   1 モデル 1 ファイルでは収まらないので、複数モデルを 1 つの GLB にまとめる
// ・各モデルの各状態は、ルート直下の「<id>|<state>」という名前のノードになる
// ・同じ画像・材質はパック内で共有（dedup）、形状は meshopt で圧縮、画像は WebP（最大 1024px）
// ・出力: public/assets/models/<pack>.glb と catalog.json（寸法・三角形数・どのパックか）
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, prune, meshopt, unpartition, mergeDocuments, textureCompress } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptDecoder } from "meshoptimizer";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = process.env.ASSET_WORK || path.join(ROOT, ".asset-work");
const OUT = path.join(ROOT, "public", "assets", "models");
const MAX_BYTES = 14.5e6;
const sel = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "asset_selection.json"), "utf8"));
const full = JSON.parse(fs.readFileSync(path.join(WORK, "catalog_full.json"), "utf8"));
await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

/** list = [{id, states}] を 1 つのパックにして書き出す。大きすぎれば半分に分ける */
async function buildPack(name, list) {
  const doc = await io.read(path.join(WORK, "library", list[0].id, list[0].states[0] + ".glb"));
  // 最初の 1 件で作った文書を空にしてから全件を合流させる
  for (const n of doc.getRoot().listNodes()) n.dispose();
  for (const s of doc.getRoot().listScenes()) s.dispose();
  const scene = doc.createScene("pack");
  doc.getRoot().setDefaultScene(scene);
  for (const a of list) {
    for (const st of a.states) {
      const src = await io.read(path.join(WORK, "library", a.id, st + ".glb"));
      const holder = src.createNode(`${a.id}|${st}`);
      for (const s of src.getRoot().listScenes()) for (const n of s.listChildren()) holder.addChild(n);
      for (const s of src.getRoot().listScenes()) s.dispose();
      const sc = src.createScene("s");
      sc.addChild(holder);
      const map = mergeDocuments(doc, src);
      const merged = map.get(holder);
      for (const s of doc.getRoot().listScenes()) if (s !== scene) s.dispose();
      scene.addChild(merged);
    }
  }
  await doc.transform(
    dedup(),
    prune({ keepLeaves: true, keepAttributes: true }),
    textureCompress({ encoder: sharp, targetFormat: "webp", resize: [1024, 1024], quality: 85 }),
    unpartition(),
    meshopt({ encoder: MeshoptEncoder, level: "medium" }),
  );
  const bytes = await io.writeBinary(doc);
  if (bytes.byteLength > MAX_BYTES && list.length > 1) {
    const h = Math.ceil(list.length / 2);
    return [...(await buildPack(name + "a", list.slice(0, h))), ...(await buildPack(name + "b", list.slice(h)))];
  }
  if (bytes.byteLength > MAX_BYTES) console.warn("  !! over limit", name, list[0].id, (bytes.byteLength / 1e6).toFixed(1));
  fs.writeFileSync(path.join(OUT, name + ".glb"), bytes);
  console.log(`${name}.glb  ${list.length} assets  ${(bytes.byteLength / 1e6).toFixed(1)} MB`);
  return [{ name, list }];
}

const catalog = [];
let total = 0;
for (const g of sel.groups) {
  const re = new RegExp("^(?:" + g.match + ")$");
  let ids = Object.keys(full).filter((i) => re.test(i)).sort();
  if (g.limit) {
    const step = Math.max(1, ids.length / g.limit);
    ids = Array.from({ length: Math.min(g.limit, ids.length) }, (_, k) => ids[Math.floor(k * step)]);
  }
  const items = ids.map((id) => ({ id, states: g.states.filter((s) => full[id].states[s]) })).filter((a) => a.states.includes("normal"));
  for (let k = 0; k < items.length; k += g.packSize) {
    const chunk = items.slice(k, k + g.packSize);
    const packs = await buildPack(`${g.role}_${String(k / g.packSize).padStart(2, "0")}`, chunk);
    for (const p of packs) {
      total += fs.statSync(path.join(OUT, p.name + ".glb")).size;
      for (const a of p.list) {
        const e = full[a.id];
        const states = {};
        for (const st of a.states) {
          const s = e.states[st];
          states[st] = { min: s.min, max: s.max, tris: s.tris };
        }
        catalog.push({ id: a.id, name: e.name, role: g.role, pack: p.name, states });
      }
    }
  }
}
fs.writeFileSync(path.join(OUT, "catalog.json"), JSON.stringify({ assets: catalog }));
console.log(`total ${catalog.length} assets, ${(total / 1e6).toFixed(1)} MB, ${fs.readdirSync(OUT).length} files`);
