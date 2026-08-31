//! Unit tests extracted from main.rs.

use super::{
    AuthUser, HeaderMap, HeaderValue, LoginThrottle, Session, StatusCode, bytes_etag,
    can_access_book, clamped_track_position, clean_imported_title, composer_narrator,
    if_none_match_matches, is_supported_audio_file, libation_cover_art_url, media_content_type,
    normalize_asin, normalize_guessed_asin, parse_origin_list, parse_range,
    progress_write_is_stale, progress_write_is_suspect_reset,
    progress_write_is_unintentional_regression, sanitize_filename, walk_audio_files_checked,
};

#[test]
fn a_composer_names_the_narrator_only_when_another_tag_names_the_author() {
    use lofty::tag::{ItemKey, Tag, TagType};

    let mut tag = Tag::new(TagType::Mp4Ilst);
    tag.insert_text(ItemKey::Composer, "Rob Inglis".to_string());

    assert_eq!(
        composer_narrator(&tag, Some("J. R. R. Tolkien")),
        Some("Rob Inglis".to_string())
    );
    // With no other credit the composer is the author, so it is not a
    // narrator as well.
    assert_eq!(composer_narrator(&tag, None), None);
    assert_eq!(composer_narrator(&tag, Some("Rob Inglis")), None);
    assert_eq!(
        composer_narrator(&Tag::new(TagType::Mp4Ilst), Some("Anyone")),
        None
    );
}

#[test]
fn near_zero_writes_over_real_progress_are_suspect_resets() {
    // A client that failed to restore pushes ~0 over hours of progress.
    assert!(progress_write_is_suspect_reset(7200.0, 0.0, false));
    assert!(progress_write_is_suspect_reset(7200.0, 45.0, false));
    // A deliberate restart is flagged by the client and accepted.
    assert!(!progress_write_is_suspect_reset(7200.0, 0.0, true));
    // Ordinary rewinds past the near-zero band are not resets.
    assert!(!progress_write_is_suspect_reset(7200.0, 3600.0, false));
    // A book that has barely started cannot lose substantial progress.
    assert!(!progress_write_is_suspect_reset(90.0, 0.0, false));
}

#[test]
fn late_automatic_checkpoints_cannot_rollback_completion() {
    assert!(progress_write_is_unintentional_regression(
        36_000.0, 35_990.0, false
    ));
    assert!(!progress_write_is_unintentional_regression(
        36_000.0, 35_990.0, true
    ));
    // Sub-second decoder jitter around a pause is harmless.
    assert!(!progress_write_is_unintentional_regression(
        36_000.0, 35_999.25, false
    ));
}

#[test]
fn fuzz_automatic_progress_never_moves_materially_backward() {
    let mut state = 0x9e37_79b9_7f4a_7c15_u64;
    for _ in 0..100_000 {
        // Deterministic property-style stress without another test-only
        // dependency. Cover positions across very short and very long
        // audiobooks plus arbitrary request reordering gaps.
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let previous = (state % 2_000_000) as f64 / 10.0;
        state = state.rotate_left(17) ^ 0xa076_1d64_78bd_642f;
        let regression = 2.01 + (state % 500_000) as f64 / 100.0;
        let incoming = (previous - regression).max(0.0);
        if previous - incoming > 2.0 {
            assert!(progress_write_is_unintentional_regression(
                previous, incoming, false
            ));
            assert!(!progress_write_is_unintentional_regression(
                previous, incoming, true
            ));
        }
    }
}

#[test]
fn fuzz_track_positions_stay_inside_known_media() {
    let mut state = 0xd1b5_4a32_d192_ed03_u64;
    for _ in 0..100_000 {
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        let duration = 0.01 + (state % 1_000_000) as f64 / 10.0;
        state = state.wrapping_mul(2_685_821_657_736_338_717);
        let reported = (state % 4_000_000) as f64 / 10.0 - 100_000.0;
        let clamped = clamped_track_position(reported, Some(duration));
        assert!(clamped >= 0.0);
        assert!(clamped <= duration);
    }
}

fn track_with_duration(id: &str, index: usize, duration_seconds: Option<f64>) -> super::Track {
    super::Track {
        id: id.to_string(),
        title: id.to_string(),
        file_name: format!("{id}.mp3"),
        index,
        duration_seconds,
        stream_url: String::new(),
        chapters: Vec::new(),
        metadata: Default::default(),
    }
}

fn book_with_tracks(duration_seconds: Option<f64>, tracks: Vec<super::Track>) -> super::Book {
    super::Book {
        id: "book".to_string(),
        title: "Book".to_string(),
        author: None,
        narrator: None,
        duration_seconds,
        track_count: tracks.len(),
        cover_art_url: None,
        description: None,
        genres: Vec::new(),
        published_date: None,
        asin: None,
        reading_file: None,
        sync_file: None,
        chapters: Vec::new(),
        metadata: Default::default(),
        tracks,
        progress: None,
        shared_progress: Vec::new(),
        volume_gain: super::BOOK_VOLUME_GAIN_DEFAULT,
    }
}

/// A gain arrives from whatever client the listener is holding, so the
/// server is the only place that can keep a hand-edited or buggy value from
/// becoming an eardrum-splitting multiplier on every other device.
#[test]
fn a_book_volume_gain_is_clamped_to_the_supported_range() {
    assert_eq!(super::clamp_book_volume_gain(2.5), 2.5);
    assert_eq!(
        super::clamp_book_volume_gain(50.0),
        super::BOOK_VOLUME_GAIN_MAX
    );
    assert_eq!(
        super::clamp_book_volume_gain(-3.0),
        super::BOOK_VOLUME_GAIN_MIN
    );
    assert_eq!(
        super::clamp_book_volume_gain(f64::NAN),
        super::BOOK_VOLUME_GAIN_DEFAULT
    );
}

/// Books nobody has tuned must read back as unity rather than as silence, and
/// a stored value that predates a narrowed range must still be safe to hand to
/// a client. The clamp therefore applies on the way out, not only on the way in.
#[tokio::test]
async fn an_untuned_book_reads_back_at_unity_and_a_stored_extreme_is_clamped() {
    let root = tempfile::tempdir().unwrap();
    let database = super::Database::open(&root.path().join("operalibre.db")).unwrap();
    let settings = super::BookSettingsStore::new(database.clone());

    settings.set_gain("reader", "quiet", 2.0).await.unwrap();
    // Written straight past the store, the way an older release or a hand
    // edit would have left it.
    database
        .call(|connection| {
            connection.execute(
                "INSERT INTO book_settings (user_id, book_id, volume_gain)
                 VALUES ('reader', 'loud', 99.0)",
                [],
            )
        })
        .await
        .unwrap();

    assert_eq!(
        settings.gain("reader", "untouched").await.unwrap(),
        super::BOOK_VOLUME_GAIN_DEFAULT
    );
    assert_eq!(settings.gain("reader", "quiet").await.unwrap(), 2.0);
    assert_eq!(
        settings.gain("reader", "loud").await.unwrap(),
        super::BOOK_VOLUME_GAIN_MAX,
        "a stored gain above the supported range reached a client"
    );

    let listed = settings.list_for_user("reader").await.unwrap();
    assert_eq!(listed.get("loud"), Some(&super::BOOK_VOLUME_GAIN_MAX));
    assert_eq!(listed.get("quiet"), Some(&2.0));
    assert!(!listed.contains_key("untouched"));
}

/// lofty reports Duration::ZERO for media it cannot measure. Treating that
/// as a known zero-length book clamps the stored position to 0 and reports
/// the book as not started — and the library summary is what a reinstalled
/// client resumes from when /progress is unavailable.
#[test]
fn an_unmeasurable_book_does_not_report_its_position_as_zero() {
    let book = book_with_tracks(
        Some(0.0),
        vec![
            track_with_duration("t1", 0, Some(0.0)),
            track_with_duration("t2", 1, Some(0.0)),
        ],
    );
    let stored = super::Progress {
        book_id: String::new(),
        track_id: "t2".to_string(),
        position_seconds: 1_800.0,
        book_position_seconds: 7_200.0,
        duration_seconds: None,
        updated_at: "1785801600".to_string(),
        finished_override: None,
    };

    let summary = super::summarize_book_progress(&book, &stored);
    assert_eq!(summary.book_position_seconds, 7_200.0);
    assert_eq!(summary.duration_seconds, None);
    assert!(matches!(
        summary.status,
        super::BookProgressStatus::InProgress
    ));
}

#[test]
fn a_partial_duration_cannot_falsely_finish_a_book() {
    let book = book_with_tracks(
        None,
        vec![
            track_with_duration("t1", 0, Some(3_600.0)),
            track_with_duration("t2", 1, None),
        ],
    );
    let stored = super::Progress {
        book_id: String::new(),
        track_id: "t2".to_string(),
        position_seconds: 600.0,
        book_position_seconds: 4_200.0,
        duration_seconds: None,
        updated_at: "1785801600000".to_string(),
        finished_override: None,
    };

    let summary = super::summarize_book_progress(&book, &stored);
    assert_eq!(summary.book_position_seconds, 4_200.0);
    assert_eq!(summary.duration_seconds, None);
    assert!(matches!(
        summary.status,
        super::BookProgressStatus::InProgress
    ));
}

/// With every duration unknown the server cannot derive an offset, so the
/// client's reported whole-book position must be trusted — otherwise every
/// track collapses onto the same offset and advancing looks like a
/// regression the write guard then rejects.
#[test]
fn unknown_durations_keep_each_track_at_a_distinct_whole_book_offset() {
    let book = book_with_tracks(
        None,
        vec![
            track_with_duration("t1", 0, None),
            track_with_duration("t2", 1, None),
            track_with_duration("t3", 2, None),
        ],
    );
    let third = &book.tracks[2];

    let derived = super::validated_book_position_seconds(&book, third, 30.0, Some(7_230.0));
    assert_eq!(derived, 7_230.0);
    // And that position must not then read as a regression from track one.
    assert!(!super::progress_write_is_unintentional_regression(
        3_600.0, derived, false
    ));
}

#[test]
fn fuzz_accepted_progress_revisions_are_strictly_monotonic() {
    let mut state = 0x2545_f491_4f6c_dd1d_u64;
    let mut previous = super::Progress {
        book_id: String::new(),
        track_id: String::new(),
        position_seconds: 0.0,
        book_position_seconds: 0.0,
        duration_seconds: None,
        updated_at: "1785801600".to_string(),
        finished_override: None,
    };
    for _ in 0..200_000 {
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        let now = 1_785_801_600_000 + state % 10_000;
        let next = super::next_progress_timestamp(Some(&previous), now);
        assert!(
            super::progress_timestamp_millis(&next)
                > super::progress_timestamp_millis(&previous.updated_at)
        );
        previous.updated_at = next;
    }
}

#[test]
fn stale_progress_writes_are_detected_with_clock_slack() {
    // A replayed checkpoint from hours before the stored copy is stale.
    assert!(progress_write_is_stale("1753200000", 1753100000.0));
    // Ordinary clock skew between devices must not block saves.
    assert!(!progress_write_is_stale("1753200000", 1753199800.0));
    // Newer writes always pass.
    assert!(!progress_write_is_stale("1753200000", 1753200050.0));
    // Unparsable stored stamps never block a write.
    assert!(!progress_write_is_stale("2025-07-11T01:00:00.000Z", 0.0));
}

#[test]
fn book_access_defaults_to_full_library_and_honors_restrictions() {
    let unrestricted = AuthUser {
        id: "reader".to_string(),
        username: "reader".to_string(),
        is_admin: false,
        is_owner: false,
        can_approve_libation_requests: false,
        allowed_book_ids: None,
        libation_access: super::LibationAccess::Approval,
        share_progress: true,
        announce_finishes: true,
        notify_finishes: true,
    };
    assert!(can_access_book(&unrestricted, "book-a"));

    let restricted = AuthUser {
        allowed_book_ids: Some(vec!["book-a".to_string()]),
        ..unrestricted.clone()
    };
    assert!(can_access_book(&restricted, "book-a"));
    assert!(!can_access_book(&restricted, "book-b"));

    let admin = AuthUser {
        is_admin: true,
        allowed_book_ids: Some(Vec::new()),
        ..unrestricted
    };
    assert!(can_access_book(&admin, "book-b"));
}

#[test]
fn legacy_readers_default_to_per_download_libation_approval() {
    let user: super::User = serde_json::from_value(serde_json::json!({
        "id": "reader",
        "username": "reader",
        "passwordHash": "unused",
        "isAdmin": false,
        "allowedBookIds": null,
        "createdAt": "0"
    }))
    .unwrap();
    assert_eq!(user.libation_access, super::LibationAccess::Approval);
    // Accounts that predate the setting share by default, matching new ones.
    assert!(user.share_progress);
}

#[cfg(test)]
fn sharing_user(id: &str, share_progress: bool) -> super::User {
    super::User {
        id: id.to_string(),
        username: id.to_string(),
        password_hash: "unused".to_string(),
        is_admin: false,
        is_owner: false,
        can_approve_libation_requests: false,
        allowed_book_ids: None,
        libation_access: super::LibationAccess::Approval,
        share_progress,
        announce_finishes: true,
        notify_finishes: true,
        created_at: "0".to_string(),
    }
}

#[cfg(test)]
fn viewer(id: &str, share_progress: bool) -> AuthUser {
    AuthUser {
        id: id.to_string(),
        username: id.to_string(),
        is_admin: false,
        is_owner: false,
        can_approve_libation_requests: false,
        allowed_book_ids: None,
        libation_access: super::LibationAccess::Approval,
        share_progress,
        announce_finishes: true,
        notify_finishes: true,
    }
}

#[test]
fn progress_sharing_is_reciprocal_and_excludes_the_viewer() {
    let users = vec![
        sharing_user("me", true),
        sharing_user("sharer", true),
        sharing_user("private", false),
    ];

    let visible = super::visible_sharers(&users, &viewer("me", true));
    assert_eq!(
        visible,
        vec![("sharer".to_string(), "sharer".to_string())],
        "a sharing viewer sees other sharers, never themselves or opted-out users"
    );

    assert!(
        super::visible_sharers(&users, &viewer("private", false)).is_empty(),
        "opting out of sharing also hides everyone else"
    );
}

#[test]
fn shared_progress_skips_untouched_books_and_leads_with_finishers() {
    let book = book_with_tracks(
        Some(1000.0),
        vec![track_with_duration("track", 0, Some(1000.0))],
    );

    let stored = |position: f64| super::Progress {
        book_id: "book".to_string(),
        track_id: "track".to_string(),
        position_seconds: position,
        book_position_seconds: position,
        duration_seconds: Some(1000.0),
        updated_at: "1".to_string(),
        finished_override: None,
    };

    let mut saved = std::collections::HashMap::new();
    saved.insert(super::progress_key("halfway", "book"), stored(500.0));
    saved.insert(super::progress_key("done", "book"), stored(1000.0));
    // A row exists as soon as a book is opened; it must not read as reading.
    saved.insert(super::progress_key("opened", "book"), stored(0.0));

    let sharers = vec![
        ("halfway".to_string(), "Halfway".to_string()),
        ("opened".to_string(), "Opened".to_string()),
        ("done".to_string(), "Done".to_string()),
    ];
    let shared = super::collect_shared_progress(&book, &saved, &sharers);

    let names: Vec<&str> = shared.iter().map(|entry| entry.username.as_str()).collect();
    assert_eq!(names, vec!["Done", "Halfway"]);
    assert_eq!(shared[0].status, super::BookProgressStatus::Finished);
    assert_eq!(shared[1].status, super::BookProgressStatus::InProgress);
    assert_eq!(shared[1].percent_complete, Some(50.0));
}

#[test]
fn legacy_permissions_promote_the_first_admin_to_owner() {
    let mut store: super::UsersStore = serde_json::from_value(serde_json::json!({
        "users": [
            { "id": "first", "username": "first", "passwordHash": "unused", "isAdmin": true, "createdAt": "0" },
            { "id": "second", "username": "second", "passwordHash": "unused", "isAdmin": true, "createdAt": "1" }
        ]
    }))
    .unwrap();

    assert!(super::migrate_users_permissions(&mut store));
    assert_eq!(store.permissions_version, 1);
    assert!(store.users[0].is_owner);
    assert!(!store.users[1].is_owner);
    assert!(
        store
            .users
            .iter()
            .all(|user| user.can_approve_libation_requests)
    );
    assert!(
        store
            .users
            .iter()
            .all(|user| user.libation_access == super::LibationAccess::Direct)
    );
    assert!(!super::migrate_users_permissions(&mut store));
}

#[test]
fn interrupted_libation_approvals_return_to_pending() {
    let mut store: super::LibationRequestStore = serde_json::from_value(serde_json::json!({
        "requests": [
            {
                "id": "request-1",
                "userId": "reader",
                "username": "reader",
                "asin": "B000TEST10",
                "title": "Interrupted",
                "status": "approved",
                "requestedAt": "1",
                "decidedAt": "2",
                "decidedBy": "owner",
                "jobId": "job-1"
            },
            {
                "id": "request-2",
                "userId": "reader",
                "username": "reader",
                "asin": "B000TEST11",
                "title": "Finished",
                "status": "completed",
                "requestedAt": "1",
                "decidedAt": "2",
                "decidedBy": "owner",
                "jobId": "job-2"
            }
        ]
    }))
    .unwrap();

    assert!(super::recover_interrupted_libation_requests(&mut store));
    assert_eq!(store.requests[0].status, "pending");
    assert!(store.requests[0].decided_at.is_none());
    assert!(store.requests[0].decided_by.is_none());
    assert!(store.requests[0].job_id.is_none());
    assert_eq!(store.requests[1].status, "completed");
    assert!(!super::recover_interrupted_libation_requests(&mut store));
}

#[test]
fn libation_cover_urls_accept_amazon_picture_ids_only() {
    assert_eq!(
        libation_cover_art_url(Some("51Ab+cD._SX50_")),
        Some("/api/libation/covers/51Ab+cD._SX50_".to_string())
    );
    assert_eq!(libation_cover_art_url(Some("../Settings.json")), None);
    assert_eq!(
        libation_cover_art_url(Some("https://example.com/cover")),
        None
    );
    assert_eq!(libation_cover_art_url(None), None);
    assert_eq!(
        super::libation_cover_art_url_from_ids(
            Some("https://example.com/invalid-large-cover"),
            Some("51FallbackCover")
        ),
        Some("/api/libation/covers/51FallbackCover".to_string())
    );
}

#[test]
fn upload_names_cannot_escape_the_library_folder() {
    assert_eq!(
        sanitize_filename("../../Dune: Part One"),
        "_.._Dune_ Part One"
    );
    assert_eq!(sanitize_filename("..."), "audiobook");
    assert!(!sanitize_filename("../book").contains('/'));
    assert!(!sanitize_filename("..\\book").contains('\\'));
}

#[test]
fn audiobook_upload_accepts_only_scannable_audio_extensions() {
    assert!(is_supported_audio_file(super::FsPath::new("Book.M4B")));
    assert!(is_supported_audio_file(super::FsPath::new("01.mp3")));
    assert!(!is_supported_audio_file(super::FsPath::new("book.epub")));
    assert!(!is_supported_audio_file(super::FsPath::new("payload.exe")));
}

#[test]
fn library_scan_ignores_incomplete_upload_staging_folders() {
    let root = tempfile::tempdir().unwrap();
    let complete = root.path().join("Complete Book");
    let staging = root
        .path()
        .join(format!("{}test", super::UPLOAD_STAGING_PREFIX));
    std::fs::create_dir_all(&complete).unwrap();
    std::fs::create_dir_all(&staging).unwrap();
    std::fs::write(complete.join("book.m4b"), b"complete").unwrap();
    std::fs::write(staging.join("partial.m4b"), b"partial").unwrap();

    let files = walk_audio_files_checked(root.path()).files;
    assert_eq!(files, vec![complete.join("book.m4b")]);
}

#[test]
fn library_scan_ignores_faststart_work_files() {
    let root = tempfile::tempdir().unwrap();
    let book = root.path().join("Book");
    std::fs::create_dir_all(&book).unwrap();
    std::fs::write(book.join("book.m4b"), b"real").unwrap();
    // A conversion in flight writes these beside the book, and the
    // temporary remux deliberately carries the book's own extension.
    std::fs::write(
        book.join(format!("{}abcd1234.m4b", super::faststart::TEMP_PREFIX)),
        b"half written",
    )
    .unwrap();
    std::fs::write(
        book.join(format!("{}backup-abcd1234", super::faststart::TEMP_PREFIX)),
        b"backup link",
    )
    .unwrap();

    let files = walk_audio_files_checked(root.path()).files;
    assert_eq!(files, vec![book.join("book.m4b")]);
}

/// An M4B keeps its artwork in the `covr` atom, which has no `ItemKey` of
/// its own. lofty 0.25.0 dropped every unmapped atom while flattening the
/// iTunes tag, so covers silently disappeared from the whole library on a
/// rescan while titles and durations still read fine — the only visible
/// artwork left was whatever a device had already downloaded.
#[test]
fn m4b_cover_art_survives_the_tag_read() {
    let Some(tools) = super::faststart::discover_tools(None, None) else {
        eprintln!("skipping: ffmpeg is not installed");
        return;
    };
    let root = tempfile::tempdir().unwrap();
    let book = root.path().join("book.m4b");
    let created = std::process::Command::new(&tools.ffmpeg)
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=3",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=64x64:d=1",
            "-map",
            "0:a",
            "-map",
            "1:v",
            "-c:a",
            "aac",
            "-c:v",
            "mjpeg",
            "-frames:v",
            "1",
            "-disposition:v",
            "attached_pic",
        ])
        .arg(&book)
        .status()
        .expect("ffmpeg should run");
    assert!(created.success());

    let cover = super::read_track_metadata(&book)
        .cover_art
        .expect("the embedded cover should be read back");
    assert_eq!(cover.mime_type, "image/jpeg");
    assert!(!cover.data.is_empty());
}

#[test]
fn clean_imported_title_strips_trailing_audible_asin() {
    assert_eq!(clean_imported_title("Dune [B002V1OF70]"), "Dune");
    assert_eq!(clean_imported_title("Dune (B002V1OF70)"), "Dune");
    assert_eq!(clean_imported_title("Dune - [B002V1OF70]"), "Dune");
}

#[test]
fn clean_imported_title_keeps_non_asin_brackets() {
    assert_eq!(
        clean_imported_title("Dune [Unabridged]"),
        "Dune [Unabridged]"
    );
    assert_eq!(clean_imported_title("[B002V1OF70]"), "[B002V1OF70]");
}

#[test]
fn libation_sidecar_supplies_series_and_catalog_metadata() {
    let sidecar = super::parse_libation_sidecar(
        r#"{
            "product": {
                "title": "The Way of Kings",
                "asin": "B003ZWFO7E",
                "authors": [{ "name": "Brandon Sanderson" }],
                "narrators": [{ "name": "Michael Kramer" }, { "name": "Kate Reading" }],
                "publisher_summary": "A storm is coming.",
                "publisher_name": "Macmillan Audio",
                "category_ladders": [{ "ladder": [{ "name": "Fantasy" }]}],
                "series": [{ "title": "The Stormlight Archive", "sequence": "1" }]
            }
        }"#,
    )
    .expect("valid Libation sidecar");

    assert_eq!(sidecar.title.as_deref(), Some("The Way of Kings"));
    assert_eq!(sidecar.asin.as_deref(), Some("B003ZWFO7E"));
    assert_eq!(sidecar.author.as_deref(), Some("Brandon Sanderson"));
    assert_eq!(
        sidecar.narrator.as_deref(),
        Some("Michael Kramer, Kate Reading")
    );
    assert_eq!(
        sidecar.summary.series.as_deref(),
        Some("The Stormlight Archive")
    );
    assert_eq!(sidecar.summary.series_position.as_deref(), Some("1"));
    assert_eq!(sidecar.summary.genres, vec!["Fantasy"]);
}

#[test]
fn libation_sidecar_is_only_claimed_by_the_book_it_names() {
    let root = tempfile::tempdir().expect("temp dir");
    let sidecar = |asin: &str| {
        format!(r#"{{ "product": {{ "title": "Sidecar {asin}", "asin": "{asin}" }} }}"#)
    };

    // Two loose single-file books sharing `library_root` with one sidecar.
    std::fs::write(root.path().join("Other [B003ZWFO7E].m4b"), b"").unwrap();
    std::fs::write(
        root.path().join("Other [B003ZWFO7E].metadata.json"),
        sidecar("B003ZWFO7E"),
    )
    .unwrap();
    let unrelated = root.path().join("Unrelated.m4b");
    std::fs::write(&unrelated, b"").unwrap();

    assert!(
        super::libation_sidecar_for_group(&unrelated, std::slice::from_ref(&unrelated)).is_none(),
        "a loose book must not adopt a neighbour's Libation record"
    );

    let named = root.path().join("Other [B003ZWFO7E].m4b");
    assert_eq!(
        super::libation_sidecar_for_group(&named, std::slice::from_ref(&named))
            .and_then(|found| found.asin),
        Some("B003ZWFO7E".to_string())
    );

    // A folder book still adopts the single sidecar beside its tracks even
    // when neither name carries an ASIN.
    let folder = root.path().join("Renamed Book");
    std::fs::create_dir(&folder).unwrap();
    let track = folder.join("part 1.m4b");
    std::fs::write(&track, b"").unwrap();
    std::fs::write(folder.join("audible.metadata.json"), sidecar("B002V1OF70")).unwrap();
    assert_eq!(
        super::libation_sidecar_for_group(&folder, std::slice::from_ref(&track))
            .and_then(|found| found.asin),
        Some("B002V1OF70".to_string())
    );
}

#[test]
fn mpeg4_audio_is_served_as_the_registered_container_type() {
    for name in ["book.m4b", "book.m4a", "book.mp4", "BOOK.M4B"] {
        assert_eq!(
            media_content_type(super::FsPath::new(name)),
            "audio/mp4",
            "{name} should not be served as an unregistered or video type"
        );
    }
}

#[test]
fn other_media_extensions_keep_the_guessed_type() {
    assert_eq!(
        media_content_type(super::FsPath::new("book.mp3")),
        "audio/mpeg"
    );
    assert_eq!(
        media_content_type(super::FsPath::new("book.flac")),
        "audio/flac"
    );
    assert_eq!(
        media_content_type(super::FsPath::new("book.epub")),
        "application/epub+zip"
    );
    assert_eq!(
        media_content_type(super::FsPath::new("book.unknown")),
        "application/octet-stream"
    );
}

#[test]
fn parse_range_handles_common_forms() {
    assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
    assert_eq!(parse_range("bytes=500-", 1000), Some((500, 999)));
    assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
    assert_eq!(parse_range("bytes=0-4999", 1000), Some((0, 999)));
}

#[test]
fn parse_range_rejects_unsatisfiable_ranges() {
    assert_eq!(parse_range("bytes=-0", 1000), None);
    assert_eq!(parse_range("bytes=1000-", 1000), None);
    assert_eq!(parse_range("bytes=5-2", 1000), None);
    assert_eq!(parse_range("items=0-99", 1000), None);
    assert_eq!(parse_range("bytes=abc-def", 1000), None);
}

#[tokio::test]
async fn invalid_requested_range_returns_416_with_file_size() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("audio.mp3");
    std::fs::write(&path, vec![0_u8; 1000]).unwrap();
    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::RANGE,
        HeaderValue::from_static("bytes=1000-"),
    );

    let response = super::serve_file_response(&path, &[root.path()], headers, None)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(
        response.headers()[axum::http::header::CONTENT_RANGE],
        "bytes */1000"
    );
}

#[tokio::test]
async fn empty_file_without_range_returns_empty_200() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("empty.txt");
    std::fs::write(&path, []).unwrap();

    let response = super::serve_file_response(&path, &[root.path()], HeaderMap::new(), None)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[axum::http::header::CONTENT_LENGTH], "0");
}

#[test]
fn suffix_range_longer_than_file_starts_at_zero() {
    assert_eq!(parse_range("bytes=-5000", 1000), Some((0, 999)));
}

#[test]
fn contained_file_open_accepts_regular_files_and_rejects_outside_files() {
    let approved = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let inside_path = approved.path().join("track.mp3");
    let outside_path = outside.path().join("secret.txt");
    std::fs::write(&inside_path, b"audio").unwrap();
    std::fs::write(&outside_path, b"secret").unwrap();

    let roots = [approved.path().to_path_buf()];
    let (_, metadata) = super::open_contained_file(&inside_path, &roots).unwrap();
    assert_eq!(metadata.len(), 5);
    assert!(super::open_contained_file(&outside_path, &roots).is_err());
}

#[cfg(unix)]
#[test]
fn contained_file_open_rejects_post_scan_symlink_substitution() {
    use std::os::unix::fs::symlink;

    let approved = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let cached_path = approved.path().join("track.mp3");
    let secret_path = outside.path().join("secret.txt");
    std::fs::write(&cached_path, b"audio").unwrap();
    std::fs::write(&secret_path, b"secret").unwrap();

    std::fs::remove_file(&cached_path).unwrap();
    symlink(&secret_path, &cached_path).unwrap();

    let roots = [approved.path().to_path_buf()];
    assert!(super::open_contained_file(&cached_path, &roots).is_err());
}

#[test]
fn activity_delta_ignores_seeks_and_caps_impossible_movement() {
    let previous = super::Progress {
        book_id: "book".to_string(),
        track_id: "track".to_string(),
        position_seconds: 100.0,
        book_position_seconds: 100.0,
        duration_seconds: Some(1000.0),
        updated_at: "1000".to_string(),
        finished_override: None,
    };
    let saved = super::Progress {
        position_seconds: 700.0,
        book_position_seconds: 700.0,
        updated_at: "1002".to_string(),
        ..previous.clone()
    };

    assert_eq!(
        super::plausible_listened_delta(Some(&previous), &saved, true),
        0.0
    );
    assert_eq!(
        super::plausible_listened_delta(Some(&previous), &saved, false),
        9.2
    );
    assert_eq!(super::plausible_listened_delta(None, &saved, false), 0.0);
}

#[test]
fn restarting_a_finished_book_clears_the_completion_override() {
    let finished = super::Progress {
        book_id: "book".to_string(),
        track_id: "track".to_string(),
        position_seconds: 3_600.0,
        book_position_seconds: 3_600.0,
        duration_seconds: Some(3_600.0),
        updated_at: "1000".to_string(),
        finished_override: Some(true),
    };

    // A deliberate jump back to the opening is a re-listen.
    assert_eq!(
        super::carried_finished_override(Some(&finished), 4.0, true),
        None
    );
    // Ordinary playback reports near zero cannot erase the choice, and a
    // deliberate seek elsewhere in the book keeps it.
    assert_eq!(
        super::carried_finished_override(Some(&finished), 4.0, false),
        Some(true)
    );
    assert_eq!(
        super::carried_finished_override(Some(&finished), 1_800.0, true),
        Some(true)
    );
    // An explicit "unfinished" is never turned back into "no choice".
    let unfinished = super::Progress {
        finished_override: Some(false),
        ..finished
    };
    assert_eq!(
        super::carried_finished_override(Some(&unfinished), 4.0, true),
        Some(false)
    );
}

#[test]
fn explicit_completion_overrides_position_without_moving_it() {
    assert!(matches!(
        super::book_progress_status(Some(1000.0), Some(900.0), 100.0, Some(true)),
        super::BookProgressStatus::Finished
    ));
    assert!(matches!(
        super::book_progress_status(Some(1000.0), Some(0.0), 1000.0, Some(false)),
        super::BookProgressStatus::InProgress
    ));
    assert!(matches!(
        super::book_progress_status(Some(1000.0), Some(0.0), 1000.0, None),
        super::BookProgressStatus::Finished
    ));
}

/// Older stores opened with a synthetic "everything before tracking started"
/// bucket, estimated from how far into each book a reader had reached. It
/// conflated ground covered with time spent listening, so it must not survive
/// the move into the database either.
#[test]
fn the_legacy_position_estimate_is_dropped_when_an_installation_is_imported() {
    let root = tempfile::tempdir().unwrap();
    let layout = legacy_data_dir(root.path());
    let data_dir = root.path().join("data");
    std::fs::write(
        &layout.activity,
        serde_json::json!({
            "reader": {
                "2026-07-23": 600.0,
                // Fifty hours the reader never demonstrably spent listening.
                super::ACTIVITY_BASELINE_KEY: 180_000.0,
            }
        })
        .to_string(),
    )
    .unwrap();

    let database_path = data_dir.join("operalibre.db");
    super::migrate_if_needed(&database_path, &data_dir, &layout).unwrap();

    let connection = super::db::open(&database_path).unwrap();
    let store = super::read_activity_rows(&connection).unwrap();
    let reader = &store.by_user["reader"];
    assert_eq!(reader.len(), 1);
    assert_eq!(reader["2026-07-23"], 600.0);
    assert!(!reader.contains_key(super::ACTIVITY_BASELINE_KEY));
}

#[test]
fn reached_position_never_exceeds_the_books_real_length() {
    let book = book_with_tracks(
        Some(3_600.0),
        vec![track_with_duration("track", 0, Some(3_600.0))],
    );
    let progress = super::Progress {
        book_id: book.id.clone(),
        track_id: "track".to_string(),
        position_seconds: 3_600.0,
        // A client that reported a whole-book position for a book whose
        // track durations it could not read. Left unclamped this alone
        // would add ten hours to the all-time total, permanently.
        book_position_seconds: 36_000.0,
        duration_seconds: Some(3_600.0),
        updated_at: "1000".to_string(),
        finished_override: None,
    };
    assert_eq!(super::reached_position_seconds(&book, &progress), 3_600.0);

    let negative = super::Progress {
        position_seconds: 0.0,
        book_position_seconds: -50.0,
        ..progress
    };
    assert_eq!(super::reached_position_seconds(&book, &negative), 0.0);
}

#[test]
fn activity_days_follow_the_listeners_clock_not_the_servers() {
    // 2026-08-04T02:30:00Z is still the evening of the 3rd in Los Angeles.
    let utc_evening = 1_785_810_600i64;
    let day_utc = utc_evening.div_euclid(86_400);
    let day_pacific = (utc_evening + -7 * 60 * 60).div_euclid(86_400);
    assert_eq!(super::days_to_ymd(day_utc), "2026-08-04");
    assert_eq!(super::days_to_ymd(day_pacific), "2026-08-03");

    assert_eq!(super::sanitized_tz_offset_minutes(Some(-420)), -420);
    assert_eq!(super::sanitized_tz_offset_minutes(None), 0);
    // Outside the real range of UTC offsets, so the calendar is not moved.
    assert_eq!(super::sanitized_tz_offset_minutes(Some(-100_000)), 0);
    assert_eq!(super::sanitized_tz_offset_minutes(Some(1_440)), 0);
}

#[test]
fn streak_calendar_starts_on_a_monday_and_covers_today() {
    // 2026-08-04 is a Tuesday.
    let today = super::ymd_to_days("2026-08-04").unwrap();
    let calendar = super::build_streak_calendar(&std::collections::BTreeMap::new(), 8, today);

    assert_eq!(calendar.len(), 56);
    // The label column is a fixed Monday-to-Sunday, so every seventh cell
    // starting at zero has to actually be a Monday.
    assert_eq!(calendar[0].date, "2026-06-15");
    for index in (0..56).step_by(7) {
        let day = super::ymd_to_days(&calendar[index].date).unwrap();
        assert_eq!(
            super::weekday_from_monday(day),
            0,
            "{}",
            calendar[index].date
        );
    }
    assert!(calendar.iter().any(|day| day.date == "2026-08-04"));
}

#[test]
fn streaks_are_measured_against_the_listeners_today() {
    let today = super::ymd_to_days("2026-08-04").unwrap();
    let activity = std::collections::BTreeMap::from([
        ("2026-08-02".to_string(), 600.0),
        ("2026-08-03".to_string(), 600.0),
        ("2026-08-04".to_string(), 600.0),
        // Below the 30 second floor, so it neither counts nor bridges.
        ("2026-07-20".to_string(), 10.0),
        ("2026-07-18".to_string(), 600.0),
    ]);
    assert_eq!(super::compute_streaks(&activity, today), (3, 3));

    // A week later the run is over and nothing is current.
    assert_eq!(super::compute_streaks(&activity, today + 7).0, 0);
}

#[test]
fn normalize_asin_accepts_only_audible_ids() {
    assert_eq!(
        normalize_asin(" B002v1of70 "),
        Some("B002V1OF70".to_string())
    );
    // Audible sells plenty of titles under an ISBN-10 rather than a
    // B-prefixed ASIN; these are ordinary owned books, not bad input.
    assert_eq!(normalize_asin("125077795x"), Some("125077795X".to_string()));
    assert_eq!(normalize_asin("1705009050"), Some("1705009050".to_string()));
    assert_eq!(normalize_asin("1234567891"), None);
    assert_eq!(normalize_asin("Unabridged"), None);
    assert_eq!(normalize_asin("B002V1OF7"), None);
    assert_eq!(normalize_asin("B002V1OF701"), None);
    assert_eq!(normalize_asin("B002V1OF7!"), None);
    assert_eq!(normalize_asin("../../etc/pw"), None);
}

#[test]
fn normalize_guessed_asin_still_requires_the_b_prefix() {
    assert_eq!(
        normalize_guessed_asin("B002V1OF70"),
        Some("B002V1OF70".to_string())
    );
    // Ten letters, and a very common file-name suffix.
    assert_eq!(normalize_guessed_asin("Unabridged"), None);
    assert_eq!(normalize_guessed_asin("125077795X"), None);
}

#[test]
fn parse_origin_list_splits_and_normalizes() {
    assert_eq!(
        parse_origin_list("https://a.example/, http://b.example:5173 ,,".to_string()),
        vec![
            "https://a.example".to_string(),
            "http://b.example:5173".to_string()
        ]
    );
    assert!(parse_origin_list("  ".to_string()).is_empty());
}

#[test]
fn if_none_match_recognizes_matching_etags() {
    let etag = bytes_etag(b"cover-bytes");
    assert!(etag.starts_with('"') && etag.ends_with('"'));

    let mut headers = HeaderMap::new();
    headers.insert(super::IF_NONE_MATCH, etag.parse().unwrap());
    assert!(if_none_match_matches(&headers, &etag));

    let mut weak = HeaderMap::new();
    weak.insert(
        super::IF_NONE_MATCH,
        format!("W/{etag}, \"other\"").parse().unwrap(),
    );
    assert!(if_none_match_matches(&weak, &etag));

    let mut star = HeaderMap::new();
    star.insert(super::IF_NONE_MATCH, "*".parse().unwrap());
    assert!(if_none_match_matches(&star, &etag));

    let mut mismatch = HeaderMap::new();
    mismatch.insert(super::IF_NONE_MATCH, "\"different\"".parse().unwrap());
    assert!(!if_none_match_matches(&mismatch, &etag));
    assert!(!if_none_match_matches(&HeaderMap::new(), &etag));
}

#[test]
fn login_throttle_key_is_bounded() {
    let long_name = "A".repeat(10_000);
    let key = super::login_throttle_key(&long_name);
    assert_eq!(
        key.chars().count(),
        "user:".len() + super::LOGIN_THROTTLE_KEY_MAX_CHARS
    );
    assert_eq!(super::login_throttle_key(" Reader "), "user: reader ");
}

#[test]
fn proxy_client_addresses_are_trusted_only_from_loopback() {
    let mut headers = super::HeaderMap::new();
    headers.insert("x-forwarded-for", "127.0.0.1, 203.0.113.8".parse().unwrap());
    assert_eq!(
        super::request_client_ip("127.0.0.1:4000".parse().unwrap(), &headers),
        "203.0.113.8".parse::<std::net::IpAddr>().unwrap()
    );
    assert_eq!(
        super::request_client_ip("198.51.100.4:4000".parse().unwrap(), &headers),
        "198.51.100.4".parse::<std::net::IpAddr>().unwrap()
    );
}

#[test]
fn session_cookies_require_https() {
    let cookie = super::session_cookie("token", true);
    assert!(cookie.contains("; Secure;"));
    assert!(cookie.contains("; HttpOnly;"));
    assert!(cookie.contains("; SameSite=Lax"));

    let lan_cookie = super::session_cookie("token", false);
    assert!(!lan_cookie.contains("; Secure"));
    assert!(lan_cookie.contains("; HttpOnly;"));
}

#[test]
fn cookie_csrf_requires_the_target_or_an_explicit_origin() {
    let mut headers = super::HeaderMap::new();
    headers.insert(super::HOST, "books.example.com".parse().unwrap());
    headers.insert(super::ORIGIN, "https://books.example.com".parse().unwrap());
    assert!(super::cookie_request_origin_allowed(
        &std::collections::HashSet::new(),
        &headers
    ));

    headers.insert(super::ORIGIN, "https://evil.example.com".parse().unwrap());
    assert!(!super::cookie_request_origin_allowed(
        &std::collections::HashSet::new(),
        &headers
    ));

    let configured = std::collections::HashSet::from(["https://reader.example.net".to_string()]);
    headers.insert(super::ORIGIN, "https://reader.example.net".parse().unwrap());
    assert!(super::cookie_request_origin_allowed(&configured, &headers));

    headers.remove(super::ORIGIN);
    assert!(!super::cookie_request_origin_allowed(&configured, &headers));
}

#[test]
fn csrf_origins_always_include_official_apps() {
    let origins = super::build_csrf_allowed_origins(&["HTTPS://Reader.Example.NET/".to_string()]);
    assert!(origins.contains("capacitor://localhost"));
    assert!(origins.contains("http://localhost"));
    assert!(origins.contains("https://reader.example.net"));
}

#[test]
fn password_lengths_are_bounded() {
    assert!(super::validate_password(&"x".repeat(super::MIN_PASSWORD_CHARS)).is_ok());
    assert!(super::validate_password(&"x".repeat(super::MIN_PASSWORD_CHARS - 1)).is_err());
    assert!(super::validate_password(&"x".repeat(super::MAX_PASSWORD_CHARS + 1)).is_err());
}

#[test]
fn deployment_profiles_choose_safe_defaults() {
    assert_eq!(
        super::DeploymentMode::parse("local")
            .unwrap()
            .default_host(),
        "127.0.0.1"
    );
    assert_eq!(
        super::DeploymentMode::parse("lan").unwrap().default_host(),
        "0.0.0.0"
    );
    assert!(
        super::DeploymentMode::parse("proxy")
            .unwrap()
            .secure_cookies()
    );
    assert!(!super::DeploymentMode::Lan.secure_cookies());
    assert!(super::DeploymentMode::Proxy.setup_token_required(false));
    assert!(super::DeploymentMode::Lan.setup_token_required(true));
    assert!(!super::DeploymentMode::Lan.setup_token_required(false));
    assert!(super::DeploymentMode::parse("public").is_err());

    let (legacy_mode, legacy_host) =
        super::resolve_deployment_settings(None, Some("0.0.0.0".to_string())).unwrap();
    assert_eq!(legacy_mode, super::DeploymentMode::Lan);
    assert_eq!(legacy_host, "0.0.0.0");

    let (lan_mode, lan_host) =
        super::resolve_deployment_settings(Some("lan".to_string()), None).unwrap();
    assert_eq!(lan_mode, super::DeploymentMode::Lan);
    assert_eq!(lan_host, "0.0.0.0");

    assert!(
        super::resolve_deployment_settings(Some("proxy".to_string()), Some("0.0.0.0".to_string()))
            .is_err()
    );
}

#[test]
fn setup_tokens_are_bounded_and_expire() {
    let token = super::SetupToken::new("one-time-secret", 100);
    assert!(token.matches("one-time-secret", 100));
    assert!(!token.matches("wrong-secret", 100));
    assert!(!token.matches(
        "one-time-secret",
        100 + super::SETUP_TOKEN_LIFETIME_SECONDS + 1
    ));
}

#[test]
fn transfer_limits_are_configurable_and_bounded() {
    let mut values = std::collections::HashMap::new();
    assert_eq!(
        super::config_gib_limit(&values, "max_upload_gib", 20).unwrap(),
        Some(20 * super::GIBIBYTE_BYTES)
    );

    values.insert("max_upload_gib".to_string(), "0".to_string());
    assert_eq!(
        super::config_gib_limit(&values, "max_upload_gib", 20).unwrap(),
        None
    );
    values.insert("max_upload_gib".to_string(), "2".to_string());
    assert_eq!(
        super::config_gib_limit(&values, "max_upload_gib", 20).unwrap(),
        Some(2 * super::GIBIBYTE_BYTES)
    );

    values.insert(
        "max_concurrent_book_downloads".to_string(),
        "32".to_string(),
    );
    assert_eq!(
        super::config_bounded_usize(&values, "max_concurrent_book_downloads", 1, 1, 32).unwrap(),
        32
    );
    values.insert(
        "max_concurrent_book_downloads".to_string(),
        "33".to_string(),
    );
    assert!(
        super::config_bounded_usize(&values, "max_concurrent_book_downloads", 1, 1, 32).is_err()
    );

    assert!(super::download_volume_has_capacity(30, 20, 10));
    assert!(!super::download_volume_has_capacity(29, 20, 10));
    assert!(!super::download_volume_has_capacity(u64::MAX, u64::MAX, 1));
}

#[test]
fn query_tokens_are_limited_to_read_only_media_routes() {
    use super::Method;

    assert!(super::query_token_allowed(
        &Method::GET,
        "/api/books/book/cover"
    ));
    assert!(super::query_token_allowed(
        &Method::GET,
        "/api/books/book/tracks/track/stream"
    ));
    assert!(super::query_token_allowed(
        &Method::GET,
        "/api/libation/covers/picture"
    ));
    assert!(super::query_token_allowed(&Method::GET, "/api/opds"));
    assert!(super::query_token_allowed(&Method::GET, "/api/opds/books"));
    assert!(super::query_token_allowed(
        &Method::GET,
        "/abs/api/books/book/cover"
    ));
    assert!(super::query_token_allowed(
        &Method::GET,
        "/abs/api/books/book/tracks/track/stream"
    ));
    assert!(!super::query_token_allowed(&Method::GET, "/api/users"));
    assert!(!super::query_token_allowed(
        &Method::DELETE,
        "/api/books/book/download"
    ));
}

#[test]
fn media_credentials_are_distinct_from_session_credentials() {
    let session = "secret-session-token";
    let media = super::media_token_for_session(session);
    assert_ne!(media, session);
    assert_eq!(media, super::media_token_for_session(session));
    assert_ne!(media, super::media_token_for_session("another-session"));
}

#[test]
fn login_throttle_locks_after_max_failures() {
    let now = 10_000;
    let below_limit = LoginThrottle {
        failures: super::LOGIN_MAX_FAILURES - 1,
        last_failure: now,
    };
    assert!(!below_limit.is_locked(now, super::LOGIN_MAX_FAILURES));

    let at_limit = LoginThrottle {
        failures: super::LOGIN_MAX_FAILURES,
        last_failure: now,
    };
    assert!(at_limit.is_locked(now, super::LOGIN_MAX_FAILURES));
    assert!(at_limit.is_locked(
        now + super::LOGIN_LOCKOUT_SECONDS - 1,
        super::LOGIN_MAX_FAILURES
    ));
    assert!(!at_limit.is_locked(
        now + super::LOGIN_LOCKOUT_SECONDS,
        super::LOGIN_MAX_FAILURES
    ));
    assert!(at_limit.is_stale(now + super::LOGIN_LOCKOUT_SECONDS));
}

#[cfg(unix)]
fn fake_libation_state(root: &std::path::Path) -> (super::AppState, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;

    let library_root = root.join("library");
    let data_dir = root.join("data");
    std::fs::create_dir_all(&library_root).unwrap();
    std::fs::create_dir_all(&data_dir).unwrap();
    let audio_template = root.join("template.wav");
    let sample_data = vec![0u8; 160];
    let mut wav = Vec::new();
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36u32 + sample_data.len() as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&8_000u32.to_le_bytes());
    wav.extend_from_slice(&16_000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(sample_data.len() as u32).to_le_bytes());
    wav.extend_from_slice(&sample_data);
    std::fs::write(&audio_template, wav).unwrap();
    assert!(
        super::read_track_metadata(&audio_template)
            .duration_seconds
            .is_some(),
        "test WAV must be readable by the library scanner"
    );
    let log_path = root.join("libation.log");
    let cli_path = root.join("fake-libation.sh");
    let script = format!(
        r#"#!/bin/sh
command="$1"
shift
if [ "$command" = "export" ]; then
  export_path=""
  while [ "$#" -gt 0 ]; do
if [ "$1" = "--path" ]; then
  export_path="$2"
  shift 2
else
  shift
fi
  done
  printf 'start export\n' >> '{log}'
  sleep 0.02
  printf '[]' > "$export_path"
  printf 'end export\n' >> '{log}'
  exit 0
fi
if [ "$command" != "liberate" ]; then
  exit 0
fi
asin=""
books=""
while [ "$#" -gt 0 ]; do
  case "$1" in
--id)
  asin="$2"
  shift 2
  ;;
--override)
  books="${{2#Books=}}"
  shift 2
  ;;
*)
  shift
  ;;
  esac
done
printf 'start %s\n' "$asin" >> '{log}'
sleep 0.08
if [ "$asin" != "B000FAIL00" ]; then
  mkdir -p "$books/Test [$asin]"
  cp '{audio}' "$books/Test [$asin]/Test [$asin].wav"
fi
printf 'end %s\n' "$asin" >> '{log}'
exit 0
"#,
        log = log_path.display(),
        audio = audio_template.display()
    );
    std::fs::write(&cli_path, script).unwrap();
    let mut permissions = std::fs::metadata(&cli_path).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&cli_path, permissions).unwrap();

    let database = super::Database::open(&data_dir.join("operalibre.db")).unwrap();
    let state = super::AppState {
        deployment_mode: super::DeploymentMode::Local,
        csrf_allowed_origins: super::Arc::new(std::collections::HashSet::new()),
        setup_token: super::Arc::new(super::Mutex::new(None)),
        max_upload_bytes: Some(super::DEFAULT_MAX_UPLOAD_GIB * super::GIBIBYTE_BYTES),
        max_book_download_bytes: Some(super::DEFAULT_MAX_BOOK_DOWNLOAD_GIB * super::GIBIBYTE_BYTES),
        download_temp_dir: data_dir.join("download-temp"),
        min_download_free_bytes: super::DEFAULT_MIN_DOWNLOAD_FREE_GIB * super::GIBIBYTE_BYTES,
        library_root: library_root.clone(),
        library_identities_file: data_dir.join("library-identities.json"),
        progress: super::Arc::new(super::ProgressStore::new(database.clone())),
        book_settings: super::Arc::new(super::BookSettingsStore::new(database.clone())),
        libation_accounts_root: data_dir.join("libation-accounts"),
        libation_config: super::LibationConfig {
            cli_path: Some(cli_path),
            libation_files_dir: None,
            library_root,
            auto_refresh_hours: Some(super::DEFAULT_LIBATION_AUTO_REFRESH_HOURS),
            reader_refreshes_per_hour: super::DEFAULT_LIBATION_READER_REFRESHES_PER_HOUR,
        },
        alignment_config: super::AlignmentConfig { cli_path: None },
        faststart_tools: None,
        update_manager: super::updates::UpdateManager::new(data_dir.clone(), None, 4000).unwrap(),
        sync_dir: data_dir.join("sync"),
        covers_dir: data_dir.join("covers"),
        database_path: data_dir.join("operalibre.db"),
        library: super::Arc::new(super::RwLock::new(super::LibraryState::default())),
        metadata_overrides: super::Arc::new(super::MetadataOverrides::new(
            database.clone(),
            super::StoreShape::Document(super::METADATA_OVERRIDES_DOCUMENT),
            super::MetadataOverrideStore::default(),
        )),
        jobs: super::Arc::new(super::RwLock::new(std::collections::HashMap::new())),
        users: super::Arc::new(super::UserStore::new(
            database.clone(),
            super::StoreShape::Users,
            super::UsersStore::default(),
        )),
        sessions: super::Arc::new(super::SessionStore::new(
            database.clone(),
            super::StoreShape::Sessions,
            std::collections::HashMap::new(),
        )),
        activity: super::Arc::new(super::ActivityLog::new(
            database.clone(),
            super::StoreShape::Activity,
            super::ActivityStore::default(),
        )),
        reading_history: super::Arc::new(super::ReadingHistoryStore::new(
            database.clone(),
            super::StoreShape::Document(super::READING_HISTORY_DOCUMENT),
            super::ReadingHistory::default(),
        )),
        open_sessions: super::Arc::new(super::Mutex::new(super::OpenSessions::default())),
        shutdown: tokio::sync::broadcast::channel(1).0,
        works: super::Arc::new(super::WorksStore::new(
            database.clone(),
            super::StoreShape::Document(super::WORKS_DOCUMENT),
            super::WorkStore::default(),
        )),
        libation_requests: super::Arc::new(super::LibationRequests::new(
            database.clone(),
            super::StoreShape::Document(super::LIBATION_REQUESTS_DOCUMENT),
            super::LibationRequestStore::default(),
        )),
        libation_refreshes: super::Arc::new(super::LibationRefreshes::new(
            database.clone(),
            super::StoreShape::Document(super::LIBATION_REFRESHES_DOCUMENT),
            super::LibationRefreshStore::default(),
        )),
        libation_accounts: super::Arc::new(super::LibationAccounts::new(
            database.clone(),
            super::StoreShape::Document(super::LIBATION_ACCOUNTS_DOCUMENT),
            super::ManagedLibationAccountStore::default(),
        )),
        libation_login_sessions: super::Arc::new(super::Mutex::new(
            std::collections::HashMap::new(),
        )),
        rescan_lock: super::Arc::new(super::Mutex::new(())),
        libation_job_lock: super::Arc::new(super::Mutex::new(())),
        libation_refresh_reservation_lock: super::Arc::new(super::Mutex::new(())),
        faststart_lock: super::Arc::new(super::Mutex::new(())),
        login_attempts: super::Arc::new(super::Mutex::new(std::collections::HashMap::new())),
        password_task_slots: super::Arc::new(super::Semaphore::new(
            super::PASSWORD_TASK_CONCURRENCY,
        )),
        download_task_slots: super::Arc::new(super::Semaphore::new(
            super::DEFAULT_MAX_CONCURRENT_BOOK_DOWNLOADS,
        )),
        upload_lock: super::Arc::new(super::Mutex::new(())),
    };
    (state, log_path)
}

#[cfg(unix)]
fn admin_user() -> super::AuthUser {
    super::AuthUser {
        id: "admin".to_string(),
        username: "admin".to_string(),
        is_admin: true,
        is_owner: false,
        can_approve_libation_requests: true,
        allowed_book_ids: None,
        libation_access: super::LibationAccess::Direct,
        share_progress: true,
        announce_finishes: true,
        notify_finishes: true,
    }
}

#[cfg(unix)]
#[cfg(unix)]
fn stored_user(id: &str, is_admin: bool, is_owner: bool) -> super::User {
    super::User {
        id: id.to_string(),
        username: id.to_string(),
        password_hash: "unused".to_string(),
        is_admin: is_admin || is_owner,
        is_owner,
        can_approve_libation_requests: is_owner,
        allowed_book_ids: None,
        libation_access: if is_owner {
            super::LibationAccess::Direct
        } else {
            super::LibationAccess::Approval
        },
        share_progress: true,
        announce_finishes: true,
        notify_finishes: true,
        created_at: "0".to_string(),
    }
}

#[cfg(unix)]
fn approval_reader() -> super::AuthUser {
    super::AuthUser {
        id: "reader".to_string(),
        username: "reader".to_string(),
        is_admin: false,
        is_owner: false,
        can_approve_libation_requests: false,
        allowed_book_ids: None,
        libation_access: super::LibationAccess::Approval,
        share_progress: true,
        announce_finishes: true,
        notify_finishes: true,
    }
}

#[cfg(unix)]
#[tokio::test]
async fn concurrent_first_run_setup_creates_only_one_owner() {
    let root = tempfile::tempdir().unwrap();
    let (state, _) = fake_libation_state(root.path());
    let first = super::setup_admin(
        super::State(state.clone()),
        super::ConnectInfo("127.0.0.1:41001".parse().unwrap()),
        super::HeaderMap::new(),
        super::Json(super::SetupRequest {
            username: "first-owner".to_string(),
            password: "password-one".to_string(),
            setup_token: None,
        }),
    );
    let second = super::setup_admin(
        super::State(state.clone()),
        super::ConnectInfo("127.0.0.1:41002".parse().unwrap()),
        super::HeaderMap::new(),
        super::Json(super::SetupRequest {
            username: "second-owner".to_string(),
            password: "password-two".to_string(),
            setup_token: None,
        }),
    );

    let (first_result, second_result) = tokio::join!(first, second);
    assert_ne!(first_result.is_ok(), second_result.is_ok());
    let users = state.users.read().await;
    assert_eq!(users.users.len(), 1);
    assert!(users.users[0].is_owner);
    assert!(users.users[0].is_admin);
}

#[cfg(unix)]
#[tokio::test]
async fn first_run_setup_rejects_remote_clients() {
    let root = tempfile::tempdir().unwrap();
    let (state, _) = fake_libation_state(root.path());
    let mut headers = super::HeaderMap::new();
    headers.insert("x-forwarded-for", "203.0.113.9".parse().unwrap());
    let result = super::setup_admin(
        super::State(state.clone()),
        super::ConnectInfo("127.0.0.1:41001".parse().unwrap()),
        headers,
        super::Json(super::SetupRequest {
            username: "remote-owner".to_string(),
            password: "a-secure-password".to_string(),
            setup_token: None,
        }),
    )
    .await;
    let error = match result {
        Ok(_) => panic!("remote setup unexpectedly succeeded"),
        Err(error) => error,
    };
    assert_eq!(error.status, super::StatusCode::FORBIDDEN);
    assert!(state.users.read().await.users.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn remote_first_run_setup_requires_the_bootstrap_token() {
    let root = tempfile::tempdir().unwrap();
    let (mut state, _) = fake_libation_state(root.path());
    state.deployment_mode = super::DeploymentMode::Proxy;
    *state.setup_token.lock().await = Some(super::SetupToken::new(
        "one-time-secret",
        super::unix_now_seconds(),
    ));
    let mut headers = super::HeaderMap::new();
    headers.insert("x-forwarded-for", "203.0.113.9".parse().unwrap());

    let result = super::setup_admin(
        super::State(state.clone()),
        super::ConnectInfo("127.0.0.1:41001".parse().unwrap()),
        headers,
        super::Json(super::SetupRequest {
            username: "remote-owner".to_string(),
            password: "a-secure-password".to_string(),
            setup_token: Some("one-time-secret".to_string()),
        }),
    )
    .await;

    assert!(result.is_ok());
    assert!(state.setup_token.lock().await.is_none());
    assert!(state.users.read().await.users[0].is_owner);
}

#[cfg(unix)]
#[tokio::test]
async fn only_owners_can_manage_admin_roles_and_permissions() {
    let root = tempfile::tempdir().unwrap();
    let (state, _) = fake_libation_state(root.path());
    state
        .users
        .mutate(|users| {
            users.users = vec![
                stored_user("owner", true, true),
                stored_user("admin", true, false),
                stored_user("reader", false, false),
            ];
            Ok(())
        })
        .await
        .unwrap();

    let promoted = super::update_user_role(
        super::State(state.clone()),
        super::OwnerUser,
        super::Path("reader".to_string()),
        super::Json(super::UpdateUserRoleRequest {
            is_admin: true,
            is_owner: false,
        }),
    )
    .await
    .unwrap()
    .0;
    assert!(promoted.is_admin);
    assert!(!promoted.is_owner);

    let access_denied = super::update_libation_access(
        super::State(state.clone()),
        super::AdminUser(admin_user()),
        super::Path("reader".to_string()),
        super::Json(super::UpdateLibationAccessRequest {
            libation_access: super::LibationAccess::Direct,
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(access_denied.status, super::StatusCode::FORBIDDEN);

    let approver = super::update_libation_approval(
        super::State(state.clone()),
        super::OwnerUser,
        super::Path("reader".to_string()),
        super::Json(super::UpdateLibationApprovalRequest {
            can_approve_libation_requests: true,
        }),
    )
    .await
    .unwrap()
    .0;
    assert!(approver.can_approve_libation_requests);

    let final_owner = super::update_user_role(
        super::State(state),
        super::OwnerUser,
        super::Path("owner".to_string()),
        super::Json(super::UpdateUserRoleRequest {
            is_admin: true,
            is_owner: false,
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(final_owner.status, super::StatusCode::CONFLICT);
}

#[cfg(unix)]
#[tokio::test]
async fn approval_requests_are_deduplicated_and_can_be_declined() {
    let root = tempfile::tempdir().unwrap();
    let (state, _) = fake_libation_state(root.path());
    let asin = "B000TEST10".to_string();
    let create = || {
        super::create_libation_download_request(
            super::State(state.clone()),
            super::Extension(approval_reader()),
            super::Path(asin.clone()),
            super::Json(super::CreateLibationDownloadRequest {
                title: "Requested title".to_string(),
                profile_id: None,
            }),
        )
    };
    let first = create().await.unwrap().0;
    let second = create().await.unwrap().0;
    assert_eq!(first.id, second.id);
    assert_eq!(state.libation_requests.read().await.requests.len(), 1);

    let declined = super::decide_libation_download_request(
        super::State(state.clone()),
        super::LibationApprover(admin_user()),
        super::Path(first.id),
        super::Json(super::DecideLibationDownloadRequest { approved: false }),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(declined.status, "rejected");
}

#[cfg(unix)]
#[tokio::test]
async fn readers_get_three_libation_refreshes_per_hour_while_admins_are_unlimited() {
    let root = tempfile::tempdir().unwrap();
    let (state, _) = fake_libation_state(root.path());

    for _ in 0..super::DEFAULT_LIBATION_READER_REFRESHES_PER_HOUR {
        let created = super::sync_libation_library(
            super::State(state.clone()),
            super::Extension(approval_reader()),
        )
        .await
        .unwrap()
        .0;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let status = state
                .jobs
                .read()
                .await
                .get(&created.job_id)
                .map(|job| job.status.clone());
            if status.as_deref() == Some("completed") {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "reader refresh did not complete"
            );
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    let limited = super::sync_libation_library(
        super::State(state.clone()),
        super::Extension(approval_reader()),
    )
    .await
    .unwrap_err();
    assert_eq!(limited.status, super::StatusCode::TOO_MANY_REQUESTS);

    // The slot is reserved before the job is created, so a refused refresh
    // must be rejected before anything is recorded. A refusal that still
    // banked a timestamp would push the reader further past the quota on
    // every retry.
    let reader_id = approval_reader().id;
    let recorded = state
        .libation_refreshes
        .read()
        .await
        .manual_refreshes
        .get(&reader_id)
        .map(|timestamps| timestamps.len())
        .unwrap_or(0);
    assert_eq!(
        recorded as u64,
        super::DEFAULT_LIBATION_READER_REFRESHES_PER_HOUR,
        "a refused refresh consumed a slot"
    );

    let admin_first =
        super::sync_libation_library(super::State(state.clone()), super::Extension(admin_user()))
            .await
            .unwrap()
            .0;
    let admin_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        let status = state
            .jobs
            .read()
            .await
            .get(&admin_first.job_id)
            .map(|job| job.status.clone());
        if status.as_deref() == Some("completed") {
            break;
        }
        assert!(
            tokio::time::Instant::now() < admin_deadline,
            "administrator refresh did not complete"
        );
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let admin_second =
        super::sync_libation_library(super::State(state), super::Extension(admin_user()))
            .await
            .unwrap()
            .0;
    assert_ne!(admin_first.job_id, admin_second.job_id);
}

#[cfg(unix)]
#[tokio::test]
async fn simultaneous_reader_refreshes_join_before_spending_the_quota() {
    let root = tempfile::tempdir().unwrap();
    let (mut state, _) = fake_libation_state(root.path());
    state.libation_config.reader_refreshes_per_hour = 1;

    // Start both calls together. The reservation lock makes the first publish
    // its queued job before the second checks the one-refresh quota.
    let gate = state.libation_refresh_reservation_lock.lock().await;
    let first_state = state.clone();
    let second_state = state.clone();
    let first = tokio::spawn(async move {
        super::sync_libation_library(
            super::State(first_state),
            super::Extension(approval_reader()),
        )
        .await
    });
    let second = tokio::spawn(async move {
        super::sync_libation_library(
            super::State(second_state),
            super::Extension(approval_reader()),
        )
        .await
    });
    drop(gate);

    let first = first.await.unwrap().unwrap().0;
    let second = second.await.unwrap().unwrap().0;
    assert_eq!(first.job_id, second.job_id);
    assert_eq!(
        state
            .libation_refreshes
            .read()
            .await
            .manual_refreshes
            .get(&approval_reader().id)
            .map(Vec::len),
        Some(1),
    );
}

#[cfg(unix)]
#[tokio::test]
async fn four_libation_downloads_are_serialized_and_keep_their_targets() {
    let root = tempfile::tempdir().unwrap();
    let (state, log_path) = fake_libation_state(root.path());
    let asins = ["B000TEST01", "B000TEST02", "B000TEST03", "B000TEST04"];

    for asin in asins {
        let _ = super::liberate_libation_book(
            super::State(state.clone()),
            super::Extension(admin_user()),
            super::Path(asin.to_string()),
        )
        .await
        .unwrap();
    }

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let jobs = state.jobs.read().await;
        let running = jobs.values().filter(|job| job.status == "running").count();
        let queued = jobs.values().filter(|job| job.status == "queued").count();
        assert!(
            running <= 1,
            "Libation jobs overlapped: {running} were running"
        );
        if running == 1 && queued >= 3 {
            break;
        }
        drop(jobs);
        assert!(
            tokio::time::Instant::now() < deadline,
            "jobs never entered the expected queue"
        );
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }

    let state_for_export = state.clone();
    let export_task = tokio::spawn(async move {
        let _ = super::list_libation_books(
            super::State(state_for_export),
            super::Extension(admin_user()),
        )
        .await
        .unwrap();
    });

    loop {
        let jobs = state.jobs.read().await;
        let running = jobs.values().filter(|job| job.status == "running").count();
        let finished = jobs
            .values()
            .filter(|job| matches!(job.status.as_str(), "completed" | "failed"))
            .count();
        assert!(
            running <= 1,
            "Libation jobs overlapped: {running} were running"
        );
        if finished == asins.len() {
            break;
        }
        drop(jobs);
        assert!(
            tokio::time::Instant::now() < deadline,
            "four-download queue timed out"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    export_task.await.unwrap();

    let jobs = state.jobs.read().await;
    assert_eq!(jobs.len(), asins.len());
    for asin in asins {
        let job = jobs
            .values()
            .find(|job| {
                job.target_id
                    .as_deref()
                    .is_some_and(|target| target == asin || target.ends_with(&format!(":{asin}")))
            })
            .unwrap();
        assert_eq!(
            job.status, "completed",
            "{asin} ended with {:?}; output: {}",
            job.error, job.output
        );
    }
    drop(jobs);

    let lines = std::fs::read_to_string(log_path)
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>();
    assert_eq!(lines.len(), asins.len() * 2 + 2);
    for pair in lines.as_chunks::<2>().0 {
        assert!(pair[0].starts_with("start "));
        assert_eq!(pair[1], pair[0].replacen("start ", "end ", 1));
    }
    assert_eq!(lines[lines.len() - 2], "start export");

    let library = state.library.read().await;
    for asin in asins {
        assert!(
            library
                .books
                .iter()
                .any(|book| book.asin.as_deref() == Some(asin)),
            "{asin} was not present after the queued downloads finished"
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn successful_libation_exit_without_a_decrypted_book_is_failed() {
    let root = tempfile::tempdir().unwrap();
    let (state, _) = fake_libation_state(root.path());
    let asin = "B000FAIL00";
    let created = super::liberate_libation_book(
        super::State(state.clone()),
        super::Extension(admin_user()),
        super::Path(asin.to_string()),
    )
    .await
    .unwrap()
    .0;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        let jobs = state.jobs.read().await;
        let job = jobs.get(&created.job_id).unwrap();
        if job.status == "failed" {
            assert!(
                job.error
                    .as_deref()
                    .unwrap_or_default()
                    .contains("was not found")
            );
            break;
        }
        drop(jobs);
        assert!(
            tokio::time::Instant::now() < deadline,
            "failed decrypt was never reported"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

#[cfg(unix)]
#[tokio::test]
async fn duplicate_download_requests_share_the_active_job() {
    let root = tempfile::tempdir().unwrap();
    let (state, log_path) = fake_libation_state(root.path());
    let asin = "B000TEST09";
    let first = super::liberate_libation_book(
        super::State(state.clone()),
        super::Extension(admin_user()),
        super::Path(asin.to_string()),
    )
    .await
    .unwrap()
    .0;
    let second = super::liberate_libation_book(
        super::State(state.clone()),
        super::Extension(admin_user()),
        super::Path(asin.to_string()),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(first.job_id, second.job_id);

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        let jobs = state.jobs.read().await;
        let job = jobs.get(&first.job_id).unwrap();
        if job.status == "completed" {
            assert_eq!(jobs.len(), 1);
            break;
        }
        drop(jobs);
        assert!(
            tokio::time::Instant::now() < deadline,
            "deduplicated download timed out"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    let starts = std::fs::read_to_string(log_path)
        .unwrap()
        .lines()
        .filter(|line| *line == format!("start {asin}"))
        .count();
    assert_eq!(starts, 1, "the same title was decrypted more than once");
}

#[test]
fn prune_finished_jobs_keeps_active_and_newest() {
    let mut jobs = std::collections::HashMap::new();
    for index in 0..(super::MAX_TRACKED_JOBS + 10) {
        let id = format!("job-{index}");
        jobs.insert(
            id.clone(),
            super::JobStatus {
                id,
                kind: "test".to_string(),
                target_id: None,
                status: match index {
                    0 => "running",
                    1 => "queued",
                    _ => "completed",
                }
                .to_string(),
                started_at: index.to_string(),
                finished_at: None,
                exit_code: None,
                output: String::new(),
                error: None,
            },
        );
    }
    super::prune_finished_jobs(&mut jobs);
    assert_eq!(jobs.len(), super::MAX_TRACKED_JOBS);
    // Active jobs survive even though they are the oldest.
    assert!(jobs.contains_key("job-0"));
    assert!(jobs.contains_key("job-1"));
    // The oldest finished jobs are the ones dropped.
    assert!(!jobs.contains_key("job-2"));
    assert!(jobs.contains_key(&format!("job-{}", super::MAX_TRACKED_JOBS + 9)));
}

#[test]
fn job_list_summaries_bound_output_without_breaking_unicode() {
    let output = "résumé ".repeat(2_000);
    let job = super::JobStatus {
        id: "job-output".to_string(),
        kind: "test".to_string(),
        target_id: None,
        status: "completed".to_string(),
        started_at: "1".to_string(),
        finished_at: Some("2".to_string()),
        exit_code: Some(0),
        output: output.clone(),
        error: Some(output),
    };

    let summary = super::job_for_list(&job);
    assert!(summary.output.len() <= super::JOB_LIST_OUTPUT_BYTES);
    assert!(summary.error.unwrap().len() <= super::JOB_LIST_OUTPUT_BYTES);
    assert!(summary.output.ends_with("résumé "));
}

#[test]
fn job_timestamps_advance_when_the_clock_value_is_already_used() {
    let mut jobs = std::collections::HashMap::new();
    let latest = super::unix_now_millis().saturating_add(10_000);
    jobs.insert(
        "latest".to_string(),
        super::JobStatus {
            id: "latest".to_string(),
            kind: "test".to_string(),
            target_id: None,
            status: "running".to_string(),
            started_at: latest.to_string(),
            finished_at: None,
            exit_code: None,
            output: String::new(),
            error: None,
        },
    );

    assert_eq!(super::next_job_timestamp(&jobs), latest + 1);
}

#[test]
fn sessions_expire_after_max_age() {
    let session = Session {
        user_id: "user".to_string(),
        created_at: 1_000,
    };
    assert!(!session.is_expired(1_000 + super::SESSION_COOKIE_MAX_AGE_SECONDS));
    assert!(session.is_expired(1_001 + super::SESSION_COOKIE_MAX_AGE_SECONDS));
}

#[test]
fn new_sessions_prune_oldest_sessions_for_the_user() {
    let mut sessions = (0..super::MAX_SESSIONS_PER_USER)
        .map(|index| {
            (
                format!("token-{index}"),
                Session {
                    user_id: "reader".to_string(),
                    created_at: 1_000 + index as u64,
                },
            )
        })
        .collect::<std::collections::HashMap<_, _>>();
    super::prune_sessions_for_new_session(&mut sessions, "reader", 2_000);
    assert_eq!(sessions.len(), super::MAX_SESSIONS_PER_USER - 1);
    assert!(!sessions.contains_key("token-0"));
    assert!(sessions.contains_key(&format!("token-{}", super::MAX_SESSIONS_PER_USER - 1)));
}

#[test]
fn password_changes_revoke_other_sessions() {
    let mut sessions = std::collections::HashMap::from([
        (
            "current".to_string(),
            Session {
                user_id: "reader".to_string(),
                created_at: 1,
            },
        ),
        (
            "stolen".to_string(),
            Session {
                user_id: "reader".to_string(),
                created_at: 2,
            },
        ),
        (
            "other-user".to_string(),
            Session {
                user_id: "other".to_string(),
                created_at: 3,
            },
        ),
    ]);

    super::revoke_password_change_sessions(&mut sessions, "reader", Some("current"));
    assert!(sessions.contains_key("current"));
    assert!(!sessions.contains_key("stolen"));
    assert!(sessions.contains_key("other-user"));

    super::revoke_password_change_sessions(&mut sessions, "reader", None);
    assert!(!sessions.contains_key("current"));
    assert!(sessions.contains_key("other-user"));
}

#[tokio::test]
async fn temporary_download_is_removed_after_stream_file_closes() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("download.zip");
    std::fs::write(&path, b"zip bytes").unwrap();
    let file = super::fs::File::open(&path).await.unwrap();
    let permit = super::Arc::new(super::Semaphore::new(1))
        .acquire_owned()
        .await
        .unwrap();

    drop(super::RemoveOnDropFile::new(file, path.clone(), permit));

    assert!(!path.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn atomic_state_files_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("sessions.json");
    super::write_json_atomic(&path, &serde_json::json!({ "token": "secret" }))
        .await
        .unwrap();
    assert_eq!(
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[tokio::test]
async fn atomic_write_leaves_no_temp_files_and_round_trips() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("nested").join("progress.json");
    let stored = serde_json::json!({ "user::book": { "positionSeconds": 1234.5 } });

    super::write_json_atomic(&path, &stored).await.unwrap();

    let reread: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(reread, stored);

    // The temporary file is renamed, never left behind, so a later scan of
    // the data directory cannot mistake a partial write for a real store.
    let strays = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        .count();
    assert_eq!(strays, 0);
}

#[tokio::test]
async fn atomic_write_replaces_existing_store_without_truncating() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("progress.json");

    super::write_json_atomic(&path, &serde_json::json!({ "a": 1, "b": 2 }))
        .await
        .unwrap();
    // A shorter payload must fully replace the longer one rather than
    // overwriting its prefix and leaving trailing bytes behind.
    super::write_json_atomic(&path, &serde_json::json!({ "a": 1 }))
        .await
        .unwrap();

    let reread: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(reread, serde_json::json!({ "a": 1 }));
}

/// One book, described the way the scanner describes it.
struct IdentityFixture {
    alias: String,
    files: Vec<std::path::PathBuf>,
    track_fingerprints: Vec<String>,
    track_aliases: Vec<String>,
    book_fingerprint: String,
    duration_seconds: Option<f64>,
}

impl IdentityFixture {
    fn read(alias: &str, files: &[std::path::PathBuf]) -> Self {
        let track_fingerprints = files
            .iter()
            .map(|path| super::file_identity_fingerprint(path).unwrap())
            .collect::<Vec<_>>();
        let track_aliases = files
            .iter()
            .map(|path| format!("{alias}/{}", path.file_name().unwrap().to_string_lossy()))
            .collect::<Vec<_>>();
        Self {
            alias: alias.to_string(),
            files: files.to_vec(),
            book_fingerprint: super::book_identity_fingerprint(&track_fingerprints),
            track_fingerprints,
            track_aliases,
            duration_seconds: None,
        }
    }

    /// The same book, with a known runtime. The layout guard only has
    /// something to compare once a duration has been recorded.
    fn with_duration(mut self, duration_seconds: f64) -> Self {
        self.duration_seconds = Some(duration_seconds);
        self
    }
}

/// Resolve a whole scan, the way `rescan_library` does.
fn resolve_scan(
    identities: &mut super::LibraryIdentityStore,
    fixtures: &[IdentityFixture],
) -> Vec<(String, Vec<String>)> {
    let groups = fixtures
        .iter()
        .map(|fixture| super::ScannedGroup {
            book_fingerprint: &fixture.book_fingerprint,
            group_alias: &fixture.alias,
            root_id: super::DEFAULT_ROOT_ID,
            grouped_files: &fixture.files,
            track_fingerprints: &fixture.track_fingerprints,
            track_aliases: &fixture.track_aliases,
            duration_seconds: fixture.duration_seconds,
        })
        .collect::<Vec<_>>();
    super::resolve_library_identities(
        identities,
        &groups,
        &mut (super::mint_identity_id as fn() -> String),
    )
}

/// N distinct book locations, for exercising the scan gate.
fn book_aliases(count: usize) -> Vec<String> {
    (0..count).map(|index| format!("Book {index}")).collect()
}

fn write_book(
    root: &std::path::Path,
    folder: &str,
    name: &str,
    bytes: &[u8],
) -> std::path::PathBuf {
    let dir = root.join(folder);
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join(name);
    std::fs::write(&file, bytes).unwrap();
    file
}

#[test]
fn library_identity_survives_folder_and_track_renames() {
    let root = tempfile::tempdir().unwrap();
    let first_track = write_book(
        root.path(),
        "Old Book Name",
        "01 old name.mp3",
        b"stable audiobook bytes",
    );

    let mut identities = super::LibraryIdentityStore::default();
    let before = resolve_scan(
        &mut identities,
        &[IdentityFixture::read(
            "Old Book Name",
            std::slice::from_ref(&first_track),
        )],
    );

    std::fs::rename(
        root.path().join("Old Book Name"),
        root.path().join("New Book Name"),
    )
    .unwrap();
    let renamed = root.path().join("New Book Name").join("01 new name.mp3");
    std::fs::rename(
        root.path().join("New Book Name").join("01 old name.mp3"),
        &renamed,
    )
    .unwrap();

    let after = resolve_scan(
        &mut identities,
        &[IdentityFixture::read(
            "New Book Name",
            std::slice::from_ref(&renamed),
        )],
    );

    assert_eq!(after[0].0, before[0].0, "book id must survive a rename");
    assert_eq!(after[0].1, before[0].1, "track ids must survive a rename");
}

/// Faststart conversion rewrites a track's bytes at the same path, so the
/// fingerprint changes while the path does not. Saved progress is keyed on
/// the book and track ids, so those must not move.
#[test]
fn library_identity_survives_a_rewritten_track_at_the_same_path() {
    let root = tempfile::tempdir().unwrap();
    let track = write_book(root.path(), "Book", "01.m4b", b"trailing moov layout");

    let mut identities = super::LibraryIdentityStore::default();
    let before = resolve_scan(
        &mut identities,
        &[IdentityFixture::read("Book", std::slice::from_ref(&track))],
    );

    std::fs::write(&track, b"faststart layout, different bytes and length").unwrap();
    let after = resolve_scan(
        &mut identities,
        &[IdentityFixture::read("Book", std::slice::from_ref(&track))],
    );

    assert_eq!(after[0].0, before[0].0);
    assert_eq!(after[0].1, before[0].1);
}

/// The reported bug. Rename a book, drop unrelated content at the path it used
/// to occupy, and the newcomer must not inherit the original's identity —
/// progress, settings and access grants all hang off that id.
#[test]
fn a_recycled_path_does_not_steal_a_book_identity() {
    let root = tempfile::tempdir().unwrap();
    let original = write_book(root.path(), "Old Book", "01.mp3", b"the original recording");

    let mut identities = super::LibraryIdentityStore::default();
    let before = resolve_scan(
        &mut identities,
        &[IdentityFixture::read(
            "Old Book",
            std::slice::from_ref(&original),
        )],
    );
    let original_book_id = before[0].0.clone();
    let original_track_ids = before[0].1.clone();

    // The original moves to a name that sorts after the intruder, which is the
    // ordering that made the old resolver hand over the identity.
    std::fs::rename(root.path().join("Old Book"), root.path().join("Zebra Book")).unwrap();
    let moved = root.path().join("Zebra Book").join("01.mp3");
    let intruder = write_book(
        root.path(),
        "Old Book",
        "01.mp3",
        b"a completely different audiobook",
    );

    let after = resolve_scan(
        &mut identities,
        &[
            IdentityFixture::read("Old Book", std::slice::from_ref(&intruder)),
            IdentityFixture::read("Zebra Book", std::slice::from_ref(&moved)),
        ],
    );

    let (intruder_book_id, intruder_track_ids) = after[0].clone();
    let (moved_book_id, moved_track_ids) = after[1].clone();

    assert_eq!(
        moved_book_id, original_book_id,
        "the renamed book keeps its identity"
    );
    assert_eq!(moved_track_ids, original_track_ids);
    assert_ne!(
        intruder_book_id, original_book_id,
        "unrelated content at a recycled path must not inherit the book id"
    );
    assert_ne!(
        intruder_track_ids, original_track_ids,
        "unrelated content at a recycled path must not inherit track ids"
    );
}

/// Rejecting the stale identity is not enough on its own. Minting used to
/// derive the id from the path, so the newcomer was handed the exact id the
/// resolver had just refused it.
#[test]
fn a_rejected_identity_is_not_reminted_from_the_path() {
    let root = tempfile::tempdir().unwrap();
    let original = write_book(root.path(), "Book", "01.mp3", b"first recording");

    let mut identities = super::LibraryIdentityStore::default();
    let before = resolve_scan(
        &mut identities,
        &[IdentityFixture::read(
            "Book",
            std::slice::from_ref(&original),
        )],
    );
    let original_book_id = before[0].0.clone();

    // Age the identity past the path tier, then put different content at the
    // same path. The only tier that could match is the path one, and it is now
    // closed, so this must mint rather than reuse.
    identities.scan_counter += super::PATH_TIER_STALE_AFTER_SCANS + 5;
    std::fs::write(&original, b"an entirely different recording").unwrap();

    let after = resolve_scan(
        &mut identities,
        &[IdentityFixture::read(
            "Book",
            std::slice::from_ref(&original),
        )],
    );

    assert_ne!(
        after[0].0, original_book_id,
        "a freshly minted identity must not reproduce the id of the path's previous occupant"
    );
}

/// Two byte-identical copies produce the same book fingerprint by
/// construction, so only their paths tell them apart. Matching on fingerprint
/// alone would let them trade identities from one scan to the next.
#[test]
fn identical_duplicate_books_keep_separate_identities() {
    let root = tempfile::tempdir().unwrap();
    let main = write_book(root.path(), "Dune", "01.m4b", b"identical bytes");
    let backup = write_book(root.path(), "Backup/Dune", "01.m4b", b"identical bytes");

    let mut identities = super::LibraryIdentityStore::default();
    let first = resolve_scan(
        &mut identities,
        &[
            IdentityFixture::read("Dune", std::slice::from_ref(&main)),
            IdentityFixture::read("Backup/Dune", std::slice::from_ref(&backup)),
        ],
    );
    assert_ne!(first[0].0, first[1].0, "duplicates start as separate books");

    for _ in 0..3 {
        let again = resolve_scan(
            &mut identities,
            &[
                IdentityFixture::read("Dune", std::slice::from_ref(&main)),
                IdentityFixture::read("Backup/Dune", std::slice::from_ref(&backup)),
            ],
        );
        assert_eq!(again[0].0, first[0].0, "the main copy keeps its id");
        assert_eq!(again[1].0, first[1].0, "the backup keeps its id");
    }
}

/// A book that genuinely moves, with no duplicate to confuse it, is carried by
/// the fingerprint tier alone.
#[test]
fn a_uniquely_fingerprinted_book_survives_a_move() {
    let root = tempfile::tempdir().unwrap();
    let before_path = write_book(root.path(), "Loose", "01.mp3", b"unique recording");

    let mut identities = super::LibraryIdentityStore::default();
    let before = resolve_scan(
        &mut identities,
        &[IdentityFixture::read(
            "Loose",
            std::slice::from_ref(&before_path),
        )],
    );

    std::fs::create_dir_all(root.path().join("Author/Title")).unwrap();
    let after_path = root.path().join("Author/Title/01.mp3");
    std::fs::rename(&before_path, &after_path).unwrap();

    let after = resolve_scan(
        &mut identities,
        &[IdentityFixture::read(
            "Author/Title",
            std::slice::from_ref(&after_path),
        )],
    );
    assert_eq!(after[0].0, before[0].0);
    assert_eq!(after[0].1, before[0].1);
}

/// Identity ids are what progress and access grants hang off, so a format
/// migration that changed them would silently detach every listener's history.
#[test]
fn legacy_identity_files_migrate_without_changing_ids() {
    let legacy = serde_json::json!({
        "books": [{
            "fingerprint": "abc123",
            "bookId": "0123456789abcdef",
            "paths": ["Dune [B0001]"],
            "tracks": [{
                "fingerprint": "def456",
                "trackId": "fedcba9876543210",
                "paths": ["Dune [B0001]/01.m4b"]
            }]
        }],
        "fingerprintCache": {
            "Dune [B0001]/01.m4b": { "fingerprint": "def456", "size": 42, "modifiedMs": 7 }
        }
    })
    .to_string();

    let loaded = super::parse_library_identities(&legacy).unwrap();
    assert!(
        loaded.migrated,
        "a pre-versioned file is reported as migrated"
    );
    let store = loaded.store;

    assert_eq!(store.version, super::IDENTITY_FORMAT_VERSION);
    assert_eq!(store.books[0].book_id, "0123456789abcdef");
    assert_eq!(store.books[0].tracks[0].track_id, "fedcba9876543210");
    assert_eq!(store.books[0].paths[0].root_id, super::DEFAULT_ROOT_ID);
    assert_eq!(store.books[0].paths[0].relative_path, "Dune [B0001]");
    assert_eq!(
        store.books[0].tracks[0].paths[0].relative_path,
        "Dune [B0001]/01.m4b"
    );
    assert_eq!(
        store.fingerprint_cache[super::DEFAULT_ROOT_ID]["Dune [B0001]/01.m4b"].size,
        42
    );

    // A migrated store round-trips as the current format.
    let round_tripped =
        super::parse_library_identities(&serde_json::to_string(&store).unwrap()).unwrap();
    assert!(
        !round_tripped.migrated,
        "an already-versioned file is not migrated again"
    );
    assert_eq!(round_tripped.store.books[0].book_id, "0123456789abcdef");
}

#[tokio::test]
async fn legacy_identity_migration_creates_and_repairs_its_backup() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("library-identities.json");
    let backup = root.path().join("library-identities.json.pre-v1");
    let legacy = serde_json::json!({
        "books": [{
            "fingerprint": "abc123",
            "bookId": "0123456789abcdef",
            "paths": ["Dune"],
            "tracks": []
        }]
    })
    .to_string();
    std::fs::write(&path, &legacy).unwrap();

    super::load_library_identities(&path).await.unwrap();
    assert_eq!(std::fs::read_to_string(&backup).unwrap(), legacy);

    std::fs::write(&backup, "{truncated").unwrap();
    super::load_library_identities(&path).await.unwrap();
    assert_eq!(std::fs::read_to_string(&backup).unwrap(), legacy);
    assert!(
        std::fs::read_dir(root.path())
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !entry.file_name().to_string_lossy().ends_with(".tmp"))
    );
}

/// The shrink gate has no baseline until a scan commits one, so without help a
/// migrated store treats the upgrade scan as a first scan and commits whatever
/// it finds. That is the one scan where a silently partial walk is most costly:
/// the store still holds the whole established library.
#[test]
fn a_migrated_store_carries_a_shrink_baseline_into_its_first_scan() {
    let books = (0..100)
        .map(|index| {
            serde_json::json!({
                "fingerprint": format!("book{index}"),
                "bookId": format!("{index:016x}"),
                "paths": [format!("Book {index}")],
                "tracks": [{
                    "fingerprint": format!("track{index}"),
                    "trackId": format!("{:016x}", index + 1000),
                    "paths": [format!("Book {index}/01.m4b")]
                }]
            })
        })
        .collect::<Vec<_>>();
    // Only the first ninety are still on disk. The other ten are identities of
    // books deleted long ago, which the pre-versioned format never pruned.
    let cache = (0..90)
        .map(|index| {
            (
                format!("Book {index}/01.m4b"),
                serde_json::json!({
                    "fingerprint": format!("track{index}"),
                    "size": 42,
                    "modifiedMs": 7
                }),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    let legacy = serde_json::json!({ "books": books, "fingerprintCache": cache }).to_string();

    let store = super::parse_library_identities(&legacy).unwrap().store;
    let baseline = &store.manifests[super::DEFAULT_ROOT_ID];
    assert_eq!(
        baseline.book_fingerprints.len(),
        90,
        "the baseline counts the books the legacy cache shows were present, \
         not every identity ever issued"
    );

    let root = std::path::Path::new("/library");
    assert!(
        !super::assess_scan(&store, super::DEFAULT_ROOT_ID, &book_aliases(3), &[], root).commits(),
        "an error-free but nearly empty first scan after migrating is withheld"
    );
    assert!(
        super::assess_scan(&store, super::DEFAULT_ROOT_ID, &book_aliases(88), &[], root).commits(),
        "a first scan that finds the library commits"
    );
}

/// A legacy store with nothing in its fingerprint cache — written before the
/// cache existed, or by a scan that could fingerprint nothing — has no usable
/// baseline. Inventing one from the unpruned identity list would withhold a
/// perfectly good scan, so migration leaves the gate open as it was.
#[test]
fn a_migrated_store_with_no_cached_evidence_claims_no_baseline() {
    let legacy = serde_json::json!({
        "books": [{
            "fingerprint": "abc123",
            "bookId": "0123456789abcdef",
            "paths": ["Dune [B0001]"],
            "tracks": [{
                "fingerprint": "def456",
                "trackId": "fedcba9876543210",
                "paths": ["Dune [B0001]/01.m4b"]
            }]
        }]
    })
    .to_string();

    let store = super::parse_library_identities(&legacy).unwrap().store;
    assert!(store.manifests.is_empty());
    assert!(
        super::assess_scan(
            &store,
            super::DEFAULT_ROOT_ID,
            &book_aliases(0),
            &[],
            std::path::Path::new("/library")
        )
        .commits()
    );
}

#[test]
fn a_scan_that_loses_most_of_the_library_is_not_committed() {
    let mut identities = super::LibraryIdentityStore::default();
    identities.manifests.insert(
        super::DEFAULT_ROOT_ID.to_string(),
        super::RootManifest {
            book_fingerprints: (0..100).map(|index| format!("fp{index}")).collect(),
            scan: 1,
        },
    );
    let root = std::path::Path::new("/library");

    assert!(
        !super::assess_scan(
            &identities,
            super::DEFAULT_ROOT_ID,
            &book_aliases(0),
            &[],
            root
        )
        .commits(),
        "an empty scan against a known-populated library is suspect"
    );
    assert!(
        !super::assess_scan(
            &identities,
            super::DEFAULT_ROOT_ID,
            &book_aliases(10),
            &[],
            root
        )
        .commits(),
        "losing 90% of the library in one scan is suspect"
    );
    assert!(
        super::assess_scan(
            &identities,
            super::DEFAULT_ROOT_ID,
            &book_aliases(96),
            &[],
            root
        )
        .commits(),
        "ordinary churn still commits"
    );
    assert!(
        !super::assess_scan(
            &identities,
            super::DEFAULT_ROOT_ID,
            &book_aliases(100),
            &["permission denied".to_string()],
            root
        )
        .commits(),
        "a traversal error is never committed, however complete the result looks"
    );
}

#[test]
fn a_first_scan_commits_even_though_it_has_no_baseline() {
    let identities = super::LibraryIdentityStore::default();
    assert!(
        super::assess_scan(
            &identities,
            super::DEFAULT_ROOT_ID,
            &book_aliases(0),
            &[],
            std::path::Path::new("/library")
        )
        .commits()
    );
}

#[test]
fn fingerprint_history_retires_the_previous_digest_instead_of_erasing_it() {
    let mut identity = super::BookIdentity {
        fingerprint: "one".to_string(),
        fingerprint_history: Vec::new(),
        book_id: "book".to_string(),
        paths: Vec::new(),
        tracks: Vec::new(),
        last_seen_scan: 1,
        track_count: 1,
        duration_seconds: None,
    };

    identity.record_fingerprint("two");
    assert!(identity.matches_fingerprint("two"));
    assert!(
        identity.matches_fingerprint("one"),
        "the previous digest is still evidence of this book"
    );

    // Re-recording an existing digest must not grow history without bound.
    for _ in 0..50 {
        identity.record_fingerprint("two");
    }
    assert!(identity.fingerprint_history.len() <= 8);
}

#[test]
fn minting_retries_when_an_id_is_already_taken() {
    let root = tempfile::tempdir().unwrap();
    let first = write_book(root.path(), "A", "01.mp3", b"first");
    let second = write_book(root.path(), "B", "01.mp3", b"second");

    // A generator that hands out the same id twice before yielding a fresh one.
    let mut issued = 0;
    let mut mint = move || {
        issued += 1;
        match issued {
            1 | 2 => "collide".to_string(),
            _ => format!("unique-{issued}"),
        }
    };

    let mut identities = super::LibraryIdentityStore::default();
    let a = IdentityFixture::read("A", std::slice::from_ref(&first));
    let b = IdentityFixture::read("B", std::slice::from_ref(&second));
    let groups = [&a, &b]
        .iter()
        .map(|fixture| super::ScannedGroup {
            book_fingerprint: &fixture.book_fingerprint,
            group_alias: &fixture.alias,
            root_id: super::DEFAULT_ROOT_ID,
            grouped_files: &fixture.files,
            track_fingerprints: &fixture.track_fingerprints,
            track_aliases: &fixture.track_aliases,
            duration_seconds: fixture.duration_seconds,
        })
        .collect::<Vec<_>>();

    let resolved = super::resolve_library_identities(&mut identities, &groups, &mut mint);
    assert_ne!(
        resolved[0].0, resolved[1].0,
        "a collision must be retried, never silently reused"
    );
}

/// The taken-ID sets are built once per scan and updated as IDs are minted,
/// rather than rebuilt from the store for every book. That is only sound while
/// the running set stays complete, and a track ID reused across two books would
/// move a listening position from one book into another.
#[test]
fn minting_will_not_reuse_a_track_id_across_books_in_one_scan() {
    let root = tempfile::tempdir().unwrap();
    let first = write_book(root.path(), "A", "01.mp3", b"first");
    let second = write_book(root.path(), "B", "01.mp3", b"second");

    // Book IDs are minted for the whole scan first, then a track ID per book.
    // The fourth draw repeats the third, which belongs to the other book.
    let mut issued = 0;
    let mut mint = move || {
        issued += 1;
        match issued {
            1 => "book-a".to_string(),
            2 => "book-b".to_string(),
            3 | 4 => "shared-track".to_string(),
            _ => format!("track-{issued}"),
        }
    };

    let mut identities = super::LibraryIdentityStore::default();
    let a = IdentityFixture::read("A", std::slice::from_ref(&first));
    let b = IdentityFixture::read("B", std::slice::from_ref(&second));
    let groups = [&a, &b]
        .iter()
        .map(|fixture| super::ScannedGroup {
            book_fingerprint: &fixture.book_fingerprint,
            group_alias: &fixture.alias,
            root_id: super::DEFAULT_ROOT_ID,
            grouped_files: &fixture.files,
            track_fingerprints: &fixture.track_fingerprints,
            track_aliases: &fixture.track_aliases,
            duration_seconds: fixture.duration_seconds,
        })
        .collect::<Vec<_>>();

    let resolved = super::resolve_library_identities(&mut identities, &groups, &mut mint);
    assert_eq!(resolved[0].1[0], "shared-track");
    assert_ne!(
        resolved[1].1[0], resolved[0].1[0],
        "a track ID already issued to another book must be retried"
    );
}

#[test]
fn unchanged_tracks_reuse_cached_fingerprints_and_removed_ones_are_pruned() {
    let root = tempfile::tempdir().unwrap();
    let track = root.path().join("01 chapter.mp3");
    std::fs::write(&track, b"stable audiobook bytes").unwrap();
    let files = std::slice::from_ref(&track);

    let (first, cache) =
        super::fingerprint_tracks(root.path(), files, std::collections::BTreeMap::new());
    assert_eq!(cache.len(), 1);
    assert!(cache.contains_key("01 chapter.mp3"));

    // A cached digest is trusted while size and mtime hold, so a doctored
    // entry coming back out proves the file was not re-read.
    let mut doctored = cache.clone();
    doctored.get_mut("01 chapter.mp3").unwrap().fingerprint = "cached-digest".to_string();
    let (reused, _) = super::fingerprint_tracks(root.path(), files, doctored.clone());
    assert_eq!(reused[&track], "cached-digest");

    // A size change invalidates the entry and forces a real read.
    let mut stale = doctored;
    stale.get_mut("01 chapter.mp3").unwrap().size += 1;
    let (rehashed, retained) = super::fingerprint_tracks(root.path(), files, stale);
    assert_eq!(rehashed[&track], first[&track]);

    let (_, pruned) = super::fingerprint_tracks(root.path(), &[], retained);
    assert!(pruned.is_empty());
}

#[test]
fn unreadable_tracks_keep_a_stable_identity_instead_of_failing_the_scan() {
    let root = tempfile::tempdir().unwrap();
    let missing = root.path().join("gone.mp3");
    let files = std::slice::from_ref(&missing);

    let (fingerprints, cache) =
        super::fingerprint_tracks(root.path(), files, std::collections::BTreeMap::new());
    let fingerprint = fingerprints[&missing].clone();
    assert!(fingerprint.starts_with("path:"));
    // Never cached, so a file that becomes readable again is picked up on
    // the next scan rather than being stuck on the stand-in.
    assert!(cache.is_empty());

    let (repeated, _) =
        super::fingerprint_tracks(root.path(), files, std::collections::BTreeMap::new());
    assert_eq!(repeated[&missing], fingerprint);
}

#[test]
fn libation_account_rows_keep_distinct_server_identities() {
    let accounts = super::parse_libation_accounts(
        "first@example.com\tFamily\tus\tyes\tyes\nsecond@example.com\tTravel\tuk\tyes\tno\n",
    );
    assert_eq!(accounts.len(), 2);
    assert_eq!(accounts[0].name.as_deref(), Some("Family"));
    assert_ne!(accounts[0].id, accounts[1].id);
    assert!(accounts[0].authenticated);
    assert_eq!(accounts[0].connection_state, "connected");
    assert!(!accounts[1].authenticated);
    assert_eq!(accounts[1].connection_state, "needs_sign_in");
}

#[tokio::test]
async fn managed_libation_profiles_bootstrap_required_settings() {
    let root = tempfile::tempdir().unwrap();
    let library = root.path().join("library");
    let profile = root.path().join("account");
    std::fs::create_dir(&library).unwrap();

    super::initialize_managed_libation_profile(&profile, &library)
        .await
        .unwrap();

    let settings = serde_json::from_str::<serde_json::Value>(
        &tokio::fs::read_to_string(profile.join("Settings.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        settings["Books"].as_str(),
        Some(library.to_string_lossy().as_ref())
    );
    assert_eq!(
        settings["InProgress"].as_str(),
        Some(profile.join("InProgress").to_string_lossy().as_ref())
    );
    assert!(profile.join("InProgress").is_dir());
}

#[test]
fn audible_login_urls_accept_marketplaces_but_reject_lookalike_hosts() {
    assert!(
        super::validate_libation_response_url(
            "https://www.amazon.com/ap/maplanding?openid=example"
        )
        .is_ok()
    );
    assert!(
        super::validate_libation_response_url(
            "https://www.amazon.co.uk/ap/maplanding?openid=example"
        )
        .is_ok()
    );
    assert!(
        super::validate_libation_response_url(
            "https://www.amazon.com.attacker.example/ap/maplanding"
        )
        .is_err()
    );
    assert!(super::validate_libation_response_url("javascript:alert(1)").is_err());
}

#[test]
fn libation_login_output_redacts_urls() {
    let output = "Open this URL:\nhttps://www.amazon.com/ap/signin?secret=value\nPaste URL:";
    assert_eq!(
        super::sanitize_libation_login_output(output),
        "Open this URL:"
    );
}

/// Book IDs are random now, so a rescan that dies between writing them and
/// persisting them does not reproduce them: it mints different ones. Anything
/// that recorded the first set therefore holds references the library will
/// never hand out again, and the work store never prunes book IDs. Identities
/// have to be durable before anything downstream is allowed to name them.
#[cfg(unix)]
#[tokio::test]
async fn a_failed_identity_write_leaves_nothing_downstream_referring_to_the_lost_ids() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().unwrap();
    let (mut state, _) = fake_libation_state(root.path());
    let book_dir = state.library_root.join("Dune");
    std::fs::create_dir_all(&book_dir).unwrap();
    std::fs::copy(root.path().join("template.wav"), book_dir.join("01.wav")).unwrap();

    // Its own directory, so revoking write permission stops the identity write
    // without touching the database the work store lives in.
    let identity_dir = root.path().join("data").join("identities");
    std::fs::create_dir_all(&identity_dir).unwrap();
    state.library_identities_file = identity_dir.join("library-identities.json");
    std::fs::set_permissions(&identity_dir, std::fs::Permissions::from_mode(0o500)).unwrap();

    let failed = super::rescan_library(&state).await;
    // Restore before any assertion, so a failure still lets the tempdir clean up.
    std::fs::set_permissions(&identity_dir, std::fs::Permissions::from_mode(0o700)).unwrap();

    assert!(
        failed.is_err(),
        "a rescan that cannot persist identities must fail"
    );
    assert!(
        state.works.read().await.works.is_empty(),
        "no work may reference a book ID that was never persisted"
    );

    // With the directory writable the retry succeeds, and the IDs it does
    // persist are the ones the work store ends up holding.
    super::rescan_library(&state).await.unwrap();
    let book_id = state.library.read().await.books[0].id.clone();
    let works = state.works.read().await.clone();
    assert_eq!(works.works.len(), 1);
    assert_eq!(works.works[0].book_ids, vec![book_id]);
}

/// Builds a library holding one real, trailing-`moov` M4B. Returns `None`
/// where ffmpeg is not installed, which is also where the feature is off.
#[cfg(unix)]
async fn faststart_library(
    root: &std::path::Path,
) -> Option<(super::AppState, std::path::PathBuf, String, String)> {
    let tools = super::faststart::discover_tools(None, None)?;
    let (mut state, _) = fake_libation_state(root);
    let ffmpeg = tools.ffmpeg.clone();
    state.faststart_tools = Some(tools);

    let book_dir = state.library_root.join("Trailing Book");
    std::fs::create_dir_all(&book_dir).unwrap();
    let track = book_dir.join("01.m4b");
    let created = std::process::Command::new(ffmpeg)
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=3",
            "-c:a",
            "aac",
        ])
        .arg(&track)
        .status()
        .expect("ffmpeg should run");
    assert!(created.success());
    assert_eq!(
        super::faststart::inspect(&track).unwrap(),
        super::faststart::Layout::Trailing
    );

    super::rescan_library(&state).await.unwrap();
    let (book_id, track_id) = {
        let library = state.library.read().await;
        let book = library.books.first().expect("the book should be scanned");
        (book.id.clone(), book.tracks[0].id.clone())
    };
    Some((state, track, book_id, track_id))
}

#[cfg(unix)]
fn saved_position(book_id: &str, track_id: &str, age_ms: u64) -> super::Progress {
    super::Progress {
        book_id: book_id.to_string(),
        track_id: track_id.to_string(),
        position_seconds: 1.5,
        book_position_seconds: 1.5,
        duration_seconds: Some(3.0),
        updated_at: super::unix_now_millis().saturating_sub(age_ms).to_string(),
        finished_override: None,
    }
}

#[cfg(unix)]
#[tokio::test]
async fn faststart_conversion_keeps_book_identity_and_saved_progress() {
    let root = tempfile::tempdir().unwrap();
    let Some((state, track, book_id, track_id)) = faststart_library(root.path()).await else {
        eprintln!("skipping: ffmpeg is not installed");
        return;
    };

    state
        .progress
        .set(
            "admin",
            &book_id,
            saved_position(&book_id, &track_id, 60 * 60 * 1_000),
        )
        .await
        .unwrap();

    let job_id = super::create_job(&state, super::FASTSTART_JOB_KIND).await;
    let report = super::run_faststart_job(&state, &job_id, &super::FaststartRequest::default())
        .await
        .unwrap();
    assert_eq!(report.converted, 1);
    assert_eq!(report.failed, 0);
    assert_eq!(
        super::faststart::inspect(&track).unwrap(),
        super::faststart::Layout::Faststart
    );

    // The rescan after conversion must not mint new ids: the saved
    // position is keyed on the book, and its resume point on the track.
    let library = state.library.read().await;
    assert_eq!(library.books.len(), 1);
    assert_eq!(library.books[0].id, book_id);
    assert_eq!(library.books[0].tracks[0].id, track_id);
    drop(library);

    let entry = state
        .progress
        .get("admin", &book_id)
        .await
        .unwrap()
        .expect("progress should survive conversion");
    assert_eq!(entry.track_id, track_id);
    assert!((entry.position_seconds - 1.5).abs() < 1e-9);
}

#[cfg(unix)]
#[tokio::test]
async fn faststart_conversion_leaves_a_book_somebody_is_listening_to() {
    let root = tempfile::tempdir().unwrap();
    let Some((state, track, book_id, track_id)) = faststart_library(root.path()).await else {
        eprintln!("skipping: ffmpeg is not installed");
        return;
    };

    state
        .progress
        .set(
            "admin",
            &book_id,
            saved_position(&book_id, &track_id, 5_000),
        )
        .await
        .unwrap();

    let job_id = super::create_job(&state, super::FASTSTART_JOB_KIND).await;
    let report = super::run_faststart_job(&state, &job_id, &super::FaststartRequest::default())
        .await
        .unwrap();
    assert_eq!(report.converted, 0);
    assert_eq!(report.skipped, 1);
    assert_eq!(
        super::faststart::inspect(&track).unwrap(),
        super::faststart::Layout::Trailing
    );

    // The same run asked for explicitly converts it.
    let job_id = super::create_job(&state, super::FASTSTART_JOB_KIND).await;
    let report = super::run_faststart_job(
        &state,
        &job_id,
        &super::FaststartRequest {
            book_id: Some(book_id),
            include_active: true,
        },
    )
    .await
    .unwrap();
    assert_eq!(report.converted, 1);
    assert_eq!(
        super::faststart::inspect(&track).unwrap(),
        super::faststart::Layout::Faststart
    );
}

// ---------------------------------------------------------------------------
// The progress decision rules, without any storage
// ---------------------------------------------------------------------------

fn decision_book() -> super::Book {
    book_with_tracks(
        Some(1200.0),
        vec![
            track_with_duration("t1", 0, Some(600.0)),
            track_with_duration("t2", 1, Some(600.0)),
        ],
    )
}

fn decision_update(position_seconds: f64) -> super::ProgressUpdate {
    super::ProgressUpdate {
        track_id: "t1".to_string(),
        position_seconds,
        book_position_seconds: Some(position_seconds),
        duration_seconds: Some(600.0),
        updated_at_ms: None,
        intentional_regression: false,
        intentional_seek: false,
        tz_offset_minutes: None,
        speed: None,
        client: None,
    }
}

#[test]
fn reading_log_metadata_is_parsed_and_sanitized() {
    let update: super::ProgressUpdate = serde_json::from_value(serde_json::json!({
        "trackId": "t1",
        "positionSeconds": 12.0,
        "speed": 1.5,
        "client": "ios"
    }))
    .unwrap();
    assert_eq!(super::sanitized_playback_speed(update.speed), Some(1.5));
    assert_eq!(
        super::sanitized_client_name(update.client.as_deref()),
        Some("ios".to_string())
    );
    assert_eq!(super::sanitized_playback_speed(Some(f64::INFINITY)), None);
    assert_eq!(super::sanitized_client_name(Some("\nnot-a-client")), None);
}

#[test]
fn manual_completion_timezone_is_parsed() {
    let update: super::CompletionUpdate = serde_json::from_value(serde_json::json!({
        "finished": true,
        "tzOffsetMinutes": -240
    }))
    .unwrap();
    assert_eq!(
        super::sanitized_tz_offset_minutes(update.tz_offset_minutes),
        -240
    );
}

fn stored_at(book_position_seconds: f64, age_ms: u64) -> super::Progress {
    super::Progress {
        book_id: "book".to_string(),
        track_id: "t1".to_string(),
        position_seconds: book_position_seconds,
        book_position_seconds,
        duration_seconds: Some(600.0),
        updated_at: super::unix_now_millis().saturating_sub(age_ms).to_string(),
        finished_override: None,
    }
}

/// The position a decision would store, or `None` when it keeps what is there.
fn decided_position(
    previous: Option<&super::Progress>,
    update: &super::ProgressUpdate,
) -> Option<f64> {
    let book = decision_book();
    match super::decide_progress_write(
        &book,
        &book.tracks[0],
        previous,
        update,
        super::unix_now_millis(),
    ) {
        super::ProgressDecision::Keep => None,
        super::ProgressDecision::Store { saved, .. } => Some(saved.book_position_seconds),
    }
}

#[test]
fn a_first_position_is_always_stored() {
    assert_eq!(decided_position(None, &decision_update(42.0)), Some(42.0));
}

#[test]
fn moving_forward_is_stored() {
    let previous = stored_at(100.0, 5_000);
    assert_eq!(
        decided_position(Some(&previous), &decision_update(160.0)),
        Some(160.0)
    );
}

#[test]
fn a_replayed_checkpoint_is_refused() {
    let previous = stored_at(300.0, 1_000);
    let mut update = decision_update(10.0);
    update.updated_at_ms = Some(super::unix_now_millis().saturating_sub(3_600_000));
    assert_eq!(decided_position(Some(&previous), &update), None);
}

#[test]
fn a_backwards_jump_nobody_asked_for_is_refused() {
    let previous = stored_at(300.0, 5_000);
    assert_eq!(
        decided_position(Some(&previous), &decision_update(10.0)),
        None
    );
}

#[test]
fn a_deliberate_seek_backwards_is_honoured() {
    let previous = stored_at(300.0, 5_000);
    let mut update = decision_update(10.0);
    update.intentional_seek = true;
    assert_eq!(decided_position(Some(&previous), &update), Some(10.0));
}

#[test]
fn a_client_that_failed_to_restore_does_not_reset_the_book() {
    let previous = stored_at(300.0, 5_000);
    assert_eq!(
        decided_position(Some(&previous), &decision_update(0.0)),
        None
    );
}

/// `intentionalSeek` and `intentionalRegression` are not interchangeable. A
/// seek may move backwards, but only an explicit restart may drop a book that
/// is hours in back to near zero -- which is exactly what a client that failed
/// to restore its position looks like.
#[test]
fn a_seek_alone_cannot_reset_a_book_that_is_hours_in() {
    let previous = stored_at(500.0, 5_000);
    let mut seek_only = decision_update(1.0);
    seek_only.intentional_seek = true;
    assert_eq!(decided_position(Some(&previous), &seek_only), None);

    let mut restart = decision_update(1.0);
    restart.intentional_regression = true;
    assert_eq!(decided_position(Some(&previous), &restart), Some(1.0));
}

#[test]
fn a_large_drop_asks_for_the_previous_position_to_be_kept() {
    let previous = stored_at(500.0, 5_000);
    let mut update = decision_update(1.0);
    update.intentional_regression = true;
    let book = decision_book();
    let decision = super::decide_progress_write(
        &book,
        &book.tracks[0],
        Some(&previous),
        &update,
        super::unix_now_millis(),
    );
    match decision {
        super::ProgressDecision::Store {
            backup_previous, ..
        } => assert!(
            backup_previous,
            "a large deliberate drop should back the old position up first"
        ),
        super::ProgressDecision::Keep => panic!("an explicit restart should be stored"),
    }
}

#[test]
fn a_future_skewed_clock_does_not_lock_out_a_healthy_device() {
    // The skewed device writes first, a year ahead.
    let previous = stored_at(100.0, 0);
    let mut update = decision_update(200.0);
    update.updated_at_ms = Some(super::unix_now_millis().saturating_add(31_536_000_000));
    assert_eq!(decided_position(Some(&previous), &update), Some(200.0));

    // A correctly-clocked device must still be able to move forward.
    assert_eq!(
        decided_position(Some(&previous), &decision_update(250.0)),
        Some(250.0)
    );
}

/// A handler that rejects a request after editing the account list used to
/// leave the in-memory copy changed and the stored copy untouched, and the two
/// disagreed until the next restart. `mutate` works on a draft and adopts it
/// only once the change succeeds and the write commits.
#[tokio::test]
async fn a_rejected_account_change_touches_neither_the_cache_nor_the_database() {
    let root = tempfile::tempdir().unwrap();
    let database = super::Database::open(&root.path().join("operalibre.db")).unwrap();
    let store = super::UserStore::new(
        database.clone(),
        super::StoreShape::Users,
        super::UsersStore::default(),
    );

    store
        .mutate(|users| {
            users.users = vec![stored_user("owner", true, true)];
            Ok(())
        })
        .await
        .unwrap();

    let rejected = store
        .mutate(|users| {
            // Edit first, then refuse -- the order that used to leave a mess.
            users.users.push(stored_user("intruder", true, true));
            Err::<(), _>(super::ApiError::conflict("nope"))
        })
        .await;
    assert!(rejected.is_err());

    assert_eq!(
        store.read().await.users.len(),
        1,
        "a rejected change was left in the cache"
    );
    let stored = database
        .call(|connection| {
            super::read_users_rows(connection)
                .map_err(|error| rusqlite::Error::InvalidParameterName(error.to_string()))
        })
        .await
        .unwrap();
    assert_eq!(
        stored.users.len(),
        1,
        "a rejected change reached the database"
    );
}

// ---------------------------------------------------------------------------
// Importing an existing installation and exporting it back
// ---------------------------------------------------------------------------

/// Write a data directory that looks like a real installation before SQLite.
fn legacy_data_dir(root: &std::path::Path) -> super::JsonLayout {
    let data_dir = root.join("data");
    std::fs::create_dir_all(&data_dir).unwrap();
    let write = |name: &str, value: serde_json::Value| {
        std::fs::write(
            data_dir.join(name),
            serde_json::to_vec_pretty(&value).unwrap(),
        )
        .unwrap();
    };

    write(
        "progress.json",
        serde_json::json!({
            "user:alice:book:one": {
                "bookId": "one", "trackId": "t1",
                "positionSeconds": 12.5, "bookPositionSeconds": 12.5,
                "durationSeconds": 600.0, "updatedAt": "1750000000000",
                "finishedOverride": true
            },
            "user:bob:book:two": {
                "bookId": "two", "trackId": "t9",
                "positionSeconds": 3.0, "bookPositionSeconds": 903.0,
                "durationSeconds": null, "updatedAt": "1750000001000"
            }
        }),
    );
    write(
        "progress.backups.json",
        serde_json::json!({
            "user:alice:book:one": [{
                "bookId": "one", "trackId": "t1",
                "positionSeconds": 300.0, "bookPositionSeconds": 300.0,
                "durationSeconds": 600.0, "updatedAt": "1749999999000"
            }]
        }),
    );
    write(
        "book-settings.json",
        serde_json::json!({ "user:alice:book:one": { "volumeGain": 2.25 } }),
    );
    write(
        "users.json",
        serde_json::json!({
            "users": [
                {
                    "id": "alice", "username": "alice", "passwordHash": "hash-a",
                    "isAdmin": true, "isOwner": true,
                    "canApproveLibationRequests": true,
                    "allowedBookIds": null, "libationAccess": "direct",
                    "shareProgress": true, "createdAt": "2026-01-01T00:00:00Z"
                },
                {
                    "id": "bob", "username": "bob", "passwordHash": "hash-b",
                    "isAdmin": false, "isOwner": false,
                    "canApproveLibationRequests": false,
                    "allowedBookIds": ["two"], "libationAccess": "approval",
                    "shareProgress": false, "createdAt": "2026-01-02T00:00:00Z"
                }
            ],
            "permissions_version": 1
        }),
    );
    write(
        "sessions.json",
        // Sessions are the one store written in snake_case on disk.
        serde_json::json!({ "token-abc": { "user_id": "alice", "created_at": 1750000000u64 } }),
    );
    write(
        "activity.json",
        serde_json::json!({ "alice": { "2026-08-01": 1800.0, "2026-08-02": 60.0 } }),
    );
    write(
        "metadata-overrides.json",
        serde_json::json!({ "one": { "title": "Edited" } }),
    );
    write(
        "libation-requests.json",
        serde_json::json!({ "requests": [] }),
    );
    write(
        "libation-refreshes.json",
        serde_json::json!({ "manualRefreshes": {} }),
    );
    write(
        "libation-accounts.json",
        serde_json::json!({ "accounts": [] }),
    );

    super::JsonLayout {
        progress: data_dir.join("progress.json"),
        progress_backups: data_dir.join("progress.backups.json"),
        book_settings: data_dir.join("book-settings.json"),
        users: data_dir.join("users.json"),
        sessions: data_dir.join("sessions.json"),
        activity: data_dir.join("activity.json"),
        metadata_overrides: data_dir.join("metadata-overrides.json"),
        libation_requests: data_dir.join("libation-requests.json"),
        libation_refreshes: data_dir.join("libation-refreshes.json"),
        libation_accounts: data_dir.join("libation-accounts.json"),
    }
}

/// An absent optional field and one written as `null` mean the same thing to
/// serde, and an older release may have written either. Comparing round trips
/// should not care which form a file happens to use.
fn without_nulls(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(fields) => serde_json::Value::Object(
            fields
                .into_iter()
                .filter(|(_, field)| !field.is_null())
                .map(|(key, field)| (key, without_nulls(field)))
                .collect(),
        ),
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(without_nulls).collect())
        }
        other => other,
    }
}

#[test]
fn a_progress_key_splits_back_into_its_two_halves() {
    assert_eq!(
        super::split_progress_key("user:alice:book:one"),
        Some(("alice".to_string(), "one".to_string()))
    );
    // Book ids are free-form and have contained colons.
    assert_eq!(
        super::split_progress_key("user:a:b:book:x:y"),
        Some(("a:b".to_string(), "x:y".to_string()))
    );
    assert_eq!(super::split_progress_key("nonsense"), None);
}

#[tokio::test]
async fn an_existing_installation_imports_and_exports_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let layout = legacy_data_dir(root.path());
    let data_dir = root.path().join("data");
    let database_path = data_dir.join("operalibre.db");

    let before: Vec<(String, String)> = [
        &layout.progress,
        &layout.progress_backups,
        &layout.book_settings,
        &layout.users,
        &layout.sessions,
        &layout.activity,
        &layout.metadata_overrides,
    ]
    .iter()
    .map(|path| {
        (
            path.file_name().unwrap().to_string_lossy().to_string(),
            std::fs::read_to_string(path).unwrap(),
        )
    })
    .collect();

    super::migrate_if_needed(&database_path, &data_dir, &layout).unwrap();
    assert!(database_path.is_file(), "the database was not created");

    // Nothing was taken away: the originals stay, and a copy is kept.
    for (name, contents) in &before {
        assert_eq!(
            &std::fs::read_to_string(data_dir.join(name)).unwrap(),
            contents,
            "{name} was modified by the import"
        );
        assert!(
            data_dir.join("backup-pre-sqlite").join(name).is_file(),
            "{name} was not backed up"
        );
    }

    let database = super::Database::open(&database_path).unwrap();

    // Every record survives the round trip.
    let alice = database
        .call(|connection| {
            super::read_users_rows(connection)
                .map_err(|error| rusqlite::Error::InvalidParameterName(error.to_string()))
        })
        .await
        .unwrap();
    assert_eq!(alice.users.len(), 2);
    assert_eq!(alice.permissions_version, 1);
    let bob = alice.users.iter().find(|user| user.id == "bob").unwrap();
    assert_eq!(
        bob.allowed_book_ids.as_deref(),
        Some(&["two".to_string()][..])
    );
    let owner = alice.users.iter().find(|user| user.id == "alice").unwrap();
    assert!(
        owner.allowed_book_ids.is_none(),
        "an unrestricted account gained restrictions"
    );

    let store = super::ProgressStore::new(database.clone());
    let saved = store.get("alice", "one").await.unwrap().unwrap();
    assert!((saved.position_seconds - 12.5).abs() < 1e-9);
    assert_eq!(saved.finished_override, Some(true));
    let bobs = store.get("bob", "two").await.unwrap().unwrap();
    assert!((bobs.book_position_seconds - 903.0).abs() < 1e-9);
    assert_eq!(bobs.duration_seconds, None);

    let settings = super::BookSettingsStore::new(database.clone());
    assert!((settings.gain("alice", "one").await.unwrap() - 2.25).abs() < 1e-9);
    assert!((settings.gain("bob", "two").await.unwrap() - 1.0).abs() < 1e-9);

    // And the export reproduces what was imported.
    let exported_dir = root.path().join("exported");
    std::fs::create_dir_all(&exported_dir).unwrap();
    let export_layout = super::JsonLayout {
        progress: exported_dir.join("progress.json"),
        progress_backups: exported_dir.join("progress.backups.json"),
        book_settings: exported_dir.join("book-settings.json"),
        users: exported_dir.join("users.json"),
        sessions: exported_dir.join("sessions.json"),
        activity: exported_dir.join("activity.json"),
        metadata_overrides: exported_dir.join("metadata-overrides.json"),
        libation_requests: exported_dir.join("libation-requests.json"),
        libation_refreshes: exported_dir.join("libation-refreshes.json"),
        libation_accounts: exported_dir.join("libation-accounts.json"),
    };
    // Export replaces the JSON files migration intentionally leaves behind.
    // This also exercises the Windows replacement path, where a plain rename
    // cannot overwrite an existing destination.
    for name in [
        "progress.json",
        "progress.backups.json",
        "book-settings.json",
        "users.json",
        "sessions.json",
        "activity.json",
        "metadata-overrides.json",
        "libation-requests.json",
        "libation-refreshes.json",
        "libation-accounts.json",
    ] {
        std::fs::write(exported_dir.join(name), "stale export").unwrap();
    }
    database
        .call(move |connection| {
            super::export_json(connection, &export_layout)
                .map_err(|error| rusqlite::Error::InvalidParameterName(error.to_string()))
        })
        .await
        .unwrap();

    for name in [
        "progress.json",
        "progress.backups.json",
        "book-settings.json",
        "users.json",
        "sessions.json",
        "activity.json",
        "metadata-overrides.json",
    ] {
        let original: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(data_dir.join(name)).unwrap()).unwrap();
        let exported: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(exported_dir.join(name)).unwrap())
                .unwrap();
        assert_eq!(
            without_nulls(original),
            without_nulls(exported),
            "{name} did not survive the round trip"
        );
    }
}

#[tokio::test]
async fn a_second_start_does_not_import_again() {
    let root = tempfile::tempdir().unwrap();
    let layout = legacy_data_dir(root.path());
    let data_dir = root.path().join("data");
    let database_path = data_dir.join("operalibre.db");

    super::migrate_if_needed(&database_path, &data_dir, &layout).unwrap();

    // A position saved after the import must not be overwritten by a second
    // pass re-reading the now-stale JSON file.
    let database = super::Database::open(&database_path).unwrap();
    let store = super::ProgressStore::new(database.clone());
    store
        .set(
            "alice",
            "one",
            super::Progress {
                book_id: "one".to_string(),
                track_id: "t1".to_string(),
                position_seconds: 400.0,
                book_position_seconds: 400.0,
                duration_seconds: Some(600.0),
                updated_at: super::unix_now_millis().to_string(),
                finished_override: None,
            },
        )
        .await
        .unwrap();
    drop(store);
    drop(database);

    super::migrate_if_needed(&database_path, &data_dir, &layout).unwrap();

    let database = super::Database::open(&database_path).unwrap();
    let store = super::ProgressStore::new(database);
    let saved = store.get("alice", "one").await.unwrap().unwrap();
    assert!(
        (saved.position_seconds - 400.0).abs() < 1e-9,
        "a second import reverted a position saved after the first"
    );
}

#[test]
fn an_incomplete_database_does_not_suppress_a_legacy_import_retry() {
    let root = tempfile::tempdir().unwrap();
    let layout = legacy_data_dir(root.path());
    let data_dir = root.path().join("data");
    let database_path = data_dir.join("operalibre.db");

    // This is the state an earlier implementation could leave after creating
    // the schema but before committing its import transaction.
    drop(super::db::open(&database_path).unwrap());
    super::migrate_if_needed(&database_path, &data_dir, &layout).unwrap();

    let connection = super::db::open(&database_path).unwrap();
    let progress: i64 = connection
        .query_row("SELECT COUNT(*) FROM progress", [], |row| row.get(0))
        .unwrap();
    assert_eq!(progress, 2, "the legacy positions were skipped");
}

#[test]
fn export_opening_a_missing_database_does_not_create_it() {
    let root = tempfile::tempdir().unwrap();
    let database_path = root.path().join("missing.db");

    assert!(super::db::open_existing(&database_path).is_err());
    assert!(
        !database_path.exists(),
        "export setup created an empty database instead of refusing"
    );
}

#[test]
fn a_failed_import_leaves_no_database_behind() {
    let root = tempfile::tempdir().unwrap();
    let layout = legacy_data_dir(root.path());
    let data_dir = root.path().join("data");
    // Corrupt one file so the import cannot complete.
    std::fs::write(&layout.users, b"{ not json").unwrap();

    let database_path = data_dir.join("operalibre.db");
    let result = super::migrate_if_needed(&database_path, &data_dir, &layout);

    assert!(result.is_err(), "a corrupt file was imported anyway");
    assert!(
        !database_path.exists(),
        "a half-built database was left behind for the next start to adopt"
    );
    // The originals are untouched, so the server can carry on reading them.
    assert!(layout.progress.is_file());
    assert_eq!(
        std::fs::read_to_string(&layout.users).unwrap(),
        "{ not json"
    );
}

/// The media route resolves its caller through a reverse index rather than by
/// hashing every live session. An index that outlived the session it points at
/// would keep a signed-out listener streaming, so it is rebuilt on every
/// change rather than patched.
#[tokio::test]
async fn the_media_token_index_follows_the_sessions_it_points_at() {
    let root = tempfile::tempdir().unwrap();
    let database = super::Database::open(&root.path().join("operalibre.db")).unwrap();
    let sessions = super::SessionStore::new(
        database,
        super::StoreShape::Sessions,
        std::collections::HashMap::new(),
    );

    let token = "session-one".to_string();
    let media = super::media_token_for_session(&token);
    sessions
        .mutate(|live| {
            live.insert(
                token.clone(),
                super::Session {
                    user_id: "reader".to_string(),
                    created_at: super::unix_now_seconds(),
                },
            );
            Ok(())
        })
        .await
        .unwrap();

    assert_eq!(
        sessions.session_for_media_token(&media).await,
        Some(token.clone())
    );
    assert_eq!(
        sessions.session_for_media_token("not-a-media-token").await,
        None
    );

    sessions
        .mutate(|live| {
            live.remove(&token);
            Ok(())
        })
        .await
        .unwrap();

    assert_eq!(
        sessions.session_for_media_token(&media).await,
        None,
        "a signed-out session was still reachable through its media token"
    );
}

/// Cover art is extracted to disk during the scan instead of being held in
/// memory. A rescan that finds the same art must not rewrite the file, and art
/// belonging to a book that has left the library must not linger.
#[test]
fn extracted_cover_art_is_reused_and_tidied_up() {
    let root = tempfile::tempdir().unwrap();
    let covers = root.path().join("covers");

    let image = |bytes: &[u8]| super::EmbeddedImage {
        mime_type: "image/jpeg".to_string(),
        data: bytes.to_vec(),
        etag: super::bytes_etag(bytes),
    };

    let first = super::write_cover_cache(
        &covers,
        vec![
            ("book-one".to_string(), image(b"first cover bytes")),
            ("book-two".to_string(), image(b"second cover bytes")),
        ],
    )
    .unwrap()
    .0;
    assert_eq!(first.len(), 2);
    let one = first["book-one"].clone();
    assert_eq!(one.len, b"first cover bytes".len() as u64);
    assert_eq!(std::fs::read(&one.path).unwrap(), b"first cover bytes");

    let written_at = std::fs::metadata(&one.path).unwrap().modified().unwrap();

    // A rescan finding the same art for one book, new art for the other, and
    // no art at all for a book that has been removed.
    let (second, stale) = super::write_cover_cache(
        &covers,
        vec![
            ("book-one".to_string(), image(b"first cover bytes")),
            ("book-three".to_string(), image(b"third cover bytes")),
        ],
    )
    .unwrap();

    assert_eq!(
        std::fs::metadata(&one.path).unwrap().modified().unwrap(),
        written_at,
        "unchanged cover art was rewritten"
    );
    assert_eq!(
        std::fs::read(&second["book-three"].path).unwrap(),
        b"third cover bytes"
    );
    // Stale art is reported rather than removed, so the published library can
    // finish serving it; the caller tidies up once the new snapshot is live.
    assert!(
        first["book-two"].path.exists(),
        "stale art was removed early"
    );
    super::remove_stale_covers(&stale);
    assert!(
        !first["book-two"].path.exists(),
        "cover art for a departed book was left behind"
    );
}

/// The etag identifies the image, so replacing a book's art must change it.
#[test]
fn replacing_cover_art_replaces_the_file_and_its_etag() {
    let root = tempfile::tempdir().unwrap();
    let covers = root.path().join("covers");
    let image = |bytes: &[u8]| super::EmbeddedImage {
        mime_type: "image/jpeg".to_string(),
        data: bytes.to_vec(),
        etag: super::bytes_etag(bytes),
    };

    let before = super::write_cover_cache(&covers, vec![("book".to_string(), image(b"old art"))])
        .unwrap()
        .0["book"]
        .clone();
    let after = super::write_cover_cache(
        &covers,
        vec![("book".to_string(), image(b"replacement art"))],
    )
    .unwrap()
    .0["book"]
        .clone();

    assert_ne!(before.etag, after.etag);
    assert_eq!(before.path, after.path, "the cache path should be stable");
    assert_eq!(std::fs::read(&after.path).unwrap(), b"replacement art");
}

/// Overlapping mutations must not be able to publish their index snapshots
/// out of order. Without the mutation gate, the loser of a race could
/// overwrite a newer index with its own older snapshot, leaving a
/// just-signed-in session's media token unresolvable until the next session
/// change.
#[tokio::test]
async fn overlapping_session_mutations_keep_the_media_index_current() {
    let root = tempfile::tempdir().unwrap();
    let database = super::Database::open(&root.path().join("operalibre.db")).unwrap();
    let sessions = std::sync::Arc::new(super::SessionStore::new(
        database,
        super::StoreShape::Sessions,
        std::collections::HashMap::new(),
    ));

    let mut handles = Vec::new();
    for index in 0..32 {
        let sessions = sessions.clone();
        handles.push(tokio::spawn(async move {
            let token = format!("session-{index}");
            sessions
                .mutate(|live| {
                    live.insert(
                        token.clone(),
                        super::Session {
                            user_id: "reader".to_string(),
                            created_at: super::unix_now_seconds(),
                        },
                    );
                    Ok(())
                })
                .await
                .unwrap();
            super::media_token_for_session(&token)
        }));
    }

    for handle in handles {
        let media = handle.await.unwrap();
        assert!(
            sessions.session_for_media_token(&media).await.is_some(),
            "a committed session's media token was missing from the index"
        );
    }
}

/// Atom requires a real RFC 3339 instant in `<updated>`; the server's own
/// timestamps are bare unix seconds, which a strict reader rejects.
#[test]
fn rfc3339_formats_an_instant_a_feed_reader_will_accept() {
    assert_eq!(super::rfc3339_utc(0), "1970-01-01T00:00:00Z");
    assert_eq!(super::rfc3339_utc(1_750_000_000), "2025-06-15T15:06:40Z");
    // Last second of a day, and the first of the next.
    assert_eq!(super::rfc3339_utc(86_399), "1970-01-01T23:59:59Z");
    assert_eq!(super::rfc3339_utc(86_400), "1970-01-02T00:00:00Z");
}

/// An old copy left behind at a stale alias matches the identity's *history*.
/// The live book matches its current fingerprint. Current evidence has to win,
/// or the identity — and the progress and grants hanging off it — follows the
/// abandoned copy.
#[test]
fn a_current_fingerprint_outranks_a_historical_one() {
    for reversed in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let original = write_book(root.path(), "A", "01.mp3", b"first pressing");

        let mut identities = super::LibraryIdentityStore::default();
        let before = resolve_scan(
            &mut identities,
            &[IdentityFixture::read("A", std::slice::from_ref(&original))],
        );
        let book_id = before[0].0.clone();

        // The book is rewritten in place, so its old digest becomes history.
        std::fs::write(&original, b"second pressing, different bytes").unwrap();
        resolve_scan(
            &mut identities,
            &[IdentityFixture::read("A", std::slice::from_ref(&original))],
        );

        // Now it moves to B, and a copy of the ORIGINAL bytes reappears at A.
        std::fs::create_dir_all(root.path().join("B")).unwrap();
        let moved = root.path().join("B/01.mp3");
        std::fs::rename(&original, &moved).unwrap();
        let stale = write_book(root.path(), "A", "01.mp3", b"first pressing");

        let stale_fixture = IdentityFixture::read("A", std::slice::from_ref(&stale));
        let live_fixture = IdentityFixture::read("B", std::slice::from_ref(&moved));
        let scan = if reversed {
            vec![live_fixture, stale_fixture]
        } else {
            vec![stale_fixture, live_fixture]
        };
        let after = resolve_scan(&mut identities, &scan);
        let (live, stale_out) = if reversed {
            (&after[0], &after[1])
        } else {
            (&after[1], &after[0])
        };

        assert_eq!(
            live.0, book_id,
            "the live book keeps the identity (reversed = {reversed})"
        );
        assert_ne!(
            stale_out.0, book_id,
            "an old copy at a stale alias must not claim it (reversed = {reversed})"
        );
    }
}

/// One stored identity, two scanned books that both match it. Neither may
/// claim it, and the result must not depend on which is scanned first.
#[test]
fn an_identity_claimed_by_two_groups_goes_to_neither() {
    let root = tempfile::tempdir().unwrap();
    let original = write_book(root.path(), "Book", "01.mp3", b"shared bytes");

    let mut identities = super::LibraryIdentityStore::default();
    let before = resolve_scan(
        &mut identities,
        &[IdentityFixture::read(
            "Book",
            std::slice::from_ref(&original),
        )],
    );
    let book_id = before[0].0.clone();

    // A second, byte-identical copy appears elsewhere. Both now match the one
    // stored identity by fingerprint, and neither sits at its remembered path.
    let copy = write_book(root.path(), "Elsewhere", "01.mp3", b"shared bytes");
    std::fs::create_dir_all(root.path().join("Moved")).unwrap();
    let moved = root.path().join("Moved/01.mp3");
    std::fs::rename(&original, &moved).unwrap();

    let mut forward = identities.clone();
    let a = resolve_scan(
        &mut forward,
        &[
            IdentityFixture::read("Elsewhere", std::slice::from_ref(&copy)),
            IdentityFixture::read("Moved", std::slice::from_ref(&moved)),
        ],
    );
    let mut backward = identities.clone();
    let b = resolve_scan(
        &mut backward,
        &[
            IdentityFixture::read("Moved", std::slice::from_ref(&moved)),
            IdentityFixture::read("Elsewhere", std::slice::from_ref(&copy)),
        ],
    );

    let claimed_forward = a.iter().filter(|(id, _)| id == &book_id).count();
    let claimed_backward = b.iter().filter(|(id, _)| id == &book_id).count();
    assert_eq!(
        claimed_forward, claimed_backward,
        "scan order must not decide who gets an ambiguous identity"
    );
    assert_eq!(
        claimed_forward, 0,
        "an identity two books both claim is given to neither"
    );
}

/// The staleness boundary on the path-only tier, isolated from minting.
#[test]
fn the_path_tier_closes_once_an_identity_goes_stale() {
    let run = |age: u64| {
        let root = tempfile::tempdir().unwrap();
        let track = write_book(root.path(), "Book", "01.m4b", b"original container");
        let mut identities = super::LibraryIdentityStore::default();
        let before = resolve_scan(
            &mut identities,
            &[IdentityFixture::read("Book", std::slice::from_ref(&track)).with_duration(3600.0)],
        );

        identities.scan_counter += age;
        std::fs::write(&track, b"remuxed container, same audio, other bytes").unwrap();
        let after = resolve_scan(
            &mut identities,
            &[IdentityFixture::read("Book", std::slice::from_ref(&track)).with_duration(3600.0)],
        );
        (before[0].0.clone(), after[0].0.clone())
    };

    let (before, after) = run(super::PATH_TIER_STALE_AFTER_SCANS - 1);
    assert_eq!(before, after, "a recently seen identity still carries");

    let (before, after) = run(super::PATH_TIER_STALE_AFTER_SCANS + 1);
    assert_ne!(before, after, "a stale identity no longer claims by path");
}

/// A faststart remux preserves duration exactly; a different book at the same
/// path does not. That is what separates the two cases the path-only tier
/// otherwise cannot tell apart.
#[test]
fn the_path_tier_rejects_a_replacement_with_a_different_runtime() {
    let root = tempfile::tempdir().unwrap();
    let track = write_book(root.path(), "Book", "01.m4b", b"original container");

    let mut identities = super::LibraryIdentityStore::default();
    let before = resolve_scan(
        &mut identities,
        &[IdentityFixture::read("Book", std::slice::from_ref(&track)).with_duration(3600.0)],
    );

    // Same path, same filename, different bytes — but eleven hours instead of
    // one. This is a replacement, not a remux.
    std::fs::write(&track, b"an entirely different audiobook").unwrap();
    let after = resolve_scan(
        &mut identities,
        &[IdentityFixture::read("Book", std::slice::from_ref(&track)).with_duration(39_600.0)],
    );
    assert_ne!(
        after[0].0, before[0].0,
        "content of a different length must not inherit the identity"
    );

    // The remux case, by contrast, is carried.
    let root = tempfile::tempdir().unwrap();
    let track = write_book(root.path(), "Book", "01.m4b", b"trailing moov");
    let mut identities = super::LibraryIdentityStore::default();
    let before = resolve_scan(
        &mut identities,
        &[IdentityFixture::read("Book", std::slice::from_ref(&track)).with_duration(3600.0)],
    );
    std::fs::write(&track, b"leading moov, different bytes entirely").unwrap();
    let after = resolve_scan(
        &mut identities,
        &[IdentityFixture::read("Book", std::slice::from_ref(&track)).with_duration(3600.0)],
    );
    assert_eq!(
        after[0].0, before[0].0,
        "a remux keeps its duration, and its identity"
    );
}

/// A library that really did shrink must not be stranded. The gate withholds
/// the first observations and accepts the reduction once it is confirmed.
#[test]
fn a_repeated_shrink_is_eventually_accepted() {
    let mut identities = super::LibraryIdentityStore::default();
    identities.manifests.insert(
        super::DEFAULT_ROOT_ID.to_string(),
        super::RootManifest {
            book_fingerprints: (0..100).map(|index| format!("fp{index}")).collect(),
            scan: 1,
        },
    );
    let root = std::path::Path::new("/library");

    for observation in 1..super::SHRINK_CONFIRMATIONS {
        let verdict = super::assess_scan(
            &identities,
            super::DEFAULT_ROOT_ID,
            &book_aliases(20),
            &[],
            root,
        );
        assert!(!verdict.commits(), "observation {observation} is withheld");
        match verdict {
            super::ScanVerdict::Withhold {
                record_shrink: Some((count, signature)),
            } => {
                let pending = identities
                    .pending_shrink
                    .entry(super::DEFAULT_ROOT_ID.to_string())
                    .or_default();
                pending.book_count = count;
                pending.signature = signature;
                pending.observations += 1;
            }
            _ => panic!("a shrink must be recorded so it can be confirmed"),
        }
    }

    assert!(
        super::assess_scan(
            &identities,
            super::DEFAULT_ROOT_ID,
            &book_aliases(20),
            &[],
            root
        )
        .commits(),
        "a consistently reported reduction is accepted rather than stranding the library"
    );

    // A different count restarts the count: a flapping mount never confirms.
    assert!(
        !super::assess_scan(
            &identities,
            super::DEFAULT_ROOT_ID,
            &book_aliases(5),
            &[],
            root
        )
        .commits(),
        "a different reduced count is not a confirmation of the previous one"
    );
}

/// A traversal failure says nothing about how big the library is, so it must
/// never count towards confirming a shrink.
#[test]
fn a_traversal_failure_does_not_confirm_a_shrink() {
    let mut identities = super::LibraryIdentityStore::default();
    identities.manifests.insert(
        super::DEFAULT_ROOT_ID.to_string(),
        super::RootManifest {
            book_fingerprints: (0..100).map(|index| format!("fp{index}")).collect(),
            scan: 1,
        },
    );
    identities.pending_shrink.insert(
        super::DEFAULT_ROOT_ID.to_string(),
        super::PendingShrink {
            book_count: 20,
            signature: super::scan_signature(&book_aliases(20)),
            observations: super::SHRINK_CONFIRMATIONS - 1,
        },
    );

    let verdict = super::assess_scan(
        &identities,
        super::DEFAULT_ROOT_ID,
        &book_aliases(20),
        &["I/O error".to_string()],
        std::path::Path::new("/library"),
    );
    assert!(!verdict.commits());
    assert!(
        matches!(
            verdict,
            super::ScanVerdict::Withhold {
                record_shrink: None
            }
        ),
        "an errored scan must not be counted as evidence of the library's size"
    );
}

/// Two files inside one book can share a fingerprint — an intro sting, a
/// silent gap, a duplicated chapter. Track ids sit on progress rows, so a
/// stored track id going to the wrong file moves a saved position within the
/// book.
///
/// The graph here is deliberately asymmetric: the first file has exactly one
/// candidate track, the second has two, and the single candidate is shared. A
/// symmetric graph does not distinguish the resolvers — both refuse it — so it
/// has to be this shape to guard the bug. Granting the certain claim would
/// consume the shared track and cascade the second file onto the remaining
/// one, which is precisely the order-dependent behaviour being prevented.
#[test]
fn a_track_two_files_can_claim_is_not_given_to_the_certain_one() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("Book");
    std::fs::create_dir_all(&dir).unwrap();
    let first = dir.join("01.mp3");
    let second = dir.join("02.mp3");
    // Byte-identical, so both files carry one fingerprint.
    std::fs::write(&first, b"identical chapter bytes").unwrap();
    std::fs::write(&second, b"identical chapter bytes").unwrap();
    let shared_fingerprint = super::file_identity_fingerprint(&first).unwrap();

    // T1 has lived at both aliases; T2 only at the second. So "Book/01.mp3"
    // has one candidate and "Book/02.mp3" has two, with T1 in both.
    let track_one = super::TrackIdentity {
        fingerprint: shared_fingerprint.clone(),
        track_id: "track-one".to_string(),
        paths: vec![
            super::IdentityPath::new(super::DEFAULT_ROOT_ID, "Book/01.mp3"),
            super::IdentityPath::new(super::DEFAULT_ROOT_ID, "Book/02.mp3"),
        ],
    };
    let track_two = super::TrackIdentity {
        fingerprint: shared_fingerprint.clone(),
        track_id: "track-two".to_string(),
        paths: vec![super::IdentityPath::new(
            super::DEFAULT_ROOT_ID,
            "Book/02.mp3",
        )],
    };

    let fixture = IdentityFixture::read("Book", &[first.clone(), second.clone()]);
    let mut identities = super::LibraryIdentityStore {
        version: super::IDENTITY_FORMAT_VERSION,
        ..Default::default()
    };
    identities.books.push(super::BookIdentity {
        fingerprint: fixture.book_fingerprint.clone(),
        fingerprint_history: Vec::new(),
        book_id: "the-book".to_string(),
        paths: vec![super::IdentityPath::new(super::DEFAULT_ROOT_ID, "Book")],
        tracks: vec![track_one, track_two],
        last_seen_scan: 1,
        track_count: 2,
        duration_seconds: None,
    });
    identities.scan_counter = 1;

    let resolved = resolve_scan(&mut identities, std::slice::from_ref(&fixture));
    let (book_id, track_ids) = resolved[0].clone();
    assert_eq!(book_id, "the-book", "the book itself still resolves");

    assert!(
        !track_ids.contains(&"track-one".to_string()),
        "a track two files can equally claim must not be granted to whichever asked first"
    );
    assert!(
        !track_ids.contains(&"track-two".to_string()),
        "and the cascade that would follow from granting it must not happen either"
    );
    assert_ne!(track_ids[0], track_ids[1], "two files, two distinct ids");
}

/// Two byte-identical books share a digest. Remuxing one of them must not be
/// blocked just because its twin still carries the original fingerprint.
#[test]
fn remuxing_one_of_two_identical_copies_keeps_its_identity() {
    let root = tempfile::tempdir().unwrap();
    let main = write_book(root.path(), "Dune", "01.m4b", b"identical bytes");
    let backup = write_book(root.path(), "Backup/Dune", "01.m4b", b"identical bytes");

    let mut identities = super::LibraryIdentityStore::default();
    let before = resolve_scan(
        &mut identities,
        &[
            IdentityFixture::read("Dune", std::slice::from_ref(&main)).with_duration(3600.0),
            IdentityFixture::read("Backup/Dune", std::slice::from_ref(&backup))
                .with_duration(3600.0),
        ],
    );

    // Only the main copy is remuxed. Its bytes change; the backup's do not.
    std::fs::write(&main, b"faststart layout, same audio, other bytes").unwrap();
    let after = resolve_scan(
        &mut identities,
        &[
            IdentityFixture::read("Dune", std::slice::from_ref(&main)).with_duration(3600.0),
            IdentityFixture::read("Backup/Dune", std::slice::from_ref(&backup))
                .with_duration(3600.0),
        ],
    );

    assert_eq!(
        after[0].0, before[0].0,
        "the remuxed copy keeps its identity even though its twin still holds the old digest"
    );
    assert_eq!(after[1].0, before[1].0, "the untouched copy is unaffected");
}

/// Unreadable tags look exactly like a replacement. Once a book's runtime is
/// known, a scan that cannot produce one must not be waved through the
/// path-only tier.
#[test]
fn the_path_tier_closes_when_a_known_duration_goes_missing() {
    let root = tempfile::tempdir().unwrap();
    let track = write_book(root.path(), "Book", "01.m4b", b"original container");

    let mut identities = super::LibraryIdentityStore::default();
    let before = resolve_scan(
        &mut identities,
        &[IdentityFixture::read("Book", std::slice::from_ref(&track)).with_duration(3600.0)],
    );

    std::fs::write(&track, b"different content, unreadable tags").unwrap();
    let after = resolve_scan(
        &mut identities,
        // No duration this time.
        &[IdentityFixture::read("Book", std::slice::from_ref(&track))],
    );
    assert_ne!(
        after[0].0, before[0].0,
        "a known duration that cannot be confirmed closes the path tier"
    );
}

/// "Three consecutive scans" has to mean three scans that actually saw the
/// library. A drive alternating between readable and unreadable must never
/// accumulate its way to confirming a reduction it never demonstrated.
#[test]
fn a_traversal_error_interrupts_a_shrink_run() {
    let mut identities = super::LibraryIdentityStore::default();
    identities.manifests.insert(
        super::DEFAULT_ROOT_ID.to_string(),
        super::RootManifest {
            book_fingerprints: (0..100).map(|index| format!("fp{index}")).collect(),
            scan: 1,
        },
    );
    identities.pending_shrink.insert(
        super::DEFAULT_ROOT_ID.to_string(),
        super::PendingShrink {
            book_count: 20,
            signature: super::scan_signature(&book_aliases(20)),
            observations: super::SHRINK_CONFIRMATIONS - 1,
        },
    );
    let root = std::path::Path::new("/library");

    // The errored scan clears the run rather than leaving it standing.
    let verdict = super::assess_scan(
        &identities,
        super::DEFAULT_ROOT_ID,
        &book_aliases(20),
        &["I/O error".to_string()],
        root,
    );
    assert!(matches!(
        verdict,
        super::ScanVerdict::Withhold {
            record_shrink: None
        }
    ));
    identities.pending_shrink.remove(super::DEFAULT_ROOT_ID);

    assert!(
        !super::assess_scan(
            &identities,
            super::DEFAULT_ROOT_ID,
            &book_aliases(20),
            &[],
            root
        )
        .commits(),
        "after an interruption the run starts again rather than completing"
    );
}

/// An identity wanted by one certain group and one uncertain group is still
/// contested. Counting only the certain group's claim would hand it over on
/// evidence that is not actually exclusive.
///
/// The store is built by hand because the shape needed — one identity
/// remembering two aliases, a second identity sharing one of them and the same
/// digest — takes several scans to arrive at through the filesystem and is
/// clearer stated directly.
#[test]
fn an_identity_two_groups_can_claim_is_not_given_to_the_certain_one() {
    let shared = "shared-digest".to_string();
    let mut identities = super::LibraryIdentityStore {
        version: super::IDENTITY_FORMAT_VERSION,
        ..Default::default()
    };
    // I1 has lived at both aliases, so it is a candidate at either.
    identities.books.push(super::BookIdentity {
        fingerprint: shared.clone(),
        fingerprint_history: Vec::new(),
        book_id: "identity-one".to_string(),
        paths: vec![
            super::IdentityPath::new(super::DEFAULT_ROOT_ID, "X"),
            super::IdentityPath::new(super::DEFAULT_ROOT_ID, "Y"),
        ],
        tracks: Vec::new(),
        last_seen_scan: 1,
        track_count: 1,
        duration_seconds: Some(3600.0),
    });
    // I2 sits at Y with the same digest, so Y has two candidates while X has one.
    identities.books.push(super::BookIdentity {
        fingerprint: shared.clone(),
        fingerprint_history: Vec::new(),
        book_id: "identity-two".to_string(),
        paths: vec![super::IdentityPath::new(super::DEFAULT_ROOT_ID, "Y")],
        tracks: Vec::new(),
        last_seen_scan: 1,
        track_count: 1,
        duration_seconds: Some(3600.0),
    });
    identities.scan_counter = 1;

    let root = tempfile::tempdir().unwrap();
    let x_file = write_book(root.path(), "X", "01.mp3", b"x");
    let y_file = write_book(root.path(), "Y", "01.mp3", b"y");

    let mut at_x = IdentityFixture::read("X", std::slice::from_ref(&x_file));
    at_x.book_fingerprint = shared.clone();
    let mut at_y = IdentityFixture::read("Y", std::slice::from_ref(&y_file));
    at_y.book_fingerprint = shared.clone();

    let groups = [&at_x, &at_y]
        .iter()
        .map(|fixture| super::ScannedGroup {
            book_fingerprint: &fixture.book_fingerprint,
            group_alias: &fixture.alias,
            root_id: super::DEFAULT_ROOT_ID,
            grouped_files: &fixture.files,
            track_fingerprints: &fixture.track_fingerprints,
            track_aliases: &fixture.track_aliases,
            duration_seconds: fixture.duration_seconds,
        })
        .collect::<Vec<_>>();

    let resolved = super::resolve_library_identities(
        &mut identities,
        &groups,
        &mut (super::mint_identity_id as fn() -> String),
    );

    // X's only candidate is I1 — but I1 is equally a candidate at Y, so the
    // claim is not exclusive and must not be granted on that basis.
    assert_ne!(
        resolved[0].0, "identity-one",
        "an identity another group can also claim is still contested"
    );
    assert_ne!(
        resolved[1].0, "identity-one",
        "and the contested identity goes to neither group"
    );
}

/// A mount returning a different twenty books each time has not demonstrated
/// anything about the library's real size, however many times it does it.
/// Confirmation compares which books were found, not how many.
#[test]
fn a_shrink_confirms_only_when_the_same_books_are_found() {
    let mut identities = super::LibraryIdentityStore::default();
    identities.manifests.insert(
        super::DEFAULT_ROOT_ID.to_string(),
        super::RootManifest {
            book_fingerprints: (0..100).map(|index| format!("fp{index}")).collect(),
            scan: 1,
        },
    );
    let root = std::path::Path::new("/library");

    // Twenty books, but a different twenty every time.
    for round in 0..(super::SHRINK_CONFIRMATIONS + 2) {
        let aliases = (0..20)
            .map(|index| format!("Book {}", index + round * 20))
            .collect::<Vec<_>>();
        let verdict = super::assess_scan(&identities, super::DEFAULT_ROOT_ID, &aliases, &[], root);
        assert!(
            !verdict.commits(),
            "a different set of books each time never confirms (round {round})"
        );
        if let super::ScanVerdict::Withhold {
            record_shrink: Some((count, signature)),
        } = verdict
        {
            let pending = identities
                .pending_shrink
                .entry(super::DEFAULT_ROOT_ID.to_string())
                .or_default();
            pending.book_count = count;
            pending.signature = signature;
            pending.observations += 1;
        }
    }

    // The same twenty, repeated, does confirm.
    let steady = book_aliases(20);
    for _ in 0..super::SHRINK_CONFIRMATIONS.saturating_sub(1) {
        let verdict = super::assess_scan(&identities, super::DEFAULT_ROOT_ID, &steady, &[], root);
        if let super::ScanVerdict::Withhold {
            record_shrink: Some((count, signature)),
        } = verdict
        {
            let pending = identities
                .pending_shrink
                .entry(super::DEFAULT_ROOT_ID.to_string())
                .or_default();
            if pending.signature == signature {
                pending.observations += 1;
            } else {
                pending.book_count = count;
                pending.signature = signature;
                pending.observations = 1;
            }
        }
    }
    assert!(
        super::assess_scan(&identities, super::DEFAULT_ROOT_ID, &steady, &[], root).commits(),
        "a stable reduced library is eventually accepted"
    );
}
