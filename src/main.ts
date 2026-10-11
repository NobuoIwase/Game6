// ============================================================================
// エントリーポイント: エンジン生成、タイトル / 出撃準備画面、ミッションの開始と終了。
// ============================================================================
import { Engine } from "@babylonjs/core";
import { Input } from "./core/Input";
import { isTouchDevice, resolveQuality } from "./core/Quality";
import { Game } from "./core/Game";
import { Hud } from "./ui/Hud";
import { DIFFICULTIES, MISSIONS } from "./data/missions";
import { DEFAULT_LOADOUT, WEAPONS } from "./data/weapons";
import { sfx } from "./core/Audio";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("renderCanvas");
const touch = isTouchDevice();
if (touch) document.body.classList.add("touch");

const engine = new Engine(canvas, true, { stencil: true, preserveDrawingBuffer: false, powerPreference: "high-performance" }, true);
window.addEventListener("resize", () => engine.resize());

const input = new Input(canvas, touch);
const hud = new Hud();
let game: Game | null = null;

// 設定の保存（ブラウザごと）
const SAVE_KEY = "edf-test-settings";
function loadSettings(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SAVE_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function saveSettings(s: Record<string, string>) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(s));
  } catch {
    /* 保存できない環境でも動作は続ける */
  }
}

// ---------------------------------------------------------------- タイトル画面
const mission = MISSIONS[0];
function setupTitle() {
  const s = loadSettings();
  $("missionName").textContent = mission.name;
  $("missionDesc").textContent = mission.desc;
  for (const [i, id] of (["weapon1", "weapon2"] as const).entries()) {
    const sel = $<HTMLSelectElement>(id);
    sel.innerHTML = WEAPONS.map((w) => `<option value="${w.id}">${w.name}</option>`).join("");
    sel.value = s[id] && WEAPONS.some((w) => w.id === s[id]) ? s[id] : DEFAULT_LOADOUT[i];
  }
  const diff = $<HTMLSelectElement>("difficulty");
  diff.innerHTML = DIFFICULTIES.map((d) => `<option value="${d.id}">${d.name}</option>`).join("");
  diff.value = s.difficulty ?? "normal";
  $<HTMLSelectElement>("quality").value = s.quality ?? "auto";
  $("controlsHelp").textContent = touch
    ? "【操作】左側ドラッグ: 移動 / 右側ドラッグ: 視点\n射撃ボタン長押し（押したままドラッグで照準）/ ズーム / リロード / 武器切替 / ジャンプ / 回避"
    : "【操作】WASD: 移動 / マウス: 視点 / 左クリック: 射撃 / 右クリック: ズーム\nR: リロード / Q・E・ホイール・1・2: 武器切替 / Space: ジャンプ / Shift: 緊急回避 / Esc: ポーズ\nミサイルランチャーは構えるだけで画面中央の敵を自動ロックオン";
}

function show(id: string, on: boolean) {
  $(id).classList.toggle("hidden", !on);
}

async function startMission() {
  sfx.unlock();
  const w1 = $<HTMLSelectElement>("weapon1").value;
  const w2 = $<HTMLSelectElement>("weapon2").value;
  const diffId = $<HTMLSelectElement>("difficulty").value;
  const qualityChoice = $<HTMLSelectElement>("quality").value;
  saveSettings({ weapon1: w1, weapon2: w2, difficulty: diffId, quality: qualityChoice });
  const difficulty = DIFFICULTIES.find((d) => d.id === diffId) ?? DIFFICULTIES[1];
  const quality = resolveQuality(qualityChoice);

  show("title", false);
  show("result", false);
  show("loading", true);
  hud.clearRadio();
  if (game) {
    game.dispose();
    game = null;
  }
  if (touch) {
    // スマホでは全画面・横向きを試みる（失敗しても続行）
    try {
      await document.documentElement.requestFullscreen?.();
      await (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.("landscape");
    } catch {
      /* 非対応ブラウザ */
    }
  }
  try {
    game = await Game.create(engine, {
      mission,
      loadout: [w1, w2],
      difficulty,
      quality,
      input,
      hud,
      onProgress: (r, t) => {
        $("loadfill").style.width = `${Math.round(r * 100)}%`;
        $("loadtext").textContent = t;
      },
    });
  } catch (e) {
    console.error(e);
    $("loadtext").textContent = "読み込みに失敗しました: " + (e as Error).message;
    return;
  }
  show("loading", false);
  hud.show(true);
  show("touch", touch);
  input.reset();
  input.enabled = true;
  input.requestLock();
  game.onEnd = (result, m) => {
    input.enabled = false;
    document.exitPointerLock?.();
    show("touch", false);
    hud.show(false);
    $("resultTitle").textContent = result === "clear" ? "MISSION CLEAR" : "MISSION FAILED";
    const t = Math.round(m.elapsed);
    $("resultText").textContent = `${mission.name}\n経過時間 ${Math.floor(t / 60)}分${t % 60}秒\n最終アーマー ${Math.round(game!.player.maxArmor)}`;
    show("result", true);
  };
}

engine.runRenderLoop(() => {
  if (game) game.frame();
});

$("startBtn").addEventListener("click", () => void startMission());
$("retryBtn").addEventListener("click", () => void startMission());
$("toTitleBtn").addEventListener("click", () => {
  show("result", false);
  show("title", true);
});
$("resumeBtn").addEventListener("click", () => game?.setPaused(false));
$("retireBtn").addEventListener("click", () => {
  game?.setPaused(false);
  input.enabled = false;
  document.exitPointerLock?.();
  game?.dispose();
  game = null;
  hud.show(false);
  show("touch", false);
  show("pause", false);
  show("title", true);
});
// ポインタロックが外れたら（Esc）ポーズ
document.addEventListener("pointerlockchange", () => {
  if (!touch && game && !game.paused && input.enabled && document.pointerLockElement !== canvas) game.setPaused(true);
});

setupTitle();
show("loading", false);
show("title", true);

// デバッグ・自動テスト用
(window as unknown as { __game: () => Game | null }).__game = () => game;
