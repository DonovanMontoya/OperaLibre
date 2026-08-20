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
