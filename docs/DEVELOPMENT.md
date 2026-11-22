# Pengembangan

Cara menjalankan, teknologi, tema, arsitektur, cara mengukur akurasi analisis, dan roadmap.

## Menjalankan sendiri

Butuh [Node.js](https://nodejs.org) versi LTS terbaru.

```bash
git clone https://github.com/attaqifa/Musiccus.git
cd Musiccus
npm install
npm run dev
```

Buka http://localhost:5173.

| Perintah | Fungsi |
| --- | --- |
| `npm run dev` | Server pengembangan dengan hot reload |
| `npm run build` | Typecheck lalu bundle produksi ke `dist/` |
| `npm run preview` | Sajikan hasil build di http://localhost:4173 |
| `npm run typecheck` | Typecheck saja |

Hasil `npm run build` adalah situs statis biasa; cara memasangnya di hosting ada di [Deploy](DEPLOY.md).

## Teknologi

- **Audio:** Web Audio API, AudioWorklet, [signalsmith-stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch) untuk tempo dan nada
- **Analisis:** Web Worker; akor dan kunci dengan pendekatan NNLS Chroma/Chordino dan HMM
- **Stem:** [HTDemucs](https://github.com/facebookresearch/demucs) lewat [ONNX Runtime Web](https://onnxruntime.ai) di WebGPU
- **Visual:** [Three.js](https://threejs.org) dengan bloom
- **UI:** React 19, Zustand, lucide-react; tema *Graphite Prism* dengan huruf Fraunces dan IBM Plex Sans
- **Metadata:** [music-metadata](https://github.com/Borewit/music-metadata); penyimpanan lewat IndexedDB (idb-keyval)

## Tema Graphite Prism

Prinsipnya: warna yang Anda klik tidak pernah berubah, warna yang Anda tonton selalu berubah.

| Peran | Warna | Dipakai untuk |
| --- | --- | --- |
| Interaksi | Putih sinyal `#F2EFE8` (tetap) | Tombol, tab aktif, slider, seek bar, tombol play |
| Status | Hijau `#9DBF7A`, amber `#EAB04A`, merah `#E0614A` (tetap) | Berhasil, perhatian, masalah |
| Ekspresi | 12 warna kunci (OKLCH, terang sama, lingkaran kelima dipetakan ke roda warna) | Visual, lirik, lengan pusaran di logo, garis prisma, Song Map. Tidak pernah dipakai untuk kontrol atau status |
| Rumah | Oren `#F99549` (OKLCH 0,76 / 0,15 / 55°) | Warna Musiccus saat belum ada lagu: lengan pusaran di logo dan ikon, halaman sambutan, visual saat diam. Begitu kunci lagu terbaca, warnanya pelan-pelan berganti ke warna kunci. Hue-nya di tengah antara merah dan amber status, dan lebih terang dari merahnya, jadi tidak terbaca sebagai peringatan |

### Huruf, bentuk, dan kaca

Arahnya "panggung penuh": visual adalah panggungnya, UI cukup jadi kaca tipis di atasnya.

- **Dua huruf, dua suara.** Fraunces untuk hal yang dibaca seperti sampul album: judul lagu, judul sambutan, nama brand, judul di transport, HUD. IBM Plex Sans untuk semua UI, dengan angka tabular (`tnum`) supaya waktu dan meter tidak bergoyang. Tidak ada huruf mono lagi; `--font-mono` sekarang menunjuk ke Plex Sans.
- **Label ditulis biasa.** Kalimat biasa dengan berat 500, tanpa huruf kapital semua dan tanpa letter-spacing.
- **Skala ukuran** 12 / 13 / 14 / 16 / 20 / 28 / 40 px, paling kecil 12 px. Judul lagu memakai `clamp(40px, 5.4vw, 88px)`.
- **Tiga radius.** `--r-s` 8 px untuk elemen kecil, `--r-l` 20 px untuk panel, dan 999 px untuk pill (tombol, chip, segmented, mode).
- **Kaca ikut kunci lagu.** Permukaan (`--void`, `--bg`, `--panel`) dicampur sedikit warna kunci lewat `color-mix(in oklab, rgb(var(--key-rgb)) N%, …)`, dengan blur 28 px. Panel jadi terasa satu ruangan dengan visualnya, tapi tetap netral untuk teks.
- **Satu baris musik di atas judul.** Eyebrow di panggung menulis kunci dan tempo ("C mayor, 120 BPM") dalam warna kunci; kualitas file pindah ke pill di top bar ("FLAC 24-bit/96 kHz").

## Arsitektur

```
File ─► decode ─► AudioBufferSource (+ 3 stem) ─► stem mixer ─► rack efek ─► bus ─┬─► ReplayGain ─► declick ─► volume ─► output
Tab ─► getDisplayMedia ─► MediaStreamSource ──────┘                               └─► analyser + meter worklet (onset)
                                  └─► capture worklet ─► LiveAnalyzer (jendela 30 s, worker analisis tiap 8 s)
                                                                                                │
                                                       AnalysisHub (rAF): frame dipilih sesuai waktu yang terdengar
                                                                                                │
                                                                 ┌──────────────────────────────┴──────────┐
                                                            VisualEngine                         UI (React + Zustand)
                                                            (Three.js + bloom)                   lirik, panel, transport
```

| Folder | Isi |
| --- | --- |
| `src/audio` | `engine.ts` (graf Web Audio, gapless, sinkron waktu), `hub.ts` (fitur dan sinkron A/V), `features.ts` (level dan pulse yang adaptif), `decode.ts` |
| `src/analysis` | `worker.ts` (mastering, tempo, beat, struktur), `harmony.ts` (tuning, nada, kunci, akor), `chordView.ts` (akor Ringkas dan lembar akor), `fixes.ts` (koreksi akor dan kunci dari pendengar, ekspor .lab), `manager.ts` (antrean, cache, koreksi diterapkan di atas hasil analisis), `conductor.ts` (state musik per frame), `spectrogram.worker.ts` (spektrogram seluruh lagu, sesuai permintaan), `fft.ts`, `theory.ts`, `color.ts` |
| `src/lyrics` | `lyrics.ts` (sumber lirik, parser LRC, state), `lrclib.ts` (pencarian dan cache LRCLIB), `timing.ts` (perkiraan waktu per kata dari suku kata, stem vokal, dan beat grid) |
| `src/studio` | `presets.ts` (preset Racik), `graph.ts` (rantai efek, live dan offline), `store.ts`, `control.ts`, `export.ts` |
| `src/stems` | `worker.ts` (HTDemucs di WebGPU, DSP), `dsp.ts`, `mixer.ts` (penggabung stem bit-exact dan panggung HRTF), `manager.ts` (antrean, cache, export, level vokal), `store.ts` |
| `src/visual` | Visual engine, empat world, dan `recorder.ts` (rekam video) |
| `src/live` | Dengar dari tab: `tab.ts` (getDisplayMedia, tebakan judul dari judul tab), `analyzer.ts` (analisis bergulir, jam dengar yang berhenti saat senyap, beat grid yang dilanjutkan), `store.ts` |
| `src/library` | Scan folder, drag-drop, metadata dan cover, analisis koleksi |
| `src/store` | State (Zustand), controller pemutaran (antrean, acak, ulang), `session.ts` (Lanjutkan: lagu, detik, dan antrean terakhir), `sleep.ts` (timer tidur) |
| `src/ui` | Komponen antarmuka; `LyricsOverlay.tsx` (lirik kinetik), `LyricsPanel.tsx` (panel karaoke), `SignalPath.tsx` (jalur suara), `meters/` (Panel Pantau), `FileInfo.tsx` (kualitas file), `understand/` (termasuk `Character.tsx`, `FileEvidence.tsx`, `ChordSheet.tsx`, dan `ChordFix.tsx`), `studio/` (termasuk `Rack.tsx` dan `EqCurve.tsx`), `stems/` |
| `public/worklets` | `meter-processor.js`: deteksi onset kick, snare, dan hat; `musiccus-capture` mengirim suara tab per blok untuk analisis live |
| `src/pwa/sw.js` | Templat service worker; `vite.config.ts` menulisnya ke `dist/sw.js` dengan nomor versi build |
| `src/dev` | `analysisLab.ts` dan `reactivityLab.ts`: lagu sintetis dengan jawaban yang diketahui, untuk mengukur akurasi analisis dan reaksi visual. `chordBench.ts`: mengukur kunci dan akor pada rekaman sungguhan, terhadap file .lab (format MIREX, seperti anotasi Isophonics dan Billboard) atau terhadap koreksi yang Anda simpan. `harmonyLab.ts`: menyetel detektor akor dan kunci pada rekaman beranotasi (setiap lagu dianalisis sekali, lalu setelannya dicoba ratusan kali dalam hitungan detik), dengan `bench-server.cjs` sebagai server lokal untuk audio dan anotasinya. Tidak ikut di-bundle |

Uji reaksi visual dan akurasi analisis dari konsol dev:

```js
await (await import('/src/dev/reactivityLab.ts')).offlineReport();
await (await import('/src/dev/analysisLab.ts')).runSuite();

// Rekaman sungguhan: pilih folder berisi lagu dan .lab bernama sama (lagu.flac + lagu.lab).
const bench = await import('/src/dev/chordBench.ts');
await bench.benchFolder();
// Atau ukur terhadap koreksi tersimpan, untuk lagu di pustaka yang sedang terbuka.
await bench.benchFixes();
```

Skornya mengikuti MIREX: akar akor dan mayor/minor, ditimbang durasi. Kunci dinilai 1 kalau tepat, 0,5 kalau meleset satu kelima ke atas, 0,3 kalau relatif, dan 0,2 kalau paralel.

## Akurasi akor dan kunci

Setelan detektor disetel pada 56 rekaman komersial dengan anotasi akor dan kunci dari Isophonics: Abbey Road, Revolver, dan Sgt. Pepper (43 lagu The Beatles) serta 13 lagu Queen. Penyetelannya per album: setiap album pernah disisihkan, setelannya dicari dari tiga album lain, lalu diukur pada album yang disisihkan itu. Angka di album yang tidak ikut menyetel inilah yang bisa diharapkan pada lagu baru.

| | Akar akor | Mayor/minor | Kunci (skor MIREX) | Kunci tepat |
|---|---|---|---|---|
| The Beatles, setelan lama | 66,8% | 65,4% | 69,5 | 28 dari 43 |
| The Beatles, setelan baru | 75,1% | 73,0% | 73,7 | 30 dari 43 |
| Queen, setelan lama | 57,4% | 55,5% | 65,4 | 8 dari 13 |
| Queen, setelan baru | 65,7% | 63,9% | 65,4 | 8 dari 13 |

Pada album yang disisihkan, mayor/minor naik rata-rata sekitar 6 poin (Abbey Road 68,6 ke 74,3; Revolver 70,2 ke 75,6; Sgt. Pepper 57,4 ke 62,0; Queen 55,5 ke 63,0). Angka di tabel memakai setelan akhir, yang dicari dari keempat album sekaligus, jadi sedikit lebih tinggi. Yang paling banyak membantu: bass lebih dipercaya untuk menentukan akar akor, akor tidak gampang berganti di tengah birama, dan intro yang pelan (gitar sendirian sebelum band masuk) tidak lagi dibaca sebagai hening. Lagu sintetis tetap terbaca benar (99,8% mayor/minor, kuncinya semua tepat).

Membaca akor per setengah ketukan sudah dicoba, tetapi tidak dipakai. Seandainya setiap akor dikenali sempurna, grid per ketukan masih bisa mencapai 95,9% dan grid setengah ketukan 97,0%, jadi ruang perbaikannya hanya sekitar 1 poin. Pada uji nyata, setelan setengah ketukan terbaik naik 0,7 poin (Queen +2,6; Revolver dan Sgt. Pepper justru turun). Waktu pergantiannya juga sudah tepat: pergantian akor yang terbaca benar biasanya meleset kurang dari seperempat ketukan. Yang masih salah terutama akornya sendiri: akor yang bertahan lebih dari dua birama pun baru benar 76%, dan akor 1–2 ketukan 56%.

Ulangi dengan album lain: taruh audio dan .lab di satu folder bersama `manifest.json` (daftar lagu: `song`, `set` seperti nama album, path `audio` dan `chords`, lalu opsional `key`, serta `dur` dan `refDur` untuk panjang audio dan anotasinya), jalankan `node src/dev/bench-server.cjs <folder>`, lalu dari konsol dev:

```js
const lab = await import('/src/dev/harmonyLab.ts');
await lab.prepare('http://127.0.0.1:5199');                    // analisis sekali per lagu
lab.evaluate({}, 'abbey');                                      // setelan sekarang pada satu album
await lab.crossValidate(['abbey', 'revolver', 'pepper', 'queen']); // sisihkan satu album bergiliran
```

## Roadmap

- [x] **Fase A:** tampilan sederhana, lirik otomatis dari LRCLIB, lirik kinetik, dan panel karaoke
- [x] **Fase B:** *Dengar dari tab* dengan analisis live
- [ ] **Fase C:** kartu cerita lagu dalam bahasa sehari-hari, dan *Nyanyi bareng* (karaoke satu tombol)
- [ ] **Fase D:** *Jurnal dengar*: lagu favorit, mood minggu ini, dan warna lagu yang paling sering diputar, tersimpan di perangkat

## Kontribusi

Laporan bug dan ide bisa lewat [Issues](https://github.com/attaqifa/Musiccus/issues). Sebelum mengirim pull request, pastikan `npm run build` lolos tanpa error.
