import Capacitor
import UIKit

class ViewController: CAPBridgeViewController {
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        (parent as? NativeTabsController)?.contentDidLayout()
    }

    /// WebKit turns the screen by stretching the old page to the new width
    /// and only then laying it out again, so covers balloon mid-turn and the
    /// real layout snaps in at the end. Instead the page takes its new size
    /// at once, outside the turn's animation, so WebKit lays it out straight
    /// away; a still of the old page covers it until it has drawn, then gives
    /// way while the screen is still turning. Only a turn of the same screen
    /// swaps or keeps its size; a foldable moving between its cover and inner
    /// screens can carry a transform too, but changes size, and keeps its own
    /// transitions.
    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        let old = view.bounds.size
        let sameScreen = (abs(size.width - old.height) < 1 && abs(size.height - old.width) < 1)
            || (abs(size.width - old.width) < 1 && abs(size.height - old.height) < 1)
        FoldTrace.log("willTransition \(old) -> \(size) transform \(coordinator.targetTransform != .identity) sameScreen \(sameScreen)")
        guard coordinator.targetTransform != .identity, sameScreen, let webView, let host = view.superview,
              !webView.bounds.isEmpty else { return }
        // A real bitmap: snapshotView(afterScreenUpdates:) of a web view keeps
        // mirroring its live layers, stretched page and all.
        let image = UIGraphicsImageRenderer(bounds: webView.bounds).image { _ in
            webView.drawHierarchy(in: webView.bounds, afterScreenUpdates: false)
        }
        let still = UIImageView(image: image)
        still.frame = view.frame
        host.insertSubview(still, aboveSubview: view)
        webView.alpha = 0
        var shown = false
        let show = { [weak webView] in
            guard !shown else { return }
            shown = true
            UIView.animate(withDuration: 0.15, delay: 0, options: [.curveEaseOut, .beginFromCurrentState], animations: {
                webView?.alpha = 1
                still.alpha = 0
            }, completion: { _ in still.removeFromSuperview() })
        }
        coordinator.animate(alongsideTransition: { _ in
            still.center = CGPoint(x: host.bounds.midX, y: host.bounds.midY)
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
