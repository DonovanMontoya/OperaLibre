//! Streaming audiobook upload into a staged library folder, published by
//! rename only once the whole upload has been validated.

use crate::*;

pub(crate) const MAX_UPLOAD_FILES: usize = 1_000;

pub(crate) const UPLOAD_STAGING_PREFIX: &str = ".operalibre-upload-";

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

/// Receive the upload into the staging directory and move it into place under
/// its book name. The caller owns removing the staging directory on failure.
async fn stage_and_publish_upload(
    state: &AppState,
    staging_path: &FsPath,
    multipart: &mut Multipart,
) -> Result<(), ApiError> {
    let book_name =
        receive_audiobook_upload(staging_path, multipart, state.max_upload_bytes).await?;
    let destination = state.library_root.join(&book_name);
    if fs::try_exists(&destination).await? {
        return Err(ApiError::conflict(format!(
            "A library folder named '{book_name}' already exists. Choose another book name."
        )));
    }
    fs::rename(staging_path, &destination).await?;
    Ok(())
}

pub(crate) async fn receive_audiobook_upload(
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

pub(crate) fn multipart_error(error: axum::extract::multipart::MultipartError) -> ApiError {
    ApiError::bad_request(format!("The audiobook upload could not be read: {error}"))
}
