//! Explicit, owner-authorized restart recovery for the gated gift service.
//! Persisted assertions alone never grant access; every restart rechecks the
//! invitation, account, current library book, reserved room and broker claim.
use super::*;

/// Stop this installation's peers without revoking retained invitations. This
/// is a graceful runtime pause; the next opted-in boot rechecks all authority.
pub(crate) async fn pause_sender_runtime(state: &AppState) {
    let prefix = format!("{}:", state.server_id);
    let mut gate = INVITATION_GATE.lock().await;
    for (_, senders) in gate.iter_mut().filter(|(key, _)| key.starts_with(&prefix)) {
        for sender in senders.iter() {
            let _ = sender.cancel.send(true);
        }
    }
}

pub(super) fn recovery_store(
    state: &AppState,
) -> Result<crate::share_sender_recovery::RecoveryStore, ApiError> {
    let root = state
        .database_path
        .parent()
        .ok_or_else(|| ApiError::internal("Private sender storage is unavailable."))?;
    crate::share_sender_recovery::RecoveryStore::open(
        root,
        &state.server_id,
        selected_share_max_bytes(state),
        state.min_download_free_bytes,
    )
    .map_err(|_| ApiError::service_unavailable("Private sender recovery storage is unavailable."))
}

pub(super) async fn recoverable_rooms(
    state: &AppState,
) -> Result<HashSet<(String, String, String)>, ApiError> {
    let root = state
        .database_path
        .parent()
        .ok_or_else(|| ApiError::internal("Private sender storage is unavailable."))?;
    if !root
        .join("gift-sender-recovery")
        .try_exists()
        .map_err(|_| ApiError::internal("Cannot inspect private recovery storage."))?
    {
        return Ok(HashSet::new());
    }
    let now = share_now()? as u64;
    let records = recovery_store(state)?.list().await.map_err(|_| {
        ApiError::service_unavailable(
            "Private sender state cannot be inspected; no dormant room was cleaned.",
        )
    })?;
    Ok(records
        .into_iter()
        .filter(|record| {
            !record.cleanup_only && record.producer.is_some() && record.expires_at > now
        })
        .map(|record| (record.invitation_digest, record.broker_origin, record.room))
        .collect())
}

/// Explicit owner abandonment is distinct from retrying failed cleanup. Persist
/// revocation before cancellation/provider calls; completed recipient copies
/// are outside the sender's control and are never removed here.
pub(crate) async fn abandon_retained_senders(
    state: &AppState,
    broker: &crate::share_broker::BrokerClient,
) -> Result<usize, ApiError> {
    let gate = INVITATION_GATE.lock().await;
    let state = state.clone();
    let broker = broker.clone();
    tokio::spawn(async move { abandon_owned(state, broker, gate).await })
        .await
        .map_err(|_| ApiError::internal("Gift abandonment worker failed."))?
}

async fn abandon_owned(
    state: AppState,
    broker: crate::share_broker::BrokerClient,
    mut gate: tokio::sync::MutexGuard<'static, HashMap<String, Vec<ActiveSender>>>,
) -> Result<usize, ApiError> {
    let store = recovery_store(&state)?;
    let origin = broker.origin().origin().ascii_serialization();
    let records = store.list().await.map_err(|_| {
        ApiError::service_unavailable("Private sender recovery state is unreadable.")
    })?;
    let selected: Vec<_> = records
        .into_iter()
        .filter(|record| record.broker_origin == origin)
        .collect();
    let mut invitations = read_invitations(&state.database).await?;
    let mut abandoned = 0;
    for invitation in &mut invitations {
        if selected
            .iter()
            .any(|record| record.invitation_digest == invitation.token_digest)
        {
            invitation.revoked = true;
            for room in &mut invitation.broker_rooms {
                if room.origin == origin {
                    room.cleanup_pending = true;
                }
            }
            abandoned += 1;
        }
    }
    write_invitations(&state.database, invitations).await?;
    for record in &selected {
        if let Some(senders) = gate.get_mut(&invitation_key(&state, &record.invitation_digest)) {
            for sender in senders.iter().filter(|sender| sender.room == record.room) {
                let _ = sender.cancel.send(true);
            }
        }
    }
    // No fallible filesystem operation may prevent cancellation of another
    // invitation that was already revoked in the committed database write.
    let mut incomplete = false;
    for record in selected {
        incomplete |= store.mark_cleanup(&record.id()).await.is_err();
    }
    if incomplete {
        return Err(ApiError::service_unavailable(
            "Invitations were revoked and live senders cancelled; private cleanup remains pending.",
        ));
    }
    Ok(abandoned)
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SenderRecoveryReport {
    recovered: usize,
    already_active: usize,
    pending: usize,
}

/// The caller holds SETUP_GATE and has explicitly authorized this provider
/// action. No startup hook or production route invokes this automatically.
pub(crate) async fn recover_saved_senders(
    enabled: bool,
    state: &AppState,
    broker: &crate::share_broker::BrokerClient,
    owner_secret: &str,
    connectivity: &crate::share_connectivity::Connectivity,
) -> Result<SenderRecoveryReport, ApiError> {
    if !enabled {
        return Err(ApiError::service_unavailable(
            "Production sender recovery remains disabled.",
        ));
    }
    let mut gate = INVITATION_GATE.lock().await;
    let store = recovery_store(state)?;
    let records = store.list().await.map_err(|_| {
        ApiError::service_unavailable("Private sender recovery state is unreadable.")
    })?;
    let invitations = read_invitations(&state.database).await?;
    let origin = broker.origin().origin().ascii_serialization();
    let mut report = SenderRecoveryReport::default();
    let mut attempted = 0;
    for record in records {
        if record.broker_origin != origin {
            report.pending += 1;
            continue;
        }
        let key = invitation_key(state, &record.invitation_digest);
        if gate.get(&key).is_some_and(|senders| {
            senders
                .iter()
                .any(|sender| sender.room == record.room && sender.cancel.receiver_count() > 0)
        }) {
            report.already_active += 1;
            continue;
        }
        let now = share_now()? as u64;
        let invitation = invitations
            .iter()
            .find(|item| item.token_digest == record.invitation_digest);
        let auth = state
            .users
            .read()
            .await
            .users
            .iter()
            .find(|user| user.id == record.sender_user_id)
            .map(AuthUser::from);
        let authorized = invitation.is_some_and(|item| {
            !item.revoked
                && item.expires_at > now as i64
                && item.sender_user_id == record.sender_user_id
                && item.manifest.book_id == record.book_id
                && item.broker_rooms.iter().any(|room| {
                    room.room == record.room
                        && room.origin == origin
                        && room.expires_at == record.expires_at
                        && !room.cleanup_pending
                })
        }) && auth
            .as_ref()
            .is_some_and(|auth| require_book_access(auth, &record.book_id).is_ok())
            && state.library.read().await.book(&record.book_id).is_ok();
        if !authorized
            || record.cleanup_only
            || record.expires_at <= now
            || record.producer.is_none()
        {
            let _ = store.mark_cleanup(&record.id()).await;
            report.pending += 1;
            continue;
        }
        if attempted >= 16 {
            report.pending += 1;
            continue;
        }
        attempted += 1;
        let permit = match state.download_task_slots.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                report.pending += 1;
                continue;
            }
        };
        let invitation = invitation.expect("authorized invitation");
        let authority = crate::share_sender_recovery::RecoveryAuthority {
            invitation_digest: &invitation.token_digest,
            sender_user_id: &record.sender_user_id,
            book_id: &record.book_id,
            room: &record.room,
            broker_origin: &origin,
            invitation_expires_at: invitation.expires_at as u64,
            revoked: invitation.revoked,
            access_allowed: authorized,
        };
        let (restored, permit) = match store
            .restore_admitted(&record.id(), &authority, now, permit)
            .await
        {
            Ok(restored) => restored,
            Err(_) => {
                // A previous reader can still hold the lease while its peer
                // closes. A transient read/lock failure cannot permanently
                // discard an otherwise authorized, receipt-bound snapshot.
                report.pending += 1;
                continue;
            }
        };
        let configured = match connectivity.for_invitation(&record.gift_id, record.expires_at, now)
        {
            Ok(configured) => configured,
            Err(_) => {
                report.pending += 1;
                continue;
            }
        };
        // Rotation durably retains current and pending claims before its
        // broker write, and reconciles a lost response without replaying claim.
        let capability = match store
            .rotate_for_restart(&record.id(), broker, owner_secret)
            .await
        {
            Ok(capability) => capability,
            Err(_) => {
                report.pending += 1;
                continue;
            }
        };
        let peer_broker = broker.clone();
        let peer_room = record.room.clone();
        let retained = store.clone();
        let id = record.id();
        let session =
            crate::share_service::run_authorized(true, record.expires_at, move |stop| async move {
                let _permit = permit;
                let result = crate::share_sender::run_authenticated_sender_with_connectivity(
                    peer_broker,
                    peer_room,
                    capability,
                    restored.archive,
                    record.archive_size,
                    record.expires_at,
                    restored.authentication,
                    configured,
                    stop,
                )
                .await;
                if result.is_ok() {
                    let _ = retained.remove(&id).await;
                }
                result
            })
            .await;
        match session {
            Ok(session) => {
                gate.entry(key).or_default().push(ActiveSender {
                    cancel: session.cancellation_handle(),
                    broker: broker.clone(),
                    owner_secret: owner_secret.to_owned(),
                    room: record.room.clone(),
                    expires_at: record.expires_at,
                    reservation_id: reservation_id(
                        owner_secret,
                        &record.invitation_digest,
                        &record.room,
                    ),
                });
                tokio::spawn(async move {
                    let _ = session.wait().await;
                });
                report.recovered += 1;
            }
            Err(_) => {
                report.pending += 1;
            }
        }
    }
    Ok(report)
}

/// Remove local snapshots only after room cleanup was confirmed in the durable
/// invitation document, or expiry makes further transfer impossible. This
/// does not claim that external provider billing or backups were erased.
pub(crate) async fn prune_confirmed_recovery(state: &AppState) -> Result<(), ApiError> {
    let root = state
        .database_path
        .parent()
        .ok_or_else(|| ApiError::internal("Private sender storage is unavailable."))?;
    if !root
        .join("gift-sender-recovery")
        .try_exists()
        .map_err(|_| ApiError::internal("Cannot inspect private recovery storage."))?
    {
        return Ok(());
    }
    let _gate = INVITATION_GATE.lock().await;
    let store = recovery_store(state)?;
    let records = store
        .list()
        .await
        .map_err(|_| ApiError::internal("Private sender recovery state is unreadable."))?;
    let invitations = read_invitations(&state.database).await?;
    let now = share_now()? as u64;
    for record in records {
        let pending = invitations.iter().any(|invitation| {
            invitation.token_digest == record.invitation_digest
                && invitation
                    .broker_rooms
                    .iter()
                    .any(|room| room.room == record.room && room.origin == record.broker_origin)
        });
        if !pending || record.expires_at <= now {
            store
                .remove(&record.id())
                .await
                .map_err(|_| ApiError::internal("Private sender cleanup remains pending."))?;
        }
    }
    store
        .prune_orphans()
        .await
        .map_err(|_| ApiError::internal("Private sender cleanup remains pending."))?;
    Ok(())
}
