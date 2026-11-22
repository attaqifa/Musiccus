import { getAnalysis } from '../analysis/manager';
import { engine, type StemBuffers } from '../audio/engine';
import { getStems } from '../stems/manager';
import { mixNeutral, StemMixer, type StemMix } from '../stems/mixer';
import { useStems } from '../stems/store';
import { STORED } from '../stems/types';
import { getDecoded } from '../store/controller';
import { getState, toast } from '../store/player';
import { StudioGraph } from './graph';
import { useStudio } from './store';
import { playbackRate, type StudioState } from './types';

const timeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);

/**
 * Renders a track through the studio rack faster than real time, with the
 * same graph the live engine uses. Reverb and delay tails are kept; the
 * pitch stretcher's latency is trimmed so the result starts on time.
 */
export async function renderProcessed(
  buffer: AudioBuffer,
  state: StudioState,
  bpm: number | undefined,
  onProgress: (p: number) => void,
  stems?: { buffers: StemBuffers; mix: StemMix },
): Promise<AudioBuffer> {
  const sr = buffer.sampleRate;
  const rate = playbackRate(state.pitch);
  const tail = (state.space.on ? state.space.decay * 1.2 + state.space.predelay : 0) + (state.delay.on ? 3 : 0) + 0.5;
  const body = Math.ceil(buffer.length / rate);
  const length = body + Math.ceil(tail * sr);
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate: sr });
  const graph = new StudioGraph(ctx);
  // The stretcher talks to its worklet over messages; never let a reply that
  // only arrives once rendering starts block the export.
  await timeout(graph.apply(state, { bpm, immediate: true }), 3000);
  const latency = graph.latency || engine.studioLatency;

  const play = (b: AudioBuffer, to: AudioNode) => {
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.playbackRate.value = rate;
    s.connect(to);
    s.start(0);
  };
  if (stems && !mixNeutral(stems.mix)) {
    // The stem mix (karaoke, solos, 3D stage) is rendered with the same mixer the player uses.
    const mixer = new StemMixer(ctx);
    mixer.output.connect(graph.input);
    mixer.apply(stems.mix, true, true);
    play(buffer, mixer.input);
    for (const k of STORED) play(stems.buffers[k], mixer.stemIn[k]);
  } else {
    play(buffer, graph.input);
  }
  graph.output.connect(ctx.destination);

  const total = length / sr;
  const step = Math.max(1, total / 25);
  for (let t = step; t < total - 0.1; t += step) {
    void ctx.suspend(t).then(() => {
      onProgress(t / total);
      return ctx.resume();
    });
  }
  const out = await ctx.startRendering();
  onProgress(1);

  // Trim the stretcher's latency at the start and silence at the end.
  const skip = Math.min(out.length - 1, Math.round(latency * sr));
  let end = out.length;
  const floor = Math.pow(10, -96 / 20);
  for (let i = out.length - 1; i > body; i--) {
    if (Math.abs(out.getChannelData(0)[i]) > floor || Math.abs(out.getChannelData(1)[i]) > floor) {
      end = Math.min(out.length, i + Math.round(0.05 * sr));
      break;
    }
    end = i;
  }
  const trimmed = new AudioBuffer({ numberOfChannels: 2, length: Math.max(1, end - skip), sampleRate: sr });
  for (let c = 0; c < 2; c++) trimmed.copyToChannel(out.getChannelData(c).subarray(skip, end), c);
  return trimmed;
}

/** WAV encoder: 24-bit PCM with TPDF dither, or 32-bit float. */
export function encodeWav(buffer: AudioBuffer, bits: 24 | 32): Blob {
  const ch = buffer.numberOfChannels;
  const n = buffer.length;
  const bytes = bits / 8;
  const data = n * ch * bytes;
  const ab = new ArrayBuffer(44 + data);
  const dv = new DataView(ab);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  dv.setUint32(4, 36 + data, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, bits === 32 ? 3 : 1, true);
  dv.setUint16(22, ch, true);
  dv.setUint32(24, buffer.sampleRate, true);
  dv.setUint32(28, buffer.sampleRate * ch * bytes, true);
  dv.setUint16(32, ch * bytes, true);
  dv.setUint16(34, bits, true);
  w(36, 'data');
  dv.setUint32(40, data, true);
  const chans = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = chans[c][i];
      if (bits === 32) {
        dv.setFloat32(o, v, true);
      } else {
        // Triangular dither of ±1 LSB decorrelates the rounding error.
        const dither = Math.random() - Math.random();
        let x = Math.round(v * 8388607 + dither);
        x = Math.max(-8388608, Math.min(8388607, x));
        dv.setUint8(o, x & 255);
        dv.setUint8(o + 1, (x >> 8) & 255);
        dv.setUint8(o + 2, (x >> 16) & 255);
      }
      o += bytes;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Renders the playing track with the current rack and downloads it. */
export async function exportCurrentTrack(bits: 24 | 32) {
  const st = getState();
  const id = st.now?.trackId;
  const decoded = getDecoded(id);
  const track = id ? st.tracks[id] : undefined;
  if (!decoded || !track) {
    toast('Putar lagu yang ingin di-export terlebih dahulu.', 'error');
    return;
  }
  if (useStudio.getState().exporting) return;
  useStudio.setState({ exporting: { progress: 0, stage: 'Merender' } });
  try {
    const loaded = getStems(id);
    const stems = loaded && loaded.length === decoded.buffer.length ? { buffers: loaded.buffers, mix: useStems.getState().mix } : undefined;
    const out = await renderProcessed(
      decoded.buffer,
      useStudio.getState().state,
      getAnalysis(id)?.bpm,
      (p) => useStudio.setState({ exporting: { progress: p, stage: 'Merender' } }),
      stems,
    );
    useStudio.setState({ exporting: { progress: 1, stage: 'Menulis WAV' } });
    const title = (track.meta?.title || track.name.replace(/\.[^.]+$/, '')).replace(/[\\/:*?"<>|]/g, '');
    saveBlob(encodeWav(out, bits), `${title} (Musiccus).wav`);
    toast(`Export selesai: ${bits === 32 ? '32-bit float' : '24-bit'}, ${(out.sampleRate / 1000).toString().replace('.', ',')} kHz.`);
  } catch (e) {
    toast(`Export gagal: ${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    useStudio.setState({ exporting: null });
  }
}
