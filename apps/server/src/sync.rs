//! Sync maps: serving and generating the text-to-audio alignment a readalong
//! client follows.

use crate::updates::SyncAddonRuntime;
use crate::*;

pub(crate) const SYNC_GENERATE_JOB_KIND: &str = "sync-generate";

/// The longest one aligner run may take before the job is failed and the
/// process killed. Alignment is slow on a long chapter, so this is a ceiling
/// against a hung CLI, not a budget.
pub(crate) const ALIGNMENT_COMMAND_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);

pub(crate) async fn get_sync_map(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require_book_access(&auth, &book_id)?;
    let file_path = {
        let library = state.library.read().await;
        let book = library.book(&book_id)?;
        let book_id = sync_file_book_id(&book.id)?;
        library
            .sync_paths
            .get(&book_id)
            .cloned()
            .ok_or_else(|| ApiError::not_found("Sync map not found"))?
    };

    serve_file_response(
        &file_path,
        &[&state.library_root, &state.sync_dir],
        headers,
        None,
        FileCaching::Revalidated,
    )
    .await
}

/// The id a book's files under the sync directory are named after: the
/// library's own copy, never the request path as written, and only ever a
/// plain token (the scan mints hex ids), so it cannot name anything but the
/// book's files inside that directory.
pub(crate) fn sync_file_book_id(id: &str) -> Result<String, ApiError> {
    if !is_plain_file_token(id) {
        return Err(ApiError::internal("The book id cannot name a sync file."));
    }
    Ok(id.to_string())
}

pub(crate) async fn alignment_status(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let runtime = state
        .update_manager
        .sync_addon_runtime(state.alignment_config.cli_path.as_deref())
        .await;
    Ok(Json(serde_json::json!({
        "enabled": runtime.is_some(),
        "cliPath": runtime.as_ref().filter(|_| auth.is_admin).map(|runtime| runtime.cli_path.to_string_lossy().to_string()),
    })))
}

pub(crate) async fn generate_sync_map(
    State(state): State<AppState>,
    _: AdminUser,
    Path(book_id): Path<String>,
) -> Result<Json<JobCreated>, ApiError> {
    enqueue_sync_map(state, book_id).await
}

pub(crate) async fn enqueue_sync_map(
    state: AppState,
    book_id: String,
) -> Result<Json<JobCreated>, ApiError> {
    let lifecycle = state
        .update_manager
        .sync_lifecycle
        .clone()
        .try_read_owned()
        .map_err(|_| {
            ApiError::conflict("The sync add-on is being changed. Try again when it finishes.")
        })?;
    let Some(mut runtime) = state
        .update_manager
        .sync_addon_runtime(state.alignment_config.cli_path.as_deref())
        .await
    else {
        return Err(ApiError::bad_request(
            "Follow-along sync generation is not enabled. An owner can install and enable it under Administration → Experimental features.",
        ));
    };
    runtime.ffmpeg_path = runtime.ffmpeg_path.or_else(|| {
        state
            .faststart_tools
            .as_ref()
            .map(|tools| tools.ffmpeg.clone())
    });

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
                        chapters: track
                            .chapters
                            .iter()
                            .map(|chapter| SyncChapterInput {
                                title: chapter.title.clone(),
                                start_seconds: chapter.start_seconds,
                                end_seconds: chapter.end_seconds,
                            })
                            .collect(),
                    })
                    .ok_or(ApiError::not_found("Track path not found"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        (epub_path, tracks, book.title.clone())
    };
    if tracks.is_empty() {
        return Err(ApiError::bad_request("This book has no audio tracks."));
    }

    let (job_id, created) =
        create_queued_job(&state, SYNC_GENERATE_JOB_KIND, Some(book_id.clone())).await;
    if !created {
        return Ok(Json(JobCreated { job_id }));
    }
    update_job_progress(
        &state,
        &job_id,
        JobProgress::new("Waiting for the sync queue"),
    )
    .await;
    let state_for_job = state.clone();
    let job_id_for_task = job_id.clone();
    tokio::spawn(run_job(state.clone(), job_id.clone(), async move {
        let _lifecycle = lifecycle;
        let _slot = state_for_job
            .update_manager
            .sync_slots
            .acquire()
            .await
            .expect("sync queue stays open for the lifetime of the server");
        update_job_running(&state_for_job, &job_id_for_task).await;
        update_job_progress(
            &state_for_job,
            &job_id_for_task,
            JobProgress::new("Reading the ebook").fraction(0.0),
        )
        .await;
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
            &runtime,
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
                update_job_progress(
                    &state_for_job,
                    &job_id_for_task,
                    JobProgress::new("Refreshing the library").fraction(0.98),
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
    }));

    Ok(Json(JobCreated { job_id }))
}

pub(crate) struct SyncTrackInput {
    pub(crate) path: PathBuf,
    pub(crate) title: String,
    pub(crate) duration_seconds: Option<f64>,
    pub(crate) chapters: Vec<SyncChapterInput>,
}

pub(crate) struct SyncChapterInput {
    pub(crate) title: String,
    pub(crate) start_seconds: f64,
    pub(crate) end_seconds: Option<f64>,
}

struct SyncAlignmentScope {
    track_index: usize,
    section_range: std::ops::Range<usize>,
    audio_range: Option<(f64, f64)>,
    time_offset_seconds: f64,
    label: String,
}

/// The share of the progress bar given to alignment itself. Reading the EPUB
/// and matching chapters come before it, writing the map and rescanning the
/// library after; both are quick next to the aligner, but a bar that sat at
/// 0 % or 100 % through them would look stuck.
const ALIGN_PROGRESS_START: f64 = 0.03;
const ALIGN_PROGRESS_END: f64 = 0.95;

/// Where one scope sits in the whole run, so each window it finishes can move
/// the bar rather than leaving it parked until the chapter ends.
struct ScopeProgress {
    base: f64,
    span: f64,
    step: String,
    completed: usize,
    total: usize,
}

impl ScopeProgress {
    fn at(&self, done: f64) -> JobProgress {
        JobProgress::new(self.step.clone())
            .fraction(self.base + self.span * done.clamp(0.0, 1.0))
            .steps(self.completed, self.total)
    }

    /// A single aligner run says nothing until it returns. Where the book is
    /// one scope there is no other movement to fall back on, so report the
    /// step without a fraction and let the reader show work in hand rather
    /// than a number parked at the start for the whole run.
    fn indeterminate(&self) -> JobProgress {
        JobProgress::new(self.step.clone()).steps(self.completed, self.total)
    }
}

/// How long a scope's audio runs, used only to weight the progress bar: a
/// half-hour chapter should move it further than a two-minute one.
fn scope_audio_seconds(scope: &SyncAlignmentScope, tracks: &[SyncTrackInput]) -> Option<f64> {
    match scope.audio_range {
        Some((start, end)) => (end > start).then_some(end - start),
        None => tracks[scope.track_index]
            .duration_seconds
            .filter(|seconds| *seconds > 0.0),
    }
}

/// Do not mix real seconds with a made-up fallback: if any scope is missing a
/// duration, equal weights keep that scope from receiving a one-second sliver.
fn scope_progress_weights(scopes: &[SyncAlignmentScope], tracks: &[SyncTrackInput]) -> Vec<f64> {
    scopes
        .iter()
        .map(|scope| scope_audio_seconds(scope, tracks))
        .collect::<Option<Vec<_>>>()
        .unwrap_or_else(|| vec![1.0; scopes.len()])
}

pub(crate) async fn run_sync_generation(
    state: &AppState,
    job_id: &str,
    book_id: &str,
    runtime: &SyncAddonRuntime,
    epub_path: &FsPath,
    tracks: &[SyncTrackInput],
) -> anyhow::Result<usize> {
    let epub_path_owned = epub_path.to_path_buf();
    let epub =
        tokio::task::spawn_blocking(move || alignment::parse_epub_file(&epub_path_owned)).await??;
    anyhow::ensure!(
        !epub.sections.is_empty(),
        "No readable text sections were found in the EPUB."
    );
    update_job_progress(
        state,
        job_id,
        JobProgress::new("Matching the chapters to the text").fraction(0.01),
    )
    .await;
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

    // Prefer embedded chapter boundaries for a single large audio file. This
    // resets the aligner throughout an M4B instead of letting small errors
    // accumulate over the entire book. Keep the established whole-track path
    // when chapter metadata, TOC matching, or ffmpeg slicing is unavailable.
    let scopes = if tracks.len() == 1 {
        match chapter_alignment_scopes(
            &tracks[0],
            &epub.toc,
            epub.sections.len(),
            runtime.ffmpeg_path.is_some(),
        ) {
            Ok(scopes) => {
                update_job_output(
                    state,
                    job_id,
                    &format!(
                        "Matched {} embedded audio chapters; aligning each independently.\n",
                        scopes.len()
                    ),
                )
                .await;
                scopes
            }
            Err(reason) => {
                update_job_output(
                    state,
                    job_id,
                    &format!("Using whole-track alignment: {reason}\n"),
                )
                .await;
                vec![SyncAlignmentScope {
                    track_index: 0,
                    section_range: 0..epub.sections.len(),
                    audio_range: None,
                    time_offset_seconds: 0.0,
                    label: tracks[0].title.clone(),
                }]
            }
        }
    } else {
        let titles = tracks
            .iter()
            .map(|track| track.title.clone())
            .collect::<Vec<_>>();
        alignment::build_track_scopes(&titles, &epub.toc, epub.sections.len())
            .map_err(|message| anyhow::anyhow!(message))?
            .into_iter()
            .map(|scope| SyncAlignmentScope {
                track_index: scope.track_index,
                section_range: scope.section_range,
                audio_range: None,
                time_offset_seconds: track_start_seconds[scope.track_index],
                label: tracks[scope.track_index].title.clone(),
            })
            .collect()
    };

    let recognition = RecognitionSettings::for_language(epub.language.as_deref());
    if runtime.ffmpeg_path.is_some() {
        update_job_output(
            state,
            job_id,
            &format!(
                "Audio longer than {:.0} minutes is aligned in {:.0}-second windows anchored by speech recognition ({}).\n",
                MAX_SINGLE_PASS_SECONDS / 60.0,
                WINDOW_SECONDS,
                recognition.describe()
            ),
        )
        .await;
    }

    let temp_dir = tempfile::tempdir()?;
    let aligner = Aligner {
        state,
        job_id,
        cli_path: &runtime.cli_path,
        cli_args: &runtime.cli_args,
        ffmpeg_path: runtime.ffmpeg_path.as_deref(),
        temp_dir: temp_dir.path(),
        recognition: &recognition,
    };
    let scope_unit = if tracks.len() > 1 {
        "track"
    } else if scopes.len() > 1 {
        "chapter"
    } else {
        "section"
    };
    let scope_weights = scope_progress_weights(&scopes, tracks);
    let total_weight = scope_weights.iter().sum::<f64>().max(f64::MIN_POSITIVE);
    let mut done_weight = 0.0f64;
    let mut fragments = Vec::new();
    for (scope_number, scope) in scopes.iter().enumerate() {
        let track = &tracks[scope.track_index];
        let progress = ScopeProgress {
            base: ALIGN_PROGRESS_START
                + (ALIGN_PROGRESS_END - ALIGN_PROGRESS_START) * (done_weight / total_weight),
            span: (ALIGN_PROGRESS_END - ALIGN_PROGRESS_START)
                * (scope_weights[scope_number] / total_weight),
            step: if scopes.len() > 1 {
                format!(
                    "Aligning {scope_unit} {} of {}: {}",
                    scope_number + 1,
                    scopes.len(),
                    scope.label
                )
            } else {
                "Aligning the narration to the text".to_string()
            },
            completed: scope_number,
            total: scopes.len(),
        };
        done_weight += scope_weights[scope_number];
        let transcript = alignment::build_transcript(&epub.sections[scope.section_range.clone()]);
        if transcript.text.trim().is_empty() {
            continue;
        }
        update_job_progress(state, job_id, progress.at(0.0)).await;
        update_job_output(
            state,
            job_id,
            &format!(
                "Aligning {} of {}: {} (this can take a while)...\n",
                scope_number + 1,
                scopes.len(),
                scope.label
            ),
        )
        .await;

        let scope_fragments = aligner
            .align_scope(scope, track, &transcript, scope_number, &progress)
            .await?;
        update_job_output(
            state,
            job_id,
            &format!("  Matched {} sentences.\n", scope_fragments.len()),
        )
        .await;
        fragments.extend(scope_fragments);
    }

    anyhow::ensure!(
        !fragments.is_empty(),
        "Alignment produced no usable sentence fragments."
    );
    update_job_progress(
        state,
        job_id,
        JobProgress::new("Saving the sync map").fraction(ALIGN_PROGRESS_END),
    )
    .await;
    fragments.sort_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds));
    let fragment_count = fragments.len();

    let sync_map = alignment::SyncMap {
        version: alignment::SYNC_MAP_VERSION,
        generator: Some("echogarden".to_string()),
        generated_at: Some(now_unix_string()),
        precision: Some(alignment::PRECISION_SENTENCE.to_string()),
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

fn chapter_alignment_scopes(
    track: &SyncTrackInput,
    toc: &[alignment::TocEntry],
    section_count: usize,
    ffmpeg_available: bool,
) -> Result<Vec<SyncAlignmentScope>, String> {
    if !ffmpeg_available {
        return Err("ffmpeg is unavailable for embedded-chapter slicing.".to_string());
    }
    let titles = track
        .chapters
        .iter()
        .map(|chapter| chapter.title.clone())
        .collect::<Vec<_>>();
    let matched = alignment::build_chapter_scopes(&titles, toc, section_count)?;

    matched
        .into_iter()
        .map(|scope| {
            let chapter = &track.chapters[scope.chapter_index];
            let start_seconds = chapter.start_seconds;
            let end_seconds = chapter
                .end_seconds
                .or_else(|| {
                    track
                        .chapters
                        .get(scope.chapter_index + 1)
                        .map(|next| next.start_seconds)
                })
                .or(track.duration_seconds)
                .ok_or_else(|| format!("Chapter `{}` has no usable end time.", chapter.title))?;
            if !start_seconds.is_finite()
                || !end_seconds.is_finite()
                || start_seconds < 0.0
                || end_seconds <= start_seconds
            {
                return Err(format!(
                    "Chapter `{}` has an invalid audio time range.",
                    chapter.title
                ));
            }
            Ok(SyncAlignmentScope {
                track_index: 0,
                section_range: scope.section_range,
                audio_range: Some((start_seconds, end_seconds)),
                time_offset_seconds: start_seconds,
                label: chapter.title.clone(),
            })
        })
        .collect()
}

/// Audio the forced aligner sees at once. Its working set grows with input
/// length (about 1.4 GB per 1,000 s of audio on a 55-hour test book), so
/// longer scopes are cut into windows this size, each tied to the transcript
/// by speech recognition.
const WINDOW_SECONDS: f64 = 240.0;
/// A window's closing anchor must end this long before the window does, so
/// the recognizer had context on both sides of the words it was matched on.
const WINDOW_MARGIN_SECONDS: f64 = 30.0;
/// Scopes up to this long are aligned in a single pass. Longer ones are
/// windowed, and a windowed scope's final stretch is at most this long.
const MAX_SINGLE_PASS_SECONDS: f64 = WINDOW_SECONDS * 1.5;
/// How much transcript to search when matching a window's recognized words,
/// as a multiple of what the window would cover at the scope's average pace.
const WINDOW_TEXT_LOOKAHEAD: f64 = 1.8;

/// Which recognizer model to anchor windows with. English books get the
/// English-only model, which is markedly better at the same size.
struct RecognitionSettings {
    model: &'static str,
    language: Option<String>,
}

impl RecognitionSettings {
    fn for_language(language: Option<&str>) -> Self {
        let code = language
            .and_then(|value| value.split(['-', '_']).next())
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty());
        match code {
            Some(code) if code == "en" => Self {
                model: "tiny.en",
                language: Some(code),
            },
            Some(code) => Self {
                model: "tiny",
                language: Some(code),
            },
            None => Self {
                model: "tiny",
                language: None,
            },
        }
    }

    fn describe(&self) -> String {
        match &self.language {
            Some(language) => format!("whisper {}, language {language}", self.model),
            None => format!("whisper {}, language detected", self.model),
        }
    }
}

/// A window's forced alignment, awaited alongside the next recognition.
type AligningSegment<'a> = std::pin::Pin<
    Box<dyn std::future::Future<Output = anyhow::Result<Vec<alignment::SyncFragment>>> + Send + 'a>,
>;

/// Runs the alignment CLI for one job, sharing its temp directory and tools.
struct Aligner<'a> {
    state: &'a AppState,
    job_id: &'a str,
    cli_path: &'a FsPath,
    cli_args: &'a [String],
    ffmpeg_path: Option<&'a FsPath>,
    temp_dir: &'a FsPath,
    recognition: &'a RecognitionSettings,
}

impl Aligner<'_> {
    async fn align_scope(
        &self,
        scope: &SyncAlignmentScope,
        track: &SyncTrackInput,
        transcript: &alignment::Transcript,
        scope_number: usize,
        progress: &ScopeProgress,
    ) -> anyhow::Result<Vec<alignment::SyncFragment>> {
        let (scope_start, scope_end) = match scope.audio_range {
            Some((start, end)) => (start, Some(end)),
            None => (0.0, track.duration_seconds),
        };
        let windowed = match (self.ffmpeg_path, scope_end) {
            (Some(ffmpeg), Some(scope_end))
                if scope_end - scope_start > MAX_SINGLE_PASS_SECONDS =>
            {
                Some((ffmpeg, scope_end))
            }
            _ => None,
        };
        match windowed {
            Some((ffmpeg, scope_end)) => {
                self.align_windowed(
                    scope,
                    track,
                    transcript,
                    scope_number,
                    ffmpeg,
                    scope_start,
                    scope_end,
                    progress,
                )
                .await
            }
            None => {
                if progress.total <= 1 {
                    update_job_progress(self.state, self.job_id, progress.indeterminate()).await;
                }
                self.align_single_pass(scope, track, transcript, scope_number)
                    .await
            }
        }
    }

    /// The established path: one aligner run over the scope's whole audio.
    async fn align_single_pass(
        &self,
        scope: &SyncAlignmentScope,
        track: &SyncTrackInput,
        transcript: &alignment::Transcript,
        scope_number: usize,
    ) -> anyhow::Result<Vec<alignment::SyncFragment>> {
        let sliced = match scope.audio_range {
            Some((start, end)) => {
                let ffmpeg = self.ffmpeg_path.expect("chapter scopes require ffmpeg");
                Some(
                    self.slice(ffmpeg, &track.path, start, end, scope_number, 0, "scope")
                        .await?,
                )
            }
            None => None,
        };
        let audio_path = sliced.as_deref().unwrap_or(&track.path);
        let fragments = self
            .align(
                audio_path,
                transcript,
                scope.time_offset_seconds,
                scope_number,
                0,
                &scope.label,
            )
            .await;
        if let Some(path) = sliced {
            let _ = fs::remove_file(path).await;
        }
        fragments
    }

    /// Walks the scope in windows. Each window is transcribed to find where
    /// its speech sits in the transcript; the stretch up to the last confident
    /// sentence end is then force-aligned with exactly its own text, and the
    /// next window starts there. The recognizer's word timings are used only
    /// at those anchors.
    #[allow(clippy::too_many_arguments)]
    async fn align_windowed(
        &self,
        scope: &SyncAlignmentScope,
        track: &SyncTrackInput,
        transcript: &alignment::Transcript,
        scope_number: usize,
        ffmpeg: &FsPath,
        scope_start: f64,
        scope_end: f64,
        progress: &ScopeProgress,
    ) -> anyhow::Result<Vec<alignment::SyncFragment>> {
        // Book time of position zero in this file.
        let book_offset = scope.time_offset_seconds - scope_start;
        let text_len = transcript.len_utf16();
        let pace = text_len as f64 / (scope_end - scope_start);
        let done =
            |end: f64| (end - scope_start) / (scope_end - scope_start).max(f64::MIN_POSITIVE);
        let mut position = scope_start;
        let mut cursor = transcript.cursor();
        let mut fragments = Vec::new();
        let mut windows = 0usize;
        let mut unanchored = 0usize;
        // The next window starts at this one's anchor, which recognition alone
        // decides, so each window is force-aligned while the next is being
        // recognized. At most one alignment is in flight, which bounds the
        // aligner's memory to a single window.
        let mut aligning: Option<(AligningSegment<'_>, f64)> = None;

        while position < scope_end - 0.5 && cursor.position() < text_len {
            windows += 1;
            let remaining = scope_end - position;
            let recognize = async {
                if remaining <= MAX_SINGLE_PASS_SECONDS {
                    return anyhow::Ok((scope_end, text_len, 0.0, None));
                }
                let mut window = WINDOW_SECONDS;
                let (anchor, window_end, audio) = loop {
                    let window_end = (position + window).min(scope_end);
                    let audio = self
                        .slice(
                            ffmpeg,
                            &track.path,
                            position,
                            window_end,
                            scope_number,
                            windows,
                            "window",
                        )
                        .await?;
                    let recognized = self.transcribe(&audio, scope_number, windows).await;
                    if recognized.is_err() {
                        let _ = fs::remove_file(&audio).await;
                    }
                    let recognized = recognized?;
                    let lookahead =
                        ((window_end - position) * pace * WINDOW_TEXT_LOOKAHEAD).ceil() as u64;
                    let anchor = cursor.find_anchor(
                        &recognized,
                        lookahead,
                        window_end - position - WINDOW_MARGIN_SECONDS,
                    );
                    if anchor.end.is_some() || window >= WINDOW_SECONDS * 2.0 {
                        break (anchor, window_end, audio);
                    }
                    let _ = fs::remove_file(audio).await;
                    // Nothing usable: look twice as far once before giving up.
                    window *= 2.0;
                };
                let (segment_end, text_end) = match anchor.end {
                    Some(end) => (position + end.seconds, end.text_end_utf16),
                    None => {
                        // Fall back to the scope's average pace for one window.
                        unanchored += 1;
                        let target = cursor.position() + (WINDOW_SECONDS * pace).ceil() as u64;
                        (
                            (position + WINDOW_SECONDS).min(window_end),
                            cursor.sentence_end_before(target.min(text_len)),
                        )
                    }
                };
                Ok((segment_end, text_end, anchor.lead_in_seconds, Some(audio)))
            };
            let (segment_end, text_end, lead_in, mut recognized_audio) = match aligning.take() {
                Some((segment, aligned_to)) => {
                    // Let both finish so each removes its own files, even
                    // when the other fails.
                    let (segment_fragments, recognized) = tokio::join!(segment, recognize);
                    if let (Err(_), Ok((.., Some(audio)))) = (&segment_fragments, &recognized) {
                        let _ = fs::remove_file(audio).await;
                    }
                    fragments.extend(segment_fragments?);
                    let recognized = recognized?;
                    update_job_progress(self.state, self.job_id, progress.at(done(aligned_to)))
                        .await;
                    recognized
                }
                None => recognize.await?,
            };
            let text_end = text_end.clamp(cursor.position(), text_len);
            if text_end <= cursor.position() {
                if let Some(audio) = recognized_audio {
                    let _ = fs::remove_file(audio).await;
                }
                anyhow::bail!(
                    "Windowed alignment of `{}` stalled at {:.0} s.",
                    scope.label,
                    position
                );
            }
            let segment_start = position + lead_in;
            if segment_end - segment_start > 0.5 {
                // Recognition already decoded this window to mono 16 kHz PCM.
                // Trim that small local file instead of seeking, decoding, and
                // resampling the original audiobook a second time.
                let (source, source_offset) = match recognized_audio.as_deref() {
                    Some(audio) => (audio, position),
                    None => (track.path.as_path(), 0.0),
                };
                let audio = self
                    .slice(
                        ffmpeg,
                        source,
                        segment_start - source_offset,
                        segment_end - source_offset,
                        scope_number,
                        windows,
                        "segment",
                    )
                    .await;
                // The retained recognition window is no longer needed once
                // its segment has been extracted, even if extraction or
                // alignment fails.
                if let Some(audio) = recognized_audio.take() {
                    let _ = fs::remove_file(audio).await;
                }
                let segment = Box::pin(self.align_segment(
                    audio?,
                    cursor.window(text_end),
                    book_offset + segment_start,
                    scope_number,
                    windows,
                    &scope.label,
                ));
                aligning = Some((segment, segment_end));
            }
            if let Some(audio) = recognized_audio {
                let _ = fs::remove_file(audio).await;
            }
            if aligning.is_none() {
                update_job_progress(self.state, self.job_id, progress.at(done(segment_end))).await;
            }
            position = segment_end;
            cursor.advance_to(text_end);
        }
        if let Some((segment, aligned_to)) = aligning {
            fragments.extend(segment.await?);
            update_job_progress(self.state, self.job_id, progress.at(done(aligned_to))).await;
        }

        let note = if unanchored > 0 {
            format!(" ({unanchored} without a recognized anchor)")
        } else {
            String::new()
        };
        update_job_output(
            self.state,
            self.job_id,
            &format!("  Aligned in {windows} windows{note}.\n"),
        )
        .await;
        Ok(fragments)
    }

    /// Force-aligns one extracted segment, then removes its audio.
    async fn align_segment(
        &self,
        audio: PathBuf,
        transcript: alignment::Transcript,
        time_offset_seconds: f64,
        scope_number: usize,
        window: usize,
        label: &str,
    ) -> anyhow::Result<Vec<alignment::SyncFragment>> {
        let fragments = self
            .align(
                &audio,
                &transcript,
                time_offset_seconds,
                scope_number,
                window,
                label,
            )
            .await;
        let _ = fs::remove_file(audio).await;
        fragments
    }

    #[allow(clippy::too_many_arguments)]
    async fn slice(
        &self,
        ffmpeg: &FsPath,
        source: &FsPath,
        start_seconds: f64,
        end_seconds: f64,
        scope_number: usize,
        window: usize,
        kind: &str,
    ) -> anyhow::Result<PathBuf> {
        let path = self
            .temp_dir
            .join(format!("audio-{scope_number}-{window}-{kind}.wav"));
        let extracted =
            extract_alignment_audio(ffmpeg, source, &path, start_seconds, end_seconds).await;
        if extracted.is_err() {
            // FFmpeg can leave a partial file behind when it fails.
            let _ = fs::remove_file(&path).await;
        }
        extracted.map(|()| path)
    }

    async fn transcribe(
        &self,
        audio_path: &FsPath,
        scope_number: usize,
        window: usize,
    ) -> anyhow::Result<Vec<alignment::RecognizedWord>> {
        let output_path = self
            .temp_dir
            .join(format!("recognition-{scope_number}-{window}.json"));
        let mut args: Vec<std::ffi::OsString> = vec![
            "transcribe".into(),
            audio_path.into(),
            output_path.as_os_str().into(),
            "--engine=whisper".into(),
            format!("--whisper.model={}", self.recognition.model).into(),
        ];
        if let Some(language) = &self.recognition.language {
            args.push(format!("--language={language}").into());
        }
        let result = run_alignment_cli(
            self.cli_path,
            self.cli_args,
            self.ffmpeg_path,
            &args,
            "Speech recognition",
        )
        .await;
        let timeline_json = match result {
            Ok(()) => fs::read_to_string(&output_path)
                .await
                .map_err(anyhow::Error::from),
            Err(error) => Err(error),
        };
        let _ = fs::remove_file(&output_path).await;
        let entries = alignment::parse_timeline(&timeline_json?)?;
        Ok(alignment::recognized_words(&entries))
    }

    async fn align(
        &self,
        audio_path: &FsPath,
        transcript: &alignment::Transcript,
        time_offset_seconds: f64,
        scope_number: usize,
        window: usize,
        label: &str,
    ) -> anyhow::Result<Vec<alignment::SyncFragment>> {
        let transcript_path = self
            .temp_dir
            .join(format!("transcript-{scope_number}-{window}.txt"));
        fs::write(&transcript_path, &transcript.text).await?;
        let output_path = self
            .temp_dir
            .join(format!("alignment-{scope_number}-{window}.json"));
        let args: Vec<std::ffi::OsString> = vec![
            "align".into(),
            audio_path.into(),
            transcript_path.as_os_str().into(),
            output_path.as_os_str().into(),
        ];
        let result = run_alignment_cli(
            self.cli_path,
            self.cli_args,
            self.ffmpeg_path,
            &args,
            &format!("Alignment of `{label}`"),
        )
        .await;
        let timeline_json = match result {
            Ok(()) => fs::read_to_string(&output_path)
                .await
                .map_err(anyhow::Error::from),
            Err(error) => Err(error),
        };
        let _ = fs::remove_file(&output_path).await;
        let _ = fs::remove_file(&transcript_path).await;
        let entries = alignment::parse_timeline(&timeline_json?)?;
        Ok(alignment::fragments_from_timeline(
            &entries,
            transcript,
            time_offset_seconds,
        ))
    }
}

async fn run_alignment_cli(
    cli_path: &FsPath,
    cli_args: &[String],
    ffmpeg_path: Option<&FsPath>,
    args: &[std::ffi::OsString],
    what: &str,
) -> anyhow::Result<()> {
    let mut command = Command::new(cli_path);
    command.kill_on_drop(true);
    command.args(cli_args).args(args).arg("--overwrite");
    if let Some(ffmpeg_dir) = ffmpeg_path.and_then(FsPath::parent) {
        let mut paths = vec![ffmpeg_dir.to_path_buf()];
        if let Some(existing) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing));
        }
        command.env("PATH", std::env::join_paths(paths)?);
    }
    let output = tokio::time::timeout(ALIGNMENT_COMMAND_TIMEOUT, command.output())
        .await
        .map_err(|_| anyhow::anyhow!("{what} exceeded the two-hour command timeout."))?
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
        anyhow::bail!("{what} failed with status {}:\n{}", output.status, tail);
    }
    Ok(())
}

async fn extract_alignment_audio(
    ffmpeg_path: &FsPath,
    source_path: &FsPath,
    output_path: &FsPath,
    start_seconds: f64,
    end_seconds: f64,
) -> anyhow::Result<()> {
    extract_alignment_audio_with_timeout(
        ffmpeg_path,
        source_path,
        output_path,
        start_seconds,
        end_seconds,
        Duration::from_secs(10 * 60),
    )
    .await
}

async fn extract_alignment_audio_with_timeout(
    ffmpeg_path: &FsPath,
    source_path: &FsPath,
    output_path: &FsPath,
    start_seconds: f64,
    end_seconds: f64,
    timeout: Duration,
) -> anyhow::Result<()> {
    let mut command = Command::new(ffmpeg_path);
    command
        .kill_on_drop(true)
        .arg("-nostdin")
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-y")
        .arg("-ss")
        .arg(format!("{start_seconds:.3}"))
        .arg("-i")
        .arg(source_path)
        .arg("-t")
        .arg(format!("{:.3}", end_seconds - start_seconds))
        .arg("-map")
        .arg("0:a:0")
        .arg("-vn")
        .arg("-ac")
        .arg("1")
        .arg("-ar")
        .arg("16000")
        .arg("-c:a")
        .arg("pcm_s16le")
        .arg(output_path);
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| {
            anyhow::anyhow!(
                "FFmpeg audio extraction timed out after {:.1} seconds.",
                timeout.as_secs_f64()
            )
        })?
        .map_err(|error| anyhow::anyhow!("Failed to run ffmpeg for chapter audio: {error}"))?;
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
            "ffmpeg failed to extract chapter audio with status {}:\n{}",
            output.status,
            tail
        );
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn hung_audio_extraction_times_out() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("ffmpeg");
        std::fs::write(&executable, "#!/bin/sh\nexec sleep 60\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            extract_alignment_audio_with_timeout(
                &executable,
                &root.path().join("input"),
                &root.path().join("output"),
                0.0,
                10.0,
                Duration::from_millis(50),
            ),
        )
        .await
        .unwrap();
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("audio extraction timed out")
        );
    }

    /// Exercise the real extraction helper and codec seek/resampling behavior,
    /// in addition to the window-walking fixtures below.
    #[tokio::test]
    async fn reused_audio_preserves_samples_and_timing_with_real_ffmpeg() {
        let Some(tools) = faststart::discover_tools(None, None) else {
            eprintln!("skipping: ffmpeg/ffprobe are not installed");
            return;
        };
        async fn pcm(ffmpeg: &FsPath, path: &FsPath) -> Vec<i16> {
            let output = Command::new(ffmpeg)
                .args(["-nostdin", "-v", "error", "-i"])
                .arg(path)
                .args(["-f", "s16le", "-c:a", "pcm_s16le", "-"])
                .output()
                .await
                .unwrap();
            assert!(output.status.success());
            output
                .stdout
                .as_chunks::<2>()
                .0
                .iter()
                .map(|&sample| i16::from_le_bytes(sample))
                .collect()
        }
        let root = tempfile::tempdir().unwrap();
        for (extension, codec) in [("m4b", "aac"), ("mp3", "libmp3lame"), ("flac", "flac")] {
            let source = root.path().join(format!("book.{extension}"));
            let created = Command::new(&tools.ffmpeg)
                .args([
                    "-nostdin",
                    "-v",
                    "error",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "aevalsrc=0.3*sin(2*PI*(300*t+20*t*t)):s=44100:d=10",
                    "-ac",
                    "2",
                    "-c:a",
                    codec,
                ])
                .arg(&source)
                .output()
                .await
                .unwrap();
            assert!(
                created.status.success(),
                "{}",
                String::from_utf8_lossy(&created.stderr)
            );
            let window = root.path().join("window.wav");
            let direct = root.path().join("direct.wav");
            let reused = root.path().join("reused.wav");
            // Zero lead-in, a fractional seek, and a segment ending at the
            // window boundary (as with an enlarged recognition window).
            for (start, lead_in, duration) in
                [(0.0, 0.0, 3.0), (1.137, 1.137, 5.263), (1.333, 5.0, 3.0)]
            {
                extract_alignment_audio(&tools.ffmpeg, &source, &window, start, start + 8.0)
                    .await
                    .unwrap();
                extract_alignment_audio(
                    &tools.ffmpeg,
                    &source,
                    &direct,
                    start + lead_in,
                    start + lead_in + duration,
                )
                .await
                .unwrap();
                extract_alignment_audio(
                    &tools.ffmpeg,
                    &window,
                    &reused,
                    lead_in,
                    lead_in + duration,
                )
                .await
                .unwrap();
                let decoded = pcm(&tools.ffmpeg, &window).await;
                let actual = pcm(&tools.ffmpeg, &reused).await;
                let original = pcm(&tools.ffmpeg, &direct).await;
                let first_sample = (lead_in * 16000.0).round() as usize;
                // FFmpeg can return slightly less than requested after an AAC
                // seek, so a segment ending at the window boundary is only as
                // long as the decoded window.
                let sample_count =
                    ((duration * 16000.0).round() as usize).min(decoded.len() - first_sample);
                assert_eq!(
                    actual,
                    decoded[first_sample..first_sample + sample_count],
                    "{extension}: trimming must preserve the decoded PCM samples"
                );
                // Measure both extractions against the generated chirp, which
                // has no repeating period to alias a shift. MP3 and FLAC seek
                // exactly. FFmpeg 9 input seeking in AAC can start up to one
                // encoder frame (1,024 samples at 44.1 kHz) late whether the
                // segment is decoded directly or trimmed from the window, so
                // reuse must stay within that same bound.
                let offset = start + lead_in;
                let lag = |samples: &[i16]| -> i32 {
                    let mse = |lag: i32| -> f64 {
                        (800..samples.len().min(30_000))
                            .step_by(16)
                            .map(|index| {
                                let t = (index as i32 + lag) as f64 / 16000.0 + offset;
                                let expected = 0.3
                                    * (2.0 * std::f64::consts::PI * (300.0 * t + 20.0 * t * t))
                                        .sin()
                                    * 32767.0;
                                let difference = samples[index] as f64 - expected;
                                difference * difference
                            })
                            .sum()
                    };
                    (-400..=400)
                        .min_by(|&a, &b| mse(a).total_cmp(&mse(b)))
                        .unwrap()
                };
                let bound = if codec == "aac" {
                    (1024.0 * 16000.0 / 44100.0_f64).ceil() as i32 + 16
                } else {
                    16
                };
                for (kind, samples) in [("direct", &original), ("reused", &actual)] {
                    let shift = lag(samples);
                    assert!(
                        shift.abs() <= bound,
                        "{extension}: {kind} audio shifted {shift} samples"
                    );
                }
            }
        }
    }

    fn chapter(title: &str, start_seconds: f64, end_seconds: Option<f64>) -> SyncChapterInput {
        SyncChapterInput {
            title: title.to_string(),
            start_seconds,
            end_seconds,
        }
    }

    #[test]
    fn chapter_alignment_uses_embedded_audio_ranges() {
        let track = SyncTrackInput {
            path: PathBuf::from("book.m4b"),
            title: "Book".into(),
            duration_seconds: Some(95.0),
            chapters: vec![
                chapter("Opening Credits", 0.0, Some(5.0)),
                chapter("Chapter 1", 5.0, Some(45.0)),
                chapter("Chapter 2", 45.0, None),
            ],
        };
        let toc = vec![
            alignment::TocEntry {
                title: "Chapter 1".into(),
                spine_index: 1,
            },
            alignment::TocEntry {
                title: "Chapter 2".into(),
                spine_index: 2,
            },
        ];

        let scopes = chapter_alignment_scopes(&track, &toc, 3, true).unwrap();

        assert_eq!(scopes.len(), 2);
        assert_eq!(scopes[0].section_range, 1..2);
        assert_eq!(scopes[0].audio_range, Some((5.0, 45.0)));
        assert_eq!(scopes[0].time_offset_seconds, 5.0);
        assert_eq!(scopes[1].section_range, 2..3);
        assert_eq!(scopes[1].audio_range, Some((45.0, 95.0)));
        assert_eq!(scopes[1].time_offset_seconds, 45.0);
    }

    #[test]
    fn chapter_alignment_requires_ffmpeg() {
        let track = SyncTrackInput {
            path: PathBuf::from("book.m4b"),
            title: "Book".into(),
            duration_seconds: Some(60.0),
            chapters: vec![
                chapter("Chapter 1", 0.0, Some(30.0)),
                chapter("Chapter 2", 30.0, Some(60.0)),
            ],
        };
        let toc = vec![
            alignment::TocEntry {
                title: "Chapter 1".into(),
                spine_index: 0,
            },
            alignment::TocEntry {
                title: "Chapter 2".into(),
                spine_index: 1,
            },
        ];

        assert!(chapter_alignment_scopes(&track, &toc, 2, false).is_err());
    }

    #[test]
    fn chapter_alignment_rejects_invalid_audio_ranges() {
        let track = SyncTrackInput {
            path: PathBuf::from("book.m4b"),
            title: "Book".into(),
            duration_seconds: Some(60.0),
            chapters: vec![
                chapter("Chapter 1", 0.0, Some(30.0)),
                chapter("Chapter 2", 30.0, Some(30.0)),
            ],
        };
        let toc = vec![
            alignment::TocEntry {
                title: "Chapter 1".into(),
                spine_index: 0,
            },
            alignment::TocEntry {
                title: "Chapter 2".into(),
                spine_index: 1,
            },
        ];

        assert!(chapter_alignment_scopes(&track, &toc, 2, true).is_err());
    }

    #[test]
    fn progress_weights_are_equal_when_any_track_duration_is_unknown() {
        let tracks = vec![
            SyncTrackInput {
                path: PathBuf::from("one.mp3"),
                title: "One".into(),
                duration_seconds: Some(3_600.0),
                chapters: Vec::new(),
            },
            SyncTrackInput {
                path: PathBuf::from("two.mp3"),
                title: "Two".into(),
                duration_seconds: None,
                chapters: Vec::new(),
            },
        ];
        let scopes = (0..2)
            .map(|track_index| SyncAlignmentScope {
                track_index,
                section_range: track_index..track_index + 1,
                audio_range: None,
                time_offset_seconds: 0.0,
                label: tracks[track_index].title.clone(),
            })
            .collect::<Vec<_>>();

        assert_eq!(scope_progress_weights(&scopes, &tracks), vec![1.0, 1.0]);
    }

    #[test]
    #[ignore = "manual real-book probe"]
    fn manual_real_book_scope_probe() {
        let audio_path = PathBuf::from(std::env::var_os("OPERALIBRE_PROBE_AUDIO").unwrap());
        let epub_path = PathBuf::from(std::env::var_os("OPERALIBRE_PROBE_EPUB").unwrap());
        let metadata = read_track_metadata(&audio_path);
        let epub = alignment::parse_epub_file(&epub_path).unwrap();
        let track = SyncTrackInput {
            path: audio_path,
            title: metadata.title.unwrap_or_else(|| "Book".to_string()),
            duration_seconds: metadata.duration_seconds,
            chapters: metadata
                .chapters
                .into_iter()
                .map(|chapter| SyncChapterInput {
                    title: chapter.title,
                    start_seconds: chapter.start_seconds,
                    end_seconds: chapter.end_seconds,
                })
                .collect(),
        };

        let result = chapter_alignment_scopes(&track, &epub.toc, epub.sections.len(), true);
        println!(
            "audio_chapters={} epub_toc={} epub_sections={} result={}",
            track.chapters.len(),
            epub.toc.len(),
            epub.sections.len(),
            match &result {
                Ok(scopes) => format!("{} scopes", scopes.len()),
                Err(error) => error.clone(),
            }
        );
        if let Ok(scopes) = result {
            for scope in scopes.iter().take(5) {
                println!(
                    "{} {:?} {:?}",
                    scope.label, scope.audio_range, scope.section_range
                );
            }
            if let Some(output_path) = std::env::var_os("OPERALIBRE_PROBE_TRANSCRIPT") {
                let selected = std::env::var("OPERALIBRE_PROBE_SCOPE")
                    .ok()
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(2);
                let scope = &scopes[selected];
                let transcript =
                    alignment::build_transcript(&epub.sections[scope.section_range.clone()]);
                std::fs::write(output_path, transcript.text).unwrap();
                println!(
                    "selected_scope={selected} label={} audio={:?} sections={:?}",
                    scope.label, scope.audio_range, scope.section_range
                );
            }
        }
    }

    /// Drives the windowed aligner with shell-script stand-ins for ffmpeg
    /// and echogarden. The fake ffmpeg records the requested time range in
    /// the "audio" file; the fake recognizer replies with the scripted
    /// narration words inside that range; the fake aligner spaces the
    /// transcript's sentences evenly across it. Sentences are narrated at a
    /// constant pace, so even spacing is exact only when the window walk
    /// hands the aligner precisely the text that was spoken.
    #[cfg(unix)]
    mod windowed {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        const HEADING_SECONDS: f64 = 12.0;
        const SENTENCE_SECONDS: f64 = 4.0;

        fn sentence(index: usize) -> String {
            format!("Sentence {index} word two three four five six.")
        }

        fn narrated_start(index: usize) -> f64 {
            HEADING_SECONDS + index as f64 * SENTENCE_SECONDS
        }

        /// One `time word` line per spoken word: an unscripted heading, then
        /// every sentence's eight words half a second apart. Sentences in
        /// `garbled` are spoken as noise the recognizer cannot place.
        fn narration(count: usize, garbled: std::ops::Range<usize>, start: f64) -> String {
            let mut lines = Vec::new();
            for (index, word) in "this is a narrated heading for the chapter"
                .split_whitespace()
                .enumerate()
            {
                lines.push(format!("{:.3} {word}", start + index as f64 * 0.5));
            }
            for index in 0..count {
                for (position, word) in sentence(index).split_whitespace().enumerate() {
                    let word = if garbled.contains(&index) {
                        "blah"
                    } else {
                        word.trim_end_matches('.')
                    };
                    lines.push(format!(
                        "{:.3} {word}",
                        start + narrated_start(index) + position as f64 * 0.5
                    ));
                }
            }
            lines.join("\n") + "\n"
        }

        fn write_script(path: &FsPath, body: &str) {
            std::fs::write(path, body).unwrap();
            let mut permissions = std::fs::metadata(path).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(path, permissions).unwrap();
        }

        const FAKE_FFMPEG: &str = r#"#!/bin/sh
start=0; duration=0; source=""; previous=""
for argument in "$@"; do
  case "$previous" in -ss) start="$argument";; -t) duration="$argument";; -i) source="$argument";; esac
  previous="$argument"
done
case "$source" in
  *-window.wav)
    read source_start source_duration < "$source"
    start=$(awk -v s="$start" -v base="$source_start" 'BEGIN { print s + base }') ;;
  *)
    # A recognized window must be reused for its corresponding segment.
    window="${previous%-segment.wav}-window.wav"
    if [ "$window" != "$previous" ] && [ -f "$window" ]; then
      echo "segment decoded the original audio again" >&2
      exit 1
    fi ;;
esac
printf '%s %s\n' "$start" "$duration" > "$previous"
"#;

        const FAKE_ECHOGARDEN: &str = r#"#!/bin/sh
command="$1"; audio="$2"
read start duration < "$audio"
case "$command" in
  transcribe)
    awk -v s="$start" -v d="$duration" 'BEGIN { printf "["; n = 0 }
      { t = $1 + 0
        if (t >= s && t < s + d) {
          if (n > 0) printf ","
          printf "{\"type\":\"word\",\"text\":\"%s\",\"startTime\":%.3f,\"endTime\":%.3f}", $2, t - s, t - s + 0.4
          n++ } }
      END { printf "]" }' "NARRATION_PATH" > "$3" ;;
  align)
    awk -v d="$duration" 'BEGIN { RS = "\001" }
      { gsub(/\n/, " "); n = split($0, parts, /\. */); m = 0
        for (i = 1; i <= n; i++) if (parts[i] ~ /[A-Za-z0-9]/) m++
        printf "["; k = 0
        for (i = 1; i <= n; i++) {
          if (parts[i] !~ /[A-Za-z0-9]/) continue
          gsub(/^ +| +$/, "", parts[i])
          if (k > 0) printf ","
          printf "{\"type\":\"sentence\",\"text\":\"%s.\",\"startTime\":%.3f,\"endTime\":%.3f}", parts[i], k * d / m, (k + 1) * d / m
          k++ }
        printf "]" }' "$3" > "$4" ;;
esac
"#;

        #[derive(Default)]
        struct FakeOptions {
            no_ffmpeg: bool,
            unknown_duration: bool,
            fail_command: Option<&'static str>,
            fail_segment: bool,
            record_overlap: bool,
        }

        async fn align_fake_book(
            count: usize,
            garbled: std::ops::Range<usize>,
            scope_start: f64,
            book_offset: f64,
        ) -> (Vec<alignment::SyncFragment>, String) {
            let (result, output) = run_fake_book(
                count,
                garbled,
                scope_start,
                book_offset,
                FakeOptions::default(),
            )
            .await;
            (result.unwrap(), output)
        }

        async fn run_fake_book(
            count: usize,
            garbled: std::ops::Range<usize>,
            scope_start: f64,
            book_offset: f64,
            options: FakeOptions,
        ) -> (anyhow::Result<Vec<alignment::SyncFragment>>, String) {
            let root = tempfile::tempdir().unwrap();
            let (state, _) = crate::unit_tests::fake_libation_state(root.path());
            let job_id = create_job(&state, "sync-generate").await;

            let narration_path = root.path().join("narration.txt");
            std::fs::write(&narration_path, narration(count, garbled, scope_start)).unwrap();
            let ffmpeg = root.path().join("ffmpeg");
            let mut ffmpeg_script = FAKE_FFMPEG.to_string();
            if options.fail_segment {
                // Fail after writing output, as a partial extraction would.
                ffmpeg_script.push_str(
                    "case \"$previous\" in *-segment.wav) echo 'fixture failure' >&2; exit 7;; esac\n",
                );
            }
            write_script(&ffmpeg, &ffmpeg_script);
            let cli = root.path().join("echogarden");
            let mut script =
                FAKE_ECHOGARDEN.replace("NARRATION_PATH", &narration_path.display().to_string());
            if let Some(command) = options.fail_command {
                // Leave a partial timeline, as a process can do before exiting.
                script = script.replace("case \"$command\" in", &format!(
                    "if [ \"$command\" = {command} ]; then\n  if [ {command} = align ]; then echo partial > \"$4\"; else echo partial > \"$3\"; fi\n  echo 'fixture failure' >&2\n  exit 7\nfi\ncase \"$command\" in"));
            }
            let overlap_log = root.path().join("overlap.log");
            if options.record_overlap {
                // Alignment holds a marker while it runs; recognition that
                // starts meanwhile records the overlap.
                script = script.replace(
                    "case \"$command\" in",
                    &format!(
                        "marker=\"$(dirname \"$2\")/aligning\"\n\
                         if [ \"$command\" = align ]; then touch \"$marker\"; sleep 0.3; fi\n\
                         if [ \"$command\" = transcribe ]; then sleep 0.1; \
                         if [ -f \"$marker\" ]; then echo overlap >> \"{}\"; fi; fi\n\
                         case \"$command\" in",
                        overlap_log.display()
                    ),
                );
                script.push_str("if [ \"$command\" = align ]; then rm -f \"$marker\"; fi\n");
            }
            write_script(&cli, &script);

            let half = count / 2;
            let sections = vec![
                alignment::SpineSection {
                    href: "a.html".into(),
                    text: (0..half).map(sentence).collect::<Vec<_>>().join(" "),
                },
                alignment::SpineSection {
                    href: "b.html".into(),
                    text: (half..count).map(sentence).collect::<Vec<_>>().join(" "),
                },
            ];
            let transcript = alignment::build_transcript(&sections);
            let duration = scope_start + narrated_start(count) + 0.5;
            let track = SyncTrackInput {
                path: root.path().join("book.m4b"),
                title: "Book".into(),
                // A short tail: the fake aligner spreads silence evenly over
                // the last segment's sentences, which a real one does not.
                duration_seconds: (!options.unknown_duration).then_some(duration),
                chapters: Vec::new(),
            };
            std::fs::write(&track.path, format!("0 {duration}\n")).unwrap();
            let scope = SyncAlignmentScope {
                track_index: 0,
                section_range: 0..2,
                audio_range: (scope_start > 0.0).then_some((scope_start, duration)),
                time_offset_seconds: scope_start + book_offset,
                label: "Book".into(),
            };
            let recognition = RecognitionSettings::for_language(Some("en"));
            let temp_dir = tempfile::tempdir().unwrap();
            let aligner = Aligner {
                state: &state,
                job_id: &job_id,
                cli_path: &cli,
                cli_args: &[],
                ffmpeg_path: (!options.no_ffmpeg).then_some(ffmpeg.as_path()),
                temp_dir: temp_dir.path(),
                recognition: &recognition,
            };

            let progress = ScopeProgress {
                base: 0.1,
                span: 0.8,
                step: "Aligning the narration to the text".into(),
                completed: 0,
                total: 1,
            };
            let fragments = aligner
                .align_scope(&scope, &track, &transcript, 0, &progress)
                .await;
            assert_eq!(
                std::fs::read_dir(temp_dir.path()).unwrap().count(),
                0,
                "window audio and timelines should be removed as processing advances"
            );
            let job = state.jobs.read().await.get(&job_id).unwrap().clone();
            // Every window reports where it got to, so the bar reaches the end
            // of this scope's share rather than sitting still until the job is
            // over.
            if fragments.is_ok() {
                let reported = job.progress.and_then(|progress| progress.fraction);
                if !options.no_ffmpeg
                    && !options.unknown_duration
                    && duration - scope_start > MAX_SINGLE_PASS_SECONDS
                {
                    let reported = reported.expect("windowed alignment reports progress");
                    assert!(
                        reported > 0.85 && reported <= 0.9 + 1e-6,
                        "progress ended at {reported}, not near the end of the scope's span"
                    );
                } else {
                    assert!(reported.is_none(), "single-pass progress is indeterminate");
                }
            }
            if options.record_overlap {
                assert!(
                    std::fs::read_to_string(&overlap_log).is_ok_and(|log| !log.is_empty()),
                    "the next window should be recognized while the previous one aligns"
                );
            }
            assert_eq!(
                std::fs::read_to_string(&track.path).unwrap(),
                format!("0 {duration}\n"),
                "the source audio must be preserved"
            );
            (fragments, job.output)
        }

        fn assert_monotonic(fragments: &[alignment::SyncFragment]) {
            for pair in fragments.windows(2) {
                assert!(
                    pair[1].start_seconds >= pair[0].end_seconds - 1e-6,
                    "fragments overlap or run backwards: {pair:?}"
                );
            }
        }

        #[tokio::test]
        async fn windows_are_anchored_by_recognition_and_skip_the_narrated_heading() {
            let count = 200;
            let (fragments, output) = align_fake_book(count, 0..0, 0.0, 0.0).await;

            assert_eq!(fragments.len(), count);
            assert_monotonic(&fragments);
            for (index, fragment) in fragments.iter().enumerate() {
                assert_eq!(fragment.text, sentence(index));
                assert_eq!(
                    fragment.href,
                    if index < count / 2 {
                        "a.html"
                    } else {
                        "b.html"
                    }
                );
                let expected = narrated_start(index);
                assert!(
                    (fragment.start_seconds - expected).abs() < 0.75,
                    "sentence {index} starts at {:.2}, narrated at {expected:.2}",
                    fragment.start_seconds
                );
            }
            // Nothing was aligned onto the unscripted heading.
            assert!(fragments[0].start_seconds >= HEADING_SECONDS - 0.5);
            assert!(output.contains(" windows.\n"), "{output}");
            assert!(!output.contains("without a recognized anchor"), "{output}");
            let windows: usize = output
                .split("Aligned in ")
                .nth(1)
                .and_then(|rest| rest.split(' ').next())
                .and_then(|value| value.parse().ok())
                .unwrap();
            assert!(windows >= 3, "{output}");
        }

        #[tokio::test]
        async fn reused_windows_preserve_chapter_and_book_offsets() {
            let count = 200;
            let (fragments, _) = align_fake_book(count, 0..0, 123.125, 900.0).await;
            assert_eq!(fragments.len(), count);
            assert_monotonic(&fragments);
            for (index, fragment) in fragments.iter().enumerate() {
                let expected = 900.0 + 123.125 + narrated_start(index);
                assert!(
                    (fragment.start_seconds - expected).abs() < 0.75,
                    "sentence {index}: {} != {expected}",
                    fragment.start_seconds
                );
            }
        }

        #[tokio::test]
        async fn single_pass_still_handles_short_scopes_and_missing_tools_or_duration() {
            for (count, scope_start, options) in [
                (20, 0.0, FakeOptions::default()),
                (20, 123.125, FakeOptions::default()),
                (
                    200,
                    0.0,
                    FakeOptions {
                        no_ffmpeg: true,
                        ..Default::default()
                    },
                ),
                (
                    200,
                    0.0,
                    FakeOptions {
                        unknown_duration: true,
                        ..Default::default()
                    },
                ),
            ] {
                let (result, output) =
                    run_fake_book(count, 0..0, scope_start, 900.0, options).await;
                let fragments = result.unwrap();
                assert_eq!(fragments.len(), count);
                assert_monotonic(&fragments);
                assert_eq!(fragments[0].start_seconds, 900.0 + scope_start);
                assert!(!output.contains(" windows"));
            }
        }

        #[tokio::test]
        async fn recognition_of_the_next_window_overlaps_alignment() {
            let options = FakeOptions {
                record_overlap: true,
                ..Default::default()
            };
            let (result, output) = run_fake_book(200, 0..0, 0.0, 0.0, options).await;
            let fragments = result.unwrap();
            assert_eq!(fragments.len(), 200);
            assert_monotonic(&fragments);
            for (index, fragment) in fragments.iter().enumerate() {
                let expected = narrated_start(index);
                assert!(
                    (fragment.start_seconds - expected).abs() < 0.75,
                    "sentence {index}: {} != {expected}",
                    fragment.start_seconds
                );
            }
            assert!(output.contains(" windows"), "{output}");
        }

        #[tokio::test]
        async fn failed_recognition_or_alignment_removes_temporary_audio_and_text() {
            let failures = [
                FakeOptions {
                    fail_command: Some("transcribe"),
                    ..Default::default()
                },
                FakeOptions {
                    fail_command: Some("align"),
                    ..Default::default()
                },
                FakeOptions {
                    fail_segment: true,
                    ..Default::default()
                },
            ];
            for options in failures {
                let (result, _) = run_fake_book(200, 0..0, 0.0, 0.0, options).await;
                assert!(result.unwrap_err().to_string().contains("fixture failure"));
            }
        }

        #[tokio::test]
        async fn a_stretch_without_anchors_falls_back_and_resynchronizes_afterwards() {
            let count = 400;
            let (fragments, output) = align_fake_book(count, 60..190, 0.0, 0.0).await;

            assert_eq!(fragments.len(), count);
            assert_monotonic(&fragments);
            assert!(output.contains("without a recognized anchor"), "{output}");
            // Before the garbled stretch, and well after it once the
            // recognizer anchors again, timing is exact.
            for (index, fragment) in fragments
                .iter()
                .enumerate()
                .filter(|(index, _)| *index < 60 || *index >= 260)
            {
                let expected = narrated_start(index);
                assert!(
                    (fragment.start_seconds - expected).abs() < 0.75,
                    "sentence {index} starts at {:.2}, narrated at {expected:.2}",
                    fragment.start_seconds
                );
            }
        }
    }
}
