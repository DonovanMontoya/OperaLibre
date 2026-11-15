use super::*;
use tokio::sync::{mpsc, watch};

struct FakeChannel {
    frames: mpsc::UnboundedSender<Vec<u8>>,
    acks: tokio::sync::Mutex<mpsc::UnboundedReceiver<(bool, Vec<u8>)>>,
    polling: mpsc::UnboundedSender<()>,
}

#[async_trait::async_trait]
impl PersistedChannel for FakeChannel {
    async fn send_frame(&self, frame: Vec<u8>) -> anyhow::Result<()> {
        self.frames.send(frame)?;
        Ok(())
    }
    async fn next_ack(&self) -> anyhow::Result<(bool, Vec<u8>)> {
        self.polling.send(())?;
        self.acks
            .lock()
            .await
            .recv()
            .await
            .ok_or_else(|| anyhow::anyhow!("channel closed"))
    }
}

fn expires() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 90
}

fn ack(offset: u64) -> (bool, Vec<u8>) {
    (
        true,
        serde_json::json!({"type":"persisted","offset":offset})
            .to_string()
            .into_bytes(),
    )
}

async fn file(bytes: &[u8]) -> anyhow::Result<tokio::fs::File> {
    use std::io::Write;
    let mut file = tempfile::tempfile()?;
    file.write_all(bytes)?;
    Ok(tokio::fs::File::from_std(file))
}

struct Fixture {
    frames: mpsc::UnboundedReceiver<Vec<u8>>,
    acks: mpsc::UnboundedSender<(bool, Vec<u8>)>,
    polling: mpsc::UnboundedReceiver<()>,
    stop: watch::Sender<bool>,
    task: tokio::task::JoinHandle<anyhow::Result<()>>,
}

async fn start(
    bytes: &[u8],
    offset: u64,
    initial: Option<(bool, Vec<u8>)>,
) -> anyhow::Result<Fixture> {
    let (frames, received) = mpsc::unbounded_channel();
    let (acks, ack_rx) = mpsc::unbounded_channel();
    let (polling, polls) = mpsc::unbounded_channel();
    let (stop, stopped) = watch::channel(false);
    if let Some(initial) = initial {
        acks.send(initial)?;
    }
    let channel = FakeChannel {
        frames,
        acks: tokio::sync::Mutex::new(ack_rx),
        polling,
    };
    let mut file = file(bytes).await?;
    let size = bytes.len() as u64;
    let task = tokio::spawn(async move {
        send_persisted_archive(
            &channel,
            &mut file,
            "archive",
            size,
            offset,
            expires(),
            stopped,
        )
        .await
    });
    Ok(Fixture {
        frames: received,
        acks,
        polling: polls,
        stop,
        task,
    })
}

impl Fixture {
    async fn full_window(&mut self) -> anyhow::Result<Vec<Vec<u8>>> {
        let mut frames = Vec::new();
        for _ in 0..PERSISTED_WINDOW {
            frames.push(
                self.frames
                    .recv()
                    .await
                    .ok_or_else(|| anyhow::anyhow!("window incomplete"))?,
            );
        }
        // Initial unsolicited-message probe and the blocked full-window poll.
        assert!(self.polling.recv().await.is_some());
        assert!(self.polling.recv().await.is_some());
        assert!(
            self.frames.try_recv().is_err(),
            "ninth chunk escaped native persistence window"
        );
        Ok(frames)
    }
}

#[tokio::test]
async fn persisted_window_waits_for_native_append_and_drains_before_final_marker()
-> anyhow::Result<()> {
    let bytes: Vec<u8> = (0..CHUNK * 11 + 31).map(|n| (n % 251) as u8).collect();
    let mut fixture = start(&bytes, 5, None).await?;
    let frames = fixture.full_window().await?;
    let mut received = bytes[..5].to_vec();
    for frame in frames {
        let (_, offset, final_chunk, data) = crate::share_transfer::decode_chunk(&frame)?;
        assert!(!final_chunk);
        assert_eq!(offset, received.len() as u64);
        received.extend_from_slice(data);
    }
    // No ACK exists until this simulated native write completes. One durable
    // append releases only one replacement chunk, regardless of network speed.
    let mut acknowledged = 5;
    while received.len() < bytes.len() {
        acknowledged += CHUNK as u64;
        fixture.acks.send(ack(acknowledged))?;
        let frame = fixture.frames.recv().await.unwrap();
        let (_, offset, final_chunk, data) = crate::share_transfer::decode_chunk(&frame)?;
        assert!(!final_chunk);
        assert_eq!(offset, received.len() as u64);
        received.extend_from_slice(data);
        assert!(fixture.frames.try_recv().is_err());
    }
    assert_eq!(received, bytes);
    // Even after every byte has been queued, no final marker is sent until
    // each remaining exact endpoint (including the partial last chunk) is ACKed.
    while acknowledged < bytes.len() as u64 {
        acknowledged = (acknowledged + CHUNK as u64).min(bytes.len() as u64);
        fixture.acks.send(ack(acknowledged))?;
    }
    let final_frame = fixture.frames.recv().await.unwrap();
    let (_, offset, final_chunk, data) = crate::share_transfer::decode_chunk(&final_frame)?;
    assert!(final_chunk);
    assert_eq!(offset, bytes.len() as u64);
    assert!(data.is_empty());
    fixture.task.await??;
    Ok(())
}

#[tokio::test]
async fn persisted_window_rejects_malformed_binary_oversized_future_and_premature_receipts()
-> anyhow::Result<()> {
    let invalid = [
        (false, ack(CHUNK as u64).1),
        (true, vec![b'x'; 129]),
        (true, b"not json".to_vec()),
        ack(0),
        ack((CHUNK * 2) as u64),
        ack((CHUNK * 20) as u64),
        (true, br#"{"type":"persisted","offset":-1}"#.to_vec()),
        (
            true,
            br#"{"type":"verified","size":16384,"sha256":"x"}"#.to_vec(),
        ),
        (
            true,
            format!("{{\"type\":\"persisted\",\"offset\":{CHUNK},\"extra\":true}}").into_bytes(),
        ),
    ];
    for message in invalid {
        let mut fixture = start(&vec![7; CHUNK * 10], 0, None).await?;
        fixture.full_window().await?;
        fixture.acks.send(message)?;
        assert!(fixture.task.await?.is_err());
        assert!(
            fixture.frames.try_recv().is_err(),
            "invalid ACK advanced transfer"
        );
    }
    Ok(())
}

#[tokio::test]
async fn persisted_window_rejects_unsolicited_and_replayed_acks() -> anyhow::Result<()> {
    let mut initial = start(&vec![7; CHUNK * 10], 0, Some(ack(CHUNK as u64))).await?;
    assert!(initial.task.await?.is_err());
    assert!(initial.frames.try_recv().is_err());
    let mut fixture = start(&vec![7; CHUNK * 10], 0, None).await?;
    fixture.full_window().await?;
    fixture.acks.send(ack(CHUNK as u64))?;
    assert!(fixture.frames.recv().await.is_some());
    fixture.acks.send(ack(CHUNK as u64))?;
    assert!(fixture.task.await?.is_err());
    assert!(fixture.frames.try_recv().is_err());
    Ok(())
}

#[tokio::test]
async fn persisted_window_cancel_and_expiry_interrupt_missing_ack() -> anyhow::Result<()> {
    let mut fixture = start(&vec![7; CHUNK * 10], 0, None).await?;
    fixture.full_window().await?;
    fixture.stop.send(true)?;
    assert!(
        fixture
            .task
            .await?
            .unwrap_err()
            .to_string()
            .contains("cancelled")
    );
    assert!(fixture.frames.try_recv().is_err());
    let mut expired = start(&vec![7; CHUNK * 10], 0, None).await?;
    expired.full_window().await?;
    // Freeze time only after real file I/O and the full-window condition, then
    // expire the blocked ACK wait without depending on a slow wall-clock test.
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_secs(91)).await;
    assert!(
        expired
            .task
            .await?
            .unwrap_err()
            .to_string()
            .contains("expired")
    );
    assert!(expired.frames.try_recv().is_err());
    Ok(())
}

#[tokio::test]
async fn persisted_window_rejects_extra_ack_before_final_marker() -> anyhow::Result<()> {
    let mut fixture = start(&[7], 0, None).await?;
    assert!(fixture.frames.recv().await.is_some());
    // Both are queued atomically from the test task, before sender can resume.
    fixture.acks.send(ack(1))?;
    fixture.acks.send(ack(1))?;
    assert!(fixture.task.await?.is_err());
    assert!(fixture.frames.try_recv().is_err());
    Ok(())
}
