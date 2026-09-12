//! Durable, one-time sync queue entries. Host-local and excluded from backups.
use crate::*;
use chrono::{DateTime, Days, LocalResult, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;

const MAX_LATENESS_MS: u64 = 15 * 60 * 1000;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;
const YEAR_MS: u64 = 366 * DAY_MS;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncSchedule {
    book_id: String,
    run_at: u64,
    status: String,
    job_id: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScheduleRequest {
    run_at: u64,
}

/// The nightly library sweep: one durable rule, not one entry per book.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct SyncSweep {
    enabled: bool,
    /// Administrator-selected wall-clock time and IANA zone. Keeping the rule
    /// rather than just its next instant preserves that time through DST.
    local_time: String,
    time_zone: String,
    next_run_at: u64,
    last_run_at: Option<u64>,
    last_queued: Option<usize>,
    last_error: Option<String>,
}

/// The rule plus what it would do right now. The counts are derived on read,
/// never stored, so they cannot go stale against the library.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SweepStatus {
    #[serde(flatten)]
    sweep: SyncSweep,
    /// Eligible books with no aligned map: what the next sweep would queue.
    pending_count: usize,
    /// Every book the sweep considers, synced or not.
    eligible_count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SweepRequest {
    enabled: bool,
    local_time: String,
    time_zone: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SweepRun {
    queued: usize,
    /// Books the sweep passed over because they were already queued or running.
    skipped: usize,
    error: Option<String>,
}

async fn load(state: &AppState) -> Result<Vec<SyncSchedule>, ApiError> {
    match fs::read(state.database_path.with_file_name("sync-schedules.json")).await {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}

async fn save(state: &AppState, entries: &[SyncSchedule]) -> Result<(), ApiError> {
    write_json_atomic(
        &state.database_path.with_file_name("sync-schedules.json"),
        &entries,
    )
    .await
}

async fn load_sweep(state: &AppState) -> Result<SyncSweep, ApiError> {
    match fs::read(state.database_path.with_file_name("sync-sweep.json")).await {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(SyncSweep::default()),
        Err(error) => Err(error.into()),
    }
}

async fn save_sweep(state: &AppState, sweep: &SyncSweep) -> Result<(), ApiError> {
    write_json_atomic(
        &state.database_path.with_file_name("sync-sweep.json"),
        sweep,
    )
    .await
}

fn parse_sweep_rule(local_time: &str, time_zone: &str) -> Result<(NaiveTime, Tz), ApiError> {
    let time = NaiveTime::parse_from_str(local_time, "%H:%M")
        .map_err(|_| ApiError::bad_request("Choose a valid time of day."))?;
    let zone = time_zone
        .parse::<Tz>()
        .map_err(|_| ApiError::bad_request("Choose a valid IANA time zone."))?;
    Ok((time, zone))
}

/// Resolve one local calendar occurrence. During a fall-back overlap, the
/// first occurrence wins so one local night never runs twice. During a
/// spring-forward gap, use the first real instant after the missing time.
fn occurrence_on(date: NaiveDate, time: NaiveTime, zone: Tz) -> Option<DateTime<Tz>> {
    let requested = date.and_time(time);
    for minute in 0..=180 {
        let candidate = requested.checked_add_signed(chrono::Duration::minutes(minute))?;
        match zone.from_local_datetime(&candidate) {
            LocalResult::Single(value) => return Some(value),
            LocalResult::Ambiguous(first, second) => return Some(first.min(second)),
            LocalResult::None => {}
        }
    }
    None
}

fn timestamp_millis(value: DateTime<Tz>) -> Result<u64, ApiError> {
    u64::try_from(value.timestamp_millis())
        .map_err(|_| ApiError::bad_request("The nightly sync time is outside the supported range."))
}

fn utc_at(now: u64) -> Result<DateTime<Utc>, ApiError> {
    let millis = i64::try_from(now)
        .map_err(|_| ApiError::bad_request("The current time is outside the supported range."))?;
    DateTime::from_timestamp_millis(millis)
        .ok_or_else(|| ApiError::bad_request("The current time is outside the supported range."))
}

fn next_occurrence(local_time: &str, time_zone: &str, now: u64) -> Result<u64, ApiError> {
    let (time, zone) = parse_sweep_rule(local_time, time_zone)?;
    let local_now = utc_at(now)?.with_timezone(&zone);
    for offset in 0..=2 {
        let Some(date) = local_now.date_naive().checked_add_days(Days::new(offset)) else {
            continue;
        };
        let requested = date.and_time(time);
        match zone.from_local_datetime(&requested) {
            LocalResult::Ambiguous(first, second) => {
                for candidate in [first.min(second), first.max(second)] {
                    let instant = timestamp_millis(candidate)?;
                    if instant > now {
                        return Ok(instant);
                    }
                }
            }
            _ => {
                if let Some(candidate) = occurrence_on(date, time, zone) {
                    let instant = timestamp_millis(candidate)?;
                    if instant > now {
                        return Ok(instant);
                    }
                }
            }
        }
    }
    Err(ApiError::bad_request(
        "Could not calculate the next nightly sync.",
    ))
}

fn advance_occurrence(
    local_time: &str,
    time_zone: &str,
    scheduled: u64,
    now: u64,
) -> Result<u64, ApiError> {
    let (time, zone) = parse_sweep_rule(local_time, time_zone)?;
    let first_new_date = utc_at(scheduled)?
        .with_timezone(&zone)
        .date_naive()
        .checked_add_days(Days::new(1))
        .ok_or_else(|| ApiError::bad_request("Could not calculate the next nightly sync."))?;
    let today = utc_at(now)?.with_timezone(&zone).date_naive();
    let mut date = first_new_date.max(today);
    for _ in 0..=1 {
        if let Some(candidate) = occurrence_on(date, time, zone) {
            let instant = timestamp_millis(candidate)?;
            if instant > now {
                return Ok(instant);
            }
        }
        date = date
            .checked_add_days(Days::new(1))
            .ok_or_else(|| ApiError::bad_request("Could not calculate the next nightly sync."))?;
    }
    Err(ApiError::bad_request(
        "Could not calculate the next nightly sync.",
    ))
}

pub(crate) async fn list(
    State(state): State<AppState>,
    _: AdminUser,
) -> Result<Json<Vec<SyncSchedule>>, ApiError> {
    let _guard = state.sync_schedule_lock.lock().await;
    Ok(Json(load(&state).await?))
}

pub(crate) async fn schedule(
    State(state): State<AppState>,
    _: AdminUser,
    Path(book_id): Path<String>,
    Json(request): Json<ScheduleRequest>,
) -> Result<Json<SyncSchedule>, ApiError> {
    let now = unix_now_millis();
    if request.run_at <= now || request.run_at > now.saturating_add(366 * 24 * 60 * 60 * 1000) {
        return Err(ApiError::bad_request(
            "Choose a future time within the next year.",
        ));
    }
    {
        let library = state.library.read().await;
        let book = library.book(&book_id)?;
        if book
            .reading_file
            .as_ref()
            .is_none_or(|file| file.extension != "epub")
            || book.tracks.is_empty()
        {
            return Err(ApiError::bad_request(
                "Sync needs audio tracks and an EPUB companion.",
            ));
        }
    }
    if state
        .update_manager
        .sync_addon_runtime(state.alignment_config.cli_path.as_deref())
        .await
        .is_none()
    {
        return Err(ApiError::bad_request(
            "Enable Follow along before scheduling a sync.",
        ));
    }
    let _guard = state.sync_schedule_lock.lock().await;
    if state.jobs.read().await.values().any(|job| {
        job.kind == "sync-generate"
            && job.target_id.as_ref() == Some(&book_id)
            && matches!(job.status.as_str(), "queued" | "running")
    }) {
        return Err(ApiError::conflict(
            "This book is already queued or syncing.",
        ));
    }
    let mut entries = load(&state).await?;
    entries.retain(|entry| entry.book_id != book_id);
    let entry = SyncSchedule {
        book_id,
        run_at: request.run_at,
        status: "scheduled".into(),
        job_id: None,
        error: None,
    };
    entries.push(entry.clone());
    entries.sort_by_key(|entry| entry.run_at);
    save(&state, &entries).await?;
    Ok(Json(entry))
}

pub(crate) async fn cancel(
    State(state): State<AppState>,
    _: AdminUser,
    Path(book_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let _guard = state.sync_schedule_lock.lock().await;
    let mut entries = load(&state).await?;
    if entries.iter().any(|entry| {
        entry.book_id == book_id && matches!(entry.status.as_str(), "dispatching" | "submitted")
    }) {
        return Err(ApiError::conflict(
            "This sync has already joined the queue and cannot be cancelled here.",
        ));
    }
    entries.retain(|entry| entry.book_id != book_id);
    save(&state, &entries).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Books the sweep would work on: audio plus an EPUB companion, and no map
/// that came from real alignment. An `estimated` map is interpolated rather
/// than aligned, so it still counts as needing a sync.
async fn sweep_targets(state: &AppState) -> (Vec<String>, usize) {
    let library = state.library.read().await;
    let eligible: Vec<&Book> = library
        .books
        .iter()
        .filter(|book| {
            book.reading_file
                .as_ref()
                .is_some_and(|file| file.extension == "epub")
                && !book.tracks.is_empty()
        })
        .collect();
    let eligible_count = eligible.len();
    let pending = eligible
        .into_iter()
        .filter(|book| {
            book.sync_file
                .as_ref()
                .is_none_or(|file| !matches!(file.source.as_str(), "generated" | "sidecar"))
        })
        .map(|book| book.id.clone())
        .collect();
    (pending, eligible_count)
}

/// Queue every pending book, skipping any the queue already holds. Errors on a
/// single book must not abandon the rest of the library, so the first message
/// is reported and the sweep carries on.
async fn run_sweep(state: &AppState) -> SweepRun {
    let (targets, _) = sweep_targets(state).await;
    let mut queued = 0;
    let mut skipped = 0;
    let mut error = None;
    for book_id in targets {
        let busy = state.jobs.read().await.values().any(|job| {
            job.kind == "sync-generate"
                && job.target_id.as_ref() == Some(&book_id)
                && matches!(job.status.as_str(), "queued" | "running")
        });
        if busy {
            skipped += 1;
            continue;
        }
        match crate::sync::enqueue_sync_map(state.clone(), book_id).await {
            Ok(_) => queued += 1,
            Err(failure) => {
                if error.is_none() {
                    error = Some(failure.message);
                }
            }
        }
    }
    SweepRun {
        queued,
        skipped,
        error,
    }
}

pub(crate) async fn sweep(
    State(state): State<AppState>,
    _: AdminUser,
) -> Result<Json<SweepStatus>, ApiError> {
    let _guard = state.sync_schedule_lock.lock().await;
    let sweep = load_sweep(&state).await?;
    let (pending, eligible_count) = sweep_targets(&state).await;
    Ok(Json(SweepStatus {
        sweep,
        pending_count: pending.len(),
        eligible_count,
    }))
}

pub(crate) async fn set_sweep(
    State(state): State<AppState>,
    _: AdminUser,
    Json(request): Json<SweepRequest>,
) -> Result<Json<SweepStatus>, ApiError> {
    let _guard = state.sync_schedule_lock.lock().await;
    let now = unix_now_millis();
    let next_run_at = request
        .enabled
        .then(|| next_occurrence(&request.local_time, &request.time_zone, now))
        .transpose()?;
    let mut sweep = load_sweep(&state).await?;
    sweep.enabled = request.enabled;
    if let Some(next_run_at) = next_run_at {
        if next_run_at > now.saturating_add(YEAR_MS) {
            return Err(ApiError::bad_request(
                "Choose a nightly sync time within the next year.",
            ));
        }
        sweep.local_time = request.local_time;
        sweep.time_zone = request.time_zone;
        sweep.next_run_at = next_run_at;
        // A fresh start time answers whatever the last run complained about.
        sweep.last_error = None;
    }
    save_sweep(&state, &sweep).await?;
    let (pending, eligible_count) = sweep_targets(&state).await;
    Ok(Json(SweepStatus {
        sweep,
        pending_count: pending.len(),
        eligible_count,
    }))
}

pub(crate) async fn run_sweep_now(
    State(state): State<AppState>,
    _: AdminUser,
) -> Result<Json<SweepRun>, ApiError> {
    if state
        .update_manager
        .sync_addon_runtime(state.alignment_config.cli_path.as_deref())
        .await
        .is_none()
    {
        return Err(ApiError::bad_request(
            "Enable Follow along before running a sync.",
        ));
    }
    if !state.library.read().await.catalogue_ready {
        return Err(ApiError::service_unavailable(
            "The library is still being scanned.",
        ));
    }
    let _guard = state.sync_schedule_lock.lock().await;
    let result = run_sweep(&state).await;
    let mut sweep = load_sweep(&state).await?;
    sweep.last_run_at = Some(unix_now_millis());
    sweep.last_queued = Some(result.queued);
    sweep.last_error = result.error.clone();
    save_sweep(&state, &sweep).await?;
    Ok(Json(result))
}

async fn tick_sweep(state: &AppState) -> Result<(), ApiError> {
    let mut sweep = load_sweep(state).await?;
    let now = unix_now_millis();
    if !sweep.enabled || now < sweep.next_run_at {
        return Ok(());
    }
    if !state.library.read().await.catalogue_ready {
        return Ok(());
    }
    // Too late to be the night that was asked for: skip to the next one rather
    // than starting a library-wide job in the middle of someone's morning.
    if now - sweep.next_run_at > MAX_LATENESS_MS {
        sweep.next_run_at =
            advance_occurrence(&sweep.local_time, &sweep.time_zone, sweep.next_run_at, now)?;
        sweep.last_error = Some(
            "The server missed a nightly sweep by more than 15 minutes. The next one is scheduled."
                .into(),
        );
        return save_sweep(state, &sweep).await;
    }
    sweep.next_run_at =
        advance_occurrence(&sweep.local_time, &sweep.time_zone, sweep.next_run_at, now)?;
    sweep.last_run_at = Some(now);
    sweep.last_queued = None;
    sweep.last_error = None;
    // Claim the slot before queueing: a crash midway must not repeat the sweep
    // on restart. Clearing the prior outcome also prevents a claimed-but-
    // interrupted run from displaying the preceding night's result as its own.
    save_sweep(state, &sweep).await?;
    let result = run_sweep(state).await;
    sweep.last_queued = Some(result.queued);
    sweep.last_error = result.error;
    save_sweep(state, &sweep).await
}

fn due_status(entry: &SyncSchedule, now: u64) -> Option<&'static str> {
    if entry.status != "scheduled" || now < entry.run_at {
        return None;
    }
    Some(if now.saturating_sub(entry.run_at) > MAX_LATENESS_MS {
        "missed"
    } else {
        "dispatching"
    })
}

pub(crate) async fn tick(state: &AppState) -> Result<(), ApiError> {
    let _guard = state.sync_schedule_lock.lock().await;
    let mut entries = load(state).await?;
    let now = unix_now_millis();
    let ready = state.library.read().await.catalogue_ready;
    for index in 0..entries.len() {
        if entries[index].status == "submitted" {
            let jobs = state.jobs.read().await;
            let job = entries[index].job_id.as_ref().and_then(|id| jobs.get(id));
            match job {
                Some(job) if job.status == "completed" => {
                    entries[index].status = "completed".into()
                }
                Some(job) if job.status == "failed" => {
                    entries[index].status = "failed".into();
                    entries[index].error =
                        Some("Scheduled sync failed. See sync activity, then retry.".into());
                }
                None => {
                    entries[index].status = "failed".into();
                    entries[index].error = Some("Server restarted after this sync was queued. Check the book’s sync status before retrying.".into());
                }
                _ => continue,
            }
            drop(jobs);
            save(state, &entries).await?;
            continue;
        }
        // A crash between the durable claim and queue creation must not silently
        // run a book twice. Keep an explicit result for the administrator.
        if entries[index].status == "dispatching" {
            entries[index].status = "failed".into();
            entries[index].error =
                Some("Server stopped while submitting this sync. Schedule it again.".into());
            save(state, &entries).await?;
            continue;
        }
        let Some(status) = due_status(&entries[index], now) else {
            continue;
        };
        if status == "dispatching" && !ready {
            continue;
        }
        entries[index].status = status.into();
        if status == "missed" {
            entries[index].error = Some(
                "The server missed this start time by more than 15 minutes. Schedule it again."
                    .into(),
            );
            save(state, &entries).await?;
            continue;
        }
        save(state, &entries).await?;
        match crate::sync::enqueue_sync_map(state.clone(), entries[index].book_id.clone()).await {
            Ok(Json(job)) => {
                entries[index].status = "submitted".into();
                entries[index].job_id = Some(job.job_id);
            }
            Err(error) => {
                entries[index].status = "failed".into();
                entries[index].error = Some(error.message);
            }
        }
        save(state, &entries).await?;
    }
    // Keep the same lock for the sweep. This serializes the durable claim with
    // manual runs and rule edits, so no caller can queue or overwrite the same
    // nightly slot while it is being advanced.
    tick_sweep(state).await
}

pub(crate) fn start(state: AppState) {
    tokio::spawn(async move {
        let mut shutdown = state.shutdown.subscribe();
        let mut interval = tokio::time::interval(Duration::from_secs(15));
        loop {
            tokio::select! {
                _ = shutdown.recv() => break,
                _ = interval.tick() => {
                    if let Err(error) = tick(&state).await {
                        tracing::error!(?error, "could not process sync schedules");
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Timelike;

    #[test]
    fn schedules_only_dispatch_near_their_start_time() {
        let mut entry = SyncSchedule {
            book_id: "book".into(),
            run_at: 1000,
            status: "scheduled".into(),
            job_id: None,
            error: None,
        };
        assert_eq!(due_status(&entry, 999), None);
        assert_eq!(due_status(&entry, 1000), Some("dispatching"));
        assert_eq!(
            due_status(&entry, 1000 + MAX_LATENESS_MS),
            Some("dispatching")
        );
        assert_eq!(due_status(&entry, 1001 + MAX_LATENESS_MS), Some("missed"));
        entry.status = "submitted".into();
        assert_eq!(due_status(&entry, 1000), None);
    }

    #[test]
    fn nightly_rule_stays_at_the_same_wall_clock_time_across_dst() {
        let zone: Tz = "America/New_York".parse().unwrap();
        let march_seventh = zone.with_ymd_and_hms(2026, 3, 7, 1, 0, 0).single().unwrap();
        let march_eighth = advance_occurrence(
            "01:00",
            "America/New_York",
            u64::try_from(march_seventh.timestamp_millis()).unwrap(),
            u64::try_from(march_seventh.timestamp_millis()).unwrap(),
        )
        .unwrap();
        let march_ninth =
            advance_occurrence("01:00", "America/New_York", march_eighth, march_eighth).unwrap();
        let next = utc_at(march_ninth).unwrap().with_timezone(&zone);
        assert_eq!((next.hour(), next.minute()), (1, 0));
        assert_eq!(march_ninth - march_eighth, 23 * 60 * 60 * 1000);
    }

    #[test]
    fn a_missed_night_advances_to_the_next_one_without_replaying() {
        let zone: Tz = "America/New_York".parse().unwrap();
        let missed = zone.with_ymd_and_hms(2026, 3, 6, 1, 0, 0).single().unwrap();
        let now = zone.with_ymd_and_hms(2026, 3, 9, 9, 0, 0).single().unwrap();
        let next = advance_occurrence(
            "01:00",
            "America/New_York",
            u64::try_from(missed.timestamp_millis()).unwrap(),
            u64::try_from(now.timestamp_millis()).unwrap(),
        )
        .unwrap();
        let next = utc_at(next).unwrap().with_timezone(&zone);
        assert_eq!(
            next.naive_local(),
            NaiveDate::from_ymd_opt(2026, 3, 10)
                .unwrap()
                .and_hms_opt(1, 0, 0)
                .unwrap()
        );
        assert!(u64::try_from(missed.timestamp_millis()).unwrap() < next.timestamp_millis() as u64);
    }

    #[test]
    fn a_missed_fall_back_run_does_not_use_the_repeated_hour() {
        let zone: Tz = "America/New_York".parse().unwrap();
        let scheduled = zone
            .with_ymd_and_hms(2026, 11, 1, 1, 0, 0)
            .earliest()
            .unwrap();
        let now = zone
            .with_ymd_and_hms(2026, 11, 1, 1, 30, 0)
            .earliest()
            .unwrap();
        let next = advance_occurrence(
            "01:00",
            "America/New_York",
            u64::try_from(scheduled.timestamp_millis()).unwrap(),
            u64::try_from(now.timestamp_millis()).unwrap(),
        )
        .unwrap();
        let next = utc_at(next).unwrap().with_timezone(&zone);
        assert_eq!(
            next.date_naive(),
            NaiveDate::from_ymd_opt(2026, 11, 2).unwrap()
        );
    }
}
