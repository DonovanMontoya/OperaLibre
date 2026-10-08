//! Durable download intent, including the access grant that follows acquisition.

use crate::*;

pub(crate) async fn start(
    state: &AppState,
    profile_id: Option<String>,
    asin: String,
    grant_to_user: Option<String>,
) -> Result<Json<JobCreated>, ApiError> {
    let pending = PendingLibationDownload {
        id: generate_session_token(),
        profile_id,
        asin,
        grant_to_user,
    };
    state
        .libation_refreshes
        .mutate(|store| {
            store.pending_downloads.push(pending.clone());
            Ok(())
        })
        .await?;
    dispatch(state, pending, false).await
}

pub(crate) async fn dispatch(
    state: &AppState,
    pending: PendingLibationDownload,
    report_failure: bool,
) -> Result<Json<JobCreated>, ApiError> {
    let shutdown = state.shutdown.subscribe();
    let result = start_libation_download_inner(
        state,
        pending.profile_id.clone(),
        pending.asin.clone(),
        pending.grant_to_user.clone(),
    )
    .await;
    match result {
        Ok(created) => {
            let state = state.clone();
            let job_id = created.job_id.clone();
            tokio::spawn(async move {
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
            Ok(created)
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
            if let Err(error) = dispatch(&state, download, true).await {
                tracing::warn!("could not recover Libation download: {}", error.message);
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
