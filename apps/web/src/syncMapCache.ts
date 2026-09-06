import type { SyncMap } from "./types";

export type SyncMapCache = { maps: Record<string, SyncMap | null>; revision: number };
type Action =
  | { type: "loaded"; bookId: string; map: SyncMap | null }
  | { type: "invalidate"; bookId: string }
  | { type: "reset" };

/** Invalidation and the reader's reload signal must change together. */
export function syncMapCacheReducer(state: SyncMapCache, action: Action): SyncMapCache {
  switch (action.type) {
    case "loaded":
      return { ...state, maps: { ...state.maps, [action.bookId]: action.map } };
    case "invalidate": {
      const { [action.bookId]: _removed, ...maps } = state.maps;
      return { maps, revision: state.revision + 1 };
    }
    case "reset":
      return { maps: {}, revision: state.revision + 1 };
  }
}
