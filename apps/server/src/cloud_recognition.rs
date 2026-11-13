//! Optional OpenAI speech recognition for follow-along sync. The owner can
//! save an OpenAI API key so the aligner's recognition windows are
//! transcribed by OpenAI instead of the add-on's on-device whisper. Forced
//! alignment and language detection stay on the server either way.
//!
//! This sends book audio off the server, so it is off unless the owner turns
//! it on and confirms that, and the key never leaves the server again.
use crate::*;

const DOCUMENT: &str = "readalong-cloud-recognition-v1";
const OPENAI_TRANSCRIPTIONS_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
/// The OpenAI transcription model that reports word timestamps, which the
/// aligner anchors windows with.
pub(crate) const OPENAI_MODEL: &str = "whisper-1";
/// OpenAI rejects larger uploads. Recognition windows are a few minutes of
/// 16 kHz mono audio, well under it.
const MAX_UPLOAD_BYTES: u64 = 25 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const ATTEMPTS: u32 = 3;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    api_key: String,
    /// When the owner confirmed that book audio is sent to OpenAI.
    acknowledged_at: String,
}

async fn load(state: &AppState) -> Option<Stored> {
    state
        .database
        .call(|db| read_document(db, DOCUMENT))
        .await
        .ok()
        .flatten()
        .and_then(|payload| serde_json::from_str(&payload).ok())
}

/// The recognizer a new sync job should use: OpenAI when the owner saved a
/// key, otherwise none, meaning on-device whisper.
pub(crate) async fn configured(state: &AppState) -> Option<Arc<CloudRecognizer>> {
    load(state).await.map(|stored| {
        Arc::new(CloudRecognizer {
            api_key: stored.api_key,
            endpoint: OPENAI_TRANSCRIPTIONS_URL.into(),
        })
    })
}

/// Whether a job that started with OpenAI recognition may keep sending audio:
/// turning it off stops the next window rather than the next book.
pub(crate) async fn still_enabled(state: &AppState) -> bool {
    load(state).await.is_some()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudRecognitionStatus {
    enabled: bool,
    model: &'static str,
}

async fn status(state: &AppState) -> CloudRecognitionStatus {
    CloudRecognitionStatus {
        enabled: load(state).await.is_some(),
        model: OPENAI_MODEL,
    }
}

pub(crate) async fn cloud_recognition_status(
    State(state): State<AppState>,
    _: AdminUser,
) -> Json<CloudRecognitionStatus> {
    Json(status(&state).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudRecognitionInput {
    api_key: String,
    #[serde(default)]
    acknowledge_privacy: bool,
}

pub(crate) async fn set_cloud_recognition(
    State(state): State<AppState>,
    _: OwnerUser,
    Json(input): Json<CloudRecognitionInput>,
) -> Result<Json<CloudRecognitionStatus>, ApiError> {
    if !input.acknowledge_privacy {
        return Err(ApiError::bad_request(
            "Confirm that book audio will be sent to OpenAI before turning this on.",
        ));
    }
    let api_key = input.api_key.trim();
    if api_key.is_empty() || api_key.len() > 512 || api_key.chars().any(char::is_whitespace) {
        return Err(ApiError::bad_request("Enter an OpenAI API key."));
    }
    let payload = serde_json::to_string(&Stored {
        api_key: api_key.into(),
        acknowledged_at: now_unix_string(),
    })
    .map_err(|_| ApiError::internal("Cannot save the OpenAI setting."))?;
    state
        .database
        .transaction(move |db| write_document(db, DOCUMENT, &payload))
        .await?;
    Ok(Json(status(&state).await))
}

/// Back to on-device recognition. The key is deleted, not kept for later.
pub(crate) async fn remove_cloud_recognition(
    State(state): State<AppState>,
    _: OwnerUser,
) -> Result<Json<CloudRecognitionStatus>, ApiError> {
    state
        .database
        .transaction(|db| {
            db.execute("DELETE FROM documents WHERE name = ?1", [DOCUMENT])?;
            Ok(())
        })
        .await?;
    Ok(Json(status(&state).await))
}

#[cfg(test)]
pub(crate) async fn enable_for_test(state: &AppState) {
    state
        .database
        .transaction(|db| {
            write_document(
                db,
                DOCUMENT,
                r#"{"apiKey":"test-key","acknowledgedAt":"0"}"#,
            )
        })
        .await
        .unwrap();
}

pub(crate) struct CloudRecognizer {
    api_key: String,
    endpoint: String,
}

impl std::fmt::Debug for CloudRecognizer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CloudRecognizer")
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
struct VerboseTranscription {
    #[serde(default)]
    words: Vec<TranscribedWord>,
}

#[derive(Deserialize)]
struct TranscribedWord {
    word: String,
    start: f64,
    end: f64,
}

impl CloudRecognizer {
    #[cfg(test)]
    pub(crate) fn for_test(endpoint: &str) -> Self {
        Self {
            api_key: "test-key".into(),
            endpoint: endpoint.into(),
        }
    }

    /// Word timings for one audio file, as the timeline the on-device
    /// recognizer would have written.
    pub(crate) async fn transcribe(
        &self,
        audio_path: &FsPath,
        language: Option<&str>,
    ) -> anyhow::Result<Vec<alignment::TimelineEntry>> {
        let audio = fs::read(audio_path).await?;
        anyhow::ensure!(
            audio.len() as u64 <= MAX_UPLOAD_BYTES,
            "OpenAI transcription accepts at most 25 MB of audio at a time."
        );
        let (body, content_type) = multipart_body(&audio, upload_name(audio_path), language);
        let client = http_client_builder().timeout(REQUEST_TIMEOUT).build()?;
        let mut attempt = 0;
        let reply = loop {
            attempt += 1;
            let sent = client
                .post(&self.endpoint)
                .bearer_auth(&self.api_key)
                .header(CONTENT_TYPE, &content_type)
                .body(body.clone())
                .send()
                .await;
            let retryable = match &sent {
                Ok(response) => {
                    response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
                        || response.status().is_server_error()
                }
                Err(error) => error.is_timeout() || error.is_connect(),
            };
            if !retryable || attempt >= ATTEMPTS {
                break sent.map_err(|error| {
                    anyhow::anyhow!("Could not reach OpenAI for transcription: {error}")
                })?;
            }
            tokio::time::sleep(retry_delay(attempt)).await;
        };
        let status = reply.status();
        let text = reply.text().await?;
        if !status.is_success() {
            anyhow::bail!(
                "OpenAI transcription failed: {}",
                openai_error(status, &text)
            );
        }
        let parsed: VerboseTranscription = serde_json::from_str(&text).map_err(|_| {
            anyhow::anyhow!("OpenAI returned a transcription OperaLibre could not read.")
        })?;
        Ok(parsed
            .words
            .into_iter()
            .map(|word| alignment::TimelineEntry {
                kind: "word".into(),
                text: word.word,
                start_time: word.start,
                end_time: word.end,
                start_offset_utf16: None,
                end_offset_utf16: None,
                timeline: None,
            })
            .collect())
    }
}

fn retry_delay(attempt: u32) -> Duration {
    if cfg!(test) {
        Duration::from_millis(10)
    } else {
        Duration::from_secs(5 * 4u64.pow(attempt - 1))
    }
}

/// OpenAI decides the format from the file name. Recognition windows are
/// WAV; a short single-file book is sent as it is.
fn upload_name(path: &FsPath) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("mp3") => "audio.mp3",
        Some("m4a" | "m4b" | "aac") => "audio.m4a",
        Some("mp4") => "audio.mp4",
        Some("ogg" | "oga" | "opus") => "audio.ogg",
        Some("flac") => "audio.flac",
        Some("webm") => "audio.webm",
        _ => "audio.wav",
    }
}

fn multipart_body(audio: &[u8], file_name: &str, language: Option<&str>) -> (Vec<u8>, String) {
    let boundary = format!("operalibre-{}", random_hex_id());
    let mut body = Vec::with_capacity(audio.len() + 1024);
    let mut field = |name: &str, value: &str| {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    };
    field("model", OPENAI_MODEL);
    field("response_format", "verbose_json");
    field("timestamp_granularities[]", "word");
    if let Some(language) = language {
        field("language", language);
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(audio);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (body, format!("multipart/form-data; boundary={boundary}"))
}

/// OpenAI's own explanation, which never repeats the key.
fn openai_error(status: reqwest::StatusCode, body: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value["error"]["message"].as_str().map(str::to_owned));
    match status.as_u16() {
        401 => "OpenAI did not accept the API key. An owner can replace it under Administration → Experiments.".into(),
        429 => format!(
            "OpenAI is rate limiting this key or its quota is used up ({}).",
            message.unwrap_or_else(|| status.to_string())
        ),
        _ => message.unwrap_or_else(|| status.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in for OpenAI that fails `failures` times with a 500, then
    /// answers with two words, and hands back each request body it saw.
    async fn fake_openai(
        failures: usize,
    ) -> (String, Arc<std::sync::Mutex<Vec<(HeaderMap, Vec<u8>)>>>) {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = seen.clone();
        let app = Router::new().route(
            "/v1/audio/transcriptions",
            post(move |headers: HeaderMap, body: axum::body::Bytes| {
                let recorded = recorded.clone();
                async move {
                    let mut seen = recorded.lock().unwrap();
                    seen.push((headers, body.to_vec()));
                    if seen.len() <= failures {
                        return (StatusCode::INTERNAL_SERVER_ERROR, "{}".to_string());
                    }
                    (
                        StatusCode::OK,
                        r#"{"text":"Call me Ishmael.","words":[{"word":"Call","start":0.5,"end":0.8},{"word":"Ishmael.","start":1.1,"end":1.9}]}"#.to_string(),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{address}/v1/audio/transcriptions"), seen)
    }

    #[tokio::test]
    async fn transcription_sends_the_window_and_reads_word_clocks() {
        let (endpoint, seen) = fake_openai(1).await;
        let root = tempfile::tempdir().unwrap();
        let audio = root.path().join("audio-0-0-window.wav");
        std::fs::write(&audio, b"RIFF fake wave data").unwrap();
        let entries = CloudRecognizer::for_test(&endpoint)
            .transcribe(&audio, Some("en"))
            .await
            .unwrap();
        let words = alignment::recognized_words(&entries);
        assert_eq!(
            words
                .iter()
                .map(|word| (word.text.as_str(), word.start_time, word.end_time))
                .collect::<Vec<_>>(),
            [("call", 0.5, 0.8), ("ishmael", 1.1, 1.9)]
        );
        // The first reply was a server error, so the window was sent again.
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        let (headers, body) = &seen[1];
        assert_eq!(headers[AUTHORIZATION], "Bearer test-key");
        let body = String::from_utf8_lossy(body);
        for part in [
            "name=\"model\"\r\n\r\nwhisper-1\r\n",
            "name=\"timestamp_granularities[]\"\r\n\r\nword\r\n",
            "name=\"response_format\"\r\n\r\nverbose_json\r\n",
            "name=\"language\"\r\n\r\nen\r\n",
            "filename=\"audio.wav\"",
            "RIFF fake wave data",
        ] {
            assert!(body.contains(part), "{part} missing from {body}");
        }
    }

    #[tokio::test]
    async fn persistent_server_errors_fail_the_window() {
        let (endpoint, seen) = fake_openai(usize::MAX).await;
        let root = tempfile::tempdir().unwrap();
        let audio = root.path().join("window.wav");
        std::fs::write(&audio, b"RIFF").unwrap();
        let error = CloudRecognizer::for_test(&endpoint)
            .transcribe(&audio, None)
            .await
            .unwrap_err();
        assert!(
            error.to_string().starts_with("OpenAI transcription failed"),
            "{error}"
        );
        assert_eq!(seen.lock().unwrap().len(), ATTEMPTS as usize);
    }

    #[test]
    fn upload_names_match_formats_openai_accepts() {
        assert_eq!(
            upload_name(FsPath::new("/tmp/audio-1-0-window.wav")),
            "audio.wav"
        );
        assert_eq!(upload_name(FsPath::new("/books/a/Book.M4B")), "audio.m4a");
        assert_eq!(upload_name(FsPath::new("/books/a/part.mp3")), "audio.mp3");
    }

    #[test]
    fn errors_explain_without_echoing_the_key() {
        let rejected = openai_error(
            reqwest::StatusCode::UNAUTHORIZED,
            r#"{"error":{"message":"Incorrect API key provided: sk-abc***xyz"}}"#,
        );
        assert!(rejected.contains("did not accept the API key"));
        assert!(!rejected.contains("sk-"));
        assert_eq!(
            openai_error(
                reqwest::StatusCode::BAD_REQUEST,
                r#"{"error":{"message":"Audio file is too short."}}"#
            ),
            "Audio file is too short."
        );
    }
}
