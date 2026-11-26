import { lazy, Suspense, useEffect } from 'react';
import { useLive } from './live/store';
import { initEngine } from './store/controller';
import { closeDrawers, setUi, usePlayer } from './store/player';
import { CalibrationDialog } from './ui/Calibration';
import { DropOverlay, HelpDialog, SettingsDrawer, Toasts } from './ui/Dialogs';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { cls } from './ui/hooks';
import { LibraryPanel } from './ui/LibraryPanel';
import { useIdleCursor, useShortcuts } from './ui/shortcuts';
import { NowPlayingOverlay, Stage, WorldSwitcher } from './ui/Stage';
import { TipLayer } from './ui/Tip';
import { TopBar } from './ui/TopBar';
import { Transport } from './ui/Transport';
import { LyricsOverlay } from './ui/LyricsOverlay';
import { LyricsPanel } from './ui/LyricsPanel';
import { Welcome } from './ui/Welcome';

// Each mode's views load the first time that mode is opened, so the first
// visit only downloads what listening needs.
const named = <T,>(load: () => Promise<T>, key: keyof T) =>
  lazy(async () => ({ default: (await load())[key] as React.ComponentType }));
const StudioPanel = named(() => import('./ui/studio/StudioPanel'), 'StudioPanel');
const StemLanes = named(() => import('./ui/stems/StemLanes'), 'StemLanes');
const StemPanel = named(() => import('./ui/stems/StemPanel'), 'StemPanel');
const MusicHud = named(() => import('./ui/understand/MusicHud'), 'MusicHud');
const SongMap = named(() => import('./ui/understand/SongMap'), 'SongMap');
const UnderstandPanel = named(() => import('./ui/understand/UnderstandPanel'), 'UnderstandPanel');
const SonicMap = named(() => import('./ui/SonicMap'), 'SonicMap');
const MeterBridge = named(() => import('./ui/meters/MeterBridge'), 'MeterBridge');

export default function App() {
  const ui = usePlayer((s) => s.ui);
  // A captured tab counts as something to play, even with an empty library.
  const liveOn = useLive((s) => s.on);
  const hasTracks = usePlayer((s) => s.order.length > 0) || liveOn;
  const hasNow = usePlayer((s) => s.now !== null);
  const world = usePlayer((s) => s.settings.world);
  const meters = usePlayer((s) => s.settings.meters) && hasNow && !ui.hidden && !ui.sonicMap;
  const understand = ui.mode === 'pahami';
  const shape = ui.mode === 'bentuk';
  const stem = ui.mode === 'stem';

  useEffect(() => {
    void initEngine();
  }, []);
  useShortcuts();
  useIdleCursor(ui.hidden);

  return (
    <div
      className={cls(
        'app',
        hasTracks && ui.library && 'with-library',
        hasTracks && ui.inspector && 'with-inspector',
        ui.hidden && 'stage-mode',
        !hasTracks && 'is-empty',
        understand && 'mode-pahami',
        shape && 'mode-bentuk',
        stem && 'mode-stem',
      )}
    >
      <Stage />
      <TopBar />
      {hasTracks && ui.library && <LibraryPanel />}
      {hasTracks && (ui.library || ui.inspector) && (
        // Small screens only (CSS): tapping the stage behind a drawer closes it.
        <div className="drawer-scrim" aria-hidden="true" onClick={closeDrawers} />
      )}
      <main className={cls('center', meters && 'with-meters')} aria-label="Panggung" data-world={world}>
        <ErrorBoundary resetKey={`${ui.mode}:${ui.sonicMap}`} className="crash-center">
        <Suspense fallback={null}>
          {hasTracks && ui.sonicMap ? (
            <SonicMap />
          ) : (
            <>
              {hasNow && <WorldSwitcher />}
              {!hasTracks && <Welcome />}
              {understand && hasNow && <MusicHud />}
              {hasNow && <LyricsOverlay />}
              {/* Racik's stage is just the visuals and lyrics; the title is already in the transport. */}
              {understand && hasNow ? <SongMap /> : stem && hasNow ? <StemLanes /> : shape ? null : <NowPlayingOverlay />}
              {meters && <MeterBridge />}
            </>
          )}
        </Suspense>
        </ErrorBoundary>
      </main>
      {hasTracks && ui.inspector && (
        <ErrorBoundary resetKey={ui.mode} className="inspector panel crash-panel">
          <Suspense fallback={null}>
            {understand ? <UnderstandPanel /> : shape ? <StudioPanel /> : stem ? <StemPanel /> : <LyricsPanel />}
          </Suspense>
        </ErrorBoundary>
      )}
      {hasTracks && <Transport />}
      <SettingsDrawer />
      {ui.hidden && (
        <button className="stage-exit" onClick={() => setUi({ hidden: false })}>
          Tampilkan UI <kbd>H</kbd>
        </button>
      )}
      <CalibrationDialog />
      <HelpDialog />
      <Toasts />
      <TipLayer />
      <DropOverlay />
    </div>
  );
}
