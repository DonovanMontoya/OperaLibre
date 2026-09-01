//! The reading log: what each listener actually did, kept in a form that
//! outlives the files they did it to.
//!
//! Playback progress answers "where am I in this book". It is a single row per
//! listener and book, overwritten on every checkpoint, and it says nothing
//! about *when* the listening happened or how it was spread out. The daily
//! activity totals that used to be the only history here answered "how long
//! did they listen today" and threw away everything else — which book, what
//! hour, how long the sitting was.
//!
//! This module keeps two append-only logs instead.
//!
//! * [`ReadingSession`] rows record one continuous stretch of listening. They
//!   are coalesced in memory from the client's two-second checkpoints and
//!   flushed on a debounce, so a session costs a handful of lines rather than
//!   eighteen hundred an hour.
//! * [`CompletionEvent`] rows record a book being finished, and carry a frozen
//!   [`EditionSnapshot`] of what was finished. That snapshot is the point: a
//!   completion stays legible after the audio is deleted, re-downloaded in a
//!   different encoding, or replaced by another edition entirely.
//!
//! Both logs are append-only rows in the SQLite reading-history store.
//! Appending never rewrites history, so a crash can lose at most the tail of
//! an open session, never a past one.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// A gap longer than this ends the sitting. Ten minutes is comfortably longer
/// than a pause to make tea and comfortably shorter than "picked the book back
/// up after dinner", which should read as two sessions.
pub const SESSION_GAP_SECONDS: u64 = 10 * 60;

/// How soon an open session is first written through to disk.
///
/// Every flush appends a superseded revision, so a fixed interval makes write
/// volume grow with the length of the sitting: an hourly flush cadence over a
/// three-hour book is a hundred and eighty rows to store and then compact away.
/// The interval instead backs off from here to [`SESSION_FLUSH_MAX_SECONDS`],
/// which turns that same sitting into a handful of rows.
pub const SESSION_FLUSH_SECONDS: u64 = 60;

/// The ceiling the flush interval backs off to.
///
/// This bounds what a hard crash costs: the detail of the sitting in progress,
/// back to its last revision. It never costs the reader their place — playback
/// progress is written on its own two-second cadence and is untouched by this —
/// so trading a quarter hour of session detail for a twentyfold cut in write
/// volume is the right way round.
pub const SESSION_FLUSH_MAX_SECONDS: u64 = 15 * 60;

/// Sessions shorter than this are not worth a row. A listener who opens a book,
/// hears three seconds, and closes it has not had a reading session.
pub const MIN_SESSION_SECONDS: f64 = 5.0;

/// One continuous stretch of listening by one reader in one book.
///
/// Rows are revisions: an open session is flushed repeatedly under the same
/// `id`, and the copy with the highest `ended_at_ms` wins. [`compact_sessions`]
/// drops the superseded ones.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingSession {
    pub id: String,
    pub user_id: String,
    pub book_id: String,
    /// The work this book was an edition of, when one is known. Sessions keep
    /// their own copy so a later re-link cannot rewrite what was recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_id: Option<String>,
    pub started_at_ms: u64,
    pub ended_at_ms: u64,
    /// Seconds of audio actually heard, summed from validated forward position
    /// movement. Never wall-clock time, and never movement from a seek.
    pub listened_seconds: f64,
    /// Whole-book positions at the ends of the sitting, so a session can say
    /// where in the book it happened and not merely how long it ran.
    pub start_position_seconds: f64,
    pub end_position_seconds: f64,
    /// Playback rate reported by the client, when it reports one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    /// `web`, `android`, `ios`, or whatever else a client calls itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    /// The listener's offset from UTC when the session started, so the hour of
    /// day is theirs and not the server's.
    #[serde(default)]
    pub tz_offset_minutes: i64,
    /// The listener's calendar day the session started on, denormalized so a
    /// day rollup never has to redo the timezone arithmetic.
    pub started_on: String,
}

impl ReadingSession {
    /// Whether a checkpoint at this moment continues the sitting or starts a
    /// new one.
    ///
    /// A checkpoint stamped *before* the session's end is not a new sitting —
    /// session times come from the monotonic progress revision, which runs
    /// ahead of the wall clock whenever writes arrive faster than one a
    /// millisecond, so a moment slightly in the past is ordinary. Only the size
    /// of a forward gap ends a sitting.
    pub fn accepts(&self, at_ms: u64) -> bool {
        self.idle_for_ms(at_ms) <= SESSION_GAP_SECONDS.saturating_mul(1_000)
    }

    /// How long this sitting has been quiet as of `at_ms`. Zero when `at_ms`
    /// precedes the last checkpoint.
    pub fn idle_for_ms(&self, at_ms: u64) -> u64 {
        at_ms.saturating_sub(self.ended_at_ms)
    }

    /// A session worth keeping. The floor is on listened audio rather than
    /// elapsed time so a sitting spent mostly paused does not qualify.
    pub fn is_substantive(&self) -> bool {
        self.listened_seconds >= MIN_SESSION_SECONDS
    }
}

/// What a reader finished, frozen at the moment they finished it.
///
/// Everything here is copied out of the library rather than referenced into it.
/// A completion has to stay readable when the book it describes is gone from
/// disk, which rules out holding a book id and looking the rest up later.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditionSnapshot {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub narrator: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isbn: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series_position: Option<String>,
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default)]
    pub track_count: usize,
}

/// How a completion came to be recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompletionSource {
    /// The listener reached the end and the server derived it.
    Reached,
    /// A legacy event created when marking a book finished also implied it was
    /// finished that day. Kept so existing history remains readable; new
    /// status-only changes do not create completion events.
    Marked,
}

/// A book being finished. Immutable once written: a later re-read appends a
/// second event rather than replacing the first.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionEvent {
    pub id: String,
    pub user_id: String,
    pub book_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_id: Option<String>,
    pub finished_at_ms: u64,
    pub source: CompletionSource,
    #[serde(default)]
    pub tz_offset_minutes: i64,
    pub finished_on: String,
    pub snapshot: EditionSnapshot,
}

/// The persisted part of the reading log. Open sessions remain in request
/// handling; completed sessions and completion events live in SQLite's
/// document store so the server's durable state has one backend.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingHistory {
    #[serde(default)]
    pub sessions: Vec<ReadingSession>,
    #[serde(default)]
    pub completions: Vec<CompletionEvent>,
    /// Per reader, the id of the newest completion event they have seen in the
    /// finish feed; everything after it is what the feed badges as new.
    #[serde(default)]
    pub finish_seen: HashMap<String, String>,
}

/// Sessions still accumulating, keyed by listener and book. An entry lives here
/// between checkpoints and is flushed to disk on a debounce and on close.
#[derive(Debug, Default)]
pub struct OpenSessions {
    sessions: HashMap<String, OpenSession>,
}

#[derive(Debug, Clone)]
struct OpenSession {
    session: ReadingSession,
    /// When this session was last written through to disk, so the debounce can
    /// tell an unsaved change from a saved one.
    flushed_at_ms: u64,
    /// How long to wait before the next write-through. Doubles after each one,
    /// so a long sitting costs a logarithmic number of revisions instead of a
    /// linear one.
    flush_interval_ms: u64,
    /// Whether anything has changed since the last write-through. Cleared on
    /// every flush, so a sitting that closes without further checkpoints is not
    /// appended a second time identical to the row already on disk.
    dirty: bool,
}

/// What the caller should do after folding a checkpoint in.
#[derive(Debug, Clone, PartialEq)]
pub enum SessionOutcome {
    /// Nothing needs writing yet.
    Buffered,
    /// These rows should be appended. A closed session and its replacement can
    /// both appear, in that order.
    Append(Vec<ReadingSession>),
}

/// Everything a checkpoint contributes to the log.
#[derive(Debug, Clone)]
pub struct Checkpoint {
    pub user_id: String,
    pub book_id: String,
    pub work_id: Option<String>,
    pub at_ms: u64,
    pub listened_seconds: f64,
    pub position_seconds: f64,
    pub speed: Option<f64>,
    pub client: Option<String>,
    pub tz_offset_minutes: i64,
    /// The listener's calendar day, computed by the caller because the civil
    /// date helpers live beside the rest of the stats code.
    pub today: String,
}

fn session_key(user_id: &str, book_id: &str) -> String {
    format!("{user_id}\u{1f}{book_id}")
}

impl OpenSessions {
    /// Folds one checkpoint into the open session for this listener and book,
    /// starting a new session when the gap is too long.
    ///
    /// Returns the rows to append. A checkpoint normally returns nothing: rows
    /// are produced when a session closes, and on the flush debounce so a crash
    /// cannot cost more than [`SESSION_FLUSH_SECONDS`] of an open sitting.
    pub fn record(
        &mut self,
        checkpoint: Checkpoint,
        new_id: impl FnOnce() -> String,
    ) -> SessionOutcome {
        let key = session_key(&checkpoint.user_id, &checkpoint.book_id);
        let mut rows = Vec::new();

        // An existing session that this checkpoint cannot extend is finished.
        // Flush it before the replacement so the log stays ordered.
        if let Some(open) = self.sessions.get(&key)
            && !open.session.accepts(checkpoint.at_ms)
        {
            let closed = self.sessions.remove(&key).expect("checked above");
            if closed.dirty && closed.session.is_substantive() {
                rows.push(closed.session);
            }
        }

        match self.sessions.get_mut(&key) {
            Some(open) => {
                open.session.ended_at_ms = checkpoint.at_ms;
                open.session.listened_seconds += checkpoint.listened_seconds;
                open.session.end_position_seconds = checkpoint.position_seconds;
                if checkpoint.speed.is_some() {
                    open.session.speed = checkpoint.speed;
                }
                if checkpoint.client.is_some() {
                    open.session.client = checkpoint.client;
                }
                open.dirty = true;
                let due =
                    checkpoint.at_ms.saturating_sub(open.flushed_at_ms) >= open.flush_interval_ms;
                if due && open.session.is_substantive() {
                    open.flushed_at_ms = checkpoint.at_ms;
                    open.flush_interval_ms = open
                        .flush_interval_ms
                        .saturating_mul(2)
                        .min(SESSION_FLUSH_MAX_SECONDS.saturating_mul(1_000));
                    open.dirty = false;
                    rows.push(open.session.clone());
                }
            }
            None => {
                let session = ReadingSession {
                    id: new_id(),
                    user_id: checkpoint.user_id,
                    book_id: checkpoint.book_id,
                    work_id: checkpoint.work_id,
                    started_at_ms: checkpoint.at_ms,
                    ended_at_ms: checkpoint.at_ms,
                    listened_seconds: checkpoint.listened_seconds,
                    // The sitting began where the listener was before this
                    // checkpoint moved them, not where it left them.
                    start_position_seconds: (checkpoint.position_seconds
                        - checkpoint.listened_seconds)
                        .max(0.0),
                    end_position_seconds: checkpoint.position_seconds,
                    speed: checkpoint.speed,
                    client: checkpoint.client,
                    tz_offset_minutes: checkpoint.tz_offset_minutes,
                    started_on: checkpoint.today,
                };
                self.sessions.insert(
                    key,
                    OpenSession {
                        session,
                        flushed_at_ms: checkpoint.at_ms,
                        flush_interval_ms: SESSION_FLUSH_SECONDS.saturating_mul(1_000),
                        dirty: true,
                    },
                );
            }
        }

        if rows.is_empty() {
            SessionOutcome::Buffered
        } else {
            SessionOutcome::Append(rows)
        }
    }

    /// Closes every session that has gone quiet, returning the rows to append.
    /// Called on a timer so a listener who simply stops does not leave a
    /// session open until their next checkpoint.
    pub fn close_idle(&mut self, now_ms: u64) -> Vec<ReadingSession> {
        let stale = self
            .sessions
            .iter()
            .filter(|(_, open)| !open.session.accepts(now_ms))
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        stale
            .into_iter()
            .filter_map(|key| self.sessions.remove(&key))
            .filter(|open| open.dirty && open.session.is_substantive())
            .map(|open| open.session)
            .collect()
    }

    /// Closes everything, for shutdown.
    pub fn drain(&mut self) -> Vec<ReadingSession> {
        self.sessions
            .drain()
            .map(|(_, open)| open)
            .filter(|open| open.dirty && open.session.is_substantive())
            .map(|open| open.session)
            .collect()
    }

    /// Drops every buffered sitting belonging to one reader, so a deleted
    /// account's history cannot be flushed to disk after the logs are purged.
    pub fn forget_user(&mut self, user_id: &str) {
        self.sessions
            .retain(|_, open| open.session.user_id != user_id);
    }

    /// Every open session, so tests can assert what is still buffered.
    #[cfg(test)]
    pub fn iter(&self) -> impl Iterator<Item = &ReadingSession> {
        self.sessions.values().map(|open| &open.session)
    }
}

/// Collapses session revisions to one row each, keeping the latest.
///
/// Flushing an open session repeatedly under the same id is what makes a crash
/// cheap; this is where that cost is paid back. Order is preserved by first
/// appearance so a compacted log still reads chronologically.
pub fn compact_sessions(rows: Vec<ReadingSession>) -> Vec<ReadingSession> {
    let mut order: Vec<String> = Vec::new();
    let mut latest: HashMap<String, ReadingSession> = HashMap::new();
    for row in rows {
        match latest.get(&row.id) {
            Some(existing) if existing.ended_at_ms >= row.ended_at_ms => {}
            Some(_) => {
                latest.insert(row.id.clone(), row);
            }
            None => {
                order.push(row.id.clone());
                latest.insert(row.id.clone(), row);
            }
        }
    }
    order
        .into_iter()
        .filter_map(|id| latest.remove(&id))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checkpoint(at_ms: u64, listened: f64, position: f64) -> Checkpoint {
        Checkpoint {
            user_id: "reader".to_string(),
            book_id: "odyssey".to_string(),
            work_id: None,
            at_ms,
            listened_seconds: listened,
            position_seconds: position,
            speed: Some(1.0),
            client: Some("web".to_string()),
            tz_offset_minutes: 0,
            today: "2026-08-19".to_string(),
        }
    }

    fn ids() -> impl FnMut() -> String {
        let mut counter = 0;
        move || {
            counter += 1;
            format!("session-{counter}")
        }
    }

    #[test]
    fn checkpoints_inside_the_gap_coalesce_into_one_session() {
        let mut open = OpenSessions::default();
        let mut next_id = ids();
        for step in 0..10 {
            let at = 1_000_000 + step * 2_000;
            let outcome = open.record(checkpoint(at, 2.0, 2.0 * (step + 1) as f64), &mut next_id);
            assert_eq!(outcome, SessionOutcome::Buffered);
        }
        let closed = open.drain();
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0].listened_seconds, 20.0);
        assert_eq!(closed[0].start_position_seconds, 0.0);
        assert_eq!(closed[0].end_position_seconds, 20.0);
    }

    #[test]
    fn a_long_gap_starts_a_second_session() {
        let mut open = OpenSessions::default();
        let mut next_id = ids();
        open.record(checkpoint(1_000_000, 30.0, 30.0), &mut next_id);
        let after_gap = 1_000_000 + (SESSION_GAP_SECONDS + 60) * 1_000;
        let outcome = open.record(checkpoint(after_gap, 30.0, 60.0), &mut next_id);
        match outcome {
            SessionOutcome::Append(rows) => {
                assert_eq!(rows.len(), 1);
                assert_eq!(rows[0].id, "session-1");
                assert_eq!(rows[0].listened_seconds, 30.0);
            }
            other => panic!("expected the first session to close, got {other:?}"),
        }
        let closed = open.drain();
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0].id, "session-2");
    }

    #[test]
    fn an_open_session_is_flushed_on_the_debounce() {
        let mut open = OpenSessions::default();
        let mut next_id = ids();
        open.record(checkpoint(1_000_000, 10.0, 10.0), &mut next_id);
        let due = 1_000_000 + SESSION_FLUSH_SECONDS * 1_000;
        match open.record(checkpoint(due, 50.0, 60.0), &mut next_id) {
            SessionOutcome::Append(rows) => {
                assert_eq!(rows.len(), 1);
                assert_eq!(rows[0].id, "session-1");
                assert_eq!(rows[0].listened_seconds, 60.0);
            }
            other => panic!("expected a debounced flush, got {other:?}"),
        }
        // The session stays open and keeps accumulating after the flush.
        assert_eq!(open.iter().count(), 1);
    }

    #[test]
    fn a_glance_at_a_book_is_not_a_session() {
        let mut open = OpenSessions::default();
        let mut next_id = ids();
        open.record(checkpoint(1_000_000, 2.0, 2.0), &mut next_id);
        assert!(open.drain().is_empty());
    }

    fn dated_session(id: &str, started_on: &str) -> ReadingSession {
        ReadingSession {
            id: id.to_string(),
            user_id: "reader".to_string(),
            book_id: "book".to_string(),
            work_id: None,
            started_at_ms: 1_000,
            ended_at_ms: 2_000,
            listened_seconds: 600.0,
            start_position_seconds: 0.0,
            end_position_seconds: 600.0,
            speed: None,
            client: None,
            tz_offset_minutes: 0,
            started_on: started_on.to_string(),
        }
    }

    #[test]
    fn a_long_sitting_costs_a_handful_of_revisions_not_hundreds() {
        let mut open = OpenSessions::default();
        let mut next_id = ids();
        let start = 1_000_000u64;
        let mut flushes = 0;
        // Three hours of listening, checkpointed every two seconds as a real
        // client does.
        for step in 1..=5_400u64 {
            let at = start + step * 2_000;
            if let SessionOutcome::Append(rows) =
                open.record(checkpoint(at, 2.0, 2.0 * step as f64), &mut next_id)
            {
                flushes += rows.len();
            }
        }
        // A fixed sixty-second cadence would have written 180 revisions here.
        // The backoff settles at one every fifteen minutes, so three hours
        // costs about fifteen rows — roughly five kilobytes before compaction.
        assert!(
            flushes <= 20,
            "a three-hour sitting should back off to a few revisions, got {flushes}"
        );
        assert!(
            flushes >= 5,
            "revisions must still be written, got {flushes}"
        );
        // And the whole sitting is still one session.
        assert_eq!(open.drain().len(), 1);
    }

    /// A year of daily reading, end to end, measured rather than estimated.
    ///
    /// This is the guard on the whole design: if a change makes sessions cost
    /// meaningfully more per year, this is where it shows up.
    #[test]
    fn a_year_of_daily_reading_stays_small_on_disk() {
        let mut open = OpenSessions::default();
        let mut counter = 0u64;
        let mut next_id = || {
            counter += 1;
            format!("session-{counter}")
        };
        let day_ms = 86_400_000u64;
        let mut appended = Vec::new();

        // Three one-hour sittings a day for a year, checkpointed a minute apart.
        for day in 0..365u64 {
            for sitting in 0..3u64 {
                let base = day * day_ms + sitting * 4 * 3_600_000 + 1_000_000_000;
                for minute in 1..=60u64 {
                    let at = base + minute * 60_000;
                    if let SessionOutcome::Append(rows) = open.record(
                        Checkpoint {
                            user_id: "reader".to_string(),
                            book_id: format!("book-{}", day / 14),
                            work_id: Some(format!("work-{}", day / 14)),
                            at_ms: at,
                            listened_seconds: 60.0,
                            position_seconds: minute as f64 * 60.0,
                            speed: Some(1.0),
                            client: Some("web".to_string()),
                            tz_offset_minutes: 0,
                            today: "2026-08-19".to_string(),
                        },
                        &mut next_id,
                    ) {
                        appended.extend(rows);
                    }
                }
            }
        }
        appended.extend(open.drain());

        let raw_bytes = appended
            .iter()
            .map(|row| serde_json::to_string(row).unwrap().len() + 1)
            .sum::<usize>();
        let sessions = compact_sessions(appended);
        let compacted_bytes = sessions
            .iter()
            .map(|row| serde_json::to_string(row).unwrap().len() + 1)
            .sum::<usize>();

        assert_eq!(
            sessions.len(),
            365 * 3,
            "one row per sitting once compacted"
        );
        // Roughly a third of a megabyte a year for a reader who reads three
        // hours every single day. Generous headroom over the measured figure so
        // this fails on a regression, not on a rounding change.
        assert!(
            compacted_bytes < 600_000,
            "a year of daily reading should compact to well under a megabyte, got \
             {compacted_bytes} bytes (was {raw_bytes} before compaction)"
        );
        eprintln!(
            "a year of three-hours-a-day reading: {raw_bytes} bytes raw, {compacted_bytes} bytes \
             compacted, {} sessions",
            sessions.len()
        );
    }

    #[test]
    fn a_checkpoint_stamped_before_the_last_one_still_continues_the_sitting() {
        // Session times come from the monotonic progress revision, which runs
        // ahead of the wall clock after a burst of writes. A moment slightly in
        // the past is ordinary, not a new sitting.
        let session = dated_session("a", "2026-08-19");
        assert!(session.accepts(session.ended_at_ms - 1));
        assert!(session.accepts(session.ended_at_ms));
        assert!(
            !session.accepts(session.ended_at_ms + SESSION_GAP_SECONDS.saturating_mul(1_000) + 1)
        );
    }

    #[test]
    fn a_sitting_whose_clock_ran_ahead_is_not_swept_as_idle() {
        let mut open = OpenSessions::default();
        let mut next_id = ids();
        let at = 1_000_000_000u64;
        open.record(checkpoint(at, 60.0, 60.0), &mut next_id);
        // The sweeper ticks with a wall clock a few hundred milliseconds behind
        // the revision the checkpoint carried.
        assert!(
            open.close_idle(at - 500).is_empty(),
            "a session in the future is not an idle one"
        );
        assert_eq!(open.iter().count(), 1);
    }

    #[test]
    fn an_unchanged_sitting_is_not_appended_twice() {
        let mut open = OpenSessions::default();
        let mut next_id = ids();
        open.record(checkpoint(1_000_000, 10.0, 10.0), &mut next_id);
        let due = 1_000_000 + SESSION_FLUSH_SECONDS * 1_000;
        let flushed = match open.record(checkpoint(due, 50.0, 60.0), &mut next_id) {
            SessionOutcome::Append(rows) => rows,
            other => panic!("expected a flush, got {other:?}"),
        };
        assert_eq!(flushed.len(), 1);
        // Nothing has changed since that flush, so closing writes nothing more.
        assert!(
            open.drain().is_empty(),
            "a sitting already on disk unchanged must not be written again"
        );
    }

    #[test]
    fn compaction_keeps_the_latest_revision_in_original_order() {
        let base = ReadingSession {
            id: "a".to_string(),
            user_id: "reader".to_string(),
            book_id: "odyssey".to_string(),
            work_id: None,
            started_at_ms: 1_000,
            ended_at_ms: 2_000,
            listened_seconds: 10.0,
            start_position_seconds: 0.0,
            end_position_seconds: 10.0,
            speed: None,
            client: None,
            tz_offset_minutes: 0,
            started_on: "2026-08-19".to_string(),
        };
        let mut later = base.clone();
        later.ended_at_ms = 9_000;
        later.listened_seconds = 90.0;
        let mut other = base.clone();
        other.id = "b".to_string();

        let compacted = compact_sessions(vec![base, other, later]);
        assert_eq!(compacted.len(), 2);
        assert_eq!(compacted[0].id, "a");
        assert_eq!(compacted[0].listened_seconds, 90.0);
        assert_eq!(compacted[1].id, "b");
    }

    #[test]
    fn idle_sessions_close_without_a_further_checkpoint() {
        let mut open = OpenSessions::default();
        let mut next_id = ids();
        open.record(checkpoint(1_000_000, 60.0, 60.0), &mut next_id);
        assert!(open.close_idle(1_000_000 + 60_000).is_empty());
        let closed = open.close_idle(1_000_000 + (SESSION_GAP_SECONDS + 5) * 1_000);
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0].listened_seconds, 60.0);
    }
}
