//! Disposable HTTP-test inputs, never an application import or a real library
//! migration. Both the EPUB and map are built here; unrelated companions and
//! the scanner's stable audio records remain unchanged.

use super::*;
use crate::companions::{CompanionFile, CompanionKind};
use crate::library::{ReadingFile, SyncFile};
use std::path::Path;

/// Install into a scratch test library while its write guard is held:
/// `share_alignment::fixture::install(&mut library, &book_id, &library_root)?`.
/// All asset IDs can then come from AlignmentPlan::required_asset_ids().
pub(crate) fn install(
    library: &mut LibraryState,
    book_id: &str,
    scratch_library: &Path,
) -> Result<()> {
    let book = library
        .book(book_id)
        .map_err(|_| anyhow!("Fixture book unavailable."))?
        .clone();
    ensure!(
        !book.tracks.is_empty()
            && book.tracks.iter().all(|track| track
                .duration_seconds
                .is_some_and(|duration| duration.is_finite() && duration > 0.0)),
        "Fixture needs trusted positive audio durations."
    );
    let first_duration = book.tracks[0].duration_seconds.unwrap();
    let (second_offset, second_duration) = book
        .tracks
        .get(1)
        .map_or((first_duration * 0.5, first_duration * 0.5), |track| {
            (first_duration, track.duration_seconds.unwrap())
        });
    let map = alignment::SyncMap {
        version: alignment::SYNC_MAP_VERSION,
        mapping_revision: alignment::MAPPING_REVISION,
        generator: None,
        generated_at: None,
        precision: Some(alignment::PRECISION_SENTENCE.into()),
        fragments: vec![
            alignment::SyncFragment {
                start_seconds: first_duration * 0.1,
                end_seconds: first_duration * 0.3,
                href: "text/ch1.xhtml".into(),
                text: "The meadow was quiet.".into(),
                words: vec![],
            },
            alignment::SyncFragment {
                start_seconds: second_offset + second_duration * 0.1,
                end_seconds: second_offset + second_duration * 0.3,
                href: "text/ch2.xhtml".into(),
                text: "The river ran fast & cold.".into(),
                words: vec![],
            },
        ],
        recovery_gaps: vec![],
    };
    let epub = alignment::build_test_epub();
    let reading = match book.reading_file {
        Some(reading)
            if reading.extension.eq_ignore_ascii_case("epub")
                && safe_name(&reading.file_name)
                && reading.file_name.to_ascii_lowercase().ends_with(".epub") =>
        {
            reading
        }
        _ => ReadingFile {
            id: format!("fixture-epub:{}", digest(book_id.as_bytes())),
            file_name: "fixture.epub".into(),
            extension: "epub".into(),
            content_type: "application/epub+zip".into(),
            url: "/fixture/reading".into(),
        },
    };
    let directory = scratch_library.join(format!(
        "gift-alignment-fixture-{}",
        &digest(book_id.as_bytes())[..16]
    ));
    std::fs::create_dir_all(&directory)?;
    let epub_path = directory.join(&reading.file_name);
    let map_path = directory.join("fixture.sync.json");
    std::fs::write(&epub_path, &epub)?;
    std::fs::write(&map_path, serde_json::to_vec(&map)?)?;
    let companion = CompanionFile {
        id: reading.id.clone(),
        file_name: reading.file_name.clone(),
        extension: "epub".into(),
        content_type: "application/epub+zip".into(),
        url: reading.url.clone(),
        kind: CompanionKind::Book,
        size_bytes: epub.len() as u64,
        page_count: None,
        image_count: None,
        text_characters: Some(5000),
        unreadable: false,
    };
    let book = library
        .books
        .iter_mut()
        .find(|book| book.id == book_id)
        .unwrap();
    book.companions.retain(|item| item.id != reading.id);
    book.companions.push(companion);
    book.reading_file = Some(reading.clone());
    book.sync_file = Some(SyncFile {
        outdated: false,
        file_name: "fixture.sync.json".into(),
        source: "sidecar".into(),
        url: "/fixture/sync".into(),
        quality: None,
        report_current: false,
    });
    library.reading_paths.insert(reading.id, epub_path);
    library.sync_paths.insert(book_id.into(), map_path);
    AlignmentPlan::from_library(library, book_id)?;
    Ok(())
}
