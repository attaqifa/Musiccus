import { hub } from '../audio/hub';

/**
 * The live expression colour (the song's key, or its cover), as 0–255 RGB.
 * Written to `--key-rgb` on :root so CSS can use it, and read directly by
 * canvases. Only expressive, non-interactive elements use it.
 */
export const ambient = { rgb: [249, 149, 73] };

let last = '';

hub.subscribe((s) => {
  const a = s.music.accent;
  const r = Math.round(a[0] * 255);
  const g = Math.round(a[1] * 255);
  const b = Math.round(a[2] * 255);
  ambient.rgb[0] = r;
  ambient.rgb[1] = g;
  ambient.rgb[2] = b;
  const css = `${r} ${g} ${b}`;
  if (css !== last) {
    last = css;
    document.documentElement.style.setProperty('--key-rgb', css);
  }
});

export const keyCss = (alpha = 1) => `rgba(${ambient.rgb[0]}, ${ambient.rgb[1]}, ${ambient.rgb[2]}, ${alpha})`;
