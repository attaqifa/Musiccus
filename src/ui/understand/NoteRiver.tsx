import { chordsFor } from '../../analysis/chordView';
import { chordName, noteName, pitchColor, rgbCss, usesFlats } from '../../analysis/theory';
import type { Analysis } from '../../analysis/types';
import { usePlayer } from '../../store/player';
import { useHubCanvas } from '../hooks';
import { C, MONO, signalA } from '../palette';

const PAST = 4;
const FUTURE = 6;

/**
 * Pitch classes over time, like a piano roll folded into one octave. The
 * playhead sits left of centre: everything to its right has not been heard
 * yet but is already known from the analysis.
 */
export function NoteRiver({ analysis }: { analysis: Analysis }) {
  const flats = usesFlats(analysis.key);
  const chords = chordsFor(analysis, usePlayer((s) => s.settings.chordView));
  const canvas = useHubCanvas((ctx, w, h, s) => {
    ctx.clearRect(0, 0, w, h);
    const m = s.music;
    const t = m.ready ? m.trackTime : 0;
    const labelW = 26;
    const top = 14;
    const plotW = w - labelW;
    const rowH = (h - top) / 12;
    const span = PAST + FUTURE;
    const xOf = (time: number) => labelW + ((time - (t - PAST)) / span) * plotW;
    const playX = xOf(t);

    const chordTones = new Set<number>();
    if (m.chord) {
      chordTones.add(m.chord.root);
      chordTones.add((m.chord.root + (m.chord.quality === 'min' ? 3 : 4)) % 12);
      chordTones.add((m.chord.root + 7) % 12);
    }

    ctx.font = `500 10px ${MONO}`;
    ctx.textBaseline = 'middle';
    for (let pc = 0; pc < 12; pc++) {
      const y = top + (11 - pc) * rowH;
      if (chordTones.has(pc)) {
        ctx.fillStyle = signalA(0.06);
        ctx.fillRect(labelW, y, plotW, rowH);
      }
      ctx.fillStyle = chordTones.has(pc) ? C.signal : C.ink3;
      ctx.textAlign = 'right';
      ctx.fillText(noteName(pc, flats), labelW - 6, y + rowH / 2);
    }

    // Beat grid.
    const beats = analysis.beats;
    for (let i = 0; i < beats.length; i++) {
      const bt = beats[i];
      if (bt < t - PAST || bt > t + FUTURE) continue;
      const x = Math.round(xOf(bt)) + 0.5;
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    const rate = analysis.chromaRate;
    const f0 = Math.max(0, Math.floor((t - PAST) * rate));
    const f1 = Math.min(analysis.chroma.length / 12 - 1, Math.ceil((t + FUTURE) * rate));
    const colW = Math.max(1, plotW / (span * rate) + 0.6);
    for (let fr = f0; fr <= f1; fr++) {
      const ft = fr / rate;
      const x = xOf(ft);
      const future = ft > t;
      for (let pc = 0; pc < 12; pc++) {
        const v = analysis.chroma[fr * 12 + pc] / 255;
        if (v < 0.12) continue;
        ctx.fillStyle = rgbCss(pitchColor(pc), v * (future ? 0.35 : 0.9));
        ctx.fillRect(x, top + (11 - pc) * rowH + 1, colW, rowH - 2);
      }
    }

    // Chord names along the top.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    for (const c of chords) {
      if (c.end < t - PAST || c.t > t + FUTURE) continue;
      const x = Math.max(labelW, xOf(c.t));
      ctx.fillStyle = c === m.chord ? C.ink : C.ink3;
      ctx.fillText(chordName(c, analysis.key), x + 2, 10);
    }

    ctx.fillStyle = 'rgba(11,12,13,0.35)';
    ctx.fillRect(playX, top, w - playX, h - top);
    ctx.fillStyle = C.ink;
    ctx.fillRect(Math.round(playX) - 1, top - 2, 2, h - top + 2);
  });

  return <canvas ref={canvas} className="meter-canvas river" role="img" aria-label="Sungai nada: kelas nada yang berbunyi dari waktu ke waktu" />;
}
