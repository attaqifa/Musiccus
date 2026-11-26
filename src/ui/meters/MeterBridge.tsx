import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { MeterMsg } from '../../audio/engine';
import { loadJSON, saveJSON } from '../../lib/storage';
import { setSettings, usePlayer } from '../../store/player';
import { cls, useHub, useHubCanvas } from '../hooks';
import { C, MONO, signalA } from '../palette';
import { Term } from '../Tip';
import { Goniometer } from './Goniometer';
import { Spectrum } from './Spectrum';

const toDb = (lin: number) => (lin > 1e-9 ? 20 * Math.log10(lin) : -Infinity);
const num = (v: number, d = 1) => (Number.isFinite(v) ? v.toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d }).replace('-', '−') : '—');

const FLOOR = -60;
const MARKS = [0, -6, -12, -18, -24, -36, -48];
/** True peak above this is called out: it can clip in a DAC or a lossy encoder. */
const TP_WARN = -1;

/**
 * Peak and RMS per channel, with peak hold and a clip lamp that latches when
 * the true peak crosses 0 dBFS.
 */
function LevelMeter() {
  const st = useRef({ pk: [FLOOR, FLOOR], rms: [FLOOR, FLOOR], hold: [FLOOR, FLOOR], holdT: [0, 0], clipT: [-99, -99] });
  const canvas = useHubCanvas((ctx, w, h, s) => {
    const m = s.playing ? s.meter : null;
    const S = st.current;
    const dt = Math.max(0.001, s.dt);
    const pk = m ? [toDb(m.pkL), toDb(m.pkR)] : [FLOOR, FLOOR];
    const rms = m ? [10 * Math.log10(m.msL + 1e-12), 10 * Math.log10(m.msR + 1e-12)] : [FLOOR, FLOOR];
    const tp = m ? [toDb(m.tpL), toDb(m.tpR)] : [FLOOR, FLOOR];
    for (const c of [0, 1]) {
      // PPM-style: instant rise, 20 dB/s fall. RMS rides a 300 ms average.
      S.pk[c] = Math.max(pk[c], S.pk[c] - 20 * dt, FLOOR);
      S.rms[c] += (Math.max(FLOOR, rms[c]) - S.rms[c]) * (1 - Math.exp(-dt / 0.3));
      if (pk[c] >= S.hold[c] || s.now - S.holdT[c] > 1.6) {
        if (pk[c] >= S.hold[c]) S.holdT[c] = s.now;
        S.hold[c] = Math.max(pk[c], S.hold[c] - 14 * dt, FLOOR);
      }
      if (tp[c] > 0) S.clipT[c] = s.now;
    }

    ctx.clearRect(0, 0, w, h);
    const top = 14;
    const bottom = h - 26;
    const plotH = bottom - top;
    const yOf = (db: number) => top + (Math.min(0, Math.max(FLOOR, db)) / FLOOR) * plotH;
    const scaleW = 20;
    const gap = 10;
    const barW = Math.max(8, Math.min(16, (w - scaleW - gap - 4) / 2));
    const x0 = scaleW + Math.max(2, (w - scaleW - barW * 2 - gap) / 2);

    ctx.font = `500 9px ${MONO}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const db of MARKS) {
      const y = Math.round(yOf(db)) + 0.5;
      ctx.fillStyle = C.ink4;
      ctx.fillText(db === 0 ? '0' : String(-db), scaleW - 4, y);
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      ctx.moveTo(scaleW, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    for (const c of [0, 1]) {
      const x = x0 + c * (barW + gap);
      ctx.fillStyle = 'rgba(236,234,230,0.05)';
      ctx.fillRect(x, top, barW, plotH);
      // Peak behind, RMS in front: the gap between them is the crest factor.
      const yp = yOf(S.pk[c]);
      ctx.fillStyle = signalA(0.28);
      ctx.fillRect(x, yp, barW, bottom - yp);
      const yr = yOf(S.rms[c]);
      ctx.fillStyle = signalA(0.85);
      ctx.fillRect(x + 2, yr, barW - 4, bottom - yr);
      // The last dB before full scale.
      const yw = yOf(TP_WARN);
      if (yp < yw) {
        ctx.fillStyle = C.danger;
        ctx.fillRect(x, yp, barW, yw - yp);
      }
      const yh = Math.round(yOf(S.hold[c])) + 0.5;
      ctx.strokeStyle = S.hold[c] > TP_WARN ? C.danger : C.ink;
      ctx.beginPath();
      ctx.moveTo(x, yh);
      ctx.lineTo(x + barW, yh);
      ctx.stroke();
      // Clip lamp, latched for two seconds.
      const lit = s.now - S.clipT[c] < 2;
      ctx.fillStyle = lit ? C.danger : 'rgba(236,234,230,0.08)';
      ctx.fillRect(x, 2, barW, 7);
      ctx.fillStyle = C.ink3;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(c ? 'R' : 'L', x + barW / 2, bottom + 11);
      ctx.fillStyle = S.hold[c] > TP_WARN ? C.danger : C.ink2;
      ctx.fillText(S.hold[c] <= FLOOR ? '−∞' : num(S.hold[c]), x + barW / 2, h - 2);
      ctx.textBaseline = 'middle';
    }
  });
  return (
    <canvas
      ref={canvas}
      className="meter-canvas"
      role="img"
      aria-label="Meter level kiri dan kanan"
      data-tip="Batang terang: RMS (rata-rata). Batang redup: peak. Garis: peak tertinggi barusan. Lampu atas menyala merah saat true peak melewati 0 dBFS."
    />
  );
}

const HISTORY_S = 60;
const HISTORY_N = 300;

/** Momentary, short-term and integrated loudness (EBU R128), with a minute of history. */
function Loudness() {
  const refs = useRef<Record<string, HTMLElement | null>>({});
  const hist = useRef({ buf: new Float32Array(HISTORY_N).fill(-Infinity), head: 0, acc: 0 });
  const trackId = usePlayer((s) => s.now?.trackId);
  useEffect(() => {
    hist.current.buf.fill(-Infinity);
  }, [trackId]);

  const set = (k: string, text: string, hot = false) => {
    const el = refs.current[k];
    if (!el) return;
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle('hot', hot);
  };

  useHub((s) => {
    const m: MeterMsg | null = s.playing ? s.meter : null;
    set('m', m ? num(m.m) : '—');
    set('s', m ? num(m.s) : '—');
    set('i', m ? num(m.i) : '—');
    const tp = m ? toDb(m.tpMax) : -Infinity;
    set('tp', m ? num(tp) : '—', tp > TP_WARN);
    set('plr', m && Number.isFinite(m.i) && Number.isFinite(tp) ? num(tp - m.i) : '—');
    const H = hist.current;
    H.acc += s.dt;
    if (H.acc >= HISTORY_S / HISTORY_N) {
      H.acc = 0;
      H.head = (H.head + 1) % HISTORY_N;
      H.buf[H.head] = m && s.playing ? m.s : -Infinity;
    }
  });

  const canvas = useHubCanvas((ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const lo = -36;
    const hi = -4;
    const yOf = (v: number) => ((hi - Math.min(hi, Math.max(lo, v))) / (hi - lo)) * (h - 2) + 1;
    ctx.font = `500 9px ${MONO}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const [v, label] of [[-14, '−14 streaming'], [-23, '−23 siaran']] as const) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.strokeStyle = C.gridStrong;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C.ink4;
      ctx.fillText(label, 2, y - 6);
    }
    const H = hist.current;
    ctx.beginPath();
    let pen = false;
    for (let j = 0; j < HISTORY_N; j++) {
      const v = H.buf[(H.head + 1 + j) % HISTORY_N];
      const x = (j / (HISTORY_N - 1)) * w;
      if (!Number.isFinite(v)) {
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(x, yOf(v));
      else ctx.moveTo(x, yOf(v));
      pen = true;
    }
    ctx.strokeStyle = C.signal;
    ctx.lineWidth = 1.3;
    ctx.stroke();
  });

  const cell = (k: string, label: string, unit: string, tip: string) => (
    <div className="readout">
      <Term className="readout-label" tip={tip}>
        {label}
      </Term>
      <span className="readout-value">
        <span ref={(el) => void (refs.current[k] = el)}>—</span>
        <small>{unit}</small>
      </span>
    </div>
  );

  return (
    <div className="loudness">
      <div className="readouts">
        {cell('m', 'M', 'LUFS', 'Momentary: seberapa keras suaranya saat ini, dari 400 ms terakhir.')}
        {cell('s', 'S', 'LUFS', 'Short-term: seberapa keras 3 detik terakhir. Garis di bawah adalah riwayatnya.')}
        {cell('i', 'I', 'LUFS', 'Integrated: kerasnya rata-rata sejak lagu mulai (EBU R128, dengan gating). Layanan streaming umumnya menyamakan lagu di sekitar −14.')}
        {cell('tp', 'TP', 'dBTP', 'True peak: puncak tertinggi sejak lagu mulai, termasuk di antara sampel. Di atas −1 bisa clipping saat dikonversi.')}
        {cell('plr', 'PLR', 'LU', 'Peak-to-loudness ratio: jarak puncak dengan kerasnya rata-rata. Makin kecil, makin padat masternya.')}
      </div>
      <canvas ref={canvas} className="meter-canvas lhist" role="img" aria-label="Riwayat loudness short-term satu menit" />
    </div>
  );
}

type Tab = 'level' | 'loud' | 'spec' | 'stereo';
const TABS: { id: Tab; label: string }[] = [
  { id: 'level', label: 'Level' },
  { id: 'loud', label: 'Loudness' },
  { id: 'spec', label: 'Spektrum' },
  { id: 'stereo', label: 'Stereo' },
];
const TAB_KEY = 'musiccus:meter-tab';

/**
 * The meter bridge under the stage. It reads the signal after the rack and
 * before the volume, so it shows the song as Musiccus makes it, not how loud
 * the listener turned it. On narrow screens one meter shows at a time.
 */
export function MeterBridge() {
  const [tab, setTab] = useState<Tab>(() => loadJSON<{ tab: Tab }>(TAB_KEY, { tab: 'spec' }).tab);
  const [compare, setCompare] = useState(false);
  const pick = (t: Tab) => {
    setTab(t);
    saveJSON(TAB_KEY, { tab: t });
  };
  return (
    <section className="meters panel" aria-label="Pantau">
      <div className="mt-tabs" role="tablist" aria-label="Meter">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={cls(tab === t.id && 'on')} onClick={() => pick(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <button className="icon-btn mt-close" onClick={() => setSettings({ meters: false })} aria-label="Tutup Pantau" data-tip="Tutup Pantau" data-kbd="O">
        <X size={14} aria-hidden="true" />
      </button>
      <div className="mt-grid">
        <div className={cls('mt-cell mt-level', tab === 'level' && 'sel')}>
          <h5>Level</h5>
          <LevelMeter />
        </div>
        <div className={cls('mt-cell mt-loud', tab === 'loud' && 'sel')}>
          <h5>Loudness</h5>
          <Loudness />
        </div>
        <div className={cls('mt-cell mt-spec', tab === 'spec' && 'sel')}>
          <h5>
            Spektrum
            {compare && (
              <span className="mt-legend" data-tip="Garis putus-putus: lagu sebelum racikan. Area berwarna: hasil yang Anda dengar.">
                <i className="solid" aria-hidden="true" />
                hasil
                <i className="dash" aria-hidden="true" />
                asli
              </span>
            )}
          </h5>
          <Spectrum onCompareChange={setCompare} />
        </div>
        <div className={cls('mt-cell mt-stereo', tab === 'stereo' && 'sel')}>
          <h5>Stereo</h5>
          <Goniometer />
        </div>
      </div>
    </section>
  );
}
