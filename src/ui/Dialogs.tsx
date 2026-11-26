import { X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { droppedLyrics, filesFromDrop } from '../library/scan';
import { attachLrc } from '../lyrics/lyrics';
import { addFound, playQueue, setRgMode } from '../store/controller';
import { getState, setSettings, setUi, usePlayer, type ColorSource, type Mode, type QualityChoice, type Settings } from '../store/player';
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
        <button key={o.value} role="radio" aria-checked={value === o.value} className={cls(value === o.value && 'on')} onClick={() => onChange(o.value)} data-tip={o.hint}>
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
  ['1 – 3', 'Visual Nebula, Lanskap, Aurora'],
  ['B', 'Mode Racik: preset suara, kecepatan, dan nada'],
  ['A', 'Dengar asli: bandingkan racikan dengan suara asli (tahan untuk sesaat)'],
  ['S', 'Mode Stem: pisahkan vokal, drum, bass; karaoke dan panggung 3D'],
  ['Q', 'Antrean, acak, ulang, dan timer tidur'],
  ['G', 'Peta koleksi'],
  ['O', 'Panel Pantau: meter level, loudness, spektrum, dan stereo'],
  ['Y', 'Tampilkan / sembunyikan lirik'],
  ['H', 'Mode panggung: sembunyikan semua UI'],
  ['L / I', 'Tampilkan koleksi / panel kanan (lirik di mode Dengar)'],
  ['F', 'Layar penuh'],
  [',', 'Pengaturan'],
  ['?', 'Panduan mode ini'],
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

/*
 * The guide for the mode you are in: what it is for, what each part shows,
 * and only then the keys. Touch screens get the guide without the keys.
 */
const GUIDE: Record<Mode, { name: string; lede: string; parts: [string, string][]; keys: string[] }> = {
  dengar: {
    name: 'Dengar',
    lede: 'Visual yang hidup mengikuti musik. Tidak ada yang perlu diatur di sini; mode ini untuk mendengar.',
    parts: [
      ['Dunia visual', 'Nebula, Lanskap, atau Aurora, dipilih di bawah panggung. Warnanya mengikuti kunci lagu.'],
      ['Lirik', 'Buka panelnya dari tombol mikrofon di atas, atau tampilkan liriknya bergerak di atas visual.'],
      ['Mode panggung', 'Sembunyikan semua kontrol dan biarkan visualnya mengisi layar.'],
      ['Antrean', 'Acak, ulang, dan timer tidur ada di tombol antrean.'],
    ],
    keys: ['Spasi', '1 – 3', 'Y', 'H', 'Q'],
  },
  pahami: {
    name: 'Pahami',
    lede: 'Kenali lagunya: rumahnya, ketukannya, akornya, dan bentuknya. Kata bergaris titik bisa diklik atau diketuk untuk penjelasan.',
    parts: [
      ['Kunci dan tempo', 'Kunci adalah rumah lagu, tempo adalah kecepatan ketukannya. Kode Camelot di sebelahnya membantu menyambung lagu.'],
      ['Akor sekarang', 'Nama akor dan angka romawinya: I adalah rumah, V paling ingin pulang. Akor berikutnya tampil di kanan.'],
      ['Bagian lagu', 'Intro, Verse, Chorus, dan seterusnya. Warna yang sama berarti bagian yang terdengar mirip.'],
      ['Terbaca salah?', 'Ubah, ½× / 2×, dan Salah? menyimpan koreksi Anda untuk file ini.'],
    ],
    keys: ['Spasi', '← →', 'U'],
  },
  bentuk: {
    name: 'Racik',
    lede: 'Atur rasa suara tanpa merusak aslinya. Mulai dari preset; buka Rack kalau ingin mengatur sendiri.',
    parts: [
      ['Pilih rasa', 'Satu klik, langsung terdengar. Setiap preset mulai dari suara asli.'],
      ['Rack', 'EQ, kompresor, ruang, dan modul lainnya. Klik nama modul untuk menyalakannya; lampunya menyala saat modul itu sedang mengubah suara.'],
      ['Knob', 'Seret naik atau turun untuk mengubah, klik ganda untuk kembali ke nilai awal.'],
      ['Dengar asli', 'Bandingkan dengan suara asli kapan saja. Volumenya disamakan supaya perbandingannya adil.'],
    ],
    keys: ['B', 'A'],
  },
  stem: {
    name: 'Stem',
    lede: 'Pisahkan lagu menjadi vokal, drum, bass, dan lainnya, lalu dengarkan satu per satu.',
    parts: [
      ['Pemisahan', 'Bersih (AI) untuk hasil yang rapi, Instan (DSP) untuk karaoke cepat. Hasil AI disimpan, jadi setiap lagu cukup dipisahkan sekali.'],
      ['Mixer stem', 'Level, pan, mute, dan solo per stem, atau sekali klik: Karaoke, A cappella, Tanpa drum, dan lainnya.'],
      ['Panggung 3D', 'Tempatkan setiap stem di ruang di sekitar kepala Anda.'],
      ['Unduh', 'Setiap stem bisa diunduh sebagai WAV 24-bit.'],
    ],
    keys: ['S'],
  },
};

function KeyList({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="shortcuts">
      {rows.map(([k, d]) => (
        <div key={k}>
          <dt>
            <kbd>{k}</kbd>
          </dt>
          <dd>{d}</dd>
        </div>
      ))}
    </dl>
  );
}

export function HelpDialog() {
  const open = usePlayer((s) => s.ui.help);
  const mode = usePlayer((s) => s.ui.mode);
  if (!open) return null;
  const g = GUIDE[mode];
  const here = SHORTCUTS.filter(([k]) => g.keys.includes(k));
  return (
    <Modal onClose={() => setUi({ help: false })} label={`Panduan ${g.name}`} className="guide">
      <h2>{g.name}</h2>
      <p className="guide-lede">{g.lede}</p>
      <dl className="guide-parts">
        {g.parts.map(([t, d]) => (
          <div key={t}>
            <dt>{t}</dt>
            <dd>{d}</dd>
          </div>
        ))}
      </dl>
      <div className="guide-keys">
        <h3>Pintasan di mode ini</h3>
        <KeyList rows={here} />
        <details>
          <summary>Semua pintasan keyboard</summary>
          <KeyList rows={SHORTCUTS} />
        </details>
      </div>
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
