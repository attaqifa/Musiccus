/** Bump when the analysis algorithm changes so cached results are recomputed. */
export const ANALYSIS_VERSION = 14;

export type ChordQuality = 'maj' | 'min';

export interface ChordSeg {
  t: number;
  end: number;
  /** Pitch class of the root, C = 0. */
  root: number;
  quality: ChordQuality;
  /** The listener corrected this chord (see fixes.ts). */
  fixed?: boolean;
}

export interface KeyInfo {
  tonic: number;
  mode: 'major' | 'minor';
  /** 0..1, how clearly this key beat the runner-up. */
  confidence: number;
  /** The listener set the key by hand. */
  fixed?: boolean;
}

export type SectionName = 'Intro' | 'Verse' | 'Chorus' | 'Bridge' | 'Outro' | 'Puncak' | 'Bagian';

export interface Section {
  t: number;
  end: number;
  /** Cluster letter: sections with the same letter sound alike. */
  label: string;
  name: SectionName;
  /** Mean loudness relative to the track, 0..1. */
  energy: number;
}

export interface Mastering {
  lufsI: number;
  lra: number;
  truePeakDb: number;
  samplePeakDb: number;
  plr: number;
  dr: number;
  crestDb: number;
  clipEvents: number;
  clippedSamples: number;
  dcOffsetDb: number;
  correlation: number;
  /** Side energy relative to mid, in percent. */
  width: number;
  /** 16, 24 or 32 (float / not integer PCM). 0 when it cannot be judged. */
  effectiveBits: number;
}

export type Verdict = 'genuine' | 'lossy-transcode' | 'upsampled' | 'padded-bits' | 'lossy' | 'inconclusive';

export interface Authenticity {
  verdict: Verdict;
  /** Frequency of a brick-wall low-pass, if one was found. */
  cutoffHz: number | null;
  /** Size of the drop at the cutoff, dB. */
  dropDb: number;
  summary: string;
  details: string[];
  /** Long-term average spectrum: log-spaced frequencies and their levels in dB. */
  ltasFreqs: Float32Array;
  ltasDb: Float32Array;
}

export interface Analysis {
  version: number;
  duration: number;
  bpm: number;
  tempoConfidence: number;
  beats: Float32Array;
  /** Indices into `beats` that start a bar (4/4 assumed). */
  downbeats: Int32Array;
  key: KeyInfo;
  chords: ChordSeg[];
  /** Spans the listener marked as having no chord, which the simple view must not fill. */
  fixedNone?: { t: number; end: number }[];
  /** Concert-pitch offset from A = 440 Hz in cents; A = 432 Hz is about −32. */
  tuningCents: number;
  sections: Section[];
  /** Loudness curve 0..1 sampled at `energyRate`. */
  energy: Float32Array;
  energyRate: number;
  /** 12 pitch-class strengths per frame, 0..255, at `chromaRate`. */
  chroma: Uint8Array;
  chromaRate: number;
  mastering: Mastering;
  authenticity: Authenticity;
  /** Wall-clock milliseconds the analysis took. */
  elapsedMs: number;
}

export interface AnalysisJob {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
  meta: {
    bitsPerSample?: number;
    lossless?: boolean;
    codec?: string;
    resampled: boolean;
    sourceRate: number;
  };
}

export type WorkerMessage =
  | { type: 'progress'; id: number; stage: string; p: number }
  | { type: 'done'; id: number; result: Analysis }
  | { type: 'error'; id: number; message: string };

export type Rgb = [number, number, number];

export interface Palette {
  a: Rgb;
  b: Rgb;
  c: Rgb;
}

/** Per-frame musical state, derived from the analysis and the heard time. */
export interface Music {
  ready: boolean;
  trackTime: number;
  bpm: number;
  beatIndex: number;
  beatPhase: number;
  barIndex: number;
  beatInBar: number;
  /** 1 on every beat of the grid, decaying. Anticipation-free: it is exact. */
  beatPulse: number;
  downbeatPulse: number;
  /** Increments on every beat, so consumers can detect a new beat. */
  beatCount: number;
  downbeatCount: number;
  chord: ChordSeg | null;
  nextChord: ChordSeg | null;
  key: KeyInfo | null;
  section: Section | null;
  sectionIndex: number;
  nextSection: Section | null;
  timeToNext: number;
  /** 0..1 rising before a louder section arrives. */
  anticipation: number;
  /** 1 at the start of a louder section, decaying. */
  impact: number;
  energy: number;
  palette: Palette;
  /** Expression colour for the UI (logo needle, prism, chord readouts), smoothed. */
  accent: Rgb;
  /** How active each separated stem is (0..1, after the stem mixer), or null without stems. */
  stems: Record<'vocals' | 'drums' | 'bass' | 'other', number> | null;
}
