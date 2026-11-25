import Capacitor
import Foundation
import WidgetKit

@objc(CarPlayBridgePlugin)
public final class CarPlayBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CarPlayBridgePlugin"
    public let jsName = "CarPlayBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setReadingStreakScope", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeWidgetResume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setLibrary", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearLibrary", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopPlayback", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledgeSessions", returnType: CAPPluginReturnPromise)
    ]

    private var coordinator: CarPlayCoordinator { CarPlayCoordinator.shared }

    override public func load() {
        coordinator.onWebNotification = { [weak self] event, data in
            self?.notifyListeners(event, data: bridgeEventPayload(from: data))
        }
    }

    @objc public func setLibrary(_ call: CAPPluginCall) {
        guard
            let json = call.getString("snapshot"),
            let data = json.data(using: .utf8),
            let snapshot = try? JSONDecoder().decode(CarLibrarySnapshot.self, from: data)
        else {
            call.reject("The car library snapshot could not be read.")
            return
        }
        DispatchQueue.main.async {
            CarLibraryStore.shared.save(snapshot)
            self.coordinator.libraryDidChange()
            call.resolve()
        }
    }

    @objc public func takeWidgetResume(_ call: CAPPluginCall) {
        guard let scope = call.getString("scope") else { call.reject("Missing library scope."); return }
        DispatchQueue.main.async {
            if let id = self.coordinator.takeWidgetResume(scope: scope) {
                call.resolve(["bookId": id])
            } else {
                call.resolve()
            }
        }
    }

    @objc public func setReadingStreakScope(_ call: CAPPluginCall) {
        guard let scope = call.getString("scope"), !scope.isEmpty else {
            call.reject("Invalid reading streak scope.")
            return
        }
        DispatchQueue.main.async {
            ReadingStreakStore.shared.select(scope)
            call.resolve()
        }
    }

    @objc public func clearLibrary(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.coordinator.clearLibrary()
            ReadingStreakStore.shared.select(nil)
            call.resolve()
        }
    }

    @objc public func getState(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let sessions = self.coordinator.pendingSessions()
            let encoded = (try? JSONEncoder().encode(sessions))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
            var result = JSObject()
            result["connected"] = self.coordinator.isConnected
            result["sessions"] = encoded
            if let carOwnedBookId = self.coordinator.carOwnedBookId {
                result["carOwnedBookId"] = carOwnedBookId
            }
            call.resolve(result)
        }
    }

    @objc public func stopPlayback(_ call: CAPPluginCall) {
        guard let bookId = call.getString("bookId"), !bookId.isEmpty else {
            call.reject("The book to stop was not specified.")
            return
        }
        DispatchQueue.main.async {
            self.coordinator.stopPlayback(forBookId: bookId)
            let sessions = self.coordinator.pendingSessions()
            do {
                let encoded = try JSONEncoder().encode(sessions)
                var result = JSObject()
                result["connected"] = self.coordinator.isConnected
                result["sessions"] = String(data: encoded, encoding: .utf8) ?? "[]"
                if let owner = self.coordinator.carOwnedBookId {
                    result["carOwnedBookId"] = owner
                }
                call.resolve(result)
            } catch {
                call.reject("The final car playback position could not be read.")
            }
        }
    }

    @objc public func acknowledgeSessions(_ call: CAPPluginCall) {
        var acknowledged: [String: Double] = [:]
        for entry in call.getArray("sessions", JSObject.self) ?? [] {
            guard let bookId = entry["bookId"] as? String else { continue }
            let savedAt = (entry["updatedAt"] as? Double)
                ?? (entry["updatedAt"] as? NSNumber)?.doubleValue
            guard let savedAt else { continue }
            acknowledged[bookId] = savedAt
        }
        DispatchQueue.main.async {
            self.coordinator.acknowledgeSessions(acknowledged)
            call.resolve()
        }
    }
}

// The native player and the account bridge both update this store on the main queue.
final class ReadingStreakStore {
    static let shared = ReadingStreakStore()
    private static let scopeKey = "reading-streak.active-scope"
    private let defaults = UserDefaults.standard
    private var scope: String?
    private var history = ReadingStreakHistory()
    private var unsavedSeconds = 0.0

    private init() {
        scope = defaults.string(forKey: Self.scopeKey)
        history = loadHistory()
    }

    func select(_ scope: String?) {
        guard self.scope != scope else { return }
        saveHistory()
        self.scope = scope
        defaults.set(scope, forKey: Self.scopeKey)
        history = loadHistory()
        unsavedSeconds = 0
        if let file = ReadingStreakHistory.file {
            try? FileManager.default.removeItem(at: file)
        }
        publishHistory()
    }

    func record(seconds: Double, on date: Date, playbackScope: String) {
        guard let scope, playbackScope.hasPrefix(scope + ":") else { return }
        let result = history.record(seconds: seconds, on: date)
        if result == .alreadyActive { return }
        unsavedSeconds += seconds
        if unsavedSeconds >= 2 || result == .becameActive {
            saveHistory()
        }
        if result == .becameActive {
            publishHistory()
        }
    }

    private var historyKey: String? {
        scope.map { "reading-streak.history." + ResumeWidgetBook.identity(for: $0) }
    }

    private func loadHistory() -> ReadingStreakHistory {
        guard let historyKey, let data = defaults.data(forKey: historyKey),
              let history = try? JSONDecoder().decode(ReadingStreakHistory.self, from: data) else {
            return ReadingStreakHistory()
        }
        return history
    }

    private func saveHistory() {
        guard unsavedSeconds > 0, let historyKey,
              let data = try? JSONEncoder().encode(history) else { return }
        defaults.set(data, forKey: historyKey)
        unsavedSeconds = 0
    }

    private func publishHistory() {
        if scope != nil, let file = ReadingStreakHistory.file,
           let data = try? JSONEncoder().encode(history) {
            try? data.write(to: file, options: .atomic)
        }
        WidgetCenter.shared.reloadTimelines(ofKind: ReadingStreak.kind)
    }
}
