use super::*;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use tokio::sync::{mpsc, watch};

fn expires_in(seconds: u64) -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + seconds
}

async fn archive() -> anyhow::Result<tokio::fs::File> {
    use std::io::Write;
    let mut file = tempfile::tempfile()?;
    file.write_all(b"trusted archive")?; // Deliberately leave the shared cursor at EOF.
    Ok(tokio::fs::File::from_std(file))
}

struct Active(Arc<AtomicUsize>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn sender_reconnect_waits_for_old_reader_and_rewinds_shared_cursor() -> anyhow::Result<()> {
    let current = Arc::new(AtomicU64::new(0));
    let release_cleanup = Arc::new(tokio::sync::Notify::new());
    let active = Arc::new(AtomicUsize::new(0));
    let (events, mut received) = mpsc::unbounded_channel();
    let (_stop, stopped) = watch::channel(false);
    let file = archive().await?;
    let task = tokio::spawn(supervise_sender(
        file,
        expires_in(90),
        stopped,
        {
            let current = current.clone();
            move || std::future::ready(Ok(current.load(Ordering::SeqCst)))
        },
        {
            let active = active.clone();
            let release = release_cleanup.clone();
            move |generation, mut file, mut stopped| {
                let active = active.clone();
                let events = events.clone();
                let release = release.clone();
                async move {
                    assert_eq!(active.fetch_add(1, Ordering::SeqCst), 0);
                    let _active = Active(active);
                    let mut bytes = Vec::new();
                    file.read_to_end(&mut bytes).await?;
                    assert_eq!(bytes, b"trusted archive");
                    events.send((generation, false))?;
                    if generation == 0 {
                        stopped.changed().await?;
                        assert!(*stopped.borrow());
                        events.send((generation, true))?;
                        release.notified().await;
                        anyhow::bail!("old peer cancelled")
                    }
                    Ok(())
                }
            }
        },
    ));
    assert_eq!(received.recv().await, Some((0, false)));
    current.store(1, Ordering::SeqCst);
    assert_eq!(received.recv().await, Some((0, true)));
    // Cancellation has reached the old peer but it still owns the cursor.
    assert_eq!(active.load(Ordering::SeqCst), 1);
    assert!(received.try_recv().is_err());
    release_cleanup.notify_one();
    assert_eq!(received.recv().await, Some((1, false)));
    task.await??;
    assert_eq!(active.load(Ordering::SeqCst), 0);
    Ok(())
}

#[tokio::test]
async fn sender_reconnect_never_retries_failed_generation_and_terminates_on_success()
-> anyhow::Result<()> {
    let (events, mut received) = mpsc::unbounded_channel();
    let current = Arc::new(AtomicU64::new(0));
    let polls = Arc::new(AtomicUsize::new(0));
    let notify = Arc::new(tokio::sync::Notify::new());
    let (_stop, stopped) = watch::channel(false);
    let task = tokio::spawn(supervise_sender(
        archive().await?,
        expires_in(90),
        stopped,
        {
            let current = current.clone();
            let polls = polls.clone();
            let notify = notify.clone();
            move || {
                polls.fetch_add(1, Ordering::SeqCst);
                notify.notify_one();
                std::future::ready(Ok(current.load(Ordering::SeqCst)))
            }
        },
        move |generation, _file, _stopped| {
            events.send(generation).unwrap();
            std::future::ready(if generation == 0 {
                Err(anyhow::anyhow!("connection lost"))
            } else {
                Ok(())
            })
        },
    ));
    assert_eq!(received.recv().await, Some(0));
    let initial = polls.load(Ordering::SeqCst);
    while polls.load(Ordering::SeqCst) <= initial + 1 {
        notify.notified().await;
    }
    assert!(received.try_recv().is_err());
    current.store(4, Ordering::SeqCst); // Skipped generations are not replayed either.
    assert_eq!(received.recv().await, Some(4));
    task.await??;
    Ok(())
}

#[tokio::test]
async fn sender_reconnect_fails_closed_on_revocation_and_generation_rollback() -> anyhow::Result<()>
{
    for revoked in [false, true] {
        let unavailable = Arc::new(AtomicBool::new(false));
        let (events, mut received) = mpsc::unbounded_channel();
        let (_stop, stopped) = watch::channel(false);
        let task = tokio::spawn(supervise_sender(
            archive().await?,
            expires_in(90),
            stopped,
            {
                let unavailable = unavailable.clone();
                move || {
                    std::future::ready(if unavailable.load(Ordering::SeqCst) {
                        if revoked {
                            Err(anyhow::anyhow!("broker rejected active claim"))
                        } else {
                            Ok(1)
                        }
                    } else {
                        Ok(2)
                    })
                }
            },
            move |generation, _file, mut stopped| {
                let events = events.clone();
                async move {
                    events.send((generation, false))?;
                    stopped.changed().await?;
                    events.send((generation, *stopped.borrow()))?;
                    anyhow::bail!("cancelled")
                }
            },
        ));
        assert_eq!(received.recv().await, Some((2, false)));
        unavailable.store(true, Ordering::SeqCst);
        assert_eq!(received.recv().await, Some((2, true)));
        let error = task.await?.unwrap_err().to_string();
        assert!(error.contains(if revoked {
            "rejected active claim"
        } else {
            "moved backwards"
        }));
        assert!(received.recv().await.is_none());
    }
    Ok(())
}

#[tokio::test]
async fn sender_serves_initial_generation_and_all_sixteen_recipient_rotations() -> anyhow::Result<()>
{
    let current = Arc::new(AtomicU64::new(0));
    let attempts = Arc::new(AtomicUsize::new(0));
    let (_stop, stopped) = watch::channel(false);
    supervise_sender(
        archive().await?,
        expires_in(90),
        stopped,
        {
            let current = current.clone();
            move || std::future::ready(Ok(current.load(Ordering::SeqCst)))
        },
        {
            let attempts = attempts.clone();
            move |generation, _file, _stopped| {
                attempts.fetch_add(1, Ordering::SeqCst);
                if generation == 16 {
                    std::future::ready(Ok(()))
                } else {
                    current.store(generation + 1, Ordering::SeqCst);
                    std::future::ready(Err(anyhow::anyhow!("interrupted")))
                }
            }
        },
    )
    .await?;
    assert_eq!(attempts.load(Ordering::SeqCst), 17);
    Ok(())
}

#[tokio::test]
async fn sender_reconnect_has_a_hard_attempt_limit() -> anyhow::Result<()> {
    let current = Arc::new(AtomicU64::new(0));
    let attempts = Arc::new(AtomicUsize::new(0));
    let (_stop, stopped) = watch::channel(false);
    let result = supervise_sender(
        archive().await?,
        expires_in(90),
        stopped,
        {
            let current = current.clone();
            move || std::future::ready(Ok(current.load(Ordering::SeqCst)))
        },
        {
            let current = current.clone();
            let attempts = attempts.clone();
            move |generation, _file, _stopped| {
                attempts.fetch_add(1, Ordering::SeqCst);
                current.store(generation + 1, Ordering::SeqCst);
                std::future::ready(Err(anyhow::anyhow!("interrupted")))
            }
        },
    )
    .await;
    assert!(result.unwrap_err().to_string().contains("attempt limit"));
    assert_eq!(attempts.load(Ordering::SeqCst), MAX_PEER_ATTEMPTS);
    Ok(())
}

#[tokio::test]
async fn sender_reconnect_stops_before_start_when_cancelled_or_expired() -> anyhow::Result<()> {
    for dropped in [false, true] {
        let (stop, stopped) = watch::channel(false);
        if !dropped {
            stop.send(true)?;
        }
        drop(stop);
        let result = supervise_sender(
            archive().await?,
            expires_in(90),
            stopped,
            || std::future::ready(Ok(0)),
            |_, _, _| {
                panic!("cancelled sender must not start");
                #[allow(unreachable_code)]
                std::future::ready(Ok(()))
            },
        )
        .await;
        assert!(result.unwrap_err().to_string().contains("cancelled"));
    }
    let (_stop, stopped) = watch::channel(false);
    let result = supervise_sender(
        archive().await?,
        expires_in(0),
        stopped,
        || std::future::ready(Ok(0)),
        |_, _, _| {
            panic!("expired sender must not start");
            #[allow(unreachable_code)]
            std::future::ready(Ok(()))
        },
    )
    .await;
    assert!(result.unwrap_err().to_string().contains("expired"));
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn sender_reconnect_expiry_cancels_active_attempt() -> anyhow::Result<()> {
    let (_stop, stopped) = watch::channel(false);
    let result = supervise_sender(
        archive().await?,
        expires_in(2),
        stopped,
        || std::future::ready(Ok(0)),
        |_, _, mut stopped| async move {
            stopped.changed().await?;
            anyhow::ensure!(*stopped.borrow(), "missing cancellation");
            anyhow::bail!("cancelled")
        },
    )
    .await;
    assert!(result.unwrap_err().to_string().contains("expired"));
    Ok(())
}

#[tokio::test]
async fn sender_reconnect_stop_cancels_active_peer_and_blocked_session_lookup() -> anyhow::Result<()>
{
    let (stop, stopped) = watch::channel(false);
    let (entered, mut received) = mpsc::unbounded_channel();
    let task = tokio::spawn(supervise_sender(
        archive().await?,
        expires_in(90),
        stopped,
        || std::future::ready(Ok(0)),
        move |_, _file, mut stopped| {
            let entered = entered.clone();
            async move {
                entered.send(false)?;
                stopped.changed().await?;
                entered.send(*stopped.borrow())?;
                anyhow::bail!("cancelled")
            }
        },
    ));
    assert_eq!(received.recv().await, Some(false));
    stop.send(true)?;
    assert_eq!(received.recv().await, Some(true));
    assert!(task.await?.unwrap_err().to_string().contains("cancelled"));

    let (stop, stopped) = watch::channel(false);
    let (entered, waiting) = tokio::sync::oneshot::channel();
    let mut entered = Some(entered);
    let task = tokio::spawn(supervise_sender(
        archive().await?,
        expires_in(90),
        stopped,
        move || {
            if let Some(entered) = entered.take() {
                let _ = entered.send(());
            }
            std::future::pending::<anyhow::Result<u64>>()
        },
        |_, _, _| std::future::ready(Err(anyhow::anyhow!("must not start"))),
    ));
    waiting.await?;
    stop.send(true)?;
    assert!(task.await?.unwrap_err().to_string().contains("cancelled"));
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn sender_reconnect_never_reuses_reader_if_cleanup_hangs() -> anyhow::Result<()> {
    let current = Arc::new(AtomicU64::new(0));
    let attempts = Arc::new(AtomicUsize::new(0));
    let (_stop, stopped) = watch::channel(false);
    let result = supervise_sender(
        archive().await?,
        expires_in(90),
        stopped,
        {
            let current = current.clone();
            move || std::future::ready(Ok(current.load(Ordering::SeqCst)))
        },
        {
            let attempts = attempts.clone();
            move |_, _file, _stopped| {
                attempts.fetch_add(1, Ordering::SeqCst);
                current.store(1, Ordering::SeqCst);
                std::future::pending::<anyhow::Result<()>>()
            }
        },
    )
    .await;
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("cleanup timed out")
    );
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    Ok(())
}

#[derive(Default)]
struct BrokerState {
    generation: u64,
    queues: [Vec<serde_json::Value>; 2],
    producer_sessions: Vec<u64>,
}

struct ReceivingPeer {
    gathered: mpsc::Sender<()>,
    frames: mpsc::Sender<(Arc<dyn DataChannel>, bool, Vec<u8>)>,
    runtime: Arc<dyn webrtc::runtime::Runtime>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for ReceivingPeer {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.gathered.try_send(());
        }
    }
    async fn on_data_channel(&self, channel: Arc<dyn DataChannel>) {
        let frames = self.frames.clone();
        self.runtime.spawn(Box::pin(async move {
            while let Some(event) = channel.poll().await {
                if let webrtc::data_channel::DataChannelEvent::OnMessage(message) = event
                    && frames
                        .send((channel.clone(), message.is_string, message.data.to_vec()))
                        .await
                        .is_err()
                {
                    break;
                }
            }
        }));
    }
}

struct AbortTask<T>(tokio::task::JoinHandle<T>);
impl<T> Drop for AbortTask<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Real host-ICE peers and the actual sender/BrokerClient adapters, with an
/// authenticated HTTP broker fixture (not a deployed Cloudflare Durable Object).
async fn reconnect_loopback(verification_delay: std::time::Duration) -> anyhow::Result<()> {
    use axum::{
        Json, Router, extract::Path, http::StatusCode, response::IntoResponse, routing::post,
    };
    use ed25519_dalek::Verifier;
    use sha2::{Digest, Sha256};
    use std::io::Write;

    const ROOM: &str = "room____________";
    const GIFT: &str = "gift____________";
    let state = Arc::new(tokio::sync::Mutex::new(BrokerState::default()));
    let changed = Arc::new(tokio::sync::Notify::new());
    let app = Router::new()
        .route(
            "/{action}/{room}",
            post({
                let state = state.clone();
                let changed = changed.clone();
                move |Path((action, room)): Path<(String, String)>,
                      Json(body): Json<serde_json::Value>| {
                    let state = state.clone();
                    let changed = changed.clone();
                    async move {
                        if room != ROOM {
                            return StatusCode::FORBIDDEN.into_response();
                        }
                        let mut state = state.lock().await;
                        let role = match (body["payload"].as_str(), body["signature"].as_str()) {
                            (Some("producer"), Some("producer-secret")) => 0,
                            (Some("recipient0"), Some("recipient-secret"))
                                if state.generation == 0 =>
                            {
                                1
                            }
                            (Some("recipient1"), Some("recipient-secret"))
                                if state.generation == 1 =>
                            {
                                1
                            }
                            _ => return StatusCode::FORBIDDEN.into_response(),
                        };
                        if action == "session" {
                            let generation = state.generation;
                            if role == 0 {
                                state.producer_sessions.push(generation);
                            }
                            return Json(serde_json::json!({"generation":generation}))
                                .into_response();
                        }
                        if body
                            .get("generation")
                            .and_then(|value| value.as_u64())
                            .unwrap_or(0)
                            != state.generation
                        {
                            return StatusCode::CONFLICT.into_response();
                        }
                        if action == "poll" {
                            let Some(after) = body["after"].as_u64().filter(|after| *after <= 32)
                            else {
                                return StatusCode::BAD_REQUEST.into_response();
                            };
                            return Json(
                                state.queues[1 - role]
                                    .iter()
                                    .filter(|item| item["sequence"].as_u64().unwrap() > after)
                                    .cloned()
                                    .collect::<Vec<_>>(),
                            )
                            .into_response();
                        }
                        if action != "send" {
                            return StatusCode::NOT_FOUND.into_response();
                        }
                        let (Some(sequence), Some(kind), Some(message)) = (
                            body["sequence"].as_u64(),
                            body["kind"].as_str(),
                            body["message"].as_str(),
                        ) else {
                            return StatusCode::BAD_REQUEST.into_response();
                        };
                        if message.len() > 7168
                            || !matches!(
                                (role, sequence, kind),
                                (0, 1, "offer") | (1, 1, "ready") | (1, 2, "answer")
                            )
                        {
                            return StatusCode::BAD_REQUEST.into_response();
                        }
                        if sequence as usize != state.queues[role].len() + 1 {
                            return StatusCode::CONFLICT.into_response();
                        }
                        state.queues[role].push(
                            serde_json::json!({"sequence":sequence,"kind":kind,"message":message}),
                        );
                        changed.notify_one();
                        StatusCode::NO_CONTENT.into_response()
                    }
                }
            }),
        )
        .layer(axum::extract::DefaultBodyLimit::max(8192));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let _server = AbortTask(tokio::spawn(
        async move { axum::serve(listener, app).await },
    ));
    let broker = crate::share_broker::BrokerClient::local(&format!("http://{address}/"))?;
    let client = crate::http_client_builder().build()?;
    let bytes: Vec<u8> = (0..CHUNK * 12 + 31).map(|n| (n % 251) as u8).collect();
    let hex = |value: &[u8]| {
        value
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    let digest = hex(&Sha256::digest(&bytes));
    let signing = ed25519_dalek::SigningKey::from_bytes(&rand::random());
    let verifying = signing.verifying_key();
    let preview_key = rand::random::<[u8; 32]>();
    let expires = expires_in(90);
    let mut source = tempfile::tempfile()?;
    source.write_all(&bytes)?; // The supervisor, not this fixture, must rewind it.
    let (_stop, stopped) = watch::channel(false);
    let mut sender = AbortTask(tokio::spawn(run_authenticated_sender(
        broker,
        ROOM.into(),
        crate::share_broker::Capability {
            payload: "producer".into(),
            signature: "producer-secret".into(),
        },
        tokio::fs::File::from_std(source),
        bytes.len() as u64,
        expires,
        PeerAuthentication {
            gift_id: GIFT.into(),
            archive_sha256: digest.clone(),
            signing,
            preview_key,
        },
        stopped,
    )));
    let mut staged = Vec::new();
    for generation in 0..=1_u64 {
        if generation == 1 {
            let mut state = state.lock().await;
            // Same transition as a successful recipient /resume: preserve the
            // producer capability, rotate recipient, increment and clear queues.
            state.generation = 1;
            state.queues = [Vec::new(), Vec::new()];
        }
        let capability = serde_json::json!({"payload":format!("recipient{generation}"),"signature":"recipient-secret","generation":generation});
        let challenge = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
        let offset = staged.len();
        let prefix = hex(&Sha256::digest(&staged));
        let mut ready = serde_json::json!({"challenge":challenge});
        if offset > 0 {
            ready["resume"] = serde_json::json!({"offset":offset,"prefixSha256":prefix});
        }
        let mut body = capability.clone();
        body["sequence"] = 1.into();
        body["kind"] = "ready".into();
        body["message"] = ready.to_string().into();
        client
            .post(format!("http://{address}/send/{ROOM}"))
            .json(&body)
            .send()
            .await?
            .error_for_status()?;
        let offer = loop {
            let notified = changed.notified();
            let mut body = capability.clone();
            body["after"] = 0.into();
            let signals: Vec<serde_json::Value> = client
                .post(format!("http://{address}/poll/{ROOM}"))
                .json(&body)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            if let Some(signal) = signals.first() {
                let envelope: serde_json::Value =
                    serde_json::from_str(signal["message"].as_str().unwrap())?;
                let payload = URL_SAFE_NO_PAD.decode(envelope["payload"].as_str().unwrap())?;
                let signature = ed25519_dalek::Signature::from_slice(
                    &URL_SAFE_NO_PAD.decode(envelope["signature"].as_str().unwrap())?,
                )?;
                let mut signed = b"operalibre-gift-peer-offer-v1\0".to_vec();
                signed.extend_from_slice(&payload);
                verifying.verify(&signed, &signature)?;
                break serde_json::from_slice::<serde_json::Value>(&payload)?;
            }
            notified.await;
        };
        assert_eq!(offer["generation"], generation);
        assert_eq!(offer["offset"], offset);
        assert_eq!(offer["prefixSha256"], prefix);
        assert_eq!(offer["challenge"], challenge);
        assert_eq!(offer["archiveSha256"], digest);
        let description = offer["offer"].as_str().unwrap();
        let runtime = webrtc::runtime::default_runtime().unwrap();
        let mut media = MediaEngine::default();
        media.register_default_codecs()?;
        let registry = register_default_interceptors(Registry::new(), &mut media)?;
        let (gathered, mut gathered_rx) = mpsc::channel(1);
        let (frames, mut frames_rx) = mpsc::channel(16);
        let peer = PeerConnectionBuilder::new()
            .with_configuration(RTCConfigurationBuilder::new().build())
            .with_media_engine(media)
            .with_interceptor_registry(registry)
            .with_runtime(runtime.clone())
            .with_handler(Arc::new(ReceivingPeer {
                gathered,
                frames,
                runtime,
            }))
            .with_udp_addrs(vec!["0.0.0.0:0".to_string()])
            .build()
            .await?;
        peer.set_remote_description(serde_json::from_str(description)?)
            .await?;
        peer.set_local_description(peer.create_answer(None).await?)
            .await?;
        gathered_rx
            .recv()
            .await
            .ok_or_else(|| anyhow::anyhow!("gathering closed"))?;
        let answer = serde_json::to_string(&peer.local_description().await.unwrap())?;
        let transcript = format!(
            "operalibre-peer-proof-v1\n{ROOM}\n{GIFT}\n{expires}\n{generation}\n{}\n{digest}\n{offset}\n{prefix}\n{challenge}\n{}\n{}",
            bytes.len(),
            hex(&Sha256::digest(description.as_bytes())),
            hex(&Sha256::digest(answer.as_bytes()))
        );
        let derived = ring::hmac::sign(
            &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, &preview_key),
            b"operalibre-peer-proof-key-v1",
        );
        let proof = ring::hmac::sign(
            &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, derived.as_ref()),
            transcript.as_bytes(),
        );
        let mut body = capability.clone();
        body["sequence"] = 2.into();
        body["kind"] = "answer".into();
        body["message"]=serde_json::json!({"descriptionJson":answer,"proof":URL_SAFE_NO_PAD.encode(proof.as_ref())}).to_string().into();
        client
            .post(format!("http://{address}/send/{ROOM}"))
            .json(&body)
            .send()
            .await?
            .error_for_status()?;
        loop {
            let (channel, is_text, frame) = frames_rx
                .recv()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing archive chunk"))?;
            assert!(!is_text);
            let (asset, position, final_chunk, data) = crate::share_transfer::decode_chunk(&frame)?;
            assert_eq!(asset, "archive");
            assert_eq!(position, staged.len() as u64);
            if final_chunk {
                assert_eq!(generation, 1);
                assert!(data.is_empty());
                assert_eq!(staged, bytes);
                // Model a slow integrity pass; this does not measure mobile
                // hashing or demonstrate support for a real 25 GiB transfer.
                tokio::time::sleep(verification_delay).await;
                channel
                    .send_text(
                        &serde_json::json!({"type":"verified","size":bytes.len(),"sha256":digest})
                            .to_string(),
                    )
                    .await?;
                let (_, is_text, confirmation) = frames_rx
                    .recv()
                    .await
                    .ok_or_else(|| anyhow::anyhow!("missing confirmation"))?;
                assert!(is_text);
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&confirmation)?["type"],
                    "receipt-confirmed"
                );
                channel.close().await?;
                break;
            }
            staged.extend_from_slice(data);
            // Deliberately slower application writes than the loopback network.
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            channel
                .send_text(
                    &serde_json::json!({"type":"persisted","offset":staged.len()}).to_string(),
                )
                .await?;
            if generation == 0 {
                break;
            } // Disconnect with a real verified prefix.
        }
        peer.close().await?;
    }
    (&mut sender.0).await??;
    let state = state.lock().await;
    assert!(state.producer_sessions.contains(&0));
    assert!(state.producer_sessions.contains(&1));
    Ok(())
}

#[tokio::test]
async fn sender_reconnect_real_peers_use_same_producer_claim_and_resume() -> anyhow::Result<()> {
    tokio::time::timeout(
        std::time::Duration::from_secs(60),
        reconnect_loopback(std::time::Duration::ZERO),
    )
    .await??;
    Ok(())
}

#[tokio::test]
async fn sender_reconnect_verification_receipt_can_arrive_after_thirty_seconds()
-> anyhow::Result<()> {
    tokio::time::timeout(
        std::time::Duration::from_secs(60),
        reconnect_loopback(std::time::Duration::from_secs(31)),
    )
    .await??;
    Ok(())
}
