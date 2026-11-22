import { ListEnd, ListStart, Play } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { enqueue } from '../store/controller';

export interface MenuTarget {
  x: number;
  y: number;
  /** The songs the menu acts on: one track, or an album's tracks. */
  ids: string[];
  /** Plays the target now, inside the list it was picked from. */
  play: () => void;
  /** Where focus goes back when the menu closes. */
  from: HTMLElement | null;
  album?: boolean;
}

/**
 * Right-click (long press on touch, or the Menu key and Shift+F10) on a
 * library row: play now, play next, or add to the end of the queue.
 */
export function TrackMenu({ target, onClose }: { target: MenuTarget; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: target.x, top: target.y });

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(target.x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(target.y, window.innerHeight - r.height - 8)),
    });
    el.querySelector<HTMLButtonElement>('button')?.focus();
  }, [target]);

  useEffect(() => {
    const close = () => {
      onClose();
      target.from?.focus();
    };
    const away = (e: PointerEvent) => !menu.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const n = items.length;
        items[(at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n]?.focus();
      }
    };
    window.addEventListener('pointerdown', away, true);
    // Capture, so the menu's keys never reach the global shortcuts.
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [target, onClose]);

  const act = (fn: () => void) => () => {
    onClose();
    target.from?.focus();
    fn();
  };
  const what = target.album ? 'album' : 'lagu';
  const item = (icon: ReactNode, label: string, fn: () => void) => (
    <button role="menuitem" onClick={act(fn)}>
      {icon}
      {label}
    </button>
  );
  // In the body: the panels blur their backdrop, which would trap a fixed menu inside them.
  return createPortal(
    <div ref={menu} className="ctx-menu panel" role="menu" aria-label={`Pilihan ${what}`} style={pos}>
      {item(<Play size={14} aria-hidden="true" />, target.album ? 'Putar album' : 'Putar sekarang', target.play)}
      {item(<ListStart size={14} aria-hidden="true" />, 'Putar berikutnya', () => enqueue(target.ids, 'next'))}
      {item(<ListEnd size={14} aria-hidden="true" />, 'Tambah ke antrean', () => enqueue(target.ids, 'end'))}
    </div>,
    document.body,
  );
}
