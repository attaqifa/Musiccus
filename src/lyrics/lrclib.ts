/**
 * LRCLIB (lrclib.net): an open, free lyrics database with line-synced LRC.
 * No key and no account; the browser calls it directly (CORS is open). Only
 * the song's title, artist, album and duration are sent.
 */
import { del, get, set } from 'idb-keyval';

const API = 'https://lrclib.net/api';
// LRCLIB asks clients to name themselves; browsers may not set User-Agent.
const HEADERS = { 'Lrclib-Client': 'Musiccus' };
/** A song that was not found is asked again after this long. */
const MISS_TTL = 3 * 24 * 3600 * 1000;

export interface LrclibHit {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string;
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

export interface SongQuery {
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
}

async function call<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const url = `${API}/${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(9000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB menjawab ${res.status}`);
  return (await res.json()) as T;
}

/** Title without the parts that differ between releases: "(Remastered 2011)", "[Official Video]", "feat. X". */
export function cleanTitle(t: string): string {
  return t
    .replace(/\s*[([][^)\]]*(remaster|official|video|audio|lyric|live|version|edit|mix|feat\.?|ft\.)[^)\]]*[)\]]/gi, '')
    .replace(/\s+(feat\.?|ft\.)\s+.*$/i, '')
    .trim();
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** How well a search result fits the song; lower is better, Infinity rejects it. */
function score(h: LrclibHit, q: SongQuery): number {
  if (h.instrumental) return Infinity;
  let s = 0;
  if (q.duration) {
    const d = Math.abs(h.duration - q.duration);
    // A different cut of the song (radio edit, extended) has different timing.
    if (d > 4) return Infinity;
    s += d;
  }
  if (norm(cleanTitle(h.trackName)) !== norm(cleanTitle(q.title))) s += 6;
  if (q.artist && !norm(h.artistName).includes(norm(q.artist).split(' ')[0] ?? '')) s += 4;
  if (!h.syncedLyrics) s += 20;
  return s;
}

const cacheKey = (q: SongQuery) => `lrclib:${norm(q.artist ?? '')}|${norm(q.title)}|${Math.round(q.duration ?? 0)}`;

/**
 * Lyrics for a song: the exact match first (title, artist, album, duration),
 * then a search that tolerates small differences. Answers are cached, so a
 * song is looked up once.
 */
export async function lookup(q: SongQuery): Promise<LrclibHit | null> {
  const key = cacheKey(q);
  try {
    const hit = await get<{ hit: LrclibHit | null; at: number }>(key);
    if (hit && (hit.hit || Date.now() - hit.at < MISS_TTL)) return hit.hit;
  } catch {
    /* IndexedDB unavailable: ask the network */
  }
  let found: LrclibHit | null = null;
  if (q.artist && q.duration) {
    found = await call<LrclibHit>('get', {
      track_name: q.title,
      artist_name: q.artist,
      album_name: q.album ?? '',
      duration: String(Math.round(q.duration)),
    });
    if (found && (found.instrumental || (!found.syncedLyrics && !found.plainLyrics))) found = null;
  }
  if (!found || !found.syncedLyrics) {
    const params: Record<string, string> = q.artist ? { track_name: cleanTitle(q.title), artist_name: q.artist } : { q: cleanTitle(q.title) };
    const list = (await call<LrclibHit[]>('search', params)) ?? [];
    const best = list
      .map((h) => ({ h, s: score(h, q) }))
      .filter((x) => Number.isFinite(x.s))
      .sort((a, b) => a.s - b.s)[0]?.h;
    if (best && (!found || best.syncedLyrics)) found = best;
  }
  try {
    await set(key, { hit: found, at: Date.now() });
  } catch {
    /* not cached */
  }
  return found;
}

/** Free-text search for the panel's "Cari lirik" box. */
export async function search(text: string): Promise<LrclibHit[]> {
  const list = (await call<LrclibHit[]>('search', { q: text.trim() })) ?? [];
  return list.filter((h) => !h.instrumental && (h.syncedLyrics || h.plainLyrics)).slice(0, 12);
}

/* A choice made by hand in the panel, remembered per file. */

const pickKey = (path: string) => `lyrics-pick:${path}`;

export async function savedPick(path: string): Promise<LrclibHit | null> {
  try {
    return (await get<LrclibHit>(pickKey(path))) ?? null;
  } catch {
    return null;
  }
}

export async function savePick(path: string, hit: LrclibHit | null): Promise<void> {
  try {
    if (hit) await set(pickKey(path), hit);
    else await del(pickKey(path));
  } catch {
    /* not remembered */
  }
}
