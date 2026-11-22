/// <reference lib="webworker" />
/**
 * Stem separation worker. AI: htdemucs (Meta, MIT) as 21 chained fp16 ONNX
 * pieces on WebGPU, so the visuals keep their frame rate while it runs. DSP:
 * median-filter separation at the file's own rate. Both return vocals, drums
 * and bass; "other" is derived on the main thread as the remainder.
 */
import * as ort from 'onnxruntime-web/webgpu';
import { BINS, demucsFrame, demucsIspec, demucsSpec, FRAMES, fromInt16, resample, SEG, separateDsp, stemLevels, toInt16 } from './dsp';
import { MODEL_BASE, MODEL_BYTES, MODEL_CACHE, MODEL_RATE, type CachedStems, type SeparateRequest, type StemWorkerMessage } from './types';

// The WebGPU runtime is 28.7 MB, over the per-file limit of some static
// hosts, so its glue and wasm come from jsDelivr at exactly the installed
// version, unless a self-hosted copy is configured (VITE_ORT_BASE).
ort.env.wasm.wasmPaths = import.meta.env.VITE_ORT_BASE || `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';
// Ask for the faster GPU on dual-GPU machines. Browsers on Windows still use
// whichever GPU Windows assigned them; Settings shows which one that is.
ort.env.webgpu.powerPreference = 'high-performance';

const post = (m: StemWorkerMessage, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

/* ------------------------------------------------------------- Model -- */

interface PieceSpec {
  file: string;
  inputs: string[];
  outputs: string[];
}

interface Piece extends PieceSpec {
  session: ort.InferenceSession;
}

/** The input normalisation is fp16-fragile; the model card pins it to CPU. */
const CPU_NODES = [
  '/ReduceMean', '/Sub', '/Pow', '/ReduceMean_1', '/Clip', '/Sqrt', '/Add', '/Div',
  '/ReduceMean_2', '/Sub_1', '/Pow_1', '/ReduceMean_3', '/Clip_1', '/Sqrt_1', '/Add_1', '/Div_1',
];

let pieces: Piece[] | null = null;
let loading: Promise<Piece[]> | null = null;
/** Last piece that reads each intermediate tensor, so GPU memory is freed early. */
let lastUse = new Map<string, number>();

async function fetchCached(url: string, onBytes: (n: number) => void): Promise<ArrayBuffer> {
  const cache = await caches.open(MODEL_CACHE);
  const hit = await cache.match(url);
  if (hit) {
    const buf = await hit.arrayBuffer();
    onBytes(buf.byteLength);
    return buf;
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Model tidak bisa diunduh (HTTP ${res.status}).`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    onBytes(value.length);
  }
  const buf = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.length;
  }
  await cache.put(url, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } }));
  return buf.buffer;
}

async function loadModel(report: (stage: string, p: number) => void): Promise<Piece[]> {
  if (pieces) return pieces;
  if (loading) return loading;
  loading = (async () => {
    if (!('gpu' in navigator)) throw new Error('Browser ini belum mendukung WebGPU. Pakai mode Cepat, atau buka Musiccus di Chrome atau Edge terbaru.');
    const manifestBuf = await fetchCached(`${MODEL_BASE}htdemucs_split_manifest.json`, () => undefined);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBuf)) as { pieces: PieceSpec[] };
    let loaded = 0;
    const buffers: ArrayBuffer[] = [];
    for (const spec of manifest.pieces) {
      buffers.push(
        await fetchCached(MODEL_BASE + spec.file, (n) => {
          loaded += n;
          report('Mengunduh model AI', Math.min(1, loaded / MODEL_BYTES));
        }),
      );
    }
    const out: Piece[] = [];
    for (let i = 0; i < manifest.pieces.length; i++) {
      const spec = manifest.pieces[i];
      report('Menyiapkan GPU', i / manifest.pieces.length);
      // Boundaries go back to system RAM between pieces. Keeping them on the
      // GPU is faster, but the skip connections held across the whole chain
      // run integrated GPUs out of memory.
      const session = await ort.InferenceSession.create(new Uint8Array(buffers[i]), {
        executionProviders: i === 0 ? [{ name: 'webgpu', forceCpuNodeNames: CPU_NODES }] : ['webgpu'],
        graphOptimizationLevel: 'all',
        preferredOutputLocation: 'cpu',
      });
      out.push({ ...spec, session });
    }
    lastUse = new Map();
    out.forEach((p, i) => p.inputs.forEach((name) => lastUse.set(name, i)));
    pieces = out;
    return out;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runSegment(model: Piece[], left: Float32Array, right: Float32Array): Promise<{ x: Float32Array; xt: Float32Array }> {
  const frame = demucsFrame();
  const mag = demucsSpec(frame, left, right);
  const mix = new Float32Array(2 * SEG);
  mix.set(left, 0);
  mix.set(right, SEG);
  const tensors = new Map<string, ort.Tensor>([
    ['mix', new ort.Tensor('float32', mix, [1, 2, SEG])],
    ['mag', new ort.Tensor('float32', mag, [1, 4, BINS, FRAMES])],
  ]);
  const device = (await ort.env.webgpu.device) as unknown as { queue: { onSubmittedWorkDone(): Promise<void> } };
  for (let i = 0; i < model.length; i++) {
    const p = model[i];
    const feeds: Record<string, ort.Tensor> = {};
    for (const name of p.inputs) feeds[name] = tensors.get(name)!;
    const out = await p.session.run(feeds);
    for (const [name, t] of Object.entries(out)) tensors.set(name, t);
    for (const name of p.inputs) {
      if (lastUse.get(name) === i && name !== 'mix' && name !== 'mag') {
        const t = tensors.get(name);
        if (t?.location === 'gpu-buffer') t.dispose();
        tensors.delete(name);
      }
    }
    // Let the compositor draw a frame between GPU bursts.
    await device.queue.onSubmittedWorkDone();
    await sleep(1);
  }
  const x = tensors.get('x')!.data as Float32Array;
  const xt = tensors.get('xt')!.data as Float32Array;
  for (const t of tensors.values()) if (t.location === 'gpu-buffer') t.dispose();
  return { x, xt };
}

/** demucs apply_model(split=True, overlap=0.25): triangular cross-fades between 7.8 s segments. */
async function separateAi(left: Float32Array, right: Float32Array, report: (stage: string, p: number) => void): Promise<Float32Array[]> {
  const model = await loadModel(report);
  const len = left.length;
  const stride = Math.floor(SEG * 0.75);
  const half = SEG >> 1;
  const weight = new Float32Array(SEG);
  for (let i = 0; i < SEG; i++) weight[i] = (i < half ? i + 1 : SEG - i) / half;
  // htdemucs source order: drums, bass, other, vocals. We keep vocals, drums, bass.
  const sources = [3, 0, 1];
  const acc = Array.from({ length: 6 }, () => new Float64Array(len));
  const wsum = new Float64Array(len);
  const segments = Math.max(1, Math.ceil(len / stride));
  const frame = demucsFrame();
  const plane = BINS * FRAMES;
  const segL = new Float32Array(SEG);
  const segR = new Float32Array(SEG);
  const tmpL = new Float64Array(SEG);
  const tmpR = new Float64Array(SEG);
  let n = 0;
  for (let offset = 0; offset < len; offset += stride) {
    const chunk = Math.min(SEG, len - offset);
    const delta = SEG - chunk;
    const start = offset - (delta >> 1);
    segL.fill(0);
    segR.fill(0);
    for (let i = Math.max(0, start); i < Math.min(len, start + SEG); i++) {
      segL[i - start] = left[i];
      segR[i - start] = right[i];
    }
    const { x, xt } = await runSegment(model, segL, segR);
    const trim = delta >> 1;
    for (let k = 0; k < sources.length; k++) {
      const s = sources[k];
      for (let i = 0; i < SEG; i++) {
        tmpL[i] = xt[(s * 2) * SEG + i];
        tmpR[i] = xt[(s * 2 + 1) * SEG + i];
      }
      demucsIspec(frame, x, s * 4 * plane, tmpL, tmpR);
      const oL = acc[k * 2];
      const oR = acc[k * 2 + 1];
      for (let i = 0; i < chunk; i++) {
        oL[offset + i] += weight[i] * tmpL[trim + i];
        oR[offset + i] += weight[i] * tmpR[trim + i];
      }
    }
    for (let i = 0; i < chunk; i++) wsum[offset + i] += weight[i];
    n++;
    report('Memisahkan dengan AI', n / segments);
  }
  return acc.map((a) => {
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) out[i] = wsum[i] > 0 ? a[i] / wsum[i] : 0;
    return out;
  });
}

/* ----------------------------------------------------------- Requests -- */

self.onmessage = async (e: MessageEvent<SeparateRequest>) => {
  const req = e.data;
  if (req.type !== 'separate') return;
  const t0 = performance.now();
  let lastPost = 0;
  const report = (stage: string, p: number) => {
    const now = performance.now();
    if (now - lastPost < 120 && p < 1) return;
    lastPost = now;
    post({ type: 'progress', id: req.id, stage, p });
  };
  try {
    let stems: Float32Array[];
    let raw: CachedStems | undefined;
    let backend = 'DSP';
    if (req.engine === 'dsp') {
      stems = separateDsp(req.left, req.right, req.rate, (p) => report('Memisahkan (DSP)', p));
    } else {
      if (req.cached) {
        // Cached at the file's own rate: usually no resampling at all.
        const { rate, data } = req.cached;
        const n = req.left.length;
        stems = data.map((d) => (rate === req.rate && d.length === n ? fromInt16(d) : resample(fromInt16(d), rate, req.rate, n)));
      } else {
        report('Menyiapkan audio', 0);
        const l = resample(req.left, req.rate, MODEL_RATE);
        const r = resample(req.right, req.rate, MODEL_RATE);
        const at44 = await separateAi(l, r, report);
        report('Menyelaraskan ke sample rate asli', 1);
        stems = at44.map((s) => resample(s, MODEL_RATE, req.rate, req.left.length));
        raw = { rate: req.rate, data: stems.map(toInt16) };
      }
      backend = 'htdemucs · WebGPU';
    }
    report('Mengukur level stem', 1);
    const levels = stemLevels(stems, req.left, req.right, req.rate);
    const transfer: Transferable[] = [...stems.map((s) => s.buffer), ...levels.map((l) => l.buffer), ...(raw?.data ?? []).map((r) => r.buffer)];
    post({ type: 'done', id: req.id, stems, levels, raw, backend, elapsedMs: performance.now() - t0 }, transfer);
  } catch (err) {
    // The app only shows the message; the console keeps the stack for diagnosis.
    console.error('Musiccus: stem separation failed', err);
    post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
