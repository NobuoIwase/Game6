// ============================================================================
// ゲーム本体。1ミッション = 1つの Game（Scene）。
// 描画・物理・各システムの生成と、毎フレームの更新順序を管理する。
// ============================================================================
import {
  AbstractEngine,
  CascadedShadowGenerator,
  Color3,
  Color4,
  DefaultRenderingPipeline,
  DirectionalLight,
  EquiRectangularCubeTexture,
  HDRCubeTexture,
  ImageProcessingConfiguration,
  Mesh,
  MeshBuilder,
  PhotoDome,
  SSAO2RenderingPipeline,
  Scene,
  ShadowGenerator,
  TransformNode,
  UniversalCamera,
  Vector3,
} from "@babylonjs/core";
import type { GameContext, ExplosionOpts } from "./GameContext";
import type { QualitySettings } from "./Quality";
import type { Input } from "./Input";
import type { DifficultyDef, MissionDef } from "../data/missions";
import type { WeaponDef } from "../data/weapons";
import { corpseBodyOf, CorpseBody, enableHavok, Ragdoll, RigPart } from "./Physics";
import { buildNationStake } from "../world/Stake";
import { City } from "../world/City";
import { createCityMaterials } from "../world/Materials";
import { Effects } from "../combat/Effects";
import { Projectiles } from "../combat/Projectiles";
import { EnemyManager } from "../enemies/EnemyManager";
import { Player } from "../entities/Player";
import { Hud } from "../ui/Hud";
import { Mission } from "./Mission";
import { Pickups } from "../world/Pickups";
import { CombatContext } from "../combat/Weapon";
import type { Enemy } from "../enemies/Enemy";
import { antTemplateMeshes } from "../enemies/Ant";
import { spiderTemplateMeshes } from "../enemies/Spider";
import { flyerTemplateMeshes } from "../enemies/Flyer";
import { Colossus, colossusTemplateMeshes } from "../enemies/Colossus";
import { carrierTemplateMeshes } from "../enemies/Carrier";
import { clamp, damp, rand, raySphere } from "./MathUtil";
import { sfx } from "./Audio";

/** プレイヤー自身の爆発で受けるダメージの割合（地球防衛軍では自爆あり） */
export const SELF_DAMAGE_RATE = 0.5;
/** 死体（ラグドール）が物理演算される秒数 */
const CORPSE_LIFE = 15;

interface Corpse {
  ragdoll: CorpseBody;
  nodes: TransformNode[];
  age: number;
  sinking: number; // >=0 なら沈下中
  /** 当たり判定の大まかな半径 */
  radius: number;
  /** 生成直後の速さの上限（重なりの押し出しで吹き飛びすぎないように） */
  maxSpeed: number;
}

export interface GameOptions {
  mission: MissionDef;
  loadout: [string, string];
  difficulty: DifficultyDef;
  quality: QualitySettings;
  input: Input;
  hud: Hud;
  onProgress?: (ratio: number, text: string) => void;
}

export class Game implements GameContext {
  scene!: Scene;
  city!: City;
  effects!: Effects;
  projectiles!: Projectiles;
  enemies!: EnemyManager;
  player!: Player;
  difficulty: DifficultyDef;
  quality: QualitySettings;
  time = 0;
  mission!: Mission;
  pickups!: Pickups;
  camera!: UniversalCamera;
  private sun!: DirectionalLight;
  private shadowGen: ShadowGenerator | null = null;
  private corpses: Corpse[] = [];
  private timers: { t: number; fn: () => void }[] = [];
  colossus: Colossus | null = null;
  private camYaw = 0;
  private camPitch = 0.1;
  private camDist = 3.6;
  private camRecoil = 0;
  private fovBase = 0.95;
  private aimO = new Vector3();
  private aimD = new Vector3(0, 0, 1);
  private combat!: CombatContext;
  private endTimer = -1;
  paused = false;
  /** デバッグ用: 設定するとカメラをこの位置・注視点に固定する */
  debugCam: { pos: Vector3; target: Vector3 } | null = null;
  onEnd?: (result: "clear" | "failed", mission: Mission) => void;

  private constructor(
    private engine: AbstractEngine,
    private opts: GameOptions,
  ) {
    this.difficulty = opts.difficulty;
    this.quality = opts.quality;
  }

  static async create(engine: AbstractEngine, opts: GameOptions): Promise<Game> {
    const g = new Game(engine, opts);
    await g.build();
    return g;
  }

  private progress(r: number, t: string) {
    this.opts.onProgress?.(r, t);
  }

  private async build() {
    const q = this.quality;
    const engine = this.engine;
    engine.setHardwareScalingLevel(q.hardwareScaling);
    const scene = new Scene(engine);
    this.scene = scene;
    scene.skipPointerMovePicking = true;
    scene.clearColor = new Color4(0.72, 0.78, 0.86, 1);
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogDensity = q.level === "low" ? 0.0034 : 0.0017;
    scene.fogColor = new Color3(0.7, 0.76, 0.84);

    this.progress(0.1, "物理エンジンを初期化中...");
    await enableHavok(scene);

    // ---- カメラ ----
    const cam = new UniversalCamera("cam", new Vector3(0, 3, -6), scene);
    cam.inputs.clear();
    cam.minZ = 0.1;
    // 遠くは霧に溶けるので、描画距離を画質に合わせて切る（遠景の描画を省いて軽くする）
    cam.maxZ = q.level === "low" ? 520 : q.level === "medium" ? 950 : 3200;
    cam.fov = this.fovBase;
    this.camera = cam;

    // ---- 光源・空 ----
    this.progress(0.2, "空と光源を準備中...");
    // HDR が読めない環境（.hdr を配信できないホスティング等）では空の JPG で代用する
    const env = new HDRCubeTexture("assets/hdri/sky_1k.hdr", scene, 256, false, true, false, true, null, () => {
      console.warn("HDR 環境マップを読み込めないため、空の JPG で代用します");
      scene.environmentTexture = new EquiRectangularCubeTexture("assets/hdri/sky_4k.jpg", scene, 256);
      env.dispose();
    });
    scene.environmentTexture = env;
    scene.environmentIntensity = 0.85;
    const domeSize = Math.min(2800, cam.maxZ * 1.8);
    const dome = new PhotoDome("sky", "assets/hdri/sky_4k.jpg", { resolution: 48, size: domeSize }, scene);
    dome.mesh.applyFog = false;
    dome.mesh.infiniteDistance = true;
    dome.mesh.isPickable = false;
    // 遠景: 地面に突き刺さった国家級アンカー（空のドームの内側に置く）
    buildNationStake(scene, Math.min(domeSize / 2, cam.maxZ) * 0.8, scene.fogColor);

    const sun = new DirectionalLight("sun", new Vector3(-0.42, -0.78, 0.46).normalize(), scene);
    sun.intensity = 3.2;
    sun.diffuse = new Color3(1, 0.95, 0.88);
    sun.position = new Vector3(100, 200, -100);
    this.sun = sun;

    // ---- 街 ----
    this.progress(0.35, "市街地を生成中...");
    const mats = await createCityMaterials(scene);
    this.city = new City(scene, mats);
    this.city.build();
    this.city.onCollapseStart = (b) => {
      // 建物が爆発して崩れ落ちる（見た目だけの爆発を時間差で連続させる）
      const center = new Vector3(b.cx, b.height / 2, b.cz);
      const n = this.quality.level === "low" ? 3 : 6;
      for (let i = 0; i < n; i++) {
        const p = new Vector3(b.cx + rand(-b.hw, b.hw), rand(0.2, 1) * b.height, b.cz + rand(-b.hd, b.hd));
        this.later(i * 0.18, () => {
          this.effects.explosion(p, Math.min(14, 5 + Math.max(b.hw, b.hd) * 0.4), false);
          sfx.explosion(p, 1.2);
        });
      }
      this.effects.collapseDust(b.cx, b.cz, b.hw, b.hd, 1.5);
      this.effects.addShake(Math.max(0, 0.6 - Vector3.Distance(this.player.position, center) / 250));
      sfx.collapse(center);
      this.spawnDebris(b.cx, b.height * 0.6, b.cz, Math.max(b.hw, b.hd));
    };
    this.city.onCollapseEnd = (b) => this.effects.collapseDust(b.cx, b.cz, b.hw, b.hd, 0.8);

    // ---- システム ----
    this.progress(0.6, "部隊を展開中...");
    this.effects = new Effects(scene, q.particleScale);
    this.projectiles = new Projectiles(this);
    this.enemies = new EnemyManager(this);
    const start = new Vector3(this.opts.mission.playerStart[0], 0.12, this.opts.mission.playerStart[1]);
    this.player = new Player(this, this.opts.loadout, this.difficulty.playerArmor, start);
    this.camYaw = Math.PI; // 最初は北（-Z）を向く
    this.pickups = new Pickups(scene, (x, z, y) => this.city.heightAt(x, z, y));
    this.pickups.onPickup = (k) => this.opts.hud.status(k === "armor" ? "アーマー強化" : "アーマー回復", 1.2);
    this.mission = new Mission(this.opts.mission, this.enemies, this.opts.hud, q.enemyScale);
    this.mission.onEvent = (name) => {
      if (name === "colossus") this.later(9, () => this.spawnColossus());
    };
    this.enemies.onCarrier = () =>
      this.opts.hud.radio([
        { who: "オペレーター", text: "上空に戦艦級！ とげのあいだに飛行型を抱えています！" },
        { who: "本部", text: "あれも生き物だ。外殻は硬いが、上下の呼吸孔が開いた瞬間を狙え！", delay: 3.5 },
      ]);
    let hatchMsg = 0;
    this.enemies.carrierOpened = () => {
      if (hatchMsg++ < 2) this.opts.hud.radio([{ who: "隊長", text: "呼吸孔が開いたぞ！ 撃て！" }]);
    };
    this.enemies.onFirstAlert = () => this.opts.hud.radio([{ who: "本部", text: "敵が動き出したぞ！ 迎撃せよ！" }]);
    this.combat = this.makeCombatContext();

    // ---- 影 ----
    this.progress(0.75, "影とポストエフェクトを準備中...");
    this.setupShadows([
      ...this.city.shadowCasters,
      ...this.player.soldier.meshes,
      ...antTemplateMeshes(scene),
      ...spiderTemplateMeshes(scene),
      ...flyerTemplateMeshes(scene),
      ...colossusTemplateMeshes(scene),
      ...carrierTemplateMeshes(scene),
    ]);
    this.setupPostProcess();

    this.progress(0.9, "シェーダーをコンパイル中...");
    await scene.whenReadyAsync();
    this.progress(1, "出撃準備完了");
  }

  private setupShadows(casters: Mesh[]) {
    const q = this.quality;
    if (q.shadows === "none") return;
    let gen: ShadowGenerator;
    if (q.shadows === "cascaded") {
      const csm = new CascadedShadowGenerator(q.shadowMapSize, this.sun);
      csm.numCascades = q.level === "high" ? 4 : 3;
      csm.lambda = 0.88;
      csm.shadowMaxZ = q.level === "high" ? 320 : 200;
      csm.stabilizeCascades = true;
      csm.bias = 0.004;
      csm.normalBias = 0.02;
      csm.usePercentageCloserFiltering = true;
      csm.filteringQuality = q.level === "high" ? ShadowGenerator.QUALITY_MEDIUM : ShadowGenerator.QUALITY_LOW;
      gen = csm;
    } else {
      gen = new ShadowGenerator(q.shadowMapSize, this.sun);
      gen.usePercentageCloserFiltering = true;
      gen.filteringQuality = ShadowGenerator.QUALITY_LOW;
      gen.bias = 0.002;
      this.sun.autoUpdateExtends = false;
      this.sun.shadowFrustumSize = 110;
      this.sun.shadowMinZ = 1;
      this.sun.shadowMaxZ = 600;
    }
    for (const m of casters) gen.addShadowCaster(m, false);
    this.shadowGen = gen;
    // 建物の影は近くのものだけ描く（描画回数の削減）。小物・敵は常に描く
    const bset = new Set(this.city.buildings.flatMap((b) => b.root.getChildMeshes()));
    this.nearCasters = casters.filter((m) => bset.has(m as Mesh));
    this.alwaysCasters = casters.filter((m) => !bset.has(m as Mesh));
    this.refreshShadowCasters();
    if (q.level === "low") gen.getShadowMap()!.refreshRate = 2; // スマホは影を1フレームおきに更新
  }

  private nearCasters: Mesh[] = [];
  private alwaysCasters: Mesh[] = [];
  private casterT = 0;

  private refreshShadowCasters() {
    const sm = this.shadowGen?.getShadowMap();
    if (!sm) return;
    const p = this.player?.position ?? Vector3.Zero();
    const r = this.quality.level === "high" ? 260 : 150;
    const list = [...this.alwaysCasters];
    for (const m of this.nearCasters) {
      if (m.isDisposed()) continue;
      const c = m.getBoundingInfo().boundingSphere.centerWorld;
      if (Math.hypot(c.x - p.x, c.z - p.z) < r + m.getBoundingInfo().boundingSphere.radiusWorld) list.push(m);
    }
    sm.renderList = list;
  }

  private setupPostProcess() {
    const q = this.quality;
    const scene = this.scene;
    if (!q.postProcess) {
      // 軽量モード: ポストエフェクトなし。色調整だけマテリアル側で行う（ほぼ負荷なし）
      const ip = scene.imageProcessingConfiguration;
      ip.toneMappingEnabled = true;
      ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
      ip.exposure = 1.05;
      ip.contrast = 1.1;
      return;
    }
    const p = new DefaultRenderingPipeline("post", true, scene, [this.camera]);
    p.fxaaEnabled = true;
    p.imageProcessingEnabled = true;
    p.imageProcessing.toneMappingEnabled = true;
    p.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    p.imageProcessing.exposure = 1.05;
    p.imageProcessing.contrast = 1.12;
    p.imageProcessing.vignetteEnabled = true;
    p.imageProcessing.vignetteWeight = 1.6;
    p.imageProcessing.vignetteColor = new Color4(0, 0, 0, 0);
    p.bloomEnabled = q.bloom;
    p.bloomThreshold = 0.95;
    p.bloomWeight = 0.3;
    p.bloomKernel = 64;
    p.bloomScale = 0.5;
    {
      p.grainEnabled = true;
      p.grain.intensity = 5;
      p.grain.animated = true;
      p.sharpenEnabled = true;
      p.sharpen.edgeAmount = 0.2;
    }
    if (q.ssao) {
      const ssao = new SSAO2RenderingPipeline("ssao", scene, { ssaoRatio: 0.5, blurRatio: 0.5 }, [this.camera]);
      ssao.radius = 1.8;
      ssao.totalStrength = 1.1;
      ssao.samples = 12;
      ssao.maxZ = 250;
      ssao.expensiveBlur = false;
    }
  }

  // ------------------------------------------------------------------ 戦闘コンテキスト
  private makeCombatContext(): CombatContext {
    return {
      muzzle: () => this.player.muzzle(),
      aimOrigin: () => this.aimO,
      aimDir: () => this.aimD,
      hitscan: (origin, dir, range, def) => this.hitscan(origin, dir, range, def),
      launch: (origin, dir, def, target) => this.projectiles.launch(origin, dir, def, target),
      lockCandidates: (def) => this.lockCandidates(def),
      onFire: (def) => {
        sfx.shot(def.sound);
        const m = this.player.muzzle();
        const dir = this.aimD;
        this.effects.muzzleFlash(m, dir);
        this.camRecoil += def.recoil;
        if (def.kind !== "hitscan" || def.pellets > 1) this.effects.addShake(0.08);
      },
    };
  }

  private hitscan(origin: Vector3, dir: Vector3, range: number, def: WeaponDef): Vector3 {
    const wh = this.city.raycast(origin, dir, range);
    let maxD = wh ? wh.dist : range;
    // 死骸も弾を止める（撃たれた死骸は吹き飛ぶ）
    const ch = this.corpseRay(origin, dir, maxD);
    if (ch) maxD = ch.dist;
    const eh = this.enemies.raycast(origin, dir, maxD);
    let end: Vector3;
    if (eh) {
      const dmg = def.damage * eh.mult;
      const before = eh.enemy.hp;
      eh.enemy.damage(dmg, dir, eh.point, def.knockback);
      const dealt = before - Math.max(0, eh.enemy.hp);
      this.effects.hitEnemy(eh.point, dir, eh.enemy.kind, Math.min(3, 0.6 + def.damage / 40));
      this.opts.hud.hitMarker();
      // 装甲で弾かれた（ほぼ効いていない）ときは数字を出さない
      if (dealt >= 0.5) this.opts.hud.damage(eh.point, dealt, eh.mult > 1.2 ? "big" : eh.mult < 1 ? "weak" : "normal");
      sfx.hit(def.damage > 60, eh.enemy.kind === "flyer" || eh.enemy.kind === "carrier");
      end = eh.point;
    } else if (ch) {
      this.effects.impact(ch.point, dir.scale(-1));
      ch.push(dir.scale(def.damage * 4 + def.knockback * 30));
      end = ch.point;
    } else if (wh) {
      this.effects.impact(wh.point, wh.normal);
      if (wh.building) this.city.damageBuilding(wh.building, def.damage * def.buildingDamage);
      end = wh.point;
    } else {
      end = origin.add(dir.scale(range));
    }
    this.effects.tracer(this.player.muzzle(), end, "player", def.speed);
    return end;
  }

  /**
   * レイと死骸（ラグドール）の交差。各パーツを球で近似して判定する。
   * push(impulse) で当たったパーツを押せる（物理が止まった死骸は押せない）。
   */
  corpseRay(origin: Vector3, dir: Vector3, maxDist: number): { dist: number; point: Vector3; push: (imp: Vector3) => void } | null {
    let best: { dist: number; point: Vector3; push: (imp: Vector3) => void } | null = null;
    let bestD = maxDist;
    const tmp = new Vector3();
    for (const c of this.corpses) {
      if (c.sinking >= 0) continue;
      // 大まかな判定（死骸全体の球）
      const root = c.ragdoll.parts[0].node.position;
      const along = Vector3.Dot(root.subtract(origin), dir);
      if (along < -c.radius || along > bestD + c.radius) continue;
      if (raySphere(origin, dir, root, c.radius) < 0) continue;
      for (let i = 0; i < c.ragdoll.parts.length; i++) {
        const part = c.ragdoll.parts[i];
        // 固まった死骸ではパーツが親子関係のままなのでワールド行列で位置を求める
        Vector3.TransformCoordinatesToRef(part.center, part.node.getWorldMatrix(), tmp);
        const r = Math.max(0.25, Math.min(part.size.x, part.size.y, part.size.z) * 0.5 + 0.15);
        const t = raySphere(origin, dir, tmp, Math.max(r, Math.max(part.size.x, part.size.y, part.size.z) * 0.3));
        if (t >= 0 && t < bestD) {
          bestD = t;
          const body = corpseBodyOf(c.ragdoll, i);
          const point = origin.add(dir.scale(t));
          best = {
            dist: t,
            point,
            push: (imp: Vector3) => {
              if (!c.ragdoll.disposed && body) body.applyImpulse(imp, point);
            },
          };
        }
      }
    }
    return best;
  }

  /** 照準の先に有効射程内の敵がいるか（照準を赤くする） */
  private aimInRange(): boolean {
    const w = this.player.weapon;
    if (!this.player.canAct) return false;
    if (w.def.kind === "homing") return w.locks.length > 0 || !!w.lockingTarget;
    const wh = this.city.raycast(this.aimO, this.aimD, w.def.range);
    return !!this.enemies.raycast(this.aimO, this.aimD, wh ? wh.dist : w.def.range);
  }

  /** 線分と死骸（敵弾の遮蔽判定用）。当たった距離を返す */
  corpseSegment(a: Vector3, b: Vector3): number | null {
    const d = b.subtract(a);
    const len = d.length();
    if (len < 1e-6 || this.corpses.length === 0) return null;
    const h = this.corpseRay(a, d.scaleInPlace(1 / len), len);
    return h ? h.dist : null;
  }

  private lockCandidates(def: WeaponDef): Enemy[] {
    const maxAng = ((def.lockAngle ?? 12) * Math.PI) / 180;
    const out: { e: Enemy; a: number }[] = [];
    const o = this.camera.position;
    for (const e of this.enemies.list) {
      if (!e.alive) continue;
      const c = e.center();
      const to = c.subtract(o);
      const d = to.length();
      if (d > def.range) continue;
      const a = Math.acos(clamp(Vector3.Dot(to.scaleInPlace(1 / d), this.aimD), -1, 1));
      if (a > maxAng) continue;
      const blocked = this.city.segment(o, c);
      if (blocked && blocked.dist < d - 2) continue;
      out.push({ e, a });
    }
    out.sort((x, y) => x.a - y.a);
    return out.map((x) => x.e);
  }

  // ------------------------------------------------------------------ GameContext
  explode(o: ExplosionOpts) {
    const { pos, radius, damage, knockback } = o;
    this.effects.explosion(pos, radius);
    sfx.explosion(pos, radius / 7);
    const pd = Vector3.Distance(this.player.position, pos);
    this.effects.addShake(clamp(1.2 - pd / (radius * 6), 0, 0.9));

    if (o.source === "player") {
      for (const { enemy, dist } of this.enemies.inRadius(pos, radius)) {
        const k = 1 - (dist / radius) * 0.5;
        const dir = enemy.center().subtract(pos);
        dir.y = Math.max(dir.y, 0) + 0.5;
        dir.normalize();
        const before = enemy.hp;
        enemy.damage(damage * k, dir, pos, knockback * k);
        const dealt = before - Math.max(0, enemy.hp);
        if (dealt >= 0.5) this.opts.hud.damage(enemy.center(), dealt, "big");
        this.effects.hitEnemy(enemy.center(), dir.scale(-1), enemy.kind, true);
      }
    }
    // 自爆・敵の爆撃
    const selfK = o.source === "player" ? SELF_DAMAGE_RATE : 1;
    if (this.player.alive) this.player.applyBlast(pos, radius, damage * selfK, knockback);
    // 建物
    this.city.damageArea(pos, radius, damage * (o.buildingDamage ?? 1));
    // 死体・車を吹き飛ばす
    for (const c of this.corpses) {
      if (c.ragdoll.disposed) continue;
      for (const b of c.ragdoll.bodies) {
        const bp = b.transformNode.position;
        const d = Vector3.Distance(bp, pos);
        if (d > radius * 1.5) continue;
        const dir = bp.subtract(pos).normalize();
        dir.y += 0.6;
        b.applyImpulse(dir.scale(knockback * 6 * (1 - d / (radius * 1.5))), bp);
      }
    }
    for (const car of this.city.cars) {
      const cp = car.mesh.position;
      const d = Vector3.Distance(cp, pos);
      if (d > radius * 1.6) continue;
      const dir = cp.subtract(pos).normalize();
      dir.y = Math.abs(dir.y) + 0.8;
      const k = 1 - d / (radius * 1.6);
      car.body.applyImpulse(dir.scale(1200 * knockback * 0.6 * k), cp.add(new Vector3(rand(-0.5, 0.5), -0.3, rand(-1, 1))));
    }
  }

  addCorpse(r: CorpseBody, nodes: TransformNode[]) {
    const root = r.parts[0].node.position;
    let radius = 1;
    for (const p of r.parts) {
      p.node.computeWorldMatrix(true);
      radius = Math.max(radius, Vector3.Distance(p.node.getAbsolutePosition(), root) + Math.max(p.size.x, p.size.y, p.size.z));
    }
    const v0 = r.bodies[0]?.getLinearVelocity().length() ?? 0;
    this.corpses.push({ ragdoll: r, nodes, age: 0, sinking: -1, radius, maxSpeed: v0 + 4 });
  }

  /** 超巨大生物の演出: プレイヤーから見える位置の高めのビルの陰に出す */
  spawnColossus() {
    if (this.colossus) return;
    const p = this.player.position;
    const cands = this.city.buildings.filter((b) => {
      if (b.state !== "standing" || b.height < 22 || b.kind === "monument") return false;
      const d = Math.hypot(b.cx - p.x, b.cz - p.z);
      return d > 60 && d < 160;
    });
    if (!cands.length) return;
    // プレイヤーから頭が見える（間に別の建物がない）ものだけ。正面に近いビルを優先
    const fwd = new Vector3(Math.sin(this.camYaw), 0, Math.cos(this.camYaw));
    const eye = this.player.chest;
    let best: { b: (typeof cands)[0]; side: number; score: number } | null = null;
    for (const b of cands) {
      for (const side of [1, -1]) {
        const head = Colossus.path(p, b, side)[3];
        const hit = this.city.segment(eye, head);
        if (hit && hit.dist < Vector3.Distance(eye, head) - 3) continue;
        const dir = new Vector3(b.cx - p.x, 0, b.cz - p.z).normalize();
        const score = Vector3.Dot(dir, fwd) + b.height / 100 + Math.random() * 0.2;
        if (!best || score > best.score) best = { b, side, score };
      }
    }
    if (!best) return;
    this.colossus = new Colossus(this, best.b, best.side);
    this.effects.addShake(0.4);
  }

  /** t 秒後に fn を実行（ゲーム内時間。ポーズ中は進まない） */
  later(t: number, fn: () => void) {
    this.timers.push({ t, fn });
  }

  dropItem(pos: Vector3) {
    this.pickups.drop(pos);
  }

  /** 倒壊したビルから飛び散る破片 */
  private debrisTpl: Mesh | null = null;
  private spawnDebris(x: number, y: number, z: number, size: number) {
    if (!this.debrisTpl) {
      this.debrisTpl = MeshBuilder.CreateBox("debris", { width: 2, height: 1.4, depth: 1.6 }, this.scene);
      const m = this.scene.getMaterialByName("rubble");
      if (m) this.debrisTpl.material = m;
      this.debrisTpl.position.y = -3000;
      this.shadowGen?.addShadowCaster(this.debrisTpl);
    }
    const n = this.quality.level === "low" ? 4 : 8;
    for (let i = 0; i < n; i++) {
      const inst = this.debrisTpl.createInstance("deb");
      inst.position.set(x + rand(-size, size), y + rand(0, 6), z + rand(-size, size));
      inst.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
      const part: RigPart = { node: inst, parent: -1, size: new Vector3(2, 1.4, 1.6), center: Vector3.Zero(), mass: 500 };
      const r = new Ragdoll(this.scene, [part], {
        velocity: new Vector3(rand(-8, 8), rand(2, 10), rand(-8, 8)),
        spin: 4,
      });
      this.addCorpse(r, [inst]);
    }
  }

  // ------------------------------------------------------------------ 毎フレーム
  frame() {
    const input = this.opts.input;
    input.update();
    if (input.consume("pause")) this.setPaused(!this.paused);
    if (this.paused) {
      input.endFrame();
      return;
    }
    const dt = Math.min(this.engine.getDeltaTime() / 1000, 1 / 20);
    this.update(dt);
    this.scene.render();
    input.endFrame();
  }

  /** ゲームロジック1ステップ（描画は含まない） */
  update(dt: number) {
    const input = this.opts.input;
    const hud = this.opts.hud;
    this.time += dt;
    this.casterT -= dt;
    if (this.casterT <= 0) {
      this.casterT = 0.5;
      this.refreshShadowCasters();
    }
    for (let i = this.timers.length - 1; i >= 0; i--) {
      const tm = this.timers[i];
      tm.t -= dt;
      if (tm.t <= 0) {
        this.timers.splice(i, 1);
        tm.fn();
      }
    }

    // 視点操作
    const zoom = input.zoom && this.player.canAct;
    const zoomK = zoom ? this.player.weapon.def.zoom : 1;
    const sens = 1 / Math.max(1, zoomK * 0.8);
    this.camYaw += input.lookDX * sens;
    this.camPitch = clamp(this.camPitch + input.lookDY * sens - this.camRecoil, -1.25, 1.2);
    this.camRecoil *= 0.5;

    this.player.update(dt, input, this.combat, this.camYaw, this.camPitch);
    this.enemies.update(dt);
    this.projectiles.update(dt);
    this.pickups.update(dt, this.player, this.time);
    this.city.update(dt);
    this.updateCorpses(dt);
    if (this.colossus && !this.colossus.update(dt)) this.colossus = null;
    this.effects.update(dt);
    this.mission.update(dt, this.player.alive);
    this.updateCamera(dt, zoomK);
    this.opts.hud.inRange = this.aimInRange();
    sfx.setListener(this.camera.position);

    if (this.shadowGen && !(this.shadowGen instanceof CascadedShadowGenerator)) {
      this.sun.position = this.player.position.subtract(this.sun.direction.scale(250));
    }

    hud.update(dt, this.player, this.enemies.list, this.pickups.items.map((i) => ({ pos: i.pos, kind: i.kind })), this.camYaw, this.scene, this.camera, zoom);

    if (this.mission.result !== "playing") {
      if (this.endTimer < 0) this.endTimer = this.mission.result === "clear" ? 5 : 4;
      this.endTimer -= dt;
      if (this.endTimer <= 0 && this.onEnd) {
        const cb = this.onEnd;
        this.onEnd = undefined;
        cb(this.mission.result, this.mission);
      }
    }
  }

  /** デバッグ・自動テスト用: 描画せずに seconds 秒ぶん進める（物理も手動で進める） */
  simulate(seconds: number, dt = 1 / 30) {
    const pe = this.scene.getPhysicsEngine();
    for (let t = 0; t < seconds; t += dt) {
      this.opts.input.update();
      this.update(dt);
      pe?._step(dt);
      this.opts.input.endFrame();
    }
  }

  setPaused(p: boolean) {
    this.paused = p;
    document.getElementById("pause")!.classList.toggle("hidden", !p);
    if (p) document.exitPointerLock?.();
    else this.opts.input.requestLock();
  }

  private updateCamera(dt: number, zoomK: number) {
    const cam = this.camera;
    const focus = this.player.focus;
    const yaw = this.camYaw,
      pitch = this.camPitch;
    const fwd = new Vector3(Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    const right = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const zoomed = zoomK > 1.2;
    const wantDist = zoomed ? 2.0 : this.player.soldier.ragdoll ? 5.5 : 4.2;
    this.camDist += (wantDist - this.camDist) * damp(10, dt);
    const side = zoomed ? 0.6 : 0.85;
    const pivot = focus.add(right.scale(side)).addInPlace(new Vector3(0, 0.15, 0));
    let desired = pivot.subtract(fwd.scale(this.camDist));
    // 建物にめり込まないように
    const hit = this.city.segment(focus, desired);
    if (hit) desired = focus.add(desired.subtract(focus).normalize().scale(Math.max(0.3, hit.dist - 0.3)));
    if (desired.y < 0.3) desired.y = 0.3;
    // 画面の揺れ
    const s = this.effects.shake;
    if (s > 0) desired.addInPlace(new Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).scale(s * 0.25));
    cam.position.copyFrom(desired);
    cam.setTarget(desired.add(fwd));
    if (this.debugCam) {
      cam.position.copyFrom(this.debugCam.pos);
      cam.setTarget(this.debugCam.target);
    }
    const targetFov = this.fovBase / zoomK;
    cam.fov += (targetFov - cam.fov) * damp(14, dt);

    // 照準レイ（プレイヤーより手前の物に当たらないよう、プレイヤーの位置から開始）
    this.aimD.copyFrom(fwd);
    const t0 = Math.max(0, Vector3.Dot(focus.subtract(desired), fwd));
    this.aimO.copyFrom(desired).addInPlace(fwd.scale(t0));
  }

  private updateCorpses(dt: number) {
    const max = this.quality.maxRagdolls;
    let simulated = 0;
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.age += dt;
      if (c.sinking < 0) {
        simulated++;
        // 出現直後の重なり解消で飛びすぎないよう速さを抑える（その後の爆風は制限しない）
        if (c.age < 0.6 && !c.ragdoll.disposed) {
          for (const b of c.ragdoll.bodies) {
            const v = b.getLinearVelocity();
            const l = v.length();
            if (l > c.maxSpeed) b.setLinearVelocity(v.scale(c.maxSpeed / l));
          }
        }
        // 上限を超えたら古いものから物理を止める
        if (c.age > CORPSE_LIFE || simulated > max) {
          c.ragdoll.dispose();
          c.sinking = 0;
        }
      } else {
        c.sinking += dt;
        for (const n of c.nodes) if (!n.isDisposed()) n.position.y -= dt * 0.8;
        if (c.sinking > 3) {
          for (const n of c.nodes) if (!n.isDisposed()) n.dispose();
          this.corpses.splice(i, 1);
        }
      }
    }
  }

  dispose() {
    this.scene.dispose();
  }
}
