import Capacitor
import UIKit

extension UIView {
    func frozenSnapshot() -> UIImageView {
        let image = UIGraphicsImageRenderer(bounds: bounds).image { _ in
            drawHierarchy(in: bounds, afterScreenUpdates: false)
        }
        return UIImageView(image: image)
    }
}

class ViewController: CAPBridgeViewController {
    private var layoutScreen: CGSize?

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if let screen = view.window?.windowScene?.screen.bounds.size { layoutScreen = screen }
        (parent as? NativeTabsController)?.contentDidLayout()
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        let old = view.bounds.size
        let rotation = DisplayTransition.isRotation(
            from: old, to: size, transformed: coordinator.targetTransform != .identity)
        let otherScreen = DisplayTransition.isScreenChange(
            from: old, to: size, rotating: rotation,
            screenBefore: layoutScreen, screenNow: view.window?.windowScene?.screen.bounds.size)
        guard rotation || otherScreen, let webView, let host = view.superview, !webView.bounds.isEmpty else { return }
        let still = rotation ? webView.frozenSnapshot() : nil
        if let still {
            still.frame = view.frame
            host.insertSubview(still, aboveSubview: view)
        }
        webView.alpha = 0
        var shown = false
        let show = { [weak webView] in
            guard !shown else { return }
            shown = true
            UIView.animate(withDuration: 0.15, delay: 0, options: [.curveEaseOut, .beginFromCurrentState], animations: {
                webView?.alpha = 1
                still?.alpha = 0
            }, completion: { _ in still?.removeFromSuperview() })
        }
        coordinator.animate(alongsideTransition: { _ in
            if let still { still.center = CGPoint(x: host.bounds.midX, y: host.bounds.midY) }
            UIView.performWithoutAnimation { host.layoutIfNeeded() }
            webView.callAsyncJavaScript(
                """
                const until = Date.now() + 400;
                while (Math.abs(innerWidth - width) > 1 && Date.now() < until) {
                  await new Promise(r => requestAnimationFrame(r));
                }
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                """,
                arguments: ["width": Double(size.width)], in: nil, in: .page
            ) { _ in show() }
        }, completion: { _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { show() }
        })
    }

    override open func capacitorDidLoad() {
        #if OPERALIBRE_EXPERIMENTAL_GIFTS
        bridge?.registerPluginInstance(GiftImportPlugin())
        #endif
        bridge?.registerPluginInstance(BackgroundDownloadsPlugin())
        bridge?.registerPluginInstance(LibroDevicePlugin())
        bridge?.registerPluginInstance(NativeAudioPlugin())
        bridge?.registerPluginInstance(CarPlayBridgePlugin())
        bridge?.registerPluginInstance(NativeTabsPlugin())
        bridge?.registerPluginInstance(DeviceFoldPlugin())
        bridge?.registerPluginInstance(AppIconPlugin())
        webView?.scrollView.bounces = false
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            webView?.scrollView.topEdgeEffect.isHidden = true
        }
        #endif
    }
}

@objc(AppIconPlugin)
final class AppIconPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "AppIconPlugin"
    let jsName = "AppIcon"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "current", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "select", returnType: CAPPluginReturnPromise)
    ]

    @objc func current(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let app = UIApplication.shared
            guard app.supportsAlternateIcons else { call.resolve(); return }
            call.resolve(["name": app.alternateIconName ?? "Classic"])
        }
    }

    @objc func select(_ call: CAPPluginCall) {
        guard let name = call.getString("name") else { call.reject("Missing icon name"); return }
        DispatchQueue.main.async {
            UIApplication.shared.setAlternateIconName(name == "Classic" ? nil : name) { error in
                if let error { call.reject(error.localizedDescription); return }
                call.resolve(["name": name])
            }
        }
    }
}
