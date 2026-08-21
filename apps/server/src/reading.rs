//! Reading-history handlers and the bridge from playback checkpoints.

use crate::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkLinkRequest {
    pub(crate) book_id: String,
    pub(crate) work_id: String,
}

pub(crate) struct ListeningCheckpoint<'a> {
    pub(crate) previous: Option<&'a Progress>,
    pub(crate) intentional_seek: bool,
    pub(crate) tz_offset_minutes: i64,
    pub(crate) speed: Option<f64>,
    pub(crate) client: Option<String>,
}

pub(crate) async fn record_listening(
    state: &AppState,
    user_id: &str,
    book: &Book,
    saved: &Progress,
    checkpoint: ListeningCheckpoint<'_>,
) {
    let listened_seconds =
        plausible_listened_delta(checkpoint.previous, saved, checkpoint.intentional_seek);
    if listened_seconds <= 0.0 {
        return;
    }
    let work_id = state
        .works
        .read()
        .await
        .work_for_book(&book.id)
        .map(|work| work.id.clone());
    let outcome = state.open_sessions.lock().await.record(
        Checkpoint {
            user_id: user_id.to_string(),
            book_id: book.id.clone(),
            work_id,
            at_ms: progress_timestamp_millis(&saved.updated_at),
            listened_seconds,
            position_seconds: saved.book_position_seconds,
            speed: checkpoint.speed,
            client: checkpoint.client,
            tz_offset_minutes: checkpoint.tz_offset_minutes,
            today: today_ymd(checkpoint.tz_offset_minutes),
        },
        generate_session_token,
    );
    let SessionOutcome::Append(sessions) = outcome else {
        return;
    };
    persist_sessions(state, sessions).await;
}

/// Replace a flushed revision instead of retaining every cumulative snapshot
/// of the same sitting. This keeps the SQLite cache immediately useful to
/// readers and downstream aggregates; no later compaction pass is required.
pub(crate) async fn persist_sessions(state: &AppState, sessions: Vec<ReadingSession>) {
    if sessions.is_empty() {
        return;
    }
    if let Err(error) = state
        .reading_history
        .mutate(|history| {
            let ids = sessions
                .iter()
                .map(|session| &session.id)
                .collect::<HashSet<_>>();
            history
                .sessions
                .retain(|session| !ids.contains(&session.id));
            history.sessions.extend(sessions);
            Ok(())
        })
        .await
    {
        tracing::warn!("failed to persist reading session: {}", error.message);
    }
}

/// Close quiet sessions in production. The lock is released before SQLite I/O
/// so a progress checkpoint never waits on a history write while coalescing.
pub(crate) fn schedule_reading_session_sweeper(state: AppState) {
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(Duration::from_secs(60));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            let sessions = state
                .open_sessions
                .lock()
                .await
                .close_idle(unix_now_millis());
            persist_sessions(&state, sessions).await;
        }
    });
}

/// Persist the final tail after the server has stopped accepting requests.
pub(crate) async fn drain_reading_sessions(state: &AppState) {
    let sessions = state.open_sessions.lock().await.drain();
    persist_sessions(state, sessions).await;
}

pub(crate) async fn record_completion(
    state: &AppState,
    user_id: &str,
    book: &Book,
    source: CompletionSource,
    tz_offset_minutes: i64,
) {
    let work_id = state
        .works
        .read()
        .await
        .work_for_book(&book.id)
        .map(|work| work.id.clone());
    let snapshot = EditionSnapshot {
        title: book.title.clone(),
        author: book.author.clone(),
        narrator: book.narrator.clone(),
        duration_seconds: book.duration_seconds,
        asin: book.asin.clone(),
        isbn: None,
        publisher: book.metadata.publisher.clone(),
        published_date: book.published_date.clone(),
        series: book.metadata.series.clone(),
        series_position: book.metadata.series_position.clone(),
        genres: book.genres.clone(),
        track_count: book.track_count,
    };
    let event = CompletionEvent {
        id: generate_session_token(),
        user_id: user_id.to_string(),
        book_id: book.id.clone(),
        work_id,
        finished_at_ms: unix_now_millis(),
        source,
        tz_offset_minutes,
        finished_on: today_ymd(tz_offset_minutes),
        snapshot,
    };
    if let Err(error) = state
        .reading_history
        .mutate(|history| {
            history.completions.push(event);
            Ok(())
        })
        .await
    {
        tracing::warn!("failed to persist completion: {}", error.message);
    }
}

pub(crate) async fn reading_log_sessions(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Query(query): Query<ReadingLogQuery>,
) -> Json<Vec<ReadingSession>> {
    let work_ids = state.works.read().await.book_to_work();
    let history = state.reading_history.read().await;
    let sessions = compact_sessions(history.sessions.clone())
        .into_iter()
        .map(|mut session| {
            if let Some(work_id) = work_ids.get(&session.book_id) {
                session.work_id = Some(work_id.clone());
            }
            session
        })
        .collect::<Vec<_>>();
    Json(history_rows(
        &sessions,
        &auth.id,
        &query,
        |row| row.user_id.as_str(),
        |row| row.started_on.as_str(),
        |row| row.ended_at_ms,
    ))
}

pub(crate) async fn reading_log_completions(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Query(query): Query<ReadingLogQuery>,
) -> Json<Vec<CompletionEvent>> {
    let work_ids = state.works.read().await.book_to_work();
    let history = state.reading_history.read().await;
    let completions = history
        .completions
        .iter()
        .cloned()
        .map(|mut completion| {
            if let Some(work_id) = work_ids.get(&completion.book_id) {
                completion.work_id = Some(work_id.clone());
            }
            completion
        })
        .collect::<Vec<_>>();
    Json(history_rows(
        &completions,
        &auth.id,
        &query,
        |row| row.user_id.as_str(),
        |row| row.finished_on.as_str(),
        |row| row.finished_at_ms,
    ))
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct ReadingLogQuery {
    limit: Option<usize>,
    since: Option<String>,
}

const DEFAULT_READING_LOG_PAGE: usize = 200;
const MAX_READING_LOG_PAGE: usize = 1_000;

fn history_rows<T: Clone>(
    rows: &[T],
    user_id: &str,
    query: &ReadingLogQuery,
    user: impl Fn(&T) -> &str,
    day: impl Fn(&T) -> &str,
    at: impl Fn(&T) -> u64,
) -> Vec<T> {
    let limit = query
        .limit
        .unwrap_or(DEFAULT_READING_LOG_PAGE)
        .min(MAX_READING_LOG_PAGE);
    let since = query.since.as_deref();
    let mut result = rows
        .iter()
        .filter(|row| user(row) == user_id && since.is_none_or(|date| day(row) >= date))
        .cloned()
        .collect::<Vec<_>>();
    result.sort_by_key(|row| std::cmp::Reverse(at(row)));
    result.truncate(limit);
    result
}

pub(crate) async fn list_works(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<WorkStore>, ApiError> {
    require_admin(&auth)?;
    Ok(Json(state.works.read().await.clone()))
}

pub(crate) async fn link_work_edition(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Json(request): Json<WorkLinkRequest>,
) -> Result<Json<WorkStore>, ApiError> {
    require_admin(&auth)?;
    state
        .works
        .mutate(|works| {
            if works.link_manually(&request.book_id, &request.work_id) {
                Ok(())
            } else {
                Err(ApiError::not_found("Work not found"))
            }
        })
        .await?;
    Ok(Json(state.works.read().await.clone()))
}

pub(crate) async fn reject_work_suggestion(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Json(request): Json<WorkLinkRequest>,
) -> Result<Json<WorkStore>, ApiError> {
    require_admin(&auth)?;
    state
        .works
        .mutate(|works| {
            if works.reject_suggestion(&request.book_id, &request.work_id) {
                Ok(())
            } else {
                Err(ApiError::not_found("Work not found"))
            }
        })
        .await?;
    Ok(Json(state.works.read().await.clone()))
}
