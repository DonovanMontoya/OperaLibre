import Foundation

private final class ResponseProtocol: URLProtocol {
    static var chunks: [Data] = []
    static var length: Int? = nil
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var headers: [String: String] = ["Content-Type": "application/json"]
        if let length = Self.length { headers["Content-Length"] = String(length) }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for chunk in Self.chunks { client?.urlProtocol(self, didLoad: chunk) }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

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
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ResponseProtocol.self]
        let request = URLRequest(url: URL(string: "https://libro.fm/fixture")!)
        ResponseProtocol.chunks = [Data(#"{"total_pages":1}"#.utf8)]
        let (http, received) = try receiveLibroDeviceResponse(request, configuration: config)
        precondition(http.statusCode == 200)
        let streamed = try decodeLibroDeviceResponse(received)
        precondition(streamed["total_pages"] as? Int == 1)
        // Unknown/chunked and dishonest small declared lengths both have to
        // meet the same limit on bytes actually received.
        for length in [nil, 1, 9 * 1024 * 1024] as [Int?] {
            ResponseProtocol.length = length
            ResponseProtocol.chunks = Array(repeating: Data(repeating: 32, count: 1024 * 1024), count: 9)
            do {
                _ = try receiveLibroDeviceResponse(request, configuration: config)
                preconditionFailure("Oversized streamed response was accepted")
            } catch let error as URLError {
                precondition(error.code == .dataLengthExceedsMaximum)
            }
        }
        print("Libro device response tests passed")
    }
}
