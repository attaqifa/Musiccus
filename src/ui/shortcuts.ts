import { useEffect } from 'react';
import { useLyrics } from '../lyrics/lyrics';
import { next, prev, seekBy, setVolume, toggleMute, togglePlay } from '../store/controller';
import { closeDrawers, compactQuery, getState, setSettings, setUi } from '../store/player';
import { getStudio, setCompare } from '../studio/store';
import { claimMediaKey } from './mediaSession';

function isTyping(el: EventTarget | null) {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const s = getState();
      const overlay = s.ui.settings || s.ui.calibration || s.ui.help;
      switch (e.key) {
        case ' ':
          if (e.target instanceof HTMLButtonElement) return;
          e.preventDefault();
          void togglePlay();
          break;
        // Media keys may also reach the media session; whichever path comes first acts.
        case 'MediaPlayPause':
          e.preventDefault();
          if (claimMediaKey('toggle')) void togglePlay();
          break;
        case 'MediaTrackNext':
          if (claimMediaKey('next')) void next();
          break;
        case 'MediaTrackPrevious':
          if (claimMediaKey('prev')) void prev();
          break;
        case 'ArrowRight':
          seekBy(e.shiftKey ? 30 : 5);
          break;
        case 'ArrowLeft':
          seekBy(e.shiftKey ? -30 : -5);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setVolume(s.settings.volumeDb + 1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          setVolume(s.settings.volumeDb - 1);
          break;
        case 'n':
        case 'N':
          void next();
          break;
        case 'p':
        case 'P':
          void prev();
          break;
        case 'm':
        case 'M':
          toggleMute();
          break;
        case '1':
          setSettings({ world: 'nebula', director: false });
          break;
        case '2':
          setSettings({ world: 'terrain', director: false });
          break;
        case '3':
          setSettings({ world: 'stereo', director: false });
          break;
        case '4':
          setSettings({ world: 'aurora', director: false });
          break;
        case 'u':
        case 'U':
          setUi({ mode: s.ui.mode === 'pahami' ? 'dengar' : 'pahami', inspector: true, hidden: false });
          break;
        case 'b':
        case 'B':
          setUi({ mode: s.ui.mode === 'bentuk' ? 'dengar' : 'bentuk', inspector: true, hidden: false });
          break;
        case 'a':
        case 'A':
          // Tap to switch to the original and back; hold to hear it only while held.
          if (e.repeat) break;
          if (getStudio().compare) {
            setCompare(false);
            compareSince = 0;
          } else {
            setCompare(true);
            compareSince = performance.now();
          }
          break;
        case 'y':
        case 'Y':
          useLyrics.setState((l) => ({ show: !l.show }));
          break;
        case 'g':
        case 'G':
          if (s.order.length) setUi({ sonicMap: !s.ui.sonicMap, hidden: false });
          break;
        case 's':
        case 'S':
          setUi({ mode: s.ui.mode === 'stem' ? 'dengar' : 'stem', inspector: true, hidden: false });
          break;
        case 'd':
        case 'D':
          setSettings({ director: !s.settings.director });
          break;
        case 'o':
        case 'O':
          setSettings({ meters: !s.settings.meters });
          if (s.ui.hidden) setUi({ hidden: false });
          break;
        case 'h':
        case 'H':
          setUi({ hidden: !s.ui.hidden });
          break;
        case 'l':
        case 'L':
          setUi({ library: !s.ui.library, hidden: false });
          break;
        case 'i':
        case 'I':
          setUi({ inspector: !s.ui.inspector, hidden: false });
          break;
        case 'f':
        case 'F':
          if (document.fullscreenElement) void document.exitFullscreen();
          else void document.documentElement.requestFullscreen?.();
          break;
        case ',':
          setUi({ settings: !s.ui.settings });
          break;
        case 'q':
        case 'Q':
          if (s.now && !s.tracks[s.now.trackId]?.live) setUi({ queue: !s.ui.queue, hidden: false });
          break;
        case '?':
          setUi({ help: !s.ui.help });
          break;
        case 'Escape':
          if (overlay) setUi({ settings: false, calibration: false, help: false });
          else if (s.ui.queue) setUi({ queue: false });
          else if (s.ui.sonicMap) setUi({ sonicMap: false });
          else if (s.ui.hidden) setUi({ hidden: false });
          else if (compactQuery?.matches && (s.ui.library || s.ui.inspector)) closeDrawers();
          break;
        default:
          return;
      }
    };
    let compareSince = 0;
    const onKeyUp = (e: KeyboardEvent) => {
      if ((e.key === 'a' || e.key === 'A') && compareSince && performance.now() - compareSince > 350) setCompare(false);
      if (e.key === 'a' || e.key === 'A') compareSince = 0;
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);
}

/** Hides the cursor after a moment of stillness while the UI is hidden. */
export function useIdleCursor(active: boolean) {
  useEffect(() => {
    if (!active) {
      document.body.classList.remove('idle');
      return;
    }
    let t = 0;
    const wake = () => {
      document.body.classList.remove('idle');
      window.clearTimeout(t);
      t = window.setTimeout(() => document.body.classList.add('idle'), 2200);
    };
    wake();
    window.addEventListener('pointermove', wake);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('pointermove', wake);
      document.body.classList.remove('idle');
    };
  }, [active]);
}
