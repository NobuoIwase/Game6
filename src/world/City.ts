// ============================================================================
// 市街地マップの生成と、静的な当たり判定（AABB = 軸に平行な箱の集まり）。
// ----------------------------------------------------------------------------
// 建物の種類:
//   office    : コンクリートのオフィスビル
//   glass     : ガラス張りの高層ビル（一部は低層部＋塔のセットバック型）
//   apartment : レンガのアパート（ベランダ付き。ベランダの手すりは遮蔽物になる）
//   garage    : 立体駐車場（中に入れる。外階段で各階へ上がれ、柱と腰壁が敵弾を防ぐ）
//   shop      : 低層の商店（ひさし付き）
// 1つの建物は複数の箱（boxes）で構成でき、箱ごとに当たり判定を持つ。
// 建物は耐久値を持ち、0 になると爆発して崩れ落ち、がれきだけが残る。
// 当たり判定は自前（物理エンジン不要で軽い）。ラグドールや車のために Havok の静的ボディも付ける。
// ============================================================================
import {
  Matrix,
  Mesh,
  MeshBuilder,
  MultiMaterial,
  PBRMaterial,
  PhysicsBody,
  PhysicsMotionType,
  PhysicsShapeBox,
  PhysicsShapeContainer,
  Quaternion,
  Scene,
  SubMesh,
  Texture,
  TransformNode,
  Vector3,
  Vector4,
  Color3,
} from "@babylonjs/core";
import { CityMaterials, FACADE_SPECS, FacadeStyle } from "./Materials";
import { COL_STATIC, COL_ALL } from "../core/Physics";
import { createProps, PropBatch, PropKit, wirePath } from "./Props";
import type { AssetDef, AssetLibrary, AssetStateName } from "./AssetLibrary";

/** realizeAssets() で置くモデルの予約 */
interface PendingPlace {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  parent: TransformNode | null;
  states?: AssetStateName[];
  /** 影を落とす */
  cast?: boolean;
  /** 動くもの（車）。行列を固定しない */
  moving?: boolean;
}

export const CITY_HALF = 250;
const PITCH = 72;
const SIDEWALK_H = 0.12;
const SIDEWALK_W = 4;
const BLOCK_RANGE = 3; // -3..3 の 7x7 街区
/** 道路の中心線（x 方向・z 方向とも同じ位置） */
const LINES = [-252, -180, -108, -36, 36, 108, 180, 252];
/** x = LINES[k] を南北に走る道路の幅（x=108 の道路の上を高速道路が通る） */
const ROAD_W_X = [16, 16, 16, 16, 16, 18, 16, 16];
/** z = LINES[k] を東西に走る道路の幅（z=-36 は中央分離帯のある大通り） */
const ROAD_W_Z = [16, 16, 16, 30, 16, 16, 16, 16];
const AVENUE_Z = -36;
const HIGHWAY_X = 108;

export type BlockKind = "plaza" | "park" | "business" | "mixed" | "residential";
export interface Block {
  i: number;
  j: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  kind: BlockKind;
}
/** プレイヤーが乗り越えられる段差 */
export const STEP_UP = 0.6;

export type BuildingKind = "office" | "glass" | "apartment" | "garage" | "shop" | "monument" | "house" | "highway" | "bridge" | "hut";

/** 当たり判定の箱（ワールド座標） */
export interface Box {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  b: Building;
}

export interface Building {
  id: number;
  kind: BuildingKind;
  /** 見た目のメッシュの親（原点 = 地面の中心） */
  root: TransformNode;
  boxes: Box[];
  body: PhysicsBody | null;
  cx: number;
  cz: number;
  /** 全体の外接半幅 */
  hw: number;
  hd: number;
  height: number;
  hp: number;
  maxHp: number;
  state: "standing" | "collapsing" | "gone";
  collapseT: number;
  /** 建物に付いた小物（thin instance）。倒壊時に一緒に沈める */
  thin: { batch: PropBatch; idx: number }[];
  /** 外部アセットの建物（倒壊後に wreck 状態のモデルを置く） */
  asset?: { id: string; x: number; y: number; z: number; yaw: number };
}

export interface RayHit {
  dist: number;
  point: Vector3;
  normal: Vector3;
  building: Building | null;
}

export interface Car {
  mesh: TransformNode;
  body: PhysicsBody;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(arr: T[]) => arr[(Math.random() * arr.length) | 0];

/** 見た目用の箱メッシュ（UV を実寸 / tile で繰り返す） */
function uvBox(scene: Scene, w: number, h: number, d: number, tile: number, wrap = false) {
  return MeshBuilder.CreateBox(
    "box",
    {
      width: w,
      height: h,
      depth: d,
      wrap,
      faceUV: [
        new Vector4(0, 0, w / tile, h / tile),
        new Vector4(0, 0, w / tile, h / tile),
        new Vector4(0, 0, d / tile, h / tile),
        new Vector4(0, 0, d / tile, h / tile),
        new Vector4(0, 0, w / tile, d / tile),
        new Vector4(0, 0, w / tile, d / tile),
      ],
    },
    scene,
  );
}

/** 建物を組み立てるための一時的な入れ物 */
class Builder {
  meshes: Mesh[] = [];
  boxes: { c: Vector3; s: Vector3 }[] = [];
  /** 通りに面した向き（看板の向きなど） */
  front = new Vector3(0, 0, 1);
  /** 屋上の飾り（室外機など）を置くか */
  roofClutter = true;
  signs = false;
  thin: { batch: PropBatch; m: Matrix }[] = [];
  constructor(
    public cx: number,
    public cz: number,
  ) {}
  /** 当たり判定の箱（ローカル: 中心 c, 大きさ s） */
  solid(c: Vector3, s: Vector3) {
    this.boxes.push({ c, s });
  }
  /** 見た目と当たり判定の両方 */
  part(m: Mesh, c: Vector3, s: Vector3, collide = true) {
    m.position.copyFrom(c);
    this.meshes.push(m);
    if (collide) this.solid(c, s);
    return m;
  }
}

export class City {
  buildings: Building[] = [];
  cars: Car[] = [];
  private grid = new Map<number, Box[]>();
  private readonly cell = 24;
  private stamp = 0;
  private boxStamp = new WeakMap<Box, number>();
  /** 倒壊開始時に呼ばれる（爆発・土煙などの演出用） */
  onCollapseStart?: (b: Building) => void;
  onCollapseEnd?: (b: Building) => void;
  shadowCasters: Mesh[] = [];
  private carTemplates: Mesh[] = [];
  blocks: Block[] = [];
  private props!: PropKit;
  private wires: Mesh[] = [];
  private steel: PBRMaterial;
  private concrete: PBRMaterial;
  private awnings: PBRMaterial[];

  private assets: AssetLibrary | null;
  private pending: PendingPlace[] = [];

  constructor(
    private scene: Scene,
    private mats: CityMaterials,
    assets: AssetLibrary | null = null,
  ) {
    this.assets = assets?.ready ? assets : null;
    this.concrete = mats.roof;
    this.steel = new PBRMaterial("bridgeSteel", scene);
    this.steel.albedoColor = new Color3(0.25, 0.42, 0.45);
    this.steel.roughness = 0.45;
    this.steel.metallic = 0.6;
    this.awnings = [new Color3(0.55, 0.08, 0.06), new Color3(0.08, 0.25, 0.45), new Color3(0.12, 0.35, 0.15)].map((c, i) => {
      const m = new PBRMaterial("awning" + i, scene);
      m.albedoColor = c;
      m.roughness = 0.8;
      m.metallic = 0;
      return m;
    });
  }

  build() {
    this.props = createProps(this.scene, {
      concrete: this.concrete,
      metal: this.mats.metal,
      darkMetal: this.mats.darkMetal,
      glassDark: this.mats.glassDark,
      plaster: this.mats.plaster,
      rooftile: this.mats.rooftile,
      corrugated: this.mats.corrugated,
    });
    if (this.assets) this.buildPools();
    this.buildGround();
    this.carTemplates = this.createCarTemplates();
    this.layoutBlocks();
    this.buildBlocks();
    this.buildAvenue();
    this.buildHighway();
    this.buildFootbridge(12);
    this.buildMarkings();
    if (this.assets) {
      this.assetStreet();
      this.assetCars();
      this.assetSkyline();
    } else {
      this.buildLamps();
      this.buildStreetFurniture();
      this.buildCars();
      this.buildSkyline();
    }
    for (const b of this.props.all) b.build();
    for (const b of this.props.all) this.shadowCasters.push(b.mesh);
    if (this.wires.length) {
      const w = Mesh.MergeMeshes(this.wires, true, true)!;
      w.material = this.props.wireMat;
      w.isPickable = false;
      w.freezeWorldMatrix();
    }
  }

  // ------------------------------------------------------------------ 地面・街区
  private buildGround() {
    const size = 1400;
    const ground = MeshBuilder.CreateGround("ground", { width: size, height: size, subdivisions: 2 }, this.scene);
    const tile = 7;
    for (const t of [this.mats.road.albedoTexture, this.mats.road.bumpTexture, this.mats.road.metallicTexture] as Texture[]) {
      t.uScale = size / tile;
      t.vScale = size / tile;
    }
    ground.material = this.mats.road;
    ground.receiveShadows = true;
    ground.freezeWorldMatrix();
    ground.isPickable = false;

    const node = new TransformNode("groundPhys", this.scene);
    node.position.y = -0.5;
    const body = new PhysicsBody(node, PhysicsMotionType.STATIC, false, this.scene);
    const shape = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(size, 1, size), this.scene);
    shape.filterMembershipMask = COL_STATIC;
    shape.filterCollideMask = COL_ALL;
    shape.material = { friction: 0.8, restitution: 0.05 };
    body.shape = shape;
  }

  /** 街区の配置（道路幅から各街区の範囲を決め、用途を割り当てる） */
  private layoutBlocks() {
    for (let i = -BLOCK_RANGE; i <= BLOCK_RANGE; i++)
      for (let j = -BLOCK_RANGE; j <= BLOCK_RANGE; j++) {
        const kx = i + 3,
          kz = j + 3;
        const ring = Math.max(Math.abs(i), Math.abs(j));
        let kind: BlockKind = ring <= 1 ? "business" : ring === 2 ? "mixed" : "residential";
        // 大通り沿いは外周でも商店街
        if (ring === 3 && (j === -1 || j === 0) && Math.abs(i) <= 2) kind = "mixed";
        if (i === 0 && j === 0) kind = "plaza";
        if (i === 1 && j === 0) kind = "park";
        this.blocks.push({
          i,
          j,
          minX: LINES[kx] + ROAD_W_X[kx] / 2,
          maxX: LINES[kx + 1] - ROAD_W_X[kx + 1] / 2,
          minZ: LINES[kz] + ROAD_W_Z[kz] / 2,
          maxZ: LINES[kz + 1] - ROAD_W_Z[kz + 1] / 2,
          kind,
        });
      }
  }

  /** 地点 (x,z) を含む街区 */
  blockAt(x: number, z: number): Block | null {
    const i = Math.round(x / PITCH),
      j = Math.round(z / PITCH);
    if (Math.abs(i) > BLOCK_RANGE || Math.abs(j) > BLOCK_RANGE) return null;
    const b = this.blocks[(i + BLOCK_RANGE) * (BLOCK_RANGE * 2 + 1) + (j + BLOCK_RANGE)];
    return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ ? b : null;
  }

  private buildBlocks() {
    // 歩道（街区の台座）: 全部まとめて1つのメッシュ
    const sws: Mesh[] = [];
    for (const bl of this.blocks) {
      const w = bl.maxX - bl.minX,
        d = bl.maxZ - bl.minZ;
      const cx = (bl.minX + bl.maxX) / 2,
        cz = (bl.minZ + bl.maxZ) / 2;
      const m = uvBox(this.scene, w, SIDEWALK_H, d, bl.kind === "plaza" ? 4 : 3);
      m.position.set(cx, SIDEWALK_H / 2, cz);
      sws.push(m);
    }
    const sw = Mesh.MergeMeshes(sws, true, true)!;
    sw.material = this.mats.sidewalk;
    sw.receiveShadows = true;
    sw.freezeWorldMatrix();
    for (const bl of this.blocks) {
      const ring = Math.max(Math.abs(bl.i), Math.abs(bl.j));
      if (bl.kind === "plaza") {
        const cx = (bl.minX + bl.maxX) / 2,
          cz = (bl.minZ + bl.maxZ) / 2;
        const plaza = uvBox(this.scene, bl.maxX - bl.minX - 2 * SIDEWALK_W, 0.02, bl.maxZ - bl.minZ - 2 * SIDEWALK_W, 4);
        plaza.position.set(cx, SIDEWALK_H + 0.01, cz);
        plaza.material = this.mats.plaza;
        plaza.receiveShadows = true;
        plaza.freezeWorldMatrix();
        this.buildMonument(cx, cz - 6);
        continue;
      }
      if (bl.kind === "park") this.buildPark(bl);
      else if (bl.kind === "residential") this.fillResidential(bl);
      else this.fillBlock(bl, ring);
    }
  }

  /** 広場の記念碑（低い遮蔽物） */
  private buildMonument(x: number, z: number) {
    const B = new Builder(x, z);
    B.roofClutter = false;
    const base = MeshBuilder.CreateBox("monument", { width: 4, height: 1.2, depth: 4 }, this.scene);
    base.material = this.concrete;
    B.part(base, new Vector3(0, 0.6, 0), new Vector3(4, 1.2, 4));
    const pillar = MeshBuilder.CreateBox("monument2", { width: 1.2, height: 7, depth: 1.2 }, this.scene);
    pillar.material = this.mats.metal;
    B.part(pillar, new Vector3(0, 4.7, 0), new Vector3(1.2, 7, 1.2));
    this.finish(B, "monument", 1e9);
  }

  /** 通りに面した向き（ロットの中心から一番近い街区の辺の方向） */
  private frontOf(bl: Block, x: number, z: number): Vector3 {
    const d = [x - bl.minX, bl.maxX - x, z - bl.minZ, bl.maxZ - z];
    const m = Math.min(...d);
    if (m === d[0]) return new Vector3(-1, 0, 0);
    if (m === d[1]) return new Vector3(1, 0, 0);
    if (m === d[2]) return new Vector3(0, 0, -1);
    return new Vector3(0, 0, 1);
  }

  /** ビル街・商店街の街区に建物を並べる */
  private fillBlock(bl: Block, ring: number) {
    const x0 = bl.minX + SIDEWALK_W,
      x1 = bl.maxX - SIDEWALK_W,
      z0 = bl.minZ + SIDEWALK_W,
      z1 = bl.maxZ - SIDEWALK_W;
    const W = x1 - x0,
      D = z1 - z0;
    const cx = (x0 + x1) / 2,
      cz = (z0 + z1) / 2;
    const layout = Math.random();
    const lots: [number, number, number, number][] = [];
    const g = 3;
    if (bl.kind === "mixed") {
      // 商店街: 通り沿いに細い建物が並ぶ（3列 x 2列）
      const nx = 3,
        nz = 2;
      const lw = (W - g * (nx - 1)) / nx,
        ld = (D - g * (nz - 1)) / nz;
      for (let a = 0; a < nx; a++) for (let c = 0; c < nz; c++) lots.push([x0 + lw / 2 + a * (lw + g), z0 + ld / 2 + c * (ld + g), lw, ld]);
    } else if (layout < 0.2) {
      lots.push([cx, cz, W, D]);
    } else if (layout < 0.55) {
      const hw = (W - g) / 2,
        hd = (D - g) / 2;
      if (Math.random() < 0.5) lots.push([cx - (hw + g) / 2, cz, hw, D], [cx + (hw + g) / 2, cz, hw, D]);
      else lots.push([cx, cz - (hd + g) / 2, W, hd], [cx, cz + (hd + g) / 2, W, hd]);
    } else {
      const hw = (W - g) / 2,
        hd = (D - g) / 2;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) lots.push([cx + (sx * (hw + g)) / 2, cz + (sz * (hd + g)) / 2, hw, hd]);
    }
    for (const [x, z, w, d] of lots) {
      if (Math.random() < 0.05) continue;
      const r = Math.random();
      const kind: BuildingKind =
        bl.kind === "mixed"
          ? r < 0.35
            ? "shop"
            : r < 0.6
              ? "apartment"
              : r < 0.85
                ? "office"
                : "garage"
          : r < 0.32
            ? "glass"
            : r < 0.62
              ? "office"
              : r < 0.76
                ? "apartment"
                : r < 0.88
                  ? "garage"
                  : "shop";
      const bw = w * rand(0.8, 0.96);
      const bd = d * rand(0.8, 0.96);
      const px = x + rand(-0.6, 0.6),
        pz = z + rand(-0.6, 0.6);
      const front = this.frontOf(bl, px, pz);
      if (this.assets && this.assetLot(bl, ring, kind === "shop" ? x : px, kind === "shop" ? z : pz, kind === "shop" ? w : bw, kind === "shop" ? d : bd, front, kind)) continue;
      switch (kind) {
        case "glass":
          this.buildTower(px, pz, bw, bd, ring, front);
          break;
        case "office":
          this.buildBoxBuilding(px, pz, bw, bd, Math.round(bl.kind === "mixed" ? rand(3, 6) : rand(4, 11)), "office", "office", front);
          break;
        case "apartment":
          this.buildApartment(px, pz, bw, bd, front);
          break;
        case "garage":
          this.buildGarage(px, pz, Math.min(bw, 34), Math.min(bd, 34));
          break;
        case "shop":
          this.buildShops(px, pz, bw, bd, front);
          break;
      }
    }
  }

  /** 住宅街: 一戸建てとブロック塀、所々に小さなアパート */
  private fillResidential(bl: Block) {
    const x0 = bl.minX + SIDEWALK_W,
      x1 = bl.maxX - SIDEWALK_W,
      z0 = bl.minZ + SIDEWALK_W,
      z1 = bl.maxZ - SIDEWALK_W;
    const cell = 13;
    const nx = Math.floor((x1 - x0) / cell),
      nz = Math.floor((z1 - z0) / cell);
    const cw = (x1 - x0) / nx,
      cd = (z1 - z0) / nz;
    const used = new Set<string>();
    // 大きめの区画にアパートを1つ
    if (Math.random() < 0.6) {
      const a = (Math.random() * (nx - 1)) | 0,
        c = (Math.random() * (nz - 1)) | 0;
      for (const [da, dc] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ])
        used.add(`${a + da},${c + dc}`);
      const px = x0 + (a + 1) * cw,
        pz = z0 + (c + 1) * cd;
      if (!this.assets || !this.assetInLot(this.pools!.mid, px, pz, cw * 2 - 1.5, cd * 2 - 1.5, this.frontOf(bl, px, pz), "apartment", 0.2))
        this.buildApartment(px, pz, cw * 2 - 3, cd * 2 - 3, this.frontOf(bl, px, pz));
    }
    for (let a = 0; a < nx; a++)
      for (let c = 0; c < nz; c++) {
        if (used.has(`${a},${c}`)) continue;
        const px = x0 + (a + 0.5) * cw,
          pz = z0 + (c + 0.5) * cd;
        if (Math.random() < 0.1) {
          // 空き地に自販機
          const f = this.frontOf(bl, px, pz);
          const m = Matrix.RotationY(Math.atan2(f.x, f.z)).multiply(Matrix.Translation(px + f.x * (cw / 2 - 1), SIDEWALK_H, pz + f.z * (cd / 2 - 1)));
          pick(this.props.vending).add(m);
          continue;
        }
        if (this.assets && this.assetInLot(this.pools!.house, px, pz, cw - 0.6, cd - 0.6, this.frontOf(bl, px, pz), "house", 0.2)) continue;
        this.buildHouse(px, pz, cw, cd, this.frontOf(bl, px, pz));
      }
  }

  /** 一戸建て（見た目は thin instance、ブロック塀つき） */
  private buildHouse(x: number, z: number, lotW: number, lotD: number, front: Vector3) {
    const B = new Builder(x, z);
    B.roofClutter = false;
    const yaw = Math.atan2(front.x, front.z);
    const typeA = Math.random() < 0.5;
    const w = typeA ? 8 : 9.5,
      d = typeA ? 9 : 7.5,
      h = 5.6;
    // 回転後の外接寸法（90 度単位なので入れ替えるだけ）
    const side = Math.abs(front.x) > 0.5;
    const ww = side ? d : w,
      dd = side ? w : d;
    const m = Matrix.RotationY(yaw).multiply(Matrix.Translation(x, SIDEWALK_H, z));
    B.thin.push({ batch: typeA ? this.props.houseA : this.props.houseB, m });
    B.solid(new Vector3(0, h / 2 + SIDEWALK_H, 0), new Vector3(ww, h, dd));
    B.solid(new Vector3(0, h + 1.0 + SIDEWALK_H, 0), new Vector3(ww * 0.6, 2, dd * 0.6));
    // ブロック塀（正面は門の分あける）
    const hx = lotW / 2 - 0.3,
      hz = lotD / 2 - 0.3;
    const wall = (cx: number, cz: number, len: number, alongX: boolean) => {
      if (len < 0.5) return;
      const wm = Matrix.Scaling(len, 1, 1)
        .multiply(Matrix.RotationY(alongX ? 0 : Math.PI / 2))
        .multiply(Matrix.Translation(x + cx, SIDEWALK_H, z + cz));
      B.thin.push({ batch: this.props.blockWall, m: wm });
      B.solid(new Vector3(cx, 0.65 + SIDEWALK_H, cz), alongX ? new Vector3(len, 1.3, 0.2) : new Vector3(0.2, 1.3, len));
    };
    const gate = 3;
    for (const [fx, fz] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ]) {
      const isFront = fx === front.x && fz === front.z;
      if (fz !== 0) {
        const zz = fz * hz;
        if (isFront) {
          wall(-(hx + gate / 2) / 2 - gate / 4, zz, hx - gate / 2, true);
          wall((hx + gate / 2) / 2 + gate / 4, zz, hx - gate / 2, true);
        } else wall(0, zz, hx * 2, true);
      } else {
        const xx = fx * hx;
        if (isFront) {
          wall(xx, -(hz + gate / 2) / 2 - gate / 4, hz - gate / 2, false);
          wall(xx, (hz + gate / 2) / 2 + gate / 4, hz - gate / 2, false);
        } else wall(xx, 0, hz * 2, false);
      }
    }
    this.finish(B, "house", 260);
  }

  /** 公園: 芝生、遊歩道、池、木、ベンチ */
  private buildPark(bl: Block) {
    const x0 = bl.minX + SIDEWALK_W,
      x1 = bl.maxX - SIDEWALK_W,
      z0 = bl.minZ + SIDEWALK_W,
      z1 = bl.maxZ - SIDEWALK_W;
    const W = x1 - x0,
      D = z1 - z0;
    const cx = (x0 + x1) / 2,
      cz = (z0 + z1) / 2;
    const grass = MeshBuilder.CreateGround("parkGrass", { width: W, height: D }, this.scene);
    grass.position.set(cx, SIDEWALK_H + 0.02, cz);
    const gt = this.mats.grass;
    for (const t of [gt.albedoTexture, gt.bumpTexture, gt.metallicTexture] as Texture[]) {
      t.uScale = W / 8;
      t.vScale = D / 8;
    }
    grass.material = gt;
    grass.receiveShadows = true;
    grass.freezeWorldMatrix();
    // 十字の遊歩道
    const paths = [uvBox(this.scene, W, 0.03, 3.5, 3), uvBox(this.scene, 3.5, 0.03, D, 3)];
    paths[0].position.set(cx, SIDEWALK_H + 0.04, cz);
    paths[1].position.set(cx, SIDEWALK_H + 0.04, cz);
    const pm = Mesh.MergeMeshes(paths, true)!;
    pm.material = this.mats.sidewalk;
    pm.receiveShadows = true;
    pm.freezeWorldMatrix();
    // 池
    const px = cx + W * 0.24,
      pz = cz - D * 0.24;
    const pond = MeshBuilder.CreateDisc("pond", { radius: Math.min(W, D) * 0.17, tessellation: 32 }, this.scene);
    pond.rotation.x = Math.PI / 2;
    pond.scaling.x = 1.4;
    pond.position.set(px, SIDEWALK_H + 0.05, pz);
    pond.material = this.mats.water;
    pond.freezeWorldMatrix();
    // 木（遊歩道と池を避ける）
    for (let k = 0; k < 26; k++) {
      const tx = rand(x0 + 2, x1 - 2),
        tz = rand(z0 + 2, z1 - 2);
      if (Math.abs(tx - cx) < 4 || Math.abs(tz - cz) < 4) continue;
      if (Math.hypot((tx - px) / 1.4, tz - pz) < Math.min(W, D) * 0.2) continue;
      this.addTree(tx, tz, rand(0.9, 1.4));
    }
    if (this.assets) this.assetPark(cx, cz, W, D);
    // ベンチ
    if (!this.assets)
    for (const [bx, bz, r] of [
      [cx + 6, cz + 2.8, Math.PI],
      [cx - 6, cz + 2.8, Math.PI],
      [cx + 6, cz - 2.8, 0],
      [cx - 6, cz - 2.8, 0],
      [cx + 2.8, cz + 8, -Math.PI / 2],
      [cx - 2.8, cz - 8, Math.PI / 2],
    ])
      this.props.bench.add(Matrix.RotationY(r).multiply(Matrix.Translation(bx, SIDEWALK_H, bz)));
    // 公衆トイレ（小さな遮蔽物）
    const B = new Builder(cx - W * 0.3, cz + D * 0.3);
    const hut = uvBox(this.scene, 5, 3, 4, 3);
    hut.material = this.mats.plaster;
    B.part(hut, new Vector3(0, 1.5, 0), new Vector3(5, 3, 4));
    const rf = MeshBuilder.CreateBox("hutRoof", { width: 6, height: 0.3, depth: 5 }, this.scene);
    rf.material = this.mats.darkMetal;
    B.part(rf, new Vector3(0, 3.15, 0), new Vector3(6, 0.3, 5));
    B.roofClutter = false;
    this.finish(B, "hut", 300);
  }

  /** 木を1本植える（幹だけ当たり判定あり） */
  private addTree(x: number, z: number, scale = 1) {
    const m = Matrix.Scaling(scale, scale, scale)
      .multiply(Matrix.RotationY(Math.random() * Math.PI * 2))
      .multiply(Matrix.Translation(x, SIDEWALK_H, z));
    pick(this.props.trees).add(m);
  }

  /** 大通り: 中央分離帯（植え込みと街路樹）とガードレール */
  private buildAvenue() {
    const kz = LINES.indexOf(AVENUE_Z);
    const half = ROAD_W_Z[kz] / 2;
    const median = uvBox(this.scene, 504, 0.25, 3, 3);
    median.position.set(0, 0.125, AVENUE_Z);
    median.material = this.mats.sidewalk;
    median.receiveShadows = true;
    median.freezeWorldMatrix();
    const hedge = MeshBuilder.CreateBox("hedge", { width: 504, height: 0.7, depth: 1.6 }, this.scene);
    hedge.position.set(0, 0.6, AVENUE_Z);
    const hm = new PBRMaterial("hedgeMat", this.scene);
    hm.albedoColor = new Color3(0.12, 0.25, 0.08);
    hm.roughness = 0.9;
    hm.metallic = 0;
    hedge.material = hm;
    hedge.receiveShadows = true;
    hedge.freezeWorldMatrix();
    for (let x = -246; x <= 246; x += 12) {
      // 交差点の中は木を植えない
      if (LINES.some((l) => Math.abs(x - l) < 10)) continue;
      this.addTree(x, AVENUE_Z, 1.15);
    }
    // 歩道側のガードレール（横断歩道の位置はあける）
    for (const sz of [-1, 1]) {
      const z = AVENUE_Z + sz * (half - 0.4);
      for (let x = -250; x < 250; x += 4) {
        if (LINES.some((l) => Math.abs(x + 2 - l) < 16)) continue;
        this.props.rail.add(Matrix.Translation(x + 2, 0, z));
      }
    }
  }

  /** 高架の高速道路（x = HIGHWAY_X の道路の上） */
  private buildHighway() {
    const top = 12.5,
      deckW = 20,
      thick = 1.4;
    for (let z0 = -250; z0 < 250; z0 += 50) {
      const B = new Builder(HIGHWAY_X, z0 + 25);
      B.roofClutter = false;
      const deck = uvBox(this.scene, deckW, thick, 50, 4);
      deck.material = this.concrete;
      B.part(deck, new Vector3(0, top - thick / 2, 0), new Vector3(deckW, thick, 50));
      for (const sx of [-1, 1]) {
        const bar = uvBox(this.scene, 0.4, 1.1, 50, 2);
        bar.material = this.mats.garageWall;
        B.part(bar, new Vector3(sx * (deckW / 2 - 0.2), top + 0.55, 0), new Vector3(0.4, 1.1, 50));
      }
      // 橋脚（T 字）
      for (const pz of [-12.5, 12.5]) {
        const col = uvBox(this.scene, 2.6, top - thick - 1.2, 2.6, 3);
        col.material = this.concrete;
        B.part(col, new Vector3(0, (top - thick - 1.2) / 2, pz), new Vector3(2.6, top - thick - 1.2, 2.6));
        const cap = uvBox(this.scene, 16, 1.2, 2.8, 3);
        cap.material = this.concrete;
        B.part(cap, new Vector3(0, top - thick - 0.6, pz), new Vector3(16, 1.2, 2.8));
      }
      // 白線
      const lines: Mesh[] = [];
      for (const lx of [-3.3, 3.3]) {
        for (let dz = -24; dz < 25; dz += 8) {
          const l = MeshBuilder.CreateBox("hl", { width: 0.15, height: 0.02, depth: 4 }, this.scene);
          l.position.set(lx, top + 0.01, dz);
          lines.push(l);
        }
      }
      const lm = Mesh.MergeMeshes(lines, true)!;
      lm.material = this.mats.marking;
      B.meshes.push(lm);
      this.finish(B, "highway", 1e12);
    }
  }

  /** 歩道橋（大通りをまたぐ。両端に階段） */
  private buildFootbridge(x: number) {
    const kz = LINES.indexOf(AVENUE_Z);
    const half = ROAD_W_Z[kz] / 2;
    const zN = AVENUE_Z + half + 2.2,
      zS = AVENUE_Z - half - 2.2;
    const top = 5.6,
      width = 3;
    const B = new Builder(x, AVENUE_Z);
    B.roofClutter = false;
    const len = zN - zS + 3;
    const deck = uvBox(this.scene, width, 0.35, len, 3);
    deck.material = this.steel;
    B.part(deck, new Vector3(0, top - 0.175, 0), new Vector3(width, 0.35, len));
    for (const sx of [-1, 1]) {
      const rail = uvBox(this.scene, 0.12, 1.1, len, 2);
      rail.material = this.steel;
      B.part(rail, new Vector3(sx * (width / 2 - 0.06), top + 0.55, 0), new Vector3(0.12, 1.1, len));
    }
    for (const pz of [zN - AVENUE_Z, zS - AVENUE_Z, 0]) {
      const col = uvBox(this.scene, 0.5, top - 0.35, 0.5, 2);
      col.material = this.steel;
      B.part(col, new Vector3(0, (top - 0.35) / 2, pz), new Vector3(0.5, top - 0.35, 0.5));
    }
    // 階段（x 方向に下りる）
    const rise = 0.4,
      run = 0.5;
    const steps = Math.round(top / rise);
    for (const ez of [zN - AVENUE_Z + 1.5, zS - AVENUE_Z - 1.5]) {
      for (let k = 1; k <= steps; k++) {
        const h = k * rise;
        const st = uvBox(this.scene, run, h, width, 2);
        st.material = this.steel;
        B.part(st, new Vector3(width / 2 + (steps - k + 0.5) * run, h / 2, ez), new Vector3(run, h, width));
      }
      const land = uvBox(this.scene, width, 0.35, 3, 2);
      land.material = this.steel;
      B.part(land, new Vector3(0, top - 0.175, ez), new Vector3(width, 0.35, 3));
    }
    this.finish(B, "bridge", 4000);
  }

  /** 電柱と電線・信号機・自販機 */
  private buildStreetFurniture() {
    // 電柱: 住宅街と商店街の街区のまわり
    for (const bl of this.blocks) {
      if (bl.kind !== "residential" && bl.kind !== "mixed") continue;
      const inset = 0.8;
      const edges: [Vector3, Vector3][] = [
        [new Vector3(bl.minX + inset, 0, bl.minZ + inset), new Vector3(bl.maxX - inset, 0, bl.minZ + inset)],
        [new Vector3(bl.maxX - inset, 0, bl.minZ + inset), new Vector3(bl.maxX - inset, 0, bl.maxZ - inset)],
        [new Vector3(bl.maxX - inset, 0, bl.maxZ - inset), new Vector3(bl.minX + inset, 0, bl.maxZ - inset)],
        [new Vector3(bl.minX + inset, 0, bl.maxZ - inset), new Vector3(bl.minX + inset, 0, bl.minZ + inset)],
      ];
      for (const [a, b] of edges) {
        // 大通り沿いには電柱を立てない（無電柱化）
        if (Math.abs(a.z - b.z) < 1 && Math.abs(Math.abs(a.z - AVENUE_Z) - ROAD_W_Z[3] / 2) < 2) continue;
        const len = Vector3.Distance(a, b);
        const n = Math.max(1, Math.round(len / 22));
        const dir = b.subtract(a).normalize();
        const yaw = Math.atan2(dir.x, dir.z) + Math.PI / 2;
        let prev: Vector3 | null = null;
        for (let k = 0; k <= n; k++) {
          if (k === n && n > 1) break; // 角は次の辺の始点と共有
          const p = Vector3.Lerp(a, b, k / n);
          this.props.pole.add(Matrix.RotationY(yaw).multiply(Matrix.Translation(p.x, SIDEWALK_H, p.z)));
          if (prev) this.addWires(prev, p, yaw);
          prev = p;
        }
        if (prev) this.addWires(prev, b, yaw);
      }
    }
    // 信号機: 大通りの交差点
    for (const x of LINES) {
      const half = ROAD_W_Z[3] / 2;
      this.props.trafficLight.add(Matrix.RotationY(-Math.PI / 2).multiply(Matrix.Translation(x + 9, SIDEWALK_H, AVENUE_Z + half + 1)));
      this.props.trafficLight.add(Matrix.RotationY(Math.PI / 2).multiply(Matrix.Translation(x - 9, SIDEWALK_H, AVENUE_Z - half - 1)));
    }
    // 自販機: 商店街の歩道
    for (const bl of this.blocks) {
      if (bl.kind !== "mixed") continue;
      for (let k = 0; k < 2; k++) {
        const x = rand(bl.minX + 6, bl.maxX - 6);
        const z = Math.random() < 0.5 ? bl.minZ + 1.2 : bl.maxZ - 1.2;
        const yaw = z < (bl.minZ + bl.maxZ) / 2 ? Math.PI : 0;
        pick(this.props.vending).add(Matrix.RotationY(yaw).multiply(Matrix.Translation(x, SIDEWALK_H, z)));
        pick(this.props.vending).add(Matrix.RotationY(yaw).multiply(Matrix.Translation(x + 1.05, SIDEWALK_H, z)));
      }
    }
  }

  private addWires(a: Vector3, b: Vector3, yaw: number, top = 9.25) {
    const off = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    for (const [h, o] of [
      [top, 0.9],
      [top, -0.9],
      [top - 0.8, 0.6],
    ]) {
      const pa = a.add(off.scale(o)).addInPlace(new Vector3(0, h + SIDEWALK_H, 0));
      const pb = b.add(off.scale(o)).addInPlace(new Vector3(0, h + SIDEWALK_H, 0));
      const t = MeshBuilder.CreateTube("wire", { path: wirePath(pa, pb, 0.6, 6), radius: 0.03, tessellation: 3 }, this.scene);
      this.wires.push(t);
    }
  }

  /** 側面＝外壁、上面＝屋上の 2 マテリアルを持つ箱 */
  private facadeBox(w: number, h: number, d: number, style: FacadeStyle): Mesh {
    const spec = FACADE_SPECS[style];
    const mesh = MeshBuilder.CreateBox(
      "bld",
      {
        width: w,
        height: h,
        depth: d,
        wrap: true,
        faceUV: [
          new Vector4(0, 0, w / spec.tileW, h / spec.tileH),
          new Vector4(0, 0, w / spec.tileW, h / spec.tileH),
          new Vector4(0, 0, d / spec.tileW, h / spec.tileH),
          new Vector4(0, 0, d / spec.tileW, h / spec.tileH),
          new Vector4(0, 0, w / 4, d / 4),
          new Vector4(0, 0, 1, 1),
        ],
      },
      this.scene,
    );
    const facade = pick(this.mats.facades.filter((f) => f.style === style)).mat;
    const multi = new MultiMaterial("bldMat", this.scene);
    multi.subMaterials.push(facade, this.mats.roof);
    mesh.subMeshes = [];
    const verts = mesh.getTotalVertices();
    new SubMesh(0, 0, verts, 0, 24, mesh); // 側面
    new SubMesh(1, 0, verts, 24, 12, mesh); // 上面＋底面（底面は見えない）
    mesh.material = multi;
    return mesh;
  }

  private snap(v: number, style: FacadeStyle) {
    const span = FACADE_SPECS[style].tileW / 2;
    return Math.max(span * 2, Math.round(v / span) * span);
  }

  private buildBoxBuilding(x: number, z: number, w: number, d: number, floors: number, style: FacadeStyle, kind: BuildingKind, front?: Vector3) {
    const B = new Builder(x, z);
    if (front) B.front = front;
    B.signs = Math.random() < 0.5;
    w = this.snap(w, style);
    d = this.snap(d, style);
    const h = Math.max(2, floors) * (FACADE_SPECS[style].tileH / 2);
    B.part(this.facadeBox(w, h, d, style), new Vector3(0, h / 2, 0), new Vector3(w, h, d));
    this.finish(B, kind);
  }

  /** ガラスの高層ビル。半分はセットバック（低層部の上に細い塔） */
  private buildTower(x: number, z: number, w: number, d: number, ring: number, front?: Vector3) {
    const floors = Math.round(rand(9, 18) - ring);
    if (Math.random() < 0.5 || w < 20 || d < 20) {
      this.buildBoxBuilding(x, z, w, d, floors, "glass", "glass", front);
      return;
    }
    const B = new Builder(x, z);
    if (front) B.front = front;
    const fh = FACADE_SPECS.office.tileH / 2;
    const podW = this.snap(w, "office"),
      podD = this.snap(d, "office");
    const podH = Math.round(rand(2, 4)) * fh;
    B.part(this.facadeBox(podW, podH, podD, "office"), new Vector3(0, podH / 2, 0), new Vector3(podW, podH, podD));
    const tw = this.snap(podW * rand(0.5, 0.7), "glass"),
      td = this.snap(podD * rand(0.5, 0.7), "glass");
    const th = Math.max(6, floors) * (FACADE_SPECS.glass.tileH / 2);
    B.part(this.facadeBox(tw, th, td, "glass"), new Vector3(0, podH + th / 2, 0), new Vector3(tw, th, td));
    this.finish(B, "glass");
  }

  /** レンガのアパート。通り側（±z）にベランダが並ぶ */
  private buildApartment(x: number, z: number, w: number, d: number, front?: Vector3) {
    const B = new Builder(x, z);
    if (front) B.front = front;
    const spec = FACADE_SPECS.brick;
    w = this.snap(w, "brick");
    d = this.snap(Math.min(d, 18), "brick") - 2.8; // ベランダの分だけ奥行きを詰める
    const floors = Math.round(rand(3, 7));
    const fh = spec.tileH / 2;
    const h = floors * fh;
    B.part(this.facadeBox(w, h, d, "brick"), new Vector3(0, h / 2, 0), new Vector3(w, h, d));
    const side = front && Math.abs(front.z) > 0.5 ? Math.sign(front.z) : Math.random() < 0.5 ? 1 : -1;
    const bd = 1.4; // ベランダの奥行き
    const slabs: Mesh[] = [];
    const rails: Mesh[] = [];
    for (let f = 1; f < floors; f++) {
      const y = f * fh;
      const slab = uvBox(this.scene, w + 0.4, 0.22, bd, 3);
      slab.position.set(0, y, side * (d / 2 + bd / 2));
      slabs.push(slab);
      B.solid(slab.position.clone(), new Vector3(w + 0.4, 0.22, bd));
      // 手すり（腰壁）: 敵弾を防ぐ遮蔽物
      const rail = uvBox(this.scene, w + 0.4, 1.0, 0.15, 2);
      rail.position.set(0, y + 0.6, side * (d / 2 + bd));
      rails.push(rail);
      B.solid(rail.position.clone(), new Vector3(w + 0.4, 1.0, 0.15));
      // 仕切り板
      for (let px = -w / 2 + 4; px < w / 2 - 1; px += 4) {
        const div = uvBox(this.scene, 0.12, fh - 0.3, bd, 2);
        div.position.set(px, y + (fh - 0.3) / 2 + 0.1, side * (d / 2 + bd / 2));
        rails.push(div);
      }
    }
    if (slabs.length) {
      const sm = Mesh.MergeMeshes(slabs, true)!;
      sm.material = this.concrete;
      B.meshes.push(sm);
      const rm = Mesh.MergeMeshes(rails, true)!;
      rm.material = this.mats.balcony;
      B.meshes.push(rm);
    }
    this.finish(B, "apartment");
  }

  /** 立体駐車場: 柱と床、腰壁、外階段。中に入って遮蔽物として使える */
  private buildGarage(x: number, z: number, w: number, d: number) {
    const B = new Builder(x, z);
    w = Math.max(20, Math.round(w / 4) * 4);
    d = Math.max(20, Math.round(d / 4) * 4);
    const levels = Math.round(rand(2, 4)); // 屋上を含む床の数
    const fh = 3.2;
    const slabT = 0.35;
    const concrete: Mesh[] = [];
    const walls: Mesh[] = [];
    // 床（1階は地面なので 2 階から）
    for (let l = 1; l <= levels; l++) {
      const y = l * fh;
      const s = uvBox(this.scene, w, slabT, d, 4);
      s.position.set(0, y - slabT / 2, 0);
      concrete.push(s);
      B.solid(s.position.clone(), new Vector3(w, slabT, d));
    }
    // 柱
    const pillars: Vector3[] = [];
    for (let px = -w / 2 + 0.4; px <= w / 2 - 0.39; px += (w - 0.8) / Math.round(w / 8))
      for (let pz = -d / 2 + 0.4; pz <= d / 2 - 0.39; pz += (d - 0.8) / Math.round(d / 8)) pillars.push(new Vector3(px, 0, pz));
    const ph = levels * fh - slabT;
    for (const p of pillars) {
      const c = uvBox(this.scene, 0.7, ph, 0.7, 2);
      c.position.set(p.x, ph / 2, p.z);
      concrete.push(c);
      B.solid(c.position.clone(), new Vector3(0.7, ph, 0.7));
    }
    // 各階の腰壁（外階段の出入口だけ開ける）
    const stairSide = Math.random() < 0.5 ? 1 : -1; // 階段は ±x 側
    for (let l = 1; l <= levels; l++) {
      const y = l * fh + 0.55;
      const wallH = 1.1;
      for (const sz of [-1, 1]) {
        const m = uvBox(this.scene, w, wallH, 0.25, 2);
        m.position.set(0, y, sz * (d / 2 - 0.125));
        walls.push(m);
        B.solid(m.position.clone(), new Vector3(w, wallH, 0.25));
      }
      for (const sx of [-1, 1]) {
        if (sx === stairSide) {
          // 階段の出入口（z の端 4m を開ける）
          const len = d - 4.5;
          const m = uvBox(this.scene, 0.25, wallH, len, 2);
          m.position.set(sx * (w / 2 - 0.125), y, -d / 2 + len / 2);
          walls.push(m);
          B.solid(m.position.clone(), new Vector3(0.25, wallH, len));
        } else {
          const m = uvBox(this.scene, 0.25, wallH, d, 2);
          m.position.set(sx * (w / 2 - 0.125), y, 0);
          walls.push(m);
          B.solid(m.position.clone(), new Vector3(0.25, wallH, d));
        }
      }
    }
    // 外階段: 各階へ x 側の外に沿って直線で上がる（段差 0.4m、踏み面 0.5m）
    const rise = 0.4,
      run = 0.5,
      stairW = 2.4;
    for (let l = 1; l <= levels; l++) {
      const steps = Math.round((l * fh) / rise);
      const sx = stairSide * (w / 2 + stairW / 2 + (l - 1) * stairW);
      for (let k = 1; k <= steps; k++) {
        const top = Math.min(l * fh, k * rise);
        const sz = d / 2 - 2.2 - (steps - k) * run; // 最上段が出入口の横に来る
        const st = uvBox(this.scene, stairW, top, run, 2);
        st.position.set(sx, top / 2, sz);
        concrete.push(st);
        B.solid(st.position.clone(), new Vector3(stairW, top, run));
      }
      // 上の階の階段から出入口までの踊り場
      if (l > 1) {
        const lw = (l - 1) * stairW;
        const land = uvBox(this.scene, lw, slabT, 3.2, 3);
        land.position.set(stairSide * (w / 2 + lw / 2), l * fh - slabT / 2, d / 2 - 2.2);
        concrete.push(land);
        B.solid(land.position.clone(), new Vector3(lw, slabT, 3.2));
      }
    }
    const cm = Mesh.MergeMeshes(concrete, true, true)!;
    cm.material = this.concrete;
    B.meshes.push(cm);
    const wm = Mesh.MergeMeshes(walls, true, true)!;
    wm.material = this.mats.garageWall;
    B.meshes.push(wm);
    const b = this.finish(B, "garage");
    // 駐車中の車（見た目だけ）
    for (let l = 0; l < levels; l++) {
      for (let k = 0; k < 4; k++) {
        if (Math.random() < 0.35) continue;
        const inst = pick(this.carTemplates).createInstance("pcar");
        inst.parent = b.root;
        inst.position.set(rand(-w / 2 + 4, w / 2 - 4), l * fh + 0.8, (k % 2 ? 1 : -1) * (d / 2 - 4));
        inst.rotationQuaternion = Quaternion.FromEulerAngles(0, Math.PI / 2 + rand(-0.1, 0.1), 0);
        inst.isPickable = false;
      }
    }
  }

  /** 低層の商店（2〜3軒並び、ひさし付き） */
  private buildShops(x: number, z: number, w: number, d: number, front?: Vector3) {
    const B = new Builder(x, z);
    w = this.snap(w, "office");
    d = this.snap(Math.min(d, 14), "office");
    const fh = FACADE_SPECS.office.tileH / 2;
    const h = Math.round(rand(1, 2)) * fh;
    B.part(this.facadeBox(w, h, d, Math.random() < 0.5 ? "office" : "brick"), new Vector3(0, h / 2, 0), new Vector3(w, h, d));
    const side = front && Math.abs(front.z) > 0.5 ? Math.sign(front.z) : Math.random() < 0.5 ? 1 : -1;
    B.front = new Vector3(0, 0, side);
    B.signs = true;
    // 店名の横看板と、閉まっているシャッター
    const yawF = side > 0 ? 0 : Math.PI;
    B.thin.push({
      batch: pick(this.props.signsH),
      m: Matrix.RotationY(yawF).multiply(Matrix.Translation(x, 3.9, z + side * (d / 2 + 0.25))),
    });
    for (let sx = -w / 2 + 2.5; sx < w / 2 - 2; sx += 4.5) {
      if (Math.random() < 0.5) continue;
      B.thin.push({
        batch: this.props.shutter,
        m: Matrix.RotationY(yawF).multiply(Matrix.Translation(x + sx, 0.1, z + side * (d / 2 + 0.12))),
      });
    }
    // 店先のガラス
    const glass = MeshBuilder.CreateBox("shopFront", { width: w - 0.6, height: 2.4, depth: 0.1 }, this.scene);
    glass.material = this.mats.glassDark;
    B.part(glass, new Vector3(0, 1.4, side * (d / 2 + 0.06)), Vector3.Zero(), false);
    // ひさし
    const aw = MeshBuilder.CreateBox("awning", { width: w - 0.4, height: 0.12, depth: 1.8 }, this.scene);
    aw.rotation.x = side * 0.18;
    aw.material = pick(this.awnings);
    B.part(aw, new Vector3(0, 3.0, side * (d / 2 + 0.9)), new Vector3(w - 0.4, 0.2, 1.8));
    this.finish(B, "shop");
  }

  /** 屋上の室外機・給水タンク・アンテナ・広告看板 */
  private addRoofClutter(B: Builder, kind: BuildingKind) {
    let top: { c: Vector3; s: Vector3 } | null = null;
    for (const s of B.boxes) if (!top || s.c.y + s.s.y / 2 > top.c.y + top.s.y / 2) top = s;
    if (!top) return;
    const y = top.c.y + top.s.y / 2;
    const hx = top.s.x / 2 - 1.5,
      hz = top.s.z / 2 - 1.5;
    if (hx < 1 || hz < 1) return;
    const at = (lx: number, lz: number, yaw: number) =>
      Matrix.RotationY(yaw).multiply(Matrix.Translation(B.cx + top!.c.x + lx, y, B.cz + top!.c.z + lz));
    const nAc = Math.min(8, Math.round((hx * hz) / 25) + 1);
    for (let k = 0; k < nAc; k++) B.thin.push({ batch: this.props.ac, m: at(rand(-hx, hx), rand(-hz, hz), ((Math.random() * 4) | 0) * (Math.PI / 2)) });
    if (Math.random() < 0.45 && hx > 3 && hz > 3) B.thin.push({ batch: this.props.tank, m: at(rand(-hx + 2, hx - 2), rand(-hz + 2, hz - 2), 0) });
    if (Math.random() < 0.35) B.thin.push({ batch: this.props.antenna, m: at(rand(-hx, hx), rand(-hz, hz), Math.random() * 3) });
    if (kind !== "glass" && y < 40 && hx > 7 && Math.random() < 0.18) {
      const f = B.front;
      B.thin.push({ batch: pick(this.props.billboards), m: at(f.x * (hx - 1), f.z * (hz - 1), Math.atan2(f.x, f.z)) });
    }
  }

  /** 通りに突き出した縦看板 */
  private addSign(B: Builder, hw: number, hd: number, height: number) {
    const f = B.front;
    const s = new Vector3(-f.z, 0, f.x);
    const alongF = Math.abs(f.x) > 0.5 ? hw : hd;
    const alongS = Math.abs(f.x) > 0.5 ? hd : hw;
    const y = 4.6 + rand(0, Math.max(0, Math.min(8, height - 11)));
    const side = Math.random() < 0.5 ? 1 : -1;
    const lx = f.x * (alongF + 0.75) + s.x * side * (alongS - 1.4);
    const lz = f.z * (alongF + 0.75) + s.z * side * (alongS - 1.4);
    B.thin.push({
      batch: pick(this.props.signsV),
      m: Matrix.RotationY(Math.atan2(s.x, s.z)).multiply(Matrix.Translation(B.cx + lx, y, B.cz + lz)),
    });
  }

  /** Builder から建物を登録（メッシュの親子付け・当たり判定・物理ボディ） */
  private finish(B: Builder, kind: BuildingKind, hpOverride?: number): Building {
    const root = new TransformNode("bldRoot", this.scene);
    root.position.set(B.cx, 0, B.cz);
    let hw = 0,
      hd = 0,
      height = 0,
      volume = 0;
    for (const s of B.boxes) {
      hw = Math.max(hw, Math.abs(s.c.x) + s.s.x / 2);
      hd = Math.max(hd, Math.abs(s.c.z) + s.s.z / 2);
      height = Math.max(height, s.c.y + s.s.y / 2);
      volume += s.s.x * s.s.y * s.s.z;
    }
    const hp = hpOverride ?? 400 + volume * 0.05;
    const b: Building = {
      id: this.buildings.length,
      kind,
      root,
      boxes: [],
      body: null,
      cx: B.cx,
      cz: B.cz,
      hw,
      hd,
      height,
      hp,
      maxHp: hp,
      state: "standing",
      collapseT: 0,
      thin: [],
    };
    if (B.roofClutter && kind !== "garage") this.addRoofClutter(B, kind);
    if (B.signs && height > 9) this.addSign(B, hw, hd, height);
    for (const t of B.thin) b.thin.push({ batch: t.batch, idx: t.batch.add(t.m) });
    for (const m of B.meshes) {
      m.parent = root;
      m.receiveShadows = true;
      m.isPickable = false;
      this.shadowCasters.push(m);
    }
    // 物理（1つのコンテナ形状にまとめる）
    const body = new PhysicsBody(root, PhysicsMotionType.STATIC, false, this.scene);
    const cont = new PhysicsShapeContainer(this.scene);
    for (const s of B.boxes) {
      const shape = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), s.s, this.scene);
      cont.addChild(shape, s.c);
      b.boxes.push({
        minX: B.cx + s.c.x - s.s.x / 2,
        maxX: B.cx + s.c.x + s.s.x / 2,
        minY: s.c.y - s.s.y / 2,
        maxY: s.c.y + s.s.y / 2,
        minZ: B.cz + s.c.z - s.s.z / 2,
        maxZ: B.cz + s.c.z + s.s.z / 2,
        b,
      });
    }
    cont.filterMembershipMask = COL_STATIC;
    cont.filterCollideMask = COL_ALL;
    cont.material = { friction: 0.7, restitution: 0.05 };
    body.shape = cont;
    b.body = body;
    for (const m of B.meshes) m.freezeWorldMatrix();
    this.buildings.push(b);
    for (const box of b.boxes) this.gridInsert(box);
    return b;
  }

  // ------------------------------------------------------------------ 道路の装飾・車
  private buildMarkings() {
    // 道路の白線（中央線・車線）と横断歩道。thin instance で軽量に描画。
    const dash = MeshBuilder.CreateBox("dash", { width: 0.18, height: 0.02, depth: 3 }, this.scene);
    dash.material = this.mats.marking;
    dash.receiveShadows = true;
    const stripe = MeshBuilder.CreateBox("stripe", { width: 0.5, height: 0.02, depth: 4 }, this.scene);
    stripe.material = this.mats.marking;
    stripe.receiveShadows = true;
    const dm: Matrix[] = [];
    const sm: Matrix[] = [];
    const rotY = Matrix.RotationY(Math.PI / 2);
    const inCross = (p: number, widths: number[]) => LINES.some((l, k) => Math.abs(p - l) < widths[k] / 2 + 5);
    const extent = 250;
    // 南北の道路（x = LINES[k]）
    LINES.forEach((l, k) => {
      for (let p = -extent; p < extent; p += 7) {
        if (inCross(p, ROAD_W_Z)) continue;
        dm.push(Matrix.Translation(l, 0.012, p));
      }
      void k;
    });
    // 東西の道路（z = LINES[k]）。大通りは片側2車線の車線境界線
    LINES.forEach((l, k) => {
      const offs = ROAD_W_Z[k] > 20 ? [-ROAD_W_Z[k] / 4 - 1, ROAD_W_Z[k] / 4 + 1] : [0];
      for (let p = -extent; p < extent; p += 7) {
        if (inCross(p, ROAD_W_X)) continue;
        for (const o of offs) dm.push(rotY.multiply(Matrix.Translation(p, 0.012, l + o)));
      }
    });
    // 横断歩道（交差点の4辺）
    LINES.forEach((lx, kx) =>
      LINES.forEach((lz, kz) => {
        const hx = ROAD_W_X[kx] / 2,
          hz = ROAD_W_Z[kz] / 2;
        for (let s2 = -hx + 1; s2 <= hx - 1; s2 += 1.2) {
          sm.push(Matrix.Translation(lx + s2, 0.012, lz + hz + 3));
          sm.push(Matrix.Translation(lx + s2, 0.012, lz - hz - 3));
        }
        for (let s2 = -hz + 1; s2 <= hz - 1; s2 += 1.2) {
          sm.push(rotY.multiply(Matrix.Translation(lx + hx + 3, 0.012, lz + s2)));
          sm.push(rotY.multiply(Matrix.Translation(lx - hx - 3, 0.012, lz + s2)));
        }
      }),
    );
    dash.thinInstanceAdd(dm);
    stripe.thinInstanceAdd(sm);
    dash.freezeWorldMatrix();
    stripe.freezeWorldMatrix();
  }

  private buildLamps() {
    const pole = MeshBuilder.CreateCylinder("lampPole", { height: 7, diameterTop: 0.12, diameterBottom: 0.2, tessellation: 8 }, this.scene);
    pole.material = this.mats.darkMetal;
    const head = MeshBuilder.CreateBox("lampHead", { width: 1.4, height: 0.16, depth: 0.35 }, this.scene);
    head.material = this.mats.lampGlow;
    const pm: Matrix[] = [];
    const hm: Matrix[] = [];
    for (const bl of this.blocks) {
      if (bl.kind === "plaza" || bl.kind === "residential") continue;
      const cx = (bl.minX + bl.maxX) / 2,
        cz = (bl.minZ + bl.maxZ) / 2;
      for (const along of [-14, 14]) {
        for (const z of [bl.minZ + 0.8, bl.maxZ - 0.8]) {
          const s2 = z < cz ? -1 : 1;
          pm.push(Matrix.Translation(cx + along, 3.5, z));
          hm.push(Matrix.Translation(cx + along, 7, z + s2 * 0.6));
        }
        for (const x of [bl.minX + 0.8, bl.maxX - 0.8]) {
          const s2 = x < cx ? -1 : 1;
          pm.push(Matrix.Translation(x, 3.5, cz + along));
          hm.push(Matrix.RotationY(Math.PI / 2).multiply(Matrix.Translation(x + s2 * 0.6, 7, cz + along)));
        }
      }
    }
    pole.thinInstanceAdd(pm);
    head.thinInstanceAdd(hm);
    this.shadowCasters.push(pole);
  }

  private createCarTemplates(): Mesh[] {
    return this.mats.carPaints.map((paint, i) => {
      const body = MeshBuilder.CreateBox("carBody", { width: 1.8, height: 0.7, depth: 4.4 }, this.scene);
      body.position.y = 0.6;
      const cabin = MeshBuilder.CreateBox("carCabin", { width: 1.6, height: 0.6, depth: 2.2 }, this.scene);
      cabin.position.set(0, 1.25, -0.2);
      const glass = MeshBuilder.CreateBox("carGlass", { width: 1.62, height: 0.45, depth: 2.0 }, this.scene);
      glass.position.set(0, 1.25, -0.2);
      const wheels: Mesh[] = [];
      for (const sx of [-0.85, 0.85])
        for (const sz of [-1.4, 1.4]) {
          const w = MeshBuilder.CreateCylinder("wheel", { diameter: 0.66, height: 0.25, tessellation: 12 }, this.scene);
          w.rotation.z = Math.PI / 2;
          w.position.set(sx, 0.33, sz);
          wheels.push(w);
        }
      body.material = paint;
      cabin.material = paint;
      glass.material = this.mats.glassDark;
      for (const w of wheels) w.material = this.mats.tire;
      const merged = Mesh.MergeMeshes([body, cabin, glass, ...wheels], true, true, undefined, false, true)!;
      merged.name = `car${i}`;
      merged.bakeTransformIntoVertices(Matrix.Translation(0, -0.8, 0));
      merged.receiveShadows = true;
      merged.position.y = -1000; // テンプレート自体は隠す
      this.shadowCasters.push(merged);
      return merged;
    });
  }

  /** 路上駐車の車: 爆発で吹き飛ぶよう Havok の動的ボディ（初期はスリープ） */
  private buildCars() {
    let n = 0;
    for (const bl of this.blocks) {
      if (bl.kind === "plaza") continue;
      const count = (Math.random() * 3) | 0;
      for (let k = 0; k < count; k++) {
        const side = (Math.random() * 4) | 0;
        let x = 0,
          z = 0,
          ry = 0;
        if (side === 0) (x = rand(bl.minX + 8, bl.maxX - 8)), (z = bl.maxZ + 2.2), (ry = Math.PI / 2);
        else if (side === 1) (x = rand(bl.minX + 8, bl.maxX - 8)), (z = bl.minZ - 2.2), (ry = -Math.PI / 2);
        else if (side === 2) (x = bl.maxX + 2.2), (z = rand(bl.minZ + 8, bl.maxZ - 8)), (ry = 0);
        else (x = bl.minX - 2.2), (z = rand(bl.minZ + 8, bl.maxZ - 8)), (ry = Math.PI);
        if (Math.abs(x - HIGHWAY_X) < 12) continue;
        const inst = pick(this.carTemplates).createInstance(`car_${n++}`);
        inst.position.set(x, 0.8, z);
        inst.rotationQuaternion = Quaternion.FromEulerAngles(0, ry + rand(-0.08, 0.08), 0);
        const body = new PhysicsBody(inst, PhysicsMotionType.DYNAMIC, true, this.scene);
        const shape = new PhysicsShapeBox(new Vector3(0, 0.1, 0), Quaternion.Identity(), new Vector3(1.8, 1.4, 4.4), this.scene);
        shape.filterMembershipMask = COL_STATIC;
        shape.filterCollideMask = COL_ALL;
        shape.material = { friction: 0.8, restitution: 0.1 };
        body.shape = shape;
        body.setMassProperties({ mass: 1200 });
        body.setAngularDamping(0.3);
        this.cars.push({ mesh: inst, body });
      }
    }
  }

  /** マップ外周の遠景ビル群（当たり判定なし） */
  private buildSkyline() {
    const byMat = new Map<string, Mesh[]>();
    for (let k = 0; k < 90; k++) {
      const ang = (k / 90) * Math.PI * 2 + rand(-0.02, 0.02);
      const dist = rand(CITY_HALF + 40, 520);
      const style: FacadeStyle = Math.random() < 0.5 ? "glass" : "office";
      const spec = FACADE_SPECS[style];
      const w = Math.round(rand(16, 40) / (spec.tileW / 2)) * (spec.tileW / 2);
      const h = Math.round(rand(6, 30)) * (spec.tileH / 2);
      const m = MeshBuilder.CreateBox(
        "far",
        {
          width: w,
          height: h,
          depth: w,
          wrap: true,
          faceUV: [...Array(4).fill(new Vector4(0, 0, w / spec.tileW, h / spec.tileH)), new Vector4(0, 0, 1, 1), new Vector4(0, 0, 1, 1)],
        },
        this.scene,
      );
      m.position.set(Math.cos(ang) * dist, h / 2, Math.sin(ang) * dist);
      m.rotation.y = rand(0, Math.PI);
      const mat = pick(this.mats.facades.filter((f) => f.style === style)).mat;
      m.material = mat;
      const list = byMat.get(mat.name) ?? [];
      list.push(m);
      byMat.set(mat.name, list);
    }
    for (const list of byMat.values()) {
      const merged = Mesh.MergeMeshes(list, true, true);
      if (merged) {
        merged.freezeWorldMatrix();
        merged.isPickable = false;
      }
    }
  }

  // ------------------------------------------------------------------ 外部アセット（GLB）で街を作る
  /*
   * docs/HANDOFF.md 9.5 のアセット群を使う。台帳（寸法）だけで配置と当たり判定を決め、
   * 実際のモデルは build() の後の realizeAssets() でまとめて読み込んでインスタンス化する。
   * 各モデルの前方は +Z（玄関・店先）。通りに面した向きに回転して置く。
   */
  private pools: Record<"house" | "mid" | "tower" | "industrial" | "shop" | "car", AssetDef[]> | null = null;

  private buildPools() {
    const A = this.assets!;
    const sz = (d: AssetDef) => {
      const n = d.states.normal!;
      return { w: n.max[0] - n.min[0], h: n.max[1], d: n.max[2] - n.min[2] };
    };
    const IND = /工場|倉庫|焼却|格納庫|発電|整備|冷蔵|機械|サイロ|プラント|処理|変電|格納|組立/;
    const bld = A.role("building").filter((d) => !IND.test(d.name));
    this.pools = {
      house: bld.filter((d) => {
        const s = sz(d);
        return Math.max(s.w, s.d) <= 13.5 && s.h <= 12;
      }),
      mid: bld.filter((d) => {
        const s = sz(d);
        return s.h > 8 && Math.max(s.w, s.d) > 10;
      }),
      tower: [...A.role("highrise"), ...bld.filter((d) => sz(d).h > 26)],
      industrial: A.role("building").filter((d) => IND.test(d.name)),
      shop: A.role("shop"),
      car: A.role("vehicle").filter((d) => {
        const s = sz(d);
        return s.d > s.w && s.d <= 6.6 && s.h <= 3.3 && s.w >= 1.3;
      }),
    };
  }

  /**
   * 回転後の外接寸法と、モデル原点から外接箱の中心までのずれ（ワールドの向き）。
   * Babylon では glTF の x が反転する（右手系 → 左手系）。yaw は 90 度単位を想定。
   */
  private footprint(def: AssetDef, yaw: number, st: AssetStateName = "normal") {
    const n = def.states[st] ?? def.states.normal!;
    const minX = -n.max[0],
      maxX = -n.min[0],
      minZ = n.min[2],
      maxZ = n.max[2];
    const lcx = (minX + maxX) / 2,
      lcz = (minZ + maxZ) / 2,
      w = maxX - minX,
      d = maxZ - minZ;
    const c = Math.round(Math.cos(yaw)),
      s = Math.round(Math.sin(yaw));
    const swap = Math.abs(s) === 1;
    return { ww: swap ? d : w, dd: swap ? w : d, ox: lcx * c + lcz * s, oz: -lcx * s + lcz * c, lcx, lcz, h: n.max[1], minY: n.min[1] };
  }

  /** 区画（w×d、正面 front）に収まるモデルを選ぶ。大きく埋まるものほど選ばれやすい */
  private pickFit(pool: AssetDef[], w: number, d: number, front: Vector3, minFill = 0.25): AssetDef | null {
    const yaw = Math.atan2(front.x, front.z);
    const fits: { def: AssetDef; fill: number }[] = [];
    for (const def of pool) {
      const f = this.footprint(def, yaw);
      if (f.ww > w - 0.6 || f.dd > d - 0.6) continue;
      const fill = (f.ww * f.dd) / (w * d);
      if (fill >= minFill) fits.push({ def, fill });
    }
    if (!fits.length) return null;
    fits.sort((a, b) => b.fill - a.fill);
    const top = fits.slice(0, Math.max(4, Math.ceil(fits.length * 0.4)));
    return pick(top).def;
  }

  /**
   * モデルを建物として置く。(tx, tz) = 外接箱の中心。当たり判定は外接箱 1 つ。
   * @returns 作った建物
   */
  private placeAssetBuilding(def: AssetDef, tx: number, tz: number, front: Vector3, kind: BuildingKind, hp?: number): Building {
    const yaw = Math.atan2(front.x, front.z);
    const f = this.footprint(def, yaw);
    const B = new Builder(tx, tz);
    B.roofClutter = false;
    const h = f.h + SIDEWALK_H;
    B.solid(new Vector3(0, h / 2, 0), new Vector3(f.ww, h, f.dd));
    const b = this.finish(B, kind, hp);
    b.asset = { id: def.id, x: tx - f.ox, y: SIDEWALK_H, z: tz - f.oz, yaw };
    this.pending.push({ id: def.id, x: -f.ox, y: SIDEWALK_H, z: -f.oz, yaw, parent: b.root, cast: true });
    return b;
  }

  /** 区画の中で、正面を通り側へ寄せて建てる（街並みの壁面をそろえる） */
  private assetInLot(pool: AssetDef[], x: number, z: number, w: number, d: number, front: Vector3, kind: BuildingKind, minFill = 0.25): Building | null {
    const def = this.pickFit(pool, w, d, front, minFill);
    if (!def) return null;
    const f = this.footprint(def, Math.atan2(front.x, front.z));
    const room = Math.abs(front.x) > 0.5 ? (w - f.ww) / 2 : (d - f.dd) / 2;
    const push = Math.max(0, room - rand(0.6, 2.2));
    return this.placeAssetBuilding(def, x + front.x * push, z + front.z * push, front, kind);
  }

  /** 区画の正面に店を横一列に並べ、奥の余った所に建物を置く（商店街） */
  private shopRow(x: number, z: number, w: number, d: number, front: Vector3) {
    const P = this.pools!;
    const yaw = Math.atan2(front.x, front.z);
    const sideways = Math.abs(front.x) > 0.5;
    const len = sideways ? d : w; // 間口方向の長さ
    const depth = sideways ? w : d; // 奥行き方向の長さ
    const tan = new Vector3(front.z, 0, -front.x);
    let t = -len / 2 + 0.4;
    let maxDepth = 0;
    for (let guard = 0; guard < 12; guard++) {
      const def = pick(P.shop);
      const f = this.footprint(def, yaw);
      const wid = sideways ? f.dd : f.ww;
      const dep = sideways ? f.ww : f.dd;
      if (t + wid > len / 2 - 0.4 || dep > depth - 1) break;
      const off = depth / 2 - dep / 2 - 0.5;
      this.placeAssetBuilding(def, x + tan.x * (t + wid / 2) + front.x * off, z + tan.z * (t + wid / 2) + front.z * off, front, "shop", 300);
      maxDepth = Math.max(maxDepth, dep);
      t += wid + rand(0.3, 1.2);
    }
    // 奥: 残りの奥行きに住宅や小さなビル
    const rest = depth - maxDepth - 2.5;
    if (rest > 7) {
      const bx = x - front.x * (depth / 2 - rest / 2 - 0.4),
        bz = z - front.z * (depth / 2 - rest / 2 - 0.4);
      const bw = sideways ? rest : w,
        bd = sideways ? d : rest;
      this.assetInLot(Math.random() < 0.5 ? P.house : P.mid, bx, bz, bw, bd, front, "apartment", 0.15);
    }
  }

  /** ビル街・商店街の 1 区画（外部アセット版）。置けなければ false（従来の建物にする） */
  private assetLot(bl: Block, ring: number, x: number, z: number, w: number, d: number, front: Vector3, kind: BuildingKind): boolean {
    const P = this.pools!;
    if (kind === "garage") return false; // 立体駐車場は中に入れる手作りのまま
    if (kind === "shop") {
      this.shopRow(x, z, w, d, front);
      return true;
    }
    const big = w * d > 1400;
    let pool: AssetDef[];
    if (bl.kind === "business") pool = big || kind === "glass" ? P.tower : Math.random() < 0.5 ? P.tower : P.mid;
    else pool = Math.random() < 0.12 ? P.industrial : P.mid;
    const b = this.assetInLot(pool, x, z, w, d, front, kind, big ? 0.3 : 0.2) ?? this.assetInLot(P.mid, x, z, w, d, front, kind, 0.12);
    void ring;
    return !!b;
  }

  /** 遠景（マップの外周）: 簡略版（lod2）のビルを並べる */
  private assetSkyline() {
    const P = this.pools!;
    const tall = [...P.tower, ...P.mid];
    for (let k = 0; k < 110; k++) {
      const ang = (k / 110) * Math.PI * 2 + rand(-0.02, 0.02);
      const dist = rand(CITY_HALF + 35, 470);
      const def = pick(tall);
      const yaw = Math.round(rand(0, 4)) * (Math.PI / 2);
      this.pending.push({ id: def.id, x: Math.cos(ang) * dist, y: 0, z: Math.sin(ang) * dist, yaw, parent: null, states: ["lod2"] });
    }
  }

  /** 路上駐車の車（外部アセット版）。爆発で吹き飛ぶ動的ボディ */
  private assetCars() {
    const P = this.pools!;
    if (!P.car.length) return;
    let n = 0;
    for (const bl of this.blocks) {
      if (bl.kind === "plaza") continue;
      const count = 1 + ((Math.random() * 3) | 0);
      for (let k = 0; k < count; k++) {
        const side = (Math.random() * 4) | 0;
        let x = 0,
          z = 0,
          ry = 0;
        if (side === 0) (x = rand(bl.minX + 8, bl.maxX - 8)), (z = bl.maxZ + 2.2), (ry = Math.PI / 2);
        else if (side === 1) (x = rand(bl.minX + 8, bl.maxX - 8)), (z = bl.minZ - 2.2), (ry = -Math.PI / 2);
        else if (side === 2) (x = bl.maxX + 2.2), (z = rand(bl.minZ + 8, bl.maxZ - 8)), (ry = 0);
        else (x = bl.minX - 2.2), (z = rand(bl.minZ + 8, bl.maxZ - 8)), (ry = Math.PI);
        if (Math.abs(x - HIGHWAY_X) < 12) continue;
        const def = pick(P.car);
        const f = this.footprint(def, 0);
        const node = new TransformNode(`car_${n++}`, this.scene);
        node.position.set(x, f.h / 2 + 0.02, z);
        node.rotationQuaternion = Quaternion.FromEulerAngles(0, ry + rand(-0.06, 0.06), 0);
        const body = new PhysicsBody(node, PhysicsMotionType.DYNAMIC, true, this.scene);
        const w = f.ww,
          d = f.dd;
        const shape = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(w, f.h, d), this.scene);
        shape.filterMembershipMask = COL_STATIC;
        shape.filterCollideMask = COL_ALL;
        shape.material = { friction: 0.8, restitution: 0.1 };
        body.shape = shape;
        body.setMassProperties({ mass: 900 + w * d * f.h * 60 });
        body.setAngularDamping(0.3);
        this.cars.push({ mesh: node, body });
        this.pending.push({ id: def.id, x: -f.lcx, y: -f.h / 2, z: -f.lcz, yaw: 0, parent: node, cast: true, moving: true });
      }
    }
  }

  /** 小物を置く（id の候補から 1 つ） */
  private prop(ids: string[], x: number, z: number, yaw: number, y = SIDEWALK_H, cast = false) {
    const ok = ids.filter((i) => this.assets!.get(i));
    if (!ok.length) return;
    this.pending.push({ id: pick(ok), x, y, z, yaw, parent: null, cast });
  }

  /** 街路の設備・小物（外部アセット版）: 電柱と電線、信号、標識、街灯、バス停、自販機、ベンチなど */
  private assetStreet() {
    const I = (n: number[]) => n.map((k) => `infra_${String(k).padStart(3, "0")}`);
    const Pp = (n: number[]) => n.map((k) => `prop_${String(k).padStart(3, "0")}`);
    const S = (n: number[]) => n.map((k) => `ssv_${String(k).padStart(3, "0")}`);
    const poles = I([61, 62, 63, 64, 66, 67, 68, 70]);
    // 電柱と電線: 住宅街と商店街の街区のまわり
    for (const bl of this.blocks) {
      if (bl.kind !== "residential" && bl.kind !== "mixed") continue;
      const inset = 0.8;
      const edges: [Vector3, Vector3][] = [
        [new Vector3(bl.minX + inset, 0, bl.minZ + inset), new Vector3(bl.maxX - inset, 0, bl.minZ + inset)],
        [new Vector3(bl.maxX - inset, 0, bl.minZ + inset), new Vector3(bl.maxX - inset, 0, bl.maxZ - inset)],
        [new Vector3(bl.maxX - inset, 0, bl.maxZ - inset), new Vector3(bl.minX + inset, 0, bl.maxZ - inset)],
        [new Vector3(bl.minX + inset, 0, bl.maxZ - inset), new Vector3(bl.minX + inset, 0, bl.minZ + inset)],
      ];
      for (const [a, b] of edges) {
        if (Math.abs(a.z - b.z) < 1 && Math.abs(Math.abs(a.z - AVENUE_Z) - ROAD_W_Z[3] / 2) < 2) continue;
        const len = Vector3.Distance(a, b);
        const n = Math.max(1, Math.round(len / 22));
        const dir = b.subtract(a).normalize();
        const yaw = Math.atan2(dir.x, dir.z) + Math.PI / 2;
        let prev: Vector3 | null = null;
        for (let k = 0; k <= n; k++) {
          if (k === n && n > 1) break;
          const p = Vector3.Lerp(a, b, k / n);
          this.prop(poles, p.x, p.z, yaw, SIDEWALK_H, true);
          if (prev) this.addWires(prev, p, yaw, 6.55);
          prev = p;
        }
        if (prev) this.addWires(prev, b, yaw, 6.55);
        // 住宅街の角にカーブミラー
        if (bl.kind === "residential" && Math.random() < 0.5) this.prop(I([89, 90]), a.x + dir.x * 1.5, a.z + dir.z * 1.5, yaw + Math.PI / 2);
      }
    }
    // 交差点: 信号機と標識（街区の四隅）
    for (const bl of this.blocks) {
      const corners: [number, number, number][] = [
        [bl.minX + 1.2, bl.minZ + 1.2, -Math.PI * 0.75],
        [bl.maxX - 1.2, bl.minZ + 1.2, Math.PI * 0.75],
        [bl.maxX - 1.2, bl.maxZ - 1.2, Math.PI * 0.25],
        [bl.minX + 1.2, bl.maxZ - 1.2, -Math.PI * 0.25],
      ];
      for (const [x, z, yaw] of corners) {
        const onAvenue = Math.abs(Math.abs(z - AVENUE_Z) - ROAD_W_Z[3] / 2 - 1.2) < 1.5;
        if (onAvenue) this.prop(I([1, 5, 8]), x, z, yaw, SIDEWALK_H, true);
        else if (Math.random() < 0.45) this.prop(I([2, 3, 4]), x, z, yaw, SIDEWALK_H, true);
        else if (Math.random() < 0.6) this.prop(I([11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]), x, z, yaw);
      }
    }
    // 街灯: ビル街・商店街の歩道
    for (const bl of this.blocks) {
      if (bl.kind === "plaza" || bl.kind === "residential") continue;
      const cx = (bl.minX + bl.maxX) / 2,
        cz = (bl.minZ + bl.maxZ) / 2;
      const lamps = bl.kind === "business" ? I([76, 77, 81]) : I([78, 85, 79]);
      for (const along of [-14, 14]) {
        for (const z of [bl.minZ + 0.8, bl.maxZ - 0.8]) this.prop(lamps, cx + along, z, z < cz ? Math.PI : 0, SIDEWALK_H, true);
        for (const x of [bl.minX + 0.8, bl.maxX - 0.8]) this.prop(lamps, x, cz + along, x < cx ? -Math.PI / 2 : Math.PI / 2, SIDEWALK_H, true);
      }
    }
    // 歩道の小物: 自販機・ベンチ・ごみ箱・ポスト・駐輪ラック・EV 充電・AED・案内端末
    const walk = Pp([51, 52, 41, 42, 47, 57, 60, 55, 53, 31]);
    for (const bl of this.blocks) {
      if (bl.kind === "plaza" || bl.kind === "park") continue;
      const cx = (bl.minX + bl.maxX) / 2,
        cz = (bl.minZ + bl.maxZ) / 2;
      const n = bl.kind === "residential" ? 3 : 7;
      for (let k = 0; k < n; k++) {
        const side = (Math.random() * 4) | 0;
        // 建物の側（内側）を向いて歩道の端に立つ
        if (side < 2) {
          const z = side === 0 ? bl.minZ + 2.9 : bl.maxZ - 2.9;
          this.prop(walk, rand(bl.minX + 5, bl.maxX - 5), z, z < cz ? 0 : Math.PI, SIDEWALK_H, true);
        } else {
          const x = side === 2 ? bl.minX + 2.9 : bl.maxX - 2.9;
          this.prop(walk, x, rand(bl.minZ + 5, bl.maxZ - 5), x < cx ? Math.PI / 2 : -Math.PI / 2, SIDEWALK_H, true);
        }
      }
      if (bl.kind === "business" && Math.random() < 0.6) this.prop(S([1, 2, 4, 8, 9]), bl.minX + 2.6, cz + rand(-10, 10), Math.PI / 2, SIDEWALK_H, true);
    }
    // 大通り: バス停と植え込み脇の防護柵
    const half = ROAD_W_Z[3] / 2;
    for (let k = 0; k < LINES.length - 1; k++) {
      if (Math.random() < 0.6) this.prop(I([87, 88, 86]), (LINES[k] + LINES[k + 1]) / 2 + rand(-8, 8), AVENUE_Z + half + 1.8, Math.PI, SIDEWALK_H, true);
      if (Math.random() < 0.6) this.prop(I([87, 88, 86]), (LINES[k] + LINES[k + 1]) / 2 + rand(-8, 8), AVENUE_Z - half - 1.8, 0, SIDEWALK_H, true);
    }
    // マンホール（車道）
    for (let k = 0; k < 60; k++) {
      const x = pick(LINES) + rand(-3, 3),
        z = rand(-240, 240);
      this.prop(I([44]), x, z, rand(0, 6.28), 0.0);
    }
  }

  /** 公園の遊具・ベンチ・水飲み台（外部アセット版） */
  private assetPark(cx: number, cz: number, W: number, D: number) {
    const Pp = (n: number[]) => n.map((k) => `prop_${String(k).padStart(3, "0")}`);
    const play = Pp([11, 12, 13, 14, 15, 16, 17, 10]);
    const ox = cx - W * 0.25,
      oz = cz - D * 0.22;
    for (let k = 0; k < 7; k++) this.prop(play, ox + rand(-8, 8), oz + rand(-7, 7), rand(0, 6.28), SIDEWALK_H, true);
    for (const [bx, bz, r] of [
      [cx + 6, cz + 2.8, Math.PI],
      [cx - 6, cz + 2.8, Math.PI],
      [cx + 6, cz - 2.8, 0],
      [cx - 6, cz - 2.8, 0],
      [cx + 2.8, cz + 8, -Math.PI / 2],
      [cx - 2.8, cz - 8, Math.PI / 2],
    ])
      this.prop(Pp([1, 1, 3]), bx, bz, r);
    this.prop(Pp([21]), cx + 3, cz + 3, 0);
    this.prop(Pp([41]), cx - 3, cz - 3, 0);
    this.prop(Pp([2]), cx + W * 0.28, cz + D * 0.3, 0.3);
    this.prop(Pp([23]), cx + W * 0.18, cz - D * 0.12, 0);
  }

  /** build() の後に呼ぶ: 必要なパックを読み込み、予約した位置にモデルを置く */
  async realizeAssets(onProgress?: (done: number, total: number) => void) {
    const A = this.assets;
    if (!A || !this.pending.length) return;
    await A.preload(new Set(this.pending.map((p) => p.id)), onProgress);
    for (const q of this.pending) {
      const p = A.place(q.id, q.x, q.y, q.z, q.yaw, q.parent, q.states);
      if (!p) continue;
      if (q.moving) p.isStatic = false;
      if (q.cast) for (const m of p.meshes) this.shadowCasters.push(m as unknown as Mesh);
    }
    this.pending = [];
    A.freezeStatic();
  }

  // ------------------------------------------------------------------ 空間グリッド
  private key(ix: number, iz: number) {
    return (ix + 100) * 1000 + (iz + 100);
  }

  private gridInsert(box: Box) {
    const x0 = Math.floor(box.minX / this.cell),
      x1 = Math.floor(box.maxX / this.cell);
    const z0 = Math.floor(box.minZ / this.cell),
      z1 = Math.floor(box.maxZ / this.cell);
    for (let ix = x0; ix <= x1; ix++)
      for (let iz = z0; iz <= z1; iz++) {
        const k = this.key(ix, iz);
        const arr = this.grid.get(k);
        if (arr) arr.push(box);
        else this.grid.set(k, [box]);
      }
  }

  /** XZ 矩形と重なる可能性のある箱（倒壊中・倒壊済みの建物は除く） */
  query(minX: number, minZ: number, maxX: number, maxZ: number, out: Box[] = []): Box[] {
    out.length = 0;
    this.stamp++;
    const x0 = Math.floor(minX / this.cell),
      x1 = Math.floor(maxX / this.cell);
    const z0 = Math.floor(minZ / this.cell),
      z1 = Math.floor(maxZ / this.cell);
    for (let ix = x0; ix <= x1; ix++)
      for (let iz = z0; iz <= z1; iz++) {
        const arr = this.grid.get(this.key(ix, iz));
        if (!arr) continue;
        for (const box of arr) {
          if (box.b.state !== "standing" || this.boxStamp.get(box) === this.stamp) continue;
          this.boxStamp.set(box, this.stamp);
          out.push(box);
        }
      }
    return out;
  }

  private tmp: Box[] = [];

  /**
   * 地点 (x,z) で、高さ fromY から下にある一番高い床面。
   * fromY を省略すると一番上の面（屋上）を返す（敵の壁登り用）。
   */
  heightAt(x: number, z: number, fromY = Infinity): number {
    const list = this.query(x, z, x, z, this.tmp);
    let h = this.sidewalkAt(x, z) ? SIDEWALK_H : 0;
    const lim = fromY + STEP_UP;
    for (const b of list) {
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      if (b.maxY <= lim && b.maxY > h) h = b.maxY;
    }
    return h;
  }

  sidewalkAt(x: number, z: number) {
    return this.blockAt(x, z) !== null;
  }

  /**
   * 円柱（半径 r, 足元 pos.y, 高さ height）を箱から水平に押し出す。
   * 足元から STEP_UP 以下の段差は乗り越えられるので押し出さない。
   */
  collideCircle(pos: Vector3, r: number, height: number): boolean {
    const list = this.query(pos.x - r, pos.z - r, pos.x + r, pos.z + r, this.tmp);
    let hit = false;
    for (const b of list) {
      if (b.maxY <= pos.y + STEP_UP || b.minY >= pos.y + height) continue;
      const qx = Math.max(b.minX, Math.min(pos.x, b.maxX));
      const qz = Math.max(b.minZ, Math.min(pos.z, b.maxZ));
      const dx = pos.x - qx,
        dz = pos.z - qz;
      const d2 = dx * dx + dz * dz;
      if (d2 > r * r) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        pos.x = qx + (dx / d) * r;
        pos.z = qz + (dz / d) * r;
      } else {
        const pen = [pos.x - b.minX, b.maxX - pos.x, pos.z - b.minZ, b.maxZ - pos.z];
        const m = Math.min(...pen);
        if (m === pen[0]) pos.x = b.minX - r;
        else if (m === pen[1]) pos.x = b.maxX + r;
        else if (m === pen[2]) pos.z = b.minZ - r;
        else pos.z = b.maxZ + r;
      }
      hit = true;
    }
    return hit;
  }

  /** レイと地面・建物の交差。最も近いものを返す */
  raycast(origin: Vector3, dir: Vector3, maxDist: number): RayHit | null {
    let best: RayHit | null = null;
    if (dir.y < -1e-6) {
      const t = -origin.y / dir.y;
      if (t >= 0 && t <= maxDist) best = { dist: t, point: origin.add(dir.scale(t)), normal: Vector3.Up(), building: null };
    }
    const lim = best ? best.dist : maxDist;
    const ex = origin.x + dir.x * lim,
      ez = origin.z + dir.z * lim;
    const list = this.query(Math.min(origin.x, ex), Math.min(origin.z, ez), Math.max(origin.x, ex), Math.max(origin.z, ez), this.tmp);
    for (const b of list) {
      const r = this.rayBox(origin, dir, b);
      if (r && r.t <= (best ? best.dist : maxDist)) {
        best = { dist: r.t, point: origin.add(dir.scale(r.t)), normal: r.n, building: b.b };
      }
    }
    return best;
  }

  /** 線分 a→b の衝突（弾の移動判定用） */
  segment(a: Vector3, b: Vector3): RayHit | null {
    const d = b.subtract(a);
    const len = d.length();
    if (len < 1e-6) return null;
    return this.raycast(a, d.scaleInPlace(1 / len), len);
  }

  private rayBox(o: Vector3, d: Vector3, b: Box): { t: number; n: Vector3 } | null {
    const min = [b.minX, b.minY, b.minZ];
    const max = [b.maxX, b.maxY, b.maxZ];
    const oo = [o.x, o.y, o.z];
    const dd = [d.x, d.y, d.z];
    let tmin = 0,
      tmax = Infinity,
      axis = -1,
      sign = 0;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(dd[i]) < 1e-9) {
        if (oo[i] < min[i] || oo[i] > max[i]) return null;
        continue;
      }
      const inv = 1 / dd[i];
      let t1 = (min[i] - oo[i]) * inv;
      let t2 = (max[i] - oo[i]) * inv;
      let s = -1;
      if (t1 > t2) {
        [t1, t2] = [t2, t1];
        s = 1;
      }
      if (t1 > tmin) {
        tmin = t1;
        axis = i;
        sign = s;
      }
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
    if (axis < 0) return { t: 0, n: d.scale(-1) };
    return { t: tmin, n: new Vector3(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0) };
  }

  // ------------------------------------------------------------------ 破壊
  damageBuilding(b: Building, dmg: number) {
    if (b.state !== "standing") return;
    b.hp -= dmg;
    if (b.hp <= 0) this.startCollapse(b);
  }

  /** 球の範囲内の建物にダメージ */
  damageArea(center: Vector3, radius: number, dmg: number) {
    const list = this.query(center.x - radius, center.z - radius, center.x + radius, center.z + radius, []);
    const done = new Set<Building>();
    for (const box of list) {
      if (done.has(box.b)) continue;
      const qx = Math.max(box.minX, Math.min(center.x, box.maxX));
      const qy = Math.max(box.minY, Math.min(center.y, box.maxY));
      const qz = Math.max(box.minZ, Math.min(center.z, box.maxZ));
      const d = Math.hypot(center.x - qx, center.y - qy, center.z - qz);
      if (d < radius) {
        done.add(box.b);
        this.damageBuilding(box.b, dmg * (1 - (d / radius) * 0.5));
      }
    }
  }

  private startCollapse(b: Building) {
    b.state = "collapsing";
    b.collapseT = 0;
    for (const n of b.root.getDescendants(false)) if (n instanceof TransformNode) n.unfreezeWorldMatrix();
    if (b.body) {
      b.body.shape?.dispose();
      b.body.dispose();
      b.body = null;
    }
    this.onCollapseStart?.(b);
  }

  update(dt: number) {
    for (const b of this.buildings) {
      if (b.state !== "collapsing") continue;
      b.collapseT += dt;
      // 爆発の後、短時間で一気に崩れ落ちる
      const dur = 1.6 + b.height * 0.012;
      const k = Math.min(1, b.collapseT / dur);
      const sink = b.height * k * k * 1.05;
      b.root.position.y = -sink;
      const shake = (1 - k) * 0.4;
      const sx = (Math.random() - 0.5) * shake,
        sz = (Math.random() - 0.5) * shake;
      b.root.position.x = b.cx + sx;
      b.root.position.z = b.cz + sz;
      if (b.thin.length) {
        const off = Matrix.Translation(sx, -sink, sz);
        const touched = new Set<PropBatch>();
        for (const t of b.thin) {
          if (k >= 1) t.batch.hide(t.idx);
          else t.batch.setMatrix(t.idx, t.batch.base(t.idx).multiply(off), false);
          touched.add(t.batch);
        }
        for (const bt of touched) bt.mesh.thinInstanceBufferUpdated("matrix");
      }
      if (k >= 1) {
        b.state = "gone";
        b.root.dispose();
        if (b.asset && this.assets) {
          // 外部アセットの建物は、壊れた状態のモデル（wreck）に差し替える
          const a = b.asset;
          const p = this.assets.place(a.id, a.x, a.y, a.z, a.yaw, null, ["wreck"]);
          if (p) {
            p.wrecked = true;
            p.show("wreck");
            this.onCollapseEnd?.(b);
            continue;
          }
        }
        const rub = MeshBuilder.CreateCylinder(
          "rubble",
          { diameterTop: Math.min(b.hw, b.hd) * 0.6, diameterBottom: Math.max(b.hw, b.hd) * 2.1, height: 2.2, tessellation: 7 },
          this.scene,
        );
        rub.scaling.z = b.hd / Math.max(0.1, b.hw);
        rub.position.set(b.cx, 0.6, b.cz);
        rub.rotation.y = Math.random() * Math.PI;
        rub.material = this.mats.rubble;
        rub.receiveShadows = true;
        rub.freezeWorldMatrix();
        this.onCollapseEnd?.(b);
      }
    }
  }

  clampToMap(p: Vector3, margin = 2) {
    const lim = CITY_HALF - margin;
    p.x = Math.max(-lim, Math.min(lim, p.x));
    p.z = Math.max(-lim, Math.min(lim, p.z));
  }

  /** 開けた地面の上の位置か（建物の中ではない） */
  isOpen(x: number, z: number, r = 2): boolean {
    const list = this.query(x - r, z - r, x + r, z + r, this.tmp);
    for (const b of list) if (x > b.minX - r && x < b.maxX + r && z > b.minZ - r && z < b.maxZ + r) return false;
    return true;
  }
}
