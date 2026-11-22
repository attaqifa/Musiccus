import { requestAnalysis } from '../analysis/manager';
import { engine } from '../audio/engine';
import { decodeFile, renderDemo, type Decoded } from '../audio/decode';
import { computePeaks } from '../audio/peaks';
import { readMeta, type TrackMeta } from '../library/metadata';
import { filesFromList, NEEDS_WASM, walkDirectory, type FoundFile } from '../library/scan';
import { recallFolder, rememberFolder, requestPersistence } from '../lib/storage';
import { liveAnalyzer } from '../live/analyzer';
import { LIVE_ID, resetLive, useLive } from '../live/store';
import { captureTab, guessSong, TabCaptureError, type TabCapture } from '../live/tab';
import { getState, setSettings, setUi, toast, usePlayer, type RepeatMode, type Settings, type Track } from './player';

/* ------------------------------------------------------------ Library -- */

export async function getFile(t: Track): Promise<File> {
  if (t.file) return t.file;
  if (t.handle) return t.handle.getFile();
  throw new Error('File tidak tersedia.');
}

function toTracks(found: FoundFile[], existing: Record<string, Track>): Track[] {
  const out: Track[] = [];
  for (const f of found) {
    let id = f.path;
    let n = 2;
    while (existing[id]) id = `${f.path}#${n++}`;
    const t: Track = {
      id,
      path: f.path,
      name: f.name,
      ext: f.ext,
      file: f.file,
      handle: f.handle,
      metaState: 'pending',
      needsWasm: NEEDS_WASM.has(f.ext),
    };
    existing[id] = t;
    out.push(t);
  }
  return out;
}

function setLibrary(found: FoundFile[], name: string | null, replace: boolean) {
  const s = getState();
  const tracks = replace ? {} : { ...s.tracks };
  const added = toTracks(found, tracks);
  const order = replace ? added.map((t) => t.id) : [...s.order, ...added.map((t) => t.id)];
  order.sort((a, b) => collator.compare(tracks[a].path, tracks[b].path));
  usePlayer.setState({
    tracks,
    order,
    libraryName: replace ? name : (s.libraryName ?? name),
    // Songs lined up from a library that was just replaced are gone with it.
    upNext: replace ? s.upNext.filter((id) => tracks[id]) : s.upNext,
  });
  if (added.length === 0) toast('Tidak ada file audio yang dikenali di sana.');
  void parseMetadata(added.map((t) => t.id));
}

export async function openFolder(fallbackInput?: HTMLInputElement | null) {
  if (!window.showDirectoryPicker) {
    fallbackInput?.click();
    return;
  }
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await window.showDirectoryPicker({ id: 'musiccus-library', mode: 'read' });
  } catch {
    return;
  }
  await rememberFolder(dir);
  void requestPersistence();
  await loadDirectory(dir);
}

export async function resumeLastFolder(): Promise<boolean> {
  const dir = await recallFolder();
  if (!dir) return false;
  let perm = (await dir.queryPermission?.({ mode: 'read' })) ?? 'granted';
  if (perm !== 'granted') perm = (await dir.requestPermission?.({ mode: 'read' })) ?? 'denied';
  if (perm !== 'granted') {
    toast('Akses ke folder ditolak. Buka folder lagi untuk memberi izin.', 'error');
    return false;
  }
  await loadDirectory(dir);
  return true;
}

async function loadDirectory(dir: FileSystemDirectoryHandle) {
  usePlayer.setState({ scanning: true, scanFound: 0 });
  try {
    const found = await walkDirectory(dir, (n) => usePlayer.setState({ scanFound: n }));
    setLibrary(found, dir.name, true);
  } catch {
    toast('Folder tidak bisa dibaca.', 'error');
  } finally {
    usePlayer.setState({ scanning: false });
  }
}

export function addFound(found: FoundFile[], name?: string) {
  if (found.length === 0) {
    toast('Tidak ada file audio yang dikenali.');
    return;
  }
  const first = !getState().order.length;
  setLibrary(found, name ?? (first ? 'Koleksi' : null), false);
}

export function addFileList(list: FileList | null) {
  if (!list) return;
  const found = filesFromList(list);
  const root = found[0]?.path.includes('/') ? found[0].path.split('/')[0] : undefined;
  addFound(found, root);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sortOrder() {
  const { tracks, order } = getState();
  const key = (t: Track) => t.meta?.albumArtist || t.meta?.artist || '';
  const sorted = [...order].sort((a, b) => {
    const A = tracks[a];
    const B = tracks[b];
    return (
      collator.compare(key(A), key(B)) ||
      collator.compare(A.meta?.album ?? folderOf(A.path), B.meta?.album ?? folderOf(B.path)) ||
      (A.meta?.discNo ?? 1) - (B.meta?.discNo ?? 1) ||
      (A.meta?.trackNo ?? 9999) - (B.meta?.trackNo ?? 9999) ||
      collator.compare(A.path, B.path)
    );
  });
  usePlayer.setState({ order: sorted });
}

export const folderOf = (path: string) => {
  const parts = path.split('/');
  return parts.length > 1 ? parts[parts.length - 2] : '';
};

async function parseMetadata(ids: string[]) {
  let i = 0;
  const pending = new Map<string, Partial<Track>>();
  let lastFlush = performance.now();
  const flush = () => {
    if (pending.size === 0) return;
    usePlayer.setState((s) => {
      const tracks = { ...s.tracks };
      for (const [id, patch] of pending) if (tracks[id]) tracks[id] = { ...tracks[id], ...patch };
      return { tracks };
    });
    pending.clear();
    lastFlush = performance.now();
  };
  const worker = async () => {
    while (i < ids.length) {
      const id = ids[i++];
      const t = getState().tracks[id];
      if (!t) continue;
      try {
        const meta = await readMeta(await getFile(t), t.ext);
        pending.set(id, { meta, metaState: 'done' });
      } catch {
        pending.set(id, { metaState: 'error' });
      }
      if (pending.size >= 40 || performance.now() - lastFlush > 300) flush();
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  flush();
  sortOrder();
}

async function ensureMeta(t: Track): Promise<TrackMeta | undefined> {
  if (t.meta || t.synth) return t.meta;
  try {
    const meta = await readMeta(await getFile(t), t.ext);
    usePlayer.setState((s) => ({ tracks: { ...s.tracks, [t.id]: { ...s.tracks[t.id], meta, metaState: 'done' } } }));
    return meta;
  } catch {
    return undefined;
  }
}

/* ----------------------------------------------------------- Playback -- */

const DEMO_ID = 'demo:obsidian-groove';

export async function loadDemo() {
  const s = getState();
  if (!s.tracks[DEMO_ID]) {
    const demo: Track = {
      id: DEMO_ID,
      path: 'Musiccus/Demo/Obsidian groove',
      name: 'Obsidian groove',
      ext: 'synth',
      synth: true,
      metaState: 'done',
      needsWasm: false,
      meta: {
        title: 'Obsidian groove',
        artist: 'Musiccus',
        album: 'Demo',
        albumArtist: 'Musiccus',
        trackNo: 1,
        duration: 42.75,
        sampleRate: 48000,
        bitsPerSample: 32,
        channels: 2,
        codec: 'Synth',
        lossless: true,
      },
    };
    usePlayer.setState((st) => ({
      tracks: { ...st.tracks, [DEMO_ID]: demo },
      order: [DEMO_ID, ...st.order],
      libraryName: st.libraryName ?? 'Demo',
    }));
  }
  await playQueue([DEMO_ID, ...getState().order.filter((id) => id !== DEMO_ID)], 0);
}

const decoded = new Map<string, Decoded>();
let demoRender: { rate: number; promise: Promise<Decoded> } | null = null;

/** Renders the demo ahead of time so the "try demo" button starts instantly. */
export function prepareDemo(rate = 48000): Promise<Decoded> {
  if (!demoRender || demoRender.rate !== rate) {
    const promise = renderDemo(rate);
    demoRender = { rate, promise };
    promise.catch(() => (demoRender = null));
  }
  return demoRender.promise;
}
let playRequest = 0;
let prefetchTimer = 0;

function targetRate(settings: Settings): number | 'native' {
  return settings.rateMode === 'device' ? getState().deviceRate : 'native';
}

async function decodeTrack(t: Track): Promise<Decoded> {
  const cached = decoded.get(t.id);
  const settings = getState().settings;
  const want = targetRate(settings);
  if (cached && (want === 'native' ? !cached.resampled : cached.buffer.sampleRate === want)) return cached;
  let d: Decoded;
  if (t.synth) {
    d = await prepareDemo(want === 'native' ? 48000 : want);
  } else {
    const meta = await ensureMeta(t);
    d = await decodeFile(await getFile(t), t.ext, meta?.sampleRate, want);
  }
  decoded.set(t.id, d);
  return d;
}

/** The decoded buffer of a track that is playing or queued, if still in memory. */
export const getDecoded = (id: string | undefined) => (id ? decoded.get(id) : undefined);

/** Keeps memory bounded: only the playing and the queued buffer stay decoded. */
function pruneDecoded(keep: (string | undefined)[]) {
  for (const id of decoded.keys()) if (!keep.includes(id)) decoded.delete(id);
}

export function rgFor(t: Track | undefined, settings: Settings = getState().settings): number {
  if (!t?.meta || settings.rgMode === 'off') return 0;
  const m = t.meta;
  const gain = settings.rgMode === 'album' ? (m.rgAlbumGain ?? m.rgTrackGain) : m.rgTrackGain;
  if (gain === undefined) return 0;
  const peak = settings.rgMode === 'album' ? (m.rgAlbumPeak ?? m.rgTrackPeak) : m.rgTrackPeak;
  let db = gain + settings.rgPreamp;
  if (peak && peak > 0) db = Math.min(db, -20 * Math.log10(peak));
  return db;
}

function nextPlayable(queue: string[], from: number): number {
  const { tracks } = getState();
  for (let i = from; i < queue.length; i++) if (tracks[queue[i]] && !tracks[queue[i]].needsWasm) return i;
  return -1;
}

function setNow(t: Track, d: Decoded, rgDb: number) {
  usePlayer.setState({
    now: {
      trackId: t.id,
      decoder: d.decoder,
      sourceRate: d.sourceRate,
      engineRate: engine.sampleRate || d.buffer.sampleRate,
      resampled: d.resampled,
      duration: d.buffer.duration,
      channels: d.buffer.numberOfChannels,
      rgDb,
      peaks: null,
    },
  });
  window.setTimeout(() => {
    const peaks = computePeaks(d.buffer);
    usePlayer.setState((s) => (s.now?.trackId === t.id ? { now: { ...s.now, peaks } } : {}));
    void requestAnalysis(getState().tracks[t.id] ?? t, d.buffer, d.resampled);
  }, 30);
}

/* -------------------------------------------------------------- Queue -- */

/**
 * Where a song to play comes from: the queue (at `index`), the listener's
 * up-next list, or the playing song again (Ulang satu).
 */
interface Pick {
  id: string;
  source: 'queue' | 'up' | 'again';
  index: number;
}

/** Fisher–Yates; `first` (when it is in the list) stays at the front. */
function shuffled(ids: string[], first?: string): string[] {
  const rest = ids.filter((id) => id !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return first !== undefined && ids.includes(first) ? [first, ...rest] : rest;
}

const atQueue = (index: number): Pick => ({ id: getState().queue[index], source: 'queue', index });

/**
 * The song after this one. `auto` means the song ended by itself, which is the
 * only time Ulang satu plays it again; skipping always moves on.
 */
function pickNext(auto: boolean): Pick | null {
  const s = getState();
  const cur = s.now?.trackId;
  if (auto && s.settings.repeat === 'one' && cur && !s.tracks[cur]?.live) return { id: cur, source: 'again', index: s.queueIndex };
  if (s.upNext.length) return { id: s.upNext[0], source: 'up', index: -1 };
  let ni = nextPlayable(s.queue, s.queueIndex + 1);
  if (ni < 0 && s.settings.repeat !== 'off') ni = nextPlayable(s.queue, 0);
  return ni >= 0 ? atQueue(ni) : null;
}

/** Makes a pick the playing position: up-next songs are used up, queue songs move the index. */
function commitPick(p: Pick) {
  if (p.source === 'again') return;
  if (p.source === 'queue') {
    usePlayer.setState({ queueIndex: p.index, fromUp: false });
    return;
  }
  usePlayer.setState((s) => {
    const i = s.upNext.indexOf(p.id);
    return { upNext: i < 0 ? s.upNext : [...s.upNext.slice(0, i), ...s.upNext.slice(i + 1)], fromUp: true };
  });
}

/** The pick the engine has lined up gaplessly, committed when it starts. */
let scheduled: Pick | null = null;
/** Songs that failed in a row; stops Ulang semua from cycling through a folder of broken files forever. */
let failStreak = 0;

/** What comes next changed (Acak, Ulang, up next, sleep timer): line it up again. */
export function requeue() {
  if (tab || !getState().now) return;
  engine.clearNext();
  scheduled = null;
  schedulePrefetch();
}

/**
 * Plays songs from a list (a library view, an album, a harmonic path). With
 * Acak on, the chosen song plays first and the rest are shuffled. `inOrder`
 * is for lists whose order is the point, and turns Acak off.
 */
export async function playQueue(list: string[], index: number, offset = 0, opts: { inOrder?: boolean } = {}) {
  const start = nextPlayable(list, index);
  if (start < 0) {
    toast('Format ini belum bisa diputar di Musiccus.', 'error');
    return;
  }
  const s = getState();
  if (opts.inOrder && s.settings.shuffle) setSettings({ shuffle: false });
  // Playing from the current queue again keeps its order instead of reshuffling it.
  if (list === s.queue) return playPick(atQueue(start), offset);
  const shuffle = getState().settings.shuffle;
  const queue = shuffle ? shuffled(list, list[start]) : list;
  usePlayer.setState({ queue, baseQueue: list, queueIndex: -1, fromUp: false });
  await playPick(shuffle ? atQueue(0) : atQueue(start), offset);
}

/** A queue saved by Lanjutkan (see session.ts), by track id. */
export interface SavedQueue {
  queue?: string[];
  baseQueue?: string[];
  upNext?: string[];
  /** The queue song the saved song interrupted, or the saved song itself. */
  at?: string;
  fromUp?: boolean;
}

/**
 * Carries on from a saved queue: songs that are no longer in the folder are
 * dropped, and without a saved queue the whole library follows the song.
 */
export async function resumeQueue(id: string, saved: SavedQueue, offset: number) {
  const { tracks, order, settings } = getState();
  if (!tracks[id]) return;
  const keep = (ids?: string[]) => (ids ?? []).filter((x) => tracks[x]);
  let baseQueue = keep(saved.baseQueue);
  let queue = keep(saved.queue);
  if (!baseQueue.length || queue.length !== baseQueue.length) {
    baseQueue = baseQueue.length ? baseQueue : order;
    queue = settings.shuffle ? shuffled(baseQueue, id) : baseQueue;
  }
  const fromUp = !!saved.fromUp && !!saved.at && saved.at !== id;
  usePlayer.setState({
    queue,
    baseQueue,
    upNext: keep(saved.upNext),
    queueIndex: queue.indexOf(fromUp ? saved.at! : id),
    fromUp,
  });
  await playPick({ id, source: 'again', index: getState().queueIndex }, offset);
}

/** Plays the song that is playing now from `offset`. */
export async function replayCurrent(offset = 0) {
  const s = getState();
  const id = s.now?.trackId;
  if (!id || tab) return;
  await playPick({ id, source: 'again', index: s.queueIndex }, offset);
}

async function playPick(p: Pick, offset = 0) {
  if (tab) {
    endTab();
    usePlayer.setState({ now: null });
  }
  const req = ++playRequest;
  window.clearTimeout(prefetchTimer);
  scheduled = null;
  commitPick(p);
  usePlayer.setState({ status: 'loading' });
  const t = getState().tracks[p.id];
  try {
    if (!t) throw new Error('Lagu ini sudah tidak ada di library.');
    const d = await decodeTrack(t);
    if (req !== playRequest) return;
    const rg = rgFor(t);
    await engine.play(t.id, d.buffer, offset, rg);
    if (req !== playRequest) return;
    setNow(t, d, rg);
    usePlayer.setState({ status: 'playing' });
    failStreak = 0;
    pruneDecoded([t.id]);
    schedulePrefetch();
  } catch (e) {
    if (req !== playRequest) return;
    // The toast shows only the message; the console keeps the stack for diagnosis.
    console.error('Musiccus: playback failed', e);
    toast(e instanceof Error ? e.message : 'Lagu ini tidak bisa diputar.', 'error');
    usePlayer.setState({ status: getState().now ? 'paused' : 'idle' });
    const after = pickNext(false);
    if (after && after.id !== p.id && ++failStreak < Math.min(getState().queue.length + 1, 50)) void playPick(after);
    else failStreak = 0;
  }
}

/** Acak on or off. The playing song stays where it is; only what follows changes. */
export function setShuffle(on: boolean) {
  setSettings({ shuffle: on });
  const s = getState();
  if (!s.baseQueue.length) return;
  const cur = s.fromUp ? undefined : s.queue[s.queueIndex];
  if (on) {
    const queue = shuffled(s.baseQueue, cur);
    usePlayer.setState({ queue, queueIndex: cur !== undefined ? 0 : -1 });
  } else {
    // After an up-next song, continue from the queue song it interrupted.
    const at = s.queue[s.queueIndex];
    usePlayer.setState({ queue: s.baseQueue, queueIndex: at !== undefined ? s.baseQueue.indexOf(at) : -1 });
  }
  requeue();
}

const REPEAT_ORDER: Record<RepeatMode, RepeatMode> = { off: 'all', all: 'one', one: 'off' };

/** Ulang: off → semua → satu → off. */
export function cycleRepeat() {
  setSettings({ repeat: REPEAT_ORDER[getState().settings.repeat] });
  requeue();
}

const titleOf = (t: Track) => t.meta?.title || t.name.replace(/\.[^.]+$/, '');

/**
 * Lines songs up after the playing one (`next`) or at the end of the
 * up-next list. With nothing playing they simply start.
 */
export function enqueue(ids: string[], where: 'next' | 'end') {
  const { tracks, now } = getState();
  const ok = ids.filter((id) => tracks[id] && !tracks[id].needsWasm && !tracks[id].live);
  if (!ok.length) {
    toast('Format ini belum bisa diputar di Musiccus.', 'error');
    return;
  }
  if (!now || tab) {
    void playQueue(ok, 0);
    return;
  }
  usePlayer.setState((s) => ({ upNext: where === 'next' ? [...ok, ...s.upNext] : [...s.upNext, ...ok] }));
  const what = ok.length === 1 ? `“${titleOf(tracks[ok[0]])}”` : `${ok.length} lagu`;
  toast(where === 'next' ? `${what} diputar setelah lagu ini.` : `${what} masuk antrean.`);
  requeue();
}

export function removeUpNext(index: number) {
  usePlayer.setState((s) => ({ upNext: s.upNext.filter((_, i) => i !== index) }));
  requeue();
}

export function clearUpNext() {
  usePlayer.setState({ upNext: [] });
  requeue();
}

/** Jumps to an up-next song; the ones before it are skipped. */
export async function playUpNext(index: number) {
  const s = getState();
  const id = s.upNext[index];
  if (!id) return;
  usePlayer.setState({ upNext: s.upNext.slice(index) });
  await playPick({ id, source: 'up', index: -1 });
}

/** Jumps to a song further down the queue. */
export async function playQueueAt(index: number) {
  if (getState().queue[index] !== undefined) await playPick(atQueue(index));
}

function schedulePrefetch() {
  window.clearTimeout(prefetchTimer);
  prefetchTimer = window.setTimeout(prefetchNext, 1500);
}

async function prefetchNext() {
  const { tracks, now, sleep } = getState();
  // A sleep timer set to the end of this song: nothing follows it.
  if (!now || tab || sleep?.kind === 'track') return;
  const p = pickNext(true);
  const t = p && tracks[p.id];
  if (!p || !t) return;
  const req = playRequest;
  try {
    const d = await decodeTrack(t);
    if (req !== playRequest || getState().now?.trackId !== now.trackId) return;
    pruneDecoded([now.trackId, t.id]);
    if (engine.canGapless(d.buffer) && engine.scheduleNext(t.id, d.buffer, rgFor(t))) scheduled = p;
  } catch {
    /* surfaced when the track actually plays */
  }
}

engine.on('advance', ({ id }) => {
  const s = getState();
  const t = s.tracks[id];
  const d = decoded.get(id);
  if (!t || !d) return;
  const idx = s.queue.indexOf(id);
  const p = scheduled?.id === id ? scheduled : { id, source: 'queue' as const, index: idx >= 0 ? idx : s.queueIndex };
  scheduled = null;
  commitPick(p);
  usePlayer.setState({ status: 'playing' });
  setNow(t, d, rgFor(t));
  pruneDecoded([id]);
  schedulePrefetch();
});

engine.on('ended', () => {
  scheduled = null;
  if (getState().sleep?.kind === 'track') {
    usePlayer.setState({ status: 'ended', sleep: null });
    toast('Timer tidur: musik berhenti di akhir lagu.');
    return;
  }
  const p = pickNext(true);
  if (p) void playPick(p);
  else usePlayer.setState({ status: 'ended' });
});

/* ------------------------------------------------- Listening to a tab -- */

let tab: TabCapture | null = null;

/** Asks the browser to share a tab's sound and plays it through Musiccus. */
export async function listenToTab() {
  let cap: TabCapture | null;
  try {
    cap = await captureTab();
  } catch (e) {
    console.error('Musiccus: tab capture failed', e);
    toast(e instanceof TabCaptureError ? e.message : 'Tab tidak bisa dibagikan.', 'error', 8000);
    return;
  }
  if (!cap) return;
  ++playRequest;
  window.clearTimeout(prefetchTimer);
  endTab();
  try {
    await engine.playStream(LIVE_ID, cap.stream, cap.monitor);
  } catch (e) {
    console.error('Musiccus: tab playback failed', e);
    for (const t of cap.stream.getTracks()) t.stop();
    toast('Suara tab tidak bisa diputar.', 'error');
    return;
  }
  tab = cap;
  const rate = engine.sampleRate;
  const sourceRate = cap.rate || rate;
  liveAnalyzer.start(rate);
  resetLive({ on: true, monitor: cap.monitor, rate: sourceRate });
  const song = guessSong(cap.label);
  const track: Track = {
    id: LIVE_ID,
    path: LIVE_ID,
    name: song?.title || 'Dari tab',
    ext: 'live',
    live: true,
    metaState: 'done',
    needsWasm: false,
    meta: { title: song?.title || undefined, artist: song?.artist || undefined, codec: 'Live', sampleRate: sourceRate, channels: 2 },
  };
  usePlayer.setState((s) => ({
    tracks: { ...s.tracks, [LIVE_ID]: track },
    now: { trackId: LIVE_ID, decoder: 'live', sourceRate, engineRate: rate, resampled: false, duration: Infinity, channels: 2, rgDb: 0, peaks: null },
    status: 'playing',
  }));
  pruneDecoded([]);
  for (const t of cap.stream.getTracks()) t.addEventListener('ended', onTabEnded);
  if (!cap.monitor) toast('Browser tetap memutar suara tab itu sendiri, jadi Musiccus hanya menampilkan visualnya.', 'info', 8000);
}

function onTabEnded() {
  stopListening('Tab berhenti dibagikan.');
}

/** Ends the capture and frees the engine; what plays next is up to the caller. */
function endTab() {
  const t = tab;
  if (!t) return;
  tab = null;
  for (const tr of t.stream.getTracks()) {
    tr.removeEventListener('ended', onTabEnded);
    tr.stop();
  }
  liveAnalyzer.stop();
  engine.stopLive();
  resetLive();
  usePlayer.setState((s) => {
    const tracks = { ...s.tracks };
    delete tracks[LIVE_ID];
    return { tracks };
  });
}

/** Stops listening to the tab. */
export function stopListening(message?: string) {
  if (!tab) return;
  endTab();
  usePlayer.setState({ now: null, status: 'idle' });
  if (message) toast(message);
}

/** Plays the tab's sound through Musiccus, or leaves it to the tab (visuals only). */
export function setLiveMonitor(on: boolean) {
  engine.setLiveMonitor(on);
  useLive.setState({ monitor: on });
}

const LIVE_CONTROLS = 'Jeda dan ganti lagu di tab sumbernya, atau dengan tombol media di keyboard.';

export async function togglePlay() {
  if (tab) {
    toast(LIVE_CONTROLS);
    return;
  }
  const { status, order } = getState();
  if (status === 'playing') {
    usePlayer.setState({ status: 'paused' });
    await engine.pause();
  } else if (status === 'paused') {
    await engine.resume();
    usePlayer.setState({ status: 'playing' });
  } else if (status === 'ended') {
    // Songs lined up after the end play first; otherwise the last song starts again.
    const up = getState().upNext[0];
    if (up) await playPick({ id: up, source: 'up', index: -1 });
    else await replayCurrent();
  } else if (status === 'idle' && order.length) {
    await playQueue(order, 0);
  }
}

export async function next() {
  if (tab) return toast(LIVE_CONTROLS);
  const p = pickNext(false);
  if (p) await playPick(p);
}

export async function prev() {
  if (tab) return toast(LIVE_CONTROLS);
  const { queue, queueIndex, fromUp, tracks, settings } = getState();
  const pos = engine.position();
  if (pos && pos.time > 3) {
    seek(0);
    return;
  }
  // From an up-next song, back is the queue song it interrupted.
  if (fromUp && queue[queueIndex] !== undefined) {
    await playPick(atQueue(queueIndex));
    return;
  }
  const ok = (i: number) => tracks[queue[i]] && !tracks[queue[i]].needsWasm;
  for (let i = queueIndex - 1; i >= 0; i--) {
    if (ok(i)) return playPick(atQueue(i));
  }
  if (settings.repeat !== 'off') {
    for (let i = queue.length - 1; i > queueIndex; i--) {
      if (ok(i)) return playPick(atQueue(i));
    }
  }
  seek(0);
}

export function seek(sec: number) {
  if (tab) return;
  engine.seek(sec);
  window.clearTimeout(prefetchTimer);
  schedulePrefetch();
}

export function seekBy(delta: number) {
  const p = engine.position();
  if (p) seek(Math.max(0, Math.min(p.duration - 0.5, p.time + delta)));
}

/* ----------------------------------------------------------- Settings -- */

export function setVolume(db: number) {
  const v = Math.max(-60, Math.min(0, db));
  setSettings({ volumeDb: v, muted: false });
  engine.setVolume(v);
}

export function toggleMute() {
  const { muted, volumeDb } = getState().settings;
  setSettings({ muted: !muted });
  engine.setVolume(!muted ? -Infinity : volumeDb);
}

export function setRgMode(mode: Settings['rgMode']) {
  setSettings({ rgMode: mode });
  applyReplayGain();
}

function applyReplayGain() {
  const s = getState();
  if (!s.now) return;
  const t = s.tracks[s.now.trackId];
  const rg = rgFor(t);
  engine.setReplayGain(rg);
  usePlayer.setState({ now: { ...s.now, rgDb: rg } });
  requeue();
}

export function setAvOffset(ms: number) {
  setSettings({ avOffsetMs: ms });
  engine.offsetMs = ms;
}

export async function initEngine() {
  const s = getState();
  engine.offsetMs = s.settings.avOffsetMs;
  engine.setVolume(s.settings.muted ? -Infinity : s.settings.volumeDb);
  const rate = await engine.detectDeviceRate();
  usePlayer.setState({ deviceRate: rate });
}

export function closeOverlays() {
  setUi({ settings: false, calibration: false, help: false, sonicMap: false, queue: false });
}
