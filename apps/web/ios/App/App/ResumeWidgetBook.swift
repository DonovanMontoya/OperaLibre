import CryptoKit
import Foundation

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

struct ReadingStreakHistory: Codable {
    private(set) var secondsByDay: [Int: Double] = [:]

    static var file: URL? {
        ResumeWidgetBook.file?.deletingLastPathComponent().appendingPathComponent("reading-streak-local.json")
    }

    static func day(_ date: Date, timeZone: TimeZone = .current) -> Int {
        Int(floor((date.timeIntervalSince1970 + Double(timeZone.secondsFromGMT(for: date))) / 86_400))
    }

    // Match the Ledger's threshold and stop writing time once the day qualifies.
    private static let activeDayThreshold = 30.0

    enum RecordResult {
        case alreadyActive, accumulated, becameActive
    }

    mutating func record(seconds: Double, on date: Date) -> RecordResult {
        let day = Self.day(date)
        let previous = secondsByDay[day, default: 0]
        guard previous <= Self.activeDayThreshold else { return .alreadyActive }
        let total = previous + seconds
        secondsByDay[day] = total
        return total > Self.activeDayThreshold ? .becameActive : .accumulated
    }

    func streak(asOf date: Date) -> ReadingStreak {
        let today = Self.day(date)
        let active = Set(secondsByDay.compactMap { day, seconds in
            day <= today && seconds > Self.activeDayThreshold ? day : nil
        })
        var run = 0
        var longest = 0
        var previous: Int?
        for day in active.sorted() {
            run = previous == day - 1 ? run + 1 : 1
            longest = max(longest, run)
            previous = day
        }
        return ReadingStreak(
            current: previous.map { $0 >= today - 1 } == true ? run : 0,
            longest: longest,
            activity: ((today - 27)...today).map { active.contains($0) },
            asOf: date
        )
    }
}

struct ReadingStreak {
    static let kind = "OperaLibreReadingStreak"

    let current: Int
    let longest: Int
    let activity: [Bool]
    let asOf: Date

    static func read(now: Date = Date()) -> Self? {
        guard let file = ReadingStreakHistory.file,
              let data = try? Data(contentsOf: file),
              let history = try? JSONDecoder().decode(ReadingStreakHistory.self, from: data) else { return nil }
        return history.streak(asOf: now)
    }
}
