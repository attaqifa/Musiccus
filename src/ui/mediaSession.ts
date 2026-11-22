import { engine } from '../audio/engine';
import { songLabel } from '../library/display';
import { readCover } from '../library/metadata';
import { getFile, next, prev, seek, seekBy, togglePlay } from '../store/controller';
import { getState, usePlayer, type Track } from '../store/player';

/**
 * Hands the song to the operating system: title and cover in the Windows media
 * overlay, the Android notification and the lock screen, and the play, pause,
 * next and previous keys on keyboards and Bluetooth headphones, even while
 * another window has focus.
 *
 * Browsers only give a page a media session while one of its media elements
 * plays; Web Audio alone does not count. So a looping element of pure digital
 * silence plays alongside the engine. It adds zeros to the output, which leaves
 * the sound untouched.
 *
 * A captured tab is left alone: its own page (Spotify, YouTube Music) keeps the
 * session, so the media keys still reach the player that can act on them.
 */

const ms = typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : null;

/** Eight seconds of 8 kHz 8-bit silence (64 KB); Android wants media of five seconds or more. */
function silentWav(seconds = 8, rate = 8000): Blob {
  const n = seconds * rate;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const tag = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + n, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true); // bytes per second
  v.setUint16(32, 1, true); // block align
  v.setUint16(34, 8, true); // bits per sample
  tag(36, 'data');
  v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128); // unsigned 8-bit: 128 is zero
  return new Blob([buf], { type: 'audio/wav' });
}

let silence: HTMLAudioElement | null = null;
let silenceUrl = '';

function holdSession(playing: boolean) {
  if (!silence) {
    silenceUrl ||= URL.createObjectURL(silentWav());
    silence = new Audio();
    silence.loop = true;
  }
  if (!silence.getAttribute('src')) silence.src = silenceUrl;
  if (!playing) silence.pause();
  else if (silence.paused) void silence.play().catch(() => undefined);
}

/** Drops the session entirely, so another page's player gets the media keys. */
function releaseSession() {
  if (!silence?.getAttribute('src')) return;
  silence.pause();
  silence.removeAttribute('src');
  silence.load();
}

/**
 * One press can arrive twice while Musiccus has focus: as a key event and as a
 * media session action. Both paths claim it here, and the second is ignored.
 */
const claimed: Record<string, number> = {};
export function claimMediaKey(kind: 'toggle' | 'next' | 'prev'): boolean {
  const now = performance.now();
  if (now - (claimed[kind] ?? -Infinity) < 400) return false;
  claimed[kind] = now;
  return true;
}

function syncPosition() {
  if (!ms?.setPositionState) return;
  const p = engine.position();
  try {
    if (!p || p.live || !Number.isFinite(p.duration) || p.duration <= 0) ms.setPositionState();
    else ms.setPositionState({ duration: p.duration, position: Math.min(p.time, p.duration), playbackRate: engine.speed });
  } catch {
    // Rejected values (a rate of zero mid-change) only cost the OS its progress bar.
  }
}

const appIcon = () => new URL('icons/icon-512.png', document.baseURI).href;

let metaKey = '';

function setMetadata(t: Track) {
  const m = t.meta;
  const label = songLabel(t);
  const title = label.title;
  const artist = label.artist || (t.synth ? 'Musiccus' : '');
  const album = m?.album || '';
  const key = `${t.id}\n${title}\n${artist}\n${album}`;
  if (key === metaKey) return;
  metaKey = key;
  const icon = appIcon();
  ms!.metadata = new MediaMetadata({ title, artist, album, artwork: [{ src: icon, sizes: '512x512', type: 'image/png' }] });
  if (t.synth) return;
  void readCover(t.id, () => getFile(t)).then((url) => {
    if (!url || metaKey !== key || !ms!.metadata) return;
    ms!.metadata.artwork = [{ src: url }, { src: icon, sizes: '512x512', type: 'image/png' }];
  });
}

function update() {
  if (!ms) return;
  const s = getState();
  const t = s.now ? s.tracks[s.now.trackId] : undefined;
  if (!t || t.live || s.status === 'idle') {
    releaseSession();
    metaKey = '';
    ms.metadata = null;
    ms.playbackState = 'none';
    return;
  }
  const playing = s.status === 'playing' || s.status === 'loading';
  setMetadata(t);
  ms.playbackState = playing ? 'playing' : 'paused';
  holdSession(playing);
  syncPosition();
}

function on(action: MediaSessionAction, handler: MediaSessionActionHandler) {
  try {
    ms!.setActionHandler(action, handler);
  } catch {
    // This browser does not know the action; its OS controls simply lack it.
  }
}

if (ms) {
  const status = () => getState().status;
  on('play', () => status() !== 'playing' && claimMediaKey('toggle') && void togglePlay());
  on('pause', () => status() === 'playing' && claimMediaKey('toggle') && void togglePlay());
  on('stop', () => status() === 'playing' && void togglePlay());
  on('nexttrack', () => claimMediaKey('next') && void next());
  on('previoustrack', () => claimMediaKey('prev') && void prev());
  on('seekbackward', (d) => seekBy(-(d.seekOffset ?? 10)));
  on('seekforward', (d) => seekBy(d.seekOffset ?? 10));
  on('seekto', (d) => {
    if (d.seekTime == null) return;
    seek(d.seekTime);
    syncPosition();
  });

  usePlayer.subscribe((s, p) => {
    const id = s.now?.trackId;
    if (s.status !== p.status || id !== p.now?.trackId || (id && s.tracks[id] !== p.tracks[id])) update();
  });
  // Seeks and speed changes from inside the app; the OS extrapolates in between.
  window.setInterval(() => {
    if (getState().status === 'playing' && silence?.getAttribute('src')) syncPosition();
  }, 2000);
  update();
}
