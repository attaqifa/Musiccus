import { create } from 'zustand';
import { analyzeAndWait, getAnalysis, loadCachedAnalysis } from '../analysis/manager';
import { decodeFile } from '../audio/decode';
import { requestPersistence } from '../lib/storage';
import { getFile } from '../store/controller';
import { getState } from '../store/player';

interface CollectionState {
  running: boolean;
  done: number;
  total: number;
  current: string | null;
  /** Bumps whenever more analyses are available, so views can re-read. */
  version: number;
}

export const useCollection = create<CollectionState>(() => ({ running: false, done: 0, total: 0, current: null, version: 0 }));

let cancelled = false;
const bump = () => useCollection.setState((s) => ({ version: s.version + 1 }));
const idle = () => new Promise((r) => setTimeout(r, 0));

/** Tracks the map can show; formats without a decoder yet are left out. */
const candidates = () => {
  const { order, tracks } = getState();
  return order.filter((id) => tracks[id] && !tracks[id].needsWasm && !tracks[id].synth);
};

/** Pulls every analysis already cached on disk, without decoding anything. */
export async function loadCollectionCache(): Promise<void> {
  const { tracks } = getState();
  let found = 0;
  for (const id of candidates()) {
    const t = tracks[id];
    if (getAnalysis(id) || !t.meta?.sampleRate) continue;
    if (await loadCachedAnalysis(t, t.meta.sampleRate)) found++;
  }
  if (found) bump();
}

export const unanalysedCount = () => candidates().filter((id) => !getAnalysis(id)).length;

/**
 * Analyses the whole library in the background, one song at a time (the
 * playing song always jumps the queue). Results are cached, so this is a
 * one-time cost per song.
 */
export async function analyseCollection(): Promise<void> {
  if (useCollection.getState().running) return;
  cancelled = false;
  void requestPersistence();
  const pending = candidates().filter((id) => !getAnalysis(id));
  useCollection.setState({ running: true, done: 0, total: pending.length, current: null });
  for (const id of pending) {
    if (cancelled) break;
    const t = getState().tracks[id];
    if (!t) continue;
    useCollection.setState({ current: t.meta?.title ?? t.name });
    try {
      const cached = t.meta?.sampleRate ? await loadCachedAnalysis(t, t.meta.sampleRate) : undefined;
      if (!cached) {
        const d = await decodeFile(await getFile(t), t.ext, t.meta?.sampleRate, 'native');
        await analyzeAndWait(t, d.buffer, d.resampled);
      }
    } catch {
      /* unreadable file: skip it */
    }
    useCollection.setState((s) => ({ done: s.done + 1, version: s.version + 1 }));
    await idle();
  }
  useCollection.setState({ running: false, current: null });
}

export function cancelCollection() {
  cancelled = true;
}
