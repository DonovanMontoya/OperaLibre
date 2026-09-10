import Foundation
import Security
import Capacitor
import ZIPFoundation

private struct LibroDeviceError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Owns the device connection. Tokens never cross the JavaScript bridge.
@objc(LibroDevicePlugin)
public class LibroDevicePlugin: CAPPlugin, CAPBridgedPlugin, URLSessionTaskDelegate {
    public let identifier = "LibroDevicePlugin"
    public let jsName = "LibroDevice"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise)]
    private let queue = DispatchQueue(label: "com.operalibre.libro-device")
    private let service = "com.operalibre.libro-device"
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 25
        config.timeoutIntervalForResource = 30
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    public func urlSession(_ session: URLSession, task: URLSessionTask,
                           willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil) // Never forward a password or bearer to a redirect.
    }

    private func keyQuery() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: "connection"]
    }

    private func connection() throws -> [String: String]? {
        var query = keyQuery()
        query[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let value = try JSONSerialization.jsonObject(with: data) as? [String: String] else {
            throw LibroDeviceError(message: "Unlock this device to read the Libro.fm connection.")
        }
        return value
    }

    private func save(_ value: [String: String]) throws {
        let data = try JSONSerialization.data(withJSONObject: value)
        let attributes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(keyQuery() as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var query = keyQuery()
            attributes.forEach { query[$0.key] = $0.value }
            guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else {
                throw LibroDeviceError(message: "Could not securely save the Libro.fm connection.")
            }
        } else if status != errSecSuccess {
            throw LibroDeviceError(message: "Could not securely save the Libro.fm connection.")
        }
    }

    private func api(_ path: String, token: String? = nil, body: [String: String]? = nil) throws -> JSObject {
        var request = URLRequest(url: URL(string: "https://libro.fm/" + path)!)
        request.setValue("7.34.8", forHTTPHeaderField: "X-LibroFm-AppVer")
        request.setValue("okhttp/5.3.2", forHTTPHeaderField: "User-Agent")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let semaphore = DispatchSemaphore(value: 0)
        var result: Result<JSObject, Error> = .failure(LibroDeviceError(message: "Could not reach Libro.fm. Check your internet connection."))
        session.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            guard error == nil, let http = response as? HTTPURLResponse else { return }
            if http.statusCode == 404 && path.contains("packaged_m4b") {
                result = .success(["unavailable": true]); return
            }
            guard (200...299).contains(http.statusCode) else {
                result = .failure(LibroDeviceError(message: [401,403].contains(http.statusCode)
                    ? "Libro.fm could not authorize this request. Reconnect the device account."
                    : "Libro.fm returned HTTP \(http.statusCode). Try again later.")); return
            }
            guard let data, data.count <= 8 * 1024 * 1024,
                  let json = try? JSONSerialization.jsonObject(with: data) as? JSObject else {
                result = .failure(LibroDeviceError(message: "Unexpected Libro.fm response.")); return
            }
            result = .success(json)
        }.resume()
        semaphore.wait()
        return try result.get()
    }

    @objc func request(_ call: CAPPluginCall) {
        queue.async {
            do { call.resolve(try self.perform(call)) }
            catch { call.reject((error as? LibroDeviceError)?.message ?? "The device operation could not finish. Check storage and retry.") }
        }
    }

    private func perform(_ call: CAPPluginCall) throws -> JSObject {
        switch call.getString("action") {
        case "status":
            let account = try connection()
            return ["connected": account != nil, "email": account?["email"] ?? ""]
        case "disconnect":
            let status = SecItemDelete(keyQuery() as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw LibroDeviceError(message: "Could not remove the connection.") }
            return [:]
        case "connect":
            let email = (call.getString("email") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let password = call.getString("password") ?? ""
            guard !email.isEmpty, email.count <= 320, !password.isEmpty, password.count <= 1024 else { throw LibroDeviceError(message: "Enter your Libro.fm email and password.") }
            let json = try api("oauth/token", body: ["grant_type":"password", "username":email, "password":password])
            guard let token = json["access_token"] as? String, !token.isEmpty, token.count < 16384 else { throw LibroDeviceError(message: "Libro.fm did not provide a token.") }
            try save(["email":email, "token":token])
            return ["connected":true, "email":email]
        case "extract": return try extract(call)
        case "page":
            guard let page = call.getInt("page"), (1...200).contains(page), let token = try connection()?["token"] else { throw LibroDeviceError(message: "Connect the device account first.") }
            return try api("api/v10/library?page=\(page)", token: token)
        case "m4b", "manifest":
            guard let isbn = call.getString("isbn"), isbn.range(of: "^[0-9X]{10,13}$", options: .regularExpression) != nil,
                  let token = try connection()?["token"] else { throw LibroDeviceError(message: "Connect the device account first.") }
            return try api(call.getString("action") == "m4b" ? "api/v10/audiobooks/\(isbn)/packaged_m4b" : "api/v10/download-manifest?isbn=\(isbn)", token: token)
        default: throw LibroDeviceError(message: "Unsupported device operation.")
        }
    }

    private func extract(_ call: CAPPluginCall) throws -> JSObject {
        guard let folder = call.getString("folder"), folder.range(of: "^libro-[a-f0-9-]{36}$", options: .regularExpression) != nil else { throw LibroDeviceError(message: "Invalid download folder.") }
        let root = try backgroundOfflineMediaRoot()
        let directory = try validatedBackgroundMediaDestination(root.appendingPathComponent(folder))
        let fm = FileManager.default
        let output = directory.appendingPathComponent("extracted")
        // Only our generated extraction subdirectory is replaced on recovery.
        if fm.fileExists(atPath: output.path) { try fm.removeItem(at: output) }
        try fm.createDirectory(at: output, withIntermediateDirectories: true)
        var files: [JSObject] = []
        var bytes: Int64 = 0
        var names = Set<String>()
        var entries = 0
        do {
            for url in try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                if url.pathExtension == "m4b" {
                    files.append(["name":url.lastPathComponent, "path":url.absoluteString]); continue
                }
                guard url.pathExtension == "zip" else { continue }
                let archive = try Archive(url: url, accessMode: .read)
                for entry in archive {
                    entries += 1
                    guard entries <= 10000, entry.type != .symlink,
                          !entry.path.hasPrefix("/"), !entry.path.contains("\\"), !entry.path.split(separator: "/").contains("..") else { throw LibroDeviceError(message: "Unsafe or oversized archive.") }
                    guard entry.type == .file, entry.path.lowercased().hasSuffix(".mp3") else { continue }
                    let name = (entry.path as NSString).lastPathComponent
                    guard names.insert(name.lowercased()).inserted else { throw LibroDeviceError(message: "Duplicate track names in archive.") }
                    let target = output.appendingPathComponent(name)
                    guard fm.createFile(atPath: target.path, contents: nil) else { throw LibroDeviceError(message: "Could not create a track.") }
                    let handle = try FileHandle(forWritingTo: target)
                    defer { try? handle.close() }
                    var trackBytes: Int64 = 0
                    let checksum = try archive.extract(entry) { data in
                        bytes += Int64(data.count); trackBytes += Int64(data.count)
                        let free = (try fm.attributesOfFileSystem(forPath: output.path)[.systemFreeSize] as? NSNumber)?.int64Value ?? 0
                        guard bytes <= maximumBackgroundDownloadBytes, free > 256 * 1024 * 1024 else { throw LibroDeviceError(message: "Not enough space or archive exceeds 25 GiB.") }
                        try handle.write(contentsOf: data)
                    }
                    guard trackBytes > 0, UInt64(trackBytes) == entry.uncompressedSize, checksum == entry.checksum else { throw LibroDeviceError(message: "Incomplete or damaged track.") }
                    files.append(["name":name, "path":target.absoluteString])
                }
            }
            guard !files.isEmpty, files.count <= 10000 else { throw LibroDeviceError(message: "No complete audio found.") }
            return ["files":files]
        } catch { try? fm.removeItem(at: output); throw error }
    }
}
