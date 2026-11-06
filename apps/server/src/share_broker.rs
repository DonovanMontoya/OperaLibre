//! Experimental outbound broker client. No production route instantiates it.
use crate::*;

const MAX_RESPONSE: usize = 160 * 1024;

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Capability {
    pub(crate) payload: String,
    pub(crate) signature: String,
}

#[derive(Deserialize)]
pub(crate) struct Signal {
    pub(crate) sequence: u32,
    pub(crate) kind: String,
    pub(crate) message: String,
}

#[derive(Clone)]
pub(crate) struct BrokerClient {
    client: reqwest::Client,
    base: reqwest::Url,
}

impl BrokerClient {
    pub(crate) fn origin(&self) -> &reqwest::Url {
        &self.base
    }
    pub(crate) fn new(base: &str) -> anyhow::Result<Self> {
        let base = reqwest::Url::parse(base)?;
        anyhow::ensure!(
            base.scheme() == "https"
                && base.host_str().is_some()
                && base.username().is_empty()
                && base.password().is_none()
                && base.query().is_none()
                && base.fragment().is_none()
                && base.path() == "/",
            "broker must be an HTTPS origin"
        );
        Ok(Self {
            client: http_client_builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(15))
                .build()?,
            base,
        })
    }
    #[cfg(test)]
    pub(crate) fn local(base: &str) -> anyhow::Result<Self> {
        Ok(Self {
            client: http_client_builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(5))
                .build()?,
            base: reqwest::Url::parse(base)?,
        })
    }
    async fn post(
        &self,
        path: &str,
        body: serde_json::Value,
        owner: Option<&str>,
    ) -> anyhow::Result<Vec<u8>> {
        let mut request = self.client.post(self.base.join(path)?).json(&body);
        if let Some(owner) = owner {
            request = request.bearer_auth(owner);
        }
        let mut response = request.send().await?;
        let status = response.status();
        anyhow::ensure!(status.is_success(), "broker returned HTTP {status}");
        let mut data = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            anyhow::ensure!(
                data.len().saturating_add(chunk.len()) <= MAX_RESPONSE,
                "broker response exceeds limit"
            );
            data.extend_from_slice(&chunk);
        }
        Ok(data)
    }
    fn room_path(action: &str, room: &str) -> anyhow::Result<String> {
        anyhow::ensure!(
            (16..=128).contains(&room.len())
                && room
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
            "invalid room id"
        );
        Ok(format!("/{action}/{room}"))
    }
    pub(crate) async fn issue(
        &self,
        owner: &str,
        room: &str,
        nonce: &str,
        expires_at: u64,
    ) -> anyhow::Result<Capability> {
        self.issue_role(owner, room, nonce, expires_at, "producer")
            .await
    }
    pub(crate) async fn issue_recipient(
        &self,
        owner: &str,
        room: &str,
        nonce: &str,
        expires_at: u64,
    ) -> anyhow::Result<Capability> {
        self.issue_role(owner, room, nonce, expires_at, "recipient")
            .await
    }
    async fn issue_role(
        &self,
        owner: &str,
        room: &str,
        nonce: &str,
        expires_at: u64,
        role: &str,
    ) -> anyhow::Result<Capability> {
        Self::room_path("claim", room)?;
        let bytes = self
            .post(
                "/issue",
                serde_json::json!({"room":room,"role":role,"nonce":nonce,"expiresAt":expires_at}),
                Some(owner),
            )
            .await?;
        Ok(serde_json::from_slice(&bytes)?)
    }
    pub(crate) async fn publish_preview(
        &self,
        owner: &str,
        room: &str,
        expires_at: u64,
        preview: &crate::share_preview_crypto::EncryptedPreview,
    ) -> anyhow::Result<()> {
        self.post(
            &Self::room_path("preview-put", room)?,
            serde_json::json!({
                "nonce": preview.nonce, "ciphertext": preview.ciphertext, "expiresAt": expires_at
            }),
            Some(owner),
        )
        .await?;
        Ok(())
    }
    pub(crate) async fn claim(&self, room: &str, capability: &Capability) -> anyhow::Result<()> {
        self.post(
            &Self::room_path("claim", room)?,
            serde_json::to_value(capability)?,
            None,
        )
        .await?;
        Ok(())
    }
    pub(crate) async fn send(
        &self,
        room: &str,
        capability: &Capability,
        sequence: u32,
        kind: &str,
        message: &str,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            (1..=32).contains(&sequence)
                && matches!(kind, "offer" | "ice")
                && message.len() <= 4096,
            "invalid producer signal"
        );
        self.post(&Self::room_path("send", room)?, serde_json::json!({"payload":capability.payload,"signature":capability.signature,"sequence":sequence,"kind":kind,"message":message}), None).await?;
        Ok(())
    }
    pub(crate) async fn poll(
        &self,
        room: &str,
        capability: &Capability,
        after: u32,
    ) -> anyhow::Result<Vec<Signal>> {
        anyhow::ensure!(after <= 32, "invalid signal cursor");
        let bytes = self.post(&Self::room_path("poll", room)?, serde_json::json!({"payload":capability.payload,"signature":capability.signature,"after":after}), None).await?;
        let signals: Vec<Signal> = serde_json::from_slice(&bytes)?;
        anyhow::ensure!(
            signals.len() <= 32
                && signals
                    .iter()
                    .all(|signal| (1..=32).contains(&signal.sequence)
                        && matches!(signal.kind.as_str(), "answer" | "ice")
                        && signal.message.len() <= 4096),
            "invalid broker signals"
        );
        Ok(signals)
    }
    pub(crate) async fn revoke(&self, owner: &str, room: &str) -> anyhow::Result<()> {
        self.post(
            &Self::room_path("revoke", room)?,
            serde_json::json!({}),
            Some(owner),
        )
        .await?;
        Ok(())
    }

    /// Denial or network failure cancels the sender. Revocation is observed
    /// at the next poll; already queued WebRTC data cannot be recalled.
    pub(crate) async fn monitor_transfer(
        &self,
        room: &str,
        capability: &Capability,
        interval: Duration,
        cancel: tokio::sync::watch::Sender<bool>,
    ) {
        loop {
            if self.poll(room, capability, 0).await.is_err() {
                let _ = cancel.send(true);
                return;
            }
            tokio::select! {
                _ = tokio::time::sleep(interval) => {},
                _ = cancel.closed() => return,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[tokio::test]
    async fn client_handles_issuance_signals_revocation_and_errors() {
        let revoked = Arc::new(AtomicBool::new(false));
        let app = Router::new().route("/{*path}", post({ let revoked = revoked.clone(); move |Path(path): Path<String>, headers: HeaderMap, Json(body): Json<serde_json::Value>| { let revoked = revoked.clone(); async move {
            if path == "issue" { if headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok()) != Some("Bearer owner") { return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({}))); } return (StatusCode::OK, Json(serde_json::json!({"payload":body["role"],"signature":"signed"}))); }
            if path.starts_with("preview-put/") { if headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok()) != Some("Bearer owner") || body["nonce"] != "nonce" || body["ciphertext"] != "ciphertext" { return (StatusCode::FORBIDDEN, Json(serde_json::json!({}))); } return (StatusCode::NO_CONTENT, Json(serde_json::json!({}))); }
            if path.starts_with("revoke/") { revoked.store(true, Ordering::SeqCst); return (StatusCode::NO_CONTENT, Json(serde_json::json!({}))); }
            if revoked.load(Ordering::SeqCst) || body["payload"] != "producer" { return (StatusCode::FORBIDDEN, Json(serde_json::json!({}))); }
            if path.starts_with("poll/") { return (StatusCode::OK, Json(serde_json::json!([{"sequence":1,"kind":"answer","message":"sdp"}]))); }
            (StatusCode::NO_CONTENT, Json(serde_json::json!({})))
        } }}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = BrokerClient::local(&format!("http://{address}/")).unwrap();
        let room = "room____________";
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let recipient = client
            .issue_recipient("owner", room, "recipient_______", now + 60)
            .await
            .unwrap();
        assert_eq!(recipient.payload, "recipient");
        let preview = crate::share_preview_crypto::EncryptedPreview {
            nonce: "nonce".into(),
            ciphertext: "ciphertext".into(),
        };
        client
            .publish_preview("owner", room, now + 60, &preview)
            .await
            .unwrap();
        assert!(
            client
                .publish_preview("wrong", room, now + 60, &preview)
                .await
                .is_err()
        );
        assert!(
            client
                .publish_preview("owner", "../invalid", now + 60, &preview)
                .await
                .is_err()
        );
        assert!(
            crate::share_service::start(
                false,
                &client,
                "owner",
                room,
                "nonce___________",
                now + 60,
                |_, _| async { Ok(()) }
            )
            .await
            .is_err()
        );
        assert!(
            crate::share_service::start(
                true,
                &client,
                "owner",
                room,
                "nonce___________",
                now,
                |_, _| async { Ok(()) }
            )
            .await
            .is_err()
        );
        assert!(
            crate::share_service::start(
                true,
                &client,
                "wrong",
                room,
                "nonce___________",
                now + 60,
                |_, _| async { Ok(()) }
            )
            .await
            .is_err()
        );
        let (closed_tx, closed_rx) = tokio::sync::oneshot::channel();
        let session = crate::share_service::start(
            true,
            &client,
            "owner",
            room,
            "nonce___________",
            now + 60,
            move |_, mut stop| async move {
                while !*stop.borrow() {
                    stop.changed().await?;
                }
                let _ = closed_tx.send(());
                Ok(())
            },
        )
        .await
        .unwrap();
        session.stop().await.unwrap();
        closed_rx.await.unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let (expired_tx, expired_rx) = tokio::sync::oneshot::channel();
        let session = crate::share_service::start(
            true,
            &client,
            "owner",
            room,
            "nonce___________",
            now + 2,
            move |_, mut stop| async move {
                while !*stop.borrow() {
                    stop.changed().await?;
                }
                let _ = expired_tx.send(());
                Ok(())
            },
        )
        .await
        .unwrap();
        assert!(session.wait().await.is_err());
        expired_rx.await.unwrap();
        assert!(
            client
                .issue("wrong", room, "nonce___________", 99)
                .await
                .is_err()
        );
        let token = client
            .issue("owner", room, "nonce___________", 99)
            .await
            .unwrap();
        client.claim(room, &token).await.unwrap();
        client
            .send(room, &token, 1, "offer", "offer")
            .await
            .unwrap();
        assert_eq!(
            client.poll(room, &token, 0).await.unwrap()[0].message,
            "sdp"
        );
        let (cancel, mut cancelled) = tokio::sync::watch::channel(false);
        let monitor_client = client.clone();
        let monitor_token = token.clone();
        let monitor = tokio::spawn(async move {
            monitor_client
                .monitor_transfer(room, &monitor_token, Duration::from_millis(10), cancel)
                .await;
        });
        client.revoke("owner", room).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), cancelled.changed())
            .await
            .unwrap()
            .unwrap();
        assert!(*cancelled.borrow());
        monitor.await.unwrap();
        assert!(client.poll(room, &token, 0).await.is_err());
        server.abort();
    }
}
