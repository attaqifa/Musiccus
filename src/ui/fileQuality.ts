import type { Analysis } from '../analysis/types';
import type { TrackMeta } from '../library/metadata';

/**
 * The file-quality check in plain words: whether the file holds what its
 * label promises (a FLAC made from an MP3, a "24/96" file that is really CD
 * quality). The spectrum test runs in the analysis worker.
 */
export interface FileQuality {
  verdict: string;
  note: string;
  tone: 'good' | 'warn' | 'plain';
}

const khz = (hz: number) => `${(hz / 1000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} kHz`;

function bitrateGuess(cutoff: number): string {
  if (cutoff < 16500) return 'MP3 128 kbps';
  if (cutoff < 17500) return 'MP3 160 kbps';
  if (cutoff < 19000) return 'MP3 192 kbps';
  return 'MP3 256–320 kbps';
}

export function fileQuality(a: Analysis | undefined, meta: TrackMeta | undefined, rate: number | undefined): FileQuality | null {
  if (!a) return null;
  const v = a.authenticity;
  const cut = v.cutoffHz;
  const hires = (meta?.bitsPerSample ?? 16) > 16 || (rate ?? 44100) > 48000;
  switch (v.verdict) {
    case 'genuine':
      return hires
        ? { verdict: 'Hi-Res asli', note: 'Isinya sesuai label: ada detail di atas batas kualitas CD, bukan hasil konversi.', tone: 'good' }
        : { verdict: 'Kualitas penuh', note: 'Isinya sesuai label: tidak ada tanda dikonversi dari MP3.', tone: 'good' };
    case 'lossy':
      return {
        verdict: 'File terkompresi',
        note: 'Wajar untuk MP3 atau AAC: sebagian detail dibuang supaya ukurannya kecil. Di earphone biasa, bedanya jarang terdengar.',
        tone: 'plain',
      };
    case 'lossy-transcode':
      return {
        verdict: 'Kemungkinan dari MP3',
        note: `Formatnya lossless, tapi frekuensi tingginya terpotong rata di ${cut ? khz(cut) : 'bawah 20 kHz'}, ciri ${cut ? bitrateGuess(cut) : 'MP3'}. Ukurannya besar tanpa tambahan kualitas.`,
        tone: 'warn',
      };
    case 'upsampled':
      return {
        verdict: 'Bukan Hi-Res sungguhan',
        note: `Labelnya ${rate ? khz(rate) : 'Hi-Res'}, tapi isinya berhenti di ${cut ? khz(cut) : 'batas CD'}: kualitasnya setara CD yang dibesarkan.`,
        tone: 'warn',
      };
    case 'padded-bits':
      return { verdict: 'Setara CD', note: `Ditandai ${meta?.bitsPerSample ?? 24}-bit, tapi isinya 16-bit; bit tambahannya kosong.`, tone: 'warn' };
    default:
      return cut
        ? {
            verdict: 'Belum pasti',
            note: `Frekuensi tingginya terpotong di ${khz(cut)}. Itu bisa ciri MP3 256–320 kbps, tapi banyak master CD juga dipotong di sekitar situ.`,
            tone: 'plain',
          }
        : { verdict: 'Belum bisa dinilai', note: 'Lagu terlalu pendek atau terlalu senyap untuk dicek.', tone: 'plain' };
  }
}
