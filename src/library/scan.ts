export const AUDIO_EXT = new Set([
  'flac', 'wav', 'wave', 'aif', 'aiff', 'aifc', 'mp3', 'm4a', 'mp4', 'aac', 'ogg', 'oga', 'opus', 'webm',
  'alac', 'ape', 'wv', 'dsf', 'dff', 'wma',
]);

/** Formats Chrome cannot decode; they need the WASM decoders planned later. */
export const NEEDS_WASM = new Set(['ape', 'wv', 'dsf', 'dff', 'wma', 'alac']);

export interface FoundFile {
  path: string;
  name: string;
  ext: string;
  file?: File;
  handle?: FileSystemFileHandle;
}

export const extOf = (name: string) => {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
};

const isAudio = (name: string) => AUDIO_EXT.has(extOf(name)) && !name.startsWith('._');
const isLyrics = (name: string) => extOf(name) === 'lrc' && !name.startsWith('._');

/** Sidecar .lrc files found next to audio, keyed by lower-cased path without extension. */
export const sidecars = new Map<string, FileSystemFileHandle | File>();
export const sidecarKey = (path: string) => path.replace(/\.[^./]+$/, '').toLowerCase();
/** .lrc files from the most recent drop or pick, for attaching to the playing song. */
export const droppedLyrics: File[] = [];

export async function walkDirectory(
  dir: FileSystemDirectoryHandle,
  onProgress?: (found: number) => void,
): Promise<FoundFile[]> {
  const out: FoundFile[] = [];
  const walk = async (d: FileSystemDirectoryHandle, prefix: string) => {
    for await (const entry of d.values()) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        if (!entry.name.startsWith('.')) await walk(entry as FileSystemDirectoryHandle, path);
      } else if (isAudio(entry.name)) {
        out.push({ path, name: entry.name, ext: extOf(entry.name), handle: entry as FileSystemFileHandle });
        if (out.length % 25 === 0) onProgress?.(out.length);
      } else if (isLyrics(entry.name)) {
        sidecars.set(sidecarKey(path), entry as FileSystemFileHandle);
      }
    }
  };
  await walk(dir, '');
  onProgress?.(out.length);
  return out;
}

export function filesFromList(list: FileList | File[]): FoundFile[] {
  const out: FoundFile[] = [];
  droppedLyrics.length = 0;
  for (const file of Array.from(list)) {
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    if (isLyrics(file.name)) {
      sidecars.set(sidecarKey(path), file);
      droppedLyrics.push(file);
      continue;
    }
    if (!isAudio(file.name)) continue;
    out.push({ path, name: file.name, ext: extOf(file.name), file });
  }
  return out;
}

/** Collects audio files from a drop, descending into dropped folders. */
export async function filesFromDrop(dt: DataTransfer): Promise<FoundFile[]> {
  // Entries must be taken synchronously, before the first await.
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    const e = item.webkitGetAsEntry?.();
    if (e) entries.push(e);
  }
  if (entries.length === 0) return filesFromList(dt.files);

  const out: FoundFile[] = [];
  droppedLyrics.length = 0;
  const fileOf = (e: FileSystemFileEntry) => new Promise<File>((res, rej) => e.file(res, rej));
  const readAll = async (dir: FileSystemDirectoryEntry) => {
    const reader = dir.createReader();
    const all: FileSystemEntry[] = [];
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (batch.length === 0) break;
      all.push(...batch);
    }
    return all;
  };
  const visit = async (e: FileSystemEntry) => {
    if (e.isDirectory) {
      for (const child of await readAll(e as FileSystemDirectoryEntry)) await visit(child);
    } else if (isAudio(e.name)) {
      const file = await fileOf(e as FileSystemFileEntry);
      out.push({ path: e.fullPath.replace(/^\//, ''), name: e.name, ext: extOf(e.name), file });
    } else if (isLyrics(e.name)) {
      const file = await fileOf(e as FileSystemFileEntry);
      sidecars.set(sidecarKey(e.fullPath.replace(/^\//, '')), file);
      droppedLyrics.push(file);
    }
  };
  for (const e of entries) await visit(e);
  return out;
}
