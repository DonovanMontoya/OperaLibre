import CryptoKit
import Foundation

/// The widget receives display data only. Playback URLs and recovery records stay in the app.
struct ResumeWidgetBook: Codable, Equatable {
    static let kind = "OperaLibreResume"
    static var file: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.com.donovanmontoya.operalibre")?
            .appendingPathComponent("resume-widget.json")
    }

    let identity: String
    let title: String
    let author: String?
    let remaining: String?
    let percent: Int?
    let artwork: Data?

    static func identity(for scopeKey: String) -> String {
        SHA256.hash(data: Data(scopeKey.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func matches(_ url: URL, scopeKey: String) -> Bool {
        url.scheme == "operalibre" && url.host == "widget-resume" && url.path == "/" + identity(for: scopeKey)
    }

    var resumeURL: URL? { URL(string: "operalibre://widget-resume/\(identity)") }

    static func read() -> Self? {
        guard let file, let data = try? Data(contentsOf: file) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }
}

struct ReadingStreak: Codable, Equatable {
    static let kind = "OperaLibreReadingStreak"
    static var file: URL? {
        ResumeWidgetBook.file?.deletingLastPathComponent().appendingPathComponent("reading-streak.json")
    }

    let current: Int
    let longest: Int
    let activity: [Bool]
    let asOf: Date

    static func read() -> Self? {
        guard let file, let data = try? Data(contentsOf: file) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }
}
