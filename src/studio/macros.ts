import { useStudio } from './store';
import type { BandType, StudioState } from './types';

/**
 * The plain layer of Racik: four sliders that each stand for a few rack settings, so the listener
 * can lean a preset one way without opening the rack. Each reads its value back from the rack, so
 * a preset, a saved mix or a knob in the rack moves it too. The middle mark is the song as it is.
 */
export interface Macro {
  id: 'bass' | 'vokal' | 'ruang' | 'lebar';
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  /** The value that leaves the song as it is. */
  neutral: number;
  read: (s: StudioState) => number;
  write: (s: StudioState, v: number) => StudioState;
  /** The value in words, never in units. */
  say: (v: number) => string;
}

// Filters with no gain would swallow a macro's boost; such a band goes back to its default shape.
const GAINLESS: BandType[] = ['highpass', 'lowpass', 'notch'];
const DEFAULT_TYPE: Record<number, BandType> = { 0: 'lowshelf', 7: 'highshelf' };

/** Sets EQ gains by band. With the EQ off, its hidden bands start flat: what is heard is what the sliders show. */
function gains(s: StudioState, g: Record<number, number>): StudioState {
  const bands = s.eq.bands.map((b, i) => {
    const base = s.eq.on ? b : { ...b, gain: 0 };
    if (!(i in g)) return base;
    const type = GAINLESS.includes(base.type) ? (DEFAULT_TYPE[i] ?? 'peaking') : base.type;
    return { ...base, type, on: true, gain: Number(g[i].toFixed(2)) };
  });
  return { ...s, eq: { on: s.eq.on || Object.values(g).some((x) => x !== 0), bands } };
}

/** Four steps of a change in either direction, named the way a listener would say it. */
function words(v: number, limits: [number, number, number], more: string, less: string, neutral = 0): string {
  const d = v - neutral;
  const a = Math.abs(d);
  if (a < limits[0]) return 'Asli';
  const side = d > 0 ? more : less;
  return a <= limits[1] ? `Sedikit ${side}` : a <= limits[2] ? side[0].toUpperCase() + side.slice(1) : `Jauh ${side}`;
}

export const MACROS: Macro[] = [
  {
    id: 'bass',
    label: 'Bass',
    hint: 'Dentum dan bass: geser kanan supaya lebih berisi, kiri supaya lebih ringan.',
    min: -6,
    max: 8,
    step: 0.5,
    neutral: 0,
    read: (s) => (s.eq.on ? s.eq.bands[0].gain : 0),
    write: (s, v) => gains(s, { 0: v, 1: v / 2 }),
    say: (v) => words(v, [0.25, 2.5, 5], 'lebih tebal', 'lebih tipis'),
  },
  {
    id: 'vokal',
    label: 'Vokal',
    hint: 'Suara penyanyi dan lirik: geser kanan supaya lebih maju, kiri supaya lebih lembut.',
    min: -6,
    max: 6,
    step: 0.5,
    neutral: 0,
    read: (s) => (s.eq.on ? s.eq.bands[5].gain : 0),
    write: (s, v) => gains(s, { 4: (v * 2) / 3, 5: v }),
    say: (v) => words(v, [0.25, 2, 4], 'lebih jelas', 'lebih lembut'),
  },
  {
    id: 'ruang',
    label: 'Ruang',
    hint: 'Gema ruangan di sekitar musik: dari kering seperti aslinya sampai gema aula yang panjang.',
    min: 0,
    max: 0.5,
    step: 0.01,
    neutral: 0,
    read: (s) => (s.space.on ? s.space.mix : 0),
    write: (s, v) => ({ ...s, space: { ...s.space, on: v > 0.005, mix: v > 0.005 ? v : s.space.mix } }),
    say: (v) => (v <= 0.005 ? 'Asli' : v < 0.1 ? 'Sedikit ruang' : v < 0.25 ? 'Ruang terasa' : v < 0.4 ? 'Ruang luas' : 'Gema panjang'),
  },
  {
    id: 'lebar',
    label: 'Lebar',
    hint: 'Seberapa lebar musik terdengar di kiri dan kanan, paling terasa di headphone.',
    min: 0,
    max: 2,
    step: 0.05,
    neutral: 1,
    read: (s) => (!s.stereo.on ? 1 : s.stereo.mono ? 0 : s.stereo.width),
    write: (s, v) => ({
      ...s,
      stereo: { ...s.stereo, width: v, mono: false, on: Math.abs(v - 1) > 0.01 || Math.abs(s.stereo.balance) > 0.01 },
    }),
    say: (v) => (v < 0.025 ? 'Mono' : words(v, [0.025, 0.2, 0.5], 'lebih lebar', 'lebih sempit', 1)),
  },
];

/** A macro adjusts the rack, so the preset it started from now counts as tweaked. */
export function setMacro(m: Macro, v: number) {
  useStudio.setState((s) => ({ state: m.write(s.state, v), tweaked: true, compare: false }));
}
