import Foundation

// The vector script/release_signing.test.mjs produces from its test-only seed (the bytes
// 0..31), so the Node signer and this verifier must agree on the message byte for byte.
private let testPublicKey = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg="
private let testFrontendSignature =
    "S+dfVq5MbRa7X9TiSmWdMb8qv4UBayZ3Pyvq3czipsJY4dwCmJrHejnU9Rh8MFjW7I0vDGxFpDSb3AP0dfZTBQ=="

@main
struct ReleaseSignatureTests {
    static func main() {
        let frontend = "operalibre-1.2.3-frontend.zip"
        let digest = String(repeating: "b", count: 64)
        func verifies(_ tag: String, _ name: String, _ digest: String, _ signature: String, key: String = testPublicKey) -> Bool {
            verifyReleaseSignature(publicKeyBase64: key, tag: tag, assetName: name, sha256Hex: digest, signatureBase64: signature)
        }

        precondition(verifies("v1.2.3", frontend, digest, testFrontendSignature))
        precondition(verifies("v1.2.3", frontend, digest.uppercased(), testFrontendSignature + "\n"))
        precondition(!verifies("v1.2.2", frontend, digest, testFrontendSignature))
        precondition(!verifies("v1.2.3", "operalibre-1.2.3-update-macos-arm64.zip", digest, testFrontendSignature))
        precondition(!verifies("v1.2.3", frontend, String(repeating: "c", count: 64), testFrontendSignature))
        precondition(!verifies("v1.2.3", frontend, digest, "not base64!"))
        precondition(!verifies("v1.2.3", frontend, digest, "AAAA"))
        precondition(!verifies("v1.2.3", frontend, digest, testFrontendSignature, key: "not-a-key"))

        // The placeholder must never ship: every frontend update would be refused.
        precondition(
            Data(base64Encoded: releaseSigningPublicKey)?.count == 32,
            "releaseSigningPublicKey is not a 32-byte base64 key"
        )
        print("Release signature tests passed")
    }
}
