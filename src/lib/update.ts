/**
 * After a new version is deployed, a tab that is still open points at build
 * files the host has already removed, so the next mode it opens fails to load.
 * Reloading once picks up the new version. The guard stops a reload loop when
 * the file is missing for another reason (for example offline before the app
 * was fully cached).
 */
const KEY = 'musiccus:update-reload';

export function isChunkError(error: unknown): boolean {
  const msg = String((error as Error | undefined)?.message ?? error);
  return /dynamically imported module|module script failed|Importing a module script|Failed to fetch|error loading dynamically/i.test(msg);
}

/** Reloads the page once per 20 s; returns false when it just did. */
export function reloadForUpdate(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < 20_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // Without storage there is no loop guard, so do not reload automatically.
    return false;
  }
  location.reload();
  return true;
}
