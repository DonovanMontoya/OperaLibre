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
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        (parent as? NativeTabsController)?.contentDidLayout()
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        let old = view.bounds.size
        let rotation = coordinator.targetTransform != .identity
            && ((abs(size.width - old.height) < 1 && abs(size.height - old.width) < 1)
                || (abs(size.width - old.width) < 1 && abs(size.height - old.height) < 1))
        let coverSized = { (size: CGSize) in min(size.width, size.height) < 500 }
        let otherScreen = !rotation && coverSized(size) != coverSized(old)
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
        webView?.scrollView.bounces = false
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            webView?.scrollView.topEdgeEffect.isHidden = true
        }
        #endif
    }
}
