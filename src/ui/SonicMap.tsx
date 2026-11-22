import { Play, Route, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import { getAnalysis } from '../analysis/manager';
import { camelot, keyAccent, keyName, noteName, rgbCss, usesFlats } from '../analysis/theory';
import type { Analysis, KeyInfo, Rgb } from '../analysis/types';
import { analyseCollection, cancelCollection, loadCollectionCache, unanalysedCount, useCollection } from '../library/collection';
import { playQueue } from '../store/controller';
import { setUi, usePlayer } from '../store/player';
import { cls, useHubCanvas } from './hooks';
import { C, MONO, signalA } from './palette';

type Layout = 'mood' | 'harmony';

interface Star {
  id: string;
  title: string;
  artist: string;
  key: KeyInfo;
  bpm: number;
  energy: number;
  mood: number;
  cam: { n: number; minor: boolean };
  /** Positions in both layouts, unit square centred on 0. */
  a: [number, number];
  b: [number, number];
  rgb: Rgb;
  color: string;
  size: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Deterministic jitter so stars never stack exactly. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * Centre of the energy per octave, 0 (dark) .. 1 (bright). LTAS points are
 * power per Hz, so p·f weighs each octave equally. Pop and rock masters
 * measured between about 160 Hz (bass-heavy pop) and 520 Hz (guitar rock).
 */
function brightness(a: Analysis): number {
  const f = a.authenticity.ltasFreqs;
  const d = a.authenticity.ltasDb;
  let num = 0;
  let den = 0;
  for (let i = 0; i < f.length; i++) {
    if (f[i] < 40 || f[i] > 16000) continue;
    const p = Math.pow(10, d[i] / 10) * f[i];
    num += p * Math.log2(f[i]);
    den += p;
  }
  if (!den) return 0.5;
  return clamp01((num / den - Math.log2(120)) / (Math.log2(700) - Math.log2(120)));
}

function camelotOf(key: KeyInfo) {
  const c = camelot(key);
  return { n: parseInt(c, 10), minor: c.endsWith('A') };
}

function buildStars(ids: string[], tracks: ReturnType<typeof usePlayer.getState>['tracks']): Star[] {
  const out: Star[] = [];
  for (const id of ids) {
    const a = getAnalysis(id);
    const t = tracks[id];
    if (!a || !t) continue;
    const loud = clamp01((a.mastering.lufsI + 22) / 16);
    const tempo = clamp01((a.bpm - 70) / 100);
    const dyn = 1 - clamp01((a.mastering.dr - 4) / 12);
    const energy = 0.55 * loud + 0.3 * tempo + 0.15 * dyn;
    const major = a.key.mode === 'major' ? 1 : -1;
    // Brightness carries most of the mood; major/minor nudges it so the two modes never split into bands.
    const mood = 0.5 + major * (0.03 + 0.04 * a.key.confidence) + (brightness(a) - 0.5) * 0.9;
    const cam = camelotOf(a.key);
    const rgb = keyAccent(a.key);
    const j1 = hash(id) - 0.5;
    const j2 = hash(`${id}:y`) - 0.5;
    const ang = ((cam.n - 1) / 12) * Math.PI * 2 - Math.PI / 2 + j1 * 0.32;
    const r = (cam.minor ? 0.2 : 0.33) + tempo * 0.1 + j2 * 0.02;
    out.push({
      id,
      title: t.meta?.title ?? t.name.replace(/\.[^.]+$/, ''),
      artist: t.meta?.artist ?? '',
      key: a.key,
      bpm: a.bpm,
      energy,
      mood,
      cam,
      a: [energy, mood],
      b: [Math.cos(ang) * r, Math.sin(ang) * r],
      rgb,
      color: rgbCss(rgb),
      size: 2.2 + loud * 2.6,
    });
  }
  // Spread each axis over the collection (5th..95th percentile), so a library
  // of similar songs still fills the map instead of huddling in one corner.
  const spread = (vals: number[]) => {
    const sorted = [...vals].sort((x, y) => x - y);
    const lo = sorted[Math.floor(sorted.length * 0.05)] ?? 0;
    const hi = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 1;
    const span = Math.max(0.05, hi - lo);
    return (v: number) => Math.max(-0.55, Math.min(0.55, (v - lo) / span - 0.5));
  };
  const ex = spread(out.map((s) => s.a[0]));
  const my = spread(out.map((s) => s.a[1]));
  for (const s of out) {
    s.a = [ex(s.a[0]) + (hash(`${s.id}:jx`) - 0.5) * 0.04, -my(s.a[1]) + (hash(`${s.id}:jy`) - 0.5) * 0.04];
  }
  return out;
}

/** Camelot neighbours mix without a key clash: same key, ±1 on the wheel, or the relative major/minor. */
function camelotStep(a: Star['cam'], b: Star['cam']): number | null {
  if (a.n === b.n && a.minor === b.minor) return 0;
  const d = Math.min((a.n - b.n + 12) % 12, (b.n - a.n + 12) % 12);
  if (a.minor === b.minor && d === 1) return 1;
  if (a.n === b.n) return 1;
  return null;
}

/** Greedy harmonic route: each next song is key-compatible, close in tempo and energy. */
function harmonicPath(start: Star, stars: Star[], length = 12): Star[] {
  const path = [start];
  const used = new Set([start.id]);
  let cur = start;
  while (path.length < length) {
    let best: Star | null = null;
    let bestScore = Infinity;
    for (const s of stars) {
      if (used.has(s.id)) continue;
      const step = camelotStep(cur.cam, s.cam);
      if (step === null) continue;
      const ratio = s.bpm / cur.bpm;
      const tempo = Math.min(Math.abs(Math.log2(ratio)), Math.abs(Math.log2(ratio * 2)), Math.abs(Math.log2(ratio / 2)));
      if (tempo > 0.09) continue;
      const score = step * 0.6 + tempo * 12 + Math.abs(s.energy - cur.energy) * 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (!best) break;
    path.push(best);
    used.add(best.id);
    cur = best;
  }
  return path;
}

export function SonicMap() {
  const order = usePlayer((s) => s.order);
  const tracks = usePlayer((s) => s.tracks);
  const nowId = usePlayer((s) => s.now?.trackId);
  const version = useCollection((s) => s.version);
  // Songs analysed by playing them also join the map.
  const analysed = usePlayer((s) => Object.values(s.analysis).filter((a) => a.state === 'done').length);
  const job = useCollection();
  const [layout, setLayout] = useState<Layout>('mood');
  const [selected, setSelected] = useState<string | null>(null);
  const [path, setPath] = useState<string[]>([]);
  const [hover, setHover] = useState<{ x: number; y: number; star: Star } | null>(null);

  useEffect(() => {
    void loadCollectionCache();
  }, [order]);

  const stars = useMemo(() => buildStars(order, tracks), [order, tracks, version, analysed]);
  const byId = useMemo(() => new Map(stars.map((s) => [s.id, s])), [stars]);
  const missing = useMemo(() => unanalysedCount(), [order, version, analysed]);

  const view = useRef({ zoom: 1, x: 0, y: 0, mix: 0 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const geom = useRef({ w: 1, h: 1 });
  const state = useRef({ stars, layout, selected, path, nowId, byId });
  state.current = { stars, layout, selected, path, nowId, byId };

  /** Pixels per unit on each axis: the mood layout fills the panel, the wheel stays round. */
  const scales = (w: number, h: number) => {
    const v = view.current;
    const round = Math.min(w, h) * 0.9;
    return [(w * 0.82 * (1 - v.mix) + round * v.mix) * v.zoom, (h * 0.8 * (1 - v.mix) + round * v.mix) * v.zoom] as const;
  };
  const project = (s: Star, w: number, h: number) => {
    const v = view.current;
    const k = v.mix;
    const px = s.a[0] * (1 - k) + s.b[0] * k;
    const py = s.a[1] * (1 - k) + s.b[1] * k;
    const [sx, sy] = scales(w, h);
    return [w / 2 + (px + v.x) * sx, h / 2 + (py + v.y) * sy] as const;
  };

  const canvas = useHubCanvas((ctx, w, h, snap) => {
    geom.current = { w, h };
    const st = state.current;
    const v = view.current;
    v.mix += ((st.layout === 'harmony' ? 1 : 0) - v.mix) * (1 - Math.exp(-snap.dt * 6));
    ctx.clearRect(0, 0, w, h);
    const [sx, sy] = scales(w, h);
    const scale = Math.min(sx, sy);
    const cx = w / 2 + v.x * sx;
    const cy = h / 2 + v.y * sy;

    // Guides fade between the two layouts.
    ctx.lineWidth = 1;
    ctx.font = `500 11px ${MONO}`;
    ctx.globalAlpha = 1 - v.mix;
    ctx.strokeStyle = C.grid;
    ctx.beginPath();
    ctx.moveTo(cx - sx * 0.58, cy);
    ctx.lineTo(cx + sx * 0.58, cy);
    ctx.moveTo(cx, cy - sy * 0.58);
    ctx.lineTo(cx, cy + sy * 0.58);
    ctx.stroke();
    ctx.fillStyle = C.ink3;
    ctx.textAlign = 'right';
    ctx.fillText('energik →', cx + sx * 0.58, cy - 6);
    ctx.textAlign = 'left';
    ctx.fillText('← tenang', cx - sx * 0.58, cy - 6);
    ctx.fillText('↑ cerah', cx + 6, Math.max(12, cy - sy * 0.58 + 10));
    ctx.fillText('↓ gelap', cx + 6, Math.min(h - 4, cy + sy * 0.58 - 2));

    ctx.globalAlpha = v.mix;
    for (const r of [0.2, 0.33]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let n = 1; n <= 12; n++) {
      const ang = ((n - 1) / 12) * Math.PI * 2 - Math.PI / 2;
      const major = ((n - 8 + 12) % 12) * 7 % 12;
      const flats = usesFlats({ tonic: major, mode: 'major', confidence: 1 });
      ctx.fillStyle = C.ink3;
      ctx.fillText(`${n}B ${noteName(major, flats)}`, cx + Math.cos(ang) * scale * 0.48, cy + Math.sin(ang) * scale * 0.48 + 4);
      ctx.fillStyle = C.ink4;
      ctx.fillText(`${n}A`, cx + Math.cos(ang) * scale * 0.13, cy + Math.sin(ang) * scale * 0.13 + 4);
    }
    ctx.globalAlpha = 1;

    // Harmonic route.
    if (st.path.length > 1) {
      ctx.strokeStyle = signalA(0.55);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      st.path.forEach((id, i) => {
        const s = st.byId.get(id);
        if (!s) return;
        const [x, y] = project(s, w, h);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    ctx.globalCompositeOperation = 'lighter';
    for (const s of st.stars) {
      const [x, y] = project(s, w, h);
      if (x < -10 || y < -10 || x > w + 10 || y > h + 10) continue;
      const r = s.size * Math.sqrt(v.zoom);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
      g.addColorStop(0, rgbCss(s.rgb, 0.55));
      g.addColorStop(1, rgbCss(s.rgb, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r * 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    for (const id of [st.nowId, st.selected]) {
      const s = id ? st.byId.get(id) : undefined;
      if (!s) continue;
      const [x, y] = project(s, w, h);
      ctx.strokeStyle = id === st.nowId ? C.signal : signalA(0.6);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 9 + (id === st.nowId ? snap.music.beatPulse * 4 : 0), 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = C.ink;
      ctx.textAlign = 'left';
      ctx.font = `500 12px ${MONO}`;
      ctx.fillText(s.title.length > 28 ? `${s.title.slice(0, 27)}…` : s.title, x + 13, y + 4);
    }
  });

  const starAt = (mx: number, my: number): Star | null => {
    const { w, h } = geom.current;
    let best: Star | null = null;
    let bestD = 12;
    for (const s of state.current.stars) {
      const [x, y] = project(s, w, h);
      const d = Math.hypot(x - mx, y - my);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  };
  const local = (e: { currentTarget: HTMLCanvasElement; clientX: number; clientY: number }) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const onDown = (e: PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, vx: view.current.x, vy: view.current.y, moved: false };
  };
  const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const [mx, my] = local(e);
    const d = drag.current;
    if (d) {
      const [sx, sy] = scales(geom.current.w, geom.current.h);
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.moved = true;
      if (d.moved) {
        view.current.x = d.vx + (e.clientX - d.x) / sx;
        view.current.y = d.vy + (e.clientY - d.y) / sy;
        setHover(null);
        return;
      }
    }
    const s = starAt(mx, my);
    setHover(s ? { x: mx, y: my, star: s } : null);
  };
  const onUp = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) return;
    const [mx, my] = local(e);
    const s = starAt(mx, my);
    setSelected(s?.id ?? null);
  };
  const onWheel = (e: WheelEvent<HTMLCanvasElement>) => {
    const v = view.current;
    v.zoom = Math.max(0.6, Math.min(8, v.zoom * Math.pow(1.0015, -e.deltaY)));
  };

  const sel = selected ? byId.get(selected) : undefined;
  const start = (s: Star) => setPath(harmonicPath(s, stars).map((x) => x.id));
  // The path is ordered key by key, so it plays in order even with Acak on.
  const playPath = () => path.length && void playQueue(path, 0, 0, { inOrder: true });

  return (
    <section className="sonic-map panel" aria-label="Peta koleksi">
      <header className="sm-head">
        <div>
          <h2>Peta koleksi</h2>
          <p>
            {stars.length.toLocaleString('id-ID')} lagu dipetakan
            {missing > 0 && !job.running && ` · ${missing.toLocaleString('id-ID')} belum dianalisis`}
          </p>
        </div>
        <div className="sm-tools">
          <div className="segmented small" role="radiogroup" aria-label="Tata letak">
            <button role="radio" aria-checked={layout === 'mood'} className={cls(layout === 'mood' && 'on')} onClick={() => setLayout('mood')} title="Kiri ke kanan: tenang ke energik. Bawah ke atas: gelap ke cerah.">
              Energi × suasana
            </button>
            <button role="radio" aria-checked={layout === 'harmony'} className={cls(layout === 'harmony' && 'on')} onClick={() => setLayout('harmony')} title="Roda Camelot: lagu bertetangga bisa di-mix tanpa bentrok kunci.">
              Harmoni
            </button>
          </div>
          <button className="icon-btn" onClick={() => setUi({ sonicMap: false })} aria-label="Tutup peta koleksi" title="Tutup (G)">
            <X size={16} />
          </button>
        </div>
      </header>
      {job.running ? (
        <div className="sm-progress" role="status">
          <span>
            Menganalisis koleksi {job.done}/{job.total}
            {job.current && ` · ${job.current}`}
          </span>
          <div className="bar">
            <i style={{ width: `${(job.done / Math.max(1, job.total)) * 100}%` }} />
          </div>
          <button className="link-btn" onClick={cancelCollection}>
            Hentikan
          </button>
        </div>
      ) : (
        missing > 0 && (
          <div className="sm-progress">
            <span>Setiap lagu perlu dianalisis sekali (sekitar satu detik per menit audio); hasilnya disimpan.</span>
            <button className="btn small" onClick={() => void analyseCollection()}>
              Analisis {missing.toLocaleString('id-ID')} lagu
            </button>
          </div>
        )
      )}
      <div className="sm-body">
        <div className="sm-canvas">
          <canvas
            ref={canvas}
            role="img"
            aria-label="Peta koleksi: setiap titik adalah satu lagu, warnanya mengikuti kunci. Seret untuk bergeser, scroll untuk zoom, klik untuk memilih."
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={() => setHover(null)}
            onWheel={onWheel}
          />
          {hover && (
            <div className="sm-tip" style={{ left: hover.x, top: hover.y }}>
              <strong>{hover.star.title}</strong>
              <span>
                {[hover.star.artist, keyName(hover.star.key), `${camelot(hover.star.key)}`, `${Math.round(hover.star.bpm)} BPM`].filter(Boolean).join(' · ')}
              </span>
            </div>
          )}
          {stars.length === 0 && !job.running && <p className="empty-note sm-empty">Belum ada lagu yang dianalisis. Putar lagu atau analisis koleksi untuk mulai memetakan.</p>}
        </div>
        {(sel || path.length > 0) && (
          <aside className="sm-side">
            {sel && (
              <div className="sm-card">
                <i style={{ background: sel.color }} aria-hidden="true" />
                <div>
                  <strong>{sel.title}</strong>
                  <span>{[sel.artist, keyName(sel.key), camelot(sel.key), `${Math.round(sel.bpm)} BPM`].filter(Boolean).join(' · ')}</span>
                </div>
                <div className="sm-card-actions">
                  <button className="btn small" onClick={() => void playQueue([sel.id], 0)}>
                    <Play size={13} aria-hidden="true" /> Putar
                  </button>
                  <button className="btn small" onClick={() => start(sel)} title="Susun antrean yang berpindah kunci dengan mulus, tempo dan energi berdekatan">
                    <Route size={13} aria-hidden="true" /> Jalur harmonis
                  </button>
                </div>
              </div>
            )}
            {path.length > 0 && (
              <div className="sm-path">
                <div className="sm-path-head">
                  <span>Jalur harmonis · {path.length} lagu</span>
                  <button className="btn small primary" onClick={playPath}>
                    <Play size={13} aria-hidden="true" /> Putar jalur
                  </button>
                </div>
                <ol>
                  {path.map((id) => {
                    const s = byId.get(id);
                    if (!s) return null;
                    return (
                      <li key={id}>
                        <button onClick={() => setSelected(id)}>
                          <span className="cam">{camelot(s.key)}</span>
                          <span className="ttl">{s.title}</span>
                          <span className="bpm">{Math.round(s.bpm)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}
          </aside>
        )}
      </div>
    </section>
  );
}
