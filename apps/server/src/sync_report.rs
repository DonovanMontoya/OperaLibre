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
    /// The chapter's last run could not align it.
    Failed,
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
    /// Alignment failed and the chapter has no sentences; readers hold their
    /// place through it.
    Failed,
    /// Alignment failed and the chapter keeps the previous map's sentences.
    KeptPrevious,
}

/// What a run learned about one scope beyond its fragments and gaps. Saved
/// in the checkpoint so a resumed run grades the scopes it did not repeat,
/// and neither repeats nor forgets the fixes it already tried.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScopeOutcome {
    pub(crate) skipped_text: u64,
    /// Why the scope could not be aligned, in full.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
    #[serde(default)]
    pub(crate) evidence: ScopeEvidence,
    /// Automatic fixes this run tried, each at most once.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) fixes: Vec<Cause>,
    /// The automatic fix whose result the scope now has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) fixed: Option<Cause>,
    /// Another scope whose text this scope's audio was aligned with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) paired_with: Option<usize>,
}

/// What speech recognition heard in one scope: enough to tell noise from the
/// wrong text, without keeping the transcript.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ScopeEvidence {
    pub(crate) windows: u32,
    pub(crate) unanchored_windows: u32,
    pub(crate) recognition_retries: u32,
    pub(crate) recognized_words: u32,
    /// Audio those words were heard in; overlapping scans count twice, as
    /// their words do.
    pub(crate) recognized_seconds: f64,
    /// Recognized three-word runs, and how many of them the scope's text has.
    pub(crate) word_runs: u32,
    pub(crate) word_runs_in_text: u32,
    /// The first recognized words, normalized, to look for elsewhere in the
    /// book when they are not in this scope's text.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) opening: String,
    /// The language a sample of the audio was detected as.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) heard_language: Option<String>,
    /// A scope whose text the opening matches clearly better.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) matching_scope: Option<usize>,
}

impl ScopeEvidence {
    pub(crate) fn words_in_text(&self) -> Option<f64> {
        (self.word_runs > 0).then(|| f64::from(self.word_runs_in_text) / f64::from(self.word_runs))
    }
}

/// Why a chapter could not be aligned, or aligned badly, as a stable code a
/// client turns into its own words.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Cause {
    RuntimeCrash,
    NoisyAudio,
    ChapterMismatch,
    LanguageMismatch,
    EditionMismatch,
    RuntimeMissing,
    AudioUnreadable,
    Timeout,
    LanguageGuess,
    Unknown,
}

/// Names the cause of a failed alignment from its error text, which is all
/// the alignment runtime and ffmpeg report.
pub(crate) fn classify_error(error: &str) -> Cause {
    let has = |needle: &str| error.contains(needle);
    if has("Failed to run alignment CLI") || has("Failed to run ffmpeg") {
        Cause::RuntimeMissing
    } else if has("command timeout") || has("timed out") {
        Cause::Timeout
    } else if has("ffmpeg failed to extract") {
        Cause::AudioUnreadable
    } else if has("language identifier") {
        Cause::LanguageGuess
    } else if has("stopped without writing a result")
        // Older releases reported the missing result file this way.
        || has("(os error 2)")
        || killed_by_signal(error)
    {
        Cause::RuntimeCrash
    } else if has("stalled at") || has("produced no usable sentence fragments") {
        // Recognition never got past one point in the text.
        Cause::NoisyAudio
    } else {
        Cause::Unknown
    }
}

/// A process that died of a signal, directly or as a shell's 128 + signal
/// exit code: an abort, an out-of-memory kill, or a segfault.
fn killed_by_signal(error: &str) -> bool {
    let Some((_, status)) = error.split_once("failed with status ") else {
        return false;
    };
    let exit_code = status
        .strip_prefix("exit status: ")
        .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next());
    status.starts_with("signal") || matches!(exit_code, Some("134" | "137" | "139"))
}

/// Recognized speech this dense or denser is narration, not music or noise.
/// Narrators read about 150 words a minute.
const PLENTIFUL_WORDS_PER_MINUTE: f64 = 80.0;
/// Below this share of its three-word runs in the text, clear speech is not
/// this text. A weak recognizer on hard audio still lands most runs in the
/// right text, while unrelated prose shares only stock phrases.
pub(crate) const EDITION_WORDS_IN_TEXT: f64 = 0.25;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum FixKind {
    /// Tried by the run itself.
    Auto,
    /// Offered to an administrator; never applied on its own.
    Suggested,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum FixAction {
    RetryOtherModel,
    LargerModel,
    MatchOtherChapter,
    ResyncLanguage,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Fix {
    pub(crate) kind: FixKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) action: Option<FixAction>,
    /// An automatic fix this run already tried.
    #[serde(default)]
    pub(crate) attempted: bool,
    /// The chapter's timing now comes from that fix.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) applied: bool,
}

/// What a client can show for a diagnosis: only the measures that informed it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosisEvidence {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) heard_language: Option<String>,
    /// The language recognition was told to expect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) labelled_language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) matching_chapter: Option<JobChapter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) recognized_words: Option<u32>,
    /// Share of recognized three-word runs found in the chapter's text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) words_in_text: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) windows: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) unanchored_windows: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) recognition_retries: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Diagnosis {
    pub(crate) cause: Cause,
    pub(crate) evidence: DiagnosisEvidence,
    pub(crate) fix: Fix,
}

/// Everything known about one chapter when it is diagnosed.
pub(crate) struct ChapterEvidence<'a> {
    pub(crate) grade: Option<Grade>,
    pub(crate) outcome: &'a ScopeOutcome,
    /// The language recognition was told to expect.
    pub(crate) language: Option<&'a str>,
    /// Every scope's label, to name another chapter the audio belongs to.
    pub(crate) labels: &'a [String],
}

fn primary_language(code: &str) -> String {
    code.split(['-', '_'])
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

/// Whether two language tags name the same language. EPUBs may use
/// three-letter codes where the recognizer reports two, as `eng` for `en`.
pub(crate) fn same_language(a: &str, b: &str) -> bool {
    const THREE_LETTER: [(&str, &str); 22] = [
        ("eng", "en"),
        ("nld", "nl"),
        ("dut", "nl"),
        ("fra", "fr"),
        ("fre", "fr"),
        ("deu", "de"),
        ("ger", "de"),
        ("spa", "es"),
        ("ita", "it"),
        ("por", "pt"),
        ("rus", "ru"),
        ("jpn", "ja"),
        ("zho", "zh"),
        ("chi", "zh"),
        ("kor", "ko"),
        ("pol", "pl"),
        ("swe", "sv"),
        ("nor", "no"),
        ("dan", "da"),
        ("fin", "fi"),
        ("tur", "tr"),
        ("ukr", "uk"),
    ];
    let two_letter = |code: &str| {
        let code = primary_language(code);
        THREE_LETTER
            .iter()
            .find(|(three, _)| *three == code)
            .map_or(code, |(_, two)| two.to_string())
    };
    two_letter(a) == two_letter(b)
}

/// Says why a Poor or Failed chapter went wrong, or which automatic fix a
/// chapter's timing came from. A chapter that went well, or a Poor one with
/// no recognition evidence, such as a graded estimate, has no diagnosis.
pub(crate) fn diagnose_chapter(chapter: &ChapterEvidence) -> Option<Diagnosis> {
    let outcome = chapter.outcome;
    let evidence = &outcome.evidence;
    let flagged = chapter.grade.is_some_and(|grade| grade >= Grade::Poor);
    let heard_other_language = evidence
        .heard_language
        .as_deref()
        .zip(chapter.language)
        .is_some_and(|(heard, expected)| !same_language(heard, expected));
    let words_per_minute =
        f64::from(evidence.recognized_words) / (evidence.recognized_seconds / 60.0);
    let cause = match (flagged, outcome.fixed) {
        (false, Some(fixed)) => fixed,
        (false, None) => return None,
        (true, _) => match outcome.error.as_deref().map(classify_error) {
            Some(cause) if cause != Cause::NoisyAudio => cause,
            error => {
                if error.is_none() && evidence.windows == 0 {
                    return None;
                }
                if heard_other_language {
                    Cause::LanguageMismatch
                } else if evidence.matching_scope.is_some() {
                    Cause::ChapterMismatch
                } else if words_per_minute >= PLENTIFUL_WORDS_PER_MINUTE
                    && evidence
                        .words_in_text()
                        .is_some_and(|share| share < EDITION_WORDS_IN_TEXT)
                {
                    Cause::EditionMismatch
                } else {
                    Cause::NoisyAudio
                }
            }
        },
    };
    let (kind, action) = match cause {
        Cause::RuntimeCrash => (FixKind::Auto, Some(FixAction::RetryOtherModel)),
        Cause::NoisyAudio => (FixKind::Auto, Some(FixAction::LargerModel)),
        Cause::ChapterMismatch => (FixKind::Auto, Some(FixAction::MatchOtherChapter)),
        Cause::LanguageMismatch => (FixKind::Suggested, Some(FixAction::ResyncLanguage)),
        _ => (FixKind::None, None),
    };
    let measured = evidence.windows > 0;
    Some(Diagnosis {
        cause,
        evidence: DiagnosisEvidence {
            heard_language: evidence.heard_language.clone(),
            labelled_language: chapter
                .language
                .filter(|_| evidence.heard_language.is_some())
                .map(str::to_string),
            matching_chapter: evidence
                .matching_scope
                .or(outcome.paired_with)
                .and_then(|index| {
                    Some(JobChapter {
                        index,
                        label: chapter.labels.get(index)?.clone(),
                        cause: None,
                    })
                }),
            recognized_words: measured.then_some(evidence.recognized_words),
            words_in_text: evidence.words_in_text(),
            windows: measured.then_some(evidence.windows),
            unanchored_windows: measured.then_some(evidence.unanchored_windows),
            recognition_retries: measured.then_some(evidence.recognition_retries),
        },
        fix: Fix {
            kind,
            action,
            attempted: outcome.fixes.contains(&cause),
            applied: outcome.fixed == Some(cause),
        },
    })
}

/// A run with nothing to publish, for a reason its chapters' diagnoses share,
/// such as a whole book read in another language or from another edition.
#[derive(Debug)]
pub(crate) struct DiagnosedFailure {
    pub(crate) cause: Cause,
    pub(crate) heard_language: Option<String>,
    pub(crate) message: String,
}

impl std::fmt::Display for DiagnosedFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DiagnosedFailure {}

impl DiagnosedFailure {
    /// Names the cause most of `chapters` were diagnosed with, if any were.
    pub(crate) fn from_chapters(chapters: &[ChapterReport], message: String) -> anyhow::Error {
        let diagnoses = chapters
            .iter()
            .filter_map(|chapter| chapter.diagnosis.as_ref())
            .collect::<Vec<_>>();
        let common = diagnoses.iter().max_by_key(|diagnosis| {
            diagnoses
                .iter()
                .filter(|other| other.cause == diagnosis.cause)
                .count()
        });
        match common {
            Some(diagnosis) => Self {
                cause: diagnosis.cause,
                heard_language: diagnosis.evidence.heard_language.clone(),
                message,
            }
            .into(),
            None => anyhow::anyhow!(message),
        }
    }
}

/// Diagnoses every chapter a run graded from its scope outcomes.
pub(crate) fn diagnose_chapters(
    chapters: &mut [ChapterReport],
    outcomes: &[ScopeOutcome],
    labels: &[String],
    language: Option<&str>,
) {
    for chapter in chapters {
        let Some(outcome) = outcomes.get(chapter.index) else {
            continue;
        };
        chapter.diagnosis = diagnose_chapter(&ChapterEvidence {
            grade: chapter_grade(chapter),
            outcome,
            language,
            labels,
        });
    }
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
    /// The first line of why the chapter could not be aligned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
    /// The whole error when it runs past its first line, kept for working
    /// out what went wrong.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) error_detail: Option<String>,
    /// Why a chapter graded Poor or Failed, or which automatic fix its
    /// timing came from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) diagnosis: Option<Diagnosis>,
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

pub(crate) fn chapter_grade(chapter: &ChapterReport) -> Option<Grade> {
    match chapter.status {
        ChapterStatus::Empty => return None,
        ChapterStatus::Failed | ChapterStatus::KeptPrevious => return Some(Grade::Failed),
        ChapterStatus::Aligned => {}
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
#[derive(Clone)]
pub(crate) struct ChapterSpan {
    pub(crate) label: String,
    pub(crate) start_seconds: f64,
    /// Infinite when the audio's length is unknown.
    pub(crate) end_seconds: f64,
    pub(crate) text_units: u64,
    pub(crate) skipped_text: u64,
    pub(crate) error: Option<String>,
}

impl ChapterSpan {
    pub(crate) fn range(&self) -> std::ops::Range<f64> {
        self.start_seconds..self.end_seconds
    }
}

/// The scopes as a report grades them, before any run.
pub(crate) fn chapter_spans(
    epub: &alignment::EpubDocument,
    tracks: &[SyncTrackInput],
    scopes: &[SyncAlignmentScope],
) -> Vec<ChapterSpan> {
    scopes
        .iter()
        .map(|scope| ChapterSpan {
            label: scope.label.clone(),
            start_seconds: scope.time_offset_seconds,
            end_seconds: scope.time_offset_seconds
                + scope_audio_seconds(scope, tracks).unwrap_or(f64::INFINITY),
            text_units: text_units(&scope_transcript(epub, scope).text),
            skipped_text: 0,
            error: None,
        })
        .collect()
}

/// A scope as a run left it. A scope aligned with another scope's text is
/// measured against that text.
pub(crate) fn with_outcome(
    spans: &[ChapterSpan],
    index: usize,
    outcome: &ScopeOutcome,
) -> ChapterSpan {
    let span = &spans[index];
    ChapterSpan {
        text_units: outcome
            .paired_with
            .and_then(|other| spans.get(other))
            .map_or(span.text_units, |other| other.text_units),
        skipped_text: outcome.skipped_text,
        error: outcome.error.clone(),
        ..span.clone()
    }
}

pub(crate) fn with_outcomes(spans: &[ChapterSpan], outcomes: &[ScopeOutcome]) -> Vec<ChapterSpan> {
    (0..spans.len())
        .map(|index| match outcomes.get(index) {
            Some(outcome) => with_outcome(spans, index, outcome),
            None => spans[index].clone(),
        })
        .collect()
}

/// Grades each chapter from the map's sentences and the audio it could not
/// place. A sentence belongs to the chapter its start falls in; recovery gaps
/// are clipped to each chapter. A chapter whose run failed but still has
/// sentences kept them from an earlier map.
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
            let status = match &span.error {
                _ if span.text_units == 0 => ChapterStatus::Empty,
                None => ChapterStatus::Aligned,
                Some(_) if matched[index] > 0 => ChapterStatus::KeptPrevious,
                Some(_) => ChapterStatus::Failed,
            };
            let error = span
                .error
                .as_deref()
                .map(|error| error.lines().next().unwrap_or_default().to_string());
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
                error_detail: span
                    .error
                    .clone()
                    .filter(|detail| Some(detail) != error.as_ref()),
                error,
                diagnosis: None,
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

/// Saves a report and shows its grade in the book listing now rather than
/// after the next scan.
pub(crate) async fn publish_report(
    state: &AppState,
    book_id: &str,
    report: &SyncReport,
) -> Result<(), ApiError> {
    write_report(&state.sync_dir, book_id, report).await?;
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
    Ok(())
}

pub(crate) const BOOK_CHANGED: &str =
    "This book changed since its last full sync. Re-sync the whole book.";

/// The served map a chapter re-run splices into, and the report it updates.
pub(crate) struct RerunBase {
    pub(crate) map: MapIdentity,
    pub(crate) report: SyncReport,
    pub(crate) chapters: Vec<JobChapter>,
}

/// Re-running chapters is safe only while the book still divides into exactly
/// the chapters the served map's report describes; otherwise their sentences
/// would be spliced over the wrong stretch of audio.
pub(crate) fn rerun_base(
    sync_dir: &FsPath,
    book_id: &str,
    map_path: &FsPath,
    spans: &[ChapterSpan],
    chapters: &[usize],
) -> Result<RerunBase, &'static str> {
    let map = probe_sync_map(map_path, true).ok_or(BOOK_CHANGED)?.identity;
    let report = read_current_report(sync_dir, book_id, &map).ok_or(
        "This book’s chapter grades are still being updated. Try again shortly, or re-sync the whole book.",
    )?;
    let same_time = |a: f64, b: f64| (a - b).abs() < 1e-6;
    let unchanged = report.chapters.len() == spans.len()
        && report.chapters.iter().zip(spans).all(|(chapter, span)| {
            chapter.label == span.label
                && same_time(chapter.start_seconds, span.start_seconds)
                // An unknown length ends where the map's timing does.
                && (!span.end_seconds.is_finite()
                    || same_time(chapter.end_seconds, span.end_seconds))
        });
    if !unchanged {
        return Err(BOOK_CHANGED);
    }
    let chapters = chapters
        .iter()
        .map(|&index| {
            report
                .chapters
                .get(index)
                .map(|chapter| JobChapter {
                    index,
                    label: chapter.label.clone(),
                    cause: None,
                })
                .ok_or(BOOK_CHANGED)
        })
        .collect::<Result<_, _>>()?;
    Ok(RerunBase {
        map,
        report,
        chapters,
    })
}

/// A map's timing inside one chapter: the sentences that start there, and
/// recovery gaps clipped to it.
pub(crate) fn chapter_timing(
    map: &alignment::SyncMap,
    range: &std::ops::Range<f64>,
) -> (Vec<alignment::SyncFragment>, Vec<alignment::RecoveryGap>) {
    (
        map.fragments
            .iter()
            .filter(|fragment| range.contains(&fragment.start_seconds))
            .cloned()
            .collect(),
        map.recovery_gaps
            .iter()
            .filter_map(|gap| clip_gap(gap, range.start, range.end))
            .collect(),
    )
}

/// Takes a chapter's timing out of a map's sentences and gaps, keeping the
/// parts of recovery gaps that run past either end.
pub(crate) fn remove_chapter_timing(
    fragments: &mut Vec<alignment::SyncFragment>,
    gaps: &mut Vec<alignment::RecoveryGap>,
    range: &std::ops::Range<f64>,
) {
    fragments.retain(|fragment| !range.contains(&fragment.start_seconds));
    *gaps = gaps
        .iter()
        .flat_map(|gap| {
            [
                clip_gap(gap, f64::NEG_INFINITY, range.start),
                clip_gap(gap, range.end, f64::INFINITY),
            ]
        })
        .flatten()
        .collect();
}

fn clip_gap(gap: &alignment::RecoveryGap, start: f64, end: f64) -> Option<alignment::RecoveryGap> {
    let start = gap.start_seconds.max(start);
    let end = gap.end_seconds.min(end);
    (end > start).then_some(alignment::RecoveryGap {
        start_seconds: start,
        end_seconds: end,
    })
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
            &chapter_spans(&epub, tracks, &plan.scopes),
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
        if let Err(error) = publish_report(state, &book_id, &report).await {
            tracing::warn!(book_id, ?error, "could not save sync report");
        }
    }
}

/// The report as an administrator reads it, with the book's language setting
/// so it can be seen and undone beside the chapters it affects.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncReportView {
    #[serde(flatten)]
    report: SyncReport,
    language_override: Option<String>,
}

/// The chapter-by-chapter report for an administrator. 404 until the served
/// map has been graded.
pub(crate) async fn get_sync_report(
    State(state): State<AppState>,
    _: AdminUser,
    Path(book_id): Path<String>,
) -> Result<Json<SyncReportView>, ApiError> {
    let map_path = {
        let library = state.library.read().await;
        library.book(&book_id)?;
        library
            .sync_paths
            .get(&book_id)
            .cloned()
            .ok_or_else(|| ApiError::not_found("Sync map not found"))?
    };
    let language_override = language_override(&state, &book_id).await;
    let sync_dir = state.sync_dir.clone();
    let report = tokio::task::spawn_blocking(move || {
        let map = probe_sync_map(&map_path, true)?.identity;
        read_current_report(&sync_dir, &book_id, &map)
    })
    .await
    .map_err(|error| ApiError::internal(error.to_string()))?
    .ok_or_else(|| ApiError::not_found("This book's sync has not been graded yet."))?;
    Ok(Json(SyncReportView {
        report,
        language_override,
    }))
}

/// The language an administrator told sync to recognize this book's speech
/// in, when the EPUB's own label is wrong.
pub(crate) async fn language_override(state: &AppState, book_id: &str) -> Option<String> {
    state
        .metadata_overrides
        .read()
        .await
        .books
        .get(book_id)
        .and_then(|book| book.sync_language.clone())
}

#[derive(Deserialize)]
pub(crate) struct SyncLanguageRequest {
    /// A language code such as `en`; null to use the EPUB's label again.
    language: Option<String>,
}

/// A primary language subtag, such as `en` from `en-GB`.
fn language_code(value: &str) -> Option<String> {
    let code = primary_language(value);
    (matches!(code.len(), 2 | 3) && code.chars().all(|c| c.is_ascii_alphabetic())).then_some(code)
}

/// Sets or clears the language sync recognizes a book's speech in. It takes
/// effect at the book's next sync.
pub(crate) async fn set_sync_language(
    State(state): State<AppState>,
    _: AdminUser,
    Path(book_id): Path<String>,
    Json(request): Json<SyncLanguageRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state.library.read().await.book(&book_id)?;
    let language = request
        .language
        .as_deref()
        .map(|value| {
            language_code(value)
                .ok_or_else(|| ApiError::bad_request("Use a language code such as en or nl."))
        })
        .transpose()?;
    state
        .metadata_overrides
        .mutate(|overrides| {
            match overrides.books.get_mut(&book_id) {
                Some(book) => book.sync_language = language.clone(),
                None if language.is_some() => {
                    overrides.books.insert(
                        book_id.clone(),
                        BookMetadataOverride {
                            sync_language: language.clone(),
                            ..Default::default()
                        },
                    );
                }
                None => {}
            }
            Ok(())
        })
        .await?;
    Ok(Json(serde_json::json!({ "languageOverride": language })))
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
            error: None,
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

    #[test]
    fn failed_chapters_grade_failed_whether_or_not_they_kept_earlier_sentences() {
        let text = "a".repeat(100);
        let mut spans = vec![
            span(0.0, 600.0, &text, 0),
            span(600.0, 1200.0, &text, 0),
            span(1200.0, 1260.0, &text, 0),
        ];
        for span in &mut spans {
            span.error = Some("Alignment failed with status 3:\nworker crashed".into());
        }
        spans[0].error = None;
        let report = graded(&spans, &[(1.0, &text), (700.0, &text)], &[]);
        let statuses = report
            .chapters
            .iter()
            .map(|c| (c.status, c.grade))
            .collect::<Vec<_>>();
        assert_eq!(
            statuses,
            [
                (ChapterStatus::Aligned, Some(Grade::Good)),
                (ChapterStatus::KeptPrevious, Some(Grade::Failed)),
                (ChapterStatus::Failed, Some(Grade::Failed)),
            ]
        );
        assert_eq!(
            report.chapters[1].error.as_deref(),
            Some("Alignment failed with status 3:")
        );
        assert!(
            report.chapters[1]
                .error_detail
                .as_deref()
                .unwrap()
                .ends_with("worker crashed")
        );
        assert_eq!(report.grade, Some(Grade::Failed));
        // A short chapter failing does not set the book's grade.
        let short = graded(&spans[2..], &[], &[]);
        assert_eq!(short.grade, Some(Grade::Failed));
        let mixed = graded(
            &[span(0.0, 600.0, &text, 0), spans[2].clone()],
            &[(1.0, &text)],
            &[],
        );
        assert_eq!(mixed.grade, Some(Grade::Good));
        assert_eq!(mixed.quality().unwrap().flagged, 1);
    }

    fn fragment(start: f64) -> alignment::SyncFragment {
        alignment::SyncFragment {
            start_seconds: start,
            end_seconds: start + 1.0,
            href: "x".into(),
            text: format!("At {start}."),
            words: Vec::new(),
        }
    }

    #[test]
    fn a_chapter_is_cut_out_of_a_map_without_touching_its_neighbours() {
        let mut map = alignment::SyncMap {
            version: alignment::SYNC_MAP_VERSION,
            mapping_revision: alignment::MAPPING_REVISION,
            generator: None,
            generated_at: None,
            precision: None,
            fragments: [5.0, 99.5, 100.0, 150.0, 199.9, 200.0]
                .map(fragment)
                .to_vec(),
            recovery_gaps: vec![gap(90.0, 110.0), gap(120.0, 130.0), gap(190.0, 260.0)],
        };
        let range = 100.0..200.0;
        let (kept, kept_gaps) = chapter_timing(&map, &range);
        assert_eq!(
            kept.iter().map(|f| f.start_seconds).collect::<Vec<_>>(),
            [100.0, 150.0, 199.9]
        );
        assert_eq!(
            kept_gaps,
            [gap(100.0, 110.0), gap(120.0, 130.0), gap(190.0, 200.0)]
        );
        remove_chapter_timing(&mut map.fragments, &mut map.recovery_gaps, &range);
        assert_eq!(
            map.fragments
                .iter()
                .map(|f| f.start_seconds)
                .collect::<Vec<_>>(),
            [5.0, 99.5, 200.0]
        );
        assert_eq!(map.recovery_gaps, [gap(90.0, 100.0), gap(200.0, 260.0)]);
        // A chapter of unknown length runs to the end of the book.
        remove_chapter_timing(
            &mut map.fragments,
            &mut map.recovery_gaps,
            &(50.0..f64::INFINITY),
        );
        assert_eq!(map.fragments.len(), 1);
        assert!(map.recovery_gaps.is_empty());
    }

    #[test]
    fn a_rerun_needs_the_chapters_the_report_was_graded_with() {
        let root = tempfile::tempdir().unwrap();
        let map_path = root.path().join("book.sync.json");
        std::fs::write(
            &map_path,
            r#"{"version":2,"generatedAt":"7","fragments":[]}"#,
        )
        .unwrap();
        let identity = probe_sync_map(&map_path, true).unwrap().identity;
        let text = "a".repeat(100);
        let spans = [
            span(0.0, 100.0, &text, 0),
            span(100.0, f64::INFINITY, &text, 0),
        ];
        let mut report = graded(&spans, &[(1.0, &text), (150.0, &text)], &[]);
        report.map = identity.clone();
        std::fs::write(
            root.path().join("book.report.json"),
            serde_json::to_vec(&report).unwrap(),
        )
        .unwrap();
        let check = |spans: &[ChapterSpan], chapters: &[usize]| {
            rerun_base(root.path(), "book", &map_path, spans, chapters).map(|base| base.chapters)
        };
        assert_eq!(
            check(&spans, &[1]).unwrap(),
            [JobChapter {
                index: 1,
                label: "Chapter at 100".into(),
                cause: None
            }]
        );
        let mut renamed = spans.to_vec();
        renamed[0].label = "Prologue".into();
        let mut moved = spans.to_vec();
        moved[1].start_seconds = 101.0;
        for (spans, chapters) in [
            (&renamed[..], &[1][..]),
            (&moved[..], &[0][..]),
            (&spans[..1], &[0][..]),
            (&spans[..], &[2][..]),
        ] {
            assert_eq!(check(spans, chapters), Err(BOOK_CHANGED));
        }
        // A report for an earlier map cannot vouch for this one.
        std::fs::write(
            &map_path,
            r#"{"version":2,"generatedAt":"8","fragments":[]}"#,
        )
        .unwrap();
        let stale = check(&spans, &[1]).unwrap_err();
        assert!(stale.contains("grades are still being updated"), "{stale}");
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

    #[test]
    fn errors_seen_in_real_runs_are_classified() {
        for (error, cause) in [
            (
                "Alignment of `Part 3: Deadly - Chapter 55: The Rules of the Game` failed with status exit status: 1:\n    at file:///addon/node_modules/echogarden/dist/api/Alignment.js:52:19\nError: Couldn't parse language identifier 'tlh'.",
                Cause::LanguageGuess,
            ),
            (
                "Speech recognition stopped without writing a result. The alignment runtime may have crashed.",
                Cause::RuntimeCrash,
            ),
            (
                "No such file or directory (os error 2)",
                Cause::RuntimeCrash,
            ),
            (
                "Alignment of `Chapter 9` failed with status signal: 11 (SIGSEGV) (core dumped):\n",
                Cause::RuntimeCrash,
            ),
            (
                "Alignment of `Chapter 9` failed with status exit status: 137:\nKilled",
                Cause::RuntimeCrash,
            ),
            (
                "Failed to run alignment CLI: No such file or directory (os error 2)",
                Cause::RuntimeMissing,
            ),
            (
                "Failed to run ffmpeg for chapter audio: Permission denied (os error 13)",
                Cause::RuntimeMissing,
            ),
            (
                "ffmpeg failed to extract chapter audio with status exit status: 1:\nInvalid data found when processing input",
                Cause::AudioUnreadable,
            ),
            (
                "Speech recognition exceeded the two-hour command timeout.",
                Cause::Timeout,
            ),
            (
                "FFmpeg audio extraction timed out after 600.0 seconds.",
                Cause::Timeout,
            ),
            (
                "Windowed alignment of `Chapter 4` stalled at 912 s.",
                Cause::NoisyAudio,
            ),
            (
                "Alignment of `Chapter 9` failed with status exit status: 1:\nTypeError: x is undefined",
                Cause::Unknown,
            ),
            (
                "Alignment of `Chapter 9` failed with status exit status: 1341:",
                Cause::Unknown,
            ),
            (
                "Alignment produced no usable sentence fragments.",
                Cause::NoisyAudio,
            ),
            (
                "Alignment of `Chapter 3` produced no usable sentence fragments.",
                Cause::NoisyAudio,
            ),
        ] {
            assert_eq!(classify_error(error), cause, "{error}");
        }
        assert_eq!(
            serde_json::to_value(Cause::RuntimeCrash).unwrap(),
            "runtime-crash"
        );
    }

    fn evidence(words: u32, seconds: f64, runs_in_text: f64) -> ScopeEvidence {
        ScopeEvidence {
            windows: 4,
            unanchored_windows: 2,
            recognition_retries: 3,
            recognized_words: words,
            recognized_seconds: seconds,
            word_runs: words.saturating_sub(2),
            word_runs_in_text: (f64::from(words.saturating_sub(2)) * runs_in_text) as u32,
            ..Default::default()
        }
    }

    fn diagnose(grade: Grade, outcome: &ScopeOutcome, language: Option<&str>) -> Option<Diagnosis> {
        let labels = ["Chapter 1".to_string(), "Chapter 2".to_string()];
        diagnose_chapter(&ChapterEvidence {
            grade: Some(grade),
            outcome,
            language,
            labels: &labels,
        })
    }

    #[test]
    fn weak_chapters_are_diagnosed_from_what_recognition_heard() {
        // Clear narration: about 150 words a minute.
        let clear = |share| evidence(1500, 600.0, share);
        let cases = [
            (
                ScopeOutcome {
                    evidence: ScopeEvidence {
                        heard_language: Some("en".into()),
                        ..clear(0.02)
                    },
                    ..Default::default()
                },
                Cause::LanguageMismatch,
                FixKind::Suggested,
            ),
            (
                ScopeOutcome {
                    evidence: ScopeEvidence {
                        matching_scope: Some(1),
                        ..clear(0.05)
                    },
                    ..Default::default()
                },
                Cause::ChapterMismatch,
                FixKind::Auto,
            ),
            (
                ScopeOutcome {
                    evidence: clear(0.1),
                    ..Default::default()
                },
                Cause::EditionMismatch,
                FixKind::None,
            ),
            // Plenty of speech, most of it in the text: hard to hear.
            (
                ScopeOutcome {
                    evidence: clear(0.6),
                    ..Default::default()
                },
                Cause::NoisyAudio,
                FixKind::Auto,
            ),
            // Little speech heard at all.
            (
                ScopeOutcome {
                    evidence: evidence(150, 600.0, 0.05),
                    ..Default::default()
                },
                Cause::NoisyAudio,
                FixKind::Auto,
            ),
            (
                ScopeOutcome {
                    error: Some("Windowed alignment of `Chapter 1` stalled at 5 s.".into()),
                    evidence: clear(0.1),
                    ..Default::default()
                },
                Cause::EditionMismatch,
                FixKind::None,
            ),
            (
                ScopeOutcome {
                    error: Some(
                        "Speech recognition stopped without writing a result. The alignment runtime may have crashed."
                            .into(),
                    ),
                    evidence: clear(0.02),
                    ..Default::default()
                },
                Cause::RuntimeCrash,
                FixKind::Auto,
            ),
            (
                ScopeOutcome {
                    error: Some("FFmpeg audio extraction timed out after 600.0 seconds.".into()),
                    ..Default::default()
                },
                Cause::Timeout,
                FixKind::None,
            ),
        ];
        for (outcome, cause, kind) in cases {
            let diagnosis = diagnose(Grade::Poor, &outcome, Some("nl")).unwrap();
            assert_eq!(
                (diagnosis.cause, diagnosis.fix.kind),
                (cause, kind),
                "{outcome:?}"
            );
            assert!(!diagnosis.fix.attempted && !diagnosis.fix.applied);
        }

        let mismatch = ScopeOutcome {
            evidence: ScopeEvidence {
                heard_language: Some("en-US".into()),
                matching_scope: Some(1),
                ..clear(0.02)
            },
            ..Default::default()
        };
        let diagnosis = diagnose(Grade::Poor, &mismatch, Some("nl")).unwrap();
        assert_eq!(diagnosis.evidence.heard_language.as_deref(), Some("en-US"));
        assert_eq!(diagnosis.evidence.labelled_language.as_deref(), Some("nl"));
        assert_eq!(diagnosis.fix.action, Some(FixAction::ResyncLanguage));
        // The same speech is no mismatch for a book labelled in its language,
        // however the label spells it.
        assert_eq!(
            diagnose(Grade::Poor, &mismatch, Some("eng")).unwrap().cause,
            Cause::ChapterMismatch
        );
        let same = diagnose(Grade::Poor, &mismatch, Some("en")).unwrap();
        assert_eq!(same.cause, Cause::ChapterMismatch);
        assert_eq!(
            same.evidence.matching_chapter,
            Some(JobChapter {
                index: 1,
                label: "Chapter 2".into(),
                cause: None,
            })
        );
        assert_eq!(same.evidence.words_in_text, Some(29.0 / 1498.0));
    }

    #[test]
    fn diagnoses_record_fixes_and_skip_chapters_without_evidence() {
        let tried = ScopeOutcome {
            evidence: evidence(1500, 600.0, 0.6),
            fixes: vec![Cause::NoisyAudio],
            ..Default::default()
        };
        let diagnosis = diagnose(Grade::Poor, &tried, None).unwrap();
        assert!(diagnosis.fix.attempted && !diagnosis.fix.applied);
        // A fix that worked is reported on a chapter that is now fine.
        let fixed = ScopeOutcome {
            fixed: Some(Cause::ChapterMismatch),
            fixes: vec![Cause::ChapterMismatch],
            paired_with: Some(0),
            evidence: evidence(1500, 600.0, 0.95),
            ..Default::default()
        };
        let diagnosis = diagnose(Grade::Good, &fixed, None).unwrap();
        assert_eq!(diagnosis.cause, Cause::ChapterMismatch);
        assert!(diagnosis.fix.applied);
        assert_eq!(diagnosis.evidence.matching_chapter.unwrap().index, 0);
        assert!(diagnose(Grade::Review, &ScopeOutcome::default(), None).is_none());
        // Without recognition, as in an estimate, nothing can be said.
        assert!(diagnose(Grade::Poor, &ScopeOutcome::default(), None).is_none());
        // A failure is explained even without recognition.
        let failed = ScopeOutcome {
            error: Some(
                "Failed to run alignment CLI: No such file or directory (os error 2)".into(),
            ),
            ..Default::default()
        };
        let diagnosis = diagnose(Grade::Failed, &failed, None).unwrap();
        assert_eq!(diagnosis.cause, Cause::RuntimeMissing);
        assert_eq!(diagnosis.evidence, DiagnosisEvidence::default());
        let json = serde_json::to_value(&diagnosis).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"cause": "runtime-missing", "evidence": {}, "fix": {"kind": "none", "attempted": false}})
        );
    }
}
