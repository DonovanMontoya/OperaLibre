import Foundation


struct StoredRecordList<Record: Codable> {
    var records: [Record] = []
    private var unreadable: [Data] = []

    init() {}

    init(decoding data: Data?) {
        guard let data, let entries = (try? JSONSerialization.jsonObject(with: data)) as? [Any] else { return }
        let decoder = JSONDecoder()
        for entry in entries {
            guard let bytes = try? JSONSerialization.data(withJSONObject: entry, options: .fragmentsAllowed) else { continue }
            if let record = try? decoder.decode(Record.self, from: bytes) {
                records.append(record)
            } else {
                unreadable.append(bytes)
            }
        }
    }

    func encoded() -> Data? {
        let encoder = JSONEncoder()
        guard let readable = try? records.map({ try encoder.encode($0) }) else { return nil }
        return Data("[".utf8) + Data((readable + unreadable).joined(separator: Data(",".utf8))) + Data("]".utf8)
    }
}

struct StoredRecordMap<Record: Codable> {
    var records: [String: Record] = [:]
    private var unreadable: [String: Data] = [:]

    init(decoding data: Data?) {
        guard let data, let entries = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        let decoder = JSONDecoder()
        for (key, entry) in entries {
            guard let bytes = try? JSONSerialization.data(withJSONObject: entry, options: .fragmentsAllowed) else { continue }
            if let record = try? decoder.decode(Record.self, from: bytes) {
                records[key] = record
            } else {
                unreadable[key] = bytes
            }
        }
    }

    func encoded() -> Data? {
        let encoder = JSONEncoder()
        guard let readable = try? records.mapValues({ try encoder.encode($0) }) else { return nil }
        var members: [Data] = []
        for (key, value) in unreadable.merging(readable, uniquingKeysWith: { _, saved in saved }) {
            guard let name = try? encoder.encode(key) else { return nil }
            members.append(name + Data(":".utf8) + value)
        }
        return Data("{".utf8) + Data(members.joined(separator: Data(",".utf8))) + Data("}".utf8)
    }
}
