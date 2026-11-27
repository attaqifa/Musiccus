import { create } from 'zustand';
import type { ChordView } from '../analysis/chordView';
import type { DecoderKind } from '../audio/decode';
import type { TrackMeta } from '../library/metadata';
import { loadJSON, saveJSON } from '../lib/storage';
import type { HeadphoneProfile } from '../studio/headphone';

export interface Track {
  id: string;
  path: string;
  name: string;
  ext: string;
  file?: File;
  handle?: FileSystemFileHandle;
  synth?: boolean;
  /** A captured browser tab, not a file. */
  live?: boolean;
  meta?: TrackMeta;
  metaState: 'pending' | 'done' | 'error';
  needsWasm: boolean;
}

export type WorldId = 'nebula' | 'terrain' | 'aurora';
export const WORLD_IDS: readonly WorldId[] = ['nebula', 'terrain', 'aurora'];
/** Render quality the visual engine runs at. */
export type Quality = 'low' | 'medium' | 'high' | 'ultra';
/** What the listener picks in Settings: Otomatis follows the device. */
export type QualityChoice = 'auto' | 'eco' | 'high';
export type RgMode = 'off' | 'track' | 'album';
export type RateMode = 'source' | 'device';
export type Status = 'idle' | 'loading' | 'playing' | 'paused' | 'ended';
export type Mode = 'dengar' | 'pahami' | 'bentuk' | 'stem';
export type ColorSource = 'music' | 'cover' | 'mono';
/** Off, the whole queue again, or the same song again. */
export type RepeatMode = 'off' | 'all' | 'one';
/** Stop after a number of minutes, or when the playing song ends. */
export type SleepTimer = { kind: 'time'; at: number; minutes: number } | { kind: 'track' };

export interface Settings {
  rateMode: RateMode;
  rgMode: RgMode;
  rgPreamp: number;
  world: WorldId;
  quality: QualityChoice;
  avOffsetMs: number;
  volumeDb: number;
  muted: boolean;
  /** Where visual colours come from: the song's key, its cover art, or graphite. */
  colorSource: ColorSource;
  /** Look up lyrics on LRCLIB when a song has none of its own. */
  lyricsOnline: boolean;
  /** The listener's headphones and their AutoEQ correction. */
  headphone: HeadphoneProfile | null;
  headphoneOn: boolean;
  /** Blend a little of each channel into the other ear, like speakers in a room. */
  crossfeed: boolean;
  /** The meter bridge (Pantau) under the stage. */
  meters: boolean;
  /** Chords for playing along (short ones folded away) or every change the analysis heard. */
  chordView: ChordView;
  /** Play the queue in a random order. */
  shuffle: boolean;
  repeat: RepeatMode;
}

export interface AnalysisStatus {
  state: 'queued' | 'running' | 'done' | 'error';
  stage: string;
  progress: number;
  error?: string;
}

export interface NowPlaying {
  trackId: string;
  decoder: DecoderKind;
  sourceRate: number;
  engineRate: number;
  resampled: boolean;
  duration: number;
  channels: number;
  rgDb: number;
  peaks: Float32Array | null;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  text: string;
}

export interface UiState {
  library: boolean;
  inspector: boolean;
  hidden: boolean;
  settings: boolean;
  calibration: boolean;
  help: boolean;
  mode: Mode;
  /** The collection galaxy covers the stage. */
  sonicMap: boolean;
  /** The queue and sleep timer popover above the transport. */
  queue: boolean;
}

interface PlayerState {
  tracks: Record<string, Track>;
  order: string[];
  libraryName: string | null;
  scanning: boolean;
  scanFound: number;
  /** What plays, in playing order (shuffled when Acak is on). */
  queue: string[];
  /** The same songs in the order they were picked, to return to when Acak is turned off. */
  baseQueue: string[];
  queueIndex: number;
  /** Songs the listener lined up with Putar berikutnya or Tambah ke antrean; they play before the queue continues. */
  upNext: string[];
  /** The playing song came from upNext, so queueIndex still points at the last song of the queue. */
  fromUp: boolean;
  sleep: SleepTimer | null;
  now: NowPlaying | null;
  status: Status;
  deviceRate: number;
  settings: Settings;
  ui: UiState;
  toasts: Toast[];
  analysis: Record<string, AnalysisStatus>;
}

/**
 * Below this width the library and inspector become drawers over the stage,
 * and only one of them fits at a time.
 */
export const compactQuery = typeof matchMedia === 'function' ? matchMedia('(max-width: 960px)') : null;
export const isCompact = () => compactQuery?.matches ?? false;

/**
 * The render quality "Otomatis" picks for this device: phones, tablets and
 * machines with few cores or little memory get medium (or low), so the
 * visuals do not run hot.
 */
function deviceQuality(): Quality {
  if (typeof navigator === 'undefined') return 'high';
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency || 4;
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  if (memory <= 2) return 'low';
  if (touch || cores <= 4 || memory <= 4) return 'medium';
  return 'high';
}

const DEFAULT_SETTINGS: Settings = {
  rateMode: 'source',
  rgMode: 'off',
  rgPreamp: 0,
  world: 'nebula',
  quality: 'auto',
  avOffsetMs: 0,
  volumeDb: -6,
  muted: false,
  colorSource: 'music',
  lyricsOnline: true,
  headphone: null,
  headphoneOn: true,
  crossfeed: false,
  meters: false,
  chordView: 'simple',
  shuffle: false,
  repeat: 'off',
};

const QUALITY: Record<Exclude<QualityChoice, 'auto'>, Quality> = { eco: 'low', high: 'ultra' };

/** The render quality for a Settings choice. */
export const renderQuality = (q: QualityChoice): Quality => (q === 'auto' ? deviceQuality() : QUALITY[q]);

const SETTINGS_KEY = 'musiccus:settings';

/** Saved settings, with values from older versions mapped to what exists now. */
function loadSettings(): Settings {
  const saved = loadJSON<Record<string, unknown>>(SETTINGS_KEY, {});
  const s = { ...DEFAULT_SETTINGS, ...saved } as Settings & { vuRef?: number; bloom?: number; director?: boolean; detail?: boolean; detailPicked?: boolean };
  // The Cymatics and Stereo worlds were removed; anyone who last used one lands on Nebula.
  if (!WORLD_IDS.includes(s.world)) s.world = 'nebula';
  // Older versions stored a render level. The device's own pick was saved
  // as if chosen, so only the extremes count as a real choice.
  const q = saved.quality;
  if (q === 'low') s.quality = 'eco';
  else if (q === 'ultra') s.quality = 'high';
  else if (q !== 'eco' && q !== 'high') s.quality = 'auto';
  delete s.vuRef;
  delete s.bloom;
  // Auto visual switching (Sutradara) was removed.
  delete s.director;
  // The engine rate and ReplayGain preamp no longer have controls; keep the defaults.
  s.rateMode = DEFAULT_SETTINGS.rateMode;
  s.rgPreamp = DEFAULT_SETTINGS.rgPreamp;
  // The Sederhana/Detail switch was removed; everything is always shown.
  delete s.detail;
  delete s.detailPicked;
  return s;
}

export const usePlayer = create<PlayerState>(() => ({
  tracks: {},
  order: [],
  libraryName: null,
  scanning: false,
  scanFound: 0,
  queue: [],
  baseQueue: [],
  queueIndex: -1,
  upNext: [],
  fromUp: false,
  sleep: null,
  now: null,
  status: 'idle',
  deviceRate: 48000,
  settings: loadSettings(),
  ui: { library: !isCompact(), inspector: !isCompact(), hidden: false, settings: false, calibration: false, help: false, mode: 'dengar', sonicMap: false, queue: false },
  toasts: [],
  analysis: {},
}));

usePlayer.subscribe((s, prev) => {
  if (s.settings !== prev.settings) saveJSON(SETTINGS_KEY, s.settings);
});

export const getState = usePlayer.getState;

export function setSettings(patch: Partial<Settings>) {
  usePlayer.setState((s) => ({ settings: { ...s.settings, ...patch } }));
}

export function setUi(patch: Partial<UiState>) {
  usePlayer.setState((s) => {
    const ui = { ...s.ui, ...patch };
    // As drawers on a small screen, opening one panel closes the other.
    if (isCompact()) {
      if (patch.library && !s.ui.library) ui.inspector = false;
      else if (patch.inspector && !s.ui.inspector) ui.library = false;
    }
    return { ui };
  });
}

/** Closes the library and inspector drawers (small screens). */
export const closeDrawers = () => setUi({ library: false, inspector: false });

// Shrinking the window to drawer size with both panels open keeps only the inspector.
compactQuery?.addEventListener('change', (e) => {
  const { ui } = getState();
  if (e.matches && ui.library && ui.inspector) setUi({ library: false });
});

let toastId = 0;
const toastTimers = new Map<number, number>();
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 5200) {
  // The same message again (a run of songs failing alike) keeps the one shown up longer instead of stacking.
  const same = getState().toasts.find((t) => t.text === text && t.kind === kind);
  const id = same?.id ?? ++toastId;
  if (!same) usePlayer.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
  window.clearTimeout(toastTimers.get(id));
  toastTimers.set(
    id,
    window.setTimeout(() => {
      toastTimers.delete(id);
      usePlayer.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, ms),
  );
}

export const currentTrack = (s: PlayerState = getState()): Track | undefined =>
  s.now ? s.tracks[s.now.trackId] : undefined;

export function setAnalysisStatus(id: string, status: AnalysisStatus) {
  usePlayer.setState((s) => ({ analysis: { ...s.analysis, [id]: status } }));
}
