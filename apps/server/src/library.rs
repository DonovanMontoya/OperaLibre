use crate::*;

pub(crate) const AUDIO_EXTENSIONS: &[&str] = &[
    "aac", "aiff", "flac", "m4a", "m4b", "mp3", "mp4", "ogg", "opus", "wav",
];

pub(crate) const FFMPEG_TRACK_INPUT_OPTIONS: [&str; 4] = [
    "-protocol_whitelist",
    "file",
    "-format_whitelist",
    "aac,aiff,flac,mov,mp3,ogg,wav",
];

pub(crate) const SYNC_SIDECAR_SUFFIX: &str = ".sync.json";
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct MetadataOverrideStore {
    pub(crate) books: HashMap<String, BookMetadataOverride>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BookMetadataOverride {
    pub(crate) ebook_file_name: Option<String>,
    pub(crate) cover_file_name: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) author: Option<String>,
    pub(crate) narrator: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) genres: Option<Vec<String>>,
    pub(crate) published_date: Option<String>,
    pub(crate) publisher: Option<String>,
    pub(crate) series: Option<String>,
    pub(crate) series_position: Option<String>,
    pub(crate) tags: Option<Vec<BookTag>>,
    pub(crate) asin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) sync_language: Option<String>,
}

#[derive(Default)]
pub(crate) struct LibraryState {
    pub(crate) books: Vec<Book>,
    pub(crate) book_paths: HashMap<String, PathBuf>,
    pub(crate) track_paths: HashMap<String, PathBuf>,
    pub(crate) reading_paths: HashMap<String, PathBuf>,
    pub(crate) companion_analyses: AnalysisCache,
    pub(crate) sync_paths: HashMap<String, PathBuf>,
    pub(crate) cover_art: HashMap<String, CachedCover>,
    pub(crate) embedded_cover_art: HashMap<String, CachedCover>,
    pub(crate) startup_scan_pending: bool,
    pub(crate) catalogue_ready: bool,
    pub(crate) catalogue_error: bool,
}

impl LibraryState {
    pub(crate) fn book(&self, book_id: &str) -> Result<&Book, ApiError> {
        self.books
            .iter()
            .find(|candidate| candidate.id == book_id)
            .ok_or(ApiError::not_found("Book not found"))
    }
}

#[derive(Debug, Clone)]
pub(crate) struct CachedCover {
    pub(crate) mime_type: String,
    pub(crate) etag: String,
    pub(crate) path: PathBuf,
    pub(crate) len: u64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryIdentityStore {
    #[serde(default)]
    pub(crate) version: u32,
    #[serde(default)]
    pub(crate) books: Vec<BookIdentity>,
    #[serde(default)]
    pub(crate) fingerprint_cache: BTreeMap<String, BTreeMap<String, CachedFingerprint>>,
    #[serde(default)]
    pub(crate) scan_counter: u64,
    #[serde(default)]
    pub(crate) manifests: BTreeMap<String, RootManifest>,
    #[serde(default)]
    pub(crate) pending_shrink: BTreeMap<String, PendingShrink>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingShrink {
    pub(crate) book_count: usize,
    #[serde(default)]
    pub(crate) signature: String,
    pub(crate) observations: u32,
}

pub(crate) const SHRINK_CONFIRMATIONS: u32 = 3;

pub(crate) const DEFAULT_ROOT_ID: &str = "default";

pub(crate) const IDENTITY_FORMAT_VERSION: u32 = 1;

const MAX_FINGERPRINT_HISTORY: usize = 8;

const LAYOUT_DURATION_TOLERANCE: f64 = 0.01;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RootManifest {
    #[serde(default)]
    pub(crate) book_fingerprints: Vec<String>,
    #[serde(default)]
    pub(crate) scan: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IdentityPath {
    pub(crate) root_id: String,
    pub(crate) relative_path: String,
}

impl IdentityPath {
    pub(crate) fn new(root_id: &str, relative_path: &str) -> Self {
        Self {
            root_id: root_id.to_string(),
            relative_path: relative_path.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CachedFingerprint {
    pub(crate) fingerprint: String,
    pub(crate) size: u64,
    pub(crate) modified_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BookIdentity {
    pub(crate) fingerprint: String,
    #[serde(default)]
    pub(crate) fingerprint_history: Vec<String>,
    pub(crate) book_id: String,
    #[serde(default)]
    pub(crate) paths: Vec<IdentityPath>,
    #[serde(default)]
    pub(crate) tracks: Vec<TrackIdentity>,
    #[serde(default)]
    pub(crate) last_seen_scan: u64,
    #[serde(default)]
    pub(crate) track_count: usize,
    #[serde(default)]
    pub(crate) duration_seconds: Option<f64>,
    #[serde(default)]
    pub(crate) added_at: u64,
}

impl BookIdentity {
    pub(crate) fn matches_fingerprint(&self, fingerprint: &str) -> bool {
        self.fingerprint == fingerprint
            || self
                .fingerprint_history
                .iter()
                .any(|candidate| candidate == fingerprint)
    }

    pub(crate) fn record_fingerprint(&mut self, fingerprint: &str) {
        if self.fingerprint == fingerprint {
            return;
        }
        let previous = std::mem::replace(&mut self.fingerprint, fingerprint.to_string());
        self.fingerprint_history
            .retain(|candidate| candidate != &previous && candidate != fingerprint);
        self.fingerprint_history.push(previous);
        let excess = self
            .fingerprint_history
            .len()
            .saturating_sub(MAX_FINGERPRINT_HISTORY);
        self.fingerprint_history.drain(..excess);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrackIdentity {
    pub(crate) fingerprint: String,
    pub(crate) track_id: String,
    #[serde(default)]
    pub(crate) paths: Vec<IdentityPath>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Track {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) file_name: String,
    pub(crate) index: usize,
    pub(crate) duration_seconds: Option<f64>,
    pub(crate) stream_url: String,
    pub(crate) chapters: Vec<Chapter>,
    pub(crate) metadata: MetadataSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Book {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) author: Option<String>,
    pub(crate) narrator: Option<String>,
    pub(crate) duration_seconds: Option<f64>,
    pub(crate) track_count: usize,
    pub(crate) cover_art_url: Option<String>,
    pub(crate) has_cover_override: bool,
    pub(crate) cover_art_content_type: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) genres: Vec<String>,
    pub(crate) tags: Vec<BookTag>,
    pub(crate) published_date: Option<String>,
    pub(crate) asin: Option<String>,
    pub(crate) added_at: String,
    pub(crate) reading_file: Option<ReadingFile>,
    pub(crate) companions: Vec<CompanionFile>,
    pub(crate) sync_file: Option<SyncFile>,
    pub(crate) chapters: Vec<Chapter>,
    pub(crate) metadata: MetadataSummary,
    pub(crate) tracks: Vec<Track>,
    pub(crate) progress: Option<BookProgress>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) shared_progress: Vec<SharedProgress>,
    pub(crate) volume_gain: f64,
    pub(crate) volume_gain_source: VolumeGainSource,
    pub(crate) auto_volume: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) audio_analysis: Option<AudioAnalysis>,
    #[serde(skip)]
    pub(crate) audio_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BookTag {
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) position: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadingFile {
    pub(crate) id: String,
    pub(crate) file_name: String,
    pub(crate) extension: String,
    pub(crate) content_type: String,
    pub(crate) url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncFile {
    pub(crate) outdated: bool,
    pub(crate) file_name: String,
    pub(crate) source: String,
    pub(crate) url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) quality: Option<sync_report::SyncQuality>,
    #[serde(skip)]
    pub(crate) report_current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Chapter {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) track_id: String,
    pub(crate) track_index: usize,
    pub(crate) start_seconds: f64,
    pub(crate) end_seconds: Option<f64>,
    pub(crate) source: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetadataSummary {
    pub(crate) album: Option<String>,
    pub(crate) subtitle: Option<String>,
    pub(crate) publisher: Option<String>,
    pub(crate) published_date: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) language: Option<String>,
    pub(crate) series: Option<String>,
    pub(crate) series_position: Option<String>,
    pub(crate) genres: Vec<String>,
    pub(crate) raw_fields: Vec<MetadataField>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetadataField {
    pub(crate) key: String,
    pub(crate) value: String,
    pub(crate) description: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct EmbeddedImage {
    pub(crate) mime_type: String,
    pub(crate) data: Vec<u8>,
    pub(crate) etag: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BookMetadataUpdate {
    pub(crate) title: String,
    pub(crate) author: Option<String>,
    pub(crate) narrator: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) genres: Vec<String>,
    pub(crate) published_date: Option<String>,
    pub(crate) publisher: Option<String>,
    pub(crate) series: Option<String>,
    pub(crate) series_position: Option<String>,
    #[serde(default)]
    pub(crate) tags: Option<Vec<BookTag>>,
    pub(crate) asin: Option<String>,
}

#[derive(Default, Serialize)]
pub(crate) struct TrackMetadata {
    pub(crate) title: Option<String>,
    pub(crate) author: Option<String>,
    pub(crate) narrator: Option<String>,
    pub(crate) duration_seconds: Option<f64>,
    pub(crate) asin: Option<String>,
    pub(crate) chapters: Vec<ParsedChapter>,
    #[serde(skip)]
    pub(crate) cover_art: Option<EmbeddedImage>,
    pub(crate) summary: MetadataSummary,
}

#[derive(Default, Serialize)]
pub(crate) struct ParsedChapter {
    pub(crate) title: String,
    pub(crate) start_seconds: f64,
    pub(crate) end_seconds: Option<f64>,
    pub(crate) source: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListBooksQuery {
    pub(crate) limit: Option<usize>,
    pub(crate) cursor: Option<String>,
}

const MAX_BOOKS_PAGE: usize = 500;

pub(crate) async fn ensure_startup_scan_finished(state: &AppState) -> Result<(), ApiError> {
    if !state.library.read().await.catalogue_ready {
        return Err(ApiError::service_unavailable(
            "The library is still being scanned.",
        ));
    }
    Ok(())
}

pub(crate) async fn list_books(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Query(query): Query<ListBooksQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let lease = CatalogueLease::acquire(&state, &auth).await?;
    catalogue_books_response(&state, auth, query, headers, lease).await
}

async fn catalogue_books_response(
    state: &AppState,
    auth: AuthUser,
    query: ListBooksQuery,
    headers: HeaderMap,
    lease: CatalogueLease,
) -> Result<Response, ApiError> {
    ensure_startup_scan_finished(state).await?;
    let library = state.library.clone().read_owned().await;
    let start = query
        .limit
        .and(query.cursor.as_deref())
        .and_then(|cursor| {
            library
                .books
                .iter()
                .position(|book| book.id == cursor && can_access_book(&auth, &book.id))
        })
        .map_or(0, |index| index + 1);
    let limit = query
        .limit
        .map_or(usize::MAX, |limit| limit.clamp(1, MAX_BOOKS_PAGE));
    let mut visible = library.books[start..]
        .iter()
        .filter(|book| can_access_book(&auth, &book.id));
    let selected: Vec<&Book> = visible.by_ref().take(limit).collect();
    let next_cursor = visible
        .next()
        .and_then(|_| selected.last().map(|book| book.id.clone()));
    let enrichment = ProgressEnrichment::load(state, &auth, &selected).await?;
    drop(selected);
    tokio::task::spawn_blocking(move || {
        let mut spool = CatalogueSpool::new(lease)?;
        spool.bytes(b"[")?;
        for (index, book) in library.books[start..]
            .iter()
            .filter(|book| can_access_book(&auth, &book.id))
            .take(limit)
            .enumerate()
        {
            spool.begin_item();
            if index > 0 {
                spool.bytes(b",")?;
            }
            spool.json(&enrichment.apply_catalogue(book)?)?;
            spool.finish_item()?;
        }
        spool.bytes(b"]")?;
        let suffix = next_cursor
            .as_ref()
            .map_or_else(|| "\nend".to_string(), |cursor| format!("\nnext:{cursor}"));
        let etag = spool.etag(suffix.as_bytes());
        if if_none_match_matches(&headers, &etag) {
            return Ok(Response::builder()
                .status(StatusCode::NOT_MODIFIED)
                .header(ETAG, etag)
                .header(CACHE_CONTROL, "private, no-cache")
                .body(Body::empty())?);
        }
        spool.response("application/json", Some(&etag), next_cursor.as_deref())
    })
    .await
    .map_err(|_| ApiError::internal("Catalogue generation was interrupted."))?
}

pub(crate) async fn rescan(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
) -> Result<Response, ApiError> {
    let lease = CatalogueLease::acquire(&state, &auth).await?;
    rescan_library(&state).await?;
    catalogue_books_response(
        &state,
        auth,
        ListBooksQuery {
            limit: None,
            cursor: None,
        },
        HeaderMap::new(),
        lease,
    )
    .await
}

pub(crate) async fn get_book(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
) -> Result<Json<Book>, ApiError> {
    require_book_access(&auth, &book_id)?;
    let book = state.library.read().await.book(&book_id)?.clone();
    Ok(Json(book_with_progress(&state, &auth, book).await?))
}

pub(crate) async fn update_book_metadata(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Path(book_id): Path<String>,
    Json(payload): Json<BookMetadataUpdate>,
) -> Result<Json<Book>, ApiError> {
    let mut metadata_override = metadata_override_from_update(payload)?;
    state.library.read().await.book(&book_id)?;

    state
        .metadata_overrides
        .mutate(|overrides| {
            metadata_override.cover_file_name = overrides
                .books
                .get(&book_id)
                .and_then(|existing| existing.cover_file_name.clone());
            metadata_override.ebook_file_name = overrides
                .books
                .get(&book_id)
                .and_then(|existing| existing.ebook_file_name.clone());
            metadata_override.sync_language = overrides
                .books
                .get(&book_id)
                .and_then(|existing| existing.sync_language.clone());
            if metadata_override.tags.is_none() {
                metadata_override.tags = overrides
                    .books
                    .get(&book_id)
                    .and_then(|existing| existing.tags.clone());
            }
            overrides
                .books
                .insert(book_id.clone(), metadata_override.clone());
            Ok(())
        })
        .await?;

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

pub(crate) fn clean_imported_title(value: &str) -> String {
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

pub(crate) fn trailing_bracket_pair(value: &str) -> Option<(usize, usize)> {
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

pub(crate) fn metadata_override_from_update(
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
        ebook_file_name: None,
        cover_file_name: None,
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
        tags: update.tags.map(clean_book_tags),
        asin,
        sync_language: None,
    })
}

pub(crate) fn clean_genre_list(genres: Vec<String>) -> Vec<String> {
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

pub(crate) fn clean_book_tags(tags: Vec<BookTag>) -> Vec<BookTag> {
    let mut seen = HashSet::new();
    tags.into_iter()
        .filter_map(|tag| {
            let name = clean_metadata_text(&tag.name);
            if name.is_empty() || !seen.insert(name.to_lowercase()) {
                return None;
            }
            Some(BookTag {
                name,
                position: tag.position.as_deref().and_then(optional_override_value),
            })
        })
        .collect()
}

pub(crate) fn optional_override_value(value: &str) -> Option<String> {
    let cleaned = clean_metadata_text(value);
    (!cleaned.is_empty()).then_some(cleaned)
}

pub(crate) fn apply_book_metadata_override(
    book: &mut Book,
    metadata_override: &BookMetadataOverride,
) {
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
    if let Some(tags) = metadata_override.tags.as_ref() {
        book.tags = clean_book_tags(tags.clone());
    }
    if let Some(asin) = metadata_override.asin.as_deref() {
        book.asin = optional_override_value(asin);
    }
}

pub(crate) async fn load_library_identities(path: &FsPath) -> anyhow::Result<LibraryIdentityStore> {
    match fs::read_to_string(path).await {
        Ok(contents) => {
            let LoadedIdentities { store, migrated } = parse_library_identities(&contents)?;
            if !migrated {
                return Ok(store);
            }
            let backup = path.with_extension("json.pre-v1");
            let valid_backup = match fs::read_to_string(&backup).await {
                Ok(existing) => {
                    parse_library_identities(&existing).is_ok_and(|loaded| loaded.migrated)
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => false,
                Err(error) => return Err(error.into()),
            };
            if !valid_backup {
                write_bytes_atomic(&backup, contents.as_bytes())
                    .await
                    .map_err(|error| {
                        anyhow::anyhow!(
                            "could not back up {} before migrating identities: {}",
                            path.display(),
                            error.message
                        )
                    })?;
            }
            Ok(store)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(LibraryIdentityStore {
            version: IDENTITY_FORMAT_VERSION,
            ..Default::default()
        }),
        Err(error) => Err(error.into()),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyIdentityStore {
    #[serde(default)]
    books: Vec<LegacyBookIdentity>,
    #[serde(default)]
    fingerprint_cache: BTreeMap<String, CachedFingerprint>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyBookIdentity {
    fingerprint: String,
    book_id: String,
    #[serde(default)]
    paths: Vec<String>,
    #[serde(default)]
    tracks: Vec<LegacyTrackIdentity>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyTrackIdentity {
    fingerprint: String,
    track_id: String,
    #[serde(default)]
    paths: Vec<String>,
}

#[derive(Debug)]
pub(crate) struct LoadedIdentities {
    pub(crate) store: LibraryIdentityStore,
    pub(crate) migrated: bool,
}

#[derive(Debug)]
pub(crate) struct NewerIdentityFormat {
    pub(crate) version: u64,
}

impl std::fmt::Display for NewerIdentityFormat {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "library-identities.json was written by a newer OperaLibre (format {}, this build understands {IDENTITY_FORMAT_VERSION}).",
            self.version
        )
    }
}

impl std::error::Error for NewerIdentityFormat {}

pub(crate) fn parse_library_identities(contents: &str) -> anyhow::Result<LoadedIdentities> {
    let value: serde_json::Value = serde_json::from_str(contents)?;
    let versioned = value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    if versioned >= 1 {
        if versioned > u64::from(IDENTITY_FORMAT_VERSION) {
            return Err(NewerIdentityFormat { version: versioned }.into());
        }
        return Ok(LoadedIdentities {
            store: serde_json::from_value(value)?,
            migrated: false,
        });
    }

    let legacy: LegacyIdentityStore = serde_json::from_value(value)?;
    Ok(LoadedIdentities {
        store: migrate_legacy_identities(legacy),
        migrated: true,
    })
}

fn migrate_legacy_identities(legacy: LegacyIdentityStore) -> LibraryIdentityStore {
    let books: Vec<BookIdentity> = legacy
        .books
        .into_iter()
        .map(|book| BookIdentity {
            fingerprint: book.fingerprint,
            fingerprint_history: Vec::new(),
            book_id: book.book_id,
            paths: book
                .paths
                .iter()
                .map(|path| IdentityPath::new(DEFAULT_ROOT_ID, path))
                .collect(),
            tracks: book
                .tracks
                .into_iter()
                .map(|track| TrackIdentity {
                    fingerprint: track.fingerprint,
                    track_id: track.track_id,
                    paths: track
                        .paths
                        .iter()
                        .map(|path| IdentityPath::new(DEFAULT_ROOT_ID, path))
                        .collect(),
                })
                .collect(),
            last_seen_scan: 0,
            track_count: 0,
            duration_seconds: None,
            added_at: 0,
        })
        .collect();

    let cached_aliases = legacy
        .fingerprint_cache
        .keys()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let present_fingerprints = books
        .iter()
        .filter(|book| {
            book.tracks.iter().any(|track| {
                track
                    .paths
                    .iter()
                    .any(|path| cached_aliases.contains(path.relative_path.as_str()))
            })
        })
        .map(|book| book.fingerprint.clone())
        .collect::<Vec<_>>();
    let mut manifests = BTreeMap::new();
    if !present_fingerprints.is_empty() {
        manifests.insert(
            DEFAULT_ROOT_ID.to_string(),
            RootManifest {
                book_fingerprints: present_fingerprints,
                scan: 0,
            },
        );
    }

    let mut fingerprint_cache = BTreeMap::new();
    fingerprint_cache.insert(DEFAULT_ROOT_ID.to_string(), legacy.fingerprint_cache);

    LibraryIdentityStore {
        version: IDENTITY_FORMAT_VERSION,
        books,
        fingerprint_cache,
        scan_counter: 0,
        manifests,
        pending_shrink: BTreeMap::new(),
    }
}

pub(crate) fn library_identity_path(root: &FsPath, path: &FsPath) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

pub(crate) fn remember_identity_path(paths: &mut Vec<IdentityPath>, path: IdentityPath) {
    const MAX_IDENTITY_PATH_ALIASES: usize = 32;
    paths.retain(|candidate| candidate != &path);
    paths.push(path);
    let excess = paths.len().saturating_sub(MAX_IDENTITY_PATH_ALIASES);
    paths.drain(..excess);
}

pub(crate) fn mint_identity_id() -> String {
    hex_digest(rand::random::<[u8; 16]>())
}

#[cfg(test)]
pub(crate) fn file_identity_fingerprint(path: &FsPath) -> anyhow::Result<String> {
    let root = ScanRoot::new(
        path.parent()
            .ok_or_else(|| anyhow::anyhow!("missing parent"))?,
    )?;
    file_identity_fingerprint_file(root.open(path)?.0)
}
fn file_identity_fingerprint_file(mut file: std::fs::File) -> anyhow::Result<String> {
    const SAMPLE_BYTES: usize = 64 * 1024;
    let size = file.metadata()?.len();
    let mut hasher = Sha256::new();
    hasher.update(size.to_le_bytes());

    let mut sample = vec![0_u8; SAMPLE_BYTES];
    let first_read = read_sample(&mut file, &mut sample)?;
    hasher.update((first_read as u64).to_le_bytes());
    hasher.update(&sample[..first_read]);

    if size > SAMPLE_BYTES as u64 {
        std::io::Seek::seek(&mut file, std::io::SeekFrom::End(-(SAMPLE_BYTES as i64)))?;
        let last_read = read_sample(&mut file, &mut sample)?;
        hasher.update((last_read as u64).to_le_bytes());
        hasher.update(&sample[..last_read]);
    }

    Ok(hex_digest(hasher.finalize()))
}

pub(crate) fn read_sample(
    reader: &mut impl std::io::Read,
    sample: &mut [u8],
) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < sample.len() {
        match reader.read(&mut sample[filled..]) {
            Ok(0) => break,
            Ok(count) => filled += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(filled)
}

pub(crate) fn path_identity_fingerprint(path: &FsPath) -> String {
    format!("path:{}", stable_id(&path.to_string_lossy()))
}

type ScannedFingerprint = (PathBuf, String, String, Option<(u64, u64)>);

#[cfg(test)]
pub(crate) fn fingerprint_tracks(
    library_root: &FsPath,
    files: &[PathBuf],
    previous: BTreeMap<String, CachedFingerprint>,
) -> (
    HashMap<PathBuf, String>,
    BTreeMap<String, CachedFingerprint>,
) {
    fingerprint_tracks_in(
        &ScanRoot::new(library_root).unwrap(),
        library_root,
        files,
        previous,
    )
    .unwrap()
}
fn fingerprint_tracks_in(
    root: &ScanRoot,
    library_root: &FsPath,
    files: &[PathBuf],
    previous: BTreeMap<String, CachedFingerprint>,
) -> anyhow::Result<(
    HashMap<PathBuf, String>,
    BTreeMap<String, CachedFingerprint>,
)> {
    use rayon::prelude::*;

    let scanned: Vec<ScannedFingerprint> = files
        .par_iter()
        .map(|path| {
            let alias = library_identity_path(library_root, path);
            let (file, metadata) = root.open(path)?;
            let stat = Some({
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
                None => file_identity_fingerprint_file(file).unwrap_or_else(|error| {
                    tracing::warn!("could not fingerprint {}: {error}", path.display());
                    path_identity_fingerprint(path)
                }),
            };
            Ok((path.clone(), alias, fingerprint, stat))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;

    let mut fingerprints = HashMap::with_capacity(files.len());
    let mut cache = BTreeMap::new();
    for (path, alias, fingerprint, stat) in scanned {
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
        fingerprints.insert(path, fingerprint);
    }

    Ok((fingerprints, cache))
}

pub(crate) fn book_identity_fingerprint(track_fingerprints: &[String]) -> String {
    let mut sorted = track_fingerprints.to_vec();
    sorted.sort();
    let mut hasher = Sha256::new();
    for fingerprint in sorted {
        hasher.update((fingerprint.len() as u64).to_le_bytes());
        hasher.update(fingerprint.as_bytes());
    }
    hex_digest(hasher.finalize())
}

pub(crate) const PATH_TIER_STALE_AFTER_SCANS: u64 = 3;

pub(crate) struct ScannedGroup<'a> {
    pub(crate) book_fingerprint: &'a str,
    pub(crate) group_alias: &'a str,
    pub(crate) root_id: &'a str,
    pub(crate) grouped_files: &'a [PathBuf],
    pub(crate) track_fingerprints: &'a [String],
    pub(crate) track_aliases: &'a [String],
    pub(crate) duration_seconds: Option<f64>,
}

fn historical_addition_time(files: &[PathBuf]) -> u64 {
    files
        .iter()
        .filter_map(|path| std::fs::metadata(path).ok())
        .filter_map(|metadata| {
            historical_file_time(metadata.created().ok(), metadata.modified().ok())
        })
        .min()
        .unwrap_or(0)
}

pub(crate) fn historical_file_time(
    created: Option<std::time::SystemTime>,
    modified: Option<std::time::SystemTime>,
) -> Option<u64> {
    let now = unix_now_seconds();
    [created, modified].into_iter().flatten().find_map(|time| {
        time.duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|duration| duration.as_secs())
            .filter(|seconds| *seconds > 0 && *seconds <= now)
    })
}

fn claim_unambiguous_edges(
    proposals: &[Vec<usize>],
    claimed: &mut [Option<usize>],
    used: &mut HashSet<usize>,
) {
    let mut proposal_count: HashMap<usize, usize> = HashMap::new();
    for candidates in proposals {
        for index in candidates {
            *proposal_count.entry(*index).or_insert(0) += 1;
        }
    }

    for (position, candidates) in proposals.iter().enumerate() {
        if let [only] = candidates[..]
            && proposal_count.get(&only).copied().unwrap_or(0) == 1
            && !used.contains(&only)
        {
            claimed[position] = Some(only);
            used.insert(only);
        }
    }
}

pub(crate) fn resolve_library_identities(
    store: &mut LibraryIdentityStore,
    groups: &[ScannedGroup<'_>],
    mint: &mut dyn FnMut() -> String,
) -> Vec<(String, Vec<String>)> {
    let scan = store.scan_counter.saturating_add(1);
    let mut claimed_by: Vec<Option<usize>> = vec![None; groups.len()];
    let mut used: HashSet<usize> = HashSet::new();

    let scanned_fingerprints: HashSet<&str> = groups
        .iter()
        .map(|group| group.book_fingerprint)
        .collect::<HashSet<_>>();

    let path_matches = |identity: &BookIdentity, group: &ScannedGroup<'_>| {
        identity
            .paths
            .iter()
            .any(|path| path.root_id == group.root_id && path.relative_path == group.group_alias)
    };

    fn unclaimed_fingerprints<'a>(
        groups: &[ScannedGroup<'a>],
        claimed_by: &[Option<usize>],
    ) -> HashSet<&'a str> {
        groups
            .iter()
            .enumerate()
            .filter(|(position, _)| claimed_by[*position].is_none())
            .map(|(_, group)| group.book_fingerprint)
            .collect()
    }
    let current_is_present = |identity: &BookIdentity, unclaimed: &HashSet<&str>| {
        unclaimed.contains(identity.fingerprint.as_str())
    };

    let layout_matches = |identity: &BookIdentity, group: &ScannedGroup<'_>| {
        if identity.track_count != 0 && identity.track_count != group.grouped_files.len() {
            return false;
        }
        match (identity.duration_seconds, group.duration_seconds) {
            (Some(known), Some(found)) => {
                let tolerance = (known.abs() * LAYOUT_DURATION_TOLERANCE).max(2.0);
                (known - found).abs() <= tolerance
            }
            (Some(_), None) => false,
            (None, _) => true,
        }
    };

    let absent_from_scan = |identity: &BookIdentity, unclaimed: &HashSet<&str>| {
        !current_is_present(identity, unclaimed)
            && !identity
                .fingerprint_history
                .iter()
                .any(|candidate| scanned_fingerprints.contains(candidate.as_str()))
    };
    let recently_seen = |identity: &BookIdentity| {
        identity.last_seen_scan != 0
            && scan.saturating_sub(identity.last_seen_scan) <= PATH_TIER_STALE_AFTER_SCANS
    };

    let ignored_track_indexes = |identity: &BookIdentity, group: &ScannedGroup<'_>| {
        if group.track_aliases.is_empty()
            || group.track_aliases.len() != group.track_fingerprints.len()
        {
            return None;
        }
        let mut matched: HashSet<usize> = HashSet::new();
        for (alias, fingerprint) in group.track_aliases.iter().zip(group.track_fingerprints) {
            let (index, _) = identity.tracks.iter().enumerate().find(|(index, track)| {
                !matched.contains(index)
                    && track.fingerprint == *fingerprint
                    && track
                        .paths
                        .iter()
                        .any(|path| path.root_id == group.root_id && path.relative_path == *alias)
            })?;
            matched.insert(index);
        }
        let mut ignored = Vec::new();
        for (index, track) in identity.tracks.iter().enumerate() {
            if matched.contains(&index) {
                continue;
            }
            let path = track.paths.last()?;
            let name = path.relative_path.rsplit('/').next().unwrap_or_default();
            if !is_ignored_library_entry(name, false) {
                return None;
            }
            ignored.push(index);
        }
        (!ignored.is_empty()).then_some(ignored)
    };

    let claim_pass =
        |claimed_by: &mut Vec<Option<usize>>,
         used: &mut HashSet<usize>,
         eligible: &dyn Fn(&BookIdentity, &ScannedGroup<'_>) -> bool| {
            let mut proposals: Vec<Vec<usize>> = Vec::with_capacity(groups.len());
            for (position, group) in groups.iter().enumerate() {
                if claimed_by[position].is_some() {
                    proposals.push(Vec::new());
                    continue;
                }
                proposals.push(
                    store
                        .books
                        .iter()
                        .enumerate()
                        .filter(|(index, identity)| {
                            !used.contains(index) && eligible(identity, group)
                        })
                        .map(|(index, _)| index)
                        .collect(),
                );
            }
            claim_unambiguous_edges(&proposals, claimed_by, used);
        };

    claim_pass(&mut claimed_by, &mut used, &|identity, group| {
        path_matches(identity, group) && identity.fingerprint == group.book_fingerprint
    });

    claim_pass(&mut claimed_by, &mut used, &|identity, group| {
        identity.fingerprint == group.book_fingerprint
    });

    let unclaimed = unclaimed_fingerprints(groups, &claimed_by);
    claim_pass(&mut claimed_by, &mut used, &|identity, group| {
        !current_is_present(identity, &unclaimed)
            && identity.matches_fingerprint(group.book_fingerprint)
            && path_matches(identity, group)
    });

    let unclaimed = unclaimed_fingerprints(groups, &claimed_by);
    claim_pass(&mut claimed_by, &mut used, &|identity, group| {
        !current_is_present(identity, &unclaimed)
            && identity.matches_fingerprint(group.book_fingerprint)
    });

    let unclaimed_p5 = unclaimed_fingerprints(groups, &claimed_by);
    claim_pass(&mut claimed_by, &mut used, &|identity, group| {
        path_matches(identity, group)
            && absent_from_scan(identity, &unclaimed_p5)
            && recently_seen(identity)
            && layout_matches(identity, group)
    });

    let unclaimed_p6 = unclaimed_fingerprints(groups, &claimed_by);
    let before_pass_6 = claimed_by.clone();
    claim_pass(&mut claimed_by, &mut used, &|identity, group| {
        path_matches(identity, group)
            && absent_from_scan(identity, &unclaimed_p6)
            && (recently_seen(identity)
                || (identity.last_seen_scan == 0
                    && store.scan_counter == 0
                    && store.manifests.get(group.root_id).is_some_and(|manifest| {
                        manifest.scan == 0
                            && manifest.book_fingerprints.contains(&identity.fingerprint)
                    })))
            && ignored_track_indexes(identity, group).is_some()
    });
    let retirements: Vec<(usize, Vec<usize>)> = claimed_by
        .iter()
        .zip(&before_pass_6)
        .zip(groups)
        .filter(|((now, before), _)| now.is_some() && before.is_none())
        .filter_map(|((now, _), group)| {
            let index = (*now)?;
            Some((index, ignored_track_indexes(&store.books[index], group)?))
        })
        .collect();
    for (index, mut ignored) in retirements {
        ignored.sort_unstable_by(|a, b| b.cmp(a));
        for track in ignored {
            store.books[index].tracks.remove(track);
        }
    }

    let mut taken_book_ids = collect_book_ids(&store.books);
    let mut taken_track_ids = collect_track_ids(&store.books);
    for (position, group) in groups.iter().enumerate() {
        if claimed_by[position].is_some() {
            continue;
        }
        let index = store.books.len();
        let book_id = mint_unique_id(mint, &taken_book_ids);
        taken_book_ids.insert(book_id.clone());
        store.books.push(BookIdentity {
            fingerprint: group.book_fingerprint.to_string(),
            fingerprint_history: Vec::new(),
            book_id,
            paths: vec![IdentityPath::new(group.root_id, group.group_alias)],
            tracks: Vec::new(),
            last_seen_scan: scan,
            track_count: group.grouped_files.len(),
            duration_seconds: group.duration_seconds,
            added_at: unix_now_seconds(),
        });
        claimed_by[position] = Some(index);
        used.insert(index);
    }

    let mut outcomes = Vec::with_capacity(groups.len());
    for (position, group) in groups.iter().enumerate() {
        let index = claimed_by[position].expect("every group is claimed or minted above");
        let identity = &mut store.books[index];
        if identity.added_at == 0 {
            identity.added_at = historical_addition_time(group.grouped_files);
        }
        identity.record_fingerprint(group.book_fingerprint);
        identity.last_seen_scan = scan;
        identity.track_count = group.grouped_files.len();
        if group.duration_seconds.is_some() {
            identity.duration_seconds = group.duration_seconds;
        }
        remember_identity_path(
            &mut identity.paths,
            IdentityPath::new(group.root_id, group.group_alias),
        );
        let track_ids = resolve_track_identities(identity, group, mint, &mut taken_track_ids);
        outcomes.push((identity.book_id.clone(), track_ids));
    }

    store.scan_counter = scan;
    outcomes
}

fn collect_book_ids(books: &[BookIdentity]) -> HashSet<String> {
    books.iter().map(|book| book.book_id.clone()).collect()
}

fn collect_track_ids(books: &[BookIdentity]) -> HashSet<String> {
    books
        .iter()
        .flat_map(|book| book.tracks.iter().map(|track| track.track_id.clone()))
        .collect()
}

fn mint_unique_id(mint: &mut dyn FnMut() -> String, taken: &HashSet<String>) -> String {
    for _ in 0..64 {
        let candidate = mint();
        if !taken.contains(&candidate) {
            return candidate;
        }
    }
    panic!("could not mint a unique identity ID after 64 attempts");
}

fn resolve_track_identities(
    identity: &mut BookIdentity,
    group: &ScannedGroup<'_>,
    mint: &mut dyn FnMut() -> String,
    taken_track_ids: &mut HashSet<String>,
) -> Vec<String> {
    let mut used: HashSet<usize> = HashSet::new();
    let mut claimed: Vec<Option<usize>> = vec![None; group.grouped_files.len()];

    let scanned: HashSet<&str> = group
        .track_fingerprints
        .iter()
        .map(String::as_str)
        .collect();

    let path_matches = |track: &TrackIdentity, alias: &str| {
        track
            .paths
            .iter()
            .any(|path| path.root_id == group.root_id && path.relative_path == alias)
    };

    let claim_track_pass =
        |claimed: &mut Vec<Option<usize>>,
         used: &mut HashSet<usize>,
         eligible: &dyn Fn(&TrackIdentity, usize, &str) -> bool| {
            let mut proposals: Vec<Vec<usize>> = Vec::with_capacity(group.track_aliases.len());
            for (position, alias) in group.track_aliases.iter().enumerate() {
                if claimed[position].is_some() {
                    proposals.push(Vec::new());
                    continue;
                }
                proposals.push(
                    identity
                        .tracks
                        .iter()
                        .enumerate()
                        .filter(|(index, track)| {
                            !used.contains(index) && eligible(track, position, alias)
                        })
                        .map(|(index, _)| index)
                        .collect(),
                );
            }
            claim_unambiguous_edges(&proposals, claimed, used);
        };

    claim_track_pass(&mut claimed, &mut used, &|track, position, alias| {
        path_matches(track, alias) && track.fingerprint == group.track_fingerprints[position]
    });

    claim_track_pass(&mut claimed, &mut used, &|track, position, _alias| {
        track.fingerprint == group.track_fingerprints[position]
    });

    claim_track_pass(&mut claimed, &mut used, &|track, _position, alias| {
        path_matches(track, alias) && !scanned.contains(track.fingerprint.as_str())
    });

    let mut track_ids = Vec::with_capacity(group.grouped_files.len());
    for (position, alias) in group.track_aliases.iter().enumerate() {
        let fingerprint = group.track_fingerprints[position].clone();
        let index = match claimed[position] {
            Some(index) => index,
            None => {
                let index = identity.tracks.len();
                let track_id = mint_unique_id(mint, taken_track_ids);
                taken_track_ids.insert(track_id.clone());
                identity.tracks.push(TrackIdentity {
                    fingerprint: fingerprint.clone(),
                    track_id,
                    paths: vec![IdentityPath::new(group.root_id, alias)],
                });
                index
            }
        };
        let track = &mut identity.tracks[index];
        track.fingerprint = fingerprint;
        remember_identity_path(&mut track.paths, IdentityPath::new(group.root_id, alias));
        track_ids.push(track.track_id.clone());
    }
    track_ids
}

pub(crate) const SCAN_SHRINK_FLOOR: f64 = 0.5;

pub(crate) enum ScanVerdict {
    Commit,
    Withhold {
        record_shrink: Option<(usize, String)>,
    },
}

impl ScanVerdict {
    #[cfg(test)]
    pub(crate) fn commits(&self) -> bool {
        matches!(self, ScanVerdict::Commit)
    }
}

pub(crate) fn scan_signature(aliases: &[String]) -> String {
    let mut sorted = aliases.to_vec();
    sorted.sort();
    let mut hasher = Sha256::new();
    for alias in sorted {
        hasher.update((alias.len() as u64).to_le_bytes());
        hasher.update(alias.as_bytes());
    }
    hex_digest(hasher.finalize())
}

pub(crate) fn assess_scan(
    identities: &LibraryIdentityStore,
    root_id: &str,
    scanned_aliases: &[String],
    walk_errors: &[String],
    root: &FsPath,
) -> ScanVerdict {
    let scanned_books = scanned_aliases.len();
    if !walk_errors.is_empty() {
        tracing::warn!(
            "library scan hit {} traversal error(s); identities left unchanged. First: {}",
            walk_errors.len(),
            walk_errors[0]
        );
        return ScanVerdict::Withhold {
            record_shrink: None,
        };
    }

    let known = identities
        .manifests
        .get(root_id)
        .map(|manifest| manifest.book_fingerprints.len())
        .unwrap_or(0);
    if known == 0 {
        return ScanVerdict::Commit;
    }

    #[allow(clippy::cast_precision_loss)]
    let ratio = scanned_books as f64 / known as f64;
    if scanned_books > 0 && ratio >= SCAN_SHRINK_FLOOR {
        return ScanVerdict::Commit;
    }

    let signature = scan_signature(scanned_aliases);
    let confirmations = identities
        .pending_shrink
        .get(root_id)
        .filter(|pending| pending.signature == signature)
        .map(|pending| pending.observations)
        .unwrap_or(0);
    if confirmations + 1 >= SHRINK_CONFIRMATIONS {
        tracing::warn!(
            "library scan at {} found {scanned_books} books, down from {known}, for {} consecutive scans; accepting the reduction.",
            root.display(),
            confirmations + 1
        );
        return ScanVerdict::Commit;
    }

    tracing::warn!(
        "library scan at {} found {scanned_books} books, down from {known}; identities left unchanged (confirmation {} of {SHRINK_CONFIRMATIONS}).",
        root.display(),
        confirmations + 1
    );
    ScanVerdict::Withhold {
        record_shrink: Some((scanned_books, signature)),
    }
}

fn note_shrink_observation(
    identities: &mut LibraryIdentityStore,
    record_shrink: Option<(usize, String)>,
) {
    match record_shrink {
        Some((book_count, signature)) => {
            let pending = identities
                .pending_shrink
                .entry(DEFAULT_ROOT_ID.to_string())
                .or_default();
            if pending.signature == signature {
                pending.observations = pending.observations.saturating_add(1);
            } else {
                pending.book_count = book_count;
                pending.signature = signature;
                pending.observations = 1;
            }
        }
        None => {
            identities.pending_shrink.remove(DEFAULT_ROOT_ID);
        }
    }
}

pub(crate) async fn rescan_library(state: &AppState) -> anyhow::Result<()> {
    let _rescan_guard = state.rescan_lock.lock().await;
    rescan_library_locked(state).await
}

pub(crate) async fn rescan_library_locked(state: &AppState) -> anyhow::Result<()> {
    let input_root = ScanRoot::new(&state.library_root)?;
    let scan_root = state.library_root.clone();
    let (groups, walk_errors) = tokio::task::spawn_blocking(move || {
        let walk = walk_audio_files_checked(&scan_root);
        (group_files_into_books(&scan_root, walk.files), walk.errors)
    })
    .await?;
    let mut identities = match load_library_identities(&state.library_identities_file).await {
        Ok(identities) => identities,
        Err(error) if error.downcast_ref::<NewerIdentityFormat>().is_some() => {
            tracing::warn!("library scan withheld: {error}");
            return Ok(());
        }
        Err(error) => return Err(error),
    };

    let scanned_aliases = groups
        .iter()
        .map(|(group_key, _)| library_identity_path(&state.library_root, group_key))
        .collect::<Vec<_>>();
    if let ScanVerdict::Withhold { record_shrink } = assess_scan(
        &identities,
        DEFAULT_ROOT_ID,
        &scanned_aliases,
        &walk_errors,
        state.library_root.as_path(),
    ) {
        note_shrink_observation(&mut identities, record_shrink);
        write_json_atomic(&state.library_identities_file, &identities)
            .await
            .map_err(|error| anyhow::anyhow!(error.message))?;
        return Ok(());
    }

    let scanned_files = groups
        .iter()
        .flat_map(|(_, grouped_files)| grouped_files.iter().cloned())
        .collect::<Vec<_>>();
    let metadata_files = scanned_files.clone();
    let library_root = state.library_root.clone();
    let cached_fingerprints = identities
        .fingerprint_cache
        .remove(DEFAULT_ROOT_ID)
        .unwrap_or_default();

    let fingerprint_root = input_root.clone();
    let fingerprint_task = tokio::task::spawn_blocking(move || {
        fingerprint_tracks_in(
            &fingerprint_root,
            &library_root,
            &scanned_files,
            cached_fingerprints,
        )
    });
    let metadata_root = input_root.clone();
    let metadata_task = tokio::task::spawn_blocking(move || {
        let mut retained = 0u64;
        metadata_files
            .into_iter()
            .map(|path| -> anyhow::Result<_> {
                let mut metadata = read_track_metadata_in(&metadata_root, &path)?;
                let cover = metadata
                    .cover_art
                    .take()
                    .map(|image| ScannedCover::from_image_in(metadata_root.clone(), &path, &image));
                let mut count = MetadataCounter {
                    bytes: 0,
                    remaining: (128 * 1024 * 1024u64).saturating_sub(retained),
                };
                serde_json::to_writer(&mut count, &metadata)?;
                retained += count.bytes;
                Ok((path, metadata, cover))
            })
            .collect::<anyhow::Result<Vec<_>>>()
    });
    let fingerprints = fingerprint_task.await?;
    let metadata_results = metadata_task.await?;
    let (track_fingerprints_by_path, fingerprint_cache) = fingerprints?;
    let mut metadata_by_path = HashMap::new();
    let mut covers_by_path = HashMap::new();
    for (path, metadata, cover) in metadata_results? {
        if let Some(cover) = cover {
            covers_by_path.insert(path.clone(), cover);
        }
        metadata_by_path.insert(path, metadata);
    }
    identities
        .fingerprint_cache
        .insert(DEFAULT_ROOT_ID.to_string(), fingerprint_cache);

    let metadata_overrides = state.metadata_overrides.read().await.clone();
    let mut reading_paths = HashMap::new();

    struct PreparedGroup {
        group_key: PathBuf,
        grouped_files: Vec<PathBuf>,
        track_fingerprints: Vec<String>,
        track_aliases: Vec<String>,
        book_fingerprint: String,
        group_alias: String,
        duration_seconds: Option<f64>,
    }

    let prepared = groups
        .into_iter()
        .map(|(group_key, grouped_files)| {
            let track_fingerprints = grouped_files
                .iter()
                .map(|path| {
                    track_fingerprints_by_path
                        .get(path)
                        .cloned()
                        .unwrap_or_else(|| path_identity_fingerprint(path))
                })
                .collect::<Vec<_>>();
            let track_aliases = grouped_files
                .iter()
                .map(|path| library_identity_path(&state.library_root, path))
                .collect::<Vec<_>>();
            let duration_seconds = grouped_files
                .iter()
                .try_fold(0.0_f64, |total, path| {
                    metadata_by_path
                        .get(path)
                        .and_then(|metadata| metadata.duration_seconds)
                        .map(|duration| total + duration)
                })
                .filter(|total| *total > 0.0);
            PreparedGroup {
                book_fingerprint: book_identity_fingerprint(&track_fingerprints),
                group_alias: library_identity_path(&state.library_root, &group_key),
                duration_seconds,
                group_key,
                grouped_files,
                track_fingerprints,
                track_aliases,
            }
        })
        .collect::<Vec<_>>();

    let (mut identities, prepared, resolved) = tokio::task::spawn_blocking(move || {
        let mut identities = identities;
        let scanned_groups = prepared
            .iter()
            .map(|group| ScannedGroup {
                book_fingerprint: &group.book_fingerprint,
                group_alias: &group.group_alias,
                root_id: DEFAULT_ROOT_ID,
                grouped_files: &group.grouped_files,
                track_fingerprints: &group.track_fingerprints,
                track_aliases: &group.track_aliases,
                duration_seconds: group.duration_seconds,
            })
            .collect::<Vec<_>>();
        let resolved = resolve_library_identities(
            &mut identities,
            &scanned_groups,
            &mut (mint_identity_id as fn() -> String),
        );
        (identities, prepared, resolved)
    })
    .await?;

    let added_at_by_book_id: HashMap<String, u64> = identities
        .books
        .iter()
        .map(|identity| (identity.book_id.clone(), identity.added_at))
        .collect();

    let library_root = state.library_root.clone();
    let companion_root = input_root.clone();
    let sync_dir = state.sync_dir.clone();
    let (
        metadata_overrides,
        mut books,
        book_paths,
        track_paths,
        sync_paths,
        extracted_covers,
        pending_companions,
    ) = tokio::task::spawn_blocking(move || {
        let mut listings = DirectoryFiles::default();
        let mut track_paths = HashMap::new();
        let mut book_paths = HashMap::new();
        let mut sync_paths = HashMap::new();
        let mut extracted_covers: Vec<(String, ScannedCover)> = Vec::new();
        let mut books = Vec::new();
        let mut pending_companions: Vec<(usize, Vec<PathBuf>)> = Vec::new();
        for (position, group) in prepared.into_iter().enumerate() {
            let PreparedGroup {
                group_key,
                grouped_files,
                book_fingerprint,
                ..
            } = group;
            let (book_id, track_ids) = resolved[position].clone();
            book_paths.insert(book_id.clone(), group_key.clone());
            let mut metadata = grouped_files
                .iter()
                .map(|file_path| metadata_by_path.remove(file_path).unwrap_or_default())
                .collect::<Vec<_>>();

            let tracks = build_tracks(&book_id, &grouped_files, &track_ids, &metadata);
            for (track, file_path) in tracks.iter().zip(&grouped_files) {
                track_paths.insert(track.id.clone(), file_path.clone());
            }

            let duration_seconds = tracks
                .iter()
                .map(|track| track.duration_seconds)
                .try_fold(0.0, |sum, duration| duration.map(|value| sum + value));

            let mut title = book_title_for_group(&group_key, &grouped_files, &metadata);

            let embedded_cover = grouped_files
                .iter()
                .find_map(|file_path| covers_by_path.remove(file_path));
            let cover_art_url = embedded_cover
                .as_ref()
                .map(|_| format!("/api/books/{book_id}/cover"));
            let mut metadata_summary = merge_metadata_summary(&metadata);
            if let Some(imported) = libro_metadata_for_group_in(&input_root, &group_key) {
                title = clean_imported_title(&imported.title);
                if let Some(first) = metadata.first_mut() {
                    if !imported.authors.is_empty() {
                        first.author = Some(imported.authors.join(", "));
                    }
                    if !imported.audiobook_info.narrators.is_empty() {
                        first.narrator = Some(imported.audiobook_info.narrators.join(", "));
                    }
                }
                let summary = MetadataSummary {
                    description: (!imported.description.is_empty()).then_some(imported.description),
                    publisher: (!imported.publisher.is_empty()).then_some(imported.publisher),
                    published_date: (!imported.publication_date.is_empty())
                        .then_some(imported.publication_date),
                    series: imported.series,
                    series_position: imported.series_num.map(|n| {
                        n.as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| n.to_string())
                    }),
                    genres: imported.genres.into_iter().map(|g| g.name).collect(),
                    raw_fields: vec![MetadataField {
                        key: "ISBN".into(),
                        value: imported.isbn,
                        description: None,
                    }],
                    ..Default::default()
                };
                metadata_summary = merge_two_summaries(summary, metadata_summary);
            }
            if let Some(sidecar) = libation_sidecar_for_group_in(
                &input_root,
                &group_key,
                &grouped_files,
                &mut listings,
            ) {
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
            let sync_file = find_sync_file_in(
                &input_root,
                &book_id,
                &group_key,
                &grouped_files,
                &title,
                &sync_dir,
                &mut listings,
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
                has_cover_override: false,
                cover_art_content_type: None,
                description: metadata_summary.description.clone(),
                genres: metadata_summary.genres.clone(),
                tags: Vec::new(),
                published_date: metadata_summary.published_date.clone(),
                asin: metadata.iter().find_map(|item| item.asin.clone()),
                added_at: rfc3339_utc(
                    added_at_by_book_id
                        .get(book_id.as_str())
                        .copied()
                        .unwrap_or(0),
                ),
                reading_file: None,
                companions: Vec::new(),
                sync_file: sync_file.map(|sync_file| sync_file.file),
                chapters: book_chapters,
                metadata: metadata_summary,
                tracks,
                progress: None,
                shared_progress: Vec::new(),
                volume_gain: BOOK_VOLUME_GAIN_DEFAULT,
                volume_gain_source: VolumeGainSource::Default,
                auto_volume: true,
                audio_analysis: None,
                audio_fingerprint: book_fingerprint,
            };
            if let Some(metadata_override) = metadata_overrides.books.get(&book_id) {
                apply_book_metadata_override(&mut book, metadata_override);
            }
            let mut companion_candidates = discover_candidates(
                &group_key,
                &grouped_files,
                &book.title,
                embedded_cover.as_ref(),
                &mut listings,
            );
            if let Some(name) = metadata_overrides
                .books
                .get(&book_id)
                .and_then(|entry| entry.ebook_file_name.as_deref())
                .filter(|name| sanitize_filename(name) == *name)
            {
                let paired_path = (!group_key.is_dir())
                    .then(|| {
                        WalkDir::new(group_key.parent().unwrap_or(&library_root))
                            .max_depth(1)
                            .into_iter()
                            .filter_map(Result::ok)
                            .find(|entry| {
                                entry.file_type().is_file()
                                    && entry.file_name().to_str() == Some(name)
                                    && is_document(entry.path())
                            })
                            .map(walkdir::DirEntry::into_path)
                    })
                    .flatten();
                if let Some(paired_path) = paired_path
                    && !companion_candidates.contains(&paired_path)
                {
                    companion_candidates.push(paired_path);
                    companion_candidates.sort_by_key(|path| natural_path_key(path));
                }
            }
            if let Some(cover) = embedded_cover {
                extracted_covers.push((book_id.clone(), cover));
            }
            pending_companions.push((books.len(), companion_candidates));
            books.push(book);
        }
        (
            metadata_overrides,
            books,
            book_paths,
            track_paths,
            sync_paths,
            extracted_covers,
            pending_companions,
        )
    })
    .await?;

    let previous_analyses = state.library.read().await.companion_analyses.clone();
    let candidate_paths = pending_companions
        .iter()
        .flat_map(|(_, paths)| paths.iter().cloned())
        .collect::<Vec<_>>();
    let companion_analyses = tokio::task::spawn_blocking(move || {
        analyze_all_in(&companion_root, &candidate_paths, &previous_analyses)
    })
    .await?;
    for (book_index, candidates) in pending_companions {
        let book = &mut books[book_index];
        let described = describe(
            &book.id,
            &candidates,
            &companion_analyses,
            book.duration_seconds,
        );
        for (companion, path) in &described {
            reading_paths.insert(companion.id.clone(), path.clone());
        }
        book.companions = described
            .into_iter()
            .map(|(companion, _)| companion)
            .collect();
        if let Some(name) = metadata_overrides
            .books
            .get(&book.id)
            .and_then(|entry| entry.ebook_file_name.as_deref())
            && let Some(index) = book
                .companions
                .iter()
                .position(|file| file.file_name == name && file.extension == "epub")
        {
            book.companions[index].kind = CompanionKind::Book;
            let paired = book.companions.remove(index);
            book.companions.insert(0, paired);
        }
        book.reading_file = primary_reading_file(&book.companions).map(|companion| ReadingFile {
            id: companion.id.clone(),
            file_name: companion.file_name.clone(),
            extension: companion.extension.clone(),
            content_type: companion.content_type.clone(),
            url: format!("/api/books/{}/readalong", book.id),
        });
    }

    identities.pending_shrink.remove(DEFAULT_ROOT_ID);
    identities.manifests.insert(
        DEFAULT_ROOT_ID.to_string(),
        RootManifest {
            book_fingerprints: identities
                .books
                .iter()
                .filter(|book| book.last_seen_scan == identities.scan_counter)
                .map(|book| book.fingerprint.clone())
                .collect(),
            scan: identities.scan_counter,
        },
    );
    write_json_atomic(&state.library_identities_file, &identities)
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;

    resolve_book_works(state, &books).await?;

    let covers_dir = state.covers_dir.clone();
    let cover_root = state.library_root.clone();
    let cover_paths = book_paths.clone();
    let published_covers = state.library.read().await.embedded_cover_art.clone();
    let (cover_art, embedded_cover_art, stale_covers) = tokio::task::spawn_blocking(move || {
        let (embedded, stale) = write_covers(&covers_dir, extracted_covers, &published_covers)?;
        let mut covers = embedded.clone();
        for (id, metadata) in &metadata_overrides.books {
            if let Some(name) = &metadata.cover_file_name
                && let Some(path) = cover_paths.get(id)
                && let Some(cover) = read_cover_override(&cover_root, path, id, name)
            {
                covers.insert(id.clone(), cover);
            }
        }
        Ok::<_, anyhow::Error>((covers, embedded, stale))
    })
    .await
    .map_err(|error| anyhow::anyhow!("cover extraction failed: {error}"))??;

    {
        let mut library = state.library.write().await;
        let current_overrides = state.metadata_overrides.read().await;
        for book in &mut books {
            if let Some(metadata_override) = current_overrides.books.get(&book.id) {
                apply_book_metadata_override(book, metadata_override);
            }
            let cover = cover_art.get(&book.id);
            let overridden = cover.is_some_and(|cover| {
                embedded_cover_art
                    .get(&book.id)
                    .is_none_or(|embedded| embedded.path != cover.path)
            });
            set_book_cover(book, cover, overridden);
        }
        drop(current_overrides);
        library.books = books;
        library.book_paths = book_paths;
        library.track_paths = track_paths;
        library.reading_paths = reading_paths;
        library.companion_analyses = companion_analyses;
        library.sync_paths = sync_paths;
        library.cover_art = cover_art;
        library.embedded_cover_art = embedded_cover_art;
        library.catalogue_ready = true;
        library.catalogue_error = false;
    }
    remove_stale_covers(&stale_covers);
    sync_report::schedule_backfill(state);
    schedule_analysis(state);
    Ok(())
}

fn build_tracks(
    book_id: &str,
    grouped_files: &[PathBuf],
    track_ids: &[String],
    metadata: &[TrackMetadata],
) -> Vec<Track> {
    grouped_files
        .iter()
        .enumerate()
        .map(|(index, file_path)| {
            let track_id = track_ids[index].clone();
            let chapters = metadata[index]
                .chapters
                .iter()
                .map(|chapter| Chapter {
                    id: stable_id(&format!("{track_id}:{}", chapter.start_seconds)),
                    title: clean_tag_text(&chapter.title),
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
        .collect()
}

fn book_title_for_group(
    group_key: &FsPath,
    grouped_files: &[PathBuf],
    metadata: &[TrackMetadata],
) -> String {
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
    clean_imported_title(&raw_title)
}

async fn resolve_book_works(state: &AppState, books: &[Book]) -> anyhow::Result<()> {
    let editions = books
        .iter()
        .map(|book| EditionCandidate {
            book_id: book.id.clone(),
            title: book.title.clone(),
            author: book.author.clone(),
            asin: book.asin.clone(),
            isbn: None,
            duration_seconds: book.duration_seconds,
        })
        .collect::<Vec<_>>();
    state
        .works
        .mutate(move |works| {
            let now = unix_now_millis();
            for edition in &editions {
                works.resolve(edition, now, generate_session_token);
            }
            let present = editions
                .iter()
                .map(|edition| edition.book_id.clone())
                .collect::<HashSet<_>>();
            works.prune_suggestions(&present);
            Ok(())
        })
        .await
        .map_err(|error| anyhow::anyhow!(error.message))
}

pub(crate) struct DiscoveredSyncFile {
    pub(crate) file: SyncFile,
    pub(crate) path: PathBuf,
}

fn find_companion_file(
    group_key: &FsPath,
    grouped_files: &[PathBuf],
    book_title: &str,
    listings: &mut DirectoryFiles,
    is_candidate: impl Fn(&FsPath) -> bool,
    match_stem: impl Fn(&FsPath) -> Option<String>,
) -> Option<PathBuf> {
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

    let mut candidates = listings
        .files(&search_dir)
        .iter()
        .filter(|path| is_candidate(path))
        .cloned()
        .collect::<Vec<_>>();
    candidates.sort_by_key(|a| natural_path_key(a));

    candidates
        .iter()
        .find(|path| {
            let Some(stem) = match_stem(path) else {
                return false;
            };
            let stem_key = normalize_match_key(&stem);
            Some(&stem_key) == group_stem.as_ref()
                || stem_key == title_key
                || audio_stems.iter().any(|audio_stem| audio_stem == &stem_key)
        })
        .or_else(|| is_folder_book.then(|| candidates.first()).flatten())
        .cloned()
}

pub(crate) fn is_plain_file_token(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

pub(crate) struct ProbedSyncMap {
    pub(crate) outdated: bool,
    pub(crate) identity: sync_report::MapIdentity,
}

#[cfg(test)]
pub(crate) fn probe_sync_map(path: &FsPath, generated: bool) -> Option<ProbedSyncMap> {
    probe_sync_map_in(path, generated, &[path.parent()?.to_path_buf()])
}
pub(crate) fn probe_sync_map_in(
    path: &FsPath,
    generated: bool,
    allowed_roots: &[PathBuf],
) -> Option<ProbedSyncMap> {
    let file = open_scan_file_in(path, allowed_roots).ok()?;
    probe_sync_map_file(file, generated)
}
fn probe_sync_map_file(file: std::fs::File, generated: bool) -> Option<ProbedSyncMap> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Probe {
        #[serde(default)]
        precision: Option<String>,
        #[serde(default)]
        generator: Option<String>,
        #[serde(default)]
        mapping_revision: u32,
        #[serde(default)]
        generated_at: Option<String>,
    }
    struct DigestReader {
        file: std::fs::File,
        digest: Sha256,
        size: u64,
    }
    impl Read for DigestReader {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            let count = self.file.read(bytes)?;
            self.digest.update(&bytes[..count]);
            self.size += count as u64;
            Ok(count)
        }
    }
    let mut reader = std::io::BufReader::new(DigestReader {
        file,
        digest: Sha256::new(),
        size: 0,
    });
    let probe = serde_json::from_reader::<_, Probe>(&mut reader).ok()?;
    let reader = reader.into_inner();
    if probe
        .precision
        .as_deref()
        .unwrap_or(alignment::PRECISION_SENTENCE)
        != alignment::PRECISION_SENTENCE
    {
        return None;
    }
    Some(ProbedSyncMap {
        outdated: (generated || probe.generator.as_deref() == Some("echogarden"))
            && probe.mapping_revision < alignment::MAPPING_REVISION,
        identity: sync_report::MapIdentity {
            map_generated_at: probe.generated_at,
            map_size: reader.size,
            map_digest: hex_digest(reader.digest.finalize()),
        },
    })
}

#[cfg(test)]
pub(crate) fn find_sync_file(
    book_id: &str,
    group_key: &FsPath,
    grouped_files: &[PathBuf],
    book_title: &str,
    sync_dir: &FsPath,
    listings: &mut DirectoryFiles,
) -> Option<DiscoveredSyncFile> {
    let root = ScanRoot::new(grouped_files.first()?.parent()?).ok()?;
    find_sync_file_in(
        &root,
        book_id,
        group_key,
        grouped_files,
        book_title,
        sync_dir,
        listings,
    )
}
fn find_sync_file_in(
    root: &ScanRoot,
    book_id: &str,
    group_key: &FsPath,
    grouped_files: &[PathBuf],
    book_title: &str,
    sync_dir: &FsPath,
    listings: &mut DirectoryFiles,
) -> Option<DiscoveredSyncFile> {
    let url = format!("/api/books/{book_id}/sync");
    let sidecar = find_companion_file(
        group_key,
        grouped_files,
        book_title,
        listings,
        |path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(has_sync_sidecar_suffix)
                .unwrap_or(false)
        },
        |path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name[..name.len() - SYNC_SIDECAR_SUFFIX.len()].to_string())
        },
    );
    let sidecar = sidecar.and_then(|path| {
        probe_sync_map_file(root.open(&path).ok()?.0, false).map(|probe| (path, probe))
    });
    let generated = is_plain_file_token(book_id)
        .then(|| sync_dir.join(format!("{book_id}{SYNC_SIDECAR_SUFFIX}")))
        .and_then(|path| {
            probe_sync_map_in(&path, true, &[sync_dir.to_path_buf()]).map(|probe| (path, probe))
        });
    let (path, probe, source) = match (sidecar, generated) {
        (Some((_, sidecar)), Some((path, generated)))
            if sidecar.outdated && !generated.outdated =>
        {
            (path, generated, "generated")
        }
        (Some((path, probe)), _) => (path, probe, "sidecar"),
        (None, Some((path, probe))) => (path, probe, "generated"),
        (None, None) => return None,
    };
    let report = sync_report::read_current_report(sync_dir, book_id, &probe.identity);
    Some(DiscoveredSyncFile {
        file: SyncFile {
            outdated: probe.outdated,
            file_name: path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("sync.json")
                .to_string(),
            source: source.into(),
            url,
            quality: report.as_ref().and_then(sync_report::SyncReport::quality),
            report_current: report.is_some(),
        },
        path,
    })
}

#[derive(Default)]
pub(crate) struct DirectoryFiles(HashMap<PathBuf, Vec<PathBuf>>);

impl DirectoryFiles {
    pub(crate) fn files(&mut self, directory: &FsPath) -> &[PathBuf] {
        self.0.entry(directory.to_path_buf()).or_insert_with(|| {
            WalkDir::new(directory)
                .max_depth(1)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_file())
                .filter(|entry| {
                    !is_ignored_library_entry(&entry.file_name().to_string_lossy(), false)
                })
                .map(walkdir::DirEntry::into_path)
                .collect()
        })
    }
}

pub(crate) fn has_sync_sidecar_suffix(name: &str) -> bool {
    name.len() > SYNC_SIDECAR_SUFFIX.len()
        && name.is_char_boundary(name.len() - SYNC_SIDECAR_SUFFIX.len())
        && name[name.len() - SYNC_SIDECAR_SUFFIX.len()..].eq_ignore_ascii_case(SYNC_SIDECAR_SUFFIX)
}

pub(crate) fn is_supported_audio_file(path: &FsPath) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            AUDIO_EXTENSIONS
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(extension))
        })
        .unwrap_or(false)
}

pub(crate) struct AudioWalk {
    pub(crate) files: Vec<PathBuf>,
    pub(crate) errors: Vec<String>,
}

const IGNORED_DIRECTORY_NAMES: &[&str] = &[
    "#recycle",
    "@Recycle",
    "@eaDir",
    "$RECYCLE.BIN",
    "System Volume Information",
    "lost+found",
];

pub(crate) fn is_ignored_library_entry(name: &str, is_dir: bool) -> bool {
    (name.starts_with('.') && !name.starts_with(".."))
        || (is_dir
            && IGNORED_DIRECTORY_NAMES
                .iter()
                .any(|ignored| ignored.eq_ignore_ascii_case(name)))
}

pub(crate) fn walk_audio_files_checked(root: &FsPath) -> AudioWalk {
    let mut errors = Vec::new();
    let mut files = WalkDir::new(root)
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || !is_ignored_library_entry(
                    &entry.file_name().to_string_lossy(),
                    entry.file_type().is_dir(),
                )
        })
        .filter_map(|entry| match entry {
            Ok(entry) => Some(entry),
            Err(error) => {
                errors.push(error.to_string());
                None
            }
        })
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| !faststart::is_work_file(path))
        .filter(|path| is_supported_audio_file(path))
        .collect::<Vec<_>>();

    files.sort_by_key(|a| natural_path_key(a));
    AudioWalk { files, errors }
}

pub(crate) fn group_files_into_books(
    root: &FsPath,
    files: Vec<PathBuf>,
) -> Vec<(PathBuf, Vec<PathBuf>)> {
    let mut groups = Vec::<(PathBuf, Vec<PathBuf>)>::new();
    let mut group_index = HashMap::<PathBuf, usize>::new();

    for file_path in files {
        let parent = file_path.parent().unwrap_or(root);
        let key = if parent == root {
            file_path.clone()
        } else {
            parent.to_path_buf()
        };

        match group_index.get(&key) {
            Some(&index) => groups[index].1.push(file_path),
            None => {
                group_index.insert(key.clone(), groups.len());
                groups.push((key, vec![file_path]));
            }
        }
    }

    groups.sort_by_key(|a| natural_path_key(&a.0));
    groups
}

#[cfg(test)]
pub(crate) fn read_track_metadata(file_path: &FsPath) -> TrackMetadata {
    let Some(root) = file_path.parent().and_then(|path| ScanRoot::new(path).ok()) else {
        return TrackMetadata::default();
    };
    read_track_metadata_in(&root, file_path).unwrap_or_default()
}
fn read_track_metadata_in(root: &ScanRoot, file_path: &FsPath) -> anyhow::Result<TrackMetadata> {
    let (file, _) = root.open(file_path)?;
    Ok(read_track_metadata_file(file, file_path))
}
fn read_track_metadata_file(file: std::fs::File, file_path: &FsPath) -> TrackMetadata {
    let _parse_guard = METADATA_PARSE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let Ok(mut input) = MetadataInput::new(file) else {
        tracing::warn!(path = %file_path.display(), "Skipping malformed or oversized embedded metadata");
        return TrackMetadata::default();
    };
    let Ok(tagged_file) = read_bounded_tags(&input, file_path) else {
        return TrackMetadata::default();
    };

    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag());
    let mut summary = tag.map(extract_metadata_summary).unwrap_or_default();
    if let Some(vendor_summary) = tag.and_then(extract_vendor_json_summary) {
        summary = merge_two_summaries(summary, vendor_summary);
    }
    let chapters = read_embedded_chapters_from(file_path, &mut input);

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
        .or_else(|| tag.and_then(|tag| tag.artist().map(clean_tag_text)));

    TrackMetadata {
        title: tag
            .and_then(|tag| tag.title().map(clean_tag_text))
            .or_else(|| summary.album.clone()),
        narrator: tag
            .and_then(extract_narrator)
            .or_else(|| tag.and_then(extract_vendor_narrator))
            .or_else(|| tag.and_then(|tag| composer_narrator(tag, author.as_deref()))),
        author,
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

pub(crate) fn extract_asin(tag: &Tag) -> Option<String> {
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

pub(crate) fn extract_asin_from_path(path: &FsPath) -> Option<String> {
    let name = path.file_name().and_then(|name| name.to_str())?;
    name.split(|character: char| !character.is_ascii_alphanumeric())
        .find_map(normalize_guessed_asin)
}

pub(crate) fn normalize_asin(value: &str) -> Option<String> {
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

pub(crate) fn is_isbn10(value: &str) -> bool {
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

pub(crate) fn normalize_guessed_asin(value: &str) -> Option<String> {
    normalize_asin(value).filter(|asin| asin.starts_with('B'))
}

pub(crate) fn extract_metadata_summary(tag: &Tag) -> MetadataSummary {
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

pub(crate) fn first_tag_text(tag: &Tag, keys: &[ItemKey]) -> Option<String> {
    keys.iter()
        .find_map(|key| tag.get_string(*key))
        .map(clean_tag_text)
        .filter(|value| !value.is_empty())
}

pub(crate) fn collect_genres(tag: &Tag) -> Vec<String> {
    tag.get_strings(ItemKey::Genre)
        .take(100)
        .flat_map(|value| value.split([';', ',']))
        .take(100)
        .map(clean_tag_text)
        .filter(|value| !value.is_empty())
        .collect()
}

pub(crate) fn collect_raw_fields(tag: &Tag) -> Vec<MetadataField> {
    tag.items()
        .take(100)
        .filter_map(|item| {
            let value = match item.value() {
                ItemValue::Text(value) | ItemValue::Locator(value) => {
                    truncate_metadata_value(&clean_tag_text(value))
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
                    .then(|| clean_tag_text(item.description())),
            })
        })
        .collect()
}

pub(crate) fn item_key_label(key: ItemKey) -> String {
    format!("{key:?}")
}

fn clean_tag_text(value: impl AsRef<str>) -> String {
    let text = value.as_ref();
    let mut end = text.len().min(16 * 1024);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    clean_metadata_text(&text[..end])
}

pub(crate) fn clean_metadata_text(value: impl AsRef<str>) -> String {
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

pub(crate) fn truncate_metadata_value(value: &str) -> String {
    const MAX_FIELD_LEN: usize = 1600;
    if value.chars().count() <= MAX_FIELD_LEN {
        return value.to_string();
    }

    let preview = value.chars().take(MAX_FIELD_LEN).collect::<String>();
    format!("{preview}… [truncated]")
}

pub(crate) fn extract_narrator(tag: &Tag) -> Option<String> {
    first_tag_text(tag, &[ItemKey::Performer, ItemKey::Conductor])
        .or_else(|| find_raw_text_by_name(tag, &["narrator", "narrated by", "reader", "read by"]))
}

pub(crate) fn composer_narrator(tag: &Tag, author: Option<&str>) -> Option<String> {
    let composer = first_tag_text(tag, &[ItemKey::Composer])?;
    let author = author?;
    (!composer.eq_ignore_ascii_case(author)).then_some(composer)
}

pub(crate) fn extract_vendor_narrator(tag: &Tag) -> Option<String> {
    extract_vendor_json(tag).and_then(|value| {
        value
            .get("narrated_by")
            .or_else(|| value.get("narrator"))
            .and_then(serde_json::Value::as_str)
            .map(clean_tag_text)
    })
}

pub(crate) fn extract_vendor_json_summary(tag: &Tag) -> Option<MetadataSummary> {
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

pub(crate) fn extract_vendor_json(tag: &Tag) -> Option<serde_json::Value> {
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

pub(crate) fn looks_like_base64_json(value: &str) -> bool {
    value.len() > 128
        && value.len().is_multiple_of(4)
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '/' | '=')
        })
}

pub(crate) fn json_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(serde_json::Value::as_str)
            .map(clean_tag_text)
            .filter(|value| !value.is_empty())
    })
}

pub(crate) fn find_raw_text_by_name(tag: &Tag, names: &[&str]) -> Option<String> {
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
                Some(clean_tag_text(value)).filter(|value| !value.is_empty())
            }
            ItemValue::Binary(_) => None,
        }
    })
}

pub(crate) fn extract_cover_art(tag: &Tag) -> Option<EmbeddedImage> {
    let picture = tag
        .get_picture_type(PictureType::CoverFront)
        .or_else(|| tag.pictures().first())?;
    if picture.data().len() as u64 > TAG_BYTES {
        return None;
    }
    let data = normalize_cover(picture.data()).ok()?;
    Some(EmbeddedImage {
        mime_type: "image/png".into(),
        etag: bytes_etag(&data),
        data,
    })
}

#[cfg(test)]
pub(crate) fn cover_art_content_type(declared: Option<&str>) -> String {
    let declared = declared
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
        })
        .unwrap_or_default();
    match declared.as_str() {
        "image/jpeg" | "image/jpg" => "image/jpeg",
        "image/png" => "image/png",
        "image/gif" => "image/gif",
        "image/webp" => "image/webp",
        "image/bmp" => "image/bmp",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn read_track_cover_art_in(root: &ScanRoot, file_path: &FsPath) -> Option<EmbeddedImage> {
    let (file, _) = root.open(file_path).ok()?;
    let _parse_guard = METADATA_PARSE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let input = MetadataInput::new(file).ok()?;
    let tagged_file = read_bounded_tags(&input, file_path).ok()?;
    tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag())
        .and_then(extract_cover_art)
}

fn read_embedded_chapters_from(
    file_path: &FsPath,
    input: &mut MetadataInput,
) -> Vec<ParsedChapter> {
    let extension = file_path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_lowercase();

    let mut chapters = match extension.as_str() {
        "m4a" | "m4b" | "mp4" => read_mp4_chapters(input),
        "mp3" => read_id3_chapters(input),
        _ => Vec::new(),
    };

    chapters.sort_by(|a, b| a.start_seconds.total_cmp(&b.start_seconds));
    chapters.dedup_by(|a, b| {
        (a.start_seconds - b.start_seconds).abs() < 0.001 && a.title.eq_ignore_ascii_case(&b.title)
    });
    chapters
}

fn read_mp4_chapters(input: &mut MetadataInput) -> Vec<ParsedChapter> {
    let chapter_track = input.take_chapter_track();
    if !chapter_track.is_empty() {
        return chapter_track;
    }
    let Ok(mut reader) = input.fork(8 * 1024 * 1024) else {
        return Vec::new();
    };
    let config = mp4ameta::ReadConfig {
        read_meta_items: false,
        read_chapter_track: false,
        read_image_data: false,
        read_audio_info: false,
        ..mp4ameta::ReadConfig::DEFAULT
    };
    let Ok(tag) = mp4ameta::Tag::read_with(&mut reader, &config) else {
        return Vec::new();
    };

    let chapter_track = tag.chapter_track();
    let (chapters, source) = if chapter_track.is_empty() {
        (tag.chapter_list(), "mp4-chapter-list")
    } else {
        (chapter_track, "mp4-chapter-track")
    };

    chapters
        .iter()
        .enumerate()
        .map(|(index, chapter)| ParsedChapter {
            title: if chapter.title.trim().is_empty() {
                format!("Chapter {}", index + 1)
            } else {
                clean_tag_text(&chapter.title)
            },
            start_seconds: chapter.start.as_secs_f64(),
            end_seconds: chapters
                .get(index + 1)
                .map(|next_chapter| next_chapter.start.as_secs_f64()),
            source: source.to_string(),
        })
        .collect()
}

fn read_id3_chapters(input: &MetadataInput) -> Vec<ParsedChapter> {
    let Ok(reader) = input.fork(TAG_BYTES) else {
        return Vec::new();
    };
    let Ok(tag) = id3::Tag::read_from2(reader) else {
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

pub(crate) fn merge_metadata_summary(metadata: &[TrackMetadata]) -> MetadataSummary {
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

pub(crate) fn merge_two_summaries(
    primary: MetadataSummary,
    fallback: MetadataSummary,
) -> MetadataSummary {
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

pub(crate) fn build_book_chapters(tracks: &[Track]) -> Vec<Chapter> {
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

pub(crate) fn derive_track_chapters(tracks: &[Track]) -> Vec<Chapter> {
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

pub(crate) fn unique_strings(values: Vec<String>) -> Vec<String> {
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

pub(crate) fn unique_metadata_fields(fields: Vec<MetadataField>) -> Vec<MetadataField> {
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

pub(crate) struct ScannedCover {
    pub(crate) mime_type: String,
    pub(crate) etag: String,
    pub(crate) len: u64,
    pub(crate) source: PathBuf,
    pub(crate) root: ScanRoot,
}

impl ScannedCover {
    fn from_image_in(root: ScanRoot, source: &FsPath, image: &EmbeddedImage) -> Self {
        Self {
            root,
            mime_type: image.mime_type.clone(),
            etag: image.etag.clone(),
            len: image.data.len() as u64,
            source: source.to_path_buf(),
        }
    }
}

pub(crate) trait CoverSource {
    fn mime_type(&self) -> &str;
    fn etag(&self) -> &str;
    fn len(&self) -> u64;
    fn into_image(self) -> Option<EmbeddedImage>;
}

#[cfg(test)]
impl CoverSource for EmbeddedImage {
    fn mime_type(&self) -> &str {
        &self.mime_type
    }

    fn etag(&self) -> &str {
        &self.etag
    }

    fn len(&self) -> u64 {
        self.data.len() as u64
    }

    fn into_image(self) -> Option<EmbeddedImage> {
        Some(self)
    }
}

impl CoverSource for ScannedCover {
    fn mime_type(&self) -> &str {
        &self.mime_type
    }

    fn etag(&self) -> &str {
        &self.etag
    }

    fn len(&self) -> u64 {
        self.len
    }

    fn into_image(self) -> Option<EmbeddedImage> {
        read_track_cover_art_in(&self.root, &self.source)
    }
}

pub(crate) fn write_covers<T: CoverSource + Send>(
    covers_dir: &FsPath,
    extracted: Vec<(String, T)>,
    published: &HashMap<String, CachedCover>,
) -> anyhow::Result<(HashMap<String, CachedCover>, Vec<PathBuf>)> {
    use rayon::prelude::*;

    create_private_directory(covers_dir)?;

    let written = extracted
        .into_par_iter()
        .map(|(book_id, input)| -> anyhow::Result<Option<(String, String, CachedCover)>> {
            let file_name = format!("{}.cover", sanitize_filename(&book_id));
            let path = covers_dir.join(&file_name);

            let known = published.get(&book_id).is_some_and(|cover| {
                cover.path == path && cover.etag == input.etag() && cover.len == input.len()
            });
            let unchanged = std::fs::metadata(&path)
                .ok()
                .is_some_and(|metadata| metadata.len() == input.len())
                && (known
                    || std::fs::read(&path)
                        .ok()
                        .is_some_and(|existing| bytes_etag(&existing) == input.etag()));
            let (mime_type, etag, len) = if unchanged {
                (
                    input.mime_type().to_string(),
                    input.etag().to_string(),
                    input.len(),
                )
            } else {
                let Some(image) = input.into_image() else {
                    tracing::warn!(book_id = %book_id, "cover art disappeared before it could be cached");
                    return Ok(None);
                };
                let nanos = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|since_epoch| since_epoch.as_nanos())
                    .unwrap_or(0);
                let temp_path = covers_dir.join(format!(".{file_name}.{nanos}.tmp"));
                std::fs::write(&temp_path, &image.data)?;
                replace_file_blocking(&temp_path, &path).map_err(|error| {
                    anyhow::anyhow!("could not publish cover {file_name}: {error}")
                })?;
                (image.mime_type, image.etag, image.data.len() as u64)
            };
            Ok(Some((
                book_id,
                file_name,
                CachedCover {
                    mime_type,
                    etag,
                    len,
                    path,
                },
            )))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;

    let mut cached = HashMap::new();
    let mut keep = HashSet::new();
    for (book_id, file_name, cover) in written.into_iter().flatten() {
        keep.insert(file_name);
        cached.insert(book_id, cover);
    }

    let mut stale = Vec::new();
    if let Ok(entries) = std::fs::read_dir(covers_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".cover") && !keep.contains(&name) {
                stale.push(entry.path());
            }
        }
    }
    Ok((cached, stale))
}

pub(crate) fn remove_stale_covers(stale: &[PathBuf]) {
    for path in stale {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod mapping_revision_tests {
    use super::*;

    #[test]
    fn revisions_flag_legacy_generated_maps_without_expiring_external_maps() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("book.sync.json");
        for (generator, revision, generated, expected) in [
            (None, 0, true, true),
            (Some("echogarden"), 0, false, true),
            (Some("other"), 0, false, false),
            (None, 0, false, false),
            (Some("echogarden"), alignment::MAPPING_REVISION, true, false),
            (
                Some("echogarden"),
                alignment::MAPPING_REVISION + 1,
                true,
                false,
            ),
        ] {
            std::fs::write(
                &path,
                serde_json::to_vec(&serde_json::json!({
                    "version": 2, "generator": generator, "mappingRevision": revision,
                    "precision": "sentence", "fragments": [],
                }))
                .unwrap(),
            )
            .unwrap();
            assert_eq!(
                probe_sync_map(&path, generated).map(|probe| probe.outdated),
                Some(expected)
            );
        }
        std::fs::write(&path, r#"{"precision":"estimated"}"#).unwrap();
        assert!(probe_sync_map(&path, true).is_none());
        std::fs::write(&path, "invalid").unwrap();
        assert!(probe_sync_map(&path, true).is_none());
    }

    #[test]
    fn remapping_an_outdated_sidecar_serves_the_current_generated_replacement() {
        let root = tempfile::tempdir().unwrap();
        let audio = root.path().join("book.mp3");
        let sidecar = root.path().join("book.sync.json");
        let generated_dir = root.path().join("sync");
        std::fs::create_dir(&generated_dir).unwrap();
        std::fs::write(&audio, []).unwrap();
        std::fs::write(&sidecar, r#"{"generator":"echogarden","fragments":[]}"#).unwrap();
        let generated = generated_dir.join("abc.sync.json");
        std::fs::write(&generated, serde_json::to_vec(&serde_json::json!({
            "generator": "echogarden", "mappingRevision": alignment::MAPPING_REVISION, "fragments": [],
        })).unwrap()).unwrap();
        let found = find_sync_file(
            "abc",
            &audio,
            std::slice::from_ref(&audio),
            "book",
            &generated_dir,
            &mut DirectoryFiles::default(),
        )
        .unwrap();
        assert_eq!(found.path, generated);
        assert!(!found.file.outdated);
    }

    #[test]
    fn a_scan_reports_the_grade_only_while_the_report_matches_the_map() {
        let root = tempfile::tempdir().unwrap();
        let audio = root.path().join("book.mp3");
        let sync_dir = root.path().join("sync");
        std::fs::create_dir(&sync_dir).unwrap();
        std::fs::write(&audio, []).unwrap();
        let map = sync_dir.join("abc.sync.json");
        let find = || {
            find_sync_file(
                "abc",
                &audio,
                std::slice::from_ref(&audio),
                "book",
                &sync_dir,
                &mut DirectoryFiles::default(),
            )
            .unwrap()
            .file
        };
        std::fs::write(&map, r#"{"generatedAt":"1","fragments":[]}"#).unwrap();
        assert!(!find().report_current);
        let report = serde_json::json!({
            "mapGeneratedAt": "1", "mapSize": std::fs::metadata(&map).unwrap().len(),
            "mapDigest": probe_sync_map(&map, true).unwrap().identity.map_digest,
            "graded": "run", "chapters": [{
                "index": 0, "label": "One", "startSeconds": 0.0, "endSeconds": 100.0,
                "textCoverage": 0.9, "gapSeconds": 0.0, "skippedText": 0, "status": "aligned",
            }],
        });
        std::fs::write(
            sync_dir.join("abc.report.json"),
            serde_json::to_vec(&report).unwrap(),
        )
        .unwrap();
        let file = find();
        assert!(file.report_current);
        assert_eq!(
            file.quality,
            Some(sync_report::SyncQuality {
                grade: sync_report::Grade::Review,
                flagged: 1
            })
        );
        std::fs::write(&map, r#"{"generatedAt":"2","fragments":[]}"#).unwrap();
        let file = find();
        assert!(!file.report_current);
        assert_eq!(file.quality, None);
    }
}

#[cfg(all(test, unix))]
mod scan_boundary_tests {
    use super::*;
    #[test]
    fn bounded_metadata_keeps_the_opened_track_after_path_substitution() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let path = root.path().join("book.wav");
        let samples = vec![0u8; 16_000];
        let mut wav = b"RIFF".to_vec();
        wav.extend((36 + samples.len() as u32).to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.extend(16u32.to_le_bytes());
        wav.extend([1, 0, 1, 0]);
        wav.extend(8_000u32.to_le_bytes());
        wav.extend(16_000u32.to_le_bytes());
        wav.extend([2, 0, 16, 0]);
        wav.extend(b"data");
        wav.extend((samples.len() as u32).to_le_bytes());
        wav.extend(samples);
        std::fs::write(&path, wav).unwrap();
        let scan = ScanRoot::new(root.path()).unwrap();
        let (opened, _) = scan.open(&path).unwrap();
        let replacement = outside.path().join("oversized.wav");
        std::fs::write(&replacement, b"ID3\x04\0\0\x7f\x7f\x7f\x7f").unwrap();
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&replacement, &path).unwrap();
        let metadata = read_track_metadata_file(opened, &path);
        assert_eq!(metadata.duration_seconds, Some(1.0));
        assert!(read_track_metadata_in(&scan, &path).is_err());
        assert!(read_track_cover_art_in(&scan, &path).is_none());
    }
    #[test]
    fn replaced_track_cannot_supply_fingerprint_tags_cover_or_sync_metadata() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let path = root.path().join("book.mp3");
        std::fs::write(&path, b"inside").unwrap();
        let scan = ScanRoot::new(root.path()).unwrap();
        let (first, cache) = fingerprint_tracks_in(
            &scan,
            root.path(),
            std::slice::from_ref(&path),
            BTreeMap::new(),
        )
        .unwrap();
        assert!(!first[&path].starts_with("path:"));
        let secret = outside.path().join("secret.mp3");
        std::fs::write(&secret, b"outside").unwrap();
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&secret, &path).unwrap();
        assert!(
            fingerprint_tracks_in(&scan, root.path(), std::slice::from_ref(&path), cache).is_err()
        );
        assert!(read_track_metadata_in(&scan, &path).is_err());
        assert!(read_track_cover_art_in(&scan, &path).is_none());
        let sync = root.path().join("book.sync.json");
        std::os::unix::fs::symlink(&secret, &sync).unwrap();
        assert!(scan.open(&sync).is_err());
    }
}

#[cfg(all(test, unix))]
mod sync_probe_boundary_tests {
    use super::*;
    #[test]
    fn report_probe_never_uses_a_replaced_maps_parent_as_its_root() {
        let library = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let directory = library.path().join("Book");
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("Book.sync.json");
        std::fs::write(&path, r#"{"precision":"sentence","generatedAt":"inside"}"#).unwrap();
        let roots = [library.path().to_path_buf()];
        assert!(probe_sync_map_in(&path, false, &roots).is_some());
        std::fs::write(
            outside.path().join("Book.sync.json"),
            r#"{"precision":"sentence","generatedAt":"outside-secret"}"#,
        )
        .unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&directory).unwrap();
        std::os::unix::fs::symlink(outside.path(), &directory).unwrap();
        assert!(probe_sync_map_in(&path, false, &roots).is_none());
    }
}
