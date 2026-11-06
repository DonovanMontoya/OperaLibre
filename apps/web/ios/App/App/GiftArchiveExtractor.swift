#if OPERALIBRE_EXPERIMENTAL_GIFTS
import Foundation
import CoreFoundation
import CryptoKit
import Darwin
import ZIPFoundation
import Capacitor

/// Experimental staged extraction; it is not registered as a Capacitor plugin.
enum GiftArchiveExtractor {
    struct Asset {
        let name: String
        let size: UInt64
        let sha256: String
    }
    enum Failure: Error { case invalid, duplicate, unavailable, integrity, noSpace }
    private static let maxBytes: UInt64 = 25 * 1024 * 1024 * 1024
    private static let minimumFree: UInt64 = 256 * 1024 * 1024
    private static let lock = NSLock()

    /// Commits extracted files to a private directory. The caller must publish
    /// the local-library index separately and recover an interrupted publication.
    static func extract(archiveURL: URL, privateRoot: URL, giftID: String, assets: [Asset]) throws -> URL {
        guard giftID.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil,
              !assets.isEmpty, assets.count <= 256 else { throw Failure.invalid }
        var expected: [String: Asset] = [:]
        var declared: UInt64 = 0
        for asset in assets {
            guard !asset.name.isEmpty, asset.name != ".", asset.name != "..",
                  asset.name.utf8.count <= 255,
                  !asset.name.contains("/"), !asset.name.contains("\\"),
                  asset.name.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }),
                  asset.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                  asset.size <= maxBytes, declared <= maxBytes - asset.size,
                  expected.updateValue(asset, forKey: asset.name) == nil else { throw Failure.invalid }
            declared += asset.size
        }
        lock.lock(); defer { lock.unlock() }
        let fm = FileManager.default
        var isDirectory: ObjCBool = false
        guard fm.fileExists(atPath: privateRoot.path, isDirectory: &isDirectory), isDirectory.boolValue else { throw Failure.unavailable }
        let root = privateRoot.resolvingSymlinksInPath().standardizedFileURL
        let lockURL = root.appendingPathComponent(".gift-lock-" + giftID)
        let fd = open(lockURL.path, O_CREAT | O_RDWR | O_NOFOLLOW, mode_t(0o600))
        guard fd >= 0 else { throw Failure.unavailable }
        defer { close(fd) }
        guard flock(fd, LOCK_EX) == 0 else { throw Failure.unavailable }
        defer { flock(fd, LOCK_UN) }
        let destination = root.appendingPathComponent("gift-" + giftID, isDirectory: true)
        if fm.fileExists(atPath: destination.path) {
            try verifyCommitted(destination, expected: expected)
            return destination
        }
        let staging = root.appendingPathComponent(".gift-staging-" + UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: staging, withIntermediateDirectories: false)
        do {
            let archive = try Archive(url: archiveURL, accessMode: .read)
            var seen = Set<String>()
            var total: UInt64 = 0
            for entry in archive {
                guard entry.type == .file, let asset = expected[entry.path],
                      seen.insert(entry.path).inserted, seen.count <= 256,
                      entry.uncompressedSize == asset.size else { throw Failure.invalid }
                let target = staging.appendingPathComponent(asset.name)
                guard fm.createFile(atPath: target.path, contents: nil) else { throw Failure.unavailable }
                let handle = try FileHandle(forWritingTo: target)
                defer { try? handle.close() }
                var hasher = SHA256()
                var written: UInt64 = 0
                let checksum = try archive.extract(entry) { data in
                    let count = UInt64(data.count)
                    guard count <= asset.size - written, count <= maxBytes - total else { throw Failure.invalid }
                    written += count; total += count
                    let free = (try fm.attributesOfFileSystem(forPath: staging.path)[.systemFreeSize] as? NSNumber)?.uint64Value ?? 0
                    guard free >= minimumFree else { throw Failure.noSpace }
                    hasher.update(data: data)
                    try handle.write(contentsOf: data)
                }
                try handle.synchronize()
                let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
                guard written == asset.size, checksum == entry.checksum, digest == asset.sha256 else { throw Failure.integrity }
            }
            guard seen.count == expected.count else { throw Failure.invalid }
            try fm.moveItem(at: staging, to: destination)
            return destination
        } catch {
            try? fm.removeItem(at: staging)
            throw error
        }
    }

    private static func verifyCommitted(_ directory: URL, expected: [String: Asset]) throws {
        let fm = FileManager.default
        guard directory.resolvingSymlinksInPath().standardizedFileURL == directory.standardizedFileURL else { throw Failure.invalid }
        let files = try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard files.count == expected.count else { throw Failure.integrity }
        for file in files {
            guard let asset = expected[file.lastPathComponent],
                  file.resolvingSymlinksInPath().standardizedFileURL == file.standardizedFileURL else { throw Failure.invalid }
            let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true,
                  let size = values.fileSize, size >= 0, UInt64(size) == asset.size else { throw Failure.integrity }
            let handle = try FileHandle(forReadingFrom: file)
            defer { try? handle.close() }
            var hash = SHA256()
            var total: UInt64 = 0
            while let data = try handle.read(upToCount: 64 * 1024), !data.isEmpty {
                guard UInt64(data.count) <= asset.size - total else { throw Failure.integrity }
                total += UInt64(data.count)
                hash.update(data: data)
            }
            let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
            guard total == asset.size, digest == asset.sha256 else { throw Failure.integrity }
        }
    }
}

/// Durable bearer state, serialized across plugin instances and processes.
/// No logs or bridge errors may contain records, paths, or underlying errors.
/// This record lock does not cover Filesystem.appendFile or transfer leases.
enum GiftRecoveryStore {
    private static let lock = NSLock()
    private static let maxState = 16 * 1024
    private static let maxArchive: Int64 = 25 * 1024 * 1024 * 1024
    private static let maxInteger: Int64 = 9_007_199_254_740_991
    private enum Failure: Error { case unavailable }

    private static func matches(_ value: String, _ pattern: String) -> Bool {
        guard let range = value.range(of: pattern, options: .regularExpression) else { return false }
        return range.lowerBound == value.startIndex && range.upperBound == value.endIndex
    }

    private static func regular(_ fd: Int32, limit: Int64) throws -> stat {
        var metadata = stat()
        guard fstat(fd, &metadata) == 0, (metadata.st_mode & S_IFMT) == S_IFREG,
              metadata.st_nlink == 1, metadata.st_size >= 0, metadata.st_size <= limit else { throw Failure.unavailable }
        return metadata
    }

    private static func locked<T>(_ giftID: String, _ operation: (URL) throws -> T) throws -> T {
        guard matches(giftID, "^[A-Za-z0-9_-]{16,128}$") else { throw Failure.unavailable }
        lock.lock(); defer { lock.unlock() }
        let fm = FileManager.default
        let data = try fm.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true).resolvingSymlinksInPath().standardizedFileURL
        var parent = data.appendingPathComponent("gift-incoming", isDirectory: true).standardizedFileURL
        var isDirectory: ObjCBool = false
        guard parent.resolvingSymlinksInPath().standardizedFileURL == parent,
              fm.fileExists(atPath: parent.path, isDirectory: &isDirectory), isDirectory.boolValue else { throw Failure.unavailable }
        // The staged archives and their bearer sidecars must never enter device
        // backups. Locked-device protection applies to the directory and files.
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try parent.setResourceValues(values)
        try fm.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: parent.path)
        let fd = open(parent.appendingPathComponent(".recovery-" + giftID + ".lock").path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard fd >= 0 else { throw Failure.unavailable }
        defer { close(fd) }
        _ = try regular(fd, limit: Int64(maxState))
        guard fchmod(fd, mode_t(0o600)) == 0, flock(fd, LOCK_EX) == 0 else { throw Failure.unavailable }
        defer { flock(fd, LOCK_UN) }
        return try operation(parent)
    }

    static func load(giftID: String) throws -> String? {
        try locked(giftID) { parent in
            let raw = try read(parent: parent, giftID: giftID)
            let state = try raw.map { try validate(giftID: giftID, raw: $0) }
            var limit = maxArchive
            if let state {
                let archive = try object(state["archive"], required: ["giftId", "room", "size", "sha256", "expiresAt"])
                limit = try integer(archive, "size", minimum: 1, maximum: maxArchive)
            }
            try checkArchive(parent: parent, giftID: giftID, limit: limit)
            return raw
        }
    }

    /// A nil previous record means create-if-absent after a successful claim.
    /// A failed response after rename is ambiguous: callers must load again.
    static func compareAndSwap(giftID: String, previous: String?, next: String) throws -> Bool {
        try locked(giftID) { parent in
            let after = try validate(giftID: giftID, raw: next)
            let before = try previous.map { try validate(giftID: giftID, raw: $0) }
            if let before {
                let names = ["version", "broker", "token", "signingKey", "archive"]
                let oldScope = before.filter { names.contains($0.key) }, newScope = after.filter { names.contains($0.key) }
                guard NSDictionary(dictionary: oldScope).isEqual(to: newScope) else { throw Failure.unavailable }
            }
            let archive = try object(after["archive"], required: ["giftId", "room", "size", "sha256", "expiresAt"])
            try checkArchive(parent: parent, giftID: giftID, limit: try integer(archive, "size", minimum: 1, maximum: maxArchive))
            let raw = try read(parent: parent, giftID: giftID)
            let current = try raw.map { try validate(giftID: giftID, raw: $0) }
            if let before {
                guard let current, NSDictionary(dictionary: before).isEqual(to: current) else { return false }
            } else if current != nil { return false }
            try write(parent: parent, giftID: giftID, bytes: Data(next.utf8))
            return true
        }
    }

    private static func checkArchive(parent: URL, giftID: String, limit: Int64) throws {
        let fd = open(parent.appendingPathComponent(giftID + ".zip").path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw Failure.unavailable }; defer { close(fd) }
        _ = try regular(fd, limit: limit)
    }

    private static func read(parent: URL, giftID: String) throws -> String? {
        let fd = open(parent.appendingPathComponent(".recovery-" + giftID + ".json").path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 { if errno == ENOENT { return nil }; throw Failure.unavailable }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true); defer { try? handle.close() }
        let size = try regular(fd, limit: Int64(maxState)).st_size
        var bytes = Data()
        while let part = try handle.read(upToCount: 4096), !part.isEmpty {
            guard part.count <= maxState - bytes.count else { throw Failure.unavailable }
            bytes.append(part)
        }
        guard Int64(bytes.count) == size, let raw = String(data: bytes, encoding: .utf8) else { throw Failure.unavailable }
        return raw
    }

    private static func write(parent: URL, giftID: String, bytes: Data) throws {
        let temporary = parent.appendingPathComponent(".recovery-" + giftID + ".tmp")
        let destination = parent.appendingPathComponent(".recovery-" + giftID + ".json")
        let fd = open(temporary.path, O_WRONLY | O_CREAT | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard fd >= 0 else { throw Failure.unavailable }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true); defer { try? handle.close() }
        // Validate a crash-left temporary inode before truncation, including its
        // link count. A hard link must never let a write alter another file.
        _ = try regular(fd, limit: Int64(maxState))
        guard fchmod(fd, mode_t(0o600)) == 0 else { throw Failure.unavailable }
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: temporary.path)
        var file = temporary, values = URLResourceValues(); values.isExcludedFromBackup = true
        try file.setResourceValues(values)
        guard ftruncate(fd, 0) == 0 else { throw Failure.unavailable }
        try handle.write(contentsOf: bytes)
        guard fsync(fd) == 0, rename(temporary.path, destination.path) == 0 else { throw Failure.unavailable }
        let directory = open(parent.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw Failure.unavailable }; defer { close(directory) }
        // EINVAL or any other sync failure remains an ambiguous write after
        // rename. Do not report success without directory durability. Confirm
        // support on the target iOS filesystem before enabling this plugin.
        guard fsync(directory) == 0 else { throw Failure.unavailable }
    }

    private static func object(_ value: Any?, required: [String], optional: [String] = []) throws -> [String: Any] {
        guard let result = value as? [String: Any], required.allSatisfy({ result[$0] != nil }),
              result.keys.allSatisfy({ required.contains($0) || optional.contains($0) }) else { throw Failure.unavailable }
        return result
    }

    private static func string(_ record: [String: Any], _ key: String, maximum: Int, pattern: String? = nil) throws -> String {
        guard let value = record[key] as? String, value.utf8.count <= maximum,
              pattern.map({ matches(value, $0) }) ?? true else { throw Failure.unavailable }
        return value
    }

    private static func integer(_ record: [String: Any], _ key: String, minimum: Int64, maximum: Int64) throws -> Int64 {
        guard let value = record[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { throw Failure.unavailable }
        let number = value.doubleValue
        guard number.isFinite, number.rounded(.towardZero) == number, number >= Double(minimum), number <= Double(maximum) else { throw Failure.unavailable }
        return value.int64Value
    }

    private static func claim(_ value: Any?, archive: [String: Any]) throws -> [String: Any] {
        let capability = try object(value, required: ["payload", "signature"])
        let payload = try string(capability, "payload", maximum: 4096)
        _ = try string(capability, "signature", maximum: 64, pattern: "^[a-f0-9]{64}$")
        let claim = try object(try JSONSerialization.jsonObject(with: Data(payload.utf8)), required: ["room", "role", "nonce", "expiresAt"], optional: ["previousNonce"])
        guard claim["role"] as? String == "recipient", claim["room"] as? String == archive["room"] as? String,
              try integer(claim, "expiresAt", minimum: 1, maximum: maxInteger) == integer(archive, "expiresAt", minimum: 1, maximum: maxInteger) else { throw Failure.unavailable }
        let nonce = try string(claim, "nonce", maximum: 128, pattern: "^[A-Za-z0-9_-]{16,128}$")
        if claim["previousNonce"] != nil {
            guard try string(claim, "previousNonce", maximum: 128, pattern: "^[A-Za-z0-9_-]{16,128}$") != nonce else { throw Failure.unavailable }
        }
        return claim
    }

    private static func validate(giftID: String, raw: String) throws -> [String: Any] {
        guard raw.utf8.count <= maxState else { throw Failure.unavailable }
        let record = try object(try JSONSerialization.jsonObject(with: Data(raw.utf8)), required: ["version", "broker", "token", "signingKey", "archive", "current"], optional: ["pending"])
        _ = try integer(record, "version", minimum: 1, maximum: 1)
        let broker = try string(record, "broker", maximum: 512)
        guard let url = URLComponents(string: broker), url.scheme == "https", url.host?.isEmpty == false,
              url.user == nil, url.password == nil, url.path.isEmpty, url.query == nil, url.fragment == nil,
              url.port.map({ $0 >= 0 && $0 <= 65535 }) ?? true else { throw Failure.unavailable }
        _ = try string(record, "token", maximum: 4096, pattern: "^[A-Za-z0-9_-]{32,4096}$")
        _ = try string(record, "signingKey", maximum: 43, pattern: "^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$")
        let archive = try object(record["archive"], required: ["giftId", "room", "size", "sha256", "expiresAt"])
        guard archive["giftId"] as? String == giftID else { throw Failure.unavailable }
        _ = try string(archive, "room", maximum: 128, pattern: "^[A-Za-z0-9_-]{16,128}$")
        _ = try string(archive, "sha256", maximum: 64, pattern: "^[a-f0-9]{64}$")
        _ = try integer(archive, "size", minimum: 1, maximum: maxArchive)
        _ = try integer(archive, "expiresAt", minimum: 1, maximum: maxInteger)
        let current = try claim(record["current"], archive: archive)
        if let rawPending = record["pending"] {
            let pending = try object(rawPending, required: ["successor", "generation"])
            _ = try integer(pending, "generation", minimum: 0, maximum: maxInteger - 1)
            let successor = try claim(pending["successor"], archive: archive)
            guard successor["previousNonce"] as? String == current["nonce"] as? String,
                  successor["nonce"] as? String != current["nonce"] as? String else { throw Failure.unavailable }
        }
        return record
    }
}

@objc(GiftImportPlugin)
public final class GiftImportPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GiftImportPlugin"
    public let jsName = "GiftImport"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "extract", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "verifyArchive", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "prepareArchive", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "inspectArchive", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "loadRecoveryState", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "compareAndSwapRecoveryState", returnType: CAPPluginReturnPromise)]
    private let queue = DispatchQueue(label: "com.operalibre.gift-import")

    @objc func loadRecoveryState(_ call: CAPPluginCall) {
        guard let id = call.getString("giftId") else { call.reject("Gift recovery storage unavailable."); return }
        queue.async {
            do {
                let state = try GiftRecoveryStore.load(giftID: id)
                call.resolve(["state": state.map { $0 as Any } ?? NSNull()])
            } catch { call.reject("Gift recovery storage unavailable.") }
        }
    }

    @objc func compareAndSwapRecoveryState(_ call: CAPPluginCall) {
        guard let id = call.getString("giftId"), let next = call.getString("next"),
              call.options["previous"] is NSNull || call.getString("previous") != nil else { call.reject("Gift recovery storage unavailable."); return }
        let previous = call.getString("previous")
        queue.async {
            do {
                let swapped = try GiftRecoveryStore.compareAndSwap(giftID: id, previous: previous, next: next)
                call.resolve(["swapped": swapped])
            } catch { call.reject("Gift recovery storage unavailable.") }
        }
    }

    @objc func extract(_ call: CAPPluginCall) {
        guard let id = call.getString("giftId"),
              id.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil,
              let entries = call.getArray("assets", JSObject.self), !entries.isEmpty, entries.count <= 256 else {
            call.reject("Invalid gift."); return
        }
        var assets: [GiftArchiveExtractor.Asset] = []
        for entry in entries {
            guard let name = entry["name"] as? String,
                  let number = entry["size"] as? NSNumber, number.int64Value >= 0,
                  let sha256 = entry["sha256"] as? String else { call.reject("Invalid gift manifest."); return }
            assets.append(GiftArchiveExtractor.Asset(name: name, size: number.uint64Value, sha256: sha256))
        }
        queue.async {
            do {
                let fm = FileManager.default
                let data = try fm.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true).standardizedFileURL
                let incoming = data.appendingPathComponent("gift-incoming", isDirectory: true).standardizedFileURL
                let source = incoming.appendingPathComponent(id + ".zip").standardizedFileURL
                guard incoming.resolvingSymlinksInPath() == incoming,
                      source.resolvingSymlinksInPath() == source else { throw GiftArchiveExtractor.Failure.unavailable }
                let root = data.appendingPathComponent("device-library", isDirectory: true)
                try fm.createDirectory(at: root, withIntermediateDirectories: true)
                guard root.resolvingSymlinksInPath().standardizedFileURL == root.standardizedFileURL else { throw GiftArchiveExtractor.Failure.unavailable }
                let result = try GiftArchiveExtractor.extract(archiveURL: source, privateRoot: root, giftID: id, assets: assets)
                call.resolve(["directory": "device-library/" + result.lastPathComponent])
            } catch { call.reject("Gift import could not be completed.") }
        }
    }

    @objc func verifyArchive(_ call: CAPPluginCall) {
        guard let id = call.getString("giftId"), id.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil,
              let size = call.getInt("size"), size >= 0, UInt64(size) <= 25 * 1024 * 1024 * 1024,
              let expected = call.getString("sha256"), expected.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { call.reject("Invalid gift archive."); return }
        queue.async {
            do {
                let fm = FileManager.default
                let data = try fm.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true).resolvingSymlinksInPath().standardizedFileURL
                let parent = data.appendingPathComponent("gift-incoming", isDirectory: true).standardizedFileURL
                let source = parent.appendingPathComponent(id + ".zip").standardizedFileURL
                guard parent.resolvingSymlinksInPath().standardizedFileURL == parent,
                      source.resolvingSymlinksInPath().standardizedFileURL == source else { throw GiftArchiveExtractor.Failure.invalid }
                let handle = try FileHandle(forReadingFrom: source); defer { try? handle.close() }
                var hash = SHA256(); var count = 0
                while let chunk = try handle.read(upToCount: 64 * 1024), !chunk.isEmpty {
                    guard chunk.count <= size - count else { throw GiftArchiveExtractor.Failure.integrity }
                    count += chunk.count; hash.update(data: chunk)
                }
                guard count == size, hash.finalize().map({ String(format: "%02x", $0) }).joined() == expected else { throw GiftArchiveExtractor.Failure.integrity }
                call.resolve()
            } catch { call.reject("Gift archive integrity check failed.") }
        }
    }

    @objc func prepareArchive(_ call: CAPPluginCall) {
        guard let id = call.getString("giftId"), id.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil else { call.reject("Invalid gift."); return }
        queue.async {
            do {
                let fm = FileManager.default
                let data = try fm.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true).resolvingSymlinksInPath().standardizedFileURL
                let parent = data.appendingPathComponent("gift-incoming", isDirectory: true).standardizedFileURL
                try fm.createDirectory(at: parent, withIntermediateDirectories: true)
                guard parent.resolvingSymlinksInPath().standardizedFileURL == parent else { throw GiftArchiveExtractor.Failure.invalid }
                let file = parent.appendingPathComponent(id + ".zip")
                let fd = open(file.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode_t(0o600))
                guard fd >= 0 else { throw GiftArchiveExtractor.Failure.unavailable }
                close(fd)
                call.resolve()
            } catch { call.reject("Gift staging could not be created.") }
        }
    }

    // Reports a digest of the actual staged prefix; it does not resume a
    // transfer until the broker session protocol is enabled and verified.
    @objc func inspectArchive(_ call: CAPPluginCall) {
        guard let id = call.getString("giftId"), id.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil,
              let maximum = call.getInt("maximumSize"), maximum >= 0, UInt64(maximum) <= 25 * 1024 * 1024 * 1024 else { call.reject("Invalid gift."); return }
        queue.async {
            do {
                let fm = FileManager.default
                let data = try fm.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true).resolvingSymlinksInPath().standardizedFileURL
                let parent = data.appendingPathComponent("gift-incoming", isDirectory: true).standardizedFileURL
                guard parent.resolvingSymlinksInPath().standardizedFileURL == parent else { throw GiftArchiveExtractor.Failure.invalid }
                let fd = open(parent.appendingPathComponent(id + ".zip").path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
                guard fd >= 0 else { throw GiftArchiveExtractor.Failure.unavailable }
                let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true); defer { try? handle.close() }
                var metadata = stat()
                guard fstat(fd, &metadata) == 0, (metadata.st_mode & S_IFMT) == S_IFREG,
                      metadata.st_size >= 0, UInt64(metadata.st_size) <= UInt64(maximum) else { throw GiftArchiveExtractor.Failure.invalid }
                var hash = SHA256(); var count: UInt64 = 0
                while let chunk = try handle.read(upToCount: 64 * 1024), !chunk.isEmpty {
                    count += UInt64(chunk.count)
                    guard count <= UInt64(metadata.st_size) else { throw GiftArchiveExtractor.Failure.integrity }
                    hash.update(data: chunk)
                }
                guard count == UInt64(metadata.st_size) else { throw GiftArchiveExtractor.Failure.integrity }
                call.resolve(["offset": Int(count), "prefixSha256": hash.finalize().map { String(format: "%02x", $0) }.joined()])
            } catch { call.reject("Gift staging could not be inspected.") }
        }
    }
}
#endif
