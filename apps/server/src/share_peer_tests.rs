//! Isolated host-ICE loopback; no broker or external service is involved.
use std::sync::Arc;
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::peer_connection::{
    MediaEngine, PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler,
    RTCConfigurationBuilder, RTCIceGatheringState, Registry, register_default_interceptors,
};
use webrtc::runtime::{Runtime, default_runtime};

struct Handler {
    gathered: tokio::sync::mpsc::Sender<()>,
    received: Option<tokio::sync::mpsc::Sender<Vec<u8>>>,
    runtime: Arc<dyn Runtime>,
}

struct ReceiptHandler {
    gathered: tokio::sync::mpsc::Sender<()>,
    received: tokio::sync::mpsc::Sender<(Arc<dyn DataChannel>, bool, Vec<u8>)>,
    runtime: Arc<dyn Runtime>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for ReceiptHandler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.gathered.try_send(());
        }
    }
    async fn on_data_channel(&self, channel: Arc<dyn DataChannel>) {
        let sender = self.received.clone();
        self.runtime.spawn(Box::pin(async move {
            while let Some(event) = channel.poll().await {
                if let DataChannelEvent::OnMessage(message) = event {
                    if sender
                        .send((channel.clone(), message.is_string, message.data.to_vec()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }));
    }
}

#[derive(Clone)]
struct ContractBroker {
    queues: Arc<tokio::sync::Mutex<[Vec<serde_json::Value>; 2]>>,
    changed: Arc<tokio::sync::Notify>,
    revoked: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LoopbackMode {
    Good,
    Resumed,
    Forged,
    BadReceipt,
    Cancel,
    CancelAfterConfirmation,
    RevokeAfterConfirmation,
}

async fn authenticated_loopback(mode: LoopbackMode) -> anyhow::Result<()> {
    use axum::{
        Json, Router, extract::Path, http::StatusCode, response::IntoResponse, routing::post,
    };
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::Verifier;
    use sha2::{Digest, Sha256};
    use std::io::{Read, Seek, Write};

    const ROOM: &str = "room____________";
    const GIFT: &str = "gift____________";
    const PREFIX: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    let generation = if mode == LoopbackMode::Resumed { 1 } else { 0 };
    let state = ContractBroker {
        queues: Arc::new(tokio::sync::Mutex::new([Vec::new(), Vec::new()])),
        changed: Arc::new(tokio::sync::Notify::new()),
        revoked: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };
    let app = Router::new()
        .route(
            "/{action}/{room}",
            post({
                let state = state.clone();
                move |Path((action, room)): Path<(String, String)>,
                      Json(body): Json<serde_json::Value>| {
                    let state = state.clone();
                    async move {
                        if state.revoked.load(std::sync::atomic::Ordering::SeqCst) {
                            return StatusCode::FORBIDDEN.into_response();
                        }
                        let role = match (body["payload"].as_str(), body["signature"].as_str()) {
                            (Some("producer"), Some("producer-secret")) => 0,
                            (Some("recipient"), Some("recipient-secret")) => 1,
                            _ => return StatusCode::FORBIDDEN.into_response(),
                        };
                        if room != ROOM
                            || body.get("generation").and_then(|v| v.as_u64()).unwrap_or(0)
                                != generation
                        {
                            return StatusCode::CONFLICT.into_response();
                        }
                        let mut queues = state.queues.lock().await;
                        if action == "poll" {
                            let Some(after) = body["after"].as_u64().filter(|n| *n <= 32) else {
                                return StatusCode::BAD_REQUEST.into_response();
                            };
                            let result: Vec<_> = queues[1 - role]
                                .iter()
                                .filter(|item| item["sequence"].as_u64().unwrap() > after)
                                .cloned()
                                .collect();
                            return Json(result).into_response();
                        }
                        if action != "send" {
                            return StatusCode::NOT_FOUND.into_response();
                        }
                        let Some(sequence) =
                            body["sequence"].as_u64().filter(|n| (1..=32).contains(n))
                        else {
                            return StatusCode::BAD_REQUEST.into_response();
                        };
                        let Some(kind) = body["kind"].as_str() else {
                            return StatusCode::BAD_REQUEST.into_response();
                        };
                        let Some(message) = body["message"].as_str().filter(|s| s.len() <= 7168)
                        else {
                            return StatusCode::BAD_REQUEST.into_response();
                        };
                        let permitted = matches!(
                            (role, sequence, kind),
                            (0, 1, "offer") | (1, 1, "ready") | (1, 2, "answer")
                        ) || (kind == "ice"
                            && sequence >= if role == 0 { 2 } else { 3 });
                        if !permitted {
                            return StatusCode::BAD_REQUEST.into_response();
                        }
                        if sequence as usize != queues[role].len() + 1 {
                            return StatusCode::CONFLICT.into_response();
                        }
                        queues[role].push(
                        serde_json::json!({"sequence": sequence, "kind": kind, "message": message}),
                    );
                        state.changed.notify_one();
                        StatusCode::NO_CONTENT.into_response()
                    }
                }
            }),
        )
        .layer(axum::extract::DefaultBodyLimit::max(8192));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let broker = crate::share_broker::BrokerClient::local(&format!("http://{address}/"))?;
    let client = crate::http_client_builder().build()?;
    let recipient = serde_json::json!({"payload":"recipient", "signature":"recipient-secret"});
    let challenge = URL_SAFE_NO_PAD.encode([4_u8; 32]);
    let send = |sequence: u64, kind: &str, message: String| {
        let mut body = recipient.clone();
        body["generation"] = generation.into();
        body["sequence"] = sequence.into();
        body["kind"] = kind.into();
        body["message"] = message.into();
        client
            .post(format!("http://{address}/send/{ROOM}"))
            .json(&body)
            .send()
    };
    let bytes: Vec<u8> = (0..50_000).map(|n| (n % 251) as u8).collect();
    let hex = |value: &[u8]| {
        value
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    let digest = hex(&Sha256::digest(&bytes));
    let resume_offset = if mode == LoopbackMode::Resumed {
        20_000
    } else {
        0
    };
    let prefix = if resume_offset > 0 {
        hex(&Sha256::digest(&bytes[..resume_offset]))
    } else {
        PREFIX.to_string()
    };
    let mut ready = serde_json::json!({"challenge": challenge});
    if resume_offset > 0 {
        ready["resume"] = serde_json::json!({"offset":resume_offset,"prefixSha256":prefix});
    }
    send(1, "ready", ready.to_string())
        .await?
        .error_for_status()?;
    let mut source = tempfile::tempfile()?;
    source.write_all(&bytes)?;
    let signing = ed25519_dalek::SigningKey::from_bytes(&[8; 32]);
    let verifying = signing.verifying_key();
    let key = [7_u8; 32];
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs()
        + 90;
    let (stop, stop_rx) = tokio::sync::watch::channel(false);
    let sender = tokio::spawn(crate::share_sender::run_authenticated_peer(
        broker,
        ROOM.into(),
        crate::share_broker::Capability {
            payload: "producer".into(),
            signature: "producer-secret".into(),
        },
        generation,
        tokio::fs::File::from_std(source),
        bytes.len() as u64,
        expires,
        crate::share_sender::PeerAuthentication {
            gift_id: GIFT.into(),
            archive_sha256: digest.clone(),
            signing,
            preview_key: key,
        },
        stop_rx,
    ));

    let envelope = loop {
        let notified = state.changed.notified();
        let response = client.post(format!("http://{address}/poll/{ROOM}")).json(&serde_json::json!({"payload":"recipient","signature":"recipient-secret","after":0,"generation":generation})).send().await?.error_for_status()?;
        let signals: Vec<serde_json::Value> = response.json().await?;
        if let Some(signal) = signals.first() {
            assert_eq!(signal["sequence"], 1);
            assert_eq!(signal["kind"], "offer");
            break serde_json::from_str::<serde_json::Value>(signal["message"].as_str().unwrap())?;
        }
        notified.await;
    };
    let payload = URL_SAFE_NO_PAD.decode(envelope["payload"].as_str().unwrap())?;
    let signature = ed25519_dalek::Signature::from_slice(
        &URL_SAFE_NO_PAD.decode(envelope["signature"].as_str().unwrap())?,
    )?;
    let mut signed = b"operalibre-gift-peer-offer-v1\0".to_vec();
    signed.extend_from_slice(&payload);
    verifying.verify(&signed, &signature)?;
    let offer: serde_json::Value = serde_json::from_slice(&payload)?;
    assert_eq!(offer["version"], 1);
    assert_eq!(offer["giftId"], GIFT);
    assert_eq!(offer["room"], ROOM);
    assert_eq!(offer["expiresAt"], expires);
    assert_eq!(offer["archiveSize"], bytes.len());
    assert_eq!(offer["archiveSha256"], digest);
    assert_eq!(offer["generation"], generation);
    assert_eq!(offer["offset"], resume_offset);
    assert_eq!(offer["prefixSha256"], prefix);
    assert_eq!(offer["challenge"], challenge);
    let description = offer["offer"].as_str().unwrap();

    let runtime = default_runtime().expect("WebRTC runtime");
    let (gather_tx, mut gather_rx) = tokio::sync::mpsc::channel(1);
    let (received_tx, mut received_rx) = tokio::sync::mpsc::channel(16);
    let recipient_peer = peer(
        runtime.clone(),
        ReceiptHandler {
            gathered: gather_tx,
            received: received_tx,
            runtime,
        },
    )
    .await?;
    recipient_peer
        .set_remote_description(serde_json::from_str(description)?)
        .await?;
    recipient_peer
        .set_local_description(recipient_peer.create_answer(None).await?)
        .await?;
    gather_rx
        .recv()
        .await
        .ok_or_else(|| anyhow::anyhow!("ICE gathering closed"))?;
    let answer = serde_json::to_string(
        &recipient_peer
            .local_description()
            .await
            .ok_or_else(|| anyhow::anyhow!("missing answer"))?,
    )?;
    let transcript = format!(
        "operalibre-peer-proof-v1\n{ROOM}\n{GIFT}\n{expires}\n{generation}\n{}\n{digest}\n{resume_offset}\n{prefix}\n{challenge}\n{}\n{}",
        bytes.len(),
        hex(&Sha256::digest(description.as_bytes())),
        hex(&Sha256::digest(answer.as_bytes()))
    );
    let base_key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &key);
    let derived_key = ring::hmac::sign(&base_key, b"operalibre-peer-proof-key-v1");
    let tag = ring::hmac::sign(
        &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, derived_key.as_ref()),
        transcript.as_bytes(),
    );
    let mut proof = tag.as_ref().to_vec();
    if mode == LoopbackMode::Forged {
        proof[0] ^= 1;
    }
    send(
        2,
        "answer",
        serde_json::json!({"descriptionJson":answer,"proof":URL_SAFE_NO_PAD.encode(proof)})
            .to_string(),
    )
    .await?
    .error_for_status()?;
    if mode == LoopbackMode::Forged {
        let result = sender.await?;
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("peer proof authentication failed")
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(300), received_rx.recv())
                .await
                .is_err(),
            "forged proof received archive data"
        );
    } else {
        let mut staged = tempfile::tempfile()?;
        staged.write_all(&bytes[..resume_offset])?;
        let mut receiver = crate::share_transfer::Receiver::resume(
            staged,
            resume_offset as u64,
            bytes.len() as u64,
            Sha256::digest(&bytes).into(),
        )?;
        let mut frames = 0;
        loop {
            let frame =
                match tokio::time::timeout(std::time::Duration::from_secs(10), received_rx.recv())
                    .await
                {
                    Ok(Some(frame)) => frame,
                    Ok(None) => anyhow::bail!("data channel closed after {frames} frames"),
                    Err(_) if sender.is_finished() => anyhow::bail!(
                        "timed out after {frames} frames; sender result: {:?}",
                        sender.await?
                    ),
                    Err(_) => {
                        anyhow::bail!("timed out after {frames} frames; sender still running")
                    }
                };
            frames += 1;
            let (channel, is_text, frame) = frame;
            assert!(!is_text);
            let (asset, offset, final_chunk, data) = crate::share_transfer::decode_chunk(&frame)?;
            assert_eq!(asset, "archive");
            if final_chunk {
                assert_eq!(offset, bytes.len() as u64);
                assert!(data.is_empty());
                let mut verified = receiver.finish()?;
                verified.rewind()?;
                let mut actual = Vec::new();
                verified.read_to_end(&mut actual)?;
                assert_eq!(actual, bytes);
                if mode == LoopbackMode::Cancel {
                    stop.send(true)?;
                    break;
                }
                let receipt_digest = if mode == LoopbackMode::BadReceipt {
                    "0".repeat(64)
                } else {
                    digest.clone()
                };
                channel.send_text(&serde_json::json!({"type":"verified", "size":bytes.len(), "sha256":receipt_digest}).to_string()).await?;
                if mode == LoopbackMode::BadReceipt {
                    break;
                }
                let (_, is_text, confirmation) = received_rx
                    .recv()
                    .await
                    .ok_or_else(|| anyhow::anyhow!("missing receipt confirmation"))?;
                assert!(is_text);
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&confirmation)?,
                    serde_json::json!({"type":"receipt-confirmed", "size":bytes.len(), "sha256":digest})
                );
                if mode == LoopbackMode::CancelAfterConfirmation {
                    stop.send(true)?;
                    break;
                }
                if mode == LoopbackMode::RevokeAfterConfirmation {
                    state
                        .revoked
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    break;
                }
                channel.close().await?;
                break;
            }
            receiver.append(offset, data)?;
        }
        let result = sender.await?;
        match mode {
            LoopbackMode::Good | LoopbackMode::Resumed => result?,
            LoopbackMode::BadReceipt => assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("invalid verification receipt")
            ),
            LoopbackMode::Cancel
            | LoopbackMode::CancelAfterConfirmation
            | LoopbackMode::RevokeAfterConfirmation => {
                assert!(result.unwrap_err().to_string().contains("cancelled"))
            }
            LoopbackMode::Forged => unreachable!(),
        }
    }
    recipient_peer.close().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn authenticated_peer_resumes_verified_prefix_at_rotated_generation() -> anyhow::Result<()> {
    tokio::time::timeout(
        std::time::Duration::from_secs(45),
        authenticated_loopback(LoopbackMode::Resumed),
    )
    .await??;
    Ok(())
}

#[tokio::test]
async fn authenticated_peer_transfers_verified_known_bytes() -> anyhow::Result<()> {
    tokio::time::timeout(
        std::time::Duration::from_secs(45),
        authenticated_loopback(LoopbackMode::Good),
    )
    .await??;
    Ok(())
}

#[tokio::test]
async fn authenticated_peer_rejects_forged_proof_without_data() -> anyhow::Result<()> {
    tokio::time::timeout(
        std::time::Duration::from_secs(45),
        authenticated_loopback(LoopbackMode::Forged),
    )
    .await??;
    Ok(())
}

#[tokio::test]
async fn authenticated_peer_rejects_wrong_receipt() -> anyhow::Result<()> {
    tokio::time::timeout(
        std::time::Duration::from_secs(45),
        authenticated_loopback(LoopbackMode::BadReceipt),
    )
    .await??;
    Ok(())
}

#[tokio::test]
async fn authenticated_peer_cancels_while_waiting_for_receipt() -> anyhow::Result<()> {
    tokio::time::timeout(
        std::time::Duration::from_secs(45),
        authenticated_loopback(LoopbackMode::Cancel),
    )
    .await??;
    Ok(())
}

#[tokio::test]
async fn authenticated_peer_cancels_or_revokes_while_waiting_for_close() -> anyhow::Result<()> {
    tokio::time::timeout(
        std::time::Duration::from_secs(45),
        authenticated_loopback(LoopbackMode::CancelAfterConfirmation),
    )
    .await??;
    tokio::time::timeout(
        std::time::Duration::from_secs(45),
        authenticated_loopback(LoopbackMode::RevokeAfterConfirmation),
    )
    .await??;
    Ok(())
}

#[tokio::test]
async fn authenticated_sender_signs_ready_challenge_and_rejects_forged_answer() -> anyhow::Result<()>
{
    use axum::{
        Json, Router, extract::Path, http::StatusCode, response::IntoResponse, routing::post,
    };
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::Verifier;

    let (requests, mut seen) = tokio::sync::mpsc::unbounded_channel();
    let challenge = URL_SAFE_NO_PAD.encode([4_u8; 32]);
    let expected_challenge = challenge.clone();
    let app = Router::new().route("/{*path}", post(move |Path(path): Path<String>, Json(body): Json<serde_json::Value>| {
        let requests = requests.clone();
        let challenge = challenge.clone();
        async move {
            requests.send((path.clone(), body.clone())).unwrap();
            if path.starts_with("send/") { return StatusCode::NO_CONTENT.into_response(); }
            let signal = if body["after"] == 0 {
                serde_json::json!({"sequence": 1, "kind": "ready", "message": serde_json::json!({"challenge": challenge}).to_string()})
            } else {
                serde_json::json!({"sequence": 2, "kind": "answer", "message": serde_json::json!({"descriptionJson": "not JSON", "proof": URL_SAFE_NO_PAD.encode([0_u8; 32])}).to_string()})
            };
            Json(serde_json::json!([signal])).into_response()
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let broker = crate::share_broker::BrokerClient::local(&format!("http://{address}/"))?;
    let signing = ed25519_dalek::SigningKey::from_bytes(&[8; 32]);
    let verifying = signing.verifying_key();
    let (_stop, receiver) = tokio::sync::watch::channel(false);
    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs()
        + 60;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        crate::share_sender::run_authenticated_peer(
            broker,
            "room____________".into(),
            crate::share_broker::Capability {
                payload: "p".into(),
                signature: "s".into(),
            },
            0,
            tokio::fs::File::from_std(tempfile::tempfile()?),
            1,
            expires_at,
            crate::share_sender::PeerAuthentication {
                gift_id: "gift____________".into(),
                archive_sha256: "a".repeat(64),
                signing,
                preview_key: [7; 32],
            },
            receiver,
        ),
    )
    .await?;
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("peer proof authentication failed")
    );
    assert_eq!(seen.try_recv()?.1["after"], 0);
    let (path, body) = seen.try_recv()?;
    assert!(path.starts_with("send/"));
    assert_eq!(body["kind"], "offer");
    let envelope: serde_json::Value = serde_json::from_str(body["message"].as_str().unwrap())?;
    let payload = URL_SAFE_NO_PAD.decode(envelope["payload"].as_str().unwrap())?;
    let signature = ed25519_dalek::Signature::from_slice(
        &URL_SAFE_NO_PAD.decode(envelope["signature"].as_str().unwrap())?,
    )?;
    let mut signed = b"operalibre-gift-peer-offer-v1\0".to_vec();
    signed.extend_from_slice(&payload);
    verifying.verify(&signed, &signature)?;
    let offer: serde_json::Value = serde_json::from_slice(&payload)?;
    assert_eq!(offer["challenge"], expected_challenge);
    assert_eq!(offer["archiveSha256"], "a".repeat(64));
    assert_eq!(offer["offset"], 0);
    assert_eq!(seen.try_recv()?.1["after"], 1);
    assert!(seen.try_recv().is_err());
    server.abort();
    Ok(())
}

#[tokio::test]
async fn producer_peer_uses_requested_generation_for_offer_and_answer_poll() -> anyhow::Result<()> {
    use axum::{Json, Router, extract::Path, http::StatusCode, routing::post};
    let (requests, mut seen) = tokio::sync::mpsc::unbounded_channel();
    let app = Router::new().route(
        "/{*path}",
        post(
            move |Path(path): Path<String>, Json(body): Json<serde_json::Value>| {
                let requests = requests.clone();
                async move {
                    requests.send((path.clone(), body)).unwrap();
                    if path.starts_with("send/") {
                        StatusCode::NO_CONTENT
                    } else {
                        StatusCode::FORBIDDEN
                    }
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let broker = crate::share_broker::BrokerClient::local(&format!("http://{address}/"))?;
    let cap = crate::share_broker::Capability {
        payload: "p".into(),
        signature: "s".into(),
    };
    for generation in [0, 3] {
        let (_stop, receiver) = tokio::sync::watch::channel(false);
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            crate::share_sender::run_peer_generation(
                broker.clone(),
                "room____________".into(),
                cap.clone(),
                generation,
                tokio::fs::File::from_std(tempfile::tempfile()?),
                0,
                0,
                u64::MAX,
                receiver,
            ),
        )
        .await?;
        assert!(result.is_err());
        for action in ["send/", "poll/"] {
            let (path, body) = seen.try_recv()?;
            assert!(path.starts_with(action));
            if generation == 0 {
                assert!(body.get("generation").is_none());
            } else {
                assert_eq!(body["generation"], generation);
            }
        }
    }
    let (_stop, receiver) = tokio::sync::watch::channel(false);
    assert!(
        crate::share_sender::run_peer_generation(
            broker,
            "room____________".into(),
            cap,
            crate::share_broker::MAX_GENERATION + 1,
            tokio::fs::File::from_std(tempfile::tempfile()?),
            0,
            0,
            u64::MAX,
            receiver
        )
        .await
        .is_err()
    );
    assert!(seen.try_recv().is_err());
    server.abort();
    Ok(())
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.gathered.try_send(());
        }
    }
    async fn on_data_channel(&self, channel: Arc<dyn DataChannel>) {
        if let Some(sender) = self.received.clone() {
            self.runtime.spawn(Box::pin(async move {
                while let Some(event) = channel.poll().await {
                    if let DataChannelEvent::OnMessage(message) = event {
                        if sender.send(message.data.to_vec()).await.is_err() {
                            break;
                        }
                    }
                }
            }));
        }
    }
}

pub(crate) async fn transfer_round(
    bytes: &[u8],
    start: usize,
    end: usize,
    receiver: &mut crate::share_transfer::Receiver<std::fs::File>,
    revoke_after_first: bool,
    deny_before_send: bool,
) -> anyhow::Result<()> {
    use axum::{Json, Router, extract::Path, http::StatusCode, routing::post};
    let signals = Arc::new(tokio::sync::Mutex::new((String::new(), String::new())));
    let revoked = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let app = Router::new().route("/{*path}", post({ let signals = signals.clone(); let revoked = revoked.clone(); move |Path(path): Path<String>, Json(body): Json<serde_json::Value>| { let signals = signals.clone(); let revoked = revoked.clone(); async move {
        let mut signals = signals.lock().await;
        if path == "issue" { return (StatusCode::OK, Json(serde_json::json!({"payload":"producer", "signature":"test"}))); }
        if path.starts_with("claim/") { return (StatusCode::OK, Json(serde_json::json!({}))); }
        if path.starts_with("send/") { signals.0 = body["message"].as_str().unwrap_or_default().into(); return (StatusCode::OK, Json(serde_json::json!({}))); }
        if path == "recipient-answer" { signals.1 = body["message"].as_str().unwrap_or_default().into(); return (StatusCode::OK, Json(serde_json::json!({}))); }
        if path.starts_with("poll/") { if revoked.load(std::sync::atomic::Ordering::SeqCst) { return (StatusCode::FORBIDDEN, Json(serde_json::json!({}))); } return (StatusCode::OK, Json(serde_json::json!([{"sequence":1,"kind":"answer","message":signals.1}]))); }
        (StatusCode::NOT_FOUND, Json(serde_json::json!({})))
    } }}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let broker = crate::share_broker::BrokerClient::local(&format!("http://{address}/"))?;
    let room = "loopback________";
    let capability = broker.issue("owner", room, "producer________", 99).await?;
    broker.claim(room, &capability).await?;
    let runtime = default_runtime().expect("tokio WebRTC runtime");
    let (a_tx, mut a_rx) = tokio::sync::mpsc::channel(1);
    let (b_tx, mut b_rx) = tokio::sync::mpsc::channel(1);
    let (received_tx, mut received_rx) = tokio::sync::mpsc::channel(1);
    let a = peer(
        runtime.clone(),
        Handler {
            gathered: a_tx,
            received: None,
            runtime: runtime.clone(),
        },
    )
    .await?;
    let b = peer(
        runtime.clone(),
        Handler {
            gathered: b_tx,
            received: Some(received_tx),
            runtime,
        },
    )
    .await?;
    let channel = a.create_data_channel("gift", None).await?;
    a.set_local_description(a.create_offer(None).await?).await?;
    a_rx.recv()
        .await
        .ok_or_else(|| anyhow::anyhow!("offer ICE closed"))?;
    let offer = serde_json::to_string(
        &a.local_description()
            .await
            .ok_or_else(|| anyhow::anyhow!("missing offer"))?,
    )?;
    broker.send(room, &capability, 1, "offer", &offer).await?;
    let offer = signals.lock().await.0.clone();
    b.set_remote_description(serde_json::from_str(&offer)?)
        .await?;
    b.set_local_description(b.create_answer(None).await?)
        .await?;
    b_rx.recv()
        .await
        .ok_or_else(|| anyhow::anyhow!("answer ICE closed"))?;
    let answer = serde_json::to_string(
        &b.local_description()
            .await
            .ok_or_else(|| anyhow::anyhow!("missing answer"))?,
    )?;
    crate::http_client_builder()
        .build()?
        .post(format!("http://{address}/recipient-answer"))
        .json(&serde_json::json!({"message":answer}))
        .send()
        .await?
        .error_for_status()?;
    let signals = broker.poll(room, &capability, 0).await?;
    a.set_remote_description(serde_json::from_str(&signals[0].message)?)
        .await?;
    loop {
        match channel.poll().await {
            Some(DataChannelEvent::OnOpen) => break,
            Some(DataChannelEvent::OnClose) | None => anyhow::bail!("channel closed"),
            _ => {}
        }
    }
    if end == bytes.len() {
        if deny_before_send {
            revoked.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        use std::io::Write;
        let mut source = tempfile::tempfile()?;
        source.write_all(bytes)?;
        let file = tokio::fs::File::from_std(source);
        let sender_channel = channel.clone();
        let length = bytes.len() as u64;
        let expires = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs()
            + 60;
        let watch_broker = broker.clone();
        let watch_capability = capability.clone();
        let sender = tokio::spawn(async move {
            crate::share_sender::send_with_broker_watch(
                &watch_broker,
                room,
                &watch_capability,
                &*sender_channel,
                file,
                "archive",
                length,
                start as u64,
                expires,
                std::time::Duration::from_millis(10),
            )
            .await
        });
        if deny_before_send {
            let result = tokio::time::timeout(std::time::Duration::from_secs(5), sender).await??;
            anyhow::ensure!(result.is_err(), "sender ignored initial denial");
            anyhow::ensure!(
                tokio::time::timeout(std::time::Duration::from_millis(300), received_rx.recv())
                    .await
                    .is_err(),
                "frame sent before authorization"
            );
            a.close().await?;
            b.close().await?;
            server.abort();
            return Ok(());
        }
        loop {
            let frame = received_rx
                .recv()
                .await
                .ok_or_else(|| anyhow::anyhow!("receiver closed"))?;
            let (asset_id, offset, final_chunk, data) =
                crate::share_transfer::decode_chunk(&frame)?;
            anyhow::ensure!(asset_id == "archive", "unexpected asset");
            if final_chunk {
                anyhow::ensure!(offset == length && data.is_empty(), "invalid final frame");
                break;
            }
            receiver.append(offset, data)?;
            if revoke_after_first {
                revoked.store(true, std::sync::atomic::Ordering::SeqCst);
                let result =
                    tokio::time::timeout(std::time::Duration::from_secs(5), sender).await??;
                anyhow::ensure!(result.is_err(), "sender completed after broker revocation");
                a.close().await?;
                b.close().await?;
                server.abort();
                return Ok(());
            }
        }
        sender.await??;
    } else {
        for offset in (start..end).step_by(16 * 1024) {
            let until = (offset + 16 * 1024).min(end);
            let encoded = crate::share_transfer::encode_chunk(
                "archive",
                offset as u64,
                false,
                &bytes[offset..until],
            )?;
            channel
                .send(bytes::BytesMut::from(encoded.as_slice()))
                .await?;
            let frame = received_rx
                .recv()
                .await
                .ok_or_else(|| anyhow::anyhow!("receiver closed"))?;
            let (asset_id, offset, final_chunk, data) =
                crate::share_transfer::decode_chunk(&frame)?;
            anyhow::ensure!(asset_id == "archive" && !final_chunk, "unexpected frame");
            receiver.append(offset, data)?;
        }
    }
    a.close().await?;
    b.close().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn selected_archive_resumes_over_local_webrtc_and_checks_digest() -> anyhow::Result<()> {
    use crate::share::{
        ShareAssetKind, TrustedShareFile, plan_selected_assets, write_selected_archive,
    };
    use sha2::{Digest, Sha256};
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        let root = tempfile::tempdir()?;
        let ebook = root.path().join("book.epub");
        let audio = root.path().join("book.m4b");
        std::fs::write(&ebook, vec![42_u8; 150_000])?;
        std::fs::write(&audio, b"unselected audio")?;
        let candidates = vec![
            TrustedShareFile {
                id: "ebook".into(),
                kind: ShareAssetKind::Ebook,
                file_name: "book.epub".into(),
                path: ebook,
                size_bytes: 150_000,
            },
            TrustedShareFile {
                id: "audio".into(),
                kind: ShareAssetKind::Audio,
                file_name: "book.m4b".into(),
                path: audio,
                size_bytes: 16,
            },
        ];
        let planned =
            plan_selected_assets(&candidates, &["ebook".into()], &[root.path()], 200_000)?;
        let archive = root.path().join("selected.zip");
        write_selected_archive(&archive, &planned, &[root.path()])?;
        let source = std::fs::read(&archive)?;
        let digest = Sha256::digest(&source).into();
        let stage = tempfile::tempfile()?;
        let mut receiver =
            crate::share_transfer::Receiver::resume(stage, 0, source.len() as u64, digest)?;
        let split = 32 * 1024;
        transfer_round(&source, 0, split, &mut receiver, false, false).await?;
        let stage = receiver.interrupt();
        let mut receiver = crate::share_transfer::Receiver::resume(
            stage,
            split as u64,
            source.len() as u64,
            digest,
        )?;
        transfer_round(&source, split, source.len(), &mut receiver, false, false).await?;
        let verified = receiver.finish()?;
        let mut zip = zip::ZipArchive::new(verified)?;
        assert_eq!(zip.len(), 1);
        assert!(zip.by_name("book.epub").is_ok());
        assert!(zip.by_name("book.m4b").is_err());
        Ok::<(), anyhow::Error>(())
    })
    .await??;
    Ok(())
}

#[tokio::test]
async fn revoked_transfer_cannot_finalize() -> anyhow::Result<()> {
    use sha2::{Digest, Sha256};
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let bytes = vec![42_u8; 8 * 1024 * 1024];
        let digest = Sha256::digest(&bytes).into();
        let mut receiver = crate::share_transfer::Receiver::resume(
            tempfile::tempfile()?,
            0,
            bytes.len() as u64,
            digest,
        )?;
        transfer_round(&bytes, 0, bytes.len(), &mut receiver, true, false).await?;
        assert!(
            receiver.finish().is_err(),
            "partial archive must not finalize"
        );
        Ok::<(), anyhow::Error>(())
    })
    .await??;
    Ok(())
}

#[tokio::test]
async fn denied_initial_authorization_sends_no_archive_frames() -> anyhow::Result<()> {
    use sha2::{Digest, Sha256};
    let bytes = vec![7_u8; 64];
    let digest = Sha256::digest(&bytes).into();
    let mut receiver = crate::share_transfer::Receiver::resume(
        tempfile::tempfile()?,
        0,
        bytes.len() as u64,
        digest,
    )?;
    tokio::time::timeout(
        std::time::Duration::from_secs(20),
        transfer_round(&bytes, 0, bytes.len(), &mut receiver, false, true),
    )
    .await??;
    assert!(receiver.finish().is_err());
    Ok(())
}

async fn peer(
    runtime: Arc<dyn Runtime>,
    handler: impl PeerConnectionEventHandler + 'static,
) -> anyhow::Result<Arc<dyn PeerConnection>> {
    let mut media = MediaEngine::default();
    media.register_default_codecs()?;
    let registry = register_default_interceptors(Registry::new(), &mut media)?;
    let peer = PeerConnectionBuilder::new()
        .with_configuration(RTCConfigurationBuilder::new().build())
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .with_runtime(runtime)
        .with_handler(Arc::new(handler))
        .with_udp_addrs(vec!["127.0.0.1:0".to_string()])
        .with_data_channel_send_buffer_limit(256 * 1024)
        .build()
        .await?;
    Ok(Arc::new(peer))
}

#[tokio::test]
async fn host_ice_transfers_data_between_two_local_peers() -> anyhow::Result<()> {
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let runtime = default_runtime().expect("tokio WebRTC runtime");
        let (a_tx, mut a_rx) = tokio::sync::mpsc::channel(1);
        let (b_tx, mut b_rx) = tokio::sync::mpsc::channel(1);
        let (received_tx, mut received_rx) = tokio::sync::mpsc::channel(1);
        let a = peer(
            runtime.clone(),
            Handler {
                gathered: a_tx,
                received: None,
                runtime: runtime.clone(),
            },
        )
        .await?;
        let b = peer(
            runtime.clone(),
            Handler {
                gathered: b_tx,
                received: Some(received_tx),
                runtime,
            },
        )
        .await?;
        let channel = a.create_data_channel("gift", None).await?;
        let offer = a.create_offer(None).await?;
        a.set_local_description(offer).await?;
        a_rx.recv()
            .await
            .ok_or_else(|| anyhow::anyhow!("offer ICE gathering closed"))?;
        b.set_remote_description(
            a.local_description()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing offer"))?,
        )
        .await?;
        let answer = b.create_answer(None).await?;
        b.set_local_description(answer).await?;
        b_rx.recv()
            .await
            .ok_or_else(|| anyhow::anyhow!("answer ICE gathering closed"))?;
        a.set_remote_description(
            b.local_description()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing answer"))?,
        )
        .await?;
        loop {
            match channel.poll().await {
                Some(DataChannelEvent::OnOpen) => break,
                Some(DataChannelEvent::OnClose) | None => {
                    anyhow::bail!("channel closed before opening")
                }
                _ => {}
            }
        }
        channel
            .send(bytes::BytesMut::from(&b"OperaLibre loopback"[..]))
            .await?;
        assert_eq!(
            received_rx.recv().await.as_deref(),
            Some(&b"OperaLibre loopback"[..])
        );
        a.close().await?;
        b.close().await?;
        Ok::<(), anyhow::Error>(())
    })
    .await??;
    Ok(())
}
