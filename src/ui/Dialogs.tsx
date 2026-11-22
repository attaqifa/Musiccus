import { X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { droppedLyrics, filesFromDrop } from '../library/scan';
import { attachLrc } from '../lyrics/lyrics';
import { addFound, playQueue, setRgMode } from '../store/controller';
import { getState, setSettings, setUi, usePlayer, type ColorSource, type QualityChoice, type Settings } from '../store/player';
import { HeadphonePicker } from './HeadphonePicker';
import { cls } from './hooks';
import { GpuReadout, StemStorage } from './SettingsExtra';

function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} className={cls(value === o.value && 'on')} onClick={() => onChange(o.value)} title={o.hint}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">
        <span>{label}</span>
        {hint && <p>{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export function SettingsDrawer() {
  const open = usePlayer((s) => s.ui.settings);
  const s = usePlayer((st) => st.settings);
  if (!open) return null;
  const set = (p: Partial<Settings>) => setSettings(p);
  return (
    <aside className="drawer panel" aria-label="Pengaturan">
      <div className="drawer-head">
        <h2>Pengaturan</h2>
        <button className="icon-btn" onClick={() => setUi({ settings: false })} aria-label="Tutup pengaturan">
          <X size={17} />
        </button>
      </div>
      <div className="drawer-body">
        <h3>Tampilan</h3>
        <Field
          label="Tingkat detail"
          hint="Detail menampilkan semuanya: rack knob lengkap di Racik, panel Pantau (meter level, loudness, spektrum, stereo; tombol O), serta angka mastering, Sungai nada, dan Keaslian file dengan spektrogram di Pahami. Sederhana hanya menyisakan preset dan kalimat biasa."
        >
          <Segmented
            label="Tingkat detail"
            value={s.detail ? 'detail' : 'simple'}
            onChange={(v) => set({ detail: v === 'detail' })}
            options={[
              { value: 'simple', label: 'Sederhana' },
              { value: 'detail', label: 'Detail' },
            ]}
          />
        </Field>

        <h3>Pemutaran</h3>
        <Field
          label="Samakan volume antar lagu"
          hint="Lagu yang dimaster keras tidak lagi mengagetkan setelah lagu yang pelan. Bekerja untuk file yang punya tag ReplayGain. Per album menjaga perbedaan volume di dalam satu album."
        >
          <Segmented
            label="Samakan volume antar lagu"
            value={s.rgMode}
            onChange={setRgMode}
            options={[
              { value: 'off', label: 'Mati' },
              { value: 'track', label: 'Per lagu' },
              { value: 'album', label: 'Per album' },
            ]}
          />
        </Field>

        <h3>Lirik</h3>
        <Field
          label="Cari lirik otomatis"
          hint="Kalau lagu tidak membawa lirik sendiri, Musiccus mencarinya di LRCLIB, database lirik terbuka. Yang dikirim hanya judul, artis, album, dan durasi lagu."
        >
          <Segmented
            label="Cari lirik otomatis"
            value={s.lyricsOnline ? 'on' : 'off'}
            onChange={(v) => set({ lyricsOnline: v === 'on' })}
            options={[
              { value: 'on', label: 'Aktif' },
              { value: 'off', label: 'Mati' },
            ]}
          />
        </Field>

        <h3>Visual</h3>
        <Field label="Kualitas visual" hint="Otomatis menyesuaikan perangkat ini. Pilih Hemat kalau gerakan terasa patah atau baterai cepat habis.">
          <Segmented
            label="Kualitas visual"
            value={s.quality}
            onChange={(v: QualityChoice) => set({ quality: v })}
            options={[
              { value: 'auto', label: 'Otomatis' },
              { value: 'eco', label: 'Hemat' },
              { value: 'high', label: 'Tinggi' },
            ]}
          />
        </Field>
        <Field
          label="Warna visual"
          hint="Musik: warna mengikuti nuansa lagu dan tetap satu keluarga dari awal sampai akhir. Cover: warna diambil dari sampul album."
        >
          <Segmented
            label="Warna visual"
            value={s.colorSource}
            onChange={(v: ColorSource) => set({ colorSource: v })}
            options={[
              { value: 'music', label: 'Musik' },
              { value: 'cover', label: 'Cover album' },
              { value: 'mono', label: 'Monokrom' },
            ]}
          />
        </Field>
        <Field
          label="Ganti visual otomatis"
          hint="Visual berganti di setiap bagian lagu, tepat di ketukannya: intro dan outro Aurora, verse Lanskap, chorus Nebula, bridge Stereo."
        >
          <Segmented
            label="Ganti visual otomatis"
            value={s.director ? 'on' : 'off'}
            onChange={(v) => set({ director: v === 'on' })}
            options={[
              { value: 'on', label: 'Aktif' },
              { value: 'off', label: 'Mati' },
            ]}
          />
        </Field>
        <Field label="Kartu grafis" hint="GPU yang dipakai browser ini untuk visual dan pemisahan stem.">
          <GpuReadout />
        </Field>

        <h3>Headphone</h3>
        <Field
          label="Headphone saya"
          hint="Setiap headphone dan earphone punya warna suaranya sendiri. Pilih model Anda, dan suaranya dikoreksi ke arah netral untuk semua lagu. Daftar model dan profilnya diunduh dari proyek AutoEQ di GitHub; yang Anda ketik tidak dikirim ke mana pun."
        >
          <HeadphonePicker />
        </Field>
        {s.headphone && (
          <Field label="Koreksi headphone" hint="Matikan sebentar untuk mendengar bedanya.">
            <Segmented
              label="Koreksi headphone"
              value={s.headphoneOn ? 'on' : 'off'}
              onChange={(v) => set({ headphoneOn: v === 'on' })}
              options={[
                { value: 'on', label: 'Aktif' },
                { value: 'off', label: 'Mati' },
              ]}
            />
          </Field>
        )}
        <Field
          label="Suara lebih natural"
          hint="Di headphone, kiri dan kanan terpisah total, sehingga lagu lama dengan stereo ekstrem terasa aneh dan cepat melelahkan. Ini mengalirkan sedikit suara ke telinga seberang, seperti mendengar dari speaker."
        >
          <Segmented
            label="Suara lebih natural"
            value={s.crossfeed ? 'on' : 'off'}
            onChange={(v) => set({ crossfeed: v === 'on' })}
            options={[
              { value: 'on', label: 'Aktif' },
              { value: 'off', label: 'Mati' },
            ]}
          />
        </Field>
        <Field
          label={`Koreksi waktu Bluetooth: ${s.avOffsetMs > 0 ? '+' : ''}${s.avOffsetMs} ms`}
          hint="Headphone Bluetooth membuat suara datang terlambat, jadi visual dan lirik terasa mendahului. Kalibrasi sekali supaya semuanya pas lagi."
        >
          <button className="btn" onClick={() => setUi({ calibration: true, settings: false })}>
            Kalibrasi dengan klik dan kilatan
          </button>
        </Field>

        <h3>Penyimpanan</h3>
        <StemStorage />
      </div>
    </aside>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Spasi', 'Putar / jeda'],
  ['← →', 'Mundur / maju 5 detik (Shift: 30 detik)'],
  ['↑ ↓', 'Volume ±1 dB'],
  ['N / P', 'Lagu berikutnya / sebelumnya'],
  ['M', 'Mute'],
  ['U', 'Ganti mode Dengar / Pahami'],
  ['1 – 4', 'Visual Nebula, Lanskap, Stereo, Aurora'],
  ['D', 'Ganti visual otomatis'],
  ['B', 'Mode Racik: preset suara, kecepatan, dan nada'],
  ['A', 'Dengar asli: bandingkan racikan dengan suara asli (tahan untuk sesaat)'],
  ['S', 'Mode Stem: pisahkan vokal, drum, bass; karaoke dan panggung 3D'],
  ['Q', 'Antrean, acak, ulang, dan timer tidur'],
  ['G', 'Peta koleksi'],
  ['O', 'Panel Pantau: meter level, loudness, spektrum, dan stereo'],
  ['Y', 'Tampilkan / sembunyikan lirik'],
  ['H', 'Mode panggung: sembunyikan semua UI'],
  ['L / I', 'Tampilkan library / panel kanan (lirik di mode Dengar)'],
  ['F', 'Layar penuh'],
  [',', 'Pengaturan'],
  ['Esc', 'Tutup dialog, antrean, atau Peta koleksi, keluar mode panggung'],
];

function Modal({ onClose, label, children, className }: { onClose: () => void; label: string; children: ReactNode; className?: string }) {
  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cls('modal panel', className)} role="dialog" aria-modal="true" aria-label={label}>
        <button className="icon-btn modal-close" onClick={onClose} aria-label="Tutup">
          <X size={17} />
        </button>
        {children}
      </div>
    </div>
  );
}

export function HelpDialog() {
  const open = usePlayer((s) => s.ui.help);
  if (!open) return null;
  return (
    <Modal onClose={() => setUi({ help: false })} label="Pintasan keyboard">
      <h2>Pintasan keyboard</h2>
      <dl className="shortcuts">
        {SHORTCUTS.map(([k, d]) => (
          <div key={k}>
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{d}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}

export function Toasts() {
  const toasts = usePlayer((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cls('toast', t.kind === 'error' && 'error')}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function DropOverlay() {
  const [over, setOver] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const overFn = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = async (e: DragEvent) => {
      if (!e.dataTransfer || !hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      const found = await filesFromDrop(e.dataTransfer);
      // A lone .lrc dropped while a song plays becomes that song's lyrics.
      if (!found.length && droppedLyrics.length) {
        void attachLrc(droppedLyrics[0]);
        return;
      }
      addFound(found);
      const st = getState();
      if (st.status === 'idle' && found.length) {
        const first = st.order.find((id) => st.tracks[id].path === found[0].path);
        if (first) void playQueue(st.order, st.order.indexOf(first));
      }
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overFn);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', overFn);
      window.removeEventListener('drop', drop);
    };
  }, []);
  if (!over) return null;
  return (
    <div className="drop-overlay" aria-hidden="true">
      <div className="drop-frame">
        <p>Lepaskan untuk menambahkan ke koleksi</p>
        <span>File dan folder, termasuk subfolder</span>
      </div>
    </div>
  );
}
