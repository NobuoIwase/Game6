// ============================================================================
// ミッション定義
// ----------------------------------------------------------------------------
// ウェーブ（出現グループ）の発生条件と無線メッセージを並べる。
// 座標はマップ中心 (0,0) からの x,z（m）。プレイヤーは playerStart に出現。
// マップの広さは src/world/City.ts の CITY_HALF（±m）を参照。
// ============================================================================
import type { EnemyType } from "./enemies";

export interface RadioLine {
  who: string;
  text: string;
  /** 前の行からの遅延（秒） */
  delay?: number;
}

export interface SpawnGroup {
  type: EnemyType;
  count: number;
  at: [number, number];
  /** 出現位置のばらつき半径（m） */
  spread: number;
  /** true なら出現と同時にアクティブ（増援など） */
  active?: boolean;
  /** 飛行型の編隊形状 */
  formation?: "v" | "line" | "wedge";
}

export type WaveTrigger =
  | { kind: "start" }
  /** 残り敵数がこの数以下になったら */
  | { kind: "remaining"; count: number }
  /** 前のウェーブ発生から t 秒経過 */
  | { kind: "time"; t: number };

/** ウェーブ発生時の特殊演出。"colossus" = 超巨大生物がビルの陰から覗く */
export type WaveEvent = "colossus";

export interface WaveDef {
  trigger: WaveTrigger;
  groups: SpawnGroup[];
  radio: RadioLine[];
  events?: WaveEvent[];
}

export interface MissionDef {
  id: string;
  name: string;
  desc: string;
  playerStart: [number, number];
  waves: WaveDef[];
  clearRadio: RadioLine[];
  failRadio: RadioLine[];
}

export interface DifficultyDef {
  id: string;
  name: string;
  enemyHp: number;
  enemyDamage: number;
  playerArmor: number;
}

export const DIFFICULTIES: DifficultyDef[] = [
  { id: "easy", name: "EASY", enemyHp: 0.7, enemyDamage: 0.6, playerArmor: 800 },
  { id: "normal", name: "NORMAL", enemyHp: 1.0, enemyDamage: 1.0, playerArmor: 600 },
  { id: "hard", name: "HARD", enemyHp: 1.6, enemyDamage: 1.6, playerArmor: 600 },
  { id: "inferno", name: "INFERNO", enemyHp: 3.0, enemyDamage: 3.2, playerArmor: 600 },
];

const HQ = "本部";
const CAP = "隊長";
const OP = "オペレーター";

export const MISSIONS: MissionDef[] = [
  {
    id: "m01",
    name: "ミッション1：市街地の異変",
    desc:
      "市街地に巨大生物が出現した。\n" +
      "蟻型・蜘蛛型の巨大生物に加え、編隊を組んで飛行する侵略兵器が確認されている。\n" +
      "待機中の敵は攻撃するか接近すると一斉に襲ってくる。各個撃破せよ。",
    playerStart: [0, 6],
    waves: [
      {
        trigger: { kind: "start" },
        groups: [
          { type: "ant", count: 10, at: [-70, -95], spread: 22 },
          { type: "ant", count: 8, at: [95, -40], spread: 20 },
          { type: "spider", count: 6, at: [-110, 70], spread: 20 },
          { type: "flyer", count: 7, at: [60, 110], spread: 10, formation: "v" },
        ],
        radio: [
          { who: OP, text: "作戦地域に到着。市街地に巨大生物の群れを確認しました。" },
          { who: HQ, text: "敵はまだこちらに気付いていない。攻撃を開始すれば一斉に襲ってくるぞ。", delay: 3.5 },
          { who: HQ, text: "陸戦兵、慎重に各個撃破せよ。", delay: 3.5 },
        ],
      },
      {
        trigger: { kind: "remaining", count: 8 },
        groups: [
          { type: "ant", count: 14, at: [0, -190], spread: 30, active: true },
          { type: "flyer", count: 6, at: [-180, 0], spread: 10, active: true, formation: "wedge" },
        ],
        radio: [
          { who: OP, text: "南方より巨大生物の増援！ 数が多い！" },
          { who: OP, text: "西の空に飛行物体、編隊を組んで接近中！", delay: 3 },
          { who: CAP, text: "うろたえるな！ 迎え撃て！", delay: 2.5 },
          { who: OP, text: "……待ってください。ビルの陰に、とてつもなく大きな反応が……！", delay: 4 },
          { who: HQ, text: "なんだ、あれは……。こちらを、見ているのか……？", delay: 5 },
        ],
        events: ["colossus"],
      },
      {
        trigger: { kind: "remaining", count: 6 },
        groups: [
          { type: "spider", count: 10, at: [170, 120], spread: 28, active: true },
          { type: "ant", count: 10, at: [-170, -150], spread: 25, active: true },
          { type: "flyer", count: 7, at: [180, -180], spread: 10, active: true, formation: "line" },
          { type: "carrier", count: 1, at: [-60, -110], spread: 0, active: true },
        ],
        radio: [
          { who: OP, text: "新たな敵影！ 蜘蛛型が北東から接近中！" },
          { who: HQ, text: "これが最後の群れだ。ここで食い止めろ！", delay: 3 },
          { who: OP, text: "蜘蛛型の糸に注意してください。絡まると身動きが取れなくなります！", delay: 3 },
        ],
      },
    ],
    clearRadio: [
      { who: OP, text: "作戦地域の敵、全滅を確認しました。" },
      { who: HQ, text: "よくやった。EDF！ EDF！", delay: 2.5 },
    ],
    failRadio: [{ who: OP, text: "陸戦兵の反応が消失……。作戦失敗です。" }],
  },
];
