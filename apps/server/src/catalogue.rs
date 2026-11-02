//! Catalogue generation is bounded before copying metadata and while a slow
//! client retains its response. Anonymous spools keep complete legacy feeds
//! off the heap without exposing partial JSON/XML when a budget is exceeded.
use crate::*;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, ReadBuf};

pub(crate) const CATALOGUE_CONCURRENCY: usize = 2;
const CATALOGUE_MAX_BYTES: u64 = 64 * 1024 * 1024;
const CATALOGUE_BOOK_BYTES: u64 = 2 * 1024 * 1024;

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

pub(crate) struct CatalogueSpool {
    file: std::io::BufWriter<std::fs::File>,
    count: CountWriter,
    digest: Sha1,
    lease: CatalogueLease,
}
impl CatalogueSpool {
    pub(crate) fn new(lease: CatalogueLease) -> Result<Self, ApiError> {
        Ok(Self {
            file: std::io::BufWriter::with_capacity(8 * 1024, tempfile::tempfile()?),
            count: CountWriter {
                bytes: 0,
                limit: CATALOGUE_MAX_BYTES,
            },
            digest: Sha1::new(),
            lease,
        })
    }
    pub(crate) fn json(&mut self, value: &impl Serialize) -> Result<(), ApiError> {
        serde_json::to_writer(self, value).map_err(|error| {
            if error.io_error_kind() == Some(io::ErrorKind::FileTooLarge) {
                catalogue_too_large()
            } else {
                ApiError::internal("Could not prepare catalogue response.")
            }
        })
    }
    pub(crate) fn bytes(&mut self, value: &[u8]) -> Result<(), ApiError> {
        self.write_all(value).map_err(|error| {
            if error.kind() == io::ErrorKind::FileTooLarge {
                catalogue_too_large()
            } else {
                ApiError::internal("Could not prepare catalogue response.")
            }
        })
    }
    pub(crate) fn etag(&self, suffix: &[u8]) -> String {
        let mut digest = self.digest.clone();
        digest.update(suffix);
        format!("\"{}\"", hex_digest(digest.finalize()))
    }
    pub(crate) fn response(
        self,
        content_type: &str,
        etag: Option<&str>,
        next: Option<&str>,
    ) -> Result<Response, ApiError> {
        let mut file = self.file.into_inner().map_err(|error| error.into_error())?;
        std::io::Seek::rewind(&mut file)?;
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
        let reader = CatalogueReader {
            file: fs::File::from_std(file),
            _lease: self.lease,
        };
        Ok(response.body(Body::from_stream(ReaderStream::new(reader)))?)
    }
}
impl Write for CatalogueSpool {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.count.write_all(bytes)?;
        self.file.write_all(bytes)?;
        self.digest.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}
struct CatalogueReader {
    file: fs::File,
    _lease: CatalogueLease,
}
impl AsyncRead for CatalogueReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.file).poll_read(cx, buf)
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
mod tests {
    use super::*;
    #[test]
    fn spool_enforces_aggregate_bytes_before_publication() {
        let global = Arc::new(Semaphore::new(1));
        let account = Arc::new(Semaphore::new(1));
        let lease = CatalogueLease {
            _server: global.clone().try_acquire_owned().unwrap(),
            _account: account.clone().try_acquire_owned().unwrap(),
        };
        let mut spool = CatalogueSpool::new(lease).unwrap();
        spool.count.limit = 12;
        spool.bytes(b"[").unwrap();
        spool.json(&"hello").unwrap();
        assert!(spool.json(&"second item").is_err());
        assert!(spool.file.get_ref().metadata().unwrap().len() <= 12);
        drop(spool);
        assert_eq!(global.available_permits(), 1);
        assert_eq!(account.available_permits(), 1);
    }
    #[tokio::test]
    async fn spool_publishes_buffered_bytes_with_their_length_and_digest() {
        let global = Arc::new(Semaphore::new(1));
        let account = Arc::new(Semaphore::new(1));
        let lease = CatalogueLease {
            _server: global.clone().try_acquire_owned().unwrap(),
            _account: account.clone().try_acquire_owned().unwrap(),
        };
        let value = vec!["track title"; 100];
        let expected = serde_json::to_vec(&value).unwrap();
        let mut spool = CatalogueSpool::new(lease).unwrap();
        spool.json(&value).unwrap();
        assert_eq!(spool.file.get_ref().metadata().unwrap().len(), 0);
        let etag = spool.etag(&[]);
        assert_eq!(etag, format!("\"{}\"", hex_digest(Sha1::digest(&expected))));
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
}
