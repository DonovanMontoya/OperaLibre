use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

/// The deployment both the server and its updater must use. Explicit config
/// paths are relative to the caller, while config values are relative to the file.
pub(crate) struct DeploymentConfig {
    pub(crate) config_path: PathBuf,
    pub(crate) data_dir: PathBuf,
    pub(crate) port: u16,
}

impl DeploymentConfig {
    pub(crate) fn load(root: &Path) -> Result<Self, String> {
        Self::read(root, true)
    }

    /// Paths only, for stopping and logging. Those must keep working with a
    /// config the server would reject, so an unreadable file reads as empty
    /// and an unparsable port falls back to the default.
    // The server shares this file but never stops a server.
    #[allow(dead_code)]
    pub(crate) fn load_paths(root: &Path) -> Result<Self, String> {
        Self::read(root, false)
    }

    fn read(root: &Path, strict: bool) -> Result<Self, String> {
        let current_dir = env::current_dir().map_err(|error| error.to_string())?;
        let root = current_dir.join(root);
        let explicit = env::var_os("OPERALIBRE_SERVER_CONFIG");
        let fallback_dir = if explicit.is_some() {
            &current_dir
        } else {
            &root
        };
        let config_path = match explicit.as_ref() {
            Some(path) => current_dir.join(path),
            None => root.join("server.config"),
        };
        let contents = match fs::read_to_string(&config_path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && explicit.is_none() => {
                String::new()
            }
            Err(_) if !strict => String::new(),
            Err(error) => {
                return Err(format!(
                    "Could not read {}: {error}. Restore this config file before installing an update.",
                    config_path.display()
                ));
            }
        };
        let config_dir = config_path.parent().unwrap_or(&root);
        let data_dir = configured_value_in(&contents, "data_dir")
            .filter(|value| !value.trim().is_empty())
            .map(|value| config_dir.join(value.trim()))
            .or_else(|| {
                env::var_os("OPERALIBRE_DATA_DIR")
                    .filter(|value| !value.is_empty())
                    .map(|value| fallback_dir.join(value))
            })
            .unwrap_or_else(|| fallback_dir.join("data"));
        let port = port_from(
            configured_value_in(&contents, "port"),
            env::var("PORT").ok(),
        );
        let port = if strict { port? } else { port.ok().flatten() }.unwrap_or(4920);
        Ok(Self {
            config_path,
            data_dir,
            port,
        })
    }

    pub(crate) fn validate_update(&self) -> Result<(), String> {
        if !self.config_path.is_file() {
            return Err(format!(
                "Automatic install requires {}. Create this config file (it can be empty to keep environment settings and defaults), or update manually.",
                self.config_path.display()
            ));
        }
        if !self.data_dir.is_dir() {
            return Err(format!(
                "The configured data folder {} is missing. Restore it before installing an update.",
                self.data_dir.display()
            ));
        }
        Ok(())
    }

    pub(crate) fn configure_command(&self, command: &mut Command) {
        // Restarts run from the installation, which may differ from the old
        // server's cwd. Preserve the selected file and fallback data location.
        if self.config_path.is_file() || env::var_os("OPERALIBRE_SERVER_CONFIG").is_some() {
            command.env("OPERALIBRE_SERVER_CONFIG", &self.config_path);
        } else {
            command.env_remove("OPERALIBRE_SERVER_CONFIG");
        }
        command
            .env("OPERALIBRE_DATA_DIR", &self.data_dir)
            .env("PORT", self.port.to_string());
    }
}

pub(crate) fn port_from(
    configured: Option<String>,
    environment: Option<String>,
) -> Result<Option<u16>, String> {
    let Some(value) = [configured, environment]
        .into_iter()
        .flatten()
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    value
        .parse()
        .map(Some)
        .map_err(|error| format!("Invalid server port `{value}`: {error}"))
}

pub(crate) fn configured_value_in(contents: &str, key: &str) -> Option<String> {
    let wanted = key.to_ascii_lowercase().replace('-', "_");
    contents
        .lines()
        // Searched from the end: the server keeps a repeated key's last value.
        .rev()
        .find_map(|raw_line| {
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (candidate, value) = line.split_once('=')?;
            (candidate.trim().to_ascii_lowercase().replace('-', "_") == wanted)
                .then(|| unquote_config_value(value.trim()))
        })
}

/// One matching pair of surrounding quotes, as the server's
/// `unquote_config_value` strips.
fn unquote_config_value(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 2
        && bytes[0] == bytes[bytes.len() - 1]
        && (bytes[0] == b'"' || bytes[0] == b'\'')
    {
        return value[1..value.len() - 1].to_string();
    }
    value.to_string()
}
