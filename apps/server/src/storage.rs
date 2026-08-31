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
    write_bytes_atomic(path, &serde_json::to_vec_pretty(value)?).await
}

/// Write bytes to a temporary sibling and rename them into place with the
/// same durability and permission guarantees as the JSON state writer.
pub(crate) async fn write_bytes_atomic(path: &FsPath, contents: &[u8]) -> Result<(), ApiError> {
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
    temp_file.write_all(contents).await?;
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
    let temp_path = temp_path.to_path_buf();
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || replace_file_blocking(&temp_path, &path))
        .await
        .map_err(io::Error::other)?
}

/// Replace a file from a synchronous path such as JSON export. Windows cannot
/// use `rename` when the destination already exists, so every synchronous
/// writer shares the same replacement semantics as `write_json_atomic`.
#[cfg(unix)]
pub(crate) fn replace_file_blocking(temp_path: &FsPath, path: &FsPath) -> io::Result<()> {
    std::fs::rename(temp_path, path)
}

#[cfg(windows)]
pub(crate) fn replace_file_blocking(temp_path: &FsPath, path: &FsPath) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

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

// ---------------------------------------------------------------------------
// The stores
// ---------------------------------------------------------------------------
//
// Every method here keeps the signature it had when these were JSON files, so
// the handlers did not change when the backend did. What changed is what each
// call costs: reading one listener's position is now an indexed lookup rather
// than parsing every listener's positions for every book.

use rusqlite::{OptionalExtension, params};

/// Rebuild a `Progress` from its row. The book id comes from the key column,
/// not a stored copy, so the two can never disagree.
fn progress_from_row(row: &rusqlite::Row<'_>, book_id: String) -> rusqlite::Result<Progress> {
    Ok(Progress {
        book_id,
        track_id: row.get("track_id")?,
        position_seconds: row.get("position_seconds")?,
        book_position_seconds: row.get("book_position_seconds")?,
        duration_seconds: row.get("duration_seconds")?,
        updated_at: row.get("updated_at")?,
        finished_override: row
            .get::<_, Option<i64>>("finished_override")?
            .map(|value| value != 0),
    })
}

fn upsert_progress(
    connection: &rusqlite::Connection,
    user_id: &str,
    book_id: &str,
    progress: &Progress,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO progress (
             user_id, book_id, track_id, position_seconds,
             book_position_seconds, duration_seconds, updated_at, finished_override
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (user_id, book_id) DO UPDATE SET
             track_id              = excluded.track_id,
             position_seconds      = excluded.position_seconds,
             book_position_seconds = excluded.book_position_seconds,
             duration_seconds      = excluded.duration_seconds,
             updated_at            = excluded.updated_at,
             finished_override     = excluded.finished_override",
        params![
            user_id,
            book_id,
            progress.track_id,
            progress.position_seconds,
            progress.book_position_seconds,
            progress.duration_seconds,
            progress.updated_at,
            progress.finished_override.map(i64::from),
        ],
    )?;
    Ok(())
}

/// Every listener's saved position.
#[derive(Debug)]
pub(crate) struct ProgressStore {
    db: Database,
}

impl ProgressStore {
    pub(crate) fn new(db: Database) -> Self {
        Self { db }
    }

    /// One listener's position in one book.
    pub(crate) async fn get(
        &self,
        user_id: &str,
        book_id: &str,
    ) -> Result<Option<Progress>, ApiError> {
        let (user_id, book_id) = (user_id.to_string(), book_id.to_string());
        self.db
            .call(move |connection| {
                connection
                    .query_row(
                        "SELECT * FROM progress WHERE user_id = ?1 AND book_id = ?2",
                        params![user_id, book_id],
                        |row| progress_from_row(row, book_id.clone()),
                    )
                    .optional()
            })
            .await
    }

    /// Everything one listener has saved, keyed by book id.
    pub(crate) async fn list_for_user(
        &self,
        user_id: &str,
    ) -> Result<HashMap<String, Progress>, ApiError> {
        let user_id = user_id.to_string();
        self.db
            .call(move |connection| {
                let mut statement =
                    connection.prepare("SELECT * FROM progress WHERE user_id = ?1")?;
                let rows = statement.query_map(params![user_id], |row| {
                    let book_id: String = row.get("book_id")?;
                    Ok((book_id.clone(), progress_from_row(row, book_id)?))
                })?;
                rows.collect()
            })
            .await
    }

    /// Positions belonging to any of `user_ids`, keyed the way
    /// `collect_shared_progress` looks them up.
    pub(crate) async fn list_for_users(
        &self,
        user_ids: &HashSet<String>,
    ) -> Result<HashMap<String, Progress>, ApiError> {
        if user_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let user_ids: Vec<String> = user_ids.iter().cloned().collect();
        self.db
            .call(move |connection| {
                let mut found = HashMap::new();
                let mut statement =
                    connection.prepare("SELECT * FROM progress WHERE user_id = ?1")?;
                for user_id in user_ids {
                    let rows = statement.query_map(params![user_id], |row| {
                        let book_id: String = row.get("book_id")?;
                        Ok((book_id.clone(), progress_from_row(row, book_id)?))
                    })?;
                    for row in rows {
                        let (book_id, progress) = row?;
                        found.insert(progress_key(&user_id, &book_id), progress);
                    }
                }
                Ok(found)
            })
            .await
    }

    /// Book ids whose stored position moved within the last `window_ms`.
    pub(crate) async fn book_ids_active_within(
        &self,
        window_ms: u64,
    ) -> Result<HashSet<String>, ApiError> {
        let now_ms = unix_now_millis();
        self.db
            .call(move |connection| {
                let mut statement =
                    connection.prepare("SELECT book_id, updated_at FROM progress")?;
                let rows = statement.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?;
                let mut active = HashSet::new();
                for row in rows {
                    let (book_id, updated_at) = row?;
                    if now_ms.saturating_sub(progress_timestamp_millis(&updated_at)) <= window_ms {
                        active.insert(book_id);
                    }
                }
                Ok(active)
            })
            .await
    }

    /// Listener ids whose stored position moved within the last `window_ms`.
    pub(crate) async fn listener_ids_active_within(
        &self,
        window_ms: u64,
    ) -> Result<HashSet<String>, ApiError> {
        let now_ms = unix_now_millis();
        self.db
            .call(move |connection| {
                let mut statement =
                    connection.prepare("SELECT user_id, updated_at FROM progress")?;
                let rows = statement.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?;
                let mut active = HashSet::new();
                for row in rows {
                    let (user_id, updated_at) = row?;
                    if now_ms.saturating_sub(progress_timestamp_millis(&updated_at)) <= window_ms {
                        active.insert(user_id);
                    }
                }
                Ok(active)
            })
            .await
    }

    /// Apply a decision to one listener's position.
    ///
    /// The read, the decision, and the write happen in one transaction, so a
    /// concurrent checkpoint cannot slip between the position this decision
    /// was based on and the position it stores.
    pub(crate) async fn update_book<F>(
        &self,
        user_id: &str,
        book_id: &str,
        decide: F,
    ) -> Result<(Progress, Option<Progress>), ApiError>
    where
        F: FnOnce(Option<&Progress>) -> ProgressDecision + Send + 'static,
    {
        let (user_id, book_id) = (user_id.to_string(), book_id.to_string());
        self.db
            .transaction(move |transaction| {
                let previous = transaction
                    .query_row(
                        "SELECT * FROM progress WHERE user_id = ?1 AND book_id = ?2",
                        params![user_id, book_id],
                        |row| progress_from_row(row, book_id.clone()),
                    )
                    .optional()?;
                match decide(previous.as_ref()) {
                    ProgressDecision::Keep => {
                        // Every rule that keeps a position first requires one
                        // to be stored, so this branch always has a previous.
                        let kept = previous.clone().ok_or_else(|| {
                            rusqlite::Error::InvalidParameterName(
                                "progress was kept without a stored position".to_string(),
                            )
                        })?;
                        Ok((kept, previous))
                    }
                    ProgressDecision::Store {
                        saved,
                        backup_previous,
                    } => {
                        if backup_previous
                            && let Some(previous) = &previous
                        {
                            transaction.execute(
                                "INSERT INTO progress_backups (user_id, book_id, backed_up_at, payload)
                                 VALUES (?1, ?2, ?3, ?4)",
                                params![
                                    user_id,
                                    book_id,
                                    now_rfc3339ish(),
                                    serde_json::to_string(previous).unwrap_or_default(),
                                ],
                            )?;
                            transaction.execute(
                                "DELETE FROM progress_backups
                                 WHERE user_id = ?1 AND book_id = ?2 AND rowid NOT IN (
                                     SELECT rowid FROM progress_backups
                                     WHERE user_id = ?1 AND book_id = ?2
                                     ORDER BY rowid DESC LIMIT ?3
                                 )",
                                params![user_id, book_id, PROGRESS_BACKUPS_PER_BOOK as i64],
                            )?;
                        }
                        upsert_progress(transaction, &user_id, &book_id, &saved)?;
                        Ok((saved, previous))
                    }
                }
            })
            .await
    }

    /// Store one listener's position outright, ignoring the rules that guard
    /// automatic checkpoints. Used by tests and by the import.
    #[cfg(test)]
    pub(crate) async fn set(
        &self,
        user_id: &str,
        book_id: &str,
        progress: Progress,
    ) -> Result<(), ApiError> {
        let (user_id, book_id) = (user_id.to_string(), book_id.to_string());
        self.db
            .call(move |connection| upsert_progress(connection, &user_id, &book_id, &progress))
            .await
    }

    /// Forget everything belonging to one listener.
    pub(crate) async fn remove_user(&self, user_id: &str) -> Result<(), ApiError> {
        let user_id = user_id.to_string();
        self.db
            .transaction(move |transaction| {
                transaction.execute("DELETE FROM progress WHERE user_id = ?1", params![user_id])?;
                transaction.execute(
                    "DELETE FROM progress_backups WHERE user_id = ?1",
                    params![user_id],
                )?;
                Ok(())
            })
            .await
    }
}

/// Per-listener, per-book playback settings. Only volume gain today.
#[derive(Debug)]
pub(crate) struct BookSettingsStore {
    db: Database,
}

impl BookSettingsStore {
    pub(crate) fn new(db: Database) -> Self {
        Self { db }
    }

    /// One book's gain for one listener, defaulting to unity.
    pub(crate) async fn gain(&self, user_id: &str, book_id: &str) -> Result<f64, ApiError> {
        let (user_id, book_id) = (user_id.to_string(), book_id.to_string());
        Ok(self
            .db
            .call(move |connection| {
                connection
                    .query_row(
                        "SELECT volume_gain FROM book_settings WHERE user_id = ?1 AND book_id = ?2",
                        params![user_id, book_id],
                        |row| row.get::<_, f64>(0),
                    )
                    .optional()
            })
            .await?
            // Clamped on the way out as well as the way in: a value stored by
            // an older release, or edited by hand, must not reach a client as
            // an eardrum-splitting multiplier.
            .map(clamp_book_volume_gain)
            .unwrap_or(BOOK_VOLUME_GAIN_DEFAULT))
    }

    /// Every gain one listener has set, keyed by book id.
    pub(crate) async fn list_for_user(
        &self,
        user_id: &str,
    ) -> Result<HashMap<String, f64>, ApiError> {
        let user_id = user_id.to_string();
        self.db
            .call(move |connection| {
                let mut statement = connection
                    .prepare("SELECT book_id, volume_gain FROM book_settings WHERE user_id = ?1")?;
                let rows = statement.query_map(params![user_id], |row| {
                    Ok((row.get(0)?, clamp_book_volume_gain(row.get(1)?)))
                })?;
                rows.collect()
            })
            .await
    }

    /// Set one book's gain for one listener.
    pub(crate) async fn set_gain(
        &self,
        user_id: &str,
        book_id: &str,
        gain: f64,
    ) -> Result<(), ApiError> {
        let (user_id, book_id) = (user_id.to_string(), book_id.to_string());
        self.db
            .call(move |connection| {
                if gain == BOOK_VOLUME_GAIN_DEFAULT {
                    // Unity gain is the absence of a setting rather than a
                    // stored one, so resetting a book leaves no row behind.
                    connection.execute(
                        "DELETE FROM book_settings WHERE user_id = ?1 AND book_id = ?2",
                        params![user_id, book_id],
                    )?;
                } else {
                    connection.execute(
                        "INSERT INTO book_settings (user_id, book_id, volume_gain)
                         VALUES (?1, ?2, ?3)
                         ON CONFLICT (user_id, book_id) DO UPDATE SET
                             volume_gain = excluded.volume_gain",
                        params![user_id, book_id, gain],
                    )?;
                }
                Ok(())
            })
            .await
    }

    pub(crate) async fn remove_user(&self, user_id: &str) -> Result<(), ApiError> {
        let user_id = user_id.to_string();
        self.db
            .call(move |connection| {
                connection.execute(
                    "DELETE FROM book_settings WHERE user_id = ?1",
                    params![user_id],
                )?;
                Ok(())
            })
            .await
    }
}

// ---------------------------------------------------------------------------
// Stores that stay cached in memory
// ---------------------------------------------------------------------------
//
// These are small and bounded, and the auth path reads accounts and sessions
// on every request, so they keep their in-memory copy. What moved is where the
// copy is persisted: one transactional database instead of a file each.

/// A store held in memory and persisted to the database.
///
/// Reads come from the cache. Writes go through [`mutate`], which applies the
/// change to a draft and adopts it only once the change succeeds and the write
/// commits, so a rejected change touches neither the cache nor the database.
///
/// [`mutate`]: CachedStore::mutate
#[derive(Debug)]
pub(crate) struct CachedStore<T> {
    db: Database,
    persist: StoreShape,
    value: RwLock<T>,
}

/// How a cached store writes itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StoreShape {
    /// Rewritten as rows in the named table's dedicated schema.
    Users,
    Sessions,
    Activity,
    /// Kept as a JSON document under this name. These structures are still
    /// moving and are never queried by anything but their own handlers, so
    /// columns would cost a schema migration per field and buy nothing.
    Document(&'static str),
}

impl<T: Serialize + Clone + Send + Sync + 'static> CachedStore<T> {
    pub(crate) fn new(db: Database, persist: StoreShape, value: T) -> Self {
        Self {
            db,
            persist,
            value: RwLock::new(value),
        }
    }

    pub(crate) async fn read(&self) -> tokio::sync::RwLockReadGuard<'_, T> {
        self.value.read().await
    }

    pub(crate) async fn mutate<R, F>(&self, change: F) -> Result<R, ApiError>
    where
        F: FnOnce(&mut T) -> Result<R, ApiError>,
    {
        let mut value = self.value.write().await;
        let mut draft = value.clone();
        let outcome = change(&mut draft)?;
        self.persist(&draft).await?;
        *value = draft;
        Ok(outcome)
    }

    async fn persist(&self, draft: &T) -> Result<(), ApiError> {
        let payload = serde_json::to_string(draft)?;
        let shape = self.persist;
        self.db
            .transaction(move |transaction| {
                match shape {
                    StoreShape::Document(name) => write_document(transaction, name, &payload)?,
                    StoreShape::Users => {
                        write_users_rows(transaction, &payload)?;
                    }
                    StoreShape::Sessions => {
                        write_sessions_rows(transaction, &payload)?;
                    }
                    StoreShape::Activity => {
                        write_activity_rows(transaction, &payload)?;
                    }
                }
                Ok(())
            })
            .await
    }
}

/// Names for the stores that keep their JSON shape.
pub(crate) const METADATA_OVERRIDES_DOCUMENT: &str = "metadata-overrides";
pub(crate) const LIBATION_REQUESTS_DOCUMENT: &str = "libation-requests";
pub(crate) const LIBATION_REFRESHES_DOCUMENT: &str = "libation-refreshes";
pub(crate) const LIBATION_ACCOUNTS_DOCUMENT: &str = "libation-accounts";
pub(crate) const READING_HISTORY_DOCUMENT: &str = "reading-history";
pub(crate) const WORKS_DOCUMENT: &str = "works";
/// The account permission migration's watermark. It belongs with the accounts
/// but is not a property of any one of them, so it rides alongside the rows.
pub(crate) const USERS_PERMISSIONS_VERSION_DOCUMENT: &str = "users-permissions-version";

/// Accounts are rewritten wholesale. There are tens of them, they change only
/// when an administrator acts, and doing it in one transaction keeps the
/// account list and its book grants consistent with each other.
pub(crate) fn write_users_rows(
    transaction: &rusqlite::Transaction<'_>,
    payload: &str,
) -> rusqlite::Result<usize> {
    let store: UsersStore = serde_json::from_str(payload)
        .map_err(|error| rusqlite::Error::InvalidParameterName(error.to_string()))?;
    transaction.execute("DELETE FROM book_access", [])?;
    transaction.execute("DELETE FROM users", [])?;
    db::write_document(
        transaction,
        USERS_PERMISSIONS_VERSION_DOCUMENT,
        &store.permissions_version.to_string(),
    )?;
    for user in &store.users {
        transaction.execute(
            "INSERT INTO users (
                 id, username, password_hash, is_admin, is_owner,
                 can_approve_libation_requests, libation_access, share_progress,
                 announce_finishes, notify_finishes, created_at, restricted
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                user.id,
                user.username,
                user.password_hash,
                user.is_admin,
                user.is_owner,
                user.can_approve_libation_requests,
                serde_json::to_string(&user.libation_access)
                    .unwrap_or_default()
                    .trim_matches('"'),
                user.share_progress,
                user.announce_finishes,
                user.notify_finishes,
                user.created_at,
                user.allowed_book_ids.is_some(),
            ],
        )?;
        for book_id in user.allowed_book_ids.iter().flatten() {
            transaction.execute(
                "INSERT OR IGNORE INTO book_access (user_id, book_id) VALUES (?1, ?2)",
                params![user.id, book_id],
            )?;
        }
    }
    Ok(store.users.len())
}

pub(crate) fn write_sessions_rows(
    transaction: &rusqlite::Transaction<'_>,
    payload: &str,
) -> rusqlite::Result<usize> {
    let sessions: HashMap<String, Session> = serde_json::from_str(payload)
        .map_err(|error| rusqlite::Error::InvalidParameterName(error.to_string()))?;
    transaction.execute("DELETE FROM sessions", [])?;
    for (token, session) in &sessions {
        transaction.execute(
            "INSERT INTO sessions (token, user_id, created_at, media_token)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                token,
                session.user_id,
                session.created_at,
                media_token_for_session(token),
            ],
        )?;
    }
    Ok(sessions.len())
}

pub(crate) fn write_activity_rows(
    transaction: &rusqlite::Transaction<'_>,
    payload: &str,
) -> rusqlite::Result<usize> {
    let store: ActivityStore = serde_json::from_str(payload)
        .map_err(|error| rusqlite::Error::InvalidParameterName(error.to_string()))?;
    transaction.execute("DELETE FROM activity", [])?;
    let mut written = 0;
    for (user_id, days) in &store.by_user {
        for (day, seconds) in days {
            transaction.execute(
                "INSERT INTO activity (user_id, day, seconds) VALUES (?1, ?2, ?3)",
                params![user_id, day, seconds],
            )?;
            written += 1;
        }
    }
    Ok(written)
}

/// Every account.
pub(crate) type UserStore = CachedStore<UsersStore>;
/// Live sessions, keyed by token.
///
/// Wraps the cached map with a reverse index from media token to session
/// token. The media route is the hottest in the server — every range request
/// during playback carries one — and it used to hash every live session on
/// every request to find its owner.
#[derive(Debug)]
pub(crate) struct SessionStore {
    inner: CachedStore<HashMap<String, Session>>,
    by_media_token: RwLock<HashMap<String, String>>,
    /// Serializes mutation and index publication. The index is rebuilt from a
    /// fresh read of the map after each commit, so two overlapping mutations
    /// must not be free to publish out of order — without the gate, the first
    /// could overwrite the second's newer index with its own older snapshot,
    /// leaving a just-signed-in session's media token unresolvable until the
    /// next session change.
    mutate_gate: tokio::sync::Mutex<()>,
}

fn media_token_index(sessions: &HashMap<String, Session>) -> HashMap<String, String> {
    sessions
        .keys()
        .map(|token| (media_token_for_session(token), token.clone()))
        .collect()
}

impl SessionStore {
    pub(crate) fn new(
        db: Database,
        persist: StoreShape,
        sessions: HashMap<String, Session>,
    ) -> Self {
        let by_media_token = RwLock::new(media_token_index(&sessions));
        Self {
            inner: CachedStore::new(db, persist, sessions),
            by_media_token,
            mutate_gate: tokio::sync::Mutex::new(()),
        }
    }

    pub(crate) async fn read(&self) -> tokio::sync::RwLockReadGuard<'_, HashMap<String, Session>> {
        self.inner.read().await
    }

    pub(crate) async fn mutate<R, F>(&self, change: F) -> Result<R, ApiError>
    where
        F: FnOnce(&mut HashMap<String, Session>) -> Result<R, ApiError>,
    {
        let _gate = self.mutate_gate.lock().await;
        let outcome = self.inner.mutate(change).await?;
        // Rebuilt rather than patched: sessions change on sign-in and sign-out
        // only, the map is capped, and a rebuild cannot drift from the truth.
        // The gate keeps the read-and-publish step from interleaving with
        // another mutation's commit, so the index never lags the map it
        // mirrors.
        let rebuilt = media_token_index(&*self.inner.read().await);
        *self.by_media_token.write().await = rebuilt;
        Ok(outcome)
    }

    /// The session a media token belongs to, if it belongs to one.
    pub(crate) async fn session_for_media_token(&self, media_token: &str) -> Option<String> {
        let index = self.by_media_token.read().await;
        let (stored, session_token) = index.get_key_value(media_token)?;
        // Defense in depth only: the map's own lookup has already compared
        // keys with an early-exiting equality, so this cannot restore a
        // timing guarantee. It costs nothing and keeps the match explicit.
        constant_time_eq(stored.as_bytes(), media_token.as_bytes()).then(|| session_token.clone())
    }
}
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
pub(crate) type ReadingHistoryStore = CachedStore<ReadingHistory>;
pub(crate) type WorksStore = CachedStore<WorkStore>;

// ---------------------------------------------------------------------------
// Loading the caches at startup
// ---------------------------------------------------------------------------

/// Read one JSON-shaped store back out of the database.
pub(crate) fn read_document_store<T: serde::de::DeserializeOwned + Default>(
    connection: &rusqlite::Connection,
    name: &str,
) -> anyhow::Result<T> {
    match db::read_document(connection, name)? {
        Some(payload) => Ok(serde_json::from_str(&payload)?),
        None => Ok(T::default()),
    }
}

pub(crate) fn read_users_rows(connection: &rusqlite::Connection) -> anyhow::Result<UsersStore> {
    let mut grants: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut statement = connection.prepare("SELECT user_id, book_id FROM book_access")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (user_id, book_id) = row?;
            grants.entry(user_id).or_default().push(book_id);
        }
    }

    let mut statement = connection.prepare("SELECT * FROM users")?;
    let rows = statement.query_map([], |row| {
        let id: String = row.get("id")?;
        let restricted: bool = row.get("restricted")?;
        let libation_access: String = row.get("libation_access")?;
        Ok(User {
            allowed_book_ids: restricted.then(|| grants.get(&id).cloned().unwrap_or_default()),
            id,
            username: row.get("username")?,
            password_hash: row.get("password_hash")?,
            is_admin: row.get("is_admin")?,
            is_owner: row.get("is_owner")?,
            can_approve_libation_requests: row.get("can_approve_libation_requests")?,
            libation_access: serde_json::from_str(&format!("\"{libation_access}\""))
                .unwrap_or_default(),
            share_progress: row.get("share_progress")?,
            announce_finishes: row.get("announce_finishes")?,
            notify_finishes: row.get("notify_finishes")?,
            created_at: row.get("created_at")?,
        })
    })?;
    let mut users = Vec::new();
    for row in rows {
        users.push(row?);
    }
    // Accounts are presented oldest first, the order the file preserved.
    users.sort_by(|left, right| left.created_at.cmp(&right.created_at));
    let permissions_version = db::read_document(connection, USERS_PERMISSIONS_VERSION_DOCUMENT)?
        .and_then(|payload| payload.parse().ok())
        .unwrap_or(0);
    Ok(UsersStore {
        users,
        permissions_version,
    })
}

pub(crate) fn read_sessions_rows(
    connection: &rusqlite::Connection,
) -> anyhow::Result<HashMap<String, Session>> {
    let mut statement = connection.prepare("SELECT token, user_id, created_at FROM sessions")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            Session {
                user_id: row.get(1)?,
                created_at: row.get(2)?,
            },
        ))
    })?;
    let mut sessions = HashMap::new();
    for row in rows {
        let (token, session) = row?;
        sessions.insert(token, session);
    }
    Ok(sessions)
}

pub(crate) fn read_activity_rows(
    connection: &rusqlite::Connection,
) -> anyhow::Result<ActivityStore> {
    let mut statement = connection.prepare("SELECT user_id, day, seconds FROM activity")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, f64>(2)?,
        ))
    })?;
    let mut store = ActivityStore::default();
    for row in rows {
        let (user_id, day, seconds) = row?;
        store
            .by_user
            .entry(user_id)
            .or_default()
            .insert(day, seconds);
    }
    Ok(store)
}

/// Everything the server keeps cached in memory, read back at startup.
pub(crate) struct CachedSnapshot {
    pub(crate) users: UsersStore,
    pub(crate) sessions: HashMap<String, Session>,
    pub(crate) activity: ActivityStore,
    pub(crate) metadata_overrides: MetadataOverrideStore,
    pub(crate) libation_requests: LibationRequestStore,
    pub(crate) libation_refreshes: LibationRefreshStore,
    pub(crate) libation_accounts: ManagedLibationAccountStore,
    pub(crate) reading_history: ReadingHistory,
    pub(crate) works: WorkStore,
}

pub(crate) fn read_cached_snapshot(
    connection: &rusqlite::Connection,
) -> anyhow::Result<CachedSnapshot> {
    Ok(CachedSnapshot {
        users: read_users_rows(connection)?,
        sessions: read_sessions_rows(connection)?,
        activity: read_activity_rows(connection)?,
        metadata_overrides: read_document_store(connection, METADATA_OVERRIDES_DOCUMENT)?,
        libation_requests: read_document_store(connection, LIBATION_REQUESTS_DOCUMENT)?,
        libation_refreshes: read_document_store(connection, LIBATION_REFRESHES_DOCUMENT)?,
        libation_accounts: read_document_store(connection, LIBATION_ACCOUNTS_DOCUMENT)?,
        reading_history: read_document_store(connection, READING_HISTORY_DOCUMENT)?,
        works: read_document_store(connection, WORKS_DOCUMENT)?,
    })
}
