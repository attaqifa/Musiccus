import { LoaderCircle, Minus, Plus, RefreshCw, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { formatTime } from '../lib/format';
import { search, type LrclibHit } from '../lyrics/lrclib';
import { chooseHit, lineAt, nudgeOffset, offsetFor, reloadLyrics, searchText, syncLiveLine, useLyrics, type Lyrics, type LyricLine } from '../lyrics/lyrics';
import { useStems } from '../stems/store';
import { seek } from '../store/controller';
import { setSettings, setUi, usePlayer } from '../store/player';
import { cls, useHub, useHubValue } from './hooks';
import { lyricTime, offsetText, wordAt } from './LyricsOverlay';

const SOURCE: Record<Lyrics['source'], string> = {
  lrc: 'File .lrc di samping lagu',
  tag: 'Tersimpan di dalam file lagu',
  drop: 'File .lrc yang Anda tambahkan',
  lrclib: 'LRCLIB',
};

function LyricsSearch({ nowId, onDone, focus = true }: { nowId: string; onDone: () => void; focus?: boolean }) {
  const [q, setQ] = useState(() => searchText(nowId));
  const [hits, setHits] = useState<LrclibHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus) input.current?.select();
  }, [focus]);

  const run = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    setErr('');
    try {
      setHits(await search(q));
    } catch {
      setErr('LRCLIB tidak bisa dihubungi. Periksa koneksi internet, lalu coba lagi.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lp-search">
      <form onSubmit={(e) => void run(e)} role="search">
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Artis dan judul lagu" aria-label="Cari lirik" />
        <button className="btn small" disabled={busy || !q.trim()}>
          {busy ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Search size={14} aria-hidden="true" />}
          Cari
        </button>
      </form>
      {err && <p className="empty-note">{err}</p>}
      {hits && !hits.length && <p className="empty-note">Tidak ada hasil. Coba tulis judulnya saja, atau ejaan lain.</p>}
      {hits && hits.length > 0 && (
        <ul className="lp-hits">
          {hits.map((h) => (
            <li key={h.id}>
              <button
                onClick={() => {
                  void chooseHit(h);
                  onDone();
                }}
              >
                <span className="lp-hit-title">{h.trackName}</span>
                <span className="lp-hit-sub">
                  {[h.artistName, h.albumName].filter(Boolean).join(' · ')} · {formatTime(h.duration)}
                </span>
                <span className={cls('lp-hit-kind', h.syncedLyrics && 'synced')}>{h.syncedLyrics ? 'Ikut lagu' : 'Teks saja'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Line({ line, cur, word }: { line: LyricLine; cur: boolean; word: number }) {
  if (!line.words || !cur) return <>{line.text || '♪'}</>;
  return (
    <>
      {line.words.map((w, i) => (
        <span key={i} className={i < word ? 'sung' : i === word ? 'now' : undefined}>
          {w.text}
        </span>
      ))}
    </>
  );
}

/** Synced lines, scrolling with the song; the current word fills as it is sung. Click a line to jump there. */
function SyncedLines({ nowId, lines, scroller }: { nowId: string; lines: LyricLine[]; scroller: React.RefObject<HTMLElement | null> }) {
  const offset = useLyrics((s) => offsetFor(s, nowId));
  // A tab cannot be seeked: clicking a line says "this one is being sung now" instead.
  const live = usePlayer((s) => !!s.tracks[nowId]?.live);
  const list = useRef<HTMLOListElement>(null);
  const userAt = useRef(0);

  const step = useHubValue(() => {
    const t = lyricTime(offset);
    const i = lineAt(lines, t + 0.12);
    return i < 0 ? -1 : i * 4096 + wordAt(lines[i], t + 0.04) + 1;
  });
  const idx = step < 0 ? -1 : Math.floor(step / 4096);
  const word = step < 0 ? -1 : (step % 4096) - 1;

  // How far into the current word the voice is, for the fill.
  useHub(() => {
    const el = list.current?.querySelector<HTMLElement>('.cur .now');
    const w = lines[idx]?.words;
    if (!el || !w || word < 0) return;
    const t = lyricTime(offset);
    const end = w[word + 1]?.t ?? Math.min(w[word].t + 0.6, lines[idx + 1]?.t ?? Infinity);
    el.style.setProperty('--p', Math.max(0, Math.min(1, (t - w[word].t) / Math.max(0.05, end - w[word].t))).toFixed(3));
  });

  useEffect(() => {
    const box = scroller.current;
    const li = list.current?.children[Math.max(0, idx)] as HTMLElement | undefined;
    // Scrolling by hand pauses the follow for a few seconds.
    if (!box || !li || performance.now() - userAt.current < 3500) return;
    box.scrollTo({ top: li.offsetTop - box.clientHeight * 0.36, behavior: 'smooth' });
  }, [idx, scroller]);

  const touched = () => void (userAt.current = performance.now());
  return (
    <ol className="lp-lines" ref={list} onWheel={touched} onTouchMove={touched}>
      {lines.map((l, i) => (
        <li key={i} className={cls(i < idx && 'past', i === idx && 'cur', !l.text && 'gap')}>
          <button
            onClick={() => (live ? syncLiveLine(l) : seek(Math.max(0, l.t + offset - 0.15)))}
            title={live ? 'Klik saat baris ini mulai dinyanyikan' : `Lompat ke ${formatTime(Math.max(0, l.t + offset))}`}
          >
            <Line line={l} cur={i === idx} word={word} />
          </button>
        </li>
      ))}
    </ol>
  );
}

/** The right panel in Dengar mode: lyrics that follow the song, karaoke style. */
export function LyricsPanel() {
  const nowId = usePlayer((s) => s.now?.trackId);
  const online = usePlayer((s) => s.settings.lyricsOnline);
  const synth = usePlayer((s) => (s.now ? !!s.tracks[s.now.trackId]?.synth : false));
  const live = usePlayer((s) => (s.now ? !!s.tracks[s.now.trackId]?.live : false));
  const lyrics = useLyrics((s) => (nowId ? s.byTrack[nowId] : undefined));
  const timed = useLyrics((s) => (nowId ? s.timed[nowId] : undefined));
  const state = useLyrics((s) => (nowId ? s.state[nowId] : undefined));
  const offset = useLyrics((s) => (nowId ? offsetFor(s, nowId) : 0));
  const separated = useStems((s) => (nowId ? s.status[nowId]?.state === 'ready' && s.status[nowId]?.engine === 'ai' : false));
  const [searching, setSearching] = useState(false);
  const scroller = useRef<HTMLElement>(null);

  useEffect(() => setSearching(false), [nowId]);

  let body;
  if (!nowId) {
    body = <p className="empty-note pad">Putar lagu, dan liriknya muncul di sini, mengikuti setiap kata.</p>;
  } else if (synth) {
    body = <p className="empty-note pad">Lagu demo ini instrumental, jadi tidak punya lirik. Putar lagu Anda sendiri untuk melihat liriknya mengikuti setiap kata.</p>;
  } else if (state === 'loading' || (lyrics === undefined && state !== 'error')) {
    body = (
      <p className="empty-note pad lp-status">
        <LoaderCircle size={14} className="spin" aria-hidden="true" /> Mencari lirik…
      </p>
    );
  } else if (state === 'error') {
    body = (
      <div className="pad">
        <p className="empty-note">LRCLIB tidak bisa dihubungi, jadi lirik belum bisa dicari. Periksa koneksi internet.</p>
        <button className="btn small" onClick={reloadLyrics}>
          <RefreshCw size={14} aria-hidden="true" /> Coba lagi
        </button>
      </div>
    );
  } else if (!lyrics && live && online) {
    body = (
      <>
        <p className="lp-note">Ketik judul lagu yang sedang diputar di tab, lalu pilih liriknya.</p>
        {!searching && <LyricsSearch nowId={nowId} onDone={() => undefined} focus={false} />}
      </>
    );
  } else if (!lyrics) {
    body = (
      <div className="pad">
        <p className="empty-note">
          {online
            ? 'Lirik lagu ini belum ketemu. Cari dengan judul lain, atau jatuhkan file .lrc ke jendela ini.'
            : 'Lagu ini tidak membawa lirik, dan pencarian lirik online sedang mati.'}
        </p>
        <div className="lp-empty-actions">
          {online ? (
            <button className="btn small" onClick={() => setSearching(true)}>
              <Search size={14} aria-hidden="true" /> Cari lirik
            </button>
          ) : (
            <button className="btn small" onClick={() => setSettings({ lyricsOnline: true })}>
              Aktifkan pencarian lirik
            </button>
          )}
        </div>
      </div>
    );
  } else if (!lyrics.synced) {
    body = (
      <>
        <p className="lp-note">Lirik ini belum bertanda waktu, jadi belum bisa mengikuti lagu. Cari versi lain yang bertanda “Ikut lagu”.</p>
        <ol className="lp-lines plain">
          {lyrics.lines.map((l, i) => (
            <li key={i} className={cls(!l.text && 'gap')}>
              {l.text}
            </li>
          ))}
        </ol>
      </>
    );
  } else if (timed) {
    body = (
      <>
        {live && <p className="lp-note">Belum pas dengan lagu di tab? Klik baris yang sedang dinyanyikan.</p>}
        <SyncedLines nowId={nowId} lines={timed} scroller={scroller} />
      </>
    );
  }

  const estimated = !!timed?.some((l) => l.estimated);
  return (
    <aside className="inspector lyrics-panel panel" aria-label="Lirik" ref={scroller}>
      <div className="lp-head">
        <div className="lp-title">
          <span>Lirik</span>
          {lyrics && <small>{SOURCE[lyrics.source]}</small>}
        </div>
        <div className="lp-actions">
          {lyrics?.synced && nowId && (
            <div className="lp-offset" role="group" aria-label="Koreksi waktu lirik" title="Geser kalau lirik terasa mendahului atau terlambat">
              <button className="icon-btn" onClick={() => nudgeOffset(nowId, -0.1)} aria-label="Lirik lebih awal 0,1 detik">
                <Minus size={13} />
              </button>
              <span>{offsetText(offset)}</span>
              <button className="icon-btn" onClick={() => nudgeOffset(nowId, 0.1)} aria-label="Lirik lebih lambat 0,1 detik">
                <Plus size={13} />
              </button>
            </div>
          )}
          {nowId && online && !synth && (
            <button
              className={cls('icon-btn', searching && 'on')}
              onClick={() => setSearching(!searching)}
              aria-pressed={searching}
              aria-label="Cari lirik lain"
              title="Lirik salah atau tidak pas? Cari versi lain"
            >
              {searching ? <X size={16} /> : <Search size={16} />}
            </button>
          )}
          <button className="icon-btn lp-close" onClick={() => setUi({ inspector: false })} aria-label="Tutup panel lirik" title="Tutup: lirik pindah ke atas visual (I)">
            <X size={16} />
          </button>
        </div>
      </div>
      {searching && nowId && <LyricsSearch nowId={nowId} onDone={() => setSearching(false)} />}
      {body}
      {lyrics && (
        <p className="lp-foot">
          {lyrics.source === 'lrclib' && (
            <>
              Lirik dari{' '}
              <a className="link" href="https://lrclib.net" target="_blank" rel="noreferrer">
                LRCLIB
              </a>
              .{' '}
            </>
          )}
          {estimated && 'Waktu per kata diperkirakan dari irama lagu'}
          {estimated && (separated ? ' dan suara vokal.' : ' (lebih tepat setelah vokal dipisahkan dengan AI di mode Stem).')}
        </p>
      )}
    </aside>
  );
}
