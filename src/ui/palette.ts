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

export { keyCss } from './ambient';

/** Numbers and data labels on canvases: the UI face (the mono face is gone from the design). */
export const MONO = '"IBM Plex Sans", system-ui, sans-serif';
export const SERIF = '"Fraunces Variable", Georgia, serif';
export const SANS = '"IBM Plex Sans", system-ui, sans-serif';
