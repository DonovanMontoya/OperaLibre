import Capacitor
import UIKit
import XCTest

/// Compile alongside NativeTabs.swift. The isolated test bundle supplies a
/// plain ViewController with an optional webView; no app plugins are needed here.
@MainActor
final class NativeTabsTests: XCTestCase {
    private let items: [JSObject] = [
        ["id": "shelf", "title": "Shelf"],
        ["id": "settings", "title": "Settings"]
    ]

    private func configure(_ controller: NativeTabsController, selected: String = "settings") {
        controller.configure(items: items, selected: selected, visible: true,
                             blocked: false, appearance: "system", chrome: nil, bar: nil)
    }

    private func flushSelection() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
    }

    func testLegacyCallbackOnModernIOSStillNavigates() async throws {
        let controller = NativeTabsController(content: ViewController())
        configure(controller)
        let navigation = try XCTUnwrap(controller.children.compactMap { $0 as? UITabBarController }.first)
        let shelf: UIViewController
        if #available(iOS 18.0, *) {
            shelf = try XCTUnwrap(navigation.tabs.first?.viewController)
        } else {
            shelf = try XCTUnwrap(navigation.viewControllers?.first)
        }
        var selected: [String] = []
        controller.onSelect = { selected.append($0) }
        controller.tabBarController(navigation, didSelect: shelf)
        await flushSelection()
        XCTAssertEqual(selected, ["shelf"])
    }

    @available(iOS 18.0, *)
    func testModernCallbackUsesIdentifierWithoutAContentController() async {
        let controller = NativeTabsController(content: ViewController())
        configure(controller)
        var selected: [String] = []
        controller.onSelect = { selected.append($0) }
        let tab = UITab(title: "Shelf", image: nil, identifier: "shelf", viewControllerProvider: nil)
        controller.tabBarController(UITabBarController(), didSelectTab: tab, previousTab: nil)
        await flushSelection()
        XCTAssertEqual(selected, ["shelf"])
    }

    @available(iOS 18.0, *)
    func testBothCallbacksNavigateOnceAndLaterRetapsStillNavigate() async throws {
        let controller = NativeTabsController(content: ViewController())
        configure(controller)
        let navigation = try XCTUnwrap(controller.children.compactMap { $0 as? UITabBarController }.first)
        let tab = try XCTUnwrap(navigation.tabs.first)
        let shelf = try XCTUnwrap(tab.viewController)
        var selected: [String] = []
        controller.onSelect = { selected.append($0) }
        controller.tabBarController(navigation, didSelect: shelf)
        controller.tabBarController(navigation, didSelectTab: tab, previousTab: nil)
        await flushSelection()
        XCTAssertEqual(selected, ["shelf"])
        controller.tabBarController(navigation, didSelectTab: tab, previousTab: tab)
        controller.tabBarController(navigation, didSelect: shelf)
        await flushSelection()
        XCTAssertEqual(selected, ["shelf", "shelf"])
    }

    @available(iOS 18.0, *)
    func testConfigurationAndUnknownTabsDoNotEmitNavigation() async {
        let controller = NativeTabsController(content: ViewController())
        var selected: [String] = []
        controller.onSelect = { selected.append($0) }
        configure(controller)
        configure(controller, selected: "shelf")
        let tab = UITab(title: "Unknown", image: nil, identifier: "unknown", viewControllerProvider: nil)
        controller.tabBarController(UITabBarController(), didSelectTab: tab, previousTab: nil)
        await flushSelection()
        XCTAssertTrue(selected.isEmpty)
    }
}
