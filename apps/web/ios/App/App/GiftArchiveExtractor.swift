#if OPERALIBRE_EXPERIMENTAL_GIFTS
import Foundation
import CoreFoundation
import CryptoKit
import Darwin
import ZIPFoundation
import Capacitor

/// Staged extraction behind the experimental native-plugin compilation gate.
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

    /// Read only the selected descriptor under the caller's staging guard.
    /// openat anchors the child to the no-follow directory descriptor.
    static func readMetadata(_ directory: URL, asset: Asset) throws -> String {
        let maximum: UInt64 = 256 * 1024
        guard asset.size > 0, asset.size <= maximum, !asset.name.isEmpty,
              asset.name != ".", asset.name != "..", asset.name.utf8.count <= 255,
              !asset.name.contains("/"), !asset.name.contains("\\"),
              asset.name.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }),
              directory.resolvingSymlinksInPath().standardizedFileURL == directory.standardizedFileURL else { throw Failure.invalid }
        var parent = stat(), openedParent = stat()
        guard lstat(directory.path, &parent) == 0, (parent.st_mode & S_IFMT) == S_IFDIR else { throw Failure.invalid }
        let directoryFD = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directoryFD >= 0 else { throw Failure.unavailable }; defer { close(directoryFD) }
        guard fstat(directoryFD, &openedParent) == 0, openedParent.st_dev == parent.st_dev,
              openedParent.st_ino == parent.st_ino else { throw Failure.invalid }
        let fd = openat(directoryFD, asset.name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else { throw Failure.unavailable }; defer { close(fd) }
        var before = stat()
        guard fstat(fd, &before) == 0, (before.st_mode & S_IFMT) == S_IFREG,
              before.st_nlink == 1, before.st_size == Int64(asset.size) else { throw Failure.integrity }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        var bytes = Data()
        while let chunk = try handle.read(upToCount: min(16 * 1024, Int(asset.size) - bytes.count + 1)), !chunk.isEmpty {
            guard chunk.count <= Int(asset.size) - bytes.count else { throw Failure.integrity }
            bytes.append(chunk)
        }
        var after = stat(), current = stat()
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        guard bytes.count == Int(asset.size), digest == asset.sha256,
              fstat(fd, &after) == 0, after.st_size == before.st_size,
              lstat(directory.path, &current) == 0, current.st_dev == parent.st_dev,
              current.st_ino == parent.st_ino, (current.st_mode & S_IFMT) == S_IFDIR,
              directory.resolvingSymlinksInPath().standardizedFileURL == directory.standardizedFileURL,
              let json = String(data: bytes, encoding: .utf8) else { throw Failure.integrity }
        return json
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
/// Cleanup holds the separate staging lease lock before taking this record lock.
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
        guard parent.resolvingSymlinksInPath().standardizedFileURL == parent else { throw Failure.unavailable }
        try fm.createDirectory(at: parent, withIntermediateDirectories: true)
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
            if state != nil { try checkArchive(parent: parent, giftID: giftID, limit: limit) }
            return raw
        }
    }

    static func freshAllowed(giftID: String) throws -> Bool {
        try locked(giftID) { parent in
            for suffix in [".json", ".tmp"] {
                var metadata = stat()
                if lstat(parent.appendingPathComponent(".recovery-" + giftID + suffix).path, &metadata) == 0 { return false }
                guard errno == ENOENT else { throw Failure.unavailable }
            }
            return true
        }
    }

    /// The caller holds the staging guard. Persistent lock files are never
    /// unlinked: a replacement inode would split the cross-process lock.
    static func cleanup(giftID: String) throws {
        try locked(giftID) { parent in
            var files: [URL] = []
            for name in [giftID + ".zip", ".recovery-" + giftID + ".json", ".recovery-" + giftID + ".tmp"] {
                let file = parent.appendingPathComponent(name); var metadata = stat()
                if lstat(file.path, &metadata) == 0 {
                    guard (metadata.st_mode & S_IFMT) == S_IFREG, metadata.st_nlink == 1 else { throw Failure.unavailable }
                    files.append(file)
                } else if errno != ENOENT { throw Failure.unavailable }
            }
            for file in files { guard unlink(file.path) == 0 else { throw Failure.unavailable } }
            let fd = open(parent.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard fd >= 0 else { throw Failure.unavailable }; defer { close(fd) }
            guard fsync(fd) == 0 else { throw Failure.unavailable }
        }
    }

    /// A nil previous record means create-if-absent after a successful claim.
    /// A failed response after rename is ambiguous: callers must load again.
    static func compareAndSwap(giftID: String, previous: String?, next: String) throws -> Bool {
        try locked(giftID) { parent in
            let after = try validate(giftID: giftID, raw: next)
            let before = try previous.map { try validate(giftID: giftID, raw: $0) }
            if let before {
                let names = ["version", "broker", "token", "signingKey", "archive", "recoverySecret"]
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
        let record = try object(try JSONSerialization.jsonObject(with: Data(raw.utf8)), required: ["version", "broker", "token", "signingKey", "archive", "current"], optional: ["pending", "recoverySecret"])
        _ = try integer(record, "version", minimum: 1, maximum: 1)
        let broker = try string(record, "broker", maximum: 512)
        guard let url = URLComponents(string: broker), url.scheme == "https", url.host?.isEmpty == false,
              url.user == nil, url.password == nil, url.path.isEmpty, url.query == nil, url.fragment == nil,
              url.port.map({ $0 >= 0 && $0 <= 65535 }) ?? true else { throw Failure.unavailable }
        _ = try string(record, "token", maximum: 4096, pattern: "^[A-Za-z0-9_-]{32,4096}$")
        _ = try string(record, "signingKey", maximum: 43, pattern: "^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$")
        if record["recoverySecret"] != nil { _ = try string(record, "recoverySecret", maximum: 43, pattern: "^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$") }
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

/// Native transfer ownership spans inspection, negotiation, appends and verify.
/// The persistent flock is nonblocking and is released by close or process exit.
enum GiftStagingStore {
    private enum Failure: Error { case unavailable }
    private static let lock = NSLock()
    private static let maximumArchive: Int64 = 25 * 1024 * 1024 * 1024
    private static var leases: [String: Session] = [:]
    private final class Guard {
        let parent: URL
        let identity: stat
        private var descriptor: Int32?
        init(parent: URL, identity: stat, descriptor: Int32) { self.parent = parent; self.identity = identity; self.descriptor = descriptor }
        func close() { if let fd = descriptor { descriptor = nil; flock(fd, LOCK_UN); Darwin.close(fd) } }
        deinit { close() }
    }
    private final class Session {
        let owner: String, giftID: String, guardFile: Guard, handle: FileHandle, maximum: Int64
        var offset: Int64
        var failed = false, verified = false
        init(owner: String, giftID: String, guardFile: Guard, handle: FileHandle, maximum: Int64, offset: Int64) {
            self.owner = owner; self.giftID = giftID; self.guardFile = guardFile; self.handle = handle; self.maximum = maximum; self.offset = offset
        }
        func close() throws { defer { guardFile.close() }; try handle.close() }
    }
    private static func matches(_ value: String, _ pattern: String) -> Bool {
        guard let range = value.range(of: pattern, options: .regularExpression) else { return false }
        return range.lowerBound == value.startIndex && range.upperBound == value.endIndex
    }
    private static func regular(_ fd: Int32, maximum: Int64) throws -> stat {
        var metadata = stat()
        guard fstat(fd, &metadata) == 0, (metadata.st_mode & S_IFMT) == S_IFREG, metadata.st_nlink == 1,
              metadata.st_size >= 0, metadata.st_size <= maximum else { throw Failure.unavailable }
        return metadata
    }
    private static func guardFile(giftID: String) throws -> Guard {
        guard matches(giftID, "^[A-Za-z0-9_-]{16,128}$") else { throw Failure.unavailable }
        let fm = FileManager.default
        let data = try fm.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true).resolvingSymlinksInPath().standardizedFileURL
        var parent = data.appendingPathComponent("gift-incoming", isDirectory: true).standardizedFileURL
        guard parent.resolvingSymlinksInPath().standardizedFileURL == parent else { throw Failure.unavailable }
        try fm.createDirectory(at: parent, withIntermediateDirectories: true)
        var identity = stat()
        guard lstat(parent.path, &identity) == 0, (identity.st_mode & S_IFMT) == S_IFDIR,
              parent.resolvingSymlinksInPath().standardizedFileURL == parent else { throw Failure.unavailable }
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try parent.setResourceValues(values)
        try fm.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: parent.path)
        let fd = open(parent.appendingPathComponent(".staging-" + giftID + ".lock").path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard fd >= 0 else { throw Failure.unavailable }
        do {
            _ = try regular(fd, maximum: 0)
            guard fchmod(fd, mode_t(0o600)) == 0, flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw Failure.unavailable }
            return Guard(parent: parent, identity: identity, descriptor: fd)
        } catch { Darwin.close(fd); throw error }
    }

    static func acquire(giftID: String, owner: String, create: Bool, maximum: Int64) throws -> (lease: String, offset: Int64, prefixSha256: String) {
        lock.lock(); defer { lock.unlock() }
        guard maximum >= 0, maximum <= maximumArchive, leases.count < 16 else { throw Failure.unavailable }
        let held = try guardFile(giftID: giftID)
        do {
            if create { guard try GiftRecoveryStore.freshAllowed(giftID: giftID) else { throw Failure.unavailable } }
            let file = held.parent.appendingPathComponent(giftID + ".zip")
            var fd: Int32 = -1
            if create {
                fd = open(file.path, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
                if fd < 0 && errno != EEXIST { throw Failure.unavailable }
            }
            if fd < 0 { fd = open(file.path, O_RDWR | O_NOFOLLOW | O_CLOEXEC) }
            guard fd >= 0 else { throw Failure.unavailable }
            let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            do {
                let metadata = try regular(fd, maximum: maximum)
                guard fchmod(fd, mode_t(0o600)) == 0 else { throw Failure.unavailable }
                try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: file.path)
                if create {
                    guard metadata.st_size == 0 else { throw Failure.unavailable }
                    guard try GiftRecoveryStore.freshAllowed(giftID: giftID) else { throw Failure.unavailable }
                }
                let session = Session(owner: owner, giftID: giftID, guardFile: held, handle: handle, maximum: maximum, offset: metadata.st_size)
                let hash = try digest(session)
                func token() -> String { SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
                var lease = token()
                while leases[lease] != nil { lease = token() }
                leases[lease] = session
                return (lease, metadata.st_size, hash)
            } catch { try? handle.close(); throw error }
        } catch { held.close(); throw error }
    }

    private static func owned(giftID: String, owner: String, lease: String) throws -> Session {
        guard matches(lease, "^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$"), let session = leases[lease],
              session.owner == owner, session.giftID == giftID else { throw Failure.unavailable }
        return session
    }
    private static func unchanged(_ session: Session) throws {
        let parent = session.guardFile.parent
        var directory = stat(), path = stat()
        guard lstat(parent.path, &directory) == 0, (directory.st_mode & S_IFMT) == S_IFDIR,
              directory.st_dev == session.guardFile.identity.st_dev, directory.st_ino == session.guardFile.identity.st_ino,
              parent.resolvingSymlinksInPath().standardizedFileURL == parent else { throw Failure.unavailable }
        let actual = try regular(session.handle.fileDescriptor, maximum: session.maximum)
        guard lstat(parent.appendingPathComponent(session.giftID + ".zip").path, &path) == 0,
              (path.st_mode & S_IFMT) == S_IFREG, path.st_nlink == 1, path.st_dev == actual.st_dev, path.st_ino == actual.st_ino,
              actual.st_size == session.offset else { throw Failure.unavailable }
    }
    private static func digest(_ session: Session) throws -> String {
        try unchanged(session); try session.handle.seek(toOffset: 0)
        var hash = SHA256(), count: Int64 = 0
        while let bytes = try session.handle.read(upToCount: 64 * 1024), !bytes.isEmpty {
            count += Int64(bytes.count); guard count <= session.offset else { throw Failure.unavailable }; hash.update(data: bytes)
        }
        guard count == session.offset else { throw Failure.unavailable }; try unchanged(session)
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
    static func append(giftID: String, owner: String, lease: String, offset: Int64, encoded: String) throws -> Int64 {
        lock.lock(); defer { lock.unlock() }
        let session = try owned(giftID: giftID, owner: owner, lease: lease)
        guard !session.failed, !session.verified, offset == session.offset, !encoded.isEmpty, encoded.utf8.count <= 87384,
              let bytes = Data(base64Encoded: encoded), !bytes.isEmpty, bytes.count <= 64 * 1024, bytes.base64EncodedString() == encoded,
              offset <= session.maximum - Int64(bytes.count) else { throw Failure.unavailable }
        do {
            try unchanged(session); try session.handle.seek(toOffset: UInt64(offset)); try session.handle.write(contentsOf: bytes)
            guard fsync(session.handle.fileDescriptor) == 0 else { throw Failure.unavailable }
            session.offset += Int64(bytes.count); try unchanged(session); return session.offset
        } catch { session.failed = true; throw error }
    }
    static func verify(giftID: String, owner: String, lease: String, size: Int64, sha256: String) throws {
        lock.lock(); defer { lock.unlock() }
        let session = try owned(giftID: giftID, owner: owner, lease: lease)
        guard !session.failed, !session.verified, size == session.offset, matches(sha256, "^[a-f0-9]{64}$") else { throw Failure.unavailable }
        do {
            guard fsync(session.handle.fileDescriptor) == 0, try digest(session) == sha256 else { throw Failure.unavailable }
            session.verified = true
        } catch { session.failed = true; throw error }
    }
    static func release(giftID: String, owner: String, lease: String) throws {
        lock.lock(); defer { lock.unlock() }
        let session = try owned(giftID: giftID, owner: owner, lease: lease)
        leases.removeValue(forKey: lease); try session.close()
    }
    static func releaseOwner(_ owner: String) {
        lock.lock(); defer { lock.unlock() }
        for (token, session) in leases.filter({ $0.value.owner == owner }) { leases.removeValue(forKey: token); try? session.close() }
    }
    static func withInactive<T>(giftID: String, _ operation: (URL) throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        let held = try guardFile(giftID: giftID); defer { held.close() }
        return try operation(held.parent)
    }
    static func cleanup(giftID: String) throws {
        try withInactive(giftID: giftID) { _ in try GiftRecoveryStore.cleanup(giftID: giftID) }
    }
    static func syncCommitted(_ directory: URL) throws {
        let library = directory.deletingLastPathComponent()
        for file in [directory, library, library.deletingLastPathComponent()] {
            let fd = open(file.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard fd >= 0 else { throw Failure.unavailable }; defer { Darwin.close(fd) }
            guard fsync(fd) == 0 else { throw Failure.unavailable }
        }
    }
}

@objc(GiftImportPlugin)
public final class GiftImportPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GiftImportPlugin"
    public let jsName = "GiftImport"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "extract", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acquireArchive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appendArchive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "verifyArchive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseArchive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cleanupArchive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadRecoveryState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "compareAndSwapRecoveryState", returnType: CAPPluginReturnPromise)
    ]
    private let queue = DispatchQueue(label: "com.operalibre.gift-import")
    private let documentLock = NSLock()
    private var leaseOwner = UUID().uuidString
    private var documentClosed = false

    private func enqueue(_ call: CAPPluginCall, _ operation: @escaping (String) -> Void) {
        documentLock.lock(); defer { documentLock.unlock() }
        guard !documentClosed else { call.reject("Gift document is closed."); return }
        let owner = leaseOwner
        queue.async { operation(owner) }
    }

    // CapacitorBridge.reset invokes this Objective-C selector with nil on both
    // navigation and content-process termination. A real JS listener call must
    // not reset native transfer ownership. IUO accepts the bridge's nil call.
    public override func removeAllListeners(_ call: CAPPluginCall!) {
        if let call { super.removeAllListeners(call); return }
        eventListeners?.removeAllObjects()
        guard let concrete = bridge as? CapacitorBridge else {
            documentLock.lock(); defer { documentLock.unlock() }
            documentClosed = true
            let owner = leaseOwner
            queue.async { GiftStagingStore.releaseOwner(owner) }
            return
        }
        // Drain plugin invocations already queued by the previous document
        // before placing the reset barrier on the private IO queue.
        concrete.dispatchQueue.async { [weak self] in
            guard let self else { return }
            self.documentLock.lock(); defer { self.documentLock.unlock() }
            let owner = self.leaseOwner
            self.leaseOwner = UUID().uuidString
            self.queue.async { GiftStagingStore.releaseOwner(owner) }
        }
    }

    deinit {
        let owner = leaseOwner
        queue.async { GiftStagingStore.releaseOwner(owner) }
    }

    private func integer(_ call: CAPPluginCall, _ key: String) throws -> Int64 {
        guard let raw = call.options[key] as? NSNumber, CFGetTypeID(raw) != CFBooleanGetTypeID() else { throw GiftArchiveExtractor.Failure.invalid }
        let value = raw.doubleValue
        guard value.isFinite, value >= 0, value <= 26_843_545_600, value.rounded(.towardZero) == value else { throw GiftArchiveExtractor.Failure.invalid }
        return raw.int64Value
    }

    @objc func acquireArchive(_ call: CAPPluginCall) {
        guard let id = call.getString("giftId"), let create = call.options["create"] as? NSNumber,
              CFGetTypeID(create) == CFBooleanGetTypeID() else { call.reject("Gift staging lease unavailable."); return }
        enqueue(call) { owner in
            do {
                let result = try GiftStagingStore.acquire(giftID: id, owner: owner, create: create.boolValue, maximum: self.integer(call, "maximumSize"))
                call.resolve(["lease": result.lease, "offset": result.offset, "prefixSha256": result.prefixSha256])
            } catch { call.reject("Gift staging lease unavailable.") }
        }
    }

    @objc func appendArchive(_ call: CAPPluginCall) {
        guard let id = call.getString("giftId"), let lease = call.getString("lease"), let data = call.getString("data") else { call.reject("Gift staging append failed."); return }
        enqueue(call) { owner in
            do {
                let offset = try GiftStagingStore.append(giftID: id, owner: owner, lease: lease, offset: self.integer(call, "offset"), encoded: data)
                call.resolve(["offset": offset])
            } catch { call.reject("Gift staging append failed.") }
        }
    }

    @objc func verifyArchive(_ call: CAPPluginCall) {
        guard let id = call.getString("giftId"), let lease = call.getString("lease"), let sha256 = call.getString("sha256") else { call.reject("Gift archive integrity check failed."); return }
        enqueue(call) { owner in
            do {
                try GiftStagingStore.verify(giftID: id, owner: owner, lease: lease, size: self.integer(call, "size"), sha256: sha256); call.resolve()
            } catch { call.reject("Gift archive integrity check failed.") }
        }
    }

    @objc func releaseArchive(_ call: CAPPluginCall) {
        guard let id = call.getString("giftId"), let lease = call.getString("lease") else { call.reject("Gift staging release failed."); return }
        enqueue(call) { owner in
            do { try GiftStagingStore.release(giftID: id, owner: owner, lease: lease); call.resolve() }
            catch { call.reject("Gift staging release failed.") }
        }
    }

    @objc func cleanupArchive(_ call: CAPPluginCall) {
        guard let id = call.getString("giftId") else { call.reject("Gift staging cleanup unavailable."); return }
        enqueue(call) { _ in
            do { try GiftStagingStore.cleanup(giftID: id); call.resolve() }
            catch { call.reject("Gift staging cleanup unavailable.") }
        }
    }

    @objc func loadRecoveryState(_ call: CAPPluginCall) {
        guard let id = call.getString("giftId") else { call.reject("Gift recovery storage unavailable."); return }
        enqueue(call) { _ in
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
        enqueue(call) { _ in
            do {
                let swapped = try GiftRecoveryStore.compareAndSwap(giftID: id, previous: previous, next: next)
                call.resolve(["swapped": swapped])
            } catch { call.reject("Gift recovery storage unavailable.") }
        }
    }

    @objc func extract(_ call: CAPPluginCall) {
        guard let id = call.getString("giftId"), let entries = call.getArray("assets", JSObject.self),
              !entries.isEmpty, entries.count <= 256 else { call.reject("Invalid gift."); return }
        var assets: [GiftArchiveExtractor.Asset] = []
        var metadata: GiftArchiveExtractor.Asset?
        for entry in entries {
            guard let name = entry["name"] as? String, let number = entry["size"] as? NSNumber, number.int64Value >= 0,
                  let sha256 = entry["sha256"] as? String else { call.reject("Invalid gift manifest."); return }
            let asset = GiftArchiveExtractor.Asset(name: name, size: number.uint64Value, sha256: sha256)
            assets.append(asset)
            if entry["kind"] as? String == "metadata" {
                guard metadata == nil, asset.size > 0, asset.size <= 256 * 1024 else { call.reject("Invalid gift metadata."); return }
                metadata = asset
            }
        }
        enqueue(call) { _ in
            do {
                let result = try GiftStagingStore.withInactive(giftID: id) { incoming in
                    let fm = FileManager.default
                    let source = incoming.appendingPathComponent(id + ".zip").standardizedFileURL
                    guard source.resolvingSymlinksInPath() == source else { throw GiftArchiveExtractor.Failure.invalid }
                    let root = incoming.deletingLastPathComponent().appendingPathComponent("device-library", isDirectory: true)
                    try fm.createDirectory(at: root, withIntermediateDirectories: true)
                    guard root.resolvingSymlinksInPath().standardizedFileURL == root.standardizedFileURL else { throw GiftArchiveExtractor.Failure.unavailable }
                    let committed = try GiftArchiveExtractor.extract(archiveURL: source, privateRoot: root, giftID: id, assets: assets)
                    try GiftStagingStore.syncCommitted(committed)
                    let json = try metadata.map { try GiftArchiveExtractor.readMetadata(committed, asset: $0) }
                    try GiftRecoveryStore.cleanup(giftID: id)
                    return (directory: committed, metadataJson: json)
                }
                var response: JSObject = ["directory": "device-library/" + result.directory.lastPathComponent]
                if let json = result.metadataJson { response["metadataJson"] = json }
                call.resolve(response)
            } catch { call.reject("Gift import could not be completed.") }
        }
    }
}
#endif
