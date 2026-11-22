import type { Analysis } from '../../analysis/types';
import { formatLufs } from '../../lib/format';
import { usePlayer } from '../../store/player';
import { fileQuality } from '../fileQuality';
import { cls } from '../hooks';
import { MasteringExtras } from './FileEvidence';

/**
 * "Karakter rekaman": what the mastering numbers mean, in a few plain
 * sentences. In the detail layer each sentence also shows the number behind
 * it, and the numbers that have no sentence follow as a small grid.
 */

interface Trait {
  label: string;
  verdict: string;
  note: string;
  warn?: boolean;
  /** The measurement behind the sentence, shown in the detail layer. */
  figure?: string;
}

const num = (v: number) => Math.abs(v).toLocaleString('id-ID', { maximumFractionDigits: 0 });
const signed = (v: number) => `${v > 0.5 ? '+' : ''}${Math.round(v)}`.replace('-', '−');

function dynamics(a: Analysis): Trait {
  return { ...dynamicsText(a), figure: `DR ${a.mastering.dr}` };
}

function dynamicsText(a: Analysis): Trait {
  const { dr, clipEvents } = a.mastering;
  const clip = clipEvents > 20 ? ' Ada distorsi pecah di beberapa tempat.' : '';
  if (dr >= 12) return { label: 'Dinamika', verdict: 'Dinamis dan lega', note: `Bagian pelan dan keras dibiarkan berbeda jauh, seperti rekaman akustik atau master lama.${clip}` };
  if (dr >= 9) return { label: 'Dinamika', verdict: 'Seimbang', note: `Cukup padat tanpa kehilangan napas; ketukan drum masih terasa menghentak.${clip}` };
  if (dr >= 6) return { label: 'Dinamika', verdict: 'Padat dan keras', note: `Gaya rekaman modern: semua terdengar dekat dan rata, enak diputar pelan.${clip}` };
  return { label: 'Dinamika', verdict: 'Sangat padat', note: `Dipadatkan habis-habisan supaya terdengar keras; bisa cepat melelahkan di volume tinggi.${clip}` };
}

function loudness(a: Analysis): Trait {
  return { ...loudnessText(a), figure: `${formatLufs(a.mastering.lufsI)} LUFS` };
}

function loudnessText(a: Analysis): Trait {
  const delta = a.mastering.lufsI + 14;
  if (!Number.isFinite(delta)) return { label: 'Volume rekaman', verdict: 'Belum terukur', note: 'Lagu terlalu senyap untuk diukur.' };
  if (delta > 1)
    return {
      label: 'Volume rekaman',
      verdict: `${num(delta)} dB lebih keras dari standar`,
      note: 'Spotify dan YouTube akan memutarnya lebih pelan supaya setara dengan lagu lain.',
    };
  if (delta < -3)
    return { label: 'Volume rekaman', verdict: 'Lebih pelan dari standar', note: 'Masternya tidak dikejar keras; naikkan volume sedikit untuk menikmatinya.' };
  return { label: 'Volume rekaman', verdict: 'Sesuai standar streaming', note: 'Kerasnya pas dengan lagu-lagu di layanan streaming.' };
}

function stereo(a: Analysis): Trait {
  const { width, correlation } = a.mastering;
  const corr = correlation.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace('-', '−');
  return { ...stereoText(a), figure: `korelasi ${corr} · lebar ${Math.round(width)}%` };
}

function stereoText(a: Analysis): Trait {
  const { width, correlation } = a.mastering;
  const phase = correlation < 0 ? ' Sebagian suara bisa hilang kalau diputar dari speaker mono.' : '';
  // width is side energy over mid energy in percent: 6% is the side about
  // 12 dB below the middle, 25% about 6 dB below.
  if (width < 1.2) return { label: 'Stereo', verdict: 'Hampir mono', note: `Semua suara datang dari tengah, seperti rekaman lama atau radio.${phase}` };
  if (width < 6) return { label: 'Stereo', verdict: 'Terpusat', note: `Vokal dan instrumen utama di tengah, sedikit melebar ke samping.${phase}` };
  if (width < 25) return { label: 'Stereo', verdict: 'Lebar', note: `Instrumen tersebar ke kiri dan kanan.${phase}` };
  return { label: 'Stereo', verdict: 'Sangat lebar', note: `Suara mengelilingi dari kiri ke kanan; paling terasa di headphone.${phase}` };
}

/**
 * Level per octave (dB) of the long-term spectrum between two frequencies.
 * LTAS points are log-spaced samples of power per Hz, so p·f integrates to
 * energy per octave.
 */
function octaveLevel(a: Analysis, lo: number, hi: number): number {
  const f = a.authenticity.ltasFreqs;
  const d = a.authenticity.ltasDb;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < f.length; i++) {
    if (f[i] < lo || f[i] > hi) continue;
    sum += Math.pow(10, d[i] / 10) * f[i];
    n++;
  }
  return n ? 10 * Math.log10(sum / n) : NaN;
}

/**
 * Tone compared with typical pop and rock masters. Measured on masters from
 * the 1970s to now, the energy per octave in the bass (40–160 Hz) sat between
 * 4 dB below and 6 dB above the midrange (500–2000 Hz), and the treble
 * (4–12 kHz) 5 to 11 dB below it. The margins are wide on purpose: only clear
 * cases get a label.
 */
export function toneBalance(a: Analysis): { bass: number; treble: number } | null {
  const mid = octaveLevel(a, 500, 2000);
  const bass = octaveLevel(a, 40, 160) - mid;
  const treble = octaveLevel(a, 4000, 12000) - mid;
  if (!Number.isFinite(bass) || !Number.isFinite(treble)) return null;
  return { bass, treble };
}

function tone(a: Analysis): Trait | null {
  const t = toneBalance(a);
  const text = toneText(a);
  return t && text ? { ...text, figure: `bass ${signed(t.bass)} · treble ${signed(t.treble)} dB` } : null;
}

function toneText(a: Analysis): Trait | null {
  const t = toneBalance(a);
  if (!t) return null;
  const bassy = t.bass > 9;
  const thin = t.bass < -6;
  const bright = t.treble > -3;
  const dark = t.treble < -14;
  const label = 'Warna suara';
  if (bassy && bright) return { label, verdict: 'Bass dan treble menonjol', note: 'Dentum tebal dan detail atas berkilau, tengahnya agak mundur: khas EDM dan pop modern.' };
  if (bassy) return { label, verdict: 'Hangat, bass menonjol', note: 'Bass dan dentum mendominasi; cocok untuk hip-hop dan musik elektronik.' };
  if (bright && thin) return { label, verdict: 'Terang dan ringan', note: 'Detail atas jelas dan bass tipis, seperti rekaman akustik atau lagu lama.' };
  if (bright) return { label, verdict: 'Terang dan berdetail', note: 'Cymbal, napas vokal, dan petikan gitar terdengar jelas.' };
  if (dark) return { label, verdict: 'Lembut dan gelap', note: 'Bagian atas diredam, terasa hangat dan tidak menusuk di volume tinggi.' };
  if (thin) return { label, verdict: 'Bass tipis', note: 'Bagian bawah ringan; preset "Bass lebih tebal" di Racik bisa mengisinya.' };
  return { label, verdict: 'Seimbang', note: 'Bass, tengah, dan treble terdengar wajar tanpa ada yang mendominasi.' };
}

/**
 * `showFile`: include the file-quality line, when no other part of the panel
 * shows it. `detail`: add the numbers behind each sentence.
 */
export function CharacterCard({ analysis, detail, showFile }: { analysis: Analysis; detail: boolean; showFile: boolean }) {
  const meta = usePlayer((s) => (s.now ? s.tracks[s.now.trackId]?.meta : undefined));
  const rate = usePlayer((s) => s.now?.sourceRate);
  const q = showFile ? fileQuality(analysis, meta, rate) : null;
  const file: Trait | null = q && { label: 'Kualitas file', verdict: q.verdict, note: q.note, warn: q.tone === 'warn' };
  const traits = [dynamics(analysis), loudness(analysis), stereo(analysis), tone(analysis), file].filter((t): t is Trait => !!t);
  return (
    <div className="character-card">
      <dl className="character">
        {traits.map((t) => (
          <div key={t.label} className={cls('trait', t.warn && 'warn')}>
            <dt>{t.label}</dt>
            <dd>
              <span className="trait-line">
                <b>{t.verdict}</b>
                {detail && t.figure && <em className="trait-fig">{t.figure}</em>}
              </span>
              <span>{t.note}</span>
            </dd>
          </div>
        ))}
      </dl>
      {detail && <MasteringExtras m={analysis.mastering} />}
    </div>
  );
}
