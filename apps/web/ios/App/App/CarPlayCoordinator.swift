import Foundation
import UIKit
import WidgetKit

final class CarPlayCoordinator: AudiobookPlayerMonitor {
    static let shared = CarPlayCoordinator()

    private(set) var isConnected = false

    private(set) var carOwnedBookId: String?

    var onPlaybackChange: (() -> Void)?
    var onPlaybackFailure: ((String) -> Void)?
    var onLibraryChange: (() -> Void)?

    var onWebNotification: ((String, [String: Any]) -> Void)?

    private struct ListedPlayback: Equatable {
        var bookId: String?
        var isPlaying: Bool
    }
    private var listedPlayback: ListedPlayback?

    private let store = CarLibraryStore.shared
    private let engine = AudiobookPlayer.shared
    private var lastSessionWrite = 0.0
    private var deliberateRegression = false
    private var deliberateRegressionSince: Double?
    private var deliberateRegressionGeneration = 0
    private static let sessionWriteIntervalSeconds = 15.0

    private var lastWidgetBook: ResumeWidgetBook?
    private var widgetArtwork: UIImage?
    private var widgetRefreshTime = Date.distantPast

    private init() {
        store.onArtworkChange = { [weak self] in self?.libraryDidChange() }
    }

    func start() {
        engine.monitor = self
        refreshWidget()
    }


    func carSceneDidConnect() {
        isConnected = true
        listedPlayback = nil
    }

    func carSceneDidDisconnect() {
        isConnected = false
        onPlaybackChange = nil
        onPlaybackFailure = nil
        onLibraryChange = nil
        recordSession(force: true)
        notifyWeb("carDisconnected", data: [:])
    }

    // MARK: - Playback

    var snapshot: CarLibrarySnapshot {
        store.snapshot()
    }

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

    @discardableResult
    func play(book: CarLibraryBook, atBookPosition requested: Double?, restorePendingSession: Bool = true) -> Bool {
        let snapshot = store.snapshot()
        let book = restorePendingSession ? snapshot.resuming(book, sessions: store.pendingSessions()) : book
        let position = requested ?? book.resumePositionSeconds
        guard let target = book.target(atBookPosition: position) else { return false }
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

        recordSession(force: true)
        carOwnedBookId = book.id
        let isRegression = requested != nil || book.isFinished
        if !isRegression { clearDeliberateRegression() }

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
        if isRegression { flagDeliberateRegression() }
        notifyWeb("carPlaybackStarted", data: [
            "bookId": book.id,
            "trackId": first.trackId,
            "bookPositionSeconds": first.bookOffsetSeconds + target.positionInTrack
        ])
        return true
    }

    func seek(_ book: CarLibraryBook, toBookPosition position: Double) {
        let status = engine.status
        if status.isLoaded,
           currentBook()?.id == book.id,
           let trackId = status.trackId,
           let track = book.tracks.first(where: { $0.id == trackId }),
           position >= track.bookOffsetSeconds,
           position < track.bookOffsetSeconds + (track.durationSeconds ?? .greatestFiniteMagnitude)
        {
            engine.seek(toPositionSeconds: position - track.bookOffsetSeconds)
            flagDeliberateRegression()
            DispatchQueue.main.async { [weak self] in self?.recordSession(force: true) }
            return
        }
        play(book: book, atBookPosition: position)
    }

    func resume() {
        if engine.isClipPreview {
            DispatchQueue.main.async { [weak self] in _ = self?.resumeAudiobook() }
            return
        }
        engine.play()
    }

    @MainActor
    func resumeAudiobook() -> Bool {
        guard let book = resumeCandidate() else { return false }
        if !engine.isClipPreview, engine.status.isLoaded, currentBook()?.id == book.id {
            engine.play()
            return true
        }
        return play(book: book, atBookPosition: nil, restorePendingSession: false)
    }

    private func resumeCandidate() -> CarLibraryBook? {
        let snapshot = store.snapshot()
        if !engine.isClipPreview, engine.status.isLoaded, var book = currentBook() {
            book.positionSeconds = engine.status.bookPositionSeconds
            if let duration = book.durationSeconds, book.positionSeconds >= duration - 1 { return nil }
            return book
        }
        var sessions: [CarPlaybackSession] = []
        if let checkpoint = engine.loadCheckpoint(),
           checkpoint.scopeKey.hasPrefix(snapshot.scopePrefix + ":"),
           let book = snapshot.book(withId: String(checkpoint.scopeKey.dropFirst(snapshot.scopePrefix.count + 1))) {
            sessions.append(CarPlaybackSession(
                bookId: book.id, trackId: checkpoint.trackId,
                positionSeconds: checkpoint.positionSeconds,
                bookPositionSeconds: checkpoint.bookPositionSeconds,
                durationSeconds: checkpoint.durationSeconds,
                updatedAt: checkpoint.updatedAt, finished: false,
                intentionalRegression: false
            ))
        }
        return snapshot.audiobookToResume(sessions: sessions)
    }

    private var pendingWidgetResume: (scope: String, bookId: String)?

    @MainActor
    func resumeFromWidget(_ url: URL) {
        guard let book = resumeCandidate(),
              ResumeWidgetBook.matches(url, scopeKey: snapshot.recoveryScopeKey(forBookId: book.id)) else {
            refreshWidget()
            return
        }
        pendingWidgetResume = (snapshot.scopePrefix, book.id)
        notifyWeb("widgetResumeRequested", data: [:])
    }

    func takeWidgetResume(scope: String) -> String? {
        defer { pendingWidgetResume = nil }
        guard let pendingWidgetResume, pendingWidgetResume.scope == scope,
              resumeCandidate()?.id == pendingWidgetResume.bookId else { return nil }
        return pendingWidgetResume.bookId
    }

    private func refreshWidget() {
        widgetRefreshTime = Date()
        guard let file = ResumeWidgetBook.file else { return }
        guard let book = resumeCandidate() else {
            if FileManager.default.fileExists(atPath: file.path) {
                do { try FileManager.default.removeItem(at: file) } catch { return }
                WidgetCenter.shared.reloadTimelines(ofKind: ResumeWidgetBook.kind)
            }
            lastWidgetBook = nil
            widgetArtwork = nil
            return
        }
        let image = store.artwork(for: book)
        let display = ResumeWidgetBook(
            identity: ResumeWidgetBook.identity(for: snapshot.recoveryScopeKey(forBookId: book.id)),
            title: book.title, author: book.author,
            remaining: book.durationSeconds.flatMap { $0 > 0 ? carDurationLabel(seconds: $0 - book.positionSeconds) : nil },
            percent: book.percentComplete.map { Int($0 * 100) },
            artwork: image === widgetArtwork ? lastWidgetBook?.artwork : image.jpegData(compressionQuality: 0.85)
        )
        guard display != lastWidgetBook else { return }
        do {
            try JSONEncoder().encode(display).write(to: file, options: .atomic)
            lastWidgetBook = display
            widgetArtwork = image
            WidgetCenter.shared.reloadTimelines(ofKind: ResumeWidgetBook.kind)
        } catch { }
    }

    func libraryDidChange() {
        refreshWidget()
        onLibraryChange?()
    }

    func clearLibrary() {
        carOwnedBookId = nil
        pendingWidgetResume = nil
        store.clear()
        refreshWidget()
        engine.stop(releaseSession: true)
        notifyWeb("carPlaybackEnded", data: [:])
        onLibraryChange?()
        redrawCarLists()
    }

    func stopPlayback(forBookId bookId: String) {
        guard carOwnedBookId == bookId else { return }
        engine.stopOnMainThread(releaseSession: true)
        recordSession(force: true)
        carOwnedBookId = nil
        notifyWeb("carPlaybackEnded", data: ["bookId": bookId])
        redrawCarLists()
    }

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

    func webLayerDidTakeOver() {
        guard carOwnedBookId != nil else { return }
        recordSession(force: true)
        carOwnedBookId = nil
    }

    func pendingSessions() -> [CarPlaybackSession] {
        store.pendingSessions()
    }

    func acknowledgeSessions(_ acknowledged: [String: Double]) {
        let acknowledgedJumpBookId: String?
        if let bookId = carOwnedBookId,
           let since = deliberateRegressionSince,
           let savedAt = acknowledged[bookId],
           savedAt >= since
        {
            acknowledgedJumpBookId = bookId
        } else {
            acknowledgedJumpBookId = nil
        }
        store.acknowledgeSessions(acknowledged, clearRegressionForBookId: acknowledgedJumpBookId)
        if acknowledgedJumpBookId != nil {
            clearDeliberateRegression()
        }
    }

    private func flagDeliberateRegression() {
        deliberateRegression = true
        deliberateRegressionSince = nil
        deliberateRegressionGeneration += 1
        let generation = deliberateRegressionGeneration
        DispatchQueue.main.async { [weak self] in
            guard let self, generation == self.deliberateRegressionGeneration else { return }
            self.deliberateRegressionSince = Date().timeIntervalSince1970 * 1000
        }
    }

    private func clearDeliberateRegression() {
        deliberateRegression = false
        deliberateRegressionSince = nil
        deliberateRegressionGeneration += 1
    }

    private func recordSession(force: Bool, finished: Bool = false) {
        guard !engine.isClipPreview else { return }
        guard let bookId = carOwnedBookId else { return }
        let now = Date().timeIntervalSince1970 * 1000
        if !force && now - lastSessionWrite < Self.sessionWriteIntervalSeconds * 1000 { return }
        let snapshot = store.snapshot()
        let scopeKey = snapshot.recoveryScopeKey(forBookId: bookId)
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
            intentionalRegression: deliberateRegression,
            baseUpdatedAt: snapshot.book(withId: bookId)?.serverRevision
        ))
    }

    private func redrawCarLists() {
        listedPlayback = nil
        onPlaybackChange?()
    }

    private func notifyWeb(_ event: String, data: [String: Any]) {
        onWebNotification?(event, data)
    }

    // MARK: - AudiobookPlayerMonitor

    func audiobookPlayer(_ player: AudiobookPlayer, didPersist checkpoint: NativeAudioCheckpoint) {
        recordSession(force: false)
        if Date().timeIntervalSince(widgetRefreshTime) >= 300 { refreshWidget() }
    }

    func audiobookPlayerDidChangePlaybackState(_ player: AudiobookPlayer) {
        recordSession(force: true)
        refreshWidget()
        guard let onPlaybackChange else { return }
        let playback = ListedPlayback(bookId: currentBook()?.id, isPlaying: engine.status.isPlaying)
        guard playback != listedPlayback else { return }
        listedPlayback = playback
        onPlaybackChange()
    }

    func audiobookPlayerDidFinishPlayback(_ player: AudiobookPlayer) {
        recordSession(force: true, finished: true)
        let finishedBookId = carOwnedBookId
        carOwnedBookId = nil
        redrawCarLists()
        if let finishedBookId {
            notifyWeb("carPlaybackEnded", data: ["bookId": finishedBookId])
        }
    }

    func audiobookPlayer(_ player: AudiobookPlayer, didFail message: String) {
        recordSession(force: true)
        onPlaybackFailure?(message)
    }

    func audiobookPlayerDidSeekDeliberately(_ player: AudiobookPlayer) {
        flagDeliberateRegression()
        recordSession(force: true)
    }
}
