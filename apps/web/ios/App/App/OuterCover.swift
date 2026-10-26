import AVFoundation
import Capacitor
import UIKit

/// Shows the loaded book's cover on iPhone Duo's outer display while the phone
/// is open, for whoever is on the other side of it.
///
/// iOS lends the outer display of an open Duo to an app only through a camera
/// capture scene accessory, which the system presents while a camera session
/// runs with its preview on screen. So when the listener opts in, the rear
/// camera (which faces the same way as the outer display) runs at its lowest
/// settings, and a thumbnail viewfinder sits in a corner of the cover. Frames go
/// to that preview layer alone: nothing is recorded, saved, or analyzed. The
/// camera only runs while the phone is open, the app is in the foreground, and
/// a book with a cover is loaded.
final class OuterCoverController {
    static let shared = OuterCoverController()
    private static let enabledKey = "operalibre.outer-cover.enabled.v1"
    // A still cover needs no more than a few frames a second behind it.
    private static let previewFrameRate: Float64 = 5

    /// Whether the build and OS have the scene accessory at all.
    static var isSupported: Bool {
        #if compiler(>=6.4)
        if #available(iOS 27.1, *) { return true }
        #endif
        return false
    }

    var isEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: Self.enabledKey) }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.enabledKey)
            update()
        }
    }

    /// The cover the outer display shows; the coordinated view redraws on change.
    private(set) var cover: UIImage? {
        didSet { onCoverChange?(cover) }
    }
    var onCoverChange: ((UIImage?) -> Void)?

    private let session: AVCaptureSession
    private let sessionQueue = DispatchQueue(label: "com.operalibre.outer-cover-camera", qos: .utility)
    private var sessionConfigured = false
    private var sessionRunning = false
    /// The one viewfinder. The accessory's view hosts it while it is on screen.
    let previewLayer: AVCaptureVideoPreviewLayer
    private var isOpen = false
    private var isForeground = UIApplication.shared.applicationState != .background
    private var registration: AnyObject?
    private var observers: [NSObjectProtocol] = []

    private init() {
        let session = AVCaptureSession()
        // No microphone is ever added; leave the audiobook's session alone.
        session.automaticallyConfiguresApplicationAudioSession = false
        self.session = session
        previewLayer = AVCaptureVideoPreviewLayer(session: session)
        previewLayer.videoGravity = .resizeAspectFill
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                self?.isForeground = false
                self?.update()
            },
            center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
                self?.isForeground = true
                self?.update()
            },
            center.addObserver(forName: AudiobookPlayer.artworkDidChange, object: nil, queue: .main) { [weak self] _ in
                self?.cover = AudiobookPlayer.shared.artworkImage
                self?.update()
            }
        ]
        cover = AudiobookPlayer.shared.artworkImage
    }

    /// Offers the accessory from the full-screen controller on the inner
    /// display, and follows the hinge so the camera runs only while open.
    func attach(to host: UIViewController) {
        #if compiler(>=6.4)
        guard #available(iOS 27.1, *), registration == nil else { return }
        let configuration = UISceneConfiguration(name: "OperaLibre Outer Cover", sessionRole: .windowCameraCaptureAccessory)
        configuration.delegateClass = OuterCoverSceneDelegate.self
        let registration = host.registerSceneAccessory(
            UISceneAccessory.cameraCapture(sceneConfiguration: configuration, userInfo: nil)
        )
        registration.isEnabled = isEnabled
        self.registration = registration
        host.view.addInteraction(UIHingeInteraction { [weak self] _, update in
            let status = update.hinge?.status
            self?.isOpen = status == .partiallyOpen || status == .fullyOpen
            self?.update()
        })
        #endif
    }

    private func update() {
        #if compiler(>=6.4)
        if #available(iOS 27.1, *) {
            (registration as? UISceneAccessoryRegistration)?.isEnabled = isEnabled
        }
        #endif
        let shouldRun = Self.isSupported && isEnabled && isOpen && isForeground && cover != nil
            && AVCaptureDevice.authorizationStatus(for: .video) == .authorized
        guard shouldRun != sessionRunning else { return }
        sessionRunning = shouldRun
        sessionQueue.async { [weak self] in
            guard let self else { return }
            if shouldRun {
                guard self.configureSession() else { return }
                if !self.session.isRunning { self.session.startRunning() }
            } else if self.session.isRunning {
                self.session.stopRunning()
            }
        }
    }

    /// The rear camera at the smallest preset and frame rate it offers.
    private func configureSession() -> Bool {
        if sessionConfigured { return true }
        guard
            let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
                ?? AVCaptureDevice.default(for: .video),
            let input = try? AVCaptureDeviceInput(device: camera)
        else { return false }
        session.beginConfiguration()
        if session.canSetSessionPreset(.low) { session.sessionPreset = .low }
        guard session.canAddInput(input) else {
            session.commitConfiguration()
            return false
        }
        session.addInput(input)
        session.commitConfiguration()
        if let range = camera.activeFormat.videoSupportedFrameRateRanges.min(by: { $0.minFrameRate < $1.minFrameRate }),
           (try? camera.lockForConfiguration()) != nil {
            let rate = min(max(Self.previewFrameRate, range.minFrameRate), range.maxFrameRate)
            let duration = CMTime(seconds: 1 / rate, preferredTimescale: 600)
            camera.activeVideoMinFrameDuration = duration
            camera.activeVideoMaxFrameDuration = duration
            camera.unlockForConfiguration()
        }
        sessionConfigured = true
        return true
    }

    /// Turns the cover on or off, asking for the camera the first time.
    func setEnabled(_ enabled: Bool, completion: @escaping () -> Void) {
        guard enabled, AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined else {
            isEnabled = enabled && AVCaptureDevice.authorizationStatus(for: .video) == .authorized
            completion()
            return
        }
        AVCaptureDevice.requestAccess(for: .video) { granted in
            DispatchQueue.main.async { [weak self] in
                self?.isEnabled = granted
                completion()
            }
        }
    }

    var state: [String: Any] {
        let camera: String
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: camera = "granted"
        case .notDetermined: camera = "prompt"
        default: camera = "denied"
        }
        return ["supported": Self.isSupported, "enabled": isEnabled, "camera": camera]
    }
}

#if compiler(>=6.4)
/// The outer display's scene. The system connects it only while the accessory
/// is available, and takes it away when the phone closes or the app leaves the
/// foreground.
@available(iOS 27.1, *)
final class OuterCoverSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene, session.role == .windowCameraCaptureAccessory else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = OuterCoverViewController()
        // Shown, not made key: typing stays with the page on the inner display.
        window.isHidden = false
        self.window = window
    }
}
#endif

/// The cover, letterboxed on black, with the viewfinder the system requires
/// tucked into the bottom corner. It has no controls; touches do nothing.
private final class OuterCoverViewController: UIViewController {
    private let coverView = UIImageView()
    private let viewfinder = UIView()
    private let controller = OuterCoverController.shared

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        view.isUserInteractionEnabled = false
        coverView.contentMode = .scaleAspectFit
        coverView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(coverView)
        viewfinder.layer.cornerRadius = 12
        viewfinder.layer.masksToBounds = true
        viewfinder.translatesAutoresizingMaskIntoConstraints = false
        viewfinder.layer.addSublayer(controller.previewLayer)
        view.addSubview(viewfinder)
        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            coverView.topAnchor.constraint(equalTo: guide.topAnchor, constant: 24),
            coverView.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -24),
            coverView.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 24),
            coverView.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -24),
            viewfinder.widthAnchor.constraint(equalToConstant: 48),
            viewfinder.heightAnchor.constraint(equalToConstant: 64),
            viewfinder.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -12),
            viewfinder.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -12)
        ])
        coverView.image = controller.cover
        controller.onCoverChange = { [weak self] image in self?.coverView.image = image }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        controller.previewLayer.frame = viewfinder.bounds
        CATransaction.commit()
    }
}

/// Lets Settings turn the outer-display cover on and off.
@objc(OuterCoverPlugin)
public final class OuterCoverPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OuterCoverPlugin"
    public let jsName = "OuterCover"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setEnabled", returnType: CAPPluginReturnPromise)
    ]

    @objc func getState(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(OuterCoverController.shared.state) }
    }

    @objc func setEnabled(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        DispatchQueue.main.async {
            OuterCoverController.shared.setEnabled(enabled) {
                call.resolve(OuterCoverController.shared.state)
            }
        }
    }
}
