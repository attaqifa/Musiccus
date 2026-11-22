/*
 * Whole-song spectrogram for the authenticity view, on a linear frequency
 * axis (where a lossy encoder's low-pass shows as a flat ceiling). Runs on
 * demand, apart from the main analysis, so it never touches its cache.
 */
import { FFT, hann } from './fft';

export interface SpectroJob {
  id: number;
  mono: Float32Array;
  sampleRate: number;
  /** Highest frequency drawn: the file's own Nyquist, even if decoding resampled it. */
  topHz: number;
  cols: number;
  rows: number;
}

export type SpectroMessage =
  | { type: 'progress'; id: number; p: number }
  | { type: 'done'; id: number; data: Uint8Array; cols: number; rows: number; topHz: number }
  | { type: 'error'; id: number; message: string };

const N = 4096;
/** Levels mapped onto the colour ramp, dBFS. */
const LO = -120;
const HI = -20;
/** Never more FFT frames than this, so an hour-long mix stays quick. */
const MAX_FRAMES = 6000;

interface Scope {
  postMessage(msg: SpectroMessage, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<SpectroJob>) => void) | null;
}
const scope = self as unknown as Scope;

scope.onmessage = (e) => {
  const job = e.data;
  try {
    const { mono, sampleRate, topHz, rows } = job;
    const fft = new FFT(N);
    const w = hann(N);
    let wsum = 0;
    for (const v of w) wsum += v;
    // A full-scale sine peaks at |X| = sum(w) / 2.
    const ref = (wsum / 2) ** 2;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const binHz = sampleRate / N;
    const rowLo = new Int32Array(rows);
    const rowHi = new Int32Array(rows);
    for (let r = 0; r < rows; r++) {
      rowLo[r] = Math.min(N / 2 - 1, Math.floor(((r * topHz) / rows) / binHz));
      rowHi[r] = Math.max(rowLo[r], Math.min(N / 2 - 1, Math.floor((((r + 1) * topHz) / rows) / binHz) - 1));
    }
    const len = mono.length;
    const usable = Math.max(1, len - N);
    const hop = Math.max(N / 2, Math.ceil(usable / MAX_FRAMES));
    const frames = Math.max(1, Math.floor(usable / hop) + 1);
    // A short clip gets fewer columns rather than empty ones.
    const cols = Math.max(1, Math.min(job.cols, frames));
    const acc = new Float64Array(cols * rows);
    const count = new Uint32Array(cols);
    let lastPost = 0;
    for (let f = 0; f < frames; f++) {
      const start = f * hop;
      for (let i = 0; i < N; i++) {
        const k = start + i;
        re[i] = k < len ? mono[k] * w[i] : 0;
        im[i] = 0;
      }
      fft.transform(re, im);
      const col = Math.min(cols - 1, Math.floor((f * cols) / frames));
      count[col]++;
      const base = col * rows;
      for (let r = 0; r < rows; r++) {
        let p = 0;
        for (let k = rowLo[r]; k <= rowHi[r]; k++) p += re[k] * re[k] + im[k] * im[k];
        acc[base + r] += p / (rowHi[r] - rowLo[r] + 1);
      }
      if (f - lastPost > frames / 40) {
        lastPost = f;
        scope.postMessage({ type: 'progress', id: job.id, p: f / frames });
      }
    }
    const data = new Uint8Array(cols * rows);
    for (let c = 0; c < cols; c++) {
      const n = Math.max(1, count[c]);
      for (let r = 0; r < rows; r++) {
        const db = 10 * Math.log10(acc[c * rows + r] / n / ref + 1e-20);
        const t = Math.min(1, Math.max(0, (db - LO) / (HI - LO)));
        data[c * rows + r] = Math.round(t * 255);
      }
    }
    scope.postMessage({ type: 'done', id: job.id, data, cols, rows, topHz }, [data.buffer]);
  } catch (err) {
    scope.postMessage({ type: 'error', id: job.id, message: err instanceof Error ? err.message : String(err) });
  }
};
