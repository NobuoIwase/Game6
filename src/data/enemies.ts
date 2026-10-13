// ============================================================================
// 敵データ定義
// ----------------------------------------------------------------------------
// 数値調整はここで行う。行動ロジックは src/enemies/ 以下の各クラス。
// ============================================================================

export type EnemyType = "ant" | "spider" | "flyer" | "carrier";

export interface EnemyDef {
  type: EnemyType;
  name: string;
  hp: number;
  /** 移動速度（m/s） */
  speed: number;
  /** 非アクティブ時に、プレイヤーがこの距離まで近づくと起動する（m） */
  detectRange: number;
  /** 起動時に周囲の仲間を巻き込む範囲（m） */
  alertRadius: number;
  /** 攻撃距離（m） */
  attackRange: number;
  /** 攻撃間隔（秒） */
  attackInterval: number;
  /** 攻撃1発のダメージ */
  damage: number;
  /** 当たり判定の大きさ（m） */
  radius: number;
  /** ラグドールの質量の目安（kg） */
  mass: number;
  /** 撃破時にアイテムを落とす確率 */
  dropRate: number;
}

export const ENEMIES: Record<EnemyType, EnemyDef> = {
  carrier: {
    type: "carrier",
    name: "戦艦級（スポーンシップ）",
    hp: 1600,
    speed: 22,
    detectRange: 9999,
    alertRadius: 0,
    attackRange: 0,
    attackInterval: 0,
    damage: 0,
    radius: 16,
    mass: 20000,
    dropRate: 1,
  },
  ant: {
    type: "ant",
    name: "アンカー大型級（甲殻型）",
    hp: 190,
    speed: 11,
    detectRange: 55,
    alertRadius: 45,
    attackRange: 38,
    attackInterval: 2.6,
    damage: 5, // 酸1粒あたり
    radius: 3.4,
    mass: 900,
    dropRate: 0.3,
  },
  spider: {
    type: "spider",
    name: "アンカー大型級（跳躍型）",
    hp: 130,
    speed: 14,
    detectRange: 65,
    alertRadius: 50,
    attackRange: 55,
    attackInterval: 2.2,
    damage: 3, // 糸1本あたり（拘束値も蓄積）
    radius: 3.2,
    mass: 700,
    dropRate: 0.3,
  },
  flyer: {
    type: "flyer",
    name: "アンカー飛行型",
    hp: 90,
    speed: 17,
    detectRange: 90,
    alertRadius: 80,
    attackRange: 120,
    attackInterval: 0.18,
    damage: 7, // 機銃1発 / 爆弾は別
    radius: 2.6,
    mass: 400,
    dropRate: 0.35,
  },
};

/** 爆撃機（飛行型）の爆弾ダメージ */
export const FLYER_BOMB_DAMAGE = 40;
export const FLYER_BOMB_RADIUS = 7;
