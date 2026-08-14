import CryptoKit
import Foundation

private let releaseApiURL = URL(string: "https://api.github.com/repos/DonovanMontoya/OperaLibre/releases/latest")!
private let releaseDownloadPrefix = "https://github.com/DonovanMontoya/OperaLibre/releases/download/"
private let maxFrontendPackageBytes = 50 * 1024 * 1024

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

    /// Ensures a servable web root exists and returns it. A locally rebuilt ("dev") bundle
    /// always wins over any previously auto-installed release, so `script/build_and_run.sh`
    /// keeps reflecting the current checkout without interference from update state.
    func resolveServingRoot() -> URL {
        let fileManager = FileManager.default
        let bundledVersion = readVersion(at: bundledWebRoot)
        let managedVersionMarker = managedWebRoot.appendingPathComponent("VERSION.txt")
        let managedExists = fileManager.fileExists(atPath: managedVersionMarker.path)

        var shouldResetFromBundle = !managedExists || bundledVersion == "dev"
        if !shouldResetFromBundle, let bundled = parseSemver(bundledVersion) {
            let managedVersion = readVersion(at: managedWebRoot)
            if let managed = parseSemver(managedVersion), isSemver(bundled, newerThan: managed) {
                shouldResetFromBundle = true
            }
        }

        if shouldResetFromBundle {
            try? fileManager.removeItem(at: managedWebRoot)
            do {
                try fileManager.createDirectory(
                    at: managedWebRoot.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try fileManager.copyItem(at: bundledWebRoot, to: managedWebRoot)
            } catch {
                // Copy failed (disk full, permissions, interrupted) and the managed root
                // was just removed above — serve the read-only bundle directly rather than
                // a missing/partial managed root with no diagnostic.
                return bundledWebRoot
            }
        }

        return managedWebRoot
    }

    var currentVersion: String {
        readVersion(at: managedWebRoot)
    }

    func checkForUpdate() async throws -> FrontendUpdateStatus {
        var request = URLRequest(url: releaseApiURL)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")

        let release: GithubRelease
        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            release = try JSONDecoder().decode(GithubRelease.self, from: data)
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
        let (downloadedURL, _) = try await URLSession.shared.download(from: downloadURL)
        try fileManager.moveItem(at: downloadedURL, to: archivePath)

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
