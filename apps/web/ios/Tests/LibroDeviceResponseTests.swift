import Foundation

@main
struct LibroDeviceResponseTests {
    static func main() throws {
        let token = try decodeLibroDeviceResponse(Data(#"{"access_token":"fixture-token","created_at":123,"user":{"active":true,"name":null}}"#.utf8))
        precondition(token["access_token"] as? String == "fixture-token")
        precondition(token["created_at"] as? Int == 123)
        let user = token["user"] as! [String: Any]
        precondition(user["active"] as? Bool == true)
        precondition(user["name"] is NSNull)
        let empty = try decodeLibroDeviceResponse(Data(#"{"total_pages":0,"audiobooks":[]}"#.utf8))
        precondition(empty["total_pages"] as? Int == 0)
        precondition((empty["audiobooks"] as? [Any])?.isEmpty == true)
        let library = try decodeLibroDeviceResponse(Data(#"{"total_pages":1,"audiobooks":[{"isbn":"9780000000001","audiobook_info":{"narrators":["Narrator"]}}]}"#.utf8))
        // The result must remain valid JSON all the way to the native bridge.
        precondition(JSONSerialization.isValidJSONObject(library))
        _ = try JSONSerialization.data(withJSONObject: library)
        for invalid in [Data(), Data("<html>Not JSON</html>".utf8), Data("[]".utf8), Data("null".utf8), Data(repeating: 32, count: 8 * 1024 * 1024 + 1)] {
            do {
                _ = try decodeLibroDeviceResponse(invalid)
                preconditionFailure("Invalid response was accepted")
            } catch {}
        }
        print("Libro device response tests passed")
    }
}
