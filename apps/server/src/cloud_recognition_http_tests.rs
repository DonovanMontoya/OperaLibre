use super::*;

const ROUTE: &str = "/api/experimental-features/readalong-sync/cloud-recognition";
const GPU: &str = "/api/experimental-features/readalong-sync/gpu";

#[tokio::test]
async fn the_graphics_card_is_an_owner_switch_that_waits_for_the_sync_queue() {
    let server = TestServer::start(0).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "gpu-reader").await;
    let on = serde_json::json!({"enabled": true});
    assert_eq!(server.get(GPU, &owner).await.json()["enabled"], false);
    assert_eq!(server.get(GPU, &reader).await.status, StatusCode::FORBIDDEN);
    assert_eq!(
        server
            .send_json("PUT", GPU, &reader, on.clone())
            .await
            .status,
        StatusCode::FORBIDDEN
    );

    // A queued or running book holds the lifecycle, and keeps its model.
    let syncing = server
        .state
        .update_manager
        .sync_lifecycle
        .clone()
        .read_owned()
        .await;
    let refused = server.send_json("PUT", GPU, &owner, on.clone()).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST);
    assert!(refused.text().contains("sync jobs"), "{}", refused.text());
    assert!(!server.state.update_manager.recognition_gpu().await);
    drop(syncing);

    let saved = server.send_json("PUT", GPU, &owner, on).await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.text());
    assert_eq!(saved.json()["enabled"], true);
    // No add-on is installed beside the test binary, so there is no card to offer.
    assert_eq!(saved.json()["supported"], false);
    assert_eq!(server.get(GPU, &owner).await.json()["enabled"], true);
    // What the next book's plan reads.
    assert!(server.state.update_manager.recognition_gpu().await);

    let off = serde_json::json!({"enabled": false});
    assert_eq!(
        server.send_json("PUT", GPU, &owner, off).await.json()["enabled"],
        false
    );
    assert!(!server.state.update_manager.recognition_gpu().await);
}

#[tokio::test]
async fn openai_transcription_is_owner_opt_in_behind_a_privacy_confirmation() {
    let server = TestServer::start(0).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "cloud-reader").await;
    let off = serde_json::json!({"enabled":false});
    assert_eq!(server.get(ROUTE, &owner).await.json(), off);
    assert!(
        crate::cloud_recognition::configured(&server.state)
            .await
            .is_none()
    );
    assert_eq!(
        server.get(ROUTE, &reader).await.status,
        StatusCode::FORBIDDEN
    );

    let key = "sk-test-0123456789";
    let confirmed = serde_json::json!({"apiKey": key, "acknowledgePrivacy": true});
    assert_eq!(
        server
            .send_json("PUT", ROUTE, &reader, confirmed.clone())
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    // Without the confirmation nothing is saved.
    let unconfirmed = server
        .send_json("PUT", ROUTE, &owner, serde_json::json!({"apiKey": key}))
        .await;
    assert_eq!(unconfirmed.status, StatusCode::BAD_REQUEST);
    assert!(unconfirmed.text().contains("sent to OpenAI"));
    let blank = server
        .send_json(
            "PUT",
            ROUTE,
            &owner,
            serde_json::json!({"apiKey": "  ", "acknowledgePrivacy": true}),
        )
        .await;
    assert_eq!(blank.status, StatusCode::BAD_REQUEST);
    assert_eq!(server.get(ROUTE, &owner).await.json(), off);

    let on = server.send_json("PUT", ROUTE, &owner, confirmed).await;
    assert_eq!(on.status, StatusCode::OK);
    assert_eq!(on.json(), serde_json::json!({"enabled":true}));
    assert!(!on.text().contains(key));
    assert!(!server.get(ROUTE, &owner).await.text().contains(key));
    assert!(
        crate::cloud_recognition::configured(&server.state)
            .await
            .is_some()
    );

    let removed = server
        .send_json("DELETE", ROUTE, &owner, serde_json::json!({}))
        .await;
    assert_eq!(removed.json(), off);
    assert!(!crate::cloud_recognition::still_enabled(&server.state).await);
    // The key is gone, not just switched off.
    let stored = server
        .state
        .database
        .call(|db| read_document(db, "readalong-cloud-recognition-v1"))
        .await
        .unwrap();
    assert!(stored.is_none());
}
