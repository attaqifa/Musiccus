# Deploy sebagai website

Musiccus adalah situs statis: tidak ada server, tidak ada database, dan tidak ada akun. Semua kerja (decode, analisis, pemisahan stem, visual) terjadi di browser pengunjung, dan lagu mereka tidak pernah diunggah. Satu-satunya permintaan ke layanan luar yang menyangkut lagu adalah pencarian lirik ke LRCLIB, yang hanya berisi judul, artis, album, dan durasi. Fitur Headphone saya mengunduh daftar model dan profil headphone dari GitHub (AutoEQ), tanpa mengirim apa pun tentang lagu atau pengunjung. Data per pengunjung (pengaturan, hasil analisis, lirik, stem, model AI) tersimpan di browser masing-masing.

Hasil `npm run build` ada di `dist/` dan bisa diunggah ke hosting statis mana pun yang memakai HTTPS. Halaman memakai path relatif, jadi bisa di root domain maupun di subfolder.

| Hosting | Cara |
| --- | --- |
| Cloudflare Pages | Build command `npm run build`, output `dist`. Header cache dibaca dari `public/_headers`. |
| Netlify | Build command `npm run build`, publish directory `dist`. `public/_headers` juga dibaca. |
| Vercel | Framework preset Vite, output `dist`. |
| GitHub Pages | Unggah isi `dist/` (misalnya lewat GitHub Actions). Tidak perlu header khusus. Set `SITE_URL` saat build (lihat [Pratinjau link](#pratinjau-link)). |

HTTPS wajib, karena buka folder, WebGPU, dan service worker hanya jalan di koneksi aman. Semua hosting di atas menyediakannya.

## Pemuatan dan offline

- Muat pertama hanya berisi yang dibutuhkan untuk mendengar. Three.js menyusul setelah halaman tampil; panel setiap mode dan pembaca tag dimuat saat dibutuhkan.
- **PWA:** bisa di-*install* dari browser. Service worker menyimpan seluruh aplikasi pada kunjungan pertama, jadi Musiccus bisa dibuka offline (lirik yang belum pernah dicari tentu butuh internet). Daftar filenya (`precache.json`) dan `sw.js` dibuat saat build dari `src/pwa/sw.js`.
- **Pembaruan:** setiap build memberi `sw.js` nomor versi baru. Pada kunjungan online berikutnya browser memasang versi baru dan menghapus versi lama. Tab lama yang masih terbuka saat Anda deploy memuat ulang sendiri begitu membuka bagian yang filenya sudah tidak ada.

## Pratinjau link

`index.html` berisi judul, deskripsi, dan gambar (`public/og-image.jpg`, 1200×630) untuk pratinjau di WhatsApp, X, Facebook, dan Slack. Aplikasi tersebut butuh alamat gambar yang lengkap. Netlify, Vercel, dan Cloudflare Pages menyediakan alamat situs saat build. Kalau situs memakai domain sendiri, atau di hosting lain, set alamat situs Anda:

```bash
SITE_URL=https://domain-anda/ npm run build
```

Di Vercel, isi `SITE_URL` di Project Settings → Environment Variables; tanpa itu, pratinjau memakai alamat `*.vercel.app`.

## Ponsel dan tablet

Di layar 960 px ke bawah, library dan panel kanan menjadi laci di atas panggung: hanya satu yang terbuka, dan ketuk panggung (atau Esc) untuk menutup. Di ponsel, tab mode pindah ke baris sendiri. Kualitas visual "Otomatis" menyesuaikan perangkat.

## File AI di luar `dist/`

Engine pemisah stem (`ort-wasm…asyncify.wasm`, 28,7 MB) dimuat dari jsDelivr dengan versi yang sama persis dengan yang terpasang, karena beberapa hosting membatasi ukuran file 25 MiB. Modelnya (126 MB) diambil dari commit Hugging Face yang dipatok. Keduanya baru diunduh saat pengunjung pertama kali memakai pemisahan AI. Untuk menyimpannya di hosting sendiri, set saat build:

```bash
VITE_ORT_BASE=https://domain-anda/ort/ VITE_MODEL_BASE=https://domain-anda/models/htdemucs/ npm run build
```

Isi `ort/` adalah `ort-wasm-simd-threaded.asyncify.mjs` dan `.wasm` dari `node_modules/onnxruntime-web/dist/`. Isi `models/htdemucs/` adalah `htdemucs_split_manifest.json` dan 21 file `htdemucs_pNN.onnx`.

## Laptop dengan dua GPU

Windows menjalankan browser di GPU terintegrasi (misalnya Intel UHD) supaya hemat baterai, walaupun laptopnya punya NVIDIA atau AMD. Halaman web tidak bisa memilih GPU sendiri. Pengaturan → Visual → Kartu grafis menampilkan GPU yang dipakai, dan kalau itu GPU terintegrasi di Windows, juga cara memindahkan browser ke GPU yang lebih cepat.

## Dukungan browser

Chrome atau Edge di desktop mendukung semua fitur. Di Firefox dan Safari, pemutaran, visual, lirik, analisis, dan Racik tetap jalan; halaman awal menyebutkan fitur yang tidak tersedia (buka folder, dengar dari tab, pemisahan vokal AI).
