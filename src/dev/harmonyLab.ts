import { HARMONY_DEFAULTS, harmonyFromChroma, type BeatChroma, type HarmonyParams } from '../analysis/harmony';
import type { ChordSeg, KeyInfo } from '../analysis/types';
import { analyse } from './analysisLab';
import { parseLab, scoreChords, scoreKey, type ChordScore, type RefChord, type RefKey } from './chordBench';

/**
 * Tunes the chord and key detector against annotated recordings.
 *
 * A local server (with CORS) serves `/manifest`: a JSON list of songs, each
 * with paths under the server for the audio, the chord .lab and optionally
 * a key .lab, a set name (an album, say), and optionally `dur` and `refDur`
 * (audio and annotation lengths, for the alignment). Each song is analysed
 * once by the real pipeline; its beat chroma is kept, so the decoding knobs
 * can be tried hundreds of times in seconds. Knobs that change the chroma
 * itself need `rechroma`.
 *
 *   const lab = await import('/src/dev/harmonyLab.ts');
 *   await lab.prepare('http://127.0.0.1:5199');
 *   lab.evaluate({}, 'abbey');            // the current defaults on one set
 *   lab.confusions({}, 'abbey');          // what kind of mistakes
 *   await lab.crossValidate(['abbey', 'revolver', 'pepper', 'queen']);
 *   await lab.tune(lab.SEARCH, { abbey: { majmin: 1, root: 0.5 } });
 *
 * Editing a module the page imports reloads it and empties `state`:
 * `saveCache` first (POST /save/<name>), then `loadCache` (GET /results/<name>).
 *
 * The audio's start can differ from the annotated release by a few seconds
 * (silence, pre-gap); each song is aligned once against its reference with
 * the chroma alone, so the alignment does not favour any setting.
 */

export interface LabEntry {
  song: string;
  set: string;
  audio: string;
  chords: string;
  key?: string | null;
}

interface Song {
  entry: LabEntry;
  ref: { chords: RefChord[]; key: RefKey | null };
  beats: Float32Array;
  barPos: Int8Array;
  duration: number;
  bc: BeatChroma;
  /** Audio time minus reference time, in seconds. */
  offset: number;
  /** How much better the chosen offset fits than no shift (0 when it is no shift). */
  offsetGain: number;
  /** Semitones the chroma had to move to line up: a sign the tuning was read on the wrong side of a quarter tone. */
  transpose?: number;
  /** What the full pipeline gave at prepare time. */
  app: { chords: ChordSeg[]; key: KeyInfo; ms: number };
}

export const state = { base: '', songs: [] as Song[], progress: '', errors: [] as string[], chromaParams: { ...HARMONY_DEFAULTS } };

// A message-channel yield: timers are throttled to once a second or slower in a hidden tab.
const yieldNow = () =>
  new Promise<void>((r) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => r();
    ch.port2.postMessage(0);
  });

/* ------------------------------------------------------------- Chroma -- */

let worker: Worker | null = null;
let jobId = 0;

function chroma(buffer: AudioBuffer, beats: Float32Array, duration: number, params: HarmonyParams): Promise<BeatChroma> {
  worker ??= new Worker(new URL('./harmonyLab.worker.ts', import.meta.url), { type: 'module' });
  const w = worker;
  const id = ++jobId;
  const L = buffer.getChannelData(0).slice();
  const R = buffer.getChannelData(Math.min(1, buffer.numberOfChannels - 1)).slice();
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent<{ id: number; bc?: BeatChroma; error?: string }>) => {
      if (e.data.id !== id) return;
      w.removeEventListener('message', onMsg);
      if (e.data.bc) resolve(e.data.bc);
      else reject(new Error(e.data.error));
    };
    w.addEventListener('message', onMsg);
    w.postMessage({ id, L, R, sampleRate: buffer.sampleRate, beats, duration, params }, [L.buffer, R.buffer]);
  });
}

async function decode(url: string): Promise<AudioBuffer> {
  const data = await (await fetch(url)).arrayBuffer();
  return new OfflineAudioContext(2, 1, 44100).decodeAudioData(data);
}

/* ---------------------------------------------------------- Alignment -- */

const TRIADS = (() => {
  const out: Float64Array[] = [];
  for (let r = 0; r < 12; r++)
    for (const iv of [[0, 4, 7], [0, 3, 7]]) {
      const v = new Float64Array(12);
      for (const i of iv) v[(r + i) % 12] = 1 / Math.sqrt(3);
      out.push(v);
    }
  return out;
})();

function refTemplate(c: RefChord): Float64Array | null {
  if (c.root < 0) return null;
  const iv = c.cls === 'maj' ? [0, 4, 7] : c.cls === 'min' ? [0, 3, 7] : [0, 7];
  const v = new Float64Array(12);
  for (const i of iv) v[(c.root + i) % 12] = 1 / Math.sqrt(iv.length);
  return v;
}

/**
 * The shift that best lines the treble chroma up with the reference chords:
 * per beat, how much better the reference chords under it fit than an
 * average triad, weighted by how long each one lasts within the beat.
 */
function align(bc: BeatChroma, beats: Float32Array, ref: RefChord[], range = 20, step = 0.05) {
  // A song tuned near a quarter tone off can be heard a semitone away from
  // its annotation; the alignment tries that too, so it still finds the time.
  let best = { offset: 0, gain: 0, transpose: 0, score: -Infinity };
  for (const k of [0, -1, 1]) {
    const r = alignAt(bc, beats, ref, range, step, k);
    if (r.score > best.score + 1e-9) best = { ...r, transpose: k };
  }
  return best;
}

function alignAt(bc: BeatChroma, beats: Float32Array, ref: RefChord[], range: number, step: number, transpose: number) {
  const vecs = bc.treble.map((v) => {
    const n = Math.hypot(...v) || 1;
    return Float64Array.from({ length: 12 }, (_, p) => v[(p + transpose + 12) % 12] / n);
  });
  const avg = vecs.map((v) => TRIADS.reduce((a, t) => a + t.reduce((s, x, p) => s + x * v[p], 0), 0) / TRIADS.length);
  const tpl = ref.map(refTemplate);
  const n = beats.length;
  const beatLen = n > 1 ? (beats[n - 1] - beats[0]) / (n - 1) : 0.5;
  const scoreAt = (d: number) => {
    let s = 0;
    let j = 0;
    for (let i = 0; i < n; i++) {
      const a = beats[i] - d;
      const b = (i + 1 < n ? beats[i + 1] : beats[i] + beatLen) - d;
      while (j < ref.length && ref[j].end <= a) j++;
      for (let k = j; k < ref.length && ref[k].t < b; k++) {
        const t = tpl[k];
        if (!t) continue;
        const ov = Math.min(b, ref[k].end) - Math.max(a, ref[k].t);
        if (ov <= 0) continue;
        let dot = 0;
        for (let p = 0; p < 12; p++) dot += t[p] * vecs[i][p];
        s += ov * (dot - avg[i]);
      }
    }
    return s;
  };
  let best = 0;
  let bestScore = scoreAt(0);
  const zero = bestScore;
  for (let d = -range; d <= range + 1e-9; d += step) {
    const s = scoreAt(d);
    if (s > bestScore + 1e-9) {
      bestScore = s;
      best = Math.round(d * 100) / 100;
    }
  }
  return { offset: best, gain: zero !== 0 ? bestScore / zero - 1 : 0, score: bestScore };
}

const shift = (chords: ChordSeg[], d: number) => (d ? chords.map((c) => ({ ...c, t: c.t - d, end: c.end - d })) : chords);

/* ------------------------------------------------------------ Prepare -- */

/** Analyses every song in the manifest once (skips the ones already in). */
export async function prepare(base = 'http://127.0.0.1:5199', only?: (e: LabEntry) => boolean, manifest = 'manifest') {
  state.base = base;
  const list = ((await (await fetch(`${base}/${manifest}`)).json()) as LabEntry[]).filter(only ?? (() => true));
  let i = 0;
  for (const e of list) {
    i++;
    if (state.songs.some((s) => s.entry.song === e.song)) continue;
    state.progress = `${i}/${list.length} ${e.song}`;
    try {
      const [buffer, chordText, keyText] = await Promise.all([
        decode(`${base}/${e.audio}`),
        e.chords ? fetch(`${base}/${e.chords}`).then((r) => r.text()) : Promise.resolve(''),
        e.key ? fetch(`${base}/${e.key}`).then((r) => r.text()) : Promise.resolve(''),
      ]);
      const ref = parseLab(chordText);
      if (keyText) ref.key = parseLab(keyText).key ?? ref.key;
      await addSong(e, buffer, ref);
    } catch (err) {
      state.errors.push(`${e.song}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  state.progress = 'selesai';
  return { songs: state.songs.length, errors: state.errors };
}

/** One song from a decoded buffer and its reference (empty chords for a song with no annotation). */
export async function addSong(entry: LabEntry, buffer: AudioBuffer, ref: { chords: RefChord[]; key: RefKey | null }) {
  const a = await analyse(buffer);
  const d0 = a.downbeats[0] ?? 0;
  const barPos = Int8Array.from(a.beats, (_, k) => (((k - d0) % 4) + 4) % 4);
  const bc = await chroma(buffer, a.beats, a.duration, state.chromaParams);
  const { offset, gain, transpose } = ref.chords.length && entry.set !== 'synth' ? alignEntry(entry, bc, a.beats, ref.chords) : { offset: 0, gain: 0, transpose: 0 };
  state.songs.push({
    entry,
    ref,
    beats: a.beats,
    barPos,
    duration: a.duration,
    bc,
    offset,
    offsetGain: gain,
    transpose,
    app: { chords: a.chords, key: a.key, ms: a.elapsedMs },
  });
}

/**
 * With both lengths in the manifest (`dur`, `refDur`), the search is limited
 * to their difference plus 3 s: a repetitive song can otherwise line up a few
 * bars off.
 */
function alignEntry(entry: LabEntry, bc: BeatChroma, beats: Float32Array, chords: RefChord[]) {
  const e = entry as LabEntry & { dur?: number; refDur?: number };
  return align(bc, beats, chords, e.dur && e.refDur ? Math.abs(e.dur - e.refDur) + 3 : 20);
}

/**
 * Synthetic songs with known chords (pads, bass, drums from analysisLab):
 * a check that tuning on real recordings does not break the clean case.
 */
export async function prepareSynth() {
  const { synth } = await import('./analysisLab');
  const P: [number, '' | 'm'][][] = [
    [[0, ''], [7, ''], [9, 'm'], [5, '']],
    [[9, 'm'], [5, ''], [0, ''], [7, '']],
    [[2, ''], [9, ''], [11, 'm'], [7, '']],
    [[4, 'm'], [0, ''], [7, ''], [2, '']],
    [[7, ''], [4, 'm'], [0, ''], [2, '']],
    [[5, ''], [10, ''], [0, ''], [5, '']],
    [[2, 'm'], [7, ''], [0, ''], [9, 'm']],
    [[11, 'm'], [7, ''], [2, ''], [9, '']],
    [[3, ''], [10, ''], [0, 'm'], [8, '']],
    [[1, 'm'], [9, ''], [4, ''], [11, '']],
    [[6, ''], [1, ''], [3, 'm'], [11, '']],
    [[8, ''], [5, 'm'], [1, ''], [3, '']],
  ];
  const tempos = [72, 84, 96, 104, 112, 120, 128, 136, 90, 100, 116, 140];
  for (let n = 0; n < P.length; n++) {
    const song = `synth ${n + 1}`;
    if (state.songs.some((s) => s.entry.song === song)) continue;
    state.progress = `${song}/${P.length}`;
    const bpm = tempos[n];
    const bars = 24;
    const bar = (60 / bpm) * 4;
    const chords: RefChord[] = [{ t: 0, end: 0.1, root: -1, cls: 'N' }];
    for (let b = 0; b < bars; b++) {
      const [root, q] = P[n][b % 4];
      chords.push({ t: 0.1 + b * bar, end: 0.1 + (b + 1) * bar, root, cls: q === 'm' ? 'min' : 'maj' });
    }
    const [r0, q0] = P[n][0];
    await addSong({ song, set: 'synth', audio: '', chords: '' }, await synth({ bpm, progression: P[n], bars }), { chords, key: { tonic: r0, mode: q0 === 'm' ? 'minor' : 'major' } });
  }
  state.progress = 'selesai';
}

/** How far two settings disagree on songs without a reference: share of time on the same chord, and keys that changed. */
export function compare(a: Partial<HarmonyParams>, b: Partial<HarmonyParams>, set?: string) {
  const pa = { ...HARMONY_DEFAULTS, ...a };
  const pb = { ...HARMONY_DEFAULTS, ...b };
  return pick(set).map((s) => {
    const ha = harmonyFromChroma(s.bc, s.beats, s.barPos, s.duration, pa);
    const hb = harmonyFromChroma(s.bc, s.beats, s.barPos, s.duration, pb);
    const asRef: RefChord[] = ha.chords.map((c) => ({ t: c.t, end: c.end, root: c.root, cls: c.quality }));
    const sc = scoreChords(hb.chords, asRef);
    return {
      song: s.entry.song,
      sameChords: Math.round((1000 * sc.majminRight) / (sc.majminTotal || 1)) / 10,
      key: `${keyText(ha.key)} → ${keyText(hb.key)}`,
      conf: `${Math.round(100 * ha.key.confidence)}% → ${Math.round(100 * hb.key.confidence)}%`,
    };
  });
}

/** Recomputes the beat chroma with other chroma knobs (partialDecay). Slow: decodes every song again. */
export async function rechroma(p: Partial<HarmonyParams>) {
  state.chromaParams = { ...HARMONY_DEFAULTS, ...p };
  let i = 0;
  for (const s of state.songs) {
    state.progress = `rechroma ${++i}/${state.songs.length}`;
    s.bc = await chroma(await decode(`${state.base}/${s.entry.audio}`), s.beats, s.duration, state.chromaParams);
  }
  state.progress = 'selesai';
}

/* ----------------------------------------------------------- Evaluate -- */

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const keyText = (k: RefKey) => `${NAMES[k.tonic]}${k.mode === 'minor' ? 'm' : ''}`;
const pick = (set?: string) => state.songs.filter((s) => !set || s.entry.set === set);

export interface Totals {
  songs: number;
  root: number;
  majmin: number;
  key: number;
  objective: number;
}

/** Root and maj/min accuracy (share of reference time) and the mean MIREX key score. */
export function evaluate(p: Partial<HarmonyParams> = {}, set?: string, perSong = false) {
  const params = { ...HARMONY_DEFAULTS, ...p };
  const sum: ChordScore = { rootTotal: 0, rootRight: 0, majminTotal: 0, majminRight: 0 };
  let keySum = 0;
  let keyN = 0;
  const rows: Record<string, string | number>[] = [];
  for (const s of pick(set)) {
    const h = harmonyFromChroma(s.bc, s.beats, s.barPos, s.duration, params);
    const sc = scoreChords(shift(h.chords, s.offset), s.ref.chords);
    sum.rootTotal += sc.rootTotal;
    sum.rootRight += sc.rootRight;
    sum.majminTotal += sc.majminTotal;
    sum.majminRight += sc.majminRight;
    const k = s.ref.key ? scoreKey(h.key, s.ref.key) : null;
    if (k) {
      keySum += k.score;
      keyN++;
    }
    if (perSong)
      rows.push({
        song: s.entry.song,
        root: Math.round((1000 * sc.rootRight) / sc.rootTotal) / 10,
        majmin: Math.round((1000 * sc.majminRight) / sc.majminTotal) / 10,
        key: s.ref.key ? `${keyText(h.key)} vs ${keyText(s.ref.key)}: ${k!.verdict}` : keyText(h.key),
        offset: s.offset,
      });
  }
  const root = sum.rootRight / (sum.rootTotal || 1);
  const majmin = sum.majminRight / (sum.majminTotal || 1);
  const key = keySum / (keyN || 1);
  const totals: Totals = { songs: pick(set).length, root, majmin, key, objective: majmin + 0.5 * root + 0.25 * key };
  return perSong ? { totals, rows } : { totals };
}

/** The pipeline's own output from prepare time, scored the same way (to check the lab matches the app). */
export function evaluateApp(set?: string) {
  const sum: ChordScore = { rootTotal: 0, rootRight: 0, majminTotal: 0, majminRight: 0 };
  let keySum = 0;
  let keyN = 0;
  for (const s of pick(set)) {
    const sc = scoreChords(shift(s.app.chords, s.offset), s.ref.chords);
    sum.rootTotal += sc.rootTotal;
    sum.rootRight += sc.rootRight;
    sum.majminTotal += sc.majminTotal;
    sum.majminRight += sc.majminRight;
    if (s.ref.key) {
      keySum += scoreKey(s.app.key, s.ref.key).score;
      keyN++;
    }
  }
  return { root: sum.rootRight / sum.rootTotal, majmin: sum.majminRight / sum.majminTotal, key: keySum / (keyN || 1) };
}

/* --------------------------------------------------------- Confusions -- */

/**
 * Seconds of reference time by kind of outcome: right, wrong quality,
 * wrong root by interval, a chord heard in silence, silence where a chord
 * plays; and how much of the wrong time sits right at a chord change.
 */
export function confusions(p: Partial<HarmonyParams> = {}, set?: string) {
  const params = { ...HARMONY_DEFAULTS, ...p };
  const kinds = new Map<string, number>();
  const add = (k: string, d: number) => kinds.set(k, (kinds.get(k) ?? 0) + d);
  let total = 0;
  let nearChange = 0;
  const keys: Record<string, number> = {};
  for (const s of pick(set)) {
    const h = harmonyFromChroma(s.bc, s.beats, s.barPos, s.duration, params);
    const est = shift(h.chords, s.offset);
    if (s.ref.key) {
      const v = scoreKey(h.key, s.ref.key).verdict;
      keys[v] = (keys[v] ?? 0) + 1;
    }
    // Sample the reference every 50 ms.
    let j = 0;
    for (const r of s.ref.chords) {
      if (r.cls === 'X') continue;
      for (let t = r.t + 0.025; t < r.end; t += 0.05) {
        while (j < est.length && est[j].end <= t) j++;
        const e = j < est.length && est[j].t <= t ? est[j] : null;
        total += 0.05;
        let kind: string;
        if (r.cls === 'N') kind = e ? 'akor di bagian tanpa akor' : 'benar';
        else if (!e) kind = 'tanpa akor padahal ada akor';
        else if (e.root === r.root) kind = r.cls === 'other' || e.quality === r.cls ? 'benar' : `root benar, ${r.cls === 'maj' ? 'mayor terbaca minor' : 'minor terbaca mayor'}`;
        else {
          const iv = (e.root - r.root + 12) % 12;
          const name = ['', '+1 smt', '+2 (II)', '+3', '+4', '+5 (IV)', 'tritone', '+7 (V)', '+8', '+9', '+10', '-1 smt'][iv];
          const rel = (r.cls === 'maj' && iv === 9 && e.quality === 'min') || (r.cls === 'min' && iv === 3 && e.quality === 'maj');
          const third = (r.cls === 'maj' && iv === 4 && e.quality === 'min') || (r.cls === 'min' && iv === 8 && e.quality === 'maj');
          kind = rel ? 'root salah: relatif (C↔Am)' : third ? 'root salah: akor terts (C→Em, Am→F)' : `root salah: ${name}`;
        }
        add(kind, 0.05);
        if (kind !== 'benar' && (t - r.t < 0.35 || r.end - t < 0.35)) nearChange += 0.05;
      }
      j = 0;
    }
  }
  const table = [...kinds.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, d]) => ({ kind, pct: Math.round((1000 * d) / total) / 10 }));
  const wrong = total - (kinds.get('benar') ?? 0);
  return { table, wrongNearChange: Math.round((1000 * nearChange) / (wrong || 1)) / 10, keys };
}

/* --------------------------------------------------------------- Tune -- */

export type Search = Partial<Record<Exclude<keyof HarmonyParams, 'changeCost'>, number[]>> & { changeCost?: number[][] };
/** What to maximise: per set, a weight on each measure. */
export type Goal = Record<string, { majmin?: number; root?: number; key?: number }>;
export const CHORDS_GOAL: Goal = { train: { majmin: 1, root: 0.5 } };

function score(p: HarmonyParams, goal: Goal) {
  let v = 0;
  const parts: string[] = [];
  for (const [set, w] of Object.entries(goal)) {
    const t = evaluate(p, set).totals;
    v += (w.majmin ?? 0) * t.majmin + (w.root ?? 0) * t.root + (w.key ?? 0) * t.key;
    parts.push(`${set}: root ${(100 * t.root).toFixed(2)} majmin ${(100 * t.majmin).toFixed(2)} key ${(100 * t.key).toFixed(1)}`);
  }
  return { v, text: `obj ${v.toFixed(4)} | ${parts.join(' | ')}` };
}

/**
 * Candidate values per decoding knob, the ones the shipped defaults were
 * chosen from. changeCost is searched as whole shapes: downbeat d, other
 * beats o, beat 3 o or 0.6·o.
 */
export const SEARCH: Search = {
  bassFit: [0.35, 0.5, 0.7, 1, 1.4],
  bassTones: [0.15, 0.3, 0.5, 0.7],
  seventhCost: [-0.1, -0.06, -0.03, 0, 0.03],
  noChord: [0.55, 0.7, 0.85, 1],
  flatNoChord: [0, 2, 4, 8],
  flatPivot: [0.4, 0.45, 0.5],
  silence: [0.002, 0.005, 0.01, 0.03, 0.08],
  keyPrior: [0, 0.06, 0.12, 0.2],
  typeChange: [0, 0.02, 0.05],
  changeCost: [0.2, 0.3, 0.4, 0.55].flatMap((d) => [0.3, 0.4, 0.5, 0.66].flatMap((o) => [1, 0.6].map((m) => [d, o, o * m, o]))),
};
export const CHANGE_SCALES = [0.4, 0.6, 0.8, 1, 1.25, 1.6, 2.2];

export const tuneState = { running: false, log: [] as string[], best: { ...HARMONY_DEFAULTS } as HarmonyParams };

/**
 * Coordinate search: one knob at a time, keep the value that scores best,
 * repeat. Without candidates for changeCost, it is searched as a scale on
 * the default shape.
 */
export async function tune(search: Search = SEARCH, goal: Goal = CHORDS_GOAL, rounds = 3, start: Partial<HarmonyParams> = {}) {
  tuneState.running = true;
  tuneState.log = [];
  let best: HarmonyParams = { ...HARMONY_DEFAULTS, ...start };
  let bestS = score(best, goal);
  tuneState.log.push(`awal: ${bestS.text}`);
  for (let round = 0; round < rounds; round++) {
    let moved = false;
    const knobs = [...new Set([...Object.keys(search), 'changeCost'])] as (keyof HarmonyParams)[];
    for (const k of knobs) {
      const values: unknown[] =
        k === 'changeCost' ? (search.changeCost ?? CHANGE_SCALES.map((f) => HARMONY_DEFAULTS.changeCost.map((c) => c * f))) : (search[k] as number[]);
      for (const v of values) {
        const cand = { ...best, [k]: v } as HarmonyParams;
        const s = score(cand, goal);
        if (s.v > bestS.v + 1e-5) {
          best = cand;
          bestS = s;
          moved = true;
          tuneState.log.push(`r${round} ${k}=${JSON.stringify(v)}: ${s.text}`);
        }
        await yieldNow();
      }
    }
    if (!moved) break;
  }
  tuneState.best = best;
  tuneState.running = false;
  return { best, log: tuneState.log };
}

/**
 * Leave one set out: for each set, tunes on all the others and scores the
 * one left out, starting from `start`. The held-out gain is what a new
 * album can expect; the gain on the tuned sets flatters.
 */
export async function crossValidate(sets: string[], search: Search = SEARCH, rounds = 2, start: Partial<HarmonyParams> = {}, weights = { majmin: 1, root: 0.5 }) {
  const folds = [];
  for (const held of sets) {
    const goal: Goal = Object.fromEntries(sets.filter((s) => s !== held).map((s) => [s, weights]));
    const { best } = await tune(search, goal, rounds, start);
    folds.push({ held, best, before: evaluate(start, held).totals, after: evaluate(best, held).totals });
  }
  return folds;
}

/* --------------------------------------------------------------- Save -- */

/** Writes a JSON result through the bench server (POST /save/name). */
export async function save(name: string, data: unknown) {
  await fetch(`${state.base}/save/${name}`, { method: 'POST', body: JSON.stringify(data, null, 1) });
}

/**
 * Keeps the prepared songs on disk through the bench server, so a page
 * reload (an HMR full reload after editing a module) does not cost a rerun.
 */
export async function saveCache(name = 'lab-cache.json') {
  const round = (a: ArrayLike<number>) => Array.from(a, (v) => Math.round(v * 1e5) / 1e5);
  await save(
    name,
    state.songs.map((s) => ({
      ...s,
      beats: Array.from(s.beats),
      barPos: Array.from(s.barPos),
      bc: { bass: s.bc.bass.map(round), treble: s.bc.treble.map(round), level: s.bc.level },
    })),
  );
}

export async function loadCache(base = 'http://127.0.0.1:5199', name = 'lab-cache.json') {
  state.base = base;
  const rows = (await (await fetch(`${base}/results/${name}`)).json()) as (Omit<Song, 'beats' | 'barPos' | 'bc'> & {
    beats: number[];
    barPos: number[];
    bc: { bass: number[][]; treble: number[][]; level: number[] };
  })[];
  for (const r of rows) {
    if (state.songs.some((s) => s.entry.song === r.entry.song)) continue;
    state.songs.push({
      ...r,
      beats: Float32Array.from(r.beats),
      barPos: Int8Array.from(r.barPos),
      bc: { bass: r.bc.bass.map((v) => Float64Array.from(v)), treble: r.bc.treble.map((v) => Float64Array.from(v)), level: r.bc.level },
    });
  }
  return state.songs.length;
}

/** Aligns every song again (after the alignment changed, for songs from an older cache). */
export function realign() {
  for (const s of state.songs) {
    if (!s.ref.chords.length || s.entry.set === 'synth') continue;
    const { offset, gain, transpose } = alignEntry(s.entry, s.bc, s.beats, s.ref.chords);
    s.offset = offset;
    s.offsetGain = gain;
    s.transpose = transpose;
  }
}

export function offsets() {
  return state.songs.map((s) => ({ song: s.entry.song, offset: s.offset, gain: Math.round(s.offsetGain * 1000) / 10, transpose: s.transpose ?? 0 }));
}
