//! Streaming audiobook upload into a staged library folder, published by
//! rename only once the whole upload has been validated.

use crate::*;

pub(crate) const MAX_UPLOAD_FILES: usize = 1_000;

pub(crate) const UPLOAD_STAGING_PREFIX: &str = ".operalibre-upload-";

/// Remove staging folders an earlier process left in the library: an upload
/// interrupted by a crash or a hard stop never reached its own cleanup. Runs
/// before the listener is up, so nothing can be mid-upload. Returns how many
/// were removed; a library root that does not exist yet has none.
pub(crate) fn sweep_upload_staging_dirs(library_root: &FsPath) -> io::Result<usize> {
    let entries = match std::fs::read_dir(library_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    let mut removed = 0;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with(UPLOAD_STAGING_PREFIX) || !entry.file_type()?.is_dir() {
            continue;
        }
        match std::fs::remove_dir_all(entry.path()) {
            Ok(()) => removed += 1,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(
                    path = %entry.path().display(),
                    "failed to remove leftover upload staging folder: {error}"
                );
            }
        }
    }
    Ok(removed)
}

pub(crate) async fn upload_audiobook(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    mut multipart: Multipart,
) -> Result<Json<Vec<Book>>, ApiError> {
    let _upload_guard = state.upload_lock.lock().await;
    fs::create_dir_all(&state.library_root).await?;

    let staging_name = format!("{UPLOAD_STAGING_PREFIX}{}", generate_session_token());
    let staging_path = state.library_root.join(staging_name);
    fs::create_dir(&staging_path).await?;

    if let Err(error) = stage_and_publish_upload(&state, &staging_path, &mut multipart).await {
        let _ = fs::remove_dir_all(&staging_path).await;
        return Err(error);
    }

    rescan_library(&state).await?;
    Ok(Json(books_with_progress(&state, &auth).await?))
}

pub(crate) const MAX_EPUB_UPLOAD_BYTES: u64 = 64 * 1024 * 1024;

/// Publish one explicitly paired EPUB without replacing existing files.
pub(crate) async fn upload_ebook(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Path(book_id): Path<String>,
    mut multipart: Multipart,
) -> Result<Json<Vec<Book>>, ApiError> {
    let _upload_guard = state.upload_lock.lock().await;
    {
        let library = state.library.read().await;
        let book = library.book(&book_id)?;
        if book
            .reading_file
            .as_ref()
            .is_some_and(|file| file.extension == "epub")
        {
            return Err(ApiError::conflict("This book already has a paired EPUB."));
        }
        if library.sync_paths.contains_key(&book_id) {
            return Err(ApiError::conflict(
                "This book has an existing sync map. Remove it before pairing a different reading copy.",
            ));
        }
    }
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
    let (destination_dir, forced_name) = if metadata.is_dir() {
        (canonical_book_path, None)
    } else if metadata.is_file() {
        let parent = canonical_book_path
            .parent()
            .ok_or_else(|| ApiError::bad_request("The audiobook has no folder for its EPUB."))?;
        let stem = canonical_book_path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .ok_or_else(|| ApiError::bad_request("The audiobook file has no usable name."))?;
        (parent.to_path_buf(), Some(format!("{stem}.epub")))
    } else {
        return Err(ApiError::bad_request(
            "The book is not a regular file or folder.",
        ));
    };

    // The guard removes partial bytes on errors and request cancellation.
    let staged = tempfile::Builder::new()
        .prefix(".operalibre-ebook-")
        .tempfile_in(&destination_dir)?
        .into_temp_path();
    let uploaded_name =
        receive_ebook_upload(&staged, &mut multipart, state.max_upload_bytes).await?;
    let name = forced_name.unwrap_or(uploaded_name);
    if name.len() > 255 {
        return Err(ApiError::bad_request(
            "The paired EPUB file name is too long.",
        ));
    }
    let destination = destination_dir.join(&name);
    let _rescan_guard = state.rescan_lock.lock().await;
    // Do not pair a root-level companion with a second title sharing its stem
    // or metadata title. The scanner's matching rules apply to every book.
    {
        let library = state.library.read().await;
        if metadata.is_file() {
            let stem = normalize_match_key(
                destination
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default(),
            );
            for other in &library.books {
                if other.id == book_id {
                    continue;
                }
                if let Some(path) = library.book_paths.get(&other.id)
                    && path.parent() == book_path.parent()
                    && (normalize_match_key(&other.title) == stem
                        || normalize_match_key(
                            path.file_stem()
                                .and_then(|s| s.to_str())
                                .unwrap_or_default(),
                        ) == stem)
                {
                    return Err(ApiError::conflict(
                        "This EPUB name would also match another audiobook. Put the audiobooks in separate folders before pairing.",
                    ));
                }
            }
        }
        let book = library.book(&book_id)?;
        if book
            .reading_file
            .as_ref()
            .is_some_and(|file| file.extension == "epub")
            || library.sync_paths.contains_key(&book_id)
        {
            return Err(ApiError::conflict(
                "This book's reading copy changed during the upload. Refresh and try again.",
            ));
        }
    }
    // persist_noclobber atomically refuses files (including dangling symlinks)
    // created by external importers while the transfer was in flight.
    staged.persist_noclobber(&destination).map_err(|error| {
        if error.error.kind() == io::ErrorKind::AlreadyExists {
            ApiError::conflict(
                "An EPUB with this name already exists. Existing files are never replaced.",
            )
        } else {
            ApiError::from(error.error)
        }
    })?;
    let published = tempfile::TempPath::try_from_path(&destination)?;
    state
        .metadata_overrides
        .mutate(|overrides| {
            overrides
                .books
                .entry(book_id.clone())
                .or_default()
                .ebook_file_name = Some(name.clone());
            Ok(())
        })
        .await?;
    // Once metadata is durable, retain the file even if refreshing fails.
    published
        .keep()
        .map_err(|error| ApiError::from(error.error))?;
    if rescan_library_locked(&state).await.is_err() {
        return Err(ApiError::service_unavailable(
            "The EPUB was saved, but the library could not refresh. Rescan the library to finish pairing.",
        ));
    }
    let library = state.library.read().await;
    if !library
        .book(&book_id)?
        .reading_file
        .as_ref()
        .is_some_and(|file| file.file_name == name)
    {
        return Err(ApiError::service_unavailable(
            "The EPUB was saved, but the library has not adopted it yet. Rescan the library to finish pairing.",
        ));
    }
    drop(library);
    Ok(Json(books_with_progress(&state, &auth).await?))
}

async fn receive_ebook_upload(
    staged: &FsPath,
    multipart: &mut Multipart,
    max_upload_bytes: Option<u64>,
) -> Result<String, ApiError> {
    let mut uploaded_name = None;
    while let Some(mut field) = multipart.next_field().await.map_err(multipart_error)? {
        if field.name() != Some("file") {
            return Err(ApiError::bad_request("Only one EPUB file is accepted."));
        }
        if uploaded_name.is_some() {
            return Err(ApiError::bad_request("Choose exactly one EPUB file."));
        }
        let original_name = field
            .file_name()
            .ok_or_else(|| ApiError::bad_request("The EPUB needs a file name."))?;
        let file_name = sanitize_filename(original_name);
        if file_name.len() > 255 || !file_name.to_ascii_lowercase().ends_with(".epub") {
            return Err(ApiError::bad_request("Choose an EPUB (.epub) file."));
        }
        let mut output = fs::File::create(staged).await?;
        let mut bytes = 0u64;
        while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
            bytes = bytes.saturating_add(chunk.len() as u64);
            let limit = max_upload_bytes
                .unwrap_or(MAX_EPUB_UPLOAD_BYTES)
                .min(MAX_EPUB_UPLOAD_BYTES);
            if bytes > limit {
                return Err(ApiError::payload_too_large(format!(
                    "EPUB uploads are limited to {}.",
                    human_bytes(limit)
                )));
            }
            output.write_all(&chunk).await?;
        }
        output.flush().await?;
        if bytes == 0 {
            return Err(ApiError::bad_request("The EPUB is empty."));
        }
        uploaded_name = Some(file_name);
    }
    let name =
        uploaded_name.ok_or_else(|| ApiError::bad_request("Choose one EPUB file to upload."))?;
    let path = staged.to_path_buf();
    tokio::task::spawn_blocking(move || validate_uploaded_epub(&path))
        .await
        .map_err(|error| ApiError::internal(format!("Could not validate the EPUB: {error}")))?
        .map_err(|error| ApiError::bad_request(format!("The EPUB could not be read: {error}")))?;
    Ok(name)
}

fn validate_uploaded_epub(path: &FsPath) -> anyhow::Result<()> {
    // Inspect the archive from disk before allocating its contents. Fully read
    // bounded entries to verify CRCs, encryption, and actual expanded sizes.
    let mut archive = zip::ZipArchive::new(std::fs::File::open(path)?)?;
    anyhow::ensure!(archive.len() <= 4096, "The EPUB contains too many files.");
    let mut remaining = 64 * 1024 * 1024u64;
    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let file = archive.by_index(index)?;
        anyhow::ensure!(
            names.insert(file.name().to_string()),
            "The EPUB contains duplicate file names."
        );
        let limit = remaining.min(8 * 1024 * 1024);
        anyhow::ensure!(
            file.size() <= limit,
            "The EPUB's expanded contents are too large."
        );
        let count = std::io::copy(&mut file.take(limit + 1), &mut std::io::sink())?;
        anyhow::ensure!(
            count <= limit,
            "The EPUB's expanded contents are too large."
        );
        remaining -= count;
    }
    let bytes = std::fs::read(path)?;
    let epub = alignment::parse_epub(&bytes)?;
    anyhow::ensure!(
        epub.sections
            .iter()
            .any(|section| !section.text.trim().is_empty()),
        "The EPUB has no readable text. Choose an unencrypted ebook with a readable spine."
    );
    Ok(())
}

/// Receive the upload into the staging directory and move it into place under
/// its book name. The caller owns removing the staging directory on failure.
async fn stage_and_publish_upload(
    state: &AppState,
    staging_path: &FsPath,
    multipart: &mut Multipart,
) -> Result<(), ApiError> {
    let book_name = receive_audiobook_upload(
        staging_path,
        multipart,
        state.max_upload_bytes,
        &state.library_root,
    )
    .await?;
    // Checked again now that the whole upload is in: the early check while
    // receiving only saves the client the transfer.
    let destination = state.library_root.join(&book_name);
    if fs::try_exists(&destination).await? {
        return Err(book_name_taken(&book_name));
    }
    fs::rename(staging_path, &destination).await?;
    Ok(())
}

fn book_name_taken(book_name: &str) -> ApiError {
    ApiError::conflict(format!(
        "A library folder named '{book_name}' already exists. Choose another book name."
    ))
}

/// Receive the multipart body into `staging_path`. When the book name arrives
/// before the files — the order the web app sends — a name already in use
/// under `library_root` is refused before the audio is transferred.
pub(crate) async fn receive_audiobook_upload(
    staging_path: &FsPath,
    multipart: &mut Multipart,
    max_upload_bytes: Option<u64>,
    library_root: &FsPath,
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
                if fs::try_exists(library_root.join(&safe_name)).await? {
                    return Err(book_name_taken(&safe_name));
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

pub(crate) fn multipart_error(error: axum::extract::multipart::MultipartError) -> ApiError {
    ApiError::bad_request(format!("The audiobook upload could not be read: {error}"))
}
