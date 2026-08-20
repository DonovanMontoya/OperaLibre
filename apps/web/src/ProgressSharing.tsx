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

/**
 * Both finish settings default to on for the same reason sharing does: a
 * server that predates them omits the fields, and someone already sharing
 * would not expect to have been opted out of a feature they never saw.
 */
export function isAnnouncingFinishes(user: AuthUser): boolean {
  return isSharingProgress(user) && user.announceFinishes !== false;
}

export function isNotifiedOfFinishes(user: AuthUser): boolean {
  return isSharingProgress(user) && user.notifyFinishes !== false;
}

export function ProgressSharingCard({
  user,
  onUserChanged,
  onSharingChanged
}: ProgressSharingCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = isSharingProgress(user);
  const announcing = isAnnouncingFinishes(user);
  const notified = isNotifiedOfFinishes(user);

  async function save(
    shareProgress: boolean,
    finishes: { announceFinishes: boolean; notifyFinishes: boolean }
  ) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateProgressSharing(shareProgress, finishes);
      onUserChanged(updated);
      // Only the master switch changes what the library returns; the two finer
      // ones move the feed alone, so the shelf does not need refetching.
      if (shareProgress !== enabled) onSharingChanged();
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
          onClick={() =>
            void save(!enabled, { announceFinishes: announcing, notifyFinishes: notified })
          }
        >
          <span aria-hidden="true" />
        </button>
      </div>

      {/* Both of these live inside sharing, so they are offered only once it is
          on rather than sitting there disabled with nothing to explain them. */}
      {enabled ? (
        <>
          <div className="settings-toggle-row settings-toggle-nested">
            <span>
              <strong>Announce when I finish</strong>
              <small>
                Adds “{user.username} finished …” to the shared feed. Your progress stays
                visible either way — this is only about the announcement.
              </small>
            </span>
            <button
              type="button"
              className="settings-switch"
              role="switch"
              aria-checked={announcing}
              aria-label="Announce when I finish a book"
              disabled={busy}
              onClick={() =>
                void save(enabled, { announceFinishes: !announcing, notifyFinishes: notified })
              }
            >
              <span aria-hidden="true" />
            </button>
          </div>

          <div className="settings-toggle-row settings-toggle-nested">
            <span>
              <strong>Notify me about others</strong>
              <small>
                Tells you when someone else finishes a book. In the app it is a badge on the
                bell; on the phone it is also a banner while the app is open.
              </small>
            </span>
            <button
              type="button"
              className="settings-switch"
              role="switch"
              aria-checked={notified}
              aria-label="Notify me when others finish a book"
              disabled={busy}
              onClick={() =>
                void save(enabled, { announceFinishes: announcing, notifyFinishes: !notified })
              }
            >
              <span aria-hidden="true" />
            </button>
          </div>
        </>
      ) : null}

      {error ? <p className="settings-hint settings-error">{error}</p> : null}
    </section>
  );
}
