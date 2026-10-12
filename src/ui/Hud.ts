// ============================================================================
// HUD（HTML/CSS で描画）
// イメージ画像の配置: 左上=アーマー、右上=敵レーダー、右下=武器と残弾、中央=照準
// ============================================================================
import { Matrix, Scene, Vector3, Camera } from "@babylonjs/core";
import type { Player } from "../entities/Player";
import type { Enemy } from "../enemies/Enemy";
import type { RadioLine } from "../data/missions";
import type { WeaponModel } from "../data/weapons";

const $ = (id: string) => document.getElementById(id)!;

export interface RadarItem {
  pos: Vector3;
  kind: "armor" | "health";
}

export class Hud {
  private radar = $("radar") as HTMLCanvasElement;
  private rctx = this.radar.getContext("2d")!;
  private icon = $("wpIcon") as HTMLCanvasElement;
  private lastIcon: WeaponModel | null = null;
  private lockEls: HTMLDivElement[] = [];
  private radioQueue: { line: RadioLine; at: number }[] = [];
  private radioClock = 0;
  private radioLast = 0;
  private hitT = 0;
  private statusT = 0;
  radarRange = 160;
  /** 照準の先の敵が有効射程内なら true（照準が赤くなる） */
  inRange = false;
  private dmgPool: { el: HTMLDivElement; pos: Vector3; t: number; life: number; dx: number }[] = [];
  private dmgNext = 0;

  /** 敵に与えたダメージを数字で表示 */
  damage(pos: Vector3, amount: number, kind: "normal" | "big" | "weak" = "normal") {
    const layer = $("dmgLayer");
    let d = this.dmgPool.find((x) => x.t >= x.life);
    if (!d) {
      if (this.dmgPool.length < 40) {
        const el = document.createElement("div");
        layer.appendChild(el);
        d = { el, pos: new Vector3(), t: 0, life: 0.8, dx: 0 };
        this.dmgPool.push(d);
      } else {
        d = this.dmgPool[this.dmgNext];
        this.dmgNext = (this.dmgNext + 1) % this.dmgPool.length;
      }
    }
    d.pos.copyFrom(pos);
    d.t = 0;
    d.life = kind === "big" ? 1.1 : 0.75;
    d.dx = (Math.random() - 0.5) * 30;
    d.el.className = "dmg " + (kind === "normal" ? "" : kind);
    d.el.textContent = String(Math.max(1, Math.round(amount)));
    d.el.style.display = "block";
  }

  private updateDamage(dt: number, scene: Scene, camera: Camera) {
    if (!this.dmgPool.length) return;
    const engine = scene.getEngine();
    const vw = engine.getRenderWidth(),
      vh = engine.getRenderHeight();
    const transform = scene.getTransformMatrix();
    const viewport = camera.viewport.toGlobal(vw, vh);
    const cw = window.innerWidth / vw,
      chh = window.innerHeight / vh;
    for (const d of this.dmgPool) {
      if (d.t >= d.life) {
        if (d.el.style.display !== "none") d.el.style.display = "none";
        continue;
      }
      d.t += dt;
      const p = Vector3.Project(d.pos, Matrix.IdentityReadOnly, transform, viewport);
      if (p.z < 0 || p.z > 1) {
        d.el.style.display = "none";
        continue;
      }
      d.el.style.display = "block";
      const k = d.t / d.life;
      d.el.style.left = `${p.x * cw + d.dx * k}px`;
      d.el.style.top = `${p.y * chh - 40 * k}px`;
      d.el.style.opacity = String(1 - k * k);
    }
  }

  show(on: boolean) {
    $("hud").classList.toggle("hidden", !on);
  }

  // ------------------------------------------------------------------ 無線
  radio(lines: RadioLine[]) {
    let t = Math.max(this.radioClock, this.radioLast);
    for (const l of lines) {
      t += l.delay ?? 0;
      this.radioQueue.push({ line: l, at: t });
    }
    this.radioLast = t + 0.5;
  }

  private updateRadio(dt: number) {
    this.radioClock += dt;
    const box = $("radio");
    while (this.radioQueue.length && this.radioQueue[0].at <= this.radioClock) {
      const { line } = this.radioQueue.shift()!;
      const el = document.createElement("div");
      el.innerHTML = `<span class="radio-line"><span class="who">${line.who}</span>${line.text}</span>`;
      box.appendChild(el);
      while (box.children.length > 3) box.removeChild(box.firstChild!);
      setTimeout(() => el.remove(), 6500);
    }
  }

  clearRadio() {
    this.radioQueue = [];
    $("radio").innerHTML = "";
  }

  status(text: string, seconds = 2) {
    $("status").textContent = text;
    this.statusT = seconds;
  }

  hitMarker() {
    this.hitT = 0.08;
  }

  // ------------------------------------------------------------------ 毎フレーム
  update(dt: number, player: Player, enemies: Enemy[], items: RadarItem[], camYaw: number, scene: Scene, camera: Camera, zoom: boolean) {
    this.updateRadio(dt);
    // アーマー
    const a = Math.ceil(player.armor);
    $("armorCur").textContent = String(a);
    $("armorMax").textContent = String(Math.round(player.maxArmor));
    const ratio = player.armor / player.maxArmor;
    const fill = $("armorFill");
    fill.style.width = `${Math.max(0, ratio * 100)}%`;
    fill.className = ratio < 0.25 ? "low" : ratio < 0.5 ? "mid" : "";

    // 武器
    const w = player.weapon;
    $("wpName").textContent = w.def.name;
    const ammoEl = $("wpAmmo");
    ammoEl.textContent = w.reloading ? "--" : String(w.ammo);
    ammoEl.parentElement!.classList.toggle("empty", w.ammo === 0 || w.reloading);
    $("wpMag").textContent = String(w.def.magazine);
    ($("wpReloadFill") as HTMLElement).style.width = `${w.reloadRatio * 100}%`;
    const other = player.weapons.filter((x) => x !== w);
    $("wpSub").textContent = other.map((o) => `${o.def.name}  ${o.reloading ? "リロード中" : o.ammo + "/" + o.def.magazine}`).join(" / ");
    if (this.lastIcon !== w.def.model) {
      this.lastIcon = w.def.model;
      this.drawIcon(w.def.model);
    }

    // 照準
    const ch = $("crosshair");
    ch.classList.toggle("zoom", zoom && w.def.zoom > 1.2);
    ch.classList.toggle("ml", w.def.kind === "homing");
    ch.classList.toggle("inrange", this.inRange);
    this.hitT -= dt;
    $("hitmarker").classList.toggle("on", this.hitT > 0);

    // ロックオン表示・ダメージ数字
    this.updateLocks(player, scene, camera);
    this.updateDamage(dt, scene, camera);

    // 被弾・拘束の演出
    ($("damageVignette") as HTMLElement).style.opacity = String(Math.min(1, player.hurtFlash + (ratio < 0.25 ? 0.35 : 0)));
    ($("bindOverlay") as HTMLElement).style.opacity = String(player.restrained ? 1 : Math.min(0.8, player.bind / 120));

    this.statusT -= dt;
    if (this.statusT <= 0) $("status").textContent = "";

    $("enemyCount").textContent = `残り敵数 ${enemies.length}`;
    this.drawRadar(player, enemies, items, camYaw);
  }

  private updateLocks(player: Player, scene: Scene, camera: Camera) {
    const w = player.weapon;
    const marks: { pos: Vector3; done: boolean }[] = [];
    if (w.def.kind === "homing") {
      for (const e of w.locks) if (e.alive) marks.push({ pos: e.center(), done: true });
      if (w.lockingTarget?.alive) marks.push({ pos: w.lockingTarget.center(), done: false });
    }
    const layer = $("lockLayer");
    while (this.lockEls.length < marks.length) {
      const d = document.createElement("div");
      d.className = "lock";
      layer.appendChild(d);
      this.lockEls.push(d);
    }
    const engine = scene.getEngine();
    const vw = engine.getRenderWidth(),
      vh = engine.getRenderHeight();
    const transform = scene.getTransformMatrix();
    const viewport = camera.viewport.toGlobal(vw, vh);
    const cw = window.innerWidth / vw,
      chh = window.innerHeight / vh;
    this.lockEls.forEach((el, i) => {
      const m = marks[i];
      if (!m) {
        el.style.display = "none";
        return;
      }
      const p = Vector3.Project(m.pos, Matrix.IdentityReadOnly, transform, viewport);
      if (p.z < 0 || p.z > 1) {
        el.style.display = "none";
        return;
      }
      el.style.display = "block";
      el.style.left = `${p.x * cw}px`;
      el.style.top = `${p.y * chh}px`;
      el.classList.toggle("done", m.done);
    });
  }

  private drawRadar(player: Player, enemies: Enemy[], items: RadarItem[], camYaw: number) {
    const c = this.rctx;
    const S = this.radar.width;
    const R = S / 2 - 4;
    c.clearRect(0, 0, S, S);
    c.save();
    c.translate(S / 2, S / 2);
    c.beginPath();
    c.arc(0, 0, R, 0, Math.PI * 2);
    c.fillStyle = "rgba(10,30,20,0.55)";
    c.fill();
    c.strokeStyle = "rgba(160,255,190,0.7)";
    c.lineWidth = 2;
    c.stroke();
    c.strokeStyle = "rgba(160,255,190,0.25)";
    c.lineWidth = 1;
    c.beginPath();
    c.arc(0, 0, R / 2, 0, Math.PI * 2);
    c.moveTo(-R, 0);
    c.lineTo(R, 0);
    c.moveTo(0, -R);
    c.lineTo(0, R);
    c.stroke();
    // 視界の扇
    c.fillStyle = "rgba(160,255,190,0.12)";
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(0, 0, R, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
    c.fill();

    const pp = player.position;
    const cos = Math.cos(camYaw),
      sin = Math.sin(camYaw);
    const k = R / this.radarRange;
    const toRadar = (p: Vector3): [number, number] | null => {
      const dx = p.x - pp.x,
        dz = p.z - pp.z;
      // カメラの向きが上になるよう回転
      const rx = dx * cos - dz * sin;
      const rz = dx * sin + dz * cos;
      let x = rx * k,
        y = -rz * k;
      const l = Math.hypot(x, y);
      if (l > R - 3) {
        x = (x / l) * (R - 3);
        y = (y / l) * (R - 3);
      }
      return [x, y];
    };
    for (const it of items) {
      const q = toRadar(it.pos);
      if (!q) continue;
      c.fillStyle = it.kind === "armor" ? "#4ade80" : "#f472b6";
      c.fillRect(q[0] - 2.5, q[1] - 2.5, 5, 5);
    }
    for (const e of enemies) {
      const q = toRadar(e.position);
      if (!q) continue;
      c.fillStyle = e.active ? "#ff3b3b" : "#b91c1c";
      c.beginPath();
      if (e.kind === "flyer") {
        c.moveTo(q[0], q[1] - 4);
        c.lineTo(q[0] + 3.5, q[1] + 3);
        c.lineTo(q[0] - 3.5, q[1] + 3);
      } else c.arc(q[0], q[1], e.kind === "spider" ? 3.2 : 2.8, 0, Math.PI * 2);
      c.fill();
    }
    // 自分
    c.fillStyle = "#fff";
    c.beginPath();
    c.moveTo(0, -6);
    c.lineTo(4, 4);
    c.lineTo(-4, 4);
    c.fill();
    c.restore();
  }

  private drawIcon(model: WeaponModel) {
    const c = this.icon.getContext("2d")!;
    const W = this.icon.width,
      H = this.icon.height;
    c.clearRect(0, 0, W, H);
    c.fillStyle = "rgba(235,240,250,0.9)";
    const r = (x: number, y: number, w: number, h: number) => c.fillRect(x, y, w, h);
    if (model === "launcher") {
      r(20, 20, 120, 14);
      r(14, 18, 10, 18);
      r(136, 18, 10, 18);
      r(60, 34, 8, 12);
      r(90, 34, 8, 10);
      r(80, 10, 18, 10);
    } else if (model === "sniper") {
      r(10, 26, 140, 5);
      r(30, 24, 60, 10);
      r(10, 30, 26, 10);
      r(50, 16, 40, 6);
      r(62, 34, 6, 12);
    } else if (model === "shotgun") {
      r(20, 22, 110, 7);
      r(40, 29, 70, 5);
      r(20, 28, 30, 12);
      r(50, 34, 6, 10);
    } else {
      r(16, 22, 92, 10);
      r(108, 25, 34, 4);
      r(16, 28, 26, 10);
      r(62, 32, 9, 16);
      r(48, 32, 6, 10);
      r(70, 15, 20, 6);
    }
  }
}
