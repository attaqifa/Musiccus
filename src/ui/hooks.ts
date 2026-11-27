import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
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

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard focus for a dialog, drawer or popover. When it opens, focus moves
 * in (to `[data-autofocus]`, or the box itself, which needs tabIndex -1); when
 * it closes, focus goes back to whatever opened it, unless the listener has
 * already moved on. `trap` keeps Tab inside, for a modal.
 */
export function useDialogFocus<T extends HTMLElement>({ open = true, trap = false } = {}) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const box = ref.current;
    if (!open || !box) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (box.querySelector<HTMLElement>('[data-autofocus]') ?? box).focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (!trap || e.key !== 'Tab') return;
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      if (!items.length) return e.preventDefault();
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === box)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    box.addEventListener('keydown', onKey);
    return () => {
      box.removeEventListener('keydown', onKey);
      const now = document.activeElement;
      if (opener?.isConnected && (!now || now === document.body || box.contains(now))) opener.focus({ preventScroll: true });
    };
  }, [open, trap]);
  return ref;
}

/**
 * One pointer at a time for a drag. A second finger cannot take it over, and
 * the drag ends cleanly when the browser cancels the gesture, capture is lost,
 * or the mouse button was let go outside the window (no pointerup ever came).
 */
export function useDragPointer() {
  const id = useRef<number | null>(null);
  return {
    get active() {
      return id.current !== null;
    },
    /** Takes the pointer for a drag; false when another drag holds it or it is not the main button. */
    start(e: ReactPointerEvent<Element>): boolean {
      if (id.current !== null || e.button !== 0) return false;
      id.current = e.pointerId;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // The pointer is already gone; without capture, up or a buttonless move still ends the drag.
      }
      return true;
    },
    /** Whether this move belongs to the drag. */
    owns(e: ReactPointerEvent<Element>): boolean {
      if (e.pointerId !== id.current) return false;
      if (e.pointerType === 'mouse' && e.buttons === 0) {
        id.current = null;
        return false;
      }
      return true;
    },
    /** Ends the drag on up, cancel, or lost capture; true when it was this drag's pointer. */
    end(e: ReactPointerEvent<Element>): boolean {
      if (e.pointerId !== id.current) return false;
      id.current = null;
      return true;
    },
  };
}
