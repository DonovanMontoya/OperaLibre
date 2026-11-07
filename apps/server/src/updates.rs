use crate::http_client_builder;
use crate::sync::AlignmentConfig;
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

use crate::update_channel::{UpdateChannel, update_available, validate_target};
use crate::update_manifest::{
    ACCEPTED_ROOTS_FILE, ArchiveFormat, Manifest, Package, fetch_manifest, fetch_manifest_from,
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

const MAX_UPDATE_PACKAGE_BYTES: u64 = 250 * 1024 * 1024;
const MAX_FRONTEND_PACKAGE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_SYNC_ADDON_PACKAGE_BYTES: u64 = 900 * 1024 * 1024;
const MAX_UPDATE_EXTRACTED_BYTES: u64 = 750 * 1024 * 1024;
const MAX_SYNC_ADDON_EXTRACTED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const UPDATE_CACHE_TTL: Duration = Duration::from_secs(15 * 60);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;

#[derive(Clone)]
pub struct UpdateManager {
    config_path: Option<PathBuf>,
    config_digest: Option<[u8; 32]>,
    data_dir: PathBuf,
    web_dist_dir: Option<PathBuf>,
    port: u16,
    client: Client,
    cache: Arc<Mutex<Option<CachedUpdateStatus>>>,
    frontend_cache: Arc<Mutex<Option<CachedFrontendUpdateStatus>>>,
    sync_addon_cache: Arc<Mutex<Option<CachedSyncAddonStatus>>>,
    installing: Arc<AtomicBool>,
    pub(crate) sync_lifecycle: Arc<tokio::sync::RwLock<()>>,
    pub(crate) sync_slots: Arc<tokio::sync::Semaphore>,
    pub(crate) sync_queue_changed: Arc<tokio::sync::Notify>,
    pub(crate) sync_update_pause: tokio::sync::watch::Sender<u64>,
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
    channel: UpdateChannel,
    checked_at: Instant,
    reported_current_version: Option<String>,
    status: FrontendUpdateStatus,
}

struct CachedSyncAddonStatus {
    checked_at: Instant,
    status: SyncAddonStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub channel: UpdateChannel,
    pub current_channel: UpdateChannel,
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub can_auto_update: bool,
    pub platform: Option<String>,
    pub release_url: String,
    pub published_at: Option<String>,
    pub notes: Option<String>,
    pub message: Option<String>,
    pub last_update_result: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelSettings {
    pub channel: UpdateChannel,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelStatus {
    pub channel: UpdateChannel,
    pub current_version: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallRequest {
    pub channel: Option<UpdateChannel>,
    pub version: Option<String>,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncAddonStatus {
    pub id: &'static str,
    pub installed: bool,
    pub enabled: bool,
    pub managed: bool,
    pub can_toggle: bool,
    pub installed_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub can_install: bool,
    pub package_bytes: Option<u64>,
    pub release_url: Option<String>,
    pub cli_path: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SyncAddonRuntime {
    pub cli_path: PathBuf,
    pub cli_args: Vec<String>,
    pub ffmpeg_path: Option<PathBuf>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExperimentalFeatureSettings {
    #[serde(default)]
    readalong_sync_enabled: bool,
    // PATH installs were always enabled before this opt-out existed.
    #[serde(default)]
    path_runtime_disabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncAddonPackageMetadata {
    schema_version: u32,
    id: String,
    version: String,
    platform: String,
    protocol_version: u32,
    cli: String,
    #[serde(default)]
    cli_args: Vec<String>,
    #[serde(default)]
    ffmpeg: Option<String>,
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
        config_path: Option<PathBuf>,
        config_digest: Option<[u8; 32]>,
    ) -> anyhow::Result<Self> {
        let client = http_client_builder()
            .user_agent(format!("OperaLibre/{}", current_version()))
            .connect_timeout(Duration::from_secs(10))
            .build()?;
        Ok(Self {
            config_path,
            config_digest,
            data_dir,
            web_dist_dir,
            port,
            client,
            cache: Arc::new(Mutex::new(None)),
            frontend_cache: Arc::new(Mutex::new(None)),
            sync_addon_cache: Arc::new(Mutex::new(None)),
            installing: Arc::new(AtomicBool::new(false)),
            sync_lifecycle: Arc::new(tokio::sync::RwLock::new(())),
            sync_slots: Arc::new(tokio::sync::Semaphore::new(1)),
            sync_queue_changed: Arc::new(tokio::sync::Notify::new()),
            sync_update_pause: tokio::sync::watch::channel(0).0,
        })
    }

    pub async fn channel(&self) -> anyhow::Result<UpdateChannel> {
        match fs::read(self.data_dir.join("update-channel.json")).await {
            Ok(bytes) => Ok(serde_json::from_slice::<ChannelSettings>(&bytes)
                .context("Could not read the saved update channel")?
                .channel),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(
                UpdateChannel::for_version(&Version::parse(&current_version())?),
            ),
            Err(error) => Err(error.into()),
        }
    }

    pub async fn set_channel(&self, channel: UpdateChannel) -> anyhow::Result<()> {
        let Some(_guard) = InstallGuard::acquire(&self.installing) else {
            bail!("Wait for the current update to finish before changing channels.");
        };
        crate::write_json_atomic(
            &self.data_dir.join("update-channel.json"),
            &ChannelSettings { channel },
        )
        .await
        .map_err(|error| anyhow!("Could not save the update channel: {error:?}"))?;
        *self.cache.lock().await = None;
        *self.frontend_cache.lock().await = None;
        Ok(())
    }

    pub async fn check(&self, force: bool) -> anyhow::Result<UpdateStatus> {
        let channel = self.channel().await?;
        if !force {
            let cache = self.cache.lock().await;
            if let Some(cached) = cache.as_ref()
                && cached.checked_at.elapsed() < UPDATE_CACHE_TTL
                && cached.status.channel == channel
            {
                let mut status = cached.status.clone();
                if status.can_auto_update
                    && let Err(error) = self.managed_server_install()
                {
                    status.can_auto_update = false;
                    status.message = Some(error.to_string());
                }
                status.last_update_result = self.last_update_result().await;
                return Ok(status);
            }
        }

        let manifest = self.channel_manifest(channel).await?;
        let mut status = self.status_for_manifest(&manifest, channel)?;
        status.last_update_result = self.last_update_result().await;
        *self.cache.lock().await = Some(CachedUpdateStatus {
            checked_at: Instant::now(),
            status: status.clone(),
        });
        Ok(status)
    }

    async fn last_update_result(&self) -> Option<String> {
        let path = self.data_dir.join("update-result.txt");
        if fs::metadata(&path).await.ok()?.len() > 64 * 1024 {
            return None;
        }
        fs::read_to_string(path)
            .await
            .ok()
            .map(|text| text.trim().to_string())
    }

    pub async fn install(
        &self,
        request: UpdateInstallRequest,
        state: &crate::AppState,
    ) -> anyhow::Result<UpdateInstallStarted> {
        self.install_prepared(request, crate::sync::pause_for_update(state))
            .await
    }

    async fn install_prepared(
        &self,
        request: UpdateInstallRequest,
        before_restart: impl std::future::Future<Output = anyhow::Result<crate::sync::SyncUpdatePause>>,
    ) -> anyhow::Result<UpdateInstallStarted> {
        let Some(guard) = InstallGuard::acquire(&self.installing) else {
            bail!("An OperaLibre update is already being installed.");
        };
        let result = self.install_inner(request, before_restart).await;
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
        let channel = self.channel().await?;
        let reported_current_version = reported_current_version.map(normalize_version);
        if !force {
            let cache = self.frontend_cache.lock().await;
            if let Some(cached) = cache.as_ref()
                && cached.checked_at.elapsed() < UPDATE_CACHE_TTL
                && cached.channel == channel
                && cached.reported_current_version == reported_current_version
            {
                return Ok(cached.status.clone());
            }
        }

        let manifest = self
            .frontend_manifest(reported_current_version.as_deref(), channel)
            .await?;
        let status =
            self.frontend_status_for_manifest(&manifest, reported_current_version.as_deref())?;
        *self.frontend_cache.lock().await = Some(CachedFrontendUpdateStatus {
            channel,
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

    pub async fn check_sync_addon(
        &self,
        force: bool,
        config: &AlignmentConfig,
    ) -> anyhow::Result<SyncAddonStatus> {
        if let AlignmentConfig::Manual(cli_path) | AlignmentConfig::Path(cli_path) = config
            && cli_path.is_file()
        {
            let from_path = matches!(config, AlignmentConfig::Path(_));
            let enabled = !from_path
                || !self
                    .read_experimental_settings()
                    .await
                    .path_runtime_disabled;
            return Ok(SyncAddonStatus {
                id: "readalong-sync",
                installed: true,
                enabled,
                managed: false,
                can_toggle: from_path,
                installed_version: None,
                latest_version: None,
                update_available: false,
                can_install: false,
                package_bytes: None,
                release_url: None,
                cli_path: Some(cli_path.to_string_lossy().into_owned()),
                message: Some(if from_path {
                    "Using echogarden found on the server's PATH.".to_string()
                } else {
                    "This generator is configured manually in server.config and is always enabled."
                        .to_string()
                }),
            });
        }
        if !force {
            let cache = self.sync_addon_cache.lock().await;
            if let Some(cached) = cache.as_ref()
                && cached.checked_at.elapsed() < UPDATE_CACHE_TTL
            {
                return Ok(cached.status.clone());
            }
        }

        let installed = installed_sync_addon().ok();
        let settings = self.read_experimental_settings().await;
        let mut status = SyncAddonStatus {
            id: "readalong-sync",
            installed: installed.is_some(),
            enabled: installed.is_some() && settings.readalong_sync_enabled,
            managed: true,
            can_toggle: true,
            installed_version: installed
                .as_ref()
                .map(|addon| addon.metadata.version.clone()),
            latest_version: None,
            update_available: false,
            can_install: false,
            package_bytes: None,
            release_url: None,
            cli_path: installed
                .as_ref()
                .map(|addon| addon.cli_path.to_string_lossy().into_owned()),
            message: None,
        };

        let platform = match platform_key() {
            Some(platform) => platform,
            None => {
                status.managed = false;
                status.can_toggle = false;
                status.message = Some(
                    "No managed sync add-on is available for this server platform.".to_string(),
                );
                return Ok(status);
            }
        };
        let install_capability = managed_install(self.web_dist_dir.as_deref());
        if let Err(error) = &install_capability {
            status.managed = false;
            status.can_toggle = false;
            status.message = Some(error.to_string());
        }

        match self.stable_manifest().await {
            Ok(manifest) => {
                status.release_url = Some(manifest.release_url.clone());
                match sync_addon_package(&manifest, platform) {
                    Ok(package) => {
                        status.latest_version = Some(package.version.clone());
                        status.package_bytes = Some(package.size);
                        status.can_install = install_capability.is_ok();
                        status.update_available = status
                            .installed_version
                            .as_deref()
                            .and_then(|version| Version::parse(version).ok())
                            .zip(Version::parse(&package.version).ok())
                            .is_some_and(|(installed, latest)| latest > installed);
                    }
                    Err(error) if status.message.is_none() => {
                        status.message = Some(error.to_string());
                    }
                    Err(_) => {}
                }
            }
            Err(error) => {
                status.message = Some(format!(
                    "Could not check for a sync add-on package: {error}"
                ));
            }
        }

        *self.sync_addon_cache.lock().await = Some(CachedSyncAddonStatus {
            checked_at: Instant::now(),
            status: status.clone(),
        });
        Ok(status)
    }

    pub async fn install_sync_addon(&self) -> anyhow::Result<SyncAddonStatus> {
        // A disconnected HTTP client must not drop the lifecycle guard while
        // blocking extraction or replacement is still working on the package.
        let manager = self.clone();
        tokio::spawn(async move { manager.install_sync_addon_inner().await }).await?
    }

    async fn install_sync_addon_inner(&self) -> anyhow::Result<SyncAddonStatus> {
        let _lifecycle = self.sync_lifecycle.try_write().map_err(|_| {
            anyhow!("Wait for queued and running sync jobs to finish before changing the add-on.")
        })?;
        let Some(_guard) = InstallGuard::acquire(&self.installing) else {
            bail!("Another OperaLibre package is already being installed.");
        };
        let manifest = self.stable_manifest().await?;
        let platform = platform_key()
            .ok_or_else(|| anyhow!("This server platform does not have a sync add-on package."))?;
        let package = sync_addon_package(&manifest, platform)?;
        let install = managed_install(self.web_dist_dir.as_deref())?;
        let updates_dir = self.data_dir.join("updates");
        fs::create_dir_all(&updates_dir).await?;
        let staging = tempfile::Builder::new()
            .prefix("readalong-sync-")
            .tempdir_in(&updates_dir)?;
        let staging_dir = staging.path();
        let archive_path = self
            .download_package(package, staging_dir, MAX_SYNC_ADDON_PACKAGE_BYTES)
            .await?;
        let extract_dir = staging_dir.join("extracted");
        extract_package(
            archive_path,
            package,
            extract_dir.clone(),
            MAX_SYNC_ADDON_EXTRACTED_BYTES,
        )
        .await?;
        let package_root = extract_dir.join(&package.root);
        let metadata =
            validate_sync_addon_package(&package_root, &package.version, platform).await?;
        make_sync_addon_executables(&package_root, &metadata).await?;
        install_sync_addon_files(
            package_root,
            install.root.join("addons/readalong-sync"),
            self.data_dir.clone(),
        )
        .await?;
        *self.sync_addon_cache.lock().await = None;
        self.check_sync_addon(true, &AlignmentConfig::Managed).await
    }

    pub async fn set_sync_addon_enabled(
        &self,
        enabled: bool,
        config: &AlignmentConfig,
    ) -> anyhow::Result<SyncAddonStatus> {
        let _lifecycle = self.sync_lifecycle.try_write().map_err(|_| {
            anyhow!("Wait for queued and running sync jobs to finish before changing the add-on.")
        })?;
        let mut settings = self.read_experimental_settings().await;
        match config {
            AlignmentConfig::Manual(_) => {
                bail!("The generator configured in server.config is always enabled.");
            }
            AlignmentConfig::Path(cli) if cli.is_file() => {
                settings.path_runtime_disabled = !enabled;
            }
            _ => {
                installed_sync_addon().context("The follow-along sync add-on is not installed.")?;
                settings.readalong_sync_enabled = enabled;
            }
        }
        self.write_experimental_settings(&settings).await?;
        *self.sync_addon_cache.lock().await = None;
        self.check_sync_addon(false, config).await
    }

    pub async fn remove_sync_addon(&self) -> anyhow::Result<SyncAddonStatus> {
        let manager = self.clone();
        tokio::spawn(async move { manager.remove_sync_addon_inner().await }).await?
    }

    async fn remove_sync_addon_inner(&self) -> anyhow::Result<SyncAddonStatus> {
        let _lifecycle = self.sync_lifecycle.try_write().map_err(|_| {
            anyhow!("Wait for queued and running sync jobs to finish before changing the add-on.")
        })?;
        let Some(_guard) = InstallGuard::acquire(&self.installing) else {
            bail!("Another OperaLibre package is already being installed.");
        };
        let addon =
            installed_sync_addon().context("The follow-along sync add-on is not installed.")?;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .context("Could not create an add-on removal timestamp")?
            .as_millis();
        let backup = self
            .data_dir
            .join("update-backups")
            .join(format!("{timestamp}-readalong-sync"));
        tokio::task::spawn_blocking(move || remove_sync_addon_files(&addon.root, &backup))
            .await??;
        let mut settings = self.read_experimental_settings().await;
        settings.readalong_sync_enabled = false;
        self.write_experimental_settings(&settings).await?;
        *self.sync_addon_cache.lock().await = None;
        self.check_sync_addon(false, &AlignmentConfig::Managed)
            .await
    }

    pub async fn sync_addon_runtime(&self, config: &AlignmentConfig) -> Option<SyncAddonRuntime> {
        if let AlignmentConfig::Manual(cli_path) | AlignmentConfig::Path(cli_path) = config
            && cli_path.is_file()
        {
            if matches!(config, AlignmentConfig::Path(_))
                && self
                    .read_experimental_settings()
                    .await
                    .path_runtime_disabled
            {
                return None;
            }
            return Some(SyncAddonRuntime {
                cli_path: cli_path.to_path_buf(),
                cli_args: Vec::new(),
                ffmpeg_path: None,
            });
        }
        if !self
            .read_experimental_settings()
            .await
            .readalong_sync_enabled
        {
            return None;
        }
        installed_sync_addon().ok().map(|addon| SyncAddonRuntime {
            cli_path: addon.cli_path,
            cli_args: addon.cli_args,
            ffmpeg_path: addon.ffmpeg_path,
        })
    }

    async fn read_experimental_settings(&self) -> ExperimentalFeatureSettings {
        let path = self.data_dir.join("experimental-features.json");
        let Ok(contents) = fs::read(path).await else {
            return ExperimentalFeatureSettings::default();
        };
        serde_json::from_slice(&contents).unwrap_or_default()
    }

    async fn write_experimental_settings(
        &self,
        settings: &ExperimentalFeatureSettings,
    ) -> anyhow::Result<()> {
        crate::write_json_atomic(&self.data_dir.join("experimental-features.json"), settings)
            .await
            .map_err(|error| anyhow!("Could not save experimental feature settings: {error:?}"))
    }

    async fn install_inner(
        &self,
        request: UpdateInstallRequest,
        before_restart: impl std::future::Future<Output = anyhow::Result<crate::sync::SyncUpdatePause>>,
    ) -> anyhow::Result<UpdateInstallStarted> {
        let channel = self.channel().await?;
        if request.channel.is_some_and(|expected| expected != channel) {
            bail!("The selected channel changed. Check for updates again before installing.");
        }
        let install = self.managed_server_install()?;
        let manifest = self.channel_manifest(channel).await?;
        let status = self.status_for_manifest(&manifest, channel)?;
        if request
            .version
            .is_some_and(|expected| expected != status.latest_version)
        {
            bail!("The available release changed. Check for updates again before installing.");
        }
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
        let package = manifest
            .package("server", Some(platform), None)
            .ok_or_else(|| anyhow!("This server platform does not have an update package."))?;

        // Probe afresh here: the cached answer a status check gave may be
        // hours old, and this is the moment a stale one would hurt.
        ensure_install_root_is_writable(&install.root)?;
        let updates_dir = self.data_dir.join("updates");
        let staging_dir = updates_dir.join(format!("staging-{}-{platform}", package.version));
        prune_stale_staging(&updates_dir, &staging_dir).await;
        reset_dir(&staging_dir).await?;

        let archive_path = self
            .download_package(package, &staging_dir, MAX_UPDATE_PACKAGE_BYTES)
            .await?;

        let extract_dir = staging_dir.join("extracted");
        extract_package(
            archive_path,
            package,
            extract_dir.clone(),
            MAX_UPDATE_EXTRACTED_BYTES,
        )
        .await?;
        // A combined package carries everything an update applies; the
        // updater takes only the files this installation's layout uses.
        let package_root = extract_dir.join(&package.root);
        validate_update_package(&package_root, &package.version, platform).await?;
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
        // Pause only after the package is verified, and before an updater
        // starts its 45-second exit deadline. Failed launches resume the queue.
        self.ensure_updater_matches_server(&install.root)?;
        let sync_pause = before_restart.await?;
        command
            .spawn()
            .with_context(|| format!("Could not start {}", updater_path.display()))?;
        sync_pause.keep();

        Ok(UpdateInstallStarted {
            version: package.version.clone(),
            restarting: true,
        })
    }

    async fn install_frontend_inner(&self) -> anyhow::Result<UpdateInstallStarted> {
        let manifest = self.frontend_manifest(None, self.channel().await?).await?;
        let status = self.frontend_status_for_manifest(&manifest, None)?;
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
        let package = manifest
            .package("frontend", None, None)
            .ok_or_else(|| anyhow!("This release has no web frontend package."))?;
        let web_dist_dir = managed_frontend_dir(self.web_dist_dir.as_deref())?;
        let updates_dir = self.data_dir.join("updates");
        let staging_dir = updates_dir.join(format!("frontend-staging-{}", package.version));
        prune_stale_staging(&updates_dir, &staging_dir).await;
        reset_dir(&staging_dir).await?;

        let archive_path = self
            .download_package(package, &staging_dir, MAX_FRONTEND_PACKAGE_BYTES)
            .await?;
        let extract_dir = staging_dir.join("extracted");
        extract_package(
            archive_path,
            package,
            extract_dir.clone(),
            MAX_UPDATE_EXTRACTED_BYTES,
        )
        .await?;
        let package_root = extract_dir.join(&package.root);
        validate_frontend_package(&package_root, &package.version).await?;
        fs::write(
            package_root.join("web/VERSION.txt"),
            format!("{}\n", package.version),
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
            version: package.version.clone(),
            restarting: false,
        })
    }

    async fn channel_manifest(&self, channel: UpdateChannel) -> anyhow::Result<Manifest> {
        let current = Version::parse(&current_version()).ok();
        fetch_manifest_from(
            &self.client,
            &self.accepted_roots(),
            channel.manifest_url(),
            "server",
            current.as_ref(),
        )
        .await
        .map_err(|error| {
            if channel == UpdateChannel::Nightly
                && error.downcast_ref::<reqwest::Error>().and_then(reqwest::Error::status) == Some(reqwest::StatusCode::NOT_FOUND)
            {
                anyhow!("No nightly release is available yet. Your server has not changed; you can select Stable again.")
            } else {
                error
            }
        })
    }

    // Sync add-on releases remain independent of the selected server channel.
    async fn stable_manifest(&self) -> anyhow::Result<Manifest> {
        let current = Version::parse(&current_version()).ok();
        fetch_manifest(
            &self.client,
            &self.accepted_roots(),
            "server",
            current.as_ref(),
        )
        .await
    }

    fn accepted_roots(&self) -> PathBuf {
        self.data_dir.join(ACCEPTED_ROOTS_FILE)
    }

    async fn frontend_manifest(
        &self,
        reported: Option<&str>,
        channel: UpdateChannel,
    ) -> anyhow::Result<Manifest> {
        if release_install(self.web_dist_dir.as_deref())
            .is_ok_and(|install| install.layout == InstallLayout::Combined)
        {
            return self.channel_manifest(channel).await;
        }
        let installed = reported
            .map(str::to_string)
            .or_else(|| installed_frontend_version(self.web_dist_dir.as_deref()).ok())
            .and_then(|version| Version::parse(&version).ok());
        fetch_manifest(
            &self.client,
            &self.accepted_roots(),
            "frontend",
            installed.as_ref(),
        )
        .await
    }

    /// Downloads a package listed in a verified manifest and holds it to the
    /// size and SHA-256 the manifest signed.
    async fn download_package(
        &self,
        package: &Package,
        staging_dir: &Path,
        maximum_bytes: u64,
    ) -> anyhow::Result<PathBuf> {
        if package.size > maximum_bytes {
            bail!(
                "The {} package is larger than this server accepts.",
                package.component
            );
        }
        let mut response = self
            .client
            .get(&package.url)
            .timeout(Duration::from_secs(10 * 60))
            .send()
            .await?
            .error_for_status()?;
        if response
            .content_length()
            .is_some_and(|content_length| content_length != package.size)
        {
            bail!("The downloaded update package size did not match the update manifest.");
        }

        let archive_path = staging_dir.join("package");
        let mut archive = fs::File::create(&archive_path).await?;
        let mut digest = Sha256::new();
        let mut downloaded = 0_u64;
        while let Some(chunk) = response.chunk().await? {
            downloaded = downloaded
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| anyhow!("The downloaded update package is too large."))?;
            if downloaded > package.size {
                bail!("The downloaded update package is larger than the update manifest says.");
            }
            digest.update(&chunk);
            tokio::io::AsyncWriteExt::write_all(&mut archive, &chunk).await?;
        }
        tokio::io::AsyncWriteExt::flush(&mut archive).await?;
        drop(archive);
        if downloaded != package.size {
            bail!("The downloaded update package size did not match the update manifest.");
        }
        let actual_digest = crate::hex_digest(digest.finalize());
        if !actual_digest.eq_ignore_ascii_case(&package.sha256) {
            bail!("The downloaded update package failed SHA-256 verification.");
        }
        Ok(archive_path)
    }

    fn managed_server_install(&self) -> anyhow::Result<ManagedInstall> {
        let install = managed_install(self.web_dist_dir.as_deref())?;
        self.ensure_updater_matches_server(&install.root)?;
        Ok(install)
    }

    fn ensure_updater_matches_server(&self, root: &Path) -> anyhow::Result<()> {
        const MESSAGE: &str = "Automatic install needs the standard layout: server.config in the install folder, used by the running server, with the same data folder and port. Update manually, or restart OperaLibre if you changed server.config.";
        let matches = || -> anyhow::Result<bool> {
            // The updater restarts here, so inherited relative paths must keep their meaning.
            if std::env::current_dir()?.canonicalize()? != root.canonicalize()? {
                return Ok(false);
            }
            let config_path = root.join("server.config");
            if !config_path.is_file()
                || self.config_path.as_deref() != Some(config_path.canonicalize()?.as_path())
            {
                return Ok(false);
            }
            // The launcher tolerates invalid values that would prevent the server starting.
            let restarted = crate::config::ServerConfig::load()?;
            let running_data_dir = self.data_dir.canonicalize()?;
            let (data_dir, port) = updater_settings(root)?;
            Ok(restarted.config_digest == self.config_digest
                && restarted.config_path == self.config_path
                && restarted.data_dir.canonicalize()? == running_data_dir
                && restarted.port == self.port
                && data_dir.canonicalize()? == running_data_dir
                && port == self.port)
        };
        if !matches().unwrap_or(false) {
            bail!(MESSAGE);
        }
        Ok(())
    }

    fn status_for_manifest(
        &self,
        manifest: &Manifest,
        channel: UpdateChannel,
    ) -> anyhow::Result<UpdateStatus> {
        let current = Version::parse(&current_version()).context("Invalid current version")?;
        let platform = platform_key().map(str::to_string);
        let package = platform
            .as_deref()
            .and_then(|platform| manifest.package("server", Some(platform), None));
        let latest_text = package.map_or(manifest.version.as_str(), |package| &package.version);
        let latest = Version::parse(latest_text).context("Invalid release version")?;
        let capability = validate_target(&current, &latest, channel, manifest)
            .and_then(|()| self.managed_server_install());
        let can_auto_update = package.is_some() && capability.is_ok();
        let message = if package.is_none() {
            Some(manifest_notice(manifest).unwrap_or_else(|| {
                "No automatic update package is available for this server platform.".to_string()
            }))
        } else {
            capability.err().map(|error| error.to_string())
        };
        Ok(UpdateStatus {
            channel,
            current_channel: UpdateChannel::for_version(&current),
            current_version: current.to_string(),
            latest_version: latest.to_string(),
            update_available: update_available(&current, &latest, channel),
            can_auto_update,
            platform,
            release_url: manifest.release_url.clone(),
            published_at: manifest.published.clone(),
            notes: manifest.notes.as_deref().map(truncate_notes),
            message,
            last_update_result: None,
        })
    }

    fn frontend_status_for_manifest(
        &self,
        manifest: &Manifest,
        reported_current_version: Option<&str>,
    ) -> anyhow::Result<FrontendUpdateStatus> {
        let installed_version = installed_frontend_version(self.web_dist_dir.as_deref());
        let installed_current = installed_version.as_ref().ok().cloned();
        let current_text = reported_current_version
            .map(normalize_version)
            .or(installed_current)
            .unwrap_or_else(current_version);
        let current =
            Version::parse(&current_text).context("Invalid installed frontend version")?;
        let package = manifest.package("frontend", None, None);
        let latest_text = package.map_or(manifest.version.as_str(), |package| &package.version);
        let latest = Version::parse(latest_text).context("Invalid release version")?;
        // A combined release package ships its own web bundle, and the server
        // update replaces it wholesale. Installing the frontend on its own
        // would only let it run ahead of the server it talks to.
        let combined_install = release_install(self.web_dist_dir.as_deref())
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
        let can_auto_update = package.is_some() && capability.is_ok();
        let message = if package.is_none() {
            Some(manifest_notice(manifest).unwrap_or_else(|| {
                "No automatic web frontend package is available for this release.".to_string()
            }))
        } else {
            capability.err().map(|error| error.to_string())
        };
        Ok(FrontendUpdateStatus {
            current_version: current.to_string(),
            latest_version: latest.to_string(),
            update_available: if combined_install {
                update_available(&current, &latest, UpdateChannel::for_version(&latest))
            } else {
                latest > current
            },
            can_auto_update,
            release_url: manifest.release_url.clone(),
            published_at: manifest.published.clone(),
            notes: manifest.notes.as_deref().map(truncate_notes),
            message,
        })
    }
}

/// The sync add-on runtime interface this server drives; see ADDON.json.
const SYNC_ADDON_PROTOCOL: u32 = 1;

fn sync_addon_package<'a>(manifest: &'a Manifest, platform: &str) -> anyhow::Result<&'a Package> {
    manifest
        .package("readalong-sync", Some(platform), Some(SYNC_ADDON_PROTOCOL))
        .ok_or_else(|| {
            anyhow!(
                "{}",
                manifest_notice(manifest).unwrap_or_else(|| {
                    "No sync add-on package is available for this server platform.".to_string()
                })
            )
        })
}

fn manifest_notice(manifest: &Manifest) -> Option<String> {
    manifest.notice.as_ref().map(|notice| match &notice.url {
        Some(url) => format!("{} {url}", notice.message),
        None => notice.message.clone(),
    })
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

struct InstalledSyncAddon {
    root: PathBuf,
    metadata: SyncAddonPackageMetadata,
    cli_path: PathBuf,
    cli_args: Vec<String>,
    ffmpeg_path: Option<PathBuf>,
}

fn installed_sync_addon() -> anyhow::Result<InstalledSyncAddon> {
    let root = std::env::current_exe()?
        .parent()
        .ok_or_else(|| anyhow!("The server executable has no installation folder."))?
        .join("addons/readalong-sync");
    let metadata: SyncAddonPackageMetadata = serde_json::from_slice(
        &std::fs::read(root.join("ADDON.json")).context("The sync add-on has no ADDON.json")?,
    )?;
    validate_installed_sync_addon(&root, metadata)
}

fn validate_installed_sync_addon(
    root: &Path,
    metadata: SyncAddonPackageMetadata,
) -> anyhow::Result<InstalledSyncAddon> {
    if metadata.schema_version != 1
        || metadata.id != "readalong-sync"
        || metadata.protocol_version != 1
        || platform_key() != Some(metadata.platform.as_str())
    {
        bail!("The installed sync add-on is not compatible with this server.");
    }
    Version::parse(&normalize_version(&metadata.version))
        .context("The installed sync add-on version is invalid")?;
    let cli_path = safe_addon_member(root, &metadata.cli)?;
    if !cli_path.is_file() {
        bail!("The installed sync add-on is missing its command-line program.");
    }
    let cli_args = metadata
        .cli_args
        .iter()
        .map(|path| safe_addon_member(root, path))
        .collect::<anyhow::Result<Vec<_>>>()?;
    if cli_args.iter().any(|path| !path.is_file()) {
        bail!("The installed sync add-on is missing a command-line program component.");
    }
    let ffmpeg_path = metadata
        .ffmpeg
        .as_deref()
        .map(|path| safe_addon_member(root, path))
        .transpose()?;
    if ffmpeg_path.as_ref().is_some_and(|path| !path.is_file()) {
        bail!("The installed sync add-on is missing ffmpeg.");
    }
    Ok(InstalledSyncAddon {
        root: root.to_path_buf(),
        metadata,
        cli_path,
        cli_args: cli_args
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
        ffmpeg_path,
    })
}

fn safe_addon_member(root: &Path, relative: &str) -> anyhow::Result<PathBuf> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        bail!("The sync add-on manifest contains an unsafe path.");
    }
    Ok(root.join(relative))
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

/// The configured web frontend folder, once it is known to hold a build this
/// server can replace in place.
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

// Mirrors launcher main.rs data_dir, configured_value_in, port_from and server_port.
// Keep the updater's rules here: it does not use OPERALIBRE_SERVER_CONFIG or cwd.
fn updater_settings(root: &Path) -> anyhow::Result<(PathBuf, u16)> {
    let contents = std::fs::read_to_string(root.join("server.config"))?;
    let value = |key: &str| {
        contents.lines().rev().find_map(|raw_line| {
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (candidate, value) = line.split_once('=')?;
            (candidate.trim().to_ascii_lowercase().replace('-', "_") == key)
                .then(|| crate::config::unquote_config_value(value.trim()))
        })
    };
    let data_dir = value("data_dir")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("OPERALIBRE_DATA_DIR").map(PathBuf::from))
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                root.join(path)
            }
        })
        .unwrap_or_else(|| root.join("data"));
    let port = [value("port"), std::env::var("PORT").ok()]
        .into_iter()
        .flatten()
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
        .and_then(|value| value.parse().ok())
        .unwrap_or(4920);
    Ok((data_dir, port))
}

fn managed_install(web_dist_dir: Option<&Path>) -> anyhow::Result<ManagedInstall> {
    let install = release_install(web_dist_dir)?;
    // Capability must not determine layout: a read-only combined install
    // still updates its server and bundled frontend together.
    ensure_install_root_is_writable_cached(&install.root)?;
    Ok(install)
}

fn release_install(web_dist_dir: Option<&Path>) -> anyhow::Result<ManagedInstall> {
    release_install_at(&std::env::current_exe()?, web_dist_dir)
}

fn release_install_at(
    executable: &Path,
    web_dist_dir: Option<&Path>,
) -> anyhow::Result<ManagedInstall> {
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

async fn validate_sync_addon_package(
    root: &Path,
    version: &str,
    platform: &str,
) -> anyhow::Result<SyncAddonPackageMetadata> {
    let metadata: SyncAddonPackageMetadata = serde_json::from_slice(
        &fs::read(root.join("ADDON.json"))
            .await
            .context("The sync add-on package has no ADDON.json manifest.")?,
    )?;
    if metadata.schema_version != 1
        || metadata.id != "readalong-sync"
        || normalize_version(&metadata.version) != version
        || metadata.platform != platform
        || metadata.protocol_version != 1
    {
        bail!("The sync add-on package metadata does not match this server or release.");
    }
    Ok(validate_installed_sync_addon(root, metadata)?.metadata)
}

async fn install_frontend_files(
    source: PathBuf,
    destination: PathBuf,
    data_dir: PathBuf,
) -> anyhow::Result<()> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("Could not create a frontend update timestamp")?
        .as_millis();
    let backup = data_dir
        .join("update-backups")
        .join(format!("{timestamp}-frontend"));
    tokio::task::spawn_blocking(move || {
        crate::update_backups::create_generation(&backup)?;
        swap_in_directory(
            &source,
            &destination,
            &backup.join("web"),
            timestamp,
            "web frontend",
            ".operalibre-frontend",
        )?;
        complete_update_backup(&backup);
        Ok(())
    })
    .await?
}

/// Copies `source` beside `destination` and renames it into place. An
/// existing `destination` is first copied to `backup`, then moved aside and
/// moved back if the new copy cannot be renamed in. `name` words the errors
/// and `prefix` names the temporary sibling folders.
fn swap_in_directory(
    source: &Path,
    destination: &Path,
    backup: &Path,
    timestamp: u128,
    name: &str,
    prefix: &str,
) -> anyhow::Result<()> {
    let parent = destination
        .parent()
        .ok_or_else(|| anyhow!("The {name} folder has no parent."))?;
    std::fs::create_dir_all(parent)?;
    let pid = std::process::id();
    let staged = parent.join(format!("{prefix}-staged-{pid}-{timestamp}"));
    let rollback = parent.join(format!("{prefix}-rollback-{pid}-{timestamp}"));
    if let Err(error) = copy_directory(source, &staged) {
        let _ = std::fs::remove_dir_all(&staged);
        return Err(error).with_context(|| format!("Could not stage the new {name}"));
    }
    if destination.exists() {
        let moved_aside = copy_directory(destination, backup)
            .with_context(|| format!("Could not create the {name} rollback copy"))
            .and_then(|()| {
                std::fs::rename(destination, &rollback)
                    .with_context(|| format!("Could not move the installed {name} aside"))
            });
        if let Err(error) = moved_aside {
            let _ = std::fs::remove_dir_all(&staged);
            return Err(error);
        }
    }
    if let Err(error) = std::fs::rename(&staged, destination) {
        let rollback_result = if rollback.exists() {
            std::fs::rename(&rollback, destination)
        } else {
            Ok(())
        };
        return match rollback_result {
            Ok(()) => Err(error).with_context(|| {
                format!("Could not install the {name}; the previous version was restored")
            }),
            Err(rollback_error) => Err(anyhow!(
                "Could not install the {name} ({error}) and could not restore the previous version ({rollback_error}). The rollback copy remains at {}.",
                backup.display()
            )),
        };
    }
    if rollback.exists()
        && let Err(error) = std::fs::remove_dir_all(&rollback)
    {
        tracing::warn!(
            "could not remove temporary {name} rollback folder {}: {error}",
            rollback.display()
        );
    }
    Ok(())
}

/// Both renames stay on their own volume; the backup is verified before
/// the live runtime is detached.
fn remove_sync_addon_files(source: &Path, backup_root: &Path) -> anyhow::Result<()> {
    crate::update_backups::create_generation(backup_root)?;
    let backup_parent = backup_root;
    let backup = backup_root.join("readalong-sync");
    let staging = tempfile::Builder::new()
        .prefix(".sync-backup-")
        .tempdir_in(backup_parent)?;
    let copy = staging.path().join("runtime");
    copy_directory(source, &copy)
        .context("Could not back up the sync runtime; installation retained")?;
    verify_directory_copy(source, &copy)?;
    anyhow::ensure!(
        !backup.exists(),
        "The sync backup already exists; installation retained"
    );
    std::fs::rename(&copy, &backup)?;
    let parent = source
        .parent()
        .context("The sync runtime has no parent directory")?;
    let removed = tempfile::Builder::new()
        .prefix(".removed-sync-")
        .tempdir_in(parent)?;
    std::fs::rename(source, removed.path().join("runtime"))
        .context("Could not detach the sync runtime; backup retained")?;
    if let Err(error) = removed.close() {
        tracing::warn!("The sync runtime was removed, but temporary file cleanup failed: {error}");
    }
    complete_update_backup(backup_root);
    Ok(())
}

fn complete_update_backup(backup: &Path) {
    if let Err(error) = crate::update_backups::complete_and_prune(backup) {
        tracing::warn!("could not finish pruning update backups: {error}");
    }
}

fn verify_directory_copy(source: &Path, destination: &Path) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let target = destination.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            verify_directory_copy(&entry.path(), &target)?;
        } else if kind.is_file() {
            anyhow::ensure!(
                file_digest(&entry.path())? == file_digest(&target)?,
                "Sync runtime backup verification failed; installation retained"
            );
        } else {
            bail!("Unsupported sync runtime entry; installation retained");
        }
    }
    Ok(())
}

fn file_digest(path: &Path) -> anyhow::Result<Vec<u8>> {
    let mut file = std::fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = std::io::Read::read(&mut file, &mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(digest.finalize().to_vec())
}

async fn install_sync_addon_files(
    source: PathBuf,
    destination: PathBuf,
    data_dir: PathBuf,
) -> anyhow::Result<()> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("Could not create a sync add-on update timestamp")?
        .as_millis();
    let backup = data_dir
        .join("update-backups")
        .join(format!("{timestamp}-readalong-sync"));
    tokio::task::spawn_blocking(move || {
        crate::update_backups::create_generation(&backup)?;
        swap_in_directory(
            &source,
            &destination,
            &backup.join("readalong-sync"),
            timestamp,
            "sync add-on",
            ".readalong-sync",
        )?;
        complete_update_backup(&backup);
        Ok(())
    })
    .await?
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

async fn make_sync_addon_executables(
    root: &Path,
    metadata: &SyncAddonPackageMetadata,
) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        for relative in std::iter::once(metadata.cli.as_str()).chain(metadata.ffmpeg.as_deref()) {
            let path = safe_addon_member(root, relative)?;
            let mut permissions = fs::metadata(&path).await?.permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).await?;
        }
    }
    Ok(())
}

async fn extract_package(
    archive_path: PathBuf,
    package: &Package,
    output: PathBuf,
    maximum_extracted_bytes: u64,
) -> anyhow::Result<()> {
    let format = package.archive_format().ok_or_else(|| {
        anyhow!(
            "The {} package uses an archive format this version cannot open.",
            package.component
        )
    })?;
    tokio::task::spawn_blocking(move || match format {
        ArchiveFormat::Zip => extract_zip(&archive_path, &output, maximum_extracted_bytes),
        ArchiveFormat::TarGz => extract_tar_gz(&archive_path, &output, maximum_extracted_bytes),
    })
    .await??;
    Ok(())
}

fn extract_zip(
    archive_path: &Path,
    output: &Path,
    maximum_extracted_bytes: u64,
) -> anyhow::Result<()> {
    std::fs::create_dir_all(output)?;
    let file = std::fs::File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut extracted_size = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        extracted_size = extracted_size
            .checked_add(entry.size())
            .ok_or_else(|| anyhow!("The extracted update package is too large."))?;
        if extracted_size > maximum_extracted_bytes {
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
}

/// Extracts only plain files and folders with relative paths: a link or an
/// absolute or `..` path could otherwise write outside the staging folder.
fn extract_tar_gz(
    archive_path: &Path,
    output: &Path,
    maximum_extracted_bytes: u64,
) -> anyhow::Result<()> {
    use std::path::Component;
    std::fs::create_dir_all(output)?;
    let file = std::fs::File::open(archive_path)?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let mut extracted_size = 0_u64;
    for entry in archive.entries()? {
        let mut entry = entry?;
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            bail!("The update archive contains a link or special file.");
        }
        let relative = entry.path()?.into_owned();
        if relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
        {
            bail!("The update archive contains an unsafe path.");
        }
        extracted_size = extracted_size
            .checked_add(entry.header().size()?)
            .ok_or_else(|| anyhow!("The extracted update package is too large."))?;
        if extracted_size > maximum_extracted_bytes {
            bail!("The extracted update package is too large.");
        }
        let target = output.join(&relative);
        if kind.is_dir() {
            std::fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut destination = std::fs::File::create(&target)?;
        std::io::copy(&mut entry, &mut destination)?;
        destination.flush()?;
        #[cfg(unix)]
        if entry.header().mode()? & 0o111 != 0 {
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))?;
        }
    }
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
    #[test]
    fn removal_keeps_a_verified_backup_and_leaves_maps_alone() {
        let install = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let source = install.path().join("runtime");
        let backups = data.path().join("update-backups");
        let old = backups.join("1-readalong-sync");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join(".completed"), b"").unwrap();
        let backup = backups.join("2-readalong-sync");
        std::fs::create_dir_all(source.join("nested")).unwrap();
        std::fs::write(source.join("nested/model"), b"runtime bytes").unwrap();
        std::fs::write(data.path().join("book.sync.json"), b"map").unwrap();
        super::remove_sync_addon_files(&source, &backup).unwrap();
        assert!(!source.exists());
        assert!(!old.exists());
        assert!(backup.join(".completed").is_file());
        assert_eq!(
            std::fs::read(backup.join("readalong-sync/nested/model")).unwrap(),
            b"runtime bytes"
        );
        assert_eq!(
            std::fs::read(data.path().join("book.sync.json")).unwrap(),
            b"map"
        );
    }

    #[test]
    fn a_failed_backup_preserves_the_installed_runtime() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("runtime");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("program"), b"original").unwrap();
        let blocked = root.path().join("not-a-directory");
        std::fs::write(&blocked, b"file").unwrap();
        assert!(super::remove_sync_addon_files(&source, &blocked.join("backup")).is_err());
        assert_eq!(std::fs::read(source.join("program")).unwrap(), b"original");
        let copy = root.path().join("copy");
        super::copy_directory(&source, &copy).unwrap();
        std::fs::write(copy.join("program"), b"corrupt!").unwrap();
        assert!(super::verify_directory_copy(&source, &copy).is_err());
    }

    #[tokio::test]
    async fn sync_jobs_exclude_runtime_changes_and_only_one_can_process() {
        let root = tempfile::tempdir().unwrap();
        let manager =
            UpdateManager::new(root.path().to_path_buf(), None, 4000, None, None).unwrap();
        let running = manager.sync_lifecycle.clone().read_owned().await;
        let queued = manager.sync_lifecycle.clone().read_owned().await;
        let slot = manager.sync_slots.try_acquire().unwrap();
        assert!(manager.sync_slots.try_acquire().is_err());
        for result in [
            manager.install_sync_addon().await,
            manager.remove_sync_addon().await,
            manager
                .set_sync_addon_enabled(false, &AlignmentConfig::Managed)
                .await,
        ] {
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("Wait for queued and running sync jobs")
            );
        }
        drop(slot);
        drop(running);
        assert!(manager.sync_slots.try_acquire().is_ok());
        assert!(manager.sync_lifecycle.try_write().is_err());
        drop(queued);
        let updating = manager.sync_lifecycle.write().await;
        assert!(manager.sync_lifecycle.clone().try_read_owned().is_err());
        drop(updating);
        assert!(manager.sync_lifecycle.clone().try_read_owned().is_ok());
    }

    #[tokio::test]
    async fn sync_runtime_replacement_preserves_previous_version_and_maps() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let installed = root.path().join("addons/readalong-sync");
        let data = root.path().join("data");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&installed).unwrap();
        std::fs::create_dir_all(data.join("sync")).unwrap();
        std::fs::write(source.join("runtime"), "new").unwrap();
        std::fs::write(installed.join("runtime"), "old").unwrap();
        std::fs::write(data.join("sync/book.sync.json"), "map").unwrap();
        let old = data.join("update-backups/1-readalong-sync");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join(".completed"), b"").unwrap();
        std::fs::write(old.join("runtime"), "older").unwrap();
        super::install_sync_addon_files(source, installed.clone(), data.clone())
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(installed.join("runtime")).unwrap(),
            "new"
        );
        assert!(!old.exists(), "older completed add-on backup was kept");
        let backup = std::fs::read_dir(data.join("update-backups"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(
            std::fs::read_to_string(backup.join("readalong-sync/runtime")).unwrap(),
            "old"
        );
        assert_eq!(
            std::fs::read_to_string(data.join("sync/book.sync.json")).unwrap(),
            "map"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sync_runtime_that_cannot_be_backed_up_stays_installed_without_staging_debris() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let addons = root.path().join("addons");
        let installed = addons.join("readalong-sync");
        let data = root.path().join("data");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&installed).unwrap();
        std::fs::write(source.join("runtime"), "new").unwrap();
        std::fs::write(installed.join("runtime"), "old").unwrap();
        // The backup copy refuses entries other than files and folders.
        std::os::unix::fs::symlink("runtime", installed.join("link")).unwrap();

        let old = data.join("update-backups/1-readalong-sync");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join(".completed"), b"").unwrap();
        let error = super::install_sync_addon_files(source, installed.clone(), data.clone())
            .await
            .unwrap_err();

        assert!(error.to_string().contains("rollback copy"), "{error:#}");
        assert!(old.join(".completed").is_file());
        for entry in std::fs::read_dir(data.join("update-backups")).unwrap() {
            let backup = entry.unwrap().path();
            if backup != old {
                assert!(!backup.join(".completed").exists());
            }
        }
        assert_eq!(
            std::fs::read_to_string(installed.join("runtime")).unwrap(),
            "old"
        );
        let siblings = std::fs::read_dir(&addons)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(siblings, ["readalong-sync"]);
    }

    use super::{
        AlignmentConfig, InstallGuard, InstallLayout, SyncAddonPackageMetadata, UpdateManager,
        extract_tar_gz, install_frontend_files, install_layout, installed_frontend_version,
        normalize_version, platform_key, prune_stale_staging, truncate_notes,
        validate_installed_sync_addon,
    };
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    #[test]
    fn automatic_install_layouts() {
        let scratch = tempfile::tempdir().unwrap();
        // Compile the launcher's actual resolver functions without modifying its crate.
        let launcher = include_str!("../../launcher/src/main.rs");
        let mut source = String::from("use std::{env, fs, path::{Path, PathBuf}};\n");
        for name in [
            "data_dir",
            "configured_port",
            "port_from",
            "configured_value",
            "configured_value_in",
            "unquote_config_value",
            "server_port",
        ] {
            let start = launcher.find(&format!("fn {name}(")).unwrap();
            let end = start + launcher[start..].find("\n}").unwrap() + 2;
            source.push_str(&launcher[start..end]);
            source.push('\n');
        }
        source.push_str("fn main() { let root = env::args_os().nth(1).unwrap(); let root = Path::new(&root); println!(\"{}\\n{}\", data_dir(root).display(), server_port(root)); }");
        let probe_source = scratch.path().join("launcher-probe.rs");
        let probe = scratch.path().join(super::exe_name("launcher-probe"));
        std::fs::write(&probe_source, source).unwrap();
        let compiled = std::process::Command::new("rustc")
            .args(["--edition=2024", "--crate-name", "launcher_probe"])
            .arg(&probe_source)
            .arg("-o")
            .arg(&probe)
            .output()
            .unwrap();
        assert!(
            compiled.status.success(),
            "{}",
            String::from_utf8_lossy(&compiled.stderr)
        );

        let mut failures = Vec::new();
        for scenario in [
            "standard",
            "missing-config",
            "other-config",
            "absolute-config",
            "relative-config-parent-cwd",
            "cwd-config",
            "edited-data",
            "edited-port",
            "edited-invalid-port",
            "edited-invalid-mode",
            "edited-host",
            "edited-library",
            "relative-env",
            "relative-env-other-cwd",
        ] {
            let root = scratch.path().join(scenario);
            std::fs::create_dir_all(root.join("data")).unwrap();
            std::fs::create_dir(root.join("library")).unwrap();
            std::fs::write(root.join("VERSION.txt"), super::current_version()).unwrap();
            if scenario == "standard" {
                std::fs::create_dir(root.join("web")).unwrap();
                std::fs::write(
                    root.join("server.config"),
                    include_str!("../../../release/combined.config"),
                )
                .unwrap();
            } else if scenario != "missing-config" {
                std::fs::write(root.join("server.config"), "").unwrap();
            }
            let executable = root.join(super::exe_name("operalibre-server"));
            std::fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
            let mut command = std::process::Command::new(&executable);
            command
                .args([
                    "--exact",
                    "updates::tests::automatic_install_layout_child",
                    "--nocapture",
                ])
                .current_dir(&root)
                .env("OPERALIBRE_LAYOUT_SCENARIO", scenario)
                .env("OPERALIBRE_LAYOUT_PROBE", &probe)
                .env_remove("OPERALIBRE_SERVER_CONFIG")
                .env_remove("OPERALIBRE_DATA_DIR")
                .env_remove("PORT");
            if matches!(scenario, "absolute-config" | "relative-env-other-cwd") {
                command.env("OPERALIBRE_SERVER_CONFIG", root.join("server.config"));
            }
            if scenario == "relative-config-parent-cwd" {
                std::fs::write(
                    root.join("server.config"),
                    format!("data_dir = {}\n", root.join("data").display()),
                )
                .unwrap();
                command.current_dir(scratch.path()).env(
                    "OPERALIBRE_SERVER_CONFIG",
                    format!("{scenario}/server.config"),
                );
            }
            if scenario == "other-config" {
                std::fs::write(root.join("other.config"), "").unwrap();
                command.env("OPERALIBRE_SERVER_CONFIG", root.join("other.config"));
            }
            if matches!(scenario, "cwd-config" | "relative-env-other-cwd") {
                let cwd = root.join("elsewhere");
                std::fs::create_dir(&cwd).unwrap();
                std::fs::write(cwd.join("server.config"), "").unwrap();
                command.current_dir(cwd);
            }
            if scenario.starts_with("relative-env") {
                command.env("OPERALIBRE_DATA_DIR", "env-data");
                std::fs::create_dir(root.join("env-data")).unwrap();
            }
            let output = command.output().unwrap();
            if !output.status.success() {
                failures.push(format!(
                    "{scenario}: {}\n{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            std::fs::remove_file(executable).unwrap();
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[tokio::test]
    async fn automatic_install_layout_child() {
        let Ok(scenario) = std::env::var("OPERALIBRE_LAYOUT_SCENARIO") else {
            return;
        };
        let executable = std::env::current_exe().unwrap();
        let root = executable.parent().unwrap();
        let config = crate::config::ServerConfig::load().unwrap();
        std::fs::create_dir_all(&config.data_dir).unwrap();
        let mut manager = UpdateManager::new(
            config.data_dir,
            config.web_dist_dir,
            config.port,
            config.config_path,
            config.config_digest,
        )
        .unwrap();
        let manifest = crate::update_manifest::unsigned_manifest(&format!(
            r#"{{"type":"manifest","schema":1,"version":"99.0.0",
            "releaseUrl":"https://example.com/release","packages":[{{"component":"server",
            "platform":"{}","version":"99.0.0","url":"https://example.com/server.zip",
            "sha256":"{}","size":1024,"format":"zip","root":"operalibre-99.0.0"}}]}}"#,
            platform_key().unwrap(),
            "c".repeat(64)
        ));
        let status = || {
            manager
                .status_for_manifest(&manifest, super::UpdateChannel::Stable)
                .unwrap()
        };
        if scenario.starts_with("edited-") {
            let before = status();
            assert!(before.can_auto_update, "standard layout before edit");
            *manager.cache.lock().await = Some(super::CachedUpdateStatus {
                checked_at: std::time::Instant::now(),
                status: before,
            });
            std::fs::create_dir(root.join("changed-data")).unwrap();
            std::fs::write(
                root.join("server.config"),
                match scenario.as_str() {
                    "edited-data" => "data_dir = changed-data\n",
                    "edited-port" => "port = 4921\n",
                    "edited-invalid-port" => "port = invalid\n",
                    "edited-invalid-mode" => "deployment_mode = invalid\n",
                    "edited-host" => "host = 192.0.2.1\n",
                    "edited-library" => "library_root = changed-library\n",
                    _ => unreachable!(),
                },
            )
            .unwrap();
        }
        let available = matches!(
            scenario.as_str(),
            "standard" | "absolute-config" | "relative-env"
        );
        let status = status();
        assert!(status.update_available);
        assert_eq!(
            status.can_auto_update, available,
            "{scenario}: {:?}",
            status.message
        );
        if scenario.starts_with("edited-") {
            let cached = manager.check(false).await.unwrap();
            assert!(
                !cached.can_auto_update,
                "cached release metadata must not hide config edits"
            );
            assert!(cached.message.unwrap().contains("standard layout"));
        }
        if !available {
            let message = status.message.unwrap();
            assert!(message.contains("standard layout") && message.contains("Update manually"));
        }
        // A local proxy makes any manifest request fail without contacting GitHub.
        // Supported layouts must pass the gate and reach that request as before.
        let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        manager.client = crate::http_client_builder()
            .proxy(reqwest::Proxy::all(format!("http://{}", proxy.local_addr().unwrap())).unwrap())
            .build()
            .unwrap();
        let proxy_task = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut stream, _) = proxy.accept().await.unwrap();
            let mut request = [0; 1024];
            let read = stream.read(&mut request).await.unwrap();
            assert!(
                String::from_utf8_lossy(&request[..read]).starts_with("CONNECT github.com:443")
            );
            stream
                .write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
                .await
                .unwrap();
        });
        let error = manager
            .install_prepared(
                super::UpdateInstallRequest {
                    channel: Some(super::UpdateChannel::Stable),
                    version: None,
                },
                async { panic!("unsupported setup must not pause sync or hand off") },
            )
            .await
            .unwrap_err();
        if available {
            assert!(
                error.downcast_ref::<reqwest::Error>().is_some(),
                "{error:#}"
            );
            proxy_task.await.unwrap();
        } else {
            assert!(error.to_string().contains("standard layout"), "{error:#}");
            proxy_task.abort();
            crate::http_tests::assert_unsupported_update_keeps_server_running(manager.clone())
                .await;
        }
        assert!(!manager.installing.load(Ordering::SeqCst));
        assert_eq!(*manager.sync_update_pause.borrow(), 0);
        assert!(!root.join("data/updates").exists());
        assert!(!root.join("data/update.log").exists());

        if scenario.starts_with("edited-invalid-") {
            assert_eq!(manager.port, 4920);
            assert!(crate::config::ServerConfig::load().is_err());
        }
        if matches!(
            scenario.as_str(),
            "edited-data" | "edited-port" | "edited-library"
        ) {
            let restarted = crate::config::ServerConfig::load().unwrap();
            let restarted = UpdateManager::new(
                restarted.data_dir,
                restarted.web_dist_dir,
                restarted.port,
                restarted.config_path,
                restarted.config_digest,
            )
            .unwrap();
            assert!(
                restarted
                    .status_for_manifest(&manifest, super::UpdateChannel::Stable)
                    .unwrap()
                    .can_auto_update
            );
        }
        if scenario != "standard" {
            return;
        }
        // Pin parsing, precedence and path resolution to the unmodified launcher.
        for (contents, data_env, port_env) in [
            ("", None, None),
            (
                "data_dir = custom\nport = 1234\n",
                Some("ignored"),
                Some("9876"),
            ),
            (
                "DATA-DIR = 'first'\ndata_dir = \"last\"\nPORT = 1\nport = '2345'\n",
                None,
                None,
            ),
            (
                "data_dir = ''\nport = \" \"\n",
                Some("relative-env"),
                Some("3456"),
            ),
            ("data_dir = ' data '\nport = invalid\n", None, Some("4567")),
            ("", Some(""), Some("invalid")),
        ] {
            std::fs::write(root.join("server.config"), contents).unwrap();
            // This process runs only this test, so no other threads read these variables.
            unsafe {
                match data_env {
                    Some(value) => std::env::set_var("OPERALIBRE_DATA_DIR", value),
                    None => std::env::remove_var("OPERALIBRE_DATA_DIR"),
                }
                match port_env {
                    Some(value) => std::env::set_var("PORT", value),
                    None => std::env::remove_var("PORT"),
                }
            }
            let (data, port) = super::updater_settings(root).unwrap();
            let output =
                std::process::Command::new(std::env::var_os("OPERALIBRE_LAYOUT_PROBE").unwrap())
                    .arg(root)
                    .output()
                    .unwrap();
            assert!(output.status.success());
            assert_eq!(
                String::from_utf8(output.stdout).unwrap(),
                format!("{}\n{port}\n", data.display())
            );
        }
    }

    #[test]
    fn unwritable_combined_installs_keep_their_bundled_frontend() {
        let root = tempfile::tempdir().unwrap();
        let web = root.path().join("web");
        std::fs::create_dir(&web).unwrap();
        std::fs::write(root.path().join("VERSION.txt"), super::current_version()).unwrap();
        // A directory at the probe path makes the capability check fail on
        // every platform, including test runners with elevated permissions.
        std::fs::create_dir(
            root.path()
                .join(format!(".operalibre-update-probe-{}", std::process::id())),
        )
        .unwrap();
        assert!(super::ensure_install_root_is_writable(root.path()).is_err());
        let install =
            super::release_install_at(&root.path().join("operalibre-server"), Some(&web)).unwrap();
        assert_eq!(install.layout, InstallLayout::Combined);
    }

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
    fn sync_addon_manifest_paths_cannot_escape_the_package() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("generator"), []).unwrap();
        std::fs::write(root.path().join("launcher.js"), []).unwrap();
        let metadata = |cli: &str, cli_args: Vec<String>| SyncAddonPackageMetadata {
            schema_version: 1,
            id: "readalong-sync".to_string(),
            version: "1.2.3".to_string(),
            platform: platform_key().unwrap().to_string(),
            protocol_version: 1,
            cli: cli.to_string(),
            cli_args,
            ffmpeg: None,
        };

        assert!(
            validate_installed_sync_addon(
                root.path(),
                metadata("generator", vec!["launcher.js".to_string()]),
            )
            .is_ok()
        );
        assert!(
            validate_installed_sync_addon(root.path(), metadata("../generator", Vec::new()))
                .is_err()
        );
        assert!(
            validate_installed_sync_addon(root.path(), metadata("/tmp/generator", Vec::new()))
                .is_err()
        );
        assert!(
            validate_installed_sync_addon(
                root.path(),
                metadata("generator", vec!["../launcher.js".to_string()]),
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn channel_changes_cannot_race_an_install_and_stale_requests_are_refused() {
        let root = tempfile::tempdir().unwrap();
        let manager =
            UpdateManager::new(root.path().to_path_buf(), None, 4000, None, None).unwrap();
        let guard = super::InstallGuard::acquire(&manager.installing).unwrap();
        assert!(
            manager
                .set_channel(super::UpdateChannel::Nightly)
                .await
                .is_err()
        );
        assert!(!root.path().join("update-channel.json").exists());
        drop(guard);
        manager
            .set_channel(super::UpdateChannel::Nightly)
            .await
            .unwrap();
        let error = manager
            .install_prepared(
                super::UpdateInstallRequest {
                    channel: Some(super::UpdateChannel::Stable),
                    version: Some("1.0.0".into()),
                },
                std::future::pending(),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("selected channel changed"));
        manager
            .set_channel(super::UpdateChannel::Stable)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn completed_update_result_bypasses_the_release_cache() {
        let root = tempfile::tempdir().unwrap();
        let manager =
            UpdateManager::new(root.path().to_path_buf(), None, 4000, None, None).unwrap();
        assert!(manager.last_update_result().await.is_none());
        *manager.cache.lock().await = Some(super::CachedUpdateStatus {
            checked_at: std::time::Instant::now(),
            status: super::UpdateStatus {
                channel: super::UpdateChannel::Stable,
                current_channel: super::UpdateChannel::Stable,
                current_version: "0.3.7".into(),
                latest_version: "0.3.8".into(),
                update_available: true,
                can_auto_update: true,
                platform: None,
                release_url: String::new(),
                published_at: None,
                notes: None,
                message: None,
                last_update_result: Some("old result".into()),
            },
        });
        std::fs::write(
            root.path().join("update-result.txt"),
            "Failed: restored previous version\n",
        )
        .unwrap();
        assert_eq!(
            manager
                .check(false)
                .await
                .unwrap()
                .last_update_result
                .as_deref(),
            Some("Failed: restored previous version")
        );
        std::fs::write(root.path().join("update-result.txt"), "Succeeded: 0.3.8\n").unwrap();
        assert_eq!(
            manager
                .check(false)
                .await
                .unwrap()
                .last_update_result
                .as_deref(),
            Some("Succeeded: 0.3.8")
        );
        std::fs::write(root.path().join("update-result.txt"), vec![b'x'; 65537]).unwrap();
        assert!(manager.last_update_result().await.is_none());
    }

    #[tokio::test]
    async fn path_runtime_stays_enabled_after_upgrade() {
        for legacy in [None, Some(r#"{"readalongSyncEnabled":false}"#)] {
            let root = tempfile::tempdir().unwrap();
            let cli = root.path().join("echogarden");
            std::fs::write(&cli, []).unwrap();
            if let Some(settings) = legacy {
                std::fs::write(root.path().join("experimental-features.json"), settings).unwrap();
            }
            let manager =
                UpdateManager::new(root.path().to_path_buf(), None, 4000, None, None).unwrap();
            let config = AlignmentConfig::Path(cli.clone());
            let status = manager.check_sync_addon(false, &config).await.unwrap();
            assert!(status.installed);
            assert!(status.enabled);
            assert!(!status.managed);
            assert!(status.can_toggle);
            assert_eq!(
                status.message.as_deref(),
                Some("Using echogarden found on the server's PATH.")
            );
            assert_eq!(
                manager.sync_addon_runtime(&config).await.unwrap().cli_path,
                cli
            );
        }
    }

    #[tokio::test]
    async fn path_runtime_opt_out_is_durable_and_reversible() {
        let root = tempfile::tempdir().unwrap();
        let cli = root.path().join("echogarden");
        std::fs::write(&cli, []).unwrap();
        let config = AlignmentConfig::Path(cli.clone());
        let settings_path = root.path().join("experimental-features.json");
        std::fs::write(&settings_path, r#"{"readalongSyncEnabled":true}"#).unwrap();
        for enabled in [false, true] {
            let manager =
                UpdateManager::new(root.path().to_path_buf(), None, 4000, None, None).unwrap();
            let status = manager
                .set_sync_addon_enabled(enabled, &config)
                .await
                .unwrap();
            assert_eq!(status.enabled, enabled);
            let saved: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&settings_path).unwrap()).unwrap();
            assert_eq!(saved["pathRuntimeDisabled"], !enabled);
            assert_eq!(saved["readalongSyncEnabled"], true);
            let restarted =
                UpdateManager::new(root.path().to_path_buf(), None, 4000, None, None).unwrap();
            assert_eq!(
                restarted
                    .check_sync_addon(false, &config)
                    .await
                    .unwrap()
                    .enabled,
                enabled
            );
            assert_eq!(
                restarted.sync_addon_runtime(&config).await.is_some(),
                enabled
            );
        }
    }

    #[tokio::test]
    async fn a_manually_configured_sync_generator_stays_enabled() {
        let root = tempfile::tempdir().unwrap();
        let cli = root.path().join("echogarden");
        std::fs::write(&cli, []).unwrap();
        std::fs::write(
            root.path().join("experimental-features.json"),
            r#"{"readalongSyncEnabled":false,"pathRuntimeDisabled":true}"#,
        )
        .unwrap();
        let manager =
            UpdateManager::new(root.path().to_path_buf(), None, 4000, None, None).unwrap();
        let config = AlignmentConfig::Manual(cli.clone());
        let status = manager.check_sync_addon(false, &config).await.unwrap();
        assert!(status.installed);
        assert!(status.enabled);
        assert!(!status.managed);
        assert!(!status.can_toggle);
        assert_eq!(
            status.message.as_deref(),
            Some("This generator is configured manually in server.config and is always enabled.")
        );
        assert_eq!(
            manager.sync_addon_runtime(&config).await.unwrap().cli_path,
            cli
        );
        assert!(
            manager
                .set_sync_addon_enabled(false, &config)
                .await
                .unwrap_err()
                .to_string()
                .contains("always enabled")
        );
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

        let old = data.join("update-backups/1-frontend");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join(".completed"), b"").unwrap();
        std::fs::write(old.join("previous-files"), b"older frontend").unwrap();

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
        assert!(backups[0].path().join(".completed").is_file());
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
        let manager =
            UpdateManager::new(root.path().join("data"), Some(web), 4000, None, None).unwrap();
        let manifest = crate::update_manifest::unsigned_manifest(&format!(
            r#"{{"type":"manifest","schema":1,"version":"2.0.0",
            "releaseUrl":"https://github.com/DonovanMontoya/OperaLibre/releases/tag/2.0.0",
            "packages":[{{"component":"frontend","platform":"any","version":"2.0.0",
            "url":"https://example.com/frontend.zip","sha256":"{}","size":1024,
            "format":"zip","root":"operalibre-2.0.0-frontend"}}]}}"#,
            "c".repeat(64)
        ));

        let status = manager
            .frontend_status_for_manifest(&manifest, Some("1.5.0"))
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

    /// Path, kind, contents and link target of one archive entry.
    type TarEntry<'a> = (&'a str, tar::EntryType, &'a [u8], Option<&'a str>);

    fn tar_gz(entries: &[TarEntry]) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::fast(),
        ));
        for (path, kind, bytes, link) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(*kind);
            header.set_size(bytes.len() as u64);
            header.set_mode(0o755);
            if let Some(link) = link {
                header.set_link_name(link).unwrap();
            }
            // Written raw: the builder's own path checks would refuse the
            // unsafe names these tests need.
            let name = &mut header.as_old_mut().name;
            name[..path.len()].copy_from_slice(path.as_bytes());
            header.set_cksum();
            builder.append(&header, *bytes).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn tar_packages_extract_files_and_executable_bits() {
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("package.tar.gz");
        std::fs::write(
            &archive,
            tar_gz(&[
                ("pkg/", tar::EntryType::Directory, b"", None),
                (
                    "pkg/operalibre-server",
                    tar::EntryType::Regular,
                    b"server",
                    None,
                ),
                ("pkg/web/index.html", tar::EntryType::Regular, b"web", None),
            ]),
        )
        .unwrap();
        let output = root.path().join("out");
        extract_tar_gz(&archive, &output, 1024).unwrap();
        assert_eq!(
            std::fs::read(output.join("pkg/operalibre-server")).unwrap(),
            b"server"
        );
        assert_eq!(
            std::fs::read(output.join("pkg/web/index.html")).unwrap(),
            b"web"
        );
        #[cfg(unix)]
        assert_eq!(
            std::fs::metadata(output.join("pkg/operalibre-server"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
    }

    #[test]
    fn tar_packages_cannot_escape_or_link_out_of_staging() {
        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("package.tar.gz");
        let cases: [&[TarEntry]; 4] = [
            &[("../escape", tar::EntryType::Regular, b"x", None)],
            &[("/absolute", tar::EntryType::Regular, b"x", None)],
            &[(
                "pkg/link",
                tar::EntryType::Symlink,
                b"",
                Some("/etc/passwd"),
            )],
            &[("pkg/hard", tar::EntryType::Link, b"", Some("../escape"))],
        ];
        for entries in cases {
            std::fs::write(&archive, tar_gz(entries)).unwrap();
            let output = root.path().join("out");
            assert!(
                extract_tar_gz(&archive, &output, 1024).is_err(),
                "{:?}",
                entries[0].0
            );
        }
        assert!(!root.path().join("escape").exists());

        std::fs::write(
            &archive,
            tar_gz(&[("pkg/big", tar::EntryType::Regular, &[0; 2048], None)]),
        )
        .unwrap();
        assert!(extract_tar_gz(&archive, &root.path().join("big"), 1024).is_err());
    }
}
