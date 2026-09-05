//! Opt-in measurements through the same router and SQLite fixture as HTTP tests.
//! Run in release mode, serially. Timing is reported, never a flaky pass/fail gate.
use super::*;
use std::time::Instant;

#[tokio::test]
#[ignore = "performance baseline; run with npm run test:perf:server"]
async fn library_performance_baseline() {
    let count = std::env::var("PERF_BOOKS")
        .map(|value| {
            value
                .parse::<usize>()
                .expect("PERF_BOOKS must be an integer")
        })
        .unwrap_or(200);
    assert!(
        (20..=10_000).contains(&count),
        "PERF_BOOKS must be 20..10000"
    );
    let server = TestServer::start(count).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "perf-reader").await;
    let reader_id = server.get("/api/auth/me", &reader).await.json()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let full = server.get("/api/books", &owner).await;
    assert_eq!(full.status, StatusCode::OK);
    let books = full.json();
    let allowed = books[0]["id"].as_str().unwrap();
    let track = books[0]["tracks"][0]["id"].as_str().unwrap();
    let grant = server
        .send_json(
            "PUT",
            &format!("/api/users/{reader_id}/book-access"),
            &owner,
            serde_json::json!({"allowedBookIds": [allowed]}),
        )
        .await;
    assert_eq!(grant.status, StatusCode::OK);
    let mut measurements = Vec::new();
    for (name, token, uri, expected_count, conditional) in [
        ("full", &owner, "/api/books", count, false),
        ("restricted", &reader, "/api/books", 1, false),
        ("page", &owner, "/api/books?limit=10", 10, false),
        ("unchanged", &owner, "/api/books", count, true),
    ] {
        let first = server.get(uri, token).await;
        assert_eq!(first.json().as_array().unwrap().len(), expected_count);
        // Fixed byte-level ETag contract, including the pagination suffix.
        let mut hash_input = first.body.clone();
        if let Some(cursor) = first.headers.get("x-next-cursor") {
            hash_input.extend_from_slice(b"\nnext:");
            hash_input.extend_from_slice(cursor.as_bytes());
        } else {
            hash_input.extend_from_slice(b"\nend");
        }
        let etag = first.header(header::ETAG);
        assert_eq!(etag, bytes_etag(&hash_input));
        let mut samples = Vec::new();
        for iteration in 0..25 {
            let mut request = Request::builder()
                .uri(uri)
                .header(header::AUTHORIZATION, format!("Bearer {token}"));
            if conditional {
                request = request.header(header::IF_NONE_MATCH, &etag);
            }
            let start = Instant::now();
            let response = server.send(request.body(Body::empty()).unwrap()).await;
            let elapsed = start.elapsed().as_secs_f64() * 1000.0;
            if conditional {
                assert_eq!(response.status, StatusCode::NOT_MODIFIED);
                assert!(response.body.is_empty());
            } else {
                assert_eq!(response.status, StatusCode::OK);
                assert_eq!(response.body, first.body);
            }
            if iteration >= 5 {
                samples.push(elapsed);
            }
        }
        samples.sort_by(f64::total_cmp);
        measurements.push(serde_json::json!({"scenario": name, "samplesMs": samples,
            "medianMs": (samples[9] + samples[10]) / 2.0, "p95Ms": samples[18], "responseBytes": first.body.len()}));
    }
    // A future cache optimization must still invalidate on real writes.
    let before = server.get("/api/books", &reader).await.header(header::ETAG);
    save_position(&server, &reader, allowed, track, 5.0, serde_json::json!({})).await;
    let after = server.get("/api/books", &reader).await;
    assert_ne!(before, after.header(header::ETAG));
    assert_eq!(after.json()[0]["progress"]["bookPositionSeconds"], 5.0);
    assert_eq!(after.json()[0]["id"], allowed);
    let result = serde_json::json!({"schema": 1, "books": count, "measurements": measurements});
    if let Ok(path) = std::env::var("PERF_SERVER_OUTPUT") {
        std::fs::write(path, serde_json::to_vec_pretty(&result).unwrap()).unwrap();
    }
    println!("PERF_RESULT {result}");
}
