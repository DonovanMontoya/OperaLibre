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
    let created_directories = ensure_parent_directory(path).await?;
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
    if let Err(error) = replace_file(&temp_path, path).await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(error.into());
    }
    secure_file_permissions(path).await?;
    // The rename is atomic, but the directory entry it created is itself only
    // durable once the directory is synced. Skipping this can lose the whole
    // store after a crash even though the data was safely on disk.
    sync_parent_directories(path, &created_directories).await?;
    Ok(())
}

/// Create the destination directory and remember every directory created.
///
/// After the file is published, their parents must also be synced: syncing the
/// immediate parent persists the file entry, while syncing each ancestor
/// persists the newly-created directory entries themselves.
async fn ensure_parent_directory(path: &FsPath) -> io::Result<Vec<PathBuf>> {
    let Some(parent) = path.parent() else {
        return Ok(Vec::new());
    };

    let mut created = Vec::new();
    let mut candidate = parent;
    while !candidate.exists() {
        created.push(candidate.to_path_buf());
        let Some(next) = candidate.parent() else {
            break;
        };
        candidate = next;
    }
    fs::create_dir_all(parent).await?;
    Ok(created)
}

#[cfg(unix)]
async fn replace_file(temp_path: &FsPath, path: &FsPath) -> io::Result<()> {
    fs::rename(temp_path, path).await
}

#[cfg(windows)]
async fn replace_file(temp_path: &FsPath, path: &FsPath) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let temp_path = temp_path.to_path_buf();
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let from = temp_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let to = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        if unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    })
    .await
    .map_err(io::Error::other)?
}

/// Fsync the directory holding the file and any newly-created ancestor links.
#[cfg(unix)]
async fn sync_parent_directories(path: &FsPath, created_directories: &[PathBuf]) -> io::Result<()> {
    let mut directories = Vec::with_capacity(created_directories.len() + 1);
    if let Some(parent) = path.parent() {
        directories.push(parent.to_path_buf());
    }
    directories.extend(
        created_directories
            .iter()
            .filter_map(|directory| directory.parent().map(|parent| parent.to_path_buf())),
    );
    directories.sort();
    directories.dedup();

    tokio::task::spawn_blocking(move || -> io::Result<()> {
        for directory in directories {
            std::fs::File::open(directory)?.sync_all()?;
        }
        Ok(())
    })
    .await
    .map_err(io::Error::other)?
}

#[cfg(not(unix))]
async fn sync_parent_directories(
    _path: &FsPath,
    _created_directories: &[PathBuf],
) -> io::Result<()> {
    Ok(())
}

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

pub(crate) async fn load_users_store(users_file: &FsPath) -> anyhow::Result<UsersStore> {
    match fs::read_to_string(users_file).await {
        Ok(contents) => {
            let mut store: UsersStore = serde_json::from_str(&contents)?;
            if migrate_users_permissions(&mut store) {
                write_json_atomic(users_file, &store)
                    .await
                    .map_err(|error| anyhow::anyhow!(error.message.clone()))?;
            }
            Ok(store)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(UsersStore::default()),
        Err(error) => Err(error.into()),
    }
}

pub(crate) async fn load_libation_requests(path: &FsPath) -> anyhow::Result<LibationRequestStore> {
    match fs::read_to_string(path).await {
        Ok(contents) => {
            let mut store: LibationRequestStore = serde_json::from_str(&contents)?;
            if recover_interrupted_libation_requests(&mut store) {
                write_json_atomic(path, &store)
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

pub(crate) async fn load_libation_refreshes(path: &FsPath) -> anyhow::Result<LibationRefreshStore> {
    match fs::read_to_string(path).await {
        Ok(contents) => Ok(serde_json::from_str(&contents)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(LibationRefreshStore::default())
        }
        Err(error) => Err(error.into()),
    }
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
                key.strip_prefix(&prefix).map(|book_id| {
                    (
                        book_id.to_string(),
                        clamp_book_volume_gain(settings.volume_gain),
                    )
                })
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

/// A store held in memory and mirrored to a JSON file.
///
/// Reads come from the cache, so they are cheap. Writes go through [`mutate`],
/// which is the whole point of the type: every one of these stores used to be
/// "take the lock, edit the cache, remember to call the matching write
/// helper", and forgetting the last step left the two disagreeing until the
/// next restart.
///
/// [`mutate`]: CachedStore::mutate
#[derive(Debug)]
pub(crate) struct CachedStore<T> {
    file: PathBuf,
    value: RwLock<T>,
}

impl<T: Serialize + Clone> CachedStore<T> {
    pub(crate) fn new(file: PathBuf, value: T) -> Self {
        Self {
            file,
            value: RwLock::new(value),
        }
    }

    pub(crate) async fn read(&self) -> tokio::sync::RwLockReadGuard<'_, T> {
        self.value.read().await
    }

    /// Apply a change under the write lock and persist it.
    ///
    /// The change runs against a copy, which is adopted only once it succeeds
    /// and the write lands. A rejected change therefore touches neither the
    /// cache nor the file, and a failed write leaves both holding the last
    /// state that was successfully stored.
    pub(crate) async fn mutate<R, F>(&self, change: F) -> Result<R, ApiError>
    where
        F: FnOnce(&mut T) -> Result<R, ApiError>,
    {
        let mut value = self.value.write().await;
        let mut draft = value.clone();
        let outcome = change(&mut draft)?;
        write_json_atomic(&self.file, &draft).await?;
        *value = draft;
        Ok(outcome)
    }
}

/// Every account.
pub(crate) type UserStore = CachedStore<UsersStore>;
/// Live sessions, keyed by token.
pub(crate) type SessionStore = CachedStore<HashMap<String, Session>>;
/// Per-listener daily listening totals.
pub(crate) type ActivityLog = CachedStore<ActivityStore>;
/// Administrator edits layered over scanned metadata.
pub(crate) type MetadataOverrides = CachedStore<MetadataOverrideStore>;
/// Pending and decided Libation download requests.
pub(crate) type LibationRequests = CachedStore<LibationRequestStore>;
/// Per-listener Libation refresh rate limiting.
pub(crate) type LibationRefreshes = CachedStore<LibationRefreshStore>;
/// Managed Libation accounts.
pub(crate) type LibationAccounts = CachedStore<ManagedLibationAccountStore>;
