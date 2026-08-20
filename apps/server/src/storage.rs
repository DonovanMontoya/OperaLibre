//! Extracted from main.rs.

use crate::*;

pub(crate) fn record_server_pid(data_dir: &std::path::Path) -> std::io::Result<()> {
    create_private_directory(data_dir)?;
    let pid_path = data_dir.join("operalibre-server.pid");
    std::fs::write(&pid_path, std::process::id().to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(pid_path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

pub(crate) fn create_private_directory(path: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

pub(crate) async fn secure_existing_state_files(config: &ServerConfig) -> io::Result<()> {
    for path in [
        &config.progress_file,
        &config.users_file,
        &config.sessions_file,
        &config.activity_file,
        &config.metadata_overrides_file,
        &config.libation_requests_file,
    ] {
        if fs::try_exists(path).await? {
            secure_file_permissions(path).await?;
        }
    }
    for path in [
        config.data_dir.join("library-identities.json"),
        config.data_dir.join("libation-refreshes.json"),
        config.data_dir.join("book-settings.json"),
    ] {
        if fs::try_exists(&path).await? {
            secure_file_permissions(&path).await?;
        }
    }
    Ok(())
}

/// Serialize to a temporary file in the destination directory and rename it
/// into place, so a crash mid-write never leaves a truncated store behind.
pub(crate) async fn write_json_atomic<T: Serialize>(
    path: &FsPath,
    value: &T,
) -> Result<(), ApiError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let mut suffix = [0u8; 8];
    rand::rng().fill(&mut suffix);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("store");
    let temp_path = path.with_file_name(format!(
        "{file_name}.{:016x}.tmp",
        u64::from_le_bytes(suffix)
    ));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut temp_file = options.open(&temp_path).await?;
    temp_file
        .write_all(&serde_json::to_vec_pretty(value)?)
        .await?;
    // `flush` only drains tokio's userspace buffer. Without `sync_all` the
    // bytes can still be sitting in the page cache when power is lost, and the
    // rename below would then publish a truncated or empty store.
    temp_file.sync_all().await?;
    drop(temp_file);
    secure_file_permissions(&temp_path).await?;
    if let Err(error) = fs::rename(&temp_path, path).await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(error.into());
    }
    secure_file_permissions(path).await?;
    // The rename is atomic, but the directory entry it created is itself only
    // durable once the directory is synced. Skipping this can lose the whole
    // store after a crash even though the data was safely on disk.
    sync_parent_directory(path).await;
    Ok(())
}

/// Fsync the directory holding `path` so a completed rename survives a crash.
///
/// Unix only: Windows has no directory handle to sync, and `ReplaceFile`-style
/// rename semantics already order the metadata update.
#[cfg(unix)]
pub(crate) async fn sync_parent_directory(path: &FsPath) {
    let Some(parent) = path.parent() else {
        return;
    };
    let parent = parent.to_path_buf();
    let result = tokio::task::spawn_blocking(move || {
        let dir = if parent.as_os_str().is_empty() {
            std::fs::File::open(".")?
        } else {
            std::fs::File::open(&parent)?
        };
        dir.sync_all()
    })
    .await;
    match result {
        Ok(Ok(())) => {}
        // A failed directory sync does not invalidate the write that just
        // landed, so this warns rather than failing the request.
        Ok(Err(error)) => {
            tracing::warn!("could not fsync directory for {}: {error}", path.display());
        }
        Err(error) => {
            tracing::warn!(
                "directory fsync task failed for {}: {error}",
                path.display()
            );
        }
    }
}

#[cfg(not(unix))]
pub(crate) async fn sync_parent_directory(_path: &FsPath) {}

#[cfg(unix)]
pub(crate) async fn secure_file_permissions(path: &FsPath) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await
}

#[cfg(not(unix))]
pub(crate) async fn secure_file_permissions(_path: &FsPath) -> io::Result<()> {
    Ok(())
}

pub(crate) async fn load_metadata_overrides(
    metadata_overrides_file: &FsPath,
) -> anyhow::Result<MetadataOverrideStore> {
    match fs::read_to_string(metadata_overrides_file).await {
        Ok(contents) => Ok(serde_json::from_str(&contents)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(MetadataOverrideStore::default())
        }
        Err(error) => Err(error.into()),
    }
}

pub(crate) async fn write_metadata_overrides(
    metadata_overrides_file: &FsPath,
    store: &MetadataOverrideStore,
) -> Result<(), ApiError> {
    write_json_atomic(metadata_overrides_file, store).await
}

pub(crate) async fn load_activity_store(activity_file: &FsPath) -> anyhow::Result<ActivityStore> {
    match fs::read_to_string(activity_file).await {
        Ok(contents) => {
            let mut store: ActivityStore = serde_json::from_str(&contents)?;
            // Older stores opened with a synthetic "everything before tracking
            // started" bucket, estimated from how far into each book the reader
            // had got. That conflated ground covered with time spent listening
            // and could only ever overstate it, so it is dropped on sight.
            for entries in store.by_user.values_mut() {
                entries.remove(ACTIVITY_BASELINE_KEY);
            }
            Ok(store)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(ActivityStore::default()),
        Err(error) => Err(error.into()),
    }
}

pub(crate) async fn write_activity_store(
    activity_file: &FsPath,
    store: &ActivityStore,
) -> Result<(), ApiError> {
    write_json_atomic(activity_file, store).await
}

pub(crate) async fn load_users_store(users_file: &FsPath) -> anyhow::Result<UsersStore> {
    match fs::read_to_string(users_file).await {
        Ok(contents) => {
            let mut store: UsersStore = serde_json::from_str(&contents)?;
            if migrate_users_permissions(&mut store) {
                write_users_store(users_file, &store)
                    .await
                    .map_err(|error| anyhow::anyhow!(error.message.clone()))?;
            }
            Ok(store)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(UsersStore::default()),
        Err(error) => Err(error.into()),
    }
}

pub(crate) async fn write_users_store(
    users_file: &FsPath,
    store: &UsersStore,
) -> Result<(), ApiError> {
    write_json_atomic(users_file, store).await
}

pub(crate) async fn load_libation_requests(path: &FsPath) -> anyhow::Result<LibationRequestStore> {
    match fs::read_to_string(path).await {
        Ok(contents) => {
            let mut store: LibationRequestStore = serde_json::from_str(&contents)?;
            if recover_interrupted_libation_requests(&mut store) {
                write_libation_requests(path, &store)
                    .await
                    .map_err(|error| anyhow::anyhow!(error.message.clone()))?;
            }
            Ok(store)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(LibationRequestStore::default())
        }
        Err(error) => Err(error.into()),
    }
}

pub(crate) async fn write_libation_requests(
    path: &FsPath,
    store: &LibationRequestStore,
) -> Result<(), ApiError> {
    write_json_atomic(path, store).await
}

pub(crate) async fn load_libation_refreshes(path: &FsPath) -> anyhow::Result<LibationRefreshStore> {
    match fs::read_to_string(path).await {
        Ok(contents) => Ok(serde_json::from_str(&contents)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(LibationRefreshStore::default())
        }
        Err(error) => Err(error.into()),
    }
}

pub(crate) async fn write_libation_refreshes(
    path: &FsPath,
    store: &LibationRefreshStore,
) -> Result<(), ApiError> {
    write_json_atomic(path, store).await
}

pub(crate) async fn load_managed_libation_accounts(
    path: &FsPath,
) -> anyhow::Result<ManagedLibationAccountStore> {
    match fs::read_to_string(path).await {
        Ok(contents) => Ok(serde_json::from_str(&contents)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(ManagedLibationAccountStore::default())
        }
        Err(error) => Err(error.into()),
    }
}

pub(crate) async fn write_managed_libation_accounts(
    path: &FsPath,
    store: &ManagedLibationAccountStore,
) -> Result<(), ApiError> {
    write_json_atomic(path, store).await
}

pub(crate) async fn load_sessions_store(
    sessions_file: &FsPath,
) -> anyhow::Result<HashMap<String, Session>> {
    match fs::read_to_string(sessions_file).await {
        Ok(contents) => {
            let mut sessions: HashMap<String, Session> = serde_json::from_str(&contents)?;
            let now = unix_now_seconds();
            sessions.retain(|_, session| !session.is_expired(now));
            Ok(sessions)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(error) => Err(error.into()),
    }
}

pub(crate) async fn write_sessions_store(
    sessions_file: &FsPath,
    sessions: &HashMap<String, Session>,
) -> Result<(), ApiError> {
    write_json_atomic(sessions_file, sessions).await
}

// ---------------------------------------------------------------------------
// Playback progress and per-book settings
// ---------------------------------------------------------------------------
//
// These two types are the only way the rest of the server reaches a listener's
// saved position or a book's volume gain. The methods are deliberately narrow
// -- one user, one book, or one user's own rows -- rather than "read the whole
// file", so that a SQL implementation can answer each one with an indexed
// query instead of loading everything.

/// Every listener's saved position, keyed internally by user and book.
#[derive(Debug)]
pub(crate) struct ProgressStore {
    file: PathBuf,
    /// Serializes read-modify-write cycles so concurrent updates cannot
    /// overwrite each other. A transaction replaces this under SQL.
    write_lock: Mutex<()>,
}

impl ProgressStore {
    pub(crate) fn new(file: PathBuf) -> Self {
        Self {
            file,
            write_lock: Mutex::new(()),
        }
    }

    /// Store one listener's position outright, ignoring the rules that guard
    /// automatic checkpoints.
    ///
    /// Only tests need this today, so it is gated rather than left as dead
    /// code in the shipped binary. The SQLite migration will want the same
    /// primitive and can drop the gate then.
    #[cfg(test)]
    pub(crate) async fn set(
        &self,
        user_id: &str,
        book_id: &str,
        progress: Progress,
    ) -> Result<(), ApiError> {
        let _guard = self.write_lock.lock().await;
        let mut stored = read_progress(&self.file).await?;
        stored.insert(progress_key(user_id, book_id), progress);
        write_progress(&self.file, &stored).await
    }

    /// One listener's position in one book.
    pub(crate) async fn get(
        &self,
        user_id: &str,
        book_id: &str,
    ) -> Result<Option<Progress>, ApiError> {
        Ok(read_progress(&self.file)
            .await?
            .remove(&progress_key(user_id, book_id)))
    }

    /// Everything one listener has saved, keyed by book id.
    pub(crate) async fn list_for_user(
        &self,
        user_id: &str,
    ) -> Result<HashMap<String, Progress>, ApiError> {
        let prefix = progress_key(user_id, "");
        Ok(read_progress(&self.file)
            .await?
            .into_iter()
            // Keyed by the book id in the storage key, not the one in the
            // stored row. Callers look these up by the book they are rendering,
            // which is what the composite key encodes; trusting the field
            // instead would resolve differently for any row whose two copies
            // ever disagreed.
            .filter_map(|(key, progress)| {
                key.strip_prefix(&prefix)
                    .map(|book_id| (book_id.to_string(), progress))
            })
            .collect())
    }

    /// Positions belonging to any of `user_ids`, keyed the way
    /// `collect_shared_progress` looks them up.
    pub(crate) async fn list_for_users(
        &self,
        user_ids: &HashSet<String>,
    ) -> Result<HashMap<String, Progress>, ApiError> {
        let prefixes: Vec<String> = user_ids
            .iter()
            .map(|user_id| progress_key(user_id, ""))
            .collect();
        Ok(read_progress(&self.file)
            .await?
            .into_iter()
            .filter(|(key, _)| prefixes.iter().any(|prefix| key.starts_with(prefix)))
            .collect())
    }

    /// Book ids whose stored position moved within the last `window_ms`.
    pub(crate) async fn book_ids_active_within(
        &self,
        window_ms: u64,
    ) -> Result<HashSet<String>, ApiError> {
        let now_ms = unix_now_millis();
        Ok(read_progress(&self.file)
            .await?
            .into_values()
            .filter(|entry| {
                now_ms.saturating_sub(progress_timestamp_millis(&entry.updated_at)) <= window_ms
            })
            .map(|entry| entry.book_id)
            .collect())
    }

    /// Apply a decision to one listener's position, serialized against other
    /// writers. `decide` sees whatever is stored and says what should happen;
    /// the returned progress is what a client should now believe.
    ///
    /// The read, the decision, and the write all happen under one lock, which
    /// is the same shape a SQL transaction takes.
    pub(crate) async fn update_book<F>(
        &self,
        user_id: &str,
        book_id: &str,
        decide: F,
    ) -> Result<(Progress, Option<Progress>), ApiError>
    where
        F: FnOnce(Option<&Progress>) -> ProgressDecision,
    {
        let _guard = self.write_lock.lock().await;
        let mut stored = read_progress(&self.file).await?;
        let key = progress_key(user_id, book_id);
        let previous = stored.get(&key).cloned();
        match decide(previous.as_ref()) {
            ProgressDecision::Keep => {
                // Nothing to write. A `Keep` with nothing stored cannot happen:
                // every rule that returns it first requires a previous value.
                let kept = previous.clone().ok_or_else(|| {
                    ApiError::internal("Progress was kept without a stored position.")
                })?;
                Ok((kept, previous))
            }
            ProgressDecision::Store {
                saved,
                backup_previous,
            } => {
                if backup_previous && let Some(previous) = &previous {
                    backup_progress_regression(&self.file, &key, previous).await;
                }
                stored.insert(key, saved.clone());
                write_progress(&self.file, &stored).await?;
                Ok((saved, previous))
            }
        }
    }

    /// Forget everything belonging to one listener.
    pub(crate) async fn remove_user(&self, user_id: &str) -> Result<(), ApiError> {
        let _guard = self.write_lock.lock().await;
        let mut stored = read_progress(&self.file).await?;
        let prefix = progress_key(user_id, "");
        stored.retain(|key, _| !key.starts_with(&prefix));
        write_progress(&self.file, &stored).await
    }
}

/// Per-listener, per-book playback settings. Only volume gain today.
#[derive(Debug)]
pub(crate) struct BookSettingsStore {
    file: PathBuf,
    write_lock: Mutex<()>,
}

impl BookSettingsStore {
    pub(crate) fn new(file: PathBuf) -> Self {
        Self {
            file,
            write_lock: Mutex::new(()),
        }
    }

    /// One book's gain for one listener, defaulting to unity.
    pub(crate) async fn gain(&self, user_id: &str, book_id: &str) -> Result<f64, ApiError> {
        let settings = read_book_settings(&self.file).await?;
        Ok(stored_volume_gain(
            &settings,
            &progress_key(user_id, book_id),
        ))
    }

    /// Every gain one listener has set, keyed by book id.
    pub(crate) async fn list_for_user(
        &self,
        user_id: &str,
    ) -> Result<HashMap<String, f64>, ApiError> {
        let prefix = progress_key(user_id, "");
        Ok(read_book_settings(&self.file)
            .await?
            .into_iter()
            .filter(|(key, _)| key.starts_with(&prefix))
            .filter_map(|(key, settings)| {
                key.strip_prefix(&prefix)
                    .map(|book_id| (book_id.to_string(), settings.volume_gain))
            })
            .collect())
    }

    /// Set one book's gain for one listener.
    pub(crate) async fn set_gain(
        &self,
        user_id: &str,
        book_id: &str,
        gain: f64,
    ) -> Result<(), ApiError> {
        let _guard = self.write_lock.lock().await;
        let mut settings = read_book_settings(&self.file).await?;
        let key = progress_key(user_id, book_id);
        if gain == BOOK_VOLUME_GAIN_DEFAULT {
            // Unity gain is the absence of a setting rather than a stored one,
            // so resetting a book leaves nothing behind.
            settings.remove(&key);
        } else {
            settings.insert(key, BookSettings { volume_gain: gain });
        }
        write_book_settings(&self.file, &settings).await
    }

    pub(crate) async fn remove_user(&self, user_id: &str) -> Result<(), ApiError> {
        let _guard = self.write_lock.lock().await;
        let mut settings = read_book_settings(&self.file).await?;
        let prefix = progress_key(user_id, "");
        settings.retain(|key, _| !key.starts_with(&prefix));
        write_book_settings(&self.file, &settings).await
    }
}

// ---------------------------------------------------------------------------
// Accounts and sessions
// ---------------------------------------------------------------------------
//
// Unlike progress, these are held in memory and mirrored to disk, so reads are
// already cheap. The seam these need is around *writing*: every mutation used
// to be "take the lock, edit, remember to call the write helper", repeated at
// twenty-one call sites.

/// Every account, cached in memory and mirrored to a file.
#[derive(Debug)]
pub(crate) struct UserStore {
    file: PathBuf,
    users: RwLock<UsersStore>,
}

impl UserStore {
    pub(crate) fn new(file: PathBuf, users: UsersStore) -> Self {
        Self {
            file,
            users: RwLock::new(users),
        }
    }

    pub(crate) async fn read(&self) -> tokio::sync::RwLockReadGuard<'_, UsersStore> {
        self.users.read().await
    }

    /// Apply a change under the write lock and persist it.
    ///
    /// The change runs against a copy, which is adopted only once it succeeds
    /// and the write lands. A validation failure therefore leaves neither the
    /// cache nor the file touched — previously a handler that rejected a
    /// request after editing the cache left the two disagreeing until restart.
    pub(crate) async fn mutate<T, F>(&self, change: F) -> Result<T, ApiError>
    where
        F: FnOnce(&mut UsersStore) -> Result<T, ApiError>,
    {
        let mut users = self.users.write().await;
        let mut draft = users.clone();
        let outcome = change(&mut draft)?;
        write_users_store(&self.file, &draft).await?;
        *users = draft;
        Ok(outcome)
    }
}

/// Live sessions, cached in memory and mirrored to a file.
#[derive(Debug)]
pub(crate) struct SessionStore {
    file: PathBuf,
    sessions: RwLock<HashMap<String, Session>>,
}

impl SessionStore {
    pub(crate) fn new(file: PathBuf, sessions: HashMap<String, Session>) -> Self {
        Self {
            file,
            sessions: RwLock::new(sessions),
        }
    }

    pub(crate) async fn read(&self) -> tokio::sync::RwLockReadGuard<'_, HashMap<String, Session>> {
        self.sessions.read().await
    }

    /// Apply a change under the write lock and persist it, with the same
    /// all-or-nothing guarantee as [`UserStore::mutate`].
    pub(crate) async fn mutate<T, F>(&self, change: F) -> Result<T, ApiError>
    where
        F: FnOnce(&mut HashMap<String, Session>) -> Result<T, ApiError>,
    {
        let mut sessions = self.sessions.write().await;
        let mut draft = sessions.clone();
        let outcome = change(&mut draft)?;
        write_sessions_store(&self.file, &draft).await?;
        *sessions = draft;
        Ok(outcome)
    }
}
