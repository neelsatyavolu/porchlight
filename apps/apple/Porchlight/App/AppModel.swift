import Foundation
import Observation
import PorchKit
import PorchStore
import SwiftData

/// App-wide state: who is signed in, and the services screens use.
/// Screens reach it through `screens` (ScreenServices), whose `account` is
/// this model; RootView switches on `phase`.
@Observable
@MainActor
final class AppModel: AccountActions {
    enum Phase: Equatable {
        case signedOut
        case signedIn(Session)
    }

    private(set) var phase: Phase
    let sessionStore: any SessionStore
    let detector: any CarrierDetector
    let api: any APIClient
    /// Rebuilt on sign-out with a new device id (DeviceID.rotate).
    @ObservationIgnored private(set) var auth: AuthService
    @ObservationIgnored private let deviceDefaults: UserDefaults
    /// Attach to the scene with `.modelContainer(model.container)` so @Query sees synced packages.
    let container: ModelContainer
    let sync: any SyncEngine
    let repository: any PackageRepository
    /// What the screens use. Built once, so the window and the menu bar share it.
    @ObservationIgnored private(set) lazy var screens = ScreenServices(
        account: self, api: api, sync: sync, repository: repository, detector: detector
    )

    init(sessionStore: any SessionStore = KeychainSessionStore(), detector: any CarrierDetector = RuleCarrierDetector()) {
        self.sessionStore = sessionStore
        self.detector = detector

        // A 401 on a signed-in request ends the session (see endLocalSession).
        let (expired, expire) = AsyncStream<Void>.makeStream()
        let store = sessionStore
        let api = HTTPAPIClient(
            baseURL: Self.baseURL, token: { try? store.load()?.token },
            onUnauthorized: { refused in if (try? store.load()?.token) == refused { expire.yield() } }
        )
        self.api = api
        let container = Self.makeContainer()
        self.container = container
        let repository = SwiftDataPackageRepository(modelContainer: container)
        self.repository = repository
        sync = WidgetSyncEngine(base: DefaultSyncEngine(api: api, repository: repository), repository: repository)
        let defaults = UserDefaults.standard
        deviceDefaults = defaults
        auth = AuthService(api: api, store: sessionStore, deviceId: DeviceID.load(from: defaults))

        let saved = try? sessionStore.load()
        phase = saved.map(Phase.signedIn) ?? .signedOut

        Task { [weak self] in
            for await _ in expired { self?.endLocalSession() }
        }
    }

    var currentUser: User? {
        if case let .signedIn(session) = phase { session.user } else { nil }
    }

    // MARK: Sign in with Apple

    /// `nonce` is the one whose hash went into the Apple request (SignInView makes it).
    func signInWithApple(identityToken: Data?, nonce: AppleNonce) async throws {
        didSignIn(try await auth.signInWithApple(identityToken: identityToken, nonce: nonce))
    }

    // MARK: Email

    func startEmail(_ email: String) async throws {
        try await auth.startEmail(email)
    }

    func verifyEmail(email: String, code: String) async throws {
        didSignIn(try await auth.verifyEmail(email: email, code: code))
    }

    /// A magic link opened as a universal link. False when `url` isn't one.
    @discardableResult
    func handleOpenURL(_ url: URL) async throws -> Bool {
        guard let token = AuthService.linkToken(from: url) else { return false }
        didSignIn(try await auth.verifyEmail(linkToken: token))
        return true
    }

    // MARK: Session

    func signOut() async {
        await auth.signOut()
        endLocalSession()
    }

    /// Throws if the server didn't confirm; the user stays signed in.
    func deleteAccount() async throws {
        try await auth.deleteAccount()
        endLocalSession()
    }

    /// Settings, "Signed in on". Signing out this device's own session ends it here too.
    func signOutSession(id: String) async throws {
        if try await api.deleteSession(id: id).signedOut { endLocalSession() }
    }

    // MARK: Private

    private func didSignIn(_ session: Session) {
        phase = .signedIn(session)
        let engine = sync
        let screens = screens
        Task {
            _ = try? await engine.sync()
            screens.didChange()
        }
    }

    /// Forgets the session and every local package. Safe to call twice.
    private func endLocalSession() {
        try? sessionStore.clear()
        phase = .signedOut
        auth = AuthService(api: api, store: sessionStore, deviceId: DeviceID.rotate(in: deviceDefaults))
        let engine = sync
        let screens = screens
        Task {
            try? await engine.reset()
            screens.didChange()
        }
    }

    /// Production, unless the scheme sets PORCHLIGHT_API_URL (e.g. http://localhost:8787/v1 in the simulator).
    private static var baseURL: URL {
        if let raw = ProcessInfo.processInfo.environment["PORCHLIGHT_API_URL"], let url = URL(string: raw) { return url }
        return PorchConfig.productionBaseURL
    }

    /// The app's own store (no app group); if it can't open, a default
    /// container, then an in-memory one, so launch never crashes on it.
    private static func makeContainer() -> ModelContainer {
        if let container = try? PorchStore.makeContainer() { return container }
        let schema = Schema(PorchStore.models)
        if let container = try? ModelContainer(for: schema, configurations: ModelConfiguration(schema: schema)) { return container }
        do {
            return try PorchStore.makeContainer(inMemory: true)
        } catch {
            fatalError("Porchlight couldn't open its package store: \(error)")
        }
    }
}
