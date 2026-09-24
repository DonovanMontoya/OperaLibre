import Foundation

// Checks the manifest fixture script/release_signing.test.mjs writes from test-only keys, so
// the Node signer and this verifier must agree byte for byte. Run from the repository root.

@main
struct ReleaseSignatureTests {
    static func main() {
        let fixtureData = try! Data(contentsOf: URL(fileURLWithPath: "script/fixtures/update-manifest.json"))
        let fixture = try! JSONSerialization.jsonObject(with: fixtureData) as! [String: Any]
        let root = TrustedRoot(version: 1, threshold: 1, publicKeys: fixture["rootKeys"] as! [String])!
        let untrusted = TrustedRoot(version: 1, threshold: 1, publicKeys: [fixture["otherKey"] as! String])!
        func envelope(_ value: Any) -> Data {
            try! JSONSerialization.data(withJSONObject: value)
        }
        func verifies(_ value: Any, _ root: TrustedRoot) -> UpdateManifest? {
            try? verifyUpdateManifest(envelope(value), root: root)
        }

        // A manifest signed by a root key, with fields and components this build ignores.
        let direct = fixture["direct"] as! [String: Any]
        let manifest = verifies(direct, root)
        precondition(manifest?.version == "1.2.3")
        precondition(manifest?.package("frontend")?.root == "operalibre-1.2.3-frontend")
        precondition(manifest?.package("server") == nil, "platform packages are not frontend packages")
        precondition(verifies(direct, untrusted) == nil)

        var tampered = direct
        tampered["payload"] = (direct["payload"] as! String).replacingOccurrences(of: "1.2.3", with: "9.9.9")
        precondition(verifies(tampered, root) == nil)

        // A rotated key is trusted only through a rotation both keys signed.
        let rotated = fixture["rotated"] as! [String: Any]
        precondition(verifies(rotated, root)?.version == "1.2.4")
        var withoutRotation = rotated
        withoutRotation["roots"] = []
        precondition(verifies(withoutRotation, root) == nil)
        var rotations = rotated["roots"] as! [[String: Any]]
        let signatures = rotations[0]["signatures"] as! [Any]
        rotations[0]["signatures"] = [signatures[1]]
        var forgedRotation = rotated
        forgedRotation["roots"] = rotations
        precondition(verifies(forgedRotation, root) == nil)

        // A root's signature must not pass for a manifest's.
        precondition(verifies((rotated["roots"] as! [Any])[0], root) == nil)

        precondition(TrustedRoot.builtIn != nil, "releaseRootKeys must be valid Ed25519 keys")
        print("Release signature tests passed")
    }
}
