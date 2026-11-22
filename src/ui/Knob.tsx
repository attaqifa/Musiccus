import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';

interface KnobProps {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  label: string;
  format: (v: number) => string;
  defaultValue?: number;
  step?: number;
  size?: number;
  /** Draw the value arc from the middle, for controls centred on zero (gain, balance). */
  bipolar?: boolean;
  disabled?: boolean;
}

const SWEEP = 270;
const START = -135;

function arc(cx: number, cy: number, r: number, a0: number, a1: number) {
  const p = (a: number) => {
    const rad = ((a - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

/**
 * Hardware-style rotary control: drag vertically (Shift for fine), scroll,
 * arrow keys, double-click to reset.
 */
export function Knob({ value, min, max, onChange, label, format, defaultValue, step = 0.5, size = 52, bipolar, disabled }: KnobProps) {
  const drag = useRef<{ y: number; v: number } | null>(null);
  const el = useRef<HTMLDivElement>(null);
  const norm = Math.min(1, Math.max(0, (value - min) / (max - min)));
  const angle = START + norm * SWEEP;
  const set = (v: number) => {
    // Rounding to the step can leave float dust (0.30000000000000004).
    const snapped = Number((Math.round(v / step) * step).toFixed(6));
    const next = Math.min(max, Math.max(min, snapped));
    if (next !== value) onChange(next);
  };
  const latest = useRef({ set, value, step, disabled });
  latest.current = { set, value, step, disabled };

  // React's wheel listener is passive, so the panel would scroll while the knob turns.
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const onWheel = (e: globalThis.WheelEvent) => {
      const k = latest.current;
      if (k.disabled) return;
      e.preventDefault();
      k.set(k.value - Math.sign(e.deltaY) * k.step * (e.shiftKey ? 1 : 2));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, v: value };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const range = max - min;
    const sens = e.shiftKey ? 900 : 220;
    set(drag.current.v + ((drag.current.y - e.clientY) / sens) * range);
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const big = e.shiftKey ? 6 : 1;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') set(value + step * big);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') set(value - step * big);
    else if (e.key === 'Home') set(min);
    else if (e.key === 'End') set(max);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const c = size / 2;
  const mid = START + SWEEP / 2;
  const [a0, a1] = bipolar ? (angle < mid ? [angle, mid] : [mid, angle]) : [START, angle];
  return (
    <div
      ref={el}
      className={disabled ? 'knob off' : 'knob'}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value * 10) / 10}
      aria-valuetext={format(value)}
      title={`${label}: ${format(value)}. Seret naik/turun, Shift untuk halus, klik ganda untuk reset.`}
      style={{ width: size, height: size }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={() => !disabled && defaultValue !== undefined && set(defaultValue)}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <path d={arc(c, c, c - 2, START, START + SWEEP)} className="knob-track" />
        {a1 - a0 > 0.5 && <path d={arc(c, c, c - 2, a0, a1)} className="knob-value" />}
      </svg>
      <div className="knob-body" style={{ inset: 7 }}>
        <div className="knob-cap" style={{ transform: `rotate(${angle}deg)` }}>
          <span className="knob-pointer" />
        </div>
      </div>
    </div>
  );
}
