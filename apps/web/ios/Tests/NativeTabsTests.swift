import Capacitor
import UIKit
import WebKit
import XCTest

@MainActor
private final class ViewportPageLoad: NSObject, WKNavigationDelegate {
    let loaded: XCTestExpectation
    init(_ loaded: XCTestExpectation) { self.loaded = loaded }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded.fulfill() }
}

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

    func testNativeResizeReachesLoadedWebDocumentWithoutDuplicateLayoutEvents() async throws {
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 669, height: 951))
        let loaded = expectation(description: "Viewport document loaded")
        let observer = ViewportPageLoad(loaded)
        webView.navigationDelegate = observer
        webView.loadHTMLString("""
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <script>
            window.sizes = [];
            window.addEventListener('operalibre:viewportchange', event => {
                window.sizes.push([event.detail.width, event.detail.height]);
                document.documentElement.style.setProperty('--layout-height', event.detail.height + 'px');
            });
            </script>
            """, baseURL: nil)
        await fulfillment(of: [loaded], timeout: 10)
        let content = ViewController()
        content.view = webView
        content.webView = webView
        let controller = NativeTabsController(content: content)
        controller.loadViewIfNeeded()
        for size in [CGSize(width: 669, height: 951), CGSize(width: 466, height: 678),
                     CGSize(width: 466, height: 678), CGSize(width: 669, height: 951)] {
            controller.view.frame.size = size
            controller.view.setNeedsLayout()
            controller.view.layoutIfNeeded()
        }
        let sizes = try await webView.evaluateJavaScript("JSON.stringify(window.sizes)") as? String
        XCTAssertEqual(sizes, "[[669,951],[466,678],[669,951]]")
        let height = try await webView.evaluateJavaScript(
            "document.documentElement.style.getPropertyValue('--layout-height')") as? String
        XCTAssertEqual(height, "951px")
        controller.contentDidLayout(force: true)
        let settledSizes = try await webView.evaluateJavaScript("JSON.stringify(window.sizes)") as? String
        XCTAssertEqual(settledSizes, "[[669,951],[466,678],[669,951],[669,951]]")
        _ = observer
    }

    func testWebViewFollowsRepeatedResizesWithoutRotationOrReplacement() throws {
        let content = ViewController()
        let webView = WKWebView()
        content.view = webView
        let controller = NativeTabsController(content: content)
        controller.loadViewIfNeeded()
        configure(controller)
        for size in [CGSize(width: 740, height: 960), CGSize(width: 320, height: 500),
                     CGSize(width: 740, height: 960), CGSize(width: 1000, height: 600)] {
            controller.view.frame = CGRect(origin: .zero, size: size)
            controller.view.setNeedsLayout()
            controller.view.layoutIfNeeded()
            XCTAssertTrue(content.view === webView)
            XCTAssertEqual(webView.frame.height, size.height, accuracy: 0.5)
            XCTAssertEqual(webView.frame.width, size.width, accuracy: 0.5)
            controller.hide()
            controller.view.layoutIfNeeded()
            XCTAssertEqual(webView.frame, controller.view.bounds)
            configure(controller)
        }
    }

    @available(iOS 18.0, *)
    func testFloatingTabPresentationFollowsHostGeometryAcrossWindowResizes() async throws {
        let webView = WKWebView()
        let loaded = expectation(description: "Tab presentation document loaded")
        let observer = ViewportPageLoad(loaded)
        webView.navigationDelegate = observer
        webView.loadHTMLString("<meta name='viewport' content='width=device-width,initial-scale=1'>", baseURL: nil)
        await fulfillment(of: [loaded], timeout: 10)
        let content = ViewController()
        content.view = webView
        content.webView = webView
        let controller = NativeTabsController(content: content)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1024, height: 768))
        window.rootViewController = controller
        window.isHidden = false
        defer { window.isHidden = true }
        controller.traitOverrides.userInterfaceIdiom = .pad
        configure(controller)
        let navigation = try XCTUnwrap(controller.children.compactMap { $0 as? UITabBarController }.first)
        var presentations: [Bool] = []
        for (width, sizeClass) in [(1024.0, UIUserInterfaceSizeClass.regular),
                                   (375.0, UIUserInterfaceSizeClass.compact),
                                   (1024.0, UIUserInterfaceSizeClass.regular)] {
            window.frame.size.width = width
            controller.traitOverrides.horizontalSizeClass = sizeClass
            window.layoutIfNeeded()
            controller.view.setNeedsLayout()
            controller.view.layoutIfNeeded()
            navigation.view.layoutIfNeeded()
            let host = try XCTUnwrap(navigation.selectedViewController)
            // The hostless bundle does not render iPad's floating platter.
            // Supply its content clearance through UIKit's real safe area.
            host.additionalSafeAreaInsets.top = sizeClass == .regular ? 68 : 0
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            controller.viewDidLayoutSubviews()
            let frame = host.view.convert(host.view.safeAreaLayoutGuide.layoutFrame, to: controller.view)
            let top = max(0, (frame.minY - controller.view.safeAreaInsets.top).rounded())
            let floating = try await webView.evaluateJavaScript(
                "document.documentElement.classList.contains('floating-tabs')") as? Bool
            XCTAssertEqual(floating, top > 0)
            presentations.append(top > 0)
            let sentTop = try await webView.evaluateJavaScript(
                "document.documentElement.style.getPropertyValue('--native-tabs-top')") as? String
            XCTAssertEqual(sentTop, "\(Int(top))px")
            let bar = navigation.tabBar.convert(navigation.tabBar.bounds, to: controller.view)
            let bottom = top == 0 && bar.intersects(controller.view.bounds)
                && bar.width >= controller.view.bounds.width / 2 && bar.midY >= controller.view.bounds.midY
                ? controller.view.bounds.maxY - bar.minY : 0
            XCTAssertEqual(content.additionalSafeAreaInsets.bottom,
                           max(0, bottom - controller.view.safeAreaInsets.bottom), accuracy: 0.5)
        }
        XCTAssertEqual(presentations, [true, false, true])
        _ = observer
    }

    #if compiler(>=6.4)
    @available(iOS 27.1, *)
    func testHiddenReaderRailFollowsPhysicalEdgeAndLayoutDirection() {
        let bounds = CGRect(x: 0, y: 0, width: 1000, height: 600)
        let insets = UIEdgeInsets(top: 24, left: 90, bottom: 20, right: 110)
        for direction in [UIUserInterfaceLayoutDirection.leftToRight, .rightToLeft] {
            let leftEdge: UIVerticalBarEdge = direction == .leftToRight ? .leading : .trailing
            let rightEdge: UIVerticalBarEdge = direction == .leftToRight ? .trailing : .leading
            XCTAssertEqual(NativeTabsController.hiddenRailColumn(in: bounds, insets: insets,
                                                                 edge: leftEdge, direction: direction),
                           CGRect(x: 0, y: 0, width: 90, height: 600))
            XCTAssertEqual(NativeTabsController.hiddenRailColumn(in: bounds, insets: insets,
                                                                 edge: rightEdge, direction: direction),
                           CGRect(x: 890, y: 0, width: 110, height: 600))
        }
    }

    @available(iOS 27.1, *)
    func testHiddenReaderRailDoesNotMistakeNotchOrUnresolvedGeometryForBar() {
        let bounds = CGRect(x: 0, y: 0, width: 1000, height: 600)
        XCTAssertNil(NativeTabsController.hiddenRailColumn(in: bounds,
            insets: UIEdgeInsets(top: 0, left: 80, bottom: 20, right: 80),
            edge: .unspecified, direction: .leftToRight))
        XCTAssertNil(NativeTabsController.hiddenRailColumn(in: bounds, insets: .zero,
            edge: .trailing, direction: .leftToRight))
    }
    #endif

    func testStartupSelectionIsConfiguredBeforeBarIsAttached() async throws {
        let controller = NativeTabsController(content: ViewController())
        let startupItems: [JSObject] = [
            ["id": "shelf", "title": "Shelf"],
            ["id": "reading", "title": "Reading"]
        ]
        var selections: [String] = []
        controller.onSelect = { selections.append($0) }
        for selected in ["shelf", "reading", "shelf", "reading"] {
            controller.configure(items: startupItems, selected: selected, visible: false,
                                 blocked: false, appearance: "system", chrome: nil, bar: nil)
            XCTAssertFalse(controller.children.contains { $0 is UITabBarController })
        }
        controller.configure(items: startupItems, selected: "reading", visible: true,
                             blocked: false, appearance: "system", chrome: nil, bar: nil)
        let navigation = try XCTUnwrap(controller.children.compactMap { $0 as? UITabBarController }.first)
        // iPad intentionally represents Reading with its unified Shelf tab.
        let unifiedShelf = controller.traitCollection.userInterfaceIdiom == .pad
        if #available(iOS 18.0, *) {
            XCTAssertEqual(navigation.selectedTab?.identifier, unifiedShelf ? "shelf" : "reading")
        } else {
            XCTAssertEqual(navigation.selectedIndex, unifiedShelf ? 0 : 1)
        }
        await flushSelection()
        XCTAssertTrue(selections.isEmpty)
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
