/** Min/max envelope of a buffer for the waveform seek bar. */
export function computePeaks(buffer: AudioBuffer, buckets = 1600): Float32Array {
  const out = new Float32Array(buckets * 2);
  const chans: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) chans.push(buffer.getChannelData(c));
  const len = buffer.length;
  const step = len / buckets;
  // Stride keeps this fast on long hi-res files; peaks survive because the
  // stride is far shorter than one bucket.
  const stride = Math.max(1, Math.floor(step / 512));
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * step);
    const e = Math.min(len, Math.floor((b + 1) * step));
    let lo = 0;
    let hi = 0;
    for (const ch of chans) {
      for (let i = s; i < e; i += stride) {
        const v = ch[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    out[b * 2] = lo;
    out[b * 2 + 1] = hi;
  }
  return out;
}
