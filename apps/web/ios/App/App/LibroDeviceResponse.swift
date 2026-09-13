import Foundation

/// JSONSerialization produces Foundation values, not Capacitor JSValue values.
/// Preserve those values for CAPPluginCall.resolve's [String: Any] payload.
func decodeLibroDeviceResponse(_ data: Data) throws -> [String: Any] {
    guard data.count <= 8 * 1024 * 1024,
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw CocoaError(.coderReadCorrupt)
    }
    return object
}
