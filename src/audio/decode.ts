export type DecoderKind = 'browser' | 'aiff' | 'synth' | 'live';

export interface Decoded {
  buffer: AudioBuffer;
  decoder: DecoderKind;
  /** Sample rate stored in the file. */
  sourceRate: number;
  /** True when decoding changed the sample rate. */
  resampled: boolean;
}

export class DecodeError extends Error {}

const AIFF_EXT = new Set(['aif', 'aiff', 'aifc']);

export async function decodeFile(
  file: File,
  ext: string,
  sourceRate: number | undefined,
  targetRate: number | 'native',
): Promise<Decoded> {
  if (AIFF_EXT.has(ext)) {
    const buffer = decodeAiff(await file.arrayBuffer());
    if (targetRate !== 'native' && targetRate !== buffer.sampleRate) {
      return { buffer: await resample(buffer, targetRate), decoder: 'aiff', sourceRate: buffer.sampleRate, resampled: true };
    }
    return { buffer, decoder: 'aiff', sourceRate: buffer.sampleRate, resampled: false };
  }

  // decodeAudioData always converts to the context's rate, so decoding on an
  // offline context at the file's own rate keeps the samples untouched.
  const rate = targetRate === 'native' ? (sourceRate ?? 48000) : targetRate;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: clampRate(rate) });
  const data = await file.arrayBuffer();
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(data);
  } catch {
    throw new DecodeError(
      `File ${ext.toUpperCase()} ini tidak bisa dibaca browser. Filenya mungkin rusak, atau isinya memakai format yang belum didukung.`,
    );
  }
  return {
    buffer,
    decoder: 'browser',
    sourceRate: sourceRate ?? buffer.sampleRate,
    resampled: sourceRate !== undefined && sourceRate !== buffer.sampleRate,
  };
}

const clampRate = (r: number) => Math.min(768000, Math.max(8000, Math.round(r)));

export async function resample(buffer: AudioBuffer, rate: number): Promise<AudioBuffer> {
  const length = Math.ceil((buffer.length * rate) / buffer.sampleRate);
  const ctx = new OfflineAudioContext({ numberOfChannels: buffer.numberOfChannels, length, sampleRate: rate });
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

/* ------------------------------------------------------------------ AIFF -- */

function readExtended(dv: DataView, o: number): number {
  const expon = dv.getUint16(o);
  const hi = dv.getUint32(o + 2);
  const lo = dv.getUint32(o + 6);
  const sign = expon & 0x8000 ? -1 : 1;
  const e = expon & 0x7fff;
  if (e === 0 && hi === 0 && lo === 0) return 0;
  return sign * (hi * 2 ** (e - 16383 - 31) + lo * 2 ** (e - 16383 - 63));
}

const fourcc = (dv: DataView, o: number) =>
  String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

/** Full-precision AIFF / AIFC decoder (PCM 8–32 bit, sowt, float). Chrome has none. */
export function decodeAiff(ab: ArrayBuffer): AudioBuffer {
  const dv = new DataView(ab);
  if (fourcc(dv, 0) !== 'FORM') throw new DecodeError('Bukan file AIFF yang valid.');
  const form = fourcc(dv, 8);
  if (form !== 'AIFF' && form !== 'AIFC') throw new DecodeError('Bukan file AIFF yang valid.');

  let channels = 0;
  let frames = 0;
  let bits = 0;
  let rate = 0;
  let compression = 'NONE';
  let dataStart = -1;

  let p = 12;
  while (p + 8 <= dv.byteLength) {
    const id = fourcc(dv, p);
    const size = dv.getUint32(p + 4);
    const body = p + 8;
    if (id === 'COMM') {
      channels = dv.getInt16(body);
      frames = dv.getUint32(body + 2);
      bits = dv.getInt16(body + 6);
      rate = readExtended(dv, body + 8);
      if (form === 'AIFC' && size >= 22) compression = fourcc(dv, body + 18);
    } else if (id === 'SSND') {
      dataStart = body + 8 + dv.getUint32(body);
    }
    p = body + size + (size & 1);
  }
  if (!channels || !rate || dataStart < 0) throw new DecodeError('File AIFF ini tidak lengkap atau rusak.');

  const comp = compression.toLowerCase();
  const isFloat = comp === 'fl32' || comp === 'fl64';
  const little = comp === 'sowt';
  if (!['none', 'sowt', 'fl32', 'fl64', 'in24', 'in32', 'twos'].includes(comp)) {
    throw new DecodeError(`Kompresi AIFC "${compression}" belum didukung.`);
  }
  const bytes = comp === 'fl64' ? 8 : comp === 'fl32' ? 4 : Math.ceil(bits / 8);
  const available = Math.floor((dv.byteLength - dataStart) / (bytes * channels));
  frames = Math.min(frames, available);

  const buffer = new AudioBuffer({ length: Math.max(1, frames), numberOfChannels: channels, sampleRate: rate });
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) out.push(buffer.getChannelData(c));

  let o = dataStart;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      let v: number;
      if (isFloat) {
        v = bytes === 8 ? dv.getFloat64(o) : dv.getFloat32(o);
      } else if (bytes === 1) {
        v = dv.getInt8(o) / 128;
      } else if (bytes === 2) {
        v = dv.getInt16(o, little) / 32768;
      } else if (bytes === 3) {
        const b0 = dv.getUint8(o);
        const b1 = dv.getUint8(o + 1);
        const b2 = dv.getUint8(o + 2);
        let x = little ? (b2 << 16) | (b1 << 8) | b0 : (b0 << 16) | (b1 << 8) | b2;
        if (x & 0x800000) x -= 0x1000000;
        v = x / 8388608;
      } else {
        v = dv.getInt32(o, little) / 2147483648;
      }
      out[c][f] = v;
      o += bytes;
    }
  }
  return buffer;
}

/* ------------------------------------------------------------- Demo synth -- */

/**
 * Renders a 40-second groove (intro, verse, chorus) so the app can be tried
 * without a music library. Every element sits in its own frequency region so
 * each meter and visual has something distinct to react to.
 */
export async function renderDemo(rate = 48000): Promise<Decoded> {
  const bpm = 120;
  const beat = 60 / bpm;
  const bar = beat * 4;
  const bars = 20;
  const length = Math.ceil((bars * bar + 2.5) * rate);
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate: rate });

  const master = ctx.createGain();
  master.gain.value = 0.82;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 3;
  comp.attack.value = 0.01;
  comp.release.value = 0.2;
  master.connect(comp).connect(ctx.destination);

  const noise = ctx.createBuffer(1, rate, rate);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  const delay = ctx.createDelay(1);
  delay.delayTime.value = beat * 0.75;
  const fb = ctx.createGain();
  fb.gain.value = 0.32;
  const delayOut = ctx.createGain();
  delayOut.gain.value = 0.35;
  delay.connect(fb).connect(delay);
  delay.connect(delayOut).connect(master);

  const chords = [
    { root: 110.0, notes: [220.0, 261.63, 329.63] },
    { root: 87.31, notes: [174.61, 220.0, 261.63] },
    { root: 130.81, notes: [261.63, 329.63, 392.0] },
    { root: 98.0, notes: [196.0, 246.94, 293.66] },
  ];

  const env = (g: GainNode, t: number, a: number, peak: number, d: number) => {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  };

  const kick = (t: number, amp: number) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(155, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    env(g, t, 0.002, amp, 0.42);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.5);
  };

  const snare = (t: number, amp: number) => {
    const n = ctx.createBufferSource();
    n.buffer = noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1900;
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    env(g, t, 0.002, amp, 0.2);
    n.connect(bp).connect(g).connect(master);
    n.start(t, Math.random() * 0.5);
    n.stop(t + 0.25);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(200, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.08);
    const g2 = ctx.createGain();
    env(g2, t, 0.002, amp * 0.6, 0.1);
    o.connect(g2).connect(master);
    o.start(t);
    o.stop(t + 0.15);
  };

  const hat = (t: number, amp: number, open: boolean, pan: number) => {
    const n = ctx.createBufferSource();
    n.buffer = noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7500;
    const g = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    env(g, t, 0.001, amp, open ? 0.22 : 0.045);
    n.connect(hp).connect(g).connect(p).connect(master);
    n.start(t, Math.random() * 0.5);
    n.stop(t + 0.3);
  };

  const bass = (t: number, f: number, dur: number, bright: number) => {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 5;
    lp.frequency.setValueAtTime(300 + bright, t);
    lp.frequency.exponentialRampToValueAtTime(140, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32, t + 0.008);
    g.gain.setValueAtTime(0.32, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(lp).connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  };

  const pad = (t: number, notes: number[], dur: number, cutoff: number, amp: number) => {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    lp.Q.value = 0.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp, t + 0.45);
    g.gain.setValueAtTime(amp, t + dur - 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.6);
    lp.connect(g).connect(master);
    notes.forEach((f) => {
      [-1, 1].forEach((side) => {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = side * 9;
        const p = ctx.createStereoPanner();
        p.pan.value = side * 0.75;
        o.connect(p).connect(lp);
        o.start(t);
        o.stop(t + dur + 0.7);
      });
    });
  };

  const pluck = (t: number, f: number, amp: number, pan: number) => {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(5200, t);
    lp.frequency.exponentialRampToValueAtTime(900, t + 0.18);
    const g = ctx.createGain();
    env(g, t, 0.003, amp, 0.2);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    o.connect(lp).connect(g).connect(p);
    p.connect(master);
    p.connect(delay);
    o.start(t);
    o.stop(t + 0.25);
  };

  const scheduleBar = (b: number) => {
    const t0 = 0.25 + b * bar;
    const ch = chords[b % 4];
    const chorus = b >= 12;
    const verse = b >= 4;
    pad(t0, ch.notes, bar, chorus ? 3200 : verse ? 1500 : 900, chorus ? 0.05 : 0.04);
    for (let i = 0; i < 8; i++) {
      const t = t0 + i * beat * 0.5;
      const off = i % 2 === 1;
      if (verse || b >= 2) hat(t, off ? 0.14 : 0.07, chorus && off && i % 4 === 3, 0.35);
      if (verse) bass(t, off && chorus ? ch.root * 2 : ch.root, beat * 0.45, chorus ? 900 : 450);
    }
    if (verse) for (let i = 0; i < 4; i++) kick(t0 + i * beat, 0.95);
    if (verse) {
      snare(t0 + beat, chorus ? 0.5 : 0.32);
      snare(t0 + beat * 3, chorus ? 0.5 : 0.32);
    }
    if (chorus) {
      const arp = [...ch.notes, ch.notes[1] * 2, ...ch.notes.map((n) => n * 2), ch.notes[2] * 2, ch.notes[0] * 4];
      for (let i = 0; i < 16; i++) {
        pluck(t0 + i * beat * 0.25, arp[i % arp.length] * 2, 0.05, i % 2 ? -0.45 : 0.45);
      }
    }
  };

  // Build each bar just before it plays. Creating every voice up front makes
  // the renderer process thousands of idle nodes and takes seconds.
  scheduleBar(0);
  for (let b = 1; b < bars; b++) {
    const at = 0.25 + b * bar - 0.3;
    void ctx.suspend(at).then(() => {
      scheduleBar(b);
      return ctx.resume();
    });
  }
  const end = 0.25 + bars * bar;
  master.gain.setValueAtTime(0.82, end - bar);
  master.gain.linearRampToValueAtTime(0, end + 1.5);

  const buffer = await ctx.startRendering();

  // Normalise to −1.5 dBFS sample peak so the demo never clips.
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak > 0) {
    const k = Math.pow(10, -1.5 / 20) / peak;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= k;
    }
  }
  return { buffer, decoder: 'synth', sourceRate: rate, resampled: false };
}
