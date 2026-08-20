use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{ConnectInfo, DefaultBodyLimit, Multipart, Path, Query, Request, State},
    http::{
        HeaderMap, HeaderValue, Method, StatusCode,
        header::{
            ACCEPT_RANGES, AUTHORIZATION, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE,
            CONTENT_TYPE, COOKIE, ETAG, HOST, IF_NONE_MATCH, ORIGIN, RANGE, REFERER, SET_COOKIE,
        },
    },
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::{any, delete, get, post, put},
};
use base64::{Engine as _, engine::general_purpose};
use id3::frame::Content as Id3Content;
use lofty::{
    file::{AudioFile, TaggedFileExt},
    picture::PictureType,
    prelude::Accessor,
    read_from_path,
    tag::{ItemKey, ItemValue, Tag},
};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use rand::RngExt;
use rand_core::OsRng as PasswordOsRng;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use sha2::Sha256;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env, io,
    io::{Read, Write},
    net::{IpAddr, SocketAddr},
    path::{Path as FsPath, PathBuf},
    sync::{Arc, LazyLock},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom};
use tokio::{
    fs,
    process::Command,
    sync::{Mutex, OwnedMutexGuard, OwnedSemaphorePermit, RwLock, Semaphore},
};
use tokio_util::io::ReaderStream;
use tower_http::{
    cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer},
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use walkdir::WalkDir;

mod alignment;
mod faststart;
mod updates;

const AUDIO_EXTENSIONS: &[&str] = &[
    "aac", "aiff", "flac", "m4a", "m4b", "mp3", "mp4", "ogg", "opus", "wav",
];
const READING_EXTENSIONS: &[&str] = &["epub", "html", "htm", "pdf", "txt"];
const SYNC_SIDECAR_SUFFIX: &str = ".sync.json";
const LIBATION_METADATA_SIDECAR_SUFFIX: &str = ".metadata.json";
const MAX_LIBATION_METADATA_BYTES: u64 = 4 * 1024 * 1024;
const SESSION_COOKIE_NAME: &str = "operalibre_session";
const SESSION_COOKIE_MAX_AGE_SECONDS: u64 = 60 * 60 * 24 * 30;
const LOGIN_MAX_FAILURES: u32 = 5;
const LOGIN_IP_MAX_FAILURES: u32 = 25;
const LOGIN_LOCKOUT_SECONDS: u64 = 60;
const LOGIN_THROTTLE_KEY_MAX_CHARS: usize = 64;
const LOGIN_THROTTLE_MAX_ENTRIES: usize = 10_000;
const PASSWORD_TASK_CONCURRENCY: usize = 4;
const MIN_PASSWORD_CHARS: usize = 12;
const MAX_PASSWORD_CHARS: usize = 1_024;
const MAX_SESSIONS_PER_USER: usize = 20;
const MAX_SESSIONS_TOTAL: usize = 1_000;
const GIBIBYTE_BYTES: u64 = 1024 * 1024 * 1024;
const DEFAULT_MAX_UPLOAD_GIB: u64 = 20;
const DEFAULT_MAX_BOOK_DOWNLOAD_GIB: u64 = 25;
const DEFAULT_MAX_CONCURRENT_BOOK_DOWNLOADS: usize = 1;
const DEFAULT_MIN_DOWNLOAD_FREE_GIB: u64 = 2;
const MAX_CONFIGURED_BOOK_DOWNLOAD_CONCURRENCY: usize = 32;
const SETUP_TOKEN_LIFETIME_SECONDS: u64 = 30 * 60;
const OFFICIAL_APP_ORIGINS: &[&str] = &[
    "capacitor://localhost",
    "http://localhost",
    "http://127.0.0.1:49201",
];
const MAX_UPLOAD_FILES: usize = 1_000;
const UPLOAD_STAGING_PREFIX: &str = ".operalibre-upload-";
const MAX_PENDING_LIBATION_REQUESTS_PER_USER: usize = 100;
const MAX_TRACKED_LIBATION_REQUESTS: usize = 1_000;
const DEFAULT_LIBATION_AUTO_REFRESH_HOURS: u64 = 24;
const DEFAULT_LIBATION_READER_REFRESHES_PER_HOUR: u64 = 3;
const LIBATION_READER_REFRESH_WINDOW_SECONDS: u64 = 60 * 60;
const LIBATION_REFRESH_SCHEDULER_POLL_SECONDS: u64 = 15 * 60;
const LIBATION_LOGIN_SESSION_SECONDS: u64 = 10 * 60;
const LIBATION_LOGIN_START_TIMEOUT_SECONDS: u64 = 30;
const MAX_LIBATION_ACCOUNT_LABEL_CHARS: usize = 80;
const MAX_LIBATION_ACCOUNT_ID_CHARS: usize = 320;
const MAX_LIBATION_RESPONSE_URL_CHARS: usize = 16_384;
// ReaderStream otherwise reads in very small chunks. A larger media chunk
// keeps browser buffers supplied through brief scheduler or network jitter,
// which matters more as playback speed increases.
const MEDIA_STREAM_BUFFER_CAPACITY: usize = 256 * 1024;
const ACTIVITY_BASELINE_KEY: &str = "__operalibre_position_baseline__";

#[derive(Clone)]
struct AppState {
    deployment_mode: DeploymentMode,
    csrf_allowed_origins: Arc<HashSet<String>>,
    setup_token: Arc<Mutex<Option<SetupToken>>>,
    max_upload_bytes: Option<u64>,
    max_book_download_bytes: Option<u64>,
    download_temp_dir: PathBuf,
    min_download_free_bytes: u64,
    library_root: PathBuf,
    library_identities_file: PathBuf,
    progress_file: PathBuf,
    book_settings_file: PathBuf,
    users_file: PathBuf,
    sessions_file: PathBuf,
    activity_file: PathBuf,
    finish_events_file: PathBuf,
    metadata_overrides_file: PathBuf,
    libation_requests_file: PathBuf,
    libation_refreshes_file: PathBuf,
    libation_accounts_file: PathBuf,
    libation_accounts_root: PathBuf,
    libation_config: LibationConfig,
    alignment_config: AlignmentConfig,
    /// ffmpeg/ffprobe, when they were found. `None` disables faststart
    /// conversion entirely.
    faststart_tools: Option<faststart::Tools>,
    update_manager: updates::UpdateManager,
    sync_dir: PathBuf,
    library: Arc<RwLock<LibraryState>>,
    metadata_overrides: Arc<RwLock<MetadataOverrideStore>>,
    jobs: Arc<RwLock<HashMap<String, JobStatus>>>,
    users: Arc<RwLock<UsersStore>>,
    sessions: Arc<RwLock<HashMap<String, Session>>>,
    activity: Arc<RwLock<ActivityStore>>,
    finish_events: Arc<RwLock<FinishEventStore>>,
    libation_requests: Arc<RwLock<LibationRequestStore>>,
    libation_refreshes: Arc<Mutex<LibationRefreshStore>>,
    libation_accounts: Arc<RwLock<ManagedLibationAccountStore>>,
    libation_login_sessions: Arc<Mutex<HashMap<String, PendingLibationLogin>>>,
    /// Serializes read-modify-write cycles on the progress file so concurrent
    /// updates cannot overwrite each other.
    progress_write_lock: Arc<Mutex<()>>,
    /// Same guarantee for the per-book settings file.
    book_settings_write_lock: Arc<Mutex<()>>,
    /// Library scans read and replace one shared identity snapshot. Serialize
    /// them so overlapping imports, downloads, and manual rescans cannot
    /// publish stale state over a newer scan.
    rescan_lock: Arc<Mutex<()>>,
    /// Libation uses shared account and library files. Run its commands one at
    /// a time so a second title has a real queue state instead of racing the
    /// first download.
    libation_job_lock: Arc<Mutex<()>>,
    /// Faststart conversion rewrites library files. One job at a time, so two
    /// admins cannot remux the same book from opposite ends.
    faststart_lock: Arc<Mutex<()>>,
    login_attempts: Arc<Mutex<HashMap<String, LoginThrottle>>>,
    password_task_slots: Arc<Semaphore>,
    download_task_slots: Arc<Semaphore>,
    upload_lock: Arc<Mutex<()>>,
}

#[derive(Debug, Clone, Copy)]
struct LoginThrottle {
    failures: u32,
    last_failure: u64,
}

impl LoginThrottle {
    fn is_locked(&self, now_seconds: u64, max_failures: u32) -> bool {
        self.failures >= max_failures
            && now_seconds.saturating_sub(self.last_failure) < LOGIN_LOCKOUT_SECONDS
    }

    fn is_stale(&self, now_seconds: u64) -> bool {
        now_seconds.saturating_sub(self.last_failure) >= LOGIN_LOCKOUT_SECONDS
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(transparent)]
struct ActivityStore {
    by_user: HashMap<String, BTreeMap<String, f64>>,
}

/// The shared record of who finished what.
///
/// `SharedProgress` is recomputed from `progress.json` on every library read,
/// so it can say a book *is* finished but never that finishing it just
/// happened. The feed needs the event, so finishes are appended here as they
/// occur, and each listener carries a mark for how far down the list they have
/// already read.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinishEventStore {
    #[serde(default)]
    events: Vec<FinishEvent>,
    /// user id -> the id of the last event that listener has seen.
    #[serde(default)]
    seen: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinishEvent {
    id: String,
    user_id: String,
    book_id: String,
    /// Snapshotted because a rescan can drop the book from the library while
    /// the event stays worth reading. The live title wins when it is still
    /// there, so a retitled book reads correctly.
    book_title: String,
    finished_at: String,
}

/// The feed is a "what did I miss" list, not an archive, and it lives in a
/// JSON file that is rewritten whole. Old events are dropped once the list
/// outgrows this.
const FINISH_EVENT_LIMIT: usize = 500;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(transparent)]
struct MetadataOverrideStore {
    books: HashMap<String, BookMetadataOverride>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookMetadataOverride {
    title: Option<String>,
    author: Option<String>,
    narrator: Option<String>,
    description: Option<String>,
    genres: Option<Vec<String>>,
    published_date: Option<String>,
    publisher: Option<String>,
    series: Option<String>,
    series_position: Option<String>,
    asin: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct User {
    id: String,
    username: String,
    password_hash: String,
    is_admin: bool,
    #[serde(default)]
    is_owner: bool,
    #[serde(default)]
    can_approve_libation_requests: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    allowed_book_ids: Option<Vec<String>>,
    #[serde(default)]
    libation_access: LibationAccess,
    /// Whether this listener's reading status is visible to the other users on
    /// the server. Accounts created before the setting existed are treated as
    /// sharing, matching the default for new accounts.
    #[serde(default = "default_share_progress")]
    share_progress: bool,
    /// Whether finishing a book adds an entry to the shared activity feed.
    /// Only consulted while `share_progress` is on: a listener who is not
    /// sharing at all has nothing to announce.
    #[serde(default = "default_true")]
    announce_finishes: bool,
    /// Whether the finishes other listeners announce are delivered to this
    /// one. Also gated on `share_progress`, which stays reciprocal: someone
    /// who has withdrawn their own activity does not receive anyone else's.
    #[serde(default = "default_true")]
    notify_finishes: bool,
    created_at: String,
}

fn default_share_progress() -> bool {
    true
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UserPublic {
    id: String,
    username: String,
    is_admin: bool,
    is_owner: bool,
    can_approve_libation_requests: bool,
    allowed_book_ids: Option<Vec<String>>,
    libation_access: LibationAccess,
    share_progress: bool,
    announce_finishes: bool,
    notify_finishes: bool,
    created_at: String,
}

impl From<&User> for UserPublic {
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
            created_at: user.created_at.clone(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct UsersStore {
    #[serde(default)]
    permissions_version: u32,
    #[serde(default)]
    users: Vec<User>,
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
struct Session {
    user_id: String,
    created_at: u64,
}

impl Session {
    fn is_expired(&self, now_seconds: u64) -> bool {
        now_seconds.saturating_sub(self.created_at) > SESSION_COOKIE_MAX_AGE_SECONDS
    }
}

#[derive(Debug, Clone)]
struct AuthUser {
    id: String,
    username: String,
    is_admin: bool,
    is_owner: bool,
    can_approve_libation_requests: bool,
    allowed_book_ids: Option<Vec<String>>,
    libation_access: LibationAccess,
    share_progress: bool,
    announce_finishes: bool,
    notify_finishes: bool,
}

#[derive(Debug, Clone)]
struct SessionToken(String);

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum LibationAccess {
    Direct,
    #[default]
    Approval,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct LibationRequestStore {
    #[serde(default)]
    requests: Vec<LibationDownloadRequest>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibationRefreshStore {
    #[serde(default)]
    last_successful_scan: Option<u64>,
    #[serde(default)]
    manual_refreshes: HashMap<String, Vec<u64>>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedLibationAccountStore {
    #[serde(default)]
    accounts: Vec<ManagedLibationAccount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedLibationAccount {
    id: String,
    label: String,
    account_id: String,
    locale: String,
    added_by: String,
    added_at: String,
    #[serde(default = "default_libation_connection_state")]
    connection_state: String,
    #[serde(default)]
    authenticated: bool,
    #[serde(default)]
    last_successful_auth: Option<String>,
    #[serde(default)]
    last_successful_refresh: Option<String>,
    #[serde(default)]
    last_error: Option<String>,
}

fn default_libation_connection_state() -> String {
    "needs_sign_in".to_string()
}

struct PendingLibationLogin {
    profile_id: String,
    expires_at: u64,
    response_sender: std::sync::mpsc::Sender<String>,
    completion: tokio::sync::oneshot::Receiver<Result<String, String>>,
    _job_guard: OwnedMutexGuard<()>,
}

struct InteractiveLibationLogin {
    started: tokio::sync::oneshot::Receiver<Result<String, String>>,
    response_sender: std::sync::mpsc::Sender<String>,
    completion: tokio::sync::oneshot::Receiver<Result<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibationDownloadRequest {
    id: String,
    user_id: String,
    username: String,
    asin: String,
    #[serde(default)]
    profile_id: Option<String>,
    #[serde(default)]
    profile_name: Option<String>,
    #[serde(default)]
    catalog_id: Option<String>,
    title: String,
    status: String,
    requested_at: String,
    decided_at: Option<String>,
    decided_by: Option<String>,
    job_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateLibationAccessRequest {
    libation_access: LibationAccess,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateUserRoleRequest {
    is_admin: bool,
    #[serde(default)]
    is_owner: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateLibationApprovalRequest {
    can_approve_libation_requests: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgressSharingRequest {
    share_progress: bool,
    /// Omitted by clients that predate the finish feed, which must leave the
    /// two finer settings exactly as they were rather than resetting them.
    #[serde(default)]
    announce_finishes: Option<bool>,
    #[serde(default)]
    notify_finishes: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateLibationDownloadRequest {
    title: String,
    #[serde(default)]
    profile_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartLibationLoginRequest {
    #[serde(default)]
    profile_id: Option<String>,
    label: String,
    account_id: String,
    locale: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteLibationLoginRequest {
    response_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateLibationAccountRequest {
    label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibationLoginStarted {
    session_id: String,
    profile_id: String,
    login_url: String,
    expires_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecideLibationDownloadRequest {
    approved: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibationAccessResponse {
    enabled: bool,
    libation_access: LibationAccess,
    auto_refresh_hours: Option<u64>,
    manual_refreshes_per_hour: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginRequest {
    username: String,
    password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupRequest {
    username: String,
    password: String,
    #[serde(default)]
    setup_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateUserRequest {
    username: String,
    password: String,
    #[serde(default)]
    is_admin: bool,
    #[serde(default)]
    is_owner: bool,
    #[serde(default)]
    can_approve_libation_requests: bool,
    #[serde(default)]
    libation_access: Option<LibationAccess>,
    #[serde(default)]
    allowed_book_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBookAccessRequest {
    allowed_book_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePasswordRequest {
    #[serde(default)]
    current_password: Option<String>,
    new_password: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginResponse {
    token: String,
    media_token: String,
    user: UserPublic,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthStatus {
    setup_required: bool,
    setup_token_required: bool,
    setup_local_only: bool,
    user: Option<UserPublic>,
    media_token: Option<String>,
}

#[derive(Default)]
struct LibraryState {
    books: Vec<Book>,
    /// File for a root-level single-track book, or the containing directory
    /// for a grouped book. Used by the admin-only local-copy deletion route.
    book_paths: HashMap<String, PathBuf>,
    track_paths: HashMap<String, PathBuf>,
    reading_paths: HashMap<String, PathBuf>,
    /// Sync map file paths keyed by book id.
    sync_paths: HashMap<String, PathBuf>,
    cover_art: HashMap<String, EmbeddedImage>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryIdentityStore {
    #[serde(default)]
    books: Vec<BookIdentity>,
    /// Track fingerprints keyed by library-relative path, so a rescan only
    /// re-reads files whose size or modification time actually changed.
    #[serde(default)]
    fingerprint_cache: BTreeMap<String, CachedFingerprint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedFingerprint {
    fingerprint: String,
    size: u64,
    modified_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookIdentity {
    fingerprint: String,
    book_id: String,
    #[serde(default)]
    paths: Vec<String>,
    #[serde(default)]
    tracks: Vec<TrackIdentity>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackIdentity {
    fingerprint: String,
    track_id: String,
    #[serde(default)]
    paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Track {
    id: String,
    title: String,
    file_name: String,
    index: usize,
    duration_seconds: Option<f64>,
    stream_url: String,
    chapters: Vec<Chapter>,
    metadata: MetadataSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Book {
    id: String,
    title: String,
    author: Option<String>,
    narrator: Option<String>,
    duration_seconds: Option<f64>,
    track_count: usize,
    cover_art_url: Option<String>,
    description: Option<String>,
    genres: Vec<String>,
    published_date: Option<String>,
    asin: Option<String>,
    reading_file: Option<ReadingFile>,
    sync_file: Option<SyncFile>,
    chapters: Vec<Chapter>,
    metadata: MetadataSummary,
    tracks: Vec<Track>,
    progress: Option<BookProgress>,
    /// What the *other* listeners on this server have done with the book.
    /// Only populated for viewers who share their own progress, and only with
    /// users who share theirs.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    shared_progress: Vec<SharedProgress>,
    /// The viewer's own playback gain for this book, as a linear multiplier of
    /// the file's level. Books are mastered at wildly different loudnesses, so
    /// this is per book rather than a single device volume.
    volume_gain: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadingFile {
    id: String,
    file_name: String,
    extension: String,
    content_type: String,
    url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncFile {
    file_name: String,
    /// `sidecar` when found beside the audiobook, `generated` when produced
    /// by the alignment job into the server's data directory.
    source: String,
    url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BookProgress {
    status: BookProgressStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    finished_override: Option<bool>,
    book_position_seconds: f64,
    duration_seconds: Option<f64>,
    remaining_seconds: Option<f64>,
    percent_complete: Option<f64>,
    updated_at: String,
}

/// One other listener's position in a book, as shown to a viewer who also
/// shares. Deliberately narrower than `BookProgress`: a percentage and a
/// status, never a resume point someone else could act on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SharedProgress {
    user_id: String,
    username: String,
    status: BookProgressStatus,
    percent_complete: Option<f64>,
    updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum BookProgressStatus {
    NotStarted,
    InProgress,
    Finished,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Chapter {
    id: String,
    title: String,
    track_id: String,
    track_index: usize,
    start_seconds: f64,
    end_seconds: Option<f64>,
    source: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct MetadataSummary {
    album: Option<String>,
    subtitle: Option<String>,
    publisher: Option<String>,
    published_date: Option<String>,
    description: Option<String>,
    language: Option<String>,
    series: Option<String>,
    series_position: Option<String>,
    genres: Vec<String>,
    raw_fields: Vec<MetadataField>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MetadataField {
    key: String,
    value: String,
    description: Option<String>,
}

#[derive(Debug, Clone)]
struct EmbeddedImage {
    mime_type: String,
    data: Vec<u8>,
    etag: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    book_id: String,
    track_id: String,
    position_seconds: f64,
    #[serde(default)]
    book_position_seconds: f64,
    duration_seconds: Option<f64>,
    updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    finished_override: Option<bool>,
}

/// A book's playback gain as a linear multiplier. The floor tames a book
/// mastered hot; the ceiling is +24 dB, far enough to rescue a badly quiet
/// transfer, and past the point where the limiter starts doing much of the
/// work — which is the listener's trade to make.
const BOOK_VOLUME_GAIN_MIN: f64 = 0.5;
const BOOK_VOLUME_GAIN_MAX: f64 = 16.0;
const BOOK_VOLUME_GAIN_DEFAULT: f64 = 1.0;

fn clamp_book_volume_gain(value: f64) -> f64 {
    if !value.is_finite() {
        return BOOK_VOLUME_GAIN_DEFAULT;
    }
    value.clamp(BOOK_VOLUME_GAIN_MIN, BOOK_VOLUME_GAIN_MAX)
}

/// Per-listener, per-book playback preferences, keyed like progress so one
/// listener's tuning never leaks into another's library.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookSettings {
    /// Defaulted rather than required: this file is read on the way to serving
    /// the whole library, so a row that is truncated, hand-edited, or written
    /// by a future build with another shape must cost one book its gain — not
    /// hide every book from every listener behind a 500.
    #[serde(default = "default_book_volume_gain")]
    volume_gain: f64,
}

fn default_book_volume_gain() -> f64 {
    BOOK_VOLUME_GAIN_DEFAULT
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookVolumeUpdate {
    volume_gain: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProgressUpdate {
    track_id: String,
    position_seconds: f64,
    book_position_seconds: Option<f64>,
    duration_seconds: Option<f64>,
    /// Client-side epoch milliseconds of when this position was recorded.
    /// Optional for backwards compatibility; without it the write is always
    /// accepted and stamped with the server clock, as before.
    updated_at_ms: Option<u64>,
    /// Set when the listener deliberately jumped backwards (restarting a
    /// book, scrubbing, picking an earlier chapter). Without it the server
    /// refuses near-zero writes that would erase substantial progress.
    #[serde(default)]
    intentional_regression: bool,
    /// Set for either a forward or backward user-initiated seek. Position
    /// movement from this checkpoint must not be counted as listening time.
    #[serde(default)]
    intentional_seek: bool,
    /// The listener's offset from UTC in minutes, east positive (the negation
    /// of JavaScript's `getTimezoneOffset`). Activity is bucketed by the
    /// listener's own calendar day, so an evening session west of UTC is not
    /// filed under tomorrow and does not split a streak. Absent means UTC.
    tz_offset_minutes: Option<i32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompletionUpdate {
    finished: bool,
    track_id: Option<String>,
    position_seconds: Option<f64>,
    book_position_seconds: Option<f64>,
    duration_seconds: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BookMetadataUpdate {
    title: String,
    author: Option<String>,
    narrator: Option<String>,
    description: Option<String>,
    genres: Vec<String>,
    published_date: Option<String>,
    publisher: Option<String>,
    series: Option<String>,
    series_position: Option<String>,
    asin: Option<String>,
}

#[derive(Default)]
struct TrackMetadata {
    title: Option<String>,
    author: Option<String>,
    narrator: Option<String>,
    duration_seconds: Option<f64>,
    asin: Option<String>,
    chapters: Vec<ParsedChapter>,
    cover_art: Option<EmbeddedImage>,
    summary: MetadataSummary,
}

/// The raw sidecar Libation can save beside a liberated audiobook. Its schema
/// mirrors Audible responses and has changed over time, so we extract the
/// stable, user-facing fields rather than deserializing one rigid version.
#[derive(Default)]
struct LibationSidecarMetadata {
    title: Option<String>,
    subtitle: Option<String>,
    author: Option<String>,
    narrator: Option<String>,
    asin: Option<String>,
    summary: MetadataSummary,
}

#[derive(Default)]
struct ParsedChapter {
    title: String,
    start_seconds: f64,
    end_seconds: Option<f64>,
    source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibationStatus {
    enabled: bool,
    cli_path: Option<String>,
    libation_files_dir: Option<String>,
    library_root: String,
    accounts: Vec<LibationAccount>,
    authenticated: bool,
    message: Option<String>,
    auto_refresh_hours: Option<u64>,
    manual_refreshes_per_hour: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibationAccount {
    id: String,
    account_id: String,
    name: Option<String>,
    locale: String,
    scan_library: bool,
    authenticated: bool,
    managed: bool,
    connection_state: String,
    last_successful_auth: Option<String>,
    last_successful_refresh: Option<String>,
    last_error: Option<String>,
    added_by: Option<String>,
    added_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibationBook {
    catalog_id: String,
    profile_id: String,
    profile_name: String,
    account_id: Option<String>,
    asin: String,
    title: String,
    subtitle: Option<String>,
    authors: Option<String>,
    narrators: Option<String>,
    length_minutes: Option<i64>,
    description: Option<String>,
    publisher: Option<String>,
    book_status: Option<String>,
    pdf_status: Option<String>,
    content_type: Option<String>,
    locale: Option<String>,
    last_downloaded: Option<String>,
    is_audible_plus: bool,
    cover_art_url: Option<String>,
    local_book_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobStatus {
    id: String,
    kind: String,
    target_id: Option<String>,
    status: String,
    started_at: String,
    finished_at: Option<String>,
    exit_code: Option<i32>,
    output: String,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobCreated {
    job_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct LibationExportRecord {
    #[serde(rename = "Account")]
    #[serde(alias = "AccountId")]
    account: Option<String>,
    #[serde(rename = "Audible Product Id")]
    #[serde(alias = "AudibleProductId")]
    audible_product_id: Option<String>,
    #[serde(rename = "Title")]
    title: Option<String>,
    #[serde(rename = "Subtitle")]
    subtitle: Option<String>,
    #[serde(rename = "Authors")]
    #[serde(alias = "AuthorNames")]
    author_names: Option<String>,
    #[serde(rename = "Narrators")]
    #[serde(alias = "NarratorNames")]
    narrator_names: Option<String>,
    #[serde(rename = "Length In Minutes")]
    #[serde(alias = "LengthInMinutes")]
    length_in_minutes: Option<i64>,
    #[serde(rename = "Description")]
    description: Option<String>,
    #[serde(rename = "Publisher")]
    publisher: Option<String>,
    #[serde(rename = "Book Liberated Status")]
    #[serde(alias = "BookStatus")]
    book_status: Option<String>,
    #[serde(rename = "PDF Liberated Status")]
    #[serde(alias = "PdfStatus")]
    pdf_status: Option<String>,
    #[serde(rename = "Content Type")]
    #[serde(alias = "ContentType")]
    content_type: Option<String>,
    #[serde(rename = "Locale")]
    locale: Option<String>,
    #[serde(rename = "Last Downloaded")]
    #[serde(alias = "LastDownloaded")]
    last_downloaded: Option<String>,
    #[serde(rename = "Is Audible Plus?")]
    #[serde(alias = "IsAudiblePlus")]
    is_audible_plus: Option<bool>,
    #[serde(rename = "Cover Id")]
    #[serde(alias = "PictureId")]
    picture_id: Option<String>,
    #[serde(rename = "Cover Id Large")]
    #[serde(alias = "PictureLarge")]
    picture_large: Option<String>,
}

#[derive(Debug, Clone)]
struct ServerConfig {
    deployment_mode: DeploymentMode,
    host: String,
    port: u16,
    max_upload_bytes: Option<u64>,
    max_book_download_bytes: Option<u64>,
    max_concurrent_book_downloads: usize,
    download_temp_dir: PathBuf,
    min_download_free_bytes: u64,
    library_root: PathBuf,
    data_dir: PathBuf,
    progress_file: PathBuf,
    users_file: PathBuf,
    sessions_file: PathBuf,
    activity_file: PathBuf,
    finish_events_file: PathBuf,
    metadata_overrides_file: PathBuf,
    libation_requests_file: PathBuf,
    libation_cli_path: Option<PathBuf>,
    libation_files_dir: Option<PathBuf>,
    libation_auto_refresh_hours: u64,
    libation_reader_refreshes_per_hour: u64,
    alignment_cli_path: Option<PathBuf>,
    ffmpeg_path: Option<PathBuf>,
    ffprobe_path: Option<PathBuf>,
    allowed_origins: Vec<String>,
    web_dist_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeploymentMode {
    Local,
    Lan,
    Proxy,
}

impl DeploymentMode {
    fn parse(value: &str) -> anyhow::Result<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "local" => Ok(Self::Local),
            "lan" => Ok(Self::Lan),
            "proxy" => Ok(Self::Proxy),
            _ => anyhow::bail!(
                "Invalid deployment_mode `{value}`: expected `local`, `lan`, or `proxy`."
            ),
        }
    }

    fn default_host(self) -> &'static str {
        match self {
            Self::Lan => "0.0.0.0",
            Self::Local | Self::Proxy => "127.0.0.1",
        }
    }

    fn secure_cookies(self) -> bool {
        !matches!(self, Self::Lan)
    }

    fn allows_remote_setup(self) -> bool {
        !matches!(self, Self::Local)
    }

    fn setup_token_required(self, remote_client: bool) -> bool {
        matches!(self, Self::Proxy) || (matches!(self, Self::Lan) && remote_client)
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Lan => "lan",
            Self::Proxy => "proxy",
        }
    }
}

fn resolve_deployment_settings(
    configured_mode: Option<String>,
    configured_host: Option<String>,
) -> anyhow::Result<(DeploymentMode, String)> {
    let deployment_mode = configured_mode
        .map(|value| DeploymentMode::parse(&value))
        .transpose()?
        .unwrap_or_else(|| {
            configured_host
                .as_deref()
                .and_then(|host| host.parse::<IpAddr>().ok())
                .filter(|address| !address.is_loopback())
                .map(|_| DeploymentMode::Lan)
                .unwrap_or(DeploymentMode::Local)
        });
    let host = configured_host.unwrap_or_else(|| deployment_mode.default_host().to_string());
    let host_address = host.parse::<IpAddr>().map_err(|error| {
        anyhow::anyhow!("Invalid server host `{host}`: use a numeric IP address ({error})")
    })?;
    if matches!(
        deployment_mode,
        DeploymentMode::Local | DeploymentMode::Proxy
    ) && !host_address.is_loopback()
    {
        anyhow::bail!(
            "deployment_mode = {} requires a loopback host such as 127.0.0.1; use deployment_mode = lan for a direct trusted-network listener",
            deployment_mode.as_str()
        );
    }
    Ok((deployment_mode, host))
}

#[derive(Debug)]
struct SetupToken {
    digest: [u8; 32],
    expires_at: u64,
}

impl SetupToken {
    fn new(token: &str, now_seconds: u64) -> Self {
        Self {
            digest: setup_token_digest(token),
            expires_at: now_seconds.saturating_add(SETUP_TOKEN_LIFETIME_SECONDS),
        }
    }

    fn matches(&self, candidate: &str, now_seconds: u64) -> bool {
        now_seconds <= self.expires_at
            && constant_time_eq(&self.digest, &setup_token_digest(candidate))
    }
}

impl ServerConfig {
    fn load() -> anyhow::Result<Self> {
        let current_dir = env::current_dir()?;
        let explicit_config_path = env::var_os("OPERALIBRE_SERVER_CONFIG").map(PathBuf::from);
        let config_path = explicit_config_path
            .clone()
            .unwrap_or_else(|| current_dir.join("server.config"));
        let config_dir = config_path
            .parent()
            .map(FsPath::to_path_buf)
            .unwrap_or_else(|| current_dir.clone());
        let values = read_server_config_file(&config_path, explicit_config_path.is_some())?;

        let library_root = config_path_value(&values, &config_dir, "library_root")
            .or_else(|| config_path_value(&values, &config_dir, "audiobook_library"))
            .or_else(|| env_path_value("OPERALIBRE_LIBRARY"))
            .unwrap_or_else(|| current_dir.join("library"));
        let data_dir = config_path_value(&values, &config_dir, "data_dir")
            .or_else(|| env_path_value("OPERALIBRE_DATA_DIR"))
            .unwrap_or_else(|| current_dir.join("data"));
        let progress_file = config_path_value(&values, &config_dir, "progress_file")
            .or_else(|| env_path_value("OPERALIBRE_PROGRESS_FILE"))
            .unwrap_or_else(|| data_dir.join("progress.json"));
        let users_file = config_path_value(&values, &config_dir, "users_file")
            .or_else(|| env_path_value("OPERALIBRE_USERS_FILE"))
            .unwrap_or_else(|| data_dir.join("users.json"));
        let sessions_file = data_dir.join("sessions.json");
        let activity_file = config_path_value(&values, &config_dir, "activity_file")
            .or_else(|| env_path_value("OPERALIBRE_ACTIVITY_FILE"))
            .unwrap_or_else(|| data_dir.join("activity.json"));
        let finish_events_file = config_path_value(&values, &config_dir, "finish_events_file")
            .or_else(|| env_path_value("OPERALIBRE_FINISH_EVENTS_FILE"))
            .unwrap_or_else(|| data_dir.join("finish-events.json"));
        let metadata_overrides_file =
            config_path_value(&values, &config_dir, "metadata_overrides_file")
                .or_else(|| env_path_value("OPERALIBRE_METADATA_OVERRIDES_FILE"))
                .unwrap_or_else(|| data_dir.join("metadata-overrides.json"));
        let libation_requests_file = data_dir.join("libation-requests.json");
        let libation_auto_refresh_hours = config_u64_value(&values, "libation_auto_refresh_hours")?
            .unwrap_or(DEFAULT_LIBATION_AUTO_REFRESH_HOURS);
        let libation_reader_refreshes_per_hour =
            config_u64_value(&values, "libation_reader_refreshes_per_hour")?
                .unwrap_or(DEFAULT_LIBATION_READER_REFRESHES_PER_HOUR);

        let configured_host =
            config_string_value(&values, "host").or_else(|| env_string_value("HOST"));
        let configured_mode = config_string_value(&values, "deployment_mode")
            .or_else(|| env_string_value("OPERALIBRE_DEPLOYMENT_MODE"));
        let (deployment_mode, host) =
            resolve_deployment_settings(configured_mode, configured_host)?;
        let max_upload_bytes = config_gib_limit(&values, "max_upload_gib", DEFAULT_MAX_UPLOAD_GIB)?;
        let max_book_download_bytes = config_gib_limit(
            &values,
            "max_book_download_gib",
            DEFAULT_MAX_BOOK_DOWNLOAD_GIB,
        )?;
        let max_concurrent_book_downloads = config_bounded_usize(
            &values,
            "max_concurrent_book_downloads",
            DEFAULT_MAX_CONCURRENT_BOOK_DOWNLOADS,
            1,
            MAX_CONFIGURED_BOOK_DOWNLOAD_CONCURRENCY,
        )?;
        let download_temp_dir = config_path_value(&values, &config_dir, "download_temp_dir")
            .or_else(|| env_path_value("OPERALIBRE_DOWNLOAD_TEMP_DIR"))
            .unwrap_or_else(|| data_dir.join("download-temp"));
        let min_download_free_gib = config_u64_value(&values, "min_download_free_gib")?
            .unwrap_or(DEFAULT_MIN_DOWNLOAD_FREE_GIB);
        let min_download_free_bytes = min_download_free_gib
            .checked_mul(GIBIBYTE_BYTES)
            .ok_or_else(|| anyhow::anyhow!(
                "Invalid server.config `min_download_free_gib` value `{min_download_free_gib}`: size overflows bytes"
            ))?;

        Ok(Self {
            deployment_mode,
            host,
            port: config_u16_value(&values, "port")?
                .or_else(|| env_u16_value("PORT"))
                .unwrap_or(4000),
            max_upload_bytes,
            max_book_download_bytes,
            max_concurrent_book_downloads,
            download_temp_dir,
            min_download_free_bytes,
            library_root,
            data_dir,
            progress_file,
            users_file,
            sessions_file,
            activity_file,
            finish_events_file,
            metadata_overrides_file,
            libation_requests_file,
            libation_cli_path: config_path_value(&values, &config_dir, "libation_cli_path")
                .or_else(|| env_path_value("LIBATION_CLI_PATH")),
            libation_files_dir: config_path_value(&values, &config_dir, "libation_files_dir")
                .or_else(|| env_path_value("LIBATION_FILES_DIR")),
            libation_auto_refresh_hours,
            libation_reader_refreshes_per_hour,
            alignment_cli_path: config_path_value(&values, &config_dir, "alignment_cli_path")
                .or_else(|| env_path_value("OPERALIBRE_ALIGNMENT_CLI_PATH")),
            ffmpeg_path: config_path_value(&values, &config_dir, "ffmpeg_path")
                .or_else(|| env_path_value("OPERALIBRE_FFMPEG_PATH")),
            ffprobe_path: config_path_value(&values, &config_dir, "ffprobe_path")
                .or_else(|| env_path_value("OPERALIBRE_FFPROBE_PATH")),
            allowed_origins: config_string_value(&values, "allowed_origins")
                .or_else(|| env_string_value("OPERALIBRE_ALLOWED_ORIGINS"))
                .map(parse_origin_list)
                .unwrap_or_default(),
            web_dist_dir: config_path_value(&values, &config_dir, "web_dist_dir")
                .or_else(|| env_path_value("OPERALIBRE_WEB_DIST_DIR")),
        })
    }
}

fn read_server_config_file(
    config_path: &FsPath,
    explicit: bool,
) -> anyhow::Result<HashMap<String, String>> {
    let contents = match std::fs::read_to_string(config_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound && !explicit => {
            return Ok(HashMap::new());
        }
        Err(error) => return Err(error.into()),
    };

    parse_server_config(&contents)
}

fn parse_server_config(contents: &str) -> anyhow::Result<HashMap<String, String>> {
    let allowed_keys = [
        "deployment_mode",
        "host",
        "port",
        "max_upload_gib",
        "max_book_download_gib",
        "max_concurrent_book_downloads",
        "download_temp_dir",
        "min_download_free_gib",
        "library_root",
        "audiobook_library",
        "data_dir",
        "progress_file",
        "users_file",
        "activity_file",
        "finish_events_file",
        "metadata_overrides_file",
        "libation_cli_path",
        "libation_files_dir",
        "libation_auto_refresh_hours",
        "libation_reader_refreshes_per_hour",
        "alignment_cli_path",
        "ffmpeg_path",
        "ffprobe_path",
        "allowed_origins",
        "web_dist_dir",
    ];
    let mut values = HashMap::new();

    for (index, raw_line) in contents.lines().enumerate() {
        let line_number = index + 1;
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let Some((key, value)) = line.split_once('=') else {
            anyhow::bail!("Invalid server.config line {line_number}: expected `key = value`.");
        };
        let key = key.trim().to_ascii_lowercase().replace('-', "_");
        if key.is_empty() {
            anyhow::bail!("Invalid server.config line {line_number}: setting name is empty.");
        }
        if !allowed_keys.contains(&key.as_str()) {
            anyhow::bail!("Unknown server.config setting `{key}` on line {line_number}.");
        }

        values.insert(key, unquote_config_value(value.trim()));
    }

    Ok(values)
}

fn unquote_config_value(value: &str) -> String {
    if value.len() >= 2 {
        let first = value.as_bytes()[0];
        let last = value.as_bytes()[value.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

fn config_string_value(values: &HashMap<String, String>, key: &str) -> Option<String> {
    values
        .get(key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_string_value(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn config_u16_value(values: &HashMap<String, String>, key: &str) -> anyhow::Result<Option<u16>> {
    let Some(value) = config_string_value(values, key) else {
        return Ok(None);
    };
    Ok(Some(value.parse::<u16>().map_err(|error| {
        anyhow::anyhow!("Invalid server.config `{key}` value `{value}`: {error}")
    })?))
}

fn config_u64_value(values: &HashMap<String, String>, key: &str) -> anyhow::Result<Option<u64>> {
    let Some(value) = config_string_value(values, key) else {
        return Ok(None);
    };
    value
        .parse::<u64>()
        .map(Some)
        .map_err(|error| anyhow::anyhow!("Invalid server.config `{key}` value `{value}`: {error}"))
}

fn config_gib_limit(
    values: &HashMap<String, String>,
    key: &str,
    default_gib: u64,
) -> anyhow::Result<Option<u64>> {
    let gib = config_u64_value(values, key)?.unwrap_or(default_gib);
    if gib == 0 {
        return Ok(None);
    }
    gib.checked_mul(GIBIBYTE_BYTES).map(Some).ok_or_else(|| {
        anyhow::anyhow!("Invalid server.config `{key}` value `{gib}`: size overflows bytes")
    })
}

fn config_bounded_usize(
    values: &HashMap<String, String>,
    key: &str,
    default: usize,
    minimum: usize,
    maximum: usize,
) -> anyhow::Result<usize> {
    let value = config_u64_value(values, key)?
        .map(usize::try_from)
        .transpose()
        .map_err(|error| anyhow::anyhow!("Invalid server.config `{key}` value: {error}"))?
        .unwrap_or(default);
    if !(minimum..=maximum).contains(&value) {
        anyhow::bail!(
            "Invalid server.config `{key}` value `{value}`: expected {minimum} through {maximum}"
        );
    }
    Ok(value)
}

fn download_volume_has_capacity(available: u64, source: u64, reserve: u64) -> bool {
    source
        .checked_add(reserve)
        .is_some_and(|required| available >= required)
}

fn env_u16_value(key: &str) -> Option<u16> {
    env::var(key)
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
}

fn config_path_value(
    values: &HashMap<String, String>,
    config_dir: &FsPath,
    key: &str,
) -> Option<PathBuf> {
    values
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| resolve_config_path(config_dir, value))
}

fn env_path_value(key: &str) -> Option<PathBuf> {
    env::var_os(key)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn parse_origin_list(value: String) -> Vec<String> {
    value
        .split(',')
        .map(|origin| origin.trim().trim_end_matches('/'))
        .filter(|origin| !origin.is_empty())
        .map(str::to_string)
        .collect()
}

fn resolve_config_path(config_dir: &FsPath, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        config_dir.join(path)
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "operalibre_server=info,tower_http=info".into()),
        )
        .init();

    let config = ServerConfig::load()?;
    tracing::info!(
        deployment_mode = config.deployment_mode.as_str(),
        max_upload_gib = config.max_upload_bytes.map(|bytes| bytes / GIBIBYTE_BYTES).unwrap_or(0),
        max_book_download_gib = config.max_book_download_bytes.map(|bytes| bytes / GIBIBYTE_BYTES).unwrap_or(0),
        max_concurrent_book_downloads = config.max_concurrent_book_downloads,
        download_temp_dir = %config.download_temp_dir.display(),
        min_download_free_gib = config.min_download_free_bytes / GIBIBYTE_BYTES,
        library_root = %config.library_root.display(),
        data_dir = %config.data_dir.display(),
        "server configuration loaded"
    );
    if config.max_upload_bytes.is_none() || config.max_book_download_bytes.is_none() {
        tracing::warn!(
            "one or more transfer size limits are disabled; ensure storage exhaustion is controlled externally"
        );
    }

    // Auto-update eligibility checks compare this marker against the running
    // process, so record it even when the release launcher did not start us
    // (server-only packages start via start.sh / start.cmd).
    record_server_pid(&config.data_dir)?;
    create_private_directory(&config.download_temp_dir)?;
    secure_existing_state_files(&config).await?;

    let users_store = load_users_store(&config.users_file).await?;
    let setup_token =
        if users_store.users.is_empty() && config.deployment_mode.allows_remote_setup() {
            let token = generate_session_token();
            tracing::warn!(
                bootstrap_token = %token,
                valid_for_minutes = SETUP_TOKEN_LIFETIME_SECONDS / 60,
                "first-run remote setup is enabled; enter this one-time token in the setup form"
            );
            Some(SetupToken::new(&token, unix_now_seconds()))
        } else {
            None
        };
    let sessions_store = load_sessions_store(&config.sessions_file).await?;
    let activity_store = load_activity_store(&config.activity_file).await?;
    let finish_event_store = load_finish_events(&config.finish_events_file).await?;
    let metadata_overrides = load_metadata_overrides(&config.metadata_overrides_file).await?;
    let libation_requests = load_libation_requests(&config.libation_requests_file).await?;
    let libation_refreshes =
        load_libation_refreshes(&config.data_dir.join("libation-refreshes.json")).await?;
    let libation_accounts_file = config.data_dir.join("libation-accounts.json");
    let libation_accounts = load_managed_libation_accounts(&libation_accounts_file).await?;
    let libation_accounts_root = config.data_dir.join("libation-accounts");
    create_private_directory(&libation_accounts_root)?;
    if fs::try_exists(&libation_accounts_file).await? {
        secure_file_permissions(&libation_accounts_file).await?;
    }
    for account in &libation_accounts.accounts {
        initialize_managed_libation_profile(
            &libation_accounts_root.join(&account.id),
            &config.library_root,
        )
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;
    }
    if users_store.users.is_empty() {
        match fs::remove_file(&config.progress_file).await {
            Ok(_) => tracing::info!(
                "no users configured yet; cleared legacy progress at {}",
                config.progress_file.display()
            ),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => tracing::warn!(
                "failed to clear legacy progress file {}: {error}",
                config.progress_file.display()
            ),
        }
        let _ = fs::remove_file(&config.activity_file).await;
        let _ = fs::remove_file(&config.finish_events_file).await;
    }

    let state = AppState {
        deployment_mode: config.deployment_mode,
        csrf_allowed_origins: Arc::new(build_csrf_allowed_origins(&config.allowed_origins)),
        setup_token: Arc::new(Mutex::new(setup_token)),
        max_upload_bytes: config.max_upload_bytes,
        max_book_download_bytes: config.max_book_download_bytes,
        download_temp_dir: config.download_temp_dir.clone(),
        min_download_free_bytes: config.min_download_free_bytes,
        library_root: config.library_root.clone(),
        library_identities_file: config.data_dir.join("library-identities.json"),
        progress_file: config.progress_file.clone(),
        book_settings_file: config.data_dir.join("book-settings.json"),
        users_file: config.users_file.clone(),
        sessions_file: config.sessions_file.clone(),
        activity_file: config.activity_file.clone(),
        finish_events_file: config.finish_events_file.clone(),
        metadata_overrides_file: config.metadata_overrides_file.clone(),
        libation_requests_file: config.libation_requests_file.clone(),
        libation_refreshes_file: config.data_dir.join("libation-refreshes.json"),
        libation_accounts_file,
        libation_accounts_root,
        libation_config: LibationConfig::from_server_config(&config),
        alignment_config: AlignmentConfig::from_server_config(&config),
        faststart_tools: faststart::discover_tools(
            config.ffmpeg_path.clone(),
            config.ffprobe_path.clone(),
        ),
        update_manager: updates::UpdateManager::new(
            config.data_dir.clone(),
            config.web_dist_dir.clone(),
            config.port,
        )?,
        sync_dir: config.data_dir.join("sync"),
        library: Arc::new(RwLock::new(LibraryState::default())),
        metadata_overrides: Arc::new(RwLock::new(metadata_overrides)),
        jobs: Arc::new(RwLock::new(HashMap::new())),
        users: Arc::new(RwLock::new(users_store)),
        sessions: Arc::new(RwLock::new(sessions_store)),
        activity: Arc::new(RwLock::new(activity_store)),
        finish_events: Arc::new(RwLock::new(finish_event_store)),
        libation_requests: Arc::new(RwLock::new(libation_requests)),
        libation_refreshes: Arc::new(Mutex::new(libation_refreshes)),
        libation_accounts: Arc::new(RwLock::new(libation_accounts)),
        libation_login_sessions: Arc::new(Mutex::new(HashMap::new())),
        progress_write_lock: Arc::new(Mutex::new(())),
        book_settings_write_lock: Arc::new(Mutex::new(())),
        rescan_lock: Arc::new(Mutex::new(())),
        libation_job_lock: Arc::new(Mutex::new(())),
        faststart_lock: Arc::new(Mutex::new(())),
        login_attempts: Arc::new(Mutex::new(HashMap::new())),
        password_task_slots: Arc::new(Semaphore::new(PASSWORD_TASK_CONCURRENCY)),
        download_task_slots: Arc::new(Semaphore::new(config.max_concurrent_book_downloads)),
        upload_lock: Arc::new(Mutex::new(())),
    };

    rescan_library(&state).await?;
    schedule_automatic_libation_refresh(state.clone());

    let public_routes = Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/status", get(auth_status))
        .route("/api/auth/setup", post(setup_admin))
        .route("/api/auth/login", post(login))
        // Catch-all so unknown API paths return a JSON 404 instead of
        // falling through to the SPA fallback (or the auth middleware).
        .route("/api/{*path}", any(api_not_found));

    let protected_routes = Router::new()
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/me", get(me))
        .route("/api/profile/stats", get(profile_stats))
        .route("/api/update", get(update_status))
        .route("/api/update/install", post(install_update))
        .route("/api/frontend-update", get(frontend_update_status))
        .route(
            "/api/frontend-update/install",
            post(install_frontend_update),
        )
        .route("/api/users", get(list_users).post(create_user))
        .route("/api/users/{user_id}", delete(delete_user))
        .route("/api/users/{user_id}/password", post(change_password))
        .route("/api/users/{user_id}/book-access", put(update_book_access))
        .route("/api/users/{user_id}/role", put(update_user_role))
        .route(
            "/api/users/{user_id}/libation-access",
            put(update_libation_access),
        )
        .route(
            "/api/users/{user_id}/libation-approval",
            put(update_libation_approval),
        )
        .route("/api/me/progress-sharing", put(update_progress_sharing))
        .route("/api/activity/finishes", get(finish_feed))
        .route("/api/activity/finishes/seen", post(mark_finish_feed_seen))
        .route("/api/books", get(list_books))
        .route("/api/library/rescan", post(rescan))
        .route(
            "/api/library/upload",
            post(upload_audiobook).layer(DefaultBodyLimit::disable()),
        )
        .route(
            "/api/library/faststart",
            get(faststart_status).post(start_faststart_conversion),
        )
        .route("/api/libation/status", get(libation_status))
        .route(
            "/api/libation/accounts/login/start",
            post(start_libation_account_login),
        )
        .route(
            "/api/libation/accounts/login/{session_id}/complete",
            post(complete_libation_account_login),
        )
        .route(
            "/api/libation/accounts/login/{session_id}",
            delete(cancel_libation_account_login),
        )
        .route(
            "/api/libation/accounts/{profile_id}",
            put(update_libation_account).delete(delete_libation_account),
        )
        .route("/api/libation/access", get(get_libation_access))
        .route("/api/libation/requests", get(list_libation_requests))
        .route(
            "/api/libation/requests/{asin}",
            post(create_libation_download_request),
        )
        .route(
            "/api/libation/requests/{request_id}/decision",
            put(decide_libation_download_request),
        )
        .route("/api/libation/books", get(list_libation_books))
        .route(
            "/api/libation/covers/{picture_id}",
            get(get_libation_cover_art),
        )
        .route("/api/libation/sync", post(sync_libation_library))
        .route(
            "/api/libation/liberate-all",
            post(liberate_all_libation_books),
        )
        .route(
            "/api/libation/books/{asin}/liberate",
            post(liberate_libation_book),
        )
        .route(
            "/api/libation/accounts/{profile_id}/books/{asin}/liberate",
            post(liberate_profile_libation_book),
        )
        .route("/api/jobs", get(list_jobs))
        .route("/api/jobs/{job_id}", get(get_job))
        .route("/api/books/{book_id}", get(get_book))
        .route("/api/books/{book_id}/metadata", put(update_book_metadata))
        .route("/api/books/{book_id}/cover", get(get_cover_art))
        .route("/api/books/{book_id}/readalong", get(get_reading_file))
        .route("/api/books/{book_id}/sync", get(get_sync_map))
        .route(
            "/api/books/{book_id}/sync/generate",
            post(generate_sync_map),
        )
        .route("/api/alignment/status", get(alignment_status))
        .route(
            "/api/books/{book_id}/progress",
            get(get_progress).put(update_progress),
        )
        .route(
            "/api/books/{book_id}/completion",
            put(update_book_completion),
        )
        .route("/api/books/{book_id}/volume", put(update_book_volume))
        .route(
            "/api/books/{book_id}/tracks/{track_id}/stream",
            get(stream_track),
        )
        .route(
            "/api/books/{book_id}/download",
            get(download_book).delete(delete_downloaded_book),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ));

    let origins = OFFICIAL_APP_ORIGINS
        .iter()
        .copied()
        .chain(config.allowed_origins.iter().map(String::as_str))
        .map(|origin| {
            origin.parse::<HeaderValue>().map_err(|error| {
                anyhow::anyhow!("Invalid allowed_origins entry `{origin}`: {error}")
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    tracing::info!(
        configured_origins = ?config.allowed_origins,
        "CORS restricted to official app and configured origins"
    );
    let cors = CorsLayer::new().allow_origin(AllowOrigin::list(origins));

    let mut app = public_routes.merge(protected_routes);
    if let Some(dist_dir) = config.web_dist_dir.as_ref() {
        if dist_dir.join("index.html").is_file() {
            tracing::info!("serving web app from {}", dist_dir.display());
            app = app.fallback_service(
                ServeDir::new(dist_dir).fallback(ServeFile::new(dist_dir.join("index.html"))),
            );
        } else {
            tracing::warn!(
                "web_dist_dir {} has no index.html; static file serving disabled",
                dist_dir.display()
            );
        }
    }
    let app = app
        .layer(
            cors.allow_methods(AllowMethods::mirror_request())
                .allow_headers(AllowHeaders::mirror_request())
                .allow_credentials(true),
        )
        .layer(
            TraceLayer::new_for_http().make_span_with(|request: &axum::http::Request<Body>| {
                // Never record the query string: media credentials are
                // deliberately carried in URLs for native media elements.
                tracing::info_span!(
                    "http_request",
                    method = %request.method(),
                    path = %request.uri().path(),
                )
            }),
        )
        .layer(middleware::from_fn(security_headers))
        .with_state(state);

    let address: SocketAddr = format!("{}:{}", config.host, config.port).parse()?;
    if config.deployment_mode == DeploymentMode::Lan {
        tracing::warn!(
            %address,
            "LAN mode permits plain HTTP and non-Secure browser cookies; use only on a trusted LAN/VPN and never expose this port directly to the Internet"
        );
    } else if config.deployment_mode == DeploymentMode::Proxy {
        tracing::info!(%address, "proxy mode expects a same-machine TLS reverse proxy");
    }
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!("server listening on http://{address}");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}

fn record_server_pid(data_dir: &std::path::Path) -> std::io::Result<()> {
    create_private_directory(data_dir)?;
    let pid_path = data_dir.join("operalibre-server.pid");
    std::fs::write(&pid_path, std::process::id().to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(pid_path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn create_private_directory(path: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

async fn secure_existing_state_files(config: &ServerConfig) -> io::Result<()> {
    for path in [
        &config.progress_file,
        &config.users_file,
        &config.sessions_file,
        &config.activity_file,
        &config.finish_events_file,
        &config.metadata_overrides_file,
        &config.libation_requests_file,
    ] {
        if fs::try_exists(path).await? {
            secure_file_permissions(path).await?;
        }
    }
    for path in [
        config.data_dir.join("library-identities.json"),
        config.data_dir.join("libation-refreshes.json"),
        config.data_dir.join("book-settings.json"),
    ] {
        if fs::try_exists(&path).await? {
            secure_file_permissions(&path).await?;
        }
    }
    Ok(())
}

async fn api_not_found() -> ApiError {
    ApiError::not_found("Unknown API route")
}

async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    for (name, value) in [
        (
            "strict-transport-security",
            "max-age=63072000; includeSubDomains",
        ),
        ("x-content-type-options", "nosniff"),
        ("x-frame-options", "SAMEORIGIN"),
        ("referrer-policy", "no-referrer"),
        (
            "permissions-policy",
            "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        ),
    ] {
        if !headers.contains_key(name) {
            headers.insert(name, HeaderValue::from_static(value));
        }
    }
    if !headers.contains_key("content-security-policy") {
        headers.insert(
            "content-security-policy",
            HeaderValue::from_static(
                "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; media-src 'self' data: blob: http: https:; connect-src 'self' http: https:; frame-src 'self' data: blob:; worker-src 'self' blob:; form-action 'self'",
            ),
        );
    }
    response
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

#[derive(Deserialize)]
struct UpdateStatusQuery {
    #[serde(default)]
    refresh: bool,
    #[serde(default, rename = "currentVersion")]
    current_version: Option<String>,
}

async fn update_status(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Query(query): Query<UpdateStatusQuery>,
) -> Result<Json<updates::UpdateStatus>, ApiError> {
    require_admin(&auth)?;
    state
        .update_manager
        .check(query.refresh)
        .await
        .map(Json)
        .map_err(|error| ApiError::bad_gateway(format!("Could not check for updates: {error}")))
}

async fn install_update(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<updates::UpdateInstallStarted>, ApiError> {
    require_owner(&auth)?;
    state
        .update_manager
        .install()
        .await
        .map(Json)
        .map_err(|error| ApiError::bad_request(format!("Could not install the update: {error}")))
}

async fn frontend_update_status(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Query(query): Query<UpdateStatusQuery>,
) -> Result<Json<updates::FrontendUpdateStatus>, ApiError> {
    require_admin(&auth)?;
    state
        .update_manager
        .check_frontend(query.refresh, query.current_version.as_deref())
        .await
        .map(Json)
        .map_err(|error| {
            ApiError::bad_gateway(format!("Could not check for frontend updates: {error}"))
        })
}

async fn install_frontend_update(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<updates::UpdateInstallStarted>, ApiError> {
    require_owner(&auth)?;
    state
        .update_manager
        .install_frontend()
        .await
        .map(Json)
        .map_err(|error| {
            ApiError::bad_request(format!("Could not install the frontend update: {error}"))
        })
}

async fn list_books(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<Vec<Book>>, ApiError> {
    Ok(Json(books_with_progress(&state, &auth).await?))
}

async fn rescan(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<Vec<Book>>, ApiError> {
    require_admin(&auth)?;
    rescan_library(&state).await?;
    Ok(Json(books_with_progress(&state, &auth).await?))
}

// ---------------------------------------------------------------------------
// Faststart conversion
// ---------------------------------------------------------------------------

const FASTSTART_JOB_KIND: &str = "library-faststart";

/// A saved position that moved this recently means somebody is very likely
/// mid-chapter. Their player is fetching byte ranges that would land somewhere
/// else in a rewritten container, so that book waits for the next run.
const FASTSTART_ACTIVE_LISTENER_SECONDS: u64 = 15 * 60;

fn human_bytes(bytes: u64) -> String {
    const MIB: u64 = 1024 * 1024;
    if bytes >= 1024 * MIB {
        format!("{:.1} GiB", bytes as f64 / (1024.0 * MIB as f64))
    } else if bytes >= MIB {
        format!("{:.1} MiB", bytes as f64 / MIB as f64)
    } else {
        format!("{} KiB", bytes.div_ceil(1024))
    }
}

#[derive(Debug, Clone)]
struct FaststartCandidate {
    book_id: String,
    path: PathBuf,
    bytes: u64,
}

#[derive(Debug, Default)]
struct FaststartSurvey {
    mp4_files: usize,
    optimized_files: usize,
    unreadable_files: usize,
    pending: Vec<FaststartCandidate>,
    /// Book id to display title, for every book that has pending files.
    titles: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FaststartBookSummary {
    book_id: String,
    title: String,
    pending_files: usize,
    pending_bytes: u64,
    /// Somebody's position moved recently, so this book is skipped unless the
    /// administrator asks for it anyway.
    in_use: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FaststartStatusResponse {
    enabled: bool,
    ffmpeg_path: Option<String>,
    ffprobe_path: Option<String>,
    /// Without ffprobe a conversion can only be checked by container layout
    /// and size, never by duration, streams, or chapters.
    verification_limited: bool,
    mp4_files: usize,
    optimized_files: usize,
    pending_files: usize,
    unreadable_files: usize,
    pending_bytes: u64,
    books: Vec<FaststartBookSummary>,
    active_job_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FaststartRequest {
    /// Convert one book instead of the whole library.
    #[serde(default)]
    book_id: Option<String>,
    /// Convert books that look like somebody is listening to them right now.
    #[serde(default)]
    include_active: bool,
}

async fn faststart_status(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<FaststartStatusResponse>, ApiError> {
    require_admin(&auth)?;
    let survey = survey_faststart(&state, None).await?;
    let active_books = recently_active_book_ids(&state).await?;

    let mut books: HashMap<String, FaststartBookSummary> = HashMap::new();
    for candidate in &survey.pending {
        let entry =
            books
                .entry(candidate.book_id.clone())
                .or_insert_with(|| FaststartBookSummary {
                    book_id: candidate.book_id.clone(),
                    title: survey
                        .titles
                        .get(&candidate.book_id)
                        .cloned()
                        .unwrap_or_else(|| candidate.book_id.clone()),
                    pending_files: 0,
                    pending_bytes: 0,
                    in_use: active_books.contains(&candidate.book_id),
                });
        entry.pending_files += 1;
        entry.pending_bytes += candidate.bytes;
    }
    let mut books = books.into_values().collect::<Vec<_>>();
    books.sort_by(|a, b| a.title.cmp(&b.title));

    let active_job_id = state
        .jobs
        .read()
        .await
        .values()
        .filter(|job| job.kind == FASTSTART_JOB_KIND && is_active_job(job))
        .max_by_key(|job| job_started_timestamp(job))
        .map(|job| job.id.clone());

    Ok(Json(FaststartStatusResponse {
        enabled: state.faststart_tools.is_some(),
        ffmpeg_path: state
            .faststart_tools
            .as_ref()
            .map(|tools| tools.ffmpeg.to_string_lossy().to_string()),
        ffprobe_path: state
            .faststart_tools
            .as_ref()
            .and_then(|tools| tools.ffprobe.as_ref())
            .map(|path| path.to_string_lossy().to_string()),
        verification_limited: state
            .faststart_tools
            .as_ref()
            .is_some_and(|tools| tools.ffprobe.is_none()),
        mp4_files: survey.mp4_files,
        optimized_files: survey.optimized_files,
        unreadable_files: survey.unreadable_files,
        pending_files: survey.pending.len(),
        pending_bytes: survey.pending.iter().map(|entry| entry.bytes).sum(),
        books,
        active_job_id,
    }))
}

async fn start_faststart_conversion(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Json(payload): Json<FaststartRequest>,
) -> Result<Json<JobCreated>, ApiError> {
    require_admin(&auth)?;
    if state.faststart_tools.is_none() {
        return Err(ApiError::bad_request(
            "ffmpeg was not found. Set ffmpeg_path in server.config or put ffmpeg on PATH.",
        ));
    }
    if let Some(book_id) = payload.book_id.as_deref() {
        let library = state.library.read().await;
        if !library.books.iter().any(|book| book.id == book_id) {
            return Err(ApiError::not_found("Book not found"));
        }
    }

    let (job_id, created) = create_job_with_state(
        &state,
        FASTSTART_JOB_KIND,
        payload.book_id.clone(),
        "queued",
        true,
    )
    .await;
    if created {
        spawn_faststart_job(state, job_id.clone(), payload);
    }
    Ok(Json(JobCreated { job_id }))
}

/// Reads the head of every MP4-family file in the library (or one book) to see
/// which ones still carry a trailing `moov`.
async fn survey_faststart(
    state: &AppState,
    book_id: Option<&str>,
) -> Result<FaststartSurvey, ApiError> {
    let (files, titles) = {
        let library = state.library.read().await;
        let mut files = Vec::new();
        let mut titles = HashMap::new();
        for book in &library.books {
            if book_id.is_some_and(|wanted| wanted != book.id) {
                continue;
            }
            titles.insert(book.id.clone(), book.title.clone());
            for track in &book.tracks {
                if let Some(path) = library.track_paths.get(&track.id)
                    && faststart::is_mp4_file(path)
                {
                    files.push((book.id.clone(), path.clone()));
                }
            }
        }
        (files, titles)
    };

    tokio::task::spawn_blocking(move || {
        let mut survey = FaststartSurvey {
            titles,
            ..FaststartSurvey::default()
        };
        for (book_id, path) in files {
            survey.mp4_files += 1;
            let bytes = std::fs::metadata(&path).map(|entry| entry.len()).ok();
            match (faststart::inspect(&path), bytes) {
                (Ok(faststart::Layout::Trailing), Some(bytes)) => {
                    survey.pending.push(FaststartCandidate {
                        book_id,
                        path,
                        bytes,
                    });
                }
                (Ok(faststart::Layout::Faststart), _) => survey.optimized_files += 1,
                _ => survey.unreadable_files += 1,
            }
        }
        survey.pending.sort_by(|a, b| a.path.cmp(&b.path));
        survey
    })
    .await
    .map_err(|error| ApiError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        message: error.to_string(),
    })
}

/// Books whose saved position moved inside the active-listener window.
async fn recently_active_book_ids(state: &AppState) -> Result<HashSet<String>, ApiError> {
    let progress = read_progress(&state.progress_file).await?;
    let now_ms = unix_now_millis();
    let window_ms = FASTSTART_ACTIVE_LISTENER_SECONDS.saturating_mul(1_000);
    Ok(progress
        .values()
        .filter(|entry| {
            now_ms.saturating_sub(progress_timestamp_millis(&entry.updated_at)) <= window_ms
        })
        .map(|entry| entry.book_id.clone())
        .collect())
}

fn spawn_faststart_job(state: AppState, job_id: String, request: FaststartRequest) {
    tokio::spawn(async move {
        // One conversion at a time: these rewrite files under the library
        // root, and a queued second job should wait rather than interleave.
        let _guard = state.faststart_lock.lock().await;
        update_job_running(&state, &job_id).await;
        match run_faststart_job(&state, &job_id, &request).await {
            Ok(report) => {
                let status = if report.failed > 0 {
                    "failed"
                } else {
                    "completed"
                };
                let error = (report.failed > 0).then(|| {
                    format!(
                        "{} file{} could not be converted and were left untouched.",
                        report.failed,
                        if report.failed == 1 { "" } else { "s" }
                    )
                });
                update_job_finished(&state, &job_id, status, Some(0), error).await;
            }
            Err(error) => {
                update_job_output(&state, &job_id, &format!("{error}\n")).await;
                update_job_finished(&state, &job_id, "failed", None, Some(error.to_string())).await;
            }
        }
    });
}

#[derive(Debug, Default)]
struct FaststartReport {
    converted: usize,
    skipped: usize,
    failed: usize,
}

async fn run_faststart_job(
    state: &AppState,
    job_id: &str,
    request: &FaststartRequest,
) -> anyhow::Result<FaststartReport> {
    let tools = state
        .faststart_tools
        .clone()
        .ok_or_else(|| anyhow::anyhow!("ffmpeg was not found."))?;
    if tools.ffprobe.is_none() {
        update_job_output(
            state,
            job_id,
            "ffprobe was not found: conversions are verified by container layout and size only.\n",
        )
        .await;
    }

    let survey = survey_faststart(state, request.book_id.as_deref())
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;
    let mut report = FaststartReport::default();
    if survey.pending.is_empty() {
        update_job_output(state, job_id, "Every MP4 file already starts fast.\n").await;
        return Ok(report);
    }

    let active_books = if request.include_active {
        HashSet::new()
    } else {
        recently_active_book_ids(state)
            .await
            .map_err(|error| anyhow::anyhow!(error.message))?
    };

    // Clear anything a crashed earlier run left beside the books it touched.
    let directories = survey
        .pending
        .iter()
        .filter_map(|candidate| candidate.path.parent().map(FsPath::to_path_buf))
        .collect::<HashSet<_>>();
    let swept = tokio::task::spawn_blocking(move || {
        directories
            .iter()
            .map(|directory| faststart::sweep_work_files(directory))
            .sum::<usize>()
    })
    .await
    .unwrap_or(0);
    if swept > 0 {
        update_job_output(
            state,
            job_id,
            &format!("Removed {swept} leftover work file(s) from an interrupted run.\n"),
        )
        .await;
    }

    let total = survey.pending.len();
    update_job_output(
        state,
        job_id,
        &format!(
            "Converting {total} file(s) to faststart ({}).\n",
            human_bytes(survey.pending.iter().map(|entry| entry.bytes).sum())
        ),
    )
    .await;

    let reserve_bytes = state
        .min_download_free_bytes
        .max(faststart::MIN_FREE_HEADROOM_BYTES);

    for (index, candidate) in survey.pending.iter().enumerate() {
        let label = library_identity_path(&state.library_root, &candidate.path);
        let position = index + 1;

        if active_books.contains(&candidate.book_id) {
            report.skipped += 1;
            update_job_output(
                state,
                job_id,
                &format!("[{position}/{total}] skipped {label}: somebody is listening to it.\n"),
            )
            .await;
            continue;
        }

        let path = candidate.path.clone();
        let tools = tools.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            // The survey may be minutes old by now; only convert what is
            // still both present and trailing.
            match faststart::inspect(&path) {
                Ok(faststart::Layout::Trailing) => {}
                Ok(_) => return Ok(None),
                Err(error) => return Err(faststart::ConversionError::Io(error)),
            }
            faststart::convert_in_place(&tools, &path, reserve_bytes).map(Some)
        })
        .await;

        let line = match outcome {
            Ok(Ok(Some(converted))) => {
                report.converted += 1;
                let unverified = if converted.duration_verified {
                    ""
                } else {
                    " (layout and size verified only)"
                };
                format!(
                    "[{position}/{total}] converted {label}: {} -> {}{unverified}\n",
                    human_bytes(converted.before_bytes),
                    human_bytes(converted.after_bytes)
                )
            }
            Ok(Ok(None)) => {
                report.skipped += 1;
                format!("[{position}/{total}] skipped {label}: no longer needs converting.\n")
            }
            Ok(Err(error)) => {
                report.failed += 1;
                tracing::warn!("faststart conversion failed for {label}: {error}");
                format!("[{position}/{total}] failed {label}: {error}\n")
            }
            Err(error) => {
                report.failed += 1;
                format!("[{position}/{total}] failed {label}: {error}\n")
            }
        };
        update_job_output(state, job_id, &line).await;
    }

    if report.converted > 0 {
        // Durations, tags, and fingerprints all come from the files that just
        // changed. Book and track ids are keyed on library paths, which the
        // in-place swap preserved, so saved progress survives the rescan.
        if let Err(error) = rescan_library(state).await {
            update_job_output(
                state,
                job_id,
                &format!("The library rescan after conversion failed: {error}\n"),
            )
            .await;
        }
    }

    update_job_output(
        state,
        job_id,
        &format!(
            "Done: {} converted, {} skipped, {} failed.\n",
            report.converted, report.skipped, report.failed
        ),
    )
    .await;
    Ok(report)
}

async fn upload_audiobook(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    mut multipart: Multipart,
) -> Result<Json<Vec<Book>>, ApiError> {
    require_admin(&auth)?;
    let _upload_guard = state.upload_lock.lock().await;
    fs::create_dir_all(&state.library_root).await?;

    let staging_name = format!("{UPLOAD_STAGING_PREFIX}{}", generate_session_token());
    let staging_path = state.library_root.join(staging_name);
    fs::create_dir(&staging_path).await?;

    let result =
        receive_audiobook_upload(&staging_path, &mut multipart, state.max_upload_bytes).await;
    let book_name = match result {
        Ok(book_name) => book_name,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging_path).await;
            return Err(error);
        }
    };

    let destination = state.library_root.join(&book_name);
    match fs::try_exists(&destination).await {
        Ok(false) => {}
        Ok(true) => {
            let _ = fs::remove_dir_all(&staging_path).await;
            return Err(ApiError::conflict(format!(
                "A library folder named '{book_name}' already exists. Choose another book name."
            )));
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&staging_path).await;
            return Err(error.into());
        }
    }

    if let Err(error) = fs::rename(&staging_path, &destination).await {
        let _ = fs::remove_dir_all(&staging_path).await;
        return Err(error.into());
    }

    rescan_library(&state).await?;
    Ok(Json(books_with_progress(&state, &auth).await?))
}

async fn receive_audiobook_upload(
    staging_path: &FsPath,
    multipart: &mut Multipart,
    max_upload_bytes: Option<u64>,
) -> Result<String, ApiError> {
    let mut book_name = None;
    let mut audio_file_count = 0usize;
    let mut total_bytes = 0u64;
    let mut uploaded_names = HashSet::new();

    while let Some(mut field) = multipart.next_field().await.map_err(multipart_error)? {
        match field.name() {
            Some("bookName") => {
                let mut bytes = Vec::new();
                while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
                    if bytes.len().saturating_add(chunk.len()) > 1_024 {
                        return Err(ApiError::bad_request("Book name is too long."));
                    }
                    bytes.extend_from_slice(&chunk);
                }
                let value = String::from_utf8(bytes)
                    .map_err(|_| ApiError::bad_request("Book name must be valid UTF-8."))?;
                let trimmed = value.trim();
                if trimmed.is_empty() || trimmed.chars().count() > 200 {
                    return Err(ApiError::bad_request(
                        "Book name must be between 1 and 200 characters.",
                    ));
                }
                let safe_name = sanitize_filename(trimmed);
                if safe_name.len() > 240 {
                    return Err(ApiError::bad_request("Book name is too long."));
                }
                book_name = Some(safe_name);
            }
            Some("files") => {
                if audio_file_count >= MAX_UPLOAD_FILES {
                    return Err(ApiError::bad_request(format!(
                        "An audiobook can contain at most {MAX_UPLOAD_FILES} files."
                    )));
                }
                let original_name = field
                    .file_name()
                    .ok_or_else(|| ApiError::bad_request("Every upload must have a file name."))?;
                let file_name = sanitize_filename(original_name);
                if file_name.len() > 255 {
                    return Err(ApiError::bad_request(format!(
                        "The file name '{file_name}' is too long."
                    )));
                }
                if !is_supported_audio_file(FsPath::new(&file_name)) {
                    return Err(ApiError::bad_request(format!(
                        "'{file_name}' is not a supported audiobook file."
                    )));
                }
                if !uploaded_names.insert(file_name.to_lowercase()) {
                    return Err(ApiError::bad_request(format!(
                        "The upload contains more than one file named '{file_name}'."
                    )));
                }

                let output_path = staging_path.join(&file_name);
                let mut output = fs::File::create(&output_path).await?;
                let mut file_bytes = 0u64;
                while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
                    total_bytes = total_bytes.saturating_add(chunk.len() as u64);
                    file_bytes = file_bytes.saturating_add(chunk.len() as u64);
                    if let Some(limit) = max_upload_bytes
                        && total_bytes > limit
                    {
                        return Err(ApiError::payload_too_large(format!(
                            "Audiobook uploads are limited to {} GiB.",
                            limit / GIBIBYTE_BYTES
                        )));
                    }
                    output.write_all(&chunk).await?;
                }
                if file_bytes == 0 {
                    return Err(ApiError::bad_request(format!(
                        "'{file_name}' is empty and cannot be added to the library."
                    )));
                }
                output.flush().await?;
                audio_file_count += 1;
            }
            _ => {}
        }
    }

    if audio_file_count == 0 {
        return Err(ApiError::bad_request(
            "Choose at least one supported audiobook file to upload.",
        ));
    }

    book_name.ok_or_else(|| ApiError::bad_request("Book name is required."))
}

fn multipart_error(error: axum::extract::multipart::MultipartError) -> ApiError {
    ApiError::bad_request(format!("The audiobook upload could not be read: {error}"))
}

async fn start_libation_account_login(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Json(payload): Json<StartLibationLoginRequest>,
) -> Result<Json<LibationLoginStarted>, ApiError> {
    require_admin(&auth)?;
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
    let profile_id = {
        let mut store = state.libation_accounts.write().await;
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
            let id = account.id.clone();
            write_managed_libation_accounts(&state.libation_accounts_file, &store).await?;
            id
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
                added_by: auth.username,
                added_at: now_rfc3339ish(),
                connection_state: "signing_in".to_string(),
                authenticated: false,
                last_successful_auth: None,
                last_successful_refresh: None,
                last_error: None,
            });
            write_managed_libation_accounts(&state.libation_accounts_file, &store).await?;
            id
        }
    };

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

async fn complete_libation_account_login(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(session_id): Path<String>,
    Json(payload): Json<CompleteLibationLoginRequest>,
) -> Result<Json<LibationStatus>, ApiError> {
    require_admin(&auth)?;
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

async fn cancel_libation_account_login(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(session_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    require_admin(&auth)?;
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

async fn update_libation_account(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(profile_id): Path<String>,
    Json(payload): Json<UpdateLibationAccountRequest>,
) -> Result<Json<LibationStatus>, ApiError> {
    require_admin(&auth)?;
    let label = payload.label.trim();
    if label.is_empty() || label.chars().count() > MAX_LIBATION_ACCOUNT_LABEL_CHARS {
        return Err(ApiError::bad_request(format!(
            "Account label must be between 1 and {MAX_LIBATION_ACCOUNT_LABEL_CHARS} characters."
        )));
    }
    let mut store = state.libation_accounts.write().await;
    let account = store
        .accounts
        .iter_mut()
        .find(|account| account.id == profile_id)
        .ok_or(ApiError::not_found("Audible account not found."))?;
    account.label = label.to_string();
    write_managed_libation_accounts(&state.libation_accounts_file, &store).await?;
    drop(store);
    Ok(Json(read_libation_status(&state).await))
}

async fn delete_libation_account(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(profile_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    require_owner(&auth)?;
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
    let mut store = state.libation_accounts.write().await;
    let before = store.accounts.len();
    store.accounts.retain(|account| account.id != profile_id);
    if store.accounts.len() == before {
        return Err(ApiError::not_found("Audible account not found."));
    }
    write_managed_libation_accounts(&state.libation_accounts_file, &store).await?;
    drop(store);
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

fn valid_libation_locale(locale: &str) -> bool {
    matches!(
        locale,
        "us" | "uk" | "ca" | "de" | "fr" | "au" | "jp" | "in" | "es"
    )
}

fn validate_libation_response_url(value: &str) -> Result<String, ApiError> {
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

fn is_amazon_or_audible_host(host: &str) -> bool {
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

async fn prune_expired_libation_login_sessions(state: &AppState) {
    let now = unix_now_seconds();
    state
        .libation_login_sessions
        .lock()
        .await
        .retain(|_, session| session.expires_at >= now);
}

async fn mark_managed_libation_account_authenticated(
    state: &AppState,
    profile_id: &str,
) -> Result<(), ApiError> {
    let mut store = state.libation_accounts.write().await;
    if let Some(account) = store
        .accounts
        .iter_mut()
        .find(|account| account.id == profile_id)
    {
        account.authenticated = true;
        account.connection_state = "connected".to_string();
        account.last_successful_auth = Some(now_rfc3339ish());
        account.last_error = None;
        write_managed_libation_accounts(&state.libation_accounts_file, &store).await?;
    }
    Ok(())
}

async fn mark_managed_libation_account_error(state: &AppState, profile_id: &str, message: &str) {
    let mut store = state.libation_accounts.write().await;
    if let Some(account) = store
        .accounts
        .iter_mut()
        .find(|account| account.id == profile_id)
    {
        account.authenticated = false;
        account.connection_state = "needs_sign_in".to_string();
        account.last_error = Some(sanitize_libation_login_output(message));
        if let Err(error) =
            write_managed_libation_accounts(&state.libation_accounts_file, &store).await
        {
            tracing::warn!(
                "failed to persist Libation account health: {}",
                error.message
            );
        }
    }
}

async fn mark_managed_libation_account_scan_error(
    state: &AppState,
    profile_id: &str,
    message: &str,
) {
    let mut store = state.libation_accounts.write().await;
    if let Some(account) = store
        .accounts
        .iter_mut()
        .find(|account| account.id == profile_id)
    {
        account.connection_state = "error".to_string();
        account.last_error = Some(sanitize_libation_login_output(message));
        if let Err(error) =
            write_managed_libation_accounts(&state.libation_accounts_file, &store).await
        {
            tracing::warn!(
                "failed to persist Libation account scan error: {}",
                error.message
            );
        }
    }
}

#[cfg(unix)]
async fn secure_managed_libation_profile(path: &FsPath) -> Result<(), ApiError> {
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
async fn secure_managed_libation_profile(_path: &FsPath) -> Result<(), ApiError> {
    Ok(())
}

async fn initialize_managed_libation_profile(
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

async fn libation_status(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<LibationStatus>, ApiError> {
    require_admin(&auth)?;
    let _libation_guard = state.libation_job_lock.lock().await;
    Ok(Json(read_libation_status(&state).await))
}

async fn get_libation_access(
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

async fn list_libation_requests(
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

async fn create_libation_download_request(
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

    let mut requests = state.libation_requests.write().await;
    if let Some(existing) = requests.requests.iter().find(|request| {
        request.user_id == auth.id
            && request.asin == asin
            && request.profile_id.as_deref().unwrap_or("legacy") == profile.id
            && request.status == "pending"
    }) {
        return Ok(Json(existing.clone()));
    }
    if requests
        .requests
        .iter()
        .filter(|request| request.user_id == auth.id && request.status == "pending")
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
            auth.id,
            profile.id,
            asin,
            now_rfc3339ish()
        )),
        user_id: auth.id,
        username: auth.username,
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
    write_libation_requests(&state.libation_requests_file, &requests).await?;
    Ok(Json(request))
}

async fn decide_libation_download_request(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(request_id): Path<String>,
    Json(payload): Json<DecideLibationDownloadRequest>,
) -> Result<Json<LibationDownloadRequest>, ApiError> {
    require_libation_approver(&auth)?;
    if payload.approved && !state.libation_config.enabled() {
        return Err(ApiError::bad_request(
            "Libation is not configured on this server.",
        ));
    }

    let request = {
        let mut requests = state.libation_requests.write().await;
        let request = requests
            .requests
            .iter_mut()
            .find(|request| request.id == request_id)
            .ok_or(ApiError::not_found("Download request not found."))?;
        if request.user_id == auth.id {
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
        request.decided_by = Some(auth.username);
        let request = request.clone();
        write_libation_requests(&state.libation_requests_file, &requests).await?;
        request
    };

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
            let mut requests = state.libation_requests.write().await;
            if let Some(stored) = requests
                .requests
                .iter_mut()
                .find(|item| item.id == request.id)
            {
                stored.status = "pending".to_string();
                stored.decided_at = None;
                stored.decided_by = None;
            }
            let _ = write_libation_requests(&state.libation_requests_file, &requests).await;
            return Err(error);
        }
    };
    let mut requests = state.libation_requests.write().await;
    let stored = requests
        .requests
        .iter_mut()
        .find(|item| item.id == request.id)
        .ok_or(ApiError::not_found("Download request not found."))?;
    stored.job_id = Some(created.job_id);
    let response = stored.clone();
    write_libation_requests(&state.libation_requests_file, &requests).await?;
    drop(requests);
    schedule_libation_request_completion(
        state.clone(),
        response.id.clone(),
        response.job_id.clone().unwrap_or_default(),
    );
    Ok(Json(response))
}

fn schedule_libation_request_completion(state: AppState, request_id: String, job_id: String) {
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
        let mut requests = state.libation_requests.write().await;
        let Some(request) = requests
            .requests
            .iter_mut()
            .find(|request| request.id == request_id && request.status == "approved")
        else {
            return;
        };
        request.status = final_status.to_string();
        if let Err(error) = write_libation_requests(&state.libation_requests_file, &requests).await
        {
            tracing::warn!(
                "failed to persist Libation request completion: {}",
                error.message
            );
        }
    });
}

async fn list_libation_books(
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

fn valid_libation_picture_id(picture_id: &str) -> bool {
    !picture_id.is_empty()
        && picture_id.len() <= 200
        && picture_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'+'))
}

fn libation_cover_art_url(picture_id: Option<&str>) -> Option<String> {
    let picture_id = picture_id?.trim();
    valid_libation_picture_id(picture_id).then(|| format!("/api/libation/covers/{picture_id}"))
}

fn libation_cover_art_url_from_ids(
    picture_large: Option<&str>,
    picture_id: Option<&str>,
) -> Option<String> {
    libation_cover_art_url(picture_large).or_else(|| libation_cover_art_url(picture_id))
}

async fn get_libation_cover_art(
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

fn match_local_book(local_books: &[Book], libation_book: &LibationBook) -> Option<String> {
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

fn titles_match(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let shorter = if a.len() <= b.len() { a } else { b };
    let longer = if a.len() <= b.len() { b } else { a };
    let prefix = format!("{shorter} ");
    longer.starts_with(&prefix)
}

fn normalize_match_key(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|character| character.is_alphanumeric() || character.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

async fn sync_libation_library(
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

async fn reserve_manual_libation_refresh(
    state: &AppState,
    auth: &AuthUser,
) -> Result<(String, bool), ApiError> {
    if auth.is_admin {
        return Ok(create_libation_job(state, "libation-sync", None).await);
    }

    let mut refreshes = state.libation_refreshes.lock().await;
    if let Some(job_id) = active_libation_sync_job(state).await {
        return Ok((job_id, false));
    }

    let now = unix_now_seconds();
    for timestamps in refreshes.manual_refreshes.values_mut() {
        timestamps.retain(|timestamp| {
            now.saturating_sub(*timestamp) < LIBATION_READER_REFRESH_WINDOW_SECONDS
        });
    }
    refreshes
        .manual_refreshes
        .retain(|_, timestamps| !timestamps.is_empty());

    let refresh_limit = state.libation_config.reader_refreshes_per_hour;
    let refresh_limit_count = usize::try_from(refresh_limit).unwrap_or(usize::MAX);
    let timestamps = refreshes
        .manual_refreshes
        .entry(auth.id.clone())
        .or_default();
    if refresh_limit > 0
        && timestamps.len() >= refresh_limit_count
        && let Some(first_refresh) = timestamps.first()
    {
        let elapsed = now.saturating_sub(*first_refresh);
        let remaining_minutes = (LIBATION_READER_REFRESH_WINDOW_SECONDS - elapsed).div_ceil(60);
        return Err(ApiError::too_many_requests(format!(
            "You have used all {refresh_limit} Audible refreshes for this hour. Try again in {remaining_minutes} minute{}.",
            if remaining_minutes == 1 { "" } else { "s" }
        )));
    }

    let (job_id, created) = create_libation_job(state, "libation-sync", None).await;
    if created && refresh_limit > 0 {
        timestamps.push(now);
        if let Err(error) =
            write_libation_refreshes(&state.libation_refreshes_file, &refreshes).await
        {
            tracing::warn!(
                "failed to persist Libation refresh limit: {}",
                error.message
            );
        }
    }
    Ok((job_id, created))
}

async fn active_libation_sync_job(state: &AppState) -> Option<String> {
    state
        .jobs
        .read()
        .await
        .values()
        .filter(|job| job.kind == "libation-sync" && is_active_job(job))
        .max_by_key(|job| job_started_timestamp(job))
        .map(|job| job.id.clone())
}

fn spawn_libation_sync_job(state: AppState, job_id: String) {
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

async fn mark_managed_libation_account_refreshed(state: &AppState, profile_id: &str) {
    let mut store = state.libation_accounts.write().await;
    if let Some(account) = store
        .accounts
        .iter_mut()
        .find(|account| account.id == profile_id)
    {
        account.authenticated = true;
        account.connection_state = "connected".to_string();
        account.last_successful_refresh = Some(now_rfc3339ish());
        account.last_error = None;
        if let Err(error) =
            write_managed_libation_accounts(&state.libation_accounts_file, &store).await
        {
            tracing::warn!(
                "failed to persist Libation refresh health: {}",
                error.message
            );
        }
    }
}

async fn record_successful_libation_scan(state: &AppState) {
    let mut refreshes = state.libation_refreshes.lock().await;
    refreshes.last_successful_scan = Some(unix_now_seconds());
    if let Err(error) = write_libation_refreshes(&state.libation_refreshes_file, &refreshes).await {
        tracing::warn!(
            "failed to persist successful Libation refresh: {}",
            error.message
        );
    }
}

fn schedule_automatic_libation_refresh(state: AppState) {
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
                let refreshes = state.libation_refreshes.lock().await;
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

async fn liberate_libation_book(
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

async fn liberate_profile_libation_book(
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

async fn start_libation_download(
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

fn schedule_libation_access_grant(state: AppState, job_id: String, asin: String, user_id: String) {
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

async fn grant_user_book_access(
    state: &AppState,
    user_id: &str,
    book_id: &str,
) -> Result<(), ApiError> {
    let mut users = state.users.write().await;
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
    write_users_store(&state.users_file, &users).await
}

async fn liberate_all_libation_books(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<JobCreated>, ApiError> {
    require_admin(&auth)?;
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

async fn list_jobs(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<Vec<JobStatus>>, ApiError> {
    require_admin(&auth)?;
    let jobs = state.jobs.read().await;
    let mut list: Vec<JobStatus> = jobs.values().map(job_for_list).collect();
    list.sort_by_key(|job| std::cmp::Reverse(job_started_timestamp(job)));
    Ok(Json(list))
}

fn job_started_timestamp(job: &JobStatus) -> u64 {
    job.started_at.parse().unwrap_or(0)
}

async fn get_job(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(job_id): Path<String>,
) -> Result<Json<JobStatus>, ApiError> {
    let job = state
        .jobs
        .read()
        .await
        .get(&job_id)
        .cloned()
        .ok_or(ApiError::not_found("Job not found"))?;
    if auth.is_admin {
        return Ok(Json(job));
    }

    // Non-administrators only learn about jobs whose unguessable IDs were
    // returned to them by a request they initiated. Avoid exposing command
    // output, which can contain server paths or Libation account details.
    let mut summary = job;
    summary.output.clear();
    summary.error = summary
        .error
        .as_ref()
        .map(|_| "The background operation failed.".to_string());
    Ok(Json(summary))
}

async fn get_book(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
) -> Result<Json<Book>, ApiError> {
    require_book_access(&auth, &book_id)?;
    let book = {
        let library = state.library.read().await;
        library
            .books
            .iter()
            .find(|candidate| candidate.id == book_id)
            .cloned()
            .ok_or(ApiError::not_found("Book not found"))?
    };
    Ok(Json(book_with_progress(&state, &auth, book).await?))
}

async fn update_book_metadata(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
    Json(payload): Json<BookMetadataUpdate>,
) -> Result<Json<Book>, ApiError> {
    require_admin(&auth)?;

    let metadata_override = metadata_override_from_update(payload)?;
    {
        let library = state.library.read().await;
        if !library
            .books
            .iter()
            .any(|candidate| candidate.id == book_id)
        {
            return Err(ApiError::not_found("Book not found"));
        }
    }

    {
        let mut overrides = state.metadata_overrides.write().await;
        overrides
            .books
            .insert(book_id.clone(), metadata_override.clone());
        write_metadata_overrides(&state.metadata_overrides_file, &overrides).await?;
    }

    let updated_book = {
        let mut library = state.library.write().await;
        let book = library
            .books
            .iter_mut()
            .find(|candidate| candidate.id == book_id)
            .ok_or(ApiError::not_found("Book not found"))?;
        apply_book_metadata_override(book, &metadata_override);
        book.clone()
    };

    Ok(Json(book_with_progress(&state, &auth, updated_book).await?))
}

/// Per-listener playback gain for one book. Unlike the metadata override this
/// is not an admin edit: it only changes how loud the book is for the caller,
/// so any listener with access to the book may set it.
async fn update_book_volume(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
    Json(payload): Json<BookVolumeUpdate>,
) -> Result<Json<Book>, ApiError> {
    require_book_access(&auth, &book_id)?;

    let book = {
        let library = state.library.read().await;
        library
            .books
            .iter()
            .find(|candidate| candidate.id == book_id)
            .cloned()
            .ok_or(ApiError::not_found("Book not found"))?
    };

    let gain = clamp_book_volume_gain(payload.volume_gain);
    {
        let _guard = state.book_settings_write_lock.lock().await;
        let mut settings = read_book_settings(&state.book_settings_file).await?;
        let key = progress_key(&auth.id, &book_id);
        if gain == BOOK_VOLUME_GAIN_DEFAULT {
            // Unity gain is the absence of a setting rather than a stored one,
            // so resetting a book leaves nothing behind in the file.
            settings.remove(&key);
        } else {
            settings.insert(key, BookSettings { volume_gain: gain });
        }
        write_book_settings(&state.book_settings_file, &settings).await?;
    }

    Ok(Json(book_with_progress(&state, &auth, book).await?))
}

const COVER_CACHE_CONTROL: &str = "private, max-age=86400";

async fn get_cover_art(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require_book_access(&auth, &book_id)?;
    let library = state.library.read().await;
    let cover = library
        .cover_art
        .get(&book_id)
        .ok_or(ApiError::not_found("Cover art not found"))?;

    if if_none_match_matches(&headers, &cover.etag) {
        return Ok(Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(ETAG, cover.etag.clone())
            .header(CACHE_CONTROL, COVER_CACHE_CONTROL)
            .body(Body::empty())?);
    }

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, cover.mime_type.clone())
        .header(CONTENT_LENGTH, cover.data.len().to_string())
        .header(ETAG, cover.etag.clone())
        .header(CACHE_CONTROL, COVER_CACHE_CONTROL)
        .body(Body::from(cover.data.clone()))?)
}

fn if_none_match_matches(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get_all(IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(|candidate| candidate.trim())
        .any(|candidate| candidate == "*" || candidate.trim_start_matches("W/") == etag)
}

async fn get_reading_file(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require_book_access(&auth, &book_id)?;
    let file_path = {
        let library = state.library.read().await;
        let book = library
            .books
            .iter()
            .find(|candidate| candidate.id == book_id)
            .ok_or(ApiError::not_found("Book not found"))?;
        let reading_file = book
            .reading_file
            .as_ref()
            .ok_or(ApiError::not_found("Readalong file not found"))?;
        library
            .reading_paths
            .get(&reading_file.id)
            .cloned()
            .ok_or(ApiError::not_found("Readalong path not found"))?
    };

    let isolate_html = file_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")
        });
    let mut response =
        serve_file_response(&file_path, &[&state.library_root], headers, None).await?;
    // Companion files come from the audiobook library, not the application
    // bundle, so no readalong type may be re-interpreted as active content —
    // a .txt sniffed as HTML is exactly what this prevents.
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    if isolate_html {
        // Keep markup inert even when a listener chooses "Open" and views the
        // document outside the sandboxed inline frame.
        response.headers_mut().insert(
            "content-security-policy",
            HeaderValue::from_static(
                "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:",
            ),
        );
    }
    Ok(response)
}

async fn get_sync_map(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require_book_access(&auth, &book_id)?;
    let file_path = {
        let library = state.library.read().await;
        library
            .books
            .iter()
            .find(|candidate| candidate.id == book_id)
            .ok_or(ApiError::not_found("Book not found"))?;
        library
            .sync_paths
            .get(&book_id)
            .cloned()
            .ok_or(ApiError::not_found("Sync map not found"))?
    };

    serve_file_response(
        &file_path,
        &[&state.library_root, &state.sync_dir],
        headers,
        None,
    )
    .await
}

async fn alignment_status(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&auth)?;
    let config = &state.alignment_config;
    Ok(Json(serde_json::json!({
        "enabled": config.enabled(),
        "cliPath": config.cli_path.as_ref().map(|path| path.to_string_lossy().to_string()),
    })))
}

async fn generate_sync_map(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
) -> Result<Json<JobCreated>, ApiError> {
    require_admin(&auth)?;
    let Some(cli_path) = state.alignment_config.cli_path.clone() else {
        return Err(ApiError::bad_request(
            "Alignment CLI was not found. Set alignment_cli_path in server.config or put echogarden on PATH.",
        ));
    };

    let (epub_path, tracks, book_title) = {
        let library = state.library.read().await;
        let book = library
            .books
            .iter()
            .find(|candidate| candidate.id == book_id)
            .ok_or(ApiError::not_found("Book not found"))?;
        let reading_file = book
            .reading_file
            .as_ref()
            .filter(|reading_file| reading_file.extension == "epub")
            .ok_or(ApiError::bad_request(
                "Sync generation needs an EPUB readalong companion for this book.",
            ))?;
        let epub_path = library
            .reading_paths
            .get(&reading_file.id)
            .cloned()
            .ok_or(ApiError::not_found("Readalong path not found"))?;
        let tracks = book
            .tracks
            .iter()
            .map(|track| {
                library
                    .track_paths
                    .get(&track.id)
                    .cloned()
                    .map(|path| SyncTrackInput {
                        path,
                        title: track.title.clone(),
                        duration_seconds: track.duration_seconds,
                    })
                    .ok_or(ApiError::not_found("Track path not found"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        (epub_path, tracks, book.title.clone())
    };
    if tracks.is_empty() {
        return Err(ApiError::bad_request("This book has no audio tracks."));
    }

    let job_id = create_job(&state, "sync-generate").await;
    let state_for_job = state.clone();
    let job_id_for_task = job_id.clone();
    tokio::spawn(async move {
        update_job_output(
            &state_for_job,
            &job_id_for_task,
            &format!("Starting readalong sync generation for {book_title}.\n"),
        )
        .await;

        let result = run_sync_generation(
            &state_for_job,
            &job_id_for_task,
            &book_id,
            &cli_path,
            &epub_path,
            &tracks,
        )
        .await;

        match result {
            Ok(fragment_count) => {
                update_job_output(
                    &state_for_job,
                    &job_id_for_task,
                    &format!("Wrote sync map with {fragment_count} sentences.\n"),
                )
                .await;
                if let Err(error) = rescan_library(&state_for_job).await {
                    update_job_finished(
                        &state_for_job,
                        &job_id_for_task,
                        "failed",
                        None,
                        Some(format!(
                            "Sync map generated, but local rescan failed: {error}"
                        )),
                    )
                    .await;
                    return;
                }
                update_job_finished(&state_for_job, &job_id_for_task, "completed", Some(0), None)
                    .await;
            }
            Err(error) => {
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

struct SyncTrackInput {
    path: PathBuf,
    title: String,
    duration_seconds: Option<f64>,
}

async fn run_sync_generation(
    state: &AppState,
    job_id: &str,
    book_id: &str,
    cli_path: &FsPath,
    epub_path: &FsPath,
    tracks: &[SyncTrackInput],
) -> anyhow::Result<usize> {
    let epub_bytes = fs::read(epub_path).await?;
    let epub = tokio::task::spawn_blocking(move || alignment::parse_epub(&epub_bytes)).await??;
    anyhow::ensure!(
        !epub.sections.is_empty(),
        "No readable text sections were found in the EPUB."
    );
    update_job_output(
        state,
        job_id,
        &format!(
            "Extracted {} text sections and {} table-of-contents entries from the EPUB.\n",
            epub.sections.len(),
            epub.toc.len()
        ),
    )
    .await;

    // One scope per audio file: the whole book for single-file audiobooks,
    // otherwise chapter runs matched through the table of contents.
    let scopes = if tracks.len() == 1 {
        vec![alignment::TrackScope {
            track_index: 0,
            section_range: 0..epub.sections.len(),
        }]
    } else {
        let titles = tracks
            .iter()
            .map(|track| track.title.clone())
            .collect::<Vec<_>>();
        alignment::build_track_scopes(&titles, &epub.toc, epub.sections.len())
            .map_err(|message| anyhow::anyhow!(message))?
    };

    let mut track_start_seconds = vec![0.0f64; tracks.len()];
    for index in 1..tracks.len() {
        let previous_duration = tracks[index - 1].duration_seconds.ok_or_else(|| {
            anyhow::anyhow!(
                "Track `{}` has no known duration; cannot compute book positions.",
                tracks[index - 1].title
            )
        })?;
        track_start_seconds[index] = track_start_seconds[index - 1] + previous_duration;
    }

    let temp_dir = tempfile::tempdir()?;
    let mut fragments = Vec::new();
    for (scope_number, scope) in scopes.iter().enumerate() {
        let track = &tracks[scope.track_index];
        let transcript = alignment::build_transcript(&epub.sections[scope.section_range.clone()]);
        if transcript.text.trim().is_empty() {
            continue;
        }
        let transcript_path = temp_dir
            .path()
            .join(format!("transcript-{scope_number}.txt"));
        fs::write(&transcript_path, &transcript.text).await?;
        let output_path = temp_dir
            .path()
            .join(format!("alignment-{scope_number}.json"));

        update_job_output(
            state,
            job_id,
            &format!(
                "Aligning {} of {}: {} (this can take a while)...\n",
                scope_number + 1,
                scopes.len(),
                track.title
            ),
        )
        .await;

        let output = Command::new(cli_path)
            .arg("align")
            .arg(&track.path)
            .arg(&transcript_path)
            .arg(&output_path)
            .arg("--overwrite")
            .output()
            .await
            .map_err(|error| anyhow::anyhow!("Failed to run alignment CLI: {error}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let tail = stderr
                .lines()
                .rev()
                .take(12)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n");
            anyhow::bail!(
                "Alignment failed for `{}` with status {}:\n{}",
                track.title,
                output.status,
                tail
            );
        }

        let timeline_json = fs::read_to_string(&output_path).await?;
        let entries = alignment::parse_timeline(&timeline_json)?;
        let track_fragments = alignment::fragments_from_timeline(
            &entries,
            &transcript,
            track_start_seconds[scope.track_index],
        );
        update_job_output(
            state,
            job_id,
            &format!("  Matched {} sentences.\n", track_fragments.len()),
        )
        .await;
        fragments.extend(track_fragments);
    }

    anyhow::ensure!(
        !fragments.is_empty(),
        "Alignment produced no usable sentence fragments."
    );
    fragments.sort_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds));
    let fragment_count = fragments.len();

    let sync_map = alignment::SyncMap {
        version: alignment::SYNC_MAP_VERSION,
        generator: Some("echogarden".to_string()),
        generated_at: Some(now_rfc3339ish()),
        fragments,
    };
    fs::create_dir_all(&state.sync_dir).await?;
    let sync_path = state
        .sync_dir
        .join(format!("{book_id}{SYNC_SIDECAR_SUFFIX}"));
    write_json_atomic(&sync_path, &sync_map)
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;

    Ok(fragment_count)
}

async fn get_progress(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
) -> Result<Response, ApiError> {
    require_book_access(&auth, &book_id)?;
    let progress = read_progress(&state.progress_file).await?;
    let value = if let Some(saved) = progress.get(&progress_key(&auth.id, &book_id)) {
        let library = state.library.read().await;
        let enriched = library
            .books
            .iter()
            .find(|candidate| candidate.id == book_id)
            .map(|book| enrich_progress(book, saved))
            .unwrap_or_else(|| saved.clone());
        serde_json::to_value(enriched)?
    } else {
        serde_json::Value::Null
    };
    Ok(Json(value).into_response())
}

async fn update_progress(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
    Json(update): Json<ProgressUpdate>,
) -> Result<Json<Progress>, ApiError> {
    require_book_access(&auth, &book_id)?;
    let library = state.library.read().await;
    let book = library
        .books
        .iter()
        .find(|candidate| candidate.id == book_id)
        .ok_or(ApiError::not_found("Book not found"))?;
    let track = book
        .tracks
        .iter()
        .find(|candidate| candidate.id == update.track_id)
        .ok_or(ApiError::not_found("Track not found"))?;

    let _progress_guard = state.progress_write_lock.lock().await;
    let mut progress = read_progress(&state.progress_file).await?;
    let key = progress_key(&auth.id, &book.id);
    let previous = progress.get(&key).cloned();
    // Cap client timestamps at the server clock so one device with a
    // future-skewed clock cannot lock every other device out of this book.
    let now_millis = unix_now_millis();
    let now_seconds = now_millis as f64 / 1000.0;
    let incoming_seconds = update
        .updated_at_ms
        .map(|ms| (ms as f64 / 1000.0).min(now_seconds));
    if let (Some(previous), Some(incoming)) = (&previous, incoming_seconds)
        && progress_write_is_stale(&previous.updated_at, incoming)
    {
        // A replayed checkpoint — an offline queue flushing or a
        // reinstalled client syncing old local state — must not roll back
        // a position some device recorded more recently.
        return Ok(Json(previous.clone()));
    }
    let incoming_track_position =
        clamped_track_position(update.position_seconds, track.duration_seconds);
    let incoming_book_position = validated_book_position_seconds(
        book,
        track,
        incoming_track_position,
        update.book_position_seconds,
    );
    let saved = Progress {
        book_id: book.id.clone(),
        track_id: track.id.clone(),
        position_seconds: incoming_track_position,
        book_position_seconds: incoming_book_position,
        duration_seconds: update.duration_seconds.or(track.duration_seconds),
        updated_at: next_progress_timestamp(previous.as_ref(), now_millis),
        finished_override: carried_finished_override(
            previous.as_ref(),
            incoming_book_position,
            update.intentional_seek,
        ),
    };
    if let Some(previous) = &previous {
        if progress_write_is_unintentional_regression(
            previous.book_position_seconds,
            saved.book_position_seconds,
            update.intentional_seek || update.intentional_regression,
        ) {
            return Ok(Json(previous.clone()));
        }
        if progress_write_is_suspect_reset(
            previous.book_position_seconds,
            saved.book_position_seconds,
            update.intentional_regression,
        ) {
            // Keep the stored copy, exactly like a stale write: the client
            // that failed to restore converges back to the real position on
            // its next successful fetch.
            return Ok(Json(previous.clone()));
        }
        let regression_seconds = previous.book_position_seconds - saved.book_position_seconds;
        if regression_seconds > PROGRESS_BACKUP_REGRESSION_SECONDS {
            backup_progress_regression(&state.progress_file, &key, previous).await;
        }
    }
    progress.insert(key, saved.clone());
    write_progress(&state.progress_file, &progress).await?;

    // Reaching the end of a book finishes it without anyone pressing anything,
    // so the feed is fed from here as well as from the explicit mark.
    record_finish_event(
        &state,
        &auth,
        book,
        previous
            .as_ref()
            .map(|entry| summarize_book_progress(book, entry))
            .as_ref(),
        &summarize_book_progress(book, &saved),
    )
    .await;

    let listened_delta =
        plausible_listened_delta(previous.as_ref(), &saved, update.intentional_seek);
    if listened_delta > 0.0 {
        record_activity(
            &state,
            &auth.id,
            listened_delta,
            sanitized_tz_offset_minutes(update.tz_offset_minutes),
        )
        .await;
    }

    Ok(Json(saved))
}

async fn update_book_completion(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
    Json(update): Json<CompletionUpdate>,
) -> Result<Json<BookProgress>, ApiError> {
    require_book_access(&auth, &book_id)?;
    let book = state
        .library
        .read()
        .await
        .books
        .iter()
        .find(|candidate| candidate.id == book_id)
        .cloned()
        .ok_or(ApiError::not_found("Book not found"))?;
    let first_track = book
        .tracks
        .first()
        .ok_or(ApiError::bad_request("This book has no playable tracks."))?;
    let final_position = match (&update.track_id, update.position_seconds) {
        (None, None) => None,
        (Some(track_id), Some(position_seconds)) => {
            let track = book
                .tracks
                .iter()
                .find(|candidate| candidate.id == *track_id)
                .ok_or(ApiError::not_found("Track not found"))?;
            Some((
                track,
                clamped_track_position(position_seconds, track.duration_seconds),
            ))
        }
        _ => {
            return Err(ApiError::bad_request(
                "Completion position requires both trackId and positionSeconds.",
            ));
        }
    };

    let _progress_guard = state.progress_write_lock.lock().await;
    let mut progress = read_progress(&state.progress_file).await?;
    let key = progress_key(&auth.id, &book.id);
    let next_timestamp = next_progress_timestamp(progress.get(&key), unix_now_millis());
    // Snapshotted before the row is touched. Taking it afterwards would read
    // the position this very request is writing, so a book carried to its end
    // here would look finished on both sides and announce nothing.
    let previous_summary = progress
        .get(&key)
        .map(|entry| summarize_book_progress(&book, entry));
    let saved = progress.entry(key).or_insert_with(|| Progress {
        book_id: book.id.clone(),
        track_id: first_track.id.clone(),
        position_seconds: 0.0,
        book_position_seconds: 0.0,
        duration_seconds: first_track.duration_seconds,
        updated_at: next_timestamp.clone(),
        finished_override: None,
    });
    if let Some((track, position_seconds)) = final_position {
        saved.track_id = track.id.clone();
        saved.position_seconds = position_seconds;
        saved.book_position_seconds = validated_book_position_seconds(
            &book,
            track,
            position_seconds,
            update.book_position_seconds,
        );
        saved.duration_seconds = update.duration_seconds.or(track.duration_seconds);
        saved.updated_at = next_timestamp;
    }
    saved.finished_override = Some(update.finished);
    let saved = saved.clone();
    write_progress(&state.progress_file, &progress).await?;

    let summary = summarize_book_progress(&book, &saved);
    record_finish_event(&state, &auth, &book, previous_summary.as_ref(), &summary).await;

    Ok(Json(summary))
}

async fn stream_track(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path((book_id, track_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require_book_access(&auth, &book_id)?;
    let file_path = {
        let library = state.library.read().await;
        let book = library
            .books
            .iter()
            .find(|candidate| candidate.id == book_id)
            .ok_or(ApiError::not_found("Book not found"))?;
        book.tracks
            .iter()
            .find(|candidate| candidate.id == track_id)
            .ok_or(ApiError::not_found("Track not found"))?;
        library
            .track_paths
            .get(&track_id)
            .cloned()
            .ok_or(ApiError::not_found("Track path not found"))?
    };

    serve_file_response(&file_path, &[&state.library_root], headers, None).await
}

/// `mime_guess` types the MPEG-4 audio extensions in ways no client acts on:
/// `.m4b` and `.m4a` map to the unregistered `audio/m4b` and `audio/m4a`, and
/// `.mp4` maps to `video/mp4`. The track stream route carries no file extension
/// either, so a player that trusts `Content-Type` — iOS AVFoundation most of
/// all — is left with no usable hint about what it is being handed. Serve the
/// registered container type for all three and let every other extension keep
/// the guess, which is already correct for `mp3`, `flac`, `ogg`, and the rest.
fn media_content_type(file_path: &FsPath) -> String {
    let extension = file_path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_lowercase();
    match extension.as_str() {
        "m4a" | "m4b" | "mp4" => "audio/mp4".to_string(),
        _ => mime_guess::from_path(file_path)
            .first_or_octet_stream()
            .to_string(),
    }
}

async fn serve_file_response(
    file_path: &FsPath,
    allowed_roots: &[&FsPath],
    headers: HeaderMap,
    content_disposition: Option<String>,
) -> Result<Response, ApiError> {
    let file_path = file_path.to_path_buf();
    let path_for_open = file_path.clone();
    let allowed_roots = allowed_roots
        .iter()
        .map(|root| root.to_path_buf())
        .collect::<Vec<_>>();
    let (file, metadata) =
        tokio::task::spawn_blocking(move || open_contained_file(&path_for_open, &allowed_roots))
            .await
            .map_err(|error| ApiError::internal(format!("Could not open media file: {error}")))?
            .map_err(|_| ApiError::not_found("Media file not found"))?;
    let file_size = metadata.len();
    let content_type = media_content_type(&file_path);
    if file_size == 0 {
        if headers.contains_key(RANGE) {
            return range_not_satisfiable_response(file_size);
        }
        let mut response = Response::builder()
            .status(StatusCode::OK)
            .header(ACCEPT_RANGES, "bytes")
            .header(CONTENT_TYPE, content_type)
            .header(CONTENT_LENGTH, "0");
        if let Some(content_disposition) = content_disposition {
            response =
                response.header(axum::http::header::CONTENT_DISPOSITION, content_disposition);
        }
        return Ok(response.body(Body::empty())?);
    }

    let requested_range = match headers.get(RANGE) {
        None => None,
        Some(value) => {
            let Ok(value) = value.to_str() else {
                return range_not_satisfiable_response(file_size);
            };
            let Some(range) = parse_range(value, file_size) else {
                return range_not_satisfiable_response(file_size);
            };
            Some(range)
        }
    };

    let (status, start, end) = match requested_range {
        Some(range) => (StatusCode::PARTIAL_CONTENT, range.0, range.1),
        None => (StatusCode::OK, 0, file_size - 1),
    };

    let mut file = fs::File::from_std(file);
    file.seek(SeekFrom::Start(start)).await?;
    let stream =
        ReaderStream::with_capacity(file.take(end - start + 1), MEDIA_STREAM_BUFFER_CAPACITY);
    let body = Body::from_stream(stream);

    let mut response = Response::builder()
        .status(status)
        .header(ACCEPT_RANGES, "bytes")
        .header(CONTENT_TYPE, content_type)
        .header(CONTENT_LENGTH, (end - start + 1).to_string());

    if status == StatusCode::PARTIAL_CONTENT {
        response = response.header(CONTENT_RANGE, format!("bytes {start}-{end}/{file_size}"));
    }
    if let Some(content_disposition) = content_disposition {
        response = response.header(axum::http::header::CONTENT_DISPOSITION, content_disposition);
    }

    Ok(response.body(body)?)
}

fn open_contained_file(
    file_path: &FsPath,
    allowed_roots: &[PathBuf],
) -> anyhow::Result<(std::fs::File, std::fs::Metadata)> {
    if std::fs::symlink_metadata(file_path)?
        .file_type()
        .is_symlink()
    {
        anyhow::bail!("symbolic links are not valid media files");
    }

    let canonical_path = std::fs::canonicalize(file_path)?;
    let canonical_roots = allowed_roots
        .iter()
        .map(std::fs::canonicalize)
        .collect::<Result<Vec<_>, _>>()?;
    if !canonical_roots
        .iter()
        .any(|root| canonical_path != *root && canonical_path.starts_with(root))
    {
        anyhow::bail!("media file is outside an approved root");
    }

    let file = std::fs::File::open(&canonical_path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        anyhow::bail!("media path is not a regular file");
    }

    // Re-resolve and compare an independently opened handle after opening the
    // file. This rejects a pathname that was exchanged between validation and
    // use, while callers continue streaming from the already validated handle.
    let resolved_after_open = std::fs::canonicalize(file_path)?;
    if resolved_after_open != canonical_path
        || !canonical_roots
            .iter()
            .any(|root| resolved_after_open != *root && resolved_after_open.starts_with(root))
    {
        anyhow::bail!("media path changed during validation");
    }
    let opened_handle = same_file::Handle::from_file(file.try_clone()?)?;
    let current_handle = same_file::Handle::from_path(&resolved_after_open)?;
    if opened_handle != current_handle {
        anyhow::bail!("media file changed during validation");
    }

    Ok((file, metadata))
}

fn range_not_satisfiable_response(file_size: u64) -> Result<Response, ApiError> {
    Ok(Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(CONTENT_RANGE, format!("bytes */{file_size}"))
        .header(CONTENT_LENGTH, "0")
        .body(Body::empty())?)
}

async fn download_book(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
) -> Result<Response, ApiError> {
    require_book_access(&auth, &book_id)?;
    let download_permit = state
        .download_task_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            ApiError::too_many_requests(
                "The configured number of book archives are already being prepared or downloaded. Try again shortly.",
            )
        })?;
    let max_book_download_bytes = state.max_book_download_bytes;
    let download_temp_dir = state.download_temp_dir.clone();
    let min_download_free_bytes = state.min_download_free_bytes;
    let (book_title, tracks) = {
        let library = state.library.read().await;
        let book = library
            .books
            .iter()
            .find(|candidate| candidate.id == book_id)
            .ok_or(ApiError::not_found("Book not found"))?;
        let tracks: Vec<(String, PathBuf)> = book
            .tracks
            .iter()
            .filter_map(|track| {
                library
                    .track_paths
                    .get(&track.id)
                    .cloned()
                    .map(|path| (track.file_name.clone(), path))
            })
            .collect();
        (book.title.clone(), tracks)
    };

    if tracks.is_empty() {
        return Err(ApiError::not_found("No tracks available for download"));
    }

    let library_root = state.library_root.clone();
    let sizing_root = library_root.clone();
    let (tracks, source_bytes) = tokio::task::spawn_blocking(move || {
        let mut source_bytes = 0_u64;
        for (_, path) in &tracks {
            // Size the archive without keeping a handle per track: a book with
            // hundreds of chapter files would otherwise exhaust the process
            // descriptor limit before the ZIP is written.
            let (_, metadata) = open_contained_file(path, std::slice::from_ref(&sizing_root))?;
            source_bytes = source_bytes
                .checked_add(metadata.len())
                .ok_or_else(|| anyhow::anyhow!("The book is too large to archive."))?;
        }
        Ok::<_, anyhow::Error>((tracks, source_bytes))
    })
    .await
    .map_err(|error| ApiError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        message: error.to_string(),
    })??;
    if let Some(limit) = max_book_download_bytes
        && source_bytes > limit
    {
        return Err(ApiError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            message: format!(
                "Book downloads are limited to {} GiB.",
                limit / GIBIBYTE_BYTES
            ),
        });
    }
    let available_bytes = fs2::available_space(&download_temp_dir)?;
    if !download_volume_has_capacity(available_bytes, source_bytes, min_download_free_bytes) {
        return Err(ApiError {
            status: StatusCode::INSUFFICIENT_STORAGE,
            message: format!(
                "Not enough archive space: this download needs {} GiB while preserving the configured {} GiB free-space reserve.",
                source_bytes.div_ceil(GIBIBYTE_BYTES),
                min_download_free_bytes / GIBIBYTE_BYTES
            ),
        });
    }

    let (zip_path, download_permit) =
        tokio::task::spawn_blocking(move || -> anyhow::Result<(PathBuf, OwnedSemaphorePermit)> {
            let temp = tempfile::Builder::new()
                .prefix("operalibre-")
                .suffix(".zip")
                .tempfile_in(download_temp_dir)?;
            let (file, path) = temp.keep()?;
            let mut writer = zip::ZipWriter::new(file);
            let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored)
                .large_file(true);
            for (file_name, path) in tracks {
                // Re-open per entry so only one track handle is live at a time;
                // the containment check runs again against the same roots.
                let (mut source, _) =
                    open_contained_file(&path, std::slice::from_ref(&library_root))?;
                writer.start_file(sanitize_zip_entry(&file_name), options)?;
                std::io::copy(&mut source, &mut writer)?;
            }
            writer.finish()?;
            Ok((path, download_permit))
        })
        .await
        .map_err(|error| ApiError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: error.to_string(),
        })??;

    let file = fs::File::open(&zip_path).await?;
    let metadata = file.metadata().await?;
    let file_size = metadata.len();

    let safe_filename = sanitize_filename(&book_title);
    let stream = ReaderStream::new(RemoveOnDropFile::new(file, zip_path, download_permit));
    let body = Body::from_stream(stream);

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/zip")
        .header(CONTENT_LENGTH, file_size.to_string())
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{safe_filename}.zip\""),
        )
        .body(body)?)
}

struct RemoveOnDropFile {
    file: Option<fs::File>,
    path: PathBuf,
    _download_permit: OwnedSemaphorePermit,
}

impl RemoveOnDropFile {
    fn new(file: fs::File, path: PathBuf, download_permit: OwnedSemaphorePermit) -> Self {
        Self {
            file: Some(file),
            path,
            _download_permit: download_permit,
        }
    }
}

impl tokio::io::AsyncRead for RemoveOnDropFile {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        let file = self.file.as_mut().expect("file is present until drop");
        std::pin::Pin::new(file).poll_read(context, buffer)
    }
}

impl Drop for RemoveOnDropFile {
    fn drop(&mut self) {
        // Windows cannot unlink an open file. Close the handle before cleanup
        // so completed and cancelled downloads both remove their temporary ZIP.
        drop(self.file.take());
        if let Err(error) = std::fs::remove_file(&self.path)
            && error.kind() != io::ErrorKind::NotFound
        {
            tracing::warn!(
                path = %self.path.display(),
                "failed to remove temporary download: {error}"
            );
        }
    }
}

async fn delete_downloaded_book(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
) -> Result<Json<Vec<Book>>, ApiError> {
    require_admin(&auth)?;
    let _upload_guard = state.upload_lock.lock().await;

    let book_path = state
        .library
        .read()
        .await
        .book_paths
        .get(&book_id)
        .cloned()
        .ok_or(ApiError::not_found("Book not found"))?;

    let library_root = fs::canonicalize(&state.library_root).await?;
    let canonical_book_path = fs::canonicalize(&book_path).await?;
    if canonical_book_path == library_root || !canonical_book_path.starts_with(&library_root) {
        return Err(ApiError::forbidden(
            "The book path is outside the managed library.",
        ));
    }

    let metadata = fs::metadata(&canonical_book_path).await?;
    if metadata.is_dir() {
        fs::remove_dir_all(&canonical_book_path).await?;
    } else if metadata.is_file() {
        fs::remove_file(&canonical_book_path).await?;
    } else {
        return Err(ApiError::bad_request(
            "The downloaded book is not a regular file or folder.",
        ));
    }

    // Progress, metadata overrides, access grants, and Libation's catalog are
    // intentionally retained. If Libation downloads the same ASIN again, the
    // stable book id reconnects all of that state to the new local copy.
    rescan_library(&state).await?;
    Ok(Json(books_with_progress(&state, &auth).await?))
}

fn sanitize_filename(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            other if other.is_control() => '_',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "audiobook".to_string()
    } else {
        trimmed
    }
}

fn sanitize_zip_entry(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| match character {
            '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            other if other.is_control() => '_',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim_start_matches('/').to_string();
    if trimmed.is_empty() {
        "track".to_string()
    } else {
        trimmed
    }
}

fn clean_imported_title(value: &str) -> String {
    let trimmed = value.trim();
    let Some((open, close)) = trailing_bracket_pair(trimmed) else {
        return trimmed.to_string();
    };
    let candidate = trimmed[open + 1..close].trim();
    if normalize_guessed_asin(candidate).is_none() {
        return trimmed.to_string();
    }
    let cleaned = trimmed[..open].trim_end_matches([' ', '-', '_']).trim();
    if cleaned.is_empty() {
        trimmed.to_string()
    } else {
        cleaned.to_string()
    }
}

fn trailing_bracket_pair(value: &str) -> Option<(usize, usize)> {
    let close = value.trim_end().char_indices().next_back()?;
    let expected_open = match close.1 {
        ']' => '[',
        ')' => '(',
        _ => return None,
    };
    value[..close.0]
        .char_indices()
        .rev()
        .find(|(_, character)| *character == expected_open)
        .map(|(open, _)| (open, close.0))
}

fn metadata_override_from_update(
    update: BookMetadataUpdate,
) -> Result<BookMetadataOverride, ApiError> {
    let title = clean_metadata_text(&update.title);
    if title.is_empty() {
        return Err(ApiError::bad_request("Title is required."));
    }

    let asin = match update.asin {
        Some(value) if clean_metadata_text(&value).is_empty() => Some(String::new()),
        Some(value) => Some(
            normalize_asin(&value)
                .ok_or_else(|| ApiError::bad_request("ASIN must be a 10-character Audible id."))?,
        ),
        None => None,
    };

    Ok(BookMetadataOverride {
        title: Some(title),
        author: update.author.map(|value| clean_metadata_text(&value)),
        narrator: update.narrator.map(|value| clean_metadata_text(&value)),
        description: update.description.map(|value| clean_metadata_text(&value)),
        genres: Some(clean_genre_list(update.genres)),
        published_date: update
            .published_date
            .map(|value| clean_metadata_text(&value)),
        publisher: update.publisher.map(|value| clean_metadata_text(&value)),
        series: update.series.map(|value| clean_metadata_text(&value)),
        series_position: update
            .series_position
            .map(|value| clean_metadata_text(&value)),
        asin,
    })
}

fn clean_genre_list(genres: Vec<String>) -> Vec<String> {
    unique_strings(
        genres
            .into_iter()
            .flat_map(|value| {
                value
                    .split([';', ','])
                    .map(clean_metadata_text)
                    .collect::<Vec<_>>()
            })
            .filter(|value| !value.is_empty())
            .collect(),
    )
}

fn optional_override_value(value: &str) -> Option<String> {
    let cleaned = clean_metadata_text(value);
    (!cleaned.is_empty()).then_some(cleaned)
}

fn apply_book_metadata_override(book: &mut Book, metadata_override: &BookMetadataOverride) {
    if let Some(title) = metadata_override
        .title
        .as_deref()
        .and_then(optional_override_value)
    {
        book.title = title;
    }
    if let Some(author) = metadata_override.author.as_deref() {
        book.author = optional_override_value(author);
    }
    if let Some(narrator) = metadata_override.narrator.as_deref() {
        book.narrator = optional_override_value(narrator);
    }
    if let Some(description) = metadata_override.description.as_deref() {
        book.description = optional_override_value(description);
        book.metadata.description = book.description.clone();
    }
    if let Some(genres) = metadata_override.genres.as_ref() {
        book.genres = clean_genre_list(genres.clone());
        book.metadata.genres = book.genres.clone();
    }
    if let Some(published_date) = metadata_override.published_date.as_deref() {
        book.published_date = optional_override_value(published_date);
        book.metadata.published_date = book.published_date.clone();
    }
    if let Some(publisher) = metadata_override.publisher.as_deref() {
        book.metadata.publisher = optional_override_value(publisher);
    }
    if let Some(series) = metadata_override.series.as_deref() {
        book.metadata.series = optional_override_value(series);
    }
    if let Some(series_position) = metadata_override.series_position.as_deref() {
        book.metadata.series_position = optional_override_value(series_position);
    }
    if let Some(asin) = metadata_override.asin.as_deref() {
        book.asin = optional_override_value(asin);
    }
}

async fn load_library_identities(path: &FsPath) -> anyhow::Result<LibraryIdentityStore> {
    match fs::read_to_string(path).await {
        Ok(contents) => Ok(serde_json::from_str(&contents)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(LibraryIdentityStore::default())
        }
        Err(error) => Err(error.into()),
    }
}

fn library_identity_path(root: &FsPath, path: &FsPath) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn remember_identity_path(paths: &mut Vec<String>, path: &str) {
    const MAX_IDENTITY_PATH_ALIASES: usize = 32;
    if paths.iter().any(|candidate| candidate == path) {
        return;
    }
    paths.push(path.to_string());
    if paths.len() > MAX_IDENTITY_PATH_ALIASES {
        paths.remove(0);
    }
}

fn file_identity_fingerprint(path: &FsPath) -> anyhow::Result<String> {
    const SAMPLE_BYTES: usize = 64 * 1024;
    let mut file = std::fs::File::open(path)?;
    let size = file.metadata()?.len();
    let mut hasher = Sha256::new();
    hasher.update(size.to_le_bytes());

    let mut sample = vec![0_u8; SAMPLE_BYTES];
    let first_read = std::io::Read::read(&mut file, &mut sample)?;
    hasher.update((first_read as u64).to_le_bytes());
    hasher.update(&sample[..first_read]);

    if size > SAMPLE_BYTES as u64 {
        std::io::Seek::seek(&mut file, std::io::SeekFrom::End(-(SAMPLE_BYTES as i64)))?;
        let last_read = std::io::Read::read(&mut file, &mut sample)?;
        hasher.update((last_read as u64).to_le_bytes());
        hasher.update(&sample[..last_read]);
    }

    Ok(hex_digest(hasher.finalize()))
}

/// A file that cannot be read keeps a stable identity derived from its path
/// instead of failing the whole scan. The prefix can never collide with the
/// hex digest a successful fingerprint produces.
fn path_identity_fingerprint(path: &FsPath) -> String {
    format!("path:{}", stable_id(&path.to_string_lossy()))
}

/// Fingerprints every track in the library once per scan, reusing the stored
/// digest whenever a file's size and modification time are unchanged. Reading
/// 128 KB per track on every rescan is the dominant cost on large libraries,
/// so the steady state here is one stat per file.
///
/// Blocking: run this on a blocking task, not on a runtime worker.
fn fingerprint_tracks(
    library_root: &FsPath,
    files: &[PathBuf],
    previous: BTreeMap<String, CachedFingerprint>,
) -> (
    HashMap<PathBuf, String>,
    BTreeMap<String, CachedFingerprint>,
) {
    let mut fingerprints = HashMap::with_capacity(files.len());
    // Rebuilt from scratch so entries for removed files are pruned.
    let mut cache = BTreeMap::new();

    for path in files {
        let alias = library_identity_path(library_root, path);
        let stat = std::fs::metadata(path).ok().map(|metadata| {
            let modified_ms = metadata
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|since_epoch| u64::try_from(since_epoch.as_millis()).unwrap_or(u64::MAX))
                .unwrap_or(0);
            (metadata.len(), modified_ms)
        });
        let reused = stat.and_then(|(size, modified_ms)| {
            previous
                .get(&alias)
                .filter(|entry| entry.size == size && entry.modified_ms == modified_ms)
                .map(|entry| entry.fingerprint.clone())
        });
        let fingerprint = match reused {
            Some(fingerprint) => fingerprint,
            None => file_identity_fingerprint(path).unwrap_or_else(|error| {
                tracing::warn!("could not fingerprint {}: {error}", path.display());
                path_identity_fingerprint(path)
            }),
        };
        // Path-derived stand-ins are never cached: the next scan should retry
        // the read in case the file became readable again.
        if let Some((size, modified_ms)) = stat
            && !fingerprint.starts_with("path:")
        {
            cache.insert(
                alias,
                CachedFingerprint {
                    fingerprint: fingerprint.clone(),
                    size,
                    modified_ms,
                },
            );
        }
        fingerprints.insert(path.clone(), fingerprint);
    }

    (fingerprints, cache)
}

fn book_identity_fingerprint(track_fingerprints: &[String]) -> String {
    let mut sorted = track_fingerprints.to_vec();
    sorted.sort();
    let mut hasher = Sha256::new();
    for fingerprint in sorted {
        hasher.update((fingerprint.len() as u64).to_le_bytes());
        hasher.update(fingerprint.as_bytes());
    }
    hex_digest(hasher.finalize())
}

struct LibraryIdentityCandidate<'a> {
    book_fingerprint: &'a str,
    group_alias: &'a str,
    group_key: &'a FsPath,
    library_root: &'a FsPath,
    grouped_files: &'a [PathBuf],
    track_fingerprints: &'a [String],
}

fn resolve_library_identity(
    store: &mut LibraryIdentityStore,
    used_books: &mut HashSet<usize>,
    candidate: LibraryIdentityCandidate<'_>,
) -> (String, Vec<String>) {
    let LibraryIdentityCandidate {
        book_fingerprint,
        group_alias,
        group_key,
        library_root,
        grouped_files,
        track_fingerprints,
    } = candidate;
    let identity_index = store
        .books
        .iter()
        .enumerate()
        .find(|(index, identity)| {
            !used_books.contains(index) && identity.paths.iter().any(|path| path == group_alias)
        })
        .or_else(|| {
            store.books.iter().enumerate().find(|(index, identity)| {
                !used_books.contains(index) && identity.fingerprint == book_fingerprint
            })
        })
        .map(|(index, _)| index)
        .unwrap_or_else(|| {
            let index = store.books.len();
            store.books.push(BookIdentity {
                fingerprint: book_fingerprint.to_string(),
                book_id: stable_id(&group_key.to_string_lossy()),
                paths: vec![group_alias.to_string()],
                tracks: Vec::new(),
            });
            index
        });
    used_books.insert(identity_index);

    let identity = &mut store.books[identity_index];
    identity.fingerprint = book_fingerprint.to_string();
    remember_identity_path(&mut identity.paths, group_alias);

    let mut used_tracks = HashSet::new();
    let mut track_ids = Vec::with_capacity(grouped_files.len());
    for (file_path, fingerprint) in grouped_files.iter().zip(track_fingerprints) {
        let alias = library_identity_path(library_root, file_path);
        let track_index = identity
            .tracks
            .iter()
            .enumerate()
            .find(|(index, track)| {
                !used_tracks.contains(index) && track.paths.iter().any(|path| path == &alias)
            })
            .or_else(|| {
                identity.tracks.iter().enumerate().find(|(index, track)| {
                    !used_tracks.contains(index) && track.fingerprint == *fingerprint
                })
            })
            .map(|(index, _)| index)
            .unwrap_or_else(|| {
                let index = identity.tracks.len();
                identity.tracks.push(TrackIdentity {
                    fingerprint: fingerprint.clone(),
                    track_id: stable_id(&file_path.to_string_lossy()),
                    paths: vec![alias.clone()],
                });
                index
            });
        used_tracks.insert(track_index);
        let track = &mut identity.tracks[track_index];
        track.fingerprint = fingerprint.clone();
        remember_identity_path(&mut track.paths, &alias);
        track_ids.push(track.track_id.clone());
    }

    (identity.book_id.clone(), track_ids)
}

fn libation_sidecar_for_group(
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

fn parse_libation_sidecar(contents: &str) -> Option<LibationSidecarMetadata> {
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

fn normalized_json_key(key: &str) -> String {
    key.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

fn sidecar_values<'a>(
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

fn sidecar_string(value: &serde_json::Value, names: &[&str]) -> Option<String> {
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

fn sidecar_strings(value: &serde_json::Value, names: &[&str]) -> Vec<String> {
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

fn sidecar_people(value: &serde_json::Value, names: &[&str]) -> Option<String> {
    let people = sidecar_strings(value, names);
    (!people.is_empty()).then(|| unique_strings(people).join(", "))
}

fn sidecar_series(value: &serde_json::Value) -> Option<(String, Option<String>)> {
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

async fn rescan_library(state: &AppState) -> anyhow::Result<()> {
    let _rescan_guard = state.rescan_lock.lock().await;
    let scan_root = state.library_root.clone();
    let groups = tokio::task::spawn_blocking(move || {
        let files = walk_audio_files(&scan_root);
        group_files_into_books(&scan_root, files)
    })
    .await?;
    let mut identities = load_library_identities(&state.library_identities_file).await?;

    // Every track is fingerprinted up front on a blocking task: the reads are
    // synchronous and a large library would otherwise stall a runtime worker
    // for the whole scan.
    let scanned_files = groups
        .iter()
        .flat_map(|(_, grouped_files)| grouped_files.iter().cloned())
        .collect::<Vec<_>>();
    let metadata_files = scanned_files.clone();
    let library_root = state.library_root.clone();
    let cached_fingerprints = std::mem::take(&mut identities.fingerprint_cache);
    let fingerprint_task = tokio::task::spawn_blocking(move || {
        fingerprint_tracks(&library_root, &scanned_files, cached_fingerprints)
    });
    let metadata_task = tokio::task::spawn_blocking(move || {
        metadata_files
            .into_iter()
            .map(|path| {
                let metadata = read_track_metadata(&path);
                (path, metadata)
            })
            .collect::<HashMap<_, _>>()
    });
    let (track_fingerprints_by_path, fingerprint_cache) = fingerprint_task.await?;
    let mut metadata_by_path = metadata_task.await?;
    identities.fingerprint_cache = fingerprint_cache;

    let mut used_book_identities = HashSet::new();
    let metadata_overrides = state.metadata_overrides.read().await.clone();
    let mut track_paths = HashMap::new();
    let mut book_paths = HashMap::new();
    let mut reading_paths = HashMap::new();
    let mut sync_paths = HashMap::new();
    let mut cover_art = HashMap::new();
    let mut books = Vec::new();

    for (group_key, grouped_files) in groups {
        let track_fingerprints = grouped_files
            .iter()
            .map(|path| {
                track_fingerprints_by_path
                    .get(path)
                    .cloned()
                    .unwrap_or_else(|| path_identity_fingerprint(path))
            })
            .collect::<Vec<_>>();
        let book_fingerprint = book_identity_fingerprint(&track_fingerprints);
        let group_alias = library_identity_path(&state.library_root, &group_key);
        let (book_id, track_ids) = resolve_library_identity(
            &mut identities,
            &mut used_book_identities,
            LibraryIdentityCandidate {
                book_fingerprint: &book_fingerprint,
                group_alias: &group_alias,
                group_key: &group_key,
                library_root: &state.library_root,
                grouped_files: &grouped_files,
                track_fingerprints: &track_fingerprints,
            },
        );
        book_paths.insert(book_id.clone(), group_key.clone());
        let mut metadata = grouped_files
            .iter()
            .map(|file_path| metadata_by_path.remove(file_path).unwrap_or_default())
            .collect::<Vec<_>>();

        let tracks = grouped_files
            .iter()
            .enumerate()
            .map(|(index, file_path)| {
                let track_id = track_ids[index].clone();
                track_paths.insert(track_id.clone(), file_path.clone());
                let chapters = metadata[index]
                    .chapters
                    .iter()
                    .map(|chapter| Chapter {
                        id: stable_id(&format!("{track_id}:{}", chapter.start_seconds)),
                        title: chapter.title.clone(),
                        track_id: track_id.clone(),
                        track_index: index,
                        start_seconds: chapter.start_seconds,
                        end_seconds: chapter.end_seconds,
                        source: chapter.source.clone(),
                    })
                    .collect::<Vec<_>>();
                Track {
                    id: track_id.clone(),
                    title: metadata[index]
                        .title
                        .as_deref()
                        .map(clean_imported_title)
                        .unwrap_or_else(|| {
                            file_path
                                .file_stem()
                                .and_then(|name| name.to_str())
                                .map(clean_imported_title)
                                .unwrap_or_else(|| "Untitled track".to_string())
                        }),
                    file_name: file_path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("track")
                        .to_string(),
                    index,
                    duration_seconds: metadata[index].duration_seconds,
                    stream_url: format!("/api/books/{book_id}/tracks/{track_id}/stream"),
                    chapters,
                    metadata: metadata[index].summary.clone(),
                }
            })
            .collect::<Vec<_>>();

        let duration_seconds = tracks
            .iter()
            .map(|track| track.duration_seconds)
            .try_fold(0.0, |sum, duration| duration.map(|value| sum + value));

        let raw_title = if grouped_files.len() == 1 {
            metadata[0]
                .summary
                .album
                .clone()
                .or(metadata[0].title.clone())
                .unwrap_or_else(|| {
                    grouped_files[0]
                        .file_stem()
                        .and_then(|name| name.to_str())
                        .unwrap_or("Untitled book")
                        .to_string()
                })
        } else {
            group_key
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Untitled book")
                .to_string()
        };
        let mut title = clean_imported_title(&raw_title);

        let cover_art_url = metadata
            .iter()
            .find_map(|item| item.cover_art.clone())
            .map(|image| {
                cover_art.insert(book_id.clone(), image);
                format!("/api/books/{book_id}/cover")
            });
        let mut metadata_summary = merge_metadata_summary(&metadata);
        if let Some(sidecar) = libation_sidecar_for_group(&group_key, &grouped_files) {
            // A Libation sidecar is a direct Audible record for this download,
            // so it intentionally wins over lossy container tags. User edits
            // are applied below and remain the final authority.
            if let Some(sidecar_title) = sidecar.title {
                title = clean_imported_title(&sidecar_title);
            }
            metadata_summary = merge_two_summaries(sidecar.summary, metadata_summary);
            if let Some(subtitle) = sidecar.subtitle {
                metadata_summary.subtitle = Some(subtitle);
            }
            if let Some(author) = sidecar.author {
                metadata[0].author = Some(author);
            }
            if let Some(narrator) = sidecar.narrator {
                metadata[0].narrator = Some(narrator);
            }
            if let Some(asin) = sidecar.asin {
                metadata[0].asin = Some(asin);
            }
        }
        let mut book_chapters = build_book_chapters(&tracks);
        if book_chapters.is_empty() && tracks.len() > 1 {
            book_chapters = derive_track_chapters(&tracks);
        }
        let reading_file = find_reading_file(&book_id, &group_key, &grouped_files, &title);
        if let Some(reading_file) = reading_file.as_ref() {
            reading_paths.insert(reading_file.file.id.clone(), reading_file.path.clone());
        }
        let sync_file = find_sync_file(
            &book_id,
            &group_key,
            &grouped_files,
            &title,
            &state.sync_dir,
        );
        if let Some(sync_file) = sync_file.as_ref() {
            sync_paths.insert(book_id.clone(), sync_file.path.clone());
        }

        let mut book = Book {
            id: book_id.clone(),
            title,
            author: metadata.iter().find_map(|item| item.author.clone()),
            narrator: metadata.iter().find_map(|item| item.narrator.clone()),
            duration_seconds,
            track_count: tracks.len(),
            cover_art_url,
            description: metadata_summary.description.clone(),
            genres: metadata_summary.genres.clone(),
            published_date: metadata_summary.published_date.clone(),
            asin: metadata.iter().find_map(|item| item.asin.clone()),
            reading_file: reading_file.map(|reading_file| reading_file.file),
            sync_file: sync_file.map(|sync_file| sync_file.file),
            chapters: book_chapters,
            metadata: metadata_summary,
            tracks,
            progress: None,
            shared_progress: Vec::new(),
            volume_gain: BOOK_VOLUME_GAIN_DEFAULT,
        };
        if let Some(metadata_override) = metadata_overrides.books.get(&book_id) {
            apply_book_metadata_override(&mut book, metadata_override);
        }
        books.push(book);
    }

    write_json_atomic(&state.library_identities_file, &identities)
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;

    let mut library = state.library.write().await;
    library.books = books;
    library.book_paths = book_paths;
    library.track_paths = track_paths;
    library.reading_paths = reading_paths;
    library.sync_paths = sync_paths;
    library.cover_art = cover_art;
    Ok(())
}

struct DiscoveredSyncFile {
    file: SyncFile,
    path: PathBuf,
}

/// Finds a readalong sync map for a book: a user-provided `.sync.json`
/// sidecar beside the audiobook wins, then a server-generated file in the
/// sync data directory.
fn find_sync_file(
    book_id: &str,
    group_key: &FsPath,
    grouped_files: &[PathBuf],
    book_title: &str,
    sync_dir: &FsPath,
) -> Option<DiscoveredSyncFile> {
    let url = format!("/api/books/{book_id}/sync");
    let is_folder_book = group_key.is_dir();
    let search_dir = if is_folder_book {
        Some(group_key.to_path_buf())
    } else {
        group_key.parent().map(FsPath::to_path_buf)
    };

    if let Some(search_dir) = search_dir {
        let audio_stems = grouped_files
            .iter()
            .filter_map(|path| path.file_stem().and_then(|name| name.to_str()))
            .map(normalize_match_key)
            .collect::<Vec<_>>();
        let group_stem = group_key
            .file_stem()
            .and_then(|name| name.to_str())
            .map(normalize_match_key);
        let title_key = normalize_match_key(book_title);

        let mut candidates = WalkDir::new(&search_dir)
            .max_depth(1)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
            .map(|entry| entry.into_path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .map(has_sync_sidecar_suffix)
                    .unwrap_or(false)
            })
            .collect::<Vec<_>>();
        candidates.sort_by_key(|a| natural_path_key(a));

        let selected = candidates
            .iter()
            .find(|path| {
                let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                    return false;
                };
                let stem = &name[..name.len() - SYNC_SIDECAR_SUFFIX.len()];
                let stem_key = normalize_match_key(stem);
                Some(&stem_key) == group_stem.as_ref()
                    || stem_key == title_key
                    || audio_stems.iter().any(|audio_stem| audio_stem == &stem_key)
            })
            .or_else(|| is_folder_book.then(|| candidates.first()).flatten());
        if let Some(selected) = selected {
            return Some(DiscoveredSyncFile {
                path: selected.clone(),
                file: SyncFile {
                    file_name: selected
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("sync.json")
                        .to_string(),
                    source: "sidecar".to_string(),
                    url,
                },
            });
        }
    }

    let generated = sync_dir.join(format!("{book_id}{SYNC_SIDECAR_SUFFIX}"));
    if generated.is_file() {
        return Some(DiscoveredSyncFile {
            file: SyncFile {
                file_name: generated
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("sync.json")
                    .to_string(),
                source: "generated".to_string(),
                url,
            },
            path: generated,
        });
    }

    None
}

/// ASCII-case-insensitive `.sync.json` check that never slices the name at a
/// non-character boundary (file names can contain characters whose byte
/// length changes under Unicode lowercasing).
fn has_sync_sidecar_suffix(name: &str) -> bool {
    name.len() > SYNC_SIDECAR_SUFFIX.len()
        && name.is_char_boundary(name.len() - SYNC_SIDECAR_SUFFIX.len())
        && name[name.len() - SYNC_SIDECAR_SUFFIX.len()..].eq_ignore_ascii_case(SYNC_SIDECAR_SUFFIX)
}

struct DiscoveredReadingFile {
    file: ReadingFile,
    path: PathBuf,
}

fn find_reading_file(
    book_id: &str,
    group_key: &FsPath,
    grouped_files: &[PathBuf],
    book_title: &str,
) -> Option<DiscoveredReadingFile> {
    let is_folder_book = group_key.is_dir();
    let search_dir = if is_folder_book {
        group_key.to_path_buf()
    } else {
        group_key.parent()?.to_path_buf()
    };
    let audio_stems = grouped_files
        .iter()
        .filter_map(|path| path.file_stem().and_then(|name| name.to_str()))
        .map(normalize_match_key)
        .collect::<Vec<_>>();
    let group_stem = group_key
        .file_stem()
        .and_then(|name| name.to_str())
        .map(normalize_match_key);
    let title_key = normalize_match_key(book_title);

    let mut candidates = WalkDir::new(&search_dir)
        .max_depth(1)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| is_supported_reading_file(path))
        .collect::<Vec<_>>();
    candidates.sort_by_key(|a| natural_path_key(a));

    let selected = candidates
        .iter()
        .find(|path| {
            let Some(stem) = path.file_stem().and_then(|name| name.to_str()) else {
                return false;
            };
            let stem_key = normalize_match_key(stem);
            Some(&stem_key) == group_stem.as_ref()
                || stem_key == title_key
                || audio_stems.iter().any(|audio_stem| audio_stem == &stem_key)
        })
        .or_else(|| is_folder_book.then(|| candidates.first()).flatten())?;

    let extension = selected
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_lowercase();
    let file_name = selected
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("readalong")
        .to_string();
    let id = stable_id(&selected.to_string_lossy());
    let content_type = mime_guess::from_path(selected)
        .first_or_octet_stream()
        .to_string();

    Some(DiscoveredReadingFile {
        path: selected.clone(),
        file: ReadingFile {
            id,
            file_name,
            extension,
            content_type,
            url: format!("/api/books/{book_id}/readalong"),
        },
    })
}

fn is_supported_reading_file(path: &FsPath) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            READING_EXTENSIONS
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(extension))
        })
        .unwrap_or(false)
}

fn is_supported_audio_file(path: &FsPath) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            AUDIO_EXTENSIONS
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(extension))
        })
        .unwrap_or(false)
}

fn walk_audio_files(root: &FsPath) -> Vec<PathBuf> {
    let mut files = WalkDir::new(root)
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || !entry.file_type().is_dir()
                || !entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(UPLOAD_STAGING_PREFIX)
        })
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        // A conversion in flight writes a temporary remux beside the book. It
        // carries the book's extension, so it has to be excluded by name.
        .filter(|path| !faststart::is_work_file(path))
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| {
                    AUDIO_EXTENSIONS
                        .iter()
                        .any(|candidate| candidate.eq_ignore_ascii_case(extension))
                })
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();

    files.sort_by_key(|a| natural_path_key(a));
    files
}

fn group_files_into_books(root: &FsPath, files: Vec<PathBuf>) -> Vec<(PathBuf, Vec<PathBuf>)> {
    let mut groups = Vec::<(PathBuf, Vec<PathBuf>)>::new();

    for file_path in files {
        let parent = file_path.parent().unwrap_or(root);
        let key = if parent == root {
            file_path.clone()
        } else {
            parent.to_path_buf()
        };

        if let Some((_, grouped_files)) = groups.iter_mut().find(|(candidate, _)| *candidate == key)
        {
            grouped_files.push(file_path);
        } else {
            groups.push((key, vec![file_path]));
        }
    }

    groups.sort_by_key(|a| natural_path_key(&a.0));
    groups
}

fn read_track_metadata(file_path: &FsPath) -> TrackMetadata {
    let Ok(tagged_file) = read_from_path(file_path) else {
        return TrackMetadata::default();
    };

    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag());
    let mut summary = tag.map(extract_metadata_summary).unwrap_or_default();
    if let Some(vendor_summary) = tag.and_then(extract_vendor_json_summary) {
        summary = merge_two_summaries(summary, vendor_summary);
    }
    let chapters = read_embedded_chapters(file_path);

    let author = tag
        .and_then(|tag| {
            first_tag_text(
                tag,
                &[
                    ItemKey::TrackArtist,
                    ItemKey::AlbumArtist,
                    ItemKey::Writer,
                    ItemKey::Composer,
                ],
            )
        })
        .or_else(|| tag.and_then(|tag| tag.artist().map(|value| value.to_string())));

    TrackMetadata {
        title: tag
            .and_then(|tag| tag.title().map(|value| value.to_string()))
            .or_else(|| summary.album.clone()),
        narrator: tag
            .and_then(extract_narrator)
            .or_else(|| tag.and_then(extract_vendor_narrator))
            .or_else(|| tag.and_then(|tag| composer_narrator(tag, author.as_deref()))),
        author,
        // lofty reports Duration::ZERO when it cannot determine a length.
        // A zero-length track is indistinguishable from an unknown one, and
        // recording it as known collapses every track onto the same
        // whole-book offset — which strands progress on the wrong track and
        // makes advancing look like a regression. Unknown is the honest and
        // safe answer.
        duration_seconds: Some(tagged_file.properties().duration().as_secs_f64())
            .filter(|duration| *duration > 0.0),
        asin: tag
            .and_then(extract_asin)
            .or_else(|| extract_asin_from_path(file_path)),
        chapters,
        cover_art: tag.and_then(extract_cover_art),
        summary,
    }
}

fn extract_asin(tag: &Tag) -> Option<String> {
    if let Some(value) = extract_vendor_json(tag).and_then(|json| {
        ["asin", "audible_product_id", "product_id"]
            .iter()
            .find_map(|key| {
                json.get(*key)
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            })
    }) {
        return normalize_asin(&value);
    }

    tag.items().find_map(|item| {
        let key = item_key_label(item.key()).to_lowercase();
        let description = item.description().to_lowercase();
        if !(key.contains("asin") || description.contains("asin")) {
            return None;
        }
        match item.value() {
            ItemValue::Text(value) | ItemValue::Locator(value) => normalize_asin(value),
            ItemValue::Binary(_) => None,
        }
    })
}

fn extract_asin_from_path(path: &FsPath) -> Option<String> {
    let name = path.file_name().and_then(|name| name.to_str())?;
    name.split(|character: char| !character.is_ascii_alphanumeric())
        .find_map(normalize_guessed_asin)
}

/// Validates an id that was handed to us as an ASIN — a route parameter, a
/// Libation export field, a metadata sidecar, an `ASIN` tag. Audible ids come
/// in two shapes: the familiar `B`-prefixed ASIN, and an ISBN-10 for titles
/// listed under their print id (`125077795X` is *The Invisible Life of Addie
/// LaRue*). Accepting only the former rejects titles the account owns, and
/// accepting any ten alphanumerics lets junk through to the Libation CLI and
/// into saved metadata, so each shape is checked on its own terms.
fn normalize_asin(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_matches(char::from(0));
    if trimmed.len() != 10
        || !trimmed
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return None;
    }
    let normalized = trimmed.to_ascii_uppercase();
    (normalized.starts_with('B') || is_isbn10(&normalized)).then_some(normalized)
}

/// Ten characters, the last of which may be the check character `X`, weighted
/// 10 down to 1 and summing to a multiple of 11.
fn is_isbn10(value: &str) -> bool {
    if value.len() != 10 {
        return false;
    }
    let mut sum = 0u32;
    for (index, character) in value.char_indices() {
        let digit = match character.to_digit(10) {
            Some(digit) => digit,
            None if character == 'X' && index == 9 => 10,
            None => return false,
        };
        sum += (10 - index as u32) * digit;
    }
    sum.is_multiple_of(11)
}

/// Picks an ASIN out of text that merely *might* contain one, such as a file
/// name or a trailing `[B00F3F2J6K]` title suffix. Only the `B`-prefixed shape
/// counts here: a bare ten-digit run in a file name is far more likely to be a
/// date, a phone number, or a track id than an ISBN-10 the book is listed
/// under.
fn normalize_guessed_asin(value: &str) -> Option<String> {
    normalize_asin(value).filter(|asin| asin.starts_with('B'))
}

fn extract_metadata_summary(tag: &Tag) -> MetadataSummary {
    MetadataSummary {
        album: first_tag_text(tag, &[ItemKey::AlbumTitle]),
        subtitle: first_tag_text(tag, &[ItemKey::SetSubtitle, ItemKey::TrackSubtitle]),
        publisher: first_tag_text(tag, &[ItemKey::Publisher, ItemKey::Label]),
        published_date: first_tag_text(
            tag,
            &[
                ItemKey::ReleaseDate,
                ItemKey::RecordingDate,
                ItemKey::Year,
                ItemKey::OriginalReleaseDate,
            ],
        ),
        description: first_tag_text(
            tag,
            &[
                ItemKey::Description,
                ItemKey::PodcastDescription,
                ItemKey::Comment,
                ItemKey::Lyrics,
            ],
        ),
        language: first_tag_text(tag, &[ItemKey::Language]),
        series: None,
        series_position: None,
        genres: collect_genres(tag),
        raw_fields: collect_raw_fields(tag),
    }
}

fn first_tag_text(tag: &Tag, keys: &[ItemKey]) -> Option<String> {
    keys.iter()
        .find_map(|key| tag.get_string(*key))
        .map(clean_metadata_text)
        .filter(|value| !value.is_empty())
}

fn collect_genres(tag: &Tag) -> Vec<String> {
    tag.get_strings(ItemKey::Genre)
        .flat_map(|value| value.split([';', ',']))
        .map(clean_metadata_text)
        .filter(|value| !value.is_empty())
        .collect()
}

fn collect_raw_fields(tag: &Tag) -> Vec<MetadataField> {
    tag.items()
        .filter_map(|item| {
            let value = match item.value() {
                ItemValue::Text(value) | ItemValue::Locator(value) => {
                    truncate_metadata_value(&clean_metadata_text(value))
                }
                ItemValue::Binary(value) => format!("<{} bytes>", value.len()),
            };

            if value.is_empty() {
                return None;
            }

            Some(MetadataField {
                key: item_key_label(item.key()),
                value,
                description: (!item.description().is_empty())
                    .then(|| item.description().to_string()),
            })
        })
        .collect()
}

fn item_key_label(key: ItemKey) -> String {
    format!("{key:?}")
}

fn clean_metadata_text(value: impl AsRef<str>) -> String {
    let mut output = String::new();
    let mut in_tag = false;
    let normalized = value
        .as_ref()
        .replace("<br />", "\n")
        .replace("<br/>", "\n")
        .replace("<br>", "\n");

    for character in normalized.trim_matches(char::from(0)).chars() {
        match character {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => output.push(character),
            _ => {}
        }
    }

    output
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn truncate_metadata_value(value: &str) -> String {
    const MAX_FIELD_LEN: usize = 1600;
    if value.chars().count() <= MAX_FIELD_LEN {
        return value.to_string();
    }

    let preview = value.chars().take(MAX_FIELD_LEN).collect::<String>();
    format!("{preview}… [truncated]")
}

fn extract_narrator(tag: &Tag) -> Option<String> {
    first_tag_text(tag, &[ItemKey::Performer, ItemKey::Conductor])
        .or_else(|| find_raw_text_by_name(tag, &["narrator", "narrated by", "reader", "read by"]))
}

/// Converted audiobooks conventionally carry the narrator in the composer
/// field — that is what AAX rips and Libation write — so read it as one, but
/// only once another tag has named the author, since a file whose only credit
/// is a composer means it as the author.
fn composer_narrator(tag: &Tag, author: Option<&str>) -> Option<String> {
    let composer = first_tag_text(tag, &[ItemKey::Composer])?;
    let author = author?;
    (!composer.eq_ignore_ascii_case(author)).then_some(composer)
}

fn extract_vendor_narrator(tag: &Tag) -> Option<String> {
    extract_vendor_json(tag).and_then(|value| {
        value
            .get("narrated_by")
            .or_else(|| value.get("narrator"))
            .and_then(serde_json::Value::as_str)
            .map(clean_metadata_text)
    })
}

fn extract_vendor_json_summary(tag: &Tag) -> Option<MetadataSummary> {
    let value = extract_vendor_json(tag)?;
    Some(MetadataSummary {
        album: json_string(&value, &["title", "title_short", "filename"]),
        subtitle: json_string(&value, &["subtitle", "series_name"]),
        publisher: json_string(&value, &["publisher"]),
        published_date: json_string(&value, &["release_date", "purchase_date"]),
        description: json_string(&value, &["summary", "description"]),
        language: json_string(&value, &["language"]),
        series: json_string(&value, &["series", "series_name"]),
        series_position: json_string(&value, &["series_position", "series_sequence"]),
        genres: json_string(&value, &["genre"]).into_iter().collect(),
        raw_fields: Vec::new(),
    })
}

fn extract_vendor_json(tag: &Tag) -> Option<serde_json::Value> {
    tag.items().find_map(|item| {
        let text = match item.value() {
            ItemValue::Text(value) | ItemValue::Locator(value) => {
                value.trim_matches(char::from(0)).trim()
            }
            ItemValue::Binary(_) => return None,
        };

        if !looks_like_base64_json(text) {
            return None;
        }

        let decoded = general_purpose::STANDARD.decode(text).ok()?;
        serde_json::from_slice::<serde_json::Value>(&decoded)
            .ok()
            .filter(|value| value.is_object())
    })
}

fn looks_like_base64_json(value: &str) -> bool {
    value.len() > 128
        && value.len().is_multiple_of(4)
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '/' | '=')
        })
}

fn json_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(serde_json::Value::as_str)
            .map(clean_metadata_text)
            .filter(|value| !value.is_empty())
    })
}

fn find_raw_text_by_name(tag: &Tag, names: &[&str]) -> Option<String> {
    tag.items().find_map(|item| {
        let key = item_key_label(item.key()).to_lowercase();
        let description = item.description().to_lowercase();
        let matches_name = names
            .iter()
            .any(|name| key.contains(name) || description.contains(name));
        if !matches_name {
            return None;
        }

        match item.value() {
            ItemValue::Text(value) | ItemValue::Locator(value) => {
                Some(clean_metadata_text(value)).filter(|value| !value.is_empty())
            }
            ItemValue::Binary(_) => None,
        }
    })
}

fn extract_cover_art(tag: &Tag) -> Option<EmbeddedImage> {
    let picture = tag
        .get_picture_type(PictureType::CoverFront)
        .or_else(|| tag.pictures().first())?;
    Some(EmbeddedImage {
        mime_type: picture
            .mime_type()
            .map(|mime| mime.as_str().to_string())
            .unwrap_or_else(|| "application/octet-stream".to_string()),
        data: picture.data().to_vec(),
        etag: bytes_etag(picture.data()),
    })
}

fn bytes_etag(data: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(data);
    format!("\"{}\"", hex_digest(hasher.finalize()))
}

fn read_embedded_chapters(file_path: &FsPath) -> Vec<ParsedChapter> {
    let extension = file_path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_lowercase();

    let mut chapters = match extension.as_str() {
        "m4a" | "m4b" | "mp4" => read_mp4_chapters(file_path),
        "mp3" => read_id3_chapters(file_path),
        _ => Vec::new(),
    };

    chapters.sort_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds));
    chapters.dedup_by(|a, b| {
        (a.start_seconds - b.start_seconds).abs() < 0.001 && a.title.eq_ignore_ascii_case(&b.title)
    });
    chapters
}

fn read_mp4_chapters(file_path: &FsPath) -> Vec<ParsedChapter> {
    let Ok(tag) = mp4ameta::Tag::read_from_path(file_path) else {
        return Vec::new();
    };

    let chapter_track = tag.chapter_track();
    let chapter_list = tag.chapter_list();
    let source = if !chapter_track.is_empty() {
        "mp4-chapter-track"
    } else {
        "mp4-chapter-list"
    };
    let chapters = if !chapter_track.is_empty() {
        chapter_track
    } else {
        chapter_list
    };

    chapters
        .iter()
        .enumerate()
        .map(|(index, chapter)| ParsedChapter {
            title: if chapter.title.trim().is_empty() {
                format!("Chapter {}", index + 1)
            } else {
                chapter.title.clone()
            },
            start_seconds: chapter.start.as_secs_f64(),
            end_seconds: chapters
                .get(index + 1)
                .map(|next_chapter| next_chapter.start.as_secs_f64()),
            source: source.to_string(),
        })
        .collect()
}

fn read_id3_chapters(file_path: &FsPath) -> Vec<ParsedChapter> {
    let Ok(tag) = id3::Tag::read_from_path(file_path) else {
        return Vec::new();
    };

    let mut chapters = tag
        .frames()
        .filter_map(|frame| match frame.content() {
            Id3Content::Chapter(chapter) => {
                let title = chapter
                    .frames
                    .iter()
                    .find_map(|frame| {
                        (frame.id() == "TIT2")
                            .then(|| frame.content().text())
                            .flatten()
                            .map(str::to_string)
                    })
                    .unwrap_or_else(|| chapter.element_id.clone());

                Some(ParsedChapter {
                    title,
                    start_seconds: f64::from(chapter.start_time) / 1000.0,
                    end_seconds: (chapter.end_time != 0 && chapter.end_time != u32::MAX)
                        .then(|| f64::from(chapter.end_time) / 1000.0),
                    source: "id3-chap".to_string(),
                })
            }
            _ => None,
        })
        .collect::<Vec<_>>();

    chapters.sort_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds));
    chapters
}

fn merge_metadata_summary(metadata: &[TrackMetadata]) -> MetadataSummary {
    let mut raw_fields = Vec::new();
    for track in metadata {
        raw_fields.extend(track.summary.raw_fields.clone());
    }

    MetadataSummary {
        album: metadata
            .iter()
            .find_map(|track| track.summary.album.clone())
            .or_else(|| metadata.iter().find_map(|track| track.title.clone())),
        subtitle: metadata
            .iter()
            .find_map(|track| track.summary.subtitle.clone()),
        publisher: metadata
            .iter()
            .find_map(|track| track.summary.publisher.clone()),
        published_date: metadata
            .iter()
            .find_map(|track| track.summary.published_date.clone()),
        description: metadata
            .iter()
            .find_map(|track| track.summary.description.clone()),
        language: metadata
            .iter()
            .find_map(|track| track.summary.language.clone()),
        series: metadata
            .iter()
            .find_map(|track| track.summary.series.clone()),
        series_position: metadata
            .iter()
            .find_map(|track| track.summary.series_position.clone()),
        genres: unique_strings(
            metadata
                .iter()
                .flat_map(|track| track.summary.genres.clone())
                .collect(),
        ),
        raw_fields: unique_metadata_fields(raw_fields),
    }
}

fn merge_two_summaries(primary: MetadataSummary, fallback: MetadataSummary) -> MetadataSummary {
    MetadataSummary {
        album: primary.album.or(fallback.album),
        subtitle: primary.subtitle.or(fallback.subtitle),
        publisher: primary.publisher.or(fallback.publisher),
        published_date: primary.published_date.or(fallback.published_date),
        description: primary.description.or(fallback.description),
        language: primary.language.or(fallback.language),
        series: primary.series.or(fallback.series),
        series_position: primary.series_position.or(fallback.series_position),
        genres: unique_strings([primary.genres, fallback.genres].concat()),
        raw_fields: unique_metadata_fields([primary.raw_fields, fallback.raw_fields].concat()),
    }
}

fn build_book_chapters(tracks: &[Track]) -> Vec<Chapter> {
    let mut offset = 0.0;
    let mut chapters = Vec::new();

    for track in tracks {
        for chapter in &track.chapters {
            let mut book_chapter = chapter.clone();
            book_chapter.start_seconds += offset;
            book_chapter.end_seconds = book_chapter.end_seconds.map(|end| end + offset);
            chapters.push(book_chapter);
        }
        offset += track.duration_seconds.unwrap_or(0.0);
    }

    chapters.sort_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds));
    chapters
}

fn derive_track_chapters(tracks: &[Track]) -> Vec<Chapter> {
    let mut offset = 0.0;
    let mut chapters = Vec::new();

    for track in tracks {
        chapters.push(Chapter {
            id: stable_id(&format!("{}:{offset}", track.id)),
            title: track.title.clone(),
            track_id: track.id.clone(),
            track_index: track.index,
            start_seconds: offset,
            end_seconds: track.duration_seconds.map(|duration| offset + duration),
            source: "track-boundary".to_string(),
        });
        offset += track.duration_seconds.unwrap_or(0.0);
    }

    chapters
}

fn unique_strings(values: Vec<String>) -> Vec<String> {
    let mut output = Vec::new();
    for value in values {
        if !output
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(&value))
        {
            output.push(value);
        }
    }
    output
}

fn unique_metadata_fields(fields: Vec<MetadataField>) -> Vec<MetadataField> {
    let mut output = Vec::new();
    for field in fields {
        let exists = output.iter().any(|existing: &MetadataField| {
            existing.key == field.key
                && existing.value == field.value
                && existing.description == field.description
        });
        if !exists {
            output.push(field);
        }
    }
    output
}

fn enrich_progress(book: &Book, progress: &Progress) -> Progress {
    let Some(track) = book
        .tracks
        .iter()
        .find(|candidate| candidate.id == progress.track_id)
    else {
        return progress.clone();
    };

    let mut enriched = progress.clone();
    if enriched.book_position_seconds <= 0.0 {
        enriched.book_position_seconds =
            book_position_seconds(book, track, progress.position_seconds);
    }
    enriched
}

async fn books_with_progress(state: &AppState, auth: &AuthUser) -> Result<Vec<Book>, ApiError> {
    let saved_progress = read_progress(&state.progress_file).await?;
    let saved_settings = read_book_settings(&state.book_settings_file).await?;
    let sharers = progress_sharers(state, auth).await;
    let books = state.library.read().await.books.clone();
    Ok(books
        .into_iter()
        .filter(|book| can_access_book(auth, &book.id))
        .map(|mut book| {
            let key = progress_key(&auth.id, &book.id);
            book.progress = saved_progress
                .get(&key)
                .map(|progress| summarize_book_progress(&book, progress));
            book.shared_progress = collect_shared_progress(&book, &saved_progress, &sharers);
            book.volume_gain = stored_volume_gain(&saved_settings, &key);
            book
        })
        .collect())
}

async fn book_with_progress(
    state: &AppState,
    auth: &AuthUser,
    mut book: Book,
) -> Result<Book, ApiError> {
    let saved_progress = read_progress(&state.progress_file).await?;
    let key = progress_key(&auth.id, &book.id);
    book.progress = saved_progress
        .get(&key)
        .map(|progress| summarize_book_progress(&book, progress));
    let sharers = progress_sharers(state, auth).await;
    book.shared_progress = collect_shared_progress(&book, &saved_progress, &sharers);
    book.volume_gain =
        stored_volume_gain(&read_book_settings(&state.book_settings_file).await?, &key);
    Ok(book)
}

/// The other listeners whose progress `auth` is allowed to see, as
/// `(user_id, username)`. Sharing is reciprocal: a viewer who has switched
/// their own sharing off sees nobody, so opting out is a symmetric trade
/// rather than a way to watch without being watched.
async fn progress_sharers(state: &AppState, auth: &AuthUser) -> Vec<(String, String)> {
    let users = state.users.read().await;
    visible_sharers(&users.users, auth)
}

fn visible_sharers(users: &[User], auth: &AuthUser) -> Vec<(String, String)> {
    if !auth.share_progress {
        return Vec::new();
    }
    users
        .iter()
        .filter(|user| user.share_progress && user.id != auth.id)
        .map(|user| (user.id.clone(), user.username.clone()))
        .collect()
}

fn collect_shared_progress(
    book: &Book,
    saved_progress: &HashMap<String, Progress>,
    sharers: &[(String, String)],
) -> Vec<SharedProgress> {
    let mut entries: Vec<SharedProgress> = sharers
        .iter()
        .filter_map(|(user_id, username)| {
            let progress = saved_progress.get(&progress_key(user_id, book.id.as_str()))?;
            let summary = summarize_book_progress(book, progress);
            // A row exists as soon as a book is opened, so untouched books
            // would otherwise report every user on the server as a reader.
            if summary.status == BookProgressStatus::NotStarted {
                return None;
            }
            Some(SharedProgress {
                user_id: user_id.clone(),
                username: username.clone(),
                status: summary.status,
                percent_complete: summary.percent_complete,
                updated_at: summary.updated_at,
            })
        })
        .collect();
    // Finished readers first, then the furthest along, so the truncated list
    // shown on a library row leads with the most useful names.
    entries.sort_by(|a, b| {
        let rank = |entry: &SharedProgress| match entry.status {
            BookProgressStatus::Finished => 0,
            BookProgressStatus::InProgress => 1,
            BookProgressStatus::NotStarted => 2,
        };
        rank(a).cmp(&rank(b)).then_with(|| {
            b.percent_complete
                .unwrap_or(0.0)
                .partial_cmp(&a.percent_complete.unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    entries
}

fn summarize_book_progress(book: &Book, progress: &Progress) -> BookProgress {
    let enriched = enrich_progress(book, progress);
    // A non-positive duration means "unknown", never "this book is zero
    // seconds long". Treating it as known clamps the stored position to 0 and
    // reports the book as not started — and the library summary is the resume
    // point a reinstalled client falls back to when /progress is unavailable.
    let duration = book
        .duration_seconds
        .filter(|duration| *duration > 0.0)
        .or_else(|| known_duration_from_tracks(book));
    let position = duration
        .map(|duration| enriched.book_position_seconds.clamp(0.0, duration))
        .unwrap_or_else(|| enriched.book_position_seconds.max(0.0));
    let remaining = duration.map(|duration| (duration - position).max(0.0));
    let percent_complete = duration
        .filter(|duration| *duration > 0.0)
        .map(|duration| ((position / duration) * 100.0).clamp(0.0, 100.0));
    let status = book_progress_status(duration, remaining, position, enriched.finished_override);

    BookProgress {
        status,
        finished_override: enriched.finished_override,
        book_position_seconds: position,
        duration_seconds: duration,
        remaining_seconds: remaining,
        percent_complete,
        updated_at: enriched.updated_at,
    }
}

/// The furthest point a stored checkpoint reached, clamped to the book's real
/// duration. A raw `book_position_seconds` is only as trustworthy as the client
/// that reported it — when a book's track durations are unknown the server has
/// to take the client's word for it, and an over-reported position would
/// otherwise outrank every real one.
///
/// This is ground covered, not time spent: scrubbing forward moves it without
/// any listening. Never sum it into a listening total.
fn reached_position_seconds(book: &Book, progress: &Progress) -> f64 {
    summarize_book_progress(book, progress)
        .book_position_seconds
        .max(0.0)
}

fn book_progress_status(
    duration: Option<f64>,
    remaining: Option<f64>,
    position: f64,
    finished_override: Option<bool>,
) -> BookProgressStatus {
    match finished_override {
        Some(true) => BookProgressStatus::Finished,
        Some(false) if position > 0.0 => BookProgressStatus::InProgress,
        Some(false) => BookProgressStatus::NotStarted,
        None => match (duration, remaining, position) {
            (Some(duration), Some(remaining), _) if duration > 0.0 && remaining <= 30.0 => {
                BookProgressStatus::Finished
            }
            (Some(duration), _, position) if duration > 0.0 && position / duration >= 0.995 => {
                BookProgressStatus::Finished
            }
            (_, _, position) if position > 0.0 => BookProgressStatus::InProgress,
            _ => BookProgressStatus::NotStarted,
        },
    }
}

fn known_duration_from_tracks(book: &Book) -> Option<f64> {
    if book.tracks.is_empty() {
        return None;
    }
    book.tracks.iter().try_fold(0.0, |total, track| {
        track
            .duration_seconds
            .filter(|duration| *duration > 0.0)
            .map(|duration| total + duration)
    })
}

fn book_position_seconds(book: &Book, track: &Track, position_seconds: f64) -> f64 {
    let track_offset = book
        .tracks
        .iter()
        .take_while(|candidate| candidate.id != track.id)
        .map(|candidate| candidate.duration_seconds.unwrap_or(0.0))
        .sum::<f64>();
    track_offset + position_seconds.max(0.0)
}

fn clamped_track_position(position_seconds: f64, duration_seconds: Option<f64>) -> f64 {
    let position = position_seconds.max(0.0);
    duration_seconds
        .filter(|duration| *duration > 0.0)
        .map(|duration| position.min(duration))
        .unwrap_or(position)
}

/// The track id and server-side ordering are authoritative. Trust a reported
/// whole-book offset only when an earlier track has no known duration and the
/// server therefore cannot derive the offset itself.
fn validated_book_position_seconds(
    book: &Book,
    track: &Track,
    position_seconds: f64,
    reported: Option<f64>,
) -> f64 {
    let prefix_is_known = book
        .tracks
        .iter()
        .take_while(|candidate| candidate.id != track.id)
        .all(|candidate| candidate.duration_seconds.is_some());
    if prefix_is_known {
        book_position_seconds(book, track, position_seconds)
    } else {
        reported
            .unwrap_or_else(|| book_position_seconds(book, track, position_seconds))
            .max(0.0)
    }
}

/// Serialize to a temporary file in the destination directory and rename it
/// into place, so a crash mid-write never leaves a truncated store behind.
async fn write_json_atomic<T: Serialize>(path: &FsPath, value: &T) -> Result<(), ApiError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let mut suffix = [0u8; 8];
    rand::rng().fill(&mut suffix);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("store");
    let temp_path = path.with_file_name(format!(
        "{file_name}.{:016x}.tmp",
        u64::from_le_bytes(suffix)
    ));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut temp_file = options.open(&temp_path).await?;
    temp_file
        .write_all(&serde_json::to_vec_pretty(value)?)
        .await?;
    temp_file.flush().await?;
    drop(temp_file);
    secure_file_permissions(&temp_path).await?;
    if let Err(error) = fs::rename(&temp_path, path).await {
        let _ = fs::remove_file(&temp_path).await;
        return Err(error.into());
    }
    secure_file_permissions(path).await?;
    Ok(())
}

#[cfg(unix)]
async fn secure_file_permissions(path: &FsPath) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await
}

#[cfg(not(unix))]
async fn secure_file_permissions(_path: &FsPath) -> io::Result<()> {
    Ok(())
}

async fn read_progress(progress_file: &FsPath) -> Result<HashMap<String, Progress>, ApiError> {
    match fs::read_to_string(progress_file).await {
        Ok(contents) => Ok(serde_json::from_str(&contents)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(error) => Err(error.into()),
    }
}

async fn write_progress(
    progress_file: &FsPath,
    progress: &HashMap<String, Progress>,
) -> Result<(), ApiError> {
    write_json_atomic(progress_file, progress).await
}

async fn read_book_settings(
    book_settings_file: &FsPath,
) -> Result<HashMap<String, BookSettings>, ApiError> {
    match fs::read_to_string(book_settings_file).await {
        Ok(contents) => Ok(serde_json::from_str(&contents)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(error) => Err(error.into()),
    }
}

async fn write_book_settings(
    book_settings_file: &FsPath,
    settings: &HashMap<String, BookSettings>,
) -> Result<(), ApiError> {
    write_json_atomic(book_settings_file, settings).await
}

fn stored_volume_gain(settings: &HashMap<String, BookSettings>, key: &str) -> f64 {
    settings
        .get(key)
        .map(|entry| clamp_book_volume_gain(entry.volume_gain))
        .unwrap_or(BOOK_VOLUME_GAIN_DEFAULT)
}

/// Slack absorbs realistic clock skew between devices; a genuinely stale
/// replay (offline queue flush, reinstalled client) is hours or days old.
const PROGRESS_STALE_WRITE_SLACK_SECONDS: f64 = 300.0;

/// How far backwards an accepted write must jump before the replaced copy is
/// preserved on disk.
const PROGRESS_BACKUP_REGRESSION_SECONDS: f64 = 300.0;

/// AVPlayer and HTMLMediaElement clocks can differ by a fraction of a second
/// around pause and route-change events. Anything beyond this is a real
/// backwards move and must have been initiated by the listener.
const PROGRESS_AUTOMATIC_REGRESSION_SLACK_SECONDS: f64 = 2.0;

const PROGRESS_BACKUPS_PER_BOOK: usize = 20;

/// Positions this close to the start of a book are treated as "not started"
/// when they arrive over substantial stored progress.
const PROGRESS_NEAR_ZERO_SECONDS: f64 = 60.0;

/// Carries an explicit completion choice onto the next checkpoint, except
/// when the listener deliberately jumps back to the start of a book they had
/// marked finished. That is a re-listen, and keeping the override would label
/// the whole second pass "Finished". Only a deliberate seek clears it, so an
/// automatic position report can never erase the choice.
fn carried_finished_override(
    previous: Option<&Progress>,
    incoming_book_position: f64,
    intentional_seek: bool,
) -> Option<bool> {
    let previous = previous?;
    let restarting = intentional_seek
        && previous.finished_override == Some(true)
        && incoming_book_position < PROGRESS_NEAR_ZERO_SECONDS;
    if restarting {
        None
    } else {
        previous.finished_override
    }
}

fn plausible_listened_delta(
    previous: Option<&Progress>,
    saved: &Progress,
    intentional_seek: bool,
) -> f64 {
    let Some(previous) = previous else {
        // A first checkpoint may be a restore from another installation; no
        // elapsed interval exists from which listening can be inferred.
        return 0.0;
    };
    if intentional_seek {
        return 0.0;
    }
    let position_delta = (saved.book_position_seconds - previous.book_position_seconds).max(0.0);
    if position_delta <= 0.0 {
        return 0.0;
    }
    let previous_timestamp = progress_timestamp_seconds(&previous.updated_at);
    let saved_timestamp = progress_timestamp_seconds(&saved.updated_at);
    let elapsed = (saved_timestamp - previous_timestamp).max(0.0);
    // OperaLibre tops out at 2x. A small grace window covers rounded
    // timestamps and progress-save scheduling jitter without allowing a
    // multi-hour scrub to become activity.
    position_delta.min(elapsed * 2.1 + 5.0)
}

fn progress_timestamp_seconds(value: &str) -> f64 {
    let numeric = value.parse::<f64>().unwrap_or(0.0);
    if numeric >= 1_000_000_000_000.0 {
        numeric / 1000.0
    } else {
        numeric
    }
}

fn progress_timestamp_millis(value: &str) -> u64 {
    let numeric = value.parse::<f64>().unwrap_or(0.0).max(0.0);
    if numeric >= 1_000_000_000_000.0 {
        numeric.floor() as u64
    } else {
        (numeric * 1000.0).floor() as u64
    }
}

/// Accepted writes receive a server-issued monotonic millisecond revision.
/// This distinguishes a rapid rewind from the older high position it replaces
/// without allowing a future-skewed client clock to control ordering.
fn next_progress_timestamp(previous: Option<&Progress>, now_millis: u64) -> String {
    let previous_millis = previous
        .map(|progress| progress_timestamp_millis(&progress.updated_at))
        .unwrap_or(0);
    now_millis
        .max(previous_millis.saturating_add(1))
        .to_string()
}

fn progress_write_is_stale(stored_updated_at: &str, incoming_seconds: f64) -> bool {
    // Progress revisions may be legacy epoch seconds or monotonic epoch
    // milliseconds. Anything unparsable never blocks a write.
    let stored = progress_timestamp_seconds(stored_updated_at);
    incoming_seconds + PROGRESS_STALE_WRITE_SLACK_SECONDS < stored
}

/// A near-zero write that erases substantial progress is the signature of a
/// client that failed to restore its position, not of a listener starting
/// over — deliberate restarts and rewinds are flagged by the client. The
/// timestamp-staleness check cannot catch this case because the broken
/// client's write is genuinely fresh.
fn progress_write_is_suspect_reset(
    previous_book_position: f64,
    incoming_book_position: f64,
    intentional: bool,
) -> bool {
    !intentional
        && incoming_book_position < PROGRESS_NEAR_ZERO_SECONDS
        && previous_book_position - incoming_book_position > PROGRESS_BACKUP_REGRESSION_SECONDS
}

/// Periodic, pause, background, and completion-adjacent checkpoints are
/// monotonic. A late request must never roll back a newer position, regardless
/// of clock skew or network ordering. Explicit seeks and restarts are the sole
/// paths allowed to move backward.
fn progress_write_is_unintentional_regression(
    previous_book_position: f64,
    incoming_book_position: f64,
    intentional_seek: bool,
) -> bool {
    !intentional_seek
        && incoming_book_position + PROGRESS_AUTOMATIC_REGRESSION_SLACK_SECONDS
            < previous_book_position
}

/// Large backwards jumps are occasionally legitimate (restarting a book), but
/// they are also the shape of every progress-loss bug, so the replaced copy is
/// kept in a sibling file where it can always be recovered from disk.
async fn backup_progress_regression(progress_file: &FsPath, key: &str, previous: &Progress) {
    let path = progress_file.with_extension("backups.json");
    let mut backups: HashMap<String, Vec<Progress>> = match fs::read_to_string(&path).await {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => HashMap::new(),
    };
    let entries = backups.entry(key.to_string()).or_default();
    entries.push(previous.clone());
    if entries.len() > PROGRESS_BACKUPS_PER_BOOK {
        let excess = entries.len() - PROGRESS_BACKUPS_PER_BOOK;
        entries.drain(0..excess);
    }
    if write_json_atomic(&path, &backups).await.is_err() {
        tracing::warn!("failed to write progress backup file {}", path.display());
    }
}

async fn load_metadata_overrides(
    metadata_overrides_file: &FsPath,
) -> anyhow::Result<MetadataOverrideStore> {
    match fs::read_to_string(metadata_overrides_file).await {
        Ok(contents) => Ok(serde_json::from_str(&contents)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(MetadataOverrideStore::default())
        }
        Err(error) => Err(error.into()),
    }
}

async fn write_metadata_overrides(
    metadata_overrides_file: &FsPath,
    store: &MetadataOverrideStore,
) -> Result<(), ApiError> {
    write_json_atomic(metadata_overrides_file, store).await
}

#[derive(Debug, Clone)]
struct LibationConfig {
    cli_path: Option<PathBuf>,
    libation_files_dir: Option<PathBuf>,
    library_root: PathBuf,
    auto_refresh_hours: Option<u64>,
    reader_refreshes_per_hour: u64,
}

impl LibationConfig {
    fn from_server_config(config: &ServerConfig) -> Self {
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

    fn enabled(&self) -> bool {
        self.cli_path.is_some()
    }

    fn with_files_dir(&self, libation_files_dir: PathBuf) -> Self {
        Self {
            cli_path: self.cli_path.clone(),
            libation_files_dir: Some(libation_files_dir),
            library_root: self.library_root.clone(),
            auto_refresh_hours: self.auto_refresh_hours,
            reader_refreshes_per_hour: self.reader_refreshes_per_hour,
        }
    }

    fn command_args(&self, args: Vec<String>) -> Vec<String> {
        let mut command_args = args;
        if let Some(libation_files_dir) = &self.libation_files_dir {
            command_args.push("--libationFiles".to_string());
            command_args.push(libation_files_dir.to_string_lossy().to_string());
        }
        command_args
    }
}

#[derive(Debug, Clone)]
struct LibationProfile {
    id: String,
    name: String,
    account_id: Option<String>,
    managed: bool,
    config: LibationConfig,
}

fn managed_libation_profile(state: &AppState, account: &ManagedLibationAccount) -> LibationProfile {
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

async fn all_libation_profiles(state: &AppState) -> Vec<LibationProfile> {
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

async fn find_libation_profile(state: &AppState, profile_id: &str) -> Option<LibationProfile> {
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

#[derive(Debug, Clone)]
struct AlignmentConfig {
    cli_path: Option<PathBuf>,
}

impl AlignmentConfig {
    fn from_server_config(config: &ServerConfig) -> Self {
        let cli_path = config
            .alignment_cli_path
            .clone()
            .filter(|path| path.is_file())
            .or_else(find_alignment_cli_on_path);
        Self { cli_path }
    }

    fn enabled(&self) -> bool {
        self.cli_path.is_some()
    }
}

fn find_alignment_cli_on_path() -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    let candidates = ["echogarden", "echogarden.cmd", "echogarden.exe"];
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

fn find_libation_cli_on_path() -> Option<PathBuf> {
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

async fn read_libation_status(state: &AppState) -> LibationStatus {
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
        let mut store = state.libation_accounts.write().await;
        for account in &mut store.accounts {
            if let Some((authenticated, connection_state, error)) = changed_health.get(&account.id)
            {
                account.authenticated = *authenticated;
                account.connection_state = connection_state.clone();
                account.last_error = error.clone();
            }
        }
        if let Err(error) =
            write_managed_libation_accounts(&state.libation_accounts_file, &store).await
        {
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

fn parse_libation_accounts(output: &str) -> Vec<LibationAccount> {
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

fn yes_no(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case("yes") || value.trim().eq_ignore_ascii_case("true")
}

async fn export_libation_books(profile: &LibationProfile) -> Result<Vec<LibationBook>, ApiError> {
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

fn non_empty_string(value: impl AsRef<str>) -> Option<String> {
    let value = value.as_ref().trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

async fn run_libation(
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

fn start_interactive_libation_login(
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

fn run_interactive_libation_login(
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

fn extract_libation_login_url(output: &str) -> Option<String> {
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

fn sanitize_libation_login_output(output: &str) -> String {
    output
        .lines()
        .filter(|line| !line.contains("https://") && !line.starts_with("Paste URL:"))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn command_output_text(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = format!("{}{}", stdout, stderr);
    if text.trim().is_empty() {
        format!("Libation exited with status {}", output.status)
    } else {
        text.trim().to_string()
    }
}

async fn create_job(state: &AppState, kind: &str) -> String {
    create_job_with_state(state, kind, None, "running", false)
        .await
        .0
}

async fn create_libation_job(
    state: &AppState,
    kind: &str,
    target_id: Option<String>,
) -> (String, bool) {
    create_job_with_state(state, kind, target_id, "queued", true).await
}

async fn create_job_with_state(
    state: &AppState,
    kind: &str,
    target_id: Option<String>,
    status: &str,
    deduplicate_pending: bool,
) -> (String, bool) {
    let mut bytes = [0u8; 8];
    rand::rng().fill(&mut bytes);
    let id = format!("{:016x}", u64::from_le_bytes(bytes));
    let mut jobs = state.jobs.write().await;

    if deduplicate_pending
        && let Some(existing) = jobs
            .values()
            .filter(|job| job.kind == kind && job.target_id == target_id && is_active_job(job))
            .max_by_key(|job| job_started_timestamp(job))
    {
        return (existing.id.clone(), false);
    }

    let started_at = next_job_timestamp(&jobs).to_string();
    let job = JobStatus {
        id: id.clone(),
        kind: kind.to_string(),
        target_id,
        status: status.to_string(),
        started_at,
        finished_at: None,
        exit_code: None,
        output: String::new(),
        error: None,
    };
    jobs.insert(id.clone(), job);
    prune_finished_jobs(&mut jobs);
    (id, true)
}

const MAX_TRACKED_JOBS: usize = 50;
const MAX_JOB_OUTPUT_BYTES: usize = 64 * 1024;
const JOB_LIST_OUTPUT_BYTES: usize = 4 * 1024;

fn is_active_job(job: &JobStatus) -> bool {
    matches!(job.status.as_str(), "queued" | "running")
}

fn next_job_timestamp(jobs: &HashMap<String, JobStatus>) -> u64 {
    let latest = jobs.values().map(job_started_timestamp).max().unwrap_or(0);
    unix_now_millis().max(latest.saturating_add(1))
}

fn text_tail(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut start = value.len() - max_bytes;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    value[start..].to_string()
}

fn job_for_list(job: &JobStatus) -> JobStatus {
    let mut summary = job.clone();
    summary.output = text_tail(&summary.output, JOB_LIST_OUTPUT_BYTES);
    summary.error = summary
        .error
        .as_deref()
        .map(|error| text_tail(error, JOB_LIST_OUTPUT_BYTES));
    summary
}

/// Drops the oldest finished jobs once the map exceeds the cap, so job
/// history doesn't grow without bound. Active jobs are never removed.
fn prune_finished_jobs(jobs: &mut HashMap<String, JobStatus>) {
    if jobs.len() <= MAX_TRACKED_JOBS {
        return;
    }
    let mut finished: Vec<(String, u64)> = jobs
        .values()
        .filter(|job| matches!(job.status.as_str(), "completed" | "failed"))
        .map(|job| (job.id.clone(), job_started_timestamp(job)))
        .collect();
    finished.sort_by_key(|(_, started_at)| *started_at);
    for (job_id, _) in finished {
        if jobs.len() <= MAX_TRACKED_JOBS {
            break;
        }
        jobs.remove(&job_id);
    }
}

async fn update_job_running(state: &AppState, job_id: &str) {
    if let Some(job) = state.jobs.write().await.get_mut(job_id) {
        job.status = "running".to_string();
    }
}

async fn update_job_output(state: &AppState, job_id: &str, text: &str) {
    if let Some(job) = state.jobs.write().await.get_mut(job_id) {
        job.output.push_str(text);
        if job.output.len() > MAX_JOB_OUTPUT_BYTES {
            job.output = text_tail(&job.output, MAX_JOB_OUTPUT_BYTES);
        }
    }
}

async fn append_job_command_output(state: &AppState, job_id: &str, output: &std::process::Output) {
    update_job_output(state, job_id, &command_output_text(output)).await;
}

async fn update_job_finished(
    state: &AppState,
    job_id: &str,
    status: &str,
    exit_code: Option<i32>,
    error: Option<String>,
) {
    let mut jobs = state.jobs.write().await;
    if let Some(job) = jobs.get_mut(job_id) {
        job.status = status.to_string();
        job.finished_at = Some(unix_now_millis().to_string());
        job.exit_code = exit_code;
        job.error = error;
    }
    prune_finished_jobs(&mut jobs);
}

fn stable_id(input: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(input.as_bytes());
    hex_digest(hasher.finalize())[..16].to_string()
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    use std::fmt::Write as _;

    bytes
        .as_ref()
        .iter()
        .fold(String::new(), |mut output, byte| {
            write!(output, "{byte:02x}").expect("writing to a String cannot fail");
            output
        })
}

fn progress_key(user_id: &str, book_id: &str) -> String {
    format!("user:{user_id}:book:{book_id}")
}

fn parse_range(range: &str, file_size: u64) -> Option<(u64, u64)> {
    let range = range.strip_prefix("bytes=")?;
    let (start, end) = range.split_once('-')?;

    if start.is_empty() {
        let suffix_length = end.parse::<u64>().ok()?;
        if suffix_length == 0 {
            return None;
        }
        let start = file_size.saturating_sub(suffix_length);
        return Some((start, file_size - 1));
    }

    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() {
        file_size - 1
    } else {
        end.parse::<u64>().ok()?
    };

    if start >= file_size || end < start {
        return None;
    }

    Some((start, end.min(file_size - 1)))
}

fn natural_path_key(path: &FsPath) -> String {
    path.to_string_lossy().to_lowercase()
}

fn unix_now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn unix_now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn now_rfc3339ish() -> String {
    unix_now_seconds().to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileStatsQuery {
    /// The reader's offset from UTC in minutes, east positive. Streaks and the
    /// calendar are drawn against the reader's own days, not the server's.
    tz_offset_minutes: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileStats {
    total_hours_read: f64,
    books_finished: u32,
    total_tracks_completed: u32,
    current_streak_days: u32,
    longest_streak_days: u32,
    avg_daily_minutes: f64,
    last_listened_at: Option<String>,
    favorite_narrator: Option<String>,
    favorite_genre: Option<String>,
    days_active: u32,
    member_since: String,
    /// The first day the activity log recorded anything, so the client can say
    /// what window the listening total covers instead of implying all time.
    measuring_since: Option<String>,
    streak_calendar: Vec<StreakDay>,
    recent_books: Vec<RecentBook>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreakDay {
    date: String,
    minutes: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentBook {
    id: String,
    title: String,
    cover_art_url: Option<String>,
    hours_read: f64,
    finished: bool,
    updated_at: String,
}

async fn load_activity_store(activity_file: &FsPath) -> anyhow::Result<ActivityStore> {
    match fs::read_to_string(activity_file).await {
        Ok(contents) => {
            let mut store: ActivityStore = serde_json::from_str(&contents)?;
            // Older stores opened with a synthetic "everything before tracking
            // started" bucket, estimated from how far into each book the reader
            // had got. That conflated ground covered with time spent listening
            // and could only ever overstate it, so it is dropped on sight.
            for entries in store.by_user.values_mut() {
                entries.remove(ACTIVITY_BASELINE_KEY);
            }
            Ok(store)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(ActivityStore::default()),
        Err(error) => Err(error.into()),
    }
}

async fn write_activity_store(
    activity_file: &FsPath,
    store: &ActivityStore,
) -> Result<(), ApiError> {
    write_json_atomic(activity_file, store).await
}

/// Whether this write is the moment a book became finished.
///
/// A book stays finished across every later progress save, so testing the new
/// status alone would re-announce it on every heartbeat. Only the crossing
/// counts, which also means re-finishing a book after marking it unfinished
/// announces again — that is a real second reading, not a duplicate.
fn crossed_into_finished(previous: Option<&BookProgress>, next: &BookProgress) -> bool {
    next.status == BookProgressStatus::Finished
        && previous.map(|entry| entry.status) != Some(BookProgressStatus::Finished)
}

/// Append a finish to the shared feed, if this listener announces them.
///
/// Silent for anyone who has withdrawn from sharing or turned announcements
/// off, and silent when nothing crossed — so callers can hand every progress
/// write to it without deciding first.
async fn record_finish_event(
    state: &AppState,
    auth: &AuthUser,
    book: &Book,
    previous: Option<&BookProgress>,
    next: &BookProgress,
) {
    if !auth.share_progress || !auth.announce_finishes {
        return;
    }
    if !crossed_into_finished(previous, next) {
        return;
    }
    let event = FinishEvent {
        id: stable_id(&format!(
            "finish:{}:{}:{}",
            auth.id,
            book.id,
            unix_now_millis()
        )),
        user_id: auth.id.clone(),
        book_id: book.id.clone(),
        book_title: book.title.clone(),
        finished_at: now_rfc3339ish(),
    };
    // The guard is deliberately held across the file write rather than dropped
    // after the mutation. Two listeners finishing at once would otherwise each
    // take their own snapshot and race to persist it, and if the one holding
    // the older copy wrote last it would erase the other's event from disk —
    // memory would still look right until the next restart.
    let mut store = state.finish_events.write().await;
    store.events.push(event);
    // Oldest first, so trimming from the front keeps the recent tail the feed
    // actually shows.
    if store.events.len() > FINISH_EVENT_LIMIT {
        let excess = store.events.len() - FINISH_EVENT_LIMIT;
        store.events.drain(0..excess);
    }
    if let Err(error) = write_finish_events(&state.finish_events_file, &store).await {
        // The listener's own progress is already saved and is what matters;
        // a lost feed entry is not worth failing their request over.
        tracing::warn!("failed to persist finish event: {}", error.message);
    }
}

async fn load_finish_events(path: &FsPath) -> anyhow::Result<FinishEventStore> {
    match fs::read_to_string(path).await {
        Ok(contents) => Ok(serde_json::from_str(&contents)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(FinishEventStore::default()),
        Err(error) => Err(error.into()),
    }
}

async fn write_finish_events(path: &FsPath, store: &FinishEventStore) -> Result<(), ApiError> {
    write_json_atomic(path, store).await
}

/// Real UTC offsets span UTC-12 to UTC+14. Anything outside that is a broken
/// or hostile client and is treated as UTC rather than shifting the calendar.
fn sanitized_tz_offset_minutes(offset_minutes: Option<i32>) -> i64 {
    offset_minutes
        .filter(|minutes| (-12 * 60..=14 * 60).contains(minutes))
        .unwrap_or(0) as i64
}

fn today_ymd(tz_offset_minutes: i64) -> String {
    // Year-month-day in the listener's zone, no extra deps. Uses civil-date
    // conversion from days-since-epoch (1970-01-01) via Hinnant's algorithm.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0) as i64;
    days_to_ymd((now + tz_offset_minutes * 60).div_euclid(86_400))
}

fn days_to_ymd(days_since_epoch: i64) -> String {
    let z = days_since_epoch + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", year, m, d)
}

fn ymd_to_days(ymd: &str) -> Option<i64> {
    let mut parts = ymd.split('-');
    let y: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let d: i64 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y_adj = if m <= 2 { y - 1 } else { y };
    let era = y_adj.div_euclid(400);
    let yoe = y_adj.rem_euclid(400);
    let m_adj = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * m_adj + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

async fn record_activity(
    state: &AppState,
    user_id: &str,
    delta_seconds: f64,
    tz_offset_minutes: i64,
) {
    let today = today_ymd(tz_offset_minutes);
    // Keep mutation and persistence under one lock. Otherwise two snapshots can
    // be written in reverse order and an older activity total can win on disk.
    let mut activity = state.activity.write().await;
    let user_activity = activity.by_user.entry(user_id.to_string()).or_default();
    let entry = user_activity.entry(today).or_insert(0.0);
    *entry += delta_seconds;
    if let Err(error) = write_activity_store(&state.activity_file, &activity).await {
        tracing::warn!("failed to persist activity log: {}", error.message);
    }
}

async fn profile_stats(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Query(query): Query<ProfileStatsQuery>,
) -> Result<Json<ProfileStats>, ApiError> {
    let tz_offset_minutes = sanitized_tz_offset_minutes(query.tz_offset_minutes);
    let today = ymd_to_days(&today_ymd(tz_offset_minutes)).unwrap_or(0);
    let library = state.library.read().await;
    let progress_map = read_progress(&state.progress_file).await?;
    let key_prefix = format!("user:{}:book:", auth.id);
    let user_progress: Vec<(&String, &Progress)> = progress_map
        .iter()
        .filter(|(key, _)| key.starts_with(&key_prefix))
        .collect();

    // Headline numbers.
    let mut books_finished = 0u32;
    let mut total_tracks_completed = 0u32;
    let mut narrator_hours: HashMap<String, f64> = HashMap::new();
    let mut genre_hours: HashMap<String, f64> = HashMap::new();
    let mut last_updated: Option<String> = None;

    let mut book_lookup: HashMap<&str, &Book> = HashMap::new();
    for book in library.books.iter() {
        if can_access_book(&auth, &book.id) {
            book_lookup.insert(book.id.as_str(), book);
        }
    }

    let mut recent: Vec<RecentBook> = Vec::new();
    for (_, progress) in user_progress.iter() {
        if let Some(book) = book_lookup.get(progress.book_id.as_str()) {
            let summary = summarize_book_progress(book, progress);
            // How far into the book the reader has reached — the only per-book
            // signal there is, since the activity log records days and not
            // books. Good enough to rank narrators and genres and to caption a
            // shelf row; deliberately not added into the listening total.
            let hours = reached_position_seconds(book, progress) / 3600.0;
            let finished = matches!(summary.status, BookProgressStatus::Finished);
            if finished {
                books_finished += 1;
                total_tracks_completed += book.tracks.len() as u32;
            } else {
                let track_index = book
                    .tracks
                    .iter()
                    .position(|track| track.id == progress.track_id)
                    .unwrap_or(0);
                total_tracks_completed += track_index as u32;
            }
            if let Some(narrator) = book.narrator.as_ref() {
                *narrator_hours.entry(narrator.clone()).or_insert(0.0) += hours;
            }
            for genre in book.genres.iter() {
                *genre_hours.entry(genre.clone()).or_insert(0.0) += hours;
            }
            recent.push(RecentBook {
                id: book.id.clone(),
                title: book.title.clone(),
                cover_art_url: book.cover_art_url.clone(),
                hours_read: hours,
                finished,
                updated_at: progress.updated_at.clone(),
            });
            // Revisions are numeric, but legacy rows hold epoch seconds and
            // newer ones epoch milliseconds. Comparing the strings would order
            // a ten-digit revision against a thirteen-digit one by its leading
            // characters, so parse both to a common unit first.
            match &last_updated {
                Some(prev)
                    if progress_timestamp_seconds(prev)
                        >= progress_timestamp_seconds(&progress.updated_at) => {}
                _ => last_updated = Some(progress.updated_at.clone()),
            }
        }
    }

    recent.sort_by(|a, b| {
        progress_timestamp_seconds(&b.updated_at)
            .partial_cmp(&progress_timestamp_seconds(&a.updated_at))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    recent.truncate(6);

    // Activity-based numbers.
    let activity = state.activity.read().await;
    let user_activity = activity.by_user.get(&auth.id).cloned().unwrap_or_default();

    // Only ground actually covered while playing, summed from the per-day log.
    // Every second here came from a forward position move that the server could
    // match against elapsed wall-clock time, with deliberate seeks excluded —
    // so this is time spent listening, not how far into books the reader has
    // reached. Nothing estimates the era before the log existed; that history
    // is unmeasured, and `measuring_since` says so rather than guessing.
    let total_seconds_activity: f64 = user_activity.values().map(|seconds| seconds.max(0.0)).sum();
    let total_hours_read = total_seconds_activity / 3600.0;
    let measuring_since = user_activity
        .iter()
        .find(|(_, seconds)| **seconds > 0.0)
        .map(|(date, _)| date.clone());

    // "Per active day" must divide the same seconds it counts days for,
    // otherwise a scattering of sub-minute days inflates every other day's
    // average.
    let active_day_seconds: f64 = user_activity
        .values()
        .filter(|seconds| **seconds > 30.0)
        .sum();
    let days_active = user_activity
        .values()
        .filter(|seconds| **seconds > 30.0)
        .count() as u32;

    let avg_daily_minutes = if days_active > 0 {
        (active_day_seconds / 60.0) / days_active as f64
    } else {
        0.0
    };

    let (current_streak_days, longest_streak_days) = compute_streaks(&user_activity, today);
    let streak_calendar = build_streak_calendar(&user_activity, 8, today);

    let favorite_narrator = narrator_hours
        .into_iter()
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .filter(|(_, hours)| *hours > 0.05)
        .map(|(name, _)| name);
    let favorite_genre = genre_hours
        .into_iter()
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .filter(|(_, hours)| *hours > 0.05)
        .map(|(name, _)| name);

    let member_since = state
        .users
        .read()
        .await
        .users
        .iter()
        .find(|user| user.id == auth.id)
        .map(|user| user.created_at.clone())
        .unwrap_or_default();

    Ok(Json(ProfileStats {
        total_hours_read,
        books_finished,
        total_tracks_completed,
        current_streak_days,
        longest_streak_days,
        avg_daily_minutes,
        last_listened_at: last_updated,
        favorite_narrator,
        favorite_genre,
        days_active,
        member_since,
        measuring_since,
        streak_calendar,
        recent_books: recent,
    }))
}

fn compute_streaks(activity: &BTreeMap<String, f64>, today: i64) -> (u32, u32) {
    let mut active_days: Vec<i64> = activity
        .iter()
        .filter_map(|(date, seconds)| {
            if *seconds > 30.0 {
                ymd_to_days(date)
            } else {
                None
            }
        })
        .collect();
    active_days.sort_unstable();
    active_days.dedup();

    if active_days.is_empty() {
        return (0, 0);
    }

    let mut longest = 1u32;
    let mut run = 1u32;
    for window in active_days.windows(2) {
        if window[1] - window[0] == 1 {
            run += 1;
            if run > longest {
                longest = run;
            }
        } else {
            run = 1;
        }
    }

    let last = *active_days.last().unwrap();
    let current = if today - last <= 1 {
        let mut run = 1u32;
        for window in active_days.windows(2).rev() {
            if window[1] - window[0] == 1 {
                run += 1;
            } else {
                break;
            }
        }
        run
    } else {
        0
    };

    (current, longest)
}

/// Monday-based weekday index for a day count since 1970-01-01, which was a
/// Thursday.
fn weekday_from_monday(days_since_epoch: i64) -> i64 {
    (days_since_epoch + 3).rem_euclid(7)
}

/// Whole calendar weeks ending with the week that contains today, so the grid
/// the client draws lines up under a fixed Monday-to-Sunday label column. The
/// tail of the current week is still in the future and simply reads as zero.
fn build_streak_calendar(
    activity: &BTreeMap<String, f64>,
    weeks: i64,
    today: i64,
) -> Vec<StreakDay> {
    let start = today - weekday_from_monday(today) - (weeks - 1) * 7;
    (0..weeks * 7)
        .map(|offset| {
            let date = days_to_ymd(start + offset);
            let seconds = activity.get(&date).copied().unwrap_or(0.0);
            StreakDay {
                date,
                minutes: seconds / 60.0,
            }
        })
        .collect()
}

async fn load_users_store(users_file: &FsPath) -> anyhow::Result<UsersStore> {
    match fs::read_to_string(users_file).await {
        Ok(contents) => {
            let mut store: UsersStore = serde_json::from_str(&contents)?;
            if migrate_users_permissions(&mut store) {
                write_users_store(users_file, &store)
                    .await
                    .map_err(|error| anyhow::anyhow!(error.message.clone()))?;
            }
            Ok(store)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(UsersStore::default()),
        Err(error) => Err(error.into()),
    }
}

fn migrate_users_permissions(store: &mut UsersStore) -> bool {
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

async fn write_users_store(users_file: &FsPath, store: &UsersStore) -> Result<(), ApiError> {
    write_json_atomic(users_file, store).await
}

async fn load_libation_requests(path: &FsPath) -> anyhow::Result<LibationRequestStore> {
    match fs::read_to_string(path).await {
        Ok(contents) => {
            let mut store: LibationRequestStore = serde_json::from_str(&contents)?;
            if recover_interrupted_libation_requests(&mut store) {
                write_libation_requests(path, &store)
                    .await
                    .map_err(|error| anyhow::anyhow!(error.message.clone()))?;
            }
            Ok(store)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(LibationRequestStore::default())
        }
        Err(error) => Err(error.into()),
    }
}

fn recover_interrupted_libation_requests(store: &mut LibationRequestStore) -> bool {
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

async fn write_libation_requests(
    path: &FsPath,
    store: &LibationRequestStore,
) -> Result<(), ApiError> {
    write_json_atomic(path, store).await
}

async fn load_libation_refreshes(path: &FsPath) -> anyhow::Result<LibationRefreshStore> {
    match fs::read_to_string(path).await {
        Ok(contents) => Ok(serde_json::from_str(&contents)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(LibationRefreshStore::default())
        }
        Err(error) => Err(error.into()),
    }
}

async fn write_libation_refreshes(
    path: &FsPath,
    store: &LibationRefreshStore,
) -> Result<(), ApiError> {
    write_json_atomic(path, store).await
}

async fn load_managed_libation_accounts(
    path: &FsPath,
) -> anyhow::Result<ManagedLibationAccountStore> {
    match fs::read_to_string(path).await {
        Ok(contents) => Ok(serde_json::from_str(&contents)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(ManagedLibationAccountStore::default())
        }
        Err(error) => Err(error.into()),
    }
}

async fn write_managed_libation_accounts(
    path: &FsPath,
    store: &ManagedLibationAccountStore,
) -> Result<(), ApiError> {
    write_json_atomic(path, store).await
}

async fn load_sessions_store(sessions_file: &FsPath) -> anyhow::Result<HashMap<String, Session>> {
    match fs::read_to_string(sessions_file).await {
        Ok(contents) => {
            let mut sessions: HashMap<String, Session> = serde_json::from_str(&contents)?;
            let now = unix_now_seconds();
            sessions.retain(|_, session| !session.is_expired(now));
            Ok(sessions)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(error) => Err(error.into()),
    }
}

async fn write_sessions_store(
    sessions_file: &FsPath,
    sessions: &HashMap<String, Session>,
) -> Result<(), ApiError> {
    write_json_atomic(sessions_file, sessions).await
}

static DUMMY_PASSWORD_HASH: LazyLock<String> =
    LazyLock::new(|| hash_password("operalibre-timing-equalizer").unwrap_or_default());

fn hash_password(password: &str) -> Result<String, ApiError> {
    let salt = SaltString::generate(&mut PasswordOsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| ApiError::internal(format!("Password hashing failed: {error}")))
}

fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .and_then(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed))
        .is_ok()
}

async fn hash_password_async(state: &AppState, password: String) -> Result<String, ApiError> {
    let _permit = state
        .password_task_slots
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| ApiError::internal("Password worker pool is unavailable."))?;
    tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(|error| ApiError::internal(format!("Password worker failed: {error}")))?
}

async fn verify_password_async(
    state: &AppState,
    password: String,
    hash: String,
) -> Result<bool, ApiError> {
    let _permit = state
        .password_task_slots
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| ApiError::internal("Password worker pool is unavailable."))?;
    tokio::task::spawn_blocking(move || verify_password(&password, &hash))
        .await
        .map_err(|error| ApiError::internal(format!("Password worker failed: {error}")))
}

async fn verify_dummy_password_async(state: &AppState, password: String) -> Result<bool, ApiError> {
    let _permit = state
        .password_task_slots
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| ApiError::internal("Password worker pool is unavailable."))?;
    tokio::task::spawn_blocking(move || verify_password(&password, &DUMMY_PASSWORD_HASH))
        .await
        .map_err(|error| ApiError::internal(format!("Password worker failed: {error}")))
}

fn generate_session_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes);
    general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn media_token_for_session(session_token: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"operalibre-media-v1\0");
    digest.update(session_token.as_bytes());
    general_purpose::URL_SAFE_NO_PAD.encode(digest.finalize())
}

fn setup_token_digest(token: &str) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(b"operalibre-setup-v1\0");
    digest.update(token.as_bytes());
    digest.finalize().into()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (left, right) in left.iter().zip(right) {
        difference |= left ^ right;
    }
    difference == 0
}

fn normalize_username(value: &str) -> String {
    value.trim().to_string()
}

fn validate_password(password: &str) -> Result<(), ApiError> {
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

fn validate_username(username: &str) -> Result<(), ApiError> {
    let trimmed = username.trim();
    if trimmed.is_empty() {
        return Err(ApiError::bad_request("Username is required."));
    }
    if trimmed.chars().count() > 64 {
        return Err(ApiError::bad_request("Username is too long."));
    }
    Ok(())
}

fn token_from_authorization(headers: &HeaderMap) -> Option<String> {
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
}

fn token_from_cookie_header(value: &str) -> Option<String> {
    value.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        if name == SESSION_COOKIE_NAME && !value.is_empty() {
            Some(value.to_string())
        } else {
            None
        }
    })
}

fn token_from_cookies(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(token_from_cookie_header)
}

fn token_from_headers(headers: &HeaderMap) -> Option<String> {
    token_from_authorization(headers).or_else(|| token_from_cookies(headers))
}

fn session_cookie(token: &str, secure: bool) -> String {
    let secure_attribute = if secure { "; Secure" } else { "" };
    format!(
        "{SESSION_COOKIE_NAME}={token}; Path=/; Max-Age={SESSION_COOKIE_MAX_AGE_SECONDS}{secure_attribute}; HttpOnly; SameSite=Lax"
    )
}

fn expired_session_cookie(secure: bool) -> String {
    let secure_attribute = if secure { "; Secure" } else { "" };
    format!("{SESSION_COOKIE_NAME}=; Path=/; Max-Age=0{secure_attribute}; HttpOnly; SameSite=Lax")
}

fn request_client_ip(peer_address: SocketAddr, headers: &HeaderMap) -> IpAddr {
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

fn query_token_allowed(method: &Method, path: &str) -> bool {
    if method != Method::GET {
        return false;
    }
    let segments: Vec<_> = path.trim_matches('/').split('/').collect();
    matches!(
        segments.as_slice(),
        ["api", "books", _, "cover"]
            | ["api", "books", _, "readalong"]
            | ["api", "books", _, "download"]
            | ["api", "books", _, "tracks", _, "stream"]
            | ["api", "libation", "covers", _]
    )
}

enum RequestCredential {
    Session(String),
    Media(String),
}

fn extract_request_credential(req: &Request) -> Option<RequestCredential> {
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

async fn resolve_session(state: &AppState, token: &str) -> Option<AuthUser> {
    let sessions = state.sessions.read().await;
    let session = sessions.get(token)?.clone();
    drop(sessions);
    if session.is_expired(unix_now_seconds()) {
        let mut sessions = state.sessions.write().await;
        if sessions.remove(token).is_some()
            && let Err(error) = write_sessions_store(&state.sessions_file, &sessions).await
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
        .map(|user| AuthUser {
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
        })
}

async fn resolve_media_session(state: &AppState, media_token: &str) -> Option<(AuthUser, String)> {
    let session_token = {
        let sessions = state.sessions.read().await;
        sessions
            .keys()
            .find(|token| media_token_for_session(token) == media_token)
            .cloned()?
    };
    resolve_session(state, &session_token)
        .await
        .map(|user| (user, session_token))
}

async fn auth_middleware(
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

fn is_safe_http_method(method: &Method) -> bool {
    matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
}

fn request_authority(value: &str) -> Option<String> {
    value
        .parse::<axum::http::Uri>()
        .ok()?
        .authority()
        .map(|authority| authority.as_str().to_ascii_lowercase())
}

fn build_csrf_allowed_origins(configured_origins: &[String]) -> HashSet<String> {
    OFFICIAL_APP_ORIGINS
        .iter()
        .copied()
        .chain(configured_origins.iter().map(String::as_str))
        .map(|origin| origin.trim_end_matches('/').to_ascii_lowercase())
        .collect()
}

fn cookie_request_origin_allowed(allowed_origins: &HashSet<String>, headers: &HeaderMap) -> bool {
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

fn enforce_cookie_csrf(state: &AppState, request: &Request) -> Result<(), ApiError> {
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

async fn auth_status(
    State(state): State<AppState>,
    ConnectInfo(peer_address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let setup_required = state.users.read().await.users.is_empty();
    let remote_client = !request_client_ip(peer_address, &headers).is_loopback();
    let (user, media_token) = if let Some(token) = token_from_headers(&headers) {
        match resolve_session(&state, &token).await {
            Some(auth) => (
                Some(UserPublic {
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
                }),
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

async fn setup_admin(
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
        id: stable_id(&format!("user:{}:{}", username, now_rfc3339ish())),
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
        created_at: now_rfc3339ish(),
    };

    {
        let mut users = state.users.write().await;
        if !users.users.is_empty() {
            return Err(ApiError::conflict(
                "Setup was completed by another request. Sign in instead.",
            ));
        }
        users.users.push(new_user.clone());
        write_users_store(&state.users_file, &users).await?;
    }
    state.setup_token.lock().await.take();

    let token = create_session(&state, &new_user.id).await?;
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
            user: UserPublic::from(&new_user),
        }),
    ))
}

async fn login(
    State(state): State<AppState>,
    ConnectInfo(peer_address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<LoginRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let username = normalize_username(&payload.username);
    let throttle_key = login_throttle_key(&username);
    let ip_throttle_key = login_ip_throttle_key(request_client_ip(peer_address, &headers));
    {
        let mut attempts = state.login_attempts.lock().await;
        let now = unix_now_seconds();
        attempts.retain(|_, throttle| !throttle.is_stale(now));
        if attempts
            .get(&throttle_key)
            .is_some_and(|throttle| throttle.is_locked(now, LOGIN_MAX_FAILURES))
            || attempts
                .get(&ip_throttle_key)
                .is_some_and(|throttle| throttle.is_locked(now, LOGIN_IP_MAX_FAILURES))
        {
            return Err(ApiError::too_many_requests(
                "Too many failed sign-in attempts. Try again in a minute.",
            ));
        }
    }

    if payload.password.chars().count() > MAX_PASSWORD_CHARS {
        let _ = verify_dummy_password_async(&state, "oversized-password".to_string()).await?;
        record_login_failures(&state, [&throttle_key, &ip_throttle_key]).await;
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
        let _ = verify_dummy_password_async(&state, payload.password).await?;
        record_login_failures(&state, [&throttle_key, &ip_throttle_key]).await;
        return Err(ApiError::unauthorized("Invalid username or password."));
    };
    if !verify_password_async(&state, payload.password, user.password_hash.clone()).await? {
        record_login_failures(&state, [&throttle_key, &ip_throttle_key]).await;
        return Err(ApiError::unauthorized("Invalid username or password."));
    }
    let mut attempts = state.login_attempts.lock().await;
    attempts.remove(&throttle_key);
    attempts.remove(&ip_throttle_key);
    drop(attempts);

    let token = create_session(&state, &user.id).await?;
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
            user: UserPublic::from(&user),
        }),
    ))
}

/// Throttle keys come from unauthenticated input, so bound their length
/// (valid usernames are at most 64 characters anyway) to keep hostile logins
/// from bloating the attempts map with megabyte-long keys.
fn login_throttle_key(username: &str) -> String {
    format!(
        "user:{}",
        username
            .to_lowercase()
            .chars()
            .take(LOGIN_THROTTLE_KEY_MAX_CHARS)
            .collect::<String>()
    )
}

fn login_ip_throttle_key(client_ip: IpAddr) -> String {
    format!("ip:{client_ip}")
}

async fn record_login_failures<'a>(
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

async fn create_session(state: &AppState, user_id: &str) -> Result<String, ApiError> {
    let token = generate_session_token();
    let session = Session {
        user_id: user_id.to_string(),
        created_at: unix_now_seconds(),
    };
    let mut sessions = state.sessions.write().await;
    prune_sessions_for_new_session(&mut sessions, user_id, session.created_at);
    sessions.insert(token.clone(), session);
    write_sessions_store(&state.sessions_file, &sessions).await?;
    Ok(token)
}

fn prune_sessions_for_new_session(
    sessions: &mut HashMap<String, Session>,
    user_id: &str,
    now_seconds: u64,
) {
    sessions.retain(|_, session| !session.is_expired(now_seconds));

    let mut user_sessions = sessions
        .iter()
        .filter(|(_, session)| session.user_id == user_id)
        .map(|(token, session)| (token.clone(), session.created_at))
        .collect::<Vec<_>>();
    user_sessions.sort_by_key(|(_, created_at)| *created_at);
    let remove_for_user = user_sessions
        .len()
        .saturating_add(1)
        .saturating_sub(MAX_SESSIONS_PER_USER);
    for (token, _) in user_sessions.into_iter().take(remove_for_user) {
        sessions.remove(&token);
    }

    let mut all_sessions = sessions
        .iter()
        .map(|(token, session)| (token.clone(), session.created_at))
        .collect::<Vec<_>>();
    all_sessions.sort_by_key(|(_, created_at)| *created_at);
    let remove_total = all_sessions
        .len()
        .saturating_add(1)
        .saturating_sub(MAX_SESSIONS_TOTAL);
    for (token, _) in all_sessions.into_iter().take(remove_total) {
        sessions.remove(&token);
    }
}

fn revoke_password_change_sessions(
    sessions: &mut HashMap<String, Session>,
    user_id: &str,
    current_session: Option<&str>,
) {
    sessions.retain(|token, session| {
        session.user_id != user_id || current_session.is_some_and(|current| token == current)
    });
}

async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    if let Some(token) = token_from_headers(&headers) {
        let mut sessions = state.sessions.write().await;
        sessions.remove(&token);
        write_sessions_store(&state.sessions_file, &sessions).await?;
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

async fn me(Extension(auth): Extension<AuthUser>) -> Json<UserPublic> {
    Json(UserPublic {
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
    })
}

async fn update_progress_sharing(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Json(payload): Json<UpdateProgressSharingRequest>,
) -> Result<Json<UserPublic>, ApiError> {
    let mut users = state.users.write().await;
    let user = users
        .users
        .iter_mut()
        .find(|user| user.id == auth.id)
        .ok_or(ApiError::not_found("User not found."))?;
    user.share_progress = payload.share_progress;
    // Absent from older clients, which must not reset what they cannot show.
    if let Some(announce) = payload.announce_finishes {
        user.announce_finishes = announce;
    }
    if let Some(notify) = payload.notify_finishes {
        user.notify_finishes = notify;
    }
    let public = UserPublic::from(&*user);
    write_users_store(&state.users_file, &users).await?;
    Ok(Json(public))
}

/// How many finishes one request returns. The feed is a glance at what has
/// happened lately, not a scrollable history.
const FINISH_FEED_PAGE: usize = 50;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FinishFeedEntry {
    id: String,
    user_id: String,
    username: String,
    book_id: String,
    book_title: String,
    finished_at: String,
    /// False once the viewer has marked the feed read up to here.
    unseen: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FinishFeedResponse {
    entries: Vec<FinishFeedEntry>,
    unseen_count: usize,
    /// What to send back to `/seen` to clear the badge. Null on an empty feed.
    latest_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkFinishFeedSeenRequest {
    /// The id the feed reported as `latestId`. Marking by id rather than
    /// "clear everything" means a finish that lands mid-read stays unseen.
    event_id: String,
}

async fn finish_feed(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<FinishFeedResponse>, ApiError> {
    // Reciprocal, exactly like the shelf's shared progress: someone who has
    // withdrawn their own activity does not read anyone else's.
    if !auth.share_progress || !auth.notify_finishes {
        return Ok(Json(FinishFeedResponse {
            entries: Vec::new(),
            unseen_count: 0,
            latest_id: None,
        }));
    }

    let announcers: HashMap<String, String> = {
        let users = state.users.read().await;
        users
            .users
            .iter()
            .filter(|user| user.share_progress && user.announce_finishes && user.id != auth.id)
            .map(|user| (user.id.clone(), user.username.clone()))
            .collect()
    };

    let store = state.finish_events.read().await;
    let seen_id = store.seen.get(&auth.id).cloned();
    // Everything at or before the mark has been read. An id no longer in the
    // list — trimmed away — leaves nothing seen, which is the safe direction:
    // the viewer sees a finish twice rather than never.
    let seen_index = seen_id
        .as_ref()
        .and_then(|id| store.events.iter().position(|event| &event.id == id));

    let library = state.library.read().await;
    let mut entries: Vec<FinishFeedEntry> = store
        .events
        .iter()
        .enumerate()
        .filter_map(|(index, event)| {
            // Resolved live, so a listener who turns sharing or announcements
            // off afterwards drops out of everyone's feed retroactively.
            let username = announcers.get(&event.user_id)?;
            // A book the viewer cannot open should not be named to them.
            if !can_access_book(&auth, &event.book_id) {
                return None;
            }
            let title = library
                .books
                .iter()
                .find(|book| book.id == event.book_id)
                .map(|book| book.title.clone())
                .unwrap_or_else(|| event.book_title.clone());
            Some(FinishFeedEntry {
                id: event.id.clone(),
                user_id: event.user_id.clone(),
                username: username.clone(),
                book_id: event.book_id.clone(),
                book_title: title,
                finished_at: event.finished_at.clone(),
                unseen: seen_index.is_none_or(|seen| index > seen),
            })
        })
        .collect();

    // Newest first, then cut: the feed opens on what just happened.
    entries.reverse();
    entries.truncate(FINISH_FEED_PAGE);
    let unseen_count = entries.iter().filter(|entry| entry.unseen).count();
    let latest_id = entries.first().map(|entry| entry.id.clone());

    Ok(Json(FinishFeedResponse {
        entries,
        unseen_count,
        latest_id,
    }))
}

async fn mark_finish_feed_seen(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Json(payload): Json<MarkFinishFeedSeenRequest>,
) -> Result<Json<FinishFeedResponse>, ApiError> {
    {
        // Held across the write for the same reason as record_finish_event:
        // a concurrent mark from another listener must not be able to persist
        // a snapshot that predates this one.
        let mut store = state.finish_events.write().await;
        // Only ever moves forward. A stale request from a client that had an
        // older page in hand must not re-raise a badge the viewer cleared.
        let incoming = store
            .events
            .iter()
            .position(|event| event.id == payload.event_id);
        let current = store
            .seen
            .get(&auth.id)
            .and_then(|id| store.events.iter().position(|event| &event.id == id));
        match (incoming, current) {
            (Some(next), Some(previous)) if next <= previous => {}
            (Some(_), _) => {
                store.seen.insert(auth.id.clone(), payload.event_id.clone());
            }
            (None, _) => {}
        }
        write_finish_events(&state.finish_events_file, &store).await?;
    }
    finish_feed(State(state), Extension(auth)).await
}

fn require_admin(auth: &AuthUser) -> Result<(), ApiError> {
    if auth.is_admin {
        Ok(())
    } else {
        Err(ApiError::forbidden("Administrator access is required."))
    }
}

fn require_owner(auth: &AuthUser) -> Result<(), ApiError> {
    if auth.is_owner {
        Ok(())
    } else {
        Err(ApiError::forbidden("Owner access is required."))
    }
}

fn require_libation_approver(auth: &AuthUser) -> Result<(), ApiError> {
    if auth.can_approve_libation_requests {
        Ok(())
    } else {
        Err(ApiError::forbidden(
            "Permission to approve Libation requests is required.",
        ))
    }
}

fn can_access_book(auth: &AuthUser, book_id: &str) -> bool {
    auth.is_admin
        || auth
            .allowed_book_ids
            .as_ref()
            .is_none_or(|book_ids| book_ids.iter().any(|candidate| candidate == book_id))
}

fn require_book_access(auth: &AuthUser, book_id: &str) -> Result<(), ApiError> {
    if can_access_book(auth, book_id) {
        Ok(())
    } else {
        // Keep restricted books indistinguishable from books that are not in
        // the library, including for direct media and download URLs.
        Err(ApiError::not_found("Book not found"))
    }
}

async fn list_users(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<Vec<UserPublic>>, ApiError> {
    require_admin(&auth)?;
    let users = state.users.read().await;
    Ok(Json(users.users.iter().map(UserPublic::from).collect()))
}

async fn create_user(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Json(payload): Json<CreateUserRequest>,
) -> Result<Json<UserPublic>, ApiError> {
    require_admin(&auth)?;
    let is_owner = payload.is_owner;
    let is_admin = payload.is_admin || is_owner;
    if is_admin && !auth.is_owner {
        return Err(ApiError::forbidden(
            "Only an owner can create an administrator or owner account.",
        ));
    }
    let username = normalize_username(&payload.username);
    validate_username(&username)?;
    validate_password(&payload.password)?;

    let mut users = state.users.write().await;
    if users
        .users
        .iter()
        .any(|user| user.username.eq_ignore_ascii_case(&username))
    {
        return Err(ApiError::bad_request("That username is already taken."));
    }

    let new_user = User {
        id: stable_id(&format!("user:{}:{}", username, now_rfc3339ish())),
        username,
        password_hash: hash_password_async(&state, payload.password.clone()).await?,
        is_admin,
        is_owner,
        can_approve_libation_requests: is_owner
            || (is_admin && payload.can_approve_libation_requests),
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
        created_at: now_rfc3339ish(),
    };
    users.users.push(new_user.clone());
    write_users_store(&state.users_file, &users).await?;
    Ok(Json(UserPublic::from(&new_user)))
}

async fn delete_user(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(user_id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_admin(&auth)?;
    if user_id == auth.id {
        return Err(ApiError::bad_request(
            "You cannot delete your own account while signed in.",
        ));
    }

    let mut users = state.users.write().await;
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
    write_users_store(&state.users_file, &users).await?;
    drop(users);

    let mut sessions = state.sessions.write().await;
    sessions.retain(|_, session| session.user_id != user_id);
    write_sessions_store(&state.sessions_file, &sessions).await?;
    drop(sessions);

    let _progress_guard = state.progress_write_lock.lock().await;
    let mut progress = read_progress(&state.progress_file).await?;
    let prefix = format!("user:{user_id}:");
    progress.retain(|key, _| !key.starts_with(&prefix));
    write_progress(&state.progress_file, &progress).await?;
    drop(_progress_guard);

    let _settings_guard = state.book_settings_write_lock.lock().await;
    let mut book_settings = read_book_settings(&state.book_settings_file).await?;
    book_settings.retain(|key, _| !key.starts_with(&prefix));
    write_book_settings(&state.book_settings_file, &book_settings).await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn change_password(
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

    let mut users = state.users.write().await;
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

    if changing_self {
        let current = payload.current_password.unwrap_or_default();
        if !verify_password_async(&state, current, user.password_hash.clone()).await? {
            return Err(ApiError::unauthorized("Current password is incorrect."));
        }
    }

    user.password_hash = hash_password_async(&state, payload.new_password).await?;
    let target_id = user.id.clone();
    write_users_store(&state.users_file, &users).await?;
    drop(users);

    let mut sessions = state.sessions.write().await;
    revoke_password_change_sessions(
        &mut sessions,
        &target_id,
        changing_self.then_some(current_session.0.as_str()),
    );
    write_sessions_store(&state.sessions_file, &sessions).await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn update_book_access(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(user_id): Path<String>,
    Json(payload): Json<UpdateBookAccessRequest>,
) -> Result<Json<UserPublic>, ApiError> {
    require_admin(&auth)?;

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

    let mut users = state.users.write().await;
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
    let public = UserPublic::from(&*user);
    write_users_store(&state.users_file, &users).await?;
    Ok(Json(public))
}

async fn update_libation_access(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(user_id): Path<String>,
    Json(payload): Json<UpdateLibationAccessRequest>,
) -> Result<Json<UserPublic>, ApiError> {
    require_admin(&auth)?;
    let mut users = state.users.write().await;
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
    let public = UserPublic::from(&*user);
    write_users_store(&state.users_file, &users).await?;
    Ok(Json(public))
}

async fn update_user_role(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(user_id): Path<String>,
    Json(payload): Json<UpdateUserRoleRequest>,
) -> Result<Json<UserPublic>, ApiError> {
    require_owner(&auth)?;
    let mut users = state.users.write().await;
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
    }
    let public = UserPublic::from(&*user);
    write_users_store(&state.users_file, &users).await?;
    Ok(Json(public))
}

async fn update_libation_approval(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(user_id): Path<String>,
    Json(payload): Json<UpdateLibationApprovalRequest>,
) -> Result<Json<UserPublic>, ApiError> {
    require_owner(&auth)?;
    let mut users = state.users.write().await;
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
    let public = UserPublic::from(&*user);
    write_users_store(&state.users_file, &users).await?;
    Ok(Json(public))
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn bad_gateway(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            message: message.into(),
        }
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: message.into(),
        }
    }

    fn payload_too_large(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
        }
    }

    fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            message: message.into(),
        }
    }

    fn too_many_requests(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let message = if self.status == StatusCode::INTERNAL_SERVER_ERROR {
            tracing::error!(error = %self.message, "request failed with an internal error");
            "Internal server error.".to_string()
        } else {
            self.message
        };
        (
            self.status,
            [(CONTENT_TYPE, HeaderValue::from_static("application/json"))],
            Json(serde_json::json!({ "message": message })),
        )
            .into_response()
    }
}

impl From<io::Error> for ApiError {
    fn from(error: io::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: error.to_string(),
        }
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(error: serde_json::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: error.to_string(),
        }
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: error.to_string(),
        }
    }
}

impl From<axum::http::Error> for ApiError {
    fn from(error: axum::http::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: error.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AuthUser, HeaderMap, HeaderValue, LoginThrottle, Session, StatusCode, bytes_etag,
        can_access_book, clamped_track_position, clean_imported_title, composer_narrator,
        if_none_match_matches, is_supported_audio_file, libation_cover_art_url, media_content_type,
        normalize_asin, normalize_guessed_asin, parse_origin_list, parse_range,
        progress_write_is_stale, progress_write_is_suspect_reset,
        progress_write_is_unintentional_regression, sanitize_filename, walk_audio_files,
    };

    #[test]
    fn a_composer_names_the_narrator_only_when_another_tag_names_the_author() {
        use lofty::tag::{ItemKey, Tag, TagType};

        let mut tag = Tag::new(TagType::Mp4Ilst);
        tag.insert_text(ItemKey::Composer, "Rob Inglis".to_string());

        assert_eq!(
            composer_narrator(&tag, Some("J. R. R. Tolkien")),
            Some("Rob Inglis".to_string())
        );
        // With no other credit the composer is the author, so it is not a
        // narrator as well.
        assert_eq!(composer_narrator(&tag, None), None);
        assert_eq!(composer_narrator(&tag, Some("Rob Inglis")), None);
        assert_eq!(
            composer_narrator(&Tag::new(TagType::Mp4Ilst), Some("Anyone")),
            None
        );
    }

    #[test]
    fn near_zero_writes_over_real_progress_are_suspect_resets() {
        // A client that failed to restore pushes ~0 over hours of progress.
        assert!(progress_write_is_suspect_reset(7200.0, 0.0, false));
        assert!(progress_write_is_suspect_reset(7200.0, 45.0, false));
        // A deliberate restart is flagged by the client and accepted.
        assert!(!progress_write_is_suspect_reset(7200.0, 0.0, true));
        // Ordinary rewinds past the near-zero band are not resets.
        assert!(!progress_write_is_suspect_reset(7200.0, 3600.0, false));
        // A book that has barely started cannot lose substantial progress.
        assert!(!progress_write_is_suspect_reset(90.0, 0.0, false));
    }

    #[test]
    fn late_automatic_checkpoints_cannot_rollback_completion() {
        assert!(progress_write_is_unintentional_regression(
            36_000.0, 35_990.0, false
        ));
        assert!(!progress_write_is_unintentional_regression(
            36_000.0, 35_990.0, true
        ));
        // Sub-second decoder jitter around a pause is harmless.
        assert!(!progress_write_is_unintentional_regression(
            36_000.0, 35_999.25, false
        ));
    }

    #[test]
    fn fuzz_automatic_progress_never_moves_materially_backward() {
        let mut state = 0x9e37_79b9_7f4a_7c15_u64;
        for _ in 0..100_000 {
            // Deterministic property-style stress without another test-only
            // dependency. Cover positions across very short and very long
            // audiobooks plus arbitrary request reordering gaps.
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let previous = (state % 2_000_000) as f64 / 10.0;
            state = state.rotate_left(17) ^ 0xa076_1d64_78bd_642f;
            let regression = 2.01 + (state % 500_000) as f64 / 100.0;
            let incoming = (previous - regression).max(0.0);
            if previous - incoming > 2.0 {
                assert!(progress_write_is_unintentional_regression(
                    previous, incoming, false
                ));
                assert!(!progress_write_is_unintentional_regression(
                    previous, incoming, true
                ));
            }
        }
    }

    #[test]
    fn fuzz_track_positions_stay_inside_known_media() {
        let mut state = 0xd1b5_4a32_d192_ed03_u64;
        for _ in 0..100_000 {
            state ^= state >> 12;
            state ^= state << 25;
            state ^= state >> 27;
            let duration = 0.01 + (state % 1_000_000) as f64 / 10.0;
            state = state.wrapping_mul(2_685_821_657_736_338_717);
            let reported = (state % 4_000_000) as f64 / 10.0 - 100_000.0;
            let clamped = clamped_track_position(reported, Some(duration));
            assert!(clamped >= 0.0);
            assert!(clamped <= duration);
        }
    }

    fn track_with_duration(id: &str, index: usize, duration_seconds: Option<f64>) -> super::Track {
        super::Track {
            id: id.to_string(),
            title: id.to_string(),
            file_name: format!("{id}.mp3"),
            index,
            duration_seconds,
            stream_url: String::new(),
            chapters: Vec::new(),
            metadata: Default::default(),
        }
    }

    fn book_with_tracks(duration_seconds: Option<f64>, tracks: Vec<super::Track>) -> super::Book {
        super::Book {
            id: "book".to_string(),
            title: "Book".to_string(),
            author: None,
            narrator: None,
            duration_seconds,
            track_count: tracks.len(),
            cover_art_url: None,
            description: None,
            genres: Vec::new(),
            published_date: None,
            asin: None,
            reading_file: None,
            sync_file: None,
            chapters: Vec::new(),
            metadata: Default::default(),
            tracks,
            progress: None,
            shared_progress: Vec::new(),
            volume_gain: super::BOOK_VOLUME_GAIN_DEFAULT,
        }
    }

    /// A gain arrives from whatever client the listener is holding, so the
    /// server is the only place that can keep a hand-edited or buggy value from
    /// becoming an eardrum-splitting multiplier on every other device.
    #[test]
    fn a_book_volume_gain_is_clamped_to_the_supported_range() {
        assert_eq!(super::clamp_book_volume_gain(2.5), 2.5);
        assert_eq!(
            super::clamp_book_volume_gain(50.0),
            super::BOOK_VOLUME_GAIN_MAX
        );
        assert_eq!(
            super::clamp_book_volume_gain(-3.0),
            super::BOOK_VOLUME_GAIN_MIN
        );
        assert_eq!(
            super::clamp_book_volume_gain(f64::NAN),
            super::BOOK_VOLUME_GAIN_DEFAULT
        );
    }

    /// A settings file is read on the path that serves the whole library, so a
    /// row missing its gain must degrade to unity instead of failing the read.
    #[test]
    fn a_settings_row_without_a_gain_still_parses() {
        let parsed: std::collections::HashMap<String, super::BookSettings> =
            serde_json::from_str(r#"{"user:a:book:b":{},"user:a:book:c":{"volumeGain":2.0}}"#)
                .expect("a row missing its gain must not fail the whole file");
        assert_eq!(
            super::stored_volume_gain(&parsed, "user:a:book:b"),
            super::BOOK_VOLUME_GAIN_DEFAULT
        );
        assert_eq!(super::stored_volume_gain(&parsed, "user:a:book:c"), 2.0);
    }

    /// Books nobody has tuned must read back as unity rather than as silence,
    /// and a stored value that predates a narrowed range must still be safe.
    #[test]
    fn an_untuned_book_reads_back_at_unity_gain() {
        let mut settings = std::collections::HashMap::new();
        settings.insert(
            "user:reader:book:loud".to_string(),
            super::BookSettings { volume_gain: 99.0 },
        );
        settings.insert(
            "user:reader:book:quiet".to_string(),
            super::BookSettings { volume_gain: 2.0 },
        );

        assert_eq!(
            super::stored_volume_gain(&settings, "user:reader:book:untouched"),
            super::BOOK_VOLUME_GAIN_DEFAULT
        );
        assert_eq!(
            super::stored_volume_gain(&settings, "user:reader:book:quiet"),
            2.0
        );
        assert_eq!(
            super::stored_volume_gain(&settings, "user:reader:book:loud"),
            super::BOOK_VOLUME_GAIN_MAX
        );
    }

    /// lofty reports Duration::ZERO for media it cannot measure. Treating that
    /// as a known zero-length book clamps the stored position to 0 and reports
    /// the book as not started — and the library summary is what a reinstalled
    /// client resumes from when /progress is unavailable.
    #[test]
    fn an_unmeasurable_book_does_not_report_its_position_as_zero() {
        let book = book_with_tracks(
            Some(0.0),
            vec![
                track_with_duration("t1", 0, Some(0.0)),
                track_with_duration("t2", 1, Some(0.0)),
            ],
        );
        let stored = super::Progress {
            book_id: String::new(),
            track_id: "t2".to_string(),
            position_seconds: 1_800.0,
            book_position_seconds: 7_200.0,
            duration_seconds: None,
            updated_at: "1785801600".to_string(),
            finished_override: None,
        };

        let summary = super::summarize_book_progress(&book, &stored);
        assert_eq!(summary.book_position_seconds, 7_200.0);
        assert_eq!(summary.duration_seconds, None);
        assert!(matches!(
            summary.status,
            super::BookProgressStatus::InProgress
        ));
    }

    #[test]
    fn a_partial_duration_cannot_falsely_finish_a_book() {
        let book = book_with_tracks(
            None,
            vec![
                track_with_duration("t1", 0, Some(3_600.0)),
                track_with_duration("t2", 1, None),
            ],
        );
        let stored = super::Progress {
            book_id: String::new(),
            track_id: "t2".to_string(),
            position_seconds: 600.0,
            book_position_seconds: 4_200.0,
            duration_seconds: None,
            updated_at: "1785801600000".to_string(),
            finished_override: None,
        };

        let summary = super::summarize_book_progress(&book, &stored);
        assert_eq!(summary.book_position_seconds, 4_200.0);
        assert_eq!(summary.duration_seconds, None);
        assert!(matches!(
            summary.status,
            super::BookProgressStatus::InProgress
        ));
    }

    /// With every duration unknown the server cannot derive an offset, so the
    /// client's reported whole-book position must be trusted — otherwise every
    /// track collapses onto the same offset and advancing looks like a
    /// regression the write guard then rejects.
    #[test]
    fn unknown_durations_keep_each_track_at_a_distinct_whole_book_offset() {
        let book = book_with_tracks(
            None,
            vec![
                track_with_duration("t1", 0, None),
                track_with_duration("t2", 1, None),
                track_with_duration("t3", 2, None),
            ],
        );
        let third = &book.tracks[2];

        let derived = super::validated_book_position_seconds(&book, third, 30.0, Some(7_230.0));
        assert_eq!(derived, 7_230.0);
        // And that position must not then read as a regression from track one.
        assert!(!super::progress_write_is_unintentional_regression(
            3_600.0, derived, false
        ));
    }

    #[test]
    fn fuzz_accepted_progress_revisions_are_strictly_monotonic() {
        let mut state = 0x2545_f491_4f6c_dd1d_u64;
        let mut previous = super::Progress {
            book_id: String::new(),
            track_id: String::new(),
            position_seconds: 0.0,
            book_position_seconds: 0.0,
            duration_seconds: None,
            updated_at: "1785801600".to_string(),
            finished_override: None,
        };
        for _ in 0..200_000 {
            state ^= state >> 12;
            state ^= state << 25;
            state ^= state >> 27;
            let now = 1_785_801_600_000 + state % 10_000;
            let next = super::next_progress_timestamp(Some(&previous), now);
            assert!(
                super::progress_timestamp_millis(&next)
                    > super::progress_timestamp_millis(&previous.updated_at)
            );
            previous.updated_at = next;
        }
    }

    #[test]
    fn stale_progress_writes_are_detected_with_clock_slack() {
        // A replayed checkpoint from hours before the stored copy is stale.
        assert!(progress_write_is_stale("1753200000", 1753100000.0));
        // Ordinary clock skew between devices must not block saves.
        assert!(!progress_write_is_stale("1753200000", 1753199800.0));
        // Newer writes always pass.
        assert!(!progress_write_is_stale("1753200000", 1753200050.0));
        // Unparsable stored stamps never block a write.
        assert!(!progress_write_is_stale("2025-07-11T01:00:00.000Z", 0.0));
    }

    #[test]
    fn book_access_defaults_to_full_library_and_honors_restrictions() {
        let unrestricted = AuthUser {
            id: "reader".to_string(),
            username: "reader".to_string(),
            is_admin: false,
            is_owner: false,
            can_approve_libation_requests: false,
            allowed_book_ids: None,
            libation_access: super::LibationAccess::Approval,
            share_progress: true,
            announce_finishes: true,
            notify_finishes: true,
        };
        assert!(can_access_book(&unrestricted, "book-a"));

        let restricted = AuthUser {
            allowed_book_ids: Some(vec!["book-a".to_string()]),
            ..unrestricted.clone()
        };
        assert!(can_access_book(&restricted, "book-a"));
        assert!(!can_access_book(&restricted, "book-b"));

        let admin = AuthUser {
            is_admin: true,
            allowed_book_ids: Some(Vec::new()),
            ..unrestricted
        };
        assert!(can_access_book(&admin, "book-b"));
    }

    #[test]
    fn legacy_readers_default_to_per_download_libation_approval() {
        let user: super::User = serde_json::from_value(serde_json::json!({
            "id": "reader",
            "username": "reader",
            "passwordHash": "unused",
            "isAdmin": false,
            "allowedBookIds": null,
            "createdAt": "0"
        }))
        .unwrap();
        assert_eq!(user.libation_access, super::LibationAccess::Approval);
        // Accounts that predate the setting share by default, matching new ones.
        assert!(user.share_progress);
    }

    #[cfg(test)]
    fn sharing_user(id: &str, share_progress: bool) -> super::User {
        super::User {
            id: id.to_string(),
            username: id.to_string(),
            password_hash: "unused".to_string(),
            is_admin: false,
            is_owner: false,
            can_approve_libation_requests: false,
            allowed_book_ids: None,
            libation_access: super::LibationAccess::Approval,
            share_progress,
            announce_finishes: true,
            notify_finishes: true,
            created_at: "0".to_string(),
        }
    }

    #[cfg(test)]
    fn viewer(id: &str, share_progress: bool) -> AuthUser {
        AuthUser {
            id: id.to_string(),
            username: id.to_string(),
            is_admin: false,
            is_owner: false,
            can_approve_libation_requests: false,
            allowed_book_ids: None,
            libation_access: super::LibationAccess::Approval,
            share_progress,
            announce_finishes: true,
            notify_finishes: true,
        }
    }

    fn finish_summary(status: super::BookProgressStatus) -> super::BookProgress {
        super::BookProgress {
            status,
            finished_override: None,
            book_position_seconds: 0.0,
            duration_seconds: Some(3600.0),
            remaining_seconds: Some(0.0),
            percent_complete: Some(100.0),
            updated_at: "0".to_string(),
        }
    }

    #[test]
    fn only_the_crossing_into_finished_announces() {
        use super::BookProgressStatus::*;
        let finished = finish_summary(Finished);
        let reading = finish_summary(InProgress);
        let unopened = finish_summary(NotStarted);

        assert!(super::crossed_into_finished(Some(&reading), &finished));
        assert!(super::crossed_into_finished(Some(&unopened), &finished));
        // A book with no progress row at all being written as finished.
        assert!(super::crossed_into_finished(None, &finished));
    }

    #[test]
    fn a_book_already_finished_does_not_announce_again() {
        use super::BookProgressStatus::*;
        let finished = finish_summary(Finished);
        // Every heartbeat while parked at the end re-saves the same status.
        assert!(!super::crossed_into_finished(
            Some(&finish_summary(Finished)),
            &finished
        ));
        // And nothing announces while the book is merely being read.
        assert!(!super::crossed_into_finished(
            Some(&finish_summary(InProgress)),
            &finish_summary(InProgress)
        ));
        assert!(!super::crossed_into_finished(
            None,
            &finish_summary(NotStarted)
        ));
    }

    #[test]
    fn marking_a_book_unfinished_then_finishing_it_announces_once_more() {
        use super::BookProgressStatus::*;
        // A real second reading, not a duplicate: the listener deliberately
        // reset the book and got to the end again.
        assert!(super::crossed_into_finished(
            Some(&finish_summary(NotStarted)),
            &finish_summary(Finished)
        ));
    }

    #[test]
    fn progress_sharing_is_reciprocal_and_excludes_the_viewer() {
        let users = vec![
            sharing_user("me", true),
            sharing_user("sharer", true),
            sharing_user("private", false),
        ];

        let visible = super::visible_sharers(&users, &viewer("me", true));
        assert_eq!(
            visible,
            vec![("sharer".to_string(), "sharer".to_string())],
            "a sharing viewer sees other sharers, never themselves or opted-out users"
        );

        assert!(
            super::visible_sharers(&users, &viewer("private", false)).is_empty(),
            "opting out of sharing also hides everyone else"
        );
    }

    #[test]
    fn shared_progress_skips_untouched_books_and_leads_with_finishers() {
        let book = book_with_tracks(
            Some(1000.0),
            vec![track_with_duration("track", 0, Some(1000.0))],
        );

        let stored = |position: f64| super::Progress {
            book_id: "book".to_string(),
            track_id: "track".to_string(),
            position_seconds: position,
            book_position_seconds: position,
            duration_seconds: Some(1000.0),
            updated_at: "1".to_string(),
            finished_override: None,
        };

        let mut saved = std::collections::HashMap::new();
        saved.insert(super::progress_key("halfway", "book"), stored(500.0));
        saved.insert(super::progress_key("done", "book"), stored(1000.0));
        // A row exists as soon as a book is opened; it must not read as reading.
        saved.insert(super::progress_key("opened", "book"), stored(0.0));

        let sharers = vec![
            ("halfway".to_string(), "Halfway".to_string()),
            ("opened".to_string(), "Opened".to_string()),
            ("done".to_string(), "Done".to_string()),
        ];
        let shared = super::collect_shared_progress(&book, &saved, &sharers);

        let names: Vec<&str> = shared.iter().map(|entry| entry.username.as_str()).collect();
        assert_eq!(names, vec!["Done", "Halfway"]);
        assert_eq!(shared[0].status, super::BookProgressStatus::Finished);
        assert_eq!(shared[1].status, super::BookProgressStatus::InProgress);
        assert_eq!(shared[1].percent_complete, Some(50.0));
    }

    #[test]
    fn legacy_permissions_promote_the_first_admin_to_owner() {
        let mut store: super::UsersStore = serde_json::from_value(serde_json::json!({
            "users": [
                { "id": "first", "username": "first", "passwordHash": "unused", "isAdmin": true, "createdAt": "0" },
                { "id": "second", "username": "second", "passwordHash": "unused", "isAdmin": true, "createdAt": "1" }
            ]
        }))
        .unwrap();

        assert!(super::migrate_users_permissions(&mut store));
        assert_eq!(store.permissions_version, 1);
        assert!(store.users[0].is_owner);
        assert!(!store.users[1].is_owner);
        assert!(
            store
                .users
                .iter()
                .all(|user| user.can_approve_libation_requests)
        );
        assert!(
            store
                .users
                .iter()
                .all(|user| user.libation_access == super::LibationAccess::Direct)
        );
        assert!(!super::migrate_users_permissions(&mut store));
    }

    #[test]
    fn interrupted_libation_approvals_return_to_pending() {
        let mut store: super::LibationRequestStore = serde_json::from_value(serde_json::json!({
            "requests": [
                {
                    "id": "request-1",
                    "userId": "reader",
                    "username": "reader",
                    "asin": "B000TEST10",
                    "title": "Interrupted",
                    "status": "approved",
                    "requestedAt": "1",
                    "decidedAt": "2",
                    "decidedBy": "owner",
                    "jobId": "job-1"
                },
                {
                    "id": "request-2",
                    "userId": "reader",
                    "username": "reader",
                    "asin": "B000TEST11",
                    "title": "Finished",
                    "status": "completed",
                    "requestedAt": "1",
                    "decidedAt": "2",
                    "decidedBy": "owner",
                    "jobId": "job-2"
                }
            ]
        }))
        .unwrap();

        assert!(super::recover_interrupted_libation_requests(&mut store));
        assert_eq!(store.requests[0].status, "pending");
        assert!(store.requests[0].decided_at.is_none());
        assert!(store.requests[0].decided_by.is_none());
        assert!(store.requests[0].job_id.is_none());
        assert_eq!(store.requests[1].status, "completed");
        assert!(!super::recover_interrupted_libation_requests(&mut store));
    }

    #[test]
    fn libation_cover_urls_accept_amazon_picture_ids_only() {
        assert_eq!(
            libation_cover_art_url(Some("51Ab+cD._SX50_")),
            Some("/api/libation/covers/51Ab+cD._SX50_".to_string())
        );
        assert_eq!(libation_cover_art_url(Some("../Settings.json")), None);
        assert_eq!(
            libation_cover_art_url(Some("https://example.com/cover")),
            None
        );
        assert_eq!(libation_cover_art_url(None), None);
        assert_eq!(
            super::libation_cover_art_url_from_ids(
                Some("https://example.com/invalid-large-cover"),
                Some("51FallbackCover")
            ),
            Some("/api/libation/covers/51FallbackCover".to_string())
        );
    }

    #[test]
    fn upload_names_cannot_escape_the_library_folder() {
        assert_eq!(
            sanitize_filename("../../Dune: Part One"),
            "_.._Dune_ Part One"
        );
        assert_eq!(sanitize_filename("..."), "audiobook");
        assert!(!sanitize_filename("../book").contains('/'));
        assert!(!sanitize_filename("..\\book").contains('\\'));
    }

    #[test]
    fn audiobook_upload_accepts_only_scannable_audio_extensions() {
        assert!(is_supported_audio_file(super::FsPath::new("Book.M4B")));
        assert!(is_supported_audio_file(super::FsPath::new("01.mp3")));
        assert!(!is_supported_audio_file(super::FsPath::new("book.epub")));
        assert!(!is_supported_audio_file(super::FsPath::new("payload.exe")));
    }

    #[test]
    fn library_scan_ignores_incomplete_upload_staging_folders() {
        let root = tempfile::tempdir().unwrap();
        let complete = root.path().join("Complete Book");
        let staging = root
            .path()
            .join(format!("{}test", super::UPLOAD_STAGING_PREFIX));
        std::fs::create_dir_all(&complete).unwrap();
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(complete.join("book.m4b"), b"complete").unwrap();
        std::fs::write(staging.join("partial.m4b"), b"partial").unwrap();

        let files = walk_audio_files(root.path());
        assert_eq!(files, vec![complete.join("book.m4b")]);
    }

    #[test]
    fn library_scan_ignores_faststart_work_files() {
        let root = tempfile::tempdir().unwrap();
        let book = root.path().join("Book");
        std::fs::create_dir_all(&book).unwrap();
        std::fs::write(book.join("book.m4b"), b"real").unwrap();
        // A conversion in flight writes these beside the book, and the
        // temporary remux deliberately carries the book's own extension.
        std::fs::write(
            book.join(format!("{}abcd1234.m4b", super::faststart::TEMP_PREFIX)),
            b"half written",
        )
        .unwrap();
        std::fs::write(
            book.join(format!("{}backup-abcd1234", super::faststart::TEMP_PREFIX)),
            b"backup link",
        )
        .unwrap();

        let files = walk_audio_files(root.path());
        assert_eq!(files, vec![book.join("book.m4b")]);
    }

    /// An M4B keeps its artwork in the `covr` atom, which has no `ItemKey` of
    /// its own. lofty 0.25.0 dropped every unmapped atom while flattening the
    /// iTunes tag, so covers silently disappeared from the whole library on a
    /// rescan while titles and durations still read fine — the only visible
    /// artwork left was whatever a device had already downloaded.
    #[test]
    fn m4b_cover_art_survives_the_tag_read() {
        let Some(tools) = super::faststart::discover_tools(None, None) else {
            eprintln!("skipping: ffmpeg is not installed");
            return;
        };
        let root = tempfile::tempdir().unwrap();
        let book = root.path().join("book.m4b");
        let created = std::process::Command::new(&tools.ffmpeg)
            .args([
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=3",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=64x64:d=1",
                "-map",
                "0:a",
                "-map",
                "1:v",
                "-c:a",
                "aac",
                "-c:v",
                "mjpeg",
                "-frames:v",
                "1",
                "-disposition:v",
                "attached_pic",
            ])
            .arg(&book)
            .status()
            .expect("ffmpeg should run");
        assert!(created.success());

        let cover = super::read_track_metadata(&book)
            .cover_art
            .expect("the embedded cover should be read back");
        assert_eq!(cover.mime_type, "image/jpeg");
        assert!(!cover.data.is_empty());
    }

    #[test]
    fn clean_imported_title_strips_trailing_audible_asin() {
        assert_eq!(clean_imported_title("Dune [B002V1OF70]"), "Dune");
        assert_eq!(clean_imported_title("Dune (B002V1OF70)"), "Dune");
        assert_eq!(clean_imported_title("Dune - [B002V1OF70]"), "Dune");
    }

    #[test]
    fn clean_imported_title_keeps_non_asin_brackets() {
        assert_eq!(
            clean_imported_title("Dune [Unabridged]"),
            "Dune [Unabridged]"
        );
        assert_eq!(clean_imported_title("[B002V1OF70]"), "[B002V1OF70]");
    }

    #[test]
    fn libation_sidecar_supplies_series_and_catalog_metadata() {
        let sidecar = super::parse_libation_sidecar(
            r#"{
                "product": {
                    "title": "The Way of Kings",
                    "asin": "B003ZWFO7E",
                    "authors": [{ "name": "Brandon Sanderson" }],
                    "narrators": [{ "name": "Michael Kramer" }, { "name": "Kate Reading" }],
                    "publisher_summary": "A storm is coming.",
                    "publisher_name": "Macmillan Audio",
                    "category_ladders": [{ "ladder": [{ "name": "Fantasy" }]}],
                    "series": [{ "title": "The Stormlight Archive", "sequence": "1" }]
                }
            }"#,
        )
        .expect("valid Libation sidecar");

        assert_eq!(sidecar.title.as_deref(), Some("The Way of Kings"));
        assert_eq!(sidecar.asin.as_deref(), Some("B003ZWFO7E"));
        assert_eq!(sidecar.author.as_deref(), Some("Brandon Sanderson"));
        assert_eq!(
            sidecar.narrator.as_deref(),
            Some("Michael Kramer, Kate Reading")
        );
        assert_eq!(
            sidecar.summary.series.as_deref(),
            Some("The Stormlight Archive")
        );
        assert_eq!(sidecar.summary.series_position.as_deref(), Some("1"));
        assert_eq!(sidecar.summary.genres, vec!["Fantasy"]);
    }

    #[test]
    fn libation_sidecar_is_only_claimed_by_the_book_it_names() {
        let root = tempfile::tempdir().expect("temp dir");
        let sidecar = |asin: &str| {
            format!(r#"{{ "product": {{ "title": "Sidecar {asin}", "asin": "{asin}" }} }}"#)
        };

        // Two loose single-file books sharing `library_root` with one sidecar.
        std::fs::write(root.path().join("Other [B003ZWFO7E].m4b"), b"").unwrap();
        std::fs::write(
            root.path().join("Other [B003ZWFO7E].metadata.json"),
            sidecar("B003ZWFO7E"),
        )
        .unwrap();
        let unrelated = root.path().join("Unrelated.m4b");
        std::fs::write(&unrelated, b"").unwrap();

        assert!(
            super::libation_sidecar_for_group(&unrelated, std::slice::from_ref(&unrelated))
                .is_none(),
            "a loose book must not adopt a neighbour's Libation record"
        );

        let named = root.path().join("Other [B003ZWFO7E].m4b");
        assert_eq!(
            super::libation_sidecar_for_group(&named, std::slice::from_ref(&named))
                .and_then(|found| found.asin),
            Some("B003ZWFO7E".to_string())
        );

        // A folder book still adopts the single sidecar beside its tracks even
        // when neither name carries an ASIN.
        let folder = root.path().join("Renamed Book");
        std::fs::create_dir(&folder).unwrap();
        let track = folder.join("part 1.m4b");
        std::fs::write(&track, b"").unwrap();
        std::fs::write(folder.join("audible.metadata.json"), sidecar("B002V1OF70")).unwrap();
        assert_eq!(
            super::libation_sidecar_for_group(&folder, std::slice::from_ref(&track))
                .and_then(|found| found.asin),
            Some("B002V1OF70".to_string())
        );
    }

    #[test]
    fn mpeg4_audio_is_served_as_the_registered_container_type() {
        for name in ["book.m4b", "book.m4a", "book.mp4", "BOOK.M4B"] {
            assert_eq!(
                media_content_type(super::FsPath::new(name)),
                "audio/mp4",
                "{name} should not be served as an unregistered or video type"
            );
        }
    }

    #[test]
    fn other_media_extensions_keep_the_guessed_type() {
        assert_eq!(
            media_content_type(super::FsPath::new("book.mp3")),
            "audio/mpeg"
        );
        assert_eq!(
            media_content_type(super::FsPath::new("book.flac")),
            "audio/flac"
        );
        assert_eq!(
            media_content_type(super::FsPath::new("book.epub")),
            "application/epub+zip"
        );
        assert_eq!(
            media_content_type(super::FsPath::new("book.unknown")),
            "application/octet-stream"
        );
    }

    #[test]
    fn parse_range_handles_common_forms() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=500-", 1000), Some((500, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=0-4999", 1000), Some((0, 999)));
    }

    #[test]
    fn parse_range_rejects_unsatisfiable_ranges() {
        assert_eq!(parse_range("bytes=-0", 1000), None);
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=5-2", 1000), None);
        assert_eq!(parse_range("items=0-99", 1000), None);
        assert_eq!(parse_range("bytes=abc-def", 1000), None);
    }

    #[tokio::test]
    async fn invalid_requested_range_returns_416_with_file_size() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("audio.mp3");
        std::fs::write(&path, vec![0_u8; 1000]).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::RANGE,
            HeaderValue::from_static("bytes=1000-"),
        );

        let response = super::serve_file_response(&path, &[root.path()], headers, None)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            response.headers()[axum::http::header::CONTENT_RANGE],
            "bytes */1000"
        );
    }

    #[tokio::test]
    async fn empty_file_without_range_returns_empty_200() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("empty.txt");
        std::fs::write(&path, []).unwrap();

        let response = super::serve_file_response(&path, &[root.path()], HeaderMap::new(), None)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[axum::http::header::CONTENT_LENGTH], "0");
    }

    #[test]
    fn suffix_range_longer_than_file_starts_at_zero() {
        assert_eq!(parse_range("bytes=-5000", 1000), Some((0, 999)));
    }

    #[test]
    fn contained_file_open_accepts_regular_files_and_rejects_outside_files() {
        let approved = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let inside_path = approved.path().join("track.mp3");
        let outside_path = outside.path().join("secret.txt");
        std::fs::write(&inside_path, b"audio").unwrap();
        std::fs::write(&outside_path, b"secret").unwrap();

        let roots = [approved.path().to_path_buf()];
        let (_, metadata) = super::open_contained_file(&inside_path, &roots).unwrap();
        assert_eq!(metadata.len(), 5);
        assert!(super::open_contained_file(&outside_path, &roots).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn contained_file_open_rejects_post_scan_symlink_substitution() {
        use std::os::unix::fs::symlink;

        let approved = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let cached_path = approved.path().join("track.mp3");
        let secret_path = outside.path().join("secret.txt");
        std::fs::write(&cached_path, b"audio").unwrap();
        std::fs::write(&secret_path, b"secret").unwrap();

        std::fs::remove_file(&cached_path).unwrap();
        symlink(&secret_path, &cached_path).unwrap();

        let roots = [approved.path().to_path_buf()];
        assert!(super::open_contained_file(&cached_path, &roots).is_err());
    }

    #[test]
    fn activity_delta_ignores_seeks_and_caps_impossible_movement() {
        let previous = super::Progress {
            book_id: "book".to_string(),
            track_id: "track".to_string(),
            position_seconds: 100.0,
            book_position_seconds: 100.0,
            duration_seconds: Some(1000.0),
            updated_at: "1000".to_string(),
            finished_override: None,
        };
        let saved = super::Progress {
            position_seconds: 700.0,
            book_position_seconds: 700.0,
            updated_at: "1002".to_string(),
            ..previous.clone()
        };

        assert_eq!(
            super::plausible_listened_delta(Some(&previous), &saved, true),
            0.0
        );
        assert_eq!(
            super::plausible_listened_delta(Some(&previous), &saved, false),
            9.2
        );
        assert_eq!(super::plausible_listened_delta(None, &saved, false), 0.0);
    }

    #[test]
    fn restarting_a_finished_book_clears_the_completion_override() {
        let finished = super::Progress {
            book_id: "book".to_string(),
            track_id: "track".to_string(),
            position_seconds: 3_600.0,
            book_position_seconds: 3_600.0,
            duration_seconds: Some(3_600.0),
            updated_at: "1000".to_string(),
            finished_override: Some(true),
        };

        // A deliberate jump back to the opening is a re-listen.
        assert_eq!(
            super::carried_finished_override(Some(&finished), 4.0, true),
            None
        );
        // Ordinary playback reports near zero cannot erase the choice, and a
        // deliberate seek elsewhere in the book keeps it.
        assert_eq!(
            super::carried_finished_override(Some(&finished), 4.0, false),
            Some(true)
        );
        assert_eq!(
            super::carried_finished_override(Some(&finished), 1_800.0, true),
            Some(true)
        );
        // An explicit "unfinished" is never turned back into "no choice".
        let unfinished = super::Progress {
            finished_override: Some(false),
            ..finished
        };
        assert_eq!(
            super::carried_finished_override(Some(&unfinished), 4.0, true),
            Some(false)
        );
    }

    #[test]
    fn explicit_completion_overrides_position_without_moving_it() {
        assert!(matches!(
            super::book_progress_status(Some(1000.0), Some(900.0), 100.0, Some(true)),
            super::BookProgressStatus::Finished
        ));
        assert!(matches!(
            super::book_progress_status(Some(1000.0), Some(0.0), 1000.0, Some(false)),
            super::BookProgressStatus::InProgress
        ));
        assert!(matches!(
            super::book_progress_status(Some(1000.0), Some(0.0), 1000.0, None),
            super::BookProgressStatus::Finished
        ));
    }

    #[tokio::test]
    async fn the_legacy_position_estimate_is_dropped_from_stored_activity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("activity.json");
        std::fs::write(
            &path,
            serde_json::json!({
                "reader": {
                    "2026-07-23": 600.0,
                    // An estimate of pre-tracking history from how far into
                    // books the reader had reached: fifty hours the reader
                    // never demonstrably spent listening.
                    super::ACTIVITY_BASELINE_KEY: 180_000.0,
                }
            })
            .to_string(),
        )
        .unwrap();

        let store = super::load_activity_store(&path).await.unwrap();
        let reader = &store.by_user["reader"];
        assert_eq!(reader.len(), 1);
        assert_eq!(reader["2026-07-23"], 600.0);
        assert!(!reader.contains_key(super::ACTIVITY_BASELINE_KEY));
    }

    #[test]
    fn reached_position_never_exceeds_the_books_real_length() {
        let book = book_with_tracks(
            Some(3_600.0),
            vec![track_with_duration("track", 0, Some(3_600.0))],
        );
        let progress = super::Progress {
            book_id: book.id.clone(),
            track_id: "track".to_string(),
            position_seconds: 3_600.0,
            // A client that reported a whole-book position for a book whose
            // track durations it could not read. Left unclamped this alone
            // would add ten hours to the all-time total, permanently.
            book_position_seconds: 36_000.0,
            duration_seconds: Some(3_600.0),
            updated_at: "1000".to_string(),
            finished_override: None,
        };
        assert_eq!(super::reached_position_seconds(&book, &progress), 3_600.0);

        let negative = super::Progress {
            position_seconds: 0.0,
            book_position_seconds: -50.0,
            ..progress
        };
        assert_eq!(super::reached_position_seconds(&book, &negative), 0.0);
    }

    #[test]
    fn activity_days_follow_the_listeners_clock_not_the_servers() {
        // 2026-08-04T02:30:00Z is still the evening of the 3rd in Los Angeles.
        let utc_evening = 1_785_810_600i64;
        let day_utc = utc_evening.div_euclid(86_400);
        let day_pacific = (utc_evening + -7 * 60 * 60).div_euclid(86_400);
        assert_eq!(super::days_to_ymd(day_utc), "2026-08-04");
        assert_eq!(super::days_to_ymd(day_pacific), "2026-08-03");

        assert_eq!(super::sanitized_tz_offset_minutes(Some(-420)), -420);
        assert_eq!(super::sanitized_tz_offset_minutes(None), 0);
        // Outside the real range of UTC offsets, so the calendar is not moved.
        assert_eq!(super::sanitized_tz_offset_minutes(Some(-100_000)), 0);
        assert_eq!(super::sanitized_tz_offset_minutes(Some(1_440)), 0);
    }

    #[test]
    fn streak_calendar_starts_on_a_monday_and_covers_today() {
        // 2026-08-04 is a Tuesday.
        let today = super::ymd_to_days("2026-08-04").unwrap();
        let calendar = super::build_streak_calendar(&std::collections::BTreeMap::new(), 8, today);

        assert_eq!(calendar.len(), 56);
        // The label column is a fixed Monday-to-Sunday, so every seventh cell
        // starting at zero has to actually be a Monday.
        assert_eq!(calendar[0].date, "2026-06-15");
        for index in (0..56).step_by(7) {
            let day = super::ymd_to_days(&calendar[index].date).unwrap();
            assert_eq!(
                super::weekday_from_monday(day),
                0,
                "{}",
                calendar[index].date
            );
        }
        assert!(calendar.iter().any(|day| day.date == "2026-08-04"));
    }

    #[test]
    fn streaks_are_measured_against_the_listeners_today() {
        let today = super::ymd_to_days("2026-08-04").unwrap();
        let activity = std::collections::BTreeMap::from([
            ("2026-08-02".to_string(), 600.0),
            ("2026-08-03".to_string(), 600.0),
            ("2026-08-04".to_string(), 600.0),
            // Below the 30 second floor, so it neither counts nor bridges.
            ("2026-07-20".to_string(), 10.0),
            ("2026-07-18".to_string(), 600.0),
        ]);
        assert_eq!(super::compute_streaks(&activity, today), (3, 3));

        // A week later the run is over and nothing is current.
        assert_eq!(super::compute_streaks(&activity, today + 7).0, 0);
    }

    #[test]
    fn normalize_asin_accepts_only_audible_ids() {
        assert_eq!(
            normalize_asin(" B002v1of70 "),
            Some("B002V1OF70".to_string())
        );
        // Audible sells plenty of titles under an ISBN-10 rather than a
        // B-prefixed ASIN; these are ordinary owned books, not bad input.
        assert_eq!(normalize_asin("125077795x"), Some("125077795X".to_string()));
        assert_eq!(normalize_asin("1705009050"), Some("1705009050".to_string()));
        assert_eq!(normalize_asin("1234567891"), None);
        assert_eq!(normalize_asin("Unabridged"), None);
        assert_eq!(normalize_asin("B002V1OF7"), None);
        assert_eq!(normalize_asin("B002V1OF701"), None);
        assert_eq!(normalize_asin("B002V1OF7!"), None);
        assert_eq!(normalize_asin("../../etc/pw"), None);
    }

    #[test]
    fn normalize_guessed_asin_still_requires_the_b_prefix() {
        assert_eq!(
            normalize_guessed_asin("B002V1OF70"),
            Some("B002V1OF70".to_string())
        );
        // Ten letters, and a very common file-name suffix.
        assert_eq!(normalize_guessed_asin("Unabridged"), None);
        assert_eq!(normalize_guessed_asin("125077795X"), None);
    }

    #[test]
    fn parse_origin_list_splits_and_normalizes() {
        assert_eq!(
            parse_origin_list("https://a.example/, http://b.example:5173 ,,".to_string()),
            vec![
                "https://a.example".to_string(),
                "http://b.example:5173".to_string()
            ]
        );
        assert!(parse_origin_list("  ".to_string()).is_empty());
    }

    #[test]
    fn if_none_match_recognizes_matching_etags() {
        let etag = bytes_etag(b"cover-bytes");
        assert!(etag.starts_with('"') && etag.ends_with('"'));

        let mut headers = HeaderMap::new();
        headers.insert(super::IF_NONE_MATCH, etag.parse().unwrap());
        assert!(if_none_match_matches(&headers, &etag));

        let mut weak = HeaderMap::new();
        weak.insert(
            super::IF_NONE_MATCH,
            format!("W/{etag}, \"other\"").parse().unwrap(),
        );
        assert!(if_none_match_matches(&weak, &etag));

        let mut star = HeaderMap::new();
        star.insert(super::IF_NONE_MATCH, "*".parse().unwrap());
        assert!(if_none_match_matches(&star, &etag));

        let mut mismatch = HeaderMap::new();
        mismatch.insert(super::IF_NONE_MATCH, "\"different\"".parse().unwrap());
        assert!(!if_none_match_matches(&mismatch, &etag));
        assert!(!if_none_match_matches(&HeaderMap::new(), &etag));
    }

    #[test]
    fn login_throttle_key_is_bounded() {
        let long_name = "A".repeat(10_000);
        let key = super::login_throttle_key(&long_name);
        assert_eq!(
            key.chars().count(),
            "user:".len() + super::LOGIN_THROTTLE_KEY_MAX_CHARS
        );
        assert_eq!(super::login_throttle_key(" Reader "), "user: reader ");
    }

    #[test]
    fn proxy_client_addresses_are_trusted_only_from_loopback() {
        let mut headers = super::HeaderMap::new();
        headers.insert("x-forwarded-for", "127.0.0.1, 203.0.113.8".parse().unwrap());
        assert_eq!(
            super::request_client_ip("127.0.0.1:4000".parse().unwrap(), &headers),
            "203.0.113.8".parse::<std::net::IpAddr>().unwrap()
        );
        assert_eq!(
            super::request_client_ip("198.51.100.4:4000".parse().unwrap(), &headers),
            "198.51.100.4".parse::<std::net::IpAddr>().unwrap()
        );
    }

    #[test]
    fn session_cookies_require_https() {
        let cookie = super::session_cookie("token", true);
        assert!(cookie.contains("; Secure;"));
        assert!(cookie.contains("; HttpOnly;"));
        assert!(cookie.contains("; SameSite=Lax"));

        let lan_cookie = super::session_cookie("token", false);
        assert!(!lan_cookie.contains("; Secure"));
        assert!(lan_cookie.contains("; HttpOnly;"));
    }

    #[test]
    fn cookie_csrf_requires_the_target_or_an_explicit_origin() {
        let mut headers = super::HeaderMap::new();
        headers.insert(super::HOST, "books.example.com".parse().unwrap());
        headers.insert(super::ORIGIN, "https://books.example.com".parse().unwrap());
        assert!(super::cookie_request_origin_allowed(
            &std::collections::HashSet::new(),
            &headers
        ));

        headers.insert(super::ORIGIN, "https://evil.example.com".parse().unwrap());
        assert!(!super::cookie_request_origin_allowed(
            &std::collections::HashSet::new(),
            &headers
        ));

        let configured =
            std::collections::HashSet::from(["https://reader.example.net".to_string()]);
        headers.insert(super::ORIGIN, "https://reader.example.net".parse().unwrap());
        assert!(super::cookie_request_origin_allowed(&configured, &headers));

        headers.remove(super::ORIGIN);
        assert!(!super::cookie_request_origin_allowed(&configured, &headers));
    }

    #[test]
    fn csrf_origins_always_include_official_apps() {
        let origins =
            super::build_csrf_allowed_origins(&["HTTPS://Reader.Example.NET/".to_string()]);
        assert!(origins.contains("capacitor://localhost"));
        assert!(origins.contains("http://localhost"));
        assert!(origins.contains("https://reader.example.net"));
    }

    #[test]
    fn password_lengths_are_bounded() {
        assert!(super::validate_password(&"x".repeat(super::MIN_PASSWORD_CHARS)).is_ok());
        assert!(super::validate_password(&"x".repeat(super::MIN_PASSWORD_CHARS - 1)).is_err());
        assert!(super::validate_password(&"x".repeat(super::MAX_PASSWORD_CHARS + 1)).is_err());
    }

    #[test]
    fn deployment_profiles_choose_safe_defaults() {
        assert_eq!(
            super::DeploymentMode::parse("local")
                .unwrap()
                .default_host(),
            "127.0.0.1"
        );
        assert_eq!(
            super::DeploymentMode::parse("lan").unwrap().default_host(),
            "0.0.0.0"
        );
        assert!(
            super::DeploymentMode::parse("proxy")
                .unwrap()
                .secure_cookies()
        );
        assert!(!super::DeploymentMode::Lan.secure_cookies());
        assert!(super::DeploymentMode::Proxy.setup_token_required(false));
        assert!(super::DeploymentMode::Lan.setup_token_required(true));
        assert!(!super::DeploymentMode::Lan.setup_token_required(false));
        assert!(super::DeploymentMode::parse("public").is_err());

        let (legacy_mode, legacy_host) =
            super::resolve_deployment_settings(None, Some("0.0.0.0".to_string())).unwrap();
        assert_eq!(legacy_mode, super::DeploymentMode::Lan);
        assert_eq!(legacy_host, "0.0.0.0");

        let (lan_mode, lan_host) =
            super::resolve_deployment_settings(Some("lan".to_string()), None).unwrap();
        assert_eq!(lan_mode, super::DeploymentMode::Lan);
        assert_eq!(lan_host, "0.0.0.0");

        assert!(
            super::resolve_deployment_settings(
                Some("proxy".to_string()),
                Some("0.0.0.0".to_string())
            )
            .is_err()
        );
    }

    #[test]
    fn setup_tokens_are_bounded_and_expire() {
        let token = super::SetupToken::new("one-time-secret", 100);
        assert!(token.matches("one-time-secret", 100));
        assert!(!token.matches("wrong-secret", 100));
        assert!(!token.matches(
            "one-time-secret",
            100 + super::SETUP_TOKEN_LIFETIME_SECONDS + 1
        ));
    }

    #[test]
    fn transfer_limits_are_configurable_and_bounded() {
        let mut values = std::collections::HashMap::new();
        assert_eq!(
            super::config_gib_limit(&values, "max_upload_gib", 20).unwrap(),
            Some(20 * super::GIBIBYTE_BYTES)
        );

        values.insert("max_upload_gib".to_string(), "0".to_string());
        assert_eq!(
            super::config_gib_limit(&values, "max_upload_gib", 20).unwrap(),
            None
        );
        values.insert("max_upload_gib".to_string(), "2".to_string());
        assert_eq!(
            super::config_gib_limit(&values, "max_upload_gib", 20).unwrap(),
            Some(2 * super::GIBIBYTE_BYTES)
        );

        values.insert(
            "max_concurrent_book_downloads".to_string(),
            "32".to_string(),
        );
        assert_eq!(
            super::config_bounded_usize(&values, "max_concurrent_book_downloads", 1, 1, 32)
                .unwrap(),
            32
        );
        values.insert(
            "max_concurrent_book_downloads".to_string(),
            "33".to_string(),
        );
        assert!(
            super::config_bounded_usize(&values, "max_concurrent_book_downloads", 1, 1, 32)
                .is_err()
        );

        assert!(super::download_volume_has_capacity(30, 20, 10));
        assert!(!super::download_volume_has_capacity(29, 20, 10));
        assert!(!super::download_volume_has_capacity(u64::MAX, u64::MAX, 1));
    }

    #[test]
    fn query_tokens_are_limited_to_read_only_media_routes() {
        use super::Method;

        assert!(super::query_token_allowed(
            &Method::GET,
            "/api/books/book/cover"
        ));
        assert!(super::query_token_allowed(
            &Method::GET,
            "/api/books/book/tracks/track/stream"
        ));
        assert!(super::query_token_allowed(
            &Method::GET,
            "/api/libation/covers/picture"
        ));
        assert!(!super::query_token_allowed(&Method::GET, "/api/users"));
        assert!(!super::query_token_allowed(
            &Method::DELETE,
            "/api/books/book/download"
        ));
    }

    #[test]
    fn media_credentials_are_distinct_from_session_credentials() {
        let session = "secret-session-token";
        let media = super::media_token_for_session(session);
        assert_ne!(media, session);
        assert_eq!(media, super::media_token_for_session(session));
        assert_ne!(media, super::media_token_for_session("another-session"));
    }

    #[test]
    fn login_throttle_locks_after_max_failures() {
        let now = 10_000;
        let below_limit = LoginThrottle {
            failures: super::LOGIN_MAX_FAILURES - 1,
            last_failure: now,
        };
        assert!(!below_limit.is_locked(now, super::LOGIN_MAX_FAILURES));

        let at_limit = LoginThrottle {
            failures: super::LOGIN_MAX_FAILURES,
            last_failure: now,
        };
        assert!(at_limit.is_locked(now, super::LOGIN_MAX_FAILURES));
        assert!(at_limit.is_locked(
            now + super::LOGIN_LOCKOUT_SECONDS - 1,
            super::LOGIN_MAX_FAILURES
        ));
        assert!(!at_limit.is_locked(
            now + super::LOGIN_LOCKOUT_SECONDS,
            super::LOGIN_MAX_FAILURES
        ));
        assert!(at_limit.is_stale(now + super::LOGIN_LOCKOUT_SECONDS));
    }

    #[cfg(unix)]
    fn fake_libation_state(root: &std::path::Path) -> (super::AppState, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;

        let library_root = root.join("library");
        let data_dir = root.join("data");
        std::fs::create_dir_all(&library_root).unwrap();
        std::fs::create_dir_all(&data_dir).unwrap();
        let audio_template = root.join("template.wav");
        let sample_data = vec![0u8; 160];
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36u32 + sample_data.len() as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&8_000u32.to_le_bytes());
        wav.extend_from_slice(&16_000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(sample_data.len() as u32).to_le_bytes());
        wav.extend_from_slice(&sample_data);
        std::fs::write(&audio_template, wav).unwrap();
        assert!(
            super::read_track_metadata(&audio_template)
                .duration_seconds
                .is_some(),
            "test WAV must be readable by the library scanner"
        );
        let log_path = root.join("libation.log");
        let cli_path = root.join("fake-libation.sh");
        let script = format!(
            r#"#!/bin/sh
command="$1"
shift
if [ "$command" = "export" ]; then
  export_path=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--path" ]; then
      export_path="$2"
      shift 2
    else
      shift
    fi
  done
  printf 'start export\n' >> '{log}'
  sleep 0.02
  printf '[]' > "$export_path"
  printf 'end export\n' >> '{log}'
  exit 0
fi
if [ "$command" != "liberate" ]; then
  exit 0
fi
asin=""
books=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --id)
      asin="$2"
      shift 2
      ;;
    --override)
      books="${{2#Books=}}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
printf 'start %s\n' "$asin" >> '{log}'
sleep 0.08
if [ "$asin" != "B000FAIL00" ]; then
  mkdir -p "$books/Test [$asin]"
  cp '{audio}' "$books/Test [$asin]/Test [$asin].wav"
fi
printf 'end %s\n' "$asin" >> '{log}'
exit 0
"#,
            log = log_path.display(),
            audio = audio_template.display()
        );
        std::fs::write(&cli_path, script).unwrap();
        let mut permissions = std::fs::metadata(&cli_path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&cli_path, permissions).unwrap();

        let state = super::AppState {
            deployment_mode: super::DeploymentMode::Local,
            csrf_allowed_origins: super::Arc::new(std::collections::HashSet::new()),
            setup_token: super::Arc::new(super::Mutex::new(None)),
            max_upload_bytes: Some(super::DEFAULT_MAX_UPLOAD_GIB * super::GIBIBYTE_BYTES),
            max_book_download_bytes: Some(
                super::DEFAULT_MAX_BOOK_DOWNLOAD_GIB * super::GIBIBYTE_BYTES,
            ),
            download_temp_dir: data_dir.join("download-temp"),
            min_download_free_bytes: super::DEFAULT_MIN_DOWNLOAD_FREE_GIB * super::GIBIBYTE_BYTES,
            library_root: library_root.clone(),
            library_identities_file: data_dir.join("library-identities.json"),
            progress_file: data_dir.join("progress.json"),
            book_settings_file: data_dir.join("book-settings.json"),
            users_file: data_dir.join("users.json"),
            sessions_file: data_dir.join("sessions.json"),
            activity_file: data_dir.join("activity.json"),
            finish_events_file: data_dir.join("finish-events.json"),
            metadata_overrides_file: data_dir.join("metadata-overrides.json"),
            libation_requests_file: data_dir.join("libation-requests.json"),
            libation_refreshes_file: data_dir.join("libation-refreshes.json"),
            libation_accounts_file: data_dir.join("libation-accounts.json"),
            libation_accounts_root: data_dir.join("libation-accounts"),
            libation_config: super::LibationConfig {
                cli_path: Some(cli_path),
                libation_files_dir: None,
                library_root,
                auto_refresh_hours: Some(super::DEFAULT_LIBATION_AUTO_REFRESH_HOURS),
                reader_refreshes_per_hour: super::DEFAULT_LIBATION_READER_REFRESHES_PER_HOUR,
            },
            alignment_config: super::AlignmentConfig { cli_path: None },
            faststart_tools: None,
            update_manager: super::updates::UpdateManager::new(data_dir.clone(), None, 4000)
                .unwrap(),
            sync_dir: data_dir.join("sync"),
            library: super::Arc::new(super::RwLock::new(super::LibraryState::default())),
            metadata_overrides: super::Arc::new(super::RwLock::new(
                super::MetadataOverrideStore::default(),
            )),
            jobs: super::Arc::new(super::RwLock::new(std::collections::HashMap::new())),
            users: super::Arc::new(super::RwLock::new(super::UsersStore::default())),
            sessions: super::Arc::new(super::RwLock::new(std::collections::HashMap::new())),
            activity: super::Arc::new(super::RwLock::new(super::ActivityStore::default())),
            finish_events: super::Arc::new(super::RwLock::new(super::FinishEventStore::default())),
            libation_requests: super::Arc::new(super::RwLock::new(
                super::LibationRequestStore::default(),
            )),
            libation_refreshes: super::Arc::new(super::Mutex::new(
                super::LibationRefreshStore::default(),
            )),
            libation_accounts: super::Arc::new(super::RwLock::new(
                super::ManagedLibationAccountStore::default(),
            )),
            libation_login_sessions: super::Arc::new(super::Mutex::new(
                std::collections::HashMap::new(),
            )),
            progress_write_lock: super::Arc::new(super::Mutex::new(())),
            book_settings_write_lock: super::Arc::new(super::Mutex::new(())),
            rescan_lock: super::Arc::new(super::Mutex::new(())),
            libation_job_lock: super::Arc::new(super::Mutex::new(())),
            faststart_lock: super::Arc::new(super::Mutex::new(())),
            login_attempts: super::Arc::new(super::Mutex::new(std::collections::HashMap::new())),
            password_task_slots: super::Arc::new(super::Semaphore::new(
                super::PASSWORD_TASK_CONCURRENCY,
            )),
            download_task_slots: super::Arc::new(super::Semaphore::new(
                super::DEFAULT_MAX_CONCURRENT_BOOK_DOWNLOADS,
            )),
            upload_lock: super::Arc::new(super::Mutex::new(())),
        };
        (state, log_path)
    }

    #[cfg(unix)]
    fn admin_user() -> super::AuthUser {
        super::AuthUser {
            id: "admin".to_string(),
            username: "admin".to_string(),
            is_admin: true,
            is_owner: false,
            can_approve_libation_requests: true,
            allowed_book_ids: None,
            libation_access: super::LibationAccess::Direct,
            share_progress: true,
            announce_finishes: true,
            notify_finishes: true,
        }
    }

    #[cfg(unix)]
    fn owner_user() -> super::AuthUser {
        super::AuthUser {
            id: "owner".to_string(),
            username: "owner".to_string(),
            is_admin: true,
            is_owner: true,
            can_approve_libation_requests: true,
            allowed_book_ids: None,
            libation_access: super::LibationAccess::Direct,
            share_progress: true,
            announce_finishes: true,
            notify_finishes: true,
        }
    }

    #[cfg(unix)]
    fn stored_user(id: &str, is_admin: bool, is_owner: bool) -> super::User {
        super::User {
            id: id.to_string(),
            username: id.to_string(),
            password_hash: "unused".to_string(),
            is_admin: is_admin || is_owner,
            is_owner,
            can_approve_libation_requests: is_owner,
            allowed_book_ids: None,
            libation_access: if is_owner {
                super::LibationAccess::Direct
            } else {
                super::LibationAccess::Approval
            },
            share_progress: true,
            announce_finishes: true,
            notify_finishes: true,
            created_at: "0".to_string(),
        }
    }

    #[cfg(unix)]
    fn approval_reader() -> super::AuthUser {
        super::AuthUser {
            id: "reader".to_string(),
            username: "reader".to_string(),
            is_admin: false,
            is_owner: false,
            can_approve_libation_requests: false,
            allowed_book_ids: None,
            libation_access: super::LibationAccess::Approval,
            share_progress: true,
            announce_finishes: true,
            notify_finishes: true,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn concurrent_first_run_setup_creates_only_one_owner() {
        let root = tempfile::tempdir().unwrap();
        let (state, _) = fake_libation_state(root.path());
        let first = super::setup_admin(
            super::State(state.clone()),
            super::ConnectInfo("127.0.0.1:41001".parse().unwrap()),
            super::HeaderMap::new(),
            super::Json(super::SetupRequest {
                username: "first-owner".to_string(),
                password: "password-one".to_string(),
                setup_token: None,
            }),
        );
        let second = super::setup_admin(
            super::State(state.clone()),
            super::ConnectInfo("127.0.0.1:41002".parse().unwrap()),
            super::HeaderMap::new(),
            super::Json(super::SetupRequest {
                username: "second-owner".to_string(),
                password: "password-two".to_string(),
                setup_token: None,
            }),
        );

        let (first_result, second_result) = tokio::join!(first, second);
        assert_ne!(first_result.is_ok(), second_result.is_ok());
        let users = state.users.read().await;
        assert_eq!(users.users.len(), 1);
        assert!(users.users[0].is_owner);
        assert!(users.users[0].is_admin);
    }

    fn announcing_viewer(id: &str) -> AuthUser {
        let mut viewer = viewer(id, true);
        viewer.announce_finishes = true;
        viewer
    }

    fn finished_book(id: &str, title: &str) -> super::Book {
        let mut book = book_with_tracks(Some(3600.0), Vec::new());
        book.id = id.to_string();
        book.title = title.to_string();
        book
    }

    /// Real threads, because the interleaving is the whole point: on a
    /// single-threaded runtime `join!` polls in a fixed order, so the newest
    /// snapshot always happens to write last and the race cannot appear.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_finishes_all_survive_a_restart() {
        use super::BookProgressStatus::*;
        let root = tempfile::tempdir().unwrap();
        let (state, _) = fake_libation_state(root.path());

        // Enough writers that a snapshot-then-persist implementation loses at
        // least one to an older copy landing last.
        const WRITERS: usize = 24;
        let handles: Vec<_> = (0..WRITERS)
            .map(|index| {
                let state = state.clone();
                tokio::spawn(async move {
                    super::record_finish_event(
                        &state,
                        &announcing_viewer(&format!("reader-{index}")),
                        &finished_book(&format!("book-{index}"), "The Lantern Atlas"),
                        Some(&finish_summary(InProgress)),
                        &finish_summary(Finished),
                    )
                    .await;
                })
            })
            .collect();
        for handle in handles {
            handle.await.unwrap();
        }

        // Memory would pass either way, so assert against the file the next
        // boot actually reads.
        let reloaded = super::load_finish_events(&state.finish_events_file)
            .await
            .unwrap();
        assert_eq!(reloaded.events.len(), WRITERS);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn first_run_setup_rejects_remote_clients() {
        let root = tempfile::tempdir().unwrap();
        let (state, _) = fake_libation_state(root.path());
        let mut headers = super::HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.9".parse().unwrap());
        let result = super::setup_admin(
            super::State(state.clone()),
            super::ConnectInfo("127.0.0.1:41001".parse().unwrap()),
            headers,
            super::Json(super::SetupRequest {
                username: "remote-owner".to_string(),
                password: "a-secure-password".to_string(),
                setup_token: None,
            }),
        )
        .await;
        let error = match result {
            Ok(_) => panic!("remote setup unexpectedly succeeded"),
            Err(error) => error,
        };
        assert_eq!(error.status, super::StatusCode::FORBIDDEN);
        assert!(state.users.read().await.users.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn remote_first_run_setup_requires_the_bootstrap_token() {
        let root = tempfile::tempdir().unwrap();
        let (mut state, _) = fake_libation_state(root.path());
        state.deployment_mode = super::DeploymentMode::Proxy;
        *state.setup_token.lock().await = Some(super::SetupToken::new(
            "one-time-secret",
            super::unix_now_seconds(),
        ));
        let mut headers = super::HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.9".parse().unwrap());

        let result = super::setup_admin(
            super::State(state.clone()),
            super::ConnectInfo("127.0.0.1:41001".parse().unwrap()),
            headers,
            super::Json(super::SetupRequest {
                username: "remote-owner".to_string(),
                password: "a-secure-password".to_string(),
                setup_token: Some("one-time-secret".to_string()),
            }),
        )
        .await;

        assert!(result.is_ok());
        assert!(state.setup_token.lock().await.is_none());
        assert!(state.users.read().await.users[0].is_owner);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn only_an_owner_can_start_a_server_update() {
        let root = tempfile::tempdir().unwrap();
        let (state, _) = fake_libation_state(root.path());
        let denied =
            super::install_update(super::State(state.clone()), super::Extension(admin_user()))
                .await
                .unwrap_err();
        assert_eq!(denied.status, super::StatusCode::FORBIDDEN);

        let denied =
            super::install_frontend_update(super::State(state), super::Extension(admin_user()))
                .await
                .unwrap_err();
        assert_eq!(denied.status, super::StatusCode::FORBIDDEN);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn only_owners_can_manage_admin_roles_and_permissions() {
        let root = tempfile::tempdir().unwrap();
        let (state, _) = fake_libation_state(root.path());
        {
            let mut users = state.users.write().await;
            users.users = vec![
                stored_user("owner", true, true),
                stored_user("admin", true, false),
                stored_user("reader", false, false),
            ];
        }

        let denied = super::update_user_role(
            super::State(state.clone()),
            super::Extension(admin_user()),
            super::Path("reader".to_string()),
            super::Json(super::UpdateUserRoleRequest {
                is_admin: true,
                is_owner: false,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(denied.status, super::StatusCode::FORBIDDEN);

        let promoted = super::update_user_role(
            super::State(state.clone()),
            super::Extension(owner_user()),
            super::Path("reader".to_string()),
            super::Json(super::UpdateUserRoleRequest {
                is_admin: true,
                is_owner: false,
            }),
        )
        .await
        .unwrap()
        .0;
        assert!(promoted.is_admin);
        assert!(!promoted.is_owner);

        let access_denied = super::update_libation_access(
            super::State(state.clone()),
            super::Extension(admin_user()),
            super::Path("reader".to_string()),
            super::Json(super::UpdateLibationAccessRequest {
                libation_access: super::LibationAccess::Direct,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(access_denied.status, super::StatusCode::FORBIDDEN);

        let approver = super::update_libation_approval(
            super::State(state.clone()),
            super::Extension(owner_user()),
            super::Path("reader".to_string()),
            super::Json(super::UpdateLibationApprovalRequest {
                can_approve_libation_requests: true,
            }),
        )
        .await
        .unwrap()
        .0;
        assert!(approver.can_approve_libation_requests);

        let final_owner = super::update_user_role(
            super::State(state),
            super::Extension(owner_user()),
            super::Path("owner".to_string()),
            super::Json(super::UpdateUserRoleRequest {
                is_admin: true,
                is_owner: false,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(final_owner.status, super::StatusCode::CONFLICT);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn approval_requests_are_deduplicated_and_can_be_declined() {
        let root = tempfile::tempdir().unwrap();
        let (state, _) = fake_libation_state(root.path());
        let asin = "B000TEST10".to_string();
        let create = || {
            super::create_libation_download_request(
                super::State(state.clone()),
                super::Extension(approval_reader()),
                super::Path(asin.clone()),
                super::Json(super::CreateLibationDownloadRequest {
                    title: "Requested title".to_string(),
                    profile_id: None,
                }),
            )
        };
        let first = create().await.unwrap().0;
        let second = create().await.unwrap().0;
        assert_eq!(first.id, second.id);
        assert_eq!(state.libation_requests.read().await.requests.len(), 1);

        let declined = super::decide_libation_download_request(
            super::State(state.clone()),
            super::Extension(admin_user()),
            super::Path(first.id),
            super::Json(super::DecideLibationDownloadRequest { approved: false }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(declined.status, "rejected");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn readers_get_three_libation_refreshes_per_hour_while_admins_are_unlimited() {
        let root = tempfile::tempdir().unwrap();
        let (state, _) = fake_libation_state(root.path());

        for _ in 0..super::DEFAULT_LIBATION_READER_REFRESHES_PER_HOUR {
            let created = super::sync_libation_library(
                super::State(state.clone()),
                super::Extension(approval_reader()),
            )
            .await
            .unwrap()
            .0;
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
            loop {
                let status = state
                    .jobs
                    .read()
                    .await
                    .get(&created.job_id)
                    .map(|job| job.status.clone());
                if status.as_deref() == Some("completed") {
                    break;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "reader refresh did not complete"
                );
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        }

        let limited = super::sync_libation_library(
            super::State(state.clone()),
            super::Extension(approval_reader()),
        )
        .await
        .unwrap_err();
        assert_eq!(limited.status, super::StatusCode::TOO_MANY_REQUESTS);

        let admin_first = super::sync_libation_library(
            super::State(state.clone()),
            super::Extension(admin_user()),
        )
        .await
        .unwrap()
        .0;
        let admin_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let status = state
                .jobs
                .read()
                .await
                .get(&admin_first.job_id)
                .map(|job| job.status.clone());
            if status.as_deref() == Some("completed") {
                break;
            }
            assert!(
                tokio::time::Instant::now() < admin_deadline,
                "administrator refresh did not complete"
            );
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let admin_second =
            super::sync_libation_library(super::State(state), super::Extension(admin_user()))
                .await
                .unwrap()
                .0;
        assert_ne!(admin_first.job_id, admin_second.job_id);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn four_libation_downloads_are_serialized_and_keep_their_targets() {
        let root = tempfile::tempdir().unwrap();
        let (state, log_path) = fake_libation_state(root.path());
        let asins = ["B000TEST01", "B000TEST02", "B000TEST03", "B000TEST04"];

        for asin in asins {
            let _ = super::liberate_libation_book(
                super::State(state.clone()),
                super::Extension(admin_user()),
                super::Path(asin.to_string()),
            )
            .await
            .unwrap();
        }

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let jobs = state.jobs.read().await;
            let running = jobs.values().filter(|job| job.status == "running").count();
            let queued = jobs.values().filter(|job| job.status == "queued").count();
            assert!(
                running <= 1,
                "Libation jobs overlapped: {running} were running"
            );
            if running == 1 && queued >= 3 {
                break;
            }
            drop(jobs);
            assert!(
                tokio::time::Instant::now() < deadline,
                "jobs never entered the expected queue"
            );
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }

        let state_for_export = state.clone();
        let export_task = tokio::spawn(async move {
            let _ = super::list_libation_books(
                super::State(state_for_export),
                super::Extension(admin_user()),
            )
            .await
            .unwrap();
        });

        loop {
            let jobs = state.jobs.read().await;
            let running = jobs.values().filter(|job| job.status == "running").count();
            let finished = jobs
                .values()
                .filter(|job| matches!(job.status.as_str(), "completed" | "failed"))
                .count();
            assert!(
                running <= 1,
                "Libation jobs overlapped: {running} were running"
            );
            if finished == asins.len() {
                break;
            }
            drop(jobs);
            assert!(
                tokio::time::Instant::now() < deadline,
                "four-download queue timed out"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        export_task.await.unwrap();

        let jobs = state.jobs.read().await;
        assert_eq!(jobs.len(), asins.len());
        for asin in asins {
            let job = jobs
                .values()
                .find(|job| {
                    job.target_id.as_deref().is_some_and(|target| {
                        target == asin || target.ends_with(&format!(":{asin}"))
                    })
                })
                .unwrap();
            assert_eq!(
                job.status, "completed",
                "{asin} ended with {:?}; output: {}",
                job.error, job.output
            );
        }
        drop(jobs);

        let lines = std::fs::read_to_string(log_path)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect::<Vec<_>>();
        assert_eq!(lines.len(), asins.len() * 2 + 2);
        for pair in lines.as_chunks::<2>().0 {
            assert!(pair[0].starts_with("start "));
            assert_eq!(pair[1], pair[0].replacen("start ", "end ", 1));
        }
        assert_eq!(lines[lines.len() - 2], "start export");

        let library = state.library.read().await;
        for asin in asins {
            assert!(
                library
                    .books
                    .iter()
                    .any(|book| book.asin.as_deref() == Some(asin)),
                "{asin} was not present after the queued downloads finished"
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn successful_libation_exit_without_a_decrypted_book_is_failed() {
        let root = tempfile::tempdir().unwrap();
        let (state, _) = fake_libation_state(root.path());
        let asin = "B000FAIL00";
        let created = super::liberate_libation_book(
            super::State(state.clone()),
            super::Extension(admin_user()),
            super::Path(asin.to_string()),
        )
        .await
        .unwrap()
        .0;

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let jobs = state.jobs.read().await;
            let job = jobs.get(&created.job_id).unwrap();
            if job.status == "failed" {
                assert!(
                    job.error
                        .as_deref()
                        .unwrap_or_default()
                        .contains("was not found")
                );
                break;
            }
            drop(jobs);
            assert!(
                tokio::time::Instant::now() < deadline,
                "failed decrypt was never reported"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn duplicate_download_requests_share_the_active_job() {
        let root = tempfile::tempdir().unwrap();
        let (state, log_path) = fake_libation_state(root.path());
        let asin = "B000TEST09";
        let first = super::liberate_libation_book(
            super::State(state.clone()),
            super::Extension(admin_user()),
            super::Path(asin.to_string()),
        )
        .await
        .unwrap()
        .0;
        let second = super::liberate_libation_book(
            super::State(state.clone()),
            super::Extension(admin_user()),
            super::Path(asin.to_string()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(first.job_id, second.job_id);

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let jobs = state.jobs.read().await;
            let job = jobs.get(&first.job_id).unwrap();
            if job.status == "completed" {
                assert_eq!(jobs.len(), 1);
                break;
            }
            drop(jobs);
            assert!(
                tokio::time::Instant::now() < deadline,
                "deduplicated download timed out"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        let starts = std::fs::read_to_string(log_path)
            .unwrap()
            .lines()
            .filter(|line| *line == format!("start {asin}"))
            .count();
        assert_eq!(starts, 1, "the same title was decrypted more than once");
    }

    #[test]
    fn prune_finished_jobs_keeps_active_and_newest() {
        let mut jobs = std::collections::HashMap::new();
        for index in 0..(super::MAX_TRACKED_JOBS + 10) {
            let id = format!("job-{index}");
            jobs.insert(
                id.clone(),
                super::JobStatus {
                    id,
                    kind: "test".to_string(),
                    target_id: None,
                    status: match index {
                        0 => "running",
                        1 => "queued",
                        _ => "completed",
                    }
                    .to_string(),
                    started_at: index.to_string(),
                    finished_at: None,
                    exit_code: None,
                    output: String::new(),
                    error: None,
                },
            );
        }
        super::prune_finished_jobs(&mut jobs);
        assert_eq!(jobs.len(), super::MAX_TRACKED_JOBS);
        // Active jobs survive even though they are the oldest.
        assert!(jobs.contains_key("job-0"));
        assert!(jobs.contains_key("job-1"));
        // The oldest finished jobs are the ones dropped.
        assert!(!jobs.contains_key("job-2"));
        assert!(jobs.contains_key(&format!("job-{}", super::MAX_TRACKED_JOBS + 9)));
    }

    #[test]
    fn job_list_summaries_bound_output_without_breaking_unicode() {
        let output = "résumé ".repeat(2_000);
        let job = super::JobStatus {
            id: "job-output".to_string(),
            kind: "test".to_string(),
            target_id: None,
            status: "completed".to_string(),
            started_at: "1".to_string(),
            finished_at: Some("2".to_string()),
            exit_code: Some(0),
            output: output.clone(),
            error: Some(output),
        };

        let summary = super::job_for_list(&job);
        assert!(summary.output.len() <= super::JOB_LIST_OUTPUT_BYTES);
        assert!(summary.error.unwrap().len() <= super::JOB_LIST_OUTPUT_BYTES);
        assert!(summary.output.ends_with("résumé "));
    }

    #[test]
    fn job_timestamps_advance_when_the_clock_value_is_already_used() {
        let mut jobs = std::collections::HashMap::new();
        let latest = super::unix_now_millis().saturating_add(10_000);
        jobs.insert(
            "latest".to_string(),
            super::JobStatus {
                id: "latest".to_string(),
                kind: "test".to_string(),
                target_id: None,
                status: "running".to_string(),
                started_at: latest.to_string(),
                finished_at: None,
                exit_code: None,
                output: String::new(),
                error: None,
            },
        );

        assert_eq!(super::next_job_timestamp(&jobs), latest + 1);
    }

    #[test]
    fn sessions_expire_after_max_age() {
        let session = Session {
            user_id: "user".to_string(),
            created_at: 1_000,
        };
        assert!(!session.is_expired(1_000 + super::SESSION_COOKIE_MAX_AGE_SECONDS));
        assert!(session.is_expired(1_001 + super::SESSION_COOKIE_MAX_AGE_SECONDS));
    }

    #[test]
    fn new_sessions_prune_oldest_sessions_for_the_user() {
        let mut sessions = (0..super::MAX_SESSIONS_PER_USER)
            .map(|index| {
                (
                    format!("token-{index}"),
                    Session {
                        user_id: "reader".to_string(),
                        created_at: 1_000 + index as u64,
                    },
                )
            })
            .collect::<std::collections::HashMap<_, _>>();
        super::prune_sessions_for_new_session(&mut sessions, "reader", 2_000);
        assert_eq!(sessions.len(), super::MAX_SESSIONS_PER_USER - 1);
        assert!(!sessions.contains_key("token-0"));
        assert!(sessions.contains_key(&format!("token-{}", super::MAX_SESSIONS_PER_USER - 1)));
    }

    #[test]
    fn password_changes_revoke_other_sessions() {
        let mut sessions = std::collections::HashMap::from([
            (
                "current".to_string(),
                Session {
                    user_id: "reader".to_string(),
                    created_at: 1,
                },
            ),
            (
                "stolen".to_string(),
                Session {
                    user_id: "reader".to_string(),
                    created_at: 2,
                },
            ),
            (
                "other-user".to_string(),
                Session {
                    user_id: "other".to_string(),
                    created_at: 3,
                },
            ),
        ]);

        super::revoke_password_change_sessions(&mut sessions, "reader", Some("current"));
        assert!(sessions.contains_key("current"));
        assert!(!sessions.contains_key("stolen"));
        assert!(sessions.contains_key("other-user"));

        super::revoke_password_change_sessions(&mut sessions, "reader", None);
        assert!(!sessions.contains_key("current"));
        assert!(sessions.contains_key("other-user"));
    }

    #[tokio::test]
    async fn temporary_download_is_removed_after_stream_file_closes() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("download.zip");
        std::fs::write(&path, b"zip bytes").unwrap();
        let file = super::fs::File::open(&path).await.unwrap();
        let permit = super::Arc::new(super::Semaphore::new(1))
            .acquire_owned()
            .await
            .unwrap();

        drop(super::RemoveOnDropFile::new(file, path.clone(), permit));

        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn atomic_state_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("sessions.json");
        super::write_json_atomic(&path, &serde_json::json!({ "token": "secret" }))
            .await
            .unwrap();
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn library_identity_survives_folder_and_track_renames() {
        let root = tempfile::tempdir().unwrap();
        let first_folder = root.path().join("Old Book Name");
        std::fs::create_dir_all(&first_folder).unwrap();
        let first_track = first_folder.join("01 old name.mp3");
        std::fs::write(&first_track, b"stable audiobook bytes").unwrap();

        let fingerprint = super::file_identity_fingerprint(&first_track).unwrap();
        let book_fingerprint = super::book_identity_fingerprint(std::slice::from_ref(&fingerprint));
        let mut identities = super::LibraryIdentityStore::default();
        let mut used = std::collections::HashSet::new();
        let (first_book_id, first_track_ids) = super::resolve_library_identity(
            &mut identities,
            &mut used,
            super::LibraryIdentityCandidate {
                book_fingerprint: &book_fingerprint,
                group_alias: "Old Book Name",
                group_key: &first_folder,
                library_root: root.path(),
                grouped_files: std::slice::from_ref(&first_track),
                track_fingerprints: std::slice::from_ref(&fingerprint),
            },
        );

        let second_folder = root.path().join("New Book Name");
        std::fs::rename(&first_folder, &second_folder).unwrap();
        let renamed_track = second_folder.join("01 new name.mp3");
        std::fs::rename(second_folder.join("01 old name.mp3"), &renamed_track).unwrap();
        let renamed_fingerprint = super::file_identity_fingerprint(&renamed_track).unwrap();
        let renamed_book_fingerprint =
            super::book_identity_fingerprint(std::slice::from_ref(&renamed_fingerprint));
        let mut used = std::collections::HashSet::new();
        let (second_book_id, second_track_ids) = super::resolve_library_identity(
            &mut identities,
            &mut used,
            super::LibraryIdentityCandidate {
                book_fingerprint: &renamed_book_fingerprint,
                group_alias: "New Book Name",
                group_key: &second_folder,
                library_root: root.path(),
                grouped_files: std::slice::from_ref(&renamed_track),
                track_fingerprints: std::slice::from_ref(&renamed_fingerprint),
            },
        );

        assert_eq!(second_book_id, first_book_id);
        assert_eq!(second_track_ids, first_track_ids);
    }

    /// Faststart conversion rewrites a track's bytes at the same path, so the
    /// fingerprint changes while the path does not. Saved progress is keyed on
    /// the book and track ids, so those must not move.
    #[test]
    fn library_identity_survives_a_rewritten_track_at_the_same_path() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("Book");
        std::fs::create_dir_all(&folder).unwrap();
        let track = folder.join("01.m4b");
        std::fs::write(&track, b"trailing moov layout").unwrap();

        let resolve = |identities: &mut super::LibraryIdentityStore| {
            let fingerprint = super::file_identity_fingerprint(&track).unwrap();
            let book_fingerprint =
                super::book_identity_fingerprint(std::slice::from_ref(&fingerprint));
            let mut used = std::collections::HashSet::new();
            super::resolve_library_identity(
                identities,
                &mut used,
                super::LibraryIdentityCandidate {
                    book_fingerprint: &book_fingerprint,
                    group_alias: "Book",
                    group_key: &folder,
                    library_root: root.path(),
                    grouped_files: std::slice::from_ref(&track),
                    track_fingerprints: std::slice::from_ref(&fingerprint),
                },
            )
        };

        let mut identities = super::LibraryIdentityStore::default();
        let (book_id, track_ids) = resolve(&mut identities);

        std::fs::write(&track, b"faststart layout, different bytes and length").unwrap();
        let (converted_book_id, converted_track_ids) = resolve(&mut identities);

        assert_eq!(converted_book_id, book_id);
        assert_eq!(converted_track_ids, track_ids);
    }

    #[test]
    fn unchanged_tracks_reuse_cached_fingerprints_and_removed_ones_are_pruned() {
        let root = tempfile::tempdir().unwrap();
        let track = root.path().join("01 chapter.mp3");
        std::fs::write(&track, b"stable audiobook bytes").unwrap();
        let files = std::slice::from_ref(&track);

        let (first, cache) =
            super::fingerprint_tracks(root.path(), files, std::collections::BTreeMap::new());
        assert_eq!(cache.len(), 1);
        assert!(cache.contains_key("01 chapter.mp3"));

        // A cached digest is trusted while size and mtime hold, so a doctored
        // entry coming back out proves the file was not re-read.
        let mut doctored = cache.clone();
        doctored.get_mut("01 chapter.mp3").unwrap().fingerprint = "cached-digest".to_string();
        let (reused, _) = super::fingerprint_tracks(root.path(), files, doctored.clone());
        assert_eq!(reused[&track], "cached-digest");

        // A size change invalidates the entry and forces a real read.
        let mut stale = doctored;
        stale.get_mut("01 chapter.mp3").unwrap().size += 1;
        let (rehashed, retained) = super::fingerprint_tracks(root.path(), files, stale);
        assert_eq!(rehashed[&track], first[&track]);

        let (_, pruned) = super::fingerprint_tracks(root.path(), &[], retained);
        assert!(pruned.is_empty());
    }

    #[test]
    fn unreadable_tracks_keep_a_stable_identity_instead_of_failing_the_scan() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("gone.mp3");
        let files = std::slice::from_ref(&missing);

        let (fingerprints, cache) =
            super::fingerprint_tracks(root.path(), files, std::collections::BTreeMap::new());
        let fingerprint = fingerprints[&missing].clone();
        assert!(fingerprint.starts_with("path:"));
        // Never cached, so a file that becomes readable again is picked up on
        // the next scan rather than being stuck on the stand-in.
        assert!(cache.is_empty());

        let (repeated, _) =
            super::fingerprint_tracks(root.path(), files, std::collections::BTreeMap::new());
        assert_eq!(repeated[&missing], fingerprint);
    }

    #[test]
    fn libation_account_rows_keep_distinct_server_identities() {
        let accounts = super::parse_libation_accounts(
            "first@example.com\tFamily\tus\tyes\tyes\nsecond@example.com\tTravel\tuk\tyes\tno\n",
        );
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].name.as_deref(), Some("Family"));
        assert_ne!(accounts[0].id, accounts[1].id);
        assert!(accounts[0].authenticated);
        assert_eq!(accounts[0].connection_state, "connected");
        assert!(!accounts[1].authenticated);
        assert_eq!(accounts[1].connection_state, "needs_sign_in");
    }

    #[tokio::test]
    async fn managed_libation_profiles_bootstrap_required_settings() {
        let root = tempfile::tempdir().unwrap();
        let library = root.path().join("library");
        let profile = root.path().join("account");
        std::fs::create_dir(&library).unwrap();

        super::initialize_managed_libation_profile(&profile, &library)
            .await
            .unwrap();

        let settings = serde_json::from_str::<serde_json::Value>(
            &tokio::fs::read_to_string(profile.join("Settings.json"))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            settings["Books"].as_str(),
            Some(library.to_string_lossy().as_ref())
        );
        assert_eq!(
            settings["InProgress"].as_str(),
            Some(profile.join("InProgress").to_string_lossy().as_ref())
        );
        assert!(profile.join("InProgress").is_dir());
    }

    #[test]
    fn audible_login_urls_accept_marketplaces_but_reject_lookalike_hosts() {
        assert!(
            super::validate_libation_response_url(
                "https://www.amazon.com/ap/maplanding?openid=example"
            )
            .is_ok()
        );
        assert!(
            super::validate_libation_response_url(
                "https://www.amazon.co.uk/ap/maplanding?openid=example"
            )
            .is_ok()
        );
        assert!(
            super::validate_libation_response_url(
                "https://www.amazon.com.attacker.example/ap/maplanding"
            )
            .is_err()
        );
        assert!(super::validate_libation_response_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn libation_login_output_redacts_urls() {
        let output = "Open this URL:\nhttps://www.amazon.com/ap/signin?secret=value\nPaste URL:";
        assert_eq!(
            super::sanitize_libation_login_output(output),
            "Open this URL:"
        );
    }

    /// Builds a library holding one real, trailing-`moov` M4B. Returns `None`
    /// where ffmpeg is not installed, which is also where the feature is off.
    #[cfg(unix)]
    async fn faststart_library(
        root: &std::path::Path,
    ) -> Option<(super::AppState, std::path::PathBuf, String, String)> {
        let tools = super::faststart::discover_tools(None, None)?;
        let (mut state, _) = fake_libation_state(root);
        let ffmpeg = tools.ffmpeg.clone();
        state.faststart_tools = Some(tools);

        let book_dir = state.library_root.join("Trailing Book");
        std::fs::create_dir_all(&book_dir).unwrap();
        let track = book_dir.join("01.m4b");
        let created = std::process::Command::new(ffmpeg)
            .args([
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=3",
                "-c:a",
                "aac",
            ])
            .arg(&track)
            .status()
            .expect("ffmpeg should run");
        assert!(created.success());
        assert_eq!(
            super::faststart::inspect(&track).unwrap(),
            super::faststart::Layout::Trailing
        );

        super::rescan_library(&state).await.unwrap();
        let (book_id, track_id) = {
            let library = state.library.read().await;
            let book = library.books.first().expect("the book should be scanned");
            (book.id.clone(), book.tracks[0].id.clone())
        };
        Some((state, track, book_id, track_id))
    }

    #[cfg(unix)]
    fn saved_position(book_id: &str, track_id: &str, age_ms: u64) -> super::Progress {
        super::Progress {
            book_id: book_id.to_string(),
            track_id: track_id.to_string(),
            position_seconds: 1.5,
            book_position_seconds: 1.5,
            duration_seconds: Some(3.0),
            updated_at: super::unix_now_millis().saturating_sub(age_ms).to_string(),
            finished_override: None,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn faststart_conversion_keeps_book_identity_and_saved_progress() {
        let root = tempfile::tempdir().unwrap();
        let Some((state, track, book_id, track_id)) = faststart_library(root.path()).await else {
            eprintln!("skipping: ffmpeg is not installed");
            return;
        };

        let key = super::progress_key("admin", &book_id);
        let mut progress = std::collections::HashMap::new();
        progress.insert(
            key.clone(),
            saved_position(&book_id, &track_id, 60 * 60 * 1_000),
        );
        super::write_progress(&state.progress_file, &progress)
            .await
            .unwrap();

        let job_id = super::create_job(&state, super::FASTSTART_JOB_KIND).await;
        let report = super::run_faststart_job(&state, &job_id, &super::FaststartRequest::default())
            .await
            .unwrap();
        assert_eq!(report.converted, 1);
        assert_eq!(report.failed, 0);
        assert_eq!(
            super::faststart::inspect(&track).unwrap(),
            super::faststart::Layout::Faststart
        );

        // The rescan after conversion must not mint new ids: the saved
        // position is keyed on the book, and its resume point on the track.
        let library = state.library.read().await;
        assert_eq!(library.books.len(), 1);
        assert_eq!(library.books[0].id, book_id);
        assert_eq!(library.books[0].tracks[0].id, track_id);
        drop(library);

        let saved = super::read_progress(&state.progress_file).await.unwrap();
        let entry = saved.get(&key).expect("progress should survive conversion");
        assert_eq!(entry.track_id, track_id);
        assert!((entry.position_seconds - 1.5).abs() < 1e-9);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn faststart_conversion_leaves_a_book_somebody_is_listening_to() {
        let root = tempfile::tempdir().unwrap();
        let Some((state, track, book_id, track_id)) = faststart_library(root.path()).await else {
            eprintln!("skipping: ffmpeg is not installed");
            return;
        };

        let mut progress = std::collections::HashMap::new();
        progress.insert(
            super::progress_key("admin", &book_id),
            saved_position(&book_id, &track_id, 5_000),
        );
        super::write_progress(&state.progress_file, &progress)
            .await
            .unwrap();

        let job_id = super::create_job(&state, super::FASTSTART_JOB_KIND).await;
        let report = super::run_faststart_job(&state, &job_id, &super::FaststartRequest::default())
            .await
            .unwrap();
        assert_eq!(report.converted, 0);
        assert_eq!(report.skipped, 1);
        assert_eq!(
            super::faststart::inspect(&track).unwrap(),
            super::faststart::Layout::Trailing
        );

        // The same run asked for explicitly converts it.
        let job_id = super::create_job(&state, super::FASTSTART_JOB_KIND).await;
        let report = super::run_faststart_job(
            &state,
            &job_id,
            &super::FaststartRequest {
                book_id: Some(book_id),
                include_active: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(report.converted, 1);
        assert_eq!(
            super::faststart::inspect(&track).unwrap(),
            super::faststart::Layout::Faststart
        );
    }
}
