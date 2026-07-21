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
        CAPPluginMethod(name: "setNowPlaying", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getRecoveryState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private var player: AVPlayer?
    private var statusObservation: NSKeyValueObservation?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var stalledObserver: NSObjectProtocol?
    private var interruptionObserver: NSObjectProtocol?
    private var becameActiveObserver: NSObjectProtocol?
    private var enteredBackgroundObserver: NSObjectProtocol?
    private var desiredRate: Float = 1
    private var pendingPosition: Double = 0
    private var shouldAutoplay = false
    private var wasPlayingBeforeInterruption = false
    private var interruptionIsActive = false
    private var generation = 0
    private var remoteCommandTargets: [Any] = []
    private var nowPlayingTitle = "OperaLibre"
    private var nowPlayingArtist = "Audiobook"
    private var nowPlayingAlbum = ""
    private var nowPlayingArtwork: MPMediaItemArtwork?
    private var artworkGeneration = 0
    private let checkpointKey = "operalibre.native-audio-checkpoint.v1"
    private var recoveryScopeKey: String?
    private var recoveryTrackId: String?
    private var recoveryBookOffset: Double = 0
    private var lastCheckpointWrite = 0.0

    deinit {
        tearDownPlayer()
        for observer in [interruptionObserver, becameActiveObserver, enteredBackgroundObserver] {
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
        let autoplay = call.getBool("autoplay") ?? false
        let scopeKey = call.getString("recoveryScopeKey")
        let trackId = call.getString("recoveryTrackId")
        let bookOffset = max(0, call.getDouble("recoveryBookOffsetSeconds") ?? 0)

        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("The native audio player is unavailable.")
                return
            }

            self.tearDownPlayer()
            self.generation += 1
            let loadGeneration = self.generation
            self.desiredRate = rate
            self.pendingPosition = position
            self.shouldAutoplay = autoplay
            self.recoveryScopeKey = scopeKey
            self.recoveryTrackId = trackId
            self.recoveryBookOffset = bookOffset
            self.lastCheckpointWrite = 0
            self.installSessionObserversIfNeeded()

            let item = AVPlayerItem(url: url)
            // Apple's time-domain algorithm is designed for spoken audio and
            // preserves pitch continuously throughout OperaLibre's 0.75–2x range.
            item.audioTimePitchAlgorithm = .timeDomain

            let player = AVPlayer(playerItem: item)
            player.automaticallyWaitsToMinimizeStalling = true
            player.preventsDisplaySleepDuringVideoPlayback = false
            player.volume = volume
            self.player = player
            self.configureRemoteCommandsIfNeeded()
            self.installObservers(player: player, item: item, generation: loadGeneration)
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
                call.resolve()
                return
            }
            self.shouldAutoplay = true
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

        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.resolve()
                return
            }
            self.nowPlayingTitle = title
            self.nowPlayingArtist = artist
            self.nowPlayingAlbum = album
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
        DispatchQueue.main.async { [weak self] in
            self?.generation += 1
            self?.tearDownPlayer()
            call.resolve()
        }
    }

    private func installObservers(player: AVPlayer, item: AVPlayerItem, generation: Int) {
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

        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.25, preferredTimescale: 600),
            queue: .main
        ) { [weak self] _ in
            guard let self, generation == self.generation else { return }
            self.persistCheckpoint(force: false)
            // Once WKWebView is suspended, crossing the Capacitor bridge on
            // every timer tick can starve AVPlayer's time-pitch processing.
            // The native player and Now Playing center keep their own clocks.
            if UIApplication.shared.applicationState == .active {
                self.emitState()
            }
        }

        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] _ in
            guard let self, generation == self.generation else { return }
            self.shouldAutoplay = false
            self.updateNowPlayingInfo()
            if UIApplication.shared.applicationState == .active {
                self.emitState()
                self.notifyListeners("ended", data: [:])
            }
        }

        stalledObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemPlaybackStalled,
            object: item,
            queue: .main
        ) { [weak self] _ in
            guard let self, generation == self.generation else { return }
            if UIApplication.shared.applicationState == .active {
                self.notifyListeners("stalled", data: [:])
            }
        }
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
            let position = max(0, positionEvent.positionTime)
            self.pendingPosition = position
            player.seek(to: CMTime(seconds: position, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
                self?.persistCheckpoint(force: true)
                self?.updateNowPlayingInfo()
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
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            self?.persistCheckpoint(force: true)
            self?.updateNowPlayingInfo()
        }
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
        becameActiveObserver = center.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            // Some short notification interruptions do not deliver their end
            // callback until the app is active again. Resume the exact native
            // clock if playback was running before that interruption.
            if self.wasPlayingBeforeInterruption && self.shouldAutoplay {
                self.interruptionIsActive = false
                self.resumeAfterInterruption()
            }
            self.persistCheckpoint(force: true)
            self.emitState()
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
            // iOS may have already changed AVPlayer to paused by the time this
            // notification is delivered. The retained play intent is the
            // reliable signal that playback should continue afterward.
            wasPlayingBeforeInterruption = shouldAutoplay
            pendingPosition = finiteSeconds(player?.currentTime() ?? .invalid)
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
                wasPlayingBeforeInterruption = false
                persistCheckpoint(force: true)
                updateNowPlayingInfo()
                if UIApplication.shared.applicationState == .active { emitState() }
            }
        @unknown default:
            break
        }
    }

    private func resumeAfterInterruption() {
        guard !interruptionIsActive, let player else { return }
        wasPlayingBeforeInterruption = false
        activateAudioSession()
        player.playImmediately(atRate: desiredRate)
        persistCheckpoint(force: true)
        updateNowPlayingInfo()
        if UIApplication.shared.applicationState == .active { emitState() }
    }

    private func activateAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio)
            try session.setActive(true)
        } catch {
            emitError("Unable to activate background audio: \(error.localizedDescription)")
        }
    }

    private func persistCheckpoint(force: Bool) {
        guard
            let player,
            let scopeKey = recoveryScopeKey,
            let trackId = recoveryTrackId
        else { return }
        let now = Date().timeIntervalSince1970 * 1000
        if !force && now - lastCheckpointWrite < 2_000 { return }
        let position = finiteSeconds(player.currentTime())
        let duration = finiteSeconds(player.currentItem?.duration ?? .invalid)
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
        let duration = finiteSeconds(item.duration)
        let position = finiteSeconds(player.currentTime())
        let isPlaying = player.timeControlStatus == .playing
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: nowPlayingTitle,
            MPMediaItemPropertyArtist: nowPlayingArtist,
            MPMediaItemPropertyAlbumTitle: nowPlayingAlbum,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? Double(desiredRate) : 0,
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
        notifyListeners("state", data: [
            "positionSeconds": position,
            "durationSeconds": duration,
            "isPlaying": player.timeControlStatus == .playing
        ])
    }

    private func emitError(_ message: String) {
        notifyListeners("error", data: ["message": message])
    }

    private func tearDownPlayer() {
        persistCheckpoint(force: true)
        statusObservation?.invalidate()
        statusObservation = nil
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
        player?.pause()
        player?.replaceCurrentItem(with: nil)
        player = nil
        shouldAutoplay = false
        wasPlayingBeforeInterruption = false
        interruptionIsActive = false
        recoveryScopeKey = nil
        recoveryTrackId = nil
        recoveryBookOffset = 0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    private func resolveSourceURL(_ source: String) -> URL? {
        guard let url = URL(string: source) else { return nil }
        guard url.scheme == "capacitor" else { return url }
        let marker = "/_capacitor_file_"
        guard url.path.hasPrefix(marker) else { return nil }
        let filePath = String(url.path.dropFirst(marker.count)).removingPercentEncoding
            ?? String(url.path.dropFirst(marker.count))
        return URL(fileURLWithPath: filePath)
    }

    private func finiteSeconds(_ time: CMTime) -> Double {
        let value = CMTimeGetSeconds(time)
        return value.isFinite && value >= 0 ? value : 0
    }

    private func clampedRate(_ value: Double) -> Float {
        Float(min(2, max(0.5, value)))
    }

    private func clampedVolume(_ value: Double) -> Float {
        Float(min(1, max(0, value)))
    }
}
