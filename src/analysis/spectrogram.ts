import { useEffect, useSyncExternalStore } from 'react';
import { getDecoded } from '../store/controller';
import type { SpectroJob, SpectroMessage } from './spectrogram.worker';

export interface Spectrogram {
  /** Column-major levels 0..255: `data[col * rows + row]`, row 0 at 0 Hz. */
  data: Uint8Array;
  cols: number;
  rows: number;
  topHz: number;
  duration: number;
}

export type SpectroState =
  | { state: 'idle' }
  | { state: 'running'; progress: number }
  | { state: 'done'; result: Spectrogram }
  | { state: 'error'; message: string };

const ROWS = 256;
const KEEP = 4;

const results = new Map<string, Spectrogram>();
const states = new Map<string, SpectroState>();
const listeners = new Set<() => void>();
let worker: Worker | null = null;
let running: { id: number; trackId: string; duration: number } | null = null;
let nextId = 1;
const IDLE: SpectroState = { state: 'idle' };

const emit = () => listeners.forEach((l) => l());
function set(trackId: string, s: SpectroState) {
  states.set(trackId, s);
  emit();
}

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./spectrogram.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<SpectroMessage>) => {
    const msg = e.data;
    if (!running || msg.id !== running.id) return;
    const { trackId, duration } = running;
    if (msg.type === 'progress') set(trackId, { state: 'running', progress: msg.p });
    else if (msg.type === 'error') {
      running = null;
      set(trackId, { state: 'error', message: msg.message });
    } else {
      running = null;
      const result: Spectrogram = { data: msg.data, cols: msg.cols, rows: msg.rows, topHz: msg.topHz, duration };
      results.set(trackId, result);
      // Keep only the last few songs: each is a few hundred kilobytes.
      while (results.size > KEEP) {
        const first = results.keys().next().value as string;
        results.delete(first);
        states.delete(first);
      }
      set(trackId, { state: 'done', result });
    }
  };
  return worker;
}

/** Starts the spectrogram of a decoded track, unless it is done or underway. */
export function requestSpectrogram(trackId: string) {
  const st = states.get(trackId);
  if (st && st.state !== 'error' && st.state !== 'idle') return;
  const decoded = getDecoded(trackId);
  if (!decoded) return;
  const buf = decoded.buffer;
  // One song at a time: a new request replaces one still running.
  if (running) {
    worker?.terminate();
    worker = null;
    states.delete(running.trackId);
    running = null;
  }
  const n = buf.length;
  const mono = new Float32Array(n);
  const chans = Math.min(2, buf.numberOfChannels);
  for (let c = 0; c < chans; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / chans;
  }
  const rate = buf.sampleRate;
  // After resampling, nothing above the file's own Nyquist is real.
  const topHz = Math.min(rate, decoded.resampled ? decoded.sourceRate : rate) / 2;
  const duration = n / rate;
  const id = nextId++;
  running = { id, trackId, duration };
  set(trackId, { state: 'running', progress: 0 });
  const job: SpectroJob = { id, mono, sampleRate: rate, topHz, cols: Math.round(Math.min(1400, Math.max(240, duration * 6))), rows: ROWS };
  ensureWorker().postMessage(job, [mono.buffer]);
}

/** The spectrogram of a track, computed the first time it is asked for. */
export function useSpectrogram(trackId: string | undefined): SpectroState {
  const state = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (trackId ? (states.get(trackId) ?? IDLE) : IDLE),
  );
  useEffect(() => {
    if (trackId) requestSpectrogram(trackId);
  }, [trackId]);
  return state;
}
