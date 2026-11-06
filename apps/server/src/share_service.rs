//! Experimental lifecycle; no configuration or production route enables it.
use crate::share_broker::{BrokerClient, Capability};
use std::{
    future::Future,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub(crate) struct ShareSession {
    stop: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<anyhow::Result<()>>,
}

impl ShareSession {
    pub(crate) fn cancellation_handle(&self) -> tokio::sync::watch::Sender<bool> {
        self.stop.clone()
    }
    /// Request cancellation and await the peer task's cleanup.
    pub(crate) async fn stop(mut self) -> anyhow::Result<()> {
        let _ = self.stop.send(true);
        match tokio::time::timeout(Duration::from_secs(5), &mut self.task).await {
            Ok(result) => result??,
            Err(_) => {
                self.task.abort();
                anyhow::bail!("share session did not stop in time")
            }
        }
        Ok(())
    }
    pub(crate) async fn wait(self) -> anyhow::Result<()> {
        self.task.await?
    }
}

/// Issue and claim before starting a peer. The callback owns its peer and is
/// responsible for closing it when cancelled or when its future is dropped.
pub(crate) async fn start<F, Fut>(
    enabled: bool,
    broker: &BrokerClient,
    owner_secret: &str,
    room: &str,
    nonce: &str,
    expires_at: u64,
    start_peer: F,
) -> anyhow::Result<ShareSession>
where
    F: FnOnce(Capability, tokio::sync::watch::Receiver<bool>) -> Fut,
    Fut: Future<Output = anyhow::Result<()>> + Send + 'static,
{
    anyhow::ensure!(enabled, "sharing is disabled");
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    anyhow::ensure!(
        !owner_secret.is_empty() && expires_at > now && expires_at <= now.saturating_add(900),
        "invalid share session configuration"
    );
    let capability = broker.issue(owner_secret, room, nonce, expires_at).await?;
    broker.claim(room, &capability).await?;
    let (stop, receiver) = tokio::sync::watch::channel(false);
    let peer = start_peer(capability, receiver);
    let expire_signal = stop.clone();
    let timeout = Duration::from_secs(
        expires_at.saturating_sub(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs()),
    );
    let task = tokio::spawn(async move {
        tokio::pin!(peer);
        tokio::select! {
            result = &mut peer => result,
            _ = tokio::time::sleep(timeout) => {
                let _ = expire_signal.send(true);
                let _ = tokio::time::timeout(Duration::from_secs(5), &mut peer).await;
                anyhow::bail!("share session expired")
            }
        }
    });
    Ok(ShareSession { stop, task })
}

/// Start a sender for an archive already selected and opened by the server.
/// This remains unregistered; callers must bind the handle to an authorized
/// invitation and enforce the sender's permission before enabling the feature.
#[cfg(test)]
pub(crate) async fn start_sender(
    enabled: bool,
    broker: &BrokerClient,
    owner_secret: &str,
    room: &str,
    nonce: &str,
    expires_at: u64,
    archive: tokio::fs::File,
    size: u64,
    offset: u64,
) -> anyhow::Result<ShareSession> {
    let peer_broker = broker.clone();
    let peer_room = room.to_string();
    start(
        enabled,
        broker,
        owner_secret,
        room,
        nonce,
        expires_at,
        move |capability, stop| async move {
            crate::share_sender::run_peer(
                peer_broker,
                peer_room,
                capability,
                archive,
                size,
                offset,
                expires_at,
                stop,
            )
            .await
        },
    )
    .await
}
