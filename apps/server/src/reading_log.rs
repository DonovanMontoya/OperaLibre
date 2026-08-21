#![allow(dead_code)]
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

/// Below this many lines, a compaction pass is not worth the rewrite. Above it,
/// maintenance collapses revisions so the file tracks the number of real
/// sessions rather than the number of flushes.
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
    // A reading log is a timestamped record of when somebody was awake and
    // listening. It is created owner-only rather than left to the umask, and
    // hardened again afterwards in case it already existed at wider
    // permissions — matching how every other state file here is written.
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).await?;
    file.write_all(buffer.as_bytes()).await?;
    file.flush().await?;
    drop(file);
    harden(path).await
}

/// Restricts a log to its owner. A no-op off Unix.
async fn harden(path: &FsPath) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Reads newline-delimited JSON, skipping rows that will not parse.
///
/// A log is history: a single corrupt line — a torn write, a hand edit, a row
/// written by a future build with another shape — must cost that line and not
/// the reader's entire past.
async fn read_lines<T: for<'a> Deserialize<'a>>(path: &FsPath) -> io::Result<Vec<T>> {
    Ok(read_log(path).await?.rows)
}

/// A log as read: the rows that parsed, and how many lines did not.
///
/// The skip count is not diagnostic decoration. A rewrite reconstructs the file
/// from the parsed rows alone, so it must not run while lines it could not read
/// are present — those lines may be perfectly good history written by a build
/// that knew a field this one does not.
struct LogContents<T> {
    rows: Vec<T>,
    unreadable: usize,
}

async fn read_log<T: for<'a> Deserialize<'a>>(path: &FsPath) -> io::Result<LogContents<T>> {
    let contents = match fs::read_to_string(path).await {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(LogContents {
                rows: Vec::new(),
                unreadable: 0,
            });
        }
        Err(error) => return Err(error),
    };
    let mut rows = Vec::new();
    let mut unreadable = 0usize;
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str(line) {
            Ok(row) => rows.push(row),
            Err(_) => unreadable += 1,
        }
    }
    if unreadable > 0 {
        tracing::warn!(
            "skipped {unreadable} unreadable row(s) in {}",
            path.display()
        );
    }
    Ok(LogContents { rows, unreadable })
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

/// How much history to keep, and how much disk to let it cost.
///
/// Sessions age out; completions do not. That asymmetry is deliberate. The
/// daily activity totals are a separate, permanent, and very cheap archive —
/// about thirty bytes per reader per day — and every lifetime headline number
/// is computed from those, not from this log. So dropping old session rows
/// costs the *texture* of an old year (its hour-of-day pattern, its session
/// lengths, its per-book time) and none of its totals. A completion, by
/// contrast, is the only record that a book was ever read at all, and is small
/// enough that keeping it forever is free.
#[derive(Debug, Clone, Copy)]
pub struct RetentionPolicy {
    /// Drop sessions older than this many days. `None` keeps them for ever.
    pub session_days: Option<u32>,
    /// Hard ceiling on session rows, oldest dropped first. A backstop for a
    /// server whose clock or timezone data makes the age check useless.
    pub session_max_rows: usize,
    /// Hard ceiling on completion rows, oldest dropped first. Set high enough
    /// that reaching it means something has gone wrong rather than that
    /// somebody reads a lot.
    pub completion_max_rows: usize,
}

/// Roughly three years of full-fidelity sessions, and ceilings that work out to
/// about seventy megabytes of sessions and twenty-five of completions — a bound
/// a reader would have to spend decades approaching.
impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            session_days: Some(1_095),
            session_max_rows: 200_000,
            completion_max_rows: 50_000,
        }
    }
}

/// What one maintenance pass did, for the log and for the storage report.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceReport {
    /// Superseded revisions of still-current sessions, collapsed away.
    pub sessions_compacted: usize,
    /// Sessions dropped for being older than the retention window.
    pub sessions_expired: usize,
    /// Sessions dropped to stay under the row ceiling.
    pub sessions_trimmed: usize,
    pub completions_trimmed: usize,
    /// Lines the running build could not parse. Any at all suppresses the
    /// rewrite, because rebuilding the file would delete them.
    pub sessions_unreadable: usize,
    pub completions_unreadable: usize,
    /// Whether anything was actually rewritten. A pass that changes nothing
    /// touches no files.
    pub rewrote_sessions: bool,
    pub rewrote_completions: bool,
}

impl MaintenanceReport {
    pub fn did_work(&self) -> bool {
        self.rewrote_sessions || self.rewrote_completions
    }
}

/// Compacts and prunes both logs in one pass.
///
/// `today_days` is the reader-independent day count the age check measures
/// against; sessions carry the calendar day they started on, so this compares
/// like with like without needing anybody's timezone.
///
/// Nothing is rewritten unless something actually changed, so running this on a
/// timer against a settled log costs one read and no writes.
pub async fn maintain(
    sessions_path: &FsPath,
    completions_path: &FsPath,
    policy: RetentionPolicy,
    today_days: i64,
    day_number: impl Fn(&str) -> Option<i64>,
) -> io::Result<MaintenanceReport> {
    let mut report = MaintenanceReport::default();

    let raw: LogContents<ReadingSession> = read_log(sessions_path).await?;
    // A rewrite would reconstruct the file from the rows below and silently
    // drop everything this build could not parse. That is the right answer for
    // a torn line and the wrong one for history written by a newer build the
    // operator has since rolled back from, and the two are indistinguishable
    // from here. So the pass reports and leaves the file alone.
    report.sessions_unreadable = raw.unreadable;
    let raw_len = raw.rows.len();
    let mut sessions = compact_sessions(raw.rows);
    report.sessions_compacted = raw_len - sessions.len();

    if let Some(days) = policy.session_days {
        let cutoff = today_days - i64::from(days);
        let before = sessions.len();
        sessions.retain(|session| {
            // A row whose day cannot be parsed is kept rather than destroyed:
            // an unreadable date is a reason to leave history alone.
            day_number(&session.started_on).is_none_or(|day| day >= cutoff)
        });
        report.sessions_expired = before - sessions.len();
    }

    if sessions.len() > policy.session_max_rows {
        // Rows are in first-appearance order, which is chronological, so the
        // excess to drop is at the front.
        report.sessions_trimmed = sessions.len() - policy.session_max_rows;
        sessions.drain(0..report.sessions_trimmed);
    }

    if report.sessions_compacted > 0 || report.sessions_expired > 0 || report.sessions_trimmed > 0 {
        // Collapsing a handful of revisions is not worth rewriting a large
        // file; expiring or trimming always is, because that is disk coming
        // back.
        let worth_it = report.sessions_unreadable == 0
            && (report.sessions_expired > 0
                || report.sessions_trimmed > 0
                || raw_len >= COMPACTION_LINE_THRESHOLD);
        if worth_it {
            rewrite(sessions_path, &sessions).await?;
            report.rewrote_sessions = true;
        } else {
            report.sessions_compacted = 0;
            report.sessions_expired = 0;
            report.sessions_trimmed = 0;
        }
    }

    let raw: LogContents<CompletionEvent> = read_log(completions_path).await?;
    report.completions_unreadable = raw.unreadable;
    let raw_len = raw.rows.len();
    let mut completions = dedupe_completions(raw.rows);
    let deduped = raw_len - completions.len();
    if completions.len() > policy.completion_max_rows {
        report.completions_trimmed = completions.len() - policy.completion_max_rows;
        completions.drain(0..report.completions_trimmed);
    }
    if report.completions_unreadable == 0 && (report.completions_trimmed > 0 || deduped > 0) {
        rewrite(completions_path, &completions).await?;
        report.rewrote_completions = true;
    } else {
        report.completions_trimmed = 0;
    }

    Ok(report)
}

/// Bytes and rows one log currently occupies, for the storage report.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFootprint {
    pub bytes: u64,
    pub rows: usize,
}

pub async fn footprint(path: &FsPath) -> LogFootprint {
    let bytes = fs::metadata(path).await.map(|meta| meta.len()).unwrap_or(0);
    let rows = match fs::read_to_string(path).await {
        Ok(contents) => contents
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count(),
        Err(_) => 0,
    };
    LogFootprint { bytes, rows }
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
    // Unlike [`maintain`], this rewrites even when some lines could not be
    // parsed. Maintenance is optional tidying and defers to unreadable history;
    // an account deletion is a promise, and a line this build cannot read is a
    // line it cannot prove belongs to somebody else. Erring towards keeping it
    // would mean retaining data the operator asked to destroy.
    let sessions: LogContents<ReadingSession> = read_log(sessions_path).await?;
    if sessions.unreadable > 0 {
        tracing::warn!(
            "purging a deleted account dropped {} unreadable row(s) from {}",
            sessions.unreadable,
            sessions_path.display()
        );
    }
    let sessions = sessions.rows;
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
    // Written to a fresh sibling and renamed into place, so an interrupted
    // rewrite leaves the original intact. `create_new` refuses to follow a
    // pre-existing path, and the mode is set at creation rather than after, so
    // the replacement is never briefly readable by anybody else.
    let temporary = path.with_extension("jsonl.tmp");
    let _ = fs::remove_file(&temporary).await;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&temporary).await?;
    file.write_all(buffer.as_bytes()).await?;
    file.flush().await?;
    drop(file);
    if let Err(error) = fs::rename(&temporary, path).await {
        let _ = fs::remove_file(&temporary).await;
        return Err(error);
    }
    harden(path).await
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

    fn ymd_days(ymd: &str) -> Option<i64> {
        let mut parts = ymd.split('-');
        let y: i64 = parts.next()?.parse().ok()?;
        let m: i64 = parts.next()?.parse().ok()?;
        let d: i64 = parts.next()?.parse().ok()?;
        let y_adj = if m <= 2 { y - 1 } else { y };
        let era = y_adj.div_euclid(400);
        let yoe = y_adj.rem_euclid(400);
        let m_adj = if m > 2 { m - 3 } else { m + 9 };
        let doy = (153 * m_adj + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        Some(era * 146_097 + doe - 719_468)
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

    async fn write_log<T: Serialize>(path: &FsPath, rows: &[T]) {
        append_lines(path, rows).await.unwrap();
    }

    #[tokio::test]
    async fn a_long_sitting_costs_a_handful_of_revisions_not_hundreds() {
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

    #[tokio::test]
    async fn maintenance_collapses_revisions_into_one_row_each() {
        let dir = tempfile::tempdir().unwrap();
        let sessions_path = dir.path().join("reading-log.jsonl");
        let completions_path = dir.path().join("completions.jsonl");

        // One session written through many times, as the debounce does.
        let mut rows = Vec::new();
        for revision in 0..COMPACTION_LINE_THRESHOLD + 10 {
            let mut row = dated_session("only", "2026-08-19");
            row.ended_at_ms = 2_000 + revision as u64;
            row.listened_seconds = revision as f64;
            rows.push(row);
        }
        write_log(&sessions_path, &rows).await;

        let report = maintain(
            &sessions_path,
            &completions_path,
            RetentionPolicy::default(),
            ymd_days("2026-08-20").unwrap(),
            ymd_days,
        )
        .await
        .unwrap();
        assert!(report.rewrote_sessions);
        assert_eq!(report.sessions_compacted, COMPACTION_LINE_THRESHOLD + 9);

        let kept = read_sessions(&sessions_path).await.unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(
            kept[0].listened_seconds,
            (COMPACTION_LINE_THRESHOLD + 9) as f64,
            "the newest revision must be the one that survives"
        );
    }

    #[tokio::test]
    async fn sessions_age_out_and_completions_never_do() {
        let dir = tempfile::tempdir().unwrap();
        let sessions_path = dir.path().join("reading-log.jsonl");
        let completions_path = dir.path().join("completions.jsonl");

        write_log(
            &sessions_path,
            &[
                dated_session("ancient", "2019-01-01"),
                dated_session("recent", "2026-08-01"),
            ],
        )
        .await;
        write_log(
            &completions_path,
            &[CompletionEvent {
                id: "c1".to_string(),
                user_id: "reader".to_string(),
                book_id: "book".to_string(),
                work_id: None,
                finished_at_ms: 1_000,
                source: CompletionSource::Reached,
                tz_offset_minutes: 0,
                finished_on: "2019-01-02".to_string(),
                snapshot: EditionSnapshot {
                    title: "The Odyssey".to_string(),
                    ..Default::default()
                },
            }],
        )
        .await;

        let report = maintain(
            &sessions_path,
            &completions_path,
            RetentionPolicy::default(),
            ymd_days("2026-08-19").unwrap(),
            ymd_days,
        )
        .await
        .unwrap();
        assert_eq!(report.sessions_expired, 1);
        assert!(!report.rewrote_completions);

        let kept = read_sessions(&sessions_path).await.unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].id, "recent");

        let completions = read_completions(&completions_path).await.unwrap();
        assert_eq!(
            completions.len(),
            1,
            "a completion from 2019 is still the only record that the book was read"
        );
    }

    #[tokio::test]
    async fn keeping_for_ever_expires_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let sessions_path = dir.path().join("reading-log.jsonl");
        let completions_path = dir.path().join("completions.jsonl");
        write_log(&sessions_path, &[dated_session("ancient", "1999-01-01")]).await;

        let report = maintain(
            &sessions_path,
            &completions_path,
            RetentionPolicy {
                session_days: None,
                ..RetentionPolicy::default()
            },
            ymd_days("2026-08-19").unwrap(),
            ymd_days,
        )
        .await
        .unwrap();
        assert_eq!(report.sessions_expired, 0);
        assert_eq!(read_sessions(&sessions_path).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_row_with_an_unreadable_date_is_kept_rather_than_destroyed() {
        let dir = tempfile::tempdir().unwrap();
        let sessions_path = dir.path().join("reading-log.jsonl");
        let completions_path = dir.path().join("completions.jsonl");
        write_log(
            &sessions_path,
            &[
                dated_session("broken", "not-a-date"),
                dated_session("ancient", "2019-01-01"),
            ],
        )
        .await;

        maintain(
            &sessions_path,
            &completions_path,
            RetentionPolicy::default(),
            ymd_days("2026-08-19").unwrap(),
            ymd_days,
        )
        .await
        .unwrap();

        let kept = read_sessions(&sessions_path).await.unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].id, "broken");
    }

    #[tokio::test]
    async fn the_row_ceiling_drops_the_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        let sessions_path = dir.path().join("reading-log.jsonl");
        let completions_path = dir.path().join("completions.jsonl");
        let rows = (0..50)
            .map(|index| dated_session(&format!("s{index}"), "2026-08-19"))
            .collect::<Vec<_>>();
        write_log(&sessions_path, &rows).await;

        let report = maintain(
            &sessions_path,
            &completions_path,
            RetentionPolicy {
                session_days: None,
                session_max_rows: 10,
                completion_max_rows: 10,
            },
            ymd_days("2026-08-19").unwrap(),
            ymd_days,
        )
        .await
        .unwrap();
        assert_eq!(report.sessions_trimmed, 40);

        let kept = read_sessions(&sessions_path).await.unwrap();
        assert_eq!(kept.len(), 10);
        assert_eq!(kept[0].id, "s40", "the newest rows are the ones kept");
        assert_eq!(kept[9].id, "s49");
    }

    #[tokio::test]
    async fn a_settled_log_is_never_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let sessions_path = dir.path().join("reading-log.jsonl");
        let completions_path = dir.path().join("completions.jsonl");
        write_log(&sessions_path, &[dated_session("recent", "2026-08-01")]).await;

        let before = fs::metadata(&sessions_path)
            .await
            .unwrap()
            .modified()
            .unwrap();
        let report = maintain(
            &sessions_path,
            &completions_path,
            RetentionPolicy::default(),
            ymd_days("2026-08-19").unwrap(),
            ymd_days,
        )
        .await
        .unwrap();
        assert!(!report.did_work());
        let after = fs::metadata(&sessions_path)
            .await
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(
            before, after,
            "a pass that changes nothing must touch nothing"
        );
    }

    #[tokio::test]
    async fn maintenance_on_missing_logs_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let report = maintain(
            &dir.path().join("nothing.jsonl"),
            &dir.path().join("also-nothing.jsonl"),
            RetentionPolicy::default(),
            ymd_days("2026-08-19").unwrap(),
            ymd_days,
        )
        .await
        .unwrap();
        assert!(!report.did_work());
        assert!(!dir.path().join("nothing.jsonl").exists());
    }

    /// A year of daily reading, end to end, measured rather than estimated.
    ///
    /// This is the guard on the whole design: if a change makes sessions cost
    /// meaningfully more per year, this is where it shows up.
    #[tokio::test]
    async fn a_year_of_daily_reading_stays_small_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let sessions_path = dir.path().join("reading-log.jsonl");
        let completions_path = dir.path().join("completions.jsonl");

        let mut open = OpenSessions::default();
        let mut counter = 0u64;
        let mut next_id = || {
            counter += 1;
            format!("session-{counter}")
        };
        let day_ms = 86_400_000u64;
        let mut pending = Vec::new();

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
                        pending.extend(rows);
                    }
                }
            }
            if !pending.is_empty() {
                append_sessions(&sessions_path, &pending).await.unwrap();
                pending.clear();
            }
        }
        let remaining = open.drain();
        append_sessions(&sessions_path, &remaining).await.unwrap();

        let before = fs::metadata(&sessions_path).await.unwrap().len();
        let report = maintain(
            &sessions_path,
            &completions_path,
            RetentionPolicy::default(),
            ymd_days("2026-08-19").unwrap(),
            ymd_days,
        )
        .await
        .unwrap();
        assert!(report.rewrote_sessions);
        let after = fs::metadata(&sessions_path).await.unwrap().len();
        let sessions = read_sessions(&sessions_path).await.unwrap();

        assert_eq!(
            sessions.len(),
            365 * 3,
            "one row per sitting once compacted"
        );
        // Roughly a third of a megabyte a year for a reader who reads three
        // hours every single day. Generous headroom over the measured figure so
        // this fails on a regression, not on a rounding change.
        assert!(
            after < 600_000,
            "a year of daily reading should compact to well under a megabyte, got {after} bytes \
             (was {before} before compaction)"
        );
        eprintln!(
            "a year of three-hours-a-day reading: {before} bytes raw, {after} bytes compacted, \
             {} sessions",
            sessions.len()
        );
    }

    #[tokio::test]
    async fn logs_are_created_and_rewritten_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("reading-log.jsonl");
        let row = dated_session("a", "2026-08-19");
        append_sessions(&path, std::slice::from_ref(&row))
            .await
            .unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode =
                |path: &FsPath| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(
                mode(&path),
                0o600,
                "a reading log records when somebody was awake and listening; \
                 it must not be created world-readable"
            );

            // A rewrite replaces the file wholesale and must not widen it again.
            rewrite(&path, &[row]).await.unwrap();
            assert_eq!(mode(&path), 0o600, "maintenance must not un-harden the log");
        }
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

    #[tokio::test]
    async fn an_unchanged_sitting_is_not_appended_twice() {
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

    #[tokio::test]
    async fn a_pass_leaves_the_file_alone_when_rows_cannot_be_read() {
        let dir = tempfile::tempdir().unwrap();
        let sessions_path = dir.path().join("reading-log.jsonl");
        let completions_path = dir.path().join("completions.jsonl");

        // One row this build understands, and one written by a build that knew
        // a field this one does not.
        write_log(&sessions_path, &[dated_session("ancient", "2019-01-01")]).await;
        tokio::fs::write(
            dir.path().join("extra.jsonl"),
            b"{\"id\":\"future\",\"somethingNew\":true}\n",
        )
        .await
        .unwrap();
        let mut existing = tokio::fs::read_to_string(&sessions_path).await.unwrap();
        existing.push_str("{\"id\":\"future\",\"somethingNew\":true}\n");
        tokio::fs::write(&sessions_path, existing.as_bytes())
            .await
            .unwrap();

        let report = maintain(
            &sessions_path,
            &completions_path,
            RetentionPolicy::default(),
            ymd_days("2026-08-19").unwrap(),
            ymd_days,
        )
        .await
        .unwrap();

        assert_eq!(report.sessions_unreadable, 1);
        assert!(
            !report.rewrote_sessions,
            "rebuilding the file would delete history this build cannot parse"
        );
        let raw = tokio::fs::read_to_string(&sessions_path).await.unwrap();
        assert!(
            raw.contains("somethingNew"),
            "the unreadable row must survive the pass"
        );
        assert!(raw.contains("ancient"));
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
