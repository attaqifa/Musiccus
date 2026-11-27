import { create } from 'zustand';
import { loadJSON, saveJSON } from '../lib/storage';
import { toast, undoToast } from '../store/player';
import { PRESETS, presetState, type PresetId } from './presets';
import { DEFAULT_STUDIO, studioProcessing, type StudioState } from './types';

export interface ExportJob {
  progress: number;
  stage: string;
}

/** A rack the listener saved under their own name ("Racikan saya"). */
export interface SavedMix {
  /** Always starts with `my:`, so it never collides with a preset id. */
  id: string;
  name: string;
  state: StudioState;
}

export const MAX_MIXES = 6;

interface StudioStore {
  state: StudioState;
  /** The preset or saved mix the rack started from. */
  preset: PresetId | string;
  /** The listener moved a slider after picking the preset. */
  tweaked: boolean;
  /** Playing the original for comparison ("Dengar asli"). Never saved. */
  compare: boolean;
  mixes: SavedMix[];
  exporting: ExportJob | null;
}

// A new key: racks saved by the old detailed studio (headphone profiles,
// compressor settings) have no controls any more, so everyone starts clean.
const STATE_KEY = 'musiccus:sound';
const MIXES_KEY = 'musiccus:my-mixes';

interface Saved {
  state: Partial<StudioState>;
  preset: string;
  tweaked: boolean;
}

/** A full rack from a saved one, with fields added in later versions at their defaults. */
function complete(saved: Partial<StudioState> | undefined): StudioState {
  const state = structuredClone(DEFAULT_STUDIO);
  for (const key of Object.keys(state) as (keyof StudioState)[]) {
    if (saved?.[key]) Object.assign(state[key], saved[key]);
  }
  // The headphone stage comes from Settings, never from a saved rack.
  state.headphone = structuredClone(DEFAULT_STUDIO.headphone);
  return state;
}

/** loadJSON merges into an object, which would turn the saved list into one. */
function loadMixes(): SavedMix[] {
  let list: unknown;
  try {
    list = JSON.parse(localStorage.getItem(MIXES_KEY) ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return (list as Partial<SavedMix>[])
    .filter((m): m is SavedMix => !!m && typeof m.id === 'string' && m.id.startsWith('my:') && typeof m.name === 'string')
    .slice(0, MAX_MIXES)
    .map((m) => ({ ...m, state: complete(m.state) }));
}

function load(): Pick<StudioStore, 'state' | 'preset' | 'tweaked' | 'mixes'> {
  const saved = loadJSON<Saved | null>(STATE_KEY, null);
  const mixes = loadMixes();
  if (!saved) return { state: complete(undefined), preset: 'asli', tweaked: false, mixes };
  return { state: complete(saved.state), preset: saved.preset ?? 'asli', tweaked: !!saved.tweaked, mixes };
}

export const useStudio = create<StudioStore>(() => ({ ...load(), compare: false, exporting: null }));

useStudio.subscribe((s, prev) => {
  if (s.state !== prev.state || s.preset !== prev.preset || s.tweaked !== prev.tweaked) {
    saveJSON(STATE_KEY, { state: s.state, preset: s.preset, tweaked: s.tweaked });
  }
  if (s.mixes !== prev.mixes) saveJSON(MIXES_KEY, s.mixes);
});

export const getStudio = useStudio.getState;

/** Immutable update of one module's fields. */
export function setModule<K extends keyof StudioState>(key: K, patch: Partial<StudioState[K]>) {
  useStudio.setState((s) => ({ state: { ...s.state, [key]: { ...s.state[key], ...patch } }, tweaked: true, compare: false }));
}

export function setBand(index: number, patch: Partial<StudioState['eq']['bands'][number]>) {
  useStudio.setState((s) => {
    const bands = s.state.eq.bands.map((b, i) => (i === index ? { ...b, ...patch } : b));
    return { state: { ...s.state, eq: { ...s.state.eq, on: true, bands } }, tweaked: true, compare: false };
  });
}

type Snapshot = Pick<StudioStore, 'state' | 'preset' | 'tweaked'>;

/**
 * Picking a preset or a saved mix replaces the whole rack. When the rack held
 * the listener's own adjustments, the toast offers them back.
 */
function replaceRack(next: Snapshot, name: string) {
  const s = getStudio();
  const before: Snapshot = { state: s.state, preset: s.preset, tweaked: s.tweaked };
  useStudio.setState({ ...next, compare: false });
  if (before.tweaked && studioProcessing(before.state)) {
    undoToast(`Racikan diganti dengan “${name}”.`, () => useStudio.setState({ ...before, compare: false }));
  }
}

export function applyPreset(id: PresetId) {
  const label = PRESETS.find((p) => p.id === id)?.label ?? 'Asli';
  replaceRack({ state: presetState(id), preset: id, tweaked: false }, label);
}

export const resetStudio = () => applyPreset('asli');

/** Hear the original for a moment. Does nothing while the rack is clean. */
export function setCompare(on: boolean) {
  const s = getStudio();
  if (on && !studioProcessing(s.state)) return;
  if (s.compare !== on) useStudio.setState({ compare: on });
}

export function applyMix(id: string) {
  const mix = getStudio().mixes.find((m) => m.id === id);
  if (mix) replaceRack({ state: complete(mix.state), preset: id, tweaked: false }, mix.name);
}

/** Saves the current rack under a name; returns its id, or null when the list is full. */
export function saveMix(name: string): string | null {
  const s = getStudio();
  if (s.mixes.length >= MAX_MIXES) return null;
  const id = `my:${Date.now().toString(36)}`;
  const mix: SavedMix = { id, name: name.trim().slice(0, 32) || 'Racikan saya', state: complete(s.state) };
  useStudio.setState({ mixes: [...s.mixes, mix], preset: id, tweaked: false });
  return id;
}

export function deleteMix(id: string) {
  const s = getStudio();
  const at = s.mixes.findIndex((m) => m.id === id);
  if (at < 0) return;
  const mix = s.mixes[at];
  const named = s.preset === id;
  useStudio.setState({
    mixes: s.mixes.filter((m) => m.id !== id),
    // The sound keeps playing as it is; it just no longer has a name.
    ...(named ? { preset: 'asli', tweaked: true } : {}),
  });
  undoToast(`Racikan “${mix.name}” dihapus.`, () => {
    const now = getStudio();
    if (now.mixes.some((m) => m.id === id)) return;
    if (now.mixes.length >= MAX_MIXES) {
      toast(`Daftar racikan sudah penuh, jadi “${mix.name}” tidak bisa dikembalikan. Hapus satu racikan dulu.`, 'error');
      return;
    }
    const mixes = [...now.mixes];
    mixes.splice(Math.min(at, mixes.length), 0, mix);
    // The name returns to the sound only if the sound was not changed meanwhile.
    const same = named && now.preset === 'asli' && now.state === s.state;
    useStudio.setState({ mixes, ...(same ? { preset: id, tweaked: s.tweaked } : {}) });
  });
}

/** What the rack is called right now, for the player bar. */
export function soundLabel(s: Pick<StudioStore, 'preset' | 'tweaked' | 'mixes'>): string {
  const mix = s.mixes.find((m) => m.id === s.preset);
  const base = mix?.name ?? (s.preset === 'asli' ? null : PRESETS.find((p) => p.id === s.preset)?.label);
  if (!base) return 'Racikan sendiri';
  return s.tweaked ? `${base} (disesuaikan)` : base;
}
