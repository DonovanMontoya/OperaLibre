//! Voice replacement: an experiment the owner turns on that makes a second
//! copy of a book with some or all of its narration in another voice, using
//! the owner's ElevenLabs account.
//!
//! It works in three steps. A chapter is transcribed with speaker labels, so
//! the narrators in it can be told apart. An administrator then plans edits:
//! one narrator in another voice, a single line performed again, or a whole
//! chapter revoiced or read fresh from its text. Making the copy sends only
//! the stretches being changed, splices the results back, and publishes the
//! copy as its own book. The original files are never written to.
//!
//! Book audio and text leave the server for ElevenLabs, and every clip is
//! billed to the owner's key, so nothing is sent until an administrator asks
//! for it, and each clip that comes back is kept so a retry never pays twice.

use crate::elevenlabs::{self, ElevenLabs};
use crate::voice_render::{self as render, Insert};
use crate::*;
use std::sync::atomic::{AtomicBool, Ordering};

const SETTINGS_DOCUMENT: &str = "voice-replacement-settings";
const COPIES_DOCUMENT: &str = "voice-replacement-copies";
const EXPERIMENT_OFF: &str = "Voice replacement is not turned on for this server.";
/// Left in each copy's folder, so removing a copy only ever removes a folder
/// this feature made.
const COPY_MARKER: &str = ".operalibre-revoiced";
const MAX_EDITS: usize = 500;
/// The least quiet on either side of a spoken heading.
const HEADING_PAUSE_SECONDS: f64 = 1.5;
const MAX_CAST: usize = 40;
/// A pause this long is left out of what the voice changer is sent, for a
/// voice set to skip pauses.
const SKIPPED_PAUSE_SECONDS: f64 = 0.5;
/// How much of a skipped pause stays on the speech either side of it, so no
/// breath or trailing sound is cut.
const PAUSE_PAD_SECONDS: f64 = 0.12;
/// How much of the book one estimate listens through for pauses it has not
/// found before. What is left over is counted in full until a later estimate
/// reaches it.
const ESTIMATE_LISTEN_SECONDS: f64 = 30.0 * 60.0;
const MAX_STRETCHES: usize = 2_000;
/// How much of a voice can be tried before it is put in the plan.
const AUDITION_SECONDS: f64 = 30.0;
/// How much of what comes before an audition can be heard with it.
const AUDITION_LEAD_SECONDS: f64 = 10.0;
/// One transcription request takes fifteen hours at most.
const MAX_SECTION_SECONDS: f64 = 10.0 * 60.0 * 60.0;
const MAX_LISTEN_SECONDS: f64 = 30.0;
const PREVIEW_SECONDS: f64 = 15.0;
const PREVIEW_CHARACTERS: usize = 400;
/// A stretch shorter than this is not worth a request of its own.
const MIN_SLOT_SECONDS: f64 = 0.3;

static RUNS: LazyLock<Mutex<HashMap<String, Run>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// One book at a time: a provider's limits are per key, and re-encoding a
/// chapter is heavy work for a home server.
static RUN_PERMIT: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(1));
/// Held across each read-change-write of a project file.
static PROJECT_WRITES: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSettings {
    #[serde(default)]
    enabled: bool,
    /// Never sent back to a client once saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    #[cfg(test)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_base: Option<String>,
}

async fn load_settings(state: &AppState) -> StoredSettings {
    state
        .database
        .call(|db| read_document(db, SETTINGS_DOCUMENT))
        .await
        .ok()
        .flatten()
        .and_then(|payload| serde_json::from_str(&payload).ok())
        .unwrap_or_default()
}

async fn save_settings(state: &AppState, settings: &StoredSettings) -> Result<(), ApiError> {
    let payload = serde_json::to_string(settings)
        .map_err(|_| ApiError::internal("Cannot save the voice replacement settings."))?;
    state
        .database
        .transaction(move |db| write_document(db, SETTINGS_DOCUMENT, &payload))
        .await
}

/// Guards everything but the switch. The app hides voice replacement on this
/// 404, as it does for a server that predates it.
pub(crate) async fn require_experiment(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: middleware::Next,
) -> Response {
    if load_settings(&state).await.enabled {
        next.run(request).await
    } else {
        ApiError::not_found(EXPERIMENT_OFF).into_response()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceReplacementStatus {
    enabled: bool,
    has_api_key: bool,
    /// Cutting and rewriting audio needs ffmpeg on the server.
    audio_tools_available: bool,
}

fn audio_tools(state: &AppState) -> Option<faststart::Tools> {
    let tools = state.faststart_tools.clone();
    // The test server is built without tools; tests that need ffmpeg use the
    // one on this machine.
    #[cfg(test)]
    let tools = tools.or_else(|| faststart::discover_tools(None, None));
    tools
}

async fn status(state: &AppState) -> VoiceReplacementStatus {
    let settings = load_settings(state).await;
    VoiceReplacementStatus {
        enabled: settings.enabled,
        has_api_key: settings.api_key.is_some(),
        audio_tools_available: audio_tools(state).is_some(),
    }
}

pub(crate) async fn voice_replacement_experiment(
    State(state): State<AppState>,
    _: AdminUser,
) -> Json<VoiceReplacementStatus> {
    Json(status(&state).await)
}

pub(crate) async fn set_voice_replacement_enabled(
    State(state): State<AppState>,
    _: OwnerUser,
    Json(input): Json<ExperimentalFeatureEnabled>,
) -> Result<Json<VoiceReplacementStatus>, ApiError> {
    let mut settings = load_settings(&state).await;
    settings.enabled = input.enabled;
    save_settings(&state, &settings).await?;
    if !input.enabled {
        // Work in flight stops before its next request. Plans, clips and
        // copies are kept for when the experiment comes back.
        stop_all_runs(&state).await;
    }
    Ok(Json(status(&state).await))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KeyInput {
    api_key: String,
    #[serde(default)]
    acknowledge_privacy: bool,
}

pub(crate) async fn set_voice_replacement_key(
    State(state): State<AppState>,
    _: OwnerUser,
    Json(input): Json<KeyInput>,
) -> Result<Json<VoiceReplacementStatus>, ApiError> {
    if !input.acknowledge_privacy {
        return Err(ApiError::bad_request(
            "Confirm that book audio and text will be sent to ElevenLabs before saving a key.",
        ));
    }
    let api_key = input.api_key.trim();
    if api_key.is_empty() || api_key.len() > 512 || api_key.chars().any(char::is_whitespace) {
        return Err(ApiError::bad_request("Enter an ElevenLabs API key."));
    }
    let mut settings = load_settings(&state).await;
    settings.api_key = Some(api_key.into());
    save_settings(&state, &settings).await?;
    Ok(Json(status(&state).await))
}

/// The key is deleted, not kept for later, and nothing more is sent.
pub(crate) async fn remove_voice_replacement_key(
    State(state): State<AppState>,
    _: OwnerUser,
) -> Result<Json<VoiceReplacementStatus>, ApiError> {
    let mut settings = load_settings(&state).await;
    settings.api_key = None;
    save_settings(&state, &settings).await?;
    stop_all_runs(&state).await;
    Ok(Json(status(&state).await))
}

async fn provider(state: &AppState) -> Result<ElevenLabs, ApiError> {
    let settings = load_settings(state).await;
    if !settings.enabled {
        return Err(ApiError::not_found(EXPERIMENT_OFF));
    }
    let api_key = settings.api_key.ok_or_else(|| {
        ApiError::bad_request(
            "An owner needs to save an ElevenLabs API key under Administration → Experiments first.",
        )
    })?;
    #[cfg(test)]
    let base = settings.api_base;
    #[cfg(not(test))]
    let base = None;
    ElevenLabs::new(api_key, base)
        .map_err(|_| ApiError::internal("Could not prepare a connection to ElevenLabs."))
}

#[cfg(test)]
pub(crate) async fn enable_for_test(state: &AppState, api_base: &str) {
    save_settings(
        state,
        &StoredSettings {
            enabled: true,
            api_key: Some("test-key".into()),
            api_base: Some(api_base.into()),
        },
    )
    .await
    .unwrap();
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceList {
    voices: Vec<elevenlabs::Voice>,
    /// Left on the owner's plan this period, when the key may read that.
    #[serde(skip_serializing_if = "Option::is_none")]
    credits_left: Option<u64>,
}

pub(crate) async fn list_replacement_voices(
    State(state): State<AppState>,
    _: AdminUser,
) -> Result<Json<VoiceList>, ApiError> {
    let provider = provider(&state).await?;
    let voices = provider
        .voices()
        .await
        .map_err(|error| ApiError::bad_gateway(error.to_string()))?;
    Ok(Json(VoiceList {
        voices,
        credits_left: provider.credits_left().await,
    }))
}

// ---------------------------------------------------------------------------
// The book and its project
// ---------------------------------------------------------------------------

/// A chapter, or the whole of a book that has none.
#[derive(Debug, Clone, PartialEq)]
struct Section {
    index: usize,
    title: String,
    start_seconds: f64,
    end_seconds: f64,
}

fn sections(book: &Book) -> Vec<Section> {
    // Chapter marks can run past the audio; what is asked of ffmpeg cannot.
    let length = book.duration_seconds.unwrap_or(f64::INFINITY);
    let all = if book.chapters.is_empty() {
        vec![Section {
            index: 0,
            title: book.title.clone(),
            start_seconds: 0.0,
            end_seconds: book.duration_seconds.unwrap_or(0.0),
        }]
    } else {
        book.chapters
            .iter()
            .enumerate()
            .map(|(index, chapter)| Section {
                index,
                title: chapter.title.clone(),
                start_seconds: chapter.start_seconds,
                end_seconds: agent::chapter_end(book, index).unwrap_or(chapter.start_seconds),
            })
            .collect()
    };
    all.into_iter()
        .map(|section| Section {
            end_seconds: section.end_seconds.min(length),
            ..section
        })
        .filter(|section| section.end_seconds - section.start_seconds > 0.5)
        .collect()
}

struct BookAudio {
    book: Book,
    /// Each file and its length, in book order.
    tracks: Vec<(PathBuf, f64)>,
    sync_path: Option<PathBuf>,
}

async fn book_audio(state: &AppState, book_id: &str) -> Result<BookAudio, ApiError> {
    let library = state.library.read().await;
    let book = library.book(book_id)?.clone();
    let tracks = book
        .tracks
        .iter()
        .map(|track| {
            let path = library.track_paths.get(&track.id).cloned()?;
            Some((path, track.duration_seconds?))
        })
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| ApiError::conflict("This book's audio has not been measured yet."))?;
    Ok(BookAudio {
        sync_path: library.sync_paths.get(book_id).cloned(),
        book,
        tracks,
    })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VoiceChoice {
    voice_id: String,
    name: String,
    /// How the voice changer performs with this voice. Without it, the
    /// voice's own saved settings apply. Newly spoken text ignores it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    settings: Option<elevenlabs::ChangerSettings>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ChapterMethod {
    /// The voice changer: the same performance in another voice.
    KeepPerformance,
    /// Text to speech from the chapter's words.
    ReadText,
}

/// One thing to change. Times are on the book's timeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Edit {
    /// Everything one narrator says in a chapter.
    Speaker {
        #[serde(default)]
        id: String,
        chapter: usize,
        speaker: String,
        voice: VoiceChoice,
    },
    /// One stretch. With `text`, it is spoken afresh from those words, which
    /// may carry directions such as `[whispers]`; without, the original
    /// performance is kept and only the voice changes.
    Line {
        #[serde(default)]
        id: String,
        chapter: usize,
        start_seconds: f64,
        end_seconds: f64,
        voice: VoiceChoice,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    /// A whole chapter.
    Chapter {
        #[serde(default)]
        id: String,
        chapter: usize,
        voice: VoiceChoice,
        method: ChapterMethod,
    },
    /// A stretch left as it is, whatever else covers it. A chapter read
    /// afresh from its text has no original left to keep.
    Keep {
        #[serde(default)]
        id: String,
        chapter: usize,
        start_seconds: f64,
        end_seconds: f64,
    },
}

impl Edit {
    fn chapter(&self) -> usize {
        match self {
            Edit::Speaker { chapter, .. }
            | Edit::Line { chapter, .. }
            | Edit::Chapter { chapter, .. }
            | Edit::Keep { chapter, .. } => *chapter,
        }
    }

    fn id_mut(&mut self) -> &mut String {
        match self {
            Edit::Speaker { id, .. }
            | Edit::Line { id, .. }
            | Edit::Chapter { id, .. }
            | Edit::Keep { id, .. } => id,
        }
    }

    fn voice(&self) -> Option<&VoiceChoice> {
        match self {
            Edit::Speaker { voice, .. }
            | Edit::Line { voice, .. }
            | Edit::Chapter { voice, .. } => Some(voice),
            Edit::Keep { .. } => None,
        }
    }
}

/// A sentence or so, said by one narrator.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Line {
    speaker: String,
    start_seconds: f64,
    end_seconds: f64,
    text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpeakerSummary {
    id: String,
    seconds: f64,
    lines: usize,
    /// A stretch of this narrator to listen to.
    sample_start_seconds: f64,
    sample_end_seconds: f64,
}

/// A run of a chapter between two spoken headings. Books read by a cast
/// often open each character's part by saying the character's name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Passage {
    /// The headings said at its start, in order. None where a chapter
    /// begins without one.
    headings: Vec<String>,
    start_seconds: f64,
    end_seconds: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalysedSection {
    start_seconds: f64,
    end_seconds: f64,
    speakers: Vec<SpeakerSummary>,
    /// Absent in analyses saved before passages were found.
    #[serde(default)]
    passages: Option<Vec<Passage>>,
}

/// One exact stretch of the book, inside a single chapter.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Stretch {
    start_seconds: f64,
    end_seconds: f64,
}

/// How a voice in the cast is replaced. The ways differ in what they cost
/// and in how much of the original performance is left.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CastMethod {
    /// The voice changer over every second of its stretches.
    #[default]
    KeepPerformance,
    /// The voice changer over what is said. Pauses stay as they are in the
    /// book and are not paid for.
    SkipPauses,
    /// Its words, from the transcript, spoken afresh.
    ReadText,
    /// The same, by the speech model that costs half as much.
    ReadTextCheaply,
}

impl CastMethod {
    fn is_default(&self) -> bool {
        *self == Self::default()
    }

    fn source(self) -> SlotSource {
        match self {
            Self::KeepPerformance => SlotSource::Performance,
            Self::SkipPauses => SlotSource::Spoken,
            Self::ReadText => SlotSource::Heard { cheaply: false },
            Self::ReadTextCheaply => SlotSource::Heard { cheaply: true },
        }
    }
}

/// A voice heard in the book and what replaces it: a name to know it by,
/// the new voice, and every stretch it covers. The stretches are the whole
/// of it; nothing is replaced that is not listed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CastMember {
    #[serde(default)]
    id: String,
    name: String,
    voice: VoiceChoice,
    #[serde(default, skip_serializing_if = "CastMethod::is_default")]
    method: CastMethod,
    #[serde(default)]
    stretches: Vec<Stretch>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    #[serde(default)]
    edits: Vec<Edit>,
    #[serde(default)]
    cast: Vec<CastMember>,
    /// Chapters whose speakers have been found, by chapter index.
    #[serde(default)]
    analysed: BTreeMap<usize, AnalysedSection>,
}

impl Project {
    /// A chapter's analysis, while the chapter is still where it was.
    fn analysis_of(&self, section: &Section) -> Option<&AnalysedSection> {
        self.analysed.get(&section.index).filter(|analysed| {
            analysed.start_seconds == section.start_seconds
                && analysed.end_seconds == section.end_seconds
        })
    }
}

fn project_dir(state: &AppState, book_id: &str) -> PathBuf {
    // Book ids are already path-safe, but they come from a URL.
    state
        .database_path
        .with_file_name("voice-replacement")
        .join(hex_digest(Sha256::digest(book_id.as_bytes())))
}

async fn load_project(state: &AppState, book_id: &str) -> Project {
    match fs::read(project_dir(state, book_id).join("project.json")).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Project::default(),
    }
}

async fn change_project(
    state: &AppState,
    book_id: &str,
    change: impl FnOnce(&mut Project),
) -> Result<Project, ApiError> {
    let _writing = PROJECT_WRITES.lock().await;
    let mut project = load_project(state, book_id).await;
    change(&mut project);
    write_json_atomic(&project_dir(state, book_id).join("project.json"), &project).await?;
    Ok(project)
}

fn lines_path(state: &AppState, book_id: &str, index: usize) -> PathBuf {
    project_dir(state, book_id)
        .join("analysis")
        .join(format!("{index}.json"))
}

async fn load_lines(state: &AppState, book_id: &str, index: usize) -> Vec<Line> {
    match fs::read(lines_path(state, book_id, index)).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// From words to lines to the stretches an edit covers
// ---------------------------------------------------------------------------

/// Groups recognized words into lines: a new one at each change of speaker,
/// end of sentence, pause long enough to set a heading apart, or once a line
/// has run long. The pause matters because a heading does not always come
/// back with a full stop after it. `offset` moves
/// the times onto the book's timeline.
fn lines_from_words(words: &[elevenlabs::Word], offset: f64) -> Vec<Line> {
    let mut lines: Vec<Line> = Vec::new();
    let mut sentence_ended = true;
    for word in words {
        let start = offset + word.start;
        let end = offset + word.end;
        let continues = lines.last().is_some_and(|line| {
            !sentence_ended
                && line.speaker == word.speaker
                && start - line.end_seconds < HEADING_PAUSE_SECONDS
                && end - line.start_seconds < 45.0
        });
        if continues {
            let line = lines.last_mut().expect("a line continues");
            line.text.push(' ');
            line.text.push_str(&word.text);
            line.end_seconds = end.max(line.end_seconds);
        } else {
            lines.push(Line {
                speaker: word.speaker.clone(),
                start_seconds: start,
                end_seconds: end,
                text: word.text.clone(),
            });
        }
        sentence_ended = word
            .text
            .trim_end_matches(['"', '\'', '”', '’', ')'])
            .ends_with(['.', '!', '?', '…']);
    }
    lines
}

fn speaker_summaries(lines: &[Line]) -> Vec<SpeakerSummary> {
    let mut speakers: Vec<SpeakerSummary> = Vec::new();
    let mut longest: HashMap<&str, f64> = HashMap::new();
    for line in lines {
        let length = line.end_seconds - line.start_seconds;
        let at = match speakers
            .iter()
            .position(|speaker| speaker.id == line.speaker)
        {
            Some(at) => at,
            None => {
                speakers.push(SpeakerSummary {
                    id: line.speaker.clone(),
                    seconds: 0.0,
                    lines: 0,
                    sample_start_seconds: line.start_seconds,
                    sample_end_seconds: line.end_seconds,
                });
                speakers.len() - 1
            }
        };
        let speaker = &mut speakers[at];
        speaker.seconds += length;
        speaker.lines += 1;
        let best = longest.entry(line.speaker.as_str()).or_insert(0.0);
        if length > *best {
            *best = length;
            speaker.sample_start_seconds = line.start_seconds;
            speaker.sample_end_seconds = line.end_seconds.min(line.start_seconds + 12.0);
        }
    }
    speakers.sort_by(|left, right| right.seconds.total_cmp(&left.seconds));
    speakers
}

/// The stretches one narrator speaks without anyone else cutting in, each
/// widened a little into the quiet around it so no breath is clipped.
fn speaker_turns(lines: &[Line], speaker: &str) -> Vec<(f64, f64)> {
    let mut turns: Vec<(f64, f64)> = Vec::new();
    let mut joined = false;
    for (at, line) in lines.iter().enumerate() {
        if line.speaker != speaker {
            joined = false;
            continue;
        }
        let before = at
            .checked_sub(1)
            .map(|previous| (line.start_seconds - lines[previous].end_seconds).max(0.0));
        let after = lines
            .get(at + 1)
            .map(|next| (next.start_seconds - line.end_seconds).max(0.0));
        let start = line.start_seconds - before.map_or(0.1, |gap| (gap / 2.0).min(0.1));
        let end = line.end_seconds + after.map_or(0.15, |gap| (gap / 2.0).min(0.15));
        match turns.last_mut() {
            // A long pause is left as it was: it may hold music, and sending
            // silence still costs.
            Some(turn) if joined && before.is_some_and(|gap| gap <= 3.0) => turn.1 = end,
            _ => turns.push((start, end)),
        }
        joined = true;
    }
    turns
}

/// A short line with quiet on both sides: how a narrator says a heading.
fn is_heading(lines: &[Line], at: usize) -> bool {
    let line = &lines[at];
    let words = line.text.split_whitespace().count();
    if words == 0 || words > 4 || line.end_seconds - line.start_seconds > 4.0 {
        return false;
    }
    // A heading opens something, so the chapter's last line is never one.
    let Some(next) = lines.get(at + 1) else {
        return false;
    };
    let after = next.start_seconds - line.end_seconds;
    // The start of a chapter counts as quiet.
    let before = at.checked_sub(1).map_or(f64::INFINITY, |previous| {
        line.start_seconds - lines[previous].end_seconds
    });
    before.min(after) >= HEADING_PAUSE_SECONDS && before.max(after) >= 2.0
}

/// Cuts a chapter where headings are said. Headings said one after another
/// open one passage together, and a chapter with none is one passage.
fn passages(section: &Section, lines: &[Line]) -> Vec<Passage> {
    let mut found: Vec<Passage> = Vec::new();
    let mut in_heading = false;
    for (at, line) in lines.iter().enumerate() {
        let heading = is_heading(lines, at);
        if heading {
            let name = line
                .text
                .trim()
                .trim_end_matches(['.', '!', '?', '…', ':', ','])
                .to_string();
            if in_heading && let Some(passage) = found.last_mut() {
                passage.headings.push(name);
            } else {
                // Starts in the quiet before the heading, not on its first sound.
                let quiet = at.checked_sub(1).map_or(section.start_seconds, |previous| {
                    lines[previous].end_seconds.max(line.start_seconds - 0.4)
                });
                let start = quiet.clamp(section.start_seconds, section.end_seconds);
                if let Some(previous) = found.last_mut() {
                    previous.end_seconds = start;
                } else if start - section.start_seconds >= 0.5 {
                    found.push(Passage {
                        headings: Vec::new(),
                        start_seconds: section.start_seconds,
                        end_seconds: start,
                    });
                }
                found.push(Passage {
                    headings: vec![name],
                    start_seconds: start,
                    end_seconds: section.end_seconds,
                });
            }
        }
        in_heading = heading;
    }
    if found.is_empty() {
        found.push(Passage {
            headings: Vec::new(),
            start_seconds: section.start_seconds,
            end_seconds: section.end_seconds,
        });
    }
    found
}

#[derive(Debug, Clone, PartialEq)]
enum SlotSource {
    /// Change the voice of what is there.
    Performance,
    /// Change the voice of what is said there, and leave the pauses alone.
    Spoken,
    /// Speak these words.
    Text(String),
    /// Speak the chapter's own words, found when the copy is made.
    Narration,
    /// Speak what the transcript heard in this stretch.
    Heard { cheaply: bool },
}

/// A stretch of the book to replace, and how.
#[derive(Debug, Clone, PartialEq)]
struct Slot {
    start_seconds: f64,
    end_seconds: f64,
    voice_id: String,
    settings: Option<elevenlabs::ChangerSettings>,
    source: SlotSource,
}

/// Clears a stretch: the slots keep only what lies outside it.
fn carve(slots: &mut Vec<Slot>, start_seconds: f64, end_seconds: f64) {
    let mut kept = Vec::with_capacity(slots.len() + 1);
    for slot in slots.drain(..) {
        if slot.end_seconds <= start_seconds || slot.start_seconds >= end_seconds {
            kept.push(slot);
            continue;
        }
        if slot.start_seconds < start_seconds {
            kept.push(Slot {
                end_seconds: start_seconds,
                ..slot.clone()
            });
        }
        if slot.end_seconds > end_seconds {
            kept.push(Slot {
                start_seconds: end_seconds,
                ..slot
            });
        }
    }
    *slots = kept;
}

/// Lays a new slot over the others, which keep only what it does not cover.
fn overlay(slots: &mut Vec<Slot>, new: Slot) {
    carve(slots, new.start_seconds, new.end_seconds);
    slots.push(new);
}

/// What a chapter's edits come to: stretches in order that do not overlap.
/// A stretch kept as it is outranks a line, which outranks the cast, which
/// outranks a narrator's edit, which outranks the chapter's; reading the
/// chapter from its text replaces all of it.
fn resolve(section: &Section, edits: &[&Edit], cast: &[CastMember], lines: &[Line]) -> Vec<Slot> {
    let whole = |voice: &VoiceChoice, source| Slot {
        start_seconds: section.start_seconds,
        end_seconds: section.end_seconds,
        voice_id: voice.voice_id.clone(),
        settings: voice.settings,
        source,
    };
    let chapter_edit = edits.iter().rev().find_map(|edit| match edit {
        Edit::Chapter { voice, method, .. } => Some((voice, *method)),
        _ => None,
    });
    let mut slots = Vec::new();
    match chapter_edit {
        Some((voice, ChapterMethod::ReadText)) => {
            return vec![whole(voice, SlotSource::Narration)];
        }
        Some((voice, ChapterMethod::KeepPerformance)) => {
            slots.push(whole(voice, SlotSource::Performance));
        }
        None => {}
    }
    let clamp = |seconds: f64| seconds.clamp(section.start_seconds, section.end_seconds);
    for edit in edits {
        if let Edit::Speaker { speaker, voice, .. } = edit {
            for (start, end) in speaker_turns(lines, speaker) {
                overlay(
                    &mut slots,
                    Slot {
                        start_seconds: clamp(start),
                        end_seconds: clamp(end),
                        voice_id: voice.voice_id.clone(),
                        settings: voice.settings,
                        source: SlotSource::Performance,
                    },
                );
            }
        }
    }
    for member in cast {
        for stretch in &member.stretches {
            let inside = stretch.start_seconds < section.end_seconds
                && stretch.end_seconds > section.start_seconds;
            if inside {
                overlay(
                    &mut slots,
                    Slot {
                        start_seconds: clamp(stretch.start_seconds),
                        end_seconds: clamp(stretch.end_seconds),
                        voice_id: member.voice.voice_id.clone(),
                        settings: member.voice.settings,
                        source: member.method.source(),
                    },
                );
            }
        }
    }
    for edit in edits {
        if let Edit::Line {
            start_seconds,
            end_seconds,
            voice,
            text,
            ..
        } = edit
        {
            overlay(
                &mut slots,
                Slot {
                    start_seconds: clamp(*start_seconds),
                    end_seconds: clamp(*end_seconds),
                    voice_id: voice.voice_id.clone(),
                    settings: voice.settings,
                    source: match text {
                        Some(text) => SlotSource::Text(text.clone()),
                        None => SlotSource::Performance,
                    },
                },
            );
        }
    }
    for edit in edits {
        if let Edit::Keep {
            start_seconds,
            end_seconds,
            ..
        } = edit
        {
            carve(&mut slots, clamp(*start_seconds), clamp(*end_seconds));
        }
    }
    slots.retain(|slot| slot.end_seconds - slot.start_seconds >= MIN_SLOT_SECONDS);
    slots.sort_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds));
    slots
}

/// Text in pieces a speech request can carry, each ending with a sentence
/// where one ends in time.
fn speech_chunks(text: &str, max_characters: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut count = 0;
    // Where `current` could end cleanly: after a sentence, or failing that a word.
    let mut sentence_end = None;
    let mut word_end = None;
    let words = text.split_whitespace().collect::<Vec<_>>();
    for word in words {
        let length = word.chars().count() + 1;
        if count + length > max_characters && count > 0 {
            let cut = sentence_end.or(word_end).unwrap_or(current.len());
            let rest = current.split_off(cut);
            chunks.push(current.trim().to_string());
            current = rest.trim_start().to_string();
            count = current.chars().count();
            sentence_end = None;
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
        count += length;
        word_end = Some(current.len());
        if word
            .trim_end_matches(['"', '\'', '”', '’', ')'])
            .ends_with(['.', '!', '?', '…'])
        {
            sentence_end = Some(current.len());
        }
    }
    if !current.trim().is_empty() {
        chunks.push(current.trim().to_string());
    }
    chunks
}

/// Each chapter's own words, for the chapters asked about: from the e-book
/// through a sentence-level follow-along map where the book has one, and
/// otherwise from the chapter's transcript.
async fn narration_texts(
    state: &AppState,
    audio: &BookAudio,
    project: &Project,
    wanted: &[&Section],
) -> HashMap<usize, String> {
    let mut texts = HashMap::new();
    if wanted.is_empty() {
        return texts;
    }
    if let Some(path) = &audio.sync_path
        && let Ok(map) = alignment::SyncMap::read(path.clone()).await
        && map.is_sentence_precise()
    {
        let mut fragments: Vec<&alignment::SyncFragment> = map.fragments.iter().collect();
        fragments.sort_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds));
        for chapter in agent::group_heard_text(&audio.book, &fragments, f64::INFINITY) {
            if !chapter.text.trim().is_empty() {
                texts.insert(chapter.index, chapter.text);
            }
        }
    }
    for section in wanted {
        if !texts.contains_key(&section.index) && project.analysis_of(section).is_some() {
            let text = load_lines(state, &audio.book.id, section.index)
                .await
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            if !text.trim().is_empty() {
                texts.insert(section.index, text);
            }
        }
    }
    texts.retain(|index, _| wanted.iter().any(|section| section.index == *index));
    texts
}

/// Every chapter with what its edits come to. Chapters nothing changes have
/// no slots.
async fn planned_slots(
    state: &AppState,
    audio: &BookAudio,
    project: &Project,
) -> Vec<(Section, Vec<Slot>)> {
    let mut planned = Vec::new();
    for section in sections(&audio.book) {
        let edits: Vec<&Edit> = project
            .edits
            .iter()
            .filter(|edit| edit.chapter() == section.index)
            .collect();
        let needs_lines = edits
            .iter()
            .any(|edit| matches!(edit, Edit::Speaker { .. }));
        let lines = if needs_lines && project.analysis_of(&section).is_some() {
            load_lines(state, &audio.book.id, section.index).await
        } else {
            Vec::new()
        };
        let slots = resolve(&section, &edits, &project.cast, &lines);
        planned.push((section, slots));
    }
    planned
}

/// What a transcript heard in a stretch: the lines that mostly fall in it.
fn heard_text(lines: &[Line], start_seconds: f64, end_seconds: f64) -> String {
    lines
        .iter()
        .filter(|line| {
            let middle = (line.start_seconds + line.end_seconds) / 2.0;
            middle >= start_seconds && middle < end_seconds
        })
        .map(|line| line.text.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

/// The words a copy speaks afresh, by chapter.
struct Words {
    /// Chapters read whole from their text.
    narration: HashMap<usize, String>,
    /// The transcripts of chapters where a voice in the cast is read from
    /// what it says.
    heard: HashMap<usize, Vec<Line>>,
}

/// The transcripts behind every stretch set to be read from its text. A
/// chapter that has none is missing from the answer.
async fn heard_lines(
    state: &AppState,
    book_id: &str,
    project: &Project,
    planned: &[(Section, Vec<Slot>)],
) -> HashMap<usize, Vec<Line>> {
    let mut heard = HashMap::new();
    for (section, slots) in planned {
        let wanted = slots
            .iter()
            .any(|slot| matches!(slot.source, SlotSource::Heard { .. }));
        if wanted && project.analysis_of(section).is_some() {
            heard.insert(
                section.index,
                load_lines(state, book_id, section.index).await,
            );
        }
    }
    heard
}

/// The first chapter with a stretch to read from text that has no transcript.
fn unheard<'a>(
    planned: &'a [(Section, Vec<Slot>)],
    heard: &HashMap<usize, Vec<Line>>,
) -> Option<&'a Section> {
    planned
        .iter()
        .find(|(section, slots)| {
            !heard.contains_key(&section.index)
                && slots
                    .iter()
                    .any(|slot| matches!(slot.source, SlotSource::Heard { .. }))
        })
        .map(|(section, _)| section)
}

/// Where a stretch's pauses are kept once found: finding them means decoding
/// the stretch, which an estimate should not do twice.
fn pauses_path(pauses_dir: &FsPath, start_seconds: f64, end_seconds: f64) -> PathBuf {
    pauses_dir.join(format!("{start_seconds:.3}-{end_seconds:.3}.json"))
}

async fn saved_pauses(
    pauses_dir: &FsPath,
    start_seconds: f64,
    end_seconds: f64,
) -> Option<Vec<(f64, f64)>> {
    let bytes = fs::read(pauses_path(pauses_dir, start_seconds, end_seconds))
        .await
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// The pauses in a stretch of the book, as times from its start.
async fn stretch_pauses(
    pauses_dir: &FsPath,
    ffmpeg: &FsPath,
    tracks: &[(PathBuf, f64)],
    start_seconds: f64,
    end_seconds: f64,
) -> anyhow::Result<Vec<(f64, f64)>> {
    if let Some(saved) = saved_pauses(pauses_dir, start_seconds, end_seconds).await {
        return Ok(saved);
    }
    let pauses =
        render::silences(ffmpeg, &render::pieces(tracks, start_seconds, end_seconds)).await?;
    fs::create_dir_all(pauses_dir).await?;
    // A torn file does not read back and is simply found again.
    fs::write(
        pauses_path(pauses_dir, start_seconds, end_seconds),
        serde_json::to_vec(&pauses)?,
    )
    .await?;
    Ok(pauses)
}

/// What is said in a stretch, on the book's timeline: the stretch without
/// its longer pauses.
fn speech_in(start_seconds: f64, end_seconds: f64, pauses: &[(f64, f64)]) -> Vec<(f64, f64)> {
    render::spoken(
        end_seconds - start_seconds,
        pauses,
        SKIPPED_PAUSE_SECONDS,
        PAUSE_PAD_SECONDS,
    )
    .into_iter()
    .map(|(from, to)| (start_seconds + from, start_seconds + to))
    .collect()
}

fn seconds_in(stretches: &[(f64, f64)]) -> f64 {
    stretches.iter().map(|(start, end)| end - start).sum()
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunStatus {
    /// `analysis` or `render`.
    kind: &'static str,
    state: &'static str,
    step: String,
    completed: usize,
    total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

struct Run {
    status: RunStatus,
    cancel: Arc<AtomicBool>,
}

enum RunError {
    Stopped,
    Failed(String),
}

impl From<ApiError> for RunError {
    fn from(error: ApiError) -> Self {
        RunError::Failed(error.message)
    }
}

impl From<anyhow::Error> for RunError {
    fn from(error: anyhow::Error) -> Self {
        RunError::Failed(error.to_string())
    }
}

impl From<io::Error> for RunError {
    fn from(error: io::Error) -> Self {
        RunError::Failed(error.to_string())
    }
}

/// Runs are kept per server as well as per book: every test server in one
/// process has the same books.
fn run_key(state: &AppState, book_id: &str) -> String {
    format!("{}|{book_id}", state.database_path.display())
}

/// What a run needs to report progress and notice it should stop.
#[derive(Clone)]
struct RunHandle {
    key: String,
    book_id: String,
    cancel: Arc<AtomicBool>,
}

impl RunHandle {
    fn check(&self) -> Result<(), RunError> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(RunError::Stopped)
        } else {
            Ok(())
        }
    }

    async fn update(&self, change: impl FnOnce(&mut RunStatus)) {
        if let Some(run) = RUNS
            .lock()
            .await
            .get_mut(&self.key)
            .filter(|run| Arc::ptr_eq(&run.cancel, &self.cancel))
        {
            change(&mut run.status);
        }
    }
}

async fn stop_all_runs(state: &AppState) {
    let ours = run_key(state, "");
    for (key, run) in RUNS.lock().await.iter_mut() {
        if !key.starts_with(&ours) {
            continue;
        }
        run.cancel.store(true, Ordering::SeqCst);
        if run.status.state == "running" {
            run.status.step = "Stopping".into();
        }
    }
}

async fn start_run<F, Fut>(
    state: &AppState,
    book_id: &str,
    kind: &'static str,
    total: usize,
    work: F,
) -> Result<(), ApiError>
where
    F: FnOnce(AppState, RunHandle) -> Fut + Send + 'static,
    Fut: Future<Output = Result<(), RunError>> + Send,
{
    let key = run_key(state, book_id);
    let mut runs = RUNS.lock().await;
    if runs
        .get(&key)
        .is_some_and(|run| run.status.state == "running")
    {
        return Err(ApiError::conflict(
            "This book is already being worked on. Wait for it to finish, or stop it.",
        ));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    runs.insert(
        key.clone(),
        Run {
            status: RunStatus {
                kind,
                state: "running",
                step: "Waiting for another book to finish".into(),
                completed: 0,
                total,
                error: None,
            },
            cancel: cancel.clone(),
        },
    );
    let handle = RunHandle {
        key,
        book_id: book_id.to_string(),
        cancel,
    };
    let state = state.clone();
    tokio::spawn(async move {
        let outcome = {
            let _permit = RUN_PERMIT.acquire().await;
            match handle.check() {
                Ok(()) => work(state, handle.clone()).await,
                Err(stopped) => Err(stopped),
            }
        };
        let mut runs = RUNS.lock().await;
        let ours = runs
            .get(&handle.key)
            .is_some_and(|run| Arc::ptr_eq(&run.cancel, &handle.cancel));
        if !ours {
            return;
        }
        match outcome {
            Ok(()) | Err(RunError::Stopped) => {
                runs.remove(&handle.key);
            }
            Err(RunError::Failed(message)) => {
                let run = runs.get_mut(&handle.key).expect("the run is ours");
                run.status.state = "failed";
                run.status.error = Some(message);
            }
        }
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

/// Where a book's clips are made and kept. A clip is named for exactly what
/// was asked for, so asking again finds it instead of paying again.
struct Workshop<'a> {
    provider: &'a ElevenLabs,
    ffmpeg: &'a FsPath,
    tracks: &'a [(PathBuf, f64)],
    clips_dir: PathBuf,
    /// Scratch space the caller removes.
    work_dir: &'a FsPath,
    /// How the book's own audio is laid out, which a copy keeps.
    format: render::AudioFormat,
}

impl Workshop<'_> {
    fn clip_path(&self, description: &str) -> PathBuf {
        self.clips_dir.join(format!(
            "{}.mp3",
            hex_digest(Sha256::digest(description.as_bytes()))
        ))
    }

    fn pauses_dir(&self) -> PathBuf {
        self.clips_dir.with_file_name("pauses")
    }

    /// Stretches of the book in another voice, as one clip that runs them end
    /// to end. Together at most what one voice changer request takes.
    async fn performance(
        &self,
        voice_id: &str,
        settings: Option<&elevenlabs::ChangerSettings>,
        stretches: &[(f64, f64)],
    ) -> anyhow::Result<PathBuf> {
        let (Some(first), Some(last)) = (stretches.first(), stretches.last()) else {
            anyhow::bail!("There is nothing there to change the voice of.");
        };
        // Settings are part of what was asked for: changing one must not
        // find the clip made with the old ones.
        let asked = settings.map_or(String::new(), |settings| {
            format!(
                "|{:.2}|{:.2}|{:.2}|{}",
                settings.stability, settings.similarity, settings.style, settings.remove_noise
            )
        });
        // One stretch is named as it always was, so clips made before pauses
        // could be skipped are still found.
        let covered = match stretches {
            [(start, end)] => format!("{start:.3}|{end:.3}"),
            _ => stretches
                .iter()
                .map(|(start, end)| format!("{start:.3}-{end:.3}"))
                .collect::<Vec<_>>()
                .join(","),
        };
        let clip = self.clip_path(&format!(
            "performance|{}|{voice_id}|{covered}{asked}",
            elevenlabs::VOICE_CHANGER_MODEL,
        ));
        if fs::try_exists(&clip).await? {
            return Ok(clip);
        }
        let source = self.work_dir.join(format!("{}.flac", random_hex_id()));
        let pieces = render::pieces(self.tracks, first.0, last.1);
        if stretches.len() == 1 {
            render::extract_clip(self.ffmpeg, &pieces, &source, 44_100).await?;
        } else {
            let within: Vec<(f64, f64)> = stretches
                .iter()
                .map(|(start, end)| (start - first.0, end - first.0))
                .collect();
            render::extract_stretches(self.ffmpeg, &pieces, &within, &source, 44_100).await?;
        }
        let changed = self
            .provider
            .change_voice(voice_id, &source, &clip, settings)
            .await;
        let _ = fs::remove_file(&source).await;
        changed?;
        Ok(clip)
    }

    async fn speech(&self, voice_id: &str, text: &str, model: &str) -> anyhow::Result<PathBuf> {
        let clip = self.clip_path(&format!("speech|{model}|{voice_id}|{text}"));
        if !fs::try_exists(&clip).await? {
            self.provider.speak(voice_id, text, model, &clip).await?;
        }
        Ok(clip)
    }

    /// The voice changer requests a stretch takes, each as the stretches of
    /// the book it carries. Skipping pauses, a request carries only what is
    /// said; otherwise it carries one unbroken run.
    async fn changer_requests(
        &self,
        start_seconds: f64,
        end_seconds: f64,
        skip_pauses: bool,
    ) -> anyhow::Result<Vec<Vec<(f64, f64)>>> {
        let length = end_seconds - start_seconds;
        if skip_pauses {
            let pauses = stretch_pauses(
                &self.pauses_dir(),
                self.ffmpeg,
                self.tracks,
                start_seconds,
                end_seconds,
            )
            .await?;
            return Ok(render::batches(
                &speech_in(start_seconds, end_seconds, &pauses),
                elevenlabs::VOICE_CHANGER_SECONDS,
            ));
        }
        let windows = if length > elevenlabs::VOICE_CHANGER_SECONDS {
            let pauses = render::silences(
                self.ffmpeg,
                &render::pieces(self.tracks, start_seconds, end_seconds),
            )
            .await?;
            render::windows(length, elevenlabs::VOICE_CHANGER_SECONDS, &pauses)
        } else {
            vec![(0.0, length)]
        };
        Ok(windows
            .into_iter()
            .map(|(from, to)| vec![(start_seconds + from, start_seconds + to)])
            .collect())
    }

    /// One request's clip, fetched or found, as the inserts that put it back:
    /// one for each stretch it carries. `origin` is where the audio being
    /// written starts on the book's timeline.
    async fn changed(
        &self,
        origin: f64,
        voice_id: &str,
        settings: Option<&elevenlabs::ChangerSettings>,
        stretches: &[(f64, f64)],
    ) -> anyhow::Result<Vec<Insert>> {
        let (Some(first), Some(last)) = (stretches.first(), stretches.last()) else {
            return Ok(Vec::new());
        };
        let clip = self.performance(voice_id, settings, stretches).await?;
        let only: Vec<(f64, f64)> = if stretches.len() > 1 {
            stretches
                .iter()
                .map(|(start, end)| (start - first.0, end - first.0))
                .collect()
        } else {
            Vec::new()
        };
        // One gain for the whole clip: a gain for each stretch would have the
        // level moving from sentence to sentence.
        let gain_db = render::matching_gain(
            self.ffmpeg,
            &render::pieces(self.tracks, first.0, last.1),
            &only,
            &clip,
            self.format,
        )
        .await;
        Ok(stretches
            .iter()
            .enumerate()
            .map(|(at, (start, end))| Insert {
                start_seconds: start - origin,
                end_seconds: end - origin,
                clips: vec![clip.clone()],
                fit: true,
                gain_db,
                continues: at > 0,
            })
            .collect())
    }

    /// Text spoken in place of a stretch, as the insert that puts it there.
    /// It runs as long as it runs. With `matched`, it is brought to the level
    /// of what it replaces.
    async fn spoken(
        &self,
        origin: f64,
        start_seconds: f64,
        end_seconds: f64,
        clips: Vec<PathBuf>,
        matched: bool,
    ) -> Insert {
        let gain_db = match clips.first() {
            Some(first) if matched => {
                render::matching_gain(
                    self.ffmpeg,
                    &render::pieces(self.tracks, start_seconds, end_seconds),
                    &[],
                    first,
                    self.format,
                )
                .await
            }
            _ => 0.0,
        };
        Insert {
            start_seconds: start_seconds - origin,
            end_seconds: end_seconds - origin,
            clips,
            fit: false,
            gain_db,
            continues: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Finding speakers
// ---------------------------------------------------------------------------

async fn analyse(state: AppState, run: RunHandle, indexes: Vec<usize>) -> Result<(), RunError> {
    let audio = book_audio(&state, &run.book_id).await?;
    let provider = provider(&state).await?;
    let tools = audio_tools(&state)
        .ok_or_else(|| RunError::Failed("Finding speakers needs ffmpeg on the server.".into()))?;
    let wanted: Vec<Section> = sections(&audio.book)
        .into_iter()
        .filter(|section| indexes.contains(&section.index))
        .collect();
    let directory = project_dir(&state, &run.book_id);
    fs::create_dir_all(&directory).await?;
    let work_dir = tempfile::Builder::new()
        .prefix("work-")
        .tempdir_in(&directory)?;
    for (position, section) in wanted.iter().enumerate() {
        run.check()?;
        let already = load_project(&state, &run.book_id)
            .await
            .analysis_of(section)
            .is_some();
        if !already {
            if section.end_seconds - section.start_seconds > MAX_SECTION_SECONDS {
                return Err(RunError::Failed(format!(
                    "{} is longer than ten hours, which is more than one request can take.",
                    section.title
                )));
            }
            run.update(|status| {
                status.step = format!("Listening to {}", section.title);
            })
            .await;
            let clip = work_dir.path().join(format!("{}.flac", section.index));
            render::extract_clip(
                &tools.ffmpeg,
                &render::pieces(&audio.tracks, section.start_seconds, section.end_seconds),
                &clip,
                16_000,
            )
            .await?;
            run.check()?;
            let words = provider.transcribe(&clip).await?;
            let _ = fs::remove_file(&clip).await;
            let lines = lines_from_words(&words, section.start_seconds);
            // Lines first: a project never names an analysis that is not there.
            write_json_atomic(&lines_path(&state, &run.book_id, section.index), &lines).await?;
            let analysed = AnalysedSection {
                start_seconds: section.start_seconds,
                end_seconds: section.end_seconds,
                speakers: speaker_summaries(&lines),
                passages: Some(passages(section, &lines)),
            };
            change_project(&state, &run.book_id, |project| {
                project.analysed.insert(section.index, analysed);
            })
            .await?;
        }
        run.update(|status| status.completed = position + 1).await;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Making the copy
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CopyRecord {
    id: String,
    source_book_id: String,
    /// Directly inside the library folder.
    folder: String,
    created_at: String,
}

async fn load_copies(state: &AppState) -> Vec<CopyRecord> {
    state
        .database
        .call(|db| read_document(db, COPIES_DOCUMENT))
        .await
        .ok()
        .flatten()
        .and_then(|payload| serde_json::from_str(&payload).ok())
        .unwrap_or_default()
}

async fn save_copies(state: &AppState, copies: &[CopyRecord]) -> Result<(), ApiError> {
    let payload = serde_json::to_string(copies)
        .map_err(|_| ApiError::internal("Cannot save the list of revoiced copies."))?;
    state
        .database
        .transaction(move |db| write_document(db, COPIES_DOCUMENT, &payload))
        .await
}

/// Whether a record's folder is still the copy that was made: a real folder,
/// never a link, that carries the copy's marker. A folder deleted by hand, or
/// one that has since taken its name, is not.
async fn copy_is_in_place(state: &AppState, copy: &CopyRecord) -> bool {
    let folder = state.library_root.join(&copy.folder);
    let is_folder = fs::symlink_metadata(&folder)
        .await
        .is_ok_and(|metadata| metadata.is_dir());
    is_folder
        && fs::read_to_string(folder.join(COPY_MARKER))
            .await
            .is_ok_and(|marker| marker.trim() == copy.id)
}

fn section_file_stem(position: usize, title: &str) -> String {
    let title: String = sanitize_filename(title).chars().take(80).collect();
    format!("{:03} - {}", position + 1, title.trim())
}

async fn make_copy(state: AppState, run: RunHandle) -> Result<(), RunError> {
    let audio = book_audio(&state, &run.book_id).await?;
    let project = load_project(&state, &run.book_id).await;
    let planned = planned_slots(&state, &audio, &project).await;
    if planned.iter().all(|(_, slots)| slots.is_empty()) {
        return Err(RunError::Failed(
            "Nothing in the plan changes this book yet.".into(),
        ));
    }
    let provider = provider(&state).await?;
    let tools = audio_tools(&state)
        .ok_or_else(|| RunError::Failed("Making a copy needs ffmpeg on the server.".into()))?;
    let narrated: Vec<&Section> = planned
        .iter()
        .filter(|(_, slots)| {
            slots
                .iter()
                .any(|slot| slot.source == SlotSource::Narration)
        })
        .map(|(section, _)| section)
        .collect();
    let texts = narration_texts(&state, &audio, &project, &narrated).await;
    if let Some(missing) = narrated
        .iter()
        .find(|section| !texts.contains_key(&section.index))
    {
        return Err(RunError::Failed(format!(
            "{} has no text to read from. Find its speakers first, which also transcribes it.",
            missing.title
        )));
    }
    let heard = heard_lines(&state, &run.book_id, &project, &planned).await;
    if let Some(missing) = unheard(&planned, &heard) {
        // Never the voice changer in its place: that would cost more than
        // was agreed to.
        return Err(RunError::Failed(format!(
            "{} has not been transcribed, so a voice set to be read from its text has nothing to read there.",
            missing.title
        )));
    }
    let words = Words {
        narration: texts,
        heard,
    };

    let directory = project_dir(&state, &run.book_id);
    fs::create_dir_all(&directory).await?;
    let work_dir = tempfile::Builder::new()
        .prefix("work-")
        .tempdir_in(&directory)?;
    let format = render::probe(&tools, &audio.tracks[0].0).await;
    let workshop = Workshop {
        provider: &provider,
        ffmpeg: &tools.ffmpeg,
        tracks: &audio.tracks,
        clips_dir: directory.join("clips"),
        work_dir: work_dir.path(),
        format,
    };
    let title = format!("{} (Revoiced)", audio.book.title);

    // Built where an interrupted upload is built, so a crash leaves nothing
    // the next start does not sweep away.
    fs::create_dir_all(&state.library_root).await?;
    let staging = state.library_root.join(format!(
        "{}{}",
        upload::UPLOAD_STAGING_PREFIX,
        generate_session_token()
    ));
    fs::create_dir(&staging).await?;
    let built = build_copy(
        &run, &workshop, &audio, &planned, &words, format, &title, &staging,
    )
    .await;
    let published = match built {
        Ok(()) => publish_copy(&state, &run.book_id, &title, &staging).await,
        Err(error) => Err(error),
    };
    if published.is_err() {
        let _ = fs::remove_dir_all(&staging).await;
    }
    published
}

#[allow(clippy::too_many_arguments)]
async fn build_copy(
    run: &RunHandle,
    workshop: &Workshop<'_>,
    audio: &BookAudio,
    planned: &[(Section, Vec<Slot>)],
    words: &Words,
    format: render::AudioFormat,
    title: &str,
    staging: &FsPath,
) -> Result<(), RunError> {
    let total = planned.len();
    let mut first_file = None;
    for (position, (section, slots)) in planned.iter().enumerate() {
        run.check()?;
        let label = format!("Chapter {} of {total}: {}", position + 1, section.title);
        let pieces = render::pieces(&audio.tracks, section.start_seconds, section.end_seconds);
        let stem = section_file_stem(position, &section.title);
        let tags = render::Tags {
            title: &section.title,
            album: title,
            author: audio.book.author.as_deref(),
            track: position + 1,
            track_count: total,
        };
        let copy_as = match pieces.as_slice() {
            [only] if slots.is_empty() => render::copy_extension(&only.path),
            _ => None,
        };
        let file = match copy_as {
            Some(extension) => {
                run.update(|status| status.step = format!("{label}: copying"))
                    .await;
                let file = staging.join(format!("{stem}.{extension}"));
                render::copy_section(workshop.ffmpeg, &pieces[0], &file, &tags).await?;
                file
            }
            None => {
                let mut inserts = Vec::new();
                for slot in slots {
                    run.check()?;
                    inserts
                        .extend(slot_inserts(run, workshop, section, slot, words, &label).await?);
                }
                run.update(|status| status.step = format!("{label}: writing"))
                    .await;
                let file = staging.join(format!("{stem}.m4a"));
                render::splice_section(workshop.ffmpeg, &pieces, &inserts, format, &file, &tags)
                    .await?;
                file
            }
        };
        first_file.get_or_insert(file);
        run.update(|status| status.completed = position + 1).await;
    }
    if let Some(file) = first_file {
        render::attach_cover(workshop.ffmpeg, &audio.tracks[0].0, &file).await;
    }
    Ok(())
}

/// The clips for one slot, fetched or found, as the inserts that put them in
/// the chapter.
async fn slot_inserts(
    run: &RunHandle,
    workshop: &Workshop<'_>,
    section: &Section,
    slot: &Slot,
    words: &Words,
    label: &str,
) -> Result<Vec<Insert>, RunError> {
    let part = |number: usize, total: usize| {
        if total > 1 {
            format!(" (part {} of {total})", number + 1)
        } else {
            String::new()
        }
    };
    let (text, model) = match &slot.source {
        SlotSource::Performance | SlotSource::Spoken => {
            let requests = workshop
                .changer_requests(
                    slot.start_seconds,
                    slot.end_seconds,
                    slot.source == SlotSource::Spoken,
                )
                .await?;
            let mut inserts = Vec::new();
            for (number, stretches) in requests.iter().enumerate() {
                run.check()?;
                let at = stretches
                    .first()
                    .map_or(slot.start_seconds, |first| first.0);
                run.update(|status| {
                    status.step = format!(
                        "{label}: changing the voice at {}{}",
                        clock(at),
                        part(number, requests.len())
                    );
                })
                .await;
                inserts.extend(
                    workshop
                        .changed(
                            section.start_seconds,
                            &slot.voice_id,
                            slot.settings.as_ref(),
                            stretches,
                        )
                        .await?,
                );
            }
            return Ok(inserts);
        }
        SlotSource::Text(text) => (Some(text.clone()), elevenlabs::SPEECH_MODEL),
        SlotSource::Narration => (
            words.narration.get(&section.index).cloned(),
            elevenlabs::SPEECH_MODEL,
        ),
        SlotSource::Heard { cheaply } => (
            words
                .heard
                .get(&section.index)
                .map(|lines| heard_text(lines, slot.start_seconds, slot.end_seconds)),
            if *cheaply {
                elevenlabs::CHEAP_SPEECH_MODEL
            } else {
                elevenlabs::SPEECH_MODEL
            },
        ),
    };
    let Some(text) = text else {
        return Err(RunError::Failed(format!(
            "{} has no text to read from.",
            section.title
        )));
    };
    let chunks = speech_chunks(&text, elevenlabs::SPEECH_CHARACTERS);
    if chunks.is_empty() {
        // Nothing was heard there, so there is nothing to say in its place.
        return Ok(Vec::new());
    }
    let mut clips = Vec::new();
    for (number, chunk) in chunks.iter().enumerate() {
        run.check()?;
        run.update(|status| {
            status.step = format!(
                "{label}: speaking at {}{}",
                clock(slot.start_seconds),
                part(number, chunks.len())
            );
        })
        .await;
        clips.push(workshop.speech(&slot.voice_id, chunk, model).await?);
    }
    // A line rewritten by hand may be meant louder or softer than what it
    // replaces. A voice read from the transcript is meant to sit where the
    // old one did.
    let matched = matches!(slot.source, SlotSource::Heard { .. });
    Ok(vec![
        workshop
            .spoken(
                section.start_seconds,
                slot.start_seconds,
                slot.end_seconds,
                clips,
                matched,
            )
            .await,
    ])
}

fn clock(seconds: f64) -> String {
    let seconds = seconds.max(0.0) as u64;
    format!(
        "{}:{:02}:{:02}",
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60
    )
}

/// Moves the finished folder into the library under a name of its own and
/// adds it to the catalogue.
async fn publish_copy(
    state: &AppState,
    book_id: &str,
    title: &str,
    staging: &FsPath,
) -> Result<(), RunError> {
    let id = random_hex_id();
    fs::write(staging.join(COPY_MARKER), &id).await?;
    let folder = {
        let _publishing = state.upload_lock.lock().await;
        let base = sanitize_filename(title);
        let mut folder = base.clone();
        let mut number = 1;
        while fs::try_exists(state.library_root.join(&folder)).await? {
            number += 1;
            folder = format!("{base} {number}");
        }
        fs::rename(staging, state.library_root.join(&folder)).await?;
        folder
    };
    let mut copies = load_copies(state).await;
    copies.push(CopyRecord {
        id,
        source_book_id: book_id.to_string(),
        folder,
        created_at: rfc3339_utc(unix_now_seconds()),
    });
    save_copies(state, &copies).await?;
    rescan_library(state).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async fn ensure_book(state: &AppState, auth: &AuthUser, book_id: &str) -> Result<(), ApiError> {
    require_book_access(auth, book_id)?;
    state.library.read().await.book(book_id).map(|_| ())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SectionView {
    index: usize,
    title: String,
    start_seconds: f64,
    end_seconds: f64,
    /// Present once the chapter's speakers have been found.
    #[serde(skip_serializing_if = "Option::is_none")]
    speakers: Option<Vec<SpeakerSummary>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    passages: Option<Vec<Passage>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CopyView {
    id: String,
    folder: String,
    created_at: String,
    /// The copy's own book, while it is in the library.
    #[serde(skip_serializing_if = "Option::is_none")]
    book_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectView {
    book_id: String,
    chapters: Vec<SectionView>,
    edits: Vec<Edit>,
    cast: Vec<CastMember>,
    #[serde(skip_serializing_if = "Option::is_none")]
    run: Option<RunStatus>,
    copies: Vec<CopyView>,
}

async fn project_view(state: &AppState, book_id: &str) -> Result<ProjectView, ApiError> {
    let audio = book_audio(state, book_id).await?;
    let project = load_project(state, book_id).await;
    let mut chapters = Vec::new();
    for section in sections(&audio.book) {
        let analysed = project.analysis_of(&section);
        let found = match analysed {
            Some(AnalysedSection {
                passages: Some(found),
                ..
            }) => Some(found.clone()),
            Some(_) => Some(passages(
                &section,
                &load_lines(state, book_id, section.index).await,
            )),
            None => None,
        };
        chapters.push(SectionView {
            speakers: analysed.map(|analysed| analysed.speakers.clone()),
            passages: found,
            index: section.index,
            title: section.title,
            start_seconds: section.start_seconds,
            end_seconds: section.end_seconds,
        });
    }
    let run = RUNS
        .lock()
        .await
        .get(&run_key(state, book_id))
        .map(|run| run.status.clone());
    let mut records = Vec::new();
    for copy in load_copies(state).await {
        if copy.source_book_id == book_id {
            let in_place = copy_is_in_place(state, &copy).await;
            records.push((copy, in_place));
        }
    }
    let library = state.library.read().await;
    let copies = records
        .into_iter()
        .map(|(copy, in_place)| {
            let path = state.library_root.join(&copy.folder);
            CopyView {
                book_id: library
                    .book_paths
                    .iter()
                    .find(|(_, book_path)| in_place && **book_path == path)
                    .map(|(id, _)| id.clone()),
                id: copy.id,
                folder: copy.folder,
                created_at: copy.created_at,
            }
        })
        .collect();
    Ok(ProjectView {
        book_id: book_id.to_string(),
        chapters,
        edits: project.edits,
        cast: project.cast,
        run,
        copies,
    })
}

pub(crate) async fn get_voice_project(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Path(book_id): Path<String>,
) -> Result<Json<ProjectView>, ApiError> {
    ensure_book(&state, &auth, &book_id).await?;
    Ok(Json(project_view(&state, &book_id).await?))
}

/// Forgets a book's plan, transcripts and saved clips. Copies already made
/// stay in the library.
pub(crate) async fn delete_voice_project(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Path(book_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    ensure_book(&state, &auth, &book_id).await?;
    {
        let key = run_key(&state, &book_id);
        let mut runs = RUNS.lock().await;
        if runs
            .get(&key)
            .is_some_and(|run| run.status.state == "running")
        {
            return Err(ApiError::conflict(
                "Stop the work on this book before clearing it.",
            ));
        }
        runs.remove(&key);
    }
    let _writing = PROJECT_WRITES.lock().await;
    match fs::remove_dir_all(project_dir(&state, &book_id)).await {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(StatusCode::NO_CONTENT),
        Err(error) => Err(ApiError::internal(format!(
            "Could not remove the saved work: {error}"
        ))),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnalysisInput {
    chapters: Vec<usize>,
}

pub(crate) async fn start_voice_analysis(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Path(book_id): Path<String>,
    Json(input): Json<AnalysisInput>,
) -> Result<Json<ProjectView>, ApiError> {
    ensure_book(&state, &auth, &book_id).await?;
    let audio = book_audio(&state, &book_id).await?;
    let known = sections(&audio.book);
    let mut indexes = input.chapters;
    indexes.sort_unstable();
    indexes.dedup();
    if indexes.is_empty()
        || indexes
            .iter()
            .any(|index| !known.iter().any(|section| section.index == *index))
    {
        return Err(ApiError::bad_request("Choose chapters from this book."));
    }
    // Refused here, where the answer can be shown, not after the run starts.
    provider(&state).await?;
    if audio_tools(&state).is_none() {
        return Err(ApiError::service_unavailable(
            "Finding speakers needs ffmpeg on the server.",
        ));
    }
    let total = indexes.len();
    start_run(&state, &book_id, "analysis", total, move |state, run| {
        analyse(state, run, indexes)
    })
    .await?;
    Ok(Json(project_view(&state, &book_id).await?))
}

#[derive(Serialize)]
pub(crate) struct LinesView {
    lines: Vec<Line>,
}

pub(crate) async fn get_voice_lines(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Path((book_id, index)): Path<(String, usize)>,
) -> Result<Json<LinesView>, ApiError> {
    ensure_book(&state, &auth, &book_id).await?;
    let audio = book_audio(&state, &book_id).await?;
    let project = load_project(&state, &book_id).await;
    let analysed = sections(&audio.book)
        .iter()
        .any(|section| section.index == index && project.analysis_of(section).is_some());
    if !analysed {
        return Err(ApiError::not_found(
            "This chapter's speakers have not been found yet.",
        ));
    }
    Ok(Json(LinesView {
        lines: load_lines(&state, &book_id, index).await,
    }))
}

fn valid_voice(voice: &mut VoiceChoice) -> Result<(), ApiError> {
    // The id becomes part of a request path.
    let id_ok = (1..=64).contains(&voice.voice_id.len())
        && voice
            .voice_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'));
    if !id_ok {
        return Err(ApiError::bad_request("Choose a voice from the list."));
    }
    voice.name = voice
        .name
        .chars()
        .filter(|character| !character.is_control())
        .take(120)
        .collect::<String>()
        .trim()
        .to_string();
    if let Some(settings) = &mut voice.settings {
        for value in [
            &mut settings.stability,
            &mut settings.similarity,
            &mut settings.style,
        ] {
            if !(0.0..=1.0).contains(value) {
                return Err(ApiError::bad_request("Voice settings run from 0 to 1."));
            }
            *value = (*value * 100.0).round() / 100.0;
        }
    }
    Ok(())
}

/// Checks a cast member against the book as it is now, and tidies it for
/// saving: stretches in order, each inside one chapter, none overlapping.
fn valid_cast_member(mut member: CastMember, known: &[Section]) -> Result<CastMember, ApiError> {
    let id_ok = (1..=64).contains(&member.id.len())
        && member
            .id
            .chars()
            .all(|character| character.is_ascii_alphanumeric());
    if !id_ok {
        member.id = random_hex_id();
    }
    member.name = member
        .name
        .chars()
        .filter(|character| !character.is_control())
        .take(80)
        .collect::<String>()
        .trim()
        .to_string();
    if member.name.is_empty() {
        return Err(ApiError::bad_request("Give each voice in the cast a name."));
    }
    valid_voice(&mut member.voice)?;
    if member.stretches.len() > MAX_STRETCHES {
        return Err(ApiError::bad_request(format!(
            "One voice holds at most {MAX_STRETCHES} stretches."
        )));
    }
    for stretch in &member.stretches {
        let inside = stretch.start_seconds.is_finite()
            && stretch.end_seconds.is_finite()
            && stretch.end_seconds - stretch.start_seconds >= MIN_SLOT_SECONDS
            && known.iter().any(|section| {
                stretch.start_seconds >= section.start_seconds - 0.001
                    && stretch.end_seconds <= section.end_seconds + 0.001
            });
        if !inside {
            return Err(ApiError::bad_request(format!(
                "A stretch for {} does not sit inside one chapter.",
                member.name
            )));
        }
    }
    member
        .stretches
        .sort_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds));
    if member
        .stretches
        .windows(2)
        .any(|pair| pair[1].start_seconds < pair[0].end_seconds)
    {
        return Err(ApiError::bad_request(format!(
            "Two stretches for {} overlap.",
            member.name
        )));
    }
    Ok(member)
}

/// Checks an edit against the book as it is now, and tidies it for saving.
fn valid_edit(mut edit: Edit, known: &[Section], project: &Project) -> Result<Edit, ApiError> {
    let section = known
        .iter()
        .find(|section| section.index == edit.chapter())
        .ok_or_else(|| ApiError::bad_request("An edit names a chapter this book does not have."))?;
    let id = edit.id_mut();
    if id.is_empty()
        || id.len() > 64
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        *id = random_hex_id();
    }
    match &mut edit {
        Edit::Speaker { speaker, voice, .. } => {
            valid_voice(voice)?;
            let found = project
                .analysis_of(section)
                .is_some_and(|analysed| analysed.speakers.iter().any(|known| known.id == *speaker));
            if !found {
                return Err(ApiError::bad_request(
                    "An edit names a narrator who has not been found in that chapter.",
                ));
            }
        }
        Edit::Line {
            start_seconds,
            end_seconds,
            voice,
            text,
            ..
        } => {
            valid_voice(voice)?;
            let inside = start_seconds.is_finite()
                && end_seconds.is_finite()
                && *start_seconds >= section.start_seconds - 0.5
                && *end_seconds <= section.end_seconds + 0.5
                && *end_seconds - *start_seconds >= MIN_SLOT_SECONDS
                && *end_seconds - *start_seconds <= elevenlabs::VOICE_CHANGER_SECONDS;
            if !inside {
                return Err(ApiError::bad_request(
                    "A line must sit inside its chapter and run under five minutes.",
                ));
            }
            if let Some(words) = text {
                let tidy = words.split_whitespace().collect::<Vec<_>>().join(" ");
                if tidy.chars().count() > elevenlabs::SPEECH_CHARACTERS
                    || tidy.chars().any(char::is_control)
                {
                    return Err(ApiError::bad_request("That line's text is too long."));
                }
                *text = (!tidy.is_empty()).then_some(tidy);
            }
        }
        Edit::Chapter { voice, .. } => valid_voice(voice)?,
        Edit::Keep {
            start_seconds,
            end_seconds,
            ..
        } => {
            let inside = start_seconds.is_finite()
                && end_seconds.is_finite()
                && *start_seconds >= section.start_seconds - 0.5
                && *end_seconds <= section.end_seconds + 0.5
                && *end_seconds - *start_seconds >= MIN_SLOT_SECONDS;
            if !inside {
                return Err(ApiError::bad_request(
                    "A stretch to keep must sit inside its chapter.",
                ));
            }
        }
    }
    Ok(edit)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PlanInput {
    edits: Vec<Edit>,
    #[serde(default)]
    cast: Vec<CastMember>,
}

pub(crate) async fn put_voice_plan(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Path(book_id): Path<String>,
    Json(input): Json<PlanInput>,
) -> Result<Json<ProjectView>, ApiError> {
    ensure_book(&state, &auth, &book_id).await?;
    if input.edits.len() > MAX_EDITS {
        return Err(ApiError::bad_request(format!(
            "A plan holds at most {MAX_EDITS} edits."
        )));
    }
    let audio = book_audio(&state, &book_id).await?;
    let known = sections(&audio.book);
    let project = load_project(&state, &book_id).await;
    let edits = input
        .edits
        .into_iter()
        .map(|edit| valid_edit(edit, &known, &project))
        .collect::<Result<Vec<_>, _>>()?;
    if input.cast.len() > MAX_CAST {
        return Err(ApiError::bad_request(format!(
            "A cast holds at most {MAX_CAST} voices."
        )));
    }
    let cast = input
        .cast
        .into_iter()
        .map(|member| valid_cast_member(member, &known))
        .collect::<Result<Vec<_>, _>>()?;
    change_project(&state, &book_id, |project| {
        project.edits = edits;
        project.cast = cast;
    })
    .await?;
    Ok(Json(project_view(&state, &book_id).await?))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Estimate {
    /// Narration that goes through the voice changer.
    voice_changer_seconds: f64,
    /// Pauses left out of that for voices set to skip them.
    pauses_skipped_seconds: f64,
    /// Stretches set to skip pauses whose pauses have not been found yet.
    /// They are counted in full, so the credits are still the most it can
    /// cost; asking again finds more of them.
    pauses_unmeasured_seconds: f64,
    /// Text that is spoken afresh.
    speech_characters: usize,
    /// What ElevenLabs bills for both, at most: clips already made are free.
    credits: u64,
    chapters_changed: usize,
    /// Chapters set to be read from text that have none yet.
    chapters_without_text: Vec<String>,
    /// What each voice in the cast accounts for, before lines and kept
    /// stretches are taken out of it.
    cast: Vec<CastEstimate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CastEstimate {
    id: String,
    seconds: f64,
    credits: u64,
    /// Set to be read from its text, with a stretch in a chapter that has
    /// no transcript.
    without_text: bool,
}

/// What speech costs: a credit a character, or half that from the cheaper
/// model.
fn speech_credits(characters: usize, cheaply: bool) -> u64 {
    if cheaply {
        characters.div_ceil(2) as u64
    } else {
        characters as u64
    }
}

fn changer_credits(seconds: f64) -> u64 {
    (seconds / 60.0 * elevenlabs::CREDITS_PER_MINUTE).ceil() as u64
}

pub(crate) async fn get_voice_estimate(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Path(book_id): Path<String>,
) -> Result<Json<Estimate>, ApiError> {
    ensure_book(&state, &auth, &book_id).await?;
    let audio = book_audio(&state, &book_id).await?;
    let project = load_project(&state, &book_id).await;
    let planned = planned_slots(&state, &audio, &project).await;
    let narrated: Vec<&Section> = planned
        .iter()
        .filter(|(_, slots)| {
            slots
                .iter()
                .any(|slot| slot.source == SlotSource::Narration)
        })
        .map(|(section, _)| section)
        .collect();
    let texts = narration_texts(&state, &audio, &project, &narrated).await;
    let heard = heard_lines(&state, &book_id, &project, &planned).await;
    let tools = audio_tools(&state);
    let pauses_dir = project_dir(&state, &book_id).join("pauses");
    let mut estimate = Estimate {
        voice_changer_seconds: 0.0,
        pauses_skipped_seconds: 0.0,
        pauses_unmeasured_seconds: 0.0,
        speech_characters: 0,
        credits: 0,
        chapters_changed: planned
            .iter()
            .filter(|(_, slots)| !slots.is_empty())
            .count(),
        chapters_without_text: narrated
            .iter()
            .filter(|section| !texts.contains_key(&section.index))
            .map(|section| section.title.clone())
            .collect(),
        cast: Vec::new(),
    };
    let mut speech = 0u64;
    let mut listen_left = ESTIMATE_LISTEN_SECONDS;
    for (section, slots) in &planned {
        for slot in slots {
            let length = slot.end_seconds - slot.start_seconds;
            match &slot.source {
                SlotSource::Performance => estimate.voice_changer_seconds += length,
                SlotSource::Spoken => {
                    let mut pauses =
                        saved_pauses(&pauses_dir, slot.start_seconds, slot.end_seconds).await;
                    if pauses.is_none()
                        && length <= listen_left
                        && let Some(tools) = &tools
                    {
                        listen_left -= length;
                        pauses = stretch_pauses(
                            &pauses_dir,
                            &tools.ffmpeg,
                            &audio.tracks,
                            slot.start_seconds,
                            slot.end_seconds,
                        )
                        .await
                        .ok();
                    }
                    match pauses {
                        Some(pauses) => {
                            let sent = seconds_in(&speech_in(
                                slot.start_seconds,
                                slot.end_seconds,
                                &pauses,
                            ));
                            estimate.voice_changer_seconds += sent;
                            estimate.pauses_skipped_seconds += length - sent;
                        }
                        None => {
                            estimate.voice_changer_seconds += length;
                            estimate.pauses_unmeasured_seconds += length;
                        }
                    }
                }
                SlotSource::Text(text) => {
                    let characters = text.chars().count();
                    estimate.speech_characters += characters;
                    speech += speech_credits(characters, false);
                }
                SlotSource::Narration => {
                    let characters = texts
                        .get(&section.index)
                        .map_or(0, |text| text.chars().count());
                    estimate.speech_characters += characters;
                    speech += speech_credits(characters, false);
                }
                SlotSource::Heard { cheaply } => match heard.get(&section.index) {
                    Some(lines) => {
                        let characters = heard_text(lines, slot.start_seconds, slot.end_seconds)
                            .chars()
                            .count();
                        estimate.speech_characters += characters;
                        speech += speech_credits(characters, *cheaply);
                    }
                    None => {
                        if !estimate.chapters_without_text.contains(&section.title) {
                            estimate.chapters_without_text.push(section.title.clone());
                        }
                    }
                },
            }
        }
    }
    estimate.credits = changer_credits(estimate.voice_changer_seconds) + speech;
    // After the plan's own stretches, whose pauses have been found by now.
    let known = sections(&audio.book);
    for member in &project.cast {
        let seconds: f64 = member
            .stretches
            .iter()
            .map(|stretch| stretch.end_seconds - stretch.start_seconds)
            .sum();
        let mut without_text = false;
        let credits = match member.method {
            CastMethod::KeepPerformance => changer_credits(seconds),
            CastMethod::SkipPauses => {
                let mut sent = 0.0;
                for stretch in &member.stretches {
                    sent +=
                        match saved_pauses(&pauses_dir, stretch.start_seconds, stretch.end_seconds)
                            .await
                        {
                            Some(pauses) => seconds_in(&speech_in(
                                stretch.start_seconds,
                                stretch.end_seconds,
                                &pauses,
                            )),
                            None => stretch.end_seconds - stretch.start_seconds,
                        };
                }
                changer_credits(sent)
            }
            CastMethod::ReadText | CastMethod::ReadTextCheaply => {
                let mut characters = 0;
                for stretch in &member.stretches {
                    let lines = known
                        .iter()
                        .find(|section| {
                            stretch.start_seconds >= section.start_seconds - 0.001
                                && stretch.end_seconds <= section.end_seconds + 0.001
                        })
                        .and_then(|section| heard.get(&section.index));
                    match lines {
                        Some(lines) => {
                            characters +=
                                heard_text(lines, stretch.start_seconds, stretch.end_seconds)
                                    .chars()
                                    .count();
                        }
                        None => without_text = true,
                    }
                }
                speech_credits(characters, member.method == CastMethod::ReadTextCheaply)
            }
        };
        estimate.cast.push(CastEstimate {
            id: member.id.clone(),
            seconds,
            credits,
            without_text,
        });
    }
    Ok(Json(estimate))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RenderInput {
    #[serde(default)]
    acknowledge_cost: bool,
}

pub(crate) async fn start_voice_render(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Path(book_id): Path<String>,
    Json(input): Json<RenderInput>,
) -> Result<Json<ProjectView>, ApiError> {
    ensure_book(&state, &auth, &book_id).await?;
    if !input.acknowledge_cost {
        return Err(ApiError::bad_request(
            "Confirm the ElevenLabs cost before making a copy.",
        ));
    }
    provider(&state).await?;
    if audio_tools(&state).is_none() {
        return Err(ApiError::service_unavailable(
            "Making a copy needs ffmpeg on the server.",
        ));
    }
    let audio = book_audio(&state, &book_id).await?;
    let total = sections(&audio.book).len();
    start_run(&state, &book_id, "render", total, make_copy).await?;
    Ok(Json(project_view(&state, &book_id).await?))
}

/// Stops the work on a book, or dismisses a failure.
pub(crate) async fn stop_voice_run(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Path(book_id): Path<String>,
) -> Result<Json<ProjectView>, ApiError> {
    ensure_book(&state, &auth, &book_id).await?;
    {
        let key = run_key(&state, &book_id);
        let mut runs = RUNS.lock().await;
        match runs.get_mut(&key) {
            Some(run) if run.status.state == "running" => {
                run.cancel.store(true, Ordering::SeqCst);
                run.status.step = "Stopping".into();
            }
            Some(_) => {
                runs.remove(&key);
            }
            None => {}
        }
    }
    Ok(Json(project_view(&state, &book_id).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListenQuery {
    start_seconds: f64,
    end_seconds: f64,
}

fn audio_response(bytes: Vec<u8>, content_type: &'static str) -> Response {
    (
        [
            (CONTENT_TYPE, content_type),
            (CACHE_CONTROL, "private, no-store"),
        ],
        bytes,
    )
        .into_response()
}

/// A short stretch of the book as it is now, to tell narrators apart by ear.
pub(crate) async fn listen_to_original(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Path(book_id): Path<String>,
    Query(query): Query<ListenQuery>,
) -> Result<Response, ApiError> {
    ensure_book(&state, &auth, &book_id).await?;
    let length = query.end_seconds - query.start_seconds;
    if !(query.start_seconds >= 0.0 && length > 0.0 && length <= MAX_LISTEN_SECONDS) {
        return Err(ApiError::bad_request(
            "Ask for up to thirty seconds of the book.",
        ));
    }
    let audio = book_audio(&state, &book_id).await?;
    let tools = audio_tools(&state)
        .ok_or_else(|| ApiError::service_unavailable("Listening needs ffmpeg on the server."))?;
    let work_dir = tempfile::tempdir()?;
    let clip = work_dir.path().join("clip.wav");
    render::extract_clip(
        &tools.ffmpeg,
        &render::pieces(&audio.tracks, query.start_seconds, query.end_seconds),
        &clip,
        22_050,
    )
    .await?;
    Ok(audio_response(fs::read(&clip).await?, "audio/wav"))
}

/// A few seconds of an edit as it would sound. It is billed like any other
/// clip, and a line's preview is the clip its copy will use.
pub(crate) async fn preview_voice_edit(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Path(book_id): Path<String>,
    Json(edit): Json<Edit>,
) -> Result<Response, ApiError> {
    ensure_book(&state, &auth, &book_id).await?;
    let audio = book_audio(&state, &book_id).await?;
    let project = load_project(&state, &book_id).await;
    let known = sections(&audio.book);
    let edit = valid_edit(edit, &known, &project)?;
    let section = known
        .iter()
        .find(|section| section.index == edit.chapter())
        .expect("a valid edit names a chapter");
    let provider = provider(&state).await?;
    let tools = audio_tools(&state)
        .ok_or_else(|| ApiError::service_unavailable("A preview needs ffmpeg on the server."))?;
    let directory = project_dir(&state, &book_id);
    fs::create_dir_all(&directory).await?;
    let work_dir = tempfile::Builder::new()
        .prefix("work-")
        .tempdir_in(&directory)?;
    let format = render::probe(&tools, &audio.tracks[0].0).await;
    let workshop = Workshop {
        provider: &provider,
        ffmpeg: &tools.ffmpeg,
        tracks: &audio.tracks,
        clips_dir: directory.join("clips"),
        work_dir: work_dir.path(),
        format,
    };
    let voice = edit
        .voice()
        .ok_or_else(|| ApiError::bad_request("A stretch kept as it is has nothing new to hear."))?
        .clone();
    let voice_id = voice.voice_id.clone();
    let settings = voice.settings.as_ref();
    let performance = |start: f64, end: f64| (start, end.min(start + PREVIEW_SECONDS));
    let clip = match &edit {
        Edit::Speaker { speaker, .. } => {
            let sample = project
                .analysis_of(section)
                .and_then(|analysed| analysed.speakers.iter().find(|known| known.id == *speaker))
                .expect("a valid edit names a found narrator");
            let (start, end) = performance(sample.sample_start_seconds, sample.sample_end_seconds);
            workshop
                .performance(&voice_id, settings, &[(start, end)])
                .await
        }
        Edit::Line {
            start_seconds,
            end_seconds,
            text: None,
            ..
        } => {
            // The whole line, so the copy reuses this clip.
            workshop
                .performance(&voice_id, settings, &[(*start_seconds, *end_seconds)])
                .await
        }
        Edit::Line {
            text: Some(text), ..
        } => {
            workshop
                .speech(&voice_id, text, elevenlabs::SPEECH_MODEL)
                .await
        }
        Edit::Chapter {
            method: ChapterMethod::KeepPerformance,
            ..
        } => {
            let (start, end) = performance(section.start_seconds, section.end_seconds);
            workshop
                .performance(&voice_id, settings, &[(start, end)])
                .await
        }
        Edit::Chapter {
            method: ChapterMethod::ReadText,
            ..
        } => {
            let texts = narration_texts(&state, &audio, &project, &[section]).await;
            let text = texts.get(&section.index).ok_or_else(|| {
                ApiError::bad_request(
                    "This chapter has no text to read from. Find its speakers first, which also transcribes it.",
                )
            })?;
            let opening = speech_chunks(text, PREVIEW_CHARACTERS)
                .into_iter()
                .next()
                .unwrap_or_default();
            workshop
                .speech(&voice_id, &opening, elevenlabs::SPEECH_MODEL)
                .await
        }
        Edit::Keep { .. } => unreachable!("a kept stretch has no voice"),
    }
    .map_err(|error| ApiError::bad_gateway(error.to_string()))?;
    Ok(audio_response(fs::read(&clip).await?, "audio/mpeg"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AuditionInput {
    voice: VoiceChoice,
    start_seconds: f64,
    end_seconds: f64,
    /// Seconds of the book as it is, heard first, so the join can be judged.
    #[serde(default)]
    lead_seconds: f64,
    /// The way the voice would be replaced, so what is heard is what a copy
    /// made that way would hold.
    #[serde(default)]
    method: CastMethod,
}

/// Up to half a minute of the book in a voice as it is set, before anything
/// is planned. It is joined to what comes before it the way a copy is, and
/// billed like any other clip.
pub(crate) async fn audition_voice(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Path(book_id): Path<String>,
    Json(mut input): Json<AuditionInput>,
) -> Result<Response, ApiError> {
    ensure_book(&state, &auth, &book_id).await?;
    valid_voice(&mut input.voice)?;
    let audio = book_audio(&state, &book_id).await?;
    let length = input.end_seconds - input.start_seconds;
    let inside = input.start_seconds.is_finite()
        && input.end_seconds.is_finite()
        && (1.0..=AUDITION_SECONDS).contains(&length)
        && sections(&audio.book).iter().any(|section| {
            input.start_seconds >= section.start_seconds - 0.001
                && input.end_seconds <= section.end_seconds + 0.001
        });
    if !inside || !(0.0..=AUDITION_LEAD_SECONDS).contains(&input.lead_seconds) {
        return Err(ApiError::bad_request(
            "Try up to thirty seconds from inside one chapter.",
        ));
    }
    let provider = provider(&state).await?;
    let tools = audio_tools(&state).ok_or_else(|| {
        ApiError::service_unavailable("Trying a voice needs ffmpeg on the server.")
    })?;
    let directory = project_dir(&state, &book_id);
    fs::create_dir_all(&directory).await?;
    let work_dir = tempfile::Builder::new()
        .prefix("work-")
        .tempdir_in(&directory)?;
    let format = render::probe(&tools, &audio.tracks[0].0).await;
    let workshop = Workshop {
        provider: &provider,
        ffmpeg: &tools.ffmpeg,
        tracks: &audio.tracks,
        clips_dir: directory.join("clips"),
        work_dir: work_dir.path(),
        format,
    };
    let from = (input.start_seconds - input.lead_seconds).max(0.0);
    let voice_id = input.voice.voice_id.as_str();
    let provider_failed = |error: anyhow::Error| ApiError::bad_gateway(error.to_string());
    let inserts = match input.method {
        CastMethod::KeepPerformance | CastMethod::SkipPauses => {
            let requests = workshop
                .changer_requests(
                    input.start_seconds,
                    input.end_seconds,
                    input.method == CastMethod::SkipPauses,
                )
                .await?;
            let mut inserts = Vec::new();
            for stretches in &requests {
                inserts.extend(
                    workshop
                        .changed(from, voice_id, input.voice.settings.as_ref(), stretches)
                        .await
                        .map_err(provider_failed)?,
                );
            }
            inserts
        }
        CastMethod::ReadText | CastMethod::ReadTextCheaply => {
            let project = load_project(&state, &book_id).await;
            let transcribed = sections(&audio.book).into_iter().find(|section| {
                input.start_seconds >= section.start_seconds - 0.001
                    && input.end_seconds <= section.end_seconds + 0.001
                    && project.analysis_of(section).is_some()
            });
            let Some(section) = transcribed else {
                return Err(ApiError::bad_request(
                    "This chapter has not been transcribed, so there is no text to read from.",
                ));
            };
            let lines = load_lines(&state, &book_id, section.index).await;
            let text = heard_text(&lines, input.start_seconds, input.end_seconds);
            let Some(text) = speech_chunks(&text, elevenlabs::SPEECH_CHARACTERS)
                .into_iter()
                .next()
            else {
                return Err(ApiError::bad_request(
                    "The transcript holds nothing said in that part.",
                ));
            };
            let model = if input.method == CastMethod::ReadTextCheaply {
                elevenlabs::CHEAP_SPEECH_MODEL
            } else {
                elevenlabs::SPEECH_MODEL
            };
            let clip = workshop
                .speech(voice_id, &text, model)
                .await
                .map_err(provider_failed)?;
            vec![
                workshop
                    .spoken(
                        from,
                        input.start_seconds,
                        input.end_seconds,
                        vec![clip],
                        true,
                    )
                    .await,
            ]
        }
    };
    let heard = work_dir.path().join("audition.m4a");
    let title = "Audition";
    render::splice_section(
        &tools.ffmpeg,
        &render::pieces(&audio.tracks, from, input.end_seconds),
        &inserts,
        format,
        &heard,
        &render::Tags {
            title,
            album: title,
            author: None,
            track: 1,
            track_count: 1,
        },
    )
    .await?;
    Ok(audio_response(fs::read(&heard).await?, "audio/mp4"))
}

/// Removes a copy this feature made, folder and all, while the folder is
/// still that copy.
pub(crate) async fn delete_voice_copy(
    State(state): State<AppState>,
    AdminUser(auth): AdminUser,
    Path((book_id, copy_id)): Path<(String, String)>,
) -> Result<Json<ProjectView>, ApiError> {
    ensure_book(&state, &auth, &book_id).await?;
    let mut copies = load_copies(&state).await;
    let at = copies
        .iter()
        .position(|copy| copy.id == copy_id && copy.source_book_id == book_id)
        .ok_or_else(|| ApiError::not_found("That copy is not on record."))?;
    {
        let _publishing = state.upload_lock.lock().await;
        // A folder that is gone, or is no longer this copy, is left alone and
        // only the record of it is dropped.
        if copy_is_in_place(&state, &copies[at]).await {
            fs::remove_dir_all(state.library_root.join(&copies[at].folder)).await?;
        }
    }
    copies.remove(at);
    save_copies(&state, &copies).await?;
    rescan_library(&state).await?;
    Ok(Json(project_view(&state, &book_id).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(text: &str, start: f64, end: f64, speaker: &str) -> elevenlabs::Word {
        elevenlabs::Word {
            text: text.into(),
            start,
            end,
            speaker: speaker.into(),
        }
    }

    fn line(speaker: &str, start: f64, end: f64) -> Line {
        Line {
            speaker: speaker.into(),
            start_seconds: start,
            end_seconds: end,
            text: "words".into(),
        }
    }

    fn voice(id: &str) -> VoiceChoice {
        VoiceChoice {
            voice_id: id.into(),
            name: id.into(),
            settings: None,
        }
    }

    fn said(text: &str, start: f64, end: f64) -> Line {
        Line {
            text: text.into(),
            ..line("a", start, end)
        }
    }

    fn section() -> Section {
        Section {
            index: 2,
            title: "Two".into(),
            start_seconds: 100.0,
            end_seconds: 200.0,
        }
    }

    #[test]
    fn words_become_lines_at_sentences_speakers_and_pauses() {
        let words = [
            word("Call", 0.0, 0.3, "a"),
            word("me.", 0.3, 0.6, "a"),
            word("Then", 0.7, 0.9, "a"),
            word("who?\"", 1.0, 1.2, "b"),
            word("Nobody", 1.3, 1.6, "b"),
            word("answered", 5.0, 5.4, "b"),
        ];
        let lines = lines_from_words(&words, 100.0);
        let seen: Vec<(&str, &str, f64, f64)> = lines
            .iter()
            .map(|line| {
                (
                    line.speaker.as_str(),
                    line.text.as_str(),
                    line.start_seconds,
                    line.end_seconds,
                )
            })
            .collect();
        assert_eq!(
            seen,
            [
                ("a", "Call me.", 100.0, 100.6),
                ("a", "Then", 100.7, 100.9),
                ("b", "who?\"", 101.0, 101.2),
                ("b", "Nobody", 101.3, 101.6),
                ("b", "answered", 105.0, 105.4),
            ]
        );
        let speakers = speaker_summaries(&lines);
        assert_eq!(speakers[0].id, "b");
        assert_eq!(speakers[0].lines, 3);
        assert_eq!(speakers[1].id, "a");
        assert_eq!(
            (
                speakers[1].sample_start_seconds,
                speakers[1].sample_end_seconds
            ),
            (100.0, 100.6)
        );
    }

    #[test]
    fn a_narrators_turns_stop_where_someone_else_or_a_long_pause_begins() {
        let lines = [
            line("a", 100.0, 110.0),
            line("a", 110.4, 120.0),
            line("b", 120.1, 130.0),
            line("a", 131.0, 140.0),
            // Ten seconds of something that is not speech.
            line("a", 150.0, 160.0),
        ];
        let turns = speaker_turns(&lines, "a");
        let rounded: Vec<(f64, f64)> = turns
            .iter()
            .map(|(start, end)| {
                (
                    (start * 100.0).round() / 100.0,
                    (end * 100.0).round() / 100.0,
                )
            })
            .collect();
        assert_eq!(rounded, [(99.9, 120.05), (130.9, 140.15), (149.9, 160.15)]);
    }

    #[test]
    fn a_line_outranks_its_narrator_who_outranks_the_chapter() {
        let lines = [line("a", 110.0, 130.0), line("b", 130.5, 150.0)];
        let chapter = Edit::Chapter {
            id: "c".into(),
            chapter: 2,
            voice: voice("everyone"),
            method: ChapterMethod::KeepPerformance,
        };
        let speaker = Edit::Speaker {
            id: "s".into(),
            chapter: 2,
            speaker: "b".into(),
            voice: voice("reina"),
        };
        let spoken = Edit::Line {
            id: "l".into(),
            chapter: 2,
            start_seconds: 140.0,
            end_seconds: 142.0,
            voice: voice("reina"),
            text: Some("[whispers] No.".into()),
        };
        let slots = resolve(&section(), &[&spoken, &chapter, &speaker], &[], &lines);
        let seen: Vec<(f64, f64, &str, bool)> = slots
            .iter()
            .map(|slot| {
                (
                    (slot.start_seconds * 100.0).round() / 100.0,
                    (slot.end_seconds * 100.0).round() / 100.0,
                    slot.voice_id.as_str(),
                    matches!(slot.source, SlotSource::Text(_)),
                )
            })
            .collect();
        assert_eq!(
            seen,
            [
                (100.0, 130.4, "everyone", false),
                (130.4, 140.0, "reina", false),
                (140.0, 142.0, "reina", true),
                (142.0, 150.15, "reina", false),
                (150.15, 200.0, "everyone", false),
            ]
        );

        // Only the narrator: the rest of the chapter is left alone.
        let only = resolve(&section(), &[&speaker], &[], &lines);
        assert_eq!(only.len(), 1);
        assert_eq!(only[0].voice_id, "reina");

        // Reading from text replaces the chapter whatever else is planned.
        let read = Edit::Chapter {
            id: "r".into(),
            chapter: 2,
            voice: voice("reader"),
            method: ChapterMethod::ReadText,
        };
        let slots = resolve(&section(), &[&speaker, &spoken, &read], &[], &lines);
        assert_eq!(
            slots,
            [Slot {
                start_seconds: 100.0,
                end_seconds: 200.0,
                voice_id: "reader".into(),
                settings: None,
                source: SlotSource::Narration,
            }]
        );
    }

    #[test]
    fn a_chapter_is_cut_where_headings_are_said() {
        let lines = [
            // The chapter's own title, said close together: not a heading.
            said("Two.", 100.5, 100.8),
            said("Initiates", 101.9, 102.6),
            said("Mara.", 105.0, 105.4),
            said("Yesterday.", 107.2, 107.8),
            said("It was nearly a year since she had come.", 110.0, 114.0),
            // Short and slow, but not set apart enough to open a part.
            said("Or something.", 115.4, 116.2),
            said("She had not expected to stay this long.", 117.7, 121.0),
            said("Tomas.", 124.0, 124.5),
            said("He would wait.", 127.0, 128.5),
        ];
        let found = passages(&section(), &lines);
        let seen: Vec<(Vec<&str>, f64, f64)> = found
            .iter()
            .map(|passage| {
                (
                    passage.headings.iter().map(String::as_str).collect(),
                    (passage.start_seconds * 10.0).round() / 10.0,
                    (passage.end_seconds * 10.0).round() / 10.0,
                )
            })
            .collect();
        assert_eq!(
            seen,
            [
                (vec![], 100.0, 104.6),
                (vec!["Mara", "Yesterday"], 104.6, 123.6),
                (vec!["Tomas"], 123.6, 200.0),
            ]
        );

        // No headings: the chapter is one part.
        let plain = [said("It began as these things do, quietly.", 101.0, 104.0)];
        assert_eq!(
            passages(&section(), &plain),
            [Passage {
                headings: Vec::new(),
                start_seconds: 100.0,
                end_seconds: 200.0,
            }]
        );
    }

    #[test]
    fn a_heading_is_found_when_it_comes_back_without_a_full_stop() {
        // The same audio is transcribed with and without the stops; the
        // pauses are what set these headings apart.
        let words = [
            word("Mara", 5.0, 5.4, "a"),
            word("Yesterday", 7.2, 7.8, "a"),
            word("It", 10.5, 10.6, "a"),
            word("was", 10.6, 10.8, "a"),
            word("nearly", 10.8, 11.2, "a"),
            word("a", 11.2, 11.3, "a"),
            word("year", 11.3, 11.7, "a"),
        ];
        let lines = lines_from_words(&words, 100.0);
        let found = passages(&section(), &lines);
        // Said first in the chapter, so their part is the whole of it.
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].headings, ["Mara", "Yesterday"]);
        assert_eq!(found[0].start_seconds, 100.0);
    }

    #[test]
    fn the_cast_replaces_its_stretches_and_a_kept_stretch_stays() {
        let mut performer = voice("lily");
        performer.settings = Some(elevenlabs::ChangerSettings {
            stability: 0.3,
            similarity: 0.8,
            style: 0.0,
            remove_noise: false,
        });
        let cast = [CastMember {
            id: "m".into(),
            name: "Mara".into(),
            voice: performer.clone(),
            method: CastMethod::default(),
            stretches: vec![
                Stretch {
                    start_seconds: 120.0,
                    end_seconds: 160.0,
                },
                // Another chapter's: not this one's business.
                Stretch {
                    start_seconds: 300.0,
                    end_seconds: 340.0,
                },
            ],
        }];
        // A narrator found by voice would take 110 to 130; the cast is the
        // more exact instruction where they meet.
        let lines = [line("b", 110.0, 130.0)];
        let speaker = Edit::Speaker {
            id: "s".into(),
            chapter: 2,
            speaker: "b".into(),
            voice: voice("other"),
        };
        let keep = Edit::Keep {
            id: "k".into(),
            chapter: 2,
            start_seconds: 140.0,
            end_seconds: 145.0,
        };
        let slots = resolve(&section(), &[&keep, &speaker], &cast, &lines);
        let seen: Vec<(f64, f64, &str, bool)> = slots
            .iter()
            .map(|slot| {
                (
                    (slot.start_seconds * 10.0).round() / 10.0,
                    (slot.end_seconds * 10.0).round() / 10.0,
                    slot.voice_id.as_str(),
                    slot.settings.is_some(),
                )
            })
            .collect();
        assert_eq!(
            seen,
            [
                (109.9, 120.0, "other", false),
                (120.0, 140.0, "lily", true),
                (145.0, 160.0, "lily", true),
            ]
        );
    }

    #[test]
    fn a_voice_in_the_cast_is_replaced_the_way_it_is_set() {
        let member = |method| CastMember {
            id: "m".into(),
            name: "Mara".into(),
            voice: voice("lily"),
            method,
            stretches: vec![Stretch {
                start_seconds: 120.0,
                end_seconds: 160.0,
            }],
        };
        let source = |method| {
            resolve(&section(), &[], &[member(method)], &[])
                .remove(0)
                .source
        };
        assert_eq!(source(CastMethod::KeepPerformance), SlotSource::Performance);
        assert_eq!(source(CastMethod::SkipPauses), SlotSource::Spoken);
        assert_eq!(
            source(CastMethod::ReadTextCheaply),
            SlotSource::Heard { cheaply: true }
        );
        // A plan saved before there was a choice keeps the whole performance,
        // and one that still does is saved as it was.
        let saved = serde_json::json!({
            "id": "m", "name": "Mara", "voice": { "voiceId": "lily", "name": "lily" },
            "stretches": [{ "startSeconds": 120.0, "endSeconds": 160.0 }],
        });
        let read: CastMember = serde_json::from_value(saved.clone()).unwrap();
        assert_eq!(read.method, CastMethod::KeepPerformance);
        assert_eq!(serde_json::to_value(&read).unwrap(), saved);
        assert_eq!(
            serde_json::to_value(member(CastMethod::SkipPauses)).unwrap()["method"],
            "skipPauses"
        );

        // Read from its text, a stretch says the lines that fall in it, and
        // the cheaper model bills half.
        let lines = [
            said("Before.", 110.0, 119.0),
            said("First line.", 121.0, 125.0),
            said("Second line.", 150.0, 158.0),
            said("After.", 159.0, 163.0),
        ];
        assert_eq!(heard_text(&lines, 120.0, 160.0), "First line. Second line.");
        assert_eq!(speech_credits(25, false), 25);
        assert_eq!(speech_credits(25, true), 13);
    }

    #[test]
    fn a_cast_member_is_checked_against_the_book() {
        let known = [section()];
        let member = |stretches: Vec<(f64, f64)>| CastMember {
            id: String::new(),
            name: "  Mara ".into(),
            voice: voice("lily"),
            method: CastMethod::default(),
            stretches: stretches
                .into_iter()
                .map(|(start_seconds, end_seconds)| Stretch {
                    start_seconds,
                    end_seconds,
                })
                .collect(),
        };
        let tidy = valid_cast_member(member(vec![(150.0, 160.0), (110.0, 120.0)]), &known)
            .unwrap_or_else(|_| panic!("a member inside the chapter is accepted"));
        assert_eq!(tidy.name, "Mara");
        assert!(!tidy.id.is_empty());
        assert_eq!(tidy.stretches[0].start_seconds, 110.0);
        // Across a chapter's end, overlapping, or with settings out of range.
        assert!(valid_cast_member(member(vec![(190.0, 210.0)]), &known).is_err());
        assert!(valid_cast_member(member(vec![(110.0, 130.0), (125.0, 140.0)]), &known).is_err());
        let mut loud = member(vec![(110.0, 120.0)]);
        loud.voice.settings = Some(elevenlabs::ChangerSettings {
            stability: 1.5,
            similarity: 0.5,
            style: 0.0,
            remove_noise: false,
        });
        assert!(valid_cast_member(loud, &known).is_err());
    }

    #[test]
    fn speech_is_cut_at_sentences_and_loses_nothing() {
        let text = "One two three. Four five six seven. Eight nine. Ten";
        let chunks = speech_chunks(text, 24);
        assert_eq!(
            chunks,
            ["One two three.", "Four five six seven.", "Eight nine. Ten"]
        );
        // With no sentence to end on, a chunk ends on a word.
        let chunks = speech_chunks("alpha beta gamma delta epsilon", 12);
        assert_eq!(chunks.join(" "), "alpha beta gamma delta epsilon");
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 12));
        assert!(speech_chunks("  ", 10).is_empty());
    }
}
