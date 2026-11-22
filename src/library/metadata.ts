/** The tag reader loads on first use, keeping it out of the first page load. */
const tagReader = () => import('music-metadata');

export interface TrackMeta {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  trackNo?: number;
  discNo?: number;
  year?: number;
  genre?: string;
  duration?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  channels?: number;
  bitrate?: number;
  codec?: string;
  lossless?: boolean;
  rgTrackGain?: number;
  rgTrackPeak?: number;
  rgAlbumGain?: number;
  rgAlbumPeak?: number;
}

export type Tier = 'hires' | 'lossless' | 'lossy' | 'unknown';

const LOSSLESS_EXT = new Set(['flac', 'wav', 'wave', 'aif', 'aiff', 'aifc', 'alac', 'ape', 'wv', 'dsf', 'dff']);

function codecName(ext: string, codec?: string): string {
  const c = (codec ?? '').toLowerCase();
  if (c.includes('alac')) return 'ALAC';
  if (ext === 'flac' || c.includes('flac')) return 'FLAC';
  if (ext === 'wav' || ext === 'wave') return 'WAV';
  if (ext.startsWith('aif')) return 'AIFF';
  if (ext === 'mp3' || c.includes('layer 3')) return 'MP3';
  if (c.includes('opus') || ext === 'opus') return 'Opus';
  if (c.includes('vorbis')) return 'Vorbis';
  if (c.includes('aac') || ext === 'm4a' || ext === 'aac') return 'AAC';
  if (ext === 'dsf' || ext === 'dff') return 'DSD';
  return ext.toUpperCase();
}

export async function readMeta(file: File, ext: string): Promise<TrackMeta> {
  const { parseBlob } = await tagReader();
  const m = await parseBlob(file, { skipCovers: true, duration: false });
  const f = m.format;
  const c = m.common;
  const codec = codecName(ext, f.codec);
  const lossless = f.lossless ?? (LOSSLESS_EXT.has(ext) || codec === 'ALAC');
  return {
    title: c.title,
    artist: c.artist,
    album: c.album,
    albumArtist: c.albumartist,
    trackNo: c.track?.no ?? undefined,
    discNo: c.disk?.no ?? undefined,
    year: c.year,
    genre: c.genre?.[0],
    duration: f.duration,
    sampleRate: f.sampleRate,
    bitsPerSample: f.bitsPerSample,
    channels: f.numberOfChannels,
    bitrate: f.bitrate,
    codec,
    lossless,
    rgTrackGain: c.replaygain_track_gain?.dB,
    rgTrackPeak: c.replaygain_track_peak?.ratio,
    rgAlbumGain: c.replaygain_album_gain?.dB,
    rgAlbumPeak: c.replaygain_album_peak?.ratio,
  };
}

export function tierOf(meta?: TrackMeta): Tier {
  if (!meta || meta.lossless === undefined) return 'unknown';
  if (!meta.lossless) return 'lossy';
  if ((meta.bitsPerSample ?? 16) > 16 || (meta.sampleRate ?? 44100) > 48000) return 'hires';
  return 'lossless';
}

export const TIER_LABEL: Record<Tier, string> = {
  hires: 'Hi-Res Lossless',
  lossless: 'Lossless',
  lossy: 'Lossy',
  unknown: 'Belum dibaca',
};

/** Compact badge such as "24/96", "16/44.1" or "MP3 320". */
export function shortFormat(meta: TrackMeta | undefined, ext: string): string {
  if (!meta) return ext.toUpperCase();
  const rate = meta.sampleRate ? meta.sampleRate / 1000 : undefined;
  const r = rate === undefined ? '?' : Number.isInteger(rate) ? String(rate) : rate.toFixed(1);
  if (meta.lossless) {
    if (meta.codec === 'DSD') return `DSD ${r}`;
    return `${meta.bitsPerSample ?? '?'}/${r}`;
  }
  const kbps = meta.bitrate ? Math.round(meta.bitrate / 1000) : '';
  return `${meta.codec ?? ext.toUpperCase()} ${kbps}`.trim();
}

/* ------------------------------------------------------------- Cover art -- */

const coverCache = new Map<string, Promise<string | null>>();
const COVER_LIMIT = 240;

export function readCover(key: string, file: () => Promise<File>): Promise<string | null> {
  const hit = coverCache.get(key);
  if (hit) {
    coverCache.delete(key);
    coverCache.set(key, hit);
    return hit;
  }
  const p = (async () => {
    try {
      const { parseBlob } = await tagReader();
      const m = await parseBlob(await file(), { duration: false });
      const pic = m.common.picture?.[0];
      if (!pic) return null;
      return URL.createObjectURL(new Blob([new Uint8Array(pic.data)], { type: pic.format }));
    } catch {
      return null;
    }
  })();
  coverCache.set(key, p);
  if (coverCache.size > COVER_LIMIT) {
    const oldest = coverCache.keys().next().value as string;
    const old = coverCache.get(oldest);
    coverCache.delete(oldest);
    old?.then((u) => u && URL.revokeObjectURL(u));
  }
  return p;
}
