//! The in-memory background job table: creation, deduplication, progress and
//! completion updates, and the admin endpoints that watch it.

use crate::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobStatus {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) target_id: Option<String>,
    pub(crate) status: String,
    pub(crate) started_at: String,
    pub(crate) finished_at: Option<String>,
    pub(crate) exit_code: Option<i32>,
    pub(crate) output: String,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobCreated {
    pub(crate) job_id: String,
}

pub(crate) async fn list_jobs(
    State(state): State<AppState>,
    _: AdminUser,
) -> Result<Json<Vec<JobStatus>>, ApiError> {
    let jobs = state.jobs.read().await;
    let mut list: Vec<JobStatus> = jobs.values().map(job_for_list).collect();
    list.sort_by_key(|job| std::cmp::Reverse(job_started_timestamp(job)));
    Ok(Json(list))
}

pub(crate) fn job_started_timestamp(job: &JobStatus) -> u64 {
    job.started_at.parse().unwrap_or(0)
}

pub(crate) async fn get_job(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(job_id): Path<String>,
) -> Result<Json<JobStatus>, ApiError> {
    let job = state
        .jobs
        .read()
        .await
        .get(&job_id)
        .cloned()
        .ok_or(ApiError::not_found("Job not found"))?;
    if auth.is_admin {
        return Ok(Json(job));
    }

    // Non-administrators only learn about jobs whose unguessable IDs were
    // returned to them by a request they initiated. Avoid exposing command
    // output, which can contain server paths or Libation account details.
    let mut summary = job;
    summary.output.clear();
    summary.error = summary
        .error
        .as_ref()
        .map(|_| "The background operation failed.".to_string());
    Ok(Json(summary))
}

/// A job that starts running at once, with no deduplication. Production
/// paths all queue and deduplicate now; the faststart tests still create
/// jobs directly.
#[cfg(test)]
pub(crate) async fn create_job(state: &AppState, kind: &str) -> String {
    create_job_with_state(state, kind, None, "running", false)
        .await
        .0
}

pub(crate) async fn create_queued_job(
    state: &AppState,
    kind: &str,
    target_id: Option<String>,
) -> (String, bool) {
    create_job_with_state(state, kind, target_id, "queued", true).await
}

pub(crate) async fn create_job_with_state(
    state: &AppState,
    kind: &str,
    target_id: Option<String>,
    status: &str,
    deduplicate_pending: bool,
) -> (String, bool) {
    let mut bytes = [0u8; 8];
    rand::rng().fill(&mut bytes);
    let id = format!("{:016x}", u64::from_le_bytes(bytes));
    let mut jobs = state.jobs.write().await;

    if deduplicate_pending
        && let Some(existing) = jobs
            .values()
            .filter(|job| job.kind == kind && job.target_id == target_id && is_active_job(job))
            .max_by_key(|job| job_started_timestamp(job))
    {
        return (existing.id.clone(), false);
    }

    let started_at = next_job_timestamp(&jobs).to_string();
    let job = JobStatus {
        id: id.clone(),
        kind: kind.to_string(),
        target_id,
        status: status.to_string(),
        started_at,
        finished_at: None,
        exit_code: None,
        output: String::new(),
        error: None,
    };
    jobs.insert(id.clone(), job);
    prune_finished_jobs(&mut jobs);
    (id, true)
}

pub(crate) const MAX_TRACKED_JOBS: usize = 50;

pub(crate) const MAX_JOB_OUTPUT_BYTES: usize = 64 * 1024;

pub(crate) const JOB_LIST_OUTPUT_BYTES: usize = 4 * 1024;

pub(crate) fn is_active_job(job: &JobStatus) -> bool {
    matches!(job.status.as_str(), "queued" | "running")
}

/// The newest queued or running job of `kind`, if any.
pub(crate) fn active_job_id(jobs: &HashMap<String, JobStatus>, kind: &str) -> Option<String> {
    jobs.values()
        .filter(|job| job.kind == kind && is_active_job(job))
        .max_by_key(|job| job_started_timestamp(job))
        .map(|job| job.id.clone())
}

/// How long a waiter follows a job before giving it up as failed. Generous,
/// because a Libation download of a whole library can run for hours; finite,
/// because a job the table has lost track of would otherwise be waited on
/// for the life of the process.
pub(crate) const JOB_OUTCOME_WAIT_CEILING: Duration = Duration::from_secs(6 * 60 * 60);

/// Waits for a job to leave the queue: `true` once it completed, `false` once
/// it failed. A job missing from the table counts as failed — it can only
/// disappear by being pruned, and active jobs are never pruned. So does one
/// still active at [`JOB_OUTCOME_WAIT_CEILING`].
pub(crate) async fn await_job_outcome(state: &AppState, job_id: &str) -> bool {
    await_job_outcome_within(state, job_id, JOB_OUTCOME_WAIT_CEILING).await
}

pub(crate) async fn await_job_outcome_within(
    state: &AppState,
    job_id: &str,
    ceiling: Duration,
) -> bool {
    let deadline = tokio::time::Instant::now() + ceiling;
    loop {
        let status = state
            .jobs
            .read()
            .await
            .get(job_id)
            .map(|job| job.status.clone());
        match status.as_deref() {
            Some("completed") => return true,
            Some("failed") | None => return false,
            _ if tokio::time::Instant::now() >= deadline => {
                tracing::warn!("gave up waiting for job {job_id} after {ceiling:?}");
                return false;
            }
            _ => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
}

/// Marks a job failed if the task running it goes away without reporting.
///
/// A job's future can panic, or be dropped when the runtime shuts down, and
/// the table then showed it running for ever: deduplication pinned every
/// later request of the same kind to it, and waiters polled it until their
/// ceiling. Hold one of these for the life of the task and call
/// [`JobGuard::finish`] on the way out; dropping it any other way marks the
/// job failed. [`run_job`] does both around a future.
///
/// Adopted at the spawn sites one by one: wrap the spawned future in
/// `run_job(state.clone(), job_id.clone(), async move { ... })`.
pub(crate) struct JobGuard {
    state: AppState,
    job_id: String,
    armed: bool,
}

impl JobGuard {
    pub(crate) fn new(state: &AppState, job_id: &str) -> Self {
        Self {
            state: state.clone(),
            job_id: job_id.to_string(),
            armed: true,
        }
    }

    /// The task ran to its end. A job it left active is still marked failed:
    /// it can only be active because nothing recorded a result for it.
    pub(crate) async fn finish(mut self) {
        self.armed = false;
        fail_if_still_active(
            &self.state,
            &self.job_id,
            "The background job ended without reporting a result.",
        )
        .await;
    }
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        // Drop cannot wait on the table's lock. Hand the update to the
        // runtime when there is one; during runtime shutdown there is no
        // table left to keep accurate.
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let state = self.state.clone();
        let job_id = std::mem::take(&mut self.job_id);
        handle.spawn(async move {
            fail_if_still_active(
                &state,
                &job_id,
                "The background job stopped before it could report a result.",
            )
            .await;
        });
    }
}

async fn fail_if_still_active(state: &AppState, job_id: &str, error: &str) {
    let mut jobs = state.jobs.write().await;
    if let Some(job) = jobs.get_mut(job_id)
        && is_active_job(job)
    {
        job.status = "failed".to_string();
        job.finished_at = Some(unix_now_millis().to_string());
        job.error = Some(error.to_string());
    }
    prune_finished_jobs(&mut jobs);
}

/// Runs a job's future under a [`JobGuard`], so the table can never show the
/// job running once the task is gone. `work` is expected to record its own
/// completion or failure; a job it leaves active is marked failed.
pub(crate) async fn run_job<F>(state: AppState, job_id: String, work: F)
where
    F: std::future::Future<Output = ()>,
{
    let guard = JobGuard::new(&state, &job_id);
    work.await;
    guard.finish().await;
}

pub(crate) fn next_job_timestamp(jobs: &HashMap<String, JobStatus>) -> u64 {
    let latest = jobs.values().map(job_started_timestamp).max().unwrap_or(0);
    unix_now_millis().max(latest.saturating_add(1))
}

pub(crate) fn text_tail(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut start = value.len() - max_bytes;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    value[start..].to_string()
}

pub(crate) fn job_for_list(job: &JobStatus) -> JobStatus {
    let mut summary = job.clone();
    summary.output = text_tail(&summary.output, JOB_LIST_OUTPUT_BYTES);
    summary.error = summary
        .error
        .as_deref()
        .map(|error| text_tail(error, JOB_LIST_OUTPUT_BYTES));
    summary
}

/// Drops the oldest finished jobs once the map exceeds the cap, so job
/// history doesn't grow without bound. Active jobs are never removed.
pub(crate) fn prune_finished_jobs(jobs: &mut HashMap<String, JobStatus>) {
    if jobs.len() <= MAX_TRACKED_JOBS {
        return;
    }
    let mut finished: Vec<(String, u64)> = jobs
        .values()
        .filter(|job| matches!(job.status.as_str(), "completed" | "failed"))
        .map(|job| (job.id.clone(), job_started_timestamp(job)))
        .collect();
    finished.sort_by_key(|(_, started_at)| *started_at);
    for (job_id, _) in finished {
        if jobs.len() <= MAX_TRACKED_JOBS {
            break;
        }
        jobs.remove(&job_id);
    }
}

pub(crate) async fn update_job_running(state: &AppState, job_id: &str) {
    if let Some(job) = state.jobs.write().await.get_mut(job_id) {
        job.status = "running".to_string();
    }
}

pub(crate) async fn update_job_output(state: &AppState, job_id: &str, text: &str) {
    if let Some(job) = state.jobs.write().await.get_mut(job_id) {
        job.output.push_str(text);
        if job.output.len() > MAX_JOB_OUTPUT_BYTES {
            job.output = text_tail(&job.output, MAX_JOB_OUTPUT_BYTES);
        }
    }
}

pub(crate) async fn append_job_command_output(
    state: &AppState,
    job_id: &str,
    output: &std::process::Output,
) {
    update_job_output(state, job_id, &command_output_text(output)).await;
}

pub(crate) async fn update_job_finished(
    state: &AppState,
    job_id: &str,
    status: &str,
    exit_code: Option<i32>,
    error: Option<String>,
) {
    let mut jobs = state.jobs.write().await;
    if let Some(job) = jobs.get_mut(job_id) {
        job.status = status.to_string();
        job.finished_at = Some(unix_now_millis().to_string());
        job.exit_code = exit_code;
        job.error = error;
    }
    prune_finished_jobs(&mut jobs);
}
