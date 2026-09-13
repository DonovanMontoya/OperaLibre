import { ArrowLeft, Headphones } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getProfileStats, getServerStorageKey, isNetworkError, mediaUrl } from "./api";
import { Achievements } from "./Achievements";
import { readingStatus } from "./bookProgress";
import { getOfflineCoverUrl, releaseOfflineMediaUrl } from "./offline";
import {
  deriveDeviceProfileStats,
  readCachedProfileStats,
  writeCachedProfileStats
} from "./profileCache";
import { ProgressSharingCard } from "./ProgressSharing";
import { progressTimestamp, splitRoundedHours } from "./reliability";
import type { AuthUser, Book, ProfileRecentBook, ProfileStats, StreakDay } from "./types";

type ProfilePageProps = {
  user: AuthUser;
  books: Book[];
  onClose: () => void;
  onOpenBook: (bookId: string) => void;
  onUserChanged: (user: AuthUser) => void;
  onSharingChanged: () => void;
  /** Jellyfin has no shared-progress concept, so the control is hidden there. */
  sharingAvailable: boolean;
  /** A device-only library has no profile endpoint, so its ledger uses local progress. */
  deviceOnly?: boolean;
};

function relativeTime(value: string | null) {
  if (!value) return null;
  // Progress revisions are epoch milliseconds on newer rows and epoch seconds
  // on older ones. Reading a millisecond revision as seconds puts every book
  // tens of thousands of years in the future, which clamps to "just now".
  const millis = progressTimestamp(value);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  const seconds = Math.floor(millis / 1000);
  const now = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, now - seconds);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)} min ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} hr ago`;
  if (delta < 86400 * 2) return "yesterday";
  if (delta < 86400 * 30) return `${Math.floor(delta / 86400)} days ago`;
  if (delta < 86400 * 365) return `${Math.floor(delta / 86400 / 30)} months ago`;
  return `${Math.floor(delta / 86400 / 365)} years ago`;
}

function joinDate(value: string) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric"
  });
}

// The listening total counts only what the server measured, so it covers the
// window since measuring began rather than the whole account. Naming that date
// is the difference between a modest number and a number that looks broken.
function measuringSinceLabel(value: string | null) {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

export function ProfilePage({
  user,
  books,
  onClose,
  onOpenBook,
  onUserChanged,
  onSharingChanged,
  sharingAvailable,
  deviceOnly = false
}: ProfilePageProps) {
  const serverScope = getServerStorageKey();
  const [initialSnapshot] = useState(() =>
    readCachedProfileStats(window.localStorage, serverScope, user.id)
  );
  const [stats, setStats] = useState<ProfileStats | null>(initialSnapshot?.stats ?? null);
  const [cachedAt, setCachedAt] = useState<string | null>(initialSnapshot?.cachedAt ?? null);
  const [offlineSource, setOfflineSource] = useState<"cache" | "device" | null>(
    deviceOnly ? "device" : null
  );
  const [refreshRequest, setRefreshRequest] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!initialSnapshot);
  const [selectedDay, setSelectedDay] = useState<StreakDay | null>(null);

  useEffect(() => {
    if (deviceOnly) return;
    const refresh = () => setRefreshRequest((request) => request + 1);
    window.addEventListener("online", refresh);
    return () => window.removeEventListener("online", refresh);
  }, [deviceOnly]);

  useEffect(() => {
    let cancelled = false;
    if (deviceOnly) {
      setLoading(false);
      setError(null);
      setOfflineSource("device");
      return () => {
        cancelled = true;
      };
    }
    const cached = readCachedProfileStats(window.localStorage, serverScope, user.id);
    setStats(cached?.stats ?? null);
    setCachedAt(cached?.cachedAt ?? null);
    setLoading(!cached);
    setError(null);
    getProfileStats()
      .then((next) => {
        if (cancelled) return;
        const snapshot = writeCachedProfileStats(
          window.localStorage,
          serverScope,
          user.id,
          next
        );
        setStats(next);
        setCachedAt(snapshot.cachedAt);
        setOfflineSource(null);
      })
      .catch((err) => {
        if (cancelled) return;
        if (cached && isNetworkError(err)) {
          setOfflineSource("cache");
        } else if (isNetworkError(err)) {
          setOfflineSource("device");
        } else {
          setError(err instanceof Error ? err.message : "Could not load profile.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [deviceOnly, refreshRequest, serverScope, user.id]);

  const deviceStats = useMemo(() => deriveDeviceProfileStats(books), [books]);
  const displayedStats = offlineSource === "device" ? deviceStats : stats;

  const monogram = user.username.slice(0, 1).toUpperCase();

  const weeks = useMemo<StreakDay[][]>(() => {
    if (!displayedStats) return [];
    const days = [...displayedStats.streakCalendar];
    const columns: StreakDay[][] = [];
    for (let i = 0; i < days.length; i += 7) {
      columns.push(days.slice(i, i + 7));
    }
    return columns;
  }, [displayedStats]);

  const joined = joinDate(user.createdAt);
  const lastSeen = displayedStats ? relativeTime(displayedStats.lastListenedAt) : null;
  const hours = displayedStats
    ? splitRoundedHours(displayedStats.totalHoursRead)
    : { whole: "0", minutes: 0 };
  const measuringSince = displayedStats
    ? measuringSinceLabel(displayedStats.measuringSince)
    : null;
  const deviceInProgress = books.filter((book) => readingStatus(book) === "inProgress").length;

  return (
    <main className="profile-shell" onClick={onClose}>
      <article
        className={`profile-page ledger-dashboard${offlineSource === "device" ? " ledger-device-only" : ""}`}
        onClick={(event) => event.stopPropagation()}
      >
      <button type="button" className="profile-back" onClick={onClose}>
        <ArrowLeft size={14} />
        <span>Library</span>
      </button>

      {loading ? (
        <p className="profile-status">Loading…</p>
      ) : error ? (
        <p className="profile-status error">{error}</p>
      ) : displayedStats ? (
        <>
          {offlineSource ? (
            <p className="profile-status profile-offline-status" role="status">
              {offlineSource === "cache"
                ? `Offline · last synced ${relativeTime(cachedAt) ?? "previously"}`
                : `${deviceOnly ? "On-device" : "Offline"} ledger · based on progress saved here`}
            </p>
          ) : null}
          <header className="profile-head">
            <div className="profile-mono" aria-hidden="true">{monogram}</div>
            <div className="profile-id">
              <h1>Ledger</h1>
              <span className="ledger-owner">{user.username}’s reading activity</span>
              <p>
                {[
                  joined ? `Joined ${joined}` : null,
                  lastSeen ? `Last listened ${lastSeen}` : null,
                  user.isAdmin ? "Administrator" : null
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
          </header>

          <section className="profile-headline">
            <div className="headline-primary">
              <span className="headline-value">
                {hours.whole}
                <span className="headline-unit">
                  h{hours.minutes > 0 ? ` ${hours.minutes}m` : ""}
                </span>
              </span>
              <span className="headline-label">
                {offlineSource === "device"
                  ? "Progress saved on this device"
                  : measuringSince
                    ? `Listened since ${measuringSince}`
                    : "Listened, all time"}
              </span>
            </div>
            <dl className="headline-secondary">
              <div>
                <dt>Books finished</dt>
                <dd>{displayedStats.booksFinished}</dd>
              </div>
              {offlineSource === "device" ? (
                <>
                  <div>
                    <dt>In progress</dt>
                    <dd>{deviceInProgress}</dd>
                  </div>
                  <div>
                    <dt>Books on shelf</dt>
                    <dd>{books.length}</dd>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <dt>Current streak</dt>
                    <dd>
                      {displayedStats.currentStreakDays}
                      <span className="dd-unit">d</span>
                    </dd>
                  </div>
                  <div>
                    <dt>Longest streak</dt>
                    <dd>
                      {displayedStats.longestStreakDays}
                      <span className="dd-unit">d</span>
                    </dd>
                  </div>
                  <div>
                    <dt>Per active day</dt>
                    <dd>
                      {Math.round(displayedStats.avgDailyMinutes)}
                      <span className="dd-unit">m</span>
                    </dd>
                  </div>
                </>
              )}
            </dl>
          </section>

          {offlineSource !== "device" ? <section className="profile-calendar">
            <header>
              <h2>Listening habits</h2>
              <span>Last 8 weeks</span>
            </header>
            <div className="calendar-grid">
              <div className="calendar-weekdays" aria-hidden="true">
                <span>M</span>
                <span>T</span>
                <span>W</span>
                <span>T</span>
                <span>F</span>
                <span>S</span>
                <span>S</span>
              </div>
              <div className="calendar-weeks">
                {weeks.map((week, index) => (
                  <div className="calendar-week" key={index}>
                    {week.map((day) => {
                      const tier =
                        day.minutes <= 0 ? 0 : Math.min(4, Math.ceil(day.minutes / 20));
                      return (
                        <button
                          type="button"
                          key={day.date}
                          className={`calendar-cell tier-${tier}`}
                          aria-label={`${day.date}: ${Math.round(day.minutes)} minutes listened`}
                          aria-pressed={selectedDay?.date === day.date}
                          title={`${day.date} · ${Math.round(day.minutes)} min`}
                          onClick={() => setSelectedDay(day)}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
            <div className="calendar-footer">
              <p aria-live="polite">{selectedDay
                ? `${selectedDay.date} · ${Math.round(selectedDay.minutes)} minutes listened`
                : "Select a day to see your listening time."}</p>
              <div className="calendar-legend" aria-label="Color intensity indicates listening time">
                <span>Less</span>{[0, 1, 2, 3, 4].map(tier => <i key={tier} className={`calendar-cell tier-${tier}`} />)}<span>More</span>
              </div>
            </div>
          </section> : null}

          {(displayedStats.favoriteNarrator || displayedStats.favoriteGenre) && (
            <section className="profile-favorites">
              {displayedStats.favoriteNarrator ? (
                <div>
                  <span>Most-listened narrator</span>
                  <strong>{displayedStats.favoriteNarrator}</strong>
                </div>
              ) : null}
              {displayedStats.favoriteGenre ? (
                <div>
                  <span>Most-listened genre</span>
                  <strong>{displayedStats.favoriteGenre}</strong>
                </div>
              ) : null}
            </section>
          )}

          <Achievements
            books={books}
            stats={displayedStats}
            user={user}
            onOpenBook={onOpenBook}
            includeDeviceBooks={offlineSource === "device"}
            rivalriesAvailable={offlineSource === null}
          />

          {displayedStats.recentBooks.length > 0 ? (
            <section className="profile-recent">
              <header>
                <h2>Recent</h2>
              </header>
              <ul>
                {displayedStats.recentBooks.map((book) => (
                  <RecentRow
                    key={book.id}
                    book={book}
                    cachedBook={books.find((candidate) => candidate.id === book.id)}
                    onOpen={() => onOpenBook(book.id)}
                  />
                ))}
              </ul>
            </section>
          ) : null}

          {sharingAvailable ? (
            <ProgressSharingCard
              user={user}
              onUserChanged={onUserChanged}
              onSharingChanged={onSharingChanged}
            />
          ) : null}
        </>
      ) : null}
      </article>
    </main>
  );
}

function RecentRow({
  book,
  cachedBook,
  onOpen
}: {
  book: ProfileRecentBook;
  cachedBook?: Book;
  onOpen: () => void;
}) {
  const [offlineCoverUrl, setOfflineCoverUrl] = useState<string | null>(null);
  const [coverFailed, setCoverFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let resolvedUrl: string | null = null;
    setCoverFailed(false);
    if (cachedBook) {
      void getOfflineCoverUrl(cachedBook).then((url) => {
        resolvedUrl = url;
        if (active) setOfflineCoverUrl(url);
        else releaseOfflineMediaUrl(url);
      }).catch(() => undefined);
    }
    return () => {
      active = false;
      releaseOfflineMediaUrl(resolvedUrl);
    };
  }, [cachedBook]);

  // hoursRead is the furthest point reached in the book, not time at the
  // headphones — a scrub forward moves it without any listening. Word it as a
  // position so it cannot be read as a second, contradictory listening total.
  const hours = book.hoursRead;
  const tail =
    hours < 0.05
      ? "Just started"
      : hours < 1
        ? `${Math.round(hours * 60)} min in`
        : `${hours.toFixed(1)} hrs in`;
  return (
    <li>
      <button type="button" className="recent-row" onClick={onOpen}>
        {(offlineCoverUrl || book.coverArtUrl) && !coverFailed ? (
          <img
            className="recent-cover"
            src={offlineCoverUrl ?? mediaUrl(book.coverArtUrl!)}
            alt=""
            onError={() => setCoverFailed(true)}
          />
        ) : (
          <span className="recent-cover placeholder" aria-hidden="true">
            <Headphones size={18} strokeWidth={1.25} />
          </span>
        )}
        <span className="recent-text">
          <strong>{book.title}</strong>
          <span>{tail}{book.finished ? " · finished" : ""}</span>
        </span>
        <span className="recent-time">{relativeTime(book.updatedAt) ?? ""}</span>
      </button>
    </li>
  );
}
