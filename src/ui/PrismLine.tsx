import { useAnalysis } from '../analysis/manager';
import { fifthsIndex, PRISM, rgbCss } from '../analysis/theory';
import { usePlayer } from '../store/player';
import { useStudio } from '../studio/store';
import { heardSemitones } from '../studio/types';

const KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'D♭', 'A♭', 'E♭', 'B♭', 'F'];

/**
 * The Graphite Prism signature: the twelve keys around the circle of fifths
 * as a hairline, with the key you hear lit (pitch shift moves it). Decorative,
 * never interactive.
 */
export function PrismLine() {
  const nowId = usePlayer((s) => s.now?.trackId);
  const { analysis } = useAnalysis(nowId);
  const shift = useStudio((s) => heardSemitones(s.state.pitch));
  const key = analysis?.key;
  const active = key ? fifthsIndex((key.tonic + (key.mode === 'major' ? 0 : 3) + shift + 120) % 12) : -1;
  return (
    <div className="prism-line" aria-hidden="true">
      {PRISM.map((c, i) => (
        <i key={KEYS[i]} className={i === active ? 'on' : undefined} style={{ background: rgbCss(c) }} />
      ))}
    </div>
  );
}
