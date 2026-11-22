import { del, get, set } from 'idb-keyval';
import { engine, type StemBuffers } from '../audio/engine';
import { requestPersistence } from '../lib/storage';
import { getDecoded, getFile } from '../store/controller';
import { getState, toast, usePlayer } from '../store/player';
import { encodeWav, saveBlob } from '../studio/export';
import { stemGain } from './mixer';
import { setStemStatus, useStems } from './store';
import {
  ENV_FLOOR_DB,
  ENV_RATE,
  MODEL_BASE,
  MODEL_CACHE,
  STEM_LABEL,
  STEMS,
  type CachedStems,
  type SeparateRequest,
  type SeparationEngine,
  type StemId,
  type StemWorkerMessage,
} from './types';

/* ------------------------------------------------------------- State -- */

interface Loaded {
  trackId: string;
  rate: number;
  length: number;
  buffers: StemBuffers;
  /** Level envelopes (vocals, drums, bass, other) and each stem's loud reference. */
  levels: Uint8Array[];
  ref: number[];
  backend: string;
}

/** Stems in memory: only the playing track's, they are large. */
const loaded = new Map<string, Loaded>();

export const getStems = (trackId: string | undefined) => (trackId ? loaded.get(trackId) : undefined);

const BYTES_PER_DB = 255 / -ENV_FLOOR_DB;

/** Envelope byte at a time, linearly interpolated. */
function levelAt(env: Uint8Array, t: number): number {
  const x = t * ENV_RATE;
  const i = Math.floor(x);
  if (i < 0 || i >= env.length) return 0;
  const a = env[i];
  const b = env[Math.min(env.length - 1, i + 1)];
  return a + (b - a) * (x - i);
}

/**
 * How active each stem is at time `t`, 0..1 relative to its own loud
 * passages, scaled by what the mixer lets through. Null without stems.
 */
export function stemActivity(trackId: string | undefined, t: number): Record<StemId, number> | null {
  const l = getStems(trackId);
  if (!l) return null;
  const mix = useStems.getState().mix;
  const out = {} as Record<StemId, number>;
  STEMS.forEach((id, k) => {
    const span = 24 * BYTES_PER_DB;
    const v = (levelAt(l.levels[k], t) - (l.ref[k] - span)) / span;
    out[id] = Math.max(0, Math.min(1, v)) * Math.min(1, stemGain(mix, id));
  });
  return out;
}

/** Level of a stem in dBFS at `t` (before the mixer), for meters. */
export function stemDb(trackId: string | undefined, k: number, t: number): number {
  const l = getStems(trackId);
  if (!l) return -Infinity;
  return levelAt(l.levels[k], t) / BYTES_PER_DB + ENV_FLOOR_DB;
}

/**
 * The vocal stem's level over the whole song, for timing lyrics to the voice.
 * Null until the playing track is separated.
 */
export function vocalLevels(trackId: string | undefined): { db: Float32Array; rate: number; refDb: number } | null {
  const l = getStems(trackId);
  if (!l) return null;
  const env = l.levels[0];
  const db = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) db[i] = env[i] / BYTES_PER_DB + ENV_FLOOR_DB;
  return { db, rate: ENV_RATE, refDb: l.ref[0] / BYTES_PER_DB + ENV_FLOOR_DB };
}

function reference(env: Uint8Array): number {
  const hist = new Uint32Array(256);
  let n = 0;
  for (const v of env) {
    if (v > 0) {
      hist[v]++;
      n++;
    }
  }
  let acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= n * 0.05) return v;
  }
  return 0;
}

/* ------------------------------------------------------------- Cache -- */

const INDEX_KEY = 'stems:index';
const CACHE_LIMIT = 2.5e9;

interface CacheEntry {
  bytes: number;
  at: number;
}

async function cacheKey(trackId: string): Promise<string | null> {
  const t = getState().tracks[trackId];
  // The demo is re-synthesised with fresh noise each time: never reuse its stems.
  if (!t || t.synth) return null;
  const file = await getFile(t).catch(() => undefined);
  if (!file) return null;
  return `stems:v2:ai:${t.path}|${file.size}|${file.lastModified}`;
}

async function cacheSave(key: string, raw: CachedStems) {
  try {
    const index = ((await get(INDEX_KEY)) as Record<string, CacheEntry> | undefined) ?? {};
    const bytes = raw.data.reduce((a, r) => a + r.byteLength, 0);
    index[key] = { bytes, at: Date.now() };
    let total = Object.values(index).reduce((a, e) => a + e.bytes, 0);
    for (const [k] of Object.entries(index).sort((a, b) => a[1].at - b[1].at)) {
      if (total <= CACHE_LIMIT || k === key) continue;
      total -= index[k].bytes;
      delete index[k];
      await del(k);
    }
    await set(key, raw);
    await set(INDEX_KEY, index);
  } catch {
    /* storage full or unavailable: stems still play from memory */
  }
}

async function cacheLoad(key: string): Promise<CachedStems | null> {
  try {
    const raw = (await get(key)) as CachedStems | undefined;
    if (!raw?.data) return null;
    const index = ((await get(INDEX_KEY)) as Record<string, CacheEntry> | undefined) ?? {};
    if (index[key]) {
      index[key].at = Date.now();
      await set(INDEX_KEY, index);
    }
    return raw;
  } catch {
    return null;
  }
}

/** Size of the stem cache on disk, bytes. */
export async function stemCacheSize(): Promise<number> {
  const index = ((await get(INDEX_KEY).catch(() => undefined)) as Record<string, CacheEntry> | undefined) ?? {};
  return Object.values(index).reduce((a, e) => a + e.bytes, 0);
}

export async function clearStemCache(): Promise<void> {
  const index = ((await get(INDEX_KEY).catch(() => undefined)) as Record<string, CacheEntry> | undefined) ?? {};
  for (const k of Object.keys(index)) await del(k).catch(() => undefined);
  await del(INDEX_KEY).catch(() => undefined);
}

/* ------------------------------------------------------------- Model -- */

export async function refreshModelStatus(): Promise<boolean> {
  let ok = false;
  try {
    const cache = await caches.open(MODEL_CACHE);
    const m = await cache.match(`${MODEL_BASE}htdemucs_split_manifest.json`);
    if (m) {
      const manifest = (await m.json()) as { pieces: { file: string }[] };
      ok = true;
      for (const p of manifest.pieces) {
        if (!(await cache.match(MODEL_BASE + p.file))) {
          ok = false;
          break;
        }
      }
    }
  } catch {
    ok = false;
  }
  useStems.setState({ modelCached: ok });
  return ok;
}

export async function deleteModel(): Promise<void> {
  await caches.delete(MODEL_CACHE).catch(() => undefined);
  await refreshModelStatus();
}

/* -------------------------------------------------------------- Jobs -- */

interface Job {
  trackId: string;
  engine: SeparationEngine;
  buffer: AudioBuffer;
  key: string | null;
  cached?: CachedStems;
}

let worker: Worker | null = null;
let seq = 0;
let running: { id: number; job: Job } | null = null;
const queue: Job[] = [];

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<StemWorkerMessage>) => {
    const msg = e.data;
    if (!running || msg.id !== running.id) return;
    const { job } = running;
    if (msg.type === 'progress') {
      setStemStatus(job.trackId, { state: 'running', stage: msg.stage, progress: msg.p, engine: job.engine, cached: !!job.cached });
      return;
    }
    if (msg.type === 'done') finish(job, msg.stems, msg.levels, msg.backend, msg.elapsedMs, msg.raw);
    else {
      setStemStatus(job.trackId, { state: 'error', stage: 'Gagal', progress: 0, engine: job.engine, error: msg.message });
      toast(`Pemisahan stem gagal: ${msg.message}`, 'error', 8000);
      if (job.engine === 'ai') {
        void refreshModelStatus();
        // A failed GPU run can leave the device unusable: start the next try in a fresh worker.
        worker?.terminate();
        worker = null;
      }
    }
    running = null;
    pump();
  };
  worker.onerror = (e) => {
    if (running) {
      const { job } = running;
      setStemStatus(job.trackId, { state: 'error', stage: 'Gagal', progress: 0, engine: job.engine, error: e.message || 'Worker berhenti.' });
      running = null;
    }
    worker?.terminate();
    worker = null;
    pump();
  };
  return worker;
}

function finish(job: Job, stems: Float32Array[], levels: Uint8Array[], backend: string, elapsedMs: number, raw?: CachedStems) {
  const { buffer } = job;
  const make = (i: number) => {
    const b = new AudioBuffer({ numberOfChannels: 2, length: buffer.length, sampleRate: buffer.sampleRate });
    b.copyToChannel(stems[i * 2] as Float32Array<ArrayBuffer>, 0);
    b.copyToChannel(stems[i * 2 + 1] as Float32Array<ArrayBuffer>, 1);
    return b;
  };
  const buffers: StemBuffers = { vocals: make(0), drums: make(1), bass: make(2) };
  const current = usePlayer.getState().now?.trackId;
  if (job.trackId === current) {
    for (const id of loaded.keys()) if (id !== current) loaded.delete(id);
    loaded.set(job.trackId, {
      trackId: job.trackId,
      rate: buffer.sampleRate,
      length: buffer.length,
      buffers,
      levels,
      ref: levels.map(reference),
      backend,
    });
    engine.setStems(job.trackId, buffers);
  }
  setStemStatus(job.trackId, { state: 'ready', stage: 'Siap', progress: 1, engine: job.engine, backend, elapsedMs, cached: !!job.cached });
  if (raw && job.key) void cacheSave(job.key, raw);
  if (job.engine === 'ai' && !job.cached) void refreshModelStatus();
}

function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  const w = ensureWorker();
  const id = ++seq;
  running = { id, job };
  setStemStatus(job.trackId, { state: 'running', stage: job.cached ? 'Memuat dari cache' : 'Memulai', progress: 0, engine: job.engine, cached: !!job.cached });
  const ch0 = job.buffer.getChannelData(0);
  const ch1 = job.buffer.numberOfChannels > 1 ? job.buffer.getChannelData(1) : ch0;
  const req: SeparateRequest = {
    type: 'separate',
    id,
    engine: job.engine,
    rate: job.buffer.sampleRate,
    left: new Float32Array(ch0),
    right: new Float32Array(ch1),
    cached: job.cached,
  };
  w.postMessage(req, [req.left.buffer, req.right.buffer, ...(job.cached?.data ?? []).map((c) => c.buffer)]);
}

function enqueue(job: Job) {
  const i = queue.findIndex((j) => j.trackId === job.trackId);
  if (i >= 0) queue.splice(i, 1);
  queue.unshift(job);
  setStemStatus(job.trackId, { state: 'queued', stage: 'Antre', progress: 0, engine: job.engine, cached: !!job.cached });
  pump();
}

/** Separates the playing track with the given engine (default: the preferred one). */
export async function separateCurrent(engineChoice: SeparationEngine = useStems.getState().engine): Promise<void> {
  if (engineChoice === 'ai') void requestPersistence();
  const trackId = usePlayer.getState().now?.trackId;
  const d = getDecoded(trackId);
  if (!trackId || !d) {
    toast('Putar lagu yang ingin dipisahkan terlebih dahulu.', 'error');
    return;
  }
  if (running?.job.trackId === trackId) return;
  const key = engineChoice === 'ai' ? await cacheKey(trackId) : null;
  const cached = key ? ((await cacheLoad(key)) ?? undefined) : undefined;
  enqueue({ trackId, engine: engineChoice, buffer: d.buffer, key, cached });
}

/** Downloads the four stems as 24-bit WAV; "other" is rendered as the remainder. */
export function exportStems() {
  const s = usePlayer.getState();
  const id = s.now?.trackId;
  const l = getStems(id);
  const d = getDecoded(id);
  if (!id || !l || !d) {
    toast('Pisahkan lagu ini dulu sebelum mengunduh stem.', 'error');
    return;
  }
  const t = s.tracks[id];
  const title = (t?.meta?.title || t?.name.replace(/\.[^.]+$/, '') || 'Musiccus').replace(/[\/:*?"<>|]/g, '');
  const n = d.buffer.length;
  const other = new AudioBuffer({ numberOfChannels: 2, length: n, sampleRate: d.buffer.sampleRate });
  for (let c = 0; c < 2; c++) {
    const src = d.buffer.getChannelData(Math.min(c, d.buffer.numberOfChannels - 1));
    const out = new Float32Array(n);
    const parts = [l.buffers.vocals, l.buffers.drums, l.buffers.bass].map((b) => b.getChannelData(c));
    for (let i = 0; i < n; i++) out[i] = src[i] - parts[0][i] - parts[1][i] - parts[2][i];
    other.copyToChannel(out, c);
  }
  const all: [StemId, AudioBuffer][] = [['vocals', l.buffers.vocals], ['drums', l.buffers.drums], ['bass', l.buffers.bass], ['other', other]];
  all.forEach(([sid, buf], i) => setTimeout(() => saveBlob(encodeWav(buf, 24), `${title} - ${STEM_LABEL[sid]} (Musiccus).wav`), i * 400));
  toast('Empat stem diunduh sebagai WAV 24-bit. Jika dijumlahkan, hasilnya sama dengan lagu aslinya.');
}

/** Removes the playing track's stems: back to the plain file. */
export function dropStems(trackId: string) {
  loaded.delete(trackId);
  engine.setStems(trackId, null);
  useStems.setState((s) => {
    const status = { ...s.status };
    delete status[trackId];
    return { status };
  });
}

/** On every new track: restore cached AI stems, or separate when auto is on. */
async function onTrack(trackId: string | undefined) {
  for (const id of [...loaded.keys()]) {
    if (id !== trackId) {
      loaded.delete(id);
      engine.setStems(id, null);
    }
  }
  // Stems leave memory with their track, so "ready" must too; cached AI
  // stems come back on their own when the track plays again.
  useStems.setState((s) => {
    const stale = Object.keys(s.status).filter((id) => id !== trackId && s.status[id].state === 'ready');
    if (!stale.length) return {};
    const status = { ...s.status };
    for (const id of stale) delete status[id];
    return { status };
  });
  const d = getDecoded(trackId);
  if (!trackId || !d) return;
  const have = loaded.get(trackId);
  if (have && have.rate === d.buffer.sampleRate && have.length === d.buffer.length) return;
  if (running?.job.trackId === trackId) return;
  const key = await cacheKey(trackId);
  const cached = key ? await cacheLoad(key) : null;
  if (usePlayer.getState().now?.trackId !== trackId) return;
  if (cached) enqueue({ trackId, engine: 'ai', buffer: d.buffer, key, cached });
  else if (useStems.getState().auto) enqueue({ trackId, engine: useStems.getState().engine, buffer: d.buffer, key });
}

usePlayer.subscribe((s, prev) => {
  if (s.now?.trackId !== prev.now?.trackId || s.now?.engineRate !== prev.now?.engineRate) void onTrack(s.now?.trackId);
});

useStems.subscribe((s, prev) => {
  if (s.mix !== prev.mix) engine.setStemMix(s.mix);
});
engine.setStemMix(useStems.getState().mix);
void refreshModelStatus();
