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

/// UIKit owns tab selection and safe-area layout. A single sibling bridge fills
/// the selected host's content area, preserving playback and keyboard focus
/// without reloading or reparenting the web view on navigation changes.
final class NativeTabsController: UIViewController, UITabBarControllerDelegate {
    let content: ViewController
    private let navigation = UITabBarController()
    private var hosts: [String: UIViewController] = [:]
    private var identifiers: [String] = []
    private var contentConstraints: [NSLayoutConstraint] = []
    private weak var layoutHost: UIViewController?
    private var navigationVisible = false
    private var configuring = false
    private var requestedSelection: String?
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
        navigation.view.backgroundColor = spine
        // Only the navigation material is dark. The sibling web view still
        // follows the user's light/dark/system preference.
        navigation.overrideUserInterfaceStyle = .dark
        navigation.view.tintColor = brass
        let appearance = UITabBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = spine
        appearance.shadowColor = .clear
        for item in [appearance.stackedLayoutAppearance, appearance.inlineLayoutAppearance,
                     appearance.compactInlineLayoutAppearance] {
            item.normal.iconColor = parchment.withAlphaComponent(0.75)
            item.normal.titleTextAttributes = [.foregroundColor: parchment.withAlphaComponent(0.75)]
            item.selected.iconColor = brass
            item.selected.titleTextAttributes = [.foregroundColor: brass]
            item.normal.badgeBackgroundColor = oxblood
            item.normal.badgeTextAttributes = [.foregroundColor: parchment]
            item.selected.badgeBackgroundColor = oxblood
            item.selected.badgeTextAttributes = [.foregroundColor: parchment]
        }
        navigation.tabBar.standardAppearance = appearance
        navigation.tabBar.scrollEdgeAppearance = appearance
        navigation.tabBar.tintColor = brass
        navigation.tabBar.unselectedItemTintColor = parchment.withAlphaComponent(0.75)
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
        layoutContent(in: self)
    }

    override var childForStatusBarStyle: UIViewController? { navigationVisible ? nil : content }
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var childForStatusBarHidden: UIViewController? { content }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { content.supportedInterfaceOrientations }
    override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation { content.preferredInterfaceOrientationForPresentation }

    func configure(items: [JSObject], selected: String, visible: Bool, blocked: Bool, appearance: String) {
        loadViewIfNeeded()
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
            // Reset the content insets before UIKit discards a selected host.
            layoutContent(in: self)
            identifiers = ids
            hosts = Dictionary(uniqueKeysWithValues: items.enumerated().compactMap { index, item in
                guard let id = item["id"] as? String else { return nil }
                let host = NativeTabContentHost()
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
        // Dim the controls behind a web sheet without changing its viewport.
        navigation.view.alpha = blocked ? 0.25 : 1
        navigation.view.isUserInteractionEnabled = !blocked
        navigation.view.accessibilityElementsHidden = blocked
        if visible {
            if navigation.parent == nil {
                addChild(navigation)
                navigation.view.frame = view.bounds
                navigation.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                view.insertSubview(navigation.view, belowSubview: content.view)
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

    func hide() {
        loadViewIfNeeded()
        layoutContent(in: self)
        navigationVisible = false
        content.view.isHidden = false
        setNeedsStatusBarAppearanceUpdate()
        navigation.view.isHidden = true
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
        let frame: CGRect
        if host === self {
            frame = view.bounds
        } else {
            // didSelect can precede UIKit attaching the new host. Its layout
            // callback supplies the final safe area once the transition lands.
            guard host.viewIfLoaded?.isDescendant(of: view) == true else { return }
            frame = host.view.convert(host.view.safeAreaLayoutGuide.layoutFrame, to: view)
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
        CAPPluginMethod(name: "hide", returnType: CAPPluginReturnPromise)
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
                                 appearance: call.getString("appearance") ?? "system")
            call.resolve()
        }
    }

    @objc public func hide(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.controller?.hide()
            call.resolve()
        }
    }
}
