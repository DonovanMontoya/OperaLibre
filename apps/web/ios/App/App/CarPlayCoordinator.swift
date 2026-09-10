import Foundation

/// Bookkeeping shared by the CarPlay scene, the audio engine and the web layer.
///
/// The car and the phone drive one `AudiobookPlayer`, so something has to say
/// which of them started what is playing. That matters in both directions: the
/// web player must not tear down a book the driver just started, and the app
/// must be able to save the progress made in the car through its usual
/// server-side defenses rather than letting a second writer near it.
final class CarPlayCoordinator: AudiobookPlayerMonitor {
    static let shared = CarPlayCoordinator()

    /// The car screen is attached. Kept separate from `carOwnedBookId`: a
    /// connected car that is showing a book the phone started is normal.
    private(set) var isConnected = false

    /// The book the car itself started, if any. While this is set the web layer
    /// leaves the engine alone.
    private(set) var carOwnedBookId: String?

    /// Set by the CarPlay scene so the car screen can redraw when playback
    /// changes underneath it — including while the phone app is backgrounded,
    /// where the web layer's own event stream is deliberately silent.
    var onPlaybackChange: (() -> Void)?
    var onPlaybackFailure: ((String) -> Void)?
    /// The web layer pushed a new snapshot: the car's lists are out of date.
    var onLibraryChange: (() -> Void)?

    /// Set by the Capacitor plugin while a WebView exists, so the app can learn
    /// what happened in the car as soon as JS runs again.
    var onWebNotification: ((String, [String: Any]) -> Void)?

    private let store = CarLibraryStore.shared
    private let engine = AudiobookPlayer.shared
    private var lastSessionWrite = 0.0
    /// Whether the position this car session is about to save got there by a
    /// jump rather than by playing forward.
    private var deliberateRegression = false
    /// A car session's position is written on a timer of its own rather than on
    /// every checkpoint: the engine checkpoints every two seconds, and the
    /// handoff record does not need that resolution.
    private static let sessionWriteIntervalSeconds = 15.0

    private init() {}

    func start() {
        engine.monitor = self
    }

    // MARK: - Scene lifecycle

    func carSceneDidConnect() {
        isConnected = true
        notifyWeb("carConnected", data: [:])
    }

    func carSceneDidDisconnect() {
        isConnected = false
        onPlaybackChange = nil
        onPlaybackFailure = nil
        onLibraryChange = nil
        // Unplugging is the last chance to record where the drive ended.
        recordSession(force: true)
        notifyWeb("carDisconnected", data: [:])
    }

    // MARK: - Playback

    var snapshot: CarLibrarySnapshot {
        store.snapshot()
    }

    /// The book the engine is playing, resolved through the snapshot, whichever
    /// side started it.
    func currentBook() -> CarLibraryBook? {
        let snapshot = store.snapshot()
        guard
            let scopeKey = engine.status.scopeKey,
            !snapshot.scopePrefix.isEmpty,
            scopeKey.hasPrefix("\(snapshot.scopePrefix):")
        else { return nil }
        let bookId = String(scopeKey.dropFirst(snapshot.scopePrefix.count + 1))
        return snapshot.book(withId: bookId)
    }

    /// Starts a book from the car, at a whole-book position.
    ///
    /// Like the web player, the queue holds the rest of the book from the track
    /// the position falls in, so the engine rolls from one track to the next
    /// without the app being awake to feed it.
    @discardableResult
    func play(book: CarLibraryBook, atBookPosition requested: Double?, restorePendingSession: Bool = true) -> Bool {
        let snapshot = store.snapshot()
        let book = restorePendingSession ? snapshot.resuming(book, sessions: store.pendingSessions()) : book
        let position = requested ?? book.resumePositionSeconds
        guard let target = book.target(atBookPosition: position) else { return false }
        // A track whose URL will not resolve is dropped rather than queued: the
        // engine would fail the item and stop the drive on it.
        let queue = book.tracks[target.trackIndex...].compactMap { track -> NativeAudioQueuedTrack? in
            guard let url = resolveNativeAudioSourceURL(track.url) else { return nil }
            return NativeAudioQueuedTrack(
                url: url,
                trackId: track.id,
                bookOffsetSeconds: track.bookOffsetSeconds,
                title: track.title,
                artist: book.author ?? "Audiobook",
                album: book.title,
                chapters: chapters(of: book, inTrack: track)
            )
        }
        guard let first = queue.first, first.trackId == book.tracks[target.trackIndex].id else {
            return false
        }

        // The previous book's position is recorded before the engine is handed
        // a new one: a load() tears the old player down, and with it the only
        // copy of where the listener stopped.
        recordSession(force: true)
        carOwnedBookId = book.id
        // Resuming is never a regression; a chapter jump and a restart both are.
        deliberateRegression = requested != nil || book.isFinished

        engine.load(AudiobookLoadRequest(
            url: first.url,
            positionSeconds: target.positionInTrack,
            rate: snapshot.playbackRate,
            volume: 1,
            gain: book.volumeGain ?? 1,
            autoplay: true,
            recoveryScopeKey: snapshot.recoveryScopeKey(forBookId: book.id),
            recoveryTrackId: first.trackId,
            recoveryBookOffsetSeconds: first.bookOffsetSeconds,
            queue: queue
        ))
        engine.setNowPlaying(AudiobookNowPlayingRequest(
            title: first.title,
            artist: book.author ?? "Audiobook",
            album: book.title,
            artworkSource: book.artworkUrl,
            chapterStartSeconds: nil,
            chapterDurationSeconds: nil,
            chapters: first.chapters
        ))
        notifyWeb("carPlaybackStarted", data: [
            "bookId": book.id,
            "trackId": first.trackId,
            "bookPositionSeconds": first.bookOffsetSeconds + target.positionInTrack
        ])
        return true
    }

    /// Moves within a book already playing rather than reloading it, so a
    /// chapter jump inside the current file does not restart the queue.
    func seek(_ book: CarLibraryBook, toBookPosition position: Double) {
        let status = engine.status
        if status.isLoaded,
           currentBook()?.id == book.id,
           let trackId = status.trackId,
           let track = book.tracks.first(where: { $0.id == trackId }),
           position >= track.bookOffsetSeconds,
           position < track.bookOffsetSeconds + (track.durationSeconds ?? .greatestFiniteMagnitude)
        {
            deliberateRegression = true
            engine.seek(toPositionSeconds: position - track.bookOffsetSeconds)
            recordSession(force: true)
            return
        }
        play(book: book, atBookPosition: position)
    }

    /// Starts the book already loaded, whichever side loaded it. Resuming
    /// does not claim the session: a book the phone is playing stays the
    /// phone's, and its progress keeps being saved the way it always was.
    func resume() {
        engine.play()
    }

    /// Siri shares the car's native ownership and progress handoff, even when
    /// no car or WebView is connected. All access runs on the main actor.
    @MainActor
    func resumeAudiobook() -> Bool {
        let snapshot = store.snapshot()
        if engine.status.isLoaded, let book = currentBook() {
            if let duration = book.durationSeconds, engine.status.bookPositionSeconds >= duration - 1 {
                return false
            }
            engine.play()
            return true
        }
        // The engine checkpoint is account/server scoped. Pending car records
        // contain only book IDs, so they cannot identify Siri's last session.
        var sessions: [CarPlaybackSession] = []
        for book in snapshot.books {
            guard let checkpoint = engine.recoveryState(forScope: snapshot.recoveryScopeKey(forBookId: book.id)) else { continue }
            sessions.append(CarPlaybackSession(
                bookId: book.id, trackId: checkpoint.trackId,
                positionSeconds: checkpoint.positionSeconds,
                bookPositionSeconds: checkpoint.bookPositionSeconds,
                durationSeconds: checkpoint.durationSeconds,
                updatedAt: checkpoint.updatedAt, finished: false,
                intentionalRegression: false
            ))
        }
        guard let book = snapshot.audiobookToResume(sessions: sessions) else { return false }
        // This book already includes the freshest checkpoint. Passing nil keeps
        // the handoff classified as a resume, rather than a deliberate rewind.
        return play(book: book, atBookPosition: nil, restorePendingSession: false)
    }

    func libraryDidChange() {
        onLibraryChange?()
    }

    func clearLibrary() {
        // Drop ownership before stopping, so the stop checkpoint cannot create
        // a new pending session belonging to the account we just left.
        carOwnedBookId = nil
        store.clear()
        engine.stop(releaseSession: true)
        notifyWeb("carPlaybackEnded", data: [:])
        onLibraryChange?()
        onPlaybackChange?()
    }

    func togglePlayPause() {
        if engine.status.isPlaying {
            engine.pause()
        } else {
            engine.play()
        }
    }

    /// Cycles the speeds the app's own player offers, so the car and the phone
    /// agree on what the button does.
    static let playbackRates: [Double] = [1, 1.25, 1.5, 1.75, 2, 0.75]

    var playbackRate: Double {
        engine.playbackRate
    }

    @discardableResult
    func advancePlaybackRate() -> Double {
        let current = engine.playbackRate
        let index = Self.playbackRates.firstIndex { abs($0 - current) < 0.01 } ?? 0
        let next = Self.playbackRates[(index + 1) % Self.playbackRates.count]
        engine.setRate(next)
        return next
    }

    private func chapters(of book: CarLibraryBook, inTrack track: CarLibraryTrack) -> [NativeNowPlayingChapter] {
        book.chapters
            .filter { $0.trackId == nil || $0.trackId == track.id }
            .map {
                NativeNowPlayingChapter(
                    title: $0.title,
                    startSeconds: $0.startSeconds - track.bookOffsetSeconds,
                    durationSeconds: $0.durationSeconds
                )
            }
    }

    // MARK: - Handing back to the app

    /// The web layer loaded something itself, so the car session is over. Its
    /// last position is banked first — the app is about to replace the player
    /// the position lives in.
    func webLayerDidTakeOver() {
        guard carOwnedBookId != nil else { return }
        recordSession(force: true)
        carOwnedBookId = nil
    }

    func pendingSessions() -> [CarPlaybackSession] {
        store.pendingSessions()
    }

    func acknowledgeSessions(_ acknowledged: [String: Double]) {
        store.acknowledgeSessions(acknowledged)
    }

    /// Banks where the car session has got to.
    ///
    /// The position comes from the engine's own checkpoint rather than from the
    /// live player, and only when that checkpoint still belongs to the book the
    /// car claimed. Starting a second book claims it before the engine has torn
    /// the first one down, and the teardown's last checkpoint would otherwise be
    /// filed under the new book — moving it to a position from another book
    /// entirely. Matching on the scope key makes that impossible.
    private func recordSession(force: Bool, finished: Bool = false) {
        guard let bookId = carOwnedBookId else { return }
        let now = Date().timeIntervalSince1970 * 1000
        if !force && now - lastSessionWrite < Self.sessionWriteIntervalSeconds * 1000 { return }
        let scopeKey = store.snapshot().recoveryScopeKey(forBookId: bookId)
        guard let checkpoint = engine.recoveryState(forScope: scopeKey) else { return }
        lastSessionWrite = now
        store.recordSession(CarPlaybackSession(
            bookId: bookId,
            trackId: checkpoint.trackId,
            positionSeconds: checkpoint.positionSeconds,
            bookPositionSeconds: checkpoint.bookPositionSeconds,
            durationSeconds: checkpoint.durationSeconds,
            updatedAt: checkpoint.updatedAt,
            finished: finished,
            intentionalRegression: deliberateRegression
        ))
    }

    private func notifyWeb(_ event: String, data: [String: Any]) {
        onWebNotification?(event, data)
    }

    // MARK: - AudiobookPlayerMonitor

    func audiobookPlayer(_ player: AudiobookPlayer, didPersist checkpoint: NativeAudioCheckpoint) {
        recordSession(force: false)
    }

    func audiobookPlayerDidChangePlaybackState(_ player: AudiobookPlayer) {
        // A transport change is where a session is most worth banking: it is
        // the moment a listener stops, and the point they will resume from.
        recordSession(force: true)
        onPlaybackChange?()
    }

    func audiobookPlayerDidFinishPlayback(_ player: AudiobookPlayer) {
        recordSession(force: true, finished: true)
        let finishedBookId = carOwnedBookId
        carOwnedBookId = nil
        onPlaybackChange?()
        if let finishedBookId {
            notifyWeb("carPlaybackEnded", data: ["bookId": finishedBookId])
        }
    }

    func audiobookPlayer(_ player: AudiobookPlayer, didFail message: String) {
        recordSession(force: true)
        onPlaybackFailure?(message)
    }

    func audiobookPlayerDidSeekDeliberately(_ player: AudiobookPlayer) {
        deliberateRegression = true
        recordSession(force: true)
    }
}
