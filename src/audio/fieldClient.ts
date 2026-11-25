/*
 * The main thread's side of the field analysis: hands the newest stereo
 * samples to field.worker.ts at most FIELD_HZ times a second, and keeps the
 * results on the context clock so the hub can show the one being heard.
 */
import { emptyField, FIELD_PACKED, unpackField, type MixField } from './field';
import type { FieldIn, FieldOut } from './field.worker';

/** Analyses per second, at most. */
const FIELD_HZ = 60;
/** Results kept: more than a second at FIELD_HZ, enough for Bluetooth latency. */
const RING = 72;
/** Buffers in flight. When all are out the worker is behind, and a frame is skipped. */
const POOL = 3;

interface Slot {
  left: Float32Array;
  right: Float32Array;
  out: Float32Array;
}

export class FieldClient {
  private worker: Worker | null = null;
  private n = 0;
  private rate = 0;
  private pool: Slot[] = [];
  private ring: { t: number; field: MixField }[] = [];
  private head = -1;
  private count = 0;
  private lastPush = -Infinity;
  /** Bumped by every reset, so results from before it are dropped. */
  private epoch = 0;

  constructor() {
    for (let i = 0; i < RING; i++) this.ring.push({ t: -Infinity, field: emptyField() });
  }

  configure(rate: number, n: number) {
    if (rate === this.rate && n === this.n) return;
    this.rate = rate;
    this.n = n;
    if (!this.worker) {
      try {
        this.worker = new Worker(new URL('./field.worker.ts', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e: MessageEvent<FieldOut>) => this.receive(e.data);
      } catch (err) {
        console.warn('Musiccus: stereo field analysis unavailable', err);
        return;
      }
    }
    this.pool = Array.from({ length: POOL }, () => ({ left: new Float32Array(n), right: new Float32Array(n), out: new Float32Array(FIELD_PACKED) }));
    this.post({ type: 'config', rate, n });
    this.clear();
  }

  /** Forgets everything (new graph, new track): the analysis starts fresh. */
  clear() {
    this.epoch++;
    this.head = -1;
    this.count = 0;
    this.lastPush = -Infinity;
    for (const s of this.ring) s.t = -Infinity;
    this.post({ type: 'reset' });
  }

  /**
   * Offers the newest samples, captured at context time `now`; `t` is the
   * context time the frame stands for (see the hub).
   */
  push(left: Float32Array, right: Float32Array, now: number, t: number) {
    if (!this.worker || left.length < this.n || now - this.lastPush < 1 / FIELD_HZ - 1e-4) return;
    const slot = this.pool.pop();
    if (!slot) return;
    const dt = Math.min(0.1, Math.max(0.001, now - this.lastPush));
    this.lastPush = now;
    slot.left.set(left.subarray(left.length - this.n));
    slot.right.set(right.subarray(right.length - this.n));
    this.post({ type: 'frame', epoch: this.epoch, t, dt, left: slot.left, right: slot.right, out: slot.out }, [slot.left.buffer, slot.right.buffer, slot.out.buffer]);
  }

  private receive(d: FieldOut) {
    if (d.left.length === this.n) this.pool.push({ left: d.left, right: d.right, out: d.out });
    if (d.epoch !== this.epoch) return;
    this.head = (this.head + 1) % RING;
    this.count = Math.min(this.count + 1, RING);
    const slot = this.ring[this.head];
    slot.t = d.t;
    unpackField(d.out, slot.field);
  }

  /** The newest result at or before context time `t`, or null before the first. */
  pick(t: number): MixField | null {
    let best: MixField | null = null;
    for (let i = 0; i < this.count; i++) {
      const s = this.ring[(this.head - i + RING) % RING];
      best = s.field;
      if (s.t <= t) break;
    }
    return best;
  }

  private post(msg: FieldIn, transfer: Transferable[] = []) {
    this.worker?.postMessage(msg, transfer);
  }
}
