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
    if listened_seconds < reading_log::MIN_SESSION_SECONDS {
        return;
    }
    let work_id = state
        .works
        .read()
        .await
        .work_for_book(&book.id)
        .map(|work| work.id.clone());
    let session = ReadingSession {
        id: generate_session_token(),
        user_id: user_id.to_string(),
        book_id: book.id.clone(),
        work_id,
        started_at_ms: progress_timestamp_millis(&saved.updated_at)
            .saturating_sub((listened_seconds * 1000.0) as u64),
        ended_at_ms: progress_timestamp_millis(&saved.updated_at),
        listened_seconds,
        start_position_seconds: (saved.book_position_seconds - listened_seconds).max(0.0),
        end_position_seconds: saved.book_position_seconds,
        speed: None,
        client: None,
        tz_offset_minutes,
        started_on: today_ymd(tz_offset_minutes),
    };
    if let Err(error) = state
        .reading_history
        .mutate(|history| {
            history.sessions.push(session);
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
        id: generate_session_token(), user_id: user_id.to_string(), book_id: book.id.clone(),
        work_id, finished_at_ms: unix_now_millis(), source, tz_offset_minutes,
        finished_on: today_ymd(tz_offset_minutes), snapshot,
    };
    if let Err(error) = state.reading_history.mutate(|history| {
        history.completions.push(event);
        Ok(())
    }).await {
        tracing::warn!("failed to persist completion: {}", error.message);
    }
}

pub(crate) async fn reading_log_sessions(
    State(state): State<AppState>, Extension(auth): Extension<AuthUser>,
) -> Json<Vec<ReadingSession>> {
    let history = state.reading_history.read().await;
    Json(history.sessions.iter().filter(|row| row.user_id == auth.id).cloned().collect())
}

pub(crate) async fn reading_log_completions(
    State(state): State<AppState>, Extension(auth): Extension<AuthUser>,
) -> Json<Vec<CompletionEvent>> {
    let history = state.reading_history.read().await;
    Json(history.completions.iter().filter(|row| row.user_id == auth.id).cloned().collect())
}

pub(crate) async fn list_works(
    State(state): State<AppState>, Extension(auth): Extension<AuthUser>,
) -> Result<Json<WorkStore>, ApiError> {
    require_admin(&auth)?;
    Ok(Json(state.works.read().await.clone()))
}

pub(crate) async fn link_work_edition(
    State(state): State<AppState>, Extension(auth): Extension<AuthUser>, Json(request): Json<WorkLinkRequest>,
) -> Result<Json<WorkStore>, ApiError> {
    require_admin(&auth)?;
    state.works.mutate(|works| {
        if works.link_manually(&request.book_id, &request.work_id) { Ok(()) }
        else { Err(ApiError::not_found("Work not found")) }
    }).await?;
    Ok(Json(state.works.read().await.clone()))
}

pub(crate) async fn reject_work_suggestion(
    State(state): State<AppState>, Extension(auth): Extension<AuthUser>, Json(request): Json<WorkLinkRequest>,
) -> Result<Json<WorkStore>, ApiError> {
    require_admin(&auth)?;
    state.works.mutate(|works| {
        if works.reject_suggestion(&request.book_id, &request.work_id) { Ok(()) }
        else { Err(ApiError::not_found("Work not found")) }
    }).await?;
    Ok(Json(state.works.read().await.clone()))
}
