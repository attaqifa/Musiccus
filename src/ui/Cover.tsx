import { AppWindow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { readCover } from '../library/metadata';
import { getFile } from '../store/controller';
import { songLabel } from '../library/display';
import { getState } from '../store/player';

/**
 * Art for a song without a cover: its initial on a muted two-tone gradient whose
 * hue comes from the title, so each song keeps its own colour everywhere.
 */
function Monogram({ trackId, size }: { trackId: string; size: number }) {
  const t = getState().tracks[trackId];
  const title = t ? songLabel(t).title : '';
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const letter = (title.match(/[\p{L}\p{N}]/u)?.[0] ?? '♪').toUpperCase();
  return (
    <span
      className="cover-mono"
      aria-hidden="true"
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 20% 28%), hsl(${(hue + 40) % 360} 24% 13%))`,
        fontSize: Math.round(size * 0.5),
      }}
    >
      {letter}
    </span>
  );
}

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
        <Monogram trackId={trackId} size={size} />
      )}
    </div>
  );
}
