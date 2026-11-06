//! Experimental signed/encrypted preview envelopes. Not exposed by routes.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use serde::{Deserialize, Serialize};

const MAX_PREVIEW: usize = 128 * 1024;
const CONTEXT: &[u8] = b"operalibre-gift-preview-v1";
const PEER_CONTEXT: &[u8] = b"operalibre-gift-peer-offer-v1\0";
const MAX_OFFER: usize = 64 * 1024;

/// The offer must contain the complete, gathered SDP including ICE candidates.
/// The challenge is a fresh 32-byte random value supplied by the recipient.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PeerOffer<'a> {
    pub(crate) version: u8,
    pub(crate) gift_id: &'a str,
    pub(crate) room: &'a str,
    pub(crate) expires_at: u64,
    pub(crate) archive_size: u64,
    pub(crate) archive_sha256: &'a str,
    pub(crate) generation: u64,
    pub(crate) offset: u64,
    pub(crate) prefix_sha256: &'a str,
    pub(crate) challenge: &'a str,
    pub(crate) offer: &'a str,
}

#[derive(Serialize)]
pub(crate) struct SignedPeerOffer {
    pub(crate) payload: String,
    pub(crate) signature: String,
}

/// Sign only after checking that these values come from the selected archive,
/// link, recovery request, and actual local description, not broker assertions.
pub(crate) fn sign_peer_offer(
    offer: &PeerOffer<'_>,
    signing: &SigningKey,
) -> anyhow::Result<SignedPeerOffer> {
    let valid_id = |s: &str| {
        (16..=128).contains(&s.len())
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    };
    let valid_hash = |s: &str| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    let challenge = URL_SAFE_NO_PAD.decode(offer.challenge)?;
    anyhow::ensure!(
        offer.version == 1
            && valid_id(offer.gift_id)
            && valid_id(offer.room)
            && offer.expires_at <= crate::share_broker::MAX_GENERATION
            && offer.expires_at > 0
            && offer.archive_size > 0
            && offer.archive_size <= 25 * 1024 * 1024 * 1024
            && valid_hash(offer.archive_sha256)
            && offer.generation <= crate::share_broker::MAX_GENERATION
            && offer.offset <= offer.archive_size
            && valid_hash(offer.prefix_sha256)
            && challenge.len() == 32
            && URL_SAFE_NO_PAD.encode(challenge) == offer.challenge
            && !offer.offer.is_empty()
            && offer.offer.len() <= MAX_OFFER,
        "invalid peer offer"
    );
    let payload = serde_json::to_vec(offer)?;
    let mut message = Vec::with_capacity(PEER_CONTEXT.len() + payload.len());
    message.extend_from_slice(PEER_CONTEXT);
    message.extend_from_slice(&payload);
    Ok(SignedPeerOffer {
        payload: URL_SAFE_NO_PAD.encode(payload),
        signature: URL_SAFE_NO_PAD.encode(signing.sign(&message).to_bytes()),
    })
}

#[derive(Serialize, Deserialize)]
pub(crate) struct EncryptedPreview {
    pub(crate) nonce: String,
    pub(crate) ciphertext: String,
}

/// Construct the signed payload from the scanned book and the receipt of the
/// archive actually written, rather than any client-supplied file hashes.
pub(crate) fn preview_from_archive(
    book: &crate::Book,
    sender: &str,
    message: Option<&str>,
    gift_id: &str,
    room: &str,
    expires_at: u64,
    receipt: &crate::share::VerifiedArchive,
) -> anyhow::Result<serde_json::Value> {
    let valid_id = |value: &str| {
        (16..=128).contains(&value.len())
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    };
    anyhow::ensure!(
        valid_id(gift_id) && valid_id(room),
        "invalid preview identity"
    );
    anyhow::ensure!(
        !sender.trim().is_empty()
            && sender.encode_utf16().count() <= 128
            && !book.title.trim().is_empty()
            && book.title.encode_utf16().count() <= 1024,
        "invalid preview text"
    );
    anyhow::ensure!(
        message.is_none_or(|value| value.encode_utf16().count() <= 1000)
            && book
                .author
                .as_ref()
                .is_none_or(|value| value.encode_utf16().count() <= 1024)
            && book
                .description
                .as_ref()
                .is_none_or(|value| value.encode_utf16().count() <= 32000),
        "preview text too large"
    );
    anyhow::ensure!(
        !receipt.assets.is_empty() && receipt.size > 0 && receipt.size <= 25 * 1024 * 1024 * 1024,
        "invalid archive receipt"
    );
    let has_ebook = receipt
        .assets
        .iter()
        .any(|asset| matches!(asset.kind, crate::share::ShareAssetKind::Ebook));
    let has_audio = receipt
        .assets
        .iter()
        .any(|asset| matches!(asset.kind, crate::share::ShareAssetKind::Audio));
    let has_alignment = receipt
        .assets
        .iter()
        .any(|asset| matches!(asset.kind, crate::share::ShareAssetKind::Alignment));
    anyhow::ensure!(
        (has_ebook || has_audio) && (!has_alignment || (has_ebook && has_audio)),
        "invalid selected asset dependencies"
    );
    Ok(
        serde_json::json!({"version": 1, "giftId": gift_id, "room": room, "expiresAt": expires_at, "archiveSize": receipt.size, "archiveSha256": receipt.sha256, "sender": sender, "title": book.title, "author": book.author, "summary": book.description, "message": message, "assets": receipt.assets}),
    )
}

/// The caller must construct `payload` exclusively from trusted server data.
/// The encryption key and verifying key belong in the recipient's link
/// fragment, never in the broker request. Generates a new random GCM nonce.
pub(crate) fn encrypt_signed_preview<T: Serialize>(
    payload: &T,
    signing: &SigningKey,
    encryption_key: &[u8; 32],
) -> anyhow::Result<EncryptedPreview> {
    let payload = serde_json::to_vec(payload)?;
    anyhow::ensure!(
        payload.len() <= MAX_PREVIEW / 2,
        "preview payload too large"
    );
    let signature = signing.sign(&payload).to_bytes();
    let mut plaintext = serde_json::to_vec(
        &serde_json::json!({"payload": URL_SAFE_NO_PAD.encode(payload), "signature": URL_SAFE_NO_PAD.encode(signature)}),
    )?;
    anyhow::ensure!(
        plaintext.len() + 16 <= MAX_PREVIEW,
        "preview envelope too large"
    );
    let nonce_bytes: [u8; 12] = rand::random();
    let key = LessSafeKey::new(
        UnboundKey::new(&AES_256_GCM, encryption_key)
            .map_err(|_| anyhow::anyhow!("invalid preview key"))?,
    );
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce_bytes),
        Aad::from(CONTEXT),
        &mut plaintext,
    )
    .map_err(|_| anyhow::anyhow!("preview encryption failed"))?;
    Ok(EncryptedPreview {
        nonce: URL_SAFE_NO_PAD.encode(nonce_bytes),
        ciphertext: URL_SAFE_NO_PAD.encode(plaintext),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peer_offer_signs_domain_separated_exact_payload() {
        use ed25519_dalek::{Signature, Verifier};
        let signing = SigningKey::from_bytes(&[1; 32]);
        let challenge = URL_SAFE_NO_PAD.encode([3_u8; 32]);
        let hash = "a".repeat(64);
        let mut offer = PeerOffer {
            version: 1,
            gift_id: "gift____________",
            room: "room____________",
            expires_at: 200,
            archive_size: 22,
            archive_sha256: &hash,
            generation: 2,
            offset: 4,
            prefix_sha256: &hash,
            challenge: &challenge,
            offer: "v=0\r\na=candidate:1\r\n",
        };
        let signed = sign_peer_offer(&offer, &signing).unwrap();
        let payload = URL_SAFE_NO_PAD.decode(&signed.payload).unwrap();
        let signature =
            Signature::from_slice(&URL_SAFE_NO_PAD.decode(&signed.signature).unwrap()).unwrap();
        let mut message = PEER_CONTEXT.to_vec();
        message.extend_from_slice(&payload);
        assert!(signing.verifying_key().verify(&message, &signature).is_ok());
        assert!(
            signing
                .verifying_key()
                .verify(&payload, &signature)
                .is_err()
        );
        offer.offset = 23;
        assert!(sign_peer_offer(&offer, &signing).is_err());
        if let Some(path) = std::env::var_os("OPERALIBRE_PEER_FIXTURE_PATH") {
            let fixture = serde_json::json!({"signed":signed,"publicKey":URL_SAFE_NO_PAD.encode(signing.verifying_key().to_bytes()),"binding":serde_json::from_slice::<serde_json::Value>(&payload).unwrap()});
            std::fs::write(path, serde_json::to_vec(&fixture).unwrap()).unwrap();
        }
    }
    #[test]
    fn optional_cross_runtime_fixture() {
        let Some(path) = std::env::var_os("OPERALIBRE_PREVIEW_FIXTURE_PATH") else {
            return;
        };
        let signing = SigningKey::from_bytes(&[1; 32]);
        let encryption = [2_u8; 32];
        let preview = serde_json::json!({"version":1,"giftId":"gift____________","room":"room____________","expiresAt":200,"archiveSize":22,"archiveSha256":"a".repeat(64),"sender":"Alex","title":"A book","author":"A writer","summary":"A summary","message":"Private note","assets":[{"name":"book.epub","kind":"ebook","size":12,"sha256":"b".repeat(64)}]});
        let envelope = encrypt_signed_preview(&preview, &signing, &encryption).unwrap();
        let fixture = serde_json::json!({"envelope":envelope,"key":URL_SAFE_NO_PAD.encode(encryption),"publicKey":URL_SAFE_NO_PAD.encode(signing.verifying_key().to_bytes())});
        std::fs::write(path, serde_json::to_vec(&fixture).unwrap()).unwrap();
    }
}
