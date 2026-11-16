use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

const STATUS: &str = "/api/experimental-features/voice-replacement";

/// Two seconds of a steady tone as a WAV, standing in for a provider's clip.
/// ffmpeg reads the format from the bytes, whatever the file is called.
fn tone_wav() -> Vec<u8> {
    let samples: Vec<u8> = (0..16_000)
        .flat_map(|sample: i32| (((sample % 40) - 20) as i16 * 400).to_le_bytes())
        .collect();
    let mut wav = Vec::new();
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36u32 + samples.len() as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&8_000u32.to_le_bytes());
    wav.extend_from_slice(&16_000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    wav.extend_from_slice(&samples);
    wav
}

#[derive(Default)]
struct Calls {
    transcriptions: AtomicUsize,
    voice_changes: AtomicUsize,
    speeches: AtomicUsize,
    /// The voice each changed clip was asked for in.
    voices: std::sync::Mutex<Vec<String>>,
    /// The text each speech request carried.
    spoken: std::sync::Mutex<Vec<String>>,
    /// The settings each changed clip was asked for with, where it had any.
    settings: std::sync::Mutex<Vec<Option<String>>>,
}

/// A stand-in for ElevenLabs that hears two narrators in whatever it is sent
/// and answers every audio request with a tone.
async fn fake_elevenlabs() -> (String, Arc<Calls>) {
    let calls = Arc::new(Calls::default());
    let app = Router::new()
        .route(
            "/v2/voices",
            get(|headers: HeaderMap| async move {
                assert_eq!(headers["xi-api-key"], "test-key");
                Json(serde_json::json!({
                    "voices": [
                        { "voice_id": "voiceB", "name": "Briar", "category": "premade" },
                        { "voice_id": "voiceA", "name": "Alder", "preview_url": "https://example.test/a.mp3" },
                    ],
                    "has_more": false,
                }))
            }),
        )
        .route(
            "/v1/user/subscription",
            get(|| async {
                Json(serde_json::json!({ "character_count": 1_000, "character_limit": 30_000 }))
            }),
        )
        .route(
            "/v1/speech-to-text",
            post({
                let calls = calls.clone();
                move |body: axum::body::Bytes| {
                    let calls = calls.clone();
                    async move {
                        calls.transcriptions.fetch_add(1, Ordering::SeqCst);
                        let body = String::from_utf8_lossy(&body).to_string();
                        assert!(body.contains("name=\"diarize\"\r\n\r\ntrue"), "{body}");
                        Json(serde_json::json!({
                            "language_code": "en",
                            "text": "",
                            "words": [
                                { "text": "First", "start": 0.5, "end": 1.0, "type": "word", "speaker_id": "speaker_0" },
                                { "text": " ", "start": 1.0, "end": 1.1, "type": "spacing", "speaker_id": "speaker_0" },
                                { "text": "narrator.", "start": 1.1, "end": 2.5, "type": "word", "speaker_id": "speaker_0" },
                                { "text": "Second", "start": 4.0, "end": 5.0, "type": "word", "speaker_id": "speaker_1" },
                                { "text": "narrator.", "start": 5.0, "end": 8.0, "type": "word", "speaker_id": "speaker_1" },
                            ],
                        }))
                    }
                }
            }),
        )
        .route(
            "/v1/speech-to-speech/{voice}",
            post({
                let calls = calls.clone();
                move |Path(voice): Path<String>, body: axum::body::Bytes| {
                    let calls = calls.clone();
                    async move {
                        let body = String::from_utf8_lossy(&body).to_string();
                        assert!(body.contains("name=\"audio\"; filename=\"audio.flac\""));
                        calls.voice_changes.fetch_add(1, Ordering::SeqCst);
                        calls.voices.lock().unwrap().push(voice);
                        let settings = body
                            .split_once("name=\"voice_settings\"\r\n\r\n")
                            .and_then(|(_, rest)| rest.split_once("\r\n"))
                            .map(|(settings, _)| settings.to_string());
                        calls.settings.lock().unwrap().push(settings);
                        tone_wav()
                    }
                }
            }),
        )
        .route(
            "/v1/text-to-speech/{voice}",
            post({
                let calls = calls.clone();
                move |Json(body): Json<serde_json::Value>| {
                    let calls = calls.clone();
                    async move {
                        calls.speeches.fetch_add(1, Ordering::SeqCst);
                        calls
                            .spoken
                            .lock()
                            .unwrap()
                            .push(body["text"].as_str().unwrap().to_string());
                        tone_wav()
                    }
                }
            }),
        )
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}"), calls)
}

async fn wait_for_run(server: &TestServer, owner: &str, book: &str) -> serde_json::Value {
    let route = format!("/api/books/{book}/voice-replacement");
    loop {
        let project = server.get(&route, owner).await.json();
        match project["run"]["state"].as_str() {
            None => return project,
            Some("failed") => panic!("the run failed: {project}"),
            Some(_) => tokio::time::sleep(Duration::from_millis(20)).await,
        }
    }
}

fn library_files(root: &FsPath) -> BTreeMap<PathBuf, Vec<u8>> {
    WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| {
            (
                entry.path().to_path_buf(),
                std::fs::read(entry.path()).unwrap(),
            )
        })
        .collect()
}

#[tokio::test]
async fn only_the_owner_sets_up_voice_replacement_and_readers_see_nothing() {
    let server = TestServer::start(1).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "voice-reader").await;
    let (book, _) = server.first_book_and_track(&owner).await;
    let project = format!("/api/books/{book}/voice-replacement");
    let key_route = format!("{STATUS}/key");
    let key = "sk_test_0123456789";
    let confirmed = serde_json::json!({ "apiKey": key, "acknowledgePrivacy": true });

    assert_eq!(
        server.get(STATUS, &owner).await.json()["enabled"],
        serde_json::json!(false)
    );
    assert_eq!(
        server.get(STATUS, &reader).await.status,
        StatusCode::FORBIDDEN
    );
    // Off, the feature is not there at all, key route included.
    assert_eq!(
        server.get(&project, &owner).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        server
            .send_json("PUT", &key_route, &owner, confirmed.clone())
            .await
            .status,
        StatusCode::NOT_FOUND
    );

    let enable = serde_json::json!({ "enabled": true });
    assert_eq!(
        server
            .send_json("PUT", &format!("{STATUS}/enabled"), &reader, enable.clone())
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let enabled = server
        .send_json("PUT", &format!("{STATUS}/enabled"), &owner, enable)
        .await;
    assert_eq!(enabled.status, StatusCode::OK, "{}", enabled.text());
    assert_eq!(enabled.json()["hasApiKey"], serde_json::json!(false));

    assert_eq!(
        server.get(&project, &reader).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(server.get(&project, &owner).await.status, StatusCode::OK);
    // Nothing can be sent before a key is saved.
    let no_key = server
        .send_json(
            "POST",
            &format!("{project}/analysis"),
            &owner,
            serde_json::json!({ "chapters": [0] }),
        )
        .await;
    assert_eq!(no_key.status, StatusCode::BAD_REQUEST, "{}", no_key.text());

    let unconfirmed = server
        .send_json(
            "PUT",
            &key_route,
            &owner,
            serde_json::json!({ "apiKey": key }),
        )
        .await;
    assert_eq!(unconfirmed.status, StatusCode::BAD_REQUEST);
    assert!(unconfirmed.text().contains("sent to ElevenLabs"));
    assert_eq!(
        server
            .send_json("PUT", &key_route, &reader, confirmed.clone())
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let saved = server.send_json("PUT", &key_route, &owner, confirmed).await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.text());
    assert_eq!(saved.json()["hasApiKey"], serde_json::json!(true));
    assert!(!saved.text().contains(key));
    assert!(!server.get(STATUS, &owner).await.text().contains(key));

    let removed = server
        .send_json("DELETE", &key_route, &owner, serde_json::json!({}))
        .await;
    assert_eq!(removed.json()["hasApiKey"], serde_json::json!(false));
}

#[tokio::test]
async fn a_plan_is_checked_against_the_book_before_it_is_saved() {
    let server = TestServer::start(1).await;
    let owner = server.setup_owner().await;
    let (book, _) = server.first_book_and_track(&owner).await;
    let (base, calls) = fake_elevenlabs().await;
    crate::voice_replacement::enable_for_test(&server.state, &base).await;
    let project = format!("/api/books/{book}/voice-replacement");
    let voice = serde_json::json!({ "voiceId": "voiceA", "name": "Alder" });
    let plan = |edits: serde_json::Value| serde_json::json!({ "edits": edits });

    let voices = server.get("/api/voice-replacement/voices", &owner).await;
    assert_eq!(voices.status, StatusCode::OK, "{}", voices.text());
    let voices = voices.json();
    assert_eq!(voices["voices"][0]["name"], "Alder");
    assert_eq!(voices["voices"][1]["voiceId"], "voiceB");
    assert_eq!(voices["creditsLeft"], 29_000);

    for refused in [
        // A voice id that would change the request it is put into.
        serde_json::json!([{ "kind": "chapter", "chapter": 0, "method": "keepPerformance", "voice": { "voiceId": "a/../b", "name": "x" } }]),
        serde_json::json!([{ "kind": "chapter", "chapter": 99, "method": "keepPerformance", "voice": voice }]),
        // No narrators have been found in this chapter yet.
        serde_json::json!([{ "kind": "speaker", "chapter": 0, "speaker": "speaker_0", "voice": voice }]),
        serde_json::json!([{ "kind": "line", "chapter": 0, "startSeconds": 5.0, "endSeconds": 5.1, "voice": voice }]),
        serde_json::json!([{ "kind": "line", "chapter": 0, "startSeconds": 5.0, "endSeconds": 9000.0, "voice": voice }]),
    ] {
        let response = server
            .send_json(
                "PUT",
                &format!("{project}/plan"),
                &owner,
                plan(refused.clone()),
            )
            .await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST, "{refused}");
    }

    let saved = server
        .send_json(
            "PUT",
            &format!("{project}/plan"),
            &owner,
            plan(serde_json::json!([
                { "kind": "line", "chapter": 0, "startSeconds": 1.0, "endSeconds": 4.0, "voice": voice, "text": "  [whispers]  Not   yet. " },
                { "kind": "line", "chapter": 0, "startSeconds": 6.0, "endSeconds": 8.0, "voice": voice, "text": "   " },
            ])),
        )
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.text());
    let edits = saved.json()["edits"].clone();
    assert_eq!(edits[0]["text"], "[whispers] Not yet.");
    assert!(!edits[0]["id"].as_str().unwrap().is_empty());
    // Blank text means keeping the performance.
    assert!(edits[1].get("text").is_none());

    let estimate = server
        .get(&format!("{project}/estimate"), &owner)
        .await
        .json();
    assert_eq!(estimate["voiceChangerSeconds"], 2.0);
    assert_eq!(estimate["speechCharacters"], 19);
    // Two seconds of the voice changer round up to 34 credits, plus the text.
    assert_eq!(estimate["credits"], 53);
    assert_eq!(estimate["chaptersChanged"], 1);

    let unconfirmed = server
        .send_json(
            "POST",
            &format!("{project}/render"),
            &owner,
            serde_json::json!({}),
        )
        .await;
    assert_eq!(unconfirmed.status, StatusCode::BAD_REQUEST);
    assert_eq!(calls.voice_changes.load(Ordering::SeqCst), 0);
    assert_eq!(calls.speeches.load(Ordering::SeqCst), 0);

    // Turning the experiment off hides it without losing the plan.
    let off = server
        .send_json(
            "PUT",
            &format!("{STATUS}/enabled"),
            &owner,
            serde_json::json!({ "enabled": false }),
        )
        .await;
    assert_eq!(off.status, StatusCode::OK);
    assert_eq!(
        server.get(&project, &owner).await.status,
        StatusCode::NOT_FOUND
    );
    server
        .send_json(
            "PUT",
            &format!("{STATUS}/enabled"),
            &owner,
            serde_json::json!({ "enabled": true }),
        )
        .await;
    assert_eq!(
        server.get(&project, &owner).await.json()["edits"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let cleared = server
        .send_json("DELETE", &project, &owner, serde_json::json!({}))
        .await;
    assert_eq!(cleared.status, StatusCode::NO_CONTENT);
    assert!(
        server.get(&project, &owner).await.json()["edits"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn one_narrator_is_replaced_in_a_copy_and_the_original_is_left_alone() {
    if faststart::discover_tools(None, None).is_none() {
        eprintln!("skipped: this test cuts and writes real audio, which needs ffmpeg");
        return;
    }
    let server = TestServer::start(1).await;
    let owner = server.setup_owner().await;
    let (book, _) = server.first_book_and_track(&owner).await;
    let (base, calls) = fake_elevenlabs().await;
    crate::voice_replacement::enable_for_test(&server.state, &base).await;
    let project = format!("/api/books/{book}/voice-replacement");
    let original = library_files(&server.library_root);
    let voice = serde_json::json!({ "voiceId": "voiceA", "name": "Alder" });

    let started = server
        .send_json(
            "POST",
            &format!("{project}/analysis"),
            &owner,
            serde_json::json!({ "chapters": [0] }),
        )
        .await;
    assert_eq!(started.status, StatusCode::OK, "{}", started.text());
    let found = wait_for_run(&server, &owner, &book).await;
    let chapter = &found["chapters"][0];
    let chapter_start = chapter["startSeconds"].as_f64().unwrap();
    let speakers = chapter["speakers"]
        .as_array()
        .unwrap_or_else(|| panic!("no speakers: {found}"));
    assert_eq!(speakers.len(), 2, "{found}");
    assert_eq!(speakers[0]["id"], "speaker_1");
    assert_eq!(speakers[0]["seconds"], 4.0);
    let lines = server
        .get(&format!("{project}/chapters/0/lines"), &owner)
        .await
        .json();
    assert_eq!(lines["lines"][0]["text"], "First narrator.");
    assert_eq!(lines["lines"][1]["speaker"], "speaker_1");
    // Asking again does not pay again.
    server
        .send_json(
            "POST",
            &format!("{project}/analysis"),
            &owner,
            serde_json::json!({ "chapters": [0] }),
        )
        .await;
    wait_for_run(&server, &owner, &book).await;
    assert_eq!(calls.transcriptions.load(Ordering::SeqCst), 1);

    let heard = server
        .get(
            &format!(
                "{project}/original?startSeconds={chapter_start}&endSeconds={}",
                chapter_start + 3.0
            ),
            &owner,
        )
        .await;
    assert_eq!(heard.status, StatusCode::OK, "{}", heard.text());
    assert_eq!(&heard.body[..4], b"RIFF");

    let line = serde_json::json!({
        "kind": "line", "chapter": 0, "voice": voice, "text": "[softly] First narrator, again.",
        "startSeconds": chapter_start + 0.5, "endSeconds": chapter_start + 2.5,
    });
    let preview = server
        .send_json("POST", &format!("{project}/preview"), &owner, line.clone())
        .await;
    assert_eq!(preview.status, StatusCode::OK, "{}", preview.text());
    assert_eq!(preview.body, tone_wav());

    let plan = serde_json::json!({ "edits": [
        { "kind": "speaker", "chapter": 0, "speaker": "speaker_1", "voice": voice },
        line,
    ] });
    let saved = server
        .send_json("PUT", &format!("{project}/plan"), &owner, plan)
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.text());

    let render = serde_json::json!({ "acknowledgeCost": true });
    let started = server
        .send_json("POST", &format!("{project}/render"), &owner, render.clone())
        .await;
    assert_eq!(started.status, StatusCode::OK, "{}", started.text());
    let made = wait_for_run(&server, &owner, &book).await;
    let copies = made["copies"].as_array().unwrap();
    assert_eq!(copies.len(), 1, "{made}");
    let folder = server
        .library_root
        .join(copies[0]["folder"].as_str().unwrap());
    assert!(
        copies[0]["folder"]
            .as_str()
            .unwrap()
            .ends_with("(Revoiced)")
    );
    // Only the second narrator went through the voice changer, and the line's
    // preview was the clip the copy used.
    assert_eq!(calls.voice_changes.load(Ordering::SeqCst), 1);
    assert_eq!(*calls.voices.lock().unwrap(), ["voiceA"]);
    assert_eq!(
        *calls.spoken.lock().unwrap(),
        ["[softly] First narrator, again."]
    );

    // The copy is a book of its own, one file per chapter.
    let copy_id = copies[0]["bookId"]
        .as_str()
        .expect("the copy is in the library");
    assert_ne!(copy_id, book);
    let copy = server
        .get(&format!("/api/books/{copy_id}"), &owner)
        .await
        .json();
    assert_eq!(
        copy["tracks"].as_array().unwrap().len(),
        made["chapters"].as_array().unwrap().len()
    );
    assert!(copy["durationSeconds"].as_f64().unwrap() > 15.0, "{copy}");
    // Nothing that was in the library before has changed.
    let after = library_files(&server.library_root);
    for (path, bytes) in &original {
        assert_eq!(after.get(path), Some(bytes), "{} changed", path.display());
    }

    // A second copy reuses every clip and takes a name of its own.
    server
        .send_json("POST", &format!("{project}/render"), &owner, render)
        .await;
    let again = wait_for_run(&server, &owner, &book).await;
    assert_eq!(again["copies"].as_array().unwrap().len(), 2);
    assert!(
        again["copies"][1]["folder"]
            .as_str()
            .unwrap()
            .ends_with("(Revoiced) 2")
    );
    assert_eq!(calls.voice_changes.load(Ordering::SeqCst), 1);
    assert_eq!(calls.speeches.load(Ordering::SeqCst), 1);

    // Removing a copy takes its folder and nothing else.
    let removed = server
        .send_json(
            "DELETE",
            &format!("{project}/copies/{}", copies[0]["id"].as_str().unwrap()),
            &owner,
            serde_json::json!({}),
        )
        .await;
    assert_eq!(removed.status, StatusCode::OK, "{}", removed.text());
    assert_eq!(removed.json()["copies"].as_array().unwrap().len(), 1);
    assert!(!folder.exists());
    let after = library_files(&server.library_root);
    for (path, bytes) in &original {
        assert_eq!(after.get(path), Some(bytes), "{} changed", path.display());
    }
    assert_eq!(
        server
            .get(&format!("/api/books/{copy_id}"), &owner)
            .await
            .status,
        StatusCode::NOT_FOUND
    );

    // A folder that has taken a copy's name is not that copy: removing the
    // record leaves it alone.
    let second = server
        .library_root
        .join(again["copies"][1]["folder"].as_str().unwrap());
    std::fs::remove_dir_all(&second).unwrap();
    std::fs::create_dir(&second).unwrap();
    std::fs::write(second.join("keep.txt"), "someone else's").unwrap();
    let listed = server.get(&project, &owner).await.json();
    assert!(listed["copies"][0].get("bookId").is_none(), "{listed}");
    let dropped = server
        .send_json(
            "DELETE",
            &format!(
                "{project}/copies/{}",
                again["copies"][1]["id"].as_str().unwrap()
            ),
            &owner,
            serde_json::json!({}),
        )
        .await;
    assert_eq!(dropped.status, StatusCode::OK, "{}", dropped.text());
    assert!(dropped.json()["copies"].as_array().unwrap().is_empty());
    assert!(second.join("keep.txt").exists());
}

#[tokio::test]
async fn a_voice_in_the_cast_is_tried_then_replaced_over_its_stretches() {
    if faststart::discover_tools(None, None).is_none() {
        eprintln!("skipped: this test cuts and writes real audio, which needs ffmpeg");
        return;
    }
    let server = TestServer::start(1).await;
    let owner = server.setup_owner().await;
    let (book, _) = server.first_book_and_track(&owner).await;
    let (base, calls) = fake_elevenlabs().await;
    crate::voice_replacement::enable_for_test(&server.state, &base).await;
    let project = format!("/api/books/{book}/voice-replacement");
    let opened = server.get(&project, &owner).await.json();
    let start = opened["chapters"][0]["startSeconds"].as_f64().unwrap();
    let end = opened["chapters"][0]["endSeconds"].as_f64().unwrap();
    let voice = serde_json::json!({
        "voiceId": "voiceA", "name": "Alder",
        "settings": { "stability": 0.3, "similarity": 0.8, "style": 0.0, "removeNoise": false },
    });
    let member = |stretches: serde_json::Value, voice: &serde_json::Value| serde_json::json!({ "edits": [], "cast": [{ "name": "Mara", "voice": voice, "stretches": stretches }] });

    // A stretch has to sit inside one chapter, and settings inside their range.
    let across = serde_json::json!([{ "startSeconds": end - 1.0, "endSeconds": end + 3.0 }]);
    let wild = serde_json::json!({
        "voiceId": "voiceA", "name": "Alder",
        "settings": { "stability": 2.0, "similarity": 0.8, "style": 0.0 },
    });
    let inside = serde_json::json!([{ "startSeconds": start + 4.0, "endSeconds": start + 8.0 }]);
    for bad in [member(across, &voice), member(inside.clone(), &wild)] {
        let refused = server
            .send_json("PUT", &format!("{project}/plan"), &owner, bad)
            .await;
        assert_eq!(
            refused.status,
            StatusCode::BAD_REQUEST,
            "{}",
            refused.text()
        );
    }

    // Trying the voice plays the book up to the stretch, then the new voice.
    let audition = serde_json::json!({
        "voice": voice, "startSeconds": start + 4.0, "endSeconds": start + 8.0, "leadSeconds": 2.0,
    });
    let tried = server
        .send_json(
            "POST",
            &format!("{project}/audition"),
            &owner,
            audition.clone(),
        )
        .await;
    assert_eq!(tried.status, StatusCode::OK, "{}", tried.text());
    assert_eq!(&tried.body[4..8], b"ftyp");
    assert_eq!(calls.voice_changes.load(Ordering::SeqCst), 1);
    let asked = calls.settings.lock().unwrap()[0]
        .clone()
        .expect("the settings went with the request");
    let asked: serde_json::Value = serde_json::from_str(&asked).unwrap();
    assert_eq!(asked["stability"], 0.3);
    assert_eq!(asked["similarity_boost"], 0.8);
    // The same try again is not paid for again; another setting is another clip.
    server
        .send_json("POST", &format!("{project}/audition"), &owner, audition)
        .await;
    assert_eq!(calls.voice_changes.load(Ordering::SeqCst), 1);
    let plainer = serde_json::json!({
        "voice": { "voiceId": "voiceA", "name": "Alder" },
        "startSeconds": start + 4.0, "endSeconds": start + 8.0,
    });
    let tried = server
        .send_json("POST", &format!("{project}/audition"), &owner, plainer)
        .await;
    assert_eq!(tried.status, StatusCode::OK, "{}", tried.text());
    assert_eq!(calls.voice_changes.load(Ordering::SeqCst), 2);
    assert_eq!(calls.settings.lock().unwrap()[1], None);
    let long = serde_json::json!({
        "voice": voice, "startSeconds": start, "endSeconds": start + 31.0,
    });
    assert_eq!(
        server
            .send_json("POST", &format!("{project}/audition"), &owner, long)
            .await
            .status,
        StatusCode::BAD_REQUEST
    );

    let saved = server
        .send_json(
            "PUT",
            &format!("{project}/plan"),
            &owner,
            member(inside.clone(), &voice),
        )
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.text());
    let saved = saved.json();
    let id = saved["cast"][0]["id"].as_str().unwrap().to_string();
    assert!(!id.is_empty());
    let estimate = server
        .get(&format!("{project}/estimate"), &owner)
        .await
        .json();
    assert_eq!(estimate["voiceChangerSeconds"], 4.0);
    assert_eq!(estimate["cast"][0]["id"], id.as_str());
    assert_eq!(estimate["cast"][0]["credits"], 67);

    // The copy replaces that stretch with the clip that was tried.
    let started = server
        .send_json(
            "POST",
            &format!("{project}/render"),
            &owner,
            serde_json::json!({ "acknowledgeCost": true }),
        )
        .await;
    assert_eq!(started.status, StatusCode::OK, "{}", started.text());
    let made = wait_for_run(&server, &owner, &book).await;
    assert_eq!(made["copies"].as_array().unwrap().len(), 1, "{made}");
    assert_eq!(calls.voice_changes.load(Ordering::SeqCst), 2);

    // A second inside the stretch kept as it is comes out of what is replaced.
    let mut kept = member(inside, &voice);
    kept["edits"] = serde_json::json!([
        { "kind": "keep", "chapter": 0, "startSeconds": start + 5.0, "endSeconds": start + 6.0 },
    ]);
    let saved = server
        .send_json("PUT", &format!("{project}/plan"), &owner, kept)
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.text());
    let estimate = server
        .get(&format!("{project}/estimate"), &owner)
        .await
        .json();
    assert_eq!(estimate["voiceChangerSeconds"], 3.0);
}

#[tokio::test]
async fn a_long_chapter_is_changed_in_parts_and_keeps_its_length() {
    if faststart::discover_tools(None, None).is_none() {
        eprintln!("skipped: this test cuts and writes real audio, which needs ffmpeg");
        return;
    }
    let server = TestServer::start(1).await;
    let owner = server.setup_owner().await;
    // Five and a half minutes, more than one voice changer request takes.
    std::fs::write(
        server.library_root.join("Book 00").join("01 Track.wav"),
        silent_wav(330),
    )
    .unwrap();
    rescan_library(&server.state).await.unwrap();
    let (book, _) = server.first_book_and_track(&owner).await;
    let (base, calls) = fake_elevenlabs().await;
    crate::voice_replacement::enable_for_test(&server.state, &base).await;
    let project = format!("/api/books/{book}/voice-replacement");
    let voice = serde_json::json!({ "voiceId": "voiceA", "name": "Alder" });

    // The second chapter is read afresh from its transcript.
    server
        .send_json(
            "POST",
            &format!("{project}/analysis"),
            &owner,
            serde_json::json!({ "chapters": [1] }),
        )
        .await;
    wait_for_run(&server, &owner, &book).await;
    let read = serde_json::json!({ "kind": "chapter", "chapter": 1, "method": "readText", "voice": voice });
    // The first has no transcript, so it cannot be read, only revoiced.
    let unread = server
        .send_json(
            "POST",
            &format!("{project}/preview"),
            &owner,
            serde_json::json!({ "kind": "chapter", "chapter": 0, "method": "readText", "voice": voice }),
        )
        .await;
    assert_eq!(unread.status, StatusCode::BAD_REQUEST, "{}", unread.text());
    let plan = serde_json::json!({ "edits": [
        { "kind": "chapter", "chapter": 0, "method": "keepPerformance", "voice": voice },
        read,
    ] });
    let saved = server
        .send_json("PUT", &format!("{project}/plan"), &owner, plan)
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.text());
    let estimate = server
        .get(&format!("{project}/estimate"), &owner)
        .await
        .json();
    assert_eq!(estimate["voiceChangerSeconds"], 330.0);
    assert_eq!(
        estimate["speechCharacters"],
        "First narrator. Second narrator.".len()
    );
    assert_eq!(estimate["credits"], 5_500 + 32);

    server
        .send_json(
            "POST",
            &format!("{project}/render"),
            &owner,
            serde_json::json!({ "acknowledgeCost": true }),
        )
        .await;
    let made = wait_for_run(&server, &owner, &book).await;
    // Two requests for the long chapter, each under the limit, and one
    // reading for the short one.
    assert_eq!(calls.voice_changes.load(Ordering::SeqCst), 2);
    assert_eq!(
        *calls.spoken.lock().unwrap(),
        ["First narrator. Second narrator."]
    );
    let copy_id = made["copies"][0]["bookId"]
        .as_str()
        .expect("the copy is in the library");
    let copy = server
        .get(&format!("/api/books/{copy_id}"), &owner)
        .await
        .json();
    let lengths: Vec<f64> = copy["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|track| track["durationSeconds"].as_f64().unwrap())
        .collect();
    // A changed voice keeps the chapter's length; a fresh reading runs as
    // long as its two-second clip.
    assert!((lengths[0] - 330.0).abs() < 0.2, "{lengths:?}");
    assert!((lengths[1] - 2.0).abs() < 0.2, "{lengths:?}");
}
