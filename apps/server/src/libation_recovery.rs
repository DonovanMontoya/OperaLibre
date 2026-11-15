//! Durable download intent, including the access grant that follows acquisition.

use crate::*;

pub(crate) async fn start(
    state: &AppState,
    profile_id: Option<String>,
    asin: String,
    grant_to_user: Option<String>,
    initiated_by: Option<String>,
) -> Result<Json<JobCreated>, ApiError> {
    let pending = PendingLibationDownload {
        id: generate_session_token(),
        initiated_by: initiated_by.or_else(|| grant_to_user.clone()),
        job_id: None,
        profile_id,
        asin,
        grant_to_user,
    };
    let existing = state
        .libation_refreshes
        .mutate(|store| {
            if let Some(job_id) = admit_download(&store.pending_downloads, &pending)? {
                return Ok(Some(job_id));
            }
            store.pending_downloads.push(pending.clone());
            Ok(None)
        })
        .await?;
    if let Some(job_id) = existing {
        if !state.jobs.read().await.contains_key(&job_id) {
            return Err(ApiError::conflict(
                "This download is awaiting recovery. Try again shortly.",
            ));
        }
        return Ok(Json(JobCreated { job_id }));
    }
    dispatch(state, pending, false)
        .await
        .map(|(created, _)| created)
}

fn admit_download(
    downloads: &[PendingLibationDownload],
    pending: &PendingLibationDownload,
) -> Result<Option<String>, ApiError> {
    if let Some(existing) = downloads.iter().find(|existing| {
        existing.profile_id == pending.profile_id
            && existing.asin.eq_ignore_ascii_case(&pending.asin)
            && existing.grant_to_user == pending.grant_to_user
            && existing.initiated_by == pending.initiated_by
    }) {
        return existing.job_id.clone().map(Some).ok_or_else(|| {
            ApiError::conflict("This download is being queued. Try again shortly.")
        });
    }
    let user = pending
        .initiated_by
        .as_ref()
        .or(pending.grant_to_user.as_ref());
    if downloads.len() >= MAX_TRACKED_LIBATION_REQUESTS
        || downloads
            .iter()
            .filter(|existing| {
                existing
                    .initiated_by
                    .as_ref()
                    .or(existing.grant_to_user.as_ref())
                    == user
            })
            .count()
            >= MAX_PENDING_LIBATION_REQUESTS_PER_USER
    {
        return Err(ApiError::too_many_requests(
            "Too many unfinished Libation downloads. Try again after queued downloads finish.",
        ));
    }
    Ok(None)
}

#[cfg(all(test, unix))]
mod admission_tests {
    use super::*;

    fn pending(index: usize, user: &str) -> PendingLibationDownload {
        PendingLibationDownload {
            id: format!("pending-{index}"),
            initiated_by: Some(user.to_string()),
            job_id: None,
            profile_id: None,
            asin: format!("B{index:09}"),
            grant_to_user: Some(user.to_string()),
        }
    }

    #[tokio::test]
    async fn libation_admission_rejects_excess_without_persisting_or_creating_jobs() {
        let root = tempfile::tempdir().unwrap();
        let (state, _) = crate::unit_tests::fake_libation_state(root.path());
        for (count, same_user) in [(100, true), (1_000, false)] {
            state
                .libation_refreshes
                .mutate(|store| {
                    store.pending_downloads = (0..count)
                        .map(|index| pending(index, if same_user { "reader" } else { "other" }))
                        .collect();
                    Ok(())
                })
                .await
                .unwrap();
            let error = start(
                &state,
                None,
                "B999999999".to_string(),
                Some("reader".to_string()),
                Some("reader".to_string()),
            )
            .await
            .unwrap_err();
            assert_eq!(error.status, StatusCode::TOO_MANY_REQUESTS);
            let snapshot = load_cached_snapshot(&state.database).await.unwrap();
            assert_eq!(snapshot.libation_refreshes.pending_downloads.len(), count);
            assert!(state.jobs.read().await.is_empty());
        }
    }

    #[tokio::test]
    async fn libation_admission_serializes_the_last_user_slot() {
        let root = tempfile::tempdir().unwrap();
        let (state, _) = crate::unit_tests::fake_libation_state(root.path());
        state
            .libation_refreshes
            .mutate(|store| {
                store.pending_downloads = (0..99).map(|index| pending(index, "reader")).collect();
                Ok(())
            })
            .await
            .unwrap();
        let registration = state.libation_account_registration_lock.lock().await;
        let mut attempts = tokio::task::JoinSet::new();
        for asin in ["B999999998", "B999999999"] {
            let state = state.clone();
            attempts.spawn(async move {
                start(
                    &state,
                    None,
                    asin.to_string(),
                    Some("reader".to_string()),
                    Some("reader".to_string()),
                )
                .await
            });
        }
        let rejected = tokio::time::timeout(Duration::from_secs(2), attempts.join_next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(rejected.status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            state
                .libation_refreshes
                .read()
                .await
                .pending_downloads
                .len(),
            100
        );
        assert!(state.jobs.read().await.is_empty());
        drop(registration);
        let accepted = attempts.join_next().await.unwrap().unwrap().unwrap();
        assert!(!accepted.job_id.is_empty());
    }

    #[test]
    fn libation_admission_reuses_duplicates_at_capacity_and_counts_legacy_readers() {
        let mut downloads = (0..100)
            .map(|index| pending(index, "reader"))
            .collect::<Vec<_>>();
        downloads[0].job_id = Some("existing-job".to_string());
        let mut duplicate = pending(0, "reader");
        duplicate.asin.make_ascii_lowercase();
        assert_eq!(
            admit_download(&downloads, &duplicate).unwrap(),
            Some("existing-job".to_string())
        );
        for download in &mut downloads {
            download.initiated_by = None;
        }
        assert_eq!(
            admit_download(&downloads, &pending(101, "reader"))
                .unwrap_err()
                .status,
            StatusCode::TOO_MANY_REQUESTS
        );
        assert!(
            admit_download(&downloads, &pending(101, "another-reader"))
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn libation_recovery_does_not_materialize_an_oversized_saved_queue() {
        let root = tempfile::tempdir().unwrap();
        let (state, _) = crate::unit_tests::fake_libation_state(root.path());
        state
            .libation_refreshes
            .mutate(|store| {
                store.pending_downloads = (0..105)
                    .map(|index| {
                        let mut download = pending(index, "reader");
                        download.grant_to_user = None;
                        download
                    })
                    .collect();
                Ok(())
            })
            .await
            .unwrap();
        let snapshot = load_cached_snapshot(&state.database).await.unwrap();
        let (restarted, _) = crate::unit_tests::fake_libation_state(root.path());
        restarted
            .libation_refreshes
            .adopt_restored(snapshot.libation_refreshes)
            .await;
        let execution = restarted.libation_job_lock.lock().await;
        recover(restarted.clone());
        tokio::time::timeout(Duration::from_secs(2), async {
            while restarted.jobs.read().await.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(restarted.jobs.read().await.len(), 1);
        assert_eq!(
            restarted
                .libation_refreshes
                .read()
                .await
                .pending_downloads
                .len(),
            105
        );
        restarted.shutdown.send(()).unwrap();
        drop(execution);
    }

    #[tokio::test]
    async fn libation_admission_retains_reservation_after_a_grant_fails() {
        let root = tempfile::tempdir().unwrap();
        let (state, _) = crate::unit_tests::fake_libation_state(root.path());
        let execution = state.libation_job_lock.lock().await;
        let created = start(
            &state,
            None,
            "B000TEST09".to_string(),
            Some("reader".to_string()),
            Some("reader".to_string()),
        )
        .await
        .unwrap();
        update_job_finished(
            &state,
            &created.job_id,
            "failed",
            None,
            Some("grant wait expired".to_string()),
        )
        .await;
        assert!(
            state
                .jobs
                .read()
                .await
                .values()
                .any(|job| job.kind == "libation-liberate" && is_active_job(job))
        );
        state
            .libation_refreshes
            .mutate(|store| {
                store
                    .pending_downloads
                    .extend((0..99).map(|index| pending(index, "reader")));
                Ok(())
            })
            .await
            .unwrap();
        let rejected = start(
            &state,
            None,
            "B999999999".to_string(),
            Some("reader".to_string()),
            Some("reader".to_string()),
        )
        .await
        .unwrap_err();
        assert_eq!(rejected.status, StatusCode::TOO_MANY_REQUESTS);
        drop(execution);
        tokio::time::timeout(Duration::from_secs(3), async {
            while state
                .libation_refreshes
                .read()
                .await
                .pending_downloads
                .len()
                != 99
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}

pub(crate) async fn dispatch(
    state: &AppState,
    pending: PendingLibationDownload,
    report_failure: bool,
) -> Result<(Json<JobCreated>, String), ApiError> {
    let shutdown = state.shutdown.subscribe();
    let download_shutdown = state.shutdown.subscribe();
    let result = start_libation_download_inner(
        state,
        pending.profile_id.clone(),
        pending.asin.clone(),
        pending.grant_to_user.clone(),
    )
    .await;
    match result {
        Ok((created, download_job_id)) => {
            if let Err(error) = state
                .libation_refreshes
                .mutate(|store| {
                    if let Some(stored) = store
                        .pending_downloads
                        .iter_mut()
                        .find(|stored| stored.id == pending.id)
                    {
                        stored.job_id = Some(created.job_id.clone());
                    }
                    Ok(())
                })
                .await
            {
                tracing::warn!(
                    "could not save Libation download job identity: {}",
                    error.message
                );
            }
            let state = state.clone();
            let job_id = created.job_id.clone();
            let underlying_job_id = download_job_id.clone();
            tokio::spawn(async move {
                if !wait_for_terminal(&state, &underlying_job_id, download_shutdown).await {
                    return;
                }
                if !wait_for_terminal(&state, &job_id, shutdown).await {
                    return;
                }
                if let Err(error) = remove_pending(&state, &pending.id).await {
                    tracing::warn!(
                        "could not save Libation download completion: {}",
                        error.message
                    );
                }
            });
            Ok((created, download_job_id))
        }
        Err(error) => {
            if report_failure {
                let target = pending
                    .profile_id
                    .as_ref()
                    .map(|profile| format!("{profile}:{}", pending.asin));
                let (job_id, _) =
                    create_job_with_state(state, "libation-liberate", target, "running", false)
                        .await;
                update_job_finished(state, &job_id, "failed", None, Some(error.message.clone()))
                    .await;
            }
            remove_pending(state, &pending.id).await?;
            Err(error)
        }
    }
}

async fn remove_pending(state: &AppState, id: &str) -> Result<(), ApiError> {
    state
        .libation_refreshes
        .mutate(|store| {
            store.pending_downloads.retain(|pending| pending.id != id);
            Ok(())
        })
        .await
}

pub(crate) async fn wait_for_terminal(
    state: &AppState,
    job_id: &str,
    mut shutdown: tokio::sync::broadcast::Receiver<()>,
) -> bool {
    loop {
        tokio::select! {
            biased;
            _ = shutdown.recv() => return false,
            _ = await_job_outcome(state, job_id) => {},
        }
        if state
            .jobs
            .read()
            .await
            .get(job_id)
            .is_none_or(|job| !is_active_job(job))
        {
            return matches!(
                shutdown.try_recv(),
                Err(tokio::sync::broadcast::error::TryRecvError::Empty)
            );
        }
    }
}

pub(crate) async fn wait_for_library(
    state: &AppState,
    mut shutdown: tokio::sync::broadcast::Receiver<()>,
) -> bool {
    loop {
        if !matches!(
            shutdown.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ) {
            return false;
        }
        if state.library.read().await.catalogue_ready {
            return matches!(
                shutdown.try_recv(),
                Err(tokio::sync::broadcast::error::TryRecvError::Empty)
            );
        }
        tokio::select! {
            biased;
            _ = shutdown.recv() => return false,
            _ = tokio::time::sleep(Duration::from_secs(1)) => {},
        }
    }
}

pub(crate) fn recover(state: AppState) {
    let shutdown = state.shutdown.subscribe();
    tokio::spawn(async move {
        if !wait_for_library(&state, shutdown).await {
            return;
        }
        if !state.libation_config.enabled() {
            // Keep intent when Libation is temporarily unavailable.
            return;
        }
        let pending = state
            .libation_refreshes
            .read()
            .await
            .pending_downloads
            .clone();
        for download in pending {
            // Older servers could persist unlimited intent. Drain that backlog
            // without materializing a task and job for every saved entry.
            let shutdown = state.shutdown.subscribe();
            let download_shutdown = state.shutdown.subscribe();
            match dispatch(&state, download, true).await {
                Ok((created, download_job_id)) => {
                    if !wait_for_terminal(&state, &download_job_id, download_shutdown).await
                        || !wait_for_terminal(&state, &created.job_id, shutdown).await
                    {
                        return;
                    }
                }
                Err(error) => {
                    tracing::warn!("could not recover Libation download: {}", error.message)
                }
            }
        }
        let approved = state
            .libation_requests
            .read()
            .await
            .requests
            .iter()
            .filter(|request| request.status == "approved")
            .cloned()
            .collect::<Vec<_>>();
        for request in approved {
            if let Err(error) = attach_approved_libation_download(&state, request).await {
                tracing::warn!(
                    "could not recover approved Libation request: {}",
                    error.message
                );
            }
        }
        let bulk_pending = state.libation_refreshes.read().await.bulk_download_pending;
        if bulk_pending && let Err(error) = start_all_libation_downloads(state.clone()).await {
            tracing::warn!(
                "could not recover bulk Libation download: {}",
                error.message
            );
        }
    });
}

pub(crate) async fn queue_new_purchases(
    state: &AppState,
    successful_profiles: &HashSet<String>,
) -> Result<(), ApiError> {
    let preferences = state.libation_refreshes.read().await.auto_imports.clone();
    if preferences.is_empty() {
        return Ok(());
    }
    let users = state.users.read().await;
    let permitted = preferences
        .into_iter()
        .filter(|(id, preference)| {
            successful_profiles.contains(id)
                && users.users.iter().any(|user| {
                    user.id == preference.enabled_by
                        && user.is_admin
                        && user.libation_access == LibationAccess::Direct
                })
        })
        .collect::<HashMap<_, _>>();
    drop(users);
    if permitted.is_empty() {
        return Ok(());
    }
    let mut purchases = Vec::new();
    let mut failures = Vec::new();
    for profile in all_libation_profiles(state).await {
        if !profile.managed || !permitted.contains_key(&profile.id) {
            continue;
        }
        match export_libation_books(&profile).await {
            Ok(books) => purchases.extend(
                books
                    .into_iter()
                    .filter(is_libation_purchase)
                    .map(|book| (book.profile_id, book.asin)),
            ),
            Err(error) => failures.push(error.message),
        }
    }
    for (id, ownership) in &state.libation_refreshes.read().await.legacy_ownership {
        if permitted.contains_key(id)
            && let Some(asins) = &ownership.purchased_asins
        {
            purchases.extend(asins.iter().map(|asin| (id.clone(), asin.clone())));
        }
    }
    let pending = state
        .libation_refreshes
        .mutate(|store| {
            let mut pending = Vec::new();
            for (profile_id, asin) in &purchases {
                let Some(preference) = store.auto_imports.get_mut(profile_id) else {
                    continue;
                };
                if preference.seen_asins.insert(asin.clone()) {
                    pending.push(PendingLibationDownload {
                        id: generate_session_token(),
                        initiated_by: Some(preference.enabled_by.clone()),
                        job_id: None,
                        profile_id: Some(profile_id.clone()),
                        asin: asin.clone(),
                        grant_to_user: None,
                    });
                }
            }
            // Save the baseline and the work together, before starting an external writer.
            store.pending_downloads.extend(pending.clone());
            Ok(pending)
        })
        .await?;
    for download in pending {
        if let Err(error) = dispatch(state, download, true).await {
            failures.push(error.message);
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(ApiError::bad_gateway(failures.join(" ")))
    }
}
