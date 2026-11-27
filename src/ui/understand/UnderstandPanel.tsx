import { RotateCcw } from 'lucide-react';
import { useSyncExternalStore, type ReactNode } from 'react';
import { useAnalysis } from '../../analysis/manager';
import { useLive } from '../../live/store';
import { retryAnalysis } from '../../store/controller';
import { usePlayer } from '../../store/player';
import { FileInfo } from '../FileInfo';
import { Section } from '../Section';
import { CharacterCard } from './Character';
import { ChordSheet } from './ChordSheet';
import { FileEvidence } from './FileEvidence';
import { HarmonyWheel } from './HarmonyWheel';
import { LiveSummary } from './LiveSummary';
import { MusicSummary } from './MusicSummary';
import { NoteRiver } from './NoteRiver';

export function AnalysisProgress({ stage, progress }: { stage: string; progress: number }) {
  return (
    <div className="analysis-progress" role="status">
      <span>
        Menganalisis · {stage} <b>{Math.round(progress * 100)}%</b>
      </span>
      <div className="bar">
        <i style={{ width: `${Math.max(3, progress * 100)}%` }} />
      </div>
    </div>
  );
}

/** The analysis failed: the song still plays, and one click runs it again. */
export function AnalysisFailed({ short }: { short?: boolean }) {
  return (
    <div className="analysis-failed">
      <p className="empty-note">
        {short
          ? 'Analisis lagu ini gagal, jadi petanya belum ada.'
          : 'Analisis lagu ini gagal, jadi kunci, akor, dan bagiannya belum terbaca. Lagunya tetap bisa diputar dan diracik.'}
      </p>
      <button className="btn small" onClick={retryAnalysis}>
        <RotateCcw size={14} aria-hidden="true" />
        Coba lagi
      </button>
    </div>
  );
}

/** Below this width the top bar hides the format pill, so the panel shows the file instead. */
const NARROW = '(max-width: 960px)';

function useNarrow(): boolean {
  return useSyncExternalStore(
    (l) => {
      const mq = window.matchMedia(NARROW);
      mq.addEventListener('change', l);
      return () => mq.removeEventListener('change', l);
    },
    () => window.matchMedia(NARROW).matches,
  );
}

export function UnderstandPanel() {
  const nowId = usePlayer((s) => s.now?.trackId);
  const { analysis, status } = useAnalysis(nowId);
  const live = useLive((s) => s.on);
  const narrow = useNarrow();

  let body: ReactNode;
  if (!nowId) {
    body = <p className="empty-note pad">Putar lagu, dan Musiccus akan menunjukkan tempo, kunci, akor, dan bagian-bagian lagunya.</p>;
  } else if (live) {
    body = (
      <>
        <Section id="u-music" title="Musik" note="Dianalisis dari suara tab sambil diputar.">
          <LiveSummary />
        </Section>
        <p className="analysis-foot">
          Suara dari tab dianalisis setiap 8 detik dari setengah menit terakhir, jadi hasilnya menyusul sedikit. Peta lagu dan karakter
          rekaman butuh seluruh lagu, jadi hanya ada untuk file Anda sendiri.
        </p>
      </>
    );
  } else if (!analysis) {
    body =
      status?.state === 'error' ? (
        <div className="pad">
          <AnalysisFailed />
        </div>
      ) : (
        <div className="pad">
          <AnalysisProgress stage={status?.stage ?? 'Antre'} progress={status?.progress ?? 0} />
          <p className="empty-note">
            Analisis berjalan di latar belakang dan hanya sekali per lagu; hasilnya disimpan untuk diputar berikutnya.
          </p>
        </div>
      );
  } else {
    body = (
      <>
        {/* Each time the app opens, Pahami starts on the music itself: Musik open, the chord sheet closed. */}
        <Section id="u-music" title="Musik" remember={false}>
          <MusicSummary analysis={analysis} trackId={nowId} />
        </Section>
        <Section id="u-sheet" title="Lembar akor" note="Akor lagu per birama. Klik birama untuk memutar dari sana." closed remember={false}>
          <ChordSheet analysis={analysis} trackId={nowId} />
        </Section>
        <Section
          id="u-wheel"
          title="Harmoni"
          note="Lingkaran kelima: akor yang bertetangga terdengar akrab. Garis menunjukkan arah progresi lagu ini."
        >
          <HarmonyWheel analysis={analysis} />
        </Section>
        <Section id="u-river" title="Sungai nada" closed note="Nada yang dipakai dari waktu ke waktu; makin terang makin sering. Kanan garis putih belum terdengar.">
          <NoteRiver analysis={analysis} />
        </Section>
        {/*
         * How it was recorded and whether the file is what it says, in one place.
         * On a narrow window the top bar has no room for the format pill, so the
         * file's own facts lead here and the verdict is not repeated.
         */}
        <Section
          id="u-record"
          title="Rekaman"
          closed
          note="Cara lagu ini direkam dan dimaster, dan apakah filenya sesuai dengan labelnya. Perkiraan dari analisis seluruh lagu."
        >
          {narrow && (
            <div className="file-info">
              <FileInfo />
            </div>
          )}
          <CharacterCard analysis={analysis} />
          <FileEvidence analysis={analysis} trackId={nowId} compact={narrow} />
        </Section>
        <p className="analysis-foot">
          Dianalisis dalam {(analysis.elapsedMs / 1000).toFixed(1).replace('.', ',')} detik. Akor dan struktur adalah perkiraan algoritma.
        </p>
      </>
    );
  }

  return (
    <aside className="inspector understand panel" aria-label="Analisis musik">
      {body}
    </aside>
  );
}
