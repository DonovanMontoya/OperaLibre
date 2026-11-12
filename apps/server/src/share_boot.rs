//! Opt-in startup supervision for retained gifts. The caller passes the
//! owner's experiment switch, so saved settings alone cannot start a transfer.
use super::*;

const BOOT_LIFETIME: Duration = Duration::from_secs(900);
const RETRY_INTERVAL: Duration = Duration::from_secs(30);

pub(crate) fn start_boot_recovery(
    state: AppState,
    enabled: bool,
) -> Option<tokio::task::JoinHandle<()>> {
    start(state, enabled, None)
}

/// Observe completion without polling the private file-backed index and
/// competing with its OS write lock.
#[cfg(test)]
pub(crate) fn observe_boot_recovery(
    state: AppState,
    first_pass: tokio::sync::oneshot::Sender<bool>,
) -> Option<tokio::task::JoinHandle<()>> {
    start(state, true, Some(first_pass))
}

fn start(
    state: AppState,
    enabled: bool,
    mut first_pass: Option<tokio::sync::oneshot::Sender<bool>>,
) -> Option<tokio::task::JoinHandle<()>> {
    if !enabled {
        return None;
    }
    // Subscribe before spawning: a shutdown between admission and the first
    // poll must not turn into an outbound recovery request.
    let mut shutdown = state.shutdown.subscribe();
    Some(tokio::spawn(async move {
        let deadline = tokio::time::Instant::now() + BOOT_LIFETIME;
        let configuration = tokio::select! {
            biased;
            _ = shutdown.recv() => return,
            _ = tokio::time::sleep_until(deadline) => return,
            result = async {
                let _gate = SETUP_GATE.lock().await;
                load(&state).await
            } => result,
        };
        {
            match configuration {
                Ok(Some(config)) if config.auto_recover_senders && config.retain_sender_state => {}
                Ok(_) => return,
                Err(_) => {
                    tracing::warn!("Retained gift startup configuration is unavailable.");
                    return;
                }
            }
        }
        let ready = tokio::select! {
            biased;
            _ = shutdown.recv() => false,
            result = tokio::time::timeout_at(deadline,
                crate::libation_recovery::wait_for_library(&state, state.shutdown.subscribe())) => result.unwrap_or(false),
        };
        if !ready {
            return;
        }
        loop {
            // Never log configuration, provider errors, room IDs or keys.
            let result = tokio::select! {
                biased;
                _ = shutdown.recv() => {
                    crate::share::pause_sender_runtime(&state).await;
                    return;
                }
                _ = tokio::time::sleep_until(deadline) => return,
                result = recovery_pass(&state) => result,
            };
            if let Some(observer) = first_pass.take() {
                let _ = observer.send(matches!(result, Ok(true)));
            }
            match result {
                Ok(false) => return,
                Ok(true) => {}
                Err(_) => tracing::warn!("Retained gift startup recovery remains pending."),
            }
            tokio::select! {
                biased;
                _ = shutdown.recv() => {
                    crate::share::pause_sender_runtime(&state).await;
                    return;
                }
                _ = tokio::time::sleep_until(deadline) => return,
                _ = tokio::time::sleep(RETRY_INTERVAL) => {},
            }
        }
    }))
}

async fn recovery_pass(state: &AppState) -> Result<bool, ApiError> {
    let _gate = SETUP_GATE.lock().await;
    // Checked on every pass: the owner can turn gifts off while this runs.
    if !experiment_enabled(state).await {
        return Ok(false);
    }
    let Some(config) = load(state).await? else {
        return Ok(false);
    };
    if !config.auto_recover_senders || !config.retain_sender_state {
        return Ok(false);
    }
    let broker = configured_broker(&config.broker_origin)
        .map_err(|_| ApiError::service_unavailable("Gift broker configuration is invalid."))?;
    crate::share::recover_saved_senders(
        true,
        state,
        &broker,
        &config.owner_secret,
        &config.connectivity,
    )
    .await?;
    // A prior explicit revoke remains durable intent. This retry preserves
    // recoverable dormant rooms, and never extends an invitation's expiry.
    crate::share::retry_revocations_for_owner(state, &broker, &config.owner_secret).await?;
    crate::share::prune_confirmed_recovery(state).await?;
    Ok(true)
}
