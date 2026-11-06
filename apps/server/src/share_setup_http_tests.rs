use super::*;

const ROUTE: &str = "/api/admin/shares/config";

#[tokio::test]
async fn unobserved_creation_result_revokes_the_persisted_invitation() {
    let server = TestServer::start(1).await;
    let owner = server.setup_owner().await;
    let book = server.state.library.read().await.books[0].clone();
    let track = &book.tracks[0];
    let path = server.state.library.read().await.track_paths[&track.id].clone();
    let size = std::fs::metadata(path).unwrap().len();
    let created = server.send_json("POST", "/api/shares", &owner, serde_json::json!({"manifest":{"version":1,"bookId":book.id,"title":book.title,"senderDisplayName":"Owner","assets":[{"id":track.id,"kind":"audio","fileName":track.file_name,"sizeBytes":size,"sha256":"a".repeat(64)}],"totalBytes":size}})).await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let token = created.json()["token"].as_str().unwrap().to_string();
    let auth = AuthUser::from(&server.state.users.read().await.users[0]);
    crate::share_setup::abandon_handoff_for_test(server.state.clone(), auth, token.clone());
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if server
                .get(&format!("/api/shares/{token}/preview"), "")
                .await
                .status
                == StatusCode::NOT_FOUND
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let stored = server
        .state
        .database
        .call(|db| read_document(db, crate::share::SHARE_INVITATIONS_DOCUMENT))
        .await
        .unwrap()
        .unwrap();
    let invitations: serde_json::Value = serde_json::from_str(&stored).unwrap();
    assert_eq!(invitations[0]["revoked"], true);
}

async fn put(
    server: &TestServer,
    token: &str,
    body: serde_json::Value,
    https: bool,
) -> TestResponse {
    let mut request = Request::builder()
        .method("PUT")
        .uri(ROUTE)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json");
    if https {
        request = request.header("x-forwarded-proto", "https");
    }
    server
        .send(request.body(Body::from(body.to_string())).unwrap())
        .await
}

#[tokio::test]
async fn owner_gift_configuration_is_private_persistent_and_never_enables_sharing() {
    let mut server = TestServer::start(0).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "gift-config-reader").await;
    let secret = "owner-supplied-test-secret-0123456789";
    let turn_secret = "owner-turn-rest-secret-0123456789012345";
    let input = serde_json::json!({"brokerOrigin":"https://broker.example","ownerSecret":secret,"allowReaders":false,"ownerControlsBroker":true,
        "connectivity":{"relayAllowed":true,"requireRelay":false,"iceServers":[{"urls":["turn:relay.example:3478?transport=udp"],"turnRestSecret":turn_secret}]}});
    assert_eq!(
        server.get(ROUTE, &reader).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        put(&server, &reader, input.clone(), true).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        put(&server, &owner, input.clone(), true).await.status,
        StatusCode::BAD_REQUEST,
        "a forwarded header alone cannot authorize a LAN/local transport"
    );
    server.state.deployment_mode = DeploymentMode::Proxy;
    server.router = build_router(server.state.clone(), None, &[]).unwrap();
    assert_eq!(
        put(&server, &owner, input.clone(), false).await.status,
        StatusCode::BAD_REQUEST
    );
    let saved = put(&server, &owner, input, true).await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.text());
    assert_eq!(saved.json()["configured"], true);
    assert_eq!(saved.json()["productionEnabled"], false);
    assert!(!saved.text().contains(secret));
    assert!(!saved.text().contains(turn_secret));
    assert_eq!(
        saved.json()["connectivity"]["iceServers"][0]["turnRestSecretConfigured"],
        true
    );
    server.router = build_router(server.state.clone(), None, &[]).unwrap();
    let restored = server.get(ROUTE, &owner).await;
    assert_eq!(restored.json()["brokerOrigin"], "https://broker.example");
    assert_eq!(restored.json()["ownerSecretConfigured"], true);
    assert!(!restored.text().contains(secret));
    assert!(!restored.text().contains(turn_secret));
    let changed_origin = put(&server, &owner, serde_json::json!({"brokerOrigin":"https://another-broker.example","ownerControlsBroker":true}), true).await;
    assert_eq!(
        changed_origin.status,
        StatusCode::BAD_REQUEST,
        "an omitted secret must never migrate to a different broker"
    );
    assert_eq!(
        server.get(ROUTE, &owner).await.json()["brokerOrigin"],
        "https://broker.example"
    );
    let retained = put(&server, &owner, serde_json::json!({"brokerOrigin":"https://broker.example","allowReaders":true,"ownerControlsBroker":true}), true).await;
    assert_eq!(retained.status, StatusCode::OK);
    assert_eq!(retained.json()["allowReaders"], true);
    let private = server
        .state
        .database
        .call(|db| read_document(db, "share-owner-configuration-v1"))
        .await
        .unwrap()
        .unwrap();
    assert!(
        private.contains(secret),
        "only the private server store retains the supplied secret"
    );
    assert!(
        private.contains(turn_secret),
        "omitting connectivity retains the private relay secret"
    );
    assert_eq!(
        server
            .send_json("DELETE", ROUTE, &reader, serde_json::Value::Null)
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        server
            .send_json("DELETE", ROUTE, &owner, serde_json::Value::Null)
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(server.get(ROUTE, &owner).await.json()["configured"], false);
}

#[tokio::test]
async fn pending_room_recovery_prevents_setup_replacement_and_removal() {
    let mut server = TestServer::start(0).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "gift-cleanup-reader").await;
    let route = "/api/admin/shares/config/cleanup";
    assert_eq!(
        server
            .send_json("POST", route, &reader, serde_json::Value::Null)
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        server
            .send_json("POST", route, &owner, serde_json::Value::Null)
            .await
            .status,
        StatusCode::SERVICE_UNAVAILABLE
    );
    server.state.deployment_mode = DeploymentMode::Proxy;
    server.router = build_router(server.state.clone(), None, &[]).unwrap();
    let input = serde_json::json!({"brokerOrigin":"https://broker.example","ownerSecret":"retained-owner-secret-0123456789012345","ownerControlsBroker":true});
    assert_eq!(
        put(&server, &owner, input.clone(), true).await.status,
        StatusCode::OK
    );
    let pending = serde_json::json!([{"tokenDigest":"pending-test-record","senderUserId":"sender","createdAt":1,"expiresAt":2,"revoked":true,
        "manifest":{"version":1,"bookId":"fixture-book","title":"Fixture","senderDisplayName":"Sender","assets":[],"totalBytes":0},
        "brokerRooms":[{"origin":"https://broker.example","room":"room____________","expiresAt":2,"reservationVersion":1,"cleanupPending":true}]}]).to_string();
    server
        .state
        .database
        .transaction(move |db| {
            write_document(db, crate::share::SHARE_INVITATIONS_DOCUMENT, &pending)
        })
        .await
        .unwrap();
    assert_eq!(
        put(&server, &owner, input, true).await.status,
        StatusCode::CONFLICT,
        "even expired rooms need confirmed cleanup before replacing their owner credentials"
    );
    assert_eq!(
        server
            .send_json("DELETE", ROUTE, &owner, serde_json::Value::Null)
            .await
            .status,
        StatusCode::CONFLICT
    );
    assert_eq!(server.get(ROUTE, &owner).await.json()["configured"], true);
}

#[tokio::test]
async fn invalid_gift_setup_never_reflects_or_overwrites_credentials() {
    let mut server = TestServer::start(0).await;
    let owner = server.setup_owner().await;
    server.state.deployment_mode = DeploymentMode::Proxy;
    server.router = build_router(server.state.clone(), None, &[]).unwrap();
    let secret = "do-not-reflect-this-private-token-1234";
    let malformed = put(&server, &owner, serde_json::json!({"brokerOrigin":"https://broker.example","ownerSecret":secret,"ownerControlsBroker":true,"connectivity":secret}), true).await;
    assert_eq!(malformed.status, StatusCode::BAD_REQUEST);
    assert!(
        !malformed.text().contains(secret),
        "JSON rejection must not quote a misplaced credential"
    );
    for origin in [
        "http://broker.example",
        "https://user:private@broker.example",
        "https://broker.example/path",
        "https://broker.example/#private",
    ] {
        let result = put(&server, &owner, serde_json::json!({"brokerOrigin":origin,"ownerSecret":secret,"allowReaders":false,"ownerControlsBroker":true}), true).await;
        assert_eq!(result.status, StatusCode::BAD_REQUEST);
        assert!(!result.text().contains(secret));
        assert!(!result.text().contains("user:private"));
    }
    for secret in ["short", "bad\nsecret-owner-123456789012345678901234"] {
        let result = put(&server, &owner, serde_json::json!({"brokerOrigin":"https://broker.example","ownerSecret":secret,"ownerControlsBroker":true}), true).await;
        assert_eq!(result.status, StatusCode::BAD_REQUEST);
        assert!(!result.text().contains(secret));
    }
    assert_eq!(server.get(ROUTE, &owner).await.json()["configured"], false);
    server
        .state
        .database
        .transaction(|db| {
            write_document(db, "share-owner-configuration-v1", "corrupt private record")
        })
        .await
        .unwrap();
    let corrupt = server.get(ROUTE, &owner).await;
    assert_eq!(corrupt.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(!corrupt.text().contains("corrupt private record"));
}
