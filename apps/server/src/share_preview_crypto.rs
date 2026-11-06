//! Experimental signed/encrypted preview envelopes. Not exposed by routes.
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use serde::{Deserialize, Serialize};

const MAX_PREVIEW: usize = 128 * 1024;
const CONTEXT: &[u8] = b"operalibre-gift-preview-v1";

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
