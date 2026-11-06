//! Experimental transcript proof; not connected to production entry points.
use ring::hmac;
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PeerProofBinding {
    pub(crate) room: String,
    pub(crate) gift_id: String,
    pub(crate) expires_at: u64,
    pub(crate) generation: u64,
    pub(crate) archive_size: u64,
    pub(crate) archive_sha256: String,
    pub(crate) offset: u64,
    pub(crate) prefix_sha256: String,
    pub(crate) challenge: String,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn id(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn transcript(
    binding: &PeerProofBinding,
    offer: &str,
    answer: &str,
    now: u64,
) -> anyhow::Result<String> {
    const MAX_SIZE: u64 = 25 * 1024 * 1024 * 1024;
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    let challenge = URL_SAFE_NO_PAD.decode(&binding.challenge)?;
    anyhow::ensure!(
        id(&binding.room)
            && id(&binding.gift_id)
            && binding.expires_at > now
            && binding.expires_at <= 9_007_199_254_740_991
            && binding.generation <= 9_007_199_254_740_991
            && binding.archive_size > 0
            && binding.archive_size <= MAX_SIZE
            && binding.offset <= binding.archive_size
            && digest(&binding.archive_sha256)
            && digest(&binding.prefix_sha256)
            && challenge.len() == 32
            && URL_SAFE_NO_PAD.encode(challenge) == binding.challenge,
        "invalid peer proof binding"
    );
    anyhow::ensure!(
        !offer.is_empty() && offer.len() <= 4096 && !answer.is_empty() && answer.len() <= 4096,
        "invalid peer descriptions"
    );
    Ok(format!(
        "operalibre-peer-proof-v1\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
        binding.room,
        binding.gift_id,
        binding.expires_at,
        binding.generation,
        binding.archive_size,
        binding.archive_sha256,
        binding.offset,
        binding.prefix_sha256,
        binding.challenge,
        hex(&Sha256::digest(offer.as_bytes())),
        hex(&Sha256::digest(answer.as_bytes()))
    ))
}

pub(crate) fn verify_peer_proof(
    key: &[u8; 32],
    binding: &PeerProofBinding,
    offer: &str,
    answer: &str,
    now: u64,
    proof: &[u8],
) -> anyhow::Result<()> {
    let transcript = transcript(binding, offer, answer, now)?;
    let base = hmac::Key::new(hmac::HMAC_SHA256, key);
    let derived = hmac::sign(&base, b"operalibre-peer-proof-key-v1");
    hmac::verify(
        &hmac::Key::new(hmac::HMAC_SHA256, derived.as_ref()),
        transcript.as_bytes(),
        proof,
    )
    .map_err(|_| anyhow::anyhow!("peer proof authentication failed"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binds_offer_answer_archive_generation_and_expiry() {
        let key = [7_u8; 32];
        let mut binding = PeerProofBinding {
            room: "room____________".into(),
            gift_id: "gift____________".into(),
            expires_at: 100,
            generation: 1,
            archive_size: 100,
            archive_sha256: "a".repeat(64),
            offset: 12,
            prefix_sha256: "b".repeat(64),
            challenge: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM".into(),
        };
        let message = transcript(&binding, "offer", "answer", 90).unwrap();
        let base = hmac::Key::new(hmac::HMAC_SHA256, &key);
        let derived = hmac::sign(&base, b"operalibre-peer-proof-key-v1");
        let tag = hmac::sign(
            &hmac::Key::new(hmac::HMAC_SHA256, derived.as_ref()),
            message.as_bytes(),
        );
        assert_eq!(
            hex(tag.as_ref()),
            "43818e2473d196a965da58367cc94046519460199ad6ed70b004435feca37fee"
        );
        assert!(verify_peer_proof(&key, &binding, "offer", "answer", 90, tag.as_ref()).is_ok());
        assert!(verify_peer_proof(&key, &binding, "offer!", "answer", 90, tag.as_ref()).is_err());
        assert!(verify_peer_proof(&key, &binding, "offer", "answer!", 90, tag.as_ref()).is_err());
        assert!(verify_peer_proof(&key, &binding, "offer", "answer", 100, tag.as_ref()).is_err());
        binding.generation += 1;
        assert!(verify_peer_proof(&key, &binding, "offer", "answer", 90, tag.as_ref()).is_err());
        binding.generation -= 1;
        binding.offset += 1;
        assert!(verify_peer_proof(&key, &binding, "offer", "answer", 90, tag.as_ref()).is_err());
        assert!(
            verify_peer_proof(&[8_u8; 32], &binding, "offer", "answer", 90, tag.as_ref()).is_err()
        );
    }
}
