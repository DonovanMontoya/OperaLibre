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
    time::{Duration, Instant},
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
    installing: Arc<AtomicBool>,
}

struct CachedUpdateStatus {
    checked_at: Instant,
    status: UpdateStatus,
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
        if self.installing.swap(true, Ordering::SeqCst) {
            bail!("An OperaLibre update is already being installed.");
        }
        let result = self.install_inner().await;
        if result.is_err() {
            self.installing.store(false, Ordering::SeqCst);
        }
        result
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

        let install_root = managed_install_root(&self.data_dir, self.web_dist_dir.as_deref())?;
        let staging_dir = self
            .data_dir
            .join("updates")
            .join(format!("staging-{}-{platform}", status.latest_version));
        match fs::remove_dir_all(&staging_dir).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        fs::create_dir_all(&staging_dir).await?;

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
            if downloaded > MAX_UPDATE_PACKAGE_BYTES || downloaded > asset.size {
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
        let actual_digest = format!("{:x}", digest.finalize());
        if !actual_digest.eq_ignore_ascii_case(expected_digest) {
            bail!("The downloaded update package failed SHA-256 verification.");
        }

        let extract_dir = staging_dir.join("extracted");
        extract_zip(archive_path, extract_dir.clone()).await?;
        let package_root = extract_dir.join(format!(
            "operalibre-{}-update-{platform}",
            status.latest_version
        ));
        validate_update_package(&package_root, &status.latest_version, platform).await?;
        make_package_executables(&package_root).await?;

        let updater_name = if cfg!(windows) {
            "operalibre-updater.exe"
        } else {
            "operalibre-updater"
        };
        let updater_path = package_root.join(updater_name);
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
            .arg(&install_root)
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

        tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(1_500)).await;
            std::process::exit(0);
        });
        Ok(UpdateInstallStarted {
            version: status.latest_version,
            restarting: true,
        })
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
        let capability = managed_install_root(&self.data_dir, self.web_dist_dir.as_deref());
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
}

fn validated_update_asset<'a>(
    release: &'a GithubRelease,
    version: &str,
    platform: &str,
) -> anyhow::Result<(&'a GithubReleaseAsset, &'a str)> {
    let asset = find_update_asset(release, version, platform)?;
    let digest = asset
        .digest
        .as_deref()
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .filter(|digest| digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| anyhow!("The release update package has no valid SHA-256 digest."))?;
    if asset.size == 0 || asset.size > MAX_UPDATE_PACKAGE_BYTES {
        bail!("The release update package has an invalid size.");
    }
    if !asset
        .browser_download_url
        .starts_with(RELEASE_DOWNLOAD_PREFIX)
    {
        bail!("The release update package has an untrusted download URL.");
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

fn managed_install_root(data_dir: &Path, web_dist_dir: Option<&Path>) -> anyhow::Result<PathBuf> {
    let executable = std::env::current_exe()?;
    let root = executable
        .parent()
        .ok_or_else(|| anyhow!("The server executable has no installation folder."))?
        .to_path_buf();
    let version_file = root.join("VERSION.txt");
    if !version_file.is_file() {
        bail!("Automatic install is available for combined release packages only.");
    }
    let installed_version = std::fs::read_to_string(&version_file)?.trim().to_string();
    if normalize_version(&installed_version) != current_version() {
        bail!("VERSION.txt does not match the running server version.");
    }
    let expected_web = root.join("web");
    let configured_web = web_dist_dir
        .ok_or_else(|| anyhow!("This server does not use the bundled web application."))?;
    if canonical_or_absolute(configured_web)? != canonical_or_absolute(&expected_web)? {
        bail!("The configured web application is outside the managed release package.");
    }
    let pid = std::fs::read_to_string(data_dir.join("operalibre-server.pid"))
        .context("The server was not started by the OperaLibre release launcher")?;
    if pid.trim() != std::process::id().to_string() {
        bail!("The server was not started by the OperaLibre release launcher.");
    }
    Ok(root)
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
    let server_name = if cfg!(windows) {
        "operalibre-server.exe"
    } else {
        "operalibre-server"
    };
    let updater_name = if cfg!(windows) {
        "operalibre-updater.exe"
    } else {
        "operalibre-updater"
    };
    if !root.join(server_name).is_file()
        || !root.join(updater_name).is_file()
        || !root.join("web/index.html").is_file()
        || !root.join("VERSION.txt").is_file()
    {
        bail!("The update package is incomplete.");
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
        GithubRelease, GithubReleaseAsset, normalize_version, truncate_notes,
        validated_update_asset,
    };

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
}
