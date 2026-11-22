import type { ChordSeg, KeyInfo, Palette, Rgb, Section } from './types';

/*
 * Colour science for Graphite Prism. Everything is built in OKLCH, where
 * lightness is perceptual: a key colour at L 0.8 is equally bright whether it
 * is amber or blue, so every key looks as good as every other and text
 * contrast never depends on the song.
 */

const FIFTHS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];

const lin2srgb = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
const srgb2lin = (x: number) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));

function oklabToLinear(L: number, a: number, b: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** OKLCH to gamma-encoded sRGB (0..1). Chroma is reduced until the colour fits. */
export function oklch(L: number, C: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const inGamut = (c: number) => oklabToLinear(L, c * Math.cos(h), c * Math.sin(h)).every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let c = C;
  if (!inGamut(c)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(mid)) lo = mid;
      else hi = mid;
    }
    c = lo;
  }
  const lin = oklabToLinear(L, c * Math.cos(h), c * Math.sin(h));
  return lin.map((v) => lin2srgb(Math.min(1, Math.max(0, v)))) as Rgb;
}

/** Gamma-encoded sRGB (0..1) to OKLab. */
export function toOklab(r: number, g: number, b: number): [number, number, number] {
  const R = srgb2lin(r);
  const G = srgb2lin(g);
  const B = srgb2lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/**
 * The circle of fifths laid over the hue circle in 30° steps, so related keys
 * get related colours. C starts on amber (70°), G is yellow, D lime, and so on.
 */
export const pitchHue = (pc: number) => (70 + FIFTHS[((pc % 12) + 12) % 12] * 30) % 360;

/** Relative major of a key (minor keys share their relative major's hue). */
const keyRootHue = (key: KeyInfo) => pitchHue(key.mode === 'minor' ? (key.tonic + 3) % 12 : key.tonic);

/** Neutral pearl: the expression colour for a playing song in the monochrome colour mode. */
export const PEARL: Rgb = oklch(0.92, 0.012, 80);

/**
 * Musiccus's home colour, a warm orange (#F99549): the glow of a VU meter.
 * It holds the screen while nothing is playing and gives way to the song's
 * own colour as soon as that is known. Its hue sits midway between the
 * status red (32°) and amber (79°), and it is lighter than the red, so it
 * never reads as a warning.
 */
export const HOME_HUE = 55;
export const HOME: Rgb = oklch(0.76, 0.15, HOME_HUE);

/** UI expression colour for a key: same brightness for all twelve. */
export function keyAccent(key: KeyInfo | null): Rgb {
  if (!key) return PEARL;
  return oklch(key.mode === 'minor' ? 0.77 : 0.8, key.mode === 'minor' ? 0.105 : 0.12, keyRootHue(key));
}

/** Accent of each position on the circle of fifths, for the prism line. */
export const PRISM: Rgb[] = FIFTHS.map((_, i) => oklch(0.8, 0.12, (70 + i * 30) % 360));

export const pitchColor = (pc: number, minor = false): Rgb =>
  oklch(minor ? 0.66 : 0.74, minor ? 0.11 : 0.14, pitchHue(minor ? (pc + 3) % 12 : pc));

type Scheme = 'calm' | 'base' | 'lift' | 'turn';

/**
 * A section changes the palette's intensity, never its colour family: the
 * whole song stays in the key's hues, so it keeps one visual identity from
 * intro to outro. (Complementary and triadic schemes for choruses and
 * bridges made a song suddenly look like a different one.) Quiet bookends
 * are dimmer and calmer, verses sit at the base, choruses are brighter and
 * more vivid, and a bridge turns the accents by a small step for variety.
 */
function schemeFor(section: Section | null): Scheme {
  switch (section?.name) {
    case 'Intro':
    case 'Outro':
      return 'calm';
    case 'Chorus':
    case 'Puncak':
      return 'lift';
    case 'Bridge':
      return 'turn';
    default:
      return 'base';
  }
}

const angleDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180;

export function musicPalette(key: KeyInfo, chord: Pick<ChordSeg, 'root' | 'quality'> | null, section: Section | null): Palette {
  const H = keyRootHue(key);
  const minor = key.mode === 'minor';
  // The chord nudges the main hue toward its own colour, within ±16°.
  let hb = H;
  if (chord) {
    const ch = pitchHue(chord.quality === 'min' ? (chord.root + 3) % 12 : chord.root);
    hb = H + Math.max(-40, Math.min(40, angleDiff(ch, H))) * 0.4;
  }
  const energy = section ? 0.85 + section.energy * 0.3 : 1;
  const k = (minor ? 0.85 : 1) * energy;
  const lb = minor ? 0.66 : 0.71;
  switch (schemeFor(section)) {
    case 'calm':
      return { a: oklch(0.29, 0.06 * k, H), b: oklch(lb - 0.04, 0.1 * k, hb), c: oklch(0.92, 0.03, H) };
    case 'lift':
      return { a: oklch(0.35, 0.11 * k, H - 15), b: oklch(lb + 0.03, 0.17 * k, hb), c: oklch(0.97, 0.05, H + 12) };
    case 'turn':
      return { a: oklch(0.32, 0.09 * k, H + 25), b: oklch(lb, 0.15 * k, hb + 10), c: oklch(0.94, 0.04, H + 30) };
    default:
      return { a: oklch(0.32, 0.08 * k, H - 20), b: oklch(lb, 0.14 * k, hb), c: oklch(0.94, 0.035, H + 15) };
  }
}

/** Graphite with a faint hue that drifts once a minute: the monochrome colour mode. */
export function monoPalette(seconds: number): Palette {
  const h = (seconds * 6) % 360;
  return { a: oklch(0.3, 0.014, h), b: oklch(0.68, 0.022, h + 20), c: oklch(0.94, 0.008, h + 40) };
}

/** Graphite washed with the home colour: the visuals while nothing plays, or before a song's key is known. */
export function homePalette(): Palette {
  return { a: oklch(0.3, 0.035, HOME_HUE), b: oklch(0.68, 0.07, HOME_HUE + 5), c: oklch(0.94, 0.02, HOME_HUE + 10) };
}

/* ------------------------------------------------------------ Cover art -- */

export interface CoverColours {
  palette: Palette;
  accent: Rgb;
}

/**
 * Palette from album art: k-means on the cover's pixels in OKLab, then the
 * most colourful well-represented cluster becomes the main hue, and the
 * darkest and lightest clusters lend the deep and highlight roles.
 */
export async function paletteFromImage(url: string): Promise<CoverColours | null> {
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  const px: [number, number, number][] = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    px.push(toOklab(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255));
  }
  if (px.length < 16) return null;

  // Seed centroids across the lightness range, then refine.
  const K = 5;
  const sorted = [...px].sort((a, b) => a[0] - b[0]);
  let cents = Array.from({ length: K }, (_, i) => [...sorted[Math.floor(((i + 0.5) / K) * sorted.length)]]);
  let counts = new Array<number>(K).fill(0);
  for (let iter = 0; iter < 12; iter++) {
    const sums = Array.from({ length: K }, () => [0, 0, 0]);
    counts = new Array<number>(K).fill(0);
    for (const p of px) {
      let best = 0;
      let bestD = Infinity;
      for (let k = 0; k < K; k++) {
        const d = (p[0] - cents[k][0]) ** 2 + (p[1] - cents[k][1]) ** 2 + (p[2] - cents[k][2]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      sums[best][0] += p[0];
      sums[best][1] += p[1];
      sums[best][2] += p[2];
      counts[best]++;
    }
    cents = cents.map((c, k) => (counts[k] ? sums[k].map((v) => v / counts[k]) : c));
  }
  const clusters = cents
    .map((c, k) => ({ L: c[0], C: Math.hypot(c[1], c[2]), h: ((Math.atan2(c[2], c[1]) * 180) / Math.PI + 360) % 360, w: counts[k] / px.length }))
    .filter((c) => c.w > 0.02);
  if (!clusters.length) return null;

  const mid = clusters.filter((c) => c.L > 0.3 && c.L < 0.92);
  const vivid = (mid.length ? mid : clusters).reduce((a, b) => (b.C * Math.sqrt(b.w) > a.C * Math.sqrt(a.w) ? b : a));
  const dark = clusters.reduce((a, b) => (b.L < a.L ? b : a));
  const light = clusters.reduce((a, b) => (b.L > a.L ? b : a));
  const chroma = Math.max(0.03, Math.min(0.16, vivid.C));
  return {
    palette: {
      a: oklch(0.3, Math.min(0.09, Math.max(dark.C, chroma * 0.5)), dark.C > 0.03 ? dark.h : vivid.h),
      b: oklch(0.7, chroma, vivid.h),
      c: oklch(0.94, Math.min(0.04, light.C), light.C > 0.02 ? light.h : vivid.h),
    },
    accent: oklch(0.8, Math.min(0.12, chroma), vivid.h),
  };
}
