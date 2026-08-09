import { Users } from "lucide-react";
import { useState } from "react";
import { updateProgressSharing } from "./api";
import type { AuthUser } from "./types";

type ProgressSharingCardProps = {
  user: AuthUser;
  onUserChanged: (user: AuthUser) => void;
  /** Sharing is reciprocal, so the library must be refetched after a change. */
  onSharingChanged: () => void;
};

export function isSharingProgress(user: AuthUser): boolean {
  // Servers released before progress sharing omit the field; they share by
  // default, which is what the toggle should show rather than a false "off".
  return user.shareProgress !== false;
}

export function ProgressSharingCard({
  user,
  onUserChanged,
  onSharingChanged
}: ProgressSharingCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = isSharingProgress(user);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateProgressSharing(!enabled);
      onUserChanged(updated);
      onSharingChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change progress sharing.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-card">
      <span className="section-label"><Users size={13} /> Shared reading</span>
      <div className="settings-toggle-row">
        <span>
          <strong>Share my reading activity</strong>
          <small>
            Other listeners on this server see which books you have finished and how far
            you are through the rest. Turning this off also hides theirs from you.
          </small>
        </span>
        <button
          type="button"
          className="settings-switch"
          role="switch"
          aria-checked={enabled}
          aria-label="Share my reading activity"
          disabled={busy}
          onClick={() => void toggle()}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      {error ? <p className="settings-hint settings-error">{error}</p> : null}
    </section>
  );
}
