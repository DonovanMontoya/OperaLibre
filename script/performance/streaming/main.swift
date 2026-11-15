import AVFoundation
import UIKit
import MediaPlayer

@MainActor final class BenchController: UIViewController {
  let label = UITextView()
  let button = UIButton(type: .system)
  var queue: AVQueuePlayer?
  var engine: AudiobookPlayer?
  var lines = [String]()
  let base = Bundle.main.object(forInfoDictionaryKey: "BenchmarkBase") as! String
  let pairs = Bundle.main.object(forInfoDictionaryKey: "BenchmarkPairs") as! Int
  let midpoint = Bundle.main.object(forInfoDictionaryKey: "BenchmarkMidpoint") as! Double
  let candidate = Bundle.main.object(forInfoDictionaryKey: "BenchmarkCandidate") as? String ?? "bootstrap"
  let baseline = Bundle.main.object(forInfoDictionaryKey: "BenchmarkBaseline") as? String ?? "faststart"
  let speeds = Bundle.main.object(forInfoDictionaryKey: "BenchmarkSpeeds") as? [Int] ?? [40, 4]
  let playbackRate = Bundle.main.object(forInfoDictionaryKey: "BenchmarkRate") as? Double ?? 1
  let playbackGain = Bundle.main.object(forInfoDictionaryKey: "BenchmarkGain") as? Double ?? 1
  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    label.isEditable = false
    label.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
    button.setTitle("Run native streaming tests", for: .normal)
    button.addTarget(self, action: #selector(start), for: .touchUpInside)
    let stack = UIStackView(arrangedSubviews: [button, label])
    stack.axis = .vertical
    stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
      stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
      stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
    ])
    label.text =
      "OperaLibre native streaming experiment\nActual AudiobookPlayer.swift\nGenerated AAC: \(baseline) / \(candidate)\n40ms simulated response delay\nFresh URL and player per sample\nAlternating order per pair"
  }
  func log(_ text: String) {
    lines.append(text)
    label.text = lines.suffix(18).joined(separator: "\n")
    label.scrollRangeToVisible(NSRange(location: label.text.count, length: 0))
  }
  @objc func start() {
    button.isEnabled = false
    Task { await run() }
  }
  func wait(_ name: String, limit: Double = 90, _ condition: () -> Bool) async throws {
    let deadline = ProcessInfo.processInfo.systemUptime + limit
    while !condition() {
      if let item = queue?.currentItem, item.status == .failed {
        throw NSError(
          domain: "playback", code: 1,
          userInfo: [NSLocalizedDescriptionKey: item.error?.localizedDescription ?? "failed"])
      }
      if ProcessInfo.processInfo.systemUptime > deadline {
        throw NSError(domain: "timeout", code: 1, userInfo: [NSLocalizedDescriptionKey: name])
      }
      try await Task.sleep(nanoseconds: 5_000_000)
    }
  }
  func run() async {
    for speed in speeds {
      for position in [0.0, midpoint] {
        for index in 0..<pairs {
          for kind in (index % 2 == 0 ? ["flat", candidate] : [candidate, "flat"]) {
            let id = UUID().uuidString
            var row: [String: Any] = [
              "id": id, "mbps": speed, "target": position, "index": index, "kind": kind,
              "osVersion": UIDevice.current.systemVersion,
              "device": ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"]
                ?? UIDevice.current.model,
            ]
            log("\(speed)Mb \(kind) @\(Int(position)) #\(index+1)")
            let path = kind == "packet" ? "api/books/fixture/tracks/fixture/stream"
              : kind == "compact" ? "compact.m4a" : "flat.m4a"
            var url = URL(string: "\(base)/run/\(speed)/\(id)/\(path)")!
            let engine = AudiobookPlayer(makeQueuePlayer: { [weak self] items in
              let p = AVQueuePlayer(items: items)
              self?.queue = p
              return p
            })
            self.engine = engine
            let t = ProcessInfo.processInfo.systemUptime
            var proxy: BootstrapProxy?
            do {
              if kind == "bootstrap" {
                let created = BootstrapProxy()
                proxy = created
                url = try await created.prepare(
                  base: base, speed: speed, id: id, target: Int(position))
                row["bootstrapMs"] = (ProcessInfo.processInfo.systemUptime - t) * 1000
              }
              engine.load(
                AudiobookLoadRequest(
                  url: url, positionSeconds: position, rate: playbackRate, volume: 0, gain: playbackGain, autoplay: true,
                  recoveryScopeKey: id, recoveryTrackId: "fixture", recoveryBookOffsetSeconds: 0,
                  queue: []))
              try await wait("playing") { self.queue?.timeControlStatus == .playing }
              row["ratePassed"] = abs(Double(self.queue!.rate) - playbackRate) < 0.01
              if playbackGain > 1 {
                try await wait("volume boost mix") { self.queue?.currentItem?.audioMix != nil }
                row["boostPassed"] = true
              }
              row["startMs"] = (ProcessInfo.processInfo.systemUptime - t) * 1000
              try await wait("first movement") {
                (self.queue?.currentTime().seconds ?? -1) > position + 0.001
              }
              row["firstAdvanceMs"] = (ProcessInfo.processInfo.systemUptime - t) * 1000
              try await wait("position advances") {
                (self.queue?.currentTime().seconds ?? -1) > position + 0.15
              }
              row["position"] = queue!.currentTime().seconds
              row["advanceMs"] = (ProcessInfo.processInfo.systemUptime - t) * 1000
              if let duration = queue?.currentItem?.duration.seconds, duration.isFinite {
                row["duration"] = duration
              }
              engine.pause()
              try await wait("paused") { self.queue?.rate == 0 }
              row["pausePassed"] = true
              let seekTarget = position == 0 ? midpoint : midpoint / 2
              engine.seek(toPositionSeconds: seekTarget)
              try await wait("seek target") {
                abs((self.queue?.currentTime().seconds ?? -999) - seekTarget) < 0.05
              }
              row["seekPosition"] = queue!.currentTime().seconds
              engine.play()
              try await wait("seek playback advances") {
                (self.queue?.currentTime().seconds ?? -1) > seekTarget + 0.15
              }
              row["seekPlaybackPassed"] = true
              let checkpoint = engine.recoveryState(forScope: id)
              row["checkpointPosition"] = checkpoint?.positionSeconds
              if let cover = Bundle.main.url(forResource: "cover", withExtension: "jpg") {
                engine.setNowPlaying(AudiobookNowPlayingRequest(
                  title: "Fixture chapter", artist: "Fixture", album: "Streaming",
                  artworkSource: cover.absoluteString, chapterStartSeconds: nil,
                  chapterDurationSeconds: nil, chapters: []))
                try await wait("external artwork") {
                  let info = MPNowPlayingInfoCenter.default().nowPlayingInfo
                  return info?[MPMediaItemPropertyTitle] as? String == "Fixture chapter"
                    && info?[MPMediaItemPropertyArtwork] is MPMediaItemArtwork
                }
                row["artworkPassed"] = true
              }
              log(String(format: "  %.0f ms; pause/seek OK", row["startMs"] as! Double))
            } catch {
              row["error"] = error.localizedDescription
              log("  FAILED: \(error.localizedDescription)")
            }
            engine.stopOnMainThread(releaseSession: true)
            self.engine = nil
            queue = nil
            proxy?.stop()
            var request = URLRequest(url: URL(string: base + "/result")!)
            request.httpMethod = "POST"
            request.httpBody = try? JSONSerialization.data(withJSONObject: row)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            do {
              let (_, response) = try await URLSession.shared.data(for: request)
              if (response as? HTTPURLResponse)?.statusCode != 200 {
                log("RESULT UPLOAD FAILED")
                return
              }
            } catch {
              log("RESULT UPLOAD FAILED \(error)")
              return
            }
          }
        }
      }
    }
    log("COMPLETE: \(pairs * speeds.count * 4) samples. Results saved.")
    button.setTitle("Tests complete", for: .normal)
  }
}
@MainActor final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  func scene(
    _ scene: UIScene, willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let scene = scene as? UIWindowScene else { return }
    let window = UIWindow(windowScene: scene)
    window.rootViewController = BenchController()
    window.makeKeyAndVisible()
    self.window = window
  }
}
@MainActor final class AppDelegate: UIResponder, UIApplicationDelegate {
  func application(
    _ app: UIApplication, configurationForConnecting session: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: "Streaming", sessionRole: session.role)
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }
}
UIApplicationMain(
  CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
