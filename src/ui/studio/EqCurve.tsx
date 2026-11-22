import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Authenticity } from '../../analysis/types';
import { hub } from '../../audio/hub';
import { formatHz } from '../../lib/format';
import type { EqBand } from '../../studio/types';

const F_MIN = 20;
const F_MAX = 20000;
/** Gain shown above and below 0 dB. */
const RANGE = 15;
const N = 240;
const H = 156;
const TOP = 8;
const BOTTOM = 16;
const FREQS = Float32Array.from({ length: N }, (_, i) => F_MIN * Math.pow(F_MAX / F_MIN, i / (N - 1)));

/** Bands whose gain the filter ignores: they move left and right only. */
export const gainless = (t: EqBand['type']) => t === 'highpass' || t === 'lowpass' || t === 'notch';
/** Web Audio's shelves ignore Q, and the rack pins the cut filters' Q to 0. */
export const usesQ = (t: EqBand['type']) => t === 'peaking' || t === 'notch';

let scratch: { rate: number; ctx: OfflineAudioContext; nodes: BiquadFilterNode[] } | null = null;

/**
 * The summed response of the eight bands, in dB, measured on biquads set
 * exactly as the rack sets its own, so the curve is the sound and not a sketch.
 */
function response(bands: EqBand[]): Float32Array {
  const rate = hub.snapshot.sampleRate > 0 ? hub.snapshot.sampleRate : 48000;
  if (!scratch || scratch.rate !== rate) scratch = { rate, ctx: new OfflineAudioContext(1, 1, rate), nodes: [] };
  const out = new Float32Array(N);
  const mag = new Float32Array(N);
  const phase = new Float32Array(N);
  bands.forEach((b, i) => {
    const node = (scratch!.nodes[i] ??= scratch!.ctx.createBiquadFilter());
    node.type = b.type;
    node.frequency.value = b.freq;
    node.gain.value = b.on ? b.gain : 0;
    node.Q.value = b.type === 'highpass' || b.type === 'lowpass' ? 0 : b.q;
    node.getFrequencyResponse(FREQS, mag, phase);
    for (let k = 0; k < N; k++) out[k] += 20 * Math.log10(Math.max(1e-6, mag[k]));
  });
  return out;
}

const roundFreq = (f: number) => {
  const p = Math.pow(10, Math.floor(Math.log10(f)) - 2);
  return Math.min(F_MAX, Math.max(F_MIN, Math.round(f / p) * p));
};
const num = (v: number, d = 1) => v.toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d }).replace('-', '−');
const gainText = (g: number) => `${g > 0 ? '+' : ''}${num(g)} dB`;

/**
 * Eight draggable EQ points over the song's long-term spectrum. Drag a point
 * for frequency and gain, scroll on it for Q, or use the arrow keys.
 */
export function EqCurve({
  bands,
  selected,
  onSelect,
  onChange,
  ltas,
}: {
  bands: EqBand[];
  selected: number;
  onSelect: (i: number) => void;
  onChange: (i: number, patch: Partial<EqBand>) => void;
  ltas?: Authenticity | null;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(300);
  const drag = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => setW(Math.max(160, el.clientWidth));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotH = H - TOP - BOTTOM;
  const xOf = (f: number) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * w;
  const fOf = (x: number) => F_MIN * Math.pow(F_MAX / F_MIN, Math.min(1, Math.max(0, x / w)));
  const yOf = (db: number) => TOP + ((RANGE - db) / (2 * RANGE)) * plotH;
  const dbOf = (y: number) => RANGE - ((y - TOP) / plotH) * 2 * RANGE;

  const curve = useMemo(() => response(bands), [bands]);
  const path = useMemo(() => {
    let d = '';
    for (let k = 0; k < N; k++) {
      const y = Math.min(H - BOTTOM, Math.max(TOP, yOf(curve[k])));
      d += `${k ? 'L' : 'M'}${xOf(FREQS[k]).toFixed(1)} ${y.toFixed(1)}`;
    }
    return d;
    // xOf / yOf only change with w.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curve, w]);

  // The song's own spectrum, scaled into the lower part of the plot as a backdrop.
  const ghost = useMemo(() => {
    if (!ltas || ltas.ltasFreqs.length < 2) return '';
    let hi = -Infinity;
    ltas.ltasFreqs.forEach((f, i) => {
      if (f >= F_MIN && f <= F_MAX) hi = Math.max(hi, ltas.ltasDb[i]);
    });
    if (!Number.isFinite(hi)) return '';
    const base = H - BOTTOM;
    let d = '';
    let lastX = 0;
    ltas.ltasFreqs.forEach((f, i) => {
      if (f < F_MIN || f > F_MAX) return;
      const x = xOf(f);
      const rel = Math.max(0, 1 + (ltas.ltasDb[i] - hi) / 60);
      d += `${d ? 'L' : `M${x.toFixed(1)} ${base}L`}${x.toFixed(1)} ${(base - rel * plotH * 0.72).toFixed(1)}`;
      lastX = x;
    });
    return d ? `${d}L${lastX.toFixed(1)} ${base}Z` : '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ltas, w]);

  const pointY = (b: EqBand) => yOf(gainless(b.type) ? 0 : b.gain);

  const locate = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const move = (i: number, x: number, y: number) => {
    const b = bands[i];
    const patch: Partial<EqBand> = { freq: roundFreq(fOf(x)) };
    if (!gainless(b.type)) patch.gain = Math.max(-12, Math.min(12, Math.round(dbOf(y) * 2) / 2));
    onChange(i, patch);
  };

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    const { x, y } = locate(e);
    let best = -1;
    let bestD = Infinity;
    bands.forEach((b, i) => {
      const d = Math.hypot(xOf(b.freq) - x, pointY(b) - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best < 0) return;
    if (bestD > 26) {
      // Away from every point: pick the band nearest in frequency, without moving it.
      let near = 0;
      bands.forEach((b, i) => {
        if (Math.abs(xOf(b.freq) - x) < Math.abs(xOf(bands[near].freq) - x)) near = i;
      });
      onSelect(near);
      return;
    }
    onSelect(best);
    drag.current = best;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (drag.current === null) return;
    const { x, y } = locate(e);
    move(drag.current, x, y);
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  // Scroll changes the Q of the selected band (non-passive, so the panel stays put).
  const svg = useRef<SVGSVGElement>(null);
  const latest = useRef({ bands, selected, onChange });
  latest.current = { bands, selected, onChange };
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const { bands: bs, selected: i, onChange: change } = latest.current;
      const b = bs[i];
      if (!b || !usesQ(b.type)) return;
      e.preventDefault();
      const q = b.q * Math.pow(1.12, -Math.sign(e.deltaY));
      change(i, { q: Math.round(Math.min(12, Math.max(0.3, q)) * 100) / 100 });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onKey = (i: number) => (e: KeyboardEvent<SVGCircleElement>) => {
    const b = bands[i];
    const semis = e.shiftKey ? 12 : 1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      onChange(i, { freq: roundFreq(b.freq * Math.pow(2, (dir * semis) / 12)) });
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !gainless(b.type)) {
      const step = e.shiftKey ? 3 : 0.5;
      onChange(i, { gain: Math.max(-12, Math.min(12, b.gain + (e.key === 'ArrowUp' ? step : -step))) });
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const sel = bands[selected];
  return (
    <div className="eq-curve" ref={wrap}>
      <svg
        ref={svg}
        width={w}
        height={H}
        viewBox={`0 0 ${w} ${H}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="group"
        aria-label="Kurva EQ: seret titik untuk mengatur frekuensi dan gain, scroll untuk Q"
      >
        {ghost && <path d={ghost} className="eq-ghost" />}
        {[-12, -6, 6, 12].map((db) => (
          <line key={db} x1={0} x2={w} y1={yOf(db)} y2={yOf(db)} className="eq-grid" />
        ))}
        <line x1={0} x2={w} y1={yOf(0)} y2={yOf(0)} className="eq-grid zero" />
        {[50, 100, 200, 500, 1000, 2000, 5000, 10000].map((f) => (
          <g key={f}>
            <line x1={xOf(f)} x2={xOf(f)} y1={TOP} y2={H - BOTTOM} className={f === 1000 ? 'eq-grid zero' : 'eq-grid'} />
            <text x={xOf(f)} y={H - 4} className="eq-label">
              {f >= 1000 ? `${f / 1000}k` : f}
            </text>
          </g>
        ))}
        <text x={4} y={yOf(12) - 3} className="eq-label start">
          +12
        </text>
        <text x={4} y={yOf(-12) - 3} className="eq-label start">
          −12
        </text>
        <path d={path} className="eq-line" />
        {bands.map((b, i) => (
          <g key={i} className={i === selected ? 'eq-pt on' : 'eq-pt'}>
            <circle
              cx={xOf(b.freq)}
              cy={pointY(b)}
              r={i === selected ? 8 : 6.5}
              tabIndex={0}
              role="slider"
              aria-label={`Band ${i + 1}`}
              aria-valuetext={`${formatHz(b.freq)}${gainless(b.type) ? '' : `, ${gainText(b.gain)}`}`}
              aria-valuenow={Math.round(b.freq)}
              aria-valuemin={F_MIN}
              aria-valuemax={F_MAX}
              onFocus={() => onSelect(i)}
              onKeyDown={onKey(i)}
            />
            <text x={xOf(b.freq)} y={pointY(b) + 3.5} className="eq-num" aria-hidden="true">
              {i + 1}
            </text>
          </g>
        ))}
      </svg>
      {sel && (
        <p className="eq-readout" aria-live="polite">
          Band {selected + 1} · {formatHz(sel.freq)}
          {!gainless(sel.type) && ` · ${gainText(sel.gain)}`}
          {usesQ(sel.type) && ` · Q ${num(sel.q, 2)}`}
        </p>
      )}
    </div>
  );
}
