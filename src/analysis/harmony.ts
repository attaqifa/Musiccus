/*
 * Key and chords, in the manner of NNLS Chroma / Chordino (Mauch 2010):
 *
 *   tuning        the song's concert pitch from the phase of its spectral
 *                 peaks, so a band at A = 432 Hz still lands on the right notes
 *   spectrum      a log-frequency spectrum, three bins per semitone, whitened
 *                 so loud bass and quiet treble count alike
 *   notes         per beat, the median spectrum (drum hits are short, chords
 *                 are not) explained as a sum of harmonic notes by
 *                 non-negative least squares, so a C's overtones stop
 *                 voting for G and E
 *   chroma        separate bass and treble pitch classes from those notes
 *   chords        major, minor and their sevenths against both, Viterbi with
 *                 changes cheapest on downbeats and a key prior
 *   key           pitch profiles from the notes plus what the chords do:
 *                 which chord is home, which lead to it
 */
import { FFT, hann } from './fft';
import type { ChordSeg, KeyInfo } from './types';

const BPS = 3;
const MIDI_LO = 26;
const MIDI_HI = 104;
const BINS = (MIDI_HI - MIDI_LO) * BPS + 1;
const NOTE_LO = 28;
const NOTE_HI = 88;
const NOTES = NOTE_HI - NOTE_LO + 1;
const N_FFT = 4096;
const HOP = 512;

export interface HarmonyParams {
  /** Each partial of a note template is this much weaker than the one below. */
  partialDecay: number;
  /** How much the bass note being the chord's root counts against the treble fit. */
  bassFit: number;
  /** The chord's third and fifth in the bass, against the root's 1 (inversions). */
  bassTones: number;
  /** Sevenths must fit a little better than the plain triad to win. */
  seventhCost: number;
  /** Bonus for chords that belong to the key, in the second pass. */
  keyPrior: number;
  /** Score of "no chord": beats whose best chord fits worse than this stay empty. */
  noChord: number;
  /**
   * Extra "no chord" score for a flat treble, where the best chord fits
   * little better than the average one (drums, claps, speech): this much
   * per unit the margin falls below `flatPivot`.
   */
  flatNoChord: number;
  flatPivot: number;
  /**
   * Beats with less than this share of the song's median beat energy are
   * silence, whatever the spectrum says. Kept low: a soft intro (a guitar
   * alone before the band) is still music.
   */
  silence: number;
  /** Cost of changing chord on beat 1, 2, 3, 4 of the bar. */
  changeCost: number[];
  /** Cost of moving between types of one chord (C to C7). */
  typeChange: number;
  /** Weight of the pitch profiles against the chord evidence when choosing the key. */
  profileWeight: number;
  /** Softmax sharpness for key confidence, calibrated so it roughly matches how often the key is right. */
  keySharpness: number;
}

// Tuned on 56 commercial recordings with published chord annotations (three
// Beatles albums and a Queen compilation), album by album so every value was
// checked on an album it was not fitted to, then checked against the
// synthetic songs (src/dev/harmonyLab.ts; README, "Akurasi akor dan kunci").
export const HARMONY_DEFAULTS: Readonly<HarmonyParams> = {
  partialDecay: 0.85,
  bassFit: 0.7,
  bassTones: 0.3,
  seventhCost: -0.03,
  keyPrior: 0.12,
  noChord: 0.85,
  flatNoChord: 0,
  flatPivot: 0.45,
  silence: 0.005,
  changeCost: [0.2, 0.4, 0.4, 0.4],
  typeChange: 0.02,
  profileWeight: 0.8,
  keySharpness: 3,
};

export interface Harmony {
  key: KeyInfo;
  chords: ChordSeg[];
  /** Concert-pitch offset from A = 440 Hz, in cents. */
  tuningCents: number;
}

/* ------------------------------------------------------------ Spectrum -- */

/** Halves the rate (the harmony needs nothing above 5 kHz) with a 4th-order low-pass. */
function decimate(x: Float32Array, rate: number) {
  const w = (2 * Math.PI * rate * 0.22) / rate;
  const cs = Math.cos(w);
  const al = Math.sin(w) / (2 * Math.SQRT1_2);
  const a0 = 1 + al;
  const b0 = (1 - cs) / 2 / a0, b1 = (1 - cs) / a0, a1 = (-2 * cs) / a0, a2 = (1 - al) / a0;
  const n = Math.floor(x.length / 2);
  const y = new Float32Array(n);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0, w1 = 0, w2 = 0;
  for (let i = 0; i < n * 2; i++) {
    const v = x[i];
    const u = b0 * v + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = u;
    const o = b0 * u + b1 * z1 + b0 * z2 - a1 * w1 - a2 * w2;
    z2 = z1; z1 = u; w2 = w1; w1 = o;
    if ((i & 1) === 0) y[i >> 1] = o;
  }
  return { y, rate: rate / 2 };
}

/**
 * Magnitude spectra of a real signal. Even and odd samples ride as the real
 * and imaginary parts of one half-length complex FFT, then are split apart:
 * half the work of a full transform.
 */
class Stft {
  private static readonly M = N_FFT / 2;
  private fft = new FFT(Stft.M);
  private win = hann(N_FFT);
  private re = new Float64Array(Stft.M);
  private im = new Float64Array(Stft.M);
  private cos = new Float64Array(Stft.M + 1);
  private sin = new Float64Array(Stft.M + 1);
  readonly mag = new Float64Array(Stft.M + 1);
  constructor(private x: Float32Array) {
    for (let k = 0; k <= Stft.M; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / N_FFT);
      this.sin[k] = Math.sin((2 * Math.PI * k) / N_FFT);
    }
  }
  /** Magnitude spectrum of the frame centred on sample `centre`. */
  frame(centre: number) {
    const M = Stft.M;
    const s = centre - N_FFT / 2;
    const { x, win, re, im } = this;
    for (let i = 0; i < M; i++) {
      const a = s + 2 * i;
      re[i] = a >= 0 && a < x.length ? x[a] * win[2 * i] : 0;
      im[i] = a + 1 >= 0 && a + 1 < x.length ? x[a + 1] * win[2 * i + 1] : 0;
    }
    this.fft.transform(re, im);
    for (let k = 0; k <= M; k++) {
      const zr = re[k % M], zi = im[k % M];
      const cr = re[(M - k) % M], ci = -im[(M - k) % M];
      const er = (zr + cr) / 2, ei = (zi + ci) / 2;
      const or = (zi - ci) / 2, oi = -(zr - cr) / 2;
      const wr = this.cos[k], wi = -this.sin[k];
      const xr = er + wr * or - wi * oi;
      const xi = ei + wr * oi + wi * or;
      this.mag[k] = Math.sqrt(xr * xr + xi * xi);
    }
    return this.mag;
  }
}

/**
 * Concert pitch from a sample of frames: each strong spectral peak, located
 * between bins by parabolic interpolation, votes with the phase of its
 * deviation from the nearest equal-tempered semitone.
 */
function estimateTuning(stft: Stft, frames: number, binHz: number): number {
  let c = 0;
  let s = 0;
  const kLo = Math.ceil(100 / binHz);
  const kHi = Math.floor(2500 / binHz);
  for (let f = 0; f < frames; f += 6) {
    const m = stft.frame(f * HOP);
    let mx = 0;
    for (let k = kLo; k <= kHi; k++) mx = Math.max(mx, m[k]);
    if (mx <= 0) continue;
    for (let k = kLo; k <= kHi; k++) {
      if (m[k] < mx * 0.05 || m[k] <= m[k - 1] || m[k] < m[k + 1]) continue;
      const a = Math.log(m[k - 1] + 1e-12), b = Math.log(m[k]), g = Math.log(m[k + 1] + 1e-12);
      const d = a - 2 * b + g;
      const delta = d < 0 ? (0.5 * (a - g)) / d : 0;
      const hz = (k + delta) * binHz;
      const midi = 69 + 12 * Math.log2(hz / 440);
      const dev = midi - Math.round(midi);
      const w = Math.sqrt(m[k] / mx);
      c += w * Math.cos(2 * Math.PI * dev);
      s += w * Math.sin(2 * Math.PI * dev);
    }
  }
  return c === 0 && s === 0 ? 0 : Math.atan2(s, c) / (2 * Math.PI);
}

/** Maps a linear magnitude spectrum onto tuned log-frequency bins. */
function logMap(binHz: number, tuning: number) {
  const pos = new Float64Array(BINS);
  const lo = new Int32Array(BINS);
  const hi = new Int32Array(BINS);
  const half = Math.pow(2, 1 / (2 * 12 * BPS)) - 1;
  for (let b = 0; b < BINS; b++) {
    const hz = 440 * Math.pow(2, (MIDI_LO + b / BPS - 69 + tuning) / 12);
    const kf = hz / binHz;
    pos[b] = kf;
    lo[b] = Math.ceil(kf * (1 - half));
    hi[b] = Math.floor(kf * (1 + half));
  }
  return (mag: Float64Array, out: Float32Array, o: number) => {
    for (let b = 0; b < BINS; b++) {
      let v: number;
      if (hi[b] - lo[b] >= 1) {
        v = 0;
        for (let k = lo[b]; k <= hi[b]; k++) v = Math.max(v, mag[k]);
      } else {
        const k = Math.floor(pos[b]);
        const fr = pos[b] - k;
        v = mag[k] * (1 - fr) + mag[k + 1] * fr;
      }
      out[o + b] = v;
    }
  };
}

/** Subtracts the running mean and divides by the running deviation, over an octave. */
function whiten(v: Float32Array, o: number, tmp: Float64Array) {
  const W = 6 * BPS;
  for (let b = 0; b < BINS; b++) tmp[b] = v[o + b];
  let s = 0, s2 = 0, n = 0;
  let a = 0, z = 0;
  for (let b = 0; b < BINS; b++) {
    const want0 = Math.max(0, b - W), want1 = Math.min(BINS - 1, b + W);
    while (z <= want1) { s += tmp[z]; s2 += tmp[z] * tmp[z]; n++; z++; }
    while (a < want0) { s -= tmp[a]; s2 -= tmp[a] * tmp[a]; n--; a++; }
    const mu = s / n;
    const sd = Math.sqrt(Math.max(1e-18, s2 / n - mu * mu));
    v[o + b] = Math.max(0, (tmp[b] - mu) / sd);
  }
}

/* --------------------------------------------------------------- Notes -- */

/** Harmonic note templates on the log-frequency axis, partials falling by 0.7 each. */
function dictionary(partialDecay: number) {
  const W = new Float64Array(NOTES * BINS);
  for (let n = 0; n < NOTES; n++) {
    const base = (NOTE_LO + n - MIDI_LO) * BPS;
    for (let h = 1; h <= 20; h++) {
      const p = base + 12 * BPS * Math.log2(h);
      if (p > BINS - 2) break;
      const amp = Math.pow(partialDecay, h - 1);
      const k = Math.floor(p);
      const fr = p - k;
      W[n * BINS + k] += amp * (1 - fr);
      W[n * BINS + k + 1] += amp * fr;
    }
    let norm = 0;
    for (let b = 0; b < BINS; b++) norm += W[n * BINS + b] ** 2;
    norm = Math.sqrt(norm);
    for (let b = 0; b < BINS; b++) W[n * BINS + b] /= norm;
  }
  const G = new Float64Array(NOTES * NOTES);
  for (let i = 0; i < NOTES; i++)
    for (let j = 0; j < NOTES; j++) {
      let d = 0;
      for (let b = 0; b < BINS; b++) d += W[i * BINS + b] * W[j * BINS + b];
      G[i * NOTES + j] = d;
    }
  return { W, G };
}

/** Non-negative least squares by cyclic coordinate descent; small enough to converge in a few sweeps. */
function nnls(W: Float64Array, G: Float64Array, v: Float64Array, h: Float64Array) {
  const wv = new Float64Array(NOTES);
  for (let n = 0; n < NOTES; n++) {
    let d = 0;
    for (let b = 0; b < BINS; b++) d += W[n * BINS + b] * v[b];
    wv[n] = d;
  }
  h.fill(0);
  const grad = new Float64Array(NOTES);
  for (let n = 0; n < NOTES; n++) grad[n] = -wv[n];
  for (let sweep = 0; sweep < 30; sweep++) {
    let moved = 0;
    for (let j = 0; j < NOTES; j++) {
      const nh = Math.max(0, h[j] - grad[j] / G[j * NOTES + j]);
      const d = nh - h[j];
      if (d === 0) continue;
      h[j] = nh;
      moved += Math.abs(d);
      for (let i = 0; i < NOTES; i++) grad[i] += G[i * NOTES + j] * d;
    }
    if (moved < 1e-6) break;
  }
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** Bass: fully up to B2, gone by A3. Treble: fades in from G2 to G3 and out from E5 to E6. */
const bassWeight = (m: number) => 1 - smoothstep(47, 57, m);
const trebleWeight = (m: number) => smoothstep(43, 55, m) * (1 - smoothstep(76, 88, m));

export interface BeatChroma {
  bass: Float64Array[];
  treble: Float64Array[];
  /** Relative loudness of each beat's tonal content, 1 = the song's median. */
  level: number[];
}

/* -------------------------------------------------------------- Chords -- */

interface ChordType {
  iv: number[];
  w: number[];
  quality: 'maj' | 'min';
  seventh: boolean;
}
const TYPES: ChordType[] = [
  { iv: [0, 4, 7], w: [1, 1, 1], quality: 'maj', seventh: false },
  { iv: [0, 3, 7], w: [1, 1, 1], quality: 'min', seventh: false },
  { iv: [0, 4, 7, 10], w: [1, 1, 1, 0.8], quality: 'maj', seventh: true },
  { iv: [0, 4, 7, 11], w: [1, 1, 1, 0.8], quality: 'maj', seventh: true },
  { iv: [0, 3, 7, 10], w: [1, 1, 1, 0.8], quality: 'min', seventh: true },
];
const NT = TYPES.length;
const STATES = 12 * NT + 1;
const N_STATE = STATES - 1;
const TEMPLATES = (() => {
  const out: Float64Array[] = [];
  for (let r = 0; r < 12; r++)
    for (const t of TYPES) {
      const v = new Float64Array(12);
      t.iv.forEach((iv, i) => (v[(r + iv) % 12] = t.w[i]));
      const norm = Math.hypot(...v);
      for (let p = 0; p < 12; p++) v[p] /= norm;
      out.push(v);
    }
  return out;
})();
const stateRoot = (s: number) => Math.floor(s / NT);
const stateType = (s: number) => TYPES[s % NT];
/** Same displayed chord: C and C7 are one label. */
const label = (s: number) => (s === N_STATE ? -1 : stateRoot(s) * 2 + (stateType(s).quality === 'min' ? 1 : 0));

/** Diatonic labels (root * 2 + minor) for a key, with how central each is. */
function keyChords(key: { tonic: number; mode: 'major' | 'minor' }): Map<number, number> {
  const m = new Map<number, number>();
  const add = (off: number, minor: boolean, w: number) => m.set(((key.tonic + off) % 12) * 2 + (minor ? 1 : 0), w);
  if (key.mode === 'major') {
    add(0, false, 1); add(5, false, 0.65); add(7, false, 0.7); add(9, true, 0.5); add(2, true, 0.45); add(4, true, 0.3);
    add(10, false, 0.2); add(5, true, 0.12); add(8, false, 0.12); add(2, false, 0.1); add(4, false, 0.1);
  } else {
    add(0, true, 1); add(8, false, 0.6); add(10, false, 0.6); add(3, false, 0.55); add(5, true, 0.55); add(7, false, 0.5);
    add(7, true, 0.4); add(5, false, 0.12);
  }
  return m;
}

function emissions(bc: BeatChroma, key: KeyInfo | null, p: HarmonyParams): Float64Array[] {
  const prior = key ? keyChords(key) : null;
  return bc.treble.map((tr, t) => {
    const e = new Float64Array(STATES);
    const bs = bc.bass[t];
    let bsum = 0;
    for (let p = 0; p < 12; p++) bsum += bs[p];
    let tn = 0;
    for (let p = 0; p < 12; p++) tn += tr[p] * tr[p];
    tn = Math.sqrt(tn) || 1;
    let fitMax = 0;
    let fitSum = 0;
    for (let s = 0; s < N_STATE; s++) {
      const tpl = TEMPLATES[s];
      let d = 0;
      for (let p = 0; p < 12; p++) d += tr[p] * tpl[p];
      fitMax = Math.max(fitMax, d / tn);
      fitSum += d / tn;
      const r = stateRoot(s);
      const ty = stateType(s);
      const third = (r + ty.iv[1]) % 12;
      const fifth = (r + 7) % 12;
      const bassFit = bsum > 0 ? (bs[r] + p.bassTones * (bs[third] + bs[fifth])) / bsum : 0;
      let v = d / tn + p.bassFit * bassFit - (ty.seventh ? p.seventhCost : 0);
      if (prior?.has(label(s))) v += p.keyPrior;
      e[s] = v;
    }
    const margin = fitMax - fitSum / N_STATE;
    e[N_STATE] = bc.level[t] < p.silence ? 2 : p.noChord + p.flatNoChord * Math.max(0, p.flatPivot - margin);
    return e;
  });
}

/** Viterbi over chord states; changing the shown chord costs least on a downbeat. */
function decode(e: Float64Array[], barPos: Int8Array, p: HarmonyParams): Int16Array {
  const T = e.length;
  const path = new Int16Array(T);
  if (!T) return path;
  let delta = Float64Array.from(e[0]);
  const back: Int16Array[] = [];
  for (let t = 1; t < T; t++) {
    const change = p.changeCost[barPos[t]];
    let best = 0;
    for (let s = 1; s < STATES; s++) if (delta[s] > delta[best]) best = s;
    // Best way into each label, for moves between types of one chord (C to C7).
    const labelBest = new Map<number, number>();
    for (let s = 0; s < STATES; s++) {
      const l = label(s);
      const cur = labelBest.get(l);
      if (cur === undefined || delta[s] > delta[cur]) labelBest.set(l, s);
    }
    const next = new Float64Array(STATES);
    const bk = new Int16Array(STATES);
    for (let s = 0; s < STATES; s++) {
      let v = delta[s];
      let from = s;
      const same = labelBest.get(label(s))!;
      if (same !== s && delta[same] - p.typeChange > v) {
        v = delta[same] - p.typeChange;
        from = same;
      }
      if (delta[best] - change > v) {
        v = delta[best] - change;
        from = best;
      }
      next[s] = v + e[t][s];
      bk[s] = from;
    }
    back.push(bk);
    delta = next;
  }
  let s = 0;
  for (let k = 1; k < STATES; k++) if (delta[k] > delta[s]) s = k;
  for (let t = T - 1; t >= 0; t--) {
    path[t] = s;
    if (t > 0) s = back[t - 1][s];
  }
  return path;
}

function segments(path: Int16Array, beats: Float32Array, duration: number): ChordSeg[] {
  const T = path.length;
  const beatLen = T > 1 ? (beats[T - 1] - beats[0]) / (T - 1) : 0.5;
  const segs: ChordSeg[] = [];
  for (let t = 0; t < T; t++) {
    const s = path[t];
    if (s === N_STATE) continue;
    const start = beats[t];
    const end = t + 1 < T ? beats[t + 1] : Math.min(duration, start + beatLen);
    const root = stateRoot(s);
    const quality = stateType(s).quality;
    const last = segs[segs.length - 1];
    if (last && last.root === root && last.quality === quality && Math.abs(last.end - start) < 0.05) last.end = end;
    else segs.push({ t: start, end, root, quality });
  }
  return segs;
}

/* ----------------------------------------------------------------- Key -- */

// Pitch-class weight in pop and rock harmony, for the treble and for the bass.
// The minor profile is Aeolian (flat seventh) with the leading tone of V weaker.
const TREBLE_MAJOR = [1, 0.12, 0.55, 0.12, 0.8, 0.6, 0.12, 0.85, 0.12, 0.6, 0.25, 0.4];
const TREBLE_MINOR = [1, 0.12, 0.5, 0.8, 0.12, 0.55, 0.12, 0.85, 0.55, 0.12, 0.5, 0.3];
const BASS_MAJOR = [1, 0.05, 0.35, 0.05, 0.25, 0.65, 0.05, 0.75, 0.05, 0.5, 0.15, 0.1];
const BASS_MINOR = [1, 0.05, 0.15, 0.5, 0.05, 0.5, 0.05, 0.55, 0.55, 0.05, 0.55, 0.05];

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let ma = 0, mb = 0;
  for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
  ma /= 12; mb /= 12;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / (Math.sqrt(da * db) || 1);
}

const KEYS: { tonic: number; mode: 'major' | 'minor' }[] = [];
for (let t = 0; t < 12; t++) KEYS.push({ tonic: t, mode: 'major' }, { tonic: t, mode: 'minor' });

function zscore(a: number[]): number[] {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length) || 1;
  return a.map((v) => (v - m) / sd);
}

function profileScores(bc: BeatChroma): number[] {
  const tr = new Float64Array(12);
  const bs = new Float64Array(12);
  bc.treble.forEach((v, t) => {
    const w = Math.min(1, bc.level[t]);
    let mx = 1e-12;
    for (let p = 0; p < 12; p++) mx = Math.max(mx, v[p]);
    for (let p = 0; p < 12; p++) tr[p] += (v[p] / mx) * w;
    const b = bc.bass[t];
    let bsum = 1e-12;
    for (let p = 0; p < 12; p++) bsum += b[p];
    for (let p = 0; p < 12; p++) bs[p] += (b[p] / bsum) * w;
  });
  return KEYS.map(({ tonic, mode }) => {
    const rot = (prof: number[]) => Array.from({ length: 12 }, (_, p) => prof[(p - tonic + 12) % 12]);
    const pt = mode === 'major' ? TREBLE_MAJOR : TREBLE_MINOR;
    const pb = mode === 'major' ? BASS_MAJOR : BASS_MINOR;
    return pearson(tr, rot(pt)) + 0.6 * pearson(bs, rot(pb));
  });
}

/**
 * How well the chords fit each key: time spent on its diatonic chords, most
 * of all its tonic, the tonic opening or closing the song, and chords that
 * resolve onto it (V to I, IV to I, bVII to i).
 */
function chordScores(segs: ChordSeg[]): number[] {
  const total = segs.reduce((a, c) => a + c.end - c.t, 0) || 1;
  return KEYS.map((key) => {
    const fit = keyChords(key);
    const tonic = key.tonic * 2 + (key.mode === 'minor' ? 1 : 0);
    let s = 0;
    for (const c of segs) s += ((fit.get(c.root * 2 + (c.quality === 'min' ? 1 : 0)) ?? -0.4) * (c.end - c.t)) / total;
    const isTonic = (c: ChordSeg) => c.root * 2 + (c.quality === 'min' ? 1 : 0) === tonic;
    if (segs.length && isTonic(segs[0])) s += 0.06;
    if (segs.length && isTonic(segs[segs.length - 1])) s += 0.06;
    let cad = 0;
    for (let i = 1; i < segs.length; i++) {
      if (!isTonic(segs[i])) continue;
      const iv = (segs[i - 1].root - key.tonic + 12) % 12;
      if (iv === 7 && segs[i - 1].quality === 'maj') cad += 1;
      else if (iv === 5 || iv === 10) cad += 0.5;
    }
    return s + (0.25 * cad) / Math.max(4, segs.length);
  });
}

/* ------------------------------------------------------------ Analysis -- */

/**
 * Key, chords and tuning for a mono signal at `rate` (about 22 kHz), on the
 * beat grid already found. `barPos` is each beat's place in its bar, 0 on
 * the downbeat.
 */
export function analyseHarmony(
  x: Float32Array,
  rate: number,
  beats: Float32Array,
  barPos: Int8Array,
  duration: number,
  p: HarmonyParams = HARMONY_DEFAULTS,
): Harmony {
  const { bc, tuning } = harmonyChroma(x, rate, beats, duration, p);
  return { ...harmonyFromChroma(bc, beats, barPos, duration, p), tuningCents: Math.round(tuning * 100) };
}

/** Per beat, the bass and treble pitch classes of the notes sounding, and the tuning they were read at. */
export function harmonyChroma(x: Float32Array, rate: number, beats: Float32Array, duration: number, p: HarmonyParams = HARMONY_DEFAULTS) {
  const { y, rate: r2 } = decimate(x, rate);
  const binHz = r2 / N_FFT;
  const frames = Math.max(1, Math.ceil(y.length / HOP));
  const stft = new Stft(y);
  const tuning = estimateTuning(stft, frames, binHz);
  const map = logMap(binHz, tuning);

  const spec = new Float32Array(frames * BINS);
  const energy = new Float64Array(frames);
  const tmp = new Float64Array(BINS);
  for (let f = 0; f < frames; f++) {
    const m = stft.frame(f * HOP);
    map(m, spec, f * BINS);
    let e = 0;
    for (let b = 0; b < BINS; b++) e += spec[f * BINS + b] ** 2;
    energy[f] = e;
    whiten(spec, f * BINS, tmp);
  }

  const { W, G } = dictionary(p.partialDecay);
  const T = beats.length;
  const bc: BeatChroma = { bass: [], treble: [], level: [] };
  const beatEnergy: number[] = [];
  const v = new Float64Array(BINS);
  const h = new Float64Array(NOTES);
  const col: number[] = [];
  const frameAt = (t: number) => Math.round((t * r2) / HOP);
  for (let i = 0; i < T; i++) {
    const t0 = beats[i];
    const t1 = i + 1 < T ? beats[i + 1] : Math.min(duration, t0 + (i > 0 ? beats[i] - beats[i - 1] : 0.5));
    let f0 = Math.max(0, frameAt(t0));
    let f1 = Math.min(frames - 1, frameAt(t1) - 1);
    if (f1 < f0) f1 = f0 = Math.min(frames - 1, f0);
    let e = 0;
    for (let f = f0; f <= f1; f++) e += energy[f];
    beatEnergy.push(e / (f1 - f0 + 1));
    for (let b = 0; b < BINS; b++) {
      col.length = 0;
      for (let f = f0; f <= f1; f++) col.push(spec[f * BINS + b]);
      col.sort((p, q) => p - q);
      v[b] = col[col.length >> 1];
    }
    nnls(W, G, v, h);
    const bass = new Float64Array(12);
    const treble = new Float64Array(12);
    for (let n = 0; n < NOTES; n++) {
      if (h[n] <= 0) continue;
      const m = NOTE_LO + n;
      bass[m % 12] += h[n] * bassWeight(m);
      treble[m % 12] += h[n] * trebleWeight(m);
    }
    bc.bass.push(bass);
    bc.treble.push(treble);
  }
  const sorted = [...beatEnergy].sort((p, q) => p - q);
  const med = sorted[sorted.length >> 1] || 1;
  bc.level = beatEnergy.map((e) => e / med);
  return { bc, tuning };
}

/** Key and chords from the beat chroma. */
export function harmonyFromChroma(bc: BeatChroma, beats: Float32Array, barPos: Int8Array, duration: number, p: HarmonyParams = HARMONY_DEFAULTS) {
  // A first pass without a key, to see what the chords do.
  const first = segments(decode(emissions(bc, null, p), barPos, p), beats, duration);
  const prof = zscore(profileScores(bc));
  const chordFit = zscore(chordScores(first));
  const combined = prof.map((v, i) => p.profileWeight * v + chordFit[i]);
  let top = 0;
  for (let i = 1; i < KEYS.length; i++) if (combined[i] > combined[top]) top = i;
  // Confidence is the winner's share of a softmax over all 24 keys, so a
  // close relative or neighbour key pulls it down.
  let sum = 0;
  for (const c of combined) sum += Math.exp(p.keySharpness * (c - combined[top]));
  const key: KeyInfo = { tonic: KEYS[top].tonic, mode: KEYS[top].mode, confidence: 1 / sum };

  const chords = segments(decode(emissions(bc, key, p), barPos, p), beats, duration);
  return { key, chords };
}
