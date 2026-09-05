import Foundation

enum BackgroundDownloadPolicyError: Error {
    case invalidSource
    case invalidDestination
}

let maximumBackgroundDownloadBytes: Int64 = 25 * 1024 * 1024 * 1024

func normalizedBackgroundDownloadOrigin(_ url: URL) -> String? {
    guard
        let scheme = url.scheme?.lowercased(),
        scheme == "http" || scheme == "https",
        let host = url.host?.lowercased(),
        !host.isEmpty,
        url.user == nil,
        url.password == nil
    else { return nil }
    let defaultPort = scheme == "https" ? 443 : 80
    return "\(scheme)://\(host):\(url.port ?? defaultPort)"
}

/// The path prefix a configured server address carries, if any. A server can
/// live behind a reverse-proxy subpath (`https://host/jellyfin`), so media
/// paths are only approved after that prefix is removed.
func normalizedBackgroundDownloadBasePath(_ url: URL) -> String {
    var path = url.path
    while path.hasSuffix("/") { path.removeLast() }
    return path
}

private func mediaPathComponents(_ path: String, basePath: String) -> [String]? {
    let base = basePath.split(separator: "/").map(String.init)
    let components = path.split(separator: "/").map(String.init)
    guard components.count >= base.count, Array(components.prefix(base.count)) == base else {
        return nil
    }
    return Array(components.dropFirst(base.count))
}

func isApprovedBackgroundMediaPath(_ path: String, basePath: String = "") -> Bool {
    guard let components = mediaPathComponents(path, basePath: basePath) else { return false }
    if components.count == 4,
       components[0] == "api",
       components[1] == "books",
       ["cover", "readalong", "sync", "download"].contains(components.last ?? "") {
        return true
    }
    if components.count == 6,
       components[0] == "api",
       components[1] == "books",
       components[3] == "tracks",
       components.last == "stream" {
        return true
    }
    if components.count == 3,
       components[0].caseInsensitiveCompare("Audio") == .orderedSame,
       components.last?.caseInsensitiveCompare("stream") == .orderedSame {
        return true
    }
    if components.count == 3,
       components[0].caseInsensitiveCompare("Items") == .orderedSame,
       components.last?.caseInsensitiveCompare("Download") == .orderedSame {
        return true
    }
    if components.count == 4,
       components[0].caseInsensitiveCompare("Items") == .orderedSame,
       components[2].caseInsensitiveCompare("Images") == .orderedSame {
        return true
    }
    return false
}

/// The single server a job is allowed to download from: its origin plus any
/// base path the configured server address carries.
struct BackgroundDownloadAllowlist: Equatable {
    let origin: String
    let basePath: String

    init(origin: String, basePath: String) {
        self.origin = origin
        self.basePath = basePath
    }

    init?(serverAddress: URL) {
        guard let origin = normalizedBackgroundDownloadOrigin(serverAddress) else { return nil }
        self.init(origin: origin, basePath: normalizedBackgroundDownloadBasePath(serverAddress))
    }
}

func validatedBackgroundMediaSource(_ source: URL, basePath: String = "") throws -> URL {
    guard
        normalizedBackgroundDownloadOrigin(source) != nil,
        isApprovedBackgroundMediaPath(source.path, basePath: basePath)
    else { throw BackgroundDownloadPolicyError.invalidSource }
    return source
}

func validatedBackgroundMediaSource(
    _ source: URL,
    allowedBy allowlist: BackgroundDownloadAllowlist
) throws -> URL {
    guard normalizedBackgroundDownloadOrigin(source) == allowlist.origin else {
        throw BackgroundDownloadPolicyError.invalidSource
    }
    return try validatedBackgroundMediaSource(source, basePath: allowlist.basePath)
}

func backgroundOfflineMediaRoot() throws -> URL {
    guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
        throw BackgroundDownloadPolicyError.invalidDestination
    }
    var root = documents.appendingPathComponent("offline-media", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    // Offline copies can be re-downloaded from the server, so keep gigabytes
    // of audio out of the iCloud and iTunes backups of Documents.
    var resourceValues = URLResourceValues()
    resourceValues.isExcludedFromBackup = true
    do {
        try root.setResourceValues(resourceValues)
    } catch {
        NSLog("Unable to exclude offline media from backups: %@", error.localizedDescription)
    }
    return root.resolvingSymlinksInPath().standardizedFileURL
}

private func resolvingExistingPathComponents(_ url: URL) -> URL {
    var existingAncestor = url.standardizedFileURL
    var suffix: [String] = []
    while !FileManager.default.fileExists(atPath: existingAncestor.path),
          existingAncestor.path != "/" {
        suffix.append(existingAncestor.lastPathComponent)
        existingAncestor.deleteLastPathComponent()
    }
    var resolved = existingAncestor.resolvingSymlinksInPath().standardizedFileURL
    for component in suffix.reversed() {
        resolved.appendPathComponent(component)
    }
    return resolved.standardizedFileURL
}

func validatedBackgroundMediaDestination(_ destination: URL, under root: URL) throws -> URL {
    guard destination.isFileURL else { throw BackgroundDownloadPolicyError.invalidDestination }
    let resolvedRoot = root.resolvingSymlinksInPath().standardizedFileURL
    let resolved = resolvingExistingPathComponents(destination)
    let rootPrefix = resolvedRoot.path.hasSuffix("/") ? resolvedRoot.path : resolvedRoot.path + "/"
    guard resolved.path.hasPrefix(rootPrefix) else {
        throw BackgroundDownloadPolicyError.invalidDestination
    }
    return resolved
}

func validatedBackgroundMediaDestination(_ destination: URL) throws -> URL {
    try validatedBackgroundMediaDestination(destination, under: backgroundOfflineMediaRoot())
}
