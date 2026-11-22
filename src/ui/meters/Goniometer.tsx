import { useRef } from 'react';
import { SCOPE_N } from '../../audio/hub';
import { useHubCanvas } from '../hooks';
import { C, keyCss, MONO } from '../palette';

/**
 * Goniometer (vectorscope): mid on the vertical axis, side on the horizontal.
 * A vertical line is mono, a round cloud is wide stereo, a horizontal smear
 * means phase problems. The bar below is the L/R correlation.
 */
export function Goniometer() {
  const gain = useRef(1);
  const corr = useRef(0);
  const trail = useRef<HTMLCanvasElement | null>(null);

  const canvas = useHubCanvas((ctx, w, h, s) => {
    const barH = 24;
    const size = Math.max(10, Math.min(w, h - barH));
    const ox = (w - size) / 2;
    const cx = ox + size / 2;
    const cy = size / 2;
    const r = size / 2 - 4;

    // Phosphor persistence lives on an offscreen layer that fades each frame.
    let t = trail.current;
    const dpr = ctx.getTransform().a;
    const pw = Math.round(size * dpr);
    if (!t || t.width !== pw) {
      t = document.createElement('canvas');
      t.width = t.height = pw;
      trail.current = t;
    }
    const tc = t.getContext('2d')!;
    tc.setTransform(dpr, 0, 0, dpr, 0, 0);
    tc.globalCompositeOperation = 'destination-out';
    tc.fillStyle = `rgba(0,0,0,${Math.min(1, s.dt * 9)})`;
    tc.fillRect(0, 0, size, size);
    tc.globalCompositeOperation = 'lighter';

    const L = s.scopeL;
    const R = s.scopeR;
    let peak = 0;
    for (let i = 0; i < SCOPE_N; i++) {
      const a = Math.abs(L[i]) + Math.abs(R[i]);
      if (a > peak) peak = a;
    }
    // Auto-gain, so a quiet song still fills the scope.
    const target = peak > 0.003 ? 0.9 / peak : gain.current;
    gain.current += (Math.min(12, target) - gain.current) * (target < gain.current ? 0.3 : 0.02);
    const k = gain.current * r * Math.SQRT1_2;
    tc.fillStyle = keyCss(0.6);
    const half = size / 2;
    if (s.playing) {
      for (let i = 0; i < SCOPE_N; i++) {
        tc.fillRect(half + (L[i] - R[i]) * k, half - (L[i] + R[i]) * k, 1.1, 1.1);
      }
    }

    ctx.clearRect(0, 0, w, h);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = C.face;
    ctx.fill();
    ctx.strokeStyle = C.faceEdge;
    ctx.stroke();
    ctx.strokeStyle = C.grid;
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx, cy + r);
    ctx.moveTo(cx - r, cy);
    ctx.lineTo(cx + r, cy);
    const d = r * Math.SQRT1_2;
    ctx.moveTo(cx - d, cy - d);
    ctx.lineTo(cx + d, cy + d);
    ctx.moveTo(cx + d, cy - d);
    ctx.lineTo(cx - d, cy + d);
    ctx.stroke();
    ctx.drawImage(t, ox, 0, size, size);

    ctx.font = `500 9.5px ${MONO}`;
    ctx.fillStyle = C.ink3;
    ctx.textAlign = 'center';
    ctx.fillText('M', cx, 10);
    ctx.fillText('L', cx - d - 5, cy - d);
    ctx.fillText('R', cx + d + 5, cy - d);

    const mc = s.meter && s.playing ? s.meter.corr : 0;
    corr.current += (mc - corr.current) * (1 - Math.exp(-s.dt / 0.15));
    const by = h - barH + 6;
    const bx = 18;
    const bw = w - 36;
    ctx.fillStyle = 'rgba(236,234,230,0.06)';
    ctx.fillRect(bx, by, bw, 5);
    ctx.fillStyle = 'rgba(224,97,74,0.3)';
    ctx.fillRect(bx, by, bw / 2, 5);
    const px = bx + ((corr.current + 1) / 2) * bw;
    ctx.fillStyle = corr.current < 0 ? C.danger : C.signal;
    ctx.fillRect(px - 1.5, by - 3, 3, 11);
    ctx.fillStyle = C.ink3;
    ctx.textAlign = 'left';
    ctx.fillText('−1', 0, by + 5);
    ctx.textAlign = 'right';
    ctx.fillText('+1', w, by + 5);
    ctx.textAlign = 'center';
    ctx.fillStyle = corr.current < 0 ? C.danger : C.ink2;
    ctx.fillText(`korelasi ${corr.current.toFixed(2).replace('.', ',').replace('-', '−')}`, w / 2, h - 1);
  });

  return <canvas ref={canvas} className="meter-canvas" role="img" aria-label="Goniometer stereo dan meter korelasi" />;
}
