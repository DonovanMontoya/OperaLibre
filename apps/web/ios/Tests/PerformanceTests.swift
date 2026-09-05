import XCTest
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
