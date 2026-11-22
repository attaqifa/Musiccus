/**
 * Signal processing for stem separation: FFT, the exact STFT framing htdemucs
 * was trained with, a windowed-sinc resampler, a fast DSP separator, and the
 * level envelopes the visuals read.
 */
import { ENV_FLOOR_DB, ENV_RATE } from './types';

/* --------------------------------------------------------------- FFT -- */

export class FFT {
  readonly n: number;
  private rev: Uint32Array;
  private cos: Float64Array;
  private sin: Float64Array;

  constructor(n: number) {
    this.n = n;
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0, x = i; b < bits; b++, x >>= 1) r = (r << 1) | (x & 1);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / n);
      this.sin[k] = Math.sin((2 * Math.PI * k) / n);
    }
  }

  /** In-place complex FFT. The inverse is unnormalised (caller divides by n). */
  run(re: Float64Array, im: Float64Array, inverse = false): void {
    const n = this.n;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = this.cos[k];
          const wi = sgn * this.sin[k];
          const a = i + j;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

/** Periodic Hann, as torch.hann_window. */
export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  return w;
}

/** torch 'reflect' padding: index -k mirrors to k, n-1+k mirrors to n-1-k. */
function reflectPad(x: Float32Array | Float64Array, left: number, right: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n + left + right);
  for (let i = 0; i < out.length; i++) {
    let j = i - left;
    if (n === 1) j = 0;
    else {
      const period = 2 * (n - 1);
      j = ((j % period) + period) % period;
      if (j >= n) j = period - j;
    }
    out[i] = x[j];
  }
  return out;
}

/* --------------------------------------------------- htdemucs framing -- */

export const SEG = 343980;
export const NFFT = 4096;
export const HOP = 1024;
export const BINS = 2048;
export const FRAMES = 336;

export interface DemucsFrame {
  fft: FFT;
  win: Float64Array;
  re: Float64Array;
  im: Float64Array;
}

export const demucsFrame = (): DemucsFrame => ({ fft: new FFT(NFFT), win: hann(NFFT), re: new Float64Array(NFFT), im: new Float64Array(NFFT) });

/**
 * demucs `_spec` for one stereo segment of SEG samples, complex-as-channels:
 * [L.re, L.im, R.re, R.im] x 2048 bins x 336 frames, normalised STFT.
 */
export function demucsSpec(f: DemucsFrame, left: Float32Array, right: Float32Array): Float32Array {
  const le = Math.ceil(SEG / HOP);
  const pad = (HOP >> 1) * 3;
  const padded = (x: Float32Array) => reflectPad(reflectPad(x, pad, pad + le * HOP - SEG), NFFT / 2, NFFT / 2);
  const pl = padded(left);
  const pr = padded(right);
  const out = new Float32Array(4 * BINS * FRAMES);
  const scale = 1 / Math.sqrt(NFFT);
  const { re, im, win, fft } = f;
  const plane = BINS * FRAMES;
  for (let t = 0; t < FRAMES; t++) {
    const start = (t + 2) * HOP;
    for (let i = 0; i < NFFT; i++) {
      re[i] = pl[start + i] * win[i];
      im[i] = pr[start + i] * win[i];
    }
    fft.run(re, im);
    for (let k = 0; k < BINS; k++) {
      // Unpack two real spectra from one complex FFT.
      const nk = k === 0 ? 0 : NFFT - k;
      const ar = re[k];
      const ai = im[k];
      const br = re[nk];
      const bi = im[nk];
      const o = k * FRAMES + t;
      out[o] = 0.5 * (ar + br) * scale;
      out[plane + o] = 0.5 * (ai - bi) * scale;
      out[2 * plane + o] = 0.5 * (ai + bi) * scale;
      out[3 * plane + o] = -0.5 * (ar - br) * scale;
    }
  }
  return out;
}

/**
 * demucs `_ispec` for one source: complex-as-channels spectrum (4 x 2048 x
 * 336, starting at `base` in `x`) back to SEG stereo samples, added into
 * `outL`/`outR`.
 */
export function demucsIspec(f: DemucsFrame, x: Float32Array, base: number, outL: Float64Array, outR: Float64Array): void {
  const total = FRAMES + 4;
  const length = (total - 1) * HOP + NFFT;
  const accL = new Float64Array(length);
  const accR = new Float64Array(length);
  const wsum = new Float64Array(length);
  const { re, im, win, fft } = f;
  const plane = BINS * FRAMES;
  const scale = Math.sqrt(NFFT) / NFFT;
  for (let fr = 0; fr < total; fr++) {
    const start = fr * HOP;
    const t = fr - 2;
    if (t >= 0 && t < FRAMES) {
      re.fill(0);
      im.fill(0);
      for (let k = 0; k < BINS; k++) {
        const o = base + k * FRAMES + t;
        const lr = x[o];
        const li = k === 0 ? 0 : x[o + plane];
        const rr = x[o + 2 * plane];
        const ri = k === 0 ? 0 : x[o + 3 * plane];
        // Z = L + iR with Hermitian L and R.
        re[k] = lr - ri;
        im[k] = li + rr;
        if (k > 0) {
          re[NFFT - k] = lr + ri;
          im[NFFT - k] = -li + rr;
        }
      }
      fft.run(re, im, true);
      for (let i = 0; i < NFFT; i++) {
        accL[start + i] += re[i] * scale * win[i];
        accR[start + i] += im[i] * scale * win[i];
      }
    }
    for (let i = 0; i < NFFT; i++) wsum[start + i] += win[i] * win[i];
  }
  const off = NFFT / 2 + (HOP >> 1) * 3;
  for (let i = 0; i < SEG; i++) {
    const w = wsum[off + i] > 1e-11 ? wsum[off + i] : 1;
    outL[i] += accL[off + i] / w;
    outR[i] += accR[off + i] / w;
  }
}

/* --------------------------------------------------------- Resampler -- */

const ZEROS = 24;
const RES = 512;
let kernel: Float64Array | null = null;

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 40; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

function sincKernel(): Float64Array {
  if (kernel) return kernel;
  const beta = 8.6;
  const len = ZEROS * RES + 2;
  const k = new Float64Array(len);
  const norm = besselI0(beta);
  for (let i = 0; i < len; i++) {
    const u = i / RES;
    const s = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
    const r = u / ZEROS;
    k[i] = r >= 1 ? 0 : (s * besselI0(beta * Math.sqrt(1 - r * r))) / norm;
  }
  kernel = k;
  return k;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

interface Bank {
  up: number;
  down: number;
  half: number;
  width: number;
  taps: Float32Array;
}

const banks = new Map<string, Bank>();

/**
 * Polyphase filter bank for a rational rate change (44.1 -> 48 kHz is
 * 147:160): one precomputed set of taps per output phase, so the inner loop
 * is a plain dot product.
 */
function bankFor(from: number, to: number): Bank | null {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  const g = gcd(from, to);
  const up = to / g;
  const down = from / g;
  if (up > 4096) return null;
  const key = `${from}:${to}`;
  const hit = banks.get(key);
  if (hit) return hit;
  const h = sincKernel();
  const cut = Math.min(1, to / from) * 0.97;
  const half = Math.ceil(ZEROS / cut);
  const width = 2 * half;
  const taps = new Float32Array(up * width);
  const limit = ZEROS * RES;
  for (let p = 0; p < up; p++) {
    const frac = p / up;
    for (let j = 0; j < width; j++) {
      const k = j - half + 1;
      const d = Math.abs(k - frac) * cut * RES;
      if (d >= limit) continue;
      const i = d | 0;
      const t = d - i;
      taps[p * width + j] = (h[i] + (h[i + 1] - h[i]) * t) * cut;
    }
  }
  const bank = { up, down, half, width, taps };
  banks.set(key, bank);
  return bank;
}

function resamplePolyphase(x: Float32Array, b: Bank, outLen: number): Float32Array {
  const out = new Float32Array(outLen);
  const { up, down, half, width, taps } = b;
  const n = x.length;
  let i0 = 0;
  let p = 0;
  for (let o = 0; o < outLen; o++) {
    const base = p * width;
    const start = i0 - half + 1;
    let acc = 0;
    if (start >= 0 && start + width <= n) {
      for (let j = 0; j < width; j++) acc += x[start + j] * taps[base + j];
    } else {
      for (let j = 0; j < width; j++) {
        const idx = start + j;
        if (idx >= 0 && idx < n) acc += x[idx] * taps[base + j];
      }
    }
    out[o] = acc;
    p += down;
    const adv = (p / up) | 0;
    i0 += adv;
    p -= adv * up;
  }
  return out;
}

/** Windowed-sinc (Kaiser, 24 zero crossings) resampling to an exact output length. */
export function resample(x: Float32Array, from: number, to: number, outLen = Math.round((x.length * to) / from)): Float32Array {
  if (from === to) {
    const out = new Float32Array(outLen);
    out.set(x.subarray(0, Math.min(outLen, x.length)));
    return out;
  }
  const bank = bankFor(from, to);
  return bank ? resamplePolyphase(x, bank, outLen) : resampleGeneric(x, from, to, outLen);
}

/** Any rate ratio: the kernel is interpolated per tap. Kept as the reference and for odd rates. */
export function resampleGeneric(x: Float32Array, from: number, to: number, outLen = Math.round((x.length * to) / from)): Float32Array {
  const out = new Float32Array(outLen);
  const h = sincKernel();
  const ratio = to / from;
  const cut = Math.min(1, ratio) * 0.97;
  const half = Math.ceil(ZEROS / cut);
  const step = cut * RES;
  const n = x.length;
  const limit = ZEROS * RES;
  for (let o = 0; o < outLen; o++) {
    const pos = o / ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    let acc = 0;
    const k0 = Math.max(-half + 1, -i0);
    const k1 = Math.min(half, n - 1 - i0);
    for (let k = k0; k <= k1; k++) {
      const d = Math.abs(k - frac) * step;
      if (d >= limit) continue;
      const j = d | 0;
      const t = d - j;
      acc += x[i0 + k] * (h[j] + (h[j + 1] - h[j]) * t);
    }
    out[o] = acc * cut;
  }
  return out;
}

/* ----------------------------------------------------- DSP separator -- */

/** Sorted window with insert/remove by value, for running medians. */
class Window {
  private v: Float32Array;
  private n = 0;
  constructor(size: number) {
    this.v = new Float32Array(size);
  }
  private find(x: number): number {
    let lo = 0;
    let hi = this.n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.v[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  add(x: number) {
    const i = this.find(x);
    this.v.copyWithin(i + 1, i, this.n);
    this.v[i] = x;
    this.n++;
  }
  remove(x: number) {
    const i = this.find(x);
    this.v.copyWithin(i, i + 1, this.n);
    this.n--;
  }
  median(): number {
    return this.n ? this.v[this.n >> 1] : 0;
  }
  clear() {
    this.n = 0;
  }
}

const smooth = (x: number) => x * x * (3 - 2 * x);

/**
 * Fast stem estimate without a model: harmonic/percussive separation by
 * median filtering (drums are what is short in time and wide in frequency),
 * low harmonic content for bass, centre-panned harmonic content in the voice
 * band for vocals. Rough, but instant and local.
 */
export function separateDsp(
  left: Float32Array,
  right: Float32Array,
  rate: number,
  onProgress: (p: number) => void,
): Float32Array[] {
  const N = rate <= 50000 ? 4096 : rate <= 100000 ? 8192 : 16384;
  const hop = N / 2;
  const bins = N / 2 + 1;
  const len = left.length;
  const fft = new FFT(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 * (1 - Math.cos((2 * Math.PI * i) / N)));
  const TW = 9;
  const D = TW >> 1;
  const FW = 17;
  const frames = Math.ceil((len + N) / hop) + 1;

  const ringRe = Array.from({ length: TW }, () => new Float64Array(N));
  const ringIm = Array.from({ length: TW }, () => new Float64Array(N));
  const ringMag = Array.from({ length: TW }, () => new Float32Array(bins));
  const timeWin = Array.from({ length: bins }, () => new Window(TW));
  const freqWin = new Window(FW);

  const out = Array.from({ length: 6 }, () => new Float32Array(len));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const binHz = rate / N;
  const bassW = new Float64Array(bins);
  const voiceW = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    const f = k * binHz;
    bassW[k] = f <= 140 ? 1 : f >= 260 ? 0 : smooth(1 - (f - 140) / 120);
    const lo = f <= 110 ? 0 : f >= 200 ? 1 : smooth((f - 110) / 90);
    const hi = f <= 8000 ? 1 : f >= 12000 ? 0 : smooth(1 - (f - 8000) / 4000);
    voiceW[k] = lo * hi;
  }
  const H = new Float32Array(bins);
  const P = new Float32Array(bins);
  const masks = [new Float32Array(bins), new Float32Array(bins), new Float32Array(bins)];

  const offset = -N / 2;
  for (let f = 0; f < frames + D; f++) {
    // Analyse frame f into the ring.
    const slot = f % TW;
    const old = ringMag[slot];
    if (f >= TW) for (let k = 0; k < bins; k++) timeWin[k].remove(old[k]);
    const fRe = ringRe[slot];
    const fIm = ringIm[slot];
    const start = offset + f * hop;
    for (let i = 0; i < N; i++) {
      const j = start + i;
      const inside = j >= 0 && j < len && f < frames;
      fRe[i] = inside ? left[j] * win[i] : 0;
      fIm[i] = inside ? right[j] * win[i] : 0;
    }
    fft.run(fRe, fIm);
    for (let k = 0; k < bins; k++) {
      const nk = k === 0 ? 0 : N - k;
      const lr = 0.5 * (fRe[k] + fRe[nk]);
      const li = 0.5 * (fIm[k] - fIm[nk]);
      const rr = 0.5 * (fIm[k] + fIm[nk]);
      const ri = -0.5 * (fRe[k] - fRe[nk]);
      const m = 0.5 * (Math.hypot(lr, li) + Math.hypot(rr, ri));
      old[k] = m;
      timeWin[k].add(m);
    }

    // Emit the frame D behind, now that its time neighbourhood is known.
    const e = f - D;
    if (e < 0) continue;
    const es = e % TW;
    const eRe = ringRe[es];
    const eIm = ringIm[es];
    const mag = ringMag[es];
    freqWin.clear();
    for (let k = 0; k < Math.min(bins, FW >> 1); k++) freqWin.add(mag[k]);
    for (let k = 0; k < bins; k++) {
      const inK = k + (FW >> 1);
      if (inK < bins) freqWin.add(mag[inK]);
      const outK = k - (FW >> 1) - 1;
      if (outK >= 0) freqWin.remove(mag[outK]);
      H[k] = timeWin[k].median();
      P[k] = freqWin.median();
    }
    for (let k = 0; k < bins; k++) {
      const h2 = H[k] * H[k];
      const p2 = P[k] * P[k];
      const mh = h2 / (h2 + p2 + 1e-20);
      const nk = k === 0 ? 0 : N - k;
      const lr = 0.5 * (eRe[k] + eRe[nk]);
      const li = 0.5 * (eIm[k] - eIm[nk]);
      const rr = 0.5 * (eIm[k] + eIm[nk]);
      const ri = -0.5 * (eRe[k] - eRe[nk]);
      const power = lr * lr + li * li + rr * rr + ri * ri;
      const centre = power > 1e-20 ? Math.max(0, (2 * (lr * rr + li * ri)) / power) : 0;
      const voice = mh * centre ** 6 * voiceW[k] * (1 - bassW[k]);
      masks[0][k] = voice;
      masks[1][k] = 1 - mh;
      masks[2][k] = mh * bassW[k];
    }
    // Resynthesise each masked stem and overlap-add.
    const at = offset + e * hop;
    for (let s = 0; s < 3; s++) {
      const mk = masks[s];
      for (let k = 0; k < bins; k++) {
        const nk = k === 0 ? 0 : N - k;
        const g = mk[k];
        re[k] = eRe[k] * g;
        im[k] = eIm[k] * g;
        if (k > 0 && k < N / 2) {
          re[nk] = eRe[nk] * g;
          im[nk] = eIm[nk] * g;
        }
      }
      fft.run(re, im, true);
      const oL = out[s * 2];
      const oR = out[s * 2 + 1];
      for (let i = 0; i < N; i++) {
        const j = at + i;
        if (j < 0 || j >= len) continue;
        oL[j] += (re[i] / N) * win[i];
        oR[j] += (im[i] / N) * win[i];
      }
    }
    if ((e & 63) === 0) onProgress(Math.min(1, e / frames));
  }
  return out;
}

/* --------------------------------------------------------- Envelopes -- */

/** RMS level envelopes for vocals, drums, bass and the derived "other". */
export function stemLevels(stems: Float32Array[], left: Float32Array, right: Float32Array, rate: number): Uint8Array[] {
  const hop = Math.max(1, Math.round(rate / ENV_RATE));
  const frames = Math.ceil(left.length / hop);
  const out = Array.from({ length: 4 }, () => new Uint8Array(frames));
  const sums = new Float64Array(4);
  const toByte = (ms: number) => {
    const db = 10 * Math.log10(ms + 1e-12);
    return Math.max(0, Math.min(255, Math.round(((db - ENV_FLOOR_DB) / -ENV_FLOOR_DB) * 255)));
  };
  for (let f = 0; f < frames; f++) {
    sums.fill(0);
    const a = f * hop;
    const b = Math.min(left.length, a + hop);
    for (let i = a; i < b; i++) {
      let restL = left[i];
      let restR = right[i];
      for (let s = 0; s < 3; s++) {
        const l = stems[s * 2][i];
        const r = stems[s * 2 + 1][i];
        sums[s] += l * l + r * r;
        restL -= l;
        restR -= r;
      }
      sums[3] += restL * restL + restR * restR;
    }
    const n = Math.max(1, (b - a) * 2);
    for (let s = 0; s < 4; s++) out[s][f] = toByte(sums[s] / n);
  }
  return out;
}

export function toInt16(x: Float32Array): Int16Array {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = Math.round(x[i] * 32767);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

export function fromInt16(x: Int16Array): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] / 32767;
  return out;
}
