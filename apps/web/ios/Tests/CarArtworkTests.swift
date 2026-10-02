import XCTest
import UIKit

// The store is real; network I/O is replaced with local image fixtures.
private enum ArtworkFixture {
    static var beforeRead: ((URL) -> Void)?
}
func resolveNativeAudioSourceURL(_ source: String) -> URL? { URL(string: source) }
func fetchArtworkData(from url: URL) -> Data? {
    ArtworkFixture.beforeRead?(url)
    return try? Data(contentsOf: url)
}

final class CarArtworkTests: XCTestCase {
    private var sourcesKey: String { "operalibre.car-artwork-sources.v1" }
    private var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("CarLibrary")
    }
    private func snapshot(_ source: String?) -> CarLibrarySnapshot {
        let book = CarLibraryBook(id: "cover-book", title: "Book", author: nil, artworkUrl: source,
            durationSeconds: 600, positionSeconds: 0, status: "notStarted", downloaded: true,
            volumeGain: nil, tracks: [], chapters: [])
        return CarLibrarySnapshot(scopePrefix: "server:owner", playbackRate: 1, updatedAt: 1, books: [book])
    }
    private func image(_ color: UIColor) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let data = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20), format: format).image { context in
            color.setFill(); context.fill(CGRect(x: 0, y: 0, width: 20, height: 20))
        }.pngData()!
        try data.write(to: url)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    @MainActor
    private func waitUntil(_ description: String, _ ready: @escaping () -> Bool) {
        let check = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in ready() }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [check], timeout: 5), .completed, description)
    }
    @MainActor
    func testReplacementAndRemovalPersistWithoutRevivingCachedArtwork() throws {
        let store = CarLibraryStore()
        let first = try image(.red)
        let second = try image(.blue)
        let initial = snapshot(first.absoluteString)
        let cached = expectation(description: "initial cover cached")
        store.onArtworkChange = { cached.fulfill() }
        store.save(initial)
        wait(for: [cached], timeout: 5)
        let red = store.artwork(for: initial.books[0]).pngData()
        XCTAssertEqual(store.artwork(for: initial.books[0]).size.width, 20)

        let replaced = snapshot(second.absoluteString)
        let refreshed = expectation(description: "replacement redraws the car list")
        store.onArtworkChange = { refreshed.fulfill() }
        store.save(replaced)
        wait(for: [refreshed], timeout: 5)
        XCTAssertNotEqual(store.artwork(for: replaced.books[0]).pngData(), red)

        for source in [nil, ""] as [String?] {
            let removed = snapshot(source)
            store.save(removed)
            XCTAssertEqual(store.artwork(for: removed.books[0]).size.width, 108, "removal immediately displays the placeholder")
            waitUntil("removed image and source mapping are evicted") {
                let sources = UserDefaults.standard.dictionary(forKey: self.sourcesKey) ?? [:]
                let images = (try? FileManager.default.contentsOfDirectory(atPath: self.directory.appendingPathComponent("artwork").path)) ?? []
                return sources["cover-book"] == nil && images.isEmpty
            }
            waitUntil("removed artwork survives a fresh store") {
                let reopened = CarLibraryStore()
                guard let book = reopened.snapshot().books.first, book.artworkUrl == source else { return false }
                return reopened.artwork(for: book).size.width == 108
            }
        }
        store.clear()
    }

    @MainActor
    func testRemovalDuringAnArtworkReadCannotRepopulateItsCache() throws {
        let store = CarLibraryStore()
        let source = try image(.green)
        let started = expectation(description: "read started")
        let release = DispatchSemaphore(value: 0)
        ArtworkFixture.beforeRead = { url in
            guard url == source else { return }
            started.fulfill()
            _ = release.wait(timeout: .now() + 5)
        }
        defer { ArtworkFixture.beforeRead = nil; release.signal() }
        store.save(snapshot(source.absoluteString))
        wait(for: [started], timeout: 5)
        let removed = snapshot(nil)
        store.save(removed)
        release.signal()
        waitUntil("late read is removed from disk") {
            let sources = UserDefaults.standard.dictionary(forKey: self.sourcesKey) ?? [:]
            let images = (try? FileManager.default.contentsOfDirectory(atPath: self.directory.appendingPathComponent("artwork").path)) ?? []
            return sources["cover-book"] == nil && images.isEmpty
        }
        var missing = snapshot("file:///unavailable-cover.png")
        var marker = snapshot(source.absoluteString).books[0]
        marker.id = "marker"
        missing.books.append(marker)
        let drained = expectation(description: "subsequent cache job finishes")
        ArtworkFixture.beforeRead = nil
        store.onArtworkChange = { drained.fulfill() }
        store.save(missing)
        wait(for: [drained], timeout: 5)
        XCTAssertNil(UserDefaults.standard.dictionary(forKey: sourcesKey)?["cover-book"])
        XCTAssertEqual(store.artwork(for: missing.books[0]).size.width, 108, "the late old image cannot remain in memory")
        store.clear()
    }
}
