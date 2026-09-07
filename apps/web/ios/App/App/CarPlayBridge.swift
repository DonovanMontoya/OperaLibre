import Capacitor
import Foundation

/// The web layer's side of CarPlay.
///
/// It carries two things across the bridge: the library snapshot the car screen
/// reads when the app is not running, and the progress made in the car, which
/// the app saves through its own player rather than letting the car write to
/// the server itself.
///
/// Both payloads travel as JSON strings. They are nested structures with
/// optional numbers throughout, and one `Codable` model on each side is far
/// harder to get subtly wrong than hand-walking `JSObject` dictionaries.
@objc(CarPlayBridgePlugin)
public final class CarPlayBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CarPlayBridgePlugin"
    public let jsName = "CarPlayBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setLibrary", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledgeSessions", returnType: CAPPluginReturnPromise)
    ]

    private var coordinator: CarPlayCoordinator { CarPlayCoordinator.shared }

    override public func load() {
        coordinator.onWebNotification = { [weak self] event, data in
            guard let self else { return }
            var payload = JSObject()
            for (key, value) in data {
                if let value = value as? String {
                    payload[key] = value
                } else if let value = value as? Bool {
                    payload[key] = value
                } else if let value = value as? Double {
                    payload[key] = value
                }
            }
            self.notifyListeners(event, data: payload)
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
        CarLibraryStore.shared.save(snapshot)
        coordinator.libraryDidChange()
        call.resolve()
    }

    @objc public func getState(_ call: CAPPluginCall) {
        let sessions = coordinator.pendingSessions()
        let encoded = (try? JSONEncoder().encode(sessions))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        var result = JSObject()
        result["connected"] = coordinator.isConnected
        result["sessions"] = encoded
        if let carOwnedBookId = coordinator.carOwnedBookId {
            result["carOwnedBookId"] = carOwnedBookId
        }
        call.resolve(result)
    }

    /// Called once the app has saved a car session's position. Sessions are
    /// only dropped up to the timestamp the app actually saved, so a drive that
    /// is still going does not lose the minutes since.
    @objc public func acknowledgeSessions(_ call: CAPPluginCall) {
        var acknowledged: [String: Double] = [:]
        for entry in call.getArray("sessions", JSObject.self) ?? [] {
            guard let bookId = entry["bookId"] as? String else { continue }
            let savedAt = (entry["updatedAt"] as? Double)
                ?? (entry["updatedAt"] as? NSNumber)?.doubleValue
            guard let savedAt else { continue }
            acknowledged[bookId] = savedAt
        }
        coordinator.acknowledgeSessions(acknowledged)
        call.resolve()
    }
}
