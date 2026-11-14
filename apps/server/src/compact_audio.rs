//! A compact sample-size index for opted-in MP4 streams.
//! Timing tables, edit lists, text metadata and encoded samples retain their
//! original bytes. Embedded cover art is omitted from the stream: native
//! artwork comes from the separate cover endpoint. Source files stay intact.
//! Unsupported layouts use the source.

use std::fs::{File, Metadata};
use std::io::{Read, Seek, SeekFrom};
use std::sync::{Arc, Mutex};

const MAX_HEADER_BYTES: usize = 32 * 1024 * 1024;
const MAX_CACHE_BYTES: usize = 32 * 1024 * 1024;

pub(crate) struct CompactHeader {
    pub bytes: Arc<[u8]>,
    pub removed: u64,
}

#[derive(PartialEq, Eq)]
struct FileKey {
    length: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

impl FileKey {
    fn new(metadata: &Metadata) -> Self {
        Self {
            length: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            identity: {
                use std::os::unix::fs::MetadataExt;
                (
                    metadata.dev(),
                    metadata.ino(),
                    metadata.ctime(),
                    metadata.ctime_nsec(),
                )
            },
        }
    }
}

// Serialize misses as well as bounding retained headers: many simultaneous
// stream probes must not each allocate another large source index.
static CACHE: Mutex<Vec<(FileKey, Option<Arc<CompactHeader>>)>> = Mutex::new(Vec::new());

pub(crate) fn cached_header(file: &mut File, metadata: &Metadata) -> Option<Arc<CompactHeader>> {
    let key = FileKey::new(metadata);
    let mut cache = CACHE.lock().ok()?;
    // Unix ctime and inode distinguish replacements even with a preserved
    // mtime. Other platforms still compact, without retaining file identities.
    if cfg!(unix)
        && let Some(index) = cache.iter().position(|(candidate, _)| *candidate == key)
    {
        let entry = cache.remove(index);
        let result = entry.1.clone();
        cache.push(entry);
        return result;
    }
    let result = compact_header(file, metadata.len()).map(Arc::new);
    if FileKey::new(&file.metadata().ok()?) != key {
        return None;
    }
    if cfg!(unix) {
        let incoming = result.as_ref().map_or(0, |header| header.bytes.len());
        while !cache.is_empty()
            && (cache.len() >= 64
                || cache
                    .iter()
                    .filter_map(|(_, header)| header.as_ref())
                    .map(|header| header.bytes.len())
                    .sum::<usize>()
                    + incoming
                    > MAX_CACHE_BYTES)
        {
            cache.remove(0);
        }
        cache.push((key, result.clone()));
    }
    result
}

/// Accept a single, ordinary faststart MP4. Fragment offsets and auxiliary
/// indexes have different relocation rules and are deliberately left alone.
pub(crate) fn compact_header(file: &mut File, length: u64) -> Option<CompactHeader> {
    let mut offset = 0_u64;
    let mut moov = None;
    let mut media = None;
    for _ in 0..4096 {
        if offset == length {
            break;
        }
        file.seek(SeekFrom::Start(offset)).ok()?;
        let mut box_header = [0; 16];
        file.read_exact(&mut box_header[..8]).ok()?;
        let size = u64::from(u32::from_be_bytes(box_header[..4].try_into().ok()?));
        let extended = size == 1;
        let size = if extended {
            file.read_exact(&mut box_header[8..]).ok()?;
            u64::from_be_bytes(box_header[8..].try_into().ok()?)
        } else if size == 0 {
            length.checked_sub(offset)?
        } else {
            size
        };
        let end = offset.checked_add(size)?;
        if size < if extended { 16 } else { 8 } || end > length {
            return None;
        }
        match &box_header[4..8] {
            b"ftyp" | b"free" | b"skip" => {}
            b"moov" if moov.is_none() && media.is_none() => {
                if extended || end > MAX_HEADER_BYTES as u64 || size > u32::MAX as u64 {
                    return None;
                }
                moov = Some((offset as usize, end as usize));
            }
            b"mdat" if media.is_none() => {
                media = Some((offset + if extended { 16 } else { 8 }, end))
            }
            _ => return None,
        }
        offset = end;
    }
    if offset != length {
        return None;
    }
    let (start, end) = moov?;
    let media = media?;
    let mut source = vec![0; end];
    file.seek(SeekFrom::Start(0)).ok()?;
    file.read_exact(&mut source).ok()?;
    let mut bytes = Vec::with_capacity(source.len());
    bytes.extend_from_slice(&source[..start]);
    let mut chunk_tables = Vec::new();
    rewrite_boxes(&source[start..], &mut bytes, &mut chunk_tables, 0, b"root")?;
    let removed = end.checked_sub(bytes.len())? as u64;
    if removed == 0 {
        return None;
    }
    for (position, width) in chunk_tables {
        let count = read_u32(&bytes, position + 12)? as usize;
        for index in 0..count {
            let entry = position + 16 + index * width;
            let old = if width == 4 {
                u64::from(read_u32(&bytes, entry)?)
            } else {
                u64::from_be_bytes(bytes.get(entry..entry + 8)?.try_into().ok()?)
            };
            if old < media.0 || old >= media.1 {
                return None;
            }
            let new = old.checked_sub(removed)?;
            if width == 4 {
                bytes[entry..entry + 4].copy_from_slice(&u32::try_from(new).ok()?.to_be_bytes());
            } else {
                bytes[entry..entry + 8].copy_from_slice(&new.to_be_bytes());
            }
        }
    }
    Some(CompactHeader {
        bytes: bytes.into(),
        removed,
    })
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
    ))
}

fn rewrite_boxes(
    source: &[u8],
    output: &mut Vec<u8>,
    chunks: &mut Vec<(usize, usize)>,
    depth: usize,
    parent: &[u8],
) -> Option<()> {
    if depth > 8 {
        return None;
    }
    let mut offset = 0;
    while offset < source.len() {
        let size = read_u32(source, offset)? as usize;
        if size < 8 {
            return None;
        }
        let atom = source.get(offset..offset.checked_add(size)?)?;
        let kind = atom.get(4..8)?;
        let start = output.len();
        match kind {
            b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" | b"udta" | b"meta" | b"ilst" => {
                let prefix = if kind == b"meta" { 12 } else { 8 };
                output.extend_from_slice(atom.get(..prefix)?);
                rewrite_boxes(atom.get(prefix..)?, output, chunks, depth + 1, kind)?;
                let length = u32::try_from(output.len() - start).ok()?;
                output[start..start + 4].copy_from_slice(&length.to_be_bytes());
            }
            b"covr" if parent == b"ilst" => {}
            b"mvex" | b"cmov" | b"saio" | b"sinf" | b"iloc" | b"uuid" => return None,
            b"stsz" => {
                let sample_size = read_u32(atom, 12)?;
                let count = read_u32(atom, 16)? as usize;
                if atom.get(8..12)? != [0, 0, 0, 0] {
                    return None;
                }
                if sample_size != 0 {
                    if size != 20 {
                        return None;
                    }
                    output.extend_from_slice(atom);
                } else {
                    if size != 20_usize.checked_add(count.checked_mul(4)?)? {
                        return None;
                    }
                    // ISO BMFF's compact sample-size table has the same sample
                    // count/order; AAC packet sizes normally fit in 16 bits.
                    let fits = (0..count).all(|index| {
                        read_u32(atom, 20 + index * 4).is_some_and(|value| value <= u16::MAX.into())
                    });
                    if count == 0 || !fits {
                        output.extend_from_slice(atom);
                    } else {
                        let length = u32::try_from(20 + count * 2).ok()?;
                        output.extend_from_slice(&length.to_be_bytes());
                        output.extend_from_slice(b"stz2\0\0\0\0\0\0\0\x10");
                        output.extend_from_slice(&(count as u32).to_be_bytes());
                        for index in 0..count {
                            output.extend_from_slice(
                                &(read_u32(atom, 20 + index * 4)? as u16).to_be_bytes(),
                            );
                        }
                    }
                }
            }
            b"stco" | b"co64" => {
                if atom.get(8..12)? != [0, 0, 0, 0] {
                    return None;
                }
                let width = if kind == b"stco" { 4 } else { 8 };
                let count = read_u32(atom, 12)? as usize;
                if size != 16_usize.checked_add(count.checked_mul(width)?)? {
                    return None;
                }
                chunks.push((start, width));
                output.extend_from_slice(atom);
            }
            _ => output.extend_from_slice(atom),
        }
        offset += size;
    }
    Some(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn atom(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut bytes = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(body);
        bytes
    }

    pub(crate) fn fixture(wide: bool, extended: bool) -> Vec<u8> {
        let mut sizes = vec![0; 8];
        sizes.extend_from_slice(&4_u32.to_be_bytes());
        for size in [2_u32, 3, 4, 5] {
            sizes.extend_from_slice(&size.to_be_bytes());
        }
        let mut chunks = vec![0; 4];
        chunks.extend_from_slice(&1_u32.to_be_bytes());
        chunks.extend_from_slice(&0_u32.to_be_bytes());
        if wide {
            chunks.extend_from_slice(&0_u32.to_be_bytes());
        }
        let mut tables = atom(b"stsz", &sizes);
        tables.extend_from_slice(&atom(if wide { b"co64" } else { b"stco" }, &chunks));
        let mut moov = atom(
            b"moov",
            &atom(
                b"trak",
                &atom(b"mdia", &atom(b"minf", &atom(b"stbl", &tables))),
            ),
        );
        let ftyp = atom(b"ftyp", b"M4A \0\0\0\0");
        let payload_start = (ftyp.len() + moov.len() + if extended { 16 } else { 8 }) as u64;
        let chunk_pos = moov
            .windows(4)
            .position(|part| part == if wide { b"co64" } else { b"stco" })
            .unwrap()
            + 12;
        if wide {
            moov[chunk_pos..chunk_pos + 8].copy_from_slice(&payload_start.to_be_bytes());
        } else {
            moov[chunk_pos..chunk_pos + 4].copy_from_slice(&(payload_start as u32).to_be_bytes());
        }
        let mut result = ftyp;
        result.extend_from_slice(&moov);
        let payload = b"abcdefghijklmn";
        if extended {
            result.extend_from_slice(&1_u32.to_be_bytes());
            result.extend_from_slice(b"mdat");
            result.extend_from_slice(&(payload.len() as u64 + 16).to_be_bytes());
            result.extend_from_slice(payload);
        } else {
            result.extend_from_slice(&atom(b"mdat", payload));
        }
        result
    }

    fn compact(source: &[u8]) -> Option<CompactHeader> {
        let mut file = tempfile::tempfile().unwrap();
        std::io::Write::write_all(&mut file, source).unwrap();
        compact_header(&mut file, source.len() as u64)
    }

    #[test]
    fn omits_embedded_artwork_but_keeps_text_metadata_and_audio() {
        let source = fixture(false, false);
        let moov_start = read_u32(&source, 0).unwrap() as usize;
        let moov_end = moov_start + read_u32(&source, moov_start).unwrap() as usize;
        let title = atom(b"\xa9nam", &atom(b"data", b"book title"));
        let cover = atom(b"covr", &atom(b"data", &[7; 1024]));
        let mut items = title.clone();
        items.extend_from_slice(&cover);
        let mut metadata = vec![0; 4];
        metadata.extend_from_slice(&atom(b"ilst", &items));
        let metadata = atom(b"udta", &atom(b"meta", &metadata));
        let mut covered = source[..moov_end].to_vec();
        covered.extend_from_slice(&metadata);
        covered.extend_from_slice(&source[moov_end..]);
        let size = (moov_end - moov_start + metadata.len()) as u32;
        covered[moov_start..moov_start + 4].copy_from_slice(&size.to_be_bytes());
        let offset_pos = covered.windows(4).position(|part| part == b"stco").unwrap() + 12;
        let offset = read_u32(&covered, offset_pos).unwrap() + metadata.len() as u32;
        covered[offset_pos..offset_pos + 4].copy_from_slice(&offset.to_be_bytes());
        let header = compact(&covered).unwrap();
        assert_eq!(header.removed, 8 + cover.len() as u64);
        assert!(header.bytes.windows(title.len()).any(|part| part == title));
        assert!(!header.bytes.windows(4).any(|part| part == b"covr"));
        let mut result = header.bytes.to_vec();
        result.extend_from_slice(&covered[header.bytes.len() + header.removed as usize..]);
        let offset_pos = result.windows(4).position(|part| part == b"stco").unwrap() + 12;
        let offset = read_u32(&result, offset_pos).unwrap() as usize;
        assert_eq!(&result[offset..], b"abcdefghijklmn");
        assert_eq!(&covered[covered.len() - 14..], b"abcdefghijklmn");
    }

    #[test]
    fn compact_sizes_preserve_samples_and_relocate_both_chunk_widths() {
        for wide in [false, true] {
            for extended in [false, true] {
                let source = fixture(wide, extended);
                let header = compact(&source).unwrap();
                assert_eq!(header.removed, 8);
                let mut result = header.bytes.to_vec();
                result.extend_from_slice(&source[header.bytes.len() + header.removed as usize..]);
                let index = result.windows(4).position(|part| part == b"stz2").unwrap();
                assert_eq!(&result[index + 8..index + 12], &[0, 0, 0, 16]);
                assert_eq!(&result[index + 16..index + 24], &[0, 2, 0, 3, 0, 4, 0, 5]);
                let chunk = result
                    .windows(4)
                    .position(|part| part == if wide { b"co64" } else { b"stco" })
                    .unwrap()
                    + 12;
                let offset = if wide {
                    u64::from_be_bytes(result[chunk..chunk + 8].try_into().unwrap())
                } else {
                    read_u32(&result, chunk).unwrap().into()
                };
                assert_eq!(&result[offset as usize..], b"abcdefghijklmn");
                assert!(
                    compact(&result).is_none(),
                    "already compact data stays unchanged"
                );
            }
        }
    }

    #[test]
    fn unsupported_or_malformed_indexes_use_the_original() {
        let source = fixture(false, false);
        for marker in [b"mvex", b"cmov", b"saio", b"iloc"] {
            let mut invalid = source.clone();
            let pos = invalid.windows(4).position(|part| part == b"stsz").unwrap();
            invalid[pos..pos + 4].copy_from_slice(marker);
            assert!(compact(&invalid).is_none());
        }
        for length in 0..source.len() {
            assert!(compact(&source[..length]).is_none());
        }
        let mut invalid = source.clone();
        let pos = invalid.windows(4).position(|part| part == b"stco").unwrap() + 12;
        invalid[pos..pos + 4].copy_from_slice(&1_u32.to_be_bytes());
        assert!(compact(&invalid).is_none());
        let mut large_sample = source.clone();
        let pos = large_sample
            .windows(4)
            .position(|part| part == b"stsz")
            .unwrap()
            + 16;
        large_sample[pos..pos + 4].copy_from_slice(&65536_u32.to_be_bytes());
        assert!(compact(&large_sample).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn cached_headers_change_when_a_same_sized_file_preserves_its_mtime() {
        let mut source = fixture(false, false);
        let mut file = tempfile::tempfile().unwrap();
        std::io::Write::write_all(&mut file, &source).unwrap();
        let metadata = file.metadata().unwrap();
        let first = cached_header(&mut file, &metadata).unwrap();
        let pos = source.windows(4).position(|part| part == b"stsz").unwrap() + 16;
        source[pos..pos + 4].copy_from_slice(&3_u32.to_be_bytes());
        file.seek(SeekFrom::Start(0)).unwrap();
        std::io::Write::write_all(&mut file, &source).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(metadata.modified().unwrap()))
            .unwrap();
        let metadata = file.metadata().unwrap();
        let second = cached_header(&mut file, &metadata).unwrap();
        assert_ne!(first.bytes, second.bytes);
        assert_eq!(first.removed, second.removed);
    }
}
