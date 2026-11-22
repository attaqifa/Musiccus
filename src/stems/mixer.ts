import { dbToGain } from '../lib/format';
import { STEMS, STORED, type StemId } from './types';

export interface StripState {
  gainDb: number;
  mute: boolean;
  solo: boolean;
  /** -1 (left) .. 1 (right), used when the 3D stage is off. */
  pan: number;
}

/** Position on the 3D stage in metres. The listener sits at 0,0 facing -z; +x is right. */
export interface StagePos {
  x: number;
  z: number;
  /** Spread between the stem's left and right channel, metres. */
  width: number;
}

export interface StemMix {
  strips: Record<StemId, StripState>;
  stage: boolean;
  positions: Record<StemId, StagePos>;
}

export const DEFAULT_POSITIONS: Record<StemId, StagePos> = {
  vocals: { x: 0, z: -1.4, width: 0.3 },
  drums: { x: 0, z: -3, width: 1.4 },
  bass: { x: -1.7, z: -2.3, width: 0.5 },
  other: { x: 1.7, z: -2.3, width: 1.6 },
};

const strip = (): StripState => ({ gainDb: 0, mute: false, solo: false, pan: 0 });

export const DEFAULT_MIX: StemMix = {
  strips: { vocals: strip(), drums: strip(), bass: strip(), other: strip() },
  stage: false,
  positions: DEFAULT_POSITIONS,
};

/** Linear gain of one stem after mute and solo. */
export function stemGain(mix: StemMix, id: StemId): number {
  const s = mix.strips[id];
  const anySolo = STEMS.some((k) => mix.strips[k].solo);
  if (s.mute || (anySolo && !s.solo)) return 0;
  return dbToGain(s.gainDb);
}

/** True when the stems would recombine into exactly the original. */
export const mixNeutral = (mix: StemMix) =>
  !mix.stage && STEMS.every((id) => stemGain(mix, id) === 1 && mix.strips[id].pan === 0);

interface Strip {
  input: GainNode;
  vol: GainNode;
  panGate: GainNode;
  panner: StereoPannerNode;
  stageGate: GainNode;
  hrtf: [PannerNode, PannerNode];
}

const RAMP = 0.025;

/**
 * Recombines a track from its stems:
 *
 *   mix ────────────────────────────── direct ──┐
 *   mix ─┬─ minus vocals, drums, bass = other ──┤
 *   vocals, drums, bass ─ vol ─ pan | HRTF ─ wet ┴─→ output
 *
 * "Other" is the remainder, so at unity the stems add up to the original;
 * while nothing is changed the direct path plays alone and stays
 * bit-transparent.
 */
export class StemMixer {
  readonly input: GainNode;
  readonly stemIn: Record<(typeof STORED)[number], GainNode>;
  readonly output: GainNode;
  private ctx: BaseAudioContext;
  private direct: GainNode;
  private wet: GainNode;
  private strips: Record<StemId, Strip>;
  private mix: StemMix = DEFAULT_MIX;
  private wetOn = false;
  private stageOn = false;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    const stereo = (gain = 1) => {
      const g = ctx.createGain();
      g.gain.value = gain;
      g.channelCount = 2;
      g.channelCountMode = 'explicit';
      g.channelInterpretation = 'speakers';
      return g;
    };
    this.input = stereo();
    this.output = stereo();
    this.direct = stereo(1);
    this.wet = stereo(0);
    this.input.connect(this.direct).connect(this.output);
    this.wet.connect(this.output);

    const otherSum = stereo();
    this.input.connect(otherSum);
    this.stemIn = { vocals: stereo(), drums: stereo(), bass: stereo() };
    for (const id of STORED) this.stemIn[id].connect(stereo(-1)).connect(otherSum);

    const makeStrip = (input: GainNode): Strip => {
      const vol = stereo();
      const panGate = stereo(1);
      const panner = ctx.createStereoPanner();
      const stageGate = stereo(0);
      input.connect(vol);
      vol.connect(panGate).connect(panner).connect(this.wet);
      const split = ctx.createChannelSplitter(2);
      vol.connect(stageGate).connect(split);
      const hrtf = [0, 1].map((ch) => {
        const p = ctx.createPanner();
        p.panningModel = 'HRTF';
        p.distanceModel = 'inverse';
        p.refDistance = 1.4;
        p.rolloffFactor = 0.7;
        p.maxDistance = 30;
        split.connect(p, ch);
        p.connect(this.wet);
        return p;
      }) as [PannerNode, PannerNode];
      return { input, vol, panGate, panner, stageGate, hrtf };
    };
    this.strips = {
      vocals: makeStrip(this.stemIn.vocals),
      drums: makeStrip(this.stemIn.drums),
      bass: makeStrip(this.stemIn.bass),
      other: makeStrip(otherSum),
    };
    for (const id of STEMS) this.place(id, 0, true);
  }

  get processing(): boolean {
    return this.wetOn;
  }

  /** Applies mixer settings. `hasStems`: the playing track has separated stems. */
  apply(mix: StemMix, hasStems: boolean, immediate = false): void {
    this.mix = mix;
    const now = this.ctx.currentTime;
    for (const id of STEMS) {
      const s = this.strips[id];
      const g = stemGain(mix, id);
      s.vol.gain.setTargetAtTime(g, now, immediate ? 0.001 : 0.012);
      s.panner.pan.setTargetAtTime(mix.strips[id].pan, now, 0.02);
      this.place(id, now, immediate);
    }
    if (mix.stage !== this.stageOn) {
      this.stageOn = mix.stage;
      for (const id of STEMS) {
        const s = this.strips[id];
        this.ramp(s.panGate.gain, mix.stage ? 0 : 1, now);
        this.ramp(s.stageGate.gain, mix.stage ? 1 : 0, now);
      }
    }
    this.setWet(hasStems && !mixNeutral(mix), now);
  }

  /** At a gapless boundary into a track without stems, fall back to the direct path exactly there. */
  directAt(when: number): void {
    if (!this.wetOn) return;
    this.wetOn = false;
    this.direct.gain.setValueAtTime(1, when);
    this.wet.gain.setValueAtTime(0, when);
  }

  /** Drops a pending `directAt` switch (the queued track was cancelled). */
  cancelScheduled(): void {
    const now = this.ctx.currentTime;
    for (const p of [this.direct.gain, this.wet.gain]) {
      const v = p.value;
      p.cancelScheduledValues(now);
      p.setValueAtTime(v, now);
    }
    this.wetOn = this.wet.gain.value > 0.5;
  }

  private setWet(on: boolean, now: number) {
    if (on === this.wetOn) return;
    this.wetOn = on;
    this.ramp(this.direct.gain, on ? 0 : 1, now);
    this.ramp(this.wet.gain, on ? 1 : 0, now);
  }

  /** Linear ramps land exactly on 0 and 1, which keeps the direct path bit-exact. */
  private ramp(p: AudioParam, to: number, now: number) {
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.linearRampToValueAtTime(to, now + RAMP);
  }

  private place(id: StemId, now: number, immediate: boolean) {
    const pos = this.mix.positions[id];
    const x = pos.x;
    const z = pos.z;
    const d = Math.hypot(x, z) || 1;
    // Spread the stem's two channels across the line of sight.
    const px = -z / d;
    const pz = x / d;
    const half = pos.width / 2;
    const [l, r] = this.strips[id].hrtf;
    const set = (p: AudioParam, v: number) => (immediate ? (p.value = v) : p.setTargetAtTime(v, now, 0.04));
    set(l.positionX, x - px * half);
    set(l.positionZ, z - pz * half);
    set(r.positionX, x + px * half);
    set(r.positionZ, z + pz * half);
  }

  dispose(): void {
    this.input.disconnect();
    this.output.disconnect();
  }
}
