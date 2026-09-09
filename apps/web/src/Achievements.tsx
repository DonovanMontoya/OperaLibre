import { Award, BookOpen, Check, Compass, Flame, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { readingAchievements, readingRivalries } from "./readingAchievements";
import type { AuthUser, Book, ProfileStats } from "./types";
import { isSharingProgress } from "./sharingSettings";

export function Achievements({
  books,
  stats,
  user,
  onOpenBook,
  includeDeviceBooks = false,
  rivalriesAvailable = true
}: {
  books: Book[];
  stats: ProfileStats;
  user: AuthUser;
  onOpenBook: (id: string) => void;
  includeDeviceBooks?: boolean;
  rivalriesAvailable?: boolean;
}) {
  const [filter, setFilter] = useState("All");
  const achievements = useMemo(
    () => readingAchievements(books, stats, includeDeviceBooks),
    [books, includeDeviceBooks, stats]
  );
  const sharing = isSharingProgress(user);
  const rivalries = useMemo(
    () => readingRivalries(books, user.id, sharing && rivalriesAvailable),
    [books, rivalriesAvailable, user.id, sharing]
  );
  const earned = achievements.filter(
    (item) => item.current >= item.target
  ).length;
  const visible = achievements.filter(
    (item) =>
      filter === "All" ||
      (filter === "Earned"
        ? item.current >= item.target
        : item.current < item.target)
  );
  return (
    <section
      className="ledger-achievements"
      aria-labelledby="achievements-heading"
    >
      <header className="achievements-heading">
        <div>
          <span className="section-label">
            <Award size={14} /> Your reading story
          </span>
          <h2 id="achievements-heading">Small rituals. Epic journeys.</h2>
          <p>Every finished story leaves a mark.</p>
        </div>
        <div className="achievement-tally">
          <strong>
            {earned}
            <span> / {achievements.length}</span>
          </strong>
          <span>achievements earned</span>
        </div>
      </header>
      <div className="achievement-filters" aria-label="Filter achievements">
        {["All", "Earned", "In progress"].map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {value}
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <p className="achievement-note">
          Your collection starts with your next chapter. Explore All to find a
          milestone.
        </p>
      ) : null}
      <div className="achievement-grid">
        {visible.map((item) => {
          const unlocked = item.current >= item.target;
          const Icon =
            item.category === "Exploration"
              ? Compass
              : item.category === "Rituals"
                ? Flame
                : BookOpen;
          return (
            <article
              key={item.id}
              className={`achievement-card ${unlocked ? "is-earned" : ""}`}
            >
              <div className="achievement-card-top">
                <span className="achievement-seal" aria-hidden="true">
                  <Icon size={23} strokeWidth={1.4} />
                </span>
                <span className="achievement-state">
                  {unlocked ? (
                    <>
                      <Check size={12} /> Earned
                    </>
                  ) : (
                    item.category
                  )}
                </span>
              </div>
              <h3>{item.title}</h3>
              <p>{item.description}</p>
              <div className="achievement-progress">
                <progress
                  aria-label={item.title}
                  max={item.target}
                  value={Math.min(item.current, item.target)}
                />
                <span>
                  {Math.floor(Math.min(item.current, item.target))} /{" "}
                  {item.target} {item.unit}
                </span>
              </div>
              {item.evidence ? (
                <button
                  className="achievement-evidence"
                  type="button"
                  onClick={() => onOpenBook(item.evidence!.bookId)}
                >
                  {item.evidence.label} <span aria-hidden="true">↗</span>
                </button>
              ) : null}
            </article>
          );
        })}
      </div>
      <p className="achievement-note">
        Based on your current accessible library and recorded activity.
        Marked-finished books count; metadata and reading-status changes can
        change your collection. Listening hours use measured time.
      </p>
      <section className="ledger-rivalries" aria-labelledby="rivalries-heading">
        <header>
          <Users size={19} />
          <h3 id="rivalries-heading">A little friendly competition</h3>
          <span>{rivalriesAvailable ? "Live standings" : "Online standings"}</span>
        </header>
        <p>
          Share a story. Set the pace. Leads reflect current progress, and can
          change as fellow readers catch up. Series standings count finished
          books in your library.
        </p>
        {!rivalriesAvailable ? (
          <p className="achievement-note">
            Friendly standings return when the server reconnects.
          </p>
        ) : !sharing ? (
          <p className="achievement-note">
            Turn on “Share my reading activity” in Settings to discover fellow
            readers.
          </p>
        ) : rivalries.length === 0 ? (
          <p className="achievement-note">
            Start a book another sharing reader is reading to find your first
            friendly rivalry. Tied readers share the pace.
          </p>
        ) : (
          <ul>
            {rivalries.slice(0, 6).map((rivalry) => (
              <li key={rivalry.id}>
                <button
                  type="button"
                  onClick={() => onOpenBook(rivalry.bookId)}
                >
                  <span className="rivalry-symbol" aria-hidden="true">
                    {rivalry.leading ? "↗" : "→"}
                  </span>
                  <span>
                    <strong>{rivalry.title}</strong>
                    <span>{rivalry.detail}</span>
                  </span>
                  <BookOpen size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
