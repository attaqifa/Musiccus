/*
 * Field view: a plain 2D picture of the stereo field analysis as it plays,
 * to check its numbers by eye before any world draws it. Not imported by the
 * app; open it from the dev console:
 *
 *   const v = await import('/src/dev/fieldView.ts');
 *   v.showField();   // panel at the bottom left
 *   v.hideField();
 *
 * Left to right is pan (as heard), bottom to top is frequency. Orange is tone
 * (sustained notes), white is hit (transients), blue is haze (diffuse sound).
 * The dots mark where each band's direct sound sits on average.
 */
import { hub, type Snapshot } from '../audio/hub';
import { FIELD_BANDS, FIELD_PANS } from '../audio/field';

const W = 560;
const H = 380;
const PLOT = { x: 44, y: 14, w: 340, h: 330 };
const TONE = [249, 149, 73];
const HIT = [242, 239, 232];
const HAZE = [110, 150, 200];
const MARKS = [50, 100, 200, 500, 1000, 2000, 5000, 10000];

let root: HTMLDivElement | null = null;
let off: (() => void) | null = null;

const label = (hz: number) => (hz >= 1000 ? `${hz / 1000}k` : `${hz}`);

export function showField() {
  if (root) return;
  root = document.createElement('div');
  Object.assign(root.style, {
    position: 'fixed',
    left: '16px',
    bottom: '16px',
    width: `${W}px`,
    height: `${H}px`,
    zIndex: '9999',
    background: 'rgba(10, 11, 13, 0.92)',
    border: '1px solid #2A2D31',
    borderRadius: '12px',
    font: '12px "IBM Plex Sans", system-ui, sans-serif',
    color: '#ECEAE6',
  } satisfies Partial<CSSStyleDeclaration>);
  const canvas = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  root.appendChild(canvas);
  const close = document.createElement('button');
  close.textContent = '×';
  close.title = 'Tutup';
  Object.assign(close.style, {
    position: 'absolute',
    top: '6px',
    right: '8px',
    background: 'none',
    border: 'none',
    color: '#B9BCC1',
    fontSize: '18px',
    cursor: 'pointer',
  } satisfies Partial<CSSStyleDeclaration>);
  close.onclick = hideField;
  root.appendChild(close);
  document.body.appendChild(root);

  const ctx = canvas.getContext('2d')!;
  const cells = document.createElement('canvas');
  cells.width = FIELD_PANS;
  cells.height = FIELD_BANDS;
  const cctx = cells.getContext('2d')!;
  const img = cctx.createImageData(FIELD_PANS, FIELD_BANDS);
  off = hub.subscribe((s) => draw(ctx, dpr, cells, cctx, img, s));
}

export function hideField() {
  off?.();
  off = null;
  root?.remove();
  root = null;
}

function draw(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  cells: HTMLCanvasElement,
  cctx: CanvasRenderingContext2D,
  img: ImageData,
  s: Snapshot,
) {
  const f = s.field;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // Cells: each layer adds its colour, squared so quiet cells stay dark.
  const d = img.data;
  for (let b = 0; b < FIELD_BANDS; b++) {
    const y = FIELD_BANDS - 1 - b;
    for (let p = 0; p < FIELD_PANS; p++) {
      const c = b * FIELD_PANS + p;
      const t = f.tone[c] ** 2;
      const h = f.hit[c] ** 2;
      const z = f.haze[c] ** 2 * 0.8;
      const o = (y * FIELD_PANS + p) * 4;
      d[o] = Math.min(255, TONE[0] * t + HIT[0] * h + HAZE[0] * z);
      d[o + 1] = Math.min(255, TONE[1] * t + HIT[1] * h + HAZE[1] * z);
      d[o + 2] = Math.min(255, TONE[2] * t + HIT[2] * h + HAZE[2] * z);
      d[o + 3] = 255;
    }
  }
  cctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(cells, PLOT.x, PLOT.y, PLOT.w, PLOT.h);

  const yOf = (band: number) => PLOT.y + PLOT.h - ((band + 0.5) / FIELD_BANDS) * PLOT.h;
  const xOf = (pan: number) => PLOT.x + ((pan + 1) / 2) * PLOT.w;

  // Grid: centre and the ±0.5 lines, frequency marks.
  ctx.strokeStyle = 'rgba(236, 234, 230, 0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const pan of [-0.5, 0, 0.5]) {
    ctx.moveTo(xOf(pan) + 0.5, PLOT.y);
    ctx.lineTo(xOf(pan) + 0.5, PLOT.y + PLOT.h);
  }
  ctx.stroke();
  ctx.fillStyle = '#8E9196';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const lo = f.freqs[0];
  const hi = f.freqs[FIELD_BANDS - 1];
  for (const hz of MARKS) {
    const band = (Math.log(hz / lo) / Math.log(hi / lo)) * (FIELD_BANDS - 1);
    ctx.fillText(label(hz), PLOT.x - 6, yOf(band));
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('Kiri', xOf(-1) + 12, PLOT.y + PLOT.h + 6);
  ctx.fillText('Tengah', xOf(0), PLOT.y + PLOT.h + 6);
  ctx.fillText('Kanan', xOf(1) - 16, PLOT.y + PLOT.h + 6);

  // Where each band's direct sound sits on average.
  ctx.fillStyle = 'rgba(242, 239, 232, 0.9)';
  for (let b = 0; b < FIELD_BANDS; b++) {
    if (f.level[b] < 0.35 || f.diffuse[b] > 0.8) continue;
    ctx.fillRect(xOf(f.pan[b]) - 1, yOf(b) - 1, 2, 2);
  }

  // Readouts and legend.
  const x = PLOT.x + PLOT.w + 22;
  let y = PLOT.y + 4;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const line = (text: string, color = '#ECEAE6') => {
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    y += 18;
  };
  line('Peta mix', '#ECEAE6');
  y += 4;
  line(`Lebar ${Math.round(f.width * 100)}%`, '#B9BCC1');
  line(`Condong ${f.balance > 0.02 ? 'kanan' : f.balance < -0.02 ? 'kiri' : 'tengah'} ${Math.abs(Math.round(f.balance * 100))}%`, '#B9BCC1');
  line(f.mono ? 'Mono' : 'Stereo', f.mono ? '#EAB04A' : '#B9BCC1');
  let worst = 1;
  for (let b = 0; b < FIELD_BANDS; b++) if (f.level[b] > 0.3) worst = Math.min(worst, f.corr[b]);
  // Diffuse sound wobbles around 0; clearly below it, the band cancels in mono.
  line(`Fase terburuk ${worst.toFixed(2)}`, worst < -0.3 ? '#E0614A' : '#B9BCC1');
  y += 10;
  const swatch = (rgb: number[], text: string) => {
    ctx.fillStyle = `rgb(${rgb.join(',')})`;
    ctx.fillRect(x, y + 3, 10, 10);
    ctx.fillStyle = '#B9BCC1';
    ctx.fillText(text, x + 16, y);
    y += 18;
  };
  swatch(TONE, 'Nada (ditahan)');
  swatch(HIT, 'Pukulan');
  swatch(HAZE, 'Kabut (gema, lebar)');
  ctx.fillStyle = 'rgba(242, 239, 232, 0.9)';
  ctx.fillRect(x + 4, y + 7, 3, 3);
  ctx.fillStyle = '#B9BCC1';
  ctx.fillText('Posisi rata-rata band', x + 16, y);
}
