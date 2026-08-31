//! An Audiobookshelf-shaped API, for third-party players.
//!
//! Prologue, ShelfPlayer, Voice and friends already speak Audiobookshelf. This
//! module answers the subset of that API those clients use to sign in, browse
//! a library, play a book, and sync a position — so they work against an
//! OperaLibre server without anyone writing a client.
//!
//! It is mounted under `/abs`, not at the root: Audiobookshelf puts `/api/me`
//! and `/login` where OperaLibre already has its own, and quietly changing the
//! meaning of an existing route to suit a foreign client would be worse than
//! asking for a base URL with a path in it. Point the client at
//! `https://your-server/abs`.
//!
//! This is a translation layer, not an emulation. Anything a client asks for
//! that OperaLibre has no concept of is answered with the most honest empty
//! value rather than an invention.

use crate::*;

/// The single library OperaLibre presents. The server has one library root,
/// so there is one library, and its id is fixed.
pub(crate) const ABS_LIBRARY_ID: &str = "operalibre";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AbsStatusResponse {
    is_init: bool,
    language: &'static str,
    auth_methods: [&'static str; 1],
}

#[derive(Debug, Serialize)]
pub(crate) struct AbsPingResponse {
    success: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AbsLoginResponse {
    user: AbsUser,
    user_default_library_id: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AbsUser {
    id: String,
    username: String,
    #[serde(rename = "type")]
    kind: &'static str,
    token: String,
    media_progress: Vec<AbsMediaProgress>,
    is_active: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AbsMediaProgress {
    id: String,
    library_item_id: String,
    /// Seconds into the book, not into the current file.
    current_time: f64,
    duration: f64,
    /// A fraction, the way Audiobookshelf reports it.
    progress: f64,
    is_finished: bool,
    last_update: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AbsLibrary {
    id: &'static str,
    name: String,
    media_type: &'static str,
    provider: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AbsLibrariesResponse {
    libraries: Vec<AbsLibrary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AbsLibraryItem {
    id: String,
    library_id: &'static str,
    media_type: &'static str,
    // BookPlayer's current ABS integration reads these summary values from
    // the item itself before opening the full nested media object.
    kind: &'static str,
    title: String,
    author_name: Option<String>,
    narrator_name: Option<String>,
    duration: f64,
    subtitle: Option<String>,
    series: Vec<AbsSeriesReference>,
    added_at: Option<u64>,
    updated_at: Option<u64>,
    cover_path: Option<String>,
    progress: Option<f64>,
    current_time: Option<f64>,
    is_finished: Option<bool>,
    media: AbsMedia,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AbsSeriesReference {
    id: String,
    name: String,
    sequence: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AbsMedia {
    id: String,
    metadata: AbsMetadata,
    cover_path: Option<String>,
    duration: f64,
    num_tracks: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    audio_files: Vec<AbsAudioFile>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    chapters: Vec<AbsChapter>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AbsMetadata {
    title: String,
    author_name: Option<String>,
    narrator_name: Option<String>,
    description: Option<String>,
    published_year: Option<String>,
    asin: Option<String>,
    genres: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AbsAudioFile {
    index: usize,
    ino: String,
    duration: f64,
    /// Seconds into the whole book at which this file begins.
    start_offset: f64,
    title: String,
    content_url: String,
    mime_type: String,
    metadata: AbsFileMetadata,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AbsFileMetadata {
    filename: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AbsChapter {
    id: usize,
    start: f64,
    end: f64,
    title: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AbsLibraryItemsResponse {
    results: Vec<AbsLibraryItem>,
    total: usize,
    page: usize,
    limit: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AbsPlaybackSession {
    id: String,
    library_item_id: String,
    media_type: &'static str,
    play_method: u8,
    duration: f64,
    start_time: f64,
    current_time: f64,
    audio_tracks: Vec<AbsAudioFile>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    chapters: Vec<AbsChapter>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AbsProgressUpdate {
    current_time: Option<f64>,
    progress: Option<f64>,
    is_finished: Option<bool>,
    /// Audiobookshelf timestamps checkpoints in epoch milliseconds. Keeping
    /// it lets the native stale-write defense reject a delayed request.
    last_update: Option<u64>,
    /// Clients send the book's duration back with every checkpoint. The server
    /// already knows it from the scan and does not take the client's word for
    /// it, but the field is accepted so the payload still deserialises.
    #[serde(default, rename = "duration")]
    _duration: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AbsItemsQuery {
    limit: Option<usize>,
    page: Option<usize>,
}

/// Where a track begins within the whole book, and how long it runs.
fn track_offsets(book: &Book) -> Vec<(f64, f64)> {
    let mut offsets = Vec::with_capacity(book.tracks.len());
    let mut running = 0.0;
    for track in &book.tracks {
        let duration = track.duration_seconds.unwrap_or(0.0);
        offsets.push((running, duration));
        running += duration;
    }
    offsets
}

fn book_duration(book: &Book) -> f64 {
    book.duration_seconds.unwrap_or_else(|| {
        book.tracks
            .iter()
            .filter_map(|track| track.duration_seconds)
            .sum()
    })
}

fn audio_files(book: &Book, media_token: &str) -> Vec<AbsAudioFile> {
    track_offsets(book)
        .into_iter()
        .zip(&book.tracks)
        .enumerate()
        .map(|(index, ((start_offset, duration), track))| AbsAudioFile {
            index: index + 1,
            ino: track.id.clone(),
            duration,
            start_offset,
            title: track.file_name.clone(),
            // The media credential rides in the URL because a player handing
            // the address to the platform's own audio stack cannot attach a
            // header to it. It is read-only and derived from the session.
            content_url: format!(
                "/api/books/{}/tracks/{}/stream?token={}",
                book.id, track.id, media_token
            ),
            mime_type: media_content_type(FsPath::new(&track.file_name)),
            metadata: AbsFileMetadata {
                filename: track.file_name.clone(),
            },
        })
        .collect()
}

fn chapters(book: &Book) -> Vec<AbsChapter> {
    let total = book_duration(book);
    let starts: Vec<f64> = book
        .chapters
        .iter()
        .map(|chapter| chapter.start_seconds)
        .collect();
    book.chapters
        .iter()
        .enumerate()
        .map(|(index, chapter)| AbsChapter {
            id: index,
            start: chapter.start_seconds,
            // A chapter without a recorded end runs to the next one, or to the
            // end of the book. Audiobookshelf clients draw a scrubber from
            // these, and a zero-length chapter renders as a broken tick.
            end: chapter.end_seconds.unwrap_or_else(|| {
                starts
                    .get(index + 1)
                    .copied()
                    .unwrap_or(total)
                    .max(chapter.start_seconds)
            }),
            title: chapter.title.clone(),
        })
        .collect()
}

fn library_item(book: &Book, media_token: &str, include_audio_files: bool) -> AbsLibraryItem {
    let duration = book_duration(book);
    let cover_path = book
        .cover_art_url
        .as_ref()
        .map(|_| format!("/api/books/{}/cover?token={media_token}", book.id));
    let series = book
        .metadata
        .series
        .as_ref()
        .map(|name| {
            vec![AbsSeriesReference {
                id: stable_id(&format!("abs-series:{name}")),
                name: name.clone(),
                sequence: book.metadata.series_position.clone(),
            }]
        })
        .unwrap_or_default();
    let (progress, current_time, is_finished) = book
        .progress
        .as_ref()
        .map(|saved| {
            (
                saved.percent_complete.map(|percent| percent / 100.0),
                Some(saved.book_position_seconds),
                Some(matches!(saved.status, BookProgressStatus::Finished)),
            )
        })
        .unwrap_or((None, None, None));
    AbsLibraryItem {
        id: book.id.clone(),
        library_id: ABS_LIBRARY_ID,
        media_type: "book",
        kind: "book",
        title: book.title.clone(),
        author_name: book.author.clone(),
        narrator_name: book.narrator.clone(),
        duration,
        subtitle: book.metadata.subtitle.clone(),
        series,
        // OperaLibre does not currently retain library-item creation/update
        // timestamps, so leave these optional ABS fields honest.
        added_at: None,
        updated_at: None,
        cover_path: cover_path.clone(),
        progress,
        current_time,
        is_finished,
        media: AbsMedia {
            id: book.id.clone(),
            metadata: AbsMetadata {
                title: book.title.clone(),
                author_name: book.author.clone(),
                narrator_name: book.narrator.clone(),
                description: book.description.clone(),
                published_year: book.published_date.clone(),
                asin: book.asin.clone(),
                genres: book.genres.clone(),
            },
            cover_path,
            duration,
            num_tracks: book.tracks.len(),
            audio_files: if include_audio_files {
                audio_files(book, media_token)
            } else {
                Vec::new()
            },
            chapters: chapters(book),
        },
    }
}

fn media_progress(book: &Book, progress: &Progress) -> AbsMediaProgress {
    let duration = book_duration(book);
    let current_time = progress.book_position_seconds;
    AbsMediaProgress {
        id: format!("{}-{}", ABS_LIBRARY_ID, book.id),
        library_item_id: book.id.clone(),
        current_time,
        duration,
        progress: if duration > 0.0 {
            (current_time / duration).clamp(0.0, 1.0)
        } else {
            0.0
        },
        is_finished: matches!(
            summarize_book_progress(book, progress).status,
            BookProgressStatus::Finished
        ),
        last_update: progress_timestamp_millis(&progress.updated_at),
    }
}

async fn progress_for_user(
    state: &AppState,
    auth: &AuthUser,
) -> Result<Vec<AbsMediaProgress>, ApiError> {
    let saved = state.progress.list_for_user(&auth.id).await?;
    let library = state.library.read().await;
    Ok(library
        .books
        .iter()
        .filter(|book| can_access_book(auth, &book.id))
        .filter_map(|book| {
            saved
                .get(&book.id)
                .map(|progress| media_progress(book, progress))
        })
        .collect())
}

fn abs_user(auth: &AuthUser, token: String, progress: Vec<AbsMediaProgress>) -> AbsUser {
    AbsUser {
        id: auth.id.clone(),
        username: auth.username.clone(),
        kind: if auth.is_admin { "admin" } else { "user" },
        token,
        media_progress: progress,
        is_active: true,
    }
}

/// `GET /abs/status`
pub(crate) async fn abs_status(State(state): State<AppState>) -> Json<AbsStatusResponse> {
    Json(AbsStatusResponse {
        is_init: !state.users.read().await.users.is_empty(),
        language: "en-us",
        auth_methods: ["local"],
    })
}

/// `GET /abs/ping`
pub(crate) async fn abs_ping() -> Json<AbsPingResponse> {
    Json(AbsPingResponse { success: true })
}

/// `POST /abs/login`
pub(crate) async fn abs_login(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<LoginRequest>,
) -> Result<Json<AbsLoginResponse>, ApiError> {
    // Delegated so the throttle, the dummy-hash timing defence, and session
    // pruning all behave exactly as they do for a first-party client.
    let (_user, issued) = authenticate_and_open_session(&state, peer, &headers, payload).await?;
    let auth = resolve_session(&state, &issued)
        .await
        .ok_or_else(|| ApiError::internal("Session vanished immediately after sign-in."))?;
    let progress = progress_for_user(&state, &auth).await?;
    Ok(Json(AbsLoginResponse {
        user: abs_user(&auth, issued, progress),
        user_default_library_id: ABS_LIBRARY_ID,
    }))
}

/// `GET /abs/api/me`
pub(crate) async fn abs_me(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Extension(session): Extension<SessionToken>,
) -> Result<Json<AbsUser>, ApiError> {
    let progress = progress_for_user(&state, &auth).await?;
    Ok(Json(abs_user(&auth, session.0, progress)))
}

/// `GET /abs/api/libraries`
pub(crate) async fn abs_libraries(
    State(state): State<AppState>,
    Extension(_auth): Extension<AuthUser>,
) -> Json<AbsLibrariesResponse> {
    let name = state
        .library_root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Audiobooks")
        .to_string();
    Json(AbsLibrariesResponse {
        libraries: vec![AbsLibrary {
            id: ABS_LIBRARY_ID,
            name,
            media_type: "book",
            provider: "audible",
        }],
    })
}

/// `GET /abs/api/libraries/{id}/items`
pub(crate) async fn abs_library_items(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Extension(session): Extension<SessionToken>,
    Path(library_id): Path<String>,
    Query(query): Query<AbsItemsQuery>,
) -> Result<Json<AbsLibraryItemsResponse>, ApiError> {
    if library_id != ABS_LIBRARY_ID {
        return Err(ApiError::not_found("Library not found."));
    }
    let library = state.library.read().await;
    let visible: Vec<&Book> = library
        .books
        .iter()
        .filter(|book| can_access_book(&auth, &book.id))
        .collect();
    let total = visible.len();
    let limit = query
        .limit
        .filter(|limit| *limit > 0)
        .unwrap_or(total.max(1));
    let page = query.page.unwrap_or(0);
    let media_token = media_token_for_session(&session.0);
    let results = visible
        .into_iter()
        .skip(page.saturating_mul(limit))
        .take(limit)
        // The listing carries no audio files: a client fetches the item or
        // opens a playback session when it actually wants to play something.
        .map(|book| library_item(book, &media_token, false))
        .collect();
    Ok(Json(AbsLibraryItemsResponse {
        results,
        total,
        page,
        limit,
    }))
}

/// `GET /abs/api/items/{id}`
pub(crate) async fn abs_library_item(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Extension(session): Extension<SessionToken>,
    Path(item_id): Path<String>,
) -> Result<Json<AbsLibraryItem>, ApiError> {
    require_book_access(&auth, &item_id)?;
    let library = state.library.read().await;
    let book = library
        .books
        .iter()
        .find(|book| book.id == item_id)
        .ok_or(ApiError::not_found("Library item not found."))?;
    Ok(Json(library_item(
        book,
        &media_token_for_session(&session.0),
        true,
    )))
}

/// `POST /abs/api/items/{id}/play`
pub(crate) async fn abs_play(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Extension(session): Extension<SessionToken>,
    Path(item_id): Path<String>,
) -> Result<Json<AbsPlaybackSession>, ApiError> {
    require_book_access(&auth, &item_id)?;
    let saved = state.progress.get(&auth.id, &item_id).await?;
    let library = state.library.read().await;
    let book = library
        .books
        .iter()
        .find(|book| book.id == item_id)
        .ok_or(ApiError::not_found("Library item not found."))?;

    let current_time = saved
        .as_ref()
        .map(|progress| progress.book_position_seconds)
        .unwrap_or(0.0);
    Ok(Json(AbsPlaybackSession {
        id: stable_id(&format!("abs-session:{}:{}", auth.id, item_id)),
        library_item_id: book.id.clone(),
        media_type: "book",
        // Direct play: the files are served as they are, with byte ranges.
        // Nothing here transcodes.
        play_method: 0,
        duration: book_duration(book),
        start_time: current_time,
        current_time,
        audio_tracks: audio_files(book, &media_token_for_session(&session.0)),
        chapters: chapters(book),
    }))
}

/// `PATCH /abs/api/me/progress/{id}`
pub(crate) async fn abs_update_progress(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(item_id): Path<String>,
    Json(update): Json<AbsProgressUpdate>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_book_access(&auth, &item_id)?;

    let (book, requested_book_position, first_track) = {
        let library = state.library.read().await;
        let book = library
            .books
            .iter()
            .find(|book| book.id == item_id)
            .ok_or(ApiError::not_found("Library item not found."))?
            .clone();
        let duration = book_duration(&book);
        // Audiobookshelf clients send a position into the whole book, and some
        // send only a fraction. Either is turned back into the track and
        // offset OperaLibre stores.
        let book_position = update
            .current_time
            .or_else(|| update.progress.map(|fraction| fraction * duration))
            .map(|position| position.clamp(0.0, duration.max(0.0)));
        let first_track = book
            .tracks
            .first()
            .cloned()
            .ok_or(ApiError::bad_request("This book has no playable tracks."))?;
        (book, book_position, first_track)
    };

    let now_millis = unix_now_millis();
    let finished = update.is_finished;
    let last_update = update.last_update;
    let decision_book = book.clone();
    let (saved, previous) = state
        .progress
        .update_book(&auth.id, &item_id, move |previous| {
            let explicit_restart = abs_checkpoint_is_restart(
                &decision_book,
                previous,
                requested_book_position,
                finished,
            );
            let (mut saved, backup_previous) = if let Some(book_position) = requested_book_position
            {
                let (track, track_position) = track_at_book_position(&decision_book, book_position);
                let checkpoint = ProgressUpdate {
                    track_id: track.id.clone(),
                    position_seconds: track_position,
                    book_position_seconds: Some(book_position),
                    duration_seconds: track.duration_seconds,
                    updated_at_ms: last_update,
                    intentional_regression: explicit_restart,
                    intentional_seek: explicit_restart,
                    tz_offset_minutes: None,
                    speed: None,
                    client: Some("audiobookshelf".to_string()),
                };
                match decide_progress_write(
                    &decision_book,
                    &track,
                    previous,
                    &checkpoint,
                    now_millis,
                ) {
                    ProgressDecision::Keep => return ProgressDecision::Keep,
                    ProgressDecision::Store {
                        saved,
                        backup_previous,
                    } => (saved, backup_previous),
                }
            } else {
                // PATCH semantics: a completion-only request must not erase a
                // position the client deliberately omitted.
                (
                    previous.cloned().unwrap_or_else(|| Progress {
                        book_id: decision_book.id.clone(),
                        track_id: first_track.id.clone(),
                        position_seconds: 0.0,
                        book_position_seconds: 0.0,
                        duration_seconds: first_track.duration_seconds,
                        updated_at: next_progress_timestamp(previous, now_millis),
                        finished_override: None,
                    }),
                    false,
                )
            };
            if let Some(finished) = finished {
                saved.finished_override = Some(finished);
                // A completion-only PATCH is still a new media-progress
                // revision. Clients use lastUpdate to choose the newest copy.
                saved.updated_at = next_progress_timestamp(previous, now_millis);
            }
            ProgressDecision::Store {
                saved,
                backup_previous,
            }
        })
        .await?;

    let intentional_seek =
        abs_checkpoint_is_restart(&book, previous.as_ref(), requested_book_position, finished);
    record_progress_bookkeeping(
        &state,
        &auth,
        &book,
        &saved,
        previous.as_ref(),
        ProgressBookkeeping {
            intentional_seek,
            tz_offset_minutes: None,
            speed: None,
            client: Some("audiobookshelf"),
            completion_source: if finished == Some(true) {
                CompletionSource::Marked
            } else {
                CompletionSource::Reached
            },
        },
    )
    .await;

    Ok(Json(serde_json::to_value(media_progress(&book, &saved))?))
}

fn abs_checkpoint_is_restart(
    book: &Book,
    previous: Option<&Progress>,
    requested_book_position: Option<f64>,
    finished: Option<bool>,
) -> bool {
    let Some(previous) = previous else {
        return false;
    };
    finished == Some(false)
        && requested_book_position.is_some_and(|position| position < PROGRESS_NEAR_ZERO_SECONDS)
        && summarize_book_progress(book, previous).status == BookProgressStatus::Finished
}

/// `GET /abs/api/me/progress/{id}`
pub(crate) async fn abs_get_progress(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(item_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_book_access(&auth, &item_id)?;
    let saved = state.progress.get(&auth.id, &item_id).await?;
    let library = state.library.read().await;
    let book = library
        .books
        .iter()
        .find(|book| book.id == item_id)
        .ok_or(ApiError::not_found("Library item not found."))?;
    let progress = saved.ok_or(ApiError::not_found("Media progress not found."))?;
    Ok(Json(serde_json::to_value(media_progress(book, &progress))?))
}

/// `GET /abs/api/items/{id}/cover`
pub(crate) async fn abs_cover(
    state: State<AppState>,
    auth: Extension<AuthUser>,
    item_id: Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    get_cover_art(state, auth, item_id, headers).await
}

/// Which track a whole-book position lands in, and how far into it.
pub(crate) fn track_at_book_position(book: &Book, book_position: f64) -> (Track, f64) {
    let offsets = track_offsets(book);
    for ((start, duration), track) in offsets.iter().zip(&book.tracks) {
        if book_position < start + duration || duration <= &0.0 {
            return (track.clone(), (book_position - start).max(0.0));
        }
    }
    match book.tracks.last() {
        Some(track) => {
            let (start, _) = offsets.last().copied().unwrap_or((0.0, 0.0));
            (track.clone(), (book_position - start).max(0.0))
        }
        None => (
            Track {
                id: String::new(),
                title: String::new(),
                file_name: String::new(),
                index: 0,
                duration_seconds: None,
                stream_url: String::new(),
                chapters: Vec::new(),
                metadata: Default::default(),
            },
            0.0,
        ),
    }
}
