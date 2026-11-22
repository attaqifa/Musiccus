import { chordName } from './theory';
import type { Analysis, ChordSeg, Section } from './types';

/** "simple" folds short chords away so a player can keep up; "full" is what the analysis heard. */
export type ChordView = 'simple' | 'full';

/** Chords shorter than this many beats are folded into a neighbour in the simple view. */
const MIN_BEATS = 2;

const same = (a: ChordSeg, b: ChordSeg) => a.root === b.root && a.quality === b.quality;
const sameOrNone = (a: ChordSeg | null, b: ChordSeg | null) => a === b || (!!a && !!b && same(a, b));
const tones = (c: ChordSeg) => [c.root, (c.root + (c.quality === 'min' ? 3 : 4)) % 12, (c.root + 7) % 12];
const shared = (a: ChordSeg, b: ChordSeg) => {
  const tb = tones(b);
  return tones(a).filter((p) => tb.includes(p)).length;
};

/**
 * Chords for playing along: every boundary moves to the nearest beat, short
 * gaps are bridged by the chord before them, and any chord under two beats
 * is folded into the neighbour it shares most notes with (the one before it
 * on a tie, so a chord is held rather than rushed). Changes then come at
 * most every two beats. A chord the listener corrected is never folded away,
 * and a gap they marked as having no chord stays open.
 */
export function simplifyChords(chords: ChordSeg[], beats: ArrayLike<number>, open: { t: number; end: number }[] = []): ChordSeg[] {
  if (chords.length === 0 || beats.length < 2) return chords;
  const n = beats.length;
  const period = (beats[n - 1] - beats[0]) / (n - 1);
  const lastBefore = (t: number) => {
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (beats[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const snap = (t: number) => {
    const i = lastBefore(t);
    const a = beats[i];
    const b = i + 1 < n ? beats[i + 1] : a + period;
    const near = t - a < b - t ? a : b;
    return Math.abs(near - t) < period * 0.6 ? near : t;
  };
  // Beats a segment spans, counted on the grid so tempo drift does not matter.
  const length = (s: ChordSeg) => {
    const i = lastBefore(s.t);
    const step = i + 1 < n ? beats[i + 1] - beats[i] : period;
    return (s.end - s.t) / Math.max(1e-3, step);
  };

  let segs = chords.map((c) => ({ ...c, t: snap(c.t), end: snap(c.end) })).filter((c) => c.end - c.t > 1e-3);
  const touching = (a: ChordSeg, b: ChordSeg) => Math.abs(a.end - b.t) < 1e-3;

  // A short silence inside a chord is the same chord still ringing.
  for (let i = 0; i + 1 < segs.length; i++) {
    const a = segs[i];
    const b = segs[i + 1];
    const kept = open.some((g) => g.t < b.t && g.end > a.end);
    if (!touching(a, b) && !kept && (b.t - a.end) / period < MIN_BEATS) a.end = b.t;
  }

  const join = (list: ChordSeg[]) => {
    const out: ChordSeg[] = [];
    for (const s of list) {
      const p = out[out.length - 1];
      if (p && touching(p, s) && same(p, s)) {
        p.end = s.end;
        if (s.fixed) p.fixed = true;
      }
      else out.push(s);
    }
    return out;
  };
  segs = join(segs);

  for (;;) {
    let pick = -1;
    let shortest = MIN_BEATS - 0.05;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const prev = i > 0 && touching(segs[i - 1], s) ? segs[i - 1] : null;
      const next = i + 1 < segs.length && touching(s, segs[i + 1]) ? segs[i + 1] : null;
      // One alone between silences has nothing to join.
      if ((!prev && !next) || s.fixed) continue;
      const len = length(s);
      if (len < shortest) {
        shortest = len;
        pick = i;
      }
    }
    if (pick < 0) break;
    const s = segs[pick];
    const prev = pick > 0 && touching(segs[pick - 1], s) ? segs[pick - 1] : null;
    const next = pick + 1 < segs.length && touching(s, segs[pick + 1]) ? segs[pick + 1] : null;
    const toPrev = prev && (!next || shared(s, prev) >= shared(s, next));
    if (toPrev) prev.end = s.end;
    else next!.t = s.t;
    segs.splice(pick, 1);
    segs = join(segs);
  }
  return segs;
}

const simple = new WeakMap<Analysis, ChordSeg[]>();

/** The chord list a view shows. The simple one is worked out once per analysis. */
export function chordsFor(a: Analysis, view: ChordView): ChordSeg[] {
  if (view === 'full') return a.chords;
  let c = simple.get(a);
  if (!c) simple.set(a, (c = simplifyChords(a.chords, a.beats, a.fixedNone)));
  return c;
}

export interface ChartName {
  /** Beat within the bar where the name is written. */
  at: number;
  /** Beats it holds before the next name in the bar. */
  span: number;
  text: string;
  /** Carried over from the bar before, not a new chord. */
  held: boolean;
  /** The chord named, or null for a dash. */
  chord: ChordSeg | null;
}

export interface ChartBar {
  t: number;
  /** Index of its first beat in `analysis.beats`. */
  first: number;
  beats: number;
  names: ChartName[];
  /** The section that starts here. */
  section: Section | null;
}

/** The chord sounding over most of each beat, or null where nothing clear is. */
function chordPerBeat(chords: ChordSeg[], beats: ArrayLike<number>, duration: number): (ChordSeg | null)[] {
  const out: (ChordSeg | null)[] = [];
  let ci = 0;
  for (let j = 0; j < beats.length; j++) {
    const t0 = beats[j];
    const step = j + 1 < beats.length ? beats[j + 1] - t0 : j > 0 ? t0 - beats[j - 1] : 0.5;
    const t1 = Math.min(duration, t0 + step);
    while (ci < chords.length && chords[ci].end <= t0) ci++;
    let best: ChordSeg | null = null;
    let most = 0;
    for (let k = ci; k < chords.length && chords[k].t < t1; k++) {
      const o = Math.min(chords[k].end, t1) - Math.max(chords[k].t, t0);
      if (o > most) {
        most = o;
        best = chords[k];
      }
    }
    out.push(most > 0.35 * (t1 - t0) ? best : null);
  }
  return out;
}

/** Bars as a chord chart writes them: a name where the chord changes, beat by beat. */
export function chordChart(a: Analysis, chords: ChordSeg[]): ChartBar[] {
  const { beats, downbeats } = a;
  const per = chordPerBeat(chords, beats, a.duration);
  const marks: number[] = downbeats.length ? Array.from(downbeats) : [];
  if (!marks.length || marks[0] > 0) marks.unshift(0);
  // Bars past the last downbeat, or with none found, are counted in fours.
  const starts: number[] = [];
  for (let k = 0; k < marks.length; k++) {
    const end = k + 1 < marks.length ? marks[k + 1] : beats.length;
    for (let j = marks[k]; j < end; j += 4) starts.push(j);
  }
  const bars: ChartBar[] = [];
  for (let k = 0; k < starts.length; k++) {
    const first = starts[k];
    const end = Math.min(k + 1 < starts.length ? starts[k + 1] : beats.length, beats.length);
    if (end <= first) continue;
    const names: ChartName[] = [];
    for (let j = first; j < end; j++) {
      const c = per[j];
      if (j > first && sameOrNone(c, per[j - 1])) continue;
      names.push({ at: j - first, span: 0, text: c ? chordName(c, a.key) : '–', held: j === first && j > 0 && sameOrNone(c, per[j - 1]), chord: c });
    }
    names.forEach((n, i) => (n.span = (names[i + 1]?.at ?? end - first) - n.at));
    bars.push({ t: beats[first], first, beats: end - first, names, section: null });
  }
  for (const s of a.sections) {
    let best = -1;
    for (let k = 0; k < bars.length; k++) if (best < 0 || Math.abs(bars[k].t - s.t) < Math.abs(bars[best].t - s.t)) best = k;
    if (best >= 0 && !bars[best].section) bars[best].section = s;
  }
  return bars;
}
