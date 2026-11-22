import { getAnalysis } from '../analysis/manager';
import { engine } from '../audio/engine';
import { getLive, useLive } from '../live/store';
import { hub } from '../audio/hub';
import { getState, usePlayer, type Settings } from '../store/player';
import { headphoneStage } from './headphone';
import { getStudio, useStudio } from './store';
import { moduleActive, playbackRate, studioProcessing, type StudioState } from './types';

/**
 * Loudness of the processed sound relative to the original, in dB, smoothed
 * over a few seconds of playback. "Dengar asli" plays the original at this
 * level, so the comparison is about the sound, not about which is louder.
 */
export const levels = { matchDb: 0, pre: 0, post: 0, age: 0 };

const headphoneOf = (s: Settings) => headphoneStage(s.headphone, s.headphoneOn, s.crossfeed);

/** The rack as heard: the listener's sound plus their headphone stage. */
function heardState(): StudioState {
  return { ...getStudio().state, headphone: headphoneOf(getState().settings) };
}

function apply() {
  const state = heardState();
  const compare = getStudio().compare;
  // Synced delays follow the tempo actually heard, after the tempo control.
  const live = getLive();
  // A captured tab always plays at its own speed.
  const base = live.on ? live.bpm : getAnalysis(getState().now?.trackId)?.bpm;
  const bpm = base ? base * (live.on ? 1 : playbackRate(state.pitch)) : undefined;
  void engine.applyStudio(state, { bpm, bypass: compare, matchDb: levels.matchDb });
}

useStudio.subscribe((s, prev) => {
  if (s.state !== prev.state) {
    // A new sound: measure again from scratch.
    levels.pre = levels.post = levels.age = 0;
    levels.matchDb = 0;
  }
  if (s.state !== prev.state || s.compare !== prev.compare) apply();
});
usePlayer.subscribe((s, p) => {
  const hp = s.settings.headphone !== p.settings.headphone || s.settings.headphoneOn !== p.settings.headphoneOn || s.settings.crossfeed !== p.settings.crossfeed;
  if (hp || s.now?.trackId !== p.now?.trackId || s.analysis !== p.analysis) apply();
  // Nothing to compare once playback stops or the song changes.
  if (getStudio().compare && (s.now?.trackId !== p.now?.trackId || s.status !== 'playing')) useStudio.setState({ compare: false });
});
useLive.subscribe((s, p) => {
  if (s.bpm !== p.bpm || s.on !== p.on) apply();
});
apply();

hub.addProcessor((snap) => {
  const studio = getStudio();
  const st = studio.state;

  if (snap.playing && !studio.compare && studioProcessing(st)) {
    const l = engine.studioLoudness();
    if (l && l.pre > 1e-9 && l.post > 1e-9) {
      // Settle quickly on a fresh sound, then average over ~2.5 s.
      levels.age += snap.dt;
      const k = 1 - Math.exp(-snap.dt / Math.min(2.5, 0.25 + levels.age));
      levels.pre += (l.pre - levels.pre) * k;
      levels.post += (l.post - levels.post) * k;
      const d = 10 * Math.log10(levels.post / levels.pre);
      if (Number.isFinite(d)) levels.matchDb = Math.max(-12, Math.min(12, d));
    }
  }

  // The effects reach the picture: the visuals read these, eased, from the snapshot.
  const on = !studio.compare;
  const fx = snap.fx;
  const target = {
    space: on && st.space.on ? Math.min(1, st.space.mix * 2 * Math.min(1.4, st.space.decay / 2.4)) : 0,
    drive: on && st.drive.on ? st.drive.amount * st.drive.mix : 0,
    width: on && moduleActive(st, 'stereo') ? Math.max(0, Math.min(1, (st.stereo.mono ? 0 : st.stereo.width) / 2)) : 0.5,
  };
  const k = 1 - Math.exp(-snap.dt / 0.3);
  fx.space += (target.space - fx.space) * k;
  fx.drive += (target.drive - fx.drive) * k;
  fx.width += (target.width - fx.width) * k;
});
