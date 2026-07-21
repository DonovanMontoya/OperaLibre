import Capacitor

class ViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(BackgroundDownloadsPlugin())
        bridge?.registerPluginInstance(NativeAudioPlugin())
    }
}
