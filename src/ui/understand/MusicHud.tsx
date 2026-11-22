import { useRef } from 'react';
import { useAnalysis } from '../../analysis/manager';
import { chordName, keyName, romanNumeral } from '../../analysis/theory';
import { usePlayer } from '../../store/player';
import { useHub, useHubValue } from '../hooks';
import { BeatDots } from './MusicSummary';

/** Large chord readout over the stage, with a countdown to the next section. */
export function MusicHud() {
  const nowId = usePlayer((s) => s.now?.trackId);
  const { analysis } = useAnalysis(nowId);
  const chord = useHubValue((s) => s.music.chord);
  const next = useHubValue((s) => s.music.nextSection);
  const countdown = useRef<HTMLSpanElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useHub((s) => {
    const m = s.music;
    if (wrap.current) wrap.current.style.setProperty('--antic', m.anticipation.toFixed(3));
    const el = countdown.current;
    if (!el) return;
    const show = m.nextSection && m.timeToNext < 12;
    const text = show ? `${Math.max(0, m.timeToNext).toFixed(1).replace('.', ',')} s` : '';
    if (el.textContent !== text) el.textContent = text;
  });

  if (!analysis) return null;
  const key = analysis.key;
  return (
    <div className="music-hud" ref={wrap}>
      <div className="hud-chord">
        <span className="hud-name">{chord ? chordName(chord, key) : '—'}</span>
        {chord && <span className="hud-numeral">{romanNumeral(chord, key)}</span>}
      </div>
      <div className="hud-meta">
        <span>{keyName(key)}</span>
        <span>{analysis.bpm.toLocaleString('id-ID', { maximumFractionDigits: 1 })} BPM</span>
        <BeatDots />
      </div>
      {next && (
        <div className="hud-next">
          <span>→ {next.name === 'Bagian' ? `Bagian ${next.label}` : next.name}</span>
          <span ref={countdown} className="hud-count" />
        </div>
      )}
    </div>
  );
}
