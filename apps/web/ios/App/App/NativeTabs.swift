import Capacitor
import UIKit
import UIKit.UIGestureRecognizerSubclass

private final class NativeTabContentHost: UIViewController {
    var onLayout: (() -> Void)?

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        onLayout?()
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        view.setNeedsLayout()
    }
}

final class TabsOverlayView: UIView {
    var hostViews: () -> [UIView] = { [] }
    /// The area the page leaves to the tabs, in this view's coordinates.
    var controlRegion: () -> CGRect? = { nil }
    /// The rail the page has drawn, which stays the page's until it moves.
    var pageRail: () -> CGRect? = { nil }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard let region = controlRegion(), region.contains(point),
              pageRail()?.contains(point) != true,
              let hit = super.hitTest(point, with: event), hit !== self else { return nil }
        for host in hostViews() where host === hit || hit.isDescendant(of: host) || host.isDescendant(of: hit) {
            return nil
        }
        // UIKit's passthrough containers, and the empty UITabBar it leaves
        // behind a vertical bar, reach past the region; they are not controls.
        let frame = hit.convert(hit.bounds, to: self)
        if frame.contains(region) && (frame.width > region.width + 1 || frame.height > region.height + 1) {
            return nil
        }
        return hit
    }
}

private final class BarTouchTracker: UIGestureRecognizer {
    private var start = CGPoint.zero
    private(set) var strayed = false
    private static let slop: CGFloat = 24

    override init(target: Any?, action: Selector?) {
        super.init(target: target, action: action)
        cancelsTouchesInView = false
        delaysTouchesEnded = false
    }

    override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
    override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        if let touch = touches.first { start = touch.location(in: view) }
        strayed = false
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let overlay = view, let end = touches.first?.location(in: overlay) else { return finish(strayed: false) }
        finish(strayed: overlay.hitTest(end, with: nil) == nil
            && hypot(end.x - start.x, end.y - start.y) > Self.slop)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        finish(strayed: true)
    }

    private func finish(strayed: Bool) {
        self.strayed = strayed
        state = .failed
        DispatchQueue.main.async { [weak self] in self?.strayed = false }
    }
}

private func chromeColor(_ hex: String) -> UIColor? {
    var text = hex.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.hasPrefix("#") { text.removeFirst() }
    guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
    return UIColor(red: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
                   blue: CGFloat(value & 0xff) / 255, alpha: 1)
}

private func isDarkChrome(_ color: UIColor) -> Bool {
    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
    guard color.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return true }
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue < 0.5
}

final class NativeTabsController: UIViewController, UITabBarControllerDelegate {
    /// Where the visible tabs are, as decided by the last layout pass.
    private enum TabsPresentation {
        case none
        /// A bottom bar or iPad's floating bar: the area the page reserves for it.
        case reserved(CGRect)
        /// A vertical bar in a side column the page stays out of unless a rail is shown.
        case side(column: CGRect)
    }

    let content: ViewController
    private let navigation = UITabBarController()
    private let tabsOverlay = TabsOverlayView()
    private let barTouch = BarTouchTracker(target: nil, action: nil)
    private var hosts: [String: UIViewController] = [:]
    private var identifiers: [String] = []
    private var contentConstraints: [NSLayoutConstraint] = []
    private weak var layoutHost: UIViewController?
    private var lastViewportSize: CGSize?
    private var navigationVisible = false
    private var configuring = false
    private var requestedSelection: String?
    private var selectionThisTurn: String?
    private var cover: UIView?
    private var sentTopClearance: CGFloat = -1
    private var sentFloatingTopBar: Bool?
    private var sentRail: CGRect??
    private var platterInset: CGFloat = 0
    private var presentation = TabsPresentation.none
    private var sideControls: CGRect?
    private var appliedRail: CGRect?
    private var railGeneration = 0
    private var appliedRailGeneration = 0
    private static let minimumRailHeight: CGFloat = 60
    private var chrome: UIColor?
    private var barTint: UIColor?
    private var accent: UIColor?
    private var chromeIsDark = true
    private static let chromeKey = "operalibre.nativeChrome"
    private static let barKey = "operalibre.nativeBarTint"
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
        navigation.view.backgroundColor = .clear
        applyBarTint()
        applyChrome(UserDefaults.standard.string(forKey: Self.chromeKey),
                    bar: UserDefaults.standard.string(forKey: Self.barKey))
        navigation.delegate = self
        if #available(iOS 18.0, *) { navigation.mode = .tabBar }
        #if compiler(>=6.4)
        if #available(iOS 27.1, *) {
            registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) {
                (self: NativeTabsController, _) in self.view.setNeedsLayout()
            }
        }
        #endif
        addChild(content)
        content.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(content.view)
        content.didMove(toParent: self)
        paintWebView()
        contentConstraints = [
            content.view.topAnchor.constraint(equalTo: view.topAnchor),
            content.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            content.view.leftAnchor.constraint(equalTo: view.leftAnchor),
            content.view.rightAnchor.constraint(equalTo: view.rightAnchor)
        ]
        NSLayoutConstraint.activate(contentConstraints)
        tabsOverlay.frame = view.bounds
        tabsOverlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        tabsOverlay.backgroundColor = .clear
        tabsOverlay.hostViews = { [weak self] in self?.hosts.values.compactMap(\.viewIfLoaded) ?? [] }
        tabsOverlay.controlRegion = { [weak self] in self?.tabControlRegion() }
        tabsOverlay.pageRail = { [weak self] in self?.appliedRail }
        tabsOverlay.addGestureRecognizer(barTouch)
        view.addSubview(tabsOverlay)
        layoutContent(in: self)
    }

    override var childForStatusBarStyle: UIViewController? { navigationVisible ? nil : content }
    override var preferredStatusBarStyle: UIStatusBarStyle { chromeIsDark ? .lightContent : .darkContent }
    override var childForStatusBarHidden: UIViewController? { content }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { content.supportedInterfaceOrientations }
    override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation { content.preferredInterfaceOrientationForPresentation }

    func configure(items: [JSObject], selected: String, visible: Bool, blocked: Bool, appearance: String,
                   chrome: String?, bar: String?, accent: String? = nil, uncovered: Bool = false) {
        loadViewIfNeeded()
        sentTopClearance = -1
        sentFloatingTopBar = nil
        sentRail = .none
        let reselecting = requestedSelection != nil && selected != requestedSelection
        if !reselecting { applyChrome(chrome, bar: bar, accent: accent) }
        if visible != navigationVisible && navigation.parent != nil && !uncovered {
            coverContent()
        }
        overrideUserInterfaceStyle = appearance == "dark" ? .dark : appearance == "light" ? .light : .unspecified
        configuring = true
        defer { configuring = false }
        let ids = items.compactMap { $0["id"] as? String }
        let tabsChanged = ids != identifiers
        if tabsChanged {
            identifiers = ids
            hosts = Dictionary(uniqueKeysWithValues: items.enumerated().compactMap { index, item in
                guard let id = item["id"] as? String else { return nil }
                let host = NativeTabContentHost()
                host.view.backgroundColor = .clear
                host.onLayout = { [weak self] in self?.updateContentInsets() }
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
        if reselecting {
            DispatchQueue.main.async { [weak self] in self?.applyChrome(chrome, bar: bar, accent: accent) }
        }
        requestedSelection = selected
        if blocked {
            tabsOverlay.alpha = 0
        } else if tabsOverlay.alpha != 1 {
            UIView.animate(withDuration: 0.22, delay: 0, options: .curveEaseOut) { self.tabsOverlay.alpha = 1 }
        }
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

    private func applyBarTint() {
        let selected = chromeIsDark ? brass : (accent ?? oxblood)
        let resting = (chromeIsDark ? parchment : spine).withAlphaComponent(0.75)
        navigation.overrideUserInterfaceStyle = chromeIsDark ? .dark : .light
        navigation.view.tintColor = selected
        let appearance = UITabBarAppearance()
        appearance.configureWithDefaultBackground()
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

    private func applyChrome(_ hex: String?, bar: String?, accent accentHex: String? = nil) {
        let tint = bar.flatMap(chromeColor)
        let newAccent = accentHex.flatMap(chromeColor)
        let retinted = (tint != nil && tint != barTint) || (newAccent != nil && newAccent != accent)
        barTint = tint ?? barTint
        accent = newAccent ?? accent
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
            self.paintWebView()
            self.setNeedsStatusBarAppearanceUpdate()
        }
        if first { paint() } else { UIView.animate(withDuration: 0.26, animations: paint) }
    }

    private func paintWebView() {
        guard let chrome, let webView = content.webView else { return }
        webView.backgroundColor = chrome
        webView.scrollView.backgroundColor = chrome
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
        guard cover == nil, !view.bounds.isEmpty else { return }
        let snapshot = view.frozenSnapshot()
        snapshot.frame = view.bounds
        snapshot.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(snapshot)
        cover = snapshot
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self, weak snapshot] in
            if let self, let snapshot, self.cover === snapshot { self.reveal() }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        updateContentInsets()
        contentDidLayout()
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        coordinator.animate(alongsideTransition: nil) { [weak self] _ in
            self?.contentDidLayout(force: true)
        }
    }

    func contentDidLayout(force: Bool = false) {
        guard let webView = content.webView else { return }
        let size = webView.bounds.size
        guard size.width > 0, size.height > 0, force || size != lastViewportSize else { return }
        lastViewportSize = size
        webView.evaluateJavaScript("""
            window.dispatchEvent(new CustomEvent('operalibre:viewportchange', {
                detail: { width: \(size.width), height: \(size.height) }
            }))
            """)
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        view.setNeedsLayout()
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
            guard host.viewIfLoaded?.isDescendant(of: view) == true else { return }
            frame = host.view.convert(host.view.safeAreaLayoutGuide.layoutFrame, to: view)
        }
        let hostSafeTop = frame.minY
        presentation = .none
        sideControls = nil
        frame.origin.y = view.bounds.minY
        frame.size.height = view.bounds.height
        var usesFloatingTopBar = false
        var clearance: CGFloat = 0
        var topClearance: CGFloat = 0
        if navigationVisible, navigation.parent != nil, !navigation.view.isHidden {
            if host !== self {
                topClearance = max(0, (hostSafeTop - view.safeAreaInsets.top).rounded())
                if #available(iOS 18.0, *) {
                    usesFloatingTopBar = topClearance > 0
                }
            }
            if !usesFloatingTopBar {
                let bar = navigation.tabBar.convert(navigation.tabBar.bounds, to: view)
                if bar.intersects(view.bounds), bar.width >= view.bounds.width / 2, bar.midY >= view.bounds.midY {
                    clearance = view.bounds.maxY - bar.minY
                    presentation = .reserved(bar.intersection(view.bounds))
                }
            } else {
                presentation = .reserved(CGRect(x: view.bounds.minX, y: view.bounds.minY,
                                                width: view.bounds.width, height: hostSafeTop - view.bounds.minY))
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
        if usesFloatingTopBar != sentFloatingTopBar, let webView = content.webView {
            sentFloatingTopBar = usesFloatingTopBar
            webView.evaluateJavaScript(
                "document.documentElement.classList.toggle('floating-tabs', \(usesFloatingTopBar))")
        }
        var rail: CGRect?
        var sideBar = false
        var columnReserve = UIEdgeInsets.zero
        let hasLeadingRail = frame.minX > view.bounds.minX + 0.5
        let hasTrailingRail = frame.maxX < view.bounds.maxX - 0.5
        if navigationVisible, navigation.parent != nil, !navigation.view.isHidden,
           hasLeadingRail || hasTrailingRail {
            let bar = navigation.tabBar.convert(navigation.tabBar.bounds, to: view)
            let barOnLeading = hasLeadingRail && bar.maxX < view.bounds.midX
            let barOnTrailing = hasTrailingRail && bar.minX > view.bounds.midX
            let column = barOnLeading
                ? CGRect(x: view.bounds.minX, y: 0, width: frame.minX - view.bounds.minX, height: view.bounds.height)
                : CGRect(x: frame.maxX, y: 0, width: view.bounds.maxX - frame.maxX, height: view.bounds.height)
            sideBar = bar.height >= view.bounds.height / 2 && bar.width < view.bounds.width / 4
                && (barOnLeading || barOnTrailing)
            if sideBar {
                presentation = .side(column: column)
                sideControls = sideTabControls(in: column)
                DispatchQueue.main.async { [weak self] in
                    if self?.sideControlsMoved() == true { self?.view.setNeedsLayout() }
                }
            }
            if sideBar, let items = sideControls {
                let top = railTop(in: column, above: items.minY)
                if items.minY - top >= Self.minimumRailHeight {
                    rail = CGRect(x: items.midX - column.width / 2 - view.bounds.minX, y: top,
                                  width: column.width, height: items.minY - top)
                    platterInset = barOnLeading ? items.midX - column.midX : column.midX - items.midX
                    frame.origin.x = view.bounds.minX
                    frame.size.width = view.bounds.width
                    columnReserve = Self.sideColumnReserve(width: column.width, onLeft: barOnLeading,
                                                           safeArea: view.safeAreaInsets)
                }
            }
        } else if !navigationVisible || navigation.view.isHidden {
            #if compiler(>=6.4)
            if #available(iOS 27.1, *),
               let column = Self.hiddenRailColumn(in: view.bounds, insets: view.safeAreaInsets,
                                                  edge: traitCollection.verticalBarEdge,
                                                  direction: view.effectiveUserInterfaceLayoutDirection) {
                let bottom = view.bounds.maxY - view.safeAreaInsets.bottom
                let top = railTop(in: column, above: bottom)
                if bottom - top >= 264 {
                    let onLeft = column.minX <= view.bounds.minX + 0.5
                    let midX = column.midX + (onLeft ? platterInset : -platterInset)
                    rail = CGRect(x: midX - column.width / 2 - frame.minX, y: top,
                                  width: column.width, height: bottom - top)
                }
            }
            #endif
        }
        if case .none = presentation, navigationVisible, navigation.parent != nil, !navigation.view.isHidden,
           navigation.tabBar.isDescendant(of: navigation.view) {
            // An unrecognized presentation keeps the tabs usable where UIKit put the bar.
            let bar = navigation.tabBar.convert(navigation.tabBar.bounds, to: view)
            if bar.intersects(view.bounds) { presentation = .reserved(bar.intersection(view.bounds)) }
        }
        for (edge, reserve) in [(\UIEdgeInsets.left, columnReserve.left), (\.right, columnReserve.right)]
        where abs(content.additionalSafeAreaInsets[keyPath: edge] - reserve) > 0.5 {
            content.additionalSafeAreaInsets[keyPath: edge] = reserve
        }
        if rail != sentRail, let webView = content.webView {
            sentRail = .some(rail)
            let script: String
            if let rail {
                script = """
                (() => { const s = document.documentElement.style;
                s.setProperty('--rail-x', '\(Int(rail.minX))px'); s.setProperty('--rail-width', '\(Int(rail.width))px');
                s.setProperty('--rail-top', '\(Int(rail.minY))px'); s.setProperty('--rail-bottom', '\(Int(rail.maxY))px');
                document.documentElement.dataset.railControls = '\(rail.height >= 216 ? "full" : rail.height >= 164 ? "transport" : "play")';
                document.documentElement.classList.add('side-rail'); })()
                """
            } else {
                script = "document.documentElement.classList.remove('side-rail'); delete document.documentElement.dataset.railControls"
            }
            // The page applies a new rail later. Until it does, touches in the
            // rail it still shows go to the page, not to tabs that moved there.
            railGeneration += 1
            let generation = railGeneration
            webView.evaluateJavaScript(script) { [weak self] _, error in
                guard let self, error == nil, generation > self.appliedRailGeneration else { return }
                self.appliedRailGeneration = generation
                let origin = self.content.view.frame.origin
                self.appliedRail = rail?.offsetBy(dx: origin.x, dy: origin.y)
            }
        }
        if !sideBar {
            frame.origin.x = view.bounds.minX
            frame.size.width = view.bounds.width
        }
        let insets = [frame.minY, frame.maxY - view.bounds.height,
                      frame.minX, frame.maxX - view.bounds.width]
        for (constraint, inset) in zip(contentConstraints, insets) where constraint.constant != inset {
            constraint.constant = inset
        }
    }

    static func sideColumnReserve(width: CGFloat, onLeft: Bool, safeArea: UIEdgeInsets) -> UIEdgeInsets {
        var reserve = UIEdgeInsets.zero
        if onLeft {
            reserve.left = max(0, width - safeArea.left)
        } else {
            reserve.right = max(0, width - safeArea.right)
        }
        return reserve
    }

    #if compiler(>=6.4)
    @available(iOS 27.1, *)
    static func hiddenRailColumn(in bounds: CGRect, insets: UIEdgeInsets,
                                 edge: UIVerticalBarEdge, direction: UIUserInterfaceLayoutDirection) -> CGRect? {
        guard edge == .leading || edge == .trailing else { return nil }
        let left = (edge == .leading) == (direction == .leftToRight)
        let width = left ? insets.left : insets.right
        guard width >= 60 else { return nil }
        return CGRect(x: left ? bounds.minX : bounds.maxX - width, y: bounds.minY,
                      width: width, height: bounds.height)
    }
    #endif

    private func railTop(in column: CGRect, above limit: CGFloat) -> CGFloat {
        var top = view.safeAreaInsets.top
        #if compiler(>=6.4)
        if #available(iOS 27.1, *) {
            for region in view.reservedRegions(kind: .occlusion)
            where region.frame.intersects(column) && region.frame.midY < limit {
                top = max(top, region.frame.maxY)
            }
        }
        #endif
        return top
    }

    /// The one region both the page layout and touch handling give to the tabs.
    /// A side column without a verified set of tab controls stays whole, so the
    /// tabs keep working there and the page gets no rail.
    private func tabControlRegion() -> CGRect? {
        // The vertical bar is hosted apart from this controller's layout and
        // can settle after it. Lay out first, so the rail the page shows and
        // the region touches use come from the same tab frame.
        if sideControlsMoved() {
            view.setNeedsLayout()
            view.layoutIfNeeded()
            // The pass above updates the page's constraints; apply them too.
            view.layoutIfNeeded()
        }
        switch presentation {
        case .none:
            return nil
        case .reserved(let area):
            return area
        case .side(let column):
            return sideControls ?? column
        }
    }

    private func sideControlsMoved() -> Bool {
        guard case .side(let column) = presentation else { return false }
        return sideTabControls(in: column) != sideControls
    }

    private func sideTabControls(in column: CGRect) -> CGRect? {
        Self.tabControlsFrame(in: navigation.view, excluding: hosts.values.compactMap(\.viewIfLoaded),
                              tabCount: identifiers.count, within: column, in: view)
    }

    /// The frame of the view that holds every visible tab control under `root`,
    /// or nil unless each tab has the same number of controls and that view
    /// lies within `limit`. UIKit exposes no frame for its tab items, but
    /// each one is a UIControl under the tab bar controller this one owns.
    static func tabControlsFrame(in root: UIView, excluding excluded: [UIView], tabCount: Int,
                                 within limit: CGRect, in space: UIView) -> CGRect? {
        var controls: [UIView] = []
        var queue = root.subviews
        while let candidate = queue.popLast() {
            guard !candidate.isHidden, candidate.alpha > 0.01,
                  !excluded.contains(where: { $0 === candidate }) else { continue }
            if candidate is UIControl {
                controls.append(candidate)
            } else {
                queue.append(contentsOf: candidate.subviews)
            }
        }
        // Liquid Glass draws each tab twice, once beneath the selection lens,
        // and the copies part while a selection animates.
        guard tabCount > 0, !controls.isEmpty, controls.count % tabCount == 0,
              var container = controls.first?.superview else { return nil }
        while !controls.allSatisfy({ $0.isDescendant(of: container) }) {
            guard container !== root, let parent = container.superview else { return nil }
            container = parent
        }
        guard container !== root else { return nil }
        let frame = container.convert(container.bounds, to: space)
        return limit.insetBy(dx: -1, dy: -1).contains(frame) ? frame : nil
    }

    private func showSelectedContent() {
        if let host = navigation.selectedViewController {
            content.view.isHidden = false
            layoutContent(in: host)
        }
    }

    private func selectContent(id: String) {
        guard !configuring, let host = hosts[id] else { return }
        content.view.isHidden = false
        layoutContent(in: host)
        guard selectionThisTurn != id else { return }
        selectionThisTurn = id
        requestedSelection = id
        onSelect?(id)
        DispatchQueue.main.async { [weak self] in
            self?.selectionThisTurn = nil
        }
    }

    @available(iOS 18.0, *)
    func tabBarController(_ tabBarController: UITabBarController, shouldSelectTab tab: UITab) -> Bool {
        !barTouch.strayed
    }

    @available(iOS 18.0, *)
    func tabBarController(_ tabBarController: UITabBarController, didSelectTab selectedTab: UITab, previousTab: UITab?) {
        selectContent(id: selectedTab.identifier)
    }

    func tabBarController(_ tabBarController: UITabBarController, didSelect viewController: UIViewController) {
        guard let id = hosts.first(where: { $0.value === viewController })?.key else { return }
        selectContent(id: id)
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
                                 chrome: call.getString("chrome"), bar: call.getString("bar"),
                                 accent: call.getString("accent"),
                                 uncovered: call.getBool("uncovered") ?? false)
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
