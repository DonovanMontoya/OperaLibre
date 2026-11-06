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
    handler: Handler,
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
