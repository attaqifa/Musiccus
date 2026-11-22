import { Download, Plus, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { useAnalysis } from '../../analysis/manager';
import { useLive } from '../../live/store';
import { setSettings, usePlayer } from '../../store/player';
import { exportCurrentTrack } from '../../studio/export';
import { PRESETS } from '../../studio/presets';
import { applyMix, applyPreset, deleteMix, MAX_MIXES, resetStudio, saveMix, setBand, setModule, soundLabel, useStudio } from '../../studio/store';
import { ROOMS, studioProcessing } from '../../studio/types';
import { cls } from '../hooks';
import { Section } from '../Section';
import { CompareButton } from '../SoundChip';
import { Rack } from './Rack';

const signed = (v: number, unit = '') => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('id-ID', { maximumFractionDigits: 1 })}${unit}`;

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  def: number;
  text: string;
  hint?: string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <label className={cls('sound-slider', props.disabled && 'off')} title={props.hint}>
      <span className="ss-head">
        <span>{props.label}</span>
        <output>{props.text}</output>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        aria-valuetext={props.text}
        disabled={props.disabled}
        onChange={(e) => props.onChange(Number(e.target.value))}
        onDoubleClick={() => props.onChange(props.def)}
      />
    </label>
  );
}

function Presets() {
  const preset = useStudio((s) => s.preset);
  const tweaked = useStudio((s) => s.tweaked);
  const mixes = useStudio((s) => s.mixes);
  return (
    <div className="preset-grid" role="radiogroup" aria-label="Preset suara">
      {PRESETS.map((p) => (
        <button
          key={p.id}
          role="radio"
          aria-checked={preset === p.id}
          className={cls('preset', preset === p.id && 'on')}
          onClick={() => applyPreset(p.id)}
          title={p.hint}
        >
          <span className="preset-name">{p.label}</span>
          <span className="preset-hint">{preset === p.id && tweaked ? 'Disesuaikan' : p.hint}</span>
        </button>
      ))}
      {mixes.map((m) => (
        <div key={m.id} className={cls('preset mine', preset === m.id && 'on')}>
          <button role="radio" aria-checked={preset === m.id} className="preset-pick" onClick={() => applyMix(m.id)} title={`Racikan saya: ${m.name}`}>
            <span className="preset-name">{m.name}</span>
            <span className="preset-hint">{preset === m.id && tweaked ? 'Disesuaikan' : 'Racikan saya'}</span>
          </button>
          <button className="preset-del" onClick={() => deleteMix(m.id)} aria-label={`Hapus racikan ${m.name}`} title="Hapus racikan ini">
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}

function Adjust() {
  const s = useStudio((st) => st.state);
  const nowId = usePlayer((st) => st.now?.trackId);
  const { analysis } = useAnalysis(nowId);
  const live = useLive((st) => st.on);
  const p = s.pitch;
  const tempo = p.on && !live ? p.tempo : 1;
  const semis = p.on ? p.semitones : 0;
  const bass = s.eq.on ? s.eq.bands[0].gain : 0;
  const treble = s.eq.on ? s.eq.bands[7].gain : 0;
  const echo = s.space.on ? s.space.mix : 0;
  const pct = Math.round((tempo - 1) * 100);

  return (
    <div className="sound-adjust">
      <Slider
        label="Kecepatan"
        value={tempo}
        min={0.5}
        max={1.5}
        step={0.01}
        def={1}
        text={live ? 'Ikut tab' : pct === 0 ? 'Normal' : `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`}
        hint={live ? 'Suara dari tab diputar pada kecepatan aslinya; kecepatan hanya bisa diubah untuk lagu dari file.' : 'Klik ganda untuk kembali normal.'}
        disabled={live}
        onChange={(v) => setModule('pitch', { tempo: v, on: true })}
      />
      <label className={cls('sound-check', live && 'off')}>
        <input type="checkbox" checked={!p.keepPitch} disabled={live} onChange={(e) => setModule('pitch', { keepPitch: !e.target.checked, on: true })} />
        Nada ikut berubah dengan kecepatan, seperti piringan hitam
      </label>
      <Slider
        label="Nada"
        value={semis}
        min={-6}
        max={6}
        step={1}
        def={0}
        text={semis === 0 ? 'Asli' : `${signed(semis)} semitone`}
        hint="Naikkan atau turunkan nada tanpa mengubah kecepatan, misalnya supaya pas dengan suara Anda saat bernyanyi."
        onChange={(v) => setModule('pitch', { semitones: v, on: true })}
      />
      <Slider label="Bass" value={bass} min={-6} max={9} step={0.5} def={0} text={bass === 0 ? 'Asli' : signed(bass, ' dB')} onChange={(v) => setBand(0, { gain: v })} />
      <Slider
        label="Kejernihan"
        value={treble}
        min={-6}
        max={6}
        step={0.5}
        def={0}
        text={treble === 0 ? 'Asli' : signed(treble, ' dB')}
        hint="Naikkan supaya detail dan desis cymbal lebih terang; turunkan kalau terasa tajam."
        onChange={(v) => setBand(7, { gain: v })}
      />
      <Slider
        label="Gema"
        value={echo}
        min={0}
        max={0.6}
        step={0.01}
        def={0}
        text={echo === 0 ? 'Mati' : `${Math.round(echo * 100)}%`}
        onChange={(v) => {
          const room = s.space.on ? s.space.room : 'hall';
          setModule('space', { on: v > 0, mix: v, room, ...(s.space.on ? {} : { decay: ROOMS[room].decay, predelay: ROOMS[room].predelay, damping: ROOMS[room].damping }) });
        }}
      />
      {analysis && tempo !== 1 && (
        <p className="sound-readout">
          Tempo lagu {Math.round(analysis.bpm)} → {Math.round(analysis.bpm * tempo)} BPM
        </p>
      )}
    </div>
  );
}

/** Saves the current rack as one of the listener's own mixes. */
function SaveMix() {
  const [name, setName] = useState<string | null>(null);
  const count = useStudio((s) => s.mixes.length);
  const processing = useStudio((s) => studioProcessing(s.state));
  const suggestion = useStudio((s) => soundLabel(s).replace(' (disesuaikan)', ''));
  if (name === null) {
    const full = count >= MAX_MIXES;
    return (
      <button
        className="btn small ghost"
        disabled={!processing || full}
        onClick={() => setName(suggestion === 'Racikan sendiri' ? '' : `${suggestion} saya`)}
        title={full ? `Sudah ${MAX_MIXES} racikan. Hapus salah satu di Pilih rasa dulu.` : 'Simpan pengaturan ini sebagai racikan Anda sendiri, muncul di Pilih rasa.'}
      >
        <Plus size={14} aria-hidden="true" />
        Jadikan racikan saya
      </button>
    );
  }
  return (
    <form
      className="mix-form"
      onSubmit={(e) => {
        e.preventDefault();
        saveMix(name);
        setName(null);
      }}
    >
      <input
        autoFocus
        value={name}
        maxLength={32}
        placeholder="Nama racikan, mis. Bass malam"
        aria-label="Nama racikan"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setName(null)}
      />
      <button className="btn small" type="submit">
        Simpan
      </button>
      <button className="btn small ghost" type="button" onClick={() => setName(null)}>
        Batal
      </button>
    </form>
  );
}

function Actions() {
  const exporting = useStudio((s) => s.exporting);
  const preset = useStudio((s) => s.preset);
  const tweaked = useStudio((s) => s.tweaked);
  const clean = preset === 'asli' && !tweaked;
  const live = useLive((s) => s.on);
  const detail = usePlayer((s) => s.settings.detail);
  const fileOnly = 'Hanya untuk lagu dari file Anda sendiri. Suara dari tab tidak disimpan.';
  return (
    <div className="sound-actions">
      <CompareButton className="btn small" />
      <SaveMix />
      <button
        className="btn small ghost"
        disabled={!!exporting || live}
        onClick={() => void exportCurrentTrack(24)}
        title={live ? fileOnly : 'Simpan lagu dengan suara racikan ini sebagai file WAV 24-bit, misalnya versi slowed + reverb Anda sendiri.'}
      >
        <Download size={14} aria-hidden="true" />
        {exporting ? `Menyimpan ${Math.round(exporting.progress * 100)}%` : detail ? 'WAV 24-bit' : 'Simpan sebagai file'}
      </button>
      {detail && !exporting && (
        <button
          className="btn small ghost"
          disabled={live}
          onClick={() => void exportCurrentTrack(32)}
          title={live ? fileOnly : 'WAV 32-bit float: tidak ada pembulatan, puncak di atas 0 dBFS tetap utuh untuk diolah lagi di DAW.'}
        >
          <Download size={14} aria-hidden="true" />
          32-bit float
        </button>
      )}
      <button className="btn small ghost" disabled={clean} onClick={resetStudio} title="Kembali ke suara asli">
        <RotateCcw size={14} aria-hidden="true" />
        Asli
      </button>
    </div>
  );
}

/** One switch for the whole audiophile layer: the rack here, the meters and the recording data elsewhere. */
export function DetailSwitch() {
  const detail = usePlayer((s) => s.settings.detail);
  return (
    <div className="segmented small detail-switch" role="radiogroup" aria-label="Tampilan">
      <button role="radio" aria-checked={!detail} className={cls(!detail && 'on')} onClick={() => setSettings({ detail: false })} title="Preset dan beberapa slider sederhana.">
        Sederhana
      </button>
      <button
        role="radio"
        aria-checked={detail}
        className={cls(detail && 'on')}
        onClick={() => setSettings({ detail: true })}
        title="Rack knob lengkap, panel Pantau, dan angka serta Keaslian file di Pahami."
      >
        Detail
      </button>
    </div>
  );
}

export function StudioPanel() {
  const detail = usePlayer((s) => s.settings.detail);
  return (
    <aside className="inspector studio panel" aria-label="Racik suara">
      <div className="studio-mode">
        <DetailSwitch />
        <span>{detail ? 'Semua knob terbuka.' : 'Cukup pilih rasa.'}</span>
      </div>
      <Section id="s-presets" title="Pilih rasa" hint="Satu klik, langsung terdengar. Setiap preset mulai dari suara asli.">
        <Presets />
      </Section>
      {detail ? (
        <Section id="s-rack" title="Rack" hint="Setiap modul tertutup saat mati. Klik namanya untuk menyalakan; lampu kuning berarti modul itu sedang mengubah suara.">
          <Rack />
        </Section>
      ) : (
        <Section id="s-adjust" title="Sesuaikan" hint="Atur lebih jauh setelah memilih preset. Klik ganda slider untuk mengembalikannya.">
          <Adjust />
        </Section>
      )}
      <Section
        id="s-save"
        title="Bandingkan dan simpan"
        hint="Dengar asli memutar lagu tanpa racikan dengan volume yang disamakan. Racikan bisa disimpan untuk dipakai lagi, atau lagunya disimpan sebagai file."
      >
        <Actions />
      </Section>
    </aside>
  );
}
