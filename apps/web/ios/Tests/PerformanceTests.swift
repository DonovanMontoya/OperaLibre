import XCTest
import AVFoundation
import Capacitor
import MediaPlayer
import UIKit

/// Compiled alongside the actual plugin sources in an isolated simulator test bundle.
/// These tests never install over the user's OperaLibre app or touch its sandbox.
final class PerformanceTests: XCTestCase {
    private func call(_ method: (CAPPluginCall) -> Void, name: String, options: [String: Any] = [:]) {
        let done = expectation(description: name)
        let call = CAPPluginCall(callbackId: "performance", methodName: name, options: options,
            success: { _, _ in done.fulfill() }, error: { error in
                XCTFail("\(name): \(String(describing: error))")
                done.fulfill()
            })!
        method(call)
        wait(for: [done], timeout: 10)
    }

    @MainActor
    private func waitForArtwork(title: String, expectedWidth: CGFloat? = nil) {
        func ready() -> Bool {
            let info = MPNowPlayingInfoCenter.default().nowPlayingInfo
            let artwork = info?[MPMediaItemPropertyArtwork] as? MPMediaItemArtwork
            return info?[MPMediaItemPropertyTitle] as? String == title && artwork != nil
                && (expectedWidth == nil || artwork?.bounds.width == expectedWidth)
        }
        if ready() { return }
        let done = expectation(description: "artwork available")
        // Predicate expectations poll once per second, swamping this measurement.
        // A 5 ms readiness poll includes completion with a documented timing floor.
        let timer = Timer.scheduledTimer(withTimeInterval: 0.005, repeats: true) { timer in
            MainActor.assumeIsolated {
                if ready() { timer.invalidate(); done.fulfill() }
            }
        }
        defer { timer.invalidate() }
        wait(for: [done], timeout: 10)
    }

    @MainActor
    func testChapterMetadataAndArtworkPerformance() throws {
        let plugin = NativeAudioPlugin()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let audio = directory.appendingPathComponent("fixture.wav")
        // Valid 10-second mono PCM. AVPlayer, not a fake clock, loads it.
        var wav = Data()
        func u16(_ value: UInt16) { var v = value.littleEndian; withUnsafeBytes(of: &v) { wav.append(contentsOf: $0) } }
        func u32(_ value: UInt32) { var v = value.littleEndian; withUnsafeBytes(of: &v) { wav.append(contentsOf: $0) } }
        wav.append(Data("RIFF".utf8)); u32(160_036); wav.append(Data("WAVEfmt ".utf8)); u32(16)
        u16(1); u16(1); u32(8000); u32(16000); u16(2); u16(16)
        wav.append(Data("data".utf8)); u32(160_000); wav.append(Data(repeating: 0, count: 160_000))
        try wav.write(to: audio)
        let cover = directory.appendingPathComponent("cover.png")
        let image = UIGraphicsImageRenderer(size: CGSize(width: 1024, height: 1024)).image { context in
            UIColor.blue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))
        }
        try XCTUnwrap(image.pngData()).write(to: cover)
        call(plugin.load, name: "load", options: ["url": audio.absoluteString, "autoplay": false,
            "recoveryScopeKey": "performance", "recoveryTrackId": "fixture"])
        defer { call(plugin.stop, name: "stop") }
        let options: [String: Any] = ["title": "Chapter", "artist": "Fixture", "album": "Performance",
            "artworkUrl": cover.absoluteString, "chapterStartSeconds": 0, "chapterDurationSeconds": 10]
        call(plugin.setNowPlaying, name: "setNowPlaying", options: options)
        waitForArtwork(title: "Chapter")
        let measureOptions = XCTMeasureOptions(); measureOptions.iterationCount = 5
        measure(metrics: [XCTClockMetric(), XCTCPUMetric(), XCTMemoryMetric()], options: measureOptions) {
            for index in 0..<10 {
                var chapter = options; chapter["title"] = "Chapter \(index)"
                call(plugin.setNowPlaying, name: "setNowPlaying", options: chapter)
                // Include asynchronous artwork completion, not merely bridge dispatch.
                waitForArtwork(title: "Chapter \(index)")
            }
        }
        XCTAssertEqual(MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPMediaItemPropertyAlbumTitle] as? String, "Performance")
        // Reusing a cover across chapter updates must not hide a changed source.
        let replacement = directory.appendingPathComponent("replacement.png")
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let newImage = UIGraphicsImageRenderer(size: CGSize(width: 128, height: 128), format: format).image { context in
            UIColor.red.setFill(); context.fill(CGRect(x: 0, y: 0, width: 128, height: 128))
        }
        try XCTUnwrap(newImage.pngData()).write(to: replacement)
        var changed = options
        changed["title"] = "Changed cover"; changed["artworkUrl"] = replacement.absoluteString
        call(plugin.setNowPlaying, name: "setNowPlaying", options: changed)
        waitForArtwork(title: "Changed cover", expectedWidth: 128)

    }

    @MainActor
    func testStartupResumeControlsAndBookSwitch() throws {
        let engine = AudiobookPlayer()
        let observer = StartupStateObserver()
        engine.observer = observer
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".wav")
        var wav = Data()
        func u16(_ value: UInt16) { var v = value.littleEndian; withUnsafeBytes(of: &v) { wav.append(contentsOf: $0) } }
        func u32(_ value: UInt32) { var v = value.littleEndian; withUnsafeBytes(of: &v) { wav.append(contentsOf: $0) } }
        wav.append(Data("RIFF".utf8)); u32(160_036); wav.append(Data("WAVEfmt ".utf8)); u32(16)
        u16(1); u16(1); u32(8000); u32(16000); u16(2); u16(16)
        wav.append(Data("data".utf8)); u32(160_000); wav.append(Data(repeating: 0, count: 160_000))
        try wav.write(to: url)
        defer { engine.stop(releaseSession: true); try? FileManager.default.removeItem(at: url) }

        func until(_ name: String, _ predicate: @escaping () -> Bool) {
            let done = expectation(description: name)
            let timer = Timer.scheduledTimer(withTimeInterval: 0.01, repeats: true) { timer in
                MainActor.assumeIsolated {
                    if predicate() { timer.invalidate(); done.fulfill() }
                }
            }
            defer { timer.invalidate() }
            wait(for: [done], timeout: 10)
        }
        func load(_ id: String, position: Double, autoplay: Bool) {
            engine.load(AudiobookLoadRequest(url: url, positionSeconds: position, rate: 1.75,
                volume: 0.9, gain: 1, autoplay: autoplay, recoveryScopeKey: "startup-test",
                recoveryTrackId: id, recoveryBookOffsetSeconds: 0, queue: []))
        }
        load("first", position: 3, autoplay: true)
        until("resume and duration ready") {
            engine.status.isPlaying && engine.status.positionSeconds >= 3 && engine.status.durationSeconds != nil
        }
        XCTAssertLessThan(engine.status.positionSeconds, 4)
        XCTAssertEqual(engine.playbackRate, 1.75)
        XCTAssertEqual(engine.status.durationSeconds ?? 0, 10, accuracy: 0.05)
        engine.pause()
        until("pause") { !engine.status.isPlaying }
        engine.seek(toPositionSeconds: 5)
        until("paused seek") { abs(engine.status.positionSeconds - 5) < 0.1 }
        XCTAssertFalse(engine.status.isPlaying)
        observer.ready = false
        engine.seek(toPositionSeconds: 5)
        engine.skip(bySeconds: 1)
        until("superseding remote seek is ready") {
            observer.ready && abs(engine.status.positionSeconds - 6) < 0.1
        }
        XCTAssertFalse(engine.status.isPlaying)
        engine.play()
        until("play again") { engine.status.isPlaying }
        load("second", position: 2, autoplay: true)
        until("switch at selected speed") {
            engine.status.trackId == "second" && engine.status.isPlaying && engine.status.positionSeconds >= 2
        }
        XCTAssertLessThan(engine.status.positionSeconds, 3)
        XCTAssertEqual(engine.playbackRate, 1.75)
        engine.pause()
        until("pause second book") { !engine.status.isPlaying }
        load("third", position: 4, autoplay: false)
        until("paused book loads duration") { engine.status.trackId == "third" && engine.status.durationSeconds != nil }
        XCTAssertFalse(engine.status.isPlaying, "Duration completion must not start a paused book")
        XCTAssertEqual(engine.status.positionSeconds, 4, accuracy: 0.05)
        XCTAssertEqual(engine.playbackRate, 1.75)

        let queue = ["queue-first", "queue-next"].enumerated().map { index, id in
            NativeAudioQueuedTrack(url: url, trackId: id, bookOffsetSeconds: Double(index) * 10,
                title: id, artist: "Fixture", album: "Queue", chapters: [])
        }
        engine.load(AudiobookLoadRequest(url: url, positionSeconds: 9.5, rate: 1.75,
            volume: 0.9, gain: 1.5, autoplay: true, recoveryScopeKey: "queue-test",
            recoveryTrackId: "queue-first", recoveryBookOffsetSeconds: 0, queue: queue))
        until("queue advances with playback settings") {
            engine.status.trackId == "queue-next" && engine.status.isPlaying && observer.ready
        }
        XCTAssertEqual(engine.playbackRate, 1.75)
        XCTAssertEqual(engine.status.title, "queue-next")
        XCTAssertLessThan(engine.status.positionSeconds, 2)
    }

    @MainActor
    func testCancelledRemoteSeekDuringQueueAdvance() throws {
        let queuePlayer = SeekControlledQueuePlayer()
        queuePlayer.holdNextSeek = true
        let engine = AudiobookPlayer(makeQueuePlayer: { items in
            for item in items { queuePlayer.insert(item, after: nil) }
            return queuePlayer
        })
        let observer = StartupStateObserver()
        engine.observer = observer
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".wav")
        var wav = Data()
        func u16(_ value: UInt16) { var v = value.littleEndian; withUnsafeBytes(of: &v) { wav.append(contentsOf: $0) } }
        func u32(_ value: UInt32) { var v = value.littleEndian; withUnsafeBytes(of: &v) { wav.append(contentsOf: $0) } }
        wav.append(Data("RIFF".utf8)); u32(160_036); wav.append(Data("WAVEfmt ".utf8)); u32(16)
        u16(1); u16(1); u32(8000); u32(16000); u16(2); u16(16)
        wav.append(Data("data".utf8)); u32(160_000); wav.append(Data(repeating: 0, count: 160_000))
        try wav.write(to: url)
        defer { engine.stop(releaseSession: true); try? FileManager.default.removeItem(at: url) }

        func until(_ name: String, _ predicate: @escaping () -> Bool) {
            let done = expectation(description: name)
            let timer = Timer.scheduledTimer(withTimeInterval: 0.01, repeats: true) { timer in
                MainActor.assumeIsolated {
                    if predicate() { timer.invalidate(); done.fulfill() }
                }
            }
            defer { timer.invalidate() }
            wait(for: [done], timeout: 10)
        }
        func publishState() {
            NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        }
        let queue = ["cancel-first", "cancel-next"].enumerated().map { index, id in
            NativeAudioQueuedTrack(url: url, trackId: id, bookOffsetSeconds: Double(index) * 10,
                title: id, artist: "Fixture", album: "Queue", chapters: [])
        }
        engine.load(AudiobookLoadRequest(url: url, positionSeconds: 3, rate: 1.75,
            volume: 0.9, gain: 1, autoplay: false, recoveryScopeKey: "cancel-queue-test",
            recoveryTrackId: "cancel-first", recoveryBookOffsetSeconds: 0, queue: queue))
        until("initial resume seek held") { queuePlayer.heldSeek != nil }
        publishState()
        XCTAssertFalse(observer.positionReady, "Initial activation must wait for the resume seek")
        XCTAssertFalse(observer.ready)
        XCTAssertEqual(engine.status.positionSeconds, 3, accuracy: 0.01)
        XCTAssertEqual(CMTimeGetSeconds(queuePlayer.currentTime()), 0, accuracy: 0.01)
        engine.play()
        let playHandled = expectation(description: "play intent handled")
        DispatchQueue.main.async { playHandled.fulfill() }
        wait(for: [playHandled], timeout: 2)
        XCTAssertFalse(engine.status.isPlaying, "Play must not bypass the initial resume seek")
        queuePlayer.releaseHeldSeek()
        until("initial resume completed") {
            publishState()
            return observer.ready && engine.status.isPlaying
        }
        XCTAssertGreaterThanOrEqual(engine.status.positionSeconds, 3)
        engine.pause()
        until("paused before canceled remote seek") { !engine.status.isPlaying }
        let firstItem = try XCTUnwrap(queuePlayer.currentItem)
        queuePlayer.cancelNextSeekByAdvancing = true
        engine.skip(bySeconds: 1)
        until("real queue advance observed") { engine.status.trackId == "cancel-next" }
        XCTAssertFalse(queuePlayer.currentItem === firstItem)
        XCTAssertEqual(queuePlayer.cancelledSeekCount, 1)
        publishState()
        XCTAssertTrue(observer.positionReady, "Queue advance must restore readiness after a canceled seek")
        XCTAssertEqual(observer.intentionalSeekCount, 0, "The old item's remote seek must not reach the new item")
        engine.play()
        until("next item clock progresses") {
            publishState()
            return observer.ready && engine.status.positionSeconds > 0.5
        }
        XCTAssertEqual(engine.playbackRate, 1.75)
        engine.pause()
        until("next item paused") { !engine.status.isPlaying }
        let checkpoint = try XCTUnwrap(engine.recoveryState(forScope: "cancel-queue-test"))
        XCTAssertEqual(checkpoint.trackId, "cancel-next")
        XCTAssertGreaterThan(checkpoint.positionSeconds, 0.5)
        XCTAssertEqual(checkpoint.bookPositionSeconds, 10 + checkpoint.positionSeconds, accuracy: 0.01)
        XCTAssertEqual(checkpoint.positionSeconds, engine.status.positionSeconds, accuracy: 0.1)
        observer.ready = false
        engine.seek(toPositionSeconds: 2)
        until("next item app seek completes") {
            publishState()
            return observer.ready && abs(engine.status.positionSeconds - 2) < 0.1
        }
        XCTAssertEqual(observer.intentionalSeekCount, 0)
    }

    func testInterruptedSeekOnSameItemRestoresReadiness() throws {
        let queuePlayer = SeekControlledQueuePlayer()
        let engine = AudiobookPlayer(makeQueuePlayer: { items in
            for item in items { queuePlayer.insert(item, after: nil) }
            return queuePlayer
        })
        let observer = StartupStateObserver()
        engine.observer = observer
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".wav")
        var wav = Data()
        func u16(_ value: UInt16) { var v = value.littleEndian; withUnsafeBytes(of: &v) { wav.append(contentsOf: $0) } }
        func u32(_ value: UInt32) { var v = value.littleEndian; withUnsafeBytes(of: &v) { wav.append(contentsOf: $0) } }
        wav.append(Data("RIFF".utf8)); u32(160_036); wav.append(Data("WAVEfmt ".utf8)); u32(16)
        u16(1); u16(1); u32(8000); u32(16000); u16(2); u16(16)
        wav.append(Data("data".utf8)); u32(160_000); wav.append(Data(repeating: 0, count: 160_000))
        try wav.write(to: url)
        defer { engine.stop(releaseSession: true); try? FileManager.default.removeItem(at: url) }

        func until(_ name: String, _ predicate: @escaping () -> Bool) {
            let done = expectation(description: name)
            let timer = Timer.scheduledTimer(withTimeInterval: 0.01, repeats: true) { timer in
                MainActor.assumeIsolated {
                    if predicate() { timer.invalidate(); done.fulfill() }
                }
            }
            defer { timer.invalidate() }
            wait(for: [done], timeout: 10)
        }
        func publishState() {
            NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        }
        engine.load(AudiobookLoadRequest(url: url, positionSeconds: 3, rate: 1,
            volume: 0.9, gain: 1, autoplay: false, recoveryScopeKey: "interrupted-seek-test",
            recoveryTrackId: "interrupted", recoveryBookOffsetSeconds: 0, queue: []))
        until("initial resume completed") {
            publishState()
            return observer.ready
        }
        XCTAssertEqual(engine.status.positionSeconds, 3, accuracy: 0.05)

        // A single interruption is retried and still reaches the target.
        queuePlayer.interruptSeeksInPlace = 1
        observer.ready = false
        engine.seek(toPositionSeconds: 6)
        until("retried seek reaches target") {
            publishState()
            return observer.ready && abs(engine.status.positionSeconds - 6) < 0.05
        }
        XCTAssertEqual(queuePlayer.cancelledSeekCount, 1)

        // A seek that never lands follows the audio instead of the unreached target.
        queuePlayer.interruptSeeksInPlace = 3
        observer.ready = false
        engine.seek(toPositionSeconds: 9)
        until("unreached seek restores readiness") {
            publishState()
            return queuePlayer.cancelledSeekCount == 4 && observer.positionReady && observer.ready
        }
        XCTAssertEqual(queuePlayer.cancelledSeekCount, 4)
        XCTAssertEqual(engine.status.positionSeconds, 6, accuracy: 0.05)
        let checkpoint = try XCTUnwrap(engine.recoveryState(forScope: "interrupted-seek-test"))
        XCTAssertEqual(checkpoint.positionSeconds, 6, accuracy: 0.05)
    }

    func testMissingDownloadStatusPerformance() throws {
        let key = "operalibre.background-download-jobs"
        defer { UserDefaults.standard.removeObject(forKey: key) }
        let jobs = Dictionary(uniqueKeysWithValues: (0..<200).map { index in
            ("fixture-\(index)", ["title": "Fixture", "state": "completed", "total": 2,
                "requiredTotal": 2, "completed": 2, "completedRequired": 2,
                "handledTaskIds": [1, 2], "errors": []] as [String: Any])
        })
        let data = try JSONSerialization.data(withJSONObject: jobs)
        UserDefaults.standard.set(data, forKey: key)
        let options = XCTMeasureOptions(); options.iterationCount = 5
        measure(metrics: [XCTClockMetric(), XCTCPUMetric(), XCTMemoryMetric()], options: options) {
            for index in 0..<20 {
                let done = expectation(description: "missing job")
                BackgroundDownloadManager.shared.status(jobId: "missing-\(index)") { result in
                    if case .success = result { XCTFail("An unknown job must not appear downloaded") }
                    done.fulfill()
                }
                wait(for: [done], timeout: 10)
            }
        }
        let stored = try XCTUnwrap(UserDefaults.standard.data(forKey: key))
        let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: stored) as? [String: Any])
        XCTAssertTrue(NSDictionary(dictionary: decoded).isEqual(to: jobs), "Status reads must preserve stored jobs")
    }
}

private final class StartupStateObserver: AudiobookPlayerObserver {
    var ready = false
    var positionReady = false
    var intentionalSeekCount = 0
    func audiobookPlayer(_ player: AudiobookPlayer, didEmit event: String, data: [String: Any]) {
        if event == "state" {
            ready = data["readyToPlay"] as? Bool ?? false
            positionReady = data["positionReady"] as? Bool ?? false
        }
        if event == "intentionalSeek" { intentionalSeekCount += 1 }
    }
}

private final class SeekControlledQueuePlayer: AVQueuePlayer {
    var holdNextSeek = false
    var cancelNextSeekByAdvancing = false
    var heldSeek: (() -> Void)?
    var cancelledSeekCount = 0
    /// Interrupt this many seeks in place, as AVFoundation may without a newer seek.
    var interruptSeeksInPlace = 0

    override func seek(to time: CMTime, toleranceBefore: CMTime, toleranceAfter: CMTime,
                       completionHandler: @escaping (Bool) -> Void) {
        if holdNextSeek {
            holdNextSeek = false
            heldSeek = { [weak self] in
                self?.seek(to: time, toleranceBefore: toleranceBefore, toleranceAfter: toleranceAfter,
                           completionHandler: completionHandler)
            }
        } else if interruptSeeksInPlace > 0 {
            interruptSeeksInPlace -= 1
            cancelledSeekCount += 1
            DispatchQueue.main.async { completionHandler(false) }
        } else if cancelNextSeekByAdvancing {
            cancelNextSeekByAdvancing = false
            advanceToNextItem()
            cancelledSeekCount += 1
            completionHandler(false)
        } else {
            super.seek(to: time, toleranceBefore: toleranceBefore, toleranceAfter: toleranceAfter,
                       completionHandler: completionHandler)
        }
    }

    func releaseHeldSeek() {
        let seek = heldSeek
        heldSeek = nil
        seek?()
    }
}
