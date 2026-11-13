//! Owner-configured ICE for the gated gift sender. No default external service.
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use webrtc::peer_connection::{
    RTCConfiguration, RTCConfigurationBuilder, RTCIceServer, RTCIceTransportPolicy,
};

const MAX_SERVERS: usize = 4;
const MAX_URLS: usize = 8;
const MAX_SERVER_URLS: usize = 4;
const MAX_URL_BYTES: usize = 512;
const MAX_USERNAME_BYTES: usize = 256;
const MAX_CREDENTIAL_BYTES: usize = 512;

/// Private owner configuration. Serialize only into private configuration
/// storage; HTTP responses must use redacted(). No Debug implementation because
/// credentials and the TURN REST shared secret must never enter logs.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Connectivity {
    #[serde(default)]
    pub(crate) ice_servers: Vec<IceServer>,
    #[serde(default)]
    pub(crate) relay_allowed: bool,
    #[serde(default)]
    pub(crate) require_relay: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IceServer {
    pub(crate) urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) credential: Option<String>,
    /// coturn-compatible shared secret, never sent to either peer. No provider
    /// HTTP API token is accepted or fetched by this module.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) turn_rest_secret: Option<String>,
}

/// Only this explicitly scoped projection belongs in the encrypted signed
/// preview. Each role gets independent, unpredictable, time-limited credentials.
/// TURN REST limits credential lifetime; it does not impose a byte/billing cap
/// or restrict the TURN allocation to this book or destination.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecipientConnectivity {
    pub(crate) gift_id: String,
    pub(crate) expires_at: u64,
    pub(crate) ice_servers: Vec<RecipientIceServer>,
    pub(crate) ice_transport_policy: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecipientIceServer {
    pub(crate) urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) credential: Option<String>,
}

/// Immutable, validated runtime configuration. Cannot serialize owner secrets.
#[derive(Clone, Default)]
pub(crate) struct ConnectivityConfig {
    sender_servers: Vec<RTCIceServer>,
    recipient: Option<RecipientConnectivity>,
    require_relay: bool,
}

fn invalid() -> anyhow::Error {
    anyhow::anyhow!("Invalid gift ICE configuration.")
}

fn credential(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.len() <= maximum && value.bytes().all(|byte| byte.is_ascii_graphic())
}

/// Accept only the transports implemented by the installed async 0.21.1
/// gatherers: UDP STUN and UDP TURN. Secure and TCP forms are explicitly skipped
/// by that dependency, so accepting them here would silently break relay-only.
/// The URL parser and ICE-TCP support do not imply TURN stream support. See
/// upstream webrtc-rs/webrtc#848 and #907; the latter still excludes TLS.
fn is_turn_url(value: &str) -> anyhow::Result<bool> {
    anyhow::ensure!(
        !value.is_empty()
            && value.len() <= MAX_URL_BYTES
            && value.is_ascii()
            && !value
                .bytes()
                .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
            && !value.contains(['@', '#', '/', '\\', '%']),
        "Invalid gift ICE URL."
    );
    let (scheme, rest) = value.split_once(':').ok_or_else(invalid)?;
    let turn = match scheme {
        "stun" => false,
        "turn" => true,
        "stuns" | "turns" => anyhow::bail!(
            "Secure STUN/TURN is not supported by the installed gift WebRTC transport."
        ),
        _ => return Err(invalid()),
    };
    let authority = if let Some((authority, query)) = rest.split_once('?') {
        anyhow::ensure!(
            !turn || query != "transport=tcp",
            "TURN over TCP is not supported by the installed gift WebRTC transport."
        );
        anyhow::ensure!(
            turn && query == "transport=udp",
            "Unsupported gift ICE transport."
        );
        authority
    } else {
        rest
    };
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let (host, suffix) = rest.split_once(']').ok_or_else(invalid)?;
        anyhow::ensure!(
            host.parse::<std::net::Ipv6Addr>().is_ok(),
            "Invalid gift ICE host."
        );
        let port = if suffix.is_empty() {
            None
        } else {
            Some(suffix.strip_prefix(':').ok_or_else(invalid)?)
        };
        (host, port)
    } else {
        let (host, port) = authority
            .split_once(':')
            .map_or((authority, None), |(host, port)| (host, Some(port)));
        anyhow::ensure!(
            !host.is_empty()
                && host.len() <= 253
                && host
                    .trim_end_matches('.')
                    .split('.')
                    .all(|label| !label.is_empty()
                        && label.len() <= 63
                        && !label.starts_with('-')
                        && !label.ends_with('-')
                        && label
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')),
            "Invalid gift ICE host."
        );
        (host, port)
    };
    anyhow::ensure!(!host.is_empty(), "Invalid gift ICE host.");
    if let Some(port) = port {
        anyhow::ensure!(
            !port.is_empty()
                && port.bytes().all(|byte| byte.is_ascii_digit())
                && port.parse::<u16>().is_ok_and(|port| port > 0),
            "Invalid gift ICE port."
        );
    }
    Ok(turn)
}

impl Connectivity {
    pub(crate) fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.ice_servers.len() <= MAX_SERVERS,
            "Too many gift ICE servers."
        );
        let mut urls = HashSet::new();
        let mut has_turn = false;
        for server in &self.ice_servers {
            anyhow::ensure!(
                !server.urls.is_empty() && server.urls.len() <= MAX_SERVER_URLS,
                "Invalid gift ICE URL count."
            );
            let mut kind = None;
            for url in &server.urls {
                let turn = is_turn_url(url)?;
                anyhow::ensure!(
                    kind.is_none_or(|kind| kind == turn),
                    "Mixed STUN/TURN server entry."
                );
                kind = Some(turn);
                anyhow::ensure!(
                    urls.insert(url.as_str()) && urls.len() <= MAX_URLS,
                    "Duplicate or excessive gift ICE URLs."
                );
            }
            if kind == Some(true) {
                has_turn = true;
                anyhow::ensure!(self.relay_allowed, "Gift relay requires owner opt-in.");
                match (
                    &server.username,
                    &server.credential,
                    &server.turn_rest_secret,
                ) {
                    (None, None, Some(secret))
                        if secret.len() >= 32 && credential(secret, MAX_CREDENTIAL_BYTES) => {}
                    (Some(username), Some(password), None)
                        if credential(username, MAX_USERNAME_BYTES)
                            && credential(password, MAX_CREDENTIAL_BYTES) => {}
                    _ => return Err(invalid()),
                }
            } else {
                anyhow::ensure!(
                    server.username.is_none()
                        && server.credential.is_none()
                        && server.turn_rest_secret.is_none(),
                    "STUN must not carry credentials."
                );
            }
        }
        anyhow::ensure!(
            !self.require_relay || (self.relay_allowed && has_turn),
            "Relay-only requires a configured TURN server."
        );
        Ok(())
    }

    pub(crate) fn redacted(&self) -> anyhow::Result<serde_json::Value> {
        self.validate()?;
        Ok(serde_json::json!({
            "iceServers": self.ice_servers.iter().map(|server| serde_json::json!({
                "urls": server.urls,
                "usernameConfigured": server.username.is_some(),
                "credentialConfigured": server.credential.is_some(),
                "turnRestSecretConfigured": server.turn_rest_secret.is_some(),
            })).collect::<Vec<_>>(),
            "relayAllowed": self.relay_allowed, "requireRelay": self.require_relay,
        }))
    }

    /// Requires an explicitly configured coturn-compatible TURN REST shared
    /// secret for TURN invites. Static owner credentials have no bounded expiry
    /// and must never be copied into a recipient's signed preview.
    pub(crate) fn for_invitation(
        &self,
        gift_id: &str,
        expires_at: u64,
        now: u64,
    ) -> anyhow::Result<ConnectivityConfig> {
        self.validate()?;
        anyhow::ensure!(
            (16..=128).contains(&gift_id.len())
                && gift_id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
            "Invalid ICE invitation identity."
        );
        anyhow::ensure!(
            expires_at > now
                && expires_at <= now.saturating_add(crate::share::GIFT_MAX_LIFETIME_SECONDS),
            "Invalid ICE invitation lifetime."
        );
        let mut sender_servers = Vec::new();
        let mut recipient_servers = Vec::new();
        for server in &self.ice_servers {
            let turn = is_turn_url(&server.urls[0])?;
            let (sender_username, sender_password, recipient_username, recipient_password) = if turn
            {
                let secret = server.turn_rest_secret.as_ref().ok_or_else(|| {
                    anyhow::anyhow!(
                        "Recipient TURN credentials require a private TURN REST secret."
                    )
                })?;
                let (sender_username, sender_password) =
                    turn_rest(secret, gift_id, expires_at, "sender");
                let (recipient_username, recipient_password) =
                    turn_rest(secret, gift_id, expires_at, "recipient");
                (
                    Some(sender_username),
                    Some(sender_password),
                    Some(recipient_username),
                    Some(recipient_password),
                )
            } else {
                (None, None, None, None)
            };
            let rtc = RTCIceServer {
                urls: server.urls.clone(),
                username: sender_username.unwrap_or_default(),
                credential: sender_password.unwrap_or_default(),
            };
            // Exercise the dependency's real parser too; do not include its
            // errors or configuration Debug output, which could expose secrets.
            rtc.urls().map_err(|_| invalid())?;
            sender_servers.push(rtc);
            recipient_servers.push(RecipientIceServer {
                urls: server.urls.clone(),
                username: recipient_username,
                credential: recipient_password,
            });
        }
        Ok(ConnectivityConfig {
            sender_servers,
            recipient: Some(RecipientConnectivity {
                gift_id: gift_id.to_owned(),
                expires_at,
                ice_servers: recipient_servers,
                ice_transport_policy: if self.require_relay { "relay" } else { "all" },
            }),
            require_relay: self.require_relay,
        })
    }
}

fn turn_rest(secret: &str, gift_id: &str, expires_at: u64, role: &str) -> (String, String) {
    let nonce = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 16]>());
    let username = format!("{expires_at}:operalibre:{gift_id}:{role}:{nonce}");
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, secret.as_bytes());
    let password = STANDARD.encode(ring::hmac::sign(&key, username.as_bytes()).as_ref());
    (username, password)
}

impl ConnectivityConfig {
    pub(crate) fn rtc_configuration(&self) -> RTCConfiguration {
        RTCConfigurationBuilder::new()
            .with_ice_servers(self.sender_servers.clone())
            .with_ice_transport_policy(if self.require_relay {
                RTCIceTransportPolicy::Relay
            } else {
                RTCIceTransportPolicy::All
            })
            .build()
    }

    pub(crate) fn recipient_configuration(&self) -> Option<&RecipientConnectivity> {
        self.recipient.as_ref()
    }

    pub(crate) fn validate_invitation(
        &self,
        gift_id: &str,
        expires_at: u64,
        now: u64,
    ) -> anyhow::Result<()> {
        if let Some(recipient) = &self.recipient {
            anyhow::ensure!(
                recipient.gift_id == gift_id
                    && recipient.expires_at == expires_at
                    && now < expires_at,
                "ICE invitation binding mismatch or expiry."
            );
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "share_connectivity_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "share_connectivity_transport_tests.rs"]
mod transport_tests;
