import Foundation

@main
struct BackgroundDownloadPolicyTests {
    static func main() throws {
        let acceptedSources = [
            "https://books.example/api/books/book/tracks/track/stream?token=x",
            "http://192.168.1.20:4000/api/books/book/cover?token=x",
            "https://jellyfin.example/Audio/item/stream?api_key=x",
            "https://jellyfin.example/Items/item/Download?api_key=x",
            "https://jellyfin.example/Items/item/Images/Primary?api_key=x",
        ]
        for value in acceptedSources {
            precondition((try? validatedBackgroundMediaSource(URL(string: value)!)) != nil, value)
        }

        let allowlist = BackgroundDownloadAllowlist(serverAddress: URL(string: "https://books.example")!)!
        precondition(allowlist.basePath.isEmpty)
        precondition((try? validatedBackgroundMediaSource(
            URL(string: "https://books.example/api/books/book/cover")!,
            allowedBy: allowlist
        )) != nil)
        precondition((try? validatedBackgroundMediaSource(
            URL(string: "https://other.example/api/books/book/cover")!,
            allowedBy: allowlist
        )) == nil)
        precondition((try? validatedBackgroundMediaSource(
            URL(string: "http://127.0.0.1/api/books/book/cover")!,
            allowedBy: allowlist
        )) == nil)

        // A server reached through a reverse-proxy subpath keeps that prefix on
        // every media URL, so the allowlist has to skip it before matching.
        let proxied = BackgroundDownloadAllowlist(serverAddress: URL(string: "https://host.example/jellyfin")!)!
        precondition(proxied.basePath == "/jellyfin")
        let proxiedSources = [
            "https://host.example/jellyfin/Audio/item/stream?api_key=x",
            "https://host.example/jellyfin/Items/item/Images/Primary",
            "https://host.example/jellyfin/api/books/book/tracks/track/stream",
        ]
        for value in proxiedSources {
            precondition((try? validatedBackgroundMediaSource(
                URL(string: value)!,
                allowedBy: proxied
            )) != nil, value)
        }
        let proxiedRejections = [
            // Outside the base path, and a base path that only shares a prefix.
            "https://host.example/Audio/item/stream",
            "https://host.example/jellyfinx/Audio/item/stream",
            "https://host.example/jellyfin/System/Configuration",
            "https://host.example/jellyfin/Audio/item/stream/extra",
        ]
        for value in proxiedRejections {
            precondition((try? validatedBackgroundMediaSource(
                URL(string: value)!,
                allowedBy: proxied
            )) == nil, value)
        }

        let rejectedSources = [
            "file:///etc/passwd",
            "https://user:password@books.example/api/books/book/cover",
            "http://127.0.0.1/admin",
            "https://books.example/api/users",
            "https://books.example/api/books/book/private/cover",
            "https://jellyfin.example/Items/item/Images/Primary/extra",
        ]
        for value in rejectedSources {
            precondition((try? validatedBackgroundMediaSource(URL(string: value)!)) == nil, value)
        }

        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
            .appendingPathComponent("offline-media", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }

        let inside = root.appendingPathComponent("server/book/track.mp3")
        let outside = root.deletingLastPathComponent().appendingPathComponent("secret.txt")
        let traversal = root.appendingPathComponent("../secret.txt")
        precondition((try? validatedBackgroundMediaDestination(inside, under: root)) != nil)
        precondition((try? validatedBackgroundMediaDestination(outside, under: root)) == nil)
        precondition((try? validatedBackgroundMediaDestination(traversal, under: root)) == nil)

        let outsideDirectory = root.deletingLastPathComponent().appendingPathComponent("outside", isDirectory: true)
        let linkedDirectory = root.appendingPathComponent("linked", isDirectory: true)
        try FileManager.default.createDirectory(at: outsideDirectory, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: linkedDirectory, withDestinationURL: outsideDirectory)
        let throughSymlink = linkedDirectory.appendingPathComponent("track.mp3")
        precondition((try? validatedBackgroundMediaDestination(throughSymlink, under: root)) == nil)
    }
}
