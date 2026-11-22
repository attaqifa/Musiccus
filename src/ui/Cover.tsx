import { AppWindow, Disc3 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { readCover } from '../library/metadata';
import { getFile } from '../store/controller';
import { getState } from '../store/player';

/** Album art loaded lazily from the file's tags, cached by key. */
export function Cover({ trackId, size, className }: { trackId: string; size: number; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    const t = getState().tracks[trackId];
    if (!t || t.synth || t.live) return;
    void readCover(trackId, () => getFile(t)).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [trackId]);

  return (
    <div className={`cover ${className ?? ''}`} style={{ width: size, height: size }}>
      {url ? (
        <img src={url} alt="" draggable={false} />
      ) : getState().tracks[trackId]?.live ? (
        <AppWindow size={Math.round(size * 0.42)} aria-hidden="true" />
      ) : (
        <Disc3 size={Math.round(size * 0.42)} aria-hidden="true" />
      )}
    </div>
  );
}
