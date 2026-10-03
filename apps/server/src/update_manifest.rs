//! The signed update manifest: the one thing this server reads to learn about
//! releases. The contract is docs/update-manifest.md; the signer is
//! script/release_signing.mjs. Everything here is additive-compatible: unknown
//! fields, components, formats and platforms are ignored, so later releases can
//! extend the manifest without stranding this build.

use anyhow::{Context, anyhow, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use reqwest::Client;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};

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
/// The key rotations this install has accepted, in the data dir. Verification
/// starts from them, so a later manifest that leaves a rotation out cannot be
/// accepted under a key that rotation retired.
pub const ACCEPTED_ROOTS_FILE: &str = "update-roots.json";

/// The keys this build trusts out of the box: root version 1. Later roots are
/// learned from the rotations a manifest carries, each signed by the root
/// before it. Must match `rootKeys` in release/update-trust.json.
pub const ROOT_KEYS: &[&str] = &[
    "FhUko6re8/stEbHmAlnNv3+SwIzMSXNMUpPVl8BVifk=",
    // Offline backup key; it signs only key rotations.
    "ZRqn6x4T1s5YydV/orpMeF1Ec4VgpLXq7EUgAFIn0Ns=",
];

#[derive(Debug, Clone, Deserialize, Serialize)]
struct Envelope {
    payload: String,
    #[serde(default)]
    signatures: Vec<EnvelopeSignature>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    roots: Vec<Envelope>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct EnvelopeSignature {
    keyid: String,
    sig: String,
}

#[derive(Debug, Clone)]
pub struct TrustedRoot {
    version: u64,
    threshold: usize,
    keys: Vec<(String, ed25519_dalek::VerifyingKey)>,
    /// The signed rotations that led here from the built-in root.
    rotations: Vec<Envelope>,
}

#[derive(Default, Deserialize, Serialize)]
struct AcceptedRoots {
    #[serde(default)]
    rotations: Vec<Envelope>,
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
    pub data_compatibility: Option<crate::update_channel::DataCompatibility>,
    #[serde(default)]
    pub stable_version: Option<String>,
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
            rotations: Vec::new(),
        })
    }

    /// This root advanced by the rotations saved at `path`. Each one is
    /// verified again, so the file can only move trust along rotations the
    /// release keys signed. A missing or damaged file changes nothing, and the
    /// next manifest teaches the rotations again.
    pub async fn with_saved_rotations(self, path: &Path) -> anyhow::Result<Self> {
        match tokio::fs::read(path).await {
            Ok(bytes) => {
                let saved = serde_json::from_slice::<AcceptedRoots>(&bytes).unwrap_or_default();
                Ok(self.rotate(&saved.rotations))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(self),
            Err(error) => Err(error).context("Could not read the saved update keys"),
        }
    }

    async fn save(&self, path: &Path) -> anyhow::Result<()> {
        crate::write_json_atomic(
            path,
            &AcceptedRoots {
                rotations: self.rotations.clone(),
            },
        )
        .await
        .map_err(|error| anyhow!("Could not save the new update keys: {error:?}"))
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
                let mut rotations = std::mem::take(&mut self.rotations);
                rotations.push(Envelope {
                    roots: Vec::new(),
                    ..rotation.clone()
                });
                self = TrustedRoot { rotations, ..next };
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
        rotations: Vec::new(),
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
/// `root` is left at the root that signed the manifest, so the rotations it
/// followed stay in force for whatever is verified next.
pub fn verify_manifest(bytes: &[u8], root: &mut TrustedRoot) -> anyhow::Result<Manifest> {
    let envelope: Envelope =
        serde_json::from_slice(bytes).context("The update manifest is not valid JSON.")?;
    let rotated = root.clone().rotate(&envelope.roots);
    rotated.verify(&envelope, "manifest")?;
    *root = rotated;
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

/// Verifies a manifest starting from `root` advanced by the rotations saved at
/// `accepted_roots`, and saves any further rotation the manifest carries.
async fn verify_manifest_remembering(
    bytes: &[u8],
    root: TrustedRoot,
    accepted_roots: &Path,
) -> anyhow::Result<Manifest> {
    // Checks of different feeds overlap. One at a time, each reads what the
    // last one saved, so a feed that carries fewer rotations can neither
    // overwrite a newer root nor be verified under an older one.
    static SAVING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _saving = SAVING.lock().await;
    let mut root = root.with_saved_rotations(accepted_roots).await?;
    let known = root.version;
    let manifest = verify_manifest(bytes, &mut root)?;
    // Saved before the manifest is used: an update that went ahead on a
    // rotation this install then forgot could be undone by the old key.
    if root.version > known {
        root.save(accepted_roots).await?;
    }
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
    accepted_roots: &Path,
    component: &str,
    installed: Option<&Version>,
) -> anyhow::Result<Manifest> {
    fetch_manifest_from(client, accepted_roots, MANIFEST_URL, component, installed).await
}

pub async fn fetch_manifest_from(
    client: &Client,
    accepted_roots: &Path,
    initial_url: &str,
    component: &str,
    installed: Option<&Version>,
) -> anyhow::Result<Manifest> {
    let mut url = initial_url.to_string();
    for _ in 0..MAX_MANIFEST_HOPS {
        let bytes = download_manifest(client, &url).await?;
        let manifest =
            verify_manifest_remembering(&bytes, TrustedRoot::built_in()?, accepted_roots).await?;
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
        let manifest = verify_manifest(&envelope("direct"), &mut test_root()).unwrap();
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
        let manifest = verify_manifest(&envelope("direct"), &mut test_root()).unwrap();
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
        let manifest = verify_manifest(&envelope("rotated"), &mut root.clone()).unwrap();
        assert_eq!(manifest.version, "1.2.4");

        let mut without_rotation = fixture()["rotated"].clone();
        without_rotation["roots"] = serde_json::json!([]);
        assert!(
            verify_manifest(
                &serde_json::to_vec(&without_rotation).unwrap(),
                &mut root.clone()
            )
            .is_err(),
            "the new key is not trusted without the rotation"
        );

        let mut forged_rotation = fixture()["rotated"].clone();
        let signatures = forged_rotation["roots"][0]["signatures"]
            .as_array()
            .unwrap()
            .clone();
        forged_rotation["roots"][0]["signatures"] = serde_json::json!([signatures[1]]);
        assert!(
            verify_manifest(
                &serde_json::to_vec(&forged_rotation).unwrap(),
                &mut root.clone()
            )
            .is_err(),
            "a rotation signed only by the new key is refused"
        );
    }

    #[test]
    fn an_accepted_rotation_retires_the_keys_it_replaced() {
        let mut root = test_root();
        verify_manifest(&envelope("rotated"), &mut root).unwrap();
        assert!(
            verify_manifest(&envelope("direct"), &mut root).is_err(),
            "a manifest that omits the rotation cannot fall back to the old key"
        );
        assert_eq!(
            verify_manifest(&envelope("rotated"), &mut root)
                .unwrap()
                .version,
            "1.2.4"
        );

        let mut refused = test_root();
        let mut tampered = fixture()["rotated"].clone();
        tampered["payload"] = serde_json::Value::String("{}".to_string());
        assert!(verify_manifest(&serde_json::to_vec(&tampered).unwrap(), &mut refused).is_err());
        verify_manifest(&envelope("direct"), &mut refused)
            .expect("a refused manifest's rotation is not kept");
    }

    #[tokio::test]
    async fn accepted_rotations_are_saved_and_verified_again_when_loaded() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(ACCEPTED_ROOTS_FILE);
        let unchanged = test_root().with_saved_rotations(&path).await.unwrap();
        assert_eq!(unchanged.version, 1, "nothing is saved yet");

        verify_manifest_remembering(&envelope("rotated"), test_root(), &path)
            .await
            .unwrap();
        assert!(
            verify_manifest_remembering(&envelope("direct"), test_root(), &path)
                .await
                .is_err(),
            "a later check starts from the saved rotation"
        );
        let mut restored = test_root().with_saved_rotations(&path).await.unwrap();
        assert_eq!(restored.version, 2);
        assert!(verify_manifest(&envelope("direct"), &mut restored).is_err());
        assert!(verify_manifest(&envelope("rotated"), &mut restored).is_ok());

        // A saved rotation the old root never signed moves nothing.
        let mut forged: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        forged["rotations"][0]["signatures"]
            .as_array_mut()
            .unwrap()
            .remove(0);
        std::fs::write(&path, serde_json::to_vec(&forged).unwrap()).unwrap();
        let forged = test_root().with_saved_rotations(&path).await.unwrap();
        assert_eq!(forged.version, 1);

        std::fs::write(&path, b"not json").unwrap();
        let damaged = test_root().with_saved_rotations(&path).await.unwrap();
        assert_eq!(damaged.version, 1);
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
        assert!(
            verify_manifest(&serde_json::to_vec(&tampered).unwrap(), &mut root.clone()).is_err()
        );

        // A root's signature must not pass for a manifest's.
        let rotation = fixture()["rotated"]["roots"][0].clone();
        assert!(
            verify_manifest(&serde_json::to_vec(&rotation).unwrap(), &mut root.clone()).is_err()
        );

        let untrusted =
            TrustedRoot::from_keys(1, 1, &[fixture()["otherKey"].as_str().unwrap()]).unwrap();
        assert!(verify_manifest(&envelope("direct"), &mut untrusted.clone()).is_err());
    }

    #[test]
    fn bridges_route_only_older_installs_of_their_component() {
        let manifest = verify_manifest(&envelope("direct"), &mut test_root()).unwrap();
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
