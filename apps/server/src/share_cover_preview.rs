//! Raster-only thumbnails for the authenticated, encrypted gift preview.
//! The caller supplies an opened, selected cover whose bytes match its archive
//! receipt. This module never discovers files, accepts paths, or fetches URLs.

use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{ImageDecoder, ImageFormat, ImageReader, Limits};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{self, Cursor, Read, Write};

const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_INPUT_SIDE: u32 = 4096;
const MAX_INPUT_PIXELS: u64 = 4_000_000;
const MAX_DECODED_BYTES: u64 = 16 * 1024 * 1024;
const MAX_WORKING_BYTES: u64 = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 32 * 1024;
const MAX_OUTPUT_SIDE: u32 = 256;
static PREVIEW_WORKERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GiftCoverPreview {
    pub(crate) mime_type: &'static str,
    pub(crate) data_base64: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

/// Read only the selected cover entry from the already-created private archive,
/// not the original scan path. The receipt must come from archive construction.
/// File clones share a seek position: finish this work and rewind the sender's
/// descriptor before starting transfer. No selected cover means no archive read.
/// Retain admission inside blocking work even if its future is cancelled.
/// Bounded bytes, dimensions, pixels and allocation budgets limit work; this is
/// not a hard CPU-time sandbox (spawn_blocking cannot interrupt decoding).
pub(crate) async fn create_selected_cover_preview(
    archive: std::fs::File,
    selected: Option<crate::share::VerifiedArchiveAsset>,
) -> anyhow::Result<Option<GiftCoverPreview>> {
    let Some(selected) = selected else {
        return Ok(None);
    };
    let permit = PREVIEW_WORKERS.acquire().await?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        selected_cover_from_archive(archive, selected)
    })
    .await?
}

fn selected_cover_from_archive(
    archive: std::fs::File,
    selected: crate::share::VerifiedArchiveAsset,
) -> anyhow::Result<Option<GiftCoverPreview>> {
    anyhow::ensure!(
        selected.kind == crate::share::ShareAssetKind::Cover
            && !selected.name.is_empty()
            && selected.name != "."
            && selected.name != ".."
            && selected.name.len() <= 255
            && !selected
                .name
                .chars()
                .any(|c| c == '/' || c == '\\' || c.is_control())
            && selected.sha256.len() == 64
            && selected
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "invalid selected cover receipt"
    );
    let mut archive = zip::ZipArchive::new(archive)?;
    anyhow::ensure!(archive.len() <= 256, "invalid gift archive entry count");
    let entry = archive.by_name(&selected.name)?;
    anyhow::ensure!(
        entry.is_file() && !entry.encrypted() && entry.size() == selected.size,
        "selected cover archive entry does not match receipt"
    );
    // Oversized entries cannot produce a thumbnail; do not decompress/hash them
    // merely for this optional preview. No bytes from them reach the response.
    if selected.size > MAX_INPUT_BYTES as u64 {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    entry
        .take((MAX_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() as u64 == selected.size,
        "selected cover length changed"
    );
    let digest: String = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    anyhow::ensure!(digest == selected.sha256, "selected cover hash mismatch");
    // A valid, receipt-matching archive can contain an unsupported, malformed,
    // or too-large raster. Omit this optional image without exposing raw bytes.
    Ok(preview_from_bytes(bytes).ok())
}

#[cfg(test)]
fn preview_from_reader<R: Read>(opened_cover: R) -> anyhow::Result<GiftCoverPreview> {
    let mut bytes = Vec::new();
    opened_cover
        .take((MAX_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    preview_from_bytes(bytes)
}

fn preview_from_bytes(bytes: Vec<u8>) -> anyhow::Result<GiftCoverPreview> {
    anyhow::ensure!(
        !bytes.is_empty() && bytes.len() <= MAX_INPUT_BYTES,
        "cover preview input exceeds its byte limit"
    );
    let format = image::guess_format(&bytes)?;
    anyhow::ensure!(
        matches!(
            format,
            ImageFormat::Jpeg | ImageFormat::Png | ImageFormat::WebP
        ),
        "cover preview requires a supported raster"
    );
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_INPUT_SIDE);
    limits.max_image_height = Some(MAX_INPUT_SIDE);
    // PNG reserves working memory while constructing its decoder, so install
    // limits before parsing its header, not just before decoding its pixels.
    limits.max_alloc = Some(MAX_WORKING_BYTES);
    reader.limits(limits.clone());
    let mut decoder = reader.into_decoder()?;
    let (width, height) = decoder.dimensions();
    anyhow::ensure!(
        width > 0 && height > 0 && u64::from(width) * u64::from(height) <= MAX_INPUT_PIXELS,
        "cover preview exceeds its pixel limit"
    );
    anyhow::ensure!(
        decoder.total_bytes() <= MAX_DECODED_BYTES,
        "cover preview exceeds its decoded byte limit"
    );
    let mut budget = Limits::default();
    budget.max_alloc = Some(MAX_DECODED_BYTES + MAX_WORKING_BYTES);
    budget.reserve(decoder.total_bytes())?;
    limits.max_alloc = Some(budget.max_alloc.unwrap_or(0).min(MAX_WORKING_BYTES));
    decoder.set_limits(limits)?;
    let orientation = decoder.orientation()?;
    let decoded = image::DynamicImage::from_decoder(decoder)?;
    let mut small = if width > MAX_OUTPUT_SIDE || height > MAX_OUTPUT_SIDE {
        let small = decoded.thumbnail(MAX_OUTPUT_SIDE, MAX_OUTPUT_SIDE);
        drop(decoded);
        small
    } else {
        decoded
    };
    small.apply_orientation(orientation);
    let rgba = small.to_rgba8();
    drop(small);
    // Composite transparency onto white before JPEG conversion. Metadata,
    // animation and trailing/polyglot bytes never survive pixel re-encoding.
    let rgb = image::RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let pixel = rgba.get_pixel(x, y);
        let alpha = u32::from(pixel[3]);
        image::Rgb([0, 1, 2].map(|channel| {
            ((u32::from(pixel[channel]) * alpha + 255 * (255 - alpha) + 127) / 255) as u8
        }))
    });
    drop(rgba);
    let source = image::DynamicImage::ImageRgb8(rgb);
    for edge in [256, 192, 128, 96, 64] {
        let resized = if source.width() > edge || source.height() > edge {
            source.thumbnail(edge, edge)
        } else {
            source.clone()
        };
        let mut output = BoundedOutput::default();
        let encoded = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, 72)
            .encode_image(&resized);
        if encoded.is_ok() {
            return Ok(GiftCoverPreview {
                mime_type: "image/jpeg",
                data_base64: STANDARD.encode(&output.bytes),
                width: resized.width(),
                height: resized.height(),
            });
        }
        anyhow::ensure!(output.overflowed, "cover preview encoding failed");
    }
    anyhow::bail!("cover preview cannot fit its output limit")
}

#[derive(Default)]
struct BoundedOutput {
    bytes: Vec<u8>,
    overflowed: bool,
}

impl Write for BoundedOutput {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_OUTPUT_BYTES - self.bytes.len() {
            self.overflowed = true;
            return Err(io::Error::other("cover preview output limit"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    fn raster(format: ImageFormat, width: u32, height: u32) -> Vec<u8> {
        let image = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            width,
            height,
            image::Rgb([10, 30, 90]),
        ));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, format).unwrap();
        bytes.into_inner()
    }

    #[test]
    fn real_rasters_are_reencoded_without_paths_extensions_or_metadata() {
        for format in [ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::WebP] {
            let mut bytes = raster(format, 17, 23);
            bytes.extend_from_slice(b"<svg><script>remote()</script></svg>");
            let preview = preview_from_reader(Cursor::new(bytes)).unwrap();
            let encoded = STANDARD.decode(&preview.data_base64).unwrap();
            let decoded = image::load_from_memory(&encoded).unwrap();
            assert_eq!(image::guess_format(&encoded).unwrap(), ImageFormat::Jpeg);
            assert_eq!(preview.mime_type, "image/jpeg");
            assert_eq!((preview.width, preview.height), (17, 23));
            assert_eq!((decoded.width(), decoded.height()), (17, 23));
            assert!(!encoded.windows(7).any(|bytes| bytes == b"<script"));
            assert!(encoded.len() <= MAX_OUTPUT_BYTES);
            assert!(serde_json::to_vec(&preview).unwrap().len() < 48 * 1024);
            if format == ImageFormat::Png
                && let Ok(path) = std::env::var("OPERALIBRE_COVER_PREVIEW_FIXTURE")
            {
                std::fs::write(path, serde_json::to_vec(&preview).unwrap()).unwrap();
            }
        }
    }

    #[test]
    fn svg_html_empty_and_truncated_images_are_rejected() {
        for bytes in [
            Vec::new(),
            b"<svg/>".to_vec(),
            b"<html/>".to_vec(),
            raster(ImageFormat::Png, 17, 23)[..25].to_vec(),
        ] {
            assert!(preview_from_reader(Cursor::new(bytes)).is_err());
        }
    }

    #[test]
    fn compressed_dimension_and_high_bit_depth_bombs_are_rejected() {
        assert!(preview_from_reader(Cursor::new(raster(ImageFormat::Png, 4097, 1))).is_err());
        assert!(preview_from_reader(Cursor::new(raster(ImageFormat::Png, 2001, 2000))).is_err());
        let image = image::DynamicImage::ImageRgba16(image::ImageBuffer::from_pixel(
            1025,
            2048,
            image::Rgba([0_u16, 0, 0, 65535]),
        ));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        assert!(bytes.get_ref().len() < MAX_INPUT_BYTES);
        assert!(preview_from_reader(Cursor::new(bytes.into_inner())).is_err());
    }

    #[test]
    fn input_reader_stops_after_one_byte_beyond_the_limit() {
        struct Zeros(Arc<AtomicUsize>);
        impl Read for Zeros {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                buffer.fill(0);
                self.0.fetch_add(buffer.len(), Ordering::SeqCst);
                Ok(buffer.len())
            }
        }
        let count = Arc::new(AtomicUsize::new(0));
        assert!(preview_from_reader(Zeros(count.clone())).is_err());
        assert_eq!(count.load(Ordering::SeqCst), MAX_INPUT_BYTES + 1);
    }

    #[test]
    fn noisy_images_fit_the_output_and_dimension_limits() {
        let mut seed = 42_u32;
        let rgb = image::RgbImage::from_fn(256, 256, |_, _| {
            image::Rgb([0, 1, 2].map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                seed as u8
            }))
        });
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(rgb)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        let preview = preview_from_reader(Cursor::new(bytes.into_inner())).unwrap();
        let encoded = STANDARD.decode(preview.data_base64).unwrap();
        let decoded = image::load_from_memory(&encoded).unwrap();
        assert!(encoded.len() <= MAX_OUTPUT_BYTES);
        assert!(preview.width <= MAX_OUTPUT_SIDE && preview.height <= MAX_OUTPUT_SIDE);
        assert_eq!(
            (decoded.width(), decoded.height()),
            (preview.width, preview.height)
        );
    }

    fn archived_cover(bytes: &[u8]) -> (std::fs::File, crate::share::VerifiedArchiveAsset) {
        let mut writer = zip::ZipWriter::new(tempfile::tempfile().unwrap());
        writer
            .start_file(
                "selected",
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        writer.write_all(bytes).unwrap();
        let file = writer.finish().unwrap();
        (
            file,
            crate::share::VerifiedArchiveAsset {
                name: "selected".into(),
                kind: crate::share::ShareAssetKind::Cover,
                size: bytes.len() as u64,
                sha256: Sha256::digest(bytes)
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect(),
            },
        )
    }

    #[tokio::test]
    async fn no_selected_cover_never_reads_the_archive() {
        let mut not_an_archive = tempfile::tempfile().unwrap();
        not_an_archive
            .write_all(b"not a zip (ebook-only selection)")
            .unwrap();
        assert!(
            create_selected_cover_preview(not_an_archive, None)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn selected_archive_raster_is_receipt_verified_and_reencoded() {
        let (archive, receipt) = archived_cover(&raster(ImageFormat::Png, 400, 200));
        let preview = create_selected_cover_preview(archive, Some(receipt))
            .await
            .unwrap()
            .unwrap();
        assert_eq!((preview.width, preview.height), (256, 128));
        assert_eq!(
            image::guess_format(&STANDARD.decode(preview.data_base64).unwrap()).unwrap(),
            ImageFormat::Jpeg
        );
    }

    #[tokio::test]
    async fn corrupt_archives_or_mismatched_receipts_fail_closed() {
        let bytes = raster(ImageFormat::Png, 17, 23);
        for change in 0..5 {
            let (archive, mut receipt) = archived_cover(&bytes);
            match change {
                0 => receipt.sha256 = "0".repeat(64),
                1 => receipt.size += 1,
                2 => receipt.name = "absent".into(),
                3 => receipt.name = "../selected".into(),
                _ => receipt.kind = crate::share::ShareAssetKind::Ebook,
            }
            assert!(
                create_selected_cover_preview(archive, Some(receipt))
                    .await
                    .is_err()
            );
        }
        let (_, receipt) = archived_cover(&bytes);
        assert!(
            create_selected_cover_preview(tempfile::tempfile().unwrap(), Some(receipt))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn oversized_unsupported_or_undecodable_covers_are_omitted() {
        for bytes in [
            vec![0; MAX_INPUT_BYTES + 1],
            b"<svg/>".to_vec(),
            raster(ImageFormat::Png, 4097, 1),
        ] {
            let (archive, receipt) = archived_cover(&bytes);
            assert!(
                create_selected_cover_preview(archive, Some(receipt))
                    .await
                    .unwrap()
                    .is_none()
            );
        }
    }
}
