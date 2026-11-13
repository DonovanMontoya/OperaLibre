// Test-only transport for generated fixtures; not an application streaming implementation.
import Foundation
import Network

final class BootstrapProxy {
  var files: [String: Data] = [:]
  var remote: URL!
  var listener: NWListener?
  // Listener callbacks are serialized on work.
  var listenerSettled = false
  var connections: [NWConnection] = []
  let work = DispatchQueue(label: "streaming.bootstrap")
  let session = URLSession(configuration: .ephemeral)
  func prepare(base: String, speed: Int, id: String, target: Int) async throws -> URL {
    remote = URL(string: "\(base)/run/\(speed)/\(id)/hls/")!
    let (body, response) = try await session.data(
      from: URL(string: "\(base)/run/\(speed)/\(id)/bootstrap-\(target).json")!)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else {
      throw NSError(domain: "bootstrap", code: 1)
    }
    let encoded = try JSONDecoder().decode([String: String].self, from: body)
    for (name, value) in encoded {
      guard let data = Data(base64Encoded: value) else { throw NSError(domain: "base64", code: 1) }
      files[name] = data
    }
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    let listener = try NWListener(using: parameters)
    self.listener = listener
    listener.newConnectionHandler = { [weak self] c in self?.accept(c) }
    let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
      listener.stateUpdateHandler = { state in
        switch state {
        case .ready:
          if !self.listenerSettled {
            self.listenerSettled = true
            continuation.resume(returning: listener.port!.rawValue)
          }
        case .failed(let error):
          if !self.listenerSettled {
            self.listenerSettled = true
            continuation.resume(throwing: error)
          }
        default: break
        }
      }
      listener.start(queue: work)
    }
    return URL(string: "http://127.0.0.1:\(port)/book.m3u8")!
  }
  func accept(_ c: NWConnection) {
    guard connections.count < 32 else {
      c.cancel()
      return
    }
    connections.append(c)
    c.stateUpdateHandler = { [weak self, weak c] state in
      if case .cancelled = state { self?.connections.removeAll { $0 === c } }
    }
    c.start(queue: work)
    read(c, buffer: Data())
  }
  func read(_ c: NWConnection, buffer: Data) {
    c.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, done, error in
      guard let self else { return }
      var buffer = buffer
      if let data { buffer.append(data) }
      guard let text = String(data: buffer, encoding: .utf8), text.contains("\r\n\r\n") else {
        if done || error != nil || buffer.count > 16384 {
          c.cancel()
        } else {
          self.read(c, buffer: buffer)
        }
        return
      }
      let fields = text.components(separatedBy: "\r\n")[0].split(separator: " ")
      guard fields.count >= 2 else {
        c.cancel()
        return
      }
      let name = String(fields[1]).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
      guard !name.contains(".."), !name.contains("/") else {
        c.cancel()
        return
      }
      if let bytes = self.files[name] {
        self.send(c, name: name, bytes: bytes)
        return
      }
      let task = self.session.dataTask(with: self.remote.appendingPathComponent(name)) {
        [weak self] data, response, error in
        guard let self else { return }
        self.work.async {
          guard let data, error == nil, (response as? HTTPURLResponse)?.statusCode == 200 else {
            c.cancel()
            return
          }
          self.send(c, name: name, bytes: data)
        }
      }
      task.resume()
    }
  }
  func send(_ c: NWConnection, name: String, bytes: Data) {
    let type = name.hasSuffix(".m3u8") ? "application/vnd.apple.mpegurl" : "audio/mp4"
    var data = Data(
      "HTTP/1.1 200 OK\r\nContent-Type: \(type)\r\nContent-Length: \(bytes.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        .utf8)
    data.append(bytes)
    c.send(content: data, completion: .contentProcessed { _ in c.cancel() })
  }
  func stop() {
    session.invalidateAndCancel()
    work.async {
      self.listener?.cancel()
      for connection in self.connections { connection.cancel() }
      self.connections.removeAll()
    }
  }
}
