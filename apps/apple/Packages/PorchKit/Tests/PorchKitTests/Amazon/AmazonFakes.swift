import Foundation
import Synchronization
@testable import PorchKit

/// The saved pages in Fixtures/ (real ones redacted with
/// scripts/redact-amazon-fixture.py, plus two marked SYNTHETIC).
enum AmazonFixture {
    static let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "Fixtures")

    static func html(_ name: String) -> String {
        do {
            return try String(contentsOf: dir.appending(path: "\(name).html"), encoding: .utf8)
        } catch {
            fatalError("missing fixture \(name): \(error)")
        }
    }

    static func document(_ name: String) -> HTMLNode { HTMLDocument.parse(html(name)) }

    /// The pages were saved on Sunday Nov 8 2026 in Los Angeles; `NOW` is that morning.
    static let text = AmazonText(now: NOW, timeZone: LA)

    static func trackURL(_ orderId: String, _ shipmentId: String) -> URL {
        URL(string: "https://www.amazon.com/progress-tracker/package?orderId=\(orderId)&shipmentId=\(shipmentId)&packageIndex=0")!
    }

    static let shippedOrder = "259-7940233-1199213"
    static let shippedShipment = "XuqK2p9ax"
    static let deliveredOrder = "297-5002893-4427402"
    static let deliveredShipment = "Y7PJkr3Tu"
}

/// Serves pages by URL; unknown URLs get `fallback`.
struct FixtureLoader: AmazonPageLoading {
    var pages: [URL: AmazonLoadedPage]
    var fallback: AmazonLoadedPage?
    let loaded = LockedBox<[URL]>([])

    func load(_ url: URL) async throws -> AmazonLoadedPage {
        loaded.withLock { $0.append(url) }
        if let page = pages[url] { return page }
        if let fallback { return AmazonLoadedPage(url: url, html: fallback.html) }
        throw URLError(.notConnectedToInternet)
    }

    static func standard() -> FixtureLoader {
        FixtureLoader(
            pages: [
                AmazonPages.orderHistory: AmazonLoadedPage(url: AmazonPages.orderHistory, html: AmazonFixture.html("order-history")),
                AmazonFixture.trackURL(AmazonFixture.shippedOrder, AmazonFixture.shippedShipment):
                    AmazonLoadedPage(url: AmazonFixture.trackURL(AmazonFixture.shippedOrder, AmazonFixture.shippedShipment), html: AmazonFixture.html("track-tba-shipped")),
                AmazonFixture.trackURL(AmazonFixture.deliveredOrder, AmazonFixture.deliveredShipment):
                    AmazonLoadedPage(url: AmazonFixture.trackURL(AmazonFixture.deliveredOrder, AmazonFixture.deliveredShipment), html: AmazonFixture.html("track-tba-delivered")),
            ],
            // Other shipments: a track page that shows a promise but no tracking id yet.
            fallback: AmazonLoadedPage(url: AmazonPages.orderHistory, html: #"<h1 class="pt-promise-main-slot">Delivered November 7</h1>"#)
        )
    }
}

/// Records Amazon imports and status reports; everything else is unused.
final class AmazonFakeAPI: APIClient, Sendable {
    struct Calls {
        var imports: [[AmazonImportItem]] = []
        var reports: [AmazonStatusReport] = []
        var cleared = 0
    }

    let calls = Mutex(Calls())
    let importError: APIError?

    init(importError: APIError? = nil) { self.importError = importError }

    func importAmazon(_ items: [AmazonImportItem]) async throws -> ImportResponse {
        calls.withLock { $0.imports.append(items) }
        if let importError { throw importError }
        let json = #"{"results":["# + items.map { #"{"dedupeKey":"\#($0.orderId):\#($0.shipmentId)","packageId":"p","outcome":"created"}"# }.joined(separator: ",") + "]}"
        return try WireJSON.decoder().decode(ImportResponse.self, from: Data(json.utf8))
    }

    func reportAmazonStatus(_ report: AmazonStatusReport) async throws -> AmazonIntegration {
        calls.withLock { $0.reports.append(report) }
        let json = #"{"state":"\#(report.state.rawValue)","lastImportAt":null,"lastError":null,"reportedAt":"2026-11-08T18:00:00.000Z","platform":"ios"}"#
        return try WireJSON.decoder().decode(AmazonIntegration.self, from: Data(json.utf8))
    }

    func clearAmazonStatus() async throws { calls.withLock { $0.cleared += 1 } }

    func signInWithApple(_ request: AppleSignInRequest) async throws -> SignInResponse { throw unused() }
    func startEmailSignIn(_ request: EmailStartRequest) async throws { throw unused() }
    func verifyEmail(_ request: EmailVerifyRequest) async throws -> SignInResponse { throw unused() }
    func signOut() async throws { throw unused() }
    func me() async throws -> User { throw unused() }
    func deleteAccount() async throws { throw unused() }
    func putDevice(id: String, _ request: DevicePutRequest) async throws -> Device { throw unused() }
    func listSessions() async throws -> [SessionInfo] { throw unused() }
    func deleteSession(id: String) async throws -> SessionDeleteResponse { throw unused() }
    func sync(since cursor: String?) async throws -> SyncResponse { throw unused() }
    func getPackage(id: String) async throws -> PackageResponse { throw unused() }
    func putPackage(id: String, _ request: PackagePutRequest) async throws -> PackagePutResult { throw unused() }
    func deletePackage(id: String) async throws -> PackageDeleteResponse { throw unused() }
    func refreshPackage(id: String) async throws -> RefreshResponse { throw unused() }
    func importFlint(_ items: [FlintImportItem]) async throws -> ImportResponse { throw unused() }
    func startPairing() async throws -> PairingStartResponse { throw unused() }
    func claimPairing(_ request: PairingClaimRequest) async throws -> PairingClaimResponse { throw unused() }
    func listTokens() async throws -> [APITokenInfo] { throw unused() }
    func deleteToken(id: String) async throws { throw unused() }

    private func unused(_ function: String = #function) -> PorchError { .notImplemented(function) }
}

/// In-memory status store.
final class MemoryAmazonStatusStore: AmazonStatusStoring, Sendable {
    private let value: Mutex<AmazonLocalStatus>
    init(_ status: AmazonLocalStatus = AmazonLocalStatus()) { value = Mutex(status) }
    func load() -> AmazonLocalStatus { value.withLock { $0 } }
    func save(_ status: AmazonLocalStatus) { value.withLock { $0 = status } }
}

/// A clock tests move by hand.
final class TestClock: Sendable {
    private let value: Mutex<Date>
    init(_ start: Date = NOW) { value = Mutex(start) }
    var now: Date { value.withLock { $0 } }
    func advance(minutes: Double) { value.withLock { $0 = $0.addingTimeInterval(minutes * 60) } }
}

/// A Mutex in a class, so a copyable fake can share it.
final class LockedBox<T: Sendable>: Sendable {
    private let mutex: Mutex<T>
    init(_ value: T) { mutex = Mutex(value) }
    func withLock<R>(_ body: (inout T) -> R) -> R { mutex.withLock { body(&$0) } }
}
