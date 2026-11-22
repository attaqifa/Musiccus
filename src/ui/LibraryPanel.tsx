import { AppWindow, FilePlus, FolderOpen, ListPlus, Orbit, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { formatTime } from '../lib/format';
import { shortFormat, tierOf } from '../library/metadata';
import { tabCaptureSupported } from '../live/tab';
import { enqueue, folderOf, listenToTab, playQueue } from '../store/controller';
import { setUi, usePlayer, type Track } from '../store/player';
import { Cover } from './Cover';
import { cls } from './hooks';
import { pickFiles, pickFolder } from './pickers';
import { TrackMenu, type MenuTarget } from './TrackMenu';

type Row =
  | { kind: 'album'; key: string; title: string; artist: string; year?: number; firstId: string; firstQi: number; ids: string[] }
  | { kind: 'track'; id: string; qi: number };

const ALBUM_H = 64;
const TRACK_H = 34;
const OVERSCAN = 300;

const albumKey = (t: Track) =>
  `${t.meta?.albumArtist || t.meta?.artist || ''}␟${t.meta?.album || folderOf(t.path) || 'Tanpa album'}`;

function matches(t: Track, q: string) {
  if (!q) return true;
  const m = t.meta;
  return [m?.title, m?.artist, m?.album, m?.albumArtist, t.path].some((v) => v?.toLowerCase().includes(q));
}

function NowBars() {
  return (
    <span className="now-bars" aria-label="Sedang diputar">
      <i />
      <i />
      <i />
    </span>
  );
}

export function LibraryPanel() {
  const canTab = tabCaptureSupported();
  const tracks = usePlayer((s) => s.tracks);
  const order = usePlayer((s) => s.order);
  const name = usePlayer((s) => s.libraryName);
  const scanning = usePlayer((s) => s.scanning);
  const scanFound = usePlayer((s) => s.scanFound);
  const pending = usePlayer((s) => s.order.reduce((n, id) => n + (s.tracks[id]?.metaState === 'pending' ? 1 : 0), 0));
  const nowId = usePlayer((s) => s.now?.trackId);
  const status = usePlayer((s) => s.status);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const { rows, offsets, total, queue } = useMemo(() => {
    const rows: Row[] = [];
    const queue: string[] = [];
    let lastKey = '';
    let albumRow: Extract<Row, { kind: 'album' }> | null = null;
    for (const id of order) {
      const t = tracks[id];
      if (!t || !matches(t, q)) continue;
      const key = albumKey(t);
      if (key !== lastKey) {
        albumRow = {
          kind: 'album',
          key,
          title: t.meta?.album || folderOf(t.path) || 'Tanpa album',
          artist: t.meta?.albumArtist || t.meta?.artist || 'Artis tidak diketahui',
          year: t.meta?.year,
          firstId: id,
          firstQi: queue.length,
          ids: [],
        };
        rows.push(albumRow);
        lastKey = key;
      }
      if (albumRow && !t.needsWasm) albumRow.ids.push(id);
      rows.push({ kind: 'track', id, qi: queue.length });
      queue.push(id);
    }
    const offsets = new Float64Array(rows.length + 1);
    for (let i = 0; i < rows.length; i++) offsets[i + 1] = offsets[i] + (rows[i].kind === 'album' ? ALBUM_H : TRACK_H);
    return { rows, offsets, total: offsets[rows.length], queue };
  }, [order, tracks, q]);

  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView((v) => ({ ...v, height: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  let lo = 0;
  let hi = rows.length;
  const from = Math.max(0, view.top - OVERSCAN);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] < from) lo = mid + 1;
    else hi = mid;
  }
  const visible: number[] = [];
  for (let i = lo; i < rows.length && offsets[i] < view.top + view.height + OVERSCAN; i++) visible.push(i);

  const play = (qi: number) => void playQueue(queue, qi);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const openMenu = (e: MouseEvent<HTMLElement>, target: Omit<MenuTarget, 'x' | 'y' | 'from'>) => {
    e.preventDefault();
    const from = e.currentTarget;
    // The Menu key and Shift+F10 carry no pointer position: open by the row.
    const keyboard = (e.nativeEvent as PointerEvent).pointerType === '' || (e.clientX === 0 && e.clientY === 0);
    const r = from.getBoundingClientRect();
    setMenu({ ...target, from, x: keyboard ? r.left + 24 : e.clientX, y: keyboard ? r.bottom : e.clientY });
  };
  const total0 = order.length;
  const parsing = pending > 0 && !scanning;

  return (
    <aside className="library panel" aria-label="Library">
      <div className="lib-head">
        <div className="lib-title">
          <span className="lib-name">{name ?? 'Koleksi'}</span>
          <span className="lib-count">{total0.toLocaleString('id-ID')} lagu</span>
        </div>
        <div className="lib-actions">
          <button className="icon-btn" onClick={() => setUi({ sonicMap: !usePlayer.getState().ui.sonicMap })} aria-label="Peta koleksi (G)" title="Peta koleksi: galaksi lagu menurut energi, suasana, dan kunci (G)">
            <Orbit size={16} />
          </button>
          {canTab && (
            <button className="icon-btn" onClick={() => void listenToTab()} aria-label="Dengar dari tab" title="Dengar dari tab: Spotify, YouTube Music, atau situs musik lain">
              <AppWindow size={16} />
            </button>
          )}
          <button className="icon-btn" onClick={pickFolder} aria-label="Buka folder musik" title="Buka folder musik">
            <FolderOpen size={16} />
          </button>
          <button className="icon-btn" onClick={() => pickFiles(false)} aria-label="Tambah file" title="Tambah file">
            <FilePlus size={16} />
          </button>
        </div>
      </div>
      <label className="lib-search">
        <Search size={14} aria-hidden="true" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Cari judul, artis, album"
          aria-label="Cari di library"
          spellCheck={false}
        />
        {query && (
          <button className="clear" onClick={() => setQuery('')} aria-label="Hapus pencarian">
            <X size={13} />
          </button>
        )}
      </label>
      {(scanning || parsing) && (
        <div className="lib-progress" role="status">
          <span>{scanning ? `Memindai… ${scanFound} file` : `Membaca metadata ${total0 - pending}/${total0}`}</span>
          <div className="bar">
            <i style={{ width: scanning ? '30%' : `${((total0 - pending) / Math.max(1, total0)) * 100}%` }} className={scanning ? 'indeterminate' : ''} />
          </div>
        </div>
      )}
      <div className="lib-scroll" ref={scroller} onScroll={(e) => setView((v) => ({ ...v, top: e.currentTarget.scrollTop }))}>
        {rows.length === 0 && q && <p className="empty-note">Tidak ada yang cocok dengan “{query}”.</p>}
        <div style={{ height: total, position: 'relative' }} role="list">
          {visible.map((i) => {
            const r = rows[i];
            const top = offsets[i];
            if (r.kind === 'album') {
              return (
                <div
                  key={`a:${r.key}:${i}`}
                  className="lib-album"
                  style={{ top, height: ALBUM_H }}
                  role="presentation"
                  onContextMenu={(e) => r.ids.length && openMenu(e, { ids: r.ids, play: () => play(r.firstQi), album: true })}
                >
                  <Cover trackId={r.firstId} size={44} />
                  <div className="la-text">
                    <span className="la-title">{r.title}</span>
                    <span className="la-sub">
                      {r.artist}
                      {r.year ? ` · ${r.year}` : ''}
                    </span>
                  </div>
                  {r.ids.length > 0 && (
                    <button
                      className="row-add"
                      tabIndex={-1}
                      onClick={() => enqueue(r.ids, 'end')}
                      aria-label={`Tambah album “${r.title}” ke antrean`}
                      title="Tambah album ke antrean (klik kanan untuk pilihan lain)"
                    >
                      <ListPlus size={15} />
                    </button>
                  )}
                </div>
              );
            }
            const t = tracks[r.id];
            const m = t.meta;
            const isNow = nowId === t.id;
            const tier = tierOf(m);
            return (
              <div
                key={t.id}
                role="listitem"
                tabIndex={0}
                className={cls('lib-track', isNow && 'now', t.needsWasm && 'unsupported')}
                style={{ top, height: TRACK_H }}
                onClick={() => play(r.qi)}
                onContextMenu={(e) => !t.needsWasm && openMenu(e, { ids: [t.id], play: () => play(r.qi) })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.stopPropagation();
                    play(r.qi);
                  }
                }}
                title={t.needsWasm ? `Format ${t.ext.toUpperCase()} belum bisa diputar di Musiccus` : 'Klik atau Enter untuk memutar, klik kanan untuk antrean'}
              >
                <span className="lt-no">
                  {isNow && status === 'playing' ? <NowBars /> : (m?.trackNo ?? '·')}
                </span>
                <span className="lt-title">{m?.title || t.name.replace(/\.[^.]+$/, '')}</span>
                <span className={cls('lt-fmt', `tier-${tier}`)}>{t.needsWasm ? t.ext.toUpperCase() : shortFormat(m, t.ext)}</span>
                <span className="lt-dur">{m?.duration ? formatTime(m.duration) : ''}</span>
                {!t.needsWasm && (
                  <button
                    className="row-add"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      enqueue([t.id], 'end');
                    }}
                    aria-label="Tambah ke antrean"
                    title="Tambah ke antrean (klik kanan untuk pilihan lain)"
                  >
                    <ListPlus size={15} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {menu && <TrackMenu target={menu} onClose={closeMenu} />}
    </aside>
  );
}
