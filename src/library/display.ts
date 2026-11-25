import type { Track } from '../store/player';

/**
 * Bracketed noise that downloaded files carry in their title, e.g.
 * "[Official Music Video]", "(Lyric Video)", "(Official Audio)", "[HD]".
 * Musical facts such as "(Live)", "(Remix)" or "(feat. …)" are kept.
 */
const NOISE = /\s*[([](?:[^)\]]*\b(?:official|music video|lyric video|lyrics?|visuali[sz]er|audio|video|mv)\b[^)\]]*|hd|hq|4k|1080p|720p)[)\]]/gi;

const SEP = /\s+[-–—]\s+/;

/**
 * Which release of the song this is, e.g. "(2004 Remaster)", "[Live]",
 * "(Radio Edit)". Kept, but read as a quiet subtitle rather than part of the title.
 */
const VERSION = /\s*[([]([^)\]]*\b(?:remaster(?:ed)?|remix|mix|edit|version|mono|stereo|deluxe|acoustic|live|demo|instrumental)\b[^)\]]*)[)\]]\s*$/i;

/**
 * Title and artist as the listener should read them, cleaned of download
 * noise: no file extension, no "[Official Music Video]", and "Artist - Title"
 * split in two when the tags do not say who the artist is.
 */
export function songLabel(t: Track): { title: string; artist: string; version: string } {
  const m = t.meta;
  let title = (m?.title || t.name.replace(/\.[^.]+$/, '')).replace(NOISE, '').trim();
  let artist = m?.artist?.trim() || '';
  const parts = title.split(SEP);
  if (parts.length >= 2) {
    const head = parts[0].trim();
    const rest = parts.slice(1).join(' - ').trim();
    // "Avenged Sevenfold - A Little Piece Of Heaven": the head is the artist
    // when the tags name the same artist, or when they name none at all.
    if (rest && (!artist || head.toLowerCase() === artist.toLowerCase())) {
      artist ||= head;
      title = rest;
    }
  }
  let version = '';
  const v = title.match(VERSION);
  if (v && v.index && v.index > 0) {
    version = v[1].trim();
    title = title.slice(0, v.index).trim();
  }
  return { title: title || t.name, artist, version };
}
