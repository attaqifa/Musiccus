import { useAnalysis } from '../analysis/manager';
import { formatRate } from '../lib/format';
import { usePlayer } from '../store/player';
import { fileQuality } from './fileQuality';
import { cls } from './hooks';
import { SignalPath } from './SignalPath';

/** The quality check, file facts, and signal path of the playing file. */
export function FileInfo() {
  const now = usePlayer((s) => s.now);
  const track = usePlayer((s) => (s.now ? s.tracks[s.now.trackId] : undefined));
  const { analysis, status } = useAnalysis(now?.trackId);
  if (!now || !track || track.live) return null;
  const m = track.meta;
  const bits = m?.bitsPerSample ? `${m.bitsPerSample}-bit` : null;
  const q = fileQuality(analysis, m, now.sourceRate);
  const facts: [string, string][] = [
    ['Format', m?.codec ?? '—'],
    ['Resolusi', [bits, formatRate(now.sourceRate)].filter(Boolean).join(' / ')],
    ...(m?.bitrate ? [['Bitrate', `${Math.round(m.bitrate / 1000)} kbps`] as [string, string]] : []),
    ['Saluran', now.channels === 1 ? 'Mono' : now.channels === 2 ? 'Stereo' : `${now.channels} saluran`],
  ];
  return (
    <>
      {q ? (
        <>
          <p className={cls('fq-verdict', `tone-${q.tone}`)}>{q.verdict}</p>
          <p className="fq-note">{q.note}</p>
        </>
      ) : (
        <p className="fq-note">{status?.state === 'error' ? 'Kualitas file tidak bisa dicek untuk lagu ini.' : 'Sedang dicek bersama analisis lagu…'}</p>
      )}
      <dl className="fq-facts">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <SignalPath />
    </>
  );
}
