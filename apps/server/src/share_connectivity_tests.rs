use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::peer_connection::{PeerConnectionEventHandler, RTCIceGatheringState};

const GIFT: &str = "gift_connectivity1";
const SECRET: &str = "private-test-rest-secret-32-bytes-long";

fn configured(value: serde_json::Value) -> Connectivity {
    serde_json::from_value(value).unwrap()
}
fn turn() -> Connectivity {
    configured(
        serde_json::json!({"iceServers": [{"urls": ["turn:relay.example:3478?transport=udp"], "turnRestSecret": SECRET}], "relayAllowed": true}),
    )
}

#[test]
fn host_default_has_no_external_servers_or_relay() {
    let rtc = ConnectivityConfig::default().rtc_configuration();
    assert!(rtc.ice_servers().is_empty());
    assert_eq!(rtc.ice_transport_policy(), RTCIceTransportPolicy::All);
    assert!(
        ConnectivityConfig::default()
            .recipient_configuration()
            .is_none()
    );
    Connectivity::default().validate().unwrap();
}

#[test]
fn validates_supported_urls_without_contacting_external_services() {
    for url in [
        "stun:stun.example",
        "stun:127.0.0.1:3478",
        "stun:[::1]:3478",
        "turn:relay.example",
        "turn:127.0.0.1:3478?transport=udp",
    ] {
        let mut config = turn();
        config.ice_servers[0].urls = vec![url.into()];
        if url.starts_with("stun:") {
            config.ice_servers[0].turn_rest_secret = None;
        }
        config.for_invitation(GIFT, 200, 100).unwrap();
    }
}

#[test]
fn rejects_malformed_embedded_credentials_and_unsupported_transports() {
    for url in [
        "",
        "https://relay.example",
        "stuns:stun.example:5349",
        "turns:relay.example:5349",
        "turn:relay.example?transport=tcp",
        "turn://relay.example",
        "turn:user:password@relay.example",
        "turn:user%40relay.example",
        "turn:relay.example/path",
        "turn:relay.example#secret",
        "turn:relay.example?secret=password",
        "turn:relay.example?transport=udp&secret=x",
        "turn:relay.example?transport=udp?transport=tcp",
        "stun:stun.example?transport=udp",
        "stun:",
        "stun:host:0",
        "stun:host:65536",
        "stun:host:-1",
        "stun:host:abc",
        "stun:host:",
        "stun:host:12:34",
        "stun:[not-ipv6]",
        "stun:[::1]extra",
        "stun:bad_host",
        "stun:-host",
        "stun:host..example",
        "stun: host",
        "stun:host\n",
        "STUN:host",
    ] {
        let mut config = turn();
        config.ice_servers[0].urls = vec![url.into()];
        assert!(
            config.validate().is_err(),
            "accepted malformed or unsupported ICE URL"
        );
        let message = config.validate().err().unwrap().to_string();
        assert!(!message.contains("password") && !message.contains(SECRET));
    }
}

#[test]
fn enforces_server_url_and_secret_bounds() {
    let mut config = turn();
    config.ice_servers = vec![config.ice_servers[0].clone(); MAX_SERVERS + 1];
    assert!(config.validate().is_err());
    let mut config = turn();
    config.ice_servers[0].urls = (0..MAX_SERVER_URLS + 1)
        .map(|n| format!("turn:relay{n}.example"))
        .collect();
    assert!(config.validate().is_err());
    let config = configured(
        serde_json::json!({"iceServers": (0..3).map(|i| serde_json::json!({"urls": (0..3).map(|j| format!("stun:stun{i}-{j}.example")).collect::<Vec<_>>()})).collect::<Vec<_>>()}),
    );
    assert!(config.validate().is_err());
    for urls in [
        vec![],
        vec!["stun:host".to_owned(), "stun:host".to_owned()],
        vec![format!("stun:{}", "x".repeat(MAX_URL_BYTES))],
        vec!["stun:host".into(), "turn:host".into()],
    ] {
        let config = configured(serde_json::json!({"iceServers": [{"urls": urls}]}));
        assert!(config.validate().is_err());
    }
    for secret in [
        "x".repeat(31),
        "x".repeat(MAX_CREDENTIAL_BYTES + 1),
        format!("{SECRET}\n"),
    ] {
        let mut config = turn();
        config.ice_servers[0].turn_rest_secret = Some(secret);
        assert!(config.validate().is_err());
    }
    for (username, password) in [
        ("u".repeat(MAX_USERNAME_BYTES + 1), "p".into()),
        ("u".into(), "p".repeat(MAX_CREDENTIAL_BYTES + 1)),
        ("u\n".into(), "p".into()),
        ("".into(), "p".into()),
    ] {
        let config = configured(
            serde_json::json!({"iceServers": [{"urls": ["turn:host"], "username": username, "credential": password}], "relayAllowed": true}),
        );
        assert!(config.validate().is_err());
    }
}

#[test]
fn relay_requires_opt_in_and_scoped_credentials_never_fall_back_to_owner_secrets() {
    let mut config = turn();
    config.relay_allowed = false;
    assert!(config.validate().is_err());
    let config = configured(serde_json::json!({"requireRelay": true}));
    assert!(config.validate().is_err());
    let config = configured(
        serde_json::json!({"iceServers": [{"urls": ["stun:host"], "credential": "hidden"}]}),
    );
    assert!(config.validate().is_err());
    let mut config = turn();
    config.ice_servers[0].username = Some("owner-user".into());
    assert!(config.validate().is_err());
    let config = configured(
        serde_json::json!({"iceServers": [{"urls": ["turn:relay.example"], "username": "owner-user", "credential": "owner-password"}], "relayAllowed": true}),
    );
    config.validate().unwrap();
    assert!(config.for_invitation(GIFT, 200, 100).is_err());
    let redacted = config.redacted().unwrap().to_string();
    assert!(!redacted.contains("owner-user") && !redacted.contains("owner-password"));
    assert!(!turn().redacted().unwrap().to_string().contains(SECRET));
    assert!(
        serde_json::from_value::<Connectivity>(
            serde_json::json!({"providerToken": "not-supported"})
        )
        .is_err()
    );
}

// Independent RFC 2104 computation, using SHA-1 directly rather than ring's
// HMAC helper, checks the coturn TURN REST credential format on both roles.
fn reference_hmac(secret: &[u8], username: &[u8]) -> Vec<u8> {
    use sha1::{Digest, Sha1};
    let key = if secret.len() > 64 {
        Sha1::digest(secret).to_vec()
    } else {
        secret.to_vec()
    };
    let mut inner = [0x36u8; 64];
    let mut outer = [0x5cu8; 64];
    for (i, byte) in key.iter().enumerate() {
        inner[i] ^= byte;
        outer[i] ^= byte;
    }
    let mut hash = Sha1::new();
    hash.update(inner);
    hash.update(username);
    let inside = hash.finalize();
    let mut hash = Sha1::new();
    hash.update(outer);
    hash.update(inside);
    hash.finalize().to_vec()
}

#[test]
fn derives_distinct_expiring_credentials_and_only_serializes_recipient_projection() {
    let mut owner = turn();
    owner.require_relay = true;
    let config = owner.for_invitation(GIFT, 200, 100).unwrap();
    let rtc = config.rtc_configuration();
    let sender = &rtc.ice_servers()[0];
    let recipient = config.recipient_configuration().unwrap();
    let recipient_server = &recipient.ice_servers[0];
    let username = recipient_server.username.as_ref().unwrap();
    let password = recipient_server.credential.as_ref().unwrap();
    assert_eq!(rtc.ice_transport_policy(), RTCIceTransportPolicy::Relay);
    assert_eq!(recipient.ice_transport_policy, "relay");
    assert!(
        sender
            .username
            .starts_with(&format!("200:operalibre:{GIFT}:sender:"))
    );
    assert!(username.starts_with(&format!("200:operalibre:{GIFT}:recipient:")));
    assert_ne!(sender.username, *username);
    assert_ne!(sender.credential, *password);
    assert_eq!(
        sender.credential,
        STANDARD.encode(reference_hmac(
            SECRET.as_bytes(),
            sender.username.as_bytes()
        ))
    );
    assert_eq!(
        *password,
        STANDARD.encode(reference_hmac(SECRET.as_bytes(), username.as_bytes()))
    );
    let json = serde_json::to_string(recipient).unwrap();
    assert!(
        !json.contains(SECRET)
            && !json.contains("turnRestSecret")
            && !json.contains(&sender.credential)
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&json).unwrap()["giftId"],
        GIFT
    );
    assert!(config.validate_invitation(GIFT, 200, 199).is_ok());
    assert!(config.validate_invitation(GIFT, 200, 200).is_err());
    assert!(
        config
            .validate_invitation("another_gift_____", 200, 100)
            .is_err()
    );
    assert!(config.validate_invitation(GIFT, 201, 100).is_err());
    for (gift, expiry) in [
        ("invalid", 200),
        (GIFT, 100),
        (GIFT, 100 + crate::share::GIFT_MAX_LIFETIME_SECONDS + 1),
    ] {
        assert!(owner.for_invitation(gift, expiry, 100).is_err());
    }
    let next = owner.for_invitation(GIFT, 200, 100).unwrap();
    assert_ne!(
        next.rtc_configuration().ice_servers()[0].username,
        sender.username
    );
}

struct Handler {
    gathered: tokio::sync::mpsc::Sender<()>,
    received: Option<tokio::sync::mpsc::Sender<Vec<u8>>>,
}
#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.gathered.try_send(());
        }
    }
    async fn on_data_channel(&self, channel: Arc<dyn DataChannel>) {
        let Some(received) = self.received.clone() else {
            return;
        };
        tokio::spawn(async move {
            while let Some(event) = channel.poll().await {
                if let DataChannelEvent::OnMessage(message) = event {
                    let _ = received.send(message.data.to_vec()).await;
                    break;
                }
            }
        });
    }
}

async fn two_peers(config: &ConnectivityConfig, candidate: Option<&str>) -> anyhow::Result<()> {
    let (a_tx, mut a_rx) = tokio::sync::mpsc::channel(1);
    let (b_tx, mut b_rx) = tokio::sync::mpsc::channel(1);
    let (received_tx, mut received_rx) = tokio::sync::mpsc::channel(1);
    let a = crate::share_sender::create_configured_peer(
        config,
        Arc::new(Handler {
            gathered: a_tx,
            received: None,
        }),
    )
    .await?;
    let recipient_config = config
        .recipient_configuration()
        .map(|recipient| ConnectivityConfig {
            sender_servers: recipient
                .ice_servers
                .iter()
                .map(|server| RTCIceServer {
                    urls: server.urls.clone(),
                    username: server.username.clone().unwrap_or_default(),
                    credential: server.credential.clone().unwrap_or_default(),
                })
                .collect(),
            recipient: None,
            require_relay: recipient.ice_transport_policy == "relay",
        })
        .unwrap_or_default();
    let b = crate::share_sender::create_configured_peer(
        &recipient_config,
        Arc::new(Handler {
            gathered: b_tx,
            received: Some(received_tx),
        }),
    )
    .await?;
    let outcome = tokio::time::timeout(Duration::from_secs(20), async {
        let channel = a.create_data_channel("gift-connectivity", None).await?;
        a.set_local_description(a.create_offer(None).await?).await?;
        a_rx.recv()
            .await
            .ok_or_else(|| anyhow::anyhow!("offer gathering closed"))?;
        let offer = a
            .local_description()
            .await
            .ok_or_else(|| anyhow::anyhow!("missing offer"))?;
        if let Some(candidate) = candidate {
            anyhow::ensure!(
                offer.sdp.contains(&format!(" typ {candidate}")),
                "configured ICE did not produce the required candidate"
            );
        }
        if config.require_relay {
            anyhow::ensure!(
                !offer.sdp.contains(" typ host") && !offer.sdp.contains(" typ srflx"),
                "relay-only offer exposed a direct fallback"
            );
        }
        b.set_remote_description(offer).await?;
        b.set_local_description(b.create_answer(None).await?)
            .await?;
        b_rx.recv()
            .await
            .ok_or_else(|| anyhow::anyhow!("answer gathering closed"))?;
        let answer = b
            .local_description()
            .await
            .ok_or_else(|| anyhow::anyhow!("missing answer"))?;
        if let Some(candidate) = candidate {
            anyhow::ensure!(
                answer.sdp.contains(&format!(" typ {candidate}")),
                "recipient ICE did not produce the required candidate"
            );
        }
        if config.require_relay {
            anyhow::ensure!(
                !answer.sdp.contains(" typ host") && !answer.sdp.contains(" typ srflx"),
                "relay-only answer exposed a direct fallback"
            );
        }
        a.set_remote_description(answer).await?;
        loop {
            match channel.poll().await {
                Some(DataChannelEvent::OnOpen) => break,
                Some(DataChannelEvent::OnClose) | None => anyhow::bail!("channel closed"),
                _ => {}
            }
        }
        channel
            .send(bytes::BytesMut::from(&b"actual Rust ICE peer bytes"[..]))
            .await?;
        assert_eq!(
            received_rx.recv().await.as_deref(),
            Some(&b"actual Rust ICE peer bytes"[..])
        );
        Ok::<(), anyhow::Error>(())
    })
    .await;
    let cleanup = tokio::time::timeout(Duration::from_secs(5), async {
        a.close().await?;
        b.close().await?;
        Ok::<(), anyhow::Error>(())
    })
    .await;
    outcome??;
    cleanup??;
    Ok(())
}

#[tokio::test]
async fn configured_host_sender_transfers_bytes_between_actual_rust_peers() -> anyhow::Result<()> {
    two_peers(&ConnectivityConfig::default(), None).await
}

#[tokio::test]
async fn configured_local_stun_gathers_srflx_and_transfers_between_actual_rust_peers()
-> anyhow::Result<()> {
    let socket = tokio::net::UdpSocket::bind("127.0.0.1:0").await?;
    let address = socket.local_addr()?;
    let requests = Arc::new(AtomicUsize::new(0));
    let seen = requests.clone();
    // Minimal localhost RFC 5389 Binding responder. No external network,
    // provider, installation, service account or long-lived process is used.
    let server = tokio::spawn(async move {
        let mut buffer = [0u8; 2048];
        loop {
            let (length, from) = socket.recv_from(&mut buffer).await?;
            if length < 20 || buffer[..2] != [0, 1] || buffer[4..8] != [0x21, 0x12, 0xa4, 0x42] {
                continue;
            }
            let std::net::IpAddr::V4(ip) = from.ip() else {
                continue;
            };
            seen.fetch_add(1, Ordering::SeqCst);
            let mut response = [0u8; 32];
            response[..20].copy_from_slice(&buffer[..20]);
            response[..4].copy_from_slice(&[1, 1, 0, 12]);
            response[20..26].copy_from_slice(&[0, 0x20, 0, 8, 0, 1]);
            response[26..28].copy_from_slice(&(from.port() ^ 0x2112).to_be_bytes());
            for (i, byte) in ip.octets().iter().enumerate() {
                response[28 + i] = byte ^ buffer[4 + i];
            }
            socket.send_to(&response, from).await?;
        }
        #[allow(unreachable_code)]
        Ok::<(), std::io::Error>(())
    });
    let owner =
        configured(serde_json::json!({"iceServers": [{"urls": [format!("stun:{address}")]}]}));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    let config = owner.for_invitation(GIFT, now + 60, now)?;
    let outcome = two_peers(&config, Some("srflx")).await;
    server.abort();
    let _ = server.await;
    outcome?;
    assert!(
        requests.load(Ordering::SeqCst) >= 2,
        "both actual peers must query STUN"
    );
    Ok(())
}

#[path = "share_connectivity_local_turn.rs"]
mod local_turn;

#[tokio::test]
async fn configured_local_turn_authenticates_and_relays_actual_rust_peer_bytes()
-> anyhow::Result<()> {
    let mut server = local_turn::start(SECRET).await?;
    let owner = configured(
        serde_json::json!({"iceServers": [{"urls": [format!("turn:{}?transport=udp", server.address)], "turnRestSecret": SECRET}], "relayAllowed": true, "requireRelay": true}),
    );
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    let config = owner.for_invitation(GIFT, now + 60, now)?;
    let outcome = two_peers(&config, Some("relay")).await;
    server.stop().await?;
    outcome?;
    assert!(server.allocations.load(Ordering::SeqCst) >= 2);
    assert!(server.relayed.load(Ordering::SeqCst) > 0);
    assert_eq!(server.bad_integrity.load(Ordering::SeqCst), 0);
    Ok(())
}

#[test]
fn full_day_connectivity_credentials_keep_the_invitation_expiry() {
    let expiry = 100 + crate::share::GIFT_MAX_LIFETIME_SECONDS;
    let connection = turn().for_invitation(GIFT, expiry, 100).unwrap();
    assert!(
        connection
            .validate_invitation(GIFT, expiry, 100 + 16 * 60)
            .is_ok()
    );
    assert!(
        connection
            .validate_invitation(GIFT, expiry, expiry)
            .is_err()
    );
    assert!(turn().for_invitation(GIFT, expiry + 1, 100).is_err());
}
