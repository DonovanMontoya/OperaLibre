//! Extracted from main.rs.

use crate::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BookProgress {
    pub(crate) status: BookProgressStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) finished_override: Option<bool>,
    pub(crate) book_position_seconds: f64,
    pub(crate) duration_seconds: Option<f64>,
    pub(crate) remaining_seconds: Option<f64>,
    pub(crate) percent_complete: Option<f64>,
    pub(crate) updated_at: String,
}

/// One other listener's position in a book, as shown to a viewer who also
/// shares. Deliberately narrower than `BookProgress`: a percentage and a
/// status, never a resume point someone else could act on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SharedProgress {
    pub(crate) user_id: String,
    pub(crate) username: String,
    pub(crate) status: BookProgressStatus,
    pub(crate) percent_complete: Option<f64>,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BookProgressStatus {
    NotStarted,
    InProgress,
    Finished,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    pub(crate) book_id: String,
    pub(crate) track_id: String,
    pub(crate) position_seconds: f64,
    #[serde(default)]
    pub(crate) book_position_seconds: f64,
    pub(crate) duration_seconds: Option<f64>,
    pub(crate) updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) finished_override: Option<bool>,
}

/// A book's playback gain as a linear multiplier. The floor tames a book
/// mastered hot; the ceiling is +24 dB, far enough to rescue a badly quiet
/// transfer, and past the point where the limiter starts doing much of the
/// work — which is the listener's trade to make.
pub(crate) const BOOK_VOLUME_GAIN_MIN: f64 = 0.5;

pub(crate) const BOOK_VOLUME_GAIN_MAX: f64 = 16.0;

pub(crate) const BOOK_VOLUME_GAIN_DEFAULT: f64 = 1.0;

pub(crate) fn clamp_book_volume_gain(value: f64) -> f64 {
    if !value.is_finite() {
        return BOOK_VOLUME_GAIN_DEFAULT;
    }
    value.clamp(BOOK_VOLUME_GAIN_MIN, BOOK_VOLUME_GAIN_MAX)
}

/// Per-listener, per-book playback preferences, keyed like progress so one
/// listener's tuning never leaks into another's library.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BookSettings {
    /// Defaulted rather than required: this file is read on the way to serving
    /// the whole library, so a row that is truncated, hand-edited, or written
    /// by a future build with another shape must cost one book its gain — not
    /// hide every book from every listener behind a 500.
    #[serde(default = "default_book_volume_gain")]
    pub(crate) volume_gain: f64,
}

pub(crate) fn default_book_volume_gain() -> f64 {
    BOOK_VOLUME_GAIN_DEFAULT
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BookVolumeUpdate {
    pub(crate) volume_gain: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProgressUpdate {
    pub(crate) track_id: String,
    pub(crate) position_seconds: f64,
    pub(crate) book_position_seconds: Option<f64>,
    pub(crate) duration_seconds: Option<f64>,
    /// Client-side epoch milliseconds of when this position was recorded.
    /// Optional for backwards compatibility; without it the write is always
    /// accepted and stamped with the server clock, as before.
    pub(crate) updated_at_ms: Option<u64>,
    /// Set when the listener deliberately jumped backwards (restarting a
    /// book, scrubbing, picking an earlier chapter). Without it the server
    /// refuses near-zero writes that would erase substantial progress.
    #[serde(default)]
    pub(crate) intentional_regression: bool,
    /// Set for either a forward or backward user-initiated seek. Position
    /// movement from this checkpoint must not be counted as listening time.
    #[serde(default)]
    pub(crate) intentional_seek: bool,
    /// The listener's offset from UTC in minutes, east positive (the negation
    /// of JavaScript's `getTimezoneOffset`). Activity is bucketed by the
    /// listener's own calendar day, so an evening session west of UTC is not
    /// filed under tomorrow and does not split a streak. Absent means UTC.
    pub(crate) tz_offset_minutes: Option<i32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompletionUpdate {
    pub(crate) finished: bool,
    pub(crate) track_id: Option<String>,
    pub(crate) position_seconds: Option<f64>,
    pub(crate) book_position_seconds: Option<f64>,
    pub(crate) duration_seconds: Option<f64>,
}

/// Per-listener playback gain for one book. Unlike the metadata override this
/// is not an admin edit: it only changes how loud the book is for the caller,
/// so any listener with access to the book may set it.
pub(crate) async fn update_book_volume(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
    Json(payload): Json<BookVolumeUpdate>,
) -> Result<Json<Book>, ApiError> {
    require_book_access(&auth, &book_id)?;

    let book = {
        let library = state.library.read().await;
        library
            .books
            .iter()
            .find(|candidate| candidate.id == book_id)
            .cloned()
            .ok_or(ApiError::not_found("Book not found"))?
    };

    let gain = clamp_book_volume_gain(payload.volume_gain);
    state
        .book_settings
        .set_gain(&auth.id, &book_id, gain)
        .await?;

    Ok(Json(book_with_progress(&state, &auth, book).await?))
}

/// What a progress write should do, decided without touching storage.
///
/// Every defense against losing a listener's place lives here: a replayed
/// checkpoint from an offline queue, a device with a skewed clock, a client
/// that failed to restore its position and reported zero, and a backwards jump
/// nobody asked for. Keeping it pure means the rules are identical whatever
/// the storage backend is, and testable without any I/O.
#[derive(Debug, Clone)]
pub(crate) enum ProgressDecision {
    /// Keep the stored position. The client converges back to it on its next
    /// successful fetch.
    Keep,
    /// Store this position, retaining the previous one first when the drop is
    /// large enough to be worth recovering.
    Store {
        saved: Progress,
        backup_previous: bool,
    },
}

/// Decide what to do with one incoming progress write.
pub(crate) fn decide_progress_write(
    book: &Book,
    track: &Track,
    previous: Option<&Progress>,
    update: &ProgressUpdate,
    now_millis: u64,
) -> ProgressDecision {
    // Cap client timestamps at the server clock so one device with a
    // future-skewed clock cannot lock every other device out of this book.
    let now_seconds = now_millis as f64 / 1000.0;
    let incoming_seconds = update
        .updated_at_ms
        .map(|ms| (ms as f64 / 1000.0).min(now_seconds));
    if let (Some(previous), Some(incoming)) = (previous, incoming_seconds)
        && progress_write_is_stale(&previous.updated_at, incoming)
    {
        // A replayed checkpoint - an offline queue flushing or a reinstalled
        // client syncing old local state - must not roll back a position some
        // device recorded more recently.
        return ProgressDecision::Keep;
    }

    let incoming_track_position =
        clamped_track_position(update.position_seconds, track.duration_seconds);
    let incoming_book_position = validated_book_position_seconds(
        book,
        track,
        incoming_track_position,
        update.book_position_seconds,
    );
    let saved = Progress {
        book_id: book.id.clone(),
        track_id: track.id.clone(),
        position_seconds: incoming_track_position,
        book_position_seconds: incoming_book_position,
        duration_seconds: update.duration_seconds.or(track.duration_seconds),
        updated_at: next_progress_timestamp(previous, now_millis),
        finished_override: carried_finished_override(
            previous,
            incoming_book_position,
            update.intentional_seek,
        ),
    };

    let mut backup_previous = false;
    if let Some(previous) = previous {
        if progress_write_is_unintentional_regression(
            previous.book_position_seconds,
            saved.book_position_seconds,
            update.intentional_seek || update.intentional_regression,
        ) {
            return ProgressDecision::Keep;
        }
        if progress_write_is_suspect_reset(
            previous.book_position_seconds,
            saved.book_position_seconds,
            update.intentional_regression,
        ) {
            return ProgressDecision::Keep;
        }
        backup_previous = previous.book_position_seconds - saved.book_position_seconds
            > PROGRESS_BACKUP_REGRESSION_SECONDS;
    }

    ProgressDecision::Store {
        saved,
        backup_previous,
    }
}

pub(crate) async fn get_progress(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
) -> Result<Response, ApiError> {
    require_book_access(&auth, &book_id)?;
    let saved = state.progress.get(&auth.id, &book_id).await?;
    let value = if let Some(saved) = saved.as_ref() {
        let library = state.library.read().await;
        let enriched = library
            .books
            .iter()
            .find(|candidate| candidate.id == book_id)
            .map(|book| enrich_progress(book, saved))
            .unwrap_or_else(|| saved.clone());
        serde_json::to_value(enriched)?
    } else {
        serde_json::Value::Null
    };
    Ok(Json(value).into_response())
}

pub(crate) async fn update_progress(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
    Json(update): Json<ProgressUpdate>,
) -> Result<Json<Progress>, ApiError> {
    require_book_access(&auth, &book_id)?;
    // Cloned out of the library so the decision can travel to the database's
    // blocking task, and so the library lock is not held across the write.
    let (book, track) = {
        let library = state.library.read().await;
        let book = library
            .books
            .iter()
            .find(|candidate| candidate.id == book_id)
            .ok_or(ApiError::not_found("Book not found"))?;
        let track = book
            .tracks
            .iter()
            .find(|candidate| candidate.id == update.track_id)
            .ok_or(ApiError::not_found("Track not found"))?
            .clone();
        (book.clone(), track)
    };

    let now_millis = unix_now_millis();
    let decision_update = update.clone();
    let decided_book_id = book.id.clone();
    let decision_book = book.clone();
    let (saved, previous) = state
        .progress
        .update_book(&auth.id, &decided_book_id, move |previous| {
            decide_progress_write(
                &decision_book,
                &track,
                previous,
                &decision_update,
                now_millis,
            )
        })
        .await?;

    let listened_delta =
        plausible_listened_delta(previous.as_ref(), &saved, update.intentional_seek);
    if listened_delta > 0.0 {
        record_activity(
            &state,
            &auth.id,
            listened_delta,
            sanitized_tz_offset_minutes(update.tz_offset_minutes),
        )
        .await;
        record_listening(
            &state,
            &auth.id,
            &book,
            &saved,
            previous.as_ref(),
            update.intentional_seek,
            sanitized_tz_offset_minutes(update.tz_offset_minutes),
        )
        .await;
    }

    let was_finished = previous
        .as_ref()
        .map(|progress| {
            summarize_book_progress(&book, progress).status == BookProgressStatus::Finished
        })
        .unwrap_or(false);
    if !was_finished
        && summarize_book_progress(&book, &saved).status == BookProgressStatus::Finished
    {
        record_completion(
            &state,
            &auth.id,
            &book,
            CompletionSource::Reached,
            sanitized_tz_offset_minutes(update.tz_offset_minutes),
        )
        .await;
    }

    Ok(Json(saved))
}

pub(crate) async fn update_book_completion(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
    Json(update): Json<CompletionUpdate>,
) -> Result<Json<BookProgress>, ApiError> {
    require_book_access(&auth, &book_id)?;
    let book = state
        .library
        .read()
        .await
        .books
        .iter()
        .find(|candidate| candidate.id == book_id)
        .cloned()
        .ok_or(ApiError::not_found("Book not found"))?;
    let first_track = book
        .tracks
        .first()
        .ok_or(ApiError::bad_request("This book has no playable tracks."))?
        .clone();
    // Owned, because the decision travels to the database's blocking task.
    let final_position = match (&update.track_id, update.position_seconds) {
        (None, None) => None,
        (Some(track_id), Some(position_seconds)) => {
            let track = book
                .tracks
                .iter()
                .find(|candidate| candidate.id == *track_id)
                .ok_or(ApiError::not_found("Track not found"))?
                .clone();
            let clamped = clamped_track_position(position_seconds, track.duration_seconds);
            Some((track, clamped))
        }
        _ => {
            return Err(ApiError::bad_request(
                "Completion position requires both trackId and positionSeconds.",
            ));
        }
    };

    let now_millis = unix_now_millis();
    // Marking a book finished or unfinished is an explicit instruction, so it
    // bypasses the regression rules that guard automatic checkpoints.
    let decision_book = book.clone();
    let decision_update = update.clone();
    let completion_book_id = book.id.clone();
    let (saved, previous) = state
        .progress
        .update_book(&auth.id, &completion_book_id, move |previous| {
            let book = decision_book;
            let update = decision_update;
            let next_timestamp = next_progress_timestamp(previous, now_millis);
            let mut saved = previous.cloned().unwrap_or_else(|| Progress {
                book_id: book.id.clone(),
                track_id: first_track.id.clone(),
                position_seconds: 0.0,
                book_position_seconds: 0.0,
                duration_seconds: first_track.duration_seconds,
                updated_at: next_timestamp.clone(),
                finished_override: None,
            });
            if let Some((track, position_seconds)) = final_position {
                saved.track_id = track.id.clone();
                saved.position_seconds = position_seconds;
                saved.book_position_seconds = validated_book_position_seconds(
                    &book,
                    &track,
                    position_seconds,
                    update.book_position_seconds,
                );
                saved.duration_seconds = update.duration_seconds.or(track.duration_seconds);
                saved.updated_at = next_timestamp;
            }
            saved.finished_override = Some(update.finished);
            ProgressDecision::Store {
                saved,
                backup_previous: false,
            }
        })
        .await?;

    let summary = summarize_book_progress(&book, &saved);
    let was_finished = previous
        .as_ref()
        .map(|progress| {
            summarize_book_progress(&book, progress).status == BookProgressStatus::Finished
        })
        .unwrap_or(false);
    if update.finished && !was_finished {
        record_completion(&state, &auth.id, &book, CompletionSource::Marked, 0).await;
    }
    Ok(Json(summary))
}

pub(crate) fn enrich_progress(book: &Book, progress: &Progress) -> Progress {
    let Some(track) = book
        .tracks
        .iter()
        .find(|candidate| candidate.id == progress.track_id)
    else {
        return progress.clone();
    };

    let mut enriched = progress.clone();
    if enriched.book_position_seconds <= 0.0 {
        enriched.book_position_seconds =
            book_position_seconds(book, track, progress.position_seconds);
    }
    enriched
}

pub(crate) async fn books_with_progress(
    state: &AppState,
    auth: &AuthUser,
) -> Result<Vec<Book>, ApiError> {
    let own_progress = state.progress.list_for_user(&auth.id).await?;
    let own_gains = state.book_settings.list_for_user(&auth.id).await?;
    let sharers = progress_sharers(state, auth).await;
    let shared_progress = state
        .progress
        .list_for_users(&sharers.iter().map(|(id, _)| id.clone()).collect())
        .await?;
    let books = state.library.read().await.books.clone();
    Ok(books
        .into_iter()
        .filter(|book| can_access_book(auth, &book.id))
        .map(|mut book| {
            book.progress = own_progress
                .get(&book.id)
                .map(|progress| summarize_book_progress(&book, progress));
            book.shared_progress = collect_shared_progress(&book, &shared_progress, &sharers);
            book.volume_gain = own_gains
                .get(&book.id)
                .copied()
                .unwrap_or(BOOK_VOLUME_GAIN_DEFAULT);
            book
        })
        .collect())
}

pub(crate) async fn book_with_progress(
    state: &AppState,
    auth: &AuthUser,
    mut book: Book,
) -> Result<Book, ApiError> {
    book.progress = state
        .progress
        .get(&auth.id, &book.id)
        .await?
        .map(|progress| summarize_book_progress(&book, &progress));
    let sharers = progress_sharers(state, auth).await;
    let shared_progress = state
        .progress
        .list_for_users(&sharers.iter().map(|(id, _)| id.clone()).collect())
        .await?;
    book.shared_progress = collect_shared_progress(&book, &shared_progress, &sharers);
    book.volume_gain = state.book_settings.gain(&auth.id, &book.id).await?;
    Ok(book)
}

/// The other listeners whose progress `auth` is allowed to see, as
/// `(user_id, username)`. Sharing is reciprocal: a viewer who has switched
/// their own sharing off sees nobody, so opting out is a symmetric trade
/// rather than a way to watch without being watched.
pub(crate) async fn progress_sharers(state: &AppState, auth: &AuthUser) -> Vec<(String, String)> {
    let users = state.users.read().await;
    visible_sharers(&users.users, auth)
}

pub(crate) fn visible_sharers(users: &[User], auth: &AuthUser) -> Vec<(String, String)> {
    if !auth.share_progress {
        return Vec::new();
    }
    users
        .iter()
        .filter(|user| user.share_progress && user.id != auth.id)
        .map(|user| (user.id.clone(), user.username.clone()))
        .collect()
}

pub(crate) fn collect_shared_progress(
    book: &Book,
    saved_progress: &HashMap<String, Progress>,
    sharers: &[(String, String)],
) -> Vec<SharedProgress> {
    let mut entries: Vec<SharedProgress> = sharers
        .iter()
        .filter_map(|(user_id, username)| {
            let progress = saved_progress.get(&progress_key(user_id, book.id.as_str()))?;
            let summary = summarize_book_progress(book, progress);
            // A row exists as soon as a book is opened, so untouched books
            // would otherwise report every user on the server as a reader.
            if summary.status == BookProgressStatus::NotStarted {
                return None;
            }
            Some(SharedProgress {
                user_id: user_id.clone(),
                username: username.clone(),
                status: summary.status,
                percent_complete: summary.percent_complete,
                updated_at: summary.updated_at,
            })
        })
        .collect();
    // Finished readers first, then the furthest along, so the truncated list
    // shown on a library row leads with the most useful names.
    entries.sort_by(|a, b| {
        let rank = |entry: &SharedProgress| match entry.status {
            BookProgressStatus::Finished => 0,
            BookProgressStatus::InProgress => 1,
            BookProgressStatus::NotStarted => 2,
        };
        rank(a).cmp(&rank(b)).then_with(|| {
            b.percent_complete
                .unwrap_or(0.0)
                .partial_cmp(&a.percent_complete.unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    entries
}

pub(crate) fn summarize_book_progress(book: &Book, progress: &Progress) -> BookProgress {
    let enriched = enrich_progress(book, progress);
    // A non-positive duration means "unknown", never "this book is zero
    // seconds long". Treating it as known clamps the stored position to 0 and
    // reports the book as not started — and the library summary is the resume
    // point a reinstalled client falls back to when /progress is unavailable.
    let duration = book
        .duration_seconds
        .filter(|duration| *duration > 0.0)
        .or_else(|| known_duration_from_tracks(book));
    let position = duration
        .map(|duration| enriched.book_position_seconds.clamp(0.0, duration))
        .unwrap_or_else(|| enriched.book_position_seconds.max(0.0));
    let remaining = duration.map(|duration| (duration - position).max(0.0));
    let percent_complete = duration
        .filter(|duration| *duration > 0.0)
        .map(|duration| ((position / duration) * 100.0).clamp(0.0, 100.0));
    let status = book_progress_status(duration, remaining, position, enriched.finished_override);

    BookProgress {
        status,
        finished_override: enriched.finished_override,
        book_position_seconds: position,
        duration_seconds: duration,
        remaining_seconds: remaining,
        percent_complete,
        updated_at: enriched.updated_at,
    }
}

/// The furthest point a stored checkpoint reached, clamped to the book's real
/// duration. A raw `book_position_seconds` is only as trustworthy as the client
/// that reported it — when a book's track durations are unknown the server has
/// to take the client's word for it, and an over-reported position would
/// otherwise outrank every real one.
///
/// This is ground covered, not time spent: scrubbing forward moves it without
/// any listening. Never sum it into a listening total.
pub(crate) fn reached_position_seconds(book: &Book, progress: &Progress) -> f64 {
    summarize_book_progress(book, progress)
        .book_position_seconds
        .max(0.0)
}

pub(crate) fn book_progress_status(
    duration: Option<f64>,
    remaining: Option<f64>,
    position: f64,
    finished_override: Option<bool>,
) -> BookProgressStatus {
    match finished_override {
        Some(true) => BookProgressStatus::Finished,
        Some(false) if position > 0.0 => BookProgressStatus::InProgress,
        Some(false) => BookProgressStatus::NotStarted,
        None => match (duration, remaining, position) {
            (Some(duration), Some(remaining), _) if duration > 0.0 && remaining <= 30.0 => {
                BookProgressStatus::Finished
            }
            (Some(duration), _, position) if duration > 0.0 && position / duration >= 0.995 => {
                BookProgressStatus::Finished
            }
            (_, _, position) if position > 0.0 => BookProgressStatus::InProgress,
            _ => BookProgressStatus::NotStarted,
        },
    }
}

pub(crate) fn known_duration_from_tracks(book: &Book) -> Option<f64> {
    if book.tracks.is_empty() {
        return None;
    }
    book.tracks.iter().try_fold(0.0, |total, track| {
        track
            .duration_seconds
            .filter(|duration| *duration > 0.0)
            .map(|duration| total + duration)
    })
}

pub(crate) fn book_position_seconds(book: &Book, track: &Track, position_seconds: f64) -> f64 {
    let track_offset = book
        .tracks
        .iter()
        .take_while(|candidate| candidate.id != track.id)
        .map(|candidate| candidate.duration_seconds.unwrap_or(0.0))
        .sum::<f64>();
    track_offset + position_seconds.max(0.0)
}

pub(crate) fn clamped_track_position(position_seconds: f64, duration_seconds: Option<f64>) -> f64 {
    let position = position_seconds.max(0.0);
    duration_seconds
        .filter(|duration| *duration > 0.0)
        .map(|duration| position.min(duration))
        .unwrap_or(position)
}

/// The track id and server-side ordering are authoritative. Trust a reported
/// whole-book offset only when an earlier track has no known duration and the
/// server therefore cannot derive the offset itself.
pub(crate) fn validated_book_position_seconds(
    book: &Book,
    track: &Track,
    position_seconds: f64,
    reported: Option<f64>,
) -> f64 {
    let prefix_is_known = book
        .tracks
        .iter()
        .take_while(|candidate| candidate.id != track.id)
        .all(|candidate| candidate.duration_seconds.is_some());
    if prefix_is_known {
        book_position_seconds(book, track, position_seconds)
    } else {
        reported
            .unwrap_or_else(|| book_position_seconds(book, track, position_seconds))
            .max(0.0)
    }
}

/// Slack absorbs realistic clock skew between devices; a genuinely stale
/// replay (offline queue flush, reinstalled client) is hours or days old.
pub(crate) const PROGRESS_STALE_WRITE_SLACK_SECONDS: f64 = 300.0;

/// How far backwards an accepted write must jump before the replaced copy is
/// preserved on disk.
pub(crate) const PROGRESS_BACKUP_REGRESSION_SECONDS: f64 = 300.0;

/// AVPlayer and HTMLMediaElement clocks can differ by a fraction of a second
/// around pause and route-change events. Anything beyond this is a real
/// backwards move and must have been initiated by the listener.
pub(crate) const PROGRESS_AUTOMATIC_REGRESSION_SLACK_SECONDS: f64 = 2.0;

pub(crate) const PROGRESS_BACKUPS_PER_BOOK: usize = 20;

/// Positions this close to the start of a book are treated as "not started"
/// when they arrive over substantial stored progress.
pub(crate) const PROGRESS_NEAR_ZERO_SECONDS: f64 = 60.0;

/// Carries an explicit completion choice onto the next checkpoint, except
/// when the listener deliberately jumps back to the start of a book they had
/// marked finished. That is a re-listen, and keeping the override would label
/// the whole second pass "Finished". Only a deliberate seek clears it, so an
/// automatic position report can never erase the choice.
pub(crate) fn carried_finished_override(
    previous: Option<&Progress>,
    incoming_book_position: f64,
    intentional_seek: bool,
) -> Option<bool> {
    let previous = previous?;
    let restarting = intentional_seek
        && previous.finished_override == Some(true)
        && incoming_book_position < PROGRESS_NEAR_ZERO_SECONDS;
    if restarting {
        None
    } else {
        previous.finished_override
    }
}

pub(crate) fn plausible_listened_delta(
    previous: Option<&Progress>,
    saved: &Progress,
    intentional_seek: bool,
) -> f64 {
    let Some(previous) = previous else {
        // A first checkpoint may be a restore from another installation; no
        // elapsed interval exists from which listening can be inferred.
        return 0.0;
    };
    if intentional_seek {
        return 0.0;
    }
    let position_delta = (saved.book_position_seconds - previous.book_position_seconds).max(0.0);
    if position_delta <= 0.0 {
        return 0.0;
    }
    let previous_timestamp = progress_timestamp_seconds(&previous.updated_at);
    let saved_timestamp = progress_timestamp_seconds(&saved.updated_at);
    let elapsed = (saved_timestamp - previous_timestamp).max(0.0);
    // OperaLibre tops out at 2x. A small grace window covers rounded
    // timestamps and progress-save scheduling jitter without allowing a
    // multi-hour scrub to become activity.
    position_delta.min(elapsed * 2.1 + 5.0)
}

pub(crate) fn progress_timestamp_seconds(value: &str) -> f64 {
    let numeric = value.parse::<f64>().unwrap_or(0.0);
    if numeric >= 1_000_000_000_000.0 {
        numeric / 1000.0
    } else {
        numeric
    }
}

pub(crate) fn progress_timestamp_millis(value: &str) -> u64 {
    let numeric = value.parse::<f64>().unwrap_or(0.0).max(0.0);
    if numeric >= 1_000_000_000_000.0 {
        numeric.floor() as u64
    } else {
        (numeric * 1000.0).floor() as u64
    }
}

/// Accepted writes receive a server-issued monotonic millisecond revision.
/// This distinguishes a rapid rewind from the older high position it replaces
/// without allowing a future-skewed client clock to control ordering.
pub(crate) fn next_progress_timestamp(previous: Option<&Progress>, now_millis: u64) -> String {
    let previous_millis = previous
        .map(|progress| progress_timestamp_millis(&progress.updated_at))
        .unwrap_or(0);
    now_millis
        .max(previous_millis.saturating_add(1))
        .to_string()
}

pub(crate) fn progress_write_is_stale(stored_updated_at: &str, incoming_seconds: f64) -> bool {
    // Progress revisions may be legacy epoch seconds or monotonic epoch
    // milliseconds. Anything unparsable never blocks a write.
    let stored = progress_timestamp_seconds(stored_updated_at);
    incoming_seconds + PROGRESS_STALE_WRITE_SLACK_SECONDS < stored
}

/// A near-zero write that erases substantial progress is the signature of a
/// client that failed to restore its position, not of a listener starting
/// over — deliberate restarts and rewinds are flagged by the client. The
/// timestamp-staleness check cannot catch this case because the broken
/// client's write is genuinely fresh.
pub(crate) fn progress_write_is_suspect_reset(
    previous_book_position: f64,
    incoming_book_position: f64,
    intentional: bool,
) -> bool {
    !intentional
        && incoming_book_position < PROGRESS_NEAR_ZERO_SECONDS
        && previous_book_position - incoming_book_position > PROGRESS_BACKUP_REGRESSION_SECONDS
}

/// Periodic, pause, background, and completion-adjacent checkpoints are
/// monotonic. A late request must never roll back a newer position, regardless
/// of clock skew or network ordering. Explicit seeks and restarts are the sole
/// paths allowed to move backward.
pub(crate) fn progress_write_is_unintentional_regression(
    previous_book_position: f64,
    incoming_book_position: f64,
    intentional_seek: bool,
) -> bool {
    !intentional_seek
        && incoming_book_position + PROGRESS_AUTOMATIC_REGRESSION_SLACK_SECONDS
            < previous_book_position
}
