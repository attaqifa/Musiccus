import { create } from 'zustand';
import type { ChordSeg, KeyInfo } from '../analysis/types';

/** The track id a captured tab plays under. */
export const LIVE_ID = 'live:tab';

export interface LiveState {
  /** A browser tab is being captured. */
  on: boolean;
  /**
   * Musiccus plays the tab's sound (the tab itself is muted). Off when the
   * browser kept the tab audible: then only the visuals follow it.
   */
  monitor: boolean;
  /** Sample rate of the captured sound. */
  rate: number;
  /** No sound right now: the tab paused, or one song ended. */
  silent: boolean;
  /** Tempo of the current stretch of sound, once analysed. */
  bpm: number | null;
  key: KeyInfo | null;
  /** Chords of the last half minute, oldest first, on the live clock. */
  chords: ChordSeg[];
  /** Live-clock time the current stretch of sound began (after a silence). */
  songStart: number;
  /** Analyses finished in the current stretch. */
  rounds: number;
}

const IDLE: LiveState = {
  on: false,
  monitor: true,
  rate: 0,
  silent: false,
  bpm: null,
  key: null,
  chords: [],
  songStart: 0,
  rounds: 0,
};

export const useLive = create<LiveState>(() => ({ ...IDLE }));

export const getLive = useLive.getState;

export const resetLive = (patch: Partial<LiveState> = {}) => useLive.setState({ ...IDLE, ...patch });
