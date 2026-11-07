use std::{fs, path::PathBuf};

/// Values resolved by the running server, used only for the update transaction.
#[derive(Clone)]
pub(crate) struct DeploymentConfig {
    pub(crate) config_path: Option<PathBuf>,
    pub(crate) data_dir: PathBuf,
    pub(crate) port: u16,
}

impl DeploymentConfig {
    pub(crate) fn validate_update(&self) -> Result<(), String> {
        if let Some(path) = &self.config_path {
            if !path.is_absolute() || !path.is_file() {
                return Err(format!(
                    "Could not read {}. Restore this config file before installing an update.",
                    path.display()
                ));
            }
            fs::read_to_string(path).map_err(|error| format!(
                "Could not read {}: {error}. Restore this config file before installing an update.",
                path.display()
            ))?;
        }
        if !self.data_dir.is_absolute() || !self.data_dir.is_dir() {
            return Err(format!(
                "The configured data folder {} is missing. Restore it before installing an update.",
                self.data_dir.display()
            ));
        }
        Ok(())
    }
}
