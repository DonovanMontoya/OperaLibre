import Foundation
import UIKit

final class CarLibraryStore {
    static let shared = CarLibraryStore()

    private let queue = DispatchQueue(label: "com.operalibre.car-library", qos: .userInitiated)
    private let snapshotQueue = DispatchQueue(label: "com.operalibre.car-library.snapshot", qos: .userInitiated)
    private let sessionsKey = "operalibre.car-playback-sessions.v1"
    private let artworkSourcesKey = "operalibre.car-artwork-sources.v1"
    private var cachedSnapshot: CarLibrarySnapshot?
    private let invalidatedKey = "operalibre.car-library-invalidated"
    private var artworkMemoryCache: [String: UIImage] = [:]
    var onArtworkChange: (() -> Void)?
    private var artworkEpoch = 0
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
        guard !UserDefaults.standard.bool(forKey: invalidatedKey) else { return .empty }
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
        snapshotQueue.async {
            do {
                try data.write(to: snapshotURL, options: .atomic)
                UserDefaults.standard.set(false, forKey: self.invalidatedKey)
            } catch { }
        }
        cacheArtwork(for: snapshot)
    }

    func clear() {
        cachedSnapshot = .empty
        snapshotQueue.sync {
            UserDefaults.standard.set(true, forKey: invalidatedKey)
            if let snapshotURL { try? FileManager.default.removeItem(at: snapshotURL) }
        }
        persistSessions(StoredRecordList())
        artworkMemoryCache.removeAll()
        artworkEpoch += 1
        queue.async { [weak self] in
            guard let self else { return }
            if let artworkDirectory = self.artworkDirectory {
                try? FileManager.default.removeItem(at: artworkDirectory)
            }
            UserDefaults.standard.removeObject(forKey: self.artworkSourcesKey)
        }
    }

    // MARK: - Sessions

    func pendingSessions() -> [CarPlaybackSession] {
        storedSessions().records
    }

    private func storedSessions() -> StoredRecordList<CarPlaybackSession> {
        StoredRecordList(decoding: UserDefaults.standard.data(forKey: sessionsKey))
    }

    func recordSession(_ session: CarPlaybackSession) {
        var sessions = storedSessions()
        sessions.records.removeAll { $0.bookId == session.bookId }
        sessions.records.append(session)
        persistSessions(sessions)
    }

    func acknowledgeSessions(_ acknowledged: [String: Double], clearRegressionForBookId: String? = nil) {
        var sessions = storedSessions()
        sessions.records = CarPlaybackSession.remainingAfterAcknowledgement(
            sessions.records, acknowledged: acknowledged,
            clearRegressionForBookId: clearRegressionForBookId
        )
        persistSessions(sessions)
    }

    private func persistSessions(_ sessions: StoredRecordList<CarPlaybackSession>) {
        guard let data = sessions.encoded() else { return }
        UserDefaults.standard.set(data, forKey: sessionsKey)
    }

    // MARK: - Artwork

    func artwork(for book: CarLibraryBook) -> UIImage {
        if let source = book.artworkUrl, !source.isEmpty {
            if let image = artworkMemoryCache[book.id] { return image }
            if let url = artworkDirectory?.appendingPathComponent("\(artworkFileName(book.id)).png"),
               let data = try? Data(contentsOf: url),
               let image = UIImage(data: data)
            {
                artworkMemoryCache[book.id] = image
                return image
            }
        }
        if let placeholder = placeholderCache[book.id] { return placeholder }
        let placeholder = spineArtwork()
        placeholderCache[book.id] = placeholder
        return placeholder
    }

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
        let wanted = snapshot.books.reduce(into: [String: String]()) { result, book in
            if let artworkUrl = book.artworkUrl, !artworkUrl.isEmpty {
                result[book.id] = artworkUrl
            }
        }
        artworkMemoryCache = artworkMemoryCache.filter { wanted[$0.key] != nil }
        let epoch = artworkEpoch
        queue.async { [weak self] in
            guard let self else { return }
            var sources = UserDefaults.standard.dictionary(forKey: self.artworkSourcesKey)
                as? [String: String] ?? [:]
            for bookId in Set(sources.keys).union(snapshot.books.map(\.id)) where wanted[bookId] == nil {
                if let file = self.artworkDirectory?.appendingPathComponent("\(self.artworkFileName(bookId)).png") {
                    try? FileManager.default.removeItem(at: file)
                }
                sources.removeValue(forKey: bookId)
            }
            for (bookId, source) in wanted where sources[bookId] != source {
                guard
                    let url = resolveNativeAudioSourceURL(source),
                    let data = fetchArtworkData(from: url),
                    let image = UIImage(data: data),
                    let scaled = self.scaled(image),
                    let encoded = scaled.pngData(),
                    let destination = self.artworkDirectory?
                        .appendingPathComponent("\(self.artworkFileName(bookId)).png")
                else { continue }
                do { try encoded.write(to: destination, options: .atomic) }
                catch { continue }
                sources[bookId] = source
                DispatchQueue.main.async {
                    guard epoch == self.artworkEpoch,
                          self.cachedSnapshot?.book(withId: bookId)?.artworkUrl == source else { return }
                    self.artworkMemoryCache[bookId] = scaled
                    self.onArtworkChange?()
                }
            }
            UserDefaults.standard.set(sources, forKey: self.artworkSourcesKey)
        }
    }

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
        let sanitized = bookId.unicodeScalars.prefix(48).reduce(into: "") { name, scalar in
            name.append(CharacterSet.alphanumerics.contains(scalar) ? Character(scalar) : "-")
        }
        let hash = bookId.unicodeScalars.reduce(UInt64(5381)) { hash, scalar in
            hash &* 33 &+ UInt64(scalar.value)
        }
        return "\(sanitized)-\(String(hash, radix: 36))"
    }
}
