// CC0 アセット（Poly Haven）をダウンロードして public/assets に配置するスクリプト。
// 使い方: npm run fetch-assets
// 取得済みのファイルはスキップする。アセットはリポジトリにもコミット済みなので通常は不要。
import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "assets");
const TEX_RES = "1k";

// [Poly Haven ID, 保存名]
const textures = [
  ["asphalt_02", "asphalt"],
  ["concrete_pavement", "pavement"],
  ["concrete_panels", "facade"],
  ["brick_wall_001", "brick"],
];
const hdri = "kloofendal_48d_partly_cloudy_puresky";

async function exists(p) { try { await access(p); return true; } catch { return false; } }
async function download(url, out) {
  if (await exists(out)) { console.log("skip", out); return; }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, Buffer.from(await res.arrayBuffer()));
  console.log("ok  ", out);
}

for (const [id, name] of textures) {
  const files = await (await fetch(`https://api.polyhaven.com/files/${id}`)).json();
  await download(files.Diffuse[TEX_RES].jpg.url, join(root, "textures", `${name}_diff.jpg`));
  await download(files.nor_gl[TEX_RES].jpg.url, join(root, "textures", `${name}_nor.jpg`));
  await download(files.arm[TEX_RES].jpg.url, join(root, "textures", `${name}_arm.jpg`));
}
const h = await (await fetch(`https://api.polyhaven.com/files/${hdri}`)).json();
await download(h.hdri["1k"].hdr.url, join(root, "hdri", "sky_1k.hdr"));
// 空の背景用。元は 8K なので、取得後に 4096x2048 へ縮小して sky_4k.jpg として保存する。
const sky4k = join(root, "hdri", "sky_4k.jpg");
if (await exists(sky4k)) {
  console.log("skip", sky4k);
} else {
  const raw = join(root, "hdri", "sky_tonemapped.jpg");
  await download(h.tonemapped.url, raw);
  console.log(
    "\n空の画像を縮小してください（例: ImageMagick）:\n" +
      `  magick "${raw}" -resize 4096x2048 -quality 85 "${sky4k}"\n` +
      "縮小後 sky_tonemapped.jpg は削除してかまいません。",
  );
}
