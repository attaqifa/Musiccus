/*
 * Turning levels into visual features that move with any master.
 *
 * A dynamic mix swings 20 dB or more, a loud commercial master only a few dB.
 * Measuring every band against a fixed window under its recent peak (the
 * old approach) left a loud master pinned near the top: the visuals saw
 * "loud" all the time and barely moved. These trackers also measure each
 * level against the song's own recent average and spread, so a master's few
 * dB of movement become its full range, while silence still reads as zero.
 */

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export class LevelTracker {
  private peak = -70;
  private mean = 0;
  private dev = 3;
  private seeded = false;
  /** Where the level sits in a 30 dB window under the recent peak (the old measure). */
  presence = 0;
  /** Distance from the recent average in units of the recent spread, 0.5 = average. */
  contrast = 0.5;

  /** Takes a level in dB and the frame time; returns the feature, 0..1. */
  update(db: number, dt: number): number {
    this.peak = Math.max(this.peak - 3 * dt, db, -70);
    this.presence = clamp01((db - (this.peak - 30)) / 30);
    // Silence must not drag the statistics down, or the next note looks huge.
    const x = Math.max(db, this.peak - 40);
    if (!this.seeded) {
      this.mean = x;
      this.seeded = true;
    }
    const a = 1 - Math.exp(-dt / 2.5);
    this.mean += (x - this.mean) * a;
    this.dev += (Math.abs(x - this.mean) - this.dev) * a;
    const z = (x - this.mean) / Math.max(this.dev, 1.2);
    this.contrast = clamp01(0.5 + z * 0.25);
    // A band that carries nothing stays dark, however its level wobbles.
    const gate = smoothstep(0.05, 0.35, this.presence);
    return clamp01(this.presence * 0.4 + this.contrast * 0.6 * gate);
  }
}

/**
 * Spectral flux, normalised the same way: how much the spectrum rose since
 * the last frame, compared with this song's usual amount of change. Returns
 * a pulse that jumps on a transient and decays in about 150 ms, so dense
 * mixes still light up on their hits even when the onset detector is unsure.
 */
export class FluxTracker {
  private prev: Float32Array;
  private mean = 0;
  private dev = 0.5;
  private level = 0;

  constructor(n: number) {
    this.prev = new Float32Array(n).fill(-120);
  }

  update(db: ArrayLike<number>, dt: number): number {
    let flux = 0;
    for (let j = 0; j < this.prev.length; j++) {
      const d = db[j] - this.prev[j];
      if (d > 0) flux += Math.min(d, 24);
      this.prev[j] = db[j];
    }
    flux /= this.prev.length;
    const a = 1 - Math.exp(-dt / 1.5);
    this.mean += (flux - this.mean) * a;
    this.dev += (Math.abs(flux - this.mean) - this.dev) * a;
    const z = (flux - this.mean) / Math.max(this.dev, 0.05);
    this.level = Math.max(clamp01((z - 0.8) / 2.5), this.level * Math.exp(-dt * 7));
    return this.level;
  }

  reset() {
    this.prev.fill(-120);
    this.level = 0;
  }
}
