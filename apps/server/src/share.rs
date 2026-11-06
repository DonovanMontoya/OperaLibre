//! Bounded, transport-neutral contracts for one-time book sharing.

#![allow(dead_code)]

use crate::*;

pub(crate) const SHARE_TOKEN_BYTES: usize = 32;
pub(crate) const SHARE_MAX_ASSETS: usize = 256;
pub(crate) const SHARE_MAX_MESSAGE_CHARS: usize = 1_000;
pub(crate) const SHARE_MAX_PLANNED_ASSETS: usize = 256;

/// Canonical, non-secret metadata for a shared book. This is generated from
/// the scanned server record; request payloads are never used as its source.
pub(crate) fn canonical_share_metadata(book: &Book) -> anyhow::Result<Vec<u8>> {
    serde_json::to_vec(&serde_json::json!({
        "title": book.title,
        "author": book.author,
        "narrator": book.narrator,
        "description": book.description,
        "genres": book.genres,
        "tags": book.tags,
        "publishedDate": book.published_date,
        "asin": book.asin,
    }))
    .map_err(Into::into)
}
pub(crate) const SHARE_INVITATIONS_DOCUMENT: &str = "share-invitations";
pub(crate) const SHARE_DEFAULT_TTL_SECONDS: i64 = 7 * 24 * 60 * 60;

/// Serializes invitation-store updates and sender registration in this process.
/// No sender survives a server restart. The key includes the server identity so
/// independent test servers and installations do not cancel one another.
struct ActiveSender {
    cancel: tokio::sync::watch::Sender<bool>,
    broker: crate::share_broker::BrokerClient,
    owner_secret: String,
    room: String,
    expires_at: u64,
    reservation_id: String,
}
static INVITATION_GATE: LazyLock<Mutex<HashMap<String, Vec<ActiveSender>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn invitation_key(state: &AppState, digest: &str) -> String {
    format!("{}:{digest}", state.server_id)
}

#[cfg(test)]
pub(crate) async fn forget_invitation_runtime_for_test(state: &AppState, token: &str) {
    if let Some(senders) = INVITATION_GATE
        .lock()
        .await
        .remove(&invitation_key(state, &share_digest_string(token)))
    {
        for sender in senders {
            let _ = sender.cancel.send(true);
        }
    }
}

#[cfg(unix)]
fn open_share_file(path: &FsPath, root: &FsPath) -> anyhow::Result<std::fs::File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    let relative = path
        .strip_prefix(root)
        .map_err(|_| anyhow::anyhow!("asset is outside root"))?;
    let components = relative
        .components()
        .map(|component| match component {
            std::path::Component::Normal(name) => {
                CString::new(name.as_encoded_bytes()).map_err(Into::into)
            }
            _ => anyhow::bail!("invalid asset path component"),
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    anyhow::ensure!(!components.is_empty(), "asset path is empty");
    let root_name = CString::new(root.as_os_str().as_encoded_bytes())?;
    let root_fd = unsafe {
        libc::open(
            root_name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if root_fd < 0 {
        anyhow::bail!("cannot open share root")
    }
    let mut dirfd = unsafe { OwnedFd::from_raw_fd(root_fd) };
    for component in &components[..components.len() - 1] {
        let next = unsafe {
            libc::openat(
                dirfd.as_raw_fd(),
                component.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if next < 0 {
            anyhow::bail!("asset ancestor is unavailable or symlinked")
        }
        dirfd = unsafe { OwnedFd::from_raw_fd(next) };
    }
    let fd = unsafe {
        libc::openat(
            dirfd.as_raw_fd(),
            components.last().unwrap().as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        anyhow::bail!("asset is unavailable or symlinked")
    }
    let file = unsafe { std::fs::File::from_raw_fd(fd) };
    anyhow::ensure!(
        file.metadata()?.is_file(),
        "share asset is not a regular file"
    );
    Ok(file)
}

#[cfg(not(unix))]
fn open_share_file(_path: &FsPath, _root: &FsPath) -> anyhow::Result<std::fs::File> {
    anyhow::bail!("selected-asset sharing is unavailable on this platform")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ShareAssetKind {
    Audio,
    Ebook,
    Metadata,
    Cover,
    Alignment,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShareAsset {
    pub(crate) id: String,
    pub(crate) kind: ShareAssetKind,
    pub(crate) file_name: String,
    pub(crate) size_bytes: u64,
    pub(crate) sha256: String,
}

/// A file resolved by the server scanner. Callers must construct this from
/// `LibraryState` path maps; clients never provide paths to the planner.
#[derive(Debug, Clone)]
pub(crate) struct TrustedShareFile {
    pub(crate) id: String,
    pub(crate) kind: ShareAssetKind,
    pub(crate) file_name: String,
    pub(crate) path: PathBuf,
    pub(crate) size_bytes: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct PlannedShareFile {
    pub(crate) id: String,
    pub(crate) kind: ShareAssetKind,
    pub(crate) archive_name: String,
    pub(crate) path: PathBuf,
    pub(crate) size_bytes: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct GeneratedArchiveEntry {
    pub(crate) archive_name: String,
    pub(crate) contents: Vec<u8>,
}

/// A typed generated entry is deliberately separate from a file-backed asset.
/// It can only be created by server code such as `canonical_share_metadata`.
pub(crate) fn write_generated_entries(
    output: &FsPath,
    entries: &[GeneratedArchiveEntry],
) -> anyhow::Result<()> {
    let file = std::fs::File::create(output)?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .large_file(true);
    let mut names = HashSet::new();
    for entry in entries {
        if entry.archive_name.is_empty()
            || entry.archive_name.contains(['/', '\\'])
            || !names.insert(entry.archive_name.clone())
        {
            anyhow::bail!("invalid or duplicate generated archive entry")
        }
        writer.start_file(&entry.archive_name, options)?;
        writer.write_all(&entry.contents)?;
    }
    writer.finish()?;
    Ok(())
}

/// Resolve only trusted candidates and reject traversal, symlinks escaping an
/// allowed root, duplicates, and oversized selections.
pub(crate) fn plan_selected_assets(
    candidates: &[TrustedShareFile],
    selected_ids: &[String],
    allowed_roots: &[&FsPath],
    max_bytes: u64,
) -> anyhow::Result<Vec<PlannedShareFile>> {
    if selected_ids.is_empty() || selected_ids.len() > SHARE_MAX_PLANNED_ASSETS {
        anyhow::bail!("invalid selected asset count")
    }
    let mut planned = Vec::with_capacity(selected_ids.len());
    let mut seen = HashSet::new();
    let mut total = 0_u64;
    for id in selected_ids {
        if !seen.insert(id) {
            anyhow::bail!("an asset was selected more than once")
        }
        let candidate = candidates
            .iter()
            .find(|candidate| candidate.id == *id)
            .ok_or_else(|| anyhow::anyhow!("selected asset is not available"))?;
        let canonical = candidate.path.canonicalize()?;
        let contained = allowed_roots.iter().any(|root| {
            root.canonicalize()
                .ok()
                .is_some_and(|root| canonical.starts_with(root))
        });
        if !contained || !canonical.is_file() {
            anyhow::bail!("selected asset is outside the library roots")
        }
        let actual_size = std::fs::metadata(&canonical)?.len();
        if actual_size != candidate.size_bytes {
            anyhow::bail!("selected asset changed during sharing")
        }
        total = total
            .checked_add(actual_size)
            .ok_or_else(|| anyhow::anyhow!("share size overflow"))?;
        if total > max_bytes {
            anyhow::bail!("selected assets exceed the configured size limit")
        }
        planned.push(PlannedShareFile {
            id: candidate.id.clone(),
            kind: candidate.kind,
            archive_name: candidate.file_name.clone(),
            path: canonical,
            size_bytes: actual_size,
        });
    }
    Ok(planned)
}

/// Write exactly the planned files. There is deliberately no API here that
/// accepts a book id and discovers extra files implicitly.
pub(crate) fn write_selected_archive(
    output: &FsPath,
    planned: &[PlannedShareFile],
    allowed_roots: &[&FsPath],
) -> anyhow::Result<()> {
    let file = std::fs::File::create(output)?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .large_file(true);
    let mut names = HashSet::new();
    for item in planned {
        let current = item.path.canonicalize()?;
        if !current.is_file()
            || !allowed_roots.iter().any(|root| {
                root.canonicalize()
                    .ok()
                    .is_some_and(|root| current.starts_with(root))
            })
        {
            anyhow::bail!("planned asset moved outside the allowed roots")
        }
        if !names.insert(item.archive_name.clone()) {
            anyhow::bail!("duplicate archive entry")
        }
        writer.start_file(&item.archive_name, options)?;
        let mut source = open_share_file(
            &item.path,
            allowed_roots
                .first()
                .ok_or_else(|| anyhow::anyhow!("no allowed root"))?,
        )?;
        std::io::copy(&mut source, &mut writer)?;
    }
    writer.finish()?;
    Ok(())
}

pub(crate) fn write_mixed_archive(
    output: &FsPath,
    files: &[PlannedShareFile],
    generated: &[GeneratedArchiveEntry],
    allowed_roots: &[&FsPath],
) -> anyhow::Result<()> {
    let file = std::fs::File::create(output)?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .large_file(true);
    let mut names = HashSet::new();
    for item in files {
        let current = item.path.canonicalize()?;
        if !current.is_file()
            || !allowed_roots.iter().any(|root| {
                root.canonicalize()
                    .ok()
                    .is_some_and(|root| current.starts_with(root))
            })
        {
            anyhow::bail!("planned asset moved outside the allowed roots")
        }
        if !names.insert(item.archive_name.clone()) {
            anyhow::bail!("duplicate archive entry")
        }
        writer.start_file(&item.archive_name, options)?;
        let mut source = open_share_file(
            &item.path,
            allowed_roots
                .first()
                .ok_or_else(|| anyhow::anyhow!("no allowed root"))?,
        )?;
        std::io::copy(&mut source, &mut writer)?;
    }
    for entry in generated {
        if entry.archive_name.is_empty()
            || entry.archive_name.contains(['/', '\\'])
            || !names.insert(entry.archive_name.clone())
        {
            anyhow::bail!("invalid or duplicate generated archive entry")
        }
        writer.start_file(&entry.archive_name, options)?;
        writer.write_all(&entry.contents)?;
    }
    writer.finish()?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerifiedArchiveAsset {
    pub(crate) name: String,
    pub(crate) kind: ShareAssetKind,
    pub(crate) size: u64,
    pub(crate) sha256: String,
}

#[derive(Debug, Clone)]
pub(crate) struct VerifiedArchive {
    pub(crate) assets: Vec<VerifiedArchiveAsset>,
    pub(crate) size: u64,
    pub(crate) sha256: String,
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn safe_archive_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.len() <= 255
        && !name
            .chars()
            .any(|c| c == '/' || c == '\\' || c.is_control())
}

/// Hash the exact bytes while writing the selected archive, then hash the
/// resulting ZIP. Nothing from a client-supplied digest is used here.
pub(crate) fn write_verified_archive(
    output: &FsPath,
    files: &[PlannedShareFile],
    generated: &[GeneratedArchiveEntry],
    root: &FsPath,
    max_bytes: u64,
) -> anyhow::Result<VerifiedArchive> {
    use std::io::{Seek, SeekFrom};
    anyhow::ensure!(
        !files.is_empty() && files.len() + generated.len() <= SHARE_MAX_ASSETS,
        "invalid asset count"
    );
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .truncate(true)
        .open(output)?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .large_file(true);
    let mut assets = Vec::new();
    let mut names = HashSet::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    for item in files {
        anyhow::ensure!(
            safe_archive_name(&item.archive_name) && names.insert(item.archive_name.to_lowercase()),
            "invalid or duplicate archive name"
        );
        let mut source = open_share_file(&item.path, root)?;
        anyhow::ensure!(
            source.metadata()?.len() == item.size_bytes,
            "selected asset size changed"
        );
        writer.start_file(&item.archive_name, options)?;
        let mut hash = Sha256::new();
        let mut written = 0_u64;
        loop {
            let read = source.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            written = written
                .checked_add(read as u64)
                .ok_or_else(|| anyhow::anyhow!("asset size overflow"))?;
            anyhow::ensure!(
                written <= item.size_bytes && (read as u64) <= max_bytes.saturating_sub(total),
                "selected assets exceed size limit"
            );
            total += read as u64;
            hash.update(&buffer[..read]);
            writer.write_all(&buffer[..read])?;
        }
        anyhow::ensure!(
            written == item.size_bytes,
            "selected asset changed during archive creation"
        );
        assets.push(VerifiedArchiveAsset {
            name: item.archive_name.clone(),
            kind: item.kind,
            size: written,
            sha256: hex_digest(hash.finalize()),
        });
    }
    for entry in generated {
        anyhow::ensure!(
            entry.archive_name == "metadata.json"
                && names.insert(entry.archive_name.to_lowercase()),
            "invalid generated archive name"
        );
        let size = entry.contents.len() as u64;
        anyhow::ensure!(
            size <= max_bytes.saturating_sub(total),
            "selected assets exceed size limit"
        );
        total += size;
        writer.start_file(&entry.archive_name, options)?;
        writer.write_all(&entry.contents)?;
        assets.push(VerifiedArchiveAsset {
            name: entry.archive_name.clone(),
            kind: ShareAssetKind::Metadata,
            size,
            sha256: hex_digest(Sha256::digest(&entry.contents)),
        });
    }
    let mut archive = writer.finish()?;
    let size = archive.seek(SeekFrom::End(0))?;
    anyhow::ensure!(size <= max_bytes, "archive exceeds size limit");
    archive.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new();
    loop {
        let read = archive.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(VerifiedArchive {
        assets,
        size,
        sha256: hex_digest(hash.finalize()),
    })
}

fn share_archive_limit(
    state: &AppState,
    planned: &[PlannedShareFile],
    generated: &[GeneratedArchiveEntry],
) -> Result<u64, ApiError> {
    let limit = state
        .max_book_download_bytes
        .unwrap_or(DEFAULT_MAX_BOOK_DOWNLOAD_GIB * GIBIBYTE_BYTES)
        .min(DEFAULT_MAX_BOOK_DOWNLOAD_GIB * GIBIBYTE_BYTES);
    let estimated = planned
        .iter()
        .try_fold(0_u64, |sum, asset| sum.checked_add(asset.size_bytes))
        .and_then(|sum| {
            generated.iter().try_fold(sum, |total, entry| {
                total.checked_add(entry.contents.len() as u64)
            })
        })
        .and_then(|sum| sum.checked_add(1024 * 1024))
        .ok_or_else(|| ApiError::payload_too_large("Share archive is too large."))?;
    if estimated > limit {
        return Err(ApiError::payload_too_large(
            "Share archive exceeds the configured limit.",
        ));
    }
    let available = fs2::available_space(&state.download_temp_dir)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    if !download_volume_has_capacity(available, estimated, state.min_download_free_bytes) {
        return Err(ApiError {
            status: StatusCode::INSUFFICIENT_STORAGE,
            message: "Not enough space to prepare this share.".into(),
        });
    }
    Ok(limit)
}

fn trusted_candidates_for_book(
    state: &LibraryState,
    book_id: &str,
) -> Result<Vec<TrustedShareFile>, ApiError> {
    let book = state.book(book_id)?;
    let mut candidates = Vec::new();
    for track in &book.tracks {
        if let Some(path) = state.track_paths.get(&track.id) {
            let size = std::fs::metadata(path)
                .map_err(|_| ApiError::not_found("Book asset is unavailable."))?
                .len();
            candidates.push(TrustedShareFile {
                id: track.id.clone(),
                kind: ShareAssetKind::Audio,
                file_name: track.file_name.clone(),
                path: path.clone(),
                size_bytes: size,
            });
        }
    }
    if let Some(reading) = &book.reading_file
        && let Some(path) = state.reading_paths.get(&reading.id)
    {
        let size = std::fs::metadata(path)
            .map_err(|_| ApiError::not_found("Book asset is unavailable."))?
            .len();
        candidates.push(TrustedShareFile {
            id: reading.id.clone(),
            kind: ShareAssetKind::Ebook,
            file_name: reading.file_name.clone(),
            path: path.clone(),
            size_bytes: size,
        });
    }
    if book.sync_file.is_some()
        && let Some(path) = state.sync_paths.get(book_id)
    {
        let size = std::fs::metadata(path)
            .map_err(|_| ApiError::not_found("Book asset is unavailable."))?
            .len();
        candidates.push(TrustedShareFile {
            id: format!("sync:{book_id}"),
            kind: ShareAssetKind::Alignment,
            file_name: "alignment.sync.json".into(),
            path: path.clone(),
            size_bytes: size,
        });
    }
    if let Some(cover) = state.cover_art.get(book_id) {
        candidates.push(TrustedShareFile {
            id: format!("cover:{book_id}"),
            kind: ShareAssetKind::Cover,
            file_name: format!(
                "cover.{}",
                cover.mime_type.rsplit('/').next().unwrap_or("bin")
            ),
            path: cover.path.clone(),
            size_bytes: cover.len,
        });
    }
    Ok(candidates)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShareManifest {
    pub(crate) version: u8,
    pub(crate) book_id: String,
    pub(crate) title: String,
    pub(crate) author: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) sender_display_name: String,
    /// Plain text only; never place this in link metadata or HTML previews.
    pub(crate) personal_message: Option<String>,
    pub(crate) assets: Vec<ShareAsset>,
    pub(crate) total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShareInvitation {
    pub(crate) token_digest: String,
    pub(crate) manifest: ShareManifest,
    pub(crate) sender_user_id: String,
    pub(crate) created_at: i64,
    pub(crate) expires_at: i64,
    pub(crate) revoked: bool,
    #[serde(default)]
    pub(crate) selected_asset_ids: Vec<String>,
    #[serde(default)]
    pub(crate) include_metadata: bool,
    #[serde(default)]
    broker_rooms: Vec<PendingBrokerRoom>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingBrokerRoom {
    origin: String,
    room: String,
    expires_at: u64,
    #[serde(default)]
    reservation_version: u8,
    #[serde(default)]
    cleanup_pending: bool,
    #[serde(default, skip_serializing_if = "is_zero")]
    last_cleanup_attempt: u64,
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}

fn reservation_id(owner_secret: &str, token_digest: &str, room: &str) -> String {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, owner_secret.as_bytes());
    let mut mac = ring::hmac::Context::with_key(&key);
    mac.update(b"operalibre-reservation-v1\0");
    mac.update(token_digest.as_bytes());
    mac.update(b"\0");
    mac.update(room.as_bytes());
    URL_SAFE_NO_PAD.encode(mac.sign().as_ref())
}

async fn cleanup_reserved_room(
    broker: &crate::share_broker::BrokerClient,
    owner_secret: &str,
    token_digest: &str,
    entry: &PendingBrokerRoom,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        entry.reservation_version == 1,
        "unreserved legacy room requires manual recovery"
    );
    let id = reservation_id(owner_secret, token_digest, &entry.room);
    if broker
        .cleanup(owner_secret, &entry.room, &id, entry.expires_at)
        .await
        .is_ok()
    {
        return Ok(());
    }
    // If reservation's response was lost before it committed, reserve first.
    // A differently owned room rejects this operation and is never revoked.
    broker
        .reserve(owner_secret, &entry.room, &id, entry.expires_at)
        .await?;
    broker
        .cleanup(owner_secret, &entry.room, &id, entry.expires_at)
        .await
}

/// Remove the durable cleanup record only after the matching reservation has
/// been confirmed cleaned. The caller holds INVITATION_GATE.
async fn cleanup_failed_preparation(
    state: &AppState,
    broker: &crate::share_broker::BrokerClient,
    owner_secret: &str,
    token_digest: &str,
    entry: &PendingBrokerRoom,
) -> Result<(), ApiError> {
    if cleanup_reserved_room(broker, owner_secret, token_digest, entry)
        .await
        .is_err()
    {
        return Ok(()); // Keep the durable record for owner retry.
    }
    let mut invitations = read_invitations(&state.database).await?;
    let invitation = invitations
        .iter_mut()
        .find(|item| item.token_digest == token_digest)
        .ok_or_else(|| ApiError::not_found("Share link not found."))?;
    invitation.broker_rooms.retain(|item| {
        item.origin != entry.origin
            || item.room != entry.room
            || item.expires_at != entry.expires_at
    });
    write_invitations(&state.database, invitations).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateShareRequest {
    pub(crate) manifest: ShareManifest,
    pub(crate) expires_in_seconds: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShareLinkResponse {
    pub(crate) token: String,
    pub(crate) preview: ShareManifest,
    pub(crate) expires_at: i64,
}

fn share_digest_string(token: &str) -> String {
    general_purpose::URL_SAFE_NO_PAD.encode(share_token_digest(token.as_bytes()))
}

async fn read_invitations(database: &Database) -> Result<Vec<ShareInvitation>, ApiError> {
    database
        .call(
            |connection| match read_document(connection, SHARE_INVITATIONS_DOCUMENT)? {
                Some(payload) => serde_json::from_str(&payload).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                }),
                None => Ok(Vec::new()),
            },
        )
        .await
}

async fn write_invitations(
    database: &Database,
    invitations: Vec<ShareInvitation>,
) -> Result<(), ApiError> {
    let payload = serde_json::to_string(&invitations)?;
    database
        .transaction(move |transaction| {
            write_document(transaction, SHARE_INVITATIONS_DOCUMENT, &payload)
        })
        .await
}

pub(crate) async fn create_share(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Json(input): Json<CreateShareRequest>,
) -> Result<Json<ShareLinkResponse>, ApiError> {
    let _gate = INVITATION_GATE.lock().await;
    require_book_access(&auth, &input.manifest.book_id)?;
    let canonical_book = state
        .library
        .read()
        .await
        .book(&input.manifest.book_id)?
        .clone();
    if canonical_book.title != input.manifest.title {
        return Err(ApiError::bad_request(
            "Share metadata no longer matches the selected book.",
        ));
    }
    let canonical_metadata = canonical_share_metadata(&canonical_book)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    if let Some(metadata) = input
        .manifest
        .assets
        .iter()
        .find(|asset| matches!(asset.kind, ShareAssetKind::Metadata))
        && (metadata.id != format!("metadata:{}", input.manifest.book_id)
            || metadata.size_bytes != canonical_metadata.len() as u64)
    {
        return Err(ApiError::bad_request(
            "Share metadata does not match the server record.",
        ));
    }
    input
        .manifest
        .validate(state.max_book_download_bytes.unwrap_or(u64::MAX))
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let library = state.library.read().await;
    let candidates = trusted_candidates_for_book(&library, &input.manifest.book_id)?;
    let selected_ids = input
        .manifest
        .assets
        .iter()
        .filter(|asset| !matches!(asset.kind, ShareAssetKind::Metadata))
        .map(|asset| asset.id.clone())
        .collect::<Vec<_>>();
    plan_selected_assets(
        &candidates,
        &selected_ids,
        &[state.library_root.as_path()],
        state.max_book_download_bytes.unwrap_or(u64::MAX),
    )
    .map_err(|error| ApiError::bad_request(error.to_string()))?;
    for asset in &input.manifest.assets {
        if matches!(asset.kind, ShareAssetKind::Metadata) {
            continue;
        }
        let candidate = candidates
            .iter()
            .find(|candidate| candidate.id == asset.id)
            .ok_or_else(|| ApiError::bad_request("Share contains an unknown asset."))?;
        if asset.kind != candidate.kind || asset.size_bytes != candidate.size_bytes {
            return Err(ApiError::bad_request(
                "Share asset metadata does not match the server.",
            ));
        }
    }
    let token = generate_session_token();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| ApiError::internal("System clock is before Unix epoch."))?
        .as_secs() as i64;
    let expires_at = now
        + input
            .expires_in_seconds
            .unwrap_or(SHARE_DEFAULT_TTL_SECONDS)
            .clamp(60, 30 * 24 * 60 * 60);
    let invitation = ShareInvitation {
        token_digest: share_digest_string(&token),
        manifest: input.manifest.clone(),
        sender_user_id: auth.id,
        created_at: now,
        expires_at,
        revoked: false,
        selected_asset_ids: selected_ids,
        include_metadata: input
            .manifest
            .assets
            .iter()
            .any(|asset| matches!(asset.kind, ShareAssetKind::Metadata)),
        broker_rooms: Vec::new(),
    };
    let mut invitations = read_invitations(&state.database).await?;
    invitations
        .retain(|item| (item.expires_at > now && !item.revoked) || !item.broker_rooms.is_empty());
    invitations.push(invitation);
    write_invitations(&state.database, invitations).await?;
    Ok(Json(ShareLinkResponse {
        token,
        preview: input.manifest,
        expires_at,
    }))
}

pub(crate) async fn share_preview(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<ShareManifest>, ApiError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| ApiError::internal("System clock is before Unix epoch."))?
        .as_secs() as i64;
    let digest = share_digest_string(&token);
    read_invitations(&state.database)
        .await?
        .into_iter()
        .find(|item| item.token_digest == digest && !item.revoked && item.expires_at > now)
        .map(|item| Json(item.manifest))
        .ok_or_else(|| ApiError::not_found("This share link is expired or revoked."))
}

pub(crate) async fn revoke_share(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(token): Path<String>,
) -> Result<StatusCode, ApiError> {
    let mut gate = INVITATION_GATE.lock().await;
    let digest = share_digest_string(&token);
    let mut invitations = read_invitations(&state.database).await?;
    let invitation = invitations
        .iter_mut()
        .find(|item| item.token_digest == digest);
    match invitation {
        Some(item) if item.sender_user_id == auth.id => item.revoked = true,
        Some(_) => {
            return Err(ApiError::forbidden(
                "You can only revoke your own share links.",
            ));
        }
        None => return Err(ApiError::not_found("Share link not found.")),
    }
    write_invitations(&state.database, invitations).await?;
    let key = invitation_key(&state, &digest);
    let mut succeeded = Vec::new();
    if let Some(senders) = gate.get_mut(&key) {
        for sender in senders.iter() {
            let _ = sender.cancel.send(true);
        }
        let mut failed = Vec::new();
        for sender in senders.drain(..) {
            if sender
                .broker
                .cleanup(
                    &sender.owner_secret,
                    &sender.room,
                    &sender.reservation_id,
                    sender.expires_at,
                )
                .await
                .is_err()
            {
                failed.push(sender);
            } else {
                succeeded.push((
                    sender.broker.origin().origin().ascii_serialization(),
                    sender.room,
                ));
            }
        }
        *senders = failed;
    }
    let mut invitations = read_invitations(&state.database).await?;
    let record = invitations
        .iter_mut()
        .find(|item| item.token_digest == digest)
        .ok_or_else(|| ApiError::not_found("Share link not found."))?;
    record.broker_rooms.retain(|entry| {
        !succeeded
            .iter()
            .any(|(origin, room)| origin == &entry.origin && room == &entry.room)
    });
    let pending = !record.broker_rooms.is_empty();
    write_invitations(&state.database, invitations).await?;
    if pending {
        return Err(ApiError::service_unavailable(
            "Share revoked locally, but broker revocation is pending; retry with the owner broker configuration.",
        ));
    }
    gate.remove(&key);
    Ok(StatusCode::NO_CONTENT)
}

/// Retry persisted revocations after restart with explicitly supplied owner
/// credentials. Stored origins are compared, never fetched as arbitrary URLs.
pub(crate) async fn retry_share_broker_revocation(
    state: &AppState,
    auth: &AuthUser,
    token: &str,
    broker: &crate::share_broker::BrokerClient,
    owner_secret: &str,
) -> Result<(), ApiError> {
    let _gate = INVITATION_GATE.lock().await;
    let digest = share_digest_string(token);
    let mut invitations = read_invitations(&state.database).await?;
    let record = invitations
        .iter_mut()
        .find(|item| item.token_digest == digest)
        .ok_or_else(|| ApiError::not_found("Share link not found."))?;
    if record.sender_user_id != auth.id || !record.revoked {
        return Err(ApiError::not_found("Revoked share link not found."));
    }
    let origin = broker.origin().origin().ascii_serialization();
    let mut pending = Vec::new();
    for entry in record.broker_rooms.drain(..) {
        if entry.origin != origin
            || cleanup_reserved_room(broker, owner_secret, &digest, &entry)
                .await
                .is_err()
        {
            pending.push(entry);
        }
    }
    let incomplete = !pending.is_empty();
    record.broker_rooms = pending;
    write_invitations(&state.database, invitations).await?;
    if incomplete {
        return Err(ApiError::service_unavailable(
            "Broker revocation remains pending.",
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RetryBrokerRevocationsRequest {
    broker_origin: String,
    owner_secret: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RetryBrokerRevocationsResponse {
    pub(crate) completed: usize,
    pub(crate) pending: usize,
}

/// Owner-only experimental setup action. The supplied origin is used only to
/// match previously persisted targets, never to fetch an arbitrary stored URL.
pub(crate) async fn retry_owner_broker_revocations(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Json(input): Json<RetryBrokerRevocationsRequest>,
) -> Result<Json<RetryBrokerRevocationsResponse>, ApiError> {
    require_owner(&auth)?;
    if input.owner_secret.is_empty() || input.owner_secret.len() > 1024 {
        return Err(ApiError::bad_request("Invalid broker credential."));
    }
    let broker = crate::share_broker::BrokerClient::new(&input.broker_origin)
        .map_err(|_| ApiError::bad_request("Broker must be an HTTPS origin."))?;
    let result = retry_revocations_for_owner(&state, &broker, &input.owner_secret).await?;
    Ok(Json(result))
}

pub(crate) async fn retry_revocations_for_owner(
    state: &AppState,
    broker: &crate::share_broker::BrokerClient,
    owner_secret: &str,
) -> Result<RetryBrokerRevocationsResponse, ApiError> {
    let mut gate = INVITATION_GATE.lock().await;
    let origin = broker.origin().origin().ascii_serialization();
    let mut invitations = read_invitations(&state.database).await?;
    let mut attempt_order = invitations
        .iter()
        .flat_map(|item| &item.broker_rooms)
        .map(|entry| entry.last_cleanup_attempt)
        .max()
        .unwrap_or(0);
    invitations.sort_by_key(|item| {
        item.broker_rooms
            .iter()
            .filter(|entry| {
                entry.origin == origin
                    && (item.revoked
                        || entry.cleanup_pending
                        || !gate
                            .get(&invitation_key(state, &item.token_digest))
                            .is_some_and(|senders| {
                                senders.iter().any(|sender| {
                                    sender.room == entry.room && sender.cancel.receiver_count() > 0
                                })
                            }))
            })
            .map(|entry| entry.last_cleanup_attempt)
            .min()
            .unwrap_or(u64::MAX)
    });
    let mut completed = 0;
    let mut pending = 0;
    let mut attempted = 0;
    for invitation in invitations.iter_mut() {
        let mut remaining = Vec::new();
        invitation
            .broker_rooms
            .sort_by_key(|entry| entry.last_cleanup_attempt);
        for mut entry in invitation.broker_rooms.drain(..) {
            let has_live_sender = gate
                .get(&invitation_key(state, &invitation.token_digest))
                .is_some_and(|senders| {
                    senders.iter().any(|sender| {
                        sender.room == entry.room && sender.cancel.receiver_count() > 0
                    })
                });
            if !invitation.revoked && !entry.cleanup_pending && has_live_sender {
                remaining.push(entry);
                continue;
            }
            if entry.origin == origin && attempted < 16 {
                attempted += 1;
                attempt_order = attempt_order.saturating_add(1);
                entry.last_cleanup_attempt = attempt_order;
                if cleanup_reserved_room(broker, owner_secret, &invitation.token_digest, &entry)
                    .await
                    .is_ok()
                {
                    if let Some(senders) =
                        gate.get_mut(&invitation_key(state, &invitation.token_digest))
                    {
                        senders.retain(|sender| sender.room != entry.room);
                    }
                    completed += 1;
                    continue;
                }
            }
            pending += 1;
            remaining.push(entry);
        }
        invitation.broker_rooms = remaining;
    }
    write_invitations(&state.database, invitations).await?;
    Ok(RetryBrokerRevocationsResponse { completed, pending })
}

/// Experimental binding of an authenticated invitation to a selected archive
/// and sender task. Not exposed through the production router.
pub(crate) struct PreparedShareSession {
    pub(crate) gift_url: String,
    session: crate::share_service::ShareSession,
}

impl PreparedShareSession {
    pub(crate) async fn wait(self) -> anyhow::Result<()> {
        self.session.wait().await
    }
}

pub(crate) async fn start_invitation_sender(
    enabled: bool,
    state: &AppState,
    auth: &AuthUser,
    token: &str,
    broker: &crate::share_broker::BrokerClient,
    owner_secret: &str,
) -> Result<PreparedShareSession, ApiError> {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    if !enabled {
        return Err(ApiError::service_unavailable("Book sharing is disabled."));
    }
    // A caller cannot choose or reuse another invitation's broker room.
    let room = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
    let nonce = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 24]>());
    let mut gate = INVITATION_GATE.lock().await;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| ApiError::internal("System clock is invalid."))?
        .as_secs();
    let invitation = read_invitations(&state.database)
        .await?
        .into_iter()
        .find(|item| {
            item.token_digest == share_digest_string(token)
                && !item.revoked
                && item.expires_at > now as i64
        })
        .ok_or_else(|| ApiError::not_found("This share link is expired or revoked."))?;
    if invitation.sender_user_id != auth.id {
        return Err(ApiError::not_found("Share link not found."));
    }
    if invitation
        .broker_rooms
        .iter()
        .any(|room| room.expires_at > now)
    {
        return Err(ApiError::conflict(
            "A share session is already active or requires broker cleanup.",
        ));
    }
    let key = invitation_key(state, &invitation.token_digest);
    if let Some(senders) = gate.get_mut(&key) {
        senders.retain(|sender| sender.expires_at > now);
        if !senders.is_empty() {
            return Err(ApiError::conflict("A share session is already active."));
        }
    }
    require_book_access(auth, &invitation.manifest.book_id)?;
    let library = state.library.read().await;
    let candidates = trusted_candidates_for_book(&library, &invitation.manifest.book_id)?;
    let planned = plan_selected_assets(
        &candidates,
        &invitation.selected_asset_ids,
        &[state.library_root.as_path()],
        state.max_book_download_bytes.unwrap_or(u64::MAX),
    )
    .map_err(|error| ApiError::conflict(format!("Share contents changed: {error}")))?;
    let book = library.book(&invitation.manifest.book_id)?.clone();
    let generated = if invitation.include_metadata {
        vec![GeneratedArchiveEntry {
            archive_name: "metadata.json".into(),
            contents: canonical_share_metadata(&book)
                .map_err(|error| ApiError::internal(error.to_string()))?,
        }]
    } else {
        Vec::new()
    };
    drop(library);
    let limit = share_archive_limit(state, &planned, &generated)?;
    let permit = state
        .download_task_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::too_many_requests("Share transfer capacity is full."))?;
    let output = tempfile::NamedTempFile::new_in(&state.download_temp_dir)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let temp = output.into_temp_path();
    let path = temp.to_path_buf();
    let archive_path = path.clone();
    let root = state.library_root.clone();
    let receipt = tokio::task::spawn_blocking(move || {
        write_verified_archive(&archive_path, &planned, &generated, &root, limit)
    })
    .await
    .map_err(|error| ApiError::internal(error.to_string()))?
    .map_err(|error| ApiError::conflict(format!("Share contents changed: {error}")))?;
    let archive = fs::File::open(path)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let size = archive
        .metadata()
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .len();
    if size != receipt.size {
        return Err(ApiError::conflict(
            "Share archive changed during preparation.",
        ));
    }
    let expires_at = (invitation.expires_at as u64).min(now.saturating_add(900));
    let random_id = || URL_SAFE_NO_PAD.encode(rand::random::<[u8; 24]>());
    let recipient_nonce = random_id();
    let gift_id = random_id();
    let signing = ed25519_dalek::SigningKey::from_bytes(&rand::random::<[u8; 32]>());
    let preview_key = rand::random::<[u8; 32]>();
    let preview = crate::share_preview_crypto::preview_from_archive(
        &book,
        &invitation.manifest.sender_display_name,
        invitation.manifest.personal_message.as_deref(),
        &gift_id,
        &room,
        expires_at,
        &receipt,
    )
    .map_err(|error| ApiError::internal(format!("Cannot prepare share preview: {error}")))?;
    let encrypted =
        crate::share_preview_crypto::encrypt_signed_preview(&preview, &signing, &preview_key)
            .map_err(|error| {
                ApiError::internal(format!("Cannot encrypt share preview: {error}"))
            })?;
    // Persist before broker side effects; credentials are not stored here.
    let mut invitations = read_invitations(&state.database).await?;
    let record = invitations
        .iter_mut()
        .find(|item| item.token_digest == invitation.token_digest)
        .ok_or_else(|| ApiError::not_found("Share link not found."))?;
    if record.broker_rooms.len() >= 32 {
        return Err(ApiError::conflict("Too many rooms await owner cleanup."));
    }
    let pending = PendingBrokerRoom {
        origin: broker.origin().origin().ascii_serialization(),
        room: room.to_string(),
        expires_at,
        reservation_version: 1,
        cleanup_pending: true,
        last_cleanup_attempt: 0,
    };
    record.broker_rooms.push(pending.clone());
    write_invitations(&state.database, invitations).await?;
    let reservation_id = reservation_id(owner_secret, &invitation.token_digest, &room);
    if broker
        .reserve(owner_secret, &room, &reservation_id, expires_at)
        .await
        .is_err()
    {
        cleanup_failed_preparation(
            state,
            broker,
            owner_secret,
            &invitation.token_digest,
            &pending,
        )
        .await?;
        return Err(ApiError::service_unavailable(
            "Broker room reservation failed; cleanup may be pending.",
        ));
    }
    let recipient = match broker
        .issue_recipient(owner_secret, &room, &recipient_nonce, expires_at)
        .await
    {
        Ok(value) => value,
        Err(_) => {
            cleanup_failed_preparation(
                state,
                broker,
                owner_secret,
                &invitation.token_digest,
                &pending,
            )
            .await?;
            return Err(ApiError::service_unavailable(
                "Could not issue recipient capability.",
            ));
        }
    };
    if broker
        .publish_preview(owner_secret, &room, expires_at, &encrypted)
        .await
        .is_err()
    {
        cleanup_failed_preparation(
            state,
            broker,
            owner_secret,
            &invitation.token_digest,
            &pending,
        )
        .await?;
        return Err(ApiError::service_unavailable(
            "Could not publish share preview.",
        ));
    }
    let token = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&recipient).map_err(|error| ApiError::internal(error.to_string()))?,
    );
    let mut gift_url = broker
        .origin()
        .join("/gift")
        .map_err(|error| ApiError::internal(error.to_string()))?;
    gift_url
        .query_pairs_mut()
        .append_pair("gift", &token)
        .append_pair("broker", &broker.origin().origin().ascii_serialization())
        .append_pair("key", &URL_SAFE_NO_PAD.encode(preview_key))
        .append_pair(
            "signing",
            &URL_SAFE_NO_PAD.encode(signing.verifying_key().to_bytes()),
        );
    let fragment = gift_url.query().unwrap_or_default().to_string();
    gift_url.set_query(None);
    gift_url.set_fragment(Some(&fragment));
    let peer_broker = broker.clone();
    let peer_room = room.to_string();
    let session_result = crate::share_service::start(
        enabled,
        broker,
        owner_secret,
        &room,
        &nonce,
        expires_at,
        move |capability, stop| async move {
            let _guards = (temp, permit);
            crate::share_sender::run_authenticated_sender(
                peer_broker,
                peer_room,
                capability,
                archive,
                size,
                expires_at,
                crate::share_sender::PeerAuthentication {
                    gift_id,
                    archive_sha256: receipt.sha256,
                    signing,
                    preview_key,
                },
                stop,
            )
            .await
        },
    )
    .await;
    let session = match session_result {
        Ok(session) => session,
        Err(error) => {
            cleanup_failed_preparation(
                state,
                broker,
                owner_secret,
                &invitation.token_digest,
                &pending,
            )
            .await?;
            return Err(ApiError::internal(format!(
                "Share session could not start: {error}"
            )));
        }
    };
    let mark_active = async {
        let mut invitations = read_invitations(&state.database).await?;
        let record = invitations
            .iter_mut()
            .find(|item| item.token_digest == invitation.token_digest)
            .ok_or_else(|| ApiError::not_found("Share link not found."))?;
        let entry = record
            .broker_rooms
            .iter_mut()
            .find(|entry| entry.room == room && entry.origin == pending.origin)
            .ok_or_else(|| ApiError::internal("Share reservation record missing."))?;
        entry.cleanup_pending = false;
        write_invitations(&state.database, invitations).await
    }
    .await;
    if let Err(error) = mark_active {
        let _ = session.cancellation_handle().send(true);
        let _ = cleanup_failed_preparation(
            state,
            broker,
            owner_secret,
            &invitation.token_digest,
            &pending,
        )
        .await;
        return Err(error);
    }
    let senders = gate
        .entry(invitation_key(state, &invitation.token_digest))
        .or_default();
    senders.push(ActiveSender {
        cancel: session.cancellation_handle(),
        broker: broker.clone(),
        owner_secret: owner_secret.to_string(),
        room: room.to_string(),
        expires_at,
        reservation_id,
    });
    Ok(PreparedShareSession {
        gift_url: gift_url.to_string(),
        session,
    })
}

/// Transfer the server's bounded book archive after the recipient accepts the
/// preview. This is intentionally a one-way bearer route; it never creates a
/// recipient account or exposes the sender's session.
pub(crate) async fn share_download(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Response, ApiError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| ApiError::internal("System clock is before Unix epoch."))?
        .as_secs() as i64;
    let digest = share_digest_string(&token);
    let invitation = read_invitations(&state.database)
        .await?
        .into_iter()
        .find(|item| item.token_digest == digest && !item.revoked && item.expires_at > now)
        .ok_or_else(|| ApiError::not_found("This share link is expired or revoked."))?;
    if invitation.selected_asset_ids.is_empty() {
        return Err(ApiError::service_unavailable(
            "This invitation has no safe selected-asset inventory.",
        ));
    }
    let library = state.library.read().await;
    let candidates = trusted_candidates_for_book(&library, &invitation.manifest.book_id)?;
    let planned = plan_selected_assets(
        &candidates,
        &invitation.selected_asset_ids,
        &[state.library_root.as_path()],
        state.max_book_download_bytes.unwrap_or(u64::MAX),
    )
    .map_err(|error| ApiError::conflict(format!("Share contents changed: {error}")))?;
    let generated = if invitation.include_metadata {
        vec![GeneratedArchiveEntry {
            archive_name: "metadata.json".into(),
            contents: canonical_share_metadata(
                &library.book(&invitation.manifest.book_id)?.clone(),
            )
            .map_err(|error| ApiError::internal(error.to_string()))?,
        }]
    } else {
        Vec::new()
    };
    let limit = share_archive_limit(&state, &planned, &generated)?;
    let permit = state
        .download_task_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            ApiError::too_many_requests(
                "The configured number of share transfers are already active.",
            )
        })?;
    let output = tempfile::NamedTempFile::new_in(&state.download_temp_dir)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let temp_path = output.into_temp_path();
    let path = temp_path.to_path_buf();
    let archive_path = path.clone();
    let library_root = state.library_root.clone();
    let receipt = tokio::task::spawn_blocking(move || {
        write_verified_archive(&archive_path, &planned, &generated, &library_root, limit)
    })
    .await
    .map_err(|error| ApiError::internal(error.to_string()))?
    .map_err(|error| ApiError::conflict(format!("Share contents changed: {error}")))?;
    let file = fs::File::open(&path)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let size = file
        .metadata()
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .len();
    if size != receipt.size {
        return Err(ApiError::conflict(
            "Share archive changed during preparation.",
        ));
    }
    let stream = ReaderStream::new(RemoveOnDropFile::guarded(file, temp_path, permit));
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/zip")
        .header(
            "content-disposition",
            "attachment; filename=operalibre-share.zip",
        )
        .header(CONTENT_LENGTH, size)
        .body(Body::from_stream(stream))?)
}

impl ShareManifest {
    pub(crate) fn validate(&self, max_bytes: u64) -> anyhow::Result<()> {
        if self.version != 1 {
            anyhow::bail!("unsupported share manifest version")
        }
        if self.book_id.is_empty()
            || self.title.is_empty()
            || self.sender_display_name.trim().is_empty()
        {
            anyhow::bail!("share identity is incomplete")
        }
        if self
            .personal_message
            .as_deref()
            .is_some_and(|message| message.chars().count() > SHARE_MAX_MESSAGE_CHARS)
        {
            anyhow::bail!("share message is too long")
        }
        if self.assets.is_empty() || self.assets.len() > SHARE_MAX_ASSETS {
            anyhow::bail!("invalid share asset count")
        }
        let calculated = self.assets.iter().try_fold(0_u64, |sum, asset| {
            if asset.id.is_empty()
                || asset.file_name.is_empty()
                || asset.sha256.len() != 64
                || !asset.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            {
                anyhow::bail!("invalid share asset metadata")
            }
            sum.checked_add(asset.size_bytes)
                .ok_or_else(|| anyhow::anyhow!("share size overflow"))
        })?;
        if calculated != self.total_bytes {
            anyhow::bail!("share size does not match its assets")
        }
        if calculated > max_bytes {
            anyhow::bail!("share exceeds the configured size limit")
        }
        let text = self
            .assets
            .iter()
            .any(|a| matches!(a.kind, ShareAssetKind::Ebook));
        let audio = self
            .assets
            .iter()
            .any(|a| matches!(a.kind, ShareAssetKind::Audio));
        if self
            .assets
            .iter()
            .any(|a| matches!(a.kind, ShareAssetKind::Alignment))
            && (!text || !audio)
        {
            anyhow::bail!("alignment requires both an ebook and audio")
        }
        Ok(())
    }
}

/// Persist only this digest, never the bearer token itself.
pub(crate) fn share_token_digest(token: &[u8]) -> [u8; 32] {
    Sha256::digest(token).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reservation_identity_is_scoped_and_does_not_embed_credential() {
        let value = reservation_id("owner-secret", "digest-one", "room-one");
        assert_eq!(value.len(), 43);
        assert!(!value.contains("owner-secret"));
        assert_eq!(
            value,
            reservation_id("owner-secret", "digest-one", "room-one")
        );
        assert_ne!(
            value,
            reservation_id("owner-secret", "digest-two", "room-one")
        );
        assert_ne!(
            value,
            reservation_id("owner-secret", "digest-one", "room-two")
        );
        assert_ne!(
            value,
            reservation_id("other-secret", "digest-one", "room-one")
        );
    }
    use tempfile::tempdir;

    /// Opt-in cross-runtime fixture, written only to the explicit test path.
    #[test]
    fn write_native_import_fixture_when_requested() {
        let Some(output) = std::env::var_os("OPERALIBRE_GIFT_FIXTURE_PATH") else {
            return;
        };
        let root = tempdir().unwrap();
        let ebook = root.path().join("book.epub");
        std::fs::write(&ebook, b"server generated ebook").unwrap();
        let candidate = TrustedShareFile {
            id: "ebook".into(),
            kind: ShareAssetKind::Ebook,
            file_name: "book.epub".into(),
            path: ebook,
            size_bytes: 22,
        };
        let selected =
            plan_selected_assets(&[candidate], &["ebook".into()], &[root.path()], 1024).unwrap();
        write_selected_archive(std::path::Path::new(&output), &selected, &[root.path()]).unwrap();
    }
    fn asset(kind: ShareAssetKind, size: u64) -> ShareAsset {
        ShareAsset {
            id: format!("{kind:?}"),
            kind,
            file_name: "book.bin".into(),
            size_bytes: size,
            sha256: "a".repeat(64),
        }
    }
    fn manifest(assets: Vec<ShareAsset>) -> ShareManifest {
        ShareManifest {
            version: 1,
            book_id: "book".into(),
            title: "A book".into(),
            author: None,
            description: None,
            sender_display_name: "Donovan".into(),
            personal_message: None,
            total_bytes: assets.iter().map(|a| a.size_bytes).sum(),
            assets,
        }
    }
    #[test]
    fn lightweight_ebook_share_is_valid() {
        assert!(
            manifest(vec![
                asset(ShareAssetKind::Ebook, 12),
                asset(ShareAssetKind::Metadata, 2),
                asset(ShareAssetKind::Cover, 3)
            ])
            .validate(100)
            .is_ok()
        );
    }
    #[test]
    fn alignment_requires_matching_text_and_audio() {
        assert!(
            manifest(vec![
                asset(ShareAssetKind::Alignment, 1),
                asset(ShareAssetKind::Ebook, 1)
            ])
            .validate(100)
            .is_err()
        );
        assert!(
            manifest(vec![
                asset(ShareAssetKind::Alignment, 1),
                asset(ShareAssetKind::Ebook, 1),
                asset(ShareAssetKind::Audio, 1)
            ])
            .validate(100)
            .is_ok()
        );
    }
    #[test]
    fn declared_size_and_limit_are_enforced() {
        let mut value = manifest(vec![asset(ShareAssetKind::Ebook, 12)]);
        value.total_bytes = 11;
        assert!(value.validate(100).is_err());
        value.total_bytes = 12;
        assert!(value.validate(11).is_err());
    }
    #[test]
    fn personal_message_is_bounded() {
        let mut value = manifest(vec![asset(ShareAssetKind::Ebook, 1)]);
        value.personal_message = Some("x".repeat(SHARE_MAX_MESSAGE_CHARS + 1));
        assert!(value.validate(100).is_err());
    }
    #[test]
    fn token_digest_is_not_the_token() {
        let token = [7_u8; SHARE_TOKEN_BYTES];
        assert_ne!(share_token_digest(&token), token);
    }

    #[test]
    fn planner_excludes_unselected_audio_from_ebook_share() {
        let root = tempdir().unwrap();
        let ebook = root.path().join("book.epub");
        let audio = root.path().join("book.m4b");
        std::fs::write(&ebook, b"epub").unwrap();
        std::fs::write(&audio, b"audio").unwrap();
        let candidates = vec![
            TrustedShareFile {
                id: "ebook".into(),
                kind: ShareAssetKind::Ebook,
                file_name: "book.epub".into(),
                path: ebook,
                size_bytes: 4,
            },
            TrustedShareFile {
                id: "audio".into(),
                kind: ShareAssetKind::Audio,
                file_name: "book.m4b".into(),
                path: audio,
                size_bytes: 5,
            },
        ];
        let planned =
            plan_selected_assets(&candidates, &["ebook".into()], &[root.path()], 100).unwrap();
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].kind, ShareAssetKind::Ebook);
    }

    #[test]
    fn planner_rejects_path_escape_and_tampered_size() {
        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let path = outside.path().join("secret.epub");
        std::fs::write(&path, b"secret").unwrap();
        let escaped = TrustedShareFile {
            id: "escape".into(),
            kind: ShareAssetKind::Ebook,
            file_name: "secret.epub".into(),
            path,
            size_bytes: 6,
        };
        assert!(plan_selected_assets(&[escaped], &["escape".into()], &[root.path()], 100).is_err());
        let path = root.path().join("book.epub");
        std::fs::write(&path, b"actual").unwrap();
        let tampered = TrustedShareFile {
            id: "tampered".into(),
            kind: ShareAssetKind::Ebook,
            file_name: "book.epub".into(),
            path,
            size_bytes: 999,
        };
        assert!(
            plan_selected_assets(&[tampered], &["tampered".into()], &[root.path()], 1000).is_err()
        );
    }

    #[test]
    fn archive_contains_only_planned_entries() {
        let root = tempdir().unwrap();
        let ebook = root.path().join("book.epub");
        let audio = root.path().join("book.m4b");
        std::fs::write(&ebook, b"epub").unwrap();
        std::fs::write(&audio, b"audio").unwrap();
        let candidates = vec![
            TrustedShareFile {
                id: "ebook".into(),
                kind: ShareAssetKind::Ebook,
                file_name: "book.epub".into(),
                path: ebook,
                size_bytes: 4,
            },
            TrustedShareFile {
                id: "audio".into(),
                kind: ShareAssetKind::Audio,
                file_name: "book.m4b".into(),
                path: audio,
                size_bytes: 5,
            },
        ];
        let planned =
            plan_selected_assets(&candidates, &["ebook".into()], &[root.path()], 100).unwrap();
        let archive = root.path().join("share.zip");
        write_selected_archive(&archive, &planned, &[root.path()]).unwrap();
        let file = std::fs::File::open(archive).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        assert_eq!(zip.len(), 1);
        assert_eq!(zip.by_index(0).unwrap().name().unwrap(), "book.epub");
    }

    #[test]
    fn generated_metadata_entry_is_typed_and_bounded() {
        let root = tempdir().unwrap();
        let archive = root.path().join("metadata.zip");
        write_generated_entries(
            &archive,
            &[GeneratedArchiveEntry {
                archive_name: "metadata.json".into(),
                contents: br#"{"title":"Trusted"}"#.to_vec(),
            }],
        )
        .unwrap();
        let file = std::fs::File::open(archive).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut contents = String::new();
        use std::io::Read;
        zip.by_name("metadata.json")
            .unwrap()
            .read_to_string(&mut contents)
            .unwrap();
        assert_eq!(contents, r#"{"title":"Trusted"}"#);
        assert!(
            write_generated_entries(
                &root.path().join("bad.zip"),
                &[GeneratedArchiveEntry {
                    archive_name: "../private.json".into(),
                    contents: vec![1],
                }]
            )
            .is_err()
        );
    }

    #[test]
    fn mixed_archive_has_metadata_and_only_selected_ebook() {
        let root = tempdir().unwrap();
        let ebook = root.path().join("book.epub");
        let audio = root.path().join("book.m4b");
        std::fs::write(&ebook, b"ebook").unwrap();
        std::fs::write(&audio, b"audio").unwrap();
        let planned = plan_selected_assets(
            &[
                TrustedShareFile {
                    id: "ebook".into(),
                    kind: ShareAssetKind::Ebook,
                    file_name: "book.epub".into(),
                    path: ebook,
                    size_bytes: 5,
                },
                TrustedShareFile {
                    id: "audio".into(),
                    kind: ShareAssetKind::Audio,
                    file_name: "book.m4b".into(),
                    path: audio,
                    size_bytes: 5,
                },
            ],
            &["ebook".into()],
            &[root.path()],
            100,
        )
        .unwrap();
        let archive = root.path().join("mixed.zip");
        write_mixed_archive(
            &archive,
            &planned,
            &[GeneratedArchiveEntry {
                archive_name: "metadata.json".into(),
                contents: br#"{"title":"Trusted"}"#.to_vec(),
            }],
            &[root.path()],
        )
        .unwrap();
        let file = std::fs::File::open(archive).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        assert_eq!(zip.len(), 2);
        assert!(zip.by_name("book.epub").is_ok());
        assert!(zip.by_name("metadata.json").is_ok());
        assert!(zip.by_name("book.m4b").is_err());
    }

    #[test]
    fn verified_archive_hashes_only_written_bytes_and_rejects_unsafe_names() {
        let root = tempdir().unwrap();
        let ebook = root.path().join("book.epub");
        std::fs::write(&ebook, b"selected ebook").unwrap();
        let candidates = vec![TrustedShareFile {
            id: "ebook".into(),
            kind: ShareAssetKind::Ebook,
            file_name: "book.epub".into(),
            path: ebook,
            size_bytes: 14,
        }];
        let mut planned =
            plan_selected_assets(&candidates, &["ebook".into()], &[root.path()], 4096).unwrap();
        let output = tempfile::NamedTempFile::new_in(root.path()).unwrap();
        let generated = vec![GeneratedArchiveEntry {
            archive_name: "metadata.json".into(),
            contents: b"{}".to_vec(),
        }];
        let receipt =
            write_verified_archive(output.path(), &planned, &generated, root.path(), 4096).unwrap();
        assert_eq!(receipt.assets.len(), 2);
        assert_eq!(
            receipt.assets[0].sha256,
            hex_digest(Sha256::digest(b"selected ebook"))
        );
        assert_eq!(receipt.assets[1].sha256, hex_digest(Sha256::digest(b"{}")));
        let bytes = std::fs::read(output.path()).unwrap();
        assert_eq!(receipt.size, bytes.len() as u64);
        assert_eq!(receipt.sha256, hex_digest(Sha256::digest(&bytes)));
        planned[0].archive_name = "../escape".into();
        assert!(write_verified_archive(output.path(), &planned, &[], root.path(), 4096).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn archive_writer_rejects_symlinked_asset_at_open_time() {
        let root = tempdir().unwrap();
        let target = root.path().join("real.epub");
        let link = root.path().join("book.epub");
        std::fs::write(&target, b"ebook").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let planned = PlannedShareFile {
            id: "ebook".into(),
            kind: ShareAssetKind::Ebook,
            archive_name: "book.epub".into(),
            path: link,
            size_bytes: 5,
        };
        assert!(
            write_selected_archive(&root.path().join("race.zip"), &[planned], &[root.path()])
                .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn archive_writer_rejects_symlinked_ancestor_at_open_time() {
        let root = tempdir().unwrap();
        let real = root.path().join("real");
        let outside = tempdir().unwrap();
        std::fs::create_dir_all(&real).unwrap();
        let target = outside.path().join("book.epub");
        std::fs::write(&target, b"ebook").unwrap();
        let ancestor = real.join("chapter");
        std::os::unix::fs::symlink(outside.path(), &ancestor).unwrap();
        let planned = PlannedShareFile {
            id: "ebook".into(),
            kind: ShareAssetKind::Ebook,
            archive_name: "book.epub".into(),
            path: ancestor.join("book.epub"),
            size_bytes: 5,
        };
        assert!(
            write_selected_archive(
                &root.path().join("race-ancestor.zip"),
                &[planned],
                &[root.path()]
            )
            .is_err()
        );
    }
}
