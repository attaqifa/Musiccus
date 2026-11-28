import { useRef, useState, type PointerEvent } from 'react';
import { engine } from '../../audio/engine';
import { formatTime } from '../../lib/format';
import { stemGain } from '../../stems/mixer';
import { getStems } from '../../stems/manager';
import { useStems } from '../../stems/store';
import { ENV_RATE, STEM_LABEL, STEMS } from '../../stems/types';
import { seek } from '../../store/controller';
import { setUi, usePlayer } from '../../store/player';
import { useHubCanvas } from '../hooks';
import { C, MONO, STEM_COLOR } from '../palette';

const LABEL_W = 74;

/** Four lanes, one per stem: where each instrument plays across the whole song. */
function Lanes({ trackId }: { trackId: string }) {
  const layer = useRef<HTMLCanvasElement | null>(null);
  const layerKey = useRef('');
  const hoverX = useRef<number | null>(null);
  const [tip, setTip] = useState<{ x: number; text: string } | null>(null);

  const canvas = useHubCanvas((ctx, w, h) => {
    const l = getStems(trackId);
    if (!l) return;
    const dpr = ctx.getTransform().a;
    const mix = useStems.getState().mix;
    const gains = STEMS.map((id) => stemGain(mix, id)).join(',');
    const key = `${w}x${h}@${dpr}:${gains}:${l.length}`;
    if (!layer.current) layer.current = document.createElement('canvas');
    const lc0 = layer.current;
    const laneH = h / 4;
    const plotW = w - LABEL_W;
    if (layerKey.current !== key) {
      lc0.width = Math.round(w * dpr);
      lc0.height = Math.round(h * dpr);
      const lc = lc0.getContext('2d')!;
      lc.setTransform(dpr, 0, 0, dpr, 0, 0);
      lc.clearRect(0, 0, w, h);
      STEMS.forEach((id, k) => {
        const env = l.levels[k];
        const y0 = k * laneH;
        const mid = y0 + laneH / 2;
        const audible = stemGain(mix, id) > 0;
        lc.fillStyle = STEM_COLOR[id] + (audible ? 'c8' : '2e');
        const per = env.length / plotW;
        for (let x = 0; x < plotW; x++) {
          let peak = 0;
          const a = Math.floor(x * per);
          const b = Math.max(a + 1, Math.floor((x + 1) * per));
          for (let i = a; i < b && i < env.length; i++) if (env[i] > peak) peak = env[i];
          const amp = Math.pow(peak / 255, 2.2) * (laneH / 2 - 4);
          if (amp > 0.3) lc.fillRect(LABEL_W + x, mid - amp, 1, amp * 2);
        }
        lc.fillStyle = audible ? C.ink2 : C.ink4;
        lc.font = `500 11px ${MONO}`;
        lc.textBaseline = 'middle';
        lc.textAlign = 'left';
        lc.fillText(STEM_LABEL[id], 22, mid + 1);
        lc.fillStyle = STEM_COLOR[id];
        lc.globalAlpha = audible ? 1 : 0.35;
        lc.beginPath();
        lc.arc(11, mid, 4, 0, Math.PI * 2);
        lc.fill();
        lc.globalAlpha = 1;
        if (k > 0) {
          lc.fillStyle = C.grid;
          lc.fillRect(0, y0, w, 1);
        }
      });
      layerKey.current = key;
    }
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(lc0, 0, 0, w, h);
    const dur = l.length / l.rate;
    const t = engine.position()?.time ?? 0;
    const x = LABEL_W + (t / dur) * plotW;
    ctx.fillStyle = 'rgba(11,12,13,0.38)';
    ctx.fillRect(x, 0, w - x, h);
    ctx.fillStyle = C.ink;
    ctx.fillRect(Math.round(x) - 1, 0, 2, h);
    if (hoverX.current !== null && hoverX.current >= LABEL_W) {
      ctx.fillStyle = 'rgba(236,234,230,0.4)';
      ctx.fillRect(Math.round(hoverX.current), 0, 1, h);
    }
  });

  const timeAt = (e: { currentTarget: HTMLDivElement; clientX: number }) => {
    const r = e.currentTarget.getBoundingClientRect();
    const l = getStems(trackId);
    const x = Math.max(LABEL_W, Math.min(r.width, e.clientX - r.left));
    const dur = l ? l.length / l.rate : 0;
    return { x, t: ((x - LABEL_W) / Math.max(1, r.width - LABEL_W)) * dur };
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const { x, t } = timeAt(e);
    hoverX.current = x;
    const l = getStems(trackId);
    const f = Math.floor(t * ENV_RATE);
    const loud = l ? STEMS.filter((_, k) => (l.levels[k][f] ?? 0) > 150).map((id) => STEM_LABEL[id]) : [];
    setTip({ x, text: [formatTime(t), loud.length ? loud.join(', ') : 'tenang'].join(' · ') });
  };

  return (
    <div
      className="lanes-canvas"
      onPointerMove={onMove}
      onPointerLeave={() => {
        hoverX.current = null;
        setTip(null);
      }}
      onClick={(e) => seek(timeAt(e).t)}
    >
      <canvas ref={canvas} role="img" aria-label="Lajur stem: kapan vokal, drum, bass, dan instrumen lain berbunyi sepanjang lagu. Klik untuk melompat." />
      {tip && (
        <span className="ws-tip" style={{ left: tip.x, bottom: 'auto', top: -26 }}>
          {tip.text}
        </span>
      )}
    </div>
  );
}

export function StemLanes() {
  const nowId = usePlayer((s) => s.now?.trackId);
  const status = useStems((s) => (nowId ? s.status[nowId] : undefined));
  const panelOpen = usePlayer((s) => s.ui.inspector);
  if (!nowId) return null;
  const busy = status?.state === 'running' || status?.state === 'queued';
  const ready = status?.state === 'ready' && !!getStems(nowId);
  // Not separated yet: the panel already explains and holds the button, so the
  // stage stays clear. With the panel closed, one small prompt points to it.
  if (!ready && !busy) {
    if (panelOpen) return null;
    return (
      <div className="stem-hint panel">
        <span>Lagu ini belum dipisahkan.</span>
        <button className="btn small" onClick={() => setUi({ inspector: true })}>
          Pisahkan
        </button>
      </div>
    );
  }
  return (
    <section className="stem-lanes panel" aria-label="Lajur stem">
      {ready ? (
        <Lanes trackId={nowId} />
      ) : (
        status && (
          <div className="lanes-empty">
            <p className="lanes-title">{status.stage}</p>
            <div className="lanes-bar" role="progressbar" aria-valuenow={Math.round(status.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <i style={{ width: `${Math.max(2, status.progress * 100)}%` }} />
            </div>
          </div>
        )
      )}
    </section>
  );
}
