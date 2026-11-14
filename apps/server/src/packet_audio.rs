//! Native streaming view with a constant-size AAC packet table. Padding is
//! generated for bounded reads, never written to the library. All timing and
//! decoder metadata stays byte-for-byte intact.
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

pub(crate) struct PacketAudio {
    pub header: Vec<u8>,
    pub length: u64,
    sizes: Vec<u16>,
    anchors: Vec<(usize, u64)>,
    width: usize,
}

fn u32_at(b: &[u8], p: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        b.get(p..p.checked_add(4)?)?.try_into().ok()?,
    ))
}
fn atoms(mut b: &[u8]) -> Option<Vec<(&[u8], &[u8])>> {
    let mut result = Vec::new();
    while !b.is_empty() {
        let n = u32_at(b, 0)? as usize;
        if n < 8 {
            return None;
        }
        let atom = b.get(..n)?;
        result.push((atom.get(4..8)?, atom));
        b = b.get(n..)?;
        if result.len() > 4096 {
            return None;
        }
    }
    Some(result)
}
fn child<'a>(b: &'a [u8], kind: &[u8]) -> Option<&'a [u8]> {
    let matches: Vec<_> = atoms(b.get(8..)?)?
        .into_iter()
        .filter(|(k, _)| *k == kind)
        .collect();
    if matches.len() != 1 {
        return None;
    }
    Some(matches[0].1)
}
fn atom(kind: &[u8], body: &[u8]) -> Option<Vec<u8>> {
    let mut b = u32::try_from(body.len().checked_add(8)?)
        .ok()?
        .to_be_bytes()
        .to_vec();
    b.extend_from_slice(kind);
    b.extend_from_slice(body);
    Some(b)
}
impl PacketAudio {
    pub fn open(file: &mut File) -> Option<Self> {
        let length = file.metadata().ok()?.len();
        let mut prefix = Vec::new();
        let mut moov = None;
        let mut media = None;
        let mut offset = 0u64;
        for _ in 0..4096 {
            if offset == length {
                break;
            }
            file.seek(SeekFrom::Start(offset)).ok()?;
            let mut h = [0u8; 16];
            file.read_exact(&mut h[..8]).ok()?;
            let short = u32_at(&h, 0)?;
            let hs = if short == 1 { 16 } else { 8 };
            let size = if short == 1 {
                file.read_exact(&mut h[8..]).ok()?;
                u64::from_be_bytes(h[8..].try_into().ok()?)
            } else if short == 0 {
                length.checked_sub(offset)?
            } else {
                u64::from(short)
            };
            let end = offset.checked_add(size)?;
            if size < hs || end > length {
                return None;
            }
            match &h[4..8] {
                b"ftyp" if offset == 0 && size <= 1024 => {
                    prefix.resize(size as usize, 0);
                    file.seek(SeekFrom::Start(0)).ok()?;
                    file.read_exact(&mut prefix).ok()?;
                }
                b"moov"
                    if moov.is_none() && media.is_none() && hs == 8 && size <= 32 * 1024 * 1024 =>
                {
                    let mut b = vec![0; size as usize];
                    file.seek(SeekFrom::Start(offset)).ok()?;
                    file.read_exact(&mut b).ok()?;
                    moov = Some(b);
                }
                b"mdat" if media.is_none() => {
                    media = Some((offset + hs, end));
                }
                b"free" | b"skip" => {}
                _ => return None,
            }
            offset = end;
        }
        if offset != length || prefix.is_empty() {
            return None;
        }
        let moov = moov?;
        let media = media?;
        let tracks: Vec<_> = atoms(&moov[8..])?
            .into_iter()
            .filter(|(k, _)| *k == b"trak")
            .map(|(_, a)| a)
            .collect();
        let audio: Vec<_> = tracks
            .into_iter()
            .filter(|t| {
                child(t, b"mdia")
                    .and_then(|m| child(m, b"hdlr"))
                    .and_then(|h| h.get(16..20))
                    == Some(b"soun")
            })
            .collect();
        if audio.len() != 1 {
            return None;
        }
        let track = audio[0];
        let mdia = child(track, b"mdia")?;
        let minf = child(mdia, b"minf")?;
        let stbl = child(minf, b"stbl")?;
        let references = child(child(minf, b"dinf")?, b"dref")?;
        if u32_at(references, 12)? != 1 {
            return None;
        }
        let references = atoms(references.get(16..)?)?;
        if references.len() != 1
            || references[0].0 != b"url "
            || references[0].1.get(8..)? != [0, 0, 0, 1]
        {
            return None;
        }
        let description = child(stbl, b"stsd")?;
        // Single unencrypted MPEG-4 AAC description; no ALAC, HE-AAC or
        // external data references. Other formats keep the ordinary stream.
        if u32_at(description, 12)? != 1
            || description.get(20..24)? != b"mp4a"
            || description.get(30..32)? != [0, 1]
        {
            return None;
        }
        let sample_entry = description.get(16..)?;
        if sample_entry.get(16..18)? != [0, 0] {
            return None;
        }
        let esds = atoms(sample_entry.get(36..)?)?
            .into_iter()
            .find(|(k, _)| *k == b"esds")?
            .1;
        // AAC-LC AudioSpecificConfig (object type 2). Descriptor lengths are
        // variable; parse them rather than searching arbitrary codec bytes.
        if u32_at(esds, 8)? != 0 || !aac_lc(esds.get(12..)?) {
            return None;
        }
        let sizes_box = child(stbl, b"stsz")?;
        if u32_at(sizes_box, 8)? != 0 || u32_at(sizes_box, 12)? != 0 {
            return None;
        }
        let count = u32_at(sizes_box, 16)? as usize;
        if count == 0 || sizes_box.len() != 20usize.checked_add(count.checked_mul(4)?)? {
            return None;
        }
        let sizes: Vec<u16> = (0..count)
            .map(|i| {
                u16::try_from(u32_at(sizes_box, 20 + i * 4)?)
                    .ok()
                    .filter(|n| *n > 0)
            })
            .collect::<Option<_>>()?;
        let width = usize::from(*sizes.iter().max()?);
        let table = child(stbl, b"stsc")?;
        if u32_at(table, 8)? != 0 {
            return None;
        }
        let entries = u32_at(table, 12)? as usize;
        if entries == 0
            || table.len() != 16usize.checked_add(entries.checked_mul(12)?)?
            || u32_at(table, 16)? != 1
        {
            return None;
        }
        let chunks = child(stbl, b"stco").or_else(|| child(stbl, b"co64"))?;
        let cw = if chunks.get(4..8)? == b"stco" { 4 } else { 8 };
        if u32_at(chunks, 8)? != 0 {
            return None;
        }
        let chunk_count = u32_at(chunks, 12)? as usize;
        if chunks.len() != 16usize.checked_add(chunk_count.checked_mul(cw)?)? {
            return None;
        }
        for i in 0..entries {
            let first = u32_at(table, 16 + i * 12)? as usize;
            if first == 0
                || first > chunk_count
                || (i > 0 && first <= u32_at(table, 16 + (i - 1) * 12)? as usize)
                || u32_at(table, 24 + i * 12)? != 1
            {
                return None;
            }
        }
        let mut anchors = Vec::new();
        let mut sample = 0usize;
        let mut entry = 0usize;
        let mut previous_end = media.0;
        for c in 0..chunk_count {
            while entry + 1 < entries && u32_at(table, 16 + (entry + 1) * 12)? as usize <= c + 1 {
                entry += 1;
            }
            let n = u32_at(table, 20 + entry * 12)? as usize;
            if n == 0 || sample.checked_add(n)? > count {
                return None;
            }
            let p = 16 + c * cw;
            let mut position = if cw == 4 {
                u64::from(u32_at(chunks, p)?)
            } else {
                u64::from_be_bytes(chunks.get(p..p + 8)?.try_into().ok()?)
            };
            if position < previous_end {
                return None;
            }
            for j in 0..n {
                if j == 0 || sample.is_multiple_of(256) {
                    if anchors.len() >= 2_000_000 {
                        return None;
                    }
                    anchors.push((sample, position));
                }
                position = position.checked_add(u64::from(sizes[sample]))?;
                sample += 1;
            }
            if position > media.1 {
                return None;
            }
            previous_end = position;
        }
        if sample != count {
            return None;
        }
        let tables = [
            atom(
                b"stsz",
                &[
                    &[0u8; 4][..],
                    &(width as u32).to_be_bytes(),
                    &(count as u32).to_be_bytes(),
                ]
                .concat(),
            )?,
            atom(
                b"stsc",
                &[
                    &[0u8; 4][..],
                    &1u32.to_be_bytes(),
                    &1u32.to_be_bytes(),
                    &(count as u32).to_be_bytes(),
                    &1u32.to_be_bytes(),
                ]
                .concat(),
            )?,
            atom(
                b"co64",
                &[&[0u8; 4][..], &1u32.to_be_bytes(), &0u64.to_be_bytes()].concat(),
            )?,
        ];
        let rewritten = rewrite(&moov, &tables, track.as_ptr(), 0)?;
        prefix.extend_from_slice(&rewritten);
        let payload = (count as u64).checked_mul(width as u64)?;
        let mdat_length = payload.checked_add(16)?;
        prefix.extend_from_slice(&1u32.to_be_bytes());
        prefix.extend_from_slice(b"mdat");
        prefix.extend_from_slice(&mdat_length.to_be_bytes());
        let start = prefix.len() as u64;
        // Find co64 structurally in the one retained audio track.
        let needle = &tables[2];
        let indices: Vec<_> = prefix
            .windows(needle.len())
            .enumerate()
            .filter(|(_, b)| *b == needle)
            .map(|(i, _)| i)
            .collect();
        if indices.len() != 1 || prefix.len() > 65536 {
            return None;
        }
        let p = indices[0] + 16;
        prefix[p..p + 8].copy_from_slice(&start.to_be_bytes());
        Some(Self {
            header: prefix,
            length: start.checked_add(payload)?,
            sizes,
            anchors,
            width,
        })
    }
    pub fn read(&self, file: &mut File, offset: u64, count: usize) -> std::io::Result<Vec<u8>> {
        use std::io::{Error, ErrorKind};
        let invalid = || Error::new(ErrorKind::InvalidInput, "Invalid packet audio range");
        if count > 65536
            || offset
                .checked_add(count as u64)
                .is_none_or(|end| end > self.length)
        {
            return Err(invalid());
        }
        let mut output = vec![0; count];
        let mut written = 0;
        let mut cursor = offset;
        if cursor < self.header.len() as u64 {
            let n = count.min(self.header.len() - cursor as usize);
            output[..n].copy_from_slice(&self.header[cursor as usize..cursor as usize + n]);
            cursor += n as u64;
            written += n;
        }
        while written < count {
            let relative = cursor - self.header.len() as u64;
            let sample = (relative / self.width as u64) as usize;
            let within = (relative % self.width as u64) as usize;
            let n = (count - written).min(self.width - within);
            let size = usize::from(*self.sizes.get(sample).ok_or_else(invalid)?);
            if within < size {
                let (base, position) =
                    self.anchors[self.anchors.partition_point(|(s, _)| *s <= sample) - 1];
                let position = position
                    + self.sizes[base..sample]
                        .iter()
                        .map(|n| u64::from(*n))
                        .sum::<u64>()
                    + within as u64;
                let actual = n.min(size - within);
                file.seek(SeekFrom::Start(position))?;
                file.read_exact(&mut output[written..written + actual])?;
            }
            written += n;
            cursor += n as u64;
        }
        Ok(output)
    }
}
fn descriptor(b: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let tag = *b.first()?;
    let mut n = 0usize;
    let mut p = 1;
    for _ in 0..4 {
        let v = *b.get(p)?;
        p += 1;
        n = n.checked_mul(128)?.checked_add(usize::from(v & 127))?;
        if v & 128 == 0 {
            return Some((tag, b.get(p..p.checked_add(n)?)?, b.get(p + n..)?));
        }
    }
    None
}
fn aac_lc(b: &[u8]) -> bool {
    (|| -> Option<bool> {
        let (tag, es, _) = descriptor(b)?;
        if tag != 3 || *es.get(2)? != 0 {
            return None;
        }
        let (tag, decoder, _) = descriptor(es.get(3..)?)?;
        if tag != 4 || *decoder.first()? != 0x40 {
            return None;
        }
        let (tag, config, _) = descriptor(decoder.get(13..)?)?;
        Some(tag == 5 && config.len() >= 2 && config[0] >> 3 == 2)
    })() == Some(true)
}
fn rewrite(b: &[u8], tables: &[Vec<u8>; 3], track: *const u8, depth: usize) -> Option<Vec<u8>> {
    if depth > 8 {
        return None;
    }
    let kind = b.get(4..8)?;
    let containers = [
        &b"moov"[..],
        b"trak",
        b"mdia",
        b"minf",
        b"stbl",
        b"udta",
        b"meta",
        b"ilst",
    ];
    if !containers.contains(&kind) {
        return Some(b.to_vec());
    }
    let start = if kind == b"meta" { 12 } else { 8 };
    let mut body = b.get(8..start)?.to_vec();
    for (k, a) in atoms(b.get(start..)?)? {
        match k {
            b"trak" if a.as_ptr() != track => continue,
            b"tref" | b"covr" => continue,
            b"stsz" => body.extend_from_slice(&tables[0]),
            b"stsc" => body.extend_from_slice(&tables[1]),
            b"stco" | b"co64" => body.extend_from_slice(&tables[2]),
            b"mvex" | b"cmov" | b"saio" | b"sinf" | b"iloc" | b"uuid" | b"ctts" | b"stss"
            | b"stz2" => return None,
            _ => body.extend_from_slice(&rewrite(a, tables, track, depth + 1)?),
        }
    }
    atom(kind, &body)
}

type FileKey = (u64, u64, u64, i64, i64, i64, i64);
#[cfg(unix)]
fn file_key(metadata: &std::fs::Metadata) -> Option<FileKey> {
    use std::os::unix::fs::MetadataExt;
    Some((
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec(),
    ))
}
#[cfg(not(unix))]
fn file_key(_: &std::fs::Metadata) -> Option<FileKey> {
    None
}

pub(crate) struct CachedAudio {
    pub audio: PacketAudio,
    pub revision: String,
    key: FileKey,
}
impl CachedAudio {
    pub fn unchanged(&self, file: &File) -> bool {
        file.metadata().ok().and_then(|m| file_key(&m)) == Some(self.key)
    }
}
type CacheEntry = (FileKey, Option<std::sync::Arc<CachedAudio>>);
static CACHE: std::sync::Mutex<Vec<CacheEntry>> = std::sync::Mutex::new(Vec::new());
pub(crate) fn cached(file: &mut File) -> Option<std::sync::Arc<CachedAudio>> {
    use std::hash::{Hash, Hasher};
    let key = file_key(&file.metadata().ok()?)?;
    // Bound construction as well as retained memory. These indexes may contain
    // millions of packets, even when the header delivered to the phone is tiny.
    let mut cache = CACHE.lock().ok()?;
    if let Some(i) = cache.iter().position(|(k, _)| *k == key) {
        let entry = cache.remove(i);
        let result = entry.1.clone();
        cache.push(entry);
        return result;
    }
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    key.hash(&mut hash);
    let result = PacketAudio::open(file).map(|audio| {
        std::sync::Arc::new(CachedAudio {
            audio,
            revision: format!("{:016x}", hash.finish()),
            key,
        })
    });
    if file_key(&file.metadata().ok()?) != Some(key) {
        return None;
    }
    fn cost(value: &Option<std::sync::Arc<CachedAudio>>) -> usize {
        value.as_ref().map_or(0, |p| {
            p.audio.header.capacity()
                + p.audio.sizes.capacity() * 2
                + p.audio.anchors.capacity() * 16
        })
    }
    while !cache.is_empty()
        && (cache.len() >= 64
            || cache.iter().map(|(_, p)| cost(p)).sum::<usize>() + cost(&result) > 64 * 1024 * 1024)
    {
        cache.remove(0);
    }
    if cost(&result) <= 64 * 1024 * 1024 {
        cache.push((key, result.clone()));
    }
    result
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    fn make(k: &[u8], b: &[u8]) -> Vec<u8> {
        atom(k, b).unwrap()
    }
    pub fn fixture() -> Vec<u8> {
        let mut decoder = vec![0x40];
        decoder.extend_from_slice(&[0; 12]);
        decoder.extend_from_slice(&[5, 2, 0x12, 0x10]);
        let mut es = vec![0, 1, 0, 4, decoder.len() as u8];
        es.extend_from_slice(&decoder);
        let mut descriptors = vec![0; 4];
        descriptors.extend_from_slice(&[3, es.len() as u8]);
        descriptors.extend_from_slice(&es);
        let mut entry = vec![0; 28];
        entry[6..8].copy_from_slice(&1u16.to_be_bytes());
        entry.extend_from_slice(&make(b"esds", &descriptors));
        let mut sd = vec![0; 4];
        sd.extend_from_slice(&1u32.to_be_bytes());
        sd.extend_from_slice(&make(b"mp4a", &entry));
        let mut sizes = vec![0; 8];
        sizes.extend_from_slice(&4u32.to_be_bytes());
        for size in [2u32, 3, 4, 5] {
            sizes.extend_from_slice(&size.to_be_bytes());
        }
        let mut sc = vec![0; 4];
        for v in [1u32, 1, 2, 1] {
            sc.extend_from_slice(&v.to_be_bytes());
        }
        let mut offsets = vec![0; 4];
        offsets.extend_from_slice(&2u32.to_be_bytes());
        offsets.extend_from_slice(&[0; 8]);
        let timing = make(b"stts", &[0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 4, 0, 0, 4, 0]);
        let mut tables = make(b"stsd", &sd);
        tables.extend_from_slice(&make(b"stsz", &sizes));
        tables.extend_from_slice(&make(b"stsc", &sc));
        tables.extend_from_slice(&make(b"stco", &offsets));
        tables.extend_from_slice(&timing);
        let mut refs = vec![0; 4];
        refs.extend_from_slice(&1u32.to_be_bytes());
        refs.extend_from_slice(&make(b"url ", &[0, 0, 0, 1]));
        let mut minf = make(b"dinf", &make(b"dref", &refs));
        minf.extend_from_slice(&make(b"stbl", &tables));
        let mut handler = vec![0; 8];
        handler.extend_from_slice(b"soun");
        let mut mdia = make(b"hdlr", &handler);
        mdia.extend_from_slice(&make(b"minf", &minf));
        let mut moov = make(b"moov", &make(b"trak", &make(b"mdia", &mdia)));
        let mut ftyp = make(b"ftyp", b"M4A \0\0\0\0");
        let start = ftyp.len() + moov.len() + 8;
        let p = moov.windows(4).position(|b| b == b"stco").unwrap() + 12;
        moov[p..p + 4].copy_from_slice(&(start as u32).to_be_bytes());
        moov[p + 4..p + 8].copy_from_slice(&((start + 9) as u32).to_be_bytes());
        ftyp.extend_from_slice(&moov);
        ftyp.extend_from_slice(&make(b"mdat", b"abcde----fghijklmn"));
        ftyp
    }
    fn file(bytes: &[u8]) -> File {
        use std::io::Write;
        let mut f = tempfile::tempfile().unwrap();
        f.write_all(bytes).unwrap();
        f
    }
    #[test]
    fn packet_audio_reads_preserve_packets_timing_and_arbitrary_ranges() {
        let original = fixture();
        let mut f = file(&original);
        let p = PacketAudio::open(&mut f).unwrap();
        let expected = b"ab\0\0\0cde\0\0fghi\0jklmn";
        assert_eq!(p.read(&mut f, p.header.len() as u64, 20).unwrap(), expected);
        let timing = b"stts\0\0\0\0\0\0\0\x01\0\0\0\x04\0\0\x04\0";
        assert!(p.header.windows(timing.len()).any(|b| b == timing));
        let mut full = p.header.clone();
        full.extend_from_slice(expected);
        for start in 0..full.len() {
            for n in [0, 1, 7, 21] {
                let n = n.min(full.len() - start);
                assert_eq!(
                    p.read(&mut f, start as u64, n).unwrap(),
                    full[start..start + n]
                );
            }
        }
        assert!(p.read(&mut f, p.length, 1).is_err());
        assert!(p.read(&mut f, u64::MAX, 2).is_err());
        assert!(p.read(&mut f, 0, 65537).is_err());
    }
    #[test]
    fn packet_audio_rejects_incomplete_and_external_indexes() {
        let original = fixture();
        for end in 0..original.len() {
            assert!(PacketAudio::open(&mut file(&original[..end])).is_none());
        }
        for kind in [b"stsz", b"stsc", b"stco", b"esds", b"url "] {
            let mut b = original.clone();
            let i = b.windows(4).position(|b| b == kind).unwrap();
            b[i + 7] ^= 0xff;
            assert!(PacketAudio::open(&mut file(&b)).is_none(), "{:?}", kind);
        }
    }
    #[test]
    #[cfg(unix)]
    fn packet_audio_cache_pins_revisions_across_file_changes() {
        use std::io::Write;
        let mut f = file(&fixture());
        let a = cached(&mut f).unwrap();
        let b = cached(&mut f).unwrap();
        assert!(std::sync::Arc::ptr_eq(&a, &b));
        f.seek(SeekFrom::End(-1)).unwrap();
        f.write_all(b"X").unwrap();
        assert!(!a.unchanged(&f));
        let c = cached(&mut f).unwrap();
        assert_ne!(a.revision, c.revision);
        assert_eq!(c.audio.read(&mut f, c.audio.length - 1, 1).unwrap(), b"X");
    }
}
