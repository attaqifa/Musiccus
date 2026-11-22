/**
 * Word timing for lyrics that only carry a time per line (almost every LRC,
 * LRCLIB included). Each word gets an estimated start from three sources,
 * strongest last:
 *
 *   1. syllables  words share the sung part of the line by syllable count;
 *                 the sung part is as long as the syllables need at the
 *                 song's tempo, never longer than the gap to the next line
 *   2. voice      with a separated vocal stem, words move to the nearest
 *                 vocal onset and the line ends when the voice stops
 *   3. beat       words close to a sixteenth note of the beat grid land on
 *                 it, which is where sung syllables usually fall
 *
 * The first word keeps the line's own time: that one came from a person.
 */
import type { LyricLine, LyricWord } from './lyrics';

export interface Voice {
  /** Vocal level in dBFS, `rate` frames per second. */
  db: Float32Array;
  rate: number;
  /** Level of the loud sung passages, dBFS. */
  refDb: number;
}

export interface TimingInput {
  bpm?: number;
  beats?: Float32Array;
  duration?: number;
  voice?: Voice | null;
}

const VOWELS = /[aeiouyàáâãäåèéêëìíîïòóôõöùúûüýÿæœ]+/gi;

/** Rough syllable count that works for Indonesian and English. */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-zà-ÿæœ']/g, '');
  if (!w) return 0;
  let n = w.match(VOWELS)?.length ?? 0;
  // English silent final e ("make", "time"), but not "the", "be" or "-le".
  if (n > 1 && /[^aeiouyl]e$/.test(w)) n--;
  return Math.max(1, n);
}

/** Splits a line into words, keeping the spaces with the word before them. */
export function splitWords(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

/** Onsets of the voice: a rise of 4 dB or more within 60 ms while singing. */
export function vocalOnsets(v: Voice): Float32Array {
  const out: number[] = [];
  const { db, rate } = v;
  const back = Math.max(1, Math.round(0.06 * rate));
  const gap = 0.09;
  const floor = v.refDb - 30;
  const rise = new Float32Array(db.length);
  for (let i = back; i < db.length; i++) {
    let lo = db[i];
    for (let k = 1; k <= back; k++) lo = Math.min(lo, db[i - k]);
    rise[i] = db[i] - lo;
  }
  let last = -Infinity;
  for (let i = 1; i < db.length - 1; i++) {
    if (rise[i] < 4 || db[i] < floor) continue;
    if (rise[i] < rise[i - 1] || rise[i] < rise[i + 1]) continue;
    const t = i / rate;
    if (t - last < gap) continue;
    out.push(t);
    last = t;
  }
  return Float32Array.from(out);
}

/** Last moment in [a, b) the voice is clearly singing, or null if it is silent there. */
function voiceEnd(v: Voice, a: number, b: number): number | null {
  const thr = v.refDb - 22;
  const i0 = Math.max(0, Math.floor(a * v.rate));
  const i1 = Math.min(v.db.length, Math.floor(b * v.rate));
  for (let i = i1 - 1; i >= i0; i--) if (v.db[i] >= thr) return (i + 1) / v.rate;
  return null;
}

/** First index in a sorted array with value >= x. */
function lowerBound(a: Float32Array, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Nearest sixteenth note of the beat grid to `t`, or null outside the grid. */
function nearestSixteenth(beats: Float32Array, t: number): { t: number; step: number } | null {
  const i = lowerBound(beats, t);
  if (i === 0 || i >= beats.length) return null;
  const a = beats[i - 1];
  const step = (beats[i] - a) / 4;
  return { t: a + Math.round((t - a) / step) * step, step };
}

function timeLine(line: LyricLine, nextT: number, input: TimingInput, onsets: Float32Array | null): LyricWord[] | undefined {
  const parts = splitWords(line.text);
  if (parts.length < 2) return undefined;
  const syl = parts.map(syllables);
  const total = syl.reduce((a, b) => a + b, 0);
  if (total === 0) return undefined;

  const start = line.t;
  const gap = Math.max(0.2, nextT - start);
  // Sung syllables sit on eighth notes more often than not.
  const perSyl = input.bpm ? Math.min(0.36, Math.max(0.16, 30 / input.bpm)) : 0.26;
  let sung = Math.min(gap * 0.92, Math.max(0.5, total * perSyl * 1.15));
  if (input.voice) {
    const end = voiceEnd(input.voice, start, nextT - 0.05);
    if (end !== null && end - start > 0.3) sung = Math.min(gap * 0.97, end - start);
  }

  let acc = 0;
  const times = syl.map((n) => {
    const t = start + (sung * acc) / total;
    acc += n;
    return t;
  });

  const spacing = sung / parts.length;
  for (let k = 1; k < times.length; k++) {
    let t = times[k];
    if (onsets && onsets.length) {
      const reach = Math.min(0.25, spacing * 0.6);
      const j = lowerBound(onsets, t - reach);
      let best: number | null = null;
      for (let m = j; m < onsets.length && onsets[m] <= t + reach; m++) {
        if (onsets[m] <= times[k - 1] + 0.08) continue;
        if (best === null || Math.abs(onsets[m] - t) < Math.abs(best - t)) best = onsets[m];
      }
      if (best !== null) t = best;
    }
    if (input.beats && input.beats.length > 1) {
      const g = nearestSixteenth(input.beats, t);
      if (g && Math.abs(g.t - t) < Math.min(0.07, g.step * 0.45)) t = g.t;
    }
    times[k] = Math.max(t, times[k - 1] + 0.05);
  }
  return parts.map((text, k) => ({ t: times[k], text }));
}

/**
 * Returns the lines with word times: lines that already have words (enhanced
 * LRC) are kept as they are, the rest get estimates.
 */
export function estimateWords(lines: LyricLine[], input: TimingInput): LyricLine[] {
  const onsets = input.voice ? vocalOnsets(input.voice) : null;
  return lines.map((line, i) => {
    if (line.words || !line.text.trim()) return line;
    const nextT = lines[i + 1]?.t ?? Math.min(input.duration ?? line.t + 6, line.t + 6);
    const words = timeLine(line, nextT, input, onsets);
    return words ? { ...line, words, estimated: true } : line;
  });
}
