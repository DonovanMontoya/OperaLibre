import Capacitor
import UIKit

extension UIView {
    /// A still picture of the view as it is on screen now. A
    /// snapshotView(afterScreenUpdates:) of a web view keeps mirroring its
    /// live layers, so it cannot hold a frame while the page changes beneath.
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

    /// WebKit resizes the page by stretching its last frame to the new size
    /// and only laying it out again at the end, so a rotation balloons covers
    /// mid-turn and a foldable moving the app between its cover and inner
    /// screens shows the other screen's layout squeezed onto this one.
    /// Instead the page takes its new size at once, outside the transition's
    /// animation, so WebKit lays it out straight away, and stays hidden until
    /// it has drawn. A rotation covers it with a still of the old page that
    /// turns with the screen; a move between screens has nothing of the right
    /// shape to show, so the screen's own background stands in.
    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        let old = view.bounds.size
        let rotation = coordinator.targetTransform != .identity
            && ((abs(size.width - old.height) < 1 && abs(size.height - old.width) < 1)
                || (abs(size.width - old.width) < 1 && abs(size.height - old.height) < 1))
        // The cover is under 500 points on its short side; the inner screen is not.
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
            // Wait for the page to see its new width, then for it to lay out
            // and paint.
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
            // Never leave the page hidden if the script cannot answer.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { show() }
        })
    }

    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(BackgroundDownloadsPlugin())
        bridge?.registerPluginInstance(LibroDevicePlugin())
        bridge?.registerPluginInstance(NativeAudioPlugin())
        bridge?.registerPluginInstance(CarPlayBridgePlugin())
        bridge?.registerPluginInstance(NativeTabsPlugin())
        bridge?.registerPluginInstance(DeviceFoldPlugin())
        // The page runs behind the clock on its own background. UIKit's
        // scroll edge effect would lay a light haze over it there, which
        // reads as a glow at the top of the dark screens.
        if #available(iOS 26.0, *) {
            webView?.scrollView.topEdgeEffect.isHidden = true
        }
    }
}
