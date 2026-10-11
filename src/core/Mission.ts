// ============================================================================
// ミッション進行: ウェーブの出現条件・無線・クリア/失敗判定。
// ============================================================================
import type { MissionDef } from "../data/missions";
import type { EnemyManager } from "../enemies/EnemyManager";
import type { Hud } from "../ui/Hud";

export class Mission {
  private waveIndex = 0;
  private sinceWave = 0;
  result: "playing" | "clear" | "failed" = "playing";
  elapsed = 0;
  kills = 0;

  constructor(
    readonly def: MissionDef,
    private enemies: EnemyManager,
    private hud: Hud,
    private enemyScale: number,
  ) {}

  get wavesLeft() {
    return this.def.waves.length - this.waveIndex;
  }

  update(dt: number, playerAlive: boolean) {
    if (this.result !== "playing") return;
    this.elapsed += dt;
    this.sinceWave += dt;
    const next = this.def.waves[this.waveIndex];
    if (next) {
      const tr = next.trigger;
      const remaining = this.enemies.aliveCount;
      const fire =
        tr.kind === "start" ||
        (tr.kind === "remaining" && remaining <= Math.ceil(tr.count * this.enemyScale)) ||
        (tr.kind === "time" && this.sinceWave >= tr.t);
      if (fire) {
        for (const g of next.groups) this.enemies.spawnGroup(g, this.enemyScale);
        this.hud.radio(next.radio);
        this.waveIndex++;
        this.sinceWave = 0;
      }
    } else if (this.enemies.aliveCount === 0) {
      this.result = "clear";
      this.hud.radio(this.def.clearRadio);
    }
    if (!playerAlive && this.result === "playing") {
      this.result = "failed";
      this.hud.radio(this.def.failRadio);
    }
  }
}
