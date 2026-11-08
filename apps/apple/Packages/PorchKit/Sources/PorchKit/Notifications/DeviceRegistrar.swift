import Foundation

/// Sends this device's APNs token to `PUT /v1/devices/:id` for the signed-in
/// session (SPEC §3 Devices).
///
/// The app hands it the token from `didRegisterForRemoteNotifications` and
/// calls `registerIfNeeded()` after sign-in. It sends each (device, token)
/// pair once per launch; a failed send is retried on the next call.
public actor DeviceRegistrar {
    private let api: any APIClient
    private let sessionStore: any SessionStore
    private let platform: Platform
    private let appVersion: String?
    private let environment: APNSEnvironment

    private var token: String?
    private var sentKey: String?

    public init(api: any APIClient, sessionStore: any SessionStore, platform: Platform = .current,
                appVersion: String?, environment: APNSEnvironment) {
        self.api = api
        self.sessionStore = sessionStore
        self.platform = platform
        self.appVersion = appVersion
        self.environment = environment
    }

    /// Saves the token and sends it if signed in. Returns the device when a PUT was sent.
    @discardableResult
    public func setToken(_ token: Data) async throws -> Device? {
        self.token = PushEnvironment.hexToken(token)
        return try await registerIfNeeded()
    }

    /// Sends the saved token for the current session unless it already went out.
    @discardableResult
    public func registerIfNeeded() async throws -> Device? {
        guard let token, let session = try sessionStore.load() else { return nil }
        let key = "\(session.deviceId)|\(token)"
        guard key != sentKey else { return nil }
        let request = DevicePutRequest(platform: platform, apnsToken: token, appVersion: appVersion, environment: environment)
        let device = try await api.putDevice(id: session.deviceId, request)
        sentKey = key
        return device
    }

    /// After sign-out the server drops the device row, so the next session must send again.
    public func reset() {
        sentKey = nil
    }
}

/// `UNAuthorizationStatus` without UserNotifications, so the policy is testable here.
public enum NotificationAuthorization: Hashable, Sendable {
    case notDetermined, denied, authorized, provisional, ephemeral
}

/// When to show the system notification prompt: once the person has a
/// package to be told about, and only while the app is on screen.
public enum NotificationPrompt {
    public static func shouldAsk(authorization: NotificationAuthorization, hasPackages: Bool, appIsActive: Bool) -> Bool {
        authorization == .notDetermined && hasPackages && appIsActive
    }
}
