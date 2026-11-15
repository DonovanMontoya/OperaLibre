use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::sync::oneshot;
use webrtc::data_channel::DataChannelEvent;

struct Handler;
#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {}

/// The retained observer prevents dependency Drop from doing any cleanup. The
/// guard must actually close the default, non-dedicated-runtime peer and end its
/// channel stream after abrupt owner cancellation at a post-construction wait.
#[tokio::test]
async fn aborted_owner_closes_actual_default_runtime_peer() -> anyhow::Result<()> {
    let peer = create_configured_peer(&ConnectivityConfig::default(), Arc::new(Handler)).await?;
    let channel = peer.create_data_channel("owned-abort", None).await?;
    let (entered, started) = oneshot::channel();
    let owned = peer.clone();
    let owner = tokio::spawn(async move {
        let _close = PeerCloseGuard::new(owned);
        let _ = entered.send(());
        // Represents any owner wait after construction, including a file drain
        // that outlives the supervisor/session cleanup deadline.
        std::future::pending::<()>().await;
    });
    tokio::time::timeout(Duration::from_secs(2), started).await??;
    owner.abort();
    assert!(owner.await.unwrap_err().is_cancelled());
    let event = tokio::time::timeout(Duration::from_secs(2), channel.poll()).await?;
    assert!(matches!(event, None | Some(DataChannelEvent::OnClose)));
    assert!(
        peer.create_data_channel("must-be-closed", None)
            .await
            .is_err()
    );
    Ok(())
}

/// Dropping the joining future must not drop an already-started close future;
/// otherwise cancellation in close itself recreates the detached-driver leak.
#[tokio::test]
async fn aborting_close_joiner_does_not_cancel_owned_cleanup() -> anyhow::Result<()> {
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let (entered, started) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let (completed, finished) = oneshot::channel();
    let mut close = PeerCloseGuard::with_close(async move {
        counted.fetch_add(1, Ordering::SeqCst);
        let _ = entered.send(());
        released.await?;
        let _ = completed.send(());
        Ok(())
    });
    let joining = tokio::spawn(async move { close.close().await });
    tokio::time::timeout(Duration::from_secs(2), started).await??;
    joining.abort();
    assert!(joining.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), finished).await??;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    Ok(())
}

/// The join has a deadline; expiry reports failure without falsely declaring
/// the peer closed or cancelling its sole cleanup operation. Virtual time
/// exercises that bound without a wall-clock sleep.
#[tokio::test(start_paused = true)]
async fn close_join_timeout_keeps_cleanup_running_after_guard_drop() -> anyhow::Result<()> {
    let (release, released) = oneshot::channel();
    let (completed, finished) = oneshot::channel();
    let mut close = PeerCloseGuard::with_close(async move {
        released.await?;
        let _ = completed.send(());
        Ok(())
    });
    let before = tokio::time::Instant::now();
    let error = close.close().await.unwrap_err();
    assert!(error.to_string().contains("close timed out"));
    assert_eq!(before.elapsed(), PEER_CLEANUP_TIMEOUT);
    drop(close);
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(1), finished).await??;
    Ok(())
}
