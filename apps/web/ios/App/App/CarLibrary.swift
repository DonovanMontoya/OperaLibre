import Foundation

/// The library, as the car screen sees it.
///
/// Connecting to CarPlay can launch the app with no window scene at all: there
/// is no WebView, no React, no server session, and nothing to ask what is on
/// the shelf. So the app keeps a snapshot of the library on disk, written by
/// the web layer whenever it changes, and the car screen reads that. Every
/// value the car needs to start playing — track URLs with their media token,
/// the saved position, the book's gain — is in the snapshot, because none of it
/// can be fetched from a cold launch parked in a garage.
struct CarLibrarySnapshot: Codable {
    /// `serverStorageKey:userId`, the first two thirds of the recovery scope
    /// key the web player uses. Kept whole rather than rebuilt natively so the
    /// two sides cannot drift apart.
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
    /// Whole-book position, in seconds, as the web layer last knew it.
    var positionSeconds: Double
    var status: String
    var downloaded: Bool
    var volumeGain: Double?
    var tracks: [CarLibraryTrack]
    var chapters: [CarLibraryChapter]

    var isFinished: Bool { status == "finished" }
    var isInProgress: Bool { status == "inProgress" }

    /// Where a plain "play this book" starts. A book that was played to the
    /// end starts over rather than resuming a second past the last word.
    var resumePositionSeconds: Double {
        if isFinished { return 0 }
        if let durationSeconds, durationSeconds > 0, positionSeconds >= durationSeconds - 1 { return 0 }
        return max(0, positionSeconds)
    }

    /// Where in the queue a whole-book position lands: the track holding it,
    /// and the offset into that track.
    func target(atBookPosition position: Double) -> (trackIndex: Int, positionInTrack: Double)? {
        guard !tracks.isEmpty else { return nil }
        let position = max(0, position)
        for (index, track) in tracks.enumerated().reversed() where position >= track.bookOffsetSeconds {
            return (index, position - track.bookOffsetSeconds)
        }
        return (0, position)
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
}

struct CarLibraryChapter: Codable {
    var title: String
    var startSeconds: Double
    var durationSeconds: Double
    var trackId: String?
}

/// Progress made in the car, waiting for the web layer to save it.
///
/// The car never writes to the server itself. Every defense against a bad
/// progress write — the staleness check, the suspect-reset rule, the
/// book-summary fallback — lives in the web player and the server, and a second
/// writer that skipped them is exactly the failure those defenses exist for. So
/// a car session leaves its position here, and the app persists it through the
/// usual path the next time it runs.
struct CarPlaybackSession: Codable {
    var bookId: String
    var trackId: String
    var positionSeconds: Double
    var bookPositionSeconds: Double
    var durationSeconds: Double?
    var updatedAt: Double
    var finished: Bool
    /// The listener jumped rather than simply listening on. The server refuses
    /// a write that drops a substantial position back to near zero unless the
    /// client says the move was deliberate, so the car has to pass that intent
    /// along with the position.
    var intentionalRegression: Bool
}

extension CarLibraryBook {
    /// The line under a book's title on the car screen: who wrote it, and what
    /// tapping it will do.
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

/// How much listening is left, in the shelf's own phrasing.
func carDurationLabel(seconds: Double) -> String {
    let total = Int(max(0, seconds.rounded()))
    let hours = total / 3600
    let minutes = (total % 3600) / 60
    if hours > 0 { return minutes > 0 ? "\(hours)h \(minutes)m" : "\(hours)h" }
    if minutes > 0 { return "\(minutes)m" }
    return "under a minute"
}

/// A position in the book, as a clock reads it. The duration label answers
/// "how much is left"; a chapter list answers "where does this start", and
/// "under a minute" is not an answer to that question.
func carTimestampLabel(seconds: Double) -> String {
    let total = Int(max(0, seconds.rounded()))
    let hours = total / 3600, minutes = (total % 3600) / 60, remainder = total % 60
    return hours > 0
        ? String(format: "%d:%02d:%02d", hours, minutes, remainder)
        : String(format: "%d:%02d", minutes, remainder)
}
