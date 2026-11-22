import { Emitter } from '../lib/emitter';
import { dbToGain } from '../lib/format';
import { DEFAULT_MIX, mixNeutral, StemMixer, type StemMix } from '../stems/mixer';
import { STORED } from '../stems/types';
import { StudioGraph } from '../studio/graph';
import { playbackRate, studioProcessing, type StudioState } from '../studio/types';

export interface StudioOptions {
  bpm?: number;
  /** Play the original (the headphone correction stays on). */
  bypass?: boolean;
  /** Gain for the original while comparing, so both sides are equally loud. */
  matchDb?: number;
}

export interface MeterMsg {
  t: number;
  msL: number;
  msR: number;
  pkL: number;
  pkR: number;
  tpL: number;
  tpR: number;
  corr: number;
  m: number;
  s: number;
  i: number;
  mMax: number;
  sMax: number;
  tpMax: number;
}

/** A transient found by the meter worklet; `t` is exact context time. */
export interface OnsetMsg {
  band: 0 | 1 | 2;
  t: number;
  s: number;
}

/** A block of the dry captured stream; `t` is the context time of its first sample. */
export interface CaptureMsg {
  t: number;
  l: Float32Array;
  r: Float32Array;
}

export interface Position {
  id: string;
  time: number;
  /** Infinity for a live stream. */
  duration: number;
  /** A captured stream: no seeking, and `time` counts only the sound heard so far. */
  live?: boolean;
}

export interface Taps {
  analyser: AnalyserNode;
  left: AnalyserNode;
  right: AnalyserNode;
}

type EngineEvents = {
  /** A gapless transition reached the listener's ears. */
  advance: { id: string };
  /** The current track finished and nothing was queued behind it. */
  ended: { id: string };
  meter: MeterMsg;
  onset: OnsetMsg;
  graph: { sampleRate: number };
  capture: CaptureMsg;
};

/** Separated stems of one track at the track's own rate; "other" is derived. */
export type StemBuffers = Record<(typeof STORED)[number], AudioBuffer>;

interface Slot {
  id: string;
  buffer: AudioBuffer;
  src: AudioBufferSourceNode;
  /** Stem sources started on the same sample as `src`. */
  stemSrcs: AudioBufferSourceNode[];
  stemsRef: StemBuffers | null;
  /** Context time at which `offset` plays. */
  startAt: number;
  offset: number;
  rgDb: number;
  ended: boolean;
}

/** A captured stream (a browser tab) playing instead of a buffer. */
interface LiveSlot {
  id: string;
  node: MediaStreamAudioSourceNode;
  capture: AudioWorkletNode;
  /** Source time the stream started at. */
  startAt: number;
  /** Silence already left out of the live clock, in seconds. */
  held: number;
  /** Source time a silence began that is still going on. */
  holdFrom: number | null;
}

/**
 * A captured stream cannot change speed, so its rack never applies a tempo.
 * In vinyl mode the pitch still moves as it would ("Slowed + reverb" keeps
 * its deeper sound), only the speed stays.
 */
function withoutTempo(s: StudioState): StudioState {
  const p = s.pitch;
  if (p.tempo === 1) return s;
  const vinyl = p.keepPitch ? 0 : 1200 * Math.log2(p.tempo);
  return { ...s, pitch: { ...p, tempo: 1, cents: p.cents + vinyl } };
}

export interface LatencyInfo {
  baseMs: number;
  outputMs: number;
  measuredMs: number;
}

/**
 * Signal chain:
 *   sources → stem mixer → srcBus → studio rack → bus ─┬─→ ReplayGain → declick → volume → output
 *                                                       └─→ analysers + meter worklet (read-only taps)
 *
 * The context runs at the source's own sample rate when possible, so nothing
 * is resampled inside the engine. Buffers are scheduled sample-accurately,
 * which is what makes playback gapless.
 */
export class AudioEngine extends Emitter<EngineEvents> {
  ctx: AudioContext | null = null;
  deviceRate = 48000;
  taps: Taps | null = null;
  /** User A/V calibration, added on top of the measured output latency. */
  offsetMs = 0;

  studio: StudioGraph | null = null;
  stemMixer: StemMixer | null = null;
  private stemMix: StemMix = DEFAULT_MIX;
  private stems = new Map<string, StemBuffers>();
  private studioState: StudioState | null = null;
  private studioOpts: StudioOptions = {};
  /** Playback speed from the studio's tempo control. */
  private rate = 1;
  private rg!: GainNode;
  private declick!: GainNode;
  private vol!: GainNode;
  private meter: AudioWorkletNode | null = null;
  /** Keeps worklet taps pulled by the graph without being heard. */
  private sink: GainNode | null = null;
  private cur: Slot | null = null;
  private live: LiveSlot | null = null;
  private nxt: Slot | null = null;
  private paused = false;
  private frozen = 0;
  private volumeDb = 0;
  private timer = 0;
  private building: Promise<void> | null = null;

  async detectDeviceRate(): Promise<number> {
    try {
      const probe = new AudioContext();
      this.deviceRate = probe.sampleRate;
      await probe.close();
    } catch {
      /* keep default */
    }
    return this.deviceRate;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 0;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  private async ensure(rate: number): Promise<void> {
    if (this.building) await this.building;
    if (this.ctx && this.ctx.sampleRate === rate) return;
    this.building = this.build(rate);
    try {
      await this.building;
    } finally {
      this.building = null;
    }
  }

  private async build(rate: number): Promise<void> {
    this.stopLive();
    this.silenceSources();
    this.cur = null;
    this.nxt = null;
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        /* already closed */
      }
    }
    const ctx = new AudioContext({ sampleRate: rate, latencyHint: 'playback' });
    await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}worklets/meter-processor.js`);

    const stereoBus = () => {
      const g = ctx.createGain();
      g.channelCount = 2;
      g.channelCountMode = 'explicit';
      g.channelInterpretation = 'speakers';
      return g;
    };
    const srcBus = stereoBus();
    const bus = stereoBus();
    this.studio?.dispose();
    const studio = new StudioGraph(ctx);
    srcBus.connect(studio.input);
    studio.output.connect(bus);
    this.stemMixer?.dispose();
    const stemMixer = new StemMixer(ctx);
    stemMixer.output.connect(srcBus);

    const fftSize = rate <= 50000 ? 8192 : rate <= 100000 ? 16384 : 32768;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = fftSize;
    analyser.smoothingTimeConstant = 0;
    const left = ctx.createAnalyser();
    const right = ctx.createAnalyser();
    left.fftSize = right.fftSize = 2048;
    const split = ctx.createChannelSplitter(2);
    bus.connect(analyser);
    bus.connect(split);
    split.connect(left, 0);
    split.connect(right, 1);

    const meter = new AudioWorkletNode(ctx, 'musiccus-meter', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    meter.port.onmessage = (e: MessageEvent<(MeterMsg & { type: 'meter' }) | (OnsetMsg & { type: 'onset' })>) => {
      const d = e.data;
      if (d.type === 'onset') this.emit('onset', d);
      else this.emit('meter', d);
    };
    const sink = ctx.createGain();
    sink.gain.value = 0;
    bus.connect(meter);
    meter.connect(sink).connect(ctx.destination);

    this.rg = ctx.createGain();
    this.declick = ctx.createGain();
    this.vol = ctx.createGain();
    this.vol.gain.value = dbToGain(this.volumeDb);
    bus.connect(this.rg).connect(this.declick).connect(this.vol).connect(ctx.destination);

    this.studio = studio;
    this.stemMixer = stemMixer;
    stemMixer.apply(this.stemMix, false, true);
    this.meter = meter;
    this.sink = sink;
    this.taps = { analyser, left, right };
    this.ctx = ctx;
    if (this.studioState) void studio.apply(this.rackState(this.studioState), { ...this.studioOpts, immediate: true });
    this.emit('graph', { sampleRate: ctx.sampleRate });
  }

  /** Context time the listener is hearing right now, minus the user's calibration. */
  syncTime(): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    if (this.paused || ctx.state !== 'running') return this.frozen;
    let t = ctx.currentTime - (ctx.outputLatency || 0) - (ctx.baseLatency || 0);
    const ts = ctx.getOutputTimestamp();
    if (ts.contextTime && ts.performanceTime) {
      const est = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
      if (est <= ctx.currentTime && est > ctx.currentTime - 1) t = est;
    }
    return t - this.offsetMs / 1000;
  }

  latency(): LatencyInfo {
    const ctx = this.ctx;
    if (!ctx) return { baseMs: 0, outputMs: 0, measuredMs: 0 };
    const measured = ctx.currentTime - (this.syncTime() + this.offsetMs / 1000);
    return {
      baseMs: (ctx.baseLatency || 0) * 1000,
      outputMs: (ctx.outputLatency || 0) * 1000,
      measuredMs: Math.max(0, measured * 1000),
    };
  }

  async play(id: string, buffer: AudioBuffer, offset = 0, rgDb = 0): Promise<void> {
    await this.ensure(buffer.sampleRate);
    const ctx = this.ctx!;
    this.stopLive();
    this.silenceSources();
    this.nxt = null;
    if (ctx.state !== 'running') await ctx.resume();
    this.paused = false;
    const when = ctx.currentTime + 0.05;
    this.rg.gain.cancelScheduledValues(0);
    this.rg.gain.setValueAtTime(dbToGain(rgDb), when);
    this.declick.gain.cancelScheduledValues(0);
    this.declick.gain.setValueAtTime(0, ctx.currentTime);
    this.declick.gain.setValueAtTime(0, when);
    this.declick.gain.linearRampToValueAtTime(1, when + 0.012);
    this.meter?.port.postMessage({ type: 'reset', at: when });
    this.cur = this.startSlot(id, buffer, when, offset, rgDb);
    this.startTimer();
  }

  /**
   * Plays a captured stream (a browser tab) through the stem mixer and the
   * rack, like a file. It cannot seek or change speed. Without `monitor` the
   * tab keeps playing its own sound, so the engine stays silent and only the
   * visuals and analysis follow it.
   */
  async playStream(id: string, stream: MediaStream, monitor: boolean): Promise<void> {
    await this.ensure(this.deviceRate);
    const ctx = this.ctx!;
    this.stopLive();
    this.silenceSources();
    this.cur = null;
    this.nxt = null;
    if (ctx.state !== 'running') await ctx.resume();
    this.paused = false;
    const when = ctx.currentTime + 0.05;
    const node = ctx.createMediaStreamSource(stream);
    node.connect(this.stemMixer!.input);
    // The live analysis listens to the stream itself, before the rack.
    const capture = new AudioWorkletNode(ctx, 'musiccus-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    capture.port.onmessage = (e: MessageEvent<CaptureMsg>) => this.emit('capture', e.data);
    node.connect(capture);
    capture.connect(this.sink!);
    this.rg.gain.cancelScheduledValues(0);
    this.rg.gain.setValueAtTime(monitor ? 1 : 0, when);
    this.declick.gain.cancelScheduledValues(0);
    this.declick.gain.setValueAtTime(0, ctx.currentTime);
    this.declick.gain.setValueAtTime(0, when);
    this.declick.gain.linearRampToValueAtTime(1, when + 0.012);
    this.meter?.port.postMessage({ type: 'reset', at: when });
    this.live = { id, node, capture, startAt: when, held: 0, holdFrom: null };
    this.reapplyStudio();
  }

  /** Disconnects the captured stream. The caller stops the stream's tracks. */
  stopLive(): void {
    const l = this.live;
    if (!l) return;
    this.live = null;
    l.capture.port.onmessage = null;
    for (const n of [l.node, l.capture]) {
      try {
        n.disconnect();
      } catch {
        /* graph was rebuilt */
      }
    }
    this.reapplyStudio();
  }

  /** Whether Musiccus plays the stream's sound (off when the tab stays audible by itself). */
  setLiveMonitor(on: boolean): void {
    if (!this.ctx || !this.live) return;
    this.rg.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  get isLive(): boolean {
    return this.live !== null;
  }

  /** The stream fell silent at source time `from`: the live clock stops there. */
  holdLive(from: number): void {
    const l = this.live;
    if (l && l.holdFrom === null) l.holdFrom = Math.max(from, l.startAt);
  }

  /** Sound came back at source time `to`: the live clock runs again. */
  releaseLive(to: number): void {
    const l = this.live;
    if (!l || l.holdFrom === null) return;
    l.held += Math.max(0, to - l.holdFrom);
    l.holdFrom = null;
  }

  /** Seconds of sound the stream has played up to source time `t`, silences left out. */
  liveClockAt(t: number): number {
    const l = this.live;
    if (!l) return 0;
    const open = l.holdFrom !== null && t > l.holdFrom ? t - l.holdFrom : 0;
    return Math.max(0, t - l.startAt - l.held - open);
  }

  canGapless(buffer: AudioBuffer): boolean {
    return !!this.ctx && !!this.cur && buffer.sampleRate === this.ctx.sampleRate;
  }

  /** Queue a buffer to start on the exact sample the current one ends. */
  scheduleNext(id: string, buffer: AudioBuffer, rgDb = 0): boolean {
    const ctx = this.ctx;
    const cur = this.cur;
    if (!ctx || !cur || !this.canGapless(buffer)) return false;
    this.clearNext();
    const when = cur.startAt + (cur.buffer.duration - cur.offset) / this.rate;
    if (when < ctx.currentTime + 0.1) return false;
    this.rg.gain.setValueAtTime(dbToGain(rgDb), when);
    this.meter?.port.postMessage({ type: 'reset', at: when });
    this.nxt = this.startSlot(id, buffer, when, 0, rgDb);
    if (!this.hasStems(this.nxt)) this.stemMixer?.directAt(when);
    return true;
  }

  get nextId(): string | null {
    return this.nxt?.id ?? null;
  }

  clearNext(): void {
    if (!this.nxt || !this.ctx) return;
    this.stopSlot(this.nxt);
    this.nxt = null;
    this.stemMixer?.cancelScheduled();
    this.applyStemMix();
    const now = this.ctx.currentTime;
    this.rg.gain.cancelScheduledValues(now);
    if (this.cur) this.rg.gain.setValueAtTime(dbToGain(this.cur.rgDb), now);
  }

  seek(sec: number): void {
    const ctx = this.ctx;
    const cur = this.cur;
    if (!ctx || !cur) return;
    const offset = Math.max(0, Math.min(sec, cur.buffer.duration - 0.01));
    const pendingNext = this.nxt;
    this.nxt = null;

    if (this.paused) {
      this.silenceSources();
      this.frozen = ctx.currentTime;
      this.cur = this.startSlot(cur.id, cur.buffer, ctx.currentTime + 0.03, offset, cur.rgDb);
      this.frozen = this.cur.startAt;
    } else {
      const now = ctx.currentTime;
      const g = this.declick.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + 0.012);
      g.setValueAtTime(0, now + 0.02);
      g.linearRampToValueAtTime(1, now + 0.035);
      this.silenceSources(now + 0.014);
      this.cur = this.startSlot(cur.id, cur.buffer, now + 0.02, offset, cur.rgDb);
    }
    if (pendingNext) this.scheduleNext(pendingNext.id, pendingNext.buffer, pendingNext.rgDb);
  }

  async pause(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || this.paused) return;
    this.frozen = this.syncTime();
    this.paused = true;
    const now = ctx.currentTime;
    const g = this.declick.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + 0.025);
    await new Promise((r) => setTimeout(r, 45));
    if (this.paused) await ctx.suspend();
  }

  async resume(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || !this.paused) return;
    await ctx.resume();
    this.paused = false;
    const now = ctx.currentTime;
    const g = this.declick.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    g.linearRampToValueAtTime(1, now + 0.025);
  }

  stop(): void {
    this.stopLive();
    this.silenceSources();
    this.cur = null;
    this.nxt = null;
  }

  setVolume(db: number): void {
    this.volumeDb = db;
    // Touching the volume during a sleep fade means someone is still listening.
    if (this.fade) this.endFade();
    else this.restoreVolume();
  }

  /** Puts the volume back to the listener's setting, after a fade. */
  restoreVolume(): void {
    if (!this.ctx) return;
    this.vol.gain.setTargetAtTime(Number.isFinite(this.volumeDb) ? dbToGain(this.volumeDb) : 0, this.ctx.currentTime, 0.015);
  }

  private fade: { timer: number; done: (finished: boolean) => void } | null = null;

  /**
   * Lowers the volume to silence over `seconds` (the sleep timer) and leaves it
   * there; the caller pauses and calls restoreVolume. Resolves false when the
   * fade is cut short.
   */
  fadeOut(seconds: number): Promise<boolean> {
    this.endFade();
    const ctx = this.ctx;
    if (!ctx) return Promise.resolve(true);
    const g = this.vol.gain;
    const now = ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    // Exponential in gain is a straight line in decibels, so the fade sounds even.
    g.setTargetAtTime(0, now, seconds / 5);
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.fade = null;
        resolve(true);
      }, seconds * 1000);
      this.fade = { timer, done: resolve };
    });
  }

  /** Cuts a fade short and brings the volume back. */
  endFade(): void {
    const f = this.fade;
    if (!f) return;
    this.fade = null;
    window.clearTimeout(f.timer);
    this.restoreVolume();
    f.done(false);
  }

  /** Change ReplayGain of the playing track, e.g. when the mode is switched. */
  setReplayGain(db: number): void {
    if (!this.ctx || !this.cur) return;
    this.cur.rgDb = db;
    this.rg.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.02);
  }

  get studioLatency(): number {
    return this.studio?.latency ?? 0;
  }

  get studioProcessing(): boolean {
    return !!this.studioState && studioProcessing(this.studioState) && !this.studioOpts.bypass;
  }

  /** K-weighted mean-square level before and after the rack, or null before playback starts. */
  studioLoudness(): { pre: number; post: number } | null {
    return this.studio?.loudness() ?? null;
  }

  /** Applies the studio rack (and its tempo) to the live graph. */
  applyStudio(state: StudioState, opts: StudioOptions = {}): Promise<void> {
    this.studioState = state;
    this.studioOpts = opts;
    const rack = this.rackState(state);
    this.setRate(opts.bypass ? 1 : playbackRate(rack.pitch));
    return this.studio ? this.studio.apply(rack, opts) : Promise.resolve();
  }

  /** The rack as the current source can play it. */
  private rackState(state: StudioState): StudioState {
    return this.live ? withoutTempo(state) : state;
  }

  private reapplyStudio(): void {
    if (this.studioState) void this.applyStudio(this.studioState, this.studioOpts);
  }

  /**
   * Changes playback speed without a gap: the current source is re-anchored
   * at its present position and the queued next track is rescheduled.
   */
  private setRate(rate: number): void {
    if (Math.abs(rate - this.rate) < 1e-6) return;
    const old = this.rate;
    this.rate = rate;
    const ctx = this.ctx;
    const cur = this.cur;
    if (!ctx || !cur) return;
    const now = ctx.currentTime;
    if (now > cur.startAt) {
      cur.offset = Math.min(cur.buffer.duration, cur.offset + (now - cur.startAt) * old);
      cur.startAt = now;
    }
    for (const src of [cur.src, ...cur.stemSrcs]) src.playbackRate.setValueAtTime(rate, now);
    if (this.paused) this.frozen = now;
    const pending = this.nxt;
    if (pending) {
      this.clearNext();
      this.scheduleNext(pending.id, pending.buffer, pending.rgDb);
    }
  }

  /** Playback speed (1 = as recorded), from the studio's tempo control. */
  get speed(): number {
    return this.rate;
  }

  position(): Position | null {
    const live = this.live;
    if (live) return { id: live.id, time: this.liveClockAt(this.syncTime() - this.studioLatency), duration: Infinity, live: true };
    const cur = this.cur;
    if (!cur) return null;
    // What is heard left the source `studioLatency` earlier (pitch stretcher).
    const t = this.syncTime() - this.studioLatency;
    const time = t < cur.startAt ? cur.offset : cur.offset + (t - cur.startAt) * this.rate;
    return { id: cur.id, time: Math.min(Math.max(0, time), cur.buffer.duration), duration: cur.buffer.duration };
  }

  private startSlot(id: string, buffer: AudioBuffer, when: number, offset: number, rgDb: number): Slot {
    const ctx = this.ctx!;
    const mixer = this.stemMixer!;
    const make = (b: AudioBuffer, to: AudioNode) => {
      const src = ctx.createBufferSource();
      src.buffer = b;
      src.playbackRate.value = this.rate;
      src.connect(to);
      src.start(when, offset);
      return src;
    };
    const src = make(buffer, mixer.input);
    const stems = this.usableStems(id, buffer);
    const stemSrcs = stems ? STORED.map((k) => make(stems[k], mixer.stemIn[k])) : [];
    return { id, buffer, src, stemSrcs, stemsRef: stems, startAt: when, offset, rgDb, ended: false };
  }

  private usableStems(id: string, buffer: AudioBuffer): StemBuffers | null {
    const stems = this.stems.get(id);
    return stems && STORED.every((k) => stems[k].sampleRate === buffer.sampleRate && stems[k].length === buffer.length) ? stems : null;
  }

  private stopSlot(s: Slot, at?: number): void {
    for (const src of [s.src, ...s.stemSrcs]) {
      try {
        src.stop(at);
      } catch {
        /* already stopped */
      }
      if (at === undefined) src.disconnect();
    }
  }

  private silenceSources(at?: number): void {
    for (const s of [this.cur, this.nxt]) if (s) this.stopSlot(s, at);
  }

  private hasStems(s: Slot | null): boolean {
    return !!s && s.stemSrcs.length > 0;
  }

  private applyStemMix(immediate = false): void {
    this.stemMixer?.apply(this.stemMix, this.hasStems(this.cur), immediate);
  }

  /**
   * A stereo stream of what is heard, after the stems, the rack and
   * ReplayGain but before the volume knob, for recording video.
   */
  recordTap(): MediaStreamAudioDestinationNode | null {
    if (!this.ctx) return null;
    const dest = this.ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    this.declick.connect(dest);
    return dest;
  }

  releaseTap(dest: MediaStreamAudioDestinationNode): void {
    try {
      this.declick.disconnect(dest);
    } catch {
      /* graph was rebuilt */
    }
  }

  /** Mixer settings for separated stems (karaoke, solo, 3D stage). */
  setStemMix(mix: StemMix): void {
    this.stemMix = mix;
    this.syncStems();
    this.applyStemMix();
  }

  /** True while the stems are being recombined differently from the original. */
  get stemsProcessing(): boolean {
    return !!this.stemMixer?.processing;
  }

  /**
   * Registers (or drops) a track's stems. When it is the playing track, the
   * sources are restarted together at the sample being rendered now, so the
   * stems line up with the mix to the sample.
   */
  setStems(id: string, stems: StemBuffers | null): void {
    if (stems) this.stems.set(id, stems);
    else this.stems.delete(id);
    for (const key of [...this.stems.keys()]) if (key !== id && key !== this.cur?.id && key !== this.nxt?.id) this.stems.delete(key);
    this.syncStems();
    this.applyStemMix();
  }

  /**
   * Starts or drops the playing track's stem sources when needed. Stems that
   * arrive while the mix is untouched wait for the next natural restart, so a
   * finished separation never interrupts what is playing.
   */
  private syncStems(): void {
    const ctx = this.ctx;
    const cur = this.cur;
    if (!ctx || !cur) return;
    const stems = this.usableStems(cur.id, cur.buffer);
    const stale = cur.stemsRef !== null && cur.stemsRef !== stems;
    const needed = stems !== null && cur.stemsRef !== stems && !mixNeutral(this.stemMix);
    if (!stale && !needed) return;
    const at = ctx.currentTime + 0.02;
    this.seek(cur.offset + Math.max(0, at - cur.startAt) * this.rate);
  }

  /** Whether the playing track currently plays from its stems. */
  get playingStems(): boolean {
    return this.hasStems(this.cur);
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = window.setInterval(() => this.tick(), 40);
  }

  private tick(): void {
    if (!this.ctx || this.paused) return;
    const t = this.syncTime() - this.studioLatency;
    if (this.nxt && t >= this.nxt.startAt) {
      if (this.cur) this.stopSlot(this.cur);
      this.cur = this.nxt;
      this.nxt = null;
      this.applyStemMix();
      this.emit('advance', { id: this.cur.id });
      return;
    }
    const cur = this.cur;
    if (cur && !this.nxt && !cur.ended && t >= cur.startAt + (cur.buffer.duration - cur.offset) / this.rate) {
      cur.ended = true;
      this.emit('ended', { id: cur.id });
    }
  }
}

export const engine = new AudioEngine();
