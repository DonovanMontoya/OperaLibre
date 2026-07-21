import AVFoundation
import Capacitor
import Foundation
import MediaPlayer
import UIKit

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
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private var player: AVPlayer?
    private var statusObservation: NSKeyValueObservation?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var stalledObserver: NSObjectProtocol?
    private var desiredRate: Float = 1
    private var pendingPosition: Double = 0
    private var shouldAutoplay = false
    private var generation = 0
    private var remoteCommandTargets: [Any] = []
    private var nowPlayingTitle = "OperaLibre"
    private var nowPlayingArtist = "Audiobook"
    private var nowPlayingAlbum = ""
    private var nowPlayingArtwork: MPMediaItemArtwork?
    private var artworkGeneration = 0

    deinit {
        tearDownPlayer()
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
                self.updateNowPlayingInfo()
            }
            call.resolve()
        }
    }

    @objc public func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.shouldAutoplay = false
            self?.player?.pause()
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
                guard let self, self.shouldAutoplay, player.timeControlStatus != .playing else { return }
                player.playImmediately(atRate: self.desiredRate)
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
            self.updateNowPlayingInfo()
            return .success
        })
        remoteCommandTargets.append(commands.pauseCommand.addTarget { [weak self] _ in
            guard let self, let player = self.player else { return .commandFailed }
            self.shouldAutoplay = false
            player.pause()
            self.updateNowPlayingInfo()
            return .success
        })
        remoteCommandTargets.append(commands.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self, let player = self.player else { return .commandFailed }
            if player.timeControlStatus == .playing {
                self.shouldAutoplay = false
                player.pause()
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
            self?.updateNowPlayingInfo()
        }
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
