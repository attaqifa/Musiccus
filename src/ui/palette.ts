import type { SectionName } from '../analysis/types';
import type { StemId } from '../stems/types';

/**
 * Graphite Prism colours for canvas drawing; mirrors the tokens in theme.css.
 * Interaction uses `signal`, status uses ok / warn / danger, and expressive
 * data (spectra, curves) uses the live key colour from `keyCss`.
 */
export const C = {
  face: '#16181B',
  faceEdge: '#2A2D31',
  ink: '#ECEAE6',
  ink2: '#B9BCC1',
  ink3: '#8E9196',
  ink4: '#4A4E54',
  signal: '#F2EFE8',
  ok: '#9DBF7A',
  warn: '#EAB04A',
  danger: '#E0614A',
  grid: 'rgba(236, 234, 230, 0.07)',
  gridStrong: 'rgba(236, 234, 230, 0.14)',
};

export const signalA = (a: number) => `rgba(242, 239, 232, ${a})`;

/*
 * Identity, colour's fourth job: one fixed colour per kind of thing, so every Chorus looks like
 * every other Chorus and the vocals are always the same pink. Soft on purpose, so they never read
 * as status. Each set belongs to one mode (sections in Pahami, stems in Stem), so the two never
 * share a screen. Six-digit hex: canvases append an alpha byte.
 */
export const SECTION_COLOR: Record<Exclude<SectionName, 'Bagian'>, string> = {
  Intro: '#8FC7AE',
  Verse: '#B9A8E8',
  Chorus: '#D9B48E',
  Puncak: '#DD9DB5',
  Bridge: '#86B8DA',
  Outro: '#B8BE7E',
};

/** A part the analysis could not name stays graphite, told apart by its letter, so it never passes for a named one. */
export const UNNAMED_SECTION = ['#B9BCC1', '#8E9196', '#D4D2CD', '#A3A6AB'];

export const STEM_COLOR: Record<StemId, string> = {
  vocals: '#E6A3C4',
  drums: '#8DB6E2',
  bass: '#A99BEA',
  other: '#9CCFC4',
};

export { keyCss } from './ambient';

/** Numbers and data labels on canvases: the UI face (the mono face is gone from the design). */
export const MONO = '"IBM Plex Sans", system-ui, sans-serif';
export const SERIF = '"Fraunces Variable", Georgia, serif';
export const SANS = '"IBM Plex Sans", system-ui, sans-serif';
