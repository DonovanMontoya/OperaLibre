//! OperaLibre audiobook server.
//!
//! The crate root holds the dependency imports shared across the server's
//! modules, which each pull them in with `use crate::*`. Items are grouped by
//! concern: `config` and `app` for startup and routing, `auth` for accounts and
//! sessions, `library` for scanning and metadata, `media` for streaming,
//! `progress` for playback positions, and `libation` for Audible imports.

use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{ConnectInfo, DefaultBodyLimit, Multipart, Path, Query, Request, State},
    http::{
        HeaderMap, HeaderValue, Method, StatusCode,
        header::{
            ACCEPT_RANGES, AUTHORIZATION, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE,
            CONTENT_TYPE, COOKIE, ETAG, HOST, IF_NONE_MATCH, ORIGIN, RANGE, REFERER, SET_COOKIE,
        },
    },
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::{any, delete, get, post, put},
};
use base64::{Engine as _, engine::general_purpose};
use id3::frame::Content as Id3Content;
use lofty::{
    file::{AudioFile, TaggedFileExt},
    picture::PictureType,
    prelude::Accessor,
    read_from_path,
    tag::{ItemKey, ItemValue, Tag},
};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use rand::RngExt;
use rand_core::OsRng as PasswordOsRng;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use sha2::Sha256;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env, io,
    io::{Read, Write},
    net::{IpAddr, SocketAddr},
    path::{Path as FsPath, PathBuf},
    sync::{Arc, LazyLock},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom};
use tokio::{
    fs,
    process::Command,
    sync::{Mutex, OwnedMutexGuard, OwnedSemaphorePermit, RwLock, Semaphore, broadcast},
};
use tokio_util::io::ReaderStream;
use tower_http::{
    cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer},
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use walkdir::WalkDir;

mod activity;
mod alignment;
mod app;
mod auth;
mod config;
mod db;
mod error;
mod faststart;
mod faststart_jobs;
#[cfg(test)]
mod http_tests;
mod jobs;
mod libation;
mod library;
mod media;
mod migrate;
mod progress;
mod reading;
mod reading_log;
mod storage;
mod sync;
#[cfg(test)]
mod unit_tests;
mod updates;
mod upload;
mod util;
mod works;

use activity::*;
use app::*;
use auth::*;
use config::*;
use db::*;
use error::*;
use faststart_jobs::*;
use jobs::*;
use libation::*;
use library::*;
use media::*;
use migrate::*;
use progress::*;
use reading::*;
use reading_log::*;
use storage::*;
use sync::*;
use upload::*;
use util::*;
use works::*;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "operalibre_server=info,tower_http=info".into()),
        )
        .init();

    let config = ServerConfig::load()?;
    tracing::info!(
        deployment_mode = config.deployment_mode.as_str(),
        max_upload_gib = config.max_upload_bytes.map(|bytes| bytes / GIBIBYTE_BYTES).unwrap_or(0),
        max_book_download_gib = config.max_book_download_bytes.map(|bytes| bytes / GIBIBYTE_BYTES).unwrap_or(0),
        max_concurrent_book_downloads = config.max_concurrent_book_downloads,
        download_temp_dir = %config.download_temp_dir.display(),
        min_download_free_gib = config.min_download_free_bytes / GIBIBYTE_BYTES,
        library_root = %config.library_root.display(),
        data_dir = %config.data_dir.display(),
        "server configuration loaded"
    );
    if config.max_upload_bytes.is_none() || config.max_book_download_bytes.is_none() {
        tracing::warn!(
            "one or more transfer size limits are disabled; ensure storage exhaustion is controlled externally"
        );
    }

    // Auto-update eligibility checks compare this marker against the running
    // process, so record it even when the release launcher did not start us
    // (server-only packages start via start.sh / start.cmd).
    record_server_pid(&config.data_dir)?;
    create_private_directory(&config.download_temp_dir)?;
    secure_existing_state_files(&config).await?;

    let database_path = config.data_dir.join("operalibre.db");
    if env::args().any(|argument| argument == "--export-json") {
        let layout = JsonLayout::for_config(&config);
        let connection = db::open_existing(&database_path)?;
        let written = export_json(&connection, &layout)?;
        println!(
            "Exported {written} records from {} back to JSON in {}.",
            database_path.display(),
            config.data_dir.display()
        );
        return Ok(());
    }
    let json_layout = JsonLayout::for_config(&config);
    migrate_if_needed(&database_path, &config.data_dir, &json_layout)?;
    let database = Database::open(&database_path)?;

    // Everything cached in memory now comes back out of the database. The JSON
    // files are left where they are as the rollback path, and are never read
    // again after the import above.
    let mut snapshot = database
        .call(|connection| {
            read_cached_snapshot(connection)
                .map_err(|error| rusqlite::Error::InvalidParameterName(error.to_string()))
        })
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;
    // Two data migrations used to run when their file was read.
    let promoted = migrate_users_permissions(&mut snapshot.users);
    let recovered = recover_interrupted_libation_requests(&mut snapshot.libation_requests);
    if promoted || recovered {
        let users_payload = serde_json::to_string(&snapshot.users)?;
        let requests_payload = serde_json::to_string(&snapshot.libation_requests)?;
        database
            .transaction(move |transaction| {
                if promoted {
                    write_users_rows(transaction, &users_payload)?;
                }
                if recovered {
                    db::write_document(transaction, LIBATION_REQUESTS_DOCUMENT, &requests_payload)?;
                }
                Ok(())
            })
            .await
            .map_err(|error| anyhow::anyhow!(error.message))?;
    }
    let sessions_store = snapshot.sessions;
    let activity_store = snapshot.activity;
    let metadata_overrides = snapshot.metadata_overrides;
    let libation_requests = snapshot.libation_requests;
    let libation_refreshes = snapshot.libation_refreshes;
    let libation_accounts = snapshot.libation_accounts;
    let reading_history = snapshot.reading_history;
    let works_store = snapshot.works;
    let users_store = snapshot.users.clone();
    let setup_token =
        if users_store.users.is_empty() && config.deployment_mode.allows_remote_setup() {
            let token = generate_session_token();
            tracing::warn!(
                bootstrap_token = %token,
                valid_for_minutes = SETUP_TOKEN_LIFETIME_SECONDS / 60,
                "first-run remote setup is enabled; enter this one-time token in the setup form"
            );
            Some(SetupToken::new(&token, unix_now_seconds()))
        } else {
            None
        };
    let libation_accounts_root = config.data_dir.join("libation-accounts");
    create_private_directory(&libation_accounts_root)?;
    for account in &libation_accounts.accounts {
        initialize_managed_libation_profile(
            &libation_accounts_root.join(&account.id),
            &config.library_root,
        )
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;
    }
    if users_store.users.is_empty() {
        match fs::remove_file(&config.progress_file).await {
            Ok(_) => tracing::info!(
                "no users configured yet; cleared legacy progress at {}",
                config.progress_file.display()
            ),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => tracing::warn!(
                "failed to clear legacy progress file {}: {error}",
                config.progress_file.display()
            ),
        }
        let _ = fs::remove_file(&config.activity_file).await;
    }

    let (shutdown, _) = broadcast::channel(1);
    let state = AppState {
        deployment_mode: config.deployment_mode,
        csrf_allowed_origins: Arc::new(build_csrf_allowed_origins(&config.allowed_origins)),
        setup_token: Arc::new(Mutex::new(setup_token)),
        max_upload_bytes: config.max_upload_bytes,
        max_book_download_bytes: config.max_book_download_bytes,
        download_temp_dir: config.download_temp_dir.clone(),
        min_download_free_bytes: config.min_download_free_bytes,
        library_root: config.library_root.clone(),
        library_identities_file: config.data_dir.join("library-identities.json"),
        progress: Arc::new(ProgressStore::new(database.clone())),
        book_settings: Arc::new(BookSettingsStore::new(database.clone())),
        libation_accounts_root,
        libation_config: LibationConfig::from_server_config(&config),
        alignment_config: AlignmentConfig::from_server_config(&config),
        faststart_tools: faststart::discover_tools(
            config.ffmpeg_path.clone(),
            config.ffprobe_path.clone(),
        ),
        update_manager: updates::UpdateManager::new(
            config.data_dir.clone(),
            config.web_dist_dir.clone(),
            config.port,
        )?,
        sync_dir: config.data_dir.join("sync"),
        covers_dir: config.data_dir.join("covers"),
        library: Arc::new(RwLock::new(LibraryState::default())),
        metadata_overrides: Arc::new(MetadataOverrides::new(
            database.clone(),
            StoreShape::Document(METADATA_OVERRIDES_DOCUMENT),
            metadata_overrides,
        )),
        jobs: Arc::new(RwLock::new(HashMap::new())),
        users: Arc::new(UserStore::new(
            database.clone(),
            StoreShape::Users,
            users_store,
        )),
        sessions: Arc::new(SessionStore::new(
            database.clone(),
            StoreShape::Sessions,
            sessions_store,
        )),
        activity: Arc::new(ActivityLog::new(
            database.clone(),
            StoreShape::Activity,
            activity_store,
        )),
        reading_history: Arc::new(ReadingHistoryStore::new(
            database.clone(),
            StoreShape::Document(READING_HISTORY_DOCUMENT),
            reading_history,
        )),
        open_sessions: Arc::new(Mutex::new(OpenSessions::default())),
        shutdown,
        works: Arc::new(WorksStore::new(
            database.clone(),
            StoreShape::Document(WORKS_DOCUMENT),
            works_store,
        )),
        libation_requests: Arc::new(LibationRequests::new(
            database.clone(),
            StoreShape::Document(LIBATION_REQUESTS_DOCUMENT),
            libation_requests,
        )),
        libation_refreshes: Arc::new(LibationRefreshes::new(
            database.clone(),
            StoreShape::Document(LIBATION_REFRESHES_DOCUMENT),
            libation_refreshes,
        )),
        libation_accounts: Arc::new(LibationAccounts::new(
            database.clone(),
            StoreShape::Document(LIBATION_ACCOUNTS_DOCUMENT),
            libation_accounts,
        )),
        libation_login_sessions: Arc::new(Mutex::new(HashMap::new())),
        rescan_lock: Arc::new(Mutex::new(())),
        libation_job_lock: Arc::new(Mutex::new(())),
        libation_refresh_reservation_lock: Arc::new(Mutex::new(())),
        faststart_lock: Arc::new(Mutex::new(())),
        login_attempts: Arc::new(Mutex::new(HashMap::new())),
        password_task_slots: Arc::new(Semaphore::new(PASSWORD_TASK_CONCURRENCY)),
        download_task_slots: Arc::new(Semaphore::new(config.max_concurrent_book_downloads)),
        upload_lock: Arc::new(Mutex::new(())),
    };

    rescan_library(&state).await?;
    schedule_automatic_libation_refresh(state.clone());
    schedule_reading_session_sweeper(state.clone());

    let app = build_router(
        state.clone(),
        config.web_dist_dir.as_deref(),
        &config.allowed_origins,
    )?;

    let address: SocketAddr = format!("{}:{}", config.host, config.port).parse()?;
    if config.deployment_mode == DeploymentMode::Lan {
        tracing::warn!(
            %address,
            "LAN mode permits plain HTTP and non-Secure browser cookies; use only on a trusted LAN/VPN and never expose this port directly to the Internet"
        );
    } else if config.deployment_mode == DeploymentMode::Proxy {
        tracing::info!(%address, "proxy mode expects a same-machine TLS reverse proxy");
    }
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!("server listening on http://{address}");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal(state.shutdown.subscribe()))
    .await?;
    drain_reading_sessions(&state).await;

    Ok(())
}

async fn shutdown_signal(mut shutdown: broadcast::Receiver<()>) {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
            _ = shutdown.recv() => {},
        }
    }
    #[cfg(not(unix))]
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = shutdown.recv() => {},
    }
}

// ---------------------------------------------------------------------------
// Faststart conversion
// ---------------------------------------------------------------------------
