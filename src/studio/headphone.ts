import { get, set } from 'idb-keyval';
import type { HpFilter, StudioState } from './types';

/**
 * "Headphone saya": a correction curve for the listener's own headphones,
 * taken from the AutoEQ project (measurements by oratory1990, crinacle,
 * Rtings and others). Only the public list of models and the chosen model's
 * profile are downloaded; what the listener types never leaves the browser.
 */

export interface HeadphoneHit {
  name: string;
  /** Folder under results/, as written in AutoEQ's index (partly URL-encoded). */
  path: string;
  source: string;
  kind: 'earphone' | 'headphone';
}

export interface HeadphoneProfile {
  name: string;
  kind: HeadphoneHit['kind'];
  source: string;
  preamp: number;
  filters: HpFilter[];
}

const BASE = 'https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/';
const INDEX_KEY = 'autoeq:index';
const MAX_AGE = 30 * 24 * 3600 * 1000;

// Several labs measured the same models; prefer the most trusted ones.
const RANK = ['oratory1990', 'crinacle', 'Rtings', 'Innerfidelity', 'Super Review', 'Headphone.com Legacy'];
const rank = (source: string) => {
  const i = RANK.indexOf(source);
  return i < 0 ? RANK.length : i;
};

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Parses AutoEQ's results/INDEX.md: `- [Name](./source/rig/Name) by source on rig`. */
export function parseIndex(text: string): HeadphoneHit[] {
  const best = new Map<string, HeadphoneHit>();
  for (const line of text.split('\n')) {
    if (!line.startsWith('- [')) continue;
    const i = line.indexOf('](./');
    if (i < 0) continue;
    const rest = line.slice(i + 4);
    const j = rest.lastIndexOf(') by ');
    if (j < 0) continue;
    const hit: HeadphoneHit = {
      name: line.slice(3, i),
      path: rest.slice(0, j),
      source: rest.slice(j + 5).split(' on ')[0].trim(),
      kind: /in-ear|earbud/i.test(rest.slice(0, j)) ? 'earphone' : 'headphone',
    };
    // "HD 600 (2020)" and "HD600 (2020)" are the same model.
    const key = compact(hit.name);
    const old = best.get(key);
    if (!old || rank(hit.source) < rank(old.source)) best.set(key, hit);
  }
  return [...best.values()];
}

let index: Promise<HeadphoneHit[]> | null = null;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** The list of measured models, cached for a month. */
export function loadIndex(): Promise<HeadphoneHit[]> {
  index ??= (async () => {
    const cached = await get<{ at: number; text: string }>(INDEX_KEY).catch(() => undefined);
    if (cached && Date.now() - cached.at < MAX_AGE) return parseIndex(cached.text);
    try {
      const text = await fetchText(`${BASE}INDEX.md`);
      void set(INDEX_KEY, { at: Date.now(), text }).catch(() => undefined);
      return parseIndex(text);
    } catch (e) {
      if (cached) return parseIndex(cached.text);
      throw new Error('Daftar headphone tidak bisa dimuat. Periksa koneksi internet, lalu coba lagi.', { cause: e });
    }
  })();
  index.catch(() => {
    index = null;
  });
  return index;
}

/** Models whose name contains every word typed, closest first. */
export function searchHeadphones(list: HeadphoneHit[], query: string, limit = 8): HeadphoneHit[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return [];
  const whole = compact(query);
  const scored: { hit: HeadphoneHit; score: number }[] = [];
  for (const hit of list) {
    const name = compact(hit.name);
    if (!words.every((w) => name.includes(w))) continue;
    // "hd 600" should find Sennheiser HD 600 before Denon AH-D600: prefer
    // names where every typed word starts a word of the model name.
    const parts = hit.name.toLowerCase().split(/[^a-z0-9]+/);
    const atWords = words.every((w) => parts.some((p) => p.startsWith(w)));
    const score = (name.startsWith(whole) ? 0 : 2000) + (atWords ? 0 : 1000) + name.length;
    scored.push({ hit, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.hit);
}

const TYPES: Record<string, HpFilter['type']> = {
  PK: 'peaking',
  PEQ: 'peaking',
  LSC: 'lowshelf',
  LS: 'lowshelf',
  HSC: 'highshelf',
  HS: 'highshelf',
};

/**
 * Parses AutoEQ / Equalizer APO "ParametricEQ.txt":
 *   Preamp: -6.2 dB
 *   Filter 1: ON PK Fc 105 Hz Gain -3.5 dB Q 0.70
 */
export function parseParametricEq(text: string): { preamp: number; filters: HpFilter[] } {
  let preamp = 0;
  const filters: HpFilter[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const pre = /^preamp:\s*(-?[\d.]+)\s*db/i.exec(line);
    if (pre) {
      preamp = parseFloat(pre[1]);
      continue;
    }
    const m = /^filter\s*\d*:\s*on\s+([a-z]+)\s+fc\s+([\d.]+)\s*hz(?:\s+gain\s+(-?[\d.]+)\s*db)?(?:\s+q\s+([\d.]+))?/i.exec(line);
    if (!m) continue;
    const type = TYPES[m[1].toUpperCase()];
    if (!type) continue;
    filters.push({
      type,
      freq: parseFloat(m[2]),
      gain: m[3] !== undefined ? parseFloat(m[3]) : 0,
      q: m[4] !== undefined ? parseFloat(m[4]) : 0.71,
    });
  }
  return { preamp, filters: filters.slice(0, 16) };
}

/** Downloads one model's correction. */
export async function loadProfile(hit: HeadphoneHit): Promise<HeadphoneProfile> {
  const folder = hit.path.split('/').pop() ?? '';
  const file = encodeURIComponent(`${decodeURIComponent(folder)} ParametricEQ.txt`);
  let text: string;
  try {
    text = await fetchText(`${BASE}${hit.path}/${file}`);
  } catch (e) {
    throw new Error(`Profil ${hit.name} tidak bisa diunduh. Coba lagi sebentar lagi.`, { cause: e });
  }
  const eq = parseParametricEq(text);
  if (eq.filters.length === 0) throw new Error(`Profil ${hit.name} kosong atau formatnya tidak dikenal.`);
  return { name: hit.name, kind: hit.kind, source: hit.source, ...eq };
}

/** How strongly the crossfeed switch blends the channels (0..1 of the rack's range). */
const CROSSFEED = 0.7;

/** The rack's headphone stage for the listener's settings. */
export function headphoneStage(profile: HeadphoneProfile | null, on: boolean, crossfeed: boolean): StudioState['headphone'] {
  const eq = on && profile;
  return {
    on: !!eq || crossfeed,
    profile: eq ? profile.name : '',
    preamp: eq ? profile.preamp : 0,
    filters: eq ? profile.filters : [],
    crossfeed: crossfeed ? CROSSFEED : 0,
  };
}
