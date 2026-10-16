import { useCallback, useMemo, useSyncExternalStore } from "react";
import { readStoredValue } from "./appStorage";
import { parseReadingQueue } from "./readingQueue";

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// The shelf and the book page both edit the plan, so they read it through one
// store; `save` reports false when the device refuses the write.
export function useReadingQueue(storageKey: string) {
  const stored = useSyncExternalStore(subscribe, () => readStoredValue(storageKey));
  const ids = useMemo(() => parseReadingQueue(stored), [stored]);
  const save = useCallback((next: string[]) => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      return false;
    }
    listeners.forEach(listener => listener());
    return true;
  }, [storageKey]);
  return [ids, save] as const;
}
