use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

const STATUS: &str = "/api/experimental-features/chapter-notes";
const PROVIDER: &str = "/api/experimental-features/chapter-notes/provider";

async fn enable(server: &TestServer, owner: &str) {
    let enabled = server
        .send_json(
            "PUT",
            &format!("{STATUS}/enabled"),
            owner,
            serde_json::json!({ "enabled": true }),
        )
        .await;
    assert_eq!(enabled.status, StatusCode::OK, "{}", enabled.text());
}

/// An OpenAI-compatible endpoint that writes a note naming the chapter it
/// was given, and counts how often it was asked.
async fn fake_model_endpoint() -> (String, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |Json(body): Json<serde_json::Value>| {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                let prompt = body["messages"][1]["content"].as_str().unwrap().to_string();
                let heading = prompt.lines().nth(1).unwrap().to_string();
                let text = prompt
                    .split("<chapter_text>\n")
                    .nth(1)
                    .and_then(|rest| rest.split("\n</chapter_text>").next())
                    .unwrap()
                    .to_string();
                let note = serde_json::json!({
                    "synopsis": format!("Before {heading}"),
                    "summary": format!("All of {heading}: {text}"),
                    "people": ["Ana: the pilot"],
                    "terms": [],
                });
                Json(serde_json::json!({
                    "choices": [{ "message": { "content": note.to_string() } }],
                }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}/v1"), calls)
}

async fn generate_and_wait(server: &TestServer, owner: &str, book: &str) -> serde_json::Value {
    let route = format!("/api/books/{book}/chapter-notes");
    let started = server
        .send_json("POST", &route, owner, serde_json::json!({}))
        .await;
    assert_eq!(started.status, StatusCode::OK, "{}", started.text());
    loop {
        let notes = server.get(&route, owner).await.json();
        match notes["generation"]["state"].as_str() {
            None => return notes,
            Some("failed") => panic!("generation failed: {notes}"),
            Some(_) => tokio::time::sleep(Duration::from_millis(20)).await,
        }
    }
}

/// Two minute-long tracks, which are the book's two chapters.
fn two_chapter_book(server: &TestServer) {
    for track in ["01 Track.wav", "02 Track.wav"] {
        std::fs::write(
            server.library_root.join("Book 00").join(track),
            silent_wav(60),
        )
        .unwrap();
    }
}

async fn set_position(server: &TestServer, owner: &str, book: &str, track: &str, seconds: f64) {
    let saved = server
        .send_json(
            "PUT",
            &format!("/api/books/{book}/progress"),
            owner,
            serde_json::json!({ "trackId": track, "positionSeconds": seconds - 60.0, "bookPositionSeconds": seconds }),
        )
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.text());
}

#[tokio::test]
async fn only_the_owner_sets_up_chapter_notes_and_the_key_never_comes_back() {
    let server = TestServer::start(1).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "notes-reader").await;
    let (book, _) = server.first_book_and_track(&owner).await;

    let off = server
        .get(&format!("/api/books/{book}/chapter-notes"), &owner)
        .await;
    assert_eq!(off.status, StatusCode::NOT_FOUND);
    let refused = server
        .send_json(
            "PUT",
            &format!("{STATUS}/enabled"),
            &reader,
            serde_json::json!({ "enabled": true }),
        )
        .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN);
    enable(&server, &owner).await;

    let no_key = server
        .send_json(
            "PUT",
            PROVIDER,
            &owner,
            serde_json::json!({ "kind": "anthropic" }),
        )
        .await;
    assert_eq!(no_key.status, StatusCode::BAD_REQUEST, "{}", no_key.text());
    let bad_url = server
        .send_json(
            "PUT",
            PROVIDER,
            &owner,
            serde_json::json!({ "kind": "openAiCompatible", "model": "llama", "baseUrl": "file:///etc" }),
        )
        .await;
    assert_eq!(bad_url.status, StatusCode::BAD_REQUEST);
    let saved = server
        .send_json(
            "PUT",
            PROVIDER,
            &owner,
            serde_json::json!({ "kind": "anthropic", "apiKey": "sk-ant-secret" }),
        )
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.text());
    let status = saved.json();
    assert_eq!(
        status["provider"]["model"],
        chapter_notes::DEFAULT_ANTHROPIC_MODEL
    );
    assert_eq!(status["provider"]["hasApiKey"], true);
    assert!(!saved.text().contains("sk-ant-secret"));

    // Changing the model keeps the key that was already saved.
    let renamed = server
        .send_json(
            "PUT",
            PROVIDER,
            &owner,
            serde_json::json!({ "kind": "anthropic", "model": "claude-haiku-5-5" }),
        )
        .await;
    assert_eq!(renamed.status, StatusCode::OK, "{}", renamed.text());
    assert_eq!(renamed.json()["provider"]["hasApiKey"], true);

    let seen_by_reader = server.get(STATUS, &reader).await;
    assert_eq!(seen_by_reader.json()["enabled"], true);
    assert!(seen_by_reader.json()["provider"].is_null());
    assert_eq!(seen_by_reader.json()["canGenerate"], false);
    let reader_generates = server
        .send_json(
            "POST",
            &format!("/api/books/{book}/chapter-notes"),
            &reader,
            serde_json::json!({}),
        )
        .await;
    assert_eq!(reader_generates.status, StatusCode::FORBIDDEN);
    let reader_sets = server
        .send_json(
            "PUT",
            PROVIDER,
            &reader,
            serde_json::json!({ "kind": "anthropic", "apiKey": "x" }),
        )
        .await;
    assert_eq!(reader_sets.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn agents_get_notes_only_as_far_as_the_listener_has_heard() {
    let server = TestServer::start(1).await;
    let owner = server.setup_owner().await;
    two_chapter_book(&server);
    server
        .add_companions_to_first_book(
            &owner,
            &[
                (
                    "Book 00.epub",
                    alignment::build_test_epub_with_text(
                        &long_chapter_text(),
                        "<h1>Chapter 2</h1><p>The river ran fast and cold.</p>",
                    ),
                ),
                (
                    "Book 00.sync.json",
                    serde_json::to_vec(&serde_json::json!({
                        "version": alignment::SYNC_MAP_VERSION,
                        "generator": "echogarden",
                        "precision": "sentence",
                        "fragments": [
                            { "startSeconds": 0.0, "endSeconds": 3.0, "href": "a.xhtml", "text": "Ana took off." },
                            { "startSeconds": 61.0, "endSeconds": 64.0, "href": "b.xhtml", "text": "The engine died." },
                        ],
                    }))
                    .unwrap(),
                ),
            ],
        )
        .await;
    let books = server.get("/api/books", &owner).await.json();
    let book = books[0]["id"].as_str().unwrap().to_string();
    let second_track = books[0]["tracks"][1]["id"].as_str().unwrap().to_string();
    enable(&server, &owner).await;
    let (endpoint, calls) = fake_model_endpoint().await;
    let saved = server
        .send_json(
            "PUT",
            PROVIDER,
            &owner,
            serde_json::json!({ "kind": "openAiCompatible", "model": "local", "baseUrl": endpoint }),
        )
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.text());

    let notes = generate_and_wait(&server, &owner, &book).await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(notes["chapters"][1]["source"], "ebook");
    assert_eq!(
        notes["chapters"][1]["summary"],
        format!("All of {}: The engine died.", "Chapter 2 of 2: 02 Track")
    );

    let secret = create_agent(&server, &owner, &["text"]).await;
    let (failed, unstarted) = call_agent_tool(
        &server,
        &secret,
        "get_chapter_notes",
        serde_json::json!({ "bookId": book }),
    )
    .await;
    assert!(!failed, "{unstarted}");
    assert_eq!(unstarted["chapters"], serde_json::json!([]));
    assert_eq!(unstarted["chaptersAhead"], 2);

    // Into the second chapter: the first is told in full, the second only
    // by its synopsis.
    set_position(&server, &owner, &book, &second_track, 64.0).await;
    let (_, partway) = call_agent_tool(
        &server,
        &secret,
        "get_chapter_notes",
        serde_json::json!({ "bookId": book }),
    )
    .await;
    assert_eq!(partway["chapters"][0]["listener"], "heard");
    assert_eq!(
        partway["chapters"][0]["summary"],
        "All of Chapter 1 of 2: 01 Track: Ana took off."
    );
    assert_eq!(partway["chapters"][1]["listener"], "current");
    assert_eq!(
        partway["chapters"][1]["synopsis"],
        "Before Chapter 2 of 2: 02 Track"
    );
    assert!(!partway.to_string().contains("engine died"), "{partway}");

    let (_, spoiled) = call_agent_tool(
        &server,
        &secret,
        "get_chapter_notes",
        serde_json::json!({ "bookId": book, "chapter": 1, "includeSpoilers": true }),
    )
    .await;
    assert_eq!(spoiled["chapters"][0]["spoiler"], true);
    assert!(spoiled.to_string().contains("engine died"));

    // Unchanged text is not sent to the model again.
    generate_and_wait(&server, &owner, &book).await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);

    let removed = server
        .send(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/books/{book}/chapter-notes"))
                .header(header::AUTHORIZATION, format!("Bearer {owner}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(removed.status, StatusCode::NO_CONTENT, "{}", removed.text());
    let (failed, gone) = call_agent_tool(
        &server,
        &secret,
        "get_chapter_notes",
        serde_json::json!({ "bookId": book }),
    )
    .await;
    assert!(failed);
    assert!(
        gone.as_str().unwrap().contains("no chapter notes yet"),
        "{gone}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_book_without_an_ebook_is_transcribed_and_recapped_up_to_the_listener() {
    use std::os::unix::fs::PermissionsExt;
    let mut server = TestServer::start(1).await;
    let owner = server.setup_owner().await;
    two_chapter_book(&server);
    let tools = server.library_root.parent().unwrap().join("fake-tools");
    std::fs::create_dir_all(&tools).unwrap();
    // The fake ffmpeg writes where the cut starts in place of audio, and the
    // fake recognizer hears that back as two sentences.
    let ffmpeg = tools.join("ffmpeg");
    std::fs::write(
        &ffmpeg,
        "#!/bin/sh\nstart=''\nprevious=''\nfor argument in \"$@\"; do\n  [ \"$previous\" = -ss ] && start=\"$argument\"\n  previous=\"$argument\"\n  last=\"$argument\"\ndone\nprintf '%s' \"$start\" > \"$last\"\n",
    )
    .unwrap();
    let echogarden = tools.join("echogarden");
    std::fs::write(
        &echogarden,
        "#!/bin/sh\nstart=$(cat \"$2\")\nprintf '[{\"type\":\"segment\",\"text\":\"x\",\"startTime\":0,\"endTime\":50,\"timeline\":[{\"type\":\"sentence\",\"text\":\"Opened at %s.\",\"startTime\":1,\"endTime\":3},{\"type\":\"sentence\",\"text\":\"Much later.\",\"startTime\":40,\"endTime\":50}]}]' \"$start\" > \"$3\"\n",
    )
    .unwrap();
    for script in [&ffmpeg, &echogarden] {
        std::fs::set_permissions(script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    server.state.alignment_config = AlignmentConfig::Manual(echogarden.clone());
    server.state.faststart_tools = Some(faststart::Tools {
        ffmpeg,
        ffprobe: None,
    });
    server.router = build_router(server.state.clone(), None, &[]).unwrap();
    server.add_companions_to_first_book(&owner, &[]).await;
    let books = server.get("/api/books", &owner).await.json();
    let book = books[0]["id"].as_str().unwrap().to_string();
    let second_track = books[0]["tracks"][1]["id"].as_str().unwrap().to_string();
    enable(&server, &owner).await;
    assert_eq!(
        server.get(STATUS, &owner).await.json()["transcriptionAvailable"],
        true
    );

    // With no model set up, generation stops at the transcript.
    let notes = generate_and_wait(&server, &owner, &book).await;
    assert_eq!(notes["chapters"][0]["source"], "transcript");
    assert!(notes["chapters"][0]["summary"].is_null());

    let secret = create_agent(&server, &owner, &["text"]).await;
    set_position(&server, &owner, &book, &second_track, 64.0).await;
    let (failed, so_far) = call_agent_tool(
        &server,
        &secret,
        "get_text_so_far",
        serde_json::json!({ "bookId": book }),
    )
    .await;
    assert!(!failed, "{so_far}");
    assert_eq!(so_far["chapter"]["index"], 1);
    assert_eq!(so_far["chapter"]["text"], "Opened at 0.000.");
    let (_, first) = call_agent_tool(
        &server,
        &secret,
        "get_text_so_far",
        serde_json::json!({ "bookId": book, "chapter": 0 }),
    )
    .await;
    assert_eq!(first["chapter"]["text"], "Opened at 0.000. Much later.");
    let (_, listed) = call_agent_tool(
        &server,
        &secret,
        "get_chapter_notes",
        serde_json::json!({ "bookId": book }),
    )
    .await;
    assert!(
        listed["note"].as_str().unwrap().contains("get_text_so_far"),
        "{listed}"
    );
}
