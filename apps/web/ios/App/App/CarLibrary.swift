import Foundation

struct CarLibrarySnapshot: Codable {
    var scopePrefix: String
    var playbackRate: Double
    var updatedAt: Double
    var books: [CarLibraryBook]

    static let empty = CarLibrarySnapshot(scopePrefix: "", playbackRate: 1, updatedAt: 0, books: [])

    func recoveryScopeKey(forBookId bookId: String) -> String {
        "\(scopePrefix):\(bookId)"
    }

    func book(withId bookId: String) -> CarLibraryBook? {
        books.first { $0.id == bookId }
    }

    func audiobookToResume(sessions: [CarPlaybackSession]) -> CarLibraryBook? {
        guard !scopePrefix.isEmpty else { return nil }
        let latest = sessions.filter { book(withId: $0.bookId) != nil }
            .max { $0.updatedAt < $1.updatedAt }
        let candidate: CarLibraryBook?
        if let latest, let book = book(withId: latest.bookId) {
            candidate = resuming(book, sessions: sessions)
        } else {
            let reading = books.filter { $0.isInProgress }
            candidate = reading.count == 1 ? reading.first : nil
        }
        guard let candidate, !candidate.isFinished, !candidate.tracks.isEmpty,
              candidate.positionSeconds.isFinite,
              candidate.positionSeconds == 0 || candidate.resumePositionSeconds > 0
        else { return nil }
        return candidate
    }

    func resuming(_ book: CarLibraryBook, sessions: [CarPlaybackSession]) -> CarLibraryBook {
        guard let session = sessions.filter({
            $0.bookId == book.id && $0.updatedAt > updatedAt && $0.bookPositionSeconds.isFinite
        }).max(by: { $0.updatedAt < $1.updatedAt }) else { return book }
        var resumed = book
        resumed.positionSeconds = session.bookPositionSeconds
        resumed.status = session.finished ? "finished" : "inProgress"
        return resumed
    }

    func libraryGroups(maximumItemCount: Int) -> [(String, [CarLibraryBook])] {
        var remaining = max(0, maximumItemCount)
        return [
            ("Reading", books.filter { $0.isInProgress }),
            ("Not started", books.filter { !$0.isInProgress && !$0.isFinished }),
            ("Finished", books.filter { $0.isFinished })
        ].compactMap { title, books in
            let items = Array(books.prefix(remaining))
            remaining -= items.count
            return items.isEmpty ? nil : (title, items)
        }
    }
}

struct CarLibraryBook: Codable {
    var id: String
    var title: String
    var author: String?
    var artworkUrl: String?
    var durationSeconds: Double?
    var positionSeconds: Double
    var status: String
    var downloaded: Bool
    var volumeGain: Double?
    var tracks: [CarLibraryTrack]
    var chapters: [CarLibraryChapter]

    var isFinished: Bool { status == "finished" }
    var isInProgress: Bool { status == "inProgress" }

    var resumePositionSeconds: Double {
        if isFinished { return 0 }
        if let durationSeconds, durationSeconds > 0, positionSeconds >= durationSeconds - 1 { return 0 }
        return max(0, positionSeconds)
    }

    func target(atBookPosition position: Double) -> (trackIndex: Int, positionInTrack: Double)? {
        guard !tracks.isEmpty else { return nil }
        let position = max(0, position)
        for (index, track) in tracks.enumerated().reversed() where position >= track.bookOffsetSeconds {
            return (index, position - track.bookOffsetSeconds)
        }
        return (0, position)
    }

    /// The tracks that play back to back from `trackIndex`. The run ends at
    /// the first track `resolve` rejects, which is returned so playback can
    /// stop there instead of skipping audio and jumping ahead in the book.
    func playableRun<Item>(
        from trackIndex: Int,
        resolve: (CarLibraryTrack) -> Item?
    ) -> (items: [Item], stopsBefore: CarLibraryTrack?) {
        guard tracks.indices.contains(trackIndex) else { return ([], nil) }
        var items: [Item] = []
        for track in tracks[trackIndex...] {
            guard let item = resolve(track) else { return (items, track) }
            items.append(item)
        }
        return (items, nil)
    }

    var percentComplete: Double? {
        guard let durationSeconds, durationSeconds > 0 else { return nil }
        return min(1, max(0, positionSeconds / durationSeconds))
    }
}

struct CarLibraryTrack: Codable {
    var id: String
    var title: String
    var url: String
    var durationSeconds: Double?
    var bookOffsetSeconds: Double

    /// The web layer sends an empty address for a track this phone cannot
    /// play, keeping its place in the book.
    var isAvailable: Bool { !url.isEmpty }
}

struct CarLibraryChapter: Codable {
    var title: String
    var startSeconds: Double
    var durationSeconds: Double
    var trackId: String?
}

struct CarPlaybackSession: Codable {
    var bookId: String
    var trackId: String
    var positionSeconds: Double
    var bookPositionSeconds: Double
    var durationSeconds: Double?
    var updatedAt: Double
    var finished: Bool
    var intentionalRegression: Bool

    static func remainingAfterAcknowledgement(
        _ sessions: [CarPlaybackSession],
        acknowledged: [String: Double],
        clearRegressionForBookId: String?
    ) -> [CarPlaybackSession] {
        sessions.compactMap { session in
            guard let savedAt = acknowledged[session.bookId] else { return session }
            guard session.updatedAt > savedAt else { return nil }
            var remaining = session
            if session.bookId == clearRegressionForBookId {
                remaining.intentionalRegression = false
            }
            return remaining
        }
    }
}

extension CarLibraryBook {
    var carSubtitle: String {
        var parts: [String] = []
        if let author, !author.isEmpty { parts.append(author) }
        if isFinished {
            parts.append("Finished")
        } else if let durationSeconds, durationSeconds > 0 {
            parts.append(
                resumePositionSeconds > 0
                    ? "\(carDurationLabel(seconds: durationSeconds - resumePositionSeconds)) left"
                    : carDurationLabel(seconds: durationSeconds)
            )
        }
        return parts.joined(separator: " · ")
    }
}

func carDurationLabel(seconds: Double) -> String {
    let total = Int(max(0, seconds.rounded()))
    let hours = total / 3600
    let minutes = (total % 3600) / 60
    if hours > 0 { return minutes > 0 ? "\(hours)h \(minutes)m" : "\(hours)h" }
    if minutes > 0 { return "\(minutes)m" }
    return "under a minute"
}

func carTimestampLabel(seconds: Double) -> String {
    let total = Int(max(0, seconds.rounded()))
    let hours = total / 3600, minutes = (total % 3600) / 60, remainder = total % 60
    return hours > 0
        ? String(format: "%d:%02d:%02d", hours, minutes, remainder)
        : String(format: "%d:%02d", minutes, remainder)
}
