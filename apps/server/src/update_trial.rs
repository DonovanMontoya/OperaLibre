use crate::*;

pub(crate) const UPDATE_TRIAL_ENV: &str = "OPERALIBRE_UPDATE_TRIAL";
pub(crate) const UPDATE_TRIAL_HEADER: &str = "x-operalibre-update-trial";
pub(crate) const UPDATE_TRIAL_COMMIT_PATH: &str = "/api/update-trial/commit";
/// Written to the data dir, holding the trial's token, as the commit point
/// before any route opens. The updater reads it after the trial has stopped, so a lost
/// commit reply cannot lead it to restore data over changes made since.
pub(crate) const UPDATE_TRIAL_COMMITTED_FILE: &str = "update-trial-committed";

pub(crate) struct UpdateTrial {
    token: Option<String>,
    committed: tokio::sync::watch::Sender<bool>,
    commit: Mutex<()>,
    /// Injects a failure while recording the commit: see `RecordFault`.
    #[cfg(test)]
    pub(crate) record_fault: std::sync::atomic::AtomicU8,
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
            #[cfg(test)]
            record_fault: Default::default(),
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
    record_commit(&state).await?;
    trial.committed.send_replace(true);
    tracing::info!("the updater committed this build");
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
pub(crate) enum RecordFault {
    /// Preparing the record fails, as a full disk would.
    BeforePublishing = 1,
    /// Syncing the directory fails once the record is published.
    AfterPublishing = 2,
}

#[cfg(test)]
fn injected(trial: &UpdateTrial, fault: RecordFault) -> io::Result<()> {
    if trial.record_fault.load(std::sync::atomic::Ordering::SeqCst) == fault as u8 {
        Err(io::Error::other("injected record failure"))
    } else {
        Ok(())
    }
}

/// Publishing the record is the commit point. Everything that can fail runs
/// before the rename, so a published record always means the commit stands,
/// even if this process exits before opening routes or answering; the
/// updater then keeps the data and starts this build again.
async fn record_commit(state: &AppState) -> Result<(), ApiError> {
    let trial = &state.update_trial;
    let token = trial.token.as_deref().unwrap_or_default();
    let record = state
        .database_path
        .with_file_name(UPDATE_TRIAL_COMMITTED_FILE);
    let temporary = record.with_extension("tmp");
    let prepared = async {
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temporary).await?;
        file.write_all(token.as_bytes()).await?;
        file.sync_all().await?;
        drop(file);
        secure_file_permissions(&temporary).await?;
        #[cfg(test)]
        injected(trial, RecordFault::BeforePublishing)?;
        let (from, to) = (temporary.clone(), record.clone());
        tokio::task::spawn_blocking(move || replace_file_blocking(&from, &to))
            .await
            .map_err(io::Error::other)?
    }
    .await;
    if let Err(error) = prepared {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(ApiError::internal(format!(
            "Could not record the update commit: {error}"
        )));
    }
    let synced = async {
        #[cfg(test)]
        injected(trial, RecordFault::AfterPublishing)?;
        #[cfg(unix)]
        if let Some(directory) = record.parent() {
            tokio::fs::File::open(directory).await?.sync_all().await?;
        }
        io::Result::Ok(())
    }
    .await;
    if let Err(error) = synced {
        tracing::warn!(
            "the update commit is recorded, but {} could not be synced: {error}",
            record.display()
        );
    }
    Ok(())
}
