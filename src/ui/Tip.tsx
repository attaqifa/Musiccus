import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cls } from './hooks';

/*
 * One explanation system for the whole app, in place of the browser's title
 * tooltip (which never shows on a touch screen or to the keyboard).
 *
 * Any element with `data-tip` explains itself:
 *   - mouse: on hover, after a short wait (at once while moving between tips);
 *   - keyboard: when it, or a control inside it, gets focus;
 *   - touch: on tap, for things that are not controls (a tapped button does
 *     its job instead; its name is already on it or in aria-label).
 * `data-kbd` adds the shortcut as a key cap.
 *
 * <Term> is the tap-and-keyboard form for a word or number that needs
 * explaining: a quiet button that pins its explanation open.
 */

type Shown = { el: HTMLElement; text: string; kbd: string | null; pinned: boolean };

const DELAY = 450;
/** Moving from one tip to the next within this window shows the next one at once. */
const WARM = 600;
const CONTROL = 'button, a[href], input, select, textarea, label, [role="slider"], [role="button"], [role="radio"], [role="tab"]';

const tipOf = (target: EventTarget | null) =>
  target instanceof Element ? (target.closest('[data-tip]') as HTMLElement | null) : null;

/** The element's own name, so a tip that only repeats it is not read twice. */
const nameOf = (el: HTMLElement) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();

export function TipLayer() {
  const [shown, setShown] = useState<Shown | null>(null);
  const [said, setSaid] = useState('');
  const current = useRef<Shown | null>(null);
  current.current = shown;

  useEffect(() => {
    let timer = 0;
    let lastHide = 0;
    let touch = false;
    // A pressed control has done its job; its label waits until the pointer leaves it.
    let pressed: HTMLElement | null = null;

    const read = (el: HTMLElement, pinned: boolean): Shown | null => {
      const text = el.dataset.tip?.trim();
      return text ? { el, text, kbd: el.dataset.kbd ?? null, pinned } : null;
    };
    const show = (el: HTMLElement, pinned = false) => {
      window.clearTimeout(timer);
      const next = read(el, pinned);
      setShown(next);
      if (pinned && next) setSaid(next.text);
    };
    const hide = () => {
      window.clearTimeout(timer);
      if (current.current) lastHide = performance.now();
      setShown(null);
    };

    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = tipOf(e.target);
      const now = current.current;
      if (!el || now?.pinned || el === now?.el || el === pressed) return;
      window.clearTimeout(timer);
      const warm = now || performance.now() - lastHide < WARM;
      if (warm) show(el);
      else timer = window.setTimeout(() => show(el), DELAY);
    };
    const out = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = tipOf(e.target);
      if (!el || (e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) return;
      if (el === pressed) pressed = null;
      window.clearTimeout(timer);
      const now = current.current;
      if (now && !now.pinned && now.el === el) hide();
    };
    const focusIn = (e: FocusEvent) => {
      const el = tipOf(e.target);
      if (!el || !(e.target instanceof Element) || !e.target.matches(':focus-visible')) return;
      if (current.current?.pinned) return;
      show(el);
    };
    const focusOut = (e: FocusEvent) => {
      const now = current.current;
      if (!now) return;
      if (e.relatedTarget instanceof Node && now.el.contains(e.relatedTarget)) return;
      if (tipOf(e.target) === now.el) hide();
    };
    const down = (e: PointerEvent) => {
      touch = e.pointerType === 'touch';
      const el = tipOf(e.target);
      if (el && !('tipToggle' in el.dataset)) pressed = el;
      window.clearTimeout(timer);
      const now = current.current;
      if (!now) return;
      // Pressing a control hides its label; pressing elsewhere lets a pinned tip go.
      if (now.pinned ? el !== now.el : true) hide();
    };
    const click = (e: MouseEvent) => {
      const el = tipOf(e.target);
      if (!el) return;
      const now = current.current;
      if ('tipToggle' in el.dataset) {
        if (now?.pinned && now.el === el) hide();
        else show(el, true);
        return;
      }
      // On touch, a tap on something that is not a control opens its explanation.
      if (!touch || !(e.target instanceof Element)) return;
      // A control that is switched off cannot act, so a tap explains why instead.
      const found = e.target.closest(CONTROL);
      const control = found?.matches('[aria-disabled="true"]') ? null : found;
      if (control && el.contains(control)) return;
      if (control && control.contains(el)) return;
      if (now?.pinned && now.el === el) hide();
      else show(el, true);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !current.current) return;
      // Esc closes the explanation first, and only that.
      if (current.current.pinned) {
        e.stopPropagation();
        e.preventDefault();
      }
      hide();
    };
    const away = () => current.current && hide();

    document.addEventListener('pointerover', over, true);
    document.addEventListener('pointerout', out, true);
    document.addEventListener('focusin', focusIn, true);
    document.addEventListener('focusout', focusOut, true);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('click', click, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    window.addEventListener('blur', away);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerover', over, true);
      document.removeEventListener('pointerout', out, true);
      document.removeEventListener('focusin', focusIn, true);
      document.removeEventListener('focusout', focusOut, true);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('click', click, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
      window.removeEventListener('blur', away);
    };
  }, []);

  // Follow the element while it is shown: its text can change (Putar becomes
  // Jeda), and it can leave the page (a panel closes under the pointer).
  useEffect(() => {
    if (!shown) return;
    const { el, pinned } = shown;
    const sync = () => {
      const text = el.dataset.tip?.trim();
      if (!text) return setShown(null);
      setShown((s) => (s && s.el === el && (s.text !== text || s.kbd !== (el.dataset.kbd ?? null)) ? { el, text, kbd: el.dataset.kbd ?? null, pinned } : s));
    };
    const watch = new MutationObserver(sync);
    watch.observe(el, { attributes: true, attributeFilter: ['data-tip', 'data-kbd'] });
    let raf = 0;
    const alive = () => {
      if (!el.isConnected) return setShown(null);
      raf = requestAnimationFrame(alive);
    };
    raf = requestAnimationFrame(alive);

    // Screen readers hear the tip as the element's description, unless it only repeats the name.
    const describe = shown.text !== nameOf(el);
    const before = el.getAttribute('aria-describedby');
    if (describe) el.setAttribute('aria-describedby', [before, 'tip-bubble'].filter(Boolean).join(' '));
    if (pinned) el.setAttribute('aria-expanded', 'true');
    return () => {
      watch.disconnect();
      cancelAnimationFrame(raf);
      if (describe) {
        if (before) el.setAttribute('aria-describedby', before);
        else el.removeAttribute('aria-describedby');
      }
      if ('tipToggle' in el.dataset) el.setAttribute('aria-expanded', 'false');
    };
  }, [shown]);

  return createPortal(
    <>
      {shown && <Bubble shown={shown} />}
      {/* What a tapped or clicked Term says, for screen readers. */}
      <div className="sr-only" role="status" aria-live="polite">
        {said}
      </div>
    </>,
    document.body,
  );
}

function Bubble({ shown }: { shown: Shown }) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ x: number; y: number; below: boolean } | null>(null);

  useLayoutEffect(() => {
    const b = box.current;
    if (!b) return;
    const r = shown.el.getBoundingClientRect();
    const w = b.offsetWidth;
    const h = b.offsetHeight;
    const gap = 8;
    const edge = 8;
    // Above the element by default; below when there is no room (the top bar).
    const below = r.top - h - gap < edge;
    const y = below ? Math.min(r.bottom + gap, window.innerHeight - h - edge) : r.top - h - gap;
    const x = Math.min(Math.max(edge, r.left + r.width / 2 - w / 2), window.innerWidth - w - edge);
    setPlace({ x, y, below });
  }, [shown.el, shown.text, shown.kbd]);

  return (
    <div
      ref={box}
      id="tip-bubble"
      role="tooltip"
      className={cls('tip', shown.pinned && 'pinned', place?.below && 'below')}
      style={place ? { left: place.x, top: place.y } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      <span>{shown.text}</span>
      {shown.kbd && <kbd>{shown.kbd}</kbd>}
    </div>
  );
}

/** A word or number that explains itself on tap, click, or keyboard. */
export function Term({ tip, children, className }: { tip: string; children: ReactNode; className?: string }) {
  return (
    <button type="button" className={cls('term', className)} data-tip={tip} data-tip-toggle="" aria-expanded="false">
      {children}
    </button>
  );
}
