import { ListMusic, Moon, Repeat, Repeat1, Shuffle, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { songLabel } from '../library/display';
import { clearUpNext, cycleRepeat, playQueueAt, playUpNext, removeUpNext, setShuffle } from '../store/controller';
import { setUi, usePlayer, type RepeatMode, type SleepTimer, type Track } from '../store/player';
import { setSleep, SLEEP_CHOICES } from '../store/sleep';
import { cls } from './hooks';

/** How many coming songs the popover lists; the rest is a count. */
const SHOW = 30;

const titleOf = (t: Track | undefined) => {
  if (!t) return 'Lagu tidak ditemukan';
  const l = songLabel(t);
  return l.version ? `${l.title} (${l.version})` : l.title;
};

const REPEAT_LABEL: Record<RepeatMode, string> = { off: 'Ulang: mati', all: 'Ulang: semua', one: 'Ulang: satu lagu' };

export function ShuffleButton({ className }: { className?: string }) {
  const on = usePlayer((s) => s.settings.shuffle);
  return (
    <button
      className={cls('icon-btn mode-btn', on && 'on', className)}
      onClick={() => setShuffle(!on)}
      aria-pressed={on}
      aria-label="Acak"
      data-tip={on ? 'Acak: aktif' : 'Acak: mati'}
    >
      <Shuffle size={16} />
    </button>
  );
}

export function RepeatButton({ className }: { className?: string }) {
  const mode = usePlayer((s) => s.settings.repeat);
  return (
    <button
      className={cls('icon-btn mode-btn', mode !== 'off' && 'on', className)}
      onClick={cycleRepeat}
      aria-pressed={mode !== 'off'}
      aria-label={REPEAT_LABEL[mode]}
      data-tip={`${REPEAT_LABEL[mode]} (klik untuk mengganti)`}
    >
      {mode === 'one' ? <Repeat1 size={16} /> : <Repeat size={16} />}
    </button>
  );
}

const clock = (at: number) => new Date(at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

function sleepText(sleep: SleepTimer, now: number): string {
  if (sleep.kind === 'track') return 'Musik berhenti di akhir lagu ini.';
  const min = Math.ceil((sleep.at - now) / 60_000);
  if (min <= 0) return 'Musik sedang memudar…';
  return `Musik dijeda sekitar pukul ${clock(sleep.at)}, ${min} menit lagi.`;
}

function SleepTimerField() {
  const sleep = usePlayer((s) => s.sleep);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (sleep?.kind !== 'time') return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(t);
  }, [sleep]);
  const value = !sleep ? 'off' : sleep.kind === 'track' ? 'track' : String(sleep.minutes);
  const options: { value: string; label: string; aria?: string; pick: number | 'track' | null }[] = [
    { value: 'off', label: 'Mati', pick: null },
    ...SLEEP_CHOICES.map((m) => ({ value: String(m), label: String(m), aria: `${m} menit`, pick: m })),
    { value: 'track', label: 'Akhir lagu', pick: 'track' as const },
  ];
  return (
    <section className="q-sec q-sleep" aria-labelledby="q-sleep-h">
      <h3 id="q-sleep-h">
        <Moon size={13} aria-hidden="true" />
        Timer tidur <span className="q-unit">(menit)</span>
      </h3>
      <div className="segmented small" role="radiogroup" aria-labelledby="q-sleep-h">
        {options.map((o) => (
          <button
            key={o.value}
            role="radio"
            aria-checked={value === o.value}
            aria-label={o.aria}
            className={cls(value === o.value && 'on')}
            // Picking the same time again restarts it from now.
            onClick={() => setSleep(o.pick)}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="q-note" aria-live="polite">
        {sleep ? sleepText(sleep, now) : 'Musik memudar pelan, lalu dijeda.'}
      </p>
    </section>
  );
}

function QueuePop() {
  const tracks = usePlayer((s) => s.tracks);
  const nowId = usePlayer((s) => s.now?.trackId);
  const queue = usePlayer((s) => s.queue);
  const queueIndex = usePlayer((s) => s.queueIndex);
  const upNext = usePlayer((s) => s.upNext);
  const shuffle = usePlayer((s) => s.settings.shuffle);
  const repeat = usePlayer((s) => s.settings.repeat);

  const coming: number[] = [];
  for (let i = queueIndex + 1; i < queue.length && coming.length < SHOW; i++) coming.push(i);
  const rest = Math.max(0, queue.length - queueIndex - 1 - coming.length);
  // Ulang semua: the top of the queue follows its end.
  const wrapAt = coming.length;
  if (repeat === 'all') for (let i = 0; i <= queueIndex && coming.length < SHOW; i++) coming.push(i);
  const nowTrack = nowId ? tracks[nowId] : undefined;

  return (
    <div className="q-pop panel" role="dialog" aria-label="Antrean">
      <div className="q-head">
        <h2>Antrean</h2>
        <div className="q-modes">
          <button className={cls('q-mode', shuffle && 'on')} aria-pressed={shuffle} onClick={() => setShuffle(!shuffle)}>
            <Shuffle size={14} aria-hidden="true" />
            Acak
          </button>
          <button className={cls('q-mode', repeat !== 'off' && 'on')} aria-pressed={repeat !== 'off'} onClick={cycleRepeat} data-tip="Klik untuk mengganti: mati, semua, satu lagu">
            {repeat === 'one' ? <Repeat1 size={14} aria-hidden="true" /> : <Repeat size={14} aria-hidden="true" />}
            {REPEAT_LABEL[repeat]}
          </button>
        </div>
      </div>

      {nowTrack && (
        <section className="q-sec" aria-label="Sedang diputar">
          <h3>Sedang diputar</h3>
          <div className="q-row now">
            <span className="q-title">{titleOf(nowTrack)}</span>
            <span className="q-sub">{nowTrack.meta?.artist}</span>
          </div>
        </section>
      )}

      {upNext.length > 0 && (
        <section className="q-sec" aria-labelledby="q-up-h">
          <h3 id="q-up-h">
            Berikutnya dari Anda <span className="q-unit">{upNext.length}</span>
            <button className="link-btn q-clear" onClick={clearUpNext}>
              Kosongkan
            </button>
          </h3>
          <ol className="q-list">
            {upNext.map((id, i) => (
              <li key={`${id}:${i}`} className="q-item">
                <button className="q-row" onClick={() => void playUpNext(i)} data-tip="Putar sekarang">
                  <span className="q-title">{titleOf(tracks[id])}</span>
                  <span className="q-sub">{tracks[id]?.meta?.artist}</span>
                </button>
                <button className="q-remove" onClick={() => removeUpNext(i)} aria-label={`Hapus “${titleOf(tracks[id])}” dari antrean`} data-tip="Hapus dari antrean">
                  <X size={14} />
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="q-sec" aria-labelledby="q-next-h">
        <h3 id="q-next-h">{shuffle ? 'Lalu, diacak' : 'Lalu'}</h3>
        {coming.length === 0 ? (
          <p className="q-note">{queue.length ? 'Ini lagu terakhir di daftar. Nyalakan Ulang semua untuk memutar dari awal.' : 'Belum ada lagu berikutnya.'}</p>
        ) : (
          <ol className="q-list">
            {coming.map((qi, n) => (
              <li key={`${qi}:${n}`} className={cls('q-item', n === wrapAt && n > 0 && 'wrap')}>
                {n === wrapAt && <span className="q-divider">Diulang dari awal</span>}
                <button className={cls('q-row', tracks[queue[qi]]?.needsWasm && 'unsupported')} onClick={() => void playQueueAt(qi)} data-tip="Putar sekarang">
                  <span className="q-title">{titleOf(tracks[queue[qi]])}</span>
                  <span className="q-sub">{tracks[queue[qi]]?.meta?.artist}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
        {rest > 0 && <p className="q-note">dan {rest.toLocaleString('id-ID')} lagu lagi</p>}
      </section>

      <SleepTimerField />
    </div>
  );
}

/** The queue button in the transport, with the popover it opens. */
export function QueueButton() {
  const open = usePlayer((s) => s.ui.queue);
  const sleep = usePlayer((s) => s.sleep);
  const nowId = usePlayer((s) => s.now?.trackId);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const el = e.target as Element;
      // Adding songs from the library keeps the queue in view.
      if (root.current?.contains(el) || el.closest?.('.lib-track, .lib-album, .ctx-menu')) return;
      setUi({ queue: false });
    };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [open]);
  useEffect(() => {
    if (!nowId && open) setUi({ queue: false });
  }, [nowId, open]);

  const label = sleep ? 'Antrean dan timer tidur (timer aktif)' : 'Antrean dan timer tidur';
  return (
    <div className="q-wrap" ref={root}>
      <button
        className={cls('icon-btn q-btn', open && 'on')}
        onClick={() => setUi({ queue: !open })}
        disabled={!nowId}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        aria-keyshortcuts="Q"
        data-tip={label}
        data-kbd="Q"
      >
        <ListMusic size={17} />
        {sleep && <Moon className="q-badge" size={10} aria-hidden="true" />}
      </button>
      {open && <QueuePop />}
    </div>
  );
}
