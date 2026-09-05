//! Accounts and sessions: password hashing, sign-in and its throttles,
//! cookies, CSRF enforcement, and per-user permissions.

use crate::*;

pub(crate) const SESSION_COOKIE_NAME: &str = "operalibre_session";

pub(crate) const SESSION_COOKIE_MAX_AGE_SECONDS: u64 = 60 * 60 * 24 * 30;

/// Failures from one address against one username before that pair is
/// locked: the fast lock a legitimate user trips by mistyping.
pub(crate) const LOGIN_MAX_FAILURES: u32 = 5;

/// Failures from one address across every username before the address is
/// locked: catches an attacker walking a list of names.
pub(crate) const LOGIN_IP_MAX_FAILURES: u32 = 25;

/// Failures against one username from every address before the account is
/// locked: the ceiling on guessing spread across many addresses. Looser than
/// the per-address lock so a stranger cannot cheaply deny a victim from one
/// address, but still bounding how many guesses one account absorbs a minute.
pub(crate) const LOGIN_ACCOUNT_MAX_FAILURES: u32 = 50;

pub(crate) const LOGIN_LOCKOUT_SECONDS: u64 = 60;

pub(crate) const LOGIN_THROTTLE_KEY_MAX_CHARS: usize = 64;

pub(crate) const LOGIN_THROTTLE_MAX_ENTRIES: usize = 10_000;

pub(crate) const PASSWORD_TASK_CONCURRENCY: usize = 4;

pub(crate) const MIN_PASSWORD_CHARS: usize = 12;

pub(crate) const MAX_PASSWORD_CHARS: usize = 1_024;

pub(crate) const MAX_SESSIONS_PER_USER: usize = 20;

pub(crate) const MAX_SESSIONS_TOTAL: usize = 1_000;

pub(crate) const OFFICIAL_APP_ORIGINS: &[&str] = &[
    "capacitor://localhost",
    "http://localhost",
    "http://127.0.0.1:49201",
];

#[derive(Debug, Clone, Copy)]
pub(crate) struct LoginThrottle {
    pub(crate) failures: u32,
    pub(crate) last_failure: u64,
}

impl LoginThrottle {
    pub(crate) fn is_locked(&self, now_seconds: u64, max_failures: u32) -> bool {
        self.failures >= max_failures
            && now_seconds.saturating_sub(self.last_failure) < LOGIN_LOCKOUT_SECONDS
    }

    pub(crate) fn is_stale(&self, now_seconds: u64) -> bool {
        now_seconds.saturating_sub(self.last_failure) >= LOGIN_LOCKOUT_SECONDS
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct User {
    pub(crate) id: String,
    pub(crate) username: String,
    pub(crate) password_hash: String,
    pub(crate) is_admin: bool,
    #[serde(default)]
    pub(crate) is_owner: bool,
    #[serde(default)]
    pub(crate) can_approve_libation_requests: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) allowed_book_ids: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) libation_access: LibationAccess,
    /// Whether this listener's reading status is visible to the other users on
    /// the server. Accounts created before the setting existed are treated as
    /// sharing, matching the default for new accounts.
    #[serde(default = "default_share_progress")]
    pub(crate) share_progress: bool,
    #[serde(default = "default_share_progress", skip_serializing_if = "is_true")]
    pub(crate) announce_finishes: bool,
    #[serde(default = "default_share_progress", skip_serializing_if = "is_true")]
    pub(crate) notify_finishes: bool,
    pub(crate) created_at: String,
}

pub(crate) fn default_share_progress() -> bool {
    true
}

pub(crate) fn is_true(value: &bool) -> bool {
    *value
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UserPublic {
    pub(crate) id: String,
    pub(crate) username: String,
    pub(crate) is_admin: bool,
    pub(crate) is_owner: bool,
    pub(crate) can_approve_libation_requests: bool,
    pub(crate) allowed_book_ids: Option<Vec<String>>,
    pub(crate) libation_access: LibationAccess,
    pub(crate) share_progress: bool,
    pub(crate) announce_finishes: bool,
    pub(crate) notify_finishes: bool,
    pub(crate) created_at: String,
}

impl From<&User> for UserPublic {
    fn from(user: &User) -> Self {
        let mut public = UserPublic::from(AuthUser::from(user));
        public.created_at = user.created_at.clone();
        public
    }
}

impl From<AuthUser> for UserPublic {
    /// A session does not carry the account's creation time, so it is empty
    /// here; the `&User` conversion, which has the stored record, fills it in.
    fn from(auth: AuthUser) -> Self {
        Self {
            id: auth.id,
            username: auth.username,
            is_admin: auth.is_admin,
            is_owner: auth.is_owner,
            can_approve_libation_requests: auth.can_approve_libation_requests,
            allowed_book_ids: auth.allowed_book_ids,
            libation_access: auth.libation_access,
            share_progress: auth.share_progress,
            announce_finishes: auth.announce_finishes,
            notify_finishes: auth.notify_finishes,
            created_at: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct UsersStore {
    #[serde(default)]
    pub(crate) permissions_version: u32,
    #[serde(default)]
    pub(crate) users: Vec<User>,
}

impl Default for UsersStore {
    fn default() -> Self {
        Self {
            permissions_version: 1,
            users: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Session {
    pub(crate) user_id: String,
    pub(crate) created_at: u64,
}

impl Session {
    pub(crate) fn is_expired(&self, now_seconds: u64) -> bool {
        now_seconds.saturating_sub(self.created_at) > SESSION_COOKIE_MAX_AGE_SECONDS
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AuthUser {
    pub(crate) id: String,
    pub(crate) username: String,
    pub(crate) is_admin: bool,
    pub(crate) is_owner: bool,
    pub(crate) can_approve_libation_requests: bool,
    pub(crate) allowed_book_ids: Option<Vec<String>>,
    pub(crate) libation_access: LibationAccess,
    pub(crate) share_progress: bool,
    pub(crate) announce_finishes: bool,
    pub(crate) notify_finishes: bool,
}

impl From<&User> for AuthUser {
    /// The one place stored account flags become effective permissions: an
    /// owner is always an administrator, always approves Libation requests,
    /// and always has direct Libation access, whatever the stored flags say.
    fn from(user: &User) -> Self {
        Self {
            id: user.id.clone(),
            username: user.username.clone(),
            is_admin: user.is_admin || user.is_owner,
            is_owner: user.is_owner,
            can_approve_libation_requests: user.is_owner
                || (user.is_admin && user.can_approve_libation_requests),
            allowed_book_ids: user.allowed_book_ids.clone(),
            libation_access: if user.is_owner {
                LibationAccess::Direct
            } else {
                user.libation_access
            },
            share_progress: user.share_progress,
            announce_finishes: user.announce_finishes,
            notify_finishes: user.notify_finishes,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct SessionToken(pub(crate) String);

#[derive(Debug, Deserialize)]
// Permission payloads reject unknown fields. These types all model an
// absent field as a permissive default -- a missing `allowedBookIds`
// means "no restrictions" -- so a client that misspells a key would
// otherwise silently widen a user's access and still get a 200.
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateUserRoleRequest {
    pub(crate) is_admin: bool,
    #[serde(default)]
    pub(crate) is_owner: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateProgressSharingRequest {
    pub(crate) share_progress: bool,
    #[serde(default)]
    pub(crate) announce_finishes: Option<bool>,
    #[serde(default)]
    pub(crate) notify_finishes: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoginRequest {
    pub(crate) username: String,
    pub(crate) password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupRequest {
    pub(crate) username: String,
    pub(crate) password: String,
    #[serde(default)]
    pub(crate) setup_token: Option<String>,
}

#[derive(Debug, Deserialize)]
// Permission payloads reject unknown fields. These types all model an
// absent field as a permissive default -- a missing `allowedBookIds`
// means "no restrictions" -- so a client that misspells a key would
// otherwise silently widen a user's access and still get a 200.
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateUserRequest {
    pub(crate) username: String,
    pub(crate) password: String,
    #[serde(default)]
    pub(crate) is_admin: bool,
    #[serde(default)]
    pub(crate) is_owner: bool,
    #[serde(default)]
    pub(crate) can_approve_libation_requests: bool,
    #[serde(default)]
    pub(crate) libation_access: Option<LibationAccess>,
    #[serde(default)]
    pub(crate) allowed_book_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
// Permission payloads reject unknown fields. These types all model an
// absent field as a permissive default -- a missing `allowedBookIds`
// means "no restrictions" -- so a client that misspells a key would
// otherwise silently widen a user's access and still get a 200.
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateBookAccessRequest {
    pub(crate) allowed_book_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChangePasswordRequest {
    #[serde(default)]
    pub(crate) current_password: Option<String>,
    pub(crate) new_password: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoginResponse {
    pub(crate) token: String,
    pub(crate) media_token: String,
    pub(crate) user: UserPublic,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthStatus {
    pub(crate) setup_required: bool,
    pub(crate) setup_token_required: bool,
    pub(crate) setup_local_only: bool,
    pub(crate) user: Option<UserPublic>,
    pub(crate) media_token: Option<String>,
}

pub(crate) fn migrate_users_permissions(store: &mut UsersStore) -> bool {
    if store.permissions_version >= 1 {
        return false;
    }
    for user in &mut store.users {
        if user.is_admin {
            user.libation_access = LibationAccess::Direct;
            user.can_approve_libation_requests = true;
        }
    }
    if !store.users.iter().any(|user| user.is_owner) {
        if let Some(first_admin) = store.users.iter_mut().find(|user| user.is_admin) {
            first_admin.is_owner = true;
        } else if let Some(first_user) = store.users.first_mut() {
            first_user.is_admin = true;
            first_user.is_owner = true;
            first_user.libation_access = LibationAccess::Direct;
            first_user.can_approve_libation_requests = true;
        }
    }
    store.permissions_version = 1;
    true
}

pub(crate) static DUMMY_PASSWORD_HASH: LazyLock<String> =
    // A fresh per-process secret is enough: this hash only equalizes the cost
    // of an unknown-user login with a real password verification. It is never
    // an account credential, so keeping a fixed password-shaped value here
    // serves no purpose and can be mistaken for one by security tooling.
    LazyLock::new(|| hash_password(&generate_session_token()).unwrap_or_default());

pub(crate) fn hash_password(password: &str) -> Result<String, ApiError> {
    let salt = SaltString::generate(&mut PasswordOsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| ApiError::internal(format!("Password hashing failed: {error}")))
}

pub(crate) fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .and_then(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed))
        .is_ok()
}

/// Run one Argon2 operation on the blocking pool, holding a password-worker
/// permit for its duration so a burst of sign-ins cannot monopolise the pool.
async fn run_password_task<T: Send + 'static>(
    state: &AppState,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, ApiError> {
    let _permit = state
        .password_task_slots
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| ApiError::internal("Password worker pool is unavailable."))?;
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| ApiError::internal(format!("Password worker failed: {error}")))
}

pub(crate) async fn hash_password_async(
    state: &AppState,
    password: String,
) -> Result<String, ApiError> {
    run_password_task(state, move || hash_password(&password)).await?
}

pub(crate) async fn verify_password_async(
    state: &AppState,
    password: String,
    hash: String,
) -> Result<bool, ApiError> {
    run_password_task(state, move || verify_password(&password, &hash)).await
}

pub(crate) async fn verify_dummy_password_async(
    state: &AppState,
    password: String,
) -> Result<bool, ApiError> {
    run_password_task(state, move || {
        verify_password(&password, &DUMMY_PASSWORD_HASH)
    })
    .await
}

pub(crate) fn generate_session_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes);
    general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub(crate) fn media_token_for_session(session_token: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"operalibre-media-v1\0");
    digest.update(session_token.as_bytes());
    general_purpose::URL_SAFE_NO_PAD.encode(digest.finalize())
}

pub(crate) fn setup_token_digest(token: &str) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(b"operalibre-setup-v1\0");
    digest.update(token.as_bytes());
    digest.finalize().into()
}

pub(crate) fn normalize_username(value: &str) -> String {
    value.trim().to_string()
}

pub(crate) fn validate_password(password: &str) -> Result<(), ApiError> {
    let length = password.chars().count();
    if length < MIN_PASSWORD_CHARS {
        return Err(ApiError::bad_request(format!(
            "Password must be at least {MIN_PASSWORD_CHARS} characters long."
        )));
    }
    if length > MAX_PASSWORD_CHARS {
        return Err(ApiError::bad_request(format!(
            "Password must be at most {MAX_PASSWORD_CHARS} characters long."
        )));
    }
    Ok(())
}

pub(crate) fn validate_username(username: &str) -> Result<(), ApiError> {
    let trimmed = username.trim();
    if trimmed.is_empty() {
        return Err(ApiError::bad_request("Username is required."));
    }
    if trimmed.chars().count() > 64 {
        return Err(ApiError::bad_request("Username is too long."));
    }
    Ok(())
}

pub(crate) fn token_from_authorization(headers: &HeaderMap) -> Option<String> {
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
}

pub(crate) fn token_from_cookie_header(value: &str) -> Option<String> {
    value.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        if name == SESSION_COOKIE_NAME && !value.is_empty() {
            Some(value.to_string())
        } else {
            None
        }
    })
}

pub(crate) fn token_from_cookies(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(token_from_cookie_header)
}

pub(crate) fn token_from_headers(headers: &HeaderMap) -> Option<String> {
    token_from_authorization(headers).or_else(|| token_from_cookies(headers))
}

pub(crate) fn session_cookie(token: &str, secure: bool) -> String {
    let secure_attribute = if secure { "; Secure" } else { "" };
    format!(
        "{SESSION_COOKIE_NAME}={token}; Path=/; Max-Age={SESSION_COOKIE_MAX_AGE_SECONDS}{secure_attribute}; HttpOnly; SameSite=Lax"
    )
}

pub(crate) fn expired_session_cookie(secure: bool) -> String {
    let secure_attribute = if secure { "; Secure" } else { "" };
    format!("{SESSION_COOKIE_NAME}=; Path=/; Max-Age=0{secure_attribute}; HttpOnly; SameSite=Lax")
}

/// The address a request came from, in every deployment mode.
///
/// A forwarded header is trusted from a loopback peer only: that is a
/// same-machine reverse proxy in front of the port, which is exactly what the
/// header describes, in proxy mode and in a local or LAN listener that an
/// operator has put nginx in front of alike. A client reaching a LAN port
/// directly is never on loopback, so whatever it sends in the header is
/// ignored and its own address counts. A forged value from loopback can only
/// make a caller look *more* remote, which fails closed for local-only setup
/// and for the per-address login throttle.
pub(crate) fn request_client_ip(peer_address: SocketAddr, headers: &HeaderMap) -> IpAddr {
    if !peer_address.ip().is_loopback() {
        return peer_address.ip();
    }
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        // The nearest trusted proxy appends the address it observed at the
        // end. Taking the last value prevents a client-supplied leading XFF
        // value from bypassing throttles or local-only setup.
        .and_then(|value| value.split(',').next_back())
        .map(str::trim)
        .and_then(|value| value.parse::<IpAddr>().ok())
        .unwrap_or_else(|| peer_address.ip())
}

pub(crate) fn query_token_allowed(method: &Method, path: &str) -> bool {
    if method != Method::GET && method != Method::HEAD {
        return false;
    }
    let segments: Vec<_> = path.trim_matches('/').split('/').collect();
    matches!(
        segments.as_slice(),
        ["api", "opds"]
            | ["api", "opds", "books"]
            | ["api", "books", _, "cover"]
            | ["api", "books", _, "readalong"]
            | ["api", "books", _, "companions", _]
            | ["api", "books", _, "sync"]
            | ["api", "books", _, "download"]
            | ["api", "books", _, "tracks", _, "stream"]
            | ["abs", "api", "books", _, "cover"]
            | ["abs", "api", "books", _, "tracks", _, "stream"]
            | ["api", "libation", "covers", _]
    )
}

pub(crate) enum RequestCredential {
    Session(String),
    Media(String),
}

pub(crate) fn extract_request_credential(req: &Request) -> Option<RequestCredential> {
    if let Some(token) = token_from_headers(req.headers()) {
        return Some(RequestCredential::Session(token));
    }
    if !query_token_allowed(req.method(), req.uri().path()) {
        return None;
    }
    let query = req.uri().query()?;
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        if key == "token" && !value.is_empty() {
            return Some(RequestCredential::Media(value.to_string()));
        }
    }
    None
}

pub(crate) async fn resolve_session(state: &AppState, token: &str) -> Option<AuthUser> {
    let sessions = state.sessions.read().await;
    let session = sessions.get(token)?.clone();
    drop(sessions);
    if session.is_expired(unix_now_seconds()) {
        if let Err(error) = state
            .sessions
            .mutate(|sessions| Ok(sessions.remove(token).is_some()))
            .await
        {
            tracing::warn!(
                "failed to persist expired session removal: {}",
                error.message
            );
        }
        return None;
    }
    let users = state.users.read().await;
    users
        .users
        .iter()
        .find(|user| user.id == session.user_id)
        .map(AuthUser::from)
}

pub(crate) async fn resolve_media_session(
    state: &AppState,
    media_token: &str,
) -> Option<(AuthUser, String)> {
    let session_token = state.sessions.session_for_media_token(media_token).await?;
    resolve_session(state, &session_token)
        .await
        .map(|user| (user, session_token))
}

pub(crate) async fn auth_middleware(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Result<Response, ApiError> {
    enforce_cookie_csrf(&state, &req)?;
    let Some(credential) = extract_request_credential(&req) else {
        return Err(ApiError::unauthorized("Missing authentication token."));
    };
    let resolved = match credential {
        RequestCredential::Session(token) => resolve_session(&state, &token)
            .await
            .map(|user| (user, token)),
        RequestCredential::Media(token) => resolve_media_session(&state, &token).await,
    };
    let Some((user, session_token)) = resolved else {
        return Err(ApiError::unauthorized("Session is invalid or expired."));
    };
    req.extensions_mut().insert(user);
    req.extensions_mut().insert(SessionToken(session_token));
    Ok(next.run(req).await)
}

pub(crate) fn is_safe_http_method(method: &Method) -> bool {
    matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
}

pub(crate) fn request_authority(value: &str) -> Option<String> {
    value
        .parse::<axum::http::Uri>()
        .ok()?
        .authority()
        .map(|authority| authority.as_str().to_ascii_lowercase())
}

pub(crate) fn build_csrf_allowed_origins(configured_origins: &[String]) -> HashSet<String> {
    OFFICIAL_APP_ORIGINS
        .iter()
        .copied()
        .chain(configured_origins.iter().map(String::as_str))
        .map(|origin| origin.trim_end_matches('/').to_ascii_lowercase())
        .collect()
}

pub(crate) fn cookie_request_origin_allowed(
    allowed_origins: &HashSet<String>,
    headers: &HeaderMap,
) -> bool {
    let Some(source) = headers
        .get(ORIGIN)
        .or_else(|| headers.get(REFERER))
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let source_origin = source.trim_end_matches('/').to_ascii_lowercase();
    if source_origin == "null" {
        return false;
    }
    if allowed_origins.contains(&source_origin) {
        return true;
    }

    let Some(source_authority) = request_authority(source) else {
        return false;
    };
    headers
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| source_authority.eq_ignore_ascii_case(host.trim()))
}

pub(crate) fn enforce_cookie_csrf(state: &AppState, request: &Request) -> Result<(), ApiError> {
    if is_safe_http_method(request.method())
        || token_from_authorization(request.headers()).is_some()
        || token_from_cookies(request.headers()).is_none()
    {
        return Ok(());
    }
    if cookie_request_origin_allowed(&state.csrf_allowed_origins, request.headers()) {
        return Ok(());
    }
    Err(ApiError::forbidden(
        "Cookie-authenticated changes must come from this server's web app. API clients should use Authorization: Bearer.",
    ))
}

pub(crate) async fn auth_status(
    State(state): State<AppState>,
    ConnectInfo(peer_address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let setup_required = state.users.read().await.users.is_empty();
    let remote_client = !request_client_ip(peer_address, &headers).is_loopback();
    let (user, media_token) = if let Some(token) = token_from_headers(&headers) {
        match resolve_session(&state, &token).await {
            Some(auth) => (
                Some(UserPublic::from(auth)),
                Some(media_token_for_session(&token)),
            ),
            None => (None, None),
        }
    } else {
        (None, None)
    };

    (
        [(CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Json(AuthStatus {
            setup_required,
            setup_token_required: setup_required
                && state.deployment_mode.setup_token_required(remote_client),
            setup_local_only: setup_required
                && remote_client
                && !state.deployment_mode.allows_remote_setup(),
            user,
            media_token,
        }),
    )
}

pub(crate) async fn setup_admin(
    State(state): State<AppState>,
    ConnectInfo(peer_address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<SetupRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let remote_client = !request_client_ip(peer_address, &headers).is_loopback();
    if remote_client && !state.deployment_mode.allows_remote_setup() {
        return Err(ApiError::forbidden(
            "First-run setup must be completed from the server itself in local mode.",
        ));
    }
    if state.deployment_mode.setup_token_required(remote_client) {
        let candidate = payload.setup_token.as_deref().unwrap_or_default();
        let valid_token = state
            .setup_token
            .lock()
            .await
            .as_ref()
            .is_some_and(|token| token.matches(candidate, unix_now_seconds()));
        if !valid_token {
            return Err(ApiError::forbidden(
                "The setup token is invalid or expired. Restart the server to generate a new token.",
            ));
        }
    }
    {
        let users = state.users.read().await;
        if !users.users.is_empty() {
            return Err(ApiError::bad_request(
                "Setup has already been completed. Sign in instead.",
            ));
        }
    }

    let username = normalize_username(&payload.username);
    validate_username(&username)?;
    validate_password(&payload.password)?;

    let new_user = User {
        id: stable_id(&format!("user:{}:{}", username, now_unix_string())),
        username,
        password_hash: hash_password_async(&state, payload.password.clone()).await?,
        is_admin: true,
        is_owner: true,
        can_approve_libation_requests: true,
        allowed_book_ids: None,
        libation_access: LibationAccess::Direct,
        share_progress: true,
        announce_finishes: true,
        notify_finishes: true,
        created_at: now_unix_string(),
    };

    state
        .users
        .mutate(|users| {
            if !users.users.is_empty() {
                return Err(ApiError::conflict(
                    "Setup was completed by another request. Sign in instead.",
                ));
            }
            users.users.push(new_user.clone());
            Ok(())
        })
        .await?;
    state.setup_token.lock().await.take();

    let token = create_session(&state, &new_user.id).await?;
    session_login_response(&state, token, &new_user)
}

pub(crate) async fn login(
    State(state): State<AppState>,
    ConnectInfo(peer_address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<LoginRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let (user, token) =
        authenticate_and_open_session(&state, peer_address, &headers, payload).await?;
    session_login_response(&state, token, &user)
}

/// The response every sign-in path returns: the session cookie, no-store
/// caching, and the token pair a client needs for API and media requests.
fn session_login_response(
    state: &AppState,
    token: String,
    user: &User,
) -> Result<(HeaderMap, Json<LoginResponse>), ApiError> {
    let mut headers = HeaderMap::new();
    headers.insert(
        SET_COOKIE,
        HeaderValue::from_str(&session_cookie(
            &token,
            state.deployment_mode.secure_cookies(),
        ))
        .map_err(|error| ApiError::internal(format!("Invalid session cookie: {error}")))?,
    );
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("pragma", HeaderValue::from_static("no-cache"));
    Ok((
        headers,
        Json(LoginResponse {
            media_token: media_token_for_session(&token),
            token,
            user: UserPublic::from(user),
        }),
    ))
}

/// Check a username and password and open a session for the account.
///
/// Shared with the Audiobookshelf-compatible sign-in so that the throttle, the
/// constant-time treatment of unknown usernames, and session pruning cannot
/// drift between the two entry points.
pub(crate) async fn authenticate_and_open_session(
    state: &AppState,
    peer_address: SocketAddr,
    headers: &HeaderMap,
    payload: LoginRequest,
) -> Result<(User, String), ApiError> {
    let username = normalize_username(&payload.username);
    let client_ip = request_client_ip(peer_address, headers);
    let throttle_keys = LoginThrottleKeys::new(client_ip, &username);
    {
        let mut attempts = state.login_attempts.lock().await;
        let now = unix_now_seconds();
        attempts.retain(|_, throttle| !throttle.is_stale(now));
        if throttle_keys.is_locked(&attempts, now) {
            return Err(ApiError::too_many_requests(
                "Too many failed sign-in attempts. Try again in a minute.",
            ));
        }
    }

    if payload.password.chars().count() > MAX_PASSWORD_CHARS {
        let _ = verify_dummy_password_async(state, "oversized-password".to_string()).await?;
        record_login_failures(state, throttle_keys.all()).await;
        return Err(ApiError::unauthorized("Invalid username or password."));
    }

    let matched_user = {
        let users = state.users.read().await;
        users
            .users
            .iter()
            .find(|user| user.username.eq_ignore_ascii_case(&username))
            .cloned()
    };

    let Some(user) = matched_user else {
        // Burn the same time as a real verification so response timing does
        // not reveal whether the username exists.
        let _ = verify_dummy_password_async(state, payload.password).await?;
        record_login_failures(state, throttle_keys.all()).await;
        return Err(ApiError::unauthorized("Invalid username or password."));
    };
    if !verify_password_async(state, payload.password, user.password_hash.clone()).await? {
        record_login_failures(state, throttle_keys.all()).await;
        return Err(ApiError::unauthorized("Invalid username or password."));
    }
    let mut attempts = state.login_attempts.lock().await;
    for throttle_key in throttle_keys.all() {
        attempts.remove(throttle_key);
    }
    drop(attempts);

    let token = create_session(state, &user.id).await?;
    Ok((user, token))
}

/// Throttle keys come from unauthenticated input, so bound their length
/// (valid usernames are at most 64 characters anyway) to keep hostile logins
/// from bloating the attempts map with megabyte-long keys.
pub(crate) fn login_throttle_key(username: &str) -> String {
    format!(
        "user:{}",
        username
            .to_lowercase()
            .chars()
            .take(LOGIN_THROTTLE_KEY_MAX_CHARS)
            .collect::<String>()
    )
}

/// The account lock is keyed by the address attempting it as well as the
/// name. Keyed by name alone, anyone who knew a username could keep that
/// account locked with a handful of bad passwords a minute; the per-address
/// counter below still catches an attacker walking many names.
pub(crate) fn login_account_throttle_key(client_ip: IpAddr, username: &str) -> String {
    format!("ip:{client_ip}:{}", login_throttle_key(username))
}

pub(crate) fn login_ip_throttle_key(client_ip: IpAddr) -> String {
    format!("ip:{client_ip}")
}

/// The three counters one sign-in attempt is checked against, layered so
/// that no single one is both tight and abusable:
///
/// - `account`, (address, username), locks at [`LOGIN_MAX_FAILURES`]: the
///   fast lock. Keyed by address too, a stranger who knows a username cannot
///   deny its owner from somewhere else.
/// - `ip`, address alone, locks at [`LOGIN_IP_MAX_FAILURES`]: an attacker
///   walking many names from one address.
/// - `username`, name alone, locks at [`LOGIN_ACCOUNT_MAX_FAILURES`]: the
///   ceiling across addresses. Without it, guessing spread over many
///   addresses would face no bound per account at all.
///
/// A failure counts against all three; a sign-in is refused if any is over
/// its limit; a success clears all three.
pub(crate) struct LoginThrottleKeys {
    pub(crate) account: String,
    pub(crate) ip: String,
    pub(crate) username: String,
}

impl LoginThrottleKeys {
    pub(crate) fn new(client_ip: IpAddr, username: &str) -> Self {
        Self {
            account: login_account_throttle_key(client_ip, username),
            ip: login_ip_throttle_key(client_ip),
            username: login_throttle_key(username),
        }
    }

    pub(crate) fn all(&self) -> [&String; 3] {
        [&self.account, &self.ip, &self.username]
    }

    pub(crate) fn is_locked(
        &self,
        attempts: &HashMap<String, LoginThrottle>,
        now_seconds: u64,
    ) -> bool {
        [
            (&self.account, LOGIN_MAX_FAILURES),
            (&self.ip, LOGIN_IP_MAX_FAILURES),
            (&self.username, LOGIN_ACCOUNT_MAX_FAILURES),
        ]
        .into_iter()
        .any(|(key, max_failures)| {
            attempts
                .get(key)
                .is_some_and(|throttle| throttle.is_locked(now_seconds, max_failures))
        })
    }
}

pub(crate) async fn record_login_failures<'a>(
    state: &AppState,
    throttle_keys: impl IntoIterator<Item = &'a String>,
) {
    let now = unix_now_seconds();
    let mut attempts = state.login_attempts.lock().await;
    // A flood of unique bogus usernames within the lockout window can't grow
    // the map without bound: stop tracking new names at the cap. Entries for
    // already-tracked names keep counting, and stale ones are pruned on every
    // login attempt.
    for throttle_key in throttle_keys {
        if attempts.len() >= LOGIN_THROTTLE_MAX_ENTRIES && !attempts.contains_key(throttle_key) {
            continue;
        }
        let entry = attempts
            .entry(throttle_key.clone())
            .or_insert(LoginThrottle {
                failures: 0,
                last_failure: 0,
            });
        if entry.is_stale(now) {
            entry.failures = 0;
        }
        entry.failures += 1;
        entry.last_failure = now;
    }
}

pub(crate) async fn create_session(state: &AppState, user_id: &str) -> Result<String, ApiError> {
    let token = generate_session_token();
    let session = Session {
        user_id: user_id.to_string(),
        created_at: unix_now_seconds(),
    };
    state
        .sessions
        .mutate(|sessions| {
            prune_sessions_for_new_session(sessions, user_id, session.created_at);
            sessions.insert(token.clone(), session);
            Ok(())
        })
        .await?;
    Ok(token)
}

pub(crate) fn prune_sessions_for_new_session(
    sessions: &mut HashMap<String, Session>,
    user_id: &str,
    now_seconds: u64,
) {
    sessions.retain(|_, session| !session.is_expired(now_seconds));
    evict_oldest_sessions(sessions, MAX_SESSIONS_PER_USER, |session| {
        session.user_id == user_id
    });
    evict_oldest_sessions(sessions, MAX_SESSIONS_TOTAL, |_| true);
}

/// Make room for one incoming session: evict the oldest matching sessions
/// until fewer than `limit` remain.
fn evict_oldest_sessions(
    sessions: &mut HashMap<String, Session>,
    limit: usize,
    matches: impl Fn(&Session) -> bool,
) {
    let mut candidates = sessions
        .iter()
        .filter(|(_, session)| matches(session))
        .map(|(token, session)| (token.clone(), session.created_at))
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(_, created_at)| *created_at);
    let excess = candidates.len().saturating_add(1).saturating_sub(limit);
    for (token, _) in candidates.into_iter().take(excess) {
        sessions.remove(&token);
    }
}

pub(crate) fn revoke_password_change_sessions(
    sessions: &mut HashMap<String, Session>,
    user_id: &str,
    current_session: Option<&str>,
) {
    sessions.retain(|token, session| {
        session.user_id != user_id || current_session.is_some_and(|current| token == current)
    });
}

pub(crate) async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    if let Some(token) = token_from_headers(&headers) {
        state
            .sessions
            .mutate(|sessions| {
                sessions.remove(&token);
                Ok(())
            })
            .await?;
    }
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        SET_COOKIE,
        HeaderValue::from_str(&expired_session_cookie(
            state.deployment_mode.secure_cookies(),
        ))
        .map_err(|error| ApiError::internal(format!("Invalid session cookie: {error}")))?,
    );
    Ok((response_headers, Json(serde_json::json!({ "ok": true }))))
}

pub(crate) async fn me(Extension(auth): Extension<AuthUser>) -> Json<UserPublic> {
    Json(UserPublic::from(auth))
}

pub(crate) async fn update_progress_sharing(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Json(payload): Json<UpdateProgressSharingRequest>,
) -> Result<Json<UserPublic>, ApiError> {
    let public = state
        .users
        .mutate(|users| {
            let user = users
                .users
                .iter_mut()
                .find(|user| user.id == auth.id)
                .ok_or(ApiError::not_found("User not found."))?;
            user.share_progress = payload.share_progress;
            if let Some(value) = payload.announce_finishes {
                user.announce_finishes = value;
            }
            if let Some(value) = payload.notify_finishes {
                user.notify_finishes = value;
            }
            Ok(UserPublic::from(&*user))
        })
        .await?;
    Ok(Json(public))
}

/// An authenticated administrator.
///
/// Handlers that take this instead of `Extension<AuthUser>` cannot be reached
/// without the check: forgetting the guard becomes a compile error rather than
/// a review miss. The `auth_middleware` has already resolved the session and
/// inserted the `AuthUser` by the time this runs.
#[derive(Debug, Clone)]
pub(crate) struct AdminUser(pub(crate) AuthUser);

/// An authenticated owner. Strictly narrower than [`AdminUser`].
///
/// Carries no payload: no owner-only handler currently needs the acting user,
/// only the guarantee that the caller is the owner. Give it an `AuthUser` field
/// like the others if one ever does.
#[derive(Debug, Clone)]
pub(crate) struct OwnerUser;

/// A user permitted to approve Libation download requests.
#[derive(Debug, Clone)]
pub(crate) struct LibationApprover(pub(crate) AuthUser);

/// Pull the middleware-resolved user out of the request extensions.
fn authenticated_user(parts: &axum::http::request::Parts) -> Result<AuthUser, ApiError> {
    parts
        .extensions
        .get::<AuthUser>()
        .cloned()
        .ok_or_else(|| ApiError::unauthorized("Session is invalid or expired."))
}

impl<S: Send + Sync> axum::extract::FromRequestParts<S> for AdminUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        _state: &S,
    ) -> Result<Self, Self::Rejection> {
        let auth = authenticated_user(parts)?;
        require_admin(&auth)?;
        Ok(Self(auth))
    }
}

impl<S: Send + Sync> axum::extract::FromRequestParts<S> for OwnerUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        _state: &S,
    ) -> Result<Self, Self::Rejection> {
        require_owner(&authenticated_user(parts)?)?;
        Ok(Self)
    }
}

impl<S: Send + Sync> axum::extract::FromRequestParts<S> for LibationApprover {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        _state: &S,
    ) -> Result<Self, Self::Rejection> {
        let auth = authenticated_user(parts)?;
        require_libation_approver(&auth)?;
        Ok(Self(auth))
    }
}

pub(crate) fn require_admin(auth: &AuthUser) -> Result<(), ApiError> {
    if auth.is_admin {
        Ok(())
    } else {
        Err(ApiError::forbidden("Administrator access is required."))
    }
}

pub(crate) fn require_owner(auth: &AuthUser) -> Result<(), ApiError> {
    if auth.is_owner {
        Ok(())
    } else {
        Err(ApiError::forbidden("Owner access is required."))
    }
}

pub(crate) fn require_libation_approver(auth: &AuthUser) -> Result<(), ApiError> {
    if auth.can_approve_libation_requests {
        Ok(())
    } else {
        Err(ApiError::forbidden(
            "Permission to approve Libation requests is required.",
        ))
    }
}

pub(crate) fn can_access_book(auth: &AuthUser, book_id: &str) -> bool {
    auth.is_admin
        || auth
            .allowed_book_ids
            .as_ref()
            .is_none_or(|book_ids| book_ids.iter().any(|candidate| candidate == book_id))
}

pub(crate) fn require_book_access(auth: &AuthUser, book_id: &str) -> Result<(), ApiError> {
    if can_access_book(auth, book_id) {
        Ok(())
    } else {
        // Keep restricted books indistinguishable from books that are not in
        // the library, including for direct media and download URLs.
        Err(ApiError::not_found("Book not found"))
    }
}

pub(crate) async fn list_users(
    State(state): State<AppState>,
    _: AdminUser,
) -> Result<Json<Vec<UserPublic>>, ApiError> {
    let users = state.users.read().await;
    Ok(Json(users.users.iter().map(UserPublic::from).collect()))
}

pub(crate) async fn create_user(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Json(payload): Json<CreateUserRequest>,
) -> Result<Json<UserPublic>, ApiError> {
    let is_owner = payload.is_owner;
    let is_admin = payload.is_admin || is_owner;
    if is_admin && !auth.is_owner {
        return Err(ApiError::forbidden(
            "Only an owner can create an administrator or owner account.",
        ));
    }
    // Direct Libation access is an owner's grant, the same as it is on the
    // dedicated route: an administrator cannot mint a reader who downloads
    // without approval.
    if !auth.is_owner && payload.libation_access == Some(LibationAccess::Direct) {
        return Err(ApiError::forbidden(
            "Only an owner can grant direct Libation access.",
        ));
    }
    let username = normalize_username(&payload.username);
    validate_username(&username)?;
    validate_password(&payload.password)?;

    let password_hash = hash_password_async(&state, payload.password.clone()).await?;
    let new_user = User {
        id: stable_id(&format!("user:{}:{}", username, now_unix_string())),
        username,
        password_hash,
        is_admin,
        is_owner,
        // Only an owner may persist this permission. Administrators cannot
        // create administrators, and the flag is dropped for plain readers,
        // so ignoring it otherwise keeps every approver owner-minted while
        // clients that send the field regardless of role keep working.
        can_approve_libation_requests: is_owner
            || (auth.is_owner && is_admin && payload.can_approve_libation_requests),
        allowed_book_ids: if is_admin {
            None
        } else {
            payload.allowed_book_ids
        },
        libation_access: if is_owner {
            LibationAccess::Direct
        } else {
            payload.libation_access.unwrap_or(if is_admin {
                LibationAccess::Direct
            } else {
                LibationAccess::Approval
            })
        },
        share_progress: true,
        announce_finishes: true,
        notify_finishes: true,
        created_at: now_unix_string(),
    };
    let created = new_user.clone();
    state
        .users
        .mutate(move |users| {
            // Checked inside the lock so two concurrent requests cannot both
            // claim the same name.
            if users
                .users
                .iter()
                .any(|user| user.username.eq_ignore_ascii_case(&created.username))
            {
                return Err(ApiError::bad_request("That username is already taken."));
            }
            users.users.push(created);
            Ok(())
        })
        .await?;
    Ok(Json(UserPublic::from(&new_user)))
}

pub(crate) async fn delete_user(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Path(user_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if user_id == auth.id {
        return Err(ApiError::bad_request(
            "You cannot delete your own account while signed in.",
        ));
    }

    state
        .users
        .mutate(|users| {
            let target = users
                .users
                .iter()
                .find(|user| user.id == user_id)
                .ok_or(ApiError::not_found("User not found."))?;
            if (target.is_admin || target.is_owner) && !auth.is_owner {
                return Err(ApiError::forbidden(
                    "Only an owner can delete an administrator or owner.",
                ));
            }
            if target.is_owner && users.users.iter().filter(|user| user.is_owner).count() <= 1 {
                return Err(ApiError::conflict("The final owner cannot be deleted."));
            }
            users.users.retain(|user| user.id != user_id);
            Ok(())
        })
        .await?;

    state
        .sessions
        .mutate(|sessions| {
            sessions.retain(|_, session| session.user_id != user_id);
            Ok(())
        })
        .await?;

    state.progress.remove_user(&user_id).await?;
    state.book_settings.remove_user(&user_id).await?;
    // Dropped before the history purge, so a flush of the buffered sessions
    // cannot re-persist the account between the two steps.
    state.open_sessions.lock().await.forget_user(&user_id);
    state
        .reading_history
        .mutate(|history| {
            history
                .sessions
                .retain(|session| session.user_id != user_id);
            history
                .completions
                .retain(|completion| completion.user_id != user_id);
            Ok(())
        })
        .await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn change_password(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Extension(current_session): Extension<SessionToken>,
    Path(user_id): Path<String>,
    Json(payload): Json<ChangePasswordRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let changing_self = auth.id == user_id;
    if !changing_self && !auth.is_admin {
        return Err(ApiError::forbidden(
            "You can only change your own password.",
        ));
    }
    validate_password(&payload.new_password)?;

    // Verifying and hashing are deliberately done without the write lock held:
    // both are Argon2 work, and holding the lock across them queued every other
    // account change behind this request. The authority check is repeated
    // inside the mutation so nothing can change underneath it.
    let (target_id, current_hash, target_is_privileged) = {
        let users = state.users.read().await;
        let user = users
            .users
            .iter()
            .find(|user| user.id == user_id)
            .ok_or(ApiError::not_found("User not found."))?;
        (
            user.id.clone(),
            user.password_hash.clone(),
            user.is_admin || user.is_owner,
        )
    };

    if !changing_self && target_is_privileged && !auth.is_owner {
        return Err(ApiError::forbidden(
            "Only an owner can reset an administrator or owner's password.",
        ));
    }

    if changing_self {
        let current = payload.current_password.unwrap_or_default();
        if !verify_password_async(&state, current, current_hash.clone()).await? {
            return Err(ApiError::unauthorized("Current password is incorrect."));
        }
    }

    let new_hash = hash_password_async(&state, payload.new_password).await?;
    state
        .users
        .mutate(|users| {
            let user = users
                .users
                .iter_mut()
                .find(|user| user.id == user_id)
                .ok_or(ApiError::not_found("User not found."))?;
            if !changing_self && (user.is_admin || user.is_owner) && !auth.is_owner {
                return Err(ApiError::forbidden(
                    "Only an owner can reset an administrator or owner's password.",
                ));
            }
            // The password was verified before the Argon2 work. Do not let a
            // self-service request overwrite a reset that landed meanwhile.
            if changing_self && user.password_hash != current_hash {
                return Err(ApiError::unauthorized("Current password is incorrect."));
            }
            user.password_hash = new_hash;
            Ok(())
        })
        .await?;

    state
        .sessions
        .mutate(|sessions| {
            revoke_password_change_sessions(
                sessions,
                &target_id,
                changing_self.then_some(current_session.0.as_str()),
            );
            Ok(())
        })
        .await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

pub(crate) async fn update_book_access(
    State(state): State<AppState>,
    _: AdminUser,
    Path(user_id): Path<String>,
    Json(payload): Json<UpdateBookAccessRequest>,
) -> Result<Json<UserPublic>, ApiError> {
    let allowed_book_ids = if let Some(book_ids) = payload.allowed_book_ids {
        let available_ids: HashSet<String> = state
            .library
            .read()
            .await
            .books
            .iter()
            .map(|book| book.id.clone())
            .collect();
        let mut seen = HashSet::new();
        let mut normalized = Vec::new();
        for book_id in book_ids {
            if !available_ids.contains(&book_id) {
                return Err(ApiError::bad_request(format!(
                    "Book `{book_id}` is not in the library."
                )));
            }
            if seen.insert(book_id.clone()) {
                normalized.push(book_id);
            }
        }
        Some(normalized)
    } else {
        None
    };

    let public = state
        .users
        .mutate(|users| {
            let user = users
                .users
                .iter_mut()
                .find(|user| user.id == user_id)
                .ok_or(ApiError::not_found("User not found."))?;
            user.allowed_book_ids = if user.is_admin {
                None
            } else {
                allowed_book_ids
            };
            Ok(UserPublic::from(&*user))
        })
        .await?;
    Ok(Json(public))
}

pub(crate) async fn update_user_role(
    State(state): State<AppState>,
    _: OwnerUser,
    Path(user_id): Path<String>,
    Json(payload): Json<UpdateUserRoleRequest>,
) -> Result<Json<UserPublic>, ApiError> {
    let public = state
        .users
        .mutate(|users| {
            let target_index = users
                .users
                .iter()
                .position(|user| user.id == user_id)
                .ok_or(ApiError::not_found("User not found."))?;
            let was_owner = users.users[target_index].is_owner;
            if was_owner
                && !payload.is_owner
                && users.users.iter().filter(|user| user.is_owner).count() <= 1
            {
                return Err(ApiError::conflict("The final owner cannot be demoted."));
            }

            let user = &mut users.users[target_index];
            let was_admin = user.is_admin;
            user.is_owner = payload.is_owner;
            user.is_admin = payload.is_admin || payload.is_owner;
            if user.is_owner {
                user.libation_access = LibationAccess::Direct;
                user.can_approve_libation_requests = true;
                user.allowed_book_ids = None;
            } else if user.is_admin {
                user.allowed_book_ids = None;
            } else {
                user.can_approve_libation_requests = false;
                // Administrators download directly by default. Leaving the
                // tier gives that up too, rather than carrying it into a
                // reader account nobody explicitly granted it to.
                if was_admin {
                    user.libation_access = LibationAccess::Approval;
                }
            }
            Ok(UserPublic::from(&*user))
        })
        .await?;
    Ok(Json(public))
}
