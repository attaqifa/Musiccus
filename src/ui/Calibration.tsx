import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { setAvOffset, togglePlay } from '../store/controller';
import { getState, setUi, usePlayer } from '../store/player';

const INTERVAL = 0.75;

/**
 * Plays a click every 0.75 s and flashes a lamp when the click should be
 * heard. Moving the slider until both coincide measures what the browser
 * cannot see, such as Bluetooth codec delay.
 */
export function CalibrationDialog() {
  const open = usePlayer((s) => s.ui.calibration);
  if (!open) return null;
  return <CalibrationBody />;
}

function CalibrationBody() {
  const [offset, setOffset] = useState(() => getState().settings.avOffsetMs);
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const lamp = useRef<HTMLDivElement>(null);
  const [baseMs, setBaseMs] = useState<number | null>(null);

  useEffect(() => {
    if (getState().status === 'playing') void togglePlay();
    const ctx = new AudioContext({ latencyHint: 'playback', sampleRate: engine.sampleRate || undefined });
    const clicks: number[] = [];
    let next = ctx.currentTime + 0.4;
    let beat = 0;
    const schedule = () => {
      while (next < ctx.currentTime + 0.6) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = beat % 4 === 0 ? 1760 : 1320;
        g.gain.setValueAtTime(0, next);
        g.gain.linearRampToValueAtTime(0.5, next + 0.001);
        g.gain.exponentialRampToValueAtTime(0.001, next + 0.05);
        o.connect(g).connect(ctx.destination);
        o.start(next);
        o.stop(next + 0.06);
        clicks.push(next);
        if (clicks.length > 16) clicks.shift();
        next += INTERVAL;
        beat++;
      }
    };
    const timer = window.setInterval(schedule, 100);
    schedule();

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      let heard = ctx.currentTime - (ctx.outputLatency || 0) - (ctx.baseLatency || 0);
      const ts = ctx.getOutputTimestamp();
      if (ts.contextTime && ts.performanceTime) {
        const est = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
        if (est <= ctx.currentTime && est > ctx.currentTime - 1) heard = est;
      }
      const t = heard - offsetRef.current / 1000;
      let last = -Infinity;
      for (const c of clicks) if (c <= t) last = c;
      const glow = Math.exp(-(t - last) * 14);
      if (lamp.current) lamp.current.style.setProperty('--glow', glow.toFixed(3));
    };
    raf = requestAnimationFrame(loop);
    const lat = window.setTimeout(() => setBaseMs(((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000), 600);

    return () => {
      window.clearInterval(timer);
      window.clearTimeout(lat);
      cancelAnimationFrame(raf);
      void ctx.close();
    };
  }, []);

  const close = () => setUi({ calibration: false });
  const save = () => {
    setAvOffset(offset);
    close();
  };

  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal panel calibration" role="dialog" aria-modal="true" aria-label="Kalibrasi sinkronisasi audio-visual">
        <button className="icon-btn modal-close" onClick={close} aria-label="Tutup">
          <X size={17} />
        </button>
        <h2>Kalibrasi sinkron</h2>
        <p className="cal-lede">
          Dengarkan klik, lalu geser slider sampai lampu menyala tepat bersamaan dengan bunyinya. Pakai perangkat audio yang biasa
          Anda gunakan untuk mendengar.
        </p>
        <div className="cal-lamp" ref={lamp} aria-hidden="true">
          <span />
        </div>
        <label className="cal-slider">
          <span>
            Koreksi <strong>{offset > 0 ? `+${offset}` : offset} ms</strong>
          </span>
          <input type="range" min={-150} max={450} step={5} value={offset} onChange={(e) => setOffset(Number(e.target.value))} />
          <span className="cal-scale">
            <span>← geser ke sini jika lampu terlambat</span>
            <span>jika lampu mendahului bunyi →</span>
          </span>
        </label>
        <p className="mono-note">
          Latensi yang dilaporkan browser: {baseMs === null ? 'mengukur…' : `${Math.round(baseMs)} ms`}. Koreksi ditambahkan di atasnya.
        </p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setOffset(0)}>
            Reset ke 0
          </button>
          <button className="btn primary" onClick={save}>
            Simpan koreksi
          </button>
        </div>
      </div>
    </div>
  );
}
