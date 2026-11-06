import Foundation

// Drives FrontendUpdater's on-disk rollback against a temporary Application Support folder.
// No network: releases are staged by hand and promoted the way install() does after its checks.

private let fileManager = FileManager.default

private func makeWebRoot(at url: URL, version: String) {
    try! fileManager.createDirectory(at: url, withIntermediateDirectories: true)
    try! "<!doctype html><title>\(version)</title>".write(
        to: url.appendingPathComponent("index.html"), atomically: true, encoding: .utf8)
    try! version.write(to: url.appendingPathComponent("VERSION.txt"), atomically: true, encoding: .utf8)
}

private func version(at root: URL) -> String? {
    try? String(contentsOf: root.appendingPathComponent("VERSION.txt"), encoding: .utf8)
}

@main
struct FrontendRollbackTests {
    static func main() {
        let scratch = fileManager.temporaryDirectory
            .appendingPathComponent("frontend-rollback-\(UUID().uuidString)", isDirectory: true)
        defer { try? fileManager.removeItem(at: scratch) }
        let bundled = scratch.appendingPathComponent("Bundle/Web", isDirectory: true)
        let managed = scratch.appendingPathComponent("Support/Web", isDirectory: true)
        makeWebRoot(at: bundled, version: "1.0.0")
        var staged = 0
        func stage(_ version: String) -> URL {
            staged += 1
            let url = scratch.appendingPathComponent("staged-\(staged)/web", isDirectory: true)
            makeWebRoot(at: url, version: version)
            return url
        }
        func launch() -> FrontendUpdater {
            let updater = FrontendUpdater(bundledWebRoot: bundled, managedWebRoot: managed)
            _ = updater.resolveServingRoot()
            return updater
        }

        // A first launch copies the bundle in; it was never installed, so an error there is
        // a startup error as before, not a rollback.
        var updater = launch()
        precondition(updater.isServingManagedRoot)
        precondition(updater.rollBackUnconfirmedRoot() == nil)

        // 1.1.0 installs and loads, so it becomes the working release.
        try! updater.promote(stage("1.1.0"), version: "1.1.0")
        precondition(version(at: updater.previousWebRoot) == "1.0.0", "the replaced root is kept")
        updater.confirmServingRoot()
        precondition(updater.rollBackUnconfirmedRoot() == nil, "a root that loaded is not undone")

        // 1.2.0 installs but fails before it loads: the previous root comes back, only one
        // previous root is kept, and 1.2.0 is remembered as rejected.
        try! updater.promote(stage("1.2.0"), version: "1.2.0")
        precondition(version(at: updater.previousWebRoot) == "1.1.0")
        precondition(updater.currentVersion == "1.2.0")
        precondition(updater.rollBackUnconfirmedRoot()?.standardizedFileURL == managed.standardizedFileURL)
        precondition(version(at: managed) == "1.1.0")
        precondition(updater.currentVersion == "1.1.0")
        precondition(!fileManager.fileExists(atPath: updater.previousWebRoot.path))
        precondition(updater.isRejected("1.2.0"))
        precondition(!updater.isRejected("1.1.0"))

        // The restored root loads, and the next launch keeps it rather than the bundle.
        updater.confirmServingRoot()
        updater = launch()
        precondition(updater.isServingManagedRoot && updater.currentVersion == "1.1.0")
        precondition(updater.isRejected("1.2.0"), "the rejection survives a relaunch")

        // A release that never loaded is still unproven after a relaunch (the app quit or
        // crashed first). With no previous root left, the bundle is the fallback, and the
        // launch after that copies the bundle back in.
        try! updater.promote(stage("1.3.0"), version: "1.3.0")
        try! fileManager.removeItem(at: updater.previousWebRoot)
        updater = launch()
        precondition(updater.currentVersion == "1.3.0")
        precondition(updater.rollBackUnconfirmedRoot()?.standardizedFileURL == bundled.standardizedFileURL)
        precondition(!updater.isServingManagedRoot && updater.currentVersion == "1.0.0")
        precondition(updater.isRejected("1.3.0") && updater.isRejected("1.2.0"))
        precondition(updater.rollBackUnconfirmedRoot() == nil, "the bundle is the last fallback")
        updater = launch()
        precondition(updater.isServingManagedRoot && version(at: managed) == "1.0.0")

        // A restored previous root that also fails falls back to the bundle in turn.
        try! updater.promote(stage("1.4.0"), version: "1.4.0")
        updater.confirmServingRoot()
        try! updater.promote(stage("1.5.0"), version: "1.5.0")
        precondition(version(at: updater.rollBackUnconfirmedRoot()!) == "1.4.0")
        precondition(updater.rollBackUnconfirmedRoot()?.standardizedFileURL == bundled.standardizedFileURL)

        // A rebuilt bundle is authoritative: it drops the kept root so an older release
        // cannot come back over it.
        updater = launch()
        try! updater.promote(stage("1.6.0"), version: "1.6.0")
        precondition(fileManager.fileExists(atPath: updater.previousWebRoot.path))
        makeWebRoot(at: bundled, version: "2.0.0")
        updater = launch()
        precondition(version(at: managed) == "2.0.0")
        precondition(!fileManager.fileExists(atPath: updater.previousWebRoot.path))
        precondition(updater.rollBackUnconfirmedRoot() == nil)

        let support = managed.deletingLastPathComponent()
        func setWritable(_ url: URL, _ writable: Bool) {
            try! fileManager.setAttributes(
                [.posixPermissions: writable ? 0o755 : 0o555], ofItemAtPath: url.path)
        }
        // What a rollback records before it swaps anything.
        func reject(_ version: String) {
            let url = support.appendingPathComponent(".rejected-frontend-versions")
            let existing = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
            try! (existing + version + "\n").write(to: url, atomically: true, encoding: .utf8)
        }

        // An install whose root cannot be marked unproven does not go live.
        let unmarkable = stage("2.1.0")
        setWritable(unmarkable, false)
        do {
            try updater.promote(unmarkable, version: "2.1.0")
            preconditionFailure("an install without its mark must fail")
        } catch {}
        setWritable(unmarkable, true)
        precondition(version(at: managed) == "2.0.0" && updater.currentVersion == "2.0.0")
        precondition(!fileManager.fileExists(atPath: updater.previousWebRoot.path))

        // A kept root that cannot be marked unproven is not restored; the bundle is used.
        try! updater.promote(stage("2.2.0"), version: "2.2.0")
        updater.confirmServingRoot()
        try! updater.promote(stage("2.3.0"), version: "2.3.0")
        setWritable(updater.previousWebRoot, false)
        precondition(updater.rollBackUnconfirmedRoot()?.standardizedFileURL == bundled.standardizedFileURL)
        setWritable(updater.previousWebRoot, true)
        precondition(!fileManager.fileExists(atPath: managed.path), "the failed root is moved aside")
        updater = launch()
        precondition(version(at: managed) == "2.0.0")

        // A rollback cut short after recording the rejection is finished at the next launch,
        // and the restored root is still unproven.
        try! updater.promote(stage("2.4.0"), version: "2.4.0")
        updater.confirmServingRoot()
        try! updater.promote(stage("2.5.0"), version: "2.5.0")
        reject("2.5.0")
        updater = launch()
        precondition(updater.isServingManagedRoot && version(at: managed) == "2.4.0")
        precondition(!fileManager.fileExists(atPath: updater.previousWebRoot.path))
        precondition(updater.rollBackUnconfirmedRoot()?.standardizedFileURL == bundled.standardizedFileURL)
        updater = launch()

        // When the failed root cannot be moved (or the rejection saved), this session serves
        // the bundle and the failed root keeps its mark, so its next failure rolls it back.
        try! updater.promote(stage("2.6.0"), version: "2.6.0")
        updater.confirmServingRoot()
        try! updater.promote(stage("2.7.0"), version: "2.7.0")
        setWritable(support, false)
        precondition(updater.rollBackUnconfirmedRoot()?.standardizedFileURL == bundled.standardizedFileURL)
        setWritable(support, true)
        precondition(!updater.isRejected("2.7.0") && version(at: managed) == "2.7.0")
        updater = launch()
        precondition(updater.currentVersion == "2.7.0")
        precondition(version(at: updater.rollBackUnconfirmedRoot()!) == "2.6.0")
        precondition(updater.isRejected("2.7.0"))

        // The same failure after the rejection was saved is finished at the next launch.
        try! updater.promote(stage("2.8.0"), version: "2.8.0")
        reject("2.8.0")
        setWritable(support, false)
        precondition(updater.rollBackUnconfirmedRoot()?.standardizedFileURL == bundled.standardizedFileURL)
        setWritable(support, true)
        updater = launch()
        precondition(updater.isServingManagedRoot && version(at: managed) == "2.6.0")

        print("Frontend rollback tests passed")
    }
}
