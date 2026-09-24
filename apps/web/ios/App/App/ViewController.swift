import Capacitor

class ViewController: CAPBridgeViewController {
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
