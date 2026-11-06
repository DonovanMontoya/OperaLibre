//! Private, opt-in sender snapshots. Nothing here starts at server boot.
//! Callers hold the invitation/configuration gates through authorization and
//! registration. Secrets are local private-file state, never a response DTO.
use crate::share_broker::{BrokerClient, Capability};
use crate::share_sender::PeerAuthentication;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const MAX_ARCHIVE: u64 = 25 * 1024 * 1024 * 1024;
const MAX_RECORDS: usize = 256;
const MAX_INDEX: u64 = 4 * 1024 * 1024;
static FILE_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
static RESTART_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone)]
pub(crate) struct RecoveryStore(Arc<Store>);
struct Store {
    root: PathBuf,
    server_id: String,
    max_bytes: u64,
    reserve_bytes: u64,
}

/// Construct only from trusted invitation/receipt/session values. Deliberately
/// no Debug: this includes the persistent signing seed and preview key.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PersistedSender {
    pub(crate) server_id: String,
    pub(crate) invitation_digest: String,
    pub(crate) sender_user_id: String,
    pub(crate) book_id: String,
    pub(crate) broker_origin: String,
    pub(crate) room: String,
    pub(crate) gift_id: String,
    pub(crate) expires_at: u64,
    pub(crate) archive_size: u64,
    pub(crate) archive_sha256: String,
    pub(crate) signing_seed: [u8; 32],
    pub(crate) preview_key: [u8; 32],
    pub(crate) producer: Option<Capability>,
    #[serde(default)]
    pub(crate) pending_producer: Option<Capability>,
    #[serde(default)]
    pub(crate) cleanup_only: bool,
}

/// All fields come from current server authorization, not persisted assertions.
/// Main must derive these under INVITATION_GATE, including the room membership
/// and current user/book access, and retain that gate until sender registration.
pub(crate) struct RecoveryAuthority<'a> {
    pub(crate) invitation_digest: &'a str,
    pub(crate) sender_user_id: &'a str,
    pub(crate) book_id: &'a str,
    pub(crate) room: &'a str,
    pub(crate) broker_origin: &'a str,
    pub(crate) invitation_expires_at: u64,
    pub(crate) revoked: bool,
    pub(crate) access_allowed: bool,
}

pub(crate) struct RestoredSender {
    pub(crate) record: PersistedSender,
    pub(crate) archive: tokio::fs::File,
    pub(crate) authentication: PeerAuthentication,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Index {
    version: u8,
    records: Vec<PersistedSender>,
}

fn digest(bytes: impl AsRef<[u8]>) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn identifier(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn origin(value: &str) -> anyhow::Result<()> {
    let url = reqwest::Url::parse(value)?;
    let secure = url.scheme() == "https";
    #[cfg(test)]
    let secure = secure || (url.scheme() == "http" && url.host_str() == Some("127.0.0.1"));
    anyhow::ensure!(
        secure
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path() == "/"
            && url.origin().ascii_serialization() == value,
        "invalid persisted broker origin"
    );
    Ok(())
}

impl PersistedSender {
    pub(crate) fn id(&self) -> String {
        digest(format!(
            "{}\0{}\0{}",
            self.server_id, self.invitation_digest, self.room
        ))
    }
    fn validate(&self, server_id: &str) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.server_id == server_id
                && !server_id.is_empty()
                && identifier(&self.invitation_digest)
                && identifier(&self.room)
                && identifier(&self.gift_id)
                && !self.sender_user_id.is_empty()
                && self.sender_user_id.len() <= 256
                && !self.book_id.is_empty()
                && self.book_id.len() <= 256
                && self.archive_size > 0
                && self.archive_size <= MAX_ARCHIVE
                && hash(&self.archive_sha256)
                && self.expires_at > 0
                && self.expires_at <= crate::share_broker::MAX_GENERATION,
            "invalid persisted sender binding"
        );
        origin(&self.broker_origin)?;
        for capability in [&self.producer, &self.pending_producer]
            .into_iter()
            .flatten()
        {
            self.validate_capability(capability)?;
        }
        Ok(())
    }
    fn validate_capability(&self, capability: &Capability) -> anyhow::Result<()> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Claim {
            room: String,
            role: String,
            nonce: String,
            expires_at: u64,
            previous_nonce: Option<String>,
        }
        anyhow::ensure!(
            capability.payload.len() <= 4096 && hash(&capability.signature),
            "invalid producer encoding"
        );
        let claim: Claim = serde_json::from_str(&capability.payload)?;
        anyhow::ensure!(
            claim.room == self.room
                && claim.role == "producer"
                && identifier(&claim.nonce)
                && claim.expires_at == self.expires_at
                && claim
                    .previous_nonce
                    .as_ref()
                    .is_none_or(|p| identifier(p) && *p != claim.nonce),
            "invalid producer binding"
        );
        Ok(())
    }
}

fn open_private(path: &Path, write: bool) -> anyhow::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(write);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    anyhow::ensure!(metadata.is_file(), "recovery state is not a regular file");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        anyhow::ensure!(
            metadata.permissions().mode() & 0o077 == 0,
            "recovery state permissions are not private"
        );
    }
    Ok(file)
}

impl RecoveryStore {
    /// `data_root` is the configured private server data directory. Archive
    /// paths are derived IDs only, never persisted/client-provided paths.
    pub(crate) fn open(
        data_root: &Path,
        server_id: &str,
        max_bytes: u64,
        reserve_bytes: u64,
    ) -> anyhow::Result<Self> {
        anyhow::ensure!(
            !server_id.is_empty() && max_bytes > 0 && max_bytes <= MAX_ARCHIVE,
            "invalid recovery limits"
        );
        let root = data_root.join("gift-sender-recovery");
        if let Ok(metadata) = std::fs::symlink_metadata(&root) {
            anyhow::ensure!(
                metadata.is_dir() && !metadata.file_type().is_symlink(),
                "unsafe recovery directory"
            );
        }
        crate::create_private_directory(&root)?;
        Ok(Self(Arc::new(Store {
            root,
            server_id: server_id.into(),
            max_bytes,
            reserve_bytes,
        })))
    }
    fn archive_path(&self, id: &str) -> anyhow::Result<PathBuf> {
        anyhow::ensure!(hash(id), "invalid recovery ID");
        Ok(self.0.root.join(format!("{id}.zip")))
    }
    fn open_lock(&self, name: &str) -> anyhow::Result<std::fs::File> {
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
        }
        let file = options.open(self.0.root.join(name))?;
        let metadata = file.metadata()?;
        anyhow::ensure!(metadata.is_file(), "unsafe recovery lock");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            anyhow::ensure!(
                metadata.permissions().mode() & 0o077 == 0,
                "recovery lock is not private"
            );
        }
        fs2::FileExt::try_lock_exclusive(&file)
            .map_err(|_| anyhow::anyhow!("recovery state is busy; retry later"))?;
        Ok(file)
    }
    fn rotation_lease(&self, id: &str) -> anyhow::Result<std::fs::File> {
        anyhow::ensure!(hash(id), "invalid recovery ID");
        // Stable bounded stripes: unlinking a per-record lock could split old
        // and new readers across distinct inodes. Collisions fail retryably.
        let stripe = u8::from_str_radix(&id[..2], 16)? & 63;
        self.open_lock(&format!("rotation-{stripe:02x}.lock"))
    }
    fn load(&self) -> anyhow::Result<Index> {
        let path = self.0.root.join("index.json");
        let file = match open_private(&path, false) {
            Ok(file) => file,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                return Ok(Index {
                    version: 1,
                    records: Vec::new(),
                });
            }
            Err(error) => return Err(error),
        };
        anyhow::ensure!(
            file.metadata()?.len() <= MAX_INDEX,
            "recovery index too large"
        );
        let index: Index = serde_json::from_reader(file.take(MAX_INDEX + 1))?;
        anyhow::ensure!(
            index.version == 1 && index.records.len() <= MAX_RECORDS,
            "invalid recovery index"
        );
        let mut ids = std::collections::HashSet::new();
        for record in &index.records {
            record.validate(&self.0.server_id)?;
            anyhow::ensure!(ids.insert(record.id()), "duplicate recovery binding");
        }
        Ok(index)
    }
    fn retained_bytes(&self) -> anyhow::Result<u64> {
        let mut bytes = 0_u64;
        for (number, entry) in std::fs::read_dir(&self.0.root)?.enumerate() {
            anyhow::ensure!(
                number <= MAX_RECORDS * 2 + 2,
                "recovery directory entry limit exceeded"
            );
            let entry = entry?;
            let metadata = std::fs::symlink_metadata(entry.path())?;
            anyhow::ensure!(
                metadata.is_file() && !metadata.file_type().is_symlink(),
                "unsafe recovery directory entry"
            );
            if entry.file_name() != "index.json" {
                bytes = bytes
                    .checked_add(metadata.len())
                    .ok_or_else(|| anyhow::anyhow!("recovery byte overflow"))?;
            }
        }
        Ok(bytes)
    }
    fn save(&self, index: &Index) -> anyhow::Result<()> {
        let bytes = serde_json::to_vec(index)?;
        anyhow::ensure!(bytes.len() as u64 <= MAX_INDEX, "recovery index too large");
        let mut temp = tempfile::Builder::new()
            .prefix("index-stage-")
            .tempfile_in(&self.0.root)?;
        temp.write_all(&bytes)?;
        temp.as_file().sync_all()?;
        temp.persist(self.0.root.join("index.json"))
            .map_err(|_| anyhow::anyhow!("cannot publish recovery index"))?;
        std::fs::File::open(&self.0.root)?.sync_all()?;
        Ok(())
    }
    async fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce(Self) -> anyhow::Result<T> + Send + 'static,
    ) -> anyhow::Result<T> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            let _gate = FILE_GATE
                .lock()
                .map_err(|_| anyhow::anyhow!("recovery store unavailable"))?;
            let _index_lock = store.open_lock("index.lock")?;
            work(store)
        })
        .await?
    }
    pub(crate) async fn list(&self) -> anyhow::Result<Vec<PersistedSender>> {
        self.blocking(|store| Ok(store.load()?.records)).await
    }
    /// Copy only opened, trusted archive bytes. The blocking worker retains its
    /// lock through HTTP cancellation, bounds bytes, verifies SHA, fsyncs before
    /// publishing metadata, and uses a create-new private destination.
    pub(crate) async fn prepare(
        &self,
        record: PersistedSender,
        archive: std::fs::File,
        now: u64,
    ) -> anyhow::Result<String> {
        self.prepare_admitted(record, archive, now, ())
            .await
            .map(|(id, ())| id)
    }
    pub(crate) async fn prepare_admitted<G: Send + 'static>(
        &self,
        record: PersistedSender,
        mut archive: std::fs::File,
        now: u64,
        guard: G,
    ) -> anyhow::Result<(String, G)> {
        self.blocking(move |store| {
            record.validate(&store.0.server_id)?;
            anyhow::ensure!(
                record.expires_at > now
                    && record.expires_at <= now.saturating_add(900)
                    && record.producer.is_none()
                    && record.pending_producer.is_none()
                    && !record.cleanup_only,
                "invalid initial recovery state"
            );
            let mut index = store.load()?;
            anyhow::ensure!(
                index.records.len() < MAX_RECORDS
                    && index
                        .records
                        .iter()
                        .filter(|r| r.sender_user_id == record.sender_user_id)
                        .count()
                        < 16,
                "recovery invitation capacity is full"
            );
            let total = index
                .records
                .iter()
                .try_fold(record.archive_size, |sum, r| {
                    sum.checked_add(r.archive_size)
                });
            anyhow::ensure!(
                total.is_some_and(|n| n <= store.0.max_bytes),
                "recovery archive budget exceeded"
            );
            anyhow::ensure!(
                store
                    .retained_bytes()?
                    .checked_add(record.archive_size)
                    .is_some_and(|n| n <= store.0.max_bytes),
                "recovery disk budget exceeded including orphan data"
            );
            anyhow::ensure!(
                fs2::available_space(&store.0.root)?
                    >= record.archive_size.saturating_add(store.0.reserve_bytes),
                "recovery volume budget exceeded"
            );
            let id = record.id();
            let destination = store.archive_path(&id)?;
            anyhow::ensure!(
                !destination.try_exists()? && !index.records.iter().any(|r| r.id() == id),
                "recovery state already exists"
            );
            archive.seek(SeekFrom::Start(0))?;
            anyhow::ensure!(
                archive.metadata()?.is_file() && archive.metadata()?.len() == record.archive_size,
                "archive size changed"
            );
            let mut output = tempfile::Builder::new()
                .prefix("archive-stage-")
                .tempfile_in(&store.0.root)?;
            let mut sha = Sha256::new();
            let mut copied = 0_u64;
            let mut buffer = [0; 64 * 1024];
            loop {
                let count = archive.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                copied = copied
                    .checked_add(count as u64)
                    .ok_or_else(|| anyhow::anyhow!("archive overflow"))?;
                anyhow::ensure!(
                    copied <= record.archive_size,
                    "archive grew during retention"
                );
                output.write_all(&buffer[..count])?;
                sha.update(&buffer[..count]);
            }
            let sha: String = sha.finalize().iter().map(|b| format!("{b:02x}")).collect();
            anyhow::ensure!(
                copied == record.archive_size && sha == record.archive_sha256,
                "archive receipt mismatch"
            );
            output.as_file().sync_all()?;
            output
                .persist_noclobber(destination)
                .map_err(|_| anyhow::anyhow!("cannot retain private archive"))?;
            index.records.push(record);
            store.save(&index)?;
            Ok((id, guard))
        })
        .await
    }
    async fn update(
        &self,
        id: String,
        change: impl FnOnce(&mut PersistedSender) -> anyhow::Result<()> + Send + 'static,
    ) -> anyhow::Result<()> {
        self.blocking(move |store| {
            let mut index = store.load()?;
            let record = index
                .records
                .iter_mut()
                .find(|r| r.id() == id)
                .ok_or_else(|| anyhow::anyhow!("sender snapshot not found"))?;
            change(record)?;
            record.validate(&store.0.server_id)?;
            store.save(&index)
        })
        .await
    }
    pub(crate) async fn set_producer(
        &self,
        id: &str,
        capability: Capability,
    ) -> anyhow::Result<()> {
        self.update(id.into(), move |record| {
            record.validate_capability(&capability)?;
            anyhow::ensure!(
                record
                    .producer
                    .as_ref()
                    .is_none_or(|old| old.payload == capability.payload
                        && old.signature == capability.signature),
                "producer already pinned"
            );
            record.producer = Some(capability);
            Ok(())
        })
        .await
    }
    pub(crate) async fn mark_cleanup(&self, id: &str) -> anyhow::Result<()> {
        self.update(id.into(), |record| {
            record.cleanup_only = true;
            Ok(())
        })
        .await
    }
    /// Crash-before-index artifacts have never been handed out as an active
    /// gift. Remove only this module's own unindexed file naming schemes.
    pub(crate) async fn prune_orphans(&self) -> anyhow::Result<usize> {
        self.blocking(|store| {
            let index = store.load()?;
            let retained: std::collections::HashSet<_> = index
                .records
                .iter()
                .map(|r| format!("{}.zip", r.id()))
                .collect();
            let mut removed = 0;
            let entries = std::fs::read_dir(&store.0.root)?
                .take(MAX_RECORDS * 2 + 4)
                .collect::<Result<Vec<_>, _>>()?;
            anyhow::ensure!(
                entries.len() <= MAX_RECORDS * 2 + 3,
                "recovery directory entry limit exceeded"
            );
            for entry in entries {
                let name = entry.file_name();
                let Some(name) = name.to_str() else { continue };
                let owned = name.strip_suffix(".zip").is_some_and(hash)
                    || name.strip_prefix("archive-stage-").is_some_and(|suffix| {
                        !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_alphanumeric())
                    })
                    || name.strip_prefix("index-stage-").is_some_and(|suffix| {
                        !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_alphanumeric())
                    });
                if owned && !retained.contains(name) && entry.file_type()?.is_file() {
                    std::fs::remove_file(entry.path())?;
                    removed += 1;
                }
            }
            std::fs::File::open(&store.0.root)?.sync_all()?;
            Ok(removed)
        })
        .await
    }
    pub(crate) async fn restore(
        &self,
        id: &str,
        authority: &RecoveryAuthority<'_>,
        now: u64,
    ) -> anyhow::Result<RestoredSender> {
        self.restore_admitted(id, authority, now, ())
            .await
            .map(|(sender, ())| sender)
    }
    /// Admission follows the blocking read rather than its HTTP awaiter. On
    /// success return the same guard to keep it charged throughout transfer.
    pub(crate) async fn restore_admitted<G: Send + 'static>(
        &self,
        id: &str,
        authority: &RecoveryAuthority<'_>,
        now: u64,
        guard: G,
    ) -> anyhow::Result<(RestoredSender, G)> {
        let record = self
            .list()
            .await?
            .into_iter()
            .find(|r| r.id() == id)
            .ok_or_else(|| anyhow::anyhow!("sender snapshot not found"))?;
        anyhow::ensure!(
            !record.cleanup_only
                && !authority.revoked
                && authority.access_allowed
                && record.invitation_digest == authority.invitation_digest
                && record.sender_user_id == authority.sender_user_id
                && record.book_id == authority.book_id
                && record.room == authority.room
                && record.broker_origin == authority.broker_origin
                && record.expires_at <= authority.invitation_expires_at
                && record.expires_at > now
                && record.expires_at <= now.saturating_add(900),
            "sender recovery is not authorized"
        );
        let opened_record = record.clone();
        let (file, guard) = self
            .blocking(move |store| {
                let mut file = open_private(&store.archive_path(&opened_record.id())?, false)?;
                anyhow::ensure!(
                    file.metadata()?.len() == opened_record.archive_size,
                    "retained archive size changed"
                );
                fs2::FileExt::try_lock_exclusive(&file)?;
                let mut sha = Sha256::new();
                let mut count = 0_u64;
                let mut buffer = [0; 64 * 1024];
                loop {
                    let read = file.read(&mut buffer)?;
                    if read == 0 {
                        break;
                    }
                    count = count
                        .checked_add(read as u64)
                        .ok_or_else(|| anyhow::anyhow!("archive overflow"))?;
                    anyhow::ensure!(count <= opened_record.archive_size, "retained archive grew");
                    sha.update(&buffer[..read]);
                }
                let sha: String = sha.finalize().iter().map(|b| format!("{b:02x}")).collect();
                anyhow::ensure!(
                    count == opened_record.archive_size && sha == opened_record.archive_sha256,
                    "retained archive digest changed"
                );
                file.seek(SeekFrom::Start(0))?;
                Ok((file, guard))
            })
            .await?;
        let authentication = PeerAuthentication {
            gift_id: record.gift_id.clone(),
            archive_sha256: record.archive_sha256.clone(),
            signing: ed25519_dalek::SigningKey::from_bytes(&record.signing_seed),
            preview_key: record.preview_key,
        };
        Ok((
            RestoredSender {
                record,
                archive: tokio::fs::File::from_std(file),
                authentication,
            },
            guard,
        ))
    }
    /// Claim once on initial preparation; a recovered active claim is checked
    /// with /session and is never replayed through the one-time /claim endpoint.
    pub(crate) async fn activate_initial(
        &self,
        id: &str,
        broker: &BrokerClient,
    ) -> anyhow::Result<Capability> {
        let record = self
            .list()
            .await?
            .into_iter()
            .find(|r| r.id() == id)
            .ok_or_else(|| anyhow::anyhow!("sender snapshot not found"))?;
        anyhow::ensure!(
            record.broker_origin == broker.origin().origin().ascii_serialization()
                && !record.cleanup_only,
            "broker binding changed"
        );
        let capability = record
            .producer
            .ok_or_else(|| anyhow::anyhow!("producer not yet persisted"))?;
        if broker
            .session_generation(&record.room, &capability)
            .await
            .is_err()
        {
            broker.claim(&record.room, &capability).await?;
            broker.session_generation(&record.room, &capability).await?;
        }
        Ok(capability)
    }
    /// Persist both claims BEFORE rotation. A lost /resume response is resolved
    /// using /session with each saved claim; never invent a fresh room or key.
    /// An unresolved successor is retried verbatim, not replaced: its remote
    /// request can still commit after the local HTTP future was cancelled.
    pub(crate) async fn rotate_for_restart(
        &self,
        id: &str,
        broker: &BrokerClient,
        owner_secret: &str,
    ) -> anyhow::Result<Capability> {
        use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
        let _gate = RESTART_GATE.lock().await;
        let lease_id = id.to_owned();
        let _rotation_lease = self
            .blocking(move |store| store.rotation_lease(&lease_id))
            .await?;
        let record = self
            .list()
            .await?
            .into_iter()
            .find(|r| r.id() == id)
            .ok_or_else(|| anyhow::anyhow!("sender snapshot not found"))?;
        anyhow::ensure!(
            !record.cleanup_only
                && record.broker_origin == broker.origin().origin().ascii_serialization(),
            "broker binding changed"
        );
        let current = record
            .producer
            .ok_or_else(|| anyhow::anyhow!("producer not yet persisted"))?;
        if let Some(pending) = record.pending_producer {
            if broker
                .session_generation(&record.room, &pending)
                .await
                .is_err()
            {
                let generation = broker.session_generation(&record.room, &current).await?;
                if broker
                    .rotate(&record.room, &current, &pending, generation)
                    .await
                    .is_err()
                {
                    broker.session_generation(&record.room, &pending).await?;
                }
            }
            let retained = pending.clone();
            self.update(id.into(), move |r| {
                r.producer = Some(retained);
                r.pending_producer = None;
                Ok(())
            })
            .await?;
            // No peer was started while the durable successor was pending.
            // Do not spend another rotation or invent another successor here.
            return Ok(pending);
        }
        let generation = broker.session_generation(&record.room, &current).await?;
        let nonce = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 24]>());
        let next = broker
            .issue_successor(owner_secret, &record.room, &current, &nonce)
            .await?;
        let saved = next.clone();
        self.update(id.into(), move |r| {
            r.pending_producer = Some(saved);
            Ok(())
        })
        .await?;
        if broker
            .rotate(&record.room, &current, &next, generation)
            .await
            .is_err()
        {
            // Failure is ambiguous, not proof the broker did not commit.
            broker.session_generation(&record.room, &next).await?;
        }
        let promoted = next.clone();
        self.update(id.into(), move |r| {
            r.producer = Some(promoted);
            r.pending_producer = None;
            Ok(())
        })
        .await?;
        Ok(next)
    }
    /// After confirmed cleanup or successful receipt only. Delete data first;
    /// a crash leaves a nonrecoverable record for owner cleanup, not orphan data.
    pub(crate) async fn remove(&self, id: &str) -> anyhow::Result<()> {
        let id = id.to_owned();
        self.blocking(move |store| {
            let mut index = store.load()?;
            let path = store.archive_path(&id)?;
            if let Err(error) = std::fs::remove_file(path)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                return Err(error.into());
            }
            index.records.retain(|r| r.id() != id);
            store.save(&index)
        })
        .await
    }
}

#[cfg(test)]
#[path = "share_sender_recovery_tests.rs"]
mod tests;
