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
    /// Where the scanned library lives, for tests that grow it mid-flight.
    library_root: PathBuf,
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
        // Startup creates this; a harness that skips it makes the download
        // route fail for a reason that has nothing to do with the test.
        std::fs::create_dir_all(data_dir.join("download-temp")).unwrap();

        let audio = fixture_wav();
        for book in 0..book_count {
            let folder = library_root.join(format!("Book {book:02}"));
            std::fs::create_dir_all(&folder).unwrap();
            for track in 1..=2 {
                std::fs::write(folder.join(format!("{track:02} Track.wav")), &audio).unwrap();
            }
        }

        let database = Database::open(&data_dir.join("operalibre.db")).unwrap();
        let state = AppState {
            deployment_mode: DeploymentMode::Local,
            csrf_allowed_origins: Arc::new(build_csrf_allowed_origins(&[])),
            setup_token: Arc::new(Mutex::new(None)),
            max_upload_bytes: Some(DEFAULT_MAX_UPLOAD_GIB * GIBIBYTE_BYTES),
            max_book_download_bytes: Some(DEFAULT_MAX_BOOK_DOWNLOAD_GIB * GIBIBYTE_BYTES),
            download_temp_dir: data_dir.join("download-temp"),
            min_download_free_bytes: DEFAULT_MIN_DOWNLOAD_FREE_GIB * GIBIBYTE_BYTES,
            library_root: library_root.clone(),
            library_identities_file: data_dir.join("library-identities.json"),
            progress: Arc::new(ProgressStore::new(database.clone())),
            book_settings: Arc::new(BookSettingsStore::new(database.clone())),
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
            covers_dir: data_dir.join("covers"),
            database_path: data_dir.join("operalibre.db"),
            library: Arc::new(RwLock::new(LibraryState::default())),
            metadata_overrides: Arc::new(MetadataOverrides::new(
                database.clone(),
                StoreShape::Document(METADATA_OVERRIDES_DOCUMENT),
                MetadataOverrideStore::default(),
            )),
            jobs: Arc::new(RwLock::new(std::collections::HashMap::new())),
            users: Arc::new(UserStore::new(
                database.clone(),
                StoreShape::Users,
                UsersStore::default(),
            )),
            sessions: Arc::new(SessionStore::new(
                database.clone(),
                StoreShape::Sessions,
                std::collections::HashMap::new(),
            )),
            activity: Arc::new(ActivityLog::new(
                database.clone(),
                StoreShape::Activity,
                ActivityStore::default(),
            )),
            reading_history: Arc::new(ReadingHistoryStore::new(
                database.clone(),
                StoreShape::Document(READING_HISTORY_DOCUMENT),
                ReadingHistory::default(),
            )),
            open_sessions: Arc::new(Mutex::new(OpenSessions::default())),
            shutdown: tokio::sync::broadcast::channel(1).0,
            works: Arc::new(WorksStore::new(
                database.clone(),
                StoreShape::Document(WORKS_DOCUMENT),
                WorkStore::default(),
            )),
            libation_requests: Arc::new(LibationRequests::new(
                database.clone(),
                StoreShape::Document(LIBATION_REQUESTS_DOCUMENT),
                LibationRequestStore::default(),
            )),
            libation_refreshes: Arc::new(LibationRefreshes::new(
                database.clone(),
                StoreShape::Document(LIBATION_REFRESHES_DOCUMENT),
                LibationRefreshStore::default(),
            )),
            libation_accounts: Arc::new(LibationAccounts::new(
                database.clone(),
                StoreShape::Document(LIBATION_ACCOUNTS_DOCUMENT),
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

        let library_root = state.library_root.clone();
        Self {
            router: build_router(state, None, &[]).unwrap(),
            library_root,
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
async fn marking_finished_changes_status_without_inventing_a_read_date() {
    let server = TestServer::start(1).await;
    let token = server.setup_owner().await;
    // Keep the fixture above the server's 30-second natural-finish window so
    // position zero is unambiguously not finished.
    for track in 3..=6 {
        std::fs::write(
            server
                .library_root
                .join("Book 00")
                .join(format!("{track:02} Track.wav")),
            fixture_wav(),
        )
        .unwrap();
    }
    let rescan = server
        .send_json("POST", "/api/library/rescan", &token, serde_json::json!({}))
        .await;
    assert_eq!(rescan.status, StatusCode::OK, "{}", rescan.text());
    let library = server.get("/api/books", &token).await.json();
    let book = &library.as_array().unwrap()[0];
    let book_id = book["id"].as_str().unwrap();
    let final_track = book["tracks"].as_array().unwrap().last().unwrap();
    let final_track_id = final_track["id"].as_str().unwrap();
    let final_track_duration = final_track["durationSeconds"].as_f64().unwrap();
    let book_duration = book["durationSeconds"].as_f64().unwrap();

    let marked = server
        .send_json(
            "PUT",
            &format!("/api/books/{book_id}/completion"),
            &token,
            serde_json::json!({ "finished": true, "tzOffsetMinutes": -240 }),
        )
        .await;
    assert_eq!(marked.status, StatusCode::OK, "{}", marked.text());
    assert_eq!(marked.json()["status"], "finished");
    assert_eq!(
        server
            .get("/api/profile/completions", &token)
            .await
            .json()
            .as_array()
            .unwrap()
            .len(),
        0,
        "a status-only change was presented as a completion today"
    );
    assert_eq!(
        server.get("/api/profile/stats", &token).await.json()["booksFinished"],
        1,
        "the library status itself should still change"
    );

    // Reaching the end later must record the real completion even though the
    // prior status-only override still says finished.
    let reached = server
        .send_json(
            "PUT",
            &format!("/api/books/{book_id}/completion"),
            &token,
            serde_json::json!({
                "finished": true,
                "trackId": final_track_id,
                "positionSeconds": final_track_duration,
                "bookPositionSeconds": book_duration,
                "durationSeconds": final_track_duration,
                "tzOffsetMinutes": -240
            }),
        )
        .await;
    assert_eq!(reached.status, StatusCode::OK, "{}", reached.text());
    let completions = server.get("/api/profile/completions", &token).await.json();
    assert_eq!(completions.as_array().unwrap().len(), 1);
    assert_eq!(completions[0]["source"], "reached");
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

/// A non-owner administrator cannot mint an approver at creation time: the
/// flag is only persisted when an owner asked for it. Clients that send the
/// field regardless of role keep working, and creating administrators stays
/// owner-only.
#[tokio::test]
async fn a_non_owner_administrator_cannot_mint_a_libation_approver() {
    let server = TestServer::start(1).await;
    let owner = server.setup_owner().await;

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

    let promoted = server
        .send_json(
            "POST",
            "/api/users",
            &admin,
            serde_json::json!({
                "username": "understudy",
                "password": "understudy-password-1234",
                "isAdmin": true
            }),
        )
        .await;
    assert_eq!(
        promoted.status,
        StatusCode::FORBIDDEN,
        "{}",
        promoted.text()
    );

    let seeded = server
        .send_json(
            "POST",
            "/api/users",
            &admin,
            serde_json::json!({
                "username": "sleeper",
                "password": "sleeper-password-1234",
                "canApproveLibationRequests": true
            }),
        )
        .await;
    assert_eq!(seeded.status, StatusCode::OK, "{}", seeded.text());
    assert_eq!(
        seeded.json()["canApproveLibationRequests"],
        false,
        "a non-owner administrator minted an approver"
    );

    // An owner granting the flag alongside an administrator account still
    // works: that is the supported path.
    let granted = server
        .send_json(
            "POST",
            "/api/users",
            &owner,
            serde_json::json!({
                "username": "approver",
                "password": "approver-password-1234",
                "isAdmin": true,
                "canApproveLibationRequests": true
            }),
        )
        .await;
    assert_eq!(granted.status, StatusCode::OK, "{}", granted.text());
    assert_eq!(
        granted.json()["canApproveLibationRequests"],
        true,
        "the owner's explicit grant was dropped"
    );
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

// ---------------------------------------------------------------------------
// Library listing: conditional requests and paging
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_unchanged_library_answers_a_conditional_request_with_304() {
    let server = TestServer::start(3).await;
    let token = server.setup_owner().await;

    let first = server.get("/api/books", &token).await;
    assert_eq!(first.status, StatusCode::OK);
    let etag = first.header(header::ETAG);
    assert!(!etag.is_empty(), "the listing carried no ETag");

    let again = server
        .send(
            Request::builder()
                .uri("/api/books")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::IF_NONE_MATCH, &etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(again.status, StatusCode::NOT_MODIFIED);
    assert!(again.body.is_empty());
}

#[tokio::test]
async fn saving_a_position_invalidates_the_listing_tag() {
    let server = TestServer::start(2).await;
    let token = server.setup_owner().await;
    let (book, track) = server.first_book_and_track(&token).await;

    let etag = server.get("/api/books", &token).await.header(header::ETAG);
    save_position(&server, &token, &book, &track, 5.0, serde_json::json!({})).await;

    let after = server
        .send(
            Request::builder()
                .uri("/api/books")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::IF_NONE_MATCH, &etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(
        after.status,
        StatusCode::OK,
        "a stale tag was accepted after the position moved"
    );
}

/// A volume gain does not touch any position, so a tag derived only from
/// progress timestamps would answer 304 with the old gain still in it.
#[tokio::test]
async fn changing_a_gain_invalidates_the_listing_tag() {
    let server = TestServer::start(2).await;
    let token = server.setup_owner().await;
    let (book, _) = server.first_book_and_track(&token).await;

    let etag = server.get("/api/books", &token).await.header(header::ETAG);
    server
        .send_json(
            "PUT",
            &format!("/api/books/{book}/volume"),
            &token,
            serde_json::json!({ "volumeGain": 2.0 }),
        )
        .await;

    let after = server
        .send(
            Request::builder()
                .uri("/api/books")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::IF_NONE_MATCH, &etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(after.status, StatusCode::OK);
}

#[tokio::test]
async fn the_library_can_be_walked_a_page_at_a_time() {
    let server = TestServer::start(5).await;
    let token = server.setup_owner().await;

    let whole = server.get("/api/books", &token).await.json();
    let whole: Vec<String> = whole
        .as_array()
        .unwrap()
        .iter()
        .map(|book| book["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(whole.len(), 5);

    let mut walked = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..10 {
        let uri = match &cursor {
            Some(cursor) => format!("/api/books?limit=2&cursor={cursor}"),
            None => "/api/books?limit=2".to_string(),
        };
        let page = server.get(&uri, &token).await;
        assert_eq!(page.status, StatusCode::OK, "{}", page.text());
        for book in page.json().as_array().unwrap() {
            walked.push(book["id"].as_str().unwrap().to_string());
        }
        let next = page.header(axum::http::HeaderName::from_static("x-next-cursor"));
        if next.is_empty() {
            break;
        }
        cursor = Some(next);
    }

    assert_eq!(walked, whole, "paging did not reproduce the whole library");
}

#[tokio::test]
async fn a_page_only_contains_books_the_listener_may_see() {
    let server = TestServer::start(4).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "paged").await;
    let reader_id = server.get("/api/auth/me", &reader).await.json()["id"]
        .as_str()
        .unwrap()
        .to_string();

    let books = server.get("/api/books", &owner).await.json();
    let allowed: Vec<String> = books.as_array().unwrap()[..2]
        .iter()
        .map(|book| book["id"].as_str().unwrap().to_string())
        .collect();
    server
        .send_json(
            "PUT",
            &format!("/api/users/{reader_id}/book-access"),
            &owner,
            serde_json::json!({ "allowedBookIds": allowed }),
        )
        .await;

    let page = server.get("/api/books?limit=10", &reader).await;
    let listed: Vec<String> = page
        .json()
        .as_array()
        .unwrap()
        .iter()
        .map(|book| book["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        listed, allowed,
        "paging leaked a book the reader cannot see"
    );
}

/// A cursor can name a book that has since been removed, or that the listener
/// has just lost access to. Restarting the walk is recoverable; a 404 or an
/// empty page forever is not.
#[tokio::test]
async fn an_unknown_cursor_restarts_the_walk() {
    let server = TestServer::start(3).await;
    let token = server.setup_owner().await;

    let page = server
        .get("/api/books?limit=2&cursor=no-such-book", &token)
        .await;
    assert_eq!(page.status, StatusCode::OK, "{}", page.text());
    assert_eq!(page.json().as_array().unwrap().len(), 2);
}

/// A page that was exactly full gains a next cursor when a later-sorting book
/// arrives, with a body that did not change. The tag covers the navigation
/// state, so the conditional refetch must not answer 304 and hide the new
/// page from a paginating client.
#[tokio::test]
async fn a_new_book_invalidates_a_full_page_that_gained_a_cursor() {
    let server = TestServer::start(2).await;
    let token = server.setup_owner().await;

    let next_cursor = axum::http::HeaderName::from_static("x-next-cursor");
    let first = server.get("/api/books?limit=2", &token).await;
    assert_eq!(first.status, StatusCode::OK);
    assert!(
        first.header(next_cursor.clone()).is_empty(),
        "the whole library fit on one page, so there was no cursor"
    );
    let etag = first.header(header::ETAG);

    // Sorts after both existing books, so the first page's body is unchanged.
    let folder = server.library_root.join("Book 99");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("01 Track.wav"), fixture_wav()).unwrap();
    let rescan = server
        .send_json("POST", "/api/library/rescan", &token, serde_json::json!({}))
        .await;
    assert_eq!(rescan.status, StatusCode::OK, "{}", rescan.text());

    let again = server
        .send(
            Request::builder()
                .uri("/api/books?limit=2")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::IF_NONE_MATCH, &etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(
        again.status,
        StatusCode::OK,
        "a stale tag was accepted after the page gained a next cursor"
    );
    assert_eq!(again.json().as_array().unwrap().len(), 2);
    assert!(
        !again.header(next_cursor).is_empty(),
        "the refetch did not reveal the new page"
    );
}

// ---------------------------------------------------------------------------
// Cookie CSRF enforcement
// ---------------------------------------------------------------------------

impl TestServer {
    /// Sign in as the owner through the real route and return the session
    /// cookie it sets.
    async fn setup_owner_cookie(&self) -> String {
        let response = self
            .send(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/login")
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
        let set_cookie = response.header(SET_COOKIE);
        assert!(
            set_cookie.starts_with(super::SESSION_COOKIE_NAME),
            "login did not set the session cookie: {set_cookie}"
        );
        set_cookie.split(';').next().unwrap_or_default().to_string()
    }
}

/// POST a logout carrying only a session cookie, with extra headers.
async fn cookie_logout_with(
    server: &TestServer,
    cookie: &str,
    headers: &[(&'static str, &str)],
) -> TestResponse {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/api/auth/logout")
        .header(header::COOKIE, cookie);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    server.send(builder.body(Body::empty()).unwrap()).await
}

#[tokio::test]
async fn a_cookie_change_from_a_foreign_origin_is_refused() {
    let server = TestServer::start(1).await;
    server.setup_owner().await;
    let cookie = server.setup_owner_cookie().await;

    let response =
        cookie_logout_with(&server, &cookie, &[("origin", "https://evil.example")]).await;

    assert_eq!(
        response.status,
        StatusCode::FORBIDDEN,
        "{}",
        response.text()
    );
}

/// No Origin and no Referer means the request cannot be attributed to the web
/// app, so it is refused rather than given the benefit of the doubt.
#[tokio::test]
async fn a_cookie_change_without_any_origin_is_refused() {
    let server = TestServer::start(1).await;
    server.setup_owner().await;
    let cookie = server.setup_owner_cookie().await;

    let response = cookie_logout_with(&server, &cookie, &[]).await;

    assert_eq!(response.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_null_origin_is_refused() {
    let server = TestServer::start(1).await;
    server.setup_owner().await;
    let cookie = server.setup_owner_cookie().await;

    let response = cookie_logout_with(&server, &cookie, &[("origin", "null")]).await;

    assert_eq!(response.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_cookie_change_from_an_official_app_origin_is_allowed() {
    let server = TestServer::start(1).await;
    server.setup_owner().await;
    let cookie = server.setup_owner_cookie().await;

    let response = cookie_logout_with(
        &server,
        &cookie,
        &[("origin", super::OFFICIAL_APP_ORIGINS[0])],
    )
    .await;

    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
}

/// A same-origin browser request may carry an Origin that names this very
/// server; matching the Host header accepts it without configuration.
#[tokio::test]
async fn a_cookie_change_from_the_server_host_origin_is_allowed() {
    let server = TestServer::start(1).await;
    server.setup_owner().await;
    let cookie = server.setup_owner_cookie().await;

    let response = cookie_logout_with(
        &server,
        &cookie,
        &[
            ("origin", "http://operalibre.local:4000"),
            ("host", "operalibre.local:4000"),
        ],
    )
    .await;

    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
}

/// Some cross-origin form posts strip Origin but keep Referer.
#[tokio::test]
async fn a_matching_referer_is_accepted_when_the_origin_is_absent() {
    let server = TestServer::start(1).await;
    server.setup_owner().await;
    let cookie = server.setup_owner_cookie().await;

    let response = cookie_logout_with(
        &server,
        &cookie,
        &[
            ("referer", "http://operalibre.local:4000/library"),
            ("host", "operalibre.local:4000"),
        ],
    )
    .await;

    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
}

/// Bearer callers do not rely on ambient cookies, so a hostile page cannot
/// make their requests: the origin check does not apply to them.
#[tokio::test]
async fn bearer_requests_are_exempt_from_the_origin_check() {
    let server = TestServer::start(1).await;
    let token = server.setup_owner().await;

    let response = server
        .send(
            Request::builder()
                .method("POST")
                .uri("/api/auth/logout")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header("origin", "https://evil.example")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
}

/// The CSRF guard only narrows cookie-authenticated requests; an anonymous
/// caller must still see the ordinary 401 from missing credentials.
#[tokio::test]
async fn an_anonymous_request_is_unauthorized_not_csrf_forbidden() {
    let server = TestServer::start(1).await;
    server.setup_owner().await;

    let response = server
        .send(
            Request::builder()
                .method("POST")
                .uri("/api/auth/logout")
                .header("origin", "https://evil.example")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
}

// ---------------------------------------------------------------------------
// Operational surface
// ---------------------------------------------------------------------------

#[tokio::test]
async fn metrics_are_owner_only_and_describe_the_server() {
    let server = TestServer::start(3).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "curious").await;

    let refused = server.get("/api/metrics", &reader).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN);

    let metrics = server.get("/api/metrics", &owner).await;
    assert_eq!(metrics.status, StatusCode::OK, "{}", metrics.text());
    let metrics = metrics.json();
    assert_eq!(metrics["books"], 3);
    assert_eq!(metrics["tracks"], 6);
    assert_eq!(metrics["users"], 2);
    assert_eq!(metrics["listeningNow"], 0);
    assert!(metrics["activeSessions"].as_u64().unwrap() >= 1);
    assert!(metrics["databaseBytes"].as_u64().unwrap() > 0);
    assert!(!metrics["version"].as_str().unwrap().is_empty());
}

#[tokio::test]
async fn metrics_count_a_listener_who_just_saved_a_position() {
    let server = TestServer::start(2).await;
    let owner = server.setup_owner().await;
    let (book, track) = server.first_book_and_track(&owner).await;

    save_position(&server, &owner, &book, &track, 3.0, serde_json::json!({})).await;

    let metrics = server.get("/api/metrics", &owner).await.json();
    assert_eq!(metrics["listeningNow"], 1);
}

/// Two people on the same book are two listeners, and one person touching two
/// books is one listener: the count is of people, not of books.
#[tokio::test]
async fn listening_now_counts_people_not_books() {
    let server = TestServer::start(2).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "second").await;
    let (book, track) = server.first_book_and_track(&owner).await;

    save_position(&server, &owner, &book, &track, 3.0, serde_json::json!({})).await;
    save_position(&server, &reader, &book, &track, 4.0, serde_json::json!({})).await;

    let metrics = server.get("/api/metrics", &owner).await.json();
    assert_eq!(
        metrics["listeningNow"], 2,
        "two listeners on one book were collapsed into one"
    );
}

/// The request timeout must not sit in front of a book download: the archive
/// is built before the response begins, and a large book takes minutes.
#[tokio::test]
async fn downloading_a_book_is_not_behind_the_request_timeout() {
    let server = TestServer::start(1).await;
    let token = server.setup_owner().await;
    let (book, _) = server.first_book_and_track(&token).await;

    let response = server
        .get(&format!("/api/books/{book}/download"), &token)
        .await;

    // The point is that the route answers on its own terms. A timeout layer in
    // front of it would surface as 408 rather than a real answer.
    assert_ne!(
        response.status,
        StatusCode::REQUEST_TIMEOUT,
        "the download route was placed behind the request timeout"
    );
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    assert!(!response.body.is_empty(), "the archive was empty");
}

#[tokio::test]
async fn an_oversized_json_body_is_refused() {
    let server = TestServer::start(1).await;
    let token = server.setup_owner().await;
    let (book, track) = server.first_book_and_track(&token).await;

    // Well past MAX_JSON_BODY_BYTES, padded with a field the payload ignores.
    let padding = "x".repeat(2 * 1024 * 1024);
    let response = server
        .send_json(
            "PUT",
            &format!("/api/books/{book}/progress"),
            &token,
            serde_json::json!({
                "trackId": track,
                "positionSeconds": 1.0,
                "padding": padding,
            }),
        )
        .await;

    assert_eq!(response.status, StatusCode::PAYLOAD_TOO_LARGE);
}

// ---------------------------------------------------------------------------
// Third-party client surfaces
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_opds_catalogue_lists_only_what_the_reader_may_hear() {
    let server = TestServer::start(3).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "opds-reader").await;
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

    let root = server.get("/api/opds", &reader).await;
    assert_eq!(root.status, StatusCode::OK);
    assert!(root.header(header::CONTENT_TYPE).contains("opds-catalog"));
    assert!(root.text().contains("/api/opds/books"));

    let feed = server.get("/api/opds/books", &reader).await;
    assert_eq!(feed.status, StatusCode::OK, "{}", feed.text());
    let body = feed.text();
    assert_eq!(
        body.matches("<entry>").count(),
        1,
        "the feed showed books the reader cannot hear"
    );
    assert!(body.contains(&format!("urn:operalibre:book:{allowed}")));
    assert!(body.contains("opds-spec.org/acquisition"));
    // Well-formed enough that a reader will not choke on the declaration.
    assert!(body.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"));

    // Many OPDS readers cannot attach a Bearer header while following feed
    // links, so the same read-only media credential used by playback must be
    // accepted on both catalogue routes.
    let media_token = media_token_for_session(&reader);
    let root_uri = format!("/api/opds?token={media_token}");
    let root = server
        .send(
            Request::builder()
                .uri(&root_uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(root.status, StatusCode::OK, "{}", root.text());
    assert!(
        root.text()
            .contains(&format!("/api/opds/books?token={media_token}"))
    );

    let books_uri = format!("/api/opds/books?token={media_token}");
    let books = server
        .send(
            Request::builder()
                .uri(&books_uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(books.status, StatusCode::OK, "{}", books.text());
    assert!(
        books
            .text()
            .contains(&format!("stream?token={media_token}"))
    );
}

#[test]
fn opds_entries_escape_text_that_would_break_the_feed() {
    // The title comes from a file name or a tag, so it can contain anything.
    assert_eq!(
        super::xml_escape("Tom & Jerry <\"quoted\">"),
        "Tom &amp; Jerry &lt;&quot;quoted&quot;&gt;"
    );
    assert_eq!(super::xml_escape("bell\u{7}here"), "bellhere");
    assert_eq!(
        super::xml_escape("before\u{FFFE}\u{FFFF}after"),
        "beforeafter"
    );
}

#[tokio::test]
async fn an_audiobookshelf_client_can_sign_in_and_browse() {
    let server = TestServer::start(2).await;
    server.setup_owner().await;

    // The official client performs both discovery checks without credentials
    // before it will present or reuse the login form.
    let status = server
        .send(
            Request::builder()
                .uri("/abs/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(status.status, StatusCode::OK, "{}", status.text());
    let status = status.json();
    assert_eq!(status["isInit"], true);
    assert_eq!(status["language"], "en-us");
    assert_eq!(status["authMethods"], serde_json::json!(["local"]));

    let ping = server
        .send(
            Request::builder()
                .uri("/abs/ping")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(ping.status, StatusCode::OK, "{}", ping.text());
    assert_eq!(ping.json()["success"], true);

    let login = server
        .send(
            Request::builder()
                .method("POST")
                .uri("/abs/login")
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
    assert_eq!(login.status, StatusCode::OK, "{}", login.text());
    let login = login.json();
    let token = login["user"]["token"].as_str().unwrap().to_string();
    assert_eq!(login["userDefaultLibraryId"], super::ABS_LIBRARY_ID);
    assert_eq!(login["user"]["username"], "owner");

    let libraries = server.get("/abs/api/libraries", &token).await.json();
    assert_eq!(libraries["libraries"][0]["id"], super::ABS_LIBRARY_ID);
    assert_eq!(libraries["libraries"][0]["mediaType"], "book");

    let items = server
        .get(
            &format!("/abs/api/libraries/{}/items", super::ABS_LIBRARY_ID),
            &token,
        )
        .await
        .json();
    assert_eq!(items["total"], 2);
    assert_eq!(items["results"][0]["kind"], "book");
    assert_eq!(items["results"][0]["title"], "Book 00");
    let item_id = items["results"][0]["id"].as_str().unwrap().to_string();

    let item = server
        .get(&format!("/abs/api/items/{item_id}"), &token)
        .await
        .json();
    assert_eq!(item["mediaType"], "book");
    assert_eq!(item["kind"], "book");
    assert_eq!(item["title"], "Book 00");
    assert_eq!(item["duration"], 20.0);
    let files = item["media"]["audioFiles"].as_array().unwrap();
    assert_eq!(files.len(), 2);
    assert_eq!(files[0]["title"], "01 Track.wav");
    assert_eq!(files[0]["mimeType"], "audio/wav");
    // A player hands this URL to the platform's audio stack, which cannot
    // attach a header, so the credential has to be in the address.
    let content_url = files[0]["contentUrl"].as_str().unwrap();
    assert!(content_url.contains("token="));
    assert!((files[1]["startOffset"].as_f64().unwrap() - 10.0).abs() < 0.5);
    // BookPlayer decodes the expanded item with the native Audiobookshelf
    // detail model, which requires these file metadata fields and the
    // item-level libraryFiles array.
    assert_eq!(item["libraryFiles"].as_array().unwrap().len(), 2);
    assert_eq!(files[0]["metadata"]["ext"], "wav");
    assert_eq!(files[0]["metadata"]["path"], "01 Track.wav");
    assert!(files[0]["metadata"].get("size").is_some());

    // BookPlayer's download flow uses the ABS item-download endpoint rather
    // than the playback-session endpoint.
    let download = server
        .get(&format!("/abs/api/items/{item_id}/download"), &token)
        .await;
    assert_eq!(download.status, StatusCode::OK, "{}", download.text());
    assert_eq!(download.headers[header::CONTENT_TYPE], "application/zip");

    let filter_data = server
        .get(
            &format!("/abs/api/libraries/{}/filterdata", super::ABS_LIBRARY_ID),
            &token,
        )
        .await;
    assert_eq!(filter_data.status, StatusCode::OK, "{}", filter_data.text());
    let filter_data = filter_data.json();
    for field in [
        "authors",
        "genres",
        "tags",
        "series",
        "narrators",
        "languages",
    ] {
        assert!(
            filter_data[field].is_array(),
            "missing filter field {field}"
        );
    }

    let search = server
        .get(
            &format!(
                "/abs/api/libraries/{}/search?q=Book%2000",
                super::ABS_LIBRARY_ID
            ),
            &token,
        )
        .await;
    assert_eq!(search.status, StatusCode::OK, "{}", search.text());
    assert_eq!(search.json()["book"].as_array().unwrap().len(), 1);

    // A genre advertised by filterdata must be usable as a BookPlayer filter.
    let genre = filter_data["genres"]
        .as_array()
        .and_then(|genres| genres.first())
        .and_then(serde_json::Value::as_str);
    if let Some(genre) = genre {
        let encoded = general_purpose::STANDARD.encode(genre);
        let filtered = server
            .get(
                &format!(
                    "/abs/api/libraries/{}/items?filter=genres.{encoded}",
                    super::ABS_LIBRARY_ID
                ),
                &token,
            )
            .await;
        assert_eq!(filtered.status, StatusCode::OK, "{}", filtered.text());
        assert!(!filtered.json()["results"].as_array().unwrap().is_empty());
    }

    // Clients configured with `https://server/abs` concatenate that base with
    // the returned path. The composed URL must remain a working, query-token
    // authenticated stream without an Authorization header.
    let composed_url = format!("/abs{content_url}");
    let streamed = server
        .send(
            Request::builder()
                .uri(&composed_url)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(streamed.status, StatusCode::OK, "{}", streamed.text());
    assert_eq!(streamed.body.len(), fixture_wav().len());

    // The same derived credential is accepted by the ABS-prefixed cover
    // alias. This fixture has no cover, so reaching the handler is a 404; an
    // auth wiring failure would be a 401.
    let media_token = media_token_for_session(&token);
    let cover = server
        .send(
            Request::builder()
                .uri(format!(
                    "/abs/api/books/{item_id}/cover?token={media_token}"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(cover.status, StatusCode::NOT_FOUND, "{}", cover.text());

    let unknown = server
        .get("/abs/api/libraries/not-a-library/items", &token)
        .await;
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);
}

/// The compatibility layer is a translation, not a second copy of the data: a
/// position saved by a third-party player has to be the same position the web
/// app resumes from.
#[tokio::test]
async fn a_position_synced_by_an_audiobookshelf_client_is_the_same_position() {
    let server = TestServer::start(1).await;
    let token = server.setup_owner().await;
    let (book, _) = server.first_book_and_track(&token).await;

    let patched = server
        .send(
            Request::builder()
                .method("PATCH")
                .uri(format!("/abs/api/me/progress/{book}"))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({ "currentTime": 14.0, "duration": 20.0 }).to_string(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(patched.status, StatusCode::OK, "{}", patched.text());

    // Second track of two ten-second tracks: four seconds into it.
    let native = server.get("/api/books", &token).await.json();
    let progress = &native.as_array().unwrap()[0]["progress"];
    assert!((progress["bookPositionSeconds"].as_f64().unwrap() - 14.0).abs() < 0.01);

    let synced = server
        .get(&format!("/abs/api/me/progress/{book}"), &token)
        .await
        .json();
    assert!((synced["currentTime"].as_f64().unwrap() - 14.0).abs() < 0.01);
    assert!((synced["progress"].as_f64().unwrap() - 0.7).abs() < 0.01);

    let items = server
        .get(
            &format!("/abs/api/libraries/{}/items", super::ABS_LIBRARY_ID),
            &token,
        )
        .await
        .json();
    let listed = &items["results"][0];
    assert!((listed["progress"].as_f64().unwrap() - 0.7).abs() < 0.01);
    assert!((listed["currentTime"].as_f64().unwrap() - 14.0).abs() < 0.01);
    assert_eq!(listed["isFinished"], true);

    let detailed = server
        .get(&format!("/abs/api/items/{book}"), &token)
        .await
        .json();
    assert!((detailed["progress"].as_f64().unwrap() - 0.7).abs() < 0.01);
    assert!((detailed["currentTime"].as_f64().unwrap() - 14.0).abs() < 0.01);
    let before_completion_update = synced["lastUpdate"].as_u64().unwrap();

    let session = server
        .send_json(
            "POST",
            &format!("/abs/api/items/{book}/play"),
            &token,
            serde_json::json!({}),
        )
        .await
        .json();
    assert!((session["currentTime"].as_f64().unwrap() - 14.0).abs() < 0.01);
    assert!((session["startTime"].as_f64().unwrap() - 14.0).abs() < 0.01);
    assert_eq!(session["playMethod"], 0);

    // A delayed automatic checkpoint cannot roll the listener back.
    let rejected_regression = server
        .send_json(
            "PATCH",
            &format!("/abs/api/me/progress/{book}"),
            &token,
            serde_json::json!({ "currentTime": 4.0 }),
        )
        .await;
    assert_eq!(rejected_regression.status, StatusCode::OK);
    assert!((rejected_regression.json()["currentTime"].as_f64().unwrap() - 14.0).abs() < 0.01);

    let rejected_stale = server
        .send_json(
            "PATCH",
            &format!("/abs/api/me/progress/{book}"),
            &token,
            serde_json::json!({ "currentTime": 16.0, "lastUpdate": 1 }),
        )
        .await;
    assert_eq!(rejected_stale.status, StatusCode::OK);
    assert!((rejected_stale.json()["currentTime"].as_f64().unwrap() - 14.0).abs() < 0.01);

    // Completion-only PATCHes preserve the position, and false is an explicit
    // state rather than being ignored after true.
    let finished = server
        .send_json(
            "PATCH",
            &format!("/abs/api/me/progress/{book}"),
            &token,
            serde_json::json!({ "isFinished": true }),
        )
        .await
        .json();
    assert!((finished["currentTime"].as_f64().unwrap() - 14.0).abs() < 0.01);
    assert_eq!(finished["isFinished"], true);
    let finished_revision = finished["lastUpdate"].as_u64().unwrap();
    assert!(finished_revision > before_completion_update);

    let unfinished = server
        .send_json(
            "PATCH",
            &format!("/abs/api/me/progress/{book}"),
            &token,
            serde_json::json!({ "isFinished": false }),
        )
        .await
        .json();
    assert!((unfinished["currentTime"].as_f64().unwrap() - 14.0).abs() < 0.01);
    assert_eq!(unfinished["isFinished"], false);
    assert!(unfinished["lastUpdate"].as_u64().unwrap() > finished_revision);

    // A later forward checkpoint contributes to the native activity and
    // reading-history surfaces instead of updating only the resume point.
    let forward = server
        .send_json(
            "PATCH",
            &format!("/abs/api/me/progress/{book}"),
            &token,
            serde_json::json!({ "currentTime": 16.0, "isFinished": false }),
        )
        .await;
    assert_eq!(forward.status, StatusCode::OK, "{}", forward.text());
    let stats = server.get("/api/profile/stats", &token).await.json();
    assert!(stats["totalHoursRead"].as_f64().unwrap() > 0.0);
    let completions = server.get("/api/profile/completions", &token).await.json();
    assert_eq!(completions.as_array().unwrap().len(), 1);
    let metrics = server.get("/api/metrics", &token).await.json();
    assert_eq!(metrics["listeningNow"], 1);
}

#[tokio::test]
async fn an_audiobookshelf_completion_only_update_does_not_invent_a_read_date() {
    let server = TestServer::start(1).await;
    let token = server.setup_owner().await;
    for track in 3..=6 {
        std::fs::write(
            server
                .library_root
                .join("Book 00")
                .join(format!("{track:02} Track.wav")),
            fixture_wav(),
        )
        .unwrap();
    }
    let rescan = server
        .send_json("POST", "/api/library/rescan", &token, serde_json::json!({}))
        .await;
    assert_eq!(rescan.status, StatusCode::OK, "{}", rescan.text());
    let (book, _) = server.first_book_and_track(&token).await;

    let marked = server
        .send_json(
            "PATCH",
            &format!("/abs/api/me/progress/{book}"),
            &token,
            serde_json::json!({ "isFinished": true }),
        )
        .await;
    assert_eq!(marked.status, StatusCode::OK, "{}", marked.text());
    assert_eq!(marked.json()["isFinished"], true);
    assert!(
        server
            .get("/api/profile/completions", &token)
            .await
            .json()
            .as_array()
            .unwrap()
            .is_empty()
    );

    let reached = server
        .send_json(
            "PATCH",
            &format!("/abs/api/me/progress/{book}"),
            &token,
            serde_json::json!({ "currentTime": 60.0 }),
        )
        .await;
    assert_eq!(reached.status, StatusCode::OK, "{}", reached.text());
    assert_eq!(
        server
            .get("/api/profile/completions", &token)
            .await
            .json()
            .as_array()
            .unwrap()
            .len(),
        1,
        "the later position-based completion was suppressed by the manual mark"
    );
}

#[tokio::test]
async fn missing_audiobookshelf_progress_is_not_found() {
    let server = TestServer::start(1).await;
    let token = server.setup_owner().await;
    let (book, _) = server.first_book_and_track(&token).await;

    let response = server
        .get(&format!("/abs/api/me/progress/{book}"), &token)
        .await;

    assert_eq!(
        response.status,
        StatusCode::NOT_FOUND,
        "{}",
        response.text()
    );
}

#[tokio::test]
async fn the_compatibility_layer_honours_book_access() {
    let server = TestServer::start(3).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "abs-reader").await;
    let reader_id = server.get("/api/auth/me", &reader).await.json()["id"]
        .as_str()
        .unwrap()
        .to_string();

    let books = server.get("/api/books", &owner).await.json();
    let books = books.as_array().unwrap();
    let allowed = books[0]["id"].as_str().unwrap().to_string();
    let denied = books[1]["id"].as_str().unwrap().to_string();
    server
        .send_json(
            "PUT",
            &format!("/api/users/{reader_id}/book-access"),
            &owner,
            serde_json::json!({ "allowedBookIds": [allowed] }),
        )
        .await;

    let items = server
        .get(
            &format!("/abs/api/libraries/{}/items", super::ABS_LIBRARY_ID),
            &reader,
        )
        .await
        .json();
    assert_eq!(items["total"], 1);

    for uri in [
        format!("/abs/api/items/{denied}"),
        format!("/abs/api/me/progress/{denied}"),
    ] {
        let response = server.get(&uri, &reader).await;
        assert!(
            response.status == StatusCode::FORBIDDEN || response.status == StatusCode::NOT_FOUND,
            "{uri} leaked to a reader without access: {}",
            response.status
        );
    }
}

#[tokio::test]
async fn the_compatibility_layer_requires_a_session() {
    let server = TestServer::start(1).await;
    server.setup_owner().await;

    for uri in ["/abs/api/me", "/abs/api/libraries"] {
        let response = server
            .send(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await;
        assert_eq!(response.status, StatusCode::UNAUTHORIZED, "{uri}");
    }
}
