//! Extracted from main.rs.

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
    pub(crate) cover_art: HashMap<String, EmbeddedImage>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryIdentityStore {
    #[serde(default)]
    pub(crate) books: Vec<BookIdentity>,
    /// Track fingerprints keyed by library-relative path, so a rescan only
    /// re-reads files whose size or modification time actually changed.
    #[serde(default)]
    pub(crate) fingerprint_cache: BTreeMap<String, CachedFingerprint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CachedFingerprint {
    pub(crate) fingerprint: String,
    pub(crate) size: u64,
    pub(crate) modified_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BookIdentity {
    pub(crate) fingerprint: String,
    pub(crate) book_id: String,
    #[serde(default)]
    pub(crate) paths: Vec<String>,
    #[serde(default)]
    pub(crate) tracks: Vec<TrackIdentity>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrackIdentity {
    pub(crate) fingerprint: String,
    pub(crate) track_id: String,
    #[serde(default)]
    pub(crate) paths: Vec<String>,
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

pub(crate) async fn list_books(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<Vec<Book>>, ApiError> {
    Ok(Json(books_with_progress(&state, &auth).await?))
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

pub(crate) async fn update_book_metadata(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Path(book_id): Path<String>,
    Json(payload): Json<BookMetadataUpdate>,
) -> Result<Json<Book>, ApiError> {
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
        Ok(contents) => Ok(serde_json::from_str(&contents)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(LibraryIdentityStore::default())
        }
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn library_identity_path(root: &FsPath, path: &FsPath) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

pub(crate) fn remember_identity_path(paths: &mut Vec<String>, path: &str) {
    const MAX_IDENTITY_PATH_ALIASES: usize = 32;
    if paths.iter().any(|candidate| candidate == path) {
        return;
    }
    paths.push(path.to_string());
    if paths.len() > MAX_IDENTITY_PATH_ALIASES {
        paths.remove(0);
    }
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

pub(crate) struct LibraryIdentityCandidate<'a> {
    pub(crate) book_fingerprint: &'a str,
    pub(crate) group_alias: &'a str,
    pub(crate) group_key: &'a FsPath,
    pub(crate) library_root: &'a FsPath,
    pub(crate) grouped_files: &'a [PathBuf],
    pub(crate) track_fingerprints: &'a [String],
}

pub(crate) fn resolve_library_identity(
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

pub(crate) async fn rescan_library(state: &AppState) -> anyhow::Result<()> {
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

pub(crate) struct DiscoveredSyncFile {
    pub(crate) file: SyncFile,
    pub(crate) path: PathBuf,
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
pub(crate) fn has_sync_sidecar_suffix(name: &str) -> bool {
    name.len() > SYNC_SIDECAR_SUFFIX.len()
        && name.is_char_boundary(name.len() - SYNC_SIDECAR_SUFFIX.len())
        && name[name.len() - SYNC_SIDECAR_SUFFIX.len()..].eq_ignore_ascii_case(SYNC_SIDECAR_SUFFIX)
}

pub(crate) struct DiscoveredReadingFile {
    pub(crate) file: ReadingFile,
    pub(crate) path: PathBuf,
}

pub(crate) fn find_reading_file(
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

pub(crate) fn walk_audio_files(root: &FsPath) -> Vec<PathBuf> {
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
