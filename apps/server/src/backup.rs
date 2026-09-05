//! Owner-managed export and restore of durable server state.
//!
//! The audiobook library, server configuration, and Libation's external
//! sign-in profile files are intentionally outside this format. All database
//! state is included: OperaLibre account credentials and permissions, sessions,
//! progress and its rollback rows, per-book settings, activity, reading
//! history, metadata, works, Libation records, and the identity index that
//! keeps those rows attached to books.
//!
//! Sessions are exported for format compatibility but never restored: a
//! backup file has been outside the server's control since it was written,
//! and reviving the tokens in it would sign every device that held one back
//! in. A restore signs everyone out except the owner performing it.

use crate::*;
use rusqlite::OptionalExtension;

pub(crate) const MAX_BACKUP_BODY_BYTES: usize = 256 * 1024 * 1024;
const BACKUP_KIND: &str = "operalibre-server-backup";
const BACKUP_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ServerBackup {
    kind: String,
    format_version: u32,
    database_schema_version: i64,
    created_at: String,
    data: BackupData,
    library_identities: LibraryIdentityStore,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupData {
    users: UsersStore,
    sessions: HashMap<String, Session>,
    progress: Vec<BackupProgress>,
    progress_backups: Vec<BackupProgressBackup>,
    book_settings: Vec<BackupBookSettings>,
    activity: ActivityStore,
    documents: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupProgress {
    user_id: String,
    book_id: String,
    progress: Progress,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupProgressBackup {
    user_id: String,
    book_id: String,
    backed_up_at: String,
    progress: Progress,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupBookSettings {
    user_id: String,
    book_id: String,
    volume_gain: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreResult {
    restored_at: String,
    safety_backup: String,
    accounts: usize,
    progress_records: usize,
    reading_sessions: usize,
    completions: usize,
    session_retained: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

pub(crate) async fn export_server_backup(
    State(state): State<AppState>,
    _: OwnerUser,
) -> Result<Response, ApiError> {
    let _backup_guard = state.backup_lock.lock().await;
    let _state_guard = state.database.quiesce_state().await;
    let backup = build_backup(&state).await?;
    let contents = serde_json::to_vec_pretty(&backup)?;
    let filename = format!("operalibre-backup-{}.json", unix_now_seconds());
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/json")
        .header(CACHE_CONTROL, "no-store")
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .body(Body::from(contents))?)
}

pub(crate) async fn import_server_backup(
    State(state): State<AppState>,
    _: OwnerUser,
    Extension(SessionToken(current_session)): Extension<SessionToken>,
    Json(backup): Json<ServerBackup>,
) -> Result<Json<RestoreResult>, ApiError> {
    let _backup_guard = state.backup_lock.lock().await;
    validate_backup_header(&backup)?;
    // The identity index is rewritten below, and a scan running at the same
    // time would read the old index and write it back over the restored one.
    // Taken before the state gate: a scan holds the rescan lock while it
    // commits its works through the gate, so the other order could deadlock
    // a restore against a scan.
    let rescan_guard = state.rescan_lock.lock().await;
    let state_guard = state.database.quiesce_state().await;

    // A restore should include the useful tail of a sitting that is still in
    // memory, and its safety copy should as well. The live sitting itself is
    // cleared only after the replacement commits.
    let before = build_backup(&state).await?;
    let mut safety_suffix = [0u8; 8];
    rand::rng().fill(&mut safety_suffix);
    let safety_name = format!(
        "pre-restore-{}-{:016x}.operalibre-backup.json",
        unix_now_seconds(),
        u64::from_le_bytes(safety_suffix)
    );
    let safety_dir = state
        .database_path
        .parent()
        .ok_or_else(|| ApiError::internal("The server database has no data directory."))?
        .join("restore-backups");
    create_private_directory(&safety_dir)?;
    write_bytes_atomic(
        &safety_dir.join(&safety_name),
        &serde_json::to_vec_pretty(&before)?,
    )
    .await?;

    // The sessions in the file are not revived (see the module notes). The
    // owner's own live session — taken from the running server, never from
    // the backup — is carried across so the page they are on keeps working.
    let retained_session = state
        .sessions
        .read()
        .await
        .get(&current_session)
        .cloned()
        .filter(|session| {
            backup
                .data
                .users
                .users
                .iter()
                .any(|user| user.id == session.user_id)
        });
    let retained_sessions: HashMap<String, Session> = retained_session
        .map(|session| (current_session.clone(), session))
        .into_iter()
        .collect();
    let session_retained = retained_sessions.contains_key(&current_session);

    let database_path = state.database_path.clone();
    let restored_data = backup.data.clone();
    let snapshot = tokio::task::spawn_blocking(move || {
        restore_database(&database_path, &restored_data, &retained_sessions)
    })
    .await
    .map_err(|error| ApiError::internal(format!("Backup restore task failed: {error}")))?
    .map_err(|error| ApiError::bad_request(format!("The backup could not be restored: {error}")))?;

    if let Err(identity_error) =
        write_json_atomic(&state.library_identities_file, &backup.library_identities).await
    {
        let database_path = state.database_path.clone();
        let rollback_data = before.data.clone();
        // Rolling back puts the sessions that were live a moment ago back.
        let rollback = tokio::task::spawn_blocking(move || {
            let sessions = rollback_data.sessions.clone();
            restore_database(&database_path, &rollback_data, &sessions)
        })
        .await;
        return match rollback {
            Ok(Ok(_)) => Err(ApiError::internal(format!(
                "Could not restore the library identity index; the database was returned to its previous state: {}",
                identity_error.message
            ))),
            _ => Err(ApiError::internal(format!(
                "Could not restore the library identity index, and automatic database rollback also failed. Use {safety_name} from the restore-backups directory."
            ))),
        };
    }

    adopt_snapshot(&state, snapshot).await;
    *state.open_sessions.lock().await = OpenSessions::default();
    state.libation_login_sessions.lock().await.clear();
    drop(state_guard);
    // `rescan_library` takes the rescan lock itself. Another scan may slip in
    // between here and there, but it reads the restored index and so can do
    // no harm; the lock only had to cover the write.
    drop(rescan_guard);

    // The data restore is already complete at this point. A temporarily
    // unavailable library must not turn that success into a misleading 500;
    // retain the previous in-memory catalogue and report that a later rescan
    // is still needed.
    let warning = match rescan_library(&state).await {
        Ok(()) => None,
        Err(error) => {
            tracing::warn!("server data restored but library rescan failed: {error}");
            Some("Server data was restored, but the audiobook library could not be rescanned. Check that the library is available, then run Rescan library.".to_string())
        }
    };

    let history: ReadingHistory = backup
        .data
        .documents
        .get(READING_HISTORY_DOCUMENT)
        .cloned()
        .map(serde_json::from_value)
        .transpose()?
        .unwrap_or_default();
    Ok(Json(RestoreResult {
        restored_at: rfc3339_utc(unix_now_seconds()),
        safety_backup: safety_name,
        accounts: backup.data.users.users.len(),
        progress_records: backup.data.progress.len(),
        reading_sessions: history.sessions.len(),
        completions: history.completions.len(),
        session_retained,
        warning,
    }))
}

async fn build_backup(state: &AppState) -> Result<ServerBackup, ApiError> {
    let database_path = state.database_path.clone();
    let mut data = tokio::task::spawn_blocking(move || read_database(&database_path))
        .await
        .map_err(|error| ApiError::internal(format!("Backup snapshot task failed: {error}")))?
        .map_err(ApiError::from)?;

    // Overlay open reading rows onto the committed history without closing the
    // listener's current sitting or changing production state.
    let mut history = state.reading_history.read().await.clone();
    let open_rows = state.open_sessions.lock().await.backup_rows();
    if !open_rows.is_empty() {
        let ids = open_rows.iter().map(|row| &row.id).collect::<HashSet<_>>();
        history.sessions.retain(|row| !ids.contains(&row.id));
        history.sessions.extend(open_rows);
    }
    data.documents.insert(
        READING_HISTORY_DOCUMENT.to_string(),
        serde_json::to_value(history)?,
    );

    let library_identities = load_library_identities(&state.library_identities_file)
        .await
        .map_err(ApiError::from)?;
    Ok(ServerBackup {
        kind: BACKUP_KIND.to_string(),
        format_version: BACKUP_FORMAT_VERSION,
        database_schema_version: SCHEMA_VERSION,
        created_at: rfc3339_utc(unix_now_seconds()),
        data,
        library_identities,
    })
}

fn validate_backup_header(backup: &ServerBackup) -> Result<(), ApiError> {
    if backup.kind != BACKUP_KIND {
        return Err(ApiError::bad_request(
            "This is not an OperaLibre server backup.",
        ));
    }
    if backup.format_version > BACKUP_FORMAT_VERSION
        || backup.database_schema_version > SCHEMA_VERSION
    {
        return Err(ApiError::bad_request(
            "This backup was created by a newer OperaLibre server. Update this server before restoring it.",
        ));
    }
    if backup.format_version != BACKUP_FORMAT_VERSION {
        return Err(ApiError::bad_request(
            "This backup format is not supported.",
        ));
    }
    if backup.library_identities.version > IDENTITY_FORMAT_VERSION {
        return Err(ApiError::bad_request(
            "This backup uses a newer library identity format. Update this server before restoring it.",
        ));
    }
    if !backup.data.users.users.iter().any(|user| user.is_owner) {
        return Err(ApiError::bad_request(
            "The backup has no owner account and would lock the server administration page.",
        ));
    }
    Ok(())
}

fn read_database(path: &FsPath) -> anyhow::Result<BackupData> {
    let mut connection = db::open_existing(path)?;
    let transaction = connection.transaction()?;

    let users = read_users_rows(&transaction)?;
    let sessions = read_sessions_rows(&transaction)?;
    let activity = read_activity_rows(&transaction)?;

    let mut progress = Vec::new();
    {
        let mut statement =
            transaction.prepare("SELECT * FROM progress ORDER BY user_id, book_id")?;
        let rows = statement.query_map([], |row| {
            let user_id: String = row.get("user_id")?;
            let book_id: String = row.get("book_id")?;
            Ok(BackupProgress {
                user_id,
                book_id: book_id.clone(),
                progress: Progress {
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
            })
        })?;
        progress.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
    }

    let mut progress_backups = Vec::new();
    {
        let mut statement = transaction.prepare(
            "SELECT user_id, book_id, backed_up_at, payload FROM progress_backups ORDER BY rowid",
        )?;
        let rows = statement.query_map([], |row| {
            let payload: String = row.get(3)?;
            let progress = serde_json::from_str(&payload)
                .map_err(|error| rusqlite::Error::InvalidParameterName(error.to_string()))?;
            Ok(BackupProgressBackup {
                user_id: row.get(0)?,
                book_id: row.get(1)?,
                backed_up_at: row.get(2)?,
                progress,
            })
        })?;
        progress_backups.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
    }

    let mut book_settings = Vec::new();
    {
        let mut statement = transaction.prepare(
            "SELECT user_id, book_id, volume_gain FROM book_settings ORDER BY user_id, book_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(BackupBookSettings {
                user_id: row.get(0)?,
                book_id: row.get(1)?,
                volume_gain: row.get(2)?,
            })
        })?;
        book_settings.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
    }

    let mut documents = BTreeMap::new();
    {
        let mut statement =
            transaction.prepare("SELECT name, payload FROM documents ORDER BY name")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (name, payload) = row?;
            documents.insert(name, serde_json::from_str(&payload)?);
        }
    }
    transaction.commit()?;
    Ok(BackupData {
        users,
        sessions,
        progress,
        progress_backups,
        book_settings,
        activity,
        documents,
    })
}

/// Replace the database's contents with `data`, keeping only `sessions` —
/// which the caller chooses, so the ones in a backup file stay in the file.
fn restore_database(
    path: &FsPath,
    data: &BackupData,
    sessions: &HashMap<String, Session>,
) -> anyhow::Result<CachedSnapshot> {
    let mut connection = db::open_existing(path)?;
    let transaction = connection.transaction()?;
    transaction.execute("DELETE FROM book_access", [])?;
    transaction.execute("DELETE FROM sessions", [])?;
    transaction.execute("DELETE FROM progress", [])?;
    transaction.execute("DELETE FROM progress_backups", [])?;
    transaction.execute("DELETE FROM book_settings", [])?;
    transaction.execute("DELETE FROM activity", [])?;
    transaction.execute("DELETE FROM users", [])?;
    transaction.execute("DELETE FROM documents", [])?;

    write_users_rows(&transaction, &serde_json::to_string(&data.users)?)?;
    write_sessions_rows(&transaction, &serde_json::to_string(sessions)?)?;
    write_activity_rows(&transaction, &serde_json::to_string(&data.activity)?)?;

    for row in &data.progress {
        if row.progress.book_id != row.book_id {
            anyhow::bail!("a progress record has mismatched book IDs");
        }
        transaction.execute(
            "INSERT INTO progress (
                user_id, book_id, track_id, position_seconds,
                book_position_seconds, duration_seconds, updated_at, finished_override
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                row.user_id,
                row.book_id,
                row.progress.track_id,
                row.progress.position_seconds,
                row.progress.book_position_seconds,
                row.progress.duration_seconds,
                row.progress.updated_at,
                row.progress.finished_override.map(i64::from),
            ],
        )?;
    }
    for row in &data.progress_backups {
        if row.progress.book_id != row.book_id {
            anyhow::bail!("a progress backup has mismatched book IDs");
        }
        transaction.execute(
            "INSERT INTO progress_backups (user_id, book_id, backed_up_at, payload)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                row.user_id,
                row.book_id,
                row.backed_up_at,
                serde_json::to_string(&row.progress)?,
            ],
        )?;
    }
    for row in &data.book_settings {
        transaction.execute(
            "INSERT INTO book_settings (user_id, book_id, volume_gain) VALUES (?1, ?2, ?3)",
            rusqlite::params![row.user_id, row.book_id, row.volume_gain],
        )?;
    }
    for (name, value) in &data.documents {
        db::write_document(&transaction, name, &serde_json::to_string(value)?)?;
    }

    // Known document shapes and relational constraints are validated before
    // the transaction commits, so malformed backups cannot partially replace
    // a live server.
    let snapshot = read_cached_snapshot(&transaction)?;
    if !snapshot.users.users.iter().any(|user| user.is_owner) {
        anyhow::bail!("the restored data has no owner account");
    }
    let foreign_key_failure: Option<String> = transaction
        .query_row("PRAGMA foreign_key_check", [], |row| row.get(0))
        .optional()?;
    if let Some(table) = foreign_key_failure {
        anyhow::bail!("the backup contains an invalid relationship in {table}");
    }
    transaction.commit()?;
    Ok(snapshot)
}

async fn adopt_snapshot(state: &AppState, snapshot: CachedSnapshot) {
    state.users.adopt_restored(snapshot.users).await;
    state.sessions.adopt_restored(snapshot.sessions).await;
    state.activity.adopt_restored(snapshot.activity).await;
    state
        .metadata_overrides
        .adopt_restored(snapshot.metadata_overrides)
        .await;
    state
        .libation_requests
        .adopt_restored(snapshot.libation_requests)
        .await;
    state
        .libation_refreshes
        .adopt_restored(snapshot.libation_refreshes)
        .await;
    state
        .libation_accounts
        .adopt_restored(snapshot.libation_accounts)
        .await;
    state
        .reading_history
        .adopt_restored(snapshot.reading_history)
        .await;
    state.works.adopt_restored(snapshot.works).await;
}
