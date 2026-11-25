/*
 * Offline music analysis, run in a Web Worker so playback never stutters.
 *
 *   mastering     full-rate stereo: BS.1770 loudness and LRA, true peak,
 *                 DR score, clipping, DC, stereo width, effective bit depth
 *   authenticity  long-term spectrum; finds brick-wall low-passes that give
 *                 away MP3 transcodes and upsampled "hi-res"
 *   rhythm        spectral-flux onsets, comb-filtered autocorrelation for
 *                 tempo, dynamic-programming beat tracking (Ellis 2007)
 *   harmony       tuning, NNLS note chroma, key and chords (harmony.ts)
 *   structure     bar-level self-similarity, checkerboard novelty, segment
 *                 clustering and naming
 */
import { FFT, hann } from './fft';
import { analyseHarmony } from './harmony';
import {
  ANALYSIS_VERSION,
  type Analysis,
  type AnalysisJob,
  type Authenticity,
  type Mastering,
  type Section,
  type SectionName,
  type Verdict,
  type WorkerMessage,
} from './types';

interface WorkerScope {
  postMessage(msg: WorkerMessage, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<AnalysisJob>) => void) | null;
}
const scope = self as unknown as WorkerScope;

let jobId = 0;
let lastReport = 0;
function report(stage: string, p: number) {
  const now = performance.now();
  if (now - lastReport < 120 && p < 1) return;
  lastReport = now;
  scope.postMessage({ type: 'progress', id: jobId, stage, p: Math.min(1, Math.max(0, p)) });
}

scope.onmessage = (e) => {
  const job = e.data;
  jobId = job.id;
  try {
    const result = analyze(job);
    const a = result.authenticity;
    scope.postMessage({ type: 'done', id: job.id, result }, [
      result.beats.buffer,
      result.downbeats.buffer,
      result.energy.buffer,
      result.chroma.buffer,
      a.ltasFreqs.buffer,
      a.ltasDb.buffer,
    ]);
  } catch (err) {
    scope.postMessage({ type: 'error', id: job.id, message: err instanceof Error ? err.message : String(err) });
  }
};

/* ------------------------------------------------------------------ DSP -- */

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function lowpass(f0: number, rate: number, q = Math.SQRT1_2): Biquad {
  const w0 = (2 * Math.PI * f0) / rate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return { b0: (1 - cos) / 2 / a0, b1: (1 - cos) / a0, b2: (1 - cos) / 2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

function kWeighting(rate: number): [Biquad, Biquad] {
  let K = Math.tan((Math.PI * 1681.974450955533) / rate);
  let Q = 0.7071752369554196;
  const Vh = Math.pow(10, 3.999843853973347 / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const s1 = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  K = Math.tan((Math.PI * 38.13547087602444) / rate);
  Q = 0.5003270373238773;
  a0 = 1 + K / Q + K * K;
  const s2 = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [s1, s2];
}

const TP = [
  [0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875, 0.1373291015625,
    0.97216796875, -0.102294921875, 0.047607421875, -0.026611328125, 0.014892578125, -0.00830078125],
  [-0.0291748046875, 0.029296875, -0.0517578125, 0.089111328125, -0.16650390625, 0.465087890625,
    0.77978515625, -0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375],
  [-0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625, -0.2003173828125, 0.77978515625,
    0.465087890625, -0.16650390625, 0.089111328125, -0.0517578125, 0.029296875, -0.0291748046875],
  [-0.00830078125, 0.014892578125, -0.026611328125, 0.047607421875, -0.102294921875, 0.97216796875,
    0.1373291015625, -0.0594482421875, 0.033203125, -0.0196533203125, 0.010986328125, 0.001708984375],
];

const toLufs = (e: number) => (e > 0 ? -0.691 + 10 * Math.log10(e) : -Infinity);
const db20 = (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
const mean = (a: ArrayLike<number>, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i];
  return to > from ? s / (to - from) : 0;
};
const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};
const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];

/* ------------------------------------------------------------- Analysis -- */

function analyze(job: AnalysisJob): Analysis {
  const t0 = performance.now();
  const L = job.channels[0];
  const R = job.channels[1] ?? job.channels[0];
  const sr = job.sampleRate;
  const duration = L.length / sr;

  report('Mastering', 0);
  const mastering = measureMastering(L, R, sr, job.meta);
  report('Keaslian', 0.25);
  const authenticity = checkAuthenticity(L, R, sr, job.meta, mastering.effectiveBits);

  report('Spektrum', 0.33);
  const { x, rate } = downmix(L, R, sr);
  const f = extractFeatures(x, rate);

  report('Tempo dan beat', 0.72);
  const pulse = rhythmEnvelope(f);
  const tempo = estimateTempo(pulse, f.frameRate);
  const beatFrames = extendGrid(trackBeats(pulse, tempo.period, f.frameRate), f);
  const beats = new Float32Array(alignToAttacks(beatFrames.map((b) => f.frameTime(b)), x, rate));
  const bpm = beats.length > 8 ? 60 / regressionPeriod(beats) : tempo.bpm;

  report('Harmoni', 0.82);
  const beatChroma = beatSyncChroma(f, beats, duration);
  const downbeatPhase = findDownbeatPhase(f, beatFrames, beatChroma);
  const downbeats: number[] = [];
  for (let i = downbeatPhase; i < beats.length; i += 4) downbeats.push(i);
  const barPos = new Int8Array(beats.length);
  for (let i = 0; i < beats.length; i++) barPos[i] = (((i - downbeatPhase) % 4) + 4) % 4;
  const { key, chords, tuningCents } = analyseHarmony(x, rate, beats, barPos, duration);

  report('Struktur', 0.92);
  const sections = segmentStructure(f, beats, downbeats, beatChroma, duration);

  const energy = energyCurve(f.rmsDb, f.frameRate);
  const chroma = chromaRiver(f);

  report('Selesai', 1);
  return {
    version: ANALYSIS_VERSION,
    duration,
    bpm: Math.round(bpm * 10) / 10,
    tempoConfidence: tempo.confidence,
    tempoAlt: tempo.alt,
    beats,
    downbeats: new Int32Array(downbeats),
    key,
    chords,
    tuningCents,
    sections,
    energy,
    energyRate: 10,
    chroma,
    chromaRate: f.frameRate / 2,
    mastering,
    authenticity,
    elapsedMs: Math.round(performance.now() - t0),
  };
}

/* ------------------------------------------------------------ Mastering -- */

function truePeak(x: Float32Array, thr: number): number {
  let tp = 0;
  const n = x.length;
  for (let i = 0; i < n; i++) {
    const a = x[i] < 0 ? -x[i] : x[i];
    if (a > tp) tp = a;
    if (a < thr) continue;
    // The filter's centre tap sits ~5.5 samples back, so steps i+5 and i+6
    // interpolate the intervals on either side of sample i.
    for (let j = i + 5; j <= i + 6 && j < n; j++) {
      for (let p = 0; p < 4; p++) {
        const h = TP[p];
        let acc = 0;
        for (let k = 0; k < 12; k++) {
          const idx = j - k;
          if (idx >= 0) acc += h[k] * x[idx];
        }
        if (acc < 0) acc = -acc;
        if (acc > tp) tp = acc;
      }
    }
  }
  return tp;
}

function drScore(blocksRms: number[], blocksPeak: number[]): number {
  if (blocksRms.length === 0) return 0;
  const rms = [...blocksRms].sort((a, b) => b - a);
  const top = Math.max(1, Math.round(rms.length * 0.2));
  let s = 0;
  for (let i = 0; i < top; i++) s += rms[i] * rms[i];
  const rmsTop = Math.sqrt(s / top);
  const peaks = [...blocksPeak].sort((a, b) => b - a);
  const p2 = peaks.length > 1 ? peaks[1] : peaks[0];
  return rmsTop > 0 && p2 > 0 ? 20 * Math.log10(p2 / rmsTop) : 0;
}

function measureMastering(L: Float32Array, R: Float32Array, sr: number, meta: AnalysisJob['meta']): Mastering {
  const n = L.length;
  const [k1, k2] = kWeighting(sr);
  const st = new Float64Array(16);
  const sub = Math.round(sr * 0.1);
  const subE: number[] = [];
  let subSum = 0;
  let subPos = 0;

  let peakL = 0;
  let peakR = 0;
  let sumL = 0;
  let sumR = 0;
  let sLL = 0;
  let sRR = 0;
  let sLR = 0;
  let sMM = 0;
  let sSS = 0;
  let clippedSamples = 0;
  let clipEvents = 0;
  let runL = 0;
  let runR = 0;

  const blk = Math.round(sr * 3);
  const rmsL: number[] = [];
  const rmsR: number[] = [];
  const pkL: number[] = [];
  const pkR: number[] = [];
  let bL = 0;
  let bR = 0;
  let bpL = 0;
  let bpR = 0;
  let bPos = 0;

  const kw = (x: number, o: number) => {
    let y = k1.b0 * x + k1.b1 * st[o] + k1.b2 * st[o + 1] - k1.a1 * st[o + 2] - k1.a2 * st[o + 3];
    st[o + 1] = st[o];
    st[o] = x;
    st[o + 3] = st[o + 2];
    st[o + 2] = y;
    const z = k2.b0 * y + k2.b1 * st[o + 4] + k2.b2 * st[o + 5] - k2.a1 * st[o + 6] - k2.a2 * st[o + 7];
    st[o + 5] = st[o + 4];
    st[o + 4] = y;
    st[o + 7] = st[o + 6];
    st[o + 6] = z;
    y = z;
    return y;
  };

  for (let i = 0; i < n; i++) {
    const l = L[i];
    const r = R[i];
    const zl = kw(l, 0);
    const zr = kw(r, 8);
    subSum += zl * zl + zr * zr;
    if (++subPos === sub) {
      subE.push(subSum / sub);
      subSum = 0;
      subPos = 0;
    }
    const al = l < 0 ? -l : l;
    const ar = r < 0 ? -r : r;
    if (al > peakL) peakL = al;
    if (ar > peakR) peakR = ar;
    sumL += l;
    sumR += r;
    sLL += l * l;
    sRR += r * r;
    sLR += l * r;
    const m = (l + r) * 0.5;
    const s = (l - r) * 0.5;
    sMM += m * m;
    sSS += s * s;

    if (al >= 0.9999) {
      runL++;
      clippedSamples++;
    } else {
      if (runL >= 3) clipEvents++;
      runL = 0;
    }
    if (ar >= 0.9999) {
      runR++;
      clippedSamples++;
    } else {
      if (runR >= 3) clipEvents++;
      runR = 0;
    }

    bL += l * l;
    bR += r * r;
    if (al > bpL) bpL = al;
    if (ar > bpR) bpR = ar;
    if (++bPos === blk) {
      rmsL.push(Math.sqrt((2 * bL) / blk));
      rmsR.push(Math.sqrt((2 * bR) / blk));
      pkL.push(bpL);
      pkR.push(bpR);
      bL = bR = bpL = bpR = 0;
      bPos = 0;
    }
    if ((i & 0x3ffff) === 0) report('Mastering', (i / n) * 0.18);
  }
  if (bPos > sr) {
    rmsL.push(Math.sqrt((2 * bL) / bPos));
    rmsR.push(Math.sqrt((2 * bR) / bPos));
    pkL.push(bpL);
    pkR.push(bpR);
  }

  // Integrated loudness: 400 ms blocks, 75 % overlap, absolute and relative gates.
  const blocks: number[] = [];
  for (let i = 3; i < subE.length; i++) blocks.push((subE[i] + subE[i - 1] + subE[i - 2] + subE[i - 3]) / 4);
  const absGated = blocks.filter((e) => toLufs(e) > -70);
  const rel = toLufs(mean(absGated)) - 10;
  const gated = absGated.filter((e) => toLufs(e) > rel);
  const lufsI = gated.length ? toLufs(mean(gated)) : -Infinity;

  // Loudness range (EBU Tech 3342): 3 s windows, −20 LU relative gate, P95 − P10.
  const shortTerm: number[] = [];
  for (let i = 29; i < subE.length; i++) {
    let s = 0;
    for (let k = 0; k < 30; k++) s += subE[i - k];
    shortTerm.push(s / 30);
  }
  const stAbs = shortTerm.filter((e) => toLufs(e) > -70);
  const stRel = toLufs(mean(stAbs)) - 20;
  const stVals = stAbs.filter((e) => toLufs(e) > stRel).map(toLufs).sort((a, b) => a - b);
  const lra = stVals.length > 2 ? percentile(stVals, 0.95) - percentile(stVals, 0.1) : 0;

  report('True peak', 0.2);
  const samplePeak = Math.max(peakL, peakR);
  const thr = samplePeak * 0.7;
  const tp = Math.max(truePeak(L, thr), L === R ? 0 : truePeak(R, thr));

  const rmsAll = Math.sqrt((sLL + sRR) / (2 * Math.max(1, n)));
  const dr = Math.round((drScore(rmsL, pkL) + drScore(rmsR, pkR)) / 2);
  const dc = Math.abs((sumL + sumR) / (2 * Math.max(1, n)));

  let effectiveBits = 0;
  // Chrome turns 16-bit PCM into floats unevenly: negative samples over 32768,
  // positive ones over 32767 (24-bit is even). Either way counts as on the grid.
  const on16 = (v: number) => {
    if (Number.isInteger(v * 32768)) return true;
    const x = v * 32767;
    return v > 0 && Math.abs(x - Math.round(x)) < 4e-3;
  };
  if (meta.lossless !== false && !meta.resampled) {
    const stride = Math.max(1, Math.floor(n / 1_500_000));
    let nz = 0;
    let c16 = 0;
    let c24 = 0;
    for (let i = 0; i < n; i += stride) {
      for (const v of [L[i], R[i]]) {
        if (v === 0) continue;
        nz++;
        if (on16(v)) c16++;
        if (Number.isInteger(v * 8388608)) c24++;
      }
    }
    if (nz > 1000) effectiveBits = c16 / nz > 0.999 ? 16 : c24 / nz > 0.999 ? 24 : 32;
  }

  return {
    lufsI,
    lra,
    truePeakDb: db20(tp),
    samplePeakDb: db20(samplePeak),
    plr: db20(tp) - lufsI,
    dr,
    crestDb: rmsAll > 0 ? db20(samplePeak / rmsAll) : 0,
    clipEvents,
    clippedSamples,
    dcOffsetDb: db20(dc),
    correlation: sLL > 0 && sRR > 0 ? sLR / Math.sqrt(sLL * sRR) : 1,
    width: sMM > 0 ? (sSS / sMM) * 100 : 0,
    effectiveBits,
  };
}

/* --------------------------------------------------------- Authenticity -- */

/** Lossless files cut above this but below 20,5 kHz are not called transcodes (see checkAuthenticity). */
const GREY_FROM = 19500;

const khz = (f: number) => `${(f / 1000).toFixed(1).replace('.', ',')} kHz`;

function bitrateGuess(cutoff: number): string {
  if (cutoff < 15500) return '128 kbps atau lebih rendah';
  if (cutoff < 16500) return '128 kbps';
  if (cutoff < 17500) return '160 kbps';
  if (cutoff < 19000) return '192 kbps';
  return '256–320 kbps';
}

function checkAuthenticity(
  L: Float32Array,
  R: Float32Array,
  sr: number,
  meta: AnalysisJob['meta'],
  effectiveBits: number,
): Authenticity {
  const N = 8192;
  const fft = new FFT(N);
  const w = hann(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const acc = new Float64Array(N / 2 + 1);
  const n = L.length;
  const frames = 160;
  let used = 0;
  for (let fi = 0; fi < frames && n > N; fi++) {
    const start = Math.floor(((fi + 0.5) / frames) * (n - N));
    let e = 0;
    for (let i = 0; i < N; i += 8) {
      const m = (L[start + i] + R[start + i]) * 0.5;
      e += m * m;
    }
    if (e / (N / 8) < 1e-6) continue;
    for (let i = 0; i < N; i++) {
      re[i] = (L[start + i] + R[start + i]) * 0.5 * w[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    for (let k = 0; k <= N / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    used++;
  }

  const nyq = sr / 2;
  const binHz = sr / N;
  const dB = new Float64Array(N / 2 + 1);
  for (let k = 0; k <= N / 2; k++) dB[k] = 10 * Math.log10(acc[k] / Math.max(1, used) + 1e-30);
  // ±250 Hz moving average in dB.
  const half = Math.max(1, Math.round(250 / binHz));
  const smooth = new Float64Array(dB.length);
  for (let k = 0; k < dB.length; k++) smooth[k] = mean(dB, Math.max(0, k - half), Math.min(dB.length, k + half + 1));
  const bin = (f: number) => Math.max(0, Math.min(dB.length - 1, Math.round(f / binHz)));
  const avg = (a: number, b: number) => mean(smooth, bin(a), bin(b) + 1);

  const ltasN = 200;
  const ltasFreqs = new Float32Array(ltasN);
  const ltasDb = new Float32Array(ltasN);
  // Power averaged over 1/6 octave around each point. The ±250 Hz average in
  // dB above suits the cutoff search, but in the bass it spans the silent
  // bins below 30 Hz and reads the bass several dB too low.
  for (let i = 0; i < ltasN; i++) {
    const f = 20 * Math.pow((nyq * 0.995) / 20, i / (ltasN - 1));
    const k0 = Math.max(1, Math.round((f * 0.9439) / binHz));
    const k1 = Math.min(N / 2, Math.max(k0, Math.round((f * 1.0595) / binHz)));
    let p = 0;
    for (let k = k0; k <= k1; k++) p += acc[k];
    ltasFreqs[i] = f;
    ltasDb[i] = 10 * Math.log10(p / (k1 - k0 + 1) / Math.max(1, used) + 1e-30);
  }

  const details: string[] = [];
  if (used < 8) {
    return {
      verdict: 'inconclusive',
      cutoffHz: null,
      dropDb: 0,
      summary: 'Lagu terlalu pendek atau terlalu senyap untuk dinilai.',
      details,
      ltasFreqs,
      ltasDb,
    };
  }

  const ref = avg(2000, 8000);
  let bestF = 0;
  let bestDrop = 0;
  for (let f = 11000; f <= nyq - 1600; f += binHz * 2) {
    const drop = avg(f - 1500, f - 300) - avg(f + 300, f + 1500);
    if (drop > bestDrop) {
      bestDrop = drop;
      bestF = f;
    }
  }
  let cutoff: number | null = null;
  if (bestDrop >= 18 && avg(bestF + 300, Math.min(nyq - 200, bestF + 3000)) < ref - 30) {
    // Refine to where the slope crosses the midpoint between both shelves.
    const hi = avg(bestF - 1500, bestF - 300);
    const lo = avg(bestF + 300, bestF + 1500);
    const mid = (hi + lo) / 2;
    cutoff = bestF;
    for (let f = bestF - 600; f <= bestF + 600; f += binHz) {
      if (smooth[bin(f)] < mid) {
        cutoff = f;
        break;
      }
    }
  }
  let contentTop = 0;
  for (let k = dB.length - 1; k > 0; k--) {
    if (smooth[k] > ref - 60) {
      contentTop = k * binHz;
      break;
    }
  }

  const lossless = meta.lossless !== false;
  const bits = meta.bitsPerSample;
  let verdict: Verdict;
  let summary: string;
  const caveat = 'Sebagian master memang memakai low-pass, jadi ini indikasi kuat, bukan bukti mutlak.';

  if (!lossless) {
    verdict = 'lossy';
    summary = cutoff
      ? `File lossy; encoder memotong frekuensi di ${khz(cutoff)}. Wajar untuk format ini.`
      : 'File lossy dengan spektrum hampir penuh, tanda encoder bitrate tinggi.';
  } else if (cutoff !== null && cutoff >= GREY_FROM && cutoff < 20500 && sr <= 50000) {
    // 256–320 kbps encoders cut here, but so do many CD masters and sample-rate
    // converters; the average spectrum alone cannot tell them apart.
    verdict = 'inconclusive';
    summary = `Spektrum terpotong tajam di ${khz(cutoff)}. Encoder MP3/AAC 256–320 kbps memotong di sekitar sini, tapi banyak master CD juga. Dari spektrum saja belum bisa dipastikan.`;
  } else if (cutoff !== null && cutoff < 20500 && sr <= 50000) {
    verdict = 'lossy-transcode';
    summary = `Spektrum terpotong tajam di ${khz(cutoff)}, ciri encoder MP3/AAC sekitar ${bitrateGuess(cutoff)}. Kemungkinan file ini dikonversi dari format lossy.`;
    details.push(caveat);
  } else if (sr > 50000 && cutoff !== null && cutoff < 26000) {
    verdict = 'upsampled';
    summary = `File ${khz(sr)} tapi kontennya berhenti di ${khz(cutoff)}. Kemungkinan di-upsample dari 44,1/48 kHz, jadi tidak ada detail hi-res tambahan.`;
    if (cutoff < GREY_FROM) details.push(`Potongan di ${khz(cutoff)} juga khas encoder lossy (${bitrateGuess(cutoff)}).`);
    else if (cutoff < 20500) details.push(`Potongan di ${khz(cutoff)} bisa dari encoder 256–320 kbps, bisa juga dari master CD-nya.`);
    details.push(caveat);
  } else if (bits && bits > 16 && effectiveBits === 16) {
    verdict = 'padded-bits';
    summary = `Ditandai ${bits}-bit, tapi isinya 16-bit: bit-bit bawahnya selalu nol.`;
  } else {
    verdict = 'genuine';
    summary =
      sr > 50000
        ? `Ada konten di atas 22 kHz sampai sekitar ${khz(contentTop)}: konsisten dengan master hi-res asli.`
        : `Spektrum terisi sampai ${khz(Math.max(contentTop, cutoff ?? 0))}: konsisten dengan sumber lossless asli.`;
  }
  if (verdict !== 'padded-bits' && bits && bits > 16 && effectiveBits === 16) {
    details.push(`Ditandai ${bits}-bit, tapi isinya hanya 16-bit (zero-padded).`);
  }
  if (effectiveBits && lossless) {
    details.push(
      effectiveBits === 32 ? 'Sampel bukan PCM integer (float atau hasil olahan).' : `Kedalaman bit efektif: ${effectiveBits}-bit.`,
    );
  }
  return { verdict, cutoffHz: cutoff, dropDb: bestDrop, summary, details, ltasFreqs, ltasDb };
}

/* ------------------------------------------------------------- Features -- */

/** Mono at about 22 kHz, as every stage after mastering hears it. */
export function downmix(L: Float32Array, R: Float32Array, sr: number) {
  const factor = Math.max(1, Math.floor(sr / 22050));
  const rate = sr / factor;
  const n = Math.floor(L.length / factor);
  const x = new Float32Array(n);
  if (factor === 1) {
    for (let i = 0; i < n; i++) x[i] = (L[i] + R[i]) * 0.5;
    return { x, rate };
  }
  const c = lowpass(rate * 0.42, sr);
  let a1 = 0, a2 = 0, a3 = 0, a4 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0;
  let o = 0;
  for (let i = 0; i < n * factor; i++) {
    const v = (L[i] + R[i]) * 0.5;
    const y1 = c.b0 * v + c.b1 * a1 + c.b2 * a2 - c.a1 * a3 - c.a2 * a4;
    a2 = a1;
    a1 = v;
    a4 = a3;
    a3 = y1;
    const y2 = c.b0 * y1 + c.b1 * b1 + c.b2 * b2 - c.a1 * b3 - c.a2 * b4;
    b2 = b1;
    b1 = y1;
    b4 = b3;
    b3 = y2;
    if (i % factor === 0) x[o++] = y2;
  }
  return { x, rate };
}

const HOP = 512;
const N_ONSET = 1024;
const N_CHROMA = 4096;
const TIMBRE_BANDS = 16;

interface Features {
  rate: number;
  frameRate: number;
  frames: number;
  onset: Float32Array;
  onsetLow: Float32Array;
  rmsDb: Float32Array;
  /** Chroma and timbre are computed on every second frame. */
  chroma: Float32Array;
  chromaEnergy: Float32Array;
  timbre: Float32Array;
  chromaFrames: number;
  frameTime: (frame: number) => number;
}

function extractFeatures(x: Float32Array, rate: number): Features {
  const frames = Math.max(1, Math.floor((x.length - N_ONSET) / HOP));
  const onset = new Float32Array(frames);
  const onsetLow = new Float32Array(frames);
  const rmsDb = new Float32Array(frames);
  const chromaFrames = Math.ceil(frames / 2);
  const chroma = new Float32Array(chromaFrames * 12);
  const chromaEnergy = new Float32Array(chromaFrames);
  const timbre = new Float32Array(chromaFrames * TIMBRE_BANDS);

  const f1 = new FFT(N_ONSET);
  const w1 = hann(N_ONSET);
  const f2 = new FFT(N_CHROMA);
  const w2 = hann(N_CHROMA);
  const re1 = new Float64Array(N_ONSET);
  const im1 = new Float64Array(N_ONSET);
  const re2 = new Float64Array(N_CHROMA);
  const im2 = new Float64Array(N_CHROMA);

  const bins1 = N_ONSET / 2;
  const binHz1 = rate / N_ONSET;
  const lowBins = Math.max(2, Math.round(150 / binHz1));
  const prev = new Float64Array(bins1 + 1);
  const lm = new Float64Array(bins1 + 1);

  // Chroma map: every bin from 55 Hz to 5 kHz votes for its nearest pitch class.
  const binHz2 = rate / N_CHROMA;
  const kLo = Math.ceil(55 / binHz2);
  const kHi = Math.min(N_CHROMA / 2, Math.floor(5000 / binHz2));
  const pc = new Int8Array(kHi + 1);
  const pw = new Float64Array(kHi + 1);
  for (let k = kLo; k <= kHi; k++) {
    const midi = 69 + 12 * Math.log2((k * binHz2) / 440);
    const near = Math.round(midi);
    const dev = midi - near;
    pc[k] = ((near % 12) + 12) % 12;
    pw[k] = Math.cos(Math.PI * dev) ** 2;
  }
  const bandEdges: number[] = [];
  for (let b = 0; b <= TIMBRE_BANDS; b++) bandEdges.push(Math.round((60 * Math.pow(10000 / 60, b / TIMBRE_BANDS)) / binHz2));

  for (let n = 0; n < frames; n++) {
    const start = n * HOP;
    let ms = 0;
    for (let i = 0; i < HOP; i++) {
      const v = x[start + N_ONSET / 2 - HOP / 2 + i] ?? 0;
      ms += v * v;
    }
    rmsDb[n] = 10 * Math.log10(ms / HOP + 1e-12);

    for (let i = 0; i < N_ONSET; i++) {
      re1[i] = x[start + i] * w1[i];
      im1[i] = 0;
    }
    f1.transform(re1, im1);
    let flux = 0;
    let fluxLow = 0;
    for (let k = 1; k <= bins1; k++) {
      const mag = Math.sqrt(re1[k] * re1[k] + im1[k] * im1[k]) / (N_ONSET / 4);
      lm[k] = Math.log(1 + 1000 * mag);
      const d = lm[k] - prev[k];
      if (d > 0) {
        flux += d;
        if (k <= lowBins) fluxLow += d;
      }
    }
    prev.set(lm);
    onset[n] = n === 0 ? 0 : flux;
    onsetLow[n] = n === 0 ? 0 : fluxLow;

    if (n % 2 === 0) {
      const c = n / 2;
      const centre = start + N_ONSET / 2;
      const s2 = centre - N_CHROMA / 2;
      for (let i = 0; i < N_CHROMA; i++) {
        const idx = s2 + i;
        re2[i] = idx >= 0 && idx < x.length ? x[idx] * w2[i] : 0;
        im2[i] = 0;
      }
      f2.transform(re2, im2);
      let energy = 0;
      const co = c * 12;
      for (let k = kLo; k <= kHi; k++) {
        const p = re2[k] * re2[k] + im2[k] * im2[k];
        energy += p;
        chroma[co + pc[k]] += pw[k] * Math.sqrt(p);
      }
      chromaEnergy[c] = energy;
      const to = c * TIMBRE_BANDS;
      for (let b = 0; b < TIMBRE_BANDS; b++) {
        let e = 0;
        for (let k = Math.max(1, bandEdges[b]); k < Math.max(bandEdges[b] + 1, bandEdges[b + 1]); k++) e += re2[k] * re2[k] + im2[k] * im2[k];
        timbre[to + b] = Math.log10(e + 1e-10);
      }
    }
    if ((n & 255) === 0) report('Spektrum', 0.33 + (n / frames) * 0.38);
  }

  const frameRate = rate / HOP;
  return {
    rate,
    frameRate,
    frames,
    onset,
    onsetLow,
    rmsDb,
    chroma,
    chromaEnergy,
    timbre,
    chromaFrames,
    frameTime: (frame: number) => (frame * HOP + N_ONSET / 2) / rate,
  };
}

/* --------------------------------------------------------------- Rhythm -- */

function normaliseOnset(o: Float32Array, frameRate: number): Float64Array {
  const n = o.length;
  const win = Math.max(1, Math.round(frameRate * 0.4));
  const out = new Float64Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += o[i];
    if (i >= win) s -= o[i - win];
    const local = s / Math.min(i + 1, win);
    out[i] = Math.max(0, o[i] - local);
  }
  let m = 0;
  for (let i = 0; i < n; i++) m += out[i] * out[i];
  const sd = Math.sqrt(m / Math.max(1, n)) || 1;
  for (let i = 0; i < n; i++) out[i] /= sd;
  return out;
}

/**
 * Flux summed over all bins is dominated by broadband hits (snare, hats); a
 * sine-like kick barely registers. Normalising the low band and the rest
 * separately before adding them gives kick and snare an equal vote.
 */
function rhythmEnvelope(f: Features): Float32Array {
  const high = new Float32Array(f.frames);
  for (let i = 0; i < f.frames; i++) high[i] = Math.max(0, f.onset[i] - f.onsetLow[i]);
  const lo = normaliseOnset(f.onsetLow, f.frameRate);
  const hi = normaliseOnset(high, f.frameRate);
  const out = new Float32Array(f.frames);
  for (let i = 0; i < f.frames; i++) out[i] = lo[i] + hi[i];
  return out;
}

function estimateTempo(onsetRaw: Float32Array, frameRate: number) {
  const o = normaliseOnset(onsetRaw, frameRate);
  const n = o.length;
  const minLag = (frameRate * 60) / 210;
  const maxLag = (frameRate * 60) / 50;
  const acMax = Math.min(n - 1, Math.ceil(maxLag * 4) + 2);
  const ac = new Float64Array(acMax + 1);
  for (let lag = 1; lag <= acMax; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += o[i] * o[i - lag];
    ac[lag] = s / (n - lag);
  }
  // Linear interpolation: beat periods are rarely a whole number of frames,
  // and rounding every multiple drifts the comb off the true period.
  const acAt = (x: number) => {
    if (x < 1 || x >= acMax) return 0;
    const i = Math.floor(x);
    const f = x - i;
    return ac[i] * (1 - f) + ac[i + 1] * f;
  };
  const step = 0.1;
  const lags: number[] = [];
  const scores: number[] = [];
  for (let lag = minLag; lag <= maxLag && lag * 4 < acMax; lag += step) {
    // Comb over the first four multiples resolves half/double confusion; the
    // half-period term favours periods whose off-beats are also active,
    // which rejects 3:2 errors such as dotted-quarter "beats".
    let comb = 0;
    for (let m = 1; m <= 4; m++) comb += acAt(lag * m) / m;
    comb += 0.5 * acAt(lag / 2);
    const bpm = (60 * frameRate) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    lags.push(lag);
    scores.push(Math.max(0, comb) * prior);
  }
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  let period = lags[best] ?? (frameRate * 60) / 120;
  const a = scores[best - 1] ?? 0;
  const b = scores[best] ?? 0;
  const c = scores[best + 1] ?? 0;
  const denom = a - 2 * b + c;
  if (denom < 0) period += ((0.5 * (a - c)) / denom) * step;
  const avg = mean(scores) || 1;
  const confidence = Math.max(0, Math.min(1, (b / avg - 1) / 3));

  // Octave check. The comb settles the period only up to a factor of two. A
  // backbeat snare can make the half-tempo reading win, so a period whose two
  // halves are about equally strong may really be two beats. But steady
  // eighth notes (hi-hats, strummed guitar, an eighth-note bass) split the
  // right period into equal halves too: on real songs, always walking faster
  // read 80 BPM as 160 and 89 as 178. Equal halves therefore only say that
  // both readings fit the onsets, and between two readings that fit, the one
  // nearer the tempo listeners most often tap wins.
  const smooth = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) smooth[i] = 0.25 * o[i - 1] + 0.5 * o[i] + 0.25 * o[i + 1];
  const bpmOf = (L: number) => (60 * frameRate) / L;
  const fromPreferred = (L: number) => Math.abs(Math.log2(bpmOf(L) / PREFERRED_BPM));
  let chosen = period;
  for (let guard = 0; guard < 2; guard++) {
    const faster = chosen / 2;
    if (halfBalance(smooth, chosen) < HALVES_FIT) break;
    if (fromPreferred(faster) >= fromPreferred(chosen)) break;
    chosen = faster;
  }
  // The other octave, when it fits the onsets about as well: offered to the
  // listener beside the tempo, since only they can settle it.
  let alt: 0.5 | 2 | null = null;
  if (bpmOf(chosen) * 2 <= 210 && halfBalance(smooth, chosen) >= HALVES_FIT) alt = 2;
  else if (chosen < period || (bpmOf(chosen * 2) >= 50 && halfBalance(smooth, chosen * 2) >= HALVES_FIT)) alt = 0.5;
  return { period: chosen, bpm: bpmOf(chosen), confidence, alt };
}

/** The tempo listeners most often tap to; ambiguous octaves resolve toward it. */
const PREFERRED_BPM = 105;
/** Off-beat to on-beat strength at which both octaves of a period fit the onsets. */
const HALVES_FIT = 0.4;

/**
 * Folds the onset envelope at `period` and compares the strongest phase with
 * the phase half a period later: 1 means both halves are equally strong.
 */
function halfBalance(o: Float64Array, period: number): number {
  const n = o.length;
  if (period < 2) return 0;
  const at = (t: number) => {
    const i = Math.floor(t);
    const f = t - i;
    return i >= 0 && i + 1 < n ? o[i] * (1 - f) + o[i + 1] * f : 0;
  };
  const fold = (phase: number) => {
    let s = 0;
    let c = 0;
    for (let t = phase; t < n - 1; t += period) {
      s += at(t);
      c++;
    }
    return c ? s / c : 0;
  };
  const steps = Math.max(8, Math.round(period));
  let grid = -1;
  let phase = 0;
  for (let i = 0; i < steps; i++) {
    const p = (i * period) / steps;
    const g = fold(p);
    if (g > grid) {
      grid = g;
      phase = p;
    }
  }
  return grid > 0 ? fold(phase + period / 2) / grid : 0;
}

function trackBeats(onsetRaw: Float32Array, period: number, frameRate: number): number[] {
  const o = normaliseOnset(onsetRaw, frameRate);
  const n = o.length;
  // Local score: onset strength smoothed by a Gaussian a fraction of a beat wide.
  const sigma = Math.max(1, period / 32);
  const radius = Math.ceil(sigma * 3);
  const kern: number[] = [];
  for (let i = -radius; i <= radius; i++) kern.push(Math.exp(-0.5 * (i / sigma) ** 2));
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j >= 0 && j < n) s += o[j] * kern[k + radius];
    }
    local[i] = s;
  }
  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.max(1, Math.round(period / 2));
  const hi = Math.round(period * 2);
  const tightness = 100;
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let arg = -1;
    for (let tau = lo; tau <= hi; tau++) {
      const p = t - tau;
      if (p < 0) break;
      const s = cum[p] - tightness * Math.log(tau / period) ** 2;
      if (s > best) {
        best = s;
        arg = p;
      }
    }
    cum[t] = local[t] + (arg >= 0 ? Math.max(0, best) : 0);
    back[t] = arg >= 0 && best > 0 ? arg : -1;
  }
  let end = n - 1;
  let bestEnd = -Infinity;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) {
    if (cum[t] > bestEnd) {
      bestEnd = cum[t];
      end = t;
    }
  }
  const beats: number[] = [];
  for (let t = end; t >= 0; t = back[t]) {
    beats.push(t);
    if (back[t] < 0) break;
  }
  beats.reverse();
  // Trim beats in leading/trailing silence.
  let rms = 0;
  for (let i = 0; i < n; i++) rms += local[i] * local[i];
  const thr = 0.5 * Math.sqrt(rms / Math.max(1, n));
  while (beats.length && local[beats[0]] < thr) beats.shift();
  while (beats.length && local[beats[beats.length - 1]] < thr) beats.pop();
  return beats;
}

/**
 * Beat tracking starts where onsets get strong; a soft intro in tempo still
 * deserves a grid. Extend backwards by the median period while there is
 * sound, at most eight beats.
 */
function extendGrid(beats: number[], f: Features): number[] {
  if (beats.length < 4) return beats;
  const ibis: number[] = [];
  for (let i = 1; i < beats.length; i++) ibis.push(beats[i] - beats[i - 1]);
  const p = median(ibis);
  const out = [...beats];
  for (let k = 0; k < 16; k++) {
    const prev = Math.round(out[0] - p);
    if (prev < 0) break;
    let ms = -Infinity;
    for (let i = Math.max(0, prev - 4); i <= prev + 4 && i < f.frames; i++) ms = Math.max(ms, f.rmsDb[i]);
    if (ms < -55) break;
    out.unshift(prev);
  }
  return out;
}

/** Least-squares slope of beat time against beat index: the average period. */
function regressionPeriod(beats: Float32Array): number {
  const n = beats.length;
  const mx = (n - 1) / 2;
  let my = 0;
  for (let i = 0; i < n; i++) my += beats[i];
  my /= n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (beats[i] - my);
    den += (i - mx) ** 2;
  }
  return den > 0 ? num / den : 0.5;
}

/**
 * Spectral flux on a 46 ms window peaks late for slow-attack sounds such as
 * a sine-sweep kick. Find the real attacks on a 3 ms energy envelope, shift
 * the whole grid by their median lag, then snap each beat to an attack that
 * lies close to it.
 */
function alignToAttacks(beats: number[], x: Float32Array, rate: number): number[] {
  if (beats.length < 8) return beats;
  const hop = 64;
  const n = Math.floor(x.length / hop);
  const env = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let e = 0;
    for (let i = 0; i < hop; i++) {
      const v = x[k * hop + i];
      e += v * v;
    }
    env[k] = 10 * Math.log10(e / hop + 1e-10);
  }
  const hopT = hop / rate;
  let lastStrength = 0;
  const attackNear = (t: number, before: number, after: number): number | null => {
    const k0 = Math.max(2, Math.floor((t - before) / hopT));
    const k1 = Math.min(n - 1, Math.ceil((t + after) / hopT));
    let best = 3;
    let at = -1;
    for (let k = k0; k <= k1; k++) {
      const d = env[k] - env[k - 2];
      if (d > best) {
        best = d;
        at = k;
      }
    }
    lastStrength = at >= 0 ? best : 0;
    return at >= 0 ? (at - 1) * hopT : null;
  };
  const offsets: number[] = [];
  for (const b of beats) {
    const a = attackNear(b, 0.15, 0.05);
    if (a !== null) offsets.push(a - b);
  }
  const shift = offsets.length >= beats.length * 0.3 ? median(offsets) : 0;
  const strength: number[] = [];
  const snapped = beats.map((b) => {
    const target = b + shift;
    const a = attackNear(target, 0.035, 0.035);
    strength.push(lastStrength);
    return Math.max(0, a ?? target);
  });
  return regularise(snapped, strength);
}

/**
 * Beats in soft passages (an intro without drums) are guesses. Refit each
 * one from a weighted local regression in which strong, percussive beats
 * dominate, and replace weak beats that stray from the fitted grid.
 */
function regularise(beats: number[], strength: number[]): number[] {
  const n = beats.length;
  if (n < 12) return beats;
  const medStrength = median(strength.filter((x) => x > 0)) || 1;
  const out = [...beats];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, Math.min(i - 16, n - 33));
    const hi = Math.min(n - 1, Math.max(i + 16, 32));
    let sw = 0;
    let sx = 0;
    let sy = 0;
    for (let j = lo; j <= hi; j++) {
      const w = Math.max(0.05, strength[j] / medStrength) ** 2;
      sw += w;
      sx += w * j;
      sy += w * beats[j];
    }
    const mx = sx / sw;
    const my = sy / sw;
    let num = 0;
    let den = 0;
    for (let j = lo; j <= hi; j++) {
      const w = Math.max(0.05, strength[j] / medStrength) ** 2;
      num += w * (j - mx) * (beats[j] - my);
      den += w * (j - mx) ** 2;
    }
    const slope = den > 0 ? num / den : 0;
    const fit = my + slope * (i - mx);
    if (strength[i] < medStrength * 0.5 && Math.abs(beats[i] - fit) > 0.02) out[i] = Math.max(0, fit);
  }
  return out;
}

function beatSyncChroma(f: Features, beats: Float32Array, duration: number): Float64Array[] {
  const out: Float64Array[] = [];
  const ct = (c: number) => f.frameTime(c * 2);
  let c = 0;
  for (let i = 0; i < beats.length; i++) {
    const t0 = beats[i];
    const t1 = i + 1 < beats.length ? beats[i + 1] : Math.min(duration, t0 + (beats[i] - (beats[i - 1] ?? t0 - 0.5)));
    const v = new Float64Array(13);
    while (c < f.chromaFrames && ct(c) < t0) c++;
    let k = c;
    let count = 0;
    while (k < f.chromaFrames && ct(k) < t1) {
      let mx = 1e-12;
      for (let p = 0; p < 12; p++) mx = Math.max(mx, f.chroma[k * 12 + p]);
      for (let p = 0; p < 12; p++) v[p] += Math.sqrt(f.chroma[k * 12 + p] / mx);
      v[12] += f.chromaEnergy[k];
      count++;
      k++;
    }
    let norm = 0;
    for (let p = 0; p < 12; p++) norm += v[p] * v[p];
    norm = Math.sqrt(norm) || 1;
    for (let p = 0; p < 12; p++) v[p] /= norm;
    v[12] = count ? v[12] / count : 0;
    out.push(v);
  }
  return out;
}

function zscore(a: number[]): number[] {
  const m = mean(a);
  const sd = Math.sqrt(mean(a.map((v) => (v - m) ** 2))) || 1;
  return a.map((v) => (v - m) / sd);
}

function findDownbeatPhase(f: Features, beatFrames: number[], chroma: Float64Array[]): number {
  if (beatFrames.length < 8) return 0;
  const low = beatFrames.map((b) => {
    let m = 0;
    for (let k = -2; k <= 2; k++) m = Math.max(m, f.onsetLow[b + k] ?? 0);
    return m;
  });
  const change = chroma.map((v, i) => {
    if (i === 0) return 0;
    let d = 0;
    for (let p = 0; p < 12; p++) d += v[p] * chroma[i - 1][p];
    return 1 - d;
  });
  const zl = zscore(low);
  const zc = zscore(change);
  let best = 0;
  let bestScore = -Infinity;
  for (let p = 0; p < 4; p++) {
    let s = 0;
    let c = 0;
    for (let i = p; i < beatFrames.length; i += 4) {
      s += zl[i] + 1.2 * zc[i];
      c++;
    }
    s /= Math.max(1, c);
    if (s > bestScore) {
      bestScore = s;
      best = p;
    }
  }
  return best;
}

/* ------------------------------------------------------------ Structure -- */

function segmentStructure(
  f: Features,
  beats: Float32Array,
  downbeats: number[],
  beatChroma: Float64Array[],
  duration: number,
): Section[] {
  const whole = (name: SectionName = 'Bagian'): Section[] => [{ t: 0, end: duration, label: 'A', name, energy: 0.5 }];
  if (downbeats.length < 6) return whole();

  const barStarts = downbeats.map((i) => beats[i]);
  const B = barStarts.length;
  const barEnd = (k: number) => (k + 1 < B ? barStarts[k + 1] : Math.min(duration, barStarts[k] + (barStarts[k] - barStarts[k - 1])));

  const ct = (c: number) => f.frameTime(c * 2);
  const timbreBars: number[][] = [];
  const energyBars: number[] = [];
  for (let k = 0; k < B; k++) {
    const t0 = barStarts[k];
    const t1 = barEnd(k);
    const tv = new Array<number>(TIMBRE_BANDS).fill(0);
    let n = 0;
    for (let c = Math.max(0, Math.floor((t0 * f.frameRate) / 2) - 2); c < f.chromaFrames && ct(c) < t1; c++) {
      if (ct(c) < t0) continue;
      for (let b = 0; b < TIMBRE_BANDS; b++) tv[b] += f.timbre[c * TIMBRE_BANDS + b];
      n++;
    }
    timbreBars.push(tv.map((v) => v / Math.max(1, n)));
    let e = 0;
    let m = 0;
    for (let fr = Math.floor(t0 * f.frameRate); fr < Math.min(f.frames, Math.floor(t1 * f.frameRate)); fr++) {
      e += Math.pow(10, f.rmsDb[fr] / 10);
      m++;
    }
    energyBars.push(10 * Math.log10(e / Math.max(1, m) + 1e-12));
  }
  // z-normalise each timbre dimension across bars.
  for (let b = 0; b < TIMBRE_BANDS; b++) {
    const col = zscore(timbreBars.map((v) => v[b]));
    for (let k = 0; k < B; k++) timbreBars[k][b] = col[k];
  }
  const ez = zscore(energyBars);

  const vecs: Float64Array[] = [];
  for (let k = 0; k < B; k++) {
    const v = new Float64Array(12 + TIMBRE_BANDS + 1);
    const i0 = downbeats[k];
    const i1 = k + 1 < B ? downbeats[k + 1] : Math.min(beatChroma.length, i0 + 4);
    for (let i = i0; i < i1; i++) for (let p = 0; p < 12; p++) v[p] += beatChroma[i][p];
    let cn = 0;
    for (let p = 0; p < 12; p++) cn += v[p] * v[p];
    cn = Math.sqrt(cn) || 1;
    for (let p = 0; p < 12; p++) v[p] /= cn;
    let tn = 0;
    for (let b = 0; b < TIMBRE_BANDS; b++) tn += timbreBars[k][b] ** 2;
    tn = Math.sqrt(tn) || 1;
    for (let b = 0; b < TIMBRE_BANDS; b++) v[12 + b] = timbreBars[k][b] / tn;
    v[12 + TIMBRE_BANDS] = ez[k] * 0.35;
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    vecs.push(v);
  }
  const S: Float64Array[] = vecs.map((a) => new Float64Array(vecs.map((b) => a.reduce((s, x, i) => s + x * b[i], 0))));

  // Checkerboard novelty along the diagonal (Foote 2000).
  // The kernel is truncated at the song's edges and normalised by its
  // weight, so values stay in similarity units: ~0 inside a homogeneous
  // passage, 0.1+ where the music genuinely changes.
  const w = 4;
  const nov = new Array<number>(B).fill(0);
  const sigma = w / 2;
  for (let i = 2; i <= B - 2; i++) {
    let s = 0;
    let wPos = 0;
    let wNeg = 0;
    for (let a = -w; a < w; a++) {
      for (let b = -w; b < w; b++) {
        const ia = i + a;
        const ib = i + b;
        if (ia < 0 || ib < 0 || ia >= B || ib >= B) continue;
        const same = a < 0 === b < 0;
        const g = Math.exp(-((a + 0.5) ** 2 + (b + 0.5) ** 2) / (2 * sigma * sigma));
        if (same) {
          s += g * S[ia][ib];
          wPos += g;
        } else {
          s -= g * S[ia][ib];
          wNeg += g;
        }
      }
    }
    // Mean within-block similarity minus mean cross-block similarity.
    nov[i] = wPos > 0 && wNeg > 0 ? Math.max(0, s / ((wPos + wNeg) / 2)) / 2 : 0;
  }
  const eNov = energyBars.map((_, i) => (i >= 1 && i <= B - 1 ? Math.abs(mean(energyBars, i, Math.min(B, i + 2)) - mean(energyBars, Math.max(0, i - 2), i)) : 0));
  const score = nov.map((v, i) => v / 0.08 + eNov[i] / 4);

  const cands: number[] = [];
  for (let i = 2; i <= B - 2; i++) {
    let isMax = true;
    for (let k = -2; k <= 2; k++) if (k !== 0 && (score[i + k] ?? 0) > score[i]) isMax = false;
    if (isMax && score[i] >= 1) cands.push(i);
  }
  cands.sort((a, b) => score[b] - score[a]);
  const bounds: number[] = [];
  for (const c of cands) {
    if (c < 2 || c > B - 2) continue;
    if (bounds.every((b) => Math.abs(b - c) >= 4)) bounds.push(c);
  }
  bounds.sort((a, b) => a - b);
  const edges = [0, ...bounds, B];

  const segBars: [number, number][] = [];
  for (let i = 0; i < edges.length - 1; i++) segBars.push([edges[i], edges[i + 1]]);
  const segVec = segBars.map(([a, b]) => {
    const v = new Float64Array(vecs[0].length);
    for (let k = a; k < b; k++) for (let i = 0; i < v.length; i++) v[i] += vecs[k][i];
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  });
  const sim = (i: number, j: number) => segVec[i].reduce((s, x, k) => s + x * segVec[j][k], 0);

  const labels: string[] = [];
  let nextLabel = 0;
  for (let i = 0; i < segBars.length; i++) {
    let found = -1;
    let bestSim = 0;
    for (let j = 0; j < i; j++) {
      const sj = sim(i, j);
      if (sj > 0.93 && sj > bestSim) {
        bestSim = sj;
        found = j;
      }
    }
    labels.push(found >= 0 ? labels[found] : String.fromCharCode(65 + nextLabel++));
  }

  for (let i = segBars.length - 1; i > 0; i--) {
    if (labels[i] === labels[i - 1]) {
      segBars[i - 1] = [segBars[i - 1][0], segBars[i][1]];
      segBars.splice(i, 1);
      labels.splice(i, 1);
    }
  }
  // A sliver at the very end (the last bar ringing out) is not a section.
  const lastSeg = segBars.length - 1;
  if (lastSeg > 0 && segBars[lastSeg][1] - segBars[lastSeg][0] < 3) {
    const tailDb = mean(energyBars, segBars[lastSeg][0], segBars[lastSeg][1]);
    const prevDb = mean(energyBars, segBars[lastSeg - 1][0], segBars[lastSeg - 1][1]);
    if (Math.abs(tailDb - prevDb) < 3) {
      segBars[lastSeg - 1] = [segBars[lastSeg - 1][0], segBars[lastSeg][1]];
      segBars.pop();
      labels.pop();
    }
  }
  // Re-letter in order of appearance after merging.
  const relabel = new Map<string, string>();
  for (let i = 0; i < labels.length; i++) {
    if (!relabel.has(labels[i])) relabel.set(labels[i], String.fromCharCode(65 + relabel.size));
    labels[i] = relabel.get(labels[i])!;
  }

  const segEnergy = segBars.map(([a, b]) => mean(energyBars, a, b));
  const eMin = Math.min(...segEnergy);
  const eMax = Math.max(...segEnergy);
  const eNorm = segEnergy.map((e) => (eMax - eMin > 0.5 ? (e - eMin) / (eMax - eMin) : 0.5));

  const durations = segBars.map(([a, b]) => (b >= B ? duration : barStarts[b]) - (a === 0 ? 0 : barStarts[a]));
  const names = nameSections(labels, eNorm, segEnergy, durations);
  return segBars.map(([a, b], i) => ({
    t: i === 0 ? 0 : barStarts[a],
    end: b >= B ? duration : barStarts[b],
    label: labels[i],
    name: names[i],
    energy: eNorm[i],
  }));
}

function nameSections(labels: string[], energy: number[], energyDb: number[], durations: number[]): SectionName[] {
  const n = labels.length;
  const names = new Array<SectionName>(n).fill('Bagian');
  if (n === 1) return names;
  const count = new Map<string, number>();
  for (const l of labels) count.set(l, (count.get(l) ?? 0) + 1);

  if (energy[0] < 0.45 && count.get(labels[0]) === 1) names[0] = 'Intro';
  const total = durations.reduce((a, b) => a + b, 0);
  const lastShortAndFading = durations[n - 1] < total * 0.15 && energyDb[n - 1] < energyDb[n - 2] - 1;
  if (n > 2 && count.get(labels[n - 1]) === 1 && (energy[n - 1] < 0.45 || lastShortAndFading)) names[n - 1] = 'Outro';

  const free = (i: number) => names[i] === 'Bagian';
  const labelEnergy = new Map<string, number>();
  for (let i = 0; i < n; i++) if (free(i)) labelEnergy.set(labels[i], Math.max(labelEnergy.get(labels[i]) ?? -Infinity, energyDb[i]));
  const ranked = [...labelEnergy.entries()].sort((a, b) => b[1] - a[1]);
  const repeated = ranked.filter(([l]) => (count.get(l) ?? 0) >= 2);
  const medDb = median(energyDb);

  if (repeated.length) {
    const chorus = repeated[0][0];
    const verse = repeated.find(([l]) => l !== chorus)?.[0] ?? null;
    for (let i = 0; i < n; i++) {
      if (!free(i)) continue;
      if (labels[i] === chorus) names[i] = 'Chorus';
      else if (labels[i] === verse) names[i] = 'Verse';
      else if ((count.get(labels[i]) ?? 0) === 1 && i > n / 3) names[i] = 'Bridge';
    }
    return names;
  }

  // Nothing repeats (short songs, through-composed pieces): read the song in
  // order. The first free section is the verse; a later one at least as loud
  // is the chorus; quieter ones in between are bridges.
  const freeIdx = names.map((_, i) => i).filter(free);
  if (freeIdx.length === 0) return names;
  const verseDb = energyDb[freeIdx[0]];
  names[freeIdx[0]] = freeIdx.length > 1 || names[0] === 'Intro' ? 'Verse' : 'Bagian';
  for (const i of freeIdx.slice(1)) {
    if (energyDb[i] >= verseDb - 1 || energyDb[i] >= medDb + 1.5) names[i] = 'Chorus';
    else names[i] = 'Bridge';
  }
  return names;
}

/* ---------------------------------------------------------------- Curves -- */

function energyCurve(rmsDb: Float32Array, frameRate: number): Float32Array {
  const step = frameRate / 10;
  const n = Math.max(1, Math.floor(rmsDb.length / step));
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let p = 0;
    let c = 0;
    for (let k = Math.floor(i * step); k < Math.min(rmsDb.length, Math.floor((i + 1) * step)); k++) {
      p += Math.pow(10, rmsDb[k] / 10);
      c++;
    }
    raw[i] = 10 * Math.log10(p / Math.max(1, c) + 1e-12);
  }
  const sm = new Float64Array(n);
  for (let i = 0; i < n; i++) sm[i] = mean(raw, Math.max(0, i - 5), Math.min(n, i + 6));
  const sorted = Array.from(sm).sort((a, b) => a - b);
  const lo = percentile(sorted, 0.05);
  const hi = percentile(sorted, 0.98);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = hi - lo > 1 ? Math.max(0, Math.min(1, (sm[i] - lo) / (hi - lo))) : 0.5;
  return out;
}

function chromaRiver(f: Features): Uint8Array {
  const out = new Uint8Array(f.chromaFrames * 12);
  const energies = Array.from(f.chromaEnergy);
  const med = median(energies) || 1;
  for (let c = 0; c < f.chromaFrames; c++) {
    let mx = 1e-12;
    for (let p = 0; p < 12; p++) mx = Math.max(mx, f.chroma[c * 12 + p]);
    const gain = Math.min(1, Math.sqrt(f.chromaEnergy[c] / med));
    for (let p = 0; p < 12; p++) out[c * 12 + p] = Math.round(Math.pow(f.chroma[c * 12 + p] / mx, 1.5) * gain * 255);
  }
  return out;
}
