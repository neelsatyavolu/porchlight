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
/// Screens get it from the environment and call `packageAdded()` after a
/// package is added, which is when the prompt shows (once).
@Observable
@MainActor
final class PushController {
    @ObservationIgnored private let registrar: DeviceRegistrar
    @ObservationIgnored private let log = Logger(subsystem: "co.xanom.porchlight", category: "push")
    /// Set by AppDelegate from the scene phase. The prompt only shows while true.
    @ObservationIgnored var appIsActive = false

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
        }
    }

    /// Call after a package is added. Shows the system prompt the first time.
    func packageAdded() {
        Task { await askIfNeeded(hasPackages: true) }
    }

    func askIfNeeded(hasPackages: Bool) async {
        let status = await withCheckedContinuation { (cont: CheckedContinuation<UNAuthorizationStatus, Never>) in
            UNUserNotificationCenter.current().getNotificationSettings { @Sendable settings in
                cont.resume(returning: settings.authorizationStatus)
            }
        }
        let authorization: NotificationAuthorization = switch status {
        case .notDetermined: .notDetermined
        case .denied: .denied
        case .provisional: .provisional
        default: .authorized
        }
        guard NotificationPrompt.shouldAsk(authorization: authorization, hasPackages: hasPackages, appIsActive: appIsActive) else { return }
        do {
            _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        } catch {
            log.error("notification permission request failed: \(String(describing: error), privacy: .public)")
        }
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
