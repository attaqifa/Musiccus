import { Maximize2, Minimize2 } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { useSpectrogram, type Spectrogram } from '../../analysis/spectrogram';
import type { Analysis, Authenticity, Mastering, Verdict } from '../../analysis/types';
import { engine } from '../../audio/engine';
import { formatHz, formatTime } from '../../lib/format';
import { seek } from '../../store/controller';
import { cls, cssVar, useHub } from '../hooks';
import { C, MONO, signalA } from '../palette';

type Tone = 'good' | 'ok' | 'warn';

const VERDICT: Record<Verdict, { label: string; tone: Tone }> = {
  genuine: { label: 'Asli', tone: 'good' },
  'lossy-transcode': { label: 'Dicurigai transcode', tone: 'warn' },
  upsampled: { label: 'Dicurigai upsample', tone: 'warn' },
  'padded-bits': { label: 'Bit di-pad', tone: 'warn' },
  lossy: { label: 'Lossy', tone: 'ok' },
  inconclusive: { label: 'Belum bisa dinilai', tone: 'ok' },
};

const num = (v: number, d = 1) => (Number.isFinite(v) ? v.toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d }).replace('-', '−') : '—');

/** A static HiDPI canvas, redrawn on resize and when `deps` change. */
function useStaticCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, deps: unknown[]) {
  const ref = useRef<HTMLCanvasElement>(null);
  const fn = useRef(draw);
  fn.current = draw;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const paint = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (!w || !h) return;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fn.current(ctx, w, h);
    };
    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(c);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

/** Long-term average spectrum with the detected cutoff marked. */
function LtasPlot({ a }: { a: Authenticity }) {
  const ref = useStaticCanvas(
    (ctx, w, h) => {
      if (a.ltasFreqs.length < 2) return;
      const fMin = a.ltasFreqs[0];
      const fMax = a.ltasFreqs[a.ltasFreqs.length - 1];
      const xOf = (f: number) => (Math.log(f / fMin) / Math.log(fMax / fMin)) * w;
      let hi = -Infinity;
      for (const v of a.ltasDb) hi = Math.max(hi, v);
      const lo = hi - 110;
      const base = h - 12;
      const yOf = (v: number) => Math.min(base, 4 + ((hi - v) / (hi - lo)) * (base - 4));
      ctx.font = `500 10px ${MONO}`;
      ctx.textAlign = 'center';
      for (const f of [100, 1000, 10000, 20000, 40000]) {
        if (f > fMax) continue;
        const x = Math.round(xOf(f)) + 0.5;
        ctx.strokeStyle = f === 20000 ? C.gridStrong : C.grid;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, base);
        ctx.stroke();
        ctx.fillStyle = C.ink3;
        ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x, h - 2);
      }
      ctx.beginPath();
      a.ltasFreqs.forEach((f, i) => {
        if (i === 0) ctx.moveTo(xOf(f), yOf(a.ltasDb[i]));
        else ctx.lineTo(xOf(f), yOf(a.ltasDb[i]));
      });
      ctx.lineTo(w, base);
      ctx.lineTo(0, base);
      ctx.closePath();
      ctx.fillStyle = signalA(0.1);
      ctx.fill();
      ctx.strokeStyle = C.ink2;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      if (a.cutoffHz) {
        const x = xOf(a.cutoffHz);
        ctx.strokeStyle = C.warn;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, base);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = C.warn;
        const right = x > w - 64;
        ctx.textAlign = right ? 'right' : 'left';
        ctx.fillText(formatHz(a.cutoffHz), x + (right ? -4 : 4), 10);
      }
    },
    [a],
  );
  return <canvas ref={ref} className="meter-canvas ltas" role="img" aria-label="Spektrum rata-rata seluruh lagu" />;
}

/** `compact`: the verdict is already shown above, so only the evidence remains. */
function AuthenticityCard({ a, compact }: { a: Authenticity; compact?: boolean }) {
  // Inconclusive with a cutoff: a cut where encoders and masters both cut.
  const v = a.verdict === 'inconclusive' && a.cutoffHz ? { label: 'Belum pasti', tone: 'ok' as Tone } : VERDICT[a.verdict];
  return (
    <div className="rec-block">
      <div className="rec-head">
        <h4>{compact ? 'Spektrum rata-rata' : 'Tes keaslian'}</h4>
        {!compact && <span className={cls('auth-badge', `tone-${v.tone}`)}>{v.label}</span>}
      </div>
      {!compact && <p className="auth-summary">{a.summary}</p>}
      <LtasPlot a={a} />
      {a.details.length > 0 && (
        <ul className="auth-details">
          {a.details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Black, through the song's key colour, to near white: one hue, read as intensity. */
function ramp(keyRgb: string): Uint8ClampedArray {
  const [kr, kg, kb] = (keyRgb.trim() || '249 149 73').split(/\s+/).map(Number);
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let r: number;
    let g: number;
    let b: number;
    if (t < 0.65) {
      const u = Math.pow(t / 0.65, 1.4);
      r = 12 + (kr * 0.85 - 12) * u;
      g = 13 + (kg * 0.85 - 13) * u;
      b = 15 + (kb * 0.85 - 15) * u;
    } else {
      const u = (t - 0.65) / 0.35;
      r = kr * 0.85 + (250 - kr * 0.85) * u;
      g = kg * 0.85 + (248 - kg * 0.85) * u;
      b = kb * 0.85 + (240 - kb * 0.85) * u;
    }
    lut[i * 3] = r;
    lut[i * 3 + 1] = g;
    lut[i * 3 + 2] = b;
  }
  return lut;
}

const AXIS = 26;
const FOOT = 14;

function SpectrogramPlot({ s, cutoffHz }: { s: Spectrogram; cutoffHz: number | null }) {
  const image = useRef<{ s: Spectrogram; key: string; canvas: HTMLCanvasElement } | null>(null);
  const head = useRef<HTMLElement>(null);
  const [hover, setHover] = useState<{ x: number; text: string } | null>(null);

  useHub(() => {
    const el = head.current;
    if (!el) return;
    const p = engine.position();
    if (p === null || !(s.duration > 0)) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    el.style.left = `calc(${AXIS}px + (100% - ${AXIS}px) * ${Math.min(1, Math.max(0, p.time / s.duration))})`;
  });

  const ref = useStaticCanvas(
    (ctx, w, h) => {
      const key = cssVar('--key-rgb');
      if (!image.current || image.current.s !== s || image.current.key !== key) {
        const off = document.createElement('canvas');
        off.width = s.cols;
        off.height = s.rows;
        const octx = off.getContext('2d')!;
        const img = octx.createImageData(s.cols, s.rows);
        const lut = ramp(key);
        for (let c = 0; c < s.cols; c++) {
          for (let r = 0; r < s.rows; r++) {
            const v = s.data[c * s.rows + r];
            const o = ((s.rows - 1 - r) * s.cols + c) * 4;
            img.data[o] = lut[v * 3];
            img.data[o + 1] = lut[v * 3 + 1];
            img.data[o + 2] = lut[v * 3 + 2];
            img.data[o + 3] = 255;
          }
        }
        octx.putImageData(img, 0, 0);
        image.current = { s, key, canvas: off };
      }
      const pw = w - AXIS;
      const ph = h - FOOT;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(image.current.canvas, AXIS, 0, pw, ph);
      ctx.font = `500 9.5px ${MONO}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      const yOf = (f: number) => ph - (f / s.topHz) * ph;
      for (let f = 5000; f < s.topHz; f += 5000) {
        const y = Math.round(yOf(f)) + 0.5;
        ctx.fillStyle = C.ink3;
        ctx.fillText(`${f / 1000}k`, AXIS - 4, y);
        ctx.strokeStyle = 'rgba(236,234,230,0.12)';
        ctx.beginPath();
        ctx.moveTo(AXIS, y);
        ctx.lineTo(AXIS + 4, y);
        ctx.stroke();
      }
      if (cutoffHz && cutoffHz < s.topHz) {
        const y = Math.round(yOf(cutoffHz)) + 0.5;
        ctx.strokeStyle = C.warn;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(AXIS, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = C.ink3;
      ctx.textAlign = 'left';
      ctx.fillText('0:00', AXIS, h - 2);
      ctx.textAlign = 'center';
      ctx.fillText(formatTime(s.duration / 2), AXIS + pw / 2, h - 2);
      ctx.textAlign = 'right';
      ctx.fillText(formatTime(s.duration), w, h - 2);
    },
    [s, cutoffHz],
  );

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left - AXIS;
    const y = e.clientY - r.top;
    const pw = r.width - AXIS;
    const ph = r.height - FOOT;
    if (x < 0 || y > ph) return setHover(null);
    const t = (x / pw) * s.duration;
    const f = (1 - y / ph) * s.topHz;
    setHover({ x: Math.min(r.width - 56, Math.max(AXIS + 56, e.clientX - r.left)), text: `${formatTime(t)} · ${formatHz(f)}` });
  };

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left - AXIS;
    if (x < 0) return;
    seek(Math.min(1, x / (r.width - AXIS)) * s.duration);
  };

  return (
    <div className="spectro" onPointerMove={onMove} onPointerLeave={() => setHover(null)} onClick={onClick} title="Klik untuk lompat ke bagian ini">
      <canvas ref={ref} className="meter-canvas spectro-canvas" role="img" aria-label="Spektrogram seluruh lagu" />
      <i ref={head} className="spectro-head" aria-hidden="true" />
      {hover && (
        <span className="spectro-tip" style={{ left: hover.x }}>
          {hover.text}
        </span>
      )}
    </div>
  );
}

function SpectrogramCard({ trackId, a }: { trackId: string; a: Authenticity }) {
  const st = useSpectrogram(trackId);
  const [tall, setTall] = useState(false);
  return (
    <div className={cls('rec-block', tall && 'tall')}>
      <div className="rec-head">
        <h4>Spektrogram</h4>
        {st.state === 'done' && (
          <span className="rec-note">
            sampai {formatHz(st.result.topHz)}
            <button
              className="rec-icon"
              onClick={() => setTall((v) => !v)}
              aria-pressed={tall}
              aria-label={tall ? 'Perkecil spektrogram' : 'Perbesar spektrogram'}
              title={tall ? 'Perkecil' : 'Perbesar'}
            >
              {tall ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
          </span>
        )}
      </div>
      {st.state === 'done' ? (
        <>
          <SpectrogramPlot s={st.result} cutoffHz={a.cutoffHz} />
          <p className="rec-caption">
            Waktu ke kanan, frekuensi ke atas, makin terang makin keras; klik untuk lompat ke bagian itu. File lossy biasanya punya "langit-langit" datar di 16–20 kHz yang
            tidak pernah dilewati suara apa pun{a.cutoffHz ? '; garis putus-putus adalah batas yang ditemukan analisis.' : '.'}
          </p>
        </>
      ) : st.state === 'error' ? (
        <p className="empty-note">Spektrogram gagal dibuat: {st.message}</p>
      ) : (
        <div className="analysis-progress" role="status">
          <span>
            Menghitung spektrogram <b>{st.state === 'running' ? Math.round(st.progress * 100) : 0}%</b>
          </span>
          <div className="bar">
            <i style={{ width: `${Math.max(3, (st.state === 'running' ? st.progress : 0) * 100)}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

interface Metric {
  label: string;
  value: string;
  unit?: string;
  tone: Tone;
  note: string;
}

/** The mastering numbers that have no plain sentence in "Karakter rekaman". */
function extraMetrics(m: Mastering): Metric[] {
  return [
    { label: 'LRA', value: num(m.lra), unit: 'LU', tone: m.lra >= 6 ? 'good' : m.lra >= 3 ? 'ok' : 'warn', note: 'Jarak loudness bagian pelan dan bagian keras.' },
    {
      label: 'True peak',
      value: num(m.truePeakDb),
      unit: 'dBTP',
      tone: m.truePeakDb > -0.1 ? 'warn' : m.truePeakDb > -1 ? 'ok' : 'good',
      note: m.truePeakDb > -0.1 ? 'Puncak antar-sampel melewati 0 dBFS, bisa clipping di DAC.' : 'Puncak tertinggi, termasuk di antara sampel.',
    },
    { label: 'PLR', value: num(m.plr), unit: 'LU', tone: m.plr >= 12 ? 'good' : m.plr >= 8 ? 'ok' : 'warn', note: 'Ruang antara puncak dan rata-rata. Kecil berarti padat.' },
    {
      label: 'Clipping',
      value: String(m.clipEvents),
      unit: 'kejadian',
      tone: m.clipEvents === 0 ? 'good' : m.clipEvents < 20 ? 'ok' : 'warn',
      note: m.clipEvents === 0 ? 'Tidak ada sampel yang menempel di batas digital.' : `${m.clippedSamples.toLocaleString('id-ID')} sampel menempel di 0 dBFS.`,
    },
    {
      label: 'Bit efektif',
      value: m.effectiveBits ? (m.effectiveBits === 32 ? 'float' : String(m.effectiveBits)) : '—',
      unit: m.effectiveBits && m.effectiveBits !== 32 ? 'bit' : undefined,
      tone: 'ok',
      note:
        m.effectiveBits === 32
          ? 'Sampel float, jadi tidak terikat kedalaman bit integer.'
          : m.effectiveBits
            ? 'Resolusi yang benar-benar dipakai sampel, bukan label file.'
            : 'Tidak dinilai untuk file lossy atau hasil resample.',
    },
  ];
}

export function MasteringExtras({ m }: { m: Mastering }) {
  return (
    <dl className="metrics">
      {extraMetrics(m).map((x) => (
        <div key={x.label} className={cls('metric', `tone-${x.tone}`)}>
          <dt>{x.label}</dt>
          <dd>
            {x.value}
            {x.unit && <small>{x.unit}</small>}
          </dd>
          <p>{x.note}</p>
        </div>
      ))}
    </dl>
  );
}

/**
 * The evidence behind the file-quality verdict: the long-term spectrum and
 * the whole-song spectrogram. `compact` when the verdict is already shown.
 */
export function FileEvidence({ analysis, trackId, compact }: { analysis: Analysis; trackId: string; compact?: boolean }) {
  return (
    <div className="rec-data">
      <AuthenticityCard a={analysis.authenticity} compact={compact} />
      <SpectrogramCard trackId={trackId} a={analysis.authenticity} />
    </div>
  );
}
