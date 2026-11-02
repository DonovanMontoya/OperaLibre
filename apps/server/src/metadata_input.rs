//! Freeze and validate allocation-driving metadata before third-party parsers
//! see it. Audio payloads are sought over, so a large recording is not itself
//! a large metadata allocation. Parsers consume this same checked descriptor.
use crate::*;
use std::io::{Seek, SeekFrom as StdSeekFrom};

const TAG_BYTES: u64 = 8 * 1024 * 1024;
const CONTAINER_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ITEMS: usize = 10_000;
pub(crate) const READ_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) static METADATA_PARSE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Clone)]
struct Snapshot {
    start: u64,
    bytes: Arc<Vec<u8>>,
}
pub(crate) struct MetadataInput {
    file: std::fs::File,
    len: u64,
    pos: u64,
    remaining: u64,
    snapshots: Vec<Snapshot>,
    stored: u64,
    chapter_track: Vec<ParsedChapter>,
}
fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "Audio metadata exceeds its bounds or is malformed",
    )
}
fn be32(b: &[u8]) -> io::Result<u32> {
    Ok(u32::from_be_bytes(
        b.get(..4).ok_or_else(invalid)?.try_into().unwrap(),
    ))
}
fn le32(b: &[u8]) -> io::Result<u32> {
    Ok(u32::from_le_bytes(
        b.get(..4).ok_or_else(invalid)?.try_into().unwrap(),
    ))
}
fn synchsafe(b: &[u8]) -> io::Result<u32> {
    if b.len() < 4 || b[..4].iter().any(|n| n & 128 != 0) {
        return Err(invalid());
    }
    Ok(b[..4].iter().fold(0, |n, v| (n << 7) | u32::from(*v)))
}
impl MetadataInput {
    pub(crate) fn open(path: &FsPath) -> io::Result<Self> {
        Self::new(std::fs::File::open(path)?)
    }
    pub(crate) fn new(file: std::fs::File) -> io::Result<Self> {
        let len = file.metadata()?.len();
        let mut input = Self {
            file,
            len,
            pos: 0,
            remaining: READ_BYTES,
            snapshots: Vec::new(),
            stored: 0,
            chapter_track: Vec::new(),
        };
        let head = input.freeze(0, len.min(32))?;
        let mut offset = 0;
        if head.starts_with(b"ID3") {
            for _ in 0..MAX_ITEMS {
                let h = input.freeze(offset, (len - offset).min(10))?;
                if !h.starts_with(b"ID3") {
                    break;
                }
                if h.len() < 10 {
                    return Err(invalid());
                }
                let size = u64::from(synchsafe(&h[6..])?) + 10;
                if size > TAG_BYTES || offset + size > TAG_BYTES {
                    return Err(invalid());
                }
                let tag = input.freeze(offset, size)?;
                validate_id3(&tag)?;
                offset += size;
                if offset >= len {
                    break;
                }
            }
        }
        let h = input.freeze(offset, (len - offset).min(32))?;
        if h.starts_with(b"fLaC") {
            let mut at = offset + 4;
            let mut total = 0;
            for _ in 0..MAX_ITEMS {
                let header = input.freeze(at, 4)?;
                let size = ((u64::from(header[1]) << 16)
                    | (u64::from(header[2]) << 8)
                    | u64::from(header[3]))
                    + 4;
                total += size;
                if total > TAG_BYTES {
                    return Err(invalid());
                }
                let block = input.freeze(at, size)?;
                if header[0] & 127 == 4 {
                    validate_comments(&block[4..])?;
                }
                at += size;
                if header[0] & 128 != 0 {
                    break;
                }
            }
        } else if h.get(4..8) == Some(b"ftyp") {
            let mut at = offset;
            let mut count = 0;
            let mut tracks = Vec::new();
            let mut chapter_ids = Vec::new();
            let mut atom_count = AtomBudget::default();
            while at < len {
                count += 1;
                if count > MAX_ITEMS {
                    return Err(invalid());
                }
                let head = input.freeze(at, (len - at).min(16))?;
                let (size, header) = atom_size(&head, len - at)?;
                let kind = &head[4..8];
                if matches!(kind, b"moov" | b"ftyp" | b"meta" | b"udta") {
                    if size > CONTAINER_BYTES {
                        return Err(invalid());
                    }
                    let block = input.freeze(at, size)?;
                    if kind == b"moov" {
                        validate_atoms(
                            &block[header..],
                            0,
                            &mut tracks,
                            &mut chapter_ids,
                            None,
                            false,
                            &mut atom_count,
                        )?;
                    }
                }
                at += size;
            }
            for track in &tracks {
                if chapter_ids.contains(&track.id)
                    && (track.samples > MAX_ITEMS as u64
                        || track.timed_samples > MAX_ITEMS as u64
                        || track.samples_per_chunk > MAX_ITEMS as u64)
                {
                    return Err(invalid());
                }
            }
            if let Some(track) = tracks.iter().find_map(|reference| {
                tracks
                    .iter()
                    .find(|target| reference.chapter_ids.contains(&target.id))
            }) {
                input.chapter_track = read_track_chapters(&mut input, track)?;
            }
        } else if h.starts_with(b"RIFF") || h.starts_with(b"FORM") {
            let little = h.starts_with(b"RIFF");
            let mut at = offset + 12;
            let mut tags = 0;
            for _ in 0..100_000 {
                if at >= len {
                    break;
                }
                let header = input.freeze(at, 8)?;
                let size = u64::from(if little {
                    le32(&header[4..])?
                } else {
                    be32(&header[4..])?
                });
                if size > len.saturating_sub(at + 8) {
                    return Err(invalid());
                }
                if !matches!(&header[..4], b"data" | b"SSND") {
                    tags += size + 8;
                    if tags > TAG_BYTES {
                        return Err(invalid());
                    }
                    let block = input.freeze(at, size + 8)?;
                    if header[..4].eq_ignore_ascii_case(b"id3 ") {
                        validate_id3(&block[8..])?;
                    }
                }
                at += 8 + size + (size % 2);
            }
        } else if h.starts_with(b"OggS") {
            let mut at = offset;
            let mut packet = Vec::new();
            let mut packets = 0;
            while at < len && packets < 3 {
                let header = input.freeze(at, 27)?;
                if !header.starts_with(b"OggS") {
                    return Err(invalid());
                }
                let lacing = input.freeze(at + 27, u64::from(header[26]))?;
                let size: u64 = lacing.iter().map(|v| u64::from(*v)).sum();
                let page = input.freeze(at + 27 + lacing.len() as u64, size)?;
                let mut p = 0;
                for n in lacing {
                    if packet.len() + n as usize > TAG_BYTES as usize {
                        return Err(invalid());
                    }
                    packet.extend_from_slice(&page[p..p + n as usize]);
                    p += n as usize;
                    if n < 255 {
                        if packet.starts_with(b"OpusTags") {
                            validate_comments(&packet[8..])?;
                        }
                        if packet.starts_with(b"\x03vorbis") {
                            validate_comments(&packet[7..])?;
                        }
                        packet.clear();
                        packets += 1;
                    }
                }
                at += 27 + u64::from(header[26]) + size;
            }
        } else if h.first().is_none_or(|b| *b != 0xff) && offset == 0 {
            return Err(invalid());
        }
        // Properties probes inspect the first/last frames. These windows also
        // pin ID3v1 and APE footer headers against concurrent rewrites.
        input.freeze(offset, (len - offset).min(16 * 1024))?;
        input.freeze(len.saturating_sub(16 * 1024), len.min(16 * 1024))?;
        let mut ends = vec![len];
        if len >= 128 && input.freeze(len - 128, 3)? == b"TAG" {
            ends.push(len - 128);
        }
        for end in ends {
            if end < 32 {
                continue;
            }
            let tail = input.freeze(end - 32, 32)?;
            if tail.starts_with(b"APETAGEX") {
                let size = u64::from(le32(&tail[12..])?);
                if !(32..=TAG_BYTES).contains(&size) || le32(&tail[16..])? as usize > MAX_ITEMS {
                    return Err(invalid());
                }
                input.freeze(end.checked_sub(size).ok_or_else(invalid)?, size)?;
            }
        }
        input.remaining = READ_BYTES;
        Ok(input)
    }
    // Chapter titles are consumed only by our checked reader. They never go
    // back through a third-party parser, so retain decoded titles rather than
    // two snapshot entries per chapter. Container headers remain frozen.
    fn chapter_bytes(&mut self, start: u64, len: u64) -> io::Result<Vec<u8>> {
        if start > self.len || len > self.len - start || len > TAG_BYTES {
            return Err(invalid());
        }
        let mut bytes = vec![0; len as usize];
        self.file.seek(StdSeekFrom::Start(start))?;
        self.file.read_exact(&mut bytes)?;
        Ok(bytes)
    }
    fn freeze(&mut self, start: u64, len: u64) -> io::Result<Vec<u8>> {
        if self.snapshots.len() >= 4096 {
            return Err(invalid());
        }
        if start > self.len
            || len > self.len - start
            || len > CONTAINER_BYTES
            || self.stored + len > CONTAINER_BYTES + 2 * TAG_BYTES
        {
            return Err(invalid());
        }
        let mut bytes = vec![0; len as usize];
        self.file.seek(StdSeekFrom::Start(start))?;
        self.file.read_exact(&mut bytes)?;
        for old in &self.snapshots {
            let a = start.max(old.start);
            let b = (start + len).min(old.start + old.bytes.len() as u64);
            if a < b
                && bytes[(a - start) as usize..(b - start) as usize]
                    != old.bytes[(a - old.start) as usize..(b - old.start) as usize]
            {
                return Err(invalid());
            }
        }
        self.stored += len;
        self.snapshots.push(Snapshot {
            start,
            bytes: Arc::new(bytes.clone()),
        });
        Ok(bytes)
    }
    pub(crate) fn take_chapter_track(&mut self) -> Vec<ParsedChapter> {
        std::mem::take(&mut self.chapter_track)
    }
    pub(crate) fn fork(&self, limit: u64) -> io::Result<Self> {
        Ok(Self {
            file: self.file.try_clone()?,
            len: self.len,
            pos: 0,
            remaining: limit,
            snapshots: self.snapshots.clone(),
            stored: self.stored,
            chapter_track: Vec::new(),
        })
    }
}
impl Read for MetadataInput {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() || self.pos >= self.len {
            return Ok(0);
        }
        if self.remaining == 0 {
            return Err(invalid());
        }
        let mut size = out
            .len()
            .min(self.remaining as usize)
            .min((self.len - self.pos) as usize);
        if let Some(part) = self
            .snapshots
            .iter()
            .find(|part| self.pos >= part.start && self.pos < part.start + part.bytes.len() as u64)
        {
            let offset = (self.pos - part.start) as usize;
            size = size.min(part.bytes.len() - offset);
            out[..size].copy_from_slice(&part.bytes[offset..offset + size]);
        } else {
            if let Some(next) = self
                .snapshots
                .iter()
                .filter(|part| part.start > self.pos)
                .map(|part| part.start)
                .min()
            {
                size = size.min((next - self.pos) as usize);
            }
            self.file.seek(StdSeekFrom::Start(self.pos))?;
            size = self.file.read(&mut out[..size])?;
        }
        self.pos += size as u64;
        self.remaining -= size as u64;
        Ok(size)
    }
}
impl Seek for MetadataInput {
    fn seek(&mut self, pos: StdSeekFrom) -> io::Result<u64> {
        self.pos = match pos {
            StdSeekFrom::Start(n) => n,
            StdSeekFrom::Current(n) => self.pos.checked_add_signed(n).ok_or_else(invalid)?,
            StdSeekFrom::End(n) => self.len.checked_add_signed(n).ok_or_else(invalid)?,
        };
        Ok(self.pos)
    }
}
fn validate_comments(bytes: &[u8]) -> io::Result<()> {
    let vendor = le32(bytes)? as usize;
    let mut p = 4usize.checked_add(vendor).ok_or_else(invalid)?;
    let count = le32(bytes.get(p..).ok_or_else(invalid)?)? as usize;
    p += 4;
    if count > MAX_ITEMS {
        return Err(invalid());
    }
    for _ in 0..count {
        let len = le32(bytes.get(p..).ok_or_else(invalid)?)? as usize;
        p += 4;
        p = p.checked_add(len).ok_or_else(invalid)?;
        if p > bytes.len() {
            return Err(invalid());
        }
    }
    Ok(())
}
fn deunsynchronise(bytes: &[u8]) -> Vec<u8> {
    bytes
        .iter()
        .enumerate()
        .filter_map(|(i, b)| (!(i > 0 && *b == 0 && bytes[i - 1] == 255)).then_some(*b))
        .collect()
}
fn validate_id3(bytes: &[u8]) -> io::Result<()> {
    if bytes.len() < 10 || !bytes.starts_with(b"ID3") || !(2..=4).contains(&bytes[3]) {
        return Err(invalid());
    }
    if bytes[3] == 2 && bytes[5] & 0x40 != 0 {
        return Err(invalid());
    }
    let mut payload = bytes[10..].to_vec();
    if bytes[3] < 4 && bytes[5] & 128 != 0 {
        let mut i = 0;
        payload.retain(|b| {
            let keep = !(i > 0 && *b == 0 && bytes.get(i + 9) == Some(&255));
            i += 1;
            keep
        });
    }
    let skip = if bytes[5] & 0x40 != 0 && bytes[3] >= 3 {
        let n = if bytes[3] == 4 {
            synchsafe(&payload)?
        } else {
            be32(&payload)?.checked_add(4).ok_or_else(invalid)?
        };
        n as usize
    } else {
        0
    };
    let mut count = 0;
    validate_frames(
        payload.get(skip..).ok_or_else(invalid)?,
        bytes[3],
        0,
        &mut count,
    )
}
fn validate_frames(
    mut bytes: &[u8],
    version: u8,
    depth: usize,
    count: &mut usize,
) -> io::Result<()> {
    if depth > 8 {
        return Err(invalid());
    }
    let header = if version == 2 { 6 } else { 10 };
    while bytes.len() >= header && bytes[0] != 0 {
        *count += 1;
        if *count > MAX_ITEMS {
            return Err(invalid());
        }
        let len = if version == 2 {
            (u32::from(bytes[3]) << 16) | (u32::from(bytes[4]) << 8) | u32::from(bytes[5])
        } else if version == 4 {
            synchsafe(&bytes[4..])?
        } else {
            be32(&bytes[4..])?
        } as usize;
        if version >= 3 && bytes[9] & (if version == 4 { 0x0c } else { 0xc0 }) != 0 {
            return Err(invalid());
        }
        let end = header + len;
        let body = bytes.get(header..end).ok_or_else(invalid)?;
        let unsynced;
        let body = if version == 4 && bytes[9] & 2 != 0 {
            unsynced = deunsynchronise(body);
            &unsynced[..]
        } else {
            body
        };
        if version >= 3 && &bytes[..4] == b"CHAP" {
            let start = body.iter().position(|b| *b == 0).ok_or_else(invalid)? + 17;
            validate_frames(
                body.get(start..).ok_or_else(invalid)?,
                version,
                depth + 1,
                count,
            )?;
        } else if version >= 3 && &bytes[..4] == b"CTOC" {
            let mut p = body.iter().position(|b| *b == 0).ok_or_else(invalid)? + 1;
            let children = *body.get(p + 1).ok_or_else(invalid)?;
            p += 2;
            for _ in 0..children {
                p += body
                    .get(p..)
                    .ok_or_else(invalid)?
                    .iter()
                    .position(|b| *b == 0)
                    .ok_or_else(invalid)?
                    + 1;
            }
            validate_frames(
                body.get(p..).ok_or_else(invalid)?,
                version,
                depth + 1,
                count,
            )?;
        }
        bytes = &bytes[end..];
    }
    Ok(())
}
fn atom_size(bytes: &[u8], remaining: u64) -> io::Result<(u64, usize)> {
    if bytes.len() < 8 {
        return Err(invalid());
    }
    let small = be32(bytes)?;
    let (size, header) = if small == 1 {
        (
            u64::from_be_bytes(bytes.get(8..16).ok_or_else(invalid)?.try_into().unwrap()),
            16,
        )
    } else if small == 0 {
        (remaining, 8)
    } else {
        (u64::from(small), 8)
    };
    if size < header as u64 || size > remaining {
        return Err(invalid());
    }
    Ok((size, header))
}
#[derive(Default)]
struct Track {
    id: u32,
    samples: u64,
    timed_samples: u64,
    samples_per_chunk: u64,
    timescale: u32,
    chapter_ids: Vec<u32>,
    tables: HashMap<[u8; 4], Vec<u8>>,
}
#[derive(Default)]
struct AtomBudget {
    count: usize,
    tag_bytes: usize,
}
fn validate_atoms(
    mut bytes: &[u8],
    depth: usize,
    tracks: &mut Vec<Track>,
    chapters: &mut Vec<u32>,
    track: Option<usize>,
    items: bool,
    count: &mut AtomBudget,
) -> io::Result<()> {
    if depth > 32 {
        return Err(invalid());
    }
    while !bytes.is_empty() {
        count.count += 1;
        if count.count > MAX_ITEMS {
            return Err(invalid());
        }
        let (size, header) = atom_size(bytes, bytes.len() as u64)?;
        let kind = bytes.get(4..8).ok_or_else(invalid)?;
        let data = &bytes[header..size as usize];
        if kind == b"cmov" {
            return Err(invalid());
        }
        if kind == b"ilst" {
            count.tag_bytes += data.len();
            if count.tag_bytes as u64 > TAG_BYTES {
                return Err(invalid());
            }
        }
        if kind == b"trak" {
            if tracks.len() >= MAX_ITEMS {
                return Err(invalid());
            }
            let id = tracks.len();
            tracks.push(Track::default());
            validate_atoms(data, depth + 1, tracks, chapters, Some(id), false, count)?;
        } else if items
            || matches!(
                kind,
                b"moov" | b"mdia" | b"minf" | b"stbl" | b"udta" | b"tref" | b"meta" | b"ilst"
            )
        {
            let data = if kind == b"meta" {
                data.get(4..).ok_or_else(invalid)?
            } else {
                data
            };
            validate_atoms(
                data,
                depth + 1,
                tracks,
                chapters,
                track,
                kind == b"ilst",
                count,
            )?;
        } else if kind == b"chap" {
            if !data.len().is_multiple_of(4) || chapters.len() + data.len() / 4 > MAX_ITEMS {
                return Err(invalid());
            }
            for id in data.as_chunks::<4>().0 {
                chapters.push(be32(id)?);
            }
            if let Some(i) = track {
                if tracks[i].tables.insert(*b"chap", data.to_vec()).is_some() {
                    return Err(invalid());
                }
                tracks[i].chapter_ids.extend(
                    data.as_chunks::<4>()
                        .0
                        .iter()
                        .map(|id| u32::from_be_bytes(*id)),
                );
            }
        } else if let Some(i) = track {
            if matches!(
                kind,
                b"tkhd" | b"mdhd" | b"stsz" | b"stco" | b"co64" | b"stsc" | b"stts"
            ) {
                let key: [u8; 4] = kind.try_into().unwrap();
                if tracks[i].tables.insert(key, data.to_vec()).is_some() {
                    return Err(invalid());
                }
            }
            if kind == b"mdhd" {
                tracks[i].timescale = be32(
                    data.get(if data.first() == Some(&1) { 20.. } else { 12.. })
                        .ok_or_else(invalid)?,
                )?;
            } else if kind == b"tkhd" {
                tracks[i].id = be32(
                    data.get(if data.first() == Some(&1) { 20.. } else { 12.. })
                        .ok_or_else(invalid)?,
                )?;
            } else if kind == b"stsz" {
                let uniform = be32(data.get(4..).ok_or_else(invalid)?)?;
                let n = u64::from(be32(data.get(8..).ok_or_else(invalid)?)?);
                if uniform == 0 && n * 4 + 12 > data.len() as u64 {
                    return Err(invalid());
                }
                tracks[i].samples = n;
            } else if matches!(
                kind,
                b"stco" | b"co64" | b"stsc" | b"stts" | b"ctts" | b"stss"
            ) {
                let n = u64::from(be32(data.get(4..).ok_or_else(invalid)?)?);
                let width = match kind {
                    b"co64" | b"stts" | b"ctts" => 8,
                    b"stsc" => 12,
                    _ => 4,
                };
                if n * width + 8 > data.len() as u64 {
                    return Err(invalid());
                }
                if kind == b"stts" {
                    for entry in data[8..].as_chunks::<8>().0.iter().take(n as usize) {
                        tracks[i].timed_samples += u64::from(be32(entry)?);
                    }
                }
                if kind == b"stsc" {
                    for entry in data[8..].as_chunks::<12>().0.iter().take(n as usize) {
                        if be32(entry)? == 0 {
                            return Err(invalid());
                        }
                        tracks[i].samples_per_chunk = tracks[i]
                            .samples_per_chunk
                            .max(u64::from(be32(&entry[4..])?));
                    }
                }
            }
        }
        bytes = &bytes[size as usize..];
    }
    Ok(())
}

pub(crate) fn read_bounded_tags(input: &MetadataInput) -> anyhow::Result<lofty::file::TaggedFile> {
    // Lofty's options are thread-local and its allocation cap is per item.
    // The frozen aggregate preflight is the primary bound.
    lofty::config::apply_global_options(
        lofty::config::GlobalOptions::new()
            .allocation_limit(TAG_BYTES as usize)
            .preserve_format_specific_items(false),
    );
    Ok(lofty::probe::Probe::new(input.fork(READ_BYTES)?)
        .guess_file_type()?
        .read()?)
}

pub(crate) struct MetadataCounter {
    pub(crate) bytes: u64,
    pub(crate) remaining: u64,
}
impl Write for MetadataCounter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() as u64 > self.remaining {
            return Err(invalid());
        }
        self.remaining -= bytes.len() as u64;
        self.bytes += bytes.len() as u64;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(bytes: &[u8]) -> io::Result<MetadataInput> {
        let mut file = tempfile::tempfile()?;
        file.write_all(bytes)?;
        MetadataInput::new(file)
    }
    fn atom(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = ((data.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        out
    }
    #[test]
    fn metadata_rejects_declared_allocation_bombs_and_compressed_id3() {
        assert!(input(b"ID3\x04\0\0\x7f\x7f\x7f\x7f").is_err());
        let mut id3 = b"ID3\x03\0\0\0\0\0\x0eTIT2\0\0\0\x04\0\x80\x7f\xff\xff\xff".to_vec();
        id3.extend_from_slice(&[0xff, 0xfb, 0x90, 0]);
        assert!(input(&id3).is_err());
        let mut mp4 = atom(b"ftyp", b"M4B \0\0\0\0M4B ");
        let mut sizes = vec![0u8; 12];
        sizes[8..].copy_from_slice(&u32::MAX.to_be_bytes());
        let moov = atom(
            b"moov",
            &atom(
                b"trak",
                &atom(
                    b"mdia",
                    &atom(b"minf", &atom(b"stbl", &atom(b"stsz", &sizes))),
                ),
            ),
        );
        mp4.extend(moov);
        assert!(input(&mp4).is_err());
        assert!(input(&[&atom(b"ftyp", b"M4B ")[..], &[0, 0, 0, 8][..]].concat()).is_err());
    }
    #[test]
    fn metadata_skips_large_audio_and_pins_checked_headers() {
        let mut file = tempfile::tempfile().unwrap();
        let data_size = 2_000_000_000u32;
        file.write_all(b"RIFF").unwrap();
        file.write_all(&(data_size + 36).to_le_bytes()).unwrap();
        file.write_all(b"WAVEfmt ").unwrap();
        file.write_all(&16u32.to_le_bytes()).unwrap();
        file.write_all(&[1, 0, 1, 0, 0x44, 0xac, 0, 0, 0x88, 0x58, 1, 0, 2, 0, 16, 0])
            .unwrap();
        file.write_all(b"data").unwrap();
        file.write_all(&data_size.to_le_bytes()).unwrap();
        file.set_len(u64::from(data_size) + 44).unwrap();
        let mut writer = file.try_clone().unwrap();
        let checked = MetadataInput::new(file).unwrap();
        writer.seek(StdSeekFrom::Start(0)).unwrap();
        writer.write_all(b"EVIL").unwrap();
        let mut reader = checked.fork(READ_BYTES).unwrap();
        let mut header = [0u8; 4];
        reader.read_exact(&mut header).unwrap();
        assert_eq!(&header, b"RIFF");
        let tag = read_bounded_tags(&checked).unwrap();
        assert!(tag.properties().duration().as_secs() > 20_000);
    }
    #[test]
    fn metadata_aggregate_budget_rejects_before_write() {
        let mut count = MetadataCounter {
            bytes: 0,
            remaining: 12,
        };
        count.write_all(b"1234567").unwrap();
        assert!(count.write_all(b"123456").is_err());
        assert_eq!(count.bytes, 7);
    }
    #[test]
    fn metadata_normalizes_embedded_raster_and_omits_invalid_art() {
        use lofty::picture::{MimeType, Picture};
        let mut encoded = io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(12, 13)
            .write_to(&mut encoded, image::ImageFormat::Jpeg)
            .unwrap();
        let mut tag = Tag::new(lofty::tag::TagType::Id3v2);
        tag.push_picture(
            Picture::unchecked(encoded.into_inner())
                .pic_type(PictureType::CoverFront)
                .mime_type(MimeType::Jpeg)
                .build(),
        );
        let cover = extract_cover_art(&tag).unwrap();
        assert_eq!(cover.mime_type, "image/png");
        assert_eq!(image::load_from_memory(&cover.data).unwrap().width(), 12);
        let mut invalid = Tag::new(lofty::tag::TagType::Id3v2);
        invalid.push_picture(
            Picture::unchecked(b"not pixels".to_vec())
                .pic_type(PictureType::CoverFront)
                .build(),
        );
        assert!(extract_cover_art(&invalid).is_none());
    }
}

// mp4ameta reserves from sample-table counts and subtracts a UTF-16 BOM
// from an untrusted title length before reading. Decode only the checked
// chapter tables here; the library remains responsible for legacy chpl lists.
fn read_track_chapters(input: &mut MetadataInput, track: &Track) -> io::Result<Vec<ParsedChapter>> {
    if track.timescale == 0
        || track.samples > MAX_ITEMS as u64
        || track.timed_samples > MAX_ITEMS as u64
        || track.samples_per_chunk > MAX_ITEMS as u64
    {
        return Err(invalid());
    }
    let table = |key: &[u8; 4]| track.tables.get(key).map(Vec::as_slice).ok_or_else(invalid);
    let sizes = table(b"stsz")?;
    let uniform = be32(&sizes[4..])?;
    let stsc = table(b"stsc")?;
    let stts = table(b"stts")?;
    let chunks = track
        .tables
        .get(b"co64")
        .or_else(|| track.tables.get(b"stco"))
        .ok_or_else(invalid)?;
    let wide = track.tables.contains_key(b"co64");
    let chunk_count = be32(&chunks[4..])? as usize;
    if chunk_count > MAX_ITEMS {
        return Err(invalid());
    }
    let runs = stsc[8..].as_chunks::<12>().0;
    if runs.is_empty() || be32(&runs[0])? != 1 {
        return Err(invalid());
    }
    let mut previous = 0;
    for run in runs {
        let first = be32(run)?;
        if first <= previous || first as usize > chunk_count {
            return Err(invalid());
        }
        previous = first;
    }
    let mut durations = stts[8..].as_chunks::<8>().0.iter().flat_map(|row| {
        std::iter::repeat_n(
            u32::from_be_bytes(row[4..8].try_into().unwrap()),
            u32::from_be_bytes(row[..4].try_into().unwrap()) as usize,
        )
    });
    let mut run = 0;
    let mut sample = 0;
    let mut ticks = 0u64;
    let mut retained = 0u64;
    let mut chapters = Vec::new();
    for index in 0..chunk_count {
        while run + 1 < runs.len() && be32(&runs[run + 1])? as usize <= index + 1 {
            run += 1;
        }
        let width = if wide { 8 } else { 4 };
        let at = 8 + index * width;
        let mut offset = if wide {
            u64::from_be_bytes(chunks[at..at + 8].try_into().unwrap())
        } else {
            u64::from(be32(&chunks[at..])?)
        };
        for _ in 0..be32(&runs[run][4..])? {
            if sample >= MAX_ITEMS || sample as u64 >= track.samples {
                return Err(invalid());
            }
            let size = if uniform != 0 {
                uniform
            } else {
                be32(sizes.get(12 + sample * 4..).ok_or_else(invalid)?)?
            };
            let header = input.chapter_bytes(offset, 2)?;
            let len = u16::from_be_bytes(header[..2].try_into().unwrap()) as u64;
            if len + 2 > u64::from(size) || retained + len > TAG_BYTES {
                return Err(invalid());
            }
            let text = input.chapter_bytes(offset.checked_add(2).ok_or_else(invalid)?, len)?;
            retained += len;
            let bom = text
                .get(..2)
                .map(|bytes| u16::from_be_bytes(bytes.try_into().unwrap()))
                .unwrap_or(0);
            let title = if matches!(bom, 0xfeff | 0xfffe) {
                if len < 2 || !len.is_multiple_of(2) {
                    return Err(invalid());
                }
                let units = text[2..].as_chunks::<2>().0.iter().map(|b| {
                    if bom == 0xfeff {
                        u16::from_be_bytes(*b)
                    } else {
                        u16::from_le_bytes(*b)
                    }
                });
                char::decode_utf16(units)
                    .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
                    .collect()
            } else {
                String::from_utf8(text).map_err(|_| invalid())?
            };
            chapters.push(ParsedChapter {
                title,
                start_seconds: ticks as f64 / f64::from(track.timescale),
                end_seconds: None,
                source: "mp4-chapter-track".into(),
            });
            ticks = ticks
                .checked_add(u64::from(durations.next().ok_or_else(invalid)?))
                .ok_or_else(invalid)?;
            offset = offset.checked_add(u64::from(size)).ok_or_else(invalid)?;
            sample += 1;
        }
    }
    for i in 0..chapters.len().saturating_sub(1) {
        chapters[i].end_seconds = Some(chapters[i + 1].start_seconds);
    }
    Ok(chapters)
}

#[cfg(test)]
mod chapter_tests {
    use super::*;
    fn atom(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = ((data.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend(kind);
        out.extend(data);
        out
    }
    fn numbers(values: &[u32]) -> Vec<u8> {
        values.iter().flat_map(|v| v.to_be_bytes()).collect()
    }
    fn moov(offset: u32, size: u32, count: u32) -> Vec<u8> {
        let audio = atom(
            b"trak",
            &[
                atom(b"tkhd", &numbers(&[0, 0, 0, 1])),
                atom(b"tref", &atom(b"chap", &numbers(&[2]))),
            ]
            .concat(),
        );
        let tables = [
            atom(b"stsz", &numbers(&[0, size, count])),
            atom(b"stsc", &numbers(&[0, 1, 1, count, 1])),
            atom(b"stts", &numbers(&[0, 1, count, 1000])),
            atom(b"stco", &numbers(&[0, 1, offset])),
        ]
        .concat();
        let chapter = atom(
            b"trak",
            &[
                atom(b"tkhd", &numbers(&[0, 0, 0, 2])),
                atom(
                    b"mdia",
                    &[
                        atom(b"mdhd", &numbers(&[0, 0, 0, 1000])),
                        atom(b"minf", &atom(b"stbl", &tables)),
                    ]
                    .concat(),
                ),
            ]
            .concat(),
        );
        atom(b"moov", &[audio, chapter].concat())
    }
    fn parse(payload: &[u8], size: u32) -> io::Result<MetadataInput> {
        let ftyp = atom(b"ftyp", b"M4B ");
        let count = payload.len() as u32 / size;
        let headers = moov(0, size, count);
        let offset = (ftyp.len() + headers.len() + 8) as u32;
        let mut file = tempfile::tempfile()?;
        file.write_all(&[ftyp, moov(offset, size, count), atom(b"mdat", payload)].concat())?;
        MetadataInput::new(file)
    }
    #[test]
    fn metadata_chapter_tracks_keep_titles_timing_and_order() {
        let mut input = parse(b"\0\x03One\0\x03Two", 5).unwrap();
        let chapters = input.take_chapter_track();
        assert_eq!(chapters.len(), 2);
        assert_eq!(chapters[0].title, "One");
        assert_eq!(chapters[1].title, "Two");
        assert_eq!(chapters[0].end_seconds, Some(1.0));
        assert_eq!(chapters[1].start_seconds, 1.0);
    }
    #[test]
    fn metadata_chapter_tracks_accept_the_documented_count_without_snapshot_growth() {
        let mut input = parse(&b"\0\x03One".repeat(MAX_ITEMS), 5).unwrap();
        assert!(input.snapshots.len() < 32);
        let chapters = input.take_chapter_track();
        assert_eq!(chapters.len(), MAX_ITEMS);
        assert_eq!(
            chapters.last().unwrap().start_seconds,
            (MAX_ITEMS - 1) as f64
        );
        assert_eq!(chapters.last().unwrap().title, "One");
        assert!(parse(&b"\0\x03One".repeat(MAX_ITEMS + 1), 5).is_err());
    }
    #[test]
    fn metadata_chapter_tracks_reject_short_utf16_lengths_before_allocation() {
        assert!(parse(&[0, 1, 0xfe, 0xff, 0, 1, 0xfe, 0xff], 4).is_err());
    }
}

#[cfg(test)]
mod footer_tests {
    use super::*;
    #[test]
    fn metadata_ape_limit_also_applies_before_id3v1() {
        let mut bytes = vec![0xff, 0xfb, 0x90, 0];
        bytes.resize(64, 0);
        let mut footer = b"APETAGEX".to_vec();
        footer.extend(2000u32.to_le_bytes());
        footer.extend(u32::MAX.to_le_bytes());
        footer.extend(1u32.to_le_bytes());
        footer.resize(32, 0);
        bytes.extend(footer);
        let mut v1 = b"TAG".to_vec();
        v1.resize(128, 0);
        bytes.extend(v1);
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(&bytes).unwrap();
        assert!(MetadataInput::new(file).is_err());
    }
}

#[cfg(test)]
mod format_compatibility_tests {
    use super::*;

    #[test]
    fn bounded_metadata_preserves_supported_format_tags_and_durations() {
        let Some(tools) = faststart::discover_tools(None, None) else {
            eprintln!("skipping: ffmpeg is not installed");
            return;
        };
        let root = tempfile::tempdir().unwrap();
        for (extension, codec) in [
            ("mp3", "libmp3lame"),
            ("m4a", "aac"),
            ("m4b", "aac"),
            ("mp4", "aac"),
            ("aac", "aac"),
            ("flac", "flac"),
            ("ogg", "vorbis"),
            ("opus", "opus"),
            ("wav", "pcm_s16le"),
            ("aiff", "pcm_s16be"),
        ] {
            let path = root.path().join(format!("book.{extension}"));
            let generated = std::process::Command::new(&tools.ffmpeg)
                .args([
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:duration=1",
                    "-ac",
                    "2",
                    "-strict",
                    "experimental",
                    "-c:a",
                    codec,
                    "-metadata",
                    "title=A small tagged book",
                    "-metadata",
                    "artist=Known Author",
                ])
                .arg(&path)
                .output()
                .unwrap();
            assert!(
                generated.status.success(),
                "{extension}: {}",
                String::from_utf8_lossy(&generated.stderr)
            );
            let baseline = lofty::read_from_path(&path).unwrap();
            let tag = baseline.primary_tag().or_else(|| baseline.first_tag());
            let expected_title = tag.and_then(|tag| tag.title().map(|title| title.into_owned()));
            let expected_author =
                tag.and_then(|tag| tag.artist().map(|artist| artist.into_owned()));
            let metadata = read_track_metadata(&path);
            assert_eq!(metadata.title, expected_title, "{extension} title");
            assert_eq!(metadata.author, expected_author, "{extension} author");
            assert_eq!(
                metadata.duration_seconds,
                Some(baseline.properties().duration().as_secs_f64())
                    .filter(|duration| *duration > 0.0),
                "{extension} duration"
            );
        }
    }
}
