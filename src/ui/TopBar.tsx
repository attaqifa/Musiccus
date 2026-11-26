import { Activity, CircleHelp, Eye, MicVocal, PanelLeft, PanelRight, Settings2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAnalysis } from '../analysis/manager';
import { formatRate } from '../lib/format';
import { TIER_LABEL, tierOf } from '../library/metadata';
import { isCompact, setSettings, setUi, usePlayer, type Mode } from '../store/player';
import { FileInfo } from './FileInfo';
import { fileQuality } from './fileQuality';
import { cls } from './hooks';

/** Two-arm swirl, the Nebula visual in miniature: one arm signal white, the other the song's key colour. Same paths as public/favicon.svg. */
const ARM_A = 'M45.3 32.0 45.3 33.5 45.3 35.0 45.0 36.6 44.6 38.1 44.0 39.6 43.3 41.0 42.4 42.4 41.3 43.7 40.1 44.8 38.7 45.9 37.2 46.8 35.6 47.6 33.8 48.2 32.0 48.7 30.1 48.9 28.1 48.9 26.1 48.7 24.1 48.3 22.1 47.7 20.2 46.8 18.3 45.7 16.5 44.4 14.8 42.8 13.2 41.0 11.8 39.1 10.6 36.9 9.7 34.5 9.0 32.0 L10.1 34.5 11.4 36.7 12.9 38.7 14.5 40.4 16.3 41.9 18.1 43.1 20.0 44.0 21.9 44.7 23.8 45.1 25.6 45.3 27.4 45.3 29.0 45.1 30.6 44.7 32.0 44.1 33.3 43.4 34.4 42.6 35.4 41.7 36.2 40.8 36.9 39.8 37.4 38.7 37.7 37.7 37.9 36.7 38.0 35.8 37.9 34.9 37.8 34.0 37.5 33.3 37.2 32.6 36.8 32.0 A4.25 4.25 0 0 1 45.3 32.0Z';
const ARM_B = 'M18.7 32.0 18.7 30.5 18.7 29.0 19.0 27.4 19.4 25.9 20.0 24.4 20.7 23.0 21.6 21.6 22.7 20.3 23.9 19.2 25.3 18.1 26.8 17.2 28.4 16.4 30.2 15.8 32.0 15.3 33.9 15.1 35.9 15.1 37.9 15.3 39.9 15.7 41.9 16.3 43.8 17.2 45.7 18.3 47.5 19.6 49.2 21.2 50.8 23.0 52.2 24.9 53.4 27.1 54.3 29.5 55.0 32.0 L53.9 29.5 52.6 27.3 51.1 25.3 49.5 23.6 47.7 22.1 45.9 20.9 44.0 20.0 42.1 19.3 40.2 18.9 38.4 18.7 36.6 18.7 35.0 18.9 33.4 19.3 32.0 19.9 30.7 20.6 29.6 21.4 28.6 22.3 27.8 23.2 27.1 24.2 26.6 25.3 26.3 26.3 26.1 27.3 26.0 28.2 26.1 29.1 26.2 30.0 26.5 30.7 26.8 31.4 27.3 32.0 A4.25 4.25 0 0 1 18.7 32.0Z';

export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d={ARM_A} fill="var(--signal)" />
      <path d={ARM_B} fill="var(--key)" />
      <circle cx="32" cy="32" r="4.2" fill="var(--signal)" />
    </svg>
  );
}

const MODES: { id: Mode; label: string; hint: string; kbd: string }[] = [
  { id: 'dengar', label: 'Dengar', hint: 'Visual yang hidup mengikuti musik, dengan lirik yang bergerak di setiap kata.', kbd: 'U' },
  { id: 'pahami', label: 'Pahami', hint: 'Kenali lagunya: tempo, kunci, akor, dan bagian-bagiannya.', kbd: 'U' },
  { id: 'bentuk', label: 'Racik', hint: 'Atur rasa suara: bass lebih tebal, slowed + reverb, kecepatan, dan nada.', kbd: 'B' },
  { id: 'stem', label: 'Stem', hint: 'Pisahkan vokal, drum, dan bass: untuk karaoke atau menikmati satu instrumen.', kbd: 'S' },
];

/** The file's quality in one word (Hi-Res, Lossless, Lossy); click for the quality check. */
function FormatPill() {
  const now = usePlayer((s) => s.now);
  const track = usePlayer((s) => (s.now ? s.tracks[s.now.trackId] : undefined));
  const { analysis } = useAnalysis(now?.trackId);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  useEffect(() => setOpen(false), [now?.trackId]);

  if (!now || !track) return null;
  if (track.live) {
    return (
      <div className="fp-wrap">
        <span className="format-pill tier-unknown" data-tip="Suara dari tab browser. Kualitasnya mengikuti layanan musiknya.">
          <span className="fp-tier">Live</span>
          <span className="fp-spec">Tab {formatRate(now.sourceRate)}</span>
        </span>
      </div>
    );
  }
  const m = track.meta;
  const tier = tierOf(m);
  // The way players print it: "FLAC 24-bit/96 kHz".
  const rate = formatRate(now.sourceRate);
  const spec = [m?.codec, m?.bitsPerSample ? `${m.bitsPerSample}-bit/${rate}` : rate].filter(Boolean).join(' ');
  const q = fileQuality(analysis, m, now.sourceRate);

  return (
    <div className="fp-wrap" ref={root}>
      <button
        className={cls('format-pill', `tier-${tier}`, q?.tone === 'warn' && 'suspect')}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-tip="Kualitas file dan jalur suara"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="fp-tier">{TIER_LABEL[tier]}</span>
        <span className="fp-spec">{spec}</span>
        {q?.tone === 'warn' && <i className="fp-flag" aria-label={q.verdict} />}
      </button>
      {open && (
        <div className="fp-pop panel" role="dialog" aria-label="Kualitas file dan jalur suara">
          <FileInfo />
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const ui = usePlayer((s) => s.ui);
  const hasTracks = usePlayer((s) => s.order.length > 0);
  const meters = usePlayer((s) => s.settings.meters);
  const hasNow = usePlayer((s) => s.now !== null);
  return (
    <header className="topbar">
      <div className="brand">
        <BrandMark />
        <span className="brand-name">Musiccus</span>
      </div>
      <nav className="modes" aria-label="Mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            className={cls('mode', m.id === ui.mode && 'active')}
            aria-current={m.id === ui.mode ? 'page' : undefined}
            data-tip={m.hint}
            data-kbd={m.kbd}
            aria-keyshortcuts={m.kbd}
            // On a phone the lyrics drawer would cover the visual; Dengar shows
            // the lyrics over the stage instead, so only the tool modes open it.
            onClick={() => setUi({ mode: m.id, inspector: m.id === 'dengar' && isCompact() ? ui.inspector && ui.mode === 'dengar' : true })}
          >
            {m.label}
          </button>
        ))}
      </nav>
      <div className="tb-center">
        <FormatPill />
      </div>
      <div className="tb-actions">
        {hasTracks && (
          <button
            className={cls('icon-btn', ui.library && 'on')}
            onClick={() => setUi({ library: !ui.library })}
            aria-pressed={ui.library}
            aria-label="Koleksi lagu"
            aria-keyshortcuts="L"
            data-tip="Koleksi lagu"
            data-kbd="L"
          >
            <PanelLeft size={17} />
          </button>
        )}
        <button
          className={cls('icon-btn', ui.inspector && 'on')}
          onClick={() => setUi({ inspector: !ui.inspector })}
          aria-pressed={ui.inspector}
          aria-label={ui.mode === 'dengar' ? 'Panel lirik' : 'Panel kanan'}
          aria-keyshortcuts="I"
          data-tip={ui.mode === 'dengar' ? 'Panel lirik' : 'Panel kanan'}
          data-kbd="I"
        >
          {ui.mode === 'dengar' ? <MicVocal size={17} /> : <PanelRight size={17} />}
        </button>
        {hasNow && (
          <button
            className={cls('icon-btn', meters && 'on')}
            onClick={() => setSettings({ meters: !meters })}
            aria-pressed={meters}
            aria-label="Pantau"
            aria-keyshortcuts="O"
            data-tip="Pantau: meter level, loudness, spektrum, dan stereo"
            data-kbd="O"
          >
            <Activity size={17} />
          </button>
        )}
        <button className="icon-btn" onClick={() => setUi({ hidden: true })} aria-label="Mode panggung" aria-keyshortcuts="H" data-tip="Mode panggung: sembunyikan semua kontrol" data-kbd="H">
          <Eye size={17} />
        </button>
        {/* View toggles on the left of the rule, the app itself on the right. */}
        <span className="tb-rule" aria-hidden="true" />
        <button className={cls('icon-btn', ui.settings && 'on')} onClick={() => setUi({ settings: !ui.settings })} aria-label="Pengaturan" aria-keyshortcuts="," data-tip="Pengaturan" data-kbd=",">
          <Settings2 size={17} />
        </button>
        <button className="icon-btn tb-help" onClick={() => setUi({ help: true })} aria-label="Panduan" aria-keyshortcuts="?" data-tip="Panduan mode ini dan pintasan" data-kbd="?">
          <CircleHelp size={17} />
        </button>
      </div>
    </header>
  );
}
