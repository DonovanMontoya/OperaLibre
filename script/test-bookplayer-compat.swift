// Appended to unchanged BookPlayer response models by test-bookplayer-compat.py.
// Run only through the isolated Rust fixture test documented in that script.

func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() { throw NSError(domain: message, code: 1) }
}

final class FeedLinks: NSObject, XMLParserDelegate {
  var links: [(String, String)] = []
  func parser(_ parser: XMLParser, didStartElement elementName: String,
              namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
    if elementName == "link", let rel = attributes["rel"], let href = attributes["href"] {
      links.append((rel, href))
    }
  }
}

func checkContract() async throws {
  let base = URL(string: CommandLine.arguments[1])!
  var token: String?
  func request(_ path: String, method: String = "GET", body: [String: Any]? = nil,
               range: String? = nil) async throws -> (Data, HTTPURLResponse) {
    let url = URL(string: base.absoluteString + "/" + path)!
    var request = URLRequest(url: url)
    request.httpMethod = method
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    if let range { request.setValue(range, forHTTPHeaderField: "Range") }
    if let body {
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    return (data, response as! HTTPURLResponse)
  }
  func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
    let (data, response) = try await request(path)
    try require(response.statusCode == 200, "GET \(path) returned \(response.statusCode)")
    return try JSONDecoder().decode(type, from: data)
  }
  let (ping, _) = try await request("ping")
  let pingJSON = try JSONSerialization.jsonObject(with: ping) as! [String: Any]
  try require(pingJSON["success"] as? Bool == true, "ping")
  let (status, _) = try await request("status")
  let statusJSON = try JSONSerialization.jsonObject(with: status) as! [String: Any]
  try require(statusJSON["authMethods"] as? [String] == ["local"], "local login discovery")
  let (login, response) = try await request("login", method: "POST", body: ["username": "owner", "password": "owner-password-1234"])
  try require(response.statusCode == 200, "login")
  let json = try JSONSerialization.jsonObject(with: login) as! [String: Any]
  token = (json["user"] as! [String: Any])["token"] as? String
  try require(token != nil, "login token")

  let libraries = try await get("api/libraries", as: AudiobookShelfLibrariesResponse.self)
  try require(libraries.libraries.count == 1, "library count")
  let id = libraries.libraries[0].id
  let items = try await get("api/libraries/\(id)/items?limit=1&page=0", as: AudiobookShelfItemsResponse.self)
  try require(items.total == 2 && items.results.count == 1, "pagination")
  let next = try await get("api/libraries/\(id)/items?limit=1&page=1", as: AudiobookShelfItemsResponse.self)
  try require(next.results[0].id != items.results[0].id, "second page")
  let item = items.results[0]
  try require(item.media.metadata.series?.first?.sequence == "2.5", "listing series")
  let details = try await get("api/items/\(item.id)?expanded=1", as: AudiobookShelfItemDetailsResponse.self)
  try require(details.libraryFiles.count == 2 && details.media.audioFiles?.count == 2, "expanded files")
  try require(details.media.metadata.series?.first?.sequence == "2.5", "detail series")
  try require(details.media.tags == ["Favorite"], "detail tags")
  let filters = try await get("api/libraries/\(id)/filterdata", as: AudiobookShelfLibraryFilterData.self)
  try require(filters.series.first?.id == item.media.metadata.series?.first?.id, "stable series ID")
  let encoded = Data(filters.series[0].id.utf8).base64EncodedString().addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
  let filtered = try await get("api/libraries/\(id)/items?filter=series.\(encoded)", as: AudiobookShelfItemsResponse.self)
  try require(filtered.total == 2, "series filter")
  let search = try await get("api/libraries/\(id)/search?q=Book", as: AudiobookShelfSearchResponse.self)
  try require(search.book.count == 2, "search")
  _ = try await get("api/libraries/\(id)/collections?minified=1", as: AudiobookShelfCollectionsResponse.self)

  let (_, saved) = try await request("api/me/progress/\(item.id)", method: "PATCH", body: ["currentTime": 4.0, "duration": 20.0])
  try require(saved.statusCode == 200, "save progress")
  let updated = try await get("api/items/\(item.id)", as: AudiobookShelfAPIItem.self)
  try require(updated.userMediaProgress?.currentTime == 4, "nested progress")
  try require(updated.userMediaProgress?.progress == 0.2, "progress fraction")

  let (archive, downloaded) = try await request("api/items/\(item.id)/download")
  try require(downloaded.statusCode == 200, "download status")
  try require(downloaded.suggestedFilename?.hasSuffix(".zip") == true, "import filename")
  let temp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".zip")
  defer { try? FileManager.default.removeItem(at: temp) }
  try archive.write(to: temp)
  let unzip = Process()
  unzip.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
  unzip.arguments = ["-t", temp.path]
  let output = Pipe()
  unzip.standardOutput = output
  try unzip.run()
  unzip.waitUntilExit()
  try require(unzip.terminationStatus == 0, "ZIP integrity")

  // OPDS is a separate protocol, tested here with Foundation's XML parser.
  let origin = URL(string: "/", relativeTo: base)!.absoluteURL
  var feedRequest = URLRequest(url: origin.appendingPathComponent("api/opds"))
  feedRequest.setValue("Bearer \(token!)", forHTTPHeaderField: "Authorization")
  let (feed, feedResponse) = try await URLSession.shared.data(for: feedRequest)
  try require((feedResponse as! HTTPURLResponse).statusCode == 200, "OPDS root")
  let rootLinks = FeedLinks()
  let rootParser = XMLParser(data: feed)
  rootParser.delegate = rootLinks
  try require(rootParser.parse(), "OPDS root XML")
  let shelf = rootLinks.links.first { $0.0 == "subsection" }!.1
  let (booksFeed, booksResponse) = try await URLSession.shared.data(from: URL(string: shelf, relativeTo: origin)!)
  try require((booksResponse as! HTTPURLResponse).statusCode == 200, "OPDS token navigation")
  let bookLinks = FeedLinks()
  let booksParser = XMLParser(data: booksFeed)
  booksParser.delegate = bookLinks
  try require(booksParser.parse(), "OPDS acquisition XML")
  let audioLink = bookLinks.links.first { $0.0 == "http://opds-spec.org/acquisition" }!.1
  var audioRequest = URLRequest(url: URL(string: audioLink, relativeTo: origin)!)
  audioRequest.setValue("bytes=0-43", forHTTPHeaderField: "Range")
  let (audio, audioResponse) = try await URLSession.shared.data(for: audioRequest)
  try require((audioResponse as! HTTPURLResponse).statusCode == 206 && audio.count == 44, "OPDS ranged download")
  try require(String(data: audio.prefix(4), encoding: .ascii) == "RIFF", "audio bytes")

  let (_, logout) = try await request("logout", method: "POST")
  try require(logout.statusCode == 200, "logout")
  let (_, revoked) = try await request("api/libraries")
  try require(revoked.statusCode == 401, "token revocation")
  print("PASS: upstream BookPlayer decoders; discovery, login, libraries, pagination, metadata, filters, search, collections, progress, ZIP download, logout; OPDS XML, token navigation and ranged audio download")
}

Task {
  do { try await checkContract(); exit(0) }
  catch { print("FAIL: \(error)"); exit(1) }
}
dispatchMain()
