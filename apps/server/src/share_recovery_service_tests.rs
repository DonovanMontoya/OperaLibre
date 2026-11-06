//! Opt-in actual Worker (local Node adapter) + actual sender/recipient peer.
//! This is not a Cloudflare deployment or a native/browser import test.
use super::*;
use crate::share_sender_recovery::{PersistedSender, RecoveryStore};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::Verifier;
use serde_json::Value;
use tokio::io::AsyncBufReadExt;
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::peer_connection::{PeerConnection, PeerConnectionEventHandler, RTCIceGatheringState};

const FIXTURE_OWNER: &str = "fixture-owner-not-a-real-credential-123";

struct ProbeServer(tokio::task::JoinHandle<()>);
impl Drop for ProbeServer {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn persisted_claim_probe(
    target: reqwest::Url,
    store: RecoveryStore,
) -> anyhow::Result<(
    crate::share_broker::BrokerClient,
    Arc<std::sync::atomic::AtomicUsize>,
    ProbeServer,
)> {
    use axum::response::IntoResponse;
    let checked = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let app = axum::Router::new().route(
        "/{*path}",
        axum::routing::post({
            let checked = checked.clone();
            move |axum::extract::Path(path): axum::extract::Path<String>,
                  headers: HeaderMap,
                  body: axum::body::Bytes| {
                let (target, store, checked) = (target.clone(), store.clone(), checked.clone());
                async move {
                    if path.starts_with("claim/") {
                        let value: Value = serde_json::from_slice(&body).unwrap();
                        let claim: Value =
                            serde_json::from_str(value["payload"].as_str().unwrap()).unwrap();
                        if claim["role"] == "producer" {
                            let records = store.list().await.unwrap();
                            let persisted = records.iter().any(|record| {
                                record.room == claim["room"]
                                    && record.producer.as_ref().is_some_and(|cap| {
                                        value["payload"] == cap.payload
                                            && value["signature"] == cap.signature
                                    })
                            });
                            if !persisted {
                                return StatusCode::CONFLICT.into_response();
                            }
                            checked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        }
                    }
                    let client = crate::http_client_builder().build().unwrap();
                    let mut request = client
                        .post(target.join(&format!("/{path}")).unwrap())
                        .header("content-type", "application/json")
                        .body(body);
                    if let Some(auth) = headers.get("authorization") {
                        request = request.header("authorization", auth);
                    }
                    let response = request.send().await.unwrap();
                    let status = response.status();
                    // Body framing belongs to this connection, not Node's.
                    let mut headers = HeaderMap::new();
                    for name in ["content-type", "cache-control", "x-signaling-generation"] {
                        for value in response.headers().get_all(name) {
                            headers.append(name, value.clone());
                        }
                    }
                    let body = response.bytes().await.unwrap();
                    (status, headers, body).into_response()
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Ok((
        crate::share_broker::BrokerClient::local(&format!("http://{address}/"))?,
        checked,
        ProbeServer(task),
    ))
}

struct Recipient {
    gathered: tokio::sync::mpsc::Sender<()>,
    frames: tokio::sync::mpsc::Sender<(Arc<dyn DataChannel>, bool, Vec<u8>)>,
}
#[async_trait::async_trait]
impl PeerConnectionEventHandler for Recipient {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.gathered.try_send(());
        }
    }
    async fn on_data_channel(&self, channel: Arc<dyn DataChannel>) {
        let frames = self.frames.clone();
        tokio::spawn(async move {
            while let Some(event) = channel.poll().await {
                match event {
                    DataChannelEvent::OnMessage(message) => {
                        if frames
                            .send((channel.clone(), message.is_string, message.data.to_vec()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    DataChannelEvent::OnClose => break,
                    _ => {}
                }
            }
        });
    }
}
struct PeerOwner(Arc<dyn PeerConnection>);
impl Drop for PeerOwner {
    fn drop(&mut self) {
        let peer = self.0.clone();
        tokio::spawn(async move {
            let _ = peer.close().await;
        });
    }
}
struct Pins {
    recipient: crate::share_broker::Capability,
    preview_key: [u8; 32],
    verifying: ed25519_dalek::VerifyingKey,
    gift_id: String,
    recovery_secret: String,
}
fn parse_pins(url: &str) -> anyhow::Result<Pins> {
    let mut url = reqwest::Url::parse(url)?;
    let fragment = url
        .fragment()
        .ok_or_else(|| anyhow::anyhow!("missing gift fragment"))?
        .to_owned();
    url.set_query(Some(&fragment));
    let fields: HashMap<String, String> = url.query_pairs().into_owned().collect();
    let decode = |name: &str| -> anyhow::Result<Vec<u8>> {
        Ok(URL_SAFE_NO_PAD.decode(
            fields
                .get(name)
                .ok_or_else(|| anyhow::anyhow!("missing gift pin"))?,
        )?)
    };
    Ok(Pins {
        recipient: serde_json::from_slice(&decode("gift")?)?,
        preview_key: decode("key")?
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid preview pin"))?,
        verifying: ed25519_dalek::VerifyingKey::from_bytes(
            &decode("signing")?
                .try_into()
                .map_err(|_| anyhow::anyhow!("invalid signing pin"))?,
        )?,
        gift_id: fields
            .get("id")
            .ok_or_else(|| anyhow::anyhow!("missing gift ID"))?
            .clone(),
        recovery_secret: URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>()),
    })
}
async fn claim_recipient(
    broker: &crate::share_broker::BrokerClient,
    record: &PersistedSender,
    pins: &Pins,
) -> anyhow::Result<()> {
    let client = crate::http_client_builder().build()?;
    client.post(broker.origin().join(&format!("/recovery-claim/{}", record.room))?)
        .json(&serde_json::json!({"payload":pins.recipient.payload,"signature":pins.recipient.signature,"recoverySecret":pins.recovery_secret}))
        .send().await?.error_for_status()?;
    // The original gift capability alone stops authorizing recipient requests
    // immediately on enrollment, including before any producer rotation.
    let without_secret = client.post(broker.origin().join(&format!("/session/{}", record.room))?)
        .json(&serde_json::json!({"payload":pins.recipient.payload,"signature":pins.recipient.signature}))
        .send().await?;
    assert_eq!(without_secret.status(), StatusCode::FORBIDDEN);
    client.post(broker.origin().join(&format!("/session/{}", record.room))?)
        .json(&serde_json::json!({"payload":pins.recipient.payload,"signature":pins.recipient.signature,"recoverySecret":pins.recovery_secret}))
        .send().await?.error_for_status()?;
    Ok(())
}

async fn signal(
    broker: &crate::share_broker::BrokerClient,
    record: &PersistedSender,
    pins: &Pins,
    generation: u64,
    sequence: u32,
    kind: &str,
    message: Value,
) -> anyhow::Result<()> {
    crate::http_client_builder().build()?.post(broker.origin().join(&format!("/send/{}", record.room))?)
        .json(&serde_json::json!({"payload":pins.recipient.payload,"signature":pins.recipient.signature,"recoverySecret":pins.recovery_secret,"generation":generation,"sequence":sequence,"kind":kind,"message":message.to_string()}))
        .send().await?.error_for_status()?;
    Ok(())
}
async fn offer(
    broker: &crate::share_broker::BrokerClient,
    record: &PersistedSender,
    pins: &Pins,
    generation: u64,
) -> anyhow::Result<Value> {
    let client = crate::http_client_builder().build()?;
    loop {
        let signals: Vec<Value> = client.post(broker.origin().join(&format!("/poll/{}", record.room))?)
            .json(&serde_json::json!({"payload":pins.recipient.payload,"signature":pins.recipient.signature,"recoverySecret":pins.recovery_secret,"generation":generation,"after":0}))
            .send().await?.error_for_status()?.json().await?;
        if let Some(signal) = signals.first() {
            anyhow::ensure!(
                signal["sequence"] == 1 && signal["kind"] == "offer",
                "unexpected offer signal"
            );
            return Ok(serde_json::from_str(
                signal["message"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("invalid offer"))?,
            )?);
        }
        tokio::task::yield_now().await;
    }
}
fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

async fn receive_zip(
    broker: &crate::share_broker::BrokerClient,
    record: &PersistedSender,
    pins: &Pins,
    generation: u64,
) -> anyhow::Result<(Vec<u8>, PeerOwner)> {
    let challenge = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
    signal(
        broker,
        record,
        pins,
        generation,
        1,
        "ready",
        serde_json::json!({"challenge":challenge}),
    )
    .await?;
    let envelope = offer(broker, record, pins, generation).await?;
    let payload = URL_SAFE_NO_PAD.decode(envelope["payload"].as_str().unwrap())?;
    let signature = ed25519_dalek::Signature::from_slice(
        &URL_SAFE_NO_PAD.decode(envelope["signature"].as_str().unwrap())?,
    )?;
    let mut signed = b"operalibre-gift-peer-offer-v1\0".to_vec();
    signed.extend_from_slice(&payload);
    pins.verifying.verify(&signed, &signature)?;
    let offer: Value = serde_json::from_slice(&payload)?;
    assert_eq!(offer["giftId"], pins.gift_id);
    assert_eq!(offer["room"], record.room);
    assert_eq!(offer["generation"], generation);
    assert_eq!(offer["challenge"], challenge);
    assert_eq!(offer["archiveSize"], record.archive_size);
    assert_eq!(offer["archiveSha256"], record.archive_sha256);
    assert_eq!(offer["expiresAt"], record.expires_at);
    assert_eq!(offer["offset"], 0);
    assert_eq!(offer["prefixSha256"], sha(&[]));
    let description = offer["offer"].as_str().unwrap();
    let (gathered, mut gather) = tokio::sync::mpsc::channel(1);
    let (frames, mut received) = tokio::sync::mpsc::channel(16);
    let peer = PeerOwner(
        crate::share_sender::create_configured_peer(
            &crate::share_connectivity::ConnectivityConfig::default(),
            Arc::new(Recipient { gathered, frames }),
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
            .ok_or_else(|| anyhow::anyhow!("missing local answer"))?,
    )?;
    let transcript = format!(
        "operalibre-peer-proof-v1\n{}\n{}\n{}\n{}\n{}\n{}\n0\n{}\n{}\n{}\n{}",
        record.room,
        pins.gift_id,
        record.expires_at,
        generation,
        record.archive_size,
        record.archive_sha256,
        sha(&[]),
        challenge,
        sha(description.as_bytes()),
        sha(answer.as_bytes())
    );
    let derived = ring::hmac::sign(
        &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &pins.preview_key),
        b"operalibre-peer-proof-key-v1",
    );
    let proof = ring::hmac::sign(
        &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, derived.as_ref()),
        transcript.as_bytes(),
    );
    signal(
        broker,
        record,
        pins,
        generation,
        2,
        "answer",
        serde_json::json!({"descriptionJson":answer,"proof":URL_SAFE_NO_PAD.encode(proof)}),
    )
    .await?;
    let digest: [u8; 32] = (0..32)
        .map(|i| u8::from_str_radix(&record.archive_sha256[i * 2..i * 2 + 2], 16).unwrap())
        .collect::<Vec<_>>()
        .try_into()
        .unwrap();
    let mut receiver = crate::share_transfer::Receiver::resume(
        tempfile::tempfile()?,
        0,
        record.archive_size,
        digest,
    )?;
    loop {
        let (channel, text, frame) = received
            .recv()
            .await
            .ok_or_else(|| anyhow::anyhow!("recipient closed"))?;
        assert!(!text);
        let (asset, offset, final_chunk, bytes) = crate::share_transfer::decode_chunk(&frame)?;
        assert_eq!(asset, "archive");
        if !final_chunk {
            receiver.append(offset, bytes)?;
            channel
                .send_text(
                    &serde_json::json!({"type":"persisted","offset":offset+bytes.len() as u64})
                        .to_string(),
                )
                .await?;
            continue;
        }
        assert_eq!(offset, record.archive_size);
        assert!(bytes.is_empty());
        let mut verified = receiver.finish()?;
        std::io::Seek::rewind(&mut verified)?;
        let mut actual = Vec::new();
        std::io::Read::read_to_end(&mut verified, &mut actual)?;
        assert_eq!(sha(&actual), record.archive_sha256);
        channel.send_text(&serde_json::json!({"type":"verified","size":record.archive_size,"sha256":record.archive_sha256}).to_string()).await?;
        let (_, text, confirmation) = received
            .recv()
            .await
            .ok_or_else(|| anyhow::anyhow!("missing receipt confirmation"))?;
        assert!(text);
        assert_eq!(
            serde_json::from_slice::<Value>(&confirmation)?,
            serde_json::json!({"type":"receipt-confirmed","size":record.archive_size,"sha256":record.archive_sha256})
        );
        channel.close().await?;
        return Ok((actual, peer));
    }
}

#[tokio::test]
#[ignore = "requires compiled actual Worker and OPERALIBRE_WORKER_FIXTURE_SCRIPT"]
async fn retained_invitation_recovers_with_actual_worker_and_real_recipient_peer()
-> anyhow::Result<()> {
    tokio::time::timeout(Duration::from_secs(60), async {
        let script = std::env::var_os("OPERALIBRE_WORKER_FIXTURE_SCRIPT")
            .ok_or_else(|| anyhow::anyhow!("supply the actual Worker fixture script"))?;
        let mut worker = tokio::process::Command::new("node")
            .arg(script)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;
        let mut stdout = tokio::io::BufReader::new(worker.stdout.take().unwrap());
        let mut line = String::new();
        stdout.read_line(&mut line).await?;
        let locator: Value = serde_json::from_str(&line)?;
        let target = reqwest::Url::parse(
            locator["origin"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("missing Worker locator"))?,
        )?;
        let server = TestServer::start(1).await;
        let store = RecoveryStore::open(
            server.state.database_path.parent().unwrap(),
            &server.state.server_id,
            server.state.max_book_download_bytes.unwrap(),
            server.state.min_download_free_bytes,
        )?;
        let (broker, checked_claims, _probe) = persisted_claim_probe(target, store).await?;
        let owner = server.setup_owner().await;
        let (book_id, _) = server.first_book_and_track(&owner).await;
        assert_eq!(
            server
                .upload_ebook(&book_id, &owner, "book.epub", alignment::build_test_epub())
                .await
                .status,
            StatusCode::OK
        );
        let auth = AuthUser::from(&server.state.users.read().await.users[0]);
        let ebook_id = server
            .state
            .library
            .read()
            .await
            .book(&book_id)
            .unwrap()
            .reading_file
            .as_ref()
            .unwrap()
            .id
            .clone();
        let invitation = crate::share::create_selected_share_for_user(
            &server.state,
            &auth,
            crate::share::CreateSelectedShareRequest {
                book_id: book_id.clone(),
                selected_asset_ids: vec![ebook_id.clone()],
                personal_message: Some("A private card".into()),
                expires_in_seconds: Some(300),
            },
        )
        .await
        .map_err(|_| anyhow::anyhow!("selected creation failed"))?;
        let available = server.state.download_task_slots.available_permits();
        let initial = crate::share::start_invitation_sender_with_recovery(
            true,
            &server.state,
            &auth,
            &invitation.token,
            &broker,
            FIXTURE_OWNER,
            &crate::share_connectivity::Connectivity::default(),
            true,
        )
        .await
        .map_err(|error| {
            anyhow::anyhow!(
                "retained sender start failed ({}): {}",
                error.status,
                error.message
            )
        })?;
        let pins = parse_pins(&initial.gift_url)?;
        let root = server.state.database_path.parent().unwrap();
        let store = RecoveryStore::open(
            root,
            &server.state.server_id,
            server.state.max_book_download_bytes.unwrap(),
            server.state.min_download_free_bytes,
        )?;
        let record = store.list().await?.remove(0);
        assert!(record.producer.is_some());
        claim_recipient(&broker, &record, &pins).await?;
        signal(
            &broker,
            &record,
            &pins,
            0,
            1,
            "ready",
            serde_json::json!({"challenge":URL_SAFE_NO_PAD.encode([1;32])}),
        )
        .await?;
        offer(&broker, &record, &pins, 0).await?;
        crate::share::forget_invitation_runtime_for_test(&server.state, &invitation.token).await;
        assert!(initial.wait().await.is_err());
        let cleanup =
            crate::share::retry_revocations_for_owner(&server.state, &broker, FIXTURE_OWNER)
                .await
                .map_err(|_| anyhow::anyhow!("dormant cleanup retry failed"))?;
        assert_eq!(
            cleanup.completed, 0,
            "retry must not revoke a dormant recoverable gift"
        );
        crate::share::prune_confirmed_recovery(&server.state)
            .await
            .map_err(|_| anyhow::anyhow!("dormant snapshot pruning failed"))?;
        assert_eq!(
            broker
                .session_generation(&record.room, record.producer.as_ref().unwrap())
                .await?,
            0
        );
        assert_eq!(store.list().await?.len(), 1);
        assert_eq!(store.list().await?[0].id(), record.id());
        drop(store);
        let report = crate::share::recover_saved_senders(
            true,
            &server.state,
            &broker,
            FIXTURE_OWNER,
            &crate::share_connectivity::Connectivity::default(),
        )
        .await
        .map_err(|_| anyhow::anyhow!("owner recovery failed"))?;
        assert_eq!(serde_json::to_value(report)?["recovered"], 1);
        let store = RecoveryStore::open(
            root,
            &server.state.server_id,
            server.state.max_book_download_bytes.unwrap(),
            server.state.min_download_free_bytes,
        )?;
        let current = store.list().await?.remove(0).producer.unwrap();
        let generation = broker.session_generation(&record.room, &current).await?;
        assert_eq!(generation, 1);
        let (archive, peer) = receive_zip(&broker, &record, &pins, generation).await?;
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive))?;
        assert_eq!(zip.len(), 2);
        assert!(zip.by_name("book.epub").is_ok());
        assert!(zip.by_name("metadata.json").is_ok());
        assert!(zip.by_name("01 Track.wav").is_err());
        loop {
            if store.list().await?.is_empty()
                && server.state.download_task_slots.available_permits() == available
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        peer.0.close().await?;
        // Revoke the same invitation through the real authenticated HTTP route.
        assert_eq!(
            server
                .send_json(
                    "DELETE",
                    &format!("/api/shares/{}", invitation.token),
                    &owner,
                    Value::Null
                )
                .await
                .status,
            StatusCode::NO_CONTENT
        );
        assert!(
            broker
                .session_generation(&record.room, &current)
                .await
                .is_err()
        );
        assert_eq!(
            server
                .get(&format!("/api/shares/{}/preview", invitation.token), "")
                .await
                .status,
            StatusCode::NOT_FOUND
        );
        // A second retained gift proves abandonment stops a recovered live peer,
        // not only that a completed transfer's invitation becomes inaccessible.
        let invitation = crate::share::create_selected_share_for_user(
            &server.state,
            &auth,
            crate::share::CreateSelectedShareRequest {
                book_id,
                selected_asset_ids: vec![ebook_id],
                personal_message: None,
                expires_in_seconds: Some(300),
            },
        )
        .await
        .map_err(|_| anyhow::anyhow!("second selected creation failed"))?;
        let initial = crate::share::start_invitation_sender_with_recovery(
            true,
            &server.state,
            &auth,
            &invitation.token,
            &broker,
            FIXTURE_OWNER,
            &crate::share_connectivity::Connectivity::default(),
            true,
        )
        .await
        .map_err(|error| {
            anyhow::anyhow!(
                "second retained start failed ({}): {}",
                error.status,
                error.message
            )
        })?;
        let pins = parse_pins(&initial.gift_url)?;
        let record = store.list().await?.remove(0);
        claim_recipient(&broker, &record, &pins).await?;
        crate::share::forget_invitation_runtime_for_test(&server.state, &invitation.token).await;
        assert!(initial.wait().await.is_err());
        crate::share::recover_saved_senders(
            true,
            &server.state,
            &broker,
            FIXTURE_OWNER,
            &crate::share_connectivity::Connectivity::default(),
        )
        .await
        .map_err(|_| anyhow::anyhow!("second recovery failed"))?;
        let current = store.list().await?.remove(0).producer.unwrap();
        let generation = broker.session_generation(&record.room, &current).await?;
        signal(
            &broker,
            &record,
            &pins,
            generation,
            1,
            "ready",
            serde_json::json!({"challenge":URL_SAFE_NO_PAD.encode([3;32])}),
        )
        .await?;
        let _live_offer = offer(&broker, &record, &pins, generation).await?;
        assert!(server.state.download_task_slots.available_permits() < available);
        let wrong_broker = crate::share_broker::BrokerClient::new("https://wrong-broker.invalid/")?;
        assert_eq!(
            crate::share::abandon_retained_senders(&server.state, &wrong_broker)
                .await
                .map_err(|_| anyhow::anyhow!("wrong-scope abandonment failed"))?,
            0
        );
        assert_eq!(
            broker.session_generation(&record.room, &current).await?,
            generation
        );
        assert!(!store.list().await?[0].cleanup_only);
        assert_eq!(
            crate::share::abandon_retained_senders(&server.state, &broker)
                .await
                .map_err(|_| anyhow::anyhow!("retained-gift abandonment failed"))?,
            1
        );
        let cleanup =
            crate::share::retry_revocations_for_owner(&server.state, &broker, FIXTURE_OWNER)
                .await
                .map_err(|_| anyhow::anyhow!("abandoned room cleanup failed"))?;
        assert_eq!(cleanup.completed, 1);
        assert_eq!(cleanup.pending, 0);
        loop {
            if server.state.download_task_slots.available_permits() == available {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(
            broker
                .session_generation(&record.room, &current)
                .await
                .is_err()
        );
        crate::share::prune_confirmed_recovery(&server.state)
            .await
            .map_err(|_| anyhow::anyhow!("snapshot cleanup failed"))?;
        assert!(store.list().await?.is_empty());
        assert_eq!(
            server
                .get(&format!("/api/shares/{}/preview", invitation.token), "")
                .await
                .status,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            checked_claims.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "one initial persisted producer claim per gift, no reclaim on restart"
        );
        worker.kill().await?;
        Ok::<(), anyhow::Error>(())
    })
    .await??;
    Ok(())
}
