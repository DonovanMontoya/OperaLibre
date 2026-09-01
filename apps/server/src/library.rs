//! Extracted from main.rs.
//!
//! # Book identity
//!
//! Playback progress, per-book settings, metadata overrides and per-user access
//! grants are all keyed by `book_id`, so which book an identity attaches to
//! decides who can reach what. Identities are resolved once per scan by
//! [`resolve_library_identities`], which matches the whole scan at once rather
//! than group by group: matching one at a time makes the outcome depend on
//! where a folder sorts in the walk, and lets an early book consume an identity
//! belonging to a later one.
//!
//! Evidence is ranked. A book's current content fingerprint is the strongest
//! signal, a previously recorded fingerprint is weaker, and a remembered path
//! is weakest of all — paths get recycled, and identities are never pruned. A
//! claim is granted only when it is unambiguous in both directions: the scanned
//! book has exactly one candidate identity, and that identity is a candidate
//! for exactly one scanned book. Anything else mints a new identity, because a
//! wrong match moves a listener's position and their access to a book they were
//! never granted.
//!
//! ## What the path tier is, and is not
//!
//! The weakest tier exists for one real case: a faststart remux rewrites a
//! file's bytes in place, leaving the path unchanged and every fingerprint
//! stale. Without it, routine maintenance would detach every book it touched.
//!
//! It is guarded by staleness, by the identity being absent from the rest of
//! the scan, and by the book's shape — track count, and total runtime within
//! [`LAYOUT_DURATION_TOLERANCE`] (1%, or two seconds, whichever is larger). A
//! container rewrite preserves both exactly; unrelated content almost never
//! matches either.
//!
//! The runtime half of that guard is not always available. An identity
//! migrated from the pre-versioned format has never recorded a duration, and
//! neither has one whose files carry no readable duration tag, so until one
//! successful scan supplies it the tier is guarded by track count alone. The
//! reverse case is closed deliberately: once a duration *is* known, a scan that
//! cannot produce one fails the guard rather than falling back to the count,
//! because unreadable tags are exactly what a replacement looks like.
//!
//! Those guards make accidental misattribution unlikely. They are **not** an
//! authorization boundary. Content that arrives at a book's path, within the
//! staleness window, with the same track count and a runtime inside that
//! tolerance, will inherit that book's identity — and with it the progress and
//! access grants attached to it. Nothing available at this tier distinguishes
//! that from the remux it is meant to serve.
//!
//! Treat path-tier continuity as best effort. Anyone who can write to the
//! library directory is already trusted with its contents: the fingerprint
//! itself covers only the file's size and its first and last 64 KiB, and the
//! cache that avoids recomputing it trusts size and mtime. Closing this
//! properly needs evidence from outside the scan — authenticating the volume a
//! root lives on, or carrying provenance from the conversion that rewrote the
//! file.

use crate::*;

pub(crate) const AUDIO_EXTENSIONS: &[&str] = &[
    "aac", "aiff", "flac", "m4a", "m4b", "mp3", "mp4", "ogg", "opus", "wav",
];

pub(crate) const READING_EXTENSIONS: &[&str] = &["epub", "html", "htm", "pdf", "txt"];

pub(crate) const SYNC_SIDECAR_SUFFIX: &str = ".sync.json";

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct MetadataOverrideStore {
    pub(crate) books: HashMap<String, BookMetadataOverride>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BookMetadataOverride {
    pub(crate) title: Option<String>,
    pub(crate) author: Option<String>,
    pub(crate) narrator: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) genres: Option<Vec<String>>,
    pub(crate) published_date: Option<String>,
    pub(crate) publisher: Option<String>,
    pub(crate) series: Option<String>,
    pub(crate) series_position: Option<String>,
    pub(crate) asin: Option<String>,
}

#[derive(Default)]
pub(crate) struct LibraryState {
    pub(crate) books: Vec<Book>,
    /// File for a root-level single-track book, or the containing directory
    /// for a grouped book. Used by the admin-only local-copy deletion route.
    pub(crate) book_paths: HashMap<String, PathBuf>,
    pub(crate) track_paths: HashMap<String, PathBuf>,
    pub(crate) reading_paths: HashMap<String, PathBuf>,
    /// Sync map file paths keyed by book id.
    pub(crate) sync_paths: HashMap<String, PathBuf>,
    /// Cover art, extracted to disk during the scan. Holding every embedded
    /// image in memory cost a gigabyte on a few thousand books, and every
    /// request copied one again on its way out.
    pub(crate) cover_art: HashMap<String, CachedCover>,
}

impl LibraryState {
    /// The catalogue entry for `book_id`, or the 404 every book route returns.
    pub(crate) fn book(&self, book_id: &str) -> Result<&Book, ApiError> {
        self.books
            .iter()
            .find(|candidate| candidate.id == book_id)
            .ok_or(ApiError::not_found("Book not found"))
    }
}

/// An extracted cover on disk.
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
    /// Bumped when the on-disk shape changes. Absent means the pre-versioned
    /// format, which `migrate_legacy_identities` rewrites on load.
    #[serde(default)]
    pub(crate) version: u32,
    #[serde(default)]
    pub(crate) books: Vec<BookIdentity>,
    /// Track fingerprints keyed by root and then by root-relative path, so a
    /// rescan only re-reads files whose size or modification time changed.
    /// Nesting by root keeps two roots that share a relative path from
    /// colliding in the cache.
    #[serde(default)]
    pub(crate) fingerprint_cache: BTreeMap<String, BTreeMap<String, CachedFingerprint>>,
    /// Monotonic scan counter. Identities carry the value of the scan that last
    /// saw them, which is what makes a long-dead identity ineligible for the
    /// path tier.
    #[serde(default)]
    pub(crate) scan_counter: u64,
    /// The set of book fingerprints committed by the last wholly successful
    /// scan of each root. Adoption and sanity checks compare against this
    /// rather than against every identity ever recorded.
    #[serde(default)]
    pub(crate) manifests: BTreeMap<String, RootManifest>,
    /// A shrunken scan result seen but not yet accepted, per root. A drive that
    /// really did lose books reports the same reduced count every time, so the
    /// gate lets it through once it has been confirmed rather than stranding
    /// the library forever.
    #[serde(default)]
    pub(crate) pending_shrink: BTreeMap<String, PendingShrink>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingShrink {
    pub(crate) book_count: usize,
    /// Digest of the book locations the shrunken scan actually found. A count
    /// alone would let a mount that returns a different twenty books each time
    /// confirm a reduction it never demonstrated.
    #[serde(default)]
    pub(crate) signature: String,
    pub(crate) observations: u32,
}

/// How many consecutive scans must agree on a shrunken library before it is
/// accepted. Three consecutive identical results is a deliberate change or a
/// genuinely lost drive; a flapping mount does not produce it.
pub(crate) const SHRINK_CONFIRMATIONS: u32 = 3;

/// The reserved root ID for a single-root install. Every alias migrated from
/// the pre-versioned format is stamped with it.
pub(crate) const DEFAULT_ROOT_ID: &str = "default";

/// The current on-disk identity format.
pub(crate) const IDENTITY_FORMAT_VERSION: u32 = 1;

/// How many historical book fingerprints an identity remembers. A remux
/// rewrites every track, so without history a remux plus a rename would leave
/// no evidence at all; a short window covers that without unbounded growth.
const MAX_FINGERPRINT_HISTORY: usize = 8;

/// How far a book's runtime may drift and still be taken for the same
/// recording. A container rewrite preserves duration exactly; this only
/// absorbs rounding in how different muxers report it.
const LAYOUT_DURATION_TOLERANCE: f64 = 0.01;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RootManifest {
    #[serde(default)]
    pub(crate) book_fingerprints: Vec<String>,
    #[serde(default)]
    pub(crate) scan: u64,
}

/// A path recorded against the root that owns it.
///
/// A bare relative path is ambiguous the moment a second root exists: two
/// drives can each hold `Dune/01.m4b`. Pairing the path with its root is what
/// keeps one root's aliases from matching another's books.
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
    /// Recent previous fingerprints, newest last, excluding the current one.
    /// Kept so an in-place rewrite does not erase the evidence that identifies
    /// the book, and so a theft cannot destroy its victim's history.
    #[serde(default)]
    pub(crate) fingerprint_history: Vec<String>,
    pub(crate) book_id: String,
    #[serde(default)]
    pub(crate) paths: Vec<IdentityPath>,
    #[serde(default)]
    pub(crate) tracks: Vec<TrackIdentity>,
    /// The scan counter value when this identity was last matched.
    #[serde(default)]
    pub(crate) last_seen_scan: u64,
    /// The book's shape when last seen. A container rewrite preserves both, so
    /// they are what distinguish a remux from unrelated content arriving at
    /// the same path. Zero and `None` mean "not yet recorded" — a migrated
    /// identity has neither until its first scan under this format.
    #[serde(default)]
    pub(crate) track_count: usize,
    #[serde(default)]
    pub(crate) duration_seconds: Option<f64>,
}

impl BookIdentity {
    /// True when `fingerprint` is the current digest or one of the remembered
    /// previous ones.
    pub(crate) fn matches_fingerprint(&self, fingerprint: &str) -> bool {
        self.fingerprint == fingerprint
            || self
                .fingerprint_history
                .iter()
                .any(|candidate| candidate == fingerprint)
    }

    /// Record a new current fingerprint, retiring the previous one into
    /// history rather than overwriting it.
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
    pub(crate) description: Option<String>,
    pub(crate) genres: Vec<String>,
    pub(crate) published_date: Option<String>,
    pub(crate) asin: Option<String>,
    pub(crate) reading_file: Option<ReadingFile>,
    pub(crate) sync_file: Option<SyncFile>,
    pub(crate) chapters: Vec<Chapter>,
    pub(crate) metadata: MetadataSummary,
    pub(crate) tracks: Vec<Track>,
    pub(crate) progress: Option<BookProgress>,
    /// What the *other* listeners on this server have done with the book.
    /// Only populated for viewers who share their own progress, and only with
    /// users who share theirs.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) shared_progress: Vec<SharedProgress>,
    /// The viewer's own playback gain for this book, as a linear multiplier of
    /// the file's level. Books are mastered at wildly different loudnesses, so
    /// this is per book rather than a single device volume.
    pub(crate) volume_gain: f64,
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
    pub(crate) file_name: String,
    /// `sidecar` when found beside the audiobook, `generated` when produced
    /// by the alignment job into the server's data directory.
    pub(crate) source: String,
    pub(crate) url: String,
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
    pub(crate) asin: Option<String>,
}

#[derive(Default)]
pub(crate) struct TrackMetadata {
    pub(crate) title: Option<String>,
    pub(crate) author: Option<String>,
    pub(crate) narrator: Option<String>,
    pub(crate) duration_seconds: Option<f64>,
    pub(crate) asin: Option<String>,
    pub(crate) chapters: Vec<ParsedChapter>,
    pub(crate) cover_art: Option<EmbeddedImage>,
    pub(crate) summary: MetadataSummary,
}

#[derive(Default)]
pub(crate) struct ParsedChapter {
    pub(crate) title: String,
    pub(crate) start_seconds: f64,
    pub(crate) end_seconds: Option<f64>,
    pub(crate) source: String,
}

/// Optional paging for the library listing.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListBooksQuery {
    /// Omitted means the whole library, which is what every existing client
    /// asks for and keeps asking for.
    pub(crate) limit: Option<usize>,
    /// The last book id from the previous page.
    pub(crate) cursor: Option<String>,
}

/// The largest page a client may ask for at once.
const MAX_BOOKS_PAGE: usize = 500;

pub(crate) async fn list_books(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Query(query): Query<ListBooksQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let mut books = books_with_progress(&state, &auth).await?;

    // Paging is by the id of the last book seen rather than by offset: a
    // rescan between two pages can insert or remove a book, and an offset
    // would then skip or repeat one.
    let mut next_cursor = None;
    if let Some(limit) = query.limit {
        if let Some(cursor) = query.cursor.as_deref() {
            // A cursor for a book this listener can no longer see - it was
            // removed, or access was revoked - restarts rather than fails,
            // which is the behaviour a paging client can actually recover
            // from mid-scroll.
            if let Some(index) = books.iter().position(|book| book.id == cursor) {
                books.drain(..=index);
            }
        }
        let limit = limit.clamp(1, MAX_BOOKS_PAGE);
        if books.len() > limit {
            books.truncate(limit);
            next_cursor = books.last().map(|book| book.id.clone());
        }
    }

    // The tag covers the response as it was actually built, so a change to a
    // shared listener's position or to a volume gain invalidates it too. It
    // also covers the navigation state: a page that was exactly full gains a
    // next cursor when a later-sorting book arrives, with a body that did not
    // change, and a client holding only the old tag must not be told there is
    // nothing new. A cheaper tag derived from a library counter would answer
    // 304 to some requests whose content had in fact changed.
    let body = serde_json::to_vec(&books)?;
    let mut tag_input = Vec::with_capacity(body.len() + 32);
    tag_input.extend_from_slice(&body);
    match &next_cursor {
        Some(cursor) => {
            tag_input.extend_from_slice(b"\nnext:");
            tag_input.extend_from_slice(cursor.as_bytes());
        }
        None => tag_input.extend_from_slice(b"\nend"),
    }
    let etag = bytes_etag(&tag_input);
    drop(tag_input);
    if if_none_match_matches(&headers, &etag) {
        return Ok(Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(ETAG, &etag)
            .header(CACHE_CONTROL, "private, no-cache")
            .body(Body::empty())?);
    }

    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/json")
        .header(ETAG, &etag)
        .header(CACHE_CONTROL, "private, no-cache");
    if let Some(cursor) = next_cursor {
        response = response.header("x-next-cursor", cursor);
    }
    Ok(response.body(Body::from(body))?)
}

pub(crate) async fn rescan(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
) -> Result<Json<Vec<Book>>, ApiError> {
    rescan_library(&state).await?;
    Ok(Json(books_with_progress(&state, &auth).await?))
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
    let metadata_override = metadata_override_from_update(payload)?;
    state.library.read().await.book(&book_id)?;

    state
        .metadata_overrides
        .mutate(|overrides| {
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
            // The store is about to be rewritten in a shape older builds cannot
            // read, so keep the one they can. Failing to write it aborts the
            // load: a migration whose promised rollback does not exist is worse
            // than not migrating.
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

/// The pre-versioned on-disk shape: bare relative path strings and a flat
/// fingerprint cache.
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

/// Parse either format. The absence of `version` is what marks the old one;
/// every existing install has no such field.
///
/// Migration preserves every issued `bookId` and `trackId` byte for byte —
/// progress, settings and access grants are keyed by them, so reminting here
/// would detach all three.
pub(crate) struct LoadedIdentities {
    pub(crate) store: LibraryIdentityStore,
    /// True when the file on disk was in the pre-versioned shape, so the
    /// caller knows a backup is owed before it is overwritten.
    pub(crate) migrated: bool,
}

pub(crate) fn parse_library_identities(contents: &str) -> anyhow::Result<LoadedIdentities> {
    let value: serde_json::Value = serde_json::from_str(contents)?;
    let versioned = value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    if versioned >= 1 {
        if versioned > u64::from(IDENTITY_FORMAT_VERSION) {
            anyhow::bail!(
                "library-identities.json was written by a newer OperaLibre (format {versioned}, this build understands {IDENTITY_FORMAT_VERSION})."
            );
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
            // Legacy identities have never been stamped. Zero is a deliberate
            // "never seen under this format": it holds them out of the
            // path-only tier until one successful scan has confirmed where
            // they actually are. The cost is that a book rewritten in place
            // *between* the upgrade and the first scan gets a new identity;
            // the alternative is trusting an unverified path on the one scan
            // with the least evidence behind it.
            last_seen_scan: 0,
            track_count: 0,
            duration_seconds: None,
        })
        .collect();

    // Seed the shrink baseline so the first scan after an upgrade is gated like
    // any other. Without it `known` is zero, and a silently partial first scan
    // — an error-free walk of a half-mounted drive — is committed on the spot,
    // publishing an incomplete catalogue at exactly the moment the store holds
    // the most evidence that the library is larger than that.
    //
    // The baseline counts only the books the legacy store can still show were
    // present. Legacy identities were never pruned, so the full list includes
    // every book ever deleted and would overstate the library, withholding
    // scans that are perfectly good. The legacy fingerprint cache was rebuilt
    // from scratch on every scan, so its keys are exactly the track paths the
    // last successful scan walked: a book with a track in that cache was there,
    // and one without it either is gone or could not be read. Erring towards
    // the smaller count keeps the gate conservative in the safe direction.
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
                // Scan zero: the baseline was inherited, not observed under
                // this format.
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

/// Remember where an identity has been seen, most recent last.
///
/// A path already known is moved to the end rather than left in place, so the
/// eviction below drops genuinely stale aliases instead of the one the book
/// currently lives at.
pub(crate) fn remember_identity_path(paths: &mut Vec<IdentityPath>, path: IdentityPath) {
    const MAX_IDENTITY_PATH_ALIASES: usize = 32;
    paths.retain(|candidate| candidate != &path);
    paths.push(path);
    let excess = paths.len().saturating_sub(MAX_IDENTITY_PATH_ALIASES);
    paths.drain(..excess);
}

/// A fresh 128-bit identity ID.
///
/// Deliberately not derived from the path: `stable_id` is deterministic, so a
/// path-derived mint reproduces the ID of whatever previously occupied that
/// location, and the new book inherits its progress and access grants.
pub(crate) fn mint_identity_id() -> String {
    use rand::RngExt;
    let mut bytes = [0_u8; 16];
    rand::rng().fill(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn file_identity_fingerprint(path: &FsPath) -> anyhow::Result<String> {
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
pub(crate) fn path_identity_fingerprint(path: &FsPath) -> String {
    format!("path:{}", stable_id(&path.to_string_lossy()))
}

/// One file's scan result: where it is, how the identity store names it, its
/// fingerprint, and the size and mtime the cache is keyed on.
type ScannedFingerprint = (PathBuf, String, String, Option<(u64, u64)>);

/// Fingerprints every track in the library once per scan, reusing the stored
/// digest whenever a file's size and modification time are unchanged. Reading
/// 128 KB per track on every rescan is the dominant cost on large libraries,
/// so the steady state here is one stat per file.
///
/// Blocking: run this on a blocking task, not on a runtime worker.
pub(crate) fn fingerprint_tracks(
    library_root: &FsPath,
    files: &[PathBuf],
    previous: BTreeMap<String, CachedFingerprint>,
) -> (
    HashMap<PathBuf, String>,
    BTreeMap<String, CachedFingerprint>,
) {
    use rayon::prelude::*;

    // Each file is fingerprinted independently, and the work is a content hash
    // over the file, so it fans out across the pool. The results are collected
    // in the input's order and folded afterwards, which keeps the outcome
    // identical to the sequential walk regardless of completion order.
    let scanned: Vec<ScannedFingerprint> = files
        .par_iter()
        .map(|path| {
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
            (path.clone(), alias, fingerprint, stat)
        })
        .collect();

    let mut fingerprints = HashMap::with_capacity(files.len());
    // Rebuilt from scratch so entries for removed files are pruned.
    let mut cache = BTreeMap::new();
    for (path, alias, fingerprint, stat) in scanned {
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
        fingerprints.insert(path, fingerprint);
    }

    (fingerprints, cache)
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

/// How many scans an identity may go unseen before its remembered paths stop
/// being accepted as evidence on their own. Content evidence never expires;
/// only the path claim does, because paths get recycled and identities are
/// never pruned.
pub(crate) const PATH_TIER_STALE_AFTER_SCANS: u64 = 3;

/// One scanned book, before it has been matched to a stored identity.
pub(crate) struct ScannedGroup<'a> {
    pub(crate) book_fingerprint: &'a str,
    pub(crate) group_alias: &'a str,
    pub(crate) root_id: &'a str,
    pub(crate) grouped_files: &'a [PathBuf],
    pub(crate) track_fingerprints: &'a [String],
    pub(crate) track_aliases: &'a [String],
    /// Total runtime, where the tags carried one.
    pub(crate) duration_seconds: Option<f64>,
}

/// Claims only edges that are unambiguous in BOTH directions: the position
/// must have exactly one candidate, and that candidate must be proposed by
/// exactly one position. Checking only the first direction leaves the outcome
/// dependent on which position is visited first, which is the ordering bug
/// the identity resolver exists to remove.
///
/// The count covers every edge, not just positions that happen to have a
/// single candidate: a candidate wanted by one certain position and one
/// uncertain position is still contested, and handing it to the certain one
/// is a guess.
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

/// Resolve every scanned group against the stored identities at once.
///
/// The previous implementation walked groups in scan order and took the first
/// unused identity matching either the path or the fingerprint. That is
/// order-dependent: a book processed early can consume an identity that
/// belongs to one processed later, and a recycled path can claim an identity
/// outright. Resolving globally removes the ordering, and the passes below
/// only ever act on evidence that is unambiguous.
///
/// Returns one `(book_id, track_ids)` per input group, in input order.
pub(crate) fn resolve_library_identities(
    store: &mut LibraryIdentityStore,
    groups: &[ScannedGroup<'_>],
    mint: &mut dyn FnMut() -> String,
) -> Vec<(String, Vec<String>)> {
    let scan = store.scan_counter.saturating_add(1);
    let mut claimed_by: Vec<Option<usize>> = vec![None; groups.len()];
    let mut used: HashSet<usize> = HashSet::new();

    // The fingerprints present anywhere in this scan. Pass 3 uses this to
    // refuse a path-only claim whose identity is demonstrably alive elsewhere.
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

    // An identity whose *current* digest is still unaccounted for in this scan
    // is alive somewhere the resolver has not placed yet, so weaker evidence
    // pointing at it from elsewhere is a stale alias or an old copy.
    //
    // Groups already claimed are excluded deliberately. Two byte-identical
    // copies share a digest, so a bare "does this digest appear anywhere" test
    // would report both identities as alive whenever either copy is present,
    // and close the later tiers against a copy that was genuinely remuxed.
    let current_is_present = |identity: &BookIdentity, claimed_by: &[Option<usize>]| {
        groups.iter().enumerate().any(|(position, group)| {
            claimed_by[position].is_none() && group.book_fingerprint == identity.fingerprint
        })
    };

    // A book's shape: how many tracks it has and how long it runs. A faststart
    // remux preserves both exactly (`-c copy` rewrites the container, not the
    // audio); an unrelated book replacing it at the same path almost never
    // matches either. This is what keeps the path-only tier from treating
    // every same-path replacement as a remux.
    let layout_matches = |identity: &BookIdentity, group: &ScannedGroup<'_>| {
        if identity.track_count != 0 && identity.track_count != group.grouped_files.len() {
            return false;
        }
        match (identity.duration_seconds, group.duration_seconds) {
            (Some(known), Some(found)) => {
                let tolerance = (known.abs() * LAYOUT_DURATION_TOLERANCE).max(2.0);
                (known - found).abs() <= tolerance
            }
            // The identity knows how long this book is and the scan cannot say.
            // Unreadable tags are exactly what a replacement looks like, so the
            // tier closes rather than taking the path's word for it.
            (Some(_), None) => false,
            // A migrated identity has never recorded a duration. Track count
            // alone still has to agree, and the next scan records the rest.
            (None, _) => true,
        }
    };

    // One tier: collect each unclaimed group's candidate identities under this
    // tier's eligibility rule, then let the shared bidirectional claim decide.
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

    // Pass 1 — remembered path and the identity's *current* digest agree. The
    // steady state, and the only tier that can separate two byte-identical
    // copies, because their paths are the only thing that differs.
    claim_pass(&mut claimed_by, &mut used, &|identity, group| {
        path_matches(identity, group) && identity.fingerprint == group.book_fingerprint
    });

    // Pass 2 — the current digest alone, when exactly one identity carries it.
    // Carries an ordinary move or rename.
    claim_pass(&mut claimed_by, &mut used, &|identity, group| {
        identity.fingerprint == group.book_fingerprint
    });

    // Pass 3 — a historical digest, and only for an identity whose current
    // digest is nowhere in this scan. Without that guard an old copy left at a
    // stale alias could out-claim the live book, since it matches history at a
    // remembered path while the real book matches neither.
    let snapshot = claimed_by.clone();
    claim_pass(&mut claimed_by, &mut used, &|identity, group| {
        !current_is_present(identity, &snapshot)
            && identity.matches_fingerprint(group.book_fingerprint)
            && path_matches(identity, group)
    });

    // Pass 4 — a historical digest carried by exactly one identity, path
    // unknown. Recovers a book that was both rewritten and moved.
    let snapshot = claimed_by.clone();
    claim_pass(&mut claimed_by, &mut used, &|identity, group| {
        !current_is_present(identity, &snapshot)
            && identity.matches_fingerprint(group.book_fingerprint)
    });

    // Pass 5 — the remembered path alone. This is what carries a book whose
    // bytes changed underneath it: the normal outcome of a faststart remux.
    //
    // Three guards narrow it. None of the identity's digests may appear
    // anywhere in this scan, because if one does the identity is alive
    // elsewhere and this path has been recycled. The identity must have been
    // seen recently, because a long-dead identity's remembered path is exactly
    // what a new book at a reused location collides with. And the book's shape
    // must still match, which is what separates a remux from a replacement.
    let snapshot_p5 = claimed_by.clone();
    claim_pass(&mut claimed_by, &mut used, &|identity, group| {
        if !path_matches(identity, group) {
            return false;
        }
        if current_is_present(identity, &snapshot_p5)
            || identity
                .fingerprint_history
                .iter()
                .any(|candidate| scanned_fingerprints.contains(candidate.as_str()))
        {
            return false;
        }
        if identity.last_seen_scan == 0
            || scan.saturating_sub(identity.last_seen_scan) > PATH_TIER_STALE_AFTER_SCANS
        {
            return false;
        }
        layout_matches(identity, group)
    });

    // Anything still unclaimed is a book this library has not seen before, and
    // gets a fresh opaque ID. It must never be derived from the path: a
    // path-derived ID would reproduce the exact ID of whatever used to live
    // there, handing the newcomer its progress and access grants — the very
    // theft the passes above just refused.
    //
    // Both taken-ID sets are built once here and updated as IDs are minted.
    // Rebuilding them per book made a first scan quadratic in the size of the
    // library, which is precisely the scan that has the most to mint.
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
        });
        claimed_by[position] = Some(index);
        used.insert(index);
    }

    let mut outcomes = Vec::with_capacity(groups.len());
    for (position, group) in groups.iter().enumerate() {
        let index = claimed_by[position].expect("every group is claimed or minted above");
        let identity = &mut store.books[index];
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

/// Draw IDs until one is unused. A 128-bit ID makes a collision
/// vanishingly unlikely, but an injected generator in tests can force one, and
/// silently reusing an ID would transfer progress.
fn mint_unique_id(mint: &mut dyn FnMut() -> String, taken: &HashSet<String>) -> String {
    for _ in 0..64 {
        let candidate = mint();
        if !taken.contains(&candidate) {
            return candidate;
        }
    }
    panic!("could not mint a unique identity ID after 64 attempts");
}

/// Match a book's tracks the same way, scoped to the one identity.
///
/// Track IDs are stored on progress rows, so a track claimed by the wrong file
/// moves a listening position within the book.
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

    // The same bidirectional rule the book passes use. Track ids are stored on
    // progress rows, so a track claimed by the wrong file moves a listening
    // position within the book — and two files sharing a fingerprint inside one
    // book is ordinary (silence, an intro sting, a duplicated chapter).
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

    // Pass 1 — path and fingerprint agree.
    claim_track_pass(&mut claimed, &mut used, &|track, position, alias| {
        path_matches(track, alias) && track.fingerprint == group.track_fingerprints[position]
    });

    // Pass 2 — a fingerprint carried by exactly one track.
    claim_track_pass(&mut claimed, &mut used, &|track, position, _alias| {
        track.fingerprint == group.track_fingerprints[position]
    });

    // Pass 3 — the remembered path, for a track whose stored fingerprint is
    // gone from this book: the per-file shape of an in-place rewrite.
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

/// A scan may drop to this fraction of the previously committed book count
/// before it is treated as suspect. Real libraries lose a book at a time; a
/// half-mounted or half-copied one loses most of them at once.
pub(crate) const SCAN_SHRINK_FLOOR: f64 = 0.5;

/// The outcome of judging a completed walk.
pub(crate) enum ScanVerdict {
    /// Trustworthy: resolve against the stored identities and persist.
    Commit,
    /// Suspect: leave stored identities untouched. The shrink observation is
    /// still recorded so a genuine reduction can be confirmed over successive
    /// scans, carrying both the count and which books were seen.
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

/// Decide whether a completed walk is trustworthy enough to rewrite identities.
///
/// A traversal error is never trusted. A scan that lost most of the library is
/// withheld the first time and accepted once repeated, so a real deletion is
/// not permanently mistaken for a mount failure.
/// Identify a scan by the set of book locations it found, order-independently.
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
        // A failed traversal says nothing about the library's real size, so it
        // must not count towards confirming a shrink.
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
        // Nothing committed yet: a first scan, or a library that has always
        // been empty. There is no baseline to be suspicious against.
        return ScanVerdict::Commit;
    }

    #[allow(clippy::cast_precision_loss)]
    let ratio = scanned_books as f64 / known as f64;
    if scanned_books > 0 && ratio >= SCAN_SHRINK_FLOOR {
        return ScanVerdict::Commit;
    }

    // The same reduced result, seen repeatedly, is the library's real size.
    // "Same" means the same books, not merely the same number of them.
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

/// Records what a withheld scan observed, without touching identities.
///
/// A matching observation extends the current run; a different shrink starts a
/// new one. A traversal failure breaks the run: "three consecutive scans" has
/// to mean three scans that actually observed the library, otherwise a drive
/// flapping between readable and unreadable eventually confirms a reduction it
/// never demonstrated.
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
    let scan_root = state.library_root.clone();
    let (groups, walk_errors) = tokio::task::spawn_blocking(move || {
        let walk = walk_audio_files_checked(&scan_root);
        (group_files_into_books(&scan_root, walk.files), walk.errors)
    })
    .await?;
    let mut identities = load_library_identities(&state.library_identities_file).await?;

    // A scan that could not read part of the library is not evidence that the
    // library shrank, so an untrusted scan stops here, before anything derived
    // from it can reach the catalogue. Resolving it against a scratch copy and
    // publishing the result would hand listeners book and track ids that exist
    // only for this scan, and progress written against those is unrecoverable.
    // The previously published library stays up instead.
    //
    // At startup there is no previously published library, so a suspect first
    // scan leaves the catalogue empty until something triggers another one — a
    // restart, an upload, a download, a faststart job, or the administrative
    // rescan endpoint. Recovery is on the next scan, not on the drive
    // reappearing. That is the intended trade: an empty library is visibly
    // wrong and one rescan away from correct, whereas a library rebuilt from a
    // half-mounted directory looks right and quietly detaches everything it
    // could not see.
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
        // Only the observation is written; identities are untouched.
        write_json_atomic(&state.library_identities_file, &identities)
            .await
            .map_err(|error| anyhow::anyhow!(error.message))?;
        return Ok(());
    }

    // Every track is fingerprinted up front on a blocking task: the reads are
    // synchronous and a large library would otherwise stall a runtime worker
    // for the whole scan.
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

    let fingerprint_task = tokio::task::spawn_blocking(move || {
        fingerprint_tracks(&library_root, &scanned_files, cached_fingerprints)
    });
    // Tag reading is the slowest part of a first scan, and every file is
    // independent, so it fans out across the pool instead of walking the list
    // on one thread.
    let metadata_task = tokio::task::spawn_blocking(move || {
        use rayon::prelude::*;
        metadata_files
            .into_par_iter()
            .map(|path| {
                let metadata = read_track_metadata(&path);
                (path, metadata)
            })
            .collect::<HashMap<_, _>>()
    });
    let (track_fingerprints_by_path, fingerprint_cache) = fingerprint_task.await?;
    let mut metadata_by_path = metadata_task.await?;
    identities
        .fingerprint_cache
        .insert(DEFAULT_ROOT_ID.to_string(), fingerprint_cache);

    let metadata_overrides = state.metadata_overrides.read().await.clone();
    let mut track_paths = HashMap::new();
    let mut book_paths = HashMap::new();
    let mut reading_paths = HashMap::new();
    let mut sync_paths = HashMap::new();
    let mut extracted_covers: Vec<(String, EmbeddedImage)> = Vec::new();
    let mut books = Vec::new();

    // Stage one: describe every scanned book. Resolution needs to see the whole
    // scan before it decides anything, so nothing is matched inside this loop.
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
            // Summed from the tags read above. A book whose files carry no
            // duration simply has none, and the layout guard falls back to
            // track count alone.
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

    // Stage two: resolve the whole scan at once, so no book's position in the
    // walk can decide which identity it gets.
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

    for (position, group) in prepared.into_iter().enumerate() {
        let PreparedGroup {
            group_key,
            grouped_files,
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

        let cover_art_url = metadata
            .iter()
            .find_map(|item| item.cover_art.clone())
            .map(|image| {
                extracted_covers.push((book_id.clone(), image));
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

    // Reaching here means the scan was trustworthy: a suspect one returned
    // long before this point. Any run of shrink observations is therefore over.
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
    // Identities are persisted before anything else records the IDs they just
    // minted. Now that new IDs are random rather than derived from the path,
    // a rescan after a failed write mints *different* IDs, so a store written
    // first would keep permanent references to editions the library will never
    // hand out again. Written in this order, a failure here leaves the works
    // store with nothing to dangle from, and the retry resolves the same
    // fingerprints to the same persisted IDs.
    write_json_atomic(&state.library_identities_file, &identities)
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;

    resolve_book_works(state, &books).await?;

    // Cover extraction touches the disk for every book with art, so it runs
    // before the lock is taken: holding the library write guard through it
    // would stall every route that reads the library, including media
    // streaming, for the length of the pass.
    let covers_dir = state.covers_dir.clone();
    let (cover_art, stale_covers) =
        tokio::task::spawn_blocking(move || write_cover_cache(&covers_dir, extracted_covers))
            .await
            .map_err(|error| anyhow::anyhow!("cover extraction failed: {error}"))??;

    {
        let mut library = state.library.write().await;
        library.books = books;
        library.book_paths = book_paths;
        library.track_paths = track_paths;
        library.reading_paths = reading_paths;
        library.sync_paths = sync_paths;
        library.cover_art = cover_art;
    }
    // Only now is the published library done with these.
    remove_stale_covers(&stale_covers);
    Ok(())
}

/// Builds one book's track list, in walk order, from the tags read during the
/// scan.
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
        .collect()
}

/// The book's display title before sidecar and user overrides: album or track
/// tag for a single-file book, folder name for a grouped one.
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

/// Resolves the stable work identity after a complete scan. Playback remains
/// keyed by the edition's byte identity; this index is only for history and
/// lets replacement downloads roll up under the same work.
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

/// Picks the companion file beside a book that best matches it.
///
/// Readalong documents and sync-map sidecars are matched the same way: files
/// in the book's own directory (depth one, natural order) are matched by
/// normalized stem against the folder name, the book title, and every audio
/// file's stem. A folder book falls back to its first candidate even without
/// a name match — a folder holds one book, so an unmatched name there is
/// still unambiguous.
fn find_companion_file(
    group_key: &FsPath,
    grouped_files: &[PathBuf],
    book_title: &str,
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

    let mut candidates = WalkDir::new(&search_dir)
        .max_depth(1)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| is_candidate(path))
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

/// Finds a readalong sync map for a book: a user-provided `.sync.json`
/// sidecar beside the audiobook wins, then a server-generated file in the
/// sync data directory.
pub(crate) fn find_sync_file(
    book_id: &str,
    group_key: &FsPath,
    grouped_files: &[PathBuf],
    book_title: &str,
    sync_dir: &FsPath,
) -> Option<DiscoveredSyncFile> {
    let url = format!("/api/books/{book_id}/sync");
    let sidecar = find_companion_file(
        group_key,
        grouped_files,
        book_title,
        |path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(has_sync_sidecar_suffix)
                .unwrap_or(false)
        },
        // `.sync.json` is a two-part suffix, so `file_stem` would leave
        // `.sync` behind; strip the full suffix by length instead. The slice
        // is safe because `has_sync_sidecar_suffix` already checked length
        // and the character boundary.
        |path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name[..name.len() - SYNC_SIDECAR_SUFFIX.len()].to_string())
        },
    );
    if let Some(selected) = sidecar {
        return Some(DiscoveredSyncFile {
            file: SyncFile {
                file_name: selected
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("sync.json")
                    .to_string(),
                source: "sidecar".to_string(),
                url,
            },
            path: selected,
        });
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
pub(crate) fn has_sync_sidecar_suffix(name: &str) -> bool {
    name.len() > SYNC_SIDECAR_SUFFIX.len()
        && name.is_char_boundary(name.len() - SYNC_SIDECAR_SUFFIX.len())
        && name[name.len() - SYNC_SIDECAR_SUFFIX.len()..].eq_ignore_ascii_case(SYNC_SIDECAR_SUFFIX)
}

pub(crate) struct DiscoveredReadingFile {
    pub(crate) file: ReadingFile,
    pub(crate) path: PathBuf,
}

/// Finds the readalong document for a book among the files beside it.
pub(crate) fn find_reading_file(
    book_id: &str,
    group_key: &FsPath,
    grouped_files: &[PathBuf],
    book_title: &str,
) -> Option<DiscoveredReadingFile> {
    let selected = find_companion_file(
        group_key,
        grouped_files,
        book_title,
        is_supported_reading_file,
        |path| {
            path.file_stem()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        },
    )?;

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
    let content_type = mime_guess::from_path(&selected)
        .first_or_octet_stream()
        .to_string();

    Some(DiscoveredReadingFile {
        path: selected,
        file: ReadingFile {
            id,
            file_name,
            extension,
            content_type,
            url: format!("/api/books/{book_id}/readalong"),
        },
    })
}

pub(crate) fn is_supported_reading_file(path: &FsPath) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            READING_EXTENSIONS
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(extension))
        })
        .unwrap_or(false)
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

/// A completed walk, and whether any part of it failed.
///
/// A traversal error used to be indistinguishable from an empty directory,
/// which meant an unreadable or half-mounted library looked exactly like a
/// library whose books had been deleted. Identity resolution must not run on
/// that, so the failure is carried out rather than dropped.
pub(crate) struct AudioWalk {
    pub(crate) files: Vec<PathBuf>,
    pub(crate) errors: Vec<String>,
}

pub(crate) fn walk_audio_files_checked(root: &FsPath) -> AudioWalk {
    let mut errors = Vec::new();
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
        .filter_map(|entry| match entry {
            Ok(entry) => Some(entry),
            Err(error) => {
                errors.push(error.to_string());
                None
            }
        })
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        // A conversion in flight writes a temporary remux beside the book. It
        // carries the book's extension, so it has to be excluded by name.
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

pub(crate) fn read_track_metadata(file_path: &FsPath) -> TrackMetadata {
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

/// Validates an id that was handed to us as an ASIN — a route parameter, a
/// Libation export field, a metadata sidecar, an `ASIN` tag. Audible ids come
/// in two shapes: the familiar `B`-prefixed ASIN, and an ISBN-10 for titles
/// listed under their print id (`125077795X` is *The Invisible Life of Addie
/// LaRue*). Accepting only the former rejects titles the account owns, and
/// accepting any ten alphanumerics lets junk through to the Libation CLI and
/// into saved metadata, so each shape is checked on its own terms.
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

/// Ten characters, the last of which may be the check character `X`, weighted
/// 10 down to 1 and summing to a multiple of 11.
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

/// Picks an ASIN out of text that merely *might* contain one, such as a file
/// name or a trailing `[B00F3F2J6K]` title suffix. Only the `B`-prefixed shape
/// counts here: a bare ten-digit run in a file name is far more likely to be a
/// date, a phone number, or a track id than an ISBN-10 the book is listed
/// under.
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
        .map(clean_metadata_text)
        .filter(|value| !value.is_empty())
}

pub(crate) fn collect_genres(tag: &Tag) -> Vec<String> {
    tag.get_strings(ItemKey::Genre)
        .flat_map(|value| value.split([';', ',']))
        .map(clean_metadata_text)
        .filter(|value| !value.is_empty())
        .collect()
}

pub(crate) fn collect_raw_fields(tag: &Tag) -> Vec<MetadataField> {
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

pub(crate) fn item_key_label(key: ItemKey) -> String {
    format!("{key:?}")
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

/// Converted audiobooks conventionally carry the narrator in the composer
/// field — that is what AAX rips and Libation write — so read it as one, but
/// only once another tag has named the author, since a file whose only credit
/// is a composer means it as the author.
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
            .map(clean_metadata_text)
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
            .map(clean_metadata_text)
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
                Some(clean_metadata_text(value)).filter(|value| !value.is_empty())
            }
            ItemValue::Binary(_) => None,
        }
    })
}

pub(crate) fn extract_cover_art(tag: &Tag) -> Option<EmbeddedImage> {
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

pub(crate) fn read_embedded_chapters(file_path: &FsPath) -> Vec<ParsedChapter> {
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

pub(crate) fn read_mp4_chapters(file_path: &FsPath) -> Vec<ParsedChapter> {
    let Ok(tag) = mp4ameta::Tag::read_from_path(file_path) else {
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

pub(crate) fn read_id3_chapters(file_path: &FsPath) -> Vec<ParsedChapter> {
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

/// Write freshly extracted cover art to the cache directory and return what
/// the serving route needs, without the bytes, plus the paths of stale files.
///
/// Files are named by book id and rewritten only when their content actually
/// changed: a length mismatch skips the rewrite outright, and matching art is
/// confirmed by reading the existing file back. A rewrite goes to a temporary
/// file that is renamed into place — the currently published library still
/// points readers at this path until the new snapshot lands, so an in-place
/// write would stream truncated bytes under the old length and etag.
///
/// Stale files — covers for books that have left the library — are reported
/// rather than removed, for the same reason: the caller deletes them only
/// after the new snapshot is published.
pub(crate) fn write_cover_cache(
    covers_dir: &FsPath,
    extracted: Vec<(String, EmbeddedImage)>,
) -> anyhow::Result<(HashMap<String, CachedCover>, Vec<PathBuf>)> {
    create_private_directory(covers_dir)?;
    let mut cached = HashMap::new();
    let mut keep = HashSet::new();

    for (book_id, image) in extracted {
        let file_name = format!("{}.cover", sanitize_filename(&book_id));
        let path = covers_dir.join(&file_name);
        keep.insert(file_name.clone());

        let unchanged = std::fs::metadata(&path)
            .ok()
            .is_some_and(|metadata| metadata.len() == image.data.len() as u64)
            && std::fs::read(&path)
                .ok()
                .is_some_and(|existing| bytes_etag(&existing) == image.etag);
        if !unchanged {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since_epoch| since_epoch.as_nanos())
                .unwrap_or(0);
            let temp_path = covers_dir.join(format!(".{file_name}.{nanos}.tmp"));
            std::fs::write(&temp_path, &image.data)?;
            replace_file_blocking(&temp_path, &path)
                .map_err(|error| anyhow::anyhow!("could not publish cover {file_name}: {error}"))?;
        }

        cached.insert(
            book_id,
            CachedCover {
                mime_type: image.mime_type,
                etag: image.etag,
                len: image.data.len() as u64,
                path,
            },
        );
    }

    // Covers for books that have left the library.
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

/// Delete cover files the published library no longer points at.
pub(crate) fn remove_stale_covers(stale: &[PathBuf]) {
    for path in stale {
        let _ = std::fs::remove_file(path);
    }
}
