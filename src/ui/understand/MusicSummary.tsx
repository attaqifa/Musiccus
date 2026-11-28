import { useRef, useState } from 'react';
import { hub } from '../../audio/hub';
import { chordsFor } from '../../analysis/chordView';
import { adjustTempo, getFix } from '../../analysis/manager';
import { camelot, chordName, chordRole, keyName, romanNumeral } from '../../analysis/theory';
import type { Analysis, Section } from '../../analysis/types';
import { formatTime } from '../../lib/format';
import { usePlayer } from '../../store/player';
import { cls, useHub, useHubValue } from '../hooks';
import { SECTION_COLOR, UNNAMED_SECTION } from '../palette';
import { Term } from '../Tip';
import { ChordPicker, KeyPicker, type ChordTarget } from './ChordFix';
import { camelotTip, EXPLAIN } from './explain';

export const sectionColor = (s: Pick<Section, 'name' | 'label'>) =>
  s.name === 'Bagian'
    ? UNNAMED_SECTION[Math.abs(s.label.charCodeAt(0) - 65) % UNNAMED_SECTION.length]
    : SECTION_COLOR[s.name];

export function BeatDots() {
  const dots = useRef<(HTMLSpanElement | null)[]>([]);
  const bar = useRef<HTMLSpanElement>(null);
  useHub((s) => {
    const m = s.music;
    for (let i = 0; i < 4; i++) {
      const el = dots.current[i];
      if (!el) continue;
      const on = m.ready && m.beatInBar === i;
      el.style.setProperty('--pulse', on ? String(0.35 + m.beatPulse * 0.65) : '0');
    }
    if (bar.current) {
      const text = m.ready && m.barIndex >= 0 ? `birama ${m.barIndex + 1}` : '';
      if (bar.current.textContent !== text) bar.current.textContent = text;
    }
  });
  return (
    <span className="beat-dots" aria-hidden="true" data-tip="Ketukan dalam birama; titik besar adalah ketukan pertama.">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} ref={(el) => void (dots.current[i] = el)} className={i === 0 ? 'down' : ''} />
      ))}
      <span className="bar-pos" ref={bar} />
    </span>
  );
}

/** Concert A for a tuning offset. The estimate can be off by up to about 7 cents, so anything closer than 10 reads as 440. */
const tuningHz = (cents: number) => (Math.abs(cents) < 10 ? 440 : Math.round(440 * Math.pow(2, cents / 1200)));

/** The chord after this one, quietly, so the change does not come as a surprise. */
function NextChord({ analysis }: { analysis: Analysis }) {
  const next = useHubValue((s) => s.music.nextChord);
  if (!next) return null;
  return (
    <span className="ms-then" data-tip="Akor berikutnya.">
      lalu <b>{chordName(next, analysis.key)}</b>
    </span>
  );
}

export function MusicSummary({ analysis, trackId }: { analysis: Analysis; trackId: string }) {
  const chord = useHubValue((s) => s.music.chord);
  const section = useHubValue((s) => s.music.section);
  const next = useHubValue((s) => s.music.nextSection);
  const view = usePlayer((s) => s.settings.chordView);
  const [keyAt, setKeyAt] = useState<HTMLElement | null>(null);
  const [fix, setFix] = useState<ChordTarget | null>(null);
  const key = analysis.key;
  const name = chord ? chordName(chord, key) : '—';
  const numeral = chord ? romanNumeral(chord, key) : '';
  const chords = chordsFor(analysis, view);

  // The chord sounding now, or the gap around now when none does.
  const fixNow = (anchor: HTMLElement) => {
    const t = hub.snapshot.music.trackTime;
    const at = chords.find((c) => c.t <= t && c.end > t);
    if (at) return setFix({ span: { t: at.t, end: at.end }, chord: at, anchor });
    const before = chords.filter((c) => c.end <= t).pop();
    const after = chords.find((c) => c.t > t);
    setFix({ span: { t: before?.end ?? 0, end: after?.t ?? analysis.duration }, chord: null, anchor });
  };

  return (
    <div className="music-summary">
      <div className="ms-cell">
        <span className="ms-label">
          <Term tip={EXPLAIN.key}>Kunci</Term>
          <button
            className="ms-fix"
            onClick={(e) => setKeyAt(keyAt ? null : e.currentTarget)}
            aria-expanded={!!keyAt}
            aria-haspopup="dialog"
            data-tip="Kuncinya terdengar lain? Pilih sendiri; disimpan untuk file ini."
          >
            Ubah
          </button>
        </span>
        <span className="ms-value">{keyName(key)}</span>
        <span className="ms-sub">
          <Term className="camelot" tip={camelotTip(camelot(key))}>
            {camelot(key)}
          </Term>
          {key.fixed ? (
            <span className="ms-fixed">dipilih Anda</span>
          ) : getFix(trackId)?.key ? (
            <span className="ms-fixed">sudah Anda periksa</span>
          ) : (
            <Term tip={EXPLAIN.confidence}>keyakinan {Math.round(key.confidence * 100)}%</Term>
          )}
          <Term className="tuning" tip={EXPLAIN.tuning}>
            A4 {tuningHz(analysis.tuningCents)} Hz
          </Term>
        </span>
      </div>
      <div className="ms-cell">
        <span className="ms-label">
          <Term tip={EXPLAIN.tempo}>Tempo</Term>
        </span>
        <span className="ms-value">
          {analysis.bpm.toLocaleString('id-ID', { maximumFractionDigits: 1 })} <small>BPM</small>
          <span className="tempo-fix">
            <button
              className={cls(analysis.tempoAlt === 0.5 && 'suggest')}
              onClick={() => adjustTempo(trackId, 0.5)}
              aria-label="Bagi dua tempo"
              data-tip="Tempo terbaca dua kali terlalu cepat? Bagi dua; disimpan untuk file ini."
            >
              ½×
            </button>
            <button
              className={cls(analysis.tempoAlt === 2 && 'suggest')}
              onClick={() => adjustTempo(trackId, 2)}
              aria-label="Gandakan tempo"
              data-tip="Tempo terbaca setengahnya (half-time)? Gandakan; disimpan untuk file ini."
            >
              2×
            </button>
          </span>
        </span>
        <span className="ms-sub">
          <BeatDots />
          {getFix(trackId)?.tempo ? (
            <span className="ms-fixed">dipilih Anda</span>
          ) : (
            analysis.tempoAlt && (
              <span className="ms-fixed" data-tip="Ketukan lagu ini cocok dibaca di dua tempo. Pilih yang terasa saat Anda mengetuk mengikuti lagu.">
                bisa juga {Math.round(analysis.bpm * analysis.tempoAlt)}
              </span>
            )
          )}
        </span>
      </div>
      <div className="ms-cell wide">
        <span className="ms-label">
          Akor sekarang
          <button
            className="ms-fix"
            onClick={(e) => (fix ? setFix(null) : fixNow(e.currentTarget))}
            aria-expanded={!!fix}
            aria-haspopup="dialog"
            data-tip="Akor ini terdengar lain? Koreksi; disimpan untuk file ini."
          >
            {chord ? 'Salah?' : 'Ada akor?'}
          </button>
        </span>
        <span className="ms-chord">
          <span className="ms-chord-name">{name}</span>
          {chord?.fixed && <span className="ms-fixed">dikoreksi</span>}
          {numeral && (
            <Term className="ms-numeral" tip={EXPLAIN.numeral}>
              {numeral}
            </Term>
          )}
          <NextChord analysis={analysis} />
        </span>
        <span className="ms-role">{chord ? chordRole(chord, key) : 'Tidak ada akor yang jelas di sini.'}</span>
      </div>
      <div className="ms-cell wide">
        <span className="ms-label">Bagian lagu</span>
        <span className="ms-section">
          {section && <i style={{ background: sectionColor(section) }} />}
          {section ? `${section.name === 'Bagian' ? `Bagian ${section.label}` : section.name}` : '—'}
          {section && section.name !== 'Bagian' && (
            <small>
              · <Term tip={EXPLAIN.sectionLetter}>{section.label}</Term>
            </small>
          )}
        </span>
        <span className="ms-sub">
          {next ? `Berikutnya ${next.name === 'Bagian' ? `bagian ${next.label}` : next.name} di ${formatTime(next.t)}` : 'Bagian terakhir'}
        </span>
      </div>
      {keyAt && <KeyPicker trackId={trackId} analysis={analysis} anchor={keyAt} onClose={() => setKeyAt(null)} />}
      {fix && <ChordPicker trackId={trackId} analysis={analysis} view={chords} target={fix} onClose={() => setFix(null)} />}
    </div>
  );
}
