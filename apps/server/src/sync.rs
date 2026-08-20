//! Extracted from main.rs.

use crate::*;

pub(crate) async fn get_sync_map(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require_book_access(&auth, &book_id)?;
    let file_path = {
        let library = state.library.read().await;
        library
            .books
            .iter()
            .find(|candidate| candidate.id == book_id)
            .ok_or(ApiError::not_found("Book not found"))?;
        library
            .sync_paths
            .get(&book_id)
            .cloned()
            .ok_or(ApiError::not_found("Sync map not found"))?
    };

    serve_file_response(
        &file_path,
        &[&state.library_root, &state.sync_dir],
        headers,
        None,
    )
    .await
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
        let book = library
            .books
            .iter()
            .find(|candidate| candidate.id == book_id)
            .ok_or(ApiError::not_found("Book not found"))?;
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
                    &format!("Wrote sync map with {fragment_count} sentences.\n"),
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
        alignment::build_track_scopes(&titles, &epub.toc, epub.sections.len())
            .map_err(|message| anyhow::anyhow!(message))?
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
        generated_at: Some(now_rfc3339ish()),
        fragments,
    };
    fs::create_dir_all(&state.sync_dir).await?;
    let sync_path = state
        .sync_dir
        .join(format!("{book_id}{SYNC_SIDECAR_SUFFIX}"));
    write_json_atomic(&sync_path, &sync_map)
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;

    Ok(fragment_count)
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
