import { Download, PencilLine } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { chordChart, chordsFor, type ChartBar, type ChartName, type ChordView } from '../../analysis/chordView';
import { getFix, labFor, setSheetChecked } from '../../analysis/manager';
import type { Analysis } from '../../analysis/types';
import { formatTime } from '../../lib/format';
import { seek } from '../../store/controller';
import { setSettings, usePlayer } from '../../store/player';
import { setModule, useStudio } from '../../studio/store';
import { cls, useHub } from '../hooks';
import { ChordPicker, type ChordTarget } from './ChordFix';
import { sectionColor } from './MusicSummary';

const BARS_PER_ROW = 4;
const SPEEDS = [1, 0.85, 0.7];

const VIEWS: { value: ChordView; label: string; hint: string }[] = [
  {
    value: 'simple',
    label: 'Ringkas',
    hint: 'Akor yang kurang dari dua ketukan dilebur ke akor di sebelahnya, dan pergantian jatuh tepat di ketukan. Paling enak untuk ikut main.',
  },
  { value: 'full', label: 'Lengkap', hint: 'Semua pergantian yang terdengar oleh analisis, termasuk akor lewat yang singkat.' },
];

/** Plays slower without changing the key, through the same control as Racik › Pitch dan tempo. */
function SpeedSwitch() {
  const pitch = useStudio((s) => s.state.pitch);
  const rate = pitch.on ? pitch.tempo : 1;
  const pick = (v: number) => {
    if (v === 1) setModule('pitch', { tempo: 1 });
    // Turning the module on must not bring back a key shift that was switched off.
    else if (!pitch.on) setModule('pitch', { on: true, tempo: v, keepPitch: true, semitones: 0, cents: 0 });
    else setModule('pitch', { tempo: v, keepPitch: true });
  };
  return (
    <span className="sheet-speed">
      <span>Kecepatan</span>
      <span className="segmented small" role="radiogroup" aria-label="Kecepatan putar">
        {SPEEDS.map((v) => (
          <button
            key={v}
            role="radio"
            aria-checked={Math.abs(rate - v) < 0.005}
            className={cls(Math.abs(rate - v) < 0.005 && 'on')}
            onClick={() => pick(v)}
            data-tip={v === 1 ? 'Kecepatan asli.' : 'Pelankan tanpa mengubah nada, supaya sempat pindah akor. Sama dengan Tempo di Racik › Pitch dan tempo.'}
          >
            {Math.round(v * 100)}%
          </button>
        ))}
      </span>
    </span>
  );
}

/**
 * The song's chords as a chart of bars, four to a row. The row being played
 * stays on top with the next two under it, so the next chord can be read
 * before it arrives. The follow is checked on every new bar, so a scroll that
 * was cut short catches up.
 */
export function ChordSheet({ analysis, trackId }: { analysis: Analysis; trackId: string }) {
  const view = usePlayer((s) => s.settings.chordView);
  const [edit, setEdit] = useState(false);
  const [fix, setFix] = useState<ChordTarget | null>(null);
  const editing = useRef(edit);
  editing.current = edit;
  const chords = chordsFor(analysis, view);
  const bars = useMemo(() => chordChart(analysis, chords), [analysis, chords]);
  const rows = useMemo(() => {
    const out: ChartBar[][] = [];
    for (let i = 0; i < bars.length; i += BARS_PER_ROW) out.push(bars.slice(i, i + BARS_PER_ROW));
    return out;
  }, [bars]);
  const barOfBeat = useMemo(() => {
    const map = new Int32Array(analysis.beats.length).fill(-1);
    bars.forEach((b, k) => map.fill(k, b.first, b.first + b.beats));
    return map;
  }, [analysis, bars]);

  const scroller = useRef<HTMLDivElement>(null);
  const ticks = useRef<(HTMLElement | null)[]>([]);
  const barEls = useRef<(HTMLElement | null)[]>([]);
  const rowEls = useRef<(HTMLElement | null)[]>([]);
  const at = useRef({ beat: -1, bar: -2 });
  const userAt = useRef(0);

  useEffect(() => {
    at.current = { beat: -1, bar: -2 };
  }, [bars]);

  useHub((s) => {
    const m = s.music;
    const beat = m.ready && m.beatIndex < barOfBeat.length ? m.beatIndex : -1;
    const cur = at.current;
    if (beat === cur.beat && cur.bar !== -2) return;
    ticks.current[cur.beat]?.classList.remove('now');
    ticks.current[beat]?.classList.add('now');
    cur.beat = beat;
    const bar = beat >= 0 ? barOfBeat[beat] : -1;
    if (bar === cur.bar) return;
    cur.bar = bar;
    barEls.current.forEach((el, k) => {
      el?.classList.toggle('now', k === bar);
      el?.classList.toggle('past', bar >= 0 && k < bar);
    });
    // Stopped or ended: leave the sheet where the listener last saw it. Scrolling
    // by hand pauses the follow for a few seconds, like the lyrics.
    const box = scroller.current;
    const el = rowEls.current[Math.max(0, Math.floor(bar / BARS_PER_ROW))];
    // While correcting, the sheet stays where the listener is working.
    if (!m.ready || !box || !el || editing.current || performance.now() - userAt.current < 3500) return;
    const top = Math.min(el.offsetTop, box.scrollHeight - box.clientHeight);
    if (Math.abs(box.scrollTop - top) > 2) {
      box.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  });

  const touched = () => void (userAt.current = performance.now());

  // A named chord is corrected as a whole; a dash only over the beats it covers.
  const open = (b: ChartBar, n: ChartName, anchor: HTMLElement) => {
    const t0 = analysis.beats[b.first + n.at];
    const t1 = analysis.beats[b.first + n.at + n.span] ?? analysis.duration;
    setFix({ span: n.chord ? { t: n.chord.t, end: n.chord.end } : { t: t0, end: t1 }, chord: n.chord, anchor });
  };
  const checked = !!getFix(trackId)?.checked;
  const download = () => {
    const lab = labFor(trackId);
    if (!lab) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lab], { type: 'text/plain' }));
    // The first line is the title comment; characters Windows refuses in a file name become spaces.
    const title = lab.slice(2, lab.indexOf('\n')).replace(/[\\/:*?"<>|]+/g, ' ').trim();
    a.download = `${title || 'akor'}.lab`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="chord-sheet">
      <div className="sheet-tools">
        <span className="segmented small" role="radiogroup" aria-label="Tampilan akor">
          {VIEWS.map((o) => (
            <button
              key={o.value}
              role="radio"
              aria-checked={view === o.value}
              className={cls(view === o.value && 'on')}
              onClick={() => setSettings({ chordView: o.value })}
              data-tip={o.hint}
            >
              {o.label}
            </button>
          ))}
        </span>
        <SpeedSwitch />
        <button
          className={cls('btn ghost small sheet-edit', edit && 'on')}
          aria-pressed={edit}
          onClick={() => setEdit(!edit)}
          data-tip="Ada akor yang salah? Klik akornya untuk memilih yang benar. Koreksi disimpan untuk file ini."
        >
          <PencilLine size={14} aria-hidden="true" />
          Koreksi
        </button>
      </div>
      {edit && (
        <div className="sheet-fixbar">
          <p>Klik akor yang salah untuk memilih yang benar. Koreksi disimpan untuk file ini dan ikut dipakai menguji ketepatan analisis.</p>
          <label className="fx-check" data-tip="Semua akor di lembar ini, termasuk yang tidak Anda ubah, dicatat sebagai sudah benar.">
            <input type="checkbox" checked={checked} onChange={(e) => setSheetChecked(trackId, e.target.checked, view)} />
            Saya sudah memeriksa seluruh lembar ini
          </label>
          <button className="link-btn" onClick={download} data-tip="Akor dan kunci sebagai file .lab (format MIREX), untuk alat uji akor.">
            <Download size={12} aria-hidden="true" /> Unduh .lab
          </button>
        </div>
      )}
      <div className="sheet-scroll" ref={scroller} role="region" aria-label="Lembar akor" onWheel={touched} onTouchMove={touched}>
        {rows.map((row, r) => (
          <div className="sheet-row" key={r} ref={(el) => void (rowEls.current[r] = el)}>
            {row.map((b, i) => {
              const k = r * BARS_PER_ROW + i;
              const cols = { gridTemplateColumns: `repeat(${b.beats}, minmax(0, 1fr))` };
              const inner = (
                <>
                  {b.section && (
                    <span className="sheet-sec" style={{ color: sectionColor(b.section) }}>
                      {b.section.name === 'Bagian' ? `Bagian ${b.section.label}` : b.section.name}
                    </span>
                  )}
                  <span className="sheet-names" style={cols}>
                    {b.names.map((n) => {
                      const c = cls('nm', n.held && 'held', n.span === 1 && 'tight', n.chord?.fixed && 'fixed');
                      const place = { gridColumn: `${n.at + 1} / span ${n.span}` };
                      return edit ? (
                        <button
                          key={n.at}
                          className={c}
                          style={place}
                          onClick={(e) => open(b, n, e.currentTarget)}
                          aria-label={`${n.chord ? n.text : 'Tanpa akor'}, birama ${k + 1}${n.chord?.fixed ? ', dikoreksi' : ''}. Koreksi`}
                        >
                          {n.text}
                        </button>
                      ) : (
                        <span key={n.at} className={c} style={place}>
                          {n.text}
                        </span>
                      );
                    })}
                  </span>
                  <span className="sheet-ticks" style={cols}>
                    {Array.from({ length: b.beats }, (_, j) => (
                      <i key={j} ref={(el) => void (ticks.current[b.first + j] = el)} />
                    ))}
                  </span>
                </>
              );
              // Correcting: the chord names are the buttons, so the bar itself is not one.
              return edit ? (
                <div key={k} ref={(el) => void (barEls.current[k] = el)} className="sheet-bar editing" style={{ flexGrow: b.beats }}>
                  {inner}
                </div>
              ) : (
                <button
                  key={k}
                  ref={(el) => void (barEls.current[k] = el)}
                  className="sheet-bar"
                  style={{ flexGrow: b.beats }}
                  tabIndex={-1}
                  onClick={() => seek(b.t)}
                  data-tip={`Birama ${k + 1} · ${formatTime(b.t)}. Klik untuk memutar dari sini.`}
                >
                  {inner}
                </button>
              );
            })}
            {row.length < BARS_PER_ROW && <span className="sheet-rest" style={{ flexGrow: (BARS_PER_ROW - row.length) * 4 }} />}
          </div>
        ))}
      </div>
      {fix && <ChordPicker trackId={trackId} analysis={analysis} view={chords} target={fix} onClose={() => setFix(null)} />}
    </div>
  );
}
