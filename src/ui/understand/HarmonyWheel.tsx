import { useRef, useState, type PointerEvent } from 'react';
import { chordName, chordRole, fifthsIndex, noteName, pitchColor, rgbCss, romanNumeral, usesFlats } from '../../analysis/theory';
import type { Analysis, ChordSeg } from '../../analysis/types';
import { useHubCanvas } from '../hooks';
import { C, keyCss, MONO, SERIF } from '../palette';

const MAJOR_BY_FIFTHS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];

interface Cell {
  root: number;
  quality: 'maj' | 'min';
  angle: number;
  ring: 'outer' | 'inner';
}

/** Outer ring: major chords around the circle of fifths. Inner: their relative minors. */
function cells(): Cell[] {
  const out: Cell[] = [];
  MAJOR_BY_FIFTHS.forEach((root, i) => {
    const angle = -Math.PI / 2 + (i * Math.PI * 2) / 12;
    out.push({ root, quality: 'maj', angle, ring: 'outer' });
    out.push({ root: (root + 9) % 12, quality: 'min', angle, ring: 'inner' });
  });
  return out;
}
const CELLS = cells();

const cellOf = (c: Pick<ChordSeg, 'root' | 'quality'>) =>
  CELLS.find((x) => x.root === c.root && x.quality === c.quality) ?? CELLS[0];

export function HarmonyWheel({ analysis }: { analysis: Analysis }) {
  const trail = useRef<{ cell: Cell; t: number }[]>([]);
  const lastChord = useRef<ChordSeg | null>(null);
  const geom = useRef({ cx: 0, cy: 0, R: 0 });
  const [hover, setHover] = useState<{ x: number; y: number; cell: Cell } | null>(null);
  const key = analysis.key;
  const flats = usesFlats(key);
  const keyMajor = key.mode === 'major' ? key.tonic : (key.tonic + 3) % 12;
  const keyIdx = fifthsIndex(keyMajor);

  const canvas = useHubCanvas((ctx, w, h, s) => {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) / 2 - 6;
    geom.current = { cx, cy, R };
    const rOuter = [R * 0.66, R];
    const rInner = [R * 0.36, R * 0.64];
    const step = (Math.PI * 2) / 12;

    // Diatonic neighbourhood of the key: the key and one step either side.
    ctx.save();
    for (let d = -1; d <= 1; d++) {
      const a = -Math.PI / 2 + (keyIdx + d) * step;
      for (const [r0, r1] of [rOuter, rInner]) {
        ctx.beginPath();
        ctx.arc(cx, cy, r1, a - step / 2, a + step / 2);
        ctx.arc(cx, cy, r0, a + step / 2, a - step / 2, true);
        ctx.closePath();
        ctx.fillStyle = d === 0 ? keyCss(0.14) : keyCss(0.06);
        ctx.fill();
      }
    }
    ctx.restore();

    const m = s.music;
    if (m.chord && m.chord !== lastChord.current) {
      lastChord.current = m.chord;
      trail.current.push({ cell: cellOf(m.chord), t: s.now });
      if (trail.current.length > 8) trail.current.shift();
    }

    // Ring outlines.
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    for (const r of [R, R * 0.65, R * 0.36]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let i = 0; i < 12; i++) {
      const a = -Math.PI / 2 + (i + 0.5) * step;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * R * 0.36, cy + Math.sin(a) * R * 0.36);
      ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.stroke();
    }

    const current = m.chord ? cellOf(m.chord) : null;
    const pos = (c: Cell) => {
      const r = c.ring === 'outer' ? R * 0.83 : R * 0.5;
      return [cx + Math.cos(c.angle) * r, cy + Math.sin(c.angle) * r] as const;
    };

    // Progression trail: where the harmony has been moving.
    const tr = trail.current;
    for (let i = 1; i < tr.length; i++) {
      const [x0, y0] = pos(tr[i - 1].cell);
      const [x1, y1] = pos(tr[i].cell);
      const age = (tr.length - i) / tr.length;
      ctx.strokeStyle = keyCss(0.55 * (1 - age) + 0.05);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(cx, cy, x1, y1);
      ctx.stroke();
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of CELLS) {
      const [x, y] = pos(c);
      const isCur = current === c;
      if (isCur) {
        const col = pitchColor(c.root, c.quality === 'min');
        const g = ctx.createRadialGradient(x, y, 0, x, y, R * 0.2);
        g.addColorStop(0, rgbCss(col, 0.55 + m.beatPulse * 0.3));
        g.addColorStop(1, rgbCss(col, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, R * 0.2, 0, Math.PI * 2);
        ctx.fill();
      }
      const label = chordName(c, key);
      ctx.font = c.ring === 'outer' ? `500 ${isCur ? 15 : 12}px ${SERIF}` : `400 ${isCur ? 13 : 10.5}px ${MONO}`;
      ctx.fillStyle = isCur ? C.ink : c.ring === 'outer' ? C.ink2 : C.ink3;
      ctx.fillText(label, x, y);
    }

    // Centre: the key.
    ctx.font = `italic 400 13px ${SERIF}`;
    ctx.fillStyle = C.ink3;
    ctx.fillText('kunci', cx, cy - 9);
    ctx.font = `500 15px ${SERIF}`;
    ctx.fillStyle = keyCss(1);
    ctx.fillText(`${noteName(key.tonic, flats)}${key.mode === 'minor' ? 'm' : ''}`, cx, cy + 9);
  });

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const { cx, cy, R } = geom.current;
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < R * 0.36 || dist > R) {
      setHover(null);
      return;
    }
    let a = Math.atan2(dy, dx) + Math.PI / 2;
    if (a < 0) a += Math.PI * 2;
    const i = Math.round(a / ((Math.PI * 2) / 12)) % 12;
    const ring = dist > R * 0.65 ? 'outer' : 'inner';
    const cell = CELLS.find((c) => c.ring === ring && Math.abs(c.angle - (-Math.PI / 2 + (i * Math.PI * 2) / 12)) < 1e-6);
    setHover(cell ? { x, y, cell } : null);
  };

  return (
    <div className="harmony-wheel" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      <canvas ref={canvas} role="img" aria-label="Lingkaran kelima: akor yang sedang berbunyi dan jejak progresinya" />
      {hover && (
        <div className="wheel-tip" style={{ left: hover.x, top: hover.y }}>
          <strong>
            {chordName(hover.cell, key)} <span>{romanNumeral(hover.cell, key)}</span>
          </strong>
          <span>{chordRole(hover.cell, key)}</span>
        </div>
      )}
    </div>
  );
}
