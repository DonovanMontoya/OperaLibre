//! End-to-end tests that drive the real router.
//!
//! Everything here goes through `build_router`, so authentication middleware,
//! CSRF enforcement, extractors, and route matching are all exercised the way a
//! real client hits them. Unit tests that call handlers directly cannot catch a
//! route wired to the wrong method, an auth layer applied to the wrong branch,
//! or a guard that was never reached.
//!
//! This lives inside the crate rather than in `tests/` because the server is
//! currently a binary-only target with no public API. When the crate gains a
//! library target it should move to `tests/` unchanged.

use super::*;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use tower::ServiceExt;

/// A booted server with a temporary data directory and a fixture library.
struct TestServer {
    router: Router,
    /// Held so the temporary directory outlives the server.
    _root: tempfile::TempDir,
}

/// Minimal valid WAV the library scanner can read a duration from.
fn fixture_wav() -> Vec<u8> {
    // 16_000 bytes per second at this format, so this is ten seconds.
    let samples = vec![0u8; 160_000];
    let mut wav = Vec::new();
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36u32 + samples.len() as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&8_000u32.to_le_bytes());
    wav.extend_from_slice(&16_000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    wav.extend_from_slice(&samples);
    wav
}

impl TestServer {
    /// Boot a server whose library holds `book_count` two-track books.
    async fn start(book_count: usize) -> Self {
        let root = tempfile::tempdir().unwrap();
        let library_root = root.path().join("library");
        let data_dir = root.path().join("data");
        std::fs::create_dir_all(&library_root).unwrap();
        std::fs::create_dir_all(&data_dir).unwrap();

        let audio = fixture_wav();
        for book in 0..book_count {
            let folder = library_root.join(format!("Book {book:02}"));
            std::fs::create_dir_all(&folder).unwrap();
            for track in 1..=2 {
                std::fs::write(folder.join(format!("{track:02} Track.wav")), &audio).unwrap();
            }
        }

        let state = AppState {
            deployment_mode: DeploymentMode::Local,
            csrf_allowed_origins: Arc::new(std::collections::HashSet::new()),
            setup_token: Arc::new(Mutex::new(None)),
            max_upload_bytes: Some(DEFAULT_MAX_UPLOAD_GIB * GIBIBYTE_BYTES),
            max_book_download_bytes: Some(DEFAULT_MAX_BOOK_DOWNLOAD_GIB * GIBIBYTE_BYTES),
            download_temp_dir: data_dir.join("download-temp"),
            min_download_free_bytes: DEFAULT_MIN_DOWNLOAD_FREE_GIB * GIBIBYTE_BYTES,
            library_root: library_root.clone(),
            library_identities_file: data_dir.join("library-identities.json"),
            progress: Arc::new(ProgressStore::new(data_dir.join("progress.json"))),
            book_settings: Arc::new(BookSettingsStore::new(data_dir.join("book-settings.json"))),
            libation_accounts_root: data_dir.join("libation-accounts"),
            libation_config: LibationConfig {
                cli_path: None,
                libation_files_dir: None,
                library_root,
                auto_refresh_hours: None,
                reader_refreshes_per_hour: DEFAULT_LIBATION_READER_REFRESHES_PER_HOUR,
            },
            alignment_config: AlignmentConfig { cli_path: None },
            faststart_tools: None,
            update_manager: updates::UpdateManager::new(data_dir.clone(), None, 4000).unwrap(),
            sync_dir: data_dir.join("sync"),
            library: Arc::new(RwLock::new(LibraryState::default())),
            metadata_overrides: Arc::new(MetadataOverrides::new(
                data_dir.join("metadata-overrides.json"),
                MetadataOverrideStore::default(),
            )),
            jobs: Arc::new(RwLock::new(std::collections::HashMap::new())),
            users: Arc::new(UserStore::new(
                data_dir.join("users.json"),
                UsersStore::default(),
            )),
            sessions: Arc::new(SessionStore::new(
                data_dir.join("sessions.json"),
                std::collections::HashMap::new(),
            )),
            activity: Arc::new(ActivityLog::new(
                data_dir.join("activity.json"),
                ActivityStore::default(),
            )),
            libation_requests: Arc::new(LibationRequests::new(
                data_dir.join("libation-requests.json"),
                LibationRequestStore::default(),
            )),
            libation_refreshes: Arc::new(LibationRefreshes::new(
                data_dir.join("libation-refreshes.json"),
                LibationRefreshStore::default(),
            )),
            libation_accounts: Arc::new(LibationAccounts::new(
                data_dir.join("libation-accounts.json"),
                ManagedLibationAccountStore::default(),
            )),
            libation_login_sessions: Arc::new(Mutex::new(std::collections::HashMap::new())),
            rescan_lock: Arc::new(Mutex::new(())),
            libation_job_lock: Arc::new(Mutex::new(())),
            libation_refresh_reservation_lock: Arc::new(Mutex::new(())),
            faststart_lock: Arc::new(Mutex::new(())),
            login_attempts: Arc::new(Mutex::new(std::collections::HashMap::new())),
            password_task_slots: Arc::new(Semaphore::new(PASSWORD_TASK_CONCURRENCY)),
            download_task_slots: Arc::new(Semaphore::new(DEFAULT_MAX_CONCURRENT_BOOK_DOWNLOADS)),
            upload_lock: Arc::new(Mutex::new(())),
        };

        rescan_library(&state).await.unwrap();

        Self {
            router: build_router(state, None, &[]).unwrap(),
            _root: root,
        }
    }

    async fn send(&self, mut request: Request<Body>) -> TestResponse {
        // `axum::serve` adds this via `into_make_service_with_connect_info`.
        // The per-IP login throttle reads it, so a bare `oneshot` would 500
        // before reaching any handler.
        request
            .extensions_mut()
            .insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
                [127, 0, 0, 1],
                51234,
            ))));
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024 * 1024)
            .await
            .unwrap()
            .to_vec();
        TestResponse {
            status,
            headers,
            body,
        }
    }

    /// Create the first owner account and return its bearer token.
    async fn setup_owner(&self) -> String {
        let response = self
            .send(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/setup")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "username": "owner",
                            "password": "owner-password-1234"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.text());
        response.json()["token"].as_str().unwrap().to_string()
    }

    /// Create a reader account and return its bearer token.
    async fn add_reader(&self, admin_token: &str, username: &str) -> String {
        let created = self
            .send(
                Request::builder()
                    .method("POST")
                    .uri("/api/users")
                    .header(header::AUTHORIZATION, format!("Bearer {admin_token}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "username": username,
                            "password": "reader-password-1234",
                            "isAdmin": false
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await;
        assert_eq!(created.status, StatusCode::OK, "{}", created.text());

        let login = self
            .send(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/login")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "username": username,
                            "password": "reader-password-1234"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await;
        assert_eq!(login.status, StatusCode::OK, "{}", login.text());
        login.json()["token"].as_str().unwrap().to_string()
    }

    /// Log in as an already-created user and return the bearer token.
    async fn add_reader_login(&self, username: &str) -> String {
        let login = self
            .send(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/login")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "username": username,
                            "password": "deputy-password-1234"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await;
        assert_eq!(login.status, StatusCode::OK, "{}", login.text());
        login.json()["token"].as_str().unwrap().to_string()
    }

    async fn get(&self, uri: &str, token: &str) -> TestResponse {
        self.send(
            Request::builder()
                .uri(uri)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
    }

    async fn send_json(
        &self,
        method: &str,
        uri: &str,
        token: &str,
        payload: serde_json::Value,
    ) -> TestResponse {
        self.send(
            Request::builder()
                .method(method)
                .uri(uri)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
    }

    /// The first book and its first track, as the API reports them.
    async fn first_book_and_track(&self, token: &str) -> (String, String) {
        let books = self.get("/api/books", token).await;
        assert_eq!(books.status, StatusCode::OK, "{}", books.text());
        let books = books.json();
        let book = &books.as_array().unwrap()[0];
        (
            book["id"].as_str().unwrap().to_string(),
            book["tracks"].as_array().unwrap()[0]["id"]
                .as_str()
                .unwrap()
                .to_string(),
        )
    }
}

struct TestResponse {
    status: StatusCode,
    headers: HeaderMap,
    body: Vec<u8>,
}

impl TestResponse {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).to_string()
    }

    fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|error| panic!("expected JSON, got {}: {error}", self.text()))
    }

    fn header(&self, name: header::HeaderName) -> String {
        self.headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string()
    }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

#[tokio::test]
async fn protected_routes_reject_an_anonymous_caller() {
    let server = TestServer::start(1).await;
    server.setup_owner().await;

    let response = server
        .send(
            Request::builder()
                .uri("/api/books")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn an_invalid_token_is_rejected() {
    let server = TestServer::start(1).await;
    server.setup_owner().await;

    let response = server.get("/api/books", "not-a-real-token").await;

    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn setup_cannot_run_twice() {
    let server = TestServer::start(1).await;
    server.setup_owner().await;

    let second = server
        .send(
            Request::builder()
                .method("POST")
                .uri("/api/auth/setup")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "username": "usurper",
                        "password": "usurper-password-1234"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await;

    assert_ne!(second.status, StatusCode::OK);
}

#[tokio::test]
async fn logging_out_invalidates_the_token() {
    let server = TestServer::start(1).await;
    let token = server.setup_owner().await;

    let logout = server
        .send_json("POST", "/api/auth/logout", &token, serde_json::json!({}))
        .await;
    assert_eq!(logout.status, StatusCode::OK, "{}", logout.text());

    let after = server.get("/api/books", &token).await;
    assert_eq!(after.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn unknown_api_paths_return_json_not_the_spa_fallback() {
    let server = TestServer::start(1).await;

    let response = server
        .send(
            Request::builder()
                .uri("/api/does-not-exist")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

    assert_eq!(response.status, StatusCode::NOT_FOUND);
    assert!(response.header(header::CONTENT_TYPE).contains("json"));
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_reader_cannot_reach_admin_routes() {
    let server = TestServer::start(1).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "reader").await;

    let listed = server.get("/api/users", &reader).await;
    assert_eq!(listed.status, StatusCode::FORBIDDEN, "{}", listed.text());

    let rescan = server
        .send_json(
            "POST",
            "/api/library/rescan",
            &reader,
            serde_json::json!({}),
        )
        .await;
    assert_eq!(rescan.status, StatusCode::FORBIDDEN, "{}", rescan.text());
}

#[tokio::test]
async fn book_access_grants_are_enforced_on_every_book_route() {
    let server = TestServer::start(2).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "restricted").await;

    let books = server.get("/api/books", &owner).await.json();
    let books = books.as_array().unwrap();
    let allowed = books[0]["id"].as_str().unwrap().to_string();
    let denied = books[1]["id"].as_str().unwrap().to_string();
    let denied_track = books[1]["tracks"].as_array().unwrap()[0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let reader_id = server.get("/api/auth/me", &reader).await.json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let grant = server
        .send_json(
            "PUT",
            &format!("/api/users/{reader_id}/book-access"),
            &owner,
            serde_json::json!({ "allowedBookIds": [allowed] }),
        )
        .await;
    assert_eq!(grant.status, StatusCode::OK, "{}", grant.text());

    // The library listing hides it.
    let visible = server.get("/api/books", &reader).await.json();
    let visible = visible.as_array().unwrap();
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0]["id"].as_str().unwrap(), allowed);

    // And every direct route refuses it, not just the listing.
    for uri in [
        format!("/api/books/{denied}"),
        format!("/api/books/{denied}/cover"),
        format!("/api/books/{denied}/tracks/{denied_track}/stream"),
    ] {
        let response = server.get(&uri, &reader).await;
        assert!(
            response.status == StatusCode::FORBIDDEN || response.status == StatusCode::NOT_FOUND,
            "{uri} leaked to a reader without access: {}",
            response.status
        );
    }
}

// ---------------------------------------------------------------------------
// Media streaming
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_full_track_request_returns_the_whole_file() {
    let server = TestServer::start(1).await;
    let token = server.setup_owner().await;
    let (book, track) = server.first_book_and_track(&token).await;

    let response = server
        .get(&format!("/api/books/{book}/tracks/{track}/stream"), &token)
        .await;

    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.header(header::ACCEPT_RANGES), "bytes");
    assert_eq!(response.body.len(), fixture_wav().len());
}

#[tokio::test]
async fn a_mid_file_range_returns_exactly_that_slice() {
    let server = TestServer::start(1).await;
    let token = server.setup_owner().await;
    let (book, track) = server.first_book_and_track(&token).await;
    let whole = fixture_wav();

    let response = server
        .send(
            Request::builder()
                .uri(format!("/api/books/{book}/tracks/{track}/stream"))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::RANGE, "bytes=100-199")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

    assert_eq!(response.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        response.header(header::CONTENT_RANGE),
        format!("bytes 100-199/{}", whole.len())
    );
    assert_eq!(response.body, whole[100..200]);
}

#[tokio::test]
async fn an_open_ended_range_runs_to_the_end_of_the_file() {
    let server = TestServer::start(1).await;
    let token = server.setup_owner().await;
    let (book, track) = server.first_book_and_track(&token).await;
    let whole = fixture_wav();

    let response = server
        .send(
            Request::builder()
                .uri(format!("/api/books/{book}/tracks/{track}/stream"))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::RANGE, "bytes=200-")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

    assert_eq!(response.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.body, whole[200..]);
}

#[tokio::test]
async fn an_unsatisfiable_range_is_refused_with_the_file_size() {
    let server = TestServer::start(1).await;
    let token = server.setup_owner().await;
    let (book, track) = server.first_book_and_track(&token).await;

    let response = server
        .send(
            Request::builder()
                .uri(format!("/api/books/{book}/tracks/{track}/stream"))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::RANGE, "bytes=999999999-")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

    assert_eq!(response.status, StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(
        response.header(header::CONTENT_RANGE),
        format!("bytes */{}", fixture_wav().len())
    );
}

// ---------------------------------------------------------------------------
// Progress, through the real route
// ---------------------------------------------------------------------------

/// Save a position and return the progress the server reports back.
async fn save_position(
    server: &TestServer,
    token: &str,
    book: &str,
    track: &str,
    seconds: f64,
    extra: serde_json::Value,
) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "trackId": track,
        "positionSeconds": seconds,
        "bookPositionSeconds": seconds,
    });
    for (key, value) in extra.as_object().cloned().unwrap_or_default() {
        payload[key] = value;
    }
    let response = server
        .send_json(
            "PUT",
            &format!("/api/books/{book}/progress"),
            token,
            payload,
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.json()
}

#[tokio::test]
async fn a_forward_position_is_saved_and_read_back() {
    let server = TestServer::start(1).await;
    let token = server.setup_owner().await;
    let (book, track) = server.first_book_and_track(&token).await;

    save_position(&server, &token, &book, &track, 2.0, serde_json::json!({})).await;
    let saved = save_position(&server, &token, &book, &track, 6.0, serde_json::json!({})).await;

    assert!((saved["bookPositionSeconds"].as_f64().unwrap() - 6.0).abs() < 0.001);

    let books = server.get("/api/books", &token).await.json();
    let progress = &books.as_array().unwrap()[0]["progress"];
    assert!((progress["bookPositionSeconds"].as_f64().unwrap() - 6.0).abs() < 0.001);
}

#[tokio::test]
async fn a_replayed_offline_checkpoint_cannot_roll_the_position_back() {
    let server = TestServer::start(1).await;
    let token = server.setup_owner().await;
    let (book, track) = server.first_book_and_track(&token).await;

    save_position(&server, &token, &book, &track, 7.0, serde_json::json!({})).await;

    // An offline queue flushing an hour-old checkpoint.
    let stale = save_position(
        &server,
        &token,
        &book,
        &track,
        1.0,
        serde_json::json!({ "updatedAtMs": unix_now_millis() - 3_600_000 }),
    )
    .await;

    assert!(
        (stale["bookPositionSeconds"].as_f64().unwrap() - 7.0).abs() < 0.001,
        "a stale checkpoint overwrote a newer position"
    );
}

#[tokio::test]
async fn an_unintentional_regression_is_refused_but_a_deliberate_seek_is_honored() {
    let server = TestServer::start(1).await;
    let token = server.setup_owner().await;
    let (book, track) = server.first_book_and_track(&token).await;

    save_position(&server, &token, &book, &track, 7.5, serde_json::json!({})).await;

    let drifted = save_position(&server, &token, &book, &track, 0.5, serde_json::json!({})).await;
    assert!(
        (drifted["bookPositionSeconds"].as_f64().unwrap() - 7.5).abs() < 0.001,
        "an unflagged backwards jump was accepted"
    );

    let sought = save_position(
        &server,
        &token,
        &book,
        &track,
        0.5,
        serde_json::json!({ "intentionalSeek": true }),
    )
    .await;
    assert!(
        (sought["bookPositionSeconds"].as_f64().unwrap() - 0.5).abs() < 0.001,
        "a deliberate seek backwards was refused"
    );
}

#[tokio::test]
async fn a_future_skewed_client_clock_cannot_lock_out_other_devices() {
    let server = TestServer::start(1).await;
    let token = server.setup_owner().await;
    let (book, track) = server.first_book_and_track(&token).await;

    // A device a year in the future writes first.
    save_position(
        &server,
        &token,
        &book,
        &track,
        2.0,
        serde_json::json!({ "updatedAtMs": unix_now_millis() + 31_536_000_000 }),
    )
    .await;

    // A correctly-clocked device must still be able to move forward.
    let later = save_position(&server, &token, &book, &track, 6.5, serde_json::json!({})).await;
    assert!(
        (later["bookPositionSeconds"].as_f64().unwrap() - 6.5).abs() < 0.001,
        "a future-skewed clock locked out a healthy device"
    );
}

#[tokio::test]
async fn progress_is_private_to_each_user() {
    let server = TestServer::start(1).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "listener").await;
    let (book, track) = server.first_book_and_track(&owner).await;

    save_position(&server, &owner, &book, &track, 6.2, serde_json::json!({})).await;

    let reader_books = server.get("/api/books", &reader).await.json();
    assert!(
        reader_books.as_array().unwrap()[0]["progress"].is_null(),
        "one user's position leaked into another user's library"
    );
}

// ---------------------------------------------------------------------------
// Authorization, enforced by the typed extractors
// ---------------------------------------------------------------------------

/// Owner-only routes, as `(method, path)`.
const OWNER_ONLY_ROUTES: &[(&str, &str)] = &[
    ("POST", "/api/update/install"),
    ("POST", "/api/frontend-update/install"),
    ("PUT", "/api/users/someone/role"),
    ("PUT", "/api/users/someone/libation-approval"),
];

/// Admin-only routes that a plain reader must never reach.
///
/// A wrong path here cannot silently pass: an unmatched route answers 404 from
/// the API catch-all, which fails the 403 assertion.
const ADMIN_ONLY_ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/users"),
    ("POST", "/api/users"),
    ("POST", "/api/library/rescan"),
    ("GET", "/api/jobs"),
    ("GET", "/api/library/faststart"),
    ("PUT", "/api/users/someone/book-access"),
    ("PUT", "/api/users/someone/libation-access"),
];

#[tokio::test]
async fn owner_only_routes_refuse_a_plain_administrator() {
    let server = TestServer::start(1).await;
    let owner = server.setup_owner().await;

    // A second administrator who is not the owner.
    let created = server
        .send_json(
            "POST",
            "/api/users",
            &owner,
            serde_json::json!({
                "username": "deputy",
                "password": "deputy-password-1234",
                "isAdmin": true
            }),
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let admin = server.add_reader_login("deputy").await;

    for (method, path) in OWNER_ONLY_ROUTES {
        let response = server
            .send_json(method, path, &admin, serde_json::json!({}))
            .await;
        assert_eq!(
            response.status,
            StatusCode::FORBIDDEN,
            "{method} {path} was reachable by a non-owner administrator"
        );
    }
}

#[tokio::test]
async fn admin_only_routes_refuse_a_reader() {
    let server = TestServer::start(1).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "bystander").await;

    for (method, path) in ADMIN_ONLY_ROUTES {
        let response = server
            .send_json(method, path, &reader, serde_json::json!({}))
            .await;
        assert_eq!(
            response.status,
            StatusCode::FORBIDDEN,
            "{method} {path} was reachable by a reader"
        );
    }
}

#[tokio::test]
async fn every_privileged_route_is_refused_before_its_body_is_read() {
    let server = TestServer::start(1).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "prober").await;

    // A body that would fail validation if it were ever deserialized. The
    // guard runs first, so the answer must be 403 rather than 400 or 422.
    for (method, path) in ADMIN_ONLY_ROUTES.iter().chain(OWNER_ONLY_ROUTES) {
        let response = server
            .send_json(
                method,
                path,
                &reader,
                serde_json::json!({ "nonsense": [1, 2, 3] }),
            )
            .await;
        assert_eq!(
            response.status,
            StatusCode::FORBIDDEN,
            "{method} {path} looked at an unauthorized caller's body"
        );
    }
}

#[tokio::test]
async fn a_misspelled_book_access_field_is_refused_rather_than_granting_everything() {
    let server = TestServer::start(2).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "limited").await;
    let reader_id = server.get("/api/auth/me", &reader).await.json()["id"]
        .as_str()
        .unwrap()
        .to_string();

    let books = server.get("/api/books", &owner).await.json();
    let allowed = books.as_array().unwrap()[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server
        .send_json(
            "PUT",
            &format!("/api/users/{reader_id}/book-access"),
            &owner,
            serde_json::json!({ "allowedBookIds": [allowed] }),
        )
        .await;

    // `bookIds` is not a field on this payload. Before `deny_unknown_fields`
    // this deserialized to `None`, which means "clear all restrictions", so a
    // typo silently handed the reader the entire library.
    let typo = server
        .send_json(
            "PUT",
            &format!("/api/users/{reader_id}/book-access"),
            &owner,
            serde_json::json!({ "bookIds": [] }),
        )
        .await;
    assert_ne!(
        typo.status,
        StatusCode::OK,
        "a misspelled field was accepted as a permission change"
    );

    let visible = server.get("/api/books", &reader).await.json();
    assert_eq!(
        visible.as_array().unwrap().len(),
        1,
        "a misspelled field widened the reader's access"
    );
}

#[tokio::test]
async fn one_listeners_gain_does_not_follow_another_listener() {
    let server = TestServer::start(1).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "second-ear").await;
    let (book, _) = server.first_book_and_track(&owner).await;

    let set = server
        .send_json(
            "PUT",
            &format!("/api/books/{book}/volume"),
            &owner,
            serde_json::json!({ "volumeGain": 2.5 }),
        )
        .await;
    assert_eq!(set.status, StatusCode::OK, "{}", set.text());

    let owner_view = server.get("/api/books", &owner).await.json();
    assert!(
        (owner_view.as_array().unwrap()[0]["volumeGain"]
            .as_f64()
            .unwrap()
            - 2.5)
            .abs()
            < 1e-9
    );

    let reader_view = server.get("/api/books", &reader).await.json();
    assert!(
        (reader_view.as_array().unwrap()[0]["volumeGain"]
            .as_f64()
            .unwrap()
            - 1.0)
            .abs()
            < 1e-9,
        "a gain set by one listener leaked to another"
    );
}

#[tokio::test]
async fn deleting_a_listener_forgets_their_position_and_settings() {
    let server = TestServer::start(1).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "departing").await;
    let reader_id = server.get("/api/auth/me", &reader).await.json()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (book, track) = server.first_book_and_track(&reader).await;

    save_position(&server, &reader, &book, &track, 4.0, serde_json::json!({})).await;
    server
        .send_json(
            "PUT",
            &format!("/api/books/{book}/volume"),
            &reader,
            serde_json::json!({ "volumeGain": 3.0 }),
        )
        .await;

    let deleted = server
        .send(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/users/{reader_id}"))
                .header(header::AUTHORIZATION, format!("Bearer {owner}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(deleted.status, StatusCode::OK, "{}", deleted.text());

    // Recreating the same username must not inherit the old account's state.
    let reborn = server.add_reader(&owner, "departing").await;
    let books = server.get("/api/books", &reborn).await.json();
    let book_view = &books.as_array().unwrap()[0];
    assert!(
        book_view["progress"].is_null(),
        "a deleted listener's position came back"
    );
    assert!(
        (book_view["volumeGain"].as_f64().unwrap() - 1.0).abs() < 1e-9,
        "a deleted listener's gain came back"
    );
}
