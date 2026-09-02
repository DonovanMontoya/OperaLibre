//! Sync maps: serving and generating the text-to-audio alignment a readalong
//! client follows.

use crate::*;

pub(crate) async fn get_sync_map(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require_book_access(&auth, &book_id)?;
    let (book_id, aligned_path, estimate) = {
        let library = state.library.read().await;
        let book = library.book(&book_id)?;
        let book_id = sync_file_book_id(&book.id)?;
        match library.sync_paths.get(&book_id).cloned() {
            Some(path) => (book_id, Some(path), None),
            None => {
                let estimate = estimate_input(&library, book);
                (book_id, None, estimate)
            }
        }
    };
    let file_path = match (aligned_path, estimate) {
        (Some(path), _) => path,
        (None, Some(input)) => {
            let anchors = read_manual_anchors(&manual_anchors_path(&state, &book_id)).await;
            ensure_estimated_sync_map(&state, &book_id, input, &anchors).await?
        }
        (None, None) => return Err(ApiError::not_found("Sync map not found")),
    };

    serve_file_response(
        &file_path,
        &[&state.library_root, &state.sync_dir],
        headers,
        None,
    )
    .await
}

/// What an estimate is built from: the EPUB text and the audio's chapters.
pub(crate) struct EstimateInput {
    pub(crate) epub_path: PathBuf,
    pub(crate) chapters: Vec<alignment::AudioChapter>,
    pub(crate) book_duration_seconds: f64,
}

fn estimate_input(library: &LibraryState, book: &Book) -> Option<EstimateInput> {
    let reading_file = book
        .reading_file
        .as_ref()
        .filter(|reading_file| reading_file.extension == "epub")?;
    let epub_path = library.reading_paths.get(&reading_file.id).cloned()?;
    let book_duration_seconds = book
        .duration_seconds
        .or_else(|| {
            book.tracks
                .iter()
                .map(|track| track.duration_seconds)
                .try_fold(0.0, |sum, duration| duration.map(|value| sum + value))
        })
        .unwrap_or(0.0);
    let chapters = book
        .chapters
        .iter()
        .enumerate()
        .map(|(index, chapter)| alignment::AudioChapter {
            title: chapter.title.clone(),
            start_seconds: chapter.start_seconds,
            end_seconds: chapter
                .end_seconds
                .or_else(|| book.chapters.get(index + 1).map(|next| next.start_seconds))
                .unwrap_or(book_duration_seconds)
                .max(chapter.start_seconds),
        })
        .collect();
    Some(EstimateInput {
        epub_path,
        chapters,
        book_duration_seconds,
    })
}

/// Returns the on-disk estimate for this book, building it on first use.
///
/// The file name carries a fingerprint of the EPUB and the chapter list, so
/// a stale estimate is simply never found again; older ones for the book are
/// removed once the new one is written.
/// The id a book's files under the sync directory are named after: the
/// library's own copy, never the request path as written, and only ever a
/// plain token (the scan mints hex ids), so it cannot name anything but the
/// book's files inside that directory.
pub(crate) fn sync_file_book_id(id: &str) -> Result<String, ApiError> {
    if id.is_empty()
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(ApiError::internal("The book id cannot name a sync file."));
    }
    Ok(id.to_string())
}

/// Where a book's listener-placed sync anchors live.
fn manual_anchors_path(state: &AppState, book_id: &str) -> PathBuf {
    state.sync_dir.join(format!("{book_id}.anchors.json"))
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManualAnchorStore {
    #[serde(default)]
    anchors: Vec<alignment::ManualAnchor>,
}

async fn read_manual_anchors(path: &FsPath) -> Vec<alignment::ManualAnchor> {
    match fs::read(path).await {
        Ok(bytes) => serde_json::from_slice::<ManualAnchorStore>(&bytes)
            .map(|store| store.anchors)
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// More anchors than this is a listener tapping every sentence; the newest
/// are kept.
const MAX_MANUAL_ANCHORS: usize = 400;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncAnchorRequest {
    pub(crate) href: String,
    pub(crate) text: String,
    pub(crate) seconds: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncAnchorSummary {
    pub(crate) anchor_count: usize,
}

/// "The narrator is reading this sentence right now." Kept with the book,
/// so the estimate is re-timed through it for every listener; the cached
/// estimate is dropped and rebuilt on the next request.
pub(crate) async fn add_sync_anchor(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
    Json(request): Json<SyncAnchorRequest>,
) -> Result<Json<SyncAnchorSummary>, ApiError> {
    require_book_access(&auth, &book_id)?;
    let text = request
        .text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if text.is_empty() || request.href.trim().is_empty() || text.len() > 4_000 {
        return Err(ApiError::bad_request(
            "A sync anchor needs the sentence and its document.",
        ));
    }
    if !request.seconds.is_finite() || request.seconds < 0.0 {
        return Err(ApiError::bad_request(
            "A sync anchor needs a position in the book.",
        ));
    }
    let book_id = {
        let library = state.library.read().await;
        let book = library.book(&book_id)?;
        if library.sync_paths.contains_key(&book_id) {
            return Err(ApiError::bad_request(
                "This book already has an aligned sync map; anchors only adjust estimates.",
            ));
        }
        if estimate_input(&library, book).is_none() {
            return Err(ApiError::bad_request("This book has no EPUB to sync."));
        }
        sync_file_book_id(&book.id)?
    };
    let path = manual_anchors_path(&state, &book_id);
    let mut anchors = read_manual_anchors(&path).await;
    anchors.retain(|anchor| !(anchor.href == request.href && anchor.text == text));
    anchors.push(alignment::ManualAnchor {
        href: request.href.trim().to_string(),
        text,
        seconds: request.seconds,
    });
    if anchors.len() > MAX_MANUAL_ANCHORS {
        let excess = anchors.len() - MAX_MANUAL_ANCHORS;
        anchors.drain(..excess);
    }
    fs::create_dir_all(&state.sync_dir).await.map_err(|error| {
        ApiError::internal(format!("Could not create the sync directory: {error}"))
    })?;
    let anchor_count = anchors.len();
    write_json_atomic(&path, &ManualAnchorStore { anchors }).await?;
    remove_estimates(&state, &book_id).await;
    Ok(Json(SyncAnchorSummary { anchor_count }))
}

/// Drops every listener-placed anchor for the book. Admin only, since the
/// anchors are shared by everyone who reads it.
pub(crate) async fn clear_sync_anchors(
    State(state): State<AppState>,
    _: AdminUser,
    Path(book_id): Path<String>,
) -> Result<Json<SyncAnchorSummary>, ApiError> {
    let book_id = {
        let library = state.library.read().await;
        sync_file_book_id(&library.book(&book_id)?.id)?
    };
    let path = manual_anchors_path(&state, &book_id);
    if let Err(error) = fs::remove_file(&path).await
        && error.kind() != io::ErrorKind::NotFound
    {
        return Err(ApiError::internal(format!(
            "Could not clear the sync anchors: {error}"
        )));
    }
    remove_estimates(&state, &book_id).await;
    Ok(Json(SyncAnchorSummary { anchor_count: 0 }))
}

async fn remove_estimates(state: &AppState, book_id: &str) {
    let prefix = format!("{book_id}{ESTIMATED_SYNC_INFIX}-");
    if let Ok(mut entries) = fs::read_dir(&state.sync_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            if entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(&prefix))
            {
                let _ = fs::remove_file(entry.path()).await;
            }
        }
    }
}

async fn ensure_estimated_sync_map(
    state: &AppState,
    book_id: &str,
    input: EstimateInput,
    manual_anchors: &[alignment::ManualAnchor],
) -> Result<PathBuf, ApiError> {
    let metadata = fs::metadata(&input.epub_path)
        .await
        .map_err(|_| ApiError::not_found("Readalong path not found"))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let chapter_key = input
        .chapters
        .iter()
        .map(|chapter| {
            format!(
                "{}@{:.3}-{:.3}",
                chapter.title, chapter.start_seconds, chapter.end_seconds
            )
        })
        .collect::<Vec<_>>()
        .join("|");
    let anchor_key = serde_json::to_string(manual_anchors).unwrap_or_default();
    let fingerprint = stable_id(&format!(
        "{}|{}|{}|{:.3}|{}|{}|v{}",
        input.epub_path.to_string_lossy(),
        metadata.len(),
        modified,
        input.book_duration_seconds,
        chapter_key,
        anchor_key,
        alignment::SYNC_MAP_VERSION
    ));
    let prefix = format!("{book_id}{ESTIMATED_SYNC_INFIX}-");
    let file_name = format!("{prefix}{fingerprint}{SYNC_SIDECAR_SUFFIX}");
    let path = state.sync_dir.join(&file_name);
    if fs::metadata(&path).await.is_ok() {
        return Ok(path);
    }

    let epub_bytes = fs::read(&input.epub_path)
        .await
        .map_err(|error| ApiError::internal(format!("Could not read the EPUB: {error}")))?;
    let anchors = manual_anchors.to_vec();
    let map = tokio::task::spawn_blocking(move || {
        let epub = alignment::parse_epub(&epub_bytes)
            .map_err(|error| format!("The EPUB could not be parsed: {error}"))?;
        alignment::estimate_sync_map(
            &epub,
            &input.chapters,
            input.book_duration_seconds,
            &anchors,
        )
    })
    .await
    .map_err(|error| ApiError::internal(format!("Sync estimate failed: {error}")))?
    .map_err(|message| ApiError::not_found(format!("No sync map could be estimated: {message}")))?;

    fs::create_dir_all(&state.sync_dir).await.map_err(|error| {
        ApiError::internal(format!("Could not create the sync directory: {error}"))
    })?;
    write_sync_map(&path, &map).await?;

    // Sweep estimates for this book that carried an older fingerprint.
    if let Ok(mut entries) = fs::read_dir(&state.sync_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if name.starts_with(&prefix) && name != file_name {
                let _ = fs::remove_file(entry.path()).await;
            }
        }
    }
    Ok(path)
}

pub(crate) async fn alignment_status(
    State(state): State<AppState>,
    _: AdminUser,
) -> Result<Json<serde_json::Value>, ApiError> {
    let config = &state.alignment_config;
    Ok(Json(serde_json::json!({
        "enabled": config.enabled(),
        "cliPath": config.cli_path.as_ref().map(|path| path.to_string_lossy().to_string()),
    })))
}

pub(crate) async fn generate_sync_map(
    State(state): State<AppState>,
    _: AdminUser,
    Path(book_id): Path<String>,
) -> Result<Json<JobCreated>, ApiError> {
    let Some(cli_path) = state.alignment_config.cli_path.clone() else {
        return Err(ApiError::bad_request(
            "Alignment CLI was not found. Set alignment_cli_path in server.config or put echogarden on PATH.",
        ));
    };

    let (epub_path, tracks, book_title) = {
        let library = state.library.read().await;
        let book = library.book(&book_id)?;
        let reading_file = book
            .reading_file
            .as_ref()
            .filter(|reading_file| reading_file.extension == "epub")
            .ok_or(ApiError::bad_request(
                "Sync generation needs an EPUB readalong companion for this book.",
            ))?;
        let epub_path = library
            .reading_paths
            .get(&reading_file.id)
            .cloned()
            .ok_or(ApiError::not_found("Readalong path not found"))?;
        let tracks = book
            .tracks
            .iter()
            .map(|track| {
                library
                    .track_paths
                    .get(&track.id)
                    .cloned()
                    .map(|path| SyncTrackInput {
                        path,
                        title: track.title.clone(),
                        duration_seconds: track.duration_seconds,
                    })
                    .ok_or(ApiError::not_found("Track path not found"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        (epub_path, tracks, book.title.clone())
    };
    if tracks.is_empty() {
        return Err(ApiError::bad_request("This book has no audio tracks."));
    }

    let job_id = create_job(&state, "sync-generate").await;
    let state_for_job = state.clone();
    let job_id_for_task = job_id.clone();
    tokio::spawn(async move {
        update_job_output(
            &state_for_job,
            &job_id_for_task,
            &format!("Starting readalong sync generation for {book_title}.\n"),
        )
        .await;

        let result = run_sync_generation(
            &state_for_job,
            &job_id_for_task,
            &book_id,
            &cli_path,
            &epub_path,
            &tracks,
        )
        .await;

        match result {
            Ok(fragment_count) => {
                update_job_output(
                    &state_for_job,
                    &job_id_for_task,
                    &format!("Wrote sync map with {fragment_count} sentences and word timings.\n"),
                )
                .await;
                if let Err(error) = rescan_library(&state_for_job).await {
                    update_job_finished(
                        &state_for_job,
                        &job_id_for_task,
                        "failed",
                        None,
                        Some(format!(
                            "Sync map generated, but local rescan failed: {error}"
                        )),
                    )
                    .await;
                    return;
                }
                update_job_finished(&state_for_job, &job_id_for_task, "completed", Some(0), None)
                    .await;
            }
            Err(error) => {
                update_job_finished(
                    &state_for_job,
                    &job_id_for_task,
                    "failed",
                    None,
                    Some(error.to_string()),
                )
                .await;
            }
        }
    });

    Ok(Json(JobCreated { job_id }))
}

pub(crate) struct SyncTrackInput {
    pub(crate) path: PathBuf,
    pub(crate) title: String,
    pub(crate) duration_seconds: Option<f64>,
}

pub(crate) async fn run_sync_generation(
    state: &AppState,
    job_id: &str,
    book_id: &str,
    cli_path: &FsPath,
    epub_path: &FsPath,
    tracks: &[SyncTrackInput],
) -> anyhow::Result<usize> {
    let epub_bytes = fs::read(epub_path).await?;
    let epub = tokio::task::spawn_blocking(move || alignment::parse_epub(&epub_bytes)).await??;
    anyhow::ensure!(
        !epub.sections.is_empty(),
        "No readable text sections were found in the EPUB."
    );
    update_job_output(
        state,
        job_id,
        &format!(
            "Extracted {} text sections and {} table-of-contents entries from the EPUB.\n",
            epub.sections.len(),
            epub.toc.len()
        ),
    )
    .await;

    // One scope per audio file: the whole book for single-file audiobooks,
    // otherwise chapter runs matched through the table of contents.
    let scopes = if tracks.len() == 1 {
        vec![alignment::TrackScope {
            track_index: 0,
            section_range: 0..epub.sections.len(),
        }]
    } else {
        let titles = tracks
            .iter()
            .map(|track| track.title.clone())
            .collect::<Vec<_>>();
        let scopes = alignment::build_track_scopes(&titles, &epub.toc, epub.sections.len())
            .map_err(|message| anyhow::anyhow!(message))?;
        for (index, track) in tracks.iter().enumerate() {
            if !scopes.iter().any(|scope| scope.track_index == index) {
                update_job_output(
                    state,
                    job_id,
                    &format!(
                        "Skipping `{}`: it matches no chapter in the EPUB's table of contents.\n",
                        track.title
                    ),
                )
                .await;
            }
        }
        scopes
    };

    let mut track_start_seconds = vec![0.0f64; tracks.len()];
    for index in 1..tracks.len() {
        let previous_duration = tracks[index - 1].duration_seconds.ok_or_else(|| {
            anyhow::anyhow!(
                "Track `{}` has no known duration; cannot compute book positions.",
                tracks[index - 1].title
            )
        })?;
        track_start_seconds[index] = track_start_seconds[index - 1] + previous_duration;
    }

    let temp_dir = tempfile::tempdir()?;
    let mut fragments = Vec::new();
    for (scope_number, scope) in scopes.iter().enumerate() {
        let track = &tracks[scope.track_index];
        let transcript = alignment::build_transcript(&epub.sections[scope.section_range.clone()]);
        if transcript.text.trim().is_empty() {
            continue;
        }
        let transcript_path = temp_dir
            .path()
            .join(format!("transcript-{scope_number}.txt"));
        fs::write(&transcript_path, &transcript.text).await?;
        let output_path = temp_dir
            .path()
            .join(format!("alignment-{scope_number}.json"));

        update_job_output(
            state,
            job_id,
            &format!(
                "Aligning {} of {}: {} (this can take a while)...\n",
                scope_number + 1,
                scopes.len(),
                track.title
            ),
        )
        .await;

        let output = Command::new(cli_path)
            .arg("align")
            .arg(&track.path)
            .arg(&transcript_path)
            .arg(&output_path)
            .arg("--overwrite")
            .output()
            .await
            .map_err(|error| anyhow::anyhow!("Failed to run alignment CLI: {error}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let tail = stderr
                .lines()
                .rev()
                .take(12)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n");
            anyhow::bail!(
                "Alignment failed for `{}` with status {}:\n{}",
                track.title,
                output.status,
                tail
            );
        }

        let timeline_json = fs::read_to_string(&output_path).await?;
        let entries = alignment::parse_timeline(&timeline_json)?;
        let track_fragments = alignment::fragments_from_timeline(
            &entries,
            &transcript,
            track_start_seconds[scope.track_index],
        );
        update_job_output(
            state,
            job_id,
            &format!("  Matched {} sentences.\n", track_fragments.len()),
        )
        .await;
        fragments.extend(track_fragments);
    }

    anyhow::ensure!(
        !fragments.is_empty(),
        "Alignment produced no usable sentence fragments."
    );
    fragments.sort_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds));
    let fragment_count = fragments.len();

    let sync_map = alignment::SyncMap {
        version: alignment::SYNC_MAP_VERSION,
        generator: Some("echogarden".to_string()),
        generated_at: Some(now_unix_string()),
        precision: Some(alignment::PRECISION_SENTENCE.to_string()),
        anchor_count: None,
        manual_anchor_count: None,
        fragments,
    };
    fs::create_dir_all(&state.sync_dir).await?;
    let sync_path = state
        .sync_dir
        .join(format!("{book_id}{SYNC_SIDECAR_SUFFIX}"));
    write_sync_map(&sync_path, &sync_map)
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;

    Ok(fragment_count)
}

/// Sync maps name every sentence of a book, so they are written compactly:
/// pretty-printing a long title's map adds a third to several megabytes
/// that every reader downloads.
async fn write_sync_map(path: &FsPath, map: &alignment::SyncMap) -> Result<(), ApiError> {
    let bytes = serde_json::to_vec(map)
        .map_err(|error| ApiError::internal(format!("Could not encode the sync map: {error}")))?;
    write_bytes_atomic(path, &bytes).await
}

#[derive(Debug, Clone)]
pub(crate) struct AlignmentConfig {
    pub(crate) cli_path: Option<PathBuf>,
}

impl AlignmentConfig {
    pub(crate) fn from_server_config(config: &ServerConfig) -> Self {
        let cli_path = config
            .alignment_cli_path
            .clone()
            .filter(|path| path.is_file())
            .or_else(find_alignment_cli_on_path);
        Self { cli_path }
    }

    pub(crate) fn enabled(&self) -> bool {
        self.cli_path.is_some()
    }
}

pub(crate) fn find_alignment_cli_on_path() -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    let candidates = ["echogarden", "echogarden.cmd", "echogarden.exe"];
    for dir in env::split_paths(&path_var) {
        for candidate in candidates {
            let path = dir.join(candidate);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}
