import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { chordsFor } from '../../analysis/chordView';
import { useAnalysis } from '../../analysis/manager';
import { chordName, pitchColor, rgbCss } from '../../analysis/theory';
import type { Analysis, ChordSeg } from '../../analysis/types';
import { engine } from '../../audio/engine';
import { formatTime } from '../../lib/format';
import { seek } from '../../store/controller';
import { usePlayer } from '../../store/player';
import { useHubCanvas } from '../hooks';
import { C, keyCss, MONO, SANS } from '../palette';
import { sectionColor } from './MusicSummary';
import { AnalysisFailed, AnalysisProgress } from './UnderstandPanel';

const SEC_H = 30;
const CHORD_Y = 34;
const CHORD_H = 18;
const CURVE_Y = 56;

const sectionTitle = (name: string, label: string) => (name === 'Bagian' ? `Bagian ${label}` : name);

/** Draws everything that does not move: sections, chords, energy, bar lines. */
function drawStatic(ctx: CanvasRenderingContext2D, a: Analysis, chords: ChordSeg[], w: number, h: number) {
  const dur = a.duration;
  const xOf = (t: number) => (t / dur) * w;
  ctx.clearRect(0, 0, w, h);

  a.sections.forEach((s, i) => {
    const x0 = xOf(s.t);
    const x1 = xOf(s.end);
    const col = sectionColor(s);
    // A run of the same section (Chorus, Chorus) reads as one block with one label.
    const repeat = i > 0 && a.sections[i - 1].name === s.name && a.sections[i - 1].name !== 'Bagian';
    const left = repeat ? x0 : x0 + 1;
    ctx.fillStyle = col + '2e';
    ctx.fillRect(left, 0, Math.max(1, x1 - left - 1), SEC_H);
    ctx.fillStyle = col;
    ctx.fillRect(left, 0, Math.max(1, x1 - left - 1), 2);
    if (repeat) {
      ctx.fillStyle = col + '55';
      ctx.fillRect(x0, 6, 1, SEC_H - 12);
      return;
    }
    // The label gets the width of the whole run of this section, not just its first piece.
    let runEnd = i;
    while (s.name !== 'Bagian' && a.sections[runEnd + 1]?.name === s.name) runEnd++;
    const title = sectionTitle(s.name, s.label);
    ctx.font = `500 12px ${SANS}`;
    if (xOf(a.sections[runEnd].end) - x0 > ctx.measureText(title).width + 14) {
      ctx.fillStyle = C.ink;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(title, x0 + 8, SEC_H / 2 + 1);
    }
  });

  ctx.font = `500 10px ${MONO}`;
  ctx.textBaseline = 'middle';
  for (const c of chords) {
    const x0 = xOf(c.t);
    const x1 = xOf(c.end);
    if (x1 - x0 < 1) continue;
    ctx.fillStyle = rgbCss(pitchColor(c.root, c.quality === 'min'), 0.28);
    ctx.fillRect(x0, CHORD_Y, Math.max(1, x1 - x0 - 1), CHORD_H);
    const name = chordName(c, a.key);
    if (x1 - x0 > ctx.measureText(name).width + 6) {
      ctx.fillStyle = C.ink2;
      ctx.fillText(name, x0 + 3, CHORD_Y + CHORD_H / 2 + 1);
    }
  }

  const curveH = h - CURVE_Y - 2;
  ctx.beginPath();
  ctx.moveTo(0, h - 2);
  for (let i = 0; i < a.energy.length; i++) {
    ctx.lineTo(xOf(i / a.energyRate), h - 2 - a.energy[i] * curveH);
  }
  ctx.lineTo(w, h - 2);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, CURVE_Y, 0, h);
  g.addColorStop(0, keyCss(0.35));
  g.addColorStop(1, keyCss(0.04));
  ctx.fillStyle = g;
  ctx.fill();

  // Bar lines on the energy lane.
  ctx.fillStyle = 'rgba(236,234,230,0.16)';
  for (let k = 0; k < a.downbeats.length; k++) {
    const x = Math.round(xOf(a.beats[a.downbeats[k]]));
    ctx.fillRect(x, CURVE_Y, 1, k % 4 === 0 ? 8 : 4);
  }
}

function MapCanvas({ analysis }: { analysis: Analysis }) {
  const layer = useRef<HTMLCanvasElement | null>(null);
  const layerKey = useRef('');
  const hoverX = useRef<number | null>(null);
  const [tip, setTip] = useState<{ x: number; text: string; edge: 'start' | 'mid' | 'end' } | null>(null);
  const [at, setAt] = useState(0);
  const tipTimer = useRef(0);
  const howId = useId();
  const chords = chordsFor(analysis, usePlayer((s) => s.settings.chordView));

  const canvas = useHubCanvas((ctx, w, h, s) => {
    const dpr = ctx.getTransform().a;
    const key = `${w}x${h}@${dpr}:${keyCss(1)}`;
    if (!layer.current) layer.current = document.createElement('canvas');
    const l = layer.current;
    if (layerKey.current !== key) {
      l.width = Math.round(w * dpr);
      l.height = Math.round(h * dpr);
      const lc = l.getContext('2d')!;
      lc.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawStatic(lc, analysis, chords, w, h);
      layerKey.current = key;
    }
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(l, 0, 0, w, h);

    const m = s.music;
    const pos = engine.position();
    const t = pos ? pos.time : 0;
    const x = (t / analysis.duration) * w;

    // Glow on the upcoming boundary while a build-up is running.
    if (m.nextSection && m.anticipation > 0.02) {
      const bx = (m.nextSection.t / analysis.duration) * w;
      const g = ctx.createLinearGradient(bx - 40, 0, bx, 0);
      g.addColorStop(0, keyCss(0));
      g.addColorStop(1, keyCss(0.45 * m.anticipation));
      ctx.fillStyle = g;
      ctx.fillRect(bx - 40, 0, 40, h);
    }
    if (m.section) {
      const x0 = (m.section.t / analysis.duration) * w;
      const x1 = (m.section.end / analysis.duration) * w;
      ctx.strokeStyle = sectionColor(m.section);
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 1.5, 0.5, Math.max(1, x1 - x0 - 3), SEC_H - 1);
    }
    ctx.fillStyle = 'rgba(11,12,13,0.38)';
    ctx.fillRect(x, CHORD_Y, w - x, h - CHORD_Y);
    ctx.fillStyle = C.ink;
    ctx.fillRect(Math.round(x) - 1, 0, 2, h);
    if (hoverX.current !== null) {
      ctx.fillStyle = 'rgba(236,234,230,0.4)';
      ctx.fillRect(Math.round(hoverX.current), 0, 1, h);
    }
  });

  useEffect(() => {
    layerKey.current = '';
  }, [analysis, chords]);
  useEffect(() => () => window.clearTimeout(tipTimer.current), []);

  // One moment of the map in words: its time, its section, its chord.
  const describe = (t: number) => {
    const sec = analysis.sections.find((s) => t >= s.t && t < s.end);
    const ch = chords.find((c) => t >= c.t && t < c.end);
    return [formatTime(t), sec ? sectionTitle(sec.name, sec.label) : null, ch ? chordName(ch, analysis.key) : null].filter(Boolean).join(' · ');
  };
  // Near either end the tip hangs inward, so it never runs off the stage.
  const showTip = (x: number, w: number, text: string) =>
    setTip({ x, text, edge: x < w * 0.18 ? 'start' : x > w * 0.82 ? 'end' : 'mid' });

  const timeAt = (e: { currentTarget: HTMLDivElement; clientX: number }) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
    return { x, w: r.width, t: (x / r.width) * analysis.duration };
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    window.clearTimeout(tipTimer.current);
    const { x, w, t } = timeAt(e);
    hoverX.current = x;
    showTip(x, w, describe(t));
  };
  const onLeave = () => {
    window.clearTimeout(tipTimer.current);
    hoverX.current = null;
    setTip(null);
  };
  // A keyboard move says where it landed for a moment, then the map is the map again.
  const landed = (el: HTMLDivElement, t: number, extra?: string) => {
    const w = el.getBoundingClientRect().width;
    setAt(t);
    showTip((t / analysis.duration) * w, w, extra ? `${describe(t)} · ${extra}` : describe(t));
    window.clearTimeout(tipTimer.current);
    tipTimer.current = window.setTimeout(() => setTip(null), 3000);
  };
  // From the keyboard the map moves the way it is drawn: a section at a time. Left goes back to the
  // start of this section, or to the one before when the playhead is already near its start.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const now = engine.position()?.time ?? 0;
    const secs = analysis.sections;
    let t: number | undefined;
    if (e.key === 'ArrowRight') t = secs.find((s) => s.t > now + 0.5)?.t;
    else if (e.key === 'ArrowLeft') t = secs.findLast((s) => s.t < now - 2)?.t ?? 0;
    else if (e.key === 'Home') t = 0;
    else if (e.key === 'End') t = secs[secs.length - 1]?.t;
    else return;
    e.preventDefault();
    e.stopPropagation();
    if (t === undefined) return;
    seek(t);
    landed(e.currentTarget, t);
  };
  // Only a keyboard arrival shows the keys; a click has already seeked.
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (e.currentTarget.matches(':focus-visible')) landed(e.currentTarget, engine.position()?.time ?? 0, '← → pindah bagian');
  };

  return (
    <div
      className="songmap-canvas"
      role="slider"
      tabIndex={0}
      aria-label="Peta lagu"
      aria-describedby={howId}
      aria-valuemin={0}
      aria-valuemax={Math.round(analysis.duration)}
      aria-valuenow={Math.round(at)}
      aria-valuetext={describe(at)}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      onClick={(e) => seek(timeAt(e).t)}
      onKeyDown={onKey}
      onFocus={onFocus}
      onBlur={onLeave}
    >
      <canvas ref={canvas} aria-hidden="true" />
      <span id={howId} className="sr-only">
        Bagian, akor, dan kurva energi lagu. Panah kiri dan kanan pindah ke bagian sebelum dan sesudahnya.
      </span>
      {tip && (
        <span className={`ws-tip ${tip.edge}`} style={{ left: tip.x, bottom: 'auto', top: -26 }}>
          {tip.text}
        </span>
      )}
    </div>
  );
}

export function SongMap() {
  const nowId = usePlayer((s) => s.now?.trackId);
  const { analysis, status } = useAnalysis(nowId);
  // A tab's song is only known up to now, so there is no map of it.
  const live = usePlayer((s) => (s.now ? !!s.tracks[s.now.trackId]?.live : false));
  if (!nowId || live) return null;
  return (
    <section className="songmap panel" aria-label="Peta lagu">
      {analysis ? (
        <MapCanvas analysis={analysis} />
      ) : status?.state === 'error' ? (
        <AnalysisFailed short />
      ) : (
        <AnalysisProgress stage={status?.stage ?? 'Antre'} progress={status?.progress ?? 0} />
      )}
    </section>
  );
}
