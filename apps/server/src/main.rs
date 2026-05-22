use argon2::{
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
    password_hash::{SaltString, rand_core::OsRng},
};
use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{Path, Request, State},
    http::{
        HeaderMap, HeaderValue, StatusCode,
        header::{
            ACCEPT_RANGES, AUTHORIZATION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, COOKIE,
            RANGE, SET_COOKIE,
        },
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
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
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::{
    collections::{BTreeMap, HashMap},
    env, io,
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio::{fs, process::Command, sync::RwLock};
use tokio_util::io::ReaderStream;
use tower_http::{
    cors::{AllowHeaders, AllowMethods, AllowOrigin, CorsLayer},
    trace::TraceLayer,
};
use walkdir::WalkDir;

const AUDIO_EXTENSIONS: &[&str] = &[
    "aac", "aiff", "flac", "m4a", "m4b", "mp3", "mp4", "ogg", "opus", "wav",
];
const READING_EXTENSIONS: &[&str] = &["epub", "html", "htm", "pdf", "txt"];
const SESSION_COOKIE_NAME: &str = "operalibre_session";
const SESSION_COOKIE_MAX_AGE_SECONDS: u64 = 60 * 60 * 24 * 30;

#[derive(Clone)]
struct AppState {
    library_root: PathBuf,
    progress_file: PathBuf,
    users_file: PathBuf,
    sessions_file: PathBuf,
    activity_file: PathBuf,
    libation_config: LibationConfig,
    library: Arc<RwLock<LibraryState>>,
    jobs: Arc<RwLock<HashMap<String, JobStatus>>>,
    users: Arc<RwLock<UsersStore>>,
    sessions: Arc<RwLock<HashMap<String, Session>>>,
    activity: Arc<RwLock<ActivityStore>>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(transparent)]
struct ActivityStore {
    by_user: HashMap<String, BTreeMap<String, f64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct User {
    id: String,
    username: String,
    password_hash: String,
    is_admin: bool,
    created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UserPublic {
    id: String,
    username: String,
    is_admin: bool,
    created_at: String,
}

impl From<&User> for UserPublic {
    fn from(user: &User) -> Self {
        Self {
            id: user.id.clone(),
            username: user.username.clone(),
            is_admin: user.is_admin,
            created_at: user.created_at.clone(),
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct UsersStore {
    #[serde(default)]
    users: Vec<User>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Session {
    user_id: String,
    #[allow(dead_code)]
    created_at: u64,
}

#[derive(Debug, Clone)]
struct AuthUser {
    id: String,
    username: String,
    is_admin: bool,
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateUserRequest {
    username: String,
    password: String,
    #[serde(default)]
    is_admin: bool,
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
    user: UserPublic,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthStatus {
    setup_required: bool,
    user: Option<UserPublic>,
}

#[derive(Default)]
struct LibraryState {
    books: Vec<Book>,
    track_paths: HashMap<String, PathBuf>,
    reading_paths: HashMap<String, PathBuf>,
    cover_art: HashMap<String, EmbeddedImage>,
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
    chapters: Vec<Chapter>,
    metadata: MetadataSummary,
    tracks: Vec<Track>,
    progress: Option<BookProgress>,
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
struct BookProgress {
    status: BookProgressStatus,
    book_position_seconds: f64,
    duration_seconds: Option<f64>,
    remaining_seconds: Option<f64>,
    percent_complete: Option<f64>,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProgressUpdate {
    track_id: String,
    position_seconds: f64,
    book_position_seconds: Option<f64>,
    duration_seconds: Option<f64>,
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibationAccount {
    account_id: String,
    name: Option<String>,
    locale: String,
    scan_library: bool,
    authenticated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibationBook {
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
    local_book_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobStatus {
    id: String,
    kind: String,
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
}

#[derive(Debug, Clone)]
struct ServerConfig {
    host: String,
    port: u16,
    library_root: PathBuf,
    data_dir: PathBuf,
    progress_file: PathBuf,
    users_file: PathBuf,
    sessions_file: PathBuf,
    activity_file: PathBuf,
    libation_cli_path: Option<PathBuf>,
    libation_files_dir: Option<PathBuf>,
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

        Ok(Self {
            host: config_string_value(&values, "host")
                .or_else(|| env_string_value("HOST"))
                .unwrap_or_else(|| "0.0.0.0".to_string()),
            port: config_u16_value(&values, "port")?
                .or_else(|| env_u16_value("PORT"))
                .unwrap_or(4000),
            library_root,
            data_dir,
            progress_file,
            users_file,
            sessions_file,
            activity_file,
            libation_cli_path: config_path_value(&values, &config_dir, "libation_cli_path")
                .or_else(|| env_path_value("LIBATION_CLI_PATH")),
            libation_files_dir: config_path_value(&values, &config_dir, "libation_files_dir")
                .or_else(|| env_path_value("LIBATION_FILES_DIR")),
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
        "host",
        "port",
        "library_root",
        "audiobook_library",
        "data_dir",
        "progress_file",
        "users_file",
        "activity_file",
        "libation_cli_path",
        "libation_files_dir",
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
        library_root = %config.library_root.display(),
        data_dir = %config.data_dir.display(),
        "server configuration loaded"
    );

    let users_store = load_users_store(&config.users_file).await?;
    let sessions_store = load_sessions_store(&config.sessions_file).await?;
    let activity_store = load_activity_store(&config.activity_file).await?;
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
    }

    let state = AppState {
        library_root: config.library_root.clone(),
        progress_file: config.progress_file.clone(),
        users_file: config.users_file.clone(),
        sessions_file: config.sessions_file.clone(),
        activity_file: config.activity_file.clone(),
        libation_config: LibationConfig::from_server_config(&config),
        library: Arc::new(RwLock::new(LibraryState::default())),
        jobs: Arc::new(RwLock::new(HashMap::new())),
        users: Arc::new(RwLock::new(users_store)),
        sessions: Arc::new(RwLock::new(sessions_store)),
        activity: Arc::new(RwLock::new(activity_store)),
    };

    rescan_library(&state).await?;

    let public_routes = Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/status", get(auth_status))
        .route("/api/auth/setup", post(setup_admin))
        .route("/api/auth/login", post(login));

    let protected_routes = Router::new()
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/me", get(me))
        .route("/api/profile/stats", get(profile_stats))
        .route("/api/users", get(list_users).post(create_user))
        .route("/api/users/{user_id}", delete(delete_user))
        .route("/api/users/{user_id}/password", post(change_password))
        .route("/api/books", get(list_books))
        .route("/api/library/rescan", post(rescan))
        .route("/api/libation/status", get(libation_status))
        .route("/api/libation/books", get(list_libation_books))
        .route("/api/libation/sync", post(sync_libation_library))
        .route(
            "/api/libation/books/{asin}/liberate",
            post(liberate_libation_book),
        )
        .route("/api/jobs/{job_id}", get(get_job))
        .route("/api/books/{book_id}", get(get_book))
        .route("/api/books/{book_id}/cover", get(get_cover_art))
        .route("/api/books/{book_id}/readalong", get(get_reading_file))
        .route(
            "/api/books/{book_id}/progress",
            get(get_progress).put(update_progress),
        )
        .route(
            "/api/books/{book_id}/tracks/{track_id}/stream",
            get(stream_track),
        )
        .route("/api/books/{book_id}/download", get(download_book))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ));

    let app = public_routes
        .merge(protected_routes)
        .layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::mirror_request())
                .allow_methods(AllowMethods::mirror_request())
                .allow_headers(AllowHeaders::mirror_request())
                .allow_credentials(true),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let address: SocketAddr = format!("{}:{}", config.host, config.port).parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!("server listening on http://{address}");
    axum::serve(listener, app).await?;

    Ok(())
}

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    let library = state.library.read().await;
    Json(serde_json::json!({
        "ok": true,
        "libraryRoot": state.library_root,
        "bookCount": library.books.len(),
    }))
}

async fn list_books(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<Vec<Book>>, ApiError> {
    Ok(Json(books_with_progress(&state, &auth.id).await?))
}

async fn rescan(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<Vec<Book>>, ApiError> {
    rescan_library(&state).await?;
    Ok(Json(books_with_progress(&state, &auth.id).await?))
}

async fn libation_status(State(state): State<AppState>) -> Json<LibationStatus> {
    Json(read_libation_status(&state).await)
}

async fn list_libation_books(
    State(state): State<AppState>,
) -> Result<Json<Vec<LibationBook>>, ApiError> {
    let config = state.libation_config.clone();
    if !config.enabled() {
        return Err(ApiError::bad_request(
            "Libation CLI was not found. Set libation_cli_path in server.config or put libationcli on PATH.",
        ));
    }
    let mut books = export_libation_books(&config).await?;
    let library = state.library.read().await;
    for book in books.iter_mut() {
        book.local_book_id = match_local_book(&library.books, book);
    }
    Ok(Json(books))
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
) -> Result<Json<JobCreated>, ApiError> {
    let config = state.libation_config.clone();
    if !config.enabled() {
        return Err(ApiError::bad_request(
            "Libation CLI was not found. Set libation_cli_path in server.config or put libationcli on PATH.",
        ));
    }

    let job_id = create_job(&state, "libation-sync").await;
    let state_for_job = state.clone();
    let job_id_for_task = job_id.clone();
    tokio::spawn(async move {
        update_job_output(
            &state_for_job,
            &job_id_for_task,
            "Starting Libation library scan.\n",
        )
        .await;
        let result = run_libation(&config, vec!["scan".to_string()]).await;
        match result {
            Ok(output) if output.status.success() => {
                append_job_command_output(&state_for_job, &job_id_for_task, &output).await;
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
                update_job_finished(
                    &state_for_job,
                    &job_id_for_task,
                    "failed",
                    output.status.code(),
                    Some("Libation scan failed.".to_string()),
                )
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

async fn liberate_libation_book(
    State(state): State<AppState>,
    Path(asin): Path<String>,
) -> Result<Json<JobCreated>, ApiError> {
    let asin = asin.trim().to_string();
    if asin.is_empty() {
        return Err(ApiError::bad_request("Missing Audible product id."));
    }

    let config = state.libation_config.clone();
    if !config.enabled() {
        return Err(ApiError::bad_request(
            "Libation CLI was not found. Set libation_cli_path in server.config or put libationcli on PATH.",
        ));
    }

    let job_id = create_job(&state, "libation-liberate").await;
    let state_for_job = state.clone();
    let job_id_for_task = job_id.clone();
    tokio::spawn(async move {
        update_job_output(
            &state_for_job,
            &job_id_for_task,
            &format!("Starting Libation liberation for {asin}.\n"),
        )
        .await;

        let books_override = format!("Books={}", config.library_root.to_string_lossy());
        let result = run_libation(
            &config,
            vec![
                "liberate".to_string(),
                "--id".to_string(),
                asin,
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

async fn get_job(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> Result<Json<JobStatus>, ApiError> {
    state
        .jobs
        .read()
        .await
        .get(&job_id)
        .cloned()
        .map(Json)
        .ok_or(ApiError::not_found("Job not found"))
}

async fn get_book(
    State(state): State<AppState>,
    Path(book_id): Path<String>,
) -> Result<Json<Book>, ApiError> {
    let library = state.library.read().await;
    let book = library
        .books
        .iter()
        .find(|candidate| candidate.id == book_id)
        .cloned()
        .ok_or(ApiError::not_found("Book not found"))?;
    Ok(Json(book))
}

async fn get_cover_art(
    State(state): State<AppState>,
    Path(book_id): Path<String>,
) -> Result<Response, ApiError> {
    let library = state.library.read().await;
    let cover = library
        .cover_art
        .get(&book_id)
        .ok_or(ApiError::not_found("Cover art not found"))?;

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, cover.mime_type.clone())
        .header(CONTENT_LENGTH, cover.data.len().to_string())
        .body(Body::from(cover.data.clone()))?)
}

async fn get_reading_file(
    State(state): State<AppState>,
    Path(book_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
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

    serve_file_response(&file_path, headers, None).await
}

async fn get_progress(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
) -> Result<Response, ApiError> {
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

    let mut progress = read_progress(&state.progress_file).await?;
    let key = progress_key(&auth.id, &book.id);
    let previous_position = progress
        .get(&key)
        .map(|previous| previous.book_position_seconds)
        .unwrap_or(0.0);
    let saved = Progress {
        book_id: book.id.clone(),
        track_id: track.id.clone(),
        position_seconds: update.position_seconds.max(0.0),
        book_position_seconds: update
            .book_position_seconds
            .unwrap_or_else(|| book_position_seconds(book, track, update.position_seconds))
            .max(0.0),
        duration_seconds: update.duration_seconds.or(track.duration_seconds),
        updated_at: now_rfc3339ish(),
    };
    progress.insert(key, saved.clone());
    write_progress(&state.progress_file, &progress).await?;

    let listened_delta = (saved.book_position_seconds - previous_position).max(0.0);
    if listened_delta > 0.0 && listened_delta < 4.0 * 3600.0 {
        record_activity(&state, &auth.id, listened_delta).await;
    }

    Ok(Json(saved))
}

async fn stream_track(
    State(state): State<AppState>,
    Path((book_id, track_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
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

    serve_file_response(&file_path, headers, None).await
}

async fn serve_file_response(
    file_path: &FsPath,
    headers: HeaderMap,
    content_disposition: Option<String>,
) -> Result<Response, ApiError> {
    let metadata = fs::metadata(file_path).await?;
    let file_size = metadata.len();
    if file_size == 0 {
        return Err(ApiError::range_not_satisfiable(file_size));
    }

    let content_type = mime_guess::from_path(file_path)
        .first_or_octet_stream()
        .to_string();

    let requested_range = headers
        .get(RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_range(value, file_size));

    let (status, start, end) = match requested_range {
        Some(range) => (StatusCode::PARTIAL_CONTENT, range.0, range.1),
        None => (StatusCode::OK, 0, file_size - 1),
    };

    let mut file = fs::File::open(file_path).await?;
    file.seek(SeekFrom::Start(start)).await?;
    let stream = ReaderStream::new(file.take(end - start + 1));
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

async fn download_book(
    State(state): State<AppState>,
    Path(book_id): Path<String>,
) -> Result<Response, ApiError> {
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

    let zip_path = tokio::task::spawn_blocking(move || -> anyhow::Result<PathBuf> {
        let temp = tempfile::Builder::new()
            .prefix("operalibre-")
            .suffix(".zip")
            .tempfile()?;
        let (file, path) = temp.keep()?;
        let mut writer = zip::ZipWriter::new(file);
        let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .large_file(true);
        for (file_name, source_path) in tracks {
            writer.start_file(sanitize_zip_entry(&file_name), options)?;
            let mut source = std::fs::File::open(&source_path)?;
            std::io::copy(&mut source, &mut writer)?;
        }
        writer.finish()?;
        Ok(path)
    })
    .await
    .map_err(|error| ApiError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        message: error.to_string(),
    })??;

    let file = fs::File::open(&zip_path).await?;
    let metadata = file.metadata().await?;
    let file_size = metadata.len();

    let cleanup_path = zip_path.clone();
    tokio::spawn(async move {
        let _ = fs::remove_file(cleanup_path).await;
    });

    let safe_filename = sanitize_filename(&book_title);
    let stream = ReaderStream::new(file);
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
    if normalize_asin(candidate).is_none() {
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

async fn rescan_library(state: &AppState) -> anyhow::Result<()> {
    let files = walk_audio_files(&state.library_root);
    let groups = group_files_into_books(&state.library_root, files);
    let mut track_paths = HashMap::new();
    let mut reading_paths = HashMap::new();
    let mut cover_art = HashMap::new();
    let mut books = Vec::new();

    for (group_key, grouped_files) in groups {
        let book_id = stable_id(&group_key.to_string_lossy());
        let metadata = grouped_files
            .iter()
            .map(|file_path| read_track_metadata(file_path))
            .collect::<Vec<_>>();

        let tracks = grouped_files
            .iter()
            .enumerate()
            .map(|(index, file_path)| {
                let track_id = stable_id(&file_path.to_string_lossy());
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
        let title = clean_imported_title(&raw_title);

        let cover_art_url = metadata
            .iter()
            .find_map(|item| item.cover_art.clone())
            .map(|image| {
                cover_art.insert(book_id.clone(), image);
                format!("/api/books/{book_id}/cover")
            });
        let metadata_summary = merge_metadata_summary(&metadata);
        let mut book_chapters = build_book_chapters(&tracks);
        if book_chapters.is_empty() && tracks.len() > 1 {
            book_chapters = derive_track_chapters(&tracks);
        }
        let reading_file = find_reading_file(&book_id, &group_key, &grouped_files, &title);
        if let Some(reading_file) = reading_file.as_ref() {
            reading_paths.insert(reading_file.file.id.clone(), reading_file.path.clone());
        }

        books.push(Book {
            id: book_id,
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
            chapters: book_chapters,
            metadata: metadata_summary,
            tracks,
            progress: None,
        });
    }

    let mut library = state.library.write().await;
    library.books = books;
    library.track_paths = track_paths;
    library.reading_paths = reading_paths;
    library.cover_art = cover_art;
    Ok(())
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

fn walk_audio_files(root: &FsPath) -> Vec<PathBuf> {
    let mut files = WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
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

    TrackMetadata {
        title: tag
            .and_then(|tag| tag.title().map(|value| value.to_string()))
            .or_else(|| summary.album.clone()),
        author: tag
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
            .or_else(|| tag.and_then(|tag| tag.artist().map(|value| value.to_string()))),
        narrator: tag
            .and_then(extract_narrator)
            .or_else(|| tag.and_then(extract_vendor_narrator)),
        duration_seconds: Some(tagged_file.properties().duration().as_secs_f64()),
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
        .find_map(normalize_asin)
}

fn normalize_asin(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_matches(char::from(0));
    if trimmed.len() == 10
        && trimmed.starts_with('B')
        && trimmed
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        Some(trimmed.to_ascii_uppercase())
    } else {
        None
    }
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
        genres: collect_genres(tag),
        raw_fields: collect_raw_fields(tag),
    }
}

fn first_tag_text(tag: &Tag, keys: &[ItemKey]) -> Option<String> {
    keys.iter()
        .find_map(|key| tag.get_string(key))
        .map(clean_metadata_text)
        .filter(|value| !value.is_empty())
}

fn collect_genres(tag: &Tag) -> Vec<String> {
    tag.get_strings(&ItemKey::Genre)
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

fn item_key_label(key: &ItemKey) -> String {
    match key {
        ItemKey::Unknown(value) => value.clone(),
        known => format!("{known:?}"),
    }
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
    })
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

async fn books_with_progress(state: &AppState, user_id: &str) -> Result<Vec<Book>, ApiError> {
    let saved_progress = read_progress(&state.progress_file).await?;
    let books = state.library.read().await.books.clone();
    Ok(books
        .into_iter()
        .map(|mut book| {
            book.progress = saved_progress
                .get(&progress_key(user_id, &book.id))
                .map(|progress| summarize_book_progress(&book, progress));
            book
        })
        .collect())
}

fn summarize_book_progress(book: &Book, progress: &Progress) -> BookProgress {
    let enriched = enrich_progress(book, progress);
    let duration = book.duration_seconds.or_else(|| {
        let total = duration_from_tracks(book);
        (total > 0.0).then_some(total)
    });
    let position = duration
        .map(|duration| enriched.book_position_seconds.clamp(0.0, duration))
        .unwrap_or_else(|| enriched.book_position_seconds.max(0.0));
    let remaining = duration.map(|duration| (duration - position).max(0.0));
    let percent_complete = duration
        .filter(|duration| *duration > 0.0)
        .map(|duration| ((position / duration) * 100.0).clamp(0.0, 100.0));
    let status = match (duration, remaining, position) {
        (Some(duration), Some(remaining), _) if duration > 0.0 && remaining <= 30.0 => {
            BookProgressStatus::Finished
        }
        (Some(duration), _, position) if duration > 0.0 && position / duration >= 0.995 => {
            BookProgressStatus::Finished
        }
        (_, _, position) if position > 0.0 => BookProgressStatus::InProgress,
        _ => BookProgressStatus::NotStarted,
    };

    BookProgress {
        status,
        book_position_seconds: position,
        duration_seconds: duration,
        remaining_seconds: remaining,
        percent_complete,
        updated_at: enriched.updated_at,
    }
}

fn duration_from_tracks(book: &Book) -> f64 {
    book.tracks
        .iter()
        .map(|track| track.duration_seconds.unwrap_or(0.0))
        .sum()
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
    if let Some(parent) = progress_file.parent() {
        fs::create_dir_all(parent).await?;
    }
    fs::write(progress_file, serde_json::to_vec_pretty(progress)?).await?;
    Ok(())
}

#[derive(Debug, Clone)]
struct LibationConfig {
    cli_path: Option<PathBuf>,
    libation_files_dir: Option<PathBuf>,
    library_root: PathBuf,
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
        }
    }

    fn enabled(&self) -> bool {
        self.cli_path.is_some()
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
        };
    };

    match run_libation(
        &config,
        vec!["list-accounts".to_string(), "--bare".to_string()],
    )
    .await
    {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let accounts = parse_libation_accounts(&stdout);
            let authenticated =
                !accounts.is_empty() && accounts.iter().all(|account| account.authenticated);
            let message = if accounts.is_empty() {
                Some("No Libation accounts are configured.".to_string())
            } else if !authenticated {
                Some("One or more Libation accounts need to be authenticated again.".to_string())
            } else if !stderr.trim().is_empty() {
                Some(stderr.trim().to_string())
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
            }
        }
        Ok(output) => LibationStatus {
            enabled: true,
            cli_path: Some(cli_path.to_string_lossy().to_string()),
            libation_files_dir: config
                .libation_files_dir
                .as_ref()
                .map(|path| path.to_string_lossy().to_string()),
            library_root: state.library_root.to_string_lossy().to_string(),
            accounts: Vec::new(),
            authenticated: false,
            message: Some(command_output_text(&output)),
        },
        Err(error) => LibationStatus {
            enabled: true,
            cli_path: Some(cli_path.to_string_lossy().to_string()),
            libation_files_dir: config
                .libation_files_dir
                .as_ref()
                .map(|path| path.to_string_lossy().to_string()),
            library_root: state.library_root.to_string_lossy().to_string(),
            accounts: Vec::new(),
            authenticated: false,
            message: Some(error.to_string()),
        },
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
                account_id: columns[0].trim().to_string(),
                name: non_empty_string(columns[1]),
                locale: columns[2].trim().to_string(),
                scan_library: yes_no(columns[3]),
                authenticated: yes_no(columns[4]),
            })
        })
        .collect()
}

fn yes_no(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case("yes") || value.trim().eq_ignore_ascii_case("true")
}

async fn export_libation_books(config: &LibationConfig) -> Result<Vec<LibationBook>, ApiError> {
    let export_path = env::temp_dir().join(format!(
        "operalibre-libation-export-{}.json",
        now_rfc3339ish()
    ));
    let output = run_libation(
        config,
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
    let _ = fs::remove_file(&export_path).await;
    let records = serde_json::from_str::<Vec<LibationExportRecord>>(&contents)?;
    Ok(records
        .into_iter()
        .filter_map(|record| {
            let asin = non_empty_string(record.audible_product_id?)?;
            Some(LibationBook {
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
                locale: non_empty_string(record.locale.unwrap_or_default()),
                last_downloaded: non_empty_string(record.last_downloaded.unwrap_or_default()),
                is_audible_plus: record.is_audible_plus.unwrap_or(false),
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
    let id = stable_id(&format!(
        "{kind}:{}:{}",
        now_rfc3339ish(),
        state.jobs.read().await.len()
    ));
    let job = JobStatus {
        id: id.clone(),
        kind: kind.to_string(),
        status: "running".to_string(),
        started_at: now_rfc3339ish(),
        finished_at: None,
        exit_code: None,
        output: String::new(),
        error: None,
    };
    state.jobs.write().await.insert(id.clone(), job);
    id
}

async fn update_job_output(state: &AppState, job_id: &str, text: &str) {
    if let Some(job) = state.jobs.write().await.get_mut(job_id) {
        job.output.push_str(text);
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
    if let Some(job) = state.jobs.write().await.get_mut(job_id) {
        job.status = status.to_string();
        job.finished_at = Some(now_rfc3339ish());
        job.exit_code = exit_code;
        job.error = error;
    }
}

fn stable_id(input: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(input.as_bytes());
    format!("{:x}", hasher.finalize())[..16].to_string()
}

fn progress_key(user_id: &str, book_id: &str) -> String {
    format!("user:{user_id}:book:{book_id}")
}

fn parse_range(range: &str, file_size: u64) -> Option<(u64, u64)> {
    let range = range.strip_prefix("bytes=")?;
    let (start, end) = range.split_once('-')?;

    if start.is_empty() {
        let suffix_length = end.parse::<u64>().ok()?;
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

fn now_rfc3339ish() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| format!("{}", duration.as_secs()))
        .unwrap_or_else(|_| "0".to_string())
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
        Ok(contents) => Ok(serde_json::from_str(&contents)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(ActivityStore::default()),
        Err(error) => Err(error.into()),
    }
}

async fn write_activity_store(
    activity_file: &FsPath,
    store: &ActivityStore,
) -> Result<(), ApiError> {
    if let Some(parent) = activity_file.parent() {
        fs::create_dir_all(parent).await?;
    }
    fs::write(activity_file, serde_json::to_vec_pretty(store)?).await?;
    Ok(())
}

fn today_ymd_utc() -> String {
    // Year-month-day in UTC, no extra deps. Uses civil-date conversion from
    // days-since-epoch (1970-01-01) via Howard Hinnant's algorithm.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    days_to_ymd((now / 86_400) as i64)
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

async fn record_activity(state: &AppState, user_id: &str, delta_seconds: f64) {
    let today = today_ymd_utc();
    {
        let mut activity = state.activity.write().await;
        let entry = activity
            .by_user
            .entry(user_id.to_string())
            .or_default()
            .entry(today)
            .or_insert(0.0);
        *entry += delta_seconds;
    }

    let snapshot = {
        let activity = state.activity.read().await;
        ActivityStore {
            by_user: activity.by_user.clone(),
        }
    };
    if let Err(error) = write_activity_store(&state.activity_file, &snapshot).await {
        tracing::warn!("failed to persist activity log: {}", error.message);
    }
}

async fn profile_stats(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<ProfileStats>, ApiError> {
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
    let mut hours_from_positions = 0.0;
    let mut narrator_hours: HashMap<String, f64> = HashMap::new();
    let mut genre_hours: HashMap<String, f64> = HashMap::new();
    let mut last_updated: Option<String> = None;

    let mut book_lookup: HashMap<&str, &Book> = HashMap::new();
    for book in library.books.iter() {
        book_lookup.insert(book.id.as_str(), book);
    }

    let mut recent: Vec<RecentBook> = Vec::new();
    for (_, progress) in user_progress.iter() {
        if let Some(book) = book_lookup.get(progress.book_id.as_str()) {
            let summary = summarize_book_progress(book, progress);
            let hours = summary.book_position_seconds / 3600.0;
            hours_from_positions += summary.book_position_seconds;
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
            match &last_updated {
                Some(prev) if prev >= &progress.updated_at => {}
                _ => last_updated = Some(progress.updated_at.clone()),
            }
        }
    }

    recent.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    recent.truncate(6);

    // Activity-based numbers.
    let activity = state.activity.read().await;
    let user_activity = activity.by_user.get(&auth.id).cloned().unwrap_or_default();

    let total_seconds_activity: f64 = user_activity.values().sum();
    let total_hours_read = if total_seconds_activity > 0.0 {
        total_seconds_activity / 3600.0
    } else {
        hours_from_positions / 3600.0
    };

    let days_active = user_activity
        .values()
        .filter(|seconds| **seconds > 30.0)
        .count() as u32;

    let avg_daily_minutes = if days_active > 0 {
        (total_hours_read * 60.0) / days_active as f64
    } else {
        0.0
    };

    let (current_streak_days, longest_streak_days) = compute_streaks(&user_activity);
    let streak_calendar = build_streak_calendar(&user_activity, 56);

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
        streak_calendar,
        recent_books: recent,
    }))
}

fn compute_streaks(activity: &BTreeMap<String, f64>) -> (u32, u32) {
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

    let today = ymd_to_days(&today_ymd_utc()).unwrap_or(0);
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

fn build_streak_calendar(activity: &BTreeMap<String, f64>, days: i64) -> Vec<StreakDay> {
    let today = ymd_to_days(&today_ymd_utc()).unwrap_or(0);
    let start = today - (days - 1);
    (0..days)
        .map(|offset| {
            let day = start + offset;
            let date = days_to_ymd(day);
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
        Ok(contents) => Ok(serde_json::from_str(&contents)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(UsersStore::default()),
        Err(error) => Err(error.into()),
    }
}

async fn write_users_store(users_file: &FsPath, store: &UsersStore) -> Result<(), ApiError> {
    if let Some(parent) = users_file.parent() {
        fs::create_dir_all(parent).await?;
    }
    fs::write(users_file, serde_json::to_vec_pretty(store)?).await?;
    Ok(())
}

async fn load_sessions_store(sessions_file: &FsPath) -> anyhow::Result<HashMap<String, Session>> {
    match fs::read_to_string(sessions_file).await {
        Ok(contents) => Ok(serde_json::from_str(&contents)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(error) => Err(error.into()),
    }
}

async fn write_sessions_store(
    sessions_file: &FsPath,
    sessions: &HashMap<String, Session>,
) -> Result<(), ApiError> {
    if let Some(parent) = sessions_file.parent() {
        fs::create_dir_all(parent).await?;
    }
    fs::write(sessions_file, serde_json::to_vec_pretty(sessions)?).await?;
    Ok(())
}

fn hash_password(password: &str) -> Result<String, ApiError> {
    let salt = SaltString::generate(&mut OsRng);
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

fn generate_session_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn normalize_username(value: &str) -> String {
    value.trim().to_string()
}

fn validate_password(password: &str) -> Result<(), ApiError> {
    if password.chars().count() < 6 {
        return Err(ApiError::bad_request(
            "Password must be at least 6 characters long.",
        ));
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

fn session_cookie(token: &str) -> String {
    format!(
        "{SESSION_COOKIE_NAME}={token}; Path=/; Max-Age={SESSION_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax"
    )
}

fn expired_session_cookie() -> String {
    format!("{SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax")
}

fn extract_request_token(req: &Request) -> Option<String> {
    if let Some(token) = token_from_headers(req.headers()) {
        return Some(token);
    }
    let query = req.uri().query()?;
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        if key == "token" && !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

async fn resolve_session(state: &AppState, token: &str) -> Option<AuthUser> {
    let sessions = state.sessions.read().await;
    let session = sessions.get(token)?.clone();
    drop(sessions);
    let users = state.users.read().await;
    users
        .users
        .iter()
        .find(|user| user.id == session.user_id)
        .map(|user| AuthUser {
            id: user.id.clone(),
            username: user.username.clone(),
            is_admin: user.is_admin,
        })
}

async fn auth_middleware(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let Some(token) = extract_request_token(&req) else {
        return Err(ApiError::unauthorized("Missing authentication token."));
    };
    let Some(user) = resolve_session(&state, &token).await else {
        return Err(ApiError::unauthorized("Session is invalid or expired."));
    };
    req.extensions_mut().insert(user);
    Ok(next.run(req).await)
}

async fn auth_status(State(state): State<AppState>, headers: HeaderMap) -> Json<AuthStatus> {
    let setup_required = state.users.read().await.users.is_empty();
    let user = if let Some(token) = token_from_headers(&headers) {
        resolve_session(&state, &token)
            .await
            .map(|auth| UserPublic {
                id: auth.id,
                username: auth.username,
                is_admin: auth.is_admin,
                created_at: String::new(),
            })
    } else {
        None
    };

    Json(AuthStatus {
        setup_required,
        user,
    })
}

async fn setup_admin(
    State(state): State<AppState>,
    Json(payload): Json<SetupRequest>,
) -> Result<impl IntoResponse, ApiError> {
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
        password_hash: hash_password(&payload.password)?,
        is_admin: true,
        created_at: now_rfc3339ish(),
    };

    {
        let mut users = state.users.write().await;
        users.users.push(new_user.clone());
        write_users_store(&state.users_file, &users).await?;
    }

    let token = create_session(&state, &new_user.id).await?;
    let mut headers = HeaderMap::new();
    headers.insert(
        SET_COOKIE,
        HeaderValue::from_str(&session_cookie(&token))
            .map_err(|error| ApiError::internal(format!("Invalid session cookie: {error}")))?,
    );
    Ok((
        headers,
        Json(LoginResponse {
            token,
            user: UserPublic::from(&new_user),
        }),
    ))
}

async fn login(
    State(state): State<AppState>,
    Json(payload): Json<LoginRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let username = normalize_username(&payload.username);
    let matched_user = {
        let users = state.users.read().await;
        users
            .users
            .iter()
            .find(|user| user.username.eq_ignore_ascii_case(&username))
            .cloned()
    };

    let Some(user) = matched_user else {
        return Err(ApiError::unauthorized("Invalid username or password."));
    };
    if !verify_password(&payload.password, &user.password_hash) {
        return Err(ApiError::unauthorized("Invalid username or password."));
    }

    let token = create_session(&state, &user.id).await?;
    let mut headers = HeaderMap::new();
    headers.insert(
        SET_COOKIE,
        HeaderValue::from_str(&session_cookie(&token))
            .map_err(|error| ApiError::internal(format!("Invalid session cookie: {error}")))?,
    );
    Ok((
        headers,
        Json(LoginResponse {
            token,
            user: UserPublic::from(&user),
        }),
    ))
}

async fn create_session(state: &AppState, user_id: &str) -> Result<String, ApiError> {
    let token = generate_session_token();
    let session = Session {
        user_id: user_id.to_string(),
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    };
    let mut sessions = state.sessions.write().await;
    sessions.insert(token.clone(), session);
    write_sessions_store(&state.sessions_file, &sessions).await?;
    Ok(token)
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
        HeaderValue::from_str(&expired_session_cookie())
            .map_err(|error| ApiError::internal(format!("Invalid session cookie: {error}")))?,
    );
    Ok((response_headers, Json(serde_json::json!({ "ok": true }))))
}

async fn me(Extension(auth): Extension<AuthUser>) -> Json<UserPublic> {
    Json(UserPublic {
        id: auth.id,
        username: auth.username,
        is_admin: auth.is_admin,
        created_at: String::new(),
    })
}

fn require_admin(auth: &AuthUser) -> Result<(), ApiError> {
    if auth.is_admin {
        Ok(())
    } else {
        Err(ApiError::forbidden("Administrator access is required."))
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
        password_hash: hash_password(&payload.password)?,
        is_admin: payload.is_admin,
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
    let original_len = users.users.len();
    users.users.retain(|user| user.id != user_id);
    if users.users.len() == original_len {
        return Err(ApiError::not_found("User not found."));
    }
    write_users_store(&state.users_file, &users).await?;
    drop(users);

    let mut sessions = state.sessions.write().await;
    sessions.retain(|_, session| session.user_id != user_id);
    write_sessions_store(&state.sessions_file, &sessions).await?;
    drop(sessions);

    let mut progress = read_progress(&state.progress_file).await?;
    let prefix = format!("user:{user_id}:");
    progress.retain(|key, _| !key.starts_with(&prefix));
    write_progress(&state.progress_file, &progress).await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn change_password(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
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

    if changing_self {
        let current = payload.current_password.unwrap_or_default();
        if !verify_password(&current, &user.password_hash) {
            return Err(ApiError::unauthorized("Current password is incorrect."));
        }
    }

    user.password_hash = hash_password(&payload.new_password)?;
    let target_id = user.id.clone();
    write_users_store(&state.users_file, &users).await?;
    drop(users);

    if !changing_self {
        let mut sessions = state.sessions.write().await;
        sessions.retain(|_, session| session.user_id != target_id);
        write_sessions_store(&state.sessions_file, &sessions).await?;
    }

    Ok(Json(serde_json::json!({ "ok": true })))
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

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }

    fn range_not_satisfiable(file_size: u64) -> Self {
        Self {
            status: StatusCode::RANGE_NOT_SATISFIABLE,
            message: format!("Requested range not satisfiable for {file_size} bytes"),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            [(CONTENT_TYPE, HeaderValue::from_static("application/json"))],
            Json(serde_json::json!({ "message": self.message })),
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
    use super::clean_imported_title;

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
}
