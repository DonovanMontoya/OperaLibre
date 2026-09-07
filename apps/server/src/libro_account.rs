//! Account-backed Libro.fm acquisition. The wire contract is isolated here:
//! Libro.fm's app endpoints are used by community clients, not a public SDK.
use crate::*;

const API_ROOT: &str = "https://libro.fm/";
const BOOK_SIDECAR: &str = ".libro-book.json";
const MAX_JSON: usize = 8 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct LibroBook {
    pub(crate) isbn: String,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) authors: Vec<String>,
    #[serde(default)]
    pub(crate) cover_url: Option<String>,
    #[serde(default)]
    pub(crate) audiobook_info: LibroBookInfo,
    #[serde(default)]
    pub(crate) description: String,
    #[serde(default)]
    pub(crate) publisher: String,
    #[serde(default)]
    pub(crate) publication_date: String,
    #[serde(default)]
    pub(crate) series: Option<String>,
    #[serde(default)]
    pub(crate) series_num: Option<serde_json::Value>,
    #[serde(default)]
    pub(crate) genres: Vec<LibroGenre>,
}

#[derive(Default, Clone, Serialize, Deserialize)]
pub(crate) struct LibroBookInfo {
    #[serde(default)]
    pub(crate) narrators: Vec<String>,
    #[serde(default)]
    pub(crate) duration: Option<f64>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct LibroGenre {
    pub(crate) name: String,
}

// Never serialize this object into an API response or a log.
#[derive(Serialize, Deserialize)]
struct Account {
    email: String,
    token: String,
    books: Vec<LibroBook>,
    synced_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountStatus {
    connected: bool,
    email: Option<String>,
    synced_at: Option<String>,
    books: Vec<CatalogBook>,
    jobs: Vec<JobStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogBook {
    #[serde(flatten)]
    book: LibroBook,
    local_book_id: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct Login {
    email: String,
    password: String,
}

fn account_path(state: &AppState, user_id: &str) -> PathBuf {
    // User IDs are not filesystem paths, even for imported account databases.
    let key: String = Sha256::digest(user_id.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    state
        .database_path
        .with_file_name("libro-accounts")
        .join(format!("{key}.json"))
}

async fn read_account(state: &AppState, user_id: &str) -> Result<Option<Account>, ApiError> {
    match fs::read(account_path(state, user_id)).await {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

async fn account_guard(state: &AppState, user_id: &str) -> OwnedMutexGuard<()> {
    let lock = {
        let mut gates = state.libro.account_gates.lock().await;
        gates.retain(|_, gate| gate.strong_count() > 0);
        if let Some(lock) = gates.get(user_id).and_then(std::sync::Weak::upgrade) {
            lock
        } else {
            let lock = Arc::new(Mutex::new(()));
            gates.insert(user_id.to_owned(), Arc::downgrade(&lock));
            lock
        }
    };
    lock.lock_owned().await
}

fn valid_isbn(isbn: &str) -> bool {
    (10..=13).contains(&isbn.len()) && isbn.bytes().all(|c| c.is_ascii_digit() || c == b'X')
}

fn destination(book: &LibroBook) -> String {
    // ISBN, not the current marketing title, makes redownloads stable.
    format!("Libro.fm [{}]", book.isbn)
}

async fn local_book(state: &AppState, book: &LibroBook) -> Option<String> {
    let path = state.library_root.join(destination(book));
    state
        .library
        .read()
        .await
        .book_paths
        .iter()
        .find(|(_, p)| **p == path)
        .map(|(id, _)| id.clone())
}

pub(crate) async fn get_libro_account(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<AccountStatus>, ApiError> {
    let account = read_account(&state, &auth.id).await?;
    let mut books = Vec::new();
    let paths: HashMap<PathBuf, String> = state
        .library
        .read()
        .await
        .book_paths
        .iter()
        .map(|(id, path)| (path.clone(), id.clone()))
        .collect();
    if let Some(account) = &account {
        for book in &account.books {
            let id = paths
                .get(&state.library_root.join(destination(book)))
                .cloned()
                .filter(|id| {
                    auth.allowed_book_ids
                        .as_ref()
                        .is_none_or(|ids| ids.contains(id))
                });
            books.push(CatalogBook {
                book: book.clone(),
                local_book_id: id,
            });
        }
    }
    let prefix = format!("libro:{}:", auth.id);
    let mut jobs: Vec<_> = state
        .jobs
        .read()
        .await
        .values()
        .filter(|job| {
            job.target_id
                .as_ref()
                .is_some_and(|id| id.starts_with(&prefix))
        })
        .map(job_for_list)
        .collect();
    jobs.sort_by_key(|j| std::cmp::Reverse(job_started_timestamp(j)));
    jobs.truncate(30);
    Ok(Json(AccountStatus {
        connected: account.is_some(),
        email: account.as_ref().map(|a| a.email.clone()),
        synced_at: account.and_then(|a| a.synced_at),
        books,
        jobs,
    }))
}

struct Api {
    root: String,
    client: reqwest::Client,
}

impl Api {
    fn new() -> Result<Self, ApiError> {
        // Libro.fm's app API requires these compatibility headers, including at
        // token issuance. Keep them off the separate signed-media client.
        // See librofm-downloader fixes #287 and #292.
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            "x-librofm-appver",
            reqwest::header::HeaderValue::from_static("7.34.8"),
        );
        headers.insert(
            reqwest::header::ACCEPT,
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        let client = reqwest::Client::builder()
            .default_headers(headers)
            .user_agent("okhttp/5.3.2")
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| ApiError::internal("Could not initialize Libro.fm connection."))?;
        Ok(Self {
            root: API_ROOT.into(),
            client,
        })
    }

    async fn json(&self, token: &str, path: &str) -> Result<serde_json::Value, ApiError> {
        let response = self
            .client
            .get(format!("{}{path}", self.root))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| ApiError::bad_gateway("Could not reach Libro.fm. Try again."))?;
        decode_response(response).await
    }

    async fn library(&self, token: &str) -> Result<Vec<LibroBook>, ApiError> {
        let mut books = Vec::new();
        let mut seen = HashSet::new();
        let mut bytes = 0usize;
        for page in 1..=200 {
            let value = self
                .json(token, &format!("api/v10/library?page={page}"))
                .await?;
            bytes = bytes.saturating_add(value.to_string().len());
            if bytes > 32 * 1024 * 1024 {
                return Err(ApiError::bad_gateway(
                    "This Libro.fm catalog exceeds the supported metadata size.",
                ));
            }
            let pages = value["total_pages"].as_u64().ok_or_else(|| {
                ApiError::bad_gateway("Libro.fm returned an unexpected library response.")
            })?;
            if pages > 200 {
                return Err(ApiError::bad_gateway(
                    "This Libro.fm library exceeds the supported page limit.",
                ));
            }
            let batch: Vec<LibroBook> = serde_json::from_value(value["audiobooks"].clone())
                .map_err(|_| {
                    ApiError::bad_gateway("Libro.fm returned an unexpected book record.")
                })?;
            for book in batch {
                if !valid_isbn(&book.isbn) {
                    return Err(ApiError::bad_gateway(
                        "Libro.fm returned an invalid book identifier.",
                    ));
                }
                if seen.insert(book.isbn.clone()) {
                    books.push(book);
                }
            }
            if books.len() > 20_000 {
                return Err(ApiError::bad_gateway(
                    "This Libro.fm library is too large to load.",
                ));
            }
            if page >= pages {
                return Ok(books);
            }
        }
        Err(ApiError::bad_gateway(
            "Could not finish loading the Libro.fm library.",
        ))
    }
}

async fn decode_response(mut response: reqwest::Response) -> Result<serde_json::Value, ApiError> {
    match response.status().as_u16() {
        401 | 403 => {
            return Err(ApiError::bad_request(
                "Libro.fm could not authorize this request. Reconnect your account.",
            ));
        }
        429 => {
            return Err(ApiError::too_many_requests(
                "Libro.fm is limiting requests. Wait a few minutes before trying again.",
            ));
        }
        200..=299 => {}
        _ => {
            return Err(ApiError::bad_gateway(
                "Libro.fm could not complete this request. Try again later.",
            ));
        }
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ApiError::bad_gateway("The Libro.fm response was interrupted."))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_JSON {
            return Err(ApiError::bad_gateway("Libro.fm returned too much data."));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::bad_gateway("Libro.fm returned an unreadable response."))
}

pub(crate) async fn connect_libro_account(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Json(login): Json<Login>,
) -> Result<Json<JobCreated>, ApiError> {
    if login.email.trim().is_empty()
        || login.email.len() > 320
        || login.password.is_empty()
        || login.password.len() > 1024
    {
        return Err(ApiError::bad_request(
            "Enter your Libro.fm email and password.",
        ));
    }
    let guard = account_guard(&state, &auth.id).await;
    let api = Api::new()?;
    let response = api.client.post(format!("{}oauth/token", api.root))
        .json(&serde_json::json!({"grant_type":"password","username":login.email.trim(),"password":login.password}))
        .send().await.map_err(|_| ApiError::bad_gateway("Could not reach Libro.fm to sign in."))?;
    let value = decode_response(response).await?;
    let token = value["access_token"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() < 16_384)
        .ok_or_else(|| {
            ApiError::bad_request(
                "Libro.fm did not provide a sign-in token. Check your credentials.",
            )
        })?;
    let account = Account {
        email: login.email.trim().to_owned(),
        token: token.into(),
        books: Vec::new(),
        synced_at: None,
    };
    write_json_atomic(&account_path(&state, &auth.id), &account).await?;
    drop(guard);
    refresh_libro_account(State(state), Extension(auth)).await
}

pub(crate) async fn disconnect_libro_account(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<StatusCode, ApiError> {
    let _guard = account_guard(&state, &auth.id).await;
    match fs::remove_file(account_path(&state, &auth.id)).await {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn refresh_libro_account(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<JobCreated>, ApiError> {
    if read_account(&state, &auth.id).await?.is_none() {
        return Err(ApiError::bad_request(
            "Connect your Libro.fm account first.",
        ));
    }
    let (id, created) = create_queued_job(
        &state,
        "libro-refresh",
        Some(format!("libro:{}:refresh", auth.id)),
    )
    .await;
    if created {
        let job = id.clone();
        tokio::spawn(run_job(state.clone(), id.clone(), async move {
            update_job_running(&state, &job).await;
            let result = async {
                let _guard = account_guard(&state, &auth.id).await;
                let mut account = read_account(&state, &auth.id)
                    .await?
                    .ok_or_else(|| ApiError::bad_request("Account disconnected."))?;
                update_job_progress(
                    &state,
                    &job,
                    JobProgress::new("Loading your Libro.fm library"),
                )
                .await;
                account.books = Api::new()?.library(&account.token).await?;
                account.synced_at = Some(unix_now_millis().to_string());
                write_json_atomic(&account_path(&state, &auth.id), &account).await
            }
            .await;
            finish(&state, &job, result).await;
        }));
    }
    Ok(Json(JobCreated { job_id: id }))
}

async fn finish(state: &AppState, job: &str, result: Result<(), ApiError>) {
    let error = result.err().map(|e| {
        if e.status == StatusCode::INTERNAL_SERVER_ERROR {
            "The import could not finish. Check server storage and retry.".into()
        } else {
            e.message
        }
    });
    update_job_finished(
        state,
        job,
        if error.is_some() {
            "failed"
        } else {
            "completed"
        },
        None,
        error,
    )
    .await;
}

pub(crate) async fn import_libro_purchase(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(isbn): Path<String>,
) -> Result<Json<JobCreated>, ApiError> {
    let _guard = account_guard(&state, &auth.id).await;
    let account = read_account(&state, &auth.id)
        .await?
        .ok_or_else(|| ApiError::bad_request("Connect your Libro.fm account first."))?;
    let book = account
        .books
        .iter()
        .find(|book| book.isbn == isbn)
        .cloned()
        .ok_or_else(|| {
            ApiError::not_found(
                "This book is not in your connected Libro.fm library. Refresh the library first.",
            )
        })?;
    let prefix = format!("libro:{}:", auth.id);
    let target = format!("{prefix}{isbn}");
    {
        let jobs = state.jobs.read().await;
        let active: Vec<_> = jobs
            .values()
            .filter(|j| {
                j.kind == "libro-download"
                    && is_active_job(j)
                    && j.target_id
                        .as_ref()
                        .is_some_and(|id| id.starts_with(&prefix))
            })
            .collect();
        if let Some(existing) = active
            .iter()
            .find(|j| j.target_id.as_ref() == Some(&target))
        {
            return Ok(Json(JobCreated {
                job_id: existing.id.clone(),
            }));
        }
        if active.len() >= 3 {
            return Err(ApiError::too_many_requests(
                "Wait for one of your queued Libro.fm imports to finish.",
            ));
        }
    }
    let (id, created) = create_queued_job(&state, "libro-download", Some(target)).await;
    drop(_guard);
    if created {
        let job = id.clone();
        tokio::spawn(run_job(state.clone(), id.clone(), async move {
            let _slot = state.upload_lock.lock().await;
            update_job_running(&state, &job).await;
            let result = acquire_book(&state, &auth.id, &account.token, &book, &job).await;
            finish(&state, &job, result).await;
        }));
    }
    Ok(Json(JobCreated { job_id: id }))
}

fn download_url(raw: &str) -> Result<reqwest::Url, ApiError> {
    let url = reqwest::Url::parse(raw)
        .map_err(|_| ApiError::bad_gateway("Libro.fm returned an invalid download address."))?;
    let host = url.host_str().unwrap_or_default();
    let allowed = host == "libro.fm"
        || host.ends_with(".libro.fm")
        || host.ends_with(".amazonaws.com")
        || host.ends_with(".cloudfront.net");
    if url.scheme() != "https"
        || !allowed
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|p| p != 443)
    {
        return Err(ApiError::bad_gateway(
            "Libro.fm returned an unsupported download host.",
        ));
    }
    Ok(url)
}

async fn download(
    raw: &str,
    destination: &FsPath,
    remaining: &mut u64,
    reserve: u64,
    state: &AppState,
    job: &str,
) -> Result<(), ApiError> {
    let mut url = download_url(raw)?;
    let mut response = None;
    for _ in 0..5 {
        let host = url.host_str().unwrap();
        let addresses: Vec<_> = tokio::time::timeout(
            Duration::from_secs(10),
            tokio::net::lookup_host((host, 443)),
        )
        .await
        .map_err(|_| ApiError::bad_gateway("Download address lookup timed out."))?
        .map_err(|_| ApiError::bad_gateway("Could not look up the download address."))?
        .filter(|address| public_download_ip(address.ip()))
        .collect();
        if addresses.is_empty() {
            return Err(ApiError::bad_gateway(
                "The download address is not on the public internet.",
            ));
        }
        // Pin validated DNS answers on every redirect; URLs never carry our bearer token.
        let client = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(3600))
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(host, &addresses)
            .build()
            .map_err(|_| ApiError::internal("Could not initialize download."))?;
        let current =
            client.get(url.clone()).send().await.map_err(|_| {
                ApiError::bad_gateway("The Libro.fm download could not be reached.")
            })?;
        if current.status().is_redirection() {
            let location = current
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or_else(|| ApiError::bad_gateway("Invalid download redirect."))?;
            let next = url
                .join(location)
                .map_err(|_| ApiError::bad_gateway("Invalid download redirect."))?;
            url = download_url(next.as_str())?;
        } else {
            response = Some(current);
            break;
        }
    }
    let mut response =
        response.ok_or_else(|| ApiError::bad_gateway("Too many download redirects."))?;
    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(
            "Libro.fm could not download this file. Refresh your library and try again.",
        ));
    }
    let length = response.content_length();
    if length.is_some_and(|n| n > *remaining) {
        return Err(ApiError::bad_request(
            "This book exceeds the server's import size limit.",
        ));
    }
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .await?;
    let mut downloaded = 0u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ApiError::bad_gateway("Download interrupted. You can retry this import."))?
    {
        if chunk.len() as u64 > *remaining {
            return Err(ApiError::bad_request(
                "This book exceeds the server's import size limit.",
            ));
        }
        if !download_volume_has_capacity(
            fs2::available_space(&state.library_root)?,
            chunk.len() as u64,
            reserve,
        ) {
            return Err(ApiError::bad_request(
                "Not enough free space to import this book.",
            ));
        }
        output.write_all(&chunk).await?;
        *remaining -= chunk.len() as u64;
        downloaded += chunk.len() as u64;
        if downloaded % (1024 * 1024) < chunk.len() as u64 {
            let mut progress =
                JobProgress::new(format!("Downloading · {} MiB", downloaded / (1024 * 1024)));
            if let Some(total) = length.filter(|n| *n > 0) {
                progress = progress.fraction(downloaded as f64 / total as f64);
            }
            update_job_progress(state, job, progress).await;
        }
    }
    if downloaded == 0 || length.is_some_and(|n| n != downloaded) {
        return Err(ApiError::bad_gateway(
            "The download was incomplete. Try again.",
        ));
    }
    output.sync_all().await?;
    Ok(())
}

fn public_download_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, _, _] = ip.octets();
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_documentation()
                && a != 0
                && a < 224
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 198 && (18..=19).contains(&b))
                && !(a == 192 && b == 0)
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return public_download_ip(IpAddr::V4(v4));
            }
            let s = ip.segments();
            s[0] & 0xe000 == 0x2000 && !(s[0] == 0x2001 && s[1] == 0x0db8)
        }
    }
}

fn extract_mp3(archive: &FsPath, directory: &FsPath, remaining: &mut u64) -> anyhow::Result<()> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(archive)?)?;
    anyhow::ensure!(
        zip.len() <= MAX_UPLOAD_FILES,
        "Too many entries in the downloaded archive."
    );
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        let path = entry
            .enclosed_name()
            .ok_or_else(|| anyhow::anyhow!("Unsafe path in downloaded archive."))?;
        anyhow::ensure!(
            entry.unix_mode().is_none_or(|m| m & 0o170000 != 0o120000),
            "Symbolic links are not permitted in downloaded archives."
        );
        if entry.is_dir()
            || !path
                .extension()
                .is_some_and(|s| s.eq_ignore_ascii_case("mp3"))
        {
            continue;
        }
        let output = directory.join(
            path.file_name()
                .ok_or_else(|| anyhow::anyhow!("Invalid track filename."))?,
        );
        anyhow::ensure!(
            entry.size() <= *remaining,
            "Extracted audio exceeds the import size limit."
        );
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(output)?;
        let copied = io::copy(
            &mut Read::by_ref(&mut entry).take(remaining.saturating_add(1)),
            &mut file,
        )?;
        anyhow::ensure!(
            copied > 0 && copied <= *remaining && copied == entry.size(),
            "Incomplete or oversized track in downloaded archive."
        );
        *remaining -= copied;
        file.sync_all()?;
    }
    Ok(())
}

async fn acquire_book(
    state: &AppState,
    user_id: &str,
    token: &str,
    book: &LibroBook,
    job: &str,
) -> Result<(), ApiError> {
    let destination = state.library_root.join(destination(book));
    fs::create_dir_all(&state.library_root).await?;
    if fs::try_exists(&destination).await? {
        let existing = fs::read(destination.join(BOOK_SIDECAR))
            .await
            .ok()
            .and_then(|b| serde_json::from_slice::<LibroBook>(&b).ok());
        if !existing.is_some_and(|b| b.isbn == book.isbn) {
            return Err(ApiError::conflict(
                "An existing library folder conflicts with this import. Nothing was overwritten.",
            ));
        }
    } else {
        let staging = tempfile::Builder::new()
            .prefix(UPLOAD_STAGING_PREFIX)
            .tempdir_in(&state.library_root)?;
        let api = Api::new()?;
        update_job_progress(
            state,
            job,
            JobProgress::new("Preparing your Libro.fm download"),
        )
        .await;
        let response = api
            .client
            .get(format!(
                "{}api/v10/audiobooks/{}/packaged_m4b",
                api.root, book.isbn
            ))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| ApiError::bad_gateway("Could not prepare the Libro.fm download."))?;
        let m4b = if response.status().is_success() {
            decode_response(response).await?["m4b_url"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        } else if response.status().as_u16() == 404 {
            None
        } else {
            decode_response(response).await?;
            None
        };
        let limit = state.max_upload_bytes.unwrap_or(u64::MAX);
        let mut remaining = limit;
        if let Some(url) = m4b {
            download(
                &url,
                &staging.path().join("book.m4b"),
                &mut remaining,
                state.min_download_free_bytes,
                state,
                job,
            )
            .await?;
        } else {
            let manifest = api
                .json(
                    token,
                    &format!("api/v10/download-manifest?isbn={}", book.isbn),
                )
                .await?;
            let parts = manifest["parts"]
                .as_array()
                .filter(|a| !a.is_empty() && a.len() <= 100)
                .ok_or_else(|| {
                    ApiError::bad_gateway("Libro.fm did not provide downloadable audio.")
                })?;
            let mut extracted_remaining = limit;
            for (index, part) in parts.iter().enumerate() {
                let url = part["url"].as_str().ok_or_else(|| {
                    ApiError::bad_gateway("Libro.fm returned an invalid download manifest.")
                })?;
                update_job_progress(
                    state,
                    job,
                    JobProgress::new(format!(
                        "Downloading MP3 part {} of {}",
                        index + 1,
                        parts.len()
                    )),
                )
                .await;
                let archive = staging.path().join(format!("part-{index}.zip"));
                download(
                    url,
                    &archive,
                    &mut remaining,
                    state.min_download_free_bytes,
                    state,
                    job,
                )
                .await?;
                let directory = staging.path().to_path_buf();
                let zip_path = archive.clone();
                let available = fs2::available_space(&state.library_root)?
                    .saturating_sub(state.min_download_free_bytes);
                let budget = extracted_remaining.min(available);
                let used = tokio::task::spawn_blocking(move || {
                    let mut remaining = budget;
                    extract_mp3(&zip_path, &directory, &mut remaining)?;
                    Ok::<_, anyhow::Error>(budget - remaining)
                })
                .await
                .map_err(|_| ApiError::internal("Archive extraction stopped."))??;
                extracted_remaining -= used;
                fs::remove_file(archive).await?;
            }
        }
        update_job_progress(state, job, JobProgress::new("Checking downloaded audio")).await;
        let directory = staging.path().to_path_buf();
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let mut count = 0;
            for entry in std::fs::read_dir(directory)? {
                let path = entry?.path();
                if is_supported_audio_file(&path) {
                    count += 1;
                    anyhow::ensure!(
                        !read_from_path(&path)?.properties().duration().is_zero(),
                        "Downloaded audio has no readable duration."
                    );
                }
            }
            anyhow::ensure!(
                count > 0 && count <= MAX_UPLOAD_FILES,
                "Download did not contain a complete audiobook."
            );
            Ok(())
        })
        .await
        .map_err(|_| ApiError::internal("Audio validation stopped."))??;
        write_json_atomic(&staging.path().join(BOOK_SIDECAR), book).await?;
        if fs::try_exists(&destination).await? {
            return Err(ApiError::conflict(
                "A library folder appeared during import. Nothing was overwritten.",
            ));
        }
        fs::rename(staging.path(), &destination).await?;
    }
    update_job_progress(
        state,
        job,
        JobProgress::new("Adding the book to your library"),
    )
    .await;
    rescan_library(state).await?;
    let book_id = local_book(state, book).await.ok_or_else(|| {
        ApiError::internal("The imported book could not be indexed. Retry the import.")
    })?;
    grant_user_book_access(state, user_id, &book_id).await?;
    Ok(())
}

pub(crate) fn libro_metadata_for_group(path: &FsPath) -> Option<LibroBook> {
    let sidecar = path.join(BOOK_SIDECAR);
    let (file, metadata) = open_contained_file(&sidecar, &[path.to_path_buf()]).ok()?;
    if metadata.len() > MAX_JSON as u64 {
        return None;
    }
    serde_json::from_reader(file.take(MAX_JSON as u64)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book(isbn: &str) -> LibroBook {
        serde_json::from_value(serde_json::json!({"isbn":isbn,"title":"A Libro.fm book", "authors":["An Author"], "audiobook_info":{"narrators":["A Narrator"],"duration":120}})).unwrap()
    }

    #[tokio::test]
    async fn loads_every_library_page_and_deduplicates_isbns() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new().route(
            "/api/v10/library",
            get(
                |headers: HeaderMap, Query(params): Query<HashMap<String, String>>| async move {
                    assert_eq!(headers.get(AUTHORIZATION).unwrap(), "Bearer fixture-token");
                    assert_eq!(headers.get("x-librofm-appver").unwrap(), "7.34.8");
                    assert_eq!(headers.get("user-agent").unwrap(), "okhttp/5.3.2");
                    let books = if params["page"] == "1" {
                        vec![book("9780000000001")]
                    } else {
                        vec![book("9780000000001"), book("9780000000002")]
                    };
                    Json(serde_json::json!({"total_pages":2,"audiobooks":books}))
                },
            ),
        );
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut api = Api::new().unwrap();
        api.root = format!("http://{address}/");
        let books = api.library("fixture-token").await.unwrap();
        task.abort();
        assert_eq!(books.len(), 2);
        assert_eq!(books[1].isbn, "9780000000002");
    }

    #[tokio::test]
    async fn login_client_sends_required_headers_and_empty_library_is_valid() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new()
            .route(
                "/oauth/token",
                post(
                    |headers: HeaderMap, Json(body): Json<serde_json::Value>| async move {
                        assert_eq!(headers.get("x-librofm-appver").unwrap(), "7.34.8");
                        assert_eq!(headers.get("user-agent").unwrap(), "okhttp/5.3.2");
                        assert!(!headers.contains_key(AUTHORIZATION));
                        assert_eq!(body["grant_type"], "password");
                        Json(serde_json::json!({"access_token":"fixture-token"}))
                    },
                ),
            )
            .route(
                "/api/v10/library",
                get(|| async { Json(serde_json::json!({"total_pages":0,"audiobooks":[]})) }),
            );
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut api = Api::new().unwrap();
        api.root = format!("http://{address}/");
        let response = api.client.post(format!("{}oauth/token", api.root))
            .json(&serde_json::json!({"grant_type":"password","username":"fixture@example.test","password":"fixture-password"}))
            .send().await.unwrap();
        let token = decode_response(response).await.unwrap();
        assert!(
            api.library(token["access_token"].as_str().unwrap())
                .await
                .unwrap()
                .is_empty()
        );
        task.abort();
    }

    #[tokio::test]
    async fn remote_authentication_errors_do_not_expose_response_bodies() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new().route(
            "/api/v10/library",
            get(|| async { (StatusCode::UNAUTHORIZED, "sensitive upstream response") }),
        );
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let api = Api {
            root: format!("http://{address}/"),
            client: reqwest::Client::new(),
        };
        let result = api.library("fixture-token").await;
        task.abort();
        let error = result.err().unwrap();
        assert!(error.message.contains("Reconnect"));
        assert!(!error.message.contains("sensitive"));
    }

    #[test]
    fn downloads_allow_only_https_provider_hosts_and_public_addresses() {
        assert!(download_url("https://books.s3.amazonaws.com/book.m4b?signature=example").is_ok());
        for url in [
            "http://libro.fm/file",
            "https://localhost/file",
            "https://127.0.0.1/file",
            "https://libro.fm.evil.example/file",
            "https://name:password@libro.fm/file",
            "https://libro.fm:8000/file",
        ] {
            assert!(download_url(url).is_err(), "{url}");
        }
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "::1",
            "fc00::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(!public_download_ip(ip.parse().unwrap()), "{ip}");
        }
        assert!(public_download_ip("8.8.8.8".parse().unwrap()));
    }

    fn archive(path: &FsPath, entries: &[(&str, &[u8])]) {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        for (name, content) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(content).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn archives_reject_traversal_overwrites_and_expansion_beyond_limits() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("audio");
        std::fs::create_dir(&output).unwrap();
        let zip = root.path().join("download.zip");
        archive(&zip, &[("../outside.mp3", b"bad")]);
        assert!(extract_mp3(&zip, &output, &mut 100).is_err());
        assert!(!root.path().join("outside.mp3").exists());
        archive(&zip, &[("01.mp3", b"track")]);
        assert!(extract_mp3(&zip, &output, &mut 2).is_err());
        let mut budget = 100;
        extract_mp3(&zip, &output, &mut budget).unwrap();
        assert_eq!(budget, 95);
        assert!(extract_mp3(&zip, &output, &mut 100).is_err());
        assert_eq!(std::fs::read(output.join("01.mp3")).unwrap(), b"track");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn account_status_is_private_and_never_returns_the_token() {
        let root = tempfile::tempdir().unwrap();
        let (state, _) = crate::unit_tests::fake_libation_state(root.path());
        let user = AuthUser {
            id: "one".into(),
            username: "one".into(),
            is_admin: false,
            is_owner: false,
            allowed_book_ids: None,
            libation_access: LibationAccess::Approval,
            can_approve_libation_requests: false,
            share_progress: false,
            announce_finishes: false,
            notify_finishes: false,
        };
        let stored = Account {
            email: "one@example.test".into(),
            token: "private-fixture-token".into(),
            books: vec![book("9780000000001")],
            synced_at: None,
        };
        write_json_atomic(&account_path(&state, &user.id), &stored)
            .await
            .unwrap();
        let response = get_libro_account(State(state.clone()), Extension(user.clone()))
            .await
            .unwrap()
            .0;
        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("9780000000001"));
        assert!(!json.contains("private-fixture-token"));
        let other = AuthUser {
            id: "two".into(),
            ..user.clone()
        };
        let response = get_libro_account(State(state.clone()), Extension(other))
            .await
            .unwrap()
            .0;
        assert!(!response.connected);
        assert!(response.books.is_empty());
        let result = import_libro_purchase(
            State(state.clone()),
            Extension(user.clone()),
            Path("9780000000099".into()),
        )
        .await;
        assert_eq!(result.unwrap_err().status, StatusCode::NOT_FOUND);
        disconnect_libro_account(State(state.clone()), Extension(user))
            .await
            .unwrap();
        assert!(!account_path(&state, "one").exists());
    }
}
