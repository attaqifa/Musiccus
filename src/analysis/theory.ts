import { HOME, homePalette } from './color';
import type { ChordSeg, KeyInfo, Music, Rgb } from './types';

const SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

/** Position of each pitch class on the circle of fifths (C = 0, G = 1, …, F = 11). */
export const FIFTHS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
export const fifthsIndex = (pc: number) => FIFTHS[((pc % 12) + 12) % 12];

/** Flat-side keys spell with flats, everything else with sharps. */
export function usesFlats(key: KeyInfo | null): boolean {
  if (!key) return false;
  const major = key.mode === 'major' ? key.tonic : (key.tonic + 3) % 12;
  return [5, 10, 3, 8, 1, 6].includes(major);
}

export const noteName = (pc: number, flats = false) => (flats ? FLAT : SHARP)[((pc % 12) + 12) % 12];

export function keyName(key: KeyInfo): string {
  return `${noteName(key.tonic, usesFlats(key))} ${key.mode === 'major' ? 'mayor' : 'minor'}`;
}

export function camelot(key: KeyInfo): string {
  const major = key.mode === 'major' ? key.tonic : (key.tonic + 3) % 12;
  const num = ((fifthsIndex(major) + 7) % 12) + 1;
  return `${num}${key.mode === 'major' ? 'B' : 'A'}`;
}

export function chordName(c: Pick<ChordSeg, 'root' | 'quality'>, key: KeyInfo | null): string {
  return `${rootName(c.root, key)}${c.quality === 'min' ? 'm' : ''}`;
}

const NUMERALS_MAJOR = ['I', '♭II', 'II', '♭III', 'III', 'IV', '♯IV', 'V', '♭VI', 'VI', '♭VII', 'VII'];
// In minor keys degrees are counted on the natural minor scale (III, VI, VII).
const NUMERALS_MINOR = ['I', '♭II', 'II', 'III', '♯III', 'IV', '♯IV', 'V', 'VI', '♯VI', 'VII', '♯VII'];

/**
 * A chord root spelled as its degree in the key: in D major the ♭VI is B♭,
 * not A♯, and in G minor the ♯VII is F♯, not G♭. Notes of the scale follow
 * the key signature.
 */
export function rootName(pc: number, key: KeyInfo | null): string {
  if (!key) return noteName(pc);
  const n = (key.mode === 'minor' ? NUMERALS_MINOR : NUMERALS_MAJOR)[(((pc - key.tonic) % 12) + 12) % 12];
  return noteName(pc, n.startsWith('♭') || (!n.startsWith('♯') && usesFlats(key)));
}

/** Roman numeral of a chord relative to the key: uppercase major, lowercase minor. */
export function romanNumeral(c: Pick<ChordSeg, 'root' | 'quality'>, key: KeyInfo | null): string {
  if (!key) return '';
  const n = (key.mode === 'minor' ? NUMERALS_MINOR : NUMERALS_MAJOR)[(c.root - key.tonic + 12) % 12];
  return c.quality === 'min' ? n.toLowerCase() : n;
}

/** Plain-language harmonic role, for the explanation under the chord. */
export function chordRole(c: Pick<ChordSeg, 'root' | 'quality'>, key: KeyInfo | null): string {
  if (!key) return '';
  const iv = (c.root - key.tonic + 12) % 12;
  const minorKey = key.mode === 'minor';
  if (iv === 0) return 'Tonik: rumah, terasa selesai dan stabil.';
  if (iv === 7) return 'Dominan: tegang, ingin kembali ke rumah.';
  if (iv === 5) return 'Subdominan: melangkah menjauh dari rumah.';
  if (iv === 2 && !minorKey) return 'Supertonik: jembatan menuju dominan.';
  if ((iv === 9 && !minorKey) || (iv === 3 && minorKey)) return 'Relatif: berbagi nada dengan rumah, tapi warnanya berbalik.';
  if ((iv === 8 || iv === 10) && minorKey) return 'Akor mayor dari tangga minor: cerah tapi tetap sendu.';
  if (iv === 4 && !minorKey) return 'Mediant: lembut, setengah jalan antara rumah dan dominan.';
  return 'Akor pinjaman: warna dari luar tangga nada.';
}

/* ------------------------------------------------------------ Colour -- */

export { HOME, homePalette, keyAccent, monoPalette, musicPalette, PEARL, pitchColor, pitchHue, PRISM } from './color';

export const rgbCss = (c: Rgb, alpha = 1) =>
  `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${alpha})`;

export function emptyMusic(): Music {
  return {
    ready: false,
    trackTime: 0,
    bpm: 0,
    beatIndex: -1,
    beatPhase: 0,
    barIndex: -1,
    beatInBar: 0,
    beatPulse: 0,
    downbeatPulse: 0,
    beatCount: 0,
    downbeatCount: 0,
    chord: null,
    nextChord: null,
    key: null,
    section: null,
    sectionIndex: -1,
    nextSection: null,
    timeToNext: Infinity,
    anticipation: 0,
    impact: 0,
    energy: 0,
    palette: homePalette(),
    accent: [...HOME] as Rgb,
    stems: null,
  };
}
