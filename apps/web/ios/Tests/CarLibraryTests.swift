import Foundation

/// Checks the arithmetic the car screen resumes a book with.
///
/// Run it the same way as the other checks here:
/// `swiftc apps/web/ios/Tests/CarLibraryTests.swift apps/web/ios/App/App/CarLibrary.swift -o /tmp/carlibrary && /tmp/carlibrary`
@main
struct CarLibraryTests {
    static func book(
        status: String = "inProgress",
        positionSeconds: Double,
        durationSeconds: Double? = 3_600
    ) -> CarLibraryBook {
        CarLibraryBook(
            id: "book",
            title: "A Book",
            author: "An Author",
            artworkUrl: nil,
            durationSeconds: durationSeconds,
            positionSeconds: positionSeconds,
            status: status,
            downloaded: true,
            volumeGain: nil,
            tracks: [
                CarLibraryTrack(id: "one", title: "One", url: "file:///one", durationSeconds: 1_200, bookOffsetSeconds: 0),
                CarLibraryTrack(id: "two", title: "Two", url: "file:///two", durationSeconds: 1_200, bookOffsetSeconds: 1_200),
                CarLibraryTrack(id: "three", title: "Three", url: "file:///three", durationSeconds: 1_200, bookOffsetSeconds: 2_400)
            ],
            chapters: []
        )
    }

    static func main() {
        // A whole-book position resolves to the track holding it, at its own
        // offset — the same split the web player makes.
        let target = book(positionSeconds: 1_500).target(atBookPosition: 1_500)
        precondition(target?.trackIndex == 1, "middle position lands in the second track")
        precondition(target?.positionInTrack == 300, "offset is measured from that track's start")

        let first = book(positionSeconds: 0).target(atBookPosition: 0)
        precondition(first?.trackIndex == 0 && first?.positionInTrack == 0, "the start is the first track")

        let boundary = book(positionSeconds: 1_200).target(atBookPosition: 1_200)
        precondition(
            boundary?.trackIndex == 1 && boundary?.positionInTrack == 0,
            "a position exactly on a boundary belongs to the track that begins there"
        )

        // A position past the last track cannot fall off the end of the queue.
        let past = book(positionSeconds: 9_999).target(atBookPosition: 9_999)
        precondition(past?.trackIndex == 2, "a position past the end stays on the last track")

        var empty = book(positionSeconds: 10)
        empty.tracks = []
        precondition(empty.target(atBookPosition: 10) == nil, "a book with no files has nothing to resume")

        // Resuming, as the car does when a book is tapped.
        precondition(book(positionSeconds: 900).resumePositionSeconds == 900, "an unfinished book resumes where it stopped")
        precondition(
            book(status: "finished", positionSeconds: 3_600).resumePositionSeconds == 0,
            "a finished book starts over rather than resuming past its last word"
        )
        precondition(
            book(positionSeconds: 3_599.5).resumePositionSeconds == 0,
            "a position at the very end starts over even before the server calls it finished"
        )
        precondition(
            book(positionSeconds: -5).resumePositionSeconds == 0,
            "a negative position cannot seek behind the start"
        )
        precondition(
            book(positionSeconds: 1_800, durationSeconds: nil).resumePositionSeconds == 1_800,
            "an unknown duration is not treated as a zero-length book"
        )

        // Percentages drive the progress bar on the car's list rows.
        precondition(book(positionSeconds: 1_800).percentComplete == 0.5, "half a book reads as half")
        precondition(book(positionSeconds: 1_800, durationSeconds: nil).percentComplete == nil, "no duration, no bar")
        precondition(book(positionSeconds: 7_200).percentComplete == 1, "an overshoot cannot exceed a full bar")

        // The scope key has to match the one the web player recovers with, or a
        // drive's checkpoint would be filed under a book the app never asks for.
        let snapshot = CarLibrarySnapshot(
            scopePrefix: "server:user",
            playbackRate: 1.5,
            updatedAt: 0,
            books: [book(positionSeconds: 0)]
        )
        precondition(snapshot.recoveryScopeKey(forBookId: "book") == "server:user:book", "scope key is prefix plus book")
        precondition(snapshot.book(withId: "book") != nil, "books are addressable by id")
        precondition(snapshot.book(withId: "missing") == nil, "an unknown id resolves to nothing")

        var drive = CarPlaybackSession(
            bookId: "book", trackId: "two", positionSeconds: 300,
            bookPositionSeconds: 1_500, durationSeconds: 3_600, updatedAt: 10,
            finished: false, intentionalRegression: false
        )
        precondition(snapshot.resuming(book(positionSeconds: 100), sessions: [drive]).resumePositionSeconds == 1_500,
                     "a cold car launch resumes the previous drive without a WebView")
        var rewind = drive
        rewind.updatedAt = 20
        rewind.bookPositionSeconds = 200
        rewind.intentionalRegression = true
        precondition(snapshot.resuming(book(positionSeconds: 100), sessions: [rewind, drive]).resumePositionSeconds == 200,
                     "the newest drive wins even when it deliberately rewound")
        drive.finished = true
        precondition(snapshot.resuming(book(positionSeconds: 100), sessions: [drive]).resumePositionSeconds == 0,
                     "a drive that finished the book restarts it")
        drive.bookId = "other"
        precondition(snapshot.resuming(book(positionSeconds: 100), sessions: [drive]).resumePositionSeconds == 100,
                     "another book's checkpoint cannot change the resume position")
        var newerSnapshot = snapshot
        newerSnapshot.updatedAt = 30
        precondition(newerSnapshot.resuming(book(positionSeconds: 800), sessions: [rewind]).resumePositionSeconds == 800,
                     "a newer library snapshot supersedes an old drive")

        // Siri must restore the last device session without selecting another
        // account's book or silently restarting a completed audiobook.
        precondition(snapshot.audiobookToResume(sessions: [rewind])?.positionSeconds == 200,
                     "Siri restores a recent deliberate rewind")
        precondition(newerSnapshot.audiobookToResume(sessions: [rewind])?.positionSeconds == 0,
                     "a refreshed shelf position supersedes older device progress")
        precondition(CarLibrarySnapshot.empty.audiobookToResume(sessions: [rewind]) == nil,
                     "signed out snapshots cannot resume")
        var siriShelf = snapshot
        var otherBook = book(positionSeconds: 700)
        otherBook.id = "other"
        siriShelf.books.append(otherBook)
        precondition(siriShelf.audiobookToResume(sessions: []) == nil,
                     "multiple in-progress books require a known last session")
        precondition(siriShelf.audiobookToResume(sessions: [rewind])?.id == "book",
                     "last playback identifies a book on an ambiguous shelf")
        var completed = rewind
        completed.finished = true
        precondition(siriShelf.audiobookToResume(sessions: [completed]) == nil,
                     "finishing the latest book does not start a different one")
        completed.finished = false
        completed.bookPositionSeconds = 3_600
        precondition(siriShelf.audiobookToResume(sessions: [completed]) == nil,
                     "an end-of-book checkpoint cannot silently restart")
        siriShelf.books = [empty]
        precondition(siriShelf.audiobookToResume(sessions: []) == nil,
                     "books without audio cannot resume")

        var shelf = snapshot
        shelf.books = [book(positionSeconds: 100), book(status: "notStarted", positionSeconds: 0),
                       book(status: "finished", positionSeconds: 3_600)]
        let groups = shelf.libraryGroups(maximumItemCount: 2)
        precondition(groups.map { $0.0 } == ["Reading", "Not started"], "the shared budget preserves shelf order")
        precondition(groups.reduce(0) { $0 + $1.1.count } == 2, "all sections share one item limit")
        precondition(shelf.libraryGroups(maximumItemCount: 0).isEmpty, "zero capacity produces no sections")

        // The line under each title on the car screen.
        precondition(
            book(positionSeconds: 900).carSubtitle == "An Author · 45m left",
            "an unfinished book says how much is left"
        )
        precondition(
            book(positionSeconds: 0).carSubtitle == "An Author · 1h",
            "an unopened book says how long it is"
        )
        precondition(
            book(status: "finished", positionSeconds: 3_600).carSubtitle == "An Author · Finished",
            "a finished book says so instead of quoting its whole length again"
        )
        var anonymous = book(positionSeconds: 0)
        anonymous.author = nil
        precondition(anonymous.carSubtitle == "1h", "no author, no separator left dangling")

        // Chapter rows are positions in the book, not durations: "under a
        // minute" is not an answer to "where does this chapter start".
        precondition(carTimestampLabel(seconds: 0) == "0:00", "the first chapter starts at zero")
        precondition(carTimestampLabel(seconds: 42) == "0:42", "seconds are padded")
        precondition(carTimestampLabel(seconds: 342.4) == "5:42", "a fractional second rounds to the nearest")
        precondition(carTimestampLabel(seconds: 3_671) == "1:01:11", "past an hour the hour is shown")
        precondition(carTimestampLabel(seconds: -5) == "0:00", "a negative position cannot read as a clock")

        precondition(carDurationLabel(seconds: 3_600) == "1h", "a round hour drops the minutes")
        precondition(carDurationLabel(seconds: 3_660) == "1h 1m", "hours and minutes read together")
        precondition(carDurationLabel(seconds: 59) == "under a minute", "a sliver is not 0m")

        print("CarLibraryTests passed")
    }
}
