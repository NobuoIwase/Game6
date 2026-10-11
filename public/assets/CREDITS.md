# アセットのクレジット / Asset credits

すべて [Poly Haven](https://polyhaven.com/) の CC0（パブリックドメイン相当）素材。商用利用・再配布可、クレジット表記は任意。
License: https://polyhaven.com/license

| ファイル | 元アセット | 種類 |
|---|---|---|
| textures/asphalt_* | asphalt_02 | 道路 |
| textures/pavement_* | concrete_pavement | 歩道・屋上・広場 |
| textures/facade_* | concrete_panels | オフィスビル外壁（窓は Canvas で合成） |
| textures/brick_* | brick_wall_001 | レンガのアパート外壁（窓は Canvas で合成） |
| hdri/sky_1k.hdr | kloofendal_48d_partly_cloudy_puresky (1K HDR) | 環境光・反射 |
| hdri/sky_4k.jpg | 同上の tonemapped JPG を 4096x2048 に縮小 | 空の背景 |

各テクスチャは `_diff`（アルベド）/ `_nor`（OpenGL 法線）/ `_arm`（R=AO, G=粗さ, B=金属度）の 1K JPG。
再取得は `npm run fetch-assets`（scripts/fetch-assets.mjs）。
