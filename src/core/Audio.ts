// ============================================================================
// 効果音。音声ファイルを使わず WebAudio で合成する（外部素材不要・軽量）。
// 後で録音素材に差し替える場合は play* 関数の中身を AudioBuffer 再生に変えればよい。
//
// 構成: 各音 → (音ごとのバス: 距離減衰・距離ローパス・音速の遅れ) → master → コンプレッサー → リミッター → 出力
// ノイズは起動時に一度だけ作ったバッファ（白色・ブラウン・パチパチ音）を使い回す。
// ============================================================================
import type { Vector3 } from "@babylonjs/core";

interface NoiseOpts {
  /** 再生するバッファ（省略時は白色ノイズ） */
  buf?: AudioBuffer;
  gain: number;
  /** 全体の長さ（秒） */
  dur: number;
  type: BiquadFilterType;
  freq: number;
  /** フィルタ周波数の到達値（dur または sweep 秒かけて指数的に動かす） */
  freqEnd?: number;
  sweep?: number;
  q?: number;
  attack?: number;
  /** 指定すると指数減衰（setTargetAtTime の時定数）。省略時は dur までの指数ランプ */
  tau?: number;
  /** 再生速度（低いほどこもった音） */
  rate?: number;
  /** バッファの再生開始位置（秒）。省略時はランダム */
  offset?: number;
  /** 開始時刻（AudioContext 時間）。省略時は現在 */
  at?: number;
  dest?: AudioNode;
}

interface ToneOpts {
  freq: number;
  freqEnd: number;
  /** ピッチが freqEnd に達するまでの時間 */
  glide?: number;
  dur: number;
  gain: number;
  type?: OscillatorType;
  attack?: number;
  tau?: number;
  at?: number;
  dest?: AudioNode;
}

export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private brown!: AudioBuffer;
  private crackle!: AudioBuffer;
  private listener: { pos: Vector3 | null } = { pos: null };
  private lastPlay = new Map<string, number>();
  /** 鳴っている爆発音の終了時刻（同時発音数の制限用） */
  private expEnds: number[] = [];
  volume = 0.6;

  /** ユーザー操作の中で呼ぶ（ブラウザの自動再生制限対策） */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.volume;
      // 爆発が重なっても割れないよう、コンプレッサー＋リミッターを直列に挟む
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -20;
      comp.knee.value = 10;
      comp.ratio.value = 6;
      comp.attack.value = 0.004;
      comp.release.value = 0.3;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -2;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.12;
      this.master.connect(comp).connect(limiter).connect(ctx.destination);
      this.makeBuffers(ctx);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  /** ノイズ素材を一度だけ生成する */
  private makeBuffers(ctx: AudioContext) {
    const sr = ctx.sampleRate;
    // 白色ノイズ（3秒）
    const len = Math.floor(sr * 3);
    this.noise = ctx.createBuffer(1, len, sr);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // ブラウンノイズ（低音寄り。地鳴り用）
    this.brown = ctx.createBuffer(1, len, sr);
    const b = this.brown.getChannelData(0);
    let last = 0;
    let peak = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      b[i] = last;
      peak = Math.max(peak, Math.abs(last));
    }
    for (let i = 0; i < len; i++) b[i] /= peak || 1;
    // 破片が降るパチパチ音（間隔がだんだん空いていく短いクリックの集まり）
    const clen = Math.floor(sr * 2);
    this.crackle = ctx.createBuffer(1, clen, sr);
    const c = this.crackle.getChannelData(0);
    let env = 0;
    let amp = 0;
    for (let i = 0; i < clen; i++) {
      const t = i / sr;
      if (env < 0.01 && Math.random() < 0.0035 * Math.exp(-t * 1.6)) {
        env = 1;
        amp = 0.3 + Math.random() * 0.7;
      }
      c[i] = (Math.random() * 2 - 1) * env * amp;
      env *= 0.985;
    }
  }

  setListener(pos: Vector3) {
    this.listener.pos = pos;
  }

  private dist(pos?: Vector3): number {
    if (!pos || !this.listener.pos) return 0;
    const l = this.listener.pos;
    const dx = pos.x - l.x;
    const dy = pos.y - l.y;
    const dz = pos.z - l.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** 距離による減衰（0..1） */
  private att(pos?: Vector3, ref = 30): number {
    if (!pos || !this.listener.pos) return 1;
    const d = this.dist(pos);
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

  /**
   * 音ごとのバス。距離に応じて音量を下げ、高音を削り（遠くの音はこもる）、音速ぶん遅らせる。
   * 戻り値の at から鳴らし始めること。
   */
  private bus(gain: number, d: number, maxDelay = 0.45): { out: AudioNode; at: number } {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = gain;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = Math.max(700, 18000 * Math.exp(-d / 110));
    lp.Q.value = 0.5;
    g.connect(lp).connect(this.master);
    return { out: g, at: ctx.currentTime + Math.min(maxDelay, d / 343) };
  }

  private noiseBurst(o: NoiseOpts) {
    const ctx = this.ctx!;
    const t = o.at ?? ctx.currentTime;
    const buf = o.buf ?? this.noise;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = (o.rate ?? 1) * (0.85 + Math.random() * 0.3);
    const f = ctx.createBiquadFilter();
    f.type = o.type;
    f.frequency.setValueAtTime(o.freq, t);
    if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(o.freqEnd, t + (o.sweep ?? o.dur));
    f.Q.value = o.q ?? 0.8;
    const g = ctx.createGain();
    const atk = o.attack ?? 0.004;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), t + atk);
    if (o.tau) g.gain.setTargetAtTime(0, t + atk, o.tau);
    else g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    src.connect(f).connect(g).connect(o.dest ?? this.master);
    src.start(t, o.offset ?? Math.random() * (buf.duration - 0.1));
    src.stop(t + o.dur + 0.05);
  }

  private tone(o: ToneOpts) {
    const ctx = this.ctx!;
    const t = o.at ?? ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? "sine";
    osc.frequency.setValueAtTime(o.freq, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.freqEnd), t + (o.glide ?? o.dur));
    const g = ctx.createGain();
    const atk = o.attack ?? 0.003;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), t + atk);
    if (o.tau) g.gain.setTargetAtTime(0, t + atk, o.tau);
    else g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    osc.connect(g).connect(o.dest ?? this.master);
    osc.start(t);
    osc.stop(t + o.dur + 0.03);
  }

  /** 旧来の簡易トーン（短い電子音用） */
  private beep(freq: number, freqEnd: number, dur: number, gain: number, type: OscillatorType = "sine") {
    this.tone({ freq, freqEnd, dur, gain, type, attack: 0.002 });
  }

  shot(kind: string) {
    if (!this.ctx) return;
    const v = 0.92 + Math.random() * 0.16; // 毎発少しずつ音程を揺らして機械的な繰り返し感を消す
    switch (kind) {
      case "rifle":
        // 鋭い破裂音 + 中域の胴鳴り + 低いドン
        this.noiseBurst({ gain: 0.4, dur: 0.035, type: "highpass", freq: 2800 * v, attack: 0.001 });
        this.noiseBurst({ gain: 0.5, dur: 0.13, type: "bandpass", freq: 1500 * v, freqEnd: 450, q: 0.7, attack: 0.002 });
        this.tone({ freq: 150 * v, freqEnd: 50, dur: 0.09, gain: 0.4, type: "triangle" });
        break;
      case "shotgun":
        this.noiseBurst({ gain: 0.5, dur: 0.05, type: "highpass", freq: 2200, attack: 0.001 });
        this.noiseBurst({ gain: 0.9, dur: 0.38, type: "lowpass", freq: 3200 * v, freqEnd: 260, attack: 0.002 });
        this.tone({ freq: 110 * v, freqEnd: 38, dur: 0.22, gain: 0.65, type: "triangle" });
        break;
      case "sniper":
        this.noiseBurst({ gain: 0.6, dur: 0.05, type: "highpass", freq: 3500, attack: 0.001 });
        this.noiseBurst({ gain: 0.9, dur: 0.65, type: "lowpass", freq: 5000, freqEnd: 180, attack: 0.002 });
        this.tone({ freq: 220 * v, freqEnd: 40, dur: 0.28, gain: 0.5, type: "sawtooth" });
        this.noiseBurst({ buf: this.brown, gain: 0.35, dur: 0.9, type: "lowpass", freq: 400, freqEnd: 80, attack: 0.03, at: this.ctx.currentTime + 0.05 });
        break;
      case "launcher":
        this.noiseBurst({ gain: 0.6, dur: 0.7, type: "bandpass", freq: 900, freqEnd: 2500, q: 0.5, attack: 0.03 });
        this.tone({ freq: 90, freqEnd: 40, dur: 0.3, gain: 0.4 });
        break;
    }
  }

  /**
   * 爆発音。big は大きさ（爆発半径 / 7 程度。1 = ミサイル1発）。
   * 鋭い破裂音・低いドーン・こもった胴鳴り・長い地鳴り・破片のパチパチ音を重ねる。
   * 遠いほど小さく・こもり・音速ぶん遅れて聞こえる。
   */
  explosion(pos?: Vector3, big = 1) {
    if (!this.ctx || !this.throttle("exp", 40)) return;
    const ctx = this.ctx;
    const size = Math.min(3, Math.max(0.2, big));
    const d = this.dist(pos);
    const a = this.att(pos, 45);
    if (a < 0.03) return;
    // 同時発音数。多いときは尾（地鳴り・パチパチ）を省いて負荷と音の濁りを抑える
    const now = ctx.currentTime;
    let busy = 0;
    for (let i = this.expEnds.length - 1; i >= 0; i--) {
      if (this.expEnds[i] < now) this.expEnds.splice(i, 1);
      else busy++;
    }
    const lite = busy >= 4;
    if (busy >= 8) return;

    const ss = Math.sqrt(size);
    const len = 1.4 + 0.6 * ss; // 尾の長さ（約1.5〜2.5秒）
    this.expEnds.push(now + len + 0.5);
    const { out, at } = this.bus(Math.min(1.25, 0.6 + 0.35 * size) * a, d);
    // 近いほど高域の「バンッ」が強い
    const near = Math.min(1, Math.max(0.12, 1 - d / 220));

    // 1) 鋭い破裂音（数 ms で立ち上がるフィルタ付きノイズ）
    this.noiseBurst({ at, dest: out, gain: 0.9 * near, dur: 0.12 + 0.04 * ss, type: "highpass", freq: 1600, freqEnd: 700, attack: 0.001, tau: 0.025 });
    this.noiseBurst({ at, dest: out, gain: 0.6 * near, dur: 0.08, type: "bandpass", freq: 3200, q: 0.6, attack: 0.001, tau: 0.018 });
    // 2) 低いドーン（120Hz → 35Hz へ落ちる正弦波＋三角波）
    this.tone({ at, dest: out, freq: 125 / (0.85 + 0.15 * ss), freqEnd: 34, glide: 0.45 + 0.15 * ss, dur: len * 0.8, gain: 1.0, attack: 0.004, tau: 0.22 + 0.1 * ss });
    this.tone({ at, dest: out, freq: 62, freqEnd: 28, glide: 0.8, dur: len * 0.9, gain: 0.5, type: "triangle", attack: 0.01, tau: 0.35 + 0.12 * ss });
    // 3) 胴鳴り（ローパスが閉じていくノイズ）
    this.noiseBurst({ at, dest: out, gain: 0.85, dur: 1.0 + 0.3 * ss, type: "lowpass", freq: 3000, freqEnd: 160, sweep: 0.7 + 0.2 * ss, q: 0.9, attack: 0.006, tau: 0.18 + 0.08 * ss });
    if (lite) return;
    // 4) 地鳴り（低速再生のブラウンノイズ。ゆっくり立ち上がって長く残る）
    this.noiseBurst({ at: at + 0.02, dest: out, buf: this.brown, rate: 0.5, gain: 0.75, dur: len, type: "lowpass", freq: 420, freqEnd: 60, sweep: len, q: 0.7, attack: 0.08, tau: len * 0.3 });
    // 5) 破片が降るパチパチ音
    this.noiseBurst({ at: at + 0.06, dest: out, buf: this.crackle, offset: Math.random() * 0.15, gain: 0.5 * near, dur: Math.min(1.9, 0.9 + 0.4 * ss), type: "bandpass", freq: 2400, freqEnd: 1200, q: 0.7, attack: 0.01, tau: 0.45 });
  }

  enemyShot(pos: Vector3, kind: "acid" | "web" | "laser" | "bomb") {
    if (!this.ctx || !this.throttle(kind, 70)) return;
    const a = this.att(pos, 40);
    if (a < 0.05) return;
    if (kind === "acid") this.noiseBurst({ gain: 0.35 * a, dur: 0.3, type: "bandpass", freq: 700, freqEnd: 300, q: 2 });
    else if (kind === "web") this.noiseBurst({ gain: 0.25 * a, dur: 0.2, type: "highpass", freq: 3000, q: 1 });
    else if (kind === "laser") this.beep(1400, 500, 0.08, 0.15 * a, "square");
    else this.beep(900, 300, 0.6, 0.12 * a, "sine");
  }

  /**
   * 敵への着弾音。肉厚の「ドスッ／グシャ」（低い打撃 + 中域のつぶれる音 + 小さな殻の割れる音）。
   * 引数は省略可（heavy: ロケット・高威力弾、metal: 機械の敵）
   */
  hit(heavy = false, metal = false) {
    if (!this.ctx || !this.throttle("hit", 45)) return;
    const v = 0.9 + Math.random() * 0.2;
    const k = heavy ? 1.4 : 1;
    if (metal) {
      // 金属装甲: カンッという鋭い打音と短い響き
      this.noiseBurst({ gain: 0.3 * k, dur: 0.05, type: "bandpass", freq: 3800 * v, q: 3, attack: 0.001 });
      this.tone({ freq: 1250 * v, freqEnd: 1150 * v, dur: 0.12, gain: 0.07 * k, type: "triangle", tau: 0.03 });
      this.tone({ freq: 170 * v, freqEnd: 80, dur: 0.07, gain: 0.25 * k });
      return;
    }
    this.tone({ freq: (heavy ? 150 : 190) * v, freqEnd: 60, glide: 0.08, dur: 0.12, gain: 0.45 * k, attack: 0.002, tau: 0.03 });
    this.noiseBurst({ gain: 0.45 * k, dur: 0.08, type: "bandpass", freq: 1100 * v, freqEnd: 500, q: 1.2, attack: 0.002, tau: 0.02 });
    this.noiseBurst({ gain: 0.16, dur: 0.03, type: "highpass", freq: 4200, attack: 0.001, tau: 0.008 });
    // 体液が飛び散るじゅっという音（ごく小さく）
    this.noiseBurst({ gain: 0.08 * k, dur: 0.16, type: "bandpass", freq: 2600, freqEnd: 1600, q: 1.5, attack: 0.02, at: this.ctx.currentTime + 0.02 });
  }

  squish(pos: Vector3) {
    if (!this.ctx || !this.throttle("squish", 60)) return;
    const a = this.att(pos, 40);
    this.noiseBurst({ gain: 0.5 * a, dur: 0.4, type: "bandpass", freq: 500, freqEnd: 150, q: 1.5 });
    this.tone({ freq: 140, freqEnd: 50, dur: 0.25, gain: 0.3 * a, tau: 0.06 });
  }

  hurt() {
    if (!this.ctx || !this.throttle("hurt", 120)) return;
    this.beep(300, 120, 0.15, 0.3, "square");
  }

  reload() {
    if (!this.ctx) return;
    this.noiseBurst({ gain: 0.3, dur: 0.05, type: "highpass", freq: 4000 });
    this.noiseBurst({ gain: 0.35, dur: 0.06, type: "bandpass", freq: 2500, at: this.ctx.currentTime + 0.18 });
  }

  pickup() {
    if (!this.ctx) return;
    this.beep(880, 1320, 0.15, 0.2, "triangle");
  }

  lock() {
    if (!this.ctx || !this.throttle("lock", 60)) return;
    this.beep(1800, 1800, 0.05, 0.08, "square");
  }

  collapse(pos: Vector3) {
    if (!this.ctx) return;
    const a = this.att(pos, 120);
    const d = this.dist(pos);
    const { out, at } = this.bus(a, d, 0.6);
    this.noiseBurst({ at, dest: out, gain: 0.8, dur: 3.5, type: "lowpass", freq: 600, freqEnd: 60, attack: 0.2 });
    this.noiseBurst({ at, dest: out, buf: this.brown, rate: 0.6, gain: 0.6, dur: 3.2, type: "lowpass", freq: 300, freqEnd: 50, attack: 0.3, tau: 1.0 });
    this.noiseBurst({ at: at + 0.3, dest: out, buf: this.crackle, offset: 0.1, gain: 0.35, dur: 1.9, type: "bandpass", freq: 1500, q: 0.6, attack: 0.05, tau: 0.8 });
  }
}

export const sfx = new Sfx();
