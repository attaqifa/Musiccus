import { LoaderCircle, MicVocal, Pause, Play, SkipBack, SkipForward, Square, Volume2, VolumeX } from 'lucide-react';
import { useRef } from 'react';
import { engine } from '../audio/engine';
import { formatTime } from '../lib/format';
import { useLive } from '../live/store';
import { useLyrics } from '../lyrics/lyrics';
import { next, prev, setLiveMonitor, setVolume, stopListening, toggleMute, togglePlay } from '../store/controller';
import { usePlayer } from '../store/player';
import { Cover } from './Cover';
import { cls, useHub } from './hooks';
import { PrismLine } from './PrismLine';
import { QueueButton, RepeatButton, ShuffleButton } from './QueuePop';
import { SoundChip } from './SoundChip';
import { WaveSeek } from './WaveSeek';

/** The volume slider runs in dB (−60 to 0); people read it as a percentage. */
const volumePct = (db: number) => Math.round(((db + 60) / 60) * 100);

export function Transport() {
  const now = usePlayer((s) => s.now);
  const track = usePlayer((s) => (s.now ? s.tracks[s.now.trackId] : undefined));
  const status = usePlayer((s) => s.status);
  const settings = usePlayer((s) => s.settings);
  const hasQueue = usePlayer((s) => s.queue.length > 0 || s.order.length > 0);
  const live = useLive((s) => (s.on ? s : null));
  const elapsed = useRef<HTMLSpanElement>(null);
  const remain = useRef<HTMLSpanElement>(null);
  const last = useRef('');

  useHub(() => {
    const p = engine.position();
    const a = p ? formatTime(p.time) : '0:00';
    const b = p && !p.live ? `−${formatTime(p.duration - p.time)}` : '';
    const key = a + b;
    if (key === last.current) return;
    last.current = key;
    if (elapsed.current) elapsed.current.textContent = a;
    if (remain.current) remain.current.textContent = b;
  });

  const m = track?.meta;
  const title = m?.title || track?.name.replace(/\.[^.]+$/, '') || 'Belum ada lagu';
  const sub = live
    ? m?.artist || 'Suara dari tab browser'
    : track
      ? [m?.artist, m?.album].filter(Boolean).join(' — ') || track.path
      : 'Pilih lagu dari library';
  const playing = status === 'playing';
  // Without monitoring the tab plays its own sound, so the volume belongs to the tab.
  const ownVolume = !live || live.monitor;
  const liveNote = !live
    ? ''
    : live.silent
      ? 'Senyap: tab dijeda, atau lagunya berganti.'
      : live.monitor
        ? 'Jeda dan ganti lagu di tab sumbernya.'
        : 'Suara tetap dari tab aslinya.';

  return (
    <footer className="transport panel">
      <PrismLine />
      <div className="tp-track">
        {now ? <Cover trackId={now.trackId} size={48} /> : <div className="cover empty" style={{ width: 48, height: 48 }} />}
        <div className="tp-meta">
          <span className="tp-title" title={title}>
            {title}
          </span>
          <span className="tp-sub" title={sub}>
            {sub}
          </span>
        </div>
      </div>

      {live ? (
        <div className="tp-controls">
          <button className="play-btn stop" onClick={() => stopListening()} aria-label="Berhenti dengar tab" title="Berhenti dengar tab">
            <Square size={17} fill="currentColor" />
          </button>
        </div>
      ) : (
      <div className="tp-controls">
        <ShuffleButton className="tp-mode" />
        <button className="icon-btn" onClick={() => void prev()} disabled={!now} aria-label="Sebelumnya" title="Sebelumnya (P)">
          <SkipBack size={18} />
        </button>
        <button
          className={cls('play-btn', playing && 'playing')}
          onClick={() => void togglePlay()}
          disabled={!hasQueue}
          aria-label={playing ? 'Jeda' : 'Putar'}
          title={playing ? 'Jeda (Spasi)' : 'Putar (Spasi)'}
        >
          {status === 'loading' ? <LoaderCircle size={22} className="spin" /> : playing ? <Pause size={22} /> : <Play size={22} />}
        </button>
        <button className="icon-btn" onClick={() => void next()} disabled={!now} aria-label="Berikutnya" title="Berikutnya (N)">
          <SkipForward size={18} />
        </button>
        <RepeatButton className="tp-mode" />
      </div>
      )}

      {live ? (
        <div className="tp-seek tp-live" role="status">
          <span className={cls('live-badge', live.silent && 'quiet')} title="Suara langsung dari tab">
            <i aria-hidden="true" />
            LIVE
          </span>
          <span className="tp-time" ref={elapsed} title="Lama suara terdengar">
            0:00
          </span>
          <span className="tp-live-note" title={liveNote}>
            {liveNote}
          </span>
          <button
            className="link tp-live-fix"
            onClick={() => setLiveMonitor(!live.monitor)}
            title={live.monitor ? 'Biarkan tab memutar suaranya sendiri; Musiccus menampilkan visualnya saja' : 'Putar suara tab lewat Musiccus'}
          >
            {live.monitor ? 'Suaranya dobel?' : 'Tidak ada suara?'}
          </button>
        </div>
      ) : (
        <div className="tp-seek">
          <span className="tp-time" ref={elapsed}>
            0:00
          </span>
          <WaveSeek />
          <span className="tp-time right" ref={remain} />
        </div>
      )}

      <div className="tp-right">
        <SoundChip />
        <LyricsButton />
        {!live && <QueueButton />}
        <button
          className="icon-btn"
          onClick={toggleMute}
          disabled={!ownVolume}
          aria-label={settings.muted ? 'Bunyikan' : 'Bisukan'}
          title={ownVolume ? 'Mute (M)' : 'Volume diatur di tab sumbernya'}
        >
          {settings.muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
        </button>
        <input
          className="tp-volume"
          type="range"
          min={-60}
          max={0}
          step={0.5}
          value={settings.muted ? -60 : settings.volumeDb}
          disabled={!ownVolume}
          onChange={(e) => setVolume(Number(e.target.value))}
          aria-label="Volume"
          aria-valuetext={settings.muted ? 'Mute' : `${volumePct(settings.volumeDb)}%`}
          title={ownVolume ? `Volume ${settings.muted ? 'mute' : `${volumePct(settings.volumeDb)}%`} (↑ ↓)` : 'Volume diatur di tab sumbernya'}
        />
      </div>
    </footer>
  );
}

/** Kinetic lyrics over the visuals, on or off; only shown when the song has timed lyrics. */
function LyricsButton() {
  const nowId = usePlayer((s) => s.now?.trackId);
  const has = useLyrics((s) => !!(nowId && s.timed[nowId]?.length));
  const show = useLyrics((s) => s.show);
  if (!has) return null;
  return (
    <button
      className={cls('icon-btn mode-btn', show && 'on')}
      onClick={() => useLyrics.setState({ show: !show })}
      aria-pressed={show}
      aria-label="Lirik di atas visual"
      title={show ? 'Sembunyikan lirik di atas visual (Y)' : 'Tampilkan lirik di atas visual (Y)'}
    >
      <MicVocal size={17} />
    </button>
  );
}
