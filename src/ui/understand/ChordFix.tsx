import { X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { fixChords, fixKey, getFix, getRawAnalysis, revertChords } from '../../analysis/manager';
import type { ChordPick, Span } from '../../analysis/fixes';
import { chordName, keyName, noteName, rootName, usesFlats } from '../../analysis/theory';
import type { Analysis, ChordQuality, ChordSeg, KeyInfo } from '../../analysis/types';
import { formatTime } from '../../lib/format';
import { seek } from '../../store/controller';
import { cls } from '../hooks';

/**
 * Small pickers for telling Musiccus a chord or the key is wrong. The fix is
 * kept for this file and becomes part of what the analysis is measured
 * against.
 */

function Popover({ anchor, label, onClose, children }: { anchor: HTMLElement; label: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Below the anchor, or above it when the window runs out; repositioned as the panel scrolls.
  useLayoutEffect(() => {
    const place = () => {
      const el = box.current;
      if (!el) return;
      const a = anchor.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const below = a.bottom + 6;
      const top = below + r.height + 8 > window.innerHeight ? Math.max(8, a.top - r.height - 6) : below;
      setPos({ left: Math.max(8, Math.min(a.left, window.innerWidth - r.width - 8)), top });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchor]);

  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    const close = () => {
      onClose();
      anchor.focus();
    };
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key.startsWith('Arrow') && box.current?.contains(document.activeElement)) {
        // Arrows move between notes here, not through the song or the volume.
        e.stopPropagation();
        const grid = (document.activeElement as HTMLElement).closest('.fix-notes');
        if (!grid) return;
        e.preventDefault();
        const items = Array.from(grid.querySelectorAll<HTMLButtonElement>('button'));
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 6, ArrowUp: -6 }[e.key] ?? 0;
        items[(at + step + items.length) % items.length]?.focus();
      }
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [anchor, onClose]);

  // In the body: the panels blur their backdrop, which traps fixed elements inside them.
  return createPortal(
    <div
      ref={box}
      className="fix-pop panel"
      role="dialog"
      aria-label={label}
      // Off screen until measured, but focusable already.
      style={pos ?? { left: -9999, top: 0 }}
    >
      <div className="fix-head">
        <h3>{label}</h3>
        <button className="icon-btn" onClick={() => (onClose(), anchor.focus())} aria-label="Tutup">
          <X size={15} />
        </button>
      </div>
      {children}
    </div>,
    document.body,
  );
}

function NoteGrid({ value, name, onPick, label }: { value: number; name: (pc: number) => string; onPick: (pc: number) => void; label: string }) {
  return (
    <div className="fix-notes" role="radiogroup" aria-label={label}>
      {Array.from({ length: 12 }, (_, pc) => (
        <button
          key={pc}
          role="radio"
          aria-checked={value === pc}
          className={cls(value === pc && 'on')}
          onClick={() => onPick(pc)}
          {...(value === pc || (value < 0 && pc === 0) ? { 'data-autofocus': true } : {})}
        >
          {name(pc)}
        </button>
      ))}
    </div>
  );
}

function ModeSwitch<T extends string>({ value, options, onPick, label }: { value: T | null; options: [T, string][]; onPick: (v: T) => void; label: string }) {
  return (
    <span className="segmented small" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} role="radio" aria-checked={value === v} className={cls(value === v && 'on')} onClick={() => onPick(v)}>
          {text}
        </button>
      ))}
    </span>
  );
}

const sameChord = (a: Pick<ChordSeg, 'root' | 'quality'>, b: Pick<ChordSeg, 'root' | 'quality'>) => a.root === b.root && a.quality === b.quality;

export interface ChordTarget {
  span: Span;
  /** What the sheet shows there now, or null for no chord. */
  chord: ChordSeg | null;
  anchor: HTMLElement;
}

/**
 * "Akor ini salah?": pick the right chord for one span, optionally for every
 * other place the same wrong chord was heard in this view.
 */
export function ChordPicker({ trackId, analysis, view, target, onClose }: { trackId: string; analysis: Analysis; view: ChordSeg[]; target: ChordTarget; onClose: () => void }) {
  const { span, chord } = target;
  const [root, setRoot] = useState(chord?.root ?? -1);
  const [quality, setQuality] = useState<ChordQuality>(chord?.quality ?? 'maj');
  const [none, setNone] = useState(!chord);
  const [everywhere, setEverywhere] = useState(false);

  // The same chord elsewhere, as long as the listener has not fixed it already.
  const others = chord ? view.filter((c) => !c.fixed && sameChord(c, chord) && (c.end <= span.t || c.t >= span.end)) : [];
  const wasFixed = !!chord?.fixed || (analysis.fixedNone ?? []).some((g) => g.t < span.end && g.end > span.t);
  const pick: ChordPick | null = none ? 'none' : root >= 0 ? { root, quality } : null;
  const changed = pick !== null && (pick === 'none' ? !!chord : !chord || !sameChord(pick, chord));
  const heard = getRawAnalysis(trackId);
  const heardName = (() => {
    if (!heard) return null;
    const mid = (span.t + span.end) / 2;
    const c = heard.chords.find((x) => x.t <= mid && x.end > mid);
    return c ? chordName(c, analysis.key) : 'tanpa akor';
  })();

  const save = () => {
    if (!pick) return;
    fixChords(trackId, everywhere ? [span, ...others.map(({ t, end }) => ({ t, end }))] : [span], pick);
    onClose();
    target.anchor.focus();
  };
  const revert = () => {
    revertChords(trackId, [span]);
    onClose();
    target.anchor.focus();
  };
  const shownName = pick === 'none' ? 'Tanpa akor' : pick ? chordName(pick, analysis.key) : '…';

  return (
    <Popover anchor={target.anchor} label={`Akor di ${formatTime(span.t)}–${formatTime(span.end)}`} onClose={onClose}>
      <p className="fix-note">
        Tertulis <b>{chord ? chordName(chord, analysis.key) : 'tanpa akor'}</b>
        {wasFixed && heardName ? <>, hasil koreksi Anda. Analisis mendengar {heardName}.</> : '.'} Pilih akor yang benar.
      </p>
      <NoteGrid
        value={none ? -1 : root}
        name={(pc) => rootName(pc, analysis.key)}
        label="Nada dasar akor"
        onPick={(pc) => {
          setRoot(pc);
          setNone(false);
        }}
      />
      <div className="fix-row">
        <ModeSwitch
          label="Jenis akor"
          value={none ? null : quality}
          options={[
            ['maj', 'Mayor'],
            ['min', 'Minor'],
          ]}
          onPick={(q) => {
            setQuality(q);
            setNone(false);
            if (root < 0) setRoot(chord?.root ?? 0);
          }}
        />
        <button className={cls('fix-none', none && 'on')} aria-pressed={none} onClick={() => setNone(!none)}>
          Tanpa akor
        </button>
      </div>
      {chord && others.length > 0 && (
        <label className="fx-check">
          <input type="checkbox" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} />
          Ganti juga {others.length} {chordName(chord, analysis.key)} lain di lagu ini
        </label>
      )}
      <div className="fix-actions">
        <button className="btn ghost small" onClick={() => seek(span.t)}>
          Putar dari sini
        </button>
        <span className="fix-grow" />
        {wasFixed && (
          <button className="btn ghost small" onClick={revert} title="Kembali ke akor yang didengar analisis.">
            Kembalikan
          </button>
        )}
        <button className="btn primary small" onClick={save} disabled={!changed}>
          Simpan {changed ? shownName : ''}
        </button>
      </div>
    </Popover>
  );
}

/** The key, by hand. Relative keys share their notes, so the hint is about where the song comes home. */
export function KeyPicker({ trackId, analysis, anchor, onClose }: { trackId: string; analysis: Analysis; anchor: HTMLElement; onClose: () => void }) {
  const key = analysis.key;
  const [tonic, setTonic] = useState(key.tonic);
  const [mode, setMode] = useState<KeyInfo['mode']>(key.mode);
  const heard = getRawAnalysis(trackId)?.key;
  const next: KeyInfo = { tonic, mode, confidence: 1 };
  const changed = tonic !== key.tonic || mode !== key.mode;
  const relative: KeyInfo = mode === 'major' ? { tonic: (tonic + 9) % 12, mode: 'minor', confidence: 1 } : { tonic: (tonic + 3) % 12, mode: 'major', confidence: 1 };

  return (
    <Popover anchor={anchor} label="Kunci lagu" onClose={onClose}>
      <p className="fix-note">
        {key.fixed && heard ? (
          <>
            Anda memilih <b>{keyName(key)}</b>. Analisis mendengar {keyName(heard)}.
          </>
        ) : getFix(trackId)?.key ? (
          <>
            Tertulis <b>{keyName(key)}</b>, sudah Anda periksa.
          </>
        ) : (
          <>
            Terbaca <b>{keyName(key)}</b>, keyakinan {Math.round(key.confidence * 100)}%.
          </>
        )}
      </p>
      <NoteGrid value={tonic} name={(pc) => noteName(pc, usesFlats({ tonic: pc, mode, confidence: 1 }))} label="Nada dasar kunci" onPick={setTonic} />
      <div className="fix-row">
        <ModeSwitch
          label="Mayor atau minor"
          value={mode}
          options={[
            ['major', 'Mayor'],
            ['minor', 'Minor'],
          ]}
          onPick={setMode}
        />
      </div>
      <p className="fix-note quiet">
        {keyName(next)} dan {keyName(relative)} memakai nada yang sama. Pilih yang terasa seperti rumah, biasanya akor di akhir lagu atau
        refrein.
      </p>
      <div className="fix-actions">
        <span className="fix-grow" />
        {key.fixed && (
          <button className="btn ghost small" onClick={() => (fixKey(trackId, null), onClose(), anchor.focus())}>
            Kembalikan
          </button>
        )}
        <button className="btn primary small" disabled={!changed} onClick={() => (fixKey(trackId, { tonic, mode }), onClose(), anchor.focus())}>
          Simpan {changed ? keyName(next) : ''}
        </button>
      </div>
    </Popover>
  );
}
