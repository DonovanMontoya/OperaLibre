import CryptoKit
import Foundation

private let maxManifestHops = 8
private let manifestTimeout: TimeInterval = 30
private let maxFrontendPackageBytes = 50 * 1024 * 1024
private let stagingPrefix = ".staging-"
private let bundleStampName = ".bundle-stamp"
private let staleStagingAge: TimeInterval = 60 * 60
private let previousRootName = "Web.previous"
private let unconfirmedName = ".unconfirmed-frontend"
private let rejectedName = ".rejected-frontend-releases"
private let timedOutName = ".timed-out-frontend-releases"

func frontendReleaseKey(version: String, sha256: String) -> String {
    "\(version) \(sha256.lowercased())"
}

struct FrontendRollback {
    let root: URL
    let rejected: Bool
}

enum FrontendUpdateError: LocalizedError {
    case noMatchingAsset
    case untrustedDownloadURL
    case digestMismatch
    case tooManyRedirects
    case invalidPackage(String)
    case httpStatus(String, Int)
    case network(Error)

    var errorDescription: String? {
        switch self {
        case .noMatchingAsset:
            return "The latest release does not include a web frontend package."
        case .untrustedDownloadURL:
            return "The update manifest or frontend package address is not HTTPS."
        case .digestMismatch:
            return "The downloaded frontend package failed checksum verification."
        case .tooManyRedirects:
            return "The update manifest redirected too many times."
        case .invalidPackage(let reason):
            return "The frontend package is invalid: \(reason)"
        case .httpStatus(let context, let code):
            return code == 403
                ? "\(context) returned HTTP 403 — GitHub is likely rate limiting this network. Try again later."
                : "\(context) returned HTTP \(code)."
        case .network(let error):
            return error.localizedDescription
        }
    }
}

struct FrontendUpdateStatus {
    let currentVersion: String
    let latestVersion: String
    let updateAvailable: Bool
    let heldBack: Bool
    let package: UpdatePackage?
    let notice: UpdateNotice?
}

func parseSemver(_ raw: String) -> [Int]? {
    var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.hasPrefix("v") || text.hasPrefix("V") {
        text.removeFirst()
    }
    let parts = text.split(separator: ".")
    guard parts.count == 3 else { return nil }
    let numbers = parts.compactMap { Int($0) }
    return numbers.count == 3 ? numbers : nil
}

func isSemver(_ a: [Int], newerThan b: [Int]) -> Bool {
    for index in 0..<3 where a[index] != b[index] {
        return a[index] > b[index]
    }
    return false
}

final class FrontendUpdater {
    let bundledWebRoot: URL
    let managedWebRoot: URL

    private(set) var servingRoot: URL?

    init(bundledWebRoot: URL, managedWebRoot: URL) {
        self.bundledWebRoot = bundledWebRoot
        self.managedWebRoot = managedWebRoot
    }

    private var container: URL { managedWebRoot.deletingLastPathComponent() }
    var previousWebRoot: URL { container.appendingPathComponent(previousRootName, isDirectory: true) }
    private func unconfirmedMarker(in webRoot: URL) -> URL {
        webRoot.appendingPathComponent(unconfirmedName)
    }
    private var rejectedURL: URL { container.appendingPathComponent(rejectedName) }
    private var timedOutURL: URL { container.appendingPathComponent(timedOutName) }
    private var timedOutThisLaunch: Set<String> = []

    private func unconfirmedKey(in webRoot: URL) -> String? {
        guard let text = try? String(contentsOf: unconfirmedMarker(in: webRoot), encoding: .utf8) else {
            return nil
        }
        let key = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return key.isEmpty ? readVersion(at: webRoot) : key
    }

    private func readVersion(at webRoot: URL) -> String {
        let marker = webRoot.appendingPathComponent("VERSION.txt")
        guard let contents = try? String(contentsOf: marker, encoding: .utf8) else {
            return "dev"
        }
        return contents.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func bundleFingerprint() -> String? {
        let index = bundledWebRoot.appendingPathComponent("index.html")
        guard let data = try? Data(contentsOf: index) else { return nil }
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return "\(readVersion(at: bundledWebRoot)):\(digest)"
    }

    func resolveServingRoot() -> URL {
        let fileManager = FileManager.default
        let container = managedWebRoot.deletingLastPathComponent()
        removeStaleStagingDirectories(in: container)

        if let key = unconfirmedKey(in: managedWebRoot),
           isRejected(key),
           replaceFailedRoot() == bundledWebRoot,
           fileManager.fileExists(atPath: managedWebRoot.path)
        {
            servingRoot = bundledWebRoot
            return bundledWebRoot
        }

        let managedVersionMarker = managedWebRoot.appendingPathComponent("VERSION.txt")
        let managedExists = fileManager.fileExists(atPath: managedVersionMarker.path)
        let stampURL = container.appendingPathComponent(bundleStampName)
        let recordedStamp = try? String(contentsOf: stampURL, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let fingerprint = bundleFingerprint()

        let shouldResetFromBundle = !managedExists || fingerprint == nil || fingerprint != recordedStamp

        if shouldResetFromBundle {
            let stagingRoot = container
                .appendingPathComponent("\(stagingPrefix)\(UUID().uuidString)", isDirectory: true)
            let stagedWeb = stagingRoot.appendingPathComponent("web", isDirectory: true)
            do {
                try fileManager.createDirectory(at: stagingRoot, withIntermediateDirectories: true)
                try fileManager.copyItem(at: bundledWebRoot, to: stagedWeb)
                guard fileManager.fileExists(atPath: stagedWeb.appendingPathComponent("index.html").path) else {
                    throw FrontendUpdateError.invalidPackage("the bundled web root is missing index.html")
                }
                try? fileManager.removeItem(at: managedWebRoot)
                try fileManager.moveItem(at: stagedWeb, to: managedWebRoot)
                try? fileManager.removeItem(at: stagingRoot)
                try? fileManager.removeItem(at: previousWebRoot)
                if let fingerprint {
                    try? fingerprint.write(to: stampURL, atomically: true, encoding: .utf8)
                }
            } catch {
                try? fileManager.removeItem(at: stagingRoot)
                servingRoot = bundledWebRoot
                return bundledWebRoot
            }
        }

        servingRoot = managedWebRoot
        return managedWebRoot
    }

    private func removeStaleStagingDirectories(in container: URL) {
        let fileManager = FileManager.default
        guard let entries = try? fileManager.contentsOfDirectory(
            at: container,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsSubdirectoryDescendants]
        ) else { return }
        let cutoff = Date().addingTimeInterval(-staleStagingAge)
        for entry in entries where entry.lastPathComponent.hasPrefix(stagingPrefix) {
            let modified = try? entry.resourceValues(forKeys: [.contentModificationDateKey])
                .contentModificationDate
            guard let modified, modified < cutoff else { continue }
            try? fileManager.removeItem(at: entry)
        }
    }

    private var installedVersion: String?

    var currentVersion: String {
        installedVersion ?? readVersion(at: servingRoot ?? managedWebRoot)
    }

    var isServingManagedRoot: Bool {
        servingRoot?.standardizedFileURL == managedWebRoot.standardizedFileURL
    }

    func checkForUpdate() async throws -> FrontendUpdateStatus {
        let current = currentVersion
        let manifest = try await fetchManifest(currentVersion: parseSemver(current))
        let package = manifest.package("frontend")
        let latestVersion = package?.version ?? manifest.version

        let newer: Bool
        if let currentParsed = parseSemver(current), let latestParsed = parseSemver(latestVersion) {
            newer = isSemver(latestParsed, newerThan: currentParsed) && package != nil
        } else {
            newer = package != nil
        }
        let heldBack = newer && package.map {
            isRejected(frontendReleaseKey(version: $0.version, sha256: $0.sha256))
        } == true

        return FrontendUpdateStatus(
            currentVersion: current,
            latestVersion: latestVersion,
            updateAvailable: newer && !heldBack,
            heldBack: heldBack,
            package: package,
            notice: manifest.notice
        )
    }

    private func fetchManifest(currentVersion: [Int]?) async throws -> UpdateManifest {
        let acceptedRoots = managedWebRoot.deletingLastPathComponent()
            .appendingPathComponent(acceptedRootsFileName)
        guard let builtIn = TrustedRoot.builtIn else {
            throw UpdateManifestError.untrusted
        }
        var url = updateManifestURL
        for _ in 0..<maxManifestHops {
            let data: Data
            do {
                var request = URLRequest(url: url)
                request.timeoutInterval = manifestTimeout
                let (bytes, response) = try await URLSession.shared.bytes(for: request)
                try checkStatus(response, context: "The update manifest")
                data = try await readUpdateManifestBody(bytes, declaredLength: response.expectedContentLength)
            } catch let error as FrontendUpdateError {
                throw error
            } catch let error as UpdateManifestError {
                throw error
            } catch {
                throw FrontendUpdateError.network(error)
            }
            var root = builtIn.withSavedRotations(at: acceptedRoots)
            let known = root.version
            let manifest = try verifyUpdateManifest(data, root: &root)
            if root.version > known {
                try root.saveRotations(to: acceptedRoots)
            }
            let bridge = currentVersion.flatMap { current in
                manifest.bridges?.first { bridge in
                    (bridge.component == nil || bridge.component == "frontend")
                        && parseSemver(bridge.below).map { isSemver($0, newerThan: current) } == true
                }
            }
            guard let next = manifest.redirect ?? bridge?.manifest else {
                return manifest
            }
            guard next.hasPrefix("https://"), let nextURL = URL(string: next) else {
                throw FrontendUpdateError.untrustedDownloadURL
            }
            url = nextURL
        }
        throw FrontendUpdateError.tooManyRedirects
    }

    func install(_ status: FrontendUpdateStatus) async throws {
        guard let package = status.package else {
            throw FrontendUpdateError.noMatchingAsset
        }
        guard package.size <= maxFrontendPackageBytes else {
            throw FrontendUpdateError.invalidPackage("unexpected package size")
        }
        guard let downloadURL = URL(string: package.url) else {
            throw FrontendUpdateError.untrustedDownloadURL
        }

        let fileManager = FileManager.default
        let workDir = fileManager.temporaryDirectory
            .appendingPathComponent("operalibre-frontend-update-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: workDir, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: workDir) }

        let archivePath = workDir.appendingPathComponent("frontend.zip")
        try await downloadArchive(from: downloadURL, to: archivePath)

        let downloadedData = try Data(contentsOf: archivePath, options: .mappedIfSafe)
        let actualDigest = SHA256.hash(data: downloadedData).map { String(format: "%02x", $0) }.joined()
        guard downloadedData.count == package.size, actualDigest == package.sha256.lowercased() else {
            throw FrontendUpdateError.digestMismatch
        }

        let extractDir = workDir.appendingPathComponent("extracted", isDirectory: true)
        try fileManager.createDirectory(at: extractDir, withIntermediateDirectories: true)
        try runUnzip(archive: archivePath, destination: extractDir)

        let packageRoot = extractDir.appendingPathComponent(package.root, isDirectory: true)
        let stagedWeb = packageRoot.appendingPathComponent("web", isDirectory: true)
        let stagedIndex = stagedWeb.appendingPathComponent("index.html")
        let stagedVersionMarker = stagedWeb.appendingPathComponent("VERSION.txt")
        guard fileManager.fileExists(atPath: stagedIndex.path) else {
            throw FrontendUpdateError.invalidPackage("missing index.html")
        }
        guard let stagedVersion = try? String(contentsOf: stagedVersionMarker, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
            stagedVersion == package.version
        else {
            throw FrontendUpdateError.invalidPackage("version marker does not match the release")
        }

        try promote(stagedWeb, version: package.version, sha256: package.sha256)
    }

    func promote(_ stagedWeb: URL, version: String, sha256: String) throws {
        let fileManager = FileManager.default
        try frontendReleaseKey(version: version, sha256: sha256)
            .write(to: unconfirmedMarker(in: stagedWeb), atomically: true, encoding: .utf8)
        try fileManager.createDirectory(at: container, withIntermediateDirectories: true)
        let hadExisting = fileManager.fileExists(atPath: managedWebRoot.path)
        if hadExisting {
            try? fileManager.removeItem(at: previousWebRoot)
            try fileManager.moveItem(at: managedWebRoot, to: previousWebRoot)
        }
        do {
            try fileManager.moveItem(at: stagedWeb, to: managedWebRoot)
        } catch {
            if hadExisting {
                try? fileManager.moveItem(at: previousWebRoot, to: managedWebRoot)
            }
            throw error
        }
        installedVersion = version
    }

    var servingReleaseKey: String? {
        isServingManagedRoot ? unconfirmedKey(in: managedWebRoot) : nil
    }

    func confirmServingRoot(loadedRelease: String?) {
        guard let key = servingReleaseKey, key == loadedRelease else { return }
        try? FileManager.default.removeItem(at: unconfirmedMarker(in: managedWebRoot))
    }

    func rollBackUnconfirmedRoot(timedOut: Bool = false, loadedRelease: String?) -> FrontendRollback? {
        guard let key = servingReleaseKey, key == loadedRelease else { return nil }

        let reject = !timedOut
            || (keys(in: timedOutURL).contains(key) && !timedOutThisLaunch.contains(key))
        if timedOut {
            timedOutThisLaunch.insert(key)
        }
        record(key, in: reject ? rejectedURL : timedOutURL)
        installedVersion = nil
        let root = replaceFailedRoot()
        servingRoot = root
        return FrontendRollback(root: root, rejected: reject)
    }

    private func replaceFailedRoot() -> URL {
        let fileManager = FileManager.default
        let discarded = container
            .appendingPathComponent("\(stagingPrefix)\(UUID().uuidString)", isDirectory: true)
        let previousIndex = previousWebRoot.appendingPathComponent("index.html")
        let restorable = fileManager.fileExists(atPath: previousIndex.path)
            && (try? readVersion(at: previousWebRoot)
                .write(to: unconfirmedMarker(in: previousWebRoot), atomically: true, encoding: .utf8)) != nil
        guard (try? fileManager.moveItem(at: managedWebRoot, to: discarded)) != nil else {
            return bundledWebRoot
        }
        defer { try? fileManager.removeItem(at: discarded) }
        if restorable, (try? fileManager.moveItem(at: previousWebRoot, to: managedWebRoot)) != nil {
            return managedWebRoot
        }
        return bundledWebRoot
    }

    private func keys(in list: URL) -> [String] {
        guard let text = try? String(contentsOf: list, encoding: .utf8) else { return [] }
        return text.split(whereSeparator: \.isNewline).map(String.init)
    }

    private func record(_ key: String, in list: URL) {
        var saved = keys(in: list)
        guard !saved.contains(key) else { return }
        saved.append(key)
        try? (saved.joined(separator: "\n") + "\n").write(to: list, atomically: true, encoding: .utf8)
    }

    func isRejected(_ key: String) -> Bool {
        keys(in: rejectedURL).contains(key)
    }

    private func downloadArchive(from url: URL, to destination: URL) async throws {
        let request = URLRequest(url: url)
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        try checkStatus(response, context: "The frontend package download")

        FileManager.default.createFile(atPath: destination.path, contents: nil)
        let archive = try FileHandle(forWritingTo: destination)
        defer { try? archive.close() }

        var downloadedBytes = 0
        var buffer = Data()
        buffer.reserveCapacity(64 * 1024)
        for try await byte in bytes {
            guard downloadedBytes < maxFrontendPackageBytes else {
                throw FrontendUpdateError.invalidPackage("unexpected package size")
            }
            downloadedBytes += 1
            buffer.append(byte)
            if buffer.count == 64 * 1024 {
                try archive.write(contentsOf: buffer)
                buffer.removeAll(keepingCapacity: true)
            }
        }
        guard downloadedBytes > 0 else {
            throw FrontendUpdateError.invalidPackage("unexpected package size")
        }
        if !buffer.isEmpty {
            try archive.write(contentsOf: buffer)
        }
    }

    private func checkStatus(_ response: URLResponse, context: String) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            throw FrontendUpdateError.httpStatus(context, http.statusCode)
        }
    }

    private func runUnzip(archive: URL, destination: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        process.arguments = ["-qq", archive.path, "-d", destination.path]
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw FrontendUpdateError.invalidPackage("could not extract the downloaded package")
        }
    }
}
