import Foundation
import UIKit

/// Reads and writes the snapshot, the pending sessions, and the cached cover
/// art. Everything here has to work with no network and no WebView.
final class CarLibraryStore {
    static let shared = CarLibraryStore()

    private let queue = DispatchQueue(label: "com.operalibre.car-library", qos: .userInitiated)
    private let sessionsKey = "operalibre.car-playback-sessions.v1"
    private let artworkSourcesKey = "operalibre.car-artwork-sources.v1"
    private var cachedSnapshot: CarLibrarySnapshot?
    private var artworkMemoryCache: [String: UIImage] = [:]
    private var placeholderCache: [String: UIImage] = [:]

    private var directory: URL? {
        guard
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return nil }
        let directory = base.appendingPathComponent("CarLibrary", isDirectory: true)
        if !FileManager.default.fileExists(atPath: directory.path) {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        return directory
    }

    private var snapshotURL: URL? {
        directory?.appendingPathComponent("library.json")
    }

    private var artworkDirectory: URL? {
        guard let directory else { return nil }
        let artwork = directory.appendingPathComponent("artwork", isDirectory: true)
        if !FileManager.default.fileExists(atPath: artwork.path) {
            try? FileManager.default.createDirectory(at: artwork, withIntermediateDirectories: true)
        }
        return artwork
    }

    // MARK: - Snapshot

    func snapshot() -> CarLibrarySnapshot {
        if let cachedSnapshot { return cachedSnapshot }
        guard
            let snapshotURL,
            let data = try? Data(contentsOf: snapshotURL),
            let snapshot = try? JSONDecoder().decode(CarLibrarySnapshot.self, from: data)
        else { return .empty }
        cachedSnapshot = snapshot
        return snapshot
    }

    func save(_ snapshot: CarLibrarySnapshot) {
        cachedSnapshot = snapshot
        guard let snapshotURL, let data = try? JSONEncoder().encode(snapshot) else { return }
        queue.async {
            try? data.write(to: snapshotURL, options: .atomic)
        }
        cacheArtwork(for: snapshot)
    }

    // MARK: - Sessions

    func pendingSessions() -> [CarPlaybackSession] {
        guard
            let data = UserDefaults.standard.data(forKey: sessionsKey),
            let sessions = try? JSONDecoder().decode([CarPlaybackSession].self, from: data)
        else { return [] }
        return sessions
    }

    /// One record per book: a car session that keeps running only moves its own
    /// position forward, and the newest one is the only one worth saving.
    func recordSession(_ session: CarPlaybackSession) {
        var sessions = pendingSessions().filter { $0.bookId != session.bookId }
        sessions.append(session)
        persistSessions(sessions)
    }

    /// Drops the sessions the web layer has saved. Entries are matched on their
    /// timestamp as well as their book so a session that advanced between the
    /// read and the acknowledgement survives to be saved again.
    func acknowledgeSessions(_ acknowledged: [String: Double]) {
        let remaining = pendingSessions().filter { session in
            guard let savedAt = acknowledged[session.bookId] else { return true }
            return session.updatedAt > savedAt
        }
        persistSessions(remaining)
    }

    private func persistSessions(_ sessions: [CarPlaybackSession]) {
        guard let data = try? JSONEncoder().encode(sessions) else { return }
        UserDefaults.standard.set(data, forKey: sessionsKey)
    }

    // MARK: - Artwork

    /// A cover for the car list, at the size CarPlay draws it.
    ///
    /// Returns what is already cached; a miss falls back to the drawn spine
    /// rather than blocking the car screen on a download, and the real cover
    /// lands in the cache for the next look.
    func artwork(for book: CarLibraryBook) -> UIImage {
        if let image = artworkMemoryCache[book.id] { return image }
        if let url = artworkDirectory?.appendingPathComponent("\(artworkFileName(book.id)).png"),
           let data = try? Data(contentsOf: url),
           let image = UIImage(data: data)
        {
            artworkMemoryCache[book.id] = image
            return image
        }
        if let placeholder = placeholderCache[book.id] { return placeholder }
        let placeholder = spineArtwork()
        placeholderCache[book.id] = placeholder
        return placeholder
    }

    /// The shelf's own stand-in for a book with no artwork: an oxblood spine
    /// with a gilt rule. A car list of blank rows says nothing about which book
    /// is which, and the app already answers that question this way.
    private func spineArtwork() -> UIImage {
        let size = CGSize(width: 108, height: 160)
        return UIGraphicsImageRenderer(size: size).image { context in
            let cgContext = context.cgContext
            let board = UIBezierPath(
                roundedRect: CGRect(origin: .zero, size: size),
                byRoundingCorners: [.topRight, .bottomRight],
                cornerRadii: CGSize(width: 4, height: 4)
            )
            cgContext.saveGState()
            board.addClip()
            let colors = [
                UIColor(red: 0.545, green: 0.180, blue: 0.122, alpha: 1).cgColor,
                UIColor(red: 0.369, green: 0.118, blue: 0.075, alpha: 1).cgColor,
                UIColor(red: 0.165, green: 0.059, blue: 0.031, alpha: 1).cgColor
            ] as CFArray
            if let gradient = CGGradient(
                colorsSpace: CGColorSpaceCreateDeviceRGB(),
                colors: colors,
                locations: [0, 0.6, 1]
            ) {
                cgContext.drawLinearGradient(
                    gradient,
                    start: .zero,
                    end: CGPoint(x: size.width, y: size.height),
                    options: []
                )
            }
            // The binding: a shadowed edge with the gilt line the shelf draws
            // inside it.
            UIColor(white: 0, alpha: 0.3).setFill()
            cgContext.fill(CGRect(x: 0, y: 0, width: 6, height: size.height))
            UIColor(red: 0.722, green: 0.537, blue: 0.227, alpha: 0.4).setFill()
            cgContext.fill(CGRect(x: 6, y: 0, width: 2, height: size.height))
            UIColor(white: 0, alpha: 0.3).setFill()
            cgContext.fill(CGRect(x: 8, y: 0, width: 2, height: size.height))
            cgContext.restoreGState()

            UIColor(red: 0.851, green: 0.710, blue: 0.455, alpha: 0.4).setStroke()
            let rule = UIBezierPath(rect: CGRect(x: 16, y: 10, width: size.width - 24, height: size.height - 20))
            rule.lineWidth = 1
            rule.stroke()

            let glyphConfiguration = UIImage.SymbolConfiguration(pointSize: 34, weight: .light)
            if let glyph = UIImage(systemName: "book.closed", withConfiguration: glyphConfiguration)?
                .withTintColor(
                    UIColor(red: 0.851, green: 0.710, blue: 0.455, alpha: 1),
                    renderingMode: .alwaysOriginal
                )
            {
                glyph.draw(at: CGPoint(
                    x: (size.width - glyph.size.width) / 2 + 4,
                    y: (size.height - glyph.size.height) / 2
                ))
            }
        }
    }

    private func cacheArtwork(for snapshot: CarLibrarySnapshot) {
        var sources = UserDefaults.standard.dictionary(forKey: artworkSourcesKey) as? [String: String] ?? [:]
        let wanted = snapshot.books.reduce(into: [String: String]()) { result, book in
            if let artworkUrl = book.artworkUrl, !artworkUrl.isEmpty {
                result[book.id] = artworkUrl
            }
        }
        let stale = wanted.filter { sources[$0.key] != $0.value }
        guard !stale.isEmpty else { return }
        queue.async { [weak self] in
            guard let self else { return }
            for (bookId, source) in stale {
                guard
                    let url = resolveNativeAudioSourceURL(source),
                    let data = try? Data(contentsOf: url),
                    let image = UIImage(data: data),
                    let scaled = self.scaled(image),
                    let encoded = scaled.pngData(),
                    let destination = self.artworkDirectory?
                        .appendingPathComponent("\(self.artworkFileName(bookId)).png")
                else { continue }
                try? encoded.write(to: destination, options: .atomic)
                sources[bookId] = source
                DispatchQueue.main.async {
                    self.artworkMemoryCache[bookId] = scaled
                }
            }
            UserDefaults.standard.set(sources, forKey: self.artworkSourcesKey)
        }
    }

    /// Car screens are small and their list rows smaller. A full-size cover
    /// costs memory the app does not need to spend to fill a 60-point cell.
    private func scaled(_ image: UIImage) -> UIImage? {
        let side: CGFloat = 160
        guard image.size.width > side || image.size.height > side else { return image }
        let scale = min(side / image.size.width, side / image.size.height)
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }

    private func artworkFileName(_ bookId: String) -> String {
        // Book ids come from library paths and Jellyfin ids, so they are not
        // safe as file names on their own. Sanitizing alone would let two books
        // whose ids differ only in punctuation share one cover, so the id's
        // hash rides along.
        let sanitized = bookId.unicodeScalars.prefix(48).reduce(into: "") { name, scalar in
            name.append(CharacterSet.alphanumerics.contains(scalar) ? Character(scalar) : "-")
        }
        let hash = bookId.unicodeScalars.reduce(UInt64(5381)) { hash, scalar in
            hash &* 33 &+ UInt64(scalar.value)
        }
        return "\(sanitized)-\(String(hash, radix: 36))"
    }
}
