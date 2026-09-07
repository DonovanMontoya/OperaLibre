import Capacitor
import Foundation

/// The web layer's door onto `AudiobookPlayer`.
///
/// All of the playback behavior lives in the engine, which outlives any one
/// WebView and is shared with the CarPlay scene. This plugin only translates
/// between Capacitor calls and the engine's Swift API, and relays the engine's
/// events to JS.
@objc(NativeAudioPlugin)
public final class NativeAudioPlugin: CAPPlugin, CAPBridgedPlugin, AudiobookPlayerObserver {
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

    private var engine: AudiobookPlayer { AudiobookPlayer.shared }

    override public func load() {
        engine.observer = self
    }

    @objc public func load(_ call: CAPPluginCall) {
        guard let source = call.getString("url"), let url = resolveNativeAudioSourceURL(source) else {
            call.reject("The audio URL is invalid.")
            return
        }
        // Loading is how the web player claims the engine. If a car session was
        // running, its position is banked before this load replaces the player
        // it lives in.
        CarPlayCoordinator.shared.webLayerDidTakeOver()
        engine.load(AudiobookLoadRequest(
            url: url,
            positionSeconds: call.getDouble("positionSeconds") ?? 0,
            rate: call.getDouble("rate") ?? 1,
            volume: call.getDouble("volume") ?? 1,
            gain: call.getDouble("gain") ?? 1,
            autoplay: call.getBool("autoplay") ?? false,
            recoveryScopeKey: call.getString("recoveryScopeKey"),
            recoveryTrackId: call.getString("recoveryTrackId"),
            recoveryBookOffsetSeconds: call.getDouble("recoveryBookOffsetSeconds") ?? 0,
            queue: queuedTracks(from: call.getArray("queue", JSObject.self) ?? [])
        ))
        call.resolve()
    }

    @objc public func play(_ call: CAPPluginCall) {
        engine.play()
        call.resolve()
    }

    @objc public func pause(_ call: CAPPluginCall) {
        engine.pause()
        call.resolve()
    }

    @objc public func setSleepTimer(_ call: CAPPluginCall) {
        engine.setSleepTimer(seconds: call.getDouble("seconds") ?? 0)
        call.resolve()
    }

    @objc public func getSleepTimer(_ call: CAPPluginCall) {
        engine.sleepTimerRemainingSeconds { remaining in
            call.resolve(["remainingSeconds": remaining])
        }
    }

    @objc public func seek(_ call: CAPPluginCall) {
        engine.seek(toPositionSeconds: call.getDouble("positionSeconds") ?? 0)
        call.resolve()
    }

    @objc public func setRate(_ call: CAPPluginCall) {
        engine.setRate(call.getDouble("rate") ?? 1)
        call.resolve()
    }

    @objc public func setNowPlaying(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? "OperaLibre"
        engine.setNowPlaying(AudiobookNowPlayingRequest(
            title: title,
            artist: call.getString("artist") ?? "Audiobook",
            album: call.getString("album") ?? "",
            artworkSource: call.getString("artworkUrl"),
            chapterStartSeconds: call.getDouble("chapterStartSeconds"),
            chapterDurationSeconds: call.getDouble("chapterDurationSeconds"),
            chapters: nowPlayingChapters(from: call.getArray("chapters", JSObject.self) ?? [])
        ))
        call.resolve()
    }

    @objc public func setVolume(_ call: CAPPluginCall) {
        engine.setVolume(call.getDouble("volume") ?? 1)
        call.resolve()
    }

    @objc public func setGain(_ call: CAPPluginCall) {
        engine.setGain(call.getDouble("gain") ?? 1)
        call.resolve()
    }

    @objc public func getRecoveryState(_ call: CAPPluginCall) {
        guard
            let requestedScope = call.getString("scopeKey"),
            let checkpoint = engine.recoveryState(forScope: requestedScope)
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
        engine.stop(releaseSession: call.getBool("releaseSession") ?? true)
        call.resolve()
    }

    // MARK: - AudiobookPlayerObserver

    func audiobookPlayer(_ player: AudiobookPlayer, didEmit event: String, data: [String: Any]) {
        notifyListeners(event, data: jsObject(from: data))
    }

    // MARK: - Conversions

    private func queuedTracks(from entries: [JSObject]) -> [NativeAudioQueuedTrack] {
        entries.compactMap { entry -> NativeAudioQueuedTrack? in
            guard
                let source = entry["url"] as? String,
                let queueURL = resolveNativeAudioSourceURL(source),
                let queueTrackId = entry["trackId"] as? String,
                !queueTrackId.isEmpty
            else { return nil }
            return NativeAudioQueuedTrack(
                url: queueURL,
                trackId: queueTrackId,
                bookOffsetSeconds: max(0, jsDouble(entry["bookOffsetSeconds"]) ?? 0),
                title: entry["title"] as? String ?? "OperaLibre",
                artist: entry["artist"] as? String ?? "Audiobook",
                album: entry["album"] as? String ?? "",
                chapters: nowPlayingChapters(from: (entry["chapters"] as? [JSObject]) ?? [])
                    .sorted { $0.startSeconds < $1.startSeconds }
            )
        }
    }

    private func nowPlayingChapters(from entries: [JSObject]) -> [NativeNowPlayingChapter] {
        entries.compactMap { chapter -> NativeNowPlayingChapter? in
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
    }

    /// The engine speaks plain Swift values; the bridge only carries the
    /// strings, numbers and booleans its event payloads are made of.
    private func jsObject(from data: [String: Any]) -> JSObject {
        var object = JSObject()
        for (key, value) in data {
            if let value = value as? String {
                object[key] = value
            } else if let value = value as? Bool {
                object[key] = value
            } else if let value = jsDouble(value) {
                object[key] = value
            }
        }
        return object
    }
}

private func jsDouble(_ value: Any?) -> Double? {
    if let value = value as? Double { return value }
    if let value = value as? NSNumber { return value.doubleValue }
    return nil
}
