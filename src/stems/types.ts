/** The four stems, in display order. `other` is never stored: it is the mix minus the rest. */
export type StemId = 'vocals' | 'drums' | 'bass' | 'other';
export const STEMS: StemId[] = ['vocals', 'drums', 'bass', 'other'];
/** Stems that exist as audio; `other` is derived so the four always sum to the original. */
export const STORED: Exclude<StemId, 'other'>[] = ['vocals', 'drums', 'bass'];

export const STEM_LABEL: Record<StemId, string> = {
  vocals: 'Vokal',
  drums: 'Drum',
  bass: 'Bass',
  other: 'Lainnya',
};

/**
 * Categorical identity colours. They name instruments, so unlike the key
 * colours they never move; they also stay clear of the status hues
 * (green = pure, amber = changed, red = problem).
 */
export const STEM_COLOR: Record<StemId, string> = {
  vocals: '#E6A3C4',
  drums: '#8DB6E2',
  bass: '#A99BEA',
  other: '#9CCFC4',
};

export type SeparationEngine = 'ai' | 'dsp';

/** htdemucs runs at 44.1 kHz; everything else stays at the file's own rate. */
export const MODEL_RATE = 44100;
/** Stem level envelopes, frames per second. */
export const ENV_RATE = 50;
/** Level envelopes store dBFS from -60 to 0 as 0..255. */
export const ENV_FLOOR_DB = -60;

export const MODEL_COMMIT = 'a4a57cc0cf707e5b9a3e6ad3c2c4b21fcbe608c1';
/** Model pieces: the pinned Hugging Face commit, or a self-hosted copy (VITE_MODEL_BASE, ending in /). */
export const MODEL_BASE = import.meta.env.VITE_MODEL_BASE || `https://huggingface.co/monteslu/htdemucs-web-onnx/resolve/${MODEL_COMMIT}/`;
/** Sum of the 21 model pieces, for download progress before sizes are known. */
export const MODEL_BYTES = 125_881_245;
export const MODEL_CACHE = 'musiccus-models-v1';

/** Cached AI stems: vocals L/R, drums L/R, bass L/R as int16 at `rate`. */
export interface CachedStems {
  rate: number;
  data: Int16Array[];
}

export interface SeparateRequest {
  type: 'separate';
  id: number;
  engine: SeparationEngine;
  rate: number;
  left: Float32Array;
  right: Float32Array;
  /** A previous AI result, so the model does not run again. */
  cached?: CachedStems;
}

export interface SeparateResult {
  type: 'done';
  id: number;
  /** vocals L, vocals R, drums L, drums R, bass L, bass R at the request rate. */
  stems: Float32Array[];
  /** Level envelopes for vocals, drums, bass, other. */
  levels: Uint8Array[];
  /** AI output at the request rate, int16, to cache. Absent for DSP and cache hits. */
  raw?: CachedStems;
  backend: string;
  elapsedMs: number;
}

export type StemWorkerMessage =
  | { type: 'progress'; id: number; stage: string; p: number }
  | SeparateResult
  | { type: 'error'; id: number; message: string };
