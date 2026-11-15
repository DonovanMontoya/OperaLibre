//! Test-only, bounded localhost TURN UDP fixture. Uses the installed RTC crypto
//! provider for RFC 5389 long-term MD5 keys, verifies MESSAGE-INTEGRITY and the
//! locally derived TURN REST password, and actually forwards relay datagrams.
//! It is not a production TURN daemon or a test of provider/coturn deployment.
use super::*;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use tokio::net::UdpSocket;

const COOKIE: [u8; 4] = [0x21, 0x12, 0xa4, 0x42];
const REALM: &str = "operalibre-local-turn-test";
const NONCE: &[u8] = b"local-test-nonce";

pub(super) struct LocalTurn {
    pub(super) address: SocketAddr,
    pub(super) allocations: Arc<AtomicUsize>,
    pub(super) relayed: Arc<AtomicUsize>,
    pub(super) bad_integrity: Arc<AtomicUsize>,
    task: Option<tokio::task::JoinHandle<anyhow::Result<()>>>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
}
impl LocalTurn {
    pub(super) async fn stop(&mut self) -> anyhow::Result<()> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(mut task) = self.task.take() {
            match tokio::time::timeout(Duration::from_secs(3), &mut task).await {
                Ok(result) => result??,
                Err(_) => {
                    task.abort();
                    let _ = task.await;
                    anyhow::bail!("local TURN fixture cleanup timed out");
                }
            }
        }
        Ok(())
    }
}
impl Drop for LocalTurn {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

fn attribute(raw: &[u8], kind: u16) -> Option<(usize, &[u8])> {
    let mut at = 20;
    while at + 4 <= raw.len() {
        let length = u16::from_be_bytes([raw[at + 2], raw[at + 3]]) as usize;
        let value = raw.get(at + 4..at + 4 + length)?;
        if u16::from_be_bytes([raw[at], raw[at + 1]]) == kind {
            return Some((at, value));
        }
        at += 4 + length.div_ceil(4) * 4;
    }
    None
}
fn packet(kind: u16, transaction: &[u8], attrs: &[(u16, Vec<u8>)], key: Option<&[u8]>) -> Vec<u8> {
    let mut raw = vec![0u8; 20];
    raw[..2].copy_from_slice(&kind.to_be_bytes());
    raw[4..8].copy_from_slice(&COOKIE);
    raw[8..20].copy_from_slice(transaction);
    for (kind, value) in attrs {
        raw.extend_from_slice(&kind.to_be_bytes());
        raw.extend_from_slice(&(value.len() as u16).to_be_bytes());
        raw.extend_from_slice(value);
        while !raw.len().is_multiple_of(4) {
            raw.push(0);
        }
    }
    let length = raw.len() - 20 + if key.is_some() { 24 } else { 0 };
    raw[2..4].copy_from_slice(&(length as u16).to_be_bytes());
    if let Some(key) = key {
        let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, key);
        let tag = ring::hmac::sign(&key, &raw);
        raw.extend_from_slice(&[0, 8, 0, 20]);
        raw.extend_from_slice(tag.as_ref());
    }
    raw
}
fn xor_address(address: SocketAddr) -> Vec<u8> {
    let IpAddr::V4(ip) = address.ip() else {
        unreachable!("test relay is IPv4 loopback");
    };
    let mut bytes = vec![0, 1];
    bytes.extend_from_slice(&(address.port() ^ 0x2112).to_be_bytes());
    bytes.extend(ip.octets().iter().zip(COOKIE).map(|(a, b)| a ^ b));
    bytes
}
fn peer_address(bytes: &[u8]) -> Option<SocketAddr> {
    if bytes.len() != 8 || bytes[1] != 1 {
        return None;
    }
    let port = u16::from_be_bytes([bytes[2], bytes[3]]) ^ 0x2112;
    let ip = Ipv4Addr::new(
        bytes[4] ^ COOKIE[0],
        bytes[5] ^ COOKIE[1],
        bytes[6] ^ COOKIE[2],
        bytes[7] ^ COOKIE[3],
    );
    ip.is_loopback()
        .then_some(SocketAddr::new(IpAddr::V4(ip), port))
}
fn integrity_key(raw: &[u8], secret: &str) -> anyhow::Result<Vec<u8>> {
    let (_, username) =
        attribute(raw, 6).ok_or_else(|| anyhow::anyhow!("missing TURN username"))?;
    let username = std::str::from_utf8(username)?;
    let expiry = username
        .split(':')
        .next()
        .unwrap_or_default()
        .parse::<u64>()?;
    anyhow::ensure!(
        expiry
            > std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_secs(),
        "expired test TURN credential"
    );
    anyhow::ensure!(
        attribute(raw, 0x14).map(|(_, value)| value) == Some(REALM.as_bytes())
            && attribute(raw, 0x15).map(|(_, value)| value) == Some(NONCE),
        "invalid TURN realm/nonce"
    );
    let password = STANDARD.encode(reference_hmac(secret.as_bytes(), username.as_bytes()));
    let provider = webrtc::peer_connection::crypto::default_provider()?;
    let key = provider.crypto().hash(
        webrtc::peer_connection::crypto::HashAlgorithm::Md5,
        format!("{username}:{REALM}:{password}").as_bytes(),
    )?;
    let (at, digest) =
        attribute(raw, 8).ok_or_else(|| anyhow::anyhow!("missing TURN integrity"))?;
    let mut signed = raw[..at].to_vec();
    signed[2..4].copy_from_slice(&((at + 24 - 20) as u16).to_be_bytes());
    let mac = ring::hmac::Key::new(ring::hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, &key);
    ring::hmac::verify(&mac, &signed, digest)
        .map_err(|_| anyhow::anyhow!("TURN integrity failed"))?;
    Ok(key)
}

pub(super) async fn start(secret: &str) -> anyhow::Result<LocalTurn> {
    let control = Arc::new(UdpSocket::bind("127.0.0.1:0").await?);
    let address = control.local_addr()?;
    let allocations = Arc::new(AtomicUsize::new(0));
    let relayed = Arc::new(AtomicUsize::new(0));
    let bad_integrity = Arc::new(AtomicUsize::new(0));
    let (stop, mut stopped) = tokio::sync::oneshot::channel();
    let count = allocations.clone();
    let forwarded = relayed.clone();
    let bad = bad_integrity.clone();
    let secret = secret.to_owned();
    let task = tokio::spawn(async move {
        let mut sockets: HashMap<SocketAddr, Arc<UdpSocket>> = HashMap::new();
        let mut channels: HashMap<(SocketAddr, u16), SocketAddr> = HashMap::new();
        let mut tasks = tokio::task::JoinSet::new();
        let mut buffer = [0u8; 2048];
        loop {
            let (length, client) = tokio::select! {
                result = control.recv_from(&mut buffer) => result?,
                _ = &mut stopped => { tasks.abort_all(); while tasks.join_next().await.is_some() {} return Ok(()); },
            };
            let raw = &buffer[..length];
            if length >= 4 && raw[0] & 0xc0 == 0x40 {
                let channel = u16::from_be_bytes([raw[0], raw[1]]);
                let length = u16::from_be_bytes([raw[2], raw[3]]) as usize;
                if let (Some(socket), Some(peer), Some(data)) = (
                    sockets.get(&client),
                    channels.get(&(client, channel)),
                    raw.get(4..4 + length),
                ) {
                    socket.send_to(data, peer).await?;
                    forwarded.fetch_add(1, Ordering::SeqCst);
                }
                continue;
            }
            if length < 20 || raw[4..8] != COOKIE {
                continue;
            }
            let kind = u16::from_be_bytes([raw[0], raw[1]]);
            if kind == 0x16 {
                if let (Some(socket), Some((_, peer)), Some((_, data))) = (
                    sockets.get(&client),
                    attribute(raw, 0x12),
                    attribute(raw, 0x13),
                ) && let Some(peer) = peer_address(peer)
                {
                    socket.send_to(data, peer).await?;
                    forwarded.fetch_add(1, Ordering::SeqCst);
                }
                continue;
            }
            if ![3, 4, 8, 9].contains(&kind) {
                continue;
            }
            let key = match integrity_key(raw, &secret) {
                Ok(key) => key,
                Err(_) if kind == 3 && attribute(raw, 0x15).is_none() => {
                    let response = packet(
                        0x113,
                        &raw[8..20],
                        &[
                            (9, vec![0, 0, 4, 1]),
                            (0x14, REALM.as_bytes().to_vec()),
                            (0x15, NONCE.to_vec()),
                        ],
                        None,
                    );
                    control.send_to(&response, client).await?;
                    continue;
                }
                Err(error) => {
                    bad.fetch_add(1, Ordering::SeqCst);
                    return Err(error);
                }
            };
            let mut attrs = Vec::new();
            match kind {
                3 => {
                    anyhow::ensure!(
                        sockets.len() < 8 && !sockets.contains_key(&client),
                        "excessive test TURN allocations"
                    );
                    let relay = Arc::new(UdpSocket::bind("127.0.0.1:0").await?);
                    let relay_addr = relay.local_addr()?;
                    sockets.insert(client, relay.clone());
                    count.fetch_add(1, Ordering::SeqCst);
                    attrs.extend([
                        (0x16, xor_address(relay_addr)),
                        (0x20, xor_address(client)),
                        (0x0d, 600u32.to_be_bytes().to_vec()),
                    ]);
                    let control = control.clone();
                    let forwarded = forwarded.clone();
                    tasks.spawn(async move {
                        let mut bytes = [0u8; 2048];
                        loop {
                            let (length, peer) = relay.recv_from(&mut bytes).await?;
                            anyhow::ensure!(peer.ip().is_loopback(), "nonlocal test TURN peer");
                            let transaction = rand::random::<[u8; 12]>();
                            let message = packet(
                                0x17,
                                &transaction,
                                &[(0x12, xor_address(peer)), (0x13, bytes[..length].to_vec())],
                                None,
                            );
                            control.send_to(&message, client).await?;
                            forwarded.fetch_add(1, Ordering::SeqCst);
                        }
                        #[allow(unreachable_code)]
                        Ok::<(), anyhow::Error>(())
                    });
                }
                4 => attrs.push((
                    0x0d,
                    attribute(raw, 0x0d).map_or_else(
                        || 600u32.to_be_bytes().to_vec(),
                        |(_, value)| value.to_vec(),
                    ),
                )),
                8 => {
                    ensure_local_peer(raw)?;
                }
                9 => {
                    let peer = ensure_local_peer(raw)?;
                    let (_, channel) = attribute(raw, 0x0c)
                        .ok_or_else(|| anyhow::anyhow!("missing TURN channel"))?;
                    anyhow::ensure!(channel.len() == 4, "invalid TURN channel");
                    channels.insert((client, u16::from_be_bytes([channel[0], channel[1]])), peer);
                }
                _ => unreachable!(),
            }
            let response = packet(kind | 0x100, &raw[8..20], &attrs, Some(&key));
            control.send_to(&response, client).await?;
        }
        #[allow(unreachable_code)]
        Ok::<(), anyhow::Error>(())
    });
    Ok(LocalTurn {
        address,
        allocations,
        relayed,
        bad_integrity,
        task: Some(task),
        stop: Some(stop),
    })
}

fn ensure_local_peer(raw: &[u8]) -> anyhow::Result<SocketAddr> {
    attribute(raw, 0x12)
        .and_then(|(_, value)| peer_address(value))
        .ok_or_else(|| anyhow::anyhow!("nonlocal or malformed TURN peer"))
}
