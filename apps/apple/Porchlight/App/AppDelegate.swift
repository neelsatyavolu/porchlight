import Foundation
import OSLog
import PorchKit
import SwiftUI
import UserNotifications
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Owns the app's model and the push, deep link and background refresh
/// plumbing. PorchlightApp installs it with the delegate adaptor and puts
/// `model`, `router` and `push` in the environment.
@MainActor
final class AppDelegate: NSObject {
    let model: AppModel
    let router = DeepLinkRouter()
    let push: PushController
    let refresh: RefreshScheduler
    /// The Amazon importer (SPEC §6): on open, on iOS background refresh, every 30 min on the Mac.
    let amazon: AmazonModel
    /// USPS, UPS and FedEx pages read on the device (docs/API.md, "Device tracking"):
    /// on open, on iOS background refresh after Amazon, every 5 min on the Mac.
    let carriers: CarrierTrackingModel
    private let log = Logger(subsystem: "co.xanom.porchlight", category: "links")

    override init() {
        let model = AppModel()
        self.model = model
        push = PushController(api: model.api, sessionStore: model.sessionStore)
        // AppModel's one SyncEngine, so background runs join foreground ones.
        let engine = model.sync
        let screens = model.screens
        let refresh = RefreshScheduler(
            sync: BackgroundSync(sessionStore: model.sessionStore, engine: { engine }),
            didChangeStore: { screens.didChange() }
        )
        self.refresh = refresh
        let sessionStore = model.sessionStore
        amazon = AmazonModel(api: model.api, signedIn: { (try? sessionStore.load()) != nil })
        carriers = CarrierTrackingModel(
            api: model.api, signedIn: { (try? sessionStore.load()) != nil },
            didPost: { Task { _ = await refresh.run() } }
        )
        super.init()
    }

    /// `porchlight://p/<id>` goes to the router; anything else may be a
    /// sign-in link, which AppModel handles.
    func openURL(_ url: URL) {
        if let link = DeepLink(url: url) {
            router.open(link)
            return
        }
        let model = model
        Task {
            do {
                try await model.handleOpenURL(url)
            } catch {
                log.error("sign-in link failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    func sessionChanged(_ phase: AppModel.Phase) {
        switch phase {
        case .signedIn: push.sessionChanged(signedIn: true)
        case .signedOut: push.sessionChanged(signedIn: false)
        }
    }

    func scenePhaseChanged(_ phase: ScenePhase) {
        push.appIsActive = phase == .active
        switch phase {
        case .active:
            // Amazon first when it is due; the carrier pages share the time after it.
            Task {
                await amazon.importIfDue()
                await carriers.checkIfDue()
            }
            Task {
                // A first sync that brings packages in (one added on the web or
                // through the share sheet) is also a good time for the prompt.
                if await refresh.run() == .newData {
                    await push.askIfNeeded(hasPackages: true)
                }
            }
        case .background:
            #if os(iOS)
            refresh.scheduleAppRefresh()
            #endif
        default:
            break
        }
    }

    #if os(iOS)
    /// The `co.xanom.porchlight.refresh` task: book the next one, then sync.
    func handleAppRefresh() async {
        // The whole refresh gets about 30 seconds, so the Amazon import stops opening pages in time to send what it read.
        let started = Date()
        let amazonDeadline = started.addingTimeInterval(AmazonImporter.backgroundBudget)
        refresh.scheduleAppRefresh()
        _ = await refresh.run()
        await amazon.importIfDue(deadline: amazonDeadline)
        // Carrier pages get what is left; no lookup starts that can't finish in it.
        await carriers.checkIfDue(deadline: started.addingTimeInterval(DeviceTrackingCoordinator.backgroundBudget))
    }
    #endif

    private func pushArrived() {
        Task { _ = await refresh.run() }
    }

    private func notificationOpened(_ link: DeepLink?) {
        if let link { router.open(link) }
        pushArrived()
    }
}

#if os(iOS)
extension AppDelegate: UIApplicationDelegate {
    func application(
        _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        push.registerForRemoteNotifications()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        push.tokenReceived(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        push.registrationFailed(error)
    }

    /// Silent pushes (`content-available: 1`): sync, then tell iOS what came of it.
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any]) async -> UIBackgroundFetchResult {
        guard PushPayload(userInfo: userInfo) != nil else { return .noData }
        switch await refresh.run() {
        case .newData: return .newData
        case .failed: return .failed
        case .noData, .signedOut: return .noData
        }
    }
}
#else
extension AppDelegate: NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
        push.registerForRemoteNotifications()
        refresh.startTimer()
        amazon.startTimer()
        carriers.startTimer()
    }

    func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        push.tokenReceived(deviceToken)
    }

    func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        push.registrationFailed(error)
    }

    /// Silent pushes reach the Mac app only while it runs.
    func application(_ application: NSApplication, didReceiveRemoteNotification userInfo: [String: Any]) {
        guard PushPayload(userInfo: userInfo) != nil else { return }
        pushArrived()
    }
}
#endif

extension AppDelegate: UNUserNotificationCenterDelegate {
    /// A visible push while the app is open: show it and sync.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        if PushPayload(userInfo: notification.request.content.userInfo) != nil {
            await pushArrived()
        }
        return [.banner, .list, .sound]
    }

    /// A tap on a push: open its package.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let link = PushPayload(userInfo: response.notification.request.content.userInfo)?.deepLink
        await notificationOpened(link)
    }
}
