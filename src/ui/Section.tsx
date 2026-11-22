import { ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { loadJSON, saveJSON } from '../lib/storage';

/** A collapsible panel section; the collapsed state is remembered per id. */
const KEY = 'musiccus:inspector-collapsed';

export function Section({
  id,
  title,
  hint,
  note,
  closed = false,
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
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => loadJSON<Record<string, boolean>>(KEY, {})[id] ?? closed);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    saveJSON(KEY, { ...loadJSON<Record<string, boolean>>(KEY, {}), [id]: next });
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
