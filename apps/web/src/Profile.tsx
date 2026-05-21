import {
  ArrowLeft,
  BookCheck,
  Calendar,
  Clock,
  Flame,
  Headphones,
  Library,
  ListMusic,
  Mic2,
  Sparkles,
  Tag,
  TrendingUp,
  Trophy
} from "lucide-react";
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
    return { whole: "0", fraction: "00" };
  }
  const whole = Math.floor(hours);
  const minutes = Math.round((hours - whole) * 60);
  return { whole: whole.toString(), fraction: minutes.toString().padStart(2, "0") };
}

function formatRelative(value: string | null) {
  if (!value) return "—";
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "—";
  }
  const now = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, now - seconds);
  if (delta < 60) return "Moments ago";
  if (delta < 3600) return `${Math.floor(delta / 60)} min ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} hr ago`;
  if (delta < 86400 * 2) return "Yesterday";
  if (delta < 86400 * 7) return `${Math.floor(delta / 86400)} days ago`;
  if (delta < 86400 * 30) return `${Math.floor(delta / 86400 / 7)} wk ago`;
  if (delta < 86400 * 365) return `${Math.floor(delta / 86400 / 30)} mo ago`;
  return `${Math.floor(delta / 86400 / 365)} yr ago`;
}

function formatJoinDate(value: string) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const date = new Date(seconds * 1000);
  return date.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric"
  });
}

function deriveBadges(stats: ProfileStats): { label: string; hint: string; achieved: boolean }[] {
  return [
    {
      label: "First Folio",
      hint: "Finish your first book",
      achieved: stats.booksFinished >= 1
    },
    {
      label: "Marathon Reader",
      hint: "Listen 10+ hours total",
      achieved: stats.totalHoursRead >= 10
    },
    {
      label: "Seven Suns",
      hint: "Listen 7 days in a row",
      achieved: stats.longestStreakDays >= 7
    },
    {
      label: "Collector",
      hint: "Finish five books",
      achieved: stats.booksFinished >= 5
    },
    {
      label: "Devotee",
      hint: "Average 30+ min/day",
      achieved: stats.avgDailyMinutes >= 30
    },
    {
      label: "Centenarian",
      hint: "Complete 100 tracks",
      achieved: stats.totalTracksCompleted >= 100
    }
  ];
}

function StreakStamp({ day }: { day: StreakDay }) {
  const intensity = day.minutes <= 0 ? 0 : Math.min(4, Math.ceil(day.minutes / 15));
  return (
    <span
      className={`streak-stamp tier-${intensity}`}
      title={`${day.date} · ${day.minutes < 1 ? "0" : Math.round(day.minutes)} min`}
      aria-label={`${day.date}: ${Math.round(day.minutes)} minutes`}
    />
  );
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
        if (!cancelled) {
          setStats(next);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load your ledger.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const monogram = user.username.slice(0, 1).toUpperCase();

  const calendarColumns = useMemo<StreakDay[][]>(() => {
    if (!stats) return [];
    const days = [...stats.streakCalendar];
    const columns: StreakDay[][] = [];
    for (let i = 0; i < days.length; i += 7) {
      columns.push(days.slice(i, i + 7));
    }
    return columns;
  }, [stats]);

  const hoursDisplay = stats ? formatHours(stats.totalHoursRead) : { whole: "—", fraction: "00" };
  const badges = stats ? deriveBadges(stats) : [];
  const achievedCount = badges.filter((badge) => badge.achieved).length;

  return (
    <main className="profile-shell">
      <div className="profile-marbling" aria-hidden="true" />
      <header className="profile-bar">
        <button type="button" className="profile-back" onClick={onClose}>
          <ArrowLeft size={15} />
          <span>Back to library</span>
        </button>
        <span className="profile-mark">Reader's Ledger № {user.id.slice(0, 4).toUpperCase()}</span>
      </header>

      {loading ? (
        <section className="profile-loading">
          <span className="eyebrow">
            <Sparkles size={13} /> Compiling your ledger
          </span>
          <p>Smoothing the page, sharpening the quill…</p>
        </section>
      ) : error ? (
        <section className="profile-loading">
          <span className="eyebrow"><Sparkles size={13} /> Trouble at the press</span>
          <p>{error}</p>
        </section>
      ) : stats ? (
        <>
          <section className="profile-hero">
            <div className="profile-monogram" aria-hidden="true">
              <span>{monogram}</span>
              <em>{user.isAdmin ? "Librarian" : "Reader"}</em>
            </div>
            <div className="profile-titles">
              <span className="eyebrow">
                <Trophy size={13} /> Volume I · Entry of {user.username}
              </span>
              <h1>
                <span>The reading life of</span>
                <em>{user.username}</em>
              </h1>
              <p className="profile-bio">
                Bound on {formatJoinDate(user.createdAt)}. Last seen between the pages{" "}
                <strong>{formatRelative(stats.lastListenedAt)}</strong>.
              </p>
              <div className="profile-bio-chips">
                <span>
                  <Calendar size={12} /> {stats.daysActive} day{stats.daysActive === 1 ? "" : "s"} active
                </span>
                <span>
                  <Library size={12} /> {stats.recentBooks.length} on the nightstand
                </span>
                <span>
                  <Trophy size={12} /> {achievedCount}/{badges.length} accolades
                </span>
              </div>
            </div>

            <aside className="profile-hours" aria-label="Total hours read">
              <span className="profile-hours-label">Hours devoted</span>
              <span className="profile-hours-number">
                <span className="whole">{hoursDisplay.whole}</span>
                <span className="frac">.{hoursDisplay.fraction}</span>
              </span>
              <span className="profile-hours-foot">
                {stats.avgDailyMinutes > 0
                  ? `≈ ${Math.round(stats.avgDailyMinutes)} min · daily`
                  : "Begin the first chapter"}
              </span>
            </aside>
          </section>

          <section className="profile-stats">
            <article className="stat-card emphasis">
              <span className="stat-icon"><Flame size={16} /></span>
              <span className="stat-label">Consecutive nights</span>
              <span className="stat-number">{stats.currentStreakDays}</span>
              <span className="stat-foot">
                {stats.currentStreakDays === 0
                  ? "Light a new candle"
                  : stats.currentStreakDays === 1
                    ? "First night kept"
                    : `Longest vigil — ${stats.longestStreakDays}`}
              </span>
            </article>

            <article className="stat-card">
              <span className="stat-icon"><BookCheck size={16} /></span>
              <span className="stat-label">Books finished</span>
              <span className="stat-number">{stats.booksFinished}</span>
              <span className="stat-foot">Volumes closed</span>
            </article>

            <article className="stat-card">
              <span className="stat-icon"><ListMusic size={16} /></span>
              <span className="stat-label">Tracks completed</span>
              <span className="stat-number">{stats.totalTracksCompleted}</span>
              <span className="stat-foot">Pages turned</span>
            </article>

            <article className="stat-card">
              <span className="stat-icon"><Clock size={16} /></span>
              <span className="stat-label">Daily average</span>
              <span className="stat-number">{Math.round(stats.avgDailyMinutes)}</span>
              <span className="stat-foot">minutes / active day</span>
            </article>

            <article className="stat-card wide">
              <span className="stat-icon"><Mic2 size={16} /></span>
              <span className="stat-label">Voice of choice</span>
              <span className="stat-number-text">
                {stats.favoriteNarrator ?? "Yet undeclared"}
              </span>
              <span className="stat-foot">Most-listened narrator</span>
            </article>

            <article className="stat-card wide">
              <span className="stat-icon"><Tag size={16} /></span>
              <span className="stat-label">Genre of the realm</span>
              <span className="stat-number-text">
                {stats.favoriteGenre ?? "Mixed tonics"}
              </span>
              <span className="stat-foot">Hours-weighted favorite</span>
            </article>
          </section>

          <section className="profile-streak">
            <header>
              <span className="eyebrow">
                <Flame size={13} /> Eight weeks of vigil
              </span>
              <h2>The Night Watch</h2>
              <p>Every stamp is a session. Darker stamps are longer nights.</p>
            </header>
            <div className="streak-grid" role="img" aria-label="Eight-week reading heatmap">
              <div className="streak-weekdays" aria-hidden="true">
                <span>M</span>
                <span>T</span>
                <span>W</span>
                <span>T</span>
                <span>F</span>
                <span>S</span>
                <span>S</span>
              </div>
              <div className="streak-columns">
                {calendarColumns.map((column, columnIndex) => (
                  <div className="streak-column" key={columnIndex}>
                    {column.map((day) => (
                      <StreakStamp key={day.date} day={day} />
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <footer className="streak-legend">
              <span>Quiet</span>
              <span className="streak-stamp tier-0" />
              <span className="streak-stamp tier-1" />
              <span className="streak-stamp tier-2" />
              <span className="streak-stamp tier-3" />
              <span className="streak-stamp tier-4" />
              <span>Long sitting</span>
            </footer>
          </section>

          <section className="profile-badges">
            <header>
              <span className="eyebrow"><Trophy size={13} /> Marginalia &amp; medals</span>
              <h2>Accolades</h2>
            </header>
            <div className="badge-grid">
              {badges.map((badge) => (
                <div
                  key={badge.label}
                  className={`badge ${badge.achieved ? "earned" : "locked"}`}
                >
                  <span className="badge-seal" aria-hidden="true">
                    <Trophy size={14} />
                  </span>
                  <strong>{badge.label}</strong>
                  <em>{badge.hint}</em>
                </div>
              ))}
            </div>
          </section>

          <section className="profile-recent">
            <header>
              <span className="eyebrow"><Headphones size={13} /> The nightstand</span>
              <h2>Recently in your ears</h2>
            </header>
            {stats.recentBooks.length === 0 ? (
              <p className="profile-empty">
                No bookmarks yet. Crack the spine on something tonight.
              </p>
            ) : (
              <ul className="recent-list">
                {stats.recentBooks.map((book) => (
                  <RecentRow key={book.id} book={book} onOpen={() => onOpenBook(book.id)} />
                ))}
              </ul>
            )}
          </section>

          <section className="profile-coda">
            <span className="eyebrow"><TrendingUp size={13} /> Coda</span>
            <p>
              At this pace, the next hundred hours arrive in{" "}
              <strong>
                {stats.avgDailyMinutes > 0
                  ? `${Math.ceil((100 - (stats.totalHoursRead % 100)) * 60 / stats.avgDailyMinutes)} days`
                  : "—"}
              </strong>
              . Onward.
            </p>
          </section>
        </>
      ) : null}
    </main>
  );
}

function RecentRow({ book, onOpen }: { book: ProfileRecentBook; onOpen: () => void }) {
  return (
    <li>
      <button type="button" className="recent-row" onClick={onOpen}>
        {book.coverArtUrl ? (
          <img className="cover-mark" src={mediaUrl(book.coverArtUrl)} alt="" />
        ) : (
          <span className="cover-mark" aria-hidden="true">
            <Headphones size={20} strokeWidth={1.25} />
          </span>
        )}
        <span className="recent-meta">
          <strong>{book.title}</strong>
          <span>
            {book.hoursRead < 0.05
              ? "Barely begun"
              : `${book.hoursRead.toFixed(1)} hrs listened`}
            {" · "}
            {formatRelative(book.updatedAt)}
          </span>
        </span>
        <span className={`recent-flag ${book.finished ? "finished" : "ongoing"}`}>
          {book.finished ? "Finished" : "Reading"}
        </span>
      </button>
    </li>
  );
}
