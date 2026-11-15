use super::*;
use axum::{
    Json, Router,
    extract::{Path as RoutePath, State},
    routing::post,
};
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;

fn record(now: u64, bytes: &[u8]) -> PersistedSender {
    PersistedSender {
        server_id: "server-test".into(),
        invitation_digest: "invitation_digest_1234567890".into(),
        sender_user_id: "sender".into(),
        book_id: "book".into(),
        broker_origin: "https://broker.example".into(),
        room: "room_12345678901234567890".into(),
        gift_id: "gift_12345678901234567890".into(),
        expires_at: now + 300,
        archive_size: bytes.len() as u64,
        archive_sha256: digest(bytes),
        signing_seed: [7; 32],
        preview_key: [9; 32],
        producer: None,
        pending_producer: None,
        cleanup_only: false,
    }
}
fn authority(record: &PersistedSender) -> RecoveryAuthority<'_> {
    RecoveryAuthority {
        invitation_digest: &record.invitation_digest,
        sender_user_id: &record.sender_user_id,
        book_id: &record.book_id,
        room: &record.room,
        broker_origin: &record.broker_origin,
        invitation_expires_at: record.expires_at,
        revoked: false,
        access_allowed: true,
    }
}
fn opened(bytes: &[u8]) -> std::fs::File {
    let mut file = tempfile::tempfile().unwrap();
    file.write_all(bytes).unwrap();
    file
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

#[tokio::test]
async fn restart_reopens_exact_archive_and_original_cryptographic_identity() {
    let root = tempfile::tempdir().unwrap();
    let store = RecoveryStore::open(root.path(), "server-test", 1024 * 1024, 0).unwrap();
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, bytes) in [
        ("selected.epub", b"ebook fixture".as_slice()),
        ("metadata.json", br#"{"title":"Trusted title"}"#.as_slice()),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    let bytes = zip.finish().unwrap().into_inner();
    let record = record(now(), &bytes);
    let id = store
        .prepare(record.clone(), opened(&bytes), now())
        .await
        .unwrap();
    drop(store);
    let reopened = RecoveryStore::open(root.path(), "server-test", 1024 * 1024, 0).unwrap();
    let mut restored = reopened
        .restore(&id, &authority(&record), now())
        .await
        .unwrap();
    let mut received = Vec::new();
    restored.archive.read_to_end(&mut received).await.unwrap();
    assert_eq!(received, bytes);
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(received)).unwrap();
    assert_eq!(zip.len(), 2);
    assert!(zip.by_name("selected.epub").is_ok());
    assert!(zip.by_name("metadata.json").is_ok());
    assert_eq!(restored.authentication.preview_key, record.preview_key);
    assert_eq!(
        restored.authentication.signing.verifying_key(),
        ed25519_dalek::SigningKey::from_bytes(&record.signing_seed).verifying_key()
    );
    assert_eq!(restored.authentication.gift_id, record.gift_id);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(reopened.archive_path(&id).unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o077,
            0
        );
        assert_eq!(
            std::fs::metadata(root.path().join("gift-sender-recovery/index.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o077,
            0
        );
    }
}

#[tokio::test]
async fn restart_archive_lease_excludes_concurrent_sender_and_orphans_remain_charged() {
    let root = tempfile::tempdir().unwrap();
    let store = RecoveryStore::open(root.path(), "server-test", 16, 0).unwrap();
    let record = record(now(), b"snapshot");
    let id = store
        .prepare(record.clone(), opened(b"snapshot"), now())
        .await
        .unwrap();
    let restored = store
        .restore(&id, &authority(&record), now())
        .await
        .unwrap();
    assert!(
        store
            .restore(&id, &authority(&record), now())
            .await
            .is_err()
    );
    drop(restored);
    assert!(store.restore(&id, &authority(&record), now()).await.is_ok());
    let orphan = store.archive_path(&"a".repeat(64)).unwrap();
    std::fs::write(&orphan, b"orphan bytes").unwrap();
    let mut next = record;
    next.room = "another_room_1234567890".into();
    assert!(
        store
            .prepare(next.clone(), opened(b"snapshot"), now())
            .await
            .is_err()
    );
    assert_eq!(store.prune_orphans().await.unwrap(), 1);
    assert!(!orphan.exists());
    store
        .prepare(next, opened(b"snapshot"), now())
        .await
        .unwrap();
}

#[tokio::test]
async fn restart_rejects_revocation_expiry_access_changes_and_binding_changes() {
    let root = tempfile::tempdir().unwrap();
    let store = RecoveryStore::open(root.path(), "server-test", 1024 * 1024, 0).unwrap();
    let record = record(now(), b"snapshot");
    let id = store
        .prepare(record.clone(), opened(b"snapshot"), now())
        .await
        .unwrap();
    let mut auth = authority(&record);
    auth.revoked = true;
    assert!(store.restore(&id, &auth, now()).await.is_err());
    auth.revoked = false;
    auth.access_allowed = false;
    assert!(store.restore(&id, &auth, now()).await.is_err());
    auth.access_allowed = true;
    auth.book_id = "different-book";
    assert!(store.restore(&id, &auth, now()).await.is_err());
    auth.book_id = &record.book_id;
    auth.broker_origin = "https://different.example";
    assert!(store.restore(&id, &auth, now()).await.is_err());
    assert!(
        store
            .restore(&id, &authority(&record), record.expires_at)
            .await
            .is_err()
    );
    store.mark_cleanup(&id).await.unwrap();
    assert!(
        store
            .restore(&id, &authority(&record), now())
            .await
            .is_err()
    );
    store.remove(&id).await.unwrap();
    assert!(store.list().await.unwrap().is_empty());
    assert!(!store.archive_path(&id).unwrap().exists());
}

#[tokio::test]
async fn restart_rehashes_retained_bytes_and_rejects_same_size_tampering() {
    let root = tempfile::tempdir().unwrap();
    let store = RecoveryStore::open(root.path(), "server-test", 1024 * 1024, 0).unwrap();
    let record = record(now(), b"snapshot");
    let id = store
        .prepare(record.clone(), opened(b"snapshot"), now())
        .await
        .unwrap();
    std::fs::write(store.archive_path(&id).unwrap(), b"tampered").unwrap();
    assert!(
        store
            .restore(&id, &authority(&record), now())
            .await
            .is_err()
    );
    let wrong_server = RecoveryStore::open(root.path(), "other-server", 1024 * 1024, 0).unwrap();
    assert!(wrong_server.list().await.is_err());
}

#[tokio::test]
async fn retention_enforces_budget_and_never_publishes_mismatched_bytes() {
    let root = tempfile::tempdir().unwrap();
    let store = RecoveryStore::open(root.path(), "server-test", 8, 0).unwrap();
    let record = record(now(), b"snapshot");
    assert!(
        store
            .prepare(record.clone(), opened(b"tampered"), now())
            .await
            .is_err()
    );
    assert!(store.list().await.unwrap().is_empty());
    store
        .prepare(record.clone(), opened(b"snapshot"), now())
        .await
        .unwrap();
    let mut next = record;
    next.room = "another_room_1234567890".into();
    assert!(
        store
            .prepare(next, opened(b"snapshot"), now())
            .await
            .is_err()
    );
    assert_eq!(store.list().await.unwrap().len(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn restart_rejects_symlink_archives_and_unsafe_store_directory() {
    let root = tempfile::tempdir().unwrap();
    let store = RecoveryStore::open(root.path(), "server-test", 1024, 0).unwrap();
    let record = record(now(), b"snapshot");
    let id = store
        .prepare(record.clone(), opened(b"snapshot"), now())
        .await
        .unwrap();
    let private = root.path().join("private");
    std::fs::write(&private, b"snapshot").unwrap();
    std::fs::remove_file(store.archive_path(&id).unwrap()).unwrap();
    std::os::unix::fs::symlink(private, store.archive_path(&id).unwrap()).unwrap();
    assert!(
        store
            .restore(&id, &authority(&record), now())
            .await
            .is_err()
    );
    let another = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(root.path(), another.path().join("gift-sender-recovery")).unwrap();
    assert!(RecoveryStore::open(another.path(), "server-test", 1024, 0).is_err());
}

#[derive(Default)]
struct BrokerState {
    current: Option<Capability>,
    recipient: Option<Capability>,
    queues: [Vec<Value>; 2],
    generation: u64,
    claims: usize,
    rotations: usize,
    lose_rotation_response: bool,
    fail_sessions: bool,
    stale_signals: bool,
    used_nonces: std::collections::HashSet<String>,
    delayed_resume: Option<Arc<DelayedResume>>,
    resume_requests: usize,
    successors_issued: usize,
}

#[derive(Default)]
struct DelayedResume {
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
    applied: tokio::sync::Notify,
}

fn capability(payload: String) -> Capability {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, b"recovery-test-broker-key");
    let signature = ring::hmac::sign(&key, payload.as_bytes())
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Capability { payload, signature }
}
async fn issue(
    State(state): State<Arc<tokio::sync::Mutex<BrokerState>>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    if headers.get("authorization").and_then(|h| h.to_str().ok()) != Some("Bearer owner") {
        return axum::http::StatusCode::FORBIDDEN.into_response();
    }
    if body.get("previousNonce").is_some() {
        state.lock().await.successors_issued += 1;
    }
    Json(capability(body.to_string())).into_response()
}
async fn room_operation(
    State(state): State<Arc<tokio::sync::Mutex<BrokerState>>>,
    RoutePath((operation, room)): RoutePath<(String, String)>,
    Json(body): Json<Value>,
) -> axum::response::Response {
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    let state_handle = state.clone();
    let mut state = state.lock().await;
    let Some(payload) = body["payload"].as_str() else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let Ok(claim) = serde_json::from_str::<Value>(payload) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if claim["room"] != room
        || !matches!(claim["role"].as_str(), Some("producer" | "recipient"))
        || claim["expiresAt"]
            .as_u64()
            .is_none_or(|expiry| expiry <= now())
        || body["signature"] != capability(payload.into()).signature
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let role = usize::from(claim["role"] == "recipient");
    let matches = (if role == 0 {
        &state.current
    } else {
        &state.recipient
    })
    .as_ref()
    .is_some_and(|c| body["payload"] == c.payload && body["signature"] == c.signature);
    match operation.as_str() {
        "claim"
            if (if role == 0 {
                &state.current
            } else {
                &state.recipient
            })
            .is_none() =>
        {
            let member = Some(capability(body["payload"].as_str().unwrap().into()));
            if role == 0 {
                state.claims += 1;
                state.current = member;
            } else {
                state.recipient = member;
            }
            state
                .used_nonces
                .insert(claim["nonce"].as_str().unwrap().into());
            StatusCode::NO_CONTENT.into_response()
        }
        "session" if matches && !state.fail_sessions => {
            Json(json!({"generation":state.generation})).into_response()
        }
        "resume"
            if matches
                && role == 0
                && body["generation"] == state.generation
                && state.rotations < 16 =>
        {
            let current: Value =
                serde_json::from_str(&state.current.as_ref().unwrap().payload).unwrap();
            let next: Value = serde_json::from_str(body["nextPayload"].as_str().unwrap()).unwrap();
            if next["role"] != "producer"
                || next["room"] != current["room"]
                || next["previousNonce"] != current["nonce"]
                || next["expiresAt"] != current["expiresAt"]
                || body["nextSignature"]
                    != capability(body["nextPayload"].as_str().unwrap().into()).signature
                || state.used_nonces.contains(next["nonce"].as_str().unwrap())
            {
                return StatusCode::FORBIDDEN.into_response();
            }
            if let Some(delayed) = state.delayed_resume.clone() {
                state.resume_requests += 1;
                if state.resume_requests == 1 {
                    let next = capability(body["nextPayload"].as_str().unwrap().into());
                    let nonce = serde_json::from_str::<Value>(&next.payload).unwrap()["nonce"]
                        .as_str()
                        .unwrap()
                        .to_owned();
                    drop(state);
                    let remote = delayed.clone();
                    tokio::spawn(async move {
                        remote.release.notified().await;
                        let mut state = state_handle.lock().await;
                        state.current = Some(next);
                        state.generation += 1;
                        state.rotations += 1;
                        state.used_nonces.insert(nonce);
                        state.queues = [Vec::new(), Vec::new()];
                        remote.applied.notify_one();
                    });
                    delayed.entered.notify_one();
                    return std::future::pending().await;
                }
                if state.resume_requests == 2 {
                    drop(state);
                    delayed.release.notify_one();
                    delayed.applied.notified().await;
                    return StatusCode::FORBIDDEN.into_response();
                }
            }
            state.current = Some(capability(body["nextPayload"].as_str().unwrap().into()));
            state.generation += 1;
            state.rotations += 1;
            state
                .used_nonces
                .insert(next["nonce"].as_str().unwrap().into());
            state.stale_signals = false;
            state.queues = [Vec::new(), Vec::new()];
            if state.lose_rotation_response {
                state.fail_sessions = true;
                return StatusCode::BAD_GATEWAY.into_response();
            }
            (
                StatusCode::NO_CONTENT,
                [("x-signaling-generation", state.generation.to_string())],
            )
                .into_response()
        }
        "send" if matches && body["generation"].as_u64().unwrap_or(0) == state.generation => {
            let Some(sequence) = body["sequence"].as_u64().filter(|n| (1..=32).contains(n)) else {
                return StatusCode::BAD_REQUEST.into_response();
            };
            let Some(kind) = body["kind"].as_str() else {
                return StatusCode::BAD_REQUEST.into_response();
            };
            let Some(message) = body["message"].as_str().filter(|s| s.len() <= 7168) else {
                return StatusCode::BAD_REQUEST.into_response();
            };
            if !matches!(
                (role, sequence, kind),
                (0, 1, "offer") | (1, 1, "ready") | (1, 2, "answer")
            ) || sequence as usize != state.queues[role].len() + 1
            {
                return StatusCode::CONFLICT.into_response();
            }
            state.queues[role].push(json!({"sequence":sequence,"kind":kind,"message":message}));
            StatusCode::NO_CONTENT.into_response()
        }
        "poll" if matches && body["generation"].as_u64().unwrap_or(0) == state.generation => {
            let Some(after) = body["after"].as_u64().filter(|n| *n <= 32) else {
                return StatusCode::BAD_REQUEST.into_response();
            };
            Json(
                state.queues[1 - role]
                    .iter()
                    .filter(|signal| signal["sequence"].as_u64().unwrap() > after)
                    .cloned()
                    .collect::<Vec<_>>(),
            )
            .into_response()
        }
        _ => StatusCode::FORBIDDEN.into_response(),
    }
}

#[tokio::test]
async fn broker_restart_rejoins_without_reclaim_and_reconciles_lost_rotation_response() {
    let root = tempfile::tempdir().unwrap();
    let state = Arc::new(tokio::sync::Mutex::new(BrokerState::default()));
    let app = Router::new()
        .route("/issue", post(issue))
        .route("/{operation}/{room}", post(room_operation))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let broker = BrokerClient::local(&format!("http://{address}/")).unwrap();
    let mut record = record(now(), b"snapshot");
    record.broker_origin = format!("http://{address}");
    let store = RecoveryStore::open(root.path(), "server-test", 1024, 0).unwrap();
    let id = store
        .prepare(record.clone(), opened(b"snapshot"), now())
        .await
        .unwrap();
    let producer = broker
        .issue(
            "owner",
            &record.room,
            "producer_nonce_1234567890",
            record.expires_at,
        )
        .await
        .unwrap();
    store.set_producer(&id, producer).await.unwrap();
    store.activate_initial(&id, &broker).await.unwrap();
    drop(store);
    let store = RecoveryStore::open(root.path(), "server-test", 1024, 0).unwrap();
    store.activate_initial(&id, &broker).await.unwrap();
    assert_eq!(
        state.lock().await.claims,
        1,
        "active producer claim is never replayed"
    );
    state.lock().await.lose_rotation_response = true;
    state.lock().await.stale_signals = true;
    assert!(
        store
            .rotate_for_restart(&id, &broker, "owner")
            .await
            .is_err()
    );
    assert!(store.list().await.unwrap()[0].pending_producer.is_some());
    drop(store);
    {
        let mut state = state.lock().await;
        state.lose_rotation_response = false;
        state.fail_sessions = false;
    }
    let store = RecoveryStore::open(root.path(), "server-test", 1024, 0).unwrap();
    let recovered = store
        .rotate_for_restart(&id, &broker, "owner")
        .await
        .unwrap();
    let state = state.lock().await;
    assert_eq!(state.claims, 1);
    assert_eq!(state.rotations, 1);
    assert!(
        !state.stale_signals,
        "fresh producer generation clears pre-crash SDP"
    );
    assert_eq!(state.current.as_ref().unwrap().payload, recovered.payload);
    assert!(store.list().await.unwrap()[0].pending_producer.is_none());
    assert_eq!(
        store.list().await.unwrap()[0].signing_seed,
        record.signing_seed
    );
    task.abort();
}

#[tokio::test]
async fn cancelled_rotation_retries_same_pending_successor_after_delayed_remote_commit()
-> anyhow::Result<()> {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let root = tempfile::tempdir()?;
        let delayed = Arc::new(DelayedResume::default());
        let state = Arc::new(tokio::sync::Mutex::new(BrokerState {
            delayed_resume: Some(delayed.clone()),
            ..Default::default()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let app = Router::new()
            .route("/issue", post(issue))
            .route("/{operation}/{room}", post(room_operation))
            .with_state(state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await });
        let broker = BrokerClient::local(&format!("http://{address}/"))?;
        let mut record = record(now(), b"snapshot");
        record.broker_origin = format!("http://{address}");
        let store = RecoveryStore::open(root.path(), "server-test", 1024, 0)?;
        let id = store
            .prepare(record.clone(), opened(b"snapshot"), now())
            .await?;
        let current = broker
            .issue(
                "owner",
                &record.room,
                "producer_nonce_1234567890",
                record.expires_at,
            )
            .await?;
        store.set_producer(&id, current).await?;
        store.activate_initial(&id, &broker).await?;
        let first = {
            let (store, broker, id) = (store.clone(), broker.clone(), id.clone());
            tokio::spawn(async move { store.rotate_for_restart(&id, &broker, "owner").await })
        };
        delayed.entered.notified().await;
        let pending = store.list().await?[0].pending_producer.clone().unwrap();
        first.abort();
        assert!(matches!(first.await, Err(error) if error.is_cancelled()));
        let recovered = store.rotate_for_restart(&id, &broker, "owner").await?;
        assert_eq!(recovered.payload, pending.payload);
        let saved = store.list().await?.remove(0);
        assert_eq!(saved.producer.unwrap().payload, pending.payload);
        assert!(saved.pending_producer.is_none());
        assert_eq!(
            broker.session_generation(&record.room, &recovered).await?,
            1
        );
        let state = state.lock().await;
        assert_eq!(
            state.successors_issued, 1,
            "never mint B while A might still commit"
        );
        assert_eq!(state.rotations, 1);
        server.abort();
        Ok::<(), anyhow::Error>(())
    })
    .await??;
    Ok(())
}

#[tokio::test]
async fn cancelled_preparation_keeps_admission_until_blocking_worker_finishes() -> anyhow::Result<()>
{
    struct Charged {
        permit: Option<tokio::sync::OwnedSemaphorePermit>,
        dropped: Option<tokio::sync::oneshot::Sender<()>>,
    }
    impl Drop for Charged {
        fn drop(&mut self) {
            drop(self.permit.take());
            if let Some(done) = self.dropped.take() {
                let _ = done.send(());
            }
        }
    }
    let root = tempfile::tempdir()?;
    let store = RecoveryStore::open(root.path(), "server-test", 1024, 0)?;
    let semaphore = Arc::new(tokio::sync::Semaphore::new(1));
    let (dropped, done) = tokio::sync::oneshot::channel();
    let charged = Charged {
        permit: Some(semaphore.clone().try_acquire_owned()?),
        dropped: Some(dropped),
    };
    let (entered, started) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let blocker = tokio::task::spawn_blocking(move || {
        let _gate = FILE_GATE.lock().unwrap();
        let _ = entered.send(());
        released.recv().unwrap();
    });
    started.await?;
    let mut request = Box::pin(store.prepare_admitted(
        record(now(), b"snapshot"),
        opened(b"snapshot"),
        now(),
        charged,
    ));
    std::future::poll_fn(|context| {
        assert!(std::future::Future::poll(request.as_mut(), context).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    drop(request);
    assert_eq!(semaphore.available_permits(), 0);
    release.send(())?;
    blocker.await?;
    tokio::time::timeout(std::time::Duration::from_secs(5), done).await??;
    assert_eq!(semaphore.available_permits(), 1);
    assert_eq!(
        store.list().await?.len(),
        1,
        "worker completes a discoverable retained snapshot"
    );
    Ok(())
}

#[tokio::test]
#[ignore = "internal subprocess probe launched by recovery_store_os_locks_exclude_other_processes"]
async fn recovery_store_os_lock_child() -> anyhow::Result<()> {
    let root = std::env::var_os("OPERALIBRE_RECOVERY_LOCK_TEST_ROOT")
        .ok_or_else(|| anyhow::anyhow!("missing subprocess fixture"))?;
    let mode = std::env::var("OPERALIBRE_RECOVERY_LOCK_TEST_MODE")?;
    let store = RecoveryStore::open(Path::new(&root), "server-test", 1024, 0)?;
    match mode.as_str() {
        "index" => anyhow::ensure!(
            store.list().await.is_err(),
            "concurrent index transaction was admitted"
        ),
        "rotation" => anyhow::ensure!(
            store.rotation_lease(&"a".repeat(64)).is_err(),
            "concurrent rotation was admitted"
        ),
        _ => anyhow::bail!("invalid subprocess fixture mode"),
    }
    Ok(())
}

#[tokio::test]
async fn recovery_store_os_locks_exclude_other_processes() -> anyhow::Result<()> {
    let root = tempfile::tempdir()?;
    let store = RecoveryStore::open(root.path(), "server-test", 1024, 0)?;
    for mode in ["index", "rotation"] {
        let lease = if mode == "index" {
            store.open_lock("index.lock")?
        } else {
            store.rotation_lease(&"a".repeat(64))?
        };
        let root = root.path().to_owned();
        let output = tokio::task::spawn_blocking(move || {
            std::process::Command::new(std::env::current_exe()?)
                .args([
                    "share_sender_recovery::tests::recovery_store_os_lock_child",
                    "--exact",
                    "--ignored",
                    "--nocapture",
                ])
                .env("OPERALIBRE_RECOVERY_LOCK_TEST_ROOT", root)
                .env("OPERALIBRE_RECOVERY_LOCK_TEST_MODE", mode)
                .output()
        })
        .await??;
        assert!(
            output.status.success(),
            "cross-process {mode} lease probe failed"
        );
        drop(lease);
    }
    assert!(store.list().await?.is_empty());
    drop(store.rotation_lease(&"a".repeat(64))?);
    Ok(())
}

struct RecipientHandler {
    gathered: tokio::sync::mpsc::Sender<()>,
    frames: tokio::sync::mpsc::Sender<(Arc<dyn webrtc::data_channel::DataChannel>, bool, Vec<u8>)>,
}
#[async_trait::async_trait]
impl webrtc::peer_connection::PeerConnectionEventHandler for RecipientHandler {
    async fn on_ice_gathering_state_change(
        &self,
        state: webrtc::peer_connection::RTCIceGatheringState,
    ) {
        if state == webrtc::peer_connection::RTCIceGatheringState::Complete {
            let _ = self.gathered.try_send(());
        }
    }
    async fn on_data_channel(&self, channel: Arc<dyn webrtc::data_channel::DataChannel>) {
        let frames = self.frames.clone();
        tokio::spawn(async move {
            while let Some(event) = channel.poll().await {
                match event {
                    webrtc::data_channel::DataChannelEvent::OnMessage(message)
                        if frames
                            .send((channel.clone(), message.is_string, message.data.to_vec()))
                            .await
                            .is_err() =>
                    {
                        break;
                    }
                    webrtc::data_channel::DataChannelEvent::OnClose => break,
                    _ => {}
                }
            }
        });
    }
}
struct RecipientPeer(Arc<dyn webrtc::peer_connection::PeerConnection>);
impl Drop for RecipientPeer {
    fn drop(&mut self) {
        let peer = self.0.clone();
        tokio::spawn(async move {
            let _ = peer.close().await;
        });
    }
}

async fn signal_from_recipient(
    broker: &BrokerClient,
    record: &PersistedSender,
    recipient: &Capability,
    generation: u64,
    sequence: u32,
    kind: &str,
    message: Value,
) -> anyhow::Result<()> {
    crate::http_client_builder().build()?.post(broker.origin().join(&format!("/send/{}", record.room))?)
        .json(&json!({"payload":recipient.payload,"signature":recipient.signature,"generation":generation,"sequence":sequence,"kind":kind,"message":message.to_string()}))
        .send().await?.error_for_status()?;
    Ok(())
}

async fn wait_offer(state: &Arc<tokio::sync::Mutex<BrokerState>>) -> Value {
    loop {
        if let Some(offer) = state.lock().await.queues[0].first().cloned() {
            return offer;
        }
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn reopened_sender_rotates_stale_offer_and_transfers_verified_zip_over_real_peer()
-> anyhow::Result<()> {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::Verifier;
    tokio::time::timeout(std::time::Duration::from_secs(60), async {
        let root = tempfile::tempdir()?;
        let state = Arc::new(tokio::sync::Mutex::new(BrokerState::default()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let app = Router::new()
            .route("/issue", post(issue))
            .route("/{operation}/{room}", post(room_operation))
            .with_state(state.clone());
        let broker_task = tokio::spawn(async move { axum::serve(listener, app).await });
        let broker = BrokerClient::local(&format!("http://{address}/"))?;
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        zip.start_file(
            "selected.epub",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored),
        )?;
        zip.write_all(&(0..200_000).map(|n| (n % 251) as u8).collect::<Vec<_>>())?;
        zip.start_file("metadata.json", zip::write::SimpleFileOptions::default())?;
        zip.write_all(br#"{"title":"Trusted title"}"#)?;
        let bytes = zip.finish()?.into_inner();
        let mut record = record(now(), &bytes);
        record.broker_origin = format!("http://{address}");
        let store = RecoveryStore::open(root.path(), "server-test", 1024 * 1024, 0)?;
        let id = store.prepare(record.clone(), opened(&bytes), now()).await?;
        let producer = broker
            .issue(
                "owner",
                &record.room,
                "producer_nonce_1234567890",
                record.expires_at,
            )
            .await?;
        store.set_producer(&id, producer).await?;
        let producer = store.activate_initial(&id, &broker).await?;
        let recipient = broker
            .issue_recipient(
                "owner",
                &record.room,
                "recipient_nonce_1234567890",
                record.expires_at,
            )
            .await?;
        broker.claim(&record.room, &recipient).await?;
        signal_from_recipient(
            &broker,
            &record,
            &recipient,
            0,
            1,
            "ready",
            json!({"challenge":URL_SAFE_NO_PAD.encode([1;32])}),
        )
        .await?;
        let restored = store.restore(&id, &authority(&record), now()).await?;
        let old_broker = broker.clone();
        let room = record.room.clone();
        let size = record.archive_size;
        let expires = record.expires_at;
        let session = crate::share_service::run_authorized(true, expires, move |stop| {
            crate::share_sender::run_authenticated_sender(
                old_broker,
                room,
                producer,
                restored.archive,
                size,
                expires,
                restored.authentication,
                stop,
            )
        })
        .await?;
        wait_offer(&state).await;
        assert!(session.stop().await.is_err());
        drop(store);
        // New store and sender lifetime, same persisted broker room and keys.
        let store = RecoveryStore::open(root.path(), "server-test", 1024 * 1024, 0)?;
        let producer = store.rotate_for_restart(&id, &broker, "owner").await?;
        assert!(state.lock().await.queues.iter().all(Vec::is_empty));
        let generation = broker.session_generation(&record.room, &producer).await?;
        assert_eq!(generation, 1);
        let restored = store.restore(&id, &authority(&record), now()).await?;
        let sender_broker = broker.clone();
        let room = record.room.clone();
        let session = crate::share_service::run_authorized(true, expires, move |stop| {
            crate::share_sender::run_authenticated_sender(
                sender_broker,
                room,
                producer,
                restored.archive,
                size,
                expires,
                restored.authentication,
                stop,
            )
        })
        .await?;
        let challenge = URL_SAFE_NO_PAD.encode([2; 32]);
        signal_from_recipient(
            &broker,
            &record,
            &recipient,
            generation,
            1,
            "ready",
            json!({"challenge":challenge}),
        )
        .await?;
        let signal = wait_offer(&state).await;
        let envelope: Value = serde_json::from_str(signal["message"].as_str().unwrap())?;
        let payload = URL_SAFE_NO_PAD.decode(envelope["payload"].as_str().unwrap())?;
        let signature = ed25519_dalek::Signature::from_slice(
            &URL_SAFE_NO_PAD.decode(envelope["signature"].as_str().unwrap())?,
        )?;
        let mut signed = b"operalibre-gift-peer-offer-v1\0".to_vec();
        signed.extend_from_slice(&payload);
        ed25519_dalek::SigningKey::from_bytes(&record.signing_seed)
            .verifying_key()
            .verify(&signed, &signature)?;
        let offer: Value = serde_json::from_slice(&payload)?;
        assert_eq!(offer["room"], record.room);
        assert_eq!(offer["giftId"], record.gift_id);
        assert_eq!(offer["generation"], generation);
        assert_eq!(offer["challenge"], challenge);
        assert_eq!(offer["archiveSha256"], record.archive_sha256);
        assert_eq!(offer["archiveSize"], record.archive_size);
        assert_eq!(offer["offset"], 0);
        assert_eq!(offer["prefixSha256"], digest([]));
        let description = offer["offer"].as_str().unwrap();
        let (gathered, mut gather) = tokio::sync::mpsc::channel(1);
        let (frames, mut received) = tokio::sync::mpsc::channel(16);
        let peer = RecipientPeer(
            crate::share_sender::create_configured_peer(
                &crate::share_connectivity::ConnectivityConfig::default(),
                Arc::new(RecipientHandler { gathered, frames }),
            )
            .await?,
        );
        peer.0
            .set_remote_description(serde_json::from_str(description)?)
            .await?;
        peer.0
            .set_local_description(peer.0.create_answer(None).await?)
            .await?;
        gather
            .recv()
            .await
            .ok_or_else(|| anyhow::anyhow!("recipient gather closed"))?;
        let answer = serde_json::to_string(
            &peer
                .0
                .local_description()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing recipient description"))?,
        )?;
        let transcript = format!(
            "operalibre-peer-proof-v1\n{}\n{}\n{}\n{}\n{}\n{}\n0\n{}\n{}\n{}\n{}",
            record.room,
            record.gift_id,
            expires,
            generation,
            size,
            record.archive_sha256,
            digest([]),
            challenge,
            digest(description.as_bytes()),
            digest(answer.as_bytes())
        );
        let base_key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &record.preview_key);
        let proof_key = ring::hmac::sign(&base_key, b"operalibre-peer-proof-key-v1");
        let proof = ring::hmac::sign(
            &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, proof_key.as_ref()),
            transcript.as_bytes(),
        );
        signal_from_recipient(
            &broker,
            &record,
            &recipient,
            generation,
            2,
            "answer",
            json!({"descriptionJson":answer,"proof":URL_SAFE_NO_PAD.encode(proof)}),
        )
        .await?;
        let mut receiver = crate::share_transfer::Receiver::resume(
            tempfile::tempfile()?,
            0,
            size,
            Sha256::digest(&bytes).into(),
        )?;
        loop {
            let (channel, text, frame) = received
                .recv()
                .await
                .ok_or_else(|| anyhow::anyhow!("recipient channel closed"))?;
            assert!(!text);
            let (asset, offset, final_chunk, data) = crate::share_transfer::decode_chunk(&frame)?;
            assert_eq!(asset, "archive");
            if !final_chunk {
                receiver.append(offset, data)?;
                channel
                    .send_text(
                        &json!({"type":"persisted","offset":offset+data.len() as u64}).to_string(),
                    )
                    .await?;
                continue;
            }
            assert_eq!(offset, size);
            assert!(data.is_empty());
            let mut verified = receiver.finish()?;
            verified.seek(SeekFrom::Start(0))?;
            let mut actual = Vec::new();
            verified.read_to_end(&mut actual)?;
            assert_eq!(actual, bytes);
            let mut zip = zip::ZipArchive::new(std::io::Cursor::new(actual))?;
            assert_eq!(zip.len(), 2);
            assert!(zip.by_name("selected.epub").is_ok());
            assert!(zip.by_name("metadata.json").is_ok());
            channel
                .send_text(
                    &json!({"type":"verified","size":size,"sha256":record.archive_sha256})
                        .to_string(),
                )
                .await?;
            let (_, text, confirmation) = received
                .recv()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing sender confirmation"))?;
            assert!(text);
            assert_eq!(
                serde_json::from_slice::<Value>(&confirmation)?,
                json!({"type":"receipt-confirmed","size":size,"sha256":record.archive_sha256})
            );
            channel.close().await?;
            break;
        }
        session.wait().await?;
        assert_eq!(state.lock().await.claims, 1);
        peer.0.close().await?;
        broker_task.abort();
        Ok::<(), anyhow::Error>(())
    })
    .await??;
    Ok(())
}

#[tokio::test]
async fn full_day_sender_recovers_after_fifteen_minutes_but_not_after_expiry() {
    let root = tempfile::tempdir().unwrap();
    let store = RecoveryStore::open(root.path(), "server-test", 1024, 0).unwrap();
    let at = now();
    let mut record = record(at, b"snapshot");
    record.expires_at = at + crate::share::GIFT_MAX_LIFETIME_SECONDS;
    let id = store
        .prepare(record.clone(), opened(b"snapshot"), at)
        .await
        .unwrap();
    let restored = store
        .restore(&id, &authority(&record), at + 16 * 60)
        .await
        .unwrap();
    drop(restored);
    assert!(
        store
            .restore(&id, &authority(&record), record.expires_at)
            .await
            .is_err()
    );
}
