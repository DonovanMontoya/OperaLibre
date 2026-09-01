//! SQLite storage.
//!
//! One database file holds everything the server used to keep in a directory
//! of JSON documents. Two shapes live here for two different reasons.
//!
//! Playback positions, per-book settings, listening activity, accounts, and
//! sessions are real tables with real keys. They are queried by a listener, a
//! book, or a token, and progress in particular is unbounded — one row per
//! listener per book — so loading the whole set to answer one question was the
//! thing that needed to stop.
//!
//! Metadata overrides and the Libation stores keep their JSON shape in a
//! `documents` table. They are small, bounded, already cached in memory, and
//! their structures are still moving; inventing columns for them would buy
//! nothing and cost a migration every time a field is added.

use crate::*;
use rusqlite::{Connection, OptionalExtension, params};

/// Bumped when the schema changes in a way `migrate` has to react to.
pub(crate) const SCHEMA_VERSION: i64 = 2;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id                            TEXT PRIMARY KEY,
    username                      TEXT NOT NULL,
    password_hash                 TEXT NOT NULL,
    is_admin                      INTEGER NOT NULL,
    is_owner                      INTEGER NOT NULL,
    can_approve_libation_requests INTEGER NOT NULL,
    libation_access               TEXT NOT NULL,
    share_progress                INTEGER NOT NULL,
    announce_finishes             INTEGER NOT NULL DEFAULT 1,
    notify_finishes               INTEGER NOT NULL DEFAULT 1,
    created_at                    TEXT NOT NULL,
    -- NULL means unrestricted. An empty book_access set for a user with
    -- restrictions is meaningfully different from no restrictions at all,
    -- which a join alone could not express.
    restricted                    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users (username COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS book_access (
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    book_id TEXT NOT NULL,
    PRIMARY KEY (user_id, book_id)
);

CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    -- Derived once on insert so the media-token route can look a session up
    -- directly instead of hashing every session on every range request.
    media_token TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_media_token ON sessions (media_token);

CREATE TABLE IF NOT EXISTS progress (
    user_id               TEXT NOT NULL,
    book_id               TEXT NOT NULL,
    track_id              TEXT NOT NULL,
    position_seconds      REAL NOT NULL,
    book_position_seconds REAL NOT NULL,
    duration_seconds      REAL,
    updated_at            TEXT NOT NULL,
    finished_override     INTEGER,
    PRIMARY KEY (user_id, book_id)
);
CREATE INDEX IF NOT EXISTS progress_book ON progress (book_id);

CREATE TABLE IF NOT EXISTS progress_backups (
    user_id     TEXT NOT NULL,
    book_id     TEXT NOT NULL,
    backed_up_at TEXT NOT NULL,
    payload     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS progress_backups_key ON progress_backups (user_id, book_id);

CREATE TABLE IF NOT EXISTS book_settings (
    user_id     TEXT NOT NULL,
    book_id     TEXT NOT NULL,
    volume_gain REAL NOT NULL,
    PRIMARY KEY (user_id, book_id)
);

CREATE TABLE IF NOT EXISTS activity (
    user_id TEXT NOT NULL,
    day     TEXT NOT NULL,
    seconds REAL NOT NULL,
    PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS documents (
    name    TEXT PRIMARY KEY,
    payload TEXT NOT NULL
);
"#;

/// Open the database, apply pragmas, and create the schema.
pub(crate) fn open(path: &FsPath) -> anyhow::Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let connection = Connection::open(path)?;
    // WAL is what stops readers blocking on the writer, which is the whole
    // point of moving off a single rewritten file. NORMAL is the matching
    // durability setting: a crash can lose the last transaction, a power cut
    // cannot corrupt the database.
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "busy_timeout", 5_000)?;
    connection.execute_batch(SCHEMA)?;

    let stored: Option<i64> = connection
        .query_row("SELECT version FROM schema_version", [], |row| row.get(0))
        .optional()?;
    match stored {
        None => {
            connection.execute(
                "INSERT INTO schema_version (version) VALUES (?1)",
                params![SCHEMA_VERSION],
            )?;
        }
        Some(version) if version > SCHEMA_VERSION => {
            anyhow::bail!(
                "This data directory was written by a newer OperaLibre (schema {version}, this build understands {SCHEMA_VERSION}). Upgrade the server or restore a backup."
            );
        }
        Some(version) => {
            if version < 2 {
                connection.execute_batch(
                    "ALTER TABLE users ADD COLUMN announce_finishes INTEGER NOT NULL DEFAULT 1;
                     ALTER TABLE users ADD COLUMN notify_finishes INTEGER NOT NULL DEFAULT 1;
                     UPDATE schema_version SET version = 2;",
                )?;
            }
        }
    }
    Ok(connection)
}

/// Open an already-initialized database without creating a new file.
///
/// Administrative export must never turn a misspelled data directory into an
/// empty database and then overwrite the JSON rollback files with its defaults.
pub(crate) fn open_existing(path: &FsPath) -> anyhow::Result<Connection> {
    if !path.is_file() {
        anyhow::bail!(
            "No SQLite database exists at {}. Start the server normally first, or check the data directory.",
            path.display()
        );
    }
    open(path)
}

/// A database path plus the `-wal` and `-shm` sidecars SQLite may keep beside
/// it. Anything that sizes, secures, or removes a database must cover all
/// three.
pub(crate) fn sqlite_related_paths(path: &FsPath) -> impl Iterator<Item = PathBuf> + '_ {
    ["", "-wal", "-shm"].into_iter().map(move |suffix| {
        let mut candidate = path.as_os_str().to_os_string();
        candidate.push(suffix);
        PathBuf::from(candidate)
    })
}

#[cfg(unix)]
pub(crate) fn secure_database_files(path: &FsPath) {
    use std::os::unix::fs::PermissionsExt;
    for candidate in sqlite_related_paths(path) {
        if candidate.exists() {
            let _ = std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o600));
        }
    }
}

#[cfg(not(unix))]
pub(crate) fn secure_database_files(_path: &FsPath) {}

/// A handle to the database.
///
/// `rusqlite::Connection` is `Send` but not `Sync`, and its calls block. Every
/// query therefore runs on a blocking task holding the connection lock, which
/// matches the `spawn_blocking` pattern the rest of the server already uses
/// for synchronous work.
#[derive(Clone, Debug)]
pub(crate) struct Database {
    connection: Arc<std::sync::Mutex<Connection>>,
}

impl Database {
    pub(crate) fn open(path: &FsPath) -> anyhow::Result<Self> {
        let connection = open(path)?;
        secure_database_files(path);
        Ok(Self {
            connection: Arc::new(std::sync::Mutex::new(connection)),
        })
    }

    /// Run a query on a blocking task.
    pub(crate) async fn call<T, F>(&self, work: F) -> Result<T, ApiError>
    where
        F: FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let connection = self.connection.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = connection
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            work(&mut guard)
        })
        .await
        .map_err(|error| ApiError::internal(format!("Database task failed: {error}")))?
        .map_err(|error| ApiError::internal(format!("Database error: {error}")))
    }

    /// Run a closure inside a transaction, committing only if it succeeds.
    pub(crate) async fn transaction<T, F>(&self, work: F) -> Result<T, ApiError>
    where
        F: FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<T> + Send + 'static,
        T: Send + 'static,
    {
        self.call(move |connection| {
            let transaction = connection.transaction()?;
            let outcome = work(&transaction)?;
            transaction.commit()?;
            Ok(outcome)
        })
        .await
    }
}

/// Read one JSON document, if it is there.
pub(crate) fn read_document(
    connection: &Connection,
    name: &str,
) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT payload FROM documents WHERE name = ?1",
            params![name],
            |row| row.get(0),
        )
        .optional()
}

/// Write one JSON document.
pub(crate) fn write_document(
    connection: &Connection,
    name: &str,
    payload: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO documents (name, payload) VALUES (?1, ?2)
         ON CONFLICT (name) DO UPDATE SET payload = excluded.payload",
        params![name, payload],
    )?;
    Ok(())
}
