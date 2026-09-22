import CryptoKit
import Foundation

/// Base64 Ed25519 public key every downloaded release asset must be signed with. The
/// matching private key is the release workflow's OPERALIBRE_RELEASE_SIGNING_KEY secret;
/// see script/release_signing.mjs.
let releaseSigningPublicKey = "FhUko6re8/stEbHmAlnNv3+SwIzMSXNMUpPVl8BVifk="
let releaseSignatureSuffix = ".sig"
let maxReleaseSignatureBytes = 1024

/// What a release signature covers. Binding the tag and the asset name means a signature
/// can neither be moved to another file nor replayed from an older release. Must match
/// signingMessage in script/release_signing.mjs and the server's updates.rs.
func releaseSigningMessage(tag: String, assetName: String, sha256Hex: String) -> Data {
    Data("operalibre-release-asset-v1\n\(tag)\n\(assetName)\n\(sha256Hex.lowercased())".utf8)
}

func verifyReleaseSignature(
    publicKeyBase64: String,
    tag: String,
    assetName: String,
    sha256Hex: String,
    signatureBase64: String
) -> Bool {
    guard let keyData = Data(base64Encoded: publicKeyBase64),
        let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: keyData),
        let signature = Data(base64Encoded: signatureBase64.trimmingCharacters(in: .whitespacesAndNewlines)),
        signature.count == 64
    else {
        return false
    }
    return publicKey.isValidSignature(
        signature,
        for: releaseSigningMessage(tag: tag, assetName: assetName, sha256Hex: sha256Hex)
    )
}
