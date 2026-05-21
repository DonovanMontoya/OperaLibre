import { ArrowLeft, Headphones } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getProfileStats, mediaUrl } from "./api";
import type { AuthUser, ProfileRecentBook, ProfileStats, StreakDay } from "./types";

type ProfilePageProps = {
  user: AuthUser;
  onClose: () => void;
  onOpenBook: (bookId: string) => void;
};

function formatHours(hours: number) {
  if (!Number.isFinite(hours) || hours <= 0) {
    return { whole: "0", minutes: 0 };
  }
  const whole = Math.floor(hours);
  const minutes = Math.round((hours - whole) * 60);
  return { whole: whole.toString(), minutes };
}

function relativeTime(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
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

export function ProfilePage({ user, onClose, onOpenBook }: ProfilePageProps) {
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getProfileStats()
      .then((next) => {
        if (!cancelled) setStats(next);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load profile.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const monogram = user.username.slice(0, 1).toUpperCase();

  const weeks = useMemo<StreakDay[][]>(() => {
    if (!stats) return [];
    const days = [...stats.streakCalendar];
    const columns: StreakDay[][] = [];
    for (let i = 0; i < days.length; i += 7) {
      columns.push(days.slice(i, i + 7));
    }
    return columns;
  }, [stats]);

  const joined = joinDate(user.createdAt);
  const lastSeen = stats ? relativeTime(stats.lastListenedAt) : null;
  const hours = stats ? formatHours(stats.totalHoursRead) : { whole: "0", minutes: 0 };

  return (
    <main className="profile-shell" onClick={onClose}>
      <article
        className="profile-page"
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
      ) : stats ? (
        <>
          <header className="profile-head">
            <div className="profile-mono" aria-hidden="true">{monogram}</div>
            <div className="profile-id">
              <h1>{user.username}</h1>
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
              <span className="headline-label">Listened, all time</span>
            </div>
            <dl className="headline-secondary">
              <div>
                <dt>Books finished</dt>
                <dd>{stats.booksFinished}</dd>
              </div>
              <div>
                <dt>Current streak</dt>
                <dd>
                  {stats.currentStreakDays}
                  <span className="dd-unit">d</span>
                </dd>
              </div>
              <div>
                <dt>Longest streak</dt>
                <dd>
                  {stats.longestStreakDays}
                  <span className="dd-unit">d</span>
                </dd>
              </div>
              <div>
                <dt>Per active day</dt>
                <dd>
                  {Math.round(stats.avgDailyMinutes)}
                  <span className="dd-unit">m</span>
                </dd>
              </div>
            </dl>
          </section>

          <section className="profile-calendar">
            <header>
              <h2>Listening</h2>
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
                        <span
                          key={day.date}
                          className={`calendar-cell tier-${tier}`}
                          title={`${day.date} · ${Math.round(day.minutes)} min`}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </section>

          {(stats.favoriteNarrator || stats.favoriteGenre) && (
            <section className="profile-favorites">
              {stats.favoriteNarrator ? (
                <div>
                  <span>Most-listened narrator</span>
                  <strong>{stats.favoriteNarrator}</strong>
                </div>
              ) : null}
              {stats.favoriteGenre ? (
                <div>
                  <span>Most-listened genre</span>
                  <strong>{stats.favoriteGenre}</strong>
                </div>
              ) : null}
            </section>
          )}

          {stats.recentBooks.length > 0 ? (
            <section className="profile-recent">
              <header>
                <h2>Recent</h2>
              </header>
              <ul>
                {stats.recentBooks.map((book) => (
                  <RecentRow key={book.id} book={book} onOpen={() => onOpenBook(book.id)} />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
      </article>
    </main>
  );
}

function RecentRow({ book, onOpen }: { book: ProfileRecentBook; onOpen: () => void }) {
  const hours = book.hoursRead;
  const tail =
    hours < 0.05
      ? "Just started"
      : hours < 1
        ? `${Math.round(hours * 60)} min listened`
        : `${hours.toFixed(1)} hrs listened`;
  return (
    <li>
      <button type="button" className="recent-row" onClick={onOpen}>
        {book.coverArtUrl ? (
          <img className="recent-cover" src={mediaUrl(book.coverArtUrl)} alt="" />
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
