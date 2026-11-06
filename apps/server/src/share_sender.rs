//! Experimental sender primitive. No production entry point starts it.
use crate::share_transfer::encode_chunk;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use webrtc::data_channel::DataChannel;
use webrtc::peer_connection::{
    MediaEngine, PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler,
    RTCConfigurationBuilder, RTCIceGatheringState, Registry, register_default_interceptors,
};

const CHUNK: usize = 16 * 1024;
const MAX_OUTSTANDING: usize = 256 * 1024;

async fn cancellable_send<F>(
    operation: F,
    cancelled: &mut tokio::sync::watch::Receiver<bool>,
) -> anyhow::Result<()>
where
    F: std::future::Future<Output = anyhow::Result<()>>,
{
    anyhow::ensure!(!*cancelled.borrow(), "share cancelled");
    tokio::select! {
        biased;
        result = cancelled.changed() => { result?; anyhow::bail!("share cancelled"); }
        result = operation => result,
    }
}

struct GatherHandler(tokio::sync::mpsc::Sender<()>);

#[cfg(test)]
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct NegotiatedAnswer {
    description: serde_json::Value,
    resume: Option<crate::share_transfer::ResumeRequest>,
}

#[derive(Clone)]
pub(crate) struct PeerAuthentication {
    pub(crate) gift_id: String,
    pub(crate) archive_sha256: String,
    pub(crate) signing: ed25519_dalek::SigningKey,
    pub(crate) preview_key: [u8; 32],
}

// Initial generation plus the broker's 16 allowed recipient rotations. The
// producer claim itself is retained, not rotated by this supervisor.
const MAX_PEER_ATTEMPTS: usize = 17;
const GENERATION_POLL: std::time::Duration = std::time::Duration::from_millis(250);
const PEER_CLEANUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Retain the trusted archive and pinned authentication only for this process's
/// invitation lifetime. Recipient rotation keeps the producer claim valid, but
/// invalidates its old signaling generation. Never run two archive readers.
#[allow(clippy::too_many_arguments)] // Mirrors the single-attempt peer adapter.
pub(crate) async fn run_authenticated_sender(
    broker: crate::share_broker::BrokerClient,
    room: String,
    capability: crate::share_broker::Capability,
    archive: tokio::fs::File,
    size: u64,
    expires_at: u64,
    auth: PeerAuthentication,
    stop: tokio::sync::watch::Receiver<bool>,
) -> anyhow::Result<()> {
    let monitor_broker = broker.clone();
    let monitor_room = room.clone();
    let monitor_capability = capability.clone();
    supervise_sender(
        archive,
        expires_at,
        stop,
        move || {
            let broker = monitor_broker.clone();
            let room = monitor_room.clone();
            let capability = monitor_capability.clone();
            async move { broker.session_generation(&room, &capability).await }
        },
        move |generation, file, stop| {
            run_authenticated_peer(
                broker.clone(),
                room.clone(),
                capability.clone(),
                generation,
                file,
                size,
                expires_at,
                auth.clone(),
                stop,
            )
        },
    )
    .await
}

// The injected operations let lifecycle tests exercise cancellation and file
// ownership without relying on ICE timing. The real adapter above uses the
// authenticated broker session endpoint and actual peer implementation.
async fn supervise_sender<G, GF, A, AF>(
    archive: tokio::fs::File,
    expires_at: u64,
    mut stop: tokio::sync::watch::Receiver<bool>,
    mut generation: G,
    mut attempt: A,
) -> anyhow::Result<()>
where
    G: FnMut() -> GF,
    GF: std::future::Future<Output = anyhow::Result<u64>>,
    A: FnMut(u64, tokio::fs::File, tokio::sync::watch::Receiver<bool>) -> AF,
    AF: std::future::Future<Output = anyhow::Result<()>>,
{
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    anyhow::ensure!(now < expires_at, "share expired");
    anyhow::ensure!(
        expires_at <= now.saturating_add(900),
        "invalid share lifetime"
    );
    let deadline = tokio::time::Instant::now()
        + std::time::Duration::from_secs(expires_at.saturating_sub(now));
    ensure_sender_active(&stop, expires_at)?;
    let mut current = tokio::select! {
        biased;
        _ = stop.changed() => anyhow::bail!("share cancelled"),
        _ = tokio::time::sleep_until(deadline) => anyhow::bail!("share expired"),
        result = generation() => result?,
    };
    crate::share_broker::validate_generation(current)?;
    for _ in 0..MAX_PEER_ATTEMPTS {
        ensure_sender_active(&stop, expires_at)?;
        // try_clone may share its OS cursor with previous clones. The previous
        // attempt has fully stopped before this seek or another reader starts.
        let mut file = archive.try_clone().await?;
        file.seek(std::io::SeekFrom::Start(0)).await?;
        ensure_sender_active(&stop, expires_at)?;
        let (cancel, cancelled) = tokio::sync::watch::channel(false);
        let peer = attempt(current, file, cancelled);
        let monitor_stop = stop.clone();
        let previous = current;
        let next = async {
            loop {
                ensure_sender_active(&monitor_stop, expires_at)?;
                let observed = generation().await?;
                crate::share_broker::validate_generation(observed)?;
                anyhow::ensure!(observed >= previous, "signaling generation moved backwards");
                if observed > previous {
                    return Ok::<_, anyhow::Error>(observed);
                }
                tokio::time::sleep(GENERATION_POLL).await;
            }
        };
        tokio::pin!(peer, next);
        // An error in one attempt is not permission to replay a consumed ready
        // message. Only a strictly newer authenticated generation can retry it.
        let mut completed = false;
        let outcome = loop {
            tokio::select! {
                biased;
                _ = stop.changed() => break Err(anyhow::anyhow!("share cancelled")),
                _ = tokio::time::sleep_until(deadline) => break Err(anyhow::anyhow!("share expired")),
                result = &mut next => break result,
                result = &mut peer, if !completed => {
                    completed = true;
                    if result.is_ok() {
                        return Ok(());
                    }
                }
            }
        };
        if !completed {
            let _ = cancel.send(true);
            // If cleanup cannot finish, terminate; never reuse a cursor while
            // an old attempt (including blocking prefix hashing) may read it.
            tokio::time::timeout(PEER_CLEANUP_TIMEOUT, &mut peer)
                .await
                .map_err(|_| anyhow::anyhow!("share peer cleanup timed out"))?
                .ok();
        }
        current = outcome?;
    }
    anyhow::bail!("share reconnect attempt limit reached")
}

#[cfg(test)]
#[path = "share_sender_reconnect_tests.rs"]
mod reconnect_tests;

fn ensure_sender_active(
    stop: &tokio::sync::watch::Receiver<bool>,
    expires_at: u64,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !*stop.borrow() && stop.has_changed().is_ok(),
        "share cancelled"
    );
    anyhow::ensure!(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() < expires_at,
        "share expired"
    );
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Ready {
    challenge: String,
    resume: Option<crate::share_transfer::ResumeRequest>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthenticatedAnswer {
    description_json: String,
    proof: String,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct VerifiedReceipt {
    #[serde(rename = "type")]
    kind: String,
    size: u64,
    sha256: String,
}

async fn wait_for_verified_receipt(
    channel: &dyn DataChannel,
    size: u64,
    sha256: &str,
    expires_at: u64,
    mut cancelled: tokio::sync::watch::Receiver<bool>,
) -> anyhow::Result<()> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    anyhow::ensure!(now < expires_at, "share expired");
    // Native verification hashes the complete staged archive and can take much
    // longer than 30 seconds on a phone. Do not extend the invitation itself.
    let timeout = std::time::Duration::from_secs(expires_at.saturating_sub(now).min(900));
    cancellable_send(
        async {
            tokio::time::timeout(timeout, async {
                loop {
                    match channel.poll().await {
                        Some(webrtc::data_channel::DataChannelEvent::OnMessage(message)) => {
                            anyhow::ensure!(
                                message.is_string && message.data.len() <= 512,
                                "invalid verification receipt"
                            );
                            let receipt: VerifiedReceipt = serde_json::from_slice(&message.data)?;
                            anyhow::ensure!(
                                receipt.kind == "verified"
                                    && receipt.size == size
                                    && receipt.sha256 == sha256,
                                "invalid verification receipt"
                            );
                            anyhow::ensure!(
                                SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs()
                                    < expires_at,
                                "share expired"
                            );
                            let confirmation = serde_json::json!({"type": "receipt-confirmed", "size": size, "sha256": sha256}).to_string();
                            channel.send_text(&confirmation).await?;
                            return tokio::time::timeout(std::time::Duration::from_secs(30), async {
                                loop {
                                    match channel.poll().await {
                                        Some(webrtc::data_channel::DataChannelEvent::OnClose) | None => return Ok(()),
                                        Some(webrtc::data_channel::DataChannelEvent::OnMessage(_)) => anyhow::bail!("unexpected message after verification"),
                                        _ => {}
                                    }
                                }
                            }).await.map_err(|_| anyhow::anyhow!("verified channel close timed out"))?;
                        }
                        Some(webrtc::data_channel::DataChannelEvent::OnClose) | None => {
                            anyhow::bail!("data channel closed before verification")
                        }
                        _ => {}
                    }
                }
            })
            .await
            .map_err(|_| anyhow::anyhow!("verification receipt timed out"))?
        },
        &mut cancelled,
    )
    .await
}

fn decode_32(value: &str) -> anyhow::Result<[u8; 32]> {
    anyhow::ensure!(value.len() == 43, "invalid base64url value");
    let decoded = URL_SAFE_NO_PAD.decode(value)?;
    anyhow::ensure!(
        URL_SAFE_NO_PAD.encode(&decoded) == value,
        "noncanonical base64url value"
    );
    decoded
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid base64url length"))
}

// The legacy BrokerClient rejects the new ready signal. Keep this transport
// narrowly scoped until its API can be updated along with the protocol.
struct AuthSignaling {
    client: reqwest::Client,
    base: reqwest::Url,
    room: String,
    capability: crate::share_broker::Capability,
    generation: u64,
}

impl AuthSignaling {
    fn new(
        broker: &crate::share_broker::BrokerClient,
        room: String,
        capability: crate::share_broker::Capability,
        generation: u64,
    ) -> anyhow::Result<Self> {
        crate::share_broker::validate_generation(generation)?;
        anyhow::ensure!(
            (16..=128).contains(&room.len())
                && room
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
            "invalid room"
        );
        Ok(Self {
            client: crate::http_client_builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(15))
                .build()?,
            base: broker.origin().clone(),
            room,
            capability,
            generation,
        })
    }
    async fn post(&self, action: &str, mut body: serde_json::Value) -> anyhow::Result<Vec<u8>> {
        body["payload"] = self.capability.payload.clone().into();
        body["signature"] = self.capability.signature.clone().into();
        if self.generation != 0 {
            body["generation"] = self.generation.into();
        }
        let mut response = self
            .client
            .post(self.base.join(&format!("/{action}/{}", self.room))?)
            .json(&body)
            .send()
            .await?;
        anyhow::ensure!(response.status().is_success(), "broker signaling failed");
        let mut data = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            anyhow::ensure!(
                data.len().saturating_add(chunk.len()) <= 160 * 1024,
                "broker response exceeds limit"
            );
            data.extend_from_slice(&chunk);
        }
        Ok(data)
    }
    async fn poll(&self, after: u32) -> anyhow::Result<Vec<crate::share_broker::Signal>> {
        anyhow::ensure!(after <= 32, "invalid signal cursor");
        let signals: Vec<crate::share_broker::Signal> = serde_json::from_slice(
            &self
                .post("poll", serde_json::json!({"after": after}))
                .await?,
        )?;
        anyhow::ensure!(signals.len() <= 32, "too many signals");
        let mut cursor = after;
        for signal in &signals {
            anyhow::ensure!(
                signal.sequence > cursor
                    && signal.sequence <= 32
                    && signal.message.len() <= 7168
                    && matches!(signal.kind.as_str(), "ready" | "answer" | "ice"),
                "invalid broker signal"
            );
            cursor = signal.sequence;
        }
        Ok(signals)
    }
    async fn wait_for(&self, after: u32, sequence: u32, kind: &str) -> anyhow::Result<String> {
        loop {
            if let Some(signal) = self.poll(after).await?.into_iter().next() {
                anyhow::ensure!(
                    signal.sequence == sequence && signal.kind == kind,
                    "unexpected signal"
                );
                return Ok(signal.message);
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }
}

/// Authenticated exchange over an already authorized signaling generation.
#[allow(clippy::too_many_arguments)] // Explicit pinned protocol/session inputs at this peer boundary.
pub(crate) async fn run_authenticated_peer(
    broker: crate::share_broker::BrokerClient,
    room: String,
    capability: crate::share_broker::Capability,
    generation: u64,
    file: tokio::fs::File,
    size: u64,
    expires_at: u64,
    auth: PeerAuthentication,
    mut stop: tokio::sync::watch::Receiver<bool>,
) -> anyhow::Result<()> {
    anyhow::ensure!(!*stop.borrow(), "share cancelled");
    let signaling = AuthSignaling::new(&broker, room.clone(), capability, generation)?;
    let ready_message = tokio::select! {
        result = signaling.wait_for(0, 1, "ready") => result?,
        changed = stop.changed() => { changed?; anyhow::bail!("share cancelled"); }
    };
    let ready: Ready = serde_json::from_str(&ready_message)?;
    decode_32(&ready.challenge)?;
    let (mut file, offset, prefix) = if let Some(request) = ready.resume {
        anyhow::ensure!(generation > 0, "resume requires a rotated generation");
        let file = file.into_std().await;
        let stopped = stop.clone();
        tokio::task::spawn_blocking(move || {
            let mut file = file;
            let offset = crate::share_transfer::verify_resume_request_checked(
                &mut file,
                size,
                &request,
                || {
                    anyhow::ensure!(
                        !*stopped.borrow() && stopped.has_changed().is_ok(),
                        "share cancelled"
                    );
                    anyhow::ensure!(
                        SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() < expires_at,
                        "share expired"
                    );
                    Ok(())
                },
            )?;
            Ok::<_, anyhow::Error>((
                tokio::fs::File::from_std(file),
                offset,
                request.prefix_sha256,
            ))
        })
        .await??
    } else {
        (
            file,
            0,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_string(),
        )
    };
    let runtime = webrtc::runtime::default_runtime()
        .ok_or_else(|| anyhow::anyhow!("WebRTC runtime unavailable"))?;
    let mut media = MediaEngine::default();
    media.register_default_codecs()?;
    let registry = register_default_interceptors(Registry::new(), &mut media)?;
    let (gathered, mut gather_rx) = tokio::sync::mpsc::channel(1);
    let peer = PeerConnectionBuilder::new()
        .with_configuration(RTCConfigurationBuilder::new().build())
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .with_runtime(runtime)
        .with_handler(Arc::new(GatherHandler(gathered)))
        .with_udp_addrs(vec!["0.0.0.0:0".to_string()])
        .with_data_channel_send_buffer_limit(MAX_OUTSTANDING)
        .build()
        .await?;
    let result = {
        let outcome = async {
            let channel = peer.create_data_channel("operalibre-share", None).await?;
            peer.set_local_description(peer.create_offer(None).await?)
                .await?;
            gather_rx
                .recv()
                .await
                .ok_or_else(|| anyhow::anyhow!("ICE gathering closed"))?;
            let offer = serde_json::to_string(
                &peer
                    .local_description()
                    .await
                    .ok_or_else(|| anyhow::anyhow!("missing offer"))?,
            )?;
            // The proof primitive accepts descriptions of at most 4096 bytes.
            anyhow::ensure!(offer.len() <= 4096, "offer exceeds proof limit");
            let binding = crate::share_peer_proof::PeerProofBinding {
                room: room.clone(),
                gift_id: auth.gift_id.clone(),
                expires_at,
                generation,
                archive_size: size,
                archive_sha256: auth.archive_sha256.clone(),
                offset,
                prefix_sha256: prefix.clone(),
                challenge: ready.challenge.clone(),
            };
            let signed = crate::share_preview_crypto::sign_peer_offer(
                &crate::share_preview_crypto::PeerOffer {
                    version: 1,
                    gift_id: &auth.gift_id,
                    room: &room,
                    expires_at,
                    archive_size: size,
                    archive_sha256: &auth.archive_sha256,
                    generation,
                    offset,
                    prefix_sha256: &prefix,
                    challenge: &ready.challenge,
                    offer: &offer,
                },
                &auth.signing,
            )?;
            let message = serde_json::to_string(&signed)?;
            anyhow::ensure!(message.len() <= 7168, "signed offer too large");
            signaling
                .post(
                    "send",
                    serde_json::json!({"sequence": 1, "kind": "offer", "message": message}),
                )
                .await?;
            let answer: AuthenticatedAnswer =
                serde_json::from_str(&signaling.wait_for(1, 2, "answer").await?)?;
            let proof = decode_32(&answer.proof)?;
            let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
            crate::share_peer_proof::verify_peer_proof(
                &auth.preview_key,
                &binding,
                &offer,
                &answer.description_json,
                now,
                &proof,
            )?;
            peer.set_remote_description(serde_json::from_str(&answer.description_json)?)
                .await?;
            loop {
                match channel.poll().await {
                    Some(webrtc::data_channel::DataChannelEvent::OnOpen) => break,
                    Some(webrtc::data_channel::DataChannelEvent::OnClose) | None => {
                        anyhow::bail!("data channel closed")
                    }
                    _ => {}
                }
            }
            signaling.poll(2).await?;
            let (cancel, cancelled) = tokio::sync::watch::channel(false);
            let monitor = async {
                loop {
                    if signaling.poll(2).await.is_err() {
                        let _ = cancel.send(true);
                        return;
                    }
                    tokio::select! { _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {}, _ = cancel.closed() => return }
                }
            };
            let sender = async {
                send_acknowledged_archive(
                    &*channel,
                    &mut file,
                    "archive",
                    size,
                    offset,
                    expires_at,
                    cancelled.clone(),
                )
                .await?;
                wait_for_verified_receipt(
                    &*channel,
                    size,
                    &auth.archive_sha256,
                    expires_at,
                    cancelled,
                )
                .await
            };
            tokio::pin!(monitor, sender);
            tokio::select! { result = &mut sender => result, _ = &mut monitor => sender.await }
        };
        tokio::pin!(outcome);
        tokio::select! {
            result = &mut outcome => result,
            _ = stop.changed() => Err(anyhow::anyhow!("share cancelled"))
        }
    };
    // Dropping a Tokio read future does not cancel its blocking I/O. Keep the
    // handle outside the cancelled outcome and drain before the supervisor can
    // clone/seek the shared OS cursor for another generation.
    drop(file.into_std().await);
    peer.close().await?;
    result
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for GatherHandler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.0.try_send(());
        }
    }
}

/// Experimental non-trickle host-ICE sender. The broker capability has
/// already been issued and claimed by the service. TURN is not configured.
#[cfg(test)]
#[allow(clippy::too_many_arguments)] // Test-only adapter for an already authorized archive session.
pub(crate) async fn run_peer(
    broker: crate::share_broker::BrokerClient,
    room: String,
    capability: crate::share_broker::Capability,
    file: tokio::fs::File,
    size: u64,
    offset: u64,
    expires_at: u64,
    stop: tokio::sync::watch::Receiver<bool>,
) -> anyhow::Result<()> {
    run_peer_generation(
        broker, room, capability, 0, file, size, offset, expires_at, stop,
    )
    .await
}

/// Run one peer using an already active capability and signaling generation.
#[cfg(test)]
#[allow(clippy::too_many_arguments)] // Test-only signaling generation and bounded archive inputs.
pub(crate) async fn run_peer_generation(
    broker: crate::share_broker::BrokerClient,
    room: String,
    capability: crate::share_broker::Capability,
    generation: u64,
    file: tokio::fs::File,
    size: u64,
    offset: u64,
    expires_at: u64,
    mut stop: tokio::sync::watch::Receiver<bool>,
) -> anyhow::Result<()> {
    crate::share_broker::validate_generation(generation)?;
    anyhow::ensure!(!*stop.borrow(), "share cancelled");
    anyhow::ensure!(
        offset == 0,
        "resume requires an authenticated recipient request"
    );
    let runtime = webrtc::runtime::default_runtime()
        .ok_or_else(|| anyhow::anyhow!("WebRTC runtime unavailable"))?;
    let mut media = MediaEngine::default();
    media.register_default_codecs()?;
    let registry = register_default_interceptors(Registry::new(), &mut media)?;
    let (gathered, mut gather_rx) = tokio::sync::mpsc::channel(1);
    let peer = PeerConnectionBuilder::new()
        .with_configuration(RTCConfigurationBuilder::new().build())
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .with_runtime(runtime)
        .with_handler(Arc::new(GatherHandler(gathered)))
        .with_udp_addrs(vec!["0.0.0.0:0".to_string()])
        .with_data_channel_send_buffer_limit(MAX_OUTSTANDING)
        .build()
        .await?;
    let outcome = async {
        let channel = peer.create_data_channel("operalibre-share", None).await?;
        peer.set_local_description(peer.create_offer(None).await?)
            .await?;
        gather_rx
            .recv()
            .await
            .ok_or_else(|| anyhow::anyhow!("ICE gathering closed"))?;
        let offer = serde_json::to_string(
            &peer
                .local_description()
                .await
                .ok_or_else(|| anyhow::anyhow!("missing offer"))?,
        )?;
        broker
            .send_generation(&room, &capability, generation, 1, "offer", &offer)
            .await?;
        let mut cursor = 0;
        let mut resume = None;
        loop {
            let signals = broker
                .poll_generation(&room, &capability, generation, cursor)
                .await?;
            let mut answer = None;
            for signal in signals {
                anyhow::ensure!(signal.sequence > cursor, "broker signal replay");
                cursor = signal.sequence;
                if signal.kind == "answer" {
                    answer = Some(signal.message);
                    break;
                }
            }
            if let Some(answer) = answer {
                let value: serde_json::Value = serde_json::from_str(&answer)?;
                let description = if value.get("description").is_some() {
                    let negotiated: NegotiatedAnswer = serde_json::from_value(value)?;
                    resume = negotiated.resume;
                    negotiated.description
                } else {
                    value
                };
                peer.set_remote_description(serde_json::from_value(description)?)
                    .await?;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        loop {
            match channel.poll().await {
                Some(webrtc::data_channel::DataChannelEvent::OnOpen) => break,
                Some(webrtc::data_channel::DataChannelEvent::OnClose) | None => {
                    anyhow::bail!("data channel closed")
                }
                _ => {}
            }
        }
        let (file, offset) = if let Some(request) = resume {
            let file = file.into_std().await;
            let (file, offset) = tokio::task::spawn_blocking(move || {
                let mut file = file;
                let offset =
                    crate::share_transfer::verify_resume_request(&mut file, size, &request)?;
                Ok::<_, anyhow::Error>((file, offset))
            })
            .await??;
            (tokio::fs::File::from_std(file), offset)
        } else {
            (file, 0)
        };
        send_with_broker_watch_generation(
            &broker,
            &room,
            &capability,
            generation,
            &*channel,
            file,
            "archive",
            size,
            offset,
            expires_at,
            std::time::Duration::from_secs(1),
        )
        .await
    };
    tokio::pin!(outcome);
    let result = tokio::select! {
        result = &mut outcome => result,
        changed = stop.changed() => { changed?; Err(anyhow::anyhow!("share cancelled")) },
    };
    peer.close().await?;
    result
}

/// Monitor broker authorization while transferring. Poll failures fail closed.
/// This is not started by production routes.
#[allow(clippy::too_many_arguments)] // Explicit channel/archive/revocation inputs at this protocol boundary.
pub(crate) async fn send_with_broker_watch(
    broker: &crate::share_broker::BrokerClient,
    room: &str,
    capability: &crate::share_broker::Capability,
    channel: &dyn DataChannel,
    file: tokio::fs::File,
    asset_id: &str,
    size: u64,
    offset: u64,
    expires_at: u64,
    interval: std::time::Duration,
) -> anyhow::Result<()> {
    send_with_broker_watch_generation(
        broker, room, capability, 0, channel, file, asset_id, size, offset, expires_at, interval,
    )
    .await
}

#[allow(clippy::too_many_arguments)] // Authorized signaling generation and bounded file transfer inputs.
pub(crate) async fn send_with_broker_watch_generation(
    broker: &crate::share_broker::BrokerClient,
    room: &str,
    capability: &crate::share_broker::Capability,
    generation: u64,
    channel: &dyn DataChannel,
    file: tokio::fs::File,
    asset_id: &str,
    size: u64,
    offset: u64,
    expires_at: u64,
    interval: std::time::Duration,
) -> anyhow::Result<()> {
    crate::share_broker::validate_generation(generation)?;
    // Do not begin sending until the broker confirms this claim and generation.
    // Subsequent revocation is still subject to polling and queued bytes.
    broker
        .poll_generation(room, capability, generation, 0)
        .await?;
    let (cancel, cancelled) = tokio::sync::watch::channel(false);
    let monitor =
        broker.monitor_transfer_generation(room, capability, generation, interval, cancel);
    let sender = send_archive(channel, file, asset_id, size, offset, expires_at, cancelled);
    tokio::pin!(monitor, sender);
    tokio::select! {
        result = &mut sender => result,
        _ = &mut monitor => sender.await,
    }
}

/// Send from an already authorized, immutable archive handle. The receiver
/// must verify the final digest before publishing anything to its library.
/// The caller must configure a bounded WebRTC send buffer on its peer builder.
pub(crate) async fn send_archive(
    channel: &dyn DataChannel,
    mut file: tokio::fs::File,
    asset_id: &str,
    size: u64,
    offset: u64,
    expires_at: u64,
    cancelled: tokio::sync::watch::Receiver<bool>,
) -> anyhow::Result<()> {
    send_archive_reader(
        channel, &mut file, asset_id, size, offset, expires_at, cancelled,
    )
    .await
}

async fn send_archive_reader(
    channel: &dyn DataChannel,
    file: &mut tokio::fs::File,
    asset_id: &str,
    size: u64,
    offset: u64,
    expires_at: u64,
    mut cancelled: tokio::sync::watch::Receiver<bool>,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        offset <= size && file.metadata().await?.len() == size,
        "archive size changed"
    );
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    let mut position = offset;
    let mut buffer = vec![0_u8; CHUNK];
    while position < size {
        anyhow::ensure!(!*cancelled.borrow(), "share cancelled");
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        anyhow::ensure!(now < expires_at, "share expired");
        while channel.outstanding_bytes().await? > MAX_OUTSTANDING {
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(20)) => {},
                result = cancelled.changed() => { result?; anyhow::ensure!(!*cancelled.borrow(), "share cancelled"); }
            }
            anyhow::ensure!(
                SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() < expires_at,
                "share expired"
            );
        }
        let wanted = ((size - position) as usize).min(CHUNK);
        file.read_exact(&mut buffer[..wanted]).await?;
        let frame = encode_chunk(asset_id, position, false, &buffer[..wanted])?;
        cancellable_send(
            async {
                channel
                    .send(bytes::BytesMut::from(frame.as_slice()))
                    .await
                    .map_err(Into::into)
            },
            &mut cancelled,
        )
        .await?;
        position += wanted as u64;
    }
    anyhow::ensure!(
        !*cancelled.borrow()
            && SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() < expires_at,
        "share expired or cancelled"
    );
    let frame = encode_chunk(asset_id, position, true, &[])?;
    cancellable_send(
        async {
            channel
                .send(bytes::BytesMut::from(frame.as_slice()))
                .await
                .map_err(Into::into)
        },
        &mut cancelled,
    )
    .await?;
    Ok(())
}

const PERSISTED_WINDOW: usize = 8;

#[async_trait::async_trait]
trait PersistedChannel: Send + Sync {
    async fn send_frame(&self, frame: Vec<u8>) -> anyhow::Result<()>;
    async fn next_ack(&self) -> anyhow::Result<(bool, Vec<u8>)>;
}

struct PeerPersistedChannel<'a>(&'a dyn DataChannel);

#[async_trait::async_trait]
impl PersistedChannel for PeerPersistedChannel<'_> {
    async fn send_frame(&self, frame: Vec<u8>) -> anyhow::Result<()> {
        self.0.send(bytes::BytesMut::from(frame.as_slice())).await?;
        Ok(())
    }
    async fn next_ack(&self) -> anyhow::Result<(bool, Vec<u8>)> {
        use webrtc::data_channel::DataChannelEvent;
        loop {
            match self.0.poll().await {
                Some(DataChannelEvent::OnMessage(message)) => {
                    anyhow::ensure!(message.data.len() <= 128, "persisted ACK exceeds limit");
                    return Ok((message.is_string, message.data.to_vec()));
                }
                Some(
                    DataChannelEvent::OnClose
                    | DataChannelEvent::OnClosing
                    | DataChannelEvent::OnError,
                )
                | None => anyhow::bail!("data channel closed before persistence"),
                _ => {}
            }
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedAck {
    #[serde(rename = "type")]
    kind: String,
    offset: u64,
}

fn accept_persisted_ack(
    message: (bool, Vec<u8>),
    pending: &mut std::collections::VecDeque<u64>,
    sent: u64,
) -> anyhow::Result<()> {
    anyhow::ensure!(message.0 && message.1.len() <= 128, "invalid persisted ACK");
    let ack: PersistedAck = serde_json::from_slice(&message.1)?;
    let expected = pending
        .pop_front()
        .ok_or_else(|| anyhow::anyhow!("unsolicited persisted ACK"))?;
    anyhow::ensure!(
        ack.kind == "persisted" && ack.offset == expected && ack.offset <= sent,
        "invalid persisted ACK offset or type"
    );
    Ok(())
}

/// Application-level flow control bounds native queued writes independently of
/// SCTP's network buffer. Only authenticated peers use this protocol. The one
/// poll consumer drains all persisted ACKs before handing off to receipt polling.
async fn send_acknowledged_archive(
    channel: &dyn DataChannel,
    file: &mut tokio::fs::File,
    asset_id: &str,
    size: u64,
    offset: u64,
    expires_at: u64,
    cancelled: tokio::sync::watch::Receiver<bool>,
) -> anyhow::Result<()> {
    send_persisted_archive(
        &PeerPersistedChannel(channel),
        file,
        asset_id,
        size,
        offset,
        expires_at,
        cancelled,
    )
    .await
}

async fn send_persisted_archive<C: PersistedChannel>(
    channel: &C,
    file: &mut tokio::fs::File,
    asset_id: &str,
    size: u64,
    offset: u64,
    expires_at: u64,
    mut cancelled: tokio::sync::watch::Receiver<bool>,
) -> anyhow::Result<()> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    anyhow::ensure!(now < expires_at, "share expired");
    let remaining = std::time::Duration::from_secs(expires_at.saturating_sub(now).min(900));
    cancellable_send(async {
        tokio::time::timeout(remaining, async {
            anyhow::ensure!(offset <= size && file.metadata().await?.len()==size,"archive size changed");
            file.seek(std::io::SeekFrom::Start(offset)).await?;
            let mut position=offset;
            let mut pending=std::collections::VecDeque::with_capacity(PERSISTED_WINDOW);
            let mut buffer=vec![0;CHUNK];
            // Refuse messages already queued before any archive data was sent.
            tokio::select! {
                biased;
                message=channel.next_ack()=>accept_persisted_ack(message?,&mut pending,position)?,
                _=std::future::ready(())=>{}
            }
            while position < size || !pending.is_empty() {
                anyhow::ensure!(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs()<expires_at,"share expired");
                while position < size && pending.len() < PERSISTED_WINDOW {
                    let wanted=(size-position).min(CHUNK as u64) as usize;
                    file.read_exact(&mut buffer[..wanted]).await?;
                    channel.send_frame(encode_chunk(asset_id,position,false,&buffer[..wanted])?).await?;
                    position+=wanted as u64;
                    pending.push_back(position);
                }
                accept_persisted_ack(channel.next_ack().await?,&mut pending,position)?;
            }
            // A duplicate/premature receipt queued after the last ACK must not
            // become a valid receipt just because this loop has finished.
            tokio::select! {
                biased;
                message=channel.next_ack()=>accept_persisted_ack(message?,&mut pending,position)?,
                _=std::future::ready(())=>{}
            }
            anyhow::ensure!(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs()<expires_at,"share expired");
            channel.send_frame(encode_chunk(asset_id,position,true,&[])?).await?;
            Ok(())
        }).await.map_err(|_|anyhow::anyhow!("archive persistence expired"))?
    }, &mut cancelled).await
}

#[cfg(test)]
#[path = "share_sender_ack_tests.rs"]
mod ack_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn invalid_resume_prefix_is_rejected_before_offer() -> anyhow::Result<()> {
        use axum::{
            Json, Router, extract::Path, http::StatusCode, response::IntoResponse, routing::post,
        };
        use std::io::Write;
        let app = Router::new().route("/{action}/{room}", post(|Path((action, _)): Path<(String, String)>| async move {
            if action != "poll" { panic!("an invalid prefix must not produce signaling"); }
            (StatusCode::OK, Json(serde_json::json!([{"sequence":1,"kind":"ready","message":serde_json::json!({"challenge":URL_SAFE_NO_PAD.encode([1_u8;32]),"resume":{"offset":1,"prefixSha256":"0".repeat(64)}}).to_string()}]))).into_response()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let task = tokio::spawn(async move { axum::serve(listener, app).await });
        let broker = crate::share_broker::BrokerClient::local(&format!("http://{address}/"))?;
        let mut file = tempfile::tempfile()?;
        file.write_all(b"x")?;
        let (_cancel, stopped) = tokio::sync::watch::channel(false);
        let result = run_authenticated_peer(
            broker,
            "room____________".into(),
            crate::share_broker::Capability {
                payload: "p".into(),
                signature: "s".into(),
            },
            1,
            tokio::fs::File::from_std(file),
            1,
            u64::MAX,
            PeerAuthentication {
                gift_id: "gift____________".into(),
                archive_sha256: "a".repeat(64),
                signing: ed25519_dalek::SigningKey::from_bytes(&[1; 32]),
                preview_key: [2; 32],
            },
            stopped,
        )
        .await;
        task.abort();
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("resume prefix mismatch")
        );
        Ok(())
    }

    #[tokio::test]
    async fn cancellation_interrupts_a_blocked_final_send() {
        let (sender, mut receiver) = tokio::sync::watch::channel(false);
        let (entered, waiting) = tokio::sync::oneshot::channel();
        let blocked = tokio::spawn(async move {
            cancellable_send(
                async move {
                    let _ = entered.send(());
                    std::future::pending::<anyhow::Result<()>>().await
                },
                &mut receiver,
            )
            .await
        });
        waiting.await.unwrap();
        sender.send(true).unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), blocked)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
    }
}
