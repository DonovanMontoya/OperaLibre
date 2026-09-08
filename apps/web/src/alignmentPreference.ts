import type { AlignmentStatus } from "./types";

const key = (serverScope: string) => `operalibre.alignmentEnabled.${serverScope}`;

/** Remember the server flag across offline launches, without retaining admin paths. */
export function readAlignmentPreference(serverScope: string): AlignmentStatus | null {
  try {
    const value = window.localStorage.getItem(key(serverScope));
    return value === "1" || value === "0" ? { enabled: value === "1", cliPath: null } : null;
  } catch {
    return null;
  }
}

export function writeAlignmentPreference(serverScope: string, status: AlignmentStatus): void {
  try {
    window.localStorage.setItem(key(serverScope), status.enabled ? "1" : "0");
  } catch {
    // A live response still takes effect when device storage is unavailable.
  }
}

/** Newer polls and explicit admin changes supersede pending status reads. */
export function createAlignmentStatusUpdater(apply: (status: AlignmentStatus) => void) {
  let revision = 0;
  return {
    update(status: AlignmentStatus) {
      revision += 1;
      apply(status);
    },
    async refresh(load: () => Promise<AlignmentStatus>) {
      const requestRevision = ++revision;
      try {
        const status = await load();
        if (requestRevision === revision) apply(status);
      } catch {
        // An unavailable status cannot enable following or replace a cached flag.
      }
    },
    invalidate() {
      revision += 1;
    }
  };
}
