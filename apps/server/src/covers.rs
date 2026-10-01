//! Administrator-selected cover sidecars. Audio tags are never rewritten.

use crate::*;
use image::{ImageDecoder, ImageFormat, ImageReader, Limits};

pub(crate) const MAX_COVER_UPLOAD_BYTES: usize = 8 * 1024 * 1024;
const MAX_COVER_PIXELS: u64 = 16_000_000;
const MAX_COVER_DIMENSION: u32 = 8192;
const MAX_STORED_COVER_BYTES: u64 = 12 * 1024 * 1024;
const MAX_DECODED_COVER_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DECODER_WORKING_BYTES: u64 = 32 * 1024 * 1024;

pub(crate) async fn upload_cover(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Path(book_id): Path<String>,
    mut multipart: Multipart,
) -> Result<Json<Book>, ApiError> {
    // Keep decoding serialized even if a client disconnects while the blocking
    // worker is running. Otherwise cancelled uploads can bypass this bound.
    let upload_guard = state.upload_lock.clone().lock_owned().await;
    state.library.read().await.book(&book_id)?;
    let limit = state
        .max_upload_bytes
        .unwrap_or(MAX_COVER_UPLOAD_BYTES as u64)
        .min(MAX_COVER_UPLOAD_BYTES as u64) as usize;
    let mut bytes = Vec::new();
    let mut found = false;
    while let Some(mut field) = multipart.next_field().await.map_err(multipart_error)? {
        if found || field.name() != Some("file") || field.file_name().is_none() {
            return Err(ApiError::bad_request("Choose exactly one cover image."));
        }
        found = true;
        // Filename and declared MIME are deliberately not used for storage or
        // validation. Only the decoded bytes determine the accepted format.
        while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
            if bytes.len().saturating_add(chunk.len()) > limit {
                return Err(ApiError::payload_too_large(
                    "Cover images must be 8 MiB or smaller.",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
    }
    if !found || bytes.is_empty() {
        return Err(ApiError::bad_request("Choose a non-empty cover image."));
    }
    let (png, upload_guard) =
        tokio::task::spawn_blocking(move || normalize_cover(&bytes).map(|png| (png, upload_guard)))
            .await
            .map_err(|error| ApiError::internal(format!("Cover validation failed: {error}")))??;

    // Once publication starts it runs to completion, including cache adoption,
    // even if the client closes the dialog or the request times out.
    tokio::spawn(async move {
        let _upload_guard = upload_guard;
        let _scan_guard = state.rescan_lock.lock().await;
        let book_path = state
            .library
            .read()
            .await
            .book_paths
            .get(&book_id)
            .cloned()
            .ok_or(ApiError::not_found("Book not found"))?;
        let root = state.library_root.clone();
        let id = book_id.clone();
        let (file_name, cover, published) =
            tokio::task::spawn_blocking(move || publish_cover(&root, &book_path, &id, &png))
                .await
                .map_err(|error| ApiError::internal(format!("Cover storage failed: {error}")))??;
        let previous = state
            .metadata_overrides
            .mutate(|overrides| {
                let entry = overrides.books.entry(book_id.clone()).or_default();
                Ok(entry.cover_file_name.replace(file_name))
            })
            .await?;
        if let Some(published) = published {
            published
                .keep()
                .map_err(|error| ApiError::from(error.error))?;
        }
        let updated = {
            let mut library = state.library.write().await;
            library.cover_art.insert(book_id.clone(), cover.clone());
            let book = library
                .books
                .iter_mut()
                .find(|book| book.id == book_id)
                .ok_or(ApiError::not_found("Book not found"))?;
            set_book_cover(book, Some(&cover), true);
            book.clone()
        };
        remove_previous_cover(&book_id, previous.as_deref(), &cover.path);
        Ok(Json(book_with_progress(&state, &auth, updated).await?))
    })
    .await
    .map_err(|error| ApiError::internal(format!("Cover upload failed: {error}")))?
}

pub(crate) async fn remove_cover_override(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Path(book_id): Path<String>,
) -> Result<Json<Book>, ApiError> {
    tokio::spawn(async move {
        let _upload_guard = state.upload_lock.lock().await;
        let _scan_guard = state.rescan_lock.lock().await;
        state.library.read().await.book(&book_id)?;
        let previous = state
            .metadata_overrides
            .mutate(|overrides| {
                Ok(overrides
                    .books
                    .get_mut(&book_id)
                    .and_then(|entry| entry.cover_file_name.take()))
            })
            .await?;
        let (updated, old_path) = {
            let mut library = state.library.write().await;
            let old_path = library
                .cover_art
                .get(&book_id)
                .map(|cover| cover.path.clone());
            let original = library.embedded_cover_art.get(&book_id).cloned();
            if let Some(cover) = &original {
                library.cover_art.insert(book_id.clone(), cover.clone());
            } else {
                library.cover_art.remove(&book_id);
            }
            let book = library
                .books
                .iter_mut()
                .find(|book| book.id == book_id)
                .ok_or(ApiError::not_found("Book not found"))?;
            set_book_cover(book, original.as_ref(), false);
            (book.clone(), old_path)
        };
        if let (Some(name), Some(path)) = (previous, old_path)
            && valid_cover_name(&book_id, &name)
            && path.file_name().and_then(|name| name.to_str()) == Some(name.as_str())
        {
            let _ = fs::remove_file(path).await;
        }
        Ok(Json(book_with_progress(&state, &auth, updated).await?))
    })
    .await
    .map_err(|error| ApiError::internal(format!("Cover removal failed: {error}")))?
}

fn normalize_cover(bytes: &[u8]) -> Result<Vec<u8>, ApiError> {
    let invalid = || ApiError::bad_request("Choose a readable JPEG, PNG, or WebP image.");
    let format = image::guess_format(bytes).map_err(|_| invalid())?;
    if !matches!(
        format,
        ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP
    ) {
        return Err(invalid());
    }
    let mut reader = ImageReader::with_format(io::Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_COVER_DIMENSION);
    limits.max_image_height = Some(MAX_COVER_DIMENSION);
    // PNG allocates during construction and cannot lower that internal limit
    // afterwards. Reserve working space separately from the output pixels.
    limits.max_alloc = Some(MAX_DECODER_WORKING_BYTES);
    reader.limits(limits.clone());
    let mut decoder = reader.into_decoder().map_err(|_| invalid())?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_COVER_PIXELS {
        return Err(ApiError::bad_request(
            "Cover images must be at most 16 million pixels and 8192 pixels per side.",
        ));
    }
    // from_decoder does not reserve the output buffer like ImageReader::decode.
    // In particular, a 16-bit RGBA PNG costs twice as much as 8-bit RGBA.
    if decoder.total_bytes() > MAX_DECODED_COVER_BYTES {
        return Err(ApiError::bad_request(
            "The decoded cover image is too large.",
        ));
    }
    let mut budget = Limits::default();
    budget.max_alloc = Some(MAX_DECODED_COVER_BYTES + MAX_DECODER_WORKING_BYTES);
    budget
        .reserve(decoder.total_bytes())
        .map_err(|_| invalid())?;
    limits.max_alloc = Some(budget.max_alloc.unwrap_or(0).min(MAX_DECODER_WORKING_BYTES));
    decoder.set_limits(limits).map_err(|_| invalid())?;
    let orientation = decoder.orientation().map_err(|_| invalid())?;
    let decoded = image::DynamicImage::from_decoder(decoder).map_err(|_| invalid())?;
    // Re-encoding strips metadata, animation, and trailing/polyglot payloads;
    // only raster pixels reach the browser. Bound permanent disk/cache cost.
    let mut resized = if width > 1600 || height > 1600 {
        let thumbnail = decoded.thumbnail(1600, 1600);
        // Release the full-size pixels before rotation, conversion and encoding.
        drop(decoded);
        thumbnail
    } else {
        decoded
    };
    resized.apply_orientation(orientation);
    let resized = resized.to_rgba8();
    let mut output = io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(resized)
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|_| invalid())?;
    Ok(output.into_inner())
}

fn cover_prefix(book_id: &str) -> String {
    format!(
        ".operalibre-cover-{}-",
        hex_digest(Sha256::digest(book_id.as_bytes()))
    )
}

fn valid_cover_name(book_id: &str, name: &str) -> bool {
    name.strip_prefix(&cover_prefix(book_id))
        .and_then(|tail| tail.strip_suffix(".png"))
        .is_some_and(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        })
}

fn cover_directory(root: &FsPath, book_path: &FsPath) -> Result<PathBuf, ApiError> {
    let root = std::fs::canonicalize(root)?;
    let book = std::fs::canonicalize(book_path)?;
    if book == root || !book.starts_with(&root) {
        return Err(ApiError::forbidden(
            "The book path is outside the managed library.",
        ));
    }
    if book.is_dir() {
        Ok(book)
    } else if book.is_file() {
        Ok(book
            .parent()
            .ok_or_else(|| ApiError::bad_request("The book has no folder."))?
            .to_path_buf())
    } else {
        Err(ApiError::bad_request(
            "The book is not a regular file or folder.",
        ))
    }
}

fn publish_cover(
    root: &FsPath,
    book_path: &FsPath,
    book_id: &str,
    png: &[u8],
) -> Result<(String, CachedCover, Option<tempfile::TempPath>), ApiError> {
    let directory = cover_directory(root, book_path)?;
    let name = format!(
        "{}{}.png",
        cover_prefix(book_id),
        hex_digest(Sha256::digest(png))
    );
    let path = directory.join(&name);
    if std::fs::symlink_metadata(&path).is_ok() {
        // Identical uploads reuse their own immutable file. Never overwrite a
        // symlink or an unrelated file that happened to occupy this name.
        let cover = read_cover_override(root, book_path, book_id, &name).ok_or_else(|| {
            ApiError::conflict("The cover destination is occupied by an invalid file.")
        })?;
        return Ok((name, cover, None));
    }
    let mut staged = tempfile::Builder::new()
        .prefix(".operalibre-cover-upload-")
        .tempfile_in(&directory)?;
    std::io::Write::write_all(&mut staged, png)?;
    staged.as_file().sync_all()?;
    staged
        .persist_noclobber(&path)
        .map_err(|error| ApiError::from(error.error))?;
    let published = tempfile::TempPath::try_from_path(&path)?;
    #[cfg(unix)]
    std::fs::File::open(&directory)?.sync_all()?;
    Ok((
        name,
        CachedCover {
            mime_type: "image/png".into(),
            etag: bytes_etag(png),
            path,
            len: png.len() as u64,
        },
        Some(published),
    ))
}

pub(crate) fn read_cover_override(
    root: &FsPath,
    book_path: &FsPath,
    book_id: &str,
    name: &str,
) -> Option<CachedCover> {
    if !valid_cover_name(book_id, name) {
        return None;
    }
    let path = cover_directory(root, book_path).ok()?.join(name);
    let metadata = std::fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_STORED_COVER_BYTES {
        return None;
    }
    let file = std::fs::File::open(&path).ok()?;
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut file.take(MAX_STORED_COVER_BYTES + 1), &mut bytes).ok()?;
    if bytes.len() as u64 > MAX_STORED_COVER_BYTES
        || image::guess_format(&bytes).ok()? != ImageFormat::Png
        || name
            != format!(
                "{}{}.png",
                cover_prefix(book_id),
                hex_digest(Sha256::digest(&bytes))
            )
    {
        return None;
    }
    Some(CachedCover {
        mime_type: "image/png".into(),
        etag: bytes_etag(&bytes),
        path,
        len: bytes.len() as u64,
    })
}

fn remove_previous_cover(book_id: &str, previous: Option<&str>, current: &FsPath) {
    if let Some(name) = previous
        && valid_cover_name(book_id, name)
        && current.file_name().and_then(|name| name.to_str()) != Some(name)
        && let Some(parent) = current.parent()
    {
        let _ = std::fs::remove_file(parent.join(name));
    }
}

pub(crate) fn set_book_cover(book: &mut Book, cover: Option<&CachedCover>, overridden: bool) {
    book.cover_art_url = cover.map(|cover| {
        format!(
            "/api/books/{}/cover?v={}",
            book.id,
            cover.etag.trim_matches('"')
        )
    });
    book.has_cover_override = overridden;
    book.cover_art_content_type = cover.map(|cover| cover.mime_type.clone());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encoded(format: ImageFormat, width: u32, height: u32) -> Vec<u8> {
        let mut bytes = io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            width,
            height,
            image::Rgb([1, 2, 3]),
        ))
        .write_to(&mut bytes, format)
        .unwrap();
        bytes.into_inner()
    }

    #[test]
    fn supported_rasters_are_reencoded_and_active_trailing_bytes_are_discarded() {
        for format in [ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::WebP] {
            let mut bytes = encoded(format, 17, 23);
            bytes.extend_from_slice(b"<html><script>alert('polyglot')</script></html>");
            let safe = normalize_cover(&bytes).unwrap();
            assert_eq!(image::guess_format(&safe).unwrap(), ImageFormat::Png);
            assert!(!safe.windows(7).any(|bytes| bytes == b"<script"));
            let decoded = image::load_from_memory(&safe).unwrap();
            assert_eq!((decoded.width(), decoded.height()), (17, 23));
        }
    }

    #[test]
    fn invalid_truncated_and_decompression_bomb_images_are_rejected() {
        for bytes in [
            b"<svg xmlns='http://www.w3.org/2000/svg'/>".to_vec(),
            b"<html/>".to_vec(),
            vec![],
            encoded(ImageFormat::Png, 30, 30)[..25].to_vec(),
        ] {
            assert!(normalize_cover(&bytes).is_err());
        }
        // Tiny compressed files must not bypass decoded-size limits.
        assert!(normalize_cover(&encoded(ImageFormat::Png, 4001, 4000)).is_err());
        assert!(normalize_cover(&encoded(ImageFormat::Png, 8193, 1)).is_err());
        let resized = normalize_cover(&encoded(ImageFormat::Png, 2000, 1000)).unwrap();
        let resized = image::load_from_memory(&resized).unwrap();
        assert_eq!((resized.width(), resized.height()), (1600, 800));
    }

    #[test]
    fn sixteen_bit_rgba_cannot_bypass_the_decoded_buffer_budget() {
        let image = image::DynamicImage::ImageRgba16(image::ImageBuffer::from_pixel(
            4000,
            4000,
            image::Rgba([0u16, 0, 0, 65535]),
        ));
        let mut encoded = io::Cursor::new(Vec::new());
        image.write_to(&mut encoded, ImageFormat::Png).unwrap();
        drop(image);
        assert!(encoded.get_ref().len() < MAX_COVER_UPLOAD_BYTES);
        let error = normalize_cover(encoded.get_ref()).unwrap_err();
        assert!(error.message.contains("decoded cover image is too large"));
    }

    #[test]
    fn jpeg_orientation_is_applied_before_metadata_is_stripped() {
        let jpeg = encoded(ImageFormat::Jpeg, 17, 23);
        for orientation in [6u8, 8] {
            // A little-endian TIFF IFD containing only the EXIF Orientation tag.
            let mut exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0".to_vec();
            exif.extend_from_slice(&[orientation, 0, 0, 0, 0, 0, 0, 0]);
            let mut oriented = jpeg[..2].to_vec();
            oriented.extend_from_slice(&[0xff, 0xe1]);
            oriented.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
            oriented.extend_from_slice(&exif);
            oriented.extend_from_slice(&jpeg[2..]);
            let safe = normalize_cover(&oriented).unwrap();
            let result = image::load_from_memory(&safe).unwrap();
            assert_eq!((result.width(), result.height()), (23, 17));
            assert!(!safe.windows(4).any(|bytes| bytes == b"Exif"));
        }
    }

    #[test]
    fn sidecar_publication_is_atomic_and_rolls_back_before_metadata_commit() {
        let root = tempfile::tempdir().unwrap();
        let book = root.path().join("book");
        std::fs::create_dir(&book).unwrap();
        let png = normalize_cover(&encoded(ImageFormat::Png, 12, 13)).unwrap();
        let (name, cover, staged) = publish_cover(root.path(), &book, "book", &png).unwrap();
        assert!(read_cover_override(root.path(), &book, "book", &name).is_some());
        drop(staged);
        assert!(!cover.path.exists());
        assert!(std::fs::read_dir(book).unwrap().next().is_none());
        let outside = tempfile::tempdir().unwrap();
        assert_eq!(
            publish_cover(root.path(), outside.path(), "book", &png)
                .unwrap_err()
                .status,
            StatusCode::FORBIDDEN
        );
    }

    #[cfg(unix)]
    #[test]
    fn sidecar_publication_never_follows_destination_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let book = root.path().join("book");
        std::fs::create_dir(&book).unwrap();
        let png = normalize_cover(&encoded(ImageFormat::Png, 12, 13)).unwrap();
        let name = format!(
            "{}{}.png",
            cover_prefix("book"),
            hex_digest(Sha256::digest(&png))
        );
        let outside = root.path().join("outside.png");
        std::fs::write(&outside, &png).unwrap();
        std::os::unix::fs::symlink(&outside, book.join(&name)).unwrap();
        assert!(read_cover_override(root.path(), &book, "book", &name).is_none());
        assert_eq!(
            publish_cover(root.path(), &book, "book", &png)
                .unwrap_err()
                .status,
            StatusCode::CONFLICT
        );
        assert_eq!(std::fs::read(outside).unwrap(), png);
    }

    #[test]
    fn sidecar_names_cannot_traverse_or_cross_books() {
        let good = format!("{}{}.png", cover_prefix("book"), "a".repeat(64));
        assert!(valid_cover_name("book", &good));
        assert!(!valid_cover_name("other", &good));
        for name in [
            "../../outside.png",
            "/tmp/cover.png",
            "cover.svg",
            ".operalibre-cover-../bad.png",
        ] {
            assert!(!valid_cover_name("book", name));
        }
    }
}
