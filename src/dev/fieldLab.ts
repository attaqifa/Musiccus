/*
 * Field lab: measures the stereo field analysis (src/audio/field.ts) on a
 * synthetic mix whose answers are known: every sound has a fixed pan and a
 * known character (a note, a hit, or diffuse sound). Not imported by the app;
 * load it from the dev console:
 *
 *   const lab = await import('/src/dev/fieldLab.ts');
 *   lab.report();          // each sound alone, then all of them mixed
 *   lab.calibrate();       // coherence of diffuse and direct sound, for DIFFUSE_FLOOR
 *   await lab.addTestTrack(); // adds "Lab panggung" to the library to watch it play
 *
 * and watch the live field with `(await import('/src/dev/fieldView.ts')).showField()`.
 * The synthesis and the measurements are plain arithmetic, so the same file
 * also runs outside the browser.
 */
import { FIELD_BANDS, FIELD_CELLS, FIELD_PANS, FieldAnalyzer, emptyField, fieldFftSize, type FieldOptions } from '../audio/field';

export type Kind = 'tone' | 'hit' | 'haze';

export interface SourceSpec {
  name: string;
  /** -1 left .. 1 right; for diffuse sound, where its centre is. */
  pan: number;
  kind: Kind;
  /** Rough range in Hz, for the report. */
  range: string;
}

export const SOURCES: SourceSpec[] = [
  { name: 'kick', pan: 0, kind: 'hit', range: '45–150 Hz + klik' },
  { name: 'bass', pan: 0, kind: 'tone', range: '41–400 Hz' },
  { name: 'hi-hat', pan: 0.6, kind: 'hit', range: '5–16 kHz' },
  { name: 'keys', pan: -0.7, kind: 'tone', range: '175–3 kHz' },
  { name: 'lead', pan: 0, kind: 'tone', range: '440 Hz–8 kHz' },
  { name: 'pad lebar', pan: 0, kind: 'haze', range: '300 Hz–3 kHz' },
];

const BEAT = 0.5;

/** Deterministic noise so every run measures the same signal. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

/** Constant-power pan, as a StereoPannerNode or a console pan pot. */
function place(mono: Float32Array, pan: number): [Float32Array, Float32Array] {
  const th = ((pan + 1) * Math.PI) / 4;
  const gl = Math.cos(th);
  const gr = Math.sin(th);
  const L = new Float32Array(mono.length);
  const R = new Float32Array(mono.length);
  for (let i = 0; i < mono.length; i++) {
    L[i] = mono[i] * gl;
    R[i] = mono[i] * gr;
  }
  return [L, R];
}

function kick(rate: number, len: number): Float32Array {
  const x = new Float32Array(len);
  const noise = rng(1);
  for (let tb = 0; tb * rate < len; tb += BEAT) {
    let ph = 0;
    const start = Math.round(tb * rate);
    for (let i = 0; i < 0.35 * rate && start + i < len; i++) {
      const t = i / rate;
      ph += (2 * Math.PI * (48 + 100 * Math.exp(-t / 0.03))) / rate;
      x[start + i] += Math.sin(ph) * Math.exp(-t / 0.18) * 0.8 + noise() * Math.exp(-t / 0.004) * 0.5;
    }
  }
  return x;
}

function bass(rate: number, len: number): Float32Array {
  const x = new Float32Array(len);
  const notes = [55, 55, 41.2, 49];
  const a = 1 - Math.exp((-2 * Math.PI * 300) / rate);
  let y = 0;
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / rate;
    const n = Math.floor(t / (2 * BEAT));
    const tn = t - n * 2 * BEAT;
    const f = notes[n % notes.length];
    ph = (ph + f / rate) % 1;
    const env = Math.min(1, tn / 0.008) * Math.min(1, (2 * BEAT - tn) / 0.02);
    y += (2 * ph - 1 - y) * a;
    x[i] = y * env * 0.5;
  }
  return x;
}

function hat(rate: number, len: number): Float32Array {
  const x = new Float32Array(len);
  const noise = rng(2);
  let p1 = 0;
  let p2 = 0;
  for (let tb = 0; tb * rate < len; tb += BEAT / 2) {
    const start = Math.round(tb * rate);
    for (let i = 0; i < 0.12 * rate && start + i < len; i++) {
      const w = noise();
      // Two differences: a steep high-pass, the sizzle of a closed hat.
      const d1 = w - p1;
      p1 = w;
      const d2 = d1 - p2;
      p2 = d1;
      x[start + i] += d2 * Math.exp(-i / rate / 0.025) * 0.3;
    }
  }
  return x;
}

function partials(t: number, f: number, n: number, weight: (h: number) => number) {
  let v = 0;
  for (let h = 1; h <= n; h++) v += Math.sin(2 * Math.PI * h * f * t) * weight(h);
  return v;
}

function keys(rate: number, len: number): Float32Array {
  const x = new Float32Array(len);
  const chords = [
    [261.63, 329.63, 392.0],
    [220.0, 261.63, 329.63],
    [174.61, 220.0, 261.63],
    [196.0, 246.94, 293.66],
  ];
  for (let i = 0; i < len; i++) {
    const t = i / rate;
    const c = Math.floor(t / (4 * BEAT));
    const tc = t - c * 4 * BEAT;
    const env = Math.min(1, tc / 0.015) * (0.7 + 0.3 * Math.exp(-tc / 0.3)) * Math.min(1, (4 * BEAT - tc) / 0.03);
    let v = 0;
    for (const f of chords[c % chords.length]) v += partials(t, f, 8, (h) => 1 / Math.pow(h, 1.5));
    x[i] = v * env * 0.07;
  }
  return x;
}

function lead(rate: number, len: number): Float32Array {
  const x = new Float32Array(len);
  const melody = [440, 493.88, 523.25, 587.33, 659.25, 587.33, 523.25, 493.88];
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / rate;
    const n = Math.floor(t / (2 * BEAT));
    const tn = t - n * 2 * BEAT;
    const f = melody[n % melody.length] * (1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t));
    ph += f / rate;
    const env = Math.min(1, tn / 0.03) * Math.max(0, Math.min(1, (2 * BEAT - 0.05 - tn) / 0.03));
    let v = 0;
    // A voice-like spectrum: a formant near 800 Hz over a gentle slope.
    for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * h * ph) * (Math.exp(-(((h * f - 800) / 600) ** 2)) + 0.3 / h);
    x[i] = v * env * 0.1;
  }
  return x;
}

/** Two unrelated band-limited noises, one per channel: a wide pad or a reverb tail. */
function pad(rate: number, len: number): [Float32Array, Float32Array] {
  const out: Float32Array[] = [];
  for (const seed of [3, 4]) {
    const noise = rng(seed);
    const x = new Float32Array(len);
    const lp = 1 - Math.exp((-2 * Math.PI * 3000) / rate);
    const hp = 1 - Math.exp((-2 * Math.PI * 300) / rate);
    let a = 0;
    let b = 0;
    for (let i = 0; i < len; i++) {
      a += (noise() - a) * lp;
      b += (a - b) * hp;
      const t = i / rate;
      x[i] = (a - b) * (0.8 + 0.2 * Math.sin(2 * Math.PI * 0.25 * t)) * 0.35;
    }
    out.push(x);
  }
  return [out[0], out[1]];
}

export interface Rendered {
  rate: number;
  sources: { spec: SourceSpec; L: Float32Array; R: Float32Array }[];
  mix: { L: Float32Array; R: Float32Array };
}

export function render(rate = 48000, seconds = 8): Rendered {
  const len = Math.round(rate * seconds);
  const mono: Record<string, Float32Array> = {
    kick: kick(rate, len),
    bass: bass(rate, len),
    'hi-hat': hat(rate, len),
    keys: keys(rate, len),
    lead: lead(rate, len),
  };
  const sources = SOURCES.map((spec) => {
    const [L, R] = spec.kind === 'haze' ? pad(rate, len) : place(mono[spec.name], spec.pan);
    return { spec, L, R };
  });
  const mix = { L: new Float32Array(len), R: new Float32Array(len) };
  for (const s of sources) {
    for (let i = 0; i < len; i++) {
      mix.L[i] += s.L[i];
      mix.R[i] += s.R[i];
    }
  }
  return { rate, sources, mix };
}

const panOf = (p: number) => (p / (FIELD_PANS - 1)) * 2 - 1;
type Raw = FieldAnalyzer['raw'];
/** Analyser overrides, plus the FFT length, for tuning runs. */
export type LabOptions = FieldOptions & { n?: number };

/**
 * Runs one analyser per signal in lockstep at 60 frames a second and hands
 * every frame's raw grids (linear power, before normalising) to `each`.
 */
function sweep(rate: number, signals: { L: Float32Array; R: Float32Array }[], each: (raws: Raw[]) => void, opts: LabOptions = {}, skip = 0.5) {
  const ans = signals.map(() => new FieldAnalyzer(rate, opts.n ?? fieldFftSize(rate), opts));
  const outs = signals.map(() => emptyField());
  const n = ans[0].n;
  const len = signals[0].L.length;
  const fps = 60;
  let ms = 0;
  let count = 0;
  for (let t = n / rate; t * rate <= len; t += 1 / fps) {
    const end = Math.floor(t * rate);
    signals.forEach((sg, i) => {
      const t0 = performance.now();
      ans[i].analyze(sg.L.subarray(end - n, end), sg.R.subarray(end - n, end), 1 / fps, outs[i]);
      ms += performance.now() - t0;
      count++;
    });
    if (t >= skip) each(ans.map((a) => a.raw));
  }
  return { msPerFrame: ms / Math.max(1, count) };
}

interface Tally {
  tone: number;
  hit: number;
  haze: number;
  panSum: number;
  panW: number;
  panNear: number;
  hazePan: number;
  hazePan2: number;
}

const newTally = (): Tally => ({ tone: 0, hit: 0, haze: 0, panSum: 0, panW: 0, panNear: 0, hazePan: 0, hazePan2: 0 });

function addCharacter(t: Tally, c: number, tone: number, hit: number, haze: number) {
  const p = panOf(c % FIELD_PANS);
  t.tone += tone;
  t.hit += hit;
  t.haze += haze;
  t.hazePan += haze * p;
  t.hazePan2 += haze * p * p;
}

function addPan(t: Tally, c: number, direct: number, expect: number) {
  const p = panOf(c % FIELD_PANS);
  t.panSum += direct * p;
  t.panW += direct;
  if (Math.abs(p - expect) <= 0.1 + 1e-9) t.panNear += direct;
}

const pct = (x: number) => Math.round(x * 100);

function row(spec: SourceSpec, t: Tally, spread = true) {
  const total = t.tone + t.hit + t.haze || 1;
  const share = { tone: t.tone / total, hit: t.hit / total, haze: t.haze / total };
  const hazeMean = t.haze > 0 ? t.hazePan / t.haze : 0;
  const pan = spec.kind !== 'haze' && t.panW > 0;
  return {
    suara: spec.name,
    harapan: spec.kind,
    'pan harapan': spec.pan,
    'pan terbaca': pan ? +(t.panSum / t.panW).toFixed(2) : null,
    'pan tepat ±0,1 (%)': pan ? pct(t.panNear / t.panW) : null,
    'nada (%)': pct(share.tone),
    'pukulan (%)': pct(share.hit),
    'kabut (%)': pct(share.haze),
    'sebaran kabut': spread && spec.kind === 'haze' ? +Math.sqrt(Math.max(0, t.hazePan2 / (t.haze || 1) - hazeMean * hazeMean)).toFixed(2) : null,
    benar: share[spec.kind] === Math.max(share.tone, share.hit, share.haze),
  };
}

/**
 * Each sound alone, then the mix. In the mix, each band's energy in each
 * layer is credited to the sounds by what each put into that band and layer
 * when played alone: that measures whether a sound keeps its character among
 * the others (kick against bass, keys against the pad). Pan in the mix is read
 * only from the bands one sound dominates (80% of the energy there when
 * played alone), so it is measured, not credited.
 */
export function report(r: Rendered = render(), opts: LabOptions = {}) {
  const { rate } = r;
  const S = r.sources.length;
  const alone = r.sources.map(() => newTally());
  const mixed = r.sources.map(() => newTally());
  let agree = 0;
  let mixTotal = 0;
  let soloTotal = 0;
  const layers = ['tone', 'hit', 'haze'] as const;
  const bandE = new Float64Array(S);
  const solo = layers.map(() => r.sources.map(() => new Float64Array(FIELD_BANDS)));
  const mixB = layers.map(() => new Float64Array(FIELD_BANDS));
  const timing = sweep(
    rate,
    [...r.sources, r.mix],
    (raws) => {
      const mix = raws[S];
      for (let i = 0; i < S; i++) {
        const raw = raws[i];
        for (let c = 0; c < FIELD_CELLS; c++) {
          addCharacter(alone[i], c, raw.tone[c], raw.hit[c], raw.haze[c]);
          addPan(alone[i], c, raw.tone[c] + raw.hit[c], r.sources[i].spec.pan);
        }
      }
      layers.forEach((layer, l) => {
        for (let i = 0; i < S; i++) solo[l][i].fill(0);
        mixB[l].fill(0);
        for (let c = 0; c < FIELD_CELLS; c++) {
          const b = Math.floor(c / FIELD_PANS);
          mixB[l][b] += mix[layer][c];
          for (let i = 0; i < S; i++) solo[l][i][b] += raws[i][layer][c];
        }
        for (let b = 0; b < FIELD_BANDS; b++) {
          let sum = 0;
          for (let i = 0; i < S; i++) sum += solo[l][i][b];
          const m = mixB[l][b];
          agree += Math.min(m, sum);
          mixTotal += m;
          soloTotal += sum;
          if (m <= 0) continue;
          for (let i = 0; i < S; i++) {
            // A layer no sound had alone here is credited by the sounds' whole energy in the band.
            let w = sum > 0 ? solo[l][i][b] / sum : 0;
            if (sum <= 0) {
              let all = 0;
              let mine = 0;
              for (let j = 0; j < S; j++) {
                const e = solo[0][j][b] + solo[1][j][b] + solo[2][j][b];
                all += e;
                if (j === i) mine = e;
              }
              w = all > 0 ? mine / all : 0;
            }
            if (w <= 0) continue;
            const v = m * w;
            const t = mixed[i];
            t.tone += layer === 'tone' ? v : 0;
            t.hit += layer === 'hit' ? v : 0;
            t.haze += layer === 'haze' ? v : 0;
          }
        }
      });
      for (let b = 0; b < FIELD_BANDS; b++) {
        let sum = 0;
        for (let i = 0; i < S; i++) {
          bandE[i] = solo[0][i][b] + solo[1][i][b] + solo[2][i][b];
          sum += bandE[i];
        }
        if (sum <= 0) continue;
        for (let i = 0; i < S; i++) {
          if (bandE[i] < 0.8 * sum || r.sources[i].spec.kind === 'haze') continue;
          for (let p = 0; p < FIELD_PANS; p++) {
            const c = b * FIELD_PANS + p;
            addPan(mixed[i], c, mix.tone[c] + mix.hit[c], r.sources[i].spec.pan);
          }
        }
      }
    },
    opts,
  );

  const rowsAlone = r.sources.map((s, i) => row(s.spec, alone[i]));
  // In the mix energy is credited per band, so the haze's spread across pan is not known there.
  const rowsMix = r.sources.map((s, i) => row(s.spec, mixed[i], false));
  const score = (rows: ReturnType<typeof row>[]) => `${rows.filter((x) => x.benar).length} dari ${rows.length}`;
  const summary = {
    'sendiri benar': score(rowsAlone),
    'dalam mix benar': score(rowsMix),
    // How much of the mix's layers, band by band, match the sounds' layers alone.
    'kesesuaian mix (%)': pct(agree / Math.max(mixTotal, soloTotal, 1e-30)),
    'ms per analisis': +timing.msPerFrame.toFixed(2),
    grid: `${FIELD_BANDS} band × ${FIELD_PANS} posisi pan`,
  };
  if (typeof console.table === 'function') {
    console.log('Sendiri');
    console.table(rowsAlone);
    console.log('Dalam mix');
    console.table(rowsMix);
    console.table([summary]);
  }
  return { alone: rowsAlone, together: rowsMix, summary };
}

/**
 * Coherence as the analyser measures it, before DIFFUSE_FLOOR: the wide pad
 * should sit low, every direct sound high. A good floor lies between the pad's
 * typical value and the direct sounds' lowest.
 */
export function calibrate(r: Rendered = render(), opts: LabOptions = {}) {
  const direct = r.sources.map(() => 0);
  const total = r.sources.map(() => 0);
  sweep(
    r.rate,
    r.sources,
    (raws) => {
      raws.forEach((raw, i) => {
        for (let c = 0; c < FIELD_CELLS; c++) {
          direct[i] += raw.tone[c] + raw.hit[c];
          total[i] += raw.tone[c] + raw.hit[c] + raw.haze[c];
        }
      });
    },
    { ...opts, diffuseFloor: 0 },
  );
  const rows = r.sources.map((s, i) => ({ suara: s.spec.name, harapan: s.spec.kind, 'koherensi rata-rata': +(direct[i] / (total[i] || 1)).toFixed(2) }));
  if (typeof console.table === 'function') console.table(rows);
  return rows;
}

function wav(L: Float32Array, R: Float32Array, rate: number): Blob {
  const n = L.length;
  const data = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o: number, s: string) => [...s].forEach((ch, i) => data.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  data.setUint32(4, 36 + n * 4, true);
  str(8, 'WAVEfmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 2, true);
  data.setUint32(24, rate, true);
  data.setUint32(28, rate * 4, true);
  data.setUint16(32, 4, true);
  data.setUint16(34, 16, true);
  str(36, 'data');
  data.setUint32(40, n * 4, true);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const g = peak > 0.95 ? 0.95 / peak : 1;
  for (let i = 0; i < n; i++) {
    data.setInt16(44 + i * 4, Math.round(L[i] * g * 32767), true);
    data.setInt16(46 + i * 4, Math.round(R[i] * g * 32767), true);
  }
  return new Blob([data.buffer], { type: 'audio/wav' });
}

/** Adds the test mix to the library as "Lab panggung", 32 s long, to watch with fieldView. */
export async function addTestTrack(seconds = 32) {
  const r = render(48000, seconds);
  const { addFileList } = await import('../store/controller');
  const list = new DataTransfer();
  list.items.add(new File([wav(r.mix.L, r.mix.R, r.rate)], 'Lab panggung.wav', { type: 'audio/wav' }));
  addFileList(list.files);
  return SOURCES.map((s) => ({ suara: s.name, pan: s.pan, jenis: s.kind, wilayah: s.range }));
}
