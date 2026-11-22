import { DEFAULT_STUDIO, ROOMS, type StudioState } from './types';

/**
 * One-tap sound presets. Each starts from a clean rack (every effect off), so
 * picking one never stacks on top of another. The sliders in the panel then
 * adjust the result.
 */
export type PresetId = 'asli' | 'bass' | 'vokal' | 'lapang' | 'konser' | 'slowed' | 'spedup' | 'malam' | 'lofi';

export interface Preset {
  id: PresetId;
  label: string;
  /** A word or two for the preset grid in Racik; `label` is used everywhere else. */
  short: string;
  hint: string;
  build: (s: StudioState) => void;
}

/** Sets EQ band gains by index (0 = 60 Hz shelf … 7 = 12 kHz shelf) and turns the EQ on. */
function eq(s: StudioState, gains: Record<number, number>) {
  s.eq.on = true;
  s.eq.bands = s.eq.bands.map((b, i) => (i in gains ? { ...b, gain: gains[i] } : b));
}

function room(s: StudioState, name: keyof typeof ROOMS, mix: number, decay?: number) {
  const r = ROOMS[name];
  s.space = { on: true, room: name, decay: decay ?? r.decay, predelay: r.predelay, damping: r.damping, mix };
}

export const PRESETS: Preset[] = [
  { id: 'asli', label: 'Asli', short: 'Asli', hint: 'Lagu persis seperti aslinya, tanpa efek.', build: () => undefined },
  {
    id: 'bass',
    label: 'Bass lebih tebal',
    short: 'Bass tebal',
    hint: 'Dentum dan bass lebih berisi, tanpa membuat vokal tenggelam.',
    build: (s) => eq(s, { 0: 5, 1: 2.5, 2: -1 }),
  },
  {
    id: 'vokal',
    label: 'Vokal lebih jelas',
    short: 'Vokal jelas',
    hint: 'Suara penyanyi dan lirik lebih maju dan mudah ditangkap.',
    build: (s) => eq(s, { 2: -1.5, 4: 2, 5: 3, 7: 1.5 }),
  },
  {
    id: 'lapang',
    label: 'Lebih lapang',
    short: 'Lapang',
    hint: 'Musik terasa lebih lebar di headphone, dengan sedikit ruang.',
    build: (s) => {
      s.stereo = { ...s.stereo, on: true, width: 1.35 };
      room(s, 'studio', 0.12);
    },
  },
  {
    id: 'konser',
    label: 'Aula konser',
    short: 'Konser',
    hint: 'Seolah lagu dimainkan di gedung konser yang besar.',
    build: (s) => {
      room(s, 'hall', 0.28);
      s.stereo = { ...s.stereo, on: true, width: 1.15 };
    },
  },
  {
    id: 'slowed',
    label: 'Slowed + reverb',
    short: 'Slowed',
    hint: 'Lebih lambat dan sedikit lebih rendah, dengan gema yang luas.',
    build: (s) => {
      s.pitch = { ...s.pitch, on: true, tempo: 0.85, keepPitch: false };
      room(s, 'hall', 0.32, 3.2);
    },
  },
  {
    id: 'spedup',
    label: 'Sped up',
    short: 'Sped up',
    hint: 'Lebih cepat dan lebih tinggi, seperti versi sped up di media sosial.',
    build: (s) => {
      s.pitch = { ...s.pitch, on: true, tempo: 1.2, keepPitch: false };
    },
  },
  {
    id: 'malam',
    label: 'Dengar pelan',
    short: 'Pelan',
    hint: 'Untuk volume kecil di malam hari: bagian pelan terangkat, bagian keras tidak mengagetkan.',
    build: (s) => {
      s.comp = { on: true, threshold: -32, ratio: 2.5, attack: 0.02, release: 0.25, knee: 10, makeup: 7 };
      eq(s, { 7: -2 });
    },
  },
  {
    id: 'lofi',
    label: 'Lo-fi',
    short: 'Lo-fi',
    hint: 'Hangat dan sedikit buram, seperti kaset atau radio tua.',
    build: (s) => {
      s.filter = { on: true, sweep: -0.35, resonance: 0.1 };
      s.drive = { on: true, character: 'tape', amount: 0.35, tone: 0.5, mix: 0.7 };
      s.stereo = { ...s.stereo, on: true, width: 0.7 };
    },
  },
];

export function presetState(id: PresetId): StudioState {
  const s = structuredClone(DEFAULT_STUDIO);
  PRESETS.find((p) => p.id === id)?.build(s);
  return s;
}
