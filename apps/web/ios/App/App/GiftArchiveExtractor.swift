#if OPERALIBRE_EXPERIMENTAL_GIFTS
import Foundation
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

@objc(GiftImportPlugin)
public final class GiftImportPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GiftImportPlugin"
    public let jsName = "GiftImport"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "extract", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "verifyArchive", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "prepareArchive", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "inspectArchive", returnType: CAPPluginReturnPromise)]
    private let queue = DispatchQueue(label: "com.operalibre.gift-import")

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
