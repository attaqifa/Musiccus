# Fitur Musiccus

Panduan lengkap semua fitur. Ringkasannya ada di [README](../README.md).

### Dengar (mode utama)

**Memutar lagu**
- Buka folder (termasuk subfolder, diingat untuk kunjungan berikutnya), tambah file, atau seret file dan folder ke jendela.
- **Lanjutkan**: tombol di halaman awal membuka folder terakhir dan memutar lagu terakhir dari detik terakhir (mundur sedikit supaya tidak mulai di tengah kata), dengan antreannya. Berlaku untuk lagu dari folder yang dibuka; file yang diseret tidak bisa dibuka ulang oleh browser setelah reload.
- MP3, AAC, FLAC, WAV, AIFF, Opus, dan Vorbis. Lagu berikutnya menyambung tanpa jeda (gapless).
- **Acak dan ulang** di sebelah tombol lompat: acak mengocok sisa daftar tanpa memotong lagu yang sedang diputar; ulang berganti antara mati, semua, dan satu lagu. Next tetap pindah lagu walau ulang satu lagu menyala.
- **Antrean** (ikon daftar di bar pemutar, atau `Q`): klik kanan lagu atau album di library (tekan lama di layar sentuh) untuk **Putar berikutnya** atau **Tambah ke antrean**; ikon + di baris lagu langsung menambah ke akhir. Lagu yang Anda antrekan diputar dulu, lalu daftar berlanjut dari lagu yang disela. Popover antrean menampilkan apa yang akan diputar, dan setiap lagunya bisa diklik atau dihapus.
- **Timer tidur** (di popover antrean): 15, 30, 45, atau 60 menit, lalu musik memudar pelan sekitar 10 detik dan dijeda; atau berhenti di akhir lagu ini. Ikon bulan kecil di tombol antrean menandai timer yang aktif. Mengubah volume atau menjeda saat musik memudar membatalkan timer.
- **Kontrol dari luar Musiccus**: judul dan cover lagu muncul di kontrol media Windows, notifikasi Android, dan layar kunci. Tombol putar, jeda, berikutnya, dan sebelumnya di keyboard atau headphone Bluetooth tetap bekerja saat jendela lain sedang aktif. Saat mendengar dari tab, tombol itu dibiarkan untuk tab sumbernya.
- Samakan volume antar lagu (ReplayGain per lagu atau per album) di Pengaturan, untuk file yang punya tag-nya.
- **Cek kualitas file**: klik label format di atas (misalnya `Lossless · FLAC · 24-bit`) untuk melihat apakah isi file sesuai labelnya. Musiccus memeriksa spektrumnya dan memberi tahu kalau FLAC ternyata dibuat dari MP3 (dengan perkiraan bitrate-nya), kalau "Hi-Res" sebenarnya kualitas CD yang dibesarkan, atau kalau 24-bit isinya 16-bit. Potongan di sekitar 20 kHz pada file 44,1 atau 48 kHz dinilai *Belum pasti*, karena encoder 256–320 kbps dan banyak master CD sama-sama memotong di sana. Label diberi titik amber kalau ada yang janggal.
- **Jalur suara** (di popover yang sama): apa saja yang dilakukan Musiccus pada suara, dari file sampai keluar ke browser: sample rate, racikan, ReplayGain, koreksi headphone, dan volume. Titik hijau **Tidak diubah Musiccus** berarti sampelnya utuh (volume dan ReplayGain hanya mengubah level, dihitung dalam float 32-bit tanpa kehilangan); amber berarti suaranya diubah, beserta oleh apa. Setelah keluar dari browser, mixer sistem dan codec Bluetooth masih bisa mengubah suara, dan itu disebutkan juga.

**Dengar dari tab** (Chrome, Edge, Brave, atau Opera di komputer)
- Putar lagu di Spotify, YouTube Music, atau situs musik lain di tab sebelah, lalu klik **Dengar dari tab** di halaman awal (atau ikon jendela di library). Pilih tab musiknya di jendela berbagi browser dan pastikan **Bagikan juga audio tab** menyala.
- Browser membisukan tab itu dan suaranya diputar lewat Musiccus, jadi visual, Racik, dan Headphone saya ikut bekerja. Kalau browser tetap memutar suara tab sendiri (suaranya dobel), klik **Suaranya dobel?**: Musiccus diam dan hanya menampilkan visualnya.
- Tidak ada yang diunduh atau disimpan. Browser hanya meneruskan suara tab selama dibagikan, sama seperti saat panggilan video. Berhenti dengan tombol stop di bar pemutar atau **Berhenti berbagi** di browser.
- Jeda, ganti lagu, dan atur volume tetap di tab sumbernya. Senyap lebih dari sebentar dianggap jeda atau pergantian lagu.
- Tempo, kunci, dan akor dianalisis dari setengah menit terakhir dan diperbarui setiap 8 detik, jadi visual mulai mengikuti ketukan beberapa detik setelah lagu terdengar. Warna visual mengikuti kunci lagu.
- Lirik: kalau judul tab berisi judul lagu, liriknya dicari otomatis. Kalau tidak, ketik judulnya di panel lirik (`I`). Klik baris yang sedang dinyanyikan untuk menyamakan waktunya. Lirik hilang sendiri saat lagunya selesai.
- Yang tidak tersedia untuk tab, karena butuh seluruh lagu atau file aslinya: kecepatan (nada tetap bisa diubah, dan preset Slowed + reverb terdengar lebih dalam tanpa melambat), simpan sebagai file, pemisahan stem, Song Map, dan Karakter rekaman.

**Headphone saya** (Pengaturan → Headphone)
- Ketik model headphone atau earphone Anda, misalnya "Sony XM4" atau "AirPods Pro". Musiccus memasang kurva koreksi dari proyek [AutoEQ](https://github.com/jaakkopasanen/AutoEq) supaya warna suaranya mendekati netral di semua lagu. Daftarnya memuat lebih dari 6.000 model hasil ukur oratory1990, crinacle, Rtings, dan lainnya; untuk model yang diukur beberapa lab, hasil lab paling tepercaya yang dipakai.
- Yang diunduh hanya daftar model (disimpan sebulan) dan profil model yang Anda pilih. Teks yang Anda ketik tidak dikirim ke mana pun.
- **Suara lebih natural** (crossfeed): sedikit suara kiri dibawa ke telinga kanan dan sebaliknya, seperti mendengar dari speaker. Berguna untuk lagu lama yang stereonya ekstrem.
- Koreksi ini menempel di headphone, bukan di lagu: tetap aktif saat membandingkan dengan suara asli, dan tidak ikut tersimpan saat lagu diekspor.

**Lirik yang ikut lagu**
- Sumber lirik, dicoba berurutan:
  1. file `.lrc` bernama sama di folder lagu;
  2. lirik yang tersimpan di tag file (SYLT, atau tag LYRICS berisi LRC);
  3. lirik yang pernah Anda pilih sendiri untuk lagu itu;
  4. **LRCLIB** ([lrclib.net](https://lrclib.net)), database lirik terbuka yang gratis dan tanpa akun.
- Pencarian LRCLIB memakai judul, artis, album, dan durasi dari tag. Kalau tag kosong, nama file `Artis - Judul` juga dipakai. Hasil yang durasinya berbeda lebih dari 4 detik ditolak, karena itu biasanya versi lain dari lagu itu (radio edit, extended) dengan waktu lirik berbeda. Jawaban disimpan di browser, jadi satu lagu hanya dicari sekali. Pencarian online bisa dimatikan di Pengaturan → Lirik.
- Lirik salah atau tidak ketemu? Tombol cari di panel lirik mencari versi lain di LRCLIB, dan pilihan Anda diingat untuk file itu. File `.lrc` yang diseret ke jendela juga langsung dipakai.
- **Dua tampilan**:
  - **Lirik kinetik** di atas visual (nyalakan atau matikan dengan tombol mikrofon di bilah pemutar, atau `Y`): kata muncul tepat saat dinyanyikan dan meletup, baris yang sedang dinyanyikan berdenyut mengikuti kick dan snare, chorus tampil lebih besar, dan kata yang sedang dinyanyikan bercahaya dengan warna dari palet lagu. Cahaya visual 3D tepat di belakang lirik diredam halus tanpa kotak, jadi teks tetap terbaca di atas inti Nebula, matahari Lanskap, atau tirai Aurora.
  - **Panel karaoke** (tombol `I`): seluruh lirik bergulir mengikuti lagu, kata yang sedang dinyanyikan terisi dari kiri ke kanan, dan klik sebuah baris untuk melompat ke sana. Selama panel terbuka, lirik kinetik disembunyikan.
- **Waktu per kata**: hampir semua lirik (LRCLIB juga) hanya punya waktu per baris. Musiccus memperkirakan waktu setiap kata:
  1. Kata membagi bagian baris yang dinyanyikan menurut jumlah suku katanya. Panjang bagian itu mengikuti tempo lagu dan tidak pernah melewati baris berikutnya.
  2. Kalau vokal sudah dipisahkan dengan AI di mode Stem, setiap kata pindah ke awal suku kata terdekat yang terdengar di stem vokal, dan baris berakhir saat suaranya berhenti.
  3. Kata yang jatuh dekat ketukan 1/16 dari beat grid ditempelkan ke ketukan itu, karena di situ suku kata biasanya dinyanyikan.

  Kata pertama tetap memakai waktu baris dari liriknya. Lirik LRC enhanced (waktu per kata dari sumbernya) dipakai apa adanya. Uji dengan suara sintetis yang waktu suku katanya diketahui: keenam kata jatuh tepat di awal suku kata. Pada lagu sungguhan, perkiraan tanpa stem vokal masih bisa meleset beberapa ratus milidetik di frasa yang dinyanyikan lambat.
- Waktu lirik bisa digeser ±0,1 detik per lagu kalau terasa mendahului atau terlambat.

**Visual**
- **Nebula**: galaksi partikel. Bass jadi massa, kick memicu gelombang kejut, hi-hat jadi percikan.
- **Lanskap**: ngarai spektral menuju gerhana yang bernapas mengikuti musik.
- **Aurora**: tirai cahaya di atas danau; kick menjatuhkan riak.
- Warna mengikuti nuansa lagu (kuncinya) dan tetap satu keluarga dari awal sampai akhir; bagian lagu hanya mengubah intensitas. Bisa diganti ke warna cover album atau monokrom.
- Visual tahu struktur lagunya: ketegangan dibangun beberapa bar sebelum bagian yang lebih keras, lalu meledak tepat di awalnya. Setiap pergantian akor terlihat.
- Reaksinya adaptif untuk lagu yang di-master keras: kick yang memicu efek naik dari 61% ke 100% pada lagu uji bercrest 7,4 dB.
- Mode panggung tanpa UI (`H`), layar penuh (`F`).
- Visual dan lirik ditunda sebesar latensi output supaya jatuh tepat saat suaranya sampai. Untuk headphone Bluetooth ada kalibrasi klik-dan-kilatan di Pengaturan.

### Pahami (tombol `U`)

- Tempo, kunci, akor mayor/minor per ketukan, dan bagian lagu (Intro, Verse, Chorus, Bridge, Outro), dianalisis sekali per lagu di latar belakang dan disimpan.
- Kunci dan akor dibaca dari nada yang benar-benar dimainkan: nada acuan lagu dikenali dulu (lagu yang disetel 432 Hz tetap terbaca benar), setiap ketukan diurai menjadi nada beserta harmoniknya (cara NNLS Chroma/Chordino), dan bass dibaca terpisah dari treble. Akor 7th dikenali lalu ditampilkan sebagai mayor/minor dasarnya. Kunci ditentukan dari profil nada sekaligus dari akor mana yang jadi rumah dan akor mana yang mengarah ke sana. Akor di luar tangga nada dieja menurut derajatnya, misalnya B♭ (♭VI) di D mayor, bukan A♯.
- Lembar akor di Pahami, tertutup sampai dibuka: birama empat per baris seperti chord sheet, ketukan yang sedang diputar menyala, dan baris yang diputar selalu di atas dengan dua baris berikutnya di bawahnya. Klik birama untuk memutar dari sana. "Akor sekarang" juga menyebut akor berikutnya.
- Tampilan akor Ringkas (bawaan) atau Lengkap. Ringkas meleburkan akor yang kurang dari dua ketukan ke akor di sebelahnya dan menaruh setiap pergantian tepat di ketukan, jadi akor paling cepat berganti tiap dua ketukan. Pada 56 rekaman beranotasi, akurasinya hampir sama dengan Lengkap (69,5% dan 70,4% mayor/minor), dengan pergantian akor yang lebih jarang (21 dan 25 per menit). Pilihan ini berlaku di semua tampilan akor.
- **Akor atau kunci salah?** Tombol *Salah?* di Akor sekarang dan *Ubah* di Kunci membuka pilihan nada dasar dan mayor/minor (atau *Tanpa akor*). Di lembar akor, tombol *Koreksi* membuat setiap akor bisa diklik, dengan pilihan untuk mengganti juga akor yang sama di seluruh lagu. Koreksi disimpan per file (nama, ukuran, dan tanggalnya), tetap berlaku saat versi analisis berganti, dan langsung dipakai di semua tampilan dan visual. Centang *Saya sudah memeriksa seluruh lembar ini* supaya akor yang tidak diubah ikut dicatat sebagai benar, lalu *Unduh .lab* untuk menyimpan akor dan kuncinya dalam format MIREX.
- Tombol kecepatan 100%, 85%, dan 70% di lembar akor untuk memelankan lagu tanpa mengubah nadanya (sama dengan Tempo di Racik).
- Song Map di bawah panggung: bagian lagu, lajur akor, dan kurva energi. Klik untuk melompat.
- HUD akor besar dengan titik ketukan dan hitung mundur ke bagian berikutnya; Harmony Wheel di panel.
- Panel berurutan Musik, Harmoni, Karakter rekaman, lalu file. Setiap bagian punya satu kalimat penjelasan yang terlihat langsung, jadi tetap terbaca di layar sentuh.
- **Karakter rekaman**: angka mastering diterjemahkan ke kalimat biasa: seberapa dinamis lagunya, seberapa keras dibanding standar streaming, seberapa lebar stereonya, warna suaranya (hangat, terang, seimbang). Batas warna suara disetel dari pengukuran rekaman sungguhan, dari rock 1970-an sampai pop 2026: master yang wajar terbaca Seimbang, dan label lain hanya muncul kalau jelas menyimpang.
- Di layar sempit (bar atas menyembunyikan label format), bagian **File dan jalur suara** di panel ini menunjukkan kualitas file dan jalur suaranya.

### Racik (tombol `B`)

- **Preset satu klik**: Asli, Bass lebih tebal, Vokal lebih jelas, Lebih lapang, Aula konser, Slowed + reverb, Sped up, Dengar pelan (untuk volume kecil di malam hari), dan Lo-fi. Setiap preset mulai dari suara asli, jadi tidak saling menumpuk.
- **Dengar asli** (tombol `A`): bandingkan racikan dengan suara aslinya. Klik untuk berganti, atau tahan lalu lepas untuk mendengar aslinya sesaat. Volume suara asli disamakan dengan racikan (diukur K-weighted selama lagu diputar), supaya yang terdengar lebih bagus bukan sekadar yang lebih keras.
- **Racikan saya**: simpan setelan yang Anda suka dengan nama sendiri (sampai 6), lalu pakai lagi dengan satu klik dari daftar preset.
- **Simpan sebagai file**: lagu dengan racikan Anda disimpan sebagai WAV, misalnya versi slowed + reverb sendiri.
- Selama suara diracik, chip di bar pemutar menunjukkan nama racikannya dan tombol Asli, jadi suara yang berubah tidak pernah mengejutkan.
- Visual ikut bereaksi: gema melebarkan cahaya seperti kabut, saturasi membuatnya lebih panas.
- Saat preset Asli dipakai, rantai efek dilewati sepenuhnya, jadi suaranya persis file aslinya.

### Stem (tombol `S`)

- Pisahkan lagu menjadi vokal, drum, bass, dan lainnya:
  - **AI**: HTDemucs dari Meta (lisensi MIT) berjalan di GPU Anda lewat WebGPU. Model 126 MB diunduh sekali lalu disimpan di browser.
  - **Cepat**: pemisahan DSP dalam hitungan detik, tanpa unduhan, hasilnya lebih kasar.
- Preset Karaoke, A cappella, Tanpa drum, Tanpa bass, dan Ritme; mixer per stem; dan panggung 3D binaural (pakai headphone).
- Stem vokal juga mempertajam waktu per kata di lirik.
- Hasil AI disimpan (maksimal 2,5 GB), jadi lagu yang pernah dipisahkan siap lagi dalam setengah detik.

### Rincian lengkap

Semua kemampuan Musiccus selalu terlihat. Selain preset dan kalimat biasa, ada tiga lapisan rincian:

- **Rack knob** di Racik, di bawah preset. Setiap modul adalah kartu dengan lampu (menyala = sedang mengubah suara) dan ringkasan setelannya; klik judulnya untuk menyalakan atau mematikan.
  - Nada dan kecepatan (semitone, cent, tempo 50–150%, jaga nada atau gaya piringan hitam, jaga warna vokal), dengan BPM dan kunci hasil perubahan.
  - Filter sweep low-pass/high-pass dengan resonansi.
  - EQ parametrik 8 band dengan kurva respons yang dihitung dari filter Web Audio sungguhan, digambar di atas spektrum rata-rata lagu. Seret titiknya untuk frekuensi dan gain, scroll untuk Q, atau pakai panah (Shift untuk langkah besar).
  - Kompresor dengan meter gain reduction dan makeup otomatis, drive tabung atau pita, lebar stereo dan cek mono, delay yang ikut tempo, ruang (studio, hall, katedral, plate), dan gain output dengan limiter pengaman.
  - Knob: seret ke atas atau bawah, scroll (Shift untuk halus), panah dan Home/End dari keyboard, klik ganda untuk kembali ke nilai awal.
  - Simpan sebagai WAV 24-bit atau 32-bit float.
- **Panel Pantau** (tombol `O`, atau ikon di bar atas): meter di bawah panggung yang mengukur suara setelah racikan dan sebelum volume.
  - Level: peak PPM, RMS, peak hold, dan lampu clip dari true peak.
  - Loudness: momentary, short-term, integrated (LUFS), true peak, dan PLR, dengan riwayat 60 detik bergaris −14 (streaming) dan −23 (siaran).
  - Spektrum dengan nama nada saat diarahkan; selama suara diracik, garis putus-putus menunjukkan spektrum aslinya.
  - Goniometer dan korelasi stereo.
  - Di ponsel, keempatnya menjadi tab.
- **Lebih dalam di Pahami**:
  - Karakter rekaman menampilkan angkanya di samping setiap kalimat (DR, integrated LUFS, korelasi dan lebar stereo, selisih bass dan treble), ditambah LRA, true peak, PLR, clipping, dan bit efektif, masing-masing dengan satu kalimat penjelasan.
  - Sungai Nada (nada yang dipakai dari waktu ke waktu), angka Romawi akor, dan nada acuan lagu (A4 = 440 Hz atau lainnya).
  - **Keaslian file**: spektrum rata-rata seluruh lagu dan batas frekuensi yang ditemukan, untuk melihat sendiri kenapa sebuah file dinilai asli, transcode, atau upsample.
  - Spektrogram seluruh lagu dengan sumbu frekuensi linear, tempat "langit-langit" encoder lossy terlihat jelas. Garis menunjukkan posisi putar; klik untuk melompat, dan tombol perbesar untuk melihat lebih tinggi. Dihitung di worker saat bagian ini dibuka, tanpa mengubah cache analisis.

### Peta koleksi (tombol `G`)

- Setiap lagu menjadi bintang berwarna kuncinya, ditata menurut energi dan suasana, atau di roda Camelot.
- **Jalur harmonis** menyusun antrean yang berpindah kunci tanpa bentrok, dengan tempo dan energi yang berdekatan.

## Pintasan keyboard

| Tombol | Aksi |
| --- | --- |
| Spasi | Putar / jeda |
| ← → | Mundur / maju 5 detik (Shift: 30 detik) |
| ↑ ↓ | Volume |
| N / P | Lagu berikutnya / sebelumnya |
| M | Mute |
| U | Ganti mode Dengar / Pahami |
| B | Mode Racik |
| A | Dengar asli (tahan untuk sesaat) |
| S | Mode Stem |
| O | Panel Pantau (meter level, loudness, spektrum, stereo) |
| 1 – 3 | Visual Nebula, Lanskap, Aurora |
| Y | Lirik di atas visual |
| Q | Antrean, acak, ulang, dan timer tidur |
| G | Peta koleksi |
| H | Mode panggung |
| L / I | Library / panel kanan (panel lirik di mode Dengar) |
| F | Layar penuh |
| , | Pengaturan |
| ? | Daftar pintasan |
| Esc | Tutup pengaturan, antrean, Peta koleksi, mode panggung, atau laci di layar kecil |

## Keterbatasan

- ALAC, APE, WavPack, dan DSD belum bisa diputar. File-nya tetap muncul di library dan dilewati saat memutar.
- Lirik LRCLIB ditulis oleh komunitas: ada lagu yang belum punya lirik, liriknya belum bertanda waktu, atau waktunya sedikit meleset (bisa digeser per lagu).
- Waktu per kata adalah perkiraan, kecuali liriknya LRC enhanced. Tanpa stem vokal, perkiraannya hanya dari suku kata dan ketukan.
- Akor ditampilkan hanya sebagai mayor/minor (7th dilipat ke dasarnya; sus, dim, dan aug dibaca sebagai akor terdekat) dan birama diasumsikan 4/4. Kunci dianggap satu untuk seluruh lagu, jadi lagu yang naik kunci di chorus terakhir tetap memakai kunci awalnya. Nama bagian lagu adalah perkiraan.
- Pada rekaman sungguhan, kira-kira tiga dari empat ketukan dapat akor mayor/minor yang benar (The Beatles 73%, Queen 64%; lihat [Akurasi akor dan kunci](DEVELOPMENT.md#akurasi-akor-dan-kunci)). Kesalahannya kebanyakan soal akor mana, bukan kapan: akor tertukar dengan tetangganya (IV, V, atau relatifnya), akor pendek 1–2 ketukan terlewat, atau bagian yang tipis terbaca tanpa akor. Aransemen padat dengan banyak lapisan vokal dan gitar, seperti Queen, lebih sulit. Lagu yang disetel hampir seperempat nada dari 440 Hz bisa terbaca satu semitone meleset (di uji ini: Lovely Rita dan Another One Bites the Dust). Kunci lagu yang berpindah kunci dinilai terhadap kunci yang paling lama dipakai. Rock dengan power chord (tanpa terts) dan progresi yang memang ambigu (misalnya Am–Dm–G–C, bisa A minor atau C mayor) masih paling sering meleset.
- Keaslian file dinilai dari spektrum rata-rata. Upsample yang memakai interpolasi sederhana, bukan filter yang rapi, meninggalkan bayangan spektrum di atas 22 kHz dan bisa lolos sebagai hi-res asli.
- Pemisahan AI butuh WebGPU (Chrome/Edge terbaru). Stem lagu yang sedang diputar disimpan di memori: lagu 4 menit memakan sekitar 280 MB tambahan.
- Seluruh lagu di-decode ke memori, jadi file yang sangat panjang memakai RAM cukup besar.
- Dengar dari tab hanya ada di browser Chromium di komputer; Firefox, Safari, dan browser HP tidak bisa membagikan suara tab. Analisisnya hanya melihat setengah menit terakhir, jadi kunci dan tempo butuh beberapa detik untuk muncul dan bisa berubah di awal lagu. Banyak browser tidak memberi tahu judul tab, jadi lirik sering perlu dicari sendiri.
