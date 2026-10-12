// 画質設定。スマートフォンでは自動的に「低」になる。
export type QualityLevel = "low" | "medium" | "high";

export interface QualitySettings {
  level: QualityLevel;
  /** 解像度の縮小率（1 = ネイティブ。大きいほど荒く軽い） */
  hardwareScaling: number;
  shadows: "none" | "simple" | "cascaded";
  shadowMapSize: number;
  ssao: boolean;
  bloom: boolean;
  /** 同時に物理演算するラグドールの上限 */
  maxRagdolls: number;
  /** ポストエフェクト（ブルーム・SSAO・フィルムグレイン等）を使うか。使わない場合は MSAA で軽く描く */
  postProcess: boolean;
  /** 敵出現数の倍率 */
  enemyScale: number;
  /** パーティクル量の倍率 */
  particleScale: number;
  /** 描画距離 */
  viewDistance: number;
}

export function isTouchDevice(): boolean {
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

export function isMobile(): boolean {
  const ua = navigator.userAgent;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (isTouchDevice() && Math.min(screen.width, screen.height) < 900);
}

export function resolveQuality(choice: string): QualitySettings {
  const level: QualityLevel =
    choice === "low" || choice === "medium" || choice === "high" ? choice : isMobile() ? "low" : "medium";
  const dpr = window.devicePixelRatio || 1;
  switch (level) {
    case "low":
      return {
        level,
        // スマホは高 DPI なので、ある程度の解像度を確保しつつ負荷を抑える
        hardwareScaling: Math.max(1, dpr / 1.75),
        shadows: "simple",
        shadowMapSize: 1024,
        ssao: false,
        bloom: false,
        postProcess: false,
        maxRagdolls: 12,
        enemyScale: 0.6,
        particleScale: 0.5,
        viewDistance: 450,
      };
    case "medium":
      return {
        level,
        hardwareScaling: Math.max(1, dpr / 2),
        shadows: "simple",
        shadowMapSize: 2048,
        ssao: false,
        bloom: false,
        postProcess: false,
        maxRagdolls: 30,
        enemyScale: 0.85,
        particleScale: 0.8,
        viewDistance: 700,
      };
    default:
      return {
        level,
        hardwareScaling: 1 / Math.min(dpr, 1.5),
        shadows: "cascaded",
        shadowMapSize: 2048,
        ssao: true,
        bloom: true,
        postProcess: true,
        maxRagdolls: 45,
        enemyScale: 1,
        particleScale: 1,
        viewDistance: 900,
      };
  }
}
