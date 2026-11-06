//! Experimental outbound broker client. No production route instantiates it.
use crate::*;

const MAX_RESPONSE: usize = 160 * 1024;
pub(crate) const MAX_GENERATION: u64 = 9_007_199_254_740_991;

pub(crate) fn validate_generation(generation: u64) -> anyhow::Result<()> {
    anyhow::ensure!(generation <= MAX_GENERATION, "invalid signaling generation");
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Capability {
    pub(crate) payload: String,
    pub(crate) signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Claim {
    room: String,
    role: String,
    nonce: String,
    expires_at: u64,
    previous_nonce: Option<String>,
}

fn valid_identifier(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn claim(capability: &Capability, room: &str) -> anyhow::Result<Claim> {
    anyhow::ensure!(
        capability.payload.len() <= 4096
            && capability.signature.len() == 64
            && capability
                .signature
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "invalid capability encoding"
    );
    let claim: Claim = serde_json::from_str(&capability.payload)?;
    anyhow::ensure!(
        claim.room == room
            && valid_identifier(&claim.room)
            && matches!(claim.role.as_str(), "producer" | "recipient")
            && valid_identifier(&claim.nonce)
            && claim.expires_at <= MAX_GENERATION
            && claim
                .previous_nonce
                .as_ref()
                .is_none_or(|p| valid_identifier(p) && p != &claim.nonce),
        "invalid capability scope"
    );
    Ok(claim)
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
        Ok(self.post_response(path, body, owner).await?.2)
    }
    async fn post_response(
        &self,
        path: &str,
        body: serde_json::Value,
        owner: Option<&str>,
    ) -> anyhow::Result<(StatusCode, reqwest::header::HeaderMap, Vec<u8>)> {
        let mut request = self.client.post(self.base.join(path)?).json(&body);
        if let Some(owner) = owner {
            request = request.bearer_auth(owner);
        }
        let mut response = request.send().await?;
        let status = response.status();
        anyhow::ensure!(status.is_success(), "broker returned HTTP {status}");
        let headers = response.headers().clone();
        let mut data = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            anyhow::ensure!(
                data.len().saturating_add(chunk.len()) <= MAX_RESPONSE,
                "broker response exceeds limit"
            );
            data.extend_from_slice(&chunk);
        }
        Ok((status, headers, data))
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
    pub(crate) async fn reserve(
        &self,
        owner: &str,
        room: &str,
        reservation_id: &str,
        expires_at: u64,
    ) -> anyhow::Result<()> {
        self.post(
            &Self::room_path("reserve", room)?,
            serde_json::json!({"reservationId":reservation_id,"expiresAt":expires_at}),
            Some(owner),
        )
        .await?;
        Ok(())
    }
    pub(crate) async fn cleanup(
        &self,
        owner: &str,
        room: &str,
        reservation_id: &str,
        expires_at: u64,
    ) -> anyhow::Result<()> {
        self.post(
            &Self::room_path("cleanup", room)?,
            serde_json::json!({"reservationId":reservation_id,"expiresAt":expires_at}),
            Some(owner),
        )
        .await?;
        Ok(())
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
    /// The current payload is parsed for scope, not authenticated locally; the broker
    /// authenticates both claims during rotation. The caller must generate a fresh nonce.
    pub(crate) async fn issue_successor(
        &self,
        owner: &str,
        room: &str,
        current: &Capability,
        nonce: &str,
    ) -> anyhow::Result<Capability> {
        let current = claim(current, room)?;
        anyhow::ensure!(
            valid_identifier(nonce) && nonce != current.nonce,
            "invalid successor nonce"
        );
        let bytes = self
            .post(
                "/issue",
                serde_json::json!({
                    "room": room, "role": current.role, "nonce": nonce,
                    "expiresAt": current.expires_at, "previousNonce": current.nonce
                }),
                Some(owner),
            )
            .await?;
        let next: Capability = serde_json::from_slice(&bytes)?;
        let issued = claim(&next, room)?;
        anyhow::ensure!(
            issued.role == current.role
                && issued.nonce == nonce
                && issued.expires_at == current.expires_at
                && issued.previous_nonce.as_deref() == Some(current.nonce.as_str()),
            "invalid successor scope"
        );
        Ok(next)
    }

    /// A failed or malformed response may follow a successful rotation; retain both claims.
    pub(crate) async fn rotate(
        &self,
        room: &str,
        current: &Capability,
        next: &Capability,
        generation: u64,
    ) -> anyhow::Result<u64> {
        anyhow::ensure!(generation < MAX_GENERATION, "invalid signaling generation");
        let old = claim(current, room)?;
        let new = claim(next, room)?;
        anyhow::ensure!(
            old.role == new.role
                && old.expires_at == new.expires_at
                && old.nonce != new.nonce
                && new.previous_nonce.as_deref() == Some(old.nonce.as_str()),
            "invalid successor scope"
        );
        let (status, headers, _) = self.post_response(&Self::room_path("resume", room)?, serde_json::json!({
            "payload":current.payload, "signature":current.signature,
            "nextPayload":next.payload, "nextSignature":next.signature, "generation":generation
        }), None).await?;
        let expected = (generation + 1).to_string();
        anyhow::ensure!(
            status == StatusCode::NO_CONTENT
                && headers.get_all("x-signaling-generation").iter().count() == 1
                && headers
                    .get("x-signaling-generation")
                    .and_then(|h| h.to_str().ok())
                    == Some(expected.as_str()),
            "invalid rotation response; outcome may be uncertain"
        );
        Ok(generation + 1)
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
    /// Read the generation for an active claim. This is a point-in-time result;
    /// subsequent operations still need to handle rotation or revocation.
    pub(crate) async fn session_generation(
        &self,
        room: &str,
        capability: &Capability,
    ) -> anyhow::Result<u64> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Session {
            generation: u64,
        }
        let bytes = self
            .post(
                &Self::room_path("session", room)?,
                serde_json::to_value(capability)?,
                None,
            )
            .await?;
        let session: Session = serde_json::from_slice(&bytes)?;
        validate_generation(session.generation)?;
        Ok(session.generation)
    }
    pub(crate) async fn send(
        &self,
        room: &str,
        capability: &Capability,
        sequence: u32,
        kind: &str,
        message: &str,
    ) -> anyhow::Result<()> {
        self.send_generation(room, capability, 0, sequence, kind, message)
            .await
    }
    pub(crate) async fn send_generation(
        &self,
        room: &str,
        capability: &Capability,
        generation: u64,
        sequence: u32,
        kind: &str,
        message: &str,
    ) -> anyhow::Result<()> {
        validate_generation(generation)?;
        anyhow::ensure!(
            (1..=32).contains(&sequence)
                && matches!(kind, "offer" | "ice")
                && message.len() <= 4096,
            "invalid producer signal"
        );
        let mut body = serde_json::json!({"payload":capability.payload,"signature":capability.signature,"sequence":sequence,"kind":kind,"message":message});
        if generation != 0 {
            body["generation"] = generation.into();
        }
        self.post(&Self::room_path("send", room)?, body, None)
            .await?;
        Ok(())
    }
    pub(crate) async fn poll(
        &self,
        room: &str,
        capability: &Capability,
        after: u32,
    ) -> anyhow::Result<Vec<Signal>> {
        self.poll_generation(room, capability, 0, after).await
    }
    pub(crate) async fn poll_generation(
        &self,
        room: &str,
        capability: &Capability,
        generation: u64,
        after: u32,
    ) -> anyhow::Result<Vec<Signal>> {
        validate_generation(generation)?;
        anyhow::ensure!(after <= 32, "invalid signal cursor");
        let mut body = serde_json::json!({"payload":capability.payload,"signature":capability.signature,"after":after});
        if generation != 0 {
            body["generation"] = generation.into();
        }
        let bytes = self
            .post(&Self::room_path("poll", room)?, body, None)
            .await?;
        let signals: Vec<Signal> = serde_json::from_slice(&bytes)?;
        anyhow::ensure!(
            signals.len() <= 32
                && signals
                    .iter()
                    .all(|signal| (1..=32).contains(&signal.sequence)
                        && matches!(signal.kind.as_str(), "answer" | "ice")
                        && signal.message.len() <= 4096)
                && signals
                    .iter()
                    .scan(after, |last, signal| {
                        let valid = signal.sequence > *last;
                        *last = signal.sequence;
                        Some(valid)
                    })
                    .all(|valid| valid),
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
        self.monitor_transfer_generation(room, capability, 0, interval, cancel)
            .await;
    }
    pub(crate) async fn monitor_transfer_generation(
        &self,
        room: &str,
        capability: &Capability,
        generation: u64,
        interval: Duration,
        cancel: tokio::sync::watch::Sender<bool>,
    ) {
        loop {
            if self
                .poll_generation(room, capability, generation, 0)
                .await
                .is_err()
            {
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
    async fn ambiguous_rotation_can_be_checked_with_session_generation() {
        use axum::response::IntoResponse;
        let app = Router::new().route(
            "/{*path}",
            post(
                |Path(path): Path<String>, Json(body): Json<serde_json::Value>| async move {
                    if path.starts_with("resume/") {
                        // Rotation took effect, but the confirmation was lost or malformed.
                        return StatusCode::NO_CONTENT.into_response();
                    }
                    if path.starts_with("session/") {
                        if let Some(payload) = body["payload"].as_str()
                            && let Ok(claim) = serde_json::from_str::<serde_json::Value>(payload)
                        {
                            return if claim["nonce"] == "next____________" {
                                Json(serde_json::json!({"generation": 1})).into_response()
                            } else {
                                StatusCode::FORBIDDEN.into_response()
                            };
                        }
                        return match body["payload"].as_str() {
                            Some("old") => StatusCode::FORBIDDEN.into_response(),
                            Some("next") => {
                                Json(serde_json::json!({"generation": 1})).into_response()
                            }
                            Some("max") => Json(serde_json::json!({"generation": MAX_GENERATION}))
                                .into_response(),
                            Some("overflow") => {
                                Json(serde_json::json!({"generation": MAX_GENERATION + 1}))
                                    .into_response()
                            }
                            _ => Json(serde_json::json!({"generation": -1})).into_response(),
                        };
                    }
                    StatusCode::NOT_FOUND.into_response()
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = BrokerClient::local(&format!("http://{address}/")).unwrap();
        let room = "room____________";
        let current = Capability { payload: serde_json::json!({"room":room,"role":"producer","nonce":"nonce___________","expiresAt":12345}).to_string(), signature: "a".repeat(64) };
        let next = Capability { payload: serde_json::json!({"room":room,"role":"producer","nonce":"next____________","previousNonce":"nonce___________","expiresAt":12345}).to_string(), signature: "b".repeat(64) };
        assert!(client.rotate(room, &current, &next, 0).await.is_err());
        let cap = |payload: &str| Capability {
            payload: payload.into(),
            signature: "sig".into(),
        };
        assert!(client.session_generation(room, &current).await.is_err());
        assert_eq!(client.session_generation(room, &next).await.unwrap(), 1);
        assert_eq!(
            client.session_generation(room, &cap("max")).await.unwrap(),
            MAX_GENERATION
        );
        assert!(
            client
                .session_generation(room, &cap("overflow"))
                .await
                .is_err()
        );
        assert!(
            client
                .session_generation(room, &cap("negative"))
                .await
                .is_err()
        );
        server.abort();
    }

    #[tokio::test]
    async fn generation_monitor_fails_closed_and_uses_selected_generation() {
        let (requests, mut seen) = tokio::sync::mpsc::unbounded_channel();
        let app = Router::new().route(
            "/{*path}",
            post(move |Json(body): Json<serde_json::Value>| {
                let requests = requests.clone();
                async move {
                    requests.send(body).unwrap();
                    StatusCode::FORBIDDEN
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = BrokerClient::local(&format!("http://{address}/")).unwrap();
        let cap = Capability {
            payload: "p".into(),
            signature: "s".into(),
        };
        for generation in [0, 7, MAX_GENERATION + 1] {
            let (cancel, cancelled) = tokio::sync::watch::channel(false);
            client
                .monitor_transfer_generation(
                    "room____________",
                    &cap,
                    generation,
                    Duration::from_secs(1),
                    cancel,
                )
                .await;
            assert!(*cancelled.borrow());
            if generation <= MAX_GENERATION {
                let body = seen.try_recv().unwrap();
                if generation == 0 {
                    assert!(body.get("generation").is_none());
                } else {
                    assert_eq!(body["generation"], generation);
                }
            } else {
                assert!(seen.try_recv().is_err());
            }
        }
        server.abort();
    }

    #[tokio::test]
    async fn successor_and_generation_protocol() {
        use axum::response::IntoResponse;
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let app = Router::new().route("/{*path}", post({
            let seen = seen.clone();
            move |Path(path): Path<String>, headers: HeaderMap, Json(body): Json<serde_json::Value>| {
                let seen = seen.clone();
                async move {
                    seen.lock().unwrap().push((path.clone(), body.clone()));
                    if path == "issue" {
                        assert_eq!(headers.get(AUTHORIZATION).unwrap(), "Bearer owner");
                        return Json(serde_json::json!({"payload":body.to_string(),"signature":"a".repeat(64)})).into_response();
                    }
                    if path.starts_with("resume/") {
                        return (StatusCode::NO_CONTENT, [("x-signaling-generation", "1")]).into_response();
                    }
                    if path.starts_with("poll/") {
                        return Json(serde_json::json!([{"sequence":2,"kind":"answer","message":"ok"}])).into_response();
                    }
                    StatusCode::NO_CONTENT.into_response()
                }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = BrokerClient::local(&format!("http://{address}/")).unwrap();
        let room = "room____________";
        let current = Capability {
            payload: serde_json::json!({"room":room,"role":"producer","nonce":"nonce___________","expiresAt":12345}).to_string(),
            signature: "b".repeat(64),
        };
        let next = client
            .issue_successor("owner", room, &current, "next____________")
            .await
            .unwrap();
        assert_eq!(client.rotate(room, &current, &next, 0).await.unwrap(), 1);
        client
            .send_generation(room, &next, 1, 1, "offer", "sdp")
            .await
            .unwrap();
        assert_eq!(
            client.poll_generation(room, &next, 1, 1).await.unwrap()[0].message,
            "ok"
        );
        assert!(client.poll_generation(room, &next, 1, 2).await.is_err());
        assert!(client.rotate(room, &current, &next, 1).await.is_err());
        let count = seen.lock().unwrap().len();
        assert!(
            client
                .issue_successor("owner", room, &current, "nonce___________")
                .await
                .is_err()
        );
        assert!(
            client
                .issue_successor("owner", "other___________", &current, "next____________")
                .await
                .is_err()
        );
        assert!(
            client
                .rotate(room, &current, &next, MAX_GENERATION)
                .await
                .is_err()
        );
        assert!(
            client
                .send_generation(room, &next, MAX_GENERATION + 1, 1, "offer", "x")
                .await
                .is_err()
        );
        assert!(client.poll_generation(room, &next, 1, 33).await.is_err());
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), count);
        assert_eq!(seen[0].1["previousNonce"], "nonce___________");
        assert_eq!(seen[0].1["expiresAt"], 12345);
        assert_eq!(seen[1].1["nextPayload"], next.payload);
        assert_eq!(seen[1].1["generation"], 0);
        assert_eq!(seen[2].1["generation"], 1);
        assert_eq!(seen[3].1["generation"], 1);
        drop(seen);
        server.abort();
    }

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
