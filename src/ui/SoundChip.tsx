import { useRef } from 'react';
import { setUi } from '../store/player';
import { setCompare, soundLabel, useStudio } from '../studio/store';
import { studioProcessing } from '../studio/types';
import { cls } from './hooks';

/** Held longer than this, the button acts as "hold to hear the original". */
const HOLD_MS = 350;

/**
 * "Dengar asli": a click switches to the original and back; pressing and
 * holding plays the original only while held. The original plays at the
 * same loudness as the processed sound.
 */
export function CompareButton({ className, short }: { className?: string; short?: boolean }) {
  const compare = useStudio((s) => s.compare);
  const processing = useStudio((s) => studioProcessing(s.state));
  const since = useRef(0);
  const release = () => {
    if (since.current && performance.now() - since.current > HOLD_MS) setCompare(false);
    since.current = 0;
  };
  const label = compare ? 'Kembali ke racikan' : short ? 'Asli' : 'Dengar asli';
  return (
    <button
      className={cls('compare-btn', compare && 'on', className)}
      disabled={!processing}
      aria-pressed={compare}
      data-tip="Bandingkan dengan suara asli: klik untuk berganti, atau tahan lalu lepas. Volumenya disamakan supaya perbandingannya adil." data-kbd="A"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        if (compare) {
          setCompare(false);
          since.current = 0;
        } else {
          setCompare(true);
          since.current = performance.now();
        }
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      // Keyboard activation has no pointer events (detail is 0).
      onClick={(e) => e.detail === 0 && setCompare(!compare)}
    >
      {label}
    </button>
  );
}

/** Shown in the player bar while the sound is changed, so it never surprises anyone. */
export function SoundChip() {
  const processing = useStudio((s) => studioProcessing(s.state));
  const compare = useStudio((s) => s.compare);
  const label = useStudio((s) => soundLabel(s));
  if (!processing) return null;
  return (
    <div className={cls('sound-chip', compare && 'asli')}>
      <button
        className="sc-name"
        onClick={() => setUi({ mode: 'bentuk', inspector: true, hidden: false })}
        data-tip="Suara sedang diracik. Klik untuk membuka Racik."
      >
        <i className="sc-dot" aria-hidden="true" />
        <span>{compare ? 'Suara asli' : label}</span>
      </button>
      <CompareButton short />
    </div>
  );
}
