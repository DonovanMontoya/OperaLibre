//! Server configuration: deployment modes, transfer limits, and the config
//! file and environment parsing behind them.

use crate::*;

pub(crate) const GIBIBYTE_BYTES: u64 = 1024 * 1024 * 1024;

pub(crate) const DEFAULT_MAX_UPLOAD_GIB: u64 = 20;

pub(crate) const DEFAULT_MAX_BOOK_DOWNLOAD_GIB: u64 = 25;

pub(crate) const DEFAULT_MAX_CONCURRENT_BOOK_DOWNLOADS: usize = 1;

pub(crate) const DEFAULT_MIN_DOWNLOAD_FREE_GIB: u64 = 2;

pub(crate) const MAX_CONFIGURED_BOOK_DOWNLOAD_CONCURRENCY: usize = 32;

pub(crate) const SETUP_TOKEN_LIFETIME_SECONDS: u64 = 30 * 60;

#[derive(Debug, Clone)]
pub(crate) struct ServerConfig {
    pub(crate) deployment_mode: DeploymentMode,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) max_upload_bytes: Option<u64>,
    pub(crate) max_book_download_bytes: Option<u64>,
    pub(crate) max_concurrent_book_downloads: usize,
    pub(crate) download_temp_dir: PathBuf,
    pub(crate) min_download_free_bytes: u64,
    pub(crate) library_root: PathBuf,
    pub(crate) data_dir: PathBuf,
    pub(crate) progress_file: PathBuf,
    pub(crate) users_file: PathBuf,
    pub(crate) sessions_file: PathBuf,
    pub(crate) activity_file: PathBuf,
    pub(crate) metadata_overrides_file: PathBuf,
    pub(crate) libation_requests_file: PathBuf,
    pub(crate) libation_cli_path: Option<PathBuf>,
    pub(crate) libation_files_dir: Option<PathBuf>,
    pub(crate) libation_auto_refresh_hours: u64,
    pub(crate) libation_reader_refreshes_per_hour: u64,
    pub(crate) alignment_cli_path: Option<PathBuf>,
    pub(crate) ffmpeg_path: Option<PathBuf>,
    pub(crate) ffprobe_path: Option<PathBuf>,
    pub(crate) allowed_origins: Vec<String>,
    pub(crate) web_dist_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeploymentMode {
    Local,
    Lan,
    Proxy,
}

impl DeploymentMode {
    pub(crate) fn parse(value: &str) -> anyhow::Result<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "local" => Ok(Self::Local),
            "lan" => Ok(Self::Lan),
            "proxy" => Ok(Self::Proxy),
            _ => anyhow::bail!(
                "Invalid deployment_mode `{value}`: expected `local`, `lan`, or `proxy`."
            ),
        }
    }

    pub(crate) fn default_host(self) -> &'static str {
        match self {
            Self::Lan => "0.0.0.0",
            Self::Local | Self::Proxy => "127.0.0.1",
        }
    }

    pub(crate) fn secure_cookies(self) -> bool {
        !matches!(self, Self::Lan)
    }

    pub(crate) fn allows_remote_setup(self) -> bool {
        !matches!(self, Self::Local)
    }

    pub(crate) fn setup_token_required(self, remote_client: bool) -> bool {
        matches!(self, Self::Proxy) || (matches!(self, Self::Lan) && remote_client)
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Lan => "lan",
            Self::Proxy => "proxy",
        }
    }
}

pub(crate) fn resolve_deployment_settings(
    configured_mode: Option<String>,
    configured_host: Option<String>,
) -> anyhow::Result<(DeploymentMode, String)> {
    let deployment_mode = configured_mode
        .map(|value| DeploymentMode::parse(&value))
        .transpose()?
        .unwrap_or_else(|| {
            configured_host
                .as_deref()
                .and_then(|host| host.parse::<IpAddr>().ok())
                .filter(|address| !address.is_loopback())
                .map(|_| DeploymentMode::Lan)
                .unwrap_or(DeploymentMode::Local)
        });
    let host = configured_host.unwrap_or_else(|| deployment_mode.default_host().to_string());
    let host_address = host.parse::<IpAddr>().map_err(|error| {
        anyhow::anyhow!("Invalid server host `{host}`: use a numeric IP address ({error})")
    })?;
    if matches!(
        deployment_mode,
        DeploymentMode::Local | DeploymentMode::Proxy
    ) && !host_address.is_loopback()
    {
        anyhow::bail!(
            "deployment_mode = {} requires a loopback host such as 127.0.0.1; use deployment_mode = lan for a direct trusted-network listener",
            deployment_mode.as_str()
        );
    }
    Ok((deployment_mode, host))
}

#[derive(Debug)]
pub(crate) struct SetupToken {
    pub(crate) digest: [u8; 32],
    pub(crate) expires_at: u64,
}

impl SetupToken {
    pub(crate) fn new(token: &str, now_seconds: u64) -> Self {
        Self {
            digest: setup_token_digest(token),
            expires_at: now_seconds.saturating_add(SETUP_TOKEN_LIFETIME_SECONDS),
        }
    }

    pub(crate) fn matches(&self, candidate: &str, now_seconds: u64) -> bool {
        now_seconds <= self.expires_at
            && constant_time_eq(&self.digest, &setup_token_digest(candidate))
    }
}

impl ServerConfig {
    pub(crate) fn load() -> anyhow::Result<Self> {
        let current_dir = env::current_dir()?;
        let explicit_config_path = env::var_os("OPERALIBRE_SERVER_CONFIG").map(PathBuf::from);
        let config_path = explicit_config_path
            .clone()
            .unwrap_or_else(|| current_dir.join("server.config"));
        let config_dir = config_path
            .parent()
            .map(FsPath::to_path_buf)
            .unwrap_or_else(|| current_dir.clone());
        let values = read_server_config_file(&config_path, explicit_config_path.is_some())?;

        let library_root = config_path_value(&values, &config_dir, "library_root")
            .or_else(|| config_path_value(&values, &config_dir, "audiobook_library"))
            .or_else(|| env_path_value("OPERALIBRE_LIBRARY"))
            .unwrap_or_else(|| current_dir.join("library"));
        let data_dir = config_path_value(&values, &config_dir, "data_dir")
            .or_else(|| env_path_value("OPERALIBRE_DATA_DIR"))
            .unwrap_or_else(|| current_dir.join("data"));
        let progress_file = config_path_value(&values, &config_dir, "progress_file")
            .or_else(|| env_path_value("OPERALIBRE_PROGRESS_FILE"))
            .unwrap_or_else(|| data_dir.join("progress.json"));
        let users_file = config_path_value(&values, &config_dir, "users_file")
            .or_else(|| env_path_value("OPERALIBRE_USERS_FILE"))
            .unwrap_or_else(|| data_dir.join("users.json"));
        let sessions_file = data_dir.join("sessions.json");
        let activity_file = config_path_value(&values, &config_dir, "activity_file")
            .or_else(|| env_path_value("OPERALIBRE_ACTIVITY_FILE"))
            .unwrap_or_else(|| data_dir.join("activity.json"));
        let metadata_overrides_file =
            config_path_value(&values, &config_dir, "metadata_overrides_file")
                .or_else(|| env_path_value("OPERALIBRE_METADATA_OVERRIDES_FILE"))
                .unwrap_or_else(|| data_dir.join("metadata-overrides.json"));
        let libation_requests_file = data_dir.join("libation-requests.json");
        let libation_auto_refresh_hours = config_u64_value(&values, "libation_auto_refresh_hours")?
            .unwrap_or(DEFAULT_LIBATION_AUTO_REFRESH_HOURS);
        let libation_reader_refreshes_per_hour =
            config_u64_value(&values, "libation_reader_refreshes_per_hour")?
                .unwrap_or(DEFAULT_LIBATION_READER_REFRESHES_PER_HOUR);

        let configured_host =
            config_string_value(&values, "host").or_else(|| env_string_value("HOST"));
        let configured_mode = config_string_value(&values, "deployment_mode")
            .or_else(|| env_string_value("OPERALIBRE_DEPLOYMENT_MODE"));
        let (deployment_mode, host) =
            resolve_deployment_settings(configured_mode, configured_host)?;
        let max_upload_bytes = config_gib_limit(&values, "max_upload_gib", DEFAULT_MAX_UPLOAD_GIB)?;
        let max_book_download_bytes = config_gib_limit(
            &values,
            "max_book_download_gib",
            DEFAULT_MAX_BOOK_DOWNLOAD_GIB,
        )?;
        let max_concurrent_book_downloads = config_bounded_usize(
            &values,
            "max_concurrent_book_downloads",
            DEFAULT_MAX_CONCURRENT_BOOK_DOWNLOADS,
            1,
            MAX_CONFIGURED_BOOK_DOWNLOAD_CONCURRENCY,
        )?;
        let download_temp_dir = config_path_value(&values, &config_dir, "download_temp_dir")
            .or_else(|| env_path_value("OPERALIBRE_DOWNLOAD_TEMP_DIR"))
            .unwrap_or_else(|| data_dir.join("download-temp"));
        let min_download_free_gib = config_u64_value(&values, "min_download_free_gib")?
            .unwrap_or(DEFAULT_MIN_DOWNLOAD_FREE_GIB);
        let min_download_free_bytes = min_download_free_gib
            .checked_mul(GIBIBYTE_BYTES)
            .ok_or_else(|| anyhow::anyhow!(
                "Invalid server.config `min_download_free_gib` value `{min_download_free_gib}`: size overflows bytes"
            ))?;

        Ok(Self {
            deployment_mode,
            host,
            port: match config_u16_value(&values, "port")? {
                Some(port) => port,
                None => env_u16_value("PORT")?.unwrap_or(4000),
            },
            max_upload_bytes,
            max_book_download_bytes,
            max_concurrent_book_downloads,
            download_temp_dir,
            min_download_free_bytes,
            library_root,
            data_dir,
            progress_file,
            users_file,
            sessions_file,
            activity_file,
            metadata_overrides_file,
            libation_requests_file,
            libation_cli_path: config_path_value(&values, &config_dir, "libation_cli_path")
                .or_else(|| env_path_value("LIBATION_CLI_PATH")),
            libation_files_dir: config_path_value(&values, &config_dir, "libation_files_dir")
                .or_else(|| env_path_value("LIBATION_FILES_DIR")),
            libation_auto_refresh_hours,
            libation_reader_refreshes_per_hour,
            alignment_cli_path: config_path_value(&values, &config_dir, "alignment_cli_path")
                .or_else(|| env_path_value("OPERALIBRE_ALIGNMENT_CLI_PATH")),
            ffmpeg_path: config_path_value(&values, &config_dir, "ffmpeg_path")
                .or_else(|| env_path_value("OPERALIBRE_FFMPEG_PATH")),
            ffprobe_path: config_path_value(&values, &config_dir, "ffprobe_path")
                .or_else(|| env_path_value("OPERALIBRE_FFPROBE_PATH")),
            allowed_origins: normalize_allowed_origins(
                config_string_value(&values, "allowed_origins")
                    .or_else(|| env_string_value("OPERALIBRE_ALLOWED_ORIGINS"))
                    .map(parse_origin_list)
                    .unwrap_or_default(),
            )?,
            web_dist_dir: config_path_value(&values, &config_dir, "web_dist_dir")
                .or_else(|| env_path_value("OPERALIBRE_WEB_DIST_DIR")),
        })
    }
}

pub(crate) fn read_server_config_file(
    config_path: &FsPath,
    explicit: bool,
) -> anyhow::Result<HashMap<String, String>> {
    let contents = match std::fs::read_to_string(config_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound && !explicit => {
            return Ok(HashMap::new());
        }
        Err(error) => return Err(error.into()),
    };

    parse_server_config(&contents)
}

pub(crate) fn parse_server_config(contents: &str) -> anyhow::Result<HashMap<String, String>> {
    let allowed_keys = [
        "deployment_mode",
        "host",
        "port",
        "max_upload_gib",
        "max_book_download_gib",
        "max_concurrent_book_downloads",
        "download_temp_dir",
        "min_download_free_gib",
        "library_root",
        "audiobook_library",
        "data_dir",
        "progress_file",
        "users_file",
        "activity_file",
        "metadata_overrides_file",
        "libation_cli_path",
        "libation_files_dir",
        "libation_auto_refresh_hours",
        "libation_reader_refreshes_per_hour",
        "alignment_cli_path",
        "ffmpeg_path",
        "ffprobe_path",
        "allowed_origins",
        "web_dist_dir",
    ];
    let mut values = HashMap::new();

    for (index, raw_line) in contents.lines().enumerate() {
        let line_number = index + 1;
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let Some((key, value)) = line.split_once('=') else {
            anyhow::bail!("Invalid server.config line {line_number}: expected `key = value`.");
        };
        let key = key.trim().to_ascii_lowercase().replace('-', "_");
        if key.is_empty() {
            anyhow::bail!("Invalid server.config line {line_number}: setting name is empty.");
        }
        if !allowed_keys.contains(&key.as_str()) {
            anyhow::bail!("Unknown server.config setting `{key}` on line {line_number}.");
        }

        values.insert(key, unquote_config_value(value.trim()));
    }

    Ok(values)
}

pub(crate) fn unquote_config_value(value: &str) -> String {
    if value.len() >= 2 {
        let first = value.as_bytes()[0];
        let last = value.as_bytes()[value.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

pub(crate) fn config_string_value(values: &HashMap<String, String>, key: &str) -> Option<String> {
    values
        .get(key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn env_string_value(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn config_u16_value(
    values: &HashMap<String, String>,
    key: &str,
) -> anyhow::Result<Option<u16>> {
    let Some(value) = config_string_value(values, key) else {
        return Ok(None);
    };
    Ok(Some(value.parse::<u16>().map_err(|error| {
        anyhow::anyhow!("Invalid server.config `{key}` value `{value}`: {error}")
    })?))
}

pub(crate) fn config_u64_value(
    values: &HashMap<String, String>,
    key: &str,
) -> anyhow::Result<Option<u64>> {
    let Some(value) = config_string_value(values, key) else {
        return Ok(None);
    };
    value
        .parse::<u64>()
        .map(Some)
        .map_err(|error| anyhow::anyhow!("Invalid server.config `{key}` value `{value}`: {error}"))
}

pub(crate) fn config_gib_limit(
    values: &HashMap<String, String>,
    key: &str,
    default_gib: u64,
) -> anyhow::Result<Option<u64>> {
    let gib = config_u64_value(values, key)?.unwrap_or(default_gib);
    if gib == 0 {
        return Ok(None);
    }
    gib.checked_mul(GIBIBYTE_BYTES).map(Some).ok_or_else(|| {
        anyhow::anyhow!("Invalid server.config `{key}` value `{gib}`: size overflows bytes")
    })
}

pub(crate) fn config_bounded_usize(
    values: &HashMap<String, String>,
    key: &str,
    default: usize,
    minimum: usize,
    maximum: usize,
) -> anyhow::Result<usize> {
    let value = config_u64_value(values, key)?
        .map(usize::try_from)
        .transpose()
        .map_err(|error| anyhow::anyhow!("Invalid server.config `{key}` value: {error}"))?
        .unwrap_or(default);
    if !(minimum..=maximum).contains(&value) {
        anyhow::bail!(
            "Invalid server.config `{key}` value `{value}`: expected {minimum} through {maximum}"
        );
    }
    Ok(value)
}

/// A malformed value is an error, as it is in the config file: silently
/// falling back to the default would start the server on a port nobody asked
/// for.
pub(crate) fn env_u16_value(key: &str) -> anyhow::Result<Option<u16>> {
    let Some(value) = env_string_value(key) else {
        return Ok(None);
    };
    value
        .parse::<u16>()
        .map(Some)
        .map_err(|error| anyhow::anyhow!("Invalid {key} environment value `{value}`: {error}"))
}

pub(crate) fn config_path_value(
    values: &HashMap<String, String>,
    config_dir: &FsPath,
    key: &str,
) -> Option<PathBuf> {
    values
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| resolve_config_path(config_dir, value))
}

pub(crate) fn env_path_value(key: &str) -> Option<PathBuf> {
    env::var_os(key)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub(crate) fn parse_origin_list(value: String) -> Vec<String> {
    value
        .split(',')
        .map(|origin| origin.trim().trim_end_matches('/'))
        .filter(|origin| !origin.is_empty())
        .map(str::to_string)
        .collect()
}

/// Check and canonicalise the configured origins once, so the CORS allow-list
/// and the CSRF check see the same values. An origin is a scheme and an
/// authority and nothing else; a lowercased copy of exactly that is kept.
pub(crate) fn normalize_allowed_origins(origins: Vec<String>) -> anyhow::Result<Vec<String>> {
    let mut normalized = Vec::with_capacity(origins.len());
    for origin in origins {
        let parsed = origin.parse::<axum::http::Uri>().map_err(|error| {
            anyhow::anyhow!("Invalid allowed_origins entry `{origin}`: {error}")
        })?;
        let (Some(scheme), Some(authority)) = (parsed.scheme_str(), parsed.authority()) else {
            anyhow::bail!(
                "Invalid allowed_origins entry `{origin}`: an origin needs a scheme and a host, such as https://reader.example"
            );
        };
        if !matches!(parsed.path(), "" | "/") || parsed.query().is_some() {
            anyhow::bail!(
                "Invalid allowed_origins entry `{origin}`: an origin has no path or query"
            );
        }
        let canonical = format!("{scheme}://{authority}").to_ascii_lowercase();
        if !normalized.contains(&canonical) {
            normalized.push(canonical);
        }
    }
    Ok(normalized)
}

pub(crate) fn resolve_config_path(config_dir: &FsPath, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        config_dir.join(path)
    }
}
