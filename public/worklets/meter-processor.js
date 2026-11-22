/*
 * Musiccus meter processor (AudioWorklet).
 *
 * Runs on every sample, so the numbers are measurements rather than
 * estimates from a smoothed FFT:
 *   - ITU-R BS.1770-4 / EBU R128 loudness: momentary (400 ms), short-term (3 s),
 *     and gated integrated loudness, with K-weighting derived for any sample rate.
 *   - True peak via 4x polyphase oversampling (BS.1770-4 Annex 2 filter).
 *   - Per-interval mean square, sample peak, and L/R correlation for VU and
 *     phase meters.
 *   - Onsets (kick / snare / hat bands) stamped with sample-accurate context
 *     time, so visuals can land on the hit instead of on the next FFT frame.
 */

const TP_PHASES = [
  [0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875, 0.1373291015625,
    0.97216796875, -0.102294921875, 0.0476074218750, -0.0266113281250, 0.0148925781250, -0.0083007812500],
  [-0.0291748046875, 0.029296875, -0.0517578125, 0.0891113281250, -0.166503906250, 0.465087890625,
    0.77978515625, -0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375],
  [-0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625, -0.2003173828125, 0.77978515625,
    0.465087890625, -0.166503906250, 0.0891113281250, -0.0517578125, 0.029296875, -0.0291748046875],
  [-0.0083007812500, 0.0148925781250, -0.0266113281250, 0.0476074218750, -0.102294921875, 0.97216796875,
    0.1373291015625, -0.0594482421875, 0.033203125, -0.0196533203125, 0.010986328125, 0.001708984375],
];

// Coefficients from the analog prototypes used by libebur128, so the filter
// is correct at 44.1, 88.2, 96, 192 kHz and not only at 48 kHz.
function kWeighting(rate) {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / rate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const s1 = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / rate);
  a0 = 1 + K / Q + K * K;
  const s2 = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return { s1, s2 };
}

const HIST_MIN = -70; // absolute gate, LUFS
const HIST_MAX = 5;
const HIST_STEP = 0.1;
const HIST_BINS = Math.round((HIST_MAX - HIST_MIN) / HIST_STEP);
const ZEROS = new Float32Array(128);

function biquad(type, f0, Q, rate) {
  const w0 = (2 * Math.PI * f0) / rate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  let b0;
  let b1;
  let b2;
  if (type === 'lp') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  } else if (type === 'hp') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  }
  const a0 = 1 + alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}

/**
 * Energy-rise onset detector for one band. Each 4 ms hop compares the band
 * level with the quietest of the previous three hops; a rise well above the
 * running average rise counts as a hit.
 *
 * The threshold adapts to the material: it follows the mean and spread of
 * recent rises, with only a small fixed margin. A loud, limited master has
 * hits that rise just 3–6 dB above the mix, and a fixed margin of 5–6 dB
 * missed most of them.
 *
 * A hit is found on its first rising hop, but scored `settle` hops later,
 * at its loudest: scoring the first 4 ms made identical kicks read up to
 * 12 dB apart, depending on where the hop fell in the attack. Strength then
 * compares the hit with this band's typical hit, so equal kicks score alike
 * (about 1) and a ghost note scores lower. With `sustain`, the band must
 * still be up when the hit is scored: a snare rings for 100 ms or more, the
 * attack click of a kick or a bass note far less.
 */
class OnsetBand {
  constructor(filters, gap, delta, settle, sustain = false) {
    this.filters = filters;
    this.gap = gap;
    this.delta = delta;
    this.settle = settle;
    this.sustain = sustain;
    this.pending = null;
    this.hitRise = 12;
    /** Context time of the hit the last non-zero hop() returned. */
    this.hitT = 0;
    this.sum = 0;
    this.hist = [-120, -120, -120];
    this.hi = 0;
    this.mean = 0;
    this.dev = 2;
    this.peak = -60;
    this.last = -1;
  }
  push(x) {
    let y = x;
    for (let i = 0; i < this.filters.length; i++) {
      const f = this.filters[i];
      const o = f.b0 * y + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
      f.x2 = f.x1;
      f.x1 = y;
      f.y2 = f.y1;
      f.y1 = o;
      y = o;
    }
    this.sum += y * y;
  }
  hop(n, t, hopSec) {
    const db = 10 * Math.log10(this.sum / n + 1e-12);
    this.sum = 0;
    const h = this.hist;
    const floor = Math.min(h[0], h[1], h[2]);
    h[this.hi] = db;
    this.hi = (this.hi + 1) % 3;
    const rise = Math.max(0, db - floor);
    this.peak = Math.max(db, this.peak - 6 * hopSec);
    const thr = this.mean + 2 * this.dev + this.delta;
    const a = hopSec / 0.6;
    this.mean += a * (rise - this.mean);
    this.dev += a * (Math.abs(rise - this.mean) - this.dev);
    const p = this.pending;
    if (p) {
      if (db > p.max) p.max = db;
      if (--p.left > 0) return 0;
      this.pending = null;
      if (this.sustain && db < p.floor + 0.5 * (p.max - p.floor)) return 0;
      // A typical hit for this song scores about 1, a just-audible one about
      // 0.55, so equal kicks fire equal shockwaves on any master. The loudest
      // hits (usually the kick, not the bass line) score highest.
      const hitRise = p.max - p.floor;
      const typical = Math.max(this.hitRise - p.thr, 1.5);
      this.hitRise += 0.25 * (hitRise - this.hitRise);
      const loud = Math.max(0.35, Math.min(1, (p.max - (this.peak - 24)) / 24));
      this.hitT = p.t;
      return Math.min(1, 0.55 + (0.45 * (hitRise - p.thr)) / typical) * loud;
    }
    if (rise > thr && db > this.peak - 30 && t - this.last > this.gap) {
      this.last = t;
      this.pending = { t, floor, max: db, thr, left: this.settle };
    }
    return 0;
  }
}

const toLufs = (energy) => (energy > 0 ? -0.691 + 10 * Math.log10(energy) : -Infinity);

class MeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const k = kWeighting(sampleRate);
    this.k = k;
    // Per channel biquad state: [s1 x1, x2, y1, y2, s2 x1, x2, y1, y2]
    this.kst = [new Float64Array(8), new Float64Array(8)];
    this.subLen = Math.round(sampleRate * 0.1);
    this.postLen = Math.max(512, Math.round(sampleRate / 30));
    this.tpHist = [new Float64Array(24), new Float64Array(24)];
    this.hopLen = Math.max(64, Math.round(sampleRate * 0.004));
    this.hopPos = 0;
    this.bands = [
      new OnsetBand([biquad('lp', 150, 0.707, sampleRate), biquad('lp', 150, 0.707, sampleRate)], 0.16, 2.5, 3),
      new OnsetBand([biquad('bp', 2000, 0.5, sampleRate)], 0.1, 2.5, 3, true),
      new OnsetBand([biquad('hp', 8000, 0.707, sampleRate), biquad('hp', 8000, 0.707, sampleRate)], 0.06, 2, 1),
    ];
    this.reset();
    this.resetAt = -1;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.type === 'reset') {
        if (typeof d.at === 'number' && d.at > currentTime) this.resetAt = d.at;
        else this.reset();
      }
    };
  }

  reset() {
    this.kst[0].fill(0);
    this.kst[1].fill(0);
    this.tpHist[0].fill(0);
    this.tpHist[1].fill(0);
    this.tpIdx = 0;
    this.subPos = 0;
    this.subSum = 0;
    this.subRing = new Float64Array(30);
    this.subCount = 0;
    this.histCount = new Uint32Array(HIST_BINS);
    this.histEnergy = new Float64Array(HIST_BINS);
    this.momentary = -Infinity;
    this.shortTerm = -Infinity;
    this.integrated = -Infinity;
    this.mMax = -Infinity;
    this.sMax = -Infinity;
    this.tpMax = 0;
    this.resetInterval();
  }

  resetInterval() {
    this.postPos = 0;
    this.msL = 0;
    this.msR = 0;
    this.lr = 0;
    this.pkL = 0;
    this.pkR = 0;
    this.tpL = 0;
    this.tpR = 0;
  }

  completeSubBlock() {
    const e = this.subSum / this.subLen;
    this.subRing[this.subCount % 30] = e;
    this.subCount++;
    this.subSum = 0;
    this.subPos = 0;

    const n4 = Math.min(4, this.subCount);
    let m = 0;
    for (let i = 0; i < n4; i++) m += this.subRing[(this.subCount - 1 - i) % 30];
    const mE = m / n4;
    const n30 = Math.min(30, this.subCount);
    let s = 0;
    for (let i = 0; i < n30; i++) s += this.subRing[(this.subCount - 1 - i) % 30];
    const sE = s / n30;

    this.momentary = toLufs(mE);
    this.shortTerm = toLufs(sE);
    if (this.momentary > this.mMax) this.mMax = this.momentary;
    if (this.subCount >= 30 && this.shortTerm > this.sMax) this.sMax = this.shortTerm;

    // Gating blocks are 400 ms with 75 % overlap, i.e. one per 100 ms sub-block.
    if (this.subCount >= 4 && this.momentary > HIST_MIN) {
      const bin = Math.min(HIST_BINS - 1, Math.floor((this.momentary - HIST_MIN) / HIST_STEP));
      this.histCount[bin]++;
      this.histEnergy[bin] += mE;
      this.updateIntegrated();
    }
  }

  updateIntegrated() {
    let cnt = 0;
    let sum = 0;
    for (let i = 0; i < HIST_BINS; i++) {
      cnt += this.histCount[i];
      sum += this.histEnergy[i];
    }
    if (cnt === 0) return;
    const rel = toLufs(sum / cnt) - 10;
    const start = Math.max(0, Math.floor((rel - HIST_MIN) / HIST_STEP));
    cnt = 0;
    sum = 0;
    for (let i = start; i < HIST_BINS; i++) {
      cnt += this.histCount[i];
      sum += this.histEnergy[i];
    }
    this.integrated = cnt > 0 ? toLufs(sum / cnt) : -Infinity;
  }

  process(inputs) {
    if (this.resetAt >= 0 && currentTime >= this.resetAt) {
      this.resetAt = -1;
      this.reset();
    }
    const input = inputs[0];
    const L = input && input.length > 0 ? input[0] : ZEROS;
    const R = input && input.length > 1 ? input[1] : L;
    const n = L.length;
    const { s1, s2 } = this.k;
    const kl = this.kst[0];
    const kr = this.kst[1];
    const hl = this.tpHist[0];
    const hr = this.tpHist[1];

    for (let i = 0; i < n; i++) {
      const l = L[i];
      const r = R[i];

      // K-weighting, left
      let y = s1.b0 * l + s1.b1 * kl[0] + s1.b2 * kl[1] - s1.a1 * kl[2] - s1.a2 * kl[3];
      kl[1] = kl[0]; kl[0] = l; kl[3] = kl[2]; kl[2] = y;
      let z = s2.b0 * y + s2.b1 * kl[4] + s2.b2 * kl[5] - s2.a1 * kl[6] - s2.a2 * kl[7];
      kl[5] = kl[4]; kl[4] = y; kl[7] = kl[6]; kl[6] = z;
      const zl = z;
      // K-weighting, right
      y = s1.b0 * r + s1.b1 * kr[0] + s1.b2 * kr[1] - s1.a1 * kr[2] - s1.a2 * kr[3];
      kr[1] = kr[0]; kr[0] = r; kr[3] = kr[2]; kr[2] = y;
      z = s2.b0 * y + s2.b1 * kr[4] + s2.b2 * kr[5] - s2.a1 * kr[6] - s2.a2 * kr[7];
      kr[5] = kr[4]; kr[4] = y; kr[7] = kr[6]; kr[6] = z;
      const zr = z;

      this.subSum += zl * zl + zr * zr;
      if (++this.subPos >= this.subLen) this.completeSubBlock();

      // True peak: write each sample twice so 12 taps read contiguously.
      const idx = this.tpIdx;
      hl[idx] = l; hl[idx + 12] = l;
      hr[idx] = r; hr[idx + 12] = r;
      let tpl = 0;
      let tpr = 0;
      for (let p = 0; p < 4; p++) {
        const h = TP_PHASES[p];
        let al = 0;
        let ar = 0;
        for (let k = 0; k < 12; k++) {
          al += h[k] * hl[idx + 12 - k];
          ar += h[k] * hr[idx + 12 - k];
        }
        al = al < 0 ? -al : al;
        ar = ar < 0 ? -ar : ar;
        if (al > tpl) tpl = al;
        if (ar > tpr) tpr = ar;
      }
      this.tpIdx = (idx + 1) % 12;
      if (tpl > this.tpL) this.tpL = tpl;
      if (tpr > this.tpR) this.tpR = tpr;

      const mono = 0.5 * (l + r);
      this.bands[0].push(mono);
      this.bands[1].push(mono);
      this.bands[2].push(mono);
      if (++this.hopPos >= this.hopLen) {
        const hopSec = this.hopLen / sampleRate;
        const tHop = currentTime + (i + 1) / sampleRate - hopSec * 0.5;
        for (let b = 0; b < 3; b++) {
          const band = this.bands[b];
          const strength = band.hop(this.hopLen, tHop, hopSec);
          if (strength > 0) this.port.postMessage({ type: 'onset', band: b, t: band.hitT, s: strength });
        }
        this.hopPos = 0;
      }

      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > this.pkL) this.pkL = al;
      if (ar > this.pkR) this.pkR = ar;
      this.msL += l * l;
      this.msR += r * r;
      this.lr += l * r;
      if (++this.postPos >= this.postLen) {
        const m = this.tpL > this.tpR ? this.tpL : this.tpR;
        if (m > this.tpMax) this.tpMax = m;
        const pl = this.msL;
        const pr = this.msR;
        const n2 = this.postPos;
        const denom = Math.sqrt(pl * pr);
        const corr = denom > 1e-12 ? this.lr / denom : 0;
        this.port.postMessage({
          type: 'meter',
          t: currentTime + i / sampleRate,
          msL: pl / n2,
          msR: pr / n2,
          pkL: this.pkL,
          pkR: this.pkR,
          tpL: this.tpL,
          tpR: this.tpR,
          corr,
          m: this.momentary,
          s: this.shortTerm,
          i: this.integrated,
          mMax: this.mMax,
          sMax: this.sMax,
          tpMax: this.tpMax,
        });
        this.resetInterval();
      }
    }
    return true;
  }
}

registerProcessor('musiccus-meter', MeterProcessor);

/*
 * Capture processor: hands the dry sound of a captured tab to the main thread
 * in blocks of 4096 frames for the live analysis. Each block carries the
 * context time of its first sample, so beats found in it can be placed on
 * the live clock exactly.
 */
const CAPTURE_BLOCK = 4096;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.l = new Float32Array(CAPTURE_BLOCK);
    this.r = new Float32Array(CAPTURE_BLOCK);
    this.n = 0;
    this.t0 = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const L = input[0] || ZEROS;
    const R = input[1] || L;
    if (this.n === 0) this.t0 = currentTime;
    this.l.set(L, this.n);
    this.r.set(R, this.n);
    this.n += L.length;
    if (this.n >= CAPTURE_BLOCK) {
      this.port.postMessage({ t: this.t0, l: this.l, r: this.r }, [this.l.buffer, this.r.buffer]);
      this.l = new Float32Array(CAPTURE_BLOCK);
      this.r = new Float32Array(CAPTURE_BLOCK);
      this.n = 0;
    }
    return true;
  }
}

registerProcessor('musiccus-capture', CaptureProcessor);
