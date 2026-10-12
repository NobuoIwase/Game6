// ゲーム全体で共有するシステムへの参照。各システムはこのインターフェース経由で連携する。
import type { Scene, TransformNode, Vector3 } from "@babylonjs/core";
import type { City } from "../world/City";
import type { Effects } from "../combat/Effects";
import type { Projectiles } from "../combat/Projectiles";
import type { EnemyManager } from "../enemies/EnemyManager";
import type { Player } from "../entities/Player";
import type { DifficultyDef } from "../data/missions";
import type { QualitySettings } from "./Quality";
import type { CorpseBody } from "./Physics";

export interface ExplosionOpts {
  pos: Vector3;
  radius: number;
  damage: number;
  knockback: number;
  /** 爆発の発生源（プレイヤー由来の爆発は自爆ダメージ＝地球防衛軍風） */
  source: "player" | "enemy";
  buildingDamage?: number;
}

export interface GameContext {
  scene: Scene;
  city: City;
  effects: Effects;
  projectiles: Projectiles;
  enemies: EnemyManager;
  player: Player;
  difficulty: DifficultyDef;
  quality: QualitySettings;
  time: number;
  explode(opts: ExplosionOpts): void;
  /** ラグドール（死体）を登録。寿命管理と後片付けはゲーム側が行う */
  addCorpse(r: CorpseBody, nodes: TransformNode[]): void;
  dropItem(pos: Vector3): void;
  /** 線分と死骸の交差距離（死骸が敵弾・味方弾の壁になる） */
  corpseSegment(a: Vector3, b: Vector3): number | null;
  /** t 秒後に fn を実行（ゲーム内時間） */
  later(t: number, fn: () => void): void;
}
