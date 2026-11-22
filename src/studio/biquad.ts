import type { BandType } from './types';

/**
 * Magnitude response of an RBJ-cookbook biquad, matching Web Audio's
 * BiquadFilterNode (shelves use slope S = 1 and ignore Q), so curves drawn
 * in the UI are exactly what the engine applies.
 */
export function biquadDb(type: BandType, f0: number, gainDb: number, q: number, f: number, rate: number): number {
  const w0 = (2 * Math.PI * Math.min(f0, rate * 0.499)) / rate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const A = Math.pow(10, gainDb / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (type) {
    case 'peaking': {
      const alpha = sin / (2 * q);
      b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
      break;
    }
    case 'lowshelf': {
      const alpha = (sin / 2) * Math.sqrt(2);
      const sa = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 - (A - 1) * cos + sa); b1 = 2 * A * (A - 1 - (A + 1) * cos); b2 = A * (A + 1 - (A - 1) * cos - sa);
      a0 = A + 1 + (A - 1) * cos + sa; a1 = -2 * (A - 1 + (A + 1) * cos); a2 = A + 1 + (A - 1) * cos - sa;
      break;
    }
    case 'highshelf': {
      const alpha = (sin / 2) * Math.sqrt(2);
      const sa = 2 * Math.sqrt(A) * alpha;
      b0 = A * (A + 1 + (A - 1) * cos + sa); b1 = -2 * A * (A - 1 + (A + 1) * cos); b2 = A * (A + 1 + (A - 1) * cos - sa);
      a0 = A + 1 - (A - 1) * cos + sa; a1 = 2 * (A - 1 - (A + 1) * cos); a2 = A + 1 - (A - 1) * cos - sa;
      break;
    }
    case 'highpass': {
      // Web Audio's Q for low/high-pass is in dB.
      const alpha = sin / (2 * Math.pow(10, q / 20));
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    }
    case 'lowpass': {
      const alpha = sin / (2 * Math.pow(10, q / 20));
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    }
    default: {
      const alpha = sin / (2 * q);
      b0 = 1; b1 = -2 * cos; b2 = 1;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
    }
  }
  const w = (2 * Math.PI * f) / rate;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2;
  const ni = -(b1 * s1 + b2 * s2);
  const dr = a0 + a1 * c1 + a2 * c2;
  const di = -(a1 * s1 + a2 * s2);
  const mag = Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  return 20 * Math.log10(mag + 1e-12);
}
