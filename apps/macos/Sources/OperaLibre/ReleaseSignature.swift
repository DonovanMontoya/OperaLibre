import CryptoKit
import Foundation

/// The signed update manifest. The contract is docs/update-manifest.md; the signer is
/// script/release_signing.mjs and the server's verifier is apps/server/src/update_manifest.rs.
/// Keep all three in step. Unknown fields, components and formats are ignored, so later
/// releases can extend the manifest without stranding this build.

/// Always the newest release's manifest; GitHub redirects this address to it.
let updateManifestURL = URL(
    string: "https://github.com/DonovanMontoya/OperaLibre/releases/latest/download/operalibre-manifest-v1.json"
)!
/// Root version 1: the keys this build trusts out of the box. Later roots are learned from
/// the rotations a manifest carries. Must match `rootKeys` in release/update-trust.json.
let releaseRootKeys = [
    "FhUko6re8/stEbHmAlnNv3+SwIzMSXNMUpPVl8BVifk=",
    // Offline backup key; it signs only key rotations.
    "ZRqn6x4T1s5YydV/orpMeF1Ec4VgpLXq7EUgAFIn0Ns=",
]
let updateManifestSchema = 1
let maxUpdateManifestBytes = 1024 * 1024
/// The key rotations this install has accepted. Verification starts from them, so a later
/// manifest that leaves a rotation out cannot be accepted under a key that rotation retired.
let acceptedRootsFileName = "update-roots.json"

struct UpdatePackage: Decodable {
    let component: String
    let platform: String
    let version: String
    let url: String
    let sha256: String
    let size: Int
    let format: String
    let root: String
}

struct UpdateNotice: Decodable {
    let message: String
    let url: String?
}

struct UpdateBridge: Decodable {
    let component: String?
    let below: String
    let manifest: String
}

struct UpdateManifest: Decodable {
    let type: String
    let schema: Int
    let version: String
    let releaseUrl: String
    let notice: UpdateNotice?
    let redirect: String?
    let bridges: [UpdateBridge]?
    let packages: [UpdatePackage]?

    /// The first package for the component whose fields this build can use.
    func package(_ component: String) -> UpdatePackage? {
        packages?.first { package in
            package.component == component
                && package.platform == "any"
                && package.format == "zip"
                && package.url.hasPrefix("https://")
                && package.size > 0
                && package.sha256.count == 64
                && package.sha256.allSatisfy(\.isHexDigit)
                && !package.root.isEmpty
                && !package.root.hasPrefix(".")
                && !package.root.contains("/")
        }
    }
}

struct SignedEnvelope: Codable {
    let payload: String
    let signatures: [EnvelopeSignature]?
    let roots: [SignedEnvelope]?
}

struct EnvelopeSignature: Codable {
    let keyid: String
    let sig: String
}

private struct RootPayload: Decodable {
    struct Key: Decodable {
        let keyid: String
        let publicKey: String
    }
    let type: String
    let version: Int
    let threshold: Int
    let keys: [Key]
}

struct TrustedRoot {
    let version: Int
    let threshold: Int
    let keys: [(id: String, key: Curve25519.Signing.PublicKey)]
    /// The signed rotations that led here from the built-in root.
    private(set) var rotations: [SignedEnvelope] = []

    init?(version: Int, threshold: Int, publicKeys: [String]) {
        var keys: [(id: String, key: Curve25519.Signing.PublicKey)] = []
        for base64 in publicKeys {
            guard let raw = Data(base64Encoded: base64),
                let key = try? Curve25519.Signing.PublicKey(rawRepresentation: raw)
            else { return nil }
            keys.append((updateKeyID(raw), key))
        }
        guard threshold > 0, threshold <= keys.count else { return nil }
        self.version = version
        self.threshold = threshold
        self.keys = keys
    }

    static var builtIn: TrustedRoot? {
        TrustedRoot(version: 1, threshold: 1, publicKeys: releaseRootKeys)
    }

    func verifies(_ envelope: SignedEnvelope, type: String) -> Bool {
        let message = updateEnvelopeMessage(type: type, payload: envelope.payload)
        var verified = Set<String>()
        for signature in envelope.signatures ?? [] {
            guard let entry = keys.first(where: { $0.id == signature.keyid }),
                !verified.contains(entry.id),
                let bytes = Data(base64Encoded: signature.sig.trimmingCharacters(in: .whitespacesAndNewlines)),
                bytes.count == 64,
                entry.key.isValidSignature(bytes, for: message)
            else { continue }
            verified.insert(entry.id)
        }
        return verified.count >= threshold
    }

    /// Applies each rotation that follows this root in sequence. A new root must be signed
    /// by the current root's keys and by its own.
    func rotated(by rotations: [SignedEnvelope]) -> TrustedRoot {
        var current = self
        for rotation in rotations {
            guard let payload = try? JSONDecoder().decode(RootPayload.self, from: Data(rotation.payload.utf8)),
                payload.type == "root",
                payload.version == current.version + 1,
                payload.keys.allSatisfy({ entry in
                    Data(base64Encoded: entry.publicKey).map(updateKeyID) == entry.keyid
                }),
                var next = TrustedRoot(
                    version: payload.version,
                    threshold: payload.threshold,
                    publicKeys: payload.keys.map(\.publicKey)
                ),
                current.verifies(rotation, type: "root"),
                next.verifies(rotation, type: "root")
            else { continue }
            next.rotations = current.rotations
                + [SignedEnvelope(payload: rotation.payload, signatures: rotation.signatures, roots: nil)]
            current = next
        }
        return current
    }

    /// This root advanced by the rotations saved at `file`. Each one is verified again, so
    /// the file can only move trust along rotations the release keys signed. A missing or
    /// damaged file changes nothing, and the next manifest teaches the rotations again.
    func withSavedRotations(at file: URL) -> TrustedRoot {
        guard let data = try? Data(contentsOf: file),
            let saved = try? JSONDecoder().decode(AcceptedRoots.self, from: data)
        else { return self }
        return rotated(by: saved.rotations)
    }

    func saveRotations(to file: URL) throws {
        try FileManager.default.createDirectory(
            at: file.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try JSONEncoder().encode(AcceptedRoots(rotations: rotations)).write(to: file, options: .atomic)
    }
}

private struct AcceptedRoots: Codable {
    let rotations: [SignedEnvelope]
}

/// First 8 bytes of the SHA-256 of the raw public key, as hex.
func updateKeyID(_ rawPublicKey: Data) -> String {
    String(SHA256.hash(data: rawPublicKey).map { String(format: "%02x", $0) }.joined().prefix(16))
}

func updateEnvelopeMessage(type: String, payload: String) -> Data {
    Data("operalibre-signed-v1\n\(type)\n".utf8) + Data(payload.utf8)
}

enum UpdateManifestError: LocalizedError {
    case tooLarge
    case malformed
    case untrusted
    case unsupportedSchema(Int)

    var errorDescription: String? {
        switch self {
        case .tooLarge:
            return "The update manifest is too large."
        case .malformed:
            return "The update manifest is not valid."
        case .untrusted:
            return "The update manifest is not signed by a trusted OperaLibre release key."
        case .unsupportedSchema(let schema):
            return "The update manifest uses schema \(schema), which this version cannot read."
        }
    }
}

/// Collects a manifest response body, giving up as soon as it passes `maxUpdateManifestBytes`
/// so an unsigned response cannot make this app hold more than that. `declaredLength` is the
/// response's Content-Length, negative when it has none; the bytes are counted either way,
/// because the header is only the sender's claim.
func readUpdateManifestBody<Bytes: AsyncSequence>(
    _ bytes: Bytes,
    declaredLength: Int64
) async throws -> Data where Bytes.Element == UInt8 {
    guard declaredLength <= Int64(maxUpdateManifestBytes) else {
        throw UpdateManifestError.tooLarge
    }
    var body = Data()
    for try await byte in bytes {
        guard body.count < maxUpdateManifestBytes else {
            throw UpdateManifestError.tooLarge
        }
        body.append(byte)
    }
    return body
}

/// Verifies a manifest file's signatures, following any key rotations it carries. Nothing in
/// an unverified file is used. `root` is left at the root that signed the manifest, so the
/// rotations it followed stay in force for whatever is verified next.
func verifyUpdateManifest(_ data: Data, root: inout TrustedRoot) throws -> UpdateManifest {
    guard data.count <= maxUpdateManifestBytes,
        let envelope = try? JSONDecoder().decode(SignedEnvelope.self, from: data)
    else {
        throw UpdateManifestError.malformed
    }
    let rotated = root.rotated(by: envelope.roots ?? [])
    guard rotated.verifies(envelope, type: "manifest") else {
        throw UpdateManifestError.untrusted
    }
    root = rotated
    guard let manifest = try? JSONDecoder().decode(UpdateManifest.self, from: Data(envelope.payload.utf8)),
        manifest.type == "manifest"
    else {
        throw UpdateManifestError.malformed
    }
    guard manifest.schema == updateManifestSchema else {
        throw UpdateManifestError.unsupportedSchema(manifest.schema)
    }
    return manifest
}
