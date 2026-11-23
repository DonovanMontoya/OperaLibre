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
            if top > 0 {
                // Touches below the floating bar's reserved band belong to the page.
                let below = controller.view.hitTest(CGPoint(x: controller.view.bounds.midX, y: frame.minY + 40),
                                                    with: nil)
                XCTAssertFalse(below?.isDescendant(of: navigation.view) ?? false)
            }
        }
        XCTAssertEqual(presentations, [true, false, true])
        _ = observer
    }

    func testSideColumnOutsideTheWindowSafeAreaIsReservedForThePage() {
        // Split beside another app: the column holds only the tab bar.
        let split = UIEdgeInsets(top: 0, left: 0, bottom: 21, right: 0)
        XCTAssertEqual(NativeTabsController.sideColumnReserve(width: 84, onLeft: true, safeArea: split),
                       UIEdgeInsets(top: 0, left: 84, bottom: 0, right: 0))
        XCTAssertEqual(NativeTabsController.sideColumnReserve(width: 84, onLeft: false, safeArea: split),
                       UIEdgeInsets(top: 0, left: 0, bottom: 0, right: 84))
        // Cover screen: the clock's column is already outside the safe area.
        let cover = UIEdgeInsets(top: 0, left: 0, bottom: 21, right: 84)
        XCTAssertEqual(NativeTabsController.sideColumnReserve(width: 84, onLeft: false, safeArea: cover), .zero)
    }

    /// Shaped like UIKit's cover-screen bar: an empty UITabBar spanning the
    /// column, and a separately hosted platter drawing each tab twice.
    private func coverScreenTabs(tabs: Int = 5, platterX: CGFloat = 24) -> (root: UIView, platter: UIView) {
        let root = UIView(frame: CGRect(x: 0, y: 0, width: 678, height: 466))
        let passthrough = UIView(frame: root.bounds)
        passthrough.addSubview(UITabBar(frame: CGRect(x: 0, y: 0, width: 132, height: 466)))
        root.addSubview(passthrough)
        let hosting = UIView(frame: root.bounds)
        let glass = UIView(frame: CGRect(x: platterX, y: 180, width: 48, height: 262))
        let platter = UIView(frame: glass.bounds)
        for _ in 0..<2 {
            let copy = UIView(frame: platter.bounds)
            for index in 0..<tabs {
                copy.addSubview(UIControl(frame: CGRect(x: 2, y: 2 + CGFloat(index) * 50, width: 44, height: 58)))
            }
            platter.addSubview(copy)
        }
        let pocket = UIView(frame: CGRect(x: 0, y: 0, width: 79, height: 466))
        pocket.isHidden = true
        pocket.addSubview(UIControl(frame: CGRect(x: 0, y: 0, width: 40, height: 40)))
        hosting.addSubview(pocket)
        glass.addSubview(platter)
        hosting.addSubview(glass)
        root.addSubview(hosting)
        return (root, platter)
    }

    func testSideTabControlsAreTheViewHoldingEveryTab() throws {
        let (root, platter) = coverScreenTabs()
        let column = CGRect(x: 0, y: 0, width: 84, height: 466)
        let host = UIView(frame: root.bounds)
        host.addSubview(UIControl(frame: CGRect(x: 0, y: 0, width: 60, height: 60)))
        root.insertSubview(host, at: 0)
        let frame = try XCTUnwrap(NativeTabsController.tabControlsFrame(
            in: root, excluding: [host], tabCount: 5, within: column, in: root))
        XCTAssertEqual(frame, platter.convert(platter.bounds, to: root))
        XCTAssertEqual(frame, CGRect(x: 24, y: 180, width: 48, height: 262))
    }

    func testAmbiguousSideTabControlsLeaveNoRegion() {
        let column = CGRect(x: 0, y: 0, width: 84, height: 466)
        // Fewer distinct controls than configured tabs.
        let missing = coverScreenTabs(tabs: 4).root
        XCTAssertNil(NativeTabsController.tabControlsFrame(
            in: missing, excluding: [], tabCount: 5, within: column, in: missing))
        // The controls sit outside the column the page would give up.
        let outside = coverScreenTabs(platterX: 300).root
        XCTAssertNil(NativeTabsController.tabControlsFrame(
            in: outside, excluding: [], tabCount: 5, within: column, in: outside))
        // Controls with no container below the bar's root.
        let scattered = UIView(frame: CGRect(x: 0, y: 0, width: 678, height: 466))
        scattered.addSubview(UIControl(frame: CGRect(x: 10, y: 10, width: 44, height: 44)))
        scattered.addSubview(UIControl(frame: CGRect(x: 10, y: 80, width: 44, height: 44)))
        XCTAssertNil(NativeTabsController.tabControlsFrame(
            in: scattered, excluding: [], tabCount: 2, within: column, in: scattered))
        let empty = UIView(frame: scattered.bounds)
        XCTAssertNil(NativeTabsController.tabControlsFrame(
            in: empty, excluding: [], tabCount: 5, within: column, in: empty))
    }

    func testFreeRailTouchesPassToThePageAndTabTouchesReachTheTabs() throws {
        let overlay = TabsOverlayView(frame: CGRect(x: 0, y: 0, width: 678, height: 466))
        let (root, platter) = coverScreenTabs()
        overlay.addSubview(root)
        overlay.controlRegion = { platter.convert(platter.bounds, to: overlay) }
        // Above the platter, in the rail the page draws its controls into.
        XCTAssertNil(overlay.hitTest(CGPoint(x: 40, y: 100), with: nil))
        // Beside the column, where only the empty UITabBar reaches.
        XCTAssertNil(overlay.hitTest(CGPoint(x: 110, y: 300), with: nil))
        let tab = try XCTUnwrap(overlay.hitTest(CGPoint(x: 48, y: 210), with: nil))
        XCTAssertTrue(tab is UIControl)
        XCTAssertTrue(tab.isDescendant(of: platter))
        // Without a verified platter the whole column stays with the tabs.
        overlay.controlRegion = { CGRect(x: 0, y: 0, width: 84, height: 466) }
        XCTAssertNotNil(overlay.hitTest(CGPoint(x: 48, y: 210), with: nil))
        XCTAssertNil(overlay.hitTest(CGPoint(x: 110, y: 300), with: nil))
        overlay.controlRegion = { nil }
        XCTAssertNil(overlay.hitTest(CGPoint(x: 48, y: 210), with: nil))
    }

    func testBottomTabsTakeTheirTouchesAndLeaveThePageItsOwn() throws {
        let content = ViewController()
        let page = UIView()
        content.view = page
        let controller = NativeTabsController(content: content)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 466, height: 678))
        window.rootViewController = controller
        window.isHidden = false
        defer { window.isHidden = true }
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .pad, "iPad shows floating tabs instead")
        configure(controller)
        let navigation = try XCTUnwrap(controller.children.compactMap { $0 as? UITabBarController }.first)
        window.layoutIfNeeded()
        navigation.view.layoutIfNeeded()
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
        let bar = navigation.tabBar.convert(navigation.tabBar.bounds, to: controller.view)
        let onTab = try XCTUnwrap(controller.view.hitTest(CGPoint(x: bar.midX, y: bar.midY), with: nil))
        XCTAssertTrue(onTab.isDescendant(of: navigation.tabBar))
        let onPage = try XCTUnwrap(controller.view.hitTest(CGPoint(x: bar.midX, y: bar.minY / 2), with: nil))
        XCTAssertTrue(onPage === page || onPage.isDescendant(of: page))
        controller.hide()
        let hidden = try XCTUnwrap(controller.view.hitTest(CGPoint(x: bar.midX, y: bar.midY), with: nil))
        XCTAssertTrue(hidden === page || hidden.isDescendant(of: page))
    }

    func testLateTabPlatterMovesTheRailAndTouchesTogether() async throws {
        let webView = WKWebView()
        let loaded = expectation(description: "Rail document loaded")
        let observer = ViewportPageLoad(loaded)
        webView.navigationDelegate = observer
        webView.loadHTMLString("<meta name='viewport' content='width=device-width,initial-scale=1'>", baseURL: nil)
        await fulfillment(of: [loaded], timeout: 10)
        let content = ViewController()
        content.view = webView
        content.webView = webView
        let controller = NativeTabsController(content: content)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 678, height: 466))
        window.rootViewController = controller
        window.isHidden = false
        defer { window.isHidden = true }
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .pad, "iPad shows floating tabs instead")
        configure(controller)
        let navigation = try XCTUnwrap(controller.children.compactMap { $0 as? UITabBarController }.first)
        let host = try XCTUnwrap(navigation.selectedViewController)
        // The hostless bundle cannot show the cover-screen bar. Recreate its
        // shape: a side column, the empty UITabBar, and a separate platter.
        host.additionalSafeAreaInsets.left = 84
        window.layoutIfNeeded()
        navigation.tabBar.frame = CGRect(x: 0, y: 0, width: 80, height: 466)
        navigation.tabBar.subviews.forEach { $0.isHidden = true }
        host.view.layoutIfNeeded()
        controller.viewDidLayoutSubviews()
        controller.view.layoutIfNeeded()
        let rail = { () async throws -> String? in
            try await webView.evaluateJavaScript("""
                document.documentElement.classList.contains('side-rail')
                    ? document.documentElement.style.getPropertyValue('--rail-bottom') : 'none'
                """) as? String
        }
        let noRail = try await rail()
        XCTAssertEqual(noRail, "none")

        // The platter appears after layout. The first touch lays out again,
        // so the rail the page shows matches the region the touch used.
        let platter = UIView(frame: CGRect(x: 18, y: 300, width: 48, height: 120))
        for _ in 0..<2 {
            let copy = UIView(frame: platter.bounds)
            for index in 0..<2 {
                copy.addSubview(UIControl(frame: CGRect(x: 2, y: 2 + CGFloat(index) * 58, width: 44, height: 58)))
            }
            platter.addSubview(copy)
        }
        navigation.view.addSubview(platter)
        let inRail = controller.view.hitTest(CGPoint(x: 42, y: 200), with: nil)
        XCTAssertTrue(inRail?.isDescendant(of: webView) ?? false)
        let shownRail = try await rail()
        XCTAssertEqual(shownRail, "300px")

        // The platter then settles higher, into what was the rail.
        platter.frame.origin.y = 150
        let onTab = controller.view.hitTest(CGPoint(x: 42, y: 200), with: nil)
        XCTAssertTrue(onTab?.isDescendant(of: platter) ?? false)
        let movedRail = try await rail()
        XCTAssertEqual(movedRail, "150px")
        XCTAssertTrue(controller.view.hitTest(CGPoint(x: 42, y: 100), with: nil)?.isDescendant(of: webView) ?? false)
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
