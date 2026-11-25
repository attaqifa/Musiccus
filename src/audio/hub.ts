import { emptyMusic } from '../analysis/theory';
import type { Music } from '../analysis/types';
import { engine, type MeterMsg, type OnsetMsg } from './engine';
import { FluxTracker, LevelTracker } from './features';
import { copyField, decayField, emptyField, type MixField } from './field';
import { FieldClient } from './fieldClient';

/** Log-spaced spectrum points captured per frame (20 Hz up to Nyquist, max 48 kHz). */
export const SPEC_N = 1024;
/** Visual bands, 20 Hz – 20 kHz, normalised 0..1. */
export const BANDS_N = 256;
export const SCOPE_N = 1024;
export const SPEC_FLOOR = -140;

export interface Features {
  sub: number;
  bass: number;
  lowMid: number;
  mid: number;
  presence: number;
  air: number;
  energy: number;
  brightness: number;
  /** Onset envelopes, 1 at the hit and decaying. */
  kick: number;
  snare: number;
  hat: number;
  kickCount: number;
  /**
   * Transient strength 0..1: spectral flux against this song's usual amount
   * of change, joined with kick and snare hits. Moves on dense masters too.
   */
  pulse: number;
  levelDb: number;
  active: boolean;
}

export interface Snapshot {
  now: number;
  dt: number;
  /** Context time currently heard (after latency + calibration). */
  t: number;
  playing: boolean;
  sampleRate: number;
  specFreqs: Float32Array;
  spec: Float32Array;
  bands: Float32Array;
  scopeL: Float32Array;
  scopeR: Float32Array;
  features: Features;
  meter: MeterMsg | null;
  /** Musical state from the offline analysis (beat, chord, section, palette). */
  music: Music;
  /**
   * Where each sound sits in the stereo mix (pan by frequency, tone, hit and
   * haze), read from the two channels as heard. Needs no stems; see field.ts.
   */
  field: MixField;
  /** Studio effects visuals can respond to, 0..1. */
  fx: { space: number; drive: number; width: number };
}

interface Captured {
  t: number;
  spec: Float32Array;
  scopeL: Float32Array;
  scopeR: Float32Array;
}

const REGIONS: [number, number][] = [
  [20, 60],
  [60, 250],
  [250, 500],
  [500, 2000],
  [2000, 6000],
  [6000, 20000],
];

type Sub = (s: Snapshot) => void;

class AnalysisHub {
  private subs = new Set<Sub>();
  private processors: Sub[] = [];
  private reported = new WeakSet<Sub>();
  private raf = 0;
  private lastNow = 0;

  private rate = 0;
  private fftSize = 0;
  private fft: Float32Array<ArrayBuffer> = new Float32Array(0);
  private tdL: Float32Array<ArrayBuffer> = new Float32Array(2048);
  private tdR: Float32Array<ArrayBuffer> = new Float32Array(2048);
  private field = new FieldClient();
  private loBin = new Int32Array(SPEC_N);
  private hiBin = new Int32Array(SPEC_N);
  private ctrBin = new Float32Array(SPEC_N);
  specFreqs = new Float32Array(SPEC_N);
  private regionIdx: [number, number][] = [];
  private bandPos = new Float32Array(BANDS_N);
  private bandTilt = new Float32Array(BANDS_N);

  private ring: Captured[] = [];
  private head = -1;
  private count = 0;

  private meters: MeterMsg[] = [];
  private onsets: OnsetMsg[] = [];

  /** Six regions, then the whole spectrum. */
  private levels = Array.from({ length: 7 }, () => new LevelTracker());
  private flux = new FluxTracker(BANDS_N);
  private bandDb = new Float32Array(BANDS_N);
  private bandRef = -60;
  private env = { kick: 0, snare: 0, hat: 0 };
  private smooth = new Float32Array(8);

  readonly snapshot: Snapshot;

  constructor() {
    const features: Features = {
      sub: 0, bass: 0, lowMid: 0, mid: 0, presence: 0, air: 0, energy: 0, brightness: 0,
      kick: 0, snare: 0, hat: 0, kickCount: 0, pulse: 0, levelDb: -Infinity, active: false,
    };
    this.snapshot = {
      now: 0, dt: 0, t: 0, playing: false, sampleRate: 0, specFreqs: this.specFreqs,
      spec: new Float32Array(SPEC_N).fill(SPEC_FLOOR), bands: new Float32Array(BANDS_N),
      scopeL: new Float32Array(SCOPE_N), scopeR: new Float32Array(SCOPE_N), features, meter: null,
      music: emptyMusic(),
      field: emptyField(),
      fx: { space: 0, drive: 0, width: 0 },
    };
    for (let i = 0; i < 240; i++) {
      this.ring.push({
        t: -Infinity, spec: new Float32Array(SPEC_N),
        scopeL: new Float32Array(SCOPE_N), scopeR: new Float32Array(SCOPE_N),
      });
    }
    engine.on('meter', (m) => {
      this.meters.push(m);
      if (this.meters.length > 160) this.meters.splice(0, this.meters.length - 160);
    });
    engine.on('onset', (o) => {
      this.onsets.push(o);
      if (this.onsets.length > 64) this.onsets.shift();
    });
    engine.on('graph', () => this.clear());
  }

  /** Runs every frame after the audio features, before subscribers see the snapshot. */
  addProcessor(fn: Sub) {
    this.processors.push(fn);
  }

  subscribe(fn: Sub): () => void {
    this.subs.add(fn);
    if (!this.raf) {
      this.lastNow = performance.now();
      this.raf = requestAnimationFrame(this.loop);
    }
    return () => {
      this.subs.delete(fn);
      if (this.subs.size === 0 && this.raf) {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
      }
    };
  }

  private clear() {
    this.count = 0;
    this.head = -1;
    this.meters = [];
    this.onsets = [];
    this.field.clear();
  }

  private configure(rate: number, fftSize: number) {
    this.rate = rate;
    this.fftSize = fftSize;
    this.fft = new Float32Array(fftSize / 2);
    const binHz = rate / fftSize;
    const top = Math.min(rate / 2, 48000) * 0.995;
    const ratio = Math.log(top / 20);
    for (let i = 0; i < SPEC_N; i++) this.specFreqs[i] = 20 * Math.exp((ratio * i) / (SPEC_N - 1));
    for (let i = 0; i < SPEC_N; i++) {
      const f = this.specFreqs[i];
      const lo = i > 0 ? Math.sqrt(f * this.specFreqs[i - 1]) : f;
      const hi = i < SPEC_N - 1 ? Math.sqrt(f * this.specFreqs[i + 1]) : f;
      this.loBin[i] = Math.ceil(lo / binHz);
      this.hiBin[i] = Math.min(fftSize / 2 - 1, Math.floor(hi / binHz));
      this.ctrBin[i] = f / binHz;
    }
    const idxOf = (hz: number) => {
      const p = Math.log(Math.max(20, hz) / 20) / ratio;
      return Math.max(0, Math.min(SPEC_N - 1, Math.round(p * (SPEC_N - 1))));
    };
    this.regionIdx = REGIONS.map(([a, b]) => [idxOf(a), Math.max(idxOf(a) + 1, idxOf(b))]);
    for (let j = 0; j < BANDS_N; j++) {
      const f = 20 * Math.pow(1000, j / (BANDS_N - 1));
      this.bandPos[j] = (Math.log(f / 20) / ratio) * (SPEC_N - 1);
      this.bandTilt[j] = 3 * Math.log2(f / 1000);
    }
    this.clear();
  }

  private mapSpectrum(spec: Float32Array) {
    const fft = this.fft;
    for (let i = 0; i < SPEC_N; i++) {
      const lo = this.loBin[i];
      const hi = this.hiBin[i];
      let v: number;
      if (hi >= lo) {
        v = -Infinity;
        for (let k = lo; k <= hi; k++) if (fft[k] > v) v = fft[k];
      } else {
        const c = this.ctrBin[i];
        const k = Math.floor(c);
        const fr = c - k;
        v = fft[k] * (1 - fr) + fft[Math.min(k + 1, fft.length - 1)] * fr;
      }
      spec[i] = Number.isFinite(v) ? Math.max(SPEC_FLOOR, v) : SPEC_FLOOR;
    }
  }

  private capture(nowCtx: number) {
    const taps = engine.taps;
    const ctx = engine.ctx;
    if (!taps || !ctx) return;
    const a = taps.analyser;
    if (a.fftSize !== this.fftSize || ctx.sampleRate !== this.rate) this.configure(ctx.sampleRate, a.fftSize);

    this.head = (this.head + 1) % this.ring.length;
    this.count = Math.min(this.count + 1, this.ring.length);
    const slot = this.ring[this.head];
    // The Blackman window weights the newest samples lightly, so the frame's
    // perceptual centre sits a fraction of the window behind "now".
    slot.t = nowCtx - (0.2 * this.fftSize) / this.rate;
    a.getFloatFrequencyData(this.fft);
    this.mapSpectrum(slot.spec);

    const n = taps.left.fftSize;
    if (this.tdL.length !== n) {
      this.tdL = new Float32Array(n);
      this.tdR = new Float32Array(n);
    }
    taps.left.getFloatTimeDomainData(this.tdL);
    slot.scopeL.set(this.tdL.subarray(n - SCOPE_N));
    taps.right.getFloatTimeDomainData(this.tdR);
    slot.scopeR.set(this.tdR.subarray(n - SCOPE_N));
    // The field's Hann window responds most to sound at its middle; stamping
    // the frame 0.3 of a window back makes a hit peak about 35 ms after it
    // is heard, with its first glow slightly before.
    this.field.configure(ctx.sampleRate, n);
    this.field.push(this.tdL, this.tdR, nowCtx, nowCtx - (0.3 * n) / ctx.sampleRate);
  }

  private pick(t: number): Captured | null {
    if (this.count === 0) return null;
    let best: Captured | null = null;
    for (let n = 0; n < this.count; n++) {
      const c = this.ring[(this.head - n + this.ring.length) % this.ring.length];
      best = c;
      if (c.t <= t) break;
    }
    return best;
  }

  private pickMeter(t: number): MeterMsg | null {
    const m = this.meters;
    for (let i = m.length - 1; i >= 0; i--) if (m[i].t <= t) return m[i];
    return m.length ? m[0] : null;
  }

  private loop = (nowMs: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, Math.max(0.001, (nowMs - this.lastNow) / 1000));
    this.lastNow = nowMs;
    const s = this.snapshot;
    s.now = nowMs / 1000;
    s.dt = dt;

    const ctx = engine.ctx;
    const playing = !!ctx && !engine.isPaused && ctx.state === 'running' && engine.position() !== null;
    s.playing = playing;
    s.sampleRate = ctx?.sampleRate ?? 0;
    if (playing && ctx) this.capture(ctx.currentTime);

    const t = engine.syncTime();
    s.t = t;
    const f = s.features;

    if (playing) {
      const frame = this.pick(t);
      if (frame) {
        s.spec.set(frame.spec);
        s.scopeL.set(frame.scopeL);
        s.scopeR.set(frame.scopeR);
      }
      // Fire each onset on the frame where it reaches the listener's ears.
      while (this.onsets.length && this.onsets[0].t <= t) {
        const o = this.onsets.shift()!;
        if (t - o.t > 0.25) continue;
        if (o.band === 0) {
          this.env.kick = Math.max(this.env.kick, o.s);
          // Only decisive hits count as a "beat" that retriggers shockwaves.
          if (o.s >= 0.5) f.kickCount++;
        } else if (o.band === 1) this.env.snare = Math.max(this.env.snare, o.s);
        else this.env.hat = Math.max(this.env.hat, o.s);
      }
      s.meter = this.pickMeter(t);
      const field = this.field.pick(t);
      if (field) copyField(s.field, field);
      else decayField(s.field, dt);
    } else {
      decayField(s.field, dt);
      s.scopeL.fill(0);
      s.scopeR.fill(0);
      if (!ctx || engine.position() === null) s.spec.fill(SPEC_FLOOR);
    }

    this.computeFeatures(dt, playing);
    for (const p of this.processors) {
      try {
        p(s);
      } catch (err) {
        if (!this.reported.has(p)) {
          this.reported.add(p);
          console.error('Musiccus: processor error', err);
        }
      }
    }
    // One failing consumer must not freeze the meters and visuals after it.
    for (const fn of this.subs) {
      try {
        fn(s);
      } catch (err) {
        if (!this.reported.has(fn)) {
          this.reported.add(fn);
          console.error('Musiccus: subscriber error', err);
        }
      }
    }
  };

  private computeFeatures(dt: number, playing: boolean) {
    const s = this.snapshot;
    const f = s.features;
    const spec = s.spec;
    const decayRef = 3 * dt;

    const regionDb = (r: [number, number]) => {
      let p = 0;
      for (let i = r[0]; i <= r[1]; i++) p += Math.pow(10, spec[i] / 10);
      return 10 * Math.log10(p / (r[1] - r[0] + 1) + 1e-20);
    };

    const vals = new Array<number>(6);
    let totalP = 0;
    let centroidNum = 0;
    if (playing && this.regionIdx.length) {
      for (let r = 0; r < 6; r++) vals[r] = this.levels[r].update(regionDb(this.regionIdx[r]), dt);
      const end = this.regionIdx[5][1];
      for (let i = 0; i <= end; i++) {
        const p = Math.pow(10, spec[i] / 10);
        totalP += p;
        centroidNum += p * Math.log2(this.specFreqs[i]);
      }
    } else {
      vals.fill(0);
    }
    const levelDb = 10 * Math.log10(totalP / Math.max(1, this.regionIdx[5]?.[1] ?? 1) + 1e-20);
    const energy = playing ? this.levels[6].update(levelDb, dt) : 0;
    const centroid = totalP > 0 ? centroidNum / totalP : Math.log2(1000);
    const brightness = Math.max(0, Math.min(1, (centroid - Math.log2(200)) / (Math.log2(6000) - Math.log2(200))));

    const targets = [...vals, energy, brightness];
    for (let k = 0; k < 8; k++) {
      const cur = this.smooth[k];
      const tau = targets[k] > cur ? 0.035 : 0.22;
      this.smooth[k] = cur + (targets[k] - cur) * (1 - Math.exp(-dt / tau));
    }
    [f.sub, f.bass, f.lowMid, f.mid, f.presence, f.air, f.energy, f.brightness] = this.smooth;

    this.env.kick *= Math.exp(-dt * 7);
    this.env.snare *= Math.exp(-dt * 9);
    this.env.hat *= Math.exp(-dt * 14);
    f.kick = this.env.kick;
    f.snare = this.env.snare;
    f.hat = this.env.hat;
    f.levelDb = playing ? levelDb : -Infinity;
    f.active = playing && levelDb > -110;

    // Bands for visuals: tilted +3 dB/oct (so music reads roughly flat),
    // then normalised against a slowly decaying running peak.
    const bands = s.bands;
    if (playing) {
      let frameMax = -200;
      for (let j = 0; j < BANDS_N; j++) {
        const pos = this.bandPos[j];
        const k = Math.floor(pos);
        const fr = pos - k;
        const v = spec[k] * (1 - fr) + spec[Math.min(SPEC_N - 1, k + 1)] * fr + this.bandTilt[j];
        bands[j] = v;
        this.bandDb[j] = v;
        if (v > frameMax) frameMax = v;
      }
      f.pulse = Math.max(this.flux.update(this.bandDb, dt), this.env.kick * 0.9, this.env.snare * 0.8);
      this.bandRef = Math.max(this.bandRef - decayRef, frameMax, -80);
      const floor = this.bandRef - 54;
      for (let j = 0; j < BANDS_N; j++) bands[j] = Math.max(0, Math.min(1, (bands[j] - floor) / 54));
    } else {
      for (let j = 0; j < BANDS_N; j++) bands[j] *= Math.exp(-dt * 3);
      this.flux.reset();
      f.pulse *= Math.exp(-dt * 7);
    }
  }
}

export const hub = new AnalysisHub();
