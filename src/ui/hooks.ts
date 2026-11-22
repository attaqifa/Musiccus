import { useEffect, useRef, useState } from 'react';
import { hub, type Snapshot } from '../audio/hub';

/** Runs `fn` on every animation frame with the synced analysis snapshot. */
export function useHub(fn: (s: Snapshot) => void) {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => hub.subscribe((s) => ref.current(s)), []);
}

/**
 * Re-renders only when the selected value changes (by identity), so React
 * components can follow discrete musical events like chord changes without
 * re-rendering every frame.
 */
export function useHubValue<T>(select: (s: Snapshot) => T): T {
  const [value, setValue] = useState(() => select(hub.snapshot));
  const last = useRef(value);
  useHub((s) => {
    const v = select(s);
    if (!Object.is(v, last.current)) {
      last.current = v;
      setValue(v);
    }
  });
  return value;
}

type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number, s: Snapshot) => void;

/** A HiDPI canvas redrawn each frame from the hub. Returns the ref to attach. */
export function useHubCanvas(draw: Draw) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0, dpr: 1 });

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const r = c.getBoundingClientRect();
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
      size.current = { w: r.width, h: r.height, dpr };
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  useHub((s) => {
    const c = canvasRef.current;
    const { w, h, dpr } = size.current;
    if (!c || w === 0) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, w, h, s);
  });

  return canvasRef;
}

export const cls = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

/** Reads a CSS custom property from :root so canvases follow the theme tokens. */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
