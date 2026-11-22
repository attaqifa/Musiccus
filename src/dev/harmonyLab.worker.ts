import { harmonyChroma, type HarmonyParams } from '../analysis/harmony';
import { downmix } from '../analysis/worker';

interface Job {
  id: number;
  L: Float32Array;
  R: Float32Array;
  sampleRate: number;
  beats: Float32Array;
  duration: number;
  params: HarmonyParams;
}

const scope = self as unknown as { postMessage(m: unknown): void; onmessage: ((e: MessageEvent<Job>) => void) | null };

// Importing the analysis worker installs its handler; this one replaces it.
scope.onmessage = (e) => {
  const j = e.data;
  try {
    const { x, rate } = downmix(j.L, j.R, j.sampleRate);
    const { bc, tuning } = harmonyChroma(x, rate, j.beats, j.duration, j.params);
    scope.postMessage({ id: j.id, bc, tuning });
  } catch (err) {
    scope.postMessage({ id: j.id, error: err instanceof Error ? err.message : String(err) });
  }
};
