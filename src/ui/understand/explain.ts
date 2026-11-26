/*
 * What the music words mean, in one place, so Pahami, the live view and the
 * stage all explain them the same way. Meaning first; how Musiccus measured
 * it comes after, for whoever wants it.
 */

export const EXPLAIN = {
  key: 'Kunci adalah rumah lagu: nada tempat musiknya terasa pulang dan selesai. Musiccus membaca nada yang dimainkan (bass dan treble terpisah), lalu memeriksa akor mana yang jadi rumah.',
  liveKey: 'Kunci adalah rumah lagu: nada tempat musiknya terasa pulang. Di sini dibaca dari setengah menit terakhir, jadi makin pasti seiring lagunya berjalan.',
  confidence: 'Seberapa jelas kunci ini terbaca dari nadanya. Makin rendah, makin mungkin lagunya ambigu atau berpindah kunci; dengarkan, lalu pilih sendiri lewat Ubah bila perlu.',
  liveConfidence: 'Seberapa jelas kunci ini terbaca dari nadanya. Angkanya naik seiring makin banyak lagu yang terdengar.',
  tuning: 'Nada acuan lagu. Standarnya A4 = 440 Hz, tapi sebagian lagu disetel lebih rendah atau tinggi. Musiccus menyesuaikan diri dulu sebelum membaca kunci dan akor.',
  tempo: 'Kecepatan ketukan, dalam ketukan per menit (BPM). Dihitung dari pola awal tiap nada (autokorelasi onset), lalu setiap ketukan dipetakan di sepanjang lagu.',
  liveTempo: 'Kecepatan ketukan, dalam ketukan per menit (BPM), dari analisis terakhir. Ketukan di antaranya dilanjutkan dengan tempo yang sama.',
  numeral: 'Posisi akor di dalam kunci. I adalah rumah, V paling ingin pulang ke I, IV melangkah menjauh. Huruf kecil berarti akor minor.',
  sectionLetter: 'Huruf bagian: bagian dengan huruf yang sama terdengar mirip, misalnya setiap Chorus.',
} as const;

/** The Camelot code with its actual neighbours, so the rule reads as something to use. */
export function camelotTip(code: string): string {
  const n = Number.parseInt(code, 10);
  const letter = code.slice(-1);
  if (!n || (letter !== 'A' && letter !== 'B')) return 'Kode Camelot: lagu dengan kode sama atau bersebelahan bersambung tanpa terdengar sumbang.';
  const prev = n === 1 ? 12 : n - 1;
  const next = n === 12 ? 1 : n + 1;
  const other = letter === 'A' ? 'B' : 'A';
  return `Kode Camelot, cara DJ menyambung lagu: lagu berkode ${code}, ${prev}${letter}, ${next}${letter}, atau ${n}${other} bersambung dengan lagu ini tanpa terdengar sumbang.`;
}
