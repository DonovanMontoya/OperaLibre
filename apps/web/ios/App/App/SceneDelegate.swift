import Capacitor
import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        if let content = window?.rootViewController as? ViewController {
            window?.rootViewController = NativeTabsController(content: content)
        }
        if let delegate = UIApplication.shared.delegate as? AppDelegate {
            delegate.window = window
        }
        for context in connectionOptions.urlContexts {
            openURL(context)
        }
        if let userActivity = connectionOptions.userActivities.first {
            continueUserActivity(userActivity)
        }
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        (window?.rootViewController as? NativeTabsController)?.contentDidLayout(force: true)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            openURL(context)
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        continueUserActivity(userActivity)
    }

    private func openURL(_ context: UIOpenURLContext) {
        if context.url.scheme == "operalibre", context.url.host == "widget-resume" {
            CarPlayCoordinator.shared.resumeFromWidget(context.url)
            return
        }
        var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
        if let sourceApplication = context.options.sourceApplication {
            options[.sourceApplication] = sourceApplication
        }
        if let annotation = context.options.annotation {
            options[.annotation] = annotation
        }
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            open: context.url,
            options: options
        )
    }

    private func continueUserActivity(_ userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            continue: userActivity,
            restorationHandler: { _ in }
        )
    }
}
