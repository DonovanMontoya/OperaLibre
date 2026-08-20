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
//! Both logs are newline-delimited JSON. Appending never rewrites history, so a
//! crash can lose at most the tail of an open session, never a past one.

use std::collections::HashMap;
use std::io;
use std::path::Path as FsPath;

use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio::io::AsyncWriteExt;

/// A gap longer than this ends the sitting. Ten minutes is comfortably longer
/// than a pause to make tea and comfortably shorter than "picked the book back
/// up after dinner", which should read as two sessions.
pub const SESSION_GAP_SECONDS: u64 = 10 * 60;

/// How often an open session is written through to disk. A crash loses at most
/// this much of the session in progress; every earlier session is already
/// durable. Sixty seconds keeps a long book to about one line a minute before
/// compaction, which then collapses them to one.
pub const SESSION_FLUSH_SECONDS: u64 = 60;

/// Sessions shorter than this are not worth a row. A listener who opens a book,
/// hears three seconds, and closes it has not had a reading session.
pub const MIN_SESSION_SECONDS: f64 = 5.0;

/// Compaction rewrites the log without superseded revisions. It runs at startup
/// and whenever the line count passes this, so the file tracks the number of
/// real sessions rather than the number of flushes.
pub const COMPACTION_LINE_THRESHOLD: usize = 4_096;

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
    pub fn accepts(&self, at_ms: u64) -> bool {
        at_ms >= self.ended_at_ms
            && (at_ms - self.ended_at_ms) <= SESSION_GAP_SECONDS.saturating_mul(1_000)
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
    /// The listener marked the book finished themselves.
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
                let due = checkpoint.at_ms.saturating_sub(open.flushed_at_ms)
                    >= SESSION_FLUSH_SECONDS.saturating_mul(1_000);
                if due && open.session.is_substantive() {
                    open.flushed_at_ms = checkpoint.at_ms;
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

    /// Every open session, for folding into a stats read.
    pub fn iter(&self) -> impl Iterator<Item = &ReadingSession> {
        self.sessions.values().map(|open| &open.session)
    }
}

/// Appends newline-delimited JSON rows, creating the file if it is missing.
///
/// Opened in append mode for each write rather than held open: these writes are
/// a minute apart at most, and a long-lived handle would have to be revalidated
/// after any external rotation of the file anyway.
async fn append_lines<T: Serialize>(path: &FsPath, rows: &[T]) -> io::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let mut buffer = String::new();
    for row in rows {
        match serde_json::to_string(row) {
            Ok(line) => {
                buffer.push_str(&line);
                buffer.push('\n');
            }
            // One unserializable row must not cost the rest of the batch.
            Err(error) => tracing::warn!("skipping unserializable reading-log row: {error}"),
        }
    }
    if buffer.is_empty() {
        return Ok(());
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await?;
    file.write_all(buffer.as_bytes()).await?;
    file.flush().await?;
    Ok(())
}

/// Reads newline-delimited JSON, skipping rows that will not parse.
///
/// A log is history: a single corrupt line — a torn write, a hand edit, a row
/// written by a future build with another shape — must cost that line and not
/// the reader's entire past.
async fn read_lines<T: for<'a> Deserialize<'a>>(path: &FsPath) -> io::Result<Vec<T>> {
    let contents = match fs::read_to_string(path).await {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut rows = Vec::new();
    let mut skipped = 0usize;
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str(line) {
            Ok(row) => rows.push(row),
            Err(_) => skipped += 1,
        }
    }
    if skipped > 0 {
        tracing::warn!("skipped {skipped} unreadable row(s) in {}", path.display());
    }
    Ok(rows)
}

pub async fn append_sessions(path: &FsPath, rows: &[ReadingSession]) -> io::Result<()> {
    append_lines(path, rows).await
}

pub async fn append_completion(path: &FsPath, event: &CompletionEvent) -> io::Result<()> {
    append_lines(path, std::slice::from_ref(event)).await
}

pub async fn read_sessions(path: &FsPath) -> io::Result<Vec<ReadingSession>> {
    Ok(compact_sessions(read_lines(path).await?))
}

pub async fn read_completions(path: &FsPath) -> io::Result<Vec<CompletionEvent>> {
    Ok(dedupe_completions(read_lines(path).await?))
}

/// Collapses session revisions to one row each, keeping the latest.
///
/// Flushing an open session repeatedly under the same id is what makes a crash
/// cheap; this is where that cost is paid back. Order is preserved by first
/// appearance so a compacted file still reads chronologically.
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

/// Drops repeated completion rows. Events are append-only and never revised, so
/// a duplicate id can only come from a retried write.
fn dedupe_completions(rows: Vec<CompletionEvent>) -> Vec<CompletionEvent> {
    let mut seen = std::collections::HashSet::new();
    rows.into_iter()
        .filter(|row| seen.insert(row.id.clone()))
        .collect()
}

/// Removes one reader from both logs, for account deletion.
///
/// Rewrites rather than appends a tombstone: a deleted account's history has to
/// actually leave the disk, not merely stop being served. Each file is written
/// to a sibling temporary and renamed into place, so an interrupted purge
/// leaves the original intact rather than a half-written one.
pub async fn forget_user(
    sessions_path: &FsPath,
    completions_path: &FsPath,
    user_id: &str,
) -> io::Result<()> {
    let sessions: Vec<ReadingSession> = read_lines(sessions_path).await?;
    let kept = sessions
        .into_iter()
        .filter(|row| row.user_id != user_id)
        .collect::<Vec<_>>();
    rewrite(sessions_path, &kept).await?;

    let completions: Vec<CompletionEvent> = read_lines(completions_path).await?;
    let kept = completions
        .into_iter()
        .filter(|row| row.user_id != user_id)
        .collect::<Vec<_>>();
    rewrite(completions_path, &kept).await
}

/// Replaces a log with exactly these rows, atomically. A file that never
/// existed and would now be empty is left absent rather than created empty.
async fn rewrite<T: Serialize>(path: &FsPath, rows: &[T]) -> io::Result<()> {
    if rows.is_empty() && !fs::try_exists(path).await.unwrap_or(false) {
        return Ok(());
    }
    let mut buffer = String::new();
    for row in rows {
        if let Ok(line) = serde_json::to_string(row) {
            buffer.push_str(&line);
            buffer.push('\n');
        }
    }
    let temporary = path.with_extension("jsonl.tmp");
    fs::write(&temporary, buffer.as_bytes()).await?;
    fs::rename(&temporary, path).await
}

/// Rewrites the session log without superseded revisions, when it has grown
/// enough to be worth the pass.
///
/// Writes a sibling temporary file and renames it into place, so an interrupted
/// compaction leaves the original log untouched rather than a half-written one.
pub async fn compact_session_log(path: &FsPath) -> io::Result<bool> {
    let raw: Vec<ReadingSession> = read_lines(path).await?;
    if raw.len() < COMPACTION_LINE_THRESHOLD {
        return Ok(false);
    }
    rewrite(path, &compact_sessions(raw)).await?;
    Ok(true)
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
