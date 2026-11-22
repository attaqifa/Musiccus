import { engine } from '../audio/engine';
import { hub, type Snapshot } from '../audio/hub';
import { readCover } from '../library/metadata';
import { getFile } from '../store/controller';
import { getState } from '../store/player';
import { stemActivity } from '../stems/manager';
import { useStudio } from '../studio/store';
import { heardSemitones } from '../studio/types';
import { chordsFor } from './chordView';
import { HOME, homePalette, keyAccent, monoPalette, musicPalette, paletteFromImage, PEARL, type CoverColours } from './color';
import { liveAnalyzer } from '../live/analyzer';
import { getAnalysis } from './manager';
import type { ChordSeg, KeyInfo, Palette, Rgb } from './types';

/** Key and chord as heard through the pitch shifter, so the colours follow the ear. */
function heard(key: KeyInfo, chord: ChordSeg | null): [KeyInfo, ChordSeg | null] {
  const n = heardSemitones(useStudio.getState().state.pitch);
  if (!n) return [key, chord];
  const up = (pc: number) => (pc + n + 120) % 12;
  return [{ ...key, tonic: up(key.tonic) }, chord && { ...chord, root: up(chord.root) }];
}

const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

/** Cover palettes, extracted once per track (null = no usable artwork). */
const covers = new Map<string, CoverColours | null | 'loading'>();

function coverColours(trackId: string): CoverColours | null {
  const hit = covers.get(trackId);
  if (hit === 'loading') return null;
  if (hit !== undefined) return hit;
  const track = getState().tracks[trackId];
  if (!track || track.synth || track.live) {
    covers.set(trackId, null);
    return null;
  }
  covers.set(trackId, 'loading');
  void readCover(trackId, () => getFile(track))
    .then((url) => (url ? paletteFromImage(url) : null))
    .then((c) => covers.set(trackId, c))
    .catch(() => covers.set(trackId, null));
  return null;
}

/** Index of the last element whose time is <= t, or -1. */
function lastAtOrBefore(n: number, timeAt: (i: number) => number, t: number): number {
  let lo = 0;
  let hi = n - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeAt(mid) <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

const smoothstep = (x: number) => {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
};

/**
 * The Conductor turns the offline analysis into a per-frame musical state:
 * where we are in the bar, which chord is sounding, what section comes next
 * and how close it is. Because the whole song is known in advance, visuals
 * can build up before a chorus instead of reacting after it starts.
 */
class Conductor {
  private lastBeat = -1;
  private lastTrack = '';
  /** The gliding palette. Kept here, not on the snapshot, so later processors can recolour a copy. */
  private pal: Palette | null = null;

  update(s: Snapshot) {
    const m = s.music;
    const pos = engine.position();
    const a = getAnalysis(pos?.id);
    const settings = getState().settings;
    // Home colour until a song's own colour is known; a playing song in the monochrome mode stays neutral.
    const mono = pos != null && settings.colorSource === 'mono';
    let target: Palette = mono ? monoPalette(s.now) : homePalette();
    let accent: Rgb = mono ? PEARL : HOME;
    // Stem activity is known for the whole song, so it can be read at the heard time exactly.
    m.stems = pos ? stemActivity(pos.id, pos.time) : null;

    if (pos?.live) {
      // A captured tab: no artwork, so "cover" falls back to the key's colours too.
      liveAnalyzer.fill(m, s, pos.time);
      if (m.key && settings.colorSource !== 'mono') {
        const [key] = heard(m.key, null);
        target = musicPalette(key, null, null);
        accent = keyAccent(key);
      }
    } else if (!pos || !a) {
      m.ready = false;
      m.beatPulse *= Math.exp(-s.dt * 6);
      m.downbeatPulse *= Math.exp(-s.dt * 6);
      m.anticipation *= Math.exp(-s.dt * 2);
      m.impact *= Math.exp(-s.dt * 2);
      m.chord = m.nextChord = null;
      m.section = m.nextSection = null;
      m.key = null;
      m.timeToNext = Infinity;
    } else {
      if (pos.id !== this.lastTrack) {
        this.lastTrack = pos.id;
        this.lastBeat = -1;
      }
      const t = pos.time;
      m.ready = true;
      m.trackTime = t;
      m.bpm = a.bpm;
      m.key = a.key;

      const beats = a.beats;
      const bi = lastAtOrBefore(beats.length, (i) => beats[i], t);
      m.beatIndex = bi;
      if (bi >= 0) {
        const period = 60 / Math.max(1, a.bpm);
        const next = bi + 1 < beats.length ? beats[bi + 1] : beats[bi] + period;
        m.beatPhase = Math.max(0, Math.min(1, (t - beats[bi]) / Math.max(0.05, next - beats[bi])));
        m.beatPulse = bi + 1 < beats.length || t - beats[bi] < period ? Math.exp(-(t - beats[bi]) * 9) : 0;
        const di = lastAtOrBefore(a.downbeats.length, (i) => a.downbeats[i], bi);
        m.barIndex = di;
        m.beatInBar = di >= 0 ? bi - a.downbeats[di] : bi % 4;
        const downTime = di >= 0 ? beats[a.downbeats[di]] : beats[bi];
        m.downbeatPulse = Math.exp(-(t - downTime) * 5);
        if (bi !== this.lastBeat) {
          if (this.lastBeat >= 0 && bi === this.lastBeat + 1) {
            m.beatCount++;
            if (m.beatInBar === 0) m.downbeatCount++;
          }
          this.lastBeat = bi;
        }
      } else {
        m.beatPhase = 0;
        m.beatPulse = 0;
        m.downbeatPulse = 0;
        m.barIndex = -1;
      }

      const chords = chordsFor(a, settings.chordView);
      const ci = lastAtOrBefore(chords.length, (i) => chords[i].t, t);
      const chord = ci >= 0 ? chords[ci] : null;
      m.chord = chord && t < chord.end ? chord : null;
      m.nextChord = chords[ci + 1] ?? null;

      const si = lastAtOrBefore(a.sections.length, (i) => a.sections[i].t, t);
      const sec = si >= 0 ? a.sections[si] : null;
      const nxt = a.sections[si + 1] ?? null;
      const prev = si > 0 ? a.sections[si - 1] : null;
      m.sectionIndex = si;
      m.section = sec;
      m.nextSection = nxt;
      m.timeToNext = nxt ? nxt.t - t : Infinity;

      // Build-up over the last four bars before a louder section.
      const lead = Math.max(4, Math.min(12, (16 * 60) / Math.max(1, a.bpm)));
      const rise = sec && nxt ? nxt.energy - sec.energy : 0;
      m.anticipation = rise > 0.18 ? smoothstep(1 - m.timeToNext / lead) * Math.min(1, rise * 2) : 0;
      const roseIn = sec && prev ? sec.energy - prev.energy : 0;
      m.impact = sec && roseIn > 0.18 ? Math.exp(-(t - sec.t) * 1.4) * Math.min(1, roseIn * 2) : 0;

      const ei = t * a.energyRate;
      const e0 = Math.floor(ei);
      const fr = ei - e0;
      m.energy = (a.energy[Math.min(a.energy.length - 1, e0)] ?? 0) * (1 - fr) + (a.energy[Math.min(a.energy.length - 1, e0 + 1)] ?? 0) * fr;

      if (settings.colorSource === 'music') {
        const [key, ch] = heard(a.key, m.chord);
        target = musicPalette(key, ch, m.section);
        accent = keyAccent(key);
      }
    }
    if (pos && !pos.live && settings.colorSource === 'cover') {
      const cover = coverColours(pos.id);
      if (cover) {
        target = cover.palette;
        accent = cover.accent;
      } else if (a) {
        // No artwork (or still loading): fall back to the key's colours.
        const [key, ch] = heard(a.key, m.chord);
        target = musicPalette(key, ch, m.section);
        accent = keyAccent(key);
      }
    }

    if (reducedMotion?.matches) {
      m.beatPulse = 0;
      m.downbeatPulse = 0;
      m.impact *= 0.3;
    }

    // Glide between palettes so chord changes tint rather than flash. The
    // UI accent moves slower still: it should drift, never blink.
    const k = 1 - Math.exp(-s.dt / 0.6);
    this.pal ??= { a: [...m.palette.a], b: [...m.palette.b], c: [...m.palette.c] };
    const p = this.pal;
    m.palette = p;
    for (const slot of ['a', 'b', 'c'] as const) {
      for (let i = 0; i < 3; i++) p[slot][i] += (target[slot][i] - p[slot][i]) * k;
    }
    const ka = 1 - Math.exp(-s.dt / 1.5);
    for (let i = 0; i < 3; i++) m.accent[i] += (accent[i] - m.accent[i]) * ka;
  }
}

export const conductor = new Conductor();
hub.addProcessor((s) => conductor.update(s));
