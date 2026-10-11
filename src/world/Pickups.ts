// ============================================================================
// 回収アイテム（敵が落とす）
//   アーマー（緑）: 最大アーマーが増える（地球防衛軍の「アーマー」）
//   回復（赤）    : アーマーを回復
// ============================================================================
import { Color3, InstancedMesh, Mesh, MeshBuilder, PBRMaterial, Scene, Vector3 } from "@babylonjs/core";
import type { Player } from "../entities/Player";
import { sfx } from "../core/Audio";

interface Item {
  mesh: InstancedMesh;
  kind: "armor" | "health";
  pos: Vector3;
  vy: number;
  life: number;
}

export class Pickups {
  items: Item[] = [];
  private tpl: Record<"armor" | "health", Mesh>;
  onPickup?: (kind: "armor" | "health") => void;

  constructor(
    scene: Scene,
    private heightAt: (x: number, z: number) => number,
  ) {
    const mk = (name: string, color: Color3) => {
      const m = MeshBuilder.CreateBox(name, { size: 0.7 }, scene);
      const mat = new PBRMaterial(name + "Mat", scene);
      mat.albedoColor = color.scale(0.6);
      mat.emissiveColor = color;
      mat.metallic = 0.2;
      mat.roughness = 0.3;
      m.material = mat;
      m.isPickable = false;
      m.position.y = -3000;
      return m;
    };
    this.tpl = { armor: mk("itemArmor", new Color3(0.2, 1.2, 0.35)), health: mk("itemHealth", new Color3(1.3, 0.15, 0.25)) };
  }

  drop(pos: Vector3) {
    const kind = Math.random() < 0.6 ? "armor" : "health";
    const mesh = this.tpl[kind].createInstance("item");
    mesh.isPickable = false;
    this.items.push({ mesh, kind, pos: pos.clone(), vy: 6, life: 90 });
  }

  update(dt: number, player: Player, t: number) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.life -= dt;
      const g = this.heightAt(it.pos.x, it.pos.z) + 0.5;
      it.vy -= 15 * dt;
      it.pos.y += it.vy * dt;
      if (it.pos.y < g) {
        it.pos.y = g;
        it.vy = 0;
      }
      // 近くにいると吸い寄せられる
      const d = Vector3.Distance(it.pos, player.chest);
      if (player.alive && d < 6) it.pos.addInPlace(player.chest.subtract(it.pos).normalize().scale(dt * 14));
      it.mesh.position.copyFrom(it.pos);
      it.mesh.position.y += Math.sin(t * 3 + i) * 0.15;
      it.mesh.rotation.y = t * 1.5 + i;
      if (player.alive && d < 1.6) {
        if (it.kind === "armor") player.addMaxArmor(2);
        else player.heal(player.maxArmor * 0.2);
        sfx.pickup();
        this.onPickup?.(it.kind);
        it.life = 0;
      }
      if (it.life <= 0) {
        it.mesh.dispose();
        this.items.splice(i, 1);
      }
    }
  }

  clear() {
    for (const it of this.items) it.mesh.dispose();
    this.items = [];
  }
}
