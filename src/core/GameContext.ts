// ゲーム全体で共有するシステムへの参照。各システムはこのインターフェース経由で連携する。
import type { Scene, TransformNode, Vector3 } from "@babylonjs/core";
import type { City } from "../world/City";
import type { Effects } from "../combat/Effects";
import type { Projectiles } from "../combat/Projectiles";
import type { EnemyManager } from "../enemies/EnemyManager";
import type { Player } from "../entities/Player";
import type { DifficultyDef } from "../data/missions";
import type { QualitySettings } from "./Quality";
import type { Ragdoll } from "./Physics";

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
  addCorpse(r: Ragdoll, nodes: TransformNode[]): void;
  dropItem(pos: Vector3): void;
}
