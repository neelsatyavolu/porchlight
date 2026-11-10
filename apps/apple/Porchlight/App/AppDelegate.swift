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
    #if os(macOS)
    /// Sparkle auto-update; starts checking as soon as the app launches.
    let updater = Updater()
    #endif
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
        amazon = AmazonModel(
            api: model.api, signedIn: { (try? sessionStore.load()) != nil },
            didImport: { Task { _ = await refresh.run() } },
            packages: { [repository = model.repository] in (try? await repository.packages(includeArchived: false)) ?? [] }
        )
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
                _ = await refresh.run()
                // Asks for notification permission the first time, once signed in.
                await push.askIfNeeded()
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
        let started = Date()
        refresh.scheduleAppRefresh()
        _ = await refresh.run()
        await readOnDevice(started: started)
    }

    /// Reads what only this device can: Amazon, then due carrier pages. iOS gives
    /// a background run about 30 seconds, so each stops starting new pages in time
    /// to send what it read. Used by background refresh and the server's wake push.
    private func readOnDevice(started: Date) async {
        await amazon.importIfDue(deadline: started.addingTimeInterval(AmazonImporter.backgroundBudget))
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
        guard let payload = PushPayload(userInfo: userInfo) else { return .noData }
        // The server's "check now" (docs/API.md "Background checks"): read Amazon and
        // carrier pages; what changes comes back as the usual alert push.
        if payload.wantsCheck {
            let started = Date()
            _ = await refresh.run()
            await readOnDevice(started: started)
        }
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
        LoginItem.turnOnOnce()
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
