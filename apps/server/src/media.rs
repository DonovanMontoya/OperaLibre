//! Serving the audio: track streaming with range support, readalong
//! companions, cover art, and whole-book archive downloads.

use crate::*;

// ReaderStream otherwise reads in very small chunks. A larger media chunk
// keeps browser buffers supplied through brief scheduler or network jitter,
// which matters more as playback speed increases.
pub(crate) const MEDIA_STREAM_BUFFER_CAPACITY: usize = 256 * 1024;

pub(crate) const COVER_CACHE_CONTROL: &str = "private, max-age=86400";

/// Track streams and downloads carry the listener's media token in the URL,
/// so a shared cache must never hold one.
pub(crate) const MEDIA_CACHE_CONTROL: &str = "private";

pub(crate) async fn get_cover_art(
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

    // Streamed from the extracted file rather than copied out of a map that
    // held every cover in the library resident.
    let cover = cover.clone();
    drop(library);
    let file = fs::File::open(&cover.path)
        .await
        .map_err(|_| ApiError::not_found("Cover art not found"))?;

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, cover.mime_type)
        .header(CONTENT_LENGTH, cover.len.to_string())
        .header(ETAG, cover.etag)
        .header(CACHE_CONTROL, COVER_CACHE_CONTROL)
        .body(Body::from_stream(ReaderStream::new(file)))?)
}

pub(crate) fn if_none_match_matches(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get_all(IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(|candidate| candidate.trim())
        .any(|candidate| candidate == "*" || candidate.trim_start_matches("W/") == etag)
}

pub(crate) async fn get_reading_file(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require_book_access(&auth, &book_id)?;
    let file_path = {
        let library = state.library.read().await;
        let book = library.book(&book_id)?;
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
    serve_companion_document(&state, &file_path, headers).await
}

/// Any companion beside the book — the text, a picture supplement, or a
/// loose image — by the id the book response gave it.
pub(crate) async fn get_companion_file(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path((book_id, companion_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require_book_access(&auth, &book_id)?;
    let file_path = {
        let library = state.library.read().await;
        let book = library.book(&book_id)?;
        book.companions
            .iter()
            .find(|companion| companion.id == companion_id)
            .ok_or(ApiError::not_found("Companion file not found"))?;
        library
            .reading_paths
            .get(&companion_id)
            .cloned()
            .ok_or(ApiError::not_found("Companion path not found"))?
    };
    serve_companion_document(&state, &file_path, headers).await
}

async fn serve_companion_document(
    state: &AppState,
    file_path: &FsPath,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let isolate_html = file_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")
        });
    let mut response =
        serve_file_response(file_path, &[&state.library_root], headers, None).await?;
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

pub(crate) async fn stream_track(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path((book_id, track_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require_book_access(&auth, &book_id)?;
    let file_path = {
        let library = state.library.read().await;
        let book = library.book(&book_id)?;
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
pub(crate) fn media_content_type(file_path: &FsPath) -> String {
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

pub(crate) async fn serve_file_response(
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
    // A range this server cannot serve (another unit, several ranges, a
    // malformed spec) is ignored and the whole file goes out, as RFC 9110
    // allows; only a well-formed byte range outside the file earns a 416.
    let requested_range = match headers.get(RANGE) {
        None => None,
        Some(value) => match value
            .to_str()
            .map(|value| parse_byte_range(value, file_size))
        {
            Ok(ByteRange::Satisfiable(start, end)) => Some((start, end)),
            Ok(ByteRange::Unsatisfiable) => return range_not_satisfiable_response(file_size),
            Ok(ByteRange::Unsupported) | Err(_) => None,
        },
    };
    if file_size == 0 {
        let mut response = Response::builder()
            .status(StatusCode::OK)
            .header(ACCEPT_RANGES, "bytes")
            .header(CONTENT_TYPE, content_type)
            .header(CONTENT_LENGTH, "0")
            .header(CACHE_CONTROL, MEDIA_CACHE_CONTROL);
        if let Some(content_disposition) = content_disposition {
            response =
                response.header(axum::http::header::CONTENT_DISPOSITION, content_disposition);
        }
        return Ok(response.body(Body::empty())?);
    }

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
        .header(CONTENT_LENGTH, (end - start + 1).to_string())
        .header(CACHE_CONTROL, MEDIA_CACHE_CONTROL);

    if status == StatusCode::PARTIAL_CONTENT {
        response = response.header(CONTENT_RANGE, format!("bytes {start}-{end}/{file_size}"));
    }
    if let Some(content_disposition) = content_disposition {
        response = response.header(axum::http::header::CONTENT_DISPOSITION, content_disposition);
    }

    Ok(response.body(body)?)
}

pub(crate) fn open_contained_file(
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

pub(crate) fn range_not_satisfiable_response(file_size: u64) -> Result<Response, ApiError> {
    Ok(Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(CONTENT_RANGE, format!("bytes */{file_size}"))
        .header(CONTENT_LENGTH, "0")
        .body(Body::empty())?)
}

/// Whether the download volume can hold `source` bytes of archive while
/// keeping `reserve` bytes free.
pub(crate) fn download_volume_has_capacity(available: u64, source: u64, reserve: u64) -> bool {
    source
        .checked_add(reserve)
        .is_some_and(|required| available >= required)
}

pub(crate) async fn download_book(
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
        let book = library.book(&book_id)?;
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
    .map_err(|error| ApiError::internal(error.to_string()))??;
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

    // The archive stays under its `TempPath` guard until the response owns it,
    // so the file is removed on every path that does not end in a download:
    // an error while writing drops the guard inside the closure, and a caller
    // that goes away mid-build drops this `JoinHandle` without cancelling the
    // blocking task — tokio lets it run to completion and then drops its
    // output, guard included, because no handle is left to receive it.
    let (zip_path, download_permit) = tokio::task::spawn_blocking(
        move || -> anyhow::Result<(tempfile::TempPath, OwnedSemaphorePermit)> {
            let temp = tempfile::Builder::new()
                .prefix(DOWNLOAD_TEMP_PREFIX)
                .suffix(DOWNLOAD_TEMP_SUFFIX)
                .tempfile_in(download_temp_dir)?;
            let (file, path) = temp.into_parts();
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
        },
    )
    .await
    .map_err(|error| ApiError::internal(error.to_string()))??;

    let file = fs::File::open(&zip_path).await?;
    let metadata = file.metadata().await?;
    let file_size = metadata.len();

    let safe_filename = sanitize_filename(&book_title);
    let stream = ReaderStream::new(RemoveOnDropFile::guarded(file, zip_path, download_permit));
    let body = Body::from_stream(stream);

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/zip")
        .header(CONTENT_LENGTH, file_size.to_string())
        .header(CACHE_CONTROL, MEDIA_CACHE_CONTROL)
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            download_content_disposition(&safe_filename),
        )
        .body(body)?)
}

/// `attachment` with the plain ASCII name every client understands and the
/// RFC 8187 form that carries the title's real characters.
pub(crate) fn download_content_disposition(safe_filename: &str) -> String {
    let ascii_fallback: String = safe_filename
        .chars()
        .map(|character| {
            if character.is_ascii() && character != '"' {
                character
            } else {
                '_'
            }
        })
        .collect();
    format!(
        "attachment; filename=\"{ascii_fallback}.zip\"; filename*=UTF-8''{}.zip",
        rfc8187_encode(safe_filename)
    )
}

pub(crate) const DOWNLOAD_TEMP_PREFIX: &str = "operalibre-";

pub(crate) const DOWNLOAD_TEMP_SUFFIX: &str = ".zip";

/// Remove archives left in the download directory by an earlier process: a
/// crash or a hard stop mid-download loses the guard that would have deleted
/// them. Returns how many were removed.
pub(crate) fn sweep_download_temp_dir(download_temp_dir: &FsPath) -> io::Result<usize> {
    let mut removed = 0;
    for entry in std::fs::read_dir(download_temp_dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !(name.starts_with(DOWNLOAD_TEMP_PREFIX) && name.ends_with(DOWNLOAD_TEMP_SUFFIX))
            || !entry.file_type()?.is_file()
        {
            continue;
        }
        match std::fs::remove_file(entry.path()) {
            Ok(()) => removed += 1,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(
                    path = %entry.path().display(),
                    "failed to remove leftover download archive: {error}"
                );
            }
        }
    }
    Ok(removed)
}

pub(crate) struct RemoveOnDropFile {
    pub(crate) file: Option<fs::File>,
    /// Deletes the archive when dropped, after the handle below is closed.
    pub(crate) path: Option<tempfile::TempPath>,
    pub(crate) _download_permit: OwnedSemaphorePermit,
}

impl RemoveOnDropFile {
    #[cfg(test)]
    pub(crate) fn new(
        file: fs::File,
        path: PathBuf,
        download_permit: OwnedSemaphorePermit,
    ) -> Self {
        let path = tempfile::TempPath::try_from_path(path).expect("an absolute archive path");
        Self::guarded(file, path, download_permit)
    }

    /// Take over an archive that is still under its creation guard, so there
    /// is no moment between building and serving it when nothing owns it.
    pub(crate) fn guarded(
        file: fs::File,
        path: tempfile::TempPath,
        download_permit: OwnedSemaphorePermit,
    ) -> Self {
        Self {
            file: Some(file),
            path: Some(path),
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
        if let Some(path) = self.path.take()
            && let Err(error) = path.close()
            && error.kind() != io::ErrorKind::NotFound
        {
            tracing::warn!("failed to remove temporary download: {error}");
        }
    }
}

pub(crate) async fn delete_downloaded_book(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Path(book_id): Path<String>,
) -> Result<Json<Vec<Book>>, ApiError> {
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
    let removal = if metadata.is_dir() {
        fs::remove_dir_all(&canonical_book_path).await
    } else if metadata.is_file() {
        fs::remove_file(&canonical_book_path).await
    } else {
        return Err(ApiError::bad_request(
            "The downloaded book is not a regular file or folder.",
        ));
    };

    // Progress, metadata overrides, access grants, and Libation's catalog are
    // intentionally retained. If Libation downloads the same ASIN again, the
    // stable book id reconnects all of that state to the new local copy.
    //
    // The rescan runs even when the removal failed part-way: a folder that
    // lost some of its tracks must stop being advertised as whole.
    let rescan = rescan_library(&state).await;
    removal?;
    rescan?;
    Ok(Json(books_with_progress(&state, &auth).await?))
}
