import CoreFoundation
import Foundation
import AVFoundation

/// Feeds AVPlayer a small-index MP4 while URLSession fetches bounded, compressed
/// windows from OperaLibre. The canonical track URL remains in AudiobookPlayer.
final class PacketAudioAsset: NSObject, AVAssetResourceLoaderDelegate {
    let source: URL
    let asset: AVURLAsset
    let queue = DispatchQueue(label: "com.operalibre.packet-audio")
    private var session: URLSession!
    private let delegateProxy = NetworkDelegate()
    private var transfers: [Int: Transfer] = [:]
    private var requests: [ObjectIdentifier: AVAssetResourceLoadingRequest] = [:]
    private var pending: [ObjectIdentifier: URLSessionDataTask] = [:]
    private var prefix = Data()
    private var fileLength: Int64?
    private var version: String?
    private var loadingBootstrap = false
    private var stopped = false
    private var failed = false
    private let onFailure: () -> Void

    private final class Transfer {
        let maximum: Int
        let type: String
        let completion: (Result<Data, Error>) -> Void
        var data = Data()
        var failure: Error?
        init(maximum: Int, type: String, completion: @escaping (Result<Data, Error>) -> Void) {
            self.maximum = maximum; self.type = type; self.completion = completion
        }
    }
    private final class NetworkDelegate: NSObject, URLSessionDataDelegate {
        weak var owner: PacketAudioAsset?
        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            guard let owner, let transfer = owner.transfers[dataTask.taskIdentifier],
                  let response = response as? HTTPURLResponse,
                  response.statusCode == 200,
                  response.value(forHTTPHeaderField: "Content-Type")?.hasPrefix(transfer.type) == true,
                  response.expectedContentLength <= transfer.maximum + 1024 else {
                completionHandler(.cancel); return
            }
            completionHandler(.allow)
        }
        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            guard let owner, let transfer = owner.transfers[dataTask.taskIdentifier] else { return }
            guard transfer.data.count + data.count <= transfer.maximum else {
                transfer.failure = owner.error("Oversized audio response"); dataTask.cancel(); return
            }
            transfer.data.append(data)
        }
        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            guard let owner, let transfer = owner.transfers.removeValue(forKey: task.taskIdentifier) else { return }
            if let failure = transfer.failure ?? error { transfer.completion(.failure(failure)) }
            else { transfer.completion(.success(transfer.data)) }
        }
        func urlSession(_ session: URLSession, task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                        completionHandler: @escaping (URLRequest?) -> Void) {
            guard let original = owner?.source, let target = request.url,
                  original.scheme == target.scheme, original.host == target.host,
                  original.port == target.port else { completionHandler(nil); return }
            completionHandler(request)
        }
    }

    init(source: URL, onFailure: @escaping () -> Void) {
        self.onFailure = onFailure
        self.source = source
        var url = URLComponents(url: source, resolvingAgainstBaseURL: false)!
        url.scheme = "packet-" + (source.scheme ?? "http")
        self.asset = AVURLAsset(url: url.url!)
        super.init()
        delegateProxy.owner = self
        let operations = OperationQueue(); operations.maxConcurrentOperationCount = 1; operations.underlyingQueue = queue
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.httpMaximumConnectionsPerHost = 2
        session = URLSession(configuration: configuration, delegate: delegateProxy, delegateQueue: operations)
        asset.resourceLoader.setDelegate(self, queue: queue)
    }
    deinit { session?.invalidateAndCancel() }
    func cancel() {
        queue.async { [weak self] in
            guard let self else { return }
            self.stopped = true
            self.session.invalidateAndCancel()
            for request in self.requests.values { request.finishLoading(with: self.error("Audio load cancelled")) }
            self.requests.removeAll(); self.pending.removeAll()
        }
    }
    private func error(_ message: String) -> NSError {
        NSError(domain: "PacketAudio", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
    private func get(_ operation: String, offset: Int64 = 0, count: Int = 0,
                     completion: @escaping (Result<Data, Error>) -> Void) -> URLSessionDataTask {
        var url = URLComponents(url: source, resolvingAgainstBaseURL: false)!
        var query = (url.queryItems ?? []).filter { !["op", "offset", "count", "revision"].contains($0.name) }
        query += [URLQueryItem(name: "op", value: operation), URLQueryItem(name: "offset", value: String(offset)),
                  URLQueryItem(name: "count", value: String(count))]
        if let version { query.append(URLQueryItem(name: "revision", value: version)) }
        url.queryItems = query
        let task = session.dataTask(with: url.url!)
        transfers[task.taskIdentifier] = Transfer(maximum: operation == "bootstrap" ? 262144 : count,
                                                type: operation == "bootstrap" ? "application/json" : "application/octet-stream",
                                                completion: completion)
        task.resume()
        return task
    }
    func resourceLoader(_ resourceLoader: AVAssetResourceLoader,
                        shouldWaitForLoadingOfRequestedResource request: AVAssetResourceLoadingRequest) -> Bool {
        guard !stopped, !failed, requests.count < 8 else { return false }
        requests[ObjectIdentifier(request)] = request
        if fileLength != nil { pump(request) }
        else if !loadingBootstrap {
            loadingBootstrap = true
            _ = get("bootstrap") { [weak self] result in
                guard let self, !self.stopped else { return }
                do {
                    let data = try result.get()
                    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let length = object["length"] as? NSNumber,
                          let revision = object["revision"] as? String, !revision.isEmpty, revision.count <= 128,
                          let encoded = object["data"] as? String,
                          let prefix = Data(base64Encoded: encoded), !prefix.isEmpty,
                          CFGetTypeID(length) != CFBooleanGetTypeID(), length.doubleValue.isFinite, length.doubleValue.rounded() == length.doubleValue,
                          length.doubleValue > 0, length.doubleValue < 9_007_199_254_740_992, prefix.count <= 65536,
                          prefix.count <= length.int64Value else { throw self.error("Invalid audio bootstrap") }
                    self.fileLength = length.int64Value; self.version = revision; self.prefix = prefix
                    for loading in Array(self.requests.values) { self.pump(loading) }
                } catch {
                    for loading in Array(self.requests.values) { self.fail(loading, error) }
                }
            }
        }
        return true
    }
    func resourceLoader(_ resourceLoader: AVAssetResourceLoader, didCancel request: AVAssetResourceLoadingRequest) {
        let id = ObjectIdentifier(request)
        requests.removeValue(forKey: id)
        pending.removeValue(forKey: id)?.cancel()
    }
    private func fail(_ request: AVAssetResourceLoadingRequest, _ error: Error) {
        let id = ObjectIdentifier(request)
        guard requests.removeValue(forKey: id) != nil else { return }
        pending.removeValue(forKey: id)?.cancel()
        request.finishLoading(with: error)
        if !failed && !stopped {
            failed = true
            DispatchQueue.main.async(execute: onFailure)
        }
    }
    private func pump(_ request: AVAssetResourceLoadingRequest) {
        let id = ObjectIdentifier(request)
        guard !stopped, requests[id] != nil, pending[id] == nil, let fileLength else { return }
        if let info = request.contentInformationRequest {
            info.contentType = AVFileType.m4a.rawValue
            info.contentLength = fileLength
            info.isByteRangeAccessSupported = true
        }
        guard let data = request.dataRequest else { requests.removeValue(forKey: id); request.finishLoading(); return }
        guard data.requestedOffset >= 0, data.requestedLength >= 0 else { fail(request, error("Invalid audio range")); return }
        let offset = max(data.currentOffset, data.requestedOffset)
        let (end, overflow) = data.requestedOffset.addingReportingOverflow(Int64(data.requestedLength))
        guard !overflow else { fail(request, error("Invalid audio range")); return }
        let requestedEnd = data.requestsAllDataToEndOfResource ? fileLength : min(fileLength, end)
        if offset >= requestedEnd { requests.removeValue(forKey: id); request.finishLoading(); return }
        if offset < prefix.count {
            let end = Int(min(requestedEnd, Int64(prefix.count)))
            data.respond(with: prefix.subdata(in: Int(offset)..<end))
            queue.async { [weak self] in self?.pump(request) }
            return
        }
        let count = Int(min(65536, requestedEnd - offset))
        pending[id] = get("range", offset: offset, count: count) { [weak self] result in
            guard let self, self.requests[id] != nil else { return }
            self.pending.removeValue(forKey: id)
            do {
                let bytes = try result.get()
                guard bytes.count == count else { throw self.error("Truncated audio range") }
                data.respond(with: bytes)
                self.pump(request)
            } catch { self.fail(request, error) }
        }
    }
}
