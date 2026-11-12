//! Chapter notes: an experiment the owner turns on that gives each chapter a
//! spoiler-free synopsis, a full summary, and the people and terms in it, so a
//! listener's agent can talk about a book that has no e-book.
//!
//! Notes start from the book's words. A book with a follow-along map already
//! has them; any other chapter is transcribed on this server by the
//! follow-along add-on's speech recognizer. Writing the notes needs a language
//! model, which the owner names here: Anthropic, or any OpenAI-compatible
//! endpoint, including one running on the owner's own network. With no model
//! set up, generation stops at the transcript, and an agent can still read it
//! up to the listener's position and write its own recap.
//!
//! The text leaves the server only for the model the owner chose, and only
//! when an administrator generates notes for that book.

use crate::*;
use std::sync::atomic::{AtomicBool, Ordering};

const SETTINGS_DOCUMENT: &str = "chapter-notes-settings";
const NOTES_DOCUMENT_PREFIX: &str = "chapter-notes:";
const EXPERIMENT_OFF: &str = "Chapter notes are not turned on for this server.";

/// Speech recognition runs on windows this long, so a long chapter shows
/// progress and never holds an hour of audio in the recognizer at once.
const TRANSCRIPTION_WINDOW_SECONDS: f64 = 10.0 * 60.0;

/// Far more than any chapter needs, and well inside every current model's
/// context. A longer chapter is cut and its note says so.
const MAX_CHAPTER_CHARACTERS: usize = 600_000;

/// Summaries of the chapters just before, so names and threads carry over
/// without resending the whole book with every chapter.
const PRIOR_SUMMARIES: usize = 3;

const ANTHROPIC_API: &str = "https://api.anthropic.com/v1/messages";
pub(crate) const DEFAULT_ANTHROPIC_MODEL: &str = "claude-opus-5-5";

static GENERATIONS: LazyLock<Mutex<HashMap<String, Generation>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// One book at a time: transcription is the heaviest thing a home server
/// does, and a model provider's rate limit is per key.
static RUN_PERMIT: LazyLock<tokio::sync::Semaphore> =
    LazyLock::new(|| tokio::sync::Semaphore::new(1));

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProviderKind {
    Anthropic,
    OpenAiCompatible,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Provider {
    kind: ProviderKind,
    model: String,
    /// Required for an OpenAI-compatible endpoint, such as
    /// `http://192.168.1.20:11434/v1` for Ollama. Unused for Anthropic.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
    /// Never sent back to a client once saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSettings {
    #[serde(default)]
    enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider: Option<Provider>,
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
        .map_err(|_| ApiError::internal("Cannot save the chapter notes settings."))?;
    state
        .database
        .transaction(move |db| write_document(db, SETTINGS_DOCUMENT, &payload))
        .await
}

pub(crate) async fn experiment_enabled(state: &AppState) -> bool {
    load_settings(state).await.enabled
}

/// Guards every per-book route. The app hides chapter notes on this 404, as
/// it does for a server that predates them.
pub(crate) async fn require_experiment(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: middleware::Next,
) -> Response {
    if experiment_enabled(&state).await {
        next.run(request).await
    } else {
        ApiError::not_found(EXPERIMENT_OFF).into_response()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderSummary {
    kind: ProviderKind,
    model: String,
    base_url: Option<String>,
    has_api_key: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChapterNotesStatus {
    enabled: bool,
    /// Administrators only: which model writes the notes.
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<ProviderSummary>,
    /// Whether this server can transcribe a chapter without an e-book.
    transcription_available: bool,
    can_generate: bool,
}

async fn status_for(state: &AppState, auth: &AuthUser) -> ChapterNotesStatus {
    let settings = load_settings(state).await;
    let admin = auth.is_admin || auth.is_owner;
    ChapterNotesStatus {
        enabled: settings.enabled,
        provider: settings
            .provider
            .filter(|_| admin)
            .map(|provider| ProviderSummary {
                kind: provider.kind,
                model: provider.model,
                base_url: provider.base_url,
                has_api_key: provider.api_key.is_some(),
            }),
        transcription_available: settings.enabled && transcription_tools(state).await.is_some(),
        can_generate: settings.enabled && admin,
    }
}

pub(crate) async fn chapter_notes_experiment(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Json<ChapterNotesStatus> {
    Json(status_for(&state, &auth).await)
}

pub(crate) async fn set_chapter_notes_enabled(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Json(input): Json<ExperimentalFeatureEnabled>,
) -> Result<Json<ChapterNotesStatus>, ApiError> {
    require_owner(&auth)?;
    let mut settings = load_settings(&state).await;
    settings.enabled = input.enabled;
    save_settings(&state, &settings).await?;
    if !input.enabled {
        // Work in flight stops at its next chapter. Saved notes are kept for
        // when the experiment comes back.
        for generation in GENERATIONS.lock().await.values() {
            generation.cancel.store(true, Ordering::Relaxed);
        }
    }
    Ok(Json(status_for(&state, &auth).await))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderInput {
    kind: ProviderKind,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    base_url: Option<String>,
    /// Left out keeps the saved key; an empty string removes it.
    #[serde(default)]
    api_key: Option<String>,
}

pub(crate) async fn set_chapter_notes_provider(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Json(input): Json<ProviderInput>,
) -> Result<Json<ChapterNotesStatus>, ApiError> {
    require_owner(&auth)?;
    let mut settings = load_settings(&state).await;
    if !settings.enabled {
        return Err(ApiError::not_found(EXPERIMENT_OFF));
    }
    let previous = settings
        .provider
        .take()
        .filter(|provider| provider.kind == input.kind);
    let model = input
        .model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string);
    let model = match (input.kind, model) {
        (_, Some(model)) => model,
        (ProviderKind::Anthropic, None) => DEFAULT_ANTHROPIC_MODEL.to_string(),
        (ProviderKind::OpenAiCompatible, None) => {
            return Err(ApiError::bad_request("Name the model to use."));
        }
    };
    if model.chars().count() > 200 || model.chars().any(char::is_control) {
        return Err(ApiError::bad_request("That model name is not valid."));
    }
    let base_url = match input.kind {
        ProviderKind::Anthropic => None,
        ProviderKind::OpenAiCompatible => {
            let raw = input
                .base_url
                .as_deref()
                .map(str::trim)
                .filter(|url| !url.is_empty())
                .ok_or_else(|| ApiError::bad_request("Give the endpoint's address."))?;
            let parsed = reqwest::Url::parse(raw)
                .ok()
                .filter(|url| matches!(url.scheme(), "http" | "https") && url.host().is_some())
                .ok_or_else(|| {
                    ApiError::bad_request("The endpoint must be an http:// or https:// address.")
                })?;
            Some(parsed.as_str().trim_end_matches('/').to_string())
        }
    };
    let api_key = match input.api_key.as_deref().map(str::trim) {
        Some("") => None,
        Some(key) => {
            if key.chars().any(char::is_control) || key.len() > 1_000 {
                return Err(ApiError::bad_request("That API key is not valid."));
            }
            Some(key.to_string())
        }
        None => previous.and_then(|provider| provider.api_key),
    };
    if input.kind == ProviderKind::Anthropic && api_key.is_none() {
        return Err(ApiError::bad_request("Paste an Anthropic API key."));
    }
    settings.provider = Some(Provider {
        kind: input.kind,
        model,
        base_url,
        api_key,
    });
    save_settings(&state, &settings).await?;
    Ok(Json(status_for(&state, &auth).await))
}

pub(crate) async fn remove_chapter_notes_provider(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
) -> Result<Json<ChapterNotesStatus>, ApiError> {
    require_owner(&auth)?;
    let mut settings = load_settings(&state).await;
    settings.provider = None;
    save_settings(&state, &settings).await?;
    Ok(Json(status_for(&state, &auth).await))
}

// ---------------------------------------------------------------------------
// Stored notes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TextSource {
    /// The book's own text, through its follow-along map.
    Ebook,
    /// Recognized speech.
    Transcript,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChapterNote {
    pub(crate) index: usize,
    pub(crate) title: String,
    pub(crate) start_seconds: f64,
    pub(crate) end_seconds: Option<f64>,
    pub(crate) source: TextSource,
    pub(crate) characters_of_text: usize,
    /// Of the text the notes were written from, so a rerun skips chapters
    /// whose words have not changed.
    #[serde(default, skip_serializing)]
    text_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) synopsis: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) summary: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) people: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) terms: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) model: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) text_truncated: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BookNotes {
    pub(crate) chapters: Vec<ChapterNote>,
    #[serde(default)]
    pub(crate) updated_at: String,
}

/// The text_hash is kept in storage but not shown to clients, so storage
/// goes through this rather than `BookNotes`' own serialization.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredNote {
    #[serde(flatten)]
    note: ChapterNote,
    #[serde(default)]
    stored_text_hash: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredBookNotes {
    chapters: Vec<StoredNote>,
    #[serde(default)]
    updated_at: String,
}

fn notes_document(book_id: &str) -> String {
    format!("{NOTES_DOCUMENT_PREFIX}{book_id}")
}

pub(crate) async fn load_notes(state: &AppState, book_id: &str) -> Option<BookNotes> {
    let name = notes_document(book_id);
    let payload = state
        .database
        .call(move |db| read_document(db, &name))
        .await
        .ok()
        .flatten()?;
    let stored: StoredBookNotes = serde_json::from_str(&payload).ok()?;
    Some(BookNotes {
        chapters: stored
            .chapters
            .into_iter()
            .map(|stored| ChapterNote {
                text_hash: stored.stored_text_hash,
                ..stored.note
            })
            .collect(),
        updated_at: stored.updated_at,
    })
}

async fn save_notes(state: &AppState, book_id: &str, notes: &BookNotes) -> Result<(), ApiError> {
    let stored = StoredBookNotes {
        chapters: notes
            .chapters
            .iter()
            .cloned()
            .map(|note| StoredNote {
                stored_text_hash: note.text_hash.clone(),
                note,
            })
            .collect(),
        updated_at: notes.updated_at.clone(),
    };
    let payload = serde_json::to_string(&stored)
        .map_err(|_| ApiError::internal("Cannot save chapter notes."))?;
    let name = notes_document(book_id);
    state
        .database
        .transaction(move |db| write_document(db, &name, &payload))
        .await
}

async fn delete_notes(state: &AppState, book_id: &str) -> Result<(), ApiError> {
    let name = notes_document(book_id);
    state
        .database
        .transaction(move |db| {
            db.execute("DELETE FROM documents WHERE name = ?1", [name])?;
            Ok(())
        })
        .await?;
    let directory = transcripts_dir(state).join(transcript_dir_name(book_id));
    match fs::remove_dir_all(&directory).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ApiError::internal(format!(
            "Could not remove saved transcripts: {error}"
        ))),
    }
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

/// A stretch of recognized speech, on the book's timeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptSpan {
    pub(crate) start_seconds: f64,
    pub(crate) end_seconds: f64,
    pub(crate) text: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedTranscript {
    start_seconds: f64,
    end_seconds: f64,
    spans: Vec<TranscriptSpan>,
}

fn transcripts_dir(state: &AppState) -> PathBuf {
    state.database_path.with_file_name("chapter-transcripts")
}

/// Book ids are already path-safe, but they come from a URL.
fn transcript_dir_name(book_id: &str) -> String {
    hex_digest(Sha256::digest(book_id.as_bytes()))
}

fn transcript_path(state: &AppState, book_id: &str, index: usize) -> PathBuf {
    transcripts_dir(state)
        .join(transcript_dir_name(book_id))
        .join(format!("{index}.json"))
}

async fn read_transcript(path: &FsPath) -> Option<SavedTranscript> {
    serde_json::from_slice(&fs::read(path).await.ok()?).ok()
}

/// Every saved transcript of a book, in book order, for reading the words a
/// listener has heard. Empty when the book was never transcribed.
pub(crate) async fn transcript_spans(state: &AppState, book_id: &str) -> Vec<TranscriptSpan> {
    let Some(notes) = load_notes(state, book_id).await else {
        return Vec::new();
    };
    let mut spans = Vec::new();
    for note in notes
        .chapters
        .iter()
        .filter(|note| note.source == TextSource::Transcript)
    {
        if let Some(saved) = read_transcript(&transcript_path(state, book_id, note.index)).await {
            spans.extend(saved.spans);
        }
    }
    spans.sort_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds));
    spans
}

struct TranscriptionTools {
    runtime: updates::SyncAddonRuntime,
    ffmpeg: PathBuf,
}

async fn transcription_tools(state: &AppState) -> Option<TranscriptionTools> {
    let runtime = state
        .update_manager
        .sync_addon_runtime(&state.alignment_config)
        .await?;
    let ffmpeg = runtime.ffmpeg_path.clone().or_else(|| {
        state
            .faststart_tools
            .as_ref()
            .map(|tools| tools.ffmpeg.clone())
    })?;
    Some(TranscriptionTools { runtime, ffmpeg })
}

/// One piece of a chapter's audio inside one file.
#[derive(Debug, Clone, PartialEq)]
struct AudioPiece {
    path: PathBuf,
    /// Within the file.
    start_seconds: f64,
    end_seconds: f64,
    /// Where `start_seconds` falls on the book's timeline.
    book_offset: f64,
}

/// The audio a stretch of the book's timeline covers, cut into windows the
/// recognizer handles comfortably. A chapter may run across files.
fn audio_pieces(
    tracks: &[(PathBuf, f64)],
    start_seconds: f64,
    end_seconds: f64,
    window_seconds: f64,
) -> Vec<AudioPiece> {
    let mut pieces = Vec::new();
    let mut track_start = 0.0;
    for (path, duration) in tracks {
        let track_end = track_start + duration;
        let from = start_seconds.max(track_start);
        let to = end_seconds.min(track_end);
        let mut cursor = from;
        while to - cursor > 0.5 {
            let window_end = (cursor + window_seconds).min(to);
            pieces.push(AudioPiece {
                path: path.clone(),
                start_seconds: cursor - track_start,
                end_seconds: window_end - track_start,
                book_offset: cursor,
            });
            cursor = window_end;
        }
        track_start = track_end;
    }
    pieces
}

/// Recognized sentences, or segments when the recognizer gave none, with
/// times moved onto the book's timeline.
fn transcript_spans_from_timeline(
    entries: &[alignment::TimelineEntry],
    book_offset: f64,
) -> Vec<TranscriptSpan> {
    fn collect<'a>(
        entries: &'a [alignment::TimelineEntry],
        kind: &str,
        out: &mut Vec<&'a alignment::TimelineEntry>,
    ) {
        for entry in entries {
            if entry.kind == kind {
                out.push(entry);
            } else if let Some(children) = &entry.timeline {
                collect(children, kind, out);
            }
        }
    }
    let mut found = Vec::new();
    for kind in ["sentence", "segment"] {
        collect(entries, kind, &mut found);
        if !found.is_empty() {
            break;
        }
    }
    if found.is_empty() {
        // A bare word list: one span holding all of it.
        let words = alignment::recognized_words(entries);
        let (Some(first), Some(last)) = (words.first(), words.last()) else {
            return Vec::new();
        };
        let mut all = Vec::new();
        collect(entries, "word", &mut all);
        let text = all
            .iter()
            .map(|word| word.text.trim())
            .collect::<Vec<_>>()
            .join(" ");
        return vec![TranscriptSpan {
            start_seconds: book_offset + first.start_time,
            end_seconds: book_offset + last.end_time,
            text,
        }];
    }
    found
        .into_iter()
        .filter_map(|entry| {
            let text = entry.text.split_whitespace().collect::<Vec<_>>().join(" ");
            (!text.is_empty()).then_some(TranscriptSpan {
                start_seconds: book_offset + entry.start_time,
                end_seconds: book_offset + entry.end_time,
                text,
            })
        })
        .collect()
}

fn recognizer_model(language: Option<&str>) -> (&'static str, Option<String>) {
    let code = language
        .map(sync_report::two_letter_language)
        .filter(|value| !value.is_empty());
    // A step up from the tiny model alignment anchors with: these words are
    // read, not only matched.
    if code.as_deref() == Some("en") {
        ("base.en", code)
    } else {
        ("base", code)
    }
}

async fn transcribe_piece(
    tools: &TranscriptionTools,
    temp_dir: &FsPath,
    piece: &AudioPiece,
    number: usize,
    model: &str,
    language: Option<&str>,
) -> anyhow::Result<Vec<TranscriptSpan>> {
    let audio = temp_dir.join(format!("piece-{number}.wav"));
    sync::extract_alignment_audio(
        &tools.ffmpeg,
        &piece.path,
        &audio,
        piece.start_seconds,
        piece.end_seconds,
    )
    .await?;
    let output = temp_dir.join(format!("piece-{number}.json"));
    let mut args: Vec<std::ffi::OsString> = vec![
        "transcribe".into(),
        audio.as_os_str().into(),
        output.as_os_str().into(),
        "--engine=whisper".into(),
        format!("--whisper.model={model}").into(),
    ];
    if let Some(language) = language {
        args.push(format!("--language={language}").into());
    }
    sync::run_alignment_cli(
        &tools.runtime.cli_path,
        &tools.runtime.cli_args,
        Some(&tools.ffmpeg),
        &args,
        "Speech recognition",
    )
    .await?;
    let timeline = sync::read_cli_output(&output, "Speech recognition").await?;
    let _ = fs::remove_file(&audio).await;
    let _ = fs::remove_file(&output).await;
    Ok(transcript_spans_from_timeline(
        &alignment::parse_timeline(&timeline)?,
        piece.book_offset,
    ))
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GenerationStatus {
    state: &'static str,
    step: String,
    completed: usize,
    total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

struct Generation {
    status: GenerationStatus,
    cancel: Arc<AtomicBool>,
    /// Held by the run until it has stopped writing.
    running: Arc<tokio::sync::Mutex<()>>,
    /// Set once the run has its turn, so a removal knows whether to wait.
    started: Arc<AtomicBool>,
}

async fn set_status(book_id: &str, change: impl FnOnce(&mut GenerationStatus)) {
    if let Some(generation) = GENERATIONS.lock().await.get_mut(book_id) {
        change(&mut generation.status);
    }
}

struct Stopped;

/// A chapter as generation sees it: where it is, and its words once found.
struct ChapterPlan {
    index: usize,
    title: String,
    start_seconds: f64,
    end_seconds: Option<f64>,
    ebook_text: Option<String>,
}

fn chapter_plans(book: &Book, map: Option<&alignment::SyncMap>) -> Vec<ChapterPlan> {
    let mut plans: Vec<ChapterPlan> = if book.chapters.is_empty() {
        vec![ChapterPlan {
            index: 0,
            title: book.title.clone(),
            start_seconds: 0.0,
            end_seconds: book.duration_seconds,
            ebook_text: None,
        }]
    } else {
        book.chapters
            .iter()
            .enumerate()
            .map(|(index, chapter)| ChapterPlan {
                index,
                title: chapter.title.clone(),
                start_seconds: chapter.start_seconds,
                end_seconds: book
                    .chapters
                    .get(index + 1)
                    .map(|next| next.start_seconds)
                    .or(chapter.end_seconds)
                    .or(book.duration_seconds),
                ebook_text: None,
            })
            .collect()
    };
    if let Some(map) = map {
        let mut fragments: Vec<&alignment::SyncFragment> = map.fragments.iter().collect();
        fragments.sort_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds));
        for chapter in agent::group_heard_text(book, &fragments, f64::INFINITY) {
            if let Some(plan) = plans.iter_mut().find(|plan| plan.index == chapter.index)
                && !chapter.text.trim().is_empty()
            {
                plan.ebook_text = Some(chapter.text);
            }
        }
    }
    plans
}

async fn read_sentence_map(path: PathBuf) -> Option<alignment::SyncMap> {
    let map = tokio::task::spawn_blocking(move || -> anyhow::Result<alignment::SyncMap> {
        Ok(serde_json::from_slice(&std::fs::read(&path)?)?)
    })
    .await
    .ok()?
    .ok()?;
    map.precision
        .as_deref()
        .is_none_or(|precision| precision == alignment::PRECISION_SENTENCE)
        .then_some(map)
}

fn text_hash(text: &str) -> String {
    hex_digest(Sha256::digest(text.as_bytes()))
}

async fn run_generation(
    state: AppState,
    book_id: String,
    cancel: Arc<AtomicBool>,
    started: Arc<AtomicBool>,
    _running: tokio::sync::OwnedMutexGuard<()>,
) {
    let _permit = RUN_PERMIT.acquire().await;
    started.store(true, Ordering::SeqCst);
    if cancel.load(Ordering::SeqCst) {
        return;
    }
    let outcome = generate(&state, &book_id, &cancel).await;
    let mut generations = GENERATIONS.lock().await;
    // The entry may since belong to a newer run, after a removal.
    let Some(generation) = generations
        .get_mut(&book_id)
        .filter(|generation| Arc::ptr_eq(&generation.cancel, &cancel))
    else {
        return;
    };
    match outcome {
        Ok(()) | Err(GenerateError::Stopped(Stopped)) => {
            generations.remove(&book_id);
        }
        Err(GenerateError::Failed(message)) => {
            generation.status.state = "failed";
            generation.status.error = Some(message);
        }
    }
}

enum GenerateError {
    Stopped(Stopped),
    Failed(String),
}

impl From<ApiError> for GenerateError {
    fn from(error: ApiError) -> Self {
        GenerateError::Failed(error.message)
    }
}

async fn generate(
    state: &AppState,
    book_id: &str,
    cancel: &AtomicBool,
) -> Result<(), GenerateError> {
    let stop_check = || {
        if cancel.load(Ordering::Relaxed) {
            Err(GenerateError::Stopped(Stopped))
        } else {
            Ok(())
        }
    };
    let (book, sync_path, tracks) = {
        let library = state.library.read().await;
        let book = library.book(book_id)?.clone();
        let sync_path = library.sync_paths.get(book_id).cloned();
        let tracks = book
            .tracks
            .iter()
            .map(|track| {
                let path = library.track_paths.get(&track.id).cloned()?;
                Some((path, track.duration_seconds?))
            })
            .collect::<Option<Vec<_>>>();
        (book, sync_path, tracks)
    };
    let map = match sync_path {
        Some(path) => read_sentence_map(path).await,
        None => None,
    };
    let plans = chapter_plans(&book, map.as_ref());
    let settings = load_settings(state).await;
    let provider = settings.provider;
    let mut notes = load_notes(state, book_id).await.unwrap_or_default();
    // Notes for chapters the book no longer has would mislead.
    notes.chapters.retain(|note| {
        plans.iter().any(|plan| {
            plan.index == note.index
                && plan.title == note.title
                && plan.start_seconds == note.start_seconds
        })
    });

    let needs_transcript = plans.iter().any(|plan| plan.ebook_text.is_none());
    let tools = if needs_transcript {
        transcription_tools(state).await
    } else {
        None
    };
    if needs_transcript && tools.is_none() && plans.iter().all(|plan| plan.ebook_text.is_none()) {
        return Err(GenerateError::Failed(
            "This book has no follow-along map, and transcribing it needs the follow-along add-on. An owner can install it under Administration → Experiments.".into(),
        ));
    }
    let tracks = tracks.unwrap_or_default();
    let (model, language) = recognizer_model(
        sync_report::language_override(state, book_id)
            .await
            .as_deref()
            .or(book.metadata.language.as_deref()),
    );
    let temp_dir = tempfile::tempdir().map_err(|error| {
        GenerateError::Failed(format!("Could not create a work folder: {error}"))
    })?;
    let total = plans.len();
    let mut prior_summaries: Vec<(String, String)> = Vec::new();

    for (position, plan) in plans.iter().enumerate() {
        stop_check()?;
        let label = format!("Chapter {} of {total}: {}", position + 1, plan.title);
        let (text, source) = match &plan.ebook_text {
            Some(text) => (text.clone(), TextSource::Ebook),
            None => {
                let Some(tools) = &tools else {
                    continue;
                };
                let Some(end) = plan.end_seconds else {
                    continue;
                };
                let path = transcript_path(state, book_id, plan.index);
                let saved = read_transcript(&path).await.filter(|saved| {
                    saved.start_seconds == plan.start_seconds && saved.end_seconds == end
                });
                let spans = match saved {
                    Some(saved) => saved.spans,
                    None => {
                        let pieces = audio_pieces(
                            &tracks,
                            plan.start_seconds,
                            end,
                            TRANSCRIPTION_WINDOW_SECONDS,
                        );
                        let mut spans = Vec::new();
                        for (number, piece) in pieces.iter().enumerate() {
                            stop_check()?;
                            set_status(book_id, |status| {
                                status.step = if pieces.len() > 1 {
                                    format!(
                                        "Transcribing {label} (part {} of {})",
                                        number + 1,
                                        pieces.len()
                                    )
                                } else {
                                    format!("Transcribing {label}")
                                };
                            })
                            .await;
                            spans.extend(
                                transcribe_piece(
                                    tools,
                                    temp_dir.path(),
                                    piece,
                                    number,
                                    model,
                                    language.as_deref(),
                                )
                                .await
                                .map_err(|error| {
                                    GenerateError::Failed(format!(
                                        "Could not transcribe {}: {error}",
                                        plan.title
                                    ))
                                })?,
                            );
                        }
                        if let Some(parent) = path.parent() {
                            fs::create_dir_all(parent)
                                .await
                                .map_err(|error| GenerateError::Failed(error.to_string()))?;
                        }
                        let saved = SavedTranscript {
                            start_seconds: plan.start_seconds,
                            end_seconds: end,
                            spans,
                        };
                        let bytes = serde_json::to_vec(&saved)
                            .map_err(|error| GenerateError::Failed(error.to_string()))?;
                        fs::write(&path, bytes)
                            .await
                            .map_err(|error| GenerateError::Failed(error.to_string()))?;
                        saved.spans
                    }
                };
                let text = spans
                    .iter()
                    .map(|span| span.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" ");
                (text, TextSource::Transcript)
            }
        };
        if text.trim().is_empty() {
            continue;
        }
        let hash = text_hash(&text);
        let existing = notes
            .chapters
            .iter()
            .position(|note| note.index == plan.index);
        let up_to_date = existing.is_some_and(|at| {
            let note = &notes.chapters[at];
            note.text_hash == hash
                && match &provider {
                    None => true,
                    Some(provider) => {
                        note.summary.is_some()
                            && note.model.as_deref() == Some(provider.model.as_str())
                    }
                }
        });
        if !up_to_date {
            let mut note = ChapterNote {
                index: plan.index,
                title: plan.title.clone(),
                start_seconds: plan.start_seconds,
                end_seconds: plan.end_seconds,
                source,
                characters_of_text: text.chars().count(),
                text_hash: hash,
                synopsis: None,
                summary: None,
                people: Vec::new(),
                terms: Vec::new(),
                model: None,
                text_truncated: false,
            };
            if let Some(provider) = &provider {
                stop_check()?;
                set_status(book_id, |status| {
                    status.step = format!("Writing notes for {label}")
                })
                .await;
                let (chapter_text, truncated) = head_characters(&text, MAX_CHAPTER_CHARACTERS);
                let request = NoteRequest {
                    book_title: &book.title,
                    author: book.author.as_deref(),
                    chapter_title: &plan.title,
                    chapter_number: position + 1,
                    chapter_count: total,
                    source,
                    text: chapter_text,
                    prior: &prior_summaries,
                };
                let written = write_note(provider, &request)
                    .await
                    .map_err(GenerateError::Failed)?;
                note.synopsis = Some(written.synopsis);
                note.summary = Some(written.summary);
                note.people = written.people;
                note.terms = written.terms;
                note.model = Some(provider.model.clone());
                note.text_truncated = truncated;
            }
            match existing {
                Some(at) => notes.chapters[at] = note,
                None => notes.chapters.push(note),
            }
            notes.chapters.sort_by_key(|note| note.index);
            notes.updated_at = rfc3339_utc(unix_now_seconds());
            // Saved chapter by chapter, so a restart or a failure keeps what
            // was already paid for.
            save_notes(state, book_id, &notes).await?;
        }
        if let Some(summary) = notes
            .chapters
            .iter()
            .find(|note| note.index == plan.index)
            .and_then(|note| note.summary.clone())
        {
            prior_summaries.push((plan.title.clone(), summary));
            if prior_summaries.len() > PRIOR_SUMMARIES {
                prior_summaries.remove(0);
            }
        }
        set_status(book_id, |status| status.completed = position + 1).await;
    }
    Ok(())
}

fn head_characters(text: &str, max: usize) -> (&str, bool) {
    match text.char_indices().nth(max) {
        Some((offset, _)) => (&text[..offset], true),
        None => (text, false),
    }
}

// ---------------------------------------------------------------------------
// Writing a note
// ---------------------------------------------------------------------------

struct NoteRequest<'a> {
    book_title: &'a str,
    author: Option<&'a str>,
    chapter_title: &'a str,
    chapter_number: usize,
    chapter_count: usize,
    source: TextSource,
    text: &'a str,
    prior: &'a [(String, String)],
}

#[derive(Debug, Deserialize, PartialEq)]
struct WrittenNote {
    synopsis: String,
    summary: String,
    #[serde(default)]
    people: Vec<String>,
    #[serde(default)]
    terms: Vec<String>,
}

const NOTE_INSTRUCTIONS: &str = "You write chapter notes for someone listening to an audiobook. They read them to remember where they are, or to decide whether to revisit a chapter, so accuracy matters more than style.

Write four things about the chapter you are given:
- synopsis: one or two sentences a listener could read before hearing the chapter without anything being spoiled. Say what the chapter sets up or who it follows. Never reveal outcomes, deaths, twists, reveals, or how a conflict resolves.
- summary: a full account of what happens in the chapter, in the order it happens, in one to three paragraphs. Spoilers for this chapter are expected here, but say nothing about later chapters.
- people: the characters who appear or matter in this chapter, each as \"Name: who they are and what they do here\".
- terms: places, objects, organizations, or invented words the chapter introduces or relies on, each as \"Term: what it is\". Leave it empty when there are none.

Front and back matter, such as credits, a dedication, or acknowledgements, gets a one-line synopsis and summary saying what it is, and empty lists.

Use only what the chapter text and the earlier summaries say; do not draw on outside knowledge of the book, which could spoil later chapters.";

const TRANSCRIPT_CAVEAT: &str = "The chapter text is an automatic transcript of the narration, so it has no paragraphing and may misspell names. Spell each name the way the earlier summaries do, or else the most plausible way.";

fn note_prompt(request: &NoteRequest<'_>) -> String {
    let mut prompt = format!(
        "Book: {}{}\nChapter {} of {}: {}\n",
        request.book_title,
        request
            .author
            .map(|author| format!(" by {author}"))
            .unwrap_or_default(),
        request.chapter_number,
        request.chapter_count,
        request.chapter_title,
    );
    if request.source == TextSource::Transcript {
        prompt.push('\n');
        prompt.push_str(TRANSCRIPT_CAVEAT);
        prompt.push('\n');
    }
    if !request.prior.is_empty() {
        prompt.push_str("\n<earlier_summaries>\n");
        for (title, summary) in request.prior {
            prompt.push_str(&format!(
                "<chapter title=\"{title}\">\n{summary}\n</chapter>\n"
            ));
        }
        prompt.push_str("</earlier_summaries>\n");
    }
    prompt.push_str("\n<chapter_text>\n");
    prompt.push_str(request.text);
    prompt.push_str("\n</chapter_text>\n\nWrite the notes for this chapter as JSON.");
    prompt
}

fn note_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "synopsis": { "type": "string" },
            "summary": { "type": "string" },
            "people": { "type": "array", "items": { "type": "string" } },
            "terms": { "type": "array", "items": { "type": "string" } },
        },
        "required": ["synopsis", "summary", "people", "terms"],
        "additionalProperties": false,
    })
}

/// Models that take Anthropic's server-side fallback when a safety
/// classifier declines a request; a long novel can trip one by accident.
fn takes_server_fallback(model: &str) -> bool {
    matches!(
        model,
        "claude-fable-5-2"
            | "claude-fable-5-1"
            | "claude-opus-5-5"
            | "claude-opus-5"
            | "claude-sonnet-5-5"
    )
}

fn anthropic_body(model: &str, request: &NoteRequest<'_>) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": 16_000,
        "system": NOTE_INSTRUCTIONS,
        "messages": [{ "role": "user", "content": note_prompt(request) }],
        "output_config": { "format": { "type": "json_schema", "schema": note_schema() } },
    });
    if takes_server_fallback(model) {
        body["fallbacks"] = "default".into();
    }
    body
}

fn openai_body(model: &str, request: &NoteRequest<'_>) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": format!("{NOTE_INSTRUCTIONS}\n\nReply with a JSON object with exactly these keys: synopsis (string), summary (string), people (array of strings), terms (array of strings).") },
            { "role": "user", "content": note_prompt(request) },
        ],
        "response_format": { "type": "json_object" },
    })
}

/// The note in a reply, or why there is none, as the administrator should
/// read it.
fn anthropic_note(reply: &serde_json::Value) -> Result<WrittenNote, String> {
    match reply.get("stop_reason").and_then(|reason| reason.as_str()) {
        Some("refusal") => {
            return Err("The model declined to write notes for this chapter.".into());
        }
        Some("max_tokens") => {
            return Err("The model's notes for this chapter were cut off.".into());
        }
        _ => {}
    }
    let text = reply
        .get("content")
        .and_then(|content| content.as_array())
        .into_iter()
        .flatten()
        .filter(|block| block.get("type").and_then(|kind| kind.as_str()) == Some("text"))
        .filter_map(|block| block.get("text").and_then(|text| text.as_str()))
        .collect::<String>();
    parse_note(&text)
}

fn openai_note(reply: &serde_json::Value) -> Result<WrittenNote, String> {
    let text = reply
        .pointer("/choices/0/message/content")
        .and_then(|content| content.as_str())
        .ok_or("The model's reply had no notes in it.")?;
    parse_note(text)
}

fn parse_note(text: &str) -> Result<WrittenNote, String> {
    // Local models sometimes wrap JSON in a code fence despite being asked not to.
    let trimmed = text.trim();
    let body = trimmed
        .find('{')
        .zip(trimmed.rfind('}'))
        .map_or(trimmed, |(start, end)| &trimmed[start..=end]);
    let note: WrittenNote = serde_json::from_str(body)
        .map_err(|_| "The model's reply was not the notes it was asked for.".to_string())?;
    if note.summary.trim().is_empty() {
        return Err("The model wrote an empty summary.".into());
    }
    Ok(WrittenNote {
        synopsis: note.synopsis.trim().to_string(),
        summary: note.summary.trim().to_string(),
        people: tidy_list(note.people),
        terms: tidy_list(note.terms),
    })
}

fn tidy_list(items: Vec<String>) -> Vec<String> {
    items
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .take(60)
        .collect()
}

fn provider_error(status: reqwest::StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(|message| message.as_str())
                .map(str::to_string)
        });
    let lead = match status.as_u16() {
        401 | 403 => "The model provider did not accept the API key.",
        404 => "The model provider does not know that model or address.",
        429 => "The model provider is rate limiting this key. Try again later.",
        code if code >= 500 => "The model provider had a problem. Try again later.",
        _ => "The model provider refused the request.",
    };
    match detail {
        Some(detail) => format!("{lead} ({detail})"),
        None => lead.to_string(),
    }
}

async fn write_note(provider: &Provider, request: &NoteRequest<'_>) -> Result<WrittenNote, String> {
    let client = http_client_builder()
        .timeout(Duration::from_secs(10 * 60))
        .build()
        .map_err(|_| "Could not prepare a connection to the model provider.".to_string())?;
    let (http_request, anthropic) = match provider.kind {
        ProviderKind::Anthropic => {
            let mut builder = client
                .post(ANTHROPIC_API)
                .header("x-api-key", provider.api_key.as_deref().unwrap_or_default())
                .header("anthropic-version", "2026-10-21")
                .json(&anthropic_body(&provider.model, request));
            if takes_server_fallback(&provider.model) {
                builder = builder.header("anthropic-beta", "server-side-fallback-2026-07-01");
            }
            (builder, true)
        }
        ProviderKind::OpenAiCompatible => {
            let base = provider.base_url.as_deref().unwrap_or_default();
            let mut builder = client
                .post(format!("{base}/chat/completions"))
                .json(&openai_body(&provider.model, request));
            if let Some(key) = &provider.api_key {
                builder = builder.bearer_auth(key);
            }
            (builder, false)
        }
    };
    let response = http_request
        .send()
        .await
        .map_err(|_| "Could not reach the model provider.".to_string())?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|_| "The model provider's reply was cut off.".to_string())?;
    if !status.is_success() {
        return Err(provider_error(status, &body));
    }
    let reply: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| "The model provider's reply was not JSON.".to_string())?;
    if anthropic {
        anthropic_note(&reply)
    } else {
        openai_note(&reply)
    }
}

// ---------------------------------------------------------------------------
// Book routes
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BookChapterNotes {
    book_id: String,
    chapters: Vec<ChapterNote>,
    updated_at: Option<String>,
    generation: Option<GenerationStatus>,
}

async fn book_notes_response(state: &AppState, book_id: &str) -> BookChapterNotes {
    let notes = load_notes(state, book_id).await;
    let generation = GENERATIONS
        .lock()
        .await
        .get(book_id)
        .map(|generation| generation.status.clone());
    BookChapterNotes {
        book_id: book_id.to_string(),
        updated_at: notes.as_ref().map(|notes| notes.updated_at.clone()),
        chapters: notes.map(|notes| notes.chapters).unwrap_or_default(),
        generation,
    }
}

async fn ensure_book(state: &AppState, auth: &AuthUser, book_id: &str) -> Result<(), ApiError> {
    if !can_access_book(auth, book_id) {
        return Err(ApiError::not_found("Book not found"));
    }
    state.library.read().await.book(book_id).map(|_| ())
}

/// Every note, spoilers included: the app keeps unheard chapters hidden
/// until the listener asks to see them.
pub(crate) async fn get_book_chapter_notes(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
) -> Result<Json<BookChapterNotes>, ApiError> {
    ensure_book(&state, &auth, &book_id).await?;
    Ok(Json(book_notes_response(&state, &book_id).await))
}

pub(crate) async fn generate_book_chapter_notes(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
) -> Result<Json<BookChapterNotes>, ApiError> {
    require_admin(&auth)?;
    ensure_book(&state, &auth, &book_id).await?;
    {
        let mut generations = GENERATIONS.lock().await;
        if generations
            .get(&book_id)
            .is_some_and(|generation| generation.status.state != "failed")
        {
            return Err(ApiError::conflict(
                "Notes for this book are already being made.",
            ));
        }
        let total = state
            .library
            .read()
            .await
            .book(&book_id)
            .map(|book| book.chapters.len().max(1))
            .unwrap_or(1);
        let cancel = Arc::new(AtomicBool::new(false));
        let started = Arc::new(AtomicBool::new(false));
        let running = Arc::new(tokio::sync::Mutex::new(()));
        let guard = running
            .clone()
            .try_lock_owned()
            .expect("a new lock is free");
        generations.insert(
            book_id.clone(),
            Generation {
                status: GenerationStatus {
                    state: "running",
                    step: "Waiting for other books to finish".into(),
                    completed: 0,
                    total,
                    error: None,
                },
                cancel: cancel.clone(),
                running,
                started: started.clone(),
            },
        );
        tokio::spawn(run_generation(
            state.clone(),
            book_id.clone(),
            cancel,
            started,
            guard,
        ));
    }
    Ok(Json(book_notes_response(&state, &book_id).await))
}

/// Stops generation and forgets the book's notes and transcripts.
pub(crate) async fn delete_book_chapter_notes(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthUser>,
    Path(book_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    require_admin(&auth)?;
    ensure_book(&state, &auth, &book_id).await?;
    let removed = GENERATIONS.lock().await.remove(&book_id);
    if let Some(generation) = removed {
        generation.cancel.store(true, Ordering::SeqCst);
        // A run mid-chapter may write once more; wait for it to stop. One
        // still waiting for its turn stops as soon as it gets it.
        if generation.started.load(Ordering::SeqCst) {
            let _stopped = generation.running.lock().await;
        }
    }
    delete_notes(&state, &book_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_pieces_follow_a_chapter_across_files_in_windows() {
        let tracks = vec![
            (PathBuf::from("a.m4b"), 100.0),
            (PathBuf::from("b.m4b"), 100.0),
        ];
        let pieces = audio_pieces(&tracks, 80.0, 150.0, 30.0);
        let spans: Vec<(&str, f64, f64, f64)> = pieces
            .iter()
            .map(|piece| {
                (
                    piece.path.to_str().unwrap(),
                    piece.start_seconds,
                    piece.end_seconds,
                    piece.book_offset,
                )
            })
            .collect();
        assert_eq!(
            spans,
            vec![
                ("a.m4b", 80.0, 100.0, 80.0),
                ("b.m4b", 0.0, 30.0, 100.0),
                ("b.m4b", 30.0, 50.0, 130.0),
            ]
        );
    }

    #[test]
    fn transcript_spans_prefer_sentences_and_move_onto_the_book_timeline() {
        let timeline = r#"[{"type":"segment","text":"It was late. She ran.","startTime":0,"endTime":4,"timeline":[
            {"type":"sentence","text":"It was late.","startTime":0.5,"endTime":2,"timeline":[]},
            {"type":"sentence","text":" She  ran. ","startTime":2,"endTime":4,"timeline":[]}]}]"#;
        let entries = alignment::parse_timeline(timeline).unwrap();
        assert_eq!(
            transcript_spans_from_timeline(&entries, 600.0),
            vec![
                TranscriptSpan {
                    start_seconds: 600.5,
                    end_seconds: 602.0,
                    text: "It was late.".into()
                },
                TranscriptSpan {
                    start_seconds: 602.0,
                    end_seconds: 604.0,
                    text: "She ran.".into()
                },
            ]
        );
    }

    #[test]
    fn notes_parse_from_fenced_replies_and_refusals_are_reported() {
        let note = parse_note("```json\n{\"synopsis\":\" Setup. \",\"summary\":\"All of it.\",\"people\":[\" Ana: a pilot \",\"\"],\"terms\":[]}\n```").unwrap();
        assert_eq!(
            note,
            WrittenNote {
                synopsis: "Setup.".into(),
                summary: "All of it.".into(),
                people: vec!["Ana: a pilot".into()],
                terms: vec![],
            }
        );
        assert!(parse_note("{\"synopsis\":\"x\",\"summary\":\" \"}").is_err());
        let refused = serde_json::json!({ "stop_reason": "refusal", "content": [] });
        assert!(anthropic_note(&refused).unwrap_err().contains("declined"));
        let reply = serde_json::json!({
            "stop_reason": "end_turn",
            "content": [{ "type": "text", "text": "{\"synopsis\":\"s\",\"summary\":\"t\",\"people\":[],\"terms\":[]}" }],
        });
        assert_eq!(anthropic_note(&reply).unwrap().summary, "t");
    }

    #[test]
    fn transcript_prompts_warn_about_recognition_and_carry_earlier_summaries() {
        let prior = vec![("One".to_string(), "Ana lands.".to_string())];
        let request = NoteRequest {
            book_title: "Skyfall",
            author: Some("R. Lee"),
            chapter_title: "Two",
            chapter_number: 2,
            chapter_count: 9,
            source: TextSource::Transcript,
            text: "words",
            prior: &prior,
        };
        let prompt = note_prompt(&request);
        assert!(prompt.starts_with("Book: Skyfall by R. Lee\nChapter 2 of 9: Two\n"));
        assert!(prompt.contains(TRANSCRIPT_CAVEAT));
        assert!(prompt.contains("<chapter title=\"One\">\nAna lands.\n</chapter>"));
        let body = anthropic_body(DEFAULT_ANTHROPIC_MODEL, &request);
        assert_eq!(body["fallbacks"], "default");
        assert_eq!(body["output_config"]["format"]["type"], "json_schema");
        assert!(
            anthropic_body("claude-haiku-5-5", &request)
                .get("fallbacks")
                .is_none()
        );
    }
}
