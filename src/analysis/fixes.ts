import type { Track } from '../store/player';
import type { Analysis, ChordQuality, ChordSeg, KeyInfo } from './types';

/**
 * Corrections a listener made to the key and chords of one file.
 *
 * They are stored apart from the analysis cache, under the file's name, size
 * and date, so a newer analysis version keeps them. They also serve as
 * reference data: src/dev/chordBench.ts measures the analysis against them.
 */

export interface ChordFix {
  t: number;
  end: number;
  /** Pitch class, or -1 for "no chord here". */
  root: number;
  quality: ChordQuality;
  /** True when the listener chose this chord; false when they confirmed what the analysis heard (a checked sheet). */
  own: boolean;
}

export interface KeyFix {
  tonic: number;
  mode: KeyInfo['mode'];
  own: boolean;
}

/**
 * The tempo the listener settled on with ½× or 2×. Stored as the tempo, not
 * as the factor, so a later analysis version that already reads the right
 * octave is not halved again.
 */
export interface TempoFix {
  bpm: number;
}

export interface Fix {
  key?: KeyFix;
  tempo?: TempoFix;
  /** Applied in order, so a later span wins where two overlap. */
  chords: ChordFix[];
  /** The listener went through the whole sheet, so every span is a reference, not only the corrected ones. */
  checked: boolean;
  name: string;
  title: string;
  artist: string;
  duration: number;
  updated: number;
}

/** A chord the listener picks, or 'none' where nothing should be named. */
export type ChordPick = { root: number; quality: ChordQuality } | 'none';

export interface Span {
  t: number;
  end: number;
}

const PREFIX = 'musiccus:fix:';

/** Where a file's corrections are stored, or null for a tab. */
export async function fixId(t: Track): Promise<string | null> {
  if (t.live) return null;
  if (t.synth) return `${PREFIX}synth:${t.id}`;
  const file = t.file ?? (t.handle ? await t.handle.getFile() : undefined);
  return file ? `${PREFIX}${t.name}|${file.size}|${file.lastModified}` : null;
}

export const isFixId = (key: unknown): key is string => typeof key === 'string' && key.startsWith(PREFIX);

export function emptyFix(t: Track | undefined, duration: number): Fix {
  return {
    chords: [],
    checked: false,
    name: t?.name ?? '',
    title: t?.meta?.title || t?.name.replace(/\.[^.]+$/, '') || '',
    artist: t?.meta?.artist || '',
    duration,
    updated: Date.now(),
  };
}

export const hasContent = (f: Fix) => !!f.key || !!f.tempo || f.chords.length > 0 || f.checked;

/** Octaves (powers of two) from the analysis tempo to the listener's, within ±2. */
function tempoOctaves(analysed: number, wanted: number): number {
  if (!(analysed > 0) || !(wanted > 0)) return 0;
  return Math.max(-2, Math.min(2, Math.round(Math.log2(wanted / analysed))));
}

/**
 * The beat grid at twice or half the tempo. Doubling puts a beat halfway
 * between each pair; halving keeps every other beat, on the downbeats' side,
 * so bars still start where the analysis heard them.
 */
export function scaleTempo(a: Analysis, factor: 0.5 | 2): Analysis {
  if (a.beats.length < 4) return a;
  const old = a.beats;
  const d0 = a.downbeats[0] ?? 0;
  const beats: number[] = [];
  let first: number;
  if (factor === 2) {
    for (let i = 0; i < old.length; i++) {
      beats.push(old[i]);
      if (i + 1 < old.length) beats.push((old[i] + old[i + 1]) / 2);
    }
    first = d0 * 2;
  } else {
    for (let i = d0 % 2; i < old.length; i += 2) beats.push(old[i]);
    first = Math.floor(d0 / 2);
  }
  const downbeats: number[] = [];
  for (let i = first; i < beats.length; i += 4) downbeats.push(i);
  return {
    ...a,
    bpm: Math.round(a.bpm * factor * 10) / 10,
    // The reading this came from stays the other plausible octave.
    tempoAlt: factor === 2 ? 0.5 : 2,
    beats: new Float32Array(beats),
    downbeats: new Int32Array(downbeats),
  };
}

/** Sets the tempo the listener hears, or drops the correction when it is what the analysis read. */
export function setTempo(f: Fix, bpm: number, analysed: number): Fix {
  const tempo = tempoOctaves(analysed, bpm) === 0 ? undefined : { bpm };
  return { ...f, tempo, updated: Date.now() };
}

/** Removes [t, end) from a list of spans, keeping the parts around it. */
function cut<T extends Span>(list: T[], t: number, end: number): T[] {
  const out: T[] = [];
  for (const c of list) {
    if (c.end <= t || c.t >= end) {
      out.push(c);
      continue;
    }
    // Slivers under 50 ms are rounding between two views of the same beat.
    if (c.t < t - 0.05) out.push({ ...c, end: t });
    if (c.end > end + 0.05) out.push({ ...c, t: end });
  }
  return out;
}

const sameChord = (a: ChordSeg, b: ChordSeg) => a.root === b.root && a.quality === b.quality;

/** The analysis as the listener corrected it. Returns the same object when nothing was corrected. */
export function applyFix(a: Analysis, f: Fix | undefined): Analysis {
  if (!f) return a;
  const octaves = f.tempo ? tempoOctaves(a.bpm, f.tempo.bpm) : 0;
  for (let i = 0; i < Math.abs(octaves); i++) a = scaleTempo(a, octaves > 0 ? 2 : 0.5);
  if (!f.key && f.chords.length === 0) return a;
  let chords = a.chords;
  for (const c of f.chords) {
    chords = cut(chords, c.t, c.end);
    if (c.root >= 0) chords.push({ t: c.t, end: c.end, root: c.root, quality: c.quality, ...(c.own ? { fixed: true } : {}) });
    chords.sort((x, y) => x.t - y.t);
  }
  // Two pieces of the same chord side by side read as one.
  const joined: ChordSeg[] = [];
  for (const c of chords) {
    const p = joined[joined.length - 1];
    if (p && Math.abs(p.end - c.t) < 0.05 && sameChord(p, c)) joined[joined.length - 1] = { ...p, end: c.end, ...(p.fixed || c.fixed ? { fixed: true } : {}) };
    else joined.push(c);
  }
  const none = f.chords.filter((c) => c.root < 0).map(({ t, end }) => ({ t, end }));
  // A key confirmed on a checked sheet keeps the analysis' confidence while the two agree.
  const agrees = f.key && f.key.tonic === a.key.tonic && f.key.mode === a.key.mode;
  const key: KeyInfo = !f.key || (agrees && !f.key.own) ? a.key : { tonic: f.key.tonic, mode: f.key.mode, confidence: 1, ...(f.key.own ? { fixed: true } : {}) };
  return { ...a, key, chords: joined, ...(none.length ? { fixedNone: none } : {}) };
}

/** The chords the analysis heard inside a span, gaps included, as confirmed spans. */
function confirmed(chords: ChordSeg[], from: number, to: number): ChordFix[] {
  const out: ChordFix[] = [];
  let at = from;
  for (const c of chords) {
    if (c.end <= from || c.t >= to) continue;
    const t = Math.max(from, c.t);
    if (t > at + 0.05) out.push({ t: at, end: t, root: -1, quality: 'maj', own: false });
    const end = Math.min(to, c.end);
    out.push({ t, end, root: c.root, quality: c.quality, own: false });
    at = Math.max(at, end);
  }
  if (to > at + 0.05) out.push({ t: at, end: to, root: -1, quality: 'maj', own: false });
  return out;
}

export function setChords(f: Fix, spans: Span[], pick: ChordPick): Fix {
  let chords = f.chords;
  for (const s of spans) chords = cut(chords, s.t, s.end);
  const add = spans.map((s): ChordFix => (pick === 'none' ? { ...s, root: -1, quality: 'maj', own: true } : { ...s, ...pick, own: true }));
  return { ...f, chords: [...chords, ...add], updated: Date.now() };
}

/** Back to what the analysis heard. On a checked sheet that is confirmed as right. */
export function revertChords(f: Fix, spans: Span[], raw: ChordSeg[]): Fix {
  let chords = f.chords;
  for (const s of spans) chords = cut(chords, s.t, s.end);
  if (f.checked) for (const s of spans) chords = [...chords, ...confirmed(raw, s.t, s.end)];
  return { ...f, chords, updated: Date.now() };
}

export function setKey(f: Fix, key: { tonic: number; mode: KeyInfo['mode'] } | null, raw: KeyInfo): Fix {
  let next: KeyFix | undefined;
  if (key) next = { ...key, own: true };
  else if (f.checked) next = { tonic: raw.tonic, mode: raw.mode, own: false };
  return { ...f, key: next, updated: Date.now() };
}

/**
 * Marks the sheet as gone through: every chord in the view the listener read
 * is kept as a reference, so a later analysis version cannot change it.
 * Unmarking keeps only the listener's own corrections.
 */
export function setChecked(f: Fix, on: boolean, view: ChordSeg[], key: KeyInfo, duration: number): Fix {
  const own = f.chords.filter((c) => c.own);
  if (!on) return { ...f, checked: false, chords: own, key: f.key?.own ? f.key : undefined, updated: Date.now() };
  return {
    ...f,
    checked: true,
    duration,
    chords: [...confirmed(view, 0, duration), ...own],
    key: f.key ?? { tonic: key.tonic, mode: key.mode, own: false },
    updated: Date.now(),
  };
}

// Harte syntax, as in the Isophonics and Billboard annotations.
const HARTE = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export const harteChord = (c: { root: number; quality: ChordQuality }) => `${HARTE[c.root]}:${c.quality}`;
export const harteKey = (k: { tonic: number; mode: KeyInfo['mode'] }) => `${HARTE[k.tonic]}:${k.mode}`;

/**
 * A chord sheet as a MIREX .lab file: start, end and label per line, with N
 * where no chord sounds. The key goes in a comment line, which mir_eval and
 * src/dev/chordBench.ts read past.
 */
export function toLab(chords: ChordSeg[], key: KeyInfo, duration: number, title: string): string {
  const lines = [`# ${title.replace(/\s+/g, ' ')}`, `# key: ${harteKey(key)}`];
  const row = (t: number, end: number, label: string) => lines.push(`${t.toFixed(3)}\t${end.toFixed(3)}\t${label}`);
  let at = 0;
  for (const c of chords) {
    if (c.t > at + 0.05) row(at, c.t, 'N');
    row(Math.max(at, c.t), c.end, harteChord(c));
    at = Math.max(at, c.end);
  }
  if (duration > at + 0.05) row(at, duration, 'N');
  return lines.join('\n') + '\n';
}
