//! Extracted from main.rs.

use crate::*;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) deployment_mode: DeploymentMode,
    pub(crate) csrf_allowed_origins: Arc<HashSet<String>>,
    pub(crate) setup_token: Arc<Mutex<Option<SetupToken>>>,
    pub(crate) max_upload_bytes: Option<u64>,
    pub(crate) max_book_download_bytes: Option<u64>,
    pub(crate) download_temp_dir: PathBuf,
    pub(crate) min_download_free_bytes: u64,
    pub(crate) library_root: PathBuf,
    pub(crate) library_identities_file: PathBuf,
    /// Saved playback positions. The only way to reach a listener's place.
    pub(crate) progress: Arc<ProgressStore>,
    /// Per-listener, per-book playback settings.
    pub(crate) book_settings: Arc<BookSettingsStore>,
    pub(crate) libation_accounts_root: PathBuf,
    pub(crate) libation_config: LibationConfig,
    pub(crate) alignment_config: AlignmentConfig,
    /// ffmpeg/ffprobe, when they were found. `None` disables faststart
    /// conversion entirely.
    pub(crate) faststart_tools: Option<faststart::Tools>,
    pub(crate) update_manager: updates::UpdateManager,
    pub(crate) sync_dir: PathBuf,
    /// Where cover art extracted during the scan is kept.
    pub(crate) covers_dir: PathBuf,
    /// Where the database lives, for the metrics route to size.
    pub(crate) database_path: PathBuf,
    pub(crate) library: Arc<RwLock<LibraryState>>,
    /// Administrator metadata edits, cached and mirrored to disk.
    pub(crate) metadata_overrides: Arc<MetadataOverrides>,
    pub(crate) jobs: Arc<RwLock<HashMap<String, JobStatus>>>,
    /// Accounts, cached in memory and mirrored to disk.
    pub(crate) users: Arc<UserStore>,
    /// Live sessions, cached in memory and mirrored to disk.
    pub(crate) sessions: Arc<SessionStore>,
    /// Daily listening totals, cached and mirrored to disk.
    pub(crate) activity: Arc<ActivityLog>,
    /// Durable, per-listener reading sessions and immutable completion events.
    pub(crate) reading_history: Arc<ReadingHistoryStore>,
    /// Coalesces the client's frequent playback checkpoints into substantive
    /// listening sessions before they are persisted.
    pub(crate) open_sessions: Arc<Mutex<OpenSessions>>,
    /// A server-owned stop request, used when an in-process update needs the
    /// same graceful drain path as a signal-driven shutdown.
    pub(crate) shutdown: broadcast::Sender<()>,
    /// The work identity index above individual audio-file editions.
    pub(crate) works: Arc<WorksStore>,
    pub(crate) libation_requests: Arc<LibationRequests>,
    pub(crate) libation_refreshes: Arc<LibationRefreshes>,
    pub(crate) libation_accounts: Arc<LibationAccounts>,
    pub(crate) libation_login_sessions: Arc<Mutex<HashMap<String, PendingLibationLogin>>>,
    /// Library scans read and replace one shared identity snapshot. Serialize
    /// them so overlapping imports, downloads, and manual rescans cannot
    /// publish stale state over a newer scan.
    pub(crate) rescan_lock: Arc<Mutex<()>>,
    /// Libation uses shared account and library files. Run its commands one at
    /// a time so a second title has a real queue state instead of racing the
    /// first download.
    pub(crate) libation_job_lock: Arc<Mutex<()>>,
    /// Serializes the brief quota-reservation and job-creation sequence for a
    /// manual Libation refresh. The queued job is visible before the next
    /// caller checks its quota, so duplicate clicks join it rather than spend
    /// or exhaust refresh slots.
    pub(crate) libation_refresh_reservation_lock: Arc<Mutex<()>>,
    /// Faststart conversion rewrites library files. One job at a time, so two
    /// admins cannot remux the same book from opposite ends.
    pub(crate) faststart_lock: Arc<Mutex<()>>,
    pub(crate) login_attempts: Arc<Mutex<HashMap<String, LoginThrottle>>>,
    pub(crate) password_task_slots: Arc<Semaphore>,
    pub(crate) download_task_slots: Arc<Semaphore>,
    pub(crate) upload_lock: Arc<Mutex<()>>,
}

/// Assemble the full application router.
///
/// Split out of `main` so integration tests can drive the real routing,
/// authentication, and middleware stack instead of calling handlers directly.
pub(crate) fn build_router(
    state: AppState,
    web_dist_dir: Option<&FsPath>,
    allowed_origins: &[String],
) -> anyhow::Result<Router> {
    let public_routes = Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/status", get(auth_status))
        .route("/api/auth/setup", post(setup_admin))
        .route("/api/auth/login", post(login))
        // Audiobookshelf clients validate the server before presenting their
        // login form, and ping it again when checking a saved connection.
        .route("/abs/status", get(abs_status))
        .route("/abs/ping", get(abs_ping))
        // Audiobookshelf-compatible sign-in. Mounted under /abs so it cannot
        // collide with the routes above; clients take a base URL with a path.
        .route("/abs/login", post(abs_login))
        // Catch-all so unknown API paths return a JSON 404 instead of
        // falling through to the SPA fallback (or the auth middleware).
        .route("/api/{*path}", any(api_not_found))
        // Sign-in and setup wait on the password-hashing worker pool, and
        // every concurrent attempt clears the throttle check before any of
        // them records a failure. Without this bound a saturated or wedged
        // worker queue would hold unauthenticated connections open forever.
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(REQUEST_TIMEOUT_SECONDS),
        ))
        .layer(DefaultBodyLimit::max(MAX_JSON_BODY_BYTES));

    let protected_routes = Router::new()
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/me", get(me))
        .route("/api/profile/stats", get(profile_stats))
        .route("/api/metrics", get(metrics))
        // OPDS: the catalogue a third-party reader can browse. Authenticated
        // the same way everything else is, so a reader that only speaks HTTP
        // Basic cannot use it yet.
        .route("/api/opds", get(opds_root))
        .route("/api/opds/books", get(opds_books))
        // The Audiobookshelf-shaped surface those clients actually use.
        .route("/abs/api/me", get(abs_me))
        .route("/abs/api/libraries", get(abs_libraries))
        .route(
            "/abs/api/libraries/{library_id}/items",
            get(abs_library_items),
        )
        .route(
            "/abs/api/libraries/{library_id}/filterdata",
            get(abs_filter_data),
        )
        .route("/abs/api/libraries/{library_id}/search", get(abs_search))
        .route(
            "/abs/api/libraries/{library_id}/collections",
            get(abs_collections),
        )
        .route("/abs/api/collections/{collection_id}", get(abs_collection))
        .route("/abs/api/authors/{author_id}", get(abs_author))
        .route("/abs/api/items/{item_id}", get(abs_library_item))
        .route("/abs/api/items/{item_id}/cover", get(abs_cover))
        // Some clients concatenate content URLs with the configured `/abs`
        // base while others resolve their leading slash from the origin. Keep
        // both forms on the same native, access-controlled media handlers.
        .route("/abs/api/books/{book_id}/cover", get(get_cover_art))
        .route(
            "/abs/api/books/{book_id}/tracks/{track_id}/stream",
            get(stream_track),
        )
        .route(
            "/abs/api/items/{item_id}/play",
            post(abs_play).get(abs_play),
        )
        .route(
            "/abs/api/me/progress/{item_id}",
            get(abs_get_progress).patch(abs_update_progress),
        )
        .route("/api/profile/sessions", get(reading_log_sessions))
        .route("/api/profile/completions", get(reading_log_completions))
        .route("/api/works", get(list_works))
        .route("/api/works/link", post(link_work_edition))
        .route("/api/works/reject", post(reject_work_suggestion))
        .route("/api/update", get(update_status))
        .route("/api/frontend-update", get(frontend_update_status))
        .route("/api/users", get(list_users).post(create_user))
        .route("/api/users/{user_id}", delete(delete_user))
        .route("/api/users/{user_id}/password", post(change_password))
        .route("/api/users/{user_id}/book-access", put(update_book_access))
        .route("/api/users/{user_id}/role", put(update_user_role))
        .route(
            "/api/users/{user_id}/libation-access",
            put(update_libation_access),
        )
        .route(
            "/api/users/{user_id}/libation-approval",
            put(update_libation_approval),
        )
        .route("/api/me/progress-sharing", put(update_progress_sharing))
        .route("/api/activity/finishes", get(finish_feed))
        .route("/api/activity/finishes/seen", post(mark_finish_feed_seen))
        .route("/api/books", get(list_books))
        .route(
            "/api/library/faststart",
            get(faststart_status).post(start_faststart_conversion),
        )
        .route("/api/libation/status", get(libation_status))
        .route(
            "/api/libation/accounts/login/start",
            post(start_libation_account_login),
        )
        .route(
            "/api/libation/accounts/login/{session_id}",
            delete(cancel_libation_account_login),
        )
        .route(
            "/api/libation/accounts/{profile_id}",
            put(update_libation_account).delete(delete_libation_account),
        )
        .route("/api/libation/access", get(get_libation_access))
        .route("/api/libation/requests", get(list_libation_requests))
        .route(
            "/api/libation/requests/{asin}",
            post(create_libation_download_request),
        )
        .route(
            "/api/libation/requests/{request_id}/decision",
            put(decide_libation_download_request),
        )
        .route("/api/libation/books", get(list_libation_books))
        .route(
            "/api/libation/covers/{picture_id}",
            get(get_libation_cover_art),
        )
        .route("/api/libation/sync", post(sync_libation_library))
        .route(
            "/api/libation/liberate-all",
            post(liberate_all_libation_books),
        )
        .route(
            "/api/libation/books/{asin}/liberate",
            post(liberate_libation_book),
        )
        .route(
            "/api/libation/accounts/{profile_id}/books/{asin}/liberate",
            post(liberate_profile_libation_book),
        )
        .route("/api/jobs", get(list_jobs))
        .route("/api/jobs/{job_id}", get(get_job))
        .route("/api/books/{book_id}", get(get_book))
        .route("/api/books/{book_id}/metadata", put(update_book_metadata))
        .route("/api/books/{book_id}/cover", get(get_cover_art))
        .route("/api/books/{book_id}/readalong", get(get_reading_file))
        .route("/api/books/{book_id}/sync", get(get_sync_map))
        .route(
            "/api/books/{book_id}/sync/generate",
            post(generate_sync_map),
        )
        .route("/api/alignment/status", get(alignment_status))
        .route(
            "/api/books/{book_id}/progress",
            get(get_progress).put(update_progress),
        )
        .route(
            "/api/books/{book_id}/completion",
            put(update_book_completion),
        )
        .route("/api/books/{book_id}/volume", put(update_book_volume))
        .route(
            "/api/books/{book_id}/tracks/{track_id}/stream",
            get(stream_track),
        )
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(REQUEST_TIMEOUT_SECONDS),
        ))
        .layer(DefaultBodyLimit::max(MAX_JSON_BODY_BYTES))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ));

    // Routes that are expected to take a long time, and so are not given the
    // request timeout above.
    //
    // An upload is bounded by `max_upload_bytes` while it streams, and a book
    // download builds its archive before the response begins -- minutes, for a
    // large book. A timeout here would cut off exactly the transfers that most
    // need to finish, and neither route can hang without an operation behind
    // it hanging first.
    //
    // A rescan walks and fingerprints the whole library synchronously, and
    // completing a Libation sign-in waits up to 90 seconds on the browser flow
    // before running its own scan -- either can legitimately outlast the
    // timeout. The sign-in completion also removes its pending session before
    // waiting, so a 408 here would leave the client unable to retry and the
    // account stuck in `signing_in`.
    //
    // Installing an update downloads the release asset -- allowed ten minutes
    // on its own -- before extracting and installing it. `UpdateManager` sets
    // its `installing` flag before that work and clears it afterwards, so a
    // timeout that dropped the future mid-install would leave the flag set and
    // every later install refused as already in progress until a restart.
    let long_running_routes = Router::new()
        .route(
            "/api/library/upload",
            post(upload_audiobook).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/library/rescan", post(rescan))
        .route("/api/update/install", post(install_update))
        .route(
            "/api/frontend-update/install",
            post(install_frontend_update),
        )
        .route(
            "/api/libation/accounts/login/{session_id}/complete",
            post(complete_libation_account_login),
        )
        .route(
            "/api/books/{book_id}/download",
            get(download_book).delete(delete_downloaded_book),
        )
        .route("/abs/api/items/{item_id}/download", get(download_book))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ));

    let origins = OFFICIAL_APP_ORIGINS
        .iter()
        .copied()
        .chain(allowed_origins.iter().map(String::as_str))
        .map(|origin| {
            origin.parse::<HeaderValue>().map_err(|error| {
                anyhow::anyhow!("Invalid allowed_origins entry `{origin}`: {error}")
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    tracing::info!(
        configured_origins = ?allowed_origins,
        "CORS restricted to official app and configured origins"
    );
    let cors = CorsLayer::new().allow_origin(AllowOrigin::list(origins));

    let mut app = public_routes
        .merge(protected_routes)
        .merge(long_running_routes);
    if let Some(dist_dir) = web_dist_dir {
        if dist_dir.join("index.html").is_file() {
            tracing::info!("serving web app from {}", dist_dir.display());
            app = app.fallback_service(
                ServeDir::new(dist_dir).fallback(ServeFile::new(dist_dir.join("index.html"))),
            );
        } else {
            tracing::warn!(
                "web_dist_dir {} has no index.html; static file serving disabled",
                dist_dir.display()
            );
        }
    }
    Ok(app
        .layer(
            cors.allow_methods(AllowMethods::mirror_request())
                .allow_headers(AllowHeaders::mirror_request())
                // Browser clients need to read these to walk a paged listing
                // and issue conditional requests; neither is CORS-safelisted.
                .expose_headers([
                    axum::http::header::ETAG,
                    axum::http::HeaderName::from_static("x-next-cursor"),
                ])
                .allow_credentials(true),
        )
        .layer(
            TraceLayer::new_for_http().make_span_with(|request: &axum::http::Request<Body>| {
                // Never record the query string: media credentials are
                // deliberately carried in URLs for native media elements.
                tracing::info_span!(
                    "http_request",
                    method = %request.method(),
                    path = %request.uri().path(),
                )
            }),
        )
        .layer(middleware::from_fn(security_headers))
        .with_state(state))
}

pub(crate) async fn api_not_found() -> ApiError {
    ApiError::not_found("Unknown API route")
}

pub(crate) async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    for (name, value) in [
        (
            "strict-transport-security",
            "max-age=63072000; includeSubDomains",
        ),
        ("x-content-type-options", "nosniff"),
        ("x-frame-options", "SAMEORIGIN"),
        ("referrer-policy", "no-referrer"),
        (
            "permissions-policy",
            "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        ),
    ] {
        if !headers.contains_key(name) {
            headers.insert(name, HeaderValue::from_static(value));
        }
    }
    if !headers.contains_key("content-security-policy") {
        headers.insert(
            "content-security-policy",
            HeaderValue::from_static(
                "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; media-src 'self' data: blob: http: https:; connect-src 'self' http: https:; frame-src 'self' data: blob:; worker-src 'self' blob:; form-action 'self'",
            ),
        );
    }
    response
}

pub(crate) async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

#[derive(Deserialize)]
pub(crate) struct UpdateStatusQuery {
    #[serde(default)]
    pub(crate) refresh: bool,
    #[serde(default, rename = "currentVersion")]
    pub(crate) current_version: Option<String>,
}

pub(crate) async fn update_status(
    State(state): State<AppState>,
    _: AdminUser,
    Query(query): Query<UpdateStatusQuery>,
) -> Result<Json<updates::UpdateStatus>, ApiError> {
    state
        .update_manager
        .check(query.refresh)
        .await
        .map(Json)
        .map_err(|error| ApiError::bad_gateway(format!("Could not check for updates: {error}")))
}

pub(crate) async fn install_update(
    State(state): State<AppState>,
    _: OwnerUser,
) -> Result<Json<updates::UpdateInstallStarted>, ApiError> {
    let started =
        state.update_manager.install().await.map_err(|error| {
            ApiError::bad_request(format!("Could not install the update: {error}"))
        })?;
    // The updater waits for this process, so let `main` own the exit. That
    // runs the reading-session drain after this response has been accepted.
    let _ = state.shutdown.send(());
    Ok(Json(started))
}

pub(crate) async fn frontend_update_status(
    State(state): State<AppState>,
    _: AdminUser,
    Query(query): Query<UpdateStatusQuery>,
) -> Result<Json<updates::FrontendUpdateStatus>, ApiError> {
    state
        .update_manager
        .check_frontend(query.refresh, query.current_version.as_deref())
        .await
        .map(Json)
        .map_err(|error| {
            ApiError::bad_gateway(format!("Could not check for frontend updates: {error}"))
        })
}

pub(crate) async fn install_frontend_update(
    State(state): State<AppState>,
    _: OwnerUser,
) -> Result<Json<updates::UpdateInstallStarted>, ApiError> {
    state
        .update_manager
        .install_frontend()
        .await
        .map(Json)
        .map_err(|error| {
            ApiError::bad_request(format!("Could not install the frontend update: {error}"))
        })
}

/// How long a request may take before it is abandoned.
///
/// Generous on purpose. Starting a Libation sign-in waits on an external
/// browser flow for half a minute by design, so this is not a latency budget —
/// it is the point past which a handler is assumed to be stuck.
pub(crate) const REQUEST_TIMEOUT_SECONDS: u64 = 90;

/// The largest JSON body any route accepts. Uploads opt out; nothing else here
/// takes more than a small object.
pub(crate) const MAX_JSON_BODY_BYTES: usize = 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerMetrics {
    version: &'static str,
    deployment_mode: String,
    books: usize,
    tracks: usize,
    users: usize,
    active_sessions: usize,
    /// Listeners whose position moved in the last five minutes: how many
    /// people are actually listening right now.
    listening_now: usize,
    running_jobs: usize,
    database_bytes: u64,
    covers_bytes: u64,
    library_root: String,
}

/// Owner-only operational numbers, as plain JSON.
///
/// Deliberately not a Prometheus exposition: nothing here scrapes it yet, and
/// a JSON object is what the Administration screen and a curious owner with
/// `curl` can both read.
pub(crate) async fn metrics(
    State(state): State<AppState>,
    _: OwnerUser,
) -> Result<Json<ServerMetrics>, ApiError> {
    let (books, tracks) = {
        let library = state.library.read().await;
        (
            library.books.len(),
            library.books.iter().map(|book| book.tracks.len()).sum(),
        )
    };
    let now_seconds = unix_now_seconds();
    let active_sessions = state
        .sessions
        .read()
        .await
        .values()
        .filter(|session| !session.is_expired(now_seconds))
        .count();
    let running_jobs = state
        .jobs
        .read()
        .await
        .values()
        .filter(|job| is_active_job(job))
        .count();
    let listening_now = state
        .progress
        .listener_ids_active_within(5 * 60 * 1_000)
        .await?
        .len();

    Ok(Json(ServerMetrics {
        version: env!("CARGO_PKG_VERSION"),
        deployment_mode: format!("{:?}", state.deployment_mode).to_lowercase(),
        books,
        tracks,
        users: state.users.read().await.users.len(),
        active_sessions,
        listening_now,
        running_jobs,
        database_bytes: directory_bytes(&state.database_path),
        covers_bytes: directory_size(&state.covers_dir),
        library_root: state.library_root.display().to_string(),
    }))
}

/// One file's size, plus its write-ahead log if it has one.
fn directory_bytes(path: &FsPath) -> u64 {
    ["", "-wal", "-shm"]
        .iter()
        .filter_map(|suffix| {
            let mut candidate = path.as_os_str().to_os_string();
            candidate.push(suffix);
            std::fs::metadata(PathBuf::from(candidate)).ok()
        })
        .map(|metadata| metadata.len())
        .sum()
}

fn directory_size(path: &FsPath) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .filter_map(|entry| entry.metadata().ok())
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
        .sum()
}
