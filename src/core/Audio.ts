// ============================================================================
// 効果音。音声ファイルを使わず WebAudio で合成する（外部素材不要・軽量）。
// 後で録音素材に差し替える場合は play* 関数の中身を AudioBuffer 再生に変えればよい。
// ============================================================================
import type { Vector3 } from "@babylonjs/core";

export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private listener: { pos: Vector3 | null } = { pos: null };
  private lastPlay = new Map<string, number>();
  volume = 0.6;

  /** ユーザー操作の中で呼ぶ（ブラウザの自動再生制限対策） */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 6;
      this.master.connect(comp).connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 2;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  setListener(pos: Vector3) {
    this.listener.pos = pos;
  }

  /** 距離による減衰（0..1） */
  private att(pos?: Vector3, ref = 30): number {
    if (!pos || !this.listener.pos) return 1;
    const d = pos.subtract(this.listener.pos).length();
    return Math.min(1, ref / Math.max(ref, d));
  }

  /** 同じ音が短時間に重なりすぎないよう間引く */
  private throttle(key: string, ms: number): boolean {
    const now = performance.now();
    const last = this.lastPlay.get(key) ?? 0;
    if (now - last < ms) return false;
    this.lastPlay.set(key, now);
    return true;
  }

  private noiseBurst(opts: {
    gain: number;
    dur: number;
    type: BiquadFilterType;
    freq: number;
    freqEnd?: number;
    q?: number;
    attack?: number;
  }) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const f = ctx.createBiquadFilter();
    f.type = opts.type;
    f.frequency.setValueAtTime(opts.freq, t);
    if (opts.freqEnd) f.frequency.exponentialRampToValueAtTime(opts.freqEnd, t + opts.dur);
    f.Q.value = opts.q ?? 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(opts.gain, t + (opts.attack ?? 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5, opts.dur + 0.05);
  }

  private tone(freq: number, freqEnd: number, dur: number, gain: number, type: OscillatorType = "sine") {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  shot(kind: string) {
    if (!this.ctx) return;
    switch (kind) {
      case "rifle":
        this.noiseBurst({ gain: 0.5, dur: 0.12, type: "bandpass", freq: 2200, freqEnd: 600, q: 0.6 });
        this.tone(160, 50, 0.08, 0.35, "triangle");
        break;
      case "shotgun":
        this.noiseBurst({ gain: 0.9, dur: 0.35, type: "lowpass", freq: 3000, freqEnd: 300 });
        this.tone(110, 40, 0.18, 0.6, "triangle");
        break;
      case "sniper":
        this.noiseBurst({ gain: 0.9, dur: 0.6, type: "lowpass", freq: 5000, freqEnd: 200 });
        this.tone(220, 40, 0.25, 0.5, "sawtooth");
        break;
      case "launcher":
        this.noiseBurst({ gain: 0.6, dur: 0.7, type: "bandpass", freq: 900, freqEnd: 2500, q: 0.5, attack: 0.03 });
        this.tone(90, 40, 0.3, 0.4);
        break;
    }
  }

  explosion(pos?: Vector3, big = 1) {
    if (!this.ctx || !this.throttle("exp", 40)) return;
    const a = this.att(pos, 60) * Math.min(1.5, big);
    this.noiseBurst({ gain: 1.0 * a, dur: 1.6 * Math.min(1.4, big), type: "lowpass", freq: 1800, freqEnd: 80 });
    this.tone(70, 25, 0.9, 0.9 * a);
  }

  enemyShot(pos: Vector3, kind: "acid" | "web" | "laser" | "bomb") {
    if (!this.ctx || !this.throttle(kind, 70)) return;
    const a = this.att(pos, 40);
    if (a < 0.05) return;
    if (kind === "acid") this.noiseBurst({ gain: 0.35 * a, dur: 0.3, type: "bandpass", freq: 700, freqEnd: 300, q: 2 });
    else if (kind === "web") this.noiseBurst({ gain: 0.25 * a, dur: 0.2, type: "highpass", freq: 3000, q: 1 });
    else if (kind === "laser") this.tone(1400, 500, 0.08, 0.15 * a, "square");
    else this.tone(900, 300, 0.6, 0.12 * a, "sine");
  }

  hit() {
    if (!this.ctx || !this.throttle("hit", 50)) return;
    this.noiseBurst({ gain: 0.25, dur: 0.06, type: "highpass", freq: 2500 });
  }

  squish(pos: Vector3) {
    if (!this.ctx || !this.throttle("squish", 60)) return;
    const a = this.att(pos, 40);
    this.noiseBurst({ gain: 0.5 * a, dur: 0.4, type: "bandpass", freq: 500, freqEnd: 150, q: 1.5 });
  }

  hurt() {
    if (!this.ctx || !this.throttle("hurt", 120)) return;
    this.tone(300, 120, 0.15, 0.3, "square");
  }

  reload() {
    if (!this.ctx) return;
    this.noiseBurst({ gain: 0.3, dur: 0.05, type: "highpass", freq: 4000 });
    setTimeout(() => this.ctx && this.noiseBurst({ gain: 0.35, dur: 0.06, type: "bandpass", freq: 2500 }), 180);
  }

  pickup() {
    if (!this.ctx) return;
    this.tone(880, 1320, 0.15, 0.2, "triangle");
  }

  lock() {
    if (!this.ctx || !this.throttle("lock", 60)) return;
    this.tone(1800, 1800, 0.05, 0.08, "square");
  }

  collapse(pos: Vector3) {
    if (!this.ctx) return;
    const a = this.att(pos, 120);
    this.noiseBurst({ gain: 0.8 * a, dur: 3.5, type: "lowpass", freq: 600, freqEnd: 60, attack: 0.2 });
  }
}

export const sfx = new Sfx();
