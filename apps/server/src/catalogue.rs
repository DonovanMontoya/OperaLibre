//! Catalogue generation is bounded before copying metadata and while a slow
//! client retains its response. A listing that fits in a small buffer is
//! hashed once and served from that buffer, so an ordinary shelf does not
//! round-trip through a tempfile. Anything larger spills to an anonymous
//! file: a slow client then cannot pin a multi-megabyte feed on the heap,
//! and a budget overrun never publishes a partial JSON or XML body.
use crate::*;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, ReadBuf};

pub(crate) const CATALOGUE_CONCURRENCY: usize = 2;
pub(crate) const CATALOGUE_MAX_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const CATALOGUE_BOOK_BYTES: u64 = 2 * 1024 * 1024;
/// Past this, the remainder of a listing spills to disk. Two responses can
/// be in flight, so the resident cap is twice this value, well under the
/// 64 MiB catalogue budget. The 200-book listing benchmark is a few hundred
/// kilobytes and stays in the buffer.
pub(crate) const CATALOGUE_MEMORY_LIMIT: usize = 4 * 1024 * 1024;

pub(crate) struct CatalogueLease {
    _server: OwnedSemaphorePermit,
    _account: OwnedSemaphorePermit,
}

impl CatalogueLease {
    pub(crate) async fn acquire(state: &AppState, user: &AuthUser) -> Result<Self, ApiError> {
        let slots = {
            let mut accounts = state.catalogue_account_slots.lock().await;
            accounts.retain(|_, slots| Arc::strong_count(slots) > 1);
            accounts
                .entry(user.id.clone())
                .or_insert_with(|| Arc::new(Semaphore::new(1)))
                .clone()
        };
        let busy =
            |_| ApiError::too_many_requests("A catalogue response is still in use. Retry shortly.");
        let account = slots.try_acquire_owned().map_err(busy)?;
        let server = state
            .catalogue_slots
            .clone()
            .try_acquire_owned()
            .map_err(busy)?;
        Ok(Self {
            _server: server,
            _account: account,
        })
    }
}

struct CountWriter {
    bytes: u64,
    limit: u64,
}
impl Write for CountWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() as u64 > self.limit.saturating_sub(self.bytes) {
            return Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                "catalogue byte limit exceeded",
            ));
        }
        self.bytes += bytes.len() as u64;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Reject a book whose own JSON exceeds the per-book budget. Listings that
/// write the book into the spool enforce that budget on the bytes they
/// actually send. This check remains for feeds that omit the book body.
pub(crate) fn check_catalogue_book(book: &Book) -> Result<(), ApiError> {
    let mut count = CountWriter {
        bytes: 0,
        limit: CATALOGUE_BOOK_BYTES,
    };
    serde_json::to_writer(&mut count, book).map_err(|_| catalogue_too_large())
}

fn catalogue_too_large() -> ApiError {
    ApiError::payload_too_large(
        "Catalogue metadata exceeds its response budget. Request a smaller page or reduce oversized book metadata.",
    )
}

fn catalogue_write_error(error: io::Error) -> ApiError {
    if error.kind() == io::ErrorKind::FileTooLarge {
        catalogue_too_large()
    } else {
        ApiError::internal("Could not prepare catalogue response.")
    }
}

fn catalogue_json_error(error: serde_json::Error) -> ApiError {
    if error.io_error_kind() == Some(io::ErrorKind::FileTooLarge) {
        catalogue_too_large()
    } else {
        ApiError::internal("Could not prepare catalogue response.")
    }
}

pub(crate) struct CatalogueSpool {
    memory: Vec<u8>,
    file: Option<std::io::BufWriter<std::fs::File>>,
    count: CountWriter,
    item_start: u64,
    item_limit: u64,
    in_item: bool,
    /// Absolute `count.bytes` at which the next resident append must stop.
    /// Recomputed when an item or the aggregate limit changes, so the hot
    /// path compares once instead of re-deriving both caps per fragment.
    ceiling: u64,
    memory_limit: usize,
    /// Hash of bytes already handed to `file`. A resident listing is hashed
    /// once, when the tag is requested, rather than on every fragment.
    digest: Sha1,
    lease: CatalogueLease,
}
impl CatalogueSpool {
    pub(crate) fn new(lease: CatalogueLease) -> Result<Self, ApiError> {
        Ok(Self {
            memory: Vec::new(),
            file: None,
            count: CountWriter {
                bytes: 0,
                limit: CATALOGUE_MAX_BYTES,
            },
            item_start: 0,
            item_limit: CATALOGUE_BOOK_BYTES,
            in_item: false,
            ceiling: CATALOGUE_MAX_BYTES,
            memory_limit: CATALOGUE_MEMORY_LIMIT,
            digest: Sha1::new(),
            lease,
        })
    }
    /// Start counting bytes for one book. Later writes refuse to store a
    /// chunk that would pass the per-book budget, in the same pass that
    /// builds the body.
    pub(crate) fn begin_item(&mut self) {
        self.item_start = self.count.bytes;
        self.in_item = true;
        self.refresh_ceiling();
    }
    pub(crate) fn finish_item(&mut self) -> Result<(), ApiError> {
        let used = self.count.bytes.saturating_sub(self.item_start);
        self.in_item = false;
        self.refresh_ceiling();
        if used > self.item_limit {
            Err(catalogue_too_large())
        } else {
            Ok(())
        }
    }
    pub(crate) fn json(&mut self, value: &impl Serialize) -> Result<(), ApiError> {
        self.refresh_ceiling();
        serde_json::to_writer(self, value).map_err(catalogue_json_error)
    }
    pub(crate) fn bytes(&mut self, value: &[u8]) -> Result<(), ApiError> {
        self.refresh_ceiling();
        self.write_all(value).map_err(catalogue_write_error)
    }
    fn refresh_ceiling(&mut self) {
        self.ceiling = if self.in_item {
            self.count
                .limit
                .min(self.item_start.saturating_add(self.item_limit))
        } else {
            self.count.limit
        };
    }
    /// Content tag of the bytes written so far, plus `suffix` (the pagination
    /// cursor). The suffix is not part of the body.
    pub(crate) fn etag(&self, suffix: &[u8]) -> String {
        let mut digest = if self.file.is_some() {
            self.digest.clone()
        } else {
            let mut digest = Sha1::new();
            digest.update(&self.memory);
            digest
        };
        digest.update(suffix);
        format!("\"{}\"", hex_digest(digest.finalize()))
    }
    pub(crate) fn response(
        mut self,
        content_type: &str,
        etag: Option<&str>,
        next: Option<&str>,
    ) -> Result<Response, ApiError> {
        let source = if let Some(file) = self.file.take() {
            let mut file = file.into_inner().map_err(|error| error.into_error())?;
            std::io::Seek::rewind(&mut file)?;
            CatalogueSource::File(fs::File::from_std(file))
        } else {
            CatalogueSource::Memory(std::io::Cursor::new(std::mem::take(&mut self.memory)))
        };
        let mut response = Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, content_type)
            .header(CACHE_CONTROL, "private, no-cache")
            .header(CONTENT_LENGTH, self.count.bytes);
        if let Some(etag) = etag {
            response = response.header(ETAG, etag);
        }
        if let Some(next) = next {
            response = response.header("x-next-cursor", next);
        }
        let capacity = match &source {
            // One read of a resident listing. A 4 KiB stream buffer made the
            // benchmark spend as long copying the body out as building it.
            CatalogueSource::Memory(cursor) => cursor.get_ref().len().max(1),
            CatalogueSource::File(_) => 64 * 1024,
        };
        let reader = CatalogueReader {
            source,
            _lease: self.lease,
        };
        Ok(response.body(Body::from_stream(ReaderStream::with_capacity(
            reader, capacity,
        )))?)
    }
    fn spill(&mut self) -> io::Result<()> {
        if self.file.is_some() {
            return Ok(());
        }
        let mut file = std::io::BufWriter::with_capacity(64 * 1024, tempfile::tempfile()?);
        file.write_all(&self.memory)?;
        self.digest.update(&self.memory);
        self.memory = Vec::new();
        self.file = Some(file);
        Ok(())
    }
    /// Append while the listing is still resident and inside both caps.
    /// Kept separate from spilling so an ordinary shelf does not pay for
    /// the file path on every fragment.
    #[inline(always)]
    fn append_resident(&mut self, bytes: &[u8]) -> bool {
        if self.file.is_some() {
            return false;
        }
        let Some(next_memory) = self.memory.len().checked_add(bytes.len()) else {
            return false;
        };
        if next_memory > self.memory_limit {
            return false;
        }
        let Some(next) = self.count.bytes.checked_add(bytes.len() as u64) else {
            return false;
        };
        if next > self.ceiling {
            return false;
        }
        self.memory.extend_from_slice(bytes);
        self.count.bytes = next;
        true
    }
    #[cold]
    #[inline(never)]
    fn reject_or_spill(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.write_spill_or_reject(bytes)
    }
    fn write_spill_or_reject(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let len = bytes.len() as u64;
        if len == 0 {
            return Ok(0);
        }
        let too_large =
            || io::Error::new(io::ErrorKind::FileTooLarge, "catalogue byte limit exceeded");
        if self.in_item {
            let used = self.count.bytes.saturating_sub(self.item_start);
            if len > self.item_limit.saturating_sub(used) {
                return Err(too_large());
            }
        }
        if len > self.count.limit.saturating_sub(self.count.bytes) {
            return Err(too_large());
        }
        if self.file.is_none() {
            self.spill()?;
        }
        let Some(file) = self.file.as_mut() else {
            return Err(io::Error::other("catalogue spill did not open a file"));
        };
        file.write_all(bytes)?;
        self.digest.update(bytes);
        self.count.bytes += len;
        Ok(bytes.len())
    }
}
impl Write for CatalogueSpool {
    #[inline(always)]
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        // Refuse a chunk that would pass a cap instead of storing it. A
        // short write would let a serializer retry the tail and keep going.
        if self.append_resident(bytes) {
            return Ok(bytes.len());
        }
        self.reject_or_spill(bytes)
    }
    #[inline(always)]
    fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        // `serde_json` calls `write_all`. The default loops and checks for
        // interrupts; `Vec`'s own `write_all` is one append, which is what
        // an ordinary listing has to match.
        if self.append_resident(bytes) {
            Ok(())
        } else {
            self.reject_or_spill(bytes).map(|_| ())
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        if let Some(file) = &mut self.file {
            file.flush()?;
        }
        Ok(())
    }
}
enum CatalogueSource {
    Memory(std::io::Cursor<Vec<u8>>),
    File(fs::File),
}
struct CatalogueReader {
    source: CatalogueSource,
    _lease: CatalogueLease,
}
impl AsyncRead for CatalogueReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match &mut self.source {
            CatalogueSource::Memory(cursor) => Pin::new(cursor).poll_read(cx, buf),
            CatalogueSource::File(file) => Pin::new(file).poll_read(cx, buf),
        }
    }
}

pub(crate) struct CatalogueFieldsBudget(u64);
impl CatalogueFieldsBudget {
    pub(crate) fn new() -> Self {
        Self(CATALOGUE_MAX_BYTES)
    }
    pub(crate) fn insert<'a>(
        &mut self,
        set: &mut std::collections::BTreeSet<&'a str>,
        value: &'a str,
    ) -> Result<(), ApiError> {
        if !set.contains(value) {
            let cost = value.len() as u64 + 64;
            if cost > self.0 {
                return Err(catalogue_too_large());
            }
            self.0 -= cost;
            set.insert(value);
        }
        Ok(())
    }
}

#[cfg(test)]
impl CatalogueSpool {
    pub(crate) fn resident(&self) -> &[u8] {
        &self.memory
    }

    pub(crate) fn stored_bytes(&self) -> u64 {
        self.count.bytes
    }

    pub(crate) fn has_spilled(&self) -> bool {
        self.file.is_some()
    }

    pub(crate) fn resident_capacity(&self) -> usize {
        self.memory.capacity()
    }
}

#[cfg(test)]
pub(crate) fn lease_for_tests() -> CatalogueLease {
    let global = Arc::new(Semaphore::new(1));
    let account = Arc::new(Semaphore::new(1));
    CatalogueLease {
        _server: global.try_acquire_owned().unwrap(),
        _account: account.try_acquire_owned().unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn held_lease() -> (Arc<Semaphore>, Arc<Semaphore>, CatalogueLease) {
        let global = Arc::new(Semaphore::new(1));
        let account = Arc::new(Semaphore::new(1));
        let lease = CatalogueLease {
            _server: global.clone().try_acquire_owned().unwrap(),
            _account: account.clone().try_acquire_owned().unwrap(),
        };
        (global, account, lease)
    }

    #[test]
    fn spool_enforces_aggregate_bytes_before_publication() {
        let (global, account, lease) = held_lease();
        let mut spool = CatalogueSpool::new(lease).unwrap();
        spool.count.limit = 12;
        spool.bytes(b"[").unwrap();
        spool.json(&"hello").unwrap();
        assert!(spool.json(&"second item").is_err());
        assert!(spool.memory.len() <= 12);
        assert!(spool.file.is_none());
        drop(spool);
        assert_eq!(global.available_permits(), 1);
        assert_eq!(account.available_permits(), 1);
    }

    #[test]
    fn one_item_over_the_book_budget_is_rejected() {
        let (global, account, lease) = held_lease();
        let mut spool = CatalogueSpool::new(lease).unwrap();
        spool.item_limit = 4;
        spool.begin_item();
        spool.bytes(b"abcd").unwrap();
        spool.finish_item().unwrap();
        spool.begin_item();
        let rejected = spool.bytes(b"abcde").unwrap_err();
        assert_eq!(rejected.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(spool.count.bytes, 4, "the over-budget chunk was stored");
        assert_eq!(spool.memory, b"abcd");
        assert!(spool.file.is_none());
        drop(spool);
        assert_eq!(global.available_permits(), 1);
        assert_eq!(account.available_permits(), 1);
    }

    #[tokio::test]
    async fn spool_publishes_modest_bytes_with_their_length_and_content_etag() {
        let (global, account, lease) = held_lease();
        let value = vec!["track title"; 100];
        let expected = serde_json::to_vec(&value).unwrap();
        let mut spool = CatalogueSpool::new(lease).unwrap();
        spool.json(&value).unwrap();
        assert!(spool.file.is_none(), "a small listing must not open a file");
        let etag = spool.etag(b"\nend");
        let mut tagged = expected.clone();
        tagged.extend_from_slice(b"\nend");
        assert_eq!(etag, bytes_etag(&tagged));
        let response = spool
            .response("application/json", Some(&etag), None)
            .unwrap();
        assert_eq!(
            response.headers()[CONTENT_LENGTH],
            expected.len().to_string()
        );
        assert_eq!(response.headers()[ETAG], etag);
        let body = axum::body::to_bytes(response.into_body(), expected.len())
            .await
            .unwrap();
        assert_eq!(body.as_ref(), expected);
        assert_eq!(global.available_permits(), 1);
        assert_eq!(account.available_permits(), 1);
    }

    #[tokio::test]
    async fn spilled_catalogue_keeps_a_content_etag() {
        let (global, account, lease) = held_lease();
        let value = vec!["track title"; 40];
        let expected = serde_json::to_vec(&value).unwrap();
        let mut spool = CatalogueSpool::new(lease).unwrap();
        spool.memory_limit = 32;
        assert!(expected.len() > spool.memory_limit);
        spool.json(&value).unwrap();
        assert!(spool.file.is_some(), "the body should have spilled");
        let etag = spool.etag(b"\nnext:cursor");
        let mut tagged = expected.clone();
        tagged.extend_from_slice(b"\nnext:cursor");
        assert_eq!(etag, bytes_etag(&tagged));
        let response = spool
            .response("application/json", Some(&etag), Some("cursor"))
            .unwrap();
        assert_eq!(
            response.headers()[CONTENT_LENGTH],
            expected.len().to_string()
        );
        assert_eq!(response.headers()[ETAG], etag);
        assert_eq!(response.headers()["x-next-cursor"], "cursor");
        let body = axum::body::to_bytes(response.into_body(), expected.len())
            .await
            .unwrap();
        assert_eq!(body.as_ref(), expected);
        assert_eq!(global.available_permits(), 1);
        assert_eq!(account.available_permits(), 1);
    }

    #[test]
    fn oversized_items_fail_before_the_buffer_passes_its_budget() {
        let (_global, _account, lease) = held_lease();
        let mut spool = CatalogueSpool::new(lease).unwrap();
        let oversized = "x".repeat(CATALOGUE_BOOK_BYTES as usize + 64 * 1024);
        spool.begin_item();
        let rejected = spool.json(&oversized).unwrap_err();
        assert_eq!(rejected.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(spool.count.bytes <= CATALOGUE_BOOK_BYTES);
        assert!(spool.memory.len() as u64 <= CATALOGUE_BOOK_BYTES);
        assert!(spool.memory.capacity() <= CATALOGUE_MEMORY_LIMIT);
        assert!(
            spool.file.is_none(),
            "a book over the per-book cap must not spill"
        );

        let (_global, _account, lease) = held_lease();
        let mut spool = CatalogueSpool::new(lease).unwrap();
        spool.begin_item();
        let chunk = vec![b'x'; CATALOGUE_BOOK_BYTES as usize + 1];
        let rejected = spool.bytes(&chunk).unwrap_err();
        assert_eq!(rejected.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(spool.count.bytes, 0);
        assert!(spool.memory.is_empty());
        assert!(spool.memory.capacity() <= CATALOGUE_MEMORY_LIMIT);
        assert!(spool.file.is_none());
    }

    #[test]
    fn resident_and_aggregate_caps_bind_before_a_chunk_is_stored() {
        let (_global, _account, lease) = held_lease();
        let mut spool = CatalogueSpool::new(lease).unwrap();
        spool.item_limit = 10;
        spool.memory_limit = 8;
        spool.count.limit = 24;
        spool.begin_item();
        spool.bytes(b"01234567").unwrap();
        // Four more bytes would cross the per-book cap. Refuse them before
        // they are appended or spilled.
        let rejected = spool.bytes(b"89ab").unwrap_err();
        assert_eq!(rejected.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(spool.file.is_none());
        assert_eq!(spool.memory, b"01234567");
        assert_eq!(spool.count.bytes, 8);

        spool.finish_item().unwrap();
        spool.item_limit = 100;
        spool.begin_item();
        spool.bytes(b"89ab").unwrap();
        assert!(spool.file.is_some());
        assert!(spool.memory.is_empty());
        assert!(spool.memory.capacity() <= spool.memory_limit);
        assert_eq!(spool.count.bytes, 12);

        let rejected = spool.bytes(b"0123456789abcdef").unwrap_err();
        assert_eq!(rejected.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(spool.count.bytes, 12);
        spool.flush().unwrap();
        let file = spool.file.as_mut().unwrap();
        file.flush().unwrap();
        assert_eq!(file.get_ref().metadata().unwrap().len(), 12);
    }
}
