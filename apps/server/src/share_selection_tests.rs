//! Trusted selection tests use disposable libraries and real loopback HTTP.
use super::*;

#[tokio::test]
async fn cancelled_revocation_waiter_still_persists_revocation_and_cancels_live_sender() {
    let server = SelectionHttp::start().await;
    let inventory = server.inventory().await;
    let ids = inventory["defaultSelectedAssetIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap().to_owned())
        .collect();
    let created: serde_json::Value = server.create(ids).await.json().await.unwrap();
    let token = created["token"].as_str().unwrap().to_owned();
    let auth = AuthUser::from(&server.fixture.state.users.read().await.users[0]);
    let key = invitation_key(&server.fixture.state, &share_digest_string(&token));
    let (cancel, mut cancelled) = tokio::sync::watch::channel(false);
    INVITATION_GATE.lock().await.insert(
        key.clone(),
        vec![ActiveSender {
            cancel,
            broker: crate::share_broker::BrokerClient::local("http://127.0.0.1:9/").unwrap(),
            owner_secret: "local-test-only".into(),
            room: "cancel_room______".into(),
            expires_at: share_now().unwrap() as u64 + 60,
            reservation_id: "r".repeat(43),
        }],
    );
    let entered = Arc::new(tokio::sync::Notify::new());
    let notified = entered.clone();
    let (release, held) = std::sync::mpsc::channel();
    let database = server.fixture.state.database.clone();
    let blocker = tokio::spawn(async move {
        database
            .call(move |_| {
                notified.notify_one();
                held.recv().unwrap();
                Ok(())
            })
            .await
    });
    entered.notified().await;
    let state = server.fixture.state.clone();
    let revoke_token = token.clone();
    let waiter = tokio::spawn(async move {
        revoke_share(State(state), Extension(auth), Path(revoke_token)).await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if INVITATION_GATE.try_lock().is_err() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    waiter.abort();
    let _ = waiter.await;
    release.send(()).unwrap();
    blocker.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(5), cancelled.changed())
        .await
        .unwrap()
        .unwrap();
    assert!(*cancelled.borrow());
    let preview = server
        .client
        .get(format!("{}/api/shares/{token}/preview", server.base))
        .send()
        .await
        .unwrap();
    assert_eq!(preview.status(), StatusCode::NOT_FOUND);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if !INVITATION_GATE.lock().await.contains_key(&key) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn selected_metadata_indexes_only_selected_audio_and_public_book_fields() {
    let fixture = TestServer::start(1).await;
    let mut book = fixture.state.library.read().await.books[0].clone();
    book.author = Some("Author".into());
    book.narrator = Some("Narrator".into());
    book.metadata.publisher = Some("Publisher".into());
    book.metadata.series = Some("Series".into());
    book.metadata.language = Some("en".into());
    book.metadata.raw_fields.push(MetadataField {
        key: "private-source".into(),
        value: "/private/owner/library".into(),
        description: None,
    });
    book.tracks[0].title = "UNSELECTED TRACK".into();
    let id = book.tracks[1].id.clone();
    book.tracks[1].title = "Selected track".into();
    let selected = crate::share_metadata::selected(&book, &[id]).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&selected).unwrap();
    assert_eq!(value["version"], 1);
    assert_eq!(value["narrator"], "Narrator");
    assert_eq!(value["metadata"]["publisher"], "Publisher");
    assert_eq!(value["metadata"]["series"], "Series");
    assert_eq!(value["tracks"].as_array().unwrap().len(), 1);
    assert_eq!(value["tracks"][0]["index"], 0);
    assert_eq!(value["tracks"][0]["title"], "Selected track");
    let json = String::from_utf8(selected).unwrap();
    for private in [
        "UNSELECTED TRACK",
        "/private/owner/library",
        "streamUrl",
        "rawFields",
        "sharedProgress",
        "volumeGain",
        &book.tracks[1].id,
    ] {
        assert!(!json.contains(private), "private field leaked: {private}");
    }
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(
            &crate::share_metadata::selected(&book, &[]).unwrap()
        )
        .unwrap()["tracks"],
        serde_json::json!([])
    );
    if let Some(path) = std::env::var_os("OPERALIBRE_GIFT_METADATA_FIXTURE") {
        std::fs::write(path, json).unwrap();
    }
}

#[tokio::test]
async fn selected_metadata_is_bounded_and_legacy_invitations_keep_exact_canonical_bytes() {
    let fixture = TestServer::start(1).await;
    let mut book = fixture.state.library.read().await.books[0].clone();
    let mut invitation = capacity_invitation("user", 200);
    assert_eq!(
        invitation_metadata(&book, &invitation, None).unwrap(),
        canonical_share_metadata(&book).unwrap()
    );
    invitation.metadata_version = 99;
    assert!(invitation_metadata(&book, &invitation, None).is_err());
    book.tags = (0..65)
        .map(|index| BookTag {
            name: index.to_string(),
            position: None,
        })
        .collect();
    assert!(crate::share_metadata::selected(&book, &[]).is_err());
    book.tags.clear();
    let track = book.tracks[0].id.clone();
    book.tracks[0].duration_seconds = Some(f64::NAN);
    assert!(crate::share_metadata::selected(&book, &[track]).is_err());
    assert!(
        crate::share_metadata::selected(&book, &[]).is_ok(),
        "unselected audio cannot block an ebook-only gift"
    );
}

#[tokio::test]
async fn selected_share_preview_accepts_one_thousand_unicode_code_points() {
    let fixture = TestServer::start(1).await;
    let book = fixture.state.library.read().await.books[0].clone();
    let receipt = VerifiedArchive {
        assets: vec![VerifiedArchiveAsset {
            name: "book.epub".into(),
            kind: ShareAssetKind::Ebook,
            size: 1,
            sha256: "a".repeat(64),
        }],
        size: 1,
        sha256: "b".repeat(64),
    };
    let valid = "🎁".repeat(1000);
    assert!(
        crate::share_preview_crypto::preview_from_archive(
            &book,
            "Sender",
            Some(&valid),
            "gift____________",
            "room____________",
            200,
            &receipt
        )
        .is_ok()
    );
    let invalid = "🎁".repeat(1001);
    assert!(
        crate::share_preview_crypto::preview_from_archive(
            &book,
            "Sender",
            Some(&invalid),
            "gift____________",
            "room____________",
            200,
            &receipt
        )
        .is_err()
    );
}

#[test]
fn selected_share_metadata_rich_preview_omits_only_optional_cover() {
    let signing = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
    let key = [9; 32];
    let mut preview = serde_json::json!({
        "description": "m".repeat(30 * 1024),
        "cover": {"mimeType": "image/jpeg", "dataBase64": "a".repeat(44 * 1024), "width": 256, "height": 256}
    });
    assert!(crate::share_preview_crypto::encrypt_signed_preview(&preview, &signing, &key).is_err());
    omit_cover_if_preview_exceeds_payload_limit(&mut preview).unwrap();
    assert!(preview.get("cover").is_none());
    assert_eq!(preview["description"].as_str().unwrap().len(), 30 * 1024);
    assert!(crate::share_preview_crypto::encrypt_signed_preview(&preview, &signing, &key).is_ok());
    preview["description"] = serde_json::json!("m".repeat(65 * 1024));
    omit_cover_if_preview_exceeds_payload_limit(&mut preview).unwrap();
    assert!(crate::share_preview_crypto::encrypt_signed_preview(&preview, &signing, &key).is_err());
    let mut small = serde_json::json!({"title": "Small", "cover": {"dataBase64": "a"}});
    omit_cover_if_preview_exceeds_payload_limit(&mut small).unwrap();
    assert!(small.get("cover").is_some());
}

#[tokio::test]
async fn selected_share_cover_preview_uses_receipt_and_rewinds_archive() {
    let root = tempfile::tempdir().unwrap();
    let cover_path = root.path().join("cover.png");
    image::RgbImage::from_pixel(4, 2, image::Rgb([12, 34, 56]))
        .save(&cover_path)
        .unwrap();
    let archive_path = root.path().join("selected.zip");
    std::fs::File::create(&archive_path).unwrap();
    let receipt = write_verified_archive(
        &archive_path,
        &[PlannedShareFile {
            id: "cover".into(),
            kind: ShareAssetKind::Cover,
            archive_name: "cover.png".into(),
            size_bytes: std::fs::metadata(&cover_path).unwrap().len(),
            path: cover_path,
        }],
        &[],
        root.path(),
        1024 * 1024,
    )
    .unwrap();
    let mut archive = fs::File::open(&archive_path).await.unwrap();
    let preview = selected_archive_cover_preview(&mut archive, &receipt)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((preview.width, preview.height), (4, 2));
    assert_eq!(preview.mime_type, "image/jpeg");
    let mut sent_bytes = Vec::new();
    archive.read_to_end(&mut sent_bytes).await.unwrap();
    assert_eq!(sent_bytes, std::fs::read(&archive_path).unwrap());
    let mut forged_receipt = receipt.clone();
    forged_receipt.assets[0].sha256 = "0".repeat(64);
    assert_eq!(
        selected_archive_cover_preview(&mut archive, &forged_receipt)
            .await
            .unwrap_err()
            .status,
        StatusCode::CONFLICT
    );
    assert_eq!(archive.stream_position().await.unwrap(), 0);
}

#[tokio::test]
async fn selected_share_no_cover_skips_archive_reads() {
    let mut archive = fs::File::from_std(tempfile::tempfile().unwrap());
    archive.write_all(b"not a ZIP archive").await.unwrap();
    let receipt = VerifiedArchive {
        assets: Vec::new(),
        size: 17,
        sha256: "0".repeat(64),
    };
    assert!(
        selected_archive_cover_preview(&mut archive, &receipt)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(archive.stream_position().await.unwrap(), 17);
}

fn capacity_invitation(user: &str, expires_at: i64) -> ShareInvitation {
    ShareInvitation {
        token_digest: "capacity-fixture".into(),
        sender_user_id: user.into(),
        created_at: 1,
        expires_at,
        revoked: false,
        selected_asset_ids: Vec::new(),
        include_metadata: true,
        trusted_selection: true,
        metadata_version: 0,
        broker_rooms: Vec::new(),
        manifest: ShareManifest {
            version: 1,
            book_id: "capacity-book".into(),
            title: "Capacity fixture".into(),
            author: None,
            description: None,
            sender_display_name: "Sender".into(),
            personal_message: None,
            assets: Vec::new(),
            total_bytes: 0,
        },
    }
}

#[test]
fn selected_share_capacity_limits_users_and_global_retained_records() {
    let mut invitations =
        vec![capacity_invitation("sender", 200); SHARE_MAX_INVITATIONS_PER_USER - 1];
    assert!(ensure_invitation_capacity(&invitations, "sender").is_ok());
    invitations.push(capacity_invitation("sender", 200));
    assert_eq!(
        ensure_invitation_capacity(&invitations, "sender")
            .unwrap_err()
            .status,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert!(ensure_invitation_capacity(&invitations, "another-sender").is_ok());
    let mut global = (0..SHARE_MAX_INVITATIONS - 1)
        .map(|index| capacity_invitation(&format!("sender-{index}"), 200))
        .collect::<Vec<_>>();
    assert!(ensure_invitation_capacity(&global, "new-sender").is_ok());
    global.push(capacity_invitation("last-sender", 200));
    assert_eq!(
        ensure_invitation_capacity(&global, "new-sender")
            .unwrap_err()
            .status,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[test]
fn selected_share_capacity_purges_finished_but_retains_expired_cleanup_rooms() {
    let mut expired = capacity_invitation("sender", 50);
    expired.broker_rooms.push(PendingBrokerRoom {
        origin: "https://broker.example".into(),
        room: "pending-room".into(),
        expires_at: 50,
        reservation_version: 1,
        cleanup_pending: true,
        last_cleanup_attempt: 0,
    });
    expired.revoked = true;
    let mut revoked = capacity_invitation("sender", 200);
    revoked.revoked = true;
    let mut invitations = vec![
        expired.clone(),
        capacity_invitation("sender", 50),
        revoked,
        capacity_invitation("sender", 200),
    ];
    purge_finished_invitations(&mut invitations, 100);
    assert_eq!(invitations.len(), 2);
    assert!(invitations[0].revoked && !invitations[0].broker_rooms.is_empty());
    let mut at_limit = vec![expired; SHARE_MAX_INVITATIONS_PER_USER];
    purge_finished_invitations(&mut at_limit, 100);
    assert_eq!(
        ensure_invitation_capacity(&at_limit, "sender")
            .unwrap_err()
            .status,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn selected_share_preparation_keeps_capacity_after_http_waiter_is_cancelled() {
    let slots = Arc::new(Semaphore::new(1));
    let permit = slots.clone().try_acquire_owned().unwrap();
    let (entered, waiting) = tokio::sync::oneshot::channel();
    let (release, blocked) = std::sync::mpsc::channel();
    let waiter = tokio::spawn(blocking_share_preparation(permit, move || {
        entered.send(()).unwrap();
        blocked.recv().unwrap();
    }));
    waiting.await.unwrap();
    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());
    assert_eq!(slots.available_permits(), 0);
    assert!(slots.clone().try_acquire_owned().is_err());
    release.send(()).unwrap();
    let released = tokio::time::timeout(Duration::from_secs(5), slots.acquire())
        .await
        .unwrap()
        .unwrap();
    drop(released);
    assert_eq!(slots.available_permits(), 1);
}

#[tokio::test]
async fn selected_and_legacy_capacity_fail_before_inventory_or_hashing() {
    let fixture = TestServer::start(0).await;
    let auth = AuthUser {
        id: "sender".into(),
        username: "Sender".into(),
        is_admin: false,
        is_owner: false,
        can_approve_libation_requests: false,
        allowed_book_ids: None,
        libation_access: LibationAccess::default(),
        share_progress: false,
        announce_finishes: false,
        notify_finishes: false,
        avatar: None,
    };
    let now = share_now().unwrap();
    write_invitations(
        &fixture.state.database,
        vec![capacity_invitation("sender", now + 300); SHARE_MAX_INVITATIONS_PER_USER],
    )
    .await
    .unwrap();
    let result = create_selected_share_for_user(
        &fixture.state,
        &auth,
        CreateSelectedShareRequest {
            book_id: "not-in-library".into(),
            selected_asset_ids: vec!["asset".into()],
            personal_message: None,
            expires_in_seconds: None,
        },
    )
    .await;
    assert_eq!(result.unwrap_err().status, StatusCode::TOO_MANY_REQUESTS);
    let result = create_share(
        State(fixture.state.clone()),
        Extension(auth),
        Json(CreateShareRequest {
            manifest: capacity_invitation("sender", now + 300).manifest,
            expires_in_seconds: None,
        }),
    )
    .await;
    assert_eq!(result.unwrap_err().status, StatusCode::TOO_MANY_REQUESTS);
}

/// A booted server with a temporary data directory and a fixture library.
struct TestServer {
    router: Router,
    state: AppState,
    /// Where the scanned library lives, for tests that grow it mid-flight.
    library_root: PathBuf,
    /// Held so the temporary directory outlives the server.
    _root: tempfile::TempDir,
}

/// Minimal valid WAV the library scanner can read a duration from.
fn fixture_wav() -> Vec<u8> {
    silent_wav(10)
}

fn silent_wav(seconds: usize) -> Vec<u8> {
    // 16_000 bytes per second at this format.
    let samples = vec![0u8; 16_000 * seconds];
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
            // Disposable byte-sized fixtures should not require the owner's
            // production disk reserve on a shared build volume.
            min_download_free_bytes: 0,
            server_id: Arc::from(load_or_create_server_id(&data_dir).await.unwrap()),
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
            sync_schedule_lock: Arc::new(Mutex::new(())),
            sync_report_backfill: Arc::default(),
            covers_dir: data_dir.join("covers"),
            database: database.clone(),
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
            agent_tokens: Arc::new(AgentTokens::new(
                database.clone(),
                StoreShape::Document(AGENT_TOKENS_DOCUMENT),
                AgentTokenStore::default(),
            )),
            libation_login_sessions: Arc::new(Mutex::new(std::collections::HashMap::new())),
            libation_status_accounts: Arc::new(RwLock::new(Vec::new())),
            libation_account_registration_lock: Arc::new(Mutex::new(())),
            rescan_lock: Arc::new(Mutex::new(())),
            libation_job_lock: Arc::new(Mutex::new(())),
            libation_refresh_reservation_lock: Arc::new(Mutex::new(())),
            faststart_lock: Arc::new(Mutex::new(())),
            login_attempts: Arc::new(Mutex::new(std::collections::HashMap::new())),
            credential_issuance_lock: Arc::new(Mutex::new(())),
            password_request_slots: Arc::new(Semaphore::new(PASSWORD_REQUEST_CAPACITY)),
            password_task_slots: Arc::new(Semaphore::new(PASSWORD_TASK_CONCURRENCY)),
            download_task_slots: Arc::new(Semaphore::new(DEFAULT_MAX_CONCURRENT_BOOK_DOWNLOADS)),
            catalogue_slots: Arc::new(Semaphore::new(CATALOGUE_CONCURRENCY)),
            catalogue_account_slots: Arc::new(Mutex::new(HashMap::new())),
            epub_entry_slots: Arc::new(Semaphore::new(EPUB_ENTRY_CONCURRENCY)),
            epub_entry_account_slots: Arc::new(Mutex::new(std::collections::HashMap::new())),
            upload_lock: Arc::new(Mutex::new(())),
            libro: Arc::new(LibroImports::default()),
            backup_lock: Arc::new(Mutex::new(BackupLifecycle::default())),
        };

        rescan_library(&state).await.unwrap();

        let library_root = state.library_root.clone();
        Self {
            router: build_router(state.clone(), None, &[]).unwrap(),
            state,
            library_root,
            _root: root,
        }
    }
}

struct SelectionHttp {
    fixture: TestServer,
    client: reqwest::Client,
    base: String,
    token: String,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
    book_id: String,
}

impl Drop for SelectionHttp {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl SelectionHttp {
    async fn start() -> Self {
        let fixture = TestServer::start(2).await;
        let book_id = fixture.state.library.read().await.books[0].id.clone();
        let ebook_path = fixture.library_root.join("selected.epub");
        std::fs::write(&ebook_path, b"trusted ebook fixture").unwrap();
        std::fs::create_dir_all(&fixture.state.covers_dir).unwrap();
        let cover_path = fixture.state.covers_dir.join("selected-cover.png");
        std::fs::write(&cover_path, b"trusted cover fixture").unwrap();
        {
            let mut library = fixture.state.library.write().await;
            let book = library
                .books
                .iter_mut()
                .find(|book| book.id == book_id)
                .unwrap();
            book.title = "Trusted title".into();
            book.author = Some("Trusted author".into());
            book.reading_file = Some(ReadingFile {
                id: "ebook-selected".into(),
                file_name: "selected.epub".into(),
                extension: "epub".into(),
                content_type: "application/epub+zip".into(),
                url: "/private-local-file".into(),
            });
            library
                .reading_paths
                .insert("ebook-selected".into(), ebook_path);
            library.cover_art.insert(
                book_id.clone(),
                CachedCover {
                    mime_type: "image/png".into(),
                    etag: "fixture".into(),
                    path: cover_path,
                    len: 21,
                },
            );
        }
        // Exercise the authoritative request handler separately from owner's
        // configured-broker wrapper, using the real authentication middleware.
        let selected = Router::new()
            .route("/selection/shares", post(create_selected_share))
            .layer(middleware::from_fn_with_state(
                fixture.state.clone(),
                auth_middleware,
            ))
            .with_state(fixture.state.clone());
        let router = fixture.router.clone().merge(selected);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
        });
        let client = crate::http_client_builder().build().unwrap();
        let setup = client.post(format!("{base}/api/auth/setup")).json(&serde_json::json!({"username":"Trusted Sender", "password":"selection-test-password"})).send().await.unwrap();
        assert_eq!(setup.status(), StatusCode::OK);
        let token = setup.json::<serde_json::Value>().await.unwrap()["token"]
            .as_str()
            .unwrap()
            .to_owned();
        Self {
            fixture,
            client,
            base,
            token,
            task,
            book_id,
        }
    }
    async fn inventory(&self) -> serde_json::Value {
        let response = self
            .client
            .get(format!(
                "{}/api/books/{}/gift-inventory",
                self.base, self.book_id
            ))
            .bearer_auth(&self.token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        response.json().await.unwrap()
    }
    async fn create(&self, ids: Vec<String>) -> reqwest::Response {
        self.client.post(format!("{}/selection/shares", self.base)).bearer_auth(&self.token).json(&serde_json::json!({"bookId":self.book_id,"selectedAssetIds":ids,"personalMessage":"A private note", "expiresInSeconds":120})).send().await.unwrap()
    }
}

#[tokio::test]
async fn selected_share_inventory_defaults_and_real_archive_exclude_audio() {
    let server = SelectionHttp::start().await;
    let inventory = server.inventory().await;
    if let Some(path) = std::env::var_os("OPERALIBRE_GIFT_HTTP_INVENTORY_FIXTURE") {
        // Opt-in bridge for the UI parser test: export the actual HTTP response,
        // never a separately manufactured cross-language contract fixture.
        std::fs::write(path, serde_json::to_vec(&inventory).unwrap()).unwrap();
    }
    assert_eq!(inventory["title"], "Trusted title");
    assert_eq!(
        inventory["maxBytes"],
        selected_share_max_bytes(&server.fixture.state)
    );
    for asset in inventory["assets"].as_array().unwrap() {
        assert!(
            asset["id"].is_string() && asset["kind"].is_string() && asset["fileName"].is_string()
        );
        assert!(asset["sizeBytes"].is_u64() && asset["available"].is_boolean());
        assert!(asset["requiresAssetIds"].is_array());
        assert!(asset["disabledReason"].is_null() || asset["disabledReason"].is_string());
    }
    let ids = inventory["defaultSelectedAssetIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(ids.len(), 3);
    assert!(
        inventory["assets"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|asset| asset["kind"] == "audio")
            .all(|asset| asset["defaultSelected"] == false)
    );
    assert!(
        !inventory
            .to_string()
            .contains(&server.fixture.library_root.display().to_string())
    );
    let response = server.create(ids).await;
    assert_eq!(response.status(), StatusCode::OK);
    let created: serde_json::Value = response.json().await.unwrap();
    assert_eq!(created["preview"]["title"], "Trusted title");
    assert_eq!(created["preview"]["senderDisplayName"], "Trusted Sender");
    let token = created["token"].as_str().unwrap();
    let download = server
        .client
        .get(format!("{}/api/shares/{token}/download", server.base))
        .send()
        .await
        .unwrap();
    assert_eq!(download.status(), StatusCode::OK);
    let mut archive =
        zip::ZipArchive::new(std::io::Cursor::new(download.bytes().await.unwrap())).unwrap();
    assert_eq!(archive.len(), 3);
    assert!(archive.by_name("selected.epub").is_ok());
    assert!(archive.by_name("cover.png").is_ok());
    let mut metadata = String::new();
    archive
        .by_name("metadata.json")
        .unwrap()
        .read_to_string(&mut metadata)
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&metadata).unwrap()["title"],
        "Trusted title"
    );
    assert!((0..archive.len()).all(|index| {
        !archive
            .by_index(index)
            .unwrap()
            .name()
            .unwrap()
            .ends_with(".wav")
    }));
    let metadata_asset = created["preview"]["assets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|asset| asset["kind"] == "metadata")
        .unwrap();
    assert_eq!(
        metadata_asset["sha256"],
        hex_digest(Sha256::digest(metadata.as_bytes()))
    );
}

#[tokio::test]
async fn selected_metadata_http_archive_preserves_selected_track_order_and_omits_other_audio() {
    let server = SelectionHttp::start().await;
    let (selected_id, selected_name, excluded_name) = {
        let mut library = server.fixture.state.library.write().await;
        let book = library
            .books
            .iter_mut()
            .find(|book| book.id == server.book_id)
            .unwrap();
        book.narrator = Some("Shared narrator".into());
        book.metadata.publisher = Some("Shared publisher".into());
        book.metadata.raw_fields.push(MetadataField {
            key: "not-for-sharing".into(),
            value: "PRIVATE RAW FIELD".into(),
            description: None,
        });
        (
            book.tracks[1].id.clone(),
            book.tracks[1].file_name.clone(),
            book.tracks[0].file_name.clone(),
        )
    };
    let created = server
        .create(vec![
            format!("metadata:{}", server.book_id),
            "ebook-selected".into(),
            selected_id,
        ])
        .await;
    assert_eq!(created.status(), StatusCode::OK);
    let created: serde_json::Value = created.json().await.unwrap();
    let token = created["token"].as_str().unwrap();
    let response = server
        .client
        .get(format!("{}/api/shares/{token}/download", server.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.bytes().await.unwrap();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
    assert_eq!(zip.len(), 3);
    assert!(zip.by_name(&selected_name).is_ok());
    assert!(zip.by_name(&excluded_name).is_err());
    let mut metadata = String::new();
    zip.by_name("metadata.json")
        .unwrap()
        .read_to_string(&mut metadata)
        .unwrap();
    let descriptor: serde_json::Value = serde_json::from_str(&metadata).unwrap();
    assert_eq!(descriptor["version"], 1);
    assert_eq!(descriptor["narrator"], "Shared narrator");
    assert_eq!(descriptor["metadata"]["publisher"], "Shared publisher");
    assert_eq!(descriptor["tracks"].as_array().unwrap().len(), 1);
    assert_eq!(descriptor["tracks"][0]["fileName"], selected_name);
    assert_eq!(descriptor["tracks"][0]["index"], 0);
    assert!(!metadata.contains("PRIVATE RAW FIELD"));
    assert!(!metadata.contains(&excluded_name));
    if let Some(path) = std::env::var_os("OPERALIBRE_GIFT_NATIVE_ARCHIVE_FIXTURE") {
        let assets = created["preview"]["assets"].as_array().unwrap().iter().map(|asset| serde_json::json!({"name":asset["fileName"],"kind":asset["kind"],"size":asset["sizeBytes"],"sha256":asset["sha256"]})).collect::<Vec<_>>();
        std::fs::write(path, serde_json::to_vec(&serde_json::json!({"archiveBase64":general_purpose::STANDARD.encode(bytes),"assets":assets,"metadata":descriptor})).unwrap()).unwrap();
    }
}

#[tokio::test]
async fn selected_alignment_http_requires_matching_complete_audio_and_verifies_actual_archive() {
    let server = SelectionHttp::start().await;
    let epub = gift_reader_epub();
    let reading_path =
        server.fixture.state.library.read().await.reading_paths["ebook-selected"].clone();
    std::fs::write(&reading_path, &epub).unwrap();
    std::fs::create_dir_all(&server.fixture.state.sync_dir).unwrap();
    let map_path = server.fixture.state.sync_dir.join("served.sync.json");
    let map = serde_json::json!({"version":2,"mappingRevision":alignment::MAPPING_REVISION,"precision":"sentence","fragments":[
        {"startSeconds":1.0,"endSeconds":2.0,"href":"text/ch1.xhtml","text":"The meadow was quiet."},
        {"startSeconds":11.0,"endSeconds":12.0,"href":"text/ch2.xhtml","text":"The river ran fast & cold."}
    ]});
    std::fs::write(&map_path, serde_json::to_vec(&map).unwrap()).unwrap();
    let audio_ids = {
        let mut library = server.fixture.state.library.write().await;
        let book = library
            .books
            .iter_mut()
            .find(|book| book.id == server.book_id)
            .unwrap();
        let reading = book.reading_file.as_ref().unwrap();
        book.companions = vec![crate::companions::CompanionFile {
            id: reading.id.clone(),
            file_name: reading.file_name.clone(),
            extension: "epub".into(),
            content_type: reading.content_type.clone(),
            url: reading.url.clone(),
            kind: crate::companions::CompanionKind::Book,
            size_bytes: epub.len() as u64,
            page_count: None,
            image_count: None,
            text_characters: Some(5000),
            unreadable: false,
        }];
        book.sync_file = Some(SyncFile {
            outdated: false,
            file_name: "served.sync.json".into(),
            source: "generated".into(),
            url: "/private/server/sync".into(),
            quality: None,
            report_current: false,
        });
        let ids = book
            .tracks
            .iter()
            .map(|track| track.id.clone())
            .collect::<Vec<_>>();
        library
            .sync_paths
            .insert(server.book_id.clone(), map_path.clone());
        ids
    };
    let inventory = server.inventory().await;
    let sync_id = format!("sync:{}", server.book_id);
    let alignment_asset = inventory["assets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|asset| asset["id"] == sync_id)
        .unwrap();
    assert_eq!(alignment_asset["available"], true, "{alignment_asset}");
    let mut selected = vec![
        format!("metadata:{}", server.book_id),
        "ebook-selected".into(),
        sync_id,
    ];
    selected.push(audio_ids[0].clone());
    assert_eq!(
        server.create(selected.clone()).await.status(),
        StatusCode::BAD_REQUEST
    );
    selected.push(audio_ids[1].clone());
    let created = server.create(selected).await;
    assert_eq!(created.status(), StatusCode::OK);
    let created: serde_json::Value = created.json().await.unwrap();
    let token = created["token"].as_str().unwrap();
    let response = server
        .client
        .get(format!("{}/api/shares/{token}/download", server.base))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.bytes().await.unwrap();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
    assert_eq!(zip.len(), 5);
    assert!(zip.by_name("cover.png").is_err());
    let mut metadata = String::new();
    zip.by_name("metadata.json")
        .unwrap()
        .read_to_string(&mut metadata)
        .unwrap();
    let metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap();
    assert_eq!(metadata["alignment"]["assetName"], "alignment.sync.json");
    assert_eq!(metadata["tracks"].as_array().unwrap().len(), 2);
    assert_eq!(
        metadata["alignment"]["audioAssetNames"][0],
        metadata["tracks"][0]["fileName"]
    );
    if let Some(path) = std::env::var_os("OPERALIBRE_GIFT_ALIGNMENT_ARCHIVE_FIXTURE") {
        let assets = created["preview"]["assets"].as_array().unwrap().iter().map(|asset| serde_json::json!({"name":asset["fileName"],"kind":asset["kind"],"size":asset["sizeBytes"],"sha256":asset["sha256"]})).collect::<Vec<_>>();
        let mut entries = Vec::new();
        for index in 0..zip.len() {
            let mut file = zip.by_index(index).unwrap();
            let name = file.name().unwrap().to_string();
            let mut contents = Vec::new();
            file.read_to_end(&mut contents).unwrap();
            entries.push(serde_json::json!({"name":name,"dataBase64":general_purpose::STANDARD.encode(contents)}));
        }
        std::fs::write(path,serde_json::to_vec(&serde_json::json!({"archiveBase64":general_purpose::STANDARD.encode(&bytes),"assets":assets,"metadata":metadata,"entries":entries})).unwrap()).unwrap();
    }
    // A same-length substitution is still rejected by the persisted receipt.
    let original = std::fs::read(&map_path).unwrap();
    let mut changed = original.clone();
    let index = changed.iter().position(|byte| *byte == b'm').unwrap();
    changed[index] = b'x';
    std::fs::write(&map_path, changed).unwrap();
    assert_eq!(
        server
            .client
            .get(format!("{}/api/shares/{token}/download", server.base))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
}

/// The parser's intentionally minimal fixtures omit reader-required package
/// metadata. Use a real EPUB3 package here because this exact server archive
/// also goes through epub.js and sentence highlighting in the browser suite.
fn gift_reader_epub() -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let files = [
        ("mimetype", "application/epub+zip"),
        (
            "META-INF/container.xml",
            r#"<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#,
        ),
        (
            "OEBPS/content.opf",
            r#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="gift-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="gift-id">urn:uuid:gift-fixture</dc:identifier><dc:title>Gift fixture</dc:title><dc:language>en</dc:language></metadata><manifest><item id="one" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="two" href="text/ch2.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>"#,
        ),
        (
            "OEBPS/text/ch1.xhtml",
            r#"<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter one</title></head><body><p>The meadow was quiet. Bees drifted between flowers.</p></body></html>"#,
        ),
        (
            "OEBPS/text/ch2.xhtml",
            r#"<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter two</title></head><body><p>The river ran fast &amp; cold.</p></body></html>"#,
        ),
        (
            "OEBPS/nav.xhtml",
            r#"<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">One</a></li><li><a href="text/ch2.xhtml">Two</a></li></ol></nav></body></html>"#,
        ),
    ];
    for (name, contents) in files {
        writer.start_file(name, options).unwrap();
        writer.write_all(contents.as_bytes()).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

#[tokio::test]
async fn selected_share_rejects_unknown_duplicate_unsupported_and_client_metadata() {
    let server = SelectionHttp::start().await;
    for ids in [
        vec!["not-an-asset".into()],
        vec!["ebook-selected".into(), "ebook-selected".into()],
        vec![format!("metadata:{}", server.book_id)],
    ] {
        assert_eq!(server.create(ids).await.status(), StatusCode::BAD_REQUEST);
    }
    for extra in [
        "manifest",
        "path",
        "sha256",
        "senderDisplayName",
        "allowedBookIds",
    ] {
        let mut input =
            serde_json::json!({"bookId":server.book_id,"selectedAssetIds":["ebook-selected"]});
        input[extra] = "forged".into();
        let response = server
            .client
            .post(format!("{}/selection/shares", server.base))
            .bearer_auth(&server.token)
            .json(&input)
            .send()
            .await
            .unwrap();
        assert!(response.status().is_client_error(), "accepted {extra}");
    }
    {
        let mut library = server.fixture.state.library.write().await;
        let book = library
            .books
            .iter_mut()
            .find(|book| book.id == server.book_id)
            .unwrap();
        book.sync_file = Some(SyncFile {
            outdated: false,
            file_name: "alignment.sync.json".into(),
            source: "sidecar".into(),
            url: "/sync".into(),
            quality: None,
            report_current: false,
        });
    }
    let inventory = server.inventory().await;
    let alignment = inventory["assets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|asset| asset["kind"] == "alignment")
        .unwrap();
    assert_eq!(alignment["available"], false);
    assert_eq!(alignment["requiresAssetIds"].as_array().unwrap().len(), 3);
    assert!(alignment["unsupportedReason"].is_string());
    let mut ids = vec!["ebook-selected".into(), format!("sync:{}", server.book_id)];
    ids.extend(
        inventory["assets"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|asset| asset["kind"] == "audio")
            .map(|asset| asset["id"].as_str().unwrap().to_owned()),
    );
    assert_eq!(server.create(ids).await.status(), StatusCode::BAD_REQUEST);
    let response = server.client.post(format!("{}/selection/shares",server.base)).bearer_auth(&server.token).json(&serde_json::json!({"bookId":server.book_id,"selectedAssetIds":["ebook-selected"],"personalMessage":"🎁".repeat(1001)})).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn selected_share_http_denies_restricted_book_and_missing_auth() {
    let server = SelectionHttp::start().await;
    let created = server.client.post(format!("{}/api/users",server.base)).bearer_auth(&server.token).json(&serde_json::json!({"username":"restricted","password":"selection-reader-password","isAdmin":false,"allowedBookIds":[]})).send().await.unwrap();
    assert_eq!(created.status(), StatusCode::OK);
    let login = server
        .client
        .post(format!("{}/api/auth/login", server.base))
        .json(&serde_json::json!({"username":"restricted","password":"selection-reader-password"}))
        .send()
        .await
        .unwrap();
    assert_eq!(login.status(), StatusCode::OK);
    let reader = login.json::<serde_json::Value>().await.unwrap()["token"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        server
            .client
            .get(format!(
                "{}/api/books/{}/gift-inventory",
                server.base, server.book_id
            ))
            .bearer_auth(&reader)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        server
            .client
            .post(format!("{}/selection/shares", server.base))
            .bearer_auth(reader)
            .json(
                &serde_json::json!({"bookId":server.book_id,"selectedAssetIds":["ebook-selected"]})
            )
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        server
            .client
            .get(format!(
                "{}/api/books/{}/gift-inventory",
                server.base, server.book_id
            ))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn selected_share_hashes_real_bytes_and_rejects_later_same_size_changes() {
    let server = SelectionHttp::start().await;
    let response = server.create(vec!["ebook-selected".into()]).await;
    assert_eq!(response.status(), StatusCode::OK);
    let created: serde_json::Value = response.json().await.unwrap();
    let assets = created["preview"]["assets"].as_array().unwrap();
    assert_eq!(
        assets.len(),
        2,
        "metadata is mandatory even when omitted by the caller"
    );
    let ebook = assets
        .iter()
        .find(|asset| asset["kind"] == "ebook")
        .unwrap();
    assert_eq!(
        ebook["sha256"],
        hex_digest(Sha256::digest(b"trusted ebook fixture"))
    );
    std::fs::write(
        server.fixture.library_root.join("selected.epub"),
        b"changed ebook fixture",
    )
    .unwrap();
    let token = created["token"].as_str().unwrap();
    assert_eq!(
        server
            .client
            .get(format!("{}/api/shares/{token}/download", server.base))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
}

#[cfg(unix)]
#[tokio::test]
async fn selected_share_does_not_require_unselected_audio_or_follow_ebook_symlinks() {
    let server = SelectionHttp::start().await;
    let audio_path = {
        let library = server.fixture.state.library.read().await;
        let book = library.book(&server.book_id).unwrap();
        library.track_paths[&book.tracks[0].id].clone()
    };
    std::fs::remove_file(audio_path).unwrap();
    let created = server.create(vec!["ebook-selected".into()]).await;
    assert_eq!(created.status(), StatusCode::OK);
    let created: serde_json::Value = created.json().await.unwrap();
    assert_eq!(
        server
            .client
            .get(format!(
                "{}/api/shares/{}/download",
                server.base,
                created["token"].as_str().unwrap()
            ))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let ebook = server.fixture.library_root.join("selected.epub");
    std::fs::remove_file(&ebook).unwrap();
    let private = server.fixture._root.path().join("outside-private.epub");
    std::fs::write(&private, b"must not be shared").unwrap();
    std::os::unix::fs::symlink(private, ebook).unwrap();
    let inventory = server.inventory().await;
    let ebook = inventory["assets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|asset| asset["id"] == "ebook-selected")
        .unwrap();
    assert_eq!(ebook["available"], false);
    assert!(ebook["unavailableReason"].is_string());
    assert_eq!(
        server.create(vec!["ebook-selected".into()]).await.status(),
        StatusCode::BAD_REQUEST
    );
}
