//! The signed update manifest: the one thing this server reads to learn about
//! releases. The contract is docs/update-manifest.md; the signer is
//! script/release_signing.mjs. Everything here is additive-compatible: unknown
//! fields, components, formats and platforms are ignored, so later releases can
//! extend the manifest without stranding this build.

use anyhow::{Context, anyhow, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use reqwest::Client;
use semver::Version;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::Duration;

/// Always the newest release's manifest; GitHub redirects this address to it,
/// without counting against the API rate limit.
pub const MANIFEST_URL: &str = "https://github.com/DonovanMontoya/OperaLibre/releases/latest/download/operalibre-manifest-v1.json";
/// The manifest schema this build understands. A breaking change publishes a
/// new manifest file (manifest-v2) beside this one instead of changing it.
const MANIFEST_SCHEMA: u64 = 1;
const ENVELOPE_DOMAIN: &str = "operalibre-signed-v1";
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
/// Redirects and bridges followed before giving up, which also ends a loop.
const MAX_MANIFEST_HOPS: usize = 8;

/// The keys this build trusts out of the box: root version 1. Later roots are
/// learned from the rotations a manifest carries, each signed by the root
/// before it. Must match `rootKeys` in release/update-trust.json.
pub const ROOT_KEYS: &[&str] = &[
    "FhUko6re8/stEbHmAlnNv3+SwIzMSXNMUpPVl8BVifk=",
    // Offline backup key; it signs only key rotations.
    "ZRqn6x4T1s5YydV/orpMeF1Ec4VgpLXq7EUgAFIn0Ns=",
];

#[derive(Debug, Deserialize)]
struct Envelope {
    payload: String,
    #[serde(default)]
    signatures: Vec<EnvelopeSignature>,
    #[serde(default)]
    roots: Vec<Envelope>,
}

#[derive(Debug, Deserialize)]
struct EnvelopeSignature {
    keyid: String,
    sig: String,
}

#[derive(Debug, Clone)]
pub struct TrustedRoot {
    version: u64,
    threshold: usize,
    keys: Vec<(String, ed25519_dalek::VerifyingKey)>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootPayload {
    #[serde(rename = "type")]
    kind: String,
    version: u64,
    threshold: usize,
    keys: Vec<RootKey>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootKey {
    keyid: String,
    public_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(rename = "type")]
    kind: String,
    schema: u64,
    pub version: String,
    #[serde(default)]
    pub published: Option<String>,
    pub release_url: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub notice: Option<Notice>,
    #[serde(default)]
    redirect: Option<String>,
    #[serde(default)]
    bridges: Vec<Bridge>,
    #[serde(default)]
    packages: Vec<Package>,
}

/// A message for installs this manifest cannot serve, such as a manual step.
#[derive(Debug, Clone, Deserialize)]
pub struct Notice {
    pub message: String,
    #[serde(default)]
    pub url: Option<String>,
}

/// Sends installs older than `below` to another manifest: the last release
/// that can still update them. Stepping stones like this let a later release
/// change what an update needs without stranding older installs.
#[derive(Debug, Clone, Deserialize)]
struct Bridge {
    #[serde(default)]
    component: Option<String>,
    below: String,
    manifest: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub component: String,
    pub platform: String,
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub format: String,
    /// The folder the archive extracts to.
    pub root: String,
    /// Interface version, for components like the sync add-on whose runtime
    /// contract with the server can change.
    #[serde(default)]
    pub protocol: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveFormat {
    Zip,
    TarGz,
}

impl Package {
    pub fn archive_format(&self) -> Option<ArchiveFormat> {
        match self.format.as_str() {
            "zip" => Some(ArchiveFormat::Zip),
            "tar.gz" => Some(ArchiveFormat::TarGz),
            _ => None,
        }
    }

    fn is_usable(&self) -> bool {
        self.archive_format().is_some()
            && self.url.starts_with("https://")
            && self.size > 0
            && self.sha256.len() == 64
            && self.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            && Version::parse(&self.version).is_ok()
            && is_single_folder_name(&self.root)
    }
}

fn is_single_folder_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', ':'])
        && !name.starts_with('.')
}

impl Manifest {
    /// The first usable package for the component on this platform (or for
    /// every platform), optionally limited to one interface version.
    pub fn package(
        &self,
        component: &str,
        platform: Option<&str>,
        protocol: Option<u32>,
    ) -> Option<&Package> {
        self.packages.iter().find(|package| {
            package.component == component
                && (package.platform == "any" || Some(package.platform.as_str()) == platform)
                && (protocol.is_none() || package.protocol.unwrap_or(1) == protocol.unwrap_or(1))
                && package.is_usable()
        })
    }

    fn bridge_for(&self, component: &str, installed: Option<&Version>) -> Option<&Bridge> {
        let installed = installed?;
        self.bridges.iter().find(|bridge| {
            bridge
                .component
                .as_deref()
                .is_none_or(|bridged| bridged == component)
                && Version::parse(&bridge.below).is_ok_and(|below| *installed < below)
        })
    }
}

impl TrustedRoot {
    /// Root version 1, built into this binary.
    pub fn built_in() -> anyhow::Result<Self> {
        Self::from_keys(1, 1, ROOT_KEYS)
    }

    pub fn from_keys(version: u64, threshold: usize, keys: &[&str]) -> anyhow::Result<Self> {
        let keys = keys
            .iter()
            .map(|key| {
                let key = decode_public_key(key)?;
                Ok((key_id(&key), key))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        if threshold == 0 || threshold > keys.len() {
            bail!("The update root has an invalid signature threshold.");
        }
        Ok(Self {
            version,
            threshold,
            keys,
        })
    }

    fn verify(&self, envelope: &Envelope, kind: &str) -> anyhow::Result<()> {
        let message = envelope_message(kind, &envelope.payload);
        let mut verified = Vec::new();
        for signature in &envelope.signatures {
            let Some((keyid, key)) = self.keys.iter().find(|(id, _)| *id == signature.keyid) else {
                continue;
            };
            if verified.contains(keyid) {
                continue;
            }
            let Ok(bytes) = STANDARD.decode(signature.sig.trim()) else {
                continue;
            };
            let Ok(bytes) = <[u8; 64]>::try_from(bytes) else {
                continue;
            };
            if key
                .verify_strict(&message, &ed25519_dalek::Signature::from_bytes(&bytes))
                .is_ok()
            {
                verified.push(keyid.clone());
            }
        }
        if verified.len() < self.threshold {
            bail!("The update {kind} is not signed by a trusted OperaLibre release key.");
        }
        Ok(())
    }

    /// Applies each rotation that follows this root in sequence. A new root
    /// must be signed by the current root's keys and by its own, so neither a
    /// stolen old key nor a new key alone can take over.
    fn rotate(mut self, rotations: &[Envelope]) -> Self {
        for rotation in rotations {
            let Ok(payload) = serde_json::from_str::<RootPayload>(&rotation.payload) else {
                continue;
            };
            if payload.kind != "root" || payload.version != self.version + 1 {
                continue;
            }
            let Ok(next) = root_from_payload(&payload) else {
                continue;
            };
            if self.verify(rotation, "root").is_ok() && next.verify(rotation, "root").is_ok() {
                self = next;
            }
        }
        self
    }
}

fn root_from_payload(payload: &RootPayload) -> anyhow::Result<TrustedRoot> {
    let mut keys = Vec::new();
    for entry in &payload.keys {
        let key = decode_public_key(&entry.public_key)?;
        if key_id(&key) != entry.keyid {
            bail!("An update root key has a mismatched key id.");
        }
        keys.push((entry.keyid.clone(), key));
    }
    if payload.threshold == 0 || payload.threshold > keys.len() {
        bail!("The update root has an invalid signature threshold.");
    }
    Ok(TrustedRoot {
        version: payload.version,
        threshold: payload.threshold,
        keys,
    })
}

fn decode_public_key(base64: &str) -> anyhow::Result<ed25519_dalek::VerifyingKey> {
    let bytes: [u8; 32] = STANDARD
        .decode(base64)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| anyhow!("An update root key is not a 32-byte base64 key."))?;
    ed25519_dalek::VerifyingKey::from_bytes(&bytes)
        .map_err(|_| anyhow!("An update root key is not a valid Ed25519 key."))
}

fn key_id(key: &ed25519_dalek::VerifyingKey) -> String {
    crate::hex_digest(Sha256::digest(key.as_bytes()))[..16].to_string()
}

fn envelope_message(kind: &str, payload: &str) -> Vec<u8> {
    let mut message = format!("{ENVELOPE_DOMAIN}\n{kind}\n").into_bytes();
    message.extend_from_slice(payload.as_bytes());
    message
}

/// Verifies a manifest file's signatures, following any key rotations it
/// carries, and returns the manifest. Nothing in an unverified file is used.
pub fn verify_manifest(bytes: &[u8], root: &TrustedRoot) -> anyhow::Result<Manifest> {
    let envelope: Envelope =
        serde_json::from_slice(bytes).context("The update manifest is not valid JSON.")?;
    let root = root.clone().rotate(&envelope.roots);
    root.verify(&envelope, "manifest")?;
    let manifest: Manifest = serde_json::from_str(&envelope.payload)
        .context("The update manifest payload is not valid.")?;
    if manifest.kind != "manifest" {
        bail!("The signed update file is not a manifest.");
    }
    if manifest.schema != MANIFEST_SCHEMA {
        bail!(
            "The update manifest uses schema {}, which this version cannot read.",
            manifest.schema
        );
    }
    Version::parse(&manifest.version).context("The update manifest has an invalid version.")?;
    Ok(manifest)
}

/// A manifest from its payload alone, for tests of code that reads one.
#[cfg(test)]
pub fn unsigned_manifest(payload: &str) -> Manifest {
    serde_json::from_str(payload).unwrap()
}

/// Fetches the manifest that applies to `component` at `installed`: the latest
/// one, or the one a redirect or bridge sends this install to.
pub async fn fetch_manifest(
    client: &Client,
    component: &str,
    installed: Option<&Version>,
) -> anyhow::Result<Manifest> {
    let root = TrustedRoot::built_in()?;
    let mut url = MANIFEST_URL.to_string();
    for _ in 0..MAX_MANIFEST_HOPS {
        let bytes = download_manifest(client, &url).await?;
        let manifest = verify_manifest(&bytes, &root)?;
        if let Some(next) = &manifest.redirect {
            url = next.clone();
            continue;
        }
        if let Some(bridge) = manifest.bridge_for(component, installed) {
            url = bridge.manifest.clone();
            continue;
        }
        return Ok(manifest);
    }
    bail!("The update manifest redirected too many times.")
}

async fn download_manifest(client: &Client, url: &str) -> anyhow::Result<Vec<u8>> {
    if !url.starts_with("https://") {
        bail!("The update manifest address is not HTTPS.");
    }
    let mut response = client
        .get(url)
        .timeout(Duration::from_secs(30))
        .send()
        .await?
        .error_for_status()?;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_MANIFEST_BYTES {
            bail!("The update manifest is too large.");
        }
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Written by script/release_signing.test.mjs from test-only keys, so the
    /// signer and this verifier must agree byte for byte.
    const FIXTURE: &str = include_str!("../../../script/fixtures/update-manifest.json");

    fn fixture() -> serde_json::Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    fn test_root() -> TrustedRoot {
        let fixture = fixture();
        let keys = fixture["rootKeys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|key| key.as_str().unwrap())
            .collect::<Vec<_>>();
        TrustedRoot::from_keys(1, 1, &keys).unwrap()
    }

    fn envelope(name: &str) -> Vec<u8> {
        serde_json::to_vec(&fixture()[name]).unwrap()
    }

    #[test]
    fn a_manifest_signed_by_a_root_key_verifies() {
        let manifest = verify_manifest(&envelope("direct"), &test_root()).unwrap();
        assert_eq!(manifest.version, "1.2.3");
        let server = manifest.package("server", Some("linux-x64"), None).unwrap();
        assert_eq!(server.archive_format(), Some(ArchiveFormat::TarGz));
        assert_eq!(server.root, "operalibre-1.2.3-combined-linux-x64");
        assert!(
            manifest
                .package("frontend", Some("linux-x64"), None)
                .is_some()
        );
        assert!(manifest.package("frontend", None, None).is_some());
        assert!(
            manifest
                .package("server", Some("plan9-x64"), None)
                .is_none(),
            "unknown platforms find nothing"
        );
    }

    #[test]
    fn unknown_fields_components_and_formats_are_ignored() {
        // The fixture lists a component and fields this version has never
        // heard of; reading it must still succeed.
        let manifest = verify_manifest(&envelope("direct"), &test_root()).unwrap();
        let windows = manifest
            .package("server", Some("windows-x64"), None)
            .unwrap();
        assert_eq!(
            windows.format, "zip",
            "the future-format entry listed first is skipped"
        );
        let sync = manifest.package("readalong-sync", Some("linux-x64"), Some(1));
        assert_eq!(sync.unwrap().version, "1.0.0");
        assert_eq!(
            manifest
                .package("readalong-sync", Some("linux-x64"), Some(2))
                .unwrap()
                .version,
            "2.0.0",
            "a newer interface version is listed beside the old one"
        );
    }

    #[test]
    fn a_rotated_root_is_trusted_only_through_its_signed_rotation() {
        let root = test_root();
        let manifest = verify_manifest(&envelope("rotated"), &root).unwrap();
        assert_eq!(manifest.version, "1.2.4");

        let mut without_rotation = fixture()["rotated"].clone();
        without_rotation["roots"] = serde_json::json!([]);
        assert!(
            verify_manifest(&serde_json::to_vec(&without_rotation).unwrap(), &root).is_err(),
            "the new key is not trusted without the rotation"
        );

        let mut forged_rotation = fixture()["rotated"].clone();
        let signatures = forged_rotation["roots"][0]["signatures"]
            .as_array()
            .unwrap()
            .clone();
        forged_rotation["roots"][0]["signatures"] = serde_json::json!([signatures[1]]);
        assert!(
            verify_manifest(&serde_json::to_vec(&forged_rotation).unwrap(), &root).is_err(),
            "a rotation signed only by the new key is refused"
        );
    }

    #[test]
    fn tampering_and_wrong_types_are_refused() {
        let root = test_root();
        let mut tampered = fixture()["direct"].clone();
        tampered["payload"] = serde_json::Value::String(
            tampered["payload"]
                .as_str()
                .unwrap()
                .replace("1.2.3", "9.9.9"),
        );
        assert!(verify_manifest(&serde_json::to_vec(&tampered).unwrap(), &root).is_err());

        // A root's signature must not pass for a manifest's.
        let rotation = fixture()["rotated"]["roots"][0].clone();
        assert!(verify_manifest(&serde_json::to_vec(&rotation).unwrap(), &root).is_err());

        let untrusted =
            TrustedRoot::from_keys(1, 1, &[fixture()["otherKey"].as_str().unwrap()]).unwrap();
        assert!(verify_manifest(&envelope("direct"), &untrusted).is_err());
    }

    #[test]
    fn bridges_route_only_older_installs_of_their_component() {
        let manifest = verify_manifest(&envelope("direct"), &test_root()).unwrap();
        let old = Version::parse("0.9.0").unwrap();
        let current = Version::parse("1.0.0").unwrap();
        assert!(manifest.bridge_for("server", Some(&old)).is_some());
        assert!(manifest.bridge_for("server", Some(&current)).is_none());
        assert!(manifest.bridge_for("frontend", Some(&old)).is_none());
        assert!(manifest.bridge_for("server", None).is_none());
    }

    #[test]
    fn built_in_root_keys_match_the_release_trust_file() {
        let trust: serde_json::Value =
            serde_json::from_str(include_str!("../../../release/update-trust.json")).unwrap();
        let keys = trust["rootKeys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|key| key.as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(keys, ROOT_KEYS);
        assert!(TrustedRoot::built_in().is_ok());
    }

    #[test]
    fn package_roots_are_single_folder_names() {
        for bad in ["", ".", "..", "../x", "a/b", "a\\b", "C:x", ".hidden"] {
            assert!(!is_single_folder_name(bad), "{bad}");
        }
        assert!(is_single_folder_name("operalibre-1.2.3-combined-linux-x64"));
    }
}
