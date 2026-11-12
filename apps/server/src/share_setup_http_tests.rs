use super::*;

const ROUTE: &str = "/api/admin/shares/config";

#[tokio::test]
async fn sender_retention_is_owner_opt_in_and_recovery_is_an_explicit_gated_action() {
    let mut server = TestServer::start(0).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "recovery-reader").await;
    server.state.deployment_mode = DeploymentMode::Proxy;
    server.router = build_router(server.state.clone(), None, &[]).unwrap();
    let recover = "/api/admin/shares/config/recover";
    let abandon = "/api/admin/shares/config/abandon";
    assert_eq!(
        server
            .send_json("POST", recover, &reader, serde_json::json!({}))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        server
            .send_json(
                "POST",
                abandon,
                &reader,
                serde_json::json!({"confirmAbandon":true})
            )
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        server
            .send_json(
                "POST",
                abandon,
                &owner,
                serde_json::json!({"confirmAbandon":false})
            )
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    let input = serde_json::json!({"brokerOrigin":"https://broker.example","ownerSecret":"owner-supplied-retention-secret-0123456789","ownerControlsBroker":true});
    let saved = put(&server, &owner, input, true).await;
    assert_eq!(saved.status, StatusCode::OK);
    assert_eq!(saved.json()["retainSenderState"], false);
    assert_eq!(saved.json()["autoRecoverSenders"], false);
    let invalid_auto = put(&server, &owner, serde_json::json!({"brokerOrigin":"https://broker.example","autoRecoverSenders":true,"ownerControlsBroker":true}), true).await;
    assert_eq!(invalid_auto.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        server
            .send_json("POST", recover, &owner, serde_json::json!({}))
            .await
            .status,
        StatusCode::CONFLICT
    );
    let enabled = put(&server, &owner, serde_json::json!({"brokerOrigin":"https://broker.example","retainSenderState":true,"ownerControlsBroker":true}), true).await;
    assert_eq!(enabled.status, StatusCode::OK);
    assert_eq!(enabled.json()["retainSenderState"], true);
    assert_eq!(enabled.json()["productionEnabled"], false);
    assert!(!enabled.text().contains("owner-supplied-retention-secret"));
    // Empty retained state is inspected locally without a provider request.
    let report = server
        .send_json("POST", recover, &owner, serde_json::json!({}))
        .await;
    assert_eq!(report.status, StatusCode::OK, "{}", report.text());
    assert_eq!(
        report.json(),
        serde_json::json!({"recovered":0,"alreadyActive":0,"pending":0})
    );
    let cleared = server
        .send_json(
            "POST",
            abandon,
            &owner,
            serde_json::json!({"confirmAbandon":true}),
        )
        .await;
    assert_eq!(cleared.status, StatusCode::OK, "{}", cleared.text());
    assert_eq!(
        cleared.json(),
        serde_json::json!({"abandoned":0,"completed":0,"pending":0})
    );
    let retained = put(
        &server,
        &owner,
        serde_json::json!({"brokerOrigin":"https://broker.example","ownerControlsBroker":true}),
        true,
    )
    .await;
    assert_eq!(
        retained.json()["retainSenderState"],
        true,
        "old clients must not clear retention by omission"
    );
    let automatic = put(&server, &owner, serde_json::json!({"brokerOrigin":"https://broker.example","autoRecoverSenders":true,"ownerControlsBroker":true}), true).await;
    assert_eq!(automatic.status, StatusCode::OK);
    assert_eq!(automatic.json()["autoRecoverSenders"], true);
    let preserve = put(
        &server,
        &owner,
        serde_json::json!({"brokerOrigin":"https://broker.example","ownerControlsBroker":true}),
        true,
    )
    .await;
    assert_eq!(preserve.json()["autoRecoverSenders"], true);
    let dependency = put(&server, &owner, serde_json::json!({"brokerOrigin":"https://broker.example","retainSenderState":false,"ownerControlsBroker":true}), true).await;
    assert_eq!(dependency.status, StatusCode::BAD_REQUEST);
    let disabled = put(&server, &owner, serde_json::json!({"brokerOrigin":"https://broker.example","retainSenderState":false,"autoRecoverSenders":false,"ownerControlsBroker":true}), true).await;
    assert_eq!(disabled.json()["retainSenderState"], false);
}

#[tokio::test]
async fn boot_recovery_never_contacts_a_broker_without_gate_optin_and_ready_library()
-> anyhow::Result<()> {
    let server = TestServer::start(0).await;
    let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = count.clone();
    let router = Router::new().fallback(move || {
        let count = counter.clone();
        async move {
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            StatusCode::SERVICE_UNAVAILABLE
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let provider = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    struct AbortOnDrop(tokio::task::JoinHandle<()>);
    impl Drop for AbortOnDrop {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    let _provider = AbortOnDrop(provider);
    for auto in [false, true] {
        let payload = serde_json::json!({"version":1,"brokerOrigin":origin,"ownerSecret":"only-local-test-owner-secret-1234567890","allowReaders":false,"retainSenderState":true,"autoRecoverSenders":auto,"connectivity":{}}).to_string();
        server
            .state
            .database
            .transaction(move |db| write_document(db, "share-owner-configuration-v1", &payload))
            .await
            .unwrap();
        assert!(crate::share_setup::start_boot_recovery(server.state.clone(), false).is_none());
        if auto {
            server.state.library.write().await.catalogue_ready = false;
        }
        let task = crate::share_setup::start_boot_recovery(server.state.clone(), true).unwrap();
        if auto {
            let _ = server.state.shutdown.send(());
        }
        tokio::time::timeout(Duration::from_secs(3), task).await??;
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 0);
    }
    Ok(())
}

#[tokio::test]
async fn startup_recovery_shutdown_does_not_wait_for_a_stalled_configuration_database() {
    let fixture = TestServer::start(0).await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let notified = entered.clone();
    let (release, held) = std::sync::mpsc::channel();
    let database = fixture.state.database.clone();
    let blocker = tokio::spawn(async move {
        database
            .call(move |_| {
                notified.notify_one();
                held.recv().unwrap();
                Ok(())
            })
            .await
    });
    entered.notified().await;
    let task = crate::share_setup::start_boot_recovery(fixture.state.clone(), true).unwrap();
    let _ = fixture.state.shutdown.send(());
    let result = tokio::time::timeout(Duration::from_secs(3), task).await;
    // Always release the fixture's worker, even when the assertion fails.
    release.send(()).unwrap();
    blocker.await.unwrap().unwrap();
    assert!(
        result.is_ok(),
        "startup shutdown waited for the unrelated database worker"
    );
    result.unwrap().unwrap();
}

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

#[tokio::test]
async fn book_gifts_stay_off_until_the_owner_turns_them_on() {
    let server = TestServer::start(1).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "gift-reader").await;
    let (book, _) = server.first_book_and_track(&owner).await;
    let switch = "/api/experimental-features/book-gifts";
    let inventory = format!("/api/books/{book}/gift-inventory");
    // A new server has no saved switch at all.
    server
        .state
        .database
        .transaction(|db| {
            db.execute(
                "DELETE FROM documents WHERE name = 'book-gifts-experiment-v1'",
                [],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    assert!(!crate::share_setup::experiment_enabled(&server.state).await);
    assert_eq!(
        server.get(switch, &reader).await.json(),
        serde_json::json!({"enabled":false,"configured":false,"canSend":false})
    );
    for (method, path) in [
        ("GET", inventory.as_str()),
        ("GET", ROUTE),
        ("POST", "/api/shares/selected"),
        ("POST", "/api/admin/shares/config/recover"),
        ("DELETE", "/api/shares/0123456789abcdef0123456789abcdef"),
    ] {
        let response = server
            .send_json(method, path, &owner, serde_json::json!({}))
            .await;
        assert_eq!(response.status, StatusCode::NOT_FOUND, "{method} {path}");
    }

    let enable = serde_json::json!({"enabled":true});
    assert_eq!(
        server
            .send_json("PUT", &format!("{switch}/enabled"), &reader, enable.clone())
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let on = server
        .send_json("PUT", &format!("{switch}/enabled"), &owner, enable)
        .await;
    assert_eq!(on.status, StatusCode::OK);
    // On, but nobody can send until the owner saves a broker.
    assert_eq!(
        on.json(),
        serde_json::json!({"enabled":true,"configured":false,"canSend":false})
    );
    assert_eq!(server.get(&inventory, &owner).await.status, StatusCode::OK);
    assert_eq!(server.get(ROUTE, &owner).await.status, StatusCode::OK);

    let off = server
        .send_json(
            "PUT",
            &format!("{switch}/enabled"),
            &owner,
            serde_json::json!({"enabled":false}),
        )
        .await;
    assert_eq!(off.json()["enabled"], false);
    assert_eq!(
        server.get(&inventory, &owner).await.status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn book_gift_senders_are_the_owner_and_readers_the_owner_allowed() {
    let mut server = TestServer::start(0).await;
    let owner = server.setup_owner().await;
    let reader = server.add_reader(&owner, "gift-reader").await;
    server.state.deployment_mode = DeploymentMode::Proxy;
    server.router = build_router(server.state.clone(), None, &[]).unwrap();
    let switch = "/api/experimental-features/book-gifts";
    let broker = |allow: bool| serde_json::json!({"brokerOrigin":"https://broker.example","ownerSecret":"owner-supplied-status-secret-0123456789","allowReaders":allow,"ownerControlsBroker":true});
    assert_eq!(
        put(&server, &owner, broker(false), true).await.status,
        StatusCode::OK
    );
    assert_eq!(
        server.get(switch, &owner).await.json(),
        serde_json::json!({"enabled":true,"configured":true,"canSend":true})
    );
    assert_eq!(server.get(switch, &reader).await.json()["canSend"], false);
    assert_eq!(
        put(&server, &owner, broker(true), true).await.status,
        StatusCode::OK
    );
    assert_eq!(server.get(switch, &reader).await.json()["canSend"], true);
}

#[tokio::test]
async fn turning_gifts_off_stops_startup_recovery_and_requests_already_admitted() {
    let server = TestServer::start(1).await;
    let owner = server.setup_owner().await;
    let payload = serde_json::json!({"version":1,"brokerOrigin":"https://broker.example","ownerSecret":"only-local-test-owner-secret-1234567890","allowReaders":false,"retainSenderState":true,"autoRecoverSenders":true,"connectivity":{}}).to_string();
    server
        .state
        .database
        .transaction(move |db| write_document(db, "share-owner-configuration-v1", &payload))
        .await
        .unwrap();
    // The switch was on when the server booted and is turned off before the
    // next recovery pass. A pass that still ran would wait 30 seconds for
    // another, so finishing at once shows the loop stopped.
    let off = server
        .send_json(
            "PUT",
            "/api/experimental-features/book-gifts/enabled",
            &owner,
            serde_json::json!({"enabled":false}),
        )
        .await;
    assert_eq!(off.status, StatusCode::OK);
    let task = crate::share_setup::start_boot_recovery(server.state.clone(), true).unwrap();
    tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap();

    // A request that passed the route guard before the switch changed.
    let auth = AuthUser::from(server.state.users.read().await.users.first().unwrap());
    let (book, _) = server.first_book_and_track(&owner).await;
    let input: crate::share::CreateSelectedShareRequest =
        serde_json::from_value(serde_json::json!({"bookId":book,"selectedAssetIds":["anything"]}))
            .unwrap();
    let created = crate::share_setup::create_configured_share(
        State(server.state.clone()),
        Extension(auth.clone()),
        Json(input),
    )
    .await;
    assert!(matches!(created, Err(error) if error.status == StatusCode::NOT_FOUND));
    let recovered = crate::share_setup::recover_configured_senders(
        State(server.state.clone()),
        Extension(auth.clone()),
    )
    .await;
    assert!(matches!(recovered, Err(error) if error.status == StatusCode::NOT_FOUND));
    // Broker cleanup and abandonment wait on the same gate.
    let cleanup = crate::share_setup::retry_configured_cleanup(
        State(server.state.clone()),
        Extension(auth.clone()),
    )
    .await;
    assert!(matches!(cleanup, Err(error) if error.status == StatusCode::NOT_FOUND));
    let abandoned = crate::share_setup::abandon_configured_senders(
        State(server.state.clone()),
        Extension(auth),
        Ok(Json(
            serde_json::from_value(serde_json::json!({"confirmAbandon":true})).unwrap(),
        )),
    )
    .await;
    assert!(matches!(abandoned, Err(error) if error.status == StatusCode::NOT_FOUND));
}
