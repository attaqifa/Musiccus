/*
 * Reactivity lab: measures how much the visual features move on the same
 * music as a dynamic mix and as a loudness-war master (heavy compression and
 * clipping, like most commercial releases). Not imported by the app; load it
 * from the dev console:
 *
 *   const lab = await import('/src/dev/reactivityLab.ts');
 *   await lab.offlineReport();   // renders both versions offline: no playback needed
 *
 * offlineReport() runs the real meter worklet and the real level trackers on
 * an offline render, so it is fast, repeatable and independent of the UI.
 * The live variant plays the tracks through the app:
 *
 *   await lab.addTestTracks();   // adds "Lab dinamis" and "Lab master padat"
 *   await lab.compare(16);       // plays each for 16 s and prints the table
 *
 * Rerun after touching the feature code in src/audio/hub.ts or the onset
 * detector in public/worklets/meter-processor.js.
 */
import { engine } from '../audio/engine';
import { FluxTracker, LevelTracker } from '../audio/features';
import { hub } from '../audio/hub';
import { addFileList, playQueue } from '../store/controller';
import { getState } from '../store/player';
import { synth } from './analysisLab';

/** Loudness-war mastering: +16 dB into a fast compressor, then a soft clipper. */
export async function master(src: AudioBuffer): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: src.length, sampleRate: src.sampleRate });
  const s = ctx.createBufferSource();
  s.buffer = src;
  const drive = ctx.createGain();
  drive.gain.value = Math.pow(10, 16 / 20);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 3;
  comp.ratio.value = 12;
  comp.attack.value = 0.002;
  comp.release.value = 0.06;
  const clip = ctx.createWaveShaper();
  const curve = new Float32Array(2048);
  for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / (curve.length - 1)) * 2 - 1) * 2.2) / Math.tanh(2.2);
  clip.curve = curve;
  clip.oversample = '4x';
  s.connect(drive).connect(comp).connect(clip).connect(ctx.destination);
  s.start();
  const out = await ctx.startRendering();
  // Normalise to -0.3 dBFS like a commercial master.
  let peak = 0;
  for (let c = 0; c < 2; c++) for (const v of out.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
  const g = Math.pow(10, -0.3 / 20) / Math.max(peak, 1e-6);
  for (let c = 0; c < 2; c++) {
    const d = out.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
  return out;
}

/** Peak-to-RMS ratio in dB: about 18–20 for a dynamic mix, 6–9 for a loud master. */
export function crestDb(b: AudioBuffer): number {
  let peak = 0;
  let sum = 0;
  let n = 0;
  for (let c = 0; c < b.numberOfChannels; c++) {
    for (const v of b.getChannelData(c)) {
      peak = Math.max(peak, Math.abs(v));
      sum += v * v;
      n++;
    }
  }
  return 20 * Math.log10(peak / Math.sqrt(sum / n));
}

function wav(b: AudioBuffer): Blob {
  const n = b.length;
  const data = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o: number, s: string) => [...s].forEach((ch, i) => data.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  data.setUint32(4, 36 + n * 4, true);
  str(8, 'WAVEfmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 2, true);
  data.setUint32(24, b.sampleRate, true);
  data.setUint32(28, b.sampleRate * 4, true);
  data.setUint16(32, 4, true);
  data.setUint16(34, 16, true);
  str(36, 'data');
  data.setUint32(40, n * 4, true);
  const L = b.getChannelData(0);
  const R = b.getChannelData(1);
  for (let i = 0; i < n; i++) {
    data.setInt16(44 + i * 4, Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), true);
    data.setInt16(46 + i * 4, Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), true);
  }
  return new Blob([data.buffer], { type: 'audio/wav' });
}

const BPM = 124;
const BARS = 24;
const INTRO = 2;

const testSong = () => synth({ bpm: BPM, progression: [[9, 'm'], [5, ''], [0, ''], [7, '']], bars: BARS, rate: 48000, introBars: INTRO });

/** When the test song's drums actually hit (see synth() in analysisLab.ts). */
function truth() {
  const beat = 60 / BPM;
  const bar = beat * 4;
  const kick: number[] = [];
  const snare: number[] = [];
  const hat: number[] = [];
  for (let b = INTRO; b < BARS; b++) {
    for (let i = 0; i < 4; i++) {
      const t = 0.1 + b * bar + i * beat;
      kick.push(t);
      if (i % 2 === 1) snare.push(t);
      hat.push(t, t + beat / 2);
    }
  }
  return { kick, snare, hat };
}

interface Onset {
  band: number;
  t: number;
  s: number;
}

/** Runs the app's meter worklet over a buffer offline and collects its onsets. */
export async function offlineOnsets(buffer: AudioBuffer, worklet = '/worklets/meter-processor.js'): Promise<Onset[]> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: buffer.length, sampleRate: buffer.sampleRate });
  await ctx.audioWorklet.addModule(worklet);
  const node = new AudioWorkletNode(ctx, 'musiccus-meter', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 2,
    channelCountMode: 'explicit',
  });
  const out: Onset[] = [];
  node.port.onmessage = (e) => {
    if (e.data.type === 'onset') out.push({ band: e.data.band, t: e.data.t, s: e.data.s });
  };
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(node).connect(ctx.destination);
  src.start();
  await ctx.startRendering();
  // Messages posted during rendering are still in flight.
  await new Promise((r) => setTimeout(r, 300));
  return out;
}

/** Recall (hits found) and precision (detections that were real) within 35 ms. */
function score(found: number[], real: number[]) {
  const used = new Set<number>();
  let hits = 0;
  for (const t of found) {
    let best = -1;
    for (let i = 0; i < real.length; i++) {
      if (used.has(i) || Math.abs(real[i] - t) >= 0.035) continue;
      if (best < 0 || Math.abs(real[i] - t) < Math.abs(real[best] - t)) best = i;
    }
    if (best >= 0) {
      used.add(best);
      hits++;
    }
  }
  return { recall: +(hits / real.length).toFixed(2), precision: found.length ? +(hits / found.length).toFixed(2) : 0 };
}

/** Onset quality per drum, as the hub uses it: kicks need s >= 0.5 to fire a shockwave. */
export function scoreOnsets(onsets: Onset[]) {
  const t = truth();
  const pick = (band: number, min: number) => onsets.filter((o) => o.band === band && o.s >= min).map((o) => o.t);
  return { kick: score(pick(0, 0.5), t.kick), snare: score(pick(1, 0.3), t.snare), hat: score(pick(2, 0.3), t.hat) };
}

const REGIONS: [number, number][] = [
  [20, 60],
  [60, 250],
  [250, 500],
  [500, 2000],
  [2000, 6000],
  [6000, 20000],
];

/**
 * Feeds an offline analyser (same FFT size as the app) into the app's level
 * trackers at 60 frames a second, and reports how far each feature moves,
 * with the old measure (presence only) next to the new one.
 */
export async function offlineFeatures(buffer: AudioBuffer, from = 6, to = 40) {
  const rate = buffer.sampleRate;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(to * rate), sampleRate: rate });
  const an = ctx.createAnalyser();
  an.fftSize = 8192;
  an.smoothingTimeConstant = 0;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(an).connect(ctx.destination);
  src.start();
  const bins = new Float32Array(an.frequencyBinCount);
  const hz = rate / an.fftSize;
  const names = ['sub', 'bass', 'lowMid', 'mid', 'presence', 'air', 'energy'];
  const trackers = names.map(() => new LevelTracker());
  const flux = new FluxTracker(256);
  const logBand = new Float32Array(256);
  const series: Record<string, number[]> = {};
  for (const n of names) series[n] = [];
  for (const n of names) series[`${n}Old`] = [];
  series.pulse = [];
  const dt = 1 / 60;
  const dbOf = (lo: number, hi: number) => {
    let p = 0;
    let c = 0;
    for (let k = Math.max(1, Math.floor(lo / hz)); k <= Math.min(bins.length - 1, Math.ceil(hi / hz)); k++) {
      p += Math.pow(10, bins[k] / 10);
      c++;
    }
    return 10 * Math.log10(p / Math.max(1, c) + 1e-20);
  };
  for (let f = 1; f * dt < to - 0.05; f++) {
    const time = f * dt;
    void ctx.suspend(time).then(() => {
      an.getFloatFrequencyData(bins);
      const dbs = [...REGIONS.map(([a, b]) => dbOf(a, b)), dbOf(20, 20000)];
      for (let j = 0; j < 256; j++) {
        const fc = 20 * Math.pow(1000, j / 255);
        logBand[j] = bins[Math.min(bins.length - 1, Math.round(fc / hz))];
      }
      const p = flux.update(logBand, dt);
      dbs.forEach((db, i) => {
        const v = trackers[i].update(db, dt);
        if (time >= from) {
          series[names[i]].push(v);
          series[`${names[i]}Old`].push(trackers[i].presence);
        }
      });
      if (time >= from) series.pulse.push(p);
      void ctx.resume();
    });
  }
  await ctx.startRendering();
  const stat = (v: number[]) => {
    const sorted = [...v].sort((a, b) => a - b);
    const q = (x: number) => sorted[Math.min(sorted.length - 1, Math.floor(x * sorted.length))];
    return { mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2), range: +(q(0.95) - q(0.05)).toFixed(2) };
  };
  return Object.fromEntries(Object.entries(series).map(([k, v]) => [k, stat(v)]));
}

/** Both versions of the test song, scored offline. Prints and returns the tables. */
export async function offlineReport(worklet?: string) {
  const song = await testSong();
  const loud = await master(song);
  const onsets = { dinamis: scoreOnsets(await offlineOnsets(song, worklet)), master: scoreOnsets(await offlineOnsets(loud, worklet)) };
  const fd = await offlineFeatures(song);
  const fm = await offlineFeatures(loud);
  const drums = (['kick', 'snare', 'hat'] as const).map((k) => ({
    drum: k,
    'dinamis recall': onsets.dinamis[k].recall,
    'dinamis presisi': onsets.dinamis[k].precision,
    'master recall': onsets.master[k].recall,
    'master presisi': onsets.master[k].precision,
  }));
  const features = Object.keys(fd)
    .filter((k) => !k.endsWith('Old'))
    .map((k) => ({
      fitur: k,
      'dinamis lama': fd[`${k}Old`]?.range ?? null,
      'dinamis baru': fd[k].range,
      'master lama': fm[`${k}Old`]?.range ?? null,
      'master baru': fm[k].range,
      'master rata-rata lama': fm[`${k}Old`]?.mean ?? null,
      'master rata-rata baru': fm[k].mean,
    }));
  console.table(drums);
  console.table(features);
  return { crest: { dinamis: +crestDb(song).toFixed(1), master: +crestDb(loud).toFixed(1) }, drums, features };
}

/** Adds the same song twice: as a dynamic mix and as a loud master. */
export async function addTestTracks() {
  const song = await testSong();
  const loud = await master(song);
  const list = new DataTransfer();
  list.items.add(new File([wav(song)], 'Lab dinamis.wav', { type: 'audio/wav' }));
  list.items.add(new File([wav(loud)], 'Lab master padat.wav', { type: 'audio/wav' }));
  addFileList(list.files);
  return { crestDynamic: +crestDb(song).toFixed(1), crestMaster: +crestDb(loud).toFixed(1) };
}

interface Stats {
  [k: string]: number;
}

const KEYS = ['sub', 'bass', 'mid', 'energy', 'pulse'] as const;

/** Plays the named track from 4 s in and records how the features move. */
export async function measure(name: string, seconds = 16): Promise<Stats> {
  const st = getState();
  const id = st.order.find((i) => st.tracks[i].name === name);
  if (!id) throw new Error(`Track ${name} not found; run addTestTracks() first`);
  await playQueue([id], 0, 4);
  await new Promise((r) => setTimeout(r, 1500));
  const series: Record<string, number[]> = Object.fromEntries(KEYS.map((k) => [k, []]));
  // Hits are counted from the detector's own messages; kicks as the hub
  // counts them (strong enough to fire a shockwave).
  let kicks = 0;
  let snares = 0;
  let hats = 0;
  const offOnset = engine.on('onset', (o) => {
    if (o.band === 0 && o.s >= 0.5) kicks++;
    else if (o.band === 1) snares++;
    else if (o.band === 2) hats++;
  });
  const un = hub.subscribe((s) => {
    const f = s.features as unknown as Record<string, number>;
    for (const k of KEYS) series[k].push(f[k] ?? NaN);
  });
  await new Promise((r) => setTimeout(r, seconds * 1000));
  un();
  offOnset();
  const out: Stats = { kicksPerBar: +((kicks / seconds) * (4 * 60) / 124).toFixed(2), snaresPerBar: +((snares / seconds) * (4 * 60) / 124).toFixed(2), hatsPerBar: +((hats / seconds) * (4 * 60) / 124).toFixed(2) };
  for (const k of KEYS) {
    const v = series[k].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) continue;
    const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
    out[`${k}Mean`] = +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2);
    // Movement: the spread between quiet and loud moments of the feature.
    out[`${k}Range`] = +(q(0.95) - q(0.05)).toFixed(2);
  }
  return out;
}

/** Measures both test tracks and prints them side by side. */
export async function compare(seconds = 16) {
  const dyn = await measure('Lab dinamis.wav', seconds);
  const loud = await measure('Lab master padat.wav', seconds);
  const rows = Object.keys(dyn).map((k) => ({ fitur: k, dinamis: dyn[k], 'master padat': loud[k] }));
  console.table(rows);
  return rows;
}
