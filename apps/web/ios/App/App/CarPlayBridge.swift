import Capacitor
import Foundation
import WidgetKit

@objc(CarPlayBridgePlugin)
public final class CarPlayBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CarPlayBridgePlugin"
    public let jsName = "CarPlayBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "hasStreakWidget", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setReadingStreak", returnType: CAPPluginReturnPromise),
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

    @objc public func hasStreakWidget(_ call: CAPPluginCall) {
        WidgetCenter.shared.getCurrentConfigurations { result in
            let installed = (try? result.get())?.contains { $0.kind == ReadingStreak.kind } ?? false
            call.resolve(["installed": installed])
        }
    }

    @objc public func setReadingStreak(_ call: CAPPluginCall) {
        guard let current = call.getInt("current"), current >= 0,
              let longest = call.getInt("longest"), longest >= current,
              let activity = call.getArray("activity", Bool.self), activity.count <= 28,
              let file = ReadingStreak.file else {
            call.reject("Invalid reading streak.")
            return
        }
        DispatchQueue.main.async {
            let streak = ReadingStreak(current: current, longest: longest, activity: activity,
                                       asOf: Calendar.current.startOfDay(for: Date()))
            do {
                if ReadingStreak.read() != streak {
                    try JSONEncoder().encode(streak).write(to: file, options: .atomic)
                    WidgetCenter.shared.reloadTimelines(ofKind: ReadingStreak.kind)
                }
                call.resolve()
            } catch {
                call.reject("Could not save reading streak.")
            }
        }
    }

    @objc public func clearLibrary(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.coordinator.clearLibrary()
            if let file = ReadingStreak.file, FileManager.default.fileExists(atPath: file.path) {
                do { try FileManager.default.removeItem(at: file) } catch {
                    call.reject("Could not clear reading streak.")
                    return
                }
            }
            WidgetCenter.shared.reloadTimelines(ofKind: ReadingStreak.kind)
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
