import { get, set } from 'idb-keyval';

// Browser storage can be missing or throw (private windows, blocked site
// data), so every access is guarded and the app works without it.
export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

const DIR_KEY = 'musiccus:last-folder';

export async function rememberFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    await set(DIR_KEY, handle);
  } catch {
    /* IndexedDB unavailable */
  }
}

export async function recallFolder(): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return (await get(DIR_KEY)) as FileSystemDirectoryHandle | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Asks the browser to keep Musiccus' data (analyses, stems, the AI model)
 * when disk space runs low. Chrome decides silently; Firefox may ask.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function storageInfo(): Promise<{ persisted: boolean; usage: number; quota: number } | null> {
  try {
    if (!navigator.storage?.estimate) return null;
    const [est, persisted] = await Promise.all([navigator.storage.estimate(), navigator.storage.persisted?.() ?? Promise.resolve(false)]);
    return { persisted, usage: est.usage ?? 0, quota: est.quota ?? 0 };
  } catch {
    return null;
  }
}
