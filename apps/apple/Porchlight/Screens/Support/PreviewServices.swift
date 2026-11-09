#if DEBUG
import Foundation
import PorchKit

// Fakes for SwiftUI previews only. Nothing here talks to the network.

extension ScreenServices {
    /// Services backed by sample data. `signedIn: false` previews sign-in.
    static func preview(signedIn: Bool = true, packages: [Package] = PreviewData.packages) -> ScreenServices {
        let repository = PreviewRepository(packages: packages, events: PreviewData.events)
        return ScreenServices(
            account: PreviewAccount(user: signedIn ? PreviewData.user : nil),
            api: PreviewAPI(),
            sync: PreviewSync(repository: repository),
            repository: repository,
            detector: PreviewDetector()
        )
    }
}

enum PreviewData {
    static let now = Date()
    static func ago(_ minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }
    static func today(plus days: Int) -> CalendarDate { CalendarDate(now, in: .current).adding(days: days) }

    static let user = User(id: "u1", email: "you@example.com", hasApple: true, createdAt: ago(60 * 24 * 30))

    static let packages: [Package] = [
        Package(id: "p1", carrier: .ups, trackingNumber: "1Z999AA10123456784", title: "Headphones", merchant: "Best Buy",
                status: .outForDelivery, statusDetail: "On vehicle, Oakland",
                eta: .window(start: now.addingTimeInterval(3600), end: now.addingTimeInterval(4 * 3600)),
                lastCheckedAt: ago(14), updatedAt: ago(14)),
        Package(id: "p2", carrier: .fedex, trackingNumber: "123456789012", merchant: "REI", status: .exception,
                statusDetail: "Delivery attempted, no access", eta: .day(start: today(plus: 0), end: nil),
                lastCheckedAt: ago(40), updatedAt: ago(40)),
        Package(id: "p3", carrier: .usps, trackingNumber: "9400100000000000004784", status: .inTransit,
                statusDetail: "Arrived at USPS facility", eta: .day(start: today(plus: 1), end: nil),
                lastCheckedAt: ago(90), updatedAt: ago(90)),
        Package(id: "p4", carrier: .amazon, trackingNumber: "TBA123456789012", title: "Desk lamp", source: .amazon,
                status: .inTransit, eta: .day(start: today(plus: 3), end: today(plus: 4)), lastCheckedAt: ago(200),
                updatedAt: ago(200), items: [PackageItem(name: "Desk lamp", quantity: 1), PackageItem(name: "LED bulb", quantity: 2)]),
        Package(id: "p5", carrier: .dhl, trackingNumber: "1234567890", title: "Running shoes", source: .flint,
                status: .labelCreated, lastCheckedAt: ago(300), updatedAt: ago(300)),
        Package(id: "p6", carrier: .ups, trackingNumber: "1Z999AA10123450001", title: "Coffee beans", status: .delivered,
                statusDetail: "Front door", deliveredAt: ago(120), lastCheckedAt: ago(110), updatedAt: ago(110)),
    ]

    static let events: [String: [TrackEvent]] = [
        "p1": [
            TrackEvent(id: "e3", packageId: "p1", occurredAt: ago(30), status: .outForDelivery, description: "Out for delivery", location: "Oakland, CA"),
            TrackEvent(id: "e2", packageId: "p1", occurredAt: ago(300), status: .inTransit, description: "Arrived at facility", location: "San Pablo, CA"),
            TrackEvent(id: "e1", packageId: "p1", occurredAt: ago(60 * 26), status: .labelCreated, description: "Shipper created a label"),
        ],
    ]

    /// The current session is the device the preview runs on.
    #if os(macOS)
    private static let thisDevice = Platform.macos, otherDevice = Platform.ios
    #else
    private static let thisDevice = Platform.ios, otherDevice = Platform.macos
    #endif

    static let sessions: [SessionInfo] = [
        session("s1", thisDevice, current: true, seen: 0),
        session("s2", otherDevice, current: false, seen: 180),
        session("s3", .web, current: false, seen: 60 * 50),
    ]

    private static func session(_ id: String, _ platform: Platform, current: Bool, seen minutes: Double) -> SessionInfo {
        let json = """
        {"id":"\(id)","platform":"\(platform.rawValue)","appVersion":"0.1.0 (1)","createdAt":"\(WireDate.format(ago(60 * 24 * 6)))",
         "lastSeenAt":"\(WireDate.format(ago(minutes)))","current":\(current)}
        """
        return try! WireJSON.decoder().decode(SessionInfo.self, from: Data(json.utf8))
    }
}

@MainActor
final class PreviewAccount: AccountActions {
    var currentUser: User?
    init(user: User?) { currentUser = user }
    func signInWithApple(identityToken: Data?, nonce: AppleNonce) async throws {}
    func startEmail(_ email: String) async throws {}
    func verifyEmail(email: String, code: String) async throws {}
    func signOut() async {}
    func deleteAccount() async throws {}
}

actor PreviewRepository: PackageRepository {
    private var stored: [Package]
    private let eventsById: [String: [TrackEvent]]

    init(packages: [Package], events: [String: [TrackEvent]]) {
        stored = packages
        eventsById = events
    }

    func packages(includeArchived: Bool) async throws -> [Package] { stored.filter { includeArchived || !$0.isArchived } }
    func package(id: String) async throws -> Package? { stored.first { $0.id == id } }
    func events(packageId: String) async throws -> [TrackEvent] { eventsById[packageId] ?? [] }
    func apply(_ page: SyncResponse) async throws {}
    func removeAll() async throws { stored = [] }
    func enqueue(_ write: PendingWrite, optimistic: Package?) async throws {
        stored.removeAll { $0.id == write.packageId }
        if let optimistic { stored.append(optimistic) }
    }
    func pendingWrites() async throws -> [PendingWrite] { [] }
    func acknowledge(_ write: PendingWrite, result: Package?) async throws {}
    func adopt(localId: String, existingId: String) async throws {}
    func cursor() async throws -> String? { nil }
    func setCursor(_ cursor: String?) async throws {}
}

struct PreviewSync: SyncEngine {
    let repository: PreviewRepository

    func sync() async throws -> SyncOutcome { SyncOutcome(changed: 0, deleted: 0, didFullSync: false, finishedAt: Date()) }

    func addPackage(trackingNumber: String, carrier: Carrier?, title: String?, source: ClientSource) async throws -> AddedPackage {
        let id = WireID.make()
        let pkg = Package(id: id, carrier: carrier ?? .other, trackingNumber: trackingNumber, title: title,
                          source: source == .share ? .share : .manual, updatedAt: Date())
        try await repository.enqueue(.put(id: id, request: PackagePutRequest()), optimistic: pkg)
        return AddedPackage(id: id, alreadyTracked: false)
    }

    func update(packageId: String, _ request: PackagePutRequest) async throws {
        guard var pkg = try await repository.package(id: packageId) else { return }
        if let title = request.title { pkg.title = title }
        if let archived = request.archived { pkg.archivedAt = archived ? Date() : nil }
        try await repository.enqueue(.put(id: packageId, request: request), optimistic: pkg)
    }

    func delete(packageId: String) async throws { try await repository.enqueue(.delete(id: packageId), optimistic: nil) }

    func refresh(packageId: String) async throws -> RefreshResponse {
        throw APIError.server(status: 429, body: APIErrorBody(code: .rateLimited, message: "Checked recently"), retryAfter: 100)
    }

    func reset() async throws { try await repository.removeAll() }
}

struct PreviewDetector: CarrierDetector {
    func normalize(_ raw: String) -> String {
        raw.filter { !$0.isWhitespace && $0 != "-" }.uppercased()
    }

    func detect(_ number: String) -> [Candidate] {
        let n = normalize(number)
        if n.hasPrefix("1Z") { return [Candidate(carrier: .ups, confidence: .high)] }
        if n.hasPrefix("TBA") { return [Candidate(carrier: .amazon, confidence: .high)] }
        if n.hasSuffix("US") { return [Candidate(carrier: .usps, confidence: .medium), Candidate(carrier: .dhlEcommerce, confidence: .medium)] }
        return []
    }
}

struct PreviewAPI: APIClient {
    private func unused() -> PorchError { .notImplemented("preview") }

    func signInWithApple(_ request: AppleSignInRequest) async throws -> SignInResponse { throw unused() }
    func startEmailSignIn(_ request: EmailStartRequest) async throws {}
    func verifyEmail(_ request: EmailVerifyRequest) async throws -> SignInResponse { throw unused() }
    func signOut() async throws {}
    func me() async throws -> User { PreviewData.user }
    func deleteAccount() async throws {}
    func putDevice(id: String, _ request: DevicePutRequest) async throws -> Device { throw unused() }
    func listSessions() async throws -> [SessionInfo] { PreviewData.sessions }
    func deleteSession(id: String) async throws -> SessionDeleteResponse {
        try WireJSON.decoder().decode(SessionDeleteResponse.self, from: Data(#"{"deleted":true,"signedOut":false}"#.utf8))
    }
    func sync(since cursor: String?) async throws -> SyncResponse { throw unused() }
    func getPackage(id: String) async throws -> PackageResponse { throw unused() }
    func putPackage(id: String, _ request: PackagePutRequest) async throws -> PackagePutResult { throw unused() }
    func deletePackage(id: String) async throws -> PackageDeleteResponse { throw unused() }
    func refreshPackage(id: String) async throws -> RefreshResponse { throw unused() }
    func importFlint(_ items: [FlintImportItem]) async throws -> ImportResponse { throw unused() }
    func importAmazon(_ items: [AmazonImportItem]) async throws -> ImportResponse { throw unused() }
    func startPairing() async throws -> PairingStartResponse {
        let json = #"{"code":"ABCD-EFGH","expiresAt":"\#(WireDate.format(Date().addingTimeInterval(600)))"}"#
        return try WireJSON.decoder().decode(PairingStartResponse.self, from: Data(json.utf8))
    }
    func claimPairing(_ request: PairingClaimRequest) async throws -> PairingClaimResponse { throw unused() }
    func listTokens() async throws -> [APITokenInfo] {
        let json = #"{"tokens":[{"id":"t1","label":"Flint on MacBook","scopes":["imports:write"],"createdAt":"\#(WireDate.format(PreviewData.ago(60 * 24 * 7)))","lastUsedAt":"\#(WireDate.format(PreviewData.ago(14)))"}]}"#
        return try WireJSON.decoder().decode(TokensResponse.self, from: Data(json.utf8)).tokens
    }
    func deleteToken(id: String) async throws {}
}
#endif
