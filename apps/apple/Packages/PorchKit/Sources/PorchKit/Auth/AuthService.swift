import Foundation

/// Sign-in, sign-out and device registration on top of an `APIClient` and a
/// `SessionStore`. The app model calls these; screens call the app model.
public struct AuthService: Sendable {
    public let api: any APIClient
    public let store: any SessionStore
    /// This install's device id, sent with sign-in and `PUT /v1/devices/:id`.
    public let deviceId: String

    public init(api: any APIClient, store: any SessionStore, deviceId: String) {
        self.api = api
        self.store = store
        self.deviceId = deviceId
    }

    /// Finishes Sign in with Apple. `identityToken` is the credential's
    /// `identityToken` data; `nonce` is the one whose hash went to Apple.
    public func signInWithApple(identityToken: Data?, nonce: AppleNonce) async throws -> Session {
        guard let identityToken, let jwt = String(data: identityToken, encoding: .utf8), !jwt.isEmpty else {
            throw AuthError.missingIdentityToken
        }
        let response = try await api.signInWithApple(AppleSignInRequest(identityToken: jwt, nonce: nonce.raw, deviceId: deviceId))
        return try save(response)
    }

    /// Emails a link and a 6-digit code.
    public func startEmail(_ email: String) async throws {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.contains("@") else { throw AuthError.invalidEmail }
        try await api.startEmailSignIn(EmailStartRequest(email: trimmed))
    }

    /// Trades the emailed code for a session.
    public func verifyEmail(email: String, code: String) async throws -> Session {
        let digits = code.filter { !$0.isWhitespace }
        guard digits.count == 6, digits.allSatisfy(\.isASCII), digits.allSatisfy(\.isNumber) else { throw AuthError.invalidCode }
        let request = EmailVerifyRequest.code(
            email: email.trimmingCharacters(in: .whitespacesAndNewlines), code: digits, deviceId: deviceId
        )
        return try save(try await api.verifyEmail(request))
    }

    /// Trades the token from the emailed link (universal link) for a session.
    public func verifyEmail(linkToken: String) async throws -> Session {
        try save(try await api.verifyEmail(.token(linkToken, deviceId: deviceId)))
    }

    /// The token from a magic link URL (`https://<webHost>/auth/verify?token=...`),
    /// or nil. Any other scheme or host is refused: a `porchlight://` link from
    /// a web page could otherwise sign the app in to someone else's account.
    public static func linkToken(from url: URL, host: String = PorchConfig.webHost) -> String? {
        guard url.scheme?.lowercased() == "https", url.host(percentEncoded: false)?.lowercased() == host,
              url.path() == "/auth/verify" else { return nil }
        let token = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "token" }?.value
        return token.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// Tells the server, then forgets the session locally whatever the server
    /// said: an offline sign-out still signs out this device.
    public func signOut() async {
        try? await api.signOut()
        try? store.clear()
    }

    /// Deletes the account. The local session is cleared only once the server
    /// confirms, so a failure leaves the user signed in to retry.
    public func deleteAccount() async throws {
        try await api.deleteAccount()
        try? store.clear()
    }

    /// `PUT /v1/devices/:id` for this install. `apnsToken` is the raw token
    /// from `didRegisterForRemoteNotificationsWithDeviceToken`.
    @discardableResult
    public func registerDevice(apnsToken: Data?, appVersion: String?, environment: APNSEnvironment) async throws -> Device {
        let request = DevicePutRequest(
            apnsToken: apnsToken.map { AppleNonce.hex($0) }, appVersion: appVersion, environment: environment
        )
        return try await api.putDevice(id: deviceId, request)
    }

    private func save(_ response: SignInResponse) throws -> Session {
        guard let token = response.token, !token.isEmpty else { throw AuthError.missingSessionToken }
        let session = Session(token: token, user: response.user, deviceId: deviceId)
        try store.save(session)
        return session
    }
}

public enum AuthError: Error, Hashable, Sendable {
    /// Apple returned a credential without an identity token.
    case missingIdentityToken
    /// The server answered sign-in without a token (only web sessions do that).
    case missingSessionToken
    case invalidEmail
    case invalidCode
}

/// This install's device id: a lowercase UUID created once and kept in the
/// given defaults (the app's own; there is no app group).
public enum DeviceID {
    public static let defaultsKey = "porchlight.deviceId"

    public static func load(from defaults: UserDefaults) -> String {
        if let saved = defaults.string(forKey: defaultsKey), !saved.isEmpty { return saved }
        let id = WireID.make()
        defaults.set(id, forKey: defaultsKey)
        return id
    }

    /// Replaces the saved id, for sign-out. The server's device row for the
    /// old id belongs to the old account, and if the sign-out never reached
    /// the server it still holds this install's APNs token; a new account
    /// registering under the same id would get a 404 and the old account's
    /// pushes would keep arriving. A fresh id makes a fresh row, and the
    /// server then moves the token off the old one.
    @discardableResult
    public static func rotate(in defaults: UserDefaults) -> String {
        let id = WireID.make()
        defaults.set(id, forKey: defaultsKey)
        return id
    }
}
