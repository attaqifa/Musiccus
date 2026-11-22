import type { Room } from './types';

/**
 * Synthesises a stereo reverb impulse response: decorrelated noise under an
 * exponential decay (RT60 = `decay`), with a low-pass that closes over time
 * so highs die first, plus a few early reflections that give each room its
 * shape. Energy is normalised so mix = 1 is about as loud as the dry signal.
 */
export function makeImpulse(
  ctx: BaseAudioContext,
  room: Room,
  decay: number,
  predelay: number,
  damping: number,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const pre = Math.round(predelay * rate);
  const tail = Math.ceil(decay * 1.15 * rate);
  const len = Math.max(1, pre + tail);
  const buf = ctx.createBuffer(2, len, rate);
  const k60 = 6.907755 / decay;

  const early: [number, number][] =
    room === 'plate'
      ? []
      : room === 'studio'
        ? [[0.004, 0.5], [0.009, 0.35], [0.013, 0.28], [0.021, 0.2]]
        : room === 'hall'
          ? [[0.011, 0.42], [0.019, 0.33], [0.031, 0.27], [0.047, 0.2], [0.062, 0.15]]
          : [[0.018, 0.4], [0.034, 0.32], [0.052, 0.26], [0.077, 0.2], [0.101, 0.16], [0.133, 0.12]];

  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    let seed = c === 0 ? 0x9e3779b9 : 0x85ebca6b;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) / 4294967296) * 2 - 1;
    };
    for (let i = 0; i < tail; i++) {
      const t = i / rate;
      const fc = Math.max(400, 17000 * Math.exp(-damping * 5 * (t / decay)));
      const alpha = 1 - Math.exp((-2 * Math.PI * fc) / rate);
      lp += alpha * (rand() - lp);
      // A short fade-in avoids a click and lets early reflections lead.
      const fadeIn = Math.min(1, t / 0.012);
      d[pre + i] = lp * Math.exp(-k60 * t) * fadeIn;
    }
    for (const [time, gain] of early) {
      const at = pre + Math.round(time * rate * (c === 0 ? 1 : 1.07));
      if (at < len) d[at] += gain * (c === 0 ? 1 : -1);
    }
    let energy = 0;
    for (let i = 0; i < len; i++) energy += d[i] * d[i];
    const norm = energy > 0 ? 1 / Math.sqrt(energy) : 0;
    for (let i = 0; i < len; i++) d[i] *= norm;
  }
  return buf;
}
