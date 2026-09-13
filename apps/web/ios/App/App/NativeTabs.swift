import Capacitor
import UIKit

private final class NativeTabContentHost: UIViewController {
    var onLayout: (() -> Void)?

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        onLayout?()
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        onLayout?()
    }
}

/// Holds the tab controller over the page. Only the bar itself takes touches;
/// everything else belongs to the web view spanning the whole screen beneath.
private final class TabsOverlayView: UIView {
    /// The clear views that only frame the page: the tab hosts. iPad's floating
    /// bar is not a descendant of `UITabBarController.tabBar`, so the bar is
    /// found by exclusion — whatever is not the page's frame or one of its
    /// full-screen containers.
    var hostViews: () -> [UIView] = { [] }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard let hit = super.hitTest(point, with: event), hit !== self else { return nil }
        for host in hostViews() where host === hit || hit.isDescendant(of: host) || host.isDescendant(of: hit) {
            return nil
        }
        let frame = hit.convert(hit.bounds, to: self)
        if frame.width >= bounds.width * 0.9 && frame.height >= bounds.height * 0.9 { return nil }
        return hit
    }
}

/// The web shell sends its screen colors as `#rrggbb`, the one spelling the
/// stylesheet uses for them.
private func chromeColor(_ hex: String) -> UIColor? {
    var text = hex.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.hasPrefix("#") { text.removeFirst() }
    guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
    return UIColor(red: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
                   blue: CGFloat(value & 0xff) / 255, alpha: 1)
}

/// Rec. 709 luma, deciding the same way the shell does whether a surface
/// carries ink or paper on top of it.
private func isDarkChrome(_ color: UIColor) -> Bool {
    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
    guard color.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return true }
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue < 0.5
}

/// UIKit owns tab selection and safe-area layout. A single sibling bridge fills
/// the selected host's content area, preserving playback and keyboard focus
/// without reloading or reparenting the web view on navigation changes.
final class NativeTabsController: UIViewController, UITabBarControllerDelegate {
    let content: ViewController
    private let navigation = UITabBarController()
    private let tabsOverlay = TabsOverlayView()
    private var hosts: [String: UIViewController] = [:]
    private var identifiers: [String] = []
    private var contentConstraints: [NSLayoutConstraint] = []
    private weak var layoutHost: UIViewController?
    private var navigationVisible = false
    private var configuring = false
    private var requestedSelection: String?
    private var cover: UIView?
    // Last top-bar clearance handed to the page; -1 until it has one.
    private var sentTopClearance: CGFloat = -1
    // The color the visible screen carries, sent with every tab change. The
    // page covers the window, so this shows only where it cannot reach — a
    // rotation, an iPad's top-hung bar — and sets the status bar's polarity.
    private var chrome: UIColor?
    private var barTint: UIColor?
    private var chromeIsDark = true
    // The launch screen is parchment, and the shell cannot report its color
    // until the web view has loaded. Restoring the last one hands the two
    // straight to each other instead of flashing the container between them.
    private static let chromeKey = "operalibre.nativeChrome"
    private static let barKey = "operalibre.nativeBarTint"
    // Matches the web shell's spine, gold-soft, paper, and oxblood tokens.
    private let spine = UIColor(red: 26 / 255, green: 20 / 255, blue: 16 / 255, alpha: 1)
    private let brass = UIColor(red: 217 / 255, green: 181 / 255, blue: 116 / 255, alpha: 1)
    private let parchment = UIColor(red: 241 / 255, green: 231 / 255, blue: 208 / 255, alpha: 1)
    private let oxblood = UIColor(red: 139 / 255, green: 46 / 255, blue: 31 / 255, alpha: 1)
    var onSelect: ((String) -> Void)?

    init(content: ViewController) {
        self.content = content
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("Use init(content:)") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = spine
        // The page runs the full height of the screen, so the tab controller
        // contributes nothing but its bar: no surface of its own for the page
        // to butt against.
        navigation.view.backgroundColor = .clear
        applyBarTint()
        applyChrome(UserDefaults.standard.string(forKey: Self.chromeKey),
                    bar: UserDefaults.standard.string(forKey: Self.barKey))
        navigation.delegate = self
        if #available(iOS 18.0, *) { navigation.mode = .tabBar }
        addChild(content)
        content.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(content.view)
        content.didMove(toParent: self)
        contentConstraints = [
            content.view.topAnchor.constraint(equalTo: view.topAnchor),
            content.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            content.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            content.view.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ]
        NSLayoutConstraint.activate(contentConstraints)
        tabsOverlay.frame = view.bounds
        tabsOverlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        tabsOverlay.backgroundColor = .clear
        tabsOverlay.hostViews = { [weak self] in self?.hosts.values.compactMap(\.viewIfLoaded) ?? [] }
        view.addSubview(tabsOverlay)
        layoutContent(in: self)
    }

    override var childForStatusBarStyle: UIViewController? { navigationVisible ? nil : content }
    // The clock sits over the page itself, so it reads against the screen the
    // selected tab shows rather than against the container behind it.
    override var preferredStatusBarStyle: UIStatusBarStyle { chromeIsDark ? .lightContent : .darkContent }
    override var childForStatusBarHidden: UIViewController? { content }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { content.supportedInterfaceOrientations }
    override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation { content.preferredInterfaceOrientationForPresentation }

    func configure(items: [JSObject], selected: String, visible: Bool, blocked: Bool, appearance: String,
                   chrome: String?, bar: String?) {
        loadViewIfNeeded()
        // The page may have reloaded and lost the clearance it was sent.
        sentTopClearance = -1
        applyChrome(chrome, bar: bar)
        if visible != navigationVisible && navigation.parent != nil {
            // Showing or hiding the bar resizes the web view, and the page
            // reflows over several frames as its safe area and viewport catch
            // up. Hold the last frame until the page reveals itself.
            coverContent()
        }
        overrideUserInterfaceStyle = appearance == "dark" ? .dark : appearance == "light" ? .light : .unspecified
        configuring = true
        defer { configuring = false }
        // iPad presents the collection and player together. Keep the web's
        // reading route for opening playback, but represent both with Shelf.
        let unifiedShelf = traitCollection.userInterfaceIdiom == .pad
        let items = unifiedShelf ? items.filter { $0["id"] as? String != "reading" } : items
        let selected = unifiedShelf && selected == "reading" ? "shelf" : selected
        let ids = items.compactMap { $0["id"] as? String }
        let tabsChanged = ids != identifiers
        if tabsChanged {
            // The replacement selected host may not be attached until a
            // later layout pass; its layout callback refreshes the bar's
            // clearance once it is.
            identifiers = ids
            hosts = Dictionary(uniqueKeysWithValues: items.enumerated().compactMap { index, item in
                guard let id = item["id"] as? String else { return nil }
                let host = NativeTabContentHost()
                host.view.backgroundColor = .clear
                host.onLayout = { [weak self] in self?.updateContentInsets() }
                // UIKit must measure complete items on the first layout. Adding
                // titles after publishing incomplete tabs leaves unselected
                // labels offset and clipped in the floating iPhone bar.
                host.tabBarItem = UITabBarItem(
                    title: item["title"] as? String,
                    image: UIImage(systemName: item["symbol"] as? String ?? "circle"),
                    tag: index
                )
                host.tabBarItem.badgeValue = item["badge"] as? String
                return (id, host)
            })
            if #available(iOS 18.0, *) {
                navigation.setTabs(ids.compactMap { id in
                    guard let host = hosts[id] else { return nil }
                    let tab = UITab(title: host.tabBarItem.title ?? id,
                                    image: host.tabBarItem.image, identifier: id) { _ in host }
                    tab.preferredPlacement = .fixed
                    tab.badgeValue = host.tabBarItem.badgeValue
                    return tab
                }, animated: false)
            } else {
                navigation.setViewControllers(ids.compactMap { hosts[$0] }, animated: false)
            }

        }
        for item in items {
            guard let id = item["id"] as? String, let host = hosts[id] else { continue }
            let badge = item["badge"] as? String
            if host.tabBarItem.badgeValue != badge { host.tabBarItem.badgeValue = badge }
            if #available(iOS 18.0, *) {
                navigation.tabs.first(where: { $0.identifier == id })?.badgeValue = badge
            }
        }
        if tabsChanged || selected != requestedSelection {
            if #available(iOS 18.0, *) {
                navigation.selectedTab = navigation.tabs.first(where: { $0.identifier == selected })
            } else if let index = identifiers.firstIndex(of: selected) {
                navigation.selectedIndex = index
            }
        }
        requestedSelection = selected
        // Web sheets rise from the bottom of the page, which now runs under
        // the bar. Taking the bar away leaves the sheet whole instead of
        // ghosting a dimmed copy of it across the sheet's own footer.
        tabsOverlay.alpha = blocked ? 0 : 1
        navigation.view.isUserInteractionEnabled = !blocked
        navigation.view.accessibilityElementsHidden = blocked
        if visible {
            if navigation.parent == nil {
                addChild(navigation)
                navigation.view.frame = tabsOverlay.bounds
                navigation.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                tabsOverlay.addSubview(navigation.view)
                navigation.didMove(toParent: self)
            }
            navigationVisible = true
            setNeedsStatusBarAppearanceUpdate()
            navigation.view.isHidden = false
            showSelectedContent()
        } else {
            hide()
        }
    }

    /// The bar is glass over the screen it belongs to. Tinting that glass with
    /// the page's own tone keeps it from reading as a bright slab laid on the
    /// paper, and its labels take the page's ink: gold on the dark shelf and
    /// parlour, oxblood — the same red as the play control — on paper.
    private func applyBarTint() {
        let selected = chromeIsDark ? brass : oxblood
        // Ink and spine are the same tone in the palette; on paper it reads
        // as the text color rather than as the shelf's board.
        let resting = (chromeIsDark ? parchment : spine).withAlphaComponent(0.75)
        navigation.overrideUserInterfaceStyle = chromeIsDark ? .dark : .light
        navigation.view.tintColor = selected
        let appearance = UITabBarAppearance()
        appearance.configureWithDefaultBackground()
        // iOS 26 owns the floating bar's glass and ignores this; on the older
        // full-width bar it is what keeps the material on the page's tone
        // instead of a lighter slab across the bottom of the screen.
        appearance.backgroundColor = (barTint ?? chrome)?.withAlphaComponent(0.9)
        appearance.shadowColor = .clear
        for item in [appearance.stackedLayoutAppearance, appearance.inlineLayoutAppearance,
                     appearance.compactInlineLayoutAppearance] {
            item.normal.iconColor = resting
            item.normal.titleTextAttributes = [.foregroundColor: resting]
            item.selected.iconColor = selected
            item.selected.titleTextAttributes = [.foregroundColor: selected]
            item.normal.badgeBackgroundColor = oxblood
            item.normal.badgeTextAttributes = [.foregroundColor: parchment]
            item.selected.badgeBackgroundColor = oxblood
            item.selected.badgeTextAttributes = [.foregroundColor: parchment]
        }
        navigation.tabBar.standardAppearance = appearance
        navigation.tabBar.scrollEdgeAppearance = appearance
        navigation.tabBar.tintColor = selected
        navigation.tabBar.unselectedItemTintColor = resting
    }

    /// Take the tones the selected screen reports. Crossing them over the same
    /// beat as the shell's tab fade keeps the clock and the bar from turning
    /// over before the page behind them does.
    private func applyChrome(_ hex: String?, bar: String?) {
        let tint = bar.flatMap(chromeColor)
        let retinted = tint != nil && tint != barTint
        barTint = tint ?? barTint
        guard let hex, let color = chromeColor(hex), color != chrome else {
            if retinted { applyBarTint() }
            return
        }
        let first = chrome == nil
        chrome = color
        UserDefaults.standard.set(hex, forKey: Self.chromeKey)
        UserDefaults.standard.set(bar, forKey: Self.barKey)
        chromeIsDark = isDarkChrome(color)
        applyBarTint()
        let paint = {
            self.view.backgroundColor = color
            self.setNeedsStatusBarAppearanceUpdate()
        }
        if first { paint() } else { UIView.animate(withDuration: 0.26, animations: paint) }
    }

    func hide() {
        loadViewIfNeeded()
        navigationVisible = false
        navigation.view.isHidden = true
        layoutContent(in: self)
        content.view.isHidden = false
        setNeedsStatusBarAppearanceUpdate()
    }

    func reveal() {
        guard let cover else { return }
        self.cover = nil
        UIView.animate(withDuration: 0.22, delay: 0, options: .curveEaseOut) {
            cover.alpha = 0
        } completion: { _ in
            cover.removeFromSuperview()
        }
    }

    private func coverContent() {
        guard cover == nil, let snapshot = view.snapshotView(afterScreenUpdates: false) else { return }
        snapshot.frame = view.bounds
        snapshot.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(snapshot)
        cover = snapshot
        // Never leave a stale frame over the app if the page never reports in.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self, weak snapshot] in
            if let self, let snapshot, self.cover === snapshot { self.reveal() }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        updateContentInsets()
    }

    private func layoutContent(in host: UIViewController) {
        layoutHost = host
        updateContentInsets()
    }

    private func updateContentInsets() {
        guard contentConstraints.count == 4, let host = layoutHost else { return }
        var frame: CGRect
        if host === self {
            frame = view.bounds
        } else {
            // didSelect can precede UIKit attaching the new host. Its layout
            // callback supplies the final safe area once the transition lands.
            guard host.viewIfLoaded?.isDescendant(of: view) == true else { return }
            frame = host.view.convert(host.view.safeAreaLayoutGuide.layoutFrame, to: view)
        }
        // The page owns the whole screen. The status bar sits on the page's
        // own background and the bar glasses over it, so neither edge needs a
        // strip of container color to butt against. Only the horizontal safe
        // area still trims the web view, keeping text out of the notch in
        // landscape.
        let hostSafeTop = frame.minY
        frame.origin.y = view.bounds.minY
        frame.size.height = view.bounds.height
        var clearance: CGFloat = 0
        var topClearance: CGFloat = 0
        if navigationVisible, navigation.parent != nil, !navigation.view.isHidden {
            let bar = navigation.tabBar.convert(navigation.tabBar.bounds, to: view)
            if bar.intersects(view.bounds), bar.width >= view.bounds.width / 2, bar.midY >= view.bounds.midY {
                // The page keeps its own content clear of the floating bar
                // through the bottom safe area, the same inset it already
                // reserves for the home indicator.
                clearance = view.bounds.maxY - bar.minY
            }
            if host !== self {
                // iPad hangs its floating bar from the top of the window, in a
                // view of its own rather than `tabBar`. UIKit reserves it in
                // the host's top safe area. The page learns the height as a
                // variable rather than a safe-area inset, so its content clears
                // the bar while the clock's veil stays the clock's height.
                topClearance = max(0, (hostSafeTop - view.safeAreaInsets.top).rounded())
            }
        }
        let reserved = max(0, clearance - view.safeAreaInsets.bottom)
        if abs(content.additionalSafeAreaInsets.bottom - reserved) > 0.5 {
            content.additionalSafeAreaInsets.bottom = reserved
        }
        if topClearance != sentTopClearance, let webView = content.webView {
            sentTopClearance = topClearance
            webView.evaluateJavaScript(
                "document.documentElement.style.setProperty('--native-tabs-top', '\(Int(topClearance))px')")
        }
        let insets = [frame.minY, frame.maxY - view.bounds.height,
                      frame.minX, frame.maxX - view.bounds.width]
        // These constraints always belong to the root, never a transient tab
        // host. Updating constants also keeps the same WebView and its focus.
        for (constraint, inset) in zip(contentConstraints, insets) where constraint.constant != inset {
            constraint.constant = inset
        }
    }

    private func showSelectedContent() {
        if let host = navigation.selectedViewController {
            content.view.isHidden = false
            layoutContent(in: host)
        }
    }

    private func selectContent(_ viewController: UIViewController) {
        if viewController is NativeTabContentHost {
            content.view.isHidden = false
            layoutContent(in: viewController)
        } else {
            showSelectedContent()
        }
        guard !configuring, let id = hosts.first(where: { $0.value === viewController })?.key else { return }
        requestedSelection = id
        onSelect?(id)
    }

    @available(iOS 18.0, *)
    func tabBarController(_ tabBarController: UITabBarController, didSelectTab selectedTab: UITab, previousTab: UITab?) {
        if let host = selectedTab.viewController { selectContent(host) }
    }

    func tabBarController(_ tabBarController: UITabBarController, didSelect viewController: UIViewController) {
        // Modern tabs deliver their own selection callback.
        if #available(iOS 18.0, *) { return }
        selectContent(viewController)
    }
}

@objc(NativeTabsPlugin)
public final class NativeTabsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeTabsPlugin"
    public let jsName = "NativeTabs"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hide", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reveal", returnType: CAPPluginReturnPromise)
    ]

    private var controller: NativeTabsController? {
        bridge?.viewController?.view.window?.rootViewController as? NativeTabsController
    }

    @objc public func configure(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let controller = self.controller else {
                call.reject("Native navigation is unavailable.")
                return
            }
            let items = call.getArray("tabs", JSObject.self) ?? []
            let ids = items.compactMap { $0["id"] as? String }
            guard !ids.isEmpty, ids.count <= 5, ids.count == items.count,
                  Set(ids).count == ids.count, let selected = call.getString("selected"), ids.contains(selected) else {
                call.reject("Invalid navigation tabs.")
                return
            }
            controller.onSelect = { [weak self] id in self?.notifyListeners("select", data: ["id": id]) }
            controller.configure(items: items, selected: selected,
                                 visible: call.getBool("visible") ?? false,
                                 blocked: call.getBool("blocked") ?? false,
                                 appearance: call.getString("appearance") ?? "system",
                                 chrome: call.getString("chrome"), bar: call.getString("bar"))
            call.resolve()
        }
    }

    @objc public func hide(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.controller?.hide()
            call.resolve()
        }
    }

    @objc public func reveal(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.controller?.reveal()
            call.resolve()
        }
    }
}
