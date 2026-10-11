use anyhow::{Context, bail};
use semver::Version;
use serde::{Deserialize, Serialize};

use crate::update_manifest::Manifest;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Stable,
    Nightly,
}

impl UpdateChannel {
    pub fn for_version(version: &Version) -> Self {
        if version.pre.as_str().starts_with("nightly.") {
            Self::Nightly
        } else {
            Self::Stable
        }
    }

    pub fn manifest_url(self) -> &'static str {
        match self {
            Self::Stable => crate::update_manifest::MANIFEST_URL,
            Self::Nightly => {
                "https://github.com/DonovanMontoya/OperaLibre/releases/download/nightly/operalibre-manifest-v1.json"
            }
        }
    }
}

/// Equal values promise that both builds can read and write the same state.
/// Bump storageVersion for incompatible JSON, config, or data semantics even
/// when the SQLite schema is unchanged. Public nightlies must match stable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataCompatibility {
    pub database_schema: i64,
    pub storage_version: u32,
}

impl DataCompatibility {
    pub fn current() -> Self {
        serde_json::from_str(include_str!("../../../release/data-compatibility.json"))
            .expect("valid built-in data compatibility")
    }
}

pub fn validate_target(
    current: &Version,
    target: &Version,
    channel: UpdateChannel,
    manifest: &Manifest,
) -> anyhow::Result<()> {
    if UpdateChannel::for_version(target) != channel
        || (channel == UpdateChannel::Stable && !target.pre.is_empty())
        || target.to_string() != manifest.version
    {
        bail!("The release does not belong to the selected update channel.");
    }
    if channel == UpdateChannel::Nightly || target < current {
        if manifest.data_compatibility != Some(DataCompatibility::current()) {
            bail!(
                "This release cannot safely use this server's data. Stay on the current build until a compatible release is available."
            );
        }
        if channel == UpdateChannel::Nightly {
            let stable = manifest
                .stable_version
                .as_deref()
                .context("This nightly has no verified stable return version.")?;
            let stable = Version::parse(stable)?;
            if !stable.pre.is_empty() || stable >= *target {
                bail!("This nightly has an invalid stable return version.");
            }
        }
    }
    Ok(())
}

pub fn update_available(current: &Version, target: &Version, channel: UpdateChannel) -> bool {
    target > current || (UpdateChannel::for_version(current) != channel && target != current)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compatibility_tracks_the_database_schema() {
        assert_eq!(
            DataCompatibility::current().database_schema,
            crate::db::SCHEMA_VERSION
        );
        assert!(DataCompatibility::current().storage_version > 0);
    }

    #[test]
    fn only_channel_switches_offer_older_versions() {
        let stable = Version::parse("1.0.0").unwrap();
        let nightly = Version::parse("1.0.1-nightly.20260927.1").unwrap();
        assert!(update_available(&nightly, &stable, UpdateChannel::Stable));
        assert!(update_available(&stable, &nightly, UpdateChannel::Nightly));
        assert!(!update_available(
            &Version::parse("1.0.2").unwrap(),
            &stable,
            UpdateChannel::Stable
        ));
        assert!(!update_available(
            &Version::parse("1.0.1-nightly.20260927.2").unwrap(),
            &nightly,
            UpdateChannel::Nightly
        ));
    }

    #[test]
    fn switches_require_compatible_signed_metadata() {
        let stable = Version::parse("1.0.0").unwrap();
        let nightly = Version::parse("1.0.1-nightly.20260927.1").unwrap();
        let mut manifest = crate::update_manifest::unsigned_manifest(
            r#"{"type":"manifest","schema":1,"version":"1.0.0","releaseUrl":"https://example.com","packages":[]}"#,
        );
        assert!(validate_target(&nightly, &stable, UpdateChannel::Stable, &manifest).is_err());
        manifest.data_compatibility = Some(DataCompatibility::current());
        assert!(validate_target(&nightly, &stable, UpdateChannel::Stable, &manifest).is_ok());
        manifest.version = nightly.to_string();
        assert!(validate_target(&stable, &nightly, UpdateChannel::Nightly, &manifest).is_err());
        manifest.stable_version = Some(stable.to_string());
        assert!(validate_target(&stable, &nightly, UpdateChannel::Nightly, &manifest).is_ok());
        assert!(validate_target(&stable, &nightly, UpdateChannel::Stable, &manifest).is_err());
        manifest
            .data_compatibility
            .as_mut()
            .unwrap()
            .storage_version += 1;
        assert!(validate_target(&stable, &nightly, UpdateChannel::Nightly, &manifest).is_err());
    }
}
