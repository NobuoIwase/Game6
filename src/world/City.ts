// ============================================================================
// 市街地マップの生成と、静的な当たり判定（建物 AABB）。
// ----------------------------------------------------------------------------
// ・碁盤目状の街区に、オフィスビル / レンガのアパート / ガラス張りの高層ビルを配置
// ・建物は耐久値を持ち、爆発や銃撃で倒壊する（地球防衛軍らしさ）
// ・敵やプレイヤーの移動・弾の当たり判定はこのクラスの関数で行う（物理エンジン不要で軽い）
// ・ラグドールや車が建物にぶつかるよう、建物には Havok の静的ボディも付ける
// ============================================================================
import {
  InstancedMesh,
  Matrix,
  Mesh,
  MeshBuilder,
  MultiMaterial,
  PhysicsBody,
  PhysicsMotionType,
  PhysicsShapeBox,
  Quaternion,
  Scene,
  SubMesh,
  Texture,
  TransformNode,
  Vector3,
  Vector4,
} from "@babylonjs/core";
import { CityMaterials, FACADE_SPECS, FacadeStyle } from "./Materials";
import { COL_STATIC, COL_ALL } from "../core/Physics";

export const CITY_HALF = 250;
const PITCH = 72;
const ROAD = 16;
const BLOCK = PITCH - ROAD; // 56
const SIDEWALK_H = 0.12;
const BLOCK_RANGE = 3; // -3..3 の 7x7 街区

export interface Building {
  id: number;
  mesh: Mesh;
  body: PhysicsBody | null;
  cx: number;
  cz: number;
  hw: number; // 半幅 x
  hd: number; // 半幅 z
  height: number;
  /** 現在の屋上の高さ（倒壊中は下がる） */
  top: number;
  hp: number;
  maxHp: number;
  state: "standing" | "collapsing" | "gone";
  collapseT: number;
  style: FacadeStyle;
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

export class City {
  buildings: Building[] = [];
  cars: Car[] = [];
  private grid = new Map<number, Building[]>();
  private readonly cell = 36;
  private stamp = 0;
  private stamps = new Map<Building, number>();
  /** 倒壊開始時に呼ばれる（土煙などの演出用） */
  onCollapseStart?: (b: Building) => void;
  onCollapseEnd?: (b: Building) => void;
  shadowCasters: Mesh[] = [];

  constructor(
    private scene: Scene,
    private mats: CityMaterials,
  ) {}

  build() {
    this.buildGround();
    this.buildBlocks();
    this.buildMarkings();
    this.buildLamps();
    this.buildCars();
    this.buildSkyline();
  }

  // ------------------------------------------------------------------ 生成
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

    // 物理用の地面
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
    const sw = MeshBuilder.CreateBox(
      "sidewalk",
      {
        width: BLOCK,
        height: SIDEWALK_H,
        depth: BLOCK,
        faceUV: [
          new Vector4(0, 0, BLOCK / 3, 0.05),
          new Vector4(0, 0, BLOCK / 3, 0.05),
          new Vector4(0, 0, BLOCK / 3, 0.05),
          new Vector4(0, 0, BLOCK / 3, 0.05),
          new Vector4(0, 0, BLOCK / 3, BLOCK / 3),
          new Vector4(0, 0, 1, 1),
        ],
      },
      this.scene,
    );
    sw.material = this.mats.sidewalk;
    sw.receiveShadows = true;
    const swMats: Matrix[] = [];
    for (const [cx, cz, i, j] of this.blockCenters()) {
      if (i === 0 && j === 0) {
        // 中央はプレイヤー初期位置の広場
        const plaza = MeshBuilder.CreateBox(
          "plaza",
          {
            width: BLOCK,
            height: SIDEWALK_H,
            depth: BLOCK,
            faceUV: [...Array(4).fill(new Vector4(0, 0, BLOCK / 4, 0.05)), new Vector4(0, 0, BLOCK / 4, BLOCK / 4), new Vector4(0, 0, 1, 1)],
          },
          this.scene,
        );
        plaza.position.set(cx, SIDEWALK_H / 2, cz);
        plaza.material = this.mats.plaza;
        plaza.receiveShadows = true;
        plaza.freezeWorldMatrix();
        this.buildPlazaProps(cx, cz);
        continue;
      }
      swMats.push(Matrix.Translation(cx, SIDEWALK_H / 2, cz));
      this.fillBlock(cx, cz, Math.max(Math.abs(i), Math.abs(j)));
    }
    sw.thinInstanceAdd(swMats);
    sw.freezeWorldMatrix();
  }

  private buildPlazaProps(cx: number, cz: number) {
    // 広場の中央に低い記念碑（遮蔽物）
    const mon = MeshBuilder.CreateBox("monument", { width: 4, height: 1.2, depth: 4 }, this.scene);
    mon.position.set(cx, 0.6, cz - 14);
    mon.material = this.mats.roof;
    mon.receiveShadows = true;
    this.shadowCasters.push(mon);
    const pillar = MeshBuilder.CreateBox("monument2", { width: 1.2, height: 7, depth: 1.2 }, this.scene);
    pillar.position.set(cx, 4.7, cz - 14);
    pillar.material = this.mats.metal;
    this.shadowCasters.push(pillar);
    this.addBuildingRaw(cx, cz - 14, 2, 2, 1.2, mon, "office", 99999);
  }

  /** 1つの街区に建物を並べる */
  private fillBlock(cx: number, cz: number, ring: number) {
    const inner = BLOCK - 8; // 歩道幅 4m
    const layout = Math.random();
    const lots: [number, number, number, number][] = []; // x, z, w, d
    if (layout < 0.25) {
      lots.push([cx, cz, inner, inner]);
    } else if (layout < 0.6) {
      const g = 3,
        w = (inner - g) / 2;
      if (Math.random() < 0.5) {
        lots.push([cx - (w + g) / 2, cz, w, inner], [cx + (w + g) / 2, cz, w, inner]);
      } else {
        lots.push([cx, cz - (w + g) / 2, inner, w], [cx, cz + (w + g) / 2, inner, w]);
      }
    } else {
      const g = 3,
        w = (inner - g) / 2;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) lots.push([cx + (sx * (w + g)) / 2, cz + (sz * (w + g)) / 2, w, w]);
    }
    for (const [x, z, w, d] of lots) {
      if (Math.random() < 0.08) continue; // 空き地
      // 中心に近いほど高層ビルが多い
      const r = Math.random();
      const style: FacadeStyle = ring <= 1 ? (r < 0.5 ? "glass" : "office") : r < 0.3 ? "glass" : r < 0.65 ? "office" : "brick";
      // ロットより少し小さく
      const bw = w * rand(0.72, 0.95);
      const bd = d * rand(0.72, 0.95);
      const spec = FACADE_SPECS[style];
      const floorH = spec.tileH / 2;
      const floors =
        style === "glass" ? Math.round(rand(9, 18) - ring) : style === "office" ? Math.round(rand(4, 11)) : Math.round(rand(3, 7));
      const h = Math.max(3, floors) * floorH;
      this.addBuilding(x + rand(-1, 1), z + rand(-1, 1), bw, bd, h, style);
    }
  }

  private addBuilding(cx: number, cz: number, w: number, d: number, h: number, style: FacadeStyle) {
    const spec = FACADE_SPECS[style];
    // 窓が途中で切れないよう幅を半タイル（1スパン）単位に丸める
    const span = spec.tileW / 2;
    w = Math.max(span * 2, Math.round(w / span) * span);
    d = Math.max(span * 2, Math.round(d / span) * span);
    const uw = w / spec.tileW,
      ud = d / spec.tileW,
      vh = h / spec.tileH;
    const mesh = MeshBuilder.CreateBox(
      "bld",
      {
        width: w,
        height: h,
        depth: d,
        wrap: true,
        faceUV: [
          new Vector4(0, 0, uw, vh),
          new Vector4(0, 0, uw, vh),
          new Vector4(0, 0, ud, vh),
          new Vector4(0, 0, ud, vh),
          new Vector4(0, 0, w / 4, d / 4),
          new Vector4(0, 0, 1, 1),
        ],
      },
      this.scene,
    );
    // 側面と屋上でマテリアルを分ける（Box の面順: 0..3 側面, 4 上, 5 下）
    const facade = pick(this.mats.facades.filter((f) => f.style === style)).mat;
    const multi = new MultiMaterial("bldMat", this.scene);
    multi.subMaterials.push(facade, this.mats.roof);
    mesh.subMeshes = [];
    const verts = mesh.getTotalVertices();
    new SubMesh(0, 0, verts, 0, 24, mesh);
    new SubMesh(1, 0, verts, 24, 6, mesh);
    new SubMesh(0, 0, verts, 30, 6, mesh);
    mesh.material = multi;
    mesh.position.set(cx, h / 2, cz);
    mesh.receiveShadows = true;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    this.shadowCasters.push(mesh);
    const hp = 350 + w * d * h * 0.06;
    this.addBuildingRaw(cx, cz, w / 2, d / 2, h, mesh, style, hp);
  }

  private addBuildingRaw(cx: number, cz: number, hw: number, hd: number, h: number, mesh: Mesh, style: FacadeStyle, hp: number) {
    const body = new PhysicsBody(mesh, PhysicsMotionType.STATIC, false, this.scene);
    const shape = new PhysicsShapeBox(
      Vector3.Zero(),
      Quaternion.Identity(),
      new Vector3(hw * 2, h, hd * 2),
      this.scene,
    );
    shape.filterMembershipMask = COL_STATIC;
    shape.filterCollideMask = COL_ALL;
    shape.material = { friction: 0.7, restitution: 0.05 };
    body.shape = shape;
    const b: Building = {
      id: this.buildings.length,
      mesh,
      body,
      cx,
      cz,
      hw,
      hd,
      height: h,
      top: h,
      hp,
      maxHp: hp,
      state: "standing",
      collapseT: 0,
      style,
    };
    this.buildings.push(b);
    this.gridInsert(b);
  }

  private buildMarkings() {
    // 道路の白線（中央の破線）と横断歩道。thin instance で軽量に描画。
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
        // 交差点内は描かない
        const local = ((p + PITCH / 2) % PITCH + PITCH) % PITCH;
        if (local < ROAD / 2 + 4 || local > PITCH - ROAD / 2 - 4) continue;
        dm.push(Matrix.Translation(l, 0.012, p));
        dm.push(rotY.multiply(Matrix.Translation(p, 0.012, l)));
      }
    }
    // 横断歩道
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
          // x 方向の道沿い
          pm.push(Matrix.Translation(cx + along, 3.5, cz + s * e));
          hm.push(Matrix.Translation(cx + along, 7, cz + s * (e + 0.6)));
          // z 方向の道沿い（90度回転）
          pm.push(Matrix.Translation(cx + s * e, 3.5, cz + along));
          hm.push(Matrix.RotationY(Math.PI / 2).multiply(Matrix.Translation(cx + s * (e + 0.6), 7, cz + along)));
        }
      }
    }
    pole.thinInstanceAdd(pm);
    head.thinInstanceAdd(hm);
    this.shadowCasters.push(pole);
  }

  /** 車: 爆発で吹き飛ぶよう Havok の動的ボディ（初期はスリープ） */
  private buildCars() {
    const templates: Mesh[] = this.mats.carPaints.map((paint, i) => {
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
      // 原点を車体中心へ
      merged.bakeTransformIntoVertices(Matrix.Translation(0, -0.8, 0));
      merged.receiveShadows = true;
      merged.isVisible = true;
      merged.position.y = -1000; // テンプレート自体は隠す
      this.shadowCasters.push(merged);
      return merged;
    });

    let n = 0;
    for (const [cx, cz] of this.blockCenters()) {
      // 各街区の周囲の道路脇に駐車
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
        const inst = pick(templates).createInstance(`car_${n++}`);
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
      const d = w;
      const h = Math.round(rand(6, 30)) * (spec.tileH / 2);
      const m = MeshBuilder.CreateBox(
        "far",
        {
          width: w,
          height: h,
          depth: d,
          wrap: true,
          faceUV: [
            ...Array(4).fill(new Vector4(0, 0, w / spec.tileW, h / spec.tileH)),
            new Vector4(0, 0, 1, 1),
            new Vector4(0, 0, 1, 1),
          ],
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

  private gridInsert(b: Building) {
    const x0 = Math.floor((b.cx - b.hw) / this.cell),
      x1 = Math.floor((b.cx + b.hw) / this.cell);
    const z0 = Math.floor((b.cz - b.hd) / this.cell),
      z1 = Math.floor((b.cz + b.hd) / this.cell);
    for (let ix = x0; ix <= x1; ix++)
      for (let iz = z0; iz <= z1; iz++) {
        const k = this.key(ix, iz);
        const arr = this.grid.get(k) ?? [];
        arr.push(b);
        this.grid.set(k, arr);
      }
  }

  /** XZ 矩形と重なる可能性のある建物 */
  query(minX: number, minZ: number, maxX: number, maxZ: number, out: Building[] = []): Building[] {
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
        for (const b of arr) {
          if (b.state === "gone" || this.stamps.get(b) === this.stamp) continue;
          this.stamps.set(b, this.stamp);
          out.push(b);
        }
      }
    return out;
  }

  private tmp: Building[] = [];

  /** 地点 (x,z) の地表の高さ（建物の上なら屋上の高さ） */
  heightAt(x: number, z: number): number {
    const list = this.query(x, z, x, z, this.tmp);
    let h = this.sidewalkAt(x, z) ? SIDEWALK_H : 0;
    for (const b of list) {
      if (Math.abs(x - b.cx) <= b.hw && Math.abs(z - b.cz) <= b.hd) h = Math.max(h, b.top);
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
   * 円（半径 r, 足元の高さ y, 身長 h）を建物から押し出す。
   * 押し出した場合 true。
   */
  collideCircle(pos: Vector3, r: number, height: number): boolean {
    const list = this.query(pos.x - r, pos.z - r, pos.x + r, pos.z + r, this.tmp);
    let hit = false;
    for (const b of list) {
      if (pos.y >= b.top - 0.05 || pos.y + height < 0) continue;
      const minX = b.cx - b.hw,
        maxX = b.cx + b.hw,
        minZ = b.cz - b.hd,
        maxZ = b.cz + b.hd;
      const qx = Math.max(minX, Math.min(pos.x, maxX));
      const qz = Math.max(minZ, Math.min(pos.z, maxZ));
      let dx = pos.x - qx,
        dz = pos.z - qz;
      const d2 = dx * dx + dz * dz;
      if (d2 > r * r) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        pos.x = qx + (dx / d) * r;
        pos.z = qz + (dz / d) * r;
      } else {
        // 中心が内部: 最も近い辺へ押し出す
        const pen = [pos.x - minX, maxX - pos.x, pos.z - minZ, maxZ - pos.z];
        const m = Math.min(...pen);
        if (m === pen[0]) pos.x = minX - r;
        else if (m === pen[1]) pos.x = maxX + r;
        else if (m === pen[2]) pos.z = minZ - r;
        else pos.z = maxZ + r;
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
    const end = origin.add(dir.scale(best ? best.dist : maxDist));
    const list = this.query(Math.min(origin.x, end.x), Math.min(origin.z, end.z), Math.max(origin.x, end.x), Math.max(origin.z, end.z), this.tmp);
    for (const b of list) {
      const r = this.rayBox(origin, dir, b);
      if (r && r.t <= (best ? best.dist : maxDist)) {
        best = { dist: r.t, point: origin.add(dir.scale(r.t)), normal: r.n, building: b };
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

  private rayBox(o: Vector3, d: Vector3, b: Building): { t: number; n: Vector3 } | null {
    const min = [b.cx - b.hw, 0, b.cz - b.hd];
    const max = [b.cx + b.hw, b.top, b.cz + b.hd];
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
    if (axis < 0) return { t: 0, n: d.scale(-1) }; // 内部から
    const n = new Vector3(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
    return { t: tmin, n };
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
    for (const b of list) {
      const qx = Math.max(b.cx - b.hw, Math.min(center.x, b.cx + b.hw));
      const qz = Math.max(b.cz - b.hd, Math.min(center.z, b.cz + b.hd));
      const qy = Math.max(0, Math.min(center.y, b.top));
      const d = Math.hypot(center.x - qx, center.y - qy, center.z - qz);
      if (d < radius) this.damageBuilding(b, dmg * (1 - (d / radius) * 0.5));
    }
  }

  private startCollapse(b: Building) {
    b.state = "collapsing";
    b.collapseT = 0;
    b.mesh.unfreezeWorldMatrix();
    if (b.body) {
      b.body.dispose();
      b.body = null;
    }
    this.onCollapseStart?.(b);
  }

  update(dt: number) {
    for (const b of this.buildings) {
      if (b.state !== "collapsing") continue;
      b.collapseT += dt;
      const dur = 3.5 + b.height * 0.04;
      const k = Math.min(1, b.collapseT / dur);
      const sink = b.height * (k * k * (3 - 2 * k)) * 1.02;
      b.top = Math.max(0, b.height - sink);
      b.mesh.position.y = b.height / 2 - sink;
      const shake = (1 - k) * 0.25;
      b.mesh.position.x = b.cx + (Math.random() - 0.5) * shake;
      b.mesh.position.z = b.cz + (Math.random() - 0.5) * shake;
      b.mesh.rotation.z = Math.sin(b.collapseT * 1.3) * 0.02 * k;
      if (k >= 1) {
        b.state = "gone";
        b.top = 0;
        b.mesh.dispose();
        // がれき
        const rub = MeshBuilder.CreateCylinder(
          "rubble",
          { diameterTop: Math.min(b.hw, b.hd) * 0.6, diameterBottom: Math.max(b.hw, b.hd) * 2.1, height: 2.2, tessellation: 7 },
          this.scene,
        );
        rub.scaling.z = b.hd / b.hw;
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
    for (const b of list) if (Math.abs(x - b.cx) < b.hw + r && Math.abs(z - b.cz) < b.hd + r) return false;
    return true;
  }
}
