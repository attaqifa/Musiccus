/**
 * Lyrics for the playing song, from the first source that has them:
 * a sidecar .lrc next to the file, lyrics embedded in its tags, a choice the
 * listener made earlier, or LRCLIB. A dropped .lrc replaces whatever is
 * shown. Enhanced LRC word timings (<mm:ss.xx>) are kept; other lines get
 * estimated word times (see timing.ts), redone when the beat grid or the
 * vocal stem becomes available.
 */
import { create } from 'zustand';
import { getAnalysis } from '../analysis/manager';
import { engine } from '../audio/engine';
import { loadJSON, saveJSON } from '../lib/storage';
import { getLive, LIVE_ID, useLive } from '../live/store';
import { sidecarKey, sidecars } from '../library/scan';
import { vocalLevels } from '../stems/manager';
import { useStems } from '../stems/store';
import { getFile } from '../store/controller';
import { getState, toast, usePlayer, type Track } from '../store/player';
import { cleanTitle, lookup, savedPick, savePick, type LrclibHit, type SongQuery } from './lrclib';
import { estimateWords } from './timing';

export interface LyricWord {
  t: number;
  text: string;
}

export interface LyricLine {
  t: number;
  text: string;
  words?: LyricWord[];
  /** Word times are estimates, not from the lyrics file. */
  estimated?: boolean;
}

export type LyricsSource = 'lrc' | 'tag' | 'drop' | 'lrclib';

export interface Lyrics {
  /** Lines as the source gave them. Without timestamps, `t` is just the line number. */
  lines: LyricLine[];
  synced: boolean;
  source: LyricsSource;
  /** The LRCLIB entry the lyrics came from. */
  credit?: { id: number; title: string; artist: string; duration?: number };
}

export type LyricsState = 'loading' | 'done' | 'error';

interface LyricsStore {
  /** null: the song has no lyrics anywhere we looked. */
  byTrack: Record<string, Lyrics | null>;
  /** Synced lines with word times, ready to display. */
  timed: Record<string, LyricLine[]>;
  state: Record<string, LyricsState>;
  /** Lyrics over the visuals. */
  show: boolean;
  /** Timing correction per track path, seconds (positive = lyrics later). */
  offsets: Record<string, number>;
}

const KEY = 'musiccus:lyrics';
const saved = loadJSON<{ show: boolean; offsets: Record<string, number> }>(KEY, { show: true, offsets: {} });

export const useLyrics = create<LyricsStore>(() => ({ byTrack: {}, timed: {}, state: {}, show: saved.show, offsets: saved.offsets }));

useLyrics.subscribe((s, prev) => {
  if (s.show !== prev.show || s.offsets !== prev.offsets) saveJSON(KEY, { show: s.show, offsets: s.offsets });
});

/* ------------------------------------------------------------- Parsing -- */

const STAMP = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
const WORD = /<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>/g;
const secs = (m: string, s: string) => Number(m) * 60 + Number(s.replace(':', '.'));

/** Parses LRC, including multiple stamps per line, [offset:ms] and enhanced word stamps. */
export function parseLrc(src: string): LyricLine[] {
  let offset = 0;
  const out: LyricLine[] = [];
  for (const raw of src.split(/\r?\n/)) {
    const off = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
    if (off) {
      offset = Number(off[1]) / 1000;
      continue;
    }
    const stamps = [...raw.matchAll(STAMP)];
    if (!stamps.length) continue;
    const body = raw.replace(STAMP, '');
    const words: LyricWord[] = [];
    const parts = body.split(WORD);
    // split() with two groups yields: text, m, s, text, m, s, text...
    if (parts.length > 1) {
      for (let i = 1; i + 2 < parts.length + 1; i += 3) {
        const text = parts[i + 2] ?? '';
        if (text.trim()) words.push({ t: secs(parts[i], parts[i + 1]) - offset, text });
      }
    }
    // Text before the first word stamp starts with the line itself.
    if (words.length && parts[0].trim()) words.unshift({ t: secs(stamps[0][1], stamps[0][2]) - offset, text: parts[0] });
    const text = body.replace(WORD, '').trim();
    for (const st of stamps) {
      // LRC offsets are positive when lyrics should appear earlier.
      out.push({ t: secs(st[1], st[2]) - offset, text, words: words.length ? words : undefined });
    }
  }
  return out.filter((l) => Number.isFinite(l.t)).sort((a, b) => a.t - b.t);
}

/** Index of the line being sung at `t`, or -1 before the first. */
export function lineAt(lines: LyricLine[], t: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

async function fromTags(file: File): Promise<LyricLine[] | null> {
  const { parseBlob } = await import('music-metadata');
  const m = await parseBlob(file, { duration: false, skipCovers: true });
  for (const tag of m.common.lyrics ?? []) {
    const synced = (tag.syncText ?? []).filter((x) => typeof x.timestamp === 'number');
    if (synced.length > 1 && tag.timeStampFormat === 2) {
      return synced.map((x) => ({ t: (x.timestamp as number) / 1000, text: x.text.trim() }));
    }
    // FLAC/Vorbis LYRICS tags often carry plain LRC text.
    if (tag.text && STAMP.test(tag.text)) {
      STAMP.lastIndex = 0;
      const lines = parseLrc(tag.text);
      if (lines.length) return lines;
    }
  }
  return null;
}

/** Lyrics from an LRCLIB entry: synced when it has timestamps, plain text otherwise. */
function fromHit(hit: LrclibHit): Lyrics | null {
  const credit = { id: hit.id, title: hit.trackName, artist: hit.artistName, duration: hit.duration || undefined };
  const lines = hit.syncedLyrics ? parseLrc(hit.syncedLyrics) : [];
  if (lines.length) return { lines, synced: true, source: 'lrclib', credit };
  const plain = (hit.plainLyrics ?? '').split(/\r?\n/).map((text, i) => ({ t: i, text: text.trim() }));
  return plain.some((l) => l.text) ? { lines: plain, synced: false, source: 'lrclib', credit } : null;
}

/* ------------------------------------------------------------- Loading -- */

/**
 * Title and artist to look up: the tags, or a file named "Artist - Title"
 * (a leading track number is skipped).
 */
export function songQuery(t: Track, duration?: number): SongQuery | null {
  const m = t.meta;
  // A tab says nothing about its song unless its title did.
  if (t.live) return m?.title ? { title: m.title, artist: m.artist } : null;
  const base = t.name.replace(/\.[^.]+$/, '').replace(/^\s*\d{1,3}\s*[-.)_]\s*/, '');
  const parts = base.split(/\s+[-–—]\s+/);
  const title = m?.title?.trim() || (parts.length > 1 ? parts.slice(1).join(' - ') : base).trim();
  const artist = m?.artist?.trim() || m?.albumArtist?.trim() || (parts.length > 1 ? parts[0].trim() : undefined);
  if (!title) return null;
  return { title, artist, album: m?.album, duration: m?.duration || duration };
}

const setState = (id: string, st: LyricsState) => useLyrics.setState((s) => ({ state: { ...s.state, [id]: st } }));

function setLyrics(id: string, l: Lyrics | null) {
  useLyrics.setState((s) => ({ byTrack: { ...s.byTrack, [id]: l }, state: { ...s.state, [id]: 'done' } }));
  retime(id);
}

/** (Re)computes word times for a track from its lines, beat grid and vocal stem. */
function retime(id: string) {
  const l = useLyrics.getState().byTrack[id];
  if (!l?.synced) {
    useLyrics.setState((s) => {
      if (!(id in s.timed)) return {};
      const timed = { ...s.timed };
      delete timed[id];
      return { timed };
    });
    return;
  }
  const a = getAnalysis(id);
  const now = getState().now;
  const live = getState().tracks[id]?.live;
  const lines = estimateWords(l.lines, {
    bpm: live ? (getLive().bpm ?? undefined) : a?.bpm,
    beats: a?.beats,
    duration: live ? l.credit?.duration : (a?.duration ?? (now?.trackId === id ? now.duration : undefined)),
    // Only the AI separation isolates the voice well enough to time words by.
    voice: useStems.getState().status[id]?.engine === 'ai' ? vocalLevels(id) : null,
  });
  useLyrics.setState((s) => ({ timed: { ...s.timed, [id]: lines } }));
}

/** Waits until the track's tags are read (they hold title and artist), at most a few seconds. */
function metaReady(id: string): Promise<void> {
  if (getState().tracks[id]?.metaState !== 'pending') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      unsub();
      window.clearTimeout(timer);
      resolve();
    };
    const unsub = usePlayer.subscribe((s) => {
      if (s.tracks[id]?.metaState !== 'pending') done();
    });
    const timer = window.setTimeout(done, 4000);
  });
}

async function load(trackId: string, force = false) {
  const st = useLyrics.getState();
  if (!force && (trackId in st.byTrack || st.state[trackId] === 'loading')) return;
  const t = getState().tracks[trackId];
  if (!t || t.synth) {
    setLyrics(trackId, null);
    return;
  }
  setState(trackId, 'loading');
  if (t.live) return loadLive(t);
  try {
    const side = sidecars.get(sidecarKey(t.path));
    if (side) {
      const file = side instanceof File ? side : await side.getFile();
      const lines = parseLrc(await file.text());
      if (lines.length) return setLyrics(trackId, { lines, synced: true, source: 'lrc' });
    }
    const tagged = await fromTags(await getFile(t)).catch(() => null);
    if (tagged?.length) return setLyrics(trackId, { lines: tagged, synced: true, source: 'tag' });

    const pick = await savedPick(t.path);
    if (pick) return setLyrics(trackId, fromHit(pick));

    if (!getState().settings.lyricsOnline) return setLyrics(trackId, null);
    await metaReady(trackId);
    const now = getState().now;
    const q = songQuery(getState().tracks[trackId] ?? t, now?.trackId === trackId ? now.duration : undefined);
    const hit = q ? await lookup(q) : null;
    setLyrics(trackId, hit ? fromHit(hit) : null);
  } catch {
    // Offline or LRCLIB unreachable: no lyrics now, ask again next time.
    useLyrics.setState((s) => {
      const byTrack = { ...s.byTrack };
      delete byTrack[trackId];
      return { byTrack, state: { ...s.state, [trackId]: 'error' } };
    });
  }
}

/** A tab has no file or tags: only its title, when the browser told us one, can be looked up. */
async function loadLive(t: Track) {
  const q = songQuery(t);
  if (!q || !getState().settings.lyricsOnline) return setLyrics(t.id, null);
  try {
    const hit = await lookup(q);
    const l = hit ? fromHit(hit) : null;
    if (l) setLiveSong(l, getLive().songStart);
    setLyrics(t.id, l);
  } catch {
    setLyrics(t.id, null);
  }
}

/**
 * Lyrics for a tab start where the current stretch of sound started (after
 * the last silence), the best guess for where the song began. Clicking the
 * line being sung corrects it.
 */
function setLiveSong(l: Lyrics, start: number) {
  useLyrics.setState((s) => ({ offsets: { ...s.offsets, [LIVE_ID]: Math.round(start * 100) / 100 } }));
  if (!l.credit) return;
  const { title, artist } = l.credit;
  usePlayer.setState((s) => {
    const t = s.tracks[LIVE_ID];
    return t ? { tracks: { ...s.tracks, [LIVE_ID]: { ...t, name: title, meta: { ...t.meta, title, artist } } } } : {};
  });
}

/** The tab moved on to another song: its lyrics and title no longer apply. */
function forgetLiveSong() {
  useLyrics.setState((s) => {
    const timed = { ...s.timed };
    delete timed[LIVE_ID];
    return { byTrack: { ...s.byTrack, [LIVE_ID]: null }, timed, state: { ...s.state, [LIVE_ID]: 'done' } };
  });
  usePlayer.setState((s) => {
    const t = s.tracks[LIVE_ID];
    return t ? { tracks: { ...s.tracks, [LIVE_ID]: { ...t, name: 'Dari tab', meta: { ...t.meta, title: undefined, artist: undefined } } } } : {};
  });
}

/**
 * "This line is being sung now": lines up the tab's lyrics with what is
 * heard, allowing for the moment it takes to click.
 */
export function syncLiveLine(line: LyricLine) {
  const pos = engine.position();
  if (!pos?.live) return;
  const offset = Math.round((pos.time - 0.3 - line.t) * 100) / 100;
  useLyrics.setState((s) => ({ offsets: { ...s.offsets, [LIVE_ID]: offset } }));
}

/** Looks the playing song up again, e.g. after going back online. */
export const reloadLyrics = () => {
  const id = getState().now?.trackId;
  if (id) void load(id, true);
};

/** Uses an LRCLIB result the listener picked for the playing song, and remembers it. */
export async function chooseHit(hit: LrclibHit) {
  const id = getState().now?.trackId;
  const t = id ? getState().tracks[id] : undefined;
  if (!id || !t) return;
  const l = fromHit(hit);
  if (!l) {
    toast('Entri itu tidak berisi lirik.', 'error');
    return;
  }
  if (t.live) {
    setLiveSong(l, getLive().songStart);
    setLyrics(id, l);
    useLyrics.setState({ show: true });
    toast(l.synced ? 'Lirik dipakai. Kalau belum pas, klik baris yang sedang dinyanyikan.' : 'Lirik dipakai. Entri ini belum bertanda waktu, jadi tidak bisa mengikuti lagu.');
    return;
  }
  setLyrics(id, l);
  useLyrics.setState({ show: true });
  await savePick(t.path, hit);
  toast(l.synced ? `Lirik dipakai: ${hit.trackName} · ${hit.artistName}.` : 'Lirik dipakai. Entri ini belum bertanda waktu, jadi tidak bisa mengikuti lagu.');
}

/** Attaches an .lrc the listener picked or dropped to the playing song. */
export async function attachLrc(file: File): Promise<boolean> {
  const id = getState().now?.trackId;
  if (!id) {
    toast('Putar lagunya dulu, lalu jatuhkan file .lrc-nya.', 'error');
    return false;
  }
  const lines = parseLrc(await file.text());
  if (!lines.length) {
    toast('File itu bukan lirik LRC yang bertanda waktu.', 'error');
    return false;
  }
  setLyrics(id, { lines, synced: true, source: 'drop' });
  useLyrics.setState({ show: true });
  toast(`Lirik dimuat: ${lines.length} baris.`);
  return true;
}

export function nudgeOffset(trackId: string, delta: number) {
  const path = getState().tracks[trackId]?.path ?? trackId;
  useLyrics.setState((s) => ({ offsets: { ...s.offsets, [path]: Math.round(((s.offsets[path] ?? 0) + delta) * 10) / 10 } }));
}

export const offsetFor = (s: LyricsStore, trackId: string) => s.offsets[getState().tracks[trackId]?.path ?? trackId] ?? 0;

/** Search text for the playing song, for the panel's search box. */
export function searchText(trackId: string | undefined): string {
  const t = trackId ? getState().tracks[trackId] : undefined;
  const q = t ? songQuery(t) : null;
  return q ? [q.artist, cleanTitle(q.title)].filter(Boolean).join(' ') : '';
}

usePlayer.subscribe((s, prev) => {
  const id = s.now?.trackId;
  if (id && id !== prev.now?.trackId) void load(id);
  // The beat grid arrived: snap the word estimates to it.
  if (id && s.analysis[id]?.state === 'done' && prev.analysis[id]?.state !== 'done') retime(id);
  // Turning online lookup on finds lyrics for the song already playing.
  if (id && s.settings.lyricsOnline && !prev.settings.lyricsOnline && useLyrics.getState().byTrack[id] === null) void load(id, true);
});

/**
 * A tab's song ends without telling anyone. The lyrics know how long it is:
 * a silence near its end, or the clock running past it, means the next song.
 * A silence in the middle is the listener pausing, and the lyrics stay.
 */
useLive.subscribe((s, prev) => {
  if (!s.on) {
    if (prev.on) {
      useLyrics.setState((st) => {
        const byTrack = { ...st.byTrack };
        const timed = { ...st.timed };
        const state = { ...st.state };
        delete byTrack[LIVE_ID];
        delete timed[LIVE_ID];
        delete state[LIVE_ID];
        return { byTrack, timed, state };
      });
    }
    return;
  }
  const l = useLyrics.getState().byTrack[LIVE_ID];
  const dur = l?.credit?.duration;
  if (!l || !dur) return;
  const end = (useLyrics.getState().offsets[LIVE_ID] ?? 0) + dur;
  const newStretch = s.songStart !== prev.songStart && s.songStart > end - 15;
  const past = (engine.position()?.time ?? 0) > end + 4;
  if (newStretch || past) forgetLiveSong();
  else if (s.bpm !== prev.bpm) retime(LIVE_ID);
});

useStems.subscribe((s, prev) => {
  const id = getState().now?.trackId;
  const ready = (st: typeof s) => st.status[id ?? '']?.state === 'ready' && st.status[id ?? '']?.engine === 'ai';
  if (id && ready(s) !== ready(prev)) retime(id);
});
