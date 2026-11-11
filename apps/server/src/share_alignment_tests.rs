use super::*;
use crate::library::{Book, Chapter, ReadingFile, SyncFile, Track};
use crate::share::{GeneratedArchiveEntry, PlannedShareFile, write_verified_archive};
use std::path::PathBuf;

struct Fixture {
    library: LibraryState,
    root: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let reading = ReadingFile {
            id: "primary-epub".into(),
            file_name: "book.epub".into(),
            extension: "epub".into(),
            content_type: "application/epub+zip".into(),
            url: "/private/reading".into(),
        };
        let companion = crate::companions::CompanionFile {
            id: reading.id.clone(),
            file_name: reading.file_name.clone(),
            extension: "epub".into(),
            content_type: reading.content_type.clone(),
            url: reading.url.clone(),
            kind: crate::companions::CompanionKind::Book,
            size_bytes: 0,
            page_count: None,
            image_count: None,
            text_characters: Some(5000),
            unreadable: false,
        };
        let tracks = [
            ("stable-z", "z-first.wav", 10.0),
            ("stable-a", "a-second.wav", 20.0),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (id, name, duration))| Track {
            id: id.into(),
            title: format!("Track {}", index + 1),
            file_name: name.into(),
            index,
            duration_seconds: Some(duration),
            stream_url: format!("/private/{id}/stream"),
            chapters: vec![Chapter {
                id: format!("chapter-{id}"),
                title: "Opening".into(),
                track_id: id.into(),
                track_index: index,
                start_seconds: 0.0,
                end_seconds: Some(duration),
                source: "embedded".into(),
            }],
            metadata: Default::default(),
        })
        .collect::<Vec<_>>();
        let book = Book {
            id: "trusted-book".into(),
            title: "Trusted title".into(),
            author: Some("Author".into()),
            narrator: None,
            duration_seconds: Some(30.0),
            track_count: tracks.len(),
            cover_art_url: None,
            has_cover_override: false,
            cover_art_content_type: None,
            description: None,
            genres: vec![],
            tags: vec![],
            published_date: None,
            asin: None,
            added_at: "2026-01-01T00:00:00Z".into(),
            reading_file: Some(reading),
            companions: vec![companion],
            sync_file: Some(SyncFile {
                outdated: false,
                file_name: "source.sync.json".into(),
                source: "sidecar".into(),
                url: "/private/sync".into(),
                quality: None,
                report_current: false,
            }),
            chapters: vec![],
            metadata: Default::default(),
            tracks,
            progress: None,
            shared_progress: vec![],
            volume_gain: 1.0,
        };
        let mut library = LibraryState {
            books: vec![book],
            ..Default::default()
        };
        let epub = root.path().join("book.epub");
        std::fs::write(&epub, alignment::build_test_epub()).unwrap();
        library.reading_paths.insert("primary-epub".into(), epub);
        for track in &library.books[0].tracks {
            let path = root.path().join(&track.file_name);
            // The trusted scanner's duration is the source of the plan; file
            // bytes are independently hashed by the real bounded ZIP writer.
            std::fs::write(&path, format!("fixture bytes for {}", track.id)).unwrap();
            library.track_paths.insert(track.id.clone(), path);
        }
        let map = root.path().join("source.sync.json");
        std::fs::write(&map, serde_json::to_vec(&Self::map()).unwrap()).unwrap();
        library.sync_paths.insert("trusted-book".into(), map);
        Self { library, root }
    }

    fn map() -> alignment::SyncMap {
        serde_json::from_value(serde_json::json!({ "version":2,"mappingRevision":alignment::MAPPING_REVISION,"precision":"sentence","fragments":[
            {"startSeconds":1.0,"endSeconds":2.0,"href":"text/ch1.xhtml","text":"The meadow was quiet.","words":[[1.0,1.4,0,3]]},
            {"startSeconds":11.0,"endSeconds":12.0,"href":"text/ch2.xhtml","text":"The river ran fast & cold."}
        ]})).unwrap()
    }

    fn plan(&self) -> AlignmentPlan {
        AlignmentPlan::from_library(&self.library, "trusted-book").unwrap()
    }

    fn archive(
        &self,
        metadata_change: impl FnOnce(&mut serde_json::Value),
        omit: Option<&str>,
    ) -> (PathBuf, VerifiedArchive) {
        let plan = self.plan();
        let book = &self.library.books[0];
        let mut metadata: serde_json::Value = serde_json::from_slice(
            &crate::share_metadata::selected(book, plan.required_asset_ids()).unwrap(),
        )
        .unwrap();
        metadata["alignment"] = serde_json::to_value(plan.metadata_projection()).unwrap();
        metadata_change(&mut metadata);
        let mut files = vec![
            PlannedShareFile {
                id: "primary-epub".into(),
                kind: ShareAssetKind::Ebook,
                archive_name: "book.epub".into(),
                path: self.library.reading_paths["primary-epub"].clone(),
                size_bytes: std::fs::metadata(&self.library.reading_paths["primary-epub"])
                    .unwrap()
                    .len(),
            },
            PlannedShareFile {
                id: "sync:trusted-book".into(),
                kind: ShareAssetKind::Alignment,
                archive_name: ALIGNMENT_ARCHIVE_NAME.into(),
                path: self.library.sync_paths["trusted-book"].clone(),
                size_bytes: std::fs::metadata(&self.library.sync_paths["trusted-book"])
                    .unwrap()
                    .len(),
            },
        ];
        for track in &book.tracks {
            files.push(PlannedShareFile {
                id: track.id.clone(),
                kind: ShareAssetKind::Audio,
                archive_name: track.file_name.clone(),
                path: self.library.track_paths[&track.id].clone(),
                size_bytes: std::fs::metadata(&self.library.track_paths[&track.id])
                    .unwrap()
                    .len(),
            });
        }
        files.retain(|file| Some(file.archive_name.as_str()) != omit);
        let path = self.root.path().join("selected.zip");
        std::fs::File::create(&path).unwrap();
        let receipt = write_verified_archive(
            &path,
            &files,
            &[GeneratedArchiveEntry {
                archive_name: "metadata.json".into(),
                contents: serde_json::to_vec(&metadata).unwrap(),
            }],
            self.root.path(),
            1024 * 1024,
        )
        .unwrap();
        (path, receipt)
    }
}

#[test]
fn trusted_plan_preserves_nonlexical_audio_order_and_compact_metadata() {
    let fixture = Fixture::new();
    let plan = fixture.plan();
    assert_eq!(
        plan.required_asset_ids(),
        ["primary-epub", "stable-z", "stable-a", "sync:trusted-book"]
    );
    assert_eq!(plan.selected_audio()[0].file_name, "z-first.wav");
    assert_eq!(plan.selected_audio()[1].index, 1);
    assert_eq!(plan.selected_audio()[1].duration_seconds, 20.0);
    let projection = serde_json::to_value(plan.metadata_projection()).unwrap();
    assert_eq!(
        projection,
        serde_json::json!({"assetName":"alignment.sync.json","ebookAssetName":"book.epub","audioAssetNames":["z-first.wav","a-second.wav"],"timeline":"book","precision":"sentence"})
    );
    assert!(
        !serde_json::to_string(plan.selected_audio())
            .unwrap()
            .contains("private")
    );
    let (path, receipt) = fixture.archive(|_| {}, None);
    let mut archive = std::fs::File::open(path).unwrap();
    let validated = plan.validate_archive(&mut archive, &receipt).unwrap();
    assert_eq!(validated.fragment_count, 2);
    assert_eq!(validated.bindings.len(), 5);
    assert_eq!(archive.stream_position().unwrap(), 0);
}

#[test]
fn alignment_requires_primary_epub_complete_audio_and_trusted_paths() {
    let mut fixture = Fixture::new();
    let plan = fixture.plan();
    assert!(
        plan.ensure_selected(&[
            "primary-epub".into(),
            "stable-z".into(),
            "sync:trusted-book".into()
        ])
        .is_err()
    );
    assert!(plan.ensure_selected(plan.required_asset_ids()).is_ok());
    fixture.library.track_paths.remove("stable-a");
    assert!(AlignmentPlan::from_library(&fixture.library, "trusted-book").is_err());
    let mut fixture = Fixture::new();
    fixture.library.books[0].companions[0].kind = crate::companions::CompanionKind::Supplement;
    assert!(AlignmentPlan::from_library(&fixture.library, "trusted-book").is_err());
    let mut fixture = Fixture::new();
    fixture.library.books[0].tracks[1].duration_seconds = None;
    assert!(AlignmentPlan::from_library(&fixture.library, "trusted-book").is_err());
    let mut fixture = Fixture::new();
    fixture.library.books[0].tracks[1].index = 0;
    assert!(AlignmentPlan::from_library(&fixture.library, "trusted-book").is_err());
}

#[test]
fn actual_archive_rejects_missing_audio_wrong_metadata_and_broken_receipt_hash() {
    let fixture = Fixture::new();
    let plan = fixture.plan();
    let (path, receipt) = fixture.archive(|_| {}, Some("a-second.wav"));
    assert!(
        plan.validate_archive(std::fs::File::open(path).unwrap(), &receipt)
            .is_err()
    );
    let (path, receipt) = fixture.archive(
        |metadata| metadata["tracks"].as_array_mut().unwrap().swap(0, 1),
        None,
    );
    assert!(
        plan.validate_archive(std::fs::File::open(path).unwrap(), &receipt)
            .is_err()
    );
    let (path, mut receipt) = fixture.archive(|_| {}, None);
    receipt
        .assets
        .iter_mut()
        .find(|asset| asset.kind == ShareAssetKind::Ebook)
        .unwrap()
        .sha256 = "0".repeat(64);
    assert!(
        plan.validate_archive(std::fs::File::open(path).unwrap(), &receipt)
            .is_err()
    );
    let (path, receipt) = fixture.archive(
        |metadata| {
            metadata["alignment"]["audioAssetNames"] =
                serde_json::json!(["a-second.wav", "z-first.wav"])
        },
        None,
    );
    assert!(
        plan.validate_archive(std::fs::File::open(path).unwrap(), &receipt)
            .is_err()
    );
}

#[test]
fn map_matching_rejects_wrong_text_href_clocks_and_word_spans() {
    let epub = alignment::parse_epub(&alignment::build_test_epub()).unwrap();
    let mut map = Fixture::map();
    map.fragments[0].text = "A different edition.".into();
    assert!(validate_map(&map, &epub, 30.0).is_err());
    let mut map = Fixture::map();
    map.fragments[0].href = "other.xhtml".into();
    assert!(validate_map(&map, &epub, 30.0).is_err());
    let mut map = Fixture::map();
    map.fragments[1].end_seconds = 31.0;
    assert!(validate_map(&map, &epub, 30.0).is_err());
    let mut map = Fixture::map();
    map.fragments[0].start_seconds = f64::NAN;
    assert!(validate_map(&map, &epub, 30.0).is_err());
    let mut map = Fixture::map();
    map.fragments[0].words[0].3 = u32::MAX;
    assert!(validate_map(&map, &epub, 30.0).is_err());
    let mut map = Fixture::map();
    map.recovery_gaps.push(alignment::RecoveryGap {
        start_seconds: 29.0,
        end_seconds: 40.0,
    });
    assert!(validate_map(&map, &epub, 30.0).is_err());
    let mut map = Fixture::map();
    map.precision = Some("estimated".into());
    assert!(validate_map(&map, &epub, 30.0).is_err());
    let mut map = Fixture::map();
    map.version = alignment::SYNC_MAP_VERSION + 1;
    assert!(validate_map(&map, &epub, 30.0).is_err());
    let mut map = Fixture::map();
    map.recovery_gaps.push(alignment::RecoveryGap {
        start_seconds: 0.0,
        end_seconds: 30.0,
    });
    assert!(validate_map(&map, &epub, 30.0).is_err());
}

#[test]
fn older_mapping_revision_remains_usable_and_ordered_repetition_is_not_guessed() {
    let epub = alignment::parse_epub(&alignment::build_test_epub()).unwrap();
    let mut map = Fixture::map();
    map.mapping_revision = 0;
    map.version = 1;
    map.precision = None;
    assert!(validate_map(&map, &epub, 30.0).is_ok());
    map.fragments[0].start_seconds = 1.0004; // Native words cannot precede the fragment.
    assert!(validate_map(&map, &epub, 30.0).is_err());
    map.fragments[0].words[0].0 = 1.0004;
    assert!(validate_map(&map, &epub, 30.0).is_ok());
    map.fragments.push(map.fragments[1].clone());
    map.fragments[2].start_seconds = 14.0;
    map.fragments[2].end_seconds = 15.0;
    assert!(validate_map(&map, &epub, 30.0).is_err());
}

#[test]
fn word_offsets_cannot_split_utf16_surrogates() {
    let epub = alignment::parse_epub(&alignment::build_test_epub_with_text(
        "<p>A 🦊 waved.</p>",
        "<p>End.</p>",
    ))
    .unwrap();
    let mut map: alignment::SyncMap = serde_json::from_value(serde_json::json!({"version":2,"precision":"sentence","fragments":[{"startSeconds":1.0,"endSeconds":2.0,"href":"text/ch1.xhtml","text":"A 🦊 waved.","words":[[1.0,1.4,2,2]]}]})).unwrap();
    assert!(validate_map(&map, &epub, 30.0).is_ok());
    map.fragments[0].words[0].2 = 3;
    map.fragments[0].words[0].3 = 1;
    assert!(validate_map(&map, &epub, 30.0).is_err());
}

#[test]
fn normalization_matches_the_reader_whitespace_and_soft_hyphen_rules() {
    assert_eq!(normalize_text("  A\u{00ad}B\u{feff}\u{a0}C  "), "ab c");
    assert_eq!(normalize_text("A\u{0085}B"), "a\u{0085}b");
}

#[test]
fn sharing_does_not_copy_unknown_private_map_annotations() {
    let mut map = serde_json::to_value(Fixture::map()).unwrap();
    assert!(parse_share_map(&serde_json::to_vec(&map).unwrap()).is_ok());
    map["ownerNotes"] = serde_json::json!("private annotation");
    assert!(parse_share_map(&serde_json::to_vec(&map).unwrap()).is_err());
    map.as_object_mut().unwrap().remove("ownerNotes");
    map["fragments"][0]["localPath"] = serde_json::json!("private path");
    assert!(parse_share_map(&serde_json::to_vec(&map).unwrap()).is_err());
}

#[test]
fn recipient_boundaries_reject_overlaps_overruns_and_unknown_precision() {
    let epub = alignment::parse_epub(&alignment::build_test_epub()).unwrap();
    let mut map = Fixture::map();
    map.fragments[1].start_seconds = 1.5;
    assert!(validate_map(&map, &epub, 30.0).is_err());
    let mut map = Fixture::map();
    map.fragments[1].start_seconds = map.fragments[0].end_seconds;
    map.fragments[1].end_seconds = 30.0;
    assert!(validate_map(&map, &epub, 30.0).is_ok());
    map.fragments[1].end_seconds = 30.0001;
    assert!(validate_map(&map, &epub, 30.0).is_err());
    let mut map = Fixture::map();
    map.fragments[0].words[0].1 = map.fragments[0].end_seconds + 0.0001;
    assert!(validate_map(&map, &epub, 30.0).is_err());
    let mut map = Fixture::map();
    map.recovery_gaps.push(alignment::RecoveryGap {
        start_seconds: 29.0,
        end_seconds: 30.0001,
    });
    assert!(validate_map(&map, &epub, 30.0).is_err());
    let mut map = Fixture::map();
    map.precision = None;
    assert!(validate_map(&map, &epub, 30.0).is_err());
    map.version = 1;
    assert!(validate_map(&map, &epub, 30.0).is_ok());
}

#[test]
fn recipient_href_rules_apply_even_when_epub_and_map_match() {
    for unsafe_href in [
        "https://outside.invalid/chapter",
        "/chapter.xhtml",
        "a\\b.xhtml",
        "text/raw space.xhtml",
        "text/ch.xhtml?query",
        "../chapter.xhtml",
        "%2e%2e/chapter.xhtml",
        "text/%2e/chapter.xhtml",
        "text//chapter.xhtml",
        "text/%2fchapter.xhtml",
        "text/%5cchapter.xhtml",
        "text/%3achapter.xhtml",
        "text/%00chapter.xhtml",
        "text/%ffchapter.xhtml",
        "text/%x0.xhtml",
        "#only",
    ] {
        let mut epub = alignment::parse_epub(&alignment::build_test_epub()).unwrap();
        let mut map = Fixture::map();
        epub.sections[0].href = unsafe_href.into();
        map.fragments[0].href = unsafe_href.into();
        assert!(validate_map(&map, &epub, 30.0).is_err(), "{unsafe_href}");
    }
    assert!(safe_map_href("text/Chapter%20One.xhtml#paragraph"));
    assert!(safe_map_href("text/%f0%9f%a6%8a.xhtml"));
    assert!(!safe_map_href(&"a".repeat(2049)));
}
