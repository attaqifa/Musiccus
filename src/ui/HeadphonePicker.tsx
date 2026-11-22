import { LoaderCircle, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { setSettings, toast, usePlayer } from '../store/player';
import { loadIndex, loadProfile, searchHeadphones, type HeadphoneHit } from '../studio/headphone';

const KIND = { earphone: 'Earphone', headphone: 'Headphone' } as const;

/** Find the listener's headphones in the AutoEQ list and load their correction. */
export function HeadphonePicker() {
  const profile = usePlayer((s) => s.settings.headphone);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [list, setList] = useState<HeadphoneHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const hits = useMemo(() => (list ? searchHeadphones(list, query) : []), [list, query]);

  const ensureList = () => {
    if (list || loading) return;
    setLoading(true);
    setError('');
    loadIndex().then(
      (l) => {
        setList(l);
        setLoading(false);
      },
      (e: Error) => {
        setError(e.message);
        setLoading(false);
      },
    );
  };

  const pick = async (hit: HeadphoneHit) => {
    setBusy(hit.name);
    setError('');
    try {
      const p = await loadProfile(hit);
      setSettings({ headphone: p, headphoneOn: true });
      setSearching(false);
      setQuery('');
      toast(`Suara disesuaikan untuk ${p.name}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (profile && !searching) {
    return (
      <div className="hp-current">
        <div className="hp-name">
          <b>{profile.name}</b>
          <small>
            {KIND[profile.kind]} · diukur oleh {profile.source}
          </small>
        </div>
        <div className="hp-actions">
          <button
            className="btn small ghost"
            onClick={() => {
              setSearching(true);
              ensureList();
            }}
          >
            Ganti
          </button>
          <button className="btn small ghost" onClick={() => setSettings({ headphone: null })}>
            Hapus
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="hp-search">
      <label className="hp-input">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder="Ketik model, mis. Sony WH-1000XM4"
          aria-label="Cari model headphone atau earphone"
          onFocus={ensureList}
          onChange={(e) => {
            setQuery(e.target.value);
            ensureList();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && hits[0]) void pick(hits[0]);
            if (e.key === 'Escape' && profile) setSearching(false);
          }}
        />
      </label>
      {loading && (
        <p className="hp-note">
          <LoaderCircle size={13} className="spin" aria-hidden="true" /> Memuat daftar model…
        </p>
      )}
      {error && (
        <p className="hp-note error" role="alert">
          {error}
        </p>
      )}
      {list && query.trim().length >= 2 && hits.length === 0 && (
        <p className="hp-note">Tidak ketemu. Coba merek dan serinya saja, misalnya "Sony XM4" atau "AirPods Pro".</p>
      )}
      {hits.length > 0 && (
        <ul className="hp-hits" aria-label="Hasil pencarian headphone">
          {hits.map((h) => (
            <li key={h.name}>
              <button onClick={() => void pick(h)} disabled={!!busy}>
                <span className="hp-hit-name">{h.name}</span>
                <span className="hp-hit-kind">{busy === h.name ? 'Memuat…' : KIND[h.kind]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {profile && (
        <button className="btn small ghost" onClick={() => setSearching(false)}>
          Batal
        </button>
      )}
    </div>
  );
}
