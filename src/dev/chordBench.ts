import { get, keys } from 'idb-keyval';
import { fixId, isFixId, type Fix } from '../analysis/fixes';
import type { Analysis, ChordSeg, KeyInfo } from '../analysis/types';
import { getState, type Track } from '../store/player';
import { analyse } from './analysisLab';

/**
 * Measures key and chord detection on real recordings.
 *
 * References come from MIREX .lab files beside the audio (the Isophonics and
 * Billboard annotations, or the sheet the app exports with "Unduh .lab"), or
 * from the corrections stored in the app. Only the annotations are needed;
 * the audio is your own.
 *
 * In the dev console:
 *   const b = await import('/src/dev/chordBench.ts');
 *   await b.benchFolder();  // a folder with song.flac + song.lab (+ song.key.lab)
 *   await b.benchFixes();   // songs in the open library that have corrections
 *
 * Scores follow mir_eval: chord accuracy is the share of reference time with
 * the right label (root only, and major/minor), and the key score is MIREX's
 * (1 right, 0.5 a fifth above, 0.3 relative, 0.2 parallel).
 */

/* --------------------------------------------------------- References -- */

/** maj and min are scored on major/minor; other chords on their root only; X is skipped. */
export type RefClass = 'maj' | 'min' | 'other' | 'N' | 'X';

export interface RefChord {
  t: number;
  end: number;
  root: number;
  cls: RefClass;
}

export interface RefKey {
  tonic: number;
  mode: KeyInfo['mode'];
}

const LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function pitchClass(s: string): number | null {
  const m = /^([A-G])([#b]*)$/.exec(s.trim());
  if (!m) return null;
  let p = LETTER[m[1]];
  for (const ch of m[2]) p += ch === '#' ? 1 : -1;
  return ((p % 12) + 12) % 12;
}

const MAJOR = new Set(['', 'maj', '7', 'maj7', '9', 'maj9', '11', 'maj11', '13', 'maj13', '6', 'maj6']);
const MINOR = new Set(['min', 'min7', 'minmaj7', 'min6', 'min9', 'min11', 'min13']);

/** One Harte label (C:min7/b3, Bb:maj(9), N, X) as a root and a class. */
export function parseChordLabel(label: string): { root: number; cls: RefClass } {
  const l = label.trim();
  if (l === 'N' || l === '') return { root: -1, cls: 'N' };
  const colon = l.indexOf(':');
  const head = (colon < 0 ? l : l.slice(0, colon)).split('/')[0];
  const root = pitchClass(head);
  if (root === null) return { root: -1, cls: 'X' };
  if (colon < 0) return { root, cls: 'maj' };
  const q = l.slice(colon + 1).split('/')[0];
  const shorthand = q.replace(/\(.*$/, '');
  const list = /\(([^)]*)\)/.exec(q)?.[1].split(',').map((s) => s.trim()) ?? [];
  // A removed third or fifth (*3, *5) leaves no triad to judge.
  if (list.some((iv) => /^\*b?[35]$/.test(iv))) return { root, cls: 'other' };
  if (shorthand === '' && list.length) {
    if (list.includes('3') && list.includes('5')) return { root, cls: 'maj' };
    if (list.includes('b3') && list.includes('5')) return { root, cls: 'min' };
    return { root, cls: 'other' };
  }
  if (MAJOR.has(shorthand)) return { root, cls: 'maj' };
  if (MINOR.has(shorthand)) return { root, cls: 'min' };
  return { root, cls: 'other' };
}

/** "E:minor", "E minor", "Eb", "A:dorian" as a key. Modal keys count by their third. */
export function parseKeyLabel(label: string): RefKey | null {
  const [t, m = 'major'] = label.trim().split(/[:\s]+/);
  const tonic = pitchClass(t);
  if (tonic === null) return null;
  const minor = /^(min|minor|aeolian|dorian|phrygian|locrian)$/i.test(m);
  return { tonic, mode: minor ? 'minor' : 'major' };
}

/**
 * A .lab file: "start end label" per line. Lines starting with # are
 * comments, except "# key: E:minor" (the app's export) and "# tonic: E"
 * (Billboard). Isophonics key files ("start end Key E:minor") work too.
 */
export function parseLab(text: string): { chords: RefChord[]; key: RefKey | null } {
  const chords: RefChord[] = [];
  const keySpans: { d: number; key: RefKey }[] = [];
  let key: RefKey | null = null;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    if (s.startsWith('#')) {
      const m = /^#\s*(?:key|tonic)\s*:\s*(.+)$/i.exec(s);
      if (m) key = parseKeyLabel(m[1]) ?? key;
      continue;
    }
    const parts = s.split(/\s+/);
    if (parts.length < 3) continue;
    const t = Number(parts[0]);
    const end = Number(parts[1]);
    if (!Number.isFinite(t) || !Number.isFinite(end) || end <= t) continue;
    const label = parts.slice(2).join(' ');
    if (/^key\b/i.test(label)) {
      const k = parseKeyLabel(label.replace(/^key\s*/i, ''));
      if (k) keySpans.push({ d: end - t, key: k });
      continue;
    }
    if (/^silence$/i.test(label)) continue;
    chords.push({ t, end, ...parseChordLabel(label) });
  }
  // A key file with modulations: the key held longest.
  if (!key && keySpans.length) key = keySpans.reduce((a, b) => (b.d > a.d ? b : a)).key;
  return { chords, key };
}

/** A stored correction as a reference: the whole sheet when checked, else the corrected spans. */
function fixReference(f: Fix): { chords: RefChord[]; key: RefKey | null } {
  return {
    chords: f.chords.map((c) => ({ t: c.t, end: c.end, root: c.root, cls: c.root < 0 ? 'N' : c.quality })),
    key: f.key ? { tonic: f.key.tonic, mode: f.key.mode } : null,
  };
}

/* ------------------------------------------------------------ Scoring -- */

export interface ChordScore {
  /** Seconds scored, and the seconds right, per measure. */
  rootTotal: number;
  rootRight: number;
  majminTotal: number;
  majminRight: number;
}

/** Time-weighted agreement over the reference spans; gaps in the estimate are N. */
export function scoreChords(est: ChordSeg[], ref: RefChord[]): ChordScore {
  const s: ChordScore = { rootTotal: 0, rootRight: 0, majminTotal: 0, majminRight: 0 };
  for (const r of ref) {
    if (r.cls === 'X') continue;
    const pieces: [number, ChordSeg | null][] = [];
    let at = r.t;
    for (const e of est) {
      if (e.end <= r.t || e.t >= r.end) continue;
      const a = Math.max(r.t, e.t);
      const b = Math.min(r.end, e.end);
      if (a > at) pieces.push([a - at, null]);
      if (b > a) pieces.push([b - Math.max(a, at), e]);
      at = Math.max(at, b);
    }
    if (r.end > at) pieces.push([r.end - at, null]);
    for (const [d, e] of pieces) {
      if (d <= 0) continue;
      const rootOk = r.cls === 'N' ? !e : !!e && e.root === r.root;
      s.rootTotal += d;
      if (rootOk) s.rootRight += d;
      if (r.cls === 'maj' || r.cls === 'min' || r.cls === 'N') {
        s.majminTotal += d;
        if (r.cls === 'N' ? !e : rootOk && e!.quality === r.cls) s.majminRight += d;
      }
    }
  }
  return s;
}

export type KeyVerdict = 'benar' | 'kelima' | 'relatif' | 'paralel' | 'salah';

/** MIREX key score. A fifth counts only upwards (the dominant), as in mir_eval's default. */
export function scoreKey(est: RefKey, ref: RefKey): { score: number; verdict: KeyVerdict } {
  const up = (est.tonic - ref.tonic + 12) % 12;
  if (est.mode === ref.mode && up === 0) return { score: 1, verdict: 'benar' };
  if (est.mode === ref.mode && up === 7) return { score: 0.5, verdict: 'kelima' };
  if (est.mode !== ref.mode && up === (ref.mode === 'major' ? 9 : 3)) return { score: 0.3, verdict: 'relatif' };
  if (est.mode !== ref.mode && up === 0) return { score: 0.2, verdict: 'paralel' };
  return { score: 0, verdict: 'salah' };
}

/* ------------------------------------------------------------- Runner -- */

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const keyText = (k: RefKey) => `${NAMES[k.tonic]}${k.mode === 'minor' ? 'm' : ''}`;
const pct = (right: number, total: number) => (total > 0 ? `${((100 * right) / total).toFixed(1)}%` : '—');

export interface BenchRow {
  song: string;
  reference: string;
  key: string;
  root: string;
  majmin: string;
  seconds: number;
  score?: ChordScore;
  keyScore?: number;
}

/** Analyses one file and scores it, the way the app would hear it. */
export async function scoreFile(file: File, ref: { chords: RefChord[]; key: RefKey | null }): Promise<{ analysis: Analysis; score: ChordScore; key: ReturnType<typeof scoreKey> | null }> {
  const ctx = new OfflineAudioContext(2, 1, 44100);
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  const analysis = await analyse(buffer);
  return {
    analysis,
    score: scoreChords(analysis.chords, ref.chords),
    key: ref.key ? scoreKey(analysis.key, ref.key) : null,
  };
}

function summarise(rows: BenchRow[]) {
  const sum = (f: (s: ChordScore) => number) => rows.reduce((a, r) => a + (r.score ? f(r.score) : 0), 0);
  const keyed = rows.filter((r) => r.keyScore !== undefined);
  return {
    songs: rows.filter((r) => r.score).length,
    root: pct(sum((s) => s.rootRight), sum((s) => s.rootTotal)),
    majmin: pct(sum((s) => s.majminRight), sum((s) => s.majminTotal)),
    key: keyed.length ? `${((100 * keyed.reduce((a, r) => a + r.keyScore!, 0)) / keyed.length).toFixed(1)}% (MIREX, ${keyed.length} lagu)` : '—',
  };
}

const AUDIO = /\.(flac|wav|mp3|m4a|aac|ogg|oga|opus|webm|aif|aiff)$/i;

async function walk(dir: FileSystemDirectoryHandle, path = '', out = new Map<string, File>()) {
  for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (h.kind === 'file') out.set(`${path}${name}`, await (h as FileSystemFileHandle).getFile());
    else await walk(h as FileSystemDirectoryHandle, `${path}${name}/`, out);
  }
  return out;
}

/**
 * Every audio file in a folder (and its subfolders) that has a .lab beside
 * it with the same name. A key can also come from song.key.lab or
 * song.keylab.
 */
export async function benchFolder(dir?: FileSystemDirectoryHandle) {
  const root = dir ?? (await (window as unknown as { showDirectoryPicker(): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker());
  const files = await walk(root);
  const rows: BenchRow[] = [];
  for (const [path, file] of files) {
    if (!AUDIO.test(path)) continue;
    const base = path.replace(/\.[^.]+$/, '');
    const lab = files.get(`${base}.lab`) ?? files.get(`${base}.chords.lab`);
    if (!lab) continue;
    const ref = parseLab(await lab.text());
    const keyFile = files.get(`${base}.key.lab`) ?? files.get(`${base}.keylab`);
    if (keyFile) ref.key = parseLab(await keyFile.text()).key ?? ref.key;
    rows.push(await row(path, 'file .lab', file, ref));
  }
  return report(rows);
}

/** Songs with stored corrections that are in the open library, analysed afresh. */
export async function benchFixes() {
  const ids = (await keys()).filter(isFixId);
  const stored = new Map<string, Fix>();
  for (const id of ids) {
    const f = (await get(id)) as Fix | undefined;
    if (f) stored.set(id, f);
  }
  // Only tracks whose file name matches a correction need opening.
  const names = new Set([...stored.values()].map((f) => f.name));
  const found = new Map<string, Track>();
  for (const t of Object.values(getState().tracks)) {
    if (!names.has(t.name)) continue;
    const id = await fixId(t);
    if (id) found.set(id, t);
  }
  const rows: BenchRow[] = [];
  for (const [id, f] of stored) {
    const t = found.get(id);
    const song = [f.artist, f.title].filter(Boolean).join(' – ') || f.name;
    const scope = f.checked ? 'seluruh lagu diperiksa' : 'bagian yang dikoreksi';
    const file = t?.file ?? (t?.handle ? await t.handle.getFile() : undefined);
    if (!file) {
      rows.push({ song, reference: `${scope}; file tidak ada di pustaka yang terbuka`, key: '—', root: '—', majmin: '—', seconds: 0 });
      continue;
    }
    rows.push(await row(song, scope, file, fixReference(f)));
  }
  return report(rows);
}

async function row(song: string, reference: string, file: File, ref: { chords: RefChord[]; key: RefKey | null }): Promise<BenchRow> {
  try {
    const r = await scoreFile(file, ref);
    return {
      song,
      reference,
      key: ref.key ? `${keyText(r.analysis.key)} vs ${keyText(ref.key)}: ${r.key!.verdict}` : `${keyText(r.analysis.key)} (tanpa acuan)`,
      root: pct(r.score.rootRight, r.score.rootTotal),
      majmin: pct(r.score.majminRight, r.score.majminTotal),
      seconds: Math.round(r.score.rootTotal),
      score: r.score,
      keyScore: r.key?.score,
    };
  } catch (e) {
    return { song, reference: `${reference}; gagal: ${(e as Error).message}`, key: '—', root: '—', majmin: '—', seconds: 0 };
  }
}

function report(rows: BenchRow[]) {
  const total = summarise(rows);
  console.table(rows.map(({ score: _s, keyScore: _k, ...r }) => r));
  console.log('Total (tertimbang durasi):', total);
  return { rows, total };
}
