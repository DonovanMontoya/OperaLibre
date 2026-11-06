//! Alignment-bundle validation against trusted library records and an already
//! verified selected archive. This module does not enable alignment sharing.
//!
//! SyncMap contains book-time clocks and EPUB href/text, not input digests.
//! These checks establish structural compatibility with the currently served
//! book; they do not certify narration accuracy or historical input identity.

#![allow(dead_code)]

use crate::alignment;
use crate::library::LibraryState;
use crate::share::{ShareAssetKind, VerifiedArchive, VerifiedArchiveAsset};
use anyhow::{Result, anyhow, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read, Seek, SeekFrom};

const MAX_MAP_BYTES: u64 = 16 * 1024 * 1024;
const MAX_EPUB_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EPUB_TEXT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 256 * 1024;
const MAX_FRAGMENTS: usize = 100_000;
const MAX_CHAPTERS: usize = 4096;
const MAX_TIMELINE_SECONDS: f64 = (366 * 24 * 60 * 60) as f64;
pub(crate) const ALIGNMENT_ARCHIVE_NAME: &str = "alignment.sync.json";

// Sharing a local sidecar is stricter than merely reading it: reject unknown
// payload fields rather than send arbitrary private annotations with the map.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShareMap {
    version: u32,
    #[serde(default)]
    mapping_revision: u32,
    generator: Option<String>,
    generated_at: Option<String>,
    precision: Option<String>,
    fragments: Vec<ShareFragment>,
    #[serde(default)]
    recovery_gaps: Vec<ShareGap>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShareFragment {
    start_seconds: f64,
    end_seconds: f64,
    href: String,
    text: String,
    #[serde(default)]
    words: Vec<alignment::WordTiming>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShareGap {
    start_seconds: f64,
    end_seconds: f64,
}

fn parse_share_map(bytes: &[u8]) -> Result<alignment::SyncMap> {
    let map: ShareMap = serde_json::from_slice(bytes)?;
    Ok(alignment::SyncMap {
        version: map.version,
        mapping_revision: map.mapping_revision,
        generator: map.generator,
        generated_at: map.generated_at,
        precision: map.precision,
        fragments: map
            .fragments
            .into_iter()
            .map(|fragment| alignment::SyncFragment {
                start_seconds: fragment.start_seconds,
                end_seconds: fragment.end_seconds,
                href: fragment.href,
                text: fragment.text,
                words: fragment.words,
            })
            .collect(),
        recovery_gaps: map
            .recovery_gaps
            .into_iter()
            .map(|gap| alignment::RecoveryGap {
                start_seconds: gap.start_seconds,
                end_seconds: gap.end_seconds,
            })
            .collect(),
    })
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelectedChapter {
    pub(crate) title: String,
    pub(crate) start_seconds: f64,
    pub(crate) end_seconds: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelectedAudio {
    pub(crate) file_name: String,
    pub(crate) title: String,
    pub(crate) index: usize,
    pub(crate) duration_seconds: f64,
    pub(crate) chapters: Vec<SelectedChapter>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AlignmentMetadata {
    pub(crate) asset_name: &'static str,
    pub(crate) ebook_asset_name: String,
    pub(crate) audio_asset_names: Vec<String>,
    pub(crate) timeline: &'static str,
    pub(crate) precision: &'static str,
}

/// Private constructor: only LibraryState, never HTTP metadata/paths, supplies
/// these bindings. File opening and per-book authorization remain the caller's
/// existing trusted selection/archive responsibilities.
pub(crate) struct AlignmentPlan {
    required_asset_ids: Vec<String>,
    selected_audio: Vec<SelectedAudio>,
    reading_file_name: String,
    duration_seconds: f64,
}

pub(crate) struct ValidatedAlignment {
    /// Receipt hashes bind metadata, the EPUB, map and all audio together in
    /// the same signed preview/archive. Never serialize server paths or IDs.
    pub(crate) bindings: Vec<VerifiedArchiveAsset>,
    pub(crate) fragment_count: usize,
    pub(crate) mapping_revision: u32,
}

fn safe_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value != "."
        && value != ".."
        && !value
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '/' | '\\'))
}

impl AlignmentPlan {
    pub(crate) fn from_library(library: &LibraryState, book_id: &str) -> Result<Self> {
        let book = library
            .book(book_id)
            .map_err(|_| anyhow!("Book unavailable."))?;
        let reading = book
            .reading_file
            .as_ref()
            .ok_or_else(|| anyhow!("A matching primary EPUB is required."))?;
        ensure!(
            reading.extension.eq_ignore_ascii_case("epub")
                && reading.file_name.to_ascii_lowercase().ends_with(".epub")
                && safe_name(&reading.file_name),
            "A matching primary EPUB is required."
        );
        let companion = book
            .companions
            .iter()
            .find(|item| item.id == reading.id)
            .ok_or_else(|| anyhow!("The primary EPUB must have a trusted companion record."))?;
        ensure!(
            matches!(companion.kind, crate::companions::CompanionKind::Book)
                && !companion.unreadable
                && companion.extension.eq_ignore_ascii_case("epub")
                && companion.file_name == reading.file_name
                && library.reading_paths.contains_key(&reading.id),
            "The primary EPUB is not a readable matching book companion."
        );
        ensure!(
            book.sync_file.is_some() && library.sync_paths.contains_key(book_id),
            "The book has no served alignment map."
        );
        // Reserve metadata, EPUB and map entries within the existing 256-entry
        // archive ceiling. A selected cover consumes one more slot upstream.
        ensure!(
            !book.tracks.is_empty()
                && book.tracks.len() <= 253
                && book.track_count == book.tracks.len(),
            "Alignment requires the complete bounded audio set."
        );
        let mut ids = HashSet::new();
        let mut names = HashSet::from([
            "metadata.json".to_string(),
            ALIGNMENT_ARCHIVE_NAME.to_string(),
            reading.file_name.to_lowercase(),
        ]);
        ensure!(
            names.len() == 3 && ids.insert(reading.id.clone()),
            "Alignment filenames or identities collide."
        );
        let mut required_asset_ids = vec![reading.id.clone()];
        let mut selected_audio = Vec::with_capacity(book.tracks.len());
        let mut duration_seconds = 0.0;
        let mut chapter_count = 0;
        for (index, track) in book.tracks.iter().enumerate() {
            let extension = std::path::Path::new(&track.file_name)
                .extension()
                .and_then(|extension| extension.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            ensure!(
                track.index == index
                    && !track.id.is_empty()
                    && ids.insert(track.id.clone())
                    && safe_name(&track.file_name)
                    && names.insert(track.file_name.to_lowercase())
                    && matches!(
                        extension.as_str(),
                        "aac"
                            | "aiff"
                            | "flac"
                            | "m4a"
                            | "m4b"
                            | "mp3"
                            | "mp4"
                            | "ogg"
                            | "opus"
                            | "wav"
                    )
                    && library.track_paths.contains_key(&track.id),
                "Audio order, identity or trusted file binding is invalid."
            );
            let duration = track
                .duration_seconds
                .filter(|duration| duration.is_finite() && *duration > 0.0)
                .ok_or_else(|| {
                    anyhow!("Every alignment audio track needs a known positive duration.")
                })?;
            duration_seconds += duration;
            ensure!(
                duration_seconds.is_finite()
                    && duration_seconds <= MAX_TIMELINE_SECONDS
                    && !track.title.trim().is_empty()
                    && track.title.chars().count() <= 1024,
                "Audio duration or title is invalid."
            );
            chapter_count += track.chapters.len();
            ensure!(
                chapter_count <= MAX_CHAPTERS,
                "Too many alignment chapters."
            );
            let mut chapters = Vec::with_capacity(track.chapters.len());
            let mut previous = 0.0;
            for chapter in &track.chapters {
                ensure!(
                    chapter.track_id == track.id
                        && chapter.track_index == index
                        && chapter.start_seconds.is_finite()
                        && chapter.start_seconds >= previous
                        && chapter.start_seconds <= duration
                        && !chapter.title.trim().is_empty()
                        && chapter.title.chars().count() <= 1024
                        && chapter.end_seconds.is_none_or(|end| end.is_finite()
                            && end >= chapter.start_seconds
                            && end <= duration),
                    "Chapter timing does not match its audio track."
                );
                previous = chapter.start_seconds;
                chapters.push(SelectedChapter {
                    title: chapter.title.clone(),
                    start_seconds: chapter.start_seconds,
                    end_seconds: chapter.end_seconds,
                });
            }
            required_asset_ids.push(track.id.clone());
            selected_audio.push(SelectedAudio {
                file_name: track.file_name.clone(),
                title: track.title.clone(),
                index,
                duration_seconds: duration,
                chapters,
            });
        }
        let sync_id = format!("sync:{book_id}");
        ensure!(ids.insert(sync_id.clone()), "Alignment identities collide.");
        required_asset_ids.push(sync_id);
        Ok(Self {
            required_asset_ids,
            selected_audio,
            reading_file_name: reading.file_name.clone(),
            duration_seconds,
        })
    }

    pub(crate) fn required_asset_ids(&self) -> &[String] {
        &self.required_asset_ids
    }
    pub(crate) fn selected_audio(&self) -> &[SelectedAudio] {
        &self.selected_audio
    }
    pub(crate) fn metadata_projection(&self) -> AlignmentMetadata {
        AlignmentMetadata {
            asset_name: ALIGNMENT_ARCHIVE_NAME,
            ebook_asset_name: self.reading_file_name.clone(),
            audio_asset_names: self
                .selected_audio
                .iter()
                .map(|track| track.file_name.clone())
                .collect(),
            timeline: "book",
            precision: alignment::PRECISION_SENTENCE,
        }
    }

    pub(crate) fn ensure_selected(&self, selected_ids: &[String]) -> Result<()> {
        let selected: HashSet<_> = selected_ids.iter().collect();
        ensure!(
            selected.len() == selected_ids.len()
                && self
                    .required_asset_ids
                    .iter()
                    .all(|id| selected.contains(id)),
            "Alignment requires the matching EPUB, served map and complete audio set; subset maps are not supported."
        );
        Ok(())
    }

    /// Call after spooling and before publishing a preview. The receipt must be
    /// produced by write_verified_archive, not reconstructed from a request.
    /// Only small map/EPUB/metadata entries are reread; audio is already hashed
    /// by the bounded archive writer and is not read a second time here.
    pub(crate) fn validate_archive<R: Read + Seek>(
        &self,
        archive: R,
        receipt: &VerifiedArchive,
    ) -> Result<ValidatedAlignment> {
        ensure!(receipt.assets.len() <= 256, "Too many archive entries.");
        let mut expected = HashMap::from([
            ("metadata.json".to_string(), ShareAssetKind::Metadata),
            (self.reading_file_name.clone(), ShareAssetKind::Ebook),
            (
                ALIGNMENT_ARCHIVE_NAME.to_string(),
                ShareAssetKind::Alignment,
            ),
        ]);
        for track in &self.selected_audio {
            expected.insert(track.file_name.clone(), ShareAssetKind::Audio);
        }
        let mut names = HashSet::new();
        for asset in &receipt.assets {
            ensure!(
                safe_name(&asset.name) && names.insert(asset.name.to_lowercase()),
                "Archive names collide or escape."
            );
            if asset.kind != ShareAssetKind::Cover {
                ensure!(
                    expected.remove(&asset.name) == Some(asset.kind),
                    "Archive contains an unselected or mismatched asset."
                );
            }
        }
        ensure!(
            expected.is_empty()
                && receipt
                    .assets
                    .iter()
                    .filter(|asset| asset.kind == ShareAssetKind::Cover)
                    .count()
                    <= 1,
            "The alignment archive is incomplete."
        );
        let mut zip = zip::ZipArchive::new(archive)?;
        ensure!(
            zip.len() == receipt.assets.len(),
            "Archive entries do not match the receipt."
        );
        let mut archive_names = HashSet::new();
        for index in 0..zip.len() {
            let file = zip.by_index(index)?;
            let name = file.name()?;
            ensure!(
                !file.is_dir()
                    && archive_names.insert(name.to_string())
                    && receipt
                        .assets
                        .iter()
                        .any(|asset| asset.name == name.as_ref() && asset.size == file.size()),
                "Archive contains a duplicate or unreceipted entry."
            );
        }
        let metadata = read_entry(&mut zip, receipt, "metadata.json", MAX_METADATA_BYTES)?;
        let metadata: serde_json::Value = serde_json::from_slice(&metadata)?;
        ensure!(
            metadata.get("version").and_then(serde_json::Value::as_u64) == Some(1)
                && metadata.get("tracks") == Some(&serde_json::to_value(&self.selected_audio)?)
                && metadata.get("alignment")
                    == Some(&serde_json::to_value(self.metadata_projection())?),
            "Selected audio/alignment metadata does not preserve the trusted bindings, order, durations and chapters."
        );
        let epub = read_entry(&mut zip, receipt, &self.reading_file_name, MAX_EPUB_BYTES)?;
        let epub = alignment::parse_epub_archive_within(
            &mut zip::ZipArchive::new(Cursor::new(epub))?,
            MAX_EPUB_TEXT_BYTES,
        )?;
        let map = read_entry(&mut zip, receipt, ALIGNMENT_ARCHIVE_NAME, MAX_MAP_BYTES)?;
        let map = parse_share_map(&map)?;
        validate_map(&map, &epub, self.duration_seconds)?;
        // File clones share an underlying seek position; leave a successful
        // archive ready for the existing sender even when passed as &mut File.
        zip.into_inner().seek(SeekFrom::Start(0))?;
        Ok(ValidatedAlignment {
            bindings: receipt.assets.clone(),
            fragment_count: map.fragments.len(),
            mapping_revision: map.mapping_revision,
        })
    }
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn read_entry<R: Read + Seek>(
    zip: &mut zip::ZipArchive<R>,
    receipt: &VerifiedArchive,
    name: &str,
    maximum: u64,
) -> Result<Vec<u8>> {
    let asset = receipt
        .assets
        .iter()
        .find(|asset| asset.name == name)
        .ok_or_else(|| anyhow!("Missing archive receipt."))?;
    ensure!(
        asset.size <= maximum,
        "Alignment input exceeds its bounded read limit."
    );
    let file = zip.by_name(name)?;
    ensure!(file.size() == asset.size, "Archive entry size changed.");
    let mut bytes = Vec::new();
    file.take(maximum + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 == asset.size && digest(&bytes) == asset.sha256,
        "Archive entry integrity changed."
    );
    Ok(bytes)
}

fn normalize_text(value: &str) -> String {
    let mut result = String::new();
    let mut space = false;
    for ch in value.chars().filter(|ch| *ch != '\u{00ad}') {
        // Match the JS reader's /\s/ set, including BOM but not Unicode NEL.
        if matches!(ch, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
        {
            space = !result.is_empty();
        } else {
            if space {
                result.push(' ');
                space = false;
            }
            result.extend(ch.to_lowercase());
        }
    }
    result
}

// Keep the gift recipient's relative EPUB href boundary. Decode exactly once,
// strictly as UTF-8 (like decodeURIComponent), never as a filesystem path.
fn safe_map_href(value: &str) -> bool {
    if value.is_empty()
        || value.encode_utf16().count() > 2048
        || value.starts_with('/')
        || value
            .chars()
            .any(|ch| ch <= '\u{20}' || ch == '\u{7f}' || matches!(ch, '\\' | ':' | '?'))
    {
        return false;
    }
    let path = value.split('#').next().unwrap_or("");
    let mut bytes = Vec::with_capacity(path.len());
    let mut input = path.bytes();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let Some(high) = input.next().and_then(|byte| (byte as char).to_digit(16)) else {
                return false;
            };
            let Some(low) = input.next().and_then(|byte| (byte as char).to_digit(16)) else {
                return false;
            };
            bytes.push((high * 16 + low) as u8);
        } else {
            bytes.push(byte);
        }
    }
    let Ok(decoded) = std::str::from_utf8(&bytes) else {
        return false;
    };
    !decoded.starts_with('/')
        && !decoded.contains(['\\', ':'])
        && !decoded.chars().any(|ch| ch.is_control())
        && decoded
            .split('/')
            .all(|part| !matches!(part, "" | "." | ".."))
}

fn validate_map(
    map: &alignment::SyncMap,
    epub: &alignment::EpubDocument,
    duration: f64,
) -> Result<()> {
    ensure!(
        (1..=alignment::SYNC_MAP_VERSION).contains(&map.version)
            && (map.precision.as_deref() == Some(alignment::PRECISION_SENTENCE)
                || (map.version == 1 && map.precision.is_none()))
            && !map.fragments.is_empty()
            && map.fragments.len() <= MAX_FRAGMENTS
            && map.recovery_gaps.len() <= MAX_FRAGMENTS,
        "Alignment map is not a bounded usable sentence map."
    );
    // Mapping revision indicates quality/remapping guidance, not compatibility.
    // Existing older maps remain usable; this code never bumps that revision.
    let mut sections = HashMap::<String, (String, usize)>::new();
    for section in &epub.sections {
        let text = normalize_text(&section.text);
        if text.is_empty() {
            continue;
        }
        let entry = sections.entry(section.href.clone()).or_default();
        if !entry.0.is_empty() {
            entry.0.push(' ');
        }
        entry.0.push_str(&text);
    }
    let mut previous = 0.0;
    let mut word_count = 0usize;
    for fragment in &map.fragments {
        ensure!(
            fragment.start_seconds.is_finite()
                && fragment.end_seconds.is_finite()
                && fragment.start_seconds >= previous
                && fragment.end_seconds > fragment.start_seconds
                && fragment.end_seconds <= duration
                && safe_map_href(&fragment.href),
            "Map timing does not match complete audio."
        );
        previous = fragment.end_seconds;
        let (text, cursor) = sections
            .get_mut(&fragment.href)
            .ok_or_else(|| anyhow!("Map href does not match the selected EPUB."))?;
        let needle = normalize_text(&fragment.text);
        ensure!(
            !needle.is_empty() && fragment.text.len() <= 64 * 1024 && !fragment.text.contains('\0'),
            "Map fragment text is empty or excessive."
        );
        let offset = text[*cursor..].find(&needle).ok_or_else(|| {
            anyhow!("Map text does not match the selected EPUB in reading order.")
        })?;
        *cursor += offset + needle.len();
        let utf16_len = fragment.text.encode_utf16().count() as u64;
        let mut boundaries = vec![0u64];
        for ch in fragment.text.chars() {
            boundaries.push(boundaries.last().copied().unwrap() + ch.len_utf16() as u64);
        }
        let mut previous_word = fragment.start_seconds;
        let mut previous_offset = 0u64;
        word_count += fragment.words.len();
        ensure!(word_count <= 1_000_000, "Too many alignment words.");
        for word in &fragment.words {
            let end = u64::from(word.2) + u64::from(word.3);
            ensure!(
                word.0.is_finite()
                    && word.1.is_finite()
                    && word.0 >= previous_word
                    && word.0 >= fragment.start_seconds
                    && word.1 > word.0
                    && word.1 <= fragment.end_seconds
                    && u64::from(word.2) >= previous_offset
                    && word.3 > 0
                    && end <= utf16_len
                    && boundaries.binary_search(&u64::from(word.2)).is_ok()
                    && boundaries.binary_search(&end).is_ok(),
                "Word timing or UTF-16 span is invalid."
            );
            previous_word = word.0;
            previous_offset = end;
        }
    }
    for gap in &map.recovery_gaps {
        ensure!(
            gap.start_seconds.is_finite()
                && gap.end_seconds.is_finite()
                && gap.start_seconds >= 0.0
                && gap.end_seconds > gap.start_seconds
                && gap.end_seconds <= duration,
            "Recovery gap is outside the complete audio."
        );
    }
    let mut gaps = map
        .recovery_gaps
        .iter()
        .map(|gap| (gap.start_seconds, gap.end_seconds))
        .collect::<Vec<_>>();
    gaps.sort_by(|left, right| left.0.total_cmp(&right.0));
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for (start, end) in gaps {
        if let Some(previous) = merged.last_mut().filter(|previous| start <= previous.1) {
            previous.1 = previous.1.max(end);
        } else {
            merged.push((start, end));
        }
    }
    ensure!(
        map.fragments.iter().any(|fragment| {
            let next = merged.partition_point(|gap| gap.1 <= fragment.start_seconds);
            merged
                .get(next)
                .is_none_or(|gap| gap.0 > fragment.start_seconds || gap.1 < fragment.end_seconds)
        }),
        "Recovery gaps cover every aligned fragment."
    );
    Ok(())
}

#[cfg(test)]
#[path = "share_alignment_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "share_alignment_fixture.rs"]
pub(crate) mod fixture;
