import { useRef, useState, type ReactNode } from 'react';
import { useAnalysis } from '../../analysis/manager';
import { keyName } from '../../analysis/theory';
import { engine } from '../../audio/engine';
import { formatHz } from '../../lib/format';
import { useLive } from '../../live/store';
import { usePlayer } from '../../store/player';
import { setBand, setModule, useStudio } from '../../studio/store';
import {
  DEFAULT_BANDS,
  DIVISION_BEATS,
  heardSemitones,
  moduleActive,
  ROOMS,
  type BandType,
  type Division,
  type ModuleId,
  type Room,
  type StudioState,
} from '../../studio/types';
import { cls, useHub } from '../hooks';
import { Knob } from '../Knob';
import { EqCurve, gainless, usesQ } from './EqCurve';

const num = (v: number, d = 1) => v.toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d }).replace('-', '−');
const signed = (v: number, d = 1, unit = '') => `${v > 0 ? '+' : ''}${num(v, d)}${unit}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const ms = (s: number) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${num(s, 2)} s`);

/** Make-up gain that roughly restores the level a compressor takes away. */
export const autoMakeup = (threshold: number, ratio: number) => Math.min(12, Math.max(0, -threshold * (1 - 1 / ratio) * 0.5));

function K(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  def: number;
  fmt: (v: number) => string;
  onChange: (v: number) => void;
  bipolar?: boolean;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div className={cls('fx-knob', props.disabled && 'off')} title={props.hint}>
      <Knob
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step}
        defaultValue={props.def}
        label={props.label}
        format={props.fmt}
        onChange={props.onChange}
        bipolar={props.bipolar}
        disabled={props.disabled}
        size={44}
      />
      <span className="fx-knob-label">{props.label}</span>
      <output className="fx-knob-value">{props.fmt(props.value)}</output>
    </div>
  );
}

/** A knob over a logarithmic range (frequency, Q, times): equal turns, equal ratios. */
function LogK({ min, max, def, value, onChange, fmt, digits = 3, ...rest }: {
  label: string;
  value: number;
  min: number;
  max: number;
  def: number;
  fmt: (v: number) => string;
  onChange: (v: number) => void;
  digits?: number;
  disabled?: boolean;
  hint?: string;
}) {
  const span = Math.log(max / min);
  const toPos = (v: number) => Math.log(Math.min(max, Math.max(min, v)) / min) / span;
  const fromPos = (p: number) => Number((min * Math.exp(p * span)).toPrecision(digits));
  return (
    <K
      {...rest}
      min={0}
      max={1}
      step={0.004}
      def={toPos(def)}
      value={toPos(value)}
      fmt={(p) => fmt(fromPos(p))}
      onChange={(p) => onChange(fromPos(p))}
    />
  );
}

function Seg<T extends string>({ value, options, onChange, label, disabled }: {
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className={cls('segmented small', disabled && 'off')} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          className={cls(value === o.value && 'on')}
          onClick={() => onChange(o.value)}
          title={o.hint}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * One module of the rack. Closed while it is off, so the rack reads as a
 * short list; the lamp turns amber once the module actually changes the sound.
 */
function Card({ title, on, active, onToggle, summary, off, children }: {
  title: string;
  on: boolean;
  /** The module changes the signal (not just switched on at neutral). */
  active: boolean;
  onToggle?: () => void;
  summary?: string;
  /** What the module does, shown while it is off. */
  off: string;
  children: ReactNode;
}) {
  const head = (
    <>
      <span className={cls('fx-led', on && 'on', active && 'live')} aria-hidden="true" />
      <h4>{title}</h4>
      {on && <span className="fx-sum">{summary}</span>}
    </>
  );
  // Off, a module is just its name in a two-column grid; what it does is in the tooltip.
  return (
    <section className={cls('fx-card', on && 'on', !onToggle && 'fixed')}>
      {onToggle ? (
        <button className="fx-head" aria-pressed={on} onClick={onToggle} title={on ? `Matikan ${title}` : `${off}. Klik untuk menyalakan.`}>
          {head}
        </button>
      ) : (
        <div className="fx-head static">{head}</div>
      )}
      {on && <div className="fx-body">{children}</div>}
    </section>
  );
}

const toggle = (id: ModuleId, s: StudioState) => () => {
  const on = !s[id].on;
  if (id === 'comp') setModule('comp', { on, makeup: autoMakeup(s.comp.threshold, s.comp.ratio) });
  else setModule(id, { on } as Partial<StudioState[typeof id]>);
};

/** Tempo and key of what is playing, from the analysis or the live tab. */
function useSongInfo() {
  const nowId = usePlayer((st) => st.now?.trackId);
  const { analysis } = useAnalysis(nowId);
  const live = useLive((st) => st.on);
  const liveBpm = useLive((st) => st.bpm);
  const liveKey = useLive((st) => st.key);
  if (live) return { live: true, bpm: liveBpm, key: liveKey, ltas: null };
  return { live: false, bpm: analysis?.bpm ?? null, key: analysis?.key ?? null, ltas: analysis?.authenticity ?? null };
}

function PitchCard({ s }: { s: StudioState }) {
  const p = s.pitch;
  const { live, bpm, key } = useSongInfo();
  const tempo = live ? 1 : p.tempo;
  const heard = heardSemitones({ ...p, tempo });
  const parts = [
    p.semitones ? `${signed(p.semitones, 0)} st` : '',
    p.cents ? `${signed(p.cents, 0)} c` : '',
    tempo !== 1 ? `tempo ${pct(tempo)}` : '',
  ].filter(Boolean);
  return (
    <Card
      title="Pitch dan tempo"
      on={p.on}
      active={moduleActive(s, 'pitch')}
      onToggle={toggle('pitch', s)}
      summary={parts.join(' · ') || 'Netral'}
      off="Geser nada atau kecepatan"
    >
      <div className="fx-knobs">
        <K label="Semitone" value={p.semitones} min={-12} max={12} step={1} def={0} bipolar fmt={(v) => (v ? signed(v, 0) : '0')} onChange={(v) => setModule('pitch', { semitones: v })} />
        <K label="Cent" value={p.cents} min={-50} max={50} step={1} def={0} bipolar fmt={(v) => (v ? signed(v, 0) : '0')} onChange={(v) => setModule('pitch', { cents: v })} hint="Penyetelan halus, misalnya menyamakan lagu dengan gitar yang sedikit fals." />
        <K
          label="Tempo"
          value={tempo}
          min={0.5}
          max={1.5}
          step={0.01}
          def={1}
          bipolar
          fmt={(v) => (live ? 'Ikut tab' : pct(v))}
          onChange={(v) => setModule('pitch', { tempo: v })}
          disabled={live}
          hint={live ? 'Suara dari tab diputar pada kecepatan aslinya.' : undefined}
        />
      </div>
      <div className="fx-row">
        <Seg
          label="Perilaku nada saat tempo berubah"
          value={p.keepPitch ? 'keep' : 'vinyl'}
          disabled={live}
          options={[
            { value: 'keep', label: 'Jaga nada', hint: 'Kecepatan berubah, nada tetap.' },
            { value: 'vinyl', label: 'Vinyl', hint: 'Nada ikut naik turun dengan kecepatan, seperti piringan hitam.' },
          ]}
          onChange={(v) => setModule('pitch', { keepPitch: v === 'keep' })}
        />
        <label className="fx-check" title="Saat nada digeser, suara penyanyi tidak terdengar seperti tupai atau raksasa.">
          <input type="checkbox" checked={p.formant} onChange={(e) => setModule('pitch', { formant: e.target.checked })} />
          Jaga warna vokal
        </label>
      </div>
      {(bpm || key) && (tempo !== 1 || heard !== 0) && (
        <p className="fx-readout">
          {bpm && tempo !== 1 && `${Math.round(bpm)} → ${Math.round(bpm * tempo)} BPM`}
          {bpm && tempo !== 1 && key && heard !== 0 && ' · '}
          {key && heard !== 0 && `${keyName(key)} → ${keyName({ ...key, tonic: (((key.tonic + heard) % 12) + 12) % 12 })}`}
        </p>
      )}
    </Card>
  );
}

const sweepText = (v: number) =>
  v < -0.01 ? `LP ${formatHz(20000 * Math.pow(180 / 20000, -v))}` : v > 0.01 ? `HP ${formatHz(20 * Math.pow(6000 / 20, v))}` : 'Netral';

function FilterCard({ s }: { s: StudioState }) {
  const f = s.filter;
  return (
    <Card title="Filter" on={f.on} active={moduleActive(s, 'filter')} onToggle={toggle('filter', s)} summary={sweepText(f.sweep)} off="Redam treble atau buang bass">
      <div className="fx-knobs">
        <K
          label="Sweep"
          value={f.sweep}
          min={-1}
          max={1}
          step={0.01}
          def={0}
          bipolar
          fmt={sweepText}
          onChange={(v) => setModule('filter', { sweep: v })}
          hint="Ke kiri: low-pass, treble diredam seperti dari balik dinding. Ke kanan: high-pass, bass dibuang seperti radio kecil."
        />
        <K label="Resonansi" value={f.resonance} min={0} max={1} step={0.01} def={0.2} fmt={pct} onChange={(v) => setModule('filter', { resonance: v })} hint="Menonjolkan frekuensi tepat di titik potong." />
      </div>
    </Card>
  );
}

const BAND_TYPES: { value: BandType; label: string; hint: string }[] = [
  { value: 'lowshelf', label: 'Low shelf', hint: 'Menaikkan atau menurunkan semua frekuensi di bawah titik ini.' },
  { value: 'peaking', label: 'Peak', hint: 'Lonceng di sekitar satu frekuensi; Q mengatur lebarnya.' },
  { value: 'highshelf', label: 'High shelf', hint: 'Menaikkan atau menurunkan semua frekuensi di atas titik ini.' },
  { value: 'highpass', label: 'HP', hint: 'High-pass: membuang semua di bawah titik ini.' },
  { value: 'lowpass', label: 'LP', hint: 'Low-pass: membuang semua di atas titik ini.' },
  { value: 'notch', label: 'Notch', hint: 'Memotong satu frekuensi yang sangat sempit, misalnya dengung.' },
];

function EqCard({ s }: { s: StudioState }) {
  const [sel, setSel] = useState(0);
  const { ltas } = useSongInfo();
  const bands = s.eq.bands;
  const b = bands[sel];
  const moved = bands.filter((x, i) => x.gain !== 0 || x.type !== DEFAULT_BANDS[i].type || x.freq !== DEFAULT_BANDS[i].freq).length;
  return (
    <Card
      title="EQ parametrik"
      on={s.eq.on}
      active={moduleActive(s, 'eq')}
      onToggle={toggle('eq', s)}
      summary={moved ? `${moved} band diubah` : 'Rata'}
      off="Delapan band, kurva di atas spektrum lagu"
    >
      <EqCurve bands={bands} selected={sel} onSelect={setSel} onChange={(i, patch) => setBand(i, patch)} ltas={ltas} />
      <div className="fx-row">
        <Seg label={`Tipe band ${sel + 1}`} value={b.type} options={BAND_TYPES} onChange={(type) => setBand(sel, { type })} />
      </div>
      <div className="fx-knobs">
        <LogK label="Frekuensi" value={b.freq} min={20} max={20000} def={DEFAULT_BANDS[sel].freq} fmt={formatHz} onChange={(freq) => setBand(sel, { freq })} />
        <K
          label="Gain"
          value={b.gain}
          min={-12}
          max={12}
          step={0.5}
          def={0}
          bipolar
          fmt={(v) => `${signed(v)} dB`}
          onChange={(gain) => setBand(sel, { gain })}
          disabled={gainless(b.type)}
          hint={gainless(b.type) ? 'Filter jenis ini tidak memakai gain.' : undefined}
        />
        <LogK
          label="Q"
          value={b.q}
          min={0.3}
          max={12}
          def={1}
         
          fmt={(v) => num(v, 2)}
          onChange={(q) => setBand(sel, { q })}
          disabled={!usesQ(b.type)}
          hint={usesQ(b.type) ? 'Kecil = lebar dan halus, besar = sempit dan tajam.' : 'Shelf dan filter potong di Web Audio tidak memakai Q.'}
        />
      </div>
      <div className="fx-row">
        <button className="btn small ghost" disabled={b.gain === 0} onClick={() => setBand(sel, { gain: 0 })}>
          Ratakan band {sel + 1}
        </button>
        <button className="btn small ghost" disabled={!moved} onClick={() => setModule('eq', { bands: DEFAULT_BANDS })}>
          Reset EQ
        </button>
      </div>
    </Card>
  );
}

/** Gain reduction of the compressor, read every frame. */
function GrMeter() {
  const bar = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const held = useRef(0);
  useHub((snap) => {
    const gr = Math.min(0, engine.studio?.reduction ?? 0);
    held.current = gr < held.current ? gr : held.current + (gr - held.current) * Math.min(1, snap.dt * 6);
    const v = held.current;
    if (bar.current) bar.current.style.width = `${Math.min(100, (-v / 20) * 100)}%`;
    if (text.current) text.current.textContent = `${num(v)} dB`;
  });
  return (
    <div className="gr-meter" title="Gain reduction: seberapa banyak kompresor sedang menekan level.">
      <span>GR</span>
      <span className="gr-track">
        <span ref={bar} />
      </span>
      <span className="gr-value" ref={text}>
        0,0 dB
      </span>
    </div>
  );
}

function CompCard({ s }: { s: StudioState }) {
  const c = s.comp;
  const set = (patch: Partial<StudioState['comp']>) => {
    const next = { ...c, ...patch };
    setModule('comp', { ...patch, makeup: autoMakeup(next.threshold, next.ratio) });
  };
  return (
    <Card title="Kompresor" on={c.on} active={c.on} onToggle={toggle('comp', s)} summary={`${num(c.threshold, 0)} dB · ${num(c.ratio)}:1`} off="Rapatkan dinamika, bagian pelan terangkat">
      <div className="fx-knobs four">
        <K label="Threshold" value={c.threshold} min={-48} max={0} step={0.5} def={-18} fmt={(v) => `${num(v)} dB`} onChange={(threshold) => set({ threshold })} hint="Level tempat kompresor mulai bekerja." />
        <LogK label="Ratio" value={c.ratio} min={1} max={20} def={3} fmt={(v) => `${num(v)}:1`} onChange={(ratio) => set({ ratio })} hint="Seberapa keras level di atas threshold ditekan." />
        <LogK label="Attack" value={c.attack} min={0.001} max={0.1} def={0.01} fmt={ms} onChange={(attack) => set({ attack })} hint="Cepat = transien ikut ditekan; lambat = pukulan drum tetap lolos." />
        <LogK label="Release" value={c.release} min={0.03} max={1} def={0.18} fmt={ms} onChange={(release) => set({ release })} hint="Seberapa cepat level kembali setelah ditekan." />
      </div>
      <div className="fx-row">
        <GrMeter />
        <span className="fx-sub" title="Dihitung dari threshold dan ratio, supaya hasilnya tidak sekadar lebih pelan.">
          Makeup {signed(c.makeup)} dB otomatis
        </span>
      </div>
    </Card>
  );
}

function DriveCard({ s }: { s: StudioState }) {
  const d = s.drive;
  return (
    <Card
      title="Saturasi"
      on={d.on}
      active={d.on}
      onToggle={toggle('drive', s)}
      summary={`${d.character === 'tube' ? 'Tabung' : 'Pita'} · ${pct(d.amount)}`}
      off="Kehangatan tabung atau pita"
    >
      <Seg
        label="Karakter saturasi"
        value={d.character}
        options={[
          { value: 'tube', label: 'Tabung', hint: 'Harmonik genap: hangat dan manis.' },
          { value: 'tape', label: 'Pita', hint: 'Harmonik ganjil dan kompresi halus, seperti kaset.' },
        ]}
        onChange={(character) => setModule('drive', { character })}
      />
      <div className="fx-knobs">
        <K label="Drive" value={d.amount} min={0} max={1} step={0.01} def={0.3} fmt={pct} onChange={(amount) => setModule('drive', { amount })} />
        <K label="Tone" value={d.tone} min={0} max={1} step={0.01} def={0.7} fmt={(v) => formatHz(2500 * Math.pow(8, v))} onChange={(tone) => setModule('drive', { tone })} hint="Meredam desis harmonik tinggi dari saturasi." />
        <K label="Mix" value={d.mix} min={0} max={1} step={0.01} def={1} fmt={pct} onChange={(mix) => setModule('drive', { mix })} hint="Campuran suara asli dan suara yang disaturasi." />
      </div>
    </Card>
  );
}

const balanceText = (v: number) => (Math.abs(v) < 0.01 ? 'Tengah' : `${v < 0 ? 'L' : 'R'} ${Math.round(Math.abs(v) * 100)}`);

function StereoCard({ s }: { s: StudioState }) {
  const st = s.stereo;
  return (
    <Card
      title="Stereo"
      on={st.on}
      active={st.on}
      onToggle={toggle('stereo', s)}
      summary={st.mono ? 'Mono' : `Lebar ${pct(st.width)}${Math.abs(st.balance) > 0.01 ? ` · ${balanceText(st.balance)}` : ''}`}
      off="Lebar panggung dan cek mono"
    >
      <div className="fx-knobs">
        <K
          label="Lebar"
          value={st.width}
          min={0}
          max={2}
          step={0.01}
          def={1}
          bipolar
          fmt={pct}
          onChange={(width) => setModule('stereo', { width })}
          disabled={st.mono}
          hint="0% mono, 100% asli, di atas itu lebih lebar dari aslinya."
        />
        <K label="Balance" value={st.balance} min={-1} max={1} step={0.01} def={0} bipolar fmt={balanceText} onChange={(balance) => setModule('stereo', { balance })} />
      </div>
      <label className="fx-check" title="Dengar campuran mono: cara cepat menemukan masalah fase atau instrumen yang hilang di speaker tunggal.">
        <input type="checkbox" checked={st.mono} onChange={(e) => setModule('stereo', { mono: e.target.checked })} />
        Cek mono
      </label>
    </Card>
  );
}

const DIVISIONS: { value: Division; label: string; hint: string }[] = [
  { value: '1/4', label: '1/4', hint: 'Satu ketukan.' },
  { value: '1/4d', label: '1/4.', hint: 'Satu setengah ketukan.' },
  { value: '1/8', label: '1/8', hint: 'Setengah ketukan.' },
  { value: '1/8d', label: '1/8.', hint: 'Tiga perempat ketukan, pola delay yang paling umum.' },
  { value: '1/16', label: '1/16', hint: 'Seperempat ketukan.' },
];

function DelayCard({ s }: { s: StudioState }) {
  const d = s.delay;
  const { bpm } = useSongInfo();
  const synced = d.sync && !!bpm;
  const time = synced ? (60 / bpm!) * DIVISION_BEATS[d.division] : d.timeMs / 1000;
  return (
    <Card
      title="Delay"
      on={d.on}
      active={d.on}
      onToggle={toggle('delay', s)}
      summary={`${d.sync ? d.division : ms(d.timeMs / 1000)} · mix ${pct(d.mix)}`}
      off="Gema berulang kiri-kanan"
    >
      <div className="fx-row">
        <Seg
          label="Waktu delay"
          value={d.sync ? 'sync' : 'free'}
          options={[
            { value: 'sync', label: 'Ikut tempo', hint: 'Gema jatuh tepat di ketukan lagu.' },
            { value: 'free', label: 'Bebas', hint: 'Atur waktunya sendiri dalam milidetik.' },
          ]}
          onChange={(v) => setModule('delay', { sync: v === 'sync' })}
        />
        {d.sync && <Seg label="Pembagian ketukan" value={d.division} options={DIVISIONS} onChange={(division) => setModule('delay', { division })} />}
      </div>
      <div className="fx-knobs">
        {!d.sync && <LogK label="Waktu" value={d.timeMs} min={20} max={2000} def={320} digits={3} fmt={(v) => ms(v / 1000)} onChange={(timeMs) => setModule('delay', { timeMs: Math.round(timeMs) })} />}
        <K label="Feedback" value={d.feedback} min={0} max={0.9} step={0.01} def={0.35} fmt={pct} onChange={(feedback) => setModule('delay', { feedback })} hint="Berapa kali gema berulang sebelum hilang." />
        <K label="Mix" value={d.mix} min={0} max={0.6} step={0.01} def={0.2} fmt={pct} onChange={(mix) => setModule('delay', { mix })} />
      </div>
      <p className="fx-readout">
        {ms(time)}
        {d.sync && (bpm ? ` pada ${Math.round(bpm)} BPM` : ' (tempo lagu belum diketahui)')}
      </p>
    </Card>
  );
}

function SpaceCard({ s }: { s: StudioState }) {
  const sp = s.space;
  const rooms = Object.entries(ROOMS) as [Room, (typeof ROOMS)[Room]][];
  return (
    <Card title="Ruang" on={sp.on} active={sp.on} onToggle={toggle('space', s)} summary={`${ROOMS[sp.room].label} · mix ${pct(sp.mix)}`} off="Reverb, dari studio sampai katedral">
      <Seg
        label="Jenis ruang"
        value={sp.room}
        options={rooms.map(([value, r]) => ({ value, label: r.label }))}
        onChange={(room) => setModule('space', { room, decay: ROOMS[room].decay, predelay: ROOMS[room].predelay, damping: ROOMS[room].damping })}
      />
      <div className="fx-knobs">
        <LogK label="Decay" value={sp.decay} min={0.2} max={8} def={ROOMS[sp.room].decay} fmt={(v) => `${num(v)} s`} onChange={(decay) => setModule('space', { decay })} hint="Berapa lama gema ruang memudar." />
        <K
          label="Pre-delay"
          value={sp.predelay}
          min={0}
          max={0.1}
          step={0.001}
          def={ROOMS[sp.room].predelay}
          fmt={(v) => `${Math.round(v * 1000)} ms`}
          onChange={(predelay) => setModule('space', { predelay })}
          hint="Jeda sebelum gema mulai; vokal tetap jelas di depan."
        />
        <K label="Mix" value={sp.mix} min={0} max={0.6} step={0.01} def={0.22} fmt={pct} onChange={(mix) => setModule('space', { mix })} />
      </div>
    </Card>
  );
}

function OutputCard({ s }: { s: StudioState }) {
  const o = s.output;
  return (
    <Card title="Output" on active={Math.abs(o.gain) > 0.01} summary={o.gain ? `${signed(o.gain)} dB` : '0 dB'} off="">
      <div className="fx-row">
        <K label="Gain" value={o.gain} min={-12} max={12} step={0.5} def={0} bipolar fmt={(v) => `${signed(v)} dB`} onChange={(gain) => setModule('output', { gain })} />
        <label className="fx-check" title="Menahan puncak di −1 dBFS supaya racikan yang lebih keras tidak clipping.">
          <input type="checkbox" checked={o.limiter} onChange={(e) => setModule('output', { limiter: e.target.checked })} />
          Limiter pengaman
        </label>
      </div>
    </Card>
  );
}

/** The detailed rack: every module of the studio graph, on knobs. */
export function Rack() {
  const s = useStudio((st) => st.state);
  return (
    <div className="fx-rack">
      <PitchCard s={s} />
      <FilterCard s={s} />
      <EqCard s={s} />
      <CompCard s={s} />
      <DriveCard s={s} />
      <StereoCard s={s} />
      <DelayCard s={s} />
      <SpaceCard s={s} />
      <OutputCard s={s} />
      <p className="fx-hint">Seret knob naik atau turun (Shift untuk halus), atau scroll di atasnya. Klik ganda untuk kembali ke nilai awal.</p>
    </div>
  );
}
