# 引き継ぎ資料（HANDOFF）

このプロジェクトを引き継ぐ AI / 開発者向けの資料です。README の「フォルダ構成」と合わせて読んでください。
最終更新: 2026-10-13（v0.4.1）

---

## 1. プロジェクトの目的と前提

- ユーザーの依頼: 「地球防衛軍」シリーズのコピーのようなゲームを作る。PC とスマホ（可能なら）で動作。無料のゲームエンジンを使用。リアル調。
- 最初はテスト版: 1 ミッション、敵 3 種、陸戦兵（アサルトライフル＋ミサイルランチャー）。
- 倒した敵、爆発・拘束を受けたプレイヤーはラグドール化。
- 将来、武器などを差し替えられる設計にすること。
- 敵 AI は「出現直後は待機 → 攻撃される／近づかれると周囲の敵も起こして接近」。
- ユーザーの手描きイメージ（会話内の画像。リポジトリには未収録）の要素:
  - 上の絵: 三人称視点で銃を構えるプレイヤー、多数の巨大な敵、左上 HP バー「578/518」のような数値表示、右上の円形の敵レーダー、右下の武器アイコンと「50/100」の残弾表示
  - 下の絵: 「編隊を組み飛行するてき」、「曲がる時はひっくり返る」（急旋回で裏返る）、「絨毯爆撃が射撃から爆弾へ」（機銃掃射から爆撃に切り替わる）
- ユーザーは日本語話者。UI・コメント・ドキュメントは日本語で統一している。

## 2. 技術スタック

| 項目 | 内容 |
|---|---|
| エンジン | Babylon.js 9.30（`@babylonjs/core`、まとめて import している）|
| 物理 | Havok（`@babylonjs/havok` 1.3.x）。wasm は Vite の `?url` で読み込む（`src/core/Physics.ts`）|
| 言語 | TypeScript（strict）。`npm run typecheck` で型チェック |
| ビルド | Vite 8。`base: "./"` なので dist をどこに置いても動く |
| 描画 | WebGL2。PBR + HDR 環境光（`public/assets/hdri/sky_1k.hdr`）+ PhotoDome（`sky_4k.jpg`）|

## 3. 座標系・回転の約束事（重要）

- Babylon.js は**左手系**: +X 右、+Y 上、+Z 前（奥）。地面は y=0。マップは x,z ともに ±250m（`CITY_HALF`）。
- `Quaternion.RotationYawPitchRoll(yaw, pitch, roll)`:
  - yaw+ で +Z が +X 側へ回る（右旋回）
  - pitch+ で +Z が **下（-Y）** へ向く
  - roll+ で +X が +Y 側へ回る
  - 実際に node で確認済み。迷ったら `src/core/MathUtil.ts` の `lookQuat`（+Z を任意方向へ）/ `fromToQuat`（任意ベクトル間）を使う。
- **`Quaternion.FromLookDirectionLH` は +Z を指定方向に向けない**（検証で +X 指定 → +Z が -X になった）。使わないこと。
- カメラの `camPitch` は**正で下向き**。照準方向は `(sin(yaw)cos(pitch), -sin(pitch), cos(yaw)cos(pitch))`。
- `createInstance()` で作った InstancedMesh は**元メッシュの position/rotation を引き継ぐ**。テンプレートは y=-2000 等に隠しているので、インスタンス生成後は必ず position を設定し直す（`Flyer.ts` で一度ハマった）。

## 4. 更新ループ（`Game.frame` → `Game.update`）

1. 入力（`Input.update`）・ポーズ判定
2. 視点（yaw/pitch）更新
3. `Player.update`（移動・武器・被弾状態・アニメーション）
4. `EnemyManager.update`（連鎖起動の遅延処理 → 各敵の AI → 押し合い → 当たり球の更新）
5. `Projectiles.update` → `Pickups.update` → `City.update`（倒壊）→ 死体管理 → `Effects.update` → `Mission.update`
6. カメラ配置（建物めり込み防止・画面揺れ・ズーム FOV）→ HUD 更新
7. `scene.render()`（ここで Havok の物理も 1 ステップ進む）

`Game.simulate(秒, dt)` は描画せずに上記 3〜6 と物理を手動で進めるテスト用関数。

## 5. 当たり判定の方針

- **建物・地面**: Havok を使わず、`City` の AABB（軸並行の箱）＋空間グリッドで自前判定（`raycast`, `segment`, `collideCircle`, `heightAt`）。速くて確実。
  - 1 つの建物 = 複数の箱（`Building.boxes`）。箱は宙に浮いていてもよい（床・ベランダ・階段）。
  - `heightAt(x, z, fromY)`: fromY から STEP_UP(0.6m) 上までにある一番高い床面。プレイヤー・アイテムはこれを使う。
    fromY を省略すると一番上の面（屋上）＝敵の壁登り用。
  - `collideCircle`: 足元から STEP_UP 以下の箱は押し出さない（段差を登れる）。
  - 倒壊中・倒壊済みの建物の箱は判定から除外される。
- **死骸**: `Game.corpseRay / corpseSegment` がラグドールの各パーツを球で近似して判定。ヒットスキャン・ミサイル・敵弾すべてが止まる。
- **敵**: 各敵が数個の「当たり球」（`hitSpheres`、弱点は倍率付き）を持ち、`EnemyManager.raycast/segment` で判定。
- **Havok を使うのは**: ラグドール（死体・ダウン中のプレイヤー）、車、建物の破片だけ。衝突フィルタはラグドール ⇔ 静的物（地面・建物・車）のみ（ラグドール同士は当たらない＝軽量化）。`COL_*` 定数参照。
- 建物は Havok の静的ボディも持つ（ラグドールが建物にぶつかるため）。倒壊開始時に削除。

## 5.5 街の構成（v0.3.0〜）

- 道路の中心線 `LINES`（x・z とも同じ 8 本）と、道路ごとの幅 `ROAD_W_X` / `ROAD_W_Z`。z=-36 が大通り（幅30m・中央分離帯）、x=108 の道路の上に高架の高速道路。
- 街区 `Block` は道路幅から範囲を計算し、用途（plaza / park / business / mixed / residential）を割り当てる（`City.layoutBlocks`）。
- 小物は `src/world/Props.ts` の `PropBatch`（thin instance）で描画。看板の文字は Canvas テクスチャ。
  建物に付く小物（屋上設備・看板・一戸建て本体・ブロック塀・シャッター）は `Builder.thin` に積むと `Building.thin` に登録され、倒壊時に一緒に沈む。
- 一戸建ては見た目がすべて thin instance（2種類の家の形）で、当たり判定は箱だけを持つ。
- 描画回数の対策: 建物の影は 150m 以内だけ（0.5 秒ごとに更新）、画質「低」は影の更新を1フレームおき、カメラの描画距離を画質別に制限（霧で隠れる距離）。

## 6. ラグドールの仕組み（`src/core/Physics.ts`）

- `RigPart` = { node（**関節位置を原点にしたノード**）, parent（親パーツ番号、-1 で独立）, size/center（箱形状）, mass, swing/twist（角度制限）}。
- `new Ragdoll(scene, parts, opts)` で:
  1. 全パーツを `setParent(null)` してワールド座標に固定
  2. 箱形の動的ボディを付与
  3. 親子間に 6DoF 関節（並進ロック＋角度制限）を作成。軸は生成時の相対姿勢から計算するので、どんな姿勢からでも自然につながる
  4. 初速・回転・衝撃を付与
- ラグドール中のノードは**親なし**。位置は `node.position` を読む（`getAbsolutePosition()` は描画前だと古い値を返すことがある）。
- プレイヤーの起き上がり: `Soldier.endRagdoll()` が物理を破棄し、保存しておいた親と位置へ戻す。立ち位置は骨盤の位置。
- 地上の敵の死骸は `RigidCorpse`（死亡ポーズで固まった1剛体。死骸同士も衝突）。`Enemy.rigidize` → `deathPose()` を各敵で実装。
- 死体は `Game.addCorpse` に登録 → 9 秒 or 上限（画質ごとの `maxRagdolls`）超過で物理停止 → 沈んで削除。

## 7. 敵 AI の詳細

| 敵 | 待機中 | アクティブ時 |
|---|---|---|
| 甲殻型（旧・蟻型） `Ant.ts` | 巣の周り 14m をうろつく | 個体ごとの `flank` 角で左右に散開して接近。射程 38m 以内で視線が通れば溜め 0.5 秒 → 酸 8 発を放物線で噴射。5.2m 以内は噛みつき。被弾で減速（`stagger`）と押し戻し。性格（`temper`）で接近の仕方が変わる（`chaseMove`）|
| 蜘蛛型 `Spider.ts` | 時々向きを変えて小さく跳ねる | 好みの距離（22〜40m）を保つよう跳躍・横移動。射程 55m で溜め 0.35 秒 → 糸 8 本を扇状に発射（拘束値 +16/本）|
| 飛行型 `Flyer.ts` | 隊長機が上空 55m を周回、僚機は編隊位置 | 慣性飛行（速度ベクトルを最大加速度 6m/s² でしか変えられない＝大回りでゆったり）。航過（approach）→ 離脱（extend）→ 半宙返り（loop）を繰り返す。機体の姿勢は加速度から求めた「上」ベクトルで決める（`Flyer.update`）。航過 1・2 回目は機銃、3 回目以降は奇数回目が爆撃航過で、編隊ごと裏返り、**裏返っている間だけ**爆弾を落とす（`|bank| > 2.4`）|
| 超巨大生物 `Colossus.ts` | — | 演出のみ。ベジェ曲線に沿って首の節を並べ、伸びる→見つめる→引っ込む |
| 戦艦級 `Carrier.ts` | — | 飛来（凹みに飛行型 8 機を格納）→ 上空で停止 → 対角線上の 2 機ずつ発進（`DockSlot.stage`: docked 機首を内向きに格納 → drop 2.2 秒でゆっくり下降 → cross 円盤の下をくぐって対岸へ。対角線上の仲間と右側通行ですれ違う（進行方向の右へ最大 8m ふくらむ）→ around 円盤のまわりを回り込む → form 編隊位置 → free。発進間隔 0.8 秒）。全員が揃うか 6 秒待つと `releaseAll` で編隊飛行へ。その後は呼吸（10 秒周期で約 5 秒開く）。開いている間だけ上下の呼吸孔に有効打（閉じていると全体で 3%）。産卵孔が 1.2 秒光ったあと、丸まった敵を `EnemyManager.birth` で生む |
| 生まれた敵（丸まった玉） | — | `GroundEnemy.updateCurled`: 死亡ポーズのまま玉として落下 → 着地して 0.9 秒震える → 跳ねて体を開き、起動 |

- 怯み（`Enemy.stagger`）: 被弾ごとに `max(現在値, 0.18) + 威力/最大HP×0.8`（最大 0.6 秒）。怯み中は攻撃を中断し、のけぞり＋震えのモーション（`GroundEnemy.applyOrientation`）。
- 造形（v0.4.0〜）: `AnchorShapes.ts` の `slab`（面取りした塊＝潰した菱形立方八面体）、`gem`（多面体）、`crescent`（三日月形の鎌）、`spike`（とげ板）、`band`（任意の帯を厚み付きで押し出す）で組む。どれも頂点を共有しないのでフラットシェーディングになる。`band` はダミー UV を持つ（多面体と `Mesh.MergeMeshes` するには頂点属性を揃える必要があるため）。甲殻型=黒曜石色＋赤い装甲縁＋赤い眼、跳躍型=骨色＋灰色の脚＋紫の眼。大きさは各ファイルの定数 `S`。
- 脚の姿勢は `poseLeg(femur, tibia, 腿の向き, 脛の向き, 左右)`（胴体空間で指定）。腿は上面を上へ、鎌はふくらみを外側へ向ける。内部で `axisQuat`（+X を指定方向、+Y をヒント方向へ向ける回転）を使う。
- 死亡ポーズ（`deathPose`）は脚を腹側へ強く折りたたむ。`rigidize(速度, 回転, flip=true)` で前後軸まわりの角速度を与え、跳ねる間に半回転して仰向けになる。丸まった玉の状態でも同じ `deathPose` を使う。
- 起動の連鎖: `EnemyManager.alert(e)` が同じ群れ（`group`）と `alertRadius` 内の待機中の敵に `activate(0.15 + 距離/45 + 乱数)` を予約。予約が満了すると `alert` が再帰的に呼ばれ、さらに連鎖する。
- 地上敵の移動（`GroundEnemy.walk`）: 進行方向の少し先が高ければ壁を登る（水平移動停止・機首上げ）、足元が低ければ壁を降りる。屋上も歩ける。

## 7.5 陸戦兵のアニメーション（v0.4.0〜、`Soldier.ts`）

- 走り・歩きは `Soldier.RUN_*` / `WALK_*` のキーフレーム表（[位相, 角度]）をコサイン補間。股関節は前が +、膝は曲げるのが +。速度で歩き↔走りをブレンド、ダッシュで振り幅を増やす。
- 腰の高さは `legHeight(股, 膝)` の大きい方（＝接地している脚）に合わせる。足首（`footL/R`）は足裏が地面と平行になるよう打ち消す。
- 横・後ろへの移動: 骨盤を進行方向へひねり（最大約 63°）、胴体は逆にひねって照準方向を保つ。後ろ向きは周期を逆再生。
- 銃は `gunPivot`＝銃床の当たる位置（右肩のくぼみ）。`GunModel.offset` で銃モデルの原点をずらす。照準方向はルート空間で決め、骨盤・胴体の回転を打ち消して胴体ローカルへ変換（`poseGun`）。両腕は 2 ボーン IK でグリップへ。
- 姿勢の切り替え（構え／ローレディ／リロード）は `sm.low` / `sm.reload` を平滑化して回転を Slerp。
- 回避は `animateRoll(k)`（k = 0..1）。`rollPivot`（腰の高さ）を回転・上下させ、脚・胴・頭のポーズを段階ごとに指定。`Player` の回避は 0.78 秒で速度も段階ごとに変える。
- 確認方法: ゲームを `paused = true` にして `soldier.animate(...)` / `animateRoll(k)` を直接呼び、カメラを横に置いて `scene.render()`（下記「テスト・検証の方法」）。

## 7.6 自動テストプレイ（v0.4.1〜）

- `src/core/Bot.ts`: `Game.update` の先頭で `bot.drive(dt)` が Input の値（moveX/moveY/fire/dash、`press("roll")` など）と `camYaw`/`camPitch` を書き換える。人間の入力の代わりに同じ経路を通るので、ゲーム側に特別扱いはない。
- `scripts/autoplay.mjs`: Vite の開発サーバーをスクリプト内で起動 → playwright-core でヘッドレス Chromium → 難易度を選んで出撃 → `startBot()` → `simulate(5)` を繰り返し、終了まで進める。
- 被ダメージの内訳は `Player.damageLog`（`takeDamage(量, 位置, 吹き飛ばし, 種類)` の第 4 引数で集計）。撃破数は `EnemyManager.killed`。
- 難易度を変えたら `npm run autoplay -- --difficulty easy --runs 3` などで、クリア率と被ダメージの内訳を確かめる。自動操縦は人間より照準が正確なので、「自動操縦でも危ない」なら人間には難しすぎる。下手な人を想定するときは `--aim 0.03 --turn 3`。

## 8. 調整用の主な定数

| 定数 | 場所 | 意味 |
|---|---|---|
| `SELF_DAMAGE_RATE` | `core/Game.ts` | 自分の爆発で受けるダメージ倍率（0.3）|
| `DIFFICULTIES` | `data/missions.ts` | 難易度ごとの敵の体力・攻撃力の倍率（EASY 0.6/0.4、NORMAL 0.85/0.7）|
| `randomTemper` | `enemies/Enemy.ts` | 敵の性格の出現比率 |
| 押し戻し `knock * 2.2 / (mass / 300)` | `enemies/Enemy.ts onKnock` | 1 発ごとの押し戻し速度（上限 9m/s、毎秒 e^-5 で減衰）|
| `CORPSE_LIFE` | `core/Game.ts` | 死体の物理演算時間（15 秒）|
| `STEP_UP` | `world/City.ts` | 登れる段差（0.6m）|
| `S` | `enemies/Ant.ts`, `Spider.ts` | 敵の大きさの倍率（1.6）|
| `SHIP_HORNS` / `DOCK_R` / `VENT_Y` | `enemies/Carrier.ts` | 戦艦級のとげ（＝格納できる飛行型）の数・格納位置の半径・呼吸孔の高さ |
| `REAL_DIST` / `ABOVE` | `world/Stake.ts` | 遠景の国家級の見かけの距離・地上に出ている長さ（100m 単位）|
| `CS` | `enemies/Colossus.ts` | 超巨大生物の大きさの倍率（2.5）|
| `GRAVITY` | `core/Physics.ts` | 重力（-12、ゲーム的に少し強め）|
| `QualitySettings` | `core/Quality.ts` | 解像度・影・SSAO・ラグドール上限・敵数倍率 |
| `FLYER_BOMB_*` | `data/enemies.ts` | 爆弾の威力・半径 |
| `hp = 400 + 体積 * 0.05` | `world/City.ts finish` | 建物の耐久値 |

## 9. テスト・検証の方法

この開発環境（クラウドのコンテナ）には GPU がないため、Playwright + Chromium（SwiftShader のソフトウェア描画、約 1〜2fps）で確認した。

```js
// 例: ヘッドレス Chromium で起動して撮影（スクリプトはリポジトリ外で実行）
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
// タイトルで #startBtn をクリック → #loading が hidden になるまで待つ
// window.__game() で Game にアクセスできる（main.ts で公開）
```

便利なデバッグ操作（ブラウザのコンソールでも使える）:

```js
const g = __game();
const V = g.player.position.constructor;         // Vector3 クラス（グローバルの BABYLON は無い）
g.simulate(5);                                   // 描画なしで 5 秒進める
for (const e of g.enemies.list) g.enemies.alert(e); // 全敵を起動
g.player.knockdown(new V(1, 0, 0), 12);          // プレイヤーを吹き飛ばす（ラグドール）
g.debugCam = { pos, target };                    // カメラを固定（null で解除）
g.explode({ pos, radius: 8, damage: 500, knockback: 20, source: "player" });
// ポーズの確認: 更新を止めて陸戦兵のアニメーションを直接呼び、横から描画
g.paused = true;                                 // setPaused と違いポーズ画面を出さない
g.player.soldier.animate(1 / 60, 6, 0, 0, true, 0, false, false); // 前へ 6m/s
g.player.soldier.animateRoll(0.5);               // 前転の途中
g.camera.position.copyFrom(g.player.position.add(new V(3.2, 0.2, 0.3)));
g.camera.setTarget(g.player.position.add(new V(0, 0.9, 0.3)));
g.scene.render();
// 戦艦級をすぐ近くに出す
g.enemies.spawnGroup({ type: "carrier", count: 1, at: [20, 70], spread: 0, active: true }, 1);
```

v0.1.0 時点で確認済み: 読み込み・描画エラーなし、射撃・撃破・ラグドール化・連鎖起動・酸/糸/機銃/爆撃による被弾・プレイヤーのダウンと起き上がり・ミサイルの 4 体ロックオンと誘導・ウェーブ進行・ミッションクリア画面、スマホ表示（iPhone 相当のエミュレーション）でのタッチ UI 配置、本番ビルド（`npm run build` → `npm run preview`）。

v0.2.0 で追加確認: 立体駐車場の外階段を上れる、建物の破壊→消滅、ダメージ数字と赤い照準の表示、飛行型の機銃→裏返り爆撃、超巨大生物の表示。

v0.4.0 で追加確認: 陸戦兵の各ポーズ（待機・走り4位相・ダッシュ・リロード・横歩き・後ろ歩き・前転5段階・上向きの照準）を横から撮影して確認、新しい甲殻型・跳躍型の表示と死骸の丸まり、戦艦級の格納→発進→編隊集合→呼吸→産み落とし→玉が開いて起動、遠景の国家級の表示（画質「低」「中」）、全敵を起動した戦闘の 20 秒シミュレーションでエラーなし。

**未確認**: 実 GPU での fps、スマホ実機での操作感と性能（ユーザーのスマホで v0.1 が動作したことは確認済み）。

テストプレイ用の公開先: claude.ai のアーティファクト（.hdr を配信できないため、環境マップは空の JPG で代用される）。
公開手順: `npm run build` → `dist/index.html` から doctype/html/head/body タグを除いたページと、`dist/assets` 以下（.hdr を除く）を Artifact に publish。

## 9.5 予定: Google ドライブのアセット群の組み込み（依頼者からの指示）

- 依頼者が別の AI（GPT）で作らせている **1000 を超えるアセット群**を、Google ドライブにアップロード中（2026-10-14 時点で作業途中）。**最終的にゲームに組み込む**予定。
- 置き場所: 依頼者のマイドライブ。親フォルダ ID `15xfKOh-dN5NqVp5XsnHLZKWsV-ZvNR8w` の中に、2026-10-14 時点で次のものがある:
  - `Game6_SharedPBR30_Editable.zip`（約 34MB）
  - `01_Baseline700_QualityV2` / `02_Expansion540_Original` / `03_NewV3_Final` / `04_Textured_Revisions`（フォルダ）
- Claude のセッションからは Google Drive コネクタ（`mcp__Google_Drive__*`）で読める。アップロードが終わったと依頼者から連絡があってから、中身（形式・命名・ライセンス）を確認して組み込み方針を決める。
- 組み込み時の注意: スマホでも動く軽さを保つ（テクスチャ解像度・ポリゴン数・まとめて読み込む量）。出典とライセンスは `public/assets/CREDITS.md` に追記する。

## 10. 今後の拡張の指針

- **モデルの差し替え**: `Soldier` は部位ごとの TransformNode の下にメッシュをぶら下げているだけなので、glTF を読み込んで部位ノードに付け替えれば見た目だけ変えられる。スキンメッシュを使う場合は Babylon の `Ragdoll`（Physics/v2/ragdoll）ではなく、ボーンを本作の `Ragdoll` の各パーツノードに追従させる方式が楽。
- **敵の追加**: `Enemy`（飛行など）または `GroundEnemy`（歩行）を継承し、`center()`・`update()`・`onDeath()` を実装。`data/enemies.ts` に定義を足し、`EnemyManager.spawnGroup` に分岐を追加、`Game.build` の影の登録にテンプレートを追加。
- **兵科の追加**（ウイングダイバー等）: `Player` の移動部分を兵科ごとのクラスに分けるのが良い。
- **味方 NPC**: 敵 AI と同じく `GameContext` 経由で動かし、敵の標的選択を「プレイヤー or 味方」に一般化する。
- **バンドル削減**: `import { X } from "@babylonjs/core"` を `@babylonjs/core/…/x.js` の個別 import に変えると数 MB 減る（副作用 import が必要なもの＝影・物理・ポストエフェクト等に注意）。

## 11. 作業ルール（このリポジトリでの約束）

- 作業ブランチ: `claude/sharp-cori-gozebu`
- 変更したら README の「更新履歴」に 1 行追加する。
- 調整値はできるだけ `src/data/` に置く（コードを読まない人でも調整できるように）。
- コメントは日本語。
