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

private let maximumLibroResponseBytes = 8 * 1024 * 1024

/// Receive provider JSON incrementally; completion-handler data tasks buffer
/// their entire response before the decoder can enforce its limit.
private final class LibroResponseReceiver: NSObject, URLSessionDataDelegate {
    private let finished = DispatchSemaphore(value: 0)
    private var body = Data()
    private var response: HTTPURLResponse?
    private var failure: Error?

    func receive(_ request: URLRequest, configuration: URLSessionConfiguration) throws -> (HTTPURLResponse, Data) {
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        session.dataTask(with: request).resume()
        finished.wait()
        if let failure { throw failure }
        guard let response else { throw URLError(.badServerResponse) }
        return (response, body)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse,
              response.expectedContentLength <= maximumLibroResponseBytes else {
            failure = URLError(.dataLengthExceedsMaximum)
            completionHandler(.cancel)
            return
        }
        self.response = http
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard data.count <= maximumLibroResponseBytes - body.count else {
            failure = URLError(.dataLengthExceedsMaximum)
            dataTask.cancel()
            return
        }
        guard failure == nil else { return }
        body.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if failure == nil { failure = error }
        finished.signal()
    }
}

func receiveLibroDeviceResponse(_ request: URLRequest, configuration: URLSessionConfiguration? = nil) throws -> (HTTPURLResponse, Data) {
    let config = configuration ?? URLSessionConfiguration.ephemeral
    config.httpShouldSetCookies = false
    config.timeoutIntervalForRequest = 25
    config.timeoutIntervalForResource = 30
    return try LibroResponseReceiver().receive(request, configuration: config)
}
