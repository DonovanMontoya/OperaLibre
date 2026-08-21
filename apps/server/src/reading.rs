//! Reading-history handlers and the bridge from playback checkpoints.

use crate::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkLinkRequest {
    pub(crate) book_id: String,
    pub(crate) work_id: String,
}

pub(crate) async fn record_listening(
    state: &AppState,
    user_id: &str,
    book: &Book,
    saved: &Progress,
    previous: Option<&Progress>,
    intentional_seek: bool,
    tz_offset_minutes: i64,
) {
    let listened_seconds = plausible_listened_delta(previous, saved, intentional_seek);
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
            speed: None,
            client: None,
            tz_offset_minutes,
            today: today_ymd(tz_offset_minutes),
        },
        generate_session_token,
    );
    let SessionOutcome::Append(sessions) = outcome else {
        return;
    };
    if let Err(error) = state
        .reading_history
        .mutate(|history| {
            history.sessions.extend(sessions);
            Ok(())
        })
        .await
    {
        tracing::warn!("failed to persist reading session: {}", error.message);
    }
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
    let history = state.reading_history.read().await;
    Json(history_rows(
        &history.sessions,
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
    let history = state.reading_history.read().await;
    Json(history_rows(
        &history.completions,
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
