use super::*;

const ROUTE: &str = "/api/experimental-features/readalong-sync/cloud-recognition";

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
