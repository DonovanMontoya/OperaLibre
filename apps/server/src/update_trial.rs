//! A build the managed updater has just installed runs as a trial until the
//! updater commits it. The updater can still roll back to the previous build
//! and its data snapshot until then, so nothing a client sends may be
//! acknowledged: every dynamic route answers `503` with `Retry-After`, the
//! way clients already treat a server that is still starting, and work that
//! persists outside the snapshot waits for the commit. Only the health check
//! the updater polls and its commit route answer, plus the web app's static
//! files so a page reloaded meanwhile can load and wait.

use crate::*;

/// The variable the updater sets, to a random token, on a trial start only.
pub(crate) const UPDATE_TRIAL_ENV: &str = "OPERALIBRE_UPDATE_TRIAL";
/// The header carrying that token on the commit request.
pub(crate) const UPDATE_TRIAL_HEADER: &str = "x-operalibre-update-trial";
pub(crate) const UPDATE_TRIAL_COMMIT_PATH: &str = "/api/update-trial/commit";

pub(crate) struct UpdateTrial {
    token: Option<String>,
    committed: tokio::sync::watch::Sender<bool>,
    /// Serialises commits, so a retried request cannot run queue recovery
    /// twice or report success before the first one finished.
    commit: Mutex<()>,
}

impl UpdateTrial {
    /// No trial: committed from the start.
    #[cfg(test)]
    pub(crate) fn none() -> Self {
        Self::with_token(None)
    }

    pub(crate) fn from_env() -> Self {
        Self::with_token(
            env::var(UPDATE_TRIAL_ENV)
                .ok()
                .filter(|token| !token.is_empty()),
        )
    }

    pub(crate) fn with_token(token: Option<String>) -> Self {
        let (committed, _) = tokio::sync::watch::channel(token.is_none());
        Self {
            token,
            committed,
            commit: Mutex::new(()),
        }
    }

    pub(crate) fn is_trial(&self) -> bool {
        self.token.is_some()
    }

    pub(crate) fn is_committed(&self) -> bool {
        *self.committed.borrow()
    }

    /// Resolves once the trial is committed, at once when there is none.
    pub(crate) async fn wait_for_commit(&self) {
        let mut committed = self.committed.subscribe();
        let _ = committed.wait_for(|committed| *committed).await;
    }

    fn token_matches(&self, candidate: Option<&str>) -> bool {
        match (&self.token, candidate) {
            (Some(token), Some(candidate)) => {
                constant_time_eq(token.as_bytes(), candidate.as_bytes())
            }
            _ => false,
        }
    }
}

/// Outermost gate on the dynamic routes, ahead of authentication, so not even
/// a sign-in or a session prune happens during a trial.
pub(crate) async fn update_trial_gate(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    if state.update_trial.is_committed() {
        return next.run(request).await;
    }
    let path = request.uri().path();
    let health = request.method() == Method::GET && path == "/api/health";
    if health || path == UPDATE_TRIAL_COMMIT_PATH {
        return next.run(request).await;
    }
    ApiError::service_unavailable("OperaLibre is finishing an update.").into_response()
}

/// The updater's commit. It restores the read-along queue before opening the
/// routes, so a request cannot persist an empty queue over the saved one, and
/// a queue that cannot be restored fails the commit and rolls the update back
/// as a failed start would.
pub(crate) async fn commit_update_trial(
    State(state): State<AppState>,
    ConnectInfo(peer_address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let trial = &state.update_trial;
    if !trial.is_trial() {
        return Err(ApiError::not_found("No update is waiting to be committed."));
    }
    let token = headers
        .get(UPDATE_TRIAL_HEADER)
        .and_then(|value| value.to_str().ok());
    if !peer_address.ip().is_loopback() || !trial.token_matches(token) {
        return Err(ApiError::forbidden(
            "Only the updater can commit an update.",
        ));
    }
    let _commit = trial.commit.lock().await;
    if trial.is_committed() {
        return Ok(StatusCode::NO_CONTENT);
    }
    sync::restore_queue(&state).await?;
    trial.committed.send_replace(true);
    tracing::info!("the updater committed this build");
    Ok(StatusCode::NO_CONTENT)
}
