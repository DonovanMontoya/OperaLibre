import Capacitor
import UIKit

/// Sits over the web view at its exact bounds, so its coordinate space is the
/// page's CSS viewport. It takes no touches; it only notices when the fold may
/// have moved (a rotation or resize lays it out again) and hosts the hinge
/// interaction.
private final class FoldProbeView: UIView {
    var onChange: (() -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        onChange?()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        onChange?()
    }
}

/// Reports a foldable iPhone's posture and where its fold crosses the page, so
/// the web layout can keep content off the crease and split across the two
/// halves. Devices without a hinge never send anything, and the page keeps its
/// ordinary layout.
@objc(DeviceFoldPlugin)
public class DeviceFoldPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DeviceFoldPlugin"
    public let jsName = "DeviceFold"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise)]
    private var probe: FoldProbeView?
    private var posture = "unknown"
    private var angle: Double?
    private var state: [String: Any] = ["posture": "unknown"]

    override public func load() {
        DispatchQueue.main.async { [weak self] in self?.attach() }
    }

    @objc func getState(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.attach()
            self?.refresh(notify: false)
            call.resolve(self?.state ?? [:])
        }
    }

    private func attach() {
        guard probe == nil, let webView = bridge?.webView else { return }
        let probe = FoldProbeView(frame: webView.bounds)
        probe.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        probe.isUserInteractionEnabled = false
        probe.backgroundColor = .clear
        probe.onChange = { [weak self] in self?.refresh(notify: true) }
        webView.addSubview(probe)
        self.probe = probe
        #if compiler(>=6.4)
        if #available(iOS 27.1, *) {
            probe.addInteraction(UIHingeInteraction { [weak self] _, update in
                guard let self else { return }
                if let hinge = update.hinge {
                    self.posture = Self.posture(hinge.status)
                    self.angle = Double(hinge.angle) * 180 / .pi
                } else {
                    self.posture = "unknown"
                    self.angle = nil
                }
                self.refresh(notify: true)
            })
        }
        #endif
    }

    private func refresh(notify: Bool) {
        var next: [String: Any] = ["posture": posture]
        if let angle { next["angle"] = angle.rounded() }
        #if compiler(>=6.4)
        if #available(iOS 27.1, *), let probe,
           let fold = probe.reservedRegions(kind: .division, options: .includeInactive)
            .first(where: { Self.dividesViewport($0.frame, bounds: probe.bounds) }) {
            let frame = fold.frame
            next["fold"] = [
                "x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height,
                "axis": frame.height >= frame.width ? "vertical" : "horizontal",
                "active": fold.isActive
            ] as [String: Any]
        }
        #endif
        guard !NSDictionary(dictionary: next).isEqual(to: state) else { return }
        state = next
        if notify { notifyListeners("change", data: next, retainUntilConsumed: true) }
    }

    static func dividesViewport(_ frame: CGRect, bounds: CGRect) -> Bool {
        guard !frame.isNull, !frame.isInfinite, !bounds.isEmpty,
              frame.width > 0 || frame.height > 0,
              frame.minX.isFinite, frame.minY.isFinite,
              frame.maxX.isFinite, frame.maxY.isFinite else { return false }
        // A multitasking window can occupy just one side of the display.
        // Only split the page when the region leaves room on both sides.
        if frame.height >= frame.width {
            return frame.minX > bounds.minX && frame.maxX < bounds.maxX
                && frame.maxY > bounds.minY && frame.minY < bounds.maxY
        }
        return frame.minY > bounds.minY && frame.maxY < bounds.maxY
            && frame.maxX > bounds.minX && frame.minX < bounds.maxX
    }

    #if compiler(>=6.4)
    @available(iOS 27.1, *)
    private static func posture(_ status: UIHinge.Status) -> String {
        switch status {
        case .closed: return "closed"
        case .partiallyOpen: return "half-open"
        case .fullyOpen: return "flat"
        default: return "unknown"
        }
    }
    #endif
}
