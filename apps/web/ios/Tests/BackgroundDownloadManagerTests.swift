// Compiled with the production manager by test_background_download_manager.py.
// All files and persisted records belong to this disposable fixture.
let manager = BackgroundDownloadManager()
let suite = ProcessInfo.processInfo.environment["OL_TEST_SUITE"]!
let defaults = UserDefaults(suiteName: suite)!
defaults.removePersistentDomain(forName: suite)
defer { defaults.removePersistentDomain(forName: suite) }
let root = try backgroundOfflineMediaRoot()
var a = root.appendingPathComponent("a")
var b = root.appendingPathComponent("b")
let unrelated = root.appendingPathComponent("unrelated")
try Data([9]).write(to: unrelated)
func info(_ path: URL, attempt: String? = nil) -> StoredBackgroundTask {
    StoredBackgroundTask(jobId: "book", attemptId: attempt, source: "https://assets.libro.fm/\(path.lastPathComponent)", allowedOrigin: "libro-device", allowedBasePath: "", destination: path.absoluteString, label: path.lastPathComponent, required: true)
}
var files = [info(a), info(b)]
func seed(_ sizes: [Int], budget: BackgroundBookByteBudget? = nil) throws {
    let attempt = UUID().uuidString
    a = root.appendingPathComponent("a-" + attempt)
    b = root.appendingPathComponent("b-" + attempt)
    var persisted = budget
    if budget != nil {
        persisted = BackgroundBookByteBudget()
        precondition(persisted!.reserve(destination: a.absoluteString, bytes: 7, retained: [a.absoluteString: 7, b.absoluteString: 0]))
    }
    files = [info(a, attempt: attempt), info(b, attempt: attempt)]
    for (path, size) in zip([a, b], sizes) {
        try? FileManager.default.removeItem(at: path)
        if size >= 0 { try Data(repeating: 1, count: size).write(to: path) }
    }
    manager.mutateJobs { jobs in
        jobs = ["book": StoredBackgroundJob(title: "fixture", attemptId: files[0].attemptId, byteBudget: persisted, state: "running", total: 2, requiredTotal: 2, completed: 0, completedRequired: 0, handledTaskIds: [], errors: [], files: files),
                "control": StoredBackgroundJob(title: "unrelated", state: "completed", total: 0, requiredTotal: 0, completed: 0, completedRequired: 0, handledTaskIds: [], errors: [])]
    }
}
func status() -> String {
    let done = DispatchSemaphore(value: 0)
    var state = ""
    manager.status(jobId: "book") { result in
        state = try! result.get().0
        done.signal()
    }
    precondition(done.wait(timeout: .now() + 5) == .success)
    return state
}
func stored() -> StoredBackgroundJob { manager.mutateJobs { $0["book"]! } }
for persisted in [false, true] {
    var budget = BackgroundBookByteBudget()
    precondition(budget.reserve(destination: a.absoluteString, bytes: 7, retained: [a.absoluteString: 7, b.absoluteString: 0]))
    try seed([7, 6], budget: persisted ? budget : nil)
    manager.prepare()
    precondition(status() == "failed")
    for _ in 0..<3 {
        manager.prepare()
        precondition(status() == "failed")
        let task = URLSession.shared.downloadTask(with: URL(string: files[0].source!)!)
        manager.record(task, info: files[0], succeeded: true)
        let incoming = root.appendingPathComponent("incoming")
        try Data([1]).write(to: incoming)
        do { try manager.publishLibroPart(files[0], location: incoming, bytes: 1); fatalError("late publication accepted") } catch {}
        precondition(stored().byteBudgetExceeded == true)
        precondition(!FileManager.default.fileExists(atPath: a.path))
        precondition(!FileManager.default.fileExists(atPath: b.path))
    }
    precondition(FileManager.default.fileExists(atPath: unrelated.path))
    precondition(manager.mutateJobs { $0["control"]!.state } == "completed")
    print("PASS \(persisted ? "persisted" : "legacy") oversized recovery, repeated status, delayed callbacks, isolated cleanup")
}
for size in [4, 5] {
    try seed([7, size])
    let observed = status()
    precondition(observed == "completed", "state=\(observed), job=\(stored())")
    precondition(stored().byteBudget != nil)
    print("PASS retained \(7 + size) bytes complete and persist reconstructed budget")
}
try seed([7, -1])
precondition(manager.reserveLibroBytes(files[1], bytes: 5))
precondition(!manager.reserveLibroBytes(files[1], bytes: 6))
precondition(status() == "failed")
print("PASS missing part plus persisted in-flight high-water reservation stays bounded")
// A retry gets a new attempt identity; callbacks from the failed attempt cannot
// reserve or publish into it, and the new attempt can publish at the exact limit.
try seed([-1, -1])
manager.mutateJobs { jobs in
    jobs["book"]!.attemptId = "retry"
    jobs["book"]!.files = [info(a, attempt: "retry"), info(b, attempt: "retry")]
}
precondition(!manager.reserveLibroBytes(files[0], bytes: 12))
for (file, size) in zip([info(a, attempt: "retry"), info(b, attempt: "retry")], [7, 5]) {
    let incoming = root.appendingPathComponent("incoming")
    try Data(repeating: 1, count: size).write(to: incoming)
    try manager.publishLibroPart(file, location: incoming, bytes: Int64(size))
}
precondition(status() == "completed")
print("PASS new attempt publishes while stale attempt is rejected")
