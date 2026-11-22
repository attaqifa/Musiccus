/**
 * "Dengar dari tab": the sound of another browser tab (Spotify, YouTube
 * Music) captured with getDisplayMedia. Nothing is downloaded or stored; the
 * browser hands Musiccus the tab's sound while it plays, the same way it
 * would for a video call. Only Chromium browsers on a computer can share a
 * tab's audio.
 */

export interface TabCapture {
  stream: MediaStream;
  audio: MediaStreamTrack;
  /** The browser muted the tab, so Musiccus must play its sound. */
  monitor: boolean;
  rate: number;
  /** What the browser calls the shared tab, when it says (often the page title). */
  label: string;
}

/** Chrome, Edge, Brave and Opera on a computer. */
export function tabCaptureSupported(): boolean {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!md?.getDisplayMedia || !md.getSupportedConstraints) return false;
  // Only browsers that can mute the shared tab also share its sound.
  return !!(md.getSupportedConstraints() as Record<string, boolean | undefined>).suppressLocalAudioPlayback;
}

export class TabCaptureError extends Error {}

/** Opens the browser's share picker. Resolves null when the listener cancels. */
export async function captureTab(): Promise<TabCapture | null> {
  const options = {
    // The picture is not used; keep it as small and slow as the browser allows.
    video: { displaySurface: 'browser', frameRate: { ideal: 1, max: 5 }, width: { ideal: 320 }, height: { ideal: 180 } },
    audio: {
      suppressLocalAudioPlayback: true,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    preferCurrentTab: false,
    selfBrowserSurface: 'exclude',
    systemAudio: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'exclude',
  } as DisplayMediaStreamOptions;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(options);
  } catch (e) {
    const name = (e as DOMException)?.name;
    // Closing the picker is a choice, not an error.
    if (name === 'NotAllowedError' || name === 'AbortError') return null;
    throw new TabCaptureError('Browser ini tidak bisa membagikan suara tab.', { cause: e });
  }

  const audio = stream.getAudioTracks()[0];
  const video = stream.getVideoTracks()[0];
  if (!audio) {
    for (const t of stream.getTracks()) t.stop();
    const surface = video?.getSettings().displaySurface;
    throw new TabCaptureError(
      surface && surface !== 'browser'
        ? 'Pilih sebuah tab, bukan jendela atau layar: hanya tab yang bisa dibagikan suaranya.'
        : 'Tab itu dibagikan tanpa suara. Coba lagi dan pastikan "Bagikan juga audio tab" menyala.',
    );
  }

  const settings = audio.getSettings() as MediaTrackSettings & { suppressLocalAudioPlayback?: boolean };
  return {
    stream,
    audio,
    // Browsers that support the setting but do not report it are trusted to have muted the tab.
    monitor: settings.suppressLocalAudioPlayback !== false,
    rate: settings.sampleRate ?? 0,
    label: tabTitle(video?.label ?? ''),
  };
}

/**
 * A page title from a track label. Device-style labels
 * ("web-contents-media-stream://…", "screen:0:0", random ids) are not titles.
 */
function tabTitle(label: string): string {
  const l = label.trim();
  if (!l || /^[a-z-]+:\/\//i.test(l) || /^(screen|window|tab):/i.test(l)) return '';
  if (!/\s/.test(l) && l.length >= 12) return '';
  return l;
}

/**
 * Song and artist from a music tab's title: Spotify shows "Song • Artist",
 * YouTube Music "Song - YouTube Music" or "Artist - Song".
 */
export function guessSong(title: string): { title: string; artist: string } | null {
  const t = title.replace(/\s*[-|–]\s*(YouTube Music|YouTube|Spotify.*)$/i, '').trim();
  if (!t || /^(spotify|youtube)/i.test(t)) return null;
  const dot = t.split(' • ');
  if (dot.length === 2) return { title: dot[0].trim(), artist: dot[1].trim() };
  const dash = t.split(' - ');
  if (dash.length === 2) return { title: dash[1].trim(), artist: dash[0].trim() };
  return { title: t, artist: '' };
}
