import { Minus, Plus } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { getAnalysis } from '../analysis/manager';
import { engine } from '../audio/engine';
import { lineAt, nudgeOffset, offsetFor, useLyrics, type LyricLine } from '../lyrics/lyrics';
import { usePlayer } from '../store/player';
import { lyricVeil, type VeilBox } from '../visual/veil';
import { cls, useHub, useHubValue } from './hooks';

export const offsetText = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1).replace('.', ',')} s`;

/** Index of the last word that has started at `t`, or -1. */
export function wordAt(line: LyricLine | undefined, t: number): number {
  const w = line?.words;
  if (!w) return -1;
  let i = -1;
  while (i + 1 < w.length && w[i + 1].t <= t) i++;
  return i;
}

/** The time on the song's own clock, corrected by the listener's lyric offset. */
export const lyricTime = (offset: number) => (engine.position()?.time ?? 0) - offset;

/** The panel shows lyrics itself while it is open in Dengar mode. */
export function useLyricsPanelOpen(): boolean {
  return usePlayer((s) => s.ui.mode === 'dengar' && s.ui.inspector && !s.ui.hidden && !s.ui.sonicMap && s.order.length > 0);
}

/**
 * The box around the three lines' text (not the offset control), with a little
 * air, for the visuals to quiet. Softer while the song rests between lines.
 */
function textBox(el: HTMLElement): VeilBox | null {
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  const range = document.createRange();
  for (const p of el.querySelectorAll('.ly-prev, .ly-cur, .ly-next')) {
    if (!p.textContent?.trim()) continue;
    // The words themselves, not the paragraph, which spans the whole column.
    range.selectNodeContents(p);
    const rc = range.getBoundingClientRect();
    if (rc.width < 1 || rc.height < 1) continue;
    l = Math.min(l, rc.left);
    t = Math.min(t, rc.top);
    r = Math.max(r, rc.right);
    b = Math.max(b, rc.bottom);
  }
  if (r < l) return null;
  const resting = el.classList.contains('resting') || !el.querySelector('.ly-cur')?.textContent?.replace('♪', '').trim();
  return { x: (l + r) / 2, y: (t + b) / 2, hw: (r - l) / 2 + 20, hh: (b - t) / 2 + 10, strength: resting ? 0.4 : 1 };
}

/** Choruses (and the song's peak) get the big type. */
function isChorus(trackId: string, t: number): boolean {
  const sec = getAnalysis(trackId)?.sections.find((s) => t >= s.t && t < s.end);
  return sec?.name === 'Chorus' || sec?.name === 'Puncak';
}

function Words({ line, active }: { line: LyricLine; active: number }) {
  if (!line.words) return <span className="sung">{line.text || '♪'}</span>;
  return (
    <>
      {line.words.map((w, i) => (
        <span key={i} className={i < active ? 'sung' : i === active ? 'now' : undefined}>
          {w.text}
        </span>
      ))}
    </>
  );
}

/**
 * Kinetic lyrics over the visuals: each word appears as it is sung and pops,
 * the line breathes with kick and snare, and choruses are set larger. Colour
 * comes from the song's palette.
 */
export function LyricsOverlay() {
  const nowId = usePlayer((s) => s.now?.trackId);
  const lines = useLyrics((s) => (nowId ? s.timed[nowId] : undefined));
  const show = useLyrics((s) => s.show);
  const offset = useLyrics((s) => (nowId ? offsetFor(s, nowId) : 0));
  const panelOpen = useLyricsPanelOpen();
  const root = useRef<HTMLDivElement>(null);

  // One number per (line, word) step, so React renders only when a word starts.
  const step = useHubValue(() => {
    if (!lines?.length) return -1;
    const t = lyricTime(offset);
    const i = lineAt(lines, t + 0.12);
    if (i < 0) return -1;
    const line = lines[i];
    const w = wordAt(line, t + 0.04);
    const last = line.words ? line.words[line.words.length - 1].t : line.t;
    // A long instrumental after the line: let it rest instead of hanging there.
    const rest = t - last > 3.5 && (lines[i + 1]?.t ?? Infinity) - t > 2 ? 1 : 0;
    return i * 4096 + (w + 1) * 2 + rest;
  });

  const measured = useRef(0);
  useHub((s) => {
    const el = root.current;
    if (!el) {
      lyricVeil.box = null;
      return;
    }
    // Tell the visuals where the words are (a few times a second; the engine eases between).
    const now = performance.now();
    if (now - measured.current > 120) {
      measured.current = now;
      lyricVeil.box = textBox(el);
    }
    el.style.setProperty('--pulse', s.features.pulse.toFixed(3));
    const voice = s.music.stems ? s.music.stems.vocals : s.features.energy * 0.7;
    el.style.setProperty('--voice', voice.toFixed(3));
  });
  useEffect(
    () => () => {
      lyricVeil.box = null;
    },
    [],
  );

  if (!lines?.length || !show || !nowId || panelOpen) return null;
  const idx = step < 0 ? -1 : Math.floor(step / 4096);
  const word = step < 0 ? -1 : Math.floor((step % 4096) / 2) - 1;
  const resting = step >= 0 && step % 2 === 1;
  const cur = lines[idx];
  const big = cur ? isChorus(nowId, cur.t) : false;

  return (
    <div className={cls('lyrics kinetic', big && 'big', resting && 'resting')} ref={root} aria-live="polite">
      <p className="ly-prev" key={`p${idx}`}>
        {lines[idx - 1]?.text ?? ''}
      </p>
      <p className="ly-cur" key={idx}>
        {cur && cur.text ? <Words line={cur} active={word} /> : <span className="ly-rest">♪</span>}
      </p>
      <p className="ly-next">{lines[idx + 1]?.text ?? ''}</p>
      <div className="ly-offset" role="group" aria-label="Koreksi waktu lirik">
        <button className="icon-btn" onClick={() => nudgeOffset(nowId, -0.1)} aria-label="Lirik lebih awal 0,1 detik" data-tip="Lirik lebih awal">
          <Minus size={13} />
        </button>
        <span>{offsetText(offset)}</span>
        <button className="icon-btn" onClick={() => nudgeOffset(nowId, 0.1)} aria-label="Lirik lebih lambat 0,1 detik" data-tip="Lirik lebih lambat">
          <Plus size={13} />
        </button>
      </div>
    </div>
  );
}
