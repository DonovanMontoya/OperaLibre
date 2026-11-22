import AVFoundation
import Foundation
import MediaPlayer
import UIKit

func compactAudioSource(_ source: URL) -> URL {
    guard var components = URLComponents(url: source, resolvingAgainstBaseURL: false),
          components.scheme == "http" || components.scheme == "https" else { return source }
    let path = Array(components.path.split(separator: "/").suffix(6))
    guard path.count == 6, path[0] == "api", path[1] == "books",
          path[3] == "tracks", path[5] == "stream" else { return source }
    var query = components.queryItems ?? []
    query.removeAll { $0.name == "compact" }
    query.append(URLQueryItem(name: "compact", value: "1"))
    components.queryItems = query
    return components.url ?? source
}

func packetAudioSource(_ source: URL) -> URL? {
    guard var components = URLComponents(url: source, resolvingAgainstBaseURL: false) else { return nil }
    let path = Array(components.path.split(separator: "/").suffix(6))
    guard path.count == 6, path[0] == "api", path[1] == "books",
          path[3] == "tracks", path[5] == "stream",
          components.scheme == "http" || components.scheme == "https" else { return nil }
    components.path = String(components.path.dropLast("stream".count)) + "packet-stream"
    components.queryItems = components.queryItems?.filter { $0.name != "compact" }
    return components.url
}

struct NativeAudioCheckpoint: Codable {
    let scopeKey: String
    let trackId: String
    let positionSeconds: Double
    let bookPositionSeconds: Double
    let durationSeconds: Double?
    let updatedAt: Double
}

struct NativeNowPlayingChapter {
    let title: String
    let startSeconds: Double
    let durationSeconds: Double
}

struct NativeAudioQueuedTrack {
    var url: URL
    let trackId: String
    let bookOffsetSeconds: Double
    var title: String
    var artist: String
    var album: String
    var chapters: [NativeNowPlayingChapter]
}

struct AudiobookLoadRequest {
    var url: URL
    var positionSeconds: Double
    var rate: Double
    var volume: Double
    var gain: Double
    var autoplay: Bool
    var recoveryScopeKey: String?
    var recoveryTrackId: String?
    var recoveryBookOffsetSeconds: Double
    var queue: [NativeAudioQueuedTrack]
    var keepsPendingIntentionalSeek = false
    var clipPreview = false
}

struct AudiobookNowPlayingRequest {
    var title: String
    var artist: String
    var album: String
    var artworkSource: String?
    var chapterStartSeconds: Double?
    var chapterDurationSeconds: Double?
    var chapters: [NativeNowPlayingChapter]
}

struct AudiobookPlayerStatus {
    var isLoaded: Bool
    var isPlaying: Bool
    var scopeKey: String?
    var trackId: String?
    var positionSeconds: Double
    var bookPositionSeconds: Double
    var durationSeconds: Double?
    var title: String
    var artist: String
    var album: String
}

struct AudiobookAdoptableSession {
    var positionSeconds: Double
    var sleepTimerSeconds: Double
    var sleepAtChapterEnd: Bool
}

func sameAudioSource(_ playing: URL, _ requested: URL) -> Bool {
    if playing.isFileURL || requested.isFileURL {
        return playing.isFileURL && requested.isFileURL
            && playing.standardizedFileURL.path == requested.standardizedFileURL.path
    }
    return playing.scheme == requested.scheme
        && playing.host == requested.host
        && playing.port == requested.port
        && playing.path == requested.path
}

protocol AudiobookPlayerObserver: AnyObject {
    func audiobookPlayer(_ player: AudiobookPlayer, didEmit event: String, data: [String: Any])
}

protocol AudiobookPlayerMonitor: AnyObject {
    func audiobookPlayer(_ player: AudiobookPlayer, didPersist checkpoint: NativeAudioCheckpoint)
    func audiobookPlayerDidChangePlaybackState(_ player: AudiobookPlayer)
    func audiobookPlayerDidFinishPlayback(_ player: AudiobookPlayer)
    func audiobookPlayer(_ player: AudiobookPlayer, didFail message: String)
    func audiobookPlayerDidSeekDeliberately(_ player: AudiobookPlayer)
}

extension AudiobookPlayerMonitor {
    func audiobookPlayer(_ player: AudiobookPlayer, didPersist checkpoint: NativeAudioCheckpoint) {}
    func audiobookPlayerDidChangePlaybackState(_ player: AudiobookPlayer) {}
    func audiobookPlayerDidFinishPlayback(_ player: AudiobookPlayer) {}
    func audiobookPlayer(_ player: AudiobookPlayer, didFail message: String) {}
    func audiobookPlayerDidSeekDeliberately(_ player: AudiobookPlayer) {}
}

public final class AudiobookPlayer {
    static let shared = AudiobookPlayer()

    weak var observer: AudiobookPlayerObserver?
    weak var monitor: AudiobookPlayerMonitor?

    private let makeQueuePlayer: ([AVPlayerItem]) -> AVQueuePlayer

    init(makeQueuePlayer: @escaping ([AVPlayerItem]) -> AVQueuePlayer = { AVQueuePlayer(items: $0) }) {
        self.makeQueuePlayer = makeQueuePlayer
    }

    private var player: AVPlayer?
    private var statusObservation: NSKeyValueObservation?
    private var durationObservation: NSKeyValueObservation?
    private var failureObservations: [NSKeyValueObservation] = []
    private var currentItemObservation: NSKeyValueObservation?
    private var timeControlStatusObservation: NSKeyValueObservation?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var rateChangeObserver: NSObjectProtocol?
    private var interruptionObserver: NSObjectProtocol?
    private var routeChangeObserver: NSObjectProtocol?
    private var mediaServicesResetObserver: NSObjectProtocol?
    private var becameActiveObserver: NSObjectProtocol?
    private var willEnterForegroundObserver: NSObjectProtocol?
    private var enteredBackgroundObserver: NSObjectProtocol?
    private var desiredRate: Float = 1
    private var boostGain: Float = 1
    private var pendingPosition: Double = 0
    private var lastKnownPosition: Double = 0
    private var shouldAutoplay = false
    private var wasPlayingBeforeInterruption = false
    private var interruptionIsActive = false
    private var interruptionSerial = 0
    private let sessionQueue = DispatchQueue(label: "com.operalibre.audio-session", qos: .userInitiated)
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
    private static let playIntentGraceSeconds = 5.0
    private var playIntentAt = 0.0
    private var queuedTracks: [NativeAudioQueuedTrack] = []
    private var queuedItems: [AVPlayerItem] = []
    private var activeQueueIndex = 0
    private var packetAudio: PacketAudioAsset?
    private var initialSeekComplete = false
    private var positionEstablished = false
    private(set) var isClipPreview = false
    private var seekSerial = 0
    private var finishedWhileInactive = false
    private var finishedPositionSeconds: Double?
    private var finishedDurationSeconds: Double?
    private var sleepTimerRemaining: TimeInterval = 0
    private var sleepTimerLastTick: TimeInterval?
    private var sleepTimerFinishedWhileInactive = false
    private var sleepAtChapterEnd = false
    private var sleepChapterLastPosition: Double?
    private static let sleepChapterStepSeconds = 4.0
    private static let sleepChapterFileStartSeconds = 1.0
    private var pendingErrorWhileInactive: String?
    private static let interruptionResumeGraceSeconds = 30.0
    private var interruptionEndedWhileInactiveAt: TimeInterval?
    private static let interruptionResumeRetryDelays: [TimeInterval] = [0.5, 1, 2]
    private static let interruptionResumeWindowSeconds = 10.0
    private var interruptionResumeSerial = 0
    private var interruptionResumeTask: UIBackgroundTaskIdentifier = .invalid

    deinit {
        tearDownPlayer()
        for observer in [
            interruptionObserver,
            routeChangeObserver,
            mediaServicesResetObserver,
            becameActiveObserver,
            willEnterForegroundObserver,
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

    // MARK: - Transport

    func load(_ request: AudiobookLoadRequest) {
        load(request, allowsPacketAudio: true)
    }

    private func load(_ request: AudiobookLoadRequest, allowsPacketAudio: Bool) {
        let url = compactAudioSource(request.url)
        let position = max(0, request.positionSeconds)
        let rate = clampedRate(request.rate)
        let volume = clampedVolume(request.volume)
        let gain = clampedGain(request.gain)
        let autoplay = request.autoplay
        let scopeKey = request.recoveryScopeKey
        let trackId = request.recoveryTrackId
        let bookOffset = max(0, request.recoveryBookOffsetSeconds)
        var requestedQueue = request.queue.map { track in
            var track = track
            track.url = compactAudioSource(track.url)
            return track
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

        let install = { [weak self] in
            guard let self else { return }

            let playIntentAge = Date.timeIntervalSinceReferenceDate - self.playIntentAt
            let retainedPlayIntent =
                self.shouldAutoplay && playIntentAge <= Self.playIntentGraceSeconds
            self.tearDownPlayer()
            self.isClipPreview = request.clipPreview
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
            self.initialSeekComplete = false
            self.positionEstablished = false
            if !request.keepsPendingIntentionalSeek {
                self.pendingRemoteIntentionalSeek = false
            }
            self.finishedWhileInactive = false
            self.finishedPositionSeconds = nil
            self.finishedDurationSeconds = nil
            self.installSessionObserversIfNeeded()

            let items = requestedQueue.enumerated().map { index, track in
                var asset = AVURLAsset(url: track.url)
                if index == 0, allowsPacketAudio, let source = packetAudioSource(track.url) {
                    let packet = PacketAudioAsset(source: source) { [weak self] in
                        guard let self, self.generation == loadGeneration else { return }
                        _ = self.retryWithoutPacketAudio()
                    }
                    self.packetAudio = packet
                    asset = packet.asset
                }
                let item = AVPlayerItem(
                    asset: asset,
                    automaticallyLoadedAssetKeys: []
                )
                item.audioTimePitchAlgorithm = .timeDomain
                return item
            }
            self.queuedItems = items
            let player = self.makeQueuePlayer(items)
            player.actionAtItemEnd = .advance
            player.automaticallyWaitsToMinimizeStalling = true
            player.preventsDisplaySleepDuringVideoPlayback = false
            player.volume = volume
            self.player = player
            self.activateQueuedTrack(at: 0)
            self.pendingPosition = position
            self.lastKnownPosition = position
            self.configureRemoteCommandsIfNeeded()
            self.installObservers(player: player, item: items[0], generation: loadGeneration)
        }
        if !allowsPacketAudio && Thread.isMainThread {
            install()
        } else {
            DispatchQueue.main.async(execute: install)
        }
    }

    func play() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard let player = self.player else {
                self.shouldAutoplay = true
                self.playIntentAt = Date.timeIntervalSinceReferenceDate
                return
            }
            self.shouldAutoplay = true
            self.playIntentAt = Date.timeIntervalSinceReferenceDate
            if player.currentItem?.status == .readyToPlay && self.initialSeekComplete {
                self.activateAudioSession { [weak self] activated in
                    guard let self, player === self.player else { return }
                    if activated && self.shouldAutoplay {
                        player.playImmediately(atRate: self.desiredRate)
                    }
                    self.persistCheckpoint(force: true)
                    self.updateNowPlayingInfo()
                }
            }
        }
    }

    func pause() {
        DispatchQueue.main.async { [weak self] in
            self?.shouldAutoplay = false
            self?.player?.pause()
            self?.persistCheckpoint(force: true)
            self?.updateNowPlayingInfo()
        }
    }

    func setSleepTimer(seconds: Double, atChapterEnd: Bool = false) {
        let seconds = max(0, seconds)
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.sleepTimerRemaining = seconds
            self.sleepAtChapterEnd = atChapterEnd
            self.sleepChapterLastPosition = nil
            self.syncSleepTimerWithPlaybackState(self.player?.timeControlStatus ?? .paused)
            self.sleepTimerFinishedWhileInactive = false
        }
    }

    func sleepTimerRemainingSeconds(_ completion: @escaping (Double) -> Void) {
        DispatchQueue.main.async { [weak self] in
            completion(self?.sleepTimerRemaining ?? 0)
        }
    }

    func seek(toPositionSeconds requested: Double, clipPreview: Bool = false) {
        let position = max(0, requested)
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if clipPreview && !self.isClipPreview { self.persistCheckpoint(force: true) }
            let returningFromPreview = self.isClipPreview && !clipPreview
            self.isClipPreview = clipPreview
            self.performSeek(to: position, intentional: false, requiresExactPosition: returningFromPreview)
        }
    }

    private func performSeek(to position: Double, intentional: Bool, requiresExactPosition: Bool = false) {
        let leavingPreview = requiresExactPosition || (intentional && isClipPreview)
        pendingPosition = position
        initialSeekComplete = false
        guard let player, let item = player.currentItem else { return }
        if intentional {
            isClipPreview = false
            pendingRemoteIntentionalSeek = true
            monitor?.audiobookPlayerDidSeekDeliberately(self)
        }
        seekCurrentItem(player, item: item, to: position) { [weak self] reached in
            guard let self else { return }
            guard reached || (self.positionEstablished && !leavingPreview) else {
                if leavingPreview { self.isClipPreview = true }
                self.failUnreachedResumeSeek()
                return
            }
            self.initialSeekComplete = true
            self.positionEstablished = true
            self.lastKnownPosition = self.finiteSeconds(player.currentTime())
            if !reached {
                self.pendingPosition = self.lastKnownPosition
                self.pendingRemoteIntentionalSeek = false
            }
            if UIApplication.shared.applicationState == .active {
                self.emitRemoteIntentionalSeek()
            }
            self.persistCheckpoint(force: true)
            self.emitState()
            if self.shouldAutoplay, player.timeControlStatus != .playing {
                self.activateAudioSession { [weak self] activated in
                    guard let self, activated, self.shouldAutoplay,
                          player === self.player,
                          player.timeControlStatus != .playing else { return }
                    player.playImmediately(atRate: self.desiredRate)
                }
            }
            item.asset.loadValuesAsynchronously(forKeys: ["duration"]) {}
            self.prepareBoostForNextQueuedItem()
            self.updateNowPlayingInfo()
        }
    }

    private func failUnreachedResumeSeek() {
        emitError("The audiobook could not resume at its saved position.")
    }

    private func seekCurrentItem(
        _ player: AVPlayer,
        item: AVPlayerItem,
        to position: Double,
        attempts: Int = 3,
        completion: @escaping (Bool) -> Void
    ) {
        seekSerial += 1
        let serial = seekSerial
        let seekGeneration = generation
        sleepChapterLastPosition = nil
        player.seek(to: CMTime(seconds: position, preferredTimescale: 600),
                    toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
            guard let self, serial == self.seekSerial, seekGeneration == self.generation,
                  player === self.player, player.currentItem === item else { return }
            self.sleepChapterLastPosition = nil
            if finished || item.status != .readyToPlay {
                if finished { completion(true) }
            } else if attempts > 1 {
                self.seekCurrentItem(player, item: item, to: position, attempts: attempts - 1, completion: completion)
            } else {
                completion(false)
            }
        }
    }

    func skip(bySeconds offset: Double) {
        DispatchQueue.main.async { [weak self] in
            self?.seekFromRemote(by: offset)
        }
    }

    func setRate(_ requested: Double) {
        let rate = clampedRate(requested)
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.desiredRate = rate
            if let player = self.player, player.timeControlStatus == .playing {
                player.rate = rate
            }
            self.updateNowPlayingInfo()
        }
    }

    var playbackRate: Double {
        Double(desiredRate)
    }

    func setNowPlaying(_ request: AudiobookNowPlayingRequest) {
        let suppliedChapter: NativeNowPlayingChapter? =
            if let start = request.chapterStartSeconds,
               let duration = request.chapterDurationSeconds,
               start.isFinite,
               duration.isFinite,
               duration > 0
            {
                NativeNowPlayingChapter(
                    title: request.title,
                    startSeconds: start,
                    durationSeconds: duration
                )
            } else {
                nil
            }

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.nowPlayingTitle = request.title
            self.nowPlayingArtist = request.artist
            self.nowPlayingAlbum = request.album
            self.nowPlayingChapters = request.chapters.sorted { $0.startSeconds < $1.startSeconds }
            self.sleepChapterLastPosition = nil
            self.suppliedNowPlayingChapter = suppliedChapter
            self.activeNowPlayingChapterIndex = nil
            self.loadArtwork(from: request.artworkSource)
            self.updateNowPlayingInfo()
        }
    }

    func setVolume(_ requested: Double) {
        let volume = clampedVolume(requested)
        DispatchQueue.main.async { [weak self] in
            self?.player?.volume = volume
        }
    }

    func setGain(_ requested: Double) {
        let gain = clampedGain(requested)
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.boostGain = gain
            if let item = self.player?.currentItem {
                self.applyBoost(to: item, gain: gain)
            }
            if self.positionEstablished {
                self.prepareBoostForNextQueuedItem()
            }
        }
    }

    func recoveryState(forScope scope: String) -> NativeAudioCheckpoint? {
        guard let checkpoint = loadCheckpoint(), checkpoint.scopeKey == scope else { return nil }
        return checkpoint
    }

    func adoptableSession(
        scopeKey: String,
        trackId: String,
        source: URL,
        completion: @escaping (AudiobookAdoptableSession?) -> Void
    ) {
        DispatchQueue.main.async { [weak self] in
            guard
                let self,
                let player = self.player,
                player.timeControlStatus != .paused,
                !self.isClipPreview,
                self.initialSeekComplete,
                player.currentItem?.status == .readyToPlay,
                self.recoveryScopeKey == scopeKey,
                self.recoveryTrackId == trackId,
                self.queuedTracks.indices.contains(self.activeQueueIndex),
                sameAudioSource(self.queuedTracks[self.activeQueueIndex].url, source)
            else {
                completion(nil)
                return
            }
            completion(AudiobookAdoptableSession(
                positionSeconds: self.stablePlayerPosition(),
                sleepTimerSeconds: self.sleepTimerRemaining,
                sleepAtChapterEnd: self.sleepAtChapterEnd
            ))
            DispatchQueue.main.async { [weak self] in self?.emitState() }
        }
    }

    func stop(releaseSession: Bool) {
        DispatchQueue.main.async { [weak self] in
            self?.stopOnMainThread(releaseSession: releaseSession)
        }
    }

    func stopOnMainThread(releaseSession: Bool) {
        precondition(Thread.isMainThread)
        generation += 1
        sleepTimerRemaining = 0
        sleepTimerLastTick = nil
        sleepTimerFinishedWhileInactive = false
        sleepAtChapterEnd = false
        sleepChapterLastPosition = nil
        tearDownPlayer()
        if releaseSession {
            deactivateAudioSession()
        }
    }

    var status: AudiobookPlayerStatus {
        let position = player == nil ? 0 : stablePlayerPosition()
        let duration = finiteSeconds(player?.currentItem?.duration ?? .invalid)
        return AudiobookPlayerStatus(
            isLoaded: player != nil,
            isPlaying: player?.timeControlStatus == .playing,
            scopeKey: recoveryScopeKey,
            trackId: recoveryTrackId,
            positionSeconds: position,
            bookPositionSeconds: recoveryBookOffset + position,
            durationSeconds: duration > 0 ? duration : nil,
            title: nowPlayingTitle,
            artist: nowPlayingArtist,
            album: nowPlayingAlbum
        )
    }

    private func emit(_ event: String, data: [String: Any]) {
        observer?.audiobookPlayer(self, didEmit: event, data: data)
    }

    private func prepareBoostForNextQueuedItem() {
        let next = activeQueueIndex + 1
        guard queuedItems.indices.contains(next) else { return }
        applyBoost(to: queuedItems[next], gain: boostGain)
    }

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
                    let ready: (Bool) -> Void = { [weak self] reached in
                        guard let self, generation == self.generation,
                              player === self.player, player.currentItem === item else { return }
                        guard reached else {
                            self.failUnreachedResumeSeek()
                            return
                        }
                        self.initialSeekComplete = true
                        self.positionEstablished = true
                        if UIApplication.shared.applicationState == .active {
                            self.emitRemoteIntentionalSeek()
                        }
                        self.persistCheckpoint(force: true)
                        self.emitState()
                        if self.shouldAutoplay {
                            self.activateAudioSession { [weak self] activated in
                                guard let self, activated, self.shouldAutoplay,
                                      player === self.player else { return }
                                player.playImmediately(atRate: self.desiredRate)
                                self.updateNowPlayingInfo()
                            }
                        }
                        item.asset.loadValuesAsynchronously(forKeys: ["duration"]) {}
                        self.prepareBoostForNextQueuedItem()
                        self.updateNowPlayingInfo()
                    }
                    if self.pendingPosition == 0 {
                        ready(true)
                    } else {
                        self.seekCurrentItem(player, item: item, to: self.pendingPosition, completion: ready)
                    }
                case .failed:
                    if self.retryWithoutPacketAudio() { return }
                    self.emitError(item.error?.localizedDescription ?? "The audio track could not be loaded.")
                default:
                    break
                }
            }
        }

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
                    generation == self.generation
                else { return }
                guard let currentItem = player.currentItem else {
                    if !self.initialSeekComplete {
                        if self.retryWithoutPacketAudio() { return }
                        self.emitError("The audio track could not be loaded.")
                    }
                    return
                }
                guard
                    let index = self.queuedItems.firstIndex(where: { $0 === currentItem }),
                    index != self.activeQueueIndex
                else { return }
                if !self.initialSeekComplete, self.packetAudio != nil {
                    if self.retryWithoutPacketAudio() { return }
                }
                self.activateQueuedTrack(at: index)
                self.initialSeekComplete = true
                self.positionEstablished = true
                self.prepareBoostForNextQueuedItem()
                self.pendingRemoteIntentionalSeek = false
                self.persistCheckpoint(force: true)
                self.updateNowPlayingInfo()
                if self.shouldAutoplay && player.timeControlStatus != .playing {
                    self.activateAudioSession { [weak self] activated in
                        guard let self, activated, self.shouldAutoplay,
                              player === self.player,
                              player.timeControlStatus != .playing else { return }
                        player.playImmediately(atRate: self.desiredRate)
                    }
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
            self.updateChapterSleep()
            if self.initialSeekComplete, let position = self.validSeconds(time) {
                self.lastKnownPosition = position
            }
            self.persistCheckpoint(force: false)
            let chapterIndex = self.nowPlayingChapterIndex(
                at: self.finiteSeconds(player.currentTime())
            )
            if chapterIndex != self.activeNowPlayingChapterIndex {
                self.updateNowPlayingInfo()
            }
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
            if self.sleepAtChapterEnd {
                if endedIndex >= self.queuedItems.count - 1 {
                    self.sleepAtChapterEnd = false
                } else if self.chapterStartsWithQueuedTrack(at: endedIndex + 1) {
                    self.finishSleepTimer()
                }
            }
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
                    self.emit("state", data: finalState)
                    self.emit("ended", data: finalState)
                } else {
                    self.finishedWhileInactive = true
                }
                self.monitor?.audiobookPlayerDidFinishPlayback(self)
            }
        }
    }

    private func activateQueuedTrack(at index: Int) {
        guard queuedTracks.indices.contains(index) else { return }
        if index > 0 {
            packetAudio?.cancel()
            packetAudio = nil
        }
        let track = queuedTracks[index]
        activeQueueIndex = index
        if queuedItems.indices.contains(index) {
            let item = queuedItems[index]
            applyBoost(to: item, gain: boostGain)
            durationObservation?.invalidate()
            let loadGeneration = generation
            durationObservation = item.observe(\.duration, options: [.new]) { [weak self, weak item] _, _ in
                DispatchQueue.main.async {
                    guard let self, let item, self.generation == loadGeneration,
                          self.player?.currentItem === item else { return }
                    self.updateNowPlayingInfo()
                    self.emitState()
                }
            }
            if index > 0 {
                item.asset.loadValuesAsynchronously(forKeys: ["duration"]) {}
            }
        }
        pendingPosition = 0
        lastKnownPosition = 0
        sleepChapterLastPosition = nil
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
        emit("trackChanged", data: [
            "clipPreview": isClipPreview,
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
            guard let self, self.player != nil else { return .commandFailed }
            self.play()
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
                self.play()
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
            self.performSeek(to: position, intentional: true)
            return .success
        })
    }

    private func seekFromRemote(by offset: Double) {
        guard let player else { return }
        let duration = finiteSeconds(player.currentItem?.duration ?? .invalid)
        let position = stablePlayerPosition()
        let target = max(0, duration > 0 ? min(duration, position + offset) : position + offset)
        performSeek(to: target, intentional: true)
    }

    private func emitRemoteIntentionalSeek() {
        guard pendingRemoteIntentionalSeek, let player else { return }
        pendingRemoteIntentionalSeek = false
        emit("intentionalSeek", data: [
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
        mediaServicesResetObserver = center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] _ in
            self?.handleMediaServicesReset()
        }
        willEnterForegroundObserver = center.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.emitForegroundClockEarly()
        }
        becameActiveObserver = center.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            if self.sleepTimerFinishedWhileInactive {
                self.sleepTimerFinishedWhileInactive = false
                self.emit("sleepTimerEnded", data: [:])
            }
            self.emitRemoteIntentionalSeek()
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
                self.emit("state", data: finalState)
                self.emit("ended", data: finalState)
            } else {
                self.persistCheckpoint(force: true)
                self.emitTrackChanged()
                self.emitState()
            }
            if let pendingError = self.pendingErrorWhileInactive {
                self.pendingErrorWhileInactive = nil
                self.emit("error", data: ["message": pendingError])
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

    private func emitForegroundClockEarly() {
        guard
            player != nil,
            !finishedWhileInactive,
            !sleepTimerFinishedWhileInactive,
            !pendingRemoteIntentionalSeek,
            !(wasPlayingBeforeInterruption && shouldAutoplay)
        else { return }
        emitTrackChanged()
        emitState()
    }

    private func handleAudioInterruption(_ notification: Notification) {
        guard
            let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: rawType)
        else { return }

        switch type {
        case .began:
            let rawReason = notification.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt
            NSLog("Audio interruption began (reason %@)", rawReason.map(String.init) ?? "unknown")
            if #available(iOS 17.0, *),
               rawReason == AVAudioSession.InterruptionReason.routeDisconnected.rawValue {
                pauseForLostRoute()
                return
            }
            interruptionIsActive = true
            interruptionSerial += 1
            interruptionEndedWhileInactiveAt = nil
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
            NSLog(
                "Audio interruption ended (should resume: %@, was playing: %@)",
                options.contains(.shouldResume) ? "yes" : "no",
                wasPlayingBeforeInterruption && shouldAutoplay ? "yes" : "no"
            )
            if wasPlayingBeforeInterruption && shouldAutoplay && options.contains(.shouldResume) {
                resumeAfterInterruption()
            } else {
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
            player != nil
        else { return }

        NSLog("Audio route changed (reason %lu)", rawReason)
        switch reason {
        case .oldDeviceUnavailable:
            pauseForLostRoute()
        case .newDeviceAvailable:
            if shouldAutoplay {
                if interruptionIsActive {
                    activateAudioSession { [weak self] activated in
                        guard let self, activated, self.shouldAutoplay else { return }
                        self.interruptionIsActive = false
                        self.resumeAfterInterruption()
                    }
                } else {
                    resumeAfterInterruption()
                }
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

    @discardableResult private func retryWithoutPacketAudio() -> Bool {
        guard packetAudio != nil, let item = queuedItems.first else { return false }
        return retryInitialItem(item)
    }

    @discardableResult func retryInitialItem(_ item: AVPlayerItem) -> Bool {
        precondition(Thread.isMainThread)
        guard let player, activeQueueIndex == 0, queuedItems.first === item,
              let track = queuedTracks.first else { return false }
        let position = stablePosition(item.currentTime())
        let request = AudiobookLoadRequest(
            url: track.url, positionSeconds: position,
            rate: Double(desiredRate), volume: Double(player.volume), gain: Double(boostGain),
            autoplay: shouldAutoplay, recoveryScopeKey: recoveryScopeKey,
            recoveryTrackId: recoveryTrackId, recoveryBookOffsetSeconds: recoveryBookOffset,
            queue: queuedTracks, keepsPendingIntentionalSeek: true, clipPreview: isClipPreview)
        pendingPosition = position
        lastKnownPosition = position
        initialSeekComplete = false
        packetAudio?.cancel()
        self.packetAudio = nil
        generation += 1
        load(request, allowsPacketAudio: false)
        return true
    }

    private func handleMediaServicesReset() {
        guard let player, !finishedWhileInactive else { return }
        if let item = player.currentItem,
           let index = queuedItems.firstIndex(where: { $0 === item }),
           index != activeQueueIndex {
            activateQueuedTrack(at: index)
            initialSeekComplete = true
            positionEstablished = true
            pendingRemoteIntentionalSeek = false
            if UIApplication.shared.applicationState == .active { emitTrackChanged() }
        }
        guard queuedTracks.indices.contains(activeQueueIndex) else { return }
        NSLog("Audio services were reset; rebuilding the player")
        let remaining = Array(queuedTracks[activeQueueIndex...])
        load(AudiobookLoadRequest(
            url: remaining[0].url,
            positionSeconds: stablePlayerPosition(),
            rate: Double(desiredRate),
            volume: Double(player.volume),
            gain: Double(boostGain),
            autoplay: shouldAutoplay,
            recoveryScopeKey: recoveryScopeKey,
            recoveryTrackId: recoveryTrackId,
            recoveryBookOffsetSeconds: recoveryBookOffset,
            queue: remaining,
            keepsPendingIntentionalSeek: true,
            clipPreview: isClipPreview
        ))
    }

    private func pauseForLostRoute() {
        guard let player else { return }
        shouldAutoplay = false
        wasPlayingBeforeInterruption = false
        interruptionIsActive = false
        pendingPosition = stablePlayerPosition()
        lastKnownPosition = pendingPosition
        player.pause()
        persistCheckpoint(force: true, positionSeconds: pendingPosition)
        updateNowPlayingInfo()
        if UIApplication.shared.applicationState == .active { emitState() }
    }

    private func interruptionResumeIsFresh() -> Bool {
        guard let endedAt = interruptionEndedWhileInactiveAt else { return true }
        return Date.timeIntervalSinceReferenceDate - endedAt <= Self.interruptionResumeGraceSeconds
    }

    private func resumeAfterInterruption() {
        guard !interruptionIsActive, let player else { return }
        wasPlayingBeforeInterruption = false
        interruptionEndedWhileInactiveAt = nil
        guard initialSeekComplete else { return }
        interruptionResumeSerial += 1
        let resume = interruptionResumeSerial
        if interruptionResumeTask == .invalid {
            interruptionResumeTask = UIApplication.shared.beginBackgroundTask(
                withName: "Resume after interruption"
            ) { [weak self] in
                self?.interruptionResumeSerial += 1
                self?.endInterruptionResumeTask()
            }
        }
        let deadline = Date.timeIntervalSinceReferenceDate + Self.interruptionResumeWindowSeconds
        attemptResumeAfterInterruption(player, resume: resume, deadline: deadline, retry: 0)
    }

    private func attemptResumeAfterInterruption(
        _ player: AVPlayer,
        resume: Int,
        deadline: TimeInterval,
        retry: Int
    ) {
        guard Date.timeIntervalSinceReferenceDate <= deadline else {
            finishResumeAfterInterruption(givingUp: true)
            return
        }
        let interruption = interruptionSerial
        activateAudioSession(reportingFailure: false) { [weak self] activated in
            guard let self, player === self.player, resume == self.interruptionResumeSerial else { return }
            let wanted = self.shouldAutoplay && !self.interruptionIsActive
            let expired = Date.timeIntervalSinceReferenceDate > deadline
            var givingUp = false
            if activated && wanted && !expired {
                player.playImmediately(atRate: self.desiredRate)
            } else if wanted && interruption == self.interruptionSerial {
                if !expired && retry < Self.interruptionResumeRetryDelays.count {
                    let delay = Self.interruptionResumeRetryDelays[retry]
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                        guard let self, player === self.player,
                              resume == self.interruptionResumeSerial else { return }
                        guard self.shouldAutoplay, !self.interruptionIsActive else {
                            self.endInterruptionResumeTask()
                            return
                        }
                        self.attemptResumeAfterInterruption(
                            player,
                            resume: resume,
                            deadline: deadline,
                            retry: retry + 1
                        )
                    }
                    return
                }
                givingUp = true
            }
            self.finishResumeAfterInterruption(givingUp: givingUp)
        }
    }

    private func finishResumeAfterInterruption(givingUp: Bool) {
        if givingUp {
            NSLog("Audio session stayed unavailable after an interruption; leaving playback paused")
            shouldAutoplay = false
        }
        endInterruptionResumeTask()
        persistCheckpoint(force: true)
        updateNowPlayingInfo()
        if UIApplication.shared.applicationState == .active { emitState() }
    }

    private func endInterruptionResumeTask() {
        guard interruptionResumeTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(interruptionResumeTask)
        interruptionResumeTask = .invalid
    }

    private func activateAudioSession(
        reportingFailure: Bool = true,
        then completion: @escaping (Bool) -> Void
    ) {
        let requestGeneration = generation
        let requestInterruption = interruptionSerial
        let interruptedAtRequest = interruptionIsActive
        sessionQueue.async { [weak self] in
            var failure: Error?
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playback, mode: .spokenAudio)
                try session.setActive(true)
            } catch {
                failure = error
            }
            DispatchQueue.main.async {
                guard let self, requestGeneration == self.generation else { return }
                let overtaken = requestInterruption != self.interruptionSerial
                guard let failure else {
                    completion(!overtaken)
                    return
                }
                if !reportingFailure || interruptedAtRequest || overtaken || self.interruptionIsActive {
                    NSLog("Audio session activation deferred during an interruption: %@", failure.localizedDescription)
                } else {
                    self.emitError("Unable to activate background audio: \(failure.localizedDescription)")
                }
                completion(false)
            }
        }
    }

    private func deactivateAudioSession() {
        sessionQueue.async {
            do {
                try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            } catch {
                NSLog("Unable to deactivate the audio session: %@", error.localizedDescription)
            }
        }
    }

    private func persistCheckpoint(
        force: Bool,
        positionSeconds: Double? = nil,
        durationSeconds: Double? = nil
    ) {
        guard
            !isClipPreview,
            player != nil,
            let scopeKey = recoveryScopeKey,
            let trackId = recoveryTrackId
        else { return }
        let now = Date().timeIntervalSince1970 * 1000
        if !force && now - lastCheckpointWrite < 2_000 { return }
        let position = positionSeconds ?? stablePlayerPosition()
        lastKnownPosition = position
        let item = queuedItems.indices.contains(activeQueueIndex) ? queuedItems[activeQueueIndex] : nil
        let duration = durationSeconds ?? finiteSeconds(item?.duration ?? .invalid)
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
        monitor?.audiobookPlayer(self, didPersist: checkpoint)
    }

    func loadCheckpoint() -> NativeAudioCheckpoint? {
        guard let data = UserDefaults.standard.data(forKey: checkpointKey) else { return nil }
        return try? JSONDecoder().decode(NativeAudioCheckpoint.self, from: data)
    }

    private func updateNowPlayingInfo() {
        guard let player, let item = player.currentItem else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            monitor?.audiobookPlayerDidChangePlaybackState(self)
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
        monitor?.audiobookPlayerDidChangePlaybackState(self)
    }

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
        guard let source, let url = resolveNativeAudioSourceURL(source) else { return }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard
                let data = fetchArtworkData(from: url),
                let original = UIImage(data: data)
            else { return }
            let image = downscaledArtwork(original, maximumSide: 1024)
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
        emit("state", data: stateData(
            positionSeconds: position,
            durationSeconds: duration,
            isPlaying: player.timeControlStatus == .playing
        ))
    }

    private func stateData(positionSeconds: Double, durationSeconds: Double, isPlaying: Bool) -> [String: Any] {
        var data: [String: Any] = [
            "positionSeconds": positionSeconds,
            "durationSeconds": durationSeconds,
            "isPlaying": isPlaying,
            "readyToPlay": initialSeekComplete && player?.currentItem?.status == .readyToPlay,
            "positionReady": initialSeekComplete,
            "clipPreview": isClipPreview
        ]
        if let trackId = recoveryTrackId {
            data["trackId"] = trackId
        }
        return data
    }

    private func emitError(_ message: String) {
        monitor?.audiobookPlayer(self, didFail: message)
        if UIApplication.shared.applicationState == .background {
            pendingErrorWhileInactive = message
        } else {
            emit("error", data: ["message": message])
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
        finishSleepTimer()
    }

    private func updateChapterSleep() {
        guard sleepAtChapterEnd, initialSeekComplete, let player,
              player.timeControlStatus == .playing else {
            sleepChapterLastPosition = nil
            return
        }
        let position = finiteSeconds(player.currentTime())
        let previous = sleepChapterLastPosition
        sleepChapterLastPosition = position
        guard let previous, position >= previous,
              position - previous <= Self.sleepChapterStepSeconds,
              sleepChapterIndex(at: previous) != sleepChapterIndex(at: position)
        else { return }
        finishSleepTimer()
    }

    private func sleepChapterIndex(at position: Double) -> Int? {
        nowPlayingChapters.lastIndex { position >= $0.startSeconds }
    }

    private func chapterStartsWithQueuedTrack(at index: Int) -> Bool {
        guard queuedTracks.indices.contains(index) else { return true }
        return queuedTracks[index].chapters.contains {
            $0.startSeconds <= Self.sleepChapterFileStartSeconds
        }
    }

    private func finishSleepTimer() {
        sleepTimerRemaining = 0
        sleepTimerLastTick = nil
        sleepAtChapterEnd = false
        sleepChapterLastPosition = nil
        shouldAutoplay = false
        player?.pause()
        persistCheckpoint(force: true)
        if UIApplication.shared.applicationState == .active {
            emit("sleepTimerEnded", data: [:])
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
        packetAudio?.cancel()
        packetAudio = nil
        persistCheckpoint(
            force: true,
            positionSeconds: finishedPositionSeconds,
            durationSeconds: finishedDurationSeconds
        )
        statusObservation?.invalidate()
        statusObservation = nil
        durationObservation?.invalidate()
        durationObservation = nil
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
        interruptionResumeSerial += 1
        endInterruptionResumeTask()
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

    private func finiteSeconds(_ time: CMTime) -> Double {
        validSeconds(time) ?? 0
    }

    private func validSeconds(_ time: CMTime) -> Double? {
        let value = CMTimeGetSeconds(time)
        return value.isFinite && value >= 0 ? value : nil
    }

    private func stablePlayerPosition() -> Double {
        stablePosition(player?.currentTime() ?? .invalid)
    }

    private func stablePosition(_ time: CMTime) -> Double {
        if !initialSeekComplete { return pendingPosition }
        guard let current = validSeconds(time) else {
            return lastKnownPosition
        }
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

    private func clampedGain(_ value: Double) -> Float {
        guard value.isFinite else { return 1 }
        return Float(min(16, max(0.5, value)))
    }
}

func fetchArtworkData(from url: URL, timeout: TimeInterval = 20) -> Data? {
    if url.isFileURL { return try? Data(contentsOf: url) }
    var request = URLRequest(url: url)
    request.timeoutInterval = timeout
    let finished = DispatchSemaphore(value: 0)
    var result: Data?
    let task = URLSession.shared.dataTask(with: request) { data, response, _ in
        if let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) {
            result = data
        }
        finished.signal()
    }
    task.resume()
    if finished.wait(timeout: .now() + timeout) == .timedOut {
        task.cancel()
        return nil
    }
    return result
}

func downscaledArtwork(_ image: UIImage, maximumSide: CGFloat) -> UIImage {
    let longest = max(image.size.width, image.size.height)
    guard longest > maximumSide else { return image }
    let scale = maximumSide / longest
    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    return UIGraphicsImageRenderer(size: size, format: format).image { _ in
        image.draw(in: CGRect(origin: .zero, size: size))
    }
}

func resolveNativeAudioSourceURL(_ source: String) -> URL? {
    guard let url = URL(string: source) else { return nil }
    guard url.scheme == "capacitor" else { return url }
    if url.host == "localhost", url.path.hasPrefix("/demo/"),
       let resources = Bundle.main.resourceURL {
        let demoRoot = resources.appendingPathComponent("public/demo", isDirectory: true)
        let bundled = demoRoot.appendingPathComponent(String(url.path.dropFirst("/demo/".count))).standardizedFileURL
        guard bundled.path.hasPrefix(demoRoot.path + "/"),
              FileManager.default.fileExists(atPath: bundled.path) else { return nil }
        return bundled
    }
    let marker = "/_capacitor_file_"
    guard url.path.hasPrefix(marker) else { return nil }
    let filePath = String(url.path.dropFirst(marker.count)).removingPercentEncoding
        ?? String(url.path.dropFirst(marker.count))
    return URL(fileURLWithPath: filePath)
}
