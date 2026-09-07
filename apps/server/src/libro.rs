//! Imports DRM-free Libro.fm downloads from an explicitly selected server
//! folder. Host-local settings/history are separate from portable backups.
use crate::*;
use std::time::Instant;

const SETTLE_TIME: Duration = Duration::from_secs(60);
const MAX_ITEMS: usize = 5_000;
const MARKER: &str = ".operalibre-libro.json";

#[derive(Default)]
pub(crate) struct LibroImports {
    pub(crate) account_gates: Mutex<HashMap<String, std::sync::Weak<Mutex<()>>>>,
    gate: Mutex<HashMap<String, (String, Instant)>>,
    status: RwLock<ScanStatus>,
}

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanStatus {
    items: Vec<ImportItem>,
    last_checked: Option<String>,
    error: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    folder: Option<PathBuf>,
    #[serde(default)]
    imported: BTreeMap<String, Receipt>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    signature: String,
    destination: String,
    imported_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportItem {
    name: String,
    status: String,
    detail: String,
    imported_at: Option<String>,
}

impl ImportItem {
    fn new(name: String, status: &str, detail: impl Into<String>) -> Self {
        Self {
            name,
            status: status.into(),
            detail: detail.into(),
            imported_at: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibroStatus {
    folder: Option<PathBuf>,
    #[serde(flatten)]
    scan: ScanStatus,
    job: Option<JobStatus>,
}

#[derive(Deserialize)]
pub(crate) struct LibroSettingsUpdate {
    folder: Option<String>,
}

fn settings_path(state: &AppState) -> PathBuf {
    state
        .database_path
        .with_file_name("libro-import.config.json")
}

async fn load_settings(state: &AppState) -> Result<Settings, ApiError> {
    match fs::read(settings_path(state)).await {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(e.into()),
    }
}

pub(crate) async fn libro_status(
    State(state): State<AppState>,
    _: AdminUser,
) -> Result<Json<LibroStatus>, ApiError> {
    read_status(&state).await
}

async fn read_status(state: &AppState) -> Result<Json<LibroStatus>, ApiError> {
    let settings = load_settings(state).await?;
    let mut scan = state.libro.status.read().await.clone();
    // Disabled imports still have useful history after a restart.
    if scan.last_checked.is_none() && scan.items.is_empty() {
        for receipt in settings.imported.values() {
            let exists = fs::metadata(state.library_root.join(&receipt.destination))
                .await
                .is_ok_and(|m| m.is_dir());
            let mut item = ImportItem::new(
                receipt.destination.clone(),
                if exists { "imported" } else { "missing" },
                if exists {
                    "Previously imported into your library."
                } else {
                    "The imported library folder is missing. Upload the book manually to restore it."
                },
            );
            item.imported_at = Some(receipt.imported_at.clone());
            scan.items.push(item);
        }
    }
    let job = state
        .jobs
        .read()
        .await
        .values()
        .filter(|j| j.kind == "libro-import")
        .max_by_key(|j| job_started_timestamp(j))
        .cloned();
    Ok(Json(LibroStatus {
        folder: settings.folder,
        scan,
        job,
    }))
}

pub(crate) async fn configure_libro(
    State(state): State<AppState>,
    _: OwnerUser,
    Json(update): Json<LibroSettingsUpdate>,
) -> Result<Json<LibroStatus>, ApiError> {
    let mut observations = state.libro.gate.lock().await;
    let mut settings = load_settings(&state).await?;
    let folder = update.folder.filter(|s| !s.trim().is_empty());
    settings.folder = if let Some(folder) = folder {
        let path = PathBuf::from(folder.trim());
        if !path.is_absolute() {
            return Err(ApiError::bad_request(
                "Enter an absolute folder path on the OperaLibre server.",
            ));
        }
        let library = state.library_root.clone();
        let data = state.database_path.parent().unwrap().to_path_buf();
        Some(
            tokio::task::spawn_blocking(move || validate_folder(&path, &library, &data))
                .await
                .map_err(|e| ApiError::internal(e.to_string()))?
                .map_err(|e| ApiError::bad_request(e.to_string()))?,
        )
    } else {
        None
    };
    write_json_atomic(&settings_path(&state), &settings).await?;
    observations.clear();
    *state.libro.status.write().await = ScanStatus::default();
    drop(observations);
    // The next scheduled scan observes the folder, then waits for it to settle.
    start_scan(&state).await;
    read_status(&state).await
}

fn validate_folder(path: &FsPath, library: &FsPath, data: &FsPath) -> anyhow::Result<PathBuf> {
    let folder = std::fs::canonicalize(path)?;
    anyhow::ensure!(folder.is_dir(), "Choose a folder, not a file.");
    for protected in [library, data] {
        // The library might not exist yet on a fresh installation.
        std::fs::create_dir_all(protected)?;
        let protected = std::fs::canonicalize(protected)?;
        anyhow::ensure!(
            !folder.starts_with(&protected) && !protected.starts_with(&folder),
            "Choose a dedicated import folder outside the library and server data folders."
        );
    }
    std::fs::read_dir(&folder)?;
    Ok(folder)
}

pub(crate) async fn scan_libro(
    State(state): State<AppState>,
    _: AdminUser,
) -> Result<Json<JobCreated>, ApiError> {
    if load_settings(&state).await?.folder.is_none() {
        return Err(ApiError::bad_request(
            "Choose a Libro.fm import folder first.",
        ));
    }
    Ok(Json(JobCreated {
        job_id: start_scan(&state).await,
    }))
}

async fn start_scan(state: &AppState) -> String {
    let (id, created) = create_queued_job(state, "libro-import", None).await;
    if created {
        let state = state.clone();
        let job_id = id.clone();
        tokio::spawn(run_job(state.clone(), id.clone(), async move {
            update_job_running(&state, &job_id).await;
            let result = import_scan(&state, &job_id).await;
            let error = result.err().map(|e| e.to_string());
            state.libro.status.write().await.error = error.clone();
            update_job_finished(
                &state,
                &job_id,
                if error.is_some() {
                    "failed"
                } else {
                    "completed"
                },
                None,
                error,
            )
            .await;
        }));
    }
    id
}

pub(crate) fn schedule_libro_imports(state: AppState) {
    tokio::spawn(async move {
        let mut shutdown = state.shutdown.subscribe();
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = shutdown.recv() => break,
                _ = interval.tick() => {
                    match load_settings(&state).await {
                        Ok(settings) if settings.folder.is_some() => { start_scan(&state).await; }
                        Ok(_) => {}
                        Err(e) => { state.libro.status.write().await.error = Some(e.message); }
                    }
                }
            }
        }
    });
}

#[derive(Clone)]
struct Candidate {
    source: PathBuf,
    name: String,
    files: Vec<PathBuf>,
    signature: String,
    issue: Option<String>,
}

fn audio(path: &FsPath) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("m4b") || s.eq_ignore_ascii_case("mp3"))
}

fn candidate(source: PathBuf) -> anyhow::Result<Candidate> {
    let is_dir = source.is_dir();
    let name = if is_dir {
        source.file_name()
    } else {
        source.file_stem()
    }
    .unwrap_or_default()
    .to_string_lossy()
    .into_owned();
    let mut files = Vec::new();
    let mut issue = name
        .to_ascii_lowercase()
        .ends_with(".download")
        .then(|| "Finish downloading before moving this book into the watched folder.".into());
    for (count, entry) in WalkDir::new(&source)
        .follow_links(false)
        .into_iter()
        .enumerate()
    {
        anyhow::ensure!(
            count < MAX_ITEMS,
            "Too many files in {name}. Split downloads into separate book folders."
        );
        let entry = entry?;
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if entry.file_type().is_symlink() {
            issue = Some("Remove symbolic links from this download before importing.".into());
        } else if entry.file_type().is_file() && audio(path) {
            files.push(path.to_path_buf());
        } else if entry.file_type().is_file()
            && (file_name.ends_with(".zip")
                || file_name.ends_with(".part")
                || file_name.ends_with(".crdownload")
                || file_name.ends_with(".download"))
        {
            issue = Some("Finish downloading and extract ZIPs outside the watched folder, then place the complete book folder here.".into());
        }
    }
    files.sort();
    if files.len() > 1
        && files
            .iter()
            .any(|p| p.extension().is_some_and(|s| s.eq_ignore_ascii_case("m4b")))
    {
        issue = Some("Use one M4B per book, or all its MP3 tracks. Keep alternative formats in separate folders outside the watched folder.".into());
    }
    if files.is_empty() && issue.is_none() {
        issue = Some("Place an M4B or extracted MP3 tracks in this book folder.".into());
    }
    if files.len() > MAX_UPLOAD_FILES {
        issue = Some("This book has too many tracks to import.".into());
    }
    let signature = signature(&files)?;
    Ok(Candidate {
        source,
        name,
        files,
        signature,
        issue,
    })
}

fn signature(files: &[PathBuf]) -> anyhow::Result<String> {
    let mut hash = Sha256::new();
    for file in files {
        let metadata = std::fs::symlink_metadata(file)?;
        anyhow::ensure!(metadata.is_file(), "A download changed while checking it.");
        hash.update(file.to_string_lossy().as_bytes());
        hash.update(metadata.len().to_le_bytes());
        hash.update(
            metadata
                .modified()?
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
                .to_le_bytes(),
        );
    }
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn discover(folder: &FsPath) -> anyhow::Result<Vec<Candidate>> {
    let mut items = Vec::new();
    for (index, entry) in std::fs::read_dir(folder)?.enumerate() {
        anyhow::ensure!(
            index < MAX_ITEMS,
            "The import folder contains too many entries."
        );
        let entry = entry?;
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir()
            || audio(&entry.path())
            || entry
                .path()
                .extension()
                .is_some_and(|s| s.eq_ignore_ascii_case("zip"))
        {
            items.push(candidate(entry.path())?);
        }
    }
    items.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(items)
}

async fn import_scan(state: &AppState, job: &str) -> anyhow::Result<()> {
    let mut observations = state.libro.gate.lock().await;
    let mut settings = load_settings(state)
        .await
        .map_err(|e| anyhow::anyhow!(e.message))?;
    let Some(folder) = settings.folder.clone() else {
        return Ok(());
    };
    let library = state.library_root.clone();
    let data = state.database_path.parent().unwrap().to_path_buf();
    let candidates = tokio::task::spawn_blocking(move || {
        let folder = validate_folder(&folder, &library, &data)?;
        discover(&folder)
    })
    .await??;
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    let total = candidates.len();
    let mut published = false;
    for (index, candidate) in candidates.into_iter().enumerate() {
        let key = candidate.source.to_string_lossy().into_owned();
        seen.insert(key.clone());
        update_job_progress(
            state,
            job,
            JobProgress::new(format!("Checking {}", candidate.name)).steps(index, total),
        )
        .await;
        let mut item = ImportItem::new(
            candidate.name.clone(),
            "waiting",
            "Waiting for the download to stay unchanged for 60 seconds.",
        );
        if let Some(receipt) = settings.imported.get(&key) {
            item.imported_at = Some(receipt.imported_at.clone());
            if receipt.signature != candidate.signature {
                item.status = "review".into();
                item.detail = "The source changed after import. Review it before uploading a replacement manually.".into();
            } else if state.library_root.join(&receipt.destination).is_dir() {
                item.status = "imported".into();
                item.detail = "Already imported. Your original download is kept.".into();
            } else {
                item.status = "missing".into();
                item.detail = "The imported library folder is missing. Upload the book manually to restore it.".into();
            }
        } else if let Some(issue) = &candidate.issue {
            observations.remove(&key);
            item.status = "review".into();
            item.detail = issue.clone();
        } else {
            let observation = observations
                .entry(key.clone())
                .or_insert_with(|| (candidate.signature.clone(), Instant::now()));
            if observation.0 != candidate.signature {
                *observation = (candidate.signature.clone(), Instant::now());
            }
            if observation.1.elapsed() >= SETTLE_TIME {
                anyhow::ensure!(
                    settings.imported.len() < MAX_ITEMS,
                    "Import history is full. Use manual uploads for additional books."
                );
                let _upload = state.upload_lock.lock().await;
                let library = state.library_root.clone();
                let root = settings.folder.clone().unwrap();
                let limit = state.max_upload_bytes.unwrap_or(u64::MAX);
                let reserve = state.min_download_free_bytes;
                let result = tokio::task::spawn_blocking(move || {
                    publish(&candidate, &root, &library, limit, reserve)
                })
                .await?;
                match result {
                    Ok(receipt) => {
                        item.status = "imported".into();
                        item.detail =
                            "Imported into your library. Your original download is kept.".into();
                        item.imported_at = Some(receipt.imported_at.clone());
                        settings.imported.insert(key.clone(), receipt);
                        published = true;
                        write_json_atomic(&settings_path(state), &settings)
                            .await
                            .map_err(|e| anyhow::anyhow!(e.message))?;
                    }
                    Err(e) => {
                        item.status = "review".into();
                        item.detail = e.to_string();
                    }
                }
            }
        }
        items.push(item);
        state.libro.status.write().await.items = items.clone();
    }
    observations.retain(|key, _| seen.contains(key));
    // Keep receipt visibility even if the user removes their original download.
    for (source, receipt) in &settings.imported {
        if seen.contains(source) {
            continue;
        }
        let exists = state.library_root.join(&receipt.destination).is_dir();
        let mut item = ImportItem::new(
            receipt.destination.clone(),
            if exists { "imported" } else { "missing" },
            if exists {
                "Imported. The original download is no longer in the watched folder."
            } else {
                "The imported library folder is missing. Upload the book manually to restore it."
            },
        );
        item.imported_at = Some(receipt.imported_at.clone());
        items.push(item);
    }
    let indexed: HashSet<PathBuf> = state
        .library
        .read()
        .await
        .book_paths
        .values()
        .cloned()
        .collect();
    let needs_index = settings.imported.values().any(|receipt| {
        let path = state.library_root.join(&receipt.destination);
        path.is_dir() && !indexed.contains(&path)
    });
    if published || needs_index {
        update_job_progress(
            state,
            job,
            JobProgress::new("Adding imported books to your library"),
        )
        .await;
        rescan_library(state).await?;
    }
    *state.libro.status.write().await = ScanStatus {
        items,
        last_checked: Some(unix_now_millis().to_string()),
        error: None,
    };
    Ok(())
}

fn publish(
    candidate: &Candidate,
    source_root: &FsPath,
    library: &FsPath,
    limit: u64,
    reserve: u64,
) -> anyhow::Result<Receipt> {
    let name = sanitize_filename(&candidate.name);
    anyhow::ensure!(
        !name.starts_with('.') && name.len() <= 200,
        "Rename this download to a shorter book title."
    );
    let destination = library.join(&name);
    let receipt = Receipt {
        signature: candidate.signature.clone(),
        destination: name,
        imported_at: unix_now_millis().to_string(),
    };
    if destination.exists() {
        // Recover a publish that succeeded just before a crash or failed receipt write.
        if let Ok(bytes) = std::fs::read(destination.join(MARKER))
            && let Ok(previous) = serde_json::from_slice::<Receipt>(&bytes)
            && previous.signature == receipt.signature
        {
            return Ok(previous);
        }
        anyhow::bail!(
            "A library folder with this name already exists. Review the existing book; nothing was overwritten."
        );
    }
    anyhow::ensure!(
        signature(&candidate.files)? == candidate.signature,
        "The download is still changing. It will be checked again."
    );
    let total = candidate
        .files
        .iter()
        .try_fold(0u64, |total, path| -> anyhow::Result<u64> {
            total
                .checked_add(std::fs::metadata(path)?.len())
                .ok_or_else(|| anyhow::anyhow!("Download is too large."))
        })?;
    anyhow::ensure!(
        total <= limit,
        "This book exceeds the server's upload size limit."
    );
    anyhow::ensure!(
        download_volume_has_capacity(fs2::available_space(library)?, total, reserve),
        "Not enough free space to import this book."
    );
    let staging = tempfile::Builder::new()
        .prefix(UPLOAD_STAGING_PREFIX)
        .tempdir_in(library)?;
    let mut names = HashSet::new();
    for source in &candidate.files {
        let name = source.file_name().unwrap().to_string_lossy();
        anyhow::ensure!(
            names.insert(name.to_lowercase()),
            "Tracks in different subfolders have the same name. Combine and rename them before importing."
        );
        let (mut input, before) = open_contained_file(source, &[source_root.to_path_buf()])?;
        anyhow::ensure!(
            before.len() > 0,
            "A track is empty. Finish downloading before importing."
        );
        let output_path = staging.path().join(name.as_ref());
        let mut output = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&output_path)?;
        let copied = io::copy(
            &mut Read::by_ref(&mut input).take(before.len().saturating_add(1)),
            &mut output,
        )?;
        anyhow::ensure!(
            copied == before.len() && input.metadata()?.modified()? == before.modified()?,
            "A track changed while importing. It will be checked again."
        );
        output.sync_all()?;
        let tagged = read_from_path(&output_path)
            .map_err(|_| anyhow::anyhow!("A track is not readable audio. Download it again."))?;
        anyhow::ensure!(
            !tagged.properties().duration().is_zero(),
            "A track has no readable duration. Download it again."
        );
    }
    // Also detect a new track added to an extracted book during copying.
    let checked = self::candidate(candidate.source.clone())?;
    anyhow::ensure!(
        checked.signature == candidate.signature && checked.issue.is_none(),
        "The download changed during import. It will be checked again."
    );
    let mut marker = std::fs::File::create(staging.path().join(MARKER))?;
    marker.write_all(&serde_json::to_vec(&receipt)?)?;
    marker.sync_all()?;
    anyhow::ensure!(
        !destination.exists(),
        "A library folder with this name already exists."
    );
    std::fs::rename(staging.path(), &destination)?;
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mp3(path: &FsPath) {
        // MPEG-1 Layer III, 128 kbps / 44.1 kHz, empty audio frames.
        let mut frame = vec![0; 417];
        frame[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0x00]);
        std::fs::write(path, frame.repeat(40)).unwrap();
    }

    #[test]
    fn imports_complete_audio_and_recovers_a_publish_without_a_receipt_write() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let library = root.path().join("library");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&library).unwrap();
        let book = source.join("A book");
        std::fs::create_dir(&book).unwrap();
        mp3(&book.join("01.mp3"));
        mp3(&book.join("02.mp3"));
        let candidate = candidate(book.clone()).unwrap();
        let receipt = publish(&candidate, &source, &library, 1_000_000, 0).unwrap();
        assert_eq!(
            std::fs::read(book.join("01.mp3")).unwrap(),
            std::fs::read(library.join("A book/01.mp3")).unwrap()
        );
        assert!(book.join("02.mp3").exists());
        assert_eq!(
            publish(&candidate, &source, &library, 1_000_000, 0)
                .unwrap()
                .imported_at,
            receipt.imported_at
        );
        assert_eq!(std::fs::read_dir(&library).unwrap().count(), 1);
    }

    #[test]
    fn rejects_collisions_changed_downloads_invalid_audio_and_limits_without_publishing() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let library = root.path().join("library");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&library).unwrap();
        let path = source.join("Book.mp3");
        mp3(&path);
        let original = candidate(path.clone()).unwrap();
        assert!(publish(&original, &source, &library, 1, 0).is_err());
        std::fs::create_dir(library.join("Book")).unwrap();
        std::fs::write(library.join("Book/keep.txt"), "existing").unwrap();
        assert!(publish(&original, &source, &library, 1_000_000, 0).is_err());
        assert_eq!(
            std::fs::read_to_string(library.join("Book/keep.txt")).unwrap(),
            "existing"
        );
        let other = source.join("Other.mp3");
        mp3(&other);
        let before = candidate(other.clone()).unwrap();
        std::fs::write(&other, "not audio").unwrap();
        assert!(publish(&before, &source, &library, 1_000_000, 0).is_err());
        assert!(publish(&candidate(other).unwrap(), &source, &library, 1_000_000, 0).is_err());
        assert!(!library.join("Other").exists());
        assert_eq!(
            std::fs::read_dir(&library).unwrap().count(),
            1,
            "staging is cleaned on failure"
        );
    }

    #[test]
    fn download_archives_partial_files_and_mixed_formats_require_review() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("download.zip"), "zip").unwrap();
        assert!(discover(root.path()).unwrap()[0].issue.is_some());
        let book = root.path().join("Book");
        std::fs::create_dir(&book).unwrap();
        mp3(&book.join("01.mp3"));
        std::fs::write(book.join("02.mp3.part"), "incomplete").unwrap();
        assert!(candidate(book.clone()).unwrap().issue.is_some());
        std::fs::remove_file(book.join("02.mp3.part")).unwrap();
        mp3(&book.join("full.m4b"));
        assert!(candidate(book).unwrap().issue.is_some());
    }

    #[test]
    fn watched_folder_cannot_overlap_library_or_data() {
        let root = tempfile::tempdir().unwrap();
        let library = root.path().join("library");
        let data = root.path().join("data");
        std::fs::create_dir(&library).unwrap();
        std::fs::create_dir(&data).unwrap();
        assert!(validate_folder(root.path(), &library, &data).is_err());
        assert!(validate_folder(&library, &library, &data).is_err());
        let nested = library.join("nested");
        std::fs::create_dir(&nested).unwrap();
        assert!(validate_folder(&nested, &library, &data).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_never_imported() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let library = root.path().join("library");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&library).unwrap();
        let path = source.join("Book.mp3");
        mp3(&path);
        let before = candidate(path.clone()).unwrap();
        let outside = root.path().join("outside.mp3");
        std::fs::rename(&path, &outside).unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        assert!(publish(&before, &source, &library, 1_000_000, 0).is_err());
        assert!(discover(&source).unwrap().is_empty());
        assert!(!library.join("Book").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn scan_waits_then_imports_once_and_remembers_deleted_library_copies() {
        let root = tempfile::tempdir().unwrap();
        let (mut state, _) = crate::unit_tests::fake_libation_state(root.path());
        let folder = root.path().join("downloads");
        std::fs::create_dir(&folder).unwrap();
        let source = folder.join("A book.mp3");
        mp3(&source);
        write_json_atomic(
            &settings_path(&state),
            &Settings {
                folder: Some(folder),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let job = create_job(&state, "libro-import").await;
        import_scan(&state, &job).await.unwrap();
        assert_eq!(state.libro.status.read().await.items[0].status, "waiting");
        assert!(!state.library_root.join("A book").exists());
        for observation in state.libro.gate.lock().await.values_mut() {
            observation.1 = Instant::now() - SETTLE_TIME;
        }
        import_scan(&state, &job).await.unwrap();
        assert_eq!(state.libro.status.read().await.items[0].status, "imported");
        assert!(
            state
                .library
                .read()
                .await
                .books
                .iter()
                .any(|b| b.title == "A book")
        );
        import_scan(&state, &job).await.unwrap();
        assert_eq!(load_settings(&state).await.unwrap().imported.len(), 1);
        // A fresh runtime reads durable receipts, including while paused.
        state.libro = Arc::new(LibroImports::default());
        let mut settings = load_settings(&state).await.unwrap();
        let original_folder = settings.folder.take();
        write_json_atomic(&settings_path(&state), &settings)
            .await
            .unwrap();
        assert_eq!(
            read_status(&state).await.unwrap().0.scan.items[0].status,
            "imported"
        );
        settings.folder = original_folder;
        write_json_atomic(&settings_path(&state), &settings)
            .await
            .unwrap();
        std::fs::remove_dir_all(state.library_root.join("A book")).unwrap();
        import_scan(&state, &job).await.unwrap();
        assert_eq!(state.libro.status.read().await.items[0].status, "missing");
        assert!(!state.library_root.join("A book").exists());
        assert!(source.exists());
        std::fs::write(&source, "a changed download").unwrap();
        import_scan(&state, &job).await.unwrap();
        assert_eq!(state.libro.status.read().await.items[0].status, "review");
    }
}
