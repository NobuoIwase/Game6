// ============================================================================
// 武器データ定義
// ----------------------------------------------------------------------------
// 新しい武器を追加するときは WEAPONS にエントリを足すだけでよい。
// 出撃前画面の武器選択リストにも自動で並ぶ。
// 発射の仕組みは `kind` ごとに src/combat/Weapon.ts が処理する。
//   hitscan : 弾が即着弾する（アサルトライフル、ショットガン、スナイパー）
//   rocket  : 直進する弾頭が着弾で爆発（ロケットランチャー、グレネード）
//   homing  : ロックオンした目標を追う誘導弾（ミサイルランチャー）
// ============================================================================

export type WeaponKind = "hitscan" | "rocket" | "homing";
export type WeaponModel = "rifle" | "shotgun" | "sniper" | "launcher";

export interface WeaponDef {
  id: string;
  name: string;
  category: string;
  kind: WeaponKind;
  model: WeaponModel;
  /** 1発あたりのダメージ（爆発系は爆心の最大ダメージ） */
  damage: number;
  /** 1回の射撃で出る弾数（ショットガンの散弾など） */
  pellets: number;
  /** 毎秒の射撃回数 */
  fireRate: number;
  /** 装弾数 */
  magazine: number;
  /** リロード時間（秒） */
  reloadTime: number;
  /** 拡散角（度） */
  spread: number;
  /** 射程（m） */
  range: number;
  /** ズーム倍率（右クリック） */
  zoom: number;
  /** 弾速（m/s）。hitscan では曳光弾の見た目にだけ使う */
  speed: number;
  /** 爆発半径（m）。0 なら爆発しない */
  blastRadius: number;
  /** 爆発で吹き飛ばす力 */
  knockback: number;
  /** 建物へのダメージ倍率 */
  buildingDamage: number;
  /** 反動（カメラの跳ね上がり、ラジアン） */
  recoil: number;
  /** 射撃中にフルオート（押しっぱなし）で撃てるか */
  automatic: boolean;
  // ----- homing 専用 -----
  /** 同時ロックオン数 */
  lockCount?: number;
  /** 1目標をロックするのにかかる時間（秒） */
  lockTime?: number;
  /** ロックオン範囲（画面中央からの角度、度） */
  lockAngle?: number;
  /** 誘導弾の旋回性能（rad/s） */
  turnRate?: number;
  /** 発射音の種類 */
  sound: "rifle" | "shotgun" | "sniper" | "launcher";
  /** 説明文 */
  desc: string;
}

export const WEAPONS: WeaponDef[] = [
  {
    id: "af_t1",
    name: "AF-T1 アサルトライフル",
    category: "アサルトライフル",
    kind: "hitscan",
    model: "rifle",
    damage: 16,
    pellets: 1,
    fireRate: 12,
    magazine: 150,
    reloadTime: 2.0,
    spread: 1.4,
    range: 240,
    zoom: 1.6,
    speed: 600,
    blastRadius: 0,
    knockback: 2,
    buildingDamage: 0.6,
    recoil: 0.004,
    automatic: true,
    sound: "rifle",
    desc: "陸戦兵の標準装備。連射力と弾数に優れ、あらゆる状況に対応できる。",
  },
  {
    id: "ml_t1",
    name: "ML-T1 ミサイルランチャー",
    category: "ミサイルランチャー",
    kind: "homing",
    model: "launcher",
    damage: 180,
    pellets: 1,
    fireRate: 6,
    magazine: 4,
    reloadTime: 4.5,
    spread: 0,
    range: 300,
    zoom: 1.0,
    speed: 70,
    blastRadius: 7,
    knockback: 18,
    buildingDamage: 1,
    recoil: 0.02,
    automatic: false,
    lockCount: 4,
    lockTime: 0.45,
    lockAngle: 14,
    turnRate: 3.2,
    sound: "launcher",
    desc: "構えるだけで画面中央付近の敵を自動ロックオン（最大4体）。発射した誘導弾は目標を追尾する。ロックしていない場合は直進する。",
  },
  // ---------------- 以下、入れ替え用のサンプル武器 ----------------
  {
    id: "sg_t1",
    name: "SG-T1 ショットガン",
    category: "ショットガン",
    kind: "hitscan",
    model: "shotgun",
    damage: 22,
    pellets: 12,
    fireRate: 1.6,
    magazine: 6,
    reloadTime: 2.4,
    spread: 7,
    range: 70,
    zoom: 1.0,
    speed: 500,
    blastRadius: 0,
    knockback: 8,
    buildingDamage: 0.5,
    recoil: 0.05,
    automatic: false,
    sound: "shotgun",
    desc: "近距離で絶大な威力を誇る散弾銃。",
  },
  {
    id: "sr_t1",
    name: "SR-T1 スナイパーライフル",
    category: "スナイパーライフル",
    kind: "hitscan",
    model: "sniper",
    damage: 260,
    pellets: 1,
    fireRate: 1.1,
    magazine: 5,
    reloadTime: 2.8,
    spread: 0.05,
    range: 600,
    zoom: 6,
    speed: 1500,
    blastRadius: 0,
    knockback: 12,
    buildingDamage: 0.8,
    recoil: 0.06,
    automatic: false,
    sound: "sniper",
    desc: "長射程・高威力。右クリックでスコープを覗く。",
  },
  {
    id: "rl_t1",
    name: "RL-T1 ロケットランチャー",
    category: "ロケットランチャー",
    kind: "rocket",
    model: "launcher",
    damage: 320,
    pellets: 1,
    fireRate: 1,
    magazine: 1,
    reloadTime: 2.2,
    spread: 0.3,
    range: 400,
    zoom: 1.4,
    speed: 110,
    blastRadius: 9,
    knockback: 22,
    buildingDamage: 1.5,
    recoil: 0.08,
    automatic: false,
    sound: "launcher",
    desc: "着弾地点で大爆発を起こす。自爆に注意。",
  },
];

export function getWeapon(id: string): WeaponDef {
  const w = WEAPONS.find((w) => w.id === id);
  if (!w) throw new Error(`unknown weapon: ${id}`);
  return w;
}

/** 陸戦兵の初期装備 */
export const DEFAULT_LOADOUT: [string, string] = ["af_t1", "ml_t1"];
