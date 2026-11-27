import { Download, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useLive } from '../../live/store';
import { exportCurrentTrack } from '../../studio/export';
import { PRESETS } from '../../studio/presets';
import { applyMix, applyPreset, deleteMix, MAX_MIXES, saveMix, soundLabel, useStudio } from '../../studio/store';
import { studioProcessing } from '../../studio/types';
import { cls } from '../hooks';
import { Section } from '../Section';
import { Rack } from './Rack';

/**
 * A tidy grid of short names, then the listener's own mixes; the one
 * sentence that explains the picked preset sits under it.
 */
function Presets() {
  const preset = useStudio((s) => s.preset);
  const tweaked = useStudio((s) => s.tweaked);
  const mixes = useStudio((s) => s.mixes);
  const mix = mixes.find((m) => m.id === preset);
  const picked = PRESETS.find((p) => p.id === preset);
  const note = mix ? { name: mix.name, text: 'Racikan Anda sendiri.' } : picked && { name: picked.label, text: picked.hint };
  return (
    <>
      <div className="preset-grid" role="radiogroup" aria-label="Preset suara">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            role="radio"
            aria-checked={preset === p.id}
            className={cls('preset', preset === p.id && 'on')}
            onClick={() => applyPreset(p.id)}
            data-tip={`${p.label}: ${p.hint}`}
          >
            {p.short}
          </button>
        ))}
        {mixes.map((m) => (
          <span
            key={m.id}
            className={cls('preset mine', preset === m.id && 'on')}
            // A saved name can be long: give it two or three cells instead of cutting it.
            style={m.name.length > 18 ? { gridColumn: 'span 3' } : m.name.length > 8 ? { gridColumn: 'span 2' } : undefined}
          >
            <button role="radio" aria-checked={preset === m.id} onClick={() => applyMix(m.id)} data-tip={`Racikan saya: ${m.name}`}>
              {m.name}
            </button>
            <button className="mine-del" onClick={() => deleteMix(m.id)} aria-label={`Hapus racikan ${m.name}`} data-tip="Hapus racikan ini">
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      {note && (
        <p className="preset-note" aria-live="polite">
          {tweaked ? (
            <>
              <b>{note.name}</b>, lalu disesuaikan di rack.
            </>
          ) : (
            <>
              <b>{note.name}.</b> {note.text}
            </>
          )}
        </p>
      )}
    </>
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
        data-tip={full ? `Sudah ${MAX_MIXES} racikan. Hapus salah satu di Pilih rasa dulu.` : 'Simpan pengaturan ini sebagai racikan Anda sendiri, muncul di Pilih rasa.'}
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

/*
 * Comparing lives in the player bar's sound chip (and on A), and going back to
 * the original is the Asli preset, so this row only keeps things.
 */
function Actions() {
  const exporting = useStudio((s) => s.exporting);
  const live = useLive((s) => s.on);
  const fileOnly = 'Hanya untuk lagu dari file Anda sendiri. Suara dari tab tidak disimpan.';
  return (
    <div className="sound-actions">
      <SaveMix />
      <button
        className="btn small ghost"
        disabled={!!exporting || live}
        onClick={() => void exportCurrentTrack(24)}
        data-tip={live ? fileOnly : 'Simpan lagu dengan suara racikan ini sebagai file WAV 24-bit, misalnya versi slowed + reverb Anda sendiri.'}
      >
        <Download size={14} aria-hidden="true" />
        {exporting ? `Menyimpan ${Math.round(exporting.progress * 100)}%` : 'WAV 24-bit'}
      </button>
      {!exporting && (
        <button
          className="btn small ghost"
          disabled={live}
          onClick={() => void exportCurrentTrack(32)}
          data-tip={live ? fileOnly : 'WAV 32-bit float: tidak ada pembulatan, puncak di atas 0 dBFS tetap utuh untuk diolah lagi di DAW.'}
        >
          <Download size={14} aria-hidden="true" />
          32-bit float
        </button>
      )}
    </div>
  );
}

export function StudioPanel() {
  return (
    <aside className="inspector studio panel" aria-label="Racik suara">
      <Section id="s-presets" title="Pilih rasa" hint="Satu klik, langsung terdengar. Setiap preset mulai dari suara asli.">
        <Presets />
      </Section>
      {/* The studio layer: folded until the listener opens it once, then remembered. */}
      <Section
        id="s-rack"
        title="Rack"
        closed
        hint="Modul yang menyala ada di atas dengan ringkasannya. Klik nama modul untuk membuka pengaturannya, klik lampunya untuk mematikan; lampu kuning berarti modul itu sedang mengubah suara."
      >
        <Rack />
      </Section>
      <Section id="s-save" title="Simpan" hint="Simpan pengaturan ini sebagai racikan Anda untuk dipakai lagi, atau simpan lagunya sebagai file WAV.">
        <Actions />
      </Section>
    </aside>
  );
}
