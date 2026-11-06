//! Experimental sender primitive. No production entry point starts it.
use crate::share_transfer::encode_chunk;
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

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct NegotiatedAnswer {
    description: serde_json::Value,
    resume: Option<crate::share_transfer::ResumeRequest>,
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

#[cfg(test)]
mod tests {
    use super::*;
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
