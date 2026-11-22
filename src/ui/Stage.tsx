import { Clapperboard, InfinityIcon, MicVocal, Mountain, Orbit, Sparkles, Square, Video } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAnalysis } from '../analysis/manager';
import { keyName } from '../analysis/theory';
import { hub } from '../audio/hub';
import { isChunkError, reloadForUpdate } from '../lib/update';
import { useLive } from '../live/store';
import { getState, renderQuality, setSettings, toast, usePlayer, type WorldId } from '../store/player';
import { recordingSupported, startRecording, stopRecording, useRecorder } from '../visual/recorder';
import type { VisualEngine } from '../visual/VisualEngine';
import { useLyrics } from '../lyrics/lyrics';
import { cls } from './hooks';

/** Full-window WebGL stage that sits behind every panel. */
export function Stage() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<VisualEngine | null>(null);
  const world = usePlayer((s) => s.settings.world);
  const quality = usePlayer((s) => renderQuality(s.settings.quality));
  const [veil, setVeil] = useState(true);
  const [failed, setFailed] = useState(false);
  const initial = useRef({ world, quality });

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let cancelled = false;
    let cleanup = () => {};
    // Three.js is the largest dependency: load it after the first paint.
    void import('../visual/VisualEngine').then(({ VisualEngine: Engine }) => {
      if (cancelled) return;
      let ve: VisualEngine;
      try {
        ve = new Engine(el, usePlayer.getState().settings.world, initial.current.quality);
      } catch {
        setFailed(true);
        return;
      }
      engineRef.current = ve;
      const unsub = hub.subscribe((s) => ve.frame(s));
      const t = window.setTimeout(() => setVeil(false), 120);
      cleanup = () => {
        window.clearTimeout(t);
        unsub();
        ve.dispose();
        engineRef.current = null;
      };
    }).catch((err: unknown) => {
      // The visual engine's file is gone after a new deploy: reload once.
      if (isChunkError(err)) reloadForUpdate();
    });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  // The engine crossfades between worlds itself; the veil only covers the first load.
  useEffect(() => engineRef.current?.setWorld(world), [world]);

  useEffect(() => engineRef.current?.setQuality(quality), [quality]);

  return (
    <>
      <canvas ref={canvas} className="stage-canvas" aria-hidden="true" />
      <div className={cls('stage-veil', veil && 'on')} aria-hidden="true" />
      {failed && <p className="stage-fail">WebGL tidak tersedia di browser ini, jadi visual dimatikan. Audio dan meter tetap berjalan.</p>}
    </>
  );
}

const WORLDS: { id: WorldId; label: string; icon: typeof Orbit; hint: string }[] = [
  { id: 'nebula', label: 'Nebula', icon: Orbit, hint: 'Galaksi partikel: bass jadi massa, kick jadi gelombang kejut, hi-hat jadi percikan.' },
  { id: 'terrain', label: 'Lanskap', icon: Mountain, hint: 'Lanskap spektral: dinding bass di kiri-kanan, treble di lembah, rel cahaya di setiap beat.' },
  {
    id: 'stereo',
    label: 'Stereo',
    icon: InfinityIcon,
    hint: 'Medan stereo: goniometer jadi jejak cahaya. Garis tegak berarti mono, sebaran lebar berarti stereo lebar, mendatar berarti fase berlawanan.',
  },
  { id: 'aurora', label: 'Aurora', icon: Sparkles, hint: 'Tirai cahaya di atas danau; mid melipat tirai, bass menyalakannya.' },
];

export function WorldSwitcher() {
  const world = usePlayer((s) => s.settings.world);
  const director = usePlayer((s) => s.settings.director);
  const pick = (id: WorldId) => {
    if (getState().settings.director) toast('Sutradara otomatis dimatikan karena Anda memilih world sendiri.');
    setSettings({ world: id, director: false });
  };
  return (
    <div className="world-switch">
      <div role="radiogroup" aria-label="Visual world">
        {WORLDS.map((w, i) => (
          <button
            key={w.id}
            role="radio"
            aria-checked={world === w.id}
            aria-label={w.label}
            className={cls(world === w.id && 'on')}
            onClick={() => pick(w.id)}
            title={`${w.hint} (${i + 1})`}
          >
            <w.icon size={14} aria-hidden="true" />
            <span className="ws-label">{w.label}</span>
          </button>
        ))}
      </div>
      <LyricsToggle />
      <RecordButton />
      <button
        className={cls('director', director && 'on')}
        aria-pressed={director}
        onClick={() => setSettings({ director: !director })}
        title="Ganti visual otomatis di setiap bagian lagu, tepat di ketukannya (D)"
      >
        <Clapperboard size={14} aria-hidden="true" />
        Auto
      </button>
    </div>
  );
}

function RecordButton() {
  const state = useRecorder((r) => r.state);
  const startedAt = useRecorder((r) => r.startedAt);
  // Recording a captured tab would copy someone else's stream; only own files are recorded.
  const live = useLive((s) => s.on);
  const [, tick] = useState(0);
  useEffect(() => {
    if (state !== 'recording') return;
    const t = window.setInterval(() => tick((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, [state]);
  if (!recordingSupported() || (live && state !== 'recording')) return null;
  if (state === 'recording') {
    const sec = Math.floor((performance.now() - startedAt) / 1000);
    return (
      <button className="director rec on" onClick={stopRecording} title="Hentikan dan simpan video">
        <Square size={12} aria-hidden="true" />
        {`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`}
      </button>
    );
  }
  return (
    <button
      className="director"
      disabled={state === 'saving'}
      onClick={() => void startRecording()}
      title="Rekam video: visual dan audio hasil olahan, dari awal lagu sampai selesai. Berjalan real time."
    >
      <Video size={14} aria-hidden="true" />
      Rekam
    </button>
  );
}

function LyricsToggle() {
  const nowId = usePlayer((s) => s.now?.trackId);
  const has = useLyrics((s) => !!(nowId && s.timed[nowId]?.length));
  const show = useLyrics((s) => s.show);
  if (!has) return null;
  return (
    <button className={cls('director', show && 'on')} aria-pressed={show} onClick={() => useLyrics.setState({ show: !show })} title="Lirik di atas visual (Y)">
      <MicVocal size={14} aria-hidden="true" />
      Lirik
    </button>
  );
}

/**
 * Title, artist, and one line of music above them: the song's key and tempo in
 * the key's own colour. File quality lives in the top bar's pill, not here.
 */
export function NowPlayingOverlay() {
  const now = usePlayer((s) => s.now);
  const track = usePlayer((s) => (s.now ? s.tracks[s.now.trackId] : undefined));
  const { analysis } = useAnalysis(track?.live ? undefined : now?.trackId);
  if (!now || !track) return null;
  const m = track.meta;
  const title = m?.title || track.name.replace(/\.[^.]+$/, '');
  const sub = [m?.artist, m?.album].filter(Boolean).join(', ') + (m?.year ? ` (${m.year})` : '');
  return (
    <div className="np-overlay" key={now.trackId}>
      <p className="np-eyebrow">{track.live ? 'Live dari tab' : analysis ? `${keyName(analysis.key)}, ${Math.round(analysis.bpm)} BPM` : ''}</p>
      <h1 className="np-title">{title}</h1>
      <p className="np-sub">{track.live ? m?.artist || 'Suara dari tab browser' : sub || track.path}</p>
    </div>
  );
}
