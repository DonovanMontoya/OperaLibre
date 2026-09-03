//! Admin endpoints for faststart optimization: surveying which MP4s still
//! carry a trailing `moov` and running the conversion as a background job.

use crate::*;

pub(crate) const FASTSTART_JOB_KIND: &str = "library-faststart";

/// A saved position that moved this recently means somebody is very likely
/// mid-chapter. Their player is fetching byte ranges that would land somewhere
/// else in a rewritten container, so that book waits for the next run.
pub(crate) const FASTSTART_ACTIVE_LISTENER_SECONDS: u64 = 15 * 60;

#[derive(Debug, Clone)]
pub(crate) struct FaststartCandidate {
    pub(crate) book_id: String,
    pub(crate) path: PathBuf,
    pub(crate) bytes: u64,
}

#[derive(Debug, Default)]
pub(crate) struct FaststartSurvey {
    pub(crate) mp4_files: usize,
    pub(crate) optimized_files: usize,
    pub(crate) unreadable_files: usize,
    pub(crate) pending: Vec<FaststartCandidate>,
    /// Book id to display title, for every book that has pending files.
    pub(crate) titles: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FaststartBookSummary {
    pub(crate) book_id: String,
    pub(crate) title: String,
    pub(crate) pending_files: usize,
    pub(crate) pending_bytes: u64,
    /// Somebody's position moved recently, so this book is skipped unless the
    /// administrator asks for it anyway.
    pub(crate) in_use: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FaststartStatusResponse {
    pub(crate) enabled: bool,
    pub(crate) ffmpeg_path: Option<String>,
    pub(crate) ffprobe_path: Option<String>,
    /// Without ffprobe a conversion can only be checked by container layout
    /// and size, never by duration, streams, or chapters.
    pub(crate) verification_limited: bool,
    pub(crate) mp4_files: usize,
    pub(crate) optimized_files: usize,
    pub(crate) pending_files: usize,
    pub(crate) unreadable_files: usize,
    pub(crate) pending_bytes: u64,
    pub(crate) books: Vec<FaststartBookSummary>,
    pub(crate) active_job_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FaststartRequest {
    /// Convert one book instead of the whole library.
    #[serde(default)]
    pub(crate) book_id: Option<String>,
    /// Convert books that look like somebody is listening to them right now.
    #[serde(default)]
    pub(crate) include_active: bool,
}

pub(crate) async fn faststart_status(
    State(state): State<AppState>,
    _: AdminUser,
) -> Result<Json<FaststartStatusResponse>, ApiError> {
    let survey = survey_faststart(&state, None).await?;
    let active_books = recently_active_book_ids(&state).await?;

    let mut books: HashMap<String, FaststartBookSummary> = HashMap::new();
    for candidate in &survey.pending {
        let entry =
            books
                .entry(candidate.book_id.clone())
                .or_insert_with(|| FaststartBookSummary {
                    book_id: candidate.book_id.clone(),
                    title: survey
                        .titles
                        .get(&candidate.book_id)
                        .cloned()
                        .unwrap_or_else(|| candidate.book_id.clone()),
                    pending_files: 0,
                    pending_bytes: 0,
                    in_use: active_books.contains(&candidate.book_id),
                });
        entry.pending_files += 1;
        entry.pending_bytes += candidate.bytes;
    }
    let mut books = books.into_values().collect::<Vec<_>>();
    books.sort_by(|a, b| a.title.cmp(&b.title));

    let active_job_id = active_job_id(&*state.jobs.read().await, FASTSTART_JOB_KIND);

    Ok(Json(FaststartStatusResponse {
        enabled: state.faststart_tools.is_some(),
        ffmpeg_path: state
            .faststart_tools
            .as_ref()
            .map(|tools| tools.ffmpeg.to_string_lossy().to_string()),
        ffprobe_path: state
            .faststart_tools
            .as_ref()
            .and_then(|tools| tools.ffprobe.as_ref())
            .map(|path| path.to_string_lossy().to_string()),
        verification_limited: state
            .faststart_tools
            .as_ref()
            .is_some_and(|tools| tools.ffprobe.is_none()),
        mp4_files: survey.mp4_files,
        optimized_files: survey.optimized_files,
        unreadable_files: survey.unreadable_files,
        pending_files: survey.pending.len(),
        pending_bytes: survey.pending.iter().map(|entry| entry.bytes).sum(),
        books,
        active_job_id,
    }))
}

pub(crate) async fn start_faststart_conversion(
    State(state): State<AppState>,
    _: AdminUser,
    Json(payload): Json<FaststartRequest>,
) -> Result<Json<JobCreated>, ApiError> {
    if state.faststart_tools.is_none() {
        return Err(ApiError::bad_request(
            "ffmpeg was not found. Set ffmpeg_path in server.config or put ffmpeg on PATH.",
        ));
    }
    if let Some(book_id) = payload.book_id.as_deref() {
        state.library.read().await.book(book_id)?;
    }

    let (job_id, created) =
        create_queued_job(&state, FASTSTART_JOB_KIND, payload.book_id.clone()).await;
    if created {
        spawn_faststart_job(state, job_id.clone(), payload);
    }
    Ok(Json(JobCreated { job_id }))
}

/// Reads the head of every MP4-family file in the library (or one book) to see
/// which ones still carry a trailing `moov`.
pub(crate) async fn survey_faststart(
    state: &AppState,
    book_id: Option<&str>,
) -> Result<FaststartSurvey, ApiError> {
    let (files, titles) = {
        let library = state.library.read().await;
        let mut files = Vec::new();
        let mut titles = HashMap::new();
        for book in &library.books {
            if book_id.is_some_and(|wanted| wanted != book.id) {
                continue;
            }
            titles.insert(book.id.clone(), book.title.clone());
            for track in &book.tracks {
                if let Some(path) = library.track_paths.get(&track.id)
                    && faststart::is_mp4_file(path)
                {
                    files.push((book.id.clone(), path.clone()));
                }
            }
        }
        (files, titles)
    };

    tokio::task::spawn_blocking(move || {
        let mut survey = FaststartSurvey {
            titles,
            ..FaststartSurvey::default()
        };
        for (book_id, path) in files {
            survey.mp4_files += 1;
            let bytes = std::fs::metadata(&path).map(|entry| entry.len()).ok();
            match (faststart::inspect(&path), bytes) {
                (Ok(faststart::Layout::Trailing), Some(bytes)) => {
                    survey.pending.push(FaststartCandidate {
                        book_id,
                        path,
                        bytes,
                    });
                }
                (Ok(faststart::Layout::Faststart), _) => survey.optimized_files += 1,
                _ => survey.unreadable_files += 1,
            }
        }
        survey.pending.sort_by(|a, b| a.path.cmp(&b.path));
        survey
    })
    .await
    .map_err(|error| ApiError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        message: error.to_string(),
    })
}

/// Books whose saved position moved inside the active-listener window.
pub(crate) async fn recently_active_book_ids(
    state: &AppState,
) -> Result<HashSet<String>, ApiError> {
    let window_ms = FASTSTART_ACTIVE_LISTENER_SECONDS.saturating_mul(1_000);
    state.progress.book_ids_active_within(window_ms).await
}

pub(crate) fn spawn_faststart_job(state: AppState, job_id: String, request: FaststartRequest) {
    tokio::spawn(run_job(state.clone(), job_id.clone(), async move {
        // One conversion at a time: these rewrite files under the library
        // root, and a queued second job should wait rather than interleave.
        let _guard = state.faststart_lock.lock().await;
        update_job_running(&state, &job_id).await;
        match run_faststart_job(&state, &job_id, &request).await {
            Ok(report) => {
                let status = if report.failed > 0 {
                    "failed"
                } else {
                    "completed"
                };
                let error = (report.failed > 0).then(|| {
                    format!(
                        "{} file{} could not be converted and were left untouched.",
                        report.failed,
                        if report.failed == 1 { "" } else { "s" }
                    )
                });
                update_job_finished(&state, &job_id, status, Some(0), error).await;
            }
            Err(error) => {
                update_job_output(&state, &job_id, &format!("{error}\n")).await;
                update_job_finished(&state, &job_id, "failed", None, Some(error.to_string())).await;
            }
        }
    }));
}

#[derive(Debug, Default)]
pub(crate) struct FaststartReport {
    pub(crate) converted: usize,
    pub(crate) skipped: usize,
    pub(crate) failed: usize,
}

pub(crate) async fn run_faststart_job(
    state: &AppState,
    job_id: &str,
    request: &FaststartRequest,
) -> anyhow::Result<FaststartReport> {
    let tools = state
        .faststart_tools
        .clone()
        .ok_or_else(|| anyhow::anyhow!("ffmpeg was not found."))?;
    if tools.ffprobe.is_none() {
        update_job_output(
            state,
            job_id,
            "ffprobe was not found: conversions are verified by container layout and size only.\n",
        )
        .await;
    }

    let survey = survey_faststart(state, request.book_id.as_deref())
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;
    let mut report = FaststartReport::default();
    if survey.pending.is_empty() {
        update_job_output(state, job_id, "Every MP4 file already starts fast.\n").await;
        return Ok(report);
    }

    let active_books = if request.include_active {
        HashSet::new()
    } else {
        recently_active_book_ids(state)
            .await
            .map_err(|error| anyhow::anyhow!(error.message))?
    };

    // Clear anything a crashed earlier run left beside the books it touched.
    let directories = survey
        .pending
        .iter()
        .filter_map(|candidate| candidate.path.parent().map(FsPath::to_path_buf))
        .collect::<HashSet<_>>();
    let swept = tokio::task::spawn_blocking(move || {
        directories
            .iter()
            .map(|directory| faststart::sweep_work_files(directory))
            .sum::<usize>()
    })
    .await
    .unwrap_or(0);
    if swept > 0 {
        update_job_output(
            state,
            job_id,
            &format!("Removed {swept} leftover work file(s) from an interrupted run.\n"),
        )
        .await;
    }

    let total = survey.pending.len();
    update_job_output(
        state,
        job_id,
        &format!(
            "Converting {total} file(s) to faststart ({}).\n",
            human_bytes(survey.pending.iter().map(|entry| entry.bytes).sum())
        ),
    )
    .await;

    let reserve_bytes = state
        .min_download_free_bytes
        .max(faststart::MIN_FREE_HEADROOM_BYTES);

    for (index, candidate) in survey.pending.iter().enumerate() {
        let label = library_identity_path(&state.library_root, &candidate.path);
        let position = index + 1;

        if active_books.contains(&candidate.book_id) {
            report.skipped += 1;
            update_job_output(
                state,
                job_id,
                &format!("[{position}/{total}] skipped {label}: somebody is listening to it.\n"),
            )
            .await;
            continue;
        }

        let path = candidate.path.clone();
        let tools = tools.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            // The survey may be minutes old by now; only convert what is
            // still both present and trailing.
            match faststart::inspect(&path) {
                Ok(faststart::Layout::Trailing) => {}
                Ok(_) => return Ok(None),
                Err(error) => return Err(faststart::ConversionError::Io(error)),
            }
            faststart::convert_in_place(&tools, &path, reserve_bytes).map(Some)
        })
        .await;

        let line = match outcome {
            Ok(Ok(Some(converted))) => {
                report.converted += 1;
                let unverified = if converted.duration_verified {
                    ""
                } else {
                    " (layout and size verified only)"
                };
                format!(
                    "[{position}/{total}] converted {label}: {} -> {}{unverified}\n",
                    human_bytes(converted.before_bytes),
                    human_bytes(converted.after_bytes)
                )
            }
            Ok(Ok(None)) => {
                report.skipped += 1;
                format!("[{position}/{total}] skipped {label}: no longer needs converting.\n")
            }
            Ok(Err(error)) => {
                report.failed += 1;
                tracing::warn!("faststart conversion failed for {label}: {error}");
                format!("[{position}/{total}] failed {label}: {error}\n")
            }
            Err(error) => {
                report.failed += 1;
                format!("[{position}/{total}] failed {label}: {error}\n")
            }
        };
        update_job_output(state, job_id, &line).await;
    }

    if report.converted > 0 {
        // Durations, tags, and fingerprints all come from the files that just
        // changed. Book and track ids are keyed on library paths, which the
        // in-place swap preserved, so saved progress survives the rescan.
        if let Err(error) = rescan_library(state).await {
            update_job_output(
                state,
                job_id,
                &format!("The library rescan after conversion failed: {error}\n"),
            )
            .await;
        }
    }

    update_job_output(
        state,
        job_id,
        &format!(
            "Done: {} converted, {} skipped, {} failed.\n",
            report.converted, report.skipped, report.failed
        ),
    )
    .await;
    Ok(report)
}
