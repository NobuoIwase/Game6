// ============================================================================
// 外部アセット（GPT 制作の GLB。docs/HANDOFF.md 9.5）の読み込みと配置。
// ----------------------------------------------------------------------------
// ・public/assets/models/catalog.json に全アセットの寸法・三角形数・収録パックが載っている
//   （scripts/import_assets.py → scripts/build_packs.mjs で作成）
// ・パック GLB の中で、各モデルの各状態は「<id>|<state>」という名前のノード
// ・使うパックだけを読み込み、各状態のノードを「テンプレート」として隠しておき、
//   置くたびに instantiateHierarchy で軽いインスタンスを作る
// ・距離で normal → lod1 → lod2 を切り替える（遠景は簡略版）。倒壊後は wreck に差し替え
// ・座標: メートル・Y-up。原点はモデルの記録どおり（接地補正はしない）。前方は +Z
// ============================================================================
import { AbstractMesh, AssetContainer, Mesh, MeshoptCompression, PBRMaterial, Quaternion, Scene, SceneLoader, TransformNode, Vector3 } from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import { MeshoptDecoder } from "meshoptimizer";

export type AssetStateName = "normal" | "lod1" | "lod2" | "wreck";
export interface AssetState {
  min: [number, number, number];
  max: [number, number, number];
  tris: number;
}
export interface AssetDef {
  id: string;
  name: string;
  role: string;
  pack: string;
  states: Partial<Record<AssetStateName, AssetState>>;
}

// meshopt の復号器: Babylon は既定で CDN からスクリプトを読み込むが、公開先では外部スクリプトが
// 使えないことがあるので、バンドル済みの復号器を直接使う（Web Worker も使わない同期デコード）。
(MeshoptCompression as unknown as { _Default: unknown })._Default = {
  decodeGltfBufferAsync: async (source: Uint8Array, count: number, stride: number, mode: "ATTRIBUTES" | "TRIANGLES" | "INDICES", filter?: string) => {
    await MeshoptDecoder.ready;
    const out = new Uint8Array(count * stride);
    MeshoptDecoder.decodeGltfBuffer(out, count, stride, source, mode, filter as never);
    return out;
  },
  dispose() {},
};

/** 置いた1つのモデル（状態ごとのノードを持ち、距離で切り替える） */
export class Placement {
  readonly root: TransformNode;
  readonly states = new Map<AssetStateName, TransformNode>();
  current: AssetStateName | null = null;
  /** LOD を切り替える距離（m） */
  near = 60;
  far = 180;
  /** 小さな非衝突設備だけに指定する表示上限。建物・破壊物は既定で無制限。 */
  maxDistance = Infinity;
  /** wreck に固定（倒壊後） */
  wrecked = false;
  /** 動かないもの（行列を固定して軽くする） */
  isStatic = true;
  readonly radius: number;
  meshes: AbstractMesh[] = [];

  constructor(
    readonly def: AssetDef,
    parent: TransformNode | null,
    scene: Scene,
  ) {
    this.root = new TransformNode("asset_" + def.id, scene);
    this.root.parent = parent;
    const n = def.states.normal!;
    this.radius = Math.hypot(n.max[0] - n.min[0], n.max[1] - n.min[1], n.max[2] - n.min[2]) / 2;
  }

  addState(st: AssetStateName, node: TransformNode) {
    this.states.set(st, node);
    node.setEnabled(false);
    if (st === "normal" || !this.meshes.length) this.meshes = node.getChildMeshes(false);
  }

  has(st: AssetStateName) {
    return this.states.has(st);
  }

  show(st: AssetStateName) {
    if (this.current === st) return;
    if (this.current) this.states.get(this.current)?.setEnabled(false);
    this.states.get(st)?.setEnabled(true);
    this.current = st;
  }

  /** カメラまでの距離に応じた状態 */
  pick(dist: number): AssetStateName {
    if (this.wrecked) return "wreck";
    // 距離で選んだ状態が無いときは、近い順に代わりを探す（遠景用に lod2 だけ置いた場合など）
    const order: AssetStateName[] = dist < this.near ? ["normal", "lod1", "lod2"] : dist < this.far ? ["lod1", "normal", "lod2"] : ["lod2", "lod1", "normal"];
    for (const st of order) if (this.has(st)) return st;
    return "normal";
  }

  dispose() {
    this.root.dispose();
  }
}

export class AssetLibrary {
  defs: AssetDef[] = [];
  private byId = new Map<string, AssetDef>();
  private byRole = new Map<string, AssetDef[]>();
  private packs = new Map<string, AssetContainer>();
  /** "<id>|<state>" → テンプレートノード（読み込み済みパック内） */
  private templates = new Map<string, TransformNode>();
  /** glTF の右手系 → 左手系の変換（パックの __root__ と同じ回転・拡大） */
  private conv: { q: Quaternion; s: Vector3 } | null = null;
  placements: Placement[] = [];
  private lodT = 0;

  constructor(
    private scene: Scene,
    private base = "assets/models/",
  ) {}

  /** 台帳を読む（無ければ空のまま。ゲームは従来の手作りの街で動く） */
  async loadCatalog(includeNeighborhood = true): Promise<boolean> {
    try {
      const res = await fetch(this.base + "catalog.json");
      if (!res.ok) return false;
      const data = (await res.json()) as { assets: AssetDef[] };
      this.defs = data.assets;
      if (includeNeighborhood) {
        try {
          const extra = await fetch(this.base + "neighborhood-catalog.json");
          if (extra.ok) {
            const additions = (await extra.json()) as { assets: AssetDef[] };
            const existing = new Set(this.defs.map(d => d.id));
            this.defs.push(...additions.assets.filter(d => !existing.has(d.id)));
          }
        } catch { /* 追加パックが未配備でも既存catalogは使用する */ }
      }
    } catch {
      return false;
    }
    for (const d of this.defs) {
      this.byId.set(d.id, d);
      const list = this.byRole.get(d.role) ?? [];
      list.push(d);
      this.byRole.set(d.role, list);
    }
    return this.defs.length > 0;
  }

  get ready() {
    return this.defs.length > 0;
  }

  role(name: string): AssetDef[] {
    return this.byRole.get(name) ?? [];
  }

  get(id: string) {
    return this.byId.get(id);
  }

  /** 指定モデルだけの外壁材を共有材質へ差し替える。元のcatalog・他モデルは変更しない。 */
  replaceSurface(id:string,sourceNames:string[],material:PBRMaterial) {
    for(const state of ["normal","lod1","lod2","wreck"]) {
      const root=this.templates.get(`${id}|${state}`);
      if(!root)continue;
      for(const mesh of root.getChildMeshes(false))if(mesh.material&&sourceNames.includes(mesh.material.name))mesh.material=material;
    }
  }

  /** 指定したアセットを含むパックを読み込む（同時に読み込みすぎないよう 3 本ずつ） */
  async preload(ids: Iterable<string>, onProgress?: (done: number, total: number) => void) {
    const need = new Set<string>();
    for (const id of ids) {
      const d = this.byId.get(id);
      if (d && !this.packs.has(d.pack)) need.add(d.pack);
    }
    const list = [...need];
    let done = 0;
    const worker = async () => {
      while (list.length) {
        const p = list.shift()!;
        await this.loadPack(p);
        onProgress?.(++done, need.size);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  private async loadPack(name: string) {
    // 公開先（Claude のアーティファクト）は .glb を配信できないため、ビルド時に VITE_MODEL_EXT=.glb.wasm を
    // 指定して名前だけ変えたファイルを読む（中身は同じ GLB。読み込み側には拡張子 .glb として伝える）
    const ext = import.meta.env.VITE_MODEL_EXT || ".glb";
    const c = await SceneLoader.LoadAssetContainerAsync(this.base, name + ext, this.scene, null, ".glb");
    c.addAllToScene();
    this.packs.set(name, c);
    for (const root of c.rootNodes) {
      if (!(root instanceof TransformNode)) continue;
      if (!this.conv) this.conv = { q: (root.rotationQuaternion ?? Quaternion.Identity()).clone(), s: root.scaling.clone() };
      root.position.y = -5000; // テンプレートは見えない場所へ
      for (const ch of root.getChildren()) {
        if (ch instanceof TransformNode && ch.name.includes("|")) this.templates.set(ch.name, ch);
      }
    }
    for (const m of c.meshes) {
      m.isPickable = false;
      m.isVisible = false; // インスタンスだけを描く
      m.receiveShadows = true;
      m.alwaysSelectAsActiveMesh = false;
      if (m instanceof Mesh) m.freezeNormals();
    }
    for (const mt of c.materials) {
      // ガラスの屈折（KHR_materials_transmission）は、不透明な物を毎フレーム別テクスチャへ描き直すため非常に重い。
      // 半透明の普通のガラスに置き換える
      if (mt instanceof PBRMaterial && mt.subSurface.isRefractionEnabled) {
        mt.subSurface.isRefractionEnabled = false;
        mt.alpha = 0.45;
        mt.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
      }
      mt.freeze?.();
    }
  }

  /**
   * アセットを置く。preload 済みであること。
   * @param yaw Y 軸回転（ラジアン。0 でモデルの +Z が +Z を向く）
   */
  place(id: string, x: number, y: number, z: number, yaw: number, parent: TransformNode | null = null, states?: AssetStateName[]): Placement | null {
    const def = this.byId.get(id);
    if (!def || !this.conv) return null;
    const p = new Placement(def, parent, this.scene);
    p.root.position.set(x, y, z);
    p.root.rotationQuaternion = Quaternion.RotationYawPitchRoll(yaw, 0, 0);
    const conv = new TransformNode("conv", this.scene);
    conv.parent = p.root;
    conv.rotationQuaternion = this.conv.q.clone();
    conv.scaling.copyFrom(this.conv.s);
    for (const st of states ?? (Object.keys(def.states) as AssetStateName[])) {
      const t = this.templates.get(`${id}|${st}`);
      if (!t) continue;
      const inst = t.instantiateHierarchy(conv, { doNotInstantiate: false }, (src, clone) => {
        clone.name = src.name;
        if (clone instanceof AbstractMesh) {
          clone.isPickable = false;
          clone.isVisible = true;
        }
      });
      if (inst) {
        inst.position.setAll(0);
        p.addState(st, inst);
      }
    }
    if (!p.states.size) {
      p.dispose();
      return null;
    }
    const r = p.radius;
    p.near = 45 + r * 2.5;
    p.far = 140 + r * 4;
    p.show(p.pick(0));
    this.placements.push(p);
    return p;
  }

  /** LOD の更新（数フレームに1回） */
  update(dt: number, camPos: Vector3) {
    this.lodT -= dt;
    if (this.lodT > 0) return;
    this.lodT = 0.25;
    for (const p of this.placements) {
      if (p.root.isDisposed()) continue;
      const w = p.root.getAbsolutePosition();
      const d = Math.hypot(w.x - camPos.x, w.y - camPos.y, w.z - camPos.z) - p.radius;
      if(Number.isFinite(p.maxDistance)) {
        p.root.setEnabled(d<p.maxDistance);
        if(d>=p.maxDistance)continue;
      }
      p.show(p.pick(d));
    }
  }

  /** 静的に置いたものの行列を固定して軽くする */
  freezeStatic() {
    for (const p of this.placements) {
      if (!p.isStatic || p.root.isDisposed()) continue;
      p.root.computeWorldMatrix(true);
      for (const n of p.root.getDescendants(false)) {
        if (n instanceof TransformNode) {
          n.computeWorldMatrix(true);
          n.freezeWorldMatrix();
        }
      }
    }
  }
}
