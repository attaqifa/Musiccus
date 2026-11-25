import type { Analysis } from '../analysis/types';
import { analyse } from './analysisLab';

/**
 * Measures tempo and beat tracking on real recordings.
 *
 * References sit beside the audio, under the same name:
 *   song.beats, song.beats.txt or song.txt   beat times, one per line, each
 *       optionally followed by the beat's place in the bar ("0.464 1" as in
 *       the Isophonics Beatles annotations, or "0.464 1.1"); 1 is a downbeat
 *   song.bpm or song.bpm.txt   a tempo, such as "80", when there is no beat
 *       annotation (a tempo from a site like songbpm, or tapped by hand)
 *
 * In the dev console:
 *   const b = await import('/src/dev/beatBench.ts');
 *   await b.benchBeatsFolder();
 *
 * Scores follow mir_eval and MIREX. Tempo is right within 4% (Acc1), or right
 * up to a factor of 2 or 3 (Acc2): the gap between the two is the octave
 * errors. Beats and downbeats score an F-measure within ±70 ms, skipping the
 * first 5 s as mir_eval does.
 */

export interface BeatRef {
  beats: number[];
  /** Null when the annotation does not mark bars. */
  downbeats: number[] | null;
}

/** One beat per line: a time, then optionally its place in the bar. Comments (#) and blank lines are skipped. */
export function parseBeats(text: string): BeatRef {
  const beats: number[] = [];
  const downbeats: number[] = [];
  let marked = false;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const parts = s.split(/[\s,]+/);
    const t = Number(parts[0]);
    if (!Number.isFinite(t)) continue;
    beats.push(t);
    const pos = parts[1];
    if (pos === undefined) continue;
    const place = pos.includes('.') ? Number(pos.split('.')[1]) : Number(pos);
    if (!Number.isFinite(place)) continue;
    marked = true;
    if (place === 1) downbeats.push(t);
  }
  beats.sort((a, b) => a - b);
  return { beats, downbeats: marked ? downbeats : null };
}

/** The tempo of an annotation: the median beat period, as the reference most tempo datasets use. */
export function refTempo(beats: number[]): number | null {
  const d: number[] = [];
  for (let i = 1; i < beats.length; i++) if (beats[i] > beats[i - 1]) d.push(beats[i] - beats[i - 1]);
  if (d.length < 4) return null;
  d.sort((a, b) => a - b);
  return 60 / d[d.length >> 1];
}

export type TempoVerdict = 'benar' | 'dua kali lipat' | 'setengahnya' | 'tiga kali lipat' | 'sepertiganya' | 'salah';

const FACTORS: [number, TempoVerdict][] = [
  [1, 'benar'],
  [2, 'dua kali lipat'],
  [0.5, 'setengahnya'],
  [3, 'tiga kali lipat'],
  [1 / 3, 'sepertiganya'],
];

/** How the estimated tempo relates to the reference, within MIREX's 4%. */
export function scoreTempo(est: number, ref: number): { verdict: TempoVerdict; acc1: boolean; acc2: boolean } {
  for (const [k, verdict] of FACTORS) {
    if (Math.abs(est - ref * k) <= 0.04 * ref * k) return { verdict, acc1: k === 1, acc2: true };
  }
  return { verdict: 'salah', acc1: false, acc2: false };
}

/** Beat F-measure: each reference beat matches at most one estimate within the window. */
export function fMeasure(est: ArrayLike<number>, ref: number[], window = 0.07, from = 5): number {
  const e = Array.from(est).filter((t) => t >= from);
  const r = ref.filter((t) => t >= from);
  if (!e.length && !r.length) return 1;
  if (!e.length || !r.length) return 0;
  let hits = 0;
  let j = 0;
  for (const t of r) {
    while (j < e.length && e[j] < t - window) j++;
    if (j < e.length && Math.abs(e[j] - t) <= window) {
      hits++;
      j++;
    }
  }
  const p = hits / e.length;
  const rc = hits / r.length;
  return p + rc > 0 ? (2 * p * rc) / (p + rc) : 0;
}

export interface BeatRow {
  song: string;
  reference: string;
  'tempo acuan': string;
  'tempo Musiccus': string;
  hasil: TempoVerdict | '—';
  /** The tempo after the "bisa juga" octave the app offers, when it offers one. */
  'dengan tawaran ×2/½': string;
  'beat F': string;
  'downbeat F': string;
  acc1?: boolean;
  acc2?: boolean;
  altFixes?: boolean;
  beatF?: number;
}

const num = (v: number, d = 1) => v.toFixed(d).replace('.', ',');

/** Analyses one file the way the app hears it and scores it against a beat annotation or a tempo. */
export async function scoreBeatFile(song: string, file: Blob, ref: { beats?: BeatRef; bpm?: number }, reference = ''): Promise<BeatRow> {
  const empty = { 'tempo acuan': '—', 'tempo Musiccus': '—', hasil: '—' as const, 'dengan tawaran ×2/½': '—', 'beat F': '—', 'downbeat F': '—' };
  try {
    const ctx = new OfflineAudioContext(2, 1, 44100);
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    const a: Analysis = await analyse(buffer);
    const bpm = ref.bpm ?? (ref.beats ? refTempo(ref.beats.beats) : null);
    if (!bpm) return { song, reference: `${reference}; acuan tidak terbaca`, ...empty };
    const t = scoreTempo(a.bpm, bpm);
    const withAlt = a.tempoAlt ? scoreTempo(a.bpm * a.tempoAlt, bpm) : null;
    const beatF = ref.beats ? fMeasure(a.beats, ref.beats.beats) : undefined;
    const downF = ref.beats?.downbeats ? fMeasure(Array.from(a.downbeats, (i) => a.beats[i]), ref.beats.downbeats) : undefined;
    return {
      song,
      reference,
      'tempo acuan': num(bpm),
      'tempo Musiccus': num(a.bpm),
      hasil: t.verdict,
      'dengan tawaran ×2/½': a.tempoAlt ? `${num(a.bpm * a.tempoAlt)} (${withAlt!.verdict})` : 'tidak ditawarkan',
      'beat F': beatF === undefined ? '—' : num(beatF * 100) + '%',
      'downbeat F': downF === undefined ? '—' : num(downF * 100) + '%',
      acc1: t.acc1,
      acc2: t.acc2,
      altFixes: !t.acc1 && !!withAlt?.acc1,
      beatF,
    };
  } catch (e) {
    return { song, reference: `${reference}; gagal: ${(e as Error).message}`, ...empty };
  }
}

const AUDIO = /\.(flac|wav|mp3|m4a|aac|ogg|oga|opus|webm|aif|aiff)$/i;

async function walk(dir: FileSystemDirectoryHandle, path = '', out = new Map<string, File>()) {
  for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (h.kind === 'file') out.set(`${path}${name}`, await (h as FileSystemFileHandle).getFile());
    else await walk(h as FileSystemDirectoryHandle, `${path}${name}/`, out);
  }
  return out;
}

/** Every audio file in a folder (and its subfolders) with a beat annotation or a tempo beside it. */
export async function benchBeatsFolder(dir?: FileSystemDirectoryHandle) {
  const root = dir ?? (await (window as unknown as { showDirectoryPicker(): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker());
  const files = await walk(root);
  const rows: BeatRow[] = [];
  for (const [path, file] of files) {
    if (!AUDIO.test(path)) continue;
    const base = path.replace(/\.[^.]+$/, '');
    const beatFile = files.get(`${base}.beats`) ?? files.get(`${base}.beats.txt`) ?? files.get(`${base}.txt`);
    const bpmFile = files.get(`${base}.bpm`) ?? files.get(`${base}.bpm.txt`);
    if (beatFile) rows.push(await scoreBeatFile(path, file, { beats: parseBeats(await beatFile.text()) }, 'anotasi beat'));
    else if (bpmFile) rows.push(await scoreBeatFile(path, file, { bpm: Number((await bpmFile.text()).trim().split(/\s+/)[0]) }, 'tempo'));
  }
  return reportBeats(rows);
}

export function reportBeats(rows: BeatRow[]) {
  const scored = rows.filter((r) => r.acc1 !== undefined);
  const share = (f: (r: BeatRow) => boolean) => (scored.length ? `${num((100 * scored.filter(f).length) / scored.length)}%` : '—');
  const withBeats = scored.filter((r) => r.beatF !== undefined);
  const total = {
    songs: scored.length,
    'tempo benar (Acc1)': share((r) => !!r.acc1),
    'tempo benar sampai ×2/×3 (Acc2)': share((r) => !!r.acc2),
    'salah oktaf, tawaran ×2/½ benar': share((r) => !!r.altFixes),
    'beat F rata-rata': withBeats.length ? `${num((100 * withBeats.reduce((s, r) => s + r.beatF!, 0)) / withBeats.length)}% (${withBeats.length} lagu)` : '—',
  };
  console.table(rows.map(({ acc1: _a, acc2: _b, altFixes: _c, beatF: _d, ...r }) => r));
  console.log('Total:', total);
  return { rows, total };
}
