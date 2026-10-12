//! Clips: stretches of a book a listener saved to hear again or to send to
//! someone.
//!
//! A clip is a start and an end in whole-book seconds, private to the listener
//! who saved it. Nothing here reads or writes a playback position: saving,
//! trimming, and exporting a clip must never move anyone's place in the book.

use crate::*;
use rusqlite::{OptionalExtension, params};

/// Shorter than this is a slip of the finger rather than a passage.
pub(crate) const CLIP_MIN_SECONDS: f64 = 1.0;

/// A clip is a passage, not a way to export a book. The ceiling also bounds
/// how long one export can occupy a small server's processor.
pub(crate) const CLIP_MAX_SECONDS: f64 = 300.0;

const CLIP_TITLE_MAX_CHARS: usize = 200;
const CLIP_NOTE_MAX_CHARS: usize = 2_000;
const CLIPS_PER_BOOK_MAX: i64 = 500;

/// Leaves room inside the request timeout for reading the result back.
const CLIP_EXPORT_TIMEOUT_SECONDS: u64 = 75;

/// One export at a time: encoding is the only processor-heavy thing a reader
/// can ask of the server, and home servers are small.
static CLIP_EXPORT_SLOT: Semaphore = Semaphore::const_new(1);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Clip {
    pub(crate) id: String,
    pub(crate) book_id: String,
    pub(crate) start_seconds: f64,
    pub(crate) end_seconds: f64,
    pub(crate) title: Option<String>,
    pub(crate) note: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClipList {
    clips: Vec<Clip>,
    /// Whether this server can cut a clip into an audio file to share.
    can_export_audio: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClipWrite {
    /// Chosen by the client so a save retried after a dropped connection
    /// lands once. Ignored when updating.
    id: Option<String>,
    start_seconds: f64,
    end_seconds: f64,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    note: Option<String>,
}

fn valid_clip_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn new_clip_id() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn known_book_duration(book: &Book) -> Option<f64> {
    let duration = book.duration_seconds.unwrap_or_else(|| {
        book.tracks
            .iter()
            .filter_map(|track| track.duration_seconds)
            .sum()
    });
    (duration.is_finite() && duration > 0.0).then_some(duration)
}

/// Fit a requested range to the book, or say why it cannot be a clip.
pub(crate) fn clip_range(book: &Book, start: f64, end: f64) -> Result<(f64, f64), ApiError> {
    if !start.is_finite() || !end.is_finite() {
        return Err(ApiError::bad_request("A clip needs a start and an end."));
    }
    let start = start.max(0.0);
    let end = known_book_duration(book).map_or(end, |duration| end.min(duration));
    let length = end - start;
    if length < CLIP_MIN_SECONDS {
        return Err(ApiError::bad_request(
            "A clip must be at least one second long.",
        ));
    }
    if length > CLIP_MAX_SECONDS {
        return Err(ApiError::bad_request(
            "A clip can be at most five minutes long.",
        ));
    }
    Ok((start, end))
}

fn clip_text(
    value: Option<String>,
    max_chars: usize,
    name: &str,
) -> Result<Option<String>, ApiError> {
    let Some(value) = value else { return Ok(None) };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > max_chars {
        return Err(ApiError::bad_request(format!(
            "The clip {name} can be at most {max_chars} characters."
        )));
    }
    Ok(Some(trimmed.to_string()))
}

const CLIP_COLUMNS: &str =
    "id, book_id, start_seconds, end_seconds, title, note, created_at, updated_at";

fn clip_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Clip> {
    Ok(Clip {
        id: row.get(0)?,
        book_id: row.get(1)?,
        start_seconds: row.get(2)?,
        end_seconds: row.get(3)?,
        title: row.get(4)?,
        note: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn find_clip(
    connection: &rusqlite::Connection,
    user_id: &str,
    clip_id: &str,
) -> rusqlite::Result<Option<Clip>> {
    connection
        .query_row(
            &format!("SELECT {CLIP_COLUMNS} FROM clips WHERE user_id = ?1 AND id = ?2"),
            params![user_id, clip_id],
            clip_from_row,
        )
        .optional()
}

/// Forget every clip one listener saved.
pub(crate) async fn remove_user_clips(database: &Database, user_id: &str) -> Result<(), ApiError> {
    let user_id = user_id.to_string();
    database
        .call(move |connection| {
            connection.execute("DELETE FROM clips WHERE user_id = ?1", params![user_id])?;
            Ok(())
        })
        .await
}

pub(crate) async fn list_clips(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
) -> Result<Json<ClipList>, ApiError> {
    require_book_access(&auth, &book_id)?;
    state.library.read().await.book(&book_id)?;
    let user_id = auth.id.clone();
    let clips = state
        .database
        .call(move |connection| {
            let mut statement = connection.prepare(&format!(
                "SELECT {CLIP_COLUMNS} FROM clips
                 WHERE user_id = ?1 AND book_id = ?2
                 ORDER BY start_seconds, created_at"
            ))?;
            let rows = statement.query_map(params![user_id, book_id], clip_from_row)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .await?;
    Ok(Json(ClipList {
        clips,
        can_export_audio: state.faststart_tools.is_some(),
    }))
}

enum ClipInsert {
    Saved(Clip),
    /// The id already names a clip in another book.
    Taken,
    Full,
}

pub(crate) async fn create_clip(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
    Json(payload): Json<ClipWrite>,
) -> Result<Json<Clip>, ApiError> {
    require_book_access(&auth, &book_id)?;
    let book = state.library.read().await.book(&book_id)?.clone();
    let (start_seconds, end_seconds) =
        clip_range(&book, payload.start_seconds, payload.end_seconds)?;
    let id = match payload.id {
        Some(id) if valid_clip_id(&id) => id,
        Some(_) => return Err(ApiError::bad_request("The clip id is not valid.")),
        None => new_clip_id(),
    };
    let now = rfc3339_utc(unix_now_seconds());
    let clip = Clip {
        id,
        book_id,
        start_seconds,
        end_seconds,
        title: clip_text(payload.title, CLIP_TITLE_MAX_CHARS, "title")?,
        note: clip_text(payload.note, CLIP_NOTE_MAX_CHARS, "note")?,
        created_at: now.clone(),
        updated_at: now,
    };

    let user_id = auth.id.clone();
    let outcome = state
        .database
        .transaction(move |transaction| {
            // A repeated save answers with what the first one stored, so a
            // retry cannot undo a trim made in between.
            if let Some(existing) = find_clip(transaction, &user_id, &clip.id)? {
                return Ok(if existing.book_id == clip.book_id {
                    ClipInsert::Saved(existing)
                } else {
                    ClipInsert::Taken
                });
            }
            let saved: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM clips WHERE user_id = ?1 AND book_id = ?2",
                params![user_id, clip.book_id],
                |row| row.get(0),
            )?;
            if saved >= CLIPS_PER_BOOK_MAX {
                return Ok(ClipInsert::Full);
            }
            transaction.execute(
                "INSERT INTO clips (
                    user_id, id, book_id, start_seconds, end_seconds,
                    title, note, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    user_id,
                    clip.id,
                    clip.book_id,
                    clip.start_seconds,
                    clip.end_seconds,
                    clip.title,
                    clip.note,
                    clip.created_at,
                    clip.updated_at,
                ],
            )?;
            Ok(ClipInsert::Saved(clip))
        })
        .await?;
    match outcome {
        ClipInsert::Saved(clip) => Ok(Json(clip)),
        ClipInsert::Taken => Err(ApiError::conflict("That clip id is already in use.")),
        ClipInsert::Full => Err(ApiError::conflict(format!(
            "This book already has {CLIPS_PER_BOOK_MAX} clips. Remove one to save another."
        ))),
    }
}

pub(crate) async fn update_clip(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path((book_id, clip_id)): Path<(String, String)>,
    Json(payload): Json<ClipWrite>,
) -> Result<Json<Clip>, ApiError> {
    require_book_access(&auth, &book_id)?;
    let book = state.library.read().await.book(&book_id)?.clone();
    let (start_seconds, end_seconds) =
        clip_range(&book, payload.start_seconds, payload.end_seconds)?;
    let title = clip_text(payload.title, CLIP_TITLE_MAX_CHARS, "title")?;
    let note = clip_text(payload.note, CLIP_NOTE_MAX_CHARS, "note")?;
    let now = rfc3339_utc(unix_now_seconds());
    let user_id = auth.id.clone();
    state
        .database
        .transaction(move |transaction| {
            transaction.execute(
                "UPDATE clips SET
                    start_seconds = ?1, end_seconds = ?2, title = ?3, note = ?4, updated_at = ?5
                 WHERE user_id = ?6 AND id = ?7 AND book_id = ?8",
                params![
                    start_seconds,
                    end_seconds,
                    title,
                    note,
                    now,
                    user_id,
                    clip_id,
                    book_id
                ],
            )?;
            Ok(find_clip(transaction, &user_id, &clip_id)?.filter(|clip| clip.book_id == book_id))
        })
        .await?
        .map(Json)
        .ok_or(ApiError::not_found("Clip not found"))
}

pub(crate) async fn delete_clip(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path((book_id, clip_id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    require_book_access(&auth, &book_id)?;
    let user_id = auth.id.clone();
    state
        .database
        .call(move |connection| {
            connection.execute(
                "DELETE FROM clips WHERE user_id = ?1 AND id = ?2 AND book_id = ?3",
                params![user_id, clip_id, book_id],
            )?;
            Ok(())
        })
        .await?;
    // Removing a clip that is already gone is the outcome the caller wanted.
    Ok(StatusCode::NO_CONTENT)
}

/// The part of one track a clip covers.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ClipSegment {
    pub(crate) track_id: String,
    pub(crate) offset_seconds: f64,
    pub(crate) duration_seconds: f64,
}

/// Split a whole-book range across the tracks it touches.
pub(crate) fn clip_segments(book: &Book, start: f64, end: f64) -> Vec<ClipSegment> {
    let mut segments = Vec::new();
    let mut track_start = 0.0;
    for track in &book.tracks {
        let Some(duration) = track
            .duration_seconds
            .filter(|duration| duration.is_finite() && *duration > 0.0)
        else {
            // Nothing after a track of unknown length can be placed, so the
            // rest of the range is taken from this one.
            if end > track_start {
                let offset = (start - track_start).max(0.0);
                segments.push(ClipSegment {
                    track_id: track.id.clone(),
                    offset_seconds: offset,
                    duration_seconds: end - track_start - offset,
                });
            }
            return segments;
        };
        let track_end = track_start + duration;
        let from = start.max(track_start);
        let to = end.min(track_end);
        // A boundary shared with the neighbouring track is not a segment.
        if to - from > 0.01 {
            segments.push(ClipSegment {
                track_id: track.id.clone(),
                offset_seconds: from - track_start,
                duration_seconds: to - from,
            });
        }
        if track_end >= end {
            break;
        }
        track_start = track_end;
    }
    segments
}

fn clip_timestamp(seconds: f64) -> String {
    let total = seconds.max(0.0) as u64;
    let (hours, minutes, seconds) = (total / 3600, (total % 3600) / 60, total % 60);
    if hours > 0 {
        format!("{hours}h{minutes:02}m{seconds:02}s")
    } else {
        format!("{minutes}m{seconds:02}s")
    }
}

fn clip_content_disposition(name: &str) -> String {
    let safe: String = sanitize_filename(name).chars().take(120).collect();
    let ascii_fallback: String = safe
        .chars()
        .map(|character| {
            if character.is_ascii() && character != '"' && character != '\\' {
                character
            } else {
                '_'
            }
        })
        .collect();
    format!(
        "attachment; filename=\"{ascii_fallback}.m4a\"; filename*=UTF-8''{}.m4a",
        rfc8187_encode(&safe)
    )
}

/// Removes the export's working file however the request ends.
struct ClipExportFile(PathBuf);

impl Drop for ClipExportFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Encode the given stretches of audio, in order, into one AAC file.
pub(crate) async fn export_clip_audio(
    ffmpeg: &FsPath,
    inputs: &[(PathBuf, ClipSegment)],
    tags: &[(&str, String)],
    output: &FsPath,
) -> Result<(), ApiError> {
    let mut command = Command::new(ffmpeg);
    command.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]);
    for (path, segment) in inputs {
        // Seeking before the input decodes only the stretch that is kept,
        // which is what makes a clip from hour nine as quick as one from
        // minute one.
        command
            .arg("-ss")
            .arg(format!("{:.3}", segment.offset_seconds))
            .arg("-t")
            .arg(format!("{:.3}", segment.duration_seconds))
            .arg("-i")
            .arg(path);
    }
    if inputs.len() == 1 {
        command.args(["-map", "0:a:0"]);
    } else {
        let joined: String = (0..inputs.len())
            .map(|index| format!("[{index}:a:0]"))
            .collect();
        command
            .arg("-filter_complex")
            .arg(format!("{joined}concat=n={}:v=0:a=1[clip]", inputs.len()))
            .args(["-map", "[clip]"]);
    }
    // The book's own tags and chapter list describe the whole recording.
    command.args(["-map_metadata", "-1", "-map_chapters", "-1"]);
    for (key, value) in tags {
        command.arg("-metadata").arg(format!("{key}={value}"));
    }
    command
        .args(["-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart"])
        .arg(output)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let finished = tokio::time::timeout(
        Duration::from_secs(CLIP_EXPORT_TIMEOUT_SECONDS),
        command.output(),
    )
    .await
    .map_err(|_| {
        ApiError::service_unavailable("The server took too long to prepare this clip. Try again.")
    })?
    .map_err(|error| ApiError::internal(format!("Could not start ffmpeg: {error}")))?;
    if !finished.status.success() {
        return Err(ApiError::internal(format!(
            "ffmpeg could not export the clip: {}",
            String::from_utf8_lossy(&finished.stderr).trim()
        )));
    }
    Ok(())
}

pub(crate) async fn clip_audio(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path((book_id, clip_id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    require_book_access(&auth, &book_id)?;
    let Some(tools) = state.faststart_tools.clone() else {
        return Err(ApiError::not_found(
            "This server cannot export clip audio because ffmpeg is not installed.",
        ));
    };
    let user_id = auth.id.clone();
    let wanted = clip_id.clone();
    let clip = state
        .database
        .call(move |connection| find_clip(connection, &user_id, &wanted))
        .await?
        .filter(|clip| clip.book_id == book_id)
        .ok_or(ApiError::not_found("Clip not found"))?;

    let (book, inputs) = {
        let library = state.library.read().await;
        let book = library.book(&book_id)?.clone();
        let inputs = clip_segments(&book, clip.start_seconds, clip.end_seconds)
            .into_iter()
            .map(|segment| {
                library
                    .track_paths
                    .get(&segment.track_id)
                    .cloned()
                    .map(|path| (path, segment))
                    .ok_or(ApiError::not_found("Track path not found"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        (book, inputs)
    };
    if inputs.is_empty() {
        return Err(ApiError::not_found(
            "This clip is outside the book's audio.",
        ));
    }
    // The same containment check streaming applies, so a link planted in the
    // library cannot be read out through an export.
    let roots = vec![state.library_root.clone()];
    let paths: Vec<PathBuf> = inputs.iter().map(|(path, _)| path.clone()).collect();
    tokio::task::spawn_blocking(move || {
        paths
            .iter()
            .try_for_each(|path| open_contained_file(path, &roots).map(|_| ()))
    })
    .await
    .map_err(|error| ApiError::internal(format!("Could not open media file: {error}")))?
    .map_err(|_| ApiError::not_found("Media file not found"))?;

    let moment = clip_timestamp(clip.start_seconds);
    let title = clip
        .title
        .clone()
        .unwrap_or_else(|| format!("{} at {moment}", book.title));
    let mut tags = vec![("title", title), ("album", book.title.clone())];
    if let Some(author) = &book.author {
        tags.push(("artist", author.clone()));
    }
    let download_name = match &clip.title {
        Some(title) => format!("{} - {title}", book.title),
        None => format!("{} - {moment}", book.title),
    };

    let _slot = CLIP_EXPORT_SLOT
        .acquire()
        .await
        .map_err(|_| ApiError::internal("Clip export is unavailable."))?;
    let output = ClipExportFile(
        state
            .download_temp_dir
            .join(format!("clip-{}.m4a", new_clip_id())),
    );
    export_clip_audio(&tools.ffmpeg, &inputs, &tags, &output.0).await?;
    let audio = fs::read(&output.0).await?;

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "audio/mp4")
        .header(CONTENT_LENGTH, audio.len())
        .header(CACHE_CONTROL, "private, no-store")
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            clip_content_disposition(&download_name),
        )
        .body(Body::from(audio))?)
}
