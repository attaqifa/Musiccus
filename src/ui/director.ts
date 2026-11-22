import { useRef } from 'react';
import type { Section, SectionName } from '../analysis/types';
import { getState, setSettings, type WorldId } from '../store/player';
import { useHub } from './hooks';

const BY_NAME: Partial<Record<SectionName, WorldId>> = {
  Intro: 'aurora',
  Verse: 'terrain',
  Chorus: 'nebula',
  Puncak: 'nebula',
  Bridge: 'stereo',
  Outro: 'aurora',
};
const BY_LABEL: WorldId[] = ['terrain', 'nebula', 'stereo', 'aurora'];

export const worldFor = (s: Section): WorldId => BY_NAME[s.name] ?? BY_LABEL[(s.label.charCodeAt(0) - 65) % BY_LABEL.length];

/** Worlds crossfade over 0.8 s, so the switch starts 0.4 s early and the blend is half way on the downbeat. */
const LEAD = 0.4;

/**
 * Auto Director: picks a world per section of the song. Because the
 * structure is known ahead of time, the cut is timed to land exactly on the
 * first beat of the new section.
 */
export function useDirector() {
  const handled = useRef(new Set<number>());
  const track = useRef('');

  useHub((s) => {
    const st = getState();
    const m = s.music;
    if (!st.settings.director || !m.ready) return;
    const id = st.now?.trackId ?? '';
    if (id !== track.current) {
      track.current = id;
      handled.current.clear();
    }
    const go = (sec: Section) => {
      handled.current.add(sec.t);
      const w = worldFor(sec);
      if (w !== st.settings.world) setSettings({ world: w });
    };
    if (m.nextSection && m.timeToNext > 0 && m.timeToNext < LEAD && !handled.current.has(m.nextSection.t)) {
      go(m.nextSection);
    } else if (m.section && !handled.current.has(m.section.t) && (!m.nextSection || m.timeToNext > LEAD)) {
      go(m.section);
    }
  });
}
