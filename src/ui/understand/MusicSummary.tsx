import { useRef, useState } from 'react';
import { hub } from '../../audio/hub';
import { chordsFor } from '../../analysis/chordView';
import { adjustTempo, getFix } from '../../analysis/manager';
import { camelot, chordName, chordRole, keyName, romanNumeral } from '../../analysis/theory';
import type { Analysis } from '../../analysis/types';
import { formatTime } from '../../lib/format';
import { usePlayer } from '../../store/player';
import { useHub, useHubValue } from '../hooks';
import { ChordPicker, KeyPicker, type ChordTarget } from './ChordFix';

// Categorical and deliberately soft, so sections never read as status colours.
export const SECTION_COLORS = ['#B9A8E8', '#86B8DA', '#D9B48E', '#8FC7AE', '#DD9DB5', '#B8BE7E'];
export const sectionColor = (label: string) => SECTION_COLORS[(label.charCodeAt(0) - 65) % SECTION_COLORS.length];

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
      const text = m.ready && m.barIndex >= 0 ? `${m.barIndex + 1}.${m.beatInBar + 1}` : '—';
      if (bar.current.textContent !== text) bar.current.textContent = text;
    }
  });
  return (
    <span className="beat-dots" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} ref={(el) => void (dots.current[i] = el)} className={i === 0 ? 'down' : ''} />
      ))}
      <span className="bar-pos" ref={bar}>
        —
      </span>
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
    <span className="ms-then" title="Akor berikutnya.">
      lalu <b>{chordName(next, analysis.key)}</b>
    </span>
  );
}

export function MusicSummary({ analysis, trackId, detail }: { analysis: Analysis; trackId: string; detail: boolean }) {
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
      <div
        className="ms-cell"
        title={
          detail
            ? 'Kunci nada lagu: nada yang dimainkan (dipisah dari harmoniknya, bass dan treble sendiri-sendiri) dicocokkan dengan profil tiap kunci, lalu diperiksa dengan akor mana yang jadi rumah dan akor mana yang mengarah ke sana.'
            : 'Nada dasar lagu. Persentase menunjukkan seberapa yakin analisisnya.'
        }
      >
        <span className="ms-label">
          Kunci
          <button
            className="ms-fix"
            onClick={(e) => setKeyAt(keyAt ? null : e.currentTarget)}
            aria-expanded={!!keyAt}
            aria-haspopup="dialog"
            title="Kuncinya terdengar lain? Pilih sendiri; disimpan untuk file ini."
          >
            Ubah
          </button>
        </span>
        <span className="ms-value">{keyName(key)}</span>
        <span className="ms-sub">
          <span className="camelot" title="Kode Camelot: lagu dengan kode sama atau bersebelahan enak disambung tanpa terdengar sumbang.">
            {camelot(key)}
          </span>
          {key.fixed ? (
            <span className="ms-fixed">dipilih Anda</span>
          ) : getFix(trackId)?.key ? (
            <span className="ms-fixed">sudah Anda periksa</span>
          ) : (
            <>keyakinan {Math.round(key.confidence * 100)}%</>
          )}
          {detail && (
            <span
              className="tuning"
              title="Nada acuan lagu ini. Standar modern A4 = 440 Hz, tapi sebagian lagu disetel lebih rendah atau tinggi, misalnya 432 Hz. Musiccus menyesuaikan diri dulu sebelum membaca kunci dan akor."
            >
              A4 {tuningHz(analysis.tuningCents)} Hz
            </span>
          )}
        </span>
      </div>
      <div
        className="ms-cell"
        title={
          detail
            ? 'Tempo dari autokorelasi onset, lalu beat grid dari dynamic programming.'
            : 'Jumlah ketukan per menit. Terasa dua kali terlalu cepat atau lambat? Pakai ½× atau 2×.'
        }
      >
        <span className="ms-label">Tempo</span>
        <span className="ms-value">
          {analysis.bpm.toLocaleString('id-ID', { maximumFractionDigits: 1 })} <small>BPM</small>
          <span className="tempo-fix">
            <button onClick={() => adjustTempo(trackId, 0.5)} title="Tempo terbaca dua kali terlalu cepat? Bagi dua.">
              ½×
            </button>
            <button onClick={() => adjustTempo(trackId, 2)} title="Tempo terbaca setengahnya (half-time)? Gandakan.">
              2×
            </button>
          </span>
        </span>
        <span className="ms-sub">
          <BeatDots />
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
            title="Akor ini terdengar lain? Koreksi; disimpan untuk file ini."
          >
            {chord ? 'Salah?' : 'Ada akor?'}
          </button>
        </span>
        <span className="ms-chord">
          <span className="ms-chord-name">{name}</span>
          {chord?.fixed && <span className="ms-fixed">dikoreksi</span>}
          {detail && numeral && <span className="ms-numeral">{numeral}</span>}
          <NextChord analysis={analysis} />
        </span>
        <span className="ms-role">{chord ? chordRole(chord, key) : 'Tidak ada akor yang jelas di sini.'}</span>
      </div>
      <div className="ms-cell wide">
        <span className="ms-label">Bagian lagu</span>
        <span className="ms-section">
          {section && <i style={{ background: sectionColor(section.label) }} />}
          {section ? `${section.name === 'Bagian' ? `Bagian ${section.label}` : section.name}` : '—'}
          {section && <small>· {section.label}</small>}
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
