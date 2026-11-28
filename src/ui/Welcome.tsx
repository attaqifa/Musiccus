import { AppWindow, ChevronRight, FolderClock, FolderOpen, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { tabCaptureSupported } from '../live/tab';
import { formatTime } from '../lib/format';
import { listenToTab, loadDemo, prepareDemo } from '../store/controller';
import { lastSession, resumeListening, type LastSession } from '../store/session';
import { pickFiles, pickFolder } from './pickers';

/** What each mode does, in the words its tab uses; the tabs themselves wait for a song. */
const MODES: [string, string][] = [
  ['Dengar', 'Visual yang ikut setiap dentuman, dan lirik yang muncul kata demi kata.'],
  ['Pahami', 'Kunci, tempo, akor, dan bagian lagu, dibaca langsung dari suaranya.'],
  ['Racik', 'Bass lebih tebal, vokal lebih jelas, atau slowed + reverb, dengan satu klik.'],
  ['Stem', 'Vokal, drum, dan bass dipisah: untuk karaoke atau menikmati satu instrumen.'],
];

export function Welcome() {
  const [last, setLast] = useState<LastSession | null>(null);
  useEffect(() => {
    void lastSession().then(setLast);
    const idle = window.setTimeout(() => void prepareDemo(), 1200);
    return () => window.clearTimeout(idle);
  }, []);
  const canPickFolder = typeof window.showDirectoryPicker === 'function';
  const canTab = tabCaptureSupported();
  // Everything else runs in any modern browser; these need Chrome or Edge on desktop.
  const missing = [
    ['buka folder', canPickFolder],
    ['dengar dari tab', canTab],
    ['pemisahan vokal AI (WebGPU)', 'gpu' in navigator],
  ]
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  return (
    <>
      {/* Outside the scroller, so the shadow behind the copy is never clipped by it. */}
      <div className="wl-shade" aria-hidden="true" />
      <section className="welcome" aria-labelledby="welcome-title">
        <div className="wl-body">
          <h1 id="welcome-title" className="wl-title">
            Dengar lebih <em>dalam.</em>
          </h1>
          <p className="wl-lede">
            Putar lagu dari koleksi Anda, atau dengarkan tab Spotify dan YouTube Music lewat Musiccus. Setiap lagu bisa Anda dengar,
            pahami, racik, dan pisahkan.
          </p>
          <div className="wl-actions">
            <button className="btn primary" onClick={pickFolder}>
              <FolderOpen size={17} aria-hidden="true" />
              Buka folder musik
            </button>
            {last && (
              <button
                className="btn wl-resume"
                onClick={() => void resumeListening()}
                data-tip={
                  last.point
                    ? `Putar lagi “${last.point.title}”${last.point.time > 0 ? ` dari ${formatTime(last.point.time)}` : ''} di folder "${last.folder}"`
                    : `Buka lagi folder "${last.folder}"`
                }
              >
                <FolderClock size={17} aria-hidden="true" />
                <span className="wl-resume-text">Lanjutkan {last.point ? last.point.title : last.folder}</span>
                {last.point && last.point.time > 0 && <span className="wl-resume-at">{formatTime(last.point.time)}</span>}
              </button>
            )}
            <button className="btn" onClick={() => void loadDemo()} data-tip="Lagu 40 detik yang sekaligus menunjukkan keempat mode, tanpa perlu file apa pun">
              <Play size={16} aria-hidden="true" />
              Coba lagu demo
            </button>
            {canTab && (
              <button className="btn" onClick={() => void listenToTab()} data-tip="Pilih tab yang sedang memutar musik, lalu nyalakan Bagikan juga audio tab">
                <AppWindow size={17} aria-hidden="true" />
                Dengar dari tab
              </button>
            )}
          </div>
          <p className="wl-hint">
            <span className="wl-drag-hint">Atau seret file dan folder ke mana saja di jendela ini. </span>
            {!canPickFolder && (
              <button className="link" onClick={() => pickFiles(false)}>
                Pilih file satu per satu
              </button>
            )}
          </p>
          {missing.length > 0 && (
            <p className="wl-caps">
              Di browser ini belum tersedia: {missing.join(', ')}. Fitur lain berjalan normal; untuk semuanya, buka Musiccus di Chrome atau
              Edge di desktop.
            </p>
          )}
          <dl className="wl-modes" aria-label="Empat mode Musiccus">
            {MODES.map(([name, text]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{text}</dd>
              </div>
            ))}
          </dl>
          <details className="wl-more">
            <summary>
              <ChevronRight size={14} aria-hidden="true" />
              Format yang bisa diputar
            </summary>
            <dl className="wl-formats">
              <div>
                <dt>Diputar langsung</dt>
                <dd>MP3, AAC, FLAC, WAV, AIFF, Opus, dan Vorbis. Lirik dicari otomatis kalau lagunya tidak membawa lirik sendiri.</dd>
              </div>
              {canTab && (
                <div>
                  <dt>Dari tab</dt>
                  <dd>
                    Spotify, YouTube Music, atau situs musik lain di tab sebelah. Pilih tabnya dan nyalakan "Bagikan juga audio tab". Tidak
                    ada yang diunduh atau disimpan.
                  </dd>
                </div>
              )}
              <div>
                <dt>Belum bisa diputar</dt>
                <dd>ALAC, APE, WavPack, dan DSD. File ini tetap tampil di koleksi, tetapi dilewati saat memutar.</dd>
              </div>
            </dl>
          </details>
        </div>
      </section>
    </>
  );
}
