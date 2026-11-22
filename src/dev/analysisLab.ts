/*
 * Analysis lab: synthetic songs with known tempo, chords and structure, to
 * measure the analysis worker's accuracy. Not imported by the app; load it
 * from the dev console:
 *
 *   const lab = await import('/src/dev/analysisLab.ts');
 *   await lab.runSuite();
 */
import type { Analysis, AnalysisJob, WorkerMessage } from '../analysis/types';
import { renderDemo } from '../audio/decode';

type Chord = [root: number, quality: '' | 'm'];

export interface SynthSpec {
  bpm: number;
  progression: Chord[];
  bars: number;
  rate?: number;
  introBars?: number;
}

/** A loop with pad chords, kick, bass, snare on 2 and 4, hats on eighths. */
export async function synth({ bpm, progression, bars, rate = 44100, introBars = 2 }: SynthSpec): Promise<AudioBuffer> {
  const beat = 60 / bpm;
  const bar = beat * 4;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil((bars * bar + 1) * rate), sampleRate: rate });
  const master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
  const noise = ctx.createBuffer(1, rate, rate);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const env = (g: GainNode, t: number, a: number, p: number, d: number) => {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(p, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  };
  const freq = (pc: number, oct: number) => 440 * Math.pow(2, (pc - 9) / 12 + (oct - 4));
  for (let b = 0; b < bars; b++) {
    const t0 = 0.1 + b * bar;
    const [root, q] = progression[b % progression.length];
    for (const iv of [0, q === 'm' ? 3 : 4, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq((root + iv) % 12, 4);
      const lp = ctx.createBiquadFilter();
      lp.frequency.value = 1800;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.05, t0 + 0.1);
      g.gain.setValueAtTime(0.05, t0 + bar - 0.1);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + bar);
      o.connect(lp).connect(g).connect(master);
      o.start(t0);
      o.stop(t0 + bar);
    }
    if (b < introBars) continue;
    for (let i = 0; i < 4; i++) {
      const t = t0 + i * beat;
      const k = ctx.createOscillator();
      const kg = ctx.createGain();
      k.frequency.setValueAtTime(150, t);
      k.frequency.exponentialRampToValueAtTime(45, t + 0.1);
      env(kg, t, 0.002, 0.9, 0.35);
      k.connect(kg).connect(master);
      k.start(t);
      k.stop(t + 0.4);
      const bo = ctx.createOscillator();
      bo.type = 'triangle';
      bo.frequency.value = freq(root, 2);
      const bg = ctx.createGain();
      env(bg, t, 0.01, 0.35, beat * 0.8);
      bo.connect(bg).connect(master);
      bo.start(t);
      bo.stop(t + beat);
      if (i % 2 === 1) {
        const n = ctx.createBufferSource();
        n.buffer = noise;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 2000;
        const g2 = ctx.createGain();
        env(g2, t, 0.002, 0.5, 0.18);
        n.connect(bp).connect(g2).connect(master);
        n.start(t);
        n.stop(t + 0.2);
      }
      for (const h of [0, 0.5]) {
        const th = t + h * beat;
        const n = ctx.createBufferSource();
        n.buffer = noise;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 8000;
        const g3 = ctx.createGain();
        env(g3, th, 0.001, h ? 0.12 : 0.08, 0.04);
        n.connect(hp).connect(g3).connect(master);
        n.start(th);
        n.stop(th + 0.06);
      }
    }
  }
  return ctx.startRendering();
}

export async function analyse(buffer: AudioBuffer, meta: Partial<AnalysisJob['meta']> = {}): Promise<Analysis> {
  const worker = new Worker(new URL('../analysis/worker.ts', import.meta.url), { type: 'module' });
  const channels = [0, 1].map((c) => {
    const a = new Float32Array(buffer.length);
    buffer.copyFromChannel(a, Math.min(c, buffer.numberOfChannels - 1));
    return a;
  });
  try {
    return await new Promise<Analysis>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
        if (e.data.type === 'done') resolve(e.data.result);
        else if (e.data.type === 'error') reject(new Error(e.data.message));
      };
      worker.onerror = (e) => reject(new Error(e.message));
      const job: AnalysisJob = {
        id: 1,
        channels,
        sampleRate: buffer.sampleRate,
        meta: { lossless: true, resampled: false, sourceRate: buffer.sampleRate, ...meta },
      };
      worker.postMessage(job);
    });
  } finally {
    worker.terminate();
  }
}

/** Beat timing error against a known grid, in milliseconds. */
export function beatError(beats: Float32Array, grid0: number, period: number, from: number, to: number) {
  const e: number[] = [];
  for (const b of beats) {
    if (b < from || b > to) continue;
    const k = Math.round((b - grid0) / period);
    e.push(Math.round((b - (grid0 + k * period)) * 1000));
  }
  e.sort((a, b) => a - b);
  return { n: e.length, median: e[e.length >> 1], worst: Math.max(0, ...e.map(Math.abs)) };
}

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export function summarise(a: Analysis) {
  return {
    bpm: a.bpm,
    key: `${NAMES[a.key.tonic]}${a.key.mode === 'minor' ? 'm' : ''} (${a.key.confidence.toFixed(2)})`,
    chords: a.chords.slice(0, 8).map((c) => `${c.t.toFixed(2)} ${NAMES[c.root]}${c.quality === 'min' ? 'm' : ''}`),
    sections: a.sections.map((s) => `${s.t.toFixed(1)}–${s.end.toFixed(1)} ${s.label} ${s.name}`),
    ms: a.elapsedMs,
  };
}

/** Runs the demo and three synthetic songs; prints tempo, beat error, chords and sections. */
export async function runSuite() {
  const out: Record<string, unknown> = {};
  const demo = await analyse((await renderDemo(48000)).buffer);
  out.demo = { ...summarise(demo), drums: beatError(demo.beats, 0.25, 0.5, 8.2, 40), intro: beatError(demo.beats, 0.25, 0.5, 0, 8.2) };
  const cases: [string, SynthSpec][] = [
    ['s96 D A Bm G', { bpm: 96, progression: [[2, ''], [9, ''], [11, 'm'], [7, '']], bars: 24 }],
    ['s140 Em C G D', { bpm: 140, progression: [[4, 'm'], [0, ''], [7, ''], [2, '']], bars: 32 }],
    ['s75 C F G C', { bpm: 75, progression: [[0, ''], [5, ''], [7, ''], [0, '']], bars: 16 }],
  ];
  for (const [name, spec] of cases) {
    const a = await analyse(await synth(spec));
    const p = 60 / spec.bpm;
    const introEnd = 0.1 + (spec.introBars ?? 2) * 4 * p;
    out[name] = { ...summarise(a), drums: beatError(a.beats, 0.1, p, introEnd, 1e9), intro: beatError(a.beats, 0.1, p, 0, introEnd) };
  }
  return out;
}
