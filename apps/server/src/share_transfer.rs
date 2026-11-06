//! Bounded staging and integrity checks for an experimental share transfer.
//! This module is not connected to a production route.

use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom, Write};

const MAX_CHUNK: usize = 64 * 1024;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResumeRequest {
    pub(crate) offset: u64,
    pub(crate) prefix_sha256: String,
}

pub(crate) fn verify_resume_request<F: Read + Seek>(
    file: &mut F,
    expected_size: u64,
    request: &ResumeRequest,
) -> anyhow::Result<u64> {
    let text = request.prefix_sha256.as_bytes();
    anyhow::ensure!(
        text.len() == 64
            && text
                .iter()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b)),
        "invalid prefix digest"
    );
    let mut digest = [0_u8; 32];
    for (i, item) in digest.iter_mut().enumerate() {
        *item = u8::from_str_radix(std::str::from_utf8(&text[i * 2..i * 2 + 2])?, 16)?;
    }
    verify_resume_prefix(file, request.offset, expected_size, digest)?;
    Ok(request.offset)
}

/// Validate a recipient's proposed resume point against the selected archive
/// before sending from that point. The handle remains positioned at offset.
pub(crate) fn verify_resume_prefix<F: Read + Seek>(
    file: &mut F,
    offset: u64,
    expected_size: u64,
    prefix_digest: [u8; 32],
) -> anyhow::Result<()> {
    anyhow::ensure!(offset <= expected_size, "resume offset exceeds archive");
    anyhow::ensure!(
        file.seek(SeekFrom::End(0))? == expected_size,
        "archive size changed"
    );
    file.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new();
    let mut remaining = offset;
    let mut buffer = [0_u8; 8192];
    while remaining > 0 {
        let wanted = usize::try_from(remaining.min(buffer.len() as u64))?;
        let count = file.read(&mut buffer[..wanted])?;
        anyhow::ensure!(count != 0, "archive prefix ended early");
        hash.update(&buffer[..count]);
        remaining -= count as u64;
    }
    let actual: [u8; 32] = hash.finalize().into();
    anyhow::ensure!(actual == prefix_digest, "resume prefix mismatch");
    Ok(())
}

/// The same binary envelope used by the experimental TypeScript peer.
pub(crate) fn encode_chunk(
    asset_id: &str,
    offset: u64,
    final_chunk: bool,
    data: &[u8],
) -> anyhow::Result<Vec<u8>> {
    let id = asset_id.as_bytes();
    anyhow::ensure!(!id.is_empty() && id.len() <= 255, "invalid asset id");
    anyhow::ensure!(data.len() <= MAX_CHUNK, "chunk too large");
    let mut frame = Vec::with_capacity(14 + id.len() + data.len());
    frame.push(id.len() as u8);
    frame.extend_from_slice(id);
    frame.extend_from_slice(&offset.to_be_bytes());
    frame.push(u8::from(final_chunk));
    frame.extend_from_slice(&(data.len() as u32).to_be_bytes());
    frame.extend_from_slice(data);
    Ok(frame)
}

pub(crate) fn decode_chunk(frame: &[u8]) -> anyhow::Result<(&str, u64, bool, &[u8])> {
    anyhow::ensure!(!frame.is_empty(), "empty frame");
    let id_len = frame[0] as usize;
    let header = 1 + id_len;
    anyhow::ensure!(id_len > 0 && frame.len() >= header + 13, "truncated frame");
    let id = std::str::from_utf8(&frame[1..header])?;
    let offset = u64::from_be_bytes(frame[header..header + 8].try_into()?);
    let final_chunk = match frame[header + 8] {
        0 => false,
        1 => true,
        _ => anyhow::bail!("invalid final marker"),
    };
    let size = u32::from_be_bytes(frame[header + 9..header + 13].try_into()?) as usize;
    anyhow::ensure!(
        size <= MAX_CHUNK && frame.len() == header + 13 + size,
        "invalid chunk length"
    );
    Ok((id, offset, final_chunk, &frame[header + 13..]))
}

pub(crate) struct Receiver<F> {
    file: F,
    hasher: Sha256,
    offset: u64,
    expected_size: u64,
    expected_digest: [u8; 32],
}

impl<F: Read + Write + Seek> Receiver<F> {
    #[cfg(test)]
    pub(crate) fn interrupt(self) -> F {
        self.file
    }
    /// Rehash the staged prefix, so a resume offset cannot skip integrity checks.
    pub(crate) fn resume(
        mut file: F,
        offset: u64,
        expected_size: u64,
        expected_digest: [u8; 32],
    ) -> anyhow::Result<Self> {
        anyhow::ensure!(
            offset <= expected_size,
            "resume offset exceeds expected size"
        );
        anyhow::ensure!(
            file.seek(SeekFrom::End(0))? == offset,
            "staged file length differs from resume offset"
        );
        file.seek(SeekFrom::Start(0))?;
        let mut hasher = Sha256::new();
        let mut left = offset;
        let mut buffer = [0_u8; 8192];
        while left > 0 {
            let wanted = usize::try_from(left.min(buffer.len() as u64))?;
            let read = file.read(&mut buffer[..wanted])?;
            anyhow::ensure!(read > 0, "staged prefix ended early");
            hasher.update(&buffer[..read]);
            left -= read as u64;
        }
        Ok(Self {
            file,
            hasher,
            offset,
            expected_size,
            expected_digest,
        })
    }

    pub(crate) fn append(&mut self, offset: u64, bytes: &[u8]) -> anyhow::Result<()> {
        anyhow::ensure!(offset == self.offset, "unexpected transfer offset");
        anyhow::ensure!(
            !bytes.is_empty() && bytes.len() <= MAX_CHUNK,
            "invalid chunk length"
        );
        let next = self
            .offset
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| anyhow::anyhow!("transfer size overflow"))?;
        anyhow::ensure!(next <= self.expected_size, "transfer exceeds declared size");
        self.file.write_all(bytes)?;
        self.hasher.update(bytes);
        self.offset = next;
        Ok(())
    }

    pub(crate) fn finish(mut self) -> anyhow::Result<F> {
        anyhow::ensure!(self.offset == self.expected_size, "transfer incomplete");
        let digest: [u8; 32] = self.hasher.finalize().into();
        anyhow::ensure!(
            digest == self.expected_digest,
            "transfer integrity check failed"
        );
        self.file.flush()?;
        Ok(self.file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn interruption_resume_rehashes_prefix_and_verifies_complete_file() {
        let content = b"a selected archive";
        let digest = Sha256::digest(content).into();
        let mut first =
            Receiver::resume(Cursor::new(Vec::new()), 0, content.len() as u64, digest).unwrap();
        first.append(0, &content[..5]).unwrap();
        let file = first.file;
        let mut resumed = Receiver::resume(file, 5, content.len() as u64, digest).unwrap();
        assert!(resumed.append(0, b"duplicate").is_err());
        resumed.append(5, &content[5..]).unwrap();
        assert_eq!(resumed.finish().unwrap().into_inner(), content);
    }

    #[test]
    fn corrupt_prefix_and_oversized_chunks_are_rejected() {
        let digest = Sha256::digest(b"correct").into();
        let mut receiver = Receiver::resume(Cursor::new(b"bad".to_vec()), 3, 7, digest).unwrap();
        assert!(receiver.append(3, &vec![0; MAX_CHUNK + 1]).is_err());
        receiver.append(3, b"rect").unwrap();
        assert!(receiver.finish().is_err());
        assert!(Receiver::resume(Cursor::new(b"bad".to_vec()), 2, 7, digest).is_err());
    }

    #[test]
    fn wire_frames_reject_truncation_and_invalid_markers() {
        let frame = encode_chunk("ebook", 42, false, b"abc").unwrap();
        assert_eq!(
            decode_chunk(&frame).unwrap(),
            ("ebook", 42, false, &b"abc"[..])
        );
        assert!(decode_chunk(&frame[..frame.len() - 1]).is_err());
        let mut bad = frame;
        bad[1 + "ebook".len() + 8] = 2;
        assert!(decode_chunk(&bad).is_err());
    }

    #[test]
    fn resume_offset_requires_matching_archive_prefix() {
        let data = b"selected archive bytes";
        let mut source = Cursor::new(data.to_vec());
        let digest = Sha256::digest(&data[..8]).into();
        verify_resume_prefix(&mut source, 8, data.len() as u64, digest).unwrap();
        assert_eq!(source.position(), 8);
        assert!(verify_resume_prefix(&mut source, 8, data.len() as u64, [0; 32]).is_err());
        assert!(verify_resume_prefix(&mut source, 100, data.len() as u64, digest).is_err());
        assert!(verify_resume_prefix(&mut source, 8, 99, digest).is_err());
    }

    #[test]
    fn negotiated_resume_rejects_tampered_or_malformed_prefix() {
        let data = b"trusted selected archive";
        let mut source = Cursor::new(data.to_vec());
        let good: String = Sha256::digest(&data[..7])
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let request = ResumeRequest {
            offset: 7,
            prefix_sha256: good.clone(),
        };
        assert_eq!(
            verify_resume_request(&mut source, data.len() as u64, &request).unwrap(),
            7
        );
        for bad in ["0".repeat(64), good.to_uppercase(), "bad".to_string()] {
            assert!(
                verify_resume_request(
                    &mut source,
                    data.len() as u64,
                    &ResumeRequest {
                        offset: 7,
                        prefix_sha256: bad
                    }
                )
                .is_err()
            );
        }
        assert!(
            verify_resume_request(
                &mut source,
                data.len() as u64,
                &ResumeRequest {
                    offset: 999,
                    prefix_sha256: good
                }
            )
            .is_err()
        );
    }
}
