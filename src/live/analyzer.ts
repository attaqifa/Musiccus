import type { Analysis, AnalysisJob, KeyInfo, Music, WorkerMessage } from '../analysis/types';
import { engine, type CaptureMsg } from '../audio/engine';
import type { Snapshot } from '../audio/hub';
import { getLive, useLive } from './store';

/**
 * Live analysis of a captured tab. A song from Spotify or YouTube Music
 * arrives as it plays, so the whole-song analysis cannot run once in
 * advance. Instead the last half minute of sound is analysed again every few
 * seconds with the same worker, and the results are joined on the live clock:
 * the beat grid is extended past the analysed part at its own period, and
 * the key is the one most of the analyses agreed on.
 *
 * A silence of 0.7 s or more ends a stretch of sound (the tab paused, or the
 * song ended). The live clock stops during it, and the next stretch starts a
 * fresh analysis, because the beat phase is lost and it may be a new song.
 */

/** Seconds analysed at once. */
const WINDOW = 30;
/** Seconds of new sound between analyses (also before the first one). */
const EVERY = 8;
/** Below -50 dBFS counts as silence. */
const SILENT_MS = 1e-5;
const SILENT_HOLD = 0.7;
/** A beat grid is extended at most this far past what was analysed. */
const MAX_EXTEND = 20;

interface Grid {
  /** Beat times on the live clock. */
  beats: number[];
  period: number;
  /** A downbeat on the live clock. */
  barRef: number;
  perBar: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
};

class LiveAnalyzer {
  private rate = 48000;
  private cap = 0;
  private L = new Float32Array(0);
  private R = new Float32Array(0);
  private write = 0;
  /** Samples in the current stretch (the ring holds the last `cap`). */
  private filled = 0;
  private sinceJob = 0;
  private silentFrom: number | null = null;
  private holding = false;
  private stretch = 0;

  private worker: Worker | null = null;
  private seq = 0;
  private job: { id: number; stretch: number; start: number } | null = null;

  private votes = new Float64Array(24);
  private bpms: number[] = [];
  private grid: Grid | null = null;
  private off: (() => void) | null = null;

  // Per-frame state for the visuals.
  private lastBeat = -Infinity;
  private eFast = 0;
  private eSlow = 0;
  private impactAt = -Infinity;

  start(rate: number) {
    this.stop();
    this.rate = rate;
    this.cap = Math.round(WINDOW * rate);
    this.L = new Float32Array(this.cap);
    this.R = new Float32Array(this.cap);
    this.holding = false;
    this.silentFrom = null;
    this.newStretch(0);
    this.off = engine.on('capture', (m) => this.onBlock(m));
  }

  stop() {
    this.off?.();
    this.off = null;
    this.worker?.terminate();
    this.worker = null;
    this.job = null;
    this.grid = null;
    this.L = this.R = new Float32Array(0);
  }

  private newStretch(clock: number) {
    this.stretch++;
    this.write = 0;
    this.filled = 0;
    this.sinceJob = 0;
    this.votes.fill(0);
    this.bpms = [];
    this.grid = null;
    // Key and tempo stay on screen until the new stretch has its own.
    useLive.setState({ songStart: clock, rounds: 0, chords: [] });
  }

  private onBlock(msg: CaptureMsg) {
    if (!this.cap) return;
    const n = msg.l.length;
    let ms = 0;
    for (let i = 0; i < n; i++) ms += msg.l[i] * msg.l[i] + msg.r[i] * msg.r[i];
    ms /= 2 * n;
    const end = msg.t + n / this.rate;

    if (ms < SILENT_MS) {
      this.silentFrom ??= msg.t;
      if (!this.holding && end - this.silentFrom >= SILENT_HOLD) {
        this.holding = true;
        engine.holdLive(this.silentFrom);
        this.grid = null;
        useLive.setState({ silent: true });
      }
      if (this.holding) return;
    } else {
      if (this.holding) {
        this.holding = false;
        engine.releaseLive(msg.t);
        this.newStretch(engine.liveClockAt(msg.t));
        useLive.setState({ silent: false });
      }
      this.silentFrom = null;
    }

    this.push(msg.l, msg.r);
    this.sinceJob += n;
    if (!this.job && this.sinceJob >= EVERY * this.rate) this.analyse(end);
  }

  private push(l: Float32Array, r: Float32Array) {
    let i = 0;
    while (i < l.length) {
      const k = Math.min(l.length - i, this.cap - this.write);
      this.L.set(l.subarray(i, i + k), this.write);
      this.R.set(r.subarray(i, i + k), this.write);
      this.write = (this.write + k) % this.cap;
      i += k;
    }
    this.filled += l.length;
  }

  /** Copies the last `len` samples of the ring, oldest first. */
  private tail(ring: Float32Array, len: number): Float32Array {
    const out = new Float32Array(len);
    const from = (this.write - len + this.cap) % this.cap;
    const first = Math.min(len, this.cap - from);
    out.set(ring.subarray(from, from + first), 0);
    if (first < len) out.set(ring.subarray(0, len - first), first);
    return out;
  }

  private analyse(endT: number) {
    const len = Math.min(this.filled, this.cap);
    const channels = [this.tail(this.L, len), this.tail(this.R, len)];
    // A stretch has no silences cut out of it, so the window maps onto the
    // live clock in one piece.
    const start = engine.liveClockAt(endT - len / this.rate);
    const job: AnalysisJob = {
      id: ++this.seq,
      channels,
      sampleRate: this.rate,
      meta: { resampled: false, sourceRate: this.rate, lossless: false, codec: 'Live' },
    };
    this.job = { id: job.id, stretch: this.stretch, start };
    this.sinceJob = 0;
    this.ensureWorker().postMessage(job, channels.map((c) => c.buffer));
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('../analysis/worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data;
      const job = this.job;
      if (!job || msg.id !== job.id || msg.type === 'progress') return;
      this.job = null;
      if (msg.type === 'done' && job.stretch === this.stretch) this.absorb(msg.result, job.start);
    };
    w.onerror = () => {
      this.job = null;
      w.terminate();
      if (this.worker === w) this.worker = null;
    };
    this.worker = w;
    return w;
  }

  private absorb(a: Analysis, t0: number) {
    const beats = Array.from(a.beats, (b) => b + t0);
    if (beats.length >= 4) {
      const ibis = beats.slice(1).map((b, i) => b - beats[i]);
      const period = median(ibis);
      const downs = Array.from(a.downbeats).filter((i) => i >= 0 && i < beats.length);
      const gaps = downs.slice(1).map((d, i) => d - downs[i]);
      const perBar = Math.max(2, Math.min(7, Math.round(median(gaps)) || 4));
      const barRef = downs.length ? beats[downs[downs.length - 1]] : beats[0];
      if (period > 0.2 && period < 2) this.grid = { beats, period, barRef, perBar };
    }

    if (a.bpm > 0) {
      this.bpms = [...this.bpms.slice(-2), a.bpm];
    }
    const seconds = a.duration || 1;
    this.votes[a.key.tonic + (a.key.mode === 'minor' ? 12 : 0)] += (0.25 + a.key.confidence) * seconds;
    let best = 0;
    let total = 0;
    for (let i = 0; i < 24; i++) {
      total += this.votes[i];
      if (this.votes[i] > this.votes[best]) best = i;
    }
    const key: KeyInfo = { tonic: best % 12, mode: best >= 12 ? 'minor' : 'major', confidence: total > 0 ? this.votes[best] / total : 0 };

    const live = getLive();
    const fresh = a.chords.map((c) => ({ ...c, t: c.t + t0, end: c.end + t0 }));
    const newest = fresh.length ? fresh[fresh.length - 1].end : t0;
    // The new analysis replaces what it overlaps; older chords stay for half a minute.
    const chords = [...live.chords.filter((c) => c.end <= t0 + 0.05), ...fresh].filter((c) => c.end > newest - WINDOW);

    useLive.setState({
      bpm: this.bpms.length ? Math.round(median(this.bpms) * 10) / 10 : live.bpm,
      key,
      chords,
      rounds: live.rounds + 1,
    });
  }

  /** The tempo the synced effects should follow. */
  get bpm(): number | null {
    return getLive().bpm;
  }

  /**
   * Fills the conductor's musical state for live time `t`. There are no
   * sections and no look-ahead: a captured song is only known up to now.
   */
  fill(m: Music, s: Snapshot, t: number) {
    const live = getLive();
    const decay = (k: number) => Math.exp(-s.dt * k);
    m.trackTime = t;
    m.key = live.key;
    m.bpm = live.bpm ?? 0;
    m.chord = m.nextChord = null;
    m.section = m.nextSection = null;
    m.sectionIndex = -1;
    m.timeToNext = Infinity;
    m.anticipation = 0;
    m.ready = live.key !== null;

    const e = s.features.energy;
    m.energy = e;
    this.eFast += (e - this.eFast) * (1 - decay(1 / 0.8));
    this.eSlow += (e - this.eSlow) * (1 - decay(1 / 8));
    // A sudden lift in loudness (a drop, a chorus) lands as an impact.
    if (!live.silent && this.eFast - this.eSlow > 0.22 && t - this.impactAt > 10) this.impactAt = t;
    m.impact = t >= this.impactAt ? Math.exp(-(t - this.impactAt) * 1.4) * 0.8 : 0;

    const g = this.grid;
    const lastKnown = g ? g.beats[g.beats.length - 1] : -Infinity;
    if (!g || live.silent || t - lastKnown > MAX_EXTEND) {
      m.beatPulse *= decay(6);
      m.downbeatPulse *= decay(6);
      m.beatPhase = 0;
      m.barIndex = -1;
      return;
    }
    let beat: number;
    let next: number;
    if (t <= lastKnown) {
      let lo = 0;
      let hi = g.beats.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (g.beats[mid] <= t) lo = mid;
        else hi = mid - 1;
      }
      beat = g.beats[lo];
      next = g.beats[lo + 1] ?? beat + g.period;
      if (beat > t) {
        // Before the first analysed beat: count back at the grid's period.
        beat -= Math.ceil((beat - t) / g.period) * g.period;
        next = beat + g.period;
      }
    } else {
      beat = lastKnown + Math.floor((t - lastKnown) / g.period) * g.period;
      next = beat + g.period;
    }
    const inBar = (((Math.round((beat - g.barRef) / g.period) % g.perBar) + g.perBar) % g.perBar);
    if (beat > this.lastBeat + g.period * 0.5) {
      m.beatCount++;
      if (inBar === 0) m.downbeatCount++;
    }
    this.lastBeat = beat;
    m.beatIndex = m.beatCount;
    m.barIndex = m.downbeatCount;
    m.beatInBar = inBar;
    m.beatPhase = Math.max(0, Math.min(1, (t - beat) / Math.max(0.05, next - beat)));
    m.beatPulse = Math.exp(-(t - beat) * 9);
    m.downbeatPulse = Math.exp(-(t - (beat - inBar * g.period)) * 5);
  }
}

export const liveAnalyzer = new LiveAnalyzer();
