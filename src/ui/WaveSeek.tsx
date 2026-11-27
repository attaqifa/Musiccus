import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { engine } from '../audio/engine';
import { formatTime } from '../lib/format';
import { seek, seekBy } from '../store/controller';
import { usePlayer } from '../store/player';
import { useDragPointer, useHubCanvas } from './hooks';
import { C, signalA } from './palette';

/** Waveform overview doubling as the seek bar. */
export function WaveSeek() {
  const peaks = usePlayer((s) => s.now?.peaks ?? null);
  const duration = usePlayer((s) => s.now?.duration ?? 0);
  const peaksRef = useRef(peaks);
  peaksRef.current = peaks;
  const hoverX = useRef<number | null>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const grip = useDragPointer();
  const posRef = useRef(0);

  const canvas = useHubCanvas((ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const p = engine.position();
    const frac = p && p.duration > 0 ? p.time / p.duration : 0;
    posRef.current = p?.time ?? 0;
    const mid = h / 2;
    const pk = peaksRef.current;
    const playedX = frac * w;
    if (!pk) {
      ctx.fillStyle = 'rgba(236,234,230,0.12)';
      ctx.fillRect(0, mid - 1, w, 2);
      ctx.fillStyle = C.signal;
      ctx.fillRect(0, mid - 1, playedX, 2);
    } else {
      const n = pk.length / 2;
      const barW = 2;
      const gap = 1;
      const bars = Math.floor(w / (barW + gap));
      for (let b = 0; b < bars; b++) {
        const i0 = Math.floor((b / bars) * n);
        const i1 = Math.max(i0 + 1, Math.floor(((b + 1) / bars) * n));
        let lo = 0;
        let hi = 0;
        for (let i = i0; i < i1; i++) {
          if (pk[i * 2] < lo) lo = pk[i * 2];
          if (pk[i * 2 + 1] > hi) hi = pk[i * 2 + 1];
        }
        const amp = Math.max(0.02, Math.min(1, (hi - lo) / 2));
        const bh = Math.max(1.5, Math.pow(amp, 0.7) * (h - 4));
        const x = b * (barW + gap);
        const hovered = hoverX.current !== null && x <= hoverX.current && x >= playedX;
        ctx.fillStyle = x < playedX ? C.signal : hovered ? signalA(0.4) : 'rgba(236,234,230,0.18)';
        ctx.fillRect(x, mid - bh / 2, barW, bh);
      }
    }
    ctx.fillStyle = C.ink;
    ctx.fillRect(Math.round(playedX) - 1, 1, 2, h - 2);
  });

  const timeAt = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
    return { x, t: (x / r.width) * duration };
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (duration) grip.start(e);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!duration || (grip.active && !grip.owns(e))) return;
    const h = timeAt(e);
    hoverX.current = h.x;
    setHover(h);
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (grip.end(e)) seek(timeAt(e).t);
  };
  const clearHover = () => {
    hoverX.current = null;
    setHover(null);
  };
  // A cancelled gesture (the page scrolled instead) does not seek.
  const onCancel = (e: PointerEvent<HTMLDivElement>) => {
    if (grip.end(e)) clearHover();
  };
  const onLeave = () => {
    if (!grip.active) clearHover();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight') seekBy(e.shiftKey ? 30 : 5);
    else if (e.key === 'ArrowLeft') seekBy(e.shiftKey ? -30 : -5);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      className="waveseek"
      role="slider"
      tabIndex={duration ? 0 : -1}
      aria-label="Posisi lagu"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(posRef.current)}
      aria-valuetext={formatTime(posRef.current)}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
      onLostPointerCapture={onCancel}
      onPointerLeave={onLeave}
      onKeyDown={onKey}
    >
      <canvas ref={canvas} />
      {hover && duration > 0 && (
        <span className="ws-tip" style={{ left: hover.x }}>
          {formatTime(hover.t)}
        </span>
      )}
    </div>
  );
}
