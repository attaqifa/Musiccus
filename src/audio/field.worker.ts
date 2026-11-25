/*
 * Runs the stereo field analysis (field.ts) off the main thread: an FFT of
 * 8192 points and its bookkeeping take a millisecond or two per frame, which
 * the visuals would rather spend on drawing. Each frame's buffers come back
 * with the result, so nothing is allocated while music plays.
 */
import { FieldAnalyzer, emptyField, packField } from './field';

export type FieldIn =
  | { type: 'config'; rate: number; n: number }
  | { type: 'reset' }
  | { type: 'frame'; epoch: number; t: number; dt: number; left: Float32Array; right: Float32Array; out: Float32Array };

export type FieldOut = { type: 'field'; epoch: number; t: number; left: Float32Array; right: Float32Array; out: Float32Array };

interface Scope {
  onmessage: ((e: MessageEvent<FieldIn>) => void) | null;
  postMessage(msg: FieldOut, transfer: Transferable[]): void;
}

const scope = self as unknown as Scope;
let analyzer: FieldAnalyzer | null = null;
const field = emptyField();

scope.onmessage = (e) => {
  const d = e.data;
  if (d.type === 'config') {
    analyzer = new FieldAnalyzer(d.rate, d.n);
    return;
  }
  if (d.type === 'reset') {
    analyzer?.reset();
    return;
  }
  if (analyzer && d.left.length >= analyzer.n) {
    analyzer.analyze(d.left, d.right, d.dt, field);
    packField(field, d.out);
  }
  scope.postMessage({ type: 'field', epoch: d.epoch, t: d.t, left: d.left, right: d.right, out: d.out }, [d.left.buffer, d.right.buffer, d.out.buffer]);
};
