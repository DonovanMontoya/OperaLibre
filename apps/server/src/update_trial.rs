use crate::*;

pub(crate) const UPDATE_TRIAL_ENV: &str = "OPERALIBRE_UPDATE_TRIAL";
pub(crate) const UPDATE_TRIAL_HEADER: &str = "x-operalibre-update-trial";
pub(crate) const UPDATE_TRIAL_COMMIT_PATH: &str = "/api/update-trial/commit";
/// Written to the data dir, holding the trial's token, before a commit opens
/// any route. The updater reads it after the trial has stopped, so a lost
/// commit reply cannot lead it to restore data over changes made since.
pub(crate) const UPDATE_TRIAL_COMMITTED_FILE: &str = "update-trial-committed";

pub(crate) struct UpdateTrial {
    token: Option<String>,
    committed: tokio::sync::watch::Sender<bool>,
    commit: Mutex<()>,
}

impl UpdateTrial {
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
    let token = trial.token.as_deref().unwrap_or_default();
    let record = state
        .database_path
        .with_file_name(UPDATE_TRIAL_COMMITTED_FILE);
    write_bytes_atomic(&record, token.as_bytes()).await?;
    trial.committed.send_replace(true);
    tracing::info!("the updater committed this build");
    Ok(StatusCode::NO_CONTENT)
}
