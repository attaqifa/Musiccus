import { create } from 'zustand';
import { loadJSON, saveJSON } from '../lib/storage';
import { DEFAULT_MIX, DEFAULT_POSITIONS, type StagePos, type StemMix, type StripState } from './mixer';
import { STEMS, type SeparationEngine, type StemId } from './types';

export interface StemStatus {
  state: 'queued' | 'running' | 'ready' | 'error';
  stage: string;
  progress: number;
  engine: SeparationEngine;
  backend?: string;
  error?: string;
  elapsedMs?: number;
  /** Restored from the on-disk cache instead of separated again. */
  cached?: boolean;
}

interface StemPrefs {
  mix: StemMix;
  /** Preferred separator. */
  engine: SeparationEngine;
  /** Separate every new track automatically (cached AI results always load). */
  auto: boolean;
}

interface StemStore extends StemPrefs {
  status: Record<string, StemStatus>;
  /** null while unknown. */
  modelCached: boolean | null;
}

const KEY = 'musiccus:stems';
const DEFAULT_PREFS: StemPrefs = { mix: DEFAULT_MIX, engine: 'ai', auto: false };

export const useStems = create<StemStore>(() => ({
  ...loadJSON(KEY, DEFAULT_PREFS),
  status: {},
  modelCached: null,
}));

useStems.subscribe((s, prev) => {
  if (s.mix !== prev.mix || s.engine !== prev.engine || s.auto !== prev.auto) saveJSON(KEY, { mix: s.mix, engine: s.engine, auto: s.auto });
});

export const setStemStatus = (id: string, status: StemStatus) =>
  useStems.setState((s) => ({ status: { ...s.status, [id]: status } }));

export function setStrip(id: StemId, patch: Partial<StripState>) {
  useStems.setState((s) => ({ mix: { ...s.mix, strips: { ...s.mix.strips, [id]: { ...s.mix.strips[id], ...patch } } } }));
}

export function setPosition(id: StemId, patch: Partial<StagePos>) {
  useStems.setState((s) => ({ mix: { ...s.mix, positions: { ...s.mix.positions, [id]: { ...s.mix.positions[id], ...patch } } } }));
}

export const setStage = (on: boolean) => useStems.setState((s) => ({ mix: { ...s.mix, stage: on } }));
export const resetStage = () => useStems.setState((s) => ({ mix: { ...s.mix, positions: DEFAULT_POSITIONS } }));

export interface StemPreset {
  id: string;
  label: string;
  hint: string;
  /** Stems that stay audible. */
  keep: StemId[];
}

export const PRESETS: StemPreset[] = [
  { id: 'asli', label: 'Asli', hint: 'Semua stem pada level semula: suara asli, bit-transparan.', keep: STEMS },
  { id: 'karaoke', label: 'Karaoke', hint: 'Vokal dimatikan.', keep: ['drums', 'bass', 'other'] },
  { id: 'acapella', label: 'A cappella', hint: 'Hanya vokal.', keep: ['vocals'] },
  { id: 'nodrums', label: 'Tanpa drum', hint: 'Latihan drum: semua kecuali drum.', keep: ['vocals', 'bass', 'other'] },
  { id: 'nobass', label: 'Tanpa bass', hint: 'Latihan bass: semua kecuali bass.', keep: ['vocals', 'drums', 'other'] },
  { id: 'rhythm', label: 'Ritme', hint: 'Hanya drum dan bass.', keep: ['drums', 'bass'] },
];

/** Applies a preset: levels and pans reset, mutes follow the preset, solos cleared. */
export function applyPreset(p: StemPreset) {
  useStems.setState((s) => {
    const strips = { ...s.mix.strips };
    for (const id of STEMS) strips[id] = { gainDb: 0, pan: 0, solo: false, mute: !p.keep.includes(id) };
    return { mix: { ...s.mix, strips } };
  });
}

/** The preset that matches the current mixer exactly, if any. */
export function activePreset(mix: StemMix): string | null {
  for (const p of PRESETS) {
    const match = STEMS.every((id) => {
      const st = mix.strips[id];
      return st.gainDb === 0 && st.pan === 0 && !st.solo && st.mute === !p.keep.includes(id);
    });
    if (match) return p.id;
  }
  return null;
}
