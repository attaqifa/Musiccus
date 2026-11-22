import { camelot, chordName, keyName } from '../../analysis/theory';
import type { ChordSeg, KeyInfo } from '../../analysis/types';
import { useLive } from '../../live/store';
import { BeatDots } from './MusicSummary';

/** Chord names in the order they sounded, without repeats in a row or passing blips. */
function progression(chords: ChordSeg[], key: KeyInfo | null): string[] {
  const out: string[] = [];
  for (const c of chords) {
    if (c.end - c.t < 0.4) continue;
    const name = chordName(c, key);
    if (out[out.length - 1] !== name) out.push(name);
  }
  return out.slice(-8);
}

/**
 * Pahami for a captured tab: what the live analysis has worked out so far.
 * There is no whole song to map, so sections and the recording's character
 * are left out.
 */
export function LiveSummary() {
  const key = useLive((s) => s.key);
  const bpm = useLive((s) => s.bpm);
  const chords = useLive((s) => s.chords);
  const rounds = useLive((s) => s.rounds);
  const silent = useLive((s) => s.silent);
  const prog = progression(chords, key);
  const waiting = silent ? 'Senyap. Analisis lanjut saat suaranya kembali.' : 'Mendengarkan beberapa detik dulu…';

  return (
    <div className="music-summary">
      <div className="ms-cell" title="Kunci nada dari setengah menit terakhir. Makin yakin seiring lagunya berjalan.">
        <span className="ms-label">Kunci</span>
        <span className="ms-value">{key ? keyName(key) : '—'}</span>
        <span className="ms-sub">
          {key ? (
            <>
              <span className="camelot" title="Kode Camelot: lagu dengan kode sama atau bersebelahan enak dicampur.">
                {camelot(key)}
              </span>
              keyakinan {Math.round(key.confidence * 100)}%
            </>
          ) : (
            waiting
          )}
        </span>
      </div>
      <div className="ms-cell" title="Tempo dari analisis terakhir; ketukan di antaranya dilanjutkan dengan tempo yang sama.">
        <span className="ms-label">Tempo</span>
        <span className="ms-value">
          {bpm ? (
            <>
              {Math.round(bpm)} <small>BPM</small>
            </>
          ) : (
            '—'
          )}
        </span>
        <span className="ms-sub">
          <BeatDots />
        </span>
      </div>
      <div className="ms-cell wide">
        <span className="ms-label">Akor barusan</span>
        <span className="live-prog">
          {prog.length ? prog.map((name, i) => <span key={`${i}:${name}`}>{name}</span>) : '—'}
        </span>
        <span className="ms-role">
          {prog.length
            ? 'Urutan akor dalam setengah menit terakhir, diperbarui setiap beberapa detik.'
            : rounds > 0
              ? 'Belum ada akor yang jelas.'
              : waiting}
        </span>
      </div>
    </div>
  );
}
