//! The ElevenLabs calls behind voice replacement: listing the owner's voices,
//! transcribing a chapter with speaker labels, changing the voice of a clip
//! while keeping its performance, and speaking text.
//!
//! Audio goes to and from disk, never through memory whole: a chapter can be
//! hours long and home servers are small.
use crate::*;

const API: &str = "https://api.elevenlabs.io";
pub(crate) const TRANSCRIBE_MODEL: &str = "scribe_v2";
pub(crate) const VOICE_CHANGER_MODEL: &str = "eleven_multilingual_sts_v2";
/// Follows delivery directions written in square brackets, such as
/// `[whispers]`.
pub(crate) const SPEECH_MODEL: &str = "eleven_v3";
/// What one speech request may carry, with room to spare under the model's
/// limit so a direction or two never tips it over.
pub(crate) const SPEECH_CHARACTERS: usize = 2_800;
/// The voice changer takes five minutes at most.
pub(crate) const VOICE_CHANGER_SECONDS: f64 = 4.5 * 60.0;
/// The voice changer bills a minute of audio as this many characters.
pub(crate) const CREDITS_PER_MINUTE: f64 = 1_000.0;
const OUTPUT_FORMAT: &str = "mp3_44100_128";
const ATTEMPTS: u32 = 3;
const MAX_AUDIO_REPLY_BYTES: u64 = 256 * 1024 * 1024;
const MAX_JSON_REPLY_BYTES: usize = 64 * 1024 * 1024;

pub(crate) struct ElevenLabs {
    api_key: String,
    base: String,
    client: reqwest::Client,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Voice {
    pub(crate) voice_id: String,
    pub(crate) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
}

/// How the voice changer is asked to perform, where the voice's own saved
/// settings are not wanted. Each number runs from 0 to 1.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChangerSettings {
    /// Low follows the original's ups and downs; high evens them out.
    pub(crate) stability: f64,
    /// How closely the result keeps to the chosen voice.
    pub(crate) similarity: f64,
    /// How far the original's manner is exaggerated.
    pub(crate) style: f64,
    /// Strip music and room noise from the original first.
    #[serde(default)]
    pub(crate) remove_noise: bool,
}

/// One recognized word, timed within the audio that was sent.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Word {
    pub(crate) text: String,
    pub(crate) start: f64,
    pub(crate) end: f64,
    pub(crate) speaker: String,
}

impl ElevenLabs {
    pub(crate) fn new(api_key: String, base: Option<String>) -> anyhow::Result<Self> {
        Ok(Self {
            api_key,
            base: base.unwrap_or_else(|| API.into()),
            // Transcribing hours of audio is one long request.
            client: http_client_builder()
                .timeout(Duration::from_secs(45 * 60))
                .build()?,
        })
    }

    /// The voices in the owner's ElevenLabs account, by name.
    pub(crate) async fn voices(&self) -> anyhow::Result<Vec<Voice>> {
        #[derive(Deserialize)]
        struct Page {
            #[serde(default)]
            voices: Vec<RawVoice>,
            #[serde(default)]
            has_more: bool,
            #[serde(default)]
            next_page_token: Option<String>,
        }
        #[derive(Deserialize)]
        struct RawVoice {
            voice_id: String,
            #[serde(default)]
            name: Option<String>,
            #[serde(default)]
            category: Option<String>,
            #[serde(default)]
            description: Option<String>,
        }
        let mut voices = Vec::new();
        let mut token: Option<String> = None;
        // Ten pages is a thousand voices, more than a picker can show.
        for _ in 0..10 {
            let mut query = vec![("page_size", "100")];
            if let Some(token) = &token {
                query.push(("next_page_token", token));
            }
            let url = reqwest::Url::parse_with_params(&format!("{}/v2/voices", self.base), &query)?;
            let text = self.json_reply(self.client.get(url), "list voices").await?;
            let page: Page = serde_json::from_str(&text).map_err(|_| {
                anyhow::anyhow!("ElevenLabs returned a voice list OperaLibre could not read.")
            })?;
            voices.extend(page.voices.into_iter().map(|voice| {
                Voice {
                    name: voice
                        .name
                        .filter(|name| !name.trim().is_empty())
                        .unwrap_or_else(|| voice.voice_id.clone()),
                    voice_id: voice.voice_id,
                    category: voice.category,
                    description: voice.description,
                }
            }));
            token = page.next_page_token.filter(|_| page.has_more);
            if token.is_none() {
                break;
            }
        }
        voices.sort_by_key(|voice| voice.name.to_lowercase());
        Ok(voices)
    }

    /// Credits left this billing period, when the key may read that.
    pub(crate) async fn credits_left(&self) -> Option<u64> {
        #[derive(Deserialize)]
        struct Subscription {
            character_count: u64,
            character_limit: u64,
        }
        let request = self
            .client
            .get(format!("{}/v1/user/subscription", self.base));
        let text = self.json_reply(request, "read the plan").await.ok()?;
        let plan: Subscription = serde_json::from_str(&text).ok()?;
        Some(plan.character_limit.saturating_sub(plan.character_count))
    }

    /// Every word in an audio file, with who said it. Speaker names are only
    /// consistent within the one file.
    pub(crate) async fn transcribe(&self, audio: &FsPath) -> anyhow::Result<Vec<Word>> {
        #[derive(Deserialize)]
        struct Transcript {
            #[serde(default)]
            words: Vec<RawWord>,
        }
        #[derive(Deserialize)]
        struct RawWord {
            text: String,
            #[serde(default)]
            start: Option<f64>,
            #[serde(default)]
            end: Option<f64>,
            #[serde(default, rename = "type")]
            kind: Option<String>,
            #[serde(default)]
            speaker_id: Option<String>,
        }
        let form = MultipartFile::build(
            audio,
            "file",
            &[
                ("model_id", TRANSCRIBE_MODEL),
                ("diarize", "true"),
                ("timestamps_granularity", "word"),
                ("tag_audio_events", "false"),
            ],
        )
        .await?;
        let reply = self
            .send_form(
                &format!("{}/v1/speech-to-text", self.base),
                &form,
                "transcribe",
            )
            .await?;
        let text = String::from_utf8(provider_response::read(reply, MAX_JSON_REPLY_BYTES).await?)?;
        let transcript: Transcript = serde_json::from_str(&text).map_err(|_| {
            anyhow::anyhow!("ElevenLabs returned a transcript OperaLibre could not read.")
        })?;
        Ok(transcript
            .words
            .into_iter()
            .filter(|word| word.kind.as_deref().unwrap_or("word") == "word")
            .filter_map(|word| {
                let (start, end) = (word.start?, word.end?);
                let text = word.text.trim().to_string();
                (!text.is_empty() && end >= start && text.len() <= 400).then(|| Word {
                    text,
                    start,
                    end,
                    speaker: word.speaker_id.unwrap_or_else(|| "speaker_0".into()),
                })
            })
            .collect())
    }

    /// The same performance in another voice, saved to `output`.
    pub(crate) async fn change_voice(
        &self,
        voice_id: &str,
        audio: &FsPath,
        output: &FsPath,
        settings: Option<&ChangerSettings>,
    ) -> anyhow::Result<()> {
        let voice_settings = settings.map(|settings| {
            serde_json::json!({
                "stability": settings.stability,
                "similarity_boost": settings.similarity,
                "style": settings.style,
            })
            .to_string()
        });
        let mut fields = vec![("model_id", VOICE_CHANGER_MODEL)];
        if let (Some(settings), Some(voice_settings)) = (settings, &voice_settings) {
            fields.push(("voice_settings", voice_settings));
            if settings.remove_noise {
                fields.push(("remove_background_noise", "true"));
            }
        }
        let form = MultipartFile::build(audio, "audio", &fields).await?;
        let url = format!(
            "{}/v1/speech-to-speech/{voice_id}?output_format={OUTPUT_FORMAT}",
            self.base
        );
        let reply = self.send_form(&url, &form, "change the voice").await?;
        save_audio(reply, output).await
    }

    /// `text` spoken in a voice, saved to `output`.
    pub(crate) async fn speak(
        &self,
        voice_id: &str,
        text: &str,
        output: &FsPath,
    ) -> anyhow::Result<()> {
        let url = format!(
            "{}/v1/text-to-speech/{voice_id}?output_format={OUTPUT_FORMAT}",
            self.base
        );
        let body = serde_json::json!({ "text": text, "model_id": SPEECH_MODEL });
        let reply = self
            .send_retrying("speak the text", || {
                std::future::ready(Ok(self.client.post(&url).json(&body)))
            })
            .await?;
        save_audio(reply, output).await
    }

    async fn json_reply(
        &self,
        request: reqwest::RequestBuilder,
        doing: &str,
    ) -> anyhow::Result<String> {
        let reply = request
            .header("xi-api-key", &self.api_key)
            .send()
            .await
            .map_err(|error| anyhow::anyhow!("Could not reach ElevenLabs to {doing}: {error}"))?;
        let status = reply.status();
        let text = String::from_utf8(provider_response::read(reply, MAX_JSON_REPLY_BYTES).await?)?;
        anyhow::ensure!(status.is_success(), "{}", provider_error(status, &text));
        Ok(text)
    }

    async fn send_form(
        &self,
        url: &str,
        form: &MultipartFile,
        doing: &str,
    ) -> anyhow::Result<reqwest::Response> {
        self.send_retrying(doing, || async {
            let file = fs::File::open(&form.path).await?;
            Ok(self
                .client
                .post(url)
                .header(CONTENT_TYPE, &form.content_type)
                .header(CONTENT_LENGTH, form.length)
                .body(reqwest::Body::wrap_stream(ReaderStream::new(file))))
        })
        .await
    }

    /// Sends a request, again after a rate limit, a provider fault, or a
    /// dropped connection, and turns any other failure into its explanation.
    async fn send_retrying<F, Fut>(
        &self,
        doing: &str,
        build: F,
    ) -> anyhow::Result<reqwest::Response>
    where
        F: Fn() -> Fut,
        Fut: Future<Output = anyhow::Result<reqwest::RequestBuilder>>,
    {
        let mut attempt = 0;
        loop {
            attempt += 1;
            let sent = build()
                .await?
                .header("xi-api-key", &self.api_key)
                .send()
                .await;
            let retryable = match &sent {
                Ok(reply) => {
                    reply.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
                        || reply.status().is_server_error()
                }
                Err(error) => error.is_timeout() || error.is_connect(),
            };
            if retryable && attempt < ATTEMPTS {
                tokio::time::sleep(retry_delay(attempt)).await;
                continue;
            }
            let reply = sent.map_err(|error| {
                anyhow::anyhow!("Could not reach ElevenLabs to {doing}: {error}")
            })?;
            if reply.status().is_success() {
                return Ok(reply);
            }
            let status = reply.status();
            let text = provider_response::read(reply, 1024 * 1024)
                .await
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .unwrap_or_default();
            anyhow::bail!("{}", provider_error(status, &text));
        }
    }
}

fn retry_delay(attempt: u32) -> Duration {
    if cfg!(test) {
        Duration::from_millis(10)
    } else {
        Duration::from_secs(5 * 4u64.pow(attempt - 1))
    }
}

/// Streams a provider's audio to a sibling of `output`, moved into place only
/// once it is whole, so a clip that exists was paid for and is complete.
async fn save_audio(mut reply: reqwest::Response, output: &FsPath) -> anyhow::Result<()> {
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).await?;
    }
    let partial = output.with_extension(format!("{}.part", random_hex_id()));
    let written = async {
        let mut file = fs::File::create(&partial).await?;
        let mut total = 0u64;
        while let Some(chunk) = reply.chunk().await? {
            total += chunk.len() as u64;
            anyhow::ensure!(
                total <= MAX_AUDIO_REPLY_BYTES,
                "ElevenLabs sent more audio than expected."
            );
            file.write_all(&chunk).await?;
        }
        anyhow::ensure!(total > 0, "ElevenLabs sent no audio.");
        file.flush().await?;
        file.sync_all().await?;
        Ok(())
    }
    .await;
    match written {
        Ok(()) => Ok(fs::rename(&partial, output).await?),
        Err(error) => {
            let _ = fs::remove_file(&partial).await;
            Err(error)
        }
    }
}

/// A multipart request body on disk beside the audio it carries, removed when
/// dropped.
struct MultipartFile {
    path: PathBuf,
    content_type: String,
    length: u64,
}

impl MultipartFile {
    async fn build(
        audio: &FsPath,
        file_field: &str,
        fields: &[(&str, &str)],
    ) -> anyhow::Result<Self> {
        let boundary = format!("operalibre-{}", random_hex_id());
        let path = audio.with_extension(format!("{}.form", random_hex_id()));
        let mut head = String::new();
        for (name, value) in fields {
            head.push_str(&format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            ));
        }
        let file_name = audio
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| format!("audio.{}", extension.to_ascii_lowercase()))
            .unwrap_or_else(|| "audio.flac".into());
        head.push_str(&format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; filename=\"{file_name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        ));
        // Made before the file is, so a failure part way still removes it.
        let mut form = Self {
            path,
            content_type: format!("multipart/form-data; boundary={boundary}"),
            length: 0,
        };
        let mut body = fs::File::create(&form.path).await?;
        body.write_all(head.as_bytes()).await?;
        let mut source = fs::File::open(audio).await?;
        tokio::io::copy(&mut source, &mut body).await?;
        body.write_all(format!("\r\n--{boundary}--\r\n").as_bytes())
            .await?;
        body.flush().await?;
        form.length = body.metadata().await?.len();
        Ok(form)
    }
}

impl Drop for MultipartFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// ElevenLabs' own explanation, which never repeats the key.
fn provider_error(status: reqwest::StatusCode, body: &str) -> String {
    let value = serde_json::from_str::<serde_json::Value>(body).ok();
    let detail = value.as_ref().map(|value| &value["detail"]);
    let message = detail.and_then(|detail| {
        detail["message"]
            .as_str()
            .or_else(|| detail[0]["msg"].as_str())
            .or_else(|| detail.as_str())
            .map(|message| message.chars().take(400).collect::<String>())
    });
    match status.as_u16() {
        401 => "ElevenLabs did not accept the API key. An owner can replace it under Administration → Experiments.".into(),
        429 => format!(
            "ElevenLabs is rate limiting this key ({}).",
            message.unwrap_or_else(|| status.to_string())
        ),
        _ => format!(
            "ElevenLabs refused the request: {}",
            message.unwrap_or_else(|| status.to_string())
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_explain_without_echoing_the_key() {
        let rejected = provider_error(
            reqwest::StatusCode::UNAUTHORIZED,
            r#"{"detail":{"status":"invalid_api_key","message":"Invalid API key sk_abc"}}"#,
        );
        assert!(rejected.contains("did not accept the API key"));
        assert!(!rejected.contains("sk_abc"));
        assert_eq!(
            provider_error(
                reqwest::StatusCode::UNPROCESSABLE_ENTITY,
                r#"{"detail":[{"loc":["body","model_id"],"msg":"Field required"}]}"#
            ),
            "ElevenLabs refused the request: Field required"
        );
        assert!(
            provider_error(reqwest::StatusCode::BAD_REQUEST, "<html>").ends_with("400 Bad Request")
        );
    }

    #[tokio::test]
    async fn a_form_carries_its_fields_and_the_whole_file() {
        let root = tempfile::tempdir().unwrap();
        let audio = root.path().join("clip.flac");
        std::fs::write(&audio, b"fLaC audio bytes").unwrap();
        let form = MultipartFile::build(&audio, "audio", &[("model_id", "m")])
            .await
            .unwrap();
        let body = std::fs::read_to_string(&form.path).unwrap();
        assert_eq!(form.length, body.len() as u64);
        for part in [
            "name=\"model_id\"\r\n\r\nm\r\n",
            "name=\"audio\"; filename=\"audio.flac\"",
            "\r\n\r\nfLaC audio bytes\r\n--operalibre-",
        ] {
            assert!(body.contains(part), "{part} missing from {body}");
        }
        let path = form.path.clone();
        drop(form);
        assert!(!path.exists());
    }
}
