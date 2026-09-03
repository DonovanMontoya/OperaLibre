//! Small shared helpers: timestamps, hashing and ids, filename sanitising,
//! and HTTP range parsing.

use crate::*;

pub(crate) fn human_bytes(bytes: u64) -> String {
    const MIB: u64 = 1024 * 1024;
    if bytes >= 1024 * MIB {
        format!("{:.1} GiB", bytes as f64 / (1024.0 * MIB as f64))
    } else if bytes >= MIB {
        format!("{:.1} MiB", bytes as f64 / MIB as f64)
    } else {
        format!("{} KiB", bytes.div_ceil(1024))
    }
}

pub(crate) fn sanitize_filename(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            other if other.is_control() => '_',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "audiobook".to_string()
    } else {
        trimmed
    }
}

/// Percent-encode a filename for an RFC 8187 `filename*=UTF-8''...` parameter.
/// Only the RFC's `attr-char` set passes through unencoded.
pub(crate) fn rfc8187_encode(value: &str) -> String {
    use std::fmt::Write as _;

    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        let plain = byte.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&byte);
        if plain {
            encoded.push(byte as char);
        } else {
            write!(encoded, "%{byte:02X}").expect("writing to a String cannot fail");
        }
    }
    encoded
}

pub(crate) fn sanitize_zip_entry(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| match character {
            '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            other if other.is_control() => '_',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim_start_matches('/').to_string();
    if trimmed.is_empty() {
        "track".to_string()
    } else {
        trimmed
    }
}

pub(crate) fn bytes_etag(data: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(data);
    format!("\"{}\"", hex_digest(hasher.finalize()))
}

pub(crate) fn stable_id(input: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(input.as_bytes());
    hex_digest(hasher.finalize())[..16].to_string()
}

pub(crate) fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    use std::fmt::Write as _;

    bytes
        .as_ref()
        .iter()
        .fold(String::new(), |mut output, byte| {
            write!(output, "{byte:02x}").expect("writing to a String cannot fail");
            output
        })
}

pub(crate) fn progress_key(user_id: &str, book_id: &str) -> String {
    format!("user:{user_id}:book:{book_id}")
}

/// How a `Range` request header should be answered.
///
/// RFC 9110 separates the two failure cases: a range the server does not
/// understand (another unit, several ranges, a malformed spec) is ignored and
/// the full body is sent with 200, whereas a well-formed byte range that lies
/// outside the file is refused with 416.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ByteRange {
    /// A single satisfiable byte range, as an inclusive `(start, end)` pair.
    Satisfiable(u64, u64),
    /// A well-formed byte range that no part of the file can satisfy.
    Unsatisfiable,
    /// Not a single byte range this server serves; the header is ignored.
    Unsupported,
}

pub(crate) fn parse_byte_range(range: &str, file_size: u64) -> ByteRange {
    let Some(range) = range.strip_prefix("bytes=") else {
        return ByteRange::Unsupported;
    };
    // Multiple ranges would need a multipart/byteranges body, which nothing
    // here produces. Falling back to the full body is what the RFC permits.
    if range.contains(',') {
        return ByteRange::Unsupported;
    }
    let Some((start, end)) = range.split_once('-') else {
        return ByteRange::Unsupported;
    };

    if start.is_empty() {
        let Ok(suffix_length) = end.parse::<u64>() else {
            return ByteRange::Unsupported;
        };
        // An empty file has no last byte for any suffix to end on.
        let Some(last) = file_size.checked_sub(1) else {
            return ByteRange::Unsatisfiable;
        };
        if suffix_length == 0 {
            return ByteRange::Unsatisfiable;
        }
        return ByteRange::Satisfiable(file_size.saturating_sub(suffix_length), last);
    }

    let Ok(start) = start.parse::<u64>() else {
        return ByteRange::Unsupported;
    };
    let end = if end.is_empty() {
        None
    } else {
        match end.parse::<u64>() {
            Ok(end) => Some(end),
            Err(_) => return ByteRange::Unsupported,
        }
    };
    if end.is_some_and(|end| end < start) {
        return ByteRange::Unsupported;
    }

    let Some(last) = file_size.checked_sub(1) else {
        return ByteRange::Unsatisfiable;
    };
    if start > last {
        return ByteRange::Unsatisfiable;
    }
    ByteRange::Satisfiable(start, end.map_or(last, |end| end.min(last)))
}

/// The satisfiable byte range, if there is exactly one. Serving code tells an
/// ignorable header from an unsatisfiable range with [`parse_byte_range`].
#[cfg(test)]
pub(crate) fn parse_range(range: &str, file_size: u64) -> Option<(u64, u64)> {
    match parse_byte_range(range, file_size) {
        ByteRange::Satisfiable(start, end) => Some((start, end)),
        ByteRange::Unsatisfiable | ByteRange::Unsupported => None,
    }
}

pub(crate) fn natural_path_key(path: &FsPath) -> String {
    path.to_string_lossy().to_lowercase()
}

pub(crate) fn unix_now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub(crate) fn unix_now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Unix seconds as a string: it is what the stores have always written, and
/// their timestamps are compared, not displayed. Anything that has to hand a
/// timestamp to another program wants [`rfc3339_utc`] instead.
pub(crate) fn now_unix_string() -> String {
    unix_now_seconds().to_string()
}

/// A real RFC 3339 instant in UTC, for formats that specify one.
///
/// Atom requires this for `<updated>`, and a strict reader rejects a feed that
/// carries a bare unix timestamp there.
pub(crate) fn rfc3339_utc(unix_seconds: u64) -> String {
    let days = (unix_seconds / 86_400) as i64;
    let seconds_today = unix_seconds % 86_400;
    format!(
        "{}T{:02}:{:02}:{:02}Z",
        days_to_ymd(days),
        seconds_today / 3_600,
        (seconds_today % 3_600) / 60,
        seconds_today % 60
    )
}

pub(crate) fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (left, right) in left.iter().zip(right) {
        difference |= left ^ right;
    }
    difference == 0
}
