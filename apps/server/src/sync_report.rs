//! Per-chapter grades for follow-along sync maps. A report is kept beside the
//! generated maps in the data dir, never beside the audio, so the published
//! map format and users' own sidecar maps are left untouched.

use crate::*;
use std::sync::atomic::{AtomicBool, Ordering};

/// Good: nearly all of the chapter's text is highlighted, and the reader
/// rarely has to hold its place over audio no sentence was matched to.
const GOOD_COVERAGE: f64 = 0.95;
const GOOD_GAP_SHARE: f64 = 0.05;
/// Review: usable, but worth listening to. Anything worse is Poor.
const REVIEW_COVERAGE: f64 = 0.80;
const REVIEW_GAP_SHARE: f64 = 0.20;

/// Title cards and back matter are too short to say much about a book, so
/// they keep their own grade but do not set the book's.
const MIN_BOOK_GRADE_SECONDS: f64 = 120.0;

const REPORT_SUFFIX: &str = ".report.json";

/// Ordered best to worst, so a book's grade is its chapters' maximum.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Grade {
    Good,
    Review,
    Poor,
}

/// `estimate` grades an existing map without its run's record of text that
/// was deliberately left unmatched, so it can be slightly pessimistic.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Graded {
    Run,
    Estimate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ChapterStatus {
    Aligned,
    /// The chapter has no text to align, such as a picture-only section.
    Empty,
}

/// What a run learned about one scope beyond its fragments and gaps. Saved
/// in the checkpoint so a resumed run grades the scopes it did not repeat.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScopeOutcome {
    pub(crate) skipped_text: u64,
}

/// Which map a report describes. A report is current only while the served
/// map still has this generation time and size.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MapIdentity {
    pub(crate) map_generated_at: Option<String>,
    pub(crate) map_size: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChapterReport {
    pub(crate) index: usize,
    pub(crate) label: String,
    /// Book time.
    pub(crate) start_seconds: f64,
    pub(crate) end_seconds: f64,
    pub(crate) text_coverage: f64,
    pub(crate) gap_seconds: f64,
    pub(crate) skipped_text: u64,
    pub(crate) status: ChapterStatus,
    /// Derived whenever a report is built or read, so changed thresholds
    /// apply to every existing report.
    #[serde(default, skip_deserializing)]
    pub(crate) grade: Option<Grade>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncReport {
    #[serde(flatten)]
    pub(crate) map: MapIdentity,
    pub(crate) graded: Graded,
    #[serde(default, skip_deserializing)]
    pub(crate) grade: Option<Grade>,
    pub(crate) chapters: Vec<ChapterReport>,
}

/// The compact summary a book listing carries.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncQuality {
    pub(crate) grade: Grade,
    /// Chapters graded below Good.
    pub(crate) flagged: usize,
}

impl SyncReport {
    pub(crate) fn new(map: MapIdentity, graded: Graded, chapters: Vec<ChapterReport>) -> Self {
        let mut report = Self {
            map,
            graded,
            grade: None,
            chapters,
        };
        report.regrade();
        report
    }

    fn regrade(&mut self) {
        for chapter in &mut self.chapters {
            chapter.grade = chapter_grade(chapter);
        }
        let worst = |long_only: bool| {
            self.chapters
                .iter()
                .filter(|c| !long_only || c.end_seconds - c.start_seconds >= MIN_BOOK_GRADE_SECONDS)
                .filter_map(|c| c.grade)
                .max()
        };
        self.grade = worst(true).or_else(|| worst(false));
    }

    pub(crate) fn quality(&self) -> Option<SyncQuality> {
        Some(SyncQuality {
            grade: self.grade?,
            flagged: self
                .chapters
                .iter()
                .filter(|chapter| chapter.grade.is_some_and(|grade| grade > Grade::Good))
                .count(),
        })
    }
}

fn chapter_grade(chapter: &ChapterReport) -> Option<Grade> {
    if chapter.status == ChapterStatus::Empty {
        return None;
    }
    let duration = chapter.end_seconds - chapter.start_seconds;
    let gap_share = if duration > 0.0 {
        chapter.gap_seconds / duration
    } else {
        0.0
    };
    Some(
        if chapter.text_coverage >= GOOD_COVERAGE && gap_share <= GOOD_GAP_SHARE {
            Grade::Good
        } else if chapter.text_coverage >= REVIEW_COVERAGE && gap_share <= REVIEW_GAP_SHARE {
            Grade::Review
        } else {
            Grade::Poor
        },
    )
}

/// How much text a passage holds, for coverage. Transcripts join sections
/// with blank lines and keep the EPUB's spacing, while fragments carry
/// whitespace-collapsed sentences, so only non-whitespace UTF-16 units are
/// comparable between the two.
pub(crate) fn text_units(text: &str) -> u64 {
    text.chars()
        .filter(|character| !character.is_whitespace())
        .map(|character| character.len_utf16() as u64)
        .sum()
}

/// One aligned scope as a report sees it: where it sits in the book and how
/// much text it was expected to highlight.
pub(crate) struct ChapterSpan {
    pub(crate) label: String,
    pub(crate) start_seconds: f64,
    /// Infinite when the audio's length is unknown.
    pub(crate) end_seconds: f64,
    pub(crate) text_units: u64,
    pub(crate) skipped_text: u64,
}

pub(crate) fn chapter_spans(
    epub: &alignment::EpubDocument,
    tracks: &[SyncTrackInput],
    scopes: &[SyncAlignmentScope],
    outcomes: &[ScopeOutcome],
) -> Vec<ChapterSpan> {
    scopes
        .iter()
        .enumerate()
        .map(|(index, scope)| ChapterSpan {
            label: scope.label.clone(),
            start_seconds: scope.time_offset_seconds,
            end_seconds: scope.time_offset_seconds
                + scope_audio_seconds(scope, tracks).unwrap_or(f64::INFINITY),
            text_units: text_units(&scope_transcript(epub, scope).text),
            skipped_text: outcomes
                .get(index)
                .map_or(0, |outcome| outcome.skipped_text),
        })
        .collect()
}

/// Grades each chapter from the map's sentences and the audio it could not
/// place. A sentence belongs to the chapter its start falls in; recovery gaps
/// are clipped to each chapter.
pub(crate) fn grade_chapters<'a>(
    spans: &[ChapterSpan],
    fragments: impl IntoIterator<Item = (f64, f64, &'a str)>,
    gaps: &[alignment::RecoveryGap],
) -> Vec<ChapterReport> {
    let mut order = (0..spans.len()).collect::<Vec<_>>();
    order.sort_by(|a, b| spans[*a].start_seconds.total_cmp(&spans[*b].start_seconds));
    let mut matched = vec![0u64; spans.len()];
    let mut last_end = vec![f64::NEG_INFINITY; spans.len()];
    for (start, end, text) in fragments {
        let Some(&index) = order
            .partition_point(|&index| spans[index].start_seconds <= start)
            .checked_sub(1)
            .map(|position| &order[position])
        else {
            continue;
        };
        if start < spans[index].end_seconds {
            matched[index] += text_units(text);
            last_end[index] = last_end[index].max(end);
        }
    }

    // Gaps can overlap where a scope's own gap meets one for unscoped audio.
    let mut merged: Vec<(f64, f64)> = Vec::with_capacity(gaps.len());
    let mut sorted = gaps
        .iter()
        .map(|gap| (gap.start_seconds, gap.end_seconds))
        .filter(|(start, end)| start.is_finite() && end.is_finite() && end > start)
        .collect::<Vec<_>>();
    sorted.sort_by(|a, b| a.0.total_cmp(&b.0));
    for (start, end) in sorted {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }

    spans
        .iter()
        .enumerate()
        .map(|(index, span)| {
            let start = span.start_seconds;
            let end = if span.end_seconds.is_finite() {
                span.end_seconds
            } else {
                merged
                    .iter()
                    .filter(|(gap_start, _)| *gap_start >= start)
                    .map(|(_, gap_end)| *gap_end)
                    .fold(last_end[index], f64::max)
                    .max(start)
            };
            let gap_seconds = merged
                .iter()
                .map(|(gap_start, gap_end)| (gap_end.min(end) - gap_start.max(start)).max(0.0))
                // `sum` of nothing is -0.0, which a client would print as "-0".
                .fold(0.0, |total, overlap| total + overlap)
                .min(end - start);
            let expected = span.text_units.saturating_sub(span.skipped_text);
            let status = if span.text_units == 0 {
                ChapterStatus::Empty
            } else {
                ChapterStatus::Aligned
            };
            ChapterReport {
                index,
                label: span.label.clone(),
                start_seconds: start,
                end_seconds: end,
                text_coverage: if expected == 0 {
                    1.0
                } else {
                    (matched[index] as f64 / expected as f64).clamp(0.0, 1.0)
                },
                gap_seconds,
                skipped_text: span.skipped_text,
                status,
                grade: None,
            }
        })
        .collect()
}

fn report_path(sync_dir: &FsPath, book_id: &str) -> Option<PathBuf> {
    is_plain_file_token(book_id).then(|| sync_dir.join(format!("{book_id}{REPORT_SUFFIX}")))
}

/// The book's report if it describes `map`. Reports are a few kilobytes, so
/// a scan can afford to read one per book.
pub(crate) fn read_current_report(
    sync_dir: &FsPath,
    book_id: &str,
    map: &MapIdentity,
) -> Option<SyncReport> {
    let bytes = std::fs::read(report_path(sync_dir, book_id)?).ok()?;
    let mut report = serde_json::from_slice::<SyncReport>(&bytes).ok()?;
    if &report.map != map {
        return None;
    }
    report.regrade();
    Some(report)
}

pub(crate) async fn write_report(
    sync_dir: &FsPath,
    book_id: &str,
    report: &SyncReport,
) -> Result<(), ApiError> {
    let path = report_path(sync_dir, book_id)
        .ok_or_else(|| ApiError::internal("The book id cannot name a sync report."))?;
    write_json_atomic(&path, report).await
}

/// Grades an existing map without speech recognition: the book is divided as
/// a run would divide it and the map's sentences and gaps are measured.
/// Chapter slicing is assumed available, since chapters are the most useful
/// grain even for a map that was aligned as one track.
pub(crate) fn estimate_report(
    epub_path: &FsPath,
    tracks: &[SyncTrackInput],
    map_path: &FsPath,
) -> anyhow::Result<SyncReport> {
    /// The parts of a map grading reads; word timings are skipped unparsed.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GradedMap {
        #[serde(default)]
        generated_at: Option<String>,
        fragments: Vec<GradedFragment>,
        #[serde(default)]
        recovery_gaps: Vec<alignment::RecoveryGap>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GradedFragment {
        start_seconds: f64,
        end_seconds: f64,
        text: String,
    }
    let bytes = std::fs::read(map_path)?;
    let map: GradedMap = serde_json::from_slice(&bytes)?;
    let identity = MapIdentity {
        map_generated_at: map.generated_at,
        map_size: bytes.len() as u64,
    };
    drop(bytes);
    let epub = alignment::parse_epub_file(epub_path)?;
    // A book that cannot be divided gets an empty report, so later scans do
    // not reread it until the map changes.
    let chapters = match plan_scopes(&epub, tracks, true) {
        Ok(plan) => grade_chapters(
            &chapter_spans(&epub, tracks, &plan.scopes, &[]),
            map.fragments
                .iter()
                .map(|f| (f.start_seconds, f.end_seconds, f.text.as_str())),
            &map.recovery_gaps,
        ),
        Err(_) => Vec::new(),
    };
    Ok(SyncReport::new(identity, Graded::Estimate, chapters))
}

/// Coalesces backfill requests: scans can finish in bursts, and one pass at a
/// time walks every map still missing a report.
#[derive(Default)]
pub(crate) struct Backfill {
    requested: AtomicBool,
    running: AtomicBool,
}

/// Grades, in the background, maps that a scan found without a current
/// report. Never blocks the scan that asked for it.
pub(crate) fn schedule_backfill(state: &AppState) {
    let backfill = state.sync_report_backfill.clone();
    backfill.requested.store(true, Ordering::SeqCst);
    if backfill.running.swap(true, Ordering::SeqCst) {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            while backfill.requested.swap(false, Ordering::SeqCst) {
                backfill_reports(&state).await;
            }
            backfill.running.store(false, Ordering::SeqCst);
            // A request landing between the last pass and the store above
            // found the pass still running; pick it up rather than drop it.
            if !backfill.requested.load(Ordering::SeqCst)
                || backfill.running.swap(true, Ordering::SeqCst)
            {
                return;
            }
        }
    });
}

async fn backfill_reports(state: &AppState) {
    let candidates = state
        .library
        .read()
        .await
        .books
        .iter()
        .filter(|book| {
            book.sync_file
                .as_ref()
                .is_some_and(|file| !file.report_current)
        })
        .map(|book| book.id.clone())
        .collect::<Vec<_>>();
    for book_id in candidates {
        // A running or paused sync is about to replace this map and will
        // grade its own result.
        let busy = state.jobs.read().await.values().any(|job| {
            job.kind == SYNC_GENERATE_JOB_KIND
                && job.target_id.as_deref() == Some(book_id.as_str())
                && (is_active_job(job) || job.status == "paused")
        });
        if busy {
            continue;
        }
        let (map_path, epub_path, tracks) = {
            let library = state.library.read().await;
            let Some(map_path) = library.sync_paths.get(&book_id).cloned() else {
                continue;
            };
            let Ok((epub_path, tracks)) = sync_inputs(&library, &book_id) else {
                continue;
            };
            (map_path, epub_path, tracks)
        };
        let graded =
            tokio::task::spawn_blocking(move || estimate_report(&epub_path, &tracks, &map_path))
                .await;
        let report = match graded {
            Ok(Ok(report)) => report,
            Ok(Err(error)) => {
                tracing::warn!(book_id, "could not grade sync map: {error:#}");
                continue;
            }
            Err(error) => {
                tracing::warn!(book_id, ?error, "sync map grading stopped");
                continue;
            }
        };
        if let Err(error) = write_report(&state.sync_dir, &book_id, &report).await {
            tracing::warn!(book_id, ?error, "could not save sync report");
            continue;
        }
        // The listing shows the grade now rather than after the next scan.
        let mut library = state.library.write().await;
        if let Some(file) = library
            .books
            .iter_mut()
            .find(|book| book.id == book_id)
            .and_then(|book| book.sync_file.as_mut())
        {
            file.quality = report.quality();
            file.report_current = true;
        }
    }
}

/// The chapter-by-chapter report for an administrator. 404 until the served
/// map has been graded.
pub(crate) async fn get_sync_report(
    State(state): State<AppState>,
    _: AdminUser,
    Path(book_id): Path<String>,
) -> Result<Json<SyncReport>, ApiError> {
    let map_path = {
        let library = state.library.read().await;
        library.book(&book_id)?;
        library
            .sync_paths
            .get(&book_id)
            .cloned()
            .ok_or_else(|| ApiError::not_found("Sync map not found"))?
    };
    let sync_dir = state.sync_dir.clone();
    tokio::task::spawn_blocking(move || {
        let map = probe_sync_map(&map_path, true)?.identity;
        read_current_report(&sync_dir, &book_id, &map)
    })
    .await
    .map_err(|error| ApiError::internal(error.to_string()))?
    .map(Json)
    .ok_or_else(|| ApiError::not_found("This book's sync has not been graded yet."))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span(start: f64, end: f64, text: &str, skipped: u64) -> ChapterSpan {
        ChapterSpan {
            label: format!("Chapter at {start}"),
            start_seconds: start,
            end_seconds: end,
            text_units: text_units(text),
            skipped_text: skipped,
        }
    }

    fn gap(start: f64, end: f64) -> alignment::RecoveryGap {
        alignment::RecoveryGap {
            start_seconds: start,
            end_seconds: end,
        }
    }

    fn graded(
        spans: &[ChapterSpan],
        fragments: &[(f64, &str)],
        gaps: &[alignment::RecoveryGap],
    ) -> SyncReport {
        SyncReport::new(
            MapIdentity {
                map_generated_at: Some("1".into()),
                map_size: 10,
            },
            Graded::Run,
            grade_chapters(
                spans,
                fragments
                    .iter()
                    .map(|(start, text)| (*start, start + 1.0, *text)),
                gaps,
            ),
        )
    }

    #[test]
    fn short_chapters_keep_their_grade_without_setting_the_books() {
        let text = "a".repeat(100);
        let report = graded(
            &[span(0.0, 60.0, &text, 0), span(60.0, 600.0, &text, 0)],
            &[(70.0, &text)],
            &[],
        );
        assert_eq!(report.chapters[0].grade, Some(Grade::Poor));
        assert_eq!(report.grade, Some(Grade::Good));
        assert_eq!(report.quality().unwrap().flagged, 1);
        // A book made only of short chapters is still graded by them.
        let short = graded(&[span(0.0, 60.0, &text, 0)], &[], &[]);
        assert_eq!(short.grade, Some(Grade::Poor));
    }

    #[test]
    fn whitespace_and_section_breaks_do_not_count_against_coverage() {
        let transcript = alignment::build_transcript(&[
            alignment::SpineSection {
                href: "a.xhtml".into(),
                text: "One   two.\n\nThree four.".into(),
            },
            alignment::SpineSection {
                href: "b.xhtml".into(),
                text: "Five six.".into(),
            },
        ]);
        let report = graded(
            &[span(0.0, 100.0, &transcript.text, 0)],
            &[(1.0, "One two."), (5.0, "Three four."), (9.0, "Five six.")],
            &[],
        );
        assert_eq!(report.chapters[0].text_coverage, 1.0);
        assert_eq!(report.chapters[0].grade, Some(Grade::Good));
    }

    #[test]
    fn sentences_are_assigned_by_start_and_gaps_are_clipped_to_each_chapter() {
        let text = "a".repeat(100);
        let half = "a".repeat(50);
        let report = graded(
            &[span(0.0, 100.0, &text, 0), span(100.0, 200.0, &text, 0)],
            // The second sentence starts in the first chapter and ends in the
            // next; one that starts before every chapter belongs to none.
            &[(-5.0, &half), (10.0, &half), (99.5, &half), (150.0, &half)],
            &[gap(90.0, 130.0), gap(120.0, 125.0), gap(250.0, 300.0)],
        );
        let [first, second] = &report.chapters[..] else {
            panic!("two chapters");
        };
        assert_eq!(first.text_coverage, 1.0);
        assert_eq!(second.text_coverage, 0.5);
        assert_eq!(first.gap_seconds, 10.0);
        assert_eq!(second.gap_seconds, 30.0);
        // 10% unmatched audio is Review even with every sentence matched.
        assert_eq!(first.grade, Some(Grade::Review));
        assert_eq!(second.grade, Some(Grade::Poor));
        assert_eq!(report.grade, Some(Grade::Poor));
        assert_eq!(
            report.quality(),
            Some(SyncQuality {
                grade: Grade::Poor,
                flagged: 2
            })
        );
    }

    #[test]
    fn grade_thresholds() {
        let text = "a".repeat(100);
        for (matched, gap_seconds, expected) in [
            (95, 5.0, Grade::Good),
            (100, 5.1, Grade::Review),
            (94, 0.0, Grade::Review),
            (80, 20.0, Grade::Review),
            (79, 0.0, Grade::Poor),
            (100, 20.5, Grade::Poor),
        ] {
            let matched = "a".repeat(matched);
            let report = graded(
                &[span(0.0, 100.0, &text, 0)],
                &[(1.0, &matched)],
                &[gap(50.0, 50.0 + gap_seconds)],
            );
            assert_eq!(
                report.chapters[0].grade,
                Some(expected),
                "{matched} {gap_seconds}"
            );
        }
    }

    #[test]
    fn skipped_edition_text_does_not_lower_coverage() {
        let text = "a".repeat(100);
        let spoken = "a".repeat(70);
        let report = graded(&[span(0.0, 100.0, &text, 30)], &[(1.0, &spoken)], &[]);
        assert_eq!(report.chapters[0].text_coverage, 1.0);
        assert_eq!(report.chapters[0].skipped_text, 30);
        assert_eq!(report.grade, Some(Grade::Good));
        let unskipped = graded(&[span(0.0, 100.0, &text, 0)], &[(1.0, &spoken)], &[]);
        assert_eq!(unskipped.grade, Some(Grade::Poor));
    }

    #[test]
    fn empty_chapters_have_no_grade_and_unknown_lengths_end_at_the_last_timing() {
        let report = graded(
            &[
                span(0.0, 10.0, " \n\n ", 0),
                span(10.0, f64::INFINITY, "abc def", 0),
            ],
            &[(12.0, "abc"), (20.0, "def")],
            &[gap(15.0, 16.0)],
        );
        assert_eq!(report.chapters[0].status, ChapterStatus::Empty);
        assert_eq!(report.chapters[0].grade, None);
        assert_eq!(report.chapters[1].end_seconds, 21.0);
        assert_eq!(report.chapters[1].gap_seconds, 1.0);
        assert_eq!(report.grade, Some(Grade::Review));
        let json = serde_json::to_value(&report).unwrap();
        assert!(json["chapters"][1]["endSeconds"].is_number(), "{json}");
    }

    /// Opt-in estimate of a real map. Reads the EPUB, audio tags and map
    /// named by the environment; writes nothing.
    #[test]
    #[ignore = "manual real-book grading probe"]
    fn manual_real_map_grading_probe() {
        let var = |name: &str| PathBuf::from(std::env::var_os(name).unwrap());
        let audio = var("OPERALIBRE_PROBE_AUDIO");
        let metadata = read_track_metadata(&audio);
        let tracks = [SyncTrackInput {
            path: audio,
            title: metadata.title.unwrap_or_else(|| "Book".into()),
            duration_seconds: metadata.duration_seconds,
            chapters: metadata
                .chapters
                .into_iter()
                .map(|chapter| SyncChapterInput {
                    title: chapter.title,
                    start_seconds: chapter.start_seconds,
                    end_seconds: chapter.end_seconds,
                })
                .collect(),
        }];
        let report = estimate_report(
            &var("OPERALIBRE_PROBE_EPUB"),
            &tracks,
            &var("OPERALIBRE_PROBE_MAP"),
        )
        .unwrap();
        let count = |grade| {
            report
                .chapters
                .iter()
                .filter(|c| c.grade == Some(grade))
                .count()
        };
        println!(
            "grade={:?} chapters={} good={} review={} poor={} empty={}",
            report.grade,
            report.chapters.len(),
            count(Grade::Good),
            count(Grade::Review),
            count(Grade::Poor),
            report.chapters.iter().filter(|c| c.grade.is_none()).count()
        );
        let mut worst = report.chapters.iter().collect::<Vec<_>>();
        worst.sort_by(|a, b| {
            b.grade
                .cmp(&a.grade)
                .then(a.text_coverage.total_cmp(&b.text_coverage))
        });
        for chapter in worst.iter().take(8) {
            println!(
                "{:>3} {:<32} {:?} coverage={:.3} gap={:.0}s/{:.0}s",
                chapter.index,
                chapter.label,
                chapter.grade,
                chapter.text_coverage,
                chapter.gap_seconds,
                chapter.end_seconds - chapter.start_seconds
            );
        }
    }

    #[tokio::test]
    async fn a_report_is_current_only_for_the_map_it_graded() {
        let root = tempfile::tempdir().unwrap();
        let report = graded(&[span(0.0, 10.0, "abc", 0)], &[(1.0, "abc")], &[]);
        write_report(root.path(), "book", &report).await.unwrap();
        let read = read_current_report(root.path(), "book", &report.map).unwrap();
        assert_eq!(read.grade, Some(Grade::Good));
        assert_eq!(read.chapters[0].grade, Some(Grade::Good));
        for stale in [
            MapIdentity {
                map_generated_at: Some("2".into()),
                map_size: 10,
            },
            MapIdentity {
                map_generated_at: Some("1".into()),
                map_size: 11,
            },
            MapIdentity {
                map_generated_at: None,
                map_size: 10,
            },
        ] {
            assert!(read_current_report(root.path(), "book", &stale).is_none());
        }
        assert!(read_current_report(root.path(), "../book", &report.map).is_none());
    }
}
