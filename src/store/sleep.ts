import { engine } from '../audio/engine';
import { requeue, togglePlay } from './controller';
import { getState, toast, usePlayer } from './player';

/**
 * Timer tidur: after a number of minutes the music fades out and pauses, or
 * it stops at the end of the playing song. The timer lives only in this
 * session; a reload clears it.
 */

const FADE_S = 10;

export const SLEEP_CHOICES = [15, 30, 45, 60] as const;

let timer = 0;
let fading = false;

/** Minutes from now, 'track' for the end of this song, or null to turn it off. */
export function setSleep(choice: number | 'track' | null) {
  window.clearTimeout(timer);
  if (fading) engine.endFade();
  if (choice === null) usePlayer.setState({ sleep: null });
  else if (choice === 'track') usePlayer.setState({ sleep: { kind: 'track' } });
  else {
    const at = Date.now() + choice * 60_000;
    usePlayer.setState({ sleep: { kind: 'time', at, minutes: choice } });
    arm(at);
  }
  // 'Akhir lagu' must keep the next song from being lined up gaplessly.
  requeue();
}

function arm(at: number) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void fire(), Math.max(0, at - Date.now()));
}

/** Waits out a song change in progress, so the pause lands on the song that plays. */
function settled(): Promise<void> {
  return new Promise((resolve) => {
    if (getState().status !== 'loading') return resolve();
    const off = usePlayer.subscribe((s) => {
      if (s.status === 'loading') return;
      off();
      resolve();
    });
  });
}

async function fire() {
  const s = getState();
  const sleep = s.sleep;
  if (sleep?.kind !== 'time') return;
  // Timers can fire early or late while the tab sleeps; the clock decides.
  if (Date.now() < sleep.at - 500) return arm(sleep.at);
  const t = s.now ? s.tracks[s.now.trackId] : undefined;
  if (t?.live || (s.status !== 'playing' && s.status !== 'loading')) {
    usePlayer.setState({ sleep: null });
    if (t?.live) toast('Timer tidur selesai. Musik dari tab dijeda di tab sumbernya.');
    return;
  }
  fading = true;
  const finished = await engine.fadeOut(FADE_S);
  fading = false;
  if (!finished) {
    // Cut short by the volume or a pause: someone is still listening.
    if (getState().sleep === sleep) usePlayer.setState({ sleep: null });
    if (getState().status === 'playing') toast('Timer tidur dibatalkan.');
    return;
  }
  usePlayer.setState({ sleep: null });
  await settled();
  if (getState().status === 'playing') await togglePlay();
  engine.restoreVolume();
  toast('Timer tidur: musik dijeda.');
}

// Pausing or stopping during the fade ends it, so play starts at full volume again.
usePlayer.subscribe((s, p) => {
  if (fading && s.status !== p.status && (s.status === 'paused' || s.status === 'idle' || s.status === 'ended')) engine.endFade();
});
