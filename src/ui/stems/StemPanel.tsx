import { Download, RotateCcw, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { engine } from '../../audio/engine';
import { stemGain, type StemMix } from '../../stems/mixer';
import { deleteModel, dropStems, exportStems, refreshModelStatus, separateCurrent, stemActivity, stemDb } from '../../stems/manager';
import { activePreset, applyPreset, PRESETS, resetStage, setPosition, setStage, setStrip, useStems } from '../../stems/store';
import { STEM_COLOR, STEM_LABEL, STEMS, type SeparationEngine, type StemId } from '../../stems/types';
import { useLive } from '../../live/store';
import { usePlayer } from '../../store/player';
import { cls, useHub, useHubCanvas } from '../hooks';
import { Section } from '../Section';
import { Knob } from '../Knob';
import { C, MONO } from '../palette';

const num = (v: number, d = 1) => v.toFixed(d).replace('.', ',').replace('-', '−');
const dbText = (v: number) => (v === 0 ? '0 dB' : `${v > 0 ? '+' : ''}${num(v)} dB`);
const panText = (v: number) => (Math.abs(v) < 0.01 ? 'Tengah' : `${v < 0 ? 'Kiri' : 'Kanan'} ${Math.round(Math.abs(v) * 100)}`);

const ENGINES: Record<SeparationEngine, { label: string; note: string }> = {
  ai: {
    label: 'AI · kualitas studio',
    note: 'HTDemucs (Meta, lisensi MIT) berjalan di GPU Anda lewat WebGPU. Model 126 MB diunduh sekali dari Hugging Face lalu disimpan; lagu Anda tidak pernah diunggah. Lagu 4 menit selesai dalam sekitar satu menit.',
  },
  dsp: {
    label: 'Cepat · DSP',
    note: 'Instan dan tanpa unduhan: memisahkan dengan filter median dan posisi stereo. Hasilnya kasar, cukup untuk karaoke cepat, belum untuk remix.',
  },
};

function Progress({ stage, progress }: { stage: string; progress: number }) {
  return (
    <div className="analysis-progress" role="status">
      <span>
        {stage} <b>{Math.round(progress * 100)}%</b>
      </span>
      <div className="bar">
        <i style={{ width: `${Math.max(3, progress * 100)}%` }} />
      </div>
    </div>
  );
}

function Separation({ trackId }: { trackId: string }) {
  const status = useStems((s) => s.status[trackId]);
  const choice = useStems((s) => s.engine);
  const auto = useStems((s) => s.auto);
  const modelCached = useStems((s) => s.modelCached);
  const busy = status?.state === 'running' || status?.state === 'queued';

  if (status?.state === 'ready') {
    const how = status.cached ? 'dari cache' : status.elapsedMs ? `${num(status.elapsedMs / 1000, 0)} detik` : '';
    return (
      <div className="stem-sep">
        <p className="stem-ready">
          <span className="stem-ok" aria-hidden="true" />
          Dipisahkan · {status.engine === 'ai' ? 'AI' : 'DSP'} {how && `· ${how}`}
        </p>
        <div className="stem-actions">
          <button className="btn small" onClick={exportStems} title="Unduh vokal, drum, bass, dan lainnya sebagai WAV 24-bit">
            <Download size={14} aria-hidden="true" /> Unduh stem
          </button>
          {status.engine === 'dsp' && (
            <button className="btn small" onClick={() => void separateCurrent('ai')} title="Pisahkan ulang dengan model AI">
              <Sparkles size={14} aria-hidden="true" /> Pakai AI
            </button>
          )}
          <button className="icon-btn" onClick={() => dropStems(trackId)} aria-label="Lepas stem" title="Lepas stem: kembali ke file asli">
            <X size={15} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="stem-sep">
      {busy ? (
        <>
          <Progress stage={status.stage} progress={status.progress} />
          <p className="empty-note">
            {status.engine === 'ai'
              ? 'Berjalan di GPU di sela frame, jadi musik dan visual tetap lancar. Hasilnya disimpan: lagu ini tidak perlu dipisahkan lagi.'
              : 'Memisahkan di latar belakang.'}
          </p>
        </>
      ) : (
        <>
          <div className="segmented small" role="radiogroup" aria-label="Mesin pemisah">
            {(Object.keys(ENGINES) as SeparationEngine[]).map((k) => (
              <button key={k} role="radio" aria-checked={choice === k} className={cls(choice === k && 'on')} onClick={() => useStems.setState({ engine: k })}>
                {ENGINES[k].label}
              </button>
            ))}
          </div>
          <p className="empty-note">{ENGINES[choice].note}</p>
          {status?.state === 'error' && <p className="stem-error">{status.error}</p>}
          <button className="btn primary small" onClick={() => void separateCurrent()}>
            {choice === 'ai' && modelCached === false ? 'Unduh model (126 MB) dan pisahkan' : 'Pisahkan lagu ini'}
          </button>
        </>
      )}
      <label className="fx-check" title="Lagu yang pernah dipisahkan dengan AI selalu dimuat ulang dari cache, otomatis.">
        <input type="checkbox" checked={auto} onChange={(e) => useStems.setState({ auto: e.target.checked })} />
        Pisahkan otomatis setiap lagu baru
      </label>
      {modelCached && (
        <button className="link-btn" onClick={() => void deleteModel()} title="Hapus model AI dari penyimpanan browser">
          Hapus model AI (126 MB)
        </button>
      )}
    </div>
  );
}

function Strip({ id, k, trackId, mix }: { id: StemId; k: number; trackId: string; mix: StemMix }) {
  const st = mix.strips[id];
  const audible = stemGain(mix, id) > 0;
  const meter = useRef<HTMLSpanElement>(null);
  useHub(() => {
    const el = meter.current;
    if (!el) return;
    const pos = engine.position();
    const g = stemGain(useStems.getState().mix, id);
    const db = pos && g > 0 ? stemDb(trackId, k, pos.time) + 20 * Math.log10(g) : -Infinity;
    el.style.transform = `scaleX(${Math.max(0, Math.min(1, (db + 60) / 60))})`;
  });
  return (
    <div className={cls('strip', !audible && 'off')} style={{ ['--stem' as string]: STEM_COLOR[id] }}>
      <span className="strip-name">
        <i aria-hidden="true" />
        {STEM_LABEL[id]}
      </span>
      <span className="strip-meter" aria-hidden="true">
        <span ref={meter} />
      </span>
      <div className="strip-knob">
        <Knob value={st.gainDb} min={-30} max={12} step={0.5} defaultValue={0} label={`Level ${STEM_LABEL[id]}`} format={dbText} onChange={(v) => setStrip(id, { gainDb: v })} size={32} />
        <span>{dbText(st.gainDb)}</span>
      </div>
      <div className={cls('strip-knob', mix.stage && 'disabled')} title={mix.stage ? 'Saat panggung 3D aktif, posisi diatur di panggung.' : undefined}>
        <Knob value={st.pan} min={-1} max={1} step={0.05} defaultValue={0} label={`Pan ${STEM_LABEL[id]}`} format={panText} onChange={(v) => setStrip(id, { pan: v })} size={32} />
        <span>{Math.abs(st.pan) < 0.01 ? 'C' : `${st.pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(st.pan) * 100)}`}</span>
      </div>
      <button className={cls('ms', st.mute && 'on')} aria-pressed={st.mute} onClick={() => setStrip(id, { mute: !st.mute })} title={`Mute ${STEM_LABEL[id]}`}>
        M
      </button>
      <button className={cls('ms', st.solo && 'on')} aria-pressed={st.solo} onClick={() => setStrip(id, { solo: !st.solo })} title={`Solo ${STEM_LABEL[id]}`}>
        S
      </button>
    </div>
  );
}

function Mixer({ trackId }: { trackId: string }) {
  const mix = useStems((s) => s.mix);
  const ready = useStems((s) => s.status[trackId]?.state === 'ready');
  const preset = activePreset(mix);
  return (
    <div className="stem-mixer">
      <div className="stem-presets" role="group" aria-label="Preset mixer stem">
        {PRESETS.map((p) => (
          <button key={p.id} className={cls('chip', preset === p.id && 'on')} aria-pressed={preset === p.id} onClick={() => applyPreset(p)} title={p.hint}>
            {p.label}
          </button>
        ))}
      </div>
      {!ready && <p className="empty-note">Lagu ini belum dipisahkan. Pengaturan mixer langsung berlaku begitu stemnya siap.</p>}
      <div className="strips">
        {STEMS.map((id, k) => (
          <Strip key={id} id={id} k={k} trackId={trackId} mix={mix} />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- Stage -- */

const RANGE = 4.2;

/** Words for a stage position, so the pad has a readable, accessible twin. */
function where(x: number, z: number): string {
  const d = Math.hypot(x, z);
  const ang = (Math.atan2(x, -z) * 180) / Math.PI;
  const side = Math.abs(ang) < 20 ? 'depan' : Math.abs(ang) > 160 ? 'belakang' : `${ang < 0 ? 'kiri' : 'kanan'}${Math.abs(ang) > 110 ? ' belakang' : Math.abs(ang) < 70 ? ' depan' : ''}`;
  return `${side}, ${num(d)} m`;
}

function StagePad() {
  const mix = useStems((s) => s.mix);
  const selected = useRef<StemId>('vocals');
  const drag = useRef<StemId | null>(null);
  const geom = useRef({ cx: 0, cy: 0, scale: 1 });
  const nowId = usePlayer((s) => s.now?.trackId);

  const canvas = useHubCanvas((ctx, w, h) => {
    const m = useStems.getState().mix;
    const cx = w / 2;
    const cy = h * 0.66;
    const scale = Math.min(w / (2 * RANGE), cy / RANGE);
    geom.current = { cx, cy, scale };
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = m.stage ? 1 : 0.45;

    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    for (let r = 1; r <= 4; r++) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.font = `500 10px ${MONO}`;
    ctx.fillStyle = C.ink4;
    ctx.textAlign = 'left';
    for (let r = 1; r <= 3; r++) ctx.fillText(`${r} m`, cx + 3, cy - r * scale - 3);

    // Listener, facing up the screen (-z).
    ctx.fillStyle = C.faceEdge;
    ctx.strokeStyle = C.ink3;
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 4, cy - 8);
    ctx.lineTo(cx, cy - 14);
    ctx.lineTo(cx + 4, cy - 8);
    ctx.stroke();

    const act = stemActivity(nowId, engine.position()?.time ?? 0);
    for (const id of STEMS) {
      const p = m.positions[id];
      const x = p.x;
      const z = p.z;
      const sx = cx + x * scale;
      const sy = cy + z * scale;
      const d = Math.hypot(x, z) || 1;
      const half = (p.width / 2) * scale;
      const px = (-z / d) * half;
      const py = (x / d) * half;
      const col = STEM_COLOR[id];
      const audible = stemGain(m, id) > 0;
      ctx.globalAlpha = (m.stage ? 1 : 0.45) * (audible ? 1 : 0.35);
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx - px, sy - py);
      ctx.lineTo(sx + px, sy + py);
      ctx.stroke();
      const a = act?.[id] ?? 0;
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, 22 + a * 14);
      g.addColorStop(0, col + 'cc');
      g.addColorStop(1, col + '00');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx, sy, 22 + a * 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(sx, sy, 7, 0, Math.PI * 2);
      ctx.fill();
      if (selected.current === id) {
        ctx.strokeStyle = C.signal;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sx, sy, 11, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = C.ink2;
      ctx.font = `500 11px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.fillText(STEM_LABEL[id], sx, sy - 16);
    }
    ctx.globalAlpha = 1;
  });

  const toWorld = (e: { currentTarget: HTMLCanvasElement; clientX: number; clientY: number }) => {
    const r = e.currentTarget.getBoundingClientRect();
    const { cx, cy, scale } = geom.current;
    return { x: (e.clientX - r.left - cx) / scale, z: (e.clientY - r.top - cy) / scale };
  };
  const hit = (x: number, z: number): StemId | null => {
    let best: StemId | null = null;
    let bestD = 0.45;
    for (const id of STEMS) {
      const p = useStems.getState().mix.positions[id];
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  };
  const move = (id: StemId, x: number, z: number) => {
    const d = Math.hypot(x, z);
    const k = d > RANGE ? RANGE / d : d < 0.5 ? 0.5 / Math.max(d, 1e-3) : 1;
    setPosition(id, { x: Math.round(x * k * 100) / 100, z: Math.round(z * k * 100) / 100 });
  };
  const onDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const w = toWorld(e);
    const id = hit(w.x, w.z);
    if (!id) return;
    selected.current = id;
    drag.current = id;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return;
    const w = toWorld(e);
    move(drag.current, w.x, w.z);
  };
  const onWheel = (e: WheelEvent<HTMLCanvasElement>) => {
    const w = toWorld(e);
    const id = hit(w.x, w.z) ?? selected.current;
    const p = useStems.getState().mix.positions[id];
    setPosition(id, { width: Math.max(0, Math.min(3, Math.round((p.width - Math.sign(e.deltaY) * 0.1) * 10) / 10)) });
  };
  const onKey = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const id = selected.current;
    const p = useStems.getState().mix.positions[id];
    const step = e.shiftKey ? 0.5 : 0.1;
    if (e.key === 'ArrowLeft') move(id, p.x - step, p.z);
    else if (e.key === 'ArrowRight') move(id, p.x + step, p.z);
    else if (e.key === 'ArrowUp') move(id, p.x, p.z - step);
    else if (e.key === 'ArrowDown') move(id, p.x, p.z + step);
    else if (e.key === 'Tab' && !e.shiftKey && id !== 'other') selected.current = STEMS[STEMS.indexOf(id) + 1];
    else if (e.key === 'Tab' && e.shiftKey && id !== 'vocals') selected.current = STEMS[STEMS.indexOf(id) - 1];
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="stage-pad">
      <div className="stage-pad-head">
        <label className="fx-check">
          <input type="checkbox" checked={mix.stage} onChange={(e) => setStage(e.target.checked)} />
          Aktifkan panggung 3D binaural
        </label>
        <button className="icon-btn" onClick={resetStage} aria-label="Kembalikan posisi panggung" title="Kembalikan posisi">
          <RotateCcw size={14} />
        </button>
      </div>
      <canvas
        ref={canvas}
        className="stage-canvas-pad"
        tabIndex={0}
        role="application"
        aria-label="Panggung 3D dilihat dari atas. Anda di tengah bawah, menghadap ke atas. Seret stem untuk memindahkannya; scroll untuk melebarkan. Keyboard: Tab memilih stem, panah memindahkan."
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onWheel={onWheel}
        onKeyDown={onKey}
      />
      <ul className="stage-where">
        {STEMS.map((id) => (
          <li key={id}>
            <i style={{ background: STEM_COLOR[id] }} aria-hidden="true" />
            {STEM_LABEL[id]} <span>{where(mix.positions[id].x, mix.positions[id].z)}</span>
          </li>
        ))}
      </ul>
      <p className="empty-note">
        Pakai headphone. Setiap stem diproses dengan HRTF, jadi vokal yang Anda seret ke belakang benar-benar terdengar dari belakang kepala.
      </p>
    </div>
  );
}

export function StemPanel() {
  const nowId = usePlayer((s) => s.now?.trackId);
  const live = useLive((s) => s.on);
  useEffect(() => {
    void refreshModelStatus();
  }, []);
  return (
    <aside className="inspector stem-panel panel" aria-label="Stem">
      {!nowId ? (
        <p className="empty-note pad">Putar lagu untuk memisahkannya menjadi vokal, drum, bass, dan lainnya.</p>
      ) : live ? (
        <p className="empty-note pad">
          Pemisahan stem butuh seluruh lagu sekaligus, jadi hanya tersedia untuk lagu dari file Anda sendiri. Suara dari tab tetap bisa
          diatur di Racik.
        </p>
      ) : (
        <>
          <Section id="s-sep" title="Pemisahan" hint="Pisahkan lagu menjadi vokal, drum, bass, dan lainnya.">
            <Separation trackId={nowId} />
          </Section>
          <Section id="s-mix" title="Mixer stem" hint="Level, pan, mute, dan solo per stem. Saat semua netral, jalur kembali bit-transparan.">
            <Mixer trackId={nowId} />
          </Section>
          <Section id="s-stage" title="Panggung 3D" hint="Tempatkan setiap stem di ruang di sekitar kepala Anda.">
            <StagePad />
          </Section>
        </>
      )}
    </aside>
  );
}
