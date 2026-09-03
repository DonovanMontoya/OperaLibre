import AVFoundation
import Capacitor
import Foundation
import MediaPlayer
import UIKit

private struct NativeAudioCheckpoint: Codable {
    let scopeKey: String
    let trackId: String
    let positionSeconds: Double
    let bookPositionSeconds: Double
    let durationSeconds: Double?
    let updatedAt: Double
}

private struct NativeNowPlayingChapter {
    let title: String
    let startSeconds: Double
    let durationSeconds: Double
}

private struct NativeAudioQueuedTrack {
    var url: URL
    let trackId: String
    let bookOffsetSeconds: Double
    var title: String
    var artist: String
    var album: String
    var chapters: [NativeNowPlayingChapter]
}

@objc(NativeAudioPlugin)
public final class NativeAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeAudioPlugin"
    public let jsName = "NativeAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setGain", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSleepTimer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSleepTimer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setNowPlaying", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getRecoveryState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private var player: AVPlayer?
    private var statusObservation: NSKeyValueObservation?
    private var failureObservations: [NSKeyValueObservation] = []
    private var currentItemObservation: NSKeyValueObservation?
    private var timeControlStatusObservation: NSKeyValueObservation?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var stalledObserver: NSObjectProtocol?
    private var rateChangeObserver: NSObjectProtocol?
    private var interruptionObserver: NSObjectProtocol?
    private var routeChangeObserver: NSObjectProtocol?
    private var becameActiveObserver: NSObjectProtocol?
    private var enteredBackgroundObserver: NSObjectProtocol?
    private var desiredRate: Float = 1
    /// The listener's per-book boost, separate from `player.volume` because
    /// that one cannot exceed unity and this one has to.
    private var boostGain: Float = 1
    private var pendingPosition: Double = 0
    // AVPlayer can briefly report an invalid or reset clock while iOS swaps
    // audio routes. Keep the last clock delivered by its periodic observer so
    // an AirPods transition cannot replace a live checkpoint with 0:00.
    private var lastKnownPosition: Double = 0
    private var shouldAutoplay = false
    private var wasPlayingBeforeInterruption = false
    private var interruptionIsActive = false
    private var pendingRemoteIntentionalSeek = false
    private var generation = 0
    private var remoteCommandTargets: [Any] = []
    private var nowPlayingTitle = "OperaLibre"
    private var nowPlayingArtist = "Audiobook"
    private var nowPlayingAlbum = ""
    private var nowPlayingChapters: [NativeNowPlayingChapter] = []
    private var suppliedNowPlayingChapter: NativeNowPlayingChapter?
    private var activeNowPlayingChapterIndex: Int?
    private var nowPlayingArtwork: MPMediaItemArtwork?
    private var artworkGeneration = 0
    private let checkpointKey = "operalibre.native-audio-checkpoint.v1"
    private var recoveryScopeKey: String?
    private var recoveryTrackId: String?
    private var recoveryBookOffset: Double = 0
    private var lastCheckpointWrite = 0.0
    /// How long a play() that arrived before its track was loaded stays
    /// eligible to start that track. Long enough for a React track swap,
    /// short enough that it cannot outlive the tap that caused it.
    private static let playIntentGraceSeconds = 5.0
    private var playIntentAt = 0.0
    private var queuedTracks: [NativeAudioQueuedTrack] = []
    private var queuedItems: [AVPlayerItem] = []
    private var activeQueueIndex = 0
    private var finishedWhileInactive = false
    private var finishedPositionSeconds: Double?
    private var finishedDurationSeconds: Double?
    private var sleepTimerRemaining: TimeInterval = 0
    private var sleepTimerLastTick: TimeInterval?
    private var sleepTimerFinishedWhileInactive = false
    private var pendingErrorWhileInactive: String?
    /// Set when an interruption ended without `.shouldResume` while the app
    /// was not active. The retained play intent may only auto-resume within a
    /// short window after this; an old timestamp means iOS meant the missing
    /// hint — another app owns the audio session now.
    private static let interruptionResumeGraceSeconds = 30.0
    private var interruptionEndedWhileInactiveAt: TimeInterval?

    deinit {
        tearDownPlayer()
        for observer in [
            interruptionObserver,
            routeChangeObserver,
            becameActiveObserver,
            enteredBackgroundObserver
        ] {
            if let observer { NotificationCenter.default.removeObserver(observer) }
        }
        let commandCenter = MPRemoteCommandCenter.shared()
        for target in remoteCommandTargets {
            commandCenter.playCommand.removeTarget(target)
            commandCenter.pauseCommand.removeTarget(target)
            commandCenter.togglePlayPauseCommand.removeTarget(target)
            commandCenter.skipBackwardCommand.removeTarget(target)
            commandCenter.skipForwardCommand.removeTarget(target)
            commandCenter.changePlaybackPositionCommand.removeTarget(target)
        }
    }

    @objc public func load(_ call: CAPPluginCall) {
        guard let source = call.getString("url"), let url = resolveSourceURL(source) else {
            call.reject("The audio URL is invalid.")
            return
        }

        let position = max(0, call.getDouble("positionSeconds") ?? 0)
        let rate = clampedRate(call.getDouble("rate") ?? 1)
        let volume = clampedVolume(call.getDouble("volume") ?? 1)
        let gain = clampedGain(call.getDouble("gain") ?? 1)
        let autoplay = call.getBool("autoplay") ?? false
        let scopeKey = call.getString("recoveryScopeKey")
        let trackId = call.getString("recoveryTrackId")
        let bookOffset = max(0, call.getDouble("recoveryBookOffsetSeconds") ?? 0)
        var requestedQueue: [NativeAudioQueuedTrack] =
            (call.getArray("queue", JSObject.self) ?? []).compactMap { entry -> NativeAudioQueuedTrack? in
                guard
                    let source = entry["url"] as? String,
                    let queueURL = resolveNativeAudioSourceURL(source),
                    let queueTrackId = entry["trackId"] as? String,
                    !queueTrackId.isEmpty
                else { return nil }
                let chapters = ((entry["chapters"] as? [JSObject]) ?? []).compactMap { chapter -> NativeNowPlayingChapter? in
                    guard
                        let title = chapter["title"] as? String,
                        let start = jsDouble(chapter["startSeconds"]),
                        let duration = jsDouble(chapter["durationSeconds"]),
                        start.isFinite,
                        duration.isFinite,
                        duration > 0
                    else { return nil }
                    return NativeNowPlayingChapter(
                        title: title,
                        startSeconds: start,
                        durationSeconds: duration
                    )
                }
                return NativeAudioQueuedTrack(
                    url: queueURL,
                    trackId: queueTrackId,
                    bookOffsetSeconds: max(0, jsDouble(entry["bookOffsetSeconds"]) ?? 0),
                    title: entry["title"] as? String ?? "OperaLibre",
                    artist: entry["artist"] as? String ?? "Audiobook",
                    album: entry["album"] as? String ?? "",
                    chapters: chapters.sorted { $0.startSeconds < $1.startSeconds }
                )
            }
        let currentTrackId = trackId ?? requestedQueue.first?.trackId ?? "current-track"
        if requestedQueue.first?.trackId == currentTrackId {
            requestedQueue[0].url = url
        } else {
            requestedQueue.insert(
                NativeAudioQueuedTrack(
                    url: url,
                    trackId: currentTrackId,
                    bookOffsetSeconds: bookOffset,
                    title: "OperaLibre",
                    artist: "Audiobook",
                    album: "",
                    chapters: []
                ),
                at: 0
            )
        }

        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("The native audio player is unavailable.")
                return
            }

            // A shelf Resume tap can reach play() while React is still
            // replacing the previous track. Preserve that queued intent
            // across teardown so the newly loaded item actually starts —
            // but only briefly, so an intent left over from playback that
            // stopped long ago cannot silently start an unrelated book.
            let playIntentAge = Date.timeIntervalSinceReferenceDate - self.playIntentAt
            let retainedPlayIntent =
                self.shouldAutoplay && playIntentAge <= Self.playIntentGraceSeconds
            self.tearDownPlayer()
            self.generation += 1
            let loadGeneration = self.generation
            self.desiredRate = rate
            self.boostGain = gain
            self.pendingPosition = position
            self.lastKnownPosition = position
            self.shouldAutoplay = autoplay || retainedPlayIntent
            self.recoveryScopeKey = scopeKey
            self.recoveryTrackId = trackId
            self.recoveryBookOffset = bookOffset
            self.lastCheckpointWrite = 0
            self.queuedTracks = requestedQueue
            self.activeQueueIndex = 0
            self.finishedWhileInactive = false
            self.finishedPositionSeconds = nil
            self.finishedDurationSeconds = nil
            self.installSessionObserversIfNeeded()

            let items = requestedQueue.map { track in
                let item = AVPlayerItem(url: track.url)
                // Apple's time-domain algorithm is designed for spoken audio and
                // preserves pitch throughout OperaLibre's 0.75–2x range.
                item.audioTimePitchAlgorithm = .timeDomain
                return item
            }
            self.queuedItems = items
            for item in items {
                self.applyBoost(to: item, gain: gain)
            }
            let player = AVQueuePlayer(items: items)
            player.actionAtItemEnd = .advance
            player.automaticallyWaitsToMinimizeStalling = true
            player.preventsDisplaySleepDuringVideoPlayback = false
            player.volume = volume
            self.player = player
            self.activateQueuedTrack(at: 0)
            // Queue activation resets later tracks to their natural beginning,
            // but the first track must honor the restored resume position.
            self.pendingPosition = position
            self.lastKnownPosition = position
            self.configureRemoteCommandsIfNeeded()
            self.installObservers(player: player, item: items[0], generation: loadGeneration)
            call.resolve()
        }
    }

    @objc public func play(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.resolve()
                return
            }
            guard let player = self.player else {
                self.shouldAutoplay = true
                self.playIntentAt = Date.timeIntervalSinceReferenceDate
                call.resolve()
                return
            }
            self.shouldAutoplay = true
            self.playIntentAt = Date.timeIntervalSinceReferenceDate
            if player.currentItem?.status == .readyToPlay {
                self.activateAudioSession()
                player.playImmediately(atRate: self.desiredRate)
                self.persistCheckpoint(force: true)
                self.updateNowPlayingInfo()
            }
            call.resolve()
        }
    }

    @objc public func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.shouldAutoplay = false
            self?.player?.pause()
            self?.persistCheckpoint(force: true)
            self?.updateNowPlayingInfo()
            call.resolve()
        }
    }

    @objc public func setSleepTimer(_ call: CAPPluginCall) {
        let seconds = max(0, call.getDouble("seconds") ?? 0)
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("The native audio player is unavailable.")
                return
            }
            self.sleepTimerRemaining = seconds
            self.syncSleepTimerWithPlaybackState(self.player?.timeControlStatus ?? .paused)
            self.sleepTimerFinishedWhileInactive = false
            call.resolve()
        }
    }

    @objc public func getSleepTimer(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            call.resolve(["remainingSeconds": self?.sleepTimerRemaining ?? 0])
        }
    }

    @objc public func seek(_ call: CAPPluginCall) {
        let position = max(0, call.getDouble("positionSeconds") ?? 0)
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.resolve()
                return
            }
            self.pendingPosition = position
            guard let player = self.player else {
                call.resolve()
                return
            }
            let time = CMTime(seconds: position, preferredTimescale: 600)
            player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
                guard let self else { return }
                self.persistCheckpoint(force: true)
                if self.shouldAutoplay, player.timeControlStatus != .playing {
                    player.playImmediately(atRate: self.desiredRate)
                }
            }
            call.resolve()
        }
    }

    @objc public func setRate(_ call: CAPPluginCall) {
        let rate = clampedRate(call.getDouble("rate") ?? 1)
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("The native audio player is unavailable.")
                return
            }
            self.desiredRate = rate
            if let player = self.player, player.timeControlStatus == .playing {
                player.rate = rate
            }
            self.updateNowPlayingInfo()
            call.resolve()
        }
    }

    @objc public func setNowPlaying(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? "OperaLibre"
        let artist = call.getString("artist") ?? "Audiobook"
        let album = call.getString("album") ?? ""
        let artworkURL = call.getString("artworkUrl")
        let suppliedChapterStart = call.getDouble("chapterStartSeconds")
        let suppliedChapterDuration = call.getDouble("chapterDurationSeconds")
        let suppliedChapter: NativeNowPlayingChapter? =
            if let suppliedChapterStart,
               let suppliedChapterDuration,
               suppliedChapterStart.isFinite,
               suppliedChapterDuration.isFinite,
               suppliedChapterDuration > 0
            {
                NativeNowPlayingChapter(
                    title: title,
                    startSeconds: suppliedChapterStart,
                    durationSeconds: suppliedChapterDuration
                )
            } else {
                nil
            }
        let chapters: [NativeNowPlayingChapter] =
            (call.getArray("chapters", JSObject.self) ?? []).compactMap { chapter -> NativeNowPlayingChapter? in
                guard
                    let title = chapter["title"] as? String,
                    let start = jsDouble(chapter["startSeconds"]),
                    let duration = jsDouble(chapter["durationSeconds"]),
                    start.isFinite,
                    duration.isFinite,
                    duration > 0
                else { return nil }
                return NativeNowPlayingChapter(
                    title: title,
                    startSeconds: start,
                    durationSeconds: duration
                )
            }

        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.resolve()
                return
            }
            self.nowPlayingTitle = title
            self.nowPlayingArtist = artist
            self.nowPlayingAlbum = album
            self.nowPlayingChapters = chapters.sorted { $0.startSeconds < $1.startSeconds }
            self.suppliedNowPlayingChapter = suppliedChapter
            self.activeNowPlayingChapterIndex = nil
            self.loadArtwork(from: artworkURL)
            self.updateNowPlayingInfo()
            call.resolve()
        }
    }

    @objc public func setVolume(_ call: CAPPluginCall) {
        let volume = clampedVolume(call.getDouble("volume") ?? 1)
        DispatchQueue.main.async { [weak self] in
            self?.player?.volume = volume
            call.resolve()
        }
    }

    @objc public func setGain(_ call: CAPPluginCall) {
        let gain = clampedGain(call.getDouble("gain") ?? 1)
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.resolve()
                return
            }
            self.boostGain = gain
            for item in self.queuedItems {
                self.applyBoost(to: item, gain: gain)
            }
            call.resolve()
        }
    }

    /// `AVPlayer.volume` is capped at unity, so a book mastered quiet is lifted
    /// by the mixer instead: audio mix input parameters take a linear gain that
    /// may run above 1. The asset's tracks are needed to address that gain, and
    /// for a streamed item they are not loaded yet, so the mix is attached once
    /// they arrive — playback that has already started picks it up in place.
    private func applyBoost(to item: AVPlayerItem, gain: Float) {
        guard gain != 1 else {
            item.audioMix = nil
            return
        }
        let asset = item.asset
        let loadGeneration = generation
        asset.loadValuesAsynchronously(forKeys: ["tracks"]) { [weak self, weak item] in
            var trackError: NSError?
            guard asset.statusOfValue(forKey: "tracks", error: &trackError) == .loaded else { return }
            let audioTracks = asset.tracks(withMediaType: .audio)
            guard !audioTracks.isEmpty else { return }
            let mix = AVMutableAudioMix()
            mix.inputParameters = audioTracks.map { track in
                let parameters = AVMutableAudioMixInputParameters(track: track)
                parameters.setVolume(gain, at: .zero)
                return parameters
            }
            DispatchQueue.main.async {
                // The book may have been swapped, or the gain changed again,
                // while the tracks were loading.
                guard
                    let self,
                    let item,
                    self.generation == loadGeneration,
                    self.boostGain == gain
                else { return }
                item.audioMix = mix
            }
        }
    }

    @objc public func getRecoveryState(_ call: CAPPluginCall) {
        guard
            let requestedScope = call.getString("scopeKey"),
            let checkpoint = loadCheckpoint(),
            checkpoint.scopeKey == requestedScope
        else {
            call.resolve([:])
            return
        }
        var result = JSObject()
        result["trackId"] = checkpoint.trackId
        result["positionSeconds"] = checkpoint.positionSeconds
        result["bookPositionSeconds"] = checkpoint.bookPositionSeconds
        result["updatedAt"] = checkpoint.updatedAt
        if let duration = checkpoint.durationSeconds { result["durationSeconds"] = duration }
        call.resolve(result)
    }

    @objc public func stop(_ call: CAPPluginCall) {
        // The attach cleanup passes false: it runs on every track change and
        // the next load() follows at once, so releasing the session there
        // would hand audio back to other apps between every two chapters.
        let releaseSession = call.getBool("releaseSession") ?? true
        DispatchQueue.main.async { [weak self] in
            self?.generation += 1
            // stop() must disarm the sleep timer so it cannot keep counting
            // into a session that did not arm it (logout, failover, reload).
            // stop() also runs between track reattachments, so the JS attach
            // path re-arms the timer with the seconds React still holds;
            // load() leaves the timer alone for the same reason.
            self?.sleepTimerRemaining = 0
            self?.sleepTimerLastTick = nil
            self?.sleepTimerFinishedWhileInactive = false
            self?.tearDownPlayer()
            if releaseSession {
                self?.deactivateAudioSession()
            }
            call.resolve()
        }
    }

    private func installObservers(player: AVPlayer, item: AVPlayerItem, generation: Int) {
        timeControlStatusObservation = player.observe(
            \.timeControlStatus,
            options: [.initial, .new]
        ) { [weak self, weak player] _, _ in
            DispatchQueue.main.async {
                guard
                    let self,
                    let player,
                    player === self.player,
                    generation == self.generation
                else { return }
                self.syncSleepTimerWithPlaybackState(player.timeControlStatus)
                self.updateNowPlayingInfo()
            }
        }

        rateChangeObserver = NotificationCenter.default.addObserver(
            forName: AVPlayer.rateDidChangeNotification,
            object: player,
            queue: .main
        ) { [weak self, weak player] _ in
            guard
                let self,
                let player,
                player === self.player,
                generation == self.generation
            else { return }
            self.updateNowPlayingInfo()
        }

        statusObservation = item.observe(\.status, options: [.initial, .new]) { [weak self, weak item] _, _ in
            DispatchQueue.main.async {
                guard let self, let item, generation == self.generation else { return }
                switch item.status {
                case .readyToPlay:
                    let target = CMTime(seconds: self.pendingPosition, preferredTimescale: 600)
                    player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
                        guard let self, generation == self.generation else { return }
                        self.emitState()
                        if self.shouldAutoplay {
                            self.activateAudioSession()
                            player.playImmediately(atRate: self.desiredRate)
                        }
                        self.persistCheckpoint(force: true)
                        self.updateNowPlayingInfo()
                    }
                case .failed:
                    self.emitError(item.error?.localizedDescription ?? "The audio track could not be loaded.")
                default:
                    break
                }
            }
        }

        // The observation above owns the resume seek and so only covers the
        // item playback starts on. Later queue entries still have to report a
        // load failure, otherwise AVQueuePlayer skips a missing track in
        // silence and the web layer never fails over.
        failureObservations = queuedItems.dropFirst().map { queuedItem in
            queuedItem.observe(\.status, options: [.new]) { [weak self] observedItem, _ in
                DispatchQueue.main.async {
                    guard
                        let self,
                        generation == self.generation,
                        observedItem.status == .failed
                    else { return }
                    self.emitError(
                        observedItem.error?.localizedDescription
                            ?? "The audio track could not be loaded."
                    )
                }
            }
        }

        currentItemObservation = player.observe(
            \.currentItem,
            options: [.new]
        ) { [weak self, weak player] _, _ in
            DispatchQueue.main.async {
                guard
                    let self,
                    let player,
                    generation == self.generation,
                    let currentItem = player.currentItem,
                    let index = self.queuedItems.firstIndex(where: { $0 === currentItem }),
                    index != self.activeQueueIndex
                else { return }
                self.activateQueuedTrack(at: index)
                self.persistCheckpoint(force: true)
                self.updateNowPlayingInfo()
                if self.shouldAutoplay && player.timeControlStatus != .playing {
                    self.activateAudioSession()
                    player.playImmediately(atRate: self.desiredRate)
                }
                if UIApplication.shared.applicationState == .active {
                    self.emitTrackChanged()
                    self.emitState()
                }
            }
        }

        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.25, preferredTimescale: 600),
            queue: .main
        ) { [weak self] time in
            guard let self, generation == self.generation else { return }
            self.updateSleepTimer()
            if let position = self.validSeconds(time) {
                self.lastKnownPosition = position
            }
            self.persistCheckpoint(force: false)
            let chapterIndex = self.nowPlayingChapterIndex(
                at: self.finiteSeconds(player.currentTime())
            )
            if chapterIndex != self.activeNowPlayingChapterIndex {
                self.updateNowPlayingInfo()
            }
            // Once WKWebView is suspended, crossing the Capacitor bridge on
            // every timer tick can starve AVPlayer's time-pitch processing.
            // The native player and Now Playing center keep their own clocks.
            if UIApplication.shared.applicationState == .active {
                self.emitState()
            }
        }

        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard
                let self,
                generation == self.generation,
                let endedItem = notification.object as? AVPlayerItem,
                let endedIndex = self.queuedItems.firstIndex(where: { $0 === endedItem })
            else { return }
            if endedIndex >= self.queuedItems.count - 1 {
                let endedDuration = self.finiteSeconds(endedItem.duration)
                let endedPosition = endedDuration > 0
                    ? endedDuration
                    : self.finiteSeconds(endedItem.currentTime())
                self.shouldAutoplay = false
                self.pendingPosition = endedPosition
                self.finishedPositionSeconds = endedPosition
                self.finishedDurationSeconds = endedDuration > 0 ? endedDuration : nil
                self.persistCheckpoint(
                    force: true,
                    positionSeconds: endedPosition,
                    durationSeconds: endedDuration > 0 ? endedDuration : nil
                )
                self.updateNowPlayingInfo()
                let finalState = self.stateData(
                    positionSeconds: endedPosition,
                    durationSeconds: endedDuration,
                    isPlaying: false
                )
                if UIApplication.shared.applicationState == .active {
                    self.notifyListeners("state", data: finalState)
                    self.notifyListeners("ended", data: finalState)
                } else {
                    self.finishedWhileInactive = true
                }
            }
        }

        stalledObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemPlaybackStalled,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self, generation == self.generation else { return }
            if UIApplication.shared.applicationState == .active {
                self.notifyListeners("stalled", data: [:])
            }
        }
    }

    private func activateQueuedTrack(at index: Int) {
        guard queuedTracks.indices.contains(index) else { return }
        let track = queuedTracks[index]
        activeQueueIndex = index
        pendingPosition = 0
        lastKnownPosition = 0
        recoveryTrackId = track.trackId
        recoveryBookOffset = track.bookOffsetSeconds
        lastCheckpointWrite = 0
        nowPlayingTitle = track.title
        nowPlayingArtist = track.artist
        nowPlayingAlbum = track.album
        nowPlayingChapters = track.chapters
        suppliedNowPlayingChapter = nil
        activeNowPlayingChapterIndex = nil
    }

    private func emitTrackChanged() {
        guard let trackId = recoveryTrackId, let player else { return }
        let position = finiteSeconds(player.currentTime())
        notifyListeners("trackChanged", data: [
            "trackId": trackId,
            "positionSeconds": position,
            "bookPositionSeconds": recoveryBookOffset + position,
            "isPlaying": player.timeControlStatus == .playing
        ])
    }

    private func configureRemoteCommandsIfNeeded() {
        guard remoteCommandTargets.isEmpty else { return }
        let commands = MPRemoteCommandCenter.shared()
        commands.playCommand.isEnabled = true
        commands.pauseCommand.isEnabled = true
        commands.togglePlayPauseCommand.isEnabled = true
        commands.skipBackwardCommand.isEnabled = true
        commands.skipBackwardCommand.preferredIntervals = [15]
        commands.skipForwardCommand.isEnabled = true
        commands.skipForwardCommand.preferredIntervals = [30]
        commands.changePlaybackPositionCommand.isEnabled = true

        remoteCommandTargets.append(commands.playCommand.addTarget { [weak self] _ in
            guard let self, let player = self.player else { return .commandFailed }
            self.shouldAutoplay = true
            self.activateAudioSession()
            player.playImmediately(atRate: self.desiredRate)
            self.persistCheckpoint(force: true)
            self.updateNowPlayingInfo()
            return .success
        })
        remoteCommandTargets.append(commands.pauseCommand.addTarget { [weak self] _ in
            guard let self, let player = self.player else { return .commandFailed }
            self.shouldAutoplay = false
            player.pause()
            self.persistCheckpoint(force: true)
            self.updateNowPlayingInfo()
            return .success
        })
        remoteCommandTargets.append(commands.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self, let player = self.player else { return .commandFailed }
            if player.timeControlStatus == .playing {
                self.shouldAutoplay = false
                player.pause()
                self.persistCheckpoint(force: true)
            } else {
                self.shouldAutoplay = true
                self.activateAudioSession()
                player.playImmediately(atRate: self.desiredRate)
            }
            self.updateNowPlayingInfo()
            return .success
        })
        remoteCommandTargets.append(commands.skipBackwardCommand.addTarget { [weak self] _ in
            self?.seekFromRemote(by: -15)
            return self?.player == nil ? .commandFailed : .success
        })
        remoteCommandTargets.append(commands.skipForwardCommand.addTarget { [weak self] _ in
            self?.seekFromRemote(by: 30)
            return self?.player == nil ? .commandFailed : .success
        })
        remoteCommandTargets.append(commands.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard
                let self,
                let player = self.player,
                let positionEvent = event as? MPChangePlaybackPositionCommandEvent
            else { return .commandFailed }
            let chapterStart = self.activeNowPlayingChapter()?.startSeconds ?? 0
            let itemDuration = self.finiteSeconds(player.currentItem?.duration ?? .invalid)
            let requestedPosition = max(0, positionEvent.positionTime + chapterStart)
            let position = itemDuration > 0 ? min(itemDuration, requestedPosition) : requestedPosition
            self.pendingPosition = position
            self.lastKnownPosition = position
            self.pendingRemoteIntentionalSeek = true
            player.seek(to: CMTime(seconds: position, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
                guard let self else { return }
                self.persistCheckpoint(force: true)
                self.updateNowPlayingInfo()
                if UIApplication.shared.applicationState == .active {
                    self.emitRemoteIntentionalSeek()
                }
            }
            return .success
        })
    }

    private func seekFromRemote(by offset: Double) {
        guard let player else { return }
        let duration = finiteSeconds(player.currentItem?.duration ?? .invalid)
        let position = finiteSeconds(player.currentTime())
        let target = max(0, duration > 0 ? min(duration, position + offset) : position + offset)
        pendingPosition = target
        lastKnownPosition = target
        pendingRemoteIntentionalSeek = true
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            guard let self else { return }
            self.persistCheckpoint(force: true)
            self.updateNowPlayingInfo()
            if UIApplication.shared.applicationState == .active {
                self.emitRemoteIntentionalSeek()
            }
        }
    }

    private func emitRemoteIntentionalSeek() {
        guard pendingRemoteIntentionalSeek, let player else { return }
        pendingRemoteIntentionalSeek = false
        notifyListeners("intentionalSeek", data: [
            "positionSeconds": finiteSeconds(player.currentTime())
        ])
    }

    private func installSessionObserversIfNeeded() {
        guard interruptionObserver == nil else { return }
        let center = NotificationCenter.default
        interruptionObserver = center.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            self?.handleAudioInterruption(notification)
        }
        routeChangeObserver = center.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            self?.handleAudioRouteChange(notification)
        }
        becameActiveObserver = center.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            if self.sleepTimerFinishedWhileInactive {
                self.sleepTimerFinishedWhileInactive = false
                self.notifyListeners("sleepTimerEnded", data: [:])
            }
            self.emitRemoteIntentionalSeek()
            // Some short notification interruptions do not deliver their end
            // callback until the app is active again. Resume the exact native
            // clock if playback was running before that interruption — but
            // only within the grace window and while nothing else is playing:
            // an interruption that ended without `.shouldResume` long ago
            // means another app owns the session now.
            if self.wasPlayingBeforeInterruption && self.shouldAutoplay {
                if self.interruptionResumeIsFresh()
                    && !AVAudioSession.sharedInstance().isOtherAudioPlaying {
                    self.interruptionIsActive = false
                    self.resumeAfterInterruption()
                } else {
                    self.wasPlayingBeforeInterruption = false
                    self.interruptionEndedWhileInactiveAt = nil
                }
            }
            if self.finishedWhileInactive {
                self.persistCheckpoint(
                    force: true,
                    positionSeconds: self.finishedPositionSeconds,
                    durationSeconds: self.finishedDurationSeconds
                )
                self.finishedWhileInactive = false
                let finalState = self.stateData(
                    positionSeconds: self.finishedPositionSeconds ?? 0,
                    durationSeconds: self.finishedDurationSeconds ?? 0,
                    isPlaying: false
                )
                self.notifyListeners("state", data: finalState)
                self.notifyListeners("ended", data: finalState)
            } else {
                self.persistCheckpoint(force: true)
                self.emitTrackChanged()
                self.emitState()
            }
            // Deliver a deferred error last: the JS error listener fails over
            // to web audio and stops listening, so replaying it first would
            // swallow the events above — and the state emit must correct the
            // web element's stale clock before the fallback plays from it.
            if let pendingError = self.pendingErrorWhileInactive {
                self.pendingErrorWhileInactive = nil
                self.notifyListeners("error", data: ["message": pendingError])
            }
        }
        enteredBackgroundObserver = center.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.persistCheckpoint(force: true)
        }
    }

    private func handleAudioInterruption(_ notification: Notification) {
        guard
            let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: rawType)
        else { return }

        switch type {
        case .began:
            interruptionIsActive = true
            interruptionEndedWhileInactiveAt = nil
            // iOS may have already changed AVPlayer to paused by the time this
            // notification is delivered. The retained play intent is the
            // reliable signal that playback should continue afterward.
            wasPlayingBeforeInterruption = shouldAutoplay
            pendingPosition = stablePlayerPosition()
            lastKnownPosition = pendingPosition
            player?.pause()
            persistCheckpoint(force: true)
            updateNowPlayingInfo()
            if UIApplication.shared.applicationState == .active { emitState() }
        case .ended:
            interruptionIsActive = false
            let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: rawOptions)
            if wasPlayingBeforeInterruption && shouldAutoplay && options.contains(.shouldResume) {
                resumeAfterInterruption()
            } else {
                // `shouldResume` is a system hint, and iOS does not include it
                // for every interruption that finishes while the app remains
                // inactive. Retain the user's play intent in that case so the
                // didBecomeActive fallback can restore playback. If the app is
                // already active, the missing hint remains authoritative. The
                // timestamp bounds the retention: a latch that is hours old
                // means the hint was meant, and resuming would hijack whatever
                // now owns the audio session.
                if UIApplication.shared.applicationState == .active {
                    wasPlayingBeforeInterruption = false
                } else {
                    interruptionEndedWhileInactiveAt = Date.timeIntervalSinceReferenceDate
                }
                persistCheckpoint(force: true)
                updateNowPlayingInfo()
                if UIApplication.shared.applicationState == .active { emitState() }
            }
        @unknown default:
            break
        }
    }

    private func handleAudioRouteChange(_ notification: Notification) {
        guard
            let rawReason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
            let reason = AVAudioSession.RouteChangeReason(rawValue: rawReason),
            let player
        else { return }

        switch reason {
        case .oldDeviceUnavailable:
            // Removing wired headphones or disconnecting AirPods is not
            // reliably delivered as an audio interruption. Treat the route
            // loss as an explicit pause so playback never spills onto the
            // speaker, and record AVPlayer's clock before a suspended WebView
            // can lose the position.
            shouldAutoplay = false
            wasPlayingBeforeInterruption = false
            interruptionIsActive = false
            pendingPosition = stablePlayerPosition()
            lastKnownPosition = pendingPosition
            player.pause()
            persistCheckpoint(force: true, positionSeconds: pendingPosition)
            updateNowPlayingInfo()
            if UIApplication.shared.applicationState == .active { emitState() }
        case .newDeviceAvailable:
            // Putting in AirPods can play a connection chime that begins an
            // interruption without a useful matching `.ended` notification.
            // The retained play intent is authoritative: reclaim the session
            // and Now Playing ownership once the new output route is ready.
            // A route change is not proof the interruption is over, though:
            // a phone call is still one while AirPods go in. Only a session
            // activation that succeeds ends the interruption bookkeeping; a
            // failed one keeps the play intent for the `.ended` notification.
            if shouldAutoplay {
                if interruptionIsActive {
                    guard activateAudioSession() else { break }
                    interruptionIsActive = false
                }
                resumeAfterInterruption()
            } else {
                wasPlayingBeforeInterruption = false
                persistCheckpoint(force: true)
                updateNowPlayingInfo()
                if UIApplication.shared.applicationState == .active { emitState() }
            }
        default:
            break
        }
    }

    private func interruptionResumeIsFresh() -> Bool {
        guard let endedAt = interruptionEndedWhileInactiveAt else { return true }
        return Date.timeIntervalSinceReferenceDate - endedAt <= Self.interruptionResumeGraceSeconds
    }

    private func resumeAfterInterruption() {
        guard !interruptionIsActive, let player else { return }
        wasPlayingBeforeInterruption = false
        interruptionEndedWhileInactiveAt = nil
        activateAudioSession()
        player.playImmediately(atRate: desiredRate)
        persistCheckpoint(force: true)
        updateNowPlayingInfo()
        if UIApplication.shared.applicationState == .active { emitState() }
    }

    @discardableResult
    private func activateAudioSession() -> Bool {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio)
            try session.setActive(true)
            return true
        } catch {
            // iOS refuses activation while another interruption (a phone
            // call) owns the session. That is expected, not a broken native
            // player: keep the play intent and let the interruption's end
            // resume playback instead of failing over to web audio for good.
            if interruptionIsActive {
                NSLog("Audio session activation deferred during an interruption: %@", error.localizedDescription)
            } else {
                emitError("Unable to activate background audio: \(error.localizedDescription)")
            }
            return false
        }
    }

    /// Gives the audio session up after a teardown so other apps' audio can
    /// resume. Pausing keeps the session; only a stop releases it.
    private func deactivateAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            NSLog("Unable to deactivate the audio session: %@", error.localizedDescription)
        }
    }

    private func persistCheckpoint(
        force: Bool,
        positionSeconds: Double? = nil,
        durationSeconds: Double? = nil
    ) {
        guard
            let player,
            let scopeKey = recoveryScopeKey,
            let trackId = recoveryTrackId
        else { return }
        let now = Date().timeIntervalSince1970 * 1000
        if !force && now - lastCheckpointWrite < 2_000 { return }
        let position = positionSeconds ?? stablePlayerPosition()
        lastKnownPosition = position
        let duration = durationSeconds ?? finiteSeconds(player.currentItem?.duration ?? .invalid)
        let checkpoint = NativeAudioCheckpoint(
            scopeKey: scopeKey,
            trackId: trackId,
            positionSeconds: position,
            bookPositionSeconds: recoveryBookOffset + position,
            durationSeconds: duration > 0 ? duration : nil,
            updatedAt: now
        )
        guard let data = try? JSONEncoder().encode(checkpoint) else { return }
        UserDefaults.standard.set(data, forKey: checkpointKey)
        lastCheckpointWrite = now
    }

    private func loadCheckpoint() -> NativeAudioCheckpoint? {
        guard let data = UserDefaults.standard.data(forKey: checkpointKey) else { return nil }
        return try? JSONDecoder().decode(NativeAudioCheckpoint.self, from: data)
    }

    private func updateNowPlayingInfo() {
        guard let player, let item = player.currentItem else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            return
        }
        let itemDuration = finiteSeconds(item.duration)
        let itemPosition = finiteSeconds(player.currentTime())
        activeNowPlayingChapterIndex = nowPlayingChapterIndex(at: itemPosition)
        let chapter = activeNowPlayingChapter()
        let duration = chapter?.durationSeconds ?? itemDuration
        let position = chapter.map {
            min($0.durationSeconds, max(0, itemPosition - $0.startSeconds))
        } ?? itemPosition
        let isPlaying = player.timeControlStatus == .playing
        let playbackRate = effectivePlaybackRate(for: player)
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: chapter?.title ?? nowPlayingTitle,
            MPMediaItemPropertyArtist: nowPlayingArtist,
            MPMediaItemPropertyAlbumTitle: nowPlayingAlbum,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: playbackRate,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: Double(desiredRate),
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
            MPNowPlayingInfoPropertyIsLiveStream: false
        ]
        if duration > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = duration
        }
        if let nowPlayingArtwork {
            info[MPMediaItemPropertyArtwork] = nowPlayingArtwork
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        MPNowPlayingInfoCenter.default().playbackState = isPlaying ? .playing : .paused
    }

    /// Now Playing extrapolates its clock from elapsed time and playback rate.
    /// AVPlayer's spoken-audio processing can quantize the requested rate, so
    /// use the current item's timebase rather than the UI's requested value.
    /// Waiting and paused players must publish zero or the lock-screen clock
    /// continues moving while the media clock is stopped.
    private func effectivePlaybackRate(for player: AVPlayer) -> Double {
        guard player.timeControlStatus == .playing else { return 0 }
        if let timebase = player.currentItem?.timebase {
            let rate = CMTimebaseGetRate(timebase)
            if rate.isFinite, rate > 0 { return rate }
        }
        let rate = Double(player.rate)
        return rate.isFinite && rate > 0 ? rate : Double(desiredRate)
    }

    private func nowPlayingChapterIndex(at position: Double) -> Int? {
        nowPlayingChapters.lastIndex {
            position >= $0.startSeconds && position <= $0.startSeconds + $0.durationSeconds
        }
    }

    private func activeNowPlayingChapter() -> NativeNowPlayingChapter? {
        if let activeNowPlayingChapterIndex {
            return nowPlayingChapters[activeNowPlayingChapterIndex]
        }
        return suppliedNowPlayingChapter
    }

    private func loadArtwork(from source: String?) {
        artworkGeneration += 1
        let requestedGeneration = artworkGeneration
        nowPlayingArtwork = nil
        guard let source, let url = resolveSourceURL(source) else { return }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let data = try? Data(contentsOf: url), let image = UIImage(data: data) else { return }
            DispatchQueue.main.async {
                guard let self, requestedGeneration == self.artworkGeneration else { return }
                self.nowPlayingArtwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                self.updateNowPlayingInfo()
            }
        }
    }

    private func emitState() {
        guard let player else { return }
        let position = finiteSeconds(player.currentTime())
        let duration = finiteSeconds(player.currentItem?.duration ?? .invalid)
        notifyListeners("state", data: stateData(
            positionSeconds: position,
            durationSeconds: duration,
            isPlaying: player.timeControlStatus == .playing
        ))
    }

    /// A `state` payload. The track id lets the JS side drop a clock that
    /// belongs to a track it has already moved away from.
    private func stateData(positionSeconds: Double, durationSeconds: Double, isPlaying: Bool) -> JSObject {
        var data: JSObject = [
            "positionSeconds": positionSeconds,
            "durationSeconds": durationSeconds,
            "isPlaying": isPlaying
        ]
        if let trackId = recoveryTrackId {
            data["trackId"] = trackId
        }
        return data
    }

    private func emitError(_ message: String) {
        // Only `.background` suspends the WKWebView; in `.inactive` (control
        // center, app switcher, call banner) JS still runs and the web-audio
        // failover must stay immediate.
        if UIApplication.shared.applicationState == .background {
            pendingErrorWhileInactive = message
        } else {
            notifyListeners("error", data: ["message": message])
        }
    }

    private func updateSleepTimer() {
        guard sleepTimerRemaining > 0, let player else {
            sleepTimerLastTick = nil
            return
        }
        guard player.timeControlStatus == .playing else {
            sleepTimerLastTick = nil
            return
        }

        let now = Date.timeIntervalSinceReferenceDate
        guard let lastTick = sleepTimerLastTick else {
            sleepTimerLastTick = now
            return
        }
        sleepTimerLastTick = now
        sleepTimerRemaining = max(0, sleepTimerRemaining - max(0, now - lastTick))
        guard sleepTimerRemaining == 0 else { return }

        sleepTimerLastTick = nil
        shouldAutoplay = false
        // pause() drives the timeControlStatus observation, which republishes
        // Now Playing info — no explicit updateNowPlayingInfo() needed here.
        player.pause()
        persistCheckpoint(force: true)
        if UIApplication.shared.applicationState == .active {
            notifyListeners("sleepTimerEnded", data: [:])
            emitState()
        } else {
            sleepTimerFinishedWhileInactive = true
        }
    }

    private func syncSleepTimerWithPlaybackState(_ status: AVPlayer.TimeControlStatus) {
        guard sleepTimerRemaining > 0 else {
            sleepTimerLastTick = nil
            return
        }
        sleepTimerLastTick = status == .playing
            ? Date.timeIntervalSinceReferenceDate
            : nil
    }

    private func tearDownPlayer() {
        persistCheckpoint(
            force: true,
            positionSeconds: finishedPositionSeconds,
            durationSeconds: finishedDurationSeconds
        )
        statusObservation?.invalidate()
        statusObservation = nil
        for observation in failureObservations {
            observation.invalidate()
        }
        failureObservations = []
        currentItemObservation?.invalidate()
        currentItemObservation = nil
        timeControlStatusObservation?.invalidate()
        timeControlStatusObservation = nil
        if let timeObserver, let player {
            player.removeTimeObserver(timeObserver)
        }
        timeObserver = nil
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
        }
        endObserver = nil
        if let stalledObserver {
            NotificationCenter.default.removeObserver(stalledObserver)
        }
        stalledObserver = nil
        if let rateChangeObserver {
            NotificationCenter.default.removeObserver(rateChangeObserver)
        }
        rateChangeObserver = nil
        player?.pause()
        if let queuePlayer = player as? AVQueuePlayer {
            queuePlayer.removeAllItems()
        } else {
            player?.replaceCurrentItem(with: nil)
        }
        player = nil
        shouldAutoplay = false
        playIntentAt = 0
        wasPlayingBeforeInterruption = false
        interruptionEndedWhileInactiveAt = nil
        interruptionIsActive = false
        recoveryScopeKey = nil
        recoveryTrackId = nil
        recoveryBookOffset = 0
        lastKnownPosition = 0
        nowPlayingChapters = []
        suppliedNowPlayingChapter = nil
        activeNowPlayingChapterIndex = nil
        queuedTracks = []
        queuedItems = []
        activeQueueIndex = 0
        finishedWhileInactive = false
        finishedPositionSeconds = nil
        finishedDurationSeconds = nil
        pendingErrorWhileInactive = nil
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    private func resolveSourceURL(_ source: String) -> URL? {
        resolveNativeAudioSourceURL(source)
    }

    private func finiteSeconds(_ time: CMTime) -> Double {
        validSeconds(time) ?? 0
    }

    private func validSeconds(_ time: CMTime) -> Double? {
        let value = CMTimeGetSeconds(time)
        return value.isFinite && value >= 0 ? value : nil
    }

    private func stablePlayerPosition() -> Double {
        guard let current = validSeconds(player?.currentTime() ?? .invalid) else {
            return lastKnownPosition
        }
        // A route swap can expose the replacement renderer's initial 0:00
        // before it has adopted the existing item clock. Explicit seeks and
        // queue changes update lastKnownPosition first, so preserving it here
        // does not block a real rewind to the beginning.
        if current < 0.01 && lastKnownPosition >= 1 {
            return lastKnownPosition
        }
        return current
    }

    private func clampedRate(_ value: Double) -> Float {
        Float(min(2, max(0.5, value)))
    }

    private func clampedVolume(_ value: Double) -> Float {
        Float(min(1, max(0, value)))
    }

    /// Matches the server's clamp. A hand-edited or buggy value must not turn
    /// into an eardrum-splitting multiplier on a pair of headphones.
    private func clampedGain(_ value: Double) -> Float {
        guard value.isFinite else { return 1 }
        return Float(min(16, max(0.5, value)))
    }
}

private func resolveNativeAudioSourceURL(_ source: String) -> URL? {
    guard let url = URL(string: source) else { return nil }
    guard url.scheme == "capacitor" else { return url }
    let marker = "/_capacitor_file_"
    guard url.path.hasPrefix(marker) else { return nil }
    let filePath = String(url.path.dropFirst(marker.count)).removingPercentEncoding
        ?? String(url.path.dropFirst(marker.count))
    return URL(fileURLWithPath: filePath)
}

private func jsDouble(_ value: Any?) -> Double? {
    if let value = value as? Double { return value }
    if let value = value as? NSNumber { return value.doubleValue }
    return nil
}
