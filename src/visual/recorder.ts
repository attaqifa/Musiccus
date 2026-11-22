/**
 * Video export: the visual stage and the processed audio, recorded in real
 * time while the song plays, as MP4 (H.264/AAC) where the browser can, else
 * WebM (VP9/Opus).
 */
import { create } from 'zustand';
import { engine } from '../audio/engine';
import { replayCurrent, seek } from '../store/controller';
import { getState, toast } from '../store/player';
import { saveBlob } from '../studio/export';

interface RecorderState {
  state: 'idle' | 'recording' | 'saving';
  startedAt: number;
  format: string;
}

export const useRecorder = create<RecorderState>(() => ({ state: 'idle', startedAt: 0, format: '' }));

const FORMATS: [string, string][] = [
  ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'mp4'],
  ['video/mp4', 'mp4'],
  ['video/webm;codecs=vp9,opus', 'webm'],
  ['video/webm', 'webm'],
];

let recorder: MediaRecorder | null = null;
let tap: MediaStreamAudioDestinationNode | null = null;
let stopOnEnd: (() => void) | null = null;

export const recordingSupported = () => typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;

/** Records the playing song from its start; stops by itself when the song ends. */
export async function startRecording(): Promise<void> {
  if (recorder || !recordingSupported()) return;
  const s = getState();
  const id = s.now?.trackId;
  const canvas = document.querySelector<HTMLCanvasElement>('.stage-canvas');
  if (!id || !canvas) {
    toast('Putar lagu dulu, lalu rekam visualnya.', 'error');
    return;
  }
  const [mime, ext] = FORMATS.find(([m]) => MediaRecorder.isTypeSupported(m)) ?? ['', 'webm'];
  // Start the song from the top so the video holds the whole piece.
  if (s.status !== 'playing') await replayCurrent(0);
  else seek(0);
  await new Promise((r) => setTimeout(r, 120));

  tap = engine.recordTap();
  if (!tap) return;
  const stream = new MediaStream([...canvas.captureStream(60).getVideoTracks(), ...tap.stream.getAudioTracks()]);
  const chunks: Blob[] = [];
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 16_000_000, audioBitsPerSecond: 320_000 });
  recorder = rec;
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    useRecorder.setState({ state: 'saving' });
    const t = getState().tracks[id];
    const title = (t?.meta?.title || t?.name.replace(/\.[^.]+$/, '') || 'Musiccus').replace(/[\\/:*?"<>|]/g, '');
    saveBlob(new Blob(chunks, { type: rec.mimeType || `video/${ext}` }), `${title} (Musiccus).${ext}`);
    for (const tr of stream.getTracks()) tr.stop();
    if (tap) engine.releaseTap(tap);
    tap = null;
    recorder = null;
    stopOnEnd?.();
    stopOnEnd = null;
    useRecorder.setState({ state: 'idle', startedAt: 0 });
    toast(`Video tersimpan (${ext.toUpperCase()}).`);
  };
  rec.start(1000);
  useRecorder.setState({ state: 'recording', startedAt: performance.now(), format: ext.toUpperCase() });

  // Stop at the end of the song, including a gapless move to the next one.
  const end = () => stopRecording();
  const offEnded = engine.on('ended', end);
  const offAdvance = engine.on('advance', end);
  stopOnEnd = () => {
    offEnded();
    offAdvance();
  };
}

export function stopRecording(): void {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}
