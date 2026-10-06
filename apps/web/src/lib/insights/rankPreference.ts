/**
 * Phase 10b spec §6: "Rank with my history" is a per-browser preference, stored in localStorage. Exposed as a tiny
 * external store for React's useSyncExternalStore, so the server render (no window) and the first client render agree
 * (getServerSnapshot = false) and the stored choice applies right after hydration. If storage is unavailable (private
 * mode, blocked site data) the choice still works for the life of the page via the in-memory value.
 */
export const RANK_PREFERENCE_KEY = "careerpilot.rankWithHistory";

let memory: boolean | null = null;
const listeners = new Set<() => void>();

export function readRankPreference(): boolean {
  if (memory !== null) return memory;
  try {
    return window.localStorage.getItem(RANK_PREFERENCE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeRankPreference(value: boolean): void {
  memory = value;
  try {
    window.localStorage.setItem(RANK_PREFERENCE_KEY, value ? "1" : "0");
  } catch {
    // Storage unavailable: the in-memory value above still applies until the page is reloaded.
  }
  for (const listener of listeners) listener();
}

export function subscribeRankPreference(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === RANK_PREFERENCE_KEY) {
      memory = null;
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The server never knows the browser's preference. */
export const serverRankPreference = (): boolean => false;

/** Tests only: forget the in-memory value. */
export function resetRankPreferenceForTests(): void {
  memory = null;
}
