import { del, get, set } from 'idb-keyval';
import { getState, setAnalysisStatus, usePlayer, type AnalysisStatus, type Track } from '../store/player';
import { chordsFor, type ChordView } from './chordView';
import * as fx from './fixes';
import { ANALYSIS_VERSION, type Analysis, type AnalysisJob, type KeyInfo, type WorkerMessage } from './types';

interface Job {
  track: Track;
  buffer: AudioBuffer;
  resampled: boolean;
  key: string;
  /** Resolves once the file's corrections are loaded. */
  fixed: Promise<void>;
}

/** What the algorithm heard (and the cache holds), and below it the same with the listener's corrections. */
const raw = new Map<string, Analysis>();
const results = new Map<string, Analysis>();
const fixes = new Map<string, fx.Fix>();
const fixIds = new Map<string, string>();
const fixLoads = new Map<string, Promise<void>>();
const cacheKeys = new Map<string, string>();
const queued: Job[] = [];
const inFlight = new Set<string>();
let running: { id: number; job: Job } | null = null;
let worker: Worker | null = null;
let seq = 0;

export function getAnalysis(trackId: string | undefined): Analysis | undefined {
  return trackId ? results.get(trackId) : undefined;
}

/** React hook: the analysis for a track plus its live status. */
export function useAnalysis(trackId: string | undefined): { analysis?: Analysis; status?: AnalysisStatus } {
  const status = usePlayer((s) => (trackId ? s.analysis[trackId] : undefined));
  return { analysis: getAnalysis(trackId), status };
}

async function cacheKey(t: Track, rate: number): Promise<string> {
  if (t.synth) return `analysis:${ANALYSIS_VERSION}:${t.id}:${rate}`;
  const file = t.file ?? (t.handle ? await t.handle.getFile() : undefined);
  return `analysis:${ANALYSIS_VERSION}:${t.path}|${file?.size ?? 0}|${file?.lastModified ?? 0}|${rate}`;
}

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
    const msg = e.data;
    if (!running || msg.id !== running.id) return;
    const { job } = running;
    if (msg.type === 'progress') {
      setAnalysisStatus(job.track.id, { state: 'running', stage: msg.stage, progress: msg.p });
      return;
    }
    if (msg.type === 'done') {
      const id = job.track.id;
      raw.set(id, msg.result);
      cacheKeys.set(id, job.key);
      void set(job.key, msg.result).catch(() => undefined);
      void job.fixed.then(() => {
        publish(id);
        setAnalysisStatus(id, { state: 'done', stage: 'Selesai', progress: 1 });
      });
    } else {
      setAnalysisStatus(job.track.id, { state: 'error', stage: 'Gagal', progress: 0, error: msg.message });
    }
    inFlight.delete(job.track.id);
    running = null;
    pump();
  };
  worker.onerror = () => {
    if (running) {
      setAnalysisStatus(running.job.track.id, { state: 'error', stage: 'Gagal', progress: 0, error: 'Worker analisis berhenti.' });
      inFlight.delete(running.job.track.id);
    }
    running = null;
    worker?.terminate();
    worker = null;
    pump();
  };
  return worker;
}

function pump() {
  if (running || queued.length === 0) return;
  // The track being heard always goes first.
  const nowId = getState().now?.trackId;
  const idx = Math.max(0, queued.findIndex((j) => j.track.id === nowId));
  const job = queued.splice(idx, 1)[0];
  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, job.buffer.numberOfChannels); c++) {
    const a = new Float32Array(job.buffer.length);
    job.buffer.copyFromChannel(a, c);
    channels.push(a);
  }
  const m = job.track.meta;
  const payload: AnalysisJob = {
    id: ++seq,
    channels,
    sampleRate: job.buffer.sampleRate,
    meta: {
      bitsPerSample: m?.bitsPerSample,
      lossless: m?.lossless,
      codec: m?.codec,
      resampled: job.resampled,
      sourceRate: m?.sampleRate ?? job.buffer.sampleRate,
    },
  };
  running = { id: payload.id, job };
  setAnalysisStatus(job.track.id, { state: 'running', stage: 'Menyiapkan', progress: 0 });
  ensureWorker().postMessage(payload, channels.map((c) => c.buffer));
}

/**
 * Analyse a decoded track once. Results are cached in IndexedDB, so a song
 * is only ever analysed the first time it plays.
 */
export async function requestAnalysis(track: Track, buffer: AudioBuffer, resampled: boolean): Promise<void> {
  if (raw.has(track.id) || inFlight.has(track.id)) return;
  inFlight.add(track.id);
  const fixed = loadFix(track);
  setAnalysisStatus(track.id, { state: 'queued', stage: 'Antre', progress: 0 });
  let key = '';
  try {
    key = await cacheKey(track, buffer.sampleRate);
    const cached = (await get(key)) as Analysis | undefined;
    cacheKeys.set(track.id, key);
    if (cached && cached.version === ANALYSIS_VERSION) {
      raw.set(track.id, cached);
      await fixed;
      publish(track.id);
      inFlight.delete(track.id);
      setAnalysisStatus(track.id, { state: 'done', stage: 'Dari cache', progress: 1 });
      return;
    }
  } catch {
    /* no cache: analyse */
  }
  // Keep at most one waiting job besides the current track, to bound memory.
  while (queued.length >= 2) {
    const dropped = queued.shift()!;
    inFlight.delete(dropped.track.id);
    usePlayer.setState((s) => {
      const next = { ...s.analysis };
      delete next[dropped.track.id];
      return { analysis: next };
    });
  }
  queued.push({ track, buffer, resampled, key, fixed });
  pump();
}

/** Loads a track's analysis from the on-disk cache without decoding it. */
export async function loadCachedAnalysis(track: Track, rate: number): Promise<Analysis | undefined> {
  if (results.has(track.id)) return results.get(track.id);
  try {
    const key = await cacheKey(track, rate);
    const cached = (await get(key)) as Analysis | undefined;
    if (cached && cached.version === ANALYSIS_VERSION) {
      raw.set(track.id, cached);
      cacheKeys.set(track.id, key);
      await loadFix(track);
      publish(track.id);
      return results.get(track.id);
    }
  } catch {
    /* not cached */
  }
  return undefined;
}

/** Analyses a decoded track and resolves when done (undefined on error or when bumped from the queue). */
export function analyzeAndWait(track: Track, buffer: AudioBuffer, resampled = false): Promise<Analysis | undefined> {
  return new Promise((resolve) => {
    let seen = false;
    const check = () => {
      const st = usePlayer.getState().analysis[track.id];
      if (st) seen = true;
      if (results.has(track.id)) return resolve(results.get(track.id)), true;
      if (st?.state === 'error' || (seen && !st)) return resolve(undefined), true;
      return false;
    };
    const unsub = usePlayer.subscribe(() => {
      if (check()) unsub();
    });
    void requestAnalysis(track, buffer, resampled).then(() => {
      if (check()) unsub();
    });
  });
}

/**
 * Tempo octave correction. Half- and double-time readings are genuinely
 * ambiguous, so the listener gets the final word; the fix is cached.
 */
export function adjustTempo(trackId: string, factor: 0.5 | 2) {
  const a = raw.get(trackId);
  if (!a || a.beats.length < 4) return;
  const old = Array.from(a.beats);
  const d0 = a.downbeats[0] ?? 0;
  let beats: number[];
  let first: number;
  if (factor === 2) {
    beats = [];
    for (let i = 0; i < old.length; i++) {
      beats.push(old[i]);
      if (i + 1 < old.length) beats.push((old[i] + old[i + 1]) / 2);
    }
    first = d0 * 2;
  } else {
    beats = old.filter((_, i) => i % 2 === d0 % 2);
    first = Math.floor(d0 / 2);
  }
  const downbeats: number[] = [];
  for (let i = first; i < beats.length; i += 4) downbeats.push(i);
  const next: Analysis = {
    ...a,
    bpm: Math.round(a.bpm * factor * 10) / 10,
    beats: new Float32Array(beats),
    downbeats: new Int32Array(downbeats),
  };
  raw.set(trackId, next);
  publish(trackId);
  const key = cacheKeys.get(trackId);
  if (key) void set(key, next).catch(() => undefined);
  setAnalysisStatus(trackId, { state: 'done', stage: 'Tempo dikoreksi', progress: 1 });
}

/* ------------------------------------------------------------------------ */
/* Corrections: the listener's key and chords, kept per file.               */
/* ------------------------------------------------------------------------ */

function loadFix(track: Track): Promise<void> {
  let p = fixLoads.get(track.id);
  if (!p) {
    p = (async () => {
      try {
        const id = await fx.fixId(track);
        if (!id) return;
        fixIds.set(track.id, id);
        const f = (await get(id)) as fx.Fix | undefined;
        if (f) fixes.set(track.id, f);
      } catch {
        /* no stored corrections */
      }
    })();
    fixLoads.set(track.id, p);
  }
  return p;
}

function publish(trackId: string) {
  const a = raw.get(trackId);
  if (a) results.set(trackId, fx.applyFix(a, fixes.get(trackId)));
}

/** What the algorithm heard, before the listener's corrections. */
export const getRawAnalysis = (trackId: string | undefined) => (trackId ? raw.get(trackId) : undefined);

export const getFix = (trackId: string | undefined) => (trackId ? fixes.get(trackId) : undefined);

function commit(trackId: string, change: (f: fx.Fix, a: Analysis) => fx.Fix) {
  const a = raw.get(trackId);
  if (!a) return;
  const f = change(fixes.get(trackId) ?? fx.emptyFix(getState().tracks[trackId], a.duration), a);
  const keep = fx.hasContent(f);
  if (keep) fixes.set(trackId, f);
  else fixes.delete(trackId);
  publish(trackId);
  setAnalysisStatus(trackId, { state: 'done', stage: 'Dikoreksi', progress: 1 });
  const id = fixIds.get(trackId);
  if (id) void (keep ? set(id, f) : del(id)).catch(() => undefined);
}

/** Sets the key by hand, or back to what the analysis heard with null. */
export function fixKey(trackId: string, key: { tonic: number; mode: KeyInfo['mode'] } | null) {
  commit(trackId, (f, a) => fx.setKey(f, key, a.key));
}

/** Names the chord over these spans, or 'none' for no chord. */
export function fixChords(trackId: string, spans: fx.Span[], pick: fx.ChordPick) {
  commit(trackId, (f) => fx.setChords(f, spans, pick));
}

export function revertChords(trackId: string, spans: fx.Span[]) {
  commit(trackId, (f, a) => fx.revertChords(f, spans, a.chords));
}

/** Marks the whole sheet, as the listener reads it in this view, as checked by ear. */
export function setSheetChecked(trackId: string, on: boolean, view: ChordView) {
  const shown = results.get(trackId);
  if (!shown) return;
  commit(trackId, (f, a) => fx.setChecked(f, on, chordsFor(shown, view), shown.key, a.duration));
}

/** The corrected sheet as a MIREX .lab file, for the benchmark or other tools. */
export function labFor(trackId: string): string | null {
  const a = results.get(trackId);
  if (!a) return null;
  const t = getState().tracks[trackId];
  return fx.toLab(a.chords, a.key, a.duration, t?.meta?.title || t?.name || 'Musiccus');
}
