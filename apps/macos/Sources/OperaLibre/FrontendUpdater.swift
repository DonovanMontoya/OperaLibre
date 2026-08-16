import CryptoKit
import Foundation

private let releaseApiURL = URL(string: "https://api.github.com/repos/DonovanMontoya/OperaLibre/releases/latest")!
private let releaseDownloadPrefix = "https://github.com/DonovanMontoya/OperaLibre/releases/download/"
private let maxFrontendPackageBytes = 50 * 1024 * 1024
private let stagingPrefix = ".staging-"
/// Records the fingerprint of the bundle the managed root was last reset from.
private let bundleStampName = ".bundle-stamp"
/// How long a staging directory must sit untouched before it counts as abandoned rather
/// than in use by a concurrently launching instance.
private let staleStagingAge: TimeInterval = 60 * 60

struct GithubReleaseAsset: Decodable {
    let name: String
    let browser_download_url: String
    let size: Int
    let digest: String?
}

struct GithubRelease: Decodable {
    let tag_name: String
    let assets: [GithubReleaseAsset]
}

enum FrontendUpdateError: LocalizedError {
    case noMatchingAsset
    case untrustedDownloadURL
    case invalidDigest
    case digestMismatch
    case invalidPackage(String)
    case httpStatus(String, Int)
    case network(Error)

    var errorDescription: String? {
        switch self {
        case .noMatchingAsset:
            return "The latest release does not include a macOS web frontend package."
        case .untrustedDownloadURL:
            return "The frontend package download URL was not from GitHub."
        case .invalidDigest:
            return "The frontend package has no valid SHA-256 digest."
        case .digestMismatch:
            return "The downloaded frontend package failed checksum verification."
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
    let asset: GithubReleaseAsset?
}

/// Parses "1.2.3" (optional leading v) into [major, minor, patch]; nil for anything else, including "dev".
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

    /// The root `resolveServingRoot()` actually handed to the web server. Version checks read
    /// from this rather than `managedWebRoot`, because a failed staging swap falls back to
    /// serving the read-only bundle and a leftover managed tree would otherwise report a
    /// version nobody is running.
    private(set) var servingRoot: URL?

    init(bundledWebRoot: URL, managedWebRoot: URL) {
        self.bundledWebRoot = bundledWebRoot
        self.managedWebRoot = managedWebRoot
    }

    private func readVersion(at webRoot: URL) -> String {
        let marker = webRoot.appendingPathComponent("VERSION.txt")
        guard let contents = try? String(contentsOf: marker, encoding: .utf8) else {
            return "dev"
        }
        return contents.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Fingerprint of the bundled web root. `index.html` references Vite's content-hashed
    /// asset filenames, so hashing it detects any rebuild of the frontend; the version
    /// marker is folded in so a re-stamped but otherwise identical build still counts.
    private func bundleFingerprint() -> String? {
        let index = bundledWebRoot.appendingPathComponent("index.html")
        guard let data = try? Data(contentsOf: index) else { return nil }
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return "\(readVersion(at: bundledWebRoot)):\(digest)"
    }

    /// Ensures a servable web root exists and returns it. A rebuilt bundle wins over any
    /// previously auto-installed release, so `script/build_and_run.sh` keeps reflecting the
    /// current checkout without interference from update state.
    func resolveServingRoot() -> URL {
        let fileManager = FileManager.default
        let container = managedWebRoot.deletingLastPathComponent()
        // Swept unconditionally: a leftover that is still too young to collect here would
        // otherwise never be revisited once resets stop happening, leaking a full copy of
        // the web bundle for good.
        removeStaleStagingDirectories(in: container)

        let managedVersionMarker = managedWebRoot.appendingPathComponent("VERSION.txt")
        let managedExists = fileManager.fileExists(atPath: managedVersionMarker.path)
        let stampURL = container.appendingPathComponent(bundleStampName)
        let recordedStamp = try? String(contentsOf: stampURL, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let fingerprint = bundleFingerprint()

        // Reset when the bundle itself changed since we last copied it — not merely because
        // it reports "dev". A locally built shell is always "dev" (build_and_run.sh does not
        // set OPERALIBRE_VERSION and no release job ships a macOS .app), so the old rule made
        // this branch unconditional and silently discarded every installed update on the next
        // relaunch. Comparing the bundle against its own last-copied fingerprint keeps a fresh
        // `build_and_run.sh` build authoritative for the current checkout while letting an
        // installed release survive untouched.
        let shouldResetFromBundle = !managedExists || fingerprint == nil || fingerprint != recordedStamp

        if shouldResetFromBundle {
            // Copy into a staging directory first and only swap it into place once it's
            // fully written and validated. A copy that fails partway (disk full,
            // interrupted, ...) must never leave a half-written tree at managedWebRoot:
            // its VERSION.txt could already be present and match, so the next launch
            // would treat the broken tree as complete and reuse it indefinitely.
            // The copy lands in a wrapper directory we create ourselves rather than being the
            // staging directory: `copyItem` preserves the source's modification date, so a
            // tree copied straight from the app bundle would inherit the build date and read
            // as stale the instant it exists. Creating the wrapper — and then adding a child
            // to it — stamps it with the current time, which is what the sweep below trusts.
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
                // Recorded only after the swap actually landed, so an interrupted reset is
                // retried on the next launch rather than being mistaken for up to date.
                if let fingerprint {
                    try? fingerprint.write(to: stampURL, atomically: true, encoding: .utf8)
                }
            } catch {
                try? fileManager.removeItem(at: stagingRoot)
                // The managed root, if any, was left untouched above — serve the
                // read-only bundle directly rather than a missing/partial managed root.
                servingRoot = bundledWebRoot
                return bundledWebRoot
            }
        }

        servingRoot = managedWebRoot
        return managedWebRoot
    }

    /// Deletes leftover staging trees from interrupted copies. Only trees untouched for
    /// `staleStagingAge` are removed: a second instance launching concurrently is still
    /// writing into its own staging directory, and deleting that out from under it would
    /// leave it promoting a half-copied tree — precisely what staging exists to prevent.
    /// This relies on the wrapper directory carrying a genuine creation time; see the
    /// staging setup in `resolveServingRoot()`.
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

    /// Set once `install()` succeeds. When a failed staging swap pinned `servingRoot` to the
    /// read-only bundle, the bundle's marker never changes, so without this the same release
    /// would be offered and re-downloaded on every check for the rest of the session.
    private var installedVersion: String?

    var currentVersion: String {
        installedVersion ?? readVersion(at: servingRoot ?? managedWebRoot)
    }

    /// False when a failed staging swap left us serving the read-only bundle. `install()`
    /// writes to `managedWebRoot`, so in that case a reload cannot pick the update up.
    var isServingManagedRoot: Bool {
        servingRoot?.standardizedFileURL == managedWebRoot.standardizedFileURL
    }

    func checkForUpdate() async throws -> FrontendUpdateStatus {
        var request = URLRequest(url: releaseApiURL)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")

        let release: GithubRelease
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            // Without this an unauthenticated rate-limit (403) or an outage page reaches the
            // decoder and is reported as a malformed-data error, which tells nobody anything.
            try checkStatus(response, context: "The GitHub release feed")
            release = try JSONDecoder().decode(GithubRelease.self, from: data)
        } catch let error as FrontendUpdateError {
            throw error
        } catch {
            throw FrontendUpdateError.network(error)
        }

        let latestVersion = release.tag_name.hasPrefix("v")
            ? String(release.tag_name.dropFirst())
            : release.tag_name
        let assetName = "operalibre-\(latestVersion)-frontend.zip"
        let asset = release.assets.first { $0.name == assetName }

        let current = currentVersion
        let updateAvailable: Bool
        if let currentParsed = parseSemver(current), let latestParsed = parseSemver(latestVersion) {
            updateAvailable = isSemver(latestParsed, newerThan: currentParsed) && asset != nil
        } else {
            // A "dev" build has no comparable version; any published release counts as available.
            updateAvailable = asset != nil
        }

        return FrontendUpdateStatus(
            currentVersion: current,
            latestVersion: latestVersion,
            updateAvailable: updateAvailable,
            asset: asset
        )
    }

    func install(_ status: FrontendUpdateStatus) async throws {
        guard let asset = status.asset else {
            throw FrontendUpdateError.noMatchingAsset
        }
        guard asset.browser_download_url.hasPrefix(releaseDownloadPrefix) else {
            throw FrontendUpdateError.untrustedDownloadURL
        }
        guard let digestField = asset.digest,
            let expectedDigest = digestField.hasPrefix("sha256:") ? String(digestField.dropFirst(7)) : nil,
            expectedDigest.count == 64
        else {
            throw FrontendUpdateError.invalidDigest
        }
        guard asset.size > 0, asset.size <= maxFrontendPackageBytes else {
            throw FrontendUpdateError.invalidPackage("unexpected package size")
        }
        guard let downloadURL = URL(string: asset.browser_download_url) else {
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
        guard actualDigest == expectedDigest.lowercased() else {
            throw FrontendUpdateError.digestMismatch
        }

        let extractDir = workDir.appendingPathComponent("extracted", isDirectory: true)
        try fileManager.createDirectory(at: extractDir, withIntermediateDirectories: true)
        try runUnzip(archive: archivePath, destination: extractDir)

        let packageRoot = extractDir.appendingPathComponent("operalibre-\(status.latestVersion)-frontend", isDirectory: true)
        let stagedWeb = packageRoot.appendingPathComponent("web", isDirectory: true)
        let stagedIndex = stagedWeb.appendingPathComponent("index.html")
        let stagedVersionMarker = stagedWeb.appendingPathComponent("VERSION.txt")
        guard fileManager.fileExists(atPath: stagedIndex.path) else {
            throw FrontendUpdateError.invalidPackage("missing index.html")
        }
        guard let stagedVersion = try? String(contentsOf: stagedVersionMarker, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
            stagedVersion == status.latestVersion
        else {
            throw FrontendUpdateError.invalidPackage("version marker does not match the release")
        }

        try fileManager.createDirectory(
            at: managedWebRoot.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let backupDir = workDir.appendingPathComponent("previous", isDirectory: true)
        let hadExisting = fileManager.fileExists(atPath: managedWebRoot.path)
        if hadExisting {
            try fileManager.moveItem(at: managedWebRoot, to: backupDir)
        }
        do {
            try fileManager.moveItem(at: stagedWeb, to: managedWebRoot)
        } catch {
            if hadExisting {
                try? fileManager.moveItem(at: backupDir, to: managedWebRoot)
            }
            throw error
        }
        installedVersion = status.latestVersion
    }

    /// Streams an update into our scoped workspace instead of asking URLSession to create an
    /// unbounded temporary file. The byte limit is checked before each write, so an oversized
    /// response never consumes more than the configured package allowance on disk.
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
