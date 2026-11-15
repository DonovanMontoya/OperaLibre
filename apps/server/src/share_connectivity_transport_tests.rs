//! Dependency-level capability regression tests, not a TCP/TLS TURN service.
//! webrtc 0.21.1 parses these URLs but its private async gatherers skip them.
//! Keep owner configuration fail-closed until actual stream allocation, TLS
//! verification, relay routing and cancellation have a tested implementation.
use super::*;
use std::sync::Arc;
use std::time::Duration;
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCIceGatheringState,
};

const SECRET: &str = "private-transport-test-secret-32-bytes";

#[test]
fn unsupported_fallback_is_rejected_atomically_without_echoing_configuration() {
    for (url, diagnostic) in [
        (
            "turn:private-relay.example:443?transport=tcp",
            "TURN over TCP",
        ),
        ("turns:private-relay.example:443", "Secure STUN/TURN"),
        (
            "turns:private-relay.example:443?transport=tcp",
            "Secure STUN/TURN",
        ),
        ("stuns:private-relay.example:443", "Secure STUN/TURN"),
    ] {
        // A supported URL must not conceal an unsupported fallback. No partial
        // runtime or recipient configuration may escape this mixed list.
        let owner: Connectivity = serde_json::from_value(serde_json::json!({
            "iceServers": [{
                "urls": ["turn:private-relay.example:3478?transport=udp", url],
                "turnRestSecret": SECRET
            }],
            "relayAllowed": true,
            "requireRelay": true
        }))
        .unwrap();
        for error in [
            owner.validate().err().unwrap(),
            owner.redacted().err().unwrap(),
            owner
                .for_invitation("gift_transport_test", 200, 100)
                .err()
                .unwrap(),
        ] {
            let message = error.to_string();
            assert!(
                message.contains(diagnostic),
                "missing capability diagnostic"
            );
            assert!(!message.contains(SECRET));
            assert!(!message.contains("private-relay.example"));
        }
    }
}

struct Gathered(tokio::sync::mpsc::Sender<()>);

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Gathered {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.0.try_send(());
        }
    }
}

#[tokio::test]
async fn installed_async_driver_skips_tcp_and_secure_turn_despite_url_parser_acceptance()
-> anyhow::Result<()> {
    // Bypass only our owner validator to demonstrate the installed dependency's
    // behavior. Both local listeners remain live throughout gathering. Nothing
    // is provisioned and no external address is contacted.
    for (scheme, suffix) in [
        ("turn", "?transport=tcp"),
        ("turns", ""),
        ("turns", "?transport=tcp"),
    ] {
        let tcp = std::net::TcpListener::bind("127.0.0.1:0")?;
        tcp.set_nonblocking(true)?;
        let address = tcp.local_addr()?;
        let udp = std::net::UdpSocket::bind(address)?;
        udp.set_nonblocking(true)?;
        let url = format!("{scheme}:{address}{suffix}");
        let server = RTCIceServer {
            urls: vec![url],
            username: "test-scoped-user".into(),
            credential: "test-scoped-credential".into(),
        };
        // Syntactic acceptance is insufficient evidence of runtime support.
        assert_eq!(server.urls()?.len(), 1);
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        let peer = PeerConnectionBuilder::new()
            .with_configuration(
                RTCConfigurationBuilder::default()
                    .with_ice_servers(vec![server])
                    .with_ice_transport_policy(RTCIceTransportPolicy::Relay)
                    .build(),
            )
            .with_handler(Arc::new(Gathered(tx)))
            .with_udp_addrs(vec!["127.0.0.1:0"])
            .build()
            .await?;
        let outcome = tokio::time::timeout(Duration::from_secs(5), async {
            peer.create_data_channel("unsupported-transport-probe", None).await?;
            peer.set_local_description(peer.create_offer(None).await?).await?;
            anyhow::ensure!(rx.recv().await.is_some(), "gathering event stream closed");
            let offer = peer.local_description().await.ok_or_else(|| anyhow::anyhow!("missing SDP"))?;
            anyhow::ensure!(!offer.sdp.contains("a=candidate:"), "unsupported transport produced a candidate");
            anyhow::ensure!(matches!(tcp.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock), "unsupported transport opened TCP");
            let mut buffer = [0u8; 2048];
            anyhow::ensure!(matches!(udp.recv_from(&mut buffer), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock), "unsupported transport silently fell back to UDP");
            Ok::<(), anyhow::Error>(())
        }).await;
        // Always close the actual driver, including assertion/timeout failure.
        let closed = tokio::time::timeout(Duration::from_secs(5), peer.close()).await;
        outcome??;
        closed??;
    }
    Ok(())
}
