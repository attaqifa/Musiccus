import { useEffect, useRef, useState } from 'react';

/**
 * A delete that cannot be undone asks once more, in place: the first click
 * says what will be lost and offers the real delete next to Batal. Esc or
 * Batal steps back and focus returns to the first button. No dialog: nothing
 * else on screen has to stop for it.
 */
export function ConfirmButton({ className, label, confirm, note, onConfirm, disabled, tip }: {
  className: string;
  label: string;
  /** The delete itself, naming what goes: "Ya, hapus 126 MB". */
  confirm: string;
  /** What deleting costs later. */
  note: string;
  onConfirm: () => void;
  disabled?: boolean;
  tip?: string;
}) {
  const [armed, setArmed] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const yes = useRef<HTMLButtonElement>(null);
  const backFocus = useRef(false);

  useEffect(() => {
    if (armed) yes.current?.focus();
    else if (backFocus.current) {
      backFocus.current = false;
      trigger.current?.focus();
    }
  }, [armed]);

  const cancel = () => {
    backFocus.current = true;
    setArmed(false);
  };

  if (!armed) {
    return (
      <button ref={trigger} className={className} disabled={disabled} onClick={() => setArmed(true)} data-tip={tip}>
        {label}
      </button>
    );
  }
  return (
    <span
      className="confirm"
      role="group"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        // Esc closes this question, not the drawer around it.
        e.stopPropagation();
        cancel();
      }}
    >
      <span className="confirm-note">{note}</span>
      <button
        ref={yes}
        className={className}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirm}
      </button>
      <button className={className} onClick={cancel}>
        Batal
      </button>
    </span>
  );
}
