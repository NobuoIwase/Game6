// ============================================================================
// AI による自動テストプレイ
// ----------------------------------------------------------------------------
// ヘッドレスの Chromium でゲームを起動し、src/core/Bot.ts の自動操縦でミッションを
// 最後まで遊ばせて、結果（クリア/失敗・時間・撃破数・被ダメージの内訳）を集計する。
// 描画はせずロジックだけを高速に進めるので、GPU のない環境でも数分で終わる。
//
//   npm run autoplay                       … NORMAL を 3 回
//   npm run autoplay -- --difficulty easy --runs 5
//   npm run autoplay -- --aim 0.03 --turn 3  … 下手なプレイヤーを想定
//   npm run autoplay -- --json out.json    … 結果を JSON で保存
//
// ブラウザ: 環境変数 CHROMIUM_PATH、なければ /opt/pw-browsers/chromium、
// それもなければ playwright-core の既定（npx playwright install chromium で入る）。
// ============================================================================
import { chromium } from "playwright-core";
import { createServer } from "vite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(" ")
    .split("--")
    .filter(Boolean)
    .map((a) => {
      const [k, ...v] = a.trim().split(/\s+/);
      return [k, v.join(" ") || "true"];
    }),
);
const runs = +(args.runs ?? 3);
const difficulty = args.difficulty ?? "normal";
const limit = +(args.limit ?? 900); // 1 回のプレイの上限（ゲーム内の秒）
const botOpts = { aimError: args.aim ? +args.aim : undefined, turnRate: args.turn ? +args.turn : undefined };

const exe = process.env.CHROMIUM_PATH || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const server = await createServer({ root, logLevel: "error", server: { port: 0, host: "127.0.0.1", hmr: false, watch: { ignored: ["**/*"] } } }); // 編集中でもページが再読み込みされないように
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  executablePath: exe,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--mute-audio"],
});

const results = [];
for (let i = 0; i < runs; i++) {
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector("#startBtn");
  await page.selectOption("#difficulty", difficulty);
  await page.selectOption("#quality", "low");
  await page.click("#startBtn");
  await page.waitForFunction(() => document.getElementById("loading")?.classList.contains("hidden"), null, { timeout: 300000 });
  const r = await page.evaluate(
    async ({ limit, botOpts }) => {
      const g = window.__game();
      const bot = g.startBot(botOpts);
      const timeline = [];
      while (g.mission.result === "playing" && g.mission.elapsed < limit) {
        g.simulate(5);
        timeline.push({ t: Math.round(g.mission.elapsed), armor: Math.round(g.player.armor), enemies: g.enemies.aliveCount, kills: g.mission.kills });
        await new Promise((res) => setTimeout(res, 0));
      }
      const p = g.player;
      return {
        result: g.mission.result,
        time: Math.round(g.mission.elapsed),
        kills: g.mission.kills,
        armor: Math.round(p.armor),
        maxArmor: Math.round(p.maxArmor),
        enemiesLeft: g.enemies.aliveCount,
        left: g.enemies.list.filter((e) => e.alive).reduce((m, e) => ((m[e.kind + (e.active ? "" : "(待機)")] = (m[e.kind + (e.active ? "" : "(待機)")] ?? 0) + 1), m), {}),
        damage: Object.fromEntries(Object.entries(p.damageLog).map(([k, v]) => [k, Math.round(v)])),
        bot: bot.stats,
        timeline,
      };
    },
    { limit, botOpts },
  );
  r.errors = errors;
  results.push(r);
  const dmg = Object.entries(r.damage)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  console.log(
    `#${i + 1} ${r.result.toUpperCase().padEnd(7)} ${String(r.time).padStart(4)}s  撃破 ${r.kills}  残り敵 ${r.enemiesLeft}${r.enemiesLeft ? " " + JSON.stringify(r.left) : ""}  アーマー ${r.armor}/${r.maxArmor}  被ダメージ: ${dmg || "なし"}${errors.length ? "  エラー " + errors.length + "件: " + errors[0] : ""}`,
  );
  await page.close();
}

const clears = results.filter((r) => r.result === "clear").length;
console.log(`\n難易度 ${difficulty.toUpperCase()}: ${runs} 回中 ${clears} 回クリア（クリア率 ${Math.round((clears / runs) * 100)}%）`);
if (args.json) fs.writeFileSync(path.resolve(root, args.json), JSON.stringify({ difficulty, botOpts, results }, null, 2));
await browser.close();
await server.close();
