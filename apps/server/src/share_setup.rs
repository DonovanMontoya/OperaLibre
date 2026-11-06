//! Owner-only experimental configuration. No production route mounts these
//! handlers. Credentials stay in the private server database (and its backups),
//! never in a settings response, a shared URL, or a recipient preview.
use crate::*;

const DOCUMENT: &str = "share-owner-configuration-v1";
static SETUP_GATE: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredConfiguration {
    version: u8,
    broker_origin: String,
    owner_secret: String,
    allow_readers: bool,
    #[serde(default)]
    retain_sender_state: bool,
    #[serde(default)]
    auto_recover_senders: bool,
    #[serde(default)]
    connectivity: crate::share_connectivity::Connectivity,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConfigureGiftSharing {
    broker_origin: String,
    /// Omit to retain the existing secret. No masked sentinel is accepted.
    owner_secret: Option<String>,
    #[serde(default)]
    allow_readers: bool,
    retain_sender_state: Option<bool>,
    auto_recover_senders: Option<bool>,
    owner_controls_broker: bool,
    /// Omit to retain owner TURN secrets; GET returns only configured markers.
    connectivity: Option<crate::share_connectivity::Connectivity>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GiftSharingConfiguration {
    configured: bool,
    broker_origin: Option<String>,
    owner_secret_configured: bool,
    allow_readers: bool,
    retain_sender_state: bool,
    auto_recover_senders: bool,
    production_enabled: bool,
    connectivity: serde_json::Value,
}

fn valid_secret(secret: &str) -> bool {
    (32..=1024).contains(&secret.len()) && secret.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

fn snapshot(config: Option<&StoredConfiguration>) -> Result<GiftSharingConfiguration, ApiError> {
    Ok(GiftSharingConfiguration {
        configured: config.is_some(),
        broker_origin: config.map(|config| config.broker_origin.clone()),
        owner_secret_configured: config.is_some(),
        allow_readers: config.is_some_and(|config| config.allow_readers),
        retain_sender_state: config.is_some_and(|config| config.retain_sender_state),
        auto_recover_senders: config.is_some_and(|config| config.auto_recover_senders),
        production_enabled: false,
        connectivity: config
            .map(|config| &config.connectivity)
            .unwrap_or(&crate::share_connectivity::Connectivity::default())
            .redacted()
            .map_err(|_| ApiError::internal("Gift connectivity configuration is invalid."))?,
    })
}

async fn load(state: &AppState) -> Result<Option<StoredConfiguration>, ApiError> {
    let payload = state
        .database
        .call(|db| read_document(db, DOCUMENT))
        .await?;
    let Some(payload) = payload else {
        return Ok(None);
    };
    let config: StoredConfiguration = serde_json::from_str(&payload)
        .map_err(|_| ApiError::internal("Gift configuration is unreadable."))?;
    if config.version != 1
        || !valid_secret(&config.owner_secret)
        || config.connectivity.validate().is_err()
        || configured_broker(&config.broker_origin).is_err()
        || (config.auto_recover_senders && !config.retain_sender_state)
    {
        return Err(ApiError::internal("Gift configuration is invalid."));
    }
    Ok(Some(config))
}

pub(crate) async fn get_configuration(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<GiftSharingConfiguration>, ApiError> {
    require_owner(&auth)?;
    let _gate = SETUP_GATE.lock().await;
    Ok(Json(snapshot(load(&state).await?.as_ref())?))
}

pub(crate) async fn put_configuration(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    input: Result<Json<ConfigureGiftSharing>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<GiftSharingConfiguration>, ApiError> {
    require_owner(&auth)?;
    let Json(input) =
        input.map_err(|_| ApiError::bad_request("Invalid gift configuration request."))?;
    if !matches!(state.deployment_mode, DeploymentMode::Proxy)
        || !peer.ip().is_loopback()
        || headers
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok())
            != Some("https")
    {
        return Err(ApiError::bad_request(
            "Gift credentials require HTTPS through a trusted loopback reverse proxy in proxy deployment mode.",
        ));
    }
    let _gate = SETUP_GATE.lock().await;
    if !input.owner_controls_broker
        || input.broker_origin.len() > 512
        || input
            .broker_origin
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return Err(ApiError::bad_request(
            "Confirm an owner-controlled HTTPS broker origin.",
        ));
    }
    let broker = crate::share_broker::BrokerClient::new(&input.broker_origin).map_err(|_| {
        ApiError::bad_request("The broker must be an HTTPS origin without credentials or a path.")
    })?;
    let broker_origin = broker.origin().origin().ascii_serialization();
    let previous = load(&state).await?;
    let retain_sender_state = input.retain_sender_state.unwrap_or_else(|| {
        previous
            .as_ref()
            .is_some_and(|config| config.retain_sender_state)
    });
    let auto_recover_senders = input.auto_recover_senders.unwrap_or_else(|| {
        previous
            .as_ref()
            .is_some_and(|config| config.auto_recover_senders)
    });
    if auto_recover_senders && !retain_sender_state {
        return Err(ApiError::bad_request(
            "Automatic sender recovery requires private sender retention. Disable automatic recovery before disabling retention.",
        ));
    }
    if input.owner_secret.is_none()
        && previous
            .as_ref()
            .is_some_and(|config| config.broker_origin != broker_origin)
    {
        return Err(ApiError::bad_request(
            "Enter this broker's owner secret when changing its origin. The previous broker's secret is not reused.",
        ));
    }
    let owner_secret = input
        .owner_secret
        .or_else(|| previous.as_ref().map(|config| config.owner_secret.clone()))
        .filter(|secret| valid_secret(secret))
        .ok_or_else(|| {
            ApiError::bad_request(
                "Provide the existing broker owner secret (32–1024 printable ASCII characters).",
            )
        })?;
    crate::share::ensure_no_pending_broker_rooms(&state).await?;
    let connectivity = input
        .connectivity
        .or_else(|| previous.map(|config| config.connectivity))
        .unwrap_or_default();
    connectivity
        .validate()
        .map_err(|_| ApiError::bad_request("Invalid or unsupported gift ICE configuration."))?;
    if connectivity
        .ice_servers
        .iter()
        .any(|server| server.credential.is_some())
    {
        return Err(ApiError::bad_request(
            "Recipient relay requires a private TURN REST shared secret, not static owner credentials.",
        ));
    }
    let config = StoredConfiguration {
        version: 1,
        broker_origin,
        owner_secret,
        allow_readers: input.allow_readers,
        retain_sender_state,
        auto_recover_senders,
        connectivity,
    };
    let response = snapshot(Some(&config))?;
    let payload = serde_json::to_string(&config)
        .map_err(|_| ApiError::internal("Cannot save gift configuration."))?;
    state
        .database
        .transaction(move |db| write_document(db, DOCUMENT, &payload))
        .await?;
    Ok(Json(response))
}

pub(crate) async fn delete_configuration(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<StatusCode, ApiError> {
    require_owner(&auth)?;
    let _gate = SETUP_GATE.lock().await;
    crate::share::ensure_no_pending_broker_rooms(&state).await?;
    state
        .database
        .transaction(|db| {
            db.execute("DELETE FROM documents WHERE name = ?1", [DOCUMENT])?;
            Ok(())
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn retry_configured_cleanup(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<crate::share::RetryBrokerRevocationsResponse>, ApiError> {
    require_owner(&auth)?;
    let _gate = SETUP_GATE.lock().await;
    let config = load(&state)
        .await?
        .ok_or_else(|| ApiError::service_unavailable("No gift broker is configured."))?;
    let broker = crate::share_broker::BrokerClient::new(&config.broker_origin)
        .map_err(|_| ApiError::service_unavailable("Gift broker configuration is invalid."))?;
    // This is an explicit owner action. A saved setup alone makes no request.
    let report =
        crate::share::retry_revocations_for_owner(&state, &broker, &config.owner_secret).await?;
    crate::share::prune_confirmed_recovery(&state).await?;
    Ok(Json(report))
}

pub(crate) async fn recover_configured_senders(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<crate::share::SenderRecoveryReport>, ApiError> {
    require_owner(&auth)?;
    let _gate = SETUP_GATE.lock().await;
    let config = load(&state)
        .await?
        .ok_or_else(|| ApiError::service_unavailable("No gift broker is configured."))?;
    if !config.retain_sender_state {
        return Err(ApiError::conflict(
            "Private sender retention is not enabled.",
        ));
    }
    let broker = configured_broker(&config.broker_origin)
        .map_err(|_| ApiError::service_unavailable("Gift broker configuration is invalid."))?;
    Ok(Json(
        crate::share::recover_saved_senders(
            cfg!(test),
            &state,
            &broker,
            &config.owner_secret,
            &config.connectivity,
        )
        .await?,
    ))
}

fn configured_broker(origin: &str) -> anyhow::Result<crate::share_broker::BrokerClient> {
    // A local HTTP adapter is available only in the test executable. Released
    // server binaries still require the exact owner-configured HTTPS origin.
    #[cfg(test)]
    if let Ok(url) = reqwest::Url::parse(origin)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.origin().ascii_serialization() == origin
    {
        return crate::share_broker::BrokerClient::local(origin);
    }
    crate::share_broker::BrokerClient::new(origin)
}

#[path = "share_boot.rs"]
mod boot;
pub(crate) use boot::start_boot_recovery;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AbandonRetainedGifts {
    confirm_abandon: bool,
}

pub(crate) async fn abandon_configured_senders(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    input: Result<Json<AbandonRetainedGifts>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_owner(&auth)?;
    if !cfg!(test) {
        return Err(ApiError::service_unavailable(
            "Production gift management remains disabled.",
        ));
    }
    let Json(input) = input.map_err(|_| {
        ApiError::bad_request("Explicit retained-gift abandonment confirmation is required.")
    })?;
    if !input.confirm_abandon {
        return Err(ApiError::bad_request(
            "Explicit retained-gift abandonment confirmation is required.",
        ));
    }
    let _gate = SETUP_GATE.lock().await;
    let config = load(&state)
        .await?
        .ok_or_else(|| ApiError::service_unavailable("No gift broker is configured."))?;
    let broker = crate::share_broker::BrokerClient::new(&config.broker_origin)
        .map_err(|_| ApiError::service_unavailable("Gift broker configuration is invalid."))?;
    let abandoned = crate::share::abandon_retained_senders(&state, &broker).await?;
    let cleanup =
        crate::share::retry_revocations_for_owner(&state, &broker, &config.owner_secret).await?;
    crate::share::prune_confirmed_recovery(&state).await?;
    Ok(Json(
        serde_json::json!({"abandoned":abandoned,"completed":cleanup.completed,"pending":cleanup.pending}),
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreatedGift {
    gift_url: String,
    expires_at: i64,
    /// Returned only to the authenticated sender, never placed in the gift
    /// fragment. Revocation still requires that sender's server session.
    management_token: String,
}

struct RequestLifetime(Option<tokio::sync::watch::Sender<bool>>);
impl Drop for RequestLifetime {
    fn drop(&mut self) {
        if let Some(stop) = self.0.take() {
            let _ = stop.send(true);
        }
    }
}

/// Own the invitation until the HTTP handler observes its completed worker.
/// A completed-but-unobserved JoinHandle result must also roll back, not just a
/// worker which happened to observe the request's cancellation flag in time.
struct GiftHandoff {
    gift: Option<CreatedGift>,
    rollback: Option<(AppState, AuthUser)>,
}
impl GiftHandoff {
    fn commit(mut self) -> CreatedGift {
        drop(self.rollback.take());
        self.gift.take().expect("owned prepared gift")
    }
}
impl Drop for GiftHandoff {
    fn drop(&mut self) {
        if let (Some((state, auth)), Some(gift)) = (self.rollback.take(), self.gift.take())
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            runtime.spawn(async move {
                let _ = crate::share::revoke_share(
                    State(state),
                    Extension(auth),
                    Path(gift.management_token),
                )
                .await;
            });
        }
    }
}

#[cfg(test)]
pub(crate) fn abandon_handoff_for_test(state: AppState, auth: AuthUser, management_token: String) {
    drop(GiftHandoff {
        gift: Some(CreatedGift {
            gift_url: String::new(),
            expires_at: 0,
            management_token,
        }),
        rollback: Some((state, auth)),
    });
}

/// Dropping an awaiter cannot undo a blocking database write. Keep creation
/// owned until persistence is observed and a cancelled request is revoked.
async fn own_creation<T, F, Fut>(work: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce(tokio::sync::watch::Receiver<bool>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<T, ApiError>> + Send + 'static,
{
    let (stop, cancelled) = tokio::sync::watch::channel(false);
    let mut lifetime = RequestLifetime(Some(stop));
    let result = tokio::spawn(work(cancelled))
        .await
        .map_err(|_| ApiError::internal("Gift preparation worker failed."))?;
    drop(lifetime.0.take());
    result
}

/// A reader can use owner-configured infrastructure only after an explicit
/// owner opt-in. Setup mutation and sender registration share a gate so that
/// changing credentials cannot orphan a concurrent room reservation.
pub(crate) async fn create_configured_share(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Json(input): Json<crate::share::CreateSelectedShareRequest>,
) -> Result<Json<CreatedGift>, ApiError> {
    if !cfg!(test) {
        return Err(ApiError::service_unavailable(
            "Production gift sharing remains disabled.",
        ));
    }
    // Waiters are still cancellable HTTP requests. Admit only one owned
    // background creation instead of detaching an unbounded queue of payloads.
    let gate: tokio::sync::MutexGuard<'static, ()> = SETUP_GATE.lock().await;
    let handoff =
        own_creation(move |cancelled| create_owned(state, auth, input, cancelled, gate)).await?;
    Ok(Json(handoff.commit()))
}

async fn create_owned(
    state: AppState,
    auth: AuthUser,
    mut input: crate::share::CreateSelectedShareRequest,
    cancelled: tokio::sync::watch::Receiver<bool>,
    _gate: tokio::sync::MutexGuard<'static, ()>,
) -> Result<GiftHandoff, ApiError> {
    if *cancelled.borrow() {
        return Err(ApiError::conflict("Gift preparation was cancelled."));
    }
    require_book_access(&auth, &input.book_id)?;
    let config = load(&state).await?.ok_or_else(|| {
        ApiError::service_unavailable("The owner has not configured a gift broker.")
    })?;
    if !auth.is_owner && !config.allow_readers {
        return Err(ApiError::forbidden(
            "The owner has not enabled gifts for readers.",
        ));
    }
    let broker = crate::share_broker::BrokerClient::new(&config.broker_origin)
        .map_err(|_| ApiError::service_unavailable("Gift broker configuration is invalid."))?;
    if config.retain_sender_state {
        crate::share::prune_confirmed_recovery(&state).await?;
    }
    input.expires_in_seconds = Some(input.expires_in_seconds.unwrap_or(900).clamp(60, 900));
    let Json(invitation) = crate::share::create_selected_share(
        State(state.clone()),
        Extension(auth.clone()),
        Json(input),
    )
    .await?;
    if *cancelled.borrow() {
        let _ =
            crate::share::revoke_share(State(state), Extension(auth), Path(invitation.token)).await;
        return Err(ApiError::conflict("Gift preparation was cancelled."));
    }
    let session = match crate::share::start_invitation_sender_with_recovery(
        cfg!(test),
        &state,
        &auth,
        &invitation.token,
        &broker,
        &config.owner_secret,
        &config.connectivity,
        config.retain_sender_state,
    )
    .await
    {
        Ok(session) => session,
        Err(error) => {
            // No unusable live invitation is left behind without its bearer
            // token. Revocation persists first; failed broker cleanup remains
            // in the durable owner recovery queue.
            let _ = crate::share::revoke_share(
                State(state.clone()),
                Extension(auth.clone()),
                Path(invitation.token),
            )
            .await;
            return Err(error);
        }
    };
    if *cancelled.borrow() {
        let _ =
            crate::share::revoke_share(State(state), Extension(auth), Path(invitation.token)).await;
        drop(session);
        return Err(ApiError::conflict("Gift preparation was cancelled."));
    }
    let gift_url = session.gift_url.clone();
    let expires_at = session.expires_at as i64;
    // The session already owns bounded file/task guards. Observe completion
    // without logging peer errors that might include SDP or credentials.
    tokio::spawn(async move {
        let _ = session.wait().await;
    });
    Ok(GiftHandoff {
        gift: Some(CreatedGift {
            gift_url,
            expires_at,
            management_token: invitation.token,
        }),
        rollback: Some((state, auth)),
    })
}

#[cfg(test)]
mod ownership_tests {
    use super::*;

    #[tokio::test]
    async fn cancelled_http_waiter_keeps_worker_alive_to_observe_persistence() {
        let (entered, active) = tokio::sync::oneshot::channel();
        let (finished, done) = tokio::sync::oneshot::channel();
        let request = tokio::spawn(own_creation(move |mut cancelled| async move {
            let _ = entered.send(());
            cancelled.changed().await.unwrap();
            assert!(*cancelled.borrow());
            let _ = finished.send(());
            Err::<(), _>(ApiError::conflict("cancelled"))
        }));
        active.await.unwrap();
        request.abort();
        let _ = request.await;
        tokio::time::timeout(Duration::from_secs(1), done)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn observed_success_does_not_cancel_the_completed_worker() {
        assert_eq!(
            own_creation(|cancelled| async move {
                assert!(!*cancelled.borrow());
                Ok(42)
            })
            .await
            .unwrap(),
            42
        );
    }
}
