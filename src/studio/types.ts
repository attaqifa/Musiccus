export type BandType = 'lowshelf' | 'peaking' | 'highshelf' | 'highpass' | 'lowpass' | 'notch';

export interface EqBand {
  on: boolean;
  type: BandType;
  freq: number;
  gain: number;
  q: number;
}

export interface HpFilter {
  type: 'peaking' | 'lowshelf' | 'highshelf';
  freq: number;
  gain: number;
  q: number;
}

export type Division = '1/4' | '1/4d' | '1/8' | '1/8d' | '1/16';
export type Room = 'studio' | 'hall' | 'katedral' | 'plate';
export type Character = 'tube' | 'tape';

export interface StudioState {
  pitch: { on: boolean; semitones: number; cents: number; tempo: number; keepPitch: boolean; formant: boolean };
  filter: { on: boolean; sweep: number; resonance: number };
  eq: { on: boolean; bands: EqBand[] };
  comp: { on: boolean; threshold: number; ratio: number; attack: number; release: number; knee: number; makeup: number };
  drive: { on: boolean; character: Character; amount: number; tone: number; mix: number };
  stereo: { on: boolean; width: number; balance: number; mono: boolean };
  delay: { on: boolean; sync: boolean; division: Division; timeMs: number; feedback: number; tone: number; mix: number };
  space: { on: boolean; room: Room; decay: number; predelay: number; damping: number; mix: number };
  headphone: { on: boolean; profile: string; preamp: number; filters: HpFilter[]; crossfeed: number };
  output: { gain: number; limiter: boolean };
}

export type ModuleId = Exclude<keyof StudioState, 'output'>;

export const ROOMS: Record<Room, { label: string; decay: number; predelay: number; damping: number }> = {
  studio: { label: 'Studio', decay: 0.6, predelay: 0.006, damping: 0.6 },
  hall: { label: 'Hall', decay: 2.4, predelay: 0.024, damping: 0.45 },
  katedral: { label: 'Katedral', decay: 5.5, predelay: 0.04, damping: 0.3 },
  plate: { label: 'Plate', decay: 1.6, predelay: 0, damping: 0.15 },
};

export const DIVISION_BEATS: Record<Division, number> = { '1/4': 1, '1/4d': 1.5, '1/8': 0.5, '1/8d': 0.75, '1/16': 0.25 };

export const DEFAULT_BANDS: EqBand[] = [
  { on: true, type: 'lowshelf', freq: 60, gain: 0, q: 0.71 },
  { on: true, type: 'peaking', freq: 140, gain: 0, q: 1 },
  { on: true, type: 'peaking', freq: 320, gain: 0, q: 1 },
  { on: true, type: 'peaking', freq: 700, gain: 0, q: 1 },
  { on: true, type: 'peaking', freq: 1600, gain: 0, q: 1 },
  { on: true, type: 'peaking', freq: 3500, gain: 0, q: 1 },
  { on: true, type: 'peaking', freq: 7000, gain: 0, q: 1 },
  { on: true, type: 'highshelf', freq: 12000, gain: 0, q: 0.71 },
];

export const DEFAULT_STUDIO: StudioState = {
  pitch: { on: false, semitones: 0, cents: 0, tempo: 1, keepPitch: true, formant: false },
  filter: { on: false, sweep: 0, resonance: 0.2 },
  eq: { on: false, bands: DEFAULT_BANDS },
  comp: { on: false, threshold: -18, ratio: 3, attack: 0.01, release: 0.18, knee: 6, makeup: 0 },
  drive: { on: false, character: 'tube', amount: 0.3, tone: 0.7, mix: 1 },
  stereo: { on: false, width: 1, balance: 0, mono: false },
  delay: { on: false, sync: true, division: '1/8d', timeMs: 320, feedback: 0.35, tone: 0.6, mix: 0.2 },
  space: { on: false, room: 'hall', decay: 2.4, predelay: 0.024, damping: 0.45, mix: 0.22 },
  headphone: { on: false, profile: '', preamp: 0, filters: [], crossfeed: 0 },
  output: { gain: 0, limiter: true },
};

export const MODULE_ORDER: ModuleId[] = ['pitch', 'filter', 'eq', 'comp', 'drive', 'stereo', 'delay', 'space', 'headphone'];

export const MODULE_LABEL: Record<ModuleId, string> = {
  pitch: 'Pitch dan tempo',
  filter: 'Filter',
  eq: 'EQ parametrik',
  comp: 'Kompresor',
  drive: 'Saturasi',
  stereo: 'Stereo',
  delay: 'Delay',
  space: 'Ruang',
  headphone: 'Headphone',
};

/** True when the module changes the signal at all. */
export function moduleActive(s: StudioState, id: ModuleId): boolean {
  switch (id) {
    case 'pitch':
      return s.pitch.on && (s.pitch.semitones !== 0 || s.pitch.cents !== 0 || Math.abs(s.pitch.tempo - 1) > 1e-3);
    case 'filter':
      return s.filter.on && Math.abs(s.filter.sweep) > 0.01;
    case 'eq':
      return s.eq.on && s.eq.bands.some((b) => b.on && (b.gain !== 0 || b.type === 'highpass' || b.type === 'lowpass' || b.type === 'notch'));
    case 'headphone':
      return s.headphone.on && (s.headphone.filters.length > 0 || s.headphone.crossfeed > 0 || s.headphone.preamp !== 0);
    default:
      return s[id].on;
  }
}

export function activeModules(s: StudioState): ModuleId[] {
  return MODULE_ORDER.filter((id) => moduleActive(s, id));
}

/**
 * True when the rack changes the song. The headphone correction does not
 * count: it is part of the listener's setup, applied to the original too.
 */
export const studioProcessing = (s: StudioState) =>
  activeModules(s).some((id) => id !== 'headphone') || Math.abs(s.output.gain) > 0.01;

/** Pitch shift the stretcher must apply, given tempo and the keep-pitch option. */
export function pitchShift(p: StudioState['pitch']): number {
  if (!p.on) return 0;
  const user = p.semitones + p.cents / 100;
  return p.keepPitch ? user - 12 * Math.log2(p.tempo) : user;
}

export const playbackRate = (p: StudioState['pitch']) => (p.on ? p.tempo : 1);

/** Whole semitones the listener hears the song moved by (tempo counts only in vinyl mode). */
export function heardSemitones(p: StudioState['pitch']): number {
  if (!p.on) return 0;
  return Math.round(p.semitones + p.cents / 100 + (p.keepPitch ? 0 : 12 * Math.log2(p.tempo)));
}
