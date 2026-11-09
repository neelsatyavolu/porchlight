import Foundation
import Testing
@testable import PorchKit

@Suite struct AmazonImporterTests {
    func importer(_ loader: FixtureLoader, api: AmazonFakeAPI = AmazonFakeAPI()) -> AmazonImporter {
        AmazonImporter(loader: loader, api: api, timeZone: LA, now: { NOW }, pause: .zero)
    }

    @Test func importsTheOpenShipments() async throws {
        let loader = FixtureLoader.standard()
        let api = AmazonFakeAPI()
        let result = await importer(loader, api: api).run()
        #expect(result == .imported(items: 2, rejected: 0))
        // Your Orders, then the four open shipments' track pages; nothing older.
        #expect(loader.loaded.withLock { $0 }.count == 5)
        let sent = try #require(api.calls.withLock { $0.imports }.first)
        #expect(Set(sent.map(\.trackingNumber)) == ["TBA532261610252", "TBA096464206829"])
        #expect(sent.allSatisfy { $0.carrier == .amazon && $0.observed != nil })
    }

    @Test func stopsAtSignIn() async {
        let signIn = URL(string: "https://www.amazon.com/ap/signin?openid.return_to=orders")!
        let loader = FixtureLoader(pages: [AmazonPages.orderHistory: AmazonLoadedPage(url: signIn, html: AmazonFixture.html("signin"))])
        let api = AmazonFakeAPI()
        #expect(await importer(loader, api: api).run() == .needsSignIn)
        #expect(api.calls.withLock { $0.imports }.isEmpty)
    }

    @Test func stopsWhenATrackPageAsksForSignIn() async {
        var loader = FixtureLoader.standard()
        loader.fallback = AmazonLoadedPage(url: AmazonPages.orderHistory, html: AmazonFixture.html("signin"))
        loader.pages = loader.pages.filter { $0.key == AmazonPages.orderHistory }
        #expect(await importer(loader).run() == .needsSignIn)
    }

    @Test func reportsAnOrdersPageItCantRead() async {
        let loader = FixtureLoader(pages: [AmazonPages.orderHistory: AmazonLoadedPage(url: AmazonPages.orderHistory, html: "<html><body><h1>Your Orders</h1></body></html>")])
        #expect(await importer(loader).run() == .parseFailed(AmazonImporter.ordersUnreadable))
    }

    @Test func reportsTrackPagesItCantRead() async {
        var loader = FixtureLoader.standard()
        loader.pages = loader.pages.filter { $0.key == AmazonPages.orderHistory }
        loader.fallback = AmazonLoadedPage(url: AmazonPages.orderHistory, html: "<html><body><p>Something new</p></body></html>")
        #expect(await importer(loader).run() == .parseFailed(AmazonImporter.tracksUnreadable))
    }

    @Test func sendsNothingWhenNothingIsOpen() async {
        let empty = #"<div class="order-card js-order-card"><div class="order-header"><div class="yohtmlc-order-id">Order # 111-2223334-4445556</div></div><div class="a-box delivery-box"><span class="delivery-box__primary-text">Delivered October 2</span><a href="/progress-tracker/package?orderId=111-2223334-4445556&amp;shipmentId=Abc">Track package</a></div></div>"#
        let loader = FixtureLoader(pages: [AmazonPages.orderHistory: AmazonLoadedPage(url: AmazonPages.orderHistory, html: empty)])
        let api = AmazonFakeAPI()
        #expect(await importer(loader, api: api).run() == .imported(items: 0, rejected: 0))
        #expect(api.calls.withLock { $0.imports }.isEmpty)
    }

    @Test func failsSoftlyOffline() async {
        let loader = FixtureLoader(pages: [:])
        #expect(await importer(loader).run() == .failed(AmazonImporter.amazonUnreachable))
    }

    @Test func stopsOpeningTrackPagesAtTheDeadlineAndSendsWhatItRead() async {
        let loader = FixtureLoader.standard()
        var late = importer(loader)
        late.deadline = NOW.addingTimeInterval(-1)
        guard case .imported = await late.run() else {
            Issue.record("expected .imported")
            return
        }
        // Your Orders and the first open shipment only.
        #expect(loader.loaded.withLock { $0 }.count == 2)

        let roomy = FixtureLoader.standard()
        var early = importer(roomy)
        early.deadline = NOW.addingTimeInterval(60)
        #expect(await early.run() == .imported(items: 2, rejected: 0))
        #expect(roomy.loaded.withLock { $0 }.count == 5)
    }

    @Test func failsSoftlyWhenPorchlightIsDown() async {
        let api = AmazonFakeAPI(importError: .network("offline"))
        guard case .failed = await importer(FixtureLoader.standard(), api: api).run() else {
            Issue.record("expected .failed")
            return
        }
    }
}

@Suite struct AmazonImportCoordinatorTests {
    func make(_ loader: FixtureLoader = .standard(), api: AmazonFakeAPI = AmazonFakeAPI(), connected: Bool = true)
        -> (AmazonImportCoordinator, MemoryAmazonStatusStore, TestClock) {
        var initial = AmazonLocalStatus()
        initial.connected = connected
        let store = MemoryAmazonStatusStore(initial)
        let clock = TestClock()
        let coordinator = AmazonImportCoordinator(store: store, api: api, now: { clock.now }) {
            AmazonImporter(loader: loader, api: api, timeZone: LA, now: { clock.now }, pause: .zero)
        }
        return (coordinator, store, clock)
    }

    @Test func doesNothingUntilConnected() async {
        let loader = FixtureLoader.standard()
        let (coordinator, _, _) = make(loader, connected: false)
        let status = await coordinator.runIfDue()
        #expect(status.state == nil)
        #expect(loader.loaded.withLock { $0 }.isEmpty)
    }

    @Test func importsReportsAndWaitsFifteenMinutes() async {
        let loader = FixtureLoader.standard()
        let api = AmazonFakeAPI()
        let (coordinator, _, clock) = make(loader, api: api)

        let first = await coordinator.runIfDue()
        #expect(first.state == .ok)
        #expect(first.lastImportAt == NOW)
        #expect(first.lastCount == 2)
        #expect(api.calls.withLock { $0.reports } == [AmazonStatusReport(state: .ok, lastImportAt: NOW, lastError: nil)])

        clock.advance(minutes: 14)
        _ = await coordinator.runIfDue()
        #expect(api.calls.withLock { $0.imports }.count == 1)
        #expect(await coordinator.nextAllowedAt() == NOW.addingTimeInterval(15 * 60))

        clock.advance(minutes: 2)
        _ = await coordinator.runIfDue()
        #expect(api.calls.withLock { $0.imports }.count == 2)
    }

    @Test func macRetriesSoonAfterAnAttemptThatDidntFinish() async {
        let (coordinator, store, clock) = make()
        #expect(await coordinator.isDueOnMac())
        // An attempt the app quit in the middle of: started, never finished.
        var s = store.load()
        s.lastAttemptAt = NOW
        s.lastImportAt = NOW.addingTimeInterval(-60 * 60)
        store.save(s)
        clock.advance(minutes: 10)
        #expect(!(await coordinator.isDueOnMac()))   // the 15-minute floor still holds
        clock.advance(minutes: 6)
        #expect(await coordinator.isDueOnMac())      // the last good import is stale, so try again now
    }

    @Test func macWaitsHalfAnHourAfterAGoodImport() async {
        let (coordinator, _, clock) = make()
        _ = await coordinator.runIfDue()
        clock.advance(minutes: 20)
        #expect(!(await coordinator.isDueOnMac()))
        clock.advance(minutes: 10)
        #expect(await coordinator.isDueOnMac())
    }

    @Test func aManualRefreshOnlyWaitsTwoMinutes() async {
        let api = AmazonFakeAPI()
        let (coordinator, _, clock) = make(api: api)
        _ = await coordinator.runIfDue()
        clock.advance(minutes: 1)
        _ = await coordinator.runIfDue(minimumInterval: AmazonImportCoordinator.manualMinimumInterval)
        #expect(api.calls.withLock { $0.imports }.count == 1)
        clock.advance(minutes: 1.5)
        _ = await coordinator.runIfDue(minimumInterval: AmazonImportCoordinator.manualMinimumInterval)
        #expect(api.calls.withLock { $0.imports }.count == 2)
        // The scheduled runs still keep 15 minutes from the last attempt.
        clock.advance(minutes: 5)
        _ = await coordinator.runIfDue()
        #expect(api.calls.withLock { $0.imports }.count == 2)
    }

    @Test func macIsNeverDueWhenDisconnected() async {
        let (coordinator, _, _) = make(connected: false)
        #expect(!(await coordinator.isDueOnMac()))
    }

    @Test func reportsSignInAndKeepsTheLastGoodImport() async {
        let api = AmazonFakeAPI()
        var loader = FixtureLoader.standard()
        let (coordinator, store, clock) = make(loader, api: api)
        _ = await coordinator.runIfDue()

        loader = FixtureLoader(pages: [AmazonPages.orderHistory: AmazonLoadedPage(url: URL(string: "https://www.amazon.com/ap/signin")!, html: "")])
        let signedOut = AmazonImportCoordinator(store: store, api: api, now: { clock.now }) { [loader] in
            AmazonImporter(loader: loader, api: api, timeZone: LA, now: { clock.now }, pause: .zero)
        }
        clock.advance(minutes: 20)
        let status = await signedOut.runIfDue()
        #expect(status.state == .needsSignIn)
        #expect(status.lastImportAt == NOW)
        #expect(api.calls.withLock { $0.reports }.last == AmazonStatusReport(state: .needsSignIn, lastImportAt: NOW, lastError: "Amazon asked you to sign in again."))

        // Signing in again clears the wait and the error.
        await signedOut.connected()
        #expect(await signedOut.nextAllowedAt() == nil)
        #expect(await signedOut.status.state == nil)
    }

    @Test func keepsTheStateOnANetworkFailure() async {
        let api = AmazonFakeAPI()
        var initial = AmazonLocalStatus()
        initial.connected = true
        initial.state = .ok
        let store = MemoryAmazonStatusStore(initial)
        let coordinator = AmazonImportCoordinator(store: store, api: api, now: { NOW }) {
            AmazonImporter(loader: FixtureLoader(pages: [:]), api: api, timeZone: LA, now: { NOW }, pause: .zero)
        }
        let status = await coordinator.runIfDue()
        #expect(status.state == .ok)
        #expect(status.lastError == AmazonImporter.amazonUnreachable)
        #expect(api.calls.withLock { $0.reports }.isEmpty)
    }

    @Test func disconnectForgetsEverything() async {
        let api = AmazonFakeAPI()
        let (coordinator, store, _) = make(api: api)
        _ = await coordinator.runIfDue()
        await coordinator.disconnected()
        #expect(store.load() == AmazonLocalStatus())
        #expect(api.calls.withLock { $0.cleared } == 1)
    }

    @Test func storesStatusInDefaults() throws {
        let defaults = try #require(UserDefaults(suiteName: "porchlight.amazon.tests.\(UUID().uuidString)"))
        let store = DefaultsAmazonStatusStore(defaults: defaults)
        #expect(store.load() == AmazonLocalStatus())
        var s = AmazonLocalStatus()
        s.connected = true
        s.state = .parseFailed
        s.lastAttemptAt = NOW
        store.save(s)
        #expect(DefaultsAmazonStatusStore(defaults: defaults).load() == s)
    }
}

@Suite struct AmazonStatusTextTests {
    func status(_ state: AmazonImportState?, lastImport: Date? = nil, count: Int? = nil, error: String? = nil) -> AmazonLocalStatus {
        var s = AmazonLocalStatus()
        s.connected = true
        s.state = state
        s.lastImportAt = lastImport
        s.lastAttemptAt = lastImport
        s.lastCount = count
        s.lastError = error
        return s
    }

    func line(_ s: AmazonLocalStatus) -> AmazonStatusText.Line { AmazonStatusText.line(s, now: NOW, timeZone: LA) }

    @Test func describesEachState() {
        let tenAgo = NOW.addingTimeInterval(-600)
        #expect(line(status(nil)) == .init(text: "Connected. The first import starts soon.", isProblem: false))
        #expect(line(status(.ok, lastImport: tenAgo, count: 3)) == .init(text: "Last import 10 min ago. 3 packages.", isProblem: false))
        #expect(line(status(.ok, lastImport: tenAgo, count: 0)).text == "Last import 10 min ago. Nothing on the way.")
        #expect(line(status(.needsSignIn, lastImport: tenAgo)) == .init(text: "Amazon wants you to sign in again. Last import 10 min ago.", isProblem: true))
        #expect(line(status(.parseFailed, lastImport: tenAgo)).isProblem)
        #expect(line(status(.ok, lastImport: tenAgo, error: "Couldn't reach Amazon.")).text == "Last import 10 min ago. The last try failed: Couldn't reach Amazon.")
    }
}
