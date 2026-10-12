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
  InstancedMesh,
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

export const CITY_HALF = 250;
const PITCH = 72;
const ROAD = 16;
const BLOCK = PITCH - ROAD; // 56
const SIDEWALK_H = 0.12;
const BLOCK_RANGE = 3; // -3..3 の 7x7 街区
/** プレイヤーが乗り越えられる段差 */
export const STEP_UP = 0.6;

export type BuildingKind = "office" | "glass" | "apartment" | "garage" | "shop" | "monument";

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
}

export interface RayHit {
  dist: number;
  point: Vector3;
  normal: Vector3;
  building: Building | null;
}

export interface Car {
  mesh: InstancedMesh;
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
  private concrete: PBRMaterial;
  private awnings: PBRMaterial[];

  constructor(
    private scene: Scene,
    private mats: CityMaterials,
  ) {
    this.concrete = mats.roof;
    this.awnings = [new Color3(0.55, 0.08, 0.06), new Color3(0.08, 0.25, 0.45), new Color3(0.12, 0.35, 0.15)].map((c, i) => {
      const m = new PBRMaterial("awning" + i, scene);
      m.albedoColor = c;
      m.roughness = 0.8;
      m.metallic = 0;
      return m;
    });
  }

  build() {
    this.buildGround();
    this.carTemplates = this.createCarTemplates();
    this.buildBlocks();
    this.buildMarkings();
    this.buildLamps();
    this.buildCars();
    this.buildSkyline();
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

  private blockCenters(): [number, number, number, number][] {
    const out: [number, number, number, number][] = [];
    for (let i = -BLOCK_RANGE; i <= BLOCK_RANGE; i++)
      for (let j = -BLOCK_RANGE; j <= BLOCK_RANGE; j++) out.push([i * PITCH, j * PITCH, i, j]);
    return out;
  }

  private buildBlocks() {
    // 歩道（街区の台座）: 全街区同じ大きさなので thin instance で1回の描画
    const sw = uvBox(this.scene, BLOCK, SIDEWALK_H, BLOCK, 3);
    sw.material = this.mats.sidewalk;
    sw.receiveShadows = true;
    const swMats: Matrix[] = [];
    for (const [cx, cz, i, j] of this.blockCenters()) {
      if (i === 0 && j === 0) {
        // 中央はプレイヤー初期位置の広場
        const plaza = uvBox(this.scene, BLOCK, SIDEWALK_H, BLOCK, 4);
        plaza.position.set(cx, SIDEWALK_H / 2, cz);
        plaza.material = this.mats.plaza;
        plaza.receiveShadows = true;
        plaza.freezeWorldMatrix();
        this.buildMonument(cx, cz - 14);
        continue;
      }
      swMats.push(Matrix.Translation(cx, SIDEWALK_H / 2, cz));
      this.fillBlock(cx, cz, Math.max(Math.abs(i), Math.abs(j)));
    }
    sw.thinInstanceAdd(swMats);
    sw.freezeWorldMatrix();
  }

  /** 広場の記念碑（低い遮蔽物） */
  private buildMonument(x: number, z: number) {
    const B = new Builder(x, z);
    const base = MeshBuilder.CreateBox("monument", { width: 4, height: 1.2, depth: 4 }, this.scene);
    base.material = this.concrete;
    B.part(base, new Vector3(0, 0.6, 0), new Vector3(4, 1.2, 4));
    const pillar = MeshBuilder.CreateBox("monument2", { width: 1.2, height: 7, depth: 1.2 }, this.scene);
    pillar.material = this.mats.metal;
    B.part(pillar, new Vector3(0, 4.7, 0), new Vector3(1.2, 7, 1.2));
    this.finish(B, "monument", 1e9);
  }

  /** 1つの街区に建物を並べる */
  private fillBlock(cx: number, cz: number, ring: number) {
    const inner = BLOCK - 8; // 歩道幅 4m
    const layout = Math.random();
    const lots: [number, number, number, number][] = []; // x, z, w, d
    const g = 3;
    const half = (inner - g) / 2;
    if (layout < 0.2) {
      lots.push([cx, cz, inner, inner]);
    } else if (layout < 0.55) {
      if (Math.random() < 0.5) lots.push([cx - (half + g) / 2, cz, half, inner], [cx + (half + g) / 2, cz, half, inner]);
      else lots.push([cx, cz - (half + g) / 2, inner, half], [cx, cz + (half + g) / 2, inner, half]);
    } else {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) lots.push([cx + (sx * (half + g)) / 2, cz + (sz * (half + g)) / 2, half, half]);
    }
    for (const [x, z, w, d] of lots) {
      if (Math.random() < 0.06) continue; // 空き地
      const r = Math.random();
      // 中心ほど高層ビルが多い
      const kind: BuildingKind =
        ring <= 1
          ? r < 0.3
            ? "glass"
            : r < 0.6
              ? "office"
              : r < 0.75
                ? "apartment"
                : r < 0.88
                  ? "garage"
                  : "shop"
          : r < 0.14
            ? "glass"
            : r < 0.34
              ? "office"
              : r < 0.62
                ? "apartment"
                : r < 0.8
                  ? "garage"
                  : "shop";
      const bw = w * rand(0.75, 0.95);
      const bd = d * rand(0.75, 0.95);
      const px = x + rand(-1, 1),
        pz = z + rand(-1, 1);
      switch (kind) {
        case "glass":
          this.buildTower(px, pz, bw, bd, ring);
          break;
        case "office":
          this.buildBoxBuilding(px, pz, bw, bd, Math.round(rand(4, 11)), "office", "office");
          break;
        case "apartment":
          this.buildApartment(px, pz, bw, bd);
          break;
        case "garage":
          this.buildGarage(px, pz, Math.min(bw, 34), Math.min(bd, 34));
          break;
        case "shop":
          this.buildShops(px, pz, bw, bd);
          break;
      }
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
    new SubMesh(0, 0, verts, 0, 24, mesh);
    new SubMesh(1, 0, verts, 24, 6, mesh);
    new SubMesh(0, 0, verts, 30, 6, mesh);
    mesh.material = multi;
    return mesh;
  }

  private snap(v: number, style: FacadeStyle) {
    const span = FACADE_SPECS[style].tileW / 2;
    return Math.max(span * 2, Math.round(v / span) * span);
  }

  private buildBoxBuilding(x: number, z: number, w: number, d: number, floors: number, style: FacadeStyle, kind: BuildingKind) {
    const B = new Builder(x, z);
    w = this.snap(w, style);
    d = this.snap(d, style);
    const h = Math.max(2, floors) * (FACADE_SPECS[style].tileH / 2);
    B.part(this.facadeBox(w, h, d, style), new Vector3(0, h / 2, 0), new Vector3(w, h, d));
    this.finish(B, kind);
  }

  /** ガラスの高層ビル。半分はセットバック（低層部の上に細い塔） */
  private buildTower(x: number, z: number, w: number, d: number, ring: number) {
    const floors = Math.round(rand(9, 18) - ring);
    if (Math.random() < 0.5 || w < 20 || d < 20) {
      this.buildBoxBuilding(x, z, w, d, floors, "glass", "glass");
      return;
    }
    const B = new Builder(x, z);
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
  private buildApartment(x: number, z: number, w: number, d: number) {
    const B = new Builder(x, z);
    const spec = FACADE_SPECS.brick;
    w = this.snap(w, "brick");
    d = this.snap(Math.min(d, 18), "brick") - 2.8; // ベランダの分だけ奥行きを詰める
    const floors = Math.round(rand(3, 7));
    const fh = spec.tileH / 2;
    const h = floors * fh;
    B.part(this.facadeBox(w, h, d, "brick"), new Vector3(0, h / 2, 0), new Vector3(w, h, d));
    const side = Math.random() < 0.5 ? 1 : -1;
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
  private buildShops(x: number, z: number, w: number, d: number) {
    const B = new Builder(x, z);
    w = this.snap(w, "office");
    d = this.snap(Math.min(d, 14), "office");
    const fh = FACADE_SPECS.office.tileH / 2;
    const h = Math.round(rand(1, 2)) * fh;
    B.part(this.facadeBox(w, h, d, Math.random() < 0.5 ? "office" : "brick"), new Vector3(0, h / 2, 0), new Vector3(w, h, d));
    const side = Math.random() < 0.5 ? 1 : -1;
    // 店先のガラス
    const front = MeshBuilder.CreateBox("shopFront", { width: w - 0.6, height: 2.4, depth: 0.1 }, this.scene);
    front.material = this.mats.glassDark;
    B.part(front, new Vector3(0, 1.4, side * (d / 2 + 0.06)), Vector3.Zero(), false);
    // ひさし
    const aw = MeshBuilder.CreateBox("awning", { width: w - 0.4, height: 0.12, depth: 1.8 }, this.scene);
    aw.rotation.x = side * 0.18;
    aw.material = pick(this.awnings);
    B.part(aw, new Vector3(0, 3.0, side * (d / 2 + 0.9)), new Vector3(w - 0.4, 0.2, 1.8));
    this.finish(B, "shop");
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
    };
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
    const dash = MeshBuilder.CreateBox("dash", { width: 0.18, height: 0.02, depth: 3 }, this.scene);
    dash.material = this.mats.marking;
    dash.receiveShadows = true;
    const stripe = MeshBuilder.CreateBox("stripe", { width: 0.5, height: 0.02, depth: 4 }, this.scene);
    stripe.material = this.mats.marking;
    stripe.receiveShadows = true;
    const dm: Matrix[] = [];
    const sm: Matrix[] = [];
    const lines: number[] = [];
    for (let k = -BLOCK_RANGE; k <= BLOCK_RANGE + 1; k++) lines.push(k * PITCH - PITCH / 2);
    const extent = (BLOCK_RANGE + 0.5) * PITCH;
    const rotY = Matrix.RotationY(Math.PI / 2);
    for (const l of lines) {
      for (let p = -extent; p < extent; p += 7) {
        const local = (((p + PITCH / 2) % PITCH) + PITCH) % PITCH;
        if (local < ROAD / 2 + 4 || local > PITCH - ROAD / 2 - 4) continue;
        dm.push(Matrix.Translation(l, 0.012, p));
        dm.push(rotY.multiply(Matrix.Translation(p, 0.012, l)));
      }
    }
    for (const lx of lines)
      for (const lz of lines) {
        for (let s = -6; s <= 6; s += 1.2) {
          sm.push(Matrix.Translation(lx + s, 0.012, lz + ROAD / 2 + 3));
          sm.push(Matrix.Translation(lx + s, 0.012, lz - ROAD / 2 - 3));
          sm.push(rotY.multiply(Matrix.Translation(lx + ROAD / 2 + 3, 0.012, lz + s)));
          sm.push(rotY.multiply(Matrix.Translation(lx - ROAD / 2 - 3, 0.012, lz + s)));
        }
      }
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
    for (const [cx, cz, i, j] of this.blockCenters()) {
      if (i === 0 && j === 0) continue;
      const e = BLOCK / 2 - 0.8;
      for (const s of [-1, 1]) {
        for (const along of [-14, 14]) {
          pm.push(Matrix.Translation(cx + along, 3.5, cz + s * e));
          hm.push(Matrix.Translation(cx + along, 7, cz + s * (e + 0.6)));
          pm.push(Matrix.Translation(cx + s * e, 3.5, cz + along));
          hm.push(Matrix.RotationY(Math.PI / 2).multiply(Matrix.Translation(cx + s * (e + 0.6), 7, cz + along)));
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
    for (const [cx, cz] of this.blockCenters()) {
      const count = (Math.random() * 3) | 0;
      for (let k = 0; k < count; k++) {
        const side = (Math.random() * 4) | 0;
        const along = rand(-20, 20);
        const off = BLOCK / 2 + 2.2;
        let x = cx,
          z = cz,
          ry = 0;
        if (side === 0) (x = cx + along), (z = cz + off), (ry = Math.PI / 2 + (Math.random() < 0.5 ? 0 : Math.PI));
        else if (side === 1) (x = cx + along), (z = cz - off), (ry = Math.PI / 2);
        else if (side === 2) (x = cx + off), (z = cz + along), (ry = 0);
        else (x = cx - off), (z = cz + along), (ry = Math.PI);
        if (Math.abs(x) < 20 && Math.abs(z) < 30) continue;
        const inst = pick(this.carTemplates).createInstance(`car_${n++}`);
        inst.position.set(x, 0.8, z);
        inst.rotationQuaternion = Quaternion.FromEulerAngles(0, ry + rand(-0.1, 0.1), 0);
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
    const lx = (((x + PITCH / 2) % PITCH) + PITCH) % PITCH;
    const lz = (((z + PITCH / 2) % PITCH) + PITCH) % PITCH;
    const inBlock = lx > ROAD / 2 && lx < PITCH - ROAD / 2 && lz > ROAD / 2 && lz < PITCH - ROAD / 2;
    return inBlock && Math.abs(x) < (BLOCK_RANGE + 0.5) * PITCH && Math.abs(z) < (BLOCK_RANGE + 0.5) * PITCH;
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
    for (const m of b.root.getChildMeshes()) m.unfreezeWorldMatrix();
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
      b.root.position.x = b.cx + (Math.random() - 0.5) * shake;
      b.root.position.z = b.cz + (Math.random() - 0.5) * shake;
      if (k >= 1) {
        b.state = "gone";
        b.root.dispose();
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
