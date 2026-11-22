import { get, set } from 'idb-keyval';
import { engine } from '../audio/engine';
import { recallFolder, saveJSON } from '../lib/storage';
import { resumeLastFolder, resumeQueue, type SavedQueue } from './controller';
import { getState, usePlayer } from './player';

/**
 * Remembers where listening stopped (the song, the second, and the queue
 * around it) so Lanjutkan on the welcome screen carries on from there.
 *
 * Only songs from an opened folder count: the browser can open those again
 * after a reload. Dropped files, the demo and tabs leave the last point as it
 * was.
 */

const POINT_KEY = 'musiccus:resume';
const QUEUE_KEY = 'musiccus:resume-queue';

export interface ResumePoint {
  folder: string;
  id: string;
  title: string;
  artist: string;
  time: number;
  /** The queue song this one interrupted (an up-next song), or the song itself. */
  at?: string;
  fromUp: boolean;
}

function readPoint(): ResumePoint | null {
  try {
    const raw = localStorage.getItem(POINT_KEY);
    const p = raw ? (JSON.parse(raw) as ResumePoint) : null;
    return p && typeof p.id === 'string' && typeof p.folder === 'string' ? p : null;
  } catch {
    return null;
  }
}

function currentPoint(): ResumePoint | null {
  const s = getState();
  const t = s.now ? s.tracks[s.now.trackId] : undefined;
  if (!s.now || !t?.handle || t.live || t.synth || !s.libraryName) return null;
  const p = engine.position();
  let time = p && !p.live && p.id === t.id ? p.time : 0;
  // A song that (nearly) finished starts again from the top.
  if (s.status === 'ended' || s.now.duration - time < 5) time = 0;
  return {
    folder: s.libraryName,
    id: t.id,
    title: t.meta?.title || t.name.replace(/\.[^.]+$/, ''),
    artist: t.meta?.artist || '',
    time: Math.round(time * 10) / 10,
    at: s.queue[s.queueIndex],
    fromUp: s.fromUp,
  };
}

let savedQueue: { queue: string[]; baseQueue: string[]; upNext: string[] } | null = null;

function save() {
  const point = currentPoint();
  if (!point) return;
  saveJSON(POINT_KEY, point);
  // The queue can hold thousands of songs; write it only when it changed.
  const { queue, baseQueue, upNext } = getState();
  if (savedQueue && savedQueue.queue === queue && savedQueue.baseQueue === baseQueue && savedQueue.upNext === upNext) return;
  savedQueue = { queue, baseQueue, upNext };
  void set(QUEUE_KEY, savedQueue).catch(() => undefined);
}

export interface LastSession {
  folder: string;
  point: ResumePoint | null;
}

/** The remembered folder and, when it is the same folder, the song to carry on with. */
export async function lastSession(): Promise<LastSession | null> {
  const dir = await recallFolder();
  if (!dir) return null;
  const point = readPoint();
  return { folder: dir.name, point: point?.folder === dir.name ? point : null };
}

/**
 * Opens the remembered folder again and plays the last song from a little
 * before where it stopped, with the queue it was part of.
 */
export async function resumeListening(): Promise<void> {
  const point = readPoint();
  if (!(await resumeLastFolder()) || !point) return;
  const s = getState();
  if (s.libraryName !== point.folder || !s.tracks[point.id]) return;
  let queue: SavedQueue = {};
  try {
    queue = ((await get(QUEUE_KEY)) as SavedQueue | undefined) ?? {};
  } catch {
    /* IndexedDB unavailable: the library order follows the song */
  }
  // A few seconds back, so the music comes back mid-phrase rather than mid-word.
  await resumeQueue(point.id, { ...queue, at: point.at, fromUp: point.fromUp }, Math.max(0, point.time - 3));
}

usePlayer.subscribe((s, p) => {
  if (s.status !== p.status || s.now?.trackId !== p.now?.trackId) save();
});
window.setInterval(() => {
  if (getState().status === 'playing') save();
}, 5000);
// Closing the tab or switching away: keep the exact second.
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && save());
window.addEventListener('pagehide', save);
