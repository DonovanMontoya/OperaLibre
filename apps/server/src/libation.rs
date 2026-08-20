//! Extracted from main.rs.

use crate::*;

pub(crate) const LIBATION_METADATA_SIDECAR_SUFFIX: &str = ".metadata.json";

pub(crate) const MAX_LIBATION_METADATA_BYTES: u64 = 4 * 1024 * 1024;

pub(crate) const MAX_PENDING_LIBATION_REQUESTS_PER_USER: usize = 100;

pub(crate) const MAX_TRACKED_LIBATION_REQUESTS: usize = 1_000;

pub(crate) const DEFAULT_LIBATION_AUTO_REFRESH_HOURS: u64 = 24;

pub(crate) const DEFAULT_LIBATION_READER_REFRESHES_PER_HOUR: u64 = 3;

pub(crate) const LIBATION_READER_REFRESH_WINDOW_SECONDS: u64 = 60 * 60;

pub(crate) const LIBATION_REFRESH_SCHEDULER_POLL_SECONDS: u64 = 15 * 60;

pub(crate) const LIBATION_LOGIN_SESSION_SECONDS: u64 = 10 * 60;

pub(crate) const LIBATION_LOGIN_START_TIMEOUT_SECONDS: u64 = 30;

pub(crate) const MAX_LIBATION_ACCOUNT_LABEL_CHARS: usize = 80;

pub(crate) const MAX_LIBATION_ACCOUNT_ID_CHARS: usize = 320;

pub(crate) const MAX_LIBATION_RESPONSE_URL_CHARS: usize = 16_384;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LibationAccess {
    Direct,
    #[default]
    Approval,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub(crate) struct LibationRequestStore {
    #[serde(default)]
    pub(crate) requests: Vec<LibationDownloadRequest>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibationRefreshStore {
    #[serde(default)]
    pub(crate) last_successful_scan: Option<u64>,
    #[serde(default)]
    pub(crate) manual_refreshes: HashMap<String, Vec<u64>>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedLibationAccountStore {
    #[serde(default)]
    pub(crate) accounts: Vec<ManagedLibationAccount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedLibationAccount {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) account_id: String,
    pub(crate) locale: String,
    pub(crate) added_by: String,
    pub(crate) added_at: String,
    #[serde(default = "default_libation_connection_state")]
    pub(crate) connection_state: String,
    #[serde(default)]
    pub(crate) authenticated: bool,
    #[serde(default)]
    pub(crate) last_successful_auth: Option<String>,
    #[serde(default)]
    pub(crate) last_successful_refresh: Option<String>,
    #[serde(default)]
    pub(crate) last_error: Option<String>,
}

pub(crate) fn default_libation_connection_state() -> String {
    "needs_sign_in".to_string()
}

pub(crate) struct PendingLibationLogin {
    pub(crate) profile_id: String,
    pub(crate) expires_at: u64,
    pub(crate) response_sender: std::sync::mpsc::Sender<String>,
    pub(crate) completion: tokio::sync::oneshot::Receiver<Result<String, String>>,
    pub(crate) _job_guard: OwnedMutexGuard<()>,
}

pub(crate) struct InteractiveLibationLogin {
    pub(crate) started: tokio::sync::oneshot::Receiver<Result<String, String>>,
    pub(crate) response_sender: std::sync::mpsc::Sender<String>,
    pub(crate) completion: tokio::sync::oneshot::Receiver<Result<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibationDownloadRequest {
    pub(crate) id: String,
    pub(crate) user_id: String,
    pub(crate) username: String,
    pub(crate) asin: String,
    #[serde(default)]
    pub(crate) profile_id: Option<String>,
    #[serde(default)]
    pub(crate) profile_name: Option<String>,
    #[serde(default)]
    pub(crate) catalog_id: Option<String>,
    pub(crate) title: String,
    pub(crate) status: String,
    pub(crate) requested_at: String,
    pub(crate) decided_at: Option<String>,
    pub(crate) decided_by: Option<String>,
    pub(crate) job_id: Option<String>,
}

#[derive(Debug, Deserialize)]
// Permission payloads reject unknown fields. These types all model an
// absent field as a permissive default -- a missing `allowedBookIds`
// means "no restrictions" -- so a client that misspells a key would
// otherwise silently widen a user's access and still get a 200.
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateLibationAccessRequest {
    pub(crate) libation_access: LibationAccess,
}

#[derive(Debug, Deserialize)]
// Permission payloads reject unknown fields. These types all model an
// absent field as a permissive default -- a missing `allowedBookIds`
// means "no restrictions" -- so a client that misspells a key would
// otherwise silently widen a user's access and still get a 200.
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateLibationApprovalRequest {
    pub(crate) can_approve_libation_requests: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateLibationDownloadRequest {
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) profile_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartLibationLoginRequest {
    #[serde(default)]
    pub(crate) profile_id: Option<String>,
    pub(crate) label: String,
    pub(crate) account_id: String,
    pub(crate) locale: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompleteLibationLoginRequest {
    pub(crate) response_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateLibationAccountRequest {
    pub(crate) label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibationLoginStarted {
    pub(crate) session_id: String,
    pub(crate) profile_id: String,
    pub(crate) login_url: String,
    pub(crate) expires_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecideLibationDownloadRequest {
    pub(crate) approved: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibationAccessResponse {
    pub(crate) enabled: bool,
    pub(crate) libation_access: LibationAccess,
    pub(crate) auto_refresh_hours: Option<u64>,
    pub(crate) manual_refreshes_per_hour: u64,
}

/// The raw sidecar Libation can save beside a liberated audiobook. Its schema
/// mirrors Audible responses and has changed over time, so we extract the
/// stable, user-facing fields rather than deserializing one rigid version.
#[derive(Default)]
pub(crate) struct LibationSidecarMetadata {
    pub(crate) title: Option<String>,
    pub(crate) subtitle: Option<String>,
    pub(crate) author: Option<String>,
    pub(crate) narrator: Option<String>,
    pub(crate) asin: Option<String>,
    pub(crate) summary: MetadataSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibationStatus {
    pub(crate) enabled: bool,
    pub(crate) cli_path: Option<String>,
    pub(crate) libation_files_dir: Option<String>,
    pub(crate) library_root: String,
    pub(crate) accounts: Vec<LibationAccount>,
    pub(crate) authenticated: bool,
    pub(crate) message: Option<String>,
    pub(crate) auto_refresh_hours: Option<u64>,
    pub(crate) manual_refreshes_per_hour: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibationAccount {
    pub(crate) id: String,
    pub(crate) account_id: String,
    pub(crate) name: Option<String>,
    pub(crate) locale: String,
    pub(crate) scan_library: bool,
    pub(crate) authenticated: bool,
    pub(crate) managed: bool,
    pub(crate) connection_state: String,
    pub(crate) last_successful_auth: Option<String>,
    pub(crate) last_successful_refresh: Option<String>,
    pub(crate) last_error: Option<String>,
    pub(crate) added_by: Option<String>,
    pub(crate) added_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibationBook {
    pub(crate) catalog_id: String,
    pub(crate) profile_id: String,
    pub(crate) profile_name: String,
    pub(crate) account_id: Option<String>,
    pub(crate) asin: String,
    pub(crate) title: String,
    pub(crate) subtitle: Option<String>,
    pub(crate) authors: Option<String>,
    pub(crate) narrators: Option<String>,
    pub(crate) length_minutes: Option<i64>,
    pub(crate) description: Option<String>,
    pub(crate) publisher: Option<String>,
    pub(crate) book_status: Option<String>,
    pub(crate) pdf_status: Option<String>,
    pub(crate) content_type: Option<String>,
    pub(crate) locale: Option<String>,
    pub(crate) last_downloaded: Option<String>,
    pub(crate) is_audible_plus: bool,
    pub(crate) cover_art_url: Option<String>,
    pub(crate) local_book_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct LibationExportRecord {
    #[serde(rename = "Account")]
    #[serde(alias = "AccountId")]
    pub(crate) account: Option<String>,
    #[serde(rename = "Audible Product Id")]
    #[serde(alias = "AudibleProductId")]
    pub(crate) audible_product_id: Option<String>,
    #[serde(rename = "Title")]
    pub(crate) title: Option<String>,
    #[serde(rename = "Subtitle")]
    pub(crate) subtitle: Option<String>,
    #[serde(rename = "Authors")]
    #[serde(alias = "AuthorNames")]
    pub(crate) author_names: Option<String>,
    #[serde(rename = "Narrators")]
    #[serde(alias = "NarratorNames")]
    pub(crate) narrator_names: Option<String>,
    #[serde(rename = "Length In Minutes")]
    #[serde(alias = "LengthInMinutes")]
    pub(crate) length_in_minutes: Option<i64>,
    #[serde(rename = "Description")]
    pub(crate) description: Option<String>,
    #[serde(rename = "Publisher")]
    pub(crate) publisher: Option<String>,
    #[serde(rename = "Book Liberated Status")]
    #[serde(alias = "BookStatus")]
    pub(crate) book_status: Option<String>,
    #[serde(rename = "PDF Liberated Status")]
    #[serde(alias = "PdfStatus")]
    pub(crate) pdf_status: Option<String>,
    #[serde(rename = "Content Type")]
    #[serde(alias = "ContentType")]
    pub(crate) content_type: Option<String>,
    #[serde(rename = "Locale")]
    pub(crate) locale: Option<String>,
    #[serde(rename = "Last Downloaded")]
    #[serde(alias = "LastDownloaded")]
    pub(crate) last_downloaded: Option<String>,
    #[serde(rename = "Is Audible Plus?")]
    #[serde(alias = "IsAudiblePlus")]
    pub(crate) is_audible_plus: Option<bool>,
    #[serde(rename = "Cover Id")]
    #[serde(alias = "PictureId")]
    pub(crate) picture_id: Option<String>,
    #[serde(rename = "Cover Id Large")]
    #[serde(alias = "PictureLarge")]
    pub(crate) picture_large: Option<String>,
}

pub(crate) async fn start_libation_account_login(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Json(payload): Json<StartLibationLoginRequest>,
) -> Result<Json<LibationLoginStarted>, ApiError> {
    if !state.libation_config.enabled() {
        return Err(ApiError::bad_request(
            "Libation CLI was not found. Configure libation_cli_path before adding an Audible account.",
        ));
    }
    let label = payload.label.trim();
    let account_id = payload.account_id.trim();
    let locale = payload.locale.trim().to_ascii_lowercase();
    if label.is_empty() || label.chars().count() > MAX_LIBATION_ACCOUNT_LABEL_CHARS {
        return Err(ApiError::bad_request(format!(
            "Account label must be between 1 and {MAX_LIBATION_ACCOUNT_LABEL_CHARS} characters."
        )));
    }
    if account_id.is_empty() || account_id.chars().count() > MAX_LIBATION_ACCOUNT_ID_CHARS {
        return Err(ApiError::bad_request(
            "Enter a valid Audible account email or login id.",
        ));
    }
    if !valid_libation_locale(&locale) {
        return Err(ApiError::bad_request(
            "Choose a supported Audible marketplace: us, uk, ca, de, fr, au, jp, in, or es.",
        ));
    }

    prune_expired_libation_login_sessions(&state).await;
    let added_by = auth.username.clone();
    let stored_locale = locale.clone();
    let profile_id = state
        .libation_accounts
        .mutate(move |store| {
            let locale = stored_locale;
            if let Some(requested_id) = payload.profile_id.as_deref() {
                if store.accounts.iter().any(|account| {
                    account.id != requested_id
                        && account.account_id.eq_ignore_ascii_case(account_id)
                        && account.locale == locale
                }) {
                    return Err(ApiError::conflict(
                        "That Audible account and marketplace are already configured.",
                    ));
                }
                let account = store
                    .accounts
                    .iter_mut()
                    .find(|account| account.id == requested_id)
                    .ok_or(ApiError::not_found("Audible account not found."))?;
                account.label = label.to_string();
                account.account_id = account_id.to_string();
                account.locale = locale.clone();
                account.authenticated = false;
                account.connection_state = "signing_in".to_string();
                account.last_error = None;
                Ok(account.id.clone())
            } else {
                if store.accounts.iter().any(|account| {
                    account.account_id.eq_ignore_ascii_case(account_id) && account.locale == locale
                }) {
                    return Err(ApiError::conflict(
                        "That Audible account and marketplace are already configured. Use Reconnect on the existing account.",
                    ));
                }
                let id = stable_id(&format!(
                    "libation-account:{}:{}:{}",
                    account_id,
                    locale,
                    generate_session_token()
                ));
                store.accounts.push(ManagedLibationAccount {
                    id: id.clone(),
                    label: label.to_string(),
                    account_id: account_id.to_string(),
                    locale: locale.clone(),
                    added_by,
                    added_at: now_rfc3339ish(),
                    connection_state: "signing_in".to_string(),
                    authenticated: false,
                    last_successful_auth: None,
                    last_successful_refresh: None,
                    last_error: None,
                });
                Ok(id)
            }
        })
        .await?;

    let profile_dir = state.libation_accounts_root.join(&profile_id);
    initialize_managed_libation_profile(&profile_dir, &state.library_root).await?;
    let profile_config = state.libation_config.with_files_dir(profile_dir);
    let job_guard = state.libation_job_lock.clone().lock_owned().await;
    let login = start_interactive_libation_login(profile_config, account_id.to_string(), locale)
        .map_err(ApiError::from)?;
    let login_url = match tokio::time::timeout(
        Duration::from_secs(LIBATION_LOGIN_START_TIMEOUT_SECONDS + 5),
        login.started,
    )
    .await
    {
        Ok(Ok(Ok(url))) => url,
        Ok(Ok(Err(message))) => {
            mark_managed_libation_account_error(&state, &profile_id, &message).await;
            return Err(ApiError::bad_gateway(message));
        }
        Ok(Err(_)) => {
            let message = "Libation login stopped before returning a sign-in URL.".to_string();
            mark_managed_libation_account_error(&state, &profile_id, &message).await;
            return Err(ApiError::bad_gateway(message));
        }
        Err(_) => {
            let message = "Libation did not return a sign-in URL in time.".to_string();
            mark_managed_libation_account_error(&state, &profile_id, &message).await;
            return Err(ApiError::bad_gateway(message));
        }
    };
    let session_id = generate_session_token();
    let expires_at = unix_now_seconds().saturating_add(LIBATION_LOGIN_SESSION_SECONDS);
    state.libation_login_sessions.lock().await.insert(
        session_id.clone(),
        PendingLibationLogin {
            profile_id: profile_id.clone(),
            expires_at,
            response_sender: login.response_sender,
            completion: login.completion,
            _job_guard: job_guard,
        },
    );
    Ok(Json(LibationLoginStarted {
        session_id,
        profile_id,
        login_url,
        expires_at,
    }))
}

pub(crate) async fn complete_libation_account_login(
    State(state): State<AppState>,
    _: AdminUser,
    Path(session_id): Path<String>,
    Json(payload): Json<CompleteLibationLoginRequest>,
) -> Result<Json<LibationStatus>, ApiError> {
    let response_url = validate_libation_response_url(&payload.response_url)?;
    let pending = state
        .libation_login_sessions
        .lock()
        .await
        .remove(&session_id)
        .ok_or(ApiError::not_found(
            "Audible sign-in session not found or expired.",
        ))?;
    if unix_now_seconds() > pending.expires_at {
        mark_managed_libation_account_error(
            &state,
            &pending.profile_id,
            "The Audible sign-in session expired.",
        )
        .await;
        return Err(ApiError::bad_request(
            "The Audible sign-in session expired.",
        ));
    }
    pending
        .response_sender
        .send(response_url)
        .map_err(|_| ApiError::bad_gateway("Libation stopped waiting for the Audible response."))?;
    let profile_id = pending.profile_id.clone();
    match tokio::time::timeout(Duration::from_secs(90), pending.completion).await {
        Ok(Ok(Ok(_))) => {
            secure_managed_libation_profile(&state.libation_accounts_root.join(&profile_id))
                .await?;
            mark_managed_libation_account_authenticated(&state, &profile_id).await?;
            if let Some(profile) = find_libation_profile(&state, &profile_id).await {
                match run_libation(&profile.config, vec!["scan".to_string()]).await {
                    Ok(output) if output.status.success() => {
                        mark_managed_libation_account_refreshed(&state, &profile_id).await;
                    }
                    Ok(output) => {
                        mark_managed_libation_account_scan_error(
                            &state,
                            &profile_id,
                            &command_output_text(&output),
                        )
                        .await;
                    }
                    Err(error) => {
                        mark_managed_libation_account_scan_error(
                            &state,
                            &profile_id,
                            &error.to_string(),
                        )
                        .await;
                    }
                }
            }
        }
        Ok(Ok(Err(message))) => {
            mark_managed_libation_account_error(&state, &profile_id, &message).await;
            return Err(ApiError::bad_gateway(message));
        }
        Ok(Err(_)) => {
            let message = "Libation login ended unexpectedly.";
            mark_managed_libation_account_error(&state, &profile_id, message).await;
            return Err(ApiError::bad_gateway(message));
        }
        Err(_) => {
            let message = "Libation did not finish the Audible sign-in in time.";
            mark_managed_libation_account_error(&state, &profile_id, message).await;
            return Err(ApiError::bad_gateway(message));
        }
    }
    drop(pending._job_guard);
    Ok(Json(read_libation_status(&state).await))
}

pub(crate) async fn cancel_libation_account_login(
    State(state): State<AppState>,
    _: AdminUser,
    Path(session_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let pending = state
        .libation_login_sessions
        .lock()
        .await
        .remove(&session_id);
    if let Some(pending) = pending {
        mark_managed_libation_account_error(&state, &pending.profile_id, "Sign-in was cancelled.")
            .await;
    }
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn update_libation_account(
    State(state): State<AppState>,
    _: AdminUser,
    Path(profile_id): Path<String>,
    Json(payload): Json<UpdateLibationAccountRequest>,
) -> Result<Json<LibationStatus>, ApiError> {
    let label = payload.label.trim();
    if label.is_empty() || label.chars().count() > MAX_LIBATION_ACCOUNT_LABEL_CHARS {
        return Err(ApiError::bad_request(format!(
            "Account label must be between 1 and {MAX_LIBATION_ACCOUNT_LABEL_CHARS} characters."
        )));
    }
    state
        .libation_accounts
        .mutate(|store| {
            let account = store
                .accounts
                .iter_mut()
                .find(|account| account.id == profile_id)
                .ok_or(ApiError::not_found("Audible account not found."))?;
            account.label = label.to_string();
            Ok(())
        })
        .await?;
    Ok(Json(read_libation_status(&state).await))
}

pub(crate) async fn delete_libation_account(
    State(state): State<AppState>,
    _: OwnerUser,
    Path(profile_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    {
        let sessions = state.libation_login_sessions.lock().await;
        if sessions
            .values()
            .any(|session| session.profile_id == profile_id)
        {
            return Err(ApiError::conflict(
                "Cancel or finish this account's sign-in before removing it.",
            ));
        }
    }
    if state
        .libation_requests
        .read()
        .await
        .requests
        .iter()
        .any(|request| {
            request.profile_id.as_deref() == Some(profile_id.as_str())
                && request.status == "pending"
        })
    {
        return Err(ApiError::conflict(
            "Resolve pending download requests for this Audible account before removing it.",
        ));
    }
    let _libation_guard = state.libation_job_lock.lock().await;
    state
        .libation_accounts
        .mutate(|store| {
            let before = store.accounts.len();
            store.accounts.retain(|account| account.id != profile_id);
            if store.accounts.len() == before {
                return Err(ApiError::not_found("Audible account not found."));
            }
            Ok(())
        })
        .await?;
    let profile_dir = state.libation_accounts_root.join(&profile_id);
    if profile_dir.starts_with(&state.libation_accounts_root) {
        match fs::remove_dir_all(&profile_dir).await {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) fn valid_libation_locale(locale: &str) -> bool {
    matches!(
        locale,
        "us" | "uk" | "ca" | "de" | "fr" | "au" | "jp" | "in" | "es"
    )
}

pub(crate) fn validate_libation_response_url(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > MAX_LIBATION_RESPONSE_URL_CHARS {
        return Err(ApiError::bad_request(
            "Paste the complete final Audible sign-in URL.",
        ));
    }
    let parsed = reqwest::Url::parse(value)
        .map_err(|_| ApiError::bad_request("The Audible response must be a valid URL."))?;
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if parsed.scheme() != "https" || !is_amazon_or_audible_host(&host) {
        return Err(ApiError::bad_request(
            "The response URL must be an HTTPS Amazon or Audible address.",
        ));
    }
    Ok(value.to_string())
}

pub(crate) fn is_amazon_or_audible_host(host: &str) -> bool {
    let host = host.strip_prefix("www.").unwrap_or(host);
    const MARKETPLACE_SUFFIXES: &[&str] = &[
        "com", "co.uk", "ca", "de", "fr", "com.au", "co.jp", "in", "es",
    ];
    ["amazon", "audible"].iter().any(|brand| {
        MARKETPLACE_SUFFIXES
            .iter()
            .any(|suffix| host == format!("{brand}.{suffix}"))
    })
}

pub(crate) async fn prune_expired_libation_login_sessions(state: &AppState) {
    let now = unix_now_seconds();
    state
        .libation_login_sessions
        .lock()
        .await
        .retain(|_, session| session.expires_at >= now);
}

pub(crate) async fn mark_managed_libation_account_authenticated(
    state: &AppState,
    profile_id: &str,
) -> Result<(), ApiError> {
    state
        .libation_accounts
        .mutate(|store| {
            if let Some(account) = store
                .accounts
                .iter_mut()
                .find(|account| account.id == profile_id)
            {
                account.authenticated = true;
                account.connection_state = "connected".to_string();
                account.last_successful_auth = Some(now_rfc3339ish());
                account.last_error = None;
            }
            Ok(())
        })
        .await
}

pub(crate) async fn mark_managed_libation_account_error(
    state: &AppState,
    profile_id: &str,
    message: &str,
) {
    let stored = state
        .libation_accounts
        .mutate(|store| {
            if let Some(account) = store
                .accounts
                .iter_mut()
                .find(|account| account.id == profile_id)
            {
                account.authenticated = false;
                account.connection_state = "needs_sign_in".to_string();
                account.last_error = Some(sanitize_libation_login_output(message));
            }
            Ok(())
        })
        .await;
    if let Err(error) = stored {
        tracing::warn!(
            "failed to persist Libation account health: {}",
            error.message
        );
    }
}

pub(crate) async fn mark_managed_libation_account_scan_error(
    state: &AppState,
    profile_id: &str,
    message: &str,
) {
    let stored = state
        .libation_accounts
        .mutate(|store| {
            if let Some(account) = store
                .accounts
                .iter_mut()
                .find(|account| account.id == profile_id)
            {
                account.connection_state = "error".to_string();
                account.last_error = Some(sanitize_libation_login_output(message));
            }
            Ok(())
        })
        .await;
    if let Err(error) = stored {
        tracing::warn!(
            "failed to persist Libation account scan error: {}",
            error.message
        );
    }
}

#[cfg(unix)]
pub(crate) async fn secure_managed_libation_profile(path: &FsPath) -> Result<(), ApiError> {
    use std::os::unix::fs::PermissionsExt;
    if !fs::try_exists(path).await? {
        return Ok(());
    }
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || -> io::Result<()> {
        for entry in WalkDir::new(path).follow_links(false) {
            let entry = entry?;
            let mode = if entry.file_type().is_dir() {
                0o700
            } else {
                0o600
            };
            std::fs::set_permissions(entry.path(), std::fs::Permissions::from_mode(mode))?;
        }
        Ok(())
    })
    .await
    .map_err(|error| {
        ApiError::internal(format!("Could not secure Libation account files: {error}"))
    })??;
    Ok(())
}

#[cfg(not(unix))]
pub(crate) async fn secure_managed_libation_profile(_path: &FsPath) -> Result<(), ApiError> {
    Ok(())
}

pub(crate) async fn initialize_managed_libation_profile(
    profile_dir: &FsPath,
    library_root: &FsPath,
) -> Result<(), ApiError> {
    create_private_directory(profile_dir).map_err(ApiError::from)?;
    let in_progress_dir = profile_dir.join("InProgress");
    create_private_directory(&in_progress_dir).map_err(ApiError::from)?;

    let settings_path = profile_dir.join("Settings.json");
    let mut settings = match fs::read_to_string(&settings_path).await {
        Ok(contents) => serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(
            &contents,
        )
        .map_err(|error| {
            ApiError::internal(format!(
                "The managed Libation Settings.json is invalid: {error}"
            ))
        })?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => serde_json::Map::new(),
        Err(error) => return Err(error.into()),
    };

    let books_path = library_root.to_string_lossy().to_string();
    let in_progress_path = in_progress_dir.to_string_lossy().to_string();
    let mut changed = false;
    if !settings
        .get("Books")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
    {
        settings.insert("Books".to_string(), serde_json::Value::String(books_path));
        changed = true;
    }
    if !settings
        .get("InProgress")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
    {
        settings.insert(
            "InProgress".to_string(),
            serde_json::Value::String(in_progress_path),
        );
        changed = true;
    }
    if changed {
        write_json_atomic(&settings_path, &settings).await?;
    }
    secure_managed_libation_profile(profile_dir).await
}

pub(crate) async fn libation_status(
    State(state): State<AppState>,
    _: AdminUser,
) -> Result<Json<LibationStatus>, ApiError> {
    let _libation_guard = state.libation_job_lock.lock().await;
    Ok(Json(read_libation_status(&state).await))
}

pub(crate) async fn get_libation_access(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Json<LibationAccessResponse> {
    Json(LibationAccessResponse {
        enabled: state.libation_config.enabled(),
        libation_access: if auth.is_owner {
            LibationAccess::Direct
        } else {
            auth.libation_access
        },
        auto_refresh_hours: state.libation_config.auto_refresh_hours,
        manual_refreshes_per_hour: state.libation_config.reader_refreshes_per_hour,
    })
}

pub(crate) async fn list_libation_requests(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Json<Vec<LibationDownloadRequest>> {
    let requests = state.libation_requests.read().await;
    let mut visible = requests
        .requests
        .iter()
        .filter(|request| auth.can_approve_libation_requests || request.user_id == auth.id)
        .cloned()
        .collect::<Vec<_>>();
    visible.sort_by_key(|request| {
        (
            request.status != "pending",
            std::cmp::Reverse(request.requested_at.clone()),
        )
    });
    Json(visible)
}

pub(crate) async fn create_libation_download_request(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(asin): Path<String>,
    Json(payload): Json<CreateLibationDownloadRequest>,
) -> Result<Json<LibationDownloadRequest>, ApiError> {
    if auth.libation_access != LibationAccess::Approval {
        return Err(ApiError::bad_request(
            "This account can start Libation downloads without an approval request.",
        ));
    }
    if !state.libation_config.enabled() {
        return Err(ApiError::bad_request(
            "Libation is not configured on this server.",
        ));
    }
    let asin = normalize_asin(&asin)
        .ok_or_else(|| ApiError::bad_request("Invalid Audible product id."))?;
    let profile_id = payload.profile_id.as_deref().unwrap_or("legacy");
    let profile = find_libation_profile(&state, profile_id)
        .await
        .ok_or(ApiError::not_found("Audible account not found."))?;
    let catalog_id = format!("{}:{asin}", profile.id);
    let title = payload.title.trim();
    if title.is_empty() || title.chars().count() > 500 {
        return Err(ApiError::bad_request(
            "The requested book title must be between 1 and 500 characters.",
        ));
    }

    let user_id = auth.id.clone();
    let username = auth.username.clone();
    let request = state
        .libation_requests
        .mutate(move |requests| {
            // Deduplication, the quota check, and the insert all happen inside
            // the lock so two simultaneous requests cannot both pass.
            if let Some(existing) = requests.requests.iter().find(|request| {
                request.user_id == user_id
                    && request.asin == asin
                    && request.profile_id.as_deref().unwrap_or("legacy") == profile.id
                    && request.status == "pending"
            }) {
                return Ok(existing.clone());
            }
            if requests
                .requests
                .iter()
                .filter(|request| request.user_id == user_id && request.status == "pending")
                .count()
                >= MAX_PENDING_LIBATION_REQUESTS_PER_USER
            {
                return Err(ApiError::too_many_requests(
                    "This reader has too many pending Libation requests.",
                ));
            }
            while requests.requests.len() >= MAX_TRACKED_LIBATION_REQUESTS {
                let Some(index) = requests
                    .requests
                    .iter()
                    .enumerate()
                    .filter(|(_, request)| request.status != "pending")
                    .min_by_key(|(_, request)| &request.requested_at)
                    .map(|(index, _)| index)
                else {
                    return Err(ApiError::too_many_requests(
                        "The Libation request queue is full.",
                    ));
                };
                requests.requests.remove(index);
            }
            let request = LibationDownloadRequest {
                id: stable_id(&format!(
                    "libation-request:{}:{}:{}:{}",
                    user_id,
                    profile.id,
                    asin,
                    now_rfc3339ish()
                )),
                user_id,
                username,
                asin,
                profile_id: Some(profile.id),
                profile_name: Some(profile.name),
                catalog_id: Some(catalog_id),
                title: title.to_string(),
                status: "pending".to_string(),
                requested_at: now_rfc3339ish(),
                decided_at: None,
                decided_by: None,
                job_id: None,
            };
            requests.requests.push(request.clone());
            Ok(request)
        })
        .await?;
    Ok(Json(request))
}

pub(crate) async fn decide_libation_download_request(
    State(state): State<AppState>,
    LibationApprover(auth): LibationApprover,
    Path(request_id): Path<String>,
    Json(payload): Json<DecideLibationDownloadRequest>,
) -> Result<Json<LibationDownloadRequest>, ApiError> {
    if payload.approved && !state.libation_config.enabled() {
        return Err(ApiError::bad_request(
            "Libation is not configured on this server.",
        ));
    }

    let decider_id = auth.id.clone();
    let decider_name = auth.username.clone();
    let request = state
        .libation_requests
        .mutate(move |requests| {
            let request = requests
                .requests
                .iter_mut()
                .find(|request| request.id == request_id)
                .ok_or(ApiError::not_found("Download request not found."))?;
            if request.user_id == decider_id {
                return Err(ApiError::forbidden(
                    "A requester cannot decide their own Libation request.",
                ));
            }
            if request.status != "pending" {
                return Err(ApiError::conflict(
                    "This download request has already been decided.",
                ));
            }
            request.status = if payload.approved {
                "approved"
            } else {
                "rejected"
            }
            .to_string();
            request.decided_at = Some(now_rfc3339ish());
            request.decided_by = Some(decider_name);
            Ok(request.clone())
        })
        .await?;

    if !payload.approved {
        return Ok(Json(request));
    }

    let created = match start_libation_download(
        &state,
        request.profile_id.clone(),
        request.asin.clone(),
        Some(request.user_id.clone()),
    )
    .await
    {
        Ok(created) => created.0,
        Err(error) => {
            let _ = state
                .libation_requests
                .mutate(|requests| {
                    if let Some(stored) = requests
                        .requests
                        .iter_mut()
                        .find(|item| item.id == request.id)
                    {
                        stored.status = "pending".to_string();
                        stored.decided_at = None;
                        stored.decided_by = None;
                    }
                    Ok(())
                })
                .await;
            return Err(error);
        }
    };
    let response = state
        .libation_requests
        .mutate(|requests| {
            let stored = requests
                .requests
                .iter_mut()
                .find(|item| item.id == request.id)
                .ok_or(ApiError::not_found("Download request not found."))?;
            stored.job_id = Some(created.job_id);
            Ok(stored.clone())
        })
        .await?;
    schedule_libation_request_completion(
        state.clone(),
        response.id.clone(),
        response.job_id.clone().unwrap_or_default(),
    );
    Ok(Json(response))
}

pub(crate) fn schedule_libation_request_completion(
    state: AppState,
    request_id: String,
    job_id: String,
) {
    tokio::spawn(async move {
        let final_status = loop {
            let status = state
                .jobs
                .read()
                .await
                .get(&job_id)
                .map(|job| job.status.clone());
            match status.as_deref() {
                Some("completed") => break "completed",
                Some("failed") | None => break "failed",
                _ => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
            }
        };
        let stored = state
            .libation_requests
            .mutate(|requests| {
                let Some(request) = requests
                    .requests
                    .iter_mut()
                    .find(|request| request.id == request_id && request.status == "approved")
                else {
                    return Ok(false);
                };
                request.status = final_status.to_string();
                Ok(true)
            })
            .await;
        if let Err(error) = stored {
            tracing::warn!(
                "failed to persist Libation request completion: {}",
                error.message
            );
        }
    });
}

pub(crate) async fn list_libation_books(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<Vec<LibationBook>>, ApiError> {
    if !state.libation_config.enabled() {
        return Err(ApiError::bad_request(
            "Libation CLI was not found. Set libation_cli_path in server.config or put libationcli on PATH.",
        ));
    }
    let profiles = all_libation_profiles(&state).await;
    let mut books = Vec::new();
    let mut profile_labels = HashMap::<String, String>::new();
    let mut first_error = None;
    {
        let _libation_guard = state.libation_job_lock.lock().await;
        for profile in profiles {
            if profile.managed {
                profile_labels.insert(profile.id.clone(), profile.name.clone());
            } else if let Ok(output) = run_libation(
                &profile.config,
                vec!["list-accounts".to_string(), "--bare".to_string()],
            )
            .await
                && output.status.success()
            {
                for account in parse_libation_accounts(&String::from_utf8_lossy(&output.stdout)) {
                    if let Some(label) = account.name {
                        profile_labels.insert(account.id, label);
                    }
                }
            }
            match export_libation_books(&profile).await {
                Ok(mut profile_books) => books.append(&mut profile_books),
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
    }
    if books.is_empty()
        && let Some(error) = first_error
    {
        return Err(error);
    }
    let library = state.library.read().await;
    for book in books.iter_mut() {
        if let Some(label) = profile_labels.get(&book.profile_id) {
            book.profile_name = label.clone();
        }
        if !auth.is_admin {
            book.account_id = None;
        }
        book.local_book_id = match_local_book(&library.books, book);
        if !auth.is_admin
            && book
                .local_book_id
                .as_deref()
                .is_some_and(|book_id| !can_access_book(&auth, book_id))
        {
            book.local_book_id = None;
        }
        if let Some(local_book_id) = &book.local_book_id
            && library.cover_art.contains_key(local_book_id)
        {
            book.cover_art_url = Some(format!("/api/books/{local_book_id}/cover"));
        }
    }
    Ok(Json(books))
}

pub(crate) fn valid_libation_picture_id(picture_id: &str) -> bool {
    !picture_id.is_empty()
        && picture_id.len() <= 200
        && picture_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'+'))
}

pub(crate) fn libation_cover_art_url(picture_id: Option<&str>) -> Option<String> {
    let picture_id = picture_id?.trim();
    valid_libation_picture_id(picture_id).then(|| format!("/api/libation/covers/{picture_id}"))
}

pub(crate) fn libation_cover_art_url_from_ids(
    picture_large: Option<&str>,
    picture_id: Option<&str>,
) -> Option<String> {
    libation_cover_art_url(picture_large).or_else(|| libation_cover_art_url(picture_id))
}

pub(crate) async fn get_libation_cover_art(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(picture_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let _ = auth;
    if !valid_libation_picture_id(&picture_id) {
        return Err(ApiError::not_found("Libation cover art not found"));
    }

    let mut files_dirs = state
        .libation_config
        .libation_files_dir
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    files_dirs.extend(
        state
            .libation_accounts
            .read()
            .await
            .accounts
            .iter()
            .map(|account| state.libation_accounts_root.join(&account.id)),
    );
    for files_dir in files_dirs {
        let images_dir = files_dir.join("Images");
        for suffix in ["Native", "_500x500", "_300x300", "_80x80"] {
            let path = images_dir.join(format!("{picture_id}{suffix}.jpg"));
            match fs::read(&path).await {
                Ok(data) if !data.is_empty() => {
                    let etag = bytes_etag(&data);
                    if if_none_match_matches(&headers, &etag) {
                        return Ok(Response::builder()
                            .status(StatusCode::NOT_MODIFIED)
                            .header(ETAG, etag)
                            .header(CACHE_CONTROL, COVER_CACHE_CONTROL)
                            .body(Body::empty())?);
                    }
                    return Ok(Response::builder()
                        .status(StatusCode::OK)
                        .header(CONTENT_TYPE, "image/jpeg")
                        .header(CONTENT_LENGTH, data.len().to_string())
                        .header(ETAG, etag)
                        .header(CACHE_CONTROL, COVER_CACHE_CONTROL)
                        .body(Body::from(data))?);
                }
                Ok(_) => continue,
                Err(_) => continue,
            }
        }
    }

    let cdn_url =
        format!("https://images-na.ssl-images-amazon.com/images/I/{picture_id}._SL300_.jpg");
    Ok(Redirect::temporary(&cdn_url).into_response())
}

pub(crate) fn match_local_book(
    local_books: &[Book],
    libation_book: &LibationBook,
) -> Option<String> {
    let target_asin = normalize_asin(&libation_book.asin);
    if let Some(asin) = target_asin.as_ref()
        && let Some(matched) = local_books
            .iter()
            .find(|book| book.asin.as_deref() == Some(asin.as_str()))
    {
        return Some(matched.id.clone());
    }

    let target_key = normalize_match_key(&libation_book.title);
    if target_key.is_empty() {
        return None;
    }

    local_books
        .iter()
        .find(|book| {
            let candidate = normalize_match_key(&book.title);
            !candidate.is_empty() && titles_match(&candidate, &target_key)
        })
        .map(|book| book.id.clone())
}

pub(crate) fn titles_match(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let shorter = if a.len() <= b.len() { a } else { b };
    let longer = if a.len() <= b.len() { b } else { a };
    let prefix = format!("{shorter} ");
    longer.starts_with(&prefix)
}

pub(crate) fn normalize_match_key(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|character| character.is_alphanumeric() || character.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) async fn sync_libation_library(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<JobCreated>, ApiError> {
    if !state.libation_config.enabled() {
        return Err(ApiError::bad_request(
            "Libation CLI was not found. Set libation_cli_path in server.config or put libationcli on PATH.",
        ));
    }

    let (job_id, created) = reserve_manual_libation_refresh(&state, &auth).await?;
    if created {
        spawn_libation_sync_job(state.clone(), job_id.clone());
    }
    Ok(Json(JobCreated { job_id }))
}

pub(crate) async fn reserve_manual_libation_refresh(
    state: &AppState,
    auth: &AuthUser,
) -> Result<(String, bool), ApiError> {
    if auth.is_admin {
        return Ok(create_libation_job(state, "libation-sync", None).await);
    }

    if let Some(job_id) = active_libation_sync_job(state).await {
        return Ok((job_id, false));
    }

    let now = unix_now_seconds();
    let refresh_limit = state.libation_config.reader_refreshes_per_hour;
    let refresh_limit_count = usize::try_from(refresh_limit).unwrap_or(usize::MAX);

    // The slot is reserved before the job is created rather than recorded
    // after it. Checking the quota and taking the slot happen in one locked
    // step, so two simultaneous refreshes cannot both pass a quota with room
    // for one. If no job actually starts, the slot is handed back below.
    if refresh_limit > 0 {
        state
            .libation_refreshes
            .mutate(|refreshes| {
                for timestamps in refreshes.manual_refreshes.values_mut() {
                    timestamps.retain(|timestamp| {
                        now.saturating_sub(*timestamp) < LIBATION_READER_REFRESH_WINDOW_SECONDS
                    });
                }
                refreshes
                    .manual_refreshes
                    .retain(|_, timestamps| !timestamps.is_empty());

                let timestamps = refreshes
                    .manual_refreshes
                    .entry(auth.id.clone())
                    .or_default();
                if timestamps.len() >= refresh_limit_count
                    && let Some(first_refresh) = timestamps.first()
                {
                    let elapsed = now.saturating_sub(*first_refresh);
                    let remaining_minutes =
                        (LIBATION_READER_REFRESH_WINDOW_SECONDS - elapsed).div_ceil(60);
                    return Err(ApiError::too_many_requests(format!(
                        "You have used all {refresh_limit} Audible refreshes for this hour. Try again in {remaining_minutes} minute{}.",
                        if remaining_minutes == 1 { "" } else { "s" }
                    )));
                }
                timestamps.push(now);
                Ok(())
            })
            .await?;
    }

    let (job_id, created) = create_libation_job(state, "libation-sync", None).await;
    if !created && refresh_limit > 0 {
        // An existing job was joined instead of a new one starting, so the
        // reservation is released rather than counted against the reader.
        let released = state
            .libation_refreshes
            .mutate(|refreshes| {
                if let Some(timestamps) = refreshes.manual_refreshes.get_mut(&auth.id)
                    && let Some(index) = timestamps.iter().rposition(|timestamp| *timestamp == now)
                {
                    timestamps.remove(index);
                }
                Ok(())
            })
            .await;
        if let Err(error) = released {
            tracing::warn!(
                "failed to release an unused Libation refresh slot: {}",
                error.message
            );
        }
    }
    Ok((job_id, created))
}

pub(crate) async fn active_libation_sync_job(state: &AppState) -> Option<String> {
    state
        .jobs
        .read()
        .await
        .values()
        .filter(|job| job.kind == "libation-sync" && is_active_job(job))
        .max_by_key(|job| job_started_timestamp(job))
        .map(|job| job.id.clone())
}

pub(crate) fn spawn_libation_sync_job(state: AppState, job_id: String) {
    let state_for_job = state.clone();
    let job_id_for_task = job_id;
    tokio::spawn(async move {
        let _libation_guard = state_for_job.libation_job_lock.lock().await;
        update_job_running(&state_for_job, &job_id_for_task).await;
        update_job_output(
            &state_for_job,
            &job_id_for_task,
            "Starting Libation library scan.\n",
        )
        .await;
        let profiles = all_libation_profiles(&state_for_job).await;
        let mut failures = Vec::new();
        let mut exit_code = Some(0);
        for profile in profiles {
            update_job_output(
                &state_for_job,
                &job_id_for_task,
                &format!("\nChecking {}.\n", profile.name),
            )
            .await;
            match run_libation(&profile.config, vec!["scan".to_string()]).await {
                Ok(output) if output.status.success() => {
                    append_job_command_output(&state_for_job, &job_id_for_task, &output).await;
                    if profile.managed {
                        mark_managed_libation_account_refreshed(&state_for_job, &profile.id).await;
                    }
                }
                Ok(output) => {
                    exit_code = output.status.code();
                    append_job_command_output(&state_for_job, &job_id_for_task, &output).await;
                    let message = format!("{} could not be refreshed.", profile.name);
                    if profile.managed {
                        mark_managed_libation_account_error(
                            &state_for_job,
                            &profile.id,
                            &command_output_text(&output),
                        )
                        .await;
                    }
                    failures.push(message);
                }
                Err(error) => {
                    exit_code = None;
                    if profile.managed {
                        mark_managed_libation_account_error(
                            &state_for_job,
                            &profile.id,
                            &error.to_string(),
                        )
                        .await;
                    }
                    failures.push(format!("{}: {error}", profile.name));
                }
            }
        }
        if failures.is_empty() {
            record_successful_libation_scan(&state_for_job).await;
            update_job_finished(
                &state_for_job,
                &job_id_for_task,
                "completed",
                exit_code,
                None,
            )
            .await;
        } else {
            update_job_finished(
                &state_for_job,
                &job_id_for_task,
                "failed",
                exit_code,
                Some(failures.join(" ")),
            )
            .await;
        }
    });
}

pub(crate) async fn mark_managed_libation_account_refreshed(state: &AppState, profile_id: &str) {
    let stored = state
        .libation_accounts
        .mutate(|store| {
            if let Some(account) = store
                .accounts
                .iter_mut()
                .find(|account| account.id == profile_id)
            {
                account.authenticated = true;
                account.connection_state = "connected".to_string();
                account.last_successful_refresh = Some(now_rfc3339ish());
                account.last_error = None;
            }
            Ok(())
        })
        .await;
    if let Err(error) = stored {
        tracing::warn!(
            "failed to persist Libation refresh health: {}",
            error.message
        );
    }
}

pub(crate) async fn record_successful_libation_scan(state: &AppState) {
    let stored = state
        .libation_refreshes
        .mutate(|refreshes| {
            refreshes.last_successful_scan = Some(unix_now_seconds());
            Ok(())
        })
        .await;
    if let Err(error) = stored {
        tracing::warn!(
            "failed to persist successful Libation refresh: {}",
            error.message
        );
    }
}

pub(crate) fn schedule_automatic_libation_refresh(state: AppState) {
    let Some(interval_hours) = state.libation_config.auto_refresh_hours else {
        return;
    };
    if !state.libation_config.enabled() {
        return;
    }

    tokio::spawn(async move {
        let interval_seconds = interval_hours.saturating_mul(60 * 60);
        let poll_seconds = interval_seconds.clamp(1, LIBATION_REFRESH_SCHEDULER_POLL_SECONDS);
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(poll_seconds));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            timer.tick().await;
            let due = {
                let refreshes = state.libation_refreshes.read().await;
                refreshes
                    .last_successful_scan
                    .is_none_or(|last| unix_now_seconds().saturating_sub(last) >= interval_seconds)
            };
            if !due {
                continue;
            }

            let (job_id, created) = create_libation_job(&state, "libation-sync", None).await;
            if created {
                tracing::info!(
                    interval_hours,
                    "starting scheduled Libation library refresh"
                );
                spawn_libation_sync_job(state.clone(), job_id);
            }
        }
    });
}

pub(crate) async fn liberate_libation_book(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(asin): Path<String>,
) -> Result<Json<JobCreated>, ApiError> {
    let asin = normalize_asin(&asin)
        .ok_or_else(|| ApiError::bad_request("Invalid Audible product id."))?;
    if auth.libation_access != LibationAccess::Direct {
        return Err(ApiError::forbidden(
            "This account must request approval for Libation downloads.",
        ));
    }
    let grant_to_user = (!auth.is_admin).then_some(auth.id);
    start_libation_download(&state, None, asin, grant_to_user).await
}

pub(crate) async fn liberate_profile_libation_book(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path((profile_id, asin)): Path<(String, String)>,
) -> Result<Json<JobCreated>, ApiError> {
    let asin = normalize_asin(&asin)
        .ok_or_else(|| ApiError::bad_request("Invalid Audible product id."))?;
    if auth.libation_access != LibationAccess::Direct {
        return Err(ApiError::forbidden(
            "This account must request approval for Libation downloads.",
        ));
    }
    let grant_to_user = (!auth.is_admin).then_some(auth.id);
    start_libation_download(&state, Some(profile_id), asin, grant_to_user).await
}

pub(crate) async fn start_libation_download(
    state: &AppState,
    profile_id: Option<String>,
    asin: String,
    grant_to_user: Option<String>,
) -> Result<Json<JobCreated>, ApiError> {
    if !state.libation_config.enabled() {
        return Err(ApiError::bad_request(
            "Libation CLI was not found. Set libation_cli_path in server.config or put libationcli on PATH.",
        ));
    }

    let profile = if let Some(profile_id) = profile_id.as_deref() {
        find_libation_profile(state, profile_id)
            .await
            .ok_or(ApiError::not_found("Audible account not found."))?
    } else {
        all_libation_profiles(state)
            .await
            .into_iter()
            .next()
            .ok_or(ApiError::bad_request("No Audible accounts are configured."))?
    };
    let config = profile.config.clone();
    let catalog_id = format!("{}:{asin}", profile.id);

    if let Some(user_id) = grant_to_user.as_deref() {
        let local_book_id = state
            .library
            .read()
            .await
            .books
            .iter()
            .find(|book| {
                book.asin
                    .as_deref()
                    .is_some_and(|candidate| candidate.eq_ignore_ascii_case(&asin))
            })
            .map(|book| book.id.clone());
        if let Some(book_id) = local_book_id {
            grant_user_book_access(state, user_id, &book_id).await?;
            let (job_id, _) = create_job_with_state(
                state,
                "libation-access-grant",
                Some(catalog_id),
                "running",
                false,
            )
            .await;
            update_job_finished(state, &job_id, "completed", None, None).await;
            return Ok(Json(JobCreated { job_id }));
        }
    }

    let (job_id, created) =
        create_libation_job(state, "libation-liberate", Some(catalog_id.clone())).await;
    if let Some(user_id) = grant_to_user {
        schedule_libation_access_grant(state.clone(), job_id.clone(), asin.clone(), user_id);
    }
    if !created {
        return Ok(Json(JobCreated { job_id }));
    }
    let state_for_job = state.clone();
    let job_id_for_task = job_id.clone();
    tokio::spawn(async move {
        let _libation_guard = state_for_job.libation_job_lock.lock().await;
        update_job_running(&state_for_job, &job_id_for_task).await;
        update_job_output(
            &state_for_job,
            &job_id_for_task,
            &format!(
                "Starting Libation liberation for {asin} from {}.\n",
                profile.name
            ),
        )
        .await;

        let books_override = format!("Books={}", config.library_root.to_string_lossy());
        let result = run_libation(
            &config,
            vec![
                "liberate".to_string(),
                "--force".to_string(),
                "--id".to_string(),
                asin.clone(),
                "--override".to_string(),
                books_override,
            ],
        )
        .await;

        match result {
            Ok(output) if output.status.success() => {
                append_job_command_output(&state_for_job, &job_id_for_task, &output).await;
                if let Err(error) = rescan_library(&state_for_job).await {
                    update_job_finished(
                        &state_for_job,
                        &job_id_for_task,
                        "failed",
                        output.status.code(),
                        Some(format!(
                            "Download completed, but local rescan failed: {error}"
                        )),
                    )
                    .await;
                    return;
                }
                let downloaded_book_found =
                    state_for_job.library.read().await.books.iter().any(|book| {
                        book.asin
                            .as_deref()
                            .is_some_and(|local_asin| local_asin.eq_ignore_ascii_case(&asin))
                    });
                if !downloaded_book_found {
                    update_job_finished(
                        &state_for_job,
                        &job_id_for_task,
                        "failed",
                        output.status.code(),
                        Some(format!(
                            "Libation finished, but {asin} was not found in the OperaLibre library after rescanning."
                        )),
                    )
                    .await;
                    return;
                }
                if profile.managed {
                    mark_managed_libation_account_refreshed(&state_for_job, &profile.id).await;
                }
                update_job_finished(
                    &state_for_job,
                    &job_id_for_task,
                    "completed",
                    output.status.code(),
                    None,
                )
                .await;
            }
            Ok(output) => {
                append_job_command_output(&state_for_job, &job_id_for_task, &output).await;
                if profile.managed {
                    mark_managed_libation_account_scan_error(
                        &state_for_job,
                        &profile.id,
                        &command_output_text(&output),
                    )
                    .await;
                }
                update_job_finished(
                    &state_for_job,
                    &job_id_for_task,
                    "failed",
                    output.status.code(),
                    Some("Libation liberation failed.".to_string()),
                )
                .await;
            }
            Err(error) => {
                if profile.managed {
                    mark_managed_libation_account_scan_error(
                        &state_for_job,
                        &profile.id,
                        &error.to_string(),
                    )
                    .await;
                }
                update_job_finished(
                    &state_for_job,
                    &job_id_for_task,
                    "failed",
                    None,
                    Some(error.to_string()),
                )
                .await;
            }
        }
    });

    Ok(Json(JobCreated { job_id }))
}

pub(crate) fn schedule_libation_access_grant(
    state: AppState,
    job_id: String,
    asin: String,
    user_id: String,
) {
    tokio::spawn(async move {
        loop {
            let status = state
                .jobs
                .read()
                .await
                .get(&job_id)
                .map(|job| job.status.clone());
            match status.as_deref() {
                Some("completed") => break,
                Some("failed") | None => return,
                _ => tokio::time::sleep(std::time::Duration::from_millis(50)).await,
            }
        }

        let book_id = state
            .library
            .read()
            .await
            .books
            .iter()
            .find(|book| {
                book.asin
                    .as_deref()
                    .is_some_and(|candidate| candidate.eq_ignore_ascii_case(&asin))
            })
            .map(|book| book.id.clone());
        let Some(book_id) = book_id else { return };

        if let Err(error) = grant_user_book_access(&state, &user_id, &book_id).await {
            tracing::warn!(
                "failed to grant requested Libation book access: {}",
                error.message
            );
        }
    });
}

pub(crate) async fn grant_user_book_access(
    state: &AppState,
    user_id: &str,
    book_id: &str,
) -> Result<(), ApiError> {
    state
        .users
        .mutate(|users| {
            let user = users
                .users
                .iter_mut()
                .find(|user| user.id == user_id)
                .ok_or(ApiError::not_found("User not found."))?;
            let Some(allowed_book_ids) = user.allowed_book_ids.as_mut() else {
                return Ok(());
            };
            if allowed_book_ids
                .iter()
                .any(|candidate| candidate == book_id)
            {
                return Ok(());
            }
            allowed_book_ids.push(book_id.to_string());
            Ok(())
        })
        .await
}

pub(crate) async fn liberate_all_libation_books(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
) -> Result<Json<JobCreated>, ApiError> {
    if auth.libation_access != LibationAccess::Direct {
        return Err(ApiError::forbidden(
            "This administrator must request approval for Libation downloads.",
        ));
    }
    if !state.libation_config.enabled() {
        return Err(ApiError::bad_request(
            "Libation CLI was not found. Set libation_cli_path in server.config or put libationcli on PATH.",
        ));
    }

    let (job_id, created) = create_libation_job(&state, "libation-liberate-all", None).await;
    if !created {
        return Ok(Json(JobCreated { job_id }));
    }
    let state_for_job = state.clone();
    let job_id_for_task = job_id.clone();
    tokio::spawn(async move {
        let _libation_guard = state_for_job.libation_job_lock.lock().await;
        update_job_running(&state_for_job, &job_id_for_task).await;
        update_job_output(
            &state_for_job,
            &job_id_for_task,
            "Starting Libation library scan before downloading all books.\n",
        )
        .await;

        let profiles = all_libation_profiles(&state_for_job).await;
        let mut failures = Vec::new();
        let mut exit_code = Some(0);
        for profile in profiles {
            update_job_output(
                &state_for_job,
                &job_id_for_task,
                &format!("\nScanning {}.\n", profile.name),
            )
            .await;
            match run_libation(&profile.config, vec!["scan".to_string()]).await {
                Ok(output) if output.status.success() => {
                    append_job_command_output(&state_for_job, &job_id_for_task, &output).await;
                    if profile.managed {
                        mark_managed_libation_account_refreshed(&state_for_job, &profile.id).await;
                    }
                }
                Ok(output) => {
                    exit_code = output.status.code();
                    append_job_command_output(&state_for_job, &job_id_for_task, &output).await;
                    failures.push(format!("{} scan failed", profile.name));
                    continue;
                }
                Err(error) => {
                    exit_code = None;
                    failures.push(format!("{} scan failed: {error}", profile.name));
                    continue;
                }
            }

            update_job_output(
                &state_for_job,
                &job_id_for_task,
                &format!("Downloading remaining books from {}.\n", profile.name),
            )
            .await;
            let books_override = format!("Books={}", profile.config.library_root.to_string_lossy());
            match run_libation(
                &profile.config,
                vec![
                    "liberate".to_string(),
                    "--override".to_string(),
                    books_override,
                ],
            )
            .await
            {
                Ok(output) if output.status.success() => {
                    append_job_command_output(&state_for_job, &job_id_for_task, &output).await;
                }
                Ok(output) => {
                    exit_code = output.status.code();
                    append_job_command_output(&state_for_job, &job_id_for_task, &output).await;
                    failures.push(format!("{} download failed", profile.name));
                }
                Err(error) => {
                    exit_code = None;
                    failures.push(format!("{} download failed: {error}", profile.name));
                }
            }
        }
        if let Err(error) = rescan_library(&state_for_job).await {
            failures.push(format!("Local library rescan failed: {error}"));
        }
        if failures.is_empty() {
            record_successful_libation_scan(&state_for_job).await;
            update_job_finished(
                &state_for_job,
                &job_id_for_task,
                "completed",
                exit_code,
                None,
            )
            .await;
        } else {
            update_job_finished(
                &state_for_job,
                &job_id_for_task,
                "failed",
                exit_code,
                Some(failures.join(". ")),
            )
            .await;
        }
    });

    Ok(Json(JobCreated { job_id }))
}

pub(crate) fn libation_sidecar_for_group(
    group_key: &FsPath,
    grouped_files: &[PathBuf],
) -> Option<LibationSidecarMetadata> {
    let directory = grouped_files.first()?.parent()?;
    let mut candidates = std::fs::read_dir(directory)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.to_ascii_lowercase()
                        .ends_with(LIBATION_METADATA_SIDECAR_SUFFIX)
                })
        })
        .collect::<Vec<_>>();
    candidates.sort();

    let known_asins = grouped_files
        .iter()
        .filter_map(|path| extract_asin_from_path(path))
        .collect::<HashSet<_>>();
    let audio_stems = grouped_files
        .iter()
        .filter_map(|path| path.file_stem().and_then(|name| name.to_str()))
        .map(normalize_match_key)
        .collect::<Vec<_>>();
    let group_stem = group_key
        .file_stem()
        .and_then(|name| name.to_str())
        .map(normalize_match_key);

    let mut parsed = candidates
        .into_iter()
        .filter_map(|path| {
            let metadata = std::fs::metadata(&path).ok()?;
            if metadata.len() > MAX_LIBATION_METADATA_BYTES {
                return None;
            }
            let contents = std::fs::read_to_string(&path).ok()?;
            Some((path, parse_libation_sidecar(&contents)?))
        })
        .collect::<Vec<_>>();

    let owns_sidecar = |path: &FsPath, sidecar: &LibationSidecarMetadata| {
        if sidecar
            .asin
            .as_ref()
            .is_some_and(|asin| known_asins.contains(asin))
        {
            return true;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            return false;
        };
        let stem_key =
            normalize_match_key(&name[..name.len() - LIBATION_METADATA_SIDECAR_SUFFIX.len()]);
        Some(&stem_key) == group_stem.as_ref() || audio_stems.iter().any(|stem| stem == &stem_key)
    };

    // Only a book that owns its folder may claim a sidecar that names neither
    // its ASIN nor its files. Loose files in `library_root` share a directory
    // with every other loose book, so an unrelated record must not win there.
    let selected = parsed
        .iter()
        .position(|(path, sidecar)| owns_sidecar(path, sidecar))
        .or_else(|| {
            (group_key.is_dir() && known_asins.is_empty() && !parsed.is_empty()).then_some(0)
        })?;
    Some(parsed.swap_remove(selected).1)
}

pub(crate) fn parse_libation_sidecar(contents: &str) -> Option<LibationSidecarMetadata> {
    let value: serde_json::Value = serde_json::from_str(contents).ok()?;
    let title = sidecar_string(&value, &["title", "title_name"]);
    let asin = sidecar_string(&value, &["asin", "audible_product_id", "product_id"])
        .and_then(|value| normalize_asin(&value));
    let series = sidecar_series(&value);
    let genres = sidecar_strings(
        &value,
        &["genres", "genre", "category_ladders", "categories"],
    );
    let metadata = MetadataSummary {
        album: title.clone(),
        subtitle: sidecar_string(&value, &["subtitle"]),
        publisher: sidecar_string(&value, &["publisher_name", "publisher"]),
        published_date: sidecar_string(
            &value,
            &["publication_date", "release_date", "published_date"],
        ),
        description: sidecar_string(&value, &["publisher_summary", "summary", "description"]),
        language: sidecar_string(&value, &["language"]),
        series: series.as_ref().map(|(name, _)| name.clone()),
        series_position: series.and_then(|(_, position)| position),
        genres: unique_strings(genres),
        raw_fields: Vec::new(),
    };
    let result = LibationSidecarMetadata {
        title,
        subtitle: metadata.subtitle.clone(),
        author: sidecar_people(&value, &["authors", "author"]),
        narrator: sidecar_people(&value, &["narrators", "narrator"]),
        asin,
        summary: metadata,
    };
    (result.title.is_some() || result.asin.is_some() || result.summary.series.is_some())
        .then_some(result)
}

pub(crate) fn normalized_json_key(key: &str) -> String {
    key.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

pub(crate) fn sidecar_values<'a>(
    value: &'a serde_json::Value,
    names: &[&str],
    output: &mut Vec<&'a serde_json::Value>,
) {
    match value {
        serde_json::Value::Object(object) => {
            for (key, nested) in object {
                if names
                    .iter()
                    .any(|name| normalized_json_key(key) == normalized_json_key(name))
                {
                    output.push(nested);
                }
                sidecar_values(nested, names, output);
            }
        }
        serde_json::Value::Array(values) => {
            for nested in values {
                sidecar_values(nested, names, output);
            }
        }
        _ => {}
    }
}

pub(crate) fn sidecar_string(value: &serde_json::Value, names: &[&str]) -> Option<String> {
    // Prefer fields on the current record before descending. Otherwise a
    // nested series title can win over the audiobook title merely because
    // JSON object keys are stored in sorted order.
    if let serde_json::Value::Object(object) = value
        && let Some(value) = object.iter().find_map(|(key, value)| {
            names
                .iter()
                .any(|name| normalized_json_key(key) == normalized_json_key(name))
                .then_some(value)
        })
        && let Some(value) = value
            .as_str()
            .map(clean_metadata_text)
            .filter(|value| !value.is_empty())
    {
        return Some(value);
    }
    match value {
        serde_json::Value::Object(object) => object
            .values()
            .find_map(|nested| sidecar_string(nested, names)),
        serde_json::Value::Array(values) => values
            .iter()
            .find_map(|nested| sidecar_string(nested, names)),
        _ => None,
    }
}

pub(crate) fn sidecar_strings(value: &serde_json::Value, names: &[&str]) -> Vec<String> {
    let mut values = Vec::new();
    sidecar_values(value, names, &mut values);
    values
        .into_iter()
        .flat_map(|value| match value {
            serde_json::Value::String(value) => vec![clean_metadata_text(value)],
            serde_json::Value::Array(values) => values
                .iter()
                .flat_map(|entry| {
                    entry
                        .as_str()
                        .map(clean_metadata_text)
                        .or_else(|| sidecar_string(entry, &["name", "title"]))
                })
                .collect(),
            serde_json::Value::Object(_) => sidecar_string(value, &["name", "title"])
                .into_iter()
                .collect(),
            _ => Vec::new(),
        })
        .filter(|value| !value.is_empty())
        .collect()
}

pub(crate) fn sidecar_people(value: &serde_json::Value, names: &[&str]) -> Option<String> {
    let people = sidecar_strings(value, names);
    (!people.is_empty()).then(|| unique_strings(people).join(", "))
}

pub(crate) fn sidecar_series(value: &serde_json::Value) -> Option<(String, Option<String>)> {
    let mut series = Vec::new();
    sidecar_values(value, &["series"], &mut series);
    series
        .into_iter()
        .find_map(|value| match value {
            serde_json::Value::String(name) => Some((clean_metadata_text(name), None)),
            serde_json::Value::Array(entries) => entries.iter().find_map(|entry| {
                let name = sidecar_string(entry, &["title", "name", "series_title"])?;
                Some((
                    name,
                    sidecar_string(entry, &["sequence", "position", "series_sequence"]),
                ))
            }),
            serde_json::Value::Object(_) => {
                let name = sidecar_string(value, &["title", "name", "series_title"])?;
                Some((
                    name,
                    sidecar_string(value, &["sequence", "position", "series_sequence"]),
                ))
            }
            _ => None,
        })
        .filter(|(name, _)| !name.is_empty())
}

#[derive(Debug, Clone)]
pub(crate) struct LibationConfig {
    pub(crate) cli_path: Option<PathBuf>,
    pub(crate) libation_files_dir: Option<PathBuf>,
    pub(crate) library_root: PathBuf,
    pub(crate) auto_refresh_hours: Option<u64>,
    pub(crate) reader_refreshes_per_hour: u64,
}

impl LibationConfig {
    pub(crate) fn from_server_config(config: &ServerConfig) -> Self {
        let cli_path = config
            .libation_cli_path
            .clone()
            .filter(|path| path.is_file())
            .or_else(find_libation_cli_on_path);
        let libation_files_dir = config
            .libation_files_dir
            .clone()
            .filter(|path| path.is_dir());

        Self {
            cli_path,
            libation_files_dir,
            library_root: config.library_root.clone(),
            auto_refresh_hours: (config.libation_auto_refresh_hours > 0)
                .then_some(config.libation_auto_refresh_hours),
            reader_refreshes_per_hour: config.libation_reader_refreshes_per_hour,
        }
    }

    pub(crate) fn enabled(&self) -> bool {
        self.cli_path.is_some()
    }

    pub(crate) fn with_files_dir(&self, libation_files_dir: PathBuf) -> Self {
        Self {
            cli_path: self.cli_path.clone(),
            libation_files_dir: Some(libation_files_dir),
            library_root: self.library_root.clone(),
            auto_refresh_hours: self.auto_refresh_hours,
            reader_refreshes_per_hour: self.reader_refreshes_per_hour,
        }
    }

    pub(crate) fn command_args(&self, args: Vec<String>) -> Vec<String> {
        let mut command_args = args;
        if let Some(libation_files_dir) = &self.libation_files_dir {
            command_args.push("--libationFiles".to_string());
            command_args.push(libation_files_dir.to_string_lossy().to_string());
        }
        command_args
    }
}

#[derive(Debug, Clone)]
pub(crate) struct LibationProfile {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) account_id: Option<String>,
    pub(crate) managed: bool,
    pub(crate) config: LibationConfig,
}

pub(crate) fn managed_libation_profile(
    state: &AppState,
    account: &ManagedLibationAccount,
) -> LibationProfile {
    LibationProfile {
        id: account.id.clone(),
        name: account.label.clone(),
        account_id: Some(account.account_id.clone()),
        managed: true,
        config: state
            .libation_config
            .with_files_dir(state.libation_accounts_root.join(&account.id)),
    }
}

pub(crate) async fn all_libation_profiles(state: &AppState) -> Vec<LibationProfile> {
    let accounts = state.libation_accounts.read().await;
    let mut profiles = accounts
        .accounts
        .iter()
        .map(|account| managed_libation_profile(state, account))
        .collect::<Vec<_>>();
    if state.libation_config.libation_files_dir.is_some() || profiles.is_empty() {
        profiles.insert(
            0,
            LibationProfile {
                id: "legacy".to_string(),
                name: "Existing Libation accounts".to_string(),
                account_id: None,
                managed: false,
                config: state.libation_config.clone(),
            },
        );
    }
    profiles
}

pub(crate) async fn find_libation_profile(
    state: &AppState,
    profile_id: &str,
) -> Option<LibationProfile> {
    if profile_id == "legacy" || profile_id.starts_with("legacy-") {
        return state.libation_config.enabled().then(|| LibationProfile {
            id: profile_id.to_string(),
            name: "Existing Libation accounts".to_string(),
            account_id: None,
            managed: false,
            config: state.libation_config.clone(),
        });
    }
    state
        .libation_accounts
        .read()
        .await
        .accounts
        .iter()
        .find(|account| account.id == profile_id)
        .map(|account| managed_libation_profile(state, account))
}

pub(crate) fn find_libation_cli_on_path() -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    let candidates = ["libationcli", "LibationCli", "libationcli.exe"];
    for dir in env::split_paths(&path_var) {
        for candidate in candidates {
            let path = dir.join(candidate);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

pub(crate) async fn read_libation_status(state: &AppState) -> LibationStatus {
    let config = state.libation_config.clone();
    let Some(cli_path) = config.cli_path.as_ref() else {
        return LibationStatus {
            enabled: false,
            cli_path: None,
            libation_files_dir: config
                .libation_files_dir
                .as_ref()
                .map(|path| path.to_string_lossy().to_string()),
            library_root: state.library_root.to_string_lossy().to_string(),
            accounts: Vec::new(),
            authenticated: false,
            message: Some(
                "Libation CLI was not found. Set libation_cli_path in server.config or put libationcli on PATH."
                    .to_string(),
            ),
            auto_refresh_hours: config.auto_refresh_hours,
            manual_refreshes_per_hour: config.reader_refreshes_per_hour,
        };
    };

    let managed_snapshot = state.libation_accounts.read().await.accounts.clone();
    let mut accounts = Vec::new();
    let mut changed_health = HashMap::<String, (bool, String, Option<String>)>::new();
    for managed in &managed_snapshot {
        let profile = managed_libation_profile(state, managed);
        let result = run_libation(
            &profile.config,
            vec!["list-accounts".to_string(), "--bare".to_string()],
        )
        .await;
        let (authenticated, connection_state, error) = match result {
            Ok(output) if output.status.success() => {
                let listed = parse_libation_accounts(&String::from_utf8_lossy(&output.stdout));
                let authenticated = listed.iter().any(|account| {
                    account.account_id.eq_ignore_ascii_case(&managed.account_id)
                        && account.locale.eq_ignore_ascii_case(&managed.locale)
                        && account.authenticated
                });
                let has_scan_error = authenticated
                    && managed.connection_state == "error"
                    && managed.last_error.is_some();
                (
                    authenticated && !has_scan_error,
                    if has_scan_error {
                        "error"
                    } else if authenticated {
                        "connected"
                    } else {
                        "needs_sign_in"
                    }
                    .to_string(),
                    if has_scan_error {
                        managed.last_error.clone()
                    } else {
                        (!authenticated).then(|| {
                            "This Audible account needs to be signed in again.".to_string()
                        })
                    },
                )
            }
            Ok(output) => (
                false,
                "error".to_string(),
                Some(command_output_text(&output)),
            ),
            Err(error) => (false, "error".to_string(), Some(error.to_string())),
        };
        changed_health.insert(
            managed.id.clone(),
            (authenticated, connection_state.clone(), error.clone()),
        );
        accounts.push(LibationAccount {
            id: managed.id.clone(),
            account_id: managed.account_id.clone(),
            name: Some(managed.label.clone()),
            locale: managed.locale.clone(),
            scan_library: true,
            authenticated,
            managed: true,
            connection_state,
            last_successful_auth: managed.last_successful_auth.clone(),
            last_successful_refresh: managed.last_successful_refresh.clone(),
            last_error: error.or_else(|| managed.last_error.clone()),
            added_by: Some(managed.added_by.clone()),
            added_at: Some(managed.added_at.clone()),
        });
    }
    if !changed_health.is_empty() {
        let stored = state
            .libation_accounts
            .mutate(|store| {
                for account in &mut store.accounts {
                    if let Some((authenticated, connection_state, error)) =
                        changed_health.get(&account.id)
                    {
                        account.authenticated = *authenticated;
                        account.connection_state = connection_state.clone();
                        account.last_error = error.clone();
                    }
                }
                Ok(())
            })
            .await;
        if let Err(error) = stored {
            tracing::warn!(
                "failed to persist Libation account status: {}",
                error.message
            );
        }
    }

    if config.libation_files_dir.is_some() || managed_snapshot.is_empty() {
        match run_libation(
            &config,
            vec!["list-accounts".to_string(), "--bare".to_string()],
        )
        .await
        {
            Ok(output) if output.status.success() => {
                accounts.extend(parse_libation_accounts(&String::from_utf8_lossy(
                    &output.stdout,
                )));
            }
            Ok(output) if accounts.is_empty() => accounts.push(LibationAccount {
                id: "legacy".to_string(),
                account_id: "Existing Libation profile".to_string(),
                name: Some("Existing Libation profile".to_string()),
                locale: String::new(),
                scan_library: true,
                authenticated: false,
                managed: false,
                connection_state: "error".to_string(),
                last_successful_auth: None,
                last_successful_refresh: None,
                last_error: Some(command_output_text(&output)),
                added_by: None,
                added_at: None,
            }),
            Err(error) if accounts.is_empty() => accounts.push(LibationAccount {
                id: "legacy".to_string(),
                account_id: "Existing Libation profile".to_string(),
                name: Some("Existing Libation profile".to_string()),
                locale: String::new(),
                scan_library: true,
                authenticated: false,
                managed: false,
                connection_state: "error".to_string(),
                last_successful_auth: None,
                last_successful_refresh: None,
                last_error: Some(error.to_string()),
                added_by: None,
                added_at: None,
            }),
            _ => {}
        }
    }

    let authenticated =
        !accounts.is_empty() && accounts.iter().all(|account| account.authenticated);
    let broken_count = accounts
        .iter()
        .filter(|account| !account.authenticated)
        .count();
    let message = if accounts.is_empty() {
        Some(
            "No Libation accounts are configured. Administrators can add an Audible account here."
                .to_string(),
        )
    } else if broken_count > 0 {
        Some(format!(
            "{broken_count} Audible account{} need{} attention.",
            if broken_count == 1 { "" } else { "s" },
            if broken_count == 1 { "s" } else { "" }
        ))
    } else {
        None
    };
    LibationStatus {
        enabled: true,
        cli_path: Some(cli_path.to_string_lossy().to_string()),
        libation_files_dir: config
            .libation_files_dir
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        library_root: state.library_root.to_string_lossy().to_string(),
        accounts,
        authenticated,
        message,
        auto_refresh_hours: config.auto_refresh_hours,
        manual_refreshes_per_hour: config.reader_refreshes_per_hour,
    }
}

pub(crate) fn parse_libation_accounts(output: &str) -> Vec<LibationAccount> {
    output
        .lines()
        .filter_map(|line| {
            let columns = line.split('\t').collect::<Vec<_>>();
            if columns.len() < 5 {
                return None;
            }
            Some(LibationAccount {
                id: format!(
                    "legacy-{}",
                    stable_id(&format!("{}:{}", columns[0].trim(), columns[2].trim()))
                ),
                account_id: columns[0].trim().to_string(),
                name: non_empty_string(columns[1]),
                locale: columns[2].trim().to_string(),
                scan_library: yes_no(columns[3]),
                authenticated: yes_no(columns[4]),
                managed: false,
                connection_state: if yes_no(columns[4]) {
                    "connected".to_string()
                } else {
                    "needs_sign_in".to_string()
                },
                last_successful_auth: None,
                last_successful_refresh: None,
                last_error: None,
                added_by: None,
                added_at: None,
            })
        })
        .collect()
}

pub(crate) fn yes_no(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case("yes") || value.trim().eq_ignore_ascii_case("true")
}

pub(crate) async fn export_libation_books(
    profile: &LibationProfile,
) -> Result<Vec<LibationBook>, ApiError> {
    // An unpredictable owner-only temp file, so no other local user can
    // pre-create, read, or symlink the export path in a shared temp dir.
    let export_file = tempfile::Builder::new()
        .prefix("operalibre-libation-export-")
        .suffix(".json")
        .tempfile()
        .map_err(ApiError::from)?;
    let export_path = export_file.path().to_path_buf();
    let output = run_libation(
        &profile.config,
        vec![
            "export".to_string(),
            "--path".to_string(),
            export_path.to_string_lossy().to_string(),
            "--json".to_string(),
        ],
    )
    .await?;

    if !output.status.success() {
        return Err(ApiError::bad_gateway(command_output_text(&output)));
    }

    let contents = fs::read_to_string(&export_path).await?;
    drop(export_file);
    let records = serde_json::from_str::<Vec<LibationExportRecord>>(&contents)?;
    Ok(records
        .into_iter()
        .filter_map(|record| {
            let asin = non_empty_string(record.audible_product_id?)?;
            let locale = non_empty_string(record.locale.unwrap_or_default());
            let record_account = record.account.as_deref().and_then(non_empty_string);
            let account_id = profile.account_id.clone().or(record_account);
            let profile_id = if profile.managed {
                profile.id.clone()
            } else if let Some(account_id) = account_id.as_deref() {
                format!(
                    "legacy-{}",
                    stable_id(&format!(
                        "{}:{}",
                        account_id,
                        locale.as_deref().unwrap_or_default()
                    ))
                )
            } else {
                profile.id.clone()
            };
            let profile_name = if profile.managed {
                profile.name.clone()
            } else {
                account_id.clone().unwrap_or_else(|| profile.name.clone())
            };
            let cover_art_url = libation_cover_art_url_from_ids(
                record.picture_large.as_deref(),
                record.picture_id.as_deref(),
            );
            Some(LibationBook {
                catalog_id: format!("{profile_id}:{asin}"),
                profile_id,
                profile_name,
                account_id,
                asin,
                title: record.title.unwrap_or_else(|| "Untitled".to_string()),
                subtitle: non_empty_string(record.subtitle.unwrap_or_default()),
                authors: non_empty_string(record.author_names.unwrap_or_default()),
                narrators: non_empty_string(record.narrator_names.unwrap_or_default()),
                length_minutes: record.length_in_minutes,
                description: non_empty_string(record.description.unwrap_or_default()),
                publisher: non_empty_string(record.publisher.unwrap_or_default()),
                book_status: non_empty_string(record.book_status.unwrap_or_default()),
                pdf_status: non_empty_string(record.pdf_status.unwrap_or_default()),
                content_type: non_empty_string(record.content_type.unwrap_or_default()),
                locale,
                last_downloaded: non_empty_string(record.last_downloaded.unwrap_or_default()),
                is_audible_plus: record.is_audible_plus.unwrap_or(false),
                cover_art_url,
                local_book_id: None,
            })
        })
        .collect())
}

pub(crate) fn non_empty_string(value: impl AsRef<str>) -> Option<String> {
    let value = value.as_ref().trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

pub(crate) async fn run_libation(
    config: &LibationConfig,
    args: Vec<String>,
) -> anyhow::Result<std::process::Output> {
    let cli_path = config
        .cli_path
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("Libation CLI is not configured"))?;
    Ok(Command::new(cli_path)
        .args(config.command_args(args))
        .output()
        .await?)
}

pub(crate) fn start_interactive_libation_login(
    config: LibationConfig,
    account_id: String,
    locale: String,
) -> anyhow::Result<InteractiveLibationLogin> {
    let cli_path = config
        .cli_path
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Libation CLI is not configured"))?;
    let args = config.command_args(vec![
        "login-external".to_string(),
        "--account".to_string(),
        account_id,
        "--locale".to_string(),
        locale,
    ]);
    let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
    let (response_sender, response_receiver) = std::sync::mpsc::channel();
    let (completion_sender, completion_receiver) = tokio::sync::oneshot::channel();

    std::thread::Builder::new()
        .name("libation-login".to_string())
        .spawn(move || {
            let result =
                run_interactive_libation_login(&cli_path, &args, started_sender, response_receiver);
            let _ = completion_sender.send(result);
        })?;

    Ok(InteractiveLibationLogin {
        started: started_receiver,
        response_sender,
        completion: completion_receiver,
    })
}

pub(crate) fn run_interactive_libation_login(
    cli_path: &FsPath,
    args: &[String],
    started_sender: tokio::sync::oneshot::Sender<Result<String, String>>,
    response_receiver: std::sync::mpsc::Receiver<String>,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize {
        rows: 24,
        cols: 160,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(pair) => pair,
        Err(error) => {
            let message = format!("Could not open a terminal for Libation login: {error}");
            let _ = started_sender.send(Err(message.clone()));
            return Err(message);
        }
    };
    let mut command = CommandBuilder::new(cli_path);
    command.args(args);
    let mut child = match pair.slave.spawn_command(command) {
        Ok(child) => child,
        Err(error) => {
            let message = format!("Could not start Libation login: {error}");
            let _ = started_sender.send(Err(message.clone()));
            return Err(message);
        }
    };
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Could not read Libation login output: {error}"))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Could not write to Libation login: {error}"))?;
    let (output_sender, output_receiver) = std::sync::mpsc::channel::<Vec<u8>>();
    let reader_thread = std::thread::spawn(move || {
        let mut buffer = [0u8; 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    if output_sender.send(buffer[..count].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let deadline =
        std::time::Instant::now() + Duration::from_secs(LIBATION_LOGIN_START_TIMEOUT_SECONDS);
    let mut output = String::new();
    let login_url = loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            let _ = child.kill();
            let message = "Libation did not provide an Audible sign-in URL in time.".to_string();
            let _ = started_sender.send(Err(message.clone()));
            return Err(message);
        }
        match output_receiver.recv_timeout(remaining.min(Duration::from_secs(1))) {
            Ok(chunk) => {
                output.push_str(&String::from_utf8_lossy(&chunk));
                if output.len() > 128 * 1024 {
                    output = text_tail(&output, 128 * 1024);
                }
                if let Some(url) = extract_libation_login_url(&output) {
                    break url;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                let status = child.wait().ok();
                let message = format!(
                    "Libation exited before providing a sign-in URL{}: {}",
                    status
                        .map(|value| format!(" ({value})"))
                        .unwrap_or_default(),
                    sanitize_libation_login_output(&output)
                );
                let _ = started_sender.send(Err(message.clone()));
                return Err(message);
            }
        }
    };
    if started_sender.send(Ok(login_url)).is_err() {
        let _ = child.kill();
        return Err("The Libation login request was cancelled.".to_string());
    }

    let response_url =
        match response_receiver.recv_timeout(Duration::from_secs(LIBATION_LOGIN_SESSION_SECONDS)) {
            Ok(response_url) => response_url,
            Err(_) => {
                let _ = child.kill();
                return Err("The Libation login session expired or was cancelled.".to_string());
            }
        };
    writer
        .write_all(response_url.as_bytes())
        .and_then(|_| writer.write_all(b"\r\n"))
        .and_then(|_| writer.flush())
        .map_err(|error| format!("Could not submit the Audible response to Libation: {error}"))?;
    drop(writer);

    let status = child
        .wait()
        .map_err(|error| format!("Could not wait for Libation login: {error}"))?;
    let _ = reader_thread.join();
    while let Ok(chunk) = output_receiver.try_recv() {
        output.push_str(&String::from_utf8_lossy(&chunk));
    }
    let safe_output = sanitize_libation_login_output(&output);
    if status.success() {
        Ok(safe_output)
    } else if safe_output.is_empty() {
        Err(format!("Libation login exited with status {status}."))
    } else {
        Err(safe_output)
    }
}

pub(crate) fn extract_libation_login_url(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .map(|token| {
            token.trim_matches(|character: char| {
                matches!(character, '\'' | '"' | '(' | ')' | '<' | '>' | ',')
            })
        })
        .find(|token| {
            reqwest::Url::parse(token).is_ok_and(|url| {
                url.scheme() == "https"
                    && url
                        .host_str()
                        .is_some_and(|host| is_amazon_or_audible_host(&host.to_ascii_lowercase()))
            })
        })
        .map(ToString::to_string)
}

pub(crate) fn sanitize_libation_login_output(output: &str) -> String {
    output
        .lines()
        .filter(|line| !line.contains("https://") && !line.starts_with("Paste URL:"))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

pub(crate) fn command_output_text(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = format!("{}{}", stdout, stderr);
    if text.trim().is_empty() {
        format!("Libation exited with status {}", output.status)
    } else {
        text.trim().to_string()
    }
}

pub(crate) fn recover_interrupted_libation_requests(store: &mut LibationRequestStore) -> bool {
    let mut changed = false;
    for request in &mut store.requests {
        if request.status == "approved" {
            request.status = "pending".to_string();
            request.decided_at = None;
            request.decided_by = None;
            request.job_id = None;
            changed = true;
        }
    }
    changed
}

pub(crate) async fn update_libation_access(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Path(user_id): Path<String>,
    Json(payload): Json<UpdateLibationAccessRequest>,
) -> Result<Json<UserPublic>, ApiError> {
    let public = state
        .users
        .mutate(|users| {
            let user = users
                .users
                .iter_mut()
                .find(|user| user.id == user_id)
                .ok_or(ApiError::not_found("User not found."))?;
            if user.is_owner {
                return Err(ApiError::bad_request(
                    "Owners always have direct Libation access.",
                ));
            }
            if user.is_admin && !auth.is_owner {
                return Err(ApiError::forbidden(
                    "Only an owner can change an administrator's Libation access.",
                ));
            }
            user.libation_access = payload.libation_access;
            Ok(UserPublic::from(&*user))
        })
        .await?;
    Ok(Json(public))
}

pub(crate) async fn update_libation_approval(
    State(state): State<AppState>,
    _: OwnerUser,
    Path(user_id): Path<String>,
    Json(payload): Json<UpdateLibationApprovalRequest>,
) -> Result<Json<UserPublic>, ApiError> {
    let public = state
        .users
        .mutate(|users| {
            let user = users
                .users
                .iter_mut()
                .find(|user| user.id == user_id)
                .ok_or(ApiError::not_found("User not found."))?;
            if !user.is_admin && !user.is_owner {
                return Err(ApiError::bad_request(
                    "Only administrators can approve Libation requests.",
                ));
            }
            if user.is_owner && !payload.can_approve_libation_requests {
                return Err(ApiError::bad_request(
                    "Owners always have permission to approve Libation requests.",
                ));
            }
            user.can_approve_libation_requests = payload.can_approve_libation_requests;
            Ok(UserPublic::from(&*user))
        })
        .await?;
    Ok(Json(public))
}
