//! Moving an existing installation's JSON files into the database.
//!
//! Installations upgrade in place from the Administration screen, so this runs
//! against live data on someone else's machine. It is written to be boring:
//! copy everything first, import inside one transaction, and if anything at
//! all goes wrong, destroy the half-built database and keep running on the
//! files that are already there.
//!
//! The JSON files are never deleted. A release that has to be rolled back can
//! use `--export-json` to write the database back out in the original format.

use crate::*;

/// Marks a database which has finished importing the legacy JSON layout.
const JSON_IMPORT_COMPLETE_DOCUMENT: &str = "json-import-complete";

/// The JSON files an installation may have, and the store each one feeds.
pub(crate) struct JsonLayout {
    pub(crate) progress: PathBuf,
    pub(crate) progress_backups: PathBuf,
    pub(crate) book_settings: PathBuf,
    pub(crate) users: PathBuf,
    pub(crate) sessions: PathBuf,
    pub(crate) activity: PathBuf,
    pub(crate) metadata_overrides: PathBuf,
    pub(crate) libation_requests: PathBuf,
    pub(crate) libation_refreshes: PathBuf,
    pub(crate) libation_accounts: PathBuf,
}

impl JsonLayout {
    pub(crate) fn for_config(config: &ServerConfig) -> Self {
        Self {
            progress: config.progress_file.clone(),
            progress_backups: config.progress_file.with_extension("backups.json"),
            book_settings: config.data_dir.join("book-settings.json"),
            users: config.users_file.clone(),
            sessions: config.sessions_file.clone(),
            activity: config.activity_file.clone(),
            metadata_overrides: config.metadata_overrides_file.clone(),
            libation_requests: config.libation_requests_file.clone(),
            libation_refreshes: config.data_dir.join("libation-refreshes.json"),
            libation_accounts: config.data_dir.join("libation-accounts.json"),
        }
    }

    fn all(&self) -> Vec<&PathBuf> {
        vec![
            &self.progress,
            &self.progress_backups,
            &self.book_settings,
            &self.users,
            &self.sessions,
            &self.activity,
            &self.metadata_overrides,
            &self.libation_requests,
            &self.libation_refreshes,
            &self.libation_accounts,
        ]
    }

    fn any_present(&self) -> bool {
        self.all().iter().any(|path| path.is_file())
    }
}

fn read_json<T: serde::de::DeserializeOwned + Default>(path: &FsPath) -> anyhow::Result<T> {
    match std::fs::read_to_string(path) {
        Ok(contents) if contents.trim().is_empty() => Ok(T::default()),
        Ok(contents) => Ok(serde_json::from_str(&contents)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(error.into()),
    }
}

/// Copy every JSON file that exists into a dated backup directory.
fn back_up(layout: &JsonLayout, data_dir: &FsPath) -> anyhow::Result<PathBuf> {
    let backup_dir = data_dir.join("backup-pre-sqlite");
    create_private_directory(&backup_dir)?;
    for path in layout.all() {
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name() else {
            continue;
        };
        std::fs::copy(path, backup_dir.join(name))?;
    }
    Ok(backup_dir)
}

/// Import the JSON files into an empty database.
fn import(connection: &mut rusqlite::Connection, layout: &JsonLayout) -> anyhow::Result<u64> {
    let progress: HashMap<String, Progress> = read_json(&layout.progress)?;
    let progress_backups: HashMap<String, Vec<Progress>> = read_json(&layout.progress_backups)?;
    let book_settings: HashMap<String, BookSettings> = read_json(&layout.book_settings)?;
    let users: UsersStore = read_json(&layout.users)?;
    let sessions: HashMap<String, Session> = read_json(&layout.sessions)?;
    let mut activity: ActivityStore = read_json(&layout.activity)?;
    // Older stores opened with a synthetic "everything before tracking
    // started" bucket, estimated from how far into each book the reader had
    // got. That conflated ground covered with time spent listening and could
    // only ever overstate it, so it is dropped on the way in.
    for entries in activity.by_user.values_mut() {
        entries.remove(ACTIVITY_BASELINE_KEY);
    }
    let metadata_overrides: MetadataOverrideStore = read_json(&layout.metadata_overrides)?;
    let libation_requests: LibationRequestStore = read_json(&layout.libation_requests)?;
    let libation_refreshes: LibationRefreshStore = read_json(&layout.libation_refreshes)?;
    let libation_accounts: ManagedLibationAccountStore = read_json(&layout.libation_accounts)?;

    let transaction = connection.transaction()?;
    let mut rows = 0u64;

    for (key, entry) in &progress {
        let Some((user_id, book_id)) = split_progress_key(key) else {
            tracing::warn!("skipping unparseable progress key `{key}` during import");
            continue;
        };
        transaction.execute(
            "INSERT OR REPLACE INTO progress (
                 user_id, book_id, track_id, position_seconds,
                 book_position_seconds, duration_seconds, updated_at, finished_override
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                user_id,
                book_id,
                entry.track_id,
                entry.position_seconds,
                entry.book_position_seconds,
                entry.duration_seconds,
                entry.updated_at,
                entry.finished_override.map(i64::from),
            ],
        )?;
        rows += 1;
    }

    // The JSON format did not record when a backup was made, only the saved
    // position itself. Its update time is the closest stable ordering value;
    // row insertion order preserves the order within one legacy backup list.
    for (key, entries) in &progress_backups {
        let Some((user_id, book_id)) = split_progress_key(key) else {
            tracing::warn!("skipping unparseable progress backup key `{key}` during import");
            continue;
        };
        for entry in entries {
            transaction.execute(
                "INSERT INTO progress_backups (user_id, book_id, backed_up_at, payload)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![
                    user_id,
                    book_id,
                    entry.updated_at,
                    serde_json::to_string(entry)?,
                ],
            )?;
            rows += 1;
        }
    }

    for (key, settings) in &book_settings {
        let Some((user_id, book_id)) = split_progress_key(key) else {
            tracing::warn!("skipping unparseable book settings key `{key}` during import");
            continue;
        };
        transaction.execute(
            "INSERT OR REPLACE INTO book_settings (user_id, book_id, volume_gain)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![user_id, book_id, settings.volume_gain],
        )?;
        rows += 1;
    }

    rows += write_users_rows(&transaction, &serde_json::to_string(&users)?)? as u64;
    rows += write_sessions_rows(&transaction, &serde_json::to_string(&sessions)?)? as u64;
    rows += write_activity_rows(&transaction, &serde_json::to_string(&activity)?)? as u64;

    let documents: [(&str, String); 4] = [
        (
            METADATA_OVERRIDES_DOCUMENT,
            serde_json::to_string(&metadata_overrides)?,
        ),
        (
            LIBATION_REQUESTS_DOCUMENT,
            serde_json::to_string(&libation_requests)?,
        ),
        (
            LIBATION_REFRESHES_DOCUMENT,
            serde_json::to_string(&libation_refreshes)?,
        ),
        (
            LIBATION_ACCOUNTS_DOCUMENT,
            serde_json::to_string(&libation_accounts)?,
        ),
    ];
    for (name, payload) in documents {
        db::write_document(&transaction, name, &payload)?;
        rows += 1;
    }
    db::write_document(&transaction, JSON_IMPORT_COMPLETE_DOCUMENT, "true")?;

    transaction.commit()?;
    Ok(rows)
}

/// Split `user:<id>:book:<id>` back into its two halves.
pub(crate) fn split_progress_key(key: &str) -> Option<(String, String)> {
    let rest = key.strip_prefix("user:")?;
    let separator = rest.find(":book:")?;
    Some((
        rest[..separator].to_string(),
        rest[separator + ":book:".len()..].to_string(),
    ))
}

/// Bring an existing installation's JSON files into a new database.
///
/// Does nothing when the database already exists, or when there is nothing to
/// import. Never removes the JSON files.
pub(crate) fn migrate_if_needed(
    database_path: &FsPath,
    data_dir: &FsPath,
    layout: &JsonLayout,
) -> anyhow::Result<()> {
    if database_path.exists() && migration_completed(database_path)? {
        return Ok(());
    }
    if !layout.any_present() {
        return Ok(());
    }

    tracing::info!(
        "importing existing JSON data into {}",
        database_path.display()
    );
    let backup_dir = back_up(layout, data_dir)?;
    tracing::info!("copied the existing files to {}", backup_dir.display());

    // Build alongside the live path and publish only after the transaction has
    // committed. A process killed before then leaves the JSON files as the
    // authority, and the next start simply retries from them.
    let temporary_path = database_path.with_extension("importing");
    remove_database_files(&temporary_path);
    let mut connection = db::open(&temporary_path)?;
    match import(&mut connection, layout) {
        Ok(rows) => {
            drop(connection);
            // An old database can only be an incomplete import: a completed
            // migration publishes the database atomically below. Remove it
            // before replacing it with the complete import.
            remove_database_files(database_path);
            std::fs::rename(&temporary_path, database_path)?;
            db::secure_database_files(database_path);
            tracing::info!(
                "imported {rows} records. The original files were left in place; \
                 use --export-json to write them back out."
            );
            Ok(())
        }
        Err(error) => {
            // Leave nothing half-built. The server carries on from the JSON
            // files, which have not been touched, and tries again next start.
            drop(connection);
            remove_database_files(&temporary_path);
            Err(error)
        }
    }
}

/// A database published by this migration is safe to prefer over the legacy
/// files. An unmarked database was left by an interrupted older attempt and
/// must not suppress a retry while the JSON sources remain available.
fn migration_completed(database_path: &FsPath) -> anyhow::Result<bool> {
    let connection = db::open_existing(database_path)?;
    Ok(db::read_document(&connection, JSON_IMPORT_COMPLETE_DOCUMENT)?.as_deref() == Some("true"))
}

/// Remove a database and its SQLite sidecar files. These paths are generated
/// from the one explicit database target, never user input.
fn remove_database_files(path: &FsPath) {
    for suffix in ["", "-wal", "-shm"] {
        let mut candidate = path.as_os_str().to_os_string();
        candidate.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(candidate));
    }
}

/// Write the database back out as the JSON files an older release reads.
///
/// This is the supported way back. A release that has to be rolled back does
/// not need a backup restore: run `--export-json`, then install the older
/// build, which will find the files exactly where it expects them.
pub(crate) fn export_json(
    connection: &rusqlite::Connection,
    layout: &JsonLayout,
) -> anyhow::Result<u64> {
    let mut written = 0u64;

    let mut progress: HashMap<String, Progress> = HashMap::new();
    {
        let mut statement = connection.prepare("SELECT * FROM progress")?;
        let rows = statement.query_map([], |row| {
            let user_id: String = row.get("user_id")?;
            let book_id: String = row.get("book_id")?;
            Ok((
                progress_key(&user_id, &book_id),
                Progress {
                    book_id,
                    track_id: row.get("track_id")?,
                    position_seconds: row.get("position_seconds")?,
                    book_position_seconds: row.get("book_position_seconds")?,
                    duration_seconds: row.get("duration_seconds")?,
                    updated_at: row.get("updated_at")?,
                    finished_override: row
                        .get::<_, Option<i64>>("finished_override")?
                        .map(|value| value != 0),
                },
            ))
        })?;
        for row in rows {
            let (key, entry) = row?;
            progress.insert(key, entry);
            written += 1;
        }
    }

    let mut progress_backups: HashMap<String, Vec<Progress>> = HashMap::new();
    {
        let mut statement = connection
            .prepare("SELECT user_id, book_id, payload FROM progress_backups ORDER BY rowid")?;
        let rows = statement.query_map([], |row| {
            Ok((
                progress_key(&row.get::<_, String>(0)?, &row.get::<_, String>(1)?),
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (key, payload) = row?;
            progress_backups
                .entry(key)
                .or_default()
                .push(serde_json::from_str(&payload)?);
            written += 1;
        }
    }

    let mut book_settings: HashMap<String, BookSettings> = HashMap::new();
    {
        let mut statement =
            connection.prepare("SELECT user_id, book_id, volume_gain FROM book_settings")?;
        let rows = statement.query_map([], |row| {
            Ok((
                progress_key(&row.get::<_, String>(0)?, &row.get::<_, String>(1)?),
                BookSettings {
                    volume_gain: row.get(2)?,
                },
            ))
        })?;
        for row in rows {
            let (key, settings) = row?;
            book_settings.insert(key, settings);
            written += 1;
        }
    }

    let users = read_users_rows(connection)?;
    let sessions = read_sessions_rows(connection)?;
    let activity = read_activity_rows(connection)?;
    let metadata_overrides: MetadataOverrideStore =
        read_document_store(connection, METADATA_OVERRIDES_DOCUMENT)?;
    let libation_requests: LibationRequestStore =
        read_document_store(connection, LIBATION_REQUESTS_DOCUMENT)?;
    let libation_refreshes: LibationRefreshStore =
        read_document_store(connection, LIBATION_REFRESHES_DOCUMENT)?;
    let libation_accounts: ManagedLibationAccountStore =
        read_document_store(connection, LIBATION_ACCOUNTS_DOCUMENT)?;
    written += users.users.len() as u64 + sessions.len() as u64 + 4;

    write_json_file(&layout.progress, &progress)?;
    write_json_file(&layout.progress_backups, &progress_backups)?;
    write_json_file(&layout.book_settings, &book_settings)?;
    write_json_file(&layout.users, &users)?;
    write_json_file(&layout.sessions, &sessions)?;
    write_json_file(&layout.activity, &activity)?;
    write_json_file(&layout.metadata_overrides, &metadata_overrides)?;
    write_json_file(&layout.libation_requests, &libation_requests)?;
    write_json_file(&layout.libation_refreshes, &libation_refreshes)?;
    write_json_file(&layout.libation_accounts, &libation_accounts)?;
    Ok(written)
}

/// The same write-temp-then-rename dance `write_json_atomic` does, without an
/// async runtime: export runs before the server starts.
fn write_json_file<T: Serialize>(path: &FsPath, value: &T) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp_path = path.with_extension("tmp-export");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp_path)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temp_path, path)?;
    Ok(())
}
