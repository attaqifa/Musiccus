import SignalsmithStretch, { type StretchNode } from 'signalsmith-stretch';
import { makeImpulse } from './ir';
import {
  DIVISION_BEATS,
  moduleActive,
  pitchShift,
  studioProcessing,
  type Character,
  type HpFilter,
  type StudioState,
} from './types';

const dB = (v: number) => Math.pow(10, v / 20);
const FADE = 0.008;

interface Tap {
  input: AudioNode;
  analyser: AnalyserNode;
}

/** An analyser behind the two K-weighting stages of ITU-R BS.1770, approximated with biquads. */
function kWeightedTap(ctx: BaseAudioContext): Tap {
  const shelf = ctx.createBiquadFilter();
  shelf.type = 'highshelf';
  shelf.frequency.value = 1500;
  shelf.gain.value = 4;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 60;
  hp.Q.value = 0.5;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  shelf.connect(hp).connect(analyser);
  return { input: shelf, analyser };
}

/** A crossfaded insert: `in → dry → out` and `in → effect → wet → out`. */
class Insert {
  readonly in: GainNode;
  readonly out: GainNode;
  readonly dry: GainNode;
  readonly wet: GainNode;
  on = false;
  constructor(ctx: BaseAudioContext) {
    this.in = stereoGain(ctx);
    this.out = stereoGain(ctx);
    this.dry = stereoGain(ctx);
    this.wet = stereoGain(ctx, 0);
    this.in.connect(this.dry).connect(this.out);
    this.wet.connect(this.out);
  }
  set(on: boolean, t: number, immediate: boolean) {
    this.on = on;
    ramp(this.dry.gain, on ? 0 : 1, t, immediate);
    ramp(this.wet.gain, on ? 1 : 0, t, immediate);
  }
}

function stereoGain(ctx: BaseAudioContext, value = 1): GainNode {
  const g = ctx.createGain();
  g.channelCount = 2;
  g.channelCountMode = 'explicit';
  g.channelInterpretation = 'speakers';
  g.gain.value = value;
  return g;
}

function ramp(p: AudioParam, v: number, t: number, immediate: boolean) {
  if (immediate) {
    p.cancelScheduledValues(0);
    p.value = v;
  } else {
    p.setTargetAtTime(v, t, FADE);
  }
}

function driveCurve(character: Character, amount: number): { curve: Float32Array<ArrayBuffer>; makeup: number } {
  const n = 4096;
  const curve = new Float32Array(n);
  const k = 1 + amount * 9;
  if (character === 'tube') {
    // Asymmetric tanh: the bias adds the even harmonics typical of a triode.
    const bias = 0.18 * amount;
    const lo = Math.tanh(-k + bias) - Math.tanh(bias);
    const hi = Math.tanh(k + bias) - Math.tanh(bias);
    const norm = Math.max(Math.abs(lo), Math.abs(hi));
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = (Math.tanh(k * x + bias) - Math.tanh(bias)) / norm;
    }
    const slope = (k * (1 - Math.tanh(bias) ** 2)) / norm;
    return { curve, makeup: 1 / Math.pow(slope, 0.85) };
  }
  // Tape: symmetric arctan with a soft knee, odd harmonics, gentle compression.
  const norm = Math.atan(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.atan(k * x) / norm;
  }
  return { curve, makeup: 1 / Math.pow(k / norm, 0.85) };
}

/**
 * The studio rack as a Web Audio graph. It runs identically on the live
 * context and on an OfflineAudioContext for export.
 *
 *   input ─┬─ dryAll ──────────────────────────────┬─ mix → limiter → headphone → output
 *          └─ pitch → filter → EQ → comp → drive → stereo → delay
 *             → space → gain ─ wetAll ─────────────┘
 *
 * With nothing active only the dry path carries signal (gain exactly 1), so
 * the chain stays bit-transparent. The headphone correction sits after the
 * mix: it belongs to the listener's ears, so it stays on while the original
 * is compared with the processed sound.
 */
export class StudioGraph {
  readonly input: GainNode;
  readonly output: GainNode;
  private ctx: BaseAudioContext;
  private dryAll: GainNode;
  private wetAll: GainNode;
  private mix: GainNode;
  /** K-weighted taps before and after the rack, for level-matched comparison. */
  private probe: { pre: Tap; post: Tap; buf: Float32Array<ArrayBuffer> };
  /** A flat analyser on the rack's input, so the meters can show the original next to the result. */
  readonly preSpectrum: AnalyserNode;

  private pitch: Insert;
  private stretch: StretchNode | null = null;
  private stretchLoading: Promise<void> | null = null;
  private stretchKey = '';
  latency = 0;

  private filter: Insert;
  private lp: BiquadFilterNode;
  private hp: BiquadFilterNode;

  private eq: Insert;
  private eqNodes: BiquadFilterNode[] = [];

  private comp: Insert;
  readonly compressor: DynamicsCompressorNode;
  private makeup: GainNode;

  private driveIn: GainNode;
  private driveOut: GainNode;
  private driveDry: GainNode;
  private driveWet: GainNode;
  private shaper: WaveShaperNode;
  private drivePost: GainNode;
  private driveTone: BiquadFilterNode;
  private driveKey = '';

  private stereo: Insert;
  private mx: { ll: GainNode; rl: GainNode; rr: GainNode; lr: GainNode };

  private delayIn: GainNode;
  private delayOut: GainNode;
  private delaySend: GainNode;
  private dl: DelayNode;
  private dr: DelayNode;
  private fbL: GainNode;
  private fbR: GainNode;
  private toneL: BiquadFilterNode;
  private toneR: BiquadFilterNode;

  private spaceIn: GainNode;
  private spaceOut: GainNode;
  private spaceSend: GainNode;
  /** Send levels set by the rack, and whether each module is on. */
  private sends = { space: 0, delay: 0, spaceOn: false, delayOn: false };
  private convolver: ConvolverNode;
  private irKey = '';
  private irTimer = 0;

  private headphone: Insert;
  private hpChainIn: GainNode;
  private hpPreamp: GainNode;
  private hpFilters: BiquadFilterNode[] = [];
  private hpKey = '';
  private xf: { direct: GainNode[]; cross: GainNode[] };

  private outGain: GainNode;
  private limiter: Insert;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = stereoGain(ctx);
    this.output = stereoGain(ctx);
    this.dryAll = stereoGain(ctx);
    this.wetAll = stereoGain(ctx, 0);
    this.mix = stereoGain(ctx);
    this.input.connect(this.dryAll).connect(this.mix);
    this.wetAll.connect(this.mix);
    this.probe = { pre: kWeightedTap(ctx), post: kWeightedTap(ctx), buf: new Float32Array(2048) };
    this.preSpectrum = ctx.createAnalyser();
    this.preSpectrum.fftSize = 8192;
    this.preSpectrum.smoothingTimeConstant = 0;

    // Pitch (the stretcher is created lazily; it is the heaviest node).
    this.pitch = new Insert(ctx);

    // Filter: a low-pass and a high-pass in series, one of them parked.
    this.filter = new Insert(ctx);
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 22000;
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 10;
    this.filter.in.connect(this.lp).connect(this.hp).connect(this.filter.wet);

    // EQ: eight bands in series.
    this.eq = new Insert(ctx);
    let prev: AudioNode = this.eq.in;
    for (let i = 0; i < 8; i++) {
      const b = ctx.createBiquadFilter();
      prev.connect(b);
      prev = b;
      this.eqNodes.push(b);
    }
    prev.connect(this.eq.wet);

    // Compressor with make-up gain.
    this.comp = new Insert(ctx);
    this.compressor = ctx.createDynamicsCompressor();
    this.makeup = stereoGain(ctx);
    this.comp.in.connect(this.compressor).connect(this.makeup).connect(this.comp.wet);

    // Drive: parallel dry/wet so "mix" blends saturation in.
    this.driveIn = stereoGain(ctx);
    this.driveOut = stereoGain(ctx);
    this.driveDry = stereoGain(ctx);
    this.driveWet = stereoGain(ctx, 0);
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '4x';
    this.drivePost = stereoGain(ctx);
    this.driveTone = ctx.createBiquadFilter();
    this.driveTone.type = 'lowpass';
    this.driveIn.connect(this.driveDry).connect(this.driveOut);
    this.driveIn.connect(this.shaper).connect(this.driveTone).connect(this.drivePost).connect(this.driveWet).connect(this.driveOut);

    // Stereo matrix: L' = a·L + b·R, R' = a·R + b·L, then balance.
    this.stereo = new Insert(ctx);
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    this.mx = { ll: ctx.createGain(), rl: ctx.createGain(), rr: ctx.createGain(), lr: ctx.createGain() };
    this.stereo.in.connect(split);
    split.connect(this.mx.ll, 0).connect(merge, 0, 0);
    split.connect(this.mx.rl, 1).connect(merge, 0, 0);
    split.connect(this.mx.rr, 1).connect(merge, 0, 1);
    split.connect(this.mx.lr, 0).connect(merge, 0, 1);
    merge.connect(this.stereo.wet);

    // Ping-pong delay as a send.
    this.delayIn = stereoGain(ctx);
    this.delayOut = stereoGain(ctx);
    this.delaySend = stereoGain(ctx, 0);
    const mono = ctx.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = 'explicit';
    mono.channelInterpretation = 'speakers';
    this.dl = ctx.createDelay(4);
    this.dr = ctx.createDelay(4);
    this.fbL = ctx.createGain();
    this.fbR = ctx.createGain();
    this.toneL = ctx.createBiquadFilter();
    this.toneR = ctx.createBiquadFilter();
    this.toneL.type = this.toneR.type = 'lowpass';
    const dMerge = ctx.createChannelMerger(2);
    this.delayIn.connect(this.delayOut);
    this.delayIn.connect(mono).connect(this.dl);
    this.dl.connect(this.toneL).connect(this.fbL).connect(this.dr);
    this.dr.connect(this.toneR).connect(this.fbR).connect(this.dl);
    this.dl.connect(dMerge, 0, 0);
    this.dr.connect(dMerge, 0, 1);
    dMerge.connect(this.delaySend).connect(this.delayOut);

    // Convolution reverb as a send.
    this.spaceIn = stereoGain(ctx);
    this.spaceOut = stereoGain(ctx);
    this.spaceSend = stereoGain(ctx, 0);
    this.convolver = ctx.createConvolver();
    this.convolver.normalize = false;
    this.spaceIn.connect(this.spaceOut);
    this.spaceIn.connect(this.convolver).connect(this.spaceSend).connect(this.spaceOut);

    // Headphone: AutoEQ filters, preamp, crossfeed.
    this.headphone = new Insert(ctx);
    this.hpChainIn = stereoGain(ctx);
    this.hpPreamp = stereoGain(ctx);
    this.headphone.in.connect(this.hpChainIn);
    this.hpChainIn.connect(this.hpPreamp);
    const xSplit = ctx.createChannelSplitter(2);
    const xMerge = ctx.createChannelMerger(2);
    this.xf = { direct: [ctx.createGain(), ctx.createGain()], cross: [ctx.createGain(), ctx.createGain()] };
    this.hpPreamp.connect(xSplit);
    for (const c of [0, 1]) {
      xSplit.connect(this.xf.direct[c], c).connect(xMerge, 0, c);
      // The far ear hears the other speaker later and duller (BS2B-style).
      const lpf = ctx.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.frequency.value = 700;
      lpf.Q.value = -3;
      const d = ctx.createDelay(0.01);
      d.delayTime.value = 0.00028;
      xSplit.connect(lpf, c).connect(d).connect(this.xf.cross[c]).connect(xMerge, 0, 1 - c);
    }
    xMerge.connect(this.headphone.wet);

    // Output gain and safety limiter.
    this.outGain = stereoGain(ctx);
    this.limiter = new Insert(ctx);
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -1;
    lim.knee.value = 0;
    lim.ratio.value = 20;
    lim.attack.value = 0.002;
    lim.release.value = 0.1;
    this.limiter.in.connect(lim).connect(this.limiter.wet);

    // Wire the chain.
    this.input.connect(this.pitch.in);
    this.pitch.out.connect(this.filter.in);
    this.filter.out.connect(this.eq.in);
    this.eq.out.connect(this.comp.in);
    this.comp.out.connect(this.driveIn);
    this.driveOut.connect(this.stereo.in);
    this.stereo.out.connect(this.delayIn);
    this.delayOut.connect(this.spaceIn);
    this.spaceOut.connect(this.outGain).connect(this.wetAll);
    this.mix.connect(this.limiter.in);
    this.limiter.out.connect(this.headphone.in);
    this.headphone.out.connect(this.output);
    this.input.connect(this.probe.pre.input);
    this.outGain.connect(this.probe.post.input);
    this.input.connect(this.preSpectrum);
  }

  /** Gain reduction of the compressor right now, in dB (≤ 0). */
  get reduction(): number {
    return this.comp.on ? this.compressor.reduction : 0;
  }

  /**
   * Applies a full studio state. Cheap enough to call on every knob move:
   * only curves, impulses and filter lists are rebuilt when they change.
   */
  apply(
    s: StudioState,
    opts: { bpm?: number; immediate?: boolean; bypass?: boolean; matchDb?: number } = {},
  ): Promise<void> {
    const t = this.ctx.currentTime;
    const im = !!opts.immediate;
    const processing = studioProcessing(s) && !opts.bypass;
    // While comparing, the original plays as loud as the processed sound did,
    // so "louder" is never mistaken for "better".
    const match = opts.bypass ? Math.max(-12, Math.min(12, opts.matchDb ?? 0)) : 0;
    ramp(this.wetAll.gain, processing ? 1 : 0, t, im);
    ramp(this.dryAll.gain, processing ? 0 : dB(match), t, im);

    // Filter: negative sweeps close a low-pass, positive ones open a high-pass.
    const f = s.filter;
    this.filter.set(moduleActive(s, 'filter'), t, im);
    const res = 0.7 + f.resonance * 14;
    ramp(this.lp.frequency, f.sweep < 0 ? 20000 * Math.pow(180 / 20000, -f.sweep) : 22000, t, im);
    ramp(this.hp.frequency, f.sweep > 0 ? 20 * Math.pow(6000 / 20, f.sweep) : 10, t, im);
    ramp(this.lp.Q, f.sweep < 0 ? res : 0.7, t, im);
    ramp(this.hp.Q, f.sweep > 0 ? res : 0.7, t, im);

    this.eq.set(moduleActive(s, 'eq'), t, im);
    s.eq.bands.forEach((b, i) => {
      const node = this.eqNodes[i];
      if (!node) return;
      if (node.type !== b.type) node.type = b.type;
      ramp(node.frequency, b.freq, t, im);
      ramp(node.gain, b.on ? b.gain : 0, t, im);
      ramp(node.Q, b.type === 'highpass' || b.type === 'lowpass' ? 0 : b.q, t, im);
    });

    const c = s.comp;
    this.comp.set(c.on, t, im);
    ramp(this.compressor.threshold, c.threshold, t, im);
    ramp(this.compressor.ratio, c.ratio, t, im);
    ramp(this.compressor.knee, c.knee, t, im);
    ramp(this.compressor.attack, c.attack, t, im);
    ramp(this.compressor.release, c.release, t, im);
    ramp(this.makeup.gain, dB(c.makeup), t, im);

    const d = s.drive;
    const driveKey = `${d.character}:${d.amount.toFixed(3)}`;
    if (driveKey !== this.driveKey) {
      this.driveKey = driveKey;
      const { curve, makeup } = driveCurve(d.character, d.amount);
      this.shaper.curve = curve;
      ramp(this.drivePost.gain, makeup, t, im);
    }
    ramp(this.driveTone.frequency, 2500 * Math.pow(20000 / 2500, d.tone), t, im);
    ramp(this.driveDry.gain, d.on ? 1 - d.mix : 1, t, im);
    ramp(this.driveWet.gain, d.on ? d.mix : 0, t, im);

    const st = s.stereo;
    this.stereo.set(st.on, t, im);
    const w = st.mono ? 0 : st.width;
    const a = (1 + w) / 2;
    const b = (1 - w) / 2;
    const gl = st.balance > 0 ? 1 - st.balance : 1;
    const gr = st.balance < 0 ? 1 + st.balance : 1;
    ramp(this.mx.ll.gain, a * gl, t, im);
    ramp(this.mx.rl.gain, b * gl, t, im);
    ramp(this.mx.rr.gain, a * gr, t, im);
    ramp(this.mx.lr.gain, b * gr, t, im);

    const dl = s.delay;
    const time =
      dl.sync && opts.bpm ? Math.min(3.9, (60 / opts.bpm) * DIVISION_BEATS[dl.division]) : Math.min(3.9, dl.timeMs / 1000);
    ramp(this.dl.delayTime, time, t, im);
    ramp(this.dr.delayTime, time, t, im);
    ramp(this.fbL.gain, dl.feedback, t, im);
    ramp(this.fbR.gain, dl.feedback, t, im);
    const toneHz = 1200 * Math.pow(16000 / 1200, dl.tone);
    ramp(this.toneL.frequency, toneHz, t, im);
    ramp(this.toneR.frequency, toneHz, t, im);
    ramp(this.delaySend.gain, dl.on ? dl.mix : 0, t, im);
    this.sends.delay = dl.on ? dl.mix : 0;
    this.sends.delayOn = dl.on;

    const sp = s.space;
    const irKey = `${sp.room}:${sp.decay.toFixed(2)}:${sp.predelay.toFixed(3)}:${sp.damping.toFixed(2)}`;
    if (sp.on && irKey !== this.irKey) {
      this.irKey = irKey;
      const build = () => {
        this.convolver.buffer = makeImpulse(this.ctx, sp.room, sp.decay, sp.predelay, sp.damping);
      };
      if (im || !this.convolver.buffer) build();
      else {
        clearTimeout(this.irTimer);
        this.irTimer = window.setTimeout(build, 120);
      }
    }
    ramp(this.spaceSend.gain, sp.on ? sp.mix : 0, t, im);
    this.sends.space = sp.on ? sp.mix : 0;
    this.sends.spaceOn = sp.on;

    const hp = s.headphone;
    this.headphone.set(moduleActive(s, 'headphone'), t, im);
    const hpKey = JSON.stringify(hp.filters);
    if (hpKey !== this.hpKey) {
      this.hpKey = hpKey;
      this.rebuildHeadphone(hp.filters);
    }
    ramp(this.hpPreamp.gain, dB(hp.preamp), t, im);
    const cross = hp.crossfeed * 0.32;
    for (const c2 of [0, 1]) {
      ramp(this.xf.direct[c2].gain, 1 / (1 + cross), t, im);
      ramp(this.xf.cross[c2].gain, cross / (1 + cross), t, im);
    }

    ramp(this.outGain.gain, dB(s.output.gain), t, im);
    // A raised original could clip, so the limiter catches it too.
    this.limiter.set((s.output.limiter && processing) || match > 0.25, t, im);

    return this.applyPitch(s, im);
  }

  /** Mean-square level before and after the rack over the last ~40 ms, K-weighted. */
  loudness(): { pre: number; post: number } {
    const ms = (tap: Tap) => {
      const buf = this.probe.buf;
      tap.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      return sum / buf.length;
    };
    return { pre: ms(this.probe.pre), post: ms(this.probe.post) };
  }

  private rebuildHeadphone(filters: HpFilter[]) {
    this.hpChainIn.disconnect();
    for (const f of this.hpFilters) f.disconnect();
    this.hpFilters = filters.map((spec) => {
      const n = this.ctx.createBiquadFilter();
      n.type = spec.type;
      n.frequency.value = spec.freq;
      n.gain.value = spec.gain;
      n.Q.value = spec.q;
      return n;
    });
    let prev: AudioNode = this.hpChainIn;
    for (const n of this.hpFilters) {
      prev.connect(n);
      prev = n;
    }
    prev.connect(this.hpPreamp);
  }

  private async applyPitch(s: StudioState, immediate: boolean): Promise<void> {
    const on = moduleActive(s, 'pitch') && Math.abs(pitchShift(s.pitch)) > 1e-3;
    const key = on ? `${pitchShift(s.pitch).toFixed(4)}:${s.pitch.formant}` : 'off';
    if (key === this.stretchKey) return;
    this.stretchKey = key;
    const t = this.ctx.currentTime;
    if (!on) {
      this.pitch.set(false, t, immediate);
      this.latency = 0;
      // Park the stretcher once the fade is done; it is the costliest node.
      const node = this.stretch;
      if (node) window.setTimeout(() => this.stretchKey === 'off' && void node.stop(), 80);
      return;
    }
    if (!this.stretch) {
      if (!this.stretchLoading) {
        this.stretchLoading = (async () => {
          const node = await SignalsmithStretch(this.ctx, {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
          });
          this.pitch.in.connect(node).connect(this.pitch.wet);
          await node.start();
          this.stretch = node;
          this.latency = await node.latency();
        })();
      }
      await this.stretchLoading;
    }
    const node = this.stretch!;
    await node.start();
    this.latency = await node.latency();
    await node.schedule({ semitones: pitchShift(s.pitch), formantCompensation: s.pitch.formant });
    this.pitch.set(true, this.ctx.currentTime, immediate);
  }

  /** Waits until any lazily created node (the stretcher) is ready. */
  async ready(): Promise<void> {
    if (this.stretchLoading) await this.stretchLoading;
  }

  dispose() {
    clearTimeout(this.irTimer);
    this.input.disconnect();
    this.output.disconnect();
    this.stretch?.disconnect();
  }
}
