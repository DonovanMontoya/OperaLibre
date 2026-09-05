use anyhow::{Context, anyhow, bail};
use reqwest::Client;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{fs, process::Command, sync::Mutex};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

const RELEASE_API_URL: &str =
    "https://api.github.com/repos/DonovanMontoya/OperaLibre/releases/latest";
const RELEASE_DOWNLOAD_PREFIX: &str =
    "https://github.com/DonovanMontoya/OperaLibre/releases/download/";
const RELEASE_PAGE_PREFIX: &str = "https://github.com/DonovanMontoya/OperaLibre/releases/";
const MAX_UPDATE_PACKAGE_BYTES: u64 = 250 * 1024 * 1024;
const MAX_FRONTEND_PACKAGE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_UPDATE_EXTRACTED_BYTES: u64 = 750 * 1024 * 1024;
const UPDATE_CACHE_TTL: Duration = Duration::from_secs(15 * 60);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;

#[derive(Clone)]
pub struct UpdateManager {
    data_dir: PathBuf,
    web_dist_dir: Option<PathBuf>,
    port: u16,
    client: Client,
    cache: Arc<Mutex<Option<CachedUpdateStatus>>>,
    frontend_cache: Arc<Mutex<Option<CachedFrontendUpdateStatus>>>,
    installing: Arc<AtomicBool>,
}

/// Holds the `installing` flag for the length of one install and releases it
/// unless the install is `keep`-ed.
///
/// The flag has to be cleared even if the install future is never polled to
/// completion -- a dropped future would otherwise leave it set and every later
/// install refused as already in progress until the process restarts. `Drop`
/// runs on cancellation, where code after an `.await` does not.
struct InstallGuard {
    installing: Arc<AtomicBool>,
    release: bool,
}

impl InstallGuard {
    /// Claims the flag, or returns `None` if an install is already running.
    fn acquire(installing: &Arc<AtomicBool>) -> Option<Self> {
        if installing.swap(true, Ordering::SeqCst) {
            return None;
        }
        Some(Self {
            installing: Arc::clone(installing),
            release: true,
        })
    }

    /// Leaves the flag set: a staged backend update keeps it held so nothing
    /// else installs over it while the restart is pending.
    fn keep(mut self) {
        self.release = false;
    }
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        if self.release {
            self.installing.store(false, Ordering::SeqCst);
        }
    }
}

struct CachedUpdateStatus {
    checked_at: Instant,
    status: UpdateStatus,
}

struct CachedFrontendUpdateStatus {
    checked_at: Instant,
    reported_current_version: Option<String>,
    status: FrontendUpdateStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub can_auto_update: bool,
    pub platform: Option<String>,
    pub release_url: String,
    pub published_at: Option<String>,
    pub notes: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallStarted {
    pub version: String,
    pub restarting: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendUpdateStatus {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub can_auto_update: bool,
    pub release_url: String,
    pub published_at: Option<String>,
    pub notes: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    published_at: Option<String>,
    body: Option<String>,
    assets: Vec<GithubReleaseAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubReleaseAsset {
    name: String,
    browser_download_url: String,
    size: u64,
    digest: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstallLayout {
    Combined,
    ServerOnly,
}

impl InstallLayout {
    fn as_updater_arg(self) -> &'static str {
        match self {
            InstallLayout::Combined => "combined",
            InstallLayout::ServerOnly => "server-only",
        }
    }
}

struct ManagedInstall {
    root: PathBuf,
    layout: InstallLayout,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdatePackageMetadata {
    schema_version: u32,
    version: String,
    platform: String,
}

impl UpdateManager {
    pub fn new(
        data_dir: PathBuf,
        web_dist_dir: Option<PathBuf>,
        port: u16,
    ) -> anyhow::Result<Self> {
        let client = Client::builder()
            .user_agent(format!("OperaLibre/{}", current_version()))
            .connect_timeout(Duration::from_secs(10))
            .build()?;
        Ok(Self {
            data_dir,
            web_dist_dir,
            port,
            client,
            cache: Arc::new(Mutex::new(None)),
            frontend_cache: Arc::new(Mutex::new(None)),
            installing: Arc::new(AtomicBool::new(false)),
        })
    }

    pub async fn check(&self, force: bool) -> anyhow::Result<UpdateStatus> {
        if !force {
            let cache = self.cache.lock().await;
            if let Some(cached) = cache.as_ref()
                && cached.checked_at.elapsed() < UPDATE_CACHE_TTL
            {
                return Ok(cached.status.clone());
            }
        }

        let release = self.fetch_latest_release().await?;
        let status = self.status_for_release(&release)?;
        *self.cache.lock().await = Some(CachedUpdateStatus {
            checked_at: Instant::now(),
            status: status.clone(),
        });
        Ok(status)
    }

    pub async fn install(&self) -> anyhow::Result<UpdateInstallStarted> {
        let Some(guard) = InstallGuard::acquire(&self.installing) else {
            bail!("An OperaLibre update is already being installed.");
        };
        let result = self.install_inner().await;
        if result.is_ok() {
            // A staged backend update restarts the process; hold the flag so
            // nothing installs over it in the meantime.
            guard.keep();
        }
        result
    }

    pub async fn check_frontend(
        &self,
        force: bool,
        reported_current_version: Option<&str>,
    ) -> anyhow::Result<FrontendUpdateStatus> {
        let reported_current_version = reported_current_version.map(normalize_version);
        if !force {
            let cache = self.frontend_cache.lock().await;
            if let Some(cached) = cache.as_ref()
                && cached.checked_at.elapsed() < UPDATE_CACHE_TTL
                && cached.reported_current_version == reported_current_version
            {
                return Ok(cached.status.clone());
            }
        }

        let release = self.fetch_latest_release().await?;
        let status =
            self.frontend_status_for_release(&release, reported_current_version.as_deref())?;
        *self.frontend_cache.lock().await = Some(CachedFrontendUpdateStatus {
            checked_at: Instant::now(),
            reported_current_version,
            status: status.clone(),
        });
        Ok(status)
    }

    pub async fn install_frontend(&self) -> anyhow::Result<UpdateInstallStarted> {
        let Some(_guard) = InstallGuard::acquire(&self.installing) else {
            bail!("An OperaLibre update is already being installed.");
        };
        self.install_frontend_inner().await
    }

    async fn install_inner(&self) -> anyhow::Result<UpdateInstallStarted> {
        let release = self.fetch_latest_release().await?;
        let status = self.status_for_release(&release)?;
        if !status.update_available {
            bail!("OperaLibre is already up to date.");
        }
        if !status.can_auto_update {
            bail!(
                "{}",
                status
                    .message
                    .unwrap_or_else(|| "This installation must be updated manually.".to_string())
            );
        }
        let platform = status
            .platform
            .as_deref()
            .ok_or_else(|| anyhow!("This server platform does not have an update package."))?;
        let (asset, expected_digest) =
            validated_update_asset(&release, &status.latest_version, platform)?;

        let install = managed_install(self.web_dist_dir.as_deref())?;
        // Probe afresh here: the cached answer a status check gave may be
        // hours old, and this is the moment a stale one would hurt.
        ensure_install_root_is_writable(&install.root)?;
        let updates_dir = self.data_dir.join("updates");
        let staging_dir = updates_dir.join(format!("staging-{}-{platform}", status.latest_version));
        prune_stale_staging(&updates_dir, &staging_dir).await;
        reset_dir(&staging_dir).await?;

        let archive_path = self
            .download_verified_asset(
                asset,
                expected_digest,
                &staging_dir,
                MAX_UPDATE_PACKAGE_BYTES,
            )
            .await?;

        let extract_dir = staging_dir.join("extracted");
        extract_zip(archive_path, extract_dir.clone()).await?;
        let package_root = extract_dir.join(format!(
            "operalibre-{}-update-{platform}",
            status.latest_version
        ));
        validate_update_package(&package_root, &status.latest_version, platform).await?;
        make_package_executables(&package_root).await?;

        let updater_path = package_root.join(exe_name("operalibre-updater"));
        let log_path = self.data_dir.join("update.log");
        let stdout = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .with_context(|| format!("Could not open {}", log_path.display()))?;
        let stderr = stdout.try_clone()?;
        let mut command = Command::new(&updater_path);
        command
            .arg("--apply-update")
            .arg(&package_root)
            .arg("--install-root")
            .arg(&install.root)
            .arg("--layout")
            .arg(install.layout.as_updater_arg())
            .arg("--server-pid")
            .arg(std::process::id().to_string())
            .arg("--port")
            .arg(self.port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
        command
            .spawn()
            .with_context(|| format!("Could not start {}", updater_path.display()))?;

        Ok(UpdateInstallStarted {
            version: status.latest_version,
            restarting: true,
        })
    }

    async fn install_frontend_inner(&self) -> anyhow::Result<UpdateInstallStarted> {
        let release = self.fetch_latest_release().await?;
        let status = self.frontend_status_for_release(&release, None)?;
        if !status.update_available {
            bail!("The web frontend is already up to date.");
        }
        if !status.can_auto_update {
            bail!(
                "{}",
                status.message.unwrap_or_else(|| {
                    "This web frontend installation must be updated manually.".to_string()
                })
            );
        }
        let (asset, expected_digest) = validated_frontend_asset(&release, &status.latest_version)?;
        let web_dist_dir = managed_frontend_dir(self.web_dist_dir.as_deref())?;
        let updates_dir = self.data_dir.join("updates");
        let staging_dir = updates_dir.join(format!("frontend-staging-{}", status.latest_version));
        prune_stale_staging(&updates_dir, &staging_dir).await;
        reset_dir(&staging_dir).await?;

        let archive_path = self
            .download_verified_asset(
                asset,
                expected_digest,
                &staging_dir,
                MAX_FRONTEND_PACKAGE_BYTES,
            )
            .await?;
        let extract_dir = staging_dir.join("extracted");
        extract_zip(archive_path, extract_dir.clone()).await?;
        let package_root =
            extract_dir.join(format!("operalibre-{}-frontend", status.latest_version));
        validate_frontend_package(&package_root, &status.latest_version).await?;
        fs::write(
            package_root.join("web/VERSION.txt"),
            format!("{}\n", status.latest_version),
        )
        .await?;
        install_frontend_files(
            package_root.join("web"),
            web_dist_dir,
            self.data_dir.clone(),
        )
        .await?;
        *self.frontend_cache.lock().await = None;

        Ok(UpdateInstallStarted {
            version: status.latest_version,
            restarting: false,
        })
    }

    async fn download_verified_asset(
        &self,
        asset: &GithubReleaseAsset,
        expected_digest: &str,
        staging_dir: &Path,
        maximum_bytes: u64,
    ) -> anyhow::Result<PathBuf> {
        let mut response = self
            .client
            .get(&asset.browser_download_url)
            .timeout(Duration::from_secs(10 * 60))
            .send()
            .await?
            .error_for_status()?;
        if response
            .content_length()
            .is_some_and(|content_length| content_length != asset.size)
        {
            bail!("The downloaded update package size did not match the release metadata.");
        }

        let archive_path = staging_dir.join("update.zip");
        let mut archive = fs::File::create(&archive_path).await?;
        let mut digest = Sha256::new();
        let mut downloaded = 0_u64;
        while let Some(chunk) = response.chunk().await? {
            downloaded = downloaded
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| anyhow!("The downloaded update package is too large."))?;
            if downloaded > maximum_bytes || downloaded > asset.size {
                bail!("The downloaded update package is larger than the release metadata.");
            }
            digest.update(&chunk);
            tokio::io::AsyncWriteExt::write_all(&mut archive, &chunk).await?;
        }
        tokio::io::AsyncWriteExt::flush(&mut archive).await?;
        drop(archive);
        if downloaded != asset.size {
            bail!("The downloaded update package size did not match the release metadata.");
        }
        let actual_digest = crate::hex_digest(digest.finalize());
        if !actual_digest.eq_ignore_ascii_case(expected_digest) {
            bail!("The downloaded update package failed SHA-256 verification.");
        }
        Ok(archive_path)
    }

    async fn fetch_latest_release(&self) -> anyhow::Result<GithubRelease> {
        self.client
            .get(RELEASE_API_URL)
            .timeout(Duration::from_secs(30))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2026-03-10")
            .send()
            .await?
            .error_for_status()?
            .json::<GithubRelease>()
            .await
            .context("GitHub returned invalid release metadata")
    }

    fn status_for_release(&self, release: &GithubRelease) -> anyhow::Result<UpdateStatus> {
        if !release.html_url.starts_with(RELEASE_PAGE_PREFIX) {
            bail!("GitHub returned an untrusted release URL.");
        }
        let current = Version::parse(&current_version()).context("Invalid current version")?;
        let latest_text = normalize_version(&release.tag_name);
        let latest = Version::parse(&latest_text).context("Invalid release version")?;
        let platform = platform_key().map(str::to_string);
        let package_available = platform.as_deref().is_some_and(|platform| {
            validated_update_asset(release, &latest_text, platform).is_ok()
        });
        let capability = managed_install(self.web_dist_dir.as_deref());
        let can_auto_update = package_available && capability.is_ok();
        let message = if !package_available {
            Some("No automatic update package is available for this server platform.".to_string())
        } else {
            capability.err().map(|error| error.to_string())
        };
        Ok(UpdateStatus {
            current_version: current.to_string(),
            latest_version: latest.to_string(),
            update_available: latest > current,
            can_auto_update,
            platform,
            release_url: release.html_url.clone(),
            published_at: release.published_at.clone(),
            notes: release.body.as_deref().map(truncate_notes),
            message,
        })
    }

    fn frontend_status_for_release(
        &self,
        release: &GithubRelease,
        reported_current_version: Option<&str>,
    ) -> anyhow::Result<FrontendUpdateStatus> {
        if !release.html_url.starts_with(RELEASE_PAGE_PREFIX) {
            bail!("GitHub returned an untrusted release URL.");
        }
        let installed_version = installed_frontend_version(self.web_dist_dir.as_deref());
        let installed_current = installed_version.as_ref().ok().cloned();
        let current_text = reported_current_version
            .map(normalize_version)
            .or(installed_current)
            .unwrap_or_else(current_version);
        let current =
            Version::parse(&current_text).context("Invalid installed frontend version")?;
        let latest_text = normalize_version(&release.tag_name);
        let latest = Version::parse(&latest_text).context("Invalid release version")?;
        let package_available = validated_frontend_asset(release, &latest_text).is_ok();
        // A combined release package ships its own web bundle, and the server
        // update replaces it wholesale. Installing the frontend on its own
        // would only let it run ahead of the server it talks to.
        let combined_install = managed_install(self.web_dist_dir.as_deref())
            .is_ok_and(|install| install.layout == InstallLayout::Combined);
        let reported = reported_current_version.map(normalize_version);
        let capability = installed_version.and_then(|installed_version| {
            if combined_install {
                bail!(
                    "This installation's web frontend ships with the server package. Install the server update instead."
                );
            }
            if let Some(reported) = reported.filter(|reported| *reported != installed_version) {
                bail!(
                    "This browser is running web frontend {reported}, but this server is serving {installed_version}. Reload the page to pick up the served version; if the mismatch persists, this frontend is hosted separately and must be updated through its hosting provider."
                );
            }
            Ok(())
        });
        let can_auto_update = package_available && capability.is_ok();
        let message = if !package_available {
            Some("No automatic web frontend package is available for this release.".to_string())
        } else {
            capability.err().map(|error| error.to_string())
        };
        Ok(FrontendUpdateStatus {
            current_version: current.to_string(),
            latest_version: latest.to_string(),
            update_available: latest > current,
            can_auto_update,
            release_url: release.html_url.clone(),
            published_at: release.published_at.clone(),
            notes: release.body.as_deref().map(truncate_notes),
            message,
        })
    }
}

fn validated_update_asset<'a>(
    release: &'a GithubRelease,
    version: &str,
    platform: &str,
) -> anyhow::Result<(&'a GithubReleaseAsset, &'a str)> {
    let asset = find_update_asset(release, version, platform)?;
    check_release_asset(asset, MAX_UPDATE_PACKAGE_BYTES, "release update package")
}

fn validated_frontend_asset<'a>(
    release: &'a GithubRelease,
    version: &str,
) -> anyhow::Result<(&'a GithubReleaseAsset, &'a str)> {
    let name = format!("operalibre-{version}-frontend.zip");
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == name)
        .ok_or_else(|| anyhow!("Release asset {name} was not found."))?;
    check_release_asset(asset, MAX_FRONTEND_PACKAGE_BYTES, "frontend package")
}

/// Removes every other entry under `updates_dir`, leaving only `keep`. Each
/// staged version otherwise stays behind after it was applied or abandoned,
/// and an update package is a few hundred megabytes extracted.
async fn prune_stale_staging(updates_dir: &Path, keep: &Path) {
    let mut entries = match fs::read_dir(updates_dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            tracing::warn!(
                "could not list old update staging folders in {}: {error}",
                updates_dir.display()
            );
            return;
        }
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path == keep {
            continue;
        }
        let removed = match entry.file_type().await {
            Ok(file_type) if file_type.is_dir() => fs::remove_dir_all(&path).await,
            _ => fs::remove_file(&path).await,
        };
        if let Err(error) = removed {
            tracing::warn!(
                "could not remove old update staging entry {}: {error}",
                path.display()
            );
        }
    }
}

/// Clears whatever a previous, possibly interrupted attempt left in `dir` and
/// recreates it empty.
async fn reset_dir(dir: &Path) -> anyhow::Result<()> {
    match fs::remove_dir_all(dir).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    fs::create_dir_all(dir).await?;
    Ok(())
}

/// `base` with the platform's executable suffix.
fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

/// The digest, size, and origin checks every release asset must pass before a
/// byte of it is downloaded.
fn check_release_asset<'a>(
    asset: &'a GithubReleaseAsset,
    max_bytes: u64,
    label: &str,
) -> anyhow::Result<(&'a GithubReleaseAsset, &'a str)> {
    let digest = asset
        .digest
        .as_deref()
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .filter(|digest| digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| anyhow!("The {label} has no valid SHA-256 digest."))?;
    if asset.size == 0 || asset.size > max_bytes {
        bail!("The {label} has an invalid size.");
    }
    if !asset
        .browser_download_url
        .starts_with(RELEASE_DOWNLOAD_PREFIX)
    {
        bail!("The {label} has an untrusted download URL.");
    }
    Ok((asset, digest))
}

fn find_update_asset<'a>(
    release: &'a GithubRelease,
    version: &str,
    platform: &str,
) -> anyhow::Result<&'a GithubReleaseAsset> {
    let name = format!("operalibre-{version}-update-{platform}.zip");
    release
        .assets
        .iter()
        .find(|asset| asset.name == name)
        .ok_or_else(|| anyhow!("Release asset {name} was not found."))
}

fn managed_frontend_dir(web_dist_dir: Option<&Path>) -> anyhow::Result<PathBuf> {
    let web_dist_dir =
        web_dist_dir.ok_or_else(|| anyhow!("This server does not serve the web frontend."))?;
    if !web_dist_dir.join("index.html").is_file() {
        bail!("The configured web frontend has no index.html.");
    }
    let parent = web_dist_dir
        .parent()
        .ok_or_else(|| anyhow!("The configured web frontend has no parent folder."))?;
    if !parent.is_dir() {
        bail!("The configured web frontend parent folder does not exist.");
    }
    canonical_or_absolute(web_dist_dir)
}

fn installed_frontend_version(web_dist_dir: Option<&Path>) -> anyhow::Result<String> {
    let web_dist_dir = managed_frontend_dir(web_dist_dir)?;
    let direct_marker = web_dist_dir.join("VERSION.txt");
    let marker = if direct_marker.is_file() {
        direct_marker
    } else {
        let parent_marker = web_dist_dir
            .parent()
            .ok_or_else(|| anyhow!("The configured web frontend has no parent folder."))?
            .join("VERSION.txt");
        if !parent_marker.is_file() {
            bail!("The installed web frontend has no VERSION.txt marker.");
        }
        parent_marker
    };
    let version = normalize_version(&std::fs::read_to_string(marker)?);
    Version::parse(&version).context("The installed web frontend version is invalid")?;
    Ok(version)
}

fn managed_install(web_dist_dir: Option<&Path>) -> anyhow::Result<ManagedInstall> {
    let executable = std::env::current_exe()?;
    let root = executable
        .parent()
        .ok_or_else(|| anyhow!("The server executable has no installation folder."))?
        .to_path_buf();
    let version_file = root.join("VERSION.txt");
    if !version_file.is_file() {
        bail!("Automatic install is available for OperaLibre release packages only.");
    }
    let installed_version = std::fs::read_to_string(&version_file)?.trim().to_string();
    if normalize_version(&installed_version) != current_version() {
        bail!("VERSION.txt does not match the running server version.");
    }
    let layout = install_layout(&root, web_dist_dir)?;
    // The updater replaces files here after the server exits. Proving the
    // folder is writable now turns an unrecoverable half-applied update into
    // an ordinary error message, while the server is still running.
    ensure_install_root_is_writable_cached(&root)?;
    Ok(ManagedInstall { root, layout })
}

/// Roots that a probe has already found writable. Every status check calls
/// [`managed_install`], and writing a probe file to the install folder each
/// time is needless once it has passed; an install still probes afresh.
static WRITABLE_INSTALL_ROOTS: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

fn ensure_install_root_is_writable_cached(root: &Path) -> anyhow::Result<()> {
    if WRITABLE_INSTALL_ROOTS
        .lock()
        .map(|roots| roots.iter().any(|known| known == root))
        .unwrap_or(false)
    {
        return Ok(());
    }
    ensure_install_root_is_writable(root)?;
    if let Ok(mut roots) = WRITABLE_INSTALL_ROOTS.lock()
        && !roots.iter().any(|known| known == root)
    {
        roots.push(root.to_path_buf());
    }
    Ok(())
}

fn ensure_install_root_is_writable(root: &Path) -> anyhow::Result<()> {
    let probe = root.join(format!(".operalibre-update-probe-{}", std::process::id()));
    // The hardened systemd unit mounts the install folder read-only, so the
    // message names the setting that lets in-app updates through.
    std::fs::write(&probe, []).with_context(|| {
        format!(
            "{} is not writable by this server. If OperaLibre runs under the hardened systemd unit, add the install folder to ReadWritePaths to allow in-app updates.",
            root.display()
        )
    })?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

fn install_layout(root: &Path, web_dist_dir: Option<&Path>) -> anyhow::Result<InstallLayout> {
    let Some(configured_web) = web_dist_dir else {
        return Ok(InstallLayout::ServerOnly);
    };
    if canonical_or_absolute(configured_web)? == canonical_or_absolute(&root.join("web"))? {
        Ok(InstallLayout::Combined)
    } else {
        Ok(InstallLayout::ServerOnly)
    }
}

fn canonical_or_absolute(path: &Path) -> anyhow::Result<PathBuf> {
    if path.exists() {
        return Ok(std::fs::canonicalize(path)?);
    }
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

async fn validate_update_package(root: &Path, version: &str, platform: &str) -> anyhow::Result<()> {
    let metadata: UpdatePackageMetadata =
        serde_json::from_slice(&fs::read(root.join("UPDATE.json")).await?)?;
    if metadata.schema_version != 1
        || normalize_version(&metadata.version) != version
        || metadata.platform != platform
    {
        bail!("The update package metadata does not match this release.");
    }
    if !root.join(exe_name("operalibre-server")).is_file()
        || !root.join(exe_name("operalibre-updater")).is_file()
        || !root.join("web/index.html").is_file()
        || !root.join("VERSION.txt").is_file()
    {
        bail!("The update package is incomplete.");
    }
    Ok(())
}

async fn validate_frontend_package(root: &Path, version: &str) -> anyhow::Result<()> {
    let packaged_version = normalize_version(
        &fs::read_to_string(root.join("VERSION.txt"))
            .await
            .context("The frontend package has no VERSION.txt marker.")?,
    );
    if packaged_version != version {
        bail!("The frontend package version does not match this release.");
    }
    if !root.join("web/index.html").is_file() {
        bail!("The frontend package is incomplete.");
    }
    Ok(())
}

async fn install_frontend_files(
    source: PathBuf,
    destination: PathBuf,
    data_dir: PathBuf,
) -> anyhow::Result<()> {
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("Could not create a frontend update timestamp")?
            .as_millis();
        let parent = destination
            .parent()
            .ok_or_else(|| anyhow!("The configured web frontend has no parent folder."))?;
        let staged = parent.join(format!(
            ".operalibre-frontend-staged-{}-{timestamp}",
            std::process::id()
        ));
        let rollback = parent.join(format!(
            ".operalibre-frontend-rollback-{}-{timestamp}",
            std::process::id()
        ));
        let backup = data_dir
            .join("update-backups")
            .join(format!("{timestamp}-frontend"))
            .join("web");

        copy_directory(&destination, &backup)
            .context("Could not create the frontend rollback copy")?;
        if let Err(error) = copy_directory(&source, &staged) {
            let _ = std::fs::remove_dir_all(&staged);
            return Err(error).context("Could not stage the new web frontend");
        }
        std::fs::rename(&destination, &rollback)
            .context("Could not move the installed web frontend aside")?;
        if let Err(error) = std::fs::rename(&staged, &destination) {
            let rollback_result = std::fs::rename(&rollback, &destination);
            return match rollback_result {
                Ok(()) => Err(error).context(
                    "Could not install the web frontend; the previous version was restored",
                ),
                Err(rollback_error) => Err(anyhow!(
                    "Could not install the web frontend ({error}) and could not restore the previous version ({rollback_error}). The rollback copy remains at {}.",
                    backup.display()
                )),
            };
        }
        if let Err(error) = std::fs::remove_dir_all(&rollback) {
            tracing::warn!(
                "could not remove temporary frontend rollback folder {}: {error}",
                rollback.display()
            );
        }
        Ok(())
    })
    .await??;
    Ok(())
}

fn copy_directory(source: &Path, destination: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_directory(&entry.path(), &target)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), target)?;
        } else {
            bail!(
                "The web frontend contains an unsupported filesystem entry at {}.",
                entry.path().display()
            );
        }
    }
    Ok(())
}

async fn make_package_executables(root: &Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    for name in ["operalibre-server", "operalibre-updater"] {
        let path = root.join(name);
        let mut permissions = fs::metadata(&path).await?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).await?;
    }
    Ok(())
}

async fn extract_zip(archive_path: PathBuf, output: PathBuf) -> anyhow::Result<()> {
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        std::fs::create_dir_all(&output)?;
        let file = std::fs::File::open(archive_path)?;
        let mut archive = zip::ZipArchive::new(file)?;
        let mut extracted_size = 0_u64;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index)?;
            extracted_size = extracted_size
                .checked_add(entry.size())
                .ok_or_else(|| anyhow!("The extracted update package is too large."))?;
            if extracted_size > MAX_UPDATE_EXTRACTED_BYTES {
                bail!("The extracted update package is too large.");
            }
            let relative = entry
                .enclosed_name()
                .ok_or_else(|| anyhow!("The update archive contains an unsafe path."))?;
            let target = output.join(relative);
            if entry.is_dir() {
                std::fs::create_dir_all(&target)?;
                continue;
            }
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut destination = std::fs::File::create(target)?;
            std::io::copy(&mut entry, &mut destination)?;
            destination.flush()?;
        }
        Ok(())
    })
    .await??;
    Ok(())
}

pub fn current_version() -> String {
    normalize_version(option_env!("OPERALIBRE_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")))
}

fn normalize_version(version: &str) -> String {
    version.trim().trim_start_matches(['v', 'V']).to_string()
}

fn platform_key() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("macos", "x86_64") => Some("macos-x64"),
        ("macos", "aarch64") => Some("macos-arm64"),
        ("windows", "x86_64") => Some("windows-x64"),
        _ => None,
    }
}

fn truncate_notes(notes: &str) -> String {
    const MAX_CHARS: usize = 4_000;
    let trimmed = notes.trim();
    if trimmed.chars().count() <= MAX_CHARS {
        return trimmed.to_string();
    }
    let mut value = trimmed.chars().take(MAX_CHARS).collect::<String>();
    value.push('…');
    value
}

#[cfg(test)]
mod tests {
    use super::{
        GithubRelease, GithubReleaseAsset, InstallGuard, InstallLayout, UpdateManager,
        install_frontend_files, install_layout, installed_frontend_version, normalize_version,
        prune_stale_staging, truncate_notes, validated_frontend_asset, validated_update_asset,
    };
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    #[test]
    fn install_layouts_are_classified_by_the_configured_frontend() {
        let root = tempfile::tempdir().unwrap();
        let bundled_web = root.path().join("web");
        std::fs::create_dir_all(&bundled_web).unwrap();
        let custom_web = tempfile::tempdir().unwrap();

        assert_eq!(
            install_layout(root.path(), Some(&bundled_web)).unwrap(),
            InstallLayout::Combined
        );
        assert_eq!(
            install_layout(root.path(), Some(custom_web.path())).unwrap(),
            InstallLayout::ServerOnly
        );
        assert_eq!(
            install_layout(root.path(), None).unwrap(),
            InstallLayout::ServerOnly
        );
    }

    #[tokio::test]
    async fn staging_a_version_removes_every_other_staged_version() {
        let data = tempfile::tempdir().unwrap();
        let updates = data.path().join("updates");
        let old = updates.join("staging-1.0.0-macos-arm64");
        let old_frontend = updates.join("frontend-staging-1.0.0");
        let current = updates.join("staging-1.1.0-macos-arm64");
        for dir in [&old, &old_frontend, &current] {
            std::fs::create_dir_all(dir.join("extracted")).unwrap();
        }
        std::fs::write(updates.join("stray.zip"), b"zip").unwrap();

        prune_stale_staging(&updates, &current).await;

        assert!(!old.exists());
        assert!(!old_frontend.exists());
        assert!(!updates.join("stray.zip").exists());
        assert!(current.join("extracted").is_dir());

        // A missing updates folder is not an error on a fresh install.
        prune_stale_staging(&data.path().join("missing"), &current).await;
    }

    #[test]
    fn release_versions_are_normalized() {
        assert_eq!(normalize_version("v1.2.3"), "1.2.3");
        assert_eq!(normalize_version("  V2.0.0-beta.1  "), "2.0.0-beta.1");
    }

    #[test]
    fn release_notes_are_bounded_on_character_boundaries() {
        let notes = "📚".repeat(4_001);
        let truncated = truncate_notes(&notes);
        assert_eq!(truncated.chars().count(), 4_001);
        assert!(truncated.ends_with('…'));
    }

    #[test]
    fn update_assets_require_an_exact_platform_name_and_valid_digest() {
        let mut release = GithubRelease {
            tag_name: "v1.2.3".to_string(),
            html_url: "https://github.com/DonovanMontoya/OperaLibre/releases/tag/v1.2.3"
                .to_string(),
            published_at: None,
            body: None,
            assets: vec![GithubReleaseAsset {
                name: "operalibre-1.2.3-update-macos-arm64.zip".to_string(),
                browser_download_url: "https://github.com/DonovanMontoya/OperaLibre/releases/download/v1.2.3/operalibre-1.2.3-update-macos-arm64.zip".to_string(),
                size: 1024,
                digest: Some(format!("sha256:{}", "a".repeat(64))),
            }],
        };

        assert!(validated_update_asset(&release, "1.2.3", "macos-arm64").is_ok());
        assert!(validated_update_asset(&release, "1.2.3", "macos-x64").is_err());
        release.assets[0].digest = Some("sha256:not-a-digest".to_string());
        assert!(validated_update_asset(&release, "1.2.3", "macos-arm64").is_err());
    }

    #[test]
    fn frontend_assets_require_an_exact_name_and_valid_digest() {
        let mut release = GithubRelease {
            tag_name: "v1.2.3".to_string(),
            html_url: "https://github.com/DonovanMontoya/OperaLibre/releases/tag/v1.2.3"
                .to_string(),
            published_at: None,
            body: None,
            assets: vec![GithubReleaseAsset {
                name: "operalibre-1.2.3-frontend.zip".to_string(),
                browser_download_url: "https://github.com/DonovanMontoya/OperaLibre/releases/download/v1.2.3/operalibre-1.2.3-frontend.zip".to_string(),
                size: 1024,
                digest: Some(format!("sha256:{}", "b".repeat(64))),
            }],
        };

        assert!(validated_frontend_asset(&release, "1.2.3").is_ok());
        assert!(validated_frontend_asset(&release, "1.2.4").is_err());
        release.assets[0].browser_download_url = "https://example.com/frontend.zip".to_string();
        assert!(validated_frontend_asset(&release, "1.2.3").is_err());
    }

    #[tokio::test]
    async fn frontend_install_replaces_files_and_keeps_a_rollback_copy() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("served-web");
        let data = root.path().join("data");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(source.join("index.html"), "new frontend").unwrap();
        std::fs::write(source.join("VERSION.txt"), "2.0.0\n").unwrap();
        std::fs::write(destination.join("index.html"), "old frontend").unwrap();
        std::fs::write(destination.join("VERSION.txt"), "1.0.0\n").unwrap();

        install_frontend_files(source, destination.clone(), data.clone())
            .await
            .unwrap();

        assert_eq!(
            std::fs::read_to_string(destination.join("index.html")).unwrap(),
            "new frontend"
        );
        assert_eq!(
            installed_frontend_version(Some(&destination)).unwrap(),
            "2.0.0"
        );
        let backups = std::fs::read_dir(data.join("update-backups"))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(backups.len(), 1);
        assert_eq!(
            std::fs::read_to_string(backups[0].path().join("web/index.html")).unwrap(),
            "old frontend"
        );
    }

    #[test]
    fn separately_hosted_frontends_are_reported_but_not_replaced() {
        let root = tempfile::tempdir().unwrap();
        let web = root.path().join("web");
        std::fs::create_dir_all(&web).unwrap();
        std::fs::write(web.join("index.html"), "server frontend").unwrap();
        std::fs::write(web.join("VERSION.txt"), "1.0.0\n").unwrap();
        let manager = UpdateManager::new(root.path().join("data"), Some(web), 4000).unwrap();
        let release = GithubRelease {
            tag_name: "v2.0.0".to_string(),
            html_url: "https://github.com/DonovanMontoya/OperaLibre/releases/tag/v2.0.0"
                .to_string(),
            published_at: None,
            body: None,
            assets: vec![GithubReleaseAsset {
                name: "operalibre-2.0.0-frontend.zip".to_string(),
                browser_download_url: "https://github.com/DonovanMontoya/OperaLibre/releases/download/v2.0.0/operalibre-2.0.0-frontend.zip".to_string(),
                size: 1024,
                digest: Some(format!("sha256:{}", "c".repeat(64))),
            }],
        };

        let status = manager
            .frontend_status_for_release(&release, Some("1.5.0"))
            .unwrap();
        assert_eq!(status.current_version, "1.5.0");
        assert!(status.update_available);
        assert!(!status.can_auto_update);
        assert!(status.message.unwrap().contains("hosting provider"));
    }

    /// A cancelled install must not wedge the flag. This is the failure the
    /// request timeout used to cause: the future is dropped mid-install, the
    /// cleanup after the `.await` never runs, and every later install is
    /// refused as already in progress until the process restarts.
    #[tokio::test]
    async fn a_cancelled_install_releases_the_flag() {
        let installing = Arc::new(AtomicBool::new(false));

        let install = {
            let installing = Arc::clone(&installing);
            async move {
                let _guard = InstallGuard::acquire(&installing).expect("flag was free");
                // Stands in for the download-and-extract work.
                std::future::pending::<()>().await;
            }
        };
        // Elapsing drops the inner future mid-install, which is precisely what
        // the request timeout layer does to a handler.
        let outcome = tokio::time::timeout(std::time::Duration::from_millis(50), install).await;
        assert!(outcome.is_err(), "the install should have been cancelled");

        assert!(
            !installing.load(Ordering::SeqCst),
            "a cancelled install left the flag set, blocking every later install"
        );
        assert!(
            InstallGuard::acquire(&installing).is_some(),
            "a later install was refused after a cancelled one"
        );
    }

    /// A staged backend update deliberately keeps the flag: the process is
    /// about to restart and nothing should install over it.
    #[test]
    fn a_staged_install_keeps_the_flag_held() {
        let installing = Arc::new(AtomicBool::new(false));

        let guard = InstallGuard::acquire(&installing).expect("flag was free");
        guard.keep();

        assert!(installing.load(Ordering::SeqCst), "the flag was released");
        assert!(
            InstallGuard::acquire(&installing).is_none(),
            "a second install started while one was staged for restart"
        );
    }
}
