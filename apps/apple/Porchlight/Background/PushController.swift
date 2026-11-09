import Foundation
import Observation
import OSLog
import PorchKit
import UserNotifications
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// APNs registration and the notification prompt. The logic it calls
/// (DeviceRegistrar, NotificationPrompt, PushEnvironment) is tested in PorchKit.
///
/// The prompt shows once, the first time the app is in front while signed in.
/// Settings shows the current permission and a way to turn it on.
@Observable
@MainActor
final class PushController {
    @ObservationIgnored private let registrar: DeviceRegistrar
    @ObservationIgnored private let log = Logger(subsystem: "co.xanom.porchlight", category: "push")
    /// Set by AppDelegate from the scene phase. The prompt only shows while true.
    @ObservationIgnored var appIsActive = false
    /// The notification permission, as of the last check.
    private(set) var authorization = NotificationAuthorization.notDetermined
    @ObservationIgnored private var signedIn = false

    init(api: any APIClient, sessionStore: any SessionStore) {
        registrar = DeviceRegistrar(api: api, sessionStore: sessionStore,
                                    appVersion: PushEnvironment.appVersion(of: .main),
                                    environment: Self.environment())
    }

    func registerForRemoteNotifications() {
        #if os(iOS)
        UIApplication.shared.registerForRemoteNotifications()
        #else
        NSApplication.shared.registerForRemoteNotifications()
        #endif
    }

    func tokenReceived(_ token: Data) {
        Task {
            do {
                try await registrar.setToken(token)
            } catch {
                log.error("device registration failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    func registrationFailed(_ error: any Error) {
        log.error("APNs registration failed: \(String(describing: error), privacy: .public)")
    }

    func sessionChanged(signedIn: Bool) {
        self.signedIn = signedIn
        Task {
            guard signedIn else {
                await registrar.reset()
                return
            }
            registerForRemoteNotifications()
            do {
                try await registrar.registerIfNeeded()
            } catch {
                log.error("device registration failed: \(String(describing: error), privacy: .public)")
            }
            await askIfNeeded()
        }
    }

    /// Call after a package is added, in case the prompt hasn't shown yet.
    func packageAdded() {
        Task { await askIfNeeded() }
    }

    /// Shows the system prompt if it hasn't been answered, someone is signed in
    /// and the app is in front. Safe to call often.
    func askIfNeeded() async {
        await checkAuthorization()
        guard NotificationPrompt.shouldAsk(authorization: authorization, signedIn: signedIn, appIsActive: appIsActive) else { return }
        await request()
    }

    /// Settings' button: the prompt if it was never answered, otherwise the
    /// system's notification settings for Porchlight (the prompt shows only once).
    func turnOn() async {
        await checkAuthorization()
        if authorization == .notDetermined {
            await request()
        } else {
            openSystemSettings()
        }
    }

    func checkAuthorization() async {
        let status = await withCheckedContinuation { (cont: CheckedContinuation<UNAuthorizationStatus, Never>) in
            UNUserNotificationCenter.current().getNotificationSettings { @Sendable settings in
                cont.resume(returning: settings.authorizationStatus)
            }
        }
        authorization = switch status {
        case .notDetermined: .notDetermined
        case .denied: .denied
        case .provisional: .provisional
        default: .authorized
        }
    }

    private func request() async {
        do {
            _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        } catch {
            log.error("notification permission request failed: \(String(describing: error), privacy: .public)")
        }
        await checkAuthorization()
    }

    private func openSystemSettings() {
        #if os(iOS)
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        UIApplication.shared.open(url)
        #else
        let id = Bundle.main.bundleIdentifier ?? "co.xanom.porchlight"
        guard let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(id)") else { return }
        NSWorkspace.shared.open(url)
        #endif
    }

    private static func environment() -> APNSEnvironment {
        #if targetEnvironment(simulator)
        return .sandbox
        #else
        #if DEBUG
        let isDebug = true
        #else
        let isDebug = false
        #endif
        return PushEnvironment.resolve(provisioningProfile: provisioningProfile(), isDebugBuild: isDebug)
        #endif
    }

    private static func provisioningProfile() -> Data? {
        #if os(iOS)
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision") else { return nil }
        #else
        let url = Bundle.main.bundleURL.appending(path: "Contents/embedded.provisionprofile")
        #endif
        return try? Data(contentsOf: url)
    }
}
