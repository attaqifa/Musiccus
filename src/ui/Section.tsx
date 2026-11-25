import { ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { loadJSON, saveJSON } from '../lib/storage';

/** A collapsible panel section; the collapsed state is remembered per id. */
const KEY = 'musiccus:inspector-collapsed';
/** Collapsed state of sections that are not remembered across reloads. */
const sessionState = new Map<string, boolean>();

export function Section({
  id,
  title,
  hint,
  note,
  closed = false,
  remember = true,
  children,
}: {
  id: string;
  title: string;
  /** Tooltip on the heading. */
  hint?: string;
  /** A short visible explanation under the heading, readable on touch screens too. */
  note?: string;
  /** Starts collapsed until the listener opens it once. */
  closed?: boolean;
  /**
   * false: every visit to the app starts from `closed`; opening or closing only
   * lasts until the app is reloaded (it still survives switching modes).
   */
  remember?: boolean;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() =>
    remember ? (loadJSON<Record<string, boolean>>(KEY, {})[id] ?? closed) : (sessionState.get(id) ?? closed),
  );
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    if (remember) saveJSON(KEY, { ...loadJSON<Record<string, boolean>>(KEY, {}), [id]: next });
    else sessionState.set(id, next);
  };
  return (
    <section className={`insp-section ${collapsed ? 'collapsed' : ''}`}>
      <button className="insp-head" onClick={toggle} aria-expanded={!collapsed} title={hint}>
        <span>{title}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {!collapsed && (
        <div className="insp-body">
          {note && <p className="insp-note">{note}</p>}
          {children}
        </div>
      )}
    </section>
  );
}
