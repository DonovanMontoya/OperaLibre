//! Sync maps: serving and generating the text-to-audio alignment a readalong
//! client follows.

use crate::updates::SyncAddonRuntime;
use crate::*;

/// Queue rank is separate from creation time so moving a book never changes
/// its elapsed time or history. Old snapshots fall back to creation order.
fn sync_queue_order(job: &JobStatus) -> u64 {
    job.queue_position
        .unwrap_or_else(|| job_started_timestamp(job))
}

struct SyncQueueWake(Arc<tokio::sync::Notify>);
impl Drop for SyncQueueWake {
    fn drop(&mut self) {
        self.0.notify_waiters();
    }
}

pub(crate) async fn claim_sync_slot<'a>(
    state: &'a AppState,
    id: &str,
) -> Option<tokio::sync::SemaphorePermit<'a>> {
    loop {
        let changed = state.update_manager.sync_queue_changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        {
            let jobs = state.jobs.read().await;
            if jobs.get(id).is_none_or(|job| job.status != "queued") {
                return None;
            }
            let first = jobs
                .values()
                .filter(|job| job.kind == SYNC_GENERATE_JOB_KIND && job.status == "queued")
                .min_by_key(|job| (sync_queue_order(job), &job.id));
            if first.is_none_or(|job| job.id != id) {
                drop(jobs);
                changed.await;
                continue;
            }
        }
        let slot = state.update_manager.sync_slots.acquire().await.ok()?;
        let mut jobs = state.jobs.write().await;
        let first = jobs
            .values()
            .filter(|job| job.kind == SYNC_GENERATE_JOB_KIND && job.status == "queued")
            .min_by_key(|job| (sync_queue_order(job), &job.id));
        if first.is_some_and(|job| job.id == id) {
            let job = jobs.get_mut(id)?;
            job.status = "running".into();
            job.running_at = Some(unix_now_millis().to_string());
            return Some(slot);
        }
        drop(jobs);
        drop(slot);
    }
}

pub(crate) async fn remove_sync_job(
    State(state): State<AppState>,
    _: AdminUser,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let _schedule_guard = state.sync_schedule_lock.lock().await;
    let mut jobs = state.jobs.write().await;
    let job = jobs
        .get(&id)
        .filter(|job| job.kind == SYNC_GENERATE_JOB_KIND)
        .ok_or_else(|| ApiError::not_found("Sync job not found"))?;
    if !matches!(job.status.as_str(), "queued" | "paused") && !finished_sync_result(job) {
        return Err(ApiError::conflict(
            "Only queued, paused, or finished syncs can be removed.",
        ));
    }
    crate::sync_schedule::save_finished_results(&state, &jobs).await?;
    let previous = jobs.remove(&id).unwrap();
    if let Err(error) = save_queue(&state, &jobs).await {
        jobs.insert(id, previous);
        return Err(error);
    }
    state.update_manager.sync_queue_changed.notify_waiters();
    // A running worker cannot be using this job's checkpoint.
    let _ = fs::remove_file(sync_checkpoint_path(&state, &previous.id)).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub(crate) struct SyncJobControl {
    action: String,
}

pub(crate) async fn control_sync_job(
    State(state): State<AppState>,
    _: AdminUser,
    Path(id): Path<String>,
    Json(control): Json<SyncJobControl>,
) -> Result<Json<JobStatus>, ApiError> {
    let mut jobs = state.jobs.write().await;
    let previous = jobs.clone();
    let job = jobs
        .get(&id)
        .filter(|job| job.kind == SYNC_GENERATE_JOB_KIND)
        .ok_or_else(|| ApiError::not_found("Sync job not found"))?;
    match control.action.as_str() {
        "up" | "down" if job.status == "queued" => {
            let mut ordered: Vec<_> = jobs
                .values()
                .filter(|job| job.kind == SYNC_GENERATE_JOB_KIND && job.status == "queued")
                .map(|job| (sync_queue_order(job), job.id.clone()))
                .collect();
            ordered.sort();
            let index = ordered.iter().position(|(_, key)| key == &id).unwrap();
            let other = if control.action == "up" {
                index.checked_sub(1)
            } else {
                (index + 1 < ordered.len()).then_some(index + 1)
            };
            if let Some(other) = other {
                ordered.swap(index, other);
            }
            for (rank, (_, key)) in ordered.iter().enumerate() {
                jobs.get_mut(key).unwrap().queue_position = Some(rank as u64);
            }
        }
        "pause" if matches!(job.status.as_str(), "queued" | "running") => {
            let job = jobs.get_mut(&id).unwrap();
            job.pause_requested = true;
            if job.status == "queued" {
                job.status = "paused".into();
                job.resume_pending = false;
            }
        }
        "resume" if job.status == "paused" => {
            let rank = jobs
                .values()
                .map(sync_queue_order)
                .max()
                .unwrap_or(0)
                .saturating_add(1);
            let job = jobs.get_mut(&id).unwrap();
            job.pause_requested = false;
            job.status = "queued".into();
            job.queue_position = Some(rank);
            job.resume_pending = true;
            job.progress = Some(JobProgress::new("Waiting to resume from saved progress"));
        }
        "up" | "down" | "pause" | "resume" => {
            return Err(ApiError::conflict(
                "The sync has changed state. Refresh and try again.",
            ));
        }
        _ => return Err(ApiError::bad_request("Unknown sync queue action.")),
    }
    if let Err(error) = save_queue(&state, &jobs).await {
        *jobs = previous;
        return Err(error);
    }
    let updated = jobs[&id].clone();
    drop(jobs);
    state.update_manager.sync_queue_changed.notify_waiters();
    if control.action == "resume" {
        resume_queue(&state).await;
    }
    Ok(Json(updated))
}

#[derive(Debug, Serialize, Deserialize)]
struct SyncCheckpoint {
    fingerprint: String,
    completed_scopes: usize,
    fragments: Vec<alignment::SyncFragment>,
    recovery_gaps: Vec<alignment::RecoveryGap>,
    /// Indexed by scope; a scope with no text keeps the default.
    #[serde(default)]
    outcomes: Vec<sync_report::ScopeOutcome>,
}

fn sync_checkpoint_path(state: &AppState, id: &str) -> PathBuf {
    state
        .database_path
        .with_file_name("sync-checkpoints")
        .join(format!("{id}.json"))
}

/// Reject cached timing when the input files, alignment settings or chapter
/// scopes change. File metadata avoids rereading gigabytes of audio on a NAS.
async fn checkpoint_fingerprint(
    epub: &FsPath,
    tracks: &[SyncTrackInput],
    scopes: &[SyncAlignmentScope],
    runtime: &SyncAddonRuntime,
    recognition: &RecognitionSettings,
) -> anyhow::Result<String> {
    let mut hash = Sha256::new();
    // Server alignment code and its settings can change without recommending
    // regeneration of finished maps. Be conservative when mixing saved sections.
    hash.update(include_str!("sync.rs"));
    hash.update(include_str!("alignment.rs"));
    hash.update(format!(
        "{}:{:?}:{:?}:{:?}",
        alignment::MAPPING_REVISION,
        runtime.cli_path,
        runtime.cli_args,
        scopes
    ));
    hash.update(format!("{:?}", runtime.ffmpeg_path));
    hash.update(recognition.describe());
    for path in std::iter::once(epub)
        .chain(tracks.iter().map(|track| track.path.as_path()))
        .chain(std::iter::once(runtime.cli_path.as_path()))
        .chain(
            runtime
                .cli_args
                .iter()
                .map(FsPath::new)
                .filter(|path| path.is_file()),
        )
        .chain(runtime.ffmpeg_path.as_deref())
    {
        let metadata = fs::metadata(path).await?;
        hash.update(format!(
            "{path:?}:{}:{:?}",
            metadata.len(),
            metadata.modified()?
        ));
    }
    Ok(hex_digest(hash.finalize()))
}

#[derive(Debug)]
struct SyncPaused;
impl std::fmt::Display for SyncPaused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Sync paused")
    }
}
impl std::error::Error for SyncPaused {}

async fn wait_for_manual_pause(state: &AppState, id: &str) {
    loop {
        let changed = state.update_manager.sync_queue_changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        if state
            .jobs
            .read()
            .await
            .get(id)
            .is_some_and(|job| job.pause_requested)
        {
            return;
        }
        changed.await;
    }
}

async fn pause_at_checkpoint(state: &AppState, id: &str) -> anyhow::Result<()> {
    let mut jobs = state.jobs.write().await;
    if jobs.get(id).is_some_and(|job| job.pause_requested) {
        let previous = jobs[id].clone();
        let job = jobs.get_mut(id).unwrap();
        job.status = "paused".into();
        job.resume_pending = false;
        if let Some(progress) = &mut job.progress {
            progress.step = "Paused; completed sections saved".into();
        }
        if let Err(error) = save_queue(state, &jobs).await {
            jobs.insert(id.to_string(), previous);
            return Err(anyhow::anyhow!(error.message));
        }
        return Err(SyncPaused.into());
    }
    Ok(())
}

/// Owns update exclusion while workers stop and their queue is saved. A failed
/// or cancelled update releases the stop signal so recovery can restart work.
pub(crate) struct SyncUpdatePause {
    signal: tokio::sync::watch::Sender<u64>,
    state: AppState,
    // A late rollback must not release a newer update’s stop signal.
    token: u64,
    _lifecycle: Option<tokio::sync::OwnedRwLockWriteGuard<()>>,
    keep: bool,
}

impl SyncUpdatePause {
    pub(crate) fn keep(mut self) {
        self.keep = true;
    }
}

impl Drop for SyncUpdatePause {
    fn drop(&mut self) {
        if self.keep {
            return;
        }
        let state = self.state.clone();
        let signal = self.signal.clone();
        let held = self._lifecycle.take();
        let token = self.token;
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            signal.send_if_modified(|current| {
                if *current != token {
                    return false;
                }
                *current = 0;
                true
            });
            return;
        };
        handle.spawn(async move {
            // Cancellation can happen while waiting for workers to stop. Keep
            // the signal set until they have all released update exclusion.
            let lifecycle = match held {
                Some(guard) => guard,
                None => {
                    state
                        .update_manager
                        .sync_lifecycle
                        .clone()
                        .write_owned()
                        .await
                }
            };
            if let Err(error) = save_update_queue(&state).await {
                tracing::error!(?error, "could not save sync queue after failed update");
            }
            drop(lifecycle);
            signal.send_if_modified(|current| {
                if *current != token {
                    return false;
                }
                *current = 0;
                true
            });
            resume_queue(&state).await;
        });
    }
}

async fn wait_for_update(signal: &mut tokio::sync::watch::Receiver<u64>) {
    let _ = signal.wait_for(|token| *token != 0).await;
}

pub(crate) async fn pause_for_update(state: &AppState) -> anyhow::Result<SyncUpdatePause> {
    let mut pause = SyncUpdatePause {
        signal: state.update_manager.sync_update_pause.clone(),
        state: state.clone(),
        token: rand::random::<u64>().max(1),
        _lifecycle: None,
        keep: false,
    };
    pause.signal.send_replace(pause.token);
    // Both running and queued workers listen to the signal and release their
    // lifecycle guards. Holding the write guard prevents new workers racing in.
    pause._lifecycle = Some(
        state
            .update_manager
            .sync_lifecycle
            .clone()
            .write_owned()
            .await,
    );
    save_update_queue(state).await?;
    Ok(pause)
}

async fn save_update_queue(state: &AppState) -> anyhow::Result<()> {
    let mut jobs = state.jobs.write().await;
    for job in jobs
        .values_mut()
        .filter(|job| job.kind == SYNC_GENERATE_JOB_KIND && is_active_job(job))
    {
        if job.pause_requested {
            job.status = "paused".into();
            job.resume_pending = false;
        } else {
            job.status = "queued".into();
            job.resume_pending = true;
        }
        job.running_at = None;
        if let Some(progress) = &mut job.progress {
            progress.step = if job.status == "paused" {
                "Paused; saved sections available"
            } else {
                "Saved for server update; resumes after restart"
            }
            .into();
        }
    }
    save_queue(state, &jobs)
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;
    Ok(())
}

pub(crate) const SYNC_GENERATE_JOB_KIND: &str = "sync-generate";

fn finished_sync_result(job: &JobStatus) -> bool {
    job.kind == SYNC_GENERATE_JOB_KIND
        && matches!(job.status.as_str(), "completed" | "failed" | "cancelled")
}

/// A book keeps its latest result until it finishes another sync. Active
/// jobs and other kinds of work never replace or lose their entries here.
pub(crate) fn prune_sync_results(jobs: &mut HashMap<String, JobStatus>) {
    let mut latest: HashMap<String, (u64, String)> = HashMap::new();
    for job in jobs.values().filter(|job| finished_sync_result(job)) {
        if let Some(book_id) = &job.target_id {
            let order = (job_started_timestamp(job), job.id.clone());
            let entry = latest
                .entry(book_id.clone())
                .or_insert_with(|| order.clone());
            if order > *entry {
                *entry = order;
            }
        }
    }
    jobs.retain(|id, job| {
        !finished_sync_result(job)
            || job
                .target_id
                .as_ref()
                .is_none_or(|book_id| latest[book_id].1 == *id)
    });
}

/// Queue snapshots are serialized while holding the job table's write lock,
/// so a completion cannot be overwritten by an older enqueue snapshot.
pub(crate) async fn save_queue(
    state: &AppState,
    jobs: &HashMap<String, JobStatus>,
) -> Result<(), ApiError> {
    let entries: Vec<_> = jobs
        .values()
        .filter(|job| job.kind == SYNC_GENERATE_JOB_KIND)
        .collect();
    write_json_atomic(
        &state.database_path.with_file_name("sync-jobs.json"),
        &entries,
    )
    .await
}

pub(crate) async fn restore_queue(state: &AppState) -> Result<(), ApiError> {
    let _schedule_guard = state.sync_schedule_lock.lock().await;
    let bytes = match fs::read(state.database_path.with_file_name("sync-jobs.json")).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let entries: Vec<JobStatus> = serde_json::from_slice(&bytes)?;
    let mut jobs = state.jobs.write().await;
    for mut job in entries {
        if job.kind != SYNC_GENERATE_JOB_KIND {
            continue;
        }
        if is_active_job(&job) {
            job.status = if job.pause_requested {
                "paused"
            } else {
                "queued"
            }
            .into();
            job.running_at = None;
            job.resume_pending = job.status == "queued";
            job.progress = Some(JobProgress::new(if job.status == "paused" {
                "Paused; saved sections available after restart"
            } else {
                "Recovered after restart; waiting to resume"
            }));
        }
        jobs.insert(job.id.clone(), job);
    }
    if let Err(error) = crate::sync_schedule::save_finished_results(state, &jobs).await {
        tracing::error!(
            ?error,
            "could not persist recovered scheduled sync outcomes"
        );
    } else {
        prune_sync_results(&mut jobs);
        prune_finished_jobs(&mut jobs);
    }
    Ok(())
}

pub(crate) async fn resume_queue(state: &AppState) {
    if *state.update_manager.sync_update_pause.borrow() != 0
        || !state.library.read().await.catalogue_ready
    {
        return;
    }
    let mut pending: Vec<_> = state
        .jobs
        .read()
        .await
        .values()
        .filter(|job| job.resume_pending)
        .cloned()
        .collect();
    // The schedule calls this every tick; read the runtime from disk only when
    // there is something to resume.
    if pending.is_empty()
        || state
            .update_manager
            .sync_addon_runtime(state.alignment_config.cli_path.as_deref())
            .await
            .is_none()
    {
        return;
    }
    pending.sort_by_key(sync_queue_order);
    for job in pending {
        let Some(book_id) = job.target_id else {
            continue;
        };
        let chapters = (!job.chapters.is_empty())
            .then(|| job.chapters.iter().map(|chapter| chapter.index).collect());
        if let Err(error) = enqueue_sync_map_inner(
            state.clone(),
            book_id,
            chapters,
            Some(job.id.clone()),
            false,
        )
        .await
        {
            if error.status == StatusCode::CONFLICT || error.status.is_server_error() {
                tracing::warn!(?error, "sync recovery will retry");
                continue;
            }
            update_job_finished(state, &job.id, "failed", None, Some(error.message)).await;
        }
    }
}

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

#[derive(Deserialize)]
pub(crate) struct GenerateSyncRequest {
    /// Report indices of the chapters to re-run; absent for the whole book.
    chapters: Option<Vec<usize>>,
}

pub(crate) async fn generate_sync_map(
    State(state): State<AppState>,
    _: AdminUser,
    Path(book_id): Path<String>,
    body: Option<Json<GenerateSyncRequest>>,
) -> Result<Json<JobCreated>, ApiError> {
    let chapters = body.and_then(|Json(body)| body.chapters);
    if chapters.as_ref().is_some_and(Vec::is_empty) {
        return Err(ApiError::bad_request(
            "Choose at least one chapter to re-run.",
        ));
    }
    enqueue_sync_map_inner(state, book_id, chapters, None, false).await
}

pub(crate) async fn enqueue_sync_map(
    state: AppState,
    book_id: String,
) -> Result<Json<JobCreated>, ApiError> {
    enqueue_sync_map_inner(state, book_id, None, None, false).await
}

/// Chapter re-runs splice into a current map OperaLibre generated; any other
/// map is replaced by re-syncing the whole book.
async fn rerun_map_path(state: &AppState, book_id: &str) -> Result<PathBuf, ApiError> {
    let library = state.library.read().await;
    match &library.book(book_id)?.sync_file {
        Some(file) if file.source == "generated" && !file.outdated => {}
        Some(file) if file.source == "generated" => {
            return Err(ApiError::conflict(
                "This book’s map is outdated. Re-sync the whole book.",
            ));
        }
        _ => {
            return Err(ApiError::conflict(
                "Only maps OperaLibre generated can re-run single chapters. Re-sync the whole book.",
            ));
        }
    }
    library
        .sync_paths
        .get(book_id)
        .cloned()
        .ok_or_else(|| ApiError::conflict(sync_report::BOOK_CHANGED))
}

/// Refuses a re-run the book can no longer take before it joins the queue,
/// and names its chapters for the job.
async fn rerun_request_chapters(
    state: &AppState,
    book_id: &str,
    epub_path: &FsPath,
    tracks: &[SyncTrackInput],
    chapter_slicing: bool,
    chapters: &[usize],
) -> Result<Vec<JobChapter>, ApiError> {
    let map_path = rerun_map_path(state, book_id).await?;
    let (sync_dir, book_id, epub_path, tracks, chapters) = (
        state.sync_dir.clone(),
        book_id.to_string(),
        epub_path.to_path_buf(),
        tracks.to_vec(),
        chapters.to_vec(),
    );
    tokio::task::spawn_blocking(move || {
        let epub = alignment::parse_epub_file(&epub_path).map_err(|_| sync_report::BOOK_CHANGED)?;
        let plan =
            plan_scopes(&epub, &tracks, chapter_slicing).map_err(|_| sync_report::BOOK_CHANGED)?;
        let spans = sync_report::chapter_spans(&epub, &tracks, &plan.scopes);
        sync_report::rerun_base(&sync_dir, &book_id, &map_path, &spans, &chapters)
            .map(|base| base.chapters)
    })
    .await
    .map_err(|error| ApiError::internal(error.to_string()))?
    .map_err(ApiError::conflict)
}

/// Accept a sweep as one durable queue update. Start the workers only after
/// the snapshot is published; a restart between publication and dispatch will
/// recover every accepted book from that snapshot.
pub(crate) async fn enqueue_sync_batch(
    state: AppState,
    book_ids: Vec<String>,
) -> Result<(usize, usize), ApiError> {
    if book_ids.is_empty() {
        return Ok((0, 0));
    }
    if *state.update_manager.sync_update_pause.borrow() != 0 {
        return Err(ApiError::conflict(
            "Sync generation is paused for a server update.",
        ));
    }
    let lifecycle = state
        .update_manager
        .sync_lifecycle
        .clone()
        .try_read_owned()
        .map_err(|_| {
            ApiError::conflict("The sync add-on is being changed. Try again when it finishes.")
        })?;
    if state
        .update_manager
        .sync_addon_runtime(state.alignment_config.cli_path.as_deref())
        .await
        .is_none()
    {
        return Err(ApiError::bad_request(
            "Follow-along sync generation is not enabled.",
        ));
    }
    let mut jobs = state.jobs.write().await;
    let requested = book_ids.len();
    let mut created = Vec::with_capacity(book_ids.len());
    let mut active_books: HashSet<String> = jobs
        .values()
        .filter(|job| job.kind == SYNC_GENERATE_JOB_KIND && is_unfinished_job(job))
        .filter_map(|job| job.target_id.clone())
        .collect();
    let mut timestamp = next_job_timestamp(&jobs);
    for book_id in book_ids {
        if !active_books.insert(book_id.clone()) {
            continue;
        }
        let job_id = loop {
            let id = random_hex_id();
            if !jobs.contains_key(&id) {
                break id;
            }
        };
        jobs.insert(
            job_id.clone(),
            JobStatus {
                resume_pending: true,
                queue_position: None,
                pause_requested: false,
                id: job_id.clone(),
                kind: SYNC_GENERATE_JOB_KIND.into(),
                target_id: Some(book_id.clone()),
                status: "queued".into(),
                started_at: timestamp.to_string(),
                running_at: None,
                finished_at: None,
                exit_code: None,
                output: String::new(),
                error: None,
                progress: Some(JobProgress::new("Waiting for the sync queue")),
                chapters: Vec::new(),
                failed_chapters: Vec::new(),
                cause: None,
                heard_language: None,
            },
        );
        timestamp = timestamp.saturating_add(1);
        created.push((book_id, job_id));
    }
    prune_finished_jobs(&mut jobs);
    if let Err(error) = save_queue(&state, &jobs).await {
        for (_, id) in &created {
            jobs.remove(id);
        }
        return Err(error);
    }
    for (_, id) in &created {
        if let Some(job) = jobs.get_mut(id) {
            job.resume_pending = false;
        }
    }
    drop(jobs);

    let count = created.len();
    tokio::spawn(async move {
        let _lifecycle = lifecycle;
        for (book_id, job_id) in created {
            if let Err(error) =
                enqueue_sync_map_inner(state.clone(), book_id, None, Some(job_id.clone()), true)
                    .await
            {
                if error.status == StatusCode::CONFLICT {
                    // An update can pause dispatch after the batch was accepted.
                    // Keep these jobs recoverable until the handoff saves the queue.
                    if let Some(job) = state.jobs.write().await.get_mut(&job_id) {
                        job.resume_pending = job.status == "queued";
                    }
                    continue;
                }
                update_job_finished(&state, &job_id, "failed", None, Some(error.message)).await;
            }
        }
    });
    Ok((count, requested - count))
}

/// Queues a sync of the whole book, or with `chapters`, a re-run of just those.
/// A recovered job passes its saved chapters with its `resume_id`; it is
/// checked again when it runs rather than refused here, where a refusal would
/// only be retried.
async fn enqueue_sync_map_inner(
    state: AppState,
    book_id: String,
    mut chapters: Option<Vec<usize>>,
    resume_id: Option<String>,
    already_persisted: bool,
) -> Result<Json<JobCreated>, ApiError> {
    if *state.update_manager.sync_update_pause.borrow() != 0 {
        return Err(ApiError::conflict(
            "Sync generation is paused for a server update.",
        ));
    }
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
        let (epub_path, tracks) = sync_inputs(&library, &book_id)?;
        (epub_path, tracks, library.book(&book_id)?.title.clone())
    };
    if tracks.is_empty() {
        return Err(ApiError::bad_request("This book has no audio tracks."));
    }

    let resuming = resume_id.is_some();
    if let Some(chapters) = &mut chapters {
        chapters.sort_unstable();
        chapters.dedup();
    }
    let rerun_chapters = match &chapters {
        Some(chapters) if !resuming => {
            rerun_request_chapters(
                &state,
                &book_id,
                &epub_path,
                &tracks,
                runtime.ffmpeg_path.is_some(),
                chapters,
            )
            .await?
        }
        _ => Vec::new(),
    };
    let (job_id, created) = if let Some(id) = resume_id {
        (id, true)
    } else {
        create_queued_job(&state, SYNC_GENERATE_JOB_KIND, Some(book_id.clone())).await
    };
    {
        let mut jobs = state.jobs.write().await;
        // A queued whole-book sync covers any chapters; a queued re-run
        // covers only its own, and must finish before anything wider.
        let covered = |job: &JobStatus| {
            job.chapters.is_empty()
                || chapters.as_ref().is_some_and(|wanted| {
                    wanted
                        .iter()
                        .all(|index| job.chapters.iter().any(|chapter| chapter.index == *index))
                })
        };
        if !created && jobs.get(&job_id).is_some_and(|job| !covered(job)) {
            return Err(ApiError::conflict(
                "This book already has chapters waiting to re-run. Let them finish, or remove them from the queue, first.",
            ));
        }
        let position = jobs
            .values()
            .map(sync_queue_order)
            .max()
            .unwrap_or(0)
            .saturating_add(1);
        if created && let Some(job) = jobs.get_mut(&job_id) {
            if !resuming {
                job.queue_position = Some(position);
                job.chapters = rerun_chapters;
            }
            job.resume_pending = job.status == "queued";
            job.progress = Some(JobProgress::new("Waiting for the sync queue"));
        }
        if !already_persisted && let Err(error) = save_queue(&state, &jobs).await {
            if created && !resuming {
                jobs.remove(&job_id);
            }
            return Err(error);
        }
        if !created {
            return Ok(Json(JobCreated { job_id }));
        }
        if let Some(job) = jobs.get_mut(&job_id) {
            job.resume_pending = false;
        }
    }
    let mut update_pause = state.update_manager.sync_update_pause.subscribe();
    let state_for_job = state.clone();
    let job_id_for_task = job_id.clone();
    tokio::spawn(async move {
        let guard = JobGuard::new(&state_for_job, &job_id_for_task);
        let _lifecycle = lifecycle;
        let slot = tokio::select! {
            biased;
            _ = wait_for_update(&mut update_pause) => { guard.disarm(); return; }
            slot = claim_sync_slot(&state_for_job, &job_id_for_task) => slot,
        };
        let Some(slot) = slot else {
            guard.disarm();
            return;
        };
        let _wake = SyncQueueWake(state_for_job.update_manager.sync_queue_changed.clone());
        let _slot = slot;
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

        let run = async {
            // The book may have changed since a re-run was queued.
            if chapters.is_some() {
                rerun_map_path(&state_for_job, &book_id)
                    .await
                    .map_err(|error| anyhow::anyhow!(error.message))?;
            }
            run_sync_generation(
                &state_for_job,
                &job_id_for_task,
                &book_id,
                &runtime,
                &epub_path,
                &tracks,
                chapters.as_deref(),
            )
            .await
        };
        let result = tokio::select! {
            biased;
            _ = wait_for_update(&mut update_pause) => { guard.disarm(); return; }
            result = run => result,
        };

        match result {
            Ok(generated) => {
                let mut summary = format!(
                    "Wrote sync map with {} sentences and word timings.\n",
                    generated.fragment_count
                );
                if !generated.failed.is_empty() {
                    summary.push_str(&format!(
                        "Could not align {}; see the chapter grades.\n",
                        chapter_labels(&generated.failed)
                    ));
                }
                update_job_output(&state_for_job, &job_id_for_task, &summary).await;
                if let Some(job) = state_for_job.jobs.write().await.get_mut(&job_id_for_task) {
                    job.failed_chapters = generated.failed;
                }
                update_job_progress(
                    &state_for_job,
                    &job_id_for_task,
                    JobProgress::new("Refreshing the library").fraction(0.98),
                )
                .await;
                let rescanned = tokio::select! {
                    biased;
                    _ = wait_for_update(&mut update_pause) => {
                        // The complete map is already published; startup's scan
                        // will discover it without repeating alignment.
                        update_job_finished(&state_for_job, &job_id_for_task, "completed", Some(0), None).await;
                        guard.disarm();
                        return;
                    }
                    result = rescan_library(&state_for_job) => result,
                };
                if let Err(error) = rescanned {
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
            Err(error) if error.downcast_ref::<SyncPaused>().is_some() => {
                guard.disarm();
                return;
            }
            Err(error) => {
                let _ =
                    fs::remove_file(sync_checkpoint_path(&state_for_job, &job_id_for_task)).await;
                if let Some(failure) = error.downcast_ref::<sync_report::DiagnosedFailure>()
                    && let Some(job) = state_for_job.jobs.write().await.get_mut(&job_id_for_task)
                {
                    job.cause = Some(failure.cause);
                    job.heard_language = failure.heard_language.clone();
                }
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
        guard.finish().await;
    });

    state.update_manager.sync_queue_changed.notify_waiters();
    Ok(Json(JobCreated { job_id }))
}

/// The EPUB and audio tracks a sync of one book reads.
pub(crate) fn sync_inputs(
    library: &LibraryState,
    book_id: &str,
) -> Result<(PathBuf, Vec<SyncTrackInput>), ApiError> {
    let book = library.book(book_id)?;
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
    Ok((epub_path, tracks))
}

#[derive(Clone)]
pub(crate) struct SyncTrackInput {
    pub(crate) path: PathBuf,
    pub(crate) title: String,
    pub(crate) duration_seconds: Option<f64>,
    pub(crate) chapters: Vec<SyncChapterInput>,
}

#[derive(Clone)]
pub(crate) struct SyncChapterInput {
    pub(crate) title: String,
    pub(crate) start_seconds: f64,
    pub(crate) end_seconds: Option<f64>,
}

#[derive(Clone, Debug)]
pub(crate) struct SyncAlignmentScope {
    pub(crate) track_index: usize,
    pub(crate) section_range: std::ops::Range<usize>,
    pub(crate) audio_range: Option<(f64, f64)>,
    pub(crate) time_offset_seconds: f64,
    pub(crate) label: String,
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

/// How long a scope's audio runs: it weights the progress bar, so a
/// half-hour chapter moves it further than a two-minute one, and bounds the
/// chapter a report grades.
pub(crate) fn scope_audio_seconds(
    scope: &SyncAlignmentScope,
    tracks: &[SyncTrackInput],
) -> Option<f64> {
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

/// What a finished run wrote: the map's sentence count and the chapters it
/// could not align.
#[derive(Debug)]
pub(crate) struct SyncGenerated {
    pub(crate) fragment_count: usize,
    pub(crate) failed: Vec<JobChapter>,
}

/// When this many chapters fail before any aligns, the runtime itself is
/// probably broken; the job stops rather than fail every chapter in turn.
const FAIL_FAST_CHAPTERS: usize = 3;

/// The map readers follow now, or for a book the library has not listed, the
/// one its sync would replace.
async fn served_map_path(state: &AppState, book_id: &str) -> PathBuf {
    state
        .library
        .read()
        .await
        .sync_paths
        .get(book_id)
        .cloned()
        .unwrap_or_else(|| generated_map_path(state, book_id))
}

fn generated_map_path(state: &AppState, book_id: &str) -> PathBuf {
    state
        .sync_dir
        .join(format!("{book_id}{SYNC_SIDECAR_SUFFIX}"))
}

/// A whole map, with the identity its report is matched by.
async fn read_sync_map(
    path: &FsPath,
) -> anyhow::Result<(alignment::SyncMap, sync_report::MapIdentity)> {
    let bytes = fs::read(path).await?;
    let map: alignment::SyncMap = serde_json::from_slice(&bytes)?;
    let identity = sync_report::MapIdentity::from_bytes(map.generated_at.clone(), &bytes);
    Ok((map, identity))
}

/// Aligns the whole book, or with `chapters`, only those scopes, spliced into
/// the served map. A chapter that fails is recorded and the run goes on: a
/// whole-book run keeps that chapter's sentences from the previous map, and a
/// re-run leaves them as they were. Only when nothing aligns does the job
/// fail, leaving the served map untouched.
pub(crate) async fn run_sync_generation(
    state: &AppState,
    job_id: &str,
    book_id: &str,
    runtime: &SyncAddonRuntime,
    epub_path: &FsPath,
    tracks: &[SyncTrackInput],
    chapters: Option<&[usize]>,
) -> anyhow::Result<SyncGenerated> {
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

    let plan = plan_scopes(&epub, tracks, runtime.ffmpeg_path.is_some())?;
    if let Some(note) = &plan.note {
        update_job_output(state, job_id, &format!("{note}\n")).await;
    }
    let scopes = plan.scopes;
    let spans = sync_report::chapter_spans(&epub, tracks, &scopes);
    let labels = spans
        .iter()
        .map(|span| span.label.clone())
        .collect::<Vec<_>>();
    let map_path = served_map_path(state, book_id).await;
    let rerun = match chapters {
        Some(chapters) => {
            let (sync_dir, book, path, spans, chapters) = (
                state.sync_dir.clone(),
                book_id.to_string(),
                map_path.clone(),
                spans.clone(),
                chapters.to_vec(),
            );
            let base = tokio::task::spawn_blocking(move || {
                sync_report::rerun_base(&sync_dir, &book, &path, &spans, &chapters)
            })
            .await?
            .map_err(|message| anyhow::anyhow!(message))?;
            update_job_output(
                state,
                job_id,
                &format!(
                    "Re-running {}; the rest of the map stays as it is.\n",
                    chapter_labels(&base.chapters)
                ),
            )
            .await;
            Some(base)
        }
        None => None,
    };
    let mut selected = chapters.map_or_else(|| (0..scopes.len()).collect(), <[usize]>::to_vec);
    selected.sort_unstable();
    selected.dedup();

    let recognition = book_recognition(state, book_id, &epub).await;
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
    let aligner = Aligner::new(state, job_id, runtime, temp_dir.path(), &recognition);
    let scope_unit = if tracks.len() > 1 {
        "track"
    } else if scopes.len() > 1 {
        "chapter"
    } else {
        "section"
    };
    let scope_weights = scope_progress_weights(&scopes, tracks);
    let total_weight = selected
        .iter()
        .map(|&index| scope_weights[index])
        .sum::<f64>()
        .max(f64::MIN_POSITIVE);
    let mut done_weight = 0.0f64;
    let checkpoint_path = sync_checkpoint_path(state, job_id);
    let fingerprint =
        checkpoint_fingerprint(epub_path, tracks, &scopes, runtime, &recognition).await?;
    let mut run = SyncCheckpoint {
        fingerprint,
        completed_scopes: 0,
        fragments: Vec::new(),
        recovery_gaps: if tracks.len() == 1 && rerun.is_none() {
            unscoped_audio_gaps(&tracks[0], &scopes)
        } else {
            Vec::new()
        },
        outcomes: Vec::new(),
    };
    match fs::read(&checkpoint_path).await {
        Ok(bytes) => {
            let checkpoint: SyncCheckpoint = serde_json::from_slice(&bytes)?;
            if checkpoint.fingerprint == run.fingerprint
                && checkpoint.completed_scopes <= selected.len()
            {
                run = checkpoint;
                done_weight = selected[..run.completed_scopes]
                    .iter()
                    .map(|&index| scope_weights[index])
                    .sum();
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let mut attempted = selected[..run.completed_scopes]
        .iter()
        .filter(|&&index| spans[index].text_units > 0)
        .count();
    let systemic_failures = |outcomes: &[sync_report::ScopeOutcome]| {
        outcomes
            .iter()
            .filter(|outcome| {
                outcome.error.as_deref().is_some_and(|error| {
                    sync_report::classify_error(error) != sync_report::Cause::NoisyAudio
                })
            })
            .count()
    };
    let mut gave_up = false;
    // Read only if a chapter fails: a long book's map runs to megabytes.
    let previous_map = tokio::sync::OnceCell::new();
    pause_at_checkpoint(state, job_id).await?;
    for (position, &scope_number) in selected.iter().enumerate().skip(run.completed_scopes) {
        let scope = &scopes[scope_number];
        let track = &tracks[scope.track_index];
        let progress = ScopeProgress {
            base: ALIGN_PROGRESS_START
                + (ALIGN_PROGRESS_END - ALIGN_PROGRESS_START) * (done_weight / total_weight),
            span: (ALIGN_PROGRESS_END - ALIGN_PROGRESS_START)
                * (scope_weights[scope_number] / total_weight),
            step: if rerun.is_some() {
                format!(
                    "Re-running {scope_unit} {} of {}: {}",
                    scope_number + 1,
                    scopes.len(),
                    scope.label
                )
            } else if scopes.len() > 1 {
                format!(
                    "Aligning {scope_unit} {} of {}: {}",
                    scope_number + 1,
                    scopes.len(),
                    scope.label
                )
            } else {
                "Aligning the narration to the text".to_string()
            },
            completed: position,
            total: selected.len(),
        };
        done_weight += scope_weights[scope_number];
        let transcript = scope_transcript(&epub, scope);
        if transcript.text.trim().is_empty() {
            continue;
        }
        attempted += 1;
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

        let Some(aligned) =
            align_unless_paused(&aligner, scope, track, &transcript, scope_number, &progress).await
        else {
            update_job_progress(state, job_id, progress.at(0.0)).await;
            pause_at_checkpoint(state, job_id).await?;
            return Err(SyncPaused.into());
        };
        let evidence = aligner.take_evidence(&transcript.text);
        let outcome = match aligned {
            Ok(aligned) => {
                update_job_output(
                    state,
                    job_id,
                    &format!("  Matched {} sentences.\n", aligned.fragments.len()),
                )
                .await;
                run.fragments.extend(aligned.fragments);
                run.recovery_gaps.extend(aligned.recovery_gaps);
                sync_report::ScopeOutcome {
                    skipped_text: aligned.skipped_text,
                    evidence,
                    ..Default::default()
                }
            }
            Err(error) => {
                let detail = format!("{error:#}");
                update_job_output(state, job_id, &format!("  Could not align: {detail}\n")).await;
                // A re-run leaves the chapter as the map has it. A whole-book
                // run keeps the previous map's sentences, or holds the
                // reader's place through the chapter when there are none.
                if rerun.is_none() {
                    let range = spans[scope_number].range();
                    let previous = previous_map
                        .get_or_init(|| async {
                            read_sync_map(&map_path).await.ok().map(|(map, _)| map)
                        })
                        .await;
                    let (kept, kept_gaps) = previous
                        .as_ref()
                        .map(|map| sync_report::chapter_timing(map, &range))
                        .unwrap_or_default();
                    if !kept.is_empty() {
                        run.fragments.extend(kept);
                        run.recovery_gaps.extend(kept_gaps);
                    } else if range.end.is_finite() {
                        run.recovery_gaps.push(alignment::RecoveryGap {
                            start_seconds: range.start,
                            end_seconds: range.end,
                        });
                    }
                }
                sync_report::ScopeOutcome {
                    error: Some(detail),
                    evidence,
                    ..Default::default()
                }
            }
        };
        run.outcomes.resize_with(scope_number, Default::default);
        run.outcomes.push(outcome);
        if attempted >= FAIL_FAST_CHAPTERS && systemic_failures(&run.outcomes) == attempted {
            update_job_output(
                state,
                job_id,
                &format!("The first {attempted} chapters all failed; stopping.\n"),
            )
            .await;
            gave_up = true;
            break;
        }
        run.completed_scopes = position + 1;
        save_checkpoint(&checkpoint_path, &run).await?;
        update_job_progress(state, job_id, progress.at(1.0)).await;
        pause_at_checkpoint(state, job_id).await?;
    }

    // A runtime that failed every chapter from the start is not worth
    // retrying chapter by chapter.
    if !gave_up {
        let fixes = AutomaticFixes {
            aligner: &aligner,
            epub: &epub,
            tracks,
            scopes: &scopes,
            spans: &spans,
            labels: &labels,
            checkpoint_path: &checkpoint_path,
        };
        fixes.run(&selected, &mut run).await?;
    }
    let SyncCheckpoint {
        mut fragments,
        mut recovery_gaps,
        outcomes,
        ..
    } = run;
    let language = recognition.language.as_deref();

    let failed = selected
        .iter()
        .filter_map(|&index| {
            let outcome = outcomes.get(index)?;
            let error = outcome.error.as_deref()?;
            let cause = sync_report::diagnose_chapter(&sync_report::ChapterEvidence {
                grade: Some(sync_report::Grade::Failed),
                outcome,
                language,
                labels: &labels,
            })
            .map_or_else(
                || sync_report::classify_error(error),
                |diagnosis| diagnosis.cause,
            );
            Some(JobChapter {
                index,
                label: scopes[index].label.clone(),
                cause: Some(cause),
            })
        })
        .collect::<Vec<_>>();
    // A content failure can still explain why nothing aligned.
    let all_failed = !failed.is_empty() && failed.len() == attempted;
    let failure = || {
        let detail = failed
            .last()
            .and_then(|chapter| outcomes[chapter.index].error.clone());
        anyhow::anyhow!(detail.unwrap_or_default())
    };
    if all_failed && rerun.is_none() {
        let mut graded = sync_report::grade_chapters(
            &sync_report::with_outcomes(&spans, &outcomes),
            fragments
                .iter()
                .map(|f| (f.start_seconds, f.end_seconds, f.text.as_str())),
            &recovery_gaps,
        );
        sync_report::diagnose_chapters(&mut graded, &outcomes, &labels, language);
        return Err(sync_report::DiagnosedFailure::from_chapters(
            &graded,
            failure().to_string(),
        ));
    }
    update_job_progress(
        state,
        job_id,
        JobProgress::new("Saving the sync map").fraction(ALIGN_PROGRESS_END),
    )
    .await;

    let sync_path = generated_map_path(state, book_id);
    let (sync_map, identity) = match &rerun {
        None => {
            if fragments.is_empty() {
                let mut graded = sync_report::grade_chapters(
                    &sync_report::with_outcomes(&spans, &outcomes),
                    std::iter::empty(),
                    &recovery_gaps,
                );
                sync_report::diagnose_chapters(&mut graded, &outcomes, &labels, language);
                return Err(sync_report::DiagnosedFailure::from_chapters(
                    &graded,
                    "Alignment produced no usable sentence fragments.".into(),
                ));
            }
            fragments.sort_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds));
            let sync_map = alignment::SyncMap {
                version: alignment::SYNC_MAP_VERSION,
                mapping_revision: alignment::MAPPING_REVISION,
                generator: Some("echogarden".to_string()),
                generated_at: Some(now_unix_string()),
                precision: Some(alignment::PRECISION_SENTENCE.to_string()),
                fragments,
                recovery_gaps,
            };
            fs::create_dir_all(&state.sync_dir).await?;
            let identity = write_sync_map(&sync_path, &sync_map).await?;
            (sync_map, identity)
        }
        Some(base) => {
            let (mut sync_map, mut identity) = read_sync_map(&map_path).await?;
            anyhow::ensure!(identity == base.map, sync_report::BOOK_CHANGED);
            // With every chapter failed the map is left as it is, and only
            // the report records the failures.
            if !all_failed {
                for &index in &selected {
                    if outcomes.get(index).is_some_and(|o| o.error.is_none()) {
                        sync_report::remove_chapter_timing(
                            &mut sync_map.fragments,
                            &mut sync_map.recovery_gaps,
                            &spans[index].range(),
                        );
                    }
                }
                sync_map.fragments.append(&mut fragments);
                sync_map.recovery_gaps.append(&mut recovery_gaps);
                sync_map
                    .fragments
                    .sort_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds));
                sync_map.generated_at = Some(now_unix_string());
                identity = write_sync_map(&sync_path, &sync_map).await?;
            }
            (sync_map, identity)
        }
    };
    let mut graded = sync_report::grade_chapters(
        &sync_report::with_outcomes(&spans, &outcomes),
        sync_map
            .fragments
            .iter()
            .map(|f| (f.start_seconds, f.end_seconds, f.text.as_str())),
        &sync_map.recovery_gaps,
    );
    sync_report::diagnose_chapters(&mut graded, &outcomes, &labels, language);
    let report = match rerun {
        None => sync_report::SyncReport::new(identity, sync_report::Graded::Run, graded),
        // The other chapters' timing is unchanged, and so are their grades.
        Some(base) => {
            let mut chapters = base.report.chapters;
            for (chapter, regraded) in chapters.iter_mut().zip(graded) {
                if selected.binary_search(&chapter.index).is_ok()
                    && outcomes.get(chapter.index).is_some()
                {
                    *chapter = regraded;
                }
            }
            sync_report::SyncReport::new(identity, base.report.graded, chapters)
        }
    };
    // The map is already published; without a report it is graded later.
    if let Err(error) = sync_report::publish_report(state, book_id, &report).await {
        update_job_output(
            state,
            job_id,
            &format!("Could not save the chapter grades: {}\n", error.message),
        )
        .await;
    }
    if all_failed {
        return Err(failure());
    }

    let _ = fs::remove_file(checkpoint_path).await;
    Ok(SyncGenerated {
        fragment_count: sync_map.fragments.len(),
        failed,
    })
}

/// Interrupts expensive work, but never a checkpoint write: completed
/// sections stay durable and resuming repeats only the unfinished one.
/// Dropping alignment also stops its kill-on-drop child process. `None`
/// when the job was paused.
async fn align_unless_paused(
    aligner: &Aligner<'_>,
    scope: &SyncAlignmentScope,
    track: &SyncTrackInput,
    transcript: &alignment::Transcript,
    scope_number: usize,
    progress: &ScopeProgress,
) -> Option<anyhow::Result<ScopeAlignment>> {
    tokio::select! {
        biased;
        _ = wait_for_manual_pause(aligner.state, aligner.job_id) => None,
        result = aligner.align_scope(scope, track, transcript, scope_number, progress) => Some(result),
    }
}

async fn save_checkpoint(path: &FsPath, checkpoint: &SyncCheckpoint) -> anyhow::Result<()> {
    fs::create_dir_all(path.parent().unwrap()).await?;
    write_bytes_atomic(path, &serde_json::to_vec(checkpoint)?)
        .await
        .map_err(|error| anyhow::anyhow!(error.message))
}

/// A swapped chapter's opening must find at least this share of its
/// five-word phrases, in order, in the other chapter's text: clear evidence
/// the narrator is reading that chapter.
const REPAIR_MIN_MATCH: f64 = 0.4;
/// And beat its own text by this much, so a chapter that merely repeats
/// another's wording is never moved.
const REPAIR_MARGIN: f64 = 0.25;
/// Only speech this unlike its text is checked against other chapters and
/// for its language; a chapter that is merely hard to hear matches far more.
const UNMATCHED_WORDS_IN_TEXT: f64 = 0.35;
/// A 30-second sample is plenty for the recognizer to name a language, taken
/// a minute in where a chapter allows, past its spoken title and music.
const LANGUAGE_SAMPLE_SECONDS: f64 = 30.0;
const LANGUAGE_SAMPLE_OFFSET: f64 = 60.0;
/// Below this confidence a detected language is not trusted.
const LANGUAGE_CONFIDENCE: f64 = 0.6;

/// After a run's first pass, tries the automatic fix a weak chapter's
/// diagnosis names, once per chapter and cause, keeping a result only when
/// it grades better.
struct AutomaticFixes<'a> {
    aligner: &'a Aligner<'a>,
    epub: &'a alignment::EpubDocument,
    tracks: &'a [SyncTrackInput],
    scopes: &'a [SyncAlignmentScope],
    spans: &'a [sync_report::ChapterSpan],
    labels: &'a [String],
    checkpoint_path: &'a FsPath,
}

/// What a run learns, at most once, to tell why chapters went badly.
#[derive(Default)]
struct Clues {
    /// The language the narration was detected in; one book is read in one.
    heard: Option<String>,
    detection_tried: bool,
    transcripts: Option<Vec<String>>,
}

impl AutomaticFixes<'_> {
    async fn run(&self, selected: &[usize], run: &mut SyncCheckpoint) -> anyhow::Result<()> {
        let language = self.aligner.recognition.language.as_deref();
        let heard = run
            .outcomes
            .iter()
            .find_map(|outcome| outcome.evidence.heard_language.clone());
        let mut clues = Clues {
            detection_tried: heard.is_some(),
            heard,
            transcripts: None,
        };
        let mut suggested = false;
        for &index in selected {
            while let Some(outcome) = run.outcomes.get(index) {
                let span = sync_report::with_outcome(self.spans, index, outcome);
                let Some(grade) = chapter_grade(&span, &run.fragments, &run.recovery_gaps)
                    .filter(|grade| *grade >= sync_report::Grade::Poor)
                else {
                    break;
                };
                let content_problem = outcome.error.as_deref().is_none_or(|error| {
                    sync_report::classify_error(error) == sync_report::Cause::NoisyAudio
                });
                if content_problem
                    && outcome
                        .evidence
                        .words_in_text()
                        .is_none_or(|share| share < UNMATCHED_WORDS_IN_TEXT)
                {
                    self.look_closer(index, run, &mut clues).await?;
                }
                let Some(diagnosis) =
                    sync_report::diagnose_chapter(&sync_report::ChapterEvidence {
                        grade: Some(grade),
                        outcome: &run.outcomes[index],
                        language,
                        labels: self.labels,
                    })
                else {
                    break;
                };
                if diagnosis.fix.kind == sync_report::FixKind::Suggested && !suggested {
                    suggested = true;
                    update_job_output(
                        self.aligner.state,
                        self.aligner.job_id,
                        &format!(
                            "{} and any chapters like it need the book re-synced as {}; choose that from its chapter grades.\n",
                            self.labels[index],
                            clues.heard.as_deref().unwrap_or_default()
                        ),
                    )
                    .await;
                }
                if diagnosis.fix.kind != sync_report::FixKind::Auto || diagnosis.fix.attempted {
                    break;
                }
                self.attempt(index, diagnosis.cause, grade, run).await?;
            }
        }
        pause_at_checkpoint(self.aligner.state, self.aligner.job_id).await
    }

    /// For speech that is not this chapter's text: whether it is another
    /// chapter's, and, failing that, which language it is in.
    async fn look_closer(
        &self,
        index: usize,
        run: &mut SyncCheckpoint,
        clues: &mut Clues,
    ) -> anyhow::Result<()> {
        let language = self.aligner.recognition.language.as_deref();
        let transcripts = clues.transcripts.get_or_insert_with(|| {
            self.scopes
                .iter()
                .map(|scope| scope_transcript(self.epub, scope).text)
                .collect()
        });
        // Narration in another language matches no chapter's text.
        let other_language = clues
            .heard
            .as_deref()
            .zip(language)
            .is_some_and(|(heard, expected)| !sync_report::same_language(heard, expected));
        let matching = (!other_language)
            .then(|| matching_scope(&run.outcomes[index].evidence.opening, transcripts, index))
            .flatten();
        if matching.is_none() && !clues.detection_tried && language.is_some() {
            clues.detection_tried = true;
            let scope = &self.scopes[index];
            let detected = tokio::select! {
                biased;
                _ = wait_for_manual_pause(self.aligner.state, self.aligner.job_id) => {
                    pause_at_checkpoint(self.aligner.state, self.aligner.job_id).await?;
                    return Err(SyncPaused.into());
                }
                result = self.aligner.detect_language(scope, &self.tracks[scope.track_index], index) => result,
            };
            let note = match &detected {
                Ok(Some((code, name))) => format!(
                    "The narration sounds like {name} ({code}); recognition was set to {}.\n",
                    language.unwrap_or_default()
                ),
                Ok(None) => String::new(),
                Err(error) => format!("Could not check the narration's language: {error:#}\n"),
            };
            update_job_output(self.aligner.state, self.aligner.job_id, &note).await;
            clues.heard = detected.ok().flatten().map(|(code, _)| code);
        }
        let evidence = &mut run.outcomes[index].evidence;
        evidence.matching_scope = matching;
        evidence.heard_language = clues.heard.clone();
        Ok(())
    }

    /// Aligns one chapter again as `cause` calls for, and keeps the result
    /// if it grades better than `grade`.
    async fn attempt(
        &self,
        index: usize,
        cause: sync_report::Cause,
        grade: sync_report::Grade,
        run: &mut SyncCheckpoint,
    ) -> anyhow::Result<()> {
        let state = self.aligner.state;
        let job_id = self.aligner.job_id;
        let scope = &self.scopes[index];
        let label = &scope.label;
        let outcome = &run.outcomes[index];
        let mut paired_with = outcome.paired_with;
        // Later model retries keep any chapter pairing already repaired.
        let scope = SyncAlignmentScope {
            section_range: paired_with
                .map(|other| self.scopes[other].section_range.clone())
                .unwrap_or_else(|| scope.section_range.clone()),
            ..scope.clone()
        };
        let recognition;
        let (fixer, scope, note) = match cause {
            sync_report::Cause::RuntimeCrash => {
                recognition = self.aligner.recognition.swapped();
                (
                    self.aligner.with_recognition(&recognition),
                    scope.clone(),
                    format!(
                        "{label} crashed the speech recognizer; trying it once more, led by the whisper {} model.",
                        recognition.model
                    ),
                )
            }
            sync_report::Cause::NoisyAudio => {
                recognition = self.aligner.recognition.larger();
                (
                    self.aligner.with_recognition(&recognition),
                    scope.clone(),
                    format!(
                        "{label} was hard to recognize; trying the larger whisper {} model once.",
                        recognition.model
                    ),
                )
            }
            sync_report::Cause::ChapterMismatch => {
                let other = outcome
                    .evidence
                    .matching_scope
                    .expect("a chapter mismatch names its match");
                paired_with = Some(other);
                (
                    self.aligner.with_recognition(self.aligner.recognition),
                    SyncAlignmentScope {
                        section_range: self.scopes[other].section_range.clone(),
                        ..scope.clone()
                    },
                    format!(
                        "The audio of {label} sounds like the text of {}; aligning it with that text.",
                        self.scopes[other].label
                    ),
                )
            }
            _ => return Ok(()),
        };
        update_job_output(state, job_id, &format!("{note}\n")).await;
        let progress = ScopeProgress {
            base: ALIGN_PROGRESS_END,
            span: 0.0,
            step: format!("Trying a fix for {label}"),
            completed: 0,
            total: 1,
        };
        update_job_progress(state, job_id, progress.at(0.0)).await;
        let transcript = scope_transcript(self.epub, &scope);
        let Some(result) = align_unless_paused(
            &fixer,
            &scope,
            &self.tracks[scope.track_index],
            &transcript,
            index,
            &progress,
        )
        .await
        else {
            pause_at_checkpoint(state, job_id).await?;
            return Err(SyncPaused.into());
        };
        let evidence = fixer.take_evidence(&transcript.text);
        run.outcomes[index].fixes.push(cause);
        match result {
            Ok(aligned) => {
                let candidate = sync_report::ScopeOutcome {
                    skipped_text: aligned.skipped_text,
                    evidence,
                    fixes: run.outcomes[index].fixes.clone(),
                    fixed: Some(cause),
                    paired_with,
                    ..Default::default()
                };
                let new_grade = chapter_grade(
                    &sync_report::with_outcome(self.spans, index, &candidate),
                    &aligned.fragments,
                    &aligned.recovery_gaps,
                );
                let note = match new_grade {
                    Some(new) if new < grade => {
                        sync_report::remove_chapter_timing(
                            &mut run.fragments,
                            &mut run.recovery_gaps,
                            &self.spans[index].range(),
                        );
                        run.fragments.extend(aligned.fragments);
                        run.recovery_gaps.extend(aligned.recovery_gaps);
                        run.outcomes[index] = candidate;
                        format!(
                            "  That helped: {label} went from {grade:?} to {new:?}; keeping it.\n"
                        )
                    }
                    _ => format!("  That did not improve {label}; keeping the first result.\n"),
                };
                update_job_output(state, job_id, &note).await;
            }
            Err(error) => {
                update_job_output(state, job_id, &format!("  That failed too: {error:#}\n")).await;
            }
        }
        save_checkpoint(self.checkpoint_path, run).await?;
        pause_at_checkpoint(state, job_id).await
    }
}

/// One chapter's grade from the timing that starts in it.
fn chapter_grade(
    span: &sync_report::ChapterSpan,
    fragments: &[alignment::SyncFragment],
    gaps: &[alignment::RecoveryGap],
) -> Option<sync_report::Grade> {
    sync_report::grade_chapters(
        std::slice::from_ref(span),
        fragments
            .iter()
            .map(|f| (f.start_seconds, f.end_seconds, f.text.as_str())),
        gaps,
    )
    .first()
    .and_then(sync_report::chapter_grade)
}

/// The scope whose text a chapter's recognized opening clearly belongs to,
/// when that is not the chapter's own.
fn matching_scope(opening: &str, transcripts: &[String], own: usize) -> Option<usize> {
    let words = opening
        .split_whitespace()
        .map(|text| alignment::RecognizedWord {
            text: text.to_string(),
            start_time: 0.0,
            end_time: 0.0,
        })
        .collect::<Vec<_>>();
    let phrases = words.len().checked_sub(4).filter(|count| *count > 0)? as f64;
    let share = |text: &str| alignment::recognition_anchor_count(&words, text) as f64 / phrases;
    let own_share = share(&transcripts[own]);
    transcripts
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != own)
        .map(|(index, text)| (index, share(text)))
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .filter(|(_, best)| *best >= REPAIR_MIN_MATCH && *best >= own_share + REPAIR_MARGIN)
        .map(|(index, _)| index)
}

/// "Chapter 3", or "Chapter 3, Chapter 5 and Chapter 7", for the job log.
fn chapter_labels(chapters: &[JobChapter]) -> String {
    let labels = chapters
        .iter()
        .map(|chapter| chapter.label.as_str())
        .collect::<Vec<_>>();
    match labels.split_last() {
        Some((last, [])) => last.to_string(),
        Some((last, rest)) => format!("{} and {last}", rest.join(", ")),
        None => String::new(),
    }
}

/// Sync maps name every sentence of a book, so they are written compactly:
/// pretty-printing a long title's map adds a third to several megabytes
/// that every reader downloads. Returns the identity a report names it by.
async fn write_sync_map(
    path: &FsPath,
    map: &alignment::SyncMap,
) -> anyhow::Result<sync_report::MapIdentity> {
    let bytes = serde_json::to_vec(map)?;
    write_bytes_atomic(path, &bytes)
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;
    Ok(sync_report::MapIdentity::from_bytes(
        map.generated_at.clone(),
        &bytes,
    ))
}

pub(crate) fn scope_transcript(
    epub: &alignment::EpubDocument,
    scope: &SyncAlignmentScope,
) -> alignment::Transcript {
    alignment::build_transcript(&epub.sections[scope.section_range.clone()])
}

pub(crate) struct ScopePlan {
    pub(crate) scopes: Vec<SyncAlignmentScope>,
    /// How the book was divided, for the job log.
    pub(crate) note: Option<String>,
}

/// Divides a book into the scopes it is aligned in. Grading uses the same
/// plan, so a report's chapters are exactly the stretches that were aligned.
pub(crate) fn plan_scopes(
    epub: &alignment::EpubDocument,
    tracks: &[SyncTrackInput],
    chapter_slicing: bool,
) -> anyhow::Result<ScopePlan> {
    // Prefer embedded chapter boundaries for a single large audio file. This
    // resets the aligner throughout an M4B instead of letting small errors
    // accumulate over the entire book. Keep the established whole-track path
    // when chapter metadata, TOC matching, or ffmpeg slicing is unavailable.
    if tracks.len() == 1 {
        return Ok(
            match chapter_alignment_scopes(&tracks[0], &epub.toc, &epub.sections, chapter_slicing) {
                Ok(scopes) => ScopePlan {
                    note: Some(format!(
                        "Matched {} embedded audio chapters; aligning each independently.",
                        scopes.len()
                    )),
                    scopes,
                },
                Err(reason) => ScopePlan {
                    note: Some(format!("Using whole-track alignment: {reason}")),
                    scopes: vec![SyncAlignmentScope {
                        track_index: 0,
                        section_range: 0..epub.sections.len(),
                        audio_range: None,
                        time_offset_seconds: 0.0,
                        label: tracks[0].title.clone(),
                    }],
                },
            },
        );
    }
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
    let titles = tracks
        .iter()
        .map(|track| track.title.clone())
        .collect::<Vec<_>>();
    let scopes = alignment::build_track_scopes(&titles, &epub.toc, epub.sections.len())
        .map_err(|message| anyhow::anyhow!(message))?
        .into_iter()
        .map(|scope| SyncAlignmentScope {
            track_index: scope.track_index,
            section_range: scope.section_range,
            audio_range: None,
            time_offset_seconds: track_start_seconds[scope.track_index],
            label: tracks[scope.track_index].title.clone(),
        })
        .collect();
    Ok(ScopePlan { scopes, note: None })
}

fn chapter_alignment_scopes(
    track: &SyncTrackInput,
    toc: &[alignment::TocEntry],
    sections: &[alignment::SpineSection],
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
    let matched = alignment::build_chapter_scopes_with_sections(&titles, toc, sections)?;

    matched
        .into_iter()
        .map(|scope| {
            let chapter = &track.chapters[scope.chapter_index];
            let last_chapter = &track.chapters[scope.chapter_end_index - 1];
            let start_seconds = chapter.start_seconds;
            let end_seconds = last_chapter
                .end_seconds
                .or_else(|| {
                    track
                        .chapters
                        .get(scope.chapter_end_index)
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

/// Skipped credits, reordered apparatus, and audio-only bonus chapters must
/// hold the reader's place. A matched illustration scope remains covered even
/// when it deliberately produces no text fragments.
fn unscoped_audio_gaps(
    track: &SyncTrackInput,
    scopes: &[SyncAlignmentScope],
) -> Vec<alignment::RecoveryGap> {
    let Some(mut ranges) = scopes
        .iter()
        .map(|s| s.audio_range)
        .collect::<Option<Vec<_>>>()
    else {
        return Vec::new();
    };
    ranges.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut cursor: f64 = 0.0;
    let mut gaps = Vec::new();
    for (start, end) in ranges {
        if start > cursor {
            gaps.push(alignment::RecoveryGap {
                start_seconds: cursor,
                end_seconds: start,
            });
        }
        cursor = cursor.max(end);
    }
    if let Some(end) = track
        .duration_seconds
        .filter(|end| end.is_finite() && *end > cursor)
    {
        gaps.push(alignment::RecoveryGap {
            start_seconds: cursor,
            end_seconds: end,
        });
    }
    gaps
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
/// After losing text, scan short overlapping audio intervals without guessing
/// a new text cursor. Overlap keeps a sentence at a scan boundary recoverable.
const RECOVERY_SCAN_SECONDS: f64 = 60.0;
const RECOVERY_OVERLAP_SECONDS: f64 = 15.0;

/// Which recognizer model to anchor windows with. English books get the
/// English-only model, which is markedly better at the same size.
#[derive(Clone)]
struct RecognitionSettings {
    model: &'static str,
    /// Re-checks uncertain windows and scans for a way back after a lost
    /// stretch.
    retry_model: &'static str,
    language: Option<String>,
}

impl RecognitionSettings {
    fn for_language(language: Option<&str>) -> Self {
        let code = language
            .and_then(|value| value.split(['-', '_']).next())
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .map(|value| if value == "eng" { "en".into() } else { value });
        let english = code.as_deref() == Some("en");
        Self {
            model: if english { "tiny.en" } else { "tiny" },
            retry_model: if english { "base.en" } else { "base" },
            language: code,
        }
    }

    fn describe(&self) -> String {
        match &self.language {
            Some(language) => format!("whisper {}, language {language}", self.model),
            None => format!("whisper {}, language detected", self.model),
        }
    }

    /// For a scope the first pass crashed on: whisper crashes are particular
    /// to a model and its input, so lead with the other one.
    fn swapped(&self) -> Self {
        Self {
            model: self.retry_model,
            retry_model: self.model,
            language: self.language.clone(),
        }
    }

    /// One last, slower pass for audio the usual models could not follow.
    fn larger(&self) -> Self {
        let model = if self.language.as_deref() == Some("en") {
            "small.en"
        } else {
            "small"
        };
        Self {
            model,
            retry_model: model,
            language: self.language.clone(),
        }
    }
}

/// The settings a book's sync recognizes speech with: the language an
/// administrator chose for it, or else the EPUB's own label.
async fn book_recognition(
    state: &AppState,
    book_id: &str,
    epub: &alignment::EpubDocument,
) -> RecognitionSettings {
    let chosen = sync_report::language_override(state, book_id).await;
    RecognitionSettings::for_language(chosen.as_deref().or(epub.language.as_deref()))
}

/// Runs the alignment CLI for one job, sharing its temp directory and tools.
struct Aligner<'a> {
    state: &'a AppState,
    job_id: &'a str,
    cli_path: &'a FsPath,
    cli_args: &'a [String],
    ffmpeg_path: Option<&'a FsPath>,
    temp_dir: &'a FsPath,
    recognition: &'a RecognitionSettings,
    /// What recognition heard in the scope being aligned, kept even when the
    /// scope fails, since that is when it is wanted.
    heard: std::sync::Mutex<Heard>,
}

#[derive(Default)]
struct Heard {
    evidence: sync_report::ScopeEvidence,
    words: Vec<alignment::RecognizedWord>,
}

/// Words of a scope's opening kept to look for elsewhere in the book: about
/// the first minute of narration.
const OPENING_WORDS: usize = 150;

#[derive(Default)]
struct ScopeAlignment {
    fragments: Vec<alignment::SyncFragment>,
    recovery_gaps: Vec<alignment::RecoveryGap>,
    /// Edition-only text deliberately left unmatched, in the units
    /// `sync_report::text_units` counts, so it does not lower the grade.
    skipped_text: u64,
}

impl<'a> Aligner<'a> {
    fn new(
        state: &'a AppState,
        job_id: &'a str,
        runtime: &'a SyncAddonRuntime,
        temp_dir: &'a FsPath,
        recognition: &'a RecognitionSettings,
    ) -> Self {
        Self {
            state,
            job_id,
            cli_path: &runtime.cli_path,
            cli_args: &runtime.cli_args,
            ffmpeg_path: runtime.ffmpeg_path.as_deref(),
            temp_dir,
            recognition,
            heard: Default::default(),
        }
    }

    fn with_recognition<'b>(&self, recognition: &'b RecognitionSettings) -> Aligner<'b>
    where
        'a: 'b,
    {
        Aligner {
            state: self.state,
            job_id: self.job_id,
            cli_path: self.cli_path,
            cli_args: self.cli_args,
            ffmpeg_path: self.ffmpeg_path,
            temp_dir: self.temp_dir,
            recognition,
            heard: Default::default(),
        }
    }

    fn record(&self, change: impl FnOnce(&mut Heard)) {
        change(&mut self.heard.lock().unwrap_or_else(|error| error.into_inner()));
    }

    /// What was heard since the last call, measured against the text the
    /// scope was aligned with.
    fn take_evidence(&self, text: &str) -> sync_report::ScopeEvidence {
        let Heard {
            mut evidence,
            words,
        } = std::mem::take(&mut *self.heard.lock().unwrap_or_else(|error| error.into_inner()));
        let (runs, found) = alignment::recognized_runs_in_text(&words, text);
        evidence.recognized_words = words.len() as u32;
        evidence.word_runs = runs as u32;
        evidence.word_runs_in_text = found as u32;
        evidence.opening = words
            .iter()
            .take(OPENING_WORDS)
            .map(|word| word.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        evidence
    }

    async fn align_scope(
        &self,
        scope: &SyncAlignmentScope,
        track: &SyncTrackInput,
        transcript: &alignment::Transcript,
        scope_number: usize,
        progress: &ScopeProgress,
    ) -> anyhow::Result<ScopeAlignment> {
        let (scope_start, scope_end) = match scope.audio_range {
            Some((start, end)) => (start, Some(end)),
            None => (0.0, track.duration_seconds),
        };
        let windowed = match (self.ffmpeg_path, scope_end) {
            (Some(ffmpeg), Some(scope_end)) if scope_end - scope_start > 0.5 => {
                Some((ffmpeg, scope_end))
            }
            _ => None,
        };
        let aligned = match windowed {
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
        }?;
        anyhow::ensure!(
            !aligned.fragments.is_empty() || transcript.text.trim().is_empty(),
            "Alignment of `{}` produced no usable sentence fragments.",
            scope.label
        );
        Ok(aligned)
    }

    /// The established path: one aligner run over the scope's whole audio.
    async fn align_single_pass(
        &self,
        scope: &SyncAlignmentScope,
        track: &SyncTrackInput,
        transcript: &alignment::Transcript,
        scope_number: usize,
    ) -> anyhow::Result<ScopeAlignment> {
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
        let mut prepared = transcript.window(0, transcript.len_utf16());
        let duration = scope
            .audio_range
            .map(|(start, end)| end - start)
            .or(track.duration_seconds);
        let mut recognized = Vec::new();
        let mut skipped_text = 0;
        if duration.is_some_and(|seconds| seconds <= MAX_SINGLE_PASS_SECONDS) {
            recognized = self
                .transcribe_checked(
                    audio_path,
                    scope_number,
                    0,
                    &prepared.text,
                    duration.unwrap(),
                )
                .await?;
            skipped_text = self
                .mask_unspoken_sentences(&mut prepared, &recognized, 0..transcript.len_utf16())
                .await;
            prepared.include_unmapped_leading_narration(&recognized);
            self.include_unmapped_narration(&mut prepared, &recognized, true)
                .await;
        }
        let fragments = self
            .align_pass(
                audio_path,
                &prepared,
                scope.time_offset_seconds,
                scope_number,
                0,
                &scope.label,
                &recognized,
            )
            .await;
        if let Some(path) = sliced {
            let _ = fs::remove_file(path).await;
        }
        Ok(ScopeAlignment {
            fragments: fragments?,
            recovery_gaps: Vec::new(),
            skipped_text,
        })
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
    ) -> anyhow::Result<ScopeAlignment> {
        // Book time of position zero in this file.
        let book_offset = scope.time_offset_seconds - scope_start;
        let text_len = transcript.len_utf16();
        let mut transcript = transcript.window(0, text_len);
        let pace = text_len as f64 / (scope_end - scope_start);
        let mut position = scope_start;
        let mut cursor = 0u64;
        let mut fragments = Vec::new();
        let mut windows = 0usize;
        let mut unanchored = 0usize;
        let mut recovering = false;
        let mut recovery_start = None;
        let mut recovery_gaps = Vec::new();
        let mut skipped_text = 0;

        while position < scope_end - 0.5 && cursor < text_len {
            windows += 1;
            let remaining = scope_end - position;
            if recovering {
                let gap_start = *recovery_start.get_or_insert_with(|| {
                    fragments.last().map_or(
                        book_offset + scope_start,
                        |fragment: &alignment::SyncFragment| fragment.end_seconds,
                    )
                });
                let scan_end = (position + RECOVERY_SCAN_SECONDS).min(scope_end);
                let audio = self
                    .slice(
                        ffmpeg,
                        &track.path,
                        position,
                        scan_end,
                        scope_number,
                        windows,
                        "recovery",
                    )
                    .await?;
                // Recovery requires an exact, unique sentence. The normal
                // window model can have enough short anchors to avoid retry
                // while still mishearing every complete sentence after noise.
                // Use the stronger model for these bounded recovery scans.
                let mut recognized = match self
                    .transcribe(
                        &audio,
                        scope_number,
                        &windows.to_string(),
                        self.recognition.retry_model,
                    )
                    .await
                {
                    Ok(words) => words,
                    Err(error) => {
                        self.note_failed_retry(&error).await;
                        self.transcribe(
                            &audio,
                            scope_number,
                            &windows.to_string(),
                            self.recognition.model,
                        )
                        .await?
                    }
                };
                if let Some(retry_start) =
                    alignment::recovery_clock_retry_start(&recognized, &transcript.text)
                    && retry_start > 0.0
                    && retry_start < scan_end - position - 0.5
                {
                    let shorter = self
                        .slice(
                            ffmpeg,
                            &audio,
                            retry_start,
                            scan_end - position,
                            scope_number,
                            windows,
                            "recovery-clock",
                        )
                        .await?;
                    let retry = self
                        .transcribe(
                            &shorter,
                            scope_number,
                            &format!("{windows}-recovery-clock"),
                            self.recognition.retry_model,
                        )
                        .await;
                    let _ = fs::remove_file(shorter).await;
                    if let Ok(mut retry) = retry {
                        for word in &mut retry {
                            word.start_time += retry_start;
                            word.end_time += retry_start;
                        }
                        if alignment::find_recovery_anchor(
                            &retry,
                            &transcript.text,
                            cursor,
                            scan_end - position,
                        )
                        .is_some()
                        {
                            recognized = retry;
                        }
                    }
                }
                let _ = fs::remove_file(audio).await;
                self.record(|heard| {
                    heard.evidence.windows += 1;
                    heard.evidence.recognized_seconds += scan_end - position;
                    heard.words.extend(recognized.iter().cloned());
                });
                if let Some(anchor) = alignment::find_recovery_anchor(
                    &recognized,
                    &transcript.text,
                    cursor,
                    scan_end - position,
                ) {
                    let start = position + anchor.start_seconds;
                    let end = position + anchor.end_seconds;
                    let audio = self
                        .slice(
                            ffmpeg,
                            &track.path,
                            start,
                            end,
                            scope_number,
                            windows,
                            "recovered",
                        )
                        .await?;
                    let chunk = transcript.window(anchor.text_start_utf16, anchor.text_end_utf16);
                    let shifted = recognized
                        .iter()
                        .cloned()
                        .map(|mut word| {
                            word.start_time -= anchor.start_seconds;
                            word.end_time -= anchor.start_seconds;
                            word
                        })
                        .collect::<Vec<_>>();
                    let result = self
                        .align(
                            &audio,
                            &chunk,
                            book_offset + start,
                            scope_number,
                            windows,
                            &scope.label,
                            &shifted,
                            end - start,
                        )
                        .await;
                    let _ = fs::remove_file(audio).await;
                    let recovered = result?;
                    position = end;
                    cursor =
                        alignment::skip_whitespace_utf16(&transcript.text, anchor.text_end_utf16);
                    // Recognition alone is not enough: keep the gap open if
                    // forced alignment cannot produce a usable sentence.
                    if let Some(first) = recovered.fragments.first() {
                        if first.start_seconds > gap_start {
                            recovery_gaps.push(alignment::RecoveryGap {
                                start_seconds: gap_start,
                                end_seconds: first.start_seconds,
                            });
                        }
                        recovery_start = None;
                        recovering = false;
                        update_job_output(self.state, self.job_id, &format!("  Recovered at {:.1} s using a unique sentence; uncertain audio was left unmatched.\n", first.start_seconds)).await;
                        recovery_gaps.extend(recovered.recovery_gaps);
                        fragments.extend(recovered.fragments);
                    }
                } else {
                    position = if scan_end >= scope_end {
                        scope_end
                    } else {
                        scan_end - RECOVERY_OVERLAP_SECONDS
                    };
                }
                let done =
                    (position - scope_start) / (scope_end - scope_start).max(f64::MIN_POSITIVE);
                update_job_progress(self.state, self.job_id, progress.at(done)).await;
                continue;
            }
            let (segment_end, text_end, lead_in, recognized) =
                if remaining <= MAX_SINGLE_PASS_SECONDS {
                    let audio = self
                        .slice(
                            ffmpeg,
                            &track.path,
                            position,
                            scope_end,
                            scope_number,
                            windows,
                            "window",
                        )
                        .await?;
                    let recognition_text = transcript.window(cursor, text_len);
                    let recognized = self
                        .transcribe_checked(
                            &audio,
                            scope_number,
                            windows,
                            &recognition_text.text,
                            scope_end - position,
                        )
                        .await?;
                    let _ = fs::remove_file(audio).await;
                    skipped_text += self
                        .mask_unspoken_sentences(&mut transcript, &recognized, cursor..text_len)
                        .await;
                    let text = transcript.window(cursor, text_len);
                    let anchor = alignment::find_window_anchor(
                        &recognized,
                        &transcript.text,
                        cursor,
                        text_len - cursor,
                        remaining,
                    );
                    if text.text.split_whitespace().count() >= 10
                        && (anchor.end.is_none()
                            || alignment::recognition_misses_opening(&recognized, &text.text))
                    {
                        unanchored += 1;
                        self.record(|heard| heard.evidence.unanchored_windows += 1);
                        recovering = true;
                        continue;
                    }
                    if alignment::recognition_misses_ending(&recognized, &text.text)
                        && let Some(end) = anchor.end
                    {
                        (
                            position + end.seconds,
                            end.text_end_utf16,
                            anchor.lead_in_seconds,
                            recognized,
                        )
                    } else {
                        (scope_end, text_len, 0.0, recognized)
                    }
                } else {
                    let mut window = WINDOW_SECONDS;
                    let (anchor, recognized) = loop {
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
                        let lookahead =
                            ((window_end - position) * pace * WINDOW_TEXT_LOOKAHEAD).ceil() as u64;
                        let recognition_end = (cursor + lookahead).min(text_len);
                        let recognition_text = transcript.window(cursor, recognition_end);
                        let recognized = self
                            .transcribe_checked(
                                &audio,
                                scope_number,
                                windows,
                                &recognition_text.text,
                                window_end - position,
                            )
                            .await?;
                        let _ = fs::remove_file(audio).await;
                        // Inspect the recognition lookahead before cutting the
                        // alignment window. An omission may cross that cut.
                        skipped_text += self
                            .mask_unspoken_sentences(
                                &mut transcript,
                                &recognized,
                                cursor..recognition_end,
                            )
                            .await;
                        let anchor = alignment::find_window_anchor(
                            &recognized,
                            &transcript.text,
                            cursor,
                            lookahead,
                            window_end - position - WINDOW_MARGIN_SECONDS,
                        );
                        if anchor.end.is_some() || window >= WINDOW_SECONDS * 2.0 {
                            break (anchor, recognized);
                        }
                        // Nothing usable: look twice as far once before giving up.
                        window *= 2.0;
                    };
                    let recognition_text = transcript.window(cursor, text_len);
                    if alignment::recognition_misses_opening(&recognized, &recognition_text.text) {
                        unanchored += 1;
                        self.record(|heard| heard.evidence.unanchored_windows += 1);
                        recovering = true;
                        continue;
                    }
                    let (segment_end, text_end, lead_in) = match anchor.end {
                        Some(end) => (
                            position + end.seconds,
                            end.text_end_utf16,
                            anchor.lead_in_seconds,
                        ),
                        None => {
                            // Never advance text by an average-rate guess. An
                            // error here otherwise becomes the next window's
                            // starting point and can persist for the chapter.
                            unanchored += 1;
                            self.record(|heard| heard.evidence.unanchored_windows += 1);
                            recovering = true;
                            continue;
                        }
                    };
                    (segment_end, text_end, lead_in, recognized)
                };
            let text_end = text_end.clamp(cursor, text_len);
            anyhow::ensure!(
                text_end > cursor,
                "Windowed alignment of `{}` stalled at {:.0} s.",
                scope.label,
                position
            );
            let segment_start = position + lead_in;
            if segment_end - segment_start > 0.5 {
                let audio = self
                    .slice(
                        ffmpeg,
                        &track.path,
                        segment_start,
                        segment_end,
                        scope_number,
                        windows,
                        "segment",
                    )
                    .await?;
                let mut window_transcript = transcript.window(cursor, text_end);
                if cursor == 0 && lead_in == 0.0 {
                    window_transcript.include_unmapped_leading_narration(&recognized);
                }
                self.include_unmapped_narration(
                    &mut window_transcript,
                    &recognized,
                    text_end == text_len && (segment_end - scope_end).abs() < 0.001,
                )
                .await;
                let segment_recognition = recognized
                    .iter()
                    .cloned()
                    .map(|mut word| {
                        word.start_time -= lead_in;
                        word.end_time -= lead_in;
                        word
                    })
                    .collect::<Vec<_>>();
                let segment_fragments = self
                    .align(
                        &audio,
                        &window_transcript,
                        book_offset + segment_start,
                        scope_number,
                        windows,
                        &scope.label,
                        &segment_recognition,
                        segment_end - segment_start,
                    )
                    .await;
                let _ = fs::remove_file(audio).await;
                let aligned = segment_fragments?;
                fragments.extend(aligned.fragments);
                recovery_gaps.extend(aligned.recovery_gaps);
            }
            position = segment_end;
            cursor = alignment::skip_whitespace_utf16(&transcript.text, text_end);
            let done = (position - scope_start) / (scope_end - scope_start).max(f64::MIN_POSITIVE);
            update_job_progress(self.state, self.job_id, progress.at(done)).await;
        }

        if let Some(start_seconds) = recovery_start
            && book_offset + scope_end > start_seconds
        {
            recovery_gaps.push(alignment::RecoveryGap {
                start_seconds,
                end_seconds: book_offset + scope_end,
            });
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
        Ok(ScopeAlignment {
            fragments,
            recovery_gaps,
            skipped_text,
        })
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
        extract_alignment_audio(ffmpeg, source, &path, start_seconds, end_seconds).await?;
        Ok(path)
    }

    async fn transcribe_checked(
        &self,
        audio_path: &FsPath,
        scope_number: usize,
        window: usize,
        text: &str,
        duration: f64,
    ) -> anyhow::Result<Vec<alignment::RecognizedWord>> {
        let words = self
            .recognize_window(audio_path, scope_number, window, text, duration)
            .await?;
        self.record(|heard| {
            heard.evidence.windows += 1;
            heard.evidence.recognized_seconds += duration;
            heard.words.extend(words.iter().cloned());
        });
        Ok(words)
    }

    async fn recognize_window(
        &self,
        audio_path: &FsPath,
        scope_number: usize,
        window: usize,
        text: &str,
        duration: f64,
    ) -> anyhow::Result<Vec<alignment::RecognizedWord>> {
        let recognized = self
            .transcribe(
                audio_path,
                scope_number,
                &window.to_string(),
                self.recognition.model,
            )
            .await?;
        if !alignment::recognition_needs_retry(&recognized, text) {
            return Ok(recognized);
        }
        let model = self.recognition.retry_model;
        self.record(|heard| heard.evidence.recognition_retries += 1);
        // Retries only refine a usable result. The larger model can crash on
        // audio the first one handled, so keep that result rather than fail
        // the book. A pass already using the larger model goes straight to
        // shorter windows.
        let recognized = if model == self.recognition.model {
            recognized
        } else {
            update_job_output(
                self.state,
                self.job_id,
                "  Retrying uncertain speech recognition in this window.\n",
            )
            .await;
            match self
                .transcribe(audio_path, scope_number, &window.to_string(), model)
                .await
            {
                Ok(retry) => retry,
                Err(error) => {
                    self.note_failed_retry(&error).await;
                    return Ok(recognized);
                }
            }
        };
        let Some(ffmpeg) = self
            .ffmpeg_path
            .filter(|_| duration > 60.0 && alignment::recognition_needs_retry(&recognized, text))
        else {
            return Ok(recognized);
        };
        update_job_output(
            self.state,
            self.job_id,
            "  Checking uncertain recognition in two shorter windows.\n",
        )
        .await;
        let midpoint = duration / 2.0;
        let mut shorter = Vec::new();
        for (part, start, end) in [
            ("left", 0.0, (midpoint + 10.0).min(duration)),
            ("right", (midpoint - 10.0).max(0.0), duration),
        ] {
            let audio = self
                .slice(ffmpeg, audio_path, start, end, scope_number, window, part)
                .await?;
            let result = self
                .transcribe(&audio, scope_number, &format!("{window}-{part}"), model)
                .await;
            let _ = fs::remove_file(audio).await;
            let words = match result {
                Ok(words) => words,
                Err(error) => {
                    self.note_failed_retry(&error).await;
                    return Ok(recognized);
                }
            };
            for mut word in words {
                word.start_time += start;
                word.end_time += start;
                if (part == "left" && word.start_time < midpoint)
                    || (part == "right" && word.start_time >= midpoint)
                {
                    shorter.push(word);
                }
            }
        }
        if alignment::recognition_anchor_count(&shorter, text)
            <= alignment::recognition_anchor_count(&recognized, text)
        {
            return Ok(recognized);
        }
        #[cfg(test)]
        if let Some(directory) = std::env::var_os("OPERALIBRE_PROBE_OUTPUT") {
            let entries = shorter.iter().map(|word| serde_json::json!({"type":"word", "text":word.text, "startTime":word.start_time, "endTime":word.end_time})).collect::<Vec<_>>();
            fs::write(
                PathBuf::from(directory).join(format!("recognition-{scope_number}-{window}.json")),
                serde_json::to_vec(&entries)?,
            )
            .await?;
        }
        Ok(shorter)
    }

    /// The language a sample of the scope's audio is spoken in, as a code
    /// and a name, when the recognizer is confident of it.
    async fn detect_language(
        &self,
        scope: &SyncAlignmentScope,
        track: &SyncTrackInput,
        scope_number: usize,
    ) -> anyhow::Result<Option<(String, String)>> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Detected {
            language: String,
            #[serde(default)]
            language_name: String,
            probability: f64,
        }
        let (Some(ffmpeg), Some((start, end))) = (
            self.ffmpeg_path,
            scope
                .audio_range
                .or(track.duration_seconds.map(|seconds| (0.0, seconds))),
        ) else {
            return Ok(None);
        };
        let from = start + ((end - start) / 3.0).min(LANGUAGE_SAMPLE_OFFSET);
        let audio = self
            .slice(
                ffmpeg,
                &track.path,
                from,
                (from + LANGUAGE_SAMPLE_SECONDS).min(end),
                scope_number,
                0,
                "language",
            )
            .await?;
        let output_path = self.temp_dir.join("language.json");
        let detected = run_alignment_cli(
            self.cli_path,
            self.cli_args,
            self.ffmpeg_path,
            &[
                "detect-speech-language".into(),
                audio.as_os_str().into(),
                output_path.as_os_str().into(),
            ],
            "Language detection",
        )
        .await;
        let _ = fs::remove_file(&audio).await;
        detected?;
        let json = read_cli_output(&output_path, "Language detection").await?;
        let _ = fs::remove_file(&output_path).await;
        Ok(serde_json::from_str::<Vec<Detected>>(&json)?
            .into_iter()
            .max_by(|a, b| a.probability.total_cmp(&b.probability))
            .filter(|best| best.probability >= LANGUAGE_CONFIDENCE)
            .map(|best| (best.language, best.language_name)))
    }

    async fn note_failed_retry(&self, error: &anyhow::Error) {
        let reason = error.to_string();
        let reason = reason.lines().next().unwrap_or_default();
        update_job_output(
            self.state,
            self.job_id,
            &format!("  Continuing without a failed recognition retry: {reason}\n"),
        )
        .await;
    }

    async fn transcribe(
        &self,
        audio_path: &FsPath,
        scope_number: usize,
        window: &str,
        model: &str,
    ) -> anyhow::Result<Vec<alignment::RecognizedWord>> {
        let output_path = self
            .temp_dir
            .join(format!("recognition-{scope_number}-{window}.json"));
        let mut args: Vec<std::ffi::OsString> = vec![
            "transcribe".into(),
            audio_path.into(),
            output_path.as_os_str().into(),
            "--engine=whisper".into(),
            format!("--whisper.model={model}").into(),
        ];
        if let Some(language) = &self.recognition.language {
            args.push(format!("--language={language}").into());
        }
        run_alignment_cli(
            self.cli_path,
            self.cli_args,
            self.ffmpeg_path,
            &args,
            "Speech recognition",
        )
        .await?;
        let timeline_json = read_cli_output(&output_path, "Speech recognition").await?;
        #[cfg(test)]
        if let Some(directory) = std::env::var_os("OPERALIBRE_PROBE_OUTPUT") {
            fs::copy(
                &output_path,
                PathBuf::from(directory).join(output_path.file_name().unwrap()),
            )
            .await?;
        }
        let _ = fs::remove_file(&output_path).await;
        let entries = alignment::parse_timeline(&timeline_json)?;
        Ok(alignment::recognized_words(&entries))
    }

    /// Returns how much text was masked, as `sync_report::text_units`.
    async fn mask_unspoken_sentences(
        &self,
        transcript: &mut alignment::Transcript,
        recognized: &[alignment::RecognizedWord],
        range: std::ops::Range<u64>,
    ) -> u64 {
        let mut window = transcript.window(range.start, range.end);
        let count = window.mask_unspoken_sentences(recognized);
        let mut masked = 0;
        if count > 0 {
            let start = alignment::utf16_to_byte_index(&transcript.text, range.start);
            let end = alignment::utf16_to_byte_index(&transcript.text, range.end);
            // Masking blanks text in place, so the difference is what was hidden.
            masked = sync_report::text_units(&transcript.text[start..end])
                .saturating_sub(sync_report::text_units(&window.text));
            transcript.text.replace_range(start..end, &window.text);
            update_job_output(
                self.state,
                self.job_id,
                &format!("  Left {count} unspoken text passage(s) unmatched.\n"),
            )
            .await;
        }
        masked
    }

    async fn include_unmapped_narration(
        &self,
        transcript: &mut alignment::Transcript,
        recognized: &[alignment::RecognizedWord],
        at_scope_end: bool,
    ) {
        let mut count = transcript.include_unmapped_narration(recognized);
        if at_scope_end {
            count += transcript.include_unmapped_trailing_narration(recognized);
        }
        if count > 0 {
            update_job_output(
                self.state,
                self.job_id,
                &format!(
                    "  Kept {count} additional narration passage(s) separate from EPUB text.\n"
                ),
            )
            .await;
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn align(
        &self,
        audio_path: &FsPath,
        transcript: &alignment::Transcript,
        time_offset_seconds: f64,
        scope_number: usize,
        window: usize,
        label: &str,
        recognized: &[alignment::RecognizedWord],
        duration: f64,
    ) -> anyhow::Result<ScopeAlignment> {
        let mut interruptions = alignment::interrupted_passages(transcript, recognized);
        let confirmation;
        let recognized = if interruptions.is_empty() {
            recognized
        } else {
            update_job_output(
                self.state,
                self.job_id,
                "  Verifying apparently missing narration before splitting alignment.\n",
            )
            .await;
            // Without confirmation, align the window whole instead of splitting.
            confirmation = match self
                .transcribe(
                    audio_path,
                    scope_number,
                    &format!("{window}-interruption-check"),
                    self.recognition.retry_model,
                )
                .await
            {
                Ok(words) => words,
                Err(error) => {
                    self.note_failed_retry(&error).await;
                    interruptions.clear();
                    Vec::new()
                }
            };
            let confirmed = alignment::interrupted_passages(transcript, &confirmation);
            interruptions.retain(|gap| {
                confirmed.iter().any(|other| {
                    gap.text_start_utf16 == other.text_start_utf16
                        && gap.text_end_utf16 == other.text_end_utf16
                })
            });
            if alignment::recognition_anchor_count(&confirmation, &transcript.text)
                > alignment::recognition_anchor_count(recognized, &transcript.text)
            {
                &confirmation
            } else {
                recognized
            }
        };
        let mut fragments: Vec<alignment::SyncFragment> = Vec::new();
        let mut recovery_gaps = Vec::new();
        let mut text_start = 0;
        let mut audio_start = 0.0;
        if let Some(ffmpeg) = self.ffmpeg_path
            && !interruptions.is_empty()
        {
            for (part, interruption) in interruptions
                .iter()
                .map(Some)
                .chain(std::iter::once(None))
                .enumerate()
            {
                let text_end = interruption.map_or(transcript.len_utf16(), |g| g.text_start_utf16);
                let audio_end = interruption
                    .map_or(duration, |g| g.start_seconds)
                    .min(duration);
                if audio_end > audio_start + 0.1 {
                    let audio = self
                        .slice(
                            ffmpeg,
                            audio_path,
                            audio_start,
                            audio_end,
                            scope_number,
                            window,
                            &format!("trusted-{part}"),
                        )
                        .await?;
                    let text = transcript.window(text_start, text_end);
                    let speech = recognized
                        .iter()
                        .filter(|w| w.start_time >= audio_start && w.end_time <= audio_end)
                        .cloned()
                        .map(|mut w| {
                            w.start_time -= audio_start;
                            w.end_time -= audio_start;
                            w
                        })
                        .collect::<Vec<_>>();
                    let aligned = self
                        .align_pass(
                            &audio,
                            &text,
                            time_offset_seconds + audio_start,
                            scope_number,
                            window,
                            label,
                            &speech,
                        )
                        .await;
                    let _ = fs::remove_file(audio).await;
                    let aligned = aligned?;
                    fragments.extend(aligned);
                }
                if let Some(gap) = interruption {
                    text_start = gap.text_end_utf16;
                    audio_start = gap.end_seconds;
                }
            }
            for gap in &interruptions {
                let start_seconds = fragments
                    .iter()
                    .rev()
                    .find(|f| f.end_seconds <= time_offset_seconds + gap.start_seconds + 0.001)
                    .map_or(time_offset_seconds, |f| f.end_seconds);
                let end_seconds = fragments
                    .iter()
                    .find(|f| f.start_seconds >= time_offset_seconds + gap.end_seconds - 0.001)
                    .map_or(time_offset_seconds + duration, |f| f.start_seconds);
                if end_seconds > start_seconds {
                    recovery_gaps.push(alignment::RecoveryGap {
                        start_seconds,
                        end_seconds,
                    });
                }
            }
        } else {
            fragments = self
                .align_pass(
                    audio_path,
                    transcript,
                    time_offset_seconds,
                    scope_number,
                    window,
                    label,
                    recognized,
                )
                .await?;
        }
        Ok(ScopeAlignment {
            fragments,
            recovery_gaps,
            skipped_text: 0,
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn align_pass(
        &self,
        audio_path: &FsPath,
        transcript: &alignment::Transcript,
        time_offset_seconds: f64,
        scope_number: usize,
        window: usize,
        label: &str,
        recognized: &[alignment::RecognizedWord],
    ) -> anyhow::Result<Vec<alignment::SyncFragment>> {
        // A recognizer may capture only the end of a closing description.
        // The unique final prose anchor still identifies where printed text
        // stops. Clip there rather than stretch prose over unrecognized audio.
        let mapped_end = transcript
            .sections
            .iter()
            .filter(|section| !section.href.is_empty())
            .map(|section| section.end_utf16)
            .max()
            .unwrap_or(0);
        let prose = transcript.window(0, mapped_end);
        let clipped_audio = if mapped_end < transcript.len_utf16()
            && let (Some(ffmpeg), Some(end)) =
                (self.ffmpeg_path, prose.narrated_text_end(recognized))
        {
            Some(
                self.slice(ffmpeg, audio_path, 0.0, end, scope_number, window, "prose")
                    .await?,
            )
        } else {
            None
        };
        let transcript = if clipped_audio.is_some() {
            &prose
        } else {
            transcript
        };
        let audio_path = clipped_audio.as_deref().unwrap_or(audio_path);
        let transcript_path = self
            .temp_dir
            .join(format!("transcript-{scope_number}-{window}.txt"));
        fs::write(&transcript_path, &transcript.text).await?;
        let output_path = self
            .temp_dir
            .join(format!("alignment-{scope_number}-{window}.json"));
        let mut args: Vec<std::ffi::OsString> = vec![
            "align".into(),
            audio_path.into(),
            transcript_path.as_os_str().into(),
            output_path.as_os_str().into(),
        ];
        // Without a language, Echogarden guesses one from this window's text.
        // Short or name-heavy passages can read as Klingon or Tagalog, which
        // eSpeak cannot voice, and the whole book then fails.
        if let Some(language) = &self.recognition.language {
            args.push(format!("--language={language}").into());
        }
        run_alignment_cli(
            self.cli_path,
            self.cli_args,
            self.ffmpeg_path,
            &args,
            &format!("Alignment of `{label}`"),
        )
        .await?;
        let timeline_json =
            read_cli_output(&output_path, &format!("Alignment of `{label}`")).await?;
        #[cfg(test)]
        if let Some(directory) = std::env::var_os("OPERALIBRE_PROBE_OUTPUT") {
            fs::copy(
                &output_path,
                PathBuf::from(directory).join(output_path.file_name().unwrap()),
            )
            .await?;
        }
        let _ = fs::remove_file(&output_path).await;
        let _ = fs::remove_file(&transcript_path).await;
        if let Some(path) = clipped_audio {
            let _ = fs::remove_file(path).await;
        }
        let mut entries = alignment::parse_timeline(&timeline_json)?;
        alignment::recover_zero_duration_sentences(&mut entries, &transcript.text, recognized);
        alignment::reconcile_sentence_starts(&mut entries, &transcript.text, recognized);
        alignment::reconcile_word_clocks(&mut entries, &transcript.text, recognized);
        Ok(alignment::fragments_from_timeline(
            &entries,
            transcript,
            time_offset_seconds,
        ))
    }
}

/// Echogarden's launcher reports a crashed worker as a clean exit, so a
/// missing result is the only sign the command failed.
async fn read_cli_output(path: &FsPath, what: &str) -> anyhow::Result<String> {
    fs::read_to_string(path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            anyhow::anyhow!(
                "{what} stopped without writing a result. The alignment runtime may have crashed."
            )
        } else {
            error.into()
        }
    })
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
        anyhow::bail!(
            "{what} failed with status {}:\n{}",
            output.status,
            stderr_tail(&output)
        );
    }
    Ok(())
}

/// The last 12 lines of a failed command's stderr, for its error message.
fn stderr_tail(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let lines = stderr.lines().collect::<Vec<_>>();
    lines[lines.len().saturating_sub(12)..].join("\n")
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
        anyhow::bail!(
            "ffmpeg failed to extract chapter audio with status {}:\n{}",
            output.status,
            stderr_tail(&output)
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
    find_on_path(&["echogarden", "echogarden.cmd", "echogarden.exe"])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn checkpoint_rejects_changed_runtime_components_at_the_same_paths() {
        let root = tempfile::tempdir().unwrap();
        let epub = root.path().join("book.epub");
        let cli = root.path().join("python");
        let script = root.path().join("align.py");
        let ffmpeg = root.path().join("ffmpeg");
        for path in [&epub, &cli, &script, &ffmpeg] {
            fs::write(path, b"original").await.unwrap();
        }
        let runtime = SyncAddonRuntime {
            cli_path: cli,
            cli_args: vec![script.to_string_lossy().into_owned(), "--fixture".into()],
            ffmpeg_path: Some(ffmpeg.clone()),
        };
        let recognition = RecognitionSettings::for_language(Some("en"));
        let original = checkpoint_fingerprint(&epub, &[], &[], &runtime, &recognition)
            .await
            .unwrap();
        assert_eq!(
            checkpoint_fingerprint(&epub, &[], &[], &runtime, &recognition)
                .await
                .unwrap(),
            original
        );
        fs::write(&script, b"updated alignment script")
            .await
            .unwrap();
        let changed_script = checkpoint_fingerprint(&epub, &[], &[], &runtime, &recognition)
            .await
            .unwrap();
        assert_ne!(changed_script, original);
        fs::write(&ffmpeg, b"updated audio slicing binary")
            .await
            .unwrap();
        assert_ne!(
            checkpoint_fingerprint(&epub, &[], &[], &runtime, &recognition)
                .await
                .unwrap(),
            changed_script
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_sync_jobs_name_their_cause() {
        let root = tempfile::tempdir().unwrap();
        let (state, _) = crate::unit_tests::fake_libation_state(root.path());
        let finish = |kind: &'static str, error: &'static str| {
            let state = state.clone();
            async move {
                let id = create_job(&state, kind).await;
                update_job_finished(&state, &id, "failed", None, Some(error.into())).await;
                state.jobs.read().await[&id].clone()
            }
        };
        let missing = "Failed to run alignment CLI: No such file or directory (os error 2)";
        let job = finish(SYNC_GENERATE_JOB_KIND, missing).await;
        assert_eq!(job.cause, Some(sync_report::Cause::RuntimeMissing));
        assert_eq!(job.error.as_deref(), Some(missing));
        assert_eq!(
            serde_json::to_value(&job).unwrap()["cause"],
            "runtime-missing"
        );
        // Other kinds of job keep their raw error alone.
        assert_eq!(finish("faststart", missing).await.cause, None);
        // A run that diagnosed its own failure keeps that cause.
        let id = create_job(&state, SYNC_GENERATE_JOB_KIND).await;
        state.jobs.write().await.get_mut(&id).unwrap().cause =
            Some(sync_report::Cause::EditionMismatch);
        update_job_finished(
            &state,
            &id,
            "failed",
            None,
            Some("Alignment produced no usable sentence fragments.".into()),
        )
        .await;
        assert_eq!(
            state.jobs.read().await[&id].cause,
            Some(sync_report::Cause::EditionMismatch)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_books_language_override_replaces_the_epub_label_for_recognition() {
        let root = tempfile::tempdir().unwrap();
        let (state, _) = crate::unit_tests::fake_libation_state(root.path());
        let epub = alignment::parse_epub(&alignment::build_test_epub_in_language(
            &[("Chapter 1", "<p>Hallo.</p>")],
            Some("nl-NL"),
        ))
        .unwrap();
        let recognition = book_recognition(&state, "book", &epub).await;
        assert_eq!(
            (recognition.model, recognition.language.as_deref()),
            ("tiny", Some("nl"))
        );
        state
            .metadata_overrides
            .mutate(|overrides| {
                overrides
                    .books
                    .entry("book".into())
                    .or_default()
                    .sync_language = Some("en".into());
                Ok(())
            })
            .await
            .unwrap();
        let recognition = book_recognition(&state, "book", &epub).await;
        assert_eq!(
            (
                recognition.model,
                recognition.retry_model,
                recognition.language.as_deref()
            ),
            ("tiny.en", "base.en", Some("en"))
        );
        assert_eq!(recognition.larger().model, "small.en");
        assert_eq!(recognition.swapped().model, "base.en");
        // Another book keeps its own label.
        let other = book_recognition(&state, "other", &epub).await;
        assert_eq!(other.language.as_deref(), Some("nl"));
        assert_eq!(other.larger().model, "small");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn paused_generation_restores_completed_tracks_after_restart() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let (mut state, _) = crate::unit_tests::fake_libation_state(root.path());
        let epub = root.path().join("book.epub");
        fs::write(&epub, alignment::build_test_epub())
            .await
            .unwrap();
        let cli = root.path().join("aligner");
        // Gate the second track so pausing must interrupt an unfinished section
        // while preserving the completed first track across a restart.
        fs::write(
            &cli,
            r#"#!/bin/sh
[ "$1" = "align" ] || exit 2
case "$2" in
  *second.wav)
    if [ ! -f "$0.release" ]; then
      printf '%s' "$$" > "$0.started.tmp"
      mv "$0.started.tmp" "$0.started"
      exec sleep 60
    fi;;
esac
printf '%s\n' "$2" >> "$0.calls"
case "$2" in
  *second.wav) text='The river ran fast & cold.';;
  *) text='The meadow was quiet.';;
esac
printf '[{"type":"sentence","text":"%s","startTime":1,"endTime":3}]' "$text" > "$4"
"#,
        )
        .await
        .unwrap();
        fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755))
            .await
            .unwrap();
        let runtime = SyncAddonRuntime {
            cli_path: cli.clone(),
            cli_args: Vec::new(),
            ffmpeg_path: None,
        };
        let tracks = vec![
            SyncTrackInput {
                path: root.path().join("first.wav"),
                title: "Chapter 1: The Meadow".into(),
                duration_seconds: Some(3600.0),
                chapters: Vec::new(),
            },
            SyncTrackInput {
                path: root.path().join("second.wav"),
                title: "Chapter 2: The River".into(),
                duration_seconds: Some(3600.0),
                chapters: Vec::new(),
            },
        ];
        for track in &tracks {
            fs::write(&track.path, b"fixture").await.unwrap();
        }
        let (id, _) =
            create_queued_job(&state, SYNC_GENERATE_JOB_KIND, Some("fixture".into())).await;
        update_job_running(&state, &id).await;
        let generation =
            run_sync_generation(&state, &id, "fixture", &runtime, &epub, &tracks, None);
        let request_pause = async {
            tokio::time::timeout(Duration::from_secs(5), async {
                while !fs::try_exists(cli.with_extension("started")).await.unwrap() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            state
                .jobs
                .write()
                .await
                .get_mut(&id)
                .unwrap()
                .pause_requested = true;
            state.update_manager.sync_queue_changed.notify_waiters();
        };
        let (result, _) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(generation, request_pause)
        })
        .await
        .expect("pause must not wait for the blocked aligner to finish");
        let error = result.unwrap_err();
        assert!(error.downcast_ref::<SyncPaused>().is_some(), "{error:#}");
        assert_eq!(state.jobs.read().await[&id].status, "paused");
        let checkpoint: SyncCheckpoint =
            serde_json::from_slice(&fs::read(sync_checkpoint_path(&state, &id)).await.unwrap())
                .unwrap();
        assert_eq!(checkpoint.completed_scopes, 1);
        assert_eq!(checkpoint.fragments.len(), 1);
        assert_eq!(checkpoint.outcomes.len(), 1);
        // Stand in for edition-only text the first track's run left unmatched;
        // the resumed run must grade with it rather than start from zero.
        let mut edited: serde_json::Value =
            serde_json::from_slice(&fs::read(sync_checkpoint_path(&state, &id)).await.unwrap())
                .unwrap();
        edited["outcomes"][0]["skippedText"] = 34.into();
        fs::write(
            sync_checkpoint_path(&state, &id),
            serde_json::to_vec(&edited).unwrap(),
        )
        .await
        .unwrap();
        let paused_progress = state.jobs.read().await[&id].progress.clone().unwrap();
        assert_eq!(paused_progress.completed, Some(1));
        assert_eq!(paused_progress.fraction, Some(0.49));
        assert!(
            !state
                .sync_dir
                .join(format!("fixture{SYNC_SIDECAR_SUFFIX}"))
                .exists()
        );
        assert_eq!(
            fs::read_to_string(cli.with_extension("calls"))
                .await
                .unwrap()
                .lines()
                .count(),
            1
        );
        let pid: i32 = fs::read_to_string(cli.with_extension("started"))
            .await
            .unwrap()
            .parse()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            // Observe the captured fixture child; never signal unrelated jobs.
            while unsafe { libc::kill(pid, 0) } == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("pausing must stop the alignment process");
        fs::write(cli.with_extension("release"), b"ready")
            .await
            .unwrap();
        state.jobs = Arc::new(RwLock::new(HashMap::new()));
        restore_queue(&state).await.unwrap();
        assert_eq!(state.jobs.read().await[&id].status, "paused");
        state
            .jobs
            .write()
            .await
            .get_mut(&id)
            .unwrap()
            .pause_requested = false;
        update_job_running(&state, &id).await;
        assert_eq!(
            run_sync_generation(&state, &id, "fixture", &runtime, &epub, &tracks, None)
                .await
                .unwrap()
                .fragment_count,
            2
        );
        let calls = fs::read_to_string(cli.with_extension("calls"))
            .await
            .unwrap();
        assert_eq!(
            calls.lines().count(),
            2,
            "the completed first track must not run twice"
        );
        let map: alignment::SyncMap = serde_json::from_slice(
            &fs::read(state.sync_dir.join(format!("fixture{SYNC_SIDECAR_SUFFIX}")))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(map.fragments[0].start_seconds, 1.0);
        assert_eq!(map.fragments[1].start_seconds, 3601.0);
        assert!(!sync_checkpoint_path(&state, &id).exists());
        let identity = probe_sync_map(
            &state.sync_dir.join(format!("fixture{SYNC_SIDECAR_SUFFIX}")),
            true,
        )
        .unwrap()
        .identity;
        let report = sync_report::read_current_report(&state.sync_dir, "fixture", &identity)
            .expect("a finished run grades its own map");
        assert_eq!(report.graded, sync_report::Graded::Run);
        assert_eq!(
            report
                .chapters
                .iter()
                .map(|c| (c.start_seconds, c.end_seconds, c.skipped_text))
                .collect::<Vec<_>>(),
            vec![(0.0, 3600.0, 34), (3600.0, 7200.0, 0)]
        );
        // Only the first sentence of each chapter was aligned; the saved
        // skipped text accounts for the rest of the first.
        assert_eq!(report.chapters[0].text_coverage, 1.0);
        assert!(report.chapters[1].text_coverage < 0.8);
        // Reusing a checkpoint after an EPUB change must start over, even
        // with the same job ID and unchanged audio.
        fs::write(
            sync_checkpoint_path(&state, &id),
            serde_json::to_vec(&checkpoint).unwrap(),
        )
        .await
        .unwrap();
        fs::write(
            &epub,
            alignment::build_test_epub_with_text(
                "<p>The meadow was quiet. Changed text and timing.</p>",
                "<p>The river ran fast &amp; cold.</p>",
            ),
        )
        .await
        .unwrap();
        run_sync_generation(&state, &id, "fixture", &runtime, &epub, &tracks, None)
            .await
            .unwrap();
        assert_eq!(
            fs::read_to_string(cli.with_extension("calls"))
                .await
                .unwrap()
                .lines()
                .count(),
            4
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_or_interrupted_generation_preserves_the_map_and_can_retry() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let (state, _) = crate::unit_tests::fake_libation_state(root.path());
        let epub = root.path().join("book.epub");
        std::fs::write(&epub, alignment::build_test_epub()).unwrap();
        let cli = root.path().join("aligner");
        let runtime = SyncAddonRuntime {
            cli_path: cli.clone(),
            cli_args: Vec::new(),
            ffmpeg_path: None,
        };
        let tracks = vec![SyncTrackInput {
            path: root.path().join("audio.wav"),
            title: "Book".into(),
            duration_seconds: None,
            chapters: Vec::new(),
        }];
        fs::write(&tracks[0].path, b"fixture audio").await.unwrap();
        fs::create_dir_all(&state.sync_dir).await.unwrap();
        let destination = state.sync_dir.join(format!("fixture{SYNC_SIDECAR_SUFFIX}"));
        let original = br#"{"version":2,"fragments":[{"startSeconds":20,"endSeconds":25,"href":"text/ch1.xhtml","text":"Previous usable timing."}]}"#;
        fs::write(&destination, original).await.unwrap();
        for script in [
            "#!/bin/sh\nexit 7\n",
            "#!/bin/sh\n: > \"$0.started\"\nexec sleep 60\n",
        ] {
            std::fs::write(&cli, script).unwrap();
            std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
            let job = create_job(&state, "sync-fixture").await;
            let result = tokio::time::timeout(
                Duration::from_millis(500),
                run_sync_generation(&state, &job, "fixture", &runtime, &epub, &tracks, None),
            )
            .await;
            if script.contains("sleep") {
                assert!(result.is_err());
                assert!(root.path().join("aligner.started").exists());
            } else {
                assert!(result.unwrap().is_err());
            }
            assert_eq!(fs::read(&destination).await.unwrap(), original);
        }
        std::fs::write(&cli, "#!/bin/sh\nprintf '%s' '[{\"type\":\"sentence\",\"text\":\"The meadow was quiet.\",\"startTime\":1,\"endTime\":3}]' > \"$4\"\n").unwrap();
        let job = create_job(&state, "sync-fixture-retry").await;
        assert_eq!(
            run_sync_generation(&state, &job, "fixture", &runtime, &epub, &tracks, None)
                .await
                .unwrap()
                .fragment_count,
            1
        );
        let published: alignment::SyncMap =
            serde_json::from_slice(&fs::read(&destination).await.unwrap()).unwrap();
        assert_eq!(published.fragments[0].start_seconds, 1.0);
        assert_eq!(published.fragments[0].text, "The meadow was quiet.");
    }

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

    #[cfg(unix)]
    #[tokio::test]
    async fn forced_alignment_uses_the_book_language_instead_of_guessing() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let (state, _) = crate::unit_tests::fake_libation_state(root.path());
        let job_id = create_job(&state, "sync-generate").await;
        let cli = root.path().join("aligner");
        // Echogarden's own guess for a short passage can be a language eSpeak
        // cannot voice; only an explicit language avoids that failure.
        std::fs::write(
            &cli,
            r#"#!/bin/sh
case " $* " in
  *" --language=en "*) ;;
  *) echo "Error: Couldn't parse language identifier 'tlh'." >&2; exit 1;;
esac
printf '[{"type":"sentence","text":"Kaladin ran.","startTime":0,"endTime":2}]' > "$4"
"#,
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        let audio = root.path().join("chapter.wav");
        std::fs::write(&audio, "").unwrap();
        let transcript = alignment::build_transcript(&[alignment::SpineSection {
            href: "a.html".into(),
            text: "Kaladin ran.".into(),
        }]);
        let recognition = RecognitionSettings::for_language(Some("eng"));
        let aligner = Aligner {
            state: &state,
            job_id: &job_id,
            cli_path: &cli,
            cli_args: &[],
            ffmpeg_path: None,
            temp_dir: root.path(),
            recognition: &recognition,
            heard: Default::default(),
        };
        let fragments = aligner
            .align_pass(&audio, &transcript, 0.0, 0, 0, "Chapter 55", &[])
            .await
            .unwrap();
        assert_eq!(recognition.model, "tiny.en");
        assert_eq!(fragments.len(), 1);
        assert_eq!(fragments[0].text, "Kaladin ran.");
    }

    fn chapter(title: &str, start_seconds: f64, end_seconds: Option<f64>) -> SyncChapterInput {
        SyncChapterInput {
            title: title.to_string(),
            start_seconds,
            end_seconds,
        }
    }

    fn text_sections(count: usize) -> Vec<alignment::SpineSection> {
        (0..count)
            .map(|index| alignment::SpineSection {
                href: format!("{index}.xhtml"),
                text: "Chapter text.".into(),
            })
            .collect()
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

        let scopes = chapter_alignment_scopes(&track, &toc, &text_sections(3), true).unwrap();

        assert_eq!(scopes.len(), 2);
        assert_eq!(scopes[0].section_range, 1..2);
        assert_eq!(scopes[0].audio_range, Some((5.0, 45.0)));
        assert_eq!(scopes[0].time_offset_seconds, 5.0);
        assert_eq!(scopes[1].section_range, 2..3);
        assert_eq!(scopes[1].audio_range, Some((45.0, 95.0)));
        assert_eq!(scopes[1].time_offset_seconds, 45.0);
    }

    #[test]
    fn split_chapter_scope_includes_every_audio_part() {
        let track = SyncTrackInput {
            path: PathBuf::from("book.m4b"),
            title: "Book".into(),
            duration_seconds: Some(120.0),
            chapters: vec![
                chapter("Chapter 1A", 0.0, Some(30.0)),
                chapter("Chapter 1B", 30.0, Some(70.0)),
                chapter("Chapter 2", 70.0, Some(120.0)),
            ],
        };
        let toc = ["Chapter 1", "Chapter 2"]
            .iter()
            .enumerate()
            .map(|(spine_index, title)| alignment::TocEntry {
                title: title.to_string(),
                spine_index,
            })
            .collect::<Vec<_>>();
        let scopes = chapter_alignment_scopes(&track, &toc, &text_sections(2), true).unwrap();
        assert_eq!(scopes.len(), 2);
        assert_eq!(scopes[0].audio_range, Some((0.0, 70.0)));
        assert_eq!(scopes[1].audio_range, Some((70.0, 120.0)));
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

        assert!(chapter_alignment_scopes(&track, &toc, &text_sections(2), false).is_err());
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

        assert!(chapter_alignment_scopes(&track, &toc, &text_sections(2), true).is_err());
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
    fn omitted_audio_is_uncertain_but_matched_picture_intervals_are_preserved() {
        let track = SyncTrackInput {
            path: "book.m4b".into(),
            title: "Book".into(),
            duration_seconds: Some(100.0),
            chapters: Vec::new(),
        };
        let mut scopes = [(10.0, 30.0), (30.0, 40.0), (60.0, 80.0)]
            .into_iter()
            .enumerate()
            .map(|(i, range)| SyncAlignmentScope {
                track_index: 0,
                section_range: i..i + 1,
                audio_range: Some(range),
                time_offset_seconds: range.0,
                label: "Chapter or picture".into(),
            })
            .collect::<Vec<_>>();
        let gaps = unscoped_audio_gaps(&track, &scopes);
        assert_eq!(
            gaps.iter()
                .map(|g| (g.start_seconds, g.end_seconds))
                .collect::<Vec<_>>(),
            vec![(0.0, 10.0), (40.0, 60.0), (80.0, 100.0)]
        );
        scopes[0].audio_range = None;
        assert!(unscoped_audio_gaps(&track, &scopes).is_empty());
    }

    #[test]
    #[ignore = "manual real-book probe"]
    fn manual_real_book_scope_probe() {
        let epub_path = PathBuf::from(std::env::var_os("OPERALIBRE_PROBE_EPUB").unwrap());
        let epub = alignment::parse_epub_file(&epub_path).unwrap();
        let track = if let Some(chapters_path) = std::env::var_os("OPERALIBRE_PROBE_CHAPTERS_JSON")
        {
            let value: serde_json::Value =
                serde_json::from_slice(&std::fs::read(chapters_path).unwrap()).unwrap();
            let chapters = value["chapters"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| SyncChapterInput {
                    title: entry["tags"]["title"].as_str().unwrap().to_string(),
                    start_seconds: entry["start_time"].as_str().unwrap().parse().unwrap(),
                    end_seconds: Some(entry["end_time"].as_str().unwrap().parse().unwrap()),
                })
                .collect::<Vec<_>>();
            SyncTrackInput {
                path: PathBuf::from("probe.m4a"),
                title: "Book".into(),
                duration_seconds: chapters.last().and_then(|chapter| chapter.end_seconds),
                chapters,
            }
        } else {
            let audio_path = PathBuf::from(std::env::var_os("OPERALIBRE_PROBE_AUDIO").unwrap());
            let metadata = read_track_metadata(&audio_path);
            SyncTrackInput {
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
            }
        };

        if let Some(path) = std::env::var_os("OPERALIBRE_PROBE_INPUT") {
            let input = serde_json::json!({
                "toc": epub.toc.iter().map(|e| serde_json::json!({"title": e.title, "spine": e.spine_index})).collect::<Vec<_>>(),
                "sections": epub.sections.iter().map(|s| serde_json::json!({"href": s.href, "text": s.text})).collect::<Vec<_>>(),
                "chapters": track.chapters.iter().map(|c| serde_json::json!({"title": c.title, "start": c.start_seconds, "end": c.end_seconds})).collect::<Vec<_>>(),
            });
            std::fs::write(path, serde_json::to_vec(&input).unwrap()).unwrap();
        }
        let result = chapter_alignment_scopes(&track, &epub.toc, &epub.sections, true);
        if result.is_err() {
            let mut ordered_toc = epub.toc.iter().collect::<Vec<_>>();
            ordered_toc.sort_by_key(|entry| entry.spine_index);
            let targets = track
                .chapters
                .iter()
                .map(|chapter| alignment::parse_label(&chapter.title))
                .collect::<Vec<_>>();
            let items = ordered_toc
                .iter()
                .map(|entry| alignment::parse_label(&entry.title))
                .collect::<Vec<_>>();
            let matched = alignment::match_in_order(&targets, &items);
            for (index, toc_index) in matched.iter().enumerate() {
                if toc_index.is_none() {
                    println!("unmatched audio {index}: {}", track.chapters[index].title);
                }
            }
        }
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
            if let Some(output_path) = std::env::var_os("OPERALIBRE_PROBE_MANIFEST") {
                let manifest = scopes
                    .iter()
                    .enumerate()
                    .map(|(index, scope)| {
                        let transcript = scope_transcript(&epub, scope);
                        serde_json::json!({
                            "index": index,
                            "label": scope.label,
                            "audioRange": scope.audio_range,
                            "sectionRange": [scope.section_range.start, scope.section_range.end],
                            "text": transcript.text,
                            "mappedText": alignment::build_transcript(&epub.sections[scope.section_range.clone()]).text,
                            "hrefs": epub.sections[scope.section_range.clone()]
                                .iter().map(|section| &section.href).collect::<Vec<_>>(),
                        })
                    })
                    .collect::<Vec<_>>();
                std::fs::write(output_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
            }
            for (index, scope) in scopes
                .iter()
                .enumerate()
                .filter(|(index, _)| *index < 5 || (98..=103).contains(index))
            {
                println!(
                    "{index} {} {:?} {:?}",
                    scope.label, scope.audio_range, scope.section_range
                );
            }
            if let Some(output_path) = std::env::var_os("OPERALIBRE_PROBE_TRANSCRIPT") {
                let selected = std::env::var("OPERALIBRE_PROBE_SCOPE")
                    .ok()
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(2);
                let scope = &scopes[selected];
                let transcript = scope_transcript(&epub, scope);
                std::fs::write(output_path, transcript.text).unwrap();
                println!(
                    "selected_scope={selected} label={} audio={:?} sections={:?}",
                    scope.label, scope.audio_range, scope.section_range
                );
            }
        } else {
            panic!("Could not establish chapter scopes for the supplied book");
        }
    }

    /// Opt-in real audio exercise of the production aligner. Writes only to
    /// the supplied test directory; existing per-scope results allow resume.
    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "manual real-book alignment probe"]
    async fn manual_real_book_alignment_probe() {
        let epub_path = PathBuf::from(std::env::var_os("OPERALIBRE_PROBE_EPUB").unwrap());
        let audio_path = PathBuf::from(std::env::var_os("OPERALIBRE_PROBE_AUDIO").unwrap());
        let cli = PathBuf::from(std::env::var_os("OPERALIBRE_PROBE_CLI").unwrap());
        let output = PathBuf::from(std::env::var_os("OPERALIBRE_PROBE_OUTPUT").unwrap());
        let ffmpeg = PathBuf::from(
            std::env::var_os("OPERALIBRE_PROBE_FFMPEG").unwrap_or_else(|| "ffmpeg".into()),
        );
        let selected = std::env::var("OPERALIBRE_PROBE_SCOPES").ok().map(|value| {
            value
                .split(',')
                .map(|index| index.parse::<usize>().unwrap())
                .collect::<Vec<_>>()
        });
        let epub = alignment::parse_epub_file(&epub_path).unwrap();
        let metadata = read_track_metadata(&audio_path);
        let mut track = SyncTrackInput {
            path: audio_path,
            title: metadata.title.unwrap_or_else(|| "Book".into()),
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
        // Portable private fixtures retain original chapter metadata while
        // storing only the preselected audio windows. Production is unchanged.
        if let Some(path) = std::env::var_os("OPERALIBRE_PROBE_CLIP_METADATA") {
            let input: serde_json::Value =
                serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            track.duration_seconds = input["audioDurationSeconds"].as_f64();
            track.chapters = input["chapters"]
                .as_array()
                .unwrap()
                .iter()
                .map(|chapter| SyncChapterInput {
                    title: chapter["title"].as_str().unwrap().to_string(),
                    start_seconds: chapter["start"].as_f64().unwrap(),
                    end_seconds: chapter["end"].as_f64(),
                })
                .collect();
        }
        #[derive(serde::Deserialize)]
        struct ProbeClip {
            path: PathBuf,
            start: f64,
            end: f64,
        }
        let clips: std::collections::HashMap<usize, ProbeClip> =
            std::env::var("OPERALIBRE_PROBE_CLIPS")
                .map(|value| serde_json::from_str(&value).unwrap())
                .unwrap_or_default();
        let scopes = chapter_alignment_scopes(&track, &epub.toc, &epub.sections, true).unwrap();
        let samples: std::collections::HashMap<usize, (f64, f64)> =
            std::env::var("OPERALIBRE_PROBE_SAMPLE_RANGES")
                .map(|value| serde_json::from_str(&value).unwrap())
                .unwrap_or_default();
        if let Some(selected) = &selected {
            assert!(!selected.is_empty(), "No scopes selected");
            assert!(
                selected.iter().all(|index| *index < scopes.len()),
                "Unknown scope selected"
            );
        }
        std::fs::create_dir_all(&output).unwrap();
        let root = tempfile::tempdir().unwrap();
        let (state, _) = crate::unit_tests::fake_libation_state(root.path());
        let job_id = create_job(&state, "sync-probe").await;
        let recognition = RecognitionSettings::for_language(epub.language.as_deref());
        let aligner = Aligner {
            state: &state,
            job_id: &job_id,
            cli_path: &cli,
            cli_args: &[],
            ffmpeg_path: Some(&ffmpeg),
            temp_dir: root.path(),
            recognition: &recognition,
            heard: Default::default(),
        };
        for (index, scope) in scopes.iter().enumerate() {
            if selected
                .as_ref()
                .is_some_and(|indices| !indices.contains(&index))
            {
                continue;
            }
            let path = output.join(format!("scope-{index}.json"));
            if path.exists() {
                continue;
            }
            let mut scope = scope.clone();
            if let Some(&(start, end)) = samples.get(&index) {
                let (a, b) = scope.audio_range.unwrap();
                assert!(
                    start.is_finite() && end.is_finite() && a <= start && start < end && end <= b
                );
                scope.audio_range = Some((start, end));
                scope.time_offset_seconds = start;
            }
            let clip_track;
            let track = if let Some(clip) = clips.get(&index) {
                assert_eq!(scope.audio_range, Some((clip.start, clip.end)));
                scope.audio_range = Some((0.0, clip.end - clip.start));
                scope.time_offset_seconds = clip.start;
                clip_track = SyncTrackInput {
                    path: clip.path.clone(),
                    title: track.title.clone(),
                    duration_seconds: Some(clip.end - clip.start),
                    chapters: Vec::new(),
                };
                &clip_track
            } else {
                &track
            };
            let scope = &scope;
            let transcript = scope_transcript(&epub, scope);
            let progress = ScopeProgress {
                base: 0.0,
                span: 1.0,
                step: scope.label.clone(),
                completed: index,
                total: scopes.len(),
            };
            let result = if transcript.text.trim().is_empty() {
                ScopeAlignment::default()
            } else {
                aligner
                    .align_scope(scope, track, &transcript, index, &progress)
                    .await
                    .unwrap()
            };
            let map = alignment::SyncMap {
                version: alignment::SYNC_MAP_VERSION,
                mapping_revision: alignment::MAPPING_REVISION,
                generator: Some("echogarden".into()),
                generated_at: None,
                precision: Some(alignment::PRECISION_SENTENCE.into()),
                fragments: result.fragments,
                recovery_gaps: result.recovery_gaps,
            };
            std::fs::write(&path, serde_json::to_vec(&map).unwrap()).unwrap();
            println!(
                "scope={index} label={} audio={:?} fragments={}",
                scope.label,
                scope.audio_range,
                map.fragments.len()
            );
        }
        println!("{}", state.jobs.read().await.get(&job_id).unwrap().output);
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
            format!("Sentence {index} word two three four five{index} six{index}.")
        }

        fn narrated_start(index: usize) -> f64 {
            HEADING_SECONDS + index as f64 * SENTENCE_SECONDS
        }

        /// One `time word` line per spoken word: an unscripted heading, then
        /// every sentence's eight words half a second apart. Sentences in
        /// `garbled` are spoken as noise the recognizer cannot place.
        fn narration(count: usize, garbled: &[std::ops::Range<usize>]) -> String {
            let mut lines = Vec::new();
            for (index, word) in "this is a narrated heading for the chapter"
                .split_whitespace()
                .enumerate()
            {
                lines.push(format!("{:.3} {word}", index as f64 * 0.5));
            }
            for index in 0..count {
                for (position, word) in sentence(index).split_whitespace().enumerate() {
                    let word = if garbled.iter().any(|range| range.contains(&index)) {
                        "blah"
                    } else {
                        word.trim_end_matches('.')
                    };
                    lines.push(format!(
                        "{:.3} {word}",
                        narrated_start(index) + position as f64 * 0.5
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
start=0; duration=0; previous=""
for argument in "$@"; do
  case "$previous" in -ss) start="$argument";; -t) duration="$argument";; esac
  previous="$argument"
done
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

        async fn align_fake_book(
            count: usize,
            garbled: std::ops::Range<usize>,
            unspoken_after: Option<usize>,
            additional_after: Option<usize>,
        ) -> (Vec<alignment::SyncFragment>, String) {
            align_fake_book_with_outages(count, &[garbled], unspoken_after, additional_after).await
        }

        async fn align_fake_book_with_outages(
            count: usize,
            garbled: &[std::ops::Range<usize>],
            unspoken_after: Option<usize>,
            additional_after: Option<usize>,
        ) -> (Vec<alignment::SyncFragment>, String) {
            align_fake_book_with_settings(
                count,
                garbled,
                unspoken_after,
                additional_after,
                0.0,
                None,
                false,
            )
            .await
        }

        async fn align_fake_book_with_settings(
            count: usize,
            garbled: &[std::ops::Range<usize>],
            unspoken_after: Option<usize>,
            additional_after: Option<usize>,
            book_offset: f64,
            empty_sentence: Option<usize>,
            crashing_retry_model: bool,
        ) -> (Vec<alignment::SyncFragment>, String) {
            let root = tempfile::tempdir().unwrap();
            let (state, _) = crate::unit_tests::fake_libation_state(root.path());
            let job_id = create_job(&state, "sync-generate").await;

            let narration_path = root.path().join("narration.txt");
            let mut speech = narration(count, garbled);
            if let Some(index) = additional_after {
                let start = narrated_start(index + 1);
                speech = speech
                    .lines()
                    .map(|line| {
                        let (time, word) = line.split_once(' ').unwrap();
                        let time: f64 = time.parse().unwrap();
                        format!(
                            "{:.3} {word}",
                            time + if time >= start { SENTENCE_SECONDS } else { 0.0 }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                for (offset, word) in "this drawing shows the river around the valley"
                    .split_whitespace()
                    .enumerate()
                {
                    speech.push_str(&format!("\n{:.3} {word}", start + offset as f64 * 0.5));
                }
                let mut lines = speech.lines().collect::<Vec<_>>();
                lines.sort_by(|left, right| {
                    left.split_once(' ')
                        .unwrap()
                        .0
                        .parse::<f64>()
                        .unwrap()
                        .total_cmp(&right.split_once(' ').unwrap().0.parse::<f64>().unwrap())
                });
                speech = lines.join("\n") + "\n";
            }
            std::fs::write(&narration_path, speech).unwrap();
            let ffmpeg = root.path().join("ffmpeg");
            write_script(&ffmpeg, FAKE_FFMPEG);
            let cli = root.path().join("echogarden");
            let script =
                FAKE_ECHOGARDEN.replace("NARRATION_PATH", &narration_path.display().to_string());
            let script = if let Some(index) = empty_sentence {
                script.replace("  align)\n", &format!("  align)\n    if grep -q '^Sentence {index} ' \"$3\"; then printf '[]' > \"$4\"; exit 0; fi\n"))
            } else {
                script
            };
            // Echogarden's launcher exits 0 without output when its worker
            // segfaults, as the larger whisper model does on some audio.
            let script = if crashing_retry_model {
                script.replace(
                    "command=\"$1\"",
                    "case \" $* \" in *\" --whisper.model=base.en \"*) exit 0;; esac\ncommand=\"$1\"",
                )
            } else {
                script
            };
            write_script(&cli, &script);

            let book_sentence = |index| {
                let spoken = sentence(index);
                if unspoken_after == Some(index) {
                    format!("{spoken} This extra paragraph exists only in the printed edition.")
                } else {
                    spoken
                }
            };
            let half = count / 2;
            let sections = vec![
                alignment::SpineSection {
                    href: "a.html".into(),
                    text: (0..half).map(book_sentence).collect::<Vec<_>>().join(" "),
                },
                alignment::SpineSection {
                    href: "b.html".into(),
                    text: (half..count)
                        .map(book_sentence)
                        .collect::<Vec<_>>()
                        .join(" "),
                },
            ];
            let transcript = alignment::build_transcript(&sections);
            let track = SyncTrackInput {
                path: root.path().join("book.m4b"),
                title: "Book".into(),
                // A short tail: the fake aligner spreads silence evenly over
                // the last segment's sentences, which a real one does not.
                duration_seconds: Some(
                    narrated_start(count)
                        + 0.5
                        + if additional_after.is_some() {
                            SENTENCE_SECONDS
                        } else {
                            0.0
                        },
                ),
                chapters: Vec::new(),
            };
            std::fs::write(
                &track.path,
                format!("0 {}\n", track.duration_seconds.unwrap()),
            )
            .unwrap();
            let scope = SyncAlignmentScope {
                track_index: 0,
                section_range: 0..2,
                audio_range: None,
                time_offset_seconds: book_offset,
                label: "Book".into(),
            };
            let recognition = RecognitionSettings::for_language(Some("en"));
            let temp_dir = tempfile::tempdir().unwrap();
            let aligner = Aligner {
                state: &state,
                job_id: &job_id,
                cli_path: &cli,
                cli_args: &[],
                ffmpeg_path: Some(&ffmpeg),
                temp_dir: temp_dir.path(),
                recognition: &recognition,
                heard: Default::default(),
            };

            let progress = ScopeProgress {
                base: 0.1,
                span: 0.8,
                step: "Aligning the narration to the text".into(),
                completed: 0,
                total: 1,
            };
            // Window recovery can find no timing; scope generation rejects that
            // result, while these tests inspect the gaps it recovered through.
            let result = aligner
                .align_windowed(
                    &scope,
                    &track,
                    &transcript,
                    0,
                    &ffmpeg,
                    0.0,
                    track.duration_seconds.unwrap(),
                    &progress,
                )
                .await
                .unwrap();
            // Masked edition-only text is reported so it does not lower the grade.
            assert_eq!(
                result.skipped_text,
                if unspoken_after.is_some() {
                    sync_report::text_units(
                        "This extra paragraph exists only in the printed edition.",
                    )
                } else {
                    0
                }
            );
            for gap in &result.recovery_gaps {
                assert!(gap.start_seconds.is_finite() && gap.end_seconds.is_finite());
                assert!(gap.start_seconds < gap.end_seconds);
                assert!(
                    result
                        .fragments
                        .iter()
                        .all(|fragment| fragment.end_seconds <= gap.start_seconds + 1e-6
                            || fragment.start_seconds >= gap.end_seconds - 1e-6)
                );
            }
            for outage in garbled.iter().filter(|range| !range.is_empty()) {
                let during = book_offset + narrated_start((outage.start + outage.end) / 2);
                assert!(
                    result
                        .recovery_gaps
                        .iter()
                        .any(|gap| gap.start_seconds <= during && during < gap.end_seconds),
                    "outage {outage:?} has no recovery metadata: {:?}",
                    result.recovery_gaps
                );
            }
            let job = state.jobs.read().await.get(&job_id).unwrap().clone();
            // Every window reports where it got to, so the bar reaches the end
            // of this scope's share rather than sitting still until the job is
            // over.
            if track.duration_seconds.unwrap() > MAX_SINGLE_PASS_SECONDS {
                let reported = job
                    .progress
                    .and_then(|progress| progress.fraction)
                    .expect("windowed alignment reports progress");
                assert!(
                    reported > 0.85 && reported <= 0.9 + 1e-6,
                    "progress ended at {reported}, not near the end of the scope's span"
                );
            }
            (result.fragments, job.output)
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
            let (fragments, output) = align_fake_book(count, 0..0, None, None).await;

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
        async fn edition_only_sentences_are_skipped_in_short_middle_and_final_windows() {
            for (count, unspoken_after) in [(40, 10), (200, 20), (200, 51), (200, 180)] {
                let (fragments, output) =
                    align_fake_book(count, 0..0, Some(unspoken_after), None).await;
                assert_eq!(fragments.len(), count, "{output}");
                assert!(output.contains("unspoken text passage"), "{output}");
                assert_monotonic(&fragments);
                for (index, fragment) in fragments.iter().enumerate() {
                    assert_eq!(fragment.text, sentence(index));
                    // Single-pass fake alignment includes the narrated heading;
                    // the windowed path also removes that heading's lead-in.
                    if count > 40 {
                        assert!(
                            (fragment.start_seconds - narrated_start(index)).abs() < 0.75,
                            "sentence {index}: {fragment:?}"
                        );
                    }
                }
            }
        }

        #[tokio::test]
        async fn a_stretch_without_anchors_stays_unmapped_and_recovers_at_the_first_clear_sentence()
        {
            let count = 400;
            let (fragments, output) = align_fake_book(count, 60..190, None, None).await;

            assert_eq!(fragments.len(), count - 130);
            assert_monotonic(&fragments);
            assert!(output.contains("without a recognized anchor"), "{output}");
            assert!(output.contains("Recovered at 772.0 s"), "{output}");
            // The first clear sentence recovers immediately, not many windows
            // later. No guessed sentence is emitted during the outage.
            for (index, fragment) in (0..60).chain(190..count).zip(&fragments) {
                assert_eq!(fragment.text, sentence(index));
                let expected = narrated_start(index);
                assert!(
                    (fragment.start_seconds - expected).abs() < 0.75,
                    "sentence {index} starts at {:.2}, narrated at {expected:.2}",
                    fragment.start_seconds
                );
            }
        }

        #[tokio::test]
        async fn a_crashing_retry_model_falls_back_instead_of_failing_the_book() {
            let count = 400;
            let outage = 60..190;
            let (fragments, output) = align_fake_book_with_settings(
                count,
                std::slice::from_ref(&outage),
                None,
                None,
                0.0,
                None,
                true,
            )
            .await;

            assert!(
                output.contains("Continuing without a failed recognition retry"),
                "{output}"
            );
            assert_eq!(fragments.len(), count - 130, "{output}");
            assert_monotonic(&fragments);
            for (index, fragment) in (0..60).chain(190..count).zip(&fragments) {
                assert_eq!(fragment.text, sentence(index));
                assert!(
                    (fragment.start_seconds - narrated_start(index)).abs() < 0.75,
                    "{index}: {fragment:?}"
                );
            }
        }

        #[tokio::test]
        async fn recovery_handles_bad_openings_and_endings_without_guessing() {
            for (count, outage) in [(40, 0..15), (40, 0..40), (40, 25..40), (200, 130..200)] {
                let (fragments, output) = align_fake_book(count, outage.clone(), None, None).await;
                assert_monotonic(&fragments);
                let expected = (0..count)
                    .filter(|index| !outage.contains(index))
                    .collect::<Vec<_>>();
                assert_eq!(fragments.len(), expected.len(), "{output}");
                for (index, fragment) in expected.into_iter().zip(&fragments) {
                    assert_eq!(fragment.text, sentence(index));
                    assert!(
                        (fragment.start_seconds - narrated_start(index)).abs() < 0.75,
                        "{index}: {fragment:?}"
                    );
                }
            }
        }

        #[tokio::test]
        async fn recovery_can_lose_and_regain_alignment_more_than_once() {
            let outages = [40..165, 225..350];
            let (fragments, output) = align_fake_book_with_outages(400, &outages, None, None).await;
            assert_monotonic(&fragments);
            let expected = (0..400)
                .filter(|index| !outages.iter().any(|range| range.contains(index)))
                .collect::<Vec<_>>();
            assert_eq!(fragments.len(), expected.len(), "{output}");
            assert!(output.matches("Recovered at").count() >= 2, "{output}");
            for (index, fragment) in expected.into_iter().zip(&fragments) {
                assert_eq!(fragment.text, sentence(index));
                assert!(
                    (fragment.start_seconds - narrated_start(index)).abs() < 0.75,
                    "{index}: {fragment:?}"
                );
            }
        }

        #[tokio::test]
        async fn recovery_requires_forced_timing_and_keeps_book_offsets() {
            let outage = 0..15;
            let (fragments, output) = align_fake_book_with_settings(
                40,
                std::slice::from_ref(&outage),
                None,
                None,
                1000.0,
                Some(15),
                false,
            )
            .await;
            assert_eq!(fragments.len(), 24, "{output}");
            assert_eq!(fragments[0].text, sentence(16));
            assert!((fragments[0].start_seconds - 1076.0).abs() < 0.01);
            assert!(output.contains("Recovered at 1076.0 s"), "{output}");
            assert!(!output.contains("Recovered at 1072.0 s"), "{output}");
            assert_monotonic(&fragments);
        }

        #[tokio::test]
        async fn different_editions_can_add_text_and_narration_in_the_same_scope() {
            let (fragments, output) = align_fake_book(200, 0..0, Some(60), Some(130)).await;
            assert_eq!(fragments.len(), 200, "{output}");
            assert_monotonic(&fragments);
            for (index, fragment) in fragments.iter().enumerate() {
                assert_eq!(fragment.text, sentence(index));
                let expected =
                    narrated_start(index) + if index > 130 { SENTENCE_SECONDS } else { 0.0 };
                assert!(
                    (fragment.start_seconds - expected).abs() < 0.75,
                    "{fragment:?}: expected {expected}"
                );
            }
        }

        #[tokio::test]
        async fn additional_narration_is_unmapped_in_short_middle_and_final_windows() {
            for (count, after) in [
                (40, 10),
                (40, 39),
                (200, 20),
                (200, 51),
                (200, 180),
                (200, 199),
            ] {
                let (fragments, output) = align_fake_book(count, 0..0, None, Some(after)).await;
                assert_eq!(fragments.len(), count, "{output}");
                assert!(output.contains("additional narration passage"), "{output}");
                assert_monotonic(&fragments);
                for (index, fragment) in fragments.iter().enumerate() {
                    assert_eq!(fragment.text, sentence(index));
                    if count > 40 {
                        let expected = narrated_start(index)
                            + if index > after { SENTENCE_SECONDS } else { 0.0 };
                        assert!(
                            (fragment.start_seconds - expected).abs() < 0.75,
                            "sentence {index}: {fragment:?}, expected {expected}"
                        );
                    }
                }
            }
        }

        #[tokio::test]
        async fn shorter_recognition_recovers_missing_speech_and_keeps_absolute_window_times() {
            let root = tempfile::tempdir().unwrap();
            let (state, _) = crate::unit_tests::fake_libation_state(root.path());
            let job_id = create_job(&state, "sync-generate").await;
            let narration = root.path().join("narration.txt");
            std::fs::write(
                &narration,
                (0..120)
                    .map(|index| format!("{index} word{index}\n"))
                    .collect::<String>(),
            )
            .unwrap();
            let ffmpeg = root.path().join("ffmpeg");
            write_script(&ffmpeg, FAKE_FFMPEG);
            let cli = root.path().join("echogarden");
            write_script(
                &cli,
                &FAKE_ECHOGARDEN
                    .replace("NARRATION_PATH", &narration.display().to_string())
                    .replace(
                        "if (t >= s && t < s + d)",
                        "if (t >= s && t < s + d && !(d > 90 && t >= 30 && t < 50))",
                    ),
            );
            let audio = root.path().join("input.wav");
            std::fs::write(&audio, "0 120\n").unwrap();
            let recognition = RecognitionSettings::for_language(Some("en"));
            let aligner = Aligner {
                state: &state,
                job_id: &job_id,
                cli_path: &cli,
                cli_args: &[],
                ffmpeg_path: Some(&ffmpeg),
                temp_dir: root.path(),
                recognition: &recognition,
                heard: Default::default(),
            };
            let text = (0..120)
                .map(|index| format!("word{index}"))
                .collect::<Vec<_>>()
                .join(" ");
            let recovered = aligner
                .transcribe_checked(&audio, 0, 1, &text, 120.0)
                .await
                .unwrap();
            assert_eq!(recovered.len(), 120);
            for (index, word) in recovered.iter().enumerate() {
                assert_eq!(word.text, format!("word{index}"));
                assert!((word.start_time - index as f64).abs() < 0.001);
            }
        }
    }

    /// Whole-book runs that survive a failing chapter, and re-runs of chosen
    /// chapters spliced into the served map. Each chapter is one hour-long
    /// track holding a single sentence.
    #[cfg(unix)]
    mod chapters {
        use super::*;
        use std::os::unix::fs::PermissionsExt;
        use sync_report::{ChapterStatus, Grade};

        /// Times each chapter's sentence from `$0.start` seconds (1 unless
        /// set), fails tracks listed in `$0.fail`, and holds tracks listed in
        /// `$0.gate` until `$0.release` exists, or with `$0.gate-repeats`,
        /// only once they have run before. Tracks in `$0.crash` exit cleanly
        /// without a result, as a crashed worker does; with `$0.once`, only
        /// the first time.
        const FAKE_ALIGNER: &str = r#"#!/bin/sh
[ "$1" = "align" ] || exit 2
track=$(basename "$2")
if [ -f "$0.gate" ] && grep -qxF "$track" "$0.gate" && [ ! -f "$0.release" ] \
  && { [ ! -f "$0.gate-repeats" ] || grep -qxF "$track" "$0.calls"; }; then
  printf '%s' "$$" > "$0.started.tmp"
  mv "$0.started.tmp" "$0.started"
  exec sleep 60
fi
printf '%s\n' "$track" >> "$0.calls"
if [ -f "$0.fail" ] && grep -qxF "$track" "$0.fail"; then
  printf 'worker crashed\nsegfault in the recognizer\n' >&2
  exit 3
fi
if [ -f "$0.crash" ] && grep -qxF "$track" "$0.crash"; then
  if [ -f "$0.once" ]; then
    { grep -vxF "$track" "$0.crash" || true; } > "$0.crash.tmp"
    mv "$0.crash.tmp" "$0.crash"
  fi
  exit 0
fi
if [ -f "$0.empty" ] && grep -qxF "$track" "$0.empty"; then
  printf '[]' > "$4"
  exit 0
fi
start=1
[ -f "$0.start" ] && start=$(cat "$0.start")
printf '[{"type":"sentence","text":"%s","startTime":%s,"endTime":%s}]' "$(cat "$3")" "$start" "$((start + 2))" > "$4"
"#;

        struct ChapterBook {
            _root: tempfile::TempDir,
            state: AppState,
            epub: PathBuf,
            tracks: Vec<SyncTrackInput>,
            runtime: SyncAddonRuntime,
        }

        impl ChapterBook {
            fn new(count: usize) -> Self {
                let root = tempfile::tempdir().unwrap();
                let (state, _) = crate::unit_tests::fake_libation_state(root.path());
                let titles = (1..=count)
                    .map(|n| format!("Chapter {n}"))
                    .collect::<Vec<_>>();
                let bodies = (1..=count)
                    .map(|n| format!("<p>Words of chapter {n}.</p>"))
                    .collect::<Vec<_>>();
                let chapters = titles
                    .iter()
                    .zip(&bodies)
                    .map(|(title, body)| (title.as_str(), body.as_str()))
                    .collect::<Vec<_>>();
                let epub = root.path().join("book.epub");
                std::fs::write(&epub, alignment::build_test_epub_with_chapters(&chapters)).unwrap();
                let tracks = titles
                    .iter()
                    .enumerate()
                    .map(|(index, title)| SyncTrackInput {
                        path: root.path().join(format!("{}.wav", index + 1)),
                        title: title.clone(),
                        duration_seconds: Some(3600.0),
                        chapters: Vec::new(),
                    })
                    .collect::<Vec<_>>();
                for track in &tracks {
                    std::fs::write(&track.path, b"fixture").unwrap();
                }
                let cli = root.path().join("aligner");
                std::fs::write(&cli, FAKE_ALIGNER).unwrap();
                std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
                std::fs::create_dir_all(&state.sync_dir).unwrap();
                Self {
                    _root: root,
                    state,
                    epub,
                    tracks,
                    runtime: SyncAddonRuntime {
                        cli_path: cli,
                        cli_args: Vec::new(),
                        ffmpeg_path: None,
                    },
                }
            }

            fn control(&self, name: &str, value: &str) {
                std::fs::write(self.runtime.cli_path.with_extension(name), value).unwrap();
            }

            fn calls(&self) -> Vec<String> {
                std::fs::read_to_string(self.runtime.cli_path.with_extension("calls"))
                    .unwrap_or_default()
                    .lines()
                    .map(str::to_string)
                    .collect()
            }

            async fn run_job(
                &self,
                job: &str,
                chapters: Option<&[usize]>,
            ) -> anyhow::Result<SyncGenerated> {
                run_sync_generation(
                    &self.state,
                    job,
                    "fixture",
                    &self.runtime,
                    &self.epub,
                    &self.tracks,
                    chapters,
                )
                .await
            }

            async fn run(&self, chapters: Option<&[usize]>) -> anyhow::Result<SyncGenerated> {
                let job = create_job(&self.state, SYNC_GENERATE_JOB_KIND).await;
                self.run_job(&job, chapters).await
            }

            fn map_path(&self) -> PathBuf {
                generated_map_path(&self.state, "fixture")
            }

            fn map(&self) -> alignment::SyncMap {
                serde_json::from_slice(&std::fs::read(self.map_path()).unwrap()).unwrap()
            }

            fn report(&self) -> sync_report::SyncReport {
                let identity = probe_sync_map(&self.map_path(), true).unwrap().identity;
                sync_report::read_current_report(&self.state.sync_dir, "fixture", &identity)
                    .expect("the report describes the served map")
            }

            /// A map from an earlier run: each chapter's sentence about 20 s
            /// in, a second sentence in chapter 2, a gap across the end of
            /// chapter 1 and one inside chapter 2. Graded as backfill would.
            fn seed_previous_map(&self) -> Vec<u8> {
                let mut fragments = (0..self.tracks.len())
                    .map(|index| {
                        // A sixth chapter starts at a time that only exact
                        // float parsing writes back unchanged.
                        let offset = if index == 5 { 2576.400999999998 } else { 20.0 };
                        serde_json::json!({
                            "startSeconds": index as f64 * 3600.0 + offset,
                            "endSeconds": index as f64 * 3600.0 + 25.0,
                            "href": format!("text/ch{}.xhtml", index + 1),
                            "text": format!("Words of chapter {}.", index + 1),
                        })
                    })
                    .collect::<Vec<_>>();
                fragments.insert(
                    2,
                    serde_json::json!({"startSeconds": 3640.0, "endSeconds": 3645.0, "href": "text/ch2.xhtml", "text": "An earlier guess."}),
                );
                let bytes = serde_json::to_vec(&serde_json::json!({
                    "version": alignment::SYNC_MAP_VERSION,
                    "mappingRevision": alignment::MAPPING_REVISION,
                    "generator": "echogarden",
                    "generatedAt": "100",
                    "precision": "sentence",
                    "fragments": fragments,
                    "recoveryGaps": [
                        {"startSeconds": 3500.0, "endSeconds": 3700.0},
                        {"startSeconds": 3800.0, "endSeconds": 3900.0},
                    ],
                }))
                .unwrap();
                std::fs::write(self.map_path(), &bytes).unwrap();
                let report =
                    sync_report::estimate_report(&self.epub, &self.tracks, &self.map_path())
                        .unwrap();
                std::fs::write(
                    self.state.sync_dir.join("fixture.report.json"),
                    serde_json::to_vec(&report).unwrap(),
                )
                .unwrap();
                bytes
            }
        }

        fn chapter(index: usize) -> JobChapter {
            JobChapter {
                index,
                label: format!("Chapter {}", index + 1),
                cause: Some(sync_report::Cause::Unknown),
            }
        }

        fn starts(map: &alignment::SyncMap) -> Vec<f64> {
            map.fragments.iter().map(|f| f.start_seconds).collect()
        }

        fn gaps(map: &alignment::SyncMap) -> Vec<(f64, f64)> {
            map.recovery_gaps
                .iter()
                .map(|gap| (gap.start_seconds, gap.end_seconds))
                .collect()
        }

        fn in_chapter(map: &alignment::SyncMap, index: usize) -> serde_json::Value {
            let range = index as f64 * 3600.0..(index + 1) as f64 * 3600.0;
            serde_json::to_value(
                map.fragments
                    .iter()
                    .filter(|f| range.contains(&f.start_seconds))
                    .collect::<Vec<_>>(),
            )
            .unwrap()
        }

        #[tokio::test]
        async fn a_failed_chapter_keeps_its_earlier_timing_and_the_book_completes() {
            let book = ChapterBook::new(4);
            book.seed_previous_map();
            book.control("fail", "2.wav\n");
            let generated = book.run(None).await.unwrap();
            assert_eq!(generated.failed, vec![chapter(1)]);
            let map = book.map();
            // Chapter 2 keeps both earlier sentences and its gaps, clipped to
            // it; the gap's part in chapter 1 went with chapter 1's old timing.
            assert_eq!(starts(&map), [1.0, 3620.0, 3640.0, 7201.0, 10801.0]);
            assert_eq!(gaps(&map), [(3600.0, 3700.0), (3800.0, 3900.0)]);
            let report = book.report();
            let failed = &report.chapters[1];
            assert_eq!(failed.status, ChapterStatus::KeptPrevious);
            assert_eq!(failed.grade, Some(Grade::Failed));
            let error = failed.error.as_deref().unwrap();
            assert!(
                error.starts_with("Alignment of `Chapter 2` failed"),
                "{error}"
            );
            assert!(!error.contains('\n'));
            assert!(
                failed
                    .error_detail
                    .as_deref()
                    .unwrap()
                    .contains("segfault in the recognizer")
            );
            assert_eq!(report.chapters[0].status, ChapterStatus::Aligned);
            assert_eq!(report.grade, Some(Grade::Failed));
            assert_eq!(report.quality().unwrap().flagged, 1);

            // Without an earlier map, readers hold their place through it.
            std::fs::remove_file(book.map_path()).unwrap();
            let generated = book.run(None).await.unwrap();
            assert_eq!(generated.failed, vec![chapter(1)]);
            let map = book.map();
            assert_eq!(starts(&map), [1.0, 7201.0, 10801.0]);
            assert_eq!(gaps(&map), [(3600.0, 7200.0)]);
            let report = book.report();
            assert_eq!(report.chapters[1].status, ChapterStatus::Failed);
            assert_eq!(report.chapters[1].text_coverage, 0.0);
            assert_eq!(report.chapters[1].grade, Some(Grade::Failed));
        }

        #[tokio::test]
        async fn failing_from_the_start_fails_the_job_and_keeps_the_old_map() {
            let book = ChapterBook::new(4);
            let previous = book.seed_previous_map();
            let report = std::fs::read(book.state.sync_dir.join("fixture.report.json")).unwrap();
            book.control("fail", "1.wav\n2.wav\n3.wav\n");
            let error = book.run(None).await.unwrap_err();
            assert!(error.to_string().contains("`Chapter 3`"), "{error:#}");
            assert_eq!(book.calls(), ["1.wav", "2.wav", "3.wav"]);
            assert_eq!(std::fs::read(book.map_path()).unwrap(), previous);
            assert_eq!(
                std::fs::read(book.state.sync_dir.join("fixture.report.json")).unwrap(),
                report
            );

            // However few chapters a book has, all of them failing fails it.
            let book = ChapterBook::new(2);
            let previous = book.seed_previous_map();
            book.control("fail", "1.wav\n2.wav\n");
            book.run(None).await.unwrap_err();
            assert_eq!(std::fs::read(book.map_path()).unwrap(), previous);
        }

        #[tokio::test]
        async fn a_resumed_run_keeps_the_chapters_that_failed_before_the_pause() {
            let book = ChapterBook::new(3);
            book.control("fail", "1.wav\n");
            book.control("gate", "2.wav\n");
            let job = create_job(&book.state, SYNC_GENERATE_JOB_KIND).await;
            let (result, _) = tokio::time::timeout(Duration::from_secs(5), async {
                tokio::join!(book.run_job(&job, None), pause_when_started(&book, &job))
            })
            .await
            .unwrap();
            assert!(result.unwrap_err().downcast_ref::<SyncPaused>().is_some());
            let checkpoint: SyncCheckpoint = serde_json::from_slice(
                &std::fs::read(sync_checkpoint_path(&book.state, &job)).unwrap(),
            )
            .unwrap();
            assert_eq!(checkpoint.completed_scopes, 1);
            assert!(checkpoint.outcomes[0].error.is_some());
            assert_eq!(gaps_of(&checkpoint.recovery_gaps), [(0.0, 3600.0)]);

            book.control("release", "");
            resume(&book, &job).await;
            let generated = book.run_job(&job, None).await.unwrap();
            assert_eq!(generated.failed, vec![chapter(0)]);
            assert_eq!(book.calls(), ["1.wav", "2.wav", "3.wav"]);
            let report = book.report();
            assert_eq!(report.chapters[0].status, ChapterStatus::Failed);
            assert!(report.chapters[0].error.is_some());
            assert_eq!(report.chapters[1].status, ChapterStatus::Aligned);
        }

        fn gaps_of(gaps: &[alignment::RecoveryGap]) -> Vec<(f64, f64)> {
            gaps.iter()
                .map(|gap| (gap.start_seconds, gap.end_seconds))
                .collect()
        }

        #[tokio::test]
        async fn a_chapter_rerun_replaces_only_that_chapter() {
            let book = ChapterBook::new(6);
            book.seed_previous_map();
            let before = book.map();
            let graded_before = serde_json::to_value(book.report()).unwrap();
            book.control("start", "5");
            let job = create_job(&book.state, SYNC_GENERATE_JOB_KIND).await;
            let generated = book.run_job(&job, Some(&[1])).await.unwrap();
            assert!(generated.failed.is_empty());
            assert_eq!(book.calls(), ["2.wav"]);
            let after = book.map();
            for index in [0, 2, 3, 4, 5] {
                assert_eq!(in_chapter(&after, index), in_chapter(&before, index));
            }
            assert_eq!(
                starts(&after),
                [20.0, 3605.0, 7220.0, 10820.0, 14420.0, 20576.400999999998]
            );
            // Untouched timing is written back exactly as it was read.
            assert!(
                String::from_utf8(std::fs::read(book.map_path()).unwrap())
                    .unwrap()
                    .contains("20576.400999999998")
            );
            // Chapter 2's gap is gone; the part of the boundary gap in
            // chapter 1 stays.
            assert_eq!(gaps(&after), [(3500.0, 3600.0)]);
            assert_ne!(after.generated_at, before.generated_at);
            assert_eq!(after.mapping_revision, before.mapping_revision);

            let report = book.report();
            let report_json = serde_json::to_value(&report).unwrap();
            assert_eq!(report_json["graded"], "estimate");
            for index in [0, 2, 3, 4, 5] {
                assert_eq!(
                    report_json["chapters"][index],
                    graded_before["chapters"][index]
                );
            }
            assert_eq!(report.chapters[1].status, ChapterStatus::Aligned);
            assert_eq!(report.chapters[1].text_coverage, 1.0);
            assert_eq!(report.chapters[1].grade, Some(Grade::Good));
            let output = book.state.jobs.read().await[&job].output.clone();
            assert!(output.contains("Re-running Chapter 2;"), "{output}");
        }

        #[tokio::test]
        async fn empty_results_preserve_previous_chapter_timing() {
            let book = ChapterBook::new(3);
            let previous = book.seed_previous_map();
            let before = book.map();
            book.control("empty", "2.wav\n");
            book.run(Some(&[1])).await.unwrap_err();
            assert_eq!(std::fs::read(book.map_path()).unwrap(), previous);
            assert_eq!(
                book.report().chapters[1].status,
                ChapterStatus::KeptPrevious
            );
            assert!(book.report().chapters[1].error.is_some());

            let mut failed = chapter(1);
            failed.cause = Some(sync_report::Cause::NoisyAudio);
            let generated = book.run(Some(&[0, 1])).await.unwrap();
            assert_eq!(generated.failed, vec![failed.clone()]);
            let after = book.map();
            assert_eq!(in_chapter(&after, 0)[0]["startSeconds"], 1.0);
            assert_eq!(in_chapter(&after, 1), in_chapter(&before, 1));
            assert_eq!(in_chapter(&after, 2), in_chapter(&before, 2));

            // A whole-book sync also keeps usable timing for an empty chapter.
            let generated = book.run(None).await.unwrap();
            assert_eq!(generated.failed, vec![failed.clone()]);
            assert_eq!(in_chapter(&book.map(), 1), in_chapter(&before, 1));
        }

        #[tokio::test]
        async fn early_failure_preserves_reports_for_unattempted_chapters() {
            let book = ChapterBook::new(4);
            let previous = book.seed_previous_map();
            let mut report = book.report();
            report.chapters[3].status = ChapterStatus::KeptPrevious;
            report.chapters[3].error = Some("Earlier chapter failure".into());
            report.chapters[3].error_detail =
                Some("Earlier chapter failure: original details".into());
            std::fs::write(
                book.state.sync_dir.join("fixture.report.json"),
                serde_json::to_vec(&report).unwrap(),
            )
            .unwrap();
            let fourth = serde_json::to_value(&book.report().chapters[3]).unwrap();
            book.control("fail", "1.wav\n2.wav\n3.wav\n");
            book.run(Some(&[0, 1, 2, 3])).await.unwrap_err();
            assert_eq!(book.calls(), ["1.wav", "2.wav", "3.wav"]);
            assert_eq!(std::fs::read(book.map_path()).unwrap(), previous);
            assert_eq!(
                serde_json::to_value(&book.report().chapters[3]).unwrap(),
                fourth
            );
        }

        #[tokio::test]
        async fn a_failed_rerun_leaves_the_chapter_as_it_was() {
            let book = ChapterBook::new(3);
            let previous = book.seed_previous_map();
            let before = book.map();
            book.control("fail", "2.wav\n");
            book.run(Some(&[1])).await.unwrap_err();
            assert_eq!(std::fs::read(book.map_path()).unwrap(), previous);
            // The report still describes the unchanged map, now with the error.
            let report = book.report();
            assert_eq!(report.chapters[1].status, ChapterStatus::KeptPrevious);
            assert!(report.chapters[1].error.is_some());
            assert_eq!(report.chapters[0].status, ChapterStatus::Aligned);

            // One of two chapters failing still replaces the other.
            let generated = book.run(Some(&[0, 1])).await.unwrap();
            assert_eq!(generated.failed, vec![chapter(1)]);
            let after = book.map();
            assert_eq!(in_chapter(&after, 0)[0]["startSeconds"], 1.0);
            assert_eq!(in_chapter(&after, 1), in_chapter(&before, 1));
            assert_eq!(in_chapter(&after, 2), in_chapter(&before, 2));
            let report = book.report();
            assert_eq!(report.chapters[0].status, ChapterStatus::Aligned);
            assert_eq!(report.chapters[1].status, ChapterStatus::KeptPrevious);

            // A chapter the book no longer has is refused before any work.
            let error = book.run(Some(&[3])).await.unwrap_err();
            assert_eq!(error.to_string(), sync_report::BOOK_CHANGED);
        }

        async fn pause_when_started(book: &ChapterBook, job: &str) {
            tokio::time::timeout(Duration::from_secs(5), async {
                while !book.runtime.cli_path.with_extension("started").exists() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            book.state
                .jobs
                .write()
                .await
                .get_mut(job)
                .unwrap()
                .pause_requested = true;
            book.state
                .update_manager
                .sync_queue_changed
                .notify_waiters();
        }

        async fn resume(book: &ChapterBook, job: &str) {
            let mut jobs = book.state.jobs.write().await;
            let entry = jobs.get_mut(job).unwrap();
            entry.pause_requested = false;
            entry.status = "running".into();
        }

        #[tokio::test]
        async fn a_crashed_chapter_is_retried_once_and_kept_when_it_aligns() {
            let book = ChapterBook::new(4);
            book.seed_previous_map();
            book.control("crash", "2.wav\n");
            book.control("once", "");
            let job = create_job(&book.state, SYNC_GENERATE_JOB_KIND).await;
            let generated = book.run_job(&job, None).await.unwrap();
            assert!(generated.failed.is_empty(), "{:?}", generated.failed);
            assert_eq!(book.calls(), ["1.wav", "2.wav", "3.wav", "4.wav", "2.wav"]);
            let report = book.report();
            let fixed = &report.chapters[1];
            assert_eq!(fixed.status, ChapterStatus::Aligned);
            assert_eq!(fixed.grade, Some(Grade::Good));
            let diagnosis = fixed.diagnosis.as_ref().unwrap();
            assert_eq!(diagnosis.cause, sync_report::Cause::RuntimeCrash);
            assert!(diagnosis.fix.attempted && diagnosis.fix.applied);
            assert!(report.chapters[0].diagnosis.is_none());
            let output = book.state.jobs.read().await[&job].output.clone();
            assert!(
                output.contains("Chapter 2 crashed the speech recognizer"),
                "{output}"
            );
            assert!(output.contains("went from Failed to Good"), "{output}");
        }

        #[tokio::test]
        async fn automatic_fixes_run_once_per_chapter_and_survive_a_pause() {
            let book = ChapterBook::new(4);
            book.seed_previous_map();
            book.control("crash", "2.wav\n3.wav\n");
            // Hold chapter 3's retry, after chapter 2's has finished.
            book.control("gate", "3.wav\n");
            book.control("gate-repeats", "");
            let job = create_job(&book.state, SYNC_GENERATE_JOB_KIND).await;
            let (result, _) = tokio::time::timeout(Duration::from_secs(5), async {
                tokio::join!(book.run_job(&job, None), pause_when_started(&book, &job))
            })
            .await
            .unwrap();
            assert!(result.unwrap_err().downcast_ref::<SyncPaused>().is_some());
            let checkpoint: SyncCheckpoint = serde_json::from_slice(
                &std::fs::read(sync_checkpoint_path(&book.state, &job)).unwrap(),
            )
            .unwrap();
            assert_eq!(checkpoint.completed_scopes, 4);
            assert_eq!(
                checkpoint.outcomes[1].fixes,
                [sync_report::Cause::RuntimeCrash]
            );
            assert!(checkpoint.outcomes[2].fixes.is_empty());

            book.control("release", "");
            resume(&book, &job).await;
            let generated = book.run_job(&job, None).await.unwrap();
            // Each crashed chapter was retried exactly once across the pause.
            assert_eq!(
                book.calls(),
                ["1.wav", "2.wav", "3.wav", "4.wav", "2.wav", "3.wav"]
            );
            assert_eq!(
                generated
                    .failed
                    .iter()
                    .map(|chapter| (chapter.index, chapter.cause))
                    .collect::<Vec<_>>(),
                [
                    (1, Some(sync_report::Cause::RuntimeCrash)),
                    (2, Some(sync_report::Cause::RuntimeCrash))
                ]
            );
            let report = book.report();
            for chapter in &report.chapters[1..3] {
                assert_eq!(chapter.status, ChapterStatus::KeptPrevious);
                let diagnosis = chapter.diagnosis.as_ref().unwrap();
                assert_eq!(diagnosis.cause, sync_report::Cause::RuntimeCrash);
                assert_eq!(diagnosis.fix.kind, sync_report::FixKind::Auto);
                assert!(diagnosis.fix.attempted && !diagnosis.fix.applied);
            }

            // A re-run of one chapter tries its fix again, once.
            book.run(Some(&[1])).await.unwrap_err();
            assert_eq!(book.calls().len(), 8);
        }
    }

    /// Diagnosis and automatic fixes that depend on what recognition heard.
    /// Each chapter is a track whose narration is scripted in `TRACK.words`;
    /// the fake ffmpeg passes the requested range along, and the fake
    /// recognizer answers from the script, sparse and garbled for tracks in
    /// `$0.noisy` unless the model is listed in `$0.clear-models`, and as
    /// stock words when told a language other than English.
    #[cfg(unix)]
    mod recognition {
        use super::*;
        use std::os::unix::fs::PermissionsExt;
        use sync_report::{Cause, FixKind, Grade};

        const SENTENCES: usize = 100;
        const SENTENCE_SECONDS: f64 = 4.0;

        /// Every word names its chapter, so no chapter's text anchors another's.
        fn sentence(chapter: usize, index: usize) -> String {
            format!(
                "Sentence c{chapter}n{index} of part{chapter} word{chapter} three{chapter} four{chapter} five{chapter}n{index} six{chapter}n{index}."
            )
        }

        const FAKE_FFMPEG: &str = r#"#!/bin/sh
start=0; duration=0; previous=""; input=""
for argument in "$@"; do
  case "$previous" in -ss) start="$argument";; -t) duration="$argument";; -i) input="$argument";; esac
  previous="$argument"
done
source="$input"
if read s0 d0 inner < "$input" 2>/dev/null && [ -n "$inner" ]; then
  start=$(awk -v a="$s0" -v b="$start" 'BEGIN { print a + b }'); source="$inner"
fi
printf '%s %s %s\n' "$start" "$duration" "$source" > "$previous"
"#;

        const FAKE_ECHOGARDEN: &str = r#"#!/bin/sh
command="$1"; audio="$2"
read start duration source < "$audio"
model=""; language=""
for argument in "$@"; do
  case "$argument" in --whisper.model=*) model="${argument#*=}";; --language=*) language="${argument#*=}";; esac
done
track=$(basename "$source")
printf '%s %s %s\n' "$command" "$track" "$model" >> "$0.calls"
case "$command" in
  detect-speech-language)
    if [ -f "$0.language-gate" ]; then
      touch "$0.language-started"
      while [ ! -f "$0.language-release" ]; do sleep 0.01; done
    fi
    printf '[{"language":"en","languageName":"English","probability":0.97}]' > "$3" ;;
  transcribe)
    mode=clear
    if [ -f "$0.noisy" ] && grep -qxF "$track" "$0.noisy" && ! grep -qxF "$model" "$0.clear-models" 2>/dev/null; then mode=noisy; fi
    [ -n "$language" ] && [ "$language" != "en" ] && mode=translated
    awk -v s="$start" -v d="$duration" -v mode="$mode" 'BEGIN { printf "["; n = 0; split("de het een van en", stock) }
      { t = $1 + 0
        if (t >= s && t < s + d) {
          k++; w = $2
          if (mode == "noisy") { if (k % 4) next; w = "blah" k }
          if (mode == "translated") w = stock[k % 5 + 1]
          if (n > 0) printf ","
          printf "{\"type\":\"word\",\"text\":\"%s\",\"startTime\":%.3f,\"endTime\":%.3f}", w, t - s, t - s + 0.3
          n++ } }
      END { printf "]" }' "$source.words" > "$3" ;;
  align)
    if [ -f "$0.empty-align" ]; then printf "[]" > "$4"; exit 0; fi
    partial=0; [ -f "$0.partial" ] && partial=1
    awk -v d="$duration" -v partial="$partial" 'BEGIN { RS = "\001" }
      { gsub(/\n/, " "); n = split($0, parts, /\. */); m = 0
        for (i = 1; i <= n; i++) if (parts[i] ~ /[A-Za-z0-9]/) m++
        printf "["; k = 0
        for (i = 1; i <= n; i++) {
          if (parts[i] !~ /[A-Za-z0-9]/) continue
          if (partial && i % 2 == 0) continue
          gsub(/^ +| +$/, "", parts[i])
          if (k > 0) printf ","
          printf "{\"type\":\"sentence\",\"text\":\"%s.\",\"startTime\":%.3f,\"endTime\":%.3f}", parts[i], k * d / m, (k + 1) * d / m
          k++ }
        printf "]" }' "$3" > "$4" ;;
esac
"#;

        fn write_script(path: &FsPath, body: &str) {
            std::fs::write(path, body).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        struct SpokenBook {
            _root: tempfile::TempDir,
            state: AppState,
            epub: PathBuf,
            tracks: Vec<SyncTrackInput>,
            runtime: SyncAddonRuntime,
        }

        impl SpokenBook {
            /// `narrated[n]` is the chapter whose text track `n` speaks.
            fn new(narrated: &[usize], language: Option<&str>) -> Self {
                let root = tempfile::tempdir().unwrap();
                let (state, _) = crate::unit_tests::fake_libation_state(root.path());
                let count = narrated.len();
                let titles = (1..=count)
                    .map(|n| format!("Chapter {n}"))
                    .collect::<Vec<_>>();
                let bodies = (0..count)
                    .map(|chapter| {
                        let text = (0..SENTENCES)
                            .map(|index| sentence(chapter, index))
                            .collect::<Vec<_>>()
                            .join(" ");
                        format!("<p>{text}</p>")
                    })
                    .collect::<Vec<_>>();
                let chapters = titles
                    .iter()
                    .zip(&bodies)
                    .map(|(title, body)| (title.as_str(), body.as_str()))
                    .collect::<Vec<_>>();
                let epub = root.path().join("book.epub");
                std::fs::write(
                    &epub,
                    alignment::build_test_epub_in_language(&chapters, language),
                )
                .unwrap();
                let tracks = narrated
                    .iter()
                    .enumerate()
                    .map(|(index, &chapter)| {
                        let path = root.path().join(format!("{}.wav", index + 1));
                        std::fs::write(&path, "fixture\n").unwrap();
                        let words = (0..SENTENCES)
                            .flat_map(|sentence_index| {
                                sentence(chapter, sentence_index)
                                    .split_whitespace()
                                    .enumerate()
                                    .map(move |(position, word)| {
                                        format!(
                                            "{:.3} {}\n",
                                            2.0 + sentence_index as f64 * SENTENCE_SECONDS
                                                + position as f64 * 0.4,
                                            word.trim_end_matches('.')
                                        )
                                    })
                                    .collect::<Vec<_>>()
                            })
                            .collect::<String>();
                        std::fs::write(path.with_extension("wav.words"), words).unwrap();
                        SyncTrackInput {
                            path,
                            title: titles[index].clone(),
                            duration_seconds: Some(2.0 + SENTENCES as f64 * SENTENCE_SECONDS),
                            chapters: Vec::new(),
                        }
                    })
                    .collect();
                let ffmpeg = root.path().join("ffmpeg");
                write_script(&ffmpeg, FAKE_FFMPEG);
                let cli = root.path().join("echogarden");
                write_script(&cli, FAKE_ECHOGARDEN);
                std::fs::create_dir_all(&state.sync_dir).unwrap();
                Self {
                    _root: root,
                    state,
                    epub,
                    tracks,
                    runtime: SyncAddonRuntime {
                        cli_path: cli,
                        cli_args: Vec::new(),
                        ffmpeg_path: Some(ffmpeg),
                    },
                }
            }

            fn control(&self, name: &str, value: &str) {
                std::fs::write(self.runtime.cli_path.with_extension(name), value).unwrap();
            }

            /// `command track model` per recognizer call.
            fn calls(&self) -> Vec<String> {
                std::fs::read_to_string(self.runtime.cli_path.with_extension("calls"))
                    .unwrap_or_default()
                    .lines()
                    .map(str::to_string)
                    .collect()
            }

            async fn run_job(
                &self,
                job: &str,
                chapters: Option<&[usize]>,
            ) -> anyhow::Result<SyncGenerated> {
                run_sync_generation(
                    &self.state,
                    job,
                    "fixture",
                    &self.runtime,
                    &self.epub,
                    &self.tracks,
                    chapters,
                )
                .await
            }

            async fn run(&self, chapters: Option<&[usize]>) -> (sync_report::SyncReport, String) {
                let job = create_job(&self.state, SYNC_GENERATE_JOB_KIND).await;
                self.run_job(&job, chapters).await.unwrap();
                let path = generated_map_path(&self.state, "fixture");
                let identity = probe_sync_map(&path, true).unwrap().identity;
                let report =
                    sync_report::read_current_report(&self.state.sync_dir, "fixture", &identity)
                        .unwrap();
                (report, self.state.jobs.read().await[&job].output.clone())
            }

            fn map(&self) -> alignment::SyncMap {
                let path = generated_map_path(&self.state, "fixture");
                serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
            }
        }

        fn grades(report: &sync_report::SyncReport) -> Vec<Option<Grade>> {
            report
                .chapters
                .iter()
                .map(|chapter| chapter.grade)
                .collect()
        }

        #[tokio::test]
        async fn noisy_audio_gets_one_larger_model_pass_kept_only_if_it_grades_better() {
            let book = SpokenBook::new(&[0, 1, 2], Some("en"));
            book.control("noisy", "2.wav\n");
            book.control("clear-models", "small.en\n");
            let (report, output) = book.run(None).await;
            assert_eq!(grades(&report), [Some(Grade::Good); 3], "{output}");
            let diagnosis = report.chapters[1].diagnosis.as_ref().unwrap();
            assert_eq!(diagnosis.cause, Cause::NoisyAudio);
            assert!(diagnosis.fix.attempted && diagnosis.fix.applied);
            assert!(
                output.contains("trying the larger whisper small.en model once"),
                "{output}"
            );
            let larger = book
                .calls()
                .into_iter()
                .filter(|call| call.ends_with(" small.en"))
                .collect::<Vec<_>>();
            assert!(!larger.is_empty());
            assert!(
                larger.iter().all(|call| call.contains(" 2.wav ")),
                "{larger:?}"
            );

            // When neither model finds timing, the previous map stays.
            std::fs::remove_file(book.runtime.cli_path.with_extension("calls")).unwrap();
            book.control("clear-models", "");
            let before = book.map();
            let (report, output) = book.run(None).await;
            assert_eq!(report.chapters[1].grade, Some(Grade::Failed), "{output}");
            assert_eq!(
                report.chapters[1].status,
                sync_report::ChapterStatus::KeptPrevious
            );
            let diagnosis = report.chapters[1].diagnosis.as_ref().unwrap();
            assert_eq!(diagnosis.cause, Cause::NoisyAudio);
            assert!(diagnosis.fix.attempted && !diagnosis.fix.applied);
            assert!(diagnosis.evidence.unanchored_windows.unwrap() > 0);
            assert!(output.contains("That failed too"), "{output}");
            assert_eq!(
                in_range(&book.map(), &report.chapters[1]),
                in_range(&before, &report.chapters[1])
            );
            // Exactly one larger-model pass over the chapter's windows.
            assert_eq!(output.matches("trying the larger whisper").count(), 1);
        }

        fn in_range(map: &alignment::SyncMap, chapter: &sync_report::ChapterReport) -> Vec<String> {
            map.fragments
                .iter()
                .filter(|f| (chapter.start_seconds..chapter.end_seconds).contains(&f.start_seconds))
                .map(|f| f.text.clone())
                .collect()
        }

        #[tokio::test]
        async fn audio_for_another_chapter_is_aligned_with_that_chapters_text() {
            let book = SpokenBook::new(&[0, 2, 1, 3], Some("en"));
            let (report, output) = book.run(None).await;
            assert_eq!(grades(&report), [Some(Grade::Good); 4], "{output}");
            for (index, other) in [(1, 2), (2, 1)] {
                let diagnosis = report.chapters[index].diagnosis.as_ref().unwrap();
                assert_eq!(diagnosis.cause, Cause::ChapterMismatch);
                assert!(diagnosis.fix.applied);
                assert_eq!(
                    diagnosis
                        .evidence
                        .matching_chapter
                        .as_ref()
                        .map(|c| c.index),
                    Some(other)
                );
                let texts = in_range(&book.map(), &report.chapters[index]);
                assert_eq!(texts.len(), SENTENCES);
                assert!(
                    texts
                        .iter()
                        .all(|text| text.contains(&format!("part{other}")))
                );
            }
            assert!(
                output.contains("The audio of Chapter 2 sounds like the text of Chapter 3"),
                "{output}"
            );
            assert!(report.chapters[0].diagnosis.is_none());
            // The language was never in doubt.
            assert!(!book.calls().iter().any(|call| call.starts_with("detect")));
        }

        #[tokio::test]
        async fn a_larger_model_keeps_an_earlier_chapter_pairing_repair() {
            let book = SpokenBook::new(&[1, 0], Some("en"));
            let job = create_job(&book.state, SYNC_GENERATE_JOB_KIND).await;
            let epub = alignment::parse_epub_file(&book.epub).unwrap();
            let scopes = plan_scopes(&epub, &book.tracks, true).unwrap().scopes;
            let spans = sync_report::chapter_spans(&epub, &book.tracks, &scopes);
            let labels = spans
                .iter()
                .map(|span| span.label.clone())
                .collect::<Vec<_>>();
            let recognition = RecognitionSettings::for_language(Some("en"));
            let temp = tempfile::tempdir().unwrap();
            let aligner = Aligner::new(&book.state, &job, &book.runtime, temp.path(), &recognition);
            let checkpoint_path = sync_checkpoint_path(&book.state, &job);
            let fixes = AutomaticFixes {
                aligner: &aligner,
                epub: &epub,
                tracks: &book.tracks,
                scopes: &scopes,
                spans: &spans,
                labels: &labels,
                checkpoint_path: &checkpoint_path,
            };
            let mut run = SyncCheckpoint {
                fingerprint: "fixture".into(),
                completed_scopes: 1,
                fragments: Vec::new(),
                recovery_gaps: Vec::new(),
                outcomes: vec![sync_report::ScopeOutcome {
                    error: Some("Windowed alignment stalled at 0 s.".into()),
                    evidence: sync_report::ScopeEvidence {
                        matching_scope: Some(1),
                        ..Default::default()
                    },
                    ..Default::default()
                }],
            };
            // A correct pairing can still leave coverage Poor on difficult audio.
            book.control("partial", "");
            fixes
                .attempt(0, Cause::ChapterMismatch, Grade::Failed, &mut run)
                .await
                .unwrap();
            let span = sync_report::with_outcome(&spans, 0, &run.outcomes[0]);
            assert_eq!(
                chapter_grade(&span, &run.fragments, &run.recovery_gaps),
                Some(Grade::Poor)
            );
            assert_eq!(run.outcomes[0].paired_with, Some(1));
            std::fs::remove_file(book.runtime.cli_path.with_extension("partial")).unwrap();

            fixes.run(&[0], &mut run).await.unwrap();
            assert_eq!(
                chapter_grade(&span, &run.fragments, &run.recovery_gaps),
                Some(Grade::Good)
            );
            assert_eq!(
                run.outcomes[0].fixes,
                [Cause::ChapterMismatch, Cause::NoisyAudio]
            );
            assert_eq!(run.outcomes[0].paired_with, Some(1));
            assert_eq!(run.fragments.len(), SENTENCES);
            assert!(
                run.fragments
                    .iter()
                    .all(|fragment| fragment.text.contains("part1"))
            );
        }

        #[tokio::test]
        async fn language_detection_can_pause_and_resume_without_repeating_alignment() {
            let book = SpokenBook::new(&[0, 1], Some("nl"));
            book.control("language-gate", "");
            let job = create_job(&book.state, SYNC_GENERATE_JOB_KIND).await;
            let (result, _) = tokio::time::timeout(Duration::from_secs(5), async {
                tokio::join!(book.run_job(&job, None), async {
                    while !book
                        .runtime
                        .cli_path
                        .with_extension("language-started")
                        .exists()
                    {
                        tokio::task::yield_now().await;
                    }
                    book.state
                        .jobs
                        .write()
                        .await
                        .get_mut(&job)
                        .unwrap()
                        .pause_requested = true;
                    book.state
                        .update_manager
                        .sync_queue_changed
                        .notify_waiters();
                })
            })
            .await
            .unwrap();
            assert!(result.unwrap_err().downcast_ref::<SyncPaused>().is_some());
            assert_eq!(book.state.jobs.read().await[&job].status, "paused");
            assert!(!generated_map_path(&book.state, "fixture").exists());
            let checkpoint: SyncCheckpoint = serde_json::from_slice(
                &std::fs::read(sync_checkpoint_path(&book.state, &job)).unwrap(),
            )
            .unwrap();
            assert_eq!(checkpoint.completed_scopes, 2);
            let transcriptions = book
                .calls()
                .iter()
                .filter(|call| call.starts_with("transcribe "))
                .count();

            book.control("language-release", "");
            {
                let mut jobs = book.state.jobs.write().await;
                let entry = jobs.get_mut(&job).unwrap();
                entry.pause_requested = false;
                entry.status = "running".into();
            }
            let error = book.run_job(&job, None).await.unwrap_err();
            assert_eq!(
                error
                    .downcast_ref::<sync_report::DiagnosedFailure>()
                    .unwrap()
                    .cause,
                Cause::LanguageMismatch
            );
            assert_eq!(
                book.calls()
                    .iter()
                    .filter(|call| call.starts_with("transcribe "))
                    .count(),
                transcriptions
            );
        }

        #[tokio::test]
        async fn unrelated_narration_is_diagnosed_after_three_empty_chapters() {
            let book = SpokenBook::new(&[9, 10, 11], Some("en"));
            let job = create_job(&book.state, SYNC_GENERATE_JOB_KIND).await;
            let error = book.run_job(&job, None).await.unwrap_err();
            let failure = error
                .downcast_ref::<sync_report::DiagnosedFailure>()
                .unwrap();
            assert_eq!(failure.cause, Cause::EditionMismatch);
            assert!(!generated_map_path(&book.state, "fixture").exists());
            assert_eq!(
                book.calls()
                    .iter()
                    .filter(|call| call.starts_with("detect"))
                    .count(),
                1
            );
            assert!(!book.calls().iter().any(|call| call.ends_with(" small.en")));

            let mixed = SpokenBook::new(&[0, 9, 2], Some("en"));
            let job = create_job(&mixed.state, SYNC_GENERATE_JOB_KIND).await;
            let generated = mixed.run_job(&job, None).await.unwrap();
            assert_eq!(generated.failed.len(), 1);
            assert_eq!(generated.failed[0].index, 1);
            assert_eq!(generated.failed[0].cause, Some(Cause::EditionMismatch));
        }

        #[tokio::test]
        async fn empty_automatic_retries_keep_the_previous_map() {
            let book = SpokenBook::new(&[0, 1, 2], Some("en"));
            book.run(None).await;
            let map_path = generated_map_path(&book.state, "fixture");
            let before = std::fs::read(&map_path).unwrap();
            book.control("empty-align", "");
            let job = create_job(&book.state, SYNC_GENERATE_JOB_KIND).await;
            let error = book.run_job(&job, None).await.unwrap_err();
            assert_eq!(
                error
                    .downcast_ref::<sync_report::DiagnosedFailure>()
                    .unwrap()
                    .cause,
                Cause::NoisyAudio
            );
            assert_eq!(std::fs::read(&map_path).unwrap(), before);
            let output = book.state.jobs.read().await[&job].output.clone();
            assert_eq!(
                output.matches("trying the larger whisper").count(),
                3,
                "{output}"
            );
            assert_eq!(output.matches("That failed too").count(), 3, "{output}");
            assert!(!output.contains("keeping it"), "{output}");
        }

        async fn set_language(book: &SpokenBook, language: Option<&str>) {
            book.state
                .metadata_overrides
                .mutate(|overrides| {
                    overrides
                        .books
                        .entry("fixture".into())
                        .or_default()
                        .sync_language = language.map(str::to_string);
                    Ok(())
                })
                .await
                .unwrap();
        }

        #[tokio::test]
        async fn a_mislabelled_language_is_suggested_not_applied_and_the_override_fixes_it() {
            let book = SpokenBook::new(&[0, 1, 2], Some("nl"));
            // Nothing matches anywhere, so the whole run fails, saying why.
            let job = create_job(&book.state, SYNC_GENERATE_JOB_KIND).await;
            let error = book.run_job(&job, None).await.unwrap_err();
            let failure = error
                .downcast_ref::<sync_report::DiagnosedFailure>()
                .expect("a diagnosed failure");
            assert_eq!(failure.cause, Cause::LanguageMismatch);
            assert_eq!(failure.heard_language.as_deref(), Some("en"));
            let calls = book.calls();
            assert_eq!(calls.iter().filter(|c| c.starts_with("detect")).count(), 1);
            // A suggestion is never applied on its own.
            assert!(
                !calls.iter().any(|call| call.ends_with(" small")),
                "{calls:?}"
            );

            set_language(&book, Some("en")).await;
            let (report, output) = book.run(None).await;
            assert_eq!(grades(&report), [Some(Grade::Good); 3], "{output}");
            assert!(output.contains("whisper tiny.en, language en"), "{output}");

            // Clearing the override puts the EPUB's label back, and a re-run
            // of one chapter shows the suggestion on that chapter.
            let map_path = generated_map_path(&book.state, "fixture");
            let before = std::fs::read(&map_path).unwrap();
            set_language(&book, None).await;
            let job = create_job(&book.state, SYNC_GENERATE_JOB_KIND).await;
            book.run_job(&job, Some(&[1])).await.unwrap_err();
            assert_eq!(std::fs::read(&map_path).unwrap(), before);
            let identity = probe_sync_map(&map_path, true).unwrap().identity;
            let report =
                sync_report::read_current_report(&book.state.sync_dir, "fixture", &identity)
                    .unwrap();
            let output = book.state.jobs.read().await[&job].output.clone();
            assert_eq!(report.chapters[0].grade, Some(Grade::Good));
            assert_eq!(report.chapters[2].grade, Some(Grade::Good));
            let chapter = &report.chapters[1];
            assert_eq!(chapter.grade, Some(Grade::Failed), "{output}");
            assert_eq!(chapter.status, sync_report::ChapterStatus::KeptPrevious);
            let diagnosis = chapter.diagnosis.as_ref().unwrap();
            assert_eq!(diagnosis.cause, Cause::LanguageMismatch);
            assert_eq!(diagnosis.fix.kind, FixKind::Suggested);
            assert_eq!(
                diagnosis.fix.action,
                Some(sync_report::FixAction::ResyncLanguage)
            );
            assert!(!diagnosis.fix.attempted);
            assert_eq!(diagnosis.evidence.heard_language.as_deref(), Some("en"));
            assert_eq!(diagnosis.evidence.labelled_language.as_deref(), Some("nl"));
            assert!(output.contains("need the book re-synced as en"), "{output}");

            set_language(&book, Some("en")).await;
            let (report, _) = book.run(Some(&[1])).await;
            assert_eq!(grades(&report), [Some(Grade::Good); 3]);
            assert!(report.chapters.iter().all(|c| c.diagnosis.is_none()));
        }
    }
}
