import { useRef, useState, type PointerEvent } from 'react';
import { engine } from '../../audio/engine';
import { SPEC_FLOOR, SPEC_N } from '../../audio/hub';
import { formatHz } from '../../lib/format';
import { useStudio } from '../../studio/store';
import { useHubCanvas } from '../hooks';
import { C, keyCss, MONO } from '../palette';

const GRID = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const ZONES: { name: string; lo: number; hi: number; tip: string }[] = [
  { name: 'Sub', lo: 20, hi: 60, tip: 'Sub-bass: getaran yang lebih terasa di badan daripada terdengar. Fondasi kick dan synth bass.' },
  { name: 'Bass', lo: 60, hi: 250, tip: 'Bass: nada dasar bass dan kick, memberi berat dan kehangatan.' },
  { name: 'Low-mid', lo: 250, hi: 500, tip: 'Low-mid: badan gitar, piano, dan vokal. Terlalu banyak terdengar "berlumpur".' },
  { name: 'Mid', lo: 500, hi: 2000, tip: 'Mid: inti hampir semua instrumen dan kejelasan vokal.' },
  { name: 'Presence', lo: 2000, hi: 6000, tip: 'Presence: kedekatan dan artikulasi; telinga paling sensitif di sini.' },
  { name: 'Air', lo: 6000, hi: 20000, tip: 'Air: kilau simbal, napas vokal, dan rasa ruang.' },
];
const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

const noteOf = (f: number) => {
  const midi = Math.round(69 + 12 * Math.log2(f / 440));
  return `${NOTES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
};

/** Display tilt: +3 dB/octave around 1 kHz so typical music reads roughly flat. */
const TILT = 3;
const TOP = -6;
const RANGE = 84;
/** Both lines are smoothed alike, since the rack's input is not delayed to the heard time. */
const TAU = 0.1;

/** Maps the rack's input analyser onto the hub's log frequency points. */
class PreSpectrum {
  private key = '';
  private lo = new Int32Array(SPEC_N);
  private hi = new Int32Array(SPEC_N);
  private ctr = new Float32Array(SPEC_N);
  private fft = new Float32Array(0);
  readonly out = new Float32Array(SPEC_N).fill(SPEC_FLOOR);

  read(a: AnalyserNode, freqs: Float32Array): Float32Array {
    const rate = a.context.sampleRate;
    const key = `${rate}:${a.fftSize}:${freqs[SPEC_N - 1]}`;
    if (key !== this.key) {
      this.key = key;
      this.fft = new Float32Array(a.frequencyBinCount);
      const binHz = rate / a.fftSize;
      for (let i = 0; i < SPEC_N; i++) {
        const f = freqs[i];
        const lo = i > 0 ? Math.sqrt(f * freqs[i - 1]) : f;
        const hi = i < SPEC_N - 1 ? Math.sqrt(f * freqs[i + 1]) : f;
        this.lo[i] = Math.ceil(lo / binHz);
        this.hi[i] = Math.min(this.fft.length - 1, Math.floor(hi / binHz));
        this.ctr[i] = f / binHz;
      }
    }
    const fft = this.fft;
    a.getFloatFrequencyData(fft);
    for (let i = 0; i < SPEC_N; i++) {
      let v: number;
      if (this.hi[i] >= this.lo[i]) {
        v = -Infinity;
        for (let k = this.lo[i]; k <= this.hi[i]; k++) if (fft[k] > v) v = fft[k];
      } else {
        const k = Math.floor(this.ctr[i]);
        const fr = this.ctr[i] - k;
        v = fft[k] * (1 - fr) + fft[Math.min(k + 1, fft.length - 1)] * fr;
      }
      this.out[i] = Number.isFinite(v) ? Math.max(SPEC_FLOOR, v) : SPEC_FLOOR;
    }
    return this.out;
  }
}

/**
 * Live spectrum of what plays. While the rack changes the sound, a dashed
 * line shows the original next to the result, so an EQ move is visible.
 */
export function Spectrum({ onCompareChange }: { onCompareChange?: (on: boolean) => void }) {
  const post = useRef(new Float32Array(SPEC_N).fill(SPEC_FLOOR));
  const pre = useRef(new Float32Array(SPEC_N).fill(SPEC_FLOOR));
  const peaks = useRef(new Float32Array(SPEC_N).fill(SPEC_FLOOR));
  const preMap = useRef(new PreSpectrum());
  const hover = useRef<number | null>(null);
  const shown = useRef(false);
  const [readout, setReadout] = useState<{ x: number; text: string; zone: string } | null>(null);
  const lastTop = useRef(20000);

  const canvas = useHubCanvas((ctx, w, h, s) => {
    ctx.clearRect(0, 0, w, h);
    const freqs = s.specFreqs;
    const top = s.sampleRate > 0 ? Math.min(s.sampleRate / 2, 48000) : 20000;
    const fMax = Math.max(20000, top);
    lastTop.current = fMax;
    const lx = Math.log(20);
    const span = Math.log(fMax) - lx;
    const xOf = (f: number) => ((Math.log(f) - lx) / span) * w;
    const plotTop = 14;
    const plotH = h - plotTop - 13;
    const yOf = (db: number) => plotTop + ((TOP - db) / RANGE) * plotH;
    const bottom = plotTop + plotH;

    const studio = engine.studio;
    const compare = studio !== null && engine.studioProcessing && !useStudio.getState().compare;
    if (compare !== shown.current) {
      shown.current = compare;
      onCompareChange?.(compare);
    }

    if (fMax > 20500) {
      ctx.fillStyle = 'rgba(236,234,230,0.035)';
      ctx.fillRect(xOf(20000), plotTop, w - xOf(20000), plotH);
    }
    ctx.font = `500 10px ${MONO}`;
    ctx.textBaseline = 'alphabetic';
    for (const z of ZONES) {
      const x0 = xOf(z.lo);
      const x1 = xOf(z.hi);
      ctx.fillStyle = C.ink4;
      ctx.textAlign = 'center';
      if (x1 - x0 > 34) ctx.fillText(z.name, (x0 + x1) / 2, 9);
    }
    for (let db = TOP - 12; db > TOP - RANGE; db -= 12) {
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(yOf(db)) + 0.5);
      ctx.lineTo(w, Math.round(yOf(db)) + 0.5);
      ctx.stroke();
    }
    for (const f of GRID) {
      if (f > fMax) continue;
      const x = Math.round(xOf(f)) + 0.5;
      ctx.strokeStyle = f === 1000 ? C.gridStrong : C.grid;
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.fillStyle = C.ink3;
      ctx.textAlign = 'center';
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x, h - 2);
    }

    const k = 1 - Math.exp(-Math.max(0.001, s.dt) / TAU);
    const sm = post.current;
    const pk = peaks.current;
    const spec = s.spec;
    for (let i = 0; i < SPEC_N; i++) {
      const v = spec[i] + TILT * Math.log2(freqs[i] / 1000);
      sm[i] += (v - sm[i]) * k;
      pk[i] = Math.max(sm[i], pk[i] - s.dt * 14);
    }
    const line = (arr: Float32Array, close: boolean) => {
      ctx.beginPath();
      let started = false;
      let lastX = -1;
      for (let i = 0; i < SPEC_N; i++) {
        const f = freqs[i];
        if (f <= 0 || f > fMax) break;
        const x = xOf(f);
        if (x - lastX < 0.8 && i < SPEC_N - 1) continue;
        lastX = x;
        const y = Math.min(bottom, yOf(arr[i]));
        if (!started) {
          if (close) {
            ctx.moveTo(x, bottom);
            ctx.lineTo(x, y);
          } else ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      if (started && close) {
        ctx.lineTo(lastX, bottom);
        ctx.closePath();
      }
      return started;
    };

    if (line(sm, true)) {
      const g = ctx.createLinearGradient(0, plotTop, 0, bottom);
      g.addColorStop(0, keyCss(0.36));
      g.addColorStop(1, keyCss(0.02));
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = keyCss(1);
      ctx.lineWidth = 1.3;
      ctx.stroke();
    }

    if (compare && studio) {
      const raw = preMap.current.read(studio.preSpectrum, freqs);
      const p = pre.current;
      for (let i = 0; i < SPEC_N; i++) p[i] += (raw[i] + TILT * Math.log2(freqs[i] / 1000) - p[i]) * k;
      if (line(p, false)) {
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = 'rgba(236,234,230,0.6)';
        ctx.lineWidth = 1.1;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    } else if (line(pk, false)) {
      ctx.strokeStyle = 'rgba(236,234,230,0.28)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (hover.current !== null) {
      ctx.strokeStyle = C.ink2;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(hover.current + 0.5, plotTop);
      ctx.lineTo(hover.current + 0.5, bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  });

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    hover.current = x;
    const f = 20 * Math.pow(lastTop.current / 20, x / r.width);
    const zone = ZONES.find((z) => f >= z.lo && f < z.hi);
    const left = Math.min(r.width - 96, Math.max(96, x));
    setReadout({ x: left, text: `${formatHz(f)} · ${noteOf(f)}`, zone: zone ? zone.tip : 'Di atas batas pendengaran manusia (~20 kHz).' });
  };
  const onLeave = () => {
    hover.current = null;
    setReadout(null);
  };

  return (
    <div className="spectrum" onPointerMove={onMove} onPointerLeave={onLeave}>
      <canvas ref={canvas} className="meter-canvas" role="img" aria-label="Analyzer spektrum frekuensi" />
      {readout && (
        <div className="spec-readout" style={{ left: readout.x }}>
          <strong>{readout.text}</strong>
          <span>{readout.zone}</span>
        </div>
      )}
    </div>
  );
}
