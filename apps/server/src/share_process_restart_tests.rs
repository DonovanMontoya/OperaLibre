//! Real process kill/relaunch of the test server executable. The child uses
//! the real startup config/database/state/router/scanner and boot supervisor;
//! only its compile-time gift gate and loopback Worker adapter are test-only.
//! It is not a released-binary, native-device or Internet-NAT test.
use super::*;

const CHILD_TEST: &str =
    "http_tests::share_recovery_service_tests::process_restart_tests::gift_boot_process_child";

#[tokio::test]
#[ignore = "internal child for selected_sender_survives_full_process_restart"]
async fn gift_boot_process_child() -> anyhow::Result<()> {
    let mode = std::env::var("OPERALIBRE_GIFT_BOOT_CHILD_MODE")?;
    anyhow::ensure!(
        ["create", "recover"].contains(&mode.as_str()),
        "invalid child mode"
    );
    let config = ServerConfig::load()?;
    create_private_directory(&config.data_dir)?;
    create_private_directory(&config.download_temp_dir)?;
    secure_existing_state_files(&config).await?;
    let database_path = config.data_dir.join("operalibre.db");
    let layout = JsonLayout::for_config(&config);
    migrate_if_needed(&database_path, &config.data_dir, &layout)?;
    let database = Database::open(&database_path)?;
    let mut snapshot = load_cached_snapshot(&database).await?;
    apply_startup_data_migrations(&database, &mut snapshot).await?;
    let accounts = prepare_libation_accounts_root(&config, &snapshot.libation_accounts).await?;
    let identity = load_or_create_server_id(&config.data_dir).await?;
    let state = build_app_state(
        &config,
        database,
        database_path,
        snapshot,
        None,
        accounts,
        identity,
    )?;
    let app = build_router(state.clone(), None, &[])?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    record_server_pid(&config.data_dir)?;
    start_startup_scan(state.clone()).await;
    if mode == "create" {
        anyhow::ensure!(
            crate::libation_recovery::wait_for_library(&state, state.shutdown.subscribe()).await,
            "child library unavailable"
        );
        let auth = AuthUser::from(
            state
                .users
                .read()
                .await
                .users
                .first()
                .ok_or_else(|| anyhow::anyhow!("missing fixture owner"))?,
        );
        let (book_id, ebook_id) = {
            let library = state.library.read().await;
            let book = library
                .books
                .first()
                .ok_or_else(|| anyhow::anyhow!("missing fixture book"))?;
            (
                book.id.clone(),
                book.reading_file
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("missing selected EPUB"))?
                    .id
                    .clone(),
            )
        };
        let invitation = crate::share::create_selected_share_for_user(
            &state,
            &auth,
            crate::share::CreateSelectedShareRequest {
                book_id,
                selected_asset_ids: vec![ebook_id],
                personal_message: Some("Keep this private".into()),
                expires_in_seconds: Some(300),
            },
        )
        .await
        .map_err(|_| anyhow::anyhow!("child invitation creation failed"))?;
        let origin = std::env::var("OPERALIBRE_GIFT_BOOT_TEST_BROKER")?;
        let broker = crate::share_broker::BrokerClient::local(&origin)?;
        let prepared = crate::share::start_invitation_sender_with_recovery(
            true,
            &state,
            &auth,
            &invitation.token,
            &broker,
            FIXTURE_OWNER,
            &crate::share_connectivity::Connectivity::default(),
            true,
        )
        .await
        .map_err(|_| anyhow::anyhow!("child sender creation failed"))?;
        write_json_atomic(
            &config.data_dir.join("gift-process-result.json"),
            &serde_json::json!({"giftUrl":prepared.gift_url,"token":invitation.token}),
        )
        .await
        .map_err(|_| anyhow::anyhow!("cannot publish private child result"))?;
        tokio::spawn(async move {
            let _ = prepared.wait().await;
        });
    }
    let _boot = crate::share_setup::start_boot_recovery(state.clone(), true).unwrap();
    // Never print the gift URL, capabilities, private state or owner secret.
    println!("GIFT_BOOT_READY {}", listener.local_addr()?);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

async fn child(
    config: &FsPath,
    broker: &crate::share_broker::BrokerClient,
    mode: &str,
) -> anyhow::Result<(tokio::process::Child, reqwest::Url)> {
    let mut child = tokio::process::Command::new(std::env::current_exe()?)
        .args([CHILD_TEST, "--exact", "--ignored", "--nocapture"])
        .env("OPERALIBRE_SERVER_CONFIG", config)
        .env("OPERALIBRE_GIFT_BOOT_CHILD_MODE", mode)
        .env("OPERALIBRE_GIFT_BOOT_TEST_BROKER", broker.origin().as_str())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    let mut stdout = tokio::io::BufReader::new(child.stdout.take().unwrap());
    let origin = tokio::time::timeout(Duration::from_secs(15), async {
        let mut line = String::new();
        loop {
            line.clear();
            anyhow::ensure!(
                stdout.read_line(&mut line).await? > 0,
                "child exited before readiness"
            );
            if let Some((_, address)) = line.split_once("GIFT_BOOT_READY ") {
                let address: SocketAddr = address.trim().parse()?;
                anyhow::ensure!(address.ip().is_loopback(), "nonlocal test child");
                return reqwest::Url::parse(&format!("http://{address}/")).map_err(Into::into);
            }
        }
    })
    .await??;
    // Draining avoids a pipe lifetime affecting the sender; no output escapes
    // this fixture. The test owns and kills only this exact captured child.
    tokio::spawn(async move {
        let _ = tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await;
    });
    Ok((child, origin))
}

async fn recovered_generation(
    store: &RecoveryStore,
    broker: &crate::share_broker::BrokerClient,
    id: &str,
) -> anyhow::Result<(PersistedSender, u64)> {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if let Ok(records) = store.list().await
                && let Some(record) = records.into_iter().find(|record| record.id() == id)
                && let Some(producer) = record.producer.as_ref()
                && let Ok(generation) = broker.session_generation(&record.room, producer).await
                && generation > 0
            {
                return Ok((record, generation));
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await?
}

#[tokio::test]
#[ignore = "requires compiled actual Worker and OPERALIBRE_WORKER_FIXTURE_SCRIPT"]
async fn selected_sender_survives_full_process_restart() -> anyhow::Result<()> {
    tokio::time::timeout(Duration::from_secs(90), async {
        let script = std::env::var_os("OPERALIBRE_WORKER_FIXTURE_SCRIPT").ok_or_else(|| anyhow::anyhow!("supply compiled Worker fixture"))?;
        let mut worker = tokio::process::Command::new("node").arg(script)
            .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::inherit()).kill_on_drop(true).spawn()?;
        let mut stdout = tokio::io::BufReader::new(worker.stdout.take().unwrap());
        let mut line = String::new(); stdout.read_line(&mut line).await?;
        let locator: Value = serde_json::from_str(&line)?;
        let target = reqwest::Url::parse(locator["origin"].as_str().ok_or_else(|| anyhow::anyhow!("Worker unavailable"))?)?;
        let fixture = TestServer::start(1).await;
        let owner = fixture.setup_owner().await;
        let (book_id, _) = fixture.first_book_and_track(&owner).await;
        let mut epub = zip::ZipWriter::new_append(std::io::Cursor::new(alignment::build_test_epub()))?;
        epub.start_file("process-fixture-padding.bin", zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored))?;
        std::io::Write::write_all(&mut epub, &rand::random::<[u8; 65536]>())?;
        assert_eq!(fixture.upload_ebook(&book_id, &owner, "book.epub", epub.finish()?.into_inner()).await.status, StatusCode::OK);
        let data = fixture.state.database_path.parent().unwrap();
        let store = RecoveryStore::open(data, &fixture.state.server_id, fixture.state.max_book_download_bytes.unwrap(), fixture.state.min_download_free_bytes)?;
        let (broker, checked_claims, _probe) = persisted_claim_probe(target, store.clone()).await?;
        let configuration = serde_json::json!({"version":1,"brokerOrigin":broker.origin().origin().ascii_serialization(),"ownerSecret":FIXTURE_OWNER,"allowReaders":false,"retainSenderState":true,"autoRecoverSenders":true,"connectivity":{}}).to_string();
        fixture.state.database.transaction(move |db| write_document(db, "share-owner-configuration-v1", &configuration)).await.unwrap();
        let config = fixture._root.path().join("gift-process.config");
        std::fs::write(&config, format!("deployment_mode = proxy\nhost = 127.0.0.1\nport = 0\nlibrary_root = {}\ndata_dir = {}\n", fixture.library_root.display(), data.display()))?;
        let (mut first, _) = child(&config, &broker, "create").await?;
        let result: Value = serde_json::from_slice(&fs::read(data.join("gift-process-result.json")).await?)?;
        let pins = parse_pins(result["giftUrl"].as_str().ok_or_else(|| anyhow::anyhow!("missing original gift"))?)?;
        let record = store.list().await?.remove(0);
        claim_recipient(&broker, &record, &pins).await?;
        let (prefix, interrupted_peer) = receive_zip_from(&broker, &record, &pins, 0, Vec::new(), true).await?;
        assert!(!prefix.is_empty() && (prefix.len() as u64) < record.archive_size);
        first.kill().await?;
        interrupted_peer.0.close().await?;
        let (mut second, second_origin) = child(&config, &broker, "recover").await?;
        let (restored, generation) = recovered_generation(&store, &broker, &record.id()).await?;
        assert_eq!(generation, 1);
        assert_eq!(restored.archive_sha256, record.archive_sha256);
        let (archive, peer) = receive_zip_from(&broker, &record, &pins, generation, prefix, false).await?;
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive))?;
        assert_eq!(zip.len(), 2);
        assert!(zip.by_name("book.epub").is_ok());
        assert!(zip.by_name("metadata.json").is_ok());
        assert!(zip.by_name("01 Track.wav").is_err());
        peer.0.close().await?;
        let client = crate::http_client_builder().build()?;
        let revoked = client.delete(second_origin.join(&format!("api/shares/{}", result["token"].as_str().unwrap()))?).bearer_auth(&owner).send().await?;
        assert_eq!(revoked.status(), StatusCode::NO_CONTENT);
        second.kill().await?;
        // Relaunch once more: durable revocation must never be undone by boot.
        let (mut third, third_origin) = child(&config, &broker, "recover").await?;
        let preview = client.get(third_origin.join(&format!("api/shares/{}/preview", result["token"].as_str().unwrap()))?).send().await?;
        assert_eq!(preview.status(), StatusCode::NOT_FOUND);
        assert_eq!(checked_claims.load(std::sync::atomic::Ordering::SeqCst), 1, "restart must rotate, never reclaim the original producer");
        third.kill().await?;
        // Both terminal states must reclaim a genuinely dormant retained
        // archive after a process death, not merely reject an empty snapshot.
        for terminal in ["revoked", "expired"] {
            let (mut creator, _) = child(&config, &broker, "create").await?;
            let result: Value = serde_json::from_slice(&fs::read(data.join("gift-process-result.json")).await?)?;
            let pins = parse_pins(result["giftUrl"].as_str().unwrap())?;
            let dormant = store.list().await?.into_iter().find(|record| record.gift_id == pins.gift_id).ok_or_else(|| anyhow::anyhow!("dormant snapshot missing"))?;
            creator.kill().await?;
            if terminal == "revoked" {
                let revoked = fixture.send_json("DELETE", &format!("/api/shares/{}", result["token"].as_str().unwrap()), &owner, Value::Null).await;
                assert_eq!(revoked.status, StatusCode::SERVICE_UNAVAILABLE);
                assert!(revoked.text().contains("revoked locally"), "revocation must persist before reporting pending broker cleanup");
            } else {
                let digest = dormant.invitation_digest.clone();
                fixture.state.database.transaction(move |db| {
                    let mut records: Value = serde_json::from_str(&read_document(db, crate::share::SHARE_INVITATIONS_DOCUMENT)?.unwrap()).unwrap();
                    let record = records.as_array_mut().unwrap().iter_mut().find(|record| record["tokenDigest"] == digest).unwrap();
                    record["expiresAt"] = Value::from(0);
                    write_document(db, crate::share::SHARE_INVITATIONS_DOCUMENT, &records.to_string())
                }).await.unwrap();
            }
            let (mut recovery, _) = child(&config, &broker, "recover").await?;
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    if let Ok(records) = store.list().await
                        && records.iter().all(|record| record.id() != dormant.id()) { break; }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }).await?;
            assert!(broker.session_generation(&dormant.room, dormant.producer.as_ref().unwrap()).await.is_err());
            recovery.kill().await?;
        }
        assert_eq!(checked_claims.load(std::sync::atomic::Ordering::SeqCst), 3, "only the three initial producer claims, never a reclaim on boot");
        worker.kill().await?;
        Ok::<(), anyhow::Error>(())
    }).await??;
    Ok(())
}
