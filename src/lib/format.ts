const nf1 = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return (h > 0 ? `${h}:` : '') + `${mm}:${String(r).padStart(2, '0')}`;
}

export function formatDb(db: number, unit = 'dB', withSign = true): string {
  if (!Number.isFinite(db)) return `−∞ ${unit}`.trim();
  const sign = withSign && db > 0.05 ? '+' : '';
  return `${sign}${nf1.format(db).replace('-', '−')} ${unit}`.trim();
}

export function formatLufs(v: number): string {
  if (!Number.isFinite(v) || v < -99) return '—';
  return nf1.format(v).replace('-', '−');
}

export function formatRate(hz: number | undefined): string {
  if (!hz) return '—';
  const k = hz / 1000;
  return `${Number.isInteger(k) ? nf0.format(k) : nf1.format(k)} kHz`;
}

export function formatRateShort(hz: number | undefined): string {
  if (!hz) return '?';
  const k = hz / 1000;
  return Number.isInteger(k) ? String(k) : k.toFixed(1).replace(/\.0$/, '');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${nf1.format(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${nf1.format(n / 1024 ** 2)} MB`;
  return `${nf1.format(n / 1024 ** 3)} GB`;
}

export function formatKbps(bps: number | undefined): string {
  if (!bps) return '';
  return `${nf0.format(Math.round(bps / 1000))} kbps`;
}

export function formatHz(hz: number): string {
  if (hz >= 1000) return `${nf1.format(hz / 1000)} kHz`;
  return `${nf0.format(Math.round(hz))} Hz`;
}

export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => (g > 0 ? 20 * Math.log10(g) : -Infinity);
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
