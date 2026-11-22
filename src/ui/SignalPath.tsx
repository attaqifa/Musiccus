import { engine } from '../audio/engine';
import { formatDb, formatRate } from '../lib/format';
import { mixNeutral } from '../stems/mixer';
import { useStems } from '../stems/store';
import { usePlayer } from '../store/player';
import { useStudio } from '../studio/store';
import { MODULE_LABEL, MODULE_ORDER, moduleActive, studioProcessing } from '../studio/types';
import { cls } from './hooks';

/**
 * clean: the samples pass untouched. level: only their level changes, in
 * float, which is lossless. changed: the sound itself is altered. info: a
 * fact about the path, not a stage Musiccus controls.
 */
type StepState = 'clean' | 'level' | 'changed' | 'info';

interface Step {
  name: string;
  value: string;
  state: StepState;
  note?: string;
}

const STATE_LABEL: Record<StepState, string> = {
  clean: 'Tidak diubah',
  level: 'Hanya level, tanpa kehilangan',
  changed: 'Mengubah suara',
  info: 'Informasi',
};

const DECODER: Record<string, string> = {
  browser: 'Decoder browser',
  aiff: 'Decoder Musiccus (AIFF)',
  synth: 'Demo yang disintesis',
};

function useSignalPath(): Step[] | null {
  const now = usePlayer((s) => s.now);
  const settings = usePlayer((s) => s.settings);
  const deviceRate = usePlayer((s) => s.deviceRate);
  const studio = useStudio((s) => s.state);
  const compare = useStudio((s) => s.compare);
  const stemMix = useStems((s) => s.mix);
  if (!now || now.decoder === 'live') return null;

  const steps: Step[] = [];
  steps.push({
    name: 'Sumber',
    value: `${formatRate(now.sourceRate)} · ${now.channels === 1 ? 'mono' : now.channels === 2 ? 'stereo' : `${now.channels} saluran`}`,
    state: 'info',
    note: DECODER[now.decoder],
  });

  steps.push(
    now.resampled
      ? {
          name: 'Sample rate',
          value: `${formatRate(now.sourceRate)} → ${formatRate(now.engineRate)}`,
          state: 'changed',
          note: settings.rateMode === 'device' ? 'Diubah ke rate perangkat, sesuai pengaturan.' : 'Browser tidak bisa memutar rate aslinya.',
        }
      : { name: 'Sample rate', value: `${formatRate(now.engineRate)}, asli`, state: 'clean' },
  );

  if (!mixNeutral(stemMix) && engine.stemsProcessing) {
    steps.push({ name: 'Stem', value: 'Mix stem diubah', state: 'changed' });
  }

  if (compare) {
    steps.push({ name: 'Racik', value: 'Dilewati, sedang membandingkan', state: 'clean' });
  } else if (studioProcessing(studio)) {
    const mods = MODULE_ORDER.filter((id) => id !== 'headphone' && moduleActive(studio, id)).map((id) => MODULE_LABEL[id]);
    if (Math.abs(studio.output.gain) > 0.01) mods.push(`Gain ${formatDb(studio.output.gain)}`);
    steps.push({ name: 'Racik', value: mods.join(', '), state: 'changed' });
  } else {
    steps.push({ name: 'Racik', value: 'Netral, dilewati', state: 'clean' });
  }

  if (settings.rgMode === 'off') {
    steps.push({ name: 'ReplayGain', value: 'Mati', state: 'clean' });
  } else {
    const mode = settings.rgMode === 'track' ? 'per lagu' : 'per album';
    steps.push(
      Math.abs(now.rgDb) < 0.01
        ? { name: 'ReplayGain', value: `0 dB, ${mode}`, state: 'clean' }
        : { name: 'ReplayGain', value: `${formatDb(now.rgDb)}, ${mode}`, state: 'level' },
    );
  }

  if (moduleActive(studio, 'headphone')) {
    const hp = studio.headphone;
    const parts = [hp.filters.length ? hp.profile || 'AutoEQ' : '', hp.crossfeed > 0 ? 'crossfeed' : ''].filter(Boolean);
    steps.push({ name: 'Headphone', value: parts.join(' + '), state: 'changed', note: 'Koreksi untuk telinga Anda; tetap aktif saat membandingkan.' });
  } else {
    steps.push({ name: 'Headphone', value: 'Tanpa koreksi', state: 'clean' });
  }

  if (settings.muted) steps.push({ name: 'Volume', value: 'Bisu', state: 'level' });
  else if (Math.abs(settings.volumeDb) < 0.01) steps.push({ name: 'Volume', value: '0 dB, utuh', state: 'clean' });
  else
    steps.push({
      name: 'Volume',
      value: `${formatDb(settings.volumeDb)} digital`,
      state: 'level',
      note: 'Untuk jalur yang benar-benar utuh, set 0 dB dan atur keras-pelan di perangkat.',
    });

  steps.push({
    name: 'Keluaran',
    value: `Browser → sistem · ${formatRate(deviceRate)}`,
    state: 'info',
    note: now.engineRate !== deviceRate ? `Sistem akan mengubah ${formatRate(now.engineRate)} ke rate perangkat.` : undefined,
  });
  return steps;
}

/** What Musiccus does to the sound between the file and the browser's output. */
export function SignalPath() {
  const steps = useSignalPath();
  if (!steps) return null;
  const changed = steps.filter((s) => s.state === 'changed').map((s) => s.name);
  const level = steps.filter((s) => s.state === 'level').map((s) => s.name);
  const headline = changed.length ? `Diubah Musiccus: ${changed.join(', ')}` : 'Tidak diubah Musiccus';
  const sub = changed.length
    ? null
    : level.length
      ? `Hanya level yang diatur (${level.join(', ').toLowerCase()}), dihitung dalam float 32-bit tanpa kehilangan.`
      : 'Bit-perfect sampai keluar dari Musiccus.';

  return (
    <section className="sp" aria-label="Jalur suara">
      <h4>Jalur suara</h4>
      <p className={cls('sp-status', changed.length ? 'changed' : 'clean')}>
        <i aria-hidden="true" />
        {headline}
      </p>
      {sub && <p className="sp-sub">{sub}</p>}
      <ol className="sp-steps">
        {steps.map((s) => (
          <li key={s.name} className={cls('sp-step', s.state)} title={STATE_LABEL[s.state]}>
            <span className="sp-name">{s.name}</span>
            <span className="sp-value">{s.value}</span>
            {s.note && <span className="sp-note">{s.note}</span>}
          </li>
        ))}
      </ol>
      <p className="sp-foot">
        Setelah keluar dari browser, mixer sistem (volume, efek suara, codec Bluetooth) masih bisa mengubah suara di luar kendali Musiccus.
      </p>
    </section>
  );
}
