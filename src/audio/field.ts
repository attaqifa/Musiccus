/*
 * Peta mix: where every sound sits in the stereo mix, read from the two
 * channels as they play. No stems are needed, so it works on any file, on a
 * captured tab, and on whatever Racik and the stem mixer send out.
 *
 * Each analysis takes the last ~170 ms of the left and right channel through
 * one FFT (long enough to tell a keyboard on the left from a bass in the
 * middle a few hertz away). For every frequency bin it measures:
 *
 * - Direct or diffuse: a source panned anywhere keeps the two channels
 *   coherent over time. Reverb, wide pads and decorrelated stereo do not.
 *   The two channels' covariance splits the bin into a direct part and an
 *   equal-in-both-channels diffuse part (primary-ambient extraction).
 * - Pan of the direct part: the principal direction of that covariance, read
 *   back through the constant-power pan law (what a StereoPannerNode or a
 *   console pan pot does). Diffuse sound in the same bin does not tilt it.
 * - Tone or hit: a narrow peak in frequency is a note. Broad energy is a hit
 *   when it is new, and a sustained sound (a distorted guitar, a cymbal
 *   wash) when it was already there a quarter of a second ago. Notes count
 *   as notes from their first frame, so a bass line does not flash as a hit.
 *
 * The energy is gathered into a grid of bands (30 Hz to 16 kHz, log spaced)
 * by pan positions (hard left to hard right) in three layers: tone, hit and
 * haze. Instruments a mix engineer separated by EQ, pan, depth or attack
 * land in different places, so the grid shows the separation of the song.
 * Two sounds at the same pitch, place and character still merge: the grid
 * shows where sound is, not which instrument made it.
 *
 * The analyser is plain DSP with no Web Audio dependency, so src/dev/fieldLab.ts
 * can measure it on synthetic mixes whose answers are known.
 */
import { FFT } from '../analysis/fft';

export const FIELD_BANDS = 96;
/** Odd, so a centred sound sits in one cell (the middle one) instead of two. */
export const FIELD_PANS = 33;
export const FIELD_LO = 30;
export const FIELD_HI = 16000;
export const FIELD_CELLS = FIELD_BANDS * FIELD_PANS;

/** FFT length for a sample rate: about 170 ms, the same at 44.1, 48, 96 and 192 kHz. */
export const fieldFftSize = (rate: number) => (rate <= 50000 ? 8192 : rate <= 100000 ? 16384 : 32768);

/** Dynamic range of the grid layers and band levels, dB. */
const RANGE_DB = 60;
/** Tilt per octave around 1 kHz so music reads roughly flat (as the hub bands). */
const TILT_DB = 3;
/** A peak must stand this many times above its neighbourhood (6 dB) to count as a note. */
const PEAK_RATIO = 2;
/** Neighbourhood for the frequency median: one sixth of an octave each side, in bins. */
const SIXTH = Math.pow(2, 1 / 6) - 1;
const MEDIAN_MIN = 3;
const MEDIAN_MAX = 16;
/** Broad energy that was present this long ago counts as sustained. */
const SUSTAIN_SEC = 0.25;
const SUSTAIN_FRAMES = 32;
/**
 * Broad energy is a hit only where a band rises clearly above its recent low.
 * How clearly depends on how many bins the band sums: a few bins of steady
 * noise wobble far more than a hundred. See fieldLab's report.
 */
const SUSTAIN_SLACK = 1.5;
/** Averaging time of the cross-spectrum, and the bins each side averaged with it. */
const COHERENCE_SEC = 0.15;
const COHERENCE_SPAN = 2;
/**
 * The coherence of two unrelated noises, measured with the averaging above,
 * does not reach 0: a short average always finds some agreement (about 0.33
 * on the lab's wide pad). Values up to this are fully diffuse; see
 * fieldLab's `calibrate()`.
 */
const DIFFUSE_FLOOR = 0.3;
/**
 * Diffuse sound has no single place, so it is spread across the stereo field:
 * three box passes of this radius in pan cells, about 0.35 pan units of
 * standard deviation (2 = edge to edge).
 */
const HAZE_BOX = 3;

/** Overrides for the lab's calibration runs; the app uses the defaults. */
export interface FieldOptions {
  diffuseFloor?: number;
  coherenceSec?: number;
  coherenceSpan?: number;
}

/**
 * The grids (tone, hit, haze) are FIELD_BANDS by FIELD_PANS, indexed
 * band * FIELD_PANS + pan, pan 0 = hard left. Every cell and band level is
 * 0..1 on a 60 dB scale against the song's recent loudest band, like the
 * hub's bands.
 */
export interface MixField {
  /** Band centre frequencies in Hz, low to high. */
  readonly freqs: Float32Array;
  /** Sustained direct sound: notes, chords, held vowels, sustained noise. */
  readonly tone: Float32Array;
  /** Transient direct sound: drum hits, plucks, strums, consonants. */
  readonly hit: Float32Array;
  /** Diffuse sound: reverb, wide pads, decorrelated stereo. */
  readonly haze: Float32Array;
  /** Per band, 0..1, all layers together on the same scale. */
  readonly level: Float32Array;
  /** Per band, -1 (left) .. 1 (right): where the band's direct sound sits on average. */
  readonly pan: Float32Array;
  /** Per band, 0..1: how much of the band is diffuse. */
  readonly diffuse: Float32Array;
  /** Per band, 0..1: how much of the band's direct sound is transient. */
  readonly hitShare: Float32Array;
  /** Per band, -1..1: phase correlation; below 0 the band cancels in mono. */
  readonly corr: Float32Array;
  /** Whole mix, 0 (mono) .. 1 (fully decorrelated or wider): side against mid. */
  width: number;
  /** Whole mix, -1 (left) .. 1 (right). */
  balance: number;
  /** The two channels are (nearly) identical. */
  mono: boolean;
  /** Sound is playing and loud enough to read. */
  active: boolean;
}

const bandFreqs = (() => {
  const f = new Float32Array(FIELD_BANDS);
  for (let b = 0; b < FIELD_BANDS; b++) f[b] = FIELD_LO * Math.pow(FIELD_HI / FIELD_LO, b / (FIELD_BANDS - 1));
  return f;
})();
const LOG_SPAN = Math.log(FIELD_HI / FIELD_LO);
/** Continuous band position of a frequency: band b covers b - 0.5 .. b + 0.5. */
const bandPos = (hz: number) => (Math.log(Math.max(1, hz) / FIELD_LO) / LOG_SPAN) * (FIELD_BANDS - 1);
const bandTilt = (() => {
  const t = new Float32Array(FIELD_BANDS);
  for (let b = 0; b < FIELD_BANDS; b++) t[b] = TILT_DB * Math.log2(bandFreqs[b] / 1000);
  return t;
})();

export function emptyField(): MixField {
  return {
    freqs: bandFreqs,
    tone: new Float32Array(FIELD_CELLS),
    hit: new Float32Array(FIELD_CELLS),
    haze: new Float32Array(FIELD_CELLS),
    level: new Float32Array(FIELD_BANDS),
    pan: new Float32Array(FIELD_BANDS),
    diffuse: new Float32Array(FIELD_BANDS),
    hitShare: new Float32Array(FIELD_BANDS),
    corr: new Float32Array(FIELD_BANDS).fill(1),
    width: 0,
    balance: 0,
    mono: false,
    active: false,
  };
}

export function copyField(dst: MixField, src: MixField) {
  dst.tone.set(src.tone);
  dst.hit.set(src.hit);
  dst.haze.set(src.haze);
  dst.level.set(src.level);
  dst.pan.set(src.pan);
  dst.diffuse.set(src.diffuse);
  dst.hitShare.set(src.hitShare);
  dst.corr.set(src.corr);
  dst.width = src.width;
  dst.balance = src.balance;
  dst.mono = src.mono;
  dst.active = src.active;
}

/** Length of a field packed into one Float32Array, for passing it between threads. */
export const FIELD_PACKED = 3 * FIELD_CELLS + 5 * FIELD_BANDS + 4;

export function packField(f: MixField, out: Float32Array) {
  let o = 0;
  for (const a of [f.tone, f.hit, f.haze, f.level, f.pan, f.diffuse, f.hitShare, f.corr]) {
    out.set(a, o);
    o += a.length;
  }
  out[o] = f.width;
  out[o + 1] = f.balance;
  out[o + 2] = f.mono ? 1 : 0;
  out[o + 3] = f.active ? 1 : 0;
}

export function unpackField(src: Float32Array, f: MixField) {
  let o = 0;
  for (const a of [f.tone, f.hit, f.haze, f.level, f.pan, f.diffuse, f.hitShare, f.corr]) {
    a.set(src.subarray(o, o + a.length));
    o += a.length;
  }
  f.width = src[o];
  f.balance = src[o + 1];
  f.mono = src[o + 2] > 0.5;
  f.active = src[o + 3] > 0.5;
}

/** Lets the picture fade out when nothing plays, instead of freezing on the last frame. */
export function decayField(f: MixField, dt: number) {
  const k = Math.exp(-dt * 3);
  for (let i = 0; i < FIELD_CELLS; i++) {
    f.tone[i] *= k;
    f.hit[i] *= k;
    f.haze[i] *= k;
  }
  for (let b = 0; b < FIELD_BANDS; b++) f.level[b] *= k;
  f.active = false;
}

/** k-th smallest of a[0..n) (0-based), reordering a. */
function select(a: Float32Array, n: number, k: number): number {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k];
  }
  return a[k];
}

/**
 * Blurs every band's row across pan with three box passes (close to a
 * Gaussian), keeping its energy: what would spill past hard left or right is
 * reflected back in.
 */
function blurRows(grid: Float64Array, radius: number, tmp: Float64Array) {
  const P = FIELD_PANS;
  const a = tmp.subarray(0, P);
  const b = tmp.subarray(P, 2 * P);
  const at = (x: Float64Array, q: number) => x[q < 0 ? -q - 1 : q >= P ? 2 * P - q - 1 : q];
  const norm = 1 / (2 * radius + 1);
  for (let band = 0; band < FIELD_BANDS; band++) {
    const row = band * P;
    let any = false;
    for (let p = 0; p < P; p++) {
      a[p] = grid[row + p];
      if (a[p] > 0) any = true;
    }
    if (!any) continue;
    for (let pass = 0; pass < 3; pass++) {
      const src = pass % 2 === 0 ? a : b;
      const dst = pass % 2 === 0 ? b : a;
      let sum = 0;
      for (let q = -radius; q <= radius; q++) sum += at(src, q);
      for (let p = 0; p < P; p++) {
        dst[p] = sum * norm;
        sum += at(src, p + radius + 1) - at(src, p - radius);
      }
    }
    for (let p = 0; p < P; p++) grid[row + p] = b[p];
  }
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ease = (cur: number, target: number, up: number, down: number) => cur + (target - cur) * (target > cur ? up : down);

export class FieldAnalyzer {
  readonly n: number;
  readonly rate: number;
  private fft: FFT;
  private win: Float64Array;
  private re: Float64Array;
  private im: Float64Array;
  private binHz: number;
  private kLo: number;
  private kHi: number;
  /** Per bin, this frame. */
  private pl: Float32Array;
  private pr: Float32Array;
  private mag: Float32Array;
  private hz: Float32Array;
  private floor: Float32Array;
  /** Per bin, averaged over time: left power, right power, cross-spectrum. */
  private aL: Float32Array;
  private aR: Float32Array;
  private aCr: Float32Array;
  private aCi: Float32Array;
  /** Band of each bin for the sustain test, and how many bins each band has. */
  private binBand: Int16Array;
  private slack = new Float32Array(FIELD_BANDS);
  /** Broad power per band this frame, the last frames' values, and their times. */
  private broadNow = new Float64Array(FIELD_BANDS);
  private past = new Float64Array(SUSTAIN_FRAMES * FIELD_BANDS);
  private pastT = new Float64Array(SUSTAIN_FRAMES).fill(-Infinity);
  private pastHead = -1;
  private hitFrac = new Float32Array(FIELD_BANDS);
  private scratch = new Float32Array(Math.max(SUSTAIN_FRAMES, MEDIAN_MAX * 2 + 1));
  private scratch64 = new Float64Array(SUSTAIN_FRAMES);
  /** Raw accumulation, linear power. */
  private cTone = new Float64Array(FIELD_CELLS);
  private cHit = new Float64Array(FIELD_CELLS);
  private cHaze = new Float64Array(FIELD_CELLS);
  private bDirect = new Float64Array(FIELD_BANDS);
  private bAmbient = new Float64Array(FIELD_BANDS);
  private bHit = new Float64Array(FIELD_BANDS);
  private bPan = new Float64Array(FIELD_BANDS);
  private bL = new Float64Array(FIELD_BANDS);
  private bR = new Float64Array(FIELD_BANDS);
  private bC = new Float64Array(FIELD_BANDS);
  private ref = -60;
  private mid = 0;
  private side = 0;
  private sumL = 0;
  private sumR = 0;
  private time = 0;
  private diffuseFloor: number;
  private coherenceSec: number;
  private span: number;
  /** Band positions of each bin's lower and upper edge. */
  private uLo: Float32Array;
  private uHi: Float32Array;
  private rowTmp = new Float64Array(FIELD_PANS * 2);

  constructor(rate: number, n = fieldFftSize(rate), opts: FieldOptions = {}) {
    this.diffuseFloor = opts.diffuseFloor ?? DIFFUSE_FLOOR;
    this.coherenceSec = opts.coherenceSec ?? COHERENCE_SEC;
    this.span = opts.coherenceSpan ?? COHERENCE_SPAN;

    this.rate = rate;
    this.n = n;
    this.fft = new FFT(n);
    this.win = new Float64Array(n);
    for (let i = 0; i < n; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.binHz = rate / n;
    this.kLo = Math.max(1, Math.floor(FIELD_LO / Math.pow(2, 1 / 12) / this.binHz));
    this.kHi = Math.min(n / 2 - 2, Math.ceil((FIELD_HI * Math.pow(2, 1 / 12)) / this.binHz));
    const bins = n / 2 + 1;
    this.pl = new Float32Array(bins);
    this.pr = new Float32Array(bins);
    this.mag = new Float32Array(bins);
    this.hz = new Float32Array(bins);
    this.floor = new Float32Array(bins);
    this.aL = new Float32Array(bins);
    this.aR = new Float32Array(bins);
    this.aCr = new Float32Array(bins);
    this.aCi = new Float32Array(bins);
    this.uLo = new Float32Array(bins);
    this.uHi = new Float32Array(bins);
    for (let k = 1; k < bins; k++) {
      this.uLo[k] = bandPos((k - 0.5) * this.binHz);
      this.uHi[k] = bandPos((k + 0.5) * this.binHz);
    }
    this.binBand = new Int16Array(bins).fill(-1);
    const count = new Float32Array(FIELD_BANDS);
    for (let k = this.kLo; k <= this.kHi; k++) {
      const b = Math.round(bandPos(k * this.binHz));
      if (b < 0 || b >= FIELD_BANDS) continue;
      this.binBand[k] = b;
      count[b]++;
    }
    for (let b = 0; b < FIELD_BANDS; b++) this.slack[b] = 1 + SUSTAIN_SLACK / Math.sqrt(Math.max(1, count[b]));
  }

  /** The last analysis before normalising: linear power per cell. For the labs. */
  get raw(): { tone: Float64Array; hit: Float64Array; haze: Float64Array } {
    return { tone: this.cTone, hit: this.cHit, haze: this.cHaze };
  }

  reset() {
    this.aL.fill(0);
    this.aR.fill(0);
    this.aCr.fill(0);
    this.aCi.fill(0);
    this.pastT.fill(-Infinity);
    this.ref = -60;
    this.mid = this.side = this.sumL = this.sumR = 0;
  }

  /**
   * Analyses the newest `n` samples of `left` and `right` (each at least `n`
   * long) into `out`. `dt` is the time since the previous analysis.
   */
  analyze(left: Float32Array, right: Float32Array, dt: number, out: MixField) {
    const { n, re, im, win, pl, pr, mag, hz, floor, aL, aR, aCr, aCi } = this;
    const kLo = this.kLo;
    const kHi = this.kHi;
    this.time += dt;
    const off = left.length - n;
    const offR = right.length - n;
    for (let i = 0; i < n; i++) {
      re[i] = left[off + i] * win[i];
      im[i] = right[offR + i] * win[i];
    }
    this.fft.transform(re, im);

    // Split the packed transform into the two channels; average the
    // cross-spectrum over time for the coherence.
    const scale = 16 / (n * n);
    const a = 1 - Math.exp(-dt / this.coherenceSec);
    let mid = 0;
    let side = 0;
    let sumL = 0;
    let sumR = 0;
    const span = this.span;
    // A margin around the range, for the neighbourhoods read below.
    const kA = Math.max(1, kLo - MEDIAN_MAX - 1);
    const kB = Math.min(n / 2 - 1, kHi + MEDIAN_MAX + 1);
    for (let k = kA; k <= kB; k++) {
      const nk = n - k;
      const lr = 0.5 * (re[k] + re[nk]);
      const li = 0.5 * (im[k] - im[nk]);
      const rr = 0.5 * (im[k] + im[nk]);
      const ri = -0.5 * (re[k] - re[nk]);
      const L = (lr * lr + li * li) * scale;
      const R = (rr * rr + ri * ri) * scale;
      pl[k] = L;
      pr[k] = R;
      mag[k] = Math.sqrt(L + R);
      aL[k] += (L - aL[k]) * a;
      aR[k] += (R - aR[k]) * a;
      aCr[k] += ((lr * rr + li * ri) * scale - aCr[k]) * a;
      aCi[k] += ((li * rr - lr * ri) * scale - aCi[k]) * a;
      if (k >= kLo && k <= kHi) {
        const mr = lr + rr;
        const mi = li + ri;
        const sr = lr - rr;
        const si = li - ri;
        mid += mr * mr + mi * mi;
        side += sr * sr + si * si;
        sumL += L;
        sumR += R;
      }
    }

    // Frequency of each bin, refined at spectral peaks so a note lands on
    // its pitch instead of spreading over the bins of its window.
    const binHz = this.binHz;
    for (let k = kLo; k <= kHi; k++) hz[k] = k * binHz;
    for (let k = kLo; k <= kHi; k++) {
      const m = mag[k];
      if (m <= mag[k - 1] || m <= mag[k + 1] || m <= 0) continue;
      const al = Math.log(mag[k - 1] + 1e-12);
      const be = Math.log(m + 1e-12);
      const ga = Math.log(mag[k + 1] + 1e-12);
      const den = al - 2 * be + ga;
      const d = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (al - ga)) / den)) : 0;
      const f = (k + d) * binHz;
      hz[k] = f;
      if (k - 1 >= kLo) hz[k - 1] = f;
      if (k + 1 <= kHi) hz[k + 1] = f;
    }

    // Broad energy: the median of the neighbourhood. Peaks above it are notes.
    // Where the neighbourhood is wide the median changes slowly, so it is
    // taken every few bins and joined by straight lines.
    const s = this.scratch;
    let last = -1;
    for (let k = kLo; k <= kHi + 1; ) {
      const w = Math.max(MEDIAN_MIN, Math.min(MEDIAN_MAX, Math.round(k * SIXTH)));
      const lo = Math.max(kA, k - w);
      const hi = Math.min(kB, k + w);
      let c = 0;
      for (let j = lo; j <= hi; j++) s[c++] = mag[j];
      floor[k] = select(s, c, c >> 1);
      if (last >= 0) for (let j = last + 1; j < k; j++) floor[j] = floor[last] + ((floor[k] - floor[last]) * (j - last)) / (k - last);
      last = k;
      k += Math.max(1, w >> 1);
    }

    // Notes stand above their neighbourhood. The rest is broad energy, a hit
    // where its band rose above the band's recent low.
    const broadNow = this.broadNow;
    broadNow.fill(0);
    for (let k = kLo; k <= kHi; k++) {
      const b = this.binBand[k];
      if (b < 0) continue;
      const broad = Math.min(mag[k], PEAK_RATIO * floor[k]);
      broadNow[b] += broad * broad;
    }
    this.pastHead = (this.pastHead + 1) % SUSTAIN_FRAMES;
    this.pastT[this.pastHead] = this.time;
    this.past.set(broadNow, this.pastHead * FIELD_BANDS);
    const s64 = this.scratch64;
    for (let b = 0; b < FIELD_BANDS; b++) {
      let c = 0;
      for (let i = 0; i < SUSTAIN_FRAMES; i++) if (this.pastT[i] >= this.time - SUSTAIN_SEC - 1e-6) s64[c++] = this.past[i * FIELD_BANDS + b];
      if (c < 2 || broadNow[b] <= 0) {
        this.hitFrac[b] = 0;
        continue;
      }
      const sorted = s64.subarray(0, c).sort();
      const low = sorted[Math.floor((c - 1) * 0.25)];
      this.hitFrac[b] = clamp01(1 - (this.slack[b] * low) / broadNow[b]);
    }

    const { cTone, cHit, cHaze, bDirect, bAmbient, bHit, bPan, bL, bR, bC } = this;
    cTone.fill(0);
    cHit.fill(0);
    cHaze.fill(0);
    bDirect.fill(0);
    bAmbient.fill(0);
    bHit.fill(0);
    bPan.fill(0);
    bL.fill(0);
    bR.fill(0);
    bC.fill(0);

    // Coherence over neighbouring bins too: more agreement measured, less bias.
    let sL = 0;
    let sR = 0;
    let sCr = 0;
    let sCi = 0;
    for (let k = Math.max(1, kLo - span); k <= kLo + span - 1; k++) {
      sL += aL[k];
      sR += aR[k];
      sCr += aCr[k];
      sCi += aCi[k];
    }
    const PM = FIELD_PANS - 1;
    for (let k = kLo; k <= kHi; k++) {
      const add = k + span;
      sL += aL[add];
      sR += aR[add];
      sCr += aCr[add];
      sCi += aCi[add];
      const drop = k - span - 1;
      if (k > kLo && drop >= 1) {
        sL -= aL[drop];
        sR -= aR[drop];
        sCr -= aCr[drop];
        sCi -= aCi[drop];
      }
      const e = pl[k] + pr[k];
      if (e <= 1e-14) continue;

      const tot = sL + sR;
      const coh = tot > 0 ? Math.sqrt(4 * (sCr * sCr + sCi * sCi) + (sL - sR) * (sL - sR)) / tot : 1;
      const direct = clamp01((coh - this.diffuseFloor) / (1 - this.diffuseFloor));

      const m = mag[k];
      const sb = this.binBand[k];
      const broad = m > 0 ? Math.min(1, (PEAK_RATIO * floor[k]) / m) : 0;
      const hitShare = sb >= 0 ? broad * broad * this.hitFrac[sb] : 0;

      // The direct sound's place: the principal direction of the two
      // channels' covariance, which diffuse sound in the same bin does not tilt.
      const pan = (Math.atan2(2 * Math.sqrt(aCr[k] * aCr[k] + aCi[k] * aCi[k]), aL[k] - aR[k]) * 2) / Math.PI - 1;
      // Diffuse sound has no single place: it starts from where its level
      // leans and is spread wide below.
      const hazePan = (Math.atan2(Math.sqrt(pr[k]), Math.sqrt(pl[k])) * 4) / Math.PI - 1;
      const eDirect = e * direct;
      const eAmbient = e - eDirect;
      const eHit = eDirect * hitShare;
      const eTone = eDirect - eHit;

      // Spread over the bands the bin covers (a bass bin spans several), and
      // between the two nearest pan positions.
      const f = hz[k];
      const refined = f !== k * binHz;
      const u1 = refined ? bandPos(f - binHz * 0.5) : this.uLo[k];
      const u2 = refined ? bandPos(f + binHz * 0.5) : this.uHi[k];
      const x = ((pan + 1) / 2) * PM;
      const p0 = Math.min(PM, Math.max(0, Math.floor(x)));
      const p1 = Math.min(PM, p0 + 1);
      const fx = Math.min(1, Math.max(0, x - p0));
      const hx = ((hazePan + 1) / 2) * PM;
      const h0 = Math.min(PM, Math.max(0, Math.floor(hx)));
      const h1 = Math.min(PM, h0 + 1);
      const hf = Math.min(1, Math.max(0, hx - h0));
      const width = Math.max(1e-6, u2 - u1);
      const bFirst = Math.max(0, Math.round(u1));
      const bLast = Math.min(FIELD_BANDS - 1, Math.round(u2));
      for (let b = bFirst; b <= bLast; b++) {
        const ov = Math.min(u2, b + 0.5) - Math.max(u1, b - 0.5);
        if (ov <= 0) continue;
        const wt = ov / width;
        const c0 = b * FIELD_PANS + p0;
        const c1 = b * FIELD_PANS + p1;
        cTone[c0] += eTone * wt * (1 - fx);
        cTone[c1] += eTone * wt * fx;
        cHit[c0] += eHit * wt * (1 - fx);
        cHit[c1] += eHit * wt * fx;
        cHaze[b * FIELD_PANS + h0] += eAmbient * wt * (1 - hf);
        cHaze[b * FIELD_PANS + h1] += eAmbient * wt * hf;
        bDirect[b] += eDirect * wt;
        bAmbient[b] += eAmbient * wt;
        bHit[b] += eHit * wt;
        bPan[b] += eDirect * wt * pan;
        bL[b] += aL[k] * wt;
        bR[b] += aR[k] * wt;
        bC[b] += aCr[k] * wt;
      }
    }

    blurRows(cHaze, HAZE_BOX, this.rowTmp);

    // Normalise: dB with the spectral tilt, against the loudest band lately.
    let frameMax = -200;
    for (let b = 0; b < FIELD_BANDS; b++) {
      const db = 10 * Math.log10(bDirect[b] + bAmbient[b] + 1e-20) + bandTilt[b];
      if (db > frameMax) frameMax = db;
    }
    this.ref = Math.max(this.ref - 3 * dt, frameMax, -80);
    const bottom = this.ref - RANGE_DB;
    // Most cells are empty: skip the logarithm for anything under the scale.
    const tiny = Math.pow(10, (bottom - 40) / 10);
    const norm = (p: number, b: number) => (p < tiny ? 0 : clamp01((10 * Math.log10(p) + bandTilt[b] - bottom) / RANGE_DB));

    const k = (tau: number) => 1 - Math.exp(-dt / tau);
    const toneUp = k(0.02);
    const toneDown = k(0.12);
    const hitDown = k(0.05);
    const hazeUp = k(0.05);
    const hazeDown = k(0.25);
    const slow = k(0.1);
    for (let b = 0; b < FIELD_BANDS; b++) {
      const row = b * FIELD_PANS;
      for (let p = 0; p < FIELD_PANS; p++) {
        const c = row + p;
        out.tone[c] = ease(out.tone[c], norm(cTone[c], b), toneUp, toneDown);
        out.hit[c] = ease(out.hit[c], norm(cHit[c], b), 1, hitDown);
        out.haze[c] = ease(out.haze[c], norm(cHaze[c], b), hazeUp, hazeDown);
      }
      const total = bDirect[b] + bAmbient[b];
      out.level[b] = ease(out.level[b], norm(total, b), toneUp, toneDown);
      if (total > 1e-14) {
        if (bDirect[b] > 1e-14) out.pan[b] += (bPan[b] / bDirect[b] - out.pan[b]) * slow;
        out.diffuse[b] += (bAmbient[b] / total - out.diffuse[b]) * slow;
        out.hitShare[b] = ease(out.hitShare[b], bDirect[b] > 1e-14 ? bHit[b] / bDirect[b] : 0, 1, hitDown);
        // A band with sound in one channel only is not out of phase: call it 1.
        const lo = Math.min(bL[b], bR[b]);
        const hi = Math.max(bL[b], bR[b]);
        out.corr[b] = lo > hi * 1e-3 ? Math.max(-1, Math.min(1, bC[b] / Math.sqrt(bL[b] * bR[b]))) : 1;
      }
    }

    const g = k(0.4);
    this.mid += (mid - this.mid) * g;
    this.side += (side - this.side) * g;
    this.sumL += (sumL - this.sumL) * g;
    this.sumR += (sumR - this.sumR) * g;
    out.width = this.mid > 0 ? clamp01(Math.sqrt(this.side / this.mid)) : 0;
    out.balance = this.sumL + this.sumR > 0 ? (this.sumR - this.sumL) / (this.sumR + this.sumL) : 0;
    out.mono = this.mid > 0 && this.side < this.mid * 1e-3;
    out.active = frameMax > -110;
  }
}
