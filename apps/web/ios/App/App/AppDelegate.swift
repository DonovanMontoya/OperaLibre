 import UIKit
import AVFoundation

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Only the category is set here. Activating the exclusive playback
        // session would silence whatever else is playing merely because the
        // app was opened; NativeAudio activates it when playback starts.
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        } catch {
            NSLog("Unable to configure audiobook playback audio session: %@", error.localizedDescription)
        }
        BackgroundDownloadManager.shared.prepare()
        // Wired up before any scene exists: connecting to a car can launch the
        // app with the CarPlay scene alone, and the coordinator is what keeps
        // the position from that drive for the app to save later.
        CarPlayCoordinator.shared.start()
        return true
    }

    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        BackgroundDownloadManager.shared.handleEvents(identifier: identifier, completionHandler: completionHandler)
    }

}
